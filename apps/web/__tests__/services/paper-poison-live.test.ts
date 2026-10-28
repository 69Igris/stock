/**
 * MONEY-620 — paper.service LIVE: POISON + persist-guard + IDOR + Invalid-Date.
 *
 * Drives the REAL exported `getPaperPortfolio` / `createPaperTrade` /
 * `closePaperTrade` / `updatePaperPrices` / `deletePaperTrade` from
 * `@usemoney/services` (`packages/services/src/paper.service.ts`) — the
 * user-facing paper-trading money path (`apps/web/lib/actions/paper.ts` for web,
 * `apps/api/src/routes/v1/paper.ts` for mobile) — through a RECORDING prisma
 * double injected at the `@usemoney/database` / `@usemoney/core` / `@usemoney/logger`
 * module boundary via `require.cache`. This is the proven seam from
 * `positions/positions-service.test.ts` + `services/holdings-poison-live.test.ts`.
 * No inline reimplementation: the SAME code that ships computes what we assert
 * (no shadow), and no live Mongo / Redis is touched (pure, exits clean).
 *
 * What this pins on the LIVE service (the service-side de-shadow / finite-guard):
 *   1. POISON SUM — ONE OPEN position with NaN/Infinity investedValue/currentValue
 *      must NOT make the paper portfolio `summary` total NaN/Infinity, nor the
 *      summary `pnlPercentage` Infinity. Every per-position number returned is
 *      finite (consumer `.toFixed`/`.toLocaleString` safe).
 *   2. PERSIST-GUARD — `createPaperTrade` reached WITHOUT the web Zod gate
 *      (apps/api passes raw JSON) must NOT write NaN/Infinity into the Prisma
 *      `Float` columns; `updatePaperPrices` must persist a finite currentValue /
 *      unrealizedPnL / pnlPercentage even on a corrupt current price; and
 *      `closePaperTrade` (MONEY-1062) REJECTS a non-finite / non-positive
 *      exitPrice up front with `{ success:false, code:"INVALID_INPUT" }` —
 *      it must NOT coerce it to 0 and persist a CLOSED-at-₹0 fake full loss.
 *   3. CLOSE P&L — the returned `pnl` is finite (the web action does
 *      `pnl.toLocaleString("en-IN")` — "₹NaN" otherwise) and price-correct.
 *   4. IDOR — every mutation's WHERE carries the caller's userId; closing another
 *      user's (or a non-existent / already-closed) position matches ZERO rows and
 *      is rejected, never silently mutating a victim's row.
 *   5. INVALID-DATE — a corrupt stored entryDate/exitDate/expiryDate must NOT
 *      throw RangeError on `.toISOString()` (the whole portfolio used to 500);
 *      it degrades (entryDate→now, exit/expiry→undefined).
 *   6. BEHAVIOUR-PRESERVING — clean finite data yields the exact prior totals.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/paper.service.ts + ./paper-logic.ts
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
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) return q.shift();
    if (method === "count") return 0;
    if (method === "aggregate") return { _sum: {}, _count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    if (
      method === "create" ||
      method === "update" ||
      method === "updateMany" ||
      method === "deleteMany"
    ) {
      return method === "updateMany" || method === "deleteMany"
        ? { count: 0 }
        : {};
    }
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

const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, model: string) {
      if (typeof model !== "string") return undefined;
      if (model === "then") return undefined;
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

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached") return async () => null;
        return async () => {};
      },
    }
  );
}

interface PaperPositionShape {
  quantity: number;
  averagePrice: number;
  investedValue: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  realizedPnL?: number;
  expiryDate?: string;
  exitDate?: string;
  entryDate: string;
  status: string;
  [k: string]: unknown;
}
interface PaperPortfolioShape {
  positions: PaperPositionShape[];
  summary: {
    totalInvested: number;
    totalCurrent: number;
    totalPnL: number;
    pnlPercentage: number;
    openPositions: number;
    closedPositions: number;
  };
}
type Result<T> =
  | { success: true; data: T; message?: string }
  | { success: false; error: string; code?: string };

interface ServicesModule {
  getPaperPortfolio: (userId: string) => Promise<Result<PaperPortfolioShape>>;
  createPaperTrade: (
    userId: string,
    trade: Record<string, unknown>
  ) => Promise<Result<PaperPositionShape>>;
  closePaperTrade: (
    userId: string,
    positionId: string,
    exitPrice: number
  ) => Promise<Result<{ pnl: number }>>;
  updatePaperPrices: (
    userId: string,
    updates: Array<{ positionId: string; currentPrice: number }>
  ) => Promise<Result<void>>;
  deletePaperTrade: (
    userId: string,
    positionId: string
  ) => Promise<Result<void>>;
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
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") ||
        key.endsWith("-logic.ts") ||
        key.endsWith("/index.ts"))
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

function reset(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  return activePrisma;
}

function ok<T>(r: Result<T>): { success: true; data: T } {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as { success: true; data: T };
}

/** How the paper header / toast renders a value — assert no NaN reaches it. */
const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** A complete Prisma PaperPosition row (defaults clean, OPEN). */
function dbPaper(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const now = new Date("2026-06-01T00:00:00.000Z");
  return {
    id: "pp-1",
    userId: "user-x",
    symbol: "RELIANCE",
    assetType: "STOCK",
    segment: "EQUITY",
    exchange: "NSE",
    positionType: "LONG",
    quantity: 10,
    lotSize: null,
    averagePrice: 2500,
    investedValue: 25000,
    currentPrice: 2600,
    currentValue: 26000,
    unrealizedPnL: 1000,
    pnlPercentage: 4,
    strikePrice: null,
    optionType: null,
    expiryDate: null,
    status: "OPEN",
    exitPrice: null,
    exitDate: null,
    realizedPnL: null,
    notes: null,
    tags: [],
    entryDate: now,
    ...overrides,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — paper.service.getPaperPortfolio: POISON never reaches a formatter (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("NaN/Infinity values + Invalid-Date entry/exit/expiry → FULLY FINITE shape, no throw, no '₹NaN'", async () => {
    prisma.queue("paperPosition", "findMany", [
      // clean open row
      dbPaper({
        id: "ok",
        symbol: "RELIANCE",
        status: "OPEN",
        investedValue: 25000,
        currentValue: 26000,
        unrealizedPnL: 1000,
        pnlPercentage: 4,
      }),
      // corrupt open row: NaN currentValue + Infinity invested + Invalid dates
      dbPaper({
        id: "bad",
        symbol: "ADANI",
        status: "OPEN",
        quantity: NaN,
        averagePrice: Infinity,
        investedValue: Infinity,
        currentValue: NaN,
        unrealizedPnL: -Infinity,
        pnlPercentage: Infinity,
        // Invalid Date — `.toISOString()` would throw RangeError if unguarded.
        entryDate: new Date("not-a-real-date"),
        exitDate: new Date("also-bad"),
        expiryDate: new Date("nope"),
      }),
      // closed row (excluded from value totals, counted as closed)
      dbPaper({
        id: "closed",
        symbol: "TCS",
        status: "CLOSED",
        investedValue: 10000,
        currentValue: 11000,
        realizedPnL: 1000,
      }),
    ]);

    let res!: { success: true; data: PaperPortfolioShape };
    await assert.doesNotReject(async () => {
      res = ok(await svc.getPaperPortfolio("user-poison"));
    });

    const { positions, summary } = res.data;

    // ── summary totals: OPEN-only, bad row contributes 0, never NaN/Infinity ──
    assert.ok(Number.isFinite(summary.totalInvested));
    assert.ok(Number.isFinite(summary.totalCurrent));
    assert.ok(Number.isFinite(summary.totalPnL));
    assert.strictEqual(summary.totalInvested, 25000); // only the clean OPEN row
    assert.strictEqual(summary.totalCurrent, 26000);
    assert.strictEqual(summary.totalPnL, 1000);
    assert.strictEqual(INR(summary.totalCurrent), "₹26,000");
    assert.notStrictEqual(INR(summary.totalCurrent), "₹NaN");
    assert.strictEqual(summary.openPositions, 2);
    assert.strictEqual(summary.closedPositions, 1);

    // ── summary % finite, never Infinity ──
    assert.ok(Number.isFinite(summary.pnlPercentage));
    assert.strictEqual(summary.pnlPercentage, 4); // 1000/25000*100

    // ── the corrupt row's dates degrade (entry→valid ISO, exit/expiry→undefined) ──
    const badRow = positions.find((p) => p.symbol === "ADANI")!;
    assert.strictEqual(badRow.exitDate, undefined);
    assert.strictEqual(badRow.expiryDate, undefined);
    // entryDate is required → a valid ISO string (the "now" fallback), never throws.
    assert.doesNotThrow(() => new Date(badRow.entryDate).toISOString());
    assert.ok(Number.isFinite(new Date(badRow.entryDate).getTime()));

    // ── EVERY per-position number is finite (consumer .toFixed/.toLocaleString) ──
    for (const p of positions) {
      for (const n of [
        p.quantity,
        p.averagePrice,
        p.investedValue,
        p.currentPrice,
        p.currentValue,
        p.unrealizedPnL,
        p.pnlPercentage,
      ]) {
        assert.ok(
          Number.isFinite(n),
          `position ${p.symbol}: ${String(n)} must be finite`
        );
        assert.notStrictEqual((n as number).toFixed(2), "NaN");
      }
    }
    // the poisoned row's numbers are specifically neutralised to 0
    assert.strictEqual(badRow.quantity, 0);
    assert.strictEqual(badRow.currentValue, 0);
    assert.strictEqual(badRow.pnlPercentage, 0);
  });

  it("ALL open rows corrupt → zeroed-but-finite summary, % 0, no throw", async () => {
    prisma.queue("paperPosition", "findMany", [
      dbPaper({
        id: "x1",
        status: "OPEN",
        investedValue: Infinity,
        currentValue: NaN,
      }),
      dbPaper({
        id: "x2",
        status: "OPEN",
        investedValue: NaN,
        currentValue: Infinity,
      }),
    ]);
    const res = ok(await svc.getPaperPortfolio("user-allbad"));
    assert.strictEqual(res.data.summary.totalInvested, 0);
    assert.strictEqual(res.data.summary.totalCurrent, 0);
    assert.strictEqual(res.data.summary.totalPnL, 0);
    assert.strictEqual(res.data.summary.pnlPercentage, 0);
    assert.ok(Number.isFinite(res.data.summary.totalPnL));
  });

  it("empty portfolio → zeroed summary, no throw", async () => {
    prisma.queue("paperPosition", "findMany", []);
    const res = ok(await svc.getPaperPortfolio("user-empty"));
    assert.deepStrictEqual(res.data.positions, []);
    assert.deepStrictEqual(res.data.summary, {
      totalInvested: 0,
      totalCurrent: 0,
      totalPnL: 0,
      pnlPercentage: 0,
      openPositions: 0,
      closedPositions: 0,
    });
  });

  it("scopes the findMany to the caller userId (an attacker cannot read a victim's paper book)", async () => {
    prisma.queue("paperPosition", "findMany", []);
    await svc.getPaperPortfolio("attacker-or-owner");
    const args = prisma.callsFor("paperPosition", "findMany")[0]!.args as {
      where: { userId: string };
    };
    assert.strictEqual(args.where.userId, "attacker-or-owner");
  });
});

describe("MONEY-620 — paper.service.getPaperPortfolio: behaviour-preserving on clean data (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("clean mixed book: stored values trusted, OPEN-only totals + % unchanged from legacy math", async () => {
    prisma.queue("paperPosition", "findMany", [
      dbPaper({
        id: "o1",
        symbol: "INFY",
        status: "OPEN",
        investedValue: 25000,
        currentValue: 26000,
        unrealizedPnL: 1000,
        pnlPercentage: 4,
        expiryDate: new Date("2026-12-25T00:00:00.000Z"),
      }),
      dbPaper({
        id: "o2",
        symbol: "WIPRO",
        status: "OPEN",
        investedValue: 50000,
        currentValue: 52000,
        unrealizedPnL: 2000,
      }),
      dbPaper({
        id: "c1",
        symbol: "TCS",
        status: "CLOSED",
        investedValue: 10000,
        currentValue: 11000,
        realizedPnL: 1000,
        exitDate: new Date("2026-05-30T00:00:00.000Z"),
      }),
    ]);
    const res = ok(await svc.getPaperPortfolio("user-clean"));
    const { summary, positions } = res.data;
    assert.strictEqual(summary.totalInvested, 75000);
    assert.strictEqual(summary.totalCurrent, 78000);
    assert.strictEqual(summary.totalPnL, 3000);
    assert.strictEqual(summary.pnlPercentage, 4); // 3000/75000*100
    assert.strictEqual(summary.openPositions, 2);
    assert.strictEqual(summary.closedPositions, 1);
    // valid dates preserved as full ISO
    const o1 = positions.find((p) => p.symbol === "INFY")!;
    assert.strictEqual(o1.expiryDate, "2026-12-25T00:00:00.000Z");
    assert.strictEqual(o1.entryDate, "2026-06-01T00:00:00.000Z");
    const c1 = positions.find((p) => p.symbol === "TCS")!;
    assert.strictEqual(c1.exitDate, "2026-05-30T00:00:00.000Z");
    assert.strictEqual(c1.realizedPnL, 1000);
  });
});

