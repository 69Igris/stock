/**
 * MONEY-620 — Mutual-funds service END-TO-END (real service fns, recording prisma).
 *
 * Drives the REAL exported functions of `@usemoney/services`:
 *   - getMutualFunds    (userId-scoped where + filter parsing + per-fund
 *                        sanitisation + finite-guarded portfolio summary)
 *   - createMutualFund  (currentNav fallback + finite-guarded invested/current/gain)
 *   - deleteMutualFund  (userId-scoped lookup + broker-synced delete gate)
 *
 * Seam: every service hard-imports `prisma` from `@usemoney/database`. We inject
 * a RECORDING prisma double at that module boundary via `require.cache` BEFORE
 * requiring the `@usemoney/services` barrel (the established pattern from
 * `services-data-e2e.test.ts` / `webhooks-dodo-e2e.test.ts`). The recording
 * prisma is a Proxy that captures every `model.method(args)` and returns a
 * per-(model.method) queued result, so the SAME query the service builds is what
 * we assert. No live Mongo / Redis is ever touched.
 *
 * The services package is ESM (`"type":"module"`), so its own `__tests__` can't
 * use the CJS `require.cache` seam — this CJS suite under `apps/web` is the seam
 * that can. Runs under the default `node --import tsx --test` (CJS). CWD must be
 * `apps/web`.
 *
 * RELEASE-RELEVANT: the LIVE holdings page calls `getMutualFundsAction` →
 * `getMutualFunds`. Pre-fix it summed raw stored fields UNGUARDED, so a single
 * corrupt broker-sync row (NaN/Infinity NAV/units/invested/current/gain)
 * poisoned the whole MF portfolio total ("₹NaN") and made `pnlPercentage` the
 * literal "NaN". This suite drives the REAL service and asserts its output is
 * fully finite on a poisoned book — the exact bug the service de-shadow closes.
 *
 * Source: packages/services/src/mutualfunds.service.ts + mutualfunds-logic.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();
  private readonly failures = new Map<string, Error>();

  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }

  fail(model: string, method: string, error: Error): void {
    this.failures.set(`${model}.${method}`, error);
  }

  private next(model: string, method: string): unknown {
    const key = `${model}.${method}`;
    const q = this.queues.get(key);
    if (q && q.length > 0) return q.shift();
    if (method === "count") return 0;
    if (method === "aggregate") return { _sum: {}, _count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    if (method === "create") return {};
    if (method === "deleteMany" || method === "updateMany") return { count: 0 };
    return [];
  }

  readonly client: Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  >;

  constructor() {
    const self = this;
    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, model: string) {
          if (typeof model !== "string") return undefined;
          if (!(model in target)) {
            target[model] = new Proxy(
              {},
              {
                get(_m, method: string) {
                  return (args?: unknown) => {
                    self.calls.push({ model, method, args });
                    const err = self.failures.get(`${model}.${method}`);
                    if (err) return Promise.reject(err);
                    return Promise.resolve(self.next(model, method));
                  };
                },
              }
            );
          }
          return target[model];
        },
      }
    ) as RecordingPrisma["client"];
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }
}

// ── module-boundary injection ───────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SILENT_LOGGER = {
  debug() {},
  error() {},
  info() {},
  warn() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};

function makeLoggerStub(): Record<string, unknown> {
  const factory = () => SILENT_LOGGER;
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getLogger" || k === "default" || k === "createModuleLoggers")
          return factory;
        if (k === "initLogger" || k === "flushLogs")
          return async () => undefined;
        return SILENT_LOGGER;
      },
    }
  );
}

let activePrisma: RecordingPrisma = new RecordingPrisma();

/** Stable prisma stub: `model.method(args)` forwards to the active recorder. */
const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, model: string) {
      if (typeof model !== "string") return undefined;
      if (model === "then") return undefined; // not a thenable
      if (!(model in target)) {
        target[model] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                activePrisma.client[model]![method]!(args);
            },
          }
        );
      }
      return target[model];
    },
  }
);

/** A no-op @usemoney/core cache stub (getMutualFunds itself does not cache, but
 *  sibling services pulled in by the barrel `export *` may reference it). */
