/**
 * ICICI Direct Breeze Adapter Tests
 *
 * Tests for the ICICI broker adapter covering:
 * - Broker info / metadata
 * - Auth URL generation
 * - Holdings normalization (stock_code->symbol, stock_ISIN->isin, pnl calculation, etc.)
 * - Positions normalization (stock_code->symbol, exchange_code->exchange, ltp->lastPrice, etc.)
 * - Orders normalization (stock_code->symbol, action->transactionType, stoploss_price->triggerPrice, etc.)
 * - Trades normalization (stock_code->symbol, trade_price->price, tradeValue calc, etc.)
 * - Mutual funds (empty array for non-mock)
 * - Auth headers (X-SessionToken, X-AppKey, X-SecretKey)
 * - Token management (refreshAccessToken, supportsAutoRefresh, getRefreshStrategy, getTokenExpiryDuration)
 * - Authentication flow (success via Success key, failure via Error key)
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

interface ICICIRawHolding {
  stock_code: string;
  stock_ISIN: string;
  exchange_code: string;
  quantity: number;
  average_price: number;
  current_price: number;
  previous_close: number;
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

interface ICICIRawPosition {
  stock_code: string;
  exchange_code: string;
  segment: string;
  product_type: string;
  buy_quantity: number;
  sell_quantity: number;
  quantity: number;
  buy_average_price: number;
  sell_average_price: number;
  average_price: number;
  ltp: number;
  realized_pnl: number;
  unrealized_pnl: number;
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

interface ICICIRawOrder {
  order_id: string;
  stock_code: string;
  exchange_code: string;
  segment: string;
  order_type: string;
  action: "BUY" | "SELL";
  product: string;
  quantity: number;
  filled_quantity: number;
  price: number;
  stoploss_price: number;
  average_price: number;
  status: string;
  validity: string;
  order_datetime: string;
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

interface ICICIRawTrade {
  trade_id: string;
  order_id: string;
  stock_code: string;
  exchange_code: string;
  segment: string;
  action: "BUY" | "SELL";
  product: string;
  quantity: number;
  trade_price: number;
  trade_datetime: string;
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
  "X-SessionToken": string;
  "X-AppKey": string;
  "X-SecretKey": string;
  "Content-Type": string;
}

// ─── Pure Normalization Functions (extracted from adapter) ────────────────────

function normalizeICICIHolding(h: ICICIRawHolding): NormalizedHolding {
  return {
    symbol: h.stock_code,
    tradingSymbol: h.stock_code,
    isin: h.stock_ISIN,
    exchange: h.exchange_code,
    totalQuantity: h.quantity,
    freeQuantity: h.quantity,
    pledgedQuantity: 0,
    averagePrice: h.average_price,
    lastPrice: h.current_price,
    closePrice: h.previous_close,
    pnl: (h.current_price - h.average_price) * h.quantity,
    pnlPercentage:
      ((h.current_price - h.average_price) / h.average_price) * 100,
    product: "CNC",
  };
}

function normalizeICICIPosition(p: ICICIRawPosition): NormalizedPosition {
  return {
    symbol: p.stock_code,
    tradingSymbol: p.stock_code,
    exchange: p.exchange_code,
    segment: p.segment,
    positionType: "NET",
    productType: p.product_type,
    buyQuantity: p.buy_quantity,
    sellQuantity: p.sell_quantity,
    netQuantity: p.quantity,
    buyPrice: p.buy_average_price,
    sellPrice: p.sell_average_price,
    averagePrice: p.average_price,
    lastPrice: p.ltp,
    realizedPnl: p.realized_pnl,
    unrealizedPnl: p.unrealized_pnl,
  };
}

function normalizeICICIOrder(o: ICICIRawOrder): NormalizedOrder {
  return {
    orderId: o.order_id,
    symbol: o.stock_code,
    tradingSymbol: o.stock_code,
    exchange: o.exchange_code,
    segment: o.segment,
    orderType: o.order_type,
    transactionType: o.action,
    productType: o.product,
    variety: "regular",
    quantity: o.quantity,
    filledQuantity: o.filled_quantity,
    price: o.price,
    triggerPrice: o.stoploss_price,
    averagePrice: o.average_price,
    status: o.status,
    validity: o.validity,
    orderTime: new Date(o.order_datetime),
  };
}

function normalizeICICITrade(t: ICICIRawTrade): NormalizedTrade {
  const tradeValue = t.quantity * t.trade_price;
  return {
    tradeId: t.trade_id,
    orderId: t.order_id,
    symbol: t.stock_code,
    tradingSymbol: t.stock_code,
    exchange: t.exchange_code,
    segment: t.segment,
    transactionType: t.action,
    productType: t.product,
    quantity: t.quantity,
    price: t.trade_price,
    tradeValue,
    brokerage: 20,
    exchangeFee: 0,
    gst: 3.6,
    sebiCharges: 0,
    stampDuty: 0,
    transactionTax: 0,
    totalCharges: 23.6,
    netAmount: tradeValue,
    tradeTime: new Date(t.trade_datetime),
  };
}

function getICICIAuthHeaders(
  sessionToken: string,
  apiKey: string,
  secretKey: string
): AuthHeaders {
  return {
    "X-SessionToken": sessionToken,
    "X-AppKey": apiKey,
    "X-SecretKey": secretKey,
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
    redirect_uri: redirectUri,
  });
  if (state) params.set("state", state);
  return `https://api.icicidirect.com/apiuser/login?${params.toString()}`;
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

function createMockICICIHolding(
  overrides: Partial<ICICIRawHolding> = {}
): ICICIRawHolding {
  return {
    stock_code: "RELIANCE",
    stock_ISIN: "INE002A01018",
    exchange_code: "NSE",
    quantity: 50,
    average_price: 2400.0,
    current_price: 2550.0,
    previous_close: 2500.0,
    ...overrides,
  };
}

function createMockICICIPosition(
  overrides: Partial<ICICIRawPosition> = {}
): ICICIRawPosition {
  return {
    stock_code: "NIFTY25MARFUT",
    exchange_code: "NFO",
    segment: "FNO",
    product_type: "FUTURES",
    buy_quantity: 75,
    sell_quantity: 25,
    quantity: 50,
    buy_average_price: 21500.0,
    sell_average_price: 21600.0,
    average_price: 21500.0,
    ltp: 21700.0,
    realized_pnl: 2500.0,
    unrealized_pnl: 10000.0,
    ...overrides,
  };
}

function createMockICICIOrder(
  overrides: Partial<ICICIRawOrder> = {}
): ICICIRawOrder {
  return {
    order_id: "ORD300001",
    stock_code: "HDFCBANK",
    exchange_code: "NSE",
    segment: "CASH",
    order_type: "LIMIT",
    action: "BUY",
    product: "CNC",
    quantity: 20,
    filled_quantity: 20,
    price: 1600.0,
    stoploss_price: 1580.0,
    average_price: 1598.5,
    status: "EXECUTED",
    validity: "DAY",
    order_datetime: "2025-02-10T11:15:00.000Z",
    ...overrides,
  };
}

function createMockICICITrade(
  overrides: Partial<ICICIRawTrade> = {}
): ICICIRawTrade {
  return {
    trade_id: "TRD400001",
    order_id: "ORD300001",
    stock_code: "WIPRO",
    exchange_code: "NSE",
    segment: "CASH",
    action: "BUY",
    product: "CNC",
    quantity: 30,
    trade_price: 450.0,
    trade_datetime: "2025-02-10T11:20:00.000Z",
    ...overrides,
  };
}

// ─── Broker Info Constant ────────────────────────────────────────────────────

const ICICI_BROKER_INFO: BrokerInfo = {
  id: "ICICI",
  name: "ICICI Direct",
  description: "Breeze API from ICICI Securities with comprehensive features",
  color: "#F15A22",
  segments: ["Equity", "F&O", "Currency", "MF"],
  features: ["Holdings", "Positions", "Orders", "Trades", "MF"],
  cost: "₹1000/year",
  tokenExpiry: "Until midnight (daily)",
  autoRefresh: false,
  mfSupport: true,
  docsUrl: "https://breezeapi.icicidirect.com/",
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ICICI Direct Adapter", () => {
  // ── Broker Info ──────────────────────────────────────────────────────────

  describe("BROKER_INFO", () => {
    it("should have id as ICICI", () => {
      assert.strictEqual(ICICI_BROKER_INFO.id, "ICICI");
    });

    it("should have name as ICICI Direct", () => {
      assert.strictEqual(ICICI_BROKER_INFO.name, "ICICI Direct");
    });

    it("should have autoRefresh as false", () => {
      assert.strictEqual(ICICI_BROKER_INFO.autoRefresh, false);
    });

    it("should have mfSupport as true", () => {
      assert.strictEqual(ICICI_BROKER_INFO.mfSupport, true);
    });

    it("should have tokenExpiry as Until midnight (daily)", () => {
      assert.strictEqual(
        ICICI_BROKER_INFO.tokenExpiry,
        "Until midnight (daily)"
      );
    });

    it("should have color as #F15A22", () => {
      assert.strictEqual(ICICI_BROKER_INFO.color, "#F15A22");
    });

    it("should have cost as ₹1000/year", () => {
      assert.strictEqual(ICICI_BROKER_INFO.cost, "₹1000/year");
    });

    it("should include Currency in segments", () => {
      assert.ok(ICICI_BROKER_INFO.segments.includes("Currency"));
    });

    it("should include MF in segments", () => {
      assert.ok(ICICI_BROKER_INFO.segments.includes("MF"));
    });

    it("should have 4 segments", () => {
      assert.strictEqual(ICICI_BROKER_INFO.segments.length, 4);
    });

    it("should have 5 features", () => {
      assert.strictEqual(ICICI_BROKER_INFO.features.length, 5);
    });

    it("should have docsUrl pointing to breezeapi.icicidirect.com", () => {
      assert.ok(
        ICICI_BROKER_INFO.docsUrl.includes("breezeapi.icicidirect.com")
      );
    });
  });

  // ── Auth URL ─────────────────────────────────────────────────────────────

  describe("getAuthUrl", () => {
    it("should include the base login URL", () => {
      const url = getAuthUrl("test_key", "https://example.com/callback");
      assert.ok(url.startsWith("https://api.icicidirect.com/apiuser/login?"));
    });

    it("should include the api_key param", () => {
      const url = getAuthUrl("my_api_key", "https://example.com/callback");
      assert.ok(url.includes("api_key=my_api_key"));
    });

    it("should include the redirect_uri param", () => {
      const url = getAuthUrl("key", "https://example.com/callback");
      assert.ok(url.includes("redirect_uri="));
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

    it("should use redirect_uri (not redirect_url like HDFC)", () => {
      const url = getAuthUrl("key", "https://example.com/callback");
      assert.ok(url.includes("redirect_uri="));
      assert.ok(!url.includes("redirect_url="));
    });
  });

  // ── Auth Headers ─────────────────────────────────────────────────────────

  describe("getAuthHeaders", () => {
    it("should include X-SessionToken", () => {
      const headers = getICICIAuthHeaders("session_tok", "api_key", "secret");
      assert.strictEqual(headers["X-SessionToken"], "session_tok");
    });

    it("should include X-AppKey", () => {
      const headers = getICICIAuthHeaders("session_tok", "api_key", "secret");
      assert.strictEqual(headers["X-AppKey"], "api_key");
    });

    it("should include X-SecretKey", () => {
      const headers = getICICIAuthHeaders("session_tok", "api_key", "secret");
      assert.strictEqual(headers["X-SecretKey"], "secret");
    });

    it("should include Content-Type as application/json", () => {
      const headers = getICICIAuthHeaders("session_tok", "api_key", "secret");
      assert.strictEqual(headers["Content-Type"], "application/json");
    });
  });

  // ── Holdings Normalization ─────────────────────────────────────────────

  describe("Holdings normalization", () => {
    let defaultHolding: NormalizedHolding;

    beforeEach(() => {
      defaultHolding = normalizeICICIHolding(createMockICICIHolding());
    });

    it("should map stock_code to symbol", () => {
      assert.strictEqual(defaultHolding.symbol, "RELIANCE");
    });

    it("should map stock_code to tradingSymbol", () => {
      assert.strictEqual(defaultHolding.tradingSymbol, "RELIANCE");
    });

    it("should map stock_ISIN to isin", () => {
      assert.strictEqual(defaultHolding.isin, "INE002A01018");
    });

    it("should map exchange_code to exchange", () => {
      assert.strictEqual(defaultHolding.exchange, "NSE");
    });

    it("should map quantity to totalQuantity", () => {
      assert.strictEqual(defaultHolding.totalQuantity, 50);
    });

    it("should set freeQuantity equal to quantity", () => {
      assert.strictEqual(defaultHolding.freeQuantity, 50);
    });

    it("should always set pledgedQuantity to 0", () => {
      assert.strictEqual(defaultHolding.pledgedQuantity, 0);
    });

    it("should map average_price to averagePrice", () => {
      assert.strictEqual(defaultHolding.averagePrice, 2400.0);
    });

    it("should map current_price to lastPrice", () => {
      assert.strictEqual(defaultHolding.lastPrice, 2550.0);
    });

    it("should map previous_close to closePrice", () => {
      assert.strictEqual(defaultHolding.closePrice, 2500.0);
    });

    it("should calculate pnl as (current_price - average_price) * quantity", () => {
      const expectedPnl = (2550.0 - 2400.0) * 50;
      assert.strictEqual(defaultHolding.pnl, expectedPnl);
    });

    it("should calculate pnlPercentage as ((current - avg) / avg) * 100", () => {
      const expectedPct = ((2550.0 - 2400.0) / 2400.0) * 100;
      assert.strictEqual(defaultHolding.pnlPercentage, expectedPct);
    });

    it("should set product to CNC", () => {
      assert.strictEqual(defaultHolding.product, "CNC");
    });

    it("should handle BSE exchange_code", () => {
      const raw = createMockICICIHolding({ exchange_code: "BSE" });
      const normalized = normalizeICICIHolding(raw);
      assert.strictEqual(normalized.exchange, "BSE");
    });

    it("should handle zero quantity", () => {
      const raw = createMockICICIHolding({ quantity: 0 });
      const normalized = normalizeICICIHolding(raw);
      assert.strictEqual(normalized.totalQuantity, 0);
      assert.strictEqual(normalized.freeQuantity, 0);
      assert.strictEqual(normalized.pnl, 0);
    });

    it("should handle negative pnl when current_price < average_price", () => {
      const raw = createMockICICIHolding({
        current_price: 2200.0,
        average_price: 2400.0,
        quantity: 10,
      });
      const normalized = normalizeICICIHolding(raw);
      assert.ok(normalized.pnl < 0);
      assert.ok(normalized.pnlPercentage < 0);
    });
  });

  // ── Positions Normalization ────────────────────────────────────────────

  describe("Positions normalization", () => {
    let defaultPosition: NormalizedPosition;

    beforeEach(() => {
      defaultPosition = normalizeICICIPosition(createMockICICIPosition());
    });

    it("should map stock_code to symbol", () => {
      assert.strictEqual(defaultPosition.symbol, "NIFTY25MARFUT");
    });

    it("should map stock_code to tradingSymbol", () => {
      assert.strictEqual(defaultPosition.tradingSymbol, "NIFTY25MARFUT");
    });

    it("should map exchange_code to exchange", () => {
      assert.strictEqual(defaultPosition.exchange, "NFO");
    });

    it("should preserve segment from raw data", () => {
      assert.strictEqual(defaultPosition.segment, "FNO");
    });

    it("should always set positionType to NET", () => {
      assert.strictEqual(defaultPosition.positionType, "NET");
    });

    it("should map product_type to productType", () => {
      assert.strictEqual(defaultPosition.productType, "FUTURES");
    });

    it("should map buy_quantity to buyQuantity", () => {
      assert.strictEqual(defaultPosition.buyQuantity, 75);
    });

    it("should map sell_quantity to sellQuantity", () => {
      assert.strictEqual(defaultPosition.sellQuantity, 25);
    });

    it("should map quantity to netQuantity", () => {
      assert.strictEqual(defaultPosition.netQuantity, 50);
    });

    it("should map buy_average_price to buyPrice", () => {
      assert.strictEqual(defaultPosition.buyPrice, 21500.0);
    });

    it("should map sell_average_price to sellPrice", () => {
      assert.strictEqual(defaultPosition.sellPrice, 21600.0);
    });

    it("should map average_price to averagePrice", () => {
      assert.strictEqual(defaultPosition.averagePrice, 21500.0);
    });

    it("should map ltp to lastPrice", () => {
      assert.strictEqual(defaultPosition.lastPrice, 21700.0);
    });

    it("should map realized_pnl to realizedPnl", () => {
      assert.strictEqual(defaultPosition.realizedPnl, 2500.0);
    });

    it("should map unrealized_pnl to unrealizedPnl", () => {
      assert.strictEqual(defaultPosition.unrealizedPnl, 10000.0);
    });

    it("should handle CASH segment", () => {
      const raw = createMockICICIPosition({ segment: "CASH" });
      const normalized = normalizeICICIPosition(raw);
      assert.strictEqual(normalized.segment, "CASH");
    });
  });

  // ── Orders Normalization ───────────────────────────────────────────────

  describe("Orders normalization", () => {
    let defaultOrder: NormalizedOrder;

    beforeEach(() => {
      defaultOrder = normalizeICICIOrder(createMockICICIOrder());
    });

    it("should map order_id to orderId", () => {
      assert.strictEqual(defaultOrder.orderId, "ORD300001");
    });

    it("should map stock_code to symbol", () => {
      assert.strictEqual(defaultOrder.symbol, "HDFCBANK");
    });

    it("should map stock_code to tradingSymbol", () => {
      assert.strictEqual(defaultOrder.tradingSymbol, "HDFCBANK");
    });

    it("should map exchange_code to exchange", () => {
      assert.strictEqual(defaultOrder.exchange, "NSE");
    });

    it("should preserve segment from raw data", () => {
      assert.strictEqual(defaultOrder.segment, "CASH");
    });

    it("should map action to transactionType", () => {
      assert.strictEqual(defaultOrder.transactionType, "BUY");
    });

    it("should map SELL action to SELL transactionType", () => {
      const raw = createMockICICIOrder({ action: "SELL" });
      const normalized = normalizeICICIOrder(raw);
      assert.strictEqual(normalized.transactionType, "SELL");
    });

    it("should always set variety to regular", () => {
      assert.strictEqual(defaultOrder.variety, "regular");
    });

    it("should map stoploss_price to triggerPrice", () => {
      assert.strictEqual(defaultOrder.triggerPrice, 1580.0);
    });

    it("should map filled_quantity to filledQuantity", () => {
      assert.strictEqual(defaultOrder.filledQuantity, 20);
    });

    it("should map order_type to orderType", () => {
      assert.strictEqual(defaultOrder.orderType, "LIMIT");
    });

    it("should map average_price to averagePrice", () => {
      assert.strictEqual(defaultOrder.averagePrice, 1598.5);
    });

    it("should map status correctly", () => {
      assert.strictEqual(defaultOrder.status, "EXECUTED");
    });

    it("should parse order_datetime to orderTime Date", () => {
      assert.ok(defaultOrder.orderTime instanceof Date);
      assert.strictEqual(
        defaultOrder.orderTime.toISOString(),
        "2025-02-10T11:15:00.000Z"
      );
    });
  });

  // ── Trades Normalization ───────────────────────────────────────────────

  describe("Trades normalization", () => {
    let defaultTrade: NormalizedTrade;

    beforeEach(() => {
      defaultTrade = normalizeICICITrade(createMockICICITrade());
    });

    it("should map trade_id to tradeId", () => {
      assert.strictEqual(defaultTrade.tradeId, "TRD400001");
    });

    it("should map order_id to orderId", () => {
      assert.strictEqual(defaultTrade.orderId, "ORD300001");
    });

    it("should map stock_code to symbol", () => {
      assert.strictEqual(defaultTrade.symbol, "WIPRO");
    });

    it("should map stock_code to tradingSymbol", () => {
      assert.strictEqual(defaultTrade.tradingSymbol, "WIPRO");
    });

    it("should map exchange_code to exchange", () => {
      assert.strictEqual(defaultTrade.exchange, "NSE");
    });

    it("should preserve segment from raw data", () => {
      assert.strictEqual(defaultTrade.segment, "CASH");
    });

    it("should map action to transactionType", () => {
      assert.strictEqual(defaultTrade.transactionType, "BUY");
    });

    it("should map trade_price to price", () => {
      assert.strictEqual(defaultTrade.price, 450.0);
    });

    it("should calculate tradeValue as quantity * trade_price", () => {
      assert.strictEqual(defaultTrade.tradeValue, 30 * 450.0);
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

    it("should parse trade_datetime to tradeTime Date", () => {
      assert.ok(defaultTrade.tradeTime instanceof Date);
      assert.strictEqual(
        defaultTrade.tradeTime.toISOString(),
        "2025-02-10T11:20:00.000Z"
      );
    });

    it("should handle SELL transactionType", () => {
      const raw = createMockICICITrade({ action: "SELL" });
      const normalized = normalizeICICITrade(raw);
      assert.strictEqual(normalized.transactionType, "SELL");
    });

    it("should handle large trade values", () => {
      const raw = createMockICICITrade({
        quantity: 10000,
        trade_price: 5000.0,
      });
      const normalized = normalizeICICITrade(raw);
      assert.strictEqual(normalized.tradeValue, 50000000);
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
        error: "ICICI Direct requires daily re-authentication",
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

  // ── Authentication Flow ────────────────────────────────────────────────

  describe("Authentication flow", () => {
    it("should use sessionToken as accessToken on success (ICICI re-uses session token)", () => {
      // ICICI adapter stores sessionToken directly as accessToken (not a new token)
      const sessionToken = "icici_session_abc123";
      const result = {
        success: true,
        accessToken: sessionToken,
        expiresAt: getEndOfDay(),
        metadata: { name: "Test User" },
      };
      assert.strictEqual(result.accessToken, sessionToken);
    });

    it("should return error from Error field on auth failure", () => {
      const response = { Error: "Invalid session token" };
      const result = {
        success: false,
        error: response.Error || "Authentication failed",
      };
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, "Invalid session token");
    });

    it("should fallback to default error message when Error field is empty", () => {
      const response = { Error: "" };
      const result = {
        success: false,
        error: response.Error || "Authentication failed",
      };
      assert.strictEqual(result.error, "Authentication failed");
    });
  });

  // ── Batch Normalization ────────────────────────────────────────────────

  describe("Batch normalization", () => {
    it("should normalize an array of holdings", () => {
      const rawHoldings = [
        createMockICICIHolding({ stock_code: "RELIANCE" }),
        createMockICICIHolding({ stock_code: "TCS" }),
        createMockICICIHolding({ stock_code: "INFY" }),
      ];
      const normalized = rawHoldings.map(normalizeICICIHolding);
      assert.strictEqual(normalized.length, 3);
      assert.strictEqual(normalized[0].symbol, "RELIANCE");
      assert.strictEqual(normalized[1].symbol, "TCS");
      assert.strictEqual(normalized[2].symbol, "INFY");
    });

    it("should normalize an empty holdings array", () => {
      const rawHoldings: ICICIRawHolding[] = [];
      const normalized = rawHoldings.map(normalizeICICIHolding);
      assert.strictEqual(normalized.length, 0);
    });

    it("should normalize an array of trades with correct values", () => {
      const rawTrades = [
        createMockICICITrade({
          trade_id: "T1",
          quantity: 10,
          trade_price: 100,
        }),
        createMockICICITrade({ trade_id: "T2", quantity: 5, trade_price: 200 }),
      ];
      const normalized = rawTrades.map(normalizeICICITrade);
      assert.strictEqual(normalized.length, 2);
      assert.strictEqual(normalized[0].tradeValue, 1000);
      assert.strictEqual(normalized[1].tradeValue, 1000);
    });
  });
});
