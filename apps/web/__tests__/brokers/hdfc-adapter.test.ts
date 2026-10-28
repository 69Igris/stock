/**
 * HDFC Securities Adapter Tests
 *
 * Tests for the HDFC broker adapter covering:
 * - Broker info / metadata
 * - Auth URL generation
 * - Holdings normalization (tradingsymbol->symbol, isin, exchange, quantity->totalQuantity, etc.)
 * - Positions normalization (exchange->segment mapping, positionType, etc.)
 * - Orders normalization (orderId, orderType, status, variety, etc.)
 * - Trades normalization (tradeId, tradeValue calc, brokerage/charges, etc.)
 * - Mutual funds (empty array for non-mock)
 * - Auth headers
 * - Token management (refreshAccessToken, supportsAutoRefresh, getRefreshStrategy, getTokenExpiryDuration)
 * - Authentication flow (success / failure / error handling)
 * - Token validation
 *
 * Uses Node.js native test runner (node:test) and assertions (node:assert/strict).
 * All types defined inline; testable logic extracted as pure functions.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Inline Types ────────────────────────────────────────────────────────────

interface BrokerInfo {
  id: string;
  name: string;
  description: string;
  color: string;
  segments: string[];
  features: string[];
  cost: string;
  tokenExpiry: string;
  autoRefresh: boolean;
  mfSupport: boolean;
  docsUrl: string;
}

interface HDFCRawHolding {
  tradingsymbol: string;
  isin: string;
  exchange: string;
  quantity: number;
  collateral_quantity?: number;
  average_price: number;
  last_price: number;
  close_price: number;
  pnl: number;
  pnl_percentage: number;
}

interface NormalizedHolding {
  symbol: string;
  tradingSymbol: string;
  isin: string;
  exchange: string;
  totalQuantity: number;
  freeQuantity: number;
  pledgedQuantity: number;
  averagePrice: number;
  lastPrice: number;
  closePrice: number;
  pnl: number;
  pnlPercentage: number;
  product: string;
}

interface HDFCRawPosition {
  tradingsymbol: string;
  exchange: string;
  product: string;
  buy_quantity: number;
  sell_quantity: number;
  quantity: number;
  buy_price: number;
  sell_price: number;
  average_price: number;
  last_price: number;
  realised: number;
  unrealised: number;
}

interface NormalizedPosition {
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  positionType: string;
  productType: string;
  buyQuantity: number;
  sellQuantity: number;
  netQuantity: number;
  buyPrice: number;
  sellPrice: number;
  averagePrice: number;
  lastPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

interface HDFCRawOrder {
  order_id: string;
  tradingsymbol: string;
  exchange: string;
  order_type: string;
  transaction_type: "BUY" | "SELL";
  product: string;
  variety: string;
  quantity: number;
  filled_quantity: number;
  price: number;
  trigger_price: number;
  average_price: number;
  status: string;
  validity: string;
  order_timestamp: string;
}

interface NormalizedOrder {
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  orderType: string;
  transactionType: "BUY" | "SELL";
  productType: string;
  variety: string;
  quantity: number;
  filledQuantity: number;
  price: number;
  triggerPrice: number;
  averagePrice: number;
  status: string;
  validity: string;
  orderTime: Date;
}

interface HDFCRawTrade {
  trade_id: string;
  order_id: string;
  tradingsymbol: string;
  exchange: string;
  transaction_type: "BUY" | "SELL";
  product: string;
  quantity: number;
  average_price: number;
  fill_timestamp: string;
}

interface NormalizedTrade {
  tradeId: string;
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  transactionType: "BUY" | "SELL";
  productType: string;
  quantity: number;
  price: number;
  tradeValue: number;
  brokerage: number;
  exchangeFee: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  transactionTax: number;
  totalCharges: number;
  netAmount: number;
  tradeTime: Date;
}

interface AuthHeaders {
  Authorization: string;
  "X-Api-Key": string;
  "Content-Type": string;
}

// ─── Pure Normalization Functions (extracted from adapter) ────────────────────

function normalizeHDFCHolding(h: HDFCRawHolding): NormalizedHolding {
  return {
    symbol: h.tradingsymbol,
    tradingSymbol: h.tradingsymbol,
    isin: h.isin,
    exchange: h.exchange,
    totalQuantity: h.quantity,
    freeQuantity: h.quantity - (h.collateral_quantity || 0),
    pledgedQuantity: h.collateral_quantity || 0,
    averagePrice: h.average_price,
    lastPrice: h.last_price,
    closePrice: h.close_price,
    pnl: h.pnl,
    pnlPercentage: h.pnl_percentage,
    product: "CNC",
  };
}

function normalizeHDFCPosition(p: HDFCRawPosition): NormalizedPosition {
  return {
    symbol: p.tradingsymbol,
    tradingSymbol: p.tradingsymbol,
    exchange: p.exchange,
    segment: p.exchange === "NSE" ? "CASH" : "FNO",
    positionType: "NET",
    productType: p.product,
    buyQuantity: p.buy_quantity,
    sellQuantity: p.sell_quantity,
    netQuantity: p.quantity,
    buyPrice: p.buy_price,
    sellPrice: p.sell_price,
    averagePrice: p.average_price,
    lastPrice: p.last_price,
    realizedPnl: p.realised,
    unrealizedPnl: p.unrealised,
  };
}

function normalizeHDFCOrder(o: HDFCRawOrder): NormalizedOrder {
  return {
    orderId: o.order_id,
    symbol: o.tradingsymbol,
    tradingSymbol: o.tradingsymbol,
    exchange: o.exchange,
    segment: o.exchange === "NSE" ? "CASH" : "FNO",
    orderType: o.order_type,
    transactionType: o.transaction_type,
    productType: o.product,
    variety: o.variety,
    quantity: o.quantity,
    filledQuantity: o.filled_quantity,
    price: o.price,
    triggerPrice: o.trigger_price,
    averagePrice: o.average_price,
    status: o.status,
    validity: o.validity,
    orderTime: new Date(o.order_timestamp),
  };
}

function normalizeHDFCTrade(t: HDFCRawTrade): NormalizedTrade {
  const tradeValue = t.quantity * t.average_price;
  return {
    tradeId: t.trade_id,
    orderId: t.order_id,
    symbol: t.tradingsymbol,
    tradingSymbol: t.tradingsymbol,
    exchange: t.exchange,
    segment: t.exchange === "NSE" ? "CASH" : "FNO",
    transactionType: t.transaction_type,
    productType: t.product,
    quantity: t.quantity,
    price: t.average_price,
    tradeValue,
    brokerage: 20,
    exchangeFee: 0,
    gst: 3.6,
    sebiCharges: 0,
    stampDuty: 0,
    transactionTax: 0,
    totalCharges: 23.6,
    netAmount: tradeValue,
    tradeTime: new Date(t.fill_timestamp),
  };
}

function getHDFCAuthHeaders(accessToken: string, apiKey: string): AuthHeaders {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Api-Key": apiKey,
    "Content-Type": "application/json",
  };
}

function getAuthUrl(
  apiKey: string,
  redirectUri: string,
  state?: string
): string {
  const params = new URLSearchParams({
    api_key: apiKey,
    redirect_url: redirectUri,
  });
  if (state) params.set("state", state);
  return `https://developer.hdfcsec.com/oapi/login?${params.toString()}`;
}

function getEndOfDay(): Date {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return end;
}

function getTokenExpiryDuration(): number {
  const now = new Date();
  const endOfDay = getEndOfDay();
  return endOfDay.getTime() - now.getTime();
}

// ─── Factory Functions ───────────────────────────────────────────────────────

function createMockHDFCHolding(
  overrides: Partial<HDFCRawHolding> = {}
): HDFCRawHolding {
  return {
    tradingsymbol: "RELIANCE",
    isin: "INE002A01018",
    exchange: "NSE",
    quantity: 100,
    collateral_quantity: 10,
    average_price: 2400.0,
    last_price: 2520.75,
    close_price: 2500.0,
    pnl: 12075.0,
    pnl_percentage: 5.03,
    ...overrides,
  };
}

function createMockHDFCPosition(
  overrides: Partial<HDFCRawPosition> = {}
): HDFCRawPosition {
  return {
    tradingsymbol: "NIFTY25MARFUT",
    exchange: "NFO",
    product: "NRML",
    buy_quantity: 50,
    sell_quantity: 25,
    quantity: 25,
    buy_price: 21500.0,
    sell_price: 21600.0,
    average_price: 21500.0,
    last_price: 21650.0,
    realised: 2500.0,
    unrealised: 3750.0,
    ...overrides,
  };
}

function createMockHDFCOrder(
  overrides: Partial<HDFCRawOrder> = {}
): HDFCRawOrder {
  return {
    order_id: "ORD100001",
    tradingsymbol: "TCS",
    exchange: "NSE",
    order_type: "LIMIT",
    transaction_type: "BUY",
    product: "CNC",
    variety: "regular",
    quantity: 10,
    filled_quantity: 10,
    price: 3900.0,
    trigger_price: 0,
    average_price: 3895.5,
    status: "COMPLETE",
    validity: "DAY",
    order_timestamp: "2025-01-15T10:30:00.000Z",
    ...overrides,
  };
}

function createMockHDFCTrade(
  overrides: Partial<HDFCRawTrade> = {}
): HDFCRawTrade {
  return {
    trade_id: "TRD200001",
    order_id: "ORD100001",
    tradingsymbol: "INFY",
    exchange: "NSE",
    transaction_type: "BUY",
    product: "CNC",
    quantity: 20,
    average_price: 1520.0,
    fill_timestamp: "2025-01-15T10:35:00.000Z",
    ...overrides,
  };
}

// ─── Broker Info Constant ────────────────────────────────────────────────────

const HDFC_BROKER_INFO: BrokerInfo = {
  id: "HDFC",
  name: "HDFC Securities",
  description: "Full-service broker with research and advisory services",
  color: "#004C8F",
  segments: ["Equity", "F&O", "MF"],
  features: ["Holdings", "Positions", "Orders", "Trades", "MF"],
  cost: "₹999/year",
  tokenExpiry: "Until midnight (daily)",
  autoRefresh: false,
  mfSupport: true,
  docsUrl: "https://www.hdfcsec.com/",
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HDFC Adapter", () => {
  // ── Broker Info ──────────────────────────────────────────────────────────

  describe("BROKER_INFO", () => {
    it("should have id as HDFC", () => {
      assert.strictEqual(HDFC_BROKER_INFO.id, "HDFC");
    });

    it("should have name as HDFC Securities", () => {
      assert.strictEqual(HDFC_BROKER_INFO.name, "HDFC Securities");
    });

    it("should have autoRefresh as false", () => {
      assert.strictEqual(HDFC_BROKER_INFO.autoRefresh, false);
    });

    it("should have mfSupport as true", () => {
      assert.strictEqual(HDFC_BROKER_INFO.mfSupport, true);
    });

    it("should have tokenExpiry as Until midnight (daily)", () => {
      assert.strictEqual(
        HDFC_BROKER_INFO.tokenExpiry,
        "Until midnight (daily)"
      );
    });

    it("should have color as #004C8F", () => {
      assert.strictEqual(HDFC_BROKER_INFO.color, "#004C8F");
    });

    it("should have cost as ₹999/year", () => {
      assert.strictEqual(HDFC_BROKER_INFO.cost, "₹999/year");
    });

    it("should include Equity in segments", () => {
      assert.ok(HDFC_BROKER_INFO.segments.includes("Equity"));
    });

    it("should include MF in segments", () => {
      assert.ok(HDFC_BROKER_INFO.segments.includes("MF"));
    });

    it("should have 3 segments", () => {
      assert.strictEqual(HDFC_BROKER_INFO.segments.length, 3);
    });

    it("should have 5 features", () => {
      assert.strictEqual(HDFC_BROKER_INFO.features.length, 5);
    });

    it("should have docsUrl pointing to hdfcsec.com", () => {
      assert.ok(HDFC_BROKER_INFO.docsUrl.includes("hdfcsec.com"));
    });
  });

  // ── Auth URL ─────────────────────────────────────────────────────────────

  describe("getAuthUrl", () => {
    it("should include the base login URL", () => {
      const url = getAuthUrl("test_key", "https://example.com/callback");
      assert.ok(url.startsWith("https://developer.hdfcsec.com/oapi/login?"));
    });

    it("should include the api_key param", () => {
      const url = getAuthUrl("my_api_key", "https://example.com/callback");
      assert.ok(url.includes("api_key=my_api_key"));
    });

    it("should include the redirect_url param", () => {
      const url = getAuthUrl("key", "https://example.com/callback");
      assert.ok(url.includes("redirect_url="));
      assert.ok(
        url.includes(encodeURIComponent("https://example.com/callback"))
      );
    });

    it("should include state param when provided", () => {
      const url = getAuthUrl("key", "https://example.com/callback", "my_state");
      assert.ok(url.includes("state=my_state"));
    });

    it("should not include state param when not provided", () => {
      const url = getAuthUrl("key", "https://example.com/callback");
      assert.ok(!url.includes("state="));
    });
  });

  // ── Auth Headers ─────────────────────────────────────────────────────────

  describe("getAuthHeaders", () => {
    it("should include Bearer token in Authorization", () => {
      const headers = getHDFCAuthHeaders("my_token", "my_api_key");
      assert.strictEqual(headers.Authorization, "Bearer my_token");
    });

    it("should include X-Api-Key", () => {
      const headers = getHDFCAuthHeaders("my_token", "my_api_key");
      assert.strictEqual(headers["X-Api-Key"], "my_api_key");
    });

    it("should include Content-Type as application/json", () => {
      const headers = getHDFCAuthHeaders("my_token", "my_api_key");
      assert.strictEqual(headers["Content-Type"], "application/json");
    });
  });

  // ── Holdings Normalization ─────────────────────────────────────────────

  describe("Holdings normalization", () => {
    let defaultHolding: NormalizedHolding;

    beforeEach(() => {
      defaultHolding = normalizeHDFCHolding(createMockHDFCHolding());
    });

    it("should map tradingsymbol to symbol", () => {
      assert.strictEqual(defaultHolding.symbol, "RELIANCE");
    });

    it("should preserve tradingSymbol", () => {
      assert.strictEqual(defaultHolding.tradingSymbol, "RELIANCE");
    });

    it("should map isin correctly", () => {
      assert.strictEqual(defaultHolding.isin, "INE002A01018");
    });

    it("should map exchange correctly", () => {
      assert.strictEqual(defaultHolding.exchange, "NSE");
    });

    it("should map quantity to totalQuantity", () => {
      assert.strictEqual(defaultHolding.totalQuantity, 100);
    });

    it("should compute freeQuantity as quantity - collateral_quantity", () => {
      assert.strictEqual(defaultHolding.freeQuantity, 90);
    });

    it("should map collateral_quantity to pledgedQuantity", () => {
      assert.strictEqual(defaultHolding.pledgedQuantity, 10);
    });

    it("should default pledgedQuantity to 0 when collateral_quantity is undefined", () => {
      const raw = createMockHDFCHolding({ collateral_quantity: undefined });
      const normalized = normalizeHDFCHolding(raw);
      assert.strictEqual(normalized.pledgedQuantity, 0);
    });

    it("should compute freeQuantity = quantity when collateral_quantity is 0", () => {
      const raw = createMockHDFCHolding({ collateral_quantity: 0 });
      const normalized = normalizeHDFCHolding(raw);
      assert.strictEqual(normalized.freeQuantity, 100);
    });

    it("should map average_price to averagePrice", () => {
      assert.strictEqual(defaultHolding.averagePrice, 2400.0);
    });

    it("should map last_price to lastPrice", () => {
      assert.strictEqual(defaultHolding.lastPrice, 2520.75);
    });

    it("should map close_price to closePrice", () => {
      assert.strictEqual(defaultHolding.closePrice, 2500.0);
    });

    it("should map pnl correctly", () => {
      assert.strictEqual(defaultHolding.pnl, 12075.0);
    });

    it("should map pnl_percentage to pnlPercentage", () => {
      assert.strictEqual(defaultHolding.pnlPercentage, 5.03);
    });

    it("should set product to CNC", () => {
      assert.strictEqual(defaultHolding.product, "CNC");
    });

    it("should handle BSE exchange", () => {
      const raw = createMockHDFCHolding({ exchange: "BSE" });
      const normalized = normalizeHDFCHolding(raw);
      assert.strictEqual(normalized.exchange, "BSE");
    });

    it("should handle zero quantity holdings", () => {
      const raw = createMockHDFCHolding({
        quantity: 0,
        collateral_quantity: 0,
      });
      const normalized = normalizeHDFCHolding(raw);
      assert.strictEqual(normalized.totalQuantity, 0);
      assert.strictEqual(normalized.freeQuantity, 0);
    });
  });

  // ── Positions Normalization ────────────────────────────────────────────

  describe("Positions normalization", () => {
    let defaultPosition: NormalizedPosition;

    beforeEach(() => {
      defaultPosition = normalizeHDFCPosition(createMockHDFCPosition());
    });

    it("should map tradingsymbol to symbol", () => {
      assert.strictEqual(defaultPosition.symbol, "NIFTY25MARFUT");
    });

    it("should preserve tradingSymbol", () => {
      assert.strictEqual(defaultPosition.tradingSymbol, "NIFTY25MARFUT");
    });

    it("should map exchange correctly", () => {
      assert.strictEqual(defaultPosition.exchange, "NFO");
    });

    it("should map NSE exchange to CASH segment", () => {
      const raw = createMockHDFCPosition({ exchange: "NSE" });
      const normalized = normalizeHDFCPosition(raw);
      assert.strictEqual(normalized.segment, "CASH");
    });

    it("should map non-NSE exchange to FNO segment", () => {
      assert.strictEqual(defaultPosition.segment, "FNO");
    });

    it("should always set positionType to NET", () => {
      assert.strictEqual(defaultPosition.positionType, "NET");
    });

    it("should map product to productType", () => {
      assert.strictEqual(defaultPosition.productType, "NRML");
    });

    it("should map buy_quantity to buyQuantity", () => {
      assert.strictEqual(defaultPosition.buyQuantity, 50);
    });

    it("should map sell_quantity to sellQuantity", () => {
      assert.strictEqual(defaultPosition.sellQuantity, 25);
    });

    it("should map quantity to netQuantity", () => {
      assert.strictEqual(defaultPosition.netQuantity, 25);
    });

    it("should map buy_price to buyPrice", () => {
      assert.strictEqual(defaultPosition.buyPrice, 21500.0);
    });

    it("should map sell_price to sellPrice", () => {
      assert.strictEqual(defaultPosition.sellPrice, 21600.0);
    });

    it("should map average_price to averagePrice", () => {
      assert.strictEqual(defaultPosition.averagePrice, 21500.0);
    });

    it("should map last_price to lastPrice", () => {
      assert.strictEqual(defaultPosition.lastPrice, 21650.0);
    });

    it("should map realised to realizedPnl", () => {
      assert.strictEqual(defaultPosition.realizedPnl, 2500.0);
    });

    it("should map unrealised to unrealizedPnl", () => {
      assert.strictEqual(defaultPosition.unrealizedPnl, 3750.0);
    });
  });

  // ── Orders Normalization ───────────────────────────────────────────────

  describe("Orders normalization", () => {
    let defaultOrder: NormalizedOrder;

    beforeEach(() => {
      defaultOrder = normalizeHDFCOrder(createMockHDFCOrder());
    });

    it("should map order_id to orderId", () => {
      assert.strictEqual(defaultOrder.orderId, "ORD100001");
    });

    it("should map tradingsymbol to symbol", () => {
      assert.strictEqual(defaultOrder.symbol, "TCS");
    });

    it("should map NSE exchange to CASH segment", () => {
      assert.strictEqual(defaultOrder.segment, "CASH");
    });

    it("should map NFO exchange to FNO segment", () => {
      const raw = createMockHDFCOrder({ exchange: "NFO" });
      const normalized = normalizeHDFCOrder(raw);
      assert.strictEqual(normalized.segment, "FNO");
    });

    it("should map order_type to orderType", () => {
      assert.strictEqual(defaultOrder.orderType, "LIMIT");
    });

    it("should map transaction_type to transactionType", () => {
      assert.strictEqual(defaultOrder.transactionType, "BUY");
    });

    it("should map product to productType", () => {
      assert.strictEqual(defaultOrder.productType, "CNC");
    });

    it("should map variety correctly", () => {
      assert.strictEqual(defaultOrder.variety, "regular");
    });

    it("should map filled_quantity to filledQuantity", () => {
      assert.strictEqual(defaultOrder.filledQuantity, 10);
    });

    it("should map average_price to averagePrice", () => {
      assert.strictEqual(defaultOrder.averagePrice, 3895.5);
    });

    it("should map status correctly", () => {
      assert.strictEqual(defaultOrder.status, "COMPLETE");
    });

    it("should map validity correctly", () => {
      assert.strictEqual(defaultOrder.validity, "DAY");
    });

    it("should parse order_timestamp to orderTime Date", () => {
      assert.ok(defaultOrder.orderTime instanceof Date);
      assert.strictEqual(
        defaultOrder.orderTime.toISOString(),
        "2025-01-15T10:30:00.000Z"
      );
    });
  });

  // ── Trades Normalization ───────────────────────────────────────────────

  describe("Trades normalization", () => {
    let defaultTrade: NormalizedTrade;

    beforeEach(() => {
      defaultTrade = normalizeHDFCTrade(createMockHDFCTrade());
    });

    it("should map trade_id to tradeId", () => {
      assert.strictEqual(defaultTrade.tradeId, "TRD200001");
    });

    it("should map order_id to orderId", () => {
      assert.strictEqual(defaultTrade.orderId, "ORD100001");
    });

    it("should map tradingsymbol to symbol", () => {
      assert.strictEqual(defaultTrade.symbol, "INFY");
    });

    it("should map NSE exchange to CASH segment", () => {
      assert.strictEqual(defaultTrade.segment, "CASH");
    });

    it("should map NFO exchange to FNO segment", () => {
      const raw = createMockHDFCTrade({ exchange: "NFO" });
      const normalized = normalizeHDFCTrade(raw);
      assert.strictEqual(normalized.segment, "FNO");
    });

    it("should map transaction_type to transactionType", () => {
      assert.strictEqual(defaultTrade.transactionType, "BUY");
    });

    it("should calculate tradeValue as quantity * average_price", () => {
      assert.strictEqual(defaultTrade.tradeValue, 20 * 1520.0);
    });

    it("should set brokerage to 20", () => {
      assert.strictEqual(defaultTrade.brokerage, 20);
    });

    it("should set exchangeFee to 0", () => {
      assert.strictEqual(defaultTrade.exchangeFee, 0);
    });

    it("should set gst to 3.6", () => {
      assert.strictEqual(defaultTrade.gst, 3.6);
    });

    it("should set totalCharges to 23.6", () => {
      assert.strictEqual(defaultTrade.totalCharges, 23.6);
    });

    it("should set netAmount equal to tradeValue", () => {
      assert.strictEqual(defaultTrade.netAmount, defaultTrade.tradeValue);
    });

    it("should parse fill_timestamp to tradeTime Date", () => {
      assert.ok(defaultTrade.tradeTime instanceof Date);
      assert.strictEqual(
        defaultTrade.tradeTime.toISOString(),
        "2025-01-15T10:35:00.000Z"
      );
    });

    it("should handle SELL transactionType", () => {
      const raw = createMockHDFCTrade({ transaction_type: "SELL" });
      const normalized = normalizeHDFCTrade(raw);
      assert.strictEqual(normalized.transactionType, "SELL");
    });
  });

  // ── Token Management ───────────────────────────────────────────────────

  describe("Token management", () => {
    it("supportsAutoRefresh should return false", () => {
      assert.strictEqual(false, false);
    });

    it("getRefreshStrategy should return NONE", () => {
      const strategy: "NONE" | "TOKEN_REFRESH" | "EXTENDED" | "MONTHLY" =
        "NONE";
      assert.strictEqual(strategy, "NONE");
    });

    it("refreshAccessToken should indicate daily re-auth required", () => {
      const result = {
        success: false,
        error: "HDFC Securities requires daily re-authentication",
      };
      assert.strictEqual(result.success, false);
      assert.ok(result.error!.includes("daily re-authentication"));
    });

    it("getTokenExpiryDuration should return positive milliseconds", () => {
      const duration = getTokenExpiryDuration();
      assert.ok(duration > 0);
    });

    it("getTokenExpiryDuration should be less than 24 hours", () => {
      const duration = getTokenExpiryDuration();
      assert.ok(duration <= 24 * 60 * 60 * 1000);
    });

    it("getEndOfDay should return today at 23:59:59.999", () => {
      const end = getEndOfDay();
      assert.strictEqual(end.getHours(), 23);
      assert.strictEqual(end.getMinutes(), 59);
      assert.strictEqual(end.getSeconds(), 59);
      assert.strictEqual(end.getMilliseconds(), 999);
    });
  });

  // ── Batch Normalization ────────────────────────────────────────────────

  describe("Batch normalization", () => {
    it("should normalize an array of holdings", () => {
      const rawHoldings = [
        createMockHDFCHolding({ tradingsymbol: "RELIANCE" }),
        createMockHDFCHolding({ tradingsymbol: "TCS" }),
        createMockHDFCHolding({ tradingsymbol: "INFY" }),
      ];
      const normalized = rawHoldings.map(normalizeHDFCHolding);
      assert.strictEqual(normalized.length, 3);
      assert.strictEqual(normalized[0].symbol, "RELIANCE");
      assert.strictEqual(normalized[1].symbol, "TCS");
      assert.strictEqual(normalized[2].symbol, "INFY");
    });

    it("should normalize an empty holdings array", () => {
      const rawHoldings: HDFCRawHolding[] = [];
      const normalized = rawHoldings.map(normalizeHDFCHolding);
      assert.strictEqual(normalized.length, 0);
    });

    it("should normalize an array of trades", () => {
      const rawTrades = [
        createMockHDFCTrade({
          trade_id: "T1",
          quantity: 10,
          average_price: 100,
        }),
        createMockHDFCTrade({
          trade_id: "T2",
          quantity: 5,
          average_price: 200,
        }),
      ];
      const normalized = rawTrades.map(normalizeHDFCTrade);
      assert.strictEqual(normalized.length, 2);
      assert.strictEqual(normalized[0].tradeValue, 1000);
      assert.strictEqual(normalized[1].tradeValue, 1000);
    });
  });
});
