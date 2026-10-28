/**
 * MONEY-620 — trades.service.getTrades PAGINATION + POISON + IDOR, on the LIVE
 * service.
 *
 * Drives the REAL exported `getTrades` from `@usemoney/services`
 * (`packages/services/src/trades.service.ts`) — the user-facing tradebook money
 * path (`apps/web/lib/actions/trades.ts` → `getTradesService`, and the
 * `apps/api` `/v1/trades` route) — through a RECORDING prisma double injected at
 * the `@usemoney/database` / `@usemoney/core` / `@usemoney/logger` module
 * boundary via `require.cache`. Same proven seam as
 * `services/holdings-poison-live.test.ts`. No inline reimplementation: the SAME
 * code that ships computes what we assert (no shadow), and no live Mongo / Redis
 * is touched (pure, exits clean).
 *
 * What this pins on the LIVE service (the service-side de-shadow / hardening):
 *   1. PAGINATION (the notifications-style 500): a NaN (`?limit=abc`) / negative
 *      / absurd `filters.limit`/`filters.skip` is CLAMPED before it reaches
 *      `prisma.trade.findMany({ take, skip })` — the recorder proves `take`/`skip`
 *      are always finite ints in range, never NaN (which Prisma rejects as
 *      "Expected Int" → a 500).
 *   2. IDOR — the `trade.findMany` + every `count`/`aggregate` WHERE is scoped to
 *      the caller userId; a `broker` filter cannot widen scope to a victim.
 *   3. NON-FINITE POISON — a CLOSED row with NaN/Infinity price/quantity (a
 *      corrupt sync/import) must NOT make any `tradeValue`, `realizedPnL`, or the
 *      `stats` totals NaN/Infinity, and `winRate` must stay a finite int.
 *   4. INVALID-DATE — a corrupt `tradeDate` must NOT throw RangeError while the
 *      service pairs/groups trades (the whole tradebook response used to 500).
 *   5. CONSUMER-SAFETY — every number in the returned shape is finite, so a UI
 *      `.toFixed()` / `.toLocaleString()` / `Number()` never sees NaN/Infinity.
 *   6. WIN-RATE divide-by-zero — 0 closed trades → winRate 0, not NaN.
 *   7. BEHAVIOUR-PRESERVING — clean finite data yields the exact prior totals.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/trades.service.ts + ./trades-logic.ts
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
        // clearTradeCache / clearPositionCache / clearUserCache / …
        return async () => {};
      },
    }
  );
}

// ── service shape ────────────────────────────────────────────────────────────

interface TradeItemShape {
  id: string;
  symbol: string;
  quantity: number;
  price: number;
  exitPrice: number | null;
  tradeValue: number | null;
  realizedPnL: number | null;
  status: string;
  tradeDate: Date;
  broker: string | null;
  brokerDisplayName?: string | null;
  segmentLabel?: string;
}
interface TradeStatsShape {
  totalPnL: number;
  winRate: number;
  winners: number;
  losers: number;
  totalTrades: number;
}
interface TradesData {
  trades: TradeItemShape[];
  total: number;
  stats: TradeStatsShape;
}
type Result<T> =
  | { success: true; data: T; message?: string }
  | { success: false; error: string };

interface TradeFilters {
  symbol?: string;
  broker?: string;
  segment?: string;
  tradeType?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  skip?: number;
}

interface ServicesModule {
  getTrades: (
    userId: string,
    filters: TradeFilters
  ) => Promise<Result<TradesData>>;
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

function reset(): { prisma: RecordingPrisma; core: CoreCacheRecorder } {
  activePrisma = new RecordingPrisma();
  activeCore = freshCoreRecorder();
  return { prisma: activePrisma, core: activeCore };
}

function ok<T>(r: Result<T>): { success: true; data: T } {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as { success: true; data: T };
}

/** How the tradebook renders the headline P&L — assert no NaN reaches it. */
const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/** A complete Prisma Trade row (defaults clean) with the selected fields. */
function dbTrade(
  overrides: Partial<{
    id: string;
    userId: string;
    symbol: string;
    exchange: string;
    segment: string;
    tradeType: string;
    positionType: string;
    orderType: string;
    productType: string;
    quantity: number;
    price: number;
    exitPrice: number | null;
    tradeValue: number | null;
    brokerage: number;
    taxes: number;
    realizedPnL: number | null;
    status: string;
    tradeDate: Date;
    exitDate: Date | null;
    broker: string | null;
    brokerUserId: string | null;
    brokerName: string | null;
    tags: string[];
    notes: string | null;
    sourceType: string;
    isEditable: boolean;
    createdAt: Date;
    updatedAt: Date;
  }> = {}
) {
  return {
    id: "t-1",
    userId: "u",
    symbol: "RELIANCE",
    exchange: "NSE",
    segment: "CASH",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "MARKET",
    productType: "CNC",
    quantity: 10,
    price: 100,
    exitPrice: null,
    tradeValue: 1000,
    brokerage: 20,
    taxes: 0,
    realizedPnL: null,
    status: "OPEN",
    tradeDate: new Date("2024-06-01T00:00:00Z"),
    exitDate: null,
    broker: null,
    brokerUserId: null,
    brokerName: null,
    tags: [],
    notes: null,
    sourceType: "MANUAL",
    isEditable: true,
    createdAt: new Date("2024-06-01T00:00:00Z"),
    updatedAt: new Date("2024-06-01T00:00:00Z"),
    ...overrides,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — trades.service.getTrades: pagination clamp reaches Prisma (LIVE)", () => {
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

  function findManyArgs(): {
    take: unknown;
    skip: unknown;
    where: { userId: string };
  } {
    return prisma.callsFor("trade", "findMany")[0]!.args as {
      take: unknown;
      skip: unknown;
      where: { userId: string };
    };
  }

  it("a NaN limit/skip (`?limit=abc` parseInt) is clamped to finite ints, never reaches findMany as NaN", async () => {
    const nan = parseInt("abc", 10);
    assert.ok(Number.isNaN(nan));
    await svc.getTrades("u", { limit: nan, skip: nan });
    const { take, skip } = findManyArgs();
    assert.equal(take, 20); // DEFAULT_TRADE_LIMIT
    assert.equal(skip, 0);
    assert.ok(Number.isInteger(take as number));
    assert.ok(Number.isInteger(skip as number));
    assert.ok(!Number.isNaN(take as number));
    assert.ok(!Number.isNaN(skip as number));
  });

  it("a negative limit (-5) / skip is clamped (no Prisma 'Expected Int')", async () => {
    await svc.getTrades("u", { limit: -5, skip: -100 });
    const { take, skip } = findManyArgs();
    assert.equal(take, 20);
    assert.equal(skip, 0);
  });

  it("an absurd limit (99999999) is capped to 100 before findMany", async () => {
    await svc.getTrades("u", { limit: 99999999, skip: 0 });
    assert.equal(findManyArgs().take, 100);
  });

  it("a normal in-range (limit, skip) is forwarded verbatim (behaviour preserved)", async () => {
    await svc.getTrades("u", { limit: 25, skip: 40 });
    const { take, skip } = findManyArgs();
    assert.equal(take, 25);
    assert.equal(skip, 40);
  });

  it("Infinity limit/skip never produce a non-finite take/skip", async () => {
    await svc.getTrades("u", { limit: Infinity, skip: Infinity });
    const { take, skip } = findManyArgs();
    assert.ok(Number.isFinite(take as number));
    assert.ok(Number.isFinite(skip as number));
    assert.equal(take, 20);
    assert.equal(skip, 0);
  });
});

