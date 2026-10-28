/**
 * MONEY-620 — holdings.service.getHoldings POISON + IDOR, on the LIVE service.
 *
 * Drives the REAL exported `getHoldings` from `@usemoney/services`
 * (`packages/services/src/holdings.service.ts`) — the user-facing holdings money
 * path (`apps/web/lib/actions/holdings.ts` → `getHoldingsService`) — through a
 * RECORDING prisma double injected at the `@usemoney/database` / `@usemoney/core`
 * / `@usemoney/logger` module boundary via `require.cache`. This is the proven
 * seam from `services/services-data-e2e.test.ts` + `security/watchlist-reorder-idor.test.ts`.
 * No inline reimplementation: the SAME code that ships computes what we assert
 * (no shadow), and no live Mongo / Redis is touched (pure, exits clean).
 *
 * What this pins on the LIVE service (the service-side de-shadow / finite-guard):
 *   1. IDOR — the `holding.findMany` WHERE is scoped to the caller's userId
 *      (an attacker can never read a victim's rows); the enrichment query is
 *      scoped to the same (symbol,exchange) pairs.
 *   2. NON-FINITE POISON — ONE holding with NaN/Infinity currentValue /
 *      quantity / averagePrice / currentPrice / unrealizedPnL must NOT make the
 *      portfolio summary OR any sector/exchange subtotal NaN/Infinity, and must
 *      NOT make the summary `pnlPercentage` the literal string "NaN"/"Infinity".
 *   3. INVALID-DATE — a corrupt `createdAt` must NOT throw RangeError on
 *      `.toISOString()` (the whole holdings response used to 500); `purchaseDate`
 *      degrades to `undefined`.
 *   4. CONSUMER-SAFETY — every number in the returned shape is finite, so a UI
 *      `.toFixed()` / `.toLocaleString()` / `Number()` never sees NaN/Infinity;
 *      the breakdown subtotals RECONCILE with the grand total.
 *   5. BEHAVIOUR-PRESERVING — clean finite data yields the exact prior totals.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/holdings.service.ts + ./holdings-logic.ts
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
  /** MONEY-850 — (symbol,exchange) sets passed to the on-demand enrich helper. */
  enrichCalls: Array<Array<{ symbol: string; exchange: string }>>;
}
function freshCoreRecorder(): CoreCacheRecorder {
  return { setCachedCalls: [], enrichCalls: [] };
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

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
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
        // clearHoldingsCache / clearUserCache / …
        return async () => {};
      },
    }
  );
}

/**
 * MONEY-850 — stub `@usemoney/core/market-data` so we can spy on the
 * fire-and-forget `enrichInstrumentsBySymbol` call without racing its async DB
 * work. Records the (symbol,exchange) set the service forwards.
 */
function makeMarketDataStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "enrichInstrumentsBySymbol") {
          return async (keys: Array<{ symbol: string; exchange: string }>) => {
            activeCore.enrichCalls.push(keys);
            return {
              totalProcessed: 0,
              enriched: 0,
              failed: 0,
              skipped: 0,
              errors: [],
            };
          };
        }
        return async () => undefined;
      },
    }
  );
}

interface HoldingItemShape {
  symbol: string;
  sector: string | null;
  exchange: string;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  brokerName: string | null;
  purchaseDate?: string;
}
interface GroupShape {
  key: string;
  count: number;
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: string;
}
interface HoldingsData {
  holdings: HoldingItemShape[];
  summary: {
    totalInvested: number;
    totalCurrent: number;
    totalPnL: number;
    pnlPercentage: string;
  };
  sectorBreakdown: GroupShape[];
  exchangeBreakdown: GroupShape[];
}
type Result<T> =
  | { success: true; data: T; message?: string }
  | { success: false; error: string };

