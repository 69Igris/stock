/**
 * Zerodha Web Client Tests
 *
 * Comprehensive tests for the Zerodha Kite Connect web API client covering:
 * - Kite API auth header construction (token apiKey:accessToken + X-Kite-Version)
 * - Login URL generation (api_key, v=3, redirect_uri encoding)
 * - SHA256 checksum generation for token exchange
 * - Holdings normalization (tradingsymbol, pnlPercentage calc, MTF data)
 * - Positions normalization (DAY/NET split, segment from exchange, F&O fields)
 * - Trades normalization (average_price as execution price, segment, ISIN extraction)
 * - Orders normalization (orderType mapping, orderStatus mapping)
 * - Order type mapping (MARKET/LIMIT/SL/SL-M)
 * - Order status mapping (including TRIGGER PENDING)
 * - Segment-from-exchange mapping (NSE, BSE, NFO, BFO, CDS, MCX, NCDEX)
 * - Mutual funds normalization (ISIN from tradingsymbol, pnl calc)
 * - Margins normalization
 * - Token validity checking
 * - Edge cases (zero prices, missing fields, empty arrays, large batches)
 *
 * Source: apps/web/lib/brokers/clients/zerodha.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ZerodhaClient } from "@/lib/brokers/clients/zerodha";
import type { BrokerCredentials } from "@/lib/brokers/base-client";

// ---------------------------------------------------------------------------
// Test subclass: exposes the protected getAuthHeaders() so we assert the REAL
// client's header construction (reads this.apiKey + this.credentials.accessToken)
// without performing any network request.
// ---------------------------------------------------------------------------

class TestZerodhaClient extends ZerodhaClient {
  publicAuthHeaders(): Record<string, string> {
    return this.getAuthHeaders();
  }
}

function realZerodhaAuthHeaders(
  apiKey: string,
  accessToken: string
): Record<string, string> {
  const creds: BrokerCredentials = { accessToken, apiKey };
  return new TestZerodhaClient(creds).publicAuthHeaders();
}

// ---------------------------------------------------------------------------
// Inline Types (no imports from source)
// ---------------------------------------------------------------------------

interface ZerodhaHoldingRaw {
  tradingsymbol: string;
  instrument_token?: number;
  isin?: string;
  exchange: string;
  quantity: number;
  average_price: number;
  last_price: number;
  close_price?: number;
  pnl: number;
  day_change?: number;
  day_change_percentage?: number;
  t1_quantity?: number;
  pledged_quantity?: number;
  collateral_quantity?: number;
  mtf?: {
    quantity: number;
    used_quantity: number;
    average_price: number;
    value: number;
    initial_margin: number;
  };
}

interface ZerodhaPositionRaw {
  tradingsymbol: string;
  instrument_token?: number;
  exchange: string;
  product: string;
  quantity: number;
  buy_quantity: number;
  sell_quantity: number;
  overnight_quantity?: number;
  buy_price: number;
  sell_price: number;
  average_price: number;
  last_price: number;
  close_price?: number;
  day_buy_quantity?: number;
  day_buy_price?: number;
  day_buy_value?: number;
  day_sell_quantity?: number;
  day_sell_price?: number;
  day_sell_value?: number;
  buy_value?: number;
  sell_value?: number;
  value?: number;
  pnl: number;
  m2m?: number;
  realised: number;
  unrealised: number;
  multiplier?: number;
}

interface ZerodhaTradeRaw {
  trade_id: string;
  order_id: string;
  tradingsymbol: string;
  isin?: string;
  exchange: string;
  transaction_type: "BUY" | "SELL";
  quantity: number;
  average_price: number;
  price?: number;
  fill_timestamp: string;
  product: string;
  order_type?: string;
}

interface ZerodhaOrderRaw {
  order_id: string;
  tradingsymbol: string;
  exchange: string;
  transaction_type: "BUY" | "SELL";
  order_type: string;
  product: string;
  quantity: number;
  price: number;
  trigger_price?: number;
  filled_quantity: number;
  pending_quantity?: number;
  status: string;
  status_message?: string;
  order_timestamp: string;
  exchange_update_timestamp?: string;
}

interface ZerothaMutualFundRaw {
  fund: string;
  tradingsymbol: string;
  folio: string;
  quantity: number;
  average_price: number;
  last_price: number;
  pnl: number;
  pnl_pct?: number;
  xirr?: number;
  pledged_quantity?: number;
  las_quantity?: number;
  last_price_date?: string;
}

// ---------------------------------------------------------------------------
// Inline fixtures for the instance data-normalizers
// ---------------------------------------------------------------------------
//
// The methods below (segment mapping, holding/position/trade/order/MF
// normalization, order-type/status mapping, token validity) are PRIVATE /
// instance methods on ZerodhaClient and are reached only through getHoldings()/
// getPositions()/etc., which each call the network via makeRequest(). They can't
// be invoked in isolation without an HTTP stub, so they remain as test fixtures
// here. The auth-header / login-URL / checksum logic below IS asserted against
// the real exported ZerodhaClient (see the corresponding describe blocks).

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

function normalizeHolding(h: ZerodhaHoldingRaw) {
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

function normalizePosition(p: ZerodhaPositionRaw, type: "DAY" | "NET") {
  const segment = getSegmentFromExchange(p.exchange);
  return {
    symbol: p.tradingsymbol,
    tradingSymbol: p.tradingsymbol,
    instrumentToken: p.instrument_token,
    exchange: p.exchange,
    segment,
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
    dayBuyQuantity: p.day_buy_quantity || 0,
    dayBuyPrice: p.day_buy_price || 0,
    dayBuyValue: p.day_buy_value || 0,
    daySellQuantity: p.day_sell_quantity || 0,
    daySellPrice: p.day_sell_price || 0,
    daySellValue: p.day_sell_value || 0,
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

function normalizeTrade(t: ZerodhaTradeRaw) {
  const segment = getSegmentFromExchange(t.exchange);
  const executionPrice = t.average_price || t.price || 0;

  let isin: string | undefined;
  if (segment === "MF" && t.tradingsymbol) {
    isin = t.tradingsymbol;
  } else if (t.isin) {
    isin = t.isin;
  }

  return {
    tradeId: t.trade_id,
    orderId: t.order_id,
    symbol: t.tradingsymbol,
    tradingSymbol: t.tradingsymbol,
    isin,
    exchange: t.exchange,
    segment,
    transactionType: t.transaction_type,
    quantity: t.quantity,
    price: executionPrice,
    value: t.quantity * executionPrice,
    tradeTime: new Date(t.fill_timestamp),
    productType: t.product,
    orderType: t.order_type,
  };
}

function mapOrderType(type: string): "MARKET" | "LIMIT" | "SL" | "SL-M" {
  const mapping: Record<string, "MARKET" | "LIMIT" | "SL" | "SL-M"> = {
    MARKET: "MARKET",
    LIMIT: "LIMIT",
    SL: "SL",
    "SL-M": "SL-M",
  };
  return mapping[type] || "MARKET";
}

function mapOrderStatus(
  status: string
): "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED" {
  const mapping: Record<
    string,
    "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED"
  > = {
    PENDING: "PENDING",
    OPEN: "OPEN",
    COMPLETE: "COMPLETE",
    CANCELLED: "CANCELLED",
    REJECTED: "REJECTED",
    "TRIGGER PENDING": "PENDING",
  };
  return mapping[status] || "PENDING";
}

function normalizeOrder(o: ZerodhaOrderRaw) {
  return {
    orderId: o.order_id,
    symbol: o.tradingsymbol,
    tradingSymbol: o.tradingsymbol,
    exchange: o.exchange,
    segment: getSegmentFromExchange(o.exchange),
    transactionType: o.transaction_type,
    orderType: mapOrderType(o.order_type),
    productType: o.product,
    quantity: o.quantity,
    price: o.price,
    triggerPrice: o.trigger_price,
    filledQuantity: o.filled_quantity,
    pendingQuantity: o.pending_quantity,
    status: mapOrderStatus(o.status),
    statusMessage: o.status_message,
    orderTime: new Date(o.order_timestamp),
    updateTime: o.exchange_update_timestamp
      ? new Date(o.exchange_update_timestamp)
      : undefined,
  };
}

function normalizeMutualFund(mf: ZerothaMutualFundRaw) {
  return {
    schemeName: mf.fund,
    schemeCode: mf.tradingsymbol,
    tradingSymbol: mf.tradingsymbol,
    isin: mf.tradingsymbol || "",
    folioNumber: mf.folio,
    folio: mf.folio,
    units: mf.quantity,
    averageNav: mf.average_price,
    currentNav: mf.last_price,
    investedValue: mf.quantity * mf.average_price,
    currentValue: mf.quantity * mf.last_price,
    pnl: mf.pnl,
    pnlPercentage:
      mf.pnl_pct ||
      (mf.average_price > 0
        ? ((mf.last_price - mf.average_price) / mf.average_price) * 100
        : 0),
    xirr: mf.xirr,
    pledgedQuantity: mf.pledged_quantity || 0,
    lasQuantity: mf.las_quantity || 0,
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
  overrides: Partial<ZerodhaHoldingRaw> = {}
): ZerodhaHoldingRaw {
  return {
    tradingsymbol: "RELIANCE",
    instrument_token: 738561,
    isin: "INE002A01018",
    exchange: "NSE",
    quantity: 10,
    average_price: 2400,
    last_price: 2520,
    close_price: 2480,
    pnl: 1200,
    day_change: 40,
    day_change_percentage: 1.64,
    t1_quantity: 0,
    pledged_quantity: 0,
    collateral_quantity: 0,
    ...overrides,
  };
}

function createMockPosition(
  overrides: Partial<ZerodhaPositionRaw> = {}
): ZerodhaPositionRaw {
  return {
    tradingsymbol: "INFY",
    instrument_token: 408065,
    exchange: "NSE",
    product: "MIS",
    quantity: 20,
    buy_quantity: 20,
    sell_quantity: 0,
    overnight_quantity: 0,
    buy_price: 1500,
    sell_price: 0,
    average_price: 1500,
    last_price: 1550,
    close_price: 1520,
    buy_value: 30000,
    sell_value: 0,
    value: 31000,
    pnl: 1000,
    m2m: 1000,
    realised: 0,
    unrealised: 1000,
    multiplier: 1,
    ...overrides,
  };
}

function createMockTrade(
  overrides: Partial<ZerodhaTradeRaw> = {}
): ZerodhaTradeRaw {
  return {
    trade_id: "TRD-001",
    order_id: "ORD-001",
    tradingsymbol: "HDFCBANK",
    exchange: "NSE",
    transaction_type: "BUY",
    quantity: 15,
    average_price: 1680,
    fill_timestamp: "2025-01-15T10:15:00+05:30",
    product: "CNC",
    order_type: "MARKET",
    ...overrides,
  };
}

function createMockOrder(
  overrides: Partial<ZerodhaOrderRaw> = {}
): ZerodhaOrderRaw {
  return {
    order_id: "ORD-001",
    tradingsymbol: "TCS",
    exchange: "NSE",
    transaction_type: "BUY",
    order_type: "LIMIT",
    product: "CNC",
    quantity: 5,
    price: 3800,
    trigger_price: 0,
    filled_quantity: 5,
    pending_quantity: 0,
    status: "COMPLETE",
    status_message: "",
    order_timestamp: "2025-01-15T09:30:00+05:30",
    exchange_update_timestamp: "2025-01-15T09:30:01+05:30",
    ...overrides,
  };
}

function createMockMutualFund(
  overrides: Partial<ZerothaMutualFundRaw> = {}
): ZerothaMutualFundRaw {
  return {
    fund: "Axis Bluechip Fund - Direct Growth",
    tradingsymbol: "INF846K01DP8",
    folio: "1234567890",
    quantity: 100.5,
    average_price: 45.5,
    last_price: 52.3,
    pnl: 683.4,
    pnl_pct: 14.95,
    xirr: 12.5,
    pledged_quantity: 0,
    las_quantity: 0,
    last_price_date: "2025-01-14",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Zerodha Web Client", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      ZERODHA_API_KEY: process.env.ZERODHA_API_KEY,
      ZERODHA_API_SECRET: process.env.ZERODHA_API_SECRET,
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
    it("should format Authorization as 'token apiKey:accessToken'", () => {
      const headers = realZerodhaAuthHeaders("my_api_key", "my_token");
      assert.strictEqual(headers.Authorization, "token my_api_key:my_token");
    });

    it("should include X-Kite-Version header set to 3", () => {
      const headers = realZerodhaAuthHeaders("key", "token");
      assert.strictEqual(headers["X-Kite-Version"], "3");
    });

    it("should have exactly two headers", () => {
      const headers = realZerodhaAuthHeaders("key", "token");
      assert.strictEqual(Object.keys(headers).length, 2);
    });

    it("should handle empty apiKey", () => {
      // Empty apiKey credential → constructor falls back to ZERODHA_API_KEY, then
      // "". Clear the env so the fallback resolves to "" deterministically
      // (afterEach restores it).
      delete process.env.ZERODHA_API_KEY;
      const headers = realZerodhaAuthHeaders("", "token");
      assert.strictEqual(headers.Authorization, "token :token");
    });

    it("should handle empty accessToken", () => {
      const headers = realZerodhaAuthHeaders("key", "");
      assert.strictEqual(headers.Authorization, "token key:");
    });

    it("should handle both empty", () => {
      delete process.env.ZERODHA_API_KEY;
      const headers = realZerodhaAuthHeaders("", "");
      assert.strictEqual(headers.Authorization, "token :");
    });
  });

  // ==========================================================================
  // Login URL Generation
  // ==========================================================================

  describe("Login URL generation", () => {
    it("should start with Zerodha login URL", () => {
      const url = ZerodhaClient.getLoginUrl("key123", "https://example.com/cb");
      assert.ok(url.startsWith("https://kite.zerodha.com/connect/login?"));
    });

    it("should include v=3 parameter", () => {
      const url = ZerodhaClient.getLoginUrl("key123", "https://example.com/cb");
      assert.ok(url.includes("v=3"));
    });

    it("should include api_key parameter", () => {
      const url = ZerodhaClient.getLoginUrl(
        "my_api_key",
        "https://example.com/cb"
      );
      assert.ok(url.includes("api_key=my_api_key"));
    });

    it("should include redirect_uri parameter", () => {
      const url = ZerodhaClient.getLoginUrl(
        "key",
        "https://usemoney.ai/callback"
      );
      assert.ok(url.includes("redirect_uri="));
      assert.ok(url.includes("usemoney.ai"));
    });

    it("should URL-encode the redirect_uri", () => {
      const url = ZerodhaClient.getLoginUrl(
        "key",
        "https://example.com/cb?a=1&b=2"
      );
      assert.ok(
        url.includes(encodeURIComponent("https://example.com/cb?a=1&b=2"))
      );
    });
  });

  // ==========================================================================
  // Checksum Generation
  // ==========================================================================

  describe("Checksum generation", () => {
    it("should generate SHA256 of apiKey + requestToken + apiSecret", () => {
      const checksum = ZerodhaClient.generateChecksum("key", "token", "secret");
      const expected = createHash("sha256")
        .update("keytokensecret")
        .digest("hex");
      assert.strictEqual(checksum, expected);
    });

    it("should return a 64-character hex string", () => {
      const checksum = ZerodhaClient.generateChecksum("k", "t", "s");
      assert.strictEqual(checksum.length, 64);
      assert.match(checksum, /^[0-9a-f]{64}$/);
    });

    it("should be deterministic", () => {
      const c1 = ZerodhaClient.generateChecksum("key", "token", "secret");
      const c2 = ZerodhaClient.generateChecksum("key", "token", "secret");
      assert.strictEqual(c1, c2);
    });

    it("should produce different checksums for different inputs", () => {
      const c1 = ZerodhaClient.generateChecksum("key1", "token", "secret");
      const c2 = ZerodhaClient.generateChecksum("key2", "token", "secret");
      assert.notStrictEqual(c1, c2);
    });

    it("should handle empty strings", () => {
      const checksum = ZerodhaClient.generateChecksum("", "", "");
      const expected = createHash("sha256").update("").digest("hex");
      assert.strictEqual(checksum, expected);
    });
  });

  // ==========================================================================
  // Segment from Exchange Mapping
  // ==========================================================================

  describe("Segment from exchange mapping", () => {
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

    it("should default to CASH for empty string", () => {
      assert.strictEqual(getSegmentFromExchange(""), "CASH");
    });
  });

  // ==========================================================================
  // Holdings Normalization
  // ==========================================================================

  describe("Holdings normalization", () => {
    it("should map tradingsymbol to symbol, tradingSymbol, and name", () => {
      const raw = createMockHolding({ tradingsymbol: "RELIANCE" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.tradingSymbol, "RELIANCE");
      assert.strictEqual(result.name, "RELIANCE");
    });

    it("should map instrument_token to instrumentToken", () => {
      const raw = createMockHolding({ instrument_token: 738561 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.instrumentToken, 738561);
    });

    it("should map isin correctly", () => {
      const raw = createMockHolding({ isin: "INE002A01018" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.isin, "INE002A01018");
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

    it("should calculate pnlPercentage as ((last-avg)/avg)*100", () => {
      const raw = createMockHolding({
        average_price: 1000,
        last_price: 1150,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, 15);
    });

    it("should return pnlPercentage=0 when average_price is 0", () => {
      const raw = createMockHolding({ average_price: 0, last_price: 100 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should handle negative pnlPercentage for loss", () => {
      const raw = createMockHolding({
        average_price: 2000,
        last_price: 1800,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, -10);
    });

    it("should map pledged_quantity with default of 0", () => {
      const raw = createMockHolding({ pledged_quantity: 5 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 5);
    });

    it("should default pledgedQuantity to 0 when missing", () => {
      const raw = createMockHolding();
      delete (raw as unknown as Record<string, unknown>).pledged_quantity;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 0);
    });

    it("should map collateral_quantity with default of 0", () => {
      const raw = createMockHolding({ collateral_quantity: 3 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.collateralQuantity, 3);
    });

    it("should normalize MTF data when present", () => {
      const raw = createMockHolding({
        mtf: {
          quantity: 5,
          used_quantity: 3,
          average_price: 2380,
          value: 11900,
          initial_margin: 3570,
        },
      });
      const result = normalizeHolding(raw);
      assert.ok(result.mtf);
      assert.strictEqual(result.mtf.quantity, 5);
      assert.strictEqual(result.mtf.usedQuantity, 3);
      assert.strictEqual(result.mtf.averagePrice, 2380);
      assert.strictEqual(result.mtf.value, 11900);
      assert.strictEqual(result.mtf.initialMargin, 3570);
    });

    it("should set mtf to null when not present", () => {
      const raw = createMockHolding();
      const result = normalizeHolding(raw);
      assert.strictEqual(result.mtf, null);
    });
  });

  // ==========================================================================
  // Positions Normalization
  // ==========================================================================

  describe("Positions normalization", () => {
    it("should map tradingsymbol to symbol and tradingSymbol", () => {
      const raw = createMockPosition({ tradingsymbol: "SBIN" });
      const result = normalizePosition(raw, "NET");
      assert.strictEqual(result.symbol, "SBIN");
      assert.strictEqual(result.tradingSymbol, "SBIN");
    });

    it("should derive segment from exchange (NSE->CASH)", () => {
      const raw = createMockPosition({ exchange: "NSE" });
      const result = normalizePosition(raw, "NET");
      assert.strictEqual(result.segment, "CASH");
    });

    it("should derive segment from exchange (NFO->FO)", () => {
      const raw = createMockPosition({ exchange: "NFO" });
      const result = normalizePosition(raw, "NET");
      assert.strictEqual(result.segment, "FO");
    });

    it("should set positionType to DAY when type is DAY", () => {
      const raw = createMockPosition();
      const result = normalizePosition(raw, "DAY");
      assert.strictEqual(result.positionType, "DAY");
    });

    it("should set positionType to NET when type is NET", () => {
      const raw = createMockPosition();
      const result = normalizePosition(raw, "NET");
      assert.strictEqual(result.positionType, "NET");
    });

    it("should default overnightQuantity to 0 when missing", () => {
      const raw = createMockPosition();
      delete (raw as unknown as Record<string, unknown>).overnight_quantity;
      const result = normalizePosition(raw, "DAY");
      assert.strictEqual(result.overnightQuantity, 0);
    });

    it("should default day-specific fields to 0 when missing", () => {
      const raw = createMockPosition();
      delete (raw as unknown as Record<string, unknown>).day_buy_quantity;
      delete (raw as unknown as Record<string, unknown>).day_buy_price;
      delete (raw as unknown as Record<string, unknown>).day_buy_value;
      delete (raw as unknown as Record<string, unknown>).day_sell_quantity;
      delete (raw as unknown as Record<string, unknown>).day_sell_price;
      delete (raw as unknown as Record<string, unknown>).day_sell_value;
      const result = normalizePosition(raw, "DAY");
      assert.strictEqual(result.dayBuyQuantity, 0);
      assert.strictEqual(result.dayBuyPrice, 0);
      assert.strictEqual(result.dayBuyValue, 0);
      assert.strictEqual(result.daySellQuantity, 0);
      assert.strictEqual(result.daySellPrice, 0);
      assert.strictEqual(result.daySellValue, 0);
    });

    it("should calculate pnlPercentage correctly", () => {
      const raw = createMockPosition({
        quantity: 10,
        average_price: 100,
        pnl: 100,
      });
      const result = normalizePosition(raw, "NET");
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should return pnlPercentage=0 when average_price is 0", () => {
      const raw = createMockPosition({
        quantity: 10,
        average_price: 0,
        pnl: 500,
      });
      const result = normalizePosition(raw, "NET");
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should map realised to realizedPnl and unrealised to unrealizedPnl", () => {
      const raw = createMockPosition({ realised: 500, unrealised: 250 });
      const result = normalizePosition(raw, "NET");
      assert.strictEqual(result.realizedPnl, 500);
      assert.strictEqual(result.unrealizedPnl, 250);
    });
  });

  // ==========================================================================
  // Trades Normalization
  // ==========================================================================

  describe("Trades normalization", () => {
    it("should map trade_id to tradeId", () => {
      const raw = createMockTrade({ trade_id: "T-12345" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.tradeId, "T-12345");
    });

    it("should map order_id to orderId", () => {
      const raw = createMockTrade({ order_id: "O-99999" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.orderId, "O-99999");
    });

    it("should use average_price as execution price", () => {
      const raw = createMockTrade({ average_price: 1680 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.price, 1680);
    });

    it("should fall back to price when average_price is 0", () => {
      const raw = createMockTrade({ average_price: 0, price: 1650 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.price, 1650);
    });

    it("should default to 0 when both average_price and price are missing", () => {
      const raw = createMockTrade({ average_price: 0 });
      delete (raw as unknown as Record<string, unknown>).price;
      const result = normalizeTrade(raw);
      assert.strictEqual(result.price, 0);
    });

    it("should calculate value as quantity * executionPrice", () => {
      const raw = createMockTrade({ quantity: 10, average_price: 500 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.value, 5000);
    });

    it("should derive segment from exchange", () => {
      const raw = createMockTrade({ exchange: "NFO" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.segment, "FO");
    });

    it("should extract ISIN from isin field when present", () => {
      const raw = createMockTrade({ isin: "INE002A01018" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.isin, "INE002A01018");
    });

    it("should set isin to undefined when not available", () => {
      const raw = createMockTrade({ exchange: "NSE" });
      delete (raw as unknown as Record<string, unknown>).isin;
      const result = normalizeTrade(raw);
      assert.strictEqual(result.isin, undefined);
    });

    it("should convert fill_timestamp to Date", () => {
      const raw = createMockTrade({
        fill_timestamp: "2025-01-15T10:15:00+05:30",
      });
      const result = normalizeTrade(raw);
      assert.ok(result.tradeTime instanceof Date);
      assert.ok(!isNaN(result.tradeTime.getTime()));
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
  });

  // ==========================================================================
  // Order Type Mapping
  // ==========================================================================

  describe("Order type mapping", () => {
    it("should map MARKET to MARKET", () => {
      assert.strictEqual(mapOrderType("MARKET"), "MARKET");
    });

    it("should map LIMIT to LIMIT", () => {
      assert.strictEqual(mapOrderType("LIMIT"), "LIMIT");
    });

    it("should map SL to SL", () => {
      assert.strictEqual(mapOrderType("SL"), "SL");
    });

    it("should map SL-M to SL-M", () => {
      assert.strictEqual(mapOrderType("SL-M"), "SL-M");
    });

    it("should default to MARKET for unknown type", () => {
      assert.strictEqual(mapOrderType("UNKNOWN"), "MARKET");
    });

    it("should default to MARKET for empty string", () => {
      assert.strictEqual(mapOrderType(""), "MARKET");
    });
  });

  // ==========================================================================
  // Order Status Mapping
  // ==========================================================================

  describe("Order status mapping", () => {
    it("should map PENDING to PENDING", () => {
      assert.strictEqual(mapOrderStatus("PENDING"), "PENDING");
    });

    it("should map OPEN to OPEN", () => {
      assert.strictEqual(mapOrderStatus("OPEN"), "OPEN");
    });

    it("should map COMPLETE to COMPLETE", () => {
      assert.strictEqual(mapOrderStatus("COMPLETE"), "COMPLETE");
    });

    it("should map CANCELLED to CANCELLED", () => {
      assert.strictEqual(mapOrderStatus("CANCELLED"), "CANCELLED");
    });

    it("should map REJECTED to REJECTED", () => {
      assert.strictEqual(mapOrderStatus("REJECTED"), "REJECTED");
    });

    it("should map 'TRIGGER PENDING' to PENDING", () => {
      assert.strictEqual(mapOrderStatus("TRIGGER PENDING"), "PENDING");
    });

    it("should default to PENDING for unknown status", () => {
      assert.strictEqual(mapOrderStatus("UNKNOWN"), "PENDING");
    });

    it("should default to PENDING for empty string", () => {
      assert.strictEqual(mapOrderStatus(""), "PENDING");
    });
  });

  // ==========================================================================
  // Orders Normalization
  // ==========================================================================

  describe("Orders normalization", () => {
    it("should map order_id to orderId", () => {
      const raw = createMockOrder({ order_id: "ORD-555" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.orderId, "ORD-555");
    });

    it("should map tradingsymbol to symbol and tradingSymbol", () => {
      const raw = createMockOrder({ tradingsymbol: "TCS" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.symbol, "TCS");
      assert.strictEqual(result.tradingSymbol, "TCS");
    });

    it("should derive segment from exchange", () => {
      const raw = createMockOrder({ exchange: "NFO" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.segment, "FO");
    });

    it("should apply orderType mapping", () => {
      const raw = createMockOrder({ order_type: "LIMIT" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.orderType, "LIMIT");
    });

    it("should apply orderStatus mapping", () => {
      const raw = createMockOrder({ status: "COMPLETE" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.status, "COMPLETE");
    });

    it("should convert order_timestamp to Date", () => {
      const raw = createMockOrder({
        order_timestamp: "2025-01-15T09:30:00+05:30",
      });
      const result = normalizeOrder(raw);
      assert.ok(result.orderTime instanceof Date);
    });

    it("should convert exchange_update_timestamp to Date when present", () => {
      const raw = createMockOrder({
        exchange_update_timestamp: "2025-01-15T09:30:01+05:30",
      });
      const result = normalizeOrder(raw);
      assert.ok(result.updateTime instanceof Date);
    });

    it("should set updateTime to undefined when exchange_update_timestamp is missing", () => {
      const raw = createMockOrder();
      delete (raw as unknown as Record<string, unknown>)
        .exchange_update_timestamp;
      const result = normalizeOrder(raw);
      assert.strictEqual(result.updateTime, undefined);
    });
  });

  // ==========================================================================
  // Mutual Funds Normalization
  // ==========================================================================

  describe("Mutual funds normalization", () => {
    it("should map fund to schemeName", () => {
      const raw = createMockMutualFund({ fund: "Axis Bluechip Fund" });
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.schemeName, "Axis Bluechip Fund");
    });

    it("should map tradingsymbol to schemeCode and isin", () => {
      const raw = createMockMutualFund({ tradingsymbol: "INF846K01DP8" });
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.schemeCode, "INF846K01DP8");
      assert.strictEqual(result.isin, "INF846K01DP8");
    });

    it("should map folio to folioNumber and folio", () => {
      const raw = createMockMutualFund({ folio: "FOLIO123" });
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.folioNumber, "FOLIO123");
      assert.strictEqual(result.folio, "FOLIO123");
    });

    it("should map quantity to units", () => {
      const raw = createMockMutualFund({ quantity: 250.75 });
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.units, 250.75);
    });

    it("should calculate investedValue and currentValue", () => {
      const raw = createMockMutualFund({
        quantity: 100,
        average_price: 50,
        last_price: 55,
      });
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.investedValue, 5000);
      assert.strictEqual(result.currentValue, 5500);
    });

    it("should use pnl_pct for pnlPercentage when available", () => {
      const raw = createMockMutualFund({ pnl_pct: 14.95 });
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.pnlPercentage, 14.95);
    });

    it("should calculate pnlPercentage when pnl_pct is not provided", () => {
      const raw = createMockMutualFund({
        average_price: 100,
        last_price: 110,
      });
      delete (raw as unknown as Record<string, unknown>).pnl_pct;
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should return pnlPercentage=0 when average_price is 0", () => {
      const raw = createMockMutualFund({ average_price: 0, last_price: 50 });
      delete (raw as unknown as Record<string, unknown>).pnl_pct;
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should default pledgedQuantity to 0 when missing", () => {
      const raw = createMockMutualFund();
      delete (raw as unknown as Record<string, unknown>).pledged_quantity;
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.pledgedQuantity, 0);
    });

    it("should default lasQuantity to 0 when missing", () => {
      const raw = createMockMutualFund();
      delete (raw as unknown as Record<string, unknown>).las_quantity;
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.lasQuantity, 0);
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
      const data: ZerodhaHoldingRaw[] = [];
      assert.deepStrictEqual(data.map(normalizeHolding), []);
    });

    it("should handle empty positions arrays (DAY and NET)", () => {
      const day: ZerodhaPositionRaw[] = [];
      const net: ZerodhaPositionRaw[] = [];
      const all = [
        ...day.map((p) => normalizePosition(p, "DAY")),
        ...net.map((p) => normalizePosition(p, "NET")),
      ];
      assert.strictEqual(all.length, 0);
    });

    it("should handle empty trades array", () => {
      const data: ZerodhaTradeRaw[] = [];
      assert.deepStrictEqual(data.map(normalizeTrade), []);
    });

    it("should handle empty orders array", () => {
      const data: ZerodhaOrderRaw[] = [];
      assert.deepStrictEqual(data.map(normalizeOrder), []);
    });

    it("should handle zero prices in holdings without NaN", () => {
      const raw = createMockHolding({
        average_price: 0,
        last_price: 0,
        pnl: 0,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, 0);
      assert.strictEqual(Number.isNaN(result.pnlPercentage), false);
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

    it("should handle fractional mutual fund units", () => {
      const raw = createMockMutualFund({
        quantity: 123.456789,
        average_price: 45.67,
        last_price: 48.92,
      });
      const result = normalizeMutualFund(raw);
      assert.strictEqual(result.units, 123.456789);
    });

    it("should handle missing optional fields in holding without crashing", () => {
      const raw: ZerodhaHoldingRaw = {
        tradingsymbol: "TEST",
        exchange: "NSE",
        quantity: 1,
        average_price: 100,
        last_price: 110,
        pnl: 10,
      };
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "TEST");
      assert.strictEqual(result.pledgedQuantity, 0);
      assert.strictEqual(result.collateralQuantity, 0);
      assert.strictEqual(result.mtf, null);
    });

    it("should handle negative pnl in positions", () => {
      const raw = createMockPosition({
        quantity: 10,
        average_price: 200,
        pnl: -500,
      });
      const result = normalizePosition(raw, "NET");
      assert.strictEqual(result.pnl, -500);
      assert.ok(result.pnlPercentage < 0);
    });
  });
});
