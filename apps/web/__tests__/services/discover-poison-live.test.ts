/**
 * MONEY-620 — discover.service POISON + ranking, on the LIVE service.
 *
 * Drives the REAL exported `getDiscoverData` + `getStocksBySector` from
 * `@usemoney/services` (`packages/services/src/discover.service.ts`) — the
 * user-facing Discover money path (`apps/web/lib/actions/discover.ts` →
 * `getDiscoverDataService` / `getStocksBySectorService`) — through a RECORDING
 * prisma double injected at the `@usemoney/database` / `@usemoney/core` /
 * `@usemoney/logger` module boundary via `require.cache`. This is the proven
 * seam from `services/holdings-poison-live.test.ts`. No inline reimplementation:
 * the SAME code that ships ranks what we assert (no shadow), and no live Mongo /
 * Redis is touched (pure, exits clean).
 *
 * What this pins on the LIVE service (the service-side de-shadow / finite-guard
 * via ./discover-logic.ts):
 *   1. RANKING POISON — a quote with NaN/Infinity `changePercent` (a corrupt
 *      sync row / a ÷0 on a zero previousClose upstream) must NEVER top the
 *      `topGainers` list nor the `topLosers` list, and must never flip the
 *      order-unstable sort so a corrupt row jumps the headline slot (the same
 *      "wrong-winner" class as ./comparison-logic.ts).
 *   2. SECTOR SORT POISON — `getStocksBySector(sort="changePercent")` is
 *      deterministic & NaN-safe (a corrupt row can't surface first).
 *   3. CACHE SCOPE — the Discover dataset is GLOBAL: it caches under userId
 *      `"_global"`, never a per-user key (no cross-user leak, no IDOR).
 *   4. CONSUMER-SAFETY — every `changePercent` in the ranked output is finite.
 *   5. BEHAVIOUR-PRESERVING — clean finite data yields the prior ranking.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/discover.service.ts + ./discover-logic.ts
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
    if (method === "groupBy") return [];
    if (method === "findFirst" || method === "findUnique") return null;
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

interface CoreCacheRecorder {
  setCachedCalls: Array<{ namespace: string; userId: string; subkey: string }>;
  cacheHit?: unknown;
}
function freshCoreRecorder(): CoreCacheRecorder {
  return { setCachedCalls: [] };
}

let activePrisma: RecordingPrisma = new RecordingPrisma();
let activeCore: CoreCacheRecorder = freshCoreRecorder();

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

/** A small, fixed sector vocabulary so `getAllSectorNames()` is deterministic. */
const STUB_SECTORS = ["IT", "Energy", "Financial Services"];

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getAllSectorNames") return () => [...STUB_SECTORS];
        if (k === "getCached") {
          return async () => {
            const hit = activeCore.cacheHit;
            activeCore.cacheHit = undefined;
            return hit ?? null;
          };
        }
        if (k === "setCached") {
          return async (namespace: string, userId: string, subkey: string) => {
            activeCore.setCachedCalls.push({ namespace, userId, subkey });
          };
        }
        return async () => {};
      },
    }
  );
}

// ── shapes ──────────────────────────────────────────────────────────────────

interface DiscoverStock {
  symbol: string;
  changePercent: number;
  change: number;
  marketCap: number | null;
  volume: number | null;
}
interface DiscoverData {
  topGainers: DiscoverStock[];
  topLosers: DiscoverStock[];
  allStocks: DiscoverStock[];
  sectors: Array<{ name: string; count: number }>;
}
type Result<T> = { success: true; data: T } | { success: false; error: string };