describe("MONEY-620 — trades.service.getTrades: IDOR scope (LIVE)", () => {
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

  it("findMany + count + aggregate WHEREs all carry the caller userId (no victim read)", async () => {
    await svc.getTrades("attacker-or-owner", {
      symbol: "tcs",
      broker: "ZERODHA:victim-user",
      tradeType: "BUY",
    });
    // list query scoped to caller; a broker filter cannot widen scope
    const fm = prisma.callsFor("trade", "findMany")[0]!.args as {
      where: {
        userId: string;
        symbol: unknown;
        broker: unknown;
        tradeType: unknown;
      };
    };
    assert.equal(fm.where.userId, "attacker-or-owner");
    assert.deepEqual(fm.where.symbol, { contains: "tcs", mode: "insensitive" });
    assert.equal(fm.where.broker, "ZERODHA");
    assert.equal(fm.where.tradeType, "BUY");

    // every count + aggregate is scoped to the same userId
    for (const c of prisma.callsFor("trade", "count")) {
      assert.equal(
        (c.args as { where: { userId: string } }).where.userId,
        "attacker-or-owner"
      );
    }
    for (const a of prisma.callsFor("trade", "aggregate")) {
      assert.equal(
        (a.args as { where: { userId: string } }).where.userId,
        "attacker-or-owner"
      );
    }
    // MONEY-840: the persisted-pairing stats + per-row queries are also IDOR-scoped.
    for (const a of prisma.callsFor("pairedTradeView", "aggregate")) {
      assert.equal(
        (a.args as { where: { userId: string } }).where.userId,
        "attacker-or-owner"
      );
    }
    for (const c of prisma.callsFor("pairedTradeView", "count")) {
      assert.equal(
        (c.args as { where: { userId: string } }).where.userId,
        "attacker-or-owner"
      );
    }
    for (const f of prisma.callsFor("pairedTradeView", "findMany")) {
      assert.equal(
        (f.args as { where: { userId: string } }).where.userId,
        "attacker-or-owner"
      );
    }
  });
});