describe("MONEY-620 — paper.service.createPaperTrade: never PERSISTS NaN/Infinity (LIVE, no Zod gate)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("a poisoned create body (apps/api raw JSON) writes only FINITE Float columns + a VALID entryDate", async () => {
    // The create returns whatever we queue; assert what the service tries to WRITE.
    prisma.queue(
      "paperPosition",
      "create",
      dbPaper({ id: "created", status: "OPEN" })
    );
    await svc.createPaperTrade("user-create", {
      symbol: "ADANI",
      quantity: NaN,
      averagePrice: Infinity,
      investedValue: NaN,
      currentPrice: Infinity,
      currentValue: -Infinity,
      unrealizedPnL: NaN,
      pnlPercentage: Infinity,
      // garbage date strings that would persist an Invalid Date
      entryDate: "not-a-real-date",
      expiryDate: "nope",
    });

    const writeArgs = prisma.callsFor("paperPosition", "create")[0]!.args as {
      data: Record<string, unknown>;
    };
    const d = writeArgs.data;
    for (const k of [
      "quantity",
      "averagePrice",
      "investedValue",
      "currentPrice",
      "currentValue",
      "unrealizedPnL",
      "pnlPercentage",
    ]) {
      assert.ok(
        Number.isFinite(d[k] as number),
        `persisted ${k} must be finite, got ${String(d[k])}`
      );
    }
    // all poison collapses to 0 (currentPrice falls back to guarded avg = 0).
    assert.strictEqual(d.quantity, 0);
    assert.strictEqual(d.averagePrice, 0);
    assert.strictEqual(d.investedValue, 0);
    assert.strictEqual(d.currentPrice, 0);
    assert.strictEqual(d.currentValue, 0);
    // a garbage entryDate string degrades to a VALID "now" Date, never Invalid.
    assert.ok(d.entryDate instanceof Date);
    assert.ok(Number.isFinite((d.entryDate as Date).getTime()));
    assert.doesNotThrow(() => (d.entryDate as Date).toISOString());
    // a garbage expiryDate becomes undefined (not an Invalid Date).
    assert.strictEqual(d.expiryDate, undefined);
  });

  it("clean create: persists the provided finite values with the service defaults", async () => {
    prisma.queue(
      "paperPosition",
      "create",
      dbPaper({ id: "created", status: "OPEN" })
    );
    await svc.createPaperTrade("user-create", {
      symbol: "INFY",
      quantity: 10,
      averagePrice: 2500,
      investedValue: 25000,
    });
    const d = (
      prisma.callsFor("paperPosition", "create")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    assert.strictEqual(d.quantity, 10);
    assert.strictEqual(d.averagePrice, 2500);
    assert.strictEqual(d.investedValue, 25000);
    assert.strictEqual(d.currentPrice, 2500); // defaults to averagePrice
    assert.strictEqual(d.currentValue, 25000); // defaults to investedValue
    assert.strictEqual(d.unrealizedPnL, 0);
    assert.strictEqual(d.pnlPercentage, 0);
    assert.strictEqual(d.userId, "user-create"); // IDOR: scoped to caller
  });

  it("the RETURNED entryDate is always a valid ISO string (no throw on read-back)", async () => {
    // Service returns from the created row; even if the row's entryDate is bad
    // (defensive read), the return must not throw.
    prisma.queue(
      "paperPosition",
      "create",
      dbPaper({ id: "created", status: "OPEN", entryDate: new Date("bad") })
    );
    const res = ok(
      await svc.createPaperTrade("user-create", {
        symbol: "INFY",
        quantity: 10,
        averagePrice: 2500,
        investedValue: 25000,
      })
    );
    assert.doesNotThrow(() => new Date(res.data.entryDate).toISOString());
    assert.ok(Number.isFinite(new Date(res.data.entryDate).getTime()));
  });
});