interface ServicesModule {
  getDiscoverData: () => Promise<Result<DiscoverData>>;
  getStocksBySector: (
    sector: string,
    options?: {
      limit?: number;
      sortBy?: "name" | "changePercent" | "marketCap";
    }
  ) => Promise<Result<DiscoverStock[]>>;
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
    // discover.service imports { prisma, Prisma } — Prisma namespace only used
    // for a cast on the raw-aggregate path, never executed here.
    Prisma: {},
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

function reset(): { prisma: RecordingPrisma; core: CoreCacheRecorder } {
  activePrisma = new RecordingPrisma();
  activeCore = freshCoreRecorder();
  return { prisma: activePrisma, core: activeCore };
}

function ok<T>(r: Result<T>): { success: true; data: T } {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as { success: true; data: T };
}

// ── fixture builders for the two prisma tables getAllStocksData reads ────────

let instSeq = 0;
function instrument(
  symbol: string,
  sector: string | null = "IT",
  exchange = "NSE"
) {
  const id = `inst-${instSeq++}`;
  return {
    id,
    symbol,
    name: symbol, // not mutual-fund-shaped → survives the name filter
    exchange,
    sector,
    instrumentType: "EQUITY",
    yahooSymbol: `${symbol}.NS`,
    // MONEY-1198 — DiscoverStock carries the durable identity used to collapse
    // dual listings. Test rows have none, and null is the honest value.
    isin: null,
  };
}
function quote(
  instrumentId: string,
  changePercent: number,
  change: number,
  opts: {
    volume?: number | null;
    marketCap?: number | null;
    price?: number;
  } = {}
) {
  return {
    instrumentId,
    price: opts.price ?? 100,
    change,
    changePercent,
    volume: opts.volume ?? 1000,
    marketCap: opts.marketCap ?? 1_000_000,
    previousClose: 95,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — discover.getDiscoverData: ranking is NaN-safe (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("a NaN/Infinity changePercent NEVER tops topGainers/topLosers; clean rows rank correctly", async () => {
    const insts = [
      instrument("CLEANUP1"),
      instrument("CLEANUP2"),
      instrument("CORRUPT"),
      instrument("CLEANDOWN1"),
      instrument("CLEANDOWN2"),
      instrument("INFDOWN"),
    ];
    prisma.queue("instrumentMapping", "findMany", insts);
    prisma.queue("latestQuote", "findMany", [
      quote(insts[0]!.id, 4, 4), // gainer +4
      quote(insts[1]!.id, 9, 9), // gainer +9 (biggest)
      // CORRUPT: NaN %change with a huge raw change — must NOT be a gainer.
      quote(insts[2]!.id, NaN, 999),
      quote(insts[3]!.id, -4, -4), // loser -4
      quote(insts[4]!.id, -9, -9), // loser -9 (worst)
      // INFDOWN: -Infinity %change — must NOT be a loser.
      quote(insts[5]!.id, -Infinity, -999),
    ]);

    const { data } = ok(await svc.getDiscoverData());

    // ── gainers: +9 then +4; CORRUPT (NaN) absent ──
    assert.deepEqual(
      data.topGainers.map((s) => s.symbol),
      ["CLEANUP2", "CLEANUP1"]
    );
    assert.ok(!data.topGainers.some((s) => s.symbol === "CORRUPT"));

    // ── losers: -9 then -4; INFDOWN (-Infinity) absent ──
    assert.deepEqual(
      data.topLosers.map((s) => s.symbol),
      ["CLEANDOWN2", "CLEANDOWN1"]
    );
    assert.ok(!data.topLosers.some((s) => s.symbol === "INFDOWN"));

    // ── consumer-safety: every ranked %change is finite ──
    for (const s of [...data.topGainers, ...data.topLosers]) {
      assert.ok(
        Number.isFinite(s.changePercent),
        `${s.symbol}: ${String(s.changePercent)} must be finite`
      );
    }
  });

  it("caches the dataset GLOBALLY (userId '_global'), never a per-user key (no IDOR/leak)", async () => {
    let core: CoreCacheRecorder;
    ({ prisma, core } = reset());
    prisma.queue("instrumentMapping", "findMany", [instrument("RELIANCE")]);
    prisma.queue("latestQuote", "findMany", [
      quote("inst-missing", 3, 3), // id won't match → allStocks empty, still caches
    ]);
    await svc.getDiscoverData();
    const writes = core.setCachedCalls.filter(
      (c) => c.namespace === "discover"
    );
    assert.ok(writes.length > 0, "expected a discover cache write");
    for (const w of writes) {
      assert.strictEqual(w.userId, "_global");
    }
  });

  it("behaviour-preserving: clean data yields the expected ordered gainers", async () => {
    const insts = [instrument("A"), instrument("B"), instrument("C")];
    prisma.queue("instrumentMapping", "findMany", insts);
    prisma.queue("latestQuote", "findMany", [
      quote(insts[0]!.id, 2, 2),
      quote(insts[1]!.id, 11, 11),
      quote(insts[2]!.id, 6, 6),
    ]);
    const { data } = ok(await svc.getDiscoverData());
    assert.deepEqual(
      data.topGainers.map((s) => s.symbol),
      ["B", "C", "A"]
    );
    assert.equal(data.topLosers.length, 0);
  });
});

describe("MONEY-620 — discover.getStocksBySector: sector sort is NaN-safe (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("sort=changePercent: a corrupt row never surfaces first; deterministic order", async () => {
    const insts = [
      instrument("REAL1", "IT"),
      instrument("CORRUPT", "IT"),
      instrument("REAL2", "IT"),
    ];
    prisma.queue("instrumentMapping", "findMany", insts);
    prisma.queue("latestQuote", "findMany", [
      quote(insts[0]!.id, 6, 6),
      // huge raw change + NaN %change: legacy Math.abs sort could float it up.
      quote(insts[1]!.id, NaN, 9999, { marketCap: 9e12 }),
      quote(insts[2]!.id, -8, -8),
    ]);

    const { data } = ok(
      await svc.getStocksBySector("IT", { sortBy: "changePercent", limit: 10 })
    );

    // |−8| > |6| > |NaN→0|: REAL2, REAL1, then CORRUPT last. Never CORRUPT first.
    assert.equal(data[0]!.symbol, "REAL2");
    assert.notEqual(data[0]!.symbol, "CORRUPT");
    assert.equal(data[data.length - 1]!.symbol, "CORRUPT");
    for (const s of data) {
      assert.ok(Number.isFinite(s.changePercent));
    }
  });

  it("the IDOR-irrelevant sector query is scoped to (isActive, sector, EQUITY)", async () => {
    prisma.queue("instrumentMapping", "findMany", []);
    prisma.queue("latestQuote", "findMany", []);
    await svc.getStocksBySector("Energy", { sortBy: "name" });
    const args = prisma.callsFor("instrumentMapping", "findMany")[0]!.args as {
      where: { isActive: boolean; sector: string; instrumentType: string };
    };
    assert.strictEqual(args.where.isActive, true);
    assert.strictEqual(args.where.sector, "Energy");
    assert.strictEqual(args.where.instrumentType, "EQUITY");
  });
});
