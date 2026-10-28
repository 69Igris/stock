/**
 * MONEY-620 — Core data services END-TO-END (real service fns, recording prisma).
 *
 * The scan flagged the @usemoney/services data layer as never imported by any
 * test. This file closes that gap for the highest-traffic read services by
 * driving their REAL exported functions:
 *
 *   - holdings.service.getHoldings        (query shape + T1 settlement math + empty)
 *   - positions.service.getPositions      (broker/segment filter parsing + summary)
 *   - positions.service.getClosedTodayPositions (today window + price-derived P&L)
 *   - dashboard.service.getDashboardStats (Promise.all aggregation + win-rate + cache key)
 *   - dashboard.service.getPortfolioReturns (XIRR/CAGR honesty: null when no trades)
 *
 * Seam: every service hard-imports `prisma` from `@usemoney/database` and the
 * cache helpers from `@usemoney/core`. We inject a RECORDING prisma double and a
 * no-op cache at those module boundaries via `require.cache` BEFORE requiring the
 * `@usemoney/services` barrel (the established pattern from
 * `webhooks-dodo-e2e.test.ts` / `demo-routes-branches.test.ts`). The recording
 * prisma is a Proxy that captures every `model.method(args)` and returns a
 * per-(model.method) queued result, so the SAME query the service builds is what
 * we assert. No live Mongo / Redis is ever touched.
 *
 * The services package is ESM (`"type":"module"`), so its own `__tests__` can't
 * use the CJS `require.cache` seam — this CJS suite under `apps/web` is the seam
 * that can. The barrel resolves to `packages/services/src/index.ts` which
 * `export *`s every service, so a single stubbed db+core powers them all.
 *
 * Runs under the default `node --import tsx --test` (CJS) — no
 * `--experimental-test-module-mocks` needed. CWD must be `apps/web`.
 *
 * Source: packages/services/src/{holdings,positions,dashboard}.service.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

/**
 * A recording prisma whose every `model.method(args)` is captured and returns
 * the next queued result for that exact `model.method` key (FIFO), defaulting to
 * `[]` for a find-style call and a benign object otherwise. This lets one stub
 * serve `findMany`, `count`, `aggregate`, `findFirst`, etc. across all services
 * while the test pre-loads the rows each call should see.
 */
class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();

  private readonly failures = new Map<string, Error>();

  /** Queue a result for the next call to `model.method`. */
  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }

  /** Make `model.method` REJECT with `error` (simulating a raw DB failure). */
  fail(model: string, method: string, error: Error): void {
    this.failures.set(`${model}.${method}`, error);
  }

  private next(model: string, method: string): unknown {
    const key = `${model}.${method}`;
    const q = this.queues.get(key);
    if (q && q.length > 0) return q.shift();
    // Sensible defaults so an un-queued read doesn't explode the service.
    if (method === "count") return 0;
    if (method === "aggregate") return { _sum: {}, _count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    return [];
  }

  /** The object handed to the service as `prisma`. */
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

/** A silent logger object usable as any named logger export. */
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

/**
 * Build a complete `@usemoney/logger` replacement: any property access (named
 * loggers like `dbLogger`, the `getLogger` factory, the default export) returns
 * the silent logger / a factory yielding it. This both silences pino noise and
 * satisfies module-load `getLogger("x")` calls in transitively-loaded siblings.
 */
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
  getCachedCalls: Array<{ namespace: string; userId: string; rest: unknown[] }>;
  setCachedCalls: Array<{
    namespace: string;
    userId: string;
    subkey: string;
    value: unknown;
    rest: unknown[];
  }>;
  /** When set, the next getCached returns this value (then clears). */
  cacheHit?: unknown;
}

function freshCoreRecorder(): CoreCacheRecorder {
  return { getCachedCalls: [], setCachedCalls: [] };
}

// ── one-time install of stable forwarding stubs ─────────────────────────────
//
// The `@usemoney/services` barrel `export *`s ~35 services, several of which pull
// HEAVY transitive deps at module load (research/persistence, subscription, GCS,
// pubsub). Re-requiring the whole barrel per-test is slow and re-triggers those
// side-effects. Instead we inject STABLE stubs whose behaviour delegates to a
// swappable backing instance, require the barrel exactly ONCE, then reset the
// backing instances between tests. The `import { prisma }` binding each service
// captures at eval time stays valid because the stub object identity never
// changes — only what it forwards to does.

let activePrisma: RecordingPrisma = new RecordingPrisma();
let activeCore: CoreCacheRecorder = freshCoreRecorder();

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

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached") {
          return async (
            namespace: string,
            userId: string,
            ...rest: unknown[]
          ) => {
            activeCore.getCachedCalls.push({ namespace, userId, rest });
            const hit = activeCore.cacheHit;
            activeCore.cacheHit = undefined;
            return hit ?? null;
          };
        }
        if (k === "setCached") {
          return async (
            namespace: string,
            userId: string,
            subkey: string,
            value: unknown,
            ...rest: unknown[]
          ) => {
            activeCore.setCachedCalls.push({
              namespace,
              userId,
              subkey,
              value,
              rest,
            });
          };
        }
        // clearHoldingsCache / clearTradeCache / clearPositionCache / …
        return async () => {};
      },
    }
  );
}

let servicesSingleton: ServicesModule | null = null;
// Remember whatever occupied these cache slots before we stubbed them so the
// suite can restore them in `after()` — this keeps the stubs from leaking into
// any OTHER test file that runs in the same process under the full glob.
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

