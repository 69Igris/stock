/**
 * Zerodha Client Normalization Tests
 *
 * Tests for the Zerodha API response normalization logic.
 * Verifies correct mapping of Zerodha-specific fields to our normalized format.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Segment mapping function (from zerodha.ts)
function getSegmentFromExchange(exchange: string): string {
  const exchangeToSegment: Record<string, string> = {
    NSE: "CASH",
    BSE: "CASH",
    NFO: "FO",
    BFO: "FO",
    CDS: "CD",
    MCX: "COM",
    NCDEX: "COM",
  };
  return exchangeToSegment[exchange] || "CASH";
}

// Trade normalization function (mirrors zerodha.ts getTrades logic)
function normalizeTrade(t: any) {
  const segment = getSegmentFromExchange(t.exchange);
  // Zerodha returns average_price as the execution price (not "price")
  const executionPrice = t.average_price || t.price || 0;
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
    value: t.quantity * executionPrice,
    tradeTime: new Date(t.fill_timestamp),
    productType: t.product,
    orderType: t.order_type,
  };
}

// Holdings normalization function (mirrors zerodha.ts getHoldings logic)
function normalizeHolding(h: any) {
  return {
    symbol: h.tradingsymbol,
    tradingSymbol: h.tradingsymbol,
    name: h.tradingsymbol,
    instrumentToken: h.instrument_token,
    isin: h.isin,
    exchange: h.exchange,
    quantity: h.quantity,
    averagePrice: h.average_price,
    currentPrice: h.last_price,
    closePrice: h.close_price,
    investedValue: h.quantity * h.average_price,
    currentValue: h.quantity * h.last_price,
    pnl: h.pnl,
    pnlPercentage:
      h.average_price > 0
        ? ((h.last_price - h.average_price) / h.average_price) * 100
        : 0,
    dayChange: h.day_change,
    dayChangePercentage: h.day_change_percentage,
    t1Quantity: h.t1_quantity,
    pledgedQuantity: h.pledged_quantity || 0,
    collateralQuantity: h.collateral_quantity || 0,
    mtf: h.mtf
      ? {
          quantity: h.mtf.quantity,
          usedQuantity: h.mtf.used_quantity,
          averagePrice: h.mtf.average_price,
          value: h.mtf.value,
          initialMargin: h.mtf.initial_margin,
        }
      : null,
  };
}

// Position normalization function (mirrors zerodha.ts normalizePosition logic)
function normalizePosition(p: any, type: "DAY" | "NET") {
  const segment = getSegmentFromExchange(p.exchange);

  return {
    symbol: p.tradingsymbol,
    tradingSymbol: p.tradingsymbol,
    instrumentToken: p.instrument_token,
    exchange: p.exchange,
    segment: segment,
    productType: p.product,
    positionType: type,
    quantity: p.quantity,
    buyQuantity: p.buy_quantity,
    sellQuantity: p.sell_quantity,
    overnightQuantity: p.overnight_quantity || 0,
    buyPrice: p.buy_price,
    sellPrice: p.sell_price,
    averagePrice: p.average_price,
    lastPrice: p.last_price,
    closePrice: p.close_price,
    buyValue: p.buy_value,
    sellValue: p.sell_value,
    value: p.value,
    pnl: p.pnl,
    m2m: p.m2m,
    realizedPnl: p.realised,
    unrealizedPnl: p.unrealised,
    pnlPercentage:
      p.average_price && p.quantity
        ? (p.pnl / Math.abs(p.quantity * p.average_price)) * 100
        : 0,
    multiplier: p.multiplier,
  };
}

describe("Zerodha Client Normalization", () => {
  describe("Segment Mapping from Exchange", () => {
    it("should map NSE to CASH", () => {
      assert.strictEqual(getSegmentFromExchange("NSE"), "CASH");
    });

    it("should map BSE to CASH", () => {
      assert.strictEqual(getSegmentFromExchange("BSE"), "CASH");
    });

    it("should map NFO to FO", () => {
      assert.strictEqual(getSegmentFromExchange("NFO"), "FO");
    });

    it("should map BFO to FO", () => {
      assert.strictEqual(getSegmentFromExchange("BFO"), "FO");
    });

    it("should map CDS to CD", () => {
      assert.strictEqual(getSegmentFromExchange("CDS"), "CD");
    });

    it("should map MCX to COM", () => {
      assert.strictEqual(getSegmentFromExchange("MCX"), "COM");
    });

    it("should map NCDEX to COM", () => {
      assert.strictEqual(getSegmentFromExchange("NCDEX"), "COM");
    });

    it("should default to CASH for unknown exchange", () => {
      assert.strictEqual(getSegmentFromExchange("UNKNOWN"), "CASH");
    });
  });

  describe("Trade Normalization", () => {
    it("should use average_price as execution price", () => {
      const zerodhaResponse = {
        trade_id: "12345",
        order_id: "67890",
        tradingsymbol: "RELIANCE",
        exchange: "NSE",
        transaction_type: "BUY",
        quantity: 10,
        price: 0, // This field is often 0 in Zerodha response
        average_price: 2450.75, // This is the actual execution price
        fill_timestamp: "2024-01-15T10:30:00+05:30",
        product: "CNC",
        order_type: "MARKET",
      };

      const normalized = normalizeTrade(zerodhaResponse);

      assert.strictEqual(normalized.price, 2450.75);
      assert.strictEqual(normalized.value, 10 * 2450.75);
    });

    it("should fall back to price if average_price is 0", () => {
      const zerodhaResponse = {
        trade_id: "12345",
        order_id: "67890",
        tradingsymbol: "TCS",
        exchange: "NSE",
        transaction_type: "SELL",
        quantity: 5,
        price: 3800.5,
        average_price: 0,
        fill_timestamp: "2024-01-15T14:00:00+05:30",
        product: "MIS",
        order_type: "LIMIT",
      };

      const normalized = normalizeTrade(zerodhaResponse);

      assert.strictEqual(normalized.price, 3800.5);
    });

    it("should default to 0 if both average_price and price are missing", () => {
      const zerodhaResponse = {
        trade_id: "12345",
        order_id: "67890",
        tradingsymbol: "INFY",
        exchange: "NSE",
        transaction_type: "BUY",
        quantity: 10,
        fill_timestamp: "2024-01-15T10:00:00+05:30",
        product: "CNC",
        order_type: "MARKET",
      };

      const normalized = normalizeTrade(zerodhaResponse);

      assert.strictEqual(normalized.price, 0);
      assert.strictEqual(normalized.value, 0);
    });

    it("should correctly map segment from exchange", () => {
      const nfoTrade = {
        trade_id: "12345",
        order_id: "67890",
        tradingsymbol: "NIFTY24JAN25000CE",
        exchange: "NFO",
        transaction_type: "BUY",
        quantity: 50,
        average_price: 150.5,
        fill_timestamp: "2024-01-15T10:00:00+05:30",
        product: "NRML",
        order_type: "MARKET",
      };

      const normalized = normalizeTrade(nfoTrade);

      assert.strictEqual(normalized.segment, "FO");
    });

    it("should map transaction type correctly", () => {
      const buyTrade = {
        trade_id: "1",
        tradingsymbol: "TEST",
        exchange: "NSE",
        transaction_type: "BUY",
        quantity: 1,
        average_price: 100,
        fill_timestamp: "2024-01-15T10:00:00",
        product: "CNC",
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
  });

  describe("Holdings Normalization", () => {
    it("should use tradingsymbol as name", () => {
      const holding = {
        tradingsymbol: "RELIANCE",
        instrument_token: 738561,
        isin: "INE002A01018",
        exchange: "NSE",
        quantity: 10,
        average_price: 2400,
        last_price: 2450,
        close_price: 2420,
        pnl: 500,
        day_change: 30,
        day_change_percentage: 1.24,
        t1_quantity: 0,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.name, "RELIANCE");
      assert.strictEqual(normalized.symbol, "RELIANCE");
    });

    it("should calculate investedValue and currentValue correctly", () => {
      const holding = {
        tradingsymbol: "TCS",
        instrument_token: 123456,
        exchange: "NSE",
        quantity: 5,
        average_price: 3800,
        last_price: 3900,
        pnl: 500,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.investedValue, 5 * 3800); // 19000
      assert.strictEqual(normalized.currentValue, 5 * 3900); // 19500
    });

    it("should calculate pnlPercentage correctly", () => {
      const holding = {
        tradingsymbol: "INFY",
        instrument_token: 456789,
        exchange: "NSE",
        quantity: 10,
        average_price: 1500,
        last_price: 1650,
        pnl: 1500,
      };

      const normalized = normalizeHolding(holding);

      // ((1650 - 1500) / 1500) * 100 = 10%
      assert.strictEqual(normalized.pnlPercentage, 10);
    });

    it("should return 0 pnlPercentage when average_price is 0", () => {
      const holding = {
        tradingsymbol: "TEST",
        instrument_token: 111,
        exchange: "NSE",
        quantity: 10,
        average_price: 0,
        last_price: 100,
        pnl: 0,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pnlPercentage, 0);
    });

    it("should handle MTF data when present", () => {
      const holding = {
        tradingsymbol: "RELIANCE",
        instrument_token: 738561,
        exchange: "NSE",
        quantity: 10,
        average_price: 2400,
        last_price: 2450,
        pnl: 500,
        mtf: {
          quantity: 5,
          used_quantity: 3,
          average_price: 2380,
          value: 11900,
          initial_margin: 3570,
        },
      };

      const normalized = normalizeHolding(holding);

      assert.ok(normalized.mtf);
      assert.strictEqual(normalized.mtf.quantity, 5);
      assert.strictEqual(normalized.mtf.usedQuantity, 3);
      assert.strictEqual(normalized.mtf.averagePrice, 2380);
    });

    it("should set mtf to null when not present", () => {
      const holding = {
        tradingsymbol: "TCS",
        instrument_token: 123456,
        exchange: "NSE",
        quantity: 5,
        average_price: 3800,
        last_price: 3900,
        pnl: 500,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.mtf, null);
    });

    it("should handle pledged and collateral quantities", () => {
      const holding = {
        tradingsymbol: "HDFC",
        instrument_token: 222333,
        exchange: "NSE",
        quantity: 20,
        average_price: 1600,
        last_price: 1650,
        pnl: 1000,
        pledged_quantity: 5,
        collateral_quantity: 3,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pledgedQuantity, 5);
      assert.strictEqual(normalized.collateralQuantity, 3);
    });

    it("should default pledged and collateral to 0 when missing", () => {
      const holding = {
        tradingsymbol: "TEST",
        instrument_token: 111,
        exchange: "NSE",
        quantity: 10,
        average_price: 100,
        last_price: 100,
        pnl: 0,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pledgedQuantity, 0);
      assert.strictEqual(normalized.collateralQuantity, 0);
    });
  });

  describe("Position Normalization", () => {
    it("should map all position fields correctly", () => {
      const zerodhaPosition = {
        tradingsymbol: "RELIANCE",
        instrument_token: 738561,
        exchange: "NSE",
        product: "CNC",
        quantity: 10,
        buy_quantity: 10,
        sell_quantity: 0,
        overnight_quantity: 10,
        buy_price: 2400,
        sell_price: 0,
        average_price: 2400,
        last_price: 2450,
        close_price: 2420,
        buy_value: 24000,
        sell_value: 0,
        value: 24500,
        pnl: 500,
        m2m: 300,
        realised: 0,
        unrealised: 500,
        multiplier: 1,
      };

      const normalized = normalizePosition(zerodhaPosition, "NET");

      assert.strictEqual(normalized.symbol, "RELIANCE");
      assert.strictEqual(normalized.segment, "CASH");
      assert.strictEqual(normalized.productType, "CNC");
      assert.strictEqual(normalized.positionType, "NET");
      assert.strictEqual(normalized.quantity, 10);
      assert.strictEqual(normalized.averagePrice, 2400);
      assert.strictEqual(normalized.lastPrice, 2450);
      assert.strictEqual(normalized.pnl, 500);
      assert.strictEqual(normalized.realizedPnl, 0);
      assert.strictEqual(normalized.unrealizedPnl, 500);
    });

    it("should handle DAY position type", () => {
      const zerodhaPosition = {
        tradingsymbol: "INFY",
        instrument_token: 456789,
        exchange: "NSE",
        product: "MIS",
        quantity: 5,
        buy_quantity: 5,
        sell_quantity: 0,
        buy_price: 1520,
        sell_price: 0,
        average_price: 1520,
        last_price: 1530,
        buy_value: 7600,
        sell_value: 0,
        value: 7650,
        pnl: 50,
        m2m: 50,
        realised: 0,
        unrealised: 50,
        multiplier: 1,
      };

      const normalized = normalizePosition(zerodhaPosition, "DAY");

      assert.strictEqual(normalized.positionType, "DAY");
      assert.strictEqual(normalized.productType, "MIS");
    });

    it("should handle NFO positions correctly", () => {
      const nfoPosition = {
        tradingsymbol: "NIFTY24JAN25000CE",
        instrument_token: 999888,
        exchange: "NFO",
        product: "NRML",
        quantity: 50,
        buy_quantity: 50,
        sell_quantity: 0,
        buy_price: 150,
        sell_price: 0,
        average_price: 150,
        last_price: 165,
        buy_value: 7500,
        sell_value: 0,
        value: 8250,
        pnl: 750,
        m2m: 750,
        realised: 0,
        unrealised: 750,
        multiplier: 1,
      };

      const normalized = normalizePosition(nfoPosition, "NET");

      assert.strictEqual(normalized.segment, "FO");
      assert.strictEqual(normalized.productType, "NRML");
    });

    it("should calculate pnlPercentage correctly", () => {
      const position = {
        tradingsymbol: "TEST",
        instrument_token: 111,
        exchange: "NSE",
        product: "CNC",
        quantity: 10,
        buy_quantity: 10,
        sell_quantity: 0,
        buy_price: 100,
        sell_price: 0,
        average_price: 100,
        last_price: 110,
        buy_value: 1000,
        sell_value: 0,
        value: 1100,
        pnl: 100,
        m2m: 100,
        realised: 0,
        unrealised: 100,
        multiplier: 1,
      };

      const normalized = normalizePosition(position, "NET");

      // pnl / (abs(quantity) * average_price) * 100 = 100 / 1000 * 100 = 10%
      assert.strictEqual(normalized.pnlPercentage, 10);
    });

    it("should default overnight_quantity to 0 when missing", () => {
      const position = {
        tradingsymbol: "TEST",
        instrument_token: 111,
        exchange: "NSE",
        product: "MIS",
        quantity: 5,
        buy_quantity: 5,
        sell_quantity: 0,
        buy_price: 100,
        average_price: 100,
        last_price: 105,
        pnl: 25,
      };

      const normalized = normalizePosition(position, "DAY");

      assert.strictEqual(normalized.overnightQuantity, 0);
    });
  });
});
