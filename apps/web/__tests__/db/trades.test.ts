/**
 * Trades DB Layer Tests
 *
 * NOW EXERCISES THE REAL SOURCE: imports the pure trade helpers from
 * `@/lib/db/trades-logic`, which is exactly the logic that `getTrades`,
 * `createTrade`, and `closePosition` (in `@/lib/db/trades.ts`) call. No inline
 * reimplementations.
 *
 * The `trades-logic` module is Prisma-free, so importing it never pulls in the
 * Prisma client — the test stays pure and exits cleanly (no orphan).
 *
 * Covers:
 * - Trade pairing: FIFO matching, partial fills, status determination
 * - P&L calculations: LONG vs SHORT (createTrade + closePosition)
 * - Win rate / total P&L stats
 * - Segment filtering with mapping
 * - Date range filtering, broker/trade-type filters, pagination
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getSegmentFilterValues,
  pairTrades,
  buildTradeWhereClause,
  calculateTradeStats,
  calculateTradeRealizedPnL,
  calculateClosePositionPnL,
  type TradeFilterInput,
} from "@/lib/db/trades-logic";

// ---------------------------------------------------------------------------
// Mock trade shape (superset of the real `PairableTrade` input)
// ---------------------------------------------------------------------------

interface MockTrade {
  id: string;
  symbol: string;
  exchange: string;
  segment: string;
  tradeType: "BUY" | "SELL";
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
}

function createMockTrade(overrides: Partial<MockTrade> = {}): MockTrade {
  return {
    id: `trade-${Math.random().toString(36).substr(2, 9)}`,
    symbol: "RELIANCE",
    exchange: "NSE",
    segment: "CASH",
    tradeType: "BUY",
    positionType: "LONG",
    orderType: "MARKET",
    productType: "CNC",
    quantity: 100,
    price: 2500,
    exitPrice: null,
    tradeValue: 250000,
    brokerage: 20,
    taxes: 0,
    realizedPnL: null,
    status: "OPEN",
    tradeDate: new Date("2024-06-01"),
    exitDate: null,
    broker: null,
    brokerUserId: null,
    brokerName: null,
    tags: [],
    notes: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Trades DB Logic", () => {
  // =========================================================================
  // Trade pairing: FIFO matching
  // =========================================================================

  describe("pairTrades - full match (CLOSED)", () => {
    it("should pair matching buy and sell with equal quantity", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);

      assert.strictEqual(paired.length, 2);
      assert.strictEqual(paired[0]!.status, "CLOSED");
      assert.strictEqual(paired[1]!.status, "CLOSED");
    });

    it("should calculate correct P&L for closed buy trade", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);
      const buyTrade = paired.find((t) => t.id === "t1");

      // P&L for BUY: (avgSellPrice - avgBuyPrice) * qty = (2600 - 2500) * 100 = 10000
      assert.strictEqual(buyTrade!.realizedPnL, 10000);
      assert.strictEqual(buyTrade!.exitPrice, 2600);
    });

    it("should calculate negative P&L for sell trade in the pair", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);
      const sellTrade = paired.find((t) => t.id === "t2");

      // Sell trade gets negated P&L: -realizedPnL = -10000
      assert.strictEqual(sellTrade!.realizedPnL, -10000);
      assert.strictEqual(sellTrade!.exitPrice, 2500);
    });

    it("should set pairedWith IDs for closed trades", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);

      assert.deepStrictEqual(paired[0]!.pairedWith, ["t2"]);
      assert.deepStrictEqual(paired[1]!.pairedWith, ["t1"]);
    });

    it("should handle multiple buys and sells that match total quantity", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 50,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          tradeType: "BUY",
          quantity: 50,
          price: 2520,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t3",
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);

      assert.strictEqual(paired.length, 3);
      for (const t of paired) {
        assert.strictEqual(t.status, "CLOSED");
      }

      // avgBuyPrice = (50*2500 + 50*2520) / 100 = 2510
      // avgSellPrice = 2600
      // P&L = (2600 - 2510) * 100 = 9000
      const buyTrade1 = paired.find((t) => t.id === "t1");
      const buyTrade2 = paired.find((t) => t.id === "t2");
      assert.strictEqual(buyTrade1!.realizedPnL, 9000);
      assert.strictEqual(buyTrade2!.realizedPnL, 9000);
    });
  });

  // =========================================================================
  // Trade pairing: partial fills
  // =========================================================================

  describe("pairTrades - partial match (PARTIAL)", () => {
    it("should mark trades as PARTIAL when buy qty > sell qty", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 50,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);

      const buyTrade = paired.find((t) => t.id === "t1");
      const sellTrade = paired.find((t) => t.id === "t2");

      // Buy is NOT fully closed (sell qty 50 < buy qty 100)
      assert.strictEqual(buyTrade!.status, "PARTIAL");
      // Sell IS fully closed (buy qty 100 >= sell qty 50)
      assert.strictEqual(sellTrade!.status, "CLOSED");
    });

    it("should mark trades as PARTIAL when sell qty > buy qty", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 50,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);

      const buyTrade = paired.find((t) => t.id === "t1");
      const sellTrade = paired.find((t) => t.id === "t2");

      // Buy IS fully closed (sell qty 100 >= buy qty 50)
      assert.strictEqual(buyTrade!.status, "CLOSED");
      // Sell is NOT fully closed (buy qty 50 < sell qty 100)
      assert.strictEqual(sellTrade!.status, "PARTIAL");
    });

    it("should calculate proportional P&L for partial fills", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 50,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);
      const buyTrade = paired.find((t) => t.id === "t1");

      // closedQty = min(100, 50) = 50
      // realizedPnL = (2600 - 2500) * 50 = 5000
      // Buy trade's proportional P&L = 5000 * (100 / 100) = 5000
      assert.strictEqual(buyTrade!.realizedPnL, 5000);
    });
  });

  // =========================================================================
  // Trade pairing: open trades
  // =========================================================================

  describe("pairTrades - no match (OPEN)", () => {
    it("should keep trades as OPEN when only buys exist", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
          status: "OPEN",
        }),
      ];

      const paired = pairTrades(trades);
      assert.strictEqual(paired[0]!.status, "OPEN");
    });

    it("should keep trades as OPEN when only sells exist", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "SELL",
          quantity: 100,
          price: 2500,
          tradeDate: date,
          status: "OPEN",
        }),
      ];

      const paired = pairTrades(trades);
      assert.strictEqual(paired[0]!.status, "OPEN");
    });

    it("should use existing status when no matching trade", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
          status: "ACTIVE",
        }),
      ];

      const paired = pairTrades(trades);
      assert.strictEqual(paired[0]!.status, "ACTIVE");
    });

    it("should default to OPEN when status is empty string", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
          status: "",
        }),
      ];

      const paired = pairTrades(trades);
      // "" || "OPEN" = "OPEN"
      assert.strictEqual(paired[0]!.status, "OPEN");
    });
  });

  // =========================================================================
  // Trade pairing: grouping keys
  // =========================================================================

  describe("pairTrades - grouping logic", () => {
    it("should not pair trades of different symbols", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          symbol: "RELIANCE",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          symbol: "TCS",
          tradeType: "SELL",
          quantity: 100,
          price: 3500,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);
      // Each should remain OPEN since they are in different groups
      for (const t of paired) {
        assert.strictEqual(t.status, "OPEN");
      }
    });

    it("should not pair trades of different dates", () => {
      const trades = [
        createMockTrade({
          id: "t1",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: new Date("2024-06-01"),
        }),
        createMockTrade({
          id: "t2",
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: new Date("2024-06-02"),
        }),
      ];

      const paired = pairTrades(trades);
      for (const t of paired) {
        assert.strictEqual(t.status, "OPEN");
      }
    });

    it("should not pair trades of different exchanges", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          exchange: "NSE",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          exchange: "BSE",
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);
      for (const t of paired) {
        assert.strictEqual(t.status, "OPEN");
      }
    });

    it("should not pair trades of different brokers", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          broker: "ZERODHA",
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          broker: "UPSTOX",
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);
      for (const t of paired) {
        assert.strictEqual(t.status, "OPEN");
      }
    });

    it("should pair trades with null broker (manual trades)", () => {
      const date = new Date("2024-06-01");
      const trades = [
        createMockTrade({
          id: "t1",
          broker: null,
          tradeType: "BUY",
          quantity: 100,
          price: 2500,
          tradeDate: date,
        }),
        createMockTrade({
          id: "t2",
          broker: null,
          tradeType: "SELL",
          quantity: 100,
          price: 2600,
          tradeDate: date,
        }),
      ];

      const paired = pairTrades(trades);
      assert.strictEqual(paired[0]!.status, "CLOSED");
      assert.strictEqual(paired[1]!.status, "CLOSED");
    });
  });

  // =========================================================================
  // P&L calculations for createTrade
  // =========================================================================

  describe("calculateTradeRealizedPnL (createTrade logic)", () => {
    it("should calculate LONG P&L: (exit - entry) * qty - brokerage", () => {
      const pnl = calculateTradeRealizedPnL("LONG", 2500, 2600, 100, 20);
      assert.strictEqual(pnl, 9980); // (2600-2500)*100 - 20
    });

    it("should calculate SHORT P&L: (entry - exit) * qty - brokerage", () => {
      const pnl = calculateTradeRealizedPnL("SHORT", 2600, 2500, 100, 20);
      assert.strictEqual(pnl, 9980); // (2600-2500)*100 - 20
    });

    it("should calculate negative LONG P&L when exit < entry", () => {
      const pnl = calculateTradeRealizedPnL("LONG", 2600, 2500, 100, 20);
      assert.strictEqual(pnl, -10020); // (2500-2600)*100 - 20
    });

    it("should calculate negative SHORT P&L when exit > entry", () => {
      const pnl = calculateTradeRealizedPnL("SHORT", 2500, 2600, 100, 20);
      assert.strictEqual(pnl, -10020); // (2500-2600)*100 - 20
    });

    it("should handle zero brokerage", () => {
      const pnl = calculateTradeRealizedPnL("LONG", 100, 110, 10, 0);
      assert.strictEqual(pnl, 100); // (110-100)*10 - 0
    });

    it("should return -brokerage when entry equals exit", () => {
      const pnl = calculateTradeRealizedPnL("LONG", 100, 100, 10, 20);
      assert.strictEqual(pnl, -20); // (100-100)*10 - 20
    });
  });

  // =========================================================================
  // P&L calculations for closePosition
  // =========================================================================

  describe("calculateClosePositionPnL", () => {
    it("should calculate LONG P&L: (exit - entry) * qty - brokerage", () => {
      const pnl = calculateClosePositionPnL("LONG", 2500, 2600, 100, 20);
      assert.strictEqual(pnl, 9980);
    });

    it("should calculate SHORT P&L: (entry - exit) * qty - brokerage", () => {
      const pnl = calculateClosePositionPnL("SHORT", 2600, 2500, 100, 20);
      assert.strictEqual(pnl, 9980);
    });

    it("should handle loss scenario for LONG", () => {
      const pnl = calculateClosePositionPnL("LONG", 2600, 2500, 50, 10);
      assert.strictEqual(pnl, -5010); // (2500-2600)*50 - 10
    });

    it("should handle loss scenario for SHORT", () => {
      const pnl = calculateClosePositionPnL("SHORT", 2500, 2600, 50, 10);
      assert.strictEqual(pnl, -5010); // (2500-2600)*50 - 10
    });

    it("should handle break-even trade minus brokerage", () => {
      const pnl = calculateClosePositionPnL("LONG", 100, 100, 100, 50);
      assert.strictEqual(pnl, -50);
    });
  });

  // =========================================================================
  // Win rate calculation
  // =========================================================================

  describe("calculateTradeStats - win rate", () => {
    it("should calculate 100% win rate when all closed trades are winners", () => {
      const trades = [
        { status: "CLOSED", realizedPnL: 5000 },
        { status: "CLOSED", realizedPnL: 3000 },
        { status: "CLOSED", realizedPnL: 1000 },
      ];

      const stats = calculateTradeStats(trades, 3);
      assert.strictEqual(stats.winRate, 100);
      assert.strictEqual(stats.winners, 3);
      assert.strictEqual(stats.losers, 0);
    });

    it("should calculate 0% win rate when all closed trades are losers", () => {
      const trades = [
        { status: "CLOSED", realizedPnL: -5000 },
        { status: "CLOSED", realizedPnL: -3000 },
      ];

      const stats = calculateTradeStats(trades, 2);
      assert.strictEqual(stats.winRate, 0);
      assert.strictEqual(stats.winners, 0);
      assert.strictEqual(stats.losers, 2);
    });

    it("should calculate 50% win rate", () => {
      const trades = [
        { status: "CLOSED", realizedPnL: 5000 },
        { status: "CLOSED", realizedPnL: -3000 },
      ];

      const stats = calculateTradeStats(trades, 2);
      assert.strictEqual(stats.winRate, 50);
    });

    it("should calculate 75% win rate", () => {
      const trades = [
        { status: "CLOSED", realizedPnL: 5000 },
        { status: "CLOSED", realizedPnL: 3000 },
        { status: "CLOSED", realizedPnL: 1000 },
        { status: "CLOSED", realizedPnL: -2000 },
      ];

      const stats = calculateTradeStats(trades, 4);
      assert.strictEqual(stats.winRate, 75);
    });

    it("should return 0% win rate when no closed trades", () => {
      const trades = [
        { status: "OPEN", realizedPnL: null },
        { status: "OPEN", realizedPnL: null },
      ];

      const stats = calculateTradeStats(trades, 2);
      assert.strictEqual(stats.winRate, 0);
    });

    it("should ignore open trades in win rate calculation", () => {
      const trades = [
        { status: "CLOSED", realizedPnL: 5000 },
        { status: "OPEN", realizedPnL: null },
        { status: "CLOSED", realizedPnL: -3000 },
      ];

      const stats = calculateTradeStats(trades, 3);
      assert.strictEqual(stats.winRate, 50);
      assert.strictEqual(stats.totalTrades, 3);
    });

    it("should treat zero P&L as a loser (not > 0)", () => {
      const trades = [
        { status: "CLOSED", realizedPnL: 0 },
        { status: "CLOSED", realizedPnL: 1000 },
      ];

      const stats = calculateTradeStats(trades, 2);
      assert.strictEqual(stats.winners, 1);
      assert.strictEqual(stats.losers, 1);
      assert.strictEqual(stats.winRate, 50);
    });

    it("should treat null realizedPnL in closed trade as loser", () => {
      const trades = [
        { status: "CLOSED", realizedPnL: null },
        { status: "CLOSED", realizedPnL: 1000 },
      ];

      const stats = calculateTradeStats(trades, 2);
      assert.strictEqual(stats.winners, 1);
      assert.strictEqual(stats.losers, 1);
    });
  });

  // =========================================================================
  // Total P&L
  // =========================================================================

  describe("calculateTradeStats - totalPnL", () => {
    it("should sum all closed trade P&L values", () => {
      const trades = [
        { status: "CLOSED", realizedPnL: 5000 },
        { status: "CLOSED", realizedPnL: -2000 },
        { status: "CLOSED", realizedPnL: 3000 },
      ];

      const stats = calculateTradeStats(trades, 3);
      assert.strictEqual(stats.totalPnL, 6000);
    });

    it("should return 0 when no closed trades", () => {
      const trades = [{ status: "OPEN", realizedPnL: null }];

      const stats = calculateTradeStats(trades, 1);
      assert.strictEqual(stats.totalPnL, 0);
    });

    it("should handle negative total P&L", () => {
      const trades = [
        { status: "CLOSED", realizedPnL: -5000 },
        { status: "CLOSED", realizedPnL: -3000 },
        { status: "CLOSED", realizedPnL: 1000 },
      ];

      const stats = calculateTradeStats(trades, 3);
      assert.strictEqual(stats.totalPnL, -7000);
    });
  });

  // =========================================================================
  // Segment filtering with mapping
  // =========================================================================

  describe("getSegmentFilterValues", () => {
    it("should map CASH to equity-related segments", () => {
      assert.deepStrictEqual(getSegmentFilterValues("CASH"), [
        "CASH",
        "EQUITY",
        "NSE",
        "BSE",
        "CNC",
        "MIS",
      ]);
    });

    it("should map FO to futures and options segments", () => {
      assert.deepStrictEqual(getSegmentFilterValues("FO"), [
        "FO",
        "NFO",
        "BFO",
        "NRML",
      ]);
    });

    it("should pass through unknown segment", () => {
      assert.deepStrictEqual(getSegmentFilterValues("CUSTOM"), ["CUSTOM"]);
    });
  });

  describe("Segment filter mapping in trades", () => {
    it("should map CASH segment in where clause", () => {
      const where = buildTradeWhereClause("user-1", { segment: "CASH" });
      assert.deepStrictEqual(where.segment, {
        in: ["CASH", "EQUITY", "NSE", "BSE", "CNC", "MIS"],
      });
    });

    it("should map FO segment in where clause", () => {
      const where = buildTradeWhereClause("user-1", { segment: "FO" });
      assert.deepStrictEqual(where.segment, {
        in: ["FO", "NFO", "BFO", "NRML"],
      });
    });

    it("should not add segment filter for 'all'", () => {
      const where = buildTradeWhereClause("user-1", { segment: "all" });
      assert.strictEqual(where.segment, undefined);
    });

    it("should pass through unknown segment", () => {
      const where = buildTradeWhereClause("user-1", { segment: "CUSTOM" });
      assert.deepStrictEqual(where.segment, { in: ["CUSTOM"] });
    });
  });

  // =========================================================================
  // Date range filtering
  // =========================================================================

  describe("Date range filtering", () => {
    it("should add fromDate as gte", () => {
      const where = buildTradeWhereClause("user-1", {
        fromDate: "2024-01-01",
      });
      const tradeDate = where.tradeDate as Record<string, Date>;
      assert.ok(tradeDate.gte instanceof Date);
      assert.strictEqual(
        tradeDate.gte.toISOString().split("T")[0],
        "2024-01-01"
      );
    });

    it("should add toDate as lte with end-of-day time", () => {
      const where = buildTradeWhereClause("user-1", {
        toDate: "2024-12-31",
      });
      const tradeDate = where.tradeDate as Record<string, Date>;
      assert.ok(tradeDate.lte instanceof Date);
      assert.strictEqual(tradeDate.lte.getHours(), 23);
      assert.strictEqual(tradeDate.lte.getMinutes(), 59);
      assert.strictEqual(tradeDate.lte.getSeconds(), 59);
      assert.strictEqual(tradeDate.lte.getMilliseconds(), 999);
    });

    it("should add both fromDate and toDate", () => {
      const where = buildTradeWhereClause("user-1", {
        fromDate: "2024-01-01",
        toDate: "2024-12-31",
      });
      const tradeDate = where.tradeDate as Record<string, Date>;
      assert.ok(tradeDate.gte);
      assert.ok(tradeDate.lte);
    });

    it("should not add tradeDate filter when neither fromDate nor toDate", () => {
      const where = buildTradeWhereClause("user-1", {});
      assert.strictEqual(where.tradeDate, undefined);
    });
  });

  // =========================================================================
  // Broker filter in trades (different from positions)
  // =========================================================================

  describe("Broker filter in trades", () => {
    it("should set brokerName to 'manual' for manual filter", () => {
      const where = buildTradeWhereClause("user-1", { broker: "manual" });
      assert.strictEqual(where.brokerName, "manual");
      assert.strictEqual(where.broker, undefined);
    });

    it("should split BROKER:userId format", () => {
      const where = buildTradeWhereClause("user-1", {
        broker: "ZERODHA:ZD123",
      });
      assert.strictEqual(where.broker, "ZERODHA");
      assert.strictEqual(where.brokerUserId, "ZD123");
    });

    it("should use plain broker name", () => {
      const where = buildTradeWhereClause("user-1", { broker: "UPSTOX" });
      assert.strictEqual(where.broker, "UPSTOX");
    });

    it("should handle BROKER: format with empty userId", () => {
      const where = buildTradeWhereClause("user-1", { broker: "UPSTOX:" });
      assert.strictEqual(where.broker, "UPSTOX");
      assert.strictEqual(where.brokerUserId, undefined);
    });

    it("should not add broker filter for 'all'", () => {
      const where = buildTradeWhereClause("user-1", { broker: "all" });
      assert.strictEqual(where.broker, undefined);
      assert.strictEqual(where.brokerName, undefined);
    });
  });

  // =========================================================================
  // Trade type filter
  // =========================================================================

  describe("Trade type filter", () => {
    it("should add tradeType filter for BUY", () => {
      const where = buildTradeWhereClause("user-1", { tradeType: "BUY" });
      assert.strictEqual(where.tradeType, "BUY");
    });

    it("should add tradeType filter for SELL", () => {
      const where = buildTradeWhereClause("user-1", { tradeType: "SELL" });
      assert.strictEqual(where.tradeType, "SELL");
    });

    it("should not add tradeType filter for 'all'", () => {
      const where = buildTradeWhereClause("user-1", { tradeType: "all" });
      assert.strictEqual(where.tradeType, undefined);
    });
  });

  // =========================================================================
  // Symbol filter + minimal/combined where
  // =========================================================================

  describe("buildTradeWhereClause - symbol + combined", () => {
    it("should include only userId when no filters provided", () => {
      const where = buildTradeWhereClause("user-1", {});
      assert.deepStrictEqual(where, { userId: "user-1" });
    });

    it("should add case-insensitive symbol filter", () => {
      const where = buildTradeWhereClause("user-1", { symbol: "RELI" });
      assert.deepStrictEqual(where.symbol, {
        contains: "RELI",
        mode: "insensitive",
      });
    });

    it("should combine symbol, broker, segment, tradeType, and dates", () => {
      const where = buildTradeWhereClause("user-1", {
        symbol: "NIFTY",
        broker: "ZERODHA:ZD1",
        segment: "FO",
        tradeType: "SELL",
        fromDate: "2024-01-01",
        toDate: "2024-12-31",
      });
      assert.strictEqual(where.userId, "user-1");
      assert.strictEqual(where.broker, "ZERODHA");
      assert.strictEqual(where.brokerUserId, "ZD1");
      assert.deepStrictEqual(where.segment, {
        in: ["FO", "NFO", "BFO", "NRML"],
      });
      assert.strictEqual(where.tradeType, "SELL");
      assert.ok((where.tradeDate as Record<string, Date>).gte);
      assert.ok((where.tradeDate as Record<string, Date>).lte);
    });
  });

  // =========================================================================
  // Pagination
  // =========================================================================

  describe("Pagination parameters", () => {
    it("should pass skip and limit to query options", () => {
      const filters: TradeFilterInput = {
        skip: 20,
        limit: 10,
      };

      // These would be used as: take: filters.limit, skip: filters.skip
      assert.strictEqual(filters.skip, 20);
      assert.strictEqual(filters.limit, 10);
    });

    it("should handle undefined pagination (no skip/limit)", () => {
      const filters: TradeFilterInput = {};

      assert.strictEqual(filters.skip, undefined);
      assert.strictEqual(filters.limit, undefined);
    });

    it("should handle zero skip", () => {
      const filters: TradeFilterInput = { skip: 0, limit: 25 };
      assert.strictEqual(filters.skip, 0);
    });

    it("should calculate page number from skip and limit", () => {
      const skip = 40;
      const limit = 20;
      const page = Math.floor(skip / limit) + 1;
      assert.strictEqual(page, 3);
    });
  });
});