/** Install stubs + require the barrel once; subsequent calls return the cache. */
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
  // Also drop any already-loaded service modules so they re-bind to our stubs.
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") || key.endsWith("/index.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // calcXirr/calcCagr come from "@usemoney/core/calc" — KEEP it real (pure math,
  // no I/O) so getPortfolioReturns is genuinely exercised. Do not stub it.

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  servicesSingleton = require("@usemoney/services") as ServicesModule;
  return servicesSingleton;
}

/** Restore the pre-stub cache so nothing leaks to sibling test files. */
function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  servicesSingleton = null;
}

/** Swap in fresh recorders for a test; returns the live handles to assert on. */
function reset(): { prisma: RecordingPrisma; core: CoreCacheRecorder } {
  activePrisma = new RecordingPrisma();
  activeCore = freshCoreRecorder();
  return { prisma: activePrisma, core: activeCore };
}

// ── minimal structural types for the bits we drive ──────────────────────────

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

/** A single point of the dashboard daily-P&L chart series. */
interface DailyPoint {
  date: string;
  pnl: number;
  cumulativePnL: number;
}

interface ServicesModule {
  getHoldings: (
    userId: string,
    filters?: { symbol?: string; sector?: string }
  ) => Promise<
    Result<{ holdings: unknown[]; summary: Record<string, unknown> }>
  >;
  getPositions: (
    userId: string,
    filters?: { symbol?: string; broker?: string; segment?: string }
  ) => Promise<
    Result<{ positions: unknown[]; summary: Record<string, unknown> }>
  >;
  getClosedTodayPositions: (userId: string) => Promise<Result<unknown[]>>;
  getDashboardStats: (
    userId: string
  ) => Promise<Result<Record<string, unknown>>>;
  getPortfolioReturns: (
    userId: string
  ) => Promise<Result<Record<string, unknown>>>;
}