function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached") return async () => null;
        if (k === "setCached") return async () => {};
        return async () => {};
      },
    }
  );
}

interface ServicesModule {
  getMutualFunds: (
    userId: string,
    filters?: { search?: string; category?: string }
  ) => Promise<Result<{ funds: MfRow[]; summary: MfSummary }>>;
  createMutualFund: (
    userId: string,
    data: Record<string, unknown>
  ) => Promise<Result<MfRow>>;
  deleteMutualFund: (userId: string, fundId: string) => Promise<Result<void>>;
}

interface ServiceOk<T> {
  success: true;
  data: T;
  message?: string;
}
interface ServiceErr {
  success: false;
  error: string;
}
type Result<T> = ServiceOk<T> | ServiceErr;

interface MfRow {
  id?: string;
  schemeName?: string;
  // Stored rows may carry null/non-finite numerics (corrupt broker sync /
  // Prisma-nullable columns). The service SANITISES these to finite `number`s
  // on the way out, but the INPUT rows the recording prisma returns can be
  // poisoned — hence `number | null` here.
  units: number | null;
  averageNav: number | null;
  currentNav: number | null;
  investedAmount: number | null;
  currentValue: number | null;
  unrealizedGain: number | null;
  xirr: number | null;
  [k: string]: unknown;
}
interface MfSummary {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: string;
}

let servicesSingleton: ServicesModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): ServicesModule {
  if (servicesSingleton) return servicesSingleton;
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorCacheEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
  });
  stub(require.resolve("@usemoney/core"), makeCoreStub());
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  // Drop any already-loaded service modules so they re-bind to our stubs.
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") ||
        key.endsWith("/index.ts") ||
        key.endsWith("-logic.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  servicesSingleton = require("@usemoney/services") as ServicesModule;
  return servicesSingleton;
}

function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  servicesSingleton = null;
}

function reset(): { prisma: RecordingPrisma } {
  activePrisma = new RecordingPrisma();
  return { prisma: activePrisma };
}

function ok<T>(r: Result<T>): ServiceOk<T> {
  assert.equal(r.success, true, `expected success, got: ${JSON.stringify(r)}`);
  return r as ServiceOk<T>;
}