describe("MONEY-620 — paper.service.closePaperTrade: finite P&L, persisted-safe, IDOR (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("LONG close: returns the price-correct finite pnl and persists it (scoped to the caller)", async () => {
    prisma.queue(
      "paperPosition",
      "findFirst",
      dbPaper({
        id: "pp-9",
        status: "OPEN",
        positionType: "LONG",
        averagePrice: 2500,
        quantity: 10,
      })
    );
    prisma.queue("paperPosition", "updateMany", { count: 1 });
    const res = ok(await svc.closePaperTrade("owner", "pp-9", 2600));
    assert.strictEqual(res.data.pnl, 1000); // (2600-2500)*10
    // the success toast does pnl.toLocaleString("en-IN") — must not be "₹NaN".
    assert.notStrictEqual(INR(res.data.pnl), "₹NaN");

    // the READ is scoped to { id, userId, status: OPEN } (IDOR + already-closed).
    const findArgs = prisma.callsFor("paperPosition", "findFirst")[0]!.args as {
      where: { id: string; userId: string; status: string };
    };
    assert.strictEqual(findArgs.where.userId, "owner");
    assert.strictEqual(findArgs.where.status, "OPEN");
    // the WRITE is scoped to { id, userId } too (defence in depth) and finite.
    const upd = prisma.callsFor("paperPosition", "updateMany")[0]!.args as {
      where: { id: string; userId: string };
      data: Record<string, unknown>;
    };
    assert.strictEqual(upd.where.userId, "owner");
    assert.strictEqual(upd.data.realizedPnL, 1000);
    assert.strictEqual(upd.data.currentValue, 26000); // 2600*10
    assert.strictEqual(upd.data.exitPrice, 2600);
  });

  // MONEY-1062: the coerce-to-0 contract this test used to pin (Infinity →
  // finite(Infinity)=0 → position persisted CLOSED at ₹0 with a full fake loss)
  // was itself the bug — the service now REJECTS a non-finite/non-positive
  // exitPrice with { success:false, code:"INVALID_INPUT" } BEFORE any read or
  // write, so the position stays OPEN and untouched.
  it("POISON (MONEY-1062): a non-finite exitPrice is REJECTED with INVALID_INPUT — no coerce-to-0, no read, no write", async () => {
    prisma.queue(
      "paperPosition",
      "findFirst",
      dbPaper({
        id: "pp-x",
        status: "OPEN",
        positionType: "LONG",
        averagePrice: 2500,
        quantity: 10,
      })
    );
    prisma.queue("paperPosition", "updateMany", { count: 1 });
    for (const bad of [Infinity, -Infinity, NaN]) {
      const res = await svc.closePaperTrade("owner", "pp-x", bad);
      assert.strictEqual(res.success, false, `exitPrice ${bad} must reject`);
      const fail = res as { success: false; error: string; code?: string };
      assert.strictEqual(fail.code, "INVALID_INPUT");
      assert.strictEqual(fail.error, "Exit price must be a positive number");
    }
    // Crucially: the guard fires BEFORE the ownership read and the write — the
    // position is never re-read, never CLOSED at ₹0, never given a fake loss.
    assert.strictEqual(prisma.callsFor("paperPosition", "findFirst").length, 0);
    assert.strictEqual(
      prisma.callsFor("paperPosition", "updateMany").length,
      0
    );
  });

  it("MONEY-1062: a zero / negative exitPrice is REJECTED with INVALID_INPUT (no write)", async () => {
    for (const bad of [0, -5, -0.01]) {
      const res = await svc.closePaperTrade("owner", "pp-x", bad);
      assert.strictEqual(res.success, false, `exitPrice ${bad} must reject`);
      assert.strictEqual(
        (res as { success: false; code?: string }).code,
        "INVALID_INPUT"
      );
    }
    assert.strictEqual(
      prisma.callsFor("paperPosition", "updateMany").length,
      0
    );
  });

  it("MONEY-1062: a non-number exitPrice (undefined — raw caller) is REJECTED, not coerced", async () => {
    const res = await svc.closePaperTrade(
      "owner",
      "pp-x",
      undefined as unknown as number
    );
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; code?: string }).code,
      "INVALID_INPUT"
    );
    assert.strictEqual(prisma.callsFor("paperPosition", "findFirst").length, 0);
  });

  it("SHORT close P&L direction is preserved (finite)", async () => {
    prisma.queue(
      "paperPosition",
      "findFirst",
      dbPaper({
        id: "pp-s",
        status: "OPEN",
        positionType: "SHORT",
        averagePrice: 100,
        quantity: 10,
      })
    );
    prisma.queue("paperPosition", "updateMany", { count: 1 });
    const res = ok(await svc.closePaperTrade("owner", "pp-s", 90));
    assert.strictEqual(res.data.pnl, 100); // (100-90)*10 SHORT profit
  });

  it("IDOR / already-closed / nonexistent: findFirst returns null → rejected, NO write", async () => {
    // default next() for findFirst is null (foreign id / closed / missing)
    const res = await svc.closePaperTrade(
      "attacker",
      "victim-or-missing",
      2600
    );
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; error: string }).error,
      "Position not found or already closed"
    );
    // crucially: NO update was attempted on anyone's row.
    assert.strictEqual(
      prisma.callsFor("paperPosition", "updateMany").length,
      0
    );
    assert.strictEqual(prisma.callsFor("paperPosition", "update").length, 0);
  });
});

