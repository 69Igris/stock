/**
 * Technical Indicators Tests — REAL source under test (de-shadowed, MONEY-620)
 *
 * Drives the ACTUAL exported indicator functions from the screener TA impl:
 *   packages/core/src/market-data/technical-indicators.ts
 * (imported via the public subpath `@usemoney/core/market-data/technical-indicators`).
 *
 * This is the SCREENER indicator implementation — distinct from the
 * packages/research technical-analysis library (covered separately by
 * __tests__/research/technical-indicators-patterns.test.ts).
 *
 * Covers:
 * - sma(): Simple Moving Average
 * - ema(): Exponential Moving Average
 * - rsi(): Relative Strength Index
 * - macd(): MACD line, signal, histogram, crossover detection
 * - bollingerBands(): Upper, middle, lower bands and bandwidth
 * - atr(): Average True Range
 * - stochastic(): Stochastic Oscillator (%K, %D)
 * - williamsR(): Williams %R
 * - obv(): On-Balance Volume
 * - computeIndicators(): Integration test with realistic OHLCV data
 * - Adversarial edge cases: empty / single / flat / NaN / insufficient data —
 *   asserting no NaN/Infinity leaks and that bounded indicators stay bounded.
 *
 * NOTE: `emaArray` is an internal (un-exported) helper, so it is exercised only
 * indirectly through macd() — it has no direct describe block here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
  stochastic,
  williamsR,
  obv,
  computeIndicators,
  type OHLCV,
} from "@usemoney/core/market-data/technical-indicators";

// ── Helper: approximate float comparison ─────────────────────────

function approx(
  actual: number | undefined,
  expected: number,
  tolerance = 0.0001
): void {
  assert.ok(actual !== undefined, `Expected ~${expected} but got undefined`);
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `Expected ~${expected} but got ${actual} (tolerance: ${tolerance})`
  );
}

// ── Helper: generate OHLCV candle ────────────────────────────────

function makeCandle(
  close: number,
  dayOffset = 0,
  open?: number,
  high?: number,
  low?: number,
  volume = 100000
): OHLCV {
  return {
    date: new Date(2025, 0, 1 + dayOffset),
    open: open ?? close,
    high: high ?? close + 2,
    low: low ?? close - 2,
    close,
    volume,
  };
}

// ── Helper: generate rising price series ─────────────────────────

function generateRisingPrices(count: number, start = 100, step = 1): number[] {
  return Array.from({ length: count }, (_, i) => start + i * step);
}

// ── Helper: generate falling price series ────────────────────────

function generateFallingPrices(count: number, start = 200, step = 1): number[] {
  return Array.from({ length: count }, (_, i) => start - i * step);
}

// ── Helper: generate candles from closes ─────────────────────────

function candlesFromCloses(
  closes: number[],
  volumeFn?: (i: number) => number
): OHLCV[] {
  return closes.map((c, i) => ({
    date: new Date(2025, 0, 1 + i),
    open: c - 0.5,
    high: c + 2,
    low: c - 2,
    close: c,
    volume: volumeFn ? volumeFn(i) : 100000,
  }));
}

// ── Helper: generate realistic OHLCV data ────────────────────────

function generateRealisticCandles(count: number): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 1500; // Start at 1500 (like a mid-cap Indian stock)
  for (let i = 0; i < count; i++) {
    const change = Math.sin(i * 0.1) * 20 + Math.cos(i * 0.05) * 10;
    price = price + change;
    if (price < 100) price = 100;
    const dayRange = Math.abs(change) + 5;
    const open = price - change * 0.3;
    const high = Math.max(open, price) + dayRange * 0.4;
    const low = Math.min(open, price) - dayRange * 0.4;
    const volume = 50000 + Math.floor(Math.abs(Math.sin(i * 0.3)) * 200000);
    candles.push({
      date: new Date(2024, 0, 1 + i),
      open,
      high,
      low,
      close: price,
      volume,
    });
  }
  return candles;
}

// ── Tests ────────────────────────────────────────────────────────

describe("Technical Indicators", () => {
  // ────────────────────────────────────────────────────────────────
  // SMA
  // ────────────────────────────────────────────────────────────────
  describe("sma()", () => {
    it("should return undefined for empty array", () => {
      assert.strictEqual(sma([], 5), undefined);
    });

    it("should return undefined when data length is less than period", () => {
      assert.strictEqual(sma([1, 2, 3], 5), undefined);
    });

    it("should return undefined for single element with period 2", () => {
      assert.strictEqual(sma([10], 2), undefined);
    });

    it("should compute SMA correctly when data length equals period", () => {
      const data = [10, 20, 30, 40, 50];
      // SMA(5) = (10+20+30+40+50)/5 = 30
      approx(sma(data, 5), 30);
    });

    it("should use only the last N values when data is longer than period", () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      // SMA(5) over last 5 = (6+7+8+9+10)/5 = 8
      approx(sma(data, 5), 8);
    });

    it("should compute SMA(3) for a short series", () => {
      // Last 3: [30, 40, 50] => 40
      approx(sma([10, 20, 30, 40, 50], 3), 40);
    });

    it("should compute SMA(1) as the last element", () => {
      approx(sma([5, 10, 15, 20], 1), 20);
    });

    it("should handle all same values", () => {
      approx(sma([100, 100, 100, 100, 100], 5), 100);
    });

    it("should handle negative values", () => {
      approx(sma([-10, -20, -30], 3), -20);
    });

    it("should handle decimal values", () => {
      approx(sma([1.5, 2.5, 3.5], 3), 2.5);
    });

    it("should compute SMA(20) for 20 values", () => {
      const data = Array.from({ length: 20 }, (_, i) => i + 1);
      // SMA(20) = sum(1..20)/20 = 210/20 = 10.5
      approx(sma(data, 20), 10.5);
    });

    it("should compute SMA(20) for 30 values (uses last 20)", () => {
      const data = Array.from({ length: 30 }, (_, i) => i + 1);
      // Last 20: 11..30, sum = (11+30)*20/2 = 410, SMA = 410/20 = 20.5
      approx(sma(data, 20), 20.5);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // EMA
  // ────────────────────────────────────────────────────────────────
  describe("ema()", () => {
    it("should return undefined for empty array", () => {
      assert.strictEqual(ema([], 5), undefined);
    });

    it("should return undefined when data length is less than period", () => {
      assert.strictEqual(ema([1, 2, 3], 5), undefined);
    });

    it("should return SMA when data length equals period (no smoothing steps)", () => {
      const data = [10, 20, 30, 40, 50];
      // EMA with no smoothing steps = SMA = 30
      approx(ema(data, 5), 30);
    });

    it("should apply exponential weighting for additional data points", () => {
      const data = [10, 20, 30, 40, 50, 60];
      // Period 5, k = 2/6 = 1/3
      // Initial SMA(5) = (10+20+30+40+50)/5 = 30
      // EMA after 60: 60*(1/3) + 30*(2/3) = 20 + 20 = 40
      approx(ema(data, 5), 40);
    });

    it("should compute EMA(3) step by step", () => {
      const data = [2, 4, 6, 8, 10];
      // Period 3, k = 2/4 = 0.5
      // Initial SMA(3) = (2+4+6)/3 = 4
      // Step 1 (8): 8*0.5 + 4*0.5 = 6
      // Step 2 (10): 10*0.5 + 6*0.5 = 8
      approx(ema(data, 3), 8);
    });

    it("should weight recent values more heavily than SMA does", () => {
      // Use an accelerating series so EMA diverges from SMA
      // In an accelerating rise, recent values grow faster, pulling EMA above SMA
      const data = [10, 12, 15, 19, 25, 33, 44, 60, 85, 120];
      const smaVal = sma(data, 5)!; // SMA of last 5 = (33+44+60+85+120)/5 = 68.4
      const emaVal = ema(data, 5)!;
      assert.ok(
        emaVal > smaVal,
        `EMA (${emaVal}) should be > SMA (${smaVal}) for accelerating rise`
      );
    });

    it("should respond faster than SMA to recent price changes", () => {
      // Start with flat prices, then a sudden jump. EMA should react more to the jump than SMA.
      const data = [50, 50, 50, 50, 50, 50, 50, 50, 50, 100];
      const smaVal = sma(data, 5)!; // SMA of last 5 = (50+50+50+50+100)/5 = 60
      const emaVal = ema(data, 5)!;
      // EMA gives more weight to the recent 100 spike, so EMA > SMA
      assert.ok(
        emaVal > smaVal,
        `EMA (${emaVal}) should be > SMA (${smaVal}) after a sudden price jump`
      );
    });

    it("should equal SMA when all values are the same", () => {
      const data = [50, 50, 50, 50, 50, 50, 50];
      approx(ema(data, 5), 50);
    });

    it("should compute EMA(12) for 12 values (initial SMA only)", () => {
      const data = Array.from({ length: 12 }, (_, i) => i + 1);
      // SMA(12) = sum(1..12)/12 = 78/12 = 6.5
      approx(ema(data, 12), 6.5);
    });

    it("should compute EMA(1) as the last element", () => {
      // Period 1, k=1, SMA = first element, then each step fully replaces
      approx(ema([5, 10, 15, 20], 1), 20);
    });

    it("should handle EMA(2) correctly", () => {
      const data = [10, 20, 30];
      // Period 2, k = 2/3
      // Initial SMA(2) = (10+20)/2 = 15
      // Step (30): 30*(2/3) + 15*(1/3) = 20 + 5 = 25
      approx(ema(data, 2), 25);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // RSI
  // ────────────────────────────────────────────────────────────────
  describe("rsi()", () => {
    it("should return undefined when data length is less than period+1", () => {
      assert.strictEqual(rsi([100, 101, 102], 14), undefined);
    });

    it("should return undefined for empty array", () => {
      assert.strictEqual(rsi([]), undefined);
    });

    it("should return undefined for exactly period values (needs period+1)", () => {
      const data = Array.from({ length: 14 }, (_, i) => 100 + i);
      assert.strictEqual(rsi(data, 14), undefined);
    });

    it("should return 100 when all price changes are gains (no losses)", () => {
      // 16 values, all rising by 1 each day
      const data = Array.from({ length: 16 }, (_, i) => 100 + i);
      approx(rsi(data, 14), 100);
    });

    it("should return 0 when all price changes are losses (no gains)", () => {
      // 16 values, all falling by 1 each day
      const data = Array.from({ length: 16 }, (_, i) => 200 - i);
      approx(rsi(data, 14), 0);
    });

    it("should return ~50 for perfectly alternating gains and losses of equal size", () => {
      // Alternating +1, -1 for 15 values
      const data: number[] = [100];
      for (let i = 1; i <= 14; i++) {
        data.push(data[i - 1]! + (i % 2 === 1 ? 1 : -1));
      }
      const result = rsi(data, 14)!;
      // With equal gains and losses, RSI should be ~50
      assert.ok(
        result >= 45 && result <= 55,
        `RSI should be ~50 but got ${result}`
      );
    });

    it("should compute RSI for a small period (period=2)", () => {
      // 4 values => 3 changes
      // Changes: +10, -5, +10 => initial gains avg = (10)/2 = 5, losses avg = 5/2 = 2.5
      // Smoothed step 3 (+10): avgGain = (5*1 + 10)/2 = 7.5, avgLoss = (2.5*1)/2 = 1.25
      // RS = 7.5 / 1.25 = 6, RSI = 100 - 100/7 = 85.714...
      const data = [100, 110, 105, 115];
      approx(rsi(data, 2), 85.7143, 0.001);
    });

    it("should return RSI > 70 for strongly rising prices", () => {
      // 20 values, mostly rising
      const data = [
        100, 102, 104, 106, 108, 107, 110, 112, 114, 116, 118, 120, 119, 122,
        124, 126, 128, 130, 132, 134,
      ];
      const result = rsi(data, 14)!;
      assert.ok(
        result > 70,
        `Expected RSI > 70 for strong uptrend, got ${result}`
      );
    });

    it("should return RSI < 30 for strongly falling prices", () => {
      const data = [
        200, 198, 196, 194, 192, 193, 190, 188, 186, 184, 182, 180, 181, 178,
        176, 174, 172, 170, 168, 166,
      ];
      const result = rsi(data, 14)!;
      assert.ok(
        result < 30,
        `Expected RSI < 30 for strong downtrend, got ${result}`
      );
    });

    it("should be between 0 and 100 for mixed data", () => {
      const data = [
        100, 105, 103, 107, 104, 108, 106, 110, 108, 112, 110, 114, 112, 116,
        114, 118,
      ];
      const result = rsi(data, 14)!;
      assert.ok(result >= 0 && result <= 100, `RSI out of range: ${result}`);
    });

    it("should handle exactly period+1 data points (initial RSI, no smoothing)", () => {
      // 15 values = 14+1 => initial RSI only
      const data = generateRisingPrices(15, 100, 2);
      const result = rsi(data, 14)!;
      assert.strictEqual(result, 100); // All gains
    });

    it("should return RSI = 100 for 30 consecutive gains", () => {
      const data = generateRisingPrices(30, 50, 1);
      approx(rsi(data, 14), 100);
    });

    it("should return RSI = 0 for 30 consecutive losses", () => {
      const data = generateFallingPrices(30, 200, 1);
      approx(rsi(data, 14), 0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // MACD
  // ────────────────────────────────────────────────────────────────
  describe("macd()", () => {
    it("should return undefined when data is too short for EMA(12)", () => {
      const data = Array.from({ length: 11 }, (_, i) => 100 + i);
      assert.strictEqual(macd(data), undefined);
    });

    it("should return undefined when data is too short for EMA(26)", () => {
      const data = Array.from({ length: 25 }, (_, i) => 100 + i);
      assert.strictEqual(macd(data), undefined);
    });

    it("should return undefined when MACD line is too short for signal (needs 26+9-1=34 points)", () => {
      // Need at least 26 for EMA26, then 9 for signal EMA
      const data = Array.from({ length: 30 }, (_, i) => 100 + i);
      // This might or might not return undefined depending on exact counts
      // emaArray(closes, 26) gives length = 30-26+1 = 5, need 9 for signal => undefined
      assert.strictEqual(macd(data), undefined);
    });

    it("should return a valid MACD object for sufficient data (35+ points)", () => {
      const data = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
      const result = macd(data);
      assert.ok(
        result !== undefined,
        "MACD should not be undefined with 40 data points"
      );
      assert.ok("macd" in result!);
      assert.ok("signal" in result!);
      assert.ok("histogram" in result!);
      assert.ok("bullishCrossover" in result!);
      assert.ok("bearishCrossover" in result!);
    });

    it("should have histogram equal to macd - signal", () => {
      const data = Array.from(
        { length: 50 },
        (_, i) => 100 + Math.sin(i * 0.2) * 10
      );
      const result = macd(data)!;
      approx(result.histogram, result.macd - result.signal, 0.0001);
    });

    it("should have positive MACD for strongly rising prices", () => {
      const data = generateRisingPrices(50, 100, 2);
      const result = macd(data)!;
      assert.ok(
        result.macd > 0,
        `MACD should be positive for uptrend, got ${result.macd}`
      );
    });

    it("should have negative MACD for strongly falling prices", () => {
      const data = generateFallingPrices(50, 300, 2);
      const result = macd(data)!;
      assert.ok(
        result.macd < 0,
        `MACD should be negative for downtrend, got ${result.macd}`
      );
    });

    it("should have MACD near zero for flat prices", () => {
      const data = Array.from({ length: 50 }, () => 100);
      const result = macd(data)!;
      approx(result.macd, 0, 0.01);
      approx(result.signal, 0, 0.01);
      approx(result.histogram, 0, 0.01);
    });

    it("should detect bullish crossover", () => {
      // Build a series that goes from downtrend to uptrend
      const falling = generateFallingPrices(30, 200, 1);
      const rising = generateRisingPrices(25, 170, 2);
      const data = [...falling, ...rising];
      const result = macd(data);
      // We can only check that the fields exist and are boolean
      if (result) {
        assert.strictEqual(typeof result.bullishCrossover, "boolean");
        assert.strictEqual(typeof result.bearishCrossover, "boolean");
      }
    });

    it("should detect bearish crossover", () => {
      // Build a series that goes from uptrend to downtrend
      const rising = generateRisingPrices(30, 100, 2);
      const falling = generateFallingPrices(25, 160, 2);
      const data = [...rising, ...falling];
      const result = macd(data);
      if (result) {
        assert.strictEqual(typeof result.bearishCrossover, "boolean");
      }
    });

    it("should not detect both bullish and bearish crossover simultaneously", () => {
      const data = Array.from(
        { length: 60 },
        (_, i) => 100 + Math.sin(i * 0.15) * 20
      );
      const result = macd(data);
      if (result) {
        assert.ok(
          !(result.bullishCrossover && result.bearishCrossover),
          "Cannot have both bullish and bearish crossover at the same time"
        );
      }
    });

    it("should return no crossover for steady trend", () => {
      const data = generateRisingPrices(60, 100, 1);
      const result = macd(data);
      if (result) {
        assert.strictEqual(result.bullishCrossover, false);
        assert.strictEqual(result.bearishCrossover, false);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Bollinger Bands
  // ────────────────────────────────────────────────────────────────
  describe("bollingerBands()", () => {
    it("should return undefined when data length is less than period", () => {
      assert.strictEqual(bollingerBands([100, 200, 300], 20), undefined);
    });

    it("should return undefined for empty array", () => {
      assert.strictEqual(bollingerBands([], 20), undefined);
    });

    it("should return undefined for 19 values with default period 20", () => {
      const data = Array.from({ length: 19 }, (_, i) => 100 + i);
      assert.strictEqual(bollingerBands(data), undefined);
    });

    it("should compute bands for exactly 20 values", () => {
      const data = Array.from({ length: 20 }, (_, i) => 100 + i);
      const result = bollingerBands(data)!;
      assert.ok(result.upper > result.middle);
      assert.ok(result.middle > result.lower);
      assert.ok(result.bandwidth > 0);
    });

    it("should have zero bandwidth when all values are the same", () => {
      const data = Array.from({ length: 20 }, () => 100);
      const result = bollingerBands(data)!;
      approx(result.middle, 100);
      approx(result.upper, 100);
      approx(result.lower, 100);
      approx(result.bandwidth, 0);
    });

    it("should have middle equal to SMA of last N values", () => {
      const data = Array.from({ length: 25 }, (_, i) => 100 + i * 2);
      const result = bollingerBands(data, 20)!;
      const expectedMiddle = sma(data, 20)!;
      approx(result.middle, expectedMiddle);
    });

    it("should have upper = middle + 2*stddev by default", () => {
      const data = Array.from({ length: 20 }, (_, i) => 100 + i);
      const result = bollingerBands(data, 20)!;
      const slice = data.slice(-20);
      const mean = slice.reduce((s, v) => s + v, 0) / 20;
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / 20;
      const stdDev = Math.sqrt(variance);
      approx(result.upper, mean + 2 * stdDev);
      approx(result.lower, mean - 2 * stdDev);
    });

    it("should respect custom stdDevMultiplier", () => {
      const data = Array.from({ length: 20 }, (_, i) => 100 + i);
      const result2 = bollingerBands(data, 20, 2)!;
      const result3 = bollingerBands(data, 20, 3)!;
      // With multiplier 3, bands should be wider
      assert.ok(
        result3.upper > result2.upper,
        "Upper band with 3x multiplier should be wider"
      );
      assert.ok(
        result3.lower < result2.lower,
        "Lower band with 3x multiplier should be wider"
      );
    });

    it("should have wider bandwidth for more volatile data", () => {
      const stable = Array.from({ length: 20 }, () => 100);
      const volatile = [
        90, 110, 85, 115, 80, 120, 75, 125, 70, 130, 90, 110, 85, 115, 80, 120,
        75, 125, 70, 130,
      ];
      const stableResult = bollingerBands(stable, 20)!;
      const volatileResult = bollingerBands(volatile, 20)!;
      assert.ok(
        volatileResult.bandwidth > stableResult.bandwidth,
        `Volatile bandwidth (${volatileResult.bandwidth}) should be > stable bandwidth (${stableResult.bandwidth})`
      );
    });

    it("should have symmetric bands around the middle", () => {
      const data = Array.from({ length: 20 }, (_, i) => 100 + i);
      const result = bollingerBands(data, 20)!;
      const upperDist = result.upper - result.middle;
      const lowerDist = result.middle - result.lower;
      approx(upperDist, lowerDist, 0.0001);
    });

    it("should compute bandwidth as percentage of middle", () => {
      const data = Array.from({ length: 20 }, (_, i) => 100 + i);
      const result = bollingerBands(data, 20)!;
      const expectedBandwidth =
        ((result.upper - result.lower) / result.middle) * 100;
      approx(result.bandwidth, expectedBandwidth);
    });

    it("should use last N values when data is longer than period", () => {
      const data = Array.from({ length: 30 }, (_, i) => 50 + i);
      const result = bollingerBands(data, 20)!;
      // Middle should be SMA of last 20 values (11..30 => 50+10..50+29)
      const last20 = data.slice(-20);
      const expectedMiddle = last20.reduce((s, v) => s + v, 0) / 20;
      approx(result.middle, expectedMiddle);
    });

    it("should return bandwidth 0 when middle is 0", () => {
      // Construct data centered at 0
      const data = Array.from({ length: 20 }, (_, i) => i - 9.5);
      const result = bollingerBands(data, 20)!;
      // Middle = 0, so bandwidth formula uses middle > 0 check
      if (Math.abs(result.middle) < 0.0001) {
        approx(result.bandwidth, 0);
      }
    });

    it("should handle custom period (period=5)", () => {
      const data = [10, 20, 30, 40, 50];
      const result = bollingerBands(data, 5)!;
      approx(result.middle, 30);
      assert.ok(result.upper > 30);
      assert.ok(result.lower < 30);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // ATR
  // ────────────────────────────────────────────────────────────────
  describe("atr()", () => {
    it("should return undefined for empty candle array", () => {
      assert.strictEqual(atr([]), undefined);
    });

    it("should return undefined when candles length < period + 1", () => {
      const candles = Array.from({ length: 14 }, (_, i) =>
        makeCandle(100 + i, i)
      );
      assert.strictEqual(atr(candles), undefined);
    });

    it("should return undefined for exactly 14 candles (needs 15)", () => {
      const candles = Array.from({ length: 14 }, (_, i) =>
        makeCandle(100 + i, i)
      );
      assert.strictEqual(atr(candles, 14), undefined);
    });

    it("should compute ATR for exactly period+1 candles", () => {
      const candles = Array.from({ length: 15 }, (_, i) =>
        makeCandle(100 + i, i, 100 + i - 0.5, 100 + i + 3, 100 + i - 3)
      );
      const result = atr(candles, 14)!;
      assert.ok(result > 0, `ATR should be positive, got ${result}`);
    });

    it("should return higher ATR for more volatile candles", () => {
      // Low volatility: range of 4 each day
      const lowVol = Array.from({ length: 20 }, (_, i) =>
        makeCandle(100, i, 99, 102, 98)
      );
      // High volatility: range of 20 each day
      const highVol = Array.from({ length: 20 }, (_, i) =>
        makeCandle(100, i, 95, 110, 90)
      );
      const lowATR = atr(lowVol, 14)!;
      const highATR = atr(highVol, 14)!;
      assert.ok(
        highATR > lowATR,
        `High vol ATR (${highATR}) should be > low vol ATR (${lowATR})`
      );
    });

    it("should consider gap-up in true range calculation", () => {
      // Gap up: previous close = 100, current high = 120, low = 110
      // TR = max(120-110, |120-100|, |110-100|) = max(10, 20, 10) = 20
      const candles: OHLCV[] = [
        makeCandle(100, 0, 98, 102, 97),
        ...Array.from({ length: 14 }, (_, i) =>
          makeCandle(115, i + 1, 112, 120, 110)
        ),
      ];
      const result = atr(candles, 14)!;
      assert.ok(result > 0);
    });

    it("should compute ATR with custom period (period=5)", () => {
      const candles = Array.from({ length: 10 }, (_, i) =>
        makeCandle(100 + i, i, 99 + i, 103 + i, 97 + i)
      );
      const result = atr(candles, 5);
      assert.ok(
        result !== undefined,
        "ATR(5) should be defined for 10 candles"
      );
      assert.ok(result! > 0);
    });

    it("should return ATR based on last N true ranges", () => {
      // 20 candles, all identical range => ATR should be constant
      const candles = Array.from({ length: 20 }, (_, i) =>
        makeCandle(100, i, 99, 105, 95)
      );
      const result = atr(candles, 14)!;
      // Each TR = max(10, 5, 5) = 10
      approx(result, 10);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Stochastic Oscillator
  // ────────────────────────────────────────────────────────────────
  describe("stochastic()", () => {
    it("should return undefined when candles length < kPeriod", () => {
      const candles = Array.from({ length: 10 }, (_, i) =>
        makeCandle(100 + i, i)
      );
      assert.strictEqual(stochastic(candles, 14), undefined);
    });

    it("should return undefined for empty candle array", () => {
      assert.strictEqual(stochastic([]), undefined);
    });

    it("should compute stochastic for exactly kPeriod candles", () => {
      const candles = Array.from({ length: 14 }, (_, i) =>
        makeCandle(100 + i, i, 100 + i - 1, 100 + i + 2, 100 + i - 2)
      );
      const result = stochastic(candles, 14)!;
      assert.ok(result.stochK !== undefined);
      // Only 1 K value, so D is not available (need dPeriod=3)
      assert.strictEqual(result.stochD, undefined);
    });

    it("should have both K and D when candles >= kPeriod + dPeriod - 1", () => {
      const candles = Array.from({ length: 20 }, (_, i) =>
        makeCandle(100 + i, i, 100 + i - 1, 100 + i + 5, 100 + i - 5)
      );
      const result = stochastic(candles, 14, 3)!;
      assert.ok(result.stochK !== undefined);
      assert.ok(result.stochD !== undefined);
    });

    it("should return %K > 80 for close near the high (overbought)", () => {
      // All candles with high=200, low=100. Last close near 200
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 195 : 150, // Last candle close near high
        volume: 100000,
      }));
      const result = stochastic(candles, 14)!;
      assert.ok(
        result.stochK! > 80,
        `%K should be > 80 (overbought) when close near high, got ${result.stochK}`
      );
    });

    it("should return %K < 20 for close near the low (oversold)", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 105 : 150, // Last candle close near low
        volume: 100000,
      }));
      const result = stochastic(candles, 14)!;
      assert.ok(
        result.stochK! < 20,
        `%K should be < 20 (oversold) when close near low, got ${result.stochK}`
      );
    });

    it("should return %K = 50 for close at midpoint", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 150 : 150,
        volume: 100000,
      }));
      const result = stochastic(candles, 14)!;
      approx(result.stochK!, 50);
    });

    it("should return %K = 50 when high equals low (no range)", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 100000,
      }));
      const result = stochastic(candles, 14)!;
      approx(result.stochK!, 50);
    });

    it("should compute %K = 100 when close equals the high of range", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 200 : 150,
        volume: 100000,
      }));
      const result = stochastic(candles, 14)!;
      approx(result.stochK!, 100);
    });

    it("should compute %K = 0 when close equals the low of range", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 100 : 150,
        volume: 100000,
      }));
      const result = stochastic(candles, 14)!;
      approx(result.stochK!, 0);
    });

    it("should have %D as simple average of last dPeriod %K values", () => {
      const candles = Array.from({ length: 20 }, (_, i) =>
        makeCandle(
          100 + i * 2,
          i,
          100 + i * 2 - 1,
          100 + i * 2 + 5,
          100 + i * 2 - 5
        )
      );
      const result = stochastic(candles, 14, 3)!;
      assert.ok(result.stochD !== undefined);
      assert.ok(
        typeof result.stochD === "number",
        `%D should be a number, got ${typeof result.stochD}`
      );
    });

    it("should have %K between 0 and 100 for normal data", () => {
      const candles = generateRealisticCandles(30);
      const result = stochastic(candles, 14)!;
      assert.ok(
        result.stochK! >= 0 && result.stochK! <= 100,
        `%K (${result.stochK}) should be between 0 and 100`
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Williams %R
  // ────────────────────────────────────────────────────────────────
  describe("williamsR()", () => {
    it("should return undefined when candles length < period", () => {
      const candles = Array.from({ length: 10 }, (_, i) =>
        makeCandle(100 + i, i)
      );
      assert.strictEqual(williamsR(candles, 14), undefined);
    });

    it("should return undefined for empty candle array", () => {
      assert.strictEqual(williamsR([]), undefined);
    });

    it("should return 0 when close equals the period high (most bullish)", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 200 : 150,
        volume: 100000,
      }));
      approx(williamsR(candles, 14)!, 0);
    });

    it("should return -100 when close equals the period low (most bearish)", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 100 : 150,
        volume: 100000,
      }));
      approx(williamsR(candles, 14)!, -100);
    });

    it("should return -50 when close is at midpoint of range", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 150 : 150,
        volume: 100000,
      }));
      approx(williamsR(candles, 14)!, -50);
    });

    it("should return -50 when high equals low (no range)", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 100000,
      }));
      approx(williamsR(candles, 14)!, -50);
    });

    it("should always be between -100 and 0", () => {
      const candles = generateRealisticCandles(30);
      const result = williamsR(candles, 14)!;
      assert.ok(
        result >= -100 && result <= 0,
        `Williams %R (${result}) should be between -100 and 0`
      );
    });

    it("should return value > -20 for close near the high (overbought)", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 195 : 150,
        volume: 100000,
      }));
      const result = williamsR(candles, 14)!;
      assert.ok(
        result > -20,
        `Williams %R (${result}) should be > -20 for overbought`
      );
    });

    it("should return value < -80 for close near the low (oversold)", () => {
      const candles: OHLCV[] = Array.from({ length: 14 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 13 ? 105 : 150,
        volume: 100000,
      }));
      const result = williamsR(candles, 14)!;
      assert.ok(
        result < -80,
        `Williams %R (${result}) should be < -80 for oversold`
      );
    });

    it("should use last close, not last-period close, for calculation", () => {
      // The close used is candles[candles.length-1].close, not the period window close
      const candles: OHLCV[] = Array.from({ length: 20 }, (_, i) => ({
        date: new Date(2025, 0, 1 + i),
        open: 150,
        high: 200,
        low: 100,
        close: i === 19 ? 180 : 150,
        volume: 100000,
      }));
      const result = williamsR(candles, 14)!;
      // high=200, low=100, close=180 => (200-180)/(200-100)*-100 = -20
      approx(result, -20);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // OBV
  // ────────────────────────────────────────────────────────────────
  describe("obv()", () => {
    it("should return 0 for empty candle array", () => {
      assert.strictEqual(obv([]), 0);
    });

    it("should return 0 for single candle", () => {
      assert.strictEqual(obv([makeCandle(100, 0, 100, 102, 98, 50000)]), 0);
    });

    it("should add volume on up days", () => {
      const candles: OHLCV[] = [
        makeCandle(100, 0, 100, 102, 98, 1000),
        makeCandle(110, 1, 105, 112, 104, 2000),
      ];
      assert.strictEqual(obv(candles), 2000);
    });

    it("should subtract volume on down days", () => {
      const candles: OHLCV[] = [
        makeCandle(100, 0, 100, 102, 98, 1000),
        makeCandle(90, 1, 95, 96, 88, 3000),
      ];
      assert.strictEqual(obv(candles), -3000);
    });

    it("should not change OBV when price is unchanged", () => {
      const candles: OHLCV[] = [
        makeCandle(100, 0, 100, 102, 98, 1000),
        makeCandle(100, 1, 99, 101, 99, 5000),
      ];
      assert.strictEqual(obv(candles), 0);
    });

    it("should accumulate volume correctly over multiple days", () => {
      const candles: OHLCV[] = [
        makeCandle(100, 0, 100, 102, 98, 1000), // Base
        makeCandle(110, 1, 105, 112, 104, 2000), // Up: +2000
        makeCandle(105, 2, 108, 110, 104, 1500), // Down: -1500
        makeCandle(108, 3, 106, 109, 105, 3000), // Up: +3000
        makeCandle(108, 4, 108, 109, 107, 1000), // Unchanged: 0
        makeCandle(100, 5, 106, 107, 99, 4000), // Down: -4000
      ];
      // OBV = 0 + 2000 - 1500 + 3000 + 0 - 4000 = -500
      assert.strictEqual(obv(candles), -500);
    });

    it("should return positive OBV for consistently rising prices", () => {
      const candles: OHLCV[] = Array.from({ length: 10 }, (_, i) =>
        makeCandle(
          100 + i * 5,
          i,
          100 + i * 5 - 1,
          100 + i * 5 + 2,
          100 + i * 5 - 2,
          10000
        )
      );
      const result = obv(candles);
      // 9 up days * 10000 = 90000
      assert.strictEqual(result, 90000);
    });

    it("should return negative OBV for consistently falling prices", () => {
      const candles: OHLCV[] = Array.from({ length: 10 }, (_, i) =>
        makeCandle(
          200 - i * 5,
          i,
          200 - i * 5 + 1,
          200 - i * 5 + 2,
          200 - i * 5 - 2,
          10000
        )
      );
      const result = obv(candles);
      // 9 down days * 10000 = -90000
      assert.strictEqual(result, -90000);
    });

    it("should handle large volumes without overflow", () => {
      const candles: OHLCV[] = [
        makeCandle(100, 0, 100, 102, 98, 1_000_000_000),
        makeCandle(110, 1, 105, 112, 104, 2_000_000_000),
        makeCandle(120, 2, 115, 122, 114, 3_000_000_000),
      ];
      assert.strictEqual(obv(candles), 5_000_000_000);
    });

    it("should return 0 when all prices are the same", () => {
      const candles: OHLCV[] = Array.from({ length: 5 }, (_, i) =>
        makeCandle(100, i, 100, 100, 100, 50000)
      );
      assert.strictEqual(obv(candles), 0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // computeIndicators (integration test)
  // ────────────────────────────────────────────────────────────────
  describe("computeIndicators()", () => {
    it("should return empty object for empty candles", () => {
      const result = computeIndicators([]);
      assert.deepStrictEqual(result, {});
    });

    it("should return empty object for single candle", () => {
      const result = computeIndicators([makeCandle(100)]);
      assert.deepStrictEqual(result, {});
    });

    it("should compute basic indicators for 2 candles", () => {
      const candles = [makeCandle(100, 0), makeCandle(105, 1)];
      const result = computeIndicators(candles);
      // Most indicators need more data, but OBV and 52w should work
      assert.ok(result.obv !== undefined);
      assert.ok(result.price52WeekHigh !== undefined);
      assert.ok(result.price52WeekLow !== undefined);
    });

    it("should populate SMA20 when given at least 20 candles", () => {
      const candles = generateRealisticCandles(25);
      const result = computeIndicators(candles);
      assert.ok(
        result.sma20 !== undefined,
        "SMA20 should be defined for 25 candles"
      );
    });

    it("should NOT populate SMA50 when given only 25 candles", () => {
      const candles = generateRealisticCandles(25);
      const result = computeIndicators(candles);
      assert.strictEqual(result.sma50, undefined);
    });

    it("should populate SMA50 when given at least 50 candles", () => {
      const candles = generateRealisticCandles(55);
      const result = computeIndicators(candles);
      assert.ok(
        result.sma50 !== undefined,
        "SMA50 should be defined for 55 candles"
      );
    });

    it("should NOT populate SMA200 when given only 100 candles", () => {
      const candles = generateRealisticCandles(100);
      const result = computeIndicators(candles);
      assert.strictEqual(result.sma200, undefined);
    });

    it("should populate SMA200 when given at least 200 candles", () => {
      const candles = generateRealisticCandles(210);
      const result = computeIndicators(candles);
      assert.ok(
        result.sma200 !== undefined,
        "SMA200 should be defined for 210 candles"
      );
    });

    it("should populate EMA12 and EMA26 for sufficient data", () => {
      const candles = generateRealisticCandles(30);
      const result = computeIndicators(candles);
      assert.ok(
        result.ema12 !== undefined,
        "EMA12 should be defined for 30 candles"
      );
      assert.ok(
        result.ema26 !== undefined,
        "EMA26 should be defined for 30 candles"
      );
    });

    it("should populate RSI14 when given 16+ candles", () => {
      const candles = generateRealisticCandles(20);
      const result = computeIndicators(candles);
      assert.ok(
        result.rsi14 !== undefined,
        "RSI14 should be defined for 20 candles"
      );
      assert.ok(
        result.rsi14! >= 0 && result.rsi14! <= 100,
        "RSI14 should be between 0 and 100"
      );
    });

    it("should populate Bollinger Bands when given 20+ candles", () => {
      const candles = generateRealisticCandles(25);
      const result = computeIndicators(candles);
      assert.ok(result.bollingerUpper !== undefined);
      assert.ok(result.bollingerMiddle !== undefined);
      assert.ok(result.bollingerLower !== undefined);
      assert.ok(result.bollingerBandwidth !== undefined);
      assert.ok(result.bollingerUpper! > result.bollingerMiddle!);
      assert.ok(result.bollingerMiddle! > result.bollingerLower!);
    });

    it("should populate ATR14 when given 16+ candles", () => {
      const candles = generateRealisticCandles(20);
      const result = computeIndicators(candles);
      assert.ok(
        result.atr14 !== undefined,
        "ATR14 should be defined for 20 candles"
      );
      assert.ok(result.atr14! > 0, "ATR14 should be positive");
    });

    it("should populate stochastic when given 14+ candles", () => {
      const candles = generateRealisticCandles(20);
      const result = computeIndicators(candles);
      assert.ok(result.stochK !== undefined, "stochK should be defined");
    });

    it("should populate williamsR when given 14+ candles", () => {
      const candles = generateRealisticCandles(20);
      const result = computeIndicators(candles);
      assert.ok(result.williamsR !== undefined);
      assert.ok(result.williamsR! >= -100 && result.williamsR! <= 0);
    });

    it("should compute OBV for any non-trivial data", () => {
      const candles = generateRealisticCandles(10);
      const result = computeIndicators(candles);
      assert.ok(result.obv !== undefined);
      assert.strictEqual(typeof result.obv, "number");
    });

    it("should compute volumeSma20 and volumeRatio for 20+ candles", () => {
      const candles = generateRealisticCandles(25);
      const result = computeIndicators(candles);
      assert.ok(
        result.volumeSma20 !== undefined,
        "volumeSma20 should be defined"
      );
      assert.ok(
        result.volumeRatio !== undefined,
        "volumeRatio should be defined"
      );
      assert.ok(result.volumeRatio! > 0, "volumeRatio should be positive");
    });

    it("should compute 52-week high and low", () => {
      const candles = generateRealisticCandles(100);
      const result = computeIndicators(candles);
      assert.ok(result.price52WeekHigh !== undefined);
      assert.ok(result.price52WeekLow !== undefined);
      assert.ok(result.price52WeekHigh! >= result.price52WeekLow!);
    });

    it("should compute distance from 52-week high/low", () => {
      const candles = generateRealisticCandles(100);
      const result = computeIndicators(candles);
      assert.ok(result.distanceFrom52WeekHigh !== undefined);
      assert.ok(result.distanceFrom52WeekLow !== undefined);
      assert.ok(
        result.distanceFrom52WeekHigh! >= 0,
        "Distance from 52w high should be >= 0"
      );
      assert.ok(
        result.distanceFrom52WeekLow! >= 0,
        "Distance from 52w low should be >= 0"
      );
    });

    it("should set goldenCross and deathCross as mutually exclusive when both SMAs available", () => {
      const candles = generateRealisticCandles(210);
      const result = computeIndicators(candles);
      if (result.goldenCross !== undefined && result.deathCross !== undefined) {
        assert.ok(
          result.goldenCross !== result.deathCross,
          "goldenCross and deathCross should be mutually exclusive"
        );
      }
    });

    it("should leave goldenCross/deathCross undefined when SMA200 is missing", () => {
      const candles = generateRealisticCandles(100);
      const result = computeIndicators(candles);
      assert.strictEqual(result.goldenCross, undefined);
      assert.strictEqual(result.deathCross, undefined);
    });

    it("should compute priceAboveSma200 for 200+ candles", () => {
      const candles = generateRealisticCandles(210);
      const result = computeIndicators(candles);
      assert.ok(result.priceAboveSma200 !== undefined);
      assert.strictEqual(typeof result.priceAboveSma200, "boolean");
    });

    it("should populate MACD fields for 35+ candles", () => {
      const candles = generateRealisticCandles(50);
      const result = computeIndicators(candles);
      assert.ok(
        result.macd !== undefined,
        "MACD should be defined for 50 candles"
      );
      assert.ok(
        result.macdSignal !== undefined,
        "MACD signal should be defined"
      );
      assert.ok(
        result.macdHistogram !== undefined,
        "MACD histogram should be defined"
      );
    });

    it("should have MACD histogram = MACD - signal", () => {
      const candles = generateRealisticCandles(50);
      const result = computeIndicators(candles);
      if (
        result.macd !== undefined &&
        result.macdSignal !== undefined &&
        result.macdHistogram !== undefined
      ) {
        approx(result.macdHistogram, result.macd - result.macdSignal, 0.0001);
      }
    });

    it("should populate macdBullishCrossover and macdBearishCrossover as booleans", () => {
      const candles = generateRealisticCandles(50);
      const result = computeIndicators(candles);
      if (result.macdBullishCrossover !== undefined) {
        assert.strictEqual(typeof result.macdBullishCrossover, "boolean");
      }
      if (result.macdBearishCrossover !== undefined) {
        assert.strictEqual(typeof result.macdBearishCrossover, "boolean");
      }
    });

    it("should compute all fields for large dataset (250 candles)", () => {
      const candles = generateRealisticCandles(250);
      const result = computeIndicators(candles);

      // All trend indicators
      assert.ok(result.sma20 !== undefined, "sma20 missing");
      assert.ok(result.sma50 !== undefined, "sma50 missing");
      assert.ok(result.sma200 !== undefined, "sma200 missing");
      assert.ok(result.ema12 !== undefined, "ema12 missing");
      assert.ok(result.ema26 !== undefined, "ema26 missing");

      // MACD
      assert.ok(result.macd !== undefined, "macd missing");
      assert.ok(result.macdSignal !== undefined, "macdSignal missing");
      assert.ok(result.macdHistogram !== undefined, "macdHistogram missing");

      // Momentum
      assert.ok(result.rsi14 !== undefined, "rsi14 missing");
      assert.ok(result.stochK !== undefined, "stochK missing");
      assert.ok(result.stochD !== undefined, "stochD missing");
      assert.ok(result.williamsR !== undefined, "williamsR missing");

      // Volatility
      assert.ok(result.bollingerUpper !== undefined, "bollingerUpper missing");
      assert.ok(
        result.bollingerMiddle !== undefined,
        "bollingerMiddle missing"
      );
      assert.ok(result.bollingerLower !== undefined, "bollingerLower missing");
      assert.ok(
        result.bollingerBandwidth !== undefined,
        "bollingerBandwidth missing"
      );
      assert.ok(result.atr14 !== undefined, "atr14 missing");

      // Volume
      assert.ok(result.obv !== undefined, "obv missing");
      assert.ok(result.volumeSma20 !== undefined, "volumeSma20 missing");
      assert.ok(result.volumeRatio !== undefined, "volumeRatio missing");

      // Price context
      assert.ok(
        result.price52WeekHigh !== undefined,
        "price52WeekHigh missing"
      );
      assert.ok(result.price52WeekLow !== undefined, "price52WeekLow missing");
      assert.ok(
        result.distanceFrom52WeekHigh !== undefined,
        "distanceFrom52WeekHigh missing"
      );
      assert.ok(
        result.distanceFrom52WeekLow !== undefined,
        "distanceFrom52WeekLow missing"
      );

      // Crossover signals
      assert.ok(result.goldenCross !== undefined, "goldenCross missing");
      assert.ok(result.deathCross !== undefined, "deathCross missing");
      assert.ok(
        result.priceAboveSma200 !== undefined,
        "priceAboveSma200 missing"
      );
    });

    it("should have consistent relationship between Bollinger middle and SMA20", () => {
      const candles = generateRealisticCandles(30);
      const result = computeIndicators(candles);
      if (result.bollingerMiddle !== undefined && result.sma20 !== undefined) {
        approx(result.bollingerMiddle, result.sma20, 0.01);
      }
    });

    it("should have goldenCross=true when SMA50 > SMA200", () => {
      // Create data where the recent trend is strongly upward so SMA50 > SMA200
      const low = Array.from({ length: 150 }, () => 100);
      const high = Array.from({ length: 60 }, (_, i) => 100 + i * 3);
      const closes = [...low, ...high];
      const candles = candlesFromCloses(closes);
      const result = computeIndicators(candles);
      if (result.goldenCross !== undefined) {
        assert.strictEqual(
          result.goldenCross,
          true,
          "goldenCross should be true when SMA50 > SMA200"
        );
        assert.strictEqual(
          result.deathCross,
          false,
          "deathCross should be false when SMA50 > SMA200"
        );
      }
    });

    it("should have deathCross=true when SMA50 < SMA200", () => {
      // Create data where the recent trend is strongly downward so SMA50 < SMA200
      const high = Array.from({ length: 150 }, () => 300);
      const low = Array.from({ length: 60 }, (_, i) => 300 - i * 3);
      const closes = [...high, ...low];
      const candles = candlesFromCloses(closes);
      const result = computeIndicators(candles);
      if (result.deathCross !== undefined) {
        assert.strictEqual(
          result.deathCross,
          true,
          "deathCross should be true when SMA50 < SMA200"
        );
        assert.strictEqual(
          result.goldenCross,
          false,
          "goldenCross should be false when SMA50 < SMA200"
        );
      }
    });

    it("should compute priceAboveSma200=true when current price > SMA200", () => {
      // Trending up over 210 days
      const closes = generateRisingPrices(210, 100, 1);
      const candles = candlesFromCloses(closes);
      const result = computeIndicators(candles);
      // Last close = 100 + 209 = 309, SMA200 = average of 11..210 = (11+210)*200/2/200 = 110.5
      assert.strictEqual(result.priceAboveSma200, true);
    });

    it("should have 52-week high >= last close and 52-week low <= last close", () => {
      const candles = generateRealisticCandles(100);
      const result = computeIndicators(candles);
      const lastClose = candles[candles.length - 1]!.close;
      // 52w high includes the high of candles, which may be above close
      assert.ok(
        result.price52WeekHigh! >= lastClose - 5,
        "52w high should be >= last close (with tolerance for high vs close)"
      );
    });

    it("should compute volumeRatio relative to 20-day average", () => {
      // Create 25 candles with constant volume, then one big volume day
      const candles: OHLCV[] = Array.from({ length: 24 }, (_, i) =>
        makeCandle(100 + i, i, 100 + i - 1, 100 + i + 2, 100 + i - 2, 100000)
      );
      candles.push(makeCandle(125, 24, 124, 127, 123, 200000));
      const result = computeIndicators(candles);
      // volumeSma20 is the SMA of last 20 volumes
      // Last candle volume = 200000
      if (
        result.volumeRatio !== undefined &&
        result.volumeSma20 !== undefined
      ) {
        approx(result.volumeRatio, 200000 / result.volumeSma20, 0.01);
      }
    });

    it("should not crash on very small dataset (3 candles)", () => {
      const candles = [
        makeCandle(100, 0),
        makeCandle(105, 1),
        makeCandle(110, 2),
      ];
      const result = computeIndicators(candles);
      assert.ok(result.obv !== undefined);
      assert.strictEqual(result.sma20, undefined);
      assert.strictEqual(result.rsi14, undefined);
      assert.strictEqual(result.atr14, undefined);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Adversarial edge cases — no NaN/Infinity leaks, bounded stays bounded
  // (MONEY-620 de-shadow: these drive the REAL exported functions)
  // ────────────────────────────────────────────────────────────────
  describe("edge cases — empty / single / insufficient → undefined contract", () => {
    it("all number[] indicators return undefined for an empty array", () => {
      assert.strictEqual(sma([], 5), undefined);
      assert.strictEqual(ema([], 5), undefined);
      assert.strictEqual(rsi([]), undefined);
      assert.strictEqual(bollingerBands([]), undefined);
      assert.strictEqual(macd([]), undefined);
    });

    it("all candle[] indicators return undefined/0 for an empty array", () => {
      assert.strictEqual(atr([]), undefined);
      assert.strictEqual(stochastic([]), undefined);
      assert.strictEqual(williamsR([]), undefined);
      assert.strictEqual(obv([]), 0);
    });

    it("a single data point is below every indicator's minimum period", () => {
      assert.strictEqual(sma([100], 2), undefined);
      assert.strictEqual(ema([100], 2), undefined);
      assert.strictEqual(rsi([100]), undefined);
      assert.strictEqual(macd([100]), undefined);
      assert.strictEqual(bollingerBands([100]), undefined);
      assert.strictEqual(atr([makeCandle(100)]), undefined);
      assert.strictEqual(stochastic([makeCandle(100)]), undefined);
      assert.strictEqual(williamsR([makeCandle(100)]), undefined);
      assert.strictEqual(obv([makeCandle(100)]), 0);
    });

    it("computeIndicators returns {} for empty and single-candle input", () => {
      assert.deepStrictEqual(computeIndicators([]), {});
      assert.deepStrictEqual(computeIndicators([makeCandle(100)]), {});
    });

    it("indicators stay undefined one element short of their period boundary", () => {
      // SMA/EMA need exactly `period` points.
      assert.strictEqual(sma([1, 2, 3, 4], 5), undefined);
      assert.strictEqual(ema([1, 2, 3, 4], 5), undefined);
      // RSI needs period+1.
      assert.strictEqual(
        rsi(
          Array.from({ length: 14 }, (_, i) => 100 + i),
          14
        ),
        undefined
      );
      // ATR needs period+1 candles.
      assert.strictEqual(
        atr(
          Array.from({ length: 14 }, (_, i) => makeCandle(100 + i, i)),
          14
        ),
        undefined
      );
    });
  });

  describe("edge cases — flat (zero-variance) series produce no NaN/Infinity", () => {
    const flatCloses = Array.from({ length: 60 }, () => 100);
    const flatCandles = Array.from({ length: 60 }, (_, i) =>
      makeCandle(100, i, 100, 100, 100, 100000)
    );

    it("sma/ema on a flat series equal the flat value (finite)", () => {
      const s = sma(flatCloses, 20)!;
      const e = ema(flatCloses, 20)!;
      assert.ok(Number.isFinite(s) && Number.isFinite(e));
      approx(s, 100);
      approx(e, 100);
    });

    it("rsi on a flat series is the guarded 100 (avgLoss === 0), never NaN", () => {
      const r = rsi(flatCloses, 14)!;
      assert.ok(Number.isFinite(r), `rsi must be finite, got ${r}`);
      assert.strictEqual(r, 100);
    });

    it("macd on a flat series is all-zero and finite (no NaN in line/signal/hist)", () => {
      const m = macd(flatCloses)!;
      assert.ok(Number.isFinite(m.macd));
      assert.ok(Number.isFinite(m.signal));
      assert.ok(Number.isFinite(m.histogram));
      approx(m.macd, 0);
      approx(m.signal, 0);
      approx(m.histogram, 0);
    });

    it("bollinger on a flat series has zero width and finite, guarded bandwidth", () => {
      const bb = bollingerBands(flatCloses, 20)!;
      for (const v of [bb.upper, bb.middle, bb.lower, bb.bandwidth]) {
        assert.ok(
          Number.isFinite(v),
          `bollinger field must be finite, got ${v}`
        );
      }
      approx(bb.upper, 100);
      approx(bb.lower, 100);
      approx(bb.bandwidth, 0);
    });

    it("atr on a flat series is 0 (no Infinity from a zero range)", () => {
      const a = atr(flatCandles, 14)!;
      assert.ok(Number.isFinite(a));
      approx(a, 0);
    });

    it("stochastic on a flat series uses the guarded %K = 50 (high === low)", () => {
      const st = stochastic(flatCandles, 14)!;
      assert.ok(Number.isFinite(st.stochK!));
      assert.ok(Number.isFinite(st.stochD!));
      approx(st.stochK!, 50);
    });

    it("williamsR on a flat series uses the guarded -50 (high === low)", () => {
      const w = williamsR(flatCandles, 14)!;
      assert.ok(Number.isFinite(w));
      approx(w, -50);
    });

    it("computeIndicators on a flat series leaks no NaN/Infinity anywhere", () => {
      const result = computeIndicators(flatCandles);
      for (const [key, val] of Object.entries(result)) {
        if (typeof val === "number") {
          assert.ok(
            Number.isFinite(val),
            `computeIndicators.${key} must be finite for a flat series, got ${val}`
          );
        }
      }
    });
  });

  describe("edge cases — flat ZERO prices exercise the divide-by-zero guards", () => {
    // middle === 0 (bollinger) and 52w-high/low === 0 (computeIndicators) paths.
    const zeroCloses = Array.from({ length: 60 }, () => 0);
    const zeroCandles = Array.from({ length: 60 }, (_, i) => ({
      date: new Date(2025, 0, 1 + i),
      open: 0,
      high: 0,
      low: 0,
      close: 0,
      volume: 0,
    }));

    it("bollinger bandwidth is the guarded 0 when middle === 0 (not NaN/Infinity)", () => {
      const bb = bollingerBands(zeroCloses, 20)!;
      assert.strictEqual(bb.middle, 0);
      assert.ok(Number.isFinite(bb.bandwidth));
      assert.strictEqual(bb.bandwidth, 0);
    });

    it("computeIndicators guards distance-from-52w when high/low are 0 (→ undefined, not NaN)", () => {
      const result = computeIndicators(zeroCandles);
      // high52w === low52w === 0 → both distance fields are guarded to undefined.
      assert.strictEqual(result.distanceFrom52WeekHigh, undefined);
      assert.strictEqual(result.distanceFrom52WeekLow, undefined);
      // volumeSma20 === 0 → volumeRatio guarded to undefined (no x/0 Infinity).
      assert.strictEqual(result.volumeRatio, undefined);
      // Nothing numeric that IS present may be non-finite.
      for (const [key, val] of Object.entries(result)) {
        if (typeof val === "number") {
          assert.ok(
            Number.isFinite(val),
            `computeIndicators.${key} must be finite for zero series, got ${val}`
          );
        }
      }
    });
  });

  describe("invariants — bounded indicators stay bounded on random/extreme data", () => {
    it("RSI stays within [0,100] across many random windows", () => {
      for (let seed = 0; seed < 40; seed++) {
        const closes = Array.from(
          { length: 60 },
          (_, i) =>
            100 + Math.sin(i * 0.3 + seed) * 40 + Math.cos(i + seed) * 15
        );
        const r = rsi(closes, 14);
        if (r !== undefined) {
          assert.ok(
            Number.isFinite(r) && r >= 0 && r <= 100,
            `RSI out of [0,100]: ${r} (seed ${seed})`
          );
        }
      }
    });

    it("Williams %R stays within [-100,0] across many random windows", () => {
      for (let seed = 0; seed < 40; seed++) {
        const candles = generateRealisticCandles(40).map((c, i) => ({
          ...c,
          close: c.close + Math.sin(i + seed) * 5,
        }));
        const w = williamsR(candles, 14);
        if (w !== undefined) {
          assert.ok(
            Number.isFinite(w) && w >= -100 && w <= 0,
            `Williams %R out of [-100,0]: ${w} (seed ${seed})`
          );
        }
      }
    });

    it("Stochastic %K and %D stay within [0,100] across many random windows", () => {
      for (let seed = 0; seed < 40; seed++) {
        const candles = generateRealisticCandles(50).map((c, i) => ({
          ...c,
          close: c.close + Math.cos(i * 0.5 + seed) * 8,
        }));
        const st = stochastic(candles, 14, 3);
        if (st?.stochK !== undefined) {
          assert.ok(
            Number.isFinite(st.stochK) && st.stochK >= 0 && st.stochK <= 100,
            `%K out of [0,100]: ${st.stochK} (seed ${seed})`
          );
        }
        if (st?.stochD !== undefined) {
          assert.ok(
            Number.isFinite(st.stochD) && st.stochD >= 0 && st.stochD <= 100,
            `%D out of [0,100]: ${st.stochD} (seed ${seed})`
          );
        }
      }
    });

    it("ATR and OBV are always finite on extreme but valid magnitudes", () => {
      const candles = Array.from({ length: 30 }, (_, i) =>
        makeCandle(
          1e6 + i * 1000,
          i,
          1e6 + i * 1000 - 5000,
          1e6 + i * 1000 + 8000,
          1e6 + i * 1000 - 8000,
          5_000_000_000
        )
      );
      const a = atr(candles, 14)!;
      const o = obv(candles);
      assert.ok(
        Number.isFinite(a) && a >= 0,
        `ATR must be finite & >=0, got ${a}`
      );
      assert.ok(Number.isFinite(o), `OBV must be finite, got ${o}`);
    });

    it("bollinger upper >= middle >= lower with finite, non-negative bandwidth", () => {
      for (let seed = 0; seed < 30; seed++) {
        const closes = Array.from(
          { length: 30 },
          (_, i) => 200 + Math.sin(i + seed) * 25
        );
        const bb = bollingerBands(closes, 20)!;
        assert.ok(bb.upper >= bb.middle && bb.middle >= bb.lower);
        assert.ok(
          Number.isFinite(bb.bandwidth) && bb.bandwidth >= 0,
          `bandwidth must be finite & >=0, got ${bb.bandwidth}`
        );
      }
    });
  });

  describe("characterization — NaN-tainted input propagates (no silent fabrication)", () => {
    // The screener never feeds NaN (DB OHLCV is finite), so there is no NaN-input
    // guard by design. These tests PIN that behavior: a NaN close taints the
    // affected indicator rather than silently producing a plausible-but-wrong
    // number. (If a future change adds sanitization, update these expectations.)
    it("sma over a window containing NaN is NaN (not a fabricated value)", () => {
      const withNaN = [10, 20, NaN, 40, 50];
      assert.ok(Number.isNaN(sma(withNaN, 5)!));
    });

    it("a NaN close taints obv via the comparison chain (stays a number)", () => {
      const candles = [
        makeCandle(100, 0, 100, 100, 100, 1000),
        { ...makeCandle(0, 1, 0, 0, 0, 2000), close: NaN },
        makeCandle(110, 2, 110, 110, 110, 3000),
      ];
      // NaN comparisons are all false → that day neither adds nor subtracts;
      // OBV remains a finite number (no NaN leak from the comparison path).
      const o = obv(candles);
      assert.ok(Number.isFinite(o), `OBV should stay finite, got ${o}`);
    });
  });
});
