/**
 * Dhan Client Normalization Tests
 *
 * Tests for the Dhan API response normalization logic.
 * Verifies correct mapping of Dhan-specific fields to our normalized format.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Exchange to segment mapping (from dhan.ts)
function getSegmentFromExchange(exchange: string): string {
  const exchangeToSegment: Record<string, string> = {
    NSE: "CASH",
    BSE: "CASH",
    NSE_FNO: "FNO",
    BSE_FNO: "FNO",
    MCX: "COM",
    CDS: "CD",
  };
  return exchangeToSegment[exchange] || "CASH";
}

// Holdings normalization function (mirrors dhan.ts logic)
function normalizeHolding(h: any) {
  const investedValue = h.quantity * h.avgCostPrice;
  const currentValue = h.quantity * h.ltp;
  const pnl = h.unrealizedProfit || currentValue - investedValue;

  return {
    symbol: h.tradingSymbol,
    tradingSymbol: h.tradingSymbol,
    instrumentToken: h.securityId,
    isin: h.isin,
    exchange: h.exchangeSegment,
    totalQuantity: h.quantity,
    freeQuantity: h.quantity - (h.t1Holdings || 0),
    t1Quantity: h.t1Holdings || 0,
    pledgedQuantity: h.collateralQty || 0,
    averagePrice: h.avgCostPrice,
    currentPrice: h.ltp,
    investedValue: investedValue,
    currentValue: currentValue,
    pnl: pnl,
    pnlPercentage: investedValue > 0 ? (pnl / investedValue) * 100 : 0,
    dayChange: h.dayChange || 0,
    dayChangePercentage: h.dayChangePercentage || 0,
    product: h.productCode || "CNC",
  };
}

// Position normalization function (mirrors dhan.ts logic)
function normalizePosition(p: any) {
  const segment = getSegmentFromExchange(p.exchangeSegment);
  const pnl = p.unrealizedProfit || 0;

  return {
    symbol: p.tradingSymbol,
    tradingSymbol: p.tradingSymbol,
    instrumentToken: p.securityId,
    exchange: p.exchangeSegment,
    segment: segment,
    productType: p.productType,
    positionType: p.positionType || (p.netQty === p.dayBuyQty ? "DAY" : "NET"),
    quantity: p.netQty,
    buyQuantity: p.dayBuyQty || 0,
    sellQuantity: p.daySellQty || 0,
    overnightQuantity: p.carryForwardBuyQty || 0,
    buyPrice: p.dayBuyAvgPrice || p.avgPrice || 0,
    sellPrice: p.daySellAvgPrice || 0,
    averagePrice: p.avgPrice,
    lastPrice: p.ltp,
    closePrice: p.previousClose || 0,
    buyValue: p.dayBuyValue || 0,
    sellValue: p.daySellValue || 0,
    value: p.netQty * p.ltp,
    pnl: pnl,
    realizedPnl: p.realizedProfit || 0,
    unrealizedPnl: pnl,
    pnlPercentage:
      p.avgPrice && p.netQty
        ? (pnl / Math.abs(p.netQty * p.avgPrice)) * 100
        : 0,
    multiplier: p.multiplier || 1,
  };
}

// Trade normalization function (mirrors dhan.ts logic)
function normalizeTrade(t: any) {
  const segment = getSegmentFromExchange(t.exchangeSegment);
  const executionPrice = t.tradedPrice || t.avgPrice || 0;
  const value = t.tradedQty * executionPrice;

  return {
    tradeId: t.orderId || t.tradeId,
    orderId: t.orderId,
    symbol: t.tradingSymbol,
    tradingSymbol: t.tradingSymbol,
    exchange: t.exchangeSegment,
    segment: segment,
    transactionType: t.transactionType as "BUY" | "SELL",
    quantity: t.tradedQty || t.quantity,
    price: executionPrice,
    value: value,
    tradeTime: new Date(t.tradedTime || t.orderCreationTime),
    productType: t.productType,
    orderType: t.orderType,
  };
}

describe("Dhan Client Normalization", () => {
  describe("Segment Mapping from Exchange", () => {
    it("should map NSE to CASH", () => {
      assert.strictEqual(getSegmentFromExchange("NSE"), "CASH");
    });

    it("should map BSE to CASH", () => {
      assert.strictEqual(getSegmentFromExchange("BSE"), "CASH");
    });

    it("should map NSE_FNO to FNO", () => {
      assert.strictEqual(getSegmentFromExchange("NSE_FNO"), "FNO");
    });

    it("should map BSE_FNO to FNO", () => {
      assert.strictEqual(getSegmentFromExchange("BSE_FNO"), "FNO");
    });

    it("should map MCX to COM", () => {
      assert.strictEqual(getSegmentFromExchange("MCX"), "COM");
    });

    it("should map CDS to CD", () => {
      assert.strictEqual(getSegmentFromExchange("CDS"), "CD");
    });

    it("should default to CASH for unknown exchange", () => {
      assert.strictEqual(getSegmentFromExchange("UNKNOWN"), "CASH");
    });
  });

  describe("Holdings Normalization", () => {
    it("should normalize basic holding correctly", () => {
      const dhanResponse = {
        tradingSymbol: "RELIANCE",
        securityId: "2885",
        isin: "INE002A01018",
        exchangeSegment: "NSE",
        quantity: 10,
        avgCostPrice: 2400,
        ltp: 2450,
        unrealizedProfit: 500,
        dayChange: 30,
        dayChangePercentage: 1.24,
        t1Holdings: 0,
      };

      const normalized = normalizeHolding(dhanResponse);

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
        tradingSymbol: "INFY",
        securityId: "1234",
        exchangeSegment: "NSE",
        quantity: 10,
        avgCostPrice: 1500,
        ltp: 1650,
        unrealizedProfit: 1500,
      };

      const normalized = normalizeHolding(holding);

      // ((1650 - 1500) / 1500) * 100 = 10%
      // But using pnl / invested: 1500 / 15000 * 100 = 10%
      assert.strictEqual(normalized.pnlPercentage, 10);
    });

    it("should calculate pnl when unrealizedProfit is missing", () => {
      const holding = {
        tradingSymbol: "TCS",
        securityId: "5678",
        exchangeSegment: "NSE",
        quantity: 5,
        avgCostPrice: 3500,
        ltp: 3600,
        // No unrealizedProfit
      };

      const normalized = normalizeHolding(holding);

      // (3600 * 5) - (3500 * 5) = 500
      assert.strictEqual(normalized.pnl, 500);
    });

    it("should handle T1 holdings", () => {
      const holding = {
        tradingSymbol: "HDFC",
        securityId: "9999",
        exchangeSegment: "NSE",
        quantity: 20,
        t1Holdings: 5,
        avgCostPrice: 1600,
        ltp: 1650,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.totalQuantity, 20);
      assert.strictEqual(normalized.freeQuantity, 15);
      assert.strictEqual(normalized.t1Quantity, 5);
    });

    it("should handle collateral quantities", () => {
      const holding = {
        tradingSymbol: "SBIN",
        securityId: "3333",
        exchangeSegment: "NSE",
        quantity: 50,
        collateralQty: 20,
        avgCostPrice: 600,
        ltp: 620,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pledgedQuantity, 20);
    });

    it("should handle zero average price", () => {
      const holding = {
        tradingSymbol: "ZERO",
        securityId: "0000",
        exchangeSegment: "NSE",
        quantity: 10,
        avgCostPrice: 0,
        ltp: 100,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pnlPercentage, 0);
    });
  });

  describe("Position Normalization", () => {
    it("should normalize basic position correctly", () => {
      const dhanPosition = {
        tradingSymbol: "RELIANCE",
        securityId: "2885",
        exchangeSegment: "NSE",
        productType: "CNC",
        netQty: 10,
        dayBuyQty: 10,
        daySellQty: 0,
        dayBuyAvgPrice: 2400,
        daySellAvgPrice: 0,
        avgPrice: 2400,
        ltp: 2450,
        previousClose: 2420,
        dayBuyValue: 24000,
        daySellValue: 0,
        unrealizedProfit: 500,
        realizedProfit: 0,
        multiplier: 1,
      };

      const normalized = normalizePosition(dhanPosition);

      assert.strictEqual(normalized.symbol, "RELIANCE");
      assert.strictEqual(normalized.segment, "CASH");
      assert.strictEqual(normalized.productType, "CNC");
      assert.strictEqual(normalized.quantity, 10);
      assert.strictEqual(normalized.averagePrice, 2400);
      assert.strictEqual(normalized.pnl, 500);
    });

    it("should identify DAY positions correctly", () => {
      const dayPosition = {
        tradingSymbol: "INFY",
        securityId: "1234",
        exchangeSegment: "NSE",
        productType: "INTRADAY",
        netQty: 10,
        dayBuyQty: 10,
        daySellQty: 0,
        avgPrice: 1500,
        ltp: 1520,
        unrealizedProfit: 200,
      };

      const normalized = normalizePosition(dayPosition);

      assert.strictEqual(normalized.positionType, "DAY");
    });

    it("should handle F&O positions", () => {
      const fnoPosition = {
        tradingSymbol: "NIFTY24JAN25000CE",
        securityId: "999888",
        exchangeSegment: "NSE_FNO",
        productType: "MARGIN",
        netQty: 50,
        dayBuyQty: 50,
        daySellQty: 0,
        avgPrice: 150,
        ltp: 165,
        unrealizedProfit: 750,
        multiplier: 1,
      };

      const normalized = normalizePosition(fnoPosition);

      assert.strictEqual(normalized.segment, "FNO");
    });

    it("should handle overnight/carry forward positions", () => {
      const netPosition = {
        tradingSymbol: "TCS",
        securityId: "5678",
        exchangeSegment: "NSE",
        productType: "CNC",
        netQty: 10,
        dayBuyQty: 0,
        daySellQty: 0,
        carryForwardBuyQty: 10,
        avgPrice: 3500,
        ltp: 3550,
        unrealizedProfit: 500,
      };

      const normalized = normalizePosition(netPosition);

      assert.strictEqual(normalized.positionType, "NET");
      assert.strictEqual(normalized.overnightQuantity, 10);
    });

    it("should calculate pnlPercentage correctly", () => {
      const position = {
        tradingSymbol: "TEST",
        securityId: "1111",
        exchangeSegment: "NSE",
        productType: "CNC",
        netQty: 10,
        dayBuyQty: 10,
        avgPrice: 100,
        ltp: 110,
        unrealizedProfit: 100,
      };

      const normalized = normalizePosition(position);

      // 100 / (10 * 100) * 100 = 10%
      assert.strictEqual(normalized.pnlPercentage, 10);
    });

    it("should handle commodity positions", () => {
      const commodityPosition = {
        tradingSymbol: "GOLDM24FEB",
        securityId: "777888",
        exchangeSegment: "MCX",
        productType: "MARGIN",
        netQty: 1,
        dayBuyQty: 1,
        avgPrice: 59000,
        ltp: 59500,
        unrealizedProfit: 500,
      };

      const normalized = normalizePosition(commodityPosition);

      assert.strictEqual(normalized.segment, "COM");
    });

    it("should handle short positions (negative quantity)", () => {
      const shortPosition = {
        tradingSymbol: "NIFTY24JAN25000PE",
        securityId: "888999",
        exchangeSegment: "NSE_FNO",
        productType: "MARGIN",
        netQty: -50,
        dayBuyQty: 0,
        daySellQty: 50,
        avgPrice: 100,
        ltp: 90,
        unrealizedProfit: 500,
      };

      const normalized = normalizePosition(shortPosition);

      assert.strictEqual(normalized.quantity, -50);
      assert.ok(normalized.pnlPercentage !== 0);
    });
  });

  describe("Trade Normalization", () => {
    it("should normalize basic trade correctly", () => {
      const dhanTrade = {
        orderId: "1234567890",
        tradingSymbol: "RELIANCE",
        exchangeSegment: "NSE",
        transactionType: "BUY",
        tradedQty: 10,
        tradedPrice: 2450.75,
        tradedTime: "2024-01-15T10:30:00+05:30",
        productType: "CNC",
        orderType: "MARKET",
      };

      const normalized = normalizeTrade(dhanTrade);

      assert.strictEqual(normalized.symbol, "RELIANCE");
      assert.strictEqual(normalized.price, 2450.75);
      assert.strictEqual(normalized.value, 10 * 2450.75);
      assert.strictEqual(normalized.transactionType, "BUY");
    });

    it("should use avgPrice when tradedPrice is missing", () => {
      const trade = {
        orderId: "1234",
        tradingSymbol: "TCS",
        exchangeSegment: "NSE",
        transactionType: "SELL",
        tradedQty: 5,
        avgPrice: 3800.5,
        tradedTime: "2024-01-15T14:00:00",
        productType: "CNC",
        orderType: "LIMIT",
      };

      const normalized = normalizeTrade(trade);

      assert.strictEqual(normalized.price, 3800.5);
    });

    it("should correctly map segment from exchange", () => {
      const fnoTrade = {
        orderId: "9999",
        tradingSymbol: "NIFTY24JAN25000CE",
        exchangeSegment: "NSE_FNO",
        transactionType: "BUY",
        tradedQty: 50,
        tradedPrice: 150.5,
        tradedTime: "2024-01-15T10:00:00",
        productType: "MARGIN",
        orderType: "MARKET",
      };

      const normalized = normalizeTrade(fnoTrade);

      assert.strictEqual(normalized.segment, "FNO");
    });

    it("should handle both BUY and SELL transactions", () => {
      const buyTrade = {
        orderId: "1",
        tradingSymbol: "TEST",
        exchangeSegment: "NSE",
        transactionType: "BUY",
        tradedQty: 10,
        tradedPrice: 100,
        tradedTime: "2024-01-15T10:00:00",
        productType: "CNC",
        orderType: "MARKET",
      };

      const sellTrade = {
        ...buyTrade,
        orderId: "2",
        transactionType: "SELL",
      };

      assert.strictEqual(normalizeTrade(buyTrade).transactionType, "BUY");
      assert.strictEqual(normalizeTrade(sellTrade).transactionType, "SELL");
    });

    it("should handle orderCreationTime fallback", () => {
      const trade = {
        orderId: "5555",
        tradingSymbol: "TEST",
        exchangeSegment: "NSE",
        transactionType: "BUY",
        tradedQty: 10,
        tradedPrice: 100,
        orderCreationTime: "2024-01-15T09:30:00",
        productType: "CNC",
        orderType: "MARKET",
      };

      const normalized = normalizeTrade(trade);

      assert.ok(normalized.tradeTime instanceof Date);
    });

    it("should use quantity when tradedQty is missing", () => {
      const trade = {
        orderId: "6666",
        tradingSymbol: "TEST",
        exchangeSegment: "NSE",
        transactionType: "BUY",
        quantity: 15,
        tradedPrice: 100,
        tradedTime: "2024-01-15T10:00:00",
        productType: "CNC",
        orderType: "MARKET",
      };

      const normalized = normalizeTrade(trade);

      assert.strictEqual(normalized.quantity, 15);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty arrays", () => {
      const holdings: any[] = [];
      const positions: any[] = [];
      const trades: any[] = [];

      assert.deepStrictEqual(holdings.map(normalizeHolding), []);
      assert.deepStrictEqual(positions.map(normalizePosition), []);
      assert.deepStrictEqual(trades.map(normalizeTrade), []);
    });

    it("should handle negative pnl", () => {
      const holding = {
        tradingSymbol: "LOSS",
        securityId: "7777",
        exchangeSegment: "NSE",
        quantity: 10,
        avgCostPrice: 200,
        ltp: 150,
        unrealizedProfit: -500,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pnl, -500);
      assert.ok(normalized.pnlPercentage < 0);
    });

    it("should handle very large quantities", () => {
      const holding = {
        tradingSymbol: "LARGE",
        securityId: "8888",
        exchangeSegment: "NSE",
        quantity: 1000000,
        avgCostPrice: 100,
        ltp: 105,
        unrealizedProfit: 5000000,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.investedValue, 100000000);
      assert.strictEqual(normalized.currentValue, 105000000);
    });

    it("should handle decimal prices", () => {
      const holding = {
        tradingSymbol: "DECIMAL",
        securityId: "9999",
        exchangeSegment: "NSE",
        quantity: 10,
        avgCostPrice: 100.55,
        ltp: 105.75,
      };

      const normalized = normalizeHolding(holding);

      assert.ok(normalized.investedValue > 1000);
      assert.ok(normalized.currentValue > normalized.investedValue);
    });

    it("should handle currency derivatives", () => {
      const cdPosition = {
        tradingSymbol: "USDINR24JAN84PE",
        securityId: "333444",
        exchangeSegment: "CDS",
        productType: "MARGIN",
        netQty: 1,
        avgPrice: 0.5,
        ltp: 0.45,
        unrealizedProfit: -50,
      };

      const normalized = normalizePosition(cdPosition);

      assert.strictEqual(normalized.segment, "CD");
    });
  });
});
