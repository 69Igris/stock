/**
 * Technical-Analysis Math — Edge-Case & NaN-Leak Guard Tests
 *
 * Imports the REAL exported symbols from the shared technical-analysis
 * libraries in packages/research (no shadow re-implementations):
 *   - packages/research/src/lib/indicators.ts          (24+ indicator families)
 *   - packages/research/src/lib/chart-patterns.ts       (chart-pattern detector)
 *   - packages/research/src/lib/candlestick-patterns.ts (candlestick detector)
 *
 * These are pure, NaN-prone functions. The suite asserts CORRECT behavior on
 * adversarial inputs: insufficient data (< period/window), empty arrays, a
 * single point, flat/constant series, NaN / negative / zero prices, and huge
 * series. It also asserts that NO NaN / Infinity leaks into outputs and that
 * bounded indicators stay bounded (RSI, %K, %D, MFI, CCI, Williams %R).
 *
 * Two real bugs were found and fixed in indicators.ts while writing this:
 *   1. computeMACD([])           leaked NaN  (now returns a neutral 0 MACD).
 *   2. findSupportResistance([]) leaked ±Infinity (now returns finite zeros).
 * The corresponding tests below are regression guards for those fixes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── REAL source imports (the thing under test) ──────────────────────
import {
  sma,
  ema,
  emaLast,
  computeRSI,
  computeMACD,
  computeBollingerBands,
  findSupportResistance,
  computeStochastic,
  computeATR,
  computeTrueRanges,
  computeADX,
  computeSupertrend,
  computePivotPoints,
  computeOBV,
  computeVWAP,
  computeVolumeRatio,
  computeCCI,
  computeMFI,
  computeWilliamsR,
  computeROC,
  computePSAR,
  computeIchimoku,
  computeBeta,
  detectNarrowRange,
  toWeekly,
  weeklySMA,
  weeklyEMA,
  weeklyRSI,
  evaluateRule,
  type StrategyRule,
} from "@usemoney/research/lib/indicators";
import {
  detectChartPatterns,
  findPeaksAndTroughs,
  type ChartPattern,
} from "@usemoney/research/lib/chart-patterns";
import {
  detectCandlestickPatterns,
  type CandlestickPattern,
} from "@usemoney/research/lib/candlestick-patterns";

// ── Helpers ─────────────────────────────────────────────────────────

/** A finite (non-NaN, non-Infinity) number assertion. */
function assertFinite(v: unknown, label: string): void {
  assert.strictEqual(
    typeof v,
    "number",
    `${label}: expected number, got ${typeof v}`
  );
  assert.ok(
    Number.isFinite(v as number),
    `${label}: expected finite, got ${v as number}`
  );
}

/** Assert a value (possibly object) contains no NaN/Infinity numbers. */
function assertNoLeak(v: unknown, label: string): void {
  if (typeof v === "number") {
    assert.ok(Number.isFinite(v), `${label}: numeric leak ${v}`);
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "number") {
        assert.ok(Number.isFinite(val), `${label}.${k}: numeric leak ${val}`);
      }
    }
  }
}

const fill = (n: number, v: number): number[] => Array(n).fill(v);
const rising = (n: number, start = 100, step = 1): number[] =>
  Array.from({ length: n }, (_, i) => start + i * step);
const falling = (n: number, start = 200, step = 1): number[] =>
  Array.from({ length: n }, (_, i) => start - i * step);

/** Deterministic "realistic" wiggly close series for huge/bound tests. */
function wiggly(n: number, base = 1000): number[] {
  return Array.from(
    { length: n },
    (_, i) =>
      base + Math.sin(i * 0.07) * 30 + Math.cos(i * 0.013) * 12 + i * 0.01
  );
}

// ════════════════════════════════════════════════════════════════════
// INDICATORS — SMA / EMA
// ════════════════════════════════════════════════════════════════════

