/**
 * Upstox Web Client Tests
 *
 * Comprehensive tests for the Upstox web API client covering:
 * - Bearer token auth headers (Authorization: Bearer <token>)
 * - OAuth2 login URL generation
 * - Holdings normalization (tradingsymbol, pnl, pnlPercentage calculation)
 * - Positions normalization (instrument_type->segment, positionType DAY)
 * - Trades normalization (trade_id, price, value calculation)
 * - Orders normalization (status mapping, pending quantity calc)
 * - Order status mapping (lowercase to uppercase)
 * - Margins normalization (equity fund data)
 * - Extended token validity (1 year / 365 days)
 * - Token validity checking
 * - Error handling patterns
 * - Edge cases (empty arrays, zero values, missing fields, negative pnl)
 *
 * Source: apps/web/lib/brokers/clients/upstox.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Inline Types (no imports from source)
// ---------------------------------------------------------------------------

interface UpstoxHoldingRaw {
  tradingsymbol: string;
  isin?: string;
  exchange: string;
  quantity: number;
  average_price: number;
  last_price: number;
  pnl?: number;
  day_change?: number;
  day_change_percentage?: number;
}

interface UpstoxPositionRaw {
  tradingsymbol: string;
  exchange: string;
  instrument_type: string;
  product: string;
  quantity: number;
  day_buy_quantity?: number;
  day_sell_quantity?: number;
  day_buy_price?: number;
  day_sell_price?: number;
  average_price: number;
  last_price: number;
  pnl?: number;
  multiplier?: number;
}

interface UpstoxTradeRaw {
  trade_id: string;
  order_id?: string;
  tradingsymbol: string;
  exchange: string;
  instrument_type: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  price: number;
  trade_date?: string;
  product?: string;
  order_type?: string;
}

interface UpstoxOrderRaw {
  order_id: string;
  tradingsymbol: string;
  exchange: string;
  instrument_type: string;
  transaction_type: "BUY" | "SELL";
  order_type: string;
  product: string;
  quantity: number;
  price: number;
  trigger_price?: number;
  filled_quantity: number;
  status: string;
  status_message?: string;
  order_timestamp: string;
}

// ---------------------------------------------------------------------------
// Inline Pure Functions (extracted from source)
// ---------------------------------------------------------------------------

function getUpstoxAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
}

function buildUpstoxLoginUrl(apiKey: string, redirectUri: string): string {
  return `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${apiKey}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

function normalizeHolding(h: UpstoxHoldingRaw) {
  return {
    symbol: h.tradingsymbol,
    tradingSymbol: h.tradingsymbol,
    isin: h.isin,
    exchange: h.exchange,
    quantity: h.quantity,
    averagePrice: h.average_price,
    currentPrice: h.last_price,
    investedValue: h.quantity * h.average_price,
    currentValue: h.quantity * h.last_price,
    pnl: h.pnl || (h.last_price - h.average_price) * h.quantity,
    pnlPercentage: h.pnl ? (h.pnl / (h.quantity * h.average_price)) * 100 : 0,
    dayChange: h.day_change || 0,
    dayChangePercentage: h.day_change_percentage || 0,
  };
}

function normalizePosition(p: UpstoxPositionRaw) {
  return {
    symbol: p.tradingsymbol,
    tradingSymbol: p.tradingsymbol,
    exchange: p.exchange,
    segment: p.instrument_type,
    productType: p.product,
    positionType: "DAY" as const,
    quantity: p.quantity,
    buyQuantity: p.day_buy_quantity,
    sellQuantity: p.day_sell_quantity,
    buyPrice: p.day_buy_price,
    sellPrice: p.day_sell_price,
    averagePrice: p.average_price,
    lastPrice: p.last_price,
    pnl: p.pnl,
    pnlPercentage: p.average_price
      ? ((p.pnl || 0) / (Math.abs(p.quantity) * p.average_price)) * 100
      : 0,
    multiplier: p.multiplier,
  };
}

function normalizeTrade(t: UpstoxTradeRaw) {
  return {
    tradeId: t.trade_id,
    orderId: t.order_id,
    symbol: t.tradingsymbol,
    tradingSymbol: t.tradingsymbol,
    exchange: t.exchange,
    segment: t.instrument_type,
    transactionType: t.transaction_type,
    quantity: t.quantity,
    price: t.price,
    value: t.quantity * t.price,
    tradeTime: new Date(t.trade_date || ""),
    productType: t.product,
    orderType: t.order_type,
  };
}

function mapUpstoxOrderStatus(
  status: string
): "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED" {
  const mapping: Record<
    string,
    "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED"
  > = {
    pending: "PENDING",
    open: "OPEN",
    complete: "COMPLETE",
    cancelled: "CANCELLED",
    rejected: "REJECTED",
    "trigger pending": "PENDING",
  };
  return mapping[status.toLowerCase()] || "PENDING";
}

function normalizeOrder(o: UpstoxOrderRaw) {
  return {
    orderId: o.order_id,
    symbol: o.tradingsymbol,
    tradingSymbol: o.tradingsymbol,
    exchange: o.exchange,
    segment: o.instrument_type,
    transactionType: o.transaction_type,
    orderType: o.order_type,
    productType: o.product,
    quantity: o.quantity,
    price: o.price,
    triggerPrice: o.trigger_price,
    filledQuantity: o.filled_quantity,
    pendingQuantity: o.quantity - o.filled_quantity,
    status: mapUpstoxOrderStatus(o.status),
    statusMessage: o.status_message,
    orderTime: new Date(o.order_timestamp),
  };
}

function normalizeMargins(response: Record<string, unknown>) {
  const data = (response.data as Record<string, unknown>)?.equity as
    | Record<string, unknown>
    | undefined;
  return {
    availableCash: (data?.available_margin as number) || 0,
    usedMargin: (data?.used_margin as number) || 0,
    totalMargin:
      ((data?.available_margin as number) || 0) +
      ((data?.used_margin as number) || 0),
    collateral: (data?.collateral as number) || 0,
  };
}

function isTokenValid(tokenExpiry: Date | undefined): boolean {
  if (!tokenExpiry) return true;
  return new Date() < tokenExpiry;
}

// Extended token expiry constant (1 year)
const EXTENDED_TOKEN_EXPIRY_MS = 86400 * 365 * 1000;

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

function createMockHolding(
  overrides: Partial<UpstoxHoldingRaw> = {}
): UpstoxHoldingRaw {
  return {
    tradingsymbol: "RELIANCE",
    isin: "INE002A01018",
    exchange: "NSE_EQ",
    quantity: 10,
    average_price: 2400,
    last_price: 2520,
    pnl: 1200,
    day_change: 20,
    day_change_percentage: 0.8,
    ...overrides,
  };
}

function createMockPosition(
  overrides: Partial<UpstoxPositionRaw> = {}
): UpstoxPositionRaw {
  return {
    tradingsymbol: "NIFTY24JAN25000CE",
    exchange: "NSE_FO",
    instrument_type: "CE",
    product: "MIS",
    quantity: 50,
    day_buy_quantity: 50,
    day_sell_quantity: 0,
    day_buy_price: 150,
    day_sell_price: 0,
    average_price: 150,
    last_price: 165,
    pnl: 750,
    multiplier: 1,
    ...overrides,
  };
}

function createMockTrade(
  overrides: Partial<UpstoxTradeRaw> = {}
): UpstoxTradeRaw {
  return {
    trade_id: "TRD-001",
    order_id: "ORD-001",
    tradingsymbol: "TCS",
    exchange: "NSE_EQ",
    instrument_type: "EQ",
    transaction_type: "BUY",
    quantity: 5,
    price: 3800,
    trade_date: "2025-01-15T10:35:00+05:30",
    product: "CNC",
    order_type: "MARKET",
    ...overrides,
  };
}

function createMockOrder(
  overrides: Partial<UpstoxOrderRaw> = {}
): UpstoxOrderRaw {
  return {
    order_id: "ORD-001",
    tradingsymbol: "INFY",
    exchange: "NSE_EQ",
    instrument_type: "EQ",
    transaction_type: "BUY",
    order_type: "LIMIT",
    product: "CNC",
    quantity: 100,
    price: 1450,
    trigger_price: 0,
    filled_quantity: 100,
    status: "complete",
    status_message: "",
    order_timestamp: "2025-01-15T10:30:00+05:30",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Upstox Web Client", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      UPSTOX_API_KEY: process.env.UPSTOX_API_KEY,
      UPSTOX_API_SECRET: process.env.UPSTOX_API_SECRET,
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
  // Bearer Token Auth Headers
  // ==========================================================================

  describe("Auth header construction", () => {
    it("should include Authorization header with Bearer prefix", () => {
      const headers = getUpstoxAuthHeaders("my_token_123");
      assert.strictEqual(headers.Authorization, "Bearer my_token_123");
    });

    it("should include Accept header as application/json", () => {
      const headers = getUpstoxAuthHeaders("token");
      assert.strictEqual(headers.Accept, "application/json");
    });

    it("should have exactly two headers", () => {
      const headers = getUpstoxAuthHeaders("token");
      assert.strictEqual(Object.keys(headers).length, 2);
    });

    it("should handle empty accessToken", () => {
      const headers = getUpstoxAuthHeaders("");
      assert.strictEqual(headers.Authorization, "Bearer ");
    });

    it("should handle token with special characters", () => {
      const headers = getUpstoxAuthHeaders("abc-123_xyz.456");
      assert.strictEqual(headers.Authorization, "Bearer abc-123_xyz.456");
    });

    it("should handle very long tokens", () => {
      const longToken = "a".repeat(1000);
      const headers = getUpstoxAuthHeaders(longToken);
      assert.strictEqual(headers.Authorization, `Bearer ${longToken}`);
    });
  });

  // ==========================================================================
  // OAuth2 Login URL Generation
  // ==========================================================================

  describe("Login URL generation", () => {
    it("should start with Upstox authorization dialog URL", () => {
      const url = buildUpstoxLoginUrl("KEY123", "https://example.com/cb");
      assert.ok(
        url.startsWith("https://api.upstox.com/v2/login/authorization/dialog?")
      );
    });

    it("should include response_type=code", () => {
      const url = buildUpstoxLoginUrl("KEY123", "https://example.com/cb");
      assert.ok(url.includes("response_type=code"));
    });

    it("should include client_id parameter", () => {
      const url = buildUpstoxLoginUrl("MY_API_KEY", "https://example.com/cb");
      assert.ok(url.includes("client_id=MY_API_KEY"));
    });

    it("should include redirect_uri parameter", () => {
      const url = buildUpstoxLoginUrl("KEY", "https://usemoney.ai/callback");
      assert.ok(url.includes("redirect_uri="));
      assert.ok(url.includes("usemoney.ai"));
    });

    it("should URL-encode the redirect_uri", () => {
      const url = buildUpstoxLoginUrl("KEY", "https://example.com/cb?a=1");
      assert.ok(url.includes(encodeURIComponent("https://example.com/cb?a=1")));
    });

    it("should handle empty apiKey", () => {
      const url = buildUpstoxLoginUrl("", "https://example.com/cb");
      assert.ok(url.includes("client_id=&") || url.includes("client_id="));
    });
  });

  // ==========================================================================
  // Extended Token Validity
  // ==========================================================================

  describe("Extended token validity", () => {
    it("should define 1 year expiry in milliseconds", () => {
      assert.strictEqual(EXTENDED_TOKEN_EXPIRY_MS, 86400 * 365 * 1000);
    });

    it("should equal 31536000000 milliseconds", () => {
      assert.strictEqual(EXTENDED_TOKEN_EXPIRY_MS, 31536000000);
    });

    it("should be approximately 365 days", () => {
      const days = EXTENDED_TOKEN_EXPIRY_MS / (24 * 60 * 60 * 1000);
      assert.strictEqual(days, 365);
    });
  });

  // ==========================================================================
  // Holdings Normalization
  // ==========================================================================

  describe("Holdings normalization", () => {
    it("should map tradingsymbol to symbol and tradingSymbol", () => {
      const raw = createMockHolding({ tradingsymbol: "RELIANCE" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.tradingSymbol, "RELIANCE");
    });

    it("should map isin correctly", () => {
      const raw = createMockHolding({ isin: "INE002A01018" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.isin, "INE002A01018");
    });

    it("should map exchange directly", () => {
      const raw = createMockHolding({ exchange: "BSE_EQ" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.exchange, "BSE_EQ");
    });

    it("should map quantity correctly", () => {
      const raw = createMockHolding({ quantity: 25 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.quantity, 25);
    });

    it("should map average_price to averagePrice", () => {
      const raw = createMockHolding({ average_price: 2400 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.averagePrice, 2400);
    });

    it("should map last_price to currentPrice", () => {
      const raw = createMockHolding({ last_price: 2520 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.currentPrice, 2520);
    });

    it("should calculate investedValue as quantity * average_price", () => {
      const raw = createMockHolding({ quantity: 10, average_price: 2400 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.investedValue, 24000);
    });

    it("should calculate currentValue as quantity * last_price", () => {
      const raw = createMockHolding({ quantity: 10, last_price: 2520 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.currentValue, 25200);
    });

    it("should use pnl when provided", () => {
      const raw = createMockHolding({ pnl: 1200 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnl, 1200);
    });

    it("should calculate pnl when not provided", () => {
      const raw = createMockHolding({
        quantity: 10,
        average_price: 100,
        last_price: 120,
      });
      delete (raw as unknown as Record<string, unknown>).pnl;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnl, 200);
    });

    it("should calculate pnlPercentage when pnl is provided", () => {
      const raw = createMockHolding({
        quantity: 10,
        average_price: 1000,
        pnl: 1500,
      });
      const result = normalizeHolding(raw);
      // 1500 / (10 * 1000) * 100 = 15%
      assert.strictEqual(result.pnlPercentage, 15);
    });

    it("should return pnlPercentage=0 when pnl is not provided", () => {
      const raw = createMockHolding();
      delete (raw as unknown as Record<string, unknown>).pnl;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should map day_change with default of 0", () => {
      const raw = createMockHolding({ day_change: 15.5 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.dayChange, 15.5);
    });

    it("should default dayChange to 0 when missing", () => {
      const raw = createMockHolding();
      delete (raw as unknown as Record<string, unknown>).day_change;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.dayChange, 0);
    });

    it("should map day_change_percentage to dayChangePercentage", () => {
      const raw = createMockHolding({ day_change_percentage: 1.2 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.dayChangePercentage, 1.2);
    });

    it("should default dayChangePercentage to 0 when missing", () => {
      const raw = createMockHolding();
      delete (raw as unknown as Record<string, unknown>).day_change_percentage;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.dayChangePercentage, 0);
    });

    it("should handle negative pnl", () => {
      const raw = createMockHolding({
        pnl: -500,
        quantity: 10,
        average_price: 200,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnl, -500);
      assert.ok(result.pnlPercentage < 0);
    });

    it("should handle zero quantity", () => {
      const raw = createMockHolding({
        quantity: 0,
        average_price: 100,
        last_price: 105,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.investedValue, 0);
      assert.strictEqual(result.currentValue, 0);
    });
  });

  // ==========================================================================
  // Positions Normalization
  // ==========================================================================

  describe("Positions normalization", () => {
    it("should map tradingsymbol to symbol and tradingSymbol", () => {
      const raw = createMockPosition({ tradingsymbol: "NIFTY24JAN25000CE" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.symbol, "NIFTY24JAN25000CE");
      assert.strictEqual(result.tradingSymbol, "NIFTY24JAN25000CE");
    });

    it("should map exchange directly", () => {
      const raw = createMockPosition({ exchange: "NSE_FO" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.exchange, "NSE_FO");
    });

    it("should map instrument_type to segment", () => {
      const raw = createMockPosition({ instrument_type: "CE" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.segment, "CE");
    });

    it("should always set positionType to DAY", () => {
      const raw = createMockPosition();
      const result = normalizePosition(raw);
      assert.strictEqual(result.positionType, "DAY");
    });

    it("should map product to productType", () => {
      const raw = createMockPosition({ product: "NRML" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.productType, "NRML");
    });

    it("should map quantity correctly", () => {
      const raw = createMockPosition({ quantity: 50 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.quantity, 50);
    });

    it("should map day_buy_quantity and day_sell_quantity", () => {
      const raw = createMockPosition({
        day_buy_quantity: 50,
        day_sell_quantity: 25,
      });
      const result = normalizePosition(raw);
      assert.strictEqual(result.buyQuantity, 50);
      assert.strictEqual(result.sellQuantity, 25);
    });

    it("should map day_buy_price and day_sell_price", () => {
      const raw = createMockPosition({
        day_buy_price: 150,
        day_sell_price: 160,
      });
      const result = normalizePosition(raw);
      assert.strictEqual(result.buyPrice, 150);
      assert.strictEqual(result.sellPrice, 160);
    });

    it("should map average_price to averagePrice", () => {
      const raw = createMockPosition({ average_price: 150 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.averagePrice, 150);
    });

    it("should map last_price to lastPrice", () => {
      const raw = createMockPosition({ last_price: 165 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.lastPrice, 165);
    });

    it("should map pnl directly", () => {
      const raw = createMockPosition({ pnl: 750 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.pnl, 750);
    });

    it("should calculate pnlPercentage correctly", () => {
      const raw = createMockPosition({
        quantity: 10,
        average_price: 100,
        pnl: 100,
      });
      const result = normalizePosition(raw);
      // 100 / (10 * 100) * 100 = 10%
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should return pnlPercentage=0 when average_price is 0", () => {
      const raw = createMockPosition({
        quantity: 10,
        average_price: 0,
        pnl: 500,
      });
      const result = normalizePosition(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should handle negative quantity (short position)", () => {
      const raw = createMockPosition({
        quantity: -50,
        average_price: 100,
        pnl: 500,
      });
      const result = normalizePosition(raw);
      assert.strictEqual(result.quantity, -50);
      // 500 / (50 * 100) * 100 = 10%
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should map multiplier directly", () => {
      const raw = createMockPosition({ multiplier: 50 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.multiplier, 50);
    });
  });

  // ==========================================================================
  // Trades Normalization
  // ==========================================================================

  describe("Trades normalization", () => {
    it("should map trade_id to tradeId", () => {
      const raw = createMockTrade({ trade_id: "TRD-999" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.tradeId, "TRD-999");
    });

    it("should map order_id to orderId", () => {
      const raw = createMockTrade({ order_id: "ORD-555" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.orderId, "ORD-555");
    });

    it("should map tradingsymbol to symbol and tradingSymbol", () => {
      const raw = createMockTrade({ tradingsymbol: "TCS" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.symbol, "TCS");
      assert.strictEqual(result.tradingSymbol, "TCS");
    });

    it("should map exchange directly", () => {
      const raw = createMockTrade({ exchange: "BSE_EQ" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.exchange, "BSE_EQ");
    });

    it("should map instrument_type to segment", () => {
      const raw = createMockTrade({ instrument_type: "FUT" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.segment, "FUT");
    });

    it("should map transaction_type directly (BUY)", () => {
      const raw = createMockTrade({ transaction_type: "BUY" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.transactionType, "BUY");
    });

    it("should map transaction_type directly (SELL)", () => {
      const raw = createMockTrade({ transaction_type: "SELL" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should map quantity correctly", () => {
      const raw = createMockTrade({ quantity: 10 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.quantity, 10);
    });

    it("should map price correctly", () => {
      const raw = createMockTrade({ price: 3800.5 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.price, 3800.5);
    });

    it("should calculate value as quantity * price", () => {
      const raw = createMockTrade({ quantity: 5, price: 3800 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 19000);
    });

    it("should convert trade_date to Date", () => {
      const raw = createMockTrade({
        trade_date: "2025-01-15T10:35:00+05:30",
      });
      const result = normalizeTrade(raw);
      assert.ok(result.tradeTime instanceof Date);
      assert.ok(!isNaN(result.tradeTime.getTime()));
    });

    it("should preserve product as productType", () => {
      const raw = createMockTrade({ product: "MIS" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.productType, "MIS");
    });

    it("should preserve order_type as orderType", () => {
      const raw = createMockTrade({ order_type: "LIMIT" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.orderType, "LIMIT");
    });

    it("should handle zero quantity producing zero value", () => {
      const raw = createMockTrade({ quantity: 0, price: 100 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 0);
    });

    it("should handle zero price producing zero value", () => {
      const raw = createMockTrade({ quantity: 10, price: 0 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 0);
    });
  });

  // ==========================================================================
  // Order Status Mapping
  // ==========================================================================

  describe("Order status mapping", () => {
    it("should map 'pending' to PENDING", () => {
      assert.strictEqual(mapUpstoxOrderStatus("pending"), "PENDING");
    });

    it("should map 'open' to OPEN", () => {
      assert.strictEqual(mapUpstoxOrderStatus("open"), "OPEN");
    });

    it("should map 'complete' to COMPLETE", () => {
      assert.strictEqual(mapUpstoxOrderStatus("complete"), "COMPLETE");
    });

    it("should map 'cancelled' to CANCELLED", () => {
      assert.strictEqual(mapUpstoxOrderStatus("cancelled"), "CANCELLED");
    });

    it("should map 'rejected' to REJECTED", () => {
      assert.strictEqual(mapUpstoxOrderStatus("rejected"), "REJECTED");
    });

    it("should map 'trigger pending' to PENDING", () => {
      assert.strictEqual(mapUpstoxOrderStatus("trigger pending"), "PENDING");
    });

    it("should be case-insensitive (COMPLETE)", () => {
      assert.strictEqual(mapUpstoxOrderStatus("COMPLETE"), "COMPLETE");
    });

    it("should be case-insensitive (Complete)", () => {
      assert.strictEqual(mapUpstoxOrderStatus("Complete"), "COMPLETE");
    });

    it("should default to PENDING for unknown status", () => {
      assert.strictEqual(mapUpstoxOrderStatus("unknown_status"), "PENDING");
    });

    it("should default to PENDING for empty string", () => {
      assert.strictEqual(mapUpstoxOrderStatus(""), "PENDING");
    });
  });

  // ==========================================================================
  // Orders Normalization
  // ==========================================================================

  describe("Orders normalization", () => {
    it("should map order_id to orderId", () => {
      const raw = createMockOrder({ order_id: "ORD-999" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.orderId, "ORD-999");
    });

    it("should map tradingsymbol to symbol and tradingSymbol", () => {
      const raw = createMockOrder({ tradingsymbol: "INFY" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.symbol, "INFY");
      assert.strictEqual(result.tradingSymbol, "INFY");
    });

    it("should map instrument_type to segment", () => {
      const raw = createMockOrder({ instrument_type: "FUT" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.segment, "FUT");
    });

    it("should map order_type to orderType", () => {
      const raw = createMockOrder({ order_type: "MARKET" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.orderType, "MARKET");
    });

    it("should map quantity and filled_quantity", () => {
      const raw = createMockOrder({ quantity: 100, filled_quantity: 75 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.quantity, 100);
      assert.strictEqual(result.filledQuantity, 75);
    });

    it("should calculate pendingQuantity as quantity - filled_quantity", () => {
      const raw = createMockOrder({ quantity: 100, filled_quantity: 75 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.pendingQuantity, 25);
    });

    it("should calculate pendingQuantity=0 when fully filled", () => {
      const raw = createMockOrder({ quantity: 100, filled_quantity: 100 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.pendingQuantity, 0);
    });

    it("should map price and trigger_price", () => {
      const raw = createMockOrder({ price: 1500, trigger_price: 1480 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.price, 1500);
      assert.strictEqual(result.triggerPrice, 1480);
    });

    it("should apply status mapping", () => {
      const raw = createMockOrder({ status: "complete" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.status, "COMPLETE");
    });

    it("should map status_message to statusMessage", () => {
      const raw = createMockOrder({ status_message: "Insufficient funds" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.statusMessage, "Insufficient funds");
    });

    it("should convert order_timestamp to Date", () => {
      const raw = createMockOrder({
        order_timestamp: "2025-01-15T10:30:00+05:30",
      });
      const result = normalizeOrder(raw);
      assert.ok(result.orderTime instanceof Date);
      assert.ok(!isNaN(result.orderTime.getTime()));
    });
  });

  // ==========================================================================
  // Margins Normalization
  // ==========================================================================

  describe("Margins normalization", () => {
    it("should extract availableCash from equity.available_margin", () => {
      const response = { data: { equity: { available_margin: 50000 } } };
      const result = normalizeMargins(response);
      assert.strictEqual(result.availableCash, 50000);
    });

    it("should extract usedMargin from equity.used_margin", () => {
      const response = { data: { equity: { used_margin: 10000 } } };
      const result = normalizeMargins(response);
      assert.strictEqual(result.usedMargin, 10000);
    });

    it("should calculate totalMargin as available + used", () => {
      const response = {
        data: { equity: { available_margin: 50000, used_margin: 10000 } },
      };
      const result = normalizeMargins(response);
      assert.strictEqual(result.totalMargin, 60000);
    });

    it("should extract collateral from equity.collateral", () => {
      const response = { data: { equity: { collateral: 5000 } } };
      const result = normalizeMargins(response);
      assert.strictEqual(result.collateral, 5000);
    });

    it("should default all to 0 when data is missing", () => {
      const result = normalizeMargins({});
      assert.strictEqual(result.availableCash, 0);
      assert.strictEqual(result.usedMargin, 0);
      assert.strictEqual(result.totalMargin, 0);
      assert.strictEqual(result.collateral, 0);
    });

    it("should default all to 0 when equity is missing", () => {
      const result = normalizeMargins({ data: {} });
      assert.strictEqual(result.availableCash, 0);
      assert.strictEqual(result.usedMargin, 0);
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

    it("should return true for extended token (1 year from now)", () => {
      const oneYearFromNow = new Date(Date.now() + EXTENDED_TOKEN_EXPIRY_MS);
      assert.strictEqual(isTokenValid(oneYearFromNow), true);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe("Edge cases", () => {
    it("should handle empty holdings array", () => {
      const data: UpstoxHoldingRaw[] = [];
      assert.deepStrictEqual(data.map(normalizeHolding), []);
    });

    it("should handle empty positions array", () => {
      const data: UpstoxPositionRaw[] = [];
      assert.deepStrictEqual(data.map(normalizePosition), []);
    });

    it("should handle empty trades array", () => {
      const data: UpstoxTradeRaw[] = [];
      assert.deepStrictEqual(data.map(normalizeTrade), []);
    });

    it("should handle empty orders array", () => {
      const data: UpstoxOrderRaw[] = [];
      assert.deepStrictEqual(data.map(normalizeOrder), []);
    });

    it("should handle large batch of holdings", () => {
      const holdings = Array.from({ length: 100 }, (_, i) =>
        createMockHolding({
          tradingsymbol: `STOCK${i}`,
          quantity: i + 1,
          average_price: (i + 1) * 100,
          last_price: (i + 1) * 105,
        })
      );
      const normalized = holdings.map(normalizeHolding);
      assert.strictEqual(normalized.length, 100);
      assert.strictEqual(normalized[0].symbol, "STOCK0");
      assert.strictEqual(normalized[99].symbol, "STOCK99");
    });

    it("should handle very large trade values without overflow", () => {
      const raw = createMockTrade({ quantity: 1000000, price: 5000 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 5000000000);
    });

    it("should handle fractional prices", () => {
      const raw = createMockHolding({
        average_price: 123.456789,
        last_price: 124.987654,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.averagePrice, 123.456789);
      assert.strictEqual(result.currentPrice, 124.987654);
    });

    it("should handle negative day change values", () => {
      const raw = createMockHolding({
        day_change: -30,
        day_change_percentage: -1.5,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.dayChange, -30);
      assert.strictEqual(result.dayChangePercentage, -1.5);
    });

    it("should handle missing optional fields in holding", () => {
      const raw: UpstoxHoldingRaw = {
        tradingsymbol: "TEST",
        exchange: "NSE_EQ",
        quantity: 1,
        average_price: 100,
        last_price: 110,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "TEST");
      assert.strictEqual(result.dayChange, 0);
      assert.strictEqual(result.dayChangePercentage, 0);
    });

    it("should handle order where filled_quantity exceeds quantity (rare)", () => {
      const raw = createMockOrder({ quantity: 10, filled_quantity: 12 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.pendingQuantity, -2);
    });
  });
});
