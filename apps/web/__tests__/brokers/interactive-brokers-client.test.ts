/**
 * Interactive Brokers Client Tests
 *
 * Tests for the Interactive Brokers web client including:
 * - Exchange mapping (IBKR codes -> normalized names)
 * - Order status mapping (IBKR statuses -> normalized statuses)
 * - Segment mapping (asset classes -> segments)
 * - Holdings normalization (position, avgCost, mktPrice, unrealizedPnl)
 * - Positions normalization (long/short, segment detection, pnl)
 * - Trades normalization (side detection, value calculation)
 * - Orders normalization (totalSize, filledQuantity, status)
 * - Auth header construction
 * - Login URL generation
 * - Error handling patterns
 *
 * Source: apps/web/lib/brokers/clients/interactive-brokers.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// --- Inline Pure Functions (mirrors source exactly) ---

function mapExchange(exchange: string): string {
  const exchangeMap: Record<string, string> = {
    NASDAQ: "NASDAQ",
    NYSE: "NYSE",
    ARCA: "NYSE",
    AMEX: "NYSE",
    NSE: "NSE",
    BSE: "BSE",
    LSE: "LSE",
    IDEALPRO: "FOREX",
    SMART: "NSE",
  };
  return exchangeMap[exchange] || exchange;
}

function mapOrderStatus(
  status: string
): "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED" {
  const mapping: Record<
    string,
    "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED"
  > = {
    submitted: "OPEN",
    filled: "COMPLETE",
    cancelled: "CANCELLED",
    inactive: "REJECTED",
    pendingsubmit: "PENDING",
    pendingcancel: "PENDING",
    presubmitted: "PENDING",
    apipending: "PENDING",
    apicancelled: "CANCELLED",
  };
  return mapping[status.toLowerCase()] || "PENDING";
}

function mapSegment(assetClass: string): string {
  const segmentMap: Record<string, string> = {
    STK: "CASH",
    OPT: "FNO",
    FUT: "FNO",
    CASH: "CASH",
    BOND: "BOND",
    FOP: "FNO",
    WAR: "CASH",
    FUND: "MF",
  };
  return segmentMap[assetClass] || "CASH";
}

/** Reimplements getAuthHeaders from InteractiveBrokersClient */
function getAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
}

/** Reimplements holding normalization from getHoldings */
function normalizeHolding(h: Record<string, unknown>) {
  const position = (h.position as number) || 0;
  const avgCost = (h.avgCost as number) || 0;
  const mktPrice = (h.mktPrice as number) || 0;
  const unrealizedPnl = (h.unrealizedPnl as number) || 0;
  const investedValue = position * avgCost;
  const symbol =
    (h.ticker as string) || (h.contractDesc as string) || `CONID_${h.conid}`;
  const priorClose = (h.priorClose as number) || mktPrice;

  return {
    symbol,
    tradingSymbol: symbol,
    isin: h.isin,
    exchange: mapExchange(
      (h.listingExchange as string) || (h.exchange as string) || "SMART"
    ),
    quantity: position,
    averagePrice: avgCost,
    currentPrice: mktPrice,
    investedValue,
    currentValue: position * mktPrice,
    pnl: unrealizedPnl,
    pnlPercentage:
      investedValue !== 0 ? (unrealizedPnl / investedValue) * 100 : 0,
    dayChange: mktPrice - priorClose,
    dayChangePercentage: priorClose
      ? ((mktPrice - priorClose) / priorClose) * 100
      : 0,
  };
}

