/**
 * FIFO Trade Pairing Algorithm Tests
 *
 * Tests for the trade pairing logic that matches buy/sell trades
 * using First-In-First-Out matching with row splitting for partial fills.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pairTradesFIFO,
  type TradeInput,
  type PairingResult,
} from "@usemoney/core/pairing";

// Helper to create a mock trade
function createTrade(overrides: Partial<TradeInput> = {}): TradeInput {
  return {
    id: `trade-${Math.random().toString(36).substr(2, 9)}`,
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

describe("FIFO Trade Pairing Algorithm", () => {
  describe("Basic Pairing", () => {
    it("should create an OPEN position for a single BUY trade", () => {
      const trades = [
        createTrade({ id: "t1", tradeType: "BUY", quantity: 10, price: 100 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "OPEN");
      assert.strictEqual(result.pairedViews[0].positionType, "LONG");
      assert.strictEqual(result.pairedViews[0].quantity, 10);
      assert.strictEqual(result.pairedViews[0].entryPrice, 100);
      assert.strictEqual(result.pairedViews[0].exitPrice, null);
      assert.strictEqual(result.pairedViews[0].realizedPnL, null);
      assert.strictEqual(result.stats.openPositions, 1);
      assert.strictEqual(result.stats.closedPositions, 0);
    });

    it("should create an OPEN position for a single SELL trade (SHORT)", () => {
      const trades = [
        createTrade({ id: "t1", tradeType: "SELL", quantity: 10, price: 100 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "OPEN");
      assert.strictEqual(result.pairedViews[0].positionType, "SHORT");
      assert.strictEqual(result.pairedViews[0].quantity, 10);
    });

    it("should pair BUY and SELL trades of equal quantity as CLOSED", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
      assert.strictEqual(result.pairedViews[0].positionType, "LONG");
      assert.strictEqual(result.pairedViews[0].entryPrice, 100);
      assert.strictEqual(result.pairedViews[0].exitPrice, 110);
      assert.strictEqual(result.pairedViews[0].quantity, 10);
      // P&L = (110 - 100) * 10 = 100
      assert.strictEqual(result.pairedViews[0].realizedPnL, 100);
      assert.strictEqual(result.stats.closedPositions, 1);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.totalRealizedPnL, 100);
    });

    it("should pair SELL and BUY trades for SHORT position", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
      assert.strictEqual(result.pairedViews[0].positionType, "SHORT");
      assert.strictEqual(result.pairedViews[0].entryPrice, 110);
      assert.strictEqual(result.pairedViews[0].exitPrice, 100);
      // SHORT P&L = (entryPrice - exitPrice) * quantity = (110 - 100) * 10 = 100
      assert.strictEqual(result.pairedViews[0].realizedPnL, 100);
    });
  });

  describe("Partial Fill / Row Splitting", () => {
    it("should split trades when BUY quantity > SELL quantity", () => {
      // Buy 10, Sell 4 → 4 closed + 6 open
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 4,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);

      // Find closed and open positions
      const closedPos = result.pairedViews.find((p) => p.status === "CLOSED");
      const partialPos = result.pairedViews.find(
        (p) => p.status === "PARTIAL" || p.status === "OPEN"
      );

      assert.ok(closedPos, "Should have a closed position");
      assert.ok(partialPos, "Should have an open/partial position");

      assert.strictEqual(closedPos.quantity, 4);
      assert.strictEqual(closedPos.realizedPnL, 40); // (110-100)*4

      // Remaining open position
      assert.strictEqual(partialPos.quantity, 6);
      assert.strictEqual(partialPos.realizedPnL, null);
    });

    it("should split trades when SELL quantity > BUY quantity", () => {
      // Buy 4, Sell 10 → 4 closed (LONG) + 6 open (SHORT)
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 4,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 2);

      const closedPos = result.pairedViews.find((p) => p.status === "CLOSED");
      const openPos = result.pairedViews.find(
        (p) => p.status === "OPEN" || p.status === "PARTIAL"
      );

      assert.ok(closedPos);
      assert.ok(openPos);

      // Closed LONG position
      assert.strictEqual(closedPos.positionType, "LONG");
      assert.strictEqual(closedPos.quantity, 4);

      // Remaining SHORT position
      assert.strictEqual(openPos.positionType, "SHORT");
      assert.strictEqual(openPos.quantity, 6);
    });

    it("should mark position as PARTIAL when partially closed", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 3,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      const partialPos = result.pairedViews.find((p) => p.status === "PARTIAL");
      assert.ok(partialPos, "Should have a PARTIAL position");
      assert.strictEqual(partialPos.quantity, 7);
      assert.strictEqual(result.stats.partialPositions, 1);
    });
  });

  describe("FIFO Order", () => {
    it("should match oldest BUY first when multiple BUYs exist", () => {
      const trades = [
        createTrade({
          id: "buy1",
          tradeType: "BUY",
          quantity: 5,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "buy2",
          tradeType: "BUY",
          quantity: 5,
          price: 105,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "sell1",
          tradeType: "SELL",
          quantity: 5,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // Should have 1 closed (from buy1) and 1 open (from buy2)
      const closedPos = result.pairedViews.find((p) => p.status === "CLOSED");
      const openPos = result.pairedViews.find((p) => p.status === "OPEN");

      assert.ok(closedPos);
      assert.ok(openPos);

      // Closed position should use the OLDER buy price (100)
      assert.strictEqual(closedPos.entryPrice, 100);
      // Open position should be the NEWER buy (105)
      assert.strictEqual(openPos.entryPrice, 105);
    });

    it("should match multiple SELLs in FIFO order across multiple BUYs", () => {
      const trades = [
        createTrade({
          id: "buy1",
          tradeType: "BUY",
          quantity: 3,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "buy2",
          tradeType: "BUY",
          quantity: 4,
          price: 105,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "sell1",
          tradeType: "SELL",
          quantity: 5,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // Buy1 (3) fully closed, Buy2 partially closed (2), remaining 2 open
      const closedPositions = result.pairedViews.filter(
        (p) => p.status === "CLOSED"
      );

      assert.strictEqual(closedPositions.length, 2);
      assert.strictEqual(result.stats.closedPositions, 2);

      // First closed: 3 units at entry 100
      const firstClosed = closedPositions.find((p) => p.quantity === 3);
      assert.ok(firstClosed);
      assert.strictEqual(firstClosed.entryPrice, 100);

      // Second closed: 2 units at entry 105
      const secondClosed = closedPositions.find((p) => p.quantity === 2);
      assert.ok(secondClosed);
      assert.strictEqual(secondClosed.entryPrice, 105);
    });
  });

  describe("Grouping by Symbol/Exchange/ProductType/Broker", () => {
    it("should pair trades within same symbol only", () => {
      const trades = [
        createTrade({
          id: "t1",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
        }),
        createTrade({
          id: "t2",
          symbol: "TCS",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
        }),
      ];

      const result = pairTradesFIFO(trades);

      // Both should be OPEN since they're different symbols
      assert.strictEqual(result.pairedViews.length, 2);
      assert.ok(result.pairedViews.every((p) => p.status === "OPEN"));
    });

    it("should pair trades within same productType only", () => {
      // MIS and CNC should be paired separately
      const trades = [
        createTrade({
          id: "t1",
          symbol: "RELIANCE",
          productType: "CNC",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "t2",
          symbol: "RELIANCE",
          productType: "MIS",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // Both should be OPEN since they're different product types
      assert.strictEqual(result.pairedViews.length, 2);
      assert.ok(
        result.pairedViews.every((p) => p.status === "OPEN"),
        "Different product types should not pair"
      );
    });

    it("should pair trades within same broker only", () => {
      const trades = [
        createTrade({
          id: "t1",
          broker: "ZERODHA",
          brokerUserId: "ABC123",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
        }),
        createTrade({
          id: "t2",
          broker: "UPSTOX",
          brokerUserId: "XYZ789",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
        }),
      ];

      const result = pairTradesFIFO(trades);

      // Both should be OPEN since they're from different brokers
      assert.strictEqual(result.pairedViews.length, 2);
      assert.ok(result.pairedViews.every((p) => p.status === "OPEN"));
    });

    it("should pair trades from same broker account correctly", () => {
      const trades = [
        createTrade({
          id: "t1",
          broker: "ZERODHA",
          brokerUserId: "ABC123",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "t2",
          broker: "ZERODHA",
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
  });

  describe("P&L Calculations", () => {
    it("should calculate positive P&L for profitable LONG trade", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 10,
          price: 120,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, 200); // (120-100)*10
      assert.strictEqual(result.stats.totalRealizedPnL, 200);
    });

    it("should calculate negative P&L for losing LONG trade", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 10,
          price: 90,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews[0].realizedPnL, -100); // (90-100)*10
      assert.strictEqual(result.stats.totalRealizedPnL, -100);
    });

    it("should calculate positive P&L for profitable SHORT trade", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "SELL",
          quantity: 10,
          price: 120,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // SHORT P&L = (entry - exit) * qty = (120 - 100) * 10 = 200
      assert.strictEqual(result.pairedViews[0].realizedPnL, 200);
    });

    it("should calculate negative P&L for losing SHORT trade", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "SELL",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "BUY",
          quantity: 10,
          price: 120,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // SHORT P&L = (entry - exit) * qty = (100 - 120) * 10 = -200
      assert.strictEqual(result.pairedViews[0].realizedPnL, -200);
    });

    it("should calculate P&L percentage correctly", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // P&L % = ((110 - 100) / 100) * 100 = 10%
      assert.strictEqual(result.pairedViews[0].pnlPercentage, 10);
    });
  });

  describe("Statistics", () => {
    it("should count total trades correctly", () => {
      const trades = [
        createTrade({ id: "t1", tradeType: "BUY", quantity: 10 }),
        createTrade({ id: "t2", tradeType: "BUY", quantity: 5 }),
        createTrade({ id: "t3", tradeType: "SELL", quantity: 8 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.stats.totalTrades, 3);
    });

    it("should sum total realized P&L across multiple closed trades", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 5,
          price: 100,
          tradeTime: new Date("2024-01-15T09:00:00"),
        }),
        createTrade({
          id: "t2",
          tradeType: "BUY",
          quantity: 5,
          price: 100,
          tradeTime: new Date("2024-01-15T09:30:00"),
        }),
        createTrade({
          id: "t3",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // Total P&L = (110-100)*5 + (110-100)*5 = 50 + 50 = 100
      assert.strictEqual(result.stats.totalRealizedPnL, 100);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty trades array", () => {
      const result = pairTradesFIFO([]);

      assert.strictEqual(result.pairedViews.length, 0);
      assert.strictEqual(result.stats.totalTrades, 0);
      assert.strictEqual(result.stats.openPositions, 0);
      assert.strictEqual(result.stats.closedPositions, 0);
    });

    it("should handle zero price trades", () => {
      const trades = [
        createTrade({ id: "t1", tradeType: "BUY", quantity: 10, price: 0 }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].entryPrice, 0);
    });

    it("should handle trades out of chronological order", () => {
      // Trades submitted in wrong order - algorithm should sort by time
      const trades = [
        createTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00"),
        }),
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00"),
        }),
      ];

      const result = pairTradesFIFO(trades);

      // Should still pair correctly (BUY first, then SELL)
      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
      assert.strictEqual(result.pairedViews[0].positionType, "LONG");
      assert.strictEqual(result.pairedViews[0].entryPrice, 100);
      assert.strictEqual(result.pairedViews[0].exitPrice, 110);
    });

    it("should use tradeDate when tradeTime is null", () => {
      const trades = [
        createTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeDate: new Date("2024-01-15"),
          tradeTime: null,
        }),
        createTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeDate: new Date("2024-01-16"),
          tradeTime: null,
        }),
      ];

      const result = pairTradesFIFO(trades);

      assert.strictEqual(result.pairedViews.length, 1);
      assert.strictEqual(result.pairedViews[0].status, "CLOSED");
    });
  });
});