/** A complete, clean stored MF row (Prisma `select` shape). */
function cleanRow(overrides: Partial<MfRow> = {}): MfRow {
  return {
    id: "mf-1",
    userId: "u",
    schemeName: "HDFC Flexi Cap - Direct Growth",
    schemeCode: "MF001",
    amcName: "HDFC AMC",
    folioNumber: "HD1",
    category: "Flexi Cap",
    units: 100,
    averageNav: 50,
    currentNav: 55,
    investedAmount: 5000,
    currentValue: 5500,
    unrealizedGain: 500,
    xirr: 12,
    sipActive: false,
    sipAmount: null,
    sipDate: null,
    brokerName: "manual",
    broker: "MANUAL",
    brokerUserId: null,
    lastUpdated: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — getMutualFunds (real fn, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });

  it("issues a userId-scoped findMany (IDOR guard) with no filters", async () => {
    prisma.queue("mutualFund", "findMany", []);
    await svc.getMutualFunds("user-mf1", {});
    const find = prisma.callsFor("mutualFund", "findMany")[0];
    assert.ok(find, "expected mutualFund.findMany");
    const args = find.args as { where: { userId: string } };
    assert.equal(args.where.userId, "user-mf1");
  });

  it("threads search + category into the where-clause but KEEPS userId scope", async () => {
    prisma.queue("mutualFund", "findMany", []);
    await svc.getMutualFunds("user-mf2", {
      search: "hdfc",
      category: "Flexi Cap",
    });
    const args = prisma.callsFor("mutualFund", "findMany")[0]!.args as {
      where: Record<string, unknown>;
    };
    assert.equal(args.where.userId, "user-mf2"); // never widened
    assert.deepEqual(args.where.schemeName, {
      contains: "hdfc",
      mode: "insensitive",
    });
    assert.equal(args.where.category, "Flexi Cap");
  });

  it("ignores the sentinel category 'all' (no category filter applied)", async () => {
    prisma.queue("mutualFund", "findMany", []);
    await svc.getMutualFunds("user-mf3", { category: "all" });
    const args = prisma.callsFor("mutualFund", "findMany")[0]!.args as {
      where: Record<string, unknown>;
    };
    assert.equal("category" in args.where, false);
  });

  it("returns a zeroed '0'-pct summary for an empty book", async () => {
    prisma.queue("mutualFund", "findMany", []);
    const res = ok(await svc.getMutualFunds("user-empty", {}));
    assert.deepEqual(res.data.funds, []);
    assert.deepEqual(res.data.summary, {
      totalInvested: 0,
      totalCurrent: 0,
      totalPnL: 0,
      pnlPercentage: "0",
    });
  });

  it("aggregates a clean two-fund book (behaviour-preserving)", async () => {
    prisma.queue("mutualFund", "findMany", [
      cleanRow({
        investedAmount: 10000,
        currentValue: 11000,
        unrealizedGain: 1000,
      }),
      cleanRow({
        id: "mf-2",
        investedAmount: 5000,
        currentValue: 5500,
        unrealizedGain: 500,
      }),
    ]);
    const res = ok(await svc.getMutualFunds("user-mf4", {}));
    assert.equal(res.data.summary.totalInvested, 15000);
    assert.equal(res.data.summary.totalCurrent, 16500);
    assert.equal(res.data.summary.totalPnL, 1500);
    // 1500 / 15000 * 100 = 10.00
    assert.equal(res.data.summary.pnlPercentage, "10.00");
  });

  // ── the core poison regression on the LIVE service ──
  it("a NaN/Infinity-poisoned book yields a FULLY FINITE summary (no '₹NaN', no 'NaN' pct)", async () => {
    prisma.queue("mutualFund", "findMany", [
      // clean
      cleanRow({
        investedAmount: 100000,
        currentValue: 120000,
        unrealizedGain: 20000,
      }),
      // corrupt invested (NaN) — pre-fix poisoned totalInvested → NaN → "₹NaN"
      cleanRow({
        id: "bad1",
        investedAmount: NaN,
        currentValue: 5000,
        unrealizedGain: 500,
      }),
      // Infinity currentValue — slips past `|| 0`; must contribute 0
      cleanRow({
        id: "bad2",
        investedAmount: 90000,
        currentValue: Infinity,
        unrealizedGain: 1000,
      }),
      // -Infinity gain — must not drag totalPnL to -Infinity
      cleanRow({
        id: "bad3",
        investedAmount: 1000,
        currentValue: 900,
        unrealizedGain: -Infinity,
      }),
      // null gain (Prisma nullable) — counts as 0
      cleanRow({
        id: "bad4",
        investedAmount: 2000,
        currentValue: 2100,
        unrealizedGain: null,
      }),
    ]);

    const res = ok(await svc.getMutualFunds("user-poison", {}));
    const s = res.data.summary;

    // totalInvested = 100000 + 0(NaN) + 90000 + 1000 + 2000 = 193000
    assert.ok(Number.isFinite(s.totalInvested), "totalInvested must be finite");
    assert.equal(s.totalInvested, 193000);
    // totalCurrent = 120000 + 5000 + 0(Inf) + 900 + 2100 = 128000
    assert.ok(Number.isFinite(s.totalCurrent), "totalCurrent must be finite");
    assert.equal(s.totalCurrent, 128000);
    // totalPnL = 20000 + 500 + 1000 + 0(-Inf) + 0(null) = 21500
    assert.ok(Number.isFinite(s.totalPnL), "totalPnL must be finite");
    assert.equal(s.totalPnL, 21500);

    // pnlPercentage is a parseable finite string, NEVER the literal "NaN"/"Infinity".
    assert.equal(typeof s.pnlPercentage, "string");
    assert.notEqual(s.pnlPercentage, "NaN");
    assert.notEqual(s.pnlPercentage, "Infinity");
    assert.ok(Number.isFinite(Number(s.pnlPercentage)));
    // 21500 / 193000 * 100 = 11.14
    assert.equal(s.pnlPercentage, "11.14");

    // EVERY per-fund numeric the holdings UI formats is finite (consumer-safety).
    for (const f of res.data.funds) {
      for (const k of [
        "units",
        "averageNav",
        "currentNav",
        "investedAmount",
        "currentValue",
        "unrealizedGain",
        "xirr",
      ] as const) {
        assert.ok(
          Number.isFinite(f[k]),
          `fund ${String(f.id)} field ${k} must be finite, got ${String(f[k])}`
        );
        assert.notEqual((f[k] as number).toFixed(2), "NaN");
      }
    }
    // A consumer's fmtINR(Math.round(total)) never renders "₹NaN".
    const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
    assert.notEqual(inr(s.totalInvested), "₹NaN");
    assert.notEqual(inr(s.totalCurrent), "₹NaN");
  });

  it("sanitises a single fund with EVERY numeric field non-finite to all zeros", async () => {
    prisma.queue("mutualFund", "findMany", [
      cleanRow({
        id: "all-bad",
        units: NaN,
        averageNav: Infinity,
        currentNav: -Infinity,
        investedAmount: NaN,
        currentValue: Infinity,
        unrealizedGain: NaN,
        xirr: Infinity,
      }),
    ]);
    const res = ok(await svc.getMutualFunds("user-allbad", {}));
    const f = res.data.funds[0]!;
    assert.equal(f.units, 0);
    assert.equal(f.averageNav, 0);
    assert.equal(f.currentNav, 0);
    assert.equal(f.investedAmount, 0);
    assert.equal(f.currentValue, 0);
    assert.equal(f.unrealizedGain, 0);
    assert.equal(f.xirr, 0);
    // Summary all-zero, pct "0" (not "NaN").
    assert.deepEqual(res.data.summary, {
      totalInvested: 0,
      totalCurrent: 0,
      totalPnL: 0,
      pnlPercentage: "0",
    });
  });

  it("preserves fractional-unit precision on a clean row (units.toFixed(3))", async () => {
    prisma.queue("mutualFund", "findMany", [cleanRow({ units: 1250.456789 })]);
    const res = ok(await svc.getMutualFunds("user-frac", {}));
    assert.equal(res.data.funds[0]!.units, 1250.456789);
    assert.equal(res.data.funds[0]!.units.toFixed(3), "1250.457");
  });

  it("sanitises a VERY LARGE corpus without overflow (summary stays finite)", async () => {
    const rows = Array.from({ length: 500 }, (_v, i) =>
      cleanRow({
        id: `big-${i}`,
        investedAmount: 5_00_00_000,
        currentValue: 6_00_00_000,
        unrealizedGain: 1_00_00_000,
      })
    );
    prisma.queue("mutualFund", "findMany", rows);
    const res = ok(await svc.getMutualFunds("user-big", {}));
    assert.ok(Number.isFinite(res.data.summary.totalInvested));
    assert.equal(res.data.summary.totalInvested, 5_00_00_000 * 500);
    assert.equal(res.data.summary.pnlPercentage, "20.00");
  });

  it("returns a sanitized error (not the raw Mongo string) when the DB throws", async () => {
    prisma.fail(
      "mutualFund",
      "findMany",
      new Error("E11000 duplicate key error on internal.mutualfunds")
    );
    const res = await svc.getMutualFunds("user-err", {});
    assert.equal(res.success, false);
    assert.equal((res as ServiceErr).error, "Failed to fetch mutual funds");
  });
});