describe("MONEY-620 — paper.service.updatePaperPrices: finite persisted MTM, IDOR (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("POISON: a non-finite currentPrice persists only FINITE currentValue/unrealizedPnL/% (scoped)", async () => {
    prisma.queue("paperPosition", "findMany", [
      dbPaper({
        id: "pp-u",
        status: "OPEN",
        positionType: "LONG",
        quantity: 10,
        investedValue: 1000,
      }),
    ]);
    prisma.queue("paperPosition", "updateMany", { count: 1 });
    const res = ok(
      await svc.updatePaperPrices("owner", [
        { positionId: "pp-u", currentPrice: Infinity },
      ])
    );
    assert.strictEqual(res.success, true);
    const upd = prisma.callsFor("paperPosition", "updateMany")[0]!.args as {
      where: { id: string; userId: string };
      data: Record<string, unknown>;
    };
    assert.strictEqual(upd.where.userId, "owner"); // IDOR scope on the WRITE
    for (const k of [
      "currentPrice",
      "currentValue",
      "unrealizedPnL",
      "pnlPercentage",
    ]) {
      assert.ok(
        Number.isFinite(upd.data[k] as number),
        `persisted ${k} must be finite, got ${String(upd.data[k])}`
      );
    }
    // currentPrice Infinity → 0; cv 0; pnl 0-1000=-1000; % -1000/1000*100=-100
    assert.strictEqual(upd.data.currentPrice, 0);
    assert.strictEqual(upd.data.currentValue, 0);
    assert.strictEqual(upd.data.unrealizedPnL, -1000);
    assert.strictEqual(upd.data.pnlPercentage, -100);
  });

  it("clean price update persists the correct finite MTM (behaviour-preserving)", async () => {
    prisma.queue("paperPosition", "findMany", [
      dbPaper({
        id: "pp-c",
        status: "OPEN",
        positionType: "LONG",
        quantity: 10,
        investedValue: 1000,
      }),
    ]);
    prisma.queue("paperPosition", "updateMany", { count: 1 });
    await svc.updatePaperPrices("owner", [
      { positionId: "pp-c", currentPrice: 120 },
    ]);
    const upd = (
      prisma.callsFor("paperPosition", "updateMany")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    assert.strictEqual(upd.currentValue, 1200);
    assert.strictEqual(upd.unrealizedPnL, 200);
    assert.strictEqual(upd.pnlPercentage, 20);
  });

  it("zero-cost-basis position → % is 0, not Infinity (the `> 0` leak)", async () => {
    prisma.queue("paperPosition", "findMany", [
      dbPaper({
        id: "pp-z",
        status: "OPEN",
        positionType: "LONG",
        quantity: 10,
        investedValue: 0, // zero cost basis
      }),
    ]);
    prisma.queue("paperPosition", "updateMany", { count: 1 });
    await svc.updatePaperPrices("owner", [
      { positionId: "pp-z", currentPrice: 50 },
    ]);
    const upd = (
      prisma.callsFor("paperPosition", "updateMany")[0]!.args as {
        data: Record<string, unknown>;
      }
    ).data;
    assert.strictEqual(upd.pnlPercentage, 0);
    assert.ok(Number.isFinite(upd.pnlPercentage as number));
  });

  it("IDOR: a foreign/missing positionId never updates anyone (findFirst null → skip)", async () => {
    // findFirst default null → the `if (position)` guard skips the write entirely
    const res = ok(
      await svc.updatePaperPrices("attacker", [
        { positionId: "victim-pos", currentPrice: 100 },
      ])
    );
    assert.strictEqual(res.success, true); // batch no-ops gracefully
    assert.strictEqual(
      prisma.callsFor("paperPosition", "updateMany").length,
      0
    );
  });

  it("[MONEY-710] reads ONCE for N updates — not one query per position", async () => {
    // This was a sequential `findFirst` + `updateMany` per update inside a
    // `for` loop: 2N round trips, serialised, on a path that runs on a price
    // -refresh timer. The read is now a single `findMany` over every id.
    //
    // Asserting the COUNT rather than just the output is the point: the MTM
    // numbers were correct before too, so an output-only test cannot tell the
    // batched version from the N+1 one and would let it regress silently.
    prisma.queue("paperPosition", "findMany", [
      dbPaper({
        id: "p1",
        status: "OPEN",
        positionType: "LONG",
        quantity: 10,
        investedValue: 1000,
      }),
      dbPaper({
        id: "p2",
        status: "OPEN",
        positionType: "LONG",
        quantity: 5,
        investedValue: 500,
      }),
      dbPaper({
        id: "p3",
        status: "OPEN",
        positionType: "LONG",
        quantity: 2,
        investedValue: 200,
      }),
    ]);
    for (let i = 0; i < 3; i++) {
      prisma.queue("paperPosition", "updateMany", { count: 1 });
    }

    await svc.updatePaperPrices("owner", [
      { positionId: "p1", currentPrice: 120 },
      { positionId: "p2", currentPrice: 110 },
      { positionId: "p3", currentPrice: 105 },
    ]);

    assert.strictEqual(
      prisma.callsFor("paperPosition", "findMany").length,
      1,
      "three updates must cost ONE read, not three"
    );
    assert.strictEqual(
      prisma.callsFor("paperPosition", "findFirst").length,
      0,
      "the per-update findFirst is the N+1 — it must be gone"
    );

    // The read must still be scoped: an id the caller does not own, or a
    // CLOSED position, must not come back. Batching must not widen access.
    const readArgs = prisma.callsFor("paperPosition", "findMany")[0]!.args as {
      where: Record<string, unknown>;
    };
    assert.strictEqual(readArgs.where.userId, "owner");
    assert.strictEqual(readArgs.where.status, "OPEN");

    // Every WRITE stays scoped to { id, userId } — defence in depth.
    for (const call of prisma.callsFor("paperPosition", "updateMany")) {
      const w = (call.args as { where: Record<string, unknown> }).where;
      assert.strictEqual(w.userId, "owner");
      assert.ok(w.id, "writes must target a specific id, never a bare userId");
    }
  });
});

