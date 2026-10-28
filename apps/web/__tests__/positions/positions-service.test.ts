/**
 * MONEY-620 — Positions money-path: pure logic + LIVE service (de-shadowed).
 *
 * Two layers, both asserting REAL exported symbols (no shadow reimplementation):
 *
 *   1. UNIT — imports the pure helpers from `packages/services/src/positions-logic`
 *      (the Prisma-free module the LIVE `positions.service` now CALLS) via the
 *      relative path, and feeds them adversarial fixtures: NaN/±Infinity poison,
 *      divide-by-zero cost basis, netQuantity-0/short/oversold classification,
 *      Invalid-Date formatting, huge notionals, zero-price options.
 *
 *   2. LIVE SERVICE — drives the REAL `getPositions` / `getClosedTodayPositions`
 *      exported from `@usemoney/services` through a recording-prisma seam
 *      (the established `require.cache` pattern from `services-data-e2e.test.ts`),
 *      asserting the user-facing output is fully finite on a poisoned sync row,
 *      never throws on an Invalid-Date, and is scoped to the caller's userId
 *      (IDOR). This is the F&O positions path the Positions tab renders.
 *
 * Pure & mocked: no live Mongo/Redis/network/timers — exits cleanly (no orphan).
 * CWD must be `apps/web` (the `@/`-free relative + barrel imports both resolve).
 *
 * Source:
 *   - packages/services/src/positions-logic.ts
 *   - packages/services/src/positions.service.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  classifyPositionDirection,
  positionDirectionLabel,
  tradeTypeForQuantity,
  absQuantity,
  positionMarketValue,
  positionUnrealizedPnL,
  positionCostBasis,
  positionReturnPct,
  summarizeOpenPositions,
  startOfToday,
  computeClosedTodayRealizedPnL,
  safeIsoDate,
  type PositionSummaryInput,
} from "../../../../packages/services/src/positions-logic";

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — PURE LOGIC (real exports, adversarial fixtures)
// ═══════════════════════════════════════════════════════════════════════════

describe("positions-logic — finite() guard", () => {
  it("passes through ordinary finite numbers (incl. negatives, 0)", () => {
    assert.equal(finite(1234.56), 1234.56);
    assert.equal(finite(-42), -42);
    assert.equal(finite(0), 0);
  });

  it("collapses NaN / ±Infinity / null / undefined to the fallback (default 0)", () => {
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
  });

  it("honours a custom fallback", () => {
    assert.equal(finite(NaN, -1), -1);
    assert.equal(finite(Infinity, 99), 99);
  });
});

describe("positions-logic — direction classification (netQuantity sign)", () => {
  it("LONG / BUY / 'Long' for strictly positive net quantity", () => {
    assert.equal(classifyPositionDirection(10), "LONG");
    assert.equal(tradeTypeForQuantity(10), "BUY");
    assert.equal(positionDirectionLabel(10), "Long");
  });

  it("SHORT / SELL / 'Short' for negative net quantity (oversold / short book)", () => {
    assert.equal(classifyPositionDirection(-5), "SHORT");
    assert.equal(tradeTypeForQuantity(-5), "SELL");
    assert.equal(positionDirectionLabel(-5), "Short");
  });

  it("netQuantity 0 classifies as SHORT (0 is not > 0) — matches original ternary", () => {
    assert.equal(classifyPositionDirection(0), "SHORT");
    assert.equal(tradeTypeForQuantity(0), "SELL");
    assert.equal(positionDirectionLabel(0), "Short");
  });

  it("NaN net quantity classifies as SHORT (NaN > 0 is false) — no throw", () => {
    assert.equal(classifyPositionDirection(NaN), "SHORT");
    assert.equal(tradeTypeForQuantity(NaN), "SELL");
  });
});

describe("positions-logic — absQuantity()", () => {
  it("returns the magnitude for long & short positions", () => {
    assert.equal(absQuantity(25), 25);
    assert.equal(absQuantity(-25), 25);
    assert.equal(absQuantity(0), 0);
  });

  it("neutralises a NaN / Infinity net quantity to 0 (never NaN into toLocaleString)", () => {
    assert.equal(absQuantity(NaN), 0);
    assert.equal(absQuantity(Infinity), 0);
    assert.equal(absQuantity(-Infinity), 0);
  });

  it("preserves a very large finite quantity (no overflow to Infinity)", () => {
    assert.equal(absQuantity(-1e15), 1e15);
    assert.ok(Number.isFinite(absQuantity(1e15)));
  });
});

describe("positions-logic — positionMarketValue() (MTM = |qty * ltp|)", () => {
  it("computes the absolute mark-to-market notional for long & short", () => {
    assert.equal(positionMarketValue(10, 2550), 25500);
    assert.equal(positionMarketValue(-10, 2550), 25500); // short → positive notional
  });

  it("a zero-price option yields 0 (not NaN)", () => {
    assert.equal(positionMarketValue(50, 0), 0);
  });

  it("a NaN / Infinity price or quantity contributes 0, never poisons the value", () => {
    assert.equal(positionMarketValue(NaN, 500), 0);
    assert.equal(positionMarketValue(100, NaN), 0);
    assert.equal(positionMarketValue(Infinity, 500), 0);
    assert.equal(positionMarketValue(100, Infinity), 0);
  });

  it("a very large notional stays finite (1e9 qty * 1e9 price would overflow without the guard? — stays finite here)", () => {
    const v = positionMarketValue(1e6, 1e6); // 1e12 — finite
    assert.equal(v, 1e12);
    assert.ok(Number.isFinite(v));
  });
});

describe("positions-logic — positionUnrealizedPnL() (price-derived)", () => {
  it("LONG gains when last > avg: (last-avg)*qty", () => {
    assert.equal(positionUnrealizedPnL(10, 2500, 2600), 1000);
  });

  it("SHORT (negative qty) gains when last < avg", () => {
    // qty=-15, avg=3000, last=2900 → (2900-3000)*-15 = 1500
    assert.equal(positionUnrealizedPnL(-15, 3000, 2900), 1500);
  });

  it("a non-finite input never yields a non-finite OUTPUT (each factor finite-guarded)", () => {
    // The guard keeps the RESULT finite — it coerces each non-finite *input* to a
    // safe number rather than zeroing the whole product. A NaN qty → qty 0 → 0;
    // a NaN avg → avg 0 → (last-0)*qty; an Infinity last → last 0 → (0-avg)*qty.
    assert.equal(positionUnrealizedPnL(NaN, 2500, 2600), 0); // qty 0
    assert.equal(positionUnrealizedPnL(10, NaN, 2600), 26000); // avg 0 → 2600*10
    assert.equal(positionUnrealizedPnL(10, 2500, Infinity), -25000); // last 0 → -2500*10
    for (const v of [
      positionUnrealizedPnL(NaN, NaN, NaN),
      positionUnrealizedPnL(Infinity, Infinity, Infinity),
      positionUnrealizedPnL(10, NaN, 2600),
    ]) {
      assert.ok(Number.isFinite(v), `result must be finite, got ${String(v)}`);
    }
  });
});

describe("positions-logic — positionCostBasis()", () => {
  it("prefers the |netValue| magnitude when positive", () => {
    assert.equal(positionCostBasis(25000, 2500, 10), 25000);
    assert.equal(positionCostBasis(-4750, 200, -25), 4750); // short net value
  });

  it("falls back to |avg * qty| when netValue is 0 / null / non-finite", () => {
    assert.equal(positionCostBasis(0, 2500, 10), 25000);
    assert.equal(positionCostBasis(null, 2500, 10), 25000);
    assert.equal(positionCostBasis(NaN, 200, -25), 5000); // |200 * -25|
    assert.equal(positionCostBasis(Infinity, 200, -25), 5000);
  });

  it("is 0 (not NaN) when both sources are unusable", () => {
    assert.equal(positionCostBasis(null, NaN, NaN), 0);
    assert.equal(positionCostBasis(0, 0, 100), 0);
  });
});

describe("positions-logic — positionReturnPct() (clamped division)", () => {
  it("computes pnl / costBasis * 100 for a normal positive basis", () => {
    assert.equal(positionReturnPct(1000, 25000), 4);
    assert.equal(positionReturnPct(-500, 25000), -2);
  });

  it("clamps to 0 on a ZERO cost basis (zero-price option / fully-hedged) — no Infinity", () => {
    assert.equal(positionReturnPct(1000, 0), 0);
    assert.equal(positionReturnPct(1000, -10), 0); // negative basis also clamped
  });

  it("clamps to 0 on non-finite pnl or basis — no NaN/Infinity reaches toFixed", () => {
    assert.equal(positionReturnPct(NaN, 25000), 0);
    assert.equal(positionReturnPct(Infinity, 25000), 0);
    assert.equal(positionReturnPct(1000, NaN), 0);
    assert.equal(positionReturnPct(1000, Infinity), 0);
  });
});

describe("positions-logic — summarizeOpenPositions()", () => {
  const row = (o: Partial<PositionSummaryInput>): PositionSummaryInput => ({
    netQuantity: 10,
    tradeValue: 25000,
    unrealizedPnL: 500,
    lastPrice: 2550,
    ...o,
  });

  it("aggregates totals, long/short counts, market value & return% for a clean book", () => {
    const s = summarizeOpenPositions([
      row({
        netQuantity: 50,
        tradeValue: 5000,
        unrealizedPnL: 500,
        lastPrice: 110,
      }),
      row({
        netQuantity: -25,
        tradeValue: -4750,
        unrealizedPnL: 250,
        lastPrice: 190,
      }),
    ]);
    assert.equal(s.totalPositions, 2);
    assert.equal(s.longPositions, 1);
    assert.equal(s.shortPositions, 1);
    assert.equal(s.totalInvested, 9750); // |5000| + |-4750|
    assert.equal(s.unrealizedPnL, 750);
    // marketValue = |50*110| + |-25*190| = 5500 + 4750 = 10250
    assert.equal(s.marketValue, 10250);
    // returnPct = 750 / 9750 * 100
    assert.equal(s.returnPct, (750 / 9750) * 100);
  });

  it("a single NaN/Infinity row never poisons the totals (the core poison guard)", () => {
    const s = summarizeOpenPositions([
      row({
        netQuantity: 50,
        tradeValue: 5000,
        unrealizedPnL: 500,
        lastPrice: 110,
      }),
      row({
        netQuantity: NaN,
        tradeValue: Infinity,
        unrealizedPnL: NaN,
        lastPrice: NaN,
      }),
    ]);
    assert.ok(Number.isFinite(s.totalInvested), "totalInvested finite");
    assert.ok(Number.isFinite(s.unrealizedPnL), "unrealizedPnL finite");
    assert.ok(Number.isFinite(s.marketValue), "marketValue finite");
    assert.ok(Number.isFinite(s.returnPct), "returnPct finite");
    // clean row only: invested 5000, pnl 500, mv |50*110|=5500
    assert.equal(s.totalInvested, 5000);
    assert.equal(s.unrealizedPnL, 500);
    assert.equal(s.marketValue, 5500);
    // a NaN netQuantity is NEITHER long nor short (both comparisons false)
    assert.equal(s.longPositions, 1);
    assert.equal(s.shortPositions, 0);
  });

  it("returnPct is 0 (not Infinity) when every row has zero cost basis", () => {
    const s = summarizeOpenPositions([
      row({ netQuantity: 50, tradeValue: 0, unrealizedPnL: 100, lastPrice: 0 }),
    ]);
    assert.equal(s.totalInvested, 0);
    assert.equal(s.returnPct, 0);
  });

  it("null tradeValue is treated as 0 invested (|| 0 fallback preserved)", () => {
    const s = summarizeOpenPositions([
      row({
        netQuantity: 10,
        tradeValue: null,
        unrealizedPnL: 0,
        lastPrice: 100,
      }),
    ]);
    assert.equal(s.totalInvested, 0);
  });

  it("empty book → all zeros, returnPct 0 (no division by zero)", () => {
    const s = summarizeOpenPositions([]);
    assert.deepEqual(s, {
      totalPositions: 0,
      totalInvested: 0,
      unrealizedPnL: 0,
      longPositions: 0,
      shortPositions: 0,
      marketValue: 0,
      returnPct: 0,
    });
  });

  it("handles a very large notional book without overflowing to Infinity", () => {
    const s = summarizeOpenPositions([
      row({
        netQuantity: 1e6,
        tradeValue: 1e11,
        unrealizedPnL: 1e9,
        lastPrice: 1e5,
      }),
    ]);
    assert.ok(Number.isFinite(s.totalInvested));
    assert.ok(Number.isFinite(s.marketValue));
    assert.equal(s.marketValue, 1e11); // |1e6 * 1e5|
  });
});

describe("positions-logic — startOfToday()", () => {
  it("zeros the time components and returns a fresh Date", () => {
    const ref = new Date("2026-06-05T14:37:42.123Z");
    const d = startOfToday(ref);
    assert.ok(d instanceof Date);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
    // does not mutate the input
    assert.equal(ref.getMilliseconds(), 123);
  });

  it("keeps the same calendar day (local) as the reference", () => {
    const ref = new Date(2026, 5, 5, 23, 59, 59); // local 5-Jun-2026
    const d = startOfToday(ref);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 5);
    assert.equal(d.getDate(), 5);
  });
});

describe("positions-logic — computeClosedTodayRealizedPnL()", () => {
  it("price-derives (sell-buy)*qty when all legs are finite & positive", () => {
    assert.equal(
      computeClosedTodayRealizedPnL({
        buyPrice: 500,
        sellPrice: 520,
        quantity: 100,
        realizedPnl: 0,
      }),
      2000
    );
  });

  it("falls back to stored realizedPnl when a leg is missing/zero (qty 0, buy 0, sell 0)", () => {
    assert.equal(
      computeClosedTodayRealizedPnL({
        buyPrice: 0,
        sellPrice: 520,
        quantity: 100,
        realizedPnl: 777,
      }),
      777
    );
    assert.equal(
      computeClosedTodayRealizedPnL({
        buyPrice: 500,
        sellPrice: 520,
        quantity: 0,
        realizedPnl: 333,
      }),
      333
    );
  });

  it("does NOT price-derive on an Infinity price (Infinity > 0 is true!) — uses stored, finite-guarded", () => {
    // The exact bug: `sellPrice > 0` passes for Infinity → (Infinity-buy)*qty = Infinity.
    assert.equal(
      computeClosedTodayRealizedPnL({
        buyPrice: 100,
        sellPrice: Infinity,
        quantity: 10,
        realizedPnl: 42,
      }),
      42
    );
    assert.equal(
      computeClosedTodayRealizedPnL({
        buyPrice: NaN,
        sellPrice: 520,
        quantity: 10,
        realizedPnl: 9,
      }),
      9
    );
  });

  it("a non-finite STORED realizedPnl is neutralised to 0 (never NaN/Infinity to the UI)", () => {
    assert.equal(
      computeClosedTodayRealizedPnL({
        buyPrice: 0,
        sellPrice: 0,
        quantity: 0,
        realizedPnl: NaN,
      }),
      0
    );
    assert.equal(
      computeClosedTodayRealizedPnL({
        buyPrice: -1,
        sellPrice: -1,
        quantity: -1,
        realizedPnl: Infinity,
      }),
      0
    );
  });

  it("handles a large finite price spread without overflow", () => {
    const v = computeClosedTodayRealizedPnL({
      buyPrice: 1,
      sellPrice: 1e6,
      quantity: 1e3,
      realizedPnl: 0,
    });
    assert.ok(Number.isFinite(v));
    assert.equal(v, (1e6 - 1) * 1e3);
  });
});

describe("positions-logic — safeIsoDate()", () => {
  it("formats a valid Date as YYYY-MM-DD", () => {
    assert.equal(safeIsoDate(new Date("2026-06-05T10:00:00Z")), "2026-06-05");
  });

  it("returns null for an Invalid Date (never throws RangeError on toISOString)", () => {
    assert.doesNotThrow(() => safeIsoDate(new Date("not-a-real-date")));
    assert.equal(safeIsoDate(new Date("not-a-real-date")), null);
    assert.equal(safeIsoDate(new Date(NaN)), null);
  });

  it("returns null for null / undefined", () => {
    assert.equal(safeIsoDate(null), null);
    assert.equal(safeIsoDate(undefined), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2 — LIVE SERVICE (real exports via recording-prisma seam)
// ═══════════════════════════════════════════════════════════════════════════
//
// Self-contained seam (does not depend on / mutate any sibling test file): we
// inject a recording prisma + no-op cache + silent logger at the module
// boundaries via `require.cache` BEFORE requiring `@usemoney/services`, then
// assert the REAL `getPositions` / `getClosedTodayPositions` output. The barrel
// is ESM-source but loaded through tsx's CJS interop, so `require.cache` is the
// valid seam (same as services-data-e2e.test.ts).

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
        // getCached → always a miss (forces the DB path + setCached);
        // setCached / clear* → no-ops.
        if (k === "getCached") return async () => null;
        return async () => {};
      },
    }
  );
}

interface ServicesModule {
  getPositions: (
    userId: string,
    filters?: { symbol?: string; broker?: string; segment?: string }
  ) => Promise<
    Result<{ positions: PositionRow[]; summary: Record<string, unknown> }>
  >;
  getClosedTodayPositions: (userId: string) => Promise<Result<ClosedRow[]>>;
}

interface PositionRow {
  symbol: string;
  positionType: string;
  tradeType: string;
  quantity: number;
  unrealizedPnL: number;
  pnlPercentage?: number;
  tradeValue: number | null;
  realizedPnL: number;
  [k: string]: unknown;
}

interface ClosedRow {
  symbol: string;
  quantity: number;
  realizedPnL: number;
  tradeDateStr?: string | null;
  segmentLabel?: string;
  [k: string]: unknown;
}

interface ServiceOk<T> {
  success: true;
  data: T;
}
interface ServiceErr {
  success: false;
  error: string;
}
type Result<T> = ServiceOk<T> | ServiceErr;

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
      (key.endsWith(".service.ts") || key.endsWith("/index.ts"))
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

function ok<T>(r: Result<T>): ServiceOk<T> {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as ServiceOk<T>;
}

/** A complete open-position DB row (all selected fields present). */
function dbOpenRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  return {
    id: `pos-${Math.random().toString(36).slice(2)}`,
    userId: "user-x",
    symbol: "NIFTY",
    exchange: "NFO",
    segment: "FO",
    productType: "NRML",
    netQuantity: 50,
    averagePrice: 100,
    lastPrice: 110,
    netValue: 5000,
    realizedPnl: 0,
    unrealizedPnl: 500,
    totalPnl: 500,
    tradeDate: now,
    broker: "ZERODHA",
    brokerUserId: "Z1",
    lastUpdated: now,
    createdAt: now,
    updatedAt: now,
    ...o,
  };
}