describe("indicators: sma / ema", () => {
  it("sma() returns the last value (not NaN/undefined) when data is shorter than period", () => {
    // Source contract: prices.length < period → prices[last] || 0
    assert.strictEqual(sma([7], 5), 7);
    assert.strictEqual(sma([3, 9], 5), 9);
  });

  it("sma() of empty array returns 0 (no NaN leak)", () => {
    const v = sma([], 5);
    assertFinite(v, "sma([],5)");
    assert.strictEqual(v, 0);
  });

  it("sma() computes the correct trailing average", () => {
    assert.strictEqual(sma([10, 20, 30, 40, 50], 5), 30);
    assert.strictEqual(sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5), 8);
  });

  it("sma() handles negative values without NaN", () => {
    const v = sma([-10, -20, -30], 3);
    assertFinite(v, "sma(neg)");
    assert.strictEqual(v, -20);
  });

  it("sma() of a flat series equals the constant", () => {
    assert.strictEqual(sma(fill(50, 100), 20), 100);
  });

  it("sma() over a huge series stays finite", () => {
    assertFinite(sma(wiggly(5000), 200), "sma(huge)");
  });

  it("ema() of a single-element series has one finite value", () => {
    const arr = ema([5], 5);
    assert.strictEqual(arr.length, 1);
    assertFinite(arr[0], "ema([5])[0]");
    assert.strictEqual(arr[0], 5);
  });

  it("ema() of a flat series stays flat and finite", () => {
    const arr = ema(fill(30, 100), 12);
    assert.strictEqual(arr.length, 30);
    for (const v of arr) assertFinite(v, "ema(flat)");
    assert.strictEqual(arr[arr.length - 1], 100);
  });

  it("ema() over a huge series leaks no NaN/Infinity", () => {
    const arr = ema(wiggly(5000), 26);
    for (let i = 0; i < arr.length; i += 250)
      assertFinite(arr[i], `ema(huge)[${i}]`);
    assertFinite(arr[arr.length - 1], "ema(huge).last");
  });

  it("emaLast() returns the final EMA value finitely for a flat series", () => {
    const v = emaLast(fill(40, 100), 12);
    assertFinite(v, "emaLast(flat)");
    assert.strictEqual(v, 100);
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — RSI (bounded [0,100])
// ════════════════════════════════════════════════════════════════════

describe("indicators: computeRSI", () => {
  it("returns the neutral 50 when data is shorter than period+1 (insufficient)", () => {
    assert.strictEqual(computeRSI([], 14), 50);
    assert.strictEqual(computeRSI([100, 101, 102], 14), 50);
    assert.strictEqual(computeRSI(rising(14), 14), 50); // exactly period, needs period+1
  });

  it("flat/constant series yields RSI 100 (no gains, no losses → avgLoss 0 guard)", () => {
    // avgLoss === 0 short-circuits to 100 (documents the source's divide-by-zero guard)
    const v = computeRSI(fill(20, 100), 14);
    assertFinite(v, "rsi(flat)");
    assert.strictEqual(v, 100);
  });

  it("all-gains series returns 100, all-losses returns 0", () => {
    assert.strictEqual(computeRSI(rising(16, 100, 1), 14), 100);
    assert.strictEqual(computeRSI(falling(16, 200, 1), 14), 0);
  });

  it("stays within [0,100] for mixed and negative-priced data", () => {
    const mixed = [
      100, 105, 103, 107, 104, 108, 106, 110, 108, 112, 110, 114, 112, 116, 114,
      118,
    ];
    const v1 = computeRSI(mixed, 14);
    assert.ok(v1 >= 0 && v1 <= 100, `rsi(mixed) out of range: ${v1}`);

    // Negative-priced rising series — RSI math is change-based, must still bound
    const neg = rising(20, -20, 1);
    const v2 = computeRSI(neg, 14);
    assert.ok(v2 >= 0 && v2 <= 100, `rsi(neg) out of range: ${v2}`);
  });

  it("stays within [0,100] on a huge series", () => {
    const v = computeRSI(wiggly(5000), 14);
    assertFinite(v, "rsi(huge)");
    assert.ok(v >= 0 && v <= 100, `rsi(huge) out of range: ${v}`);
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — MACD  (BUG #1: NaN leak on empty — fixed)
// ════════════════════════════════════════════════════════════════════

describe("indicators: computeMACD", () => {
  it("REGRESSION (bug fix): empty array returns a finite neutral 0 MACD, not NaN", () => {
    // Before the guard, ema([]) → [undefined] and the subtraction leaked NaN.
    const m = computeMACD([]);
    assert.deepStrictEqual(m, { macdLine: 0, signalLine: 0, histogram: 0 });
    assertNoLeak(m, "computeMACD([])");
  });

  it("single-element series yields a finite MACD", () => {
    const m = computeMACD([100]);
    assertNoLeak(m, "computeMACD([100])");
    assert.deepStrictEqual(m, { macdLine: 0, signalLine: 0, histogram: 0 });
  });

  it("flat series yields ~0 MACD with no leak", () => {
    const m = computeMACD(fill(60, 100));
    assertNoLeak(m, "computeMACD(flat)");
    assert.ok(
      Math.abs(m.macdLine) < 0.01,
      `macdLine should be ~0, got ${m.macdLine}`
    );
    assert.ok(
      Math.abs(m.histogram) < 0.01,
      `histogram should be ~0, got ${m.histogram}`
    );
  });

  it("histogram equals macdLine - signalLine (within rounding)", () => {
    const m = computeMACD(wiggly(80));
    assertNoLeak(m, "computeMACD(wiggly)");
    assert.ok(
      Math.abs(m.histogram - (m.macdLine - m.signalLine)) <= 0.011,
      `histogram ${m.histogram} != macd-signal ${m.macdLine - m.signalLine}`
    );
  });

  it("positive for a strong uptrend, negative for a strong downtrend", () => {
    assert.ok(computeMACD(rising(60, 100, 2)).macdLine > 0);
    assert.ok(computeMACD(falling(60, 300, 2)).macdLine < 0);
  });

  it("leaks no NaN/Infinity on a huge series", () => {
    assertNoLeak(computeMACD(wiggly(5000)), "computeMACD(huge)");
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — Bollinger Bands
// ════════════════════════════════════════════════════════════════════

describe("indicators: computeBollingerBands", () => {
  it("empty array returns all-zero bands (no NaN)", () => {
    const b = computeBollingerBands([], 20);
    assertNoLeak(b, "bb([])");
    assert.deepStrictEqual(b, { upper: 0, middle: 0, lower: 0, bandwidth: 0 });
  });

  it("flat series has zero-width bands and zero bandwidth", () => {
    const b = computeBollingerBands(fill(20, 100), 20);
    assertNoLeak(b, "bb(flat)");
    assert.strictEqual(b.middle, 100);
    assert.strictEqual(b.upper, 100);
    assert.strictEqual(b.lower, 100);
    assert.strictEqual(b.bandwidth, 0);
  });

  it("upper >= middle >= lower and bandwidth >= 0 for normal data", () => {
    const b = computeBollingerBands(rising(20, 100, 1), 20);
    assertNoLeak(b, "bb(rising)");
    assert.ok(b.upper >= b.middle);
    assert.ok(b.middle >= b.lower);
    assert.ok(b.bandwidth >= 0);
  });

  it("wider multiplier widens the bands", () => {
    const data = rising(20, 100, 1);
    const b2 = computeBollingerBands(data, 20, 2);
    const b3 = computeBollingerBands(data, 20, 3);
    assert.ok(b3.upper > b2.upper);
    assert.ok(b3.lower < b2.lower);
  });

  it("leaks no NaN/Infinity on a huge series", () => {
    assertNoLeak(computeBollingerBands(wiggly(5000), 20), "bb(huge)");
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — findSupportResistance  (BUG #2: Infinity leak on empty — fixed)
// ════════════════════════════════════════════════════════════════════

describe("indicators: findSupportResistance", () => {
  it("REGRESSION (bug fix): empty array returns finite zeros, not ±Infinity", () => {
    // Before the guard, Math.min(...[]) = +Infinity and Math.max(...[]) = -Infinity.
    const sr = findSupportResistance([]);
    assert.deepStrictEqual(sr, { support: 0, resistance: 0 });
    assertNoLeak(sr, "findSupportResistance([])");
  });

  it("short series (<20) uses min/max and stays finite", () => {
    const sr = findSupportResistance([5, 3, 9, 1, 7]);
    assertNoLeak(sr, "fsr(short)");
    assert.strictEqual(sr.support, 1);
    assert.strictEqual(sr.resistance, 9);
  });

  it("single point: support == resistance == the point", () => {
    const sr = findSupportResistance([42]);
    assert.deepStrictEqual(sr, { support: 42, resistance: 42 });
  });

  it("flat series: support == resistance == constant", () => {
    const sr = findSupportResistance(fill(60, 100));
    assertNoLeak(sr, "fsr(flat)");
    assert.strictEqual(sr.support, 100);
    assert.strictEqual(sr.resistance, 100);
  });

  it("percentile path (>=20) yields support <= resistance, both finite", () => {
    const sr = findSupportResistance(wiggly(120));
    assertNoLeak(sr, "fsr(percentile)");
    assert.ok(sr.support <= sr.resistance);
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — Stochastic (bounded [0,100])
// ════════════════════════════════════════════════════════════════════

describe("indicators: computeStochastic", () => {
  it("returns null when data is shorter than period", () => {
    assert.strictEqual(computeStochastic([], [], [], 14), null);
    assert.strictEqual(
      computeStochastic([1, 2, 3], [1, 2, 3], [1, 2, 3], 14),
      null
    );
  });

  it("flat series (zero range) returns neutral 50 for %K and %D (no divide-by-zero)", () => {
    const flat = fill(14, 100);
    const s = computeStochastic(flat, flat, flat, 14);
    assert.ok(s !== null);
    assert.strictEqual(s!.percentK, 50);
    assert.strictEqual(s!.percentD, 50);
  });

  it("%K and %D stay within [0,100] for normal and huge data", () => {
    const closes = wiggly(40);
    const highs = closes.map((c) => c + 5);
    const lows = closes.map((c) => c - 5);
    const s = computeStochastic(closes, highs, lows, 14)!;
    assert.ok(
      s.percentK >= 0 && s.percentK <= 100,
      `%K out of range: ${s.percentK}`
    );
    assert.ok(
      s.percentD >= 0 && s.percentD <= 100,
      `%D out of range: ${s.percentD}`
    );

    const bc = wiggly(5000);
    const sh = computeStochastic(
      bc,
      bc.map((c) => c + 5),
      bc.map((c) => c - 5),
      14
    )!;
    assert.ok(
      sh.percentK >= 0 && sh.percentK <= 100,
      `%K(huge) OOR: ${sh.percentK}`
    );
  });

  it("close at the high → %K = 100; close at the low → %K = 0", () => {
    const highs = fill(14, 200);
    const lows = fill(14, 100);
    const atHigh = computeStochastic([...fill(13, 150), 200], highs, lows, 14)!;
    const atLow = computeStochastic([...fill(13, 150), 100], highs, lows, 14)!;
    assert.strictEqual(atHigh.percentK, 100);
    assert.strictEqual(atLow.percentK, 0);
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — ATR / True Ranges
// ════════════════════════════════════════════════════════════════════

describe("indicators: computeATR / computeTrueRanges", () => {
  it("ATR returns null when data is shorter than period+1", () => {
    assert.strictEqual(computeATR([], [], [], 14), null);
    const c = rising(14);
    assert.strictEqual(
      computeATR(
        c,
        c.map((x) => x + 1),
        c.map((x) => x - 1),
        14
      ),
      null
    );
  });

  it("computeTrueRanges of empty / single returns empty array", () => {
    assert.deepStrictEqual(computeTrueRanges([], [], []), []);
    assert.deepStrictEqual(computeTrueRanges([100], [100], [100]), []);
  });

  it("flat series → zero true ranges and ATR 0 (finite)", () => {
    const flat = fill(20, 100);
    const trs = computeTrueRanges(flat, flat, flat);
    for (const t of trs) assert.strictEqual(t, 0);
    const v = computeATR(flat, flat, flat, 14);
    assertFinite(v, "atr(flat)");
    assert.strictEqual(v, 0);
  });

  it("constant-range candles → ATR equals that range", () => {
    const closes = fill(20, 100);
    const highs = fill(20, 105);
    const lows = fill(20, 95);
    // TR = max(105-95, |105-100|, |95-100|) = 10
    assert.strictEqual(computeATR(closes, highs, lows, 14), 10);
  });

  it("ATR is finite and non-negative on a huge series", () => {
    const c = wiggly(5000);
    const v = computeATR(
      c,
      c.map((x) => x + 3),
      c.map((x) => x - 3),
      14
    )!;
    assertFinite(v, "atr(huge)");
    assert.ok(v >= 0);
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — ADX
// ════════════════════════════════════════════════════════════════════

describe("indicators: computeADX", () => {
  it("returns null when data is shorter than period*2", () => {
    assert.strictEqual(computeADX([], [], [], 14), null);
    const c = rising(20);
    assert.strictEqual(
      computeADX(
        c,
        c.map((x) => x + 1),
        c.map((x) => x - 1),
        14
      ),
      null
    );
  });

  it("flat series returns a finite, in-range [0,100] ADX (no divide-by-zero)", () => {
    const flat = fill(40, 100);
    const v = computeADX(flat, flat, flat, 14);
    if (v !== null) {
      assertFinite(v, "adx(flat)");
      assert.ok(v >= 0 && v <= 100, `adx(flat) out of range: ${v}`);
    }
  });

  it("stays finite and within [0,100] for a strong trend and a huge series", () => {
    const up = rising(60, 100, 1);
    const v1 = computeADX(
      up,
      up.map((x) => x + 1),
      up.map((x) => x - 1),
      14
    );
    if (v1 !== null) assert.ok(v1 >= 0 && v1 <= 100, `adx(trend) OOR: ${v1}`);

    const c = wiggly(5000);
    const v2 = computeADX(
      c,
      c.map((x) => x + 2),
      c.map((x) => x - 2),
      14
    );
    if (v2 !== null) {
      assertFinite(v2, "adx(huge)");
      assert.ok(v2 >= 0 && v2 <= 100, `adx(huge) OOR: ${v2}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — Supertrend / PSAR / Ichimoku
// ════════════════════════════════════════════════════════════════════

describe("indicators: computeSupertrend / computePSAR / computeIchimoku", () => {
  it("supertrend returns null when true-range count is below period", () => {
    assert.strictEqual(computeSupertrend([], [], [], 10), null);
    const c = rising(8);
    assert.strictEqual(
      computeSupertrend(
        c,
        c.map((x) => x + 1),
        c.map((x) => x - 1),
        10
      ),
      null
    );
  });

  it("supertrend value/direction are finite & valid for a flat series", () => {
    const flat = fill(30, 100);
    const st = computeSupertrend(flat, flat, flat, 10, 3)!;
    assert.ok(st !== null);
    assertFinite(st.value, "supertrend(flat).value");
    assert.ok(["bullish", "bearish", "neutral"].includes(st.direction));
  });

  it("PSAR returns null for fewer than 3 bars", () => {
    assert.strictEqual(computePSAR([1, 2], [1, 2]), null);
    assert.strictEqual(computePSAR([], []), null);
  });

  it("PSAR is finite for a flat series and a huge series", () => {
    const flat = fill(50, 100);
    const p1 = computePSAR(flat, flat)!;
    assertFinite(p1.value, "psar(flat).value");
    assert.ok(["bullish", "bearish"].includes(p1.trend));

    const c = wiggly(3000);
    const p2 = computePSAR(
      c.map((x) => x + 2),
      c.map((x) => x - 2)
    )!;
    assertFinite(p2.value, "psar(huge).value");
  });

  it("Ichimoku returns null below senkouB period (52)", () => {
    assert.strictEqual(computeIchimoku([1, 2, 3], [1, 2, 3], [1, 2, 3]), null);
    const c = rising(40);
    assert.strictEqual(
      computeIchimoku(
        c,
        c.map((x) => x + 1),
        c.map((x) => x - 1)
      ),
      null
    );
  });

  it("Ichimoku produces finite levels with a valid priceVsCloud enum", () => {
    const c = wiggly(80);
    const ich = computeIchimoku(
      c,
      c.map((x) => x + 2),
      c.map((x) => x - 2)
    )!;
    assert.ok(ich !== null);
    assertNoLeak(ich, "ichimoku");
    assert.ok(["above", "below", "inside"].includes(ich.priceVsCloud));
    assert.ok(ich.cloudTop >= ich.cloudBottom);
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — Pivot / OBV / VWAP / Volume Ratio
// ════════════════════════════════════════════════════════════════════

describe("indicators: computePivotPoints / computeOBV / computeVWAP / computeVolumeRatio", () => {
  it("pivot points of all-zero inputs are all finite zeros (no NaN)", () => {
    const p = computePivotPoints(0, 0, 0);
    assertNoLeak(p, "pivot(0,0,0)");
    assert.deepStrictEqual(p, { pivot: 0, r1: 0, r2: 0, s1: 0, s2: 0 });
  });

  it("pivot points satisfy s2 <= s1 <= pivot <= r1 <= r2 for a normal bar", () => {
    const p = computePivotPoints(100, 110, 90);
    assertNoLeak(p, "pivot(normal)");
    assert.ok(
      p.s2 <= p.s1 && p.s1 <= p.pivot && p.pivot <= p.r1 && p.r1 <= p.r2
    );
  });

  it("OBV of empty / single candle is 0", () => {
    assert.strictEqual(computeOBV([], []), 0);
    assert.strictEqual(computeOBV([100], [50000]), 0);
  });

  it("OBV of a flat series is 0 (no up/down days)", () => {
    assert.strictEqual(computeOBV(fill(10, 100), fill(10, 1000)), 0);
  });

  it("OBV accumulates up-volume and subtracts down-volume", () => {
    // up +2000, down -1500, up +3000, flat 0, down -4000 => -500
    const prices = [100, 110, 105, 108, 108, 100];
    const vols = [1000, 2000, 1500, 3000, 1000, 4000];
    assert.strictEqual(computeOBV(prices, vols), -500);
  });

  it("VWAP of empty input returns undefined (prices[last]); no NaN forced", () => {
    // Documents the source: cumVol 0 → returns prices[prices.length-1] (undefined for [])
    assert.strictEqual(computeVWAP([], [], [], []), undefined);
  });

  it("VWAP with zero total volume falls back to last price (finite)", () => {
    const v = computeVWAP([10], [10], [10], [0]);
    assertFinite(v, "vwap(zero-vol)");
    assert.strictEqual(v, 10);
  });

  it("VWAP is finite and within [min,max] of typical prices for normal data", () => {
    const closes = wiggly(50);
    const highs = closes.map((c) => c + 5);
    const lows = closes.map((c) => c - 5);
    const vols = closes.map((_, i) => 1000 + (i % 7) * 100);
    const v = computeVWAP(closes, highs, lows, vols)!;
    assertFinite(v, "vwap(normal)");
    const lo = Math.min(...lows);
    const hi = Math.max(...highs);
    assert.ok(v >= lo && v <= hi, `vwap ${v} outside [${lo},${hi}]`);
  });

  it("volume ratio defaults to 1 when data is shorter than period+1", () => {
    assert.strictEqual(computeVolumeRatio([], 20), 1);
    assert.strictEqual(computeVolumeRatio(fill(10, 1000), 20), 1);
  });

  it("volume ratio is finite for a flat-volume series", () => {
    const v = computeVolumeRatio(fill(40, 1000), 20);
    assertFinite(v, "volRatio(flat)");
    assert.strictEqual(v, 1);
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — CCI / MFI / Williams %R / ROC (bounded where applicable)
// ════════════════════════════════════════════════════════════════════

describe("indicators: computeCCI / computeMFI / computeWilliamsR / computeROC", () => {
  it("CCI returns null when data is shorter than period", () => {
    assert.strictEqual(computeCCI([], [], [], 20), null);
  });

  it("CCI of a flat series is 0 (mean-deviation guard, no divide-by-zero)", () => {
    const flat = fill(20, 100);
    const v = computeCCI(flat, flat, flat, 20);
    assertFinite(v, "cci(flat)");
    assert.strictEqual(v, 0);
  });

  it("CCI is finite on a huge series", () => {
    const c = wiggly(5000);
    const v = computeCCI(
      c,
      c.map((x) => x + 3),
      c.map((x) => x - 3),
      20
    );
    if (v !== null) assertFinite(v, "cci(huge)");
  });

  it("MFI returns null when data is shorter than period+1", () => {
    assert.strictEqual(computeMFI([], [], [], [], 14), null);
  });

  it("MFI of a flat series is 100 (negativeFlow 0 guard) and within [0,100]", () => {
    const flat = fill(21, 100);
    const v = computeMFI(flat, flat, flat, fill(21, 1000), 14);
    assert.ok(v !== null);
    assertFinite(v, "mfi(flat)");
    assert.strictEqual(v, 100);
  });

  it("MFI stays within [0,100] on a huge series", () => {
    const c = wiggly(5000);
    const v = computeMFI(
      c,
      c.map((x) => x + 4),
      c.map((x) => x - 4),
      c.map((_, i) => 1000 + (i % 13) * 50),
      14
    );
    if (v !== null) {
      assertFinite(v, "mfi(huge)");
      assert.ok(v >= 0 && v <= 100, `mfi(huge) OOR: ${v}`);
    }
  });

  it("Williams %R returns null when data is shorter than period", () => {
    assert.strictEqual(computeWilliamsR([], [], [], 14), null);
  });

  it("Williams %R of a flat series is -50 (range guard) and within [-100,0]", () => {
    const flat = fill(14, 100);
    const v = computeWilliamsR(flat, flat, flat, 14);
    assert.strictEqual(v, -50);
  });

  it("Williams %R stays within [-100,0] for normal and huge data", () => {
    const highs = fill(14, 200);
    const lows = fill(14, 100);
    const atHigh = computeWilliamsR([...fill(13, 150), 200], highs, lows, 14)!;
    const atLow = computeWilliamsR([...fill(13, 150), 100], highs, lows, 14)!;
    // close at high → 0 (use value equality: source yields -0, which === 0)
    assert.ok(atHigh === 0, `williamsR at high should be 0, got ${atHigh}`);
    assert.strictEqual(atLow, -100);

    const c = wiggly(5000);
    const v = computeWilliamsR(
      c,
      c.map((x) => x + 5),
      c.map((x) => x - 5),
      14
    )!;
    assert.ok(v >= -100 && v <= 0, `williamsR(huge) OOR: ${v}`);
  });

  it("ROC returns null when data is shorter than period+1", () => {
    assert.strictEqual(computeROC([], 12), null);
    assert.strictEqual(computeROC(rising(12), 12), null);
  });

  it("ROC of a flat series is 0, and a zero past-price is guarded (no Infinity)", () => {
    assert.strictEqual(computeROC(fill(13, 100), 12), 0);
    // pastPrice === 0 → guarded to 0, not Infinity
    const v = computeROC([0, ...rising(12, 1, 1)], 12);
    assertFinite(v, "roc(pastZero)");
    assert.strictEqual(v, 0);
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — Beta / Narrow Range / Weekly variants
// ════════════════════════════════════════════════════════════════════

describe("indicators: computeBeta / detectNarrowRange / weekly variants", () => {
  it("beta returns null when there are fewer than 30 aligned points", () => {
    assert.strictEqual(computeBeta([1, 2, 3], [1, 2, 3]), null);
  });

  it("beta returns null when the index has zero variance (flat index)", () => {
    const stock = rising(40, 100, 1);
    const flatIndex = fill(40, 100);
    assert.strictEqual(computeBeta(stock, flatIndex), null);
  });

  it("beta is finite for two correlated normal series", () => {
    const index = rising(60, 100, 1).map((x, i) => x + Math.sin(i) * 2);
    const stock = index.map((x, i) => x * 1.5 + Math.cos(i));
    const v = computeBeta(stock, index);
    if (v !== null) assertFinite(v, "beta(normal)");
  });

  it("detectNarrowRange returns null for fewer than 7 bars", () => {
    assert.strictEqual(detectNarrowRange([1, 2, 3], [1, 2, 3]), null);
  });

  it("detectNarrowRange of a flat series is finite with boolean flags", () => {
    const flat = fill(10, 100);
    const nr = detectNarrowRange(flat, flat)!;
    assert.ok(nr !== null);
    assertFinite(nr.currentRange, "nr.currentRange");
    assert.strictEqual(typeof nr.nr4, "boolean");
    assert.strictEqual(typeof nr.nr7, "boolean");
  });

  it("toWeekly of empty/short series stays finite (no NaN), and weekly SMA of [] is 0", () => {
    assert.deepStrictEqual(toWeekly([]), []);
    assert.strictEqual(weeklySMA([], 5), 0);
    const wk = toWeekly(rising(20, 100, 1));
    for (const v of wk) assertFinite(v, "toWeekly(rising)");
  });

  it("weekly SMA/EMA/RSI are finite for a sufficiently long daily series", () => {
    const daily = wiggly(200);
    assertFinite(weeklySMA(daily, 5), "weeklySMA");
    assertFinite(weeklyEMA(daily, 5), "weeklyEMA");
    const r = weeklyRSI(daily, 14);
    assertFinite(r, "weeklyRSI");
    assert.ok(r >= 0 && r <= 100, `weeklyRSI OOR: ${r}`);
  });
});

// ════════════════════════════════════════════════════════════════════
// INDICATORS — evaluateRule (strategy rule dispatcher)
// ════════════════════════════════════════════════════════════════════

describe("indicators: evaluateRule", () => {
  it("an unknown indicator returns a non-throwing, finite, not-met result", () => {
    const rule: StrategyRule = {
      indicator: "no_such_indicator",
      condition: "above",
    };
    const res = evaluateRule(rule, rising(60), undefined, undefined, undefined);
    assert.strictEqual(res.met, false);
    assertFinite(res.value, "evaluateRule(unknown).value");
    assert.match(res.detail, /Unknown indicator/);
  });

  it("RSI rule on a flat series produces a finite value and boolean met", () => {
    const rule: StrategyRule = {
      indicator: "rsi",
      condition: "above",
      value: 50,
    };
    const res = evaluateRule(rule, fill(40, 100));
    assertFinite(res.value, "evaluateRule(rsi).value");
    assert.strictEqual(typeof res.met, "boolean");
  });

  it("HLC-requiring rules degrade gracefully (not met) when highs/lows are missing", () => {
    const cci: StrategyRule = {
      indicator: "cci",
      condition: "above",
      value: 100,
    };
    const res = evaluateRule(cci, rising(40));
    assert.strictEqual(res.met, false);
    assertFinite(res.value, "evaluateRule(cci no-hlc).value");
  });

  it("volume rule with insufficient volume data degrades gracefully", () => {
    const vol: StrategyRule = { indicator: "volume", condition: "above" };
    const res = evaluateRule(vol, rising(40), [1, 2, 3]);
    assert.strictEqual(res.met, false);
    assertFinite(res.value, "evaluateRule(volume).value");
  });
});

// ════════════════════════════════════════════════════════════════════
// CANDLESTICK PATTERN DETECTOR
// ════════════════════════════════════════════════════════════════════

describe("candlestick-patterns: detectCandlestickPatterns", () => {
  it("returns [] for empty input", () => {
    assert.deepStrictEqual(detectCandlestickPatterns([], [], [], []), []);
  });

  it("returns [] for a single flat bar (zero range)", () => {
    assert.deepStrictEqual(
      detectCandlestickPatterns([100], [100], [100], [100]),
      []
    );
  });

  it("returns [] when array lengths are mismatched (defensive guard)", () => {
    assert.deepStrictEqual(
      detectCandlestickPatterns([1, 2], [1], [1, 2], [1, 2]),
      []
    );
  });

  it("all-equal OHLC across many bars yields no patterns (every range is 0)", () => {
    const n = 30;
    const flat = fill(n, 100);
    assert.deepStrictEqual(
      detectCandlestickPatterns(flat, flat, flat, flat),
      []
    );
  });

  it("a clean doji bar is detected as a doji-family pattern", () => {
    const opens = [100, 100];
    const highs = [100, 105];
    const lows = [100, 95];
    const closes = [100, 100]; // open == close, with range → doji
    const out = detectCandlestickPatterns(opens, highs, lows, closes);
    assert.ok(out.length >= 1);
    assert.ok(
      out.some((p) => /Doji/.test(p.pattern)),
      "expected a Doji pattern"
    );
  });

  it("every detected pattern has confidence in [0,100] and a valid in-range barIndex/type", () => {
    const closes = wiggly(200);
    const opens = closes.map((c, i) => c - (i % 2 === 0 ? 1 : -1));
    const highs = closes.map((c, i) => Math.max(opens[i]!, c) + 3);
    const lows = closes.map((c, i) => Math.min(opens[i]!, c) - 3);
    const out: CandlestickPattern[] = detectCandlestickPatterns(
      opens,
      highs,
      lows,
      closes,
      30
    );
    assert.ok(out.length > 0, "expected some patterns on a wiggly series");
    for (const p of out) {
      assert.ok(
        p.confidence >= 0 && p.confidence <= 100,
        `confidence OOR: ${p.confidence} (${p.pattern})`
      );
      assert.ok(
        Number.isInteger(p.confidence),
        `confidence not integer: ${p.confidence}`
      );
      assert.ok(
        p.barIndex >= 0 && p.barIndex < closes.length,
        `barIndex OOR: ${p.barIndex}`
      );
      assert.ok(
        [1, 2, 3].includes(p.barsUsed),
        `barsUsed invalid: ${p.barsUsed}`
      );
      assert.ok(
        ["bullish", "bearish", "neutral"].includes(p.type),
        `type invalid: ${p.type}`
      );
    }
  });

  it("results are sorted by barIndex descending", () => {
    const closes = wiggly(120);
    const opens = closes.map((c, i) => c - (i % 2 === 0 ? 1 : -1));
    const highs = closes.map((c, i) => Math.max(opens[i]!, c) + 3);
    const lows = closes.map((c, i) => Math.min(opens[i]!, c) - 3);
    const out = detectCandlestickPatterns(opens, highs, lows, closes, 40);
    for (let i = 1; i < out.length; i++) {
      assert.ok(
        out[i - 1]!.barIndex >= out[i]!.barIndex,
        "not sorted by barIndex desc"
      );
    }
  });

  it("handles a huge series without throwing and with bounded confidences", () => {
    const closes = wiggly(3000);
    const opens = closes.map((c) => c - 0.5);
    const highs = closes.map((c) => c + 2);
    const lows = closes.map((c) => c - 2);
    const out = detectCandlestickPatterns(opens, highs, lows, closes, 20);
    for (const p of out) {
      assert.ok(
        p.confidence >= 0 && p.confidence <= 100,
        `huge confidence OOR: ${p.confidence}`
      );
    }
  });

  it("gaps between bars do not crash detection", () => {
    // Bar 2 gaps far above bar 1; bar 3 gaps far below — should not throw.
    const opens = [100, 150, 60, 61, 62];
    const highs = [101, 155, 65, 66, 67];
    const lows = [99, 149, 59, 60, 61];
    const closes = [100, 152, 61, 62, 63];
    const out = detectCandlestickPatterns(opens, highs, lows, closes);
    for (const p of out) {
      assert.ok(p.confidence >= 0 && p.confidence <= 100);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// CHART PATTERN DETECTOR
// ════════════════════════════════════════════════════════════════════

describe("chart-patterns: findPeaksAndTroughs", () => {
  it("returns [] when series is too short for the sensitivity window", () => {
    assert.deepStrictEqual(findPeaksAndTroughs([1, 2, 3], 5), []);
    assert.deepStrictEqual(findPeaksAndTroughs([], 5), []);
  });

  it("returns [] for a perfectly flat series (no strict peaks/troughs)", () => {
    assert.deepStrictEqual(findPeaksAndTroughs(fill(50, 100), 5), []);
  });

  it("finds a clear peak and a clear trough with correct kind and finite values", () => {
    // sensitivity 2 window; build an up-down-up shape
    const prices = [1, 2, 3, 10, 3, 2, 1, 2, 3, 0, 3, 2, 1];
    const pt = findPeaksAndTroughs(prices, 2);
    for (const e of pt) {
      assertFinite(e.value, "peak/trough value");
      assert.ok(e.index >= 0 && e.index < prices.length);
      assert.ok(e.kind === "peak" || e.kind === "trough");
    }
    assert.ok(
      pt.some((e) => e.kind === "peak"),
      "expected at least one peak"
    );
    assert.ok(
      pt.some((e) => e.kind === "trough"),
      "expected at least one trough"
    );
  });
});

describe("chart-patterns: detectChartPatterns", () => {
  it("returns [] when fewer than 20 bars are provided (insufficient data)", () => {
    assert.deepStrictEqual(
      detectChartPatterns([1, 2, 3], [1, 2, 3], [1, 2, 3]),
      []
    );
    assert.deepStrictEqual(
      detectChartPatterns(rising(19), rising(19), rising(19)),
      []
    );
  });

  it("returns [] when highs/lows lengths mismatch prices", () => {
    assert.deepStrictEqual(
      detectChartPatterns(fill(30, 100), fill(29, 100), fill(30, 100)),
      []
    );
  });

  it("returns [] for a perfectly flat series (no peaks/troughs to match)", () => {
    assert.deepStrictEqual(
      detectChartPatterns(fill(100, 100), fill(100, 100), fill(100, 100)),
      []
    );
  });

  it("ignores volumes whose length mismatches prices (no crash, still detects)", () => {
    const series = wiggly(150);
    const out = detectChartPatterns(
      series,
      series.map((x) => x + 1),
      series.map((x) => x - 1),
      [1, 2, 3] // wrong length → must be ignored, not throw
    );
    assert.ok(Array.isArray(out));
    for (const p of out) assert.ok(p.confidence >= 0 && p.confidence <= 100);
  });

  it("every detected pattern has bounded confidence and finite levels/targets", () => {
    const series = wiggly(150);
    const out: ChartPattern[] = detectChartPatterns(
      series,
      series.map((x) => x + 1),
      series.map((x) => x - 1),
      series.map((_, i) => 1000 + (i % 11) * 80)
    );
    for (const p of out) {
      assert.ok(
        p.confidence >= 0 && p.confidence <= 100,
        `confidence OOR: ${p.confidence} (${p.pattern})`
      );
      assert.ok(
        p.startIndex >= 0 && p.startIndex < series.length,
        `startIndex OOR: ${p.startIndex}`
      );
      assert.ok(
        p.endIndex >= 0 && p.endIndex < series.length,
        `endIndex OOR: ${p.endIndex}`
      );
      assert.ok(
        p.endIndex >= p.startIndex,
        `endIndex < startIndex (${p.endIndex} < ${p.startIndex})`
      );
      assert.ok(
        ["bullish", "bearish", "neutral"].includes(p.type),
        `type invalid: ${p.type}`
      );
      if (p.breakoutTarget !== undefined)
        assertFinite(p.breakoutTarget, "breakoutTarget");
      if (p.support !== undefined) assertFinite(p.support, "support");
      if (p.resistance !== undefined) assertFinite(p.resistance, "resistance");
    }
  });

  it("results are sorted by confidence descending", () => {
    const series = wiggly(180);
    const out = detectChartPatterns(
      series,
      series.map((x) => x + 1),
      series.map((x) => x - 1)
    );
    for (let i = 1; i < out.length; i++) {
      assert.ok(
        out[i - 1]!.confidence >= out[i]!.confidence,
        "not sorted by confidence desc"
      );
    }
  });

  it("handles a huge series quickly without NaN/Infinity in any output field", () => {
    const series = Array.from(
      { length: 2000 },
      (_, i) => 100 + Math.sin(i * 0.05) * 20 + Math.cos(i * 0.13) * 10
    );
    const out = detectChartPatterns(
      series,
      series.map((x) => x + 1),
      series.map((x) => x - 1)
    );
    for (const p of out) {
      assert.ok(
        p.confidence >= 0 && p.confidence <= 100,
        `huge confidence OOR: ${p.confidence}`
      );
      if (p.breakoutTarget !== undefined)
        assertFinite(p.breakoutTarget, "huge breakoutTarget");
      if (p.support !== undefined) assertFinite(p.support, "huge support");
      if (p.resistance !== undefined)
        assertFinite(p.resistance, "huge resistance");
    }
  });
});
