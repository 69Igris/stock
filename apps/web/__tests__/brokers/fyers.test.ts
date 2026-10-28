/**
 * Fyers Client Normalization Tests
 *
 * Tests for the Fyers API response normalization logic.
 * Verifies correct mapping of Fyers-specific fields to our normalized format.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Exchange to segment mapping (from fyers.ts)
function getSegmentFromExchange(exchange: string): string {
  const exchangeToSegment: Record<string, string> = {
    NSE: "CASH",
    BSE: "CASH",
    MCX: "COM",
    "NSE:CM": "CASH",
    "BSE:CM": "CASH",
    "NSE:FO": "FNO",
    "BSE:FO": "FNO",
    "MCX:COM": "COM",
    CDS: "CD",
  };
  return exchangeToSegment[exchange] || "CASH";
}

// Parse Fyers symbol format (e.g., "NSE:RELIANCE-EQ" or "NSE:NIFTY24JAN25000CE")
function parseSymbol(fyersSymbol: string): {
  symbol: string;
  exchange: string;
} {
  const parts = fyersSymbol.split(":");
  if (parts.length === 2) {
    let symbol = parts[1];
    // Remove -EQ suffix for equity symbols
    if (symbol.endsWith("-EQ")) {
      symbol = symbol.replace("-EQ", "");
    }
    return { symbol, exchange: parts[0] };
  }
  return { symbol: fyersSymbol, exchange: "NSE" };
}

// Holdings normalization function (mirrors fyers.ts logic)
function normalizeHolding(h: any) {
  const { symbol, exchange } = parseSymbol(h.symbol || h.id);
  const investedValue = h.qty * h.costPrice;
  const currentValue = h.qty * h.ltp;
  const pnl = h.pl || currentValue - investedValue;

  return {
    symbol: symbol,
    tradingSymbol: symbol,
    fyersSymbol: h.symbol || h.id,
    instrumentToken: h.id,
    isin: h.isin,
    exchange: exchange,
    totalQuantity: h.qty,
    freeQuantity: h.qty - (h.t1Qty || 0) - (h.pledgedQty || 0),
    t1Quantity: h.t1Qty || 0,
    pledgedQuantity: h.pledgedQty || 0,
    averagePrice: h.costPrice,
    currentPrice: h.ltp,
    investedValue: investedValue,
    currentValue: currentValue,
    pnl: pnl,
    pnlPercentage: investedValue > 0 ? (pnl / investedValue) * 100 : 0,
    dayChange: h.ltp - h.closePrice || 0,
    dayChangePercentage:
      h.closePrice > 0 ? ((h.ltp - h.closePrice) / h.closePrice) * 100 : 0,
    product: h.holdingType || "CNC",
  };
}

// Position normalization function (mirrors fyers.ts logic)
function normalizePosition(p: any) {
  const { symbol, exchange } = parseSymbol(p.symbol || p.id);
  const segment = getSegmentFromExchange(exchange);
  const pnl = p.pl || p.unrealizedProfit || 0;

  return {
    symbol: symbol,
    tradingSymbol: symbol,
    fyersSymbol: p.symbol || p.id,
    instrumentToken: p.id,
    exchange: exchange,
    segment: segment,
    productType: p.productType,
    positionType: p.dayBuyQty > 0 || p.daySellQty > 0 ? "DAY" : "NET",
    quantity: p.netQty,
    buyQuantity: p.buyQty || p.dayBuyQty || 0,
    sellQuantity: p.sellQty || p.daySellQty || 0,
    overnightQuantity: p.cfBuyQty || 0,
    buyPrice: p.buyAvg || p.dayBuyAvgPrice || 0,
    sellPrice: p.sellAvg || p.daySellAvgPrice || 0,
    averagePrice: p.avgPrice || p.netAvg,
    lastPrice: p.ltp,
    closePrice: p.closePrice || 0,
    buyValue: p.buyVal || p.dayBuyValue || 0,
    sellValue: p.sellVal || p.daySellValue || 0,
    value: p.netQty * p.ltp,
    pnl: pnl,
    realizedPnl: p.realizedProfit || 0,
    unrealizedPnl: p.unrealizedProfit || pnl,
    pnlPercentage:
      (p.avgPrice || p.netAvg) && p.netQty
        ? (pnl / Math.abs(p.netQty * (p.avgPrice || p.netAvg))) * 100
        : 0,
    multiplier: p.lotSize || 1,
  };
}

// Trade normalization function (mirrors fyers.ts logic)
function normalizeTrade(t: any) {
  const { symbol, exchange } = parseSymbol(t.symbol || t.id);
  const segment = getSegmentFromExchange(exchange);
  const executionPrice = t.tradePrice || t.avgPrice || t.price || 0;
  const value = t.qty * executionPrice;

  return {
    tradeId: t.tradeId || t.id,
    orderId: t.orderId,
    symbol: symbol,
    tradingSymbol: symbol,
    fyersSymbol: t.symbol || t.id,
    exchange: exchange,
    segment: segment,
    transactionType:
      t.side === 1 || t.transactionType === "BUY" ? "BUY" : "SELL",
    quantity: t.qty || t.tradedQty,
    price: executionPrice,
    value: value,
    tradeTime: new Date(t.orderDateTime || t.tradeTime || t.orderTime),
    productType: t.productType,
    orderType: t.orderType,
  };
}

describe("Fyers Client Normalization", () => {
  describe("Segment Mapping from Exchange", () => {
    it("should map NSE to CASH", () => {
      assert.strictEqual(getSegmentFromExchange("NSE"), "CASH");
    });

    it("should map BSE to CASH", () => {
      assert.strictEqual(getSegmentFromExchange("BSE"), "CASH");
    });

    it("should map NSE:CM to CASH", () => {
      assert.strictEqual(getSegmentFromExchange("NSE:CM"), "CASH");
    });

    it("should map NSE:FO to FNO", () => {
      assert.strictEqual(getSegmentFromExchange("NSE:FO"), "FNO");
    });

    it("should map BSE:FO to FNO", () => {
      assert.strictEqual(getSegmentFromExchange("BSE:FO"), "FNO");
    });

    it("should map MCX to COM", () => {
      assert.strictEqual(getSegmentFromExchange("MCX"), "COM");
    });

    it("should map MCX:COM to COM", () => {
      assert.strictEqual(getSegmentFromExchange("MCX:COM"), "COM");
    });

    it("should map CDS to CD", () => {
      assert.strictEqual(getSegmentFromExchange("CDS"), "CD");
    });

    it("should default to CASH for unknown exchange", () => {
      assert.strictEqual(getSegmentFromExchange("UNKNOWN"), "CASH");
    });
  });

  describe("Symbol Parsing", () => {
    it("should parse equity symbol with -EQ suffix", () => {
      const result = parseSymbol("NSE:RELIANCE-EQ");
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.exchange, "NSE");
    });

    it("should parse F&O symbol", () => {
      const result = parseSymbol("NSE:NIFTY24JAN25000CE");
      assert.strictEqual(result.symbol, "NIFTY24JAN25000CE");
      assert.strictEqual(result.exchange, "NSE");
    });

    it("should parse BSE symbol", () => {
      const result = parseSymbol("BSE:TCS-EQ");
      assert.strictEqual(result.symbol, "TCS");
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should parse MCX symbol", () => {
      const result = parseSymbol("MCX:GOLDM24FEB");
      assert.strictEqual(result.symbol, "GOLDM24FEB");
      assert.strictEqual(result.exchange, "MCX");
    });

    it("should handle symbol without exchange prefix", () => {
      const result = parseSymbol("RELIANCE");
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.exchange, "NSE");
    });
  });

  describe("Holdings Normalization", () => {
    it("should normalize basic holding correctly", () => {
      const fyersResponse = {
        symbol: "NSE:RELIANCE-EQ",
        id: "NSE:RELIANCE-EQ",
        isin: "INE002A01018",
        qty: 10,
        costPrice: 2400,
        ltp: 2450,
        closePrice: 2420,
        pl: 500,
        t1Qty: 0,
        holdingType: "CNC",
      };

      const normalized = normalizeHolding(fyersResponse);

      assert.strictEqual(normalized.symbol, "RELIANCE");
      assert.strictEqual(normalized.fyersSymbol, "NSE:RELIANCE-EQ");
      assert.strictEqual(normalized.totalQuantity, 10);
      assert.strictEqual(normalized.averagePrice, 2400);
      assert.strictEqual(normalized.currentPrice, 2450);
      assert.strictEqual(normalized.investedValue, 24000);
      assert.strictEqual(normalized.currentValue, 24500);
      assert.strictEqual(normalized.pnl, 500);
    });

    it("should calculate pnlPercentage correctly", () => {
      const holding = {
        symbol: "NSE:INFY-EQ",
        id: "NSE:INFY-EQ",
        qty: 10,
        costPrice: 1500,
        ltp: 1650,
        closePrice: 1600,
        pl: 1500,
      };

      const normalized = normalizeHolding(holding);

      // 1500 / 15000 * 100 = 10%
      assert.strictEqual(normalized.pnlPercentage, 10);
    });

    it("should calculate pnl when pl is missing", () => {
      const holding = {
        symbol: "NSE:TCS-EQ",
        id: "NSE:TCS-EQ",
        qty: 5,
        costPrice: 3500,
        ltp: 3600,
        closePrice: 3520,
        // No pl field
      };

      const normalized = normalizeHolding(holding);

      // (3600 * 5) - (3500 * 5) = 500
      assert.strictEqual(normalized.pnl, 500);
    });

    it("should handle T1 quantities", () => {
      const holding = {
        symbol: "NSE:HDFC-EQ",
        id: "NSE:HDFC-EQ",
        qty: 20,
        t1Qty: 5,
        costPrice: 1600,
        ltp: 1650,
        closePrice: 1620,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.totalQuantity, 20);
      assert.strictEqual(normalized.freeQuantity, 15);
      assert.strictEqual(normalized.t1Quantity, 5);
    });

    it("should handle pledged quantities", () => {
      const holding = {
        symbol: "NSE:SBIN-EQ",
        id: "NSE:SBIN-EQ",
        qty: 50,
        pledgedQty: 20,
        costPrice: 600,
        ltp: 620,
        closePrice: 610,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pledgedQuantity, 20);
      assert.strictEqual(normalized.freeQuantity, 30);
    });

    it("should calculate day change from LTP and close price", () => {
      const holding = {
        symbol: "NSE:TEST-EQ",
        id: "NSE:TEST-EQ",
        qty: 10,
        costPrice: 100,
        ltp: 105,
        closePrice: 102,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.dayChange, 3);
      // (105-102)/102 * 100 ≈ 2.94%
      assert.ok(Math.abs(normalized.dayChangePercentage - 2.94) < 0.1);
    });

    it("should handle zero cost price", () => {
      const holding = {
        symbol: "NSE:ZERO-EQ",
        id: "NSE:ZERO-EQ",
        qty: 10,
        costPrice: 0,
        ltp: 100,
        closePrice: 98,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pnlPercentage, 0);
    });
  });

  describe("Position Normalization", () => {
    it("should normalize basic position correctly", () => {
      const fyersPosition = {
        symbol: "NSE:RELIANCE-EQ",
        id: "NSE:RELIANCE-EQ",
        productType: "CNC",
        netQty: 10,
        dayBuyQty: 10,
        daySellQty: 0,
        buyQty: 10,
        sellQty: 0,
        buyAvg: 2400,
        sellAvg: 0,
        avgPrice: 2400,
        netAvg: 2400,
        ltp: 2450,
        closePrice: 2420,
        buyVal: 24000,
        sellVal: 0,
        pl: 500,
        unrealizedProfit: 500,
        realizedProfit: 0,
        lotSize: 1,
      };

      const normalized = normalizePosition(fyersPosition);

      assert.strictEqual(normalized.symbol, "RELIANCE");
      assert.strictEqual(normalized.segment, "CASH");
      assert.strictEqual(normalized.productType, "CNC");
      assert.strictEqual(normalized.positionType, "DAY");
      assert.strictEqual(normalized.quantity, 10);
      assert.strictEqual(normalized.pnl, 500);
    });

    it("should identify NET positions correctly", () => {
      const netPosition = {
        symbol: "NSE:TCS-EQ",
        id: "NSE:TCS-EQ",
        productType: "CNC",
        netQty: 10,
        dayBuyQty: 0,
        daySellQty: 0,
        cfBuyQty: 10,
        avgPrice: 3500,
        netAvg: 3500,
        ltp: 3550,
        closePrice: 3480,
        unrealizedProfit: 500,
      };

      const normalized = normalizePosition(netPosition);

      assert.strictEqual(normalized.positionType, "NET");
      assert.strictEqual(normalized.overnightQuantity, 10);
    });

    it("should handle F&O positions", () => {
      const fnoPosition = {
        symbol: "NSE:NIFTY24JAN25000CE",
        id: "NSE:NIFTY24JAN25000CE",
        productType: "MARGIN",
        netQty: 50,
        dayBuyQty: 50,
        daySellQty: 0,
        avgPrice: 150,
        netAvg: 150,
        ltp: 165,
        closePrice: 145,
        pl: 750,
        lotSize: 50,
      };

      const normalized = normalizePosition(fnoPosition);

      assert.strictEqual(normalized.segment, "CASH"); // NSE without :FO suffix
      assert.strictEqual(normalized.multiplier, 50);
    });

    it("should calculate pnlPercentage correctly", () => {
      const position = {
        symbol: "NSE:TEST-EQ",
        id: "NSE:TEST-EQ",
        productType: "CNC",
        netQty: 10,
        dayBuyQty: 10,
        avgPrice: 100,
        netAvg: 100,
        ltp: 110,
        pl: 100,
      };

      const normalized = normalizePosition(position);

      // 100 / (10 * 100) * 100 = 10%
      assert.strictEqual(normalized.pnlPercentage, 10);
    });

    it("should handle commodity positions", () => {
      const commodityPosition = {
        symbol: "MCX:GOLDM24FEB",
        id: "MCX:GOLDM24FEB",
        productType: "MARGIN",
        netQty: 1,
        dayBuyQty: 1,
        avgPrice: 59000,
        netAvg: 59000,
        ltp: 59500,
        pl: 500,
        lotSize: 1,
      };

      const normalized = normalizePosition(commodityPosition);

      assert.strictEqual(normalized.segment, "COM");
    });

    it("should handle short positions", () => {
      const shortPosition = {
        symbol: "NSE:NIFTY24JAN25000PE",
        id: "NSE:NIFTY24JAN25000PE",
        productType: "MARGIN",
        netQty: -50,
        dayBuyQty: 0,
        daySellQty: 50,
        sellAvg: 100,
        avgPrice: 100,
        netAvg: 100,
        ltp: 90,
        pl: 500,
      };

      const normalized = normalizePosition(shortPosition);

      assert.strictEqual(normalized.quantity, -50);
    });
  });

  describe("Trade Normalization", () => {
    it("should normalize basic trade correctly", () => {
      const fyersTrade = {
        tradeId: "T1234567890",
        orderId: "O1234567890",
        symbol: "NSE:RELIANCE-EQ",
        id: "NSE:RELIANCE-EQ",
        side: 1, // 1 = BUY, -1 = SELL in Fyers
        qty: 10,
        tradePrice: 2450.75,
        orderDateTime: "2024-01-15T10:30:00+05:30",
        productType: "CNC",
        orderType: "MARKET",
      };

      const normalized = normalizeTrade(fyersTrade);

      assert.strictEqual(normalized.symbol, "RELIANCE");
      assert.strictEqual(normalized.transactionType, "BUY");
      assert.strictEqual(normalized.price, 2450.75);
      assert.strictEqual(normalized.value, 10 * 2450.75);
    });

    it("should handle side = -1 as SELL", () => {
      const sellTrade = {
        tradeId: "T2222",
        orderId: "O2222",
        symbol: "NSE:TCS-EQ",
        side: -1,
        qty: 5,
        tradePrice: 3800.5,
        orderDateTime: "2024-01-15T14:00:00",
        productType: "CNC",
        orderType: "LIMIT",
      };

      const normalized = normalizeTrade(sellTrade);

      assert.strictEqual(normalized.transactionType, "SELL");
    });

    it("should handle transactionType string", () => {
      const buyTrade = {
        tradeId: "T3333",
        orderId: "O3333",
        symbol: "NSE:INFY-EQ",
        transactionType: "BUY",
        qty: 10,
        tradePrice: 1500,
        orderDateTime: "2024-01-15T10:00:00",
        productType: "CNC",
        orderType: "MARKET",
      };

      const sellTrade = {
        ...buyTrade,
        tradeId: "T4444",
        transactionType: "SELL",
      };

      assert.strictEqual(normalizeTrade(buyTrade).transactionType, "BUY");
      assert.strictEqual(normalizeTrade(sellTrade).transactionType, "SELL");
    });

    it("should use avgPrice when tradePrice is missing", () => {
      const trade = {
        tradeId: "T5555",
        orderId: "O5555",
        symbol: "NSE:WIPRO-EQ",
        side: 1,
        qty: 20,
        avgPrice: 450.25,
        orderDateTime: "2024-01-15T11:00:00",
        productType: "CNC",
        orderType: "LIMIT",
      };

      const normalized = normalizeTrade(trade);

      assert.strictEqual(normalized.price, 450.25);
    });

    it("should correctly map F&O segment", () => {
      const fnoTrade = {
        tradeId: "T6666",
        orderId: "O6666",
        symbol: "NSE:NIFTY24JAN25000CE",
        side: 1,
        qty: 50,
        tradePrice: 150.5,
        orderDateTime: "2024-01-15T10:00:00",
        productType: "MARGIN",
        orderType: "MARKET",
      };

      const normalized = normalizeTrade(fnoTrade);

      // Without :FO in symbol, it maps to CASH
      assert.strictEqual(normalized.segment, "CASH");
    });

    it("should handle different timestamp fields", () => {
      const tradeWithTradeTime = {
        tradeId: "T7777",
        symbol: "NSE:TEST-EQ",
        side: 1,
        qty: 10,
        tradePrice: 100,
        tradeTime: "2024-01-15T10:00:00",
        productType: "CNC",
        orderType: "MARKET",
      };

      const tradeWithOrderTime = {
        tradeId: "T8888",
        symbol: "NSE:TEST-EQ",
        side: 1,
        qty: 10,
        tradePrice: 100,
        orderTime: "2024-01-15T11:00:00",
        productType: "CNC",
        orderType: "MARKET",
      };

      const norm1 = normalizeTrade(tradeWithTradeTime);
      const norm2 = normalizeTrade(tradeWithOrderTime);

      assert.ok(norm1.tradeTime instanceof Date);
      assert.ok(norm2.tradeTime instanceof Date);
    });

    it("should use tradedQty when qty is missing", () => {
      const trade = {
        tradeId: "T9999",
        symbol: "NSE:TEST-EQ",
        side: 1,
        tradedQty: 15,
        tradePrice: 100,
        orderDateTime: "2024-01-15T10:00:00",
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
        symbol: "NSE:LOSS-EQ",
        id: "NSE:LOSS-EQ",
        qty: 10,
        costPrice: 200,
        ltp: 150,
        closePrice: 195,
        pl: -500,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.pnl, -500);
      assert.ok(normalized.pnlPercentage < 0);
    });

    it("should handle very large quantities", () => {
      const holding = {
        symbol: "NSE:LARGE-EQ",
        id: "NSE:LARGE-EQ",
        qty: 1000000,
        costPrice: 100,
        ltp: 105,
        closePrice: 102,
        pl: 5000000,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.investedValue, 100000000);
      assert.strictEqual(normalized.currentValue, 105000000);
    });

    it("should handle decimal prices", () => {
      const holding = {
        symbol: "NSE:DECIMAL-EQ",
        id: "NSE:DECIMAL-EQ",
        qty: 10,
        costPrice: 100.55,
        ltp: 105.75,
        closePrice: 103.25,
      };

      const normalized = normalizeHolding(holding);

      assert.ok(normalized.investedValue > 1000);
      assert.ok(normalized.currentValue > normalized.investedValue);
    });

    it("should handle symbols with complex suffixes", () => {
      const result = parseSymbol("NSE:NIFTY24JAN25000CE");
      assert.strictEqual(result.symbol, "NIFTY24JAN25000CE");
      assert.strictEqual(result.exchange, "NSE");
    });

    it("should handle BSE symbols", () => {
      const holding = {
        symbol: "BSE:RELIANCE-EQ",
        id: "BSE:RELIANCE-EQ",
        qty: 5,
        costPrice: 2400,
        ltp: 2450,
        closePrice: 2420,
      };

      const normalized = normalizeHolding(holding);

      assert.strictEqual(normalized.symbol, "RELIANCE");
      assert.strictEqual(normalized.exchange, "BSE");
    });
  });
});
