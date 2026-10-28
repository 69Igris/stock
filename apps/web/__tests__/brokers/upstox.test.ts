/**
 * Upstox Client Normalization Tests
 *
 * Tests for the Upstox API response normalization logic.
 * Verifies correct mapping of Upstox-specific fields to our normalized format.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Segment mapping function (from upstox.ts)
function getSegmentFromExchange(exchange: string): string {
  const exchangeToSegment: Record<string, string> = {
    NSE_EQ: "CASH",
    BSE_EQ: "CASH",
    NSE_FO: "FNO",
    BSE_FO: "FNO",
    MCX_FO: "COM",
    NSE_CD: "CD",
    BSE_CD: "CD",
  };
  return exchangeToSegment[exchange] || "CASH";
}

// Holdings normalization function (mirrors upstox.ts logic)
function normalizeHolding(h: any) {
  return {
    symbol: h.tradingsymbol,
    tradingSymbol: h.tradingsymbol,
    instrumentToken: h.instrument_token,
    isin: h.isin,
    exchange: h.exchange,
    totalQuantity: h.quantity,
    freeQuantity: h.quantity - (h.t1_quantity || 0),
    t1Quantity: h.t1_quantity || 0,
    pledgedQuantity: h.collateral_quantity || 0,
    averagePrice: h.average_price,
    currentPrice: h.last_price,
    investedValue: h.quantity * h.average_price,
    currentValue: h.quantity * h.last_price,
    pnl: h.pnl || (h.last_price - h.average_price) * h.quantity,
    pnlPercentage:
      h.average_price > 0
        ? ((h.last_price - h.average_price) / h.average_price) * 100
        : 0,
    dayChange: h.day_change || 0,
    dayChangePercentage: h.day_change_percentage || 0,
    product: h.product || "D",
  };
}

// Position normalization function (mirrors upstox.ts logic)
function normalizePosition(p: any) {
  const segment = getSegmentFromExchange(p.exchange);
  const pnl = p.pnl || (p.last_price - p.average_price) * p.quantity;

  return {
    symbol: p.tradingsymbol,
    tradingSymbol: p.tradingsymbol,
    instrumentToken: p.instrument_token,
    exchange: p.exchange,
    segment: segment,
    productType: p.product,
    positionType:
      p.day_buy_quantity > 0 || p.day_sell_quantity > 0 ? "DAY" : "NET",
    quantity: p.quantity,
    buyQuantity: p.day_buy_quantity,
    sellQuantity: p.day_sell_quantity,
    overnightQuantity: p.overnight_quantity || 0,
    buyPrice: p.day_buy_price || p.average_price,
    sellPrice: p.day_sell_price || 0,
    averagePrice: p.average_price,
    lastPrice: p.last_price,
    closePrice: p.close_price || 0,
    buyValue: p.day_buy_value || 0,
    sellValue: p.day_sell_value || 0,
    value: p.quantity * p.last_price,
    pnl: pnl,
    realizedPnl: p.realised || 0,
    unrealizedPnl: p.unrealised || pnl,
    pnlPercentage:
      p.average_price && p.quantity
        ? (pnl / Math.abs(p.quantity * p.average_price)) * 100
        : 0,
    multiplier: p.multiplier || 1,
  };
}

// Trade normalization function (mirrors upstox.ts logic)
function normalizeTrade(t: any) {
  const segment = getSegmentFromExchange(t.exchange);
  const executionPrice = t.average_price || t.price || 0;
  const value = t.quantity * executionPrice;

  return {
    tradeId: t.trade_id,
    orderId: t.order_id,
    symbol: t.tradingsymbol,
    tradingSymbol: t.tradingsymbol,
    exchange: t.exchange,
    segment: segment,
    transactionType: t.transaction_type as "BUY" | "SELL",
    quantity: t.quantity,
    price: executionPrice,
    value: value,
    tradeTime: new Date(
      t.trade_timestamp || t.fill_timestamp || t.order_timestamp
    ),
    productType: t.product,
    orderType: t.order_type,
  };
}

describe("Upstox Client Normalization", () => {
  describe("Segment Mapping from Exchange", () => {
    it("should map NSE_EQ to CASH", () => {
      assert.strictEqual(getSegmentFromExchange("NSE_EQ"), "CASH");
    });

    it("should map BSE_EQ to CASH", () => {
      assert.strictEqual(getSegmentFromExchange("BSE_EQ"), "CASH");
    });

    it("should map NSE_FO to FNO", () => {
      assert.strictEqual(getSegmentFromExchange("NSE_FO"), "FNO");
    });

    it("should map BSE_FO to FNO", () => {
      assert.strictEqual(getSegmentFromExchange("BSE_FO"), "FNO");
    });

    it("should map MCX_FO to COM", () => {
      assert.strictEqual(getSegmentFromExchange("MCX_FO"), "COM");
    });

    it("should map NSE_CD to CD", () => {
      assert.strictEqual(getSegmentFromExchange("NSE_CD"), "CD");
    });

    it("should map BSE_CD to CD", () => {
      assert.strictEqual(getSegmentFromExchange("BSE_CD"), "CD");
    });

    it("should default to CASH for unknown exchange", () => {
      assert.strictEqual(getSegmentFromExchange("UNKNOWN"), "CASH");
    });
  });

  describe("Holdings Normalization", () => {
    it("should normalize basic holding correctly", () => {
      const upstoxResponse = {
        tradingsymbol: "RELIANCE",
        instrument_token: "NSE_EQ|INE002A01018",
        isin: "INE002A01018",
        exchange: "NSE_EQ",
        quantity: 10,
        average_price: 2400,
        last_price: 2450,
        pnl: 500,
        day_change: 30,
        day_change_percentage: 1.24,
        t1_quantity: 0,
      };

      const normalized = normalizeHolding(upstoxResponse);

      assert.strictEqual(normalized.symbol, "RELIANCE");
      assert.strictEqual(normalized.totalQuantity, 10);
      assert.strictEqual(normalized.averagePrice, 2400);
      assert.strictEqual(normalized.currentPrice, 2450);
      assert.strictEqual(normalized.investedValue, 24000);
      assert.strictEqual(normalized.currentValue, 24500);
      assert.strictEqual(normalized.pnl, 500);
    });

    it("should calculate pnlPercentage correctly", () => {
      const holding = {
        tradingsymbol: "INFY",
        instrument_token: "NSE_EQ|INF123",
        exchange: "NSE_EQ",
        quantity: 10,
        average_price: 1500,
        last_price: 1650,
        pnl: 1500,
      };

      const normalized = normalizeHolding(holding);

      // ((1650 - 1500) / 1500) * 100 = 10%
      assert.strictEqual(normalized.pnlPercentage, 10);
    });

    it("should handle zero average price", () => {
      const holding = {
        tradingsymbol: "TEST",
        instrument_token: "NSE_EQ|TEST",
        exchange: "NSE_EQ",
        quantity: 10,
        average_price: 0,
        last_price: 100,
        pnl: 0,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pnlPercentage, 0);
    });

    it("should handle T1 quantities", () => {
      const holding = {
        tradingsymbol: "TCS",
        instrument_token: "NSE_EQ|TCS",
        exchange: "NSE_EQ",
        quantity: 20,
        t1_quantity: 5,
        average_price: 3500,
        last_price: 3600,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.totalQuantity, 20);
      assert.strictEqual(normalized.freeQuantity, 15);
      assert.strictEqual(normalized.t1Quantity, 5);
    });

    it("should handle collateral/pledged quantities", () => {
      const holding = {
        tradingsymbol: "HDFC",
        instrument_token: "NSE_EQ|HDFC",
        exchange: "NSE_EQ",
        quantity: 30,
        collateral_quantity: 10,
        average_price: 1600,
        last_price: 1650,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pledgedQuantity, 10);
    });

    it("should calculate pnl when not provided", () => {
      const holding = {
        tradingsymbol: "WIPRO",
        instrument_token: "NSE_EQ|WIPRO",
        exchange: "NSE_EQ",
        quantity: 10,
        average_price: 400,
        last_price: 420,
        // No pnl field
      };

      const normalized = normalizeHolding(holding);

      // (420 - 400) * 10 = 200
      assert.strictEqual(normalized.pnl, 200);
    });
  });

  describe("Position Normalization", () => {
    it("should normalize basic position correctly", () => {
      const upstoxPosition = {
        tradingsymbol: "RELIANCE",
        instrument_token: "NSE_EQ|INE002A01018",
        exchange: "NSE_EQ",
        product: "D",
        quantity: 10,
        day_buy_quantity: 10,
        day_sell_quantity: 0,
        overnight_quantity: 0,
        day_buy_price: 2400,
        day_sell_price: 0,
        average_price: 2400,
        last_price: 2450,
        close_price: 2420,
        day_buy_value: 24000,
        day_sell_value: 0,
        pnl: 500,
        realised: 0,
        unrealised: 500,
        multiplier: 1,
      };

      const normalized = normalizePosition(upstoxPosition);

      assert.strictEqual(normalized.symbol, "RELIANCE");
      assert.strictEqual(normalized.segment, "CASH");
      assert.strictEqual(normalized.productType, "D");
      assert.strictEqual(normalized.positionType, "DAY");
      assert.strictEqual(normalized.quantity, 10);
      assert.strictEqual(normalized.pnl, 500);
    });

    it("should correctly identify F&O positions", () => {
      const fnoPosition = {
        tradingsymbol: "NIFTY24JAN25000CE",
        instrument_token: "NSE_FO|NIFTY",
        exchange: "NSE_FO",
        product: "D",
        quantity: 50,
        day_buy_quantity: 50,
        day_sell_quantity: 0,
        average_price: 150,
        last_price: 165,
        pnl: 750,
        multiplier: 1,
      };

      const normalized = normalizePosition(fnoPosition);

      assert.strictEqual(normalized.segment, "FNO");
    });

    it("should handle overnight positions (NET)", () => {
      const netPosition = {
        tradingsymbol: "INFY",
        instrument_token: "NSE_EQ|INFY",
        exchange: "NSE_EQ",
        product: "CNC",
        quantity: 10,
        day_buy_quantity: 0,
        day_sell_quantity: 0,
        overnight_quantity: 10,
        average_price: 1500,
        last_price: 1550,
        pnl: 500,
        multiplier: 1,
      };

      const normalized = normalizePosition(netPosition);

      assert.strictEqual(normalized.positionType, "NET");
      assert.strictEqual(normalized.overnightQuantity, 10);
    });

    it("should calculate pnlPercentage correctly", () => {
      const position = {
        tradingsymbol: "TEST",
        instrument_token: "NSE_EQ|TEST",
        exchange: "NSE_EQ",
        product: "D",
        quantity: 10,
        day_buy_quantity: 10,
        day_sell_quantity: 0,
        average_price: 100,
        last_price: 110,
        pnl: 100,
        multiplier: 1,
      };

      const normalized = normalizePosition(position);

      // 100 / (10 * 100) * 100 = 10%
      assert.strictEqual(normalized.pnlPercentage, 10);
    });

    it("should handle commodity positions", () => {
      const commodityPosition = {
        tradingsymbol: "GOLDM24FEB",
        instrument_token: "MCX_FO|GOLDM",
        exchange: "MCX_FO",
        product: "M",
        quantity: 1,
        day_buy_quantity: 1,
        day_sell_quantity: 0,
        average_price: 59000,
        last_price: 59500,
        pnl: 500,
        multiplier: 1,
      };

      const normalized = normalizePosition(commodityPosition);

      assert.strictEqual(normalized.segment, "COM");
    });
  });

  describe("Trade Normalization", () => {
    it("should use average_price as execution price", () => {
      const upstoxTrade = {
        trade_id: "T12345",
        order_id: "O67890",
        tradingsymbol: "RELIANCE",
        exchange: "NSE_EQ",
        transaction_type: "BUY",
        quantity: 10,
        price: 0, // This field is often 0
        average_price: 2450.75, // This is the actual execution price
        trade_timestamp: "2024-01-15T10:30:00+05:30",
        product: "D",
        order_type: "MARKET",
      };

      const normalized = normalizeTrade(upstoxTrade);

      assert.strictEqual(normalized.price, 2450.75);
      assert.strictEqual(normalized.value, 10 * 2450.75);
    });

    it("should correctly map segment from exchange", () => {
      const fnoTrade = {
        trade_id: "T12345",
        order_id: "O67890",
        tradingsymbol: "NIFTY24JAN25000CE",
        exchange: "NSE_FO",
        transaction_type: "BUY",
        quantity: 50,
        average_price: 150.5,
        trade_timestamp: "2024-01-15T10:00:00+05:30",
        product: "M",
        order_type: "MARKET",
      };

      const normalized = normalizeTrade(fnoTrade);

      assert.strictEqual(normalized.segment, "FNO");
    });

    it("should handle buy and sell transactions", () => {
      const buyTrade = {
        trade_id: "1",
        tradingsymbol: "TEST",
        exchange: "NSE_EQ",
        transaction_type: "BUY",
        quantity: 10,
        average_price: 100,
        trade_timestamp: "2024-01-15T10:00:00",
        product: "D",
        order_type: "MARKET",
      };

      const sellTrade = {
        ...buyTrade,
        trade_id: "2",
        transaction_type: "SELL",
      };

      assert.strictEqual(normalizeTrade(buyTrade).transactionType, "BUY");
      assert.strictEqual(normalizeTrade(sellTrade).transactionType, "SELL");
    });

    it("should fall back to price if average_price is missing", () => {
      const trade = {
        trade_id: "T123",
        tradingsymbol: "TCS",
        exchange: "NSE_EQ",
        transaction_type: "SELL",
        quantity: 5,
        price: 3800.5,
        // No average_price
        trade_timestamp: "2024-01-15T14:00:00+05:30",
        product: "D",
        order_type: "LIMIT",
      };

      const normalized = normalizeTrade(trade);

      assert.strictEqual(normalized.price, 3800.5);
    });

    it("should handle different timestamp fields", () => {
      const tradeWithFillTimestamp = {
        trade_id: "T1",
        tradingsymbol: "TEST",
        exchange: "NSE_EQ",
        transaction_type: "BUY",
        quantity: 1,
        average_price: 100,
        fill_timestamp: "2024-01-15T10:00:00",
        product: "D",
        order_type: "MARKET",
      };

      const tradeWithOrderTimestamp = {
        trade_id: "T2",
        tradingsymbol: "TEST",
        exchange: "NSE_EQ",
        transaction_type: "BUY",
        quantity: 1,
        average_price: 100,
        order_timestamp: "2024-01-15T11:00:00",
        product: "D",
        order_type: "MARKET",
      };

      const norm1 = normalizeTrade(tradeWithFillTimestamp);
      const norm2 = normalizeTrade(tradeWithOrderTimestamp);

      assert.ok(norm1.tradeTime instanceof Date);
      assert.ok(norm2.tradeTime instanceof Date);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty holdings array", () => {
      const holdings: any[] = [];
      const normalized = holdings.map(normalizeHolding);
      assert.deepStrictEqual(normalized, []);
    });

    it("should handle negative pnl", () => {
      const holding = {
        tradingsymbol: "LOSS",
        instrument_token: "NSE_EQ|LOSS",
        exchange: "NSE_EQ",
        quantity: 10,
        average_price: 200,
        last_price: 150,
        pnl: -500,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pnl, -500);
      assert.ok(normalized.pnlPercentage < 0);
    });

    it("should handle very large quantities", () => {
      const holding = {
        tradingsymbol: "LARGE",
        instrument_token: "NSE_EQ|LARGE",
        exchange: "NSE_EQ",
        quantity: 1000000,
        average_price: 100,
        last_price: 105,
        pnl: 5000000,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.investedValue, 100000000);
      assert.strictEqual(normalized.currentValue, 105000000);
    });

    it("should handle decimal quantities", () => {
      const holding = {
        tradingsymbol: "DECIMAL",
        instrument_token: "NSE_EQ|DEC",
        exchange: "NSE_EQ",
        quantity: 10.5,
        average_price: 100,
        last_price: 105,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.totalQuantity, 10.5);
      assert.strictEqual(normalized.investedValue, 1050);
    });
  });
});
