/**
 * Mock Data Generator Tests
 *
 * Tests the REAL mock data generators exported from
 *   packages/core/src/brokers/mock-data.ts
 * (generateMockHoldings/Positions/Orders/Trades/MutualFunds, shouldUseMockData,
 * MOCK_STOCK_SYMBOLS). Imports the real exports — no inline reimplementation.
 *
 * These generators back the Zerodha (and other broker) mock-data fallback that
 * production serves when API keys are absent, so this exercises production code.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateMockHoldings,
  generateMockPositions,
  generateMockOrders,
  generateMockTrades,
  generateMockMutualFunds,
  shouldUseMockData,
  MOCK_STOCK_SYMBOLS,
} from "@usemoney/core/brokers";

const VALID_SYMBOLS = MOCK_STOCK_SYMBOLS;

describe("Mock Data Generators", () => {
  // --------------------------------------------------------------------------
  // generateMockHoldings
  // --------------------------------------------------------------------------

  describe("generateMockHoldings", () => {
    it("should return default 8 holdings when no count provided", () => {
      const holdings = generateMockHoldings();
      assert.equal(holdings.length, 8);
    });

    it("should return requested count of holdings", () => {
      const holdings = generateMockHoldings(5);
      assert.equal(holdings.length, 5);
    });

    it("should return 1 holding when count is 1", () => {
      const holdings = generateMockHoldings(1);
      assert.equal(holdings.length, 1);
    });

    it("should return empty array when count is 0", () => {
      const holdings = generateMockHoldings(0);
      assert.equal(holdings.length, 0);
    });

    it("should cap at available stocks (15) when count exceeds stock list", () => {
      const holdings = generateMockHoldings(20);
      assert.equal(holdings.length, 15);
    });

    it("should have symbol as a non-empty string from STOCKS list", () => {
      const holdings = generateMockHoldings(3);
      for (const h of holdings) {
        assert.equal(typeof h.symbol, "string");
        assert.ok(h.symbol.length > 0);
        assert.ok(
          VALID_SYMBOLS.includes(h.symbol),
          `${h.symbol} should be in STOCKS list`
        );
      }
    });

    it("should have tradingSymbol equal to symbol", () => {
      const holdings = generateMockHoldings(3);
      for (const h of holdings) {
        assert.equal(h.tradingSymbol, h.symbol);
      }
    });

    it("should have ISIN starting with INE", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        // `isin` is optional on HoldingData; the mock generator must supply it,
        // so an absent value FAILS here rather than short-circuiting the check.
        assert.ok(
          h.isin !== undefined && h.isin.startsWith("INE"),
          `ISIN ${h.isin} should start with INE`
        );
      }
    });

    it("should have ISIN ending with A01018", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.ok(
          h.isin !== undefined && h.isin.endsWith("A01018"),
          `ISIN ${h.isin} should end with A01018`
        );
      }
    });

    it("should have exchange set to NSE", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(h.exchange, "NSE");
      }
    });

    it("should have totalQuantity between 10 and 199", () => {
      const holdings = generateMockHoldings(8);
      for (const h of holdings) {
        assert.ok(
          h.totalQuantity >= 10,
          `totalQuantity ${h.totalQuantity} should be >= 10`
        );
        assert.ok(
          h.totalQuantity < 200,
          `totalQuantity ${h.totalQuantity} should be < 200`
        );
      }
    });

    it("should have totalQuantity as an integer", () => {
      const holdings = generateMockHoldings(8);
      for (const h of holdings) {
        assert.equal(h.totalQuantity, Math.floor(h.totalQuantity));
      }
    });

    it("should have freeQuantity equal to totalQuantity", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(h.freeQuantity, h.totalQuantity);
      }
    });

    it("should have t1Quantity as 0", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(h.t1Quantity, 0);
      }
    });

    it("should have pledgedQuantity as 0", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(h.pledgedQuantity, 0);
      }
    });

    it("should have collateralQty as 0", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(h.collateralQty, 0);
      }
    });

    it("should have product set to CNC", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(h.product, "CNC");
      }
    });

    it("should have numeric averagePrice greater than 0", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(typeof h.averagePrice, "number");
        assert.ok(h.averagePrice > 0);
      }
    });

    it("should have numeric lastPrice greater than 0", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(typeof h.lastPrice, "number");
        assert.ok(h.lastPrice > 0);
      }
    });

    it("should have numeric closePrice greater than 0", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        // `closePrice` is optional on HoldingData; assert the mock supplies a
        // real number before comparing (undefined must fail, not skip).
        const { closePrice } = h;
        assert.equal(typeof closePrice, "number");
        assert.ok(closePrice !== undefined && closePrice > 0);
      }
    });

    it("should have pnl as a finite number", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(typeof h.pnl, "number");
        assert.ok(Number.isFinite(h.pnl));
      }
    });

    it("should have pnlPercentage as a finite number", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(typeof h.pnlPercentage, "number");
        assert.ok(Number.isFinite(h.pnlPercentage));
      }
    });

    it("should calculate pnl correctly (currentValue - investedValue)", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        const investedValue = h.totalQuantity * h.averagePrice;
        const currentValue = h.totalQuantity * h.lastPrice;
        const expectedPnl = parseFloat(
          (currentValue - investedValue).toFixed(2)
        );
        assert.ok(
          Math.abs(h.pnl - expectedPnl) < 1.0,
          `pnl ${h.pnl} should be close to ${expectedPnl}`
        );
      }
    });

    it("should have dayChange as a finite number", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(typeof h.dayChange, "number");
        assert.ok(Number.isFinite(h.dayChange));
      }
    });

    it("should have dayChangePerc as a finite number", () => {
      const holdings = generateMockHoldings(5);
      for (const h of holdings) {
        assert.equal(typeof h.dayChangePerc, "number");
        assert.ok(Number.isFinite(h.dayChangePerc));
      }
    });
  });

  // --------------------------------------------------------------------------
  // generateMockPositions
  // --------------------------------------------------------------------------

  describe("generateMockPositions", () => {
    it("should return default 4 positions when no count provided", () => {
      const positions = generateMockPositions();
      assert.equal(positions.length, 4);
    });

    it("should return requested count of positions", () => {
      const positions = generateMockPositions(3);
      assert.equal(positions.length, 3);
    });

    it("should return empty array when count is 0", () => {
      const positions = generateMockPositions(0);
      assert.equal(positions.length, 0);
    });

    it("should have symbol from STOCKS list", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.ok(
          VALID_SYMBOLS.includes(p.symbol),
          `${p.symbol} should be in STOCKS list`
        );
      }
    });

    it("should have exchange set to NSE", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.equal(p.exchange, "NSE");
      }
    });

    it("should have segment set to CASH", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.equal(p.segment, "CASH");
      }
    });

    it("should have positionType set to DAY", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.equal(p.positionType, "DAY");
      }
    });

    it("should have productType set to MIS", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.equal(p.productType, "MIS");
      }
    });

    it("should have netQuantity equal to buyQuantity minus sellQuantity", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.equal(p.netQuantity, p.buyQuantity - p.sellQuantity);
      }
    });

    it("should have buyQuantity as a non-negative integer", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.ok(p.buyQuantity >= 0);
        assert.equal(p.buyQuantity, Math.floor(p.buyQuantity));
      }
    });

    it("should have sellQuantity as a non-negative integer", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.ok(p.sellQuantity >= 0);
        assert.equal(p.sellQuantity, Math.floor(p.sellQuantity));
      }
    });

    it("should have numeric realizedPnl", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.equal(typeof p.realizedPnl, "number");
        assert.ok(Number.isFinite(p.realizedPnl));
      }
    });

    it("should have numeric unrealizedPnl", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.equal(typeof p.unrealizedPnl, "number");
        assert.ok(Number.isFinite(p.unrealizedPnl));
      }
    });

    it("should have tradingSymbol equal to symbol", () => {
      const positions = generateMockPositions(4);
      for (const p of positions) {
        assert.equal(p.tradingSymbol, p.symbol);
      }
    });
  });

  // --------------------------------------------------------------------------
  // generateMockOrders
  // --------------------------------------------------------------------------

  describe("generateMockOrders", () => {
    it("should return default 10 orders when no count provided", () => {
      const orders = generateMockOrders();
      assert.equal(orders.length, 10);
    });

    it("should return requested count of orders", () => {
      const orders = generateMockOrders(6);
      assert.equal(orders.length, 6);
    });

    it("should return empty array when count is 0", () => {
      const orders = generateMockOrders(0);
      assert.equal(orders.length, 0);
    });

    it("should have orderId starting with ORD", () => {
      const orders = generateMockOrders(4);
      for (const o of orders) {
        assert.ok(
          o.orderId.startsWith("ORD"),
          `orderId ${o.orderId} should start with ORD`
        );
      }
    });

    it("should have unique orderIds", () => {
      const orders = generateMockOrders(10);
      const ids = orders.map((o) => o.orderId);
      const uniqueIds = new Set(ids);
      assert.equal(uniqueIds.size, ids.length);
    });

    it("should have exchange set to NSE", () => {
      const orders = generateMockOrders(4);
      for (const o of orders) {
        assert.equal(o.exchange, "NSE");
      }
    });

    it("should have segment set to CASH", () => {
      const orders = generateMockOrders(4);
      for (const o of orders) {
        assert.equal(o.segment, "CASH");
      }
    });

    it("should cycle statuses through COMPLETE, PENDING, CANCELLED, REJECTED", () => {
      const orders = generateMockOrders(8);
      const expectedStatuses = ["COMPLETE", "PENDING", "CANCELLED", "REJECTED"];
      for (let i = 0; i < 8; i++) {
        assert.equal(orders[i]!.status, expectedStatuses[i % 4]);
      }
    });

    it("should have COMPLETE orders with filledQuantity equal to quantity", () => {
      const orders = generateMockOrders(4);
      const completeOrders = orders.filter((o) => o.status === "COMPLETE");
      for (const o of completeOrders) {
        assert.equal(o.filledQuantity, o.quantity);
      }
    });

    it("should have CANCELLED orders with filledQuantity of 0", () => {
      const orders = generateMockOrders(4);
      const cancelledOrders = orders.filter((o) => o.status === "CANCELLED");
      for (const o of cancelledOrders) {
        assert.equal(o.filledQuantity, 0);
      }
    });

    it("should have REJECTED orders with filledQuantity of 0", () => {
      const orders = generateMockOrders(4);
      const rejectedOrders = orders.filter((o) => o.status === "REJECTED");
      for (const o of rejectedOrders) {
        assert.equal(o.filledQuantity, 0);
      }
    });

    it("should have REJECTED orders with statusMessage set to Insufficient funds", () => {
      const orders = generateMockOrders(4);
      const rejectedOrders = orders.filter((o) => o.status === "REJECTED");
      for (const o of rejectedOrders) {
        assert.equal(o.statusMessage, "Insufficient funds");
      }
    });

    it("should have non-REJECTED orders without statusMessage", () => {
      const orders = generateMockOrders(4);
      const nonRejected = orders.filter((o) => o.status !== "REJECTED");
      for (const o of nonRejected) {
        assert.equal(o.statusMessage, undefined);
      }
    });

    it("should have transactionType as BUY or SELL", () => {
      const orders = generateMockOrders(10);
      for (const o of orders) {
        assert.ok(o.transactionType === "BUY" || o.transactionType === "SELL");
      }
    });

    it("should have orderType from valid set", () => {
      const validTypes = ["MARKET", "LIMIT", "SL", "SL-M"];
      const orders = generateMockOrders(10);
      for (const o of orders) {
        assert.ok(
          validTypes.includes(o.orderType),
          `orderType ${o.orderType} should be valid`
        );
      }
    });

    it("should have productType set to CNC", () => {
      const orders = generateMockOrders(4);
      for (const o of orders) {
        assert.equal(o.productType, "CNC");
      }
    });

    it("should have validity set to DAY", () => {
      const orders = generateMockOrders(4);
      for (const o of orders) {
        assert.equal(o.validity, "DAY");
      }
    });

    it("should have variety set to regular", () => {
      const orders = generateMockOrders(4);
      for (const o of orders) {
        assert.equal(o.variety, "regular");
      }
    });

    it("should have orderTime as Date instance", () => {
      const orders = generateMockOrders(4);
      for (const o of orders) {
        assert.ok(o.orderTime instanceof Date);
      }
    });

    it("should have updateTime as Date instance", () => {
      const orders = generateMockOrders(4);
      for (const o of orders) {
        assert.ok(o.updateTime instanceof Date);
      }
    });

    it("should have MARKET orders with price 0", () => {
      const orders = generateMockOrders(10);
      const marketOrders = orders.filter((o) => o.orderType === "MARKET");
      for (const o of marketOrders) {
        assert.equal(o.price, 0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // generateMockTrades
  // --------------------------------------------------------------------------

  describe("generateMockTrades", () => {
    it("should return default 15 trades when no count provided", () => {
      const trades = generateMockTrades();
      assert.equal(trades.length, 15);
    });

    it("should return requested count of trades", () => {
      const trades = generateMockTrades(7);
      assert.equal(trades.length, 7);
    });

    it("should return empty array when count is 0", () => {
      const trades = generateMockTrades(0);
      assert.equal(trades.length, 0);
    });

    it("should have tradeId starting with TRD", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.ok(
          t.tradeId.startsWith("TRD"),
          `tradeId ${t.tradeId} should start with TRD`
        );
      }
    });

    it("should have orderId starting with ORD", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.ok(
          t.orderId.startsWith("ORD"),
          `orderId ${t.orderId} should start with ORD`
        );
      }
    });

    it("should have exchange set to NSE", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.equal(t.exchange, "NSE");
      }
    });

    it("should have segment set to CASH", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.equal(t.segment, "CASH");
      }
    });

    it("should have productType set to CNC", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.equal(t.productType, "CNC");
      }
    });

    it("should have brokerage set to 20", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.equal(t.brokerage, 20);
      }
    });

    it("should have tradeValue approximately equal to quantity * price", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        const expected = parseFloat((t.quantity * t.price).toFixed(2));
        assert.ok(
          Math.abs(t.tradeValue - expected) < 0.02,
          `tradeValue ${t.tradeValue} should be close to ${expected}`
        );
      }
    });

    it("should calculate exchangeFee from tradeValue", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        const expected = parseFloat((t.tradeValue * 0.0000345).toFixed(2));
        assert.ok(
          Math.abs(t.exchangeFee - expected) < 0.02,
          `exchangeFee ${t.exchangeFee} should be close to ${expected}`
        );
      }
    });

    it("should calculate GST as 18% of brokerage", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        const expected = parseFloat((t.brokerage * 0.18).toFixed(2));
        assert.equal(t.gst, expected);
      }
    });

    it("should calculate sebiCharges from tradeValue", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        const expected = parseFloat((t.tradeValue * 0.000001).toFixed(2));
        assert.ok(
          Math.abs(t.sebiCharges - expected) < 0.02,
          `sebiCharges ${t.sebiCharges} should be close to ${expected}`
        );
      }
    });

    it("should have SELL trades with stampDuty of 0", () => {
      const trades = generateMockTrades(15);
      const sellTrades = trades.filter((t) => t.transactionType === "SELL");
      for (const t of sellTrades) {
        assert.equal(t.stampDuty, 0, "SELL stampDuty should be 0");
      }
    });

    it("should have BUY trades with stampDuty >= 0", () => {
      const trades = generateMockTrades(15);
      const buyTrades = trades.filter((t) => t.transactionType === "BUY");
      for (const t of buyTrades) {
        assert.ok(t.stampDuty >= 0, "BUY stampDuty should be >= 0");
      }
    });

    it("should have transactionType as BUY or SELL", () => {
      const trades = generateMockTrades(10);
      for (const t of trades) {
        assert.ok(t.transactionType === "BUY" || t.transactionType === "SELL");
      }
    });

    it("should have tradeTime as Date instance", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.ok(t.tradeTime instanceof Date);
      }
    });

    it("should have positive quantity", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.ok(t.quantity > 0);
      }
    });

    it("should have positive price", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.ok(t.price > 0);
      }
    });

    it("should have positive tradeValue", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.ok(t.tradeValue > 0);
      }
    });

    it("should have positive totalCharges", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.ok(t.totalCharges > 0);
      }
    });

    it("should have positive netAmount", () => {
      const trades = generateMockTrades(5);
      for (const t of trades) {
        assert.ok(t.netAmount > 0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // generateMockMutualFunds
  // --------------------------------------------------------------------------

  describe("generateMockMutualFunds", () => {
    it("should return default 5 funds when no count provided", () => {
      const funds = generateMockMutualFunds();
      assert.equal(funds.length, 5);
    });

    it("should return requested count of funds", () => {
      const funds = generateMockMutualFunds(3);
      assert.equal(funds.length, 3);
    });

    it("should return empty array when count is 0", () => {
      const funds = generateMockMutualFunds(0);
      assert.equal(funds.length, 0);
    });

    it("should cap at 5 funds (max available)", () => {
      const funds = generateMockMutualFunds(10);
      assert.equal(funds.length, 5);
    });

    it("should have folio starting with FOL", () => {
      const funds = generateMockMutualFunds(3);
      for (const f of funds) {
        // `folio` is optional on MutualFundData; the mock generator must set it.
        assert.ok(
          f.folio !== undefined && f.folio.startsWith("FOL"),
          `folio ${f.folio} should start with FOL`
        );
      }
    });

    it("should have non-empty fundName", () => {
      const funds = generateMockMutualFunds(3);
      for (const f of funds) {
        assert.equal(typeof f.fundName, "string");
        assert.ok(f.fundName.length > 0);
      }
    });

    it("should have schemeName equal to fundName", () => {
      const funds = generateMockMutualFunds(3);
      for (const f of funds) {
        assert.equal(f.schemeName, f.fundName);
      }
    });

    it("should have isin starting with INF", () => {
      const funds = generateMockMutualFunds(5);
      for (const f of funds) {
        assert.ok(
          f.isin.startsWith("INF"),
          `isin ${f.isin} should start with INF`
        );
      }
    });

    it("should have positive units", () => {
      const funds = generateMockMutualFunds(5);
      for (const f of funds) {
        assert.ok(f.units > 0);
      }
    });

    it("should have first 3 funds as SIP", () => {
      const funds = generateMockMutualFunds(5);
      assert.equal(funds[0]!.isSIP, true);
      assert.equal(funds[1]!.isSIP, true);
      assert.equal(funds[2]!.isSIP, true);
    });

    it("should have funds after index 2 as non-SIP", () => {
      const funds = generateMockMutualFunds(5);
      assert.equal(funds[3]!.isSIP, false);
      assert.equal(funds[4]!.isSIP, false);
    });

    it("should have SIP funds with sipAmount defined and positive", () => {
      const funds = generateMockMutualFunds(5);
      const sipFunds = funds.filter((f) => f.isSIP);
      for (const f of sipFunds) {
        assert.notEqual(f.sipAmount, undefined);
        assert.ok(f.sipAmount! > 0);
      }
    });

    it("should have SIP funds with sipAmount as multiple of 1000", () => {
      const funds = generateMockMutualFunds(5);
      const sipFunds = funds.filter((f) => f.isSIP);
      for (const f of sipFunds) {
        assert.equal(f.sipAmount! % 1000, 0);
      }
    });

    it("should have SIP funds with sipFrequency MONTHLY", () => {
      const funds = generateMockMutualFunds(5);
      const sipFunds = funds.filter((f) => f.isSIP);
      for (const f of sipFunds) {
        assert.equal(f.sipFrequency, "MONTHLY");
      }
    });

    it("should have SIP funds with sipDay between 1 and 27", () => {
      const funds = generateMockMutualFunds(5);
      const sipFunds = funds.filter((f) => f.isSIP);
      for (const f of sipFunds) {
        assert.ok(f.sipDay! >= 1, `sipDay ${f.sipDay} should be >= 1`);
        assert.ok(f.sipDay! < 28, `sipDay ${f.sipDay} should be < 28`);
      }
    });

    it("should have SIP funds with nextSIPDate in the future", () => {
      const funds = generateMockMutualFunds(5);
      const sipFunds = funds.filter((f) => f.isSIP);
      const now = Date.now();
      for (const f of sipFunds) {
        assert.ok(f.nextSIPDate instanceof Date);
        assert.ok(f.nextSIPDate!.getTime() > now);
      }
    });

    it("should have non-SIP funds without sipAmount", () => {
      const funds = generateMockMutualFunds(5);
      const nonSipFunds = funds.filter((f) => !f.isSIP);
      for (const f of nonSipFunds) {
        assert.equal(f.sipAmount, undefined);
      }
    });

    it("should have non-SIP funds without sipFrequency", () => {
      const funds = generateMockMutualFunds(5);
      const nonSipFunds = funds.filter((f) => !f.isSIP);
      for (const f of nonSipFunds) {
        assert.equal(f.sipFrequency, undefined);
      }
    });

    it("should have non-SIP funds without nextSIPDate", () => {
      const funds = generateMockMutualFunds(5);
      const nonSipFunds = funds.filter((f) => !f.isSIP);
      for (const f of nonSipFunds) {
        assert.equal(f.nextSIPDate, undefined);
      }
    });

    it("should calculate pnl as currentValue - investedValue", () => {
      const funds = generateMockMutualFunds(5);
      for (const f of funds) {
        const expected = parseFloat(
          (f.currentValue - f.investedValue).toFixed(2)
        );
        assert.ok(
          Math.abs(f.pnl - expected) < 0.02,
          `pnl ${f.pnl} should be close to ${expected}`
        );
      }
    });

    it("should have lastNavDate as Date instance", () => {
      const funds = generateMockMutualFunds(3);
      for (const f of funds) {
        assert.ok(f.lastNavDate instanceof Date);
      }
    });

    it("should have positive investedValue", () => {
      const funds = generateMockMutualFunds(5);
      for (const f of funds) {
        assert.ok(f.investedValue > 0);
      }
    });

    it("should have positive currentValue", () => {
      const funds = generateMockMutualFunds(5);
      for (const f of funds) {
        assert.ok(f.currentValue > 0);
      }
    });
  });

  // --------------------------------------------------------------------------
  // shouldUseMockData
  // --------------------------------------------------------------------------

  describe("shouldUseMockData", () => {
    const savedEnv: Record<string, string | undefined> = {};
    const ALL_KEYS = [
      "ZERODHA_API_KEY",
      "ZERODHA_API_SECRET",
      "UPSTOX_API_KEY",
      "UPSTOX_API_SECRET",
      "FYERS_APP_ID",
      "FYERS_SECRET_KEY",
      "DHAN_CLIENT_ID",
      "DHAN_API_KEY",
      "ANGEL_API_KEY",
      "ANGEL_CLIENT_CODE",
      "GROWW_API_KEY",
      "ICICI_API_KEY",
      "ICICI_SECRET_KEY",
      "HDFC_API_KEY",
      "HDFC_SECRET_KEY",
    ];

    beforeEach(() => {
      for (const key of ALL_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it("should return true for ZERODHA when env vars are missing", () => {
      assert.equal(shouldUseMockData("ZERODHA"), true);
    });

    it("should return false for ZERODHA when all env vars are present", () => {
      process.env.ZERODHA_API_KEY = "test_key";
      process.env.ZERODHA_API_SECRET = "test_secret";
      assert.equal(shouldUseMockData("ZERODHA"), false);
    });

    it("should return true for ZERODHA when only API key is present", () => {
      process.env.ZERODHA_API_KEY = "test_key";
      assert.equal(shouldUseMockData("ZERODHA"), true);
    });

    it("should return true for ZERODHA when only API secret is present", () => {
      process.env.ZERODHA_API_SECRET = "test_secret";
      assert.equal(shouldUseMockData("ZERODHA"), true);
    });

    it("should return true for UPSTOX when env vars are missing", () => {
      assert.equal(shouldUseMockData("UPSTOX"), true);
    });

    it("should return false for UPSTOX when all env vars are present", () => {
      process.env.UPSTOX_API_KEY = "test_key";
      process.env.UPSTOX_API_SECRET = "test_secret";
      assert.equal(shouldUseMockData("UPSTOX"), false);
    });

    it("should return true for DHAN when env vars are missing", () => {
      assert.equal(shouldUseMockData("DHAN"), true);
    });

    it("should return false for DHAN when all env vars are present", () => {
      process.env.DHAN_CLIENT_ID = "test_id";
      process.env.DHAN_API_KEY = "test_key";
      assert.equal(shouldUseMockData("DHAN"), false);
    });

    it("should return true for FYERS when env vars are missing", () => {
      assert.equal(shouldUseMockData("FYERS"), true);
    });

    it("should return false for FYERS when all env vars are present", () => {
      process.env.FYERS_APP_ID = "test_id";
      process.env.FYERS_SECRET_KEY = "test_secret";
      assert.equal(shouldUseMockData("FYERS"), false);
    });

    it("should return true for GROWW when env var is missing", () => {
      assert.equal(shouldUseMockData("GROWW"), true);
    });

    it("should return false for GROWW when env var is present", () => {
      process.env.GROWW_API_KEY = "test_key";
      assert.equal(shouldUseMockData("GROWW"), false);
    });

    it("should return false for unknown broker (empty env key list returns false from .some)", () => {
      assert.equal(shouldUseMockData("UNKNOWN_BROKER"), false);
    });
  });
});
