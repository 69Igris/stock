/**
 * Dashboard DB Layer Tests
 *
 * NOW EXERCISES THE REAL SOURCE: imports the pure dashboard helpers from
 * `@/lib/db/dashboard-logic`, which is exactly the logic that
 * `getDashboardStats` (in `@/lib/db/dashboard`) calls. No inline
 * reimplementations.
 *
 * The `dashboard-logic` module is Prisma-free, so importing it never pulls in
 * the Prisma client — the test stays pure and exits cleanly (no orphan).
 *
 * Covers:
 * - Portfolio value aggregation (sum of currentValue across holdings)
 * - Day change / P&L aggregation (holdings, MF, positions)
 * - P&L percentage (holdingsPnL / holdingsInvested * 100)
 * - Realized P&L aggregation, win rate, best/worst trade detection
 * - Daily P&L time-series generation
 * - Current-price map + unrealized P&L with position priority
 * - Empty portfolio handling
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getClosedPairedTrades,
  getOpenPairedTrades,
  getWinners,
  getLosers,
  calculateTotalRealizedPnL,
  buildCurrentPriceMap,
  calculateTotalUnrealizedPnL,
  calculateTodaysPnL,
  calculateHoldingsAggregation,
  calculateMfAggregation,
  calculatePositionsAggregation,
  generateDailyPnL,
  calculatePnLPercentage,
  calculateWinRate,
  findBestTrade,
  findWorstTrade,
  calculateTotalPortfolioValue,
} from "@/lib/db/dashboard-logic";

// ---------------------------------------------------------------------------
// Local mock-data shapes (structural subsets accepted by the real helpers)
// ---------------------------------------------------------------------------

interface Holding {
  id: string;
  symbol: string;
  currentValue: number;
  investedValue: number;
  currentPrice: number;
}

interface MutualFund {
  id: string;
  symbol: string;
  currentValue: number | null;
  investedAmount: number | null;
  investedValue: number | null;
}

interface Position {
  id: string;
  symbol: string;
  netQuantity: number;
  lastPrice: number;
  totalPnl: number | null;
  unrealizedPnl: number | null;
}

interface PairedTrade {
  status: string;
  realizedPnL: number | null;
  segment: string;
  entryDate: Date;
  entryPrice: number | null;
  quantity: number | null;
  symbol: string;
}

interface Trade {
  id: string;
  symbol: string;
  tradeDate: Date;
  realizedPnL: number | null;
}

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

function createMockHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: `holding-${Math.random().toString(36).substr(2, 6)}`,
    symbol: "RELIANCE",
    currentValue: 260000,
    investedValue: 250000,
    currentPrice: 2600,
    ...overrides,
  };
}

function createMockMutualFund(overrides: Partial<MutualFund> = {}): MutualFund {
  return {
    id: `mf-${Math.random().toString(36).substr(2, 6)}`,
    symbol: "AXIS_BLUECHIP",
    currentValue: 55000,
    investedAmount: 50000,
    investedValue: 50000,
    ...overrides,
  };
}

function createMockPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: `pos-${Math.random().toString(36).substr(2, 6)}`,
    symbol: "NIFTY",
    netQuantity: 50,
    lastPrice: 22000,
    totalPnl: 5000,
    unrealizedPnl: 3000,
    ...overrides,
  };
}

function createMockPairedTrade(
  overrides: Partial<PairedTrade> = {}
): PairedTrade {
  return {
    status: "CLOSED",
    realizedPnL: 5000,
    segment: "EQUITY",
    entryDate: new Date("2025-01-15"),
    entryPrice: 2500,
    quantity: 100,
    symbol: "RELIANCE",
    ...overrides,
  };
}

function createMockTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: `trade-${Math.random().toString(36).substr(2, 6)}`,
    symbol: "RELIANCE",
    tradeDate: new Date(),
    realizedPnL: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Dashboard DB Logic", () => {
  // =========================================================================
  // Paired Trade Filtering
  // =========================================================================

  describe("getClosedPairedTrades", () => {
    it("should filter only CLOSED trades", () => {
      const trades = [
        createMockPairedTrade({ status: "CLOSED" }),
        createMockPairedTrade({ status: "OPEN" }),
        createMockPairedTrade({ status: "PARTIAL" }),
        createMockPairedTrade({ status: "CLOSED" }),
      ];
      const closed = getClosedPairedTrades(trades);
      assert.strictEqual(closed.length, 2);
      closed.forEach((t) => assert.strictEqual(t.status, "CLOSED"));
    });

    it("should return empty array when no closed trades exist", () => {
      const trades = [
        createMockPairedTrade({ status: "OPEN" }),
        createMockPairedTrade({ status: "PARTIAL" }),
      ];
      assert.strictEqual(getClosedPairedTrades(trades).length, 0);
    });

    it("should return empty array for empty input", () => {
      assert.strictEqual(getClosedPairedTrades([]).length, 0);
    });
  });

  describe("getOpenPairedTrades", () => {
    it("should filter OPEN and PARTIAL trades", () => {
      const trades = [
        createMockPairedTrade({ status: "CLOSED" }),
        createMockPairedTrade({ status: "OPEN" }),
        createMockPairedTrade({ status: "PARTIAL" }),
      ];
      const open = getOpenPairedTrades(trades);
      assert.strictEqual(open.length, 2);
    });

    it("should include PARTIAL status", () => {
      const trades = [createMockPairedTrade({ status: "PARTIAL" })];
      assert.strictEqual(getOpenPairedTrades(trades).length, 1);
    });

    it("should not include unknown statuses", () => {
      const trades = [createMockPairedTrade({ status: "EXPIRED" })];
      assert.strictEqual(getOpenPairedTrades(trades).length, 0);
    });
  });

  // =========================================================================
  // Winners / Losers
  // =========================================================================

  describe("getWinners / getLosers", () => {
    it("should identify winners with positive P&L", () => {
      const closed = [
        createMockPairedTrade({ realizedPnL: 5000 }),
        createMockPairedTrade({ realizedPnL: -2000 }),
        createMockPairedTrade({ realizedPnL: 1000 }),
      ];
      assert.strictEqual(getWinners(closed).length, 2);
    });

    it("should identify losers with negative P&L", () => {
      const closed = [
        createMockPairedTrade({ realizedPnL: 5000 }),
        createMockPairedTrade({ realizedPnL: -2000 }),
        createMockPairedTrade({ realizedPnL: -500 }),
      ];
      assert.strictEqual(getLosers(closed).length, 2);
    });

    it("should treat zero P&L as neither winner nor loser", () => {
      const closed = [createMockPairedTrade({ realizedPnL: 0 })];
      assert.strictEqual(getWinners(closed).length, 0);
      assert.strictEqual(getLosers(closed).length, 0);
    });

    it("should treat null P&L as zero (neither winner nor loser)", () => {
      const closed = [createMockPairedTrade({ realizedPnL: null })];
      assert.strictEqual(getWinners(closed).length, 0);
      assert.strictEqual(getLosers(closed).length, 0);
    });

    it("should handle all winners", () => {
      const closed = [
        createMockPairedTrade({ realizedPnL: 100 }),
        createMockPairedTrade({ realizedPnL: 200 }),
      ];
      assert.strictEqual(getWinners(closed).length, 2);
      assert.strictEqual(getLosers(closed).length, 0);
    });

    it("should handle all losers", () => {
      const closed = [
        createMockPairedTrade({ realizedPnL: -100 }),
        createMockPairedTrade({ realizedPnL: -200 }),
      ];
      assert.strictEqual(getWinners(closed).length, 0);
      assert.strictEqual(getLosers(closed).length, 2);
    });
  });

  // =========================================================================
  // Realized P&L
  // =========================================================================

  describe("calculateTotalRealizedPnL", () => {
    it("should sum all realized P&L from closed trades", () => {
      const closed = [
        createMockPairedTrade({ realizedPnL: 5000 }),
        createMockPairedTrade({ realizedPnL: -2000 }),
        createMockPairedTrade({ realizedPnL: 3000 }),
      ];
      assert.strictEqual(calculateTotalRealizedPnL(closed), 6000);
    });

    it("should return 0 for empty closed trades", () => {
      assert.strictEqual(calculateTotalRealizedPnL([]), 0);
    });

    it("should treat null P&L as 0", () => {
      const closed = [
        createMockPairedTrade({ realizedPnL: 1000 }),
        createMockPairedTrade({ realizedPnL: null }),
      ];
      assert.strictEqual(calculateTotalRealizedPnL(closed), 1000);
    });

    it("should handle all negative P&L", () => {
      const closed = [
        createMockPairedTrade({ realizedPnL: -3000 }),
        createMockPairedTrade({ realizedPnL: -2000 }),
      ];
      assert.strictEqual(calculateTotalRealizedPnL(closed), -5000);
    });
  });

  // =========================================================================
  // Holdings Aggregation
  // =========================================================================

  describe("calculateHoldingsAggregation", () => {
    it("should sum current values of all holdings", () => {
      const holdings = [
        createMockHolding({ currentValue: 100000, investedValue: 90000 }),
        createMockHolding({ currentValue: 200000, investedValue: 180000 }),
      ];
      const result = calculateHoldingsAggregation(holdings);
      assert.strictEqual(result.totalValue, 300000);
    });

    it("should sum invested values of all holdings", () => {
      const holdings = [
        createMockHolding({ investedValue: 100000, currentValue: 110000 }),
        createMockHolding({ investedValue: 200000, currentValue: 220000 }),
      ];
      const result = calculateHoldingsAggregation(holdings);
      assert.strictEqual(result.totalInvested, 300000);
    });

    it("should calculate P&L as currentValue - investedValue for each", () => {
      const holdings = [
        createMockHolding({ currentValue: 120000, investedValue: 100000 }),
        createMockHolding({ currentValue: 80000, investedValue: 100000 }),
      ];
      const result = calculateHoldingsAggregation(holdings);
      // (120000 - 100000) + (80000 - 100000) = 20000 - 20000 = 0
      assert.strictEqual(result.totalPnL, 0);
    });

    it("should handle empty holdings", () => {
      const result = calculateHoldingsAggregation([]);
      assert.strictEqual(result.totalValue, 0);
      assert.strictEqual(result.totalInvested, 0);
      assert.strictEqual(result.totalPnL, 0);
    });

    it("should handle single holding with profit", () => {
      const holdings = [
        createMockHolding({ currentValue: 150000, investedValue: 100000 }),
      ];
      const result = calculateHoldingsAggregation(holdings);
      assert.strictEqual(result.totalPnL, 50000);
    });

    it("should handle single holding with loss", () => {
      const holdings = [
        createMockHolding({ currentValue: 80000, investedValue: 100000 }),
      ];
      const result = calculateHoldingsAggregation(holdings);
      assert.strictEqual(result.totalPnL, -20000);
    });
  });

  // =========================================================================
  // Mutual Fund Aggregation
  // =========================================================================

  describe("calculateMfAggregation", () => {
    it("should sum mutual fund values", () => {
      const mfs = [
        createMockMutualFund({ currentValue: 50000, investedAmount: 45000 }),
        createMockMutualFund({ currentValue: 75000, investedAmount: 70000 }),
      ];
      const result = calculateMfAggregation(mfs);
      assert.strictEqual(result.totalValue, 125000);
      assert.strictEqual(result.totalInvested, 115000);
    });

    it("should prefer investedAmount over investedValue", () => {
      const mfs = [
        createMockMutualFund({
          currentValue: 50000,
          investedAmount: 45000,
          investedValue: 40000,
        }),
      ];
      const result = calculateMfAggregation(mfs);
      assert.strictEqual(result.totalInvested, 45000);
    });

    it("should fall back to investedValue when investedAmount is null", () => {
      const mfs = [
        createMockMutualFund({
          currentValue: 60000,
          investedAmount: null,
          investedValue: 55000,
        }),
      ];
      const result = calculateMfAggregation(mfs);
      assert.strictEqual(result.totalInvested, 55000);
    });

    it("should treat null currentValue as 0", () => {
      const mfs = [
        createMockMutualFund({
          currentValue: null,
          investedAmount: 50000,
        }),
      ];
      const result = calculateMfAggregation(mfs);
      assert.strictEqual(result.totalValue, 0);
      assert.strictEqual(result.totalPnL, -50000);
    });

    it("should handle empty mutual funds", () => {
      const result = calculateMfAggregation([]);
      assert.strictEqual(result.totalValue, 0);
      assert.strictEqual(result.totalInvested, 0);
      assert.strictEqual(result.totalPnL, 0);
    });

    it("should handle all null invested amounts and values", () => {
      const mfs = [
        createMockMutualFund({
          currentValue: 10000,
          investedAmount: null,
          investedValue: null,
        }),
      ];
      const result = calculateMfAggregation(mfs);
      assert.strictEqual(result.totalInvested, 0);
      assert.strictEqual(result.totalPnL, 10000);
    });
  });

  // =========================================================================
  // Open Positions Aggregation
  // =========================================================================

  describe("calculatePositionsAggregation", () => {
    it("should calculate absolute position value (netQuantity * lastPrice)", () => {
      const positions = [
        createMockPosition({ netQuantity: 50, lastPrice: 22000 }),
      ];
      const result = calculatePositionsAggregation(positions);
      assert.strictEqual(result.totalValue, 1100000);
    });

    it("should use absolute value for short positions (negative netQuantity)", () => {
      const positions = [
        createMockPosition({ netQuantity: -50, lastPrice: 22000 }),
      ];
      const result = calculatePositionsAggregation(positions);
      assert.strictEqual(result.totalValue, 1100000);
    });

    it("should sum total P&L from all positions", () => {
      const positions = [
        createMockPosition({ totalPnl: 5000 }),
        createMockPosition({ totalPnl: -2000 }),
      ];
      const result = calculatePositionsAggregation(positions);
      assert.strictEqual(result.totalPnL, 3000);
    });

    it("should treat null totalPnl as 0", () => {
      const positions = [
        createMockPosition({ totalPnl: null }),
        createMockPosition({ totalPnl: 5000 }),
      ];
      const result = calculatePositionsAggregation(positions);
      assert.strictEqual(result.totalPnL, 5000);
    });

    it("should handle empty positions", () => {
      const result = calculatePositionsAggregation([]);
      assert.strictEqual(result.totalValue, 0);
      assert.strictEqual(result.totalPnL, 0);
    });

    it("should handle zero quantity positions", () => {
      const positions = [
        createMockPosition({ netQuantity: 0, lastPrice: 22000 }),
      ];
      const result = calculatePositionsAggregation(positions);
      assert.strictEqual(result.totalValue, 0);
    });
  });

  // =========================================================================
  // Total Portfolio Value
  // =========================================================================

  describe("calculateTotalPortfolioValue", () => {
    it("should sum holdings, MF, and positions values", () => {
      assert.strictEqual(
        calculateTotalPortfolioValue(100000, 50000, 200000),
        350000
      );
    });

    it("should handle all zeros", () => {
      assert.strictEqual(calculateTotalPortfolioValue(0, 0, 0), 0);
    });

    it("should handle only holdings", () => {
      assert.strictEqual(calculateTotalPortfolioValue(100000, 0, 0), 100000);
    });

    it("should handle only mutual funds", () => {
      assert.strictEqual(calculateTotalPortfolioValue(0, 75000, 0), 75000);
    });
  });

  // =========================================================================
  // P&L Percentage
  // =========================================================================

  describe("calculatePnLPercentage", () => {
    it("should calculate positive percentage", () => {
      assert.strictEqual(calculatePnLPercentage(10000, 100000), "10.00");
    });

    it("should calculate negative percentage", () => {
      assert.strictEqual(calculatePnLPercentage(-5000, 100000), "-5.00");
    });

    it("should return '0' when totalInvested is zero", () => {
      assert.strictEqual(calculatePnLPercentage(0, 0), "0");
    });

    it("should handle fractional percentages", () => {
      assert.strictEqual(calculatePnLPercentage(10000, 300000), "3.33");
    });

    it("should return '0' when invested is zero but P&L is non-zero", () => {
      // Mirrors the source - if invested is 0, return "0" regardless of P&L
      assert.strictEqual(calculatePnLPercentage(5000, 0), "0");
    });
  });

  // =========================================================================
  // Win Rate
  // =========================================================================

  describe("calculateWinRate", () => {
    it("should calculate correct win rate percentage", () => {
      assert.strictEqual(calculateWinRate(7, 10), 70);
    });

    it("should return 0 when no closed trades", () => {
      assert.strictEqual(calculateWinRate(0, 0), 0);
    });

    it("should return 100 for all winners", () => {
      assert.strictEqual(calculateWinRate(5, 5), 100);
    });

    it("should return 0 for all losers", () => {
      assert.strictEqual(calculateWinRate(0, 10), 0);
    });

    it("should round to nearest integer", () => {
      // 3/7 * 100 = 42.857... -> 43
      assert.strictEqual(calculateWinRate(3, 7), 43);
    });

    it("should handle single trade winner", () => {
      assert.strictEqual(calculateWinRate(1, 1), 100);
    });

    it("should handle single trade loser", () => {
      assert.strictEqual(calculateWinRate(0, 1), 0);
    });
  });

  // =========================================================================
  // Best / Worst Trade
  // =========================================================================

  describe("findBestTrade", () => {
    it("should find trade with highest P&L", () => {
      const closed = [
        createMockPairedTrade({ symbol: "TCS", realizedPnL: 3000 }),
        createMockPairedTrade({ symbol: "RELIANCE", realizedPnL: 8000 }),
        createMockPairedTrade({ symbol: "INFY", realizedPnL: 2000 }),
      ];
      const best = findBestTrade(closed);
      assert.strictEqual(best?.symbol, "RELIANCE");
      assert.strictEqual(best?.pnl, 8000);
    });

    it("should return null for empty trades", () => {
      assert.strictEqual(findBestTrade([]), null);
    });

    it("should handle single trade", () => {
      const closed = [
        createMockPairedTrade({ symbol: "TCS", realizedPnL: -500 }),
      ];
      const best = findBestTrade(closed);
      assert.strictEqual(best?.symbol, "TCS");
      assert.strictEqual(best?.pnl, -500);
    });

    it("should handle all negative P&L - finds least negative", () => {
      const closed = [
        createMockPairedTrade({ symbol: "A", realizedPnL: -5000 }),
        createMockPairedTrade({ symbol: "B", realizedPnL: -1000 }),
        createMockPairedTrade({ symbol: "C", realizedPnL: -3000 }),
      ];
      const best = findBestTrade(closed);
      assert.strictEqual(best?.symbol, "B");
      assert.strictEqual(best?.pnl, -1000);
    });
  });

  describe("findWorstTrade", () => {
    it("should find trade with lowest P&L", () => {
      const closed = [
        createMockPairedTrade({ symbol: "TCS", realizedPnL: 3000 }),
        createMockPairedTrade({ symbol: "RELIANCE", realizedPnL: -8000 }),
        createMockPairedTrade({ symbol: "INFY", realizedPnL: 2000 }),
      ];
      const worst = findWorstTrade(closed);
      assert.strictEqual(worst?.symbol, "RELIANCE");
      assert.strictEqual(worst?.pnl, -8000);
    });

    it("should return null for empty trades", () => {
      assert.strictEqual(findWorstTrade([]), null);
    });

    it("should handle all positive P&L - finds least positive", () => {
      const closed = [
        createMockPairedTrade({ symbol: "A", realizedPnL: 5000 }),
        createMockPairedTrade({ symbol: "B", realizedPnL: 1000 }),
        createMockPairedTrade({ symbol: "C", realizedPnL: 3000 }),
      ];
      const worst = findWorstTrade(closed);
      assert.strictEqual(worst?.symbol, "B");
      assert.strictEqual(worst?.pnl, 1000);
    });
  });

  // =========================================================================
  // Current Price Map & Unrealized P&L
  // =========================================================================

  describe("buildCurrentPriceMap", () => {
    it("should build map from holdings prices", () => {
      const holdings = [
        createMockHolding({ symbol: "RELIANCE", currentPrice: 2600 }),
        createMockHolding({ symbol: "TCS", currentPrice: 3500 }),
      ];
      const map = buildCurrentPriceMap(holdings, []);
      assert.strictEqual(map.get("RELIANCE"), 2600);
      assert.strictEqual(map.get("TCS"), 3500);
    });

    it("should override holdings prices with position prices", () => {
      const holdings = [
        createMockHolding({ symbol: "RELIANCE", currentPrice: 2600 }),
      ];
      const positions = [
        createMockPosition({ symbol: "RELIANCE", lastPrice: 2650 }),
      ];
      const map = buildCurrentPriceMap(holdings, positions);
      assert.strictEqual(map.get("RELIANCE"), 2650);
    });

    it("should skip holdings with zero currentPrice", () => {
      const holdings = [createMockHolding({ symbol: "ZERO", currentPrice: 0 })];
      const map = buildCurrentPriceMap(holdings, []);
      assert.strictEqual(map.has("ZERO"), false);
    });

    it("should skip positions with zero lastPrice", () => {
      const positions = [createMockPosition({ symbol: "ZERO", lastPrice: 0 })];
      const map = buildCurrentPriceMap([], positions);
      assert.strictEqual(map.has("ZERO"), false);
    });
  });

  describe("calculateTotalUnrealizedPnL", () => {
    it("should use position P&L when available", () => {
      const openTrades = [
        createMockPairedTrade({
          status: "OPEN",
          symbol: "RELIANCE",
          entryPrice: 2500,
          quantity: 100,
        }),
      ];
      const positionPnLMap = new Map([["RELIANCE", 15000]]);
      const currentPriceMap = new Map([["RELIANCE", 2600]]);

      const result = calculateTotalUnrealizedPnL(
        openTrades,
        positionPnLMap,
        currentPriceMap
      );
      assert.strictEqual(result, 15000);
    });

    it("should fall back to price calculation when position P&L not available", () => {
      const openTrades = [
        createMockPairedTrade({
          status: "OPEN",
          symbol: "TCS",
          entryPrice: 3500,
          quantity: 50,
        }),
      ];
      const positionPnLMap = new Map<string, number>();
      const currentPriceMap = new Map([["TCS", 3700]]);

      const result = calculateTotalUnrealizedPnL(
        openTrades,
        positionPnLMap,
        currentPriceMap
      );
      // (3700 - 3500) * 50 = 10000
      assert.strictEqual(result, 10000);
    });

    it("should count each symbol only once (dedup)", () => {
      const openTrades = [
        createMockPairedTrade({
          status: "OPEN",
          symbol: "RELIANCE",
          entryPrice: 2500,
          quantity: 100,
        }),
        createMockPairedTrade({
          status: "OPEN",
          symbol: "RELIANCE",
          entryPrice: 2400,
          quantity: 50,
        }),
      ];
      const positionPnLMap = new Map([["RELIANCE", 15000]]);
      const currentPriceMap = new Map([["RELIANCE", 2600]]);

      const result = calculateTotalUnrealizedPnL(
        openTrades,
        positionPnLMap,
        currentPriceMap
      );
      // Should count RELIANCE only once
      assert.strictEqual(result, 15000);
    });

    it("should return 0 for empty open trades", () => {
      const result = calculateTotalUnrealizedPnL([], new Map(), new Map());
      assert.strictEqual(result, 0);
    });

    it("should return 0 when no price data available", () => {
      const openTrades = [
        createMockPairedTrade({
          status: "OPEN",
          symbol: "UNKNOWN",
          entryPrice: 100,
          quantity: 10,
        }),
      ];
      const result = calculateTotalUnrealizedPnL(
        openTrades,
        new Map(),
        new Map()
      );
      assert.strictEqual(result, 0);
    });

    it("should return 0 when entry price is null", () => {
      const openTrades = [
        createMockPairedTrade({
          status: "OPEN",
          symbol: "TEST",
          entryPrice: null,
          quantity: 10,
        }),
      ];
      const result = calculateTotalUnrealizedPnL(
        openTrades,
        new Map(),
        new Map([["TEST", 100]])
      );
      assert.strictEqual(result, 0);
    });

    it("should return 0 when quantity is null", () => {
      const openTrades = [
        createMockPairedTrade({
          status: "OPEN",
          symbol: "TEST",
          entryPrice: 100,
          quantity: null,
        }),
      ];
      const result = calculateTotalUnrealizedPnL(
        openTrades,
        new Map(),
        new Map([["TEST", 200]])
      );
      assert.strictEqual(result, 0);
    });
  });

  // =========================================================================
  // Daily P&L Generation
  // =========================================================================

  describe("generateDailyPnL", () => {
    it("should generate 30 entries by default", () => {
      const result = generateDailyPnL([]);
      assert.strictEqual(result.length, 30);
    });

    it("should generate specified number of days", () => {
      const result = generateDailyPnL([], 7);
      assert.strictEqual(result.length, 7);
    });

    it("should have 0 P&L for all days when no trades", () => {
      const result = generateDailyPnL([]);
      result.forEach((day) => {
        assert.strictEqual(day.pnl, 0);
        assert.strictEqual(day.cumulativePnL, 0);
      });
    });

    it("should accumulate cumulative P&L correctly", () => {
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0]!;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split("T")[0]!;

      const trades = [
        createMockTrade({
          tradeDate: yesterday,
          realizedPnL: 1000,
        }),
        createMockTrade({
          tradeDate: today,
          realizedPnL: 2000,
        }),
      ];

      const result = generateDailyPnL(trades);
      const lastEntry = result[result.length - 1]!;
      const secondLast = result[result.length - 2]!;

      assert.strictEqual(lastEntry.date, todayStr);
      assert.strictEqual(lastEntry.pnl, 2000);
      assert.strictEqual(secondLast.date, yesterdayStr);
      assert.strictEqual(secondLast.pnl, 1000);
      assert.strictEqual(lastEntry.cumulativePnL, 3000);
    });

    it("should sum multiple trades on the same day", () => {
      const today = new Date();

      const trades = [
        createMockTrade({ tradeDate: today, realizedPnL: 1000 }),
        createMockTrade({ tradeDate: today, realizedPnL: 2000 }),
        createMockTrade({ tradeDate: today, realizedPnL: -500 }),
      ];

      const result = generateDailyPnL(trades);
      const lastEntry = result[result.length - 1]!;
      assert.strictEqual(lastEntry.pnl, 2500);
    });

    it("should treat null realizedPnL as 0", () => {
      const today = new Date();
      const trades = [createMockTrade({ tradeDate: today, realizedPnL: null })];
      const result = generateDailyPnL(trades);
      const lastEntry = result[result.length - 1]!;
      assert.strictEqual(lastEntry.pnl, 0);
    });

    it("should have date strings in YYYY-MM-DD format", () => {
      const result = generateDailyPnL([]);
      result.forEach((day) => {
        assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
      });
    });

    it("should have dates in chronological order", () => {
      const result = generateDailyPnL([]);
      for (let i = 1; i < result.length; i++) {
        assert.ok(result[i]!.date >= result[i - 1]!.date);
      }
    });
  });

  // =========================================================================
  // Today's P&L
  // =========================================================================

  describe("calculateTodaysPnL", () => {
    it("should sum P&L for today's trades only", () => {
      const today = new Date();
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const trades = [
        createMockTrade({ tradeDate: today, realizedPnL: 1000 }),
        createMockTrade({ tradeDate: today, realizedPnL: 2000 }),
        createMockTrade({ tradeDate: yesterday, realizedPnL: 5000 }),
      ];

      const result = calculateTodaysPnL(trades);
      assert.strictEqual(result.todaysPnL, 3000);
      assert.strictEqual(result.todaysTrades, 2);
    });

    it("should return 0 for no trades today", () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const trades = [
        createMockTrade({ tradeDate: yesterday, realizedPnL: 5000 }),
      ];

      const result = calculateTodaysPnL(trades);
      assert.strictEqual(result.todaysPnL, 0);
      assert.strictEqual(result.todaysTrades, 0);
    });

    it("should return 0 for empty trades", () => {
      const result = calculateTodaysPnL([]);
      assert.strictEqual(result.todaysPnL, 0);
      assert.strictEqual(result.todaysTrades, 0);
    });
  });

  // =========================================================================
  // Empty Portfolio Handling
  // =========================================================================

  describe("Empty portfolio handling", () => {
    it("should handle completely empty portfolio", () => {
      const holdingsAgg = calculateHoldingsAggregation([]);
      const mfAgg = calculateMfAggregation([]);
      const posAgg = calculatePositionsAggregation([]);
      const totalValue = calculateTotalPortfolioValue(
        holdingsAgg.totalValue,
        mfAgg.totalValue,
        posAgg.totalValue
      );
      const pnlPct = calculatePnLPercentage(
        holdingsAgg.totalPnL,
        holdingsAgg.totalInvested
      );
      const winRate = calculateWinRate(0, 0);
      const bestTrade = findBestTrade([]);
      const worstTrade = findWorstTrade([]);

      assert.strictEqual(totalValue, 0);
      assert.strictEqual(pnlPct, "0");
      assert.strictEqual(winRate, 0);
      assert.strictEqual(bestTrade, null);
      assert.strictEqual(worstTrade, null);
    });

    it("should produce valid daily P&L for empty trades", () => {
      const dailyPnL = generateDailyPnL([]);
      assert.strictEqual(dailyPnL.length, 30);
      dailyPnL.forEach((d) => {
        assert.strictEqual(d.pnl, 0);
        assert.strictEqual(d.cumulativePnL, 0);
      });
    });
  });

  // =========================================================================
  // Full Dashboard Simulation
  // =========================================================================

  describe("Full dashboard simulation", () => {
    it("should combine all segments correctly", () => {
      const holdings = [
        createMockHolding({ currentValue: 500000, investedValue: 450000 }),
        createMockHolding({ currentValue: 300000, investedValue: 320000 }),
      ];
      const mfs = [
        createMockMutualFund({ currentValue: 100000, investedAmount: 90000 }),
      ];
      const positions = [
        createMockPosition({
          netQuantity: 100,
          lastPrice: 500,
          totalPnl: 5000,
        }),
      ];

      const holdingsAgg = calculateHoldingsAggregation(holdings);
      const mfAgg = calculateMfAggregation(mfs);
      const posAgg = calculatePositionsAggregation(positions);

      assert.strictEqual(holdingsAgg.totalValue, 800000);
      assert.strictEqual(holdingsAgg.totalPnL, 30000);
      assert.strictEqual(mfAgg.totalValue, 100000);
      assert.strictEqual(mfAgg.totalPnL, 10000);
      assert.strictEqual(posAgg.totalValue, 50000);
      assert.strictEqual(posAgg.totalPnL, 5000);

      const total = calculateTotalPortfolioValue(
        holdingsAgg.totalValue,
        mfAgg.totalValue,
        posAgg.totalValue
      );
      assert.strictEqual(total, 950000);
    });
  });
});
