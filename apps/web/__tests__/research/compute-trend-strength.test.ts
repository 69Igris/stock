import { test } from "node:test";
import assert from "node:assert/strict";

import { computeTrendStrengthTool } from "../../../../packages/research/src/tools/compute-trend-strength";

// MONEY-543 - compute-trend-strength pure-function tests.
//
// The tool is a PURE compute tool (no network / db / io). It reads closes /
// highs / lows from params and emits regression slope% + R², ADX(14), SMA
// alignment, regime classification, and observation flags.
//
// Contract under test:
//  - genuine exceptions  → { success: false }
//  - too little data     → { success: true, data: { available: false, reason } }
//  - happy path          → { success: true, data: { available: true, ... } }

async function run(args: Record<string, unknown>) {
  return computeTrendStrengthTool.execute(args);
}

interface TrendData {
  available: boolean;
  reason?: string;
  symbol?: string;
  lookback: number;
  annualizedSlopePct: number;
  r2: number;
  adx: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  currentPrice: number;
  priceAboveSma20: boolean | null;
  priceAboveSma50: boolean | null;
  priceAboveSma200: boolean | null;
  smaStackBullish: boolean | null;
  smaStackBearish: boolean | null;
  distanceFrom200SmaPct: number | null;
  regime: string;
  trendDurationBars: number;
  flags: string[];
}