interface ServicesModule {
  getHoldings: (
    userId: string,
    filters?: { symbol?: string; sector?: string }
  ) => Promise<Result<HoldingsData>>;
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
  stub(require.resolve("@usemoney/core/market-data"), makeMarketDataStub());
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

/** How the holdings page renders the headline value — assert no NaN reaches it. */
const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** A complete Prisma Holding row (defaults clean) with the selected fields. */
function dbHolding(
  overrides: Partial<{
    id: string;
    symbol: string;
    name: string | null;
    tradingSymbol: string | null;
    sector: string | null;
    exchange: string;
    quantity: number;
    t1Quantity: number;
    averagePrice: number;
    currentPrice: number;
    investedValue: number;
    currentValue: number;
    unrealizedPnL: number;
    pnlPercentage: number;
    broker: string | null;
    brokerUserId: string | null;
    createdAt: Date;
    lastUpdated: Date;
  }> = {}
) {
  return {
    id: "h-1",
    symbol: "RELIANCE",
    name: "Reliance",
    tradingSymbol: "RELIANCE",
    sector: "Energy",
    exchange: "NSE",
    quantity: 10,
    t1Quantity: 0,
    averagePrice: 1000,
    currentPrice: 1100,
    investedValue: 10000,
    currentValue: 11000,
    unrealizedPnL: 1000,
    pnlPercentage: 10,
    broker: "ZERODHA",
    brokerUserId: "Z1",
    createdAt: new Date("2026-01-02T00:00:00Z"),
    lastUpdated: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — holdings.service.getHoldings: IDOR scope (LIVE)", () => {
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

  it("the findMany WHERE carries the caller userId (an attacker cannot read a victim's holdings)", async () => {
    prisma.queue("holding", "findMany", []);
    await svc.getHoldings("attacker-or-owner", { symbol: "tcs", sector: "IT" });
    const args = prisma.callsFor("holding", "findMany")[0]!.args as {
      where: {
        userId: string;
        OR: unknown[];
        symbol: unknown;
        sector: unknown;
      };
    };
    assert.strictEqual(args.where.userId, "attacker-or-owner");
    // Only positionful rows; the userId scope is never widened by a filter.
    assert.deepStrictEqual(args.where.OR, [
      { quantity: { gt: 0 } },
      { t1Quantity: { gt: 0 } },
    ]);
    assert.deepStrictEqual(args.where.symbol, {
      contains: "tcs",
      mode: "insensitive",
    });
    assert.strictEqual(args.where.sector, "IT");
  });
});

describe("MONEY-620 — holdings.service.getHoldings: ONE poisoned row never reaches a formatter (LIVE)", () => {
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

  it("NaN/Infinity values + Invalid-Date createdAt → FULLY FINITE shape, no throw, no '₹NaN'", async () => {
    prisma.queue("holding", "findMany", [
      // clean settled row
      dbHolding({
        id: "ok",
        symbol: "RELIANCE",
        sector: "Energy",
        exchange: "NSE",
        quantity: 10,
        investedValue: 450000,
        currentValue: 500000,
        unrealizedPnL: 50000,
      }),
      // corrupt sync row: NaN currentValue + Infinity unrealizedPnL + Invalid Date
      dbHolding({
        id: "bad",
        symbol: "ADANI",
        sector: "Energy",
        exchange: "NSE",
        quantity: 10,
        averagePrice: 0,
        currentPrice: 0,
        investedValue: 100000,
        currentValue: NaN,
        unrealizedPnL: Infinity,
        // Invalid Date — `.toISOString()` would throw RangeError if unguarded.
        createdAt: new Date("not-a-real-date"),
      }),
      // unsettled corrupt recompute row: NaN averagePrice in the T1 branch
      dbHolding({
        id: "t1bad",
        symbol: "TCS",
        sector: "IT",
        exchange: "BSE",
        quantity: 0,
        t1Quantity: 5,
        averagePrice: NaN,
        currentPrice: Infinity,
        investedValue: 0,
        currentValue: 0,
        unrealizedPnL: 0,
      }),
    ]);

    let res!: { success: true; data: HoldingsData };
    await assert.doesNotReject(async () => {
      res = ok(await svc.getHoldings("user-poison", {}));
    });

    const { holdings, summary, sectorBreakdown, exchangeBreakdown } = res.data;

    // ── summary totals: bad rows contribute 0, never NaN/Infinity ──
    // invested 450000 + 100000 + 0 = 550000; current 500000 + 0 + 0 = 500000
    assert.ok(Number.isFinite(summary.totalInvested));
    assert.ok(Number.isFinite(summary.totalCurrent));
    assert.ok(Number.isFinite(summary.totalPnL));
    assert.strictEqual(summary.totalInvested, 550000);
    assert.strictEqual(summary.totalCurrent, 500000);
    assert.strictEqual(INR(summary.totalCurrent), "₹5,00,000");
    assert.notStrictEqual(INR(summary.totalCurrent), "₹NaN");

    // ── summary % is a parseable finite string, NEVER "NaN"/"Infinity" ──
    assert.strictEqual(typeof summary.pnlPercentage, "string");
    assert.notStrictEqual(summary.pnlPercentage, "NaN");
    assert.notStrictEqual(summary.pnlPercentage, "Infinity");
    assert.ok(Number.isFinite(Number(summary.pnlPercentage)));

    // ── the corrupt row's purchaseDate degrades to undefined (no throw) ──
    const badRow = holdings.find((h) => h.symbol === "ADANI")!;
    assert.strictEqual(badRow.purchaseDate, undefined);
    assert.strictEqual(badRow.currentValue, 0); // NaN neutralised
    const okRow = holdings.find((h) => h.symbol === "RELIANCE")!;
    assert.strictEqual(okRow.purchaseDate, "2026-01-02"); // valid date preserved

    // ── EVERY per-holding number is finite (consumer .toFixed/.toLocaleString) ──
    for (const h of holdings) {
      for (const n of [
        h.investedValue,
        h.currentValue,
        h.unrealizedPnL,
        h.pnlPercentage,
      ]) {
        assert.ok(
          Number.isFinite(n),
          `holding ${h.symbol}: ${String(n)} must be finite`
        );
        assert.notStrictEqual((n as number).toFixed(2), "NaN");
      }
    }

    // ── breakdown subtotals are finite and RECONCILE with the grand total ──
    for (const g of [...sectorBreakdown, ...exchangeBreakdown]) {
      for (const n of [g.totalInvested, g.totalCurrent, g.totalPnL]) {
        assert.ok(Number.isFinite(n), `bucket ${g.key}: ${String(n)} finite`);
      }
      assert.notStrictEqual(g.pnlPercentage, "NaN");
      assert.notStrictEqual(g.pnlPercentage, "Infinity");
      assert.ok(Number.isFinite(Number(g.pnlPercentage)));
    }
    const sectorCurrent = sectorBreakdown.reduce(
      (a, g) => a + g.totalCurrent,
      0
    );
    const exchangeCurrent = exchangeBreakdown.reduce(
      (a, g) => a + g.totalCurrent,
      0
    );
    // union of buckets == summary (finite-guarded values match on both sides)
    assert.strictEqual(sectorCurrent, summary.totalCurrent);
    assert.strictEqual(exchangeCurrent, summary.totalCurrent);
    const sectorInvested = sectorBreakdown.reduce(
      (a, g) => a + g.totalInvested,
      0
    );
    assert.strictEqual(sectorInvested, summary.totalInvested);
  });

  it("ALL rows corrupt → zeroed-but-finite summary, percentage '0', no throw", async () => {
    prisma.queue("holding", "findMany", [
      dbHolding({
        id: "x1",
        quantity: 10,
        investedValue: Infinity,
        currentValue: NaN,
        unrealizedPnL: -Infinity,
        createdAt: new Date("bad"),
      }),
      dbHolding({
        id: "x2",
        quantity: 10,
        investedValue: NaN,
        currentValue: Infinity,
        unrealizedPnL: NaN,
        createdAt: new Date("bad"),
      }),
    ]);
    const res = ok(await svc.getHoldings("user-allbad", {}));
    assert.strictEqual(res.data.summary.totalInvested, 0);
    assert.strictEqual(res.data.summary.totalCurrent, 0);
    assert.strictEqual(res.data.summary.totalPnL, 0);
    assert.strictEqual(res.data.summary.pnlPercentage, "0");
  });
});

describe("MONEY-620 — holdings.service.getHoldings: behaviour-preserving on clean data (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  let core: CoreCacheRecorder;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma, core } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("settled holding: stored values trusted, totals + % unchanged from the legacy math", async () => {
    prisma.queue("holding", "findMany", [
      dbHolding({
        id: "h-1",
        symbol: "INFY",
        sector: "IT",
        exchange: "NSE",
        quantity: 10,
        t1Quantity: 0,
        averagePrice: 100,
        currentPrice: 150,
        investedValue: 1000,
        currentValue: 1500,
        unrealizedPnL: 500,
        broker: "ZERODHA",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      }),
    ]);
    const res = ok(await svc.getHoldings("user-clean", {}));
    const h = res.data.holdings[0]!;
    assert.strictEqual(h.investedValue, 1000);
    assert.strictEqual(h.currentValue, 1500);
    assert.strictEqual(h.unrealizedPnL, 500);
    assert.strictEqual(h.pnlPercentage, 50);
    assert.strictEqual(h.brokerName, "zerodha");
    assert.strictEqual(h.purchaseDate, "2026-01-02");
    assert.strictEqual(res.data.summary.totalInvested, 1000);
    assert.strictEqual(res.data.summary.totalCurrent, 1500);
    assert.strictEqual(res.data.summary.pnlPercentage, "50.00");
    // additive breakdowns present and reconcile
    assert.strictEqual(res.data.sectorBreakdown[0]!.key, "IT");
    assert.strictEqual(res.data.sectorBreakdown[0]!.totalCurrent, 1500);
    assert.strictEqual(res.data.exchangeBreakdown[0]!.key, "NSE");
    // computed result is cached
    assert.ok(
      core.setCachedCalls.some(
        (c) => c.namespace === "holdings" && c.userId === "user-clean"
      )
    );
  });

  it("unsettled (quantity 0) recomputes invested/current from T1*price (unchanged)", async () => {
    prisma.queue("holding", "findMany", [
      dbHolding({
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
        investedValue: 0, // stale; service must recompute
        currentValue: 0,
        unrealizedPnL: 0,
        broker: null,
        createdAt: new Date("2026-05-30T00:00:00Z"),
      }),
    ]);
    const res = ok(await svc.getHoldings("user-t1", {}));
    const h = res.data.holdings[0]!;
    assert.strictEqual(h.investedValue, 1000); // 5*200
    assert.strictEqual(h.currentValue, 1100); // 5*220
    assert.strictEqual(h.unrealizedPnL, 100);
    assert.strictEqual(h.brokerName, null);
  });

  it("empty portfolio → zeroed summary + empty breakdowns (no enrichment query)", async () => {
    prisma.queue("holding", "findMany", []);
    const res = ok(await svc.getHoldings("user-empty", {}));
    assert.deepStrictEqual(res.data.holdings, []);
    assert.deepStrictEqual(res.data.summary, {
      totalInvested: 0,
      totalCurrent: 0,
      totalPnL: 0,
      pnlPercentage: "0",
    });
    assert.deepStrictEqual(res.data.sectorBreakdown, []);
    assert.deepStrictEqual(res.data.exchangeBreakdown, []);
    assert.strictEqual(
      prisma.callsFor("instrumentMapping", "findMany").length,
      0
    );
  });
});

