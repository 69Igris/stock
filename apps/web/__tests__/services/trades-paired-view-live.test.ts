/**
 * MONEY-840 — trades.service.getTrades reads STATUS + realised P&L + the stats
 * strip from the PERSISTED PairedTradeView, on the LIVE service.
 *
 * Drives the REAL exported `getTrades` from `@usemoney/services`
 * (`packages/services/src/trades.service.ts`) — the user-facing tradebook path
 * (`apps/web/lib/actions/trades.ts` → `getTradesService`) — through a RECORDING
 * prisma double injected at the `@usemoney/database` / `@usemoney/core` /
 * `@usemoney/logger` module boundary via `require.cache`. Same proven seam as
 * `services/trades-poison-live.test.ts`. No inline reimplementation: the SAME
 * code that ships computes what we assert (no shadow), and no live Mongo / Redis
 * is touched (pure, exits clean).
 *
 * What this pins on the LIVE service (the MONEY-840 read-path cutover):
 *   1. PER-ROW STATUS comes from the persisted PairedTradeView (CLOSED/PARTIAL/
 *      OPEN), NOT from stored Trade.status — sync never sets Trade.status, so the
 *      old read-time `pairTrades` was the only producer and it's now gone.
 *   2. MULTI-DAY DELIVERY shows CLOSED — a BUY on day 1 + SELL on day 30 that the
 *      worker paired into a CLOSED view now BOTH read CLOSED. The old per-page
 *      pairer keyed on TRADE-DATE, so a multi-day delivery never paired and
 *      showed OPEN forever (the exact bug this ticket fixes).
 *   3. STATS (totalPnL / winRate / closedCount / winners) come from the
 *      PairedTradeView CLOSED-lot aggregates, NOT from Trade.status (always 0).
 *   4. PER-ROW realised P&L is attributed to the closing SELL of a CLOSED lot.
 *   5. CROSS-PAGE status stability — a later page's rows resolve their status
 *      from their own views (no date-keyed per-page drift).
 *   6. The PairedTradeView stats query is IDOR-scoped to the caller userId.
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

  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
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
// Cache shim: getCached always misses (so the real query path runs), setCached
// is a no-op, every clear* is a no-op.
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
        if (k === "setCached") return async () => {};
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
  realizedPnL: number | null;
  status: string;
  tradeDate: Date;
}
interface TradeStatsShape {
  totalPnL: number;
  winRate: number;
  winners: number;
  losers: number;
  closedCount: number;
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

function reset(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  return activePrisma;
}

function ok<T>(r: Result<T>): { success: true; data: T } {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as { success: true; data: T };
}

// ── fixtures ───────────────────────────────────────────────────────────────

/** A complete Prisma Trade row (defaults clean). Note status defaults to OPEN
 *  — and crucially STAYS that way unless a PairedTradeView overrides it, which
 *  is the whole point: sync never sets Trade.status. */
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
    // Sync NEVER sets these two — they stay OPEN / null on a real synced row.
    realizedPnL: null,
    status: "OPEN",
    tradeDate: new Date("2024-06-01T00:00:00Z"),
    exitDate: null,
    broker: "ZERODHA",
    brokerUserId: "ZH1",
    brokerName: null,
    tags: [],
    notes: null,
    sourceType: "SYNCED",
    isEditable: false,
    createdAt: new Date("2024-06-01T00:00:00Z"),
    updatedAt: new Date("2024-06-01T00:00:00Z"),
    ...overrides,
  };
}

/** A persisted PairedTradeView row (the worker's FIFO output). */
function dbView(
  overrides: Partial<{
    sourceTradeIds: string[];
    entryTradeId: string | null;
    exitTradeId: string | null;
    status: string;
    realizedPnL: number | null;
  }> = {}
) {
  return {
    sourceTradeIds: [],
    entryTradeId: null,
    exitTradeId: null,
    status: "OPEN",
    realizedPnL: null,
    ...overrides,
  };
}

/**
 * Queue the five reads `getTrades` issues, in the exact order the service does:
 *   trade.findMany, trade.count, pairedTradeView.aggregate,
 *   pairedTradeView.count (winners), pairedTradeView.count (closed),
 *   then pairedTradeView.findMany (page views).
 */