/** Reimplements position normalization from getPositions */
function normalizePosition(p: Record<string, unknown>) {
  const position = (p.position as number) || 0;
  const avgCost = (p.avgCost as number) || 0;
  const mktPrice = (p.mktPrice as number) || 0;
  const unrealizedPnl = (p.unrealizedPnl as number) || 0;
  const realizedPnl = (p.realizedPnl as number) || 0;
  const symbol =
    (p.ticker as string) || (p.contractDesc as string) || `CONID_${p.conid}`;
  const buyQty = position > 0 ? Math.abs(position) : 0;
  const sellQty = position < 0 ? Math.abs(position) : 0;
  const pnl = unrealizedPnl + realizedPnl;

  return {
    symbol,
    tradingSymbol: symbol,
    exchange: mapExchange(
      (p.listingExchange as string) || (p.exchange as string) || "SMART"
    ),
    segment: mapSegment((p.assetClass as string) || "STK"),
    productType: (p.assetClass as string) === "STK" ? "CNC" : "NRML",
    positionType: "DAY" as const,
    quantity: position,
    buyQuantity: buyQty,
    sellQuantity: sellQty,
    buyPrice: position > 0 ? avgCost : 0,
    sellPrice: position < 0 ? avgCost : 0,
    averagePrice: avgCost,
    lastPrice: mktPrice,
    pnl,
    pnlPercentage: avgCost ? (pnl / (Math.abs(position) * avgCost)) * 100 : 0,
    realizedPnl,
    unrealizedPnl,
    multiplier: p.multiplier,
  };
}

/** Reimplements trade normalization from getTrades */
function normalizeTrade(t: Record<string, unknown>) {
  const qty = Math.abs((t.size as number) || (t.shares as number) || 0);
  const price = (t.price as number) || 0;
  const side = ((t.side as string) || "").toUpperCase();
  const symbol =
    (t.ticker as string) ||
    (t.symbol as string) ||
    (t.contractDesc as string) ||
    "";

  return {
    tradeId: String(
      t.execution_id || t.executionId || t.tradeId || `IBKR_${Date.now()}`
    ),
    orderId: String(t.orderId || t.order_ref || ""),
    symbol,
    tradingSymbol: symbol,
    exchange: mapExchange(
      (t.listingExchange as string) || (t.exchange as string) || "SMART"
    ),
    segment: mapSegment((t.secType as string) || "STK"),
    transactionType:
      side === "BUY" || side === "BOT" ? ("BUY" as const) : ("SELL" as const),
    quantity: qty,
    price,
    value: qty * price,
    tradeTime: t.tradeTime
      ? new Date(t.tradeTime as string)
      : t.time
        ? new Date(t.time as string)
        : new Date(),
    productType: (t.secType as string) === "STK" ? "CNC" : "NRML",
    orderType: ((t.orderType as string) || "MKT").toUpperCase(),
  };
}

/** Reimplements getLoginUrl static method */
function getLoginUrl(clientId: string, redirectUri: string): string {
  return `https://www.interactivebrokers.com/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=trading`;
}

// --- Tests ---