describe("MONEY-850 — holdings.service.getHoldings: on-demand sector enrichment (LIVE)", () => {
  let prisma: RecordingPrisma;
  let core: CoreCacheRecorder;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma, core } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("a held stock still missing sector after the join → fires targeted enrichment for that symbol", async () => {
    // Two holdings: TMCV (no sector) + RELIANCE (has sector). The join finds a
    // sector only for RELIANCE, so TMCV remains unenriched and should be queued.
    prisma.queue("holding", "findMany", [
      dbHolding({
        id: "tmcv",
        symbol: "TMCV",
        sector: null,
        exchange: "NSE",
      }),
      dbHolding({
        id: "rel",
        symbol: "RELIANCE",
        sector: "Energy",
        exchange: "NSE",
      }),
    ]);
    // InstrumentMapping fallback resolves nothing for TMCV.
    prisma.queue("instrumentMapping", "findMany", []);

    const res = ok(await svc.getHoldings("user-tmcv", {}));
    // read still succeeds and returns both rows (enrichment is non-blocking)
    assert.strictEqual(res.data.holdings.length, 2);

    assert.strictEqual(core.enrichCalls.length, 1);
    assert.deepStrictEqual(core.enrichCalls[0], [
      { symbol: "TMCV", exchange: "NSE" },
    ]);
  });

  it("sector resolved by the InstrumentMapping join → NO enrichment fired", async () => {
    prisma.queue("holding", "findMany", [
      dbHolding({
        id: "tmcv",
        symbol: "TMCV",
        sector: null,
        exchange: "NSE",
      }),
    ]);
    // The join DOES resolve TMCV's sector this time.
    prisma.queue("instrumentMapping", "findMany", [
      { symbol: "TMCV", exchange: "NSE", sector: "Information Technology" },
    ]);

    const res = ok(await svc.getHoldings("user-tmcv-resolved", {}));
    assert.strictEqual(res.data.holdings[0]!.sector, "Information Technology");
    assert.strictEqual(core.enrichCalls.length, 0);
  });

  it("all holdings already have a sector → no InstrumentMapping query, no enrichment", async () => {
    prisma.queue("holding", "findMany", [
      dbHolding({ id: "h1", symbol: "INFY", sector: "IT", exchange: "NSE" }),
    ]);
    ok(await svc.getHoldings("user-allsector", {}));
    assert.strictEqual(
      prisma.callsFor("instrumentMapping", "findMany").length,
      0
    );
    assert.strictEqual(core.enrichCalls.length, 0);
  });
});

describe("MONEY-620 — holdings.service.getHoldings: DB throw is sanitized (LIVE)", () => {
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  after(() => {
    uninstallServices();
  });

  it("a raw Mongo error from findMany never leaks; returns the sanitized message", async () => {
    const { prisma } = reset();
    prisma.fail(
      "holding",
      "findMany",
      new Error("E11000 duplicate key error on internal.collection")
    );
    const res = await svc.getHoldings("user-err", {});
    assert.strictEqual(res.success, false);
    assert.strictEqual(
      (res as { success: false; error: string }).error,
      "Failed to fetch holdings"
    );
  });
});