function ok<T>(r: Result<T>): ServiceOk<T> {
  assert.equal(r.success, true, `expected success, got: ${JSON.stringify(r)}`);
  return r as ServiceOk<T>;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — holdings.service.getHoldings (real fn, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  let core: CoreCacheRecorder;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma, core } = reset());
  });

  it("issues the userId-scoped findMany with the live-quantity OR gate", async () => {
    prisma.queue("holding", "findMany", []);
    await svc.getHoldings("user-h1", {});

    const find = prisma.callsFor("holding", "findMany")[0];
    assert.ok(find, "expected holding.findMany");
    const args = find.args as {
      where: { userId: string; OR: unknown[] };
      orderBy: Record<string, unknown>;
    };
    // IDOR guard: the query MUST be scoped to the caller's userId.
    assert.equal(args.where.userId, "user-h1");
    // Only positionful rows (settled or T1) are returned.
    assert.deepEqual(args.where.OR, [
      { quantity: { gt: 0 } },
      { t1Quantity: { gt: 0 } },
    ]);
    assert.deepEqual(args.orderBy, { lastUpdated: "desc" });
  });

  it("threads symbol + sector filters into the where clause", async () => {
    prisma.queue("holding", "findMany", []);
    await svc.getHoldings("user-h2", { symbol: "tcs", sector: "IT" });

    const args = prisma.callsFor("holding", "findMany")[0]!.args as {
      where: Record<string, unknown>;
    };
    assert.deepEqual(args.where.symbol, {
      contains: "tcs",
      mode: "insensitive",
    });
    assert.equal(args.where.sector, "IT");
  });

  it("ignores the sentinel sector 'all' (no sector filter applied)", async () => {
    prisma.queue("holding", "findMany", []);
    await svc.getHoldings("user-h3", { sector: "all" });
    const args = prisma.callsFor("holding", "findMany")[0]!.args as {
      where: Record<string, unknown>;
    };
    assert.equal("sector" in args.where, false);
  });

  it("returns a zeroed summary for an empty portfolio (no enrichment query)", async () => {
    prisma.queue("holding", "findMany", []);
    const res = ok(await svc.getHoldings("user-empty", {}));
    assert.deepEqual(res.data.holdings, []);
    assert.deepEqual(res.data.summary, {
      totalInvested: 0,
      totalCurrent: 0,
      totalPnL: 0,
      pnlPercentage: "0",
    });
    // No holding missing a sector → no instrumentMapping enrichment query.
    assert.equal(prisma.callsFor("instrumentMapping", "findMany").length, 0);
    // Cache miss → it persisted the computed result.
    assert.equal(core.setCachedCalls.length, 1);
    assert.equal(core.setCachedCalls[0]!.namespace, "holdings");
    assert.equal(core.setCachedCalls[0]!.userId, "user-empty");
  });

  it("computes invested/current/PnL and totals for a settled holding", async () => {
    prisma.queue("holding", "findMany", [
      {
        id: "h-1",
        symbol: "INFY",
        name: "Infosys",
        tradingSymbol: "INFY",
        sector: "IT",
        exchange: "NSE",
        quantity: 10,
        t1Quantity: 0,
        averagePrice: 100,
        currentPrice: 150,
        investedValue: 1000,
        currentValue: 1500,
        unrealizedPnL: 500,
        pnlPercentage: 50,
        broker: "ZERODHA",
        brokerUserId: "ZUID",
        createdAt: new Date("2026-01-02T00:00:00Z"),
        lastUpdated: new Date("2026-06-01T00:00:00Z"),
      },
    ]);
    const res = ok(await svc.getHoldings("user-h4", {}));
    const h = res.data.holdings[0] as Record<string, unknown>;
    assert.equal(h.symbol, "INFY");
    // quantity>0 → service trusts the stored investedValue/currentValue.
    assert.equal(h.investedValue, 1000);
    assert.equal(h.currentValue, 1500);
    assert.equal(h.unrealizedPnL, 500);
    assert.equal(h.brokerName, "zerodha");
    assert.equal(h.purchaseDate, "2026-01-02");
    assert.equal(res.data.summary.totalInvested, 1000);
    assert.equal(res.data.summary.totalCurrent, 1500);
    assert.equal(res.data.summary.pnlPercentage, "50.00");
  });

  it("derives value from T1 when settled quantity is 0 (settlement math)", async () => {
    prisma.queue("holding", "findMany", [
      {
        id: "h-t1",
        symbol: "WIPRO",
        name: null,
        tradingSymbol: "WIPRO-EQ",
        sector: "IT",
        exchange: "NSE",
        quantity: 0,
        t1Quantity: 5,
        averagePrice: 200,
        currentPrice: 220,
        investedValue: 0, // stale because qty is 0; service must recompute
        currentValue: 0,
        unrealizedPnL: 0,
        pnlPercentage: 0,
        broker: null,
        brokerUserId: null,
        createdAt: new Date("2026-05-30T00:00:00Z"),
        lastUpdated: new Date("2026-05-31T00:00:00Z"),
      },
    ]);
    const res = ok(await svc.getHoldings("user-h5", {}));
    const h = res.data.holdings[0] as Record<string, unknown>;
    // effectiveQty = 0 + 5 = 5 → invested 5*200=1000, current 5*220=1100, pnl 100
    assert.equal(h.investedValue, 1000);
    assert.equal(h.currentValue, 1100);
    assert.equal(h.unrealizedPnL, 100);
    assert.equal(h.t1Quantity, 5);
    // name falls back to tradingSymbol when name is null.
    assert.equal(h.name, "WIPRO-EQ");
    assert.equal(h.brokerName, null);
  });

  it("enriches a missing sector from InstrumentMapping (real merge path)", async () => {
    prisma.queue("holding", "findMany", [
      {
        id: "h-ns",
        symbol: "RELIANCE",
        name: "Reliance",
        tradingSymbol: "RELIANCE",
        sector: null, // triggers enrichment
        exchange: "NSE",
        quantity: 2,
        t1Quantity: 0,
        averagePrice: 1000,
        currentPrice: 1100,
        investedValue: 2000,
        currentValue: 2200,
        unrealizedPnL: 200,
        pnlPercentage: 10,
        broker: "UPSTOX",
        brokerUserId: null,
        createdAt: new Date("2026-04-01T00:00:00Z"),
        lastUpdated: new Date("2026-06-01T00:00:00Z"),
      },
    ]);
    prisma.queue("instrumentMapping", "findMany", [
      { symbol: "RELIANCE", exchange: "NSE", sector: "Energy" },
    ]);

    const res = ok(await svc.getHoldings("user-h6", {}));

    // The enrichment query is scoped to the missing symbols AND requires a
    // non-null sector. MONEY-846: was OR-by-(symbol,exchange); now symbol-IN so
    // resolveSector can fall back across exchanges (sector is a company property)
    // — a BSE holding inherits the NSE sector.
    const enrich = prisma.callsFor("instrumentMapping", "findMany")[0]!
      .args as {
      where: {
        symbol: { in: string[] };
        sector: unknown;
      };
    };
    assert.deepEqual(enrich.where.symbol, { in: ["RELIANCE"] });
    // MONEY-1152: was `{ not: null }`, which kept the "N/A" SKIPPED sentinel.
    // Behaviour here is unchanged — `resolveSector` has always filtered it in
    // JS via `isUsableSector` — so this is purely a narrower read. Both clauses
    // are needed: `notIn` alone would newly match documents where `sector` is
    // ABSENT rather than null, since a missing field satisfies `$nin` in Mongo.
    assert.deepEqual(enrich.where.sector, { not: null, notIn: ["N/A"] });

    const h = res.data.holdings[0] as Record<string, unknown>;
    assert.equal(h.sector, "Energy");
  });

  it("a BSE holding inherits the NSE sector when its BSE row is the N/A sentinel (MONEY-846 TMCV)", async () => {
    prisma.queue("holding", "findMany", [
      {
        id: "h-tmcv",
        symbol: "TMCV",
        name: "TMCV",
        tradingSymbol: "TMCV",
        sector: null,
        exchange: "BSE",
        quantity: 1,
        t1Quantity: 0,
        averagePrice: 100,
        currentPrice: 110,
        investedValue: 100,
        currentValue: 110,
        unrealizedPnL: 10,
        pnlPercentage: 10,
        broker: "ZERODHA",
        brokerUserId: null,
        createdAt: new Date("2026-04-01T00:00:00Z"),
        lastUpdated: new Date("2026-06-01T00:00:00Z"),
      },
    ]);
    // BSE row is the "N/A" SKIPPED sentinel; NSE row is enriched.
    prisma.queue("instrumentMapping", "findMany", [
      { symbol: "TMCV", exchange: "BSE", sector: "N/A" },
      { symbol: "TMCV", exchange: "NSE", sector: "Consumer Discretionary" },
    ]);

    const res = ok(await svc.getHoldings("user-tmcv", {}));
    const h = res.data.holdings[0] as Record<string, unknown>;
    assert.equal(h.sector, "Consumer Discretionary");
  });

  it("short-circuits to the cached value on a cache HIT (no DB query)", async () => {
    // Prime the cache so getCached returns a hit on the next call.
    core.cacheHit = {
      holdings: [{ id: "cached" }],
      summary: {
        totalInvested: 1,
        totalCurrent: 2,
        totalPnL: 1,
        pnlPercentage: "100",
      },
    };
    const res = ok(await svc.getHoldings("user-cached", {}));
    assert.equal(
      (res.data.holdings[0] as Record<string, unknown>).id,
      "cached"
    );
    // On a hit the service must NOT query the DB.
    assert.equal(prisma.callsFor("holding", "findMany").length, 0);
    assert.equal(core.setCachedCalls.length, 0);
  });
});