// 60-bar geometric uptrend: closes[i] = 100 * 1.001^i (default lookback 60).
function geometricUptrend(length = 60, base = 100, rate = 1.001): number[] {
  return Array.from({ length }, (_, i) => base * Math.pow(rate, i));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — key fields present with correct types.
// ─────────────────────────────────────────────────────────────────────────────

test("happy path: success + available, key fields present with correct types", async () => {
  // ~250 bars with a clear uptrend + matching highs/lows so ADX + SMA200 fire.
  const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.5);
  const highs = closes.map((c) => c + 1);
  const lows = closes.map((c) => c - 1);

  const r = await run({ closes, highs, lows, symbol: "TEST" });
  assert.equal(r.success, true);
  const d = r.data as TrendData;

  assert.equal(d.available, true);
  assert.equal(d.symbol, "TEST");

  // numeric fields
  assert.equal(typeof d.lookback, "number");
  assert.equal(typeof d.annualizedSlopePct, "number");
  assert.equal(typeof d.r2, "number");
  assert.equal(typeof d.currentPrice, "number");
  assert.equal(typeof d.trendDurationBars, "number");

  // r2 in [0,1]
  assert.ok(d.r2 >= 0 && d.r2 <= 1, `r2 in range, got ${d.r2}`);

  // SMAs present (>=200 bars) and numeric
  assert.equal(typeof d.sma20, "number");
  assert.equal(typeof d.sma50, "number");
  assert.equal(typeof d.sma200, "number");
  assert.equal(typeof d.distanceFrom200SmaPct, "number");

  // ADX present (highs/lows supplied & aligned), numeric in [0,100]
  assert.equal(typeof d.adx, "number");
  assert.ok((d.adx as number) >= 0 && (d.adx as number) <= 100);

  // booleans for price-vs-SMA + stack
  assert.equal(typeof d.priceAboveSma20, "boolean");
  assert.equal(typeof d.priceAboveSma50, "boolean");
  assert.equal(typeof d.priceAboveSma200, "boolean");
  assert.equal(typeof d.smaStackBullish, "boolean");
  assert.equal(typeof d.smaStackBearish, "boolean");

  // regime + flags
  assert.equal(typeof d.regime, "string");
  assert.ok(Array.isArray(d.flags));

  // A monotone rising line → price above all SMAs and bullish stack.
  assert.equal(d.priceAboveSma200, true);
  assert.equal(d.smaStackBullish, true);
  assert.equal(d.smaStackBearish, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. KNOWN-VALUE numeric assertion.
//    closes[i] = 100 * 1.001^i, i=0..59 (length 60, default lookback 60), no
//    highs/lows. Regression of log(close) is perfectly linear:
//      r2 = 1.0
//      per-bar log slope = ln(1.001)
//      annualizedSlopePct = (1.001^252 − 1) * 100 = 28.64 (2dp)
//      regime = "strong uptrend"  (slope >= 25 and r2 >= 0.6)
//      adx = null  (highs/lows omitted) + flag "ADX skipped..."
//      sma200 = null, distanceFrom200SmaPct = null (only 60 bars)
// ─────────────────────────────────────────────────────────────────────────────

test("known values: perfect log-linear 60-bar uptrend", async () => {
  const closes = geometricUptrend(60, 100, 1.001);

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as TrendData;

  assert.equal(d.available, true);
  assert.equal(d.lookback, 60);

  // r2 = 1.0 (perfect fit) — rounded to 3dp in the tool.
  assert.ok(Math.abs(d.r2 - 1.0) < 1e-9, `r2 should be 1.0, got ${d.r2}`);

  // annualizedSlopePct = 28.64 (runtime-verified, 2dp).
  assert.ok(
    Math.abs(d.annualizedSlopePct - 28.64) < 1e-9,
    `annualizedSlopePct should be 28.64, got ${d.annualizedSlopePct}`
  );

  // regime classification
  assert.equal(d.regime, "strong uptrend");

  // ADX degraded to null (no highs/lows) with the skip flag.
  assert.equal(d.adx, null);
  assert.ok(
    d.flags.includes("ADX skipped - highs/lows unavailable"),
    `flags should include ADX-skipped, got ${JSON.stringify(d.flags)}`
  );

  // 60 bars < 200 → sma200 / distanceFrom200SmaPct unavailable.
  assert.equal(d.sma200, null);
  assert.equal(d.distanceFrom200SmaPct, null);
  assert.equal(d.priceAboveSma200, null);

  // currentPrice = last close, rounded 2dp.
  const expectedLast = Math.round(closes[closes.length - 1]! * 100) / 100;
  assert.equal(d.currentPrice, expectedLast);
});

test("known values: 60-bar geometric DOWNTREND classifies to strong downtrend", async () => {
  // Decreasing log-linear series: closes[i] = 100 * 1.0012^(59-i) → -ln(1.0012)/bar.
  // exp() annualization is asymmetric, so rate 1.0012 yields slope <= -25.
  const closes = Array.from(
    { length: 60 },
    (_, i) => 100 * Math.pow(1.0012, 59 - i)
  );

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as TrendData;

  assert.equal(d.available, true);
  // Perfect log-linear fit → r2 = 1.0 (rounded 3dp).
  assert.ok(Math.abs(d.r2 - 1.0) < 1e-9, `r2 should be 1.0, got ${d.r2}`);
  // Annualized decay: (1.0012^-252 - 1) * 100 = -26.08 (runtime-verified, 2dp).
  const expected = Math.round((Math.pow(1.0012, -252) - 1) * 100 * 100) / 100;
  assert.ok(
    Math.abs(d.annualizedSlopePct - expected) < 1e-9,
    `annualizedSlopePct should be ${expected}, got ${d.annualizedSlopePct}`
  );
  assert.ok(Math.abs(d.annualizedSlopePct - -26.08) < 1e-9);
  assert.ok(d.annualizedSlopePct <= -25);
  assert.equal(d.regime, "strong downtrend");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Graceful degradation — available:false (NOT success:false) on thin data.
// ─────────────────────────────────────────────────────────────────────────────

test("graceful degrade: < 30 valid closes → success:true, available:false, reason names count", async () => {
  const closes = Array.from({ length: 10 }, (_, i) => 100 + i);

  const r = await run({ closes });
  // NOT a thrown exception — success stays true, the result self-reports.
  assert.equal(r.success, true);
  const d = r.data as TrendData;

  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.ok(
    (d.reason as string).includes("10"),
    `reason should name the count 10, got "${d.reason}"`
  );
  assert.ok(
    (d.reason as string).toLowerCase().includes("insufficient"),
    `reason should explain insufficiency, got "${d.reason}"`
  );
});

test("graceful degrade: empty closes → available:false (count 0), no throw", async () => {
  const r = await run({ closes: [] });
  assert.equal(r.success, true);
  const d = r.data as TrendData;
  assert.equal(d.available, false);
  assert.ok((d.reason as string).includes("0"));
  assert.equal(d.currentPrice, 0);
});

test("graceful degrade: non-finite / non-positive closes are dropped before the 30 gate", async () => {
  // 29 valid positives + a pile of junk that must be filtered out → still < 30.
  const valid = Array.from({ length: 29 }, (_, i) => 100 + i);
  const closes = [
    ...valid,
    0,
    -5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "oops",
    null,
  ];

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as TrendData;
  assert.equal(d.available, false);
  // Only 29 survived the finite-&-positive filter.
  assert.ok(
    (d.reason as string).includes("29"),
    `reason should report 29 valid closes, got "${d.reason}"`
  );
});

test("ADX-only degrade: highs/lows misaligned with closes → adx:null but result still available", async () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.3);
  // highs shorter than closes → misaligned, ADX must skip (not whole-result fail).
  const highs = closes.slice(0, 40).map((c) => c + 1);
  const lows = closes.slice(0, 40).map((c) => c - 1);

  const r = await run({ closes, highs, lows });
  assert.equal(r.success, true);
  const d = r.data as TrendData;
  assert.equal(d.available, true); // whole result NOT degraded
  assert.equal(d.adx, null); // only ADX degraded
  assert.ok(d.flags.includes("ADX skipped - highs/lows unavailable"));
});

test("ADX-only degrade: highs/lows present but contain non-finite values → adx:null", async () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.3);
  const highs = closes.map((c) => c + 1);
  const lows = closes.map((c) => c - 1);
  // Poison one high so the .every(Number.isFinite) guard fails.
  (highs as unknown[])[10] = Number.NaN;

  const r = await run({ closes, highs, lows });
  assert.equal(r.success, true);
  const d = r.data as TrendData;
  assert.equal(d.available, true);
  assert.equal(d.adx, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Edge cases — must not throw / must remain well-formed.
// ─────────────────────────────────────────────────────────────────────────────

test("edge: missing closes param → available:false, no throw", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const d = r.data as TrendData;
  assert.equal(d.available, false);
  assert.ok((d.reason as string).includes("0"));
});

test("edge: closes not an array (object) → treated as empty, available:false", async () => {
  const r = await run({ closes: { not: "an array" } });
  assert.equal(r.success, true);
  const d = r.data as TrendData;
  assert.equal(d.available, false);
});

test("edge: flat constant series (>=30 bars) → sideways, r2 = 0, no throw", async () => {
  // Constant closes → zero variance → slope 0, r2 clamped to 0.
  const closes = Array.from({ length: 60 }, () => 100);

  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as TrendData;
  assert.equal(d.available, true);
  assert.equal(d.r2, 0);
  assert.equal(d.annualizedSlopePct, 0);
  assert.equal(d.regime, "sideways");
});

test("edge: lookback clamped to series length when oversized / invalid", async () => {
  const closes = Array.from({ length: 45 }, (_, i) => 100 + i);

  // Oversized lookback clamps down to 45.
  const big = await run({ closes, lookback: 9999 });
  assert.equal(big.success, true);
  assert.equal((big.data as TrendData).lookback, 45);

  // Zero / negative lookback falls back to default 60 then clamps to 45.
  const zero = await run({ closes, lookback: 0 });
  assert.equal(zero.success, true);
  assert.equal((zero.data as TrendData).lookback, 45);

  const neg = await run({ closes, lookback: -10 });
  assert.equal(neg.success, true);
  assert.equal((neg.data as TrendData).lookback, 45);
});

test("edge: missing optional symbol → symbol undefined, no throw", async () => {
  const closes = geometricUptrend(60);
  const r = await run({ closes });
  assert.equal(r.success, true);
  const d = r.data as TrendData;
  assert.equal(d.symbol, undefined);
  assert.equal(d.available, true);
});
