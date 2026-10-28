/**
 * MONEY-620 — Risk analysis: REAL risk-logic + LIVE getPortfolioRisk service.
 *
 * DE-SHADOW. The previous version of this file was a textbook shadow: it
 * declared its own `computeHHI` / `classifyConcentration` /
 * `computePortfolioWeights` / `computeRebalancing` under a
 * "// --- Reimplemented pure functions ---" banner and asserted the COPIES,
 * never importing the real risk code. Worse, the copy was WRONG vs. production
 * (its `classifyConcentration` used `hhi > 3000 → high`, while the real
 * `compute_portfolio_concentration` uses `< 1500 low / < 2500 moderate / else
 * high` — so the shadow green-lit a classification the app does not implement).
 * It also inlined a hand-rolled `demoRisk` literal instead of the real
 * `demoRiskResult`. Exactly the failure mode the writing-tests skill exists to
 * prevent.
 *
 * This rewrite asserts the REAL code on two layers:
 *
 *   LAYER 1 — the pure math the SERVICE itself does (NOT delegated to the
 *     research compute tools): holdings→value mapping, total, weights, the
 *     daily portfolio-value series, portfolio + benchmark returns. Imported
 *     from the REAL `packages/services/src/risk-logic.ts` via relative path
 *     (importing the service barrel would open a Prisma connection at load).
 *     Heavy stats (VaR/drawdown/HHI/correlation/Sharpe/beta) live in
 *     `@usemoney/research/tools` and are covered by their own tool tests.
 *
 *   LAYER 2 — the LIVE `getPortfolioRisk` service (real export) driven through
 *     the established recording-prisma seam (same pattern as
 *     positions-service.test.ts): a recording Prisma feeds `holding.findMany`,
 *     `@usemoney/core` cache is a forced-miss no-op, the logger is silenced, and
 *     `@usemoney/research/tools` keeps the REAL compute tools but stubs the
 *     network boundary (`fetchPriceHistoryTool`) + `resolveSymbol`. Proves the
 *     userId scoping (IDOR) and that a poisoned holding row yields a FULLY
 *     FINITE concentration result (no "₹NaN" / NaN HHI), end-to-end.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: packages/services/src/risk-logic.ts + packages/services/src/risk.service.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  mapHoldingsData,
  sumHoldingsValue,
  topHoldingsByValue,
  computeWeight,
  collectSortedDates,
  buildDailyValueSeries,
  computeReturnsFromSeries,
  computeBenchmarkReturns,
  buildCloseByDate,
  type RiskHoldingInput,
  type RiskHoldingData,
  type PricePoint,
  type ValuePoint,
} from "../../../../packages/services/src/risk-logic";

import { demoRiskResult } from "@/lib/demo/data";

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — pure risk-logic (real exports)
// ═══════════════════════════════════════════════════════════════════════════

const hold = (o: Partial<RiskHoldingInput>): RiskHoldingInput => ({
  symbol: "X",
  sector: "IT",
  quantity: 10,
  averagePrice: 100,
  currentPrice: 110,
  ...o,
});

describe("risk-logic.finite", () => {
  it("passes finite numbers through unchanged (behavior-preserving)", () => {
    assert.equal(finite(0), 0);
    assert.equal(finite(123.45), 123.45);
    assert.equal(finite(-99), -99);
  });
  it("collapses NaN / ±Infinity / null / undefined to the fallback", () => {
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN, 7), 7);
  });
});

describe("risk-logic.mapHoldingsData", () => {
  it("computes value = (currentPrice || averagePrice) * quantity (finite path)", () => {
    const out = mapHoldingsData([hold({ currentPrice: 110, quantity: 10 })]);
    assert.equal(out[0]!.value, 1100);
    assert.equal(out[0]!.sector, "IT");
  });

  it("falls back to averagePrice when currentPrice is 0/null (|| chain preserved)", () => {
    assert.equal(
      mapHoldingsData([
        hold({ currentPrice: 0, averagePrice: 90, quantity: 5 }),
      ])[0]!.value,
      450
    );
    assert.equal(
      mapHoldingsData([
        hold({ currentPrice: null, averagePrice: 80, quantity: 2 }),
      ])[0]!.value,
      160
    );
  });

  it("defaults a null/empty sector to 'Unknown'", () => {
    assert.equal(
      mapHoldingsData([hold({ sector: null })])[0]!.sector,
      "Unknown"
    );
    assert.equal(mapHoldingsData([hold({ sector: "" })])[0]!.sector, "Unknown");
  });

  // BUG-1 regression: a NaN/Infinity price or quantity on a corrupt sync row
  // must NOT produce a non-finite holding value (which would poison everything).
  it("BUG-1: NaN currentPrice AND NaN averagePrice → value 0 (not NaN)", () => {
    const out = mapHoldingsData([
      hold({ currentPrice: NaN, averagePrice: NaN, quantity: 5 }),
    ]);
    assert.equal(out[0]!.value, 0);
    assert.ok(Number.isFinite(out[0]!.value));
  });
  it("BUG-1: Infinity quantity → value 0 (not Infinity)", () => {
    const out = mapHoldingsData([
      hold({ currentPrice: 100, quantity: Infinity }),
    ]);
    assert.equal(out[0]!.value, 0);
  });
  it("BUG-1: NaN quantity → value 0", () => {
    assert.equal(
      mapHoldingsData([hold({ currentPrice: 100, quantity: NaN })])[0]!.value,
      0
    );
  });
});

describe("risk-logic.sumHoldingsValue", () => {
  it("sums finite values (behavior-preserving)", () => {
    assert.equal(
      sumHoldingsValue([{ value: 100 }, { value: 250 }, { value: 50 }]),
      400
    );
  });
  it("empty portfolio → 0", () => {
    assert.equal(sumHoldingsValue([]), 0);
  });
  // BUG-2 regression: one non-finite value must not poison the whole total.
  it("BUG-2: a NaN value does NOT poison the total (skipped, not NaN)", () => {
    const total = sumHoldingsValue([
      { value: 100 },
      { value: NaN },
      { value: 300 },
    ]);
    assert.equal(total, 400);
    assert.ok(Number.isFinite(total));
  });
  it("BUG-2: an Infinity value does NOT poison the total", () => {
    assert.equal(sumHoldingsValue([{ value: 100 }, { value: Infinity }]), 100);
  });
});

describe("risk-logic.computeWeight", () => {
  it("value / totalValue for a positive total (behavior-preserving)", () => {
    assert.equal(computeWeight(250, 1000), 0.25);
    assert.equal(computeWeight(1000, 1000), 1);
  });
  // BUG-3 regression: division-by-zero / NaN denominator → 0, never Inf/NaN.
  it("BUG-3: totalValue 0 → weight 0 (no Infinity)", () => {
    const w = computeWeight(100, 0);
    assert.equal(w, 0);
    assert.ok(Number.isFinite(w));
  });
  it("BUG-3: negative total → weight 0", () => {
    assert.equal(computeWeight(100, -500), 0);
  });
  it("BUG-3: NaN total → weight 0", () => {
    const w = computeWeight(100, NaN);
    assert.equal(w, 0);
    assert.ok(Number.isFinite(w));
  });
  it("BUG-3: non-finite numerator with a good total → weight 0", () => {
    assert.equal(computeWeight(NaN, 1000), 0);
    assert.equal(computeWeight(Infinity, 1000), 0);
  });
});

describe("risk-logic.topHoldingsByValue", () => {
  const hs: RiskHoldingData[] = [
    { symbol: "SMALL", value: 100, sector: "IT" },
    { symbol: "LARGE", value: 1000, sector: "Bank" },
    { symbol: "MID", value: 500, sector: "Energy" },
  ];
  it("sorts by value descending and caps", () => {
    const top = topHoldingsByValue(hs, 2);
    assert.deepEqual(
      top.map((h) => h.symbol),
      ["LARGE", "MID"]
    );
  });
  it("does not mutate the input array", () => {
    const copy = [...hs];
    topHoldingsByValue(hs, 3);
    assert.deepEqual(hs, copy);
  });
  it("a NaN value sinks to the bottom (does not corrupt the order)", () => {
    const withNaN: RiskHoldingData[] = [
      { symbol: "NAN", value: NaN, sector: "X" },
      { symbol: "B", value: 200, sector: "Y" },
      { symbol: "A", value: 900, sector: "Z" },
    ];
    const top = topHoldingsByValue(withNaN, 3);
    assert.equal(top[0]!.symbol, "A");
    assert.equal(top[1]!.symbol, "B");
    assert.equal(top[2]!.symbol, "NAN");
  });
});

describe("risk-logic.collectSortedDates", () => {
  it("unions dates across symbols and sorts ascending", () => {
    const dates = collectSortedDates({
      A: [
        { date: "2026-01-03", close: 1 },
        { date: "2026-01-01", close: 1 },
      ],
      B: [
        { date: "2026-01-02", close: 1 },
        { date: "2026-01-01", close: 1 },
      ],
    });
    assert.deepEqual(dates, ["2026-01-01", "2026-01-02", "2026-01-03"]);
  });
  it("empty histories → empty array (no throw)", () => {
    assert.deepEqual(collectSortedDates({}), []);
  });
});

describe("risk-logic.buildDailyValueSeries", () => {
  const top: RiskHoldingData[] = [
    { symbol: "A", value: 600, sector: "IT" },
    { symbol: "B", value: 400, sector: "Bank" },
  ];
  const dates = ["2026-01-01", "2026-01-02"];

  it("weights each close by holding weight and sums per day (behavior-preserving)", () => {
    const histories: Record<string, PricePoint[]> = {
      A: [
        { date: "2026-01-01", close: 100 },
        { date: "2026-01-02", close: 110 },
      ],
      B: [
        { date: "2026-01-01", close: 50 },
        { date: "2026-01-02", close: 55 },
      ],
    };
    // total = 1000; wA = .6, wB = .4
    // day1 = 100*.6 + 50*.4 = 80 ; day2 = 110*.6 + 55*.4 = 88
    const series = buildDailyValueSeries(top, histories, 1000, dates);
    assert.equal(series.length, 2);
    assert.ok(Math.abs(series[0]!.value - 80) < 1e-9);
    assert.ok(Math.abs(series[1]!.value - 88) < 1e-9);
  });

  it("drops days that net to 0 (no zero-value points to break the divisor)", () => {
    const series = buildDailyValueSeries(
      top,
      { A: [{ date: "2026-01-01", close: 0 }] },
      1000,
      dates
    );
    assert.equal(series.length, 0);
  });

  // The weight is computeWeight-clamped: totalValue 0 → every weight 0 → no
  // Infinity dominating the day sum (BUG-3 in the series context).
  it("BUG-3: zero totalValue → no Infinity day values (empty series)", () => {
    const series = buildDailyValueSeries(
      top,
      {
        A: [{ date: "2026-01-01", close: 100 }],
        B: [{ date: "2026-01-01", close: 50 }],
      },
      0,
      dates
    );
    assert.equal(series.length, 0);
    for (const p of series) assert.ok(Number.isFinite(p.value));
  });

  // A corrupt NaN close on ONE holding must not blank the whole day — the other
  // holding still contributes a finite value.
  it("a NaN close on one holding does not poison the day (other holding survives)", () => {
    const histories: Record<string, PricePoint[]> = {
      A: [{ date: "2026-01-01", close: NaN }], // wA .6 → finite() drops to 0
      B: [{ date: "2026-01-01", close: 50 }], // wB .4 → 20
    };
    const series = buildDailyValueSeries(top, histories, 1000, ["2026-01-01"]);
    assert.equal(series.length, 1);
    assert.ok(Number.isFinite(series[0]!.value));
    assert.ok(Math.abs(series[0]!.value - 20) < 1e-9);
  });
});

describe("risk-logic.computeReturnsFromSeries", () => {
  it("computes (v[i]-v[i-1])/v[i-1] (behavior-preserving)", () => {
    const series: ValuePoint[] = [
      { date: "d1", value: 100 },
      { date: "d2", value: 110 },
      { date: "d3", value: 99 },
    ];
    const r = computeReturnsFromSeries(series);
    assert.equal(r.length, 2);
    assert.ok(Math.abs(r[0]! - 0.1) < 1e-9);
    assert.ok(Math.abs(r[1]! - -0.1) < 1e-9);
  });

  it("empty / single-element series → no returns (no throw)", () => {
    assert.deepEqual(computeReturnsFromSeries([]), []);
    assert.deepEqual(computeReturnsFromSeries([{ date: "d", value: 100 }]), []);
  });

  // BUG-4 regression: a non-finite return would make the WHOLE array fail the
  // compute tools' all-finite gate (silently nulling VaR/RAR/beta). It is
  // dropped here so the surviving returns still flow downstream.
  it("BUG-4: a zero prev value (divide-by-zero) is skipped, not Infinity", () => {
    const series: ValuePoint[] = [
      { date: "d1", value: 0 },
      { date: "d2", value: 50 }, // (50-0)/0 = Infinity → skipped
      { date: "d3", value: 55 }, // (55-50)/50 = 0.1 → kept
    ];
    const r = computeReturnsFromSeries(series);
    assert.equal(r.length, 1);
    assert.ok(r.every(Number.isFinite));
    assert.ok(Math.abs(r[0]! - 0.1) < 1e-9);
  });
  it("BUG-4: a NaN value in the series only drops the adjacent returns", () => {
    const series: ValuePoint[] = [
      { date: "d1", value: 100 },
      { date: "d2", value: 110 }, // 0.1 kept
      { date: "d3", value: NaN }, // (NaN-110)/110 = NaN → dropped
      { date: "d4", value: 120 }, // prev NaN ≤ 0 false but non-finite → skipped
    ];
    const r = computeReturnsFromSeries(series);
    assert.ok(r.every(Number.isFinite));
    assert.equal(r.length, 1);
    assert.ok(Math.abs(r[0]! - 0.1) < 1e-9);
  });
});

describe("risk-logic.buildCloseByDate + computeBenchmarkReturns", () => {
  const vs: ValuePoint[] = [
    { date: "2026-01-01", value: 80 },
    { date: "2026-01-02", value: 88 },
    { date: "2026-01-03", value: 90 },
  ];

  it("buildCloseByDate maps date → close", () => {
    const m = buildCloseByDate([
      { date: "2026-01-01", close: 100 },
      { date: "2026-01-02", close: 110 },
    ]);
    assert.equal(m.get("2026-01-01"), 100);
    assert.equal(m.get("2026-01-02"), 110);
  });

  it("computes benchmark returns aligned to the value-series dates (behavior-preserving)", () => {
    const close = buildCloseByDate([
      { date: "2026-01-01", close: 100 },
      { date: "2026-01-02", close: 110 },
      { date: "2026-01-03", close: 99 },
    ]);
    const r = computeBenchmarkReturns(vs, close);
    assert.equal(r.length, 2);
    assert.ok(Math.abs(r[0]! - 0.1) < 1e-9); // (110-100)/100
    assert.ok(Math.abs(r[1]! - -0.1) < 1e-9); // (99-110)/110
  });

  it("skips a date with no benchmark close (prev gap)", () => {
    const close = buildCloseByDate([
      { date: "2026-01-01", close: 100 },
      // 2026-01-02 missing
      { date: "2026-01-03", close: 99 },
    ]);
    // pair (01→02): curr missing → skip. pair (02→03): prev missing → skip.
    assert.deepEqual(computeBenchmarkReturns(vs, close), []);
  });

  it("BUG: prev close 0 (divide-by-zero) is skipped, not Infinity", () => {
    const close = buildCloseByDate([
      { date: "2026-01-01", close: 0 },
      { date: "2026-01-02", close: 110 }, // (110-0)/0 = Infinity → skipped
      { date: "2026-01-03", close: 121 }, // (121-110)/110 = 0.1 → kept
    ]);
    const r = computeBenchmarkReturns(vs, close);
    assert.equal(r.length, 1);
    assert.ok(r.every(Number.isFinite));
    assert.ok(Math.abs(r[0]! - 0.1) < 1e-9);
  });

  // BUG-5 regression: a NaN benchmark close must not poison the paired array
  // (which compute_beta rejects wholesale).
  it("BUG-5: a NaN benchmark close drops only the adjacent returns (no NaN array)", () => {
    const close = buildCloseByDate([
      { date: "2026-01-01", close: 100 },
      { date: "2026-01-02", close: NaN }, // (NaN-100)/100 = NaN → dropped
      { date: "2026-01-03", close: 121 }, // prev NaN non-finite → skipped
    ]);
    const r = computeBenchmarkReturns(vs, close);
    assert.ok(r.every(Number.isFinite));
    assert.equal(r.length, 0);
  });

  it("negative prev close → skipped (no sign-flipped return)", () => {
    const close = buildCloseByDate([
      { date: "2026-01-01", close: -100 },
      { date: "2026-01-02", close: 110 },
      { date: "2026-01-03", close: 121 },
    ]);
    const r = computeBenchmarkReturns(vs, close);
    // pair1: prev -100 ≤ 0 → skip. pair2: (121-110)/110 = 0.1 kept.
    assert.equal(r.length, 1);
    assert.ok(Math.abs(r[0]! - 0.1) < 1e-9);
  });
});

// Behavior-preserving: a clean end-to-end weight chain still sums to ~1.
describe("risk-logic: weights from real holdings sum to 1 (finite portfolio)", () => {
  it("mapHoldingsData → sumHoldingsValue → computeWeight sums to 1", () => {
    const holdings = mapHoldingsData([
      hold({ symbol: "RELIANCE", currentPrice: 500, quantity: 1000 }), // 500000
      hold({ symbol: "TCS", currentPrice: 300, quantity: 1000 }), // 300000
      hold({ symbol: "INFY", currentPrice: 200, quantity: 1000 }), // 200000
    ]);
    const total = sumHoldingsValue(holdings);
    assert.equal(total, 1_000_000);
    const sumW = holdings.reduce(
      (s, h) => s + computeWeight(h.value, total),
      0
    );
    assert.ok(Math.abs(sumW - 1) < 1e-9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Demo data — assert the REAL demoRiskResult (no inline copy)
// ═══════════════════════════════════════════════════════════════════════════

describe("demoRiskResult (real export) shape", () => {
  it("has 5 top holdings sorted by weight descending", () => {
    const top = demoRiskResult.concentration.topHoldings;
    assert.equal(top.length, 5);
    for (let i = 1; i < top.length; i++) {
      assert.ok(top[i]!.weight <= top[i - 1]!.weight);
    }
  });
  it("classifies HHI 1850 as moderate (matches the REAL <1500/<2500 bands)", () => {
    assert.equal(demoRiskResult.concentration.hhi, 1850);
    assert.equal(demoRiskResult.concentration.level, "moderate");
  });
  it("sector weights sum close to 1", () => {
    const total = demoRiskResult.concentration.sectorWeights.reduce(
      (s, x) => s + x.weight,
      0
    );
    assert.ok(Math.abs(total - 1) < 0.01);
  });
  it("warns about the >20% RELIANCE concentration", () => {
    const w = demoRiskResult.concentration.warnings[0]!;
    assert.ok(w.includes("RELIANCE"));
    assert.ok(w.includes("25.0%"));
  });
  it("flags rebalancing needed (totalDrift > threshold)", () => {
    assert.ok(demoRiskResult.rebalancing.needsRebalancing);
    assert.ok(
      demoRiskResult.rebalancing.totalDrift >
        demoRiskResult.rebalancing.driftThreshold
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2 — LIVE getPortfolioRisk (real export via recording-prisma seam)
// ═══════════════════════════════════════════════════════════════════════════
//
// Self-contained seam (does not mutate any sibling test file): inject a
// recording prisma + forced-miss cache + silent logger + a research-tools stub
// (REAL compute tools, stubbed network boundary) at the module boundaries via
// `require.cache` BEFORE requiring `@usemoney/services`, then assert the REAL
// `getPortfolioRisk` output. The barrel is ESM-source loaded through tsx's CJS
// interop, so `require.cache` is the valid seam (same as positions-service.test.ts).

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
        // getCached → forced miss (drive the DB path + real compute);
        // setCached / clear* → no-ops.
        if (k === "getCached") return async () => null;
        return async () => {};
      },
    }
  );
}

// ── research stub: REAL compute tools, stubbed network boundary ──────────────
//
// We keep the genuine `compute_*` tools (so HHI/concentration/etc. are actually
// computed against the values the service hands them) but replace
// `fetchPriceHistoryTool` (network) and `resolveSymbol` so the test controls the
// price inputs deterministically.

interface ToolOutput {
  success: boolean;
  data?: unknown;
  error?: string;
}
type Tool = { execute: (p: Record<string, unknown>) => Promise<ToolOutput> };

let priceHistoryByYahooSymbol: Record<string, PricePoint[]> = {};

function makeResearchToolsStub(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realTools = require("@usemoney/research/tools") as Record<
    string,
    unknown
  >;
  const fetchPriceHistoryTool: Tool = {
    execute: async (p) => {
      const symbol = String(p.symbol);
      const prices = priceHistoryByYahooSymbol[symbol];
      if (prices && prices.length > 0) {
        return { success: true, data: { prices } };
      }
      return { success: false, error: "no history" };
    },
  };
  return {
    ...realTools,
    __esModule: true,
    fetchPriceHistoryTool,
  };
}

function makeResearchStub(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realResearch = require("@usemoney/research") as Record<string, unknown>;
  return {
    ...realResearch,
    __esModule: true,
    // identity symbol resolution so our keyed price map lines up
    resolveSymbol: (symbol: string) => symbol,
  };
}

interface RiskHoldingRow {
  symbol: string;
  sector: string | null;
  exchange: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number | null;
}

interface ConcentrationResultShape {
  hhi: number;
  level: "low" | "moderate" | "high";
  topHoldings: Array<{ symbol: string; weight: number; value: number }>;
  sectorWeights: Array<{ sector: string; weight: number; count: number }>;
  warnings: string[];
}

interface PortfolioRiskResultShape {
  concentration: ConcentrationResultShape;
  correlation: unknown | null;
  var: unknown | null;
  drawdown: unknown | null;
  riskAdjustedReturns: unknown | null;
  rebalancing: { holdings: unknown[]; needsRebalancing: boolean };
  stressTest: { portfolioValue: number; scenarios: unknown[] };
  beta: unknown | null;
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

interface ServicesModule {
  getPortfolioRisk: (
    userId: string
  ) => Promise<Result<PortfolioRiskResultShape>>;
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
  stub(require.resolve("@usemoney/research"), makeResearchStub());
  stub(require.resolve("@usemoney/research/tools"), makeResearchToolsStub());
  // Force a fresh require of the service modules so they pick up our stubs.
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

function reset(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  priceHistoryByYahooSymbol = {};
  return activePrisma;
}

function ok<T>(r: Result<T>): ServiceOk<T> {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as ServiceOk<T>;
}

function dbHoldingRow(o: Partial<RiskHoldingRow> = {}): RiskHoldingRow {
  return {
    symbol: "RELIANCE",
    sector: "Energy",
    exchange: "NSE",
    quantity: 100,
    averagePrice: 2000,
    currentPrice: 2500,
    ...o,
  };
}

/** Deterministic ascending price series of `n` points for one symbol. */
function series(start: number, step: number, n: number): PricePoint[] {
  const out: PricePoint[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    out.push({ date: d.toISOString().slice(0, 10), close: start + step * i });
  }
  return out;
}