function queueReads(
  prisma: RecordingPrisma,
  opts: {
    trades: ReturnType<typeof dbTrade>[];
    total: number;
    closedSum: number | null;
    winners: number;
    closed: number;
    pageViews: ReturnType<typeof dbView>[];
  }
): void {
  prisma.queue("trade", "findMany", opts.trades);
  prisma.queue("trade", "count", opts.total);
  prisma.queue("pairedTradeView", "aggregate", {
    _sum: { realizedPnL: opts.closedSum },
  });
  prisma.queue("pairedTradeView", "count", opts.winners); // winners (shift 1)
  prisma.queue("pairedTradeView", "count", opts.closed); // closed (shift 2)
  prisma.queue("pairedTradeView", "findMany", opts.pageViews);
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-840 — getTrades: per-row status from PairedTradeView (LIVE)", () => {
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

  it("a SYNCED row (Trade.status=OPEN) reads CLOSED when a CLOSED view links it", async () => {
    const buy = dbTrade({ id: "b1", tradeType: "BUY", status: "OPEN" });
    const sell = dbTrade({
      id: "s1",
      tradeType: "SELL",
      status: "OPEN",
      tradeDate: new Date("2024-06-02T00:00:00Z"),
    });
    queueReads(prisma, {
      trades: [sell, buy],
      total: 2,
      closedSum: 500,
      winners: 1,
      closed: 1,
      pageViews: [
        dbView({
          sourceTradeIds: ["b1", "s1"],
          entryTradeId: "b1",
          exitTradeId: "s1",
          status: "CLOSED",
          realizedPnL: 500,
        }),
      ],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    const byId = new Map(data.trades.map((t) => [t.id, t]));
    assert.equal(byId.get("b1")!.status, "CLOSED");
    assert.equal(byId.get("s1")!.status, "CLOSED");
  });

  it("a row in NO view defaults to OPEN (just synced, before/without a lot)", async () => {
    const buy = dbTrade({ id: "b1", tradeType: "BUY", status: "OPEN" });
    queueReads(prisma, {
      trades: [buy],
      total: 1,
      closedSum: null,
      winners: 0,
      closed: 0,
      pageViews: [], // no view references this trade
    });
    const { data } = ok(await svc.getTrades("u", {}));
    assert.equal(data.trades[0]!.status, "OPEN");
  });

  it("PARTIAL view → row reads PARTIAL", async () => {
    const buy = dbTrade({ id: "b1", tradeType: "BUY" });
    queueReads(prisma, {
      trades: [buy],
      total: 1,
      closedSum: null,
      winners: 0,
      closed: 0,
      pageViews: [
        dbView({
          sourceTradeIds: ["b1"],
          entryTradeId: "b1",
          status: "PARTIAL",
        }),
      ],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    assert.equal(data.trades[0]!.status, "PARTIAL");
  });

  it("CLOSED outranks OPEN when a trade sits in BOTH a closed and an open lot", async () => {
    // A large buy partly closed (CLOSED lot) with an open remainder (OPEN lot).
    const buy = dbTrade({ id: "b1", tradeType: "BUY", quantity: 100 });
    queueReads(prisma, {
      trades: [buy],
      total: 1,
      closedSum: 200,
      winners: 1,
      closed: 1,
      pageViews: [
        dbView({
          sourceTradeIds: ["b1", "s1"],
          entryTradeId: "b1",
          exitTradeId: "s1",
          status: "CLOSED",
          realizedPnL: 200,
        }),
        dbView({ sourceTradeIds: ["b1"], entryTradeId: "b1", status: "OPEN" }),
      ],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    assert.equal(data.trades[0]!.status, "CLOSED");
  });

  it("status comes from the VIEW, not Trade.status — a stale Trade.status=CLOSED with no view reads OPEN", async () => {
    // Defensive: even if some legacy row carries a stale CLOSED Trade.status, the
    // view is the source of truth. No view ⇒ OPEN.
    const t = dbTrade({ id: "t9", status: "CLOSED" });
    queueReads(prisma, {
      trades: [t],
      total: 1,
      closedSum: null,
      winners: 0,
      closed: 0,
      pageViews: [],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    assert.equal(data.trades[0]!.status, "OPEN");
  });
});

describe("MONEY-840 — getTrades: MULTI-DAY delivery now CLOSED (the date-keyed bug) (LIVE)", () => {
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

  it("BUY day-1 + SELL day-30 paired into a CLOSED view: BOTH rows read CLOSED (old per-page pairer showed OPEN)", async () => {
    const buy = dbTrade({
      id: "b1",
      tradeType: "BUY",
      tradeDate: new Date("2024-01-01T00:00:00Z"),
    });
    const sell = dbTrade({
      id: "s1",
      tradeType: "SELL",
      tradeDate: new Date("2024-01-31T00:00:00Z"), // 30 days later
    });
    queueReads(prisma, {
      trades: [sell, buy],
      total: 2,
      closedSum: 1500,
      winners: 1,
      closed: 1,
      pageViews: [
        dbView({
          sourceTradeIds: ["b1", "s1"],
          entryTradeId: "b1",
          exitTradeId: "s1",
          status: "CLOSED",
          realizedPnL: 1500,
        }),
      ],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    const byId = new Map(data.trades.map((t) => [t.id, t]));
    // The date-keyed per-page pairer keyed on YYYY-MM-DD, so a Jan-1 buy and a
    // Jan-31 sell landed in different buckets and never paired → OPEN forever.
    assert.equal(byId.get("b1")!.status, "CLOSED");
    assert.equal(byId.get("s1")!.status, "CLOSED");
  });
});

describe("MONEY-840 — getTrades: per-row realised P&L attributed to the exit SELL (LIVE)", () => {
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

  it("the closing SELL carries realizedPnL; the BUY shows null", async () => {
    const buy = dbTrade({ id: "b1", tradeType: "BUY" });
    const sell = dbTrade({ id: "s1", tradeType: "SELL" });
    queueReads(prisma, {
      trades: [sell, buy],
      total: 2,
      closedSum: 700,
      winners: 1,
      closed: 1,
      pageViews: [
        dbView({
          sourceTradeIds: ["b1", "s1"],
          entryTradeId: "b1",
          exitTradeId: "s1",
          status: "CLOSED",
          realizedPnL: 700,
        }),
      ],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    const byId = new Map(data.trades.map((t) => [t.id, t]));
    assert.equal(byId.get("s1")!.realizedPnL, 700);
    assert.equal(byId.get("b1")!.realizedPnL, null);
  });

  it("a SELL that closes two lots accumulates both realised P&Ls", async () => {
    const sell = dbTrade({ id: "s1", tradeType: "SELL" });
    queueReads(prisma, {
      trades: [sell],
      total: 1,
      closedSum: 300,
      winners: 1,
      closed: 2,
      pageViews: [
        dbView({ exitTradeId: "s1", status: "CLOSED", realizedPnL: 100 }),
        dbView({ exitTradeId: "s1", status: "CLOSED", realizedPnL: 200 }),
      ],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    assert.equal(data.trades[0]!.realizedPnL, 300);
  });

  it("a non-finite stored realizedPnL on a view never leaks NaN to the row", async () => {
    const sell = dbTrade({ id: "s1", tradeType: "SELL" });
    queueReads(prisma, {
      trades: [sell],
      total: 1,
      closedSum: 0,
      winners: 0,
      closed: 1,
      pageViews: [
        dbView({
          exitTradeId: "s1",
          status: "CLOSED",
          realizedPnL: Number.POSITIVE_INFINITY,
        }),
      ],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    const pnl = data.trades[0]!.realizedPnL;
    // finite-guarded: Infinity collapses to 0 (a finite, render-safe value).
    assert.equal(pnl, 0);
    assert.ok(pnl === null || Number.isFinite(pnl));
  });
});

describe("MONEY-840 — getTrades: stats strip from PairedTradeView CLOSED lots (LIVE)", () => {
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

  it("totalPnL / winRate / winners / closedCount come from the view aggregates, not Trade.status", async () => {
    // 4 closed lots, 3 winners, total realised 1000 → winRate 75%.
    queueReads(prisma, {
      trades: [dbTrade({ id: "t1", status: "OPEN" })],
      total: 9,
      closedSum: 1000,
      winners: 3,
      closed: 4,
      pageViews: [],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    assert.equal(data.stats.totalPnL, 1000);
    assert.equal(data.stats.closedCount, 4);
    assert.equal(data.stats.winners, 3);
    assert.equal(data.stats.losers, 1);
    assert.equal(data.stats.winRate, 75);
    assert.equal(data.stats.totalTrades, 9); // totalTrades = Trade count
  });

  it("the realised-P&L aggregate is run against pairedTradeView (status CLOSED), NOT trade", async () => {
    queueReads(prisma, {
      trades: [],
      total: 0,
      closedSum: null,
      winners: 0,
      closed: 0,
      pageViews: [],
    });
    await svc.getTrades("u", {});
    // The sum aggregate must be on pairedTradeView, with a CLOSED status filter.
    const agg = prisma.callsFor("pairedTradeView", "aggregate");
    assert.equal(
      agg.length,
      1,
      "expected exactly one pairedTradeView.aggregate"
    );
    const where = (agg[0]!.args as { where: { status: string } }).where;
    assert.equal(where.status, "CLOSED");
    // And NO aggregate is run against the trade model anymore.
    assert.equal(prisma.callsFor("trade", "aggregate").length, 0);
  });

  it("0 closed lots → winRate 0 (no divide-by-zero) and totalPnL 0", async () => {
    queueReads(prisma, {
      trades: [dbTrade({ id: "t1" })],
      total: 1,
      closedSum: null,
      winners: 0,
      closed: 0,
      pageViews: [],
    });
    const { data } = ok(await svc.getTrades("u", {}));
    assert.equal(data.stats.winRate, 0);
    assert.equal(data.stats.totalPnL, 0);
    assert.equal(data.stats.closedCount, 0);
  });
});

describe("MONEY-840 — getTrades: cross-page status stability + IDOR scope (LIVE)", () => {
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

  it("page 2 rows resolve status from their OWN views (no date-keyed per-page drift)", async () => {
    // Simulate the 2nd page: a SELL whose CLOSED lot links a buy from page 1.
    const sell = dbTrade({ id: "s2", tradeType: "SELL" });
    queueReads(prisma, {
      trades: [sell],
      total: 60, // more than one page exists
      closedSum: 250,
      winners: 1,
      closed: 1,
      pageViews: [
        dbView({
          sourceTradeIds: ["b-from-page-1", "s2"],
          entryTradeId: "b-from-page-1",
          exitTradeId: "s2",
          status: "CLOSED",
          realizedPnL: 250,
        }),
      ],
    });
    const { data } = ok(await svc.getTrades("u", { skip: 50, limit: 50 }));
    assert.equal(data.trades[0]!.status, "CLOSED");
    assert.equal(data.trades[0]!.realizedPnL, 250);
  });

  it("the page-views findMany is IDOR-scoped to the caller userId", async () => {
    const buy = dbTrade({ id: "b1" });
    queueReads(prisma, {
      trades: [buy],
      total: 1,
      closedSum: null,
      winners: 0,
      closed: 0,
      pageViews: [dbView({ sourceTradeIds: ["b1"], status: "OPEN" })],
    });
    await svc.getTrades("victim-or-owner", {});
    const fm = prisma.callsFor("pairedTradeView", "findMany");
    assert.equal(fm.length, 1);
    const where = (fm[0]!.args as { where: { userId: string } }).where;
    assert.equal(where.userId, "victim-or-owner");
  });

  it("the CLOSED-lot stats query is IDOR-scoped to the caller userId", async () => {
    queueReads(prisma, {
      trades: [],
      total: 0,
      closedSum: null,
      winners: 0,
      closed: 0,
      pageViews: [],
    });
    await svc.getTrades("owner-x", { broker: "ZERODHA:other-user" });
    const agg = prisma.callsFor("pairedTradeView", "aggregate")[0]!.args as {
      where: { userId: string };
    };
    assert.equal(agg.where.userId, "owner-x");
  });
});