function dbClosedRow(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `ct-${Math.random().toString(36).slice(2)}`,
    symbol: "SBIN",
    exchange: "NSE",
    segment: "CASH",
    productType: "MIS",
    buyQuantity: 100,
    buyPrice: 500,
    sellPrice: 520,
    realizedPnl: 0,
    tradeDate: new Date(),
    broker: "ZERODHA",
    brokerUserId: "Z1",
    ...o,
  };
}

describe("MONEY-620 — getPositions LIVE (real fn, poison & IDOR)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("scopes the findMany to the caller's userId and excludes flat rows (IDOR)", async () => {
    prisma.queue("position", "findMany", []);
    await svc.getPositions("user-idor", {});
    const args = prisma.callsFor("position", "findMany")[0]!.args as {
      where: { userId: string; netQuantity: unknown };
    };
    assert.equal(args.where.userId, "user-idor");
    assert.deepEqual(args.where.netQuantity, { not: 0 });
  });

  it("a poisoned row (NaN netQuantity, Infinity netValue, NaN unrealizedPnl) yields a FULLY FINITE summary — no '₹NaN'", async () => {
    prisma.queue("position", "findMany", [
      dbOpenRow({
        symbol: "GOOD",
        netQuantity: 50,
        lastPrice: 110,
        netValue: 5000,
        unrealizedPnl: 500,
      }),
      dbOpenRow({
        symbol: "POISON",
        netQuantity: NaN, // breaks abs / classification
        lastPrice: 500,
        netValue: Infinity, // passes `|| 0`, breaks totalInvested
        unrealizedPnl: NaN, // breaks unrealizedPnL sum
      }),
    ]);

    const res = ok(await svc.getPositions("user-poison", {}));
    const s = res.data.summary as Record<string, number>;

    assert.ok(Number.isFinite(s.totalInvested), "totalInvested finite");
    assert.ok(Number.isFinite(s.unrealizedPnL), "unrealizedPnL finite");
    assert.ok(Number.isFinite(s.marketValue), "marketValue finite");
    assert.ok(Number.isFinite(s.returnPct), "returnPct finite");

    // Only the clean row contributes: invested 5000, pnl 500, mv |50*110|=5500.
    assert.equal(s.totalInvested, 5000);
    assert.equal(s.unrealizedPnL, 500);
    assert.equal(s.marketValue, 5500);
    assert.equal(s.totalPositions, 2);
    // NaN netQuantity is neither long nor short.
    assert.equal(s.longPositions, 1);
    assert.equal(s.shortPositions, 0);

    // Consumer-safety: nothing the UI formats is NaN/Infinity.
    const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
    assert.notEqual(INR(s.totalInvested), "₹NaN");
    assert.notEqual(INR(s.unrealizedPnL), "₹NaN");

    // The poisoned ROW itself is sanitized for the table too.
    const poisonRow = res.data.positions.find((p) => p.symbol === "POISON")!;
    assert.ok(Number.isFinite(poisonRow.quantity), "row quantity finite");
    assert.equal(poisonRow.quantity, 0); // absQuantity(NaN)
    assert.ok(
      Number.isFinite(poisonRow.unrealizedPnL),
      "row unrealizedPnL finite"
    );
    assert.ok(
      Number.isFinite(poisonRow.pnlPercentage as number),
      "row pnlPercentage finite"
    );
    assert.notEqual((poisonRow.unrealizedPnL as number).toFixed(2), "NaN");
  });

  it("price-derives a row's unrealized P&L when the stored value is non-finite (no NaN row)", async () => {
    prisma.queue("position", "findMany", [
      dbOpenRow({
        symbol: "WIPRO",
        netQuantity: 10,
        averagePrice: 2500,
        lastPrice: 2600,
        netValue: 25000,
        unrealizedPnl: NaN, // corrupt → service must price-derive (2600-2500)*10
      }),
    ]);
    const res = ok(await svc.getPositions("user-fallback", {}));
    const row = res.data.positions[0]!;
    assert.equal(row.unrealizedPnL, 1000); // price-derived, finite
    // pnlPercentage = 1000 / |25000| * 100 = 4
    assert.equal(row.pnlPercentage, 4);
  });

  it("a zero-price option row yields a finite 0% return (no Infinity)", async () => {
    prisma.queue("position", "findMany", [
      dbOpenRow({
        symbol: "DEEPOTM-CE",
        netQuantity: 50,
        averagePrice: 0,
        lastPrice: 0,
        netValue: 0, // zero cost basis → return% must clamp to 0
        unrealizedPnl: 0,
      }),
    ]);
    const res = ok(await svc.getPositions("user-zero", {}));
    const row = res.data.positions[0]!;
    assert.equal(row.pnlPercentage, 0);
    assert.ok(Number.isFinite(row.pnlPercentage as number));
    const s = res.data.summary as Record<string, number>;
    assert.equal(s.returnPct, 0);
    assert.ok(Number.isFinite(s.returnPct));
  });

  it("classifies a short (oversold) row and reports a positive notional", async () => {
    prisma.queue("position", "findMany", [
      dbOpenRow({
        symbol: "BANKNIFTY",
        netQuantity: -25,
        averagePrice: 200,
        lastPrice: 190,
        netValue: -4750,
        unrealizedPnl: 250,
      }),
    ]);
    const res = ok(await svc.getPositions("user-short", {}));
    const row = res.data.positions[0]!;
    assert.equal(row.positionType, "SHORT");
    assert.equal(row.tradeType, "SELL");
    assert.equal(row.quantity, 25); // abs(-25)
    const s = res.data.summary as Record<string, number>;
    assert.equal(s.shortPositions, 1);
    assert.equal(s.longPositions, 0);
    assert.equal(s.marketValue, 4750); // |−25 * 190|
    assert.equal(s.totalInvested, 4750); // |−4750|
  });

  it("a huge-notional row stays finite end-to-end (no overflow to Infinity)", async () => {
    prisma.queue("position", "findMany", [
      dbOpenRow({
        symbol: "BIGLOT",
        netQuantity: 1e6,
        averagePrice: 1e5,
        lastPrice: 1e5,
        netValue: 1e11,
        unrealizedPnl: 1e9,
      }),
    ]);
    const res = ok(await svc.getPositions("user-huge", {}));
    const s = res.data.summary as Record<string, number>;
    assert.ok(Number.isFinite(s.totalInvested));
    assert.ok(Number.isFinite(s.marketValue));
    assert.ok(Number.isFinite(s.unrealizedPnL));
    assert.equal(s.marketValue, 1e11);
  });

  it("DB throw → sanitized ServiceErr (no raw error leak)", async () => {
    prisma.fail(
      "position",
      "findMany",
      new Error("E11000 connection reset on internal.collection")
    );
    const res = await svc.getPositions("user-err", {});
    assert.equal(res.success, false);
    assert.equal((res as ServiceErr).error, "Failed to fetch positions");
  });
});