describe("MONEY-620 — trades.service.getTrades: poison + invalid date never reach a formatter (LIVE)", () => {
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

  it("NaN/Infinity price+qty CLOSED rows + an Invalid-Date row → FULLY FINITE shape, no throw, no '₹NaN'", async () => {
    // findMany page: one clean CLOSED pair-able row + corrupt rows.
    prisma.queue("trade", "findMany", [
      dbTrade({
        id: "ok",
        symbol: "INFY",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        tradeValue: 1000,
        status: "OPEN",
      }),
      dbTrade({
        id: "poison",
        symbol: "ADANI",
        tradeType: "BUY",
        quantity: NaN,
        price: Infinity,
        tradeValue: NaN,
        realizedPnL: Infinity,
        status: "OPEN",
      }),
      dbTrade({
        id: "baddate",
        symbol: "TCS",
        tradeType: "SELL",
        quantity: 5,
        price: 200,
        tradeValue: 1000,
        // Invalid Date — pairing's group key would throw on .toISOString() if unguarded.
        tradeDate: new Date("not-a-real-date"),
        status: "OPEN",
      }),
    ]);
    prisma.queue("trade", "count", 3); // total
    // MONEY-840: the stats strip now reads CLOSED-lot aggregates from the
    // PERSISTED pairedTradeView (not trade.aggregate). The poisoned _sum still
    // has to neutralise to a finite 0 here.
    prisma.queue("pairedTradeView", "aggregate", {
      _sum: { realizedPnL: Infinity },
    });
    prisma.queue("pairedTradeView", "count", 1); // winnerCount
    prisma.queue("pairedTradeView", "count", 2); // closedCount
    prisma.queue("pairedTradeView", "findMany", []); // no per-row views

    let res!: { success: true; data: TradesData };
    await assert.doesNotReject(async () => {
      res = ok(await svc.getTrades("user-poison", {}));
    });

    const { trades, stats } = res.data;

    // ── stats: poisoned aggregate neutralised, win rate finite ──
    assert.ok(Number.isFinite(stats.totalPnL));
    assert.equal(stats.totalPnL, 0); // Infinity _sum → 0
    assert.ok(Number.isFinite(stats.winRate));
    assert.equal(stats.winRate, 50); // round(1/2*100)
    assert.equal(stats.winners, 1);
    assert.equal(stats.losers, 1);
    assert.notEqual(INR(stats.totalPnL), "₹NaN");

    // ── every per-trade number is finite (consumer .toFixed/.toLocaleString) ──
    for (const t of trades) {
      for (const n of [t.tradeValue, t.realizedPnL]) {
        if (n !== null) {
          assert.ok(
            Number.isFinite(n),
            `trade ${t.symbol}: ${String(n)} must be finite`
          );
          assert.notEqual((n as number).toFixed(2), "NaN");
        }
      }
    }
    // the poisoned row's tradeValue was re-derived to a finite number (0)
    const poison = trades.find((t) => t.symbol === "ADANI")!;
    assert.equal(poison.tradeValue, 0);
    // the clean row keeps its value
    assert.equal(trades.find((t) => t.symbol === "INFY")!.tradeValue, 1000);
  });

  it("ALL closed rows corrupt → zeroed-but-finite stats, no throw", async () => {
    prisma.queue("trade", "findMany", [
      dbTrade({
        id: "x1",
        quantity: NaN,
        price: Infinity,
        tradeValue: NaN,
        status: "OPEN",
      }),
    ]);
    prisma.queue("trade", "count", 1);
    prisma.queue("trade", "aggregate", { _sum: { realizedPnL: NaN } });
    prisma.queue("trade", "count", 0); // winnerCount
    prisma.queue("trade", "count", 0); // closedCount
    const res = ok(await svc.getTrades("user-allbad", {}));
    assert.equal(res.data.stats.totalPnL, 0);
    assert.equal(res.data.stats.winRate, 0);
    assert.equal(res.data.stats.winners, 0);
    assert.equal(res.data.stats.losers, 0);
  });
});

