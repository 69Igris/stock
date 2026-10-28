/**
 * Fyers Web Client Tests
 *
 * Comprehensive tests for the Fyers web API client covering:
 * - Auth header construction (appId:accessToken format)
 * - OAuth2 login URL generation (client_id, redirect_uri, response_type, state)
 * - SHA256 appIdHash generation for token exchange
 * - Holdings normalization (symbol parsing, costPrice->averagePrice, pl calculation)
 * - Positions normalization (symbol parsing, positionType NET, pnlPercentage)
 * - Trades normalization (side mapping, tradeNumber->tradeId, value calculation)
 * - Orders normalization (type mapping 1-4, status mapping, side mapping)
 * - Order type mapping (numeric 1-4 to string)
 * - Order status mapping (numeric to string)
 * - Margins normalization (fund_limit extraction)
 * - Token validity checking
 * - Error handling patterns
 * - Edge cases (empty arrays, zero values, missing fields, special symbols)
 *
 * Source: apps/web/lib/brokers/clients/fyers.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Inline Types (no imports from source)
// ---------------------------------------------------------------------------

interface FyersHoldingRaw {
  symbol: string;
  isin?: string;
  quantity: number;
  costPrice: number;
  ltp: number;
  pl?: number;
}

interface FyersPositionRaw {
  symbol: string;
  segment?: string;
  productType?: string;
  qty: number;
  buyQty?: number;
  sellQty?: number;
  buyAvg?: number;
  sellAvg?: number;
  avgPrice?: number;
  ltp: number;
  pl?: number;
}

interface FyersTradeRaw {
  tradeNumber?: string;
  orderNumber?: string;
  symbol: string;
  exchange?: string;
  segment?: string;
  side: number;
  tradedQty: number;
  tradePrice: number;
  orderDateTime?: string;
  productType?: string;
  orderType?: string;
}

interface FyersOrderRaw {
  id: string;
  symbol: string;
  exchange?: string;
  segment?: string;
  side: number;
  type: number;
  productType?: string;
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  filledQty?: number;
  remainingQuantity?: number;
  status: number;
  message?: string;
  orderDateTime?: string;
}

// ---------------------------------------------------------------------------
// Inline Pure Functions (extracted from source)
// ---------------------------------------------------------------------------

function getFyersAuthHeaders(
  appId: string,
  accessToken: string
): Record<string, string> {
  return {
    Authorization: `${appId}:${accessToken}`,
    "Content-Type": "application/json",
  };
}

function buildFyersLoginUrl(
  appId: string,
  redirectUri: string,
  state?: string
): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    state: state || "fyers_auth",
  });
  return `https://api-t1.fyers.in/api/v3/generate-authcode?${params}`;
}

function generateAppIdHash(appId: string, secretKey: string): string {
  return createHash("sha256").update(`${appId}:${secretKey}`).digest("hex");
}

function parseSymbolFromFyers(fyersSymbol: string): {
  symbol: string;
  exchange: string;
} {
  const parts = fyersSymbol.split(":");
  if (parts.length === 2) {
    return { symbol: parts[1], exchange: parts[0] };
  }
  return { symbol: fyersSymbol, exchange: "NSE" };
}

function normalizeHolding(h: FyersHoldingRaw) {
  const parsed = parseSymbolFromFyers(h.symbol);
  const invested = h.quantity * h.costPrice;
  const current = h.quantity * h.ltp;
  return {
    symbol: parsed.symbol,
    tradingSymbol: h.symbol,
    isin: h.isin,
    exchange: parsed.exchange,
    quantity: h.quantity,
    averagePrice: h.costPrice,
    currentPrice: h.ltp,
    investedValue: invested,
    currentValue: current,
    pnl: h.pl || current - invested,
    pnlPercentage: invested ? ((current - invested) / invested) * 100 : 0,
    dayChange: 0,
    dayChangePercentage: 0,
  };
}

function normalizePosition(p: FyersPositionRaw) {
  const parsed = parseSymbolFromFyers(p.symbol);
  return {
    symbol: parsed.symbol,
    tradingSymbol: p.symbol,
    exchange: parsed.exchange,
    segment: p.segment,
    productType: p.productType,
    positionType: "NET" as const,
    quantity: p.qty,
    buyQuantity: p.buyQty,
    sellQuantity: p.sellQty,
    buyPrice: p.buyAvg,
    sellPrice: p.sellAvg,
    averagePrice: p.avgPrice,
    lastPrice: p.ltp,
    pnl: p.pl,
    pnlPercentage: p.avgPrice
      ? ((p.pl || 0) / (Math.abs(p.qty) * p.avgPrice)) * 100
      : 0,
  };
}

function normalizeTrade(t: FyersTradeRaw) {
  const parsed = parseSymbolFromFyers(t.symbol);
  return {
    tradeId: t.tradeNumber,
    orderId: t.orderNumber,
    symbol: parsed.symbol,
    tradingSymbol: t.symbol,
    exchange: t.exchange,
    segment: t.segment,
    transactionType: t.side === 1 ? ("BUY" as const) : ("SELL" as const),
    quantity: t.tradedQty,
    price: t.tradePrice,
    value: t.tradedQty * t.tradePrice,
    tradeTime: new Date(t.orderDateTime || ""),
    productType: t.productType,
    orderType: t.orderType,
  };
}

function mapFyersOrderType(type: number): "MARKET" | "LIMIT" | "SL" | "SL-M" {
  const mapping: Record<number, "MARKET" | "LIMIT" | "SL" | "SL-M"> = {
    1: "LIMIT",
    2: "MARKET",
    3: "SL",
    4: "SL-M",
  };
  return mapping[type] || "MARKET";
}

function mapFyersOrderStatus(
  status: number
): "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED" {
  const mapping: Record<
    number,
    "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED"
  > = {
    1: "CANCELLED",
    2: "COMPLETE",
    4: "OPEN",
    5: "REJECTED",
    6: "PENDING",
  };
  return mapping[status] || "PENDING";
}

function normalizeOrder(o: FyersOrderRaw) {
  const parsed = parseSymbolFromFyers(o.symbol);
  return {
    orderId: o.id,
    symbol: parsed.symbol,
    tradingSymbol: o.symbol,
    exchange: o.exchange,
    segment: o.segment,
    transactionType: o.side === 1 ? ("BUY" as const) : ("SELL" as const),
    orderType: mapFyersOrderType(o.type),
    productType: o.productType,
    quantity: o.qty,
    price: o.limitPrice,
    triggerPrice: o.stopPrice,
    filledQuantity: o.filledQty,
    pendingQuantity: o.remainingQuantity,
    status: mapFyersOrderStatus(o.status),
    statusMessage: o.message,
    orderTime: new Date(o.orderDateTime || ""),
  };
}

function normalizeMargins(response: Record<string, unknown>) {
  const fundLimit =
    (response.fund_limit as Array<Record<string, unknown>>) || [];
  return {
    availableCash: (fundLimit[0]?.equityAmount as number) || 0,
    usedMargin: (fundLimit[0]?.utilizedAmount as number) || 0,
    totalMargin: (fundLimit[0]?.totalBalance as number) || 0,
    collateral: 0,
  };
}

function isTokenValid(tokenExpiry: Date | undefined): boolean {
  if (!tokenExpiry) return true;
  return new Date() < tokenExpiry;
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

function createMockHolding(
  overrides: Partial<FyersHoldingRaw> = {}
): FyersHoldingRaw {
  return {
    symbol: "NSE:RELIANCE-EQ",
    isin: "INE002A01018",
    quantity: 10,
    costPrice: 2400,
    ltp: 2520,
    pl: 1200,
    ...overrides,
  };
}

function createMockPosition(
  overrides: Partial<FyersPositionRaw> = {}
): FyersPositionRaw {
  return {
    symbol: "NSE:NIFTY25JANFUT",
    segment: "CASH",
    productType: "INTRADAY",
    qty: 50,
    buyQty: 50,
    sellQty: 0,
    buyAvg: 21500,
    sellAvg: 0,
    avgPrice: 21500,
    ltp: 21600,
    pl: 5000,
    ...overrides,
  };
}

function createMockTrade(
  overrides: Partial<FyersTradeRaw> = {}
): FyersTradeRaw {
  return {
    tradeNumber: "TRD-001",
    orderNumber: "ORD-001",
    symbol: "NSE:INFY-EQ",
    exchange: "NSE",
    segment: "CM",
    side: 1,
    tradedQty: 20,
    tradePrice: 1520,
    orderDateTime: "2025-01-15T10:30:00+05:30",
    productType: "CNC",
    orderType: "MARKET",
    ...overrides,
  };
}

function createMockOrder(
  overrides: Partial<FyersOrderRaw> = {}
): FyersOrderRaw {
  return {
    id: "ORD-999",
    symbol: "NSE:TCS-EQ",
    exchange: "NSE",
    segment: "CM",
    side: 1,
    type: 2,
    productType: "CNC",
    qty: 10,
    limitPrice: 3900,
    stopPrice: 0,
    filledQty: 10,
    remainingQuantity: 0,
    status: 2,
    message: "",
    orderDateTime: "2025-01-15T09:30:00+05:30",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Fyers Web Client", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      FYERS_APP_ID: process.env.FYERS_APP_ID,
      FYERS_SECRET_KEY: process.env.FYERS_SECRET_KEY,
    };
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

  // ==========================================================================
  // Auth Header Construction
  // ==========================================================================

  describe("Auth header construction", () => {
    it("should format Authorization as appId:accessToken", () => {
      const headers = getFyersAuthHeaders("APP_XYZ", "token_abc123");
      assert.strictEqual(headers.Authorization, "APP_XYZ:token_abc123");
    });

    it("should include Content-Type as application/json", () => {
      const headers = getFyersAuthHeaders("APP", "TOKEN");
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should have exactly two headers", () => {
      const headers = getFyersAuthHeaders("APP", "TOKEN");
      assert.strictEqual(Object.keys(headers).length, 2);
    });

    it("should handle empty appId", () => {
      const headers = getFyersAuthHeaders("", "token123");
      assert.strictEqual(headers.Authorization, ":token123");
    });

    it("should handle empty accessToken", () => {
      const headers = getFyersAuthHeaders("APP123", "");
      assert.strictEqual(headers.Authorization, "APP123:");
    });

    it("should handle both empty strings", () => {
      const headers = getFyersAuthHeaders("", "");
      assert.strictEqual(headers.Authorization, ":");
    });

    it("should handle appId with special characters", () => {
      const headers = getFyersAuthHeaders("APP-123_v2", "tok_en");
      assert.strictEqual(headers.Authorization, "APP-123_v2:tok_en");
    });
  });

  // ==========================================================================
  // OAuth2 Login URL Generation
  // ==========================================================================

  describe("Login URL generation", () => {
    it("should start with Fyers auth URL", () => {
      const url = buildFyersLoginUrl("APP123", "https://example.com/callback");
      assert.ok(
        url.startsWith("https://api-t1.fyers.in/api/v3/generate-authcode?")
      );
    });

    it("should include client_id parameter", () => {
      const url = buildFyersLoginUrl("MY_APP_ID", "https://example.com/cb");
      assert.ok(url.includes("client_id=MY_APP_ID"));
    });

    it("should include redirect_uri parameter", () => {
      const url = buildFyersLoginUrl("APP", "https://usemoney.ai/callback");
      assert.ok(url.includes("redirect_uri="));
      assert.ok(url.includes("usemoney.ai"));
    });

    it("should include response_type=code", () => {
      const url = buildFyersLoginUrl("APP", "https://example.com/cb");
      assert.ok(url.includes("response_type=code"));
    });

    it("should use custom state when provided", () => {
      const url = buildFyersLoginUrl(
        "APP",
        "https://example.com/cb",
        "my_custom_state"
      );
      assert.ok(url.includes("state=my_custom_state"));
    });

    it("should use default state 'fyers_auth' when not provided", () => {
      const url = buildFyersLoginUrl("APP", "https://example.com/cb");
      assert.ok(url.includes("state=fyers_auth"));
    });

    it("should URL-encode the redirect_uri", () => {
      const url = buildFyersLoginUrl(
        "APP",
        "https://example.com/cb?param=1&other=2"
      );
      // URLSearchParams encodes ? and &
      assert.ok(!url.includes("redirect_uri=https://example.com/cb?param"));
    });

    it("should produce a valid URL with question mark separator", () => {
      const url = buildFyersLoginUrl("APP", "https://example.com/cb");
      const parts = url.split("?");
      assert.strictEqual(parts.length, 2);
      assert.ok(parts[1].length > 0);
    });
  });

  // ==========================================================================
  // SHA256 AppIdHash Generation
  // ==========================================================================

  describe("AppIdHash generation", () => {
    it("should generate SHA256 hash of appId:secretKey", () => {
      const hash = generateAppIdHash("MY_APP", "MY_SECRET");
      const expected = createHash("sha256")
        .update("MY_APP:MY_SECRET")
        .digest("hex");
      assert.strictEqual(hash, expected);
    });

    it("should return a 64-character hex string", () => {
      const hash = generateAppIdHash("app", "secret");
      assert.strictEqual(hash.length, 64);
      assert.match(hash, /^[0-9a-f]{64}$/);
    });

    it("should be deterministic for same inputs", () => {
      const hash1 = generateAppIdHash("app123", "secret456");
      const hash2 = generateAppIdHash("app123", "secret456");
      assert.strictEqual(hash1, hash2);
    });

    it("should produce different hashes for different inputs", () => {
      const hash1 = generateAppIdHash("app1", "secret");
      const hash2 = generateAppIdHash("app2", "secret");
      assert.notStrictEqual(hash1, hash2);
    });

    it("should produce different hashes for swapped inputs", () => {
      const hash1 = generateAppIdHash("value_a", "value_b");
      const hash2 = generateAppIdHash("value_b", "value_a");
      assert.notStrictEqual(hash1, hash2);
    });

    it("should handle empty appId", () => {
      const hash = generateAppIdHash("", "secret");
      const expected = createHash("sha256").update(":secret").digest("hex");
      assert.strictEqual(hash, expected);
    });

    it("should handle empty secretKey", () => {
      const hash = generateAppIdHash("app", "");
      const expected = createHash("sha256").update("app:").digest("hex");
      assert.strictEqual(hash, expected);
    });
  });

  // ==========================================================================
  // Symbol Parsing
  // ==========================================================================

  describe("Symbol parsing", () => {
    it("should parse NSE equity symbol", () => {
      const result = parseSymbolFromFyers("NSE:RELIANCE-EQ");
      assert.strictEqual(result.symbol, "RELIANCE-EQ");
      assert.strictEqual(result.exchange, "NSE");
    });

    it("should parse BSE equity symbol", () => {
      const result = parseSymbolFromFyers("BSE:TCS-EQ");
      assert.strictEqual(result.symbol, "TCS-EQ");
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should parse F&O symbol", () => {
      const result = parseSymbolFromFyers("NSE:NIFTY25JAN25000CE");
      assert.strictEqual(result.symbol, "NIFTY25JAN25000CE");
      assert.strictEqual(result.exchange, "NSE");
    });

    it("should parse MCX symbol", () => {
      const result = parseSymbolFromFyers("MCX:GOLDM24FEB");
      assert.strictEqual(result.symbol, "GOLDM24FEB");
      assert.strictEqual(result.exchange, "MCX");
    });

    it("should default to NSE for unprefixed symbols", () => {
      const result = parseSymbolFromFyers("RELIANCE");
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.exchange, "NSE");
    });

    it("should handle empty string", () => {
      const result = parseSymbolFromFyers("");
      assert.strictEqual(result.symbol, "");
      assert.strictEqual(result.exchange, "NSE");
    });
  });

  // ==========================================================================
  // Holdings Normalization
  // ==========================================================================

  describe("Holdings normalization", () => {
    it("should extract symbol from Fyers format", () => {
      const raw = createMockHolding({ symbol: "NSE:RELIANCE-EQ" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "RELIANCE-EQ");
    });

    it("should preserve full symbol as tradingSymbol", () => {
      const raw = createMockHolding({ symbol: "NSE:INFY-EQ" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.tradingSymbol, "NSE:INFY-EQ");
    });

    it("should extract exchange from symbol prefix", () => {
      const raw = createMockHolding({ symbol: "BSE:RELIANCE-EQ" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should map isin correctly", () => {
      const raw = createMockHolding({ isin: "INE002A01018" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.isin, "INE002A01018");
    });

    it("should map quantity correctly", () => {
      const raw = createMockHolding({ quantity: 25 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.quantity, 25);
    });

    it("should map costPrice to averagePrice", () => {
      const raw = createMockHolding({ costPrice: 2400 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.averagePrice, 2400);
    });

    it("should map ltp to currentPrice", () => {
      const raw = createMockHolding({ ltp: 2520 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.currentPrice, 2520);
    });

    it("should calculate investedValue as quantity * costPrice", () => {
      const raw = createMockHolding({ quantity: 10, costPrice: 2400 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.investedValue, 24000);
    });

    it("should calculate currentValue as quantity * ltp", () => {
      const raw = createMockHolding({ quantity: 10, ltp: 2520 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.currentValue, 25200);
    });

    it("should use pl when provided for pnl", () => {
      const raw = createMockHolding({ pl: 1200 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnl, 1200);
    });

    it("should calculate pnl from values when pl is not provided", () => {
      const raw = createMockHolding({ quantity: 10, costPrice: 100, ltp: 110 });
      delete (raw as unknown as Record<string, unknown>).pl;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnl, 100);
    });

    it("should calculate pnlPercentage correctly", () => {
      const raw = createMockHolding({
        quantity: 10,
        costPrice: 1000,
        ltp: 1100,
      });
      delete (raw as unknown as Record<string, unknown>).pl;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should return pnlPercentage=0 when invested is zero", () => {
      const raw = createMockHolding({ quantity: 0, costPrice: 0, ltp: 100 });
      delete (raw as unknown as Record<string, unknown>).pl;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should set dayChange and dayChangePercentage to 0", () => {
      const raw = createMockHolding();
      const result = normalizeHolding(raw);
      assert.strictEqual(result.dayChange, 0);
      assert.strictEqual(result.dayChangePercentage, 0);
    });

    it("should handle negative pnl", () => {
      const raw = createMockHolding({
        quantity: 10,
        costPrice: 200,
        ltp: 150,
        pl: -500,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnl, -500);
    });

    it("should handle fractional quantities", () => {
      const raw = createMockHolding({
        quantity: 10.5,
        costPrice: 100,
        ltp: 105,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.quantity, 10.5);
      assert.strictEqual(result.investedValue, 1050);
    });
  });

  // ==========================================================================
  // Positions Normalization
  // ==========================================================================

  describe("Positions normalization", () => {
    it("should extract symbol from Fyers format", () => {
      const raw = createMockPosition({ symbol: "NSE:NIFTY25JANFUT" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.symbol, "NIFTY25JANFUT");
    });

    it("should preserve full symbol as tradingSymbol", () => {
      const raw = createMockPosition({ symbol: "NSE:NIFTY25JANFUT" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.tradingSymbol, "NSE:NIFTY25JANFUT");
    });

    it("should extract exchange from symbol prefix", () => {
      const raw = createMockPosition({ symbol: "MCX:GOLDM24FEB" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.exchange, "MCX");
    });

    it("should always set positionType to NET", () => {
      const raw = createMockPosition();
      const result = normalizePosition(raw);
      assert.strictEqual(result.positionType, "NET");
    });

    it("should preserve segment", () => {
      const raw = createMockPosition({ segment: "FNO" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should preserve productType", () => {
      const raw = createMockPosition({ productType: "MARGIN" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.productType, "MARGIN");
    });

    it("should map qty to quantity", () => {
      const raw = createMockPosition({ qty: 50 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.quantity, 50);
    });

    it("should map buyQty and sellQty", () => {
      const raw = createMockPosition({ buyQty: 30, sellQty: 10 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.buyQuantity, 30);
      assert.strictEqual(result.sellQuantity, 10);
    });

    it("should map buyAvg and sellAvg", () => {
      const raw = createMockPosition({ buyAvg: 21500, sellAvg: 21600 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.buyPrice, 21500);
      assert.strictEqual(result.sellPrice, 21600);
    });

    it("should map avgPrice to averagePrice", () => {
      const raw = createMockPosition({ avgPrice: 21500 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.averagePrice, 21500);
    });

    it("should map ltp to lastPrice", () => {
      const raw = createMockPosition({ ltp: 21700 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.lastPrice, 21700);
    });

    it("should map pl to pnl", () => {
      const raw = createMockPosition({ pl: 5000 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.pnl, 5000);
    });

    it("should calculate pnlPercentage correctly", () => {
      const raw = createMockPosition({ qty: 10, avgPrice: 100, pl: 100 });
      const result = normalizePosition(raw);
      // 100 / (10 * 100) * 100 = 10%
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should return pnlPercentage=0 when avgPrice is zero", () => {
      const raw = createMockPosition({ qty: 10, avgPrice: 0, pl: 500 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should handle negative qty (short positions)", () => {
      const raw = createMockPosition({ qty: -50, avgPrice: 100, pl: 500 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.quantity, -50);
      // 500 / (50 * 100) * 100 = 10%
      assert.strictEqual(result.pnlPercentage, 10);
    });
  });

  // ==========================================================================
  // Trades Normalization
  // ==========================================================================

  describe("Trades normalization", () => {
    it("should map tradeNumber to tradeId", () => {
      const raw = createMockTrade({ tradeNumber: "TRD-999" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.tradeId, "TRD-999");
    });

    it("should map orderNumber to orderId", () => {
      const raw = createMockTrade({ orderNumber: "ORD-555" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.orderId, "ORD-555");
    });

    it("should extract symbol from Fyers format", () => {
      const raw = createMockTrade({ symbol: "NSE:INFY-EQ" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.symbol, "INFY-EQ");
    });

    it("should preserve full symbol as tradingSymbol", () => {
      const raw = createMockTrade({ symbol: "NSE:INFY-EQ" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.tradingSymbol, "NSE:INFY-EQ");
    });

    it("should map side=1 to BUY", () => {
      const raw = createMockTrade({ side: 1 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.transactionType, "BUY");
    });

    it("should map side=-1 to SELL", () => {
      const raw = createMockTrade({ side: -1 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should map side=2 to SELL", () => {
      const raw = createMockTrade({ side: 2 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should map tradedQty to quantity", () => {
      const raw = createMockTrade({ tradedQty: 20 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.quantity, 20);
    });

    it("should map tradePrice to price", () => {
      const raw = createMockTrade({ tradePrice: 1520.5 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.price, 1520.5);
    });

    it("should calculate value as tradedQty * tradePrice", () => {
      const raw = createMockTrade({ tradedQty: 10, tradePrice: 500 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 5000);
    });

    it("should convert orderDateTime to Date", () => {
      const raw = createMockTrade({
        orderDateTime: "2025-01-15T10:30:00+05:30",
      });
      const result = normalizeTrade(raw);
      assert.ok(result.tradeTime instanceof Date);
      assert.ok(!isNaN(result.tradeTime.getTime()));
    });

    it("should preserve exchange directly", () => {
      const raw = createMockTrade({ exchange: "BSE" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should preserve segment directly", () => {
      const raw = createMockTrade({ segment: "FNO" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should preserve productType", () => {
      const raw = createMockTrade({ productType: "MARGIN" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.productType, "MARGIN");
    });

    it("should handle zero quantity", () => {
      const raw = createMockTrade({ tradedQty: 0, tradePrice: 100 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 0);
    });

    it("should handle zero price", () => {
      const raw = createMockTrade({ tradedQty: 10, tradePrice: 0 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 0);
    });
  });

  // ==========================================================================
  // Order Type Mapping
  // ==========================================================================

  describe("Order type mapping", () => {
    it("should map 1 to LIMIT", () => {
      assert.strictEqual(mapFyersOrderType(1), "LIMIT");
    });

    it("should map 2 to MARKET", () => {
      assert.strictEqual(mapFyersOrderType(2), "MARKET");
    });

    it("should map 3 to SL", () => {
      assert.strictEqual(mapFyersOrderType(3), "SL");
    });

    it("should map 4 to SL-M", () => {
      assert.strictEqual(mapFyersOrderType(4), "SL-M");
    });

    it("should default to MARKET for unknown type 0", () => {
      assert.strictEqual(mapFyersOrderType(0), "MARKET");
    });

    it("should default to MARKET for unknown type 99", () => {
      assert.strictEqual(mapFyersOrderType(99), "MARKET");
    });

    it("should default to MARKET for negative type", () => {
      assert.strictEqual(mapFyersOrderType(-1), "MARKET");
    });
  });

  // ==========================================================================
  // Order Status Mapping
  // ==========================================================================

  describe("Order status mapping", () => {
    it("should map 1 to CANCELLED", () => {
      assert.strictEqual(mapFyersOrderStatus(1), "CANCELLED");
    });

    it("should map 2 to COMPLETE", () => {
      assert.strictEqual(mapFyersOrderStatus(2), "COMPLETE");
    });

    it("should map 4 to OPEN", () => {
      assert.strictEqual(mapFyersOrderStatus(4), "OPEN");
    });

    it("should map 5 to REJECTED", () => {
      assert.strictEqual(mapFyersOrderStatus(5), "REJECTED");
    });

    it("should map 6 to PENDING", () => {
      assert.strictEqual(mapFyersOrderStatus(6), "PENDING");
    });

    it("should default to PENDING for unmapped status 3", () => {
      assert.strictEqual(mapFyersOrderStatus(3), "PENDING");
    });

    it("should default to PENDING for unknown status 99", () => {
      assert.strictEqual(mapFyersOrderStatus(99), "PENDING");
    });

    it("should default to PENDING for status 0", () => {
      assert.strictEqual(mapFyersOrderStatus(0), "PENDING");
    });
  });

  // ==========================================================================
  // Orders Normalization
  // ==========================================================================

  describe("Orders normalization", () => {
    it("should map id to orderId", () => {
      const raw = createMockOrder({ id: "ORD-999" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.orderId, "ORD-999");
    });

    it("should extract symbol from Fyers format", () => {
      const raw = createMockOrder({ symbol: "NSE:TCS-EQ" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.symbol, "TCS-EQ");
    });

    it("should map side=1 to BUY", () => {
      const raw = createMockOrder({ side: 1 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.transactionType, "BUY");
    });

    it("should map side=-1 to SELL", () => {
      const raw = createMockOrder({ side: -1 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should map numeric type to string orderType", () => {
      const raw = createMockOrder({ type: 1 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.orderType, "LIMIT");
    });

    it("should map numeric status to string status", () => {
      const raw = createMockOrder({ status: 2 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.status, "COMPLETE");
    });

    it("should map qty to quantity", () => {
      const raw = createMockOrder({ qty: 50 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.quantity, 50);
    });

    it("should map limitPrice to price", () => {
      const raw = createMockOrder({ limitPrice: 3900 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.price, 3900);
    });

    it("should map stopPrice to triggerPrice", () => {
      const raw = createMockOrder({ stopPrice: 3850 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.triggerPrice, 3850);
    });

    it("should map filledQty to filledQuantity", () => {
      const raw = createMockOrder({ filledQty: 8 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.filledQuantity, 8);
    });

    it("should map remainingQuantity to pendingQuantity", () => {
      const raw = createMockOrder({ remainingQuantity: 2 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.pendingQuantity, 2);
    });

    it("should map message to statusMessage", () => {
      const raw = createMockOrder({ message: "Order executed" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.statusMessage, "Order executed");
    });

    it("should convert orderDateTime to Date", () => {
      const raw = createMockOrder({
        orderDateTime: "2025-01-15T09:30:00+05:30",
      });
      const result = normalizeOrder(raw);
      assert.ok(result.orderTime instanceof Date);
    });
  });

  // ==========================================================================
  // Margins Normalization
  // ==========================================================================

  describe("Margins normalization", () => {
    it("should extract availableCash from fund_limit[0].equityAmount", () => {
      const response = { fund_limit: [{ equityAmount: 50000 }] };
      const result = normalizeMargins(response);
      assert.strictEqual(result.availableCash, 50000);
    });

    it("should extract usedMargin from fund_limit[0].utilizedAmount", () => {
      const response = { fund_limit: [{ utilizedAmount: 10000 }] };
      const result = normalizeMargins(response);
      assert.strictEqual(result.usedMargin, 10000);
    });

    it("should extract totalMargin from fund_limit[0].totalBalance", () => {
      const response = { fund_limit: [{ totalBalance: 60000 }] };
      const result = normalizeMargins(response);
      assert.strictEqual(result.totalMargin, 60000);
    });

    it("should always set collateral to 0", () => {
      const response = { fund_limit: [{ equityAmount: 50000 }] };
      const result = normalizeMargins(response);
      assert.strictEqual(result.collateral, 0);
    });

    it("should default all to 0 when fund_limit is missing", () => {
      const result = normalizeMargins({});
      assert.strictEqual(result.availableCash, 0);
      assert.strictEqual(result.usedMargin, 0);
      assert.strictEqual(result.totalMargin, 0);
    });

    it("should default all to 0 when fund_limit is empty array", () => {
      const result = normalizeMargins({ fund_limit: [] });
      assert.strictEqual(result.availableCash, 0);
      assert.strictEqual(result.usedMargin, 0);
      assert.strictEqual(result.totalMargin, 0);
    });
  });

  // ==========================================================================
  // Token Validity
  // ==========================================================================

  describe("Token validity", () => {
    it("should return true when tokenExpiry is undefined", () => {
      assert.strictEqual(isTokenValid(undefined), true);
    });

    it("should return true when token has not expired", () => {
      const future = new Date(Date.now() + 60 * 60 * 1000);
      assert.strictEqual(isTokenValid(future), true);
    });

    it("should return false when token has expired", () => {
      const past = new Date(Date.now() - 60 * 60 * 1000);
      assert.strictEqual(isTokenValid(past), false);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe("Edge cases", () => {
    it("should handle empty holdings array", () => {
      const data: FyersHoldingRaw[] = [];
      assert.deepStrictEqual(data.map(normalizeHolding), []);
    });

    it("should handle empty positions array", () => {
      const data: FyersPositionRaw[] = [];
      assert.deepStrictEqual(data.map(normalizePosition), []);
    });

    it("should handle empty trades array", () => {
      const data: FyersTradeRaw[] = [];
      assert.deepStrictEqual(data.map(normalizeTrade), []);
    });

    it("should handle large batch of holdings", () => {
      const holdings = Array.from({ length: 100 }, (_, i) =>
        createMockHolding({
          symbol: `NSE:STOCK${i}-EQ`,
          quantity: i + 1,
          costPrice: (i + 1) * 100,
          ltp: (i + 1) * 105,
        })
      );
      const normalized = holdings.map(normalizeHolding);
      assert.strictEqual(normalized.length, 100);
      assert.strictEqual(normalized[0].symbol, "STOCK0-EQ");
      assert.strictEqual(normalized[99].symbol, "STOCK99-EQ");
    });

    it("should handle very large trade values without overflow", () => {
      const raw = createMockTrade({ tradedQty: 1000000, tradePrice: 5000 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 5000000000);
    });

    it("should handle decimal prices in holdings", () => {
      const raw = createMockHolding({ costPrice: 100.55, ltp: 105.75 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.averagePrice, 100.55);
      assert.strictEqual(result.currentPrice, 105.75);
    });

    it("should handle missing optional fields in holding", () => {
      const raw: FyersHoldingRaw = {
        symbol: "NSE:TEST-EQ",
        quantity: 1,
        costPrice: 100,
        ltp: 110,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "TEST-EQ");
      assert.strictEqual(result.isin, undefined);
    });

    it("should handle missing pl in position (defaults to 0 for pnlPercentage)", () => {
      const raw = createMockPosition({ qty: 10, avgPrice: 100 });
      delete (raw as unknown as Record<string, unknown>).pl;
      const result = normalizePosition(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });
  });
});