describe("MONEY-620 — createMutualFund (real fn, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });

  it("derives invested/current/gain and falls back currentNav→averageNav", async () => {
    // create() echoes back whatever data the service persisted.
    prisma.queue("mutualFund", "create", cleanRow());
    await svc.createMutualFund("user-c1", {
      schemeName: "X",
      units: 100,
      averageNav: 50,
      category: "Equity",
      sipActive: false,
      brokerName: "manual",
    });
    const created = prisma.callsFor("mutualFund", "create")[0]!.args as {
      data: Record<string, number | string>;
    };
    assert.equal(created.data.userId, "user-c1"); // IDOR: persisted under caller
    assert.equal(created.data.currentNav, 50); // fell back to averageNav
    assert.equal(created.data.investedAmount, 5000);
    assert.equal(created.data.currentValue, 5000);
    assert.equal(created.data.unrealizedGain, 0);
    assert.equal(created.data.xirr, 0);
  });

  it("uses an explicit currentNav and computes a non-zero gain", async () => {
    prisma.queue("mutualFund", "create", cleanRow());
    await svc.createMutualFund("user-c2", {
      schemeName: "Y",
      units: 100,
      averageNav: 50,
      currentNav: 55,
      category: "Equity",
      sipActive: false,
      brokerName: "manual",
    });
    const created = prisma.callsFor("mutualFund", "create")[0]!.args as {
      data: Record<string, number>;
    };
    assert.equal(created.data.currentNav, 55);
    assert.equal(created.data.currentValue, 5500);
    assert.equal(created.data.unrealizedGain, 500);
  });

  it("never persists a non-finite derived field (defense for non-web callers)", async () => {
    prisma.queue("mutualFund", "create", cleanRow());
    await svc.createMutualFund("user-c3", {
      schemeName: "Z",
      units: Number.POSITIVE_INFINITY, // a non-Zod caller could pass this
      averageNav: 50,
      currentNav: 55,
      category: "Equity",
      sipActive: false,
      brokerName: "manual",
    });
    const created = prisma.callsFor("mutualFund", "create")[0]!.args as {
      data: Record<string, number>;
    };
    assert.ok(Number.isFinite(created.data.investedAmount));
    assert.ok(Number.isFinite(created.data.currentValue));
    assert.ok(Number.isFinite(created.data.unrealizedGain));
  });
});