describe("MONEY-620 — trades.service.getTrades: list-shape edges (LIVE)", () => {
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

  it("empty list → empty trades + zeroed stats (winRate 0, no divide-by-zero)", async () => {
    prisma.queue("trade", "findMany", []);
    prisma.queue("trade", "count", 0);
    prisma.queue("trade", "aggregate", { _sum: { realizedPnL: null } });
    prisma.queue("trade", "count", 0);
    prisma.queue("trade", "count", 0);
    const res = ok(await svc.getTrades("user-empty", {}));
    assert.deepEqual(res.data.trades, []);
    assert.equal(res.data.total, 0);
    assert.equal(res.data.stats.totalPnL, 0);
    assert.equal(res.data.stats.winRate, 0);
  });

  it("single BUY-only row stays OPEN (no spurious pairing), stats from 0 closed", async () => {
    prisma.queue("trade", "findMany", [
      dbTrade({
        id: "b",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        status: "OPEN",
      }),
    ]);
    prisma.queue("trade", "count", 1);
    prisma.queue("trade", "aggregate", { _sum: { realizedPnL: null } });
    prisma.queue("trade", "count", 0);
    prisma.queue("trade", "count", 0);
    const res = ok(await svc.getTrades("user-buyonly", {}));
    assert.equal(res.data.trades.length, 1);
    assert.equal(res.data.trades[0]!.status, "OPEN");
    assert.equal(res.data.stats.winRate, 0);
  });

  it("SELL-only row stays OPEN", async () => {
    prisma.queue("trade", "findMany", [
      dbTrade({
        id: "s",
        tradeType: "SELL",
        quantity: 10,
        price: 100,
        status: "OPEN",
      }),
    ]);
    prisma.queue("trade", "count", 1);
    const res = ok(await svc.getTrades("user-sellonly", {}));
    assert.equal(res.data.trades[0]!.status, "OPEN");
  });

  it("a matched BUY+SELL pair reads CLOSED from the persisted PairedTradeView (MONEY-840)", async () => {
    // MONEY-840: status + per-row realised P&L come from the persisted
    // PairedTradeView the worker wrote — NOT a read-time pairer. Both legs of a
    // CLOSED lot read CLOSED; the realised P&L is attributed to the closing SELL.
    const d = new Date("2024-06-01T00:00:00Z");
    prisma.queue("trade", "findMany", [
      dbTrade({
        id: "b",
        symbol: "INFY",
        tradeType: "BUY",
        quantity: 100,
        price: 2500,
        tradeDate: d,
        status: "OPEN", // sync never sets Trade.status
      }),
      dbTrade({
        id: "s",
        symbol: "INFY",
        tradeType: "SELL",
        quantity: 100,
        price: 2600,
        tradeDate: d,
        status: "OPEN",
      }),
    ]);
    prisma.queue("trade", "count", 2);
    // Stats from the pairedTradeView CLOSED aggregates.
    prisma.queue("pairedTradeView", "aggregate", {
      _sum: { realizedPnL: 10000 },
    });
    prisma.queue("pairedTradeView", "count", 1); // 1 winning lot
    prisma.queue("pairedTradeView", "count", 1); // 1 closed lot
    // The persisted lot linking the two trades.
    prisma.queue("pairedTradeView", "findMany", [
      {
        sourceTradeIds: ["b", "s"],
        entryTradeId: "b",
        exitTradeId: "s",
        status: "CLOSED",
        realizedPnL: 10000,
      },
    ]);
    const res = ok(await svc.getTrades("user-pair", {}));
    const buy = res.data.trades.find((t) => t.id === "b")!;
    const sell = res.data.trades.find((t) => t.id === "s")!;
    assert.equal(buy.status, "CLOSED");
    assert.equal(sell.status, "CLOSED");
    // Realised P&L attributed to the closing SELL; the BUY shows null.
    assert.equal(sell.realizedPnL, 10000);
    assert.equal(buy.realizedPnL, null);
    // Stats come from the pairedTradeView aggregate path.
    assert.equal(res.data.stats.totalPnL, 10000);
  });
});

