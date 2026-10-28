/**
 * Backtest API CONTRACT tests.
 *
 * Imports the REAL exported symbols the POST /api/backtest handler calls (from
 * `@/app/api/backtest/route-logic`): the indicator math (`calculateSMA`,
 * `calculateRSI`), the strategy trade-generators (`runMACrossover`,
 * `runRSIStrategy`), input validation, and `buildResponse`.
 *
 * (Replaces the previous SHADOW version, which re-declared every one of these
 * functions inline and asserted the copies — green even if the route's real
 * math drifted.)
 *
 * Source: apps/web/app/api/backtest/route.ts
 *         apps/web/app/api/backtest/route-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calculateSMA,
  calculateRSI,
  validateBacktestInput,
  validateHistoricalData,
  normalizeSymbol,
  isKnownStrategy,
  runMACrossover,
  runRSIStrategy,
  buildResponse,
  type BacktestTrade,
} from "@/app/api/backtest/route-logic";

describe("Backtest API - calculateSMA", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(calculateSMA([], 3), []);
  });

  it("returns single element when period is 1", () => {
    assert.deepEqual(calculateSMA([42], 1), [42]);
  });

  it("returns all values when period is 1", () => {
    assert.deepEqual(
      calculateSMA([10, 20, 30, 40, 50], 1),
      [10, 20, 30, 40, 50]
    );
  });

  it("returns correct SMA for period=3 with known values", () => {
    assert.deepEqual(calculateSMA([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  });

  it("returns correct SMA for period=5", () => {
    const result = calculateSMA([10, 20, 30, 40, 50, 60, 70], 5);
    assert.equal(result[3], null);
    assert.equal(result[4], 30); // (10+20+30+40+50)/5
    assert.equal(result[5], 40); // (20+30+40+50+60)/5
    assert.equal(result[6], 50); // (30+40+50+60+70)/5
  });

  it("returns all null when period is larger than array", () => {
    assert.deepEqual(calculateSMA([1, 2, 3], 5), [null, null, null]);
  });

  it("handles constant values", () => {
    assert.deepEqual(calculateSMA([5, 5, 5, 5, 5], 3), [null, null, 5, 5, 5]);
  });

  it("handles descending sequence", () => {
    const result = calculateSMA([10, 9, 8, 7, 6], 3);
    assert.equal(result[2], 9); // (10+9+8)/3
    assert.equal(result[3], 8); // (9+8+7)/3
    assert.equal(result[4], 7); // (8+7+6)/3
  });

  it("correct window calculation - uses last N values", () => {
    const result = calculateSMA([100, 200, 300, 400, 500], 2);
    assert.equal(result[1], 150); // (100+200)/2
    assert.equal(result[4], 450); // (400+500)/2
  });

  it("returns array of same length as input", () => {
    assert.equal(calculateSMA([1, 2, 3, 4, 5, 6, 7], 4).length, 7);
  });

  it("handles single element with period > 1", () => {
    assert.deepEqual(calculateSMA([42], 3), [null]);
  });
});

describe("Backtest API - calculateRSI", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(calculateRSI([]), []);
  });

  it("returns [null] for single element", () => {
    assert.deepEqual(calculateRSI([100]), [null]);
  });

  it("returns null for first period elements", () => {
    const data = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = calculateRSI(data, 14);
    for (let i = 0; i < 14; i++) {
      assert.equal(result[i], null, `index ${i} should be null`);
    }
    assert.notEqual(result[14], null);
  });

  it("all gains => RSI 100 (avgLoss 0)", () => {
    const data = Array.from({ length: 20 }, (_, i) => 100 + i * 10);
    const result = calculateRSI(data, 14);
    for (const val of result.filter((v): v is number => v !== null)) {
      assert.equal(val, 100);
    }
  });

  it("all losses => RSI 0 (avgGain 0)", () => {
    const data = Array.from({ length: 20 }, (_, i) => 200 - i * 5);
    const result = calculateRSI(data, 14);
    for (const val of result.filter((v): v is number => v !== null)) {
      assert.equal(val, 0);
    }
  });

  it("flat prices => RSI 100 (avgLoss 0)", () => {
    const data = Array.from({ length: 20 }, () => 100);
    const result = calculateRSI(data, 14);
    for (const val of result.filter((v): v is number => v !== null)) {
      assert.equal(val, 100);
    }
  });

  it("RSI values are always in [0, 100] range", () => {
    const data = [
      100, 110, 105, 115, 108, 120, 112, 125, 118, 130, 122, 135, 128, 140, 132,
      145, 138, 150, 142, 155,
    ];
    const result = calculateRSI(data, 14);
    for (const val of result.filter((v): v is number => v !== null)) {
      assert.ok(val >= 0 && val <= 100, `RSI ${val} out of [0,100]`);
    }
  });

  it("uses default period of 14", () => {
    const data = Array.from({ length: 20 }, (_, i) => 100 + i);
    assert.deepEqual(calculateRSI(data), calculateRSI(data, 14));
  });

  it("custom period works correctly", () => {
    const data = Array.from({ length: 10 }, (_, i) => 100 + i);
    const result = calculateRSI(data, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(result[i], null, `index ${i} should be null`);
    }
    assert.notEqual(result[5], null);
  });

  it("alternating gains and losses => RSI near 50", () => {
    const data: number[] = [];
    for (let i = 0; i < 20; i++) data.push(i % 2 === 0 ? 100 : 110);
    const result = calculateRSI(data, 14);
    for (const val of result.filter((v): v is number => v !== null)) {
      assert.ok(val >= 45 && val <= 55, `RSI ${val} not near 50`);
    }
  });

  it("result length equals input length", () => {
    const data = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 10);
    assert.equal(calculateRSI(data, 14).length, 25);
  });

  it("two elements returns [null, null] with default period", () => {
    assert.deepEqual(calculateRSI([100, 110]), [null, null]);
  });
});

describe("Backtest API - Validation Logic", () => {
  it("returns error when symbol is missing", () => {
    const result = validateBacktestInput({ strategy: "MA_CROSSOVER" });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.status, 400);
      assert.equal(result.error, "Symbol and strategy are required");
    }
  });

  it("returns error when strategy is missing", () => {
    const result = validateBacktestInput({ symbol: "RELIANCE" });
    assert.equal(result.valid, false);
    if (!result.valid) assert.equal(result.status, 400);
  });

  it("returns error when both symbol and strategy are missing", () => {
    const result = validateBacktestInput({});
    assert.equal(result.valid, false);
  });

  it("isKnownStrategy accepts MA_CROSSOVER and RSI", () => {
    assert.equal(isKnownStrategy("MA_CROSSOVER"), true);
    assert.equal(isKnownStrategy("RSI"), true);
  });

  it("isKnownStrategy rejects unknown strategy names", () => {
    assert.equal(isKnownStrategy("BOLLINGER"), false);
    assert.equal(isKnownStrategy(""), false);
    assert.equal(isKnownStrategy("ma_crossover"), false); // case-sensitive
  });

  it("symbol without dot gets .NS appended", () => {
    assert.equal(normalizeSymbol("RELIANCE"), "RELIANCE.NS");
  });

  it("symbol with dot is used as-is", () => {
    assert.equal(normalizeSymbol("RELIANCE.BO"), "RELIANCE.BO");
  });

  it("returns error for insufficient data (null)", () => {
    const result = validateHistoricalData(null);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.equal(result.status, 400);
      assert.equal(
        result.error,
        "Insufficient historical data for backtesting"
      );
    }
  });

  it("returns error for undefined data", () => {
    const result = validateHistoricalData(undefined);
    assert.equal(result.valid, false);
  });

  it("returns error for insufficient data (< 50 points)", () => {
    const result = validateHistoricalData(new Array(49));
    assert.equal(result.valid, false);
  });

  it("accepts data with exactly 50 points", () => {
    assert.equal(validateHistoricalData(new Array(50)).valid, true);
  });

  it("accepts data with more than 50 points", () => {
    assert.equal(validateHistoricalData(new Array(200)).valid, true);
  });
});

describe("Backtest API - MA_CROSSOVER Strategy", () => {
  const datesFor = (closes: number[]) =>
    closes.map((_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`);

  it("ascending data with default periods yields no crossover", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const result = runMACrossover(closes, datesFor(closes));
    assert.equal(result.trades.length, 0);
  });

  it("detects a crossover with custom short/long periods", () => {
    const closes = [
      100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 85, 90, 95, 100, 105, 110, 115,
      120, 125, 130,
    ];
    const result = runMACrossover(closes, datesFor(closes), {
      shortPeriod: 3,
      longPeriod: 5,
    });
    assert.ok(result.trades.length > 0, "Should have at least one trade");
  });

  it("BUY when short crosses above long", () => {
    const closes = [
      50, 48, 46, 44, 42, 40, 38, 36, 34, 32, 35, 40, 45, 50, 55, 60, 65, 70,
      75, 80,
    ];
    const result = runMACrossover(closes, datesFor(closes), {
      shortPeriod: 3,
      longPeriod: 5,
    });
    assert.ok(result.trades.some((t) => t.type === "BUY"));
  });

  it("does not open multiple positions simultaneously", () => {
    const closes = [
      50, 48, 46, 44, 42, 40, 45, 50, 55, 60, 58, 56, 54, 52, 50, 55, 60, 65,
      70, 75,
    ];
    const result = runMACrossover(closes, datesFor(closes), {
      shortPeriod: 3,
      longPeriod: 5,
    });
    let inPosition = false;
    for (const trade of result.trades) {
      if (trade.type === "BUY") {
        assert.ok(!inPosition, "Should not BUY when already in position");
        inPosition = true;
      } else {
        assert.ok(inPosition, "Should not SELL when not in position");
        inPosition = false;
      }
    }
  });

  it("SELL trades carry a numeric pnl; BUY trades do not", () => {
    const closes = [
      50, 48, 46, 44, 42, 40, 45, 50, 55, 60, 65, 62, 58, 54, 50, 46, 42, 38,
      34, 30,
    ];
    const result = runMACrossover(closes, datesFor(closes), {
      shortPeriod: 3,
      longPeriod: 5,
    });
    for (const trade of result.trades) {
      if (trade.type === "SELL") {
        assert.equal(typeof trade.pnl, "number");
      } else {
        assert.equal(trade.pnl, undefined);
      }
    }
  });
});

describe("Backtest API - RSI Strategy", () => {
  const datesFor = (closes: number[]) =>
    closes.map((_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`);

  it("runs with defaults without error", () => {
    const closes = Array.from(
      { length: 30 },
      (_, i) => 100 + Math.sin(i * 0.5) * 5
    );
    const result = runRSIStrategy(closes, datesFor(closes));
    assert.ok(Array.isArray(result.trades));
  });

  it("BUY when RSI crosses above oversold level", () => {
    const closes = [
      100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 22, 20,
      25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80,
    ];
    const result = runRSIStrategy(closes, datesFor(closes), {
      period: 5,
      oversold: 30,
      overbought: 70,
    });
    assert.ok(result.trades.some((t) => t.type === "BUY"));
  });

  it("SELL when RSI reaches overbought after a BUY", () => {
    const closes = [
      100, 90, 80, 70, 60, 50, 40, 30, 35, 40, 50, 60, 70, 80, 90, 100, 110,
      120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240,
    ];
    const result = runRSIStrategy(closes, datesFor(closes), {
      period: 5,
      oversold: 30,
      overbought: 70,
    });
    if (result.trades.some((t) => t.type === "BUY")) {
      assert.ok(result.trades.some((t) => t.type === "SELL"));
    }
  });

  it("does not open multiple positions simultaneously", () => {
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) closes.push(100 + Math.sin(i * 0.3) * 30);
    const result = runRSIStrategy(closes, datesFor(closes), {
      period: 5,
      oversold: 30,
      overbought: 70,
    });
    let inPosition = false;
    for (const trade of result.trades) {
      if (trade.type === "BUY") {
        assert.ok(!inPosition);
        inPosition = true;
      } else {
        assert.ok(inPosition);
        inPosition = false;
      }
    }
  });
});

describe("Backtest API - buildResponse", () => {
  const empty = { trades: [], totalPnl: 0, winners: 0, losers: 0 };

  it("has all required fields", () => {
    const result = buildResponse("RELIANCE", "MA_CROSSOVER", empty);
    for (const key of [
      "symbol",
      "strategy",
      "period",
      "totalTrades",
      "winners",
      "losers",
      "winRate",
      "totalPnl",
      "trades",
    ]) {
      assert.ok(key in result, `missing ${key}`);
    }
  });

  it("period is always 1Y", () => {
    assert.equal(buildResponse("TCS", "RSI", empty).period, "1Y");
  });

  it("winRate is 0 when no trades", () => {
    const result = buildResponse("INFY", "MA_CROSSOVER", empty);
    assert.equal(result.winRate, 0);
    assert.equal(result.totalTrades, 0);
  });

  it("winRate calculation is correct", () => {
    const result = buildResponse("RELIANCE", "MA_CROSSOVER", {
      trades: [],
      totalPnl: 100,
      winners: 3,
      losers: 2,
    });
    assert.equal(result.winRate, 60); // (3/5)*100
    assert.equal(result.totalTrades, 5);
  });

  it("winRate is rounded to 1 decimal place", () => {
    const result = buildResponse("RELIANCE", "RSI", {
      trades: [],
      totalPnl: 50,
      winners: 1,
      losers: 2,
    });
    assert.equal(result.winRate, 33.3); // (1/3)*100 -> 33.3
  });

  it("totalPnl is rounded to 2 decimal places", () => {
    const result = buildResponse("TCS", "RSI", {
      trades: [],
      totalPnl: 123.456789,
      winners: 1,
      losers: 0,
    });
    assert.equal(result.totalPnl, 123.46);
  });

  it("trades array is limited to the last 20 items", () => {
    const trades: BacktestTrade[] = Array.from({ length: 30 }, (_, i) => ({
      type: i % 2 === 0 ? "BUY" : "SELL",
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      price: 100 + i,
    }));
    const result = buildResponse("RELIANCE", "MA_CROSSOVER", {
      trades,
      totalPnl: 0,
      winners: 0,
      losers: 0,
    });
    assert.equal(result.trades.length, 20);
    assert.equal(result.trades[0].date, "2024-01-11");
    assert.equal(result.trades[19].date, "2024-01-30");
  });

  it("trades array is not truncated when <= 20 items", () => {
    const trades: BacktestTrade[] = Array.from({ length: 10 }, (_, i) => ({
      type: "BUY",
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      price: 100 + i,
    }));
    const result = buildResponse("RELIANCE", "RSI", {
      trades,
      totalPnl: 0,
      winners: 0,
      losers: 0,
    });
    assert.equal(result.trades.length, 10);
  });

  it("preserves symbol and strategy in response", () => {
    const result = buildResponse("HDFCBANK.BO", "RSI", empty);
    assert.equal(result.symbol, "HDFCBANK.BO");
    assert.equal(result.strategy, "RSI");
  });
});