describe("MONEY-620 — positions.service (real fn, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });

  it("scopes getPositions to userId and excludes zero-net rows", async () => {
    prisma.queue("position", "findMany", []);
    await svc.getPositions("user-p1", {});
    const args = prisma.callsFor("position", "findMany")[0]!.args as {
      where: { userId: string; netQuantity: unknown };
    };
    assert.equal(args.where.userId, "user-p1");
    assert.deepEqual(args.where.netQuantity, { not: 0 });
  });

  it("maps broker='manual' to a null broker filter", async () => {
    prisma.queue("position", "findMany", []);
    await svc.getPositions("user-p2", { broker: "manual" });
    const args = prisma.callsFor("position", "findMany")[0]!.args as {
      where: Record<string, unknown>;
    };
    assert.equal(args.where.broker, null);
  });

  it("splits a 'broker:brokerUserId' filter into both columns", async () => {
    prisma.queue("position", "findMany", []);
    await svc.getPositions("user-p3", { broker: "ZERODHA:ZUID123" });
    const args = prisma.callsFor("position", "findMany")[0]!.args as {
      where: Record<string, unknown>;
    };
    assert.equal(args.where.broker, "ZERODHA");
    assert.equal(args.where.brokerUserId, "ZUID123");
  });

  it("expands a segment filter to all its DB synonyms (FO → NFO/BFO/NRML)", async () => {
    prisma.queue("position", "findMany", []);
    await svc.getPositions("user-p4", { segment: "FO" });
    const args = prisma.callsFor("position", "findMany")[0]!.args as {
      where: { segment: { in: string[] } };
    };
    // MONEY-846: F&O filter now also expands to FUTURES/OPTIONS-stored rows
    assert.deepEqual(args.where.segment, {
      in: ["FO", "NFO", "BFO", "NRML", "FUTURES", "OPTIONS"],
    });
  });

  it("classifies long vs short and aggregates the summary", async () => {
    prisma.queue("position", "findMany", [
      {
        id: "pos-long",
        userId: "user-p5",
        symbol: "NIFTY",
        exchange: "NFO",
        segment: "FO",
        productType: "NRML",
        netQuantity: 50, // LONG
        averagePrice: 100,
        lastPrice: 110,
        netValue: 5000,
        realizedPnl: 0,
        unrealizedPnl: 500,
        totalPnl: 500,
        tradeDate: new Date("2026-06-01T00:00:00Z"),
        broker: "ZERODHA",
        brokerUserId: "Z1",
        lastUpdated: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "pos-short",
        userId: "user-p5",
        symbol: "BANKNIFTY",
        exchange: "NFO",
        segment: "FO",
        productType: "NRML",
        netQuantity: -25, // SHORT
        averagePrice: 200,
        lastPrice: 190,
        netValue: -4750,
        realizedPnl: 0,
        unrealizedPnl: 250,
        totalPnl: 250,
        tradeDate: new Date("2026-06-01T00:00:00Z"),
        broker: "ZERODHA",
        brokerUserId: "Z1",
        lastUpdated: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const res = ok(await svc.getPositions("user-p5", {}));
    const summary = res.data.summary as Record<string, number>;
    assert.equal(summary.totalPositions, 2);
    assert.equal(summary.longPositions, 1);
    assert.equal(summary.shortPositions, 1);
    // totalInvested = |5000| + |-4750| = 9750
    assert.equal(summary.totalInvested, 9750);
    assert.equal(summary.unrealizedPnL, 750);

    const long = res.data.positions[0] as Record<string, unknown>;
    assert.equal(long.positionType, "LONG");
    assert.equal(long.tradeType, "BUY");
    assert.equal(long.quantity, 50);
    const short = res.data.positions[1] as Record<string, unknown>;
    assert.equal(short.positionType, "SHORT");
    assert.equal(short.tradeType, "SELL");
    assert.equal(short.quantity, 25); // Math.abs(-25)
  });

  it("getClosedTodayPositions filters by today's start + netQuantity 0", async () => {
    prisma.queue("position", "findMany", []);
    await svc.getClosedTodayPositions("user-p6");
    const args = prisma.callsFor("position", "findMany")[0]!.args as {
      where: { userId: string; netQuantity: number; tradeDate: { gte: Date } };
    };
    assert.equal(args.where.userId, "user-p6");
    assert.equal(args.where.netQuantity, 0);
    const gte = args.where.tradeDate.gte;
    assert.ok(gte instanceof Date);
    // Start-of-day: all time components zeroed.
    assert.equal(gte.getHours(), 0);
    assert.equal(gte.getMinutes(), 0);
    assert.equal(gte.getSeconds(), 0);
  });

  it("getClosedTodayPositions derives P&L from prices when realised is 0", async () => {
    prisma.queue("position", "findMany", [
      {
        id: "ct-1",
        symbol: "SBIN",
        exchange: "NSE",
        segment: "CASH",
        productType: "MIS",
        buyQuantity: 100,
        buyPrice: 500,
        sellPrice: 520,
        realizedPnl: 0, // Zerodha often reports 0 → service must recompute
        tradeDate: new Date(),
        broker: "ZERODHA",
        brokerUserId: "Z1",
      },
    ]);
    const res = ok(await svc.getClosedTodayPositions("user-p7"));
    const row = res.data[0] as Record<string, unknown>;
    // (520-500)*100 = 2000
    assert.equal(row.realizedPnL, 2000);
    assert.equal(row.quantity, 100);
    assert.equal(row.segmentLabel, "Equity"); // CASH → Equity
  });
});

describe("MONEY-620 — dashboard.service (real aggregation, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  let core: CoreCacheRecorder;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma, core } = reset());
  });

  function queueEmptyDashboard(): void {
    // getDashboardStats fires 11 queries via Promise.all; queue benign results.
    prisma.queue("trade", "findMany", []); // recent trades
    prisma.queue("holding", "findMany", []);
    prisma.queue("mutualFund", "findMany", []);
    prisma.queue("position", "findMany", []);
    prisma.queue("pairedTradeView", "aggregate", {
      _sum: { realizedPnL: 0 },
      _count: 0,
    });
    prisma.queue("pairedTradeView", "count", 0); // winners
    prisma.queue("pairedTradeView", "count", 0); // losers
    prisma.queue("pairedTradeView", "findMany", []); // open
    prisma.queue("trade", "count", 0); // total trades
    prisma.queue("pairedTradeView", "findFirst", null); // best
    prisma.queue("pairedTradeView", "findFirst", null); // worst
  }

  it("returns a fully-zeroed dashboard for an empty account and caches it", async () => {
    queueEmptyDashboard();
    const res = ok(await svc.getDashboardStats("user-d1"));
    const portfolio = res.data.portfolio as Record<string, number>;
    assert.equal(portfolio.totalValue, 0);
    assert.equal(portfolio.totalPnL, 0);
    const trading = res.data.trading as Record<string, unknown>;
    assert.equal(trading.totalTrades, 0);
    assert.equal(trading.winRate, 0);
    assert.equal(trading.bestTrade, null);
    assert.equal(trading.worstTrade, null);
    // 30-day daily P&L series is always length 30 (chart axis stability).
    const charts = res.data.charts as { dailyPnL: unknown[] };
    assert.equal(charts.dailyPnL.length, 30);
    // Cached under the dashboard/stats key.
    assert.equal(core.setCachedCalls.length, 1);
    assert.equal(core.setCachedCalls[0]!.namespace, "dashboard");
    assert.equal(core.setCachedCalls[0]!.subkey, "stats");
  });

  it("scopes the closed-trade aggregate to userId+status=CLOSED (IDOR guard)", async () => {
    queueEmptyDashboard();
    await svc.getDashboardStats("user-d2");
    const agg = prisma.callsFor("pairedTradeView", "aggregate")[0]!.args as {
      where: { userId: string; status: string };
      _sum: Record<string, boolean>;
    };
    assert.equal(agg.where.userId, "user-d2");
    assert.equal(agg.where.status, "CLOSED");
    assert.equal(agg._sum.realizedPnL, true);
  });

  it("computes win-rate from winner/closed counts and surfaces best/worst", async () => {
    prisma.queue("trade", "findMany", []);
    prisma.queue("holding", "findMany", []);
    prisma.queue("mutualFund", "findMany", []);
    prisma.queue("position", "findMany", []);
    prisma.queue("pairedTradeView", "aggregate", {
      _sum: { realizedPnL: 1234 },
      _count: 4, // 4 closed
    });
    prisma.queue("pairedTradeView", "count", 3); // 3 winners
    prisma.queue("pairedTradeView", "count", 1); // 1 loser
    prisma.queue("pairedTradeView", "findMany", []); // open
    prisma.queue("trade", "count", 9); // total trades
    prisma.queue("pairedTradeView", "findFirst", {
      symbol: "TATAMOTORS",
      realizedPnL: 900,
    });
    prisma.queue("pairedTradeView", "findFirst", {
      symbol: "YESBANK",
      realizedPnL: -200,
    });

    const res = ok(await svc.getDashboardStats("user-d3"));
    const trading = res.data.trading as Record<string, unknown>;
    assert.equal(trading.totalRealizedPnL, 1234);
    assert.equal(trading.closedTrades, 4);
    assert.equal(trading.totalTrades, 9);
    // round(3/4 * 100) = 75
    assert.equal(trading.winRate, 75);
    assert.equal(trading.winners, 3);
    assert.equal(trading.losers, 1);
    assert.deepEqual(trading.bestTrade, { symbol: "TATAMOTORS", pnl: 900 });
    assert.deepEqual(trading.worstTrade, { symbol: "YESBANK", pnl: -200 });
  });

  it("aggregates portfolio value across holdings + MFs + positions", async () => {
    prisma.queue("trade", "findMany", []);
    prisma.queue("holding", "findMany", [
      {
        symbol: "INFY",
        currentPrice: 150,
        currentValue: 1500,
        investedValue: 1000,
        unrealizedPnL: 500,
      },
    ]);
    prisma.queue("mutualFund", "findMany", [
      { currentValue: 800, investedAmount: 700, investedValue: 700 },
    ]);
    prisma.queue("position", "findMany", [
      {
        symbol: "NIFTY",
        netQuantity: 10,
        lastPrice: 50,
        unrealizedPnl: 0,
        totalPnl: 120,
      },
    ]);
    prisma.queue("pairedTradeView", "aggregate", {
      _sum: { realizedPnL: 0 },
      _count: 0,
    });
    prisma.queue("pairedTradeView", "count", 0);
    prisma.queue("pairedTradeView", "count", 0);
    prisma.queue("pairedTradeView", "findMany", []);
    prisma.queue("trade", "count", 1);
    prisma.queue("pairedTradeView", "findFirst", null);
    prisma.queue("pairedTradeView", "findFirst", null);

    const res = ok(await svc.getDashboardStats("user-d4"));
    const p = res.data.portfolio as Record<string, number>;
    // holdings 1500 + mf 800 + positions |10*50|=500 → 2800
    assert.equal(p.totalValue, 2800);
    assert.equal(p.holdingsValue, 1500);
    assert.equal(p.mfValue, 800);
    assert.equal(p.openPositionsValue, 500);
    // pnl: holdings (1500-1000)=500 + mf (800-700)=100 + positions totalPnl 120 = 720
    assert.equal(p.totalPnL, 720);
  });

  it("getPortfolioReturns is HONEST: null XIRR/CAGR when there are no trades", async () => {
    prisma.queue("trade", "findMany", []); // no dated cashflows
    prisma.queue("holding", "findMany", []);
    prisma.queue("mutualFund", "findMany", []);
    prisma.queue("position", "findMany", []);
    const res = ok(await svc.getPortfolioReturns("user-d5"));
    assert.equal(res.data.xirrPct, null);
    assert.equal(res.data.cagrPct, null);
    assert.equal(res.data.firstInvestmentDate, null);
    assert.equal(res.data.holdingPeriodYears, null);
    // The empty result is cached under dashboard/returns.
    assert.equal(
      core.setCachedCalls.some(
        (c) => c.namespace === "dashboard" && c.subkey === "returns"
      ),
      true
    );
  });

  it("getPortfolioReturns computes a real CAGR from a long-held BUY", async () => {
    // One BUY ~1.5y ago, current value > invested → positive, plausible CAGR.
    const buyDate = new Date();
    buyDate.setDate(buyDate.getDate() - 550);
    prisma.queue("trade", "findMany", [
      {
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        tradeValue: 1000,
        tradeDate: buyDate,
      },
    ]);
    prisma.queue("holding", "findMany", [{ currentValue: 1500 }]);
    prisma.queue("mutualFund", "findMany", []);
    prisma.queue("position", "findMany", []);
    const res = ok(await svc.getPortfolioReturns("user-d6"));
    // CAGR from 1000 → (1500 current + 0 proceeds) over ~1.5y is positive & finite.
    assert.equal(typeof res.data.cagrPct, "number");
    assert.ok((res.data.cagrPct as number) > 0);
    assert.equal(typeof res.data.holdingPeriodYears, "number");
    assert.ok((res.data.holdingPeriodYears as number) > 1);
    assert.ok(typeof res.data.firstInvestmentDate === "string");
  });

  // ───────────────── non-finite / Invalid-Date POISON regression ─────────────
  //
  // RELEASE-RELEVANT (MONEY-620): the LIVE user-facing dashboard runs through
  // `getDashboardStats` (exported as `getDashboardStatsService`). It used to
  // inline the aggregation math UNGUARDED, so a single holding/MF/position with
  // a NaN or Infinity value poisoned the whole portfolio total ("₹NaN"),
  // `pnlPercentage` became the literal string "NaN", and an Invalid-Date
  // `tradeDate` threw RangeError on `.toISOString()` (a 500 for the whole
  // dashboard). These cases drive the REAL service (NOT the helper in isolation)
  // and assert its output is fully finite on a poisoned row — the exact bug the
  // service-side de-shadow closes.
  describe("getDashboardStats — one poisoned row never reaches a formatter (LIVE service)", () => {
    /** How the dashboard UI renders the headline value — assert no NaN reaches it. */
    const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

    /**
     * Queue the 11 Promise.all reads with a deliberately POISONED row mix:
     *   - holdings: one clean row + one NaN currentValue (corrupt sync)
     *   - MFs:      one clean row + one Infinity currentValue
     *   - positions:one clean row + one NaN netQuantity
     *   - trades:   one valid today row + one Invalid-Date row (RangeError bait)
     *   - best/worst paired trade picks carry ±Infinity realizedPnL
     */
    function queuePoisonedDashboard(): void {
      const today = new Date();
      prisma.queue("trade", "findMany", [
        {
          id: "t-ok",
          symbol: "INFY",
          exchange: "NSE",
          tradeType: "SELL",
          quantity: 10,
          price: 1500,
          realizedPnL: 2000,
          tradeDate: today,
        },
        {
          id: "t-bad",
          symbol: "TCS",
          exchange: "NSE",
          tradeType: "SELL",
          quantity: 5,
          price: 3000,
          realizedPnL: 500,
          // Invalid Date — `.toISOString()` throws RangeError if not guarded.
          tradeDate: new Date("not-a-real-date"),
        },
      ]);
      prisma.queue("holding", "findMany", [
        {
          symbol: "RELIANCE",
          currentPrice: 2500,
          currentValue: 500000,
          investedValue: 450000,
          unrealizedPnL: 50000,
        },
        {
          symbol: "ADANI",
          currentPrice: 0,
          currentValue: NaN, // corrupt → must contribute 0, not poison the sum
          investedValue: 100000,
          unrealizedPnL: 0,
        },
      ]);
      prisma.queue("mutualFund", "findMany", [
        { currentValue: 100000, investedAmount: 90000, investedValue: null },
        {
          currentValue: Infinity, // Infinity passes `|| 0` → must be neutralised
          investedAmount: 90000,
          investedValue: null,
        },
      ]);
      prisma.queue("position", "findMany", [
        {
          symbol: "NIFTY",
          netQuantity: 100,
          lastPrice: 500,
          unrealizedPnl: 0,
          totalPnl: 5000,
        },
        {
          symbol: "BANKNIFTY",
          netQuantity: NaN, // NaN * lastPrice → must contribute 0
          lastPrice: 500,
          unrealizedPnl: 0,
          totalPnl: 5000,
        },
      ]);
      prisma.queue("pairedTradeView", "aggregate", {
        _sum: { realizedPnL: 8000 },
        _count: 2,
      });
      prisma.queue("pairedTradeView", "count", 1); // winners
      prisma.queue("pairedTradeView", "count", 1); // losers
      prisma.queue("pairedTradeView", "findMany", []); // open
      prisma.queue("trade", "count", 2); // total trades
      // best/worst picks with NON-FINITE stored P&L → must surface as null.
      prisma.queue("pairedTradeView", "findFirst", {
        symbol: "BEST",
        realizedPnL: Infinity,
      });
      prisma.queue("pairedTradeView", "findFirst", {
        symbol: "WORST",
        realizedPnL: -Infinity,
      });
    }

    it("a NaN holding + Infinity MF + Invalid-Date trade still yields FULLY FINITE stats (no throw, no '₹NaN')", async () => {
      queuePoisonedDashboard();

      // The service must NOT throw on the Invalid-Date row's .toISOString().
      let res!: ServiceOk<Record<string, unknown>>;
      await assert.doesNotReject(async () => {
        res = ok(await svc.getDashboardStats("user-poison"));
      });

      const p = res.data.portfolio as Record<string, unknown>;
      const t = res.data.trading as Record<string, unknown>;

      // ── totalValue: bad rows contribute 0, never NaN/Infinity ──
      // holdings 500000 (NaN row=0) + MF 100000 (Infinity row=0)
      //   + positions |100*500|=50000 (NaN row=0) = 650000
      assert.ok(
        Number.isFinite(p.totalValue),
        "totalValue must be finite, never ₹NaN"
      );
      assert.strictEqual(p.totalValue, 650000);
      assert.strictEqual(INR(p.totalValue as number), "₹6,50,000");
      assert.notStrictEqual(INR(p.totalValue as number), "₹NaN");

      // Per-segment values are finite too.
      assert.strictEqual(p.holdingsValue, 500000);
      assert.strictEqual(p.mfValue, 100000);
      assert.strictEqual(p.openPositionsValue, 50000);

      // ── totalPnL finite ──
      // holdings (500000-450000) + (NaN→0 - 100000)          = -50000
      //   + MF (100000-90000) + (Infinity→0 - 90000)         = -80000
      //   + positions totalPnl 5000 + 5000                   = +10000
      //   → -50000 + (-80000) + 10000 = -120000
      assert.ok(Number.isFinite(p.totalPnL), "totalPnL must be finite");
      assert.strictEqual(p.totalPnL, -120000);

      // ── pnlPercentage: a parseable finite string, NEVER the literal "NaN" ──
      // The service does NOT round-trip through (NaN).toFixed(2) === "NaN".
      assert.strictEqual(typeof p.pnlPercentage, "string");
      assert.notStrictEqual(p.pnlPercentage, "NaN");
      // Consumer does Number(pnlPercentage) — must stay finite.
      assert.ok(
        Number.isFinite(Number(p.pnlPercentage)),
        "Number(pnlPercentage) must be finite"
      );
      // MONEY-1074: TOTAL RETURN now includes MF (positions excluded from both
      // sides). numerator = holdingsPnL -50000 + mfPnL -80000 = -130000;
      // denominator = holdingsInvested 550000 + mfInvested 180000 = 730000;
      // -130000 / 730000 * 100 = -17.81. Still a finite, parseable string.
      assert.strictEqual(p.pnlPercentage, "-17.81");

      // ── totalRealizedPnL from the aggregate is finite ──
      assert.ok(Number.isFinite(t.totalRealizedPnL));
      assert.strictEqual(t.totalRealizedPnL, 8000);

      // ── today's P&L excludes the Invalid-Date row, stays finite ──
      assert.ok(Number.isFinite(t.todaysPnL));
      assert.strictEqual(t.todaysPnL, 2000); // only the valid today row
      assert.strictEqual(t.todaysTrades, 1);

      // ── best/worst with non-finite stored P&L surface as null (honest "—") ──
      assert.deepStrictEqual(t.bestTrade, { symbol: "BEST", pnl: null });
      assert.deepStrictEqual(t.worstTrade, { symbol: "WORST", pnl: null });

      // ── daily P&L chart: every emitted point is finite & validly dated ──
      const charts = res.data.charts as { dailyPnL: DailyPoint[] };
      assert.strictEqual(charts.dailyPnL.length, 30);
      for (const d of charts.dailyPnL) {
        assert.ok(Number.isFinite(d.pnl), "daily pnl must be finite");
        assert.ok(
          Number.isFinite(d.cumulativePnL),
          "cumulative pnl must be finite"
        );
        assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
        // A consumer formatting each point must never see NaN.
        assert.notStrictEqual(d.pnl.toFixed(2), "NaN");
      }

      // ── consumer-style assertion: nothing the dashboard formats is NaN ──
      const headlineNumbers = [
        p.totalValue,
        p.totalPnL,
        p.holdingsValue,
        p.holdingsInvested,
        p.holdingsPnL,
        p.mfValue,
        p.mfInvested,
        p.mfPnL,
        p.openPositionsValue,
        p.openPositionsPnL,
        t.totalRealizedPnL,
        t.totalUnrealizedPnL,
        t.todaysPnL,
      ] as number[];
      for (const n of headlineNumbers) {
        assert.ok(
          Number.isFinite(n),
          `every headline number must be finite (got ${String(n)})`
        );
        assert.notStrictEqual((n as number).toFixed(2), "NaN");
      }
    });

    it("clean data happy-path is unchanged (finite guards are behaviour-preserving)", async () => {
      const today = new Date();
      prisma.queue("trade", "findMany", [
        {
          id: "t1",
          symbol: "INFY",
          exchange: "NSE",
          tradeType: "SELL",
          quantity: 10,
          price: 1500,
          realizedPnL: 2000,
          tradeDate: today,
        },
      ]);
      prisma.queue("holding", "findMany", [
        {
          symbol: "RELIANCE",
          currentPrice: 2500,
          currentValue: 500000,
          investedValue: 450000,
          unrealizedPnL: 50000,
        },
      ]);
      prisma.queue("mutualFund", "findMany", [
        { currentValue: 110000, investedAmount: 90000, investedValue: null },
      ]);
      prisma.queue("position", "findMany", [
        {
          symbol: "NIFTY",
          netQuantity: 100,
          lastPrice: 500,
          unrealizedPnl: 0,
          totalPnl: 5000,
        },
      ]);
      prisma.queue("pairedTradeView", "aggregate", {
        _sum: { realizedPnL: 7000 },
        _count: 2,
      });
      prisma.queue("pairedTradeView", "count", 1); // winners
      prisma.queue("pairedTradeView", "count", 1); // losers
      prisma.queue("pairedTradeView", "findMany", []); // open
      prisma.queue("trade", "count", 5); // total trades
      prisma.queue("pairedTradeView", "findFirst", {
        symbol: "TATAMOTORS",
        realizedPnL: 900,
      });
      prisma.queue("pairedTradeView", "findFirst", {
        symbol: "YESBANK",
        realizedPnL: -200,
      });

      const res = ok(await svc.getDashboardStats("user-clean"));
      const p = res.data.portfolio as Record<string, unknown>;
      const t = res.data.trading as Record<string, unknown>;

      // holdings 500000 + MF 110000 + positions |100*500|=50000 = 660000
      assert.strictEqual(p.totalValue, 660000);
      // pnl: holdings (500000-450000)=50000 + MF (110000-90000)=20000 + positions 5000 = 75000
      assert.strictEqual(p.totalPnL, 75000);
      // MONEY-1074: MF-inclusive TOTAL RETURN (positions excluded from both
      // sides). (holdingsPnL 50000 + mfPnL 20000) / (holdingsInvested 450000 +
      // mfInvested 90000) * 100 = 70000 / 540000 * 100 = 12.96.
      assert.strictEqual(p.pnlPercentage, "12.96");
      assert.strictEqual(t.totalRealizedPnL, 7000);
      assert.strictEqual(t.todaysPnL, 2000);
      assert.strictEqual(t.todaysTrades, 1);
      assert.strictEqual(t.winRate, 50); // round(1/2*100)
      // Finite stored P&L is preserved unchanged (NOT nulled).
      assert.deepStrictEqual(t.bestTrade, { symbol: "TATAMOTORS", pnl: 900 });
      assert.deepStrictEqual(t.worstTrade, { symbol: "YESBANK", pnl: -200 });
    });
  });
});

describe("MONEY-620 — service error path (DB throw → ServiceErr, not a leak)", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });

  it("getHoldings returns a sanitized error when the DB throws", async () => {
    const { prisma } = reset();
    // Raw Mongo error from the first read in getHoldings.
    prisma.fail(
      "holding",
      "findMany",
      new Error("E11000 duplicate key error on internal.collection")
    );
    const res = await svc.getHoldings("user-err", {});
    assert.equal(res.success, false);
    // The raw Mongo error string must NOT leak to the caller.
    assert.equal((res as ServiceErr).error, "Failed to fetch holdings");
  });

  it("getPositions sanitizes a DB throw the same way", async () => {
    const { prisma } = reset();
    prisma.fail("position", "findMany", new Error("connection reset by peer"));
    const res = await svc.getPositions("user-err2", {});
    assert.equal(res.success, false);
    assert.equal((res as ServiceErr).error, "Failed to fetch positions");
  });

  // Restore the real module cache so the @usemoney/database / core / logger
  // stubs (and the re-bound service modules) never leak into a sibling suite
  // running later in the same process under the full `__tests__/**` glob.
  after(() => {
    uninstallServices();
  });
});
