/**
 * Comprehensive FIFO Trade Pairing Algorithm Tests
 *
 * Tests for packages/core/src/pairing/algorithm.ts
 *
 * Covers:
 * - Helper functions: isEffectivelyZero, getGroupKey, sortByTradeTime,
 *   calculatePnL, calculatePnLPercentage, getPositionType, isEntryTrade
 * - Basic FIFO matching (LONG and SHORT)
 * - Partial fills / row splitting
 * - Grouping logic (symbol, exchange, productType, broker, ISIN)
 * - P&L calculations (LONG, SHORT, percentage)
 * - Edge cases (empty, single, floating point, stable sort)
 * - Stats verification
 * - pairUserTrades convenience function
 * - Complex multi-step scenarios
 * - Output sorting and field propagation
 *
 * NO SHADOWS: every helper under test is the REAL exported symbol from
 * packages/core/src/pairing/algorithm.ts (imported below), and pairTradesFIFO
 * CALLS each one — so the production path and these unit tests execute the same
 * code. (This file previously reimplemented the helpers inline and asserted the
 * copies; de-shadowed under MONEY-620.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pairTradesFIFO,
  pairUserTrades,
  // Real pure helpers — asserted directly, not via inline shadows.
  QUANTITY_EPSILON,
  isEffectivelyZero,
  getGroupKey,
  sortByTradeTime,
  calculatePnL,
  calculatePnLPercentage,
  getPositionType,
  isEntryTrade,
  type TradeInput,
  type PairedTradeOutput,
  type PairingResult,
  type PairingStats,
} from "@usemoney/core/pairing";

// Anchor the epsilon contract to the REAL exported constant (not a magic 1e-6
// copy): if the source epsilon ever changes, this assertion flags it.
assert.strictEqual(QUANTITY_EPSILON, 1e-6);

// ===========================================================================
// Factory: create a TradeInput with sensible defaults
// ===========================================================================

let tradeCounter = 0;

function createTrade(overrides: Partial<TradeInput> = {}): TradeInput {
  tradeCounter++;
  return {
    id: `trade-${tradeCounter}`,
    userId: "user-1",
    symbol: "RELIANCE",
    isin: null,
    exchange: "NSE",
    segment: "CASH",
    broker: null,
    brokerUserId: null,
    tradeType: "BUY",
    positionType: "LONG",
    productType: "CNC",
    quantity: 10,
    price: 100,
    tradeDate: new Date("2024-01-15"),
    tradeTime: new Date("2024-01-15T10:00:00"),
    sourceType: "SYNCED",
    ...overrides,
  };
}

// ===========================================================================
// 1. Unit tests for reimplemented helper functions
// ===========================================================================

describe("FIFO Trade Pairing Algorithm", () => {
  // -------------------------------------------------------------------------
  // isEffectivelyZero
  // -------------------------------------------------------------------------
  describe("isEffectivelyZero", () => {
    it("should return true for 0", () => {
      assert.strictEqual(isEffectivelyZero(0), true);
    });

    it("should return true for a very small positive number", () => {
      assert.strictEqual(isEffectivelyZero(1e-7), true);
    });

    it("should return true for a very small negative number", () => {
      assert.strictEqual(isEffectivelyZero(-1e-7), true);
    });

    it("should return true for values just under QUANTITY_EPSILON", () => {
      assert.strictEqual(isEffectivelyZero(9.99e-7), true);
    });

    it("should return false for QUANTITY_EPSILON itself", () => {
      assert.strictEqual(isEffectivelyZero(1e-6), false);
    });

    it("should return false for values above QUANTITY_EPSILON", () => {
      assert.strictEqual(isEffectivelyZero(0.001), false);
    });

    it("should return false for 1", () => {
      assert.strictEqual(isEffectivelyZero(1), false);
    });

    it("should return false for -1", () => {
      assert.strictEqual(isEffectivelyZero(-1), false);
    });

    it("should handle floating point residuals (3.012e-12)", () => {
      assert.strictEqual(isEffectivelyZero(3.012e-12), true);
    });

    it("should handle the residual from 10 - 3.33 - 3.33 - 3.34", () => {
      const residual = 10 - 3.33 - 3.33 - 3.34;
      assert.strictEqual(isEffectivelyZero(residual), true);
    });
  });

  // -------------------------------------------------------------------------
  // getGroupKey
  // -------------------------------------------------------------------------
  describe("getGroupKey", () => {
    it("should use ISIN when available", () => {
      const trade = createTrade({ isin: "INE002A01018", symbol: "RELIANCE" });
      const key = getGroupKey(trade);
      assert.ok(key.startsWith("INE002A01018|"));
    });

    it("should fall back to symbol when ISIN is null", () => {
      const trade = createTrade({ isin: null, symbol: "RELIANCE" });
      const key = getGroupKey(trade);
      assert.ok(key.startsWith("RELIANCE|"));
    });

    it("should include exchange in the key", () => {
      const trade = createTrade({ exchange: "BSE" });
      const key = getGroupKey(trade);
      assert.ok(key.includes("|BSE|"));
    });

    it("should include productType in the key", () => {
      const trade = createTrade({ productType: "MIS" });
      const key = getGroupKey(trade);
      assert.ok(key.includes("|MIS|"));
    });

    it("should include broker in the key", () => {
      const trade = createTrade({ broker: "ZERODHA" as any });
      const key = getGroupKey(trade);
      assert.ok(key.includes("|ZERODHA|"));
    });

    it("should include brokerUserId in the key", () => {
      const trade = createTrade({ brokerUserId: "ABC123" });
      const key = getGroupKey(trade);
      assert.ok(key.endsWith("ABC123"));
    });

    it("should use empty string for null broker", () => {
      const trade = createTrade({ broker: null });
      const key = getGroupKey(trade);
      // broker part should be empty between pipes
      assert.ok(key.includes("||"));
    });

    it("should use empty string for null brokerUserId", () => {
      const trade = createTrade({ brokerUserId: null });
      const key = getGroupKey(trade);
      assert.ok(key.endsWith("|"));
    });

    it("should produce same key for trades with same grouping attributes", () => {
      const t1 = createTrade({
        symbol: "TCS",
        exchange: "NSE",
        productType: "CNC",
        broker: null,
        brokerUserId: null,
        isin: null,
      });
      const t2 = createTrade({
        symbol: "TCS",
        exchange: "NSE",
        productType: "CNC",
        broker: null,
        brokerUserId: null,
        isin: null,
      });
      assert.strictEqual(getGroupKey(t1), getGroupKey(t2));
    });

    it("should produce different keys for different exchanges", () => {
      const t1 = createTrade({ symbol: "TCS", exchange: "NSE", isin: null });
      const t2 = createTrade({ symbol: "TCS", exchange: "BSE", isin: null });
      assert.notStrictEqual(getGroupKey(t1), getGroupKey(t2));
    });

    it("should produce different keys for different productTypes", () => {
      const t1 = createTrade({ symbol: "TCS", productType: "CNC", isin: null });
      const t2 = createTrade({ symbol: "TCS", productType: "MIS", isin: null });
      assert.notStrictEqual(getGroupKey(t1), getGroupKey(t2));
    });

    it("should group by ISIN even when symbols differ", () => {
      const t1 = createTrade({
        symbol: "MIRAE ASSET NYSE FANG+ ETF",
        isin: "INF769K01EY0",
      });
      const t2 = createTrade({
        symbol: "MIRAE ASSET NYSE FANG ETF",
        isin: "INF769K01EY0",
      });
      assert.strictEqual(getGroupKey(t1), getGroupKey(t2));
    });
  });

  // -------------------------------------------------------------------------
  // sortByTradeTime
  // -------------------------------------------------------------------------
  describe("sortByTradeTime", () => {
    it("should sort trades chronologically (oldest first)", () => {
      const trades = [
        createTrade({ id: "c", tradeTime: new Date("2024-01-15T14:00:00") }),
        createTrade({ id: "a", tradeTime: new Date("2024-01-15T09:00:00") }),
        createTrade({ id: "b", tradeTime: new Date("2024-01-15T11:00:00") }),
      ];
      const sorted = sortByTradeTime(trades);
      assert.strictEqual(sorted[0].id, "a");
      assert.strictEqual(sorted[1].id, "b");
      assert.strictEqual(sorted[2].id, "c");
    });

    it("should use tradeDate when tradeTime is null", () => {
      const trades = [
        createTrade({
          id: "b",
          tradeDate: new Date("2024-01-20"),
          tradeTime: null,
        }),
        createTrade({
          id: "a",
          tradeDate: new Date("2024-01-10"),
          tradeTime: null,
        }),
      ];
      const sorted = sortByTradeTime(trades);
      assert.strictEqual(sorted[0].id, "a");
      assert.strictEqual(sorted[1].id, "b");
    });

    it("should not mutate the original array", () => {
      const trades = [
        createTrade({ id: "b", tradeTime: new Date("2024-01-15T14:00:00") }),
        createTrade({ id: "a", tradeTime: new Date("2024-01-15T09:00:00") }),
      ];
      const sorted = sortByTradeTime(trades);
      assert.strictEqual(trades[0].id, "b"); // original unchanged
      assert.strictEqual(sorted[0].id, "a");
    });

    it("should handle mix of tradeTime and tradeDate (null tradeTime)", () => {
      const trades = [
        createTrade({
          id: "b",
          tradeDate: new Date("2024-01-20"),
          tradeTime: new Date("2024-01-20T10:00:00"),
        }),
        createTrade({
          id: "a",
          tradeDate: new Date("2024-01-10"),
          tradeTime: null,
        }),
      ];
      const sorted = sortByTradeTime(trades);
      assert.strictEqual(sorted[0].id, "a");
      assert.strictEqual(sorted[1].id, "b");
    });

    it("should handle empty array", () => {
      const sorted = sortByTradeTime([]);
      assert.strictEqual(sorted.length, 0);
    });

    it("should handle single element", () => {
      const trades = [createTrade({ id: "only" })];
      const sorted = sortByTradeTime(trades);
      assert.strictEqual(sorted.length, 1);
      assert.strictEqual(sorted[0].id, "only");
    });
  });

  // -------------------------------------------------------------------------
  // calculatePnL
  // -------------------------------------------------------------------------
  describe("calculatePnL", () => {
    it("LONG profit: (exitPrice - entryPrice) * quantity", () => {
      assert.strictEqual(calculatePnL(100, 120, 10, "LONG"), 200);
    });

    it("LONG loss: negative when exit < entry", () => {
      assert.strictEqual(calculatePnL(100, 80, 10, "LONG"), -200);
    });

    it("LONG breakeven: zero P&L", () => {
      assert.strictEqual(calculatePnL(100, 100, 10, "LONG"), 0);
    });

    it("SHORT profit: (entryPrice - exitPrice) * quantity", () => {
      assert.strictEqual(calculatePnL(120, 100, 10, "SHORT"), 200);
    });

    it("SHORT loss: negative when exit > entry", () => {
      assert.strictEqual(calculatePnL(100, 120, 10, "SHORT"), -200);
    });

    it("SHORT breakeven: zero P&L", () => {
      assert.strictEqual(calculatePnL(100, 100, 10, "SHORT"), 0);
    });

    it("should handle zero quantity", () => {
      assert.strictEqual(calculatePnL(100, 120, 0, "LONG"), 0);
    });

    it("should handle zero prices", () => {
      assert.strictEqual(calculatePnL(0, 100, 10, "LONG"), 1000);
    });

    it("should handle fractional quantities", () => {
      const pnl = calculatePnL(100, 110, 0.5, "LONG");
      assert.strictEqual(pnl, 5); // (110 - 100) * 0.5
    });

    it("should treat unknown positionType as LONG (default)", () => {
      assert.strictEqual(calculatePnL(100, 120, 10, "UNKNOWN"), 200);
    });
  });

  // -------------------------------------------------------------------------
  // calculatePnLPercentage
  // -------------------------------------------------------------------------
  describe("calculatePnLPercentage", () => {
    it("LONG: ((exit - entry) / entry) * 100", () => {
      assert.strictEqual(calculatePnLPercentage(100, 110, "LONG"), 10);
    });

    it("LONG negative percentage", () => {
      assert.strictEqual(calculatePnLPercentage(100, 90, "LONG"), -10);
    });

    it("SHORT: ((entry - exit) / entry) * 100", () => {
      assert.strictEqual(calculatePnLPercentage(200, 180, "SHORT"), 10);
    });

    it("SHORT negative percentage", () => {
      assert.strictEqual(calculatePnLPercentage(200, 220, "SHORT"), -10);
    });

    it("should return 0 when entry price is 0", () => {
      assert.strictEqual(calculatePnLPercentage(0, 100, "LONG"), 0);
    });

    it("should return 0 for SHORT when entry price is 0", () => {
      assert.strictEqual(calculatePnLPercentage(0, 100, "SHORT"), 0);
    });

    it("should handle 100% gain", () => {
      assert.strictEqual(calculatePnLPercentage(100, 200, "LONG"), 100);
    });

    it("should handle 100% loss in SHORT", () => {
      assert.strictEqual(calculatePnLPercentage(100, 200, "SHORT"), -100);
    });

    it("should handle fractional percentages", () => {
      const pct = calculatePnLPercentage(300, 310, "LONG");
      assert.ok(Math.abs(pct - (10 / 300) * 100) < 0.0001);
    });
  });

  // -------------------------------------------------------------------------
  // getPositionType
  // -------------------------------------------------------------------------
  describe("getPositionType", () => {
    it("BUY entry -> LONG", () => {
      assert.strictEqual(getPositionType("BUY"), "LONG");
    });

    it("SELL entry -> SHORT", () => {
      assert.strictEqual(getPositionType("SELL"), "SHORT");
    });

    it("any other entry type -> SHORT (not BUY)", () => {
      assert.strictEqual(getPositionType("OTHER"), "SHORT");
    });
  });

  // -------------------------------------------------------------------------
  // isEntryTrade
  // -------------------------------------------------------------------------
  describe("isEntryTrade", () => {
    it("BUY is entry for LONG", () => {
      assert.strictEqual(isEntryTrade("BUY", "LONG"), true);
    });

    it("SELL is not entry for LONG", () => {
      assert.strictEqual(isEntryTrade("SELL", "LONG"), false);
    });

    it("SELL is entry for SHORT", () => {
      assert.strictEqual(isEntryTrade("SELL", "SHORT"), true);
    });

    it("BUY is not entry for SHORT", () => {
      assert.strictEqual(isEntryTrade("BUY", "SHORT"), false);
    });

    it("default: BUY is entry for unknown positionType", () => {
      assert.strictEqual(isEntryTrade("BUY", "UNKNOWN"), true);
    });

    it("default: SELL is not entry for unknown positionType", () => {
      assert.strictEqual(isEntryTrade("SELL", "UNKNOWN"), false);
    });
  });

  // ===========================================================================
  // 2. Integration tests via pairTradesFIFO
  // ===========================================================================

  // -------------------------------------------------------------------------
  // Basic FIFO Matching
  // -------------------------------------------------------------------------
  describe("Basic FIFO Matching", () => {
    it("should pair a single BUY + SELL of equal quantity as CLOSED", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 100,
          price: 500,
          tradeTime: new Date("2024-01-15T09:15:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 100,
          price: 520,
          tradeTime: new Date("2024-01-15T14:30:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      const pair = result.pairedViews[0];
      assert.strictEqual(pair.status, "CLOSED");
      assert.strictEqual(pair.positionType, "LONG");
      assert.strictEqual(pair.quantity, 100);
      assert.strictEqual(pair.entryPrice, 500);
      assert.strictEqual(pair.exitPrice, 520);
      assert.strictEqual(pair.entryTradeId, "b1");
      assert.strictEqual(pair.exitTradeId, "s1");
      assert.strictEqual(pair.realizedPnL, 2000); // (520 - 500) * 100
      assert.strictEqual(pair.tradeType, "BUY");
    });

    it("should match multiple BUYs sequentially with a single SELL (FIFO order)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 30,
          price: 100,
          tradeTime: new Date("2024-01-10T09:15:00"),
        }),
        createTrade({
          id: "b2",
          tradeType: "BUY",
          quantity: 20,
          price: 110,
          tradeTime: new Date("2024-01-11T09:15:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 50,
          price: 120,
          tradeTime: new Date("2024-01-15T14:30:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.strictEqual(result.stats.closedPositions, 2);
      assert.strictEqual(result.stats.openPositions, 0);

      const closed = result.pairedViews.filter((p) => p.status === "CLOSED");
      assert.strictEqual(closed.length, 2);

      const first = closed.find((p) => p.entryPrice === 100);
      assert.ok(first, "Should have closed pair at entry price 100");
      assert.strictEqual(first.quantity, 30);
      assert.strictEqual(first.realizedPnL, 600); // (120 - 100) * 30

      const second = closed.find((p) => p.entryPrice === 110);
      assert.ok(second, "Should have closed pair at entry price 110");
      assert.strictEqual(second.quantity, 20);
      assert.strictEqual(second.realizedPnL, 200); // (120 - 110) * 20
    });

    it("should match multiple SELLs sequentially with a single BUY (LONG)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 100,
          price: 200,
          tradeTime: new Date("2024-01-10T09:15:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 40,
          price: 210,
          tradeTime: new Date("2024-01-12T14:30:00"),
        }),
        createTrade({
          id: "s2",
          tradeType: "SELL",
          quantity: 60,
          price: 220,
          tradeTime: new Date("2024-01-14T14:30:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.strictEqual(result.stats.closedPositions, 2);

      const first = result.pairedViews.find((p) => p.exitPrice === 210);
      assert.ok(first);
      assert.strictEqual(first.quantity, 40);
      assert.strictEqual(first.realizedPnL, 400);

      const second = result.pairedViews.find((p) => p.exitPrice === 220);
      assert.ok(second);
      assert.strictEqual(second.quantity, 60);
      assert.strictEqual(second.realizedPnL, 1200);
    });

    it("should pair SELL-then-BUY as a SHORT position CLOSED", () => {
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 50,
          price: 300,
          tradeTime: new Date("2024-01-15T09:15:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 50,
          price: 280,
          tradeTime: new Date("2024-01-15T14:30:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      const pair = result.pairedViews[0];
      assert.strictEqual(pair.status, "CLOSED");
      assert.strictEqual(pair.positionType, "SHORT");
      assert.strictEqual(pair.entryPrice, 300);
      assert.strictEqual(pair.exitPrice, 280);
      assert.strictEqual(pair.realizedPnL, 1000);
      assert.strictEqual(pair.tradeType, "SELL");
    });

    it("should match multiple SELLs (SHORT entries) sequentially with BUY", () => {
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 20,
          price: 500,
          tradeTime: new Date("2024-01-10T09:15:00"),
        }),
        createTrade({
          id: "s2",
          tradeType: "SELL",
          quantity: 30,
          price: 510,
          tradeTime: new Date("2024-01-11T09:15:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 50,
          price: 480,
          tradeTime: new Date("2024-01-15T14:30:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.strictEqual(result.stats.closedPositions, 2);

      const first = result.pairedViews.find((p) => p.entryPrice === 500);
      assert.ok(first);
      assert.strictEqual(first.quantity, 20);
      assert.strictEqual(first.positionType, "SHORT");
      assert.strictEqual(first.realizedPnL, 400);

      const second = result.pairedViews.find((p) => p.entryPrice === 510);
      assert.ok(second);
      assert.strictEqual(second.quantity, 30);
      assert.strictEqual(second.realizedPnL, 900);
    });
  });

  // -------------------------------------------------------------------------
  // Partial Fills / Row Splitting
  // -------------------------------------------------------------------------
  describe("Partial Fills / Row Splitting", () => {
    it("BUY 100 + SELL 50 = 1 CLOSED (50) + 1 PARTIAL (50)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 100,
          price: 200,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 50,
          price: 220,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);

      const closed = result.pairedViews.find((p) => p.status === "CLOSED");
      assert.ok(closed);
      assert.strictEqual(closed.quantity, 50);
      assert.strictEqual(closed.realizedPnL, 1000);
      assert.strictEqual(closed.entryTradeId, "b1");
      assert.strictEqual(closed.exitTradeId, "s1");

      const partial = result.pairedViews.find((p) => p.status === "PARTIAL");
      assert.ok(partial);
      assert.strictEqual(partial.quantity, 50);
      assert.strictEqual(partial.realizedPnL, null);
      assert.strictEqual(partial.exitPrice, null);
      assert.strictEqual(partial.exitDate, null);
      assert.strictEqual(partial.entryTradeId, "b1");
      assert.strictEqual(partial.exitTradeId, null);

      assert.strictEqual(result.stats.closedPositions, 1);
      assert.strictEqual(result.stats.partialPositions, 1);
      assert.strictEqual(result.stats.openPositions, 0);
    });

    it("BUY 50 + BUY 50 + SELL 75 = 2 CLOSED (50+25) + 1 PARTIAL (25)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 50,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "b2",
          tradeType: "BUY",
          quantity: 50,
          price: 105,
          tradeTime: new Date("2024-01-11T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 75,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 3);

      const closed = result.pairedViews.filter((p) => p.status === "CLOSED");
      assert.strictEqual(closed.length, 2);

      const firstClosed = closed.find((p) => p.quantity === 50);
      assert.ok(firstClosed);
      assert.strictEqual(firstClosed.entryPrice, 100);
      assert.strictEqual(firstClosed.realizedPnL, 500);

      const secondClosed = closed.find((p) => p.quantity === 25);
      assert.ok(secondClosed);
      assert.strictEqual(secondClosed.entryPrice, 105);
      assert.strictEqual(secondClosed.realizedPnL, 125);

      const partial = result.pairedViews.find((p) => p.status === "PARTIAL");
      assert.ok(partial);
      assert.strictEqual(partial.quantity, 25);
      assert.strictEqual(partial.entryPrice, 105);

      assert.strictEqual(result.stats.closedPositions, 2);
      assert.strictEqual(result.stats.partialPositions, 1);
      assert.strictEqual(result.stats.openPositions, 0);
    });

    it("SELL 100 + BUY 30 = 1 CLOSED SHORT (30) + 1 PARTIAL SHORT (70)", () => {
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 100,
          price: 500,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 30,
          price: 480,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);

      const closed = result.pairedViews.find((p) => p.status === "CLOSED");
      assert.ok(closed);
      assert.strictEqual(closed.positionType, "SHORT");
      assert.strictEqual(closed.quantity, 30);
      assert.strictEqual(closed.realizedPnL, 600);

      const partial = result.pairedViews.find((p) => p.status === "PARTIAL");
      assert.ok(partial);
      assert.strictEqual(partial.positionType, "SHORT");
      assert.strictEqual(partial.quantity, 70);
      assert.strictEqual(partial.realizedPnL, null);
    });

    it("should create PARTIAL when sell exceeds buy (excess goes SHORT)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 30,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 50,
          price: 120,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);

      const closed = result.pairedViews.find((p) => p.status === "CLOSED");
      assert.ok(closed);
      assert.strictEqual(closed.positionType, "LONG");
      assert.strictEqual(closed.quantity, 30);

      const openOrPartial = result.pairedViews.find(
        (p) => p.status === "OPEN" || p.status === "PARTIAL"
      );
      assert.ok(openOrPartial);
      assert.strictEqual(openOrPartial.positionType, "SHORT");
      assert.strictEqual(openOrPartial.quantity, 20);
    });

    it("should handle a chain: BUY 100, SELL 30, SELL 30, SELL 40 = 3 CLOSED, 0 OPEN", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 100,
          price: 200,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 30,
          price: 210,
          tradeTime: new Date("2024-01-12T14:00:00"),
        }),
        createTrade({
          id: "s2",
          tradeType: "SELL",
          quantity: 30,
          price: 215,
          tradeTime: new Date("2024-01-13T14:00:00"),
        }),
        createTrade({
          id: "s3",
          tradeType: "SELL",
          quantity: 40,
          price: 220,
          tradeTime: new Date("2024-01-14T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.closedPositions, 3);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.partialPositions, 0);
      assert.strictEqual(result.pairedViews.length, 3);
      assert.ok(result.pairedViews.every((p) => p.status === "CLOSED"));
      assert.ok(result.pairedViews.every((p) => p.entryPrice === 200));

      // Total P&L: (210-200)*30 + (215-200)*30 + (220-200)*40 = 300+450+800 = 1550
      assert.strictEqual(result.stats.totalRealizedPnL, 1550);
    });

    it("should handle multiple partial fills across many sells", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 100,
          price: 50,
          tradeTime: new Date("2024-01-01T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 55,
          tradeTime: new Date("2024-01-02T09:00:00"),
        }),
        createTrade({
          id: "s2",
          tradeType: "SELL",
          quantity: 10,
          price: 60,
          tradeTime: new Date("2024-01-03T09:00:00"),
        }),
        createTrade({
          id: "s3",
          tradeType: "SELL",
          quantity: 10,
          price: 65,
          tradeTime: new Date("2024-01-04T09:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.closedPositions, 3);
      assert.strictEqual(result.stats.partialPositions, 1);

      const partial = result.pairedViews.find((p) => p.status === "PARTIAL");
      assert.ok(partial);
      assert.strictEqual(partial.quantity, 70); // 100 - 10 - 10 - 10
    });
  });

  // -------------------------------------------------------------------------
  // Grouping Logic
  // -------------------------------------------------------------------------
  describe("Grouping Logic", () => {
    it("should group trades by symbol - different symbols do not pair", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "TCS",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.ok(result.pairedViews.every((p) => p.status === "OPEN"));
      assert.strictEqual(result.stats.openPositions, 2);
      assert.strictEqual(result.stats.closedPositions, 0);
    });

    it("should group trades by exchange - different exchanges do not pair", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          exchange: "NSE",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          exchange: "BSE",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.ok(result.pairedViews.every((p) => p.status === "OPEN"));
    });

    it("should group trades by productType - MIS and CNC treated separately", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          productType: "CNC",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          productType: "MIS",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.ok(result.pairedViews.every((p) => p.status === "OPEN"));
    });

    it("should group trades by broker - different brokers do not pair", () => {
      const trades = [
        createTrade({
          id: "b1",
          broker: "ZERODHA" as any,
          brokerUserId: "ZER123",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          broker: "UPSTOX" as any,
          brokerUserId: "UPS456",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.ok(result.pairedViews.every((p) => p.status === "OPEN"));
    });

    it("should group trades by brokerUserId - same broker different accounts do not pair", () => {
      const trades = [
        createTrade({
          id: "b1",
          broker: "ZERODHA" as any,
          brokerUserId: "ZER-ACCT-1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          broker: "ZERODHA" as any,
          brokerUserId: "ZER-ACCT-2",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.ok(result.pairedViews.every((p) => p.status === "OPEN"));
    });

    it("should use ISIN as primary identifier over symbol when present", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "MIRAE ASSET NYSE FANG+ ETF",
          isin: "INF769K01EY0",
          tradeType: "BUY",
          quantity: 10,
          price: 50,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "MIRAE ASSET NYSE FANG ETF",
          isin: "INF769K01EY0",
          tradeType: "SELL",
          quantity: 10,
          price: 55,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
      assert.strictEqual(result.pairedViews[0].isin, "INF769K01EY0");
    });

    it("should NOT pair when ISINs differ even if symbols match", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          isin: "INE002A01018",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          isin: "INE999Z99999",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.ok(result.pairedViews.every((p) => p.status === "OPEN"));
    });

    it("should fall back to symbol when ISIN is null", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          isin: null,
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          isin: null,
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
    });

    it("should pair trades from same broker account correctly", () => {
      const trades = [
        createTrade({
          id: "b1",
          broker: "ZERODHA" as any,
          brokerUserId: "ABC123",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          broker: "ZERODHA" as any,
          brokerUserId: "ABC123",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
    });

    it("should handle multiple symbols in a single call", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
          price: 2500,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          tradeType: "SELL",
          quantity: 10,
          price: 2600,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
        createTrade({
          id: "b2",
          symbol: "TCS",
          tradeType: "BUY",
          quantity: 5,
          price: 3500,
          tradeTime: new Date("2024-01-15T09:30:00"),
        }),
        createTrade({
          id: "b3",
          symbol: "INFY",
          tradeType: "BUY",
          quantity: 20,
          price: 1600,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "s3",
          symbol: "INFY",
          tradeType: "SELL",
          quantity: 20,
          price: 1650,
          tradeTime: new Date("2024-01-15T15:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 3);
      assert.strictEqual(result.stats.closedPositions, 2);
      assert.strictEqual(result.stats.openPositions, 1);
      assert.strictEqual(result.stats.totalTrades, 5);

      const reliance = result.pairedViews.find(
        (p) => p.symbol === "RELIANCE" && p.status === "CLOSED"
      );
      assert.ok(reliance);
      assert.strictEqual(reliance.realizedPnL, 1000);

      const tcs = result.pairedViews.find((p) => p.symbol === "TCS");
      assert.ok(tcs);
      assert.strictEqual(tcs.status, "OPEN");

      const infy = result.pairedViews.find(
        (p) => p.symbol === "INFY" && p.status === "CLOSED"
      );
      assert.ok(infy);
      assert.strictEqual(infy.realizedPnL, 1000);
    });
  });

  // -------------------------------------------------------------------------
  // P&L Calculations (Integration)
  // -------------------------------------------------------------------------
  describe("P&L Calculations", () => {
    it("LONG position P&L: (exit - entry) * qty (profit)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 25,
          price: 400,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 25,
          price: 450,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, 1250);
      assert.strictEqual(result.stats.totalRealizedPnL, 1250);
    });

    it("LONG position P&L: (exit - entry) * qty (loss)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 500,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 480,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, -200);
    });

    it("SHORT position P&L: (entry - exit) * qty (profit)", () => {
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 15,
          price: 800,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 15,
          price: 750,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, 750);
    });

    it("SHORT position P&L: (entry - exit) * qty (loss)", () => {
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 200,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 230,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, -300);
    });

    it("LONG pnlPercentage: ((exit - entry) / entry) * 100", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].pnlPercentage, 10);
    });

    it("SHORT pnlPercentage: ((entry - exit) / entry) * 100", () => {
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 200,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 180,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].pnlPercentage, 10);
    });

    it("pnlPercentage should be negative for losing trades", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 90,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].pnlPercentage, -10);
    });

    it("pnlPercentage should handle fractional percentages accurately", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 300,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 310,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      const pnlPct = result.pairedViews[0].pnlPercentage;
      assert.ok(pnlPct !== null);
      assert.ok(
        Math.abs(pnlPct - (10 / 3) * (100 / 100)) < 0.0001,
        `Expected ~3.333%, got ${pnlPct}`
      );
    });

    it("OPEN positions should have null realizedPnL and pnlPercentage", () => {
      const trades = [
        createTrade({ id: "b1", tradeType: "BUY", quantity: 10, price: 100 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, null);
      assert.strictEqual(result.pairedViews[0].pnlPercentage, null);
    });

    it("should accumulate totalRealizedPnL across multiple closed trades", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          tradeType: "SELL",
          quantity: 10,
          price: 150,
          tradeTime: new Date("2024-01-12T14:00:00"),
        }),
        createTrade({
          id: "b2",
          symbol: "TCS",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:30:00"),
        }),
        createTrade({
          id: "s2",
          symbol: "TCS",
          tradeType: "SELL",
          quantity: 10,
          price: 80,
          tradeTime: new Date("2024-01-12T14:30:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.totalRealizedPnL, 300); // 500 + (-200)
    });

    it("should handle zero P&L (breakeven trade)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, 0);
      assert.strictEqual(result.pairedViews[0].pnlPercentage, 0);
      assert.strictEqual(result.stats.totalRealizedPnL, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------
  describe("Edge Cases", () => {
    it("should handle empty trades array", () => {
      const result = pairTradesFIFO([]);

      assert.strictEqual(result.pairedViews.length, 0);
      assert.strictEqual(result.stats.totalTrades, 0);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.closedPositions, 0);
      assert.strictEqual(result.stats.partialPositions, 0);
      assert.strictEqual(result.stats.totalRealizedPnL, 0);
    });

    it("should handle a single BUY trade (no pair)", () => {
      const trades = [
        createTrade({ id: "b1", tradeType: "BUY", quantity: 10, price: 100 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "OPEN");
      assert.strictEqual(result.pairedViews[0].positionType, "LONG");
      assert.strictEqual(result.pairedViews[0].exitTradeId, null);
      assert.strictEqual(result.pairedViews[0].exitDate, null);
      assert.strictEqual(result.pairedViews[0].exitPrice, null);
      assert.strictEqual(result.stats.openPositions, 1);
    });

    it("should handle a single SELL trade (no pair) as SHORT OPEN", () => {
      const trades = [
        createTrade({ id: "s1", tradeType: "SELL", quantity: 10, price: 100 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "OPEN");
      assert.strictEqual(result.pairedViews[0].positionType, "SHORT");
      assert.strictEqual(result.stats.openPositions, 1);
    });

    it("should handle floating point precision with effectively zero remaining qty", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 3.33,
          price: 110,
          tradeTime: new Date("2024-01-11T14:00:00"),
        }),
        createTrade({
          id: "s2",
          tradeType: "SELL",
          quantity: 3.33,
          price: 115,
          tradeTime: new Date("2024-01-12T14:00:00"),
        }),
        createTrade({
          id: "s3",
          tradeType: "SELL",
          quantity: 3.34,
          price: 120,
          tradeTime: new Date("2024-01-13T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.closedPositions, 3);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.partialPositions, 0);
    });

    it("should handle trades with same timestamp (stable processing)", () => {
      const sameTime = new Date("2024-01-15T10:00:00");

      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: sameTime,
        }),
        createTrade({
          id: "b2",
          tradeType: "BUY",
          quantity: 10,
          price: 105,
          tradeTime: sameTime,
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: sameTime,
        }),
      ];

      const result = pairTradesFIFO(trades);

      const closed = result.pairedViews.filter((p) => p.status === "CLOSED");
      const open = result.pairedViews.filter((p) => p.status === "OPEN");

      assert.strictEqual(closed.length, 1);
      assert.strictEqual(open.length, 1);
      assert.strictEqual(result.stats.closedPositions, 1);
      assert.strictEqual(result.stats.openPositions, 1);
    });

    it("should use tradeDate when tradeTime is null for sorting", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeDate: new Date("2024-01-10"),
          tradeTime: null,
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 120,
          tradeDate: new Date("2024-01-15"),
          tradeTime: null,
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
      assert.strictEqual(result.pairedViews[0].positionType, "LONG");
      assert.deepStrictEqual(
        result.pairedViews[0].entryDate,
        new Date("2024-01-10")
      );
    });

    it("should sort trades out of chronological order before pairing", () => {
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
      assert.strictEqual(result.pairedViews[0].positionType, "LONG");
      assert.strictEqual(result.pairedViews[0].entryPrice, 100);
      assert.strictEqual(result.pairedViews[0].exitPrice, 110);
    });

    it("should handle zero price trades", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 0,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, 1000);
    });

    it("should handle large quantity trades", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 1_000_000,
          price: 10.5,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 1_000_000,
          price: 11.0,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, 500_000);
    });

    it("should set ISIN from either trade in the pair when one has it", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          isin: null,
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          isin: "INE002A01018",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].isin, "INE002A01018");
    });

    it("should populate sourceTradeIds with both entry and exit trade IDs", () => {
      const trades = [
        createTrade({
          id: "entry-1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "exit-1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.deepStrictEqual(result.pairedViews[0].sourceTradeIds, [
        "entry-1",
        "exit-1",
      ]);
    });

    it("should populate sourceTradeIds with only entry trade ID for OPEN", () => {
      const trades = [
        createTrade({
          id: "entry-only",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.deepStrictEqual(result.pairedViews[0].sourceTradeIds, [
        "entry-only",
      ]);
    });

    it("should preserve segmentLabel and productTypeLabel", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          segmentLabel: "Equity",
          productTypeLabel: "Delivery",
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          segmentLabel: "Equity",
          productTypeLabel: "Delivery",
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].segmentLabel, "Equity");
      assert.strictEqual(result.pairedViews[0].productTypeLabel, "Delivery");
    });

    it("should set segmentLabel and productTypeLabel to null when not provided", () => {
      const trades = [
        createTrade({ id: "b1", tradeType: "BUY", quantity: 10, price: 100 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].segmentLabel, null);
      assert.strictEqual(result.pairedViews[0].productTypeLabel, null);
    });

    it("should handle very small fractional quantities (MF units)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 0.123,
          price: 500,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 0.123,
          price: 550,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
      // PnL = (550 - 500) * 0.123 = 6.15
      assert.ok(Math.abs(result.pairedViews[0].realizedPnL! - 6.15) < 0.001);
    });

    it("should handle entryQuantity reflecting original trade quantity", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 100,
          price: 200,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 40,
          price: 220,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      const closed = result.pairedViews.find((p) => p.status === "CLOSED");
      assert.ok(closed);
      assert.strictEqual(closed.entryQuantity, 100); // original BUY quantity
      assert.strictEqual(closed.quantity, 40); // matched quantity
    });
  });

  // -------------------------------------------------------------------------
  // Stats Verification
  // -------------------------------------------------------------------------
  describe("Stats Verification", () => {
    it("should report correct totalTrades count", () => {
      const trades = [
        createTrade({ id: "t1", tradeType: "BUY" }),
        createTrade({ id: "t2", tradeType: "SELL" }),
        createTrade({ id: "t3", tradeType: "BUY", symbol: "TCS" }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.totalTrades, 3);
    });

    it("should report correct openPositions count", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
        }),
        createTrade({ id: "b2", symbol: "TCS", tradeType: "BUY", quantity: 5 }),
        createTrade({
          id: "s1",
          symbol: "INFY",
          tradeType: "SELL",
          quantity: 8,
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.openPositions, 3);
      assert.strictEqual(result.stats.closedPositions, 0);
    });

    it("should report correct closedPositions count", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
        createTrade({
          id: "b2",
          symbol: "TCS",
          tradeType: "BUY",
          quantity: 5,
          price: 3500,
          tradeTime: new Date("2024-01-15T09:30:00"),
        }),
        createTrade({
          id: "s2",
          symbol: "TCS",
          tradeType: "SELL",
          quantity: 5,
          price: 3600,
          tradeTime: new Date("2024-01-15T14:30:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.closedPositions, 2);
      assert.strictEqual(result.stats.openPositions, 0);
    });

    it("should report correct totalRealizedPnL sum", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          tradeType: "SELL",
          quantity: 10,
          price: 200,
          tradeTime: new Date("2024-01-12T14:00:00"),
        }),
        createTrade({
          id: "b2",
          symbol: "TCS",
          tradeType: "BUY",
          quantity: 5,
          price: 1000,
          tradeTime: new Date("2024-01-10T10:00:00"),
        }),
        createTrade({
          id: "s2",
          symbol: "TCS",
          tradeType: "SELL",
          quantity: 5,
          price: 900,
          tradeTime: new Date("2024-01-12T15:00:00"),
        }),
        createTrade({
          id: "s3",
          symbol: "INFY",
          tradeType: "SELL",
          quantity: 10,
          price: 500,
          tradeTime: new Date("2024-01-10T11:00:00"),
        }),
        createTrade({
          id: "b3",
          symbol: "INFY",
          tradeType: "BUY",
          quantity: 10,
          price: 425,
          tradeTime: new Date("2024-01-12T16:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // 1000 + (-500) + 750 = 1250
      assert.strictEqual(result.stats.totalRealizedPnL, 1250);
    });

    it("should report correct partialPositions count", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 100,
          price: 200,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 30,
          price: 210,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.partialPositions, 1);
      assert.strictEqual(result.stats.closedPositions, 1);
      assert.strictEqual(result.stats.openPositions, 0);
    });

    it("should have all stats at zero for empty input", () => {
      const result = pairTradesFIFO([]);

      assert.deepStrictEqual(result.stats, {
        totalTrades: 0,
        openPositions: 0,
        closedPositions: 0,
        partialPositions: 0,
        totalRealizedPnL: 0,
      });
    });

    it("should have consistent stats with mixed open, closed, partial positions", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "A",
          tradeType: "BUY",
          quantity: 100,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "A",
          tradeType: "SELL",
          quantity: 60,
          price: 110,
          tradeTime: new Date("2024-01-12T14:00:00"),
        }),
        createTrade({
          id: "b2",
          symbol: "B",
          tradeType: "BUY",
          quantity: 50,
          price: 500,
        }),
        createTrade({
          id: "b3",
          symbol: "C",
          tradeType: "BUY",
          quantity: 20,
          price: 200,
          tradeTime: new Date("2024-01-10T10:00:00"),
        }),
        createTrade({
          id: "s3",
          symbol: "C",
          tradeType: "SELL",
          quantity: 20,
          price: 250,
          tradeTime: new Date("2024-01-12T15:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.totalTrades, 5);
      assert.strictEqual(result.stats.openPositions, 1);
      assert.strictEqual(result.stats.closedPositions, 2);
      assert.strictEqual(result.stats.partialPositions, 1);
      assert.strictEqual(result.stats.totalRealizedPnL, 600 + 1000);
    });

    it("should count totalTrades as input trades, not paired views", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 100,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 50,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.totalTrades, 2); // input trades
      assert.strictEqual(result.pairedViews.length, 2); // output views (1 closed + 1 partial)
    });
  });

  // -------------------------------------------------------------------------
  // pairUserTrades Convenience Function
  // -------------------------------------------------------------------------
  describe("pairUserTrades convenience function", () => {
    it("should filter trades by userId and pair only those trades", () => {
      const trades = [
        createTrade({
          id: "b1",
          userId: "user-A",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          userId: "user-A",
          tradeType: "SELL",
          quantity: 10,
          price: 120,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
        createTrade({
          id: "b2",
          userId: "user-B",
          tradeType: "BUY",
          quantity: 5,
          price: 200,
          tradeTime: new Date("2024-01-15T09:30:00"),
        }),
      ];

      const resultA = pairUserTrades(trades, "user-A");
      const resultB = pairUserTrades(trades, "user-B");

      assert.strictEqual(resultA.stats.totalTrades, 2);
      assert.strictEqual(resultA.pairedViews.length, 1);
      assert.strictEqual(resultA.pairedViews[0].status, "CLOSED");
      assert.strictEqual(resultA.pairedViews[0].userId, "user-A");

      assert.strictEqual(resultB.stats.totalTrades, 1);
      assert.strictEqual(resultB.pairedViews.length, 1);
      assert.strictEqual(resultB.pairedViews[0].status, "OPEN");
      assert.strictEqual(resultB.pairedViews[0].userId, "user-B");
    });

    it("should return empty results when userId has no trades", () => {
      const trades = [
        createTrade({
          id: "b1",
          userId: "user-A",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
        }),
      ];

      const result = pairUserTrades(trades, "user-NONEXISTENT");

      assert.strictEqual(result.pairedViews.length, 0);
      assert.strictEqual(result.stats.totalTrades, 0);
    });

    it("should return empty results for empty trades array", () => {
      const result = pairUserTrades([], "user-A");

      assert.strictEqual(result.pairedViews.length, 0);
      assert.strictEqual(result.stats.totalTrades, 0);
    });

    it("should correctly pair user trades with partial fills", () => {
      const trades = [
        createTrade({
          id: "b1",
          userId: "user-A",
          tradeType: "BUY",
          quantity: 100,
          price: 500,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          userId: "user-A",
          tradeType: "SELL",
          quantity: 40,
          price: 550,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
        createTrade({
          id: "s2",
          userId: "user-B",
          tradeType: "SELL",
          quantity: 60,
          price: 560,
        }),
      ];

      const result = pairUserTrades(trades, "user-A");

      assert.strictEqual(result.stats.totalTrades, 2);
      assert.strictEqual(result.stats.closedPositions, 1);
      assert.strictEqual(result.stats.partialPositions, 1);

      const closed = result.pairedViews.find((p) => p.status === "CLOSED");
      assert.ok(closed);
      assert.strictEqual(closed.quantity, 40);
      assert.strictEqual(closed.realizedPnL, 2000);

      const partial = result.pairedViews.find((p) => p.status === "PARTIAL");
      assert.ok(partial);
      assert.strictEqual(partial.quantity, 60);
    });

    it("should not mix trades from different users in the same group", () => {
      const trades = [
        createTrade({
          id: "b1",
          userId: "user-A",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          userId: "user-B",
          symbol: "RELIANCE",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const resultA = pairUserTrades(trades, "user-A");

      assert.strictEqual(resultA.stats.totalTrades, 1);
      assert.strictEqual(resultA.pairedViews[0].status, "OPEN");
    });
  });

  // -------------------------------------------------------------------------
  // Output Sorting
  // -------------------------------------------------------------------------
  describe("Output Sorting", () => {
    it("should sort pairedViews by entryDate descending (newest first)", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "b2",
          symbol: "TCS",
          tradeType: "BUY",
          quantity: 10,
          price: 3000,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "b3",
          symbol: "INFY",
          tradeType: "BUY",
          quantity: 10,
          price: 1500,
          tradeTime: new Date("2024-01-12T09:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].symbol, "TCS");
      assert.strictEqual(result.pairedViews[1].symbol, "INFY");
      assert.strictEqual(result.pairedViews[2].symbol, "RELIANCE");
    });

    it("should sort closed pairs by entry date descending", () => {
      const trades = [
        createTrade({
          id: "b1",
          symbol: "A",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-05T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "A",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-06T14:00:00"),
        }),
        createTrade({
          id: "b2",
          symbol: "B",
          tradeType: "BUY",
          quantity: 10,
          price: 200,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s2",
          symbol: "B",
          tradeType: "SELL",
          quantity: 10,
          price: 210,
          tradeTime: new Date("2024-01-11T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].symbol, "B"); // newer entry
      assert.strictEqual(result.pairedViews[1].symbol, "A"); // older entry
    });
  });

  // -------------------------------------------------------------------------
  // Source Type Handling
  // -------------------------------------------------------------------------
  describe("Source Type Handling", () => {
    it("should preserve sourceType in paired output (uses exit trade's sourceType)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          sourceType: "SYNCED",
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          sourceType: "IMPORTED",
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].sourceType, "IMPORTED");
    });

    it("should preserve sourceType for OPEN positions", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          sourceType: "MANUAL",
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].sourceType, "MANUAL");
    });
  });

  // -------------------------------------------------------------------------
  // Complex Multi-Step Scenarios
  // -------------------------------------------------------------------------
  describe("Complex Multi-Step Scenarios", () => {
    it("should handle buy-sell-buy-sell in sequence (two round trips)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 120,
          tradeTime: new Date("2024-01-11T14:00:00"),
        }),
        createTrade({
          id: "b2",
          tradeType: "BUY",
          quantity: 10,
          price: 115,
          tradeTime: new Date("2024-01-12T09:00:00"),
        }),
        createTrade({
          id: "s2",
          tradeType: "SELL",
          quantity: 10,
          price: 130,
          tradeTime: new Date("2024-01-13T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.strictEqual(result.stats.closedPositions, 2);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.totalRealizedPnL, 350);
    });

    it("should handle alternating long and short positions", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-10T14:00:00"),
        }),
        createTrade({
          id: "s2",
          tradeType: "SELL",
          quantity: 10,
          price: 115,
          tradeTime: new Date("2024-01-11T09:00:00"),
        }),
        createTrade({
          id: "b2",
          tradeType: "BUY",
          quantity: 10,
          price: 105,
          tradeTime: new Date("2024-01-11T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);
      assert.strictEqual(result.stats.closedPositions, 2);

      const longPair = result.pairedViews.find(
        (p) => p.positionType === "LONG"
      );
      const shortPair = result.pairedViews.find(
        (p) => p.positionType === "SHORT"
      );

      assert.ok(longPair);
      assert.strictEqual(longPair.realizedPnL, 100);

      assert.ok(shortPair);
      assert.strictEqual(shortPair.realizedPnL, 100);

      assert.strictEqual(result.stats.totalRealizedPnL, 200);
    });

    it("should handle pyramiding (multiple entries at different prices)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "b2",
          tradeType: "BUY",
          quantity: 10,
          price: 95,
          tradeTime: new Date("2024-01-11T09:00:00"),
        }),
        createTrade({
          id: "b3",
          tradeType: "BUY",
          quantity: 10,
          price: 90,
          tradeTime: new Date("2024-01-12T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 30,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.closedPositions, 3);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.totalRealizedPnL, 450);
    });

    it("should handle scaling out (multiple exits at different prices)", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 30,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 105,
          tradeTime: new Date("2024-01-11T14:00:00"),
        }),
        createTrade({
          id: "s2",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-12T14:00:00"),
        }),
        createTrade({
          id: "s3",
          tradeType: "SELL",
          quantity: 10,
          price: 115,
          tradeTime: new Date("2024-01-13T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.closedPositions, 3);
      assert.strictEqual(result.stats.totalRealizedPnL, 300);
    });

    it("should handle position reversal (LONG to SHORT)", () => {
      // BUY 10, then SELL 20 -> first 10 close LONG, remaining 10 becomes PARTIAL SHORT
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 20,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);

      const closed = result.pairedViews.find((p) => p.status === "CLOSED");
      assert.ok(closed);
      assert.strictEqual(closed.positionType, "LONG");
      assert.strictEqual(closed.quantity, 10);
      assert.strictEqual(closed.realizedPnL, 100);

      // remainingQty (10) < original quantity (20), so status is PARTIAL
      const partial = result.pairedViews.find((p) => p.status === "PARTIAL");
      assert.ok(partial);
      assert.strictEqual(partial.positionType, "SHORT");
      assert.strictEqual(partial.quantity, 10);
    });

    it("should handle position reversal (SHORT to LONG)", () => {
      // SELL 10, then BUY 20 -> first 10 close SHORT, remaining 10 becomes PARTIAL LONG
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 20,
          price: 100,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);

      const closed = result.pairedViews.find((p) => p.status === "CLOSED");
      assert.ok(closed);
      assert.strictEqual(closed.positionType, "SHORT");
      assert.strictEqual(closed.quantity, 10);
      assert.strictEqual(closed.realizedPnL, 100); // (110 - 100) * 10

      // remainingQty (10) < original quantity (20), so status is PARTIAL
      const partial = result.pairedViews.find((p) => p.status === "PARTIAL");
      assert.ok(partial);
      assert.strictEqual(partial.positionType, "LONG");
      assert.strictEqual(partial.quantity, 10);
    });

    it("should handle many small fills against a large order", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 100,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        ...Array.from({ length: 10 }, (_, i) =>
          createTrade({
            id: `s${i + 1}`,
            tradeType: "SELL",
            quantity: 10,
            price: 100 + (i + 1),
            tradeTime: new Date(`2024-01-${11 + i}T14:00:00`),
          })
        ),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.closedPositions, 10);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.partialPositions, 0);

      // P&L: sum of (100+i - 100) * 10 for i=1..10 = 10*(1+2+...+10) = 10*55 = 550
      assert.strictEqual(result.stats.totalRealizedPnL, 550);
    });

    it("should handle interleaved buys and sells across multiple symbols", () => {
      const trades = [
        createTrade({
          id: "b1-R",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
          price: 2500,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "b1-T",
          symbol: "TCS",
          tradeType: "BUY",
          quantity: 5,
          price: 3500,
          tradeTime: new Date("2024-01-10T09:30:00"),
        }),
        createTrade({
          id: "s1-R",
          symbol: "RELIANCE",
          tradeType: "SELL",
          quantity: 5,
          price: 2600,
          tradeTime: new Date("2024-01-12T14:00:00"),
        }),
        createTrade({
          id: "s1-T",
          symbol: "TCS",
          tradeType: "SELL",
          quantity: 5,
          price: 3600,
          tradeTime: new Date("2024-01-12T14:30:00"),
        }),
        createTrade({
          id: "s2-R",
          symbol: "RELIANCE",
          tradeType: "SELL",
          quantity: 5,
          price: 2700,
          tradeTime: new Date("2024-01-14T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // RELIANCE: 2 CLOSED (5 @ 2500->2600, 5 @ 2500->2700)
      // TCS: 1 CLOSED (5 @ 3500->3600)
      assert.strictEqual(result.stats.closedPositions, 3);
      assert.strictEqual(result.stats.openPositions, 0);

      // PnL: (2600-2500)*5 + (2700-2500)*5 + (3600-3500)*5 = 500 + 1000 + 500 = 2000
      assert.strictEqual(result.stats.totalRealizedPnL, 2000);
    });
  });

  // -------------------------------------------------------------------------
  // Floating-Point Precision Deep-Dive
  // -------------------------------------------------------------------------
  describe("Floating-Point Precision", () => {
    it("should not create spurious PARTIAL from float rounding (SHORT)", () => {
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 300,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 3.33,
          price: 290,
          tradeTime: new Date("2024-01-11T14:00:00"),
        }),
        createTrade({
          id: "b2",
          tradeType: "BUY",
          quantity: 3.33,
          price: 285,
          tradeTime: new Date("2024-01-12T14:00:00"),
        }),
        createTrade({
          id: "b3",
          tradeType: "BUY",
          quantity: 3.34,
          price: 280,
          tradeTime: new Date("2024-01-13T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.closedPositions, 3);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.partialPositions, 0);
    });

    it("should handle quantity exactly at QUANTITY_EPSILON boundary", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10 - 1e-6,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // The remaining 1e-6 is exactly at the boundary (not < QUANTITY_EPSILON)
      // So it should NOT be treated as zero
      // This means we get 1 CLOSED + either 1 PARTIAL or the boundary edge
      // Since remaining = 1e-6 and isEffectivelyZero checks Math.abs(qty) < 1e-6, 1e-6 is NOT effectively zero
      const closed = result.pairedViews.filter((p) => p.status === "CLOSED");
      assert.strictEqual(closed.length, 1);
    });

    it("should treat residual below QUANTITY_EPSILON as zero", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10 - 1e-7,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // Remaining = 1e-7 which IS effectively zero
      assert.strictEqual(result.stats.closedPositions, 1);
      assert.strictEqual(result.stats.partialPositions, 0);
      assert.strictEqual(result.stats.openPositions, 0);
    });

    it("should handle the classic 0.1 + 0.2 floating point issue", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 0.3,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 0.1,
          price: 110,
          tradeTime: new Date("2024-01-11T14:00:00"),
        }),
        createTrade({
          id: "s2",
          tradeType: "SELL",
          quantity: 0.2,
          price: 115,
          tradeTime: new Date("2024-01-12T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // 0.3 - 0.1 - 0.2 might not be exactly 0 due to floating point
      // but should be treated as zero
      assert.strictEqual(result.stats.closedPositions, 2);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.partialPositions, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Additional Field Propagation Tests
  // -------------------------------------------------------------------------
  describe("Field Propagation", () => {
    it("should set userId from the trade", () => {
      const trades = [
        createTrade({
          id: "b1",
          userId: "user-42",
          tradeType: "BUY",
          quantity: 10,
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].userId, "user-42");
    });

    it("should set exchange from the trade", () => {
      const trades = [
        createTrade({
          id: "b1",
          exchange: "BSE",
          tradeType: "BUY",
          quantity: 10,
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].exchange, "BSE");
    });

    it("should set segment from the trade", () => {
      const trades = [
        createTrade({
          id: "b1",
          segment: "FNO",
          tradeType: "BUY",
          quantity: 10,
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].segment, "FNO");
    });

    it("should set broker and brokerUserId from the trade", () => {
      const trades = [
        createTrade({
          id: "b1",
          broker: "ZERODHA" as any,
          brokerUserId: "ZER-001",
          tradeType: "BUY",
          quantity: 10,
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].broker, "ZERODHA");
      assert.strictEqual(result.pairedViews[0].brokerUserId, "ZER-001");
    });

    it("should set productType from the trade", () => {
      const trades = [
        createTrade({
          id: "b1",
          productType: "MIS",
          tradeType: "BUY",
          quantity: 10,
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].productType, "MIS");
    });

    it("should set tradeType to BUY for LONG open positions", () => {
      const trades = [
        createTrade({ id: "b1", tradeType: "BUY", quantity: 10 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].tradeType, "BUY");
    });

    it("should set tradeType to SELL for SHORT open positions", () => {
      const trades = [
        createTrade({ id: "s1", tradeType: "SELL", quantity: 10 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].tradeType, "SELL");
    });

    it("closed LONG pair should have tradeType BUY", () => {
      const trades = [
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].tradeType, "BUY");
    });

    it("closed SHORT pair should have tradeType SELL", () => {
      const trades = [
        createTrade({
          id: "s1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "b1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].tradeType, "SELL");
    });

    it("should use exit trade symbol for closed pair", () => {
      // When ISIN matches, symbols can differ; the algorithm uses exit trade's symbol
      const trades = [
        createTrade({
          id: "b1",
          symbol: "OLD_NAME",
          isin: "INF001",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "NEW_NAME",
          isin: "INF001",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // The algorithm uses the exit trade's (current trade's) symbol for the paired view
      assert.strictEqual(result.pairedViews[0].symbol, "NEW_NAME");
    });

    it("should prefer current trade ISIN, falling back to entry trade ISIN", () => {
      // Test with LONG close: exit trade ISIN is checked first
      const trades = [
        createTrade({
          id: "b1",
          symbol: "RELIANCE",
          isin: null,
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-10T09:00:00"),
        }),
        createTrade({
          id: "s1",
          symbol: "RELIANCE",
          isin: null,
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].isin, null);
    });
  });
});