describe("MONEY-620 — trades.service.getTrades: behaviour-preserving + cache + error (LIVE)", () => {
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

  it("a cache HIT returns immediately without querying Prisma", async () => {
    core.cacheHit = {
      trades: [],
      total: 7,
      stats: {
        totalPnL: 1,
        winRate: 100,
        winners: 1,
        losers: 0,
        totalTrades: 7,
      },
    };
    const res = ok(await svc.getTrades("user-cached", { limit: 20, skip: 0 }));
    assert.equal(res.data.total, 7);
    assert.equal(prisma.callsFor("trade", "findMany").length, 0);
  });

  it("clean closed row: stored P&L + labels preserved; result is cached", async () => {
    prisma.queue("trade", "findMany", [
      dbTrade({
        id: "c1",
        symbol: "INFY",
        segment: "CASH",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        exitPrice: 120,
        tradeValue: 1000,
        realizedPnL: 200,
        status: "CLOSED",
        broker: "ZERODHA",
      }),
    ]);
    prisma.queue("trade", "count", 1);
    // MONEY-840: stats from the persisted pairedTradeView CLOSED lots.
    prisma.queue("pairedTradeView", "aggregate", {
      _sum: { realizedPnL: 200 },
    });
    prisma.queue("pairedTradeView", "count", 1); // winner
    prisma.queue("pairedTradeView", "count", 1); // closed
    prisma.queue("pairedTradeView", "findMany", [
      {
        sourceTradeIds: ["c1"],
        entryTradeId: "c1",
        exitTradeId: "c1",
        status: "CLOSED",
        realizedPnL: 200,
      },
    ]);
    const res = ok(await svc.getTrades("user-clean", {}));
    const t = res.data.trades[0]!;
    assert.equal(t.tradeValue, 1000);
    assert.equal(t.segmentLabel, "Equity"); // CASH → Equity mapping
    assert.equal(t.brokerDisplayName, "ZERODHA");
    assert.equal(res.data.stats.totalPnL, 200);
    assert.equal(res.data.stats.winRate, 100);
    assert.equal(res.data.stats.winners, 1);
    assert.equal(res.data.stats.losers, 0);
    // computed result is cached under the trades namespace for this user
    assert.ok(
      core.setCachedCalls.some(
        (c) => c.namespace === "trades" && c.userId === "user-clean"
      )
    );
  });

  it("a raw Mongo error from findMany never leaks; returns the sanitized message", async () => {
    prisma.fail(
      "trade",
      "findMany",
      new Error("E11000 duplicate key error on internal.collection")
    );
    const res = await svc.getTrades("user-err", {});
    assert.equal(res.success, false);
    assert.equal(
      (res as { success: false; error: string }).error,
      "Failed to fetch trades"
    );
  });
});