describe("MONEY-620 — deleteMutualFund (real fn, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });

  it("scopes the ownership lookup to id + userId (IDOR guard)", async () => {
    prisma.queue("mutualFund", "findFirst", {
      broker: "MANUAL",
      brokerName: "manual",
    });
    prisma.queue("mutualFund", "deleteMany", { count: 1 });
    await svc.deleteMutualFund("user-d1", "fund-9");
    const lookup = prisma.callsFor("mutualFund", "findFirst")[0]!.args as {
      where: { id: string; userId: string };
    };
    assert.equal(lookup.where.id, "fund-9");
    assert.equal(lookup.where.userId, "user-d1");
    // The deleteMany is ALSO userId-scoped (never deletes another user's row).
    const del = prisma.callsFor("mutualFund", "deleteMany")[0]!.args as {
      where: { id: string; userId: string };
    };
    assert.equal(del.where.id, "fund-9");
    assert.equal(del.where.userId, "user-d1");
  });

  it("returns 'not found' (no delete) when the row isn't owned by the caller", async () => {
    prisma.queue("mutualFund", "findFirst", null); // not owned / missing
    const res = await svc.deleteMutualFund("user-d2", "fund-x");
    assert.equal(res.success, false);
    assert.equal((res as ServiceErr).error, "Mutual fund not found");
    assert.equal(prisma.callsFor("mutualFund", "deleteMany").length, 0);
  });

  it("blocks deleting a broker-synced fund (broker != MANUAL)", async () => {
    prisma.queue("mutualFund", "findFirst", {
      broker: "ZERODHA",
      brokerName: "zerodha",
    });
    const res = await svc.deleteMutualFund("user-d3", "fund-z");
    assert.equal(res.success, false);
    assert.match((res as ServiceErr).error, /Cannot delete broker-synced/);
    assert.equal(prisma.callsFor("mutualFund", "deleteMany").length, 0);
  });

  it("allows deleting a manual fund and reports success", async () => {
    prisma.queue("mutualFund", "findFirst", {
      broker: "MANUAL",
      brokerName: "manual",
    });
    prisma.queue("mutualFund", "deleteMany", { count: 1 });
    const res = ok(await svc.deleteMutualFund("user-d4", "fund-m"));
    assert.equal(res.message, "Mutual fund deleted successfully!");
  });

  // Restore the real module cache so the database/core/logger stubs (and the
  // re-bound service modules) never leak into a sibling suite later in the run.
  after(() => {
    uninstallServices();
  });
});