describe("MONEY-620 — paper.service.deletePaperTrade: IDOR scope (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("scopes the deleteMany to { id, userId }; a foreign id touches ZERO rows → not-found", async () => {
    // default deleteMany → { count: 0 } (foreign id matched nothing)
    const res = await svc.deletePaperTrade("attacker", "victim-pos");
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; error: string }).error,
      "Position not found"
    );
    const del = prisma.callsFor("paperPosition", "deleteMany")[0]!.args as {
      where: { id: string; userId: string };
    };
    assert.strictEqual(del.where.id, "victim-pos");
    assert.strictEqual(del.where.userId, "attacker"); // scope is load-bearing
  });

  it("deletes the caller's own row (count 1 → success)", async () => {
    prisma.queue("paperPosition", "deleteMany", { count: 1 });
    const res = ok(await svc.deletePaperTrade("owner", "own-pos"));
    assert.strictEqual(res.success, true);
  });
});

describe("MONEY-620 — paper.service: DB throw is sanitized (LIVE)", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  after(() => {
    uninstallServices();
  });

  it("a raw Mongo error from findMany never leaks; returns the sanitized message", async () => {
    const prisma = reset();
    prisma.fail(
      "paperPosition",
      "findMany",
      new Error("E11000 duplicate key error on internal.paperPositions")
    );
    const res = await svc.getPaperPortfolio("user-err");
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; error: string }).error,
      "Failed to fetch paper portfolio"
    );
  });
});