describe("InteractiveBrokersClient", () => {
  // ---------- Exchange Mapping ----------
  describe("Exchange Mapping", () => {
    it("should map NASDAQ to NASDAQ", () => {
      assert.strictEqual(mapExchange("NASDAQ"), "NASDAQ");
    });

    it("should map NYSE to NYSE", () => {
      assert.strictEqual(mapExchange("NYSE"), "NYSE");
    });

    it("should map ARCA to NYSE", () => {
      assert.strictEqual(mapExchange("ARCA"), "NYSE");
    });

    it("should map AMEX to NYSE", () => {
      assert.strictEqual(mapExchange("AMEX"), "NYSE");
    });

    it("should map NSE to NSE", () => {
      assert.strictEqual(mapExchange("NSE"), "NSE");
    });

    it("should map BSE to BSE", () => {
      assert.strictEqual(mapExchange("BSE"), "BSE");
    });

    it("should map IDEALPRO to FOREX", () => {
      assert.strictEqual(mapExchange("IDEALPRO"), "FOREX");
    });

    it("should map SMART to NSE (default routing)", () => {
      assert.strictEqual(mapExchange("SMART"), "NSE");
    });

    it("should return unknown exchanges as-is", () => {
      assert.strictEqual(mapExchange("XETRA"), "XETRA");
    });
  });

  // ---------- Order Status Mapping ----------
  describe("Order Status Mapping", () => {
    it("should map submitted to OPEN", () => {
      assert.strictEqual(mapOrderStatus("submitted"), "OPEN");
    });

    it("should map filled to COMPLETE", () => {
      assert.strictEqual(mapOrderStatus("filled"), "COMPLETE");
    });

    it("should map cancelled to CANCELLED", () => {
      assert.strictEqual(mapOrderStatus("cancelled"), "CANCELLED");
    });

    it("should map inactive to REJECTED", () => {
      assert.strictEqual(mapOrderStatus("inactive"), "REJECTED");
    });

    it("should map pendingsubmit to PENDING", () => {
      assert.strictEqual(mapOrderStatus("pendingsubmit"), "PENDING");
    });

    it("should map apicancelled to CANCELLED", () => {
      assert.strictEqual(mapOrderStatus("apicancelled"), "CANCELLED");
    });

    it("should be case-insensitive (Submitted -> OPEN)", () => {
      assert.strictEqual(mapOrderStatus("Submitted"), "OPEN");
    });

    it("should default unknown statuses to PENDING", () => {
      assert.strictEqual(mapOrderStatus("unknown_status"), "PENDING");
    });
  });

  // ---------- Segment Mapping ----------
  describe("Segment Mapping", () => {
    it("should map STK to CASH", () => {
      assert.strictEqual(mapSegment("STK"), "CASH");
    });

    it("should map OPT to FNO", () => {
      assert.strictEqual(mapSegment("OPT"), "FNO");
    });

    it("should map FUT to FNO", () => {
      assert.strictEqual(mapSegment("FUT"), "FNO");
    });

    it("should map BOND to BOND", () => {
      assert.strictEqual(mapSegment("BOND"), "BOND");
    });

    it("should map FUND to MF", () => {
      assert.strictEqual(mapSegment("FUND"), "MF");
    });

    it("should default unknown asset classes to CASH", () => {
      assert.strictEqual(mapSegment("UNKNOWN"), "CASH");
    });
  });

  // ---------- Auth Headers ----------
  describe("Auth Header Construction", () => {
    it("should include Bearer token in Authorization", () => {
      const headers = getAuthHeaders("my-ibkr-token");
      assert.strictEqual(headers["Authorization"], "Bearer my-ibkr-token");
    });

    it("should include Accept application/json", () => {
      const headers = getAuthHeaders("tok");
      assert.strictEqual(headers["Accept"], "application/json");
    });

    it("should produce exactly 2 headers", () => {
      const headers = getAuthHeaders("tok");
      assert.strictEqual(Object.keys(headers).length, 2);
    });
  });

  // ---------- Login URL ----------
  describe("Login URL Generation", () => {
    it("should generate correct authorize URL", () => {
      const url = getLoginUrl("my-client", "https://example.com/callback");
      assert.ok(
        url.startsWith("https://www.interactivebrokers.com/authorize?")
      );
    });

    it("should include client_id parameter", () => {
      const url = getLoginUrl("my-client", "https://example.com/callback");
      assert.ok(url.includes("client_id=my-client"));
    });

    it("should include response_type=code", () => {
      const url = getLoginUrl("my-client", "https://example.com/callback");
      assert.ok(url.includes("response_type=code"));
    });

    it("should include scope=trading", () => {
      const url = getLoginUrl("my-client", "https://example.com/callback");
      assert.ok(url.includes("scope=trading"));
    });

    it("should URL-encode the redirect_uri", () => {
      const url = getLoginUrl("cid", "https://example.com/cb?foo=bar");
      assert.ok(
        url.includes("redirect_uri=https%3A%2F%2Fexample.com%2Fcb%3Ffoo%3Dbar")
      );
    });
  });

  // ---------- Holdings Normalization ----------
  describe("Holdings Normalization", () => {
    it("should normalize a basic holding", () => {
      const raw = {
        ticker: "AAPL",
        isin: "US0378331005",
        listingExchange: "NASDAQ",
        assetClass: "STK",
        position: 10,
        avgCost: 150,
        mktPrice: 175,
        unrealizedPnl: 250,
        priorClose: 170,
        conid: 265598,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "AAPL");
      assert.strictEqual(result.exchange, "NASDAQ");
      assert.strictEqual(result.quantity, 10);
      assert.strictEqual(result.averagePrice, 150);
      assert.strictEqual(result.currentPrice, 175);
    });

    it("should calculate investedValue as position * avgCost", () => {
      const raw = {
        ticker: "TSLA",
        position: 5,
        avgCost: 200,
        mktPrice: 250,
        unrealizedPnl: 250,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.investedValue, 1000);
    });

    it("should calculate currentValue as position * mktPrice", () => {
      const raw = {
        ticker: "TSLA",
        position: 5,
        avgCost: 200,
        mktPrice: 250,
        unrealizedPnl: 250,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.currentValue, 1250);
    });

    it("should calculate pnlPercentage correctly", () => {
      const raw = {
        ticker: "X",
        position: 10,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 100,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should handle zero investedValue (avoid division by zero)", () => {
      const raw = {
        ticker: "X",
        position: 0,
        avgCost: 0,
        mktPrice: 100,
        unrealizedPnl: 0,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should calculate dayChange from mktPrice - priorClose", () => {
      const raw = {
        ticker: "X",
        position: 1,
        avgCost: 100,
        mktPrice: 105,
        unrealizedPnl: 5,
        priorClose: 100,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.dayChange, 5);
    });

    it("should fallback symbol to contractDesc when ticker is missing", () => {
      const raw = {
        contractDesc: "MSFT",
        position: 1,
        avgCost: 300,
        mktPrice: 310,
        unrealizedPnl: 10,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "MSFT");
    });

    it("should fallback symbol to CONID_xxx when both ticker and contractDesc are missing", () => {
      const raw = {
        conid: 12345,
        position: 1,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 10,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "CONID_12345");
    });

    it("should default exchange to NSE when listingExchange/exchange is missing (SMART fallback)", () => {
      const raw = {
        ticker: "X",
        position: 1,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 10,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.exchange, "NSE");
    });
  });

  // ---------- Positions Normalization ----------
  describe("Positions Normalization", () => {
    it("should normalize a long position", () => {
      const raw = {
        ticker: "GOOGL",
        listingExchange: "NASDAQ",
        assetClass: "STK",
        position: 20,
        avgCost: 140,
        mktPrice: 155,
        unrealizedPnl: 300,
        realizedPnl: 0,
      };
      const result = normalizePosition(raw);
      assert.strictEqual(result.symbol, "GOOGL");
      assert.strictEqual(result.buyQuantity, 20);
      assert.strictEqual(result.sellQuantity, 0);
      assert.strictEqual(result.productType, "CNC");
    });

    it("should normalize a short position", () => {
      const raw = {
        ticker: "AMZN",
        listingExchange: "NASDAQ",
        assetClass: "STK",
        position: -10,
        avgCost: 180,
        mktPrice: 170,
        unrealizedPnl: 100,
        realizedPnl: 0,
      };
      const result = normalizePosition(raw);
      assert.strictEqual(result.buyQuantity, 0);
      assert.strictEqual(result.sellQuantity, 10);
      assert.strictEqual(result.buyPrice, 0);
      assert.strictEqual(result.sellPrice, 180);
    });

    it("should set positionType to DAY", () => {
      const raw = {
        ticker: "X",
        assetClass: "STK",
        position: 1,
        avgCost: 100,
        mktPrice: 110,
      };
      const result = normalizePosition(raw);
      assert.strictEqual(result.positionType, "DAY");
    });

    it("should set productType to NRML for non-STK asset classes", () => {
      const raw = {
        ticker: "NIFTY",
        assetClass: "OPT",
        position: 50,
        avgCost: 200,
        mktPrice: 220,
      };
      const result = normalizePosition(raw);
      assert.strictEqual(result.productType, "NRML");
    });

    it("should calculate combined pnl (unrealized + realized)", () => {
      const raw = {
        ticker: "X",
        assetClass: "STK",
        position: 10,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 100,
        realizedPnl: 50,
      };
      const result = normalizePosition(raw);
      assert.strictEqual(result.pnl, 150);
    });

    it("should handle zero avgCost (pnlPercentage = 0)", () => {
      const raw = {
        ticker: "X",
        assetClass: "STK",
        position: 10,
        avgCost: 0,
        mktPrice: 50,
        unrealizedPnl: 0,
      };
      const result = normalizePosition(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });
  });

  // ---------- Trades Normalization ----------
  describe("Trades Normalization", () => {
    it("should normalize a BUY trade", () => {
      const raw = {
        execution_id: "EX001",
        orderId: "ORD001",
        ticker: "AAPL",
        listingExchange: "NASDAQ",
        secType: "STK",
        side: "BUY",
        size: 10,
        price: 175.5,
        tradeTime: "2024-06-15T10:30:00Z",
      };
      const result = normalizeTrade(raw);
      assert.strictEqual(result.tradeId, "EX001");
      assert.strictEqual(result.transactionType, "BUY");
      assert.strictEqual(result.quantity, 10);
      assert.strictEqual(result.price, 175.5);
    });

    it("should detect BOT as BUY", () => {
      const raw = {
        execution_id: "EX002",
        side: "BOT",
        size: 5,
        price: 100,
        ticker: "X",
      };
      const result = normalizeTrade(raw);
      assert.strictEqual(result.transactionType, "BUY");
    });

    it("should detect SELL side", () => {
      const raw = {
        execution_id: "EX003",
        side: "SLD",
        size: 5,
        price: 100,
        ticker: "X",
      };
      const result = normalizeTrade(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should calculate value as qty * price", () => {
      const raw = {
        execution_id: "EX004",
        side: "BUY",
        size: 10,
        price: 50,
        ticker: "X",
      };
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 500);
    });

    it("should use shares field if size is missing", () => {
      const raw = {
        execution_id: "EX005",
        side: "BUY",
        shares: 7,
        price: 200,
        ticker: "X",
      };
      const result = normalizeTrade(raw);
      assert.strictEqual(result.quantity, 7);
    });

    it("should use tradeTime for trade time", () => {
      const raw = {
        execution_id: "EX006",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
        tradeTime: "2024-01-15T10:00:00Z",
      };
      const result = normalizeTrade(raw);
      assert.ok(result.tradeTime instanceof Date);
      assert.strictEqual(
        result.tradeTime.toISOString(),
        "2024-01-15T10:00:00.000Z"
      );
    });

    it("should fallback to time field when tradeTime is missing", () => {
      const raw = {
        execution_id: "EX007",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
        time: "2024-02-20T14:00:00Z",
      };
      const result = normalizeTrade(raw);
      assert.strictEqual(
        result.tradeTime.toISOString(),
        "2024-02-20T14:00:00.000Z"
      );
    });

    it("should default orderType to MKT when missing", () => {
      const raw = {
        execution_id: "EX008",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
      };
      const result = normalizeTrade(raw);
      assert.strictEqual(result.orderType, "MKT");
    });

    it("should set productType to CNC for STK secType", () => {
      const raw = {
        execution_id: "EX009",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
        secType: "STK",
      };
      const result = normalizeTrade(raw);
      assert.strictEqual(result.productType, "CNC");
    });

    it("should set productType to NRML for non-STK secType", () => {
      const raw = {
        execution_id: "EX010",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
        secType: "OPT",
      };
      const result = normalizeTrade(raw);
      assert.strictEqual(result.productType, "NRML");
    });
  });

  // ---------- Edge Cases ----------
  describe("Edge Cases", () => {
    it("should handle empty holdings array", () => {
      const holdings: Record<string, unknown>[] = [];
      assert.deepStrictEqual(holdings.map(normalizeHolding), []);
    });

    it("should handle empty positions array", () => {
      const positions: Record<string, unknown>[] = [];
      assert.deepStrictEqual(positions.map(normalizePosition), []);
    });

    it("should handle empty trades array", () => {
      const trades: Record<string, unknown>[] = [];
      assert.deepStrictEqual(trades.map(normalizeTrade), []);
    });

    it("should handle holding with all zero values", () => {
      const raw = {
        ticker: "ZERO",
        position: 0,
        avgCost: 0,
        mktPrice: 0,
        unrealizedPnl: 0,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.investedValue, 0);
      assert.strictEqual(result.currentValue, 0);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should handle negative unrealizedPnl (loss)", () => {
      const raw = {
        ticker: "LOSS",
        position: 10,
        avgCost: 200,
        mktPrice: 180,
        unrealizedPnl: -200,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnl, -200);
      assert.strictEqual(result.pnlPercentage, -10);
    });
  });
});