describe("MONEY-620 — getPortfolioRisk LIVE (real fn, IDOR + poison)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });

  it("scopes holding.findMany to the caller's userId (IDOR)", async () => {
    prisma.queue("holding", "findMany", []);
    await svc.getPortfolioRisk("user-idor");
    const args = prisma.callsFor("holding", "findMany")[0]!.args as {
      where: { userId: string };
    };
    assert.equal(args.where.userId, "user-idor");
  });

  it("no holdings → failure result (not a throw)", async () => {
    prisma.queue("holding", "findMany", []);
    const r = await svc.getPortfolioRisk("user-empty");
    assert.equal(r.success, false);
  });

  it("clean holdings → finite HHI / weights / stress portfolioValue", async () => {
    prisma.queue("holding", "findMany", [
      dbHoldingRow({ symbol: "RELIANCE", currentPrice: 500, quantity: 1000 }), // 500k
      dbHoldingRow({
        symbol: "TCS",
        sector: "IT",
        currentPrice: 300,
        quantity: 1000,
      }), // 300k
      dbHoldingRow({
        symbol: "INFY",
        sector: "IT",
        currentPrice: 200,
        quantity: 1000,
      }), // 200k
    ]);
    const res = ok(await svc.getPortfolioRisk("user-clean"));
    const c = res.data.concentration;
    assert.ok(Number.isFinite(c.hhi), "HHI finite");
    assert.ok(c.hhi > 0, "HHI computed (not the empty fallback)");
    for (const h of c.topHoldings) {
      assert.ok(Number.isFinite(h.weight), "top-holding weight finite");
      assert.ok(h.weight > 0 && h.weight <= 1, "weight in (0,1]");
    }
    // stress-test portfolioValue = Σ holding value (real runStressTest).
    assert.equal(res.data.stressTest.portfolioValue, 1_000_000);
  });

  // The headline regression: a poisoned holding row (NaN price/qty) must NOT
  // blank the whole risk result — it would previously poison totalValue → every
  // weight NaN → NaN HHI. Now the bad row contributes value 0 and the rest
  // computes finitely.
  it("POISON: a NaN-price/qty holding yields a FULLY FINITE concentration (no NaN HHI)", async () => {
    prisma.queue("holding", "findMany", [
      dbHoldingRow({ symbol: "GOOD", currentPrice: 100, quantity: 1000 }), // 100k
      dbHoldingRow({
        symbol: "POISON",
        currentPrice: NaN, // corrupt
        averagePrice: NaN,
        quantity: 50,
      }),
      dbHoldingRow({
        symbol: "POISON2",
        currentPrice: 10,
        quantity: Infinity, // corrupt
      }),
    ]);
    const res = ok(await svc.getPortfolioRisk("user-poison"));
    const c = res.data.concentration;

    assert.ok(Number.isFinite(c.hhi), "HHI must be finite, not NaN");
    for (const h of c.topHoldings) {
      assert.ok(Number.isFinite(h.weight), `weight finite for ${h.symbol}`);
      assert.ok(Number.isFinite(h.value), `value finite for ${h.symbol}`);
    }
    for (const s of c.sectorWeights) {
      assert.ok(Number.isFinite(s.weight), `sector weight finite ${s.sector}`);
    }
    // Only the GOOD row carries value → it's 100% of the (finite) portfolio.
    const good = c.topHoldings.find((h) => h.symbol === "GOOD")!;
    assert.ok(Math.abs(good.weight - 1) < 1e-9, "GOOD is ~100% of book");
    // stress portfolioValue = 100k (poison rows contribute 0), finite.
    assert.ok(Number.isFinite(res.data.stressTest.portfolioValue));
    assert.equal(res.data.stressTest.portfolioValue, 100_000);
  });

  it("all-zero-value holdings → no divide-by-zero (finite, graceful)", async () => {
    prisma.queue("holding", "findMany", [
      dbHoldingRow({
        symbol: "Z1",
        currentPrice: 0,
        averagePrice: 0,
        quantity: 10,
      }),
      dbHoldingRow({
        symbol: "Z2",
        currentPrice: 0,
        averagePrice: 0,
        quantity: 5,
      }),
    ]);
    // totalValue 0 → compute_portfolio_concentration returns its own
    // "> 0" failure → service falls back to EMPTY_CONCENTRATION (hhi 0).
    const res = ok(await svc.getPortfolioRisk("user-zero"));
    assert.ok(Number.isFinite(res.data.concentration.hhi));
    assert.equal(res.data.concentration.hhi, 0);
    assert.equal(res.data.stressTest.portfolioValue, 0);
  });

  it("with >20 aligned price points, VaR/drawdown are finite (returns survive)", async () => {
    prisma.queue("holding", "findMany", [
      dbHoldingRow({
        symbol: "AAA",
        sector: "IT",
        currentPrice: 100,
        quantity: 1000,
      }),
      dbHoldingRow({
        symbol: "BBB",
        sector: "Bank",
        currentPrice: 100,
        quantity: 1000,
      }),
    ]);
    // 30 aligned daily points each → >20 sortedDates, >=20 returns.
    priceHistoryByYahooSymbol = {
      AAA: series(100, 1, 30),
      BBB: series(200, -1, 30),
      "^NSEI": series(18000, 5, 30),
    };
    const res = ok(await svc.getPortfolioRisk("user-stats"));
    if (res.data.var) {
      const v = res.data.var as { var95Amount: number };
      assert.ok(Number.isFinite(v.var95Amount), "VaR amount finite");
    }
    if (res.data.drawdown) {
      const d = res.data.drawdown as { maxDrawdown: number };
      assert.ok(Number.isFinite(d.maxDrawdown), "maxDrawdown finite");
    }
    // computedAt on the stress block is a valid ISO timestamp (no Invalid Date).
    const st = res.data.stressTest as unknown as { computedAt: string };
    assert.ok(!Number.isNaN(Date.parse(st.computedAt)));
  });

  // A corrupt benchmark close must not crash or null the whole result.
  it("a NaN in the NIFTY history does not throw / corrupt the result", async () => {
    prisma.queue("holding", "findMany", [
      dbHoldingRow({
        symbol: "AAA",
        sector: "IT",
        currentPrice: 100,
        quantity: 1000,
      }),
      dbHoldingRow({
        symbol: "BBB",
        sector: "Bank",
        currentPrice: 100,
        quantity: 1000,
      }),
    ]);
    const nifty = series(18000, 5, 30);
    nifty[10] = { date: nifty[10]!.date, close: NaN }; // one corrupt close
    priceHistoryByYahooSymbol = {
      AAA: series(100, 1, 30),
      BBB: series(200, -1, 30),
      "^NSEI": nifty,
    };
    const res = ok(await svc.getPortfolioRisk("user-bench-nan"));
    // beta may be null (one fewer pair) but it must be finite when present.
    if (res.data.beta) {
      const b = res.data.beta as { beta: number };
      assert.ok(Number.isFinite(b.beta), "beta finite when present");
    }
    assert.ok(Number.isFinite(res.data.concentration.hhi));
  });
});