describe("MONEY-620 — getClosedTodayPositions LIVE (real fn, poison & IDOR)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("scopes to userId + netQuantity 0 + today's start-of-day window (IDOR + window)", async () => {
    prisma.queue("position", "findMany", []);
    await svc.getClosedTodayPositions("user-ct");
    const args = prisma.callsFor("position", "findMany")[0]!.args as {
      where: { userId: string; netQuantity: number; tradeDate: { gte: Date } };
    };
    assert.equal(args.where.userId, "user-ct");
    assert.equal(args.where.netQuantity, 0);
    const gte = args.where.tradeDate.gte;
    assert.ok(gte instanceof Date);
    assert.equal(gte.getHours(), 0);
    assert.equal(gte.getMinutes(), 0);
    assert.equal(gte.getSeconds(), 0);
    assert.equal(gte.getMilliseconds(), 0);
  });

  it("price-derives realized P&L when Zerodha reports realised=0", async () => {
    prisma.queue("position", "findMany", [
      dbClosedRow({
        buyPrice: 500,
        sellPrice: 520,
        buyQuantity: 100,
        realizedPnl: 0,
      }),
    ]);
    const res = ok(await svc.getClosedTodayPositions("user-ct2"));
    const row = res.data[0]!;
    assert.equal(row.realizedPnL, 2000); // (520-500)*100
    assert.equal(row.quantity, 100);
    assert.equal(row.segmentLabel, "Equity"); // CASH → Equity
  });

  it("an Infinity sellPrice does NOT price-derive to Infinity (uses stored, finite)", async () => {
    prisma.queue("position", "findMany", [
      dbClosedRow({
        buyPrice: 100,
        sellPrice: Infinity, // `Infinity > 0` would pass the naive gate
        buyQuantity: 10,
        realizedPnl: 42, // → must surface this, finite-guarded
      }),
    ]);
    const res = ok(await svc.getClosedTodayPositions("user-ct3"));
    const row = res.data[0]!;
    assert.ok(Number.isFinite(row.realizedPnL), "realizedPnL finite");
    assert.equal(row.realizedPnL, 42);
    assert.notEqual(row.realizedPnL.toFixed(2), "NaN");
  });

  it("a NaN stored realizedPnl (and unusable prices) surfaces 0, never NaN", async () => {
    prisma.queue("position", "findMany", [
      dbClosedRow({
        buyPrice: 0,
        sellPrice: 0,
        buyQuantity: 0,
        realizedPnl: NaN,
      }),
    ]);
    const res = ok(await svc.getClosedTodayPositions("user-ct4"));
    const row = res.data[0]!;
    assert.equal(row.realizedPnL, 0);
    assert.ok(Number.isFinite(row.realizedPnL));
    assert.equal(row.quantity, 0); // absQuantity(0)
  });

  it("an Invalid-Date tradeDate does NOT throw and surfaces tradeDateStr=null", async () => {
    prisma.queue("position", "findMany", [
      dbClosedRow({
        symbol: "BADDATE",
        buyPrice: 10,
        sellPrice: 12,
        buyQuantity: 5,
        realizedPnl: 0,
        tradeDate: new Date("not-a-real-date"), // RangeError bait
      }),
    ]);
    let res!: ServiceOk<ClosedRow[]>;
    await assert.doesNotReject(async () => {
      res = ok(await svc.getClosedTodayPositions("user-ct5"));
    });
    const row = res.data[0]!;
    assert.equal(row.tradeDateStr, null); // honest "—", no throw
    assert.equal(row.realizedPnL, 10); // (12-10)*5 still computed
  });

  it("a valid tradeDate surfaces tradeDateStr as YYYY-MM-DD", async () => {
    prisma.queue("position", "findMany", [
      dbClosedRow({ tradeDate: new Date("2026-06-05T09:30:00Z") }),
    ]);
    const res = ok(await svc.getClosedTodayPositions("user-ct6"));
    assert.equal(res.data[0]!.tradeDateStr, "2026-06-05");
  });

  it("DB throw → sanitized ServiceErr", async () => {
    prisma.fail("position", "findMany", new Error("connection reset by peer"));
    const res = await svc.getClosedTodayPositions("user-ct-err");
    assert.equal(res.success, false);
    assert.equal((res as ServiceErr).error, "Failed to fetch closed positions");
  });

  // Restore the real module cache so the @usemoney/{database,core,logger} stubs
  // (and re-bound service modules) never leak into a sibling suite running later
  // in the same process under the full `__tests__/**` glob.
  after(() => {
    uninstallServices();
  });
});
