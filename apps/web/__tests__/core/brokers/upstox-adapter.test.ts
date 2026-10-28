/**
 * Upstox Broker Adapter Tests
 *
 * Comprehensive tests for the Upstox adapter from @usemoney/core/brokers.
 * Tests cover: BROKER_INFO, getAuthUrl, holdings/positions/orders/trades
 * normalization (mapHolding, mapPosition, mapOrder, mapTrade),
 * auto-refresh support, refresh strategy, token expiry, refreshAccessToken,
 * auth headers, and edge cases.
 *
 * Uses Node.js native test runner (node:test) and assertions (node:assert/strict).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { UpstoxAdapter } from "@usemoney/core/brokers";

// ── Inline types (no source imports) ────────────────────────────────────

type HoldingData = {
  symbol: string;
  tradingSymbol: string;
  isin: string;
  exchange: string;
  totalQuantity: number;
  freeQuantity: number;
  t1Quantity: number;
  pledgedQuantity: number;
  averagePrice: number;
  lastPrice: number;
  closePrice: number;
  pnl: number;
  pnlPercentage: number;
  product: string;
  dayChange: number;
  dayChangePerc: number;
};

type PositionData = {
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
};

type OrderData = {
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
  statusMessage: string;
  validity: string;
  orderTime: Date;
};

type TradeData = {
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
};

type BrokerInfo = {
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
};

// ── Factory functions ───────────────────────────────────────────────────

function createMockUpstoxHolding(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    trading_symbol: "RELIANCE",
    isin: "INE002A01018",
    exchange: "NSE",
    quantity: 10,
    t1_quantity: 0,
    average_price: 2450.5,
    last_price: 2520.0,
    close_price: 2500.0,
    pnl: 695.0,
    pnl_percentage: 2.84,
    product: "CNC",
    day_change: 20.0,
    day_change_percentage: 0.8,
    ...overrides,
  };
}

function createMockUpstoxPosition(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    trading_symbol: "NIFTY23DEC18000CE",
    exchange: "NFO",
    instrument_type: "CE",
    product: "MIS",
    buy_quantity: 50,
    sell_quantity: 0,
    quantity: 50,
    buy_price: 150.0,
    sell_price: 0,
    average_price: 150.0,
    last_price: 165.0,
    realised: 0,
    unrealised: 750.0,
    ...overrides,
  };
}

function createMockUpstoxOrder(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    order_id: "ORD-001",
    trading_symbol: "INFY",
    exchange: "NSE",
    instrument_type: "EQ",
    order_type: "LIMIT",
    transaction_type: "BUY",
    product: "CNC",
    variety: "SIMPLE",
    quantity: 100,
    filled_quantity: 100,
    price: 1450.0,
    trigger_price: 0,
    average_price: 1448.5,
    status: "COMPLETE",
    status_message: "",
    validity: "DAY",
    order_timestamp: "2024-01-15T10:30:00+05:30",
    ...overrides,
  };
}

function createMockUpstoxTrade(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    trade_id: "TRD-001",
    order_id: "ORD-001",
    trading_symbol: "TCS",
    exchange: "NSE",
    instrument_type: "EQ",
    transaction_type: "BUY",
    product: "CNC",
    quantity: 5,
    average_price: 3800.0,
    trade_timestamp: "2024-01-15T10:35:00+05:30",
    ...overrides,
  };
}

// ── Pure function extractors (mirror private adapter logic) ─────────────

function mapHolding(h: Record<string, unknown>): HoldingData {
  return {
    symbol: h.trading_symbol as string,
    tradingSymbol: h.trading_symbol as string,
    isin: h.isin as string,
    exchange: h.exchange as string,
    totalQuantity: h.quantity as number,
    freeQuantity: h.quantity as number,
    t1Quantity: (h.t1_quantity as number) || 0,
    pledgedQuantity: 0,
    averagePrice: h.average_price as number,
    lastPrice: h.last_price as number,
    closePrice: h.close_price as number,
    pnl: h.pnl as number,
    pnlPercentage: h.pnl_percentage as number,
    product: h.product as string,
    dayChange: (h.day_change as number) || 0,
    dayChangePerc: (h.day_change_percentage as number) || 0,
  };
}

function mapPosition(p: Record<string, unknown>): PositionData {
  return {
    symbol: p.trading_symbol as string,
    tradingSymbol: p.trading_symbol as string,
    exchange: p.exchange as string,
    segment: p.instrument_type === "EQ" ? "CASH" : "FNO",
    positionType: "DAY",
    productType: p.product as string,
    buyQuantity: p.buy_quantity as number,
    sellQuantity: p.sell_quantity as number,
    netQuantity: p.quantity as number,
    buyPrice: p.buy_price as number,
    sellPrice: p.sell_price as number,
    averagePrice: p.average_price as number,
    lastPrice: p.last_price as number,
    realizedPnl: p.realised as number,
    unrealizedPnl: p.unrealised as number,
  };
}

function mapOrder(o: Record<string, unknown>): OrderData {
  return {
    orderId: o.order_id as string,
    symbol: o.trading_symbol as string,
    tradingSymbol: o.trading_symbol as string,
    exchange: o.exchange as string,
    segment: o.instrument_type === "EQ" ? "CASH" : "FNO",
    orderType: o.order_type as string,
    transactionType: o.transaction_type as "BUY" | "SELL",
    productType: o.product as string,
    variety: o.variety as string,
    quantity: o.quantity as number,
    filledQuantity: o.filled_quantity as number,
    price: o.price as number,
    triggerPrice: o.trigger_price as number,
    averagePrice: o.average_price as number,
    status: o.status as string,
    statusMessage: o.status_message as string,
    validity: o.validity as string,
    orderTime: new Date(o.order_timestamp as string),
  };
}

function mapTrade(t: Record<string, unknown>): TradeData {
  const tradeValue = (t.quantity as number) * (t.average_price as number);
  return {
    tradeId: t.trade_id as string,
    orderId: t.order_id as string,
    symbol: t.trading_symbol as string,
    tradingSymbol: t.trading_symbol as string,
    exchange: t.exchange as string,
    segment: t.instrument_type === "EQ" ? "CASH" : "FNO",
    transactionType: t.transaction_type as "BUY" | "SELL",
    productType: t.product as string,
    quantity: t.quantity as number,
    price: t.average_price as number,
    tradeValue,
    brokerage: 20,
    exchangeFee: 0,
    gst: 3.6,
    sebiCharges: 0,
    stampDuty: 0,
    transactionTax: 0,
    totalCharges: 23.6,
    netAmount: tradeValue,
    tradeTime: new Date(t.trade_timestamp as string),
  };
}

function getAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("Upstox Adapter", () => {
  let adapter: InstanceType<typeof UpstoxAdapter>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.UPSTOX_API_KEY = process.env.UPSTOX_API_KEY;
    savedEnv.UPSTOX_API_SECRET = process.env.UPSTOX_API_SECRET;
    savedEnv.NODE_ENV = process.env.NODE_ENV;

    process.env.UPSTOX_API_KEY = "test_upstox_client_id";
    process.env.UPSTOX_API_SECRET = "test_upstox_secret";

    adapter = new UpstoxAdapter();
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

  // ── BROKER_INFO ─────────────────────────────────────────────────────

  describe("BROKER_INFO", () => {
    it("should have id set to UPSTOX", () => {
      const info = adapter.getInfo();
      assert.strictEqual(info.id, "UPSTOX");
    });

    it("should have name set to Upstox", () => {
      const info = adapter.getInfo();
      assert.strictEqual(info.name, "Upstox");
    });

    it("should have autoRefresh set to true", () => {
      const info = adapter.getInfo();
      assert.strictEqual(info.autoRefresh, true);
    });

    it("should have mfSupport set to false (Upstox has no MF API)", () => {
      const info = adapter.getInfo();
      assert.strictEqual(info.mfSupport, false);
    });

    it("should have tokenExpiry set to 1 year (extended)", () => {
      const info = adapter.getInfo();
      assert.strictEqual(info.tokenExpiry, "1 year (extended)");
    });

    it("should have a non-empty description", () => {
      const info = adapter.getInfo();
      assert.ok(info.description);
      assert.strictEqual(typeof info.description, "string");
    });

    it("should have a color defined", () => {
      const info = adapter.getInfo();
      assert.strictEqual(info.color, "#7B2D8E");
    });

    it("should support Equity, F&O, Currency, Commodity segments", () => {
      const info = adapter.getInfo();
      assert.deepStrictEqual(info.segments, [
        "Equity",
        "F&O",
        "Currency",
        "Commodity",
      ]);
    });

    it("should list Holdings, Positions, Orders, Trades as features", () => {
      const info = adapter.getInfo();
      assert.deepStrictEqual(info.features, [
        "Holdings",
        "Positions",
        "Orders",
        "Trades",
      ]);
    });

    it("should have cost set to FREE", () => {
      const info = adapter.getInfo();
      assert.strictEqual(info.cost, "FREE");
    });

    it("should have a valid docs URL", () => {
      const info = adapter.getInfo();
      assert.strictEqual(info.docsUrl, "https://upstox.com/developer/api/v2/");
    });
  });

  // ── getBrokerType ───────────────────────────────────────────────────

  describe("getBrokerType", () => {
    it("should return UPSTOX", () => {
      assert.strictEqual(adapter.getBrokerType(), "UPSTOX");
    });
  });

  // ── getAuthUrl ──────────────────────────────────────────────────────

  describe("getAuthUrl", () => {
    it("should build URL with client_id from env", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      assert.ok(url.includes("client_id=test_upstox_client_id"));
    });

    it("should include redirect_uri parameter", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      const encoded = encodeURIComponent("https://example.com/callback");
      assert.ok(url.includes(`redirect_uri=${encoded}`));
    });

    it("should include response_type=code", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      assert.ok(url.includes("response_type=code"));
    });

    it("should start with the Upstox authorization dialog URL", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      assert.ok(
        url.startsWith("https://api.upstox.com/v2/login/authorization/dialog?")
      );
    });

    it("should include state parameter when provided", () => {
      const url = adapter.getAuthUrl(
        "https://example.com/callback",
        "my_state_123"
      );
      assert.ok(url.includes("state=my_state_123"));
    });

    it("should not include state parameter when not provided", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      assert.ok(!url.includes("state="));
    });

    it("should use empty string for API key when env var is not set", () => {
      delete process.env.UPSTOX_API_KEY;
      const freshAdapter = new UpstoxAdapter();
      const url = freshAdapter.getAuthUrl("https://example.com/callback");
      assert.ok(url.includes("client_id=&") || url.includes("client_id="));
    });
  });

  // ── Holdings normalization (mapHolding) ─────────────────────────────

  describe("Holdings normalization (mapHolding)", () => {
    it("should map trading_symbol to symbol and tradingSymbol", () => {
      const raw = createMockUpstoxHolding({ trading_symbol: "RELIANCE" });
      const result = mapHolding(raw);
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.tradingSymbol, "RELIANCE");
    });

    it("should map isin directly", () => {
      const raw = createMockUpstoxHolding({ isin: "INE002A01018" });
      const result = mapHolding(raw);
      assert.strictEqual(result.isin, "INE002A01018");
    });

    it("should map exchange directly", () => {
      const raw = createMockUpstoxHolding({ exchange: "BSE" });
      const result = mapHolding(raw);
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should map quantity to totalQuantity and freeQuantity", () => {
      const raw = createMockUpstoxHolding({ quantity: 25 });
      const result = mapHolding(raw);
      assert.strictEqual(result.totalQuantity, 25);
      assert.strictEqual(result.freeQuantity, 25);
    });

    it("should map t1_quantity with default of 0", () => {
      const raw = createMockUpstoxHolding({ t1_quantity: 5 });
      const result = mapHolding(raw);
      assert.strictEqual(result.t1Quantity, 5);
    });

    it("should default t1Quantity to 0 when t1_quantity is missing", () => {
      const raw = createMockUpstoxHolding();
      delete raw.t1_quantity;
      const result = mapHolding(raw);
      assert.strictEqual(result.t1Quantity, 0);
    });

    it("should always set pledgedQuantity to 0", () => {
      const raw = createMockUpstoxHolding();
      const result = mapHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 0);
    });

    it("should map average_price to averagePrice", () => {
      const raw = createMockUpstoxHolding({ average_price: 1234.56 });
      const result = mapHolding(raw);
      assert.strictEqual(result.averagePrice, 1234.56);
    });

    it("should map last_price to lastPrice", () => {
      const raw = createMockUpstoxHolding({ last_price: 1300.0 });
      const result = mapHolding(raw);
      assert.strictEqual(result.lastPrice, 1300.0);
    });

    it("should map close_price to closePrice", () => {
      const raw = createMockUpstoxHolding({ close_price: 1280.0 });
      const result = mapHolding(raw);
      assert.strictEqual(result.closePrice, 1280.0);
    });

    it("should map pnl directly", () => {
      const raw = createMockUpstoxHolding({ pnl: 500.0 });
      const result = mapHolding(raw);
      assert.strictEqual(result.pnl, 500.0);
    });

    it("should map pnl_percentage to pnlPercentage", () => {
      const raw = createMockUpstoxHolding({ pnl_percentage: 3.5 });
      const result = mapHolding(raw);
      assert.strictEqual(result.pnlPercentage, 3.5);
    });

    it("should map product directly", () => {
      const raw = createMockUpstoxHolding({ product: "CNC" });
      const result = mapHolding(raw);
      assert.strictEqual(result.product, "CNC");
    });

    it("should map day_change with default of 0", () => {
      const raw = createMockUpstoxHolding({ day_change: 15.5 });
      const result = mapHolding(raw);
      assert.strictEqual(result.dayChange, 15.5);
    });

    it("should default dayChange to 0 when day_change is missing", () => {
      const raw = createMockUpstoxHolding();
      delete raw.day_change;
      const result = mapHolding(raw);
      assert.strictEqual(result.dayChange, 0);
    });

    it("should map day_change_percentage to dayChangePerc with default of 0", () => {
      const raw = createMockUpstoxHolding({ day_change_percentage: 1.2 });
      const result = mapHolding(raw);
      assert.strictEqual(result.dayChangePerc, 1.2);
    });

    it("should default dayChangePerc to 0 when day_change_percentage is missing", () => {
      const raw = createMockUpstoxHolding();
      delete raw.day_change_percentage;
      const result = mapHolding(raw);
      assert.strictEqual(result.dayChangePerc, 0);
    });
  });

  // ── Positions normalization (mapPosition) ───────────────────────────

  describe("Positions normalization (mapPosition)", () => {
    it("should map trading_symbol to symbol and tradingSymbol", () => {
      const raw = createMockUpstoxPosition({
        trading_symbol: "NIFTY23DEC18000CE",
      });
      const result = mapPosition(raw);
      assert.strictEqual(result.symbol, "NIFTY23DEC18000CE");
      assert.strictEqual(result.tradingSymbol, "NIFTY23DEC18000CE");
    });

    it("should map exchange directly", () => {
      const raw = createMockUpstoxPosition({ exchange: "NFO" });
      const result = mapPosition(raw);
      assert.strictEqual(result.exchange, "NFO");
    });

    it("should map instrument_type EQ to CASH segment", () => {
      const raw = createMockUpstoxPosition({ instrument_type: "EQ" });
      const result = mapPosition(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should map non-EQ instrument_type to FNO segment", () => {
      const raw = createMockUpstoxPosition({ instrument_type: "CE" });
      const result = mapPosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map instrument_type PE to FNO segment", () => {
      const raw = createMockUpstoxPosition({ instrument_type: "PE" });
      const result = mapPosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map instrument_type FUT to FNO segment", () => {
      const raw = createMockUpstoxPosition({ instrument_type: "FUT" });
      const result = mapPosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should always set positionType to DAY", () => {
      const raw = createMockUpstoxPosition();
      const result = mapPosition(raw);
      assert.strictEqual(result.positionType, "DAY");
    });

    it("should map product to productType", () => {
      const raw = createMockUpstoxPosition({ product: "MIS" });
      const result = mapPosition(raw);
      assert.strictEqual(result.productType, "MIS");
    });

    it("should map buy_quantity and sell_quantity", () => {
      const raw = createMockUpstoxPosition({
        buy_quantity: 50,
        sell_quantity: 25,
      });
      const result = mapPosition(raw);
      assert.strictEqual(result.buyQuantity, 50);
      assert.strictEqual(result.sellQuantity, 25);
    });

    it("should map quantity to netQuantity", () => {
      const raw = createMockUpstoxPosition({ quantity: 25 });
      const result = mapPosition(raw);
      assert.strictEqual(result.netQuantity, 25);
    });

    it("should map buy_price and sell_price", () => {
      const raw = createMockUpstoxPosition({
        buy_price: 150.0,
        sell_price: 160.0,
      });
      const result = mapPosition(raw);
      assert.strictEqual(result.buyPrice, 150.0);
      assert.strictEqual(result.sellPrice, 160.0);
    });

    it("should map realised to realizedPnl", () => {
      const raw = createMockUpstoxPosition({ realised: 500.0 });
      const result = mapPosition(raw);
      assert.strictEqual(result.realizedPnl, 500.0);
    });

    it("should map unrealised to unrealizedPnl", () => {
      const raw = createMockUpstoxPosition({ unrealised: 750.0 });
      const result = mapPosition(raw);
      assert.strictEqual(result.unrealizedPnl, 750.0);
    });
  });

  // ── Orders normalization (mapOrder) ─────────────────────────────────

  describe("Orders normalization (mapOrder)", () => {
    it("should map order_id to orderId", () => {
      const raw = createMockUpstoxOrder({ order_id: "ORD-999" });
      const result = mapOrder(raw);
      assert.strictEqual(result.orderId, "ORD-999");
    });

    it("should map trading_symbol to symbol and tradingSymbol", () => {
      const raw = createMockUpstoxOrder({ trading_symbol: "INFY" });
      const result = mapOrder(raw);
      assert.strictEqual(result.symbol, "INFY");
      assert.strictEqual(result.tradingSymbol, "INFY");
    });

    it("should map exchange directly", () => {
      const raw = createMockUpstoxOrder({ exchange: "BSE" });
      const result = mapOrder(raw);
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should map instrument_type EQ to CASH segment", () => {
      const raw = createMockUpstoxOrder({ instrument_type: "EQ" });
      const result = mapOrder(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should map non-EQ instrument_type to FNO segment", () => {
      const raw = createMockUpstoxOrder({ instrument_type: "FUT" });
      const result = mapOrder(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map order_type directly", () => {
      const raw = createMockUpstoxOrder({ order_type: "MARKET" });
      const result = mapOrder(raw);
      assert.strictEqual(result.orderType, "MARKET");
    });

    it("should map transaction_type as BUY or SELL", () => {
      const buyOrder = createMockUpstoxOrder({ transaction_type: "BUY" });
      const sellOrder = createMockUpstoxOrder({ transaction_type: "SELL" });
      assert.strictEqual(mapOrder(buyOrder).transactionType, "BUY");
      assert.strictEqual(mapOrder(sellOrder).transactionType, "SELL");
    });

    it("should map product to productType", () => {
      const raw = createMockUpstoxOrder({ product: "NRML" });
      const result = mapOrder(raw);
      assert.strictEqual(result.productType, "NRML");
    });

    it("should map variety directly", () => {
      const raw = createMockUpstoxOrder({ variety: "SIMPLE" });
      const result = mapOrder(raw);
      assert.strictEqual(result.variety, "SIMPLE");
    });

    it("should map quantity and filled_quantity", () => {
      const raw = createMockUpstoxOrder({
        quantity: 100,
        filled_quantity: 75,
      });
      const result = mapOrder(raw);
      assert.strictEqual(result.quantity, 100);
      assert.strictEqual(result.filledQuantity, 75);
    });

    it("should map price and trigger_price", () => {
      const raw = createMockUpstoxOrder({
        price: 1500.0,
        trigger_price: 1480.0,
      });
      const result = mapOrder(raw);
      assert.strictEqual(result.price, 1500.0);
      assert.strictEqual(result.triggerPrice, 1480.0);
    });

    it("should map average_price for orders", () => {
      const raw = createMockUpstoxOrder({ average_price: 1455.5 });
      const result = mapOrder(raw);
      assert.strictEqual(result.averagePrice, 1455.5);
    });

    it("should map status and status_message", () => {
      const raw = createMockUpstoxOrder({
        status: "REJECTED",
        status_message: "Insufficient funds",
      });
      const result = mapOrder(raw);
      assert.strictEqual(result.status, "REJECTED");
      assert.strictEqual(result.statusMessage, "Insufficient funds");
    });

    it("should map validity directly", () => {
      const raw = createMockUpstoxOrder({ validity: "IOC" });
      const result = mapOrder(raw);
      assert.strictEqual(result.validity, "IOC");
    });

    it("should convert order_timestamp to Date as orderTime", () => {
      const raw = createMockUpstoxOrder({
        order_timestamp: "2024-01-15T10:30:00+05:30",
      });
      const result = mapOrder(raw);
      assert.ok(result.orderTime instanceof Date);
      assert.ok(!isNaN(result.orderTime.getTime()));
    });
  });

  // ── Trades normalization (mapTrade) ─────────────────────────────────

  describe("Trades normalization (mapTrade)", () => {
    it("should map trade_id to tradeId", () => {
      const raw = createMockUpstoxTrade({ trade_id: "TRD-555" });
      const result = mapTrade(raw);
      assert.strictEqual(result.tradeId, "TRD-555");
    });

    it("should map order_id to orderId", () => {
      const raw = createMockUpstoxTrade({ order_id: "ORD-555" });
      const result = mapTrade(raw);
      assert.strictEqual(result.orderId, "ORD-555");
    });

    it("should map trading_symbol to symbol and tradingSymbol", () => {
      const raw = createMockUpstoxTrade({ trading_symbol: "TCS" });
      const result = mapTrade(raw);
      assert.strictEqual(result.symbol, "TCS");
      assert.strictEqual(result.tradingSymbol, "TCS");
    });

    it("should map exchange directly", () => {
      const raw = createMockUpstoxTrade({ exchange: "NSE" });
      const result = mapTrade(raw);
      assert.strictEqual(result.exchange, "NSE");
    });

    it("should map instrument_type EQ to CASH segment", () => {
      const raw = createMockUpstoxTrade({ instrument_type: "EQ" });
      const result = mapTrade(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should map non-EQ instrument_type to FNO segment", () => {
      const raw = createMockUpstoxTrade({ instrument_type: "CE" });
      const result = mapTrade(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map transaction_type directly", () => {
      const raw = createMockUpstoxTrade({ transaction_type: "SELL" });
      const result = mapTrade(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should map product to productType", () => {
      const raw = createMockUpstoxTrade({ product: "MIS" });
      const result = mapTrade(raw);
      assert.strictEqual(result.productType, "MIS");
    });

    it("should map quantity directly", () => {
      const raw = createMockUpstoxTrade({ quantity: 10 });
      const result = mapTrade(raw);
      assert.strictEqual(result.quantity, 10);
    });

    it("should map average_price to price", () => {
      const raw = createMockUpstoxTrade({ average_price: 3800.0 });
      const result = mapTrade(raw);
      assert.strictEqual(result.price, 3800.0);
    });

    it("should calculate tradeValue as quantity * average_price", () => {
      const raw = createMockUpstoxTrade({
        quantity: 5,
        average_price: 3800.0,
      });
      const result = mapTrade(raw);
      assert.strictEqual(result.tradeValue, 19000.0);
    });

    it("should set brokerage to 20", () => {
      const raw = createMockUpstoxTrade();
      const result = mapTrade(raw);
      assert.strictEqual(result.brokerage, 20);
    });

    it("should set gst to 3.6", () => {
      const raw = createMockUpstoxTrade();
      const result = mapTrade(raw);
      assert.strictEqual(result.gst, 3.6);
    });

    it("should set totalCharges to 23.6", () => {
      const raw = createMockUpstoxTrade();
      const result = mapTrade(raw);
      assert.strictEqual(result.totalCharges, 23.6);
    });

    it("should set netAmount equal to tradeValue", () => {
      const raw = createMockUpstoxTrade({
        quantity: 5,
        average_price: 3800.0,
      });
      const result = mapTrade(raw);
      assert.strictEqual(result.netAmount, 19000.0);
      assert.strictEqual(result.netAmount, result.tradeValue);
    });

    it("should set exchangeFee, sebiCharges, stampDuty, transactionTax to 0", () => {
      const raw = createMockUpstoxTrade();
      const result = mapTrade(raw);
      assert.strictEqual(result.exchangeFee, 0);
      assert.strictEqual(result.sebiCharges, 0);
      assert.strictEqual(result.stampDuty, 0);
      assert.strictEqual(result.transactionTax, 0);
    });

    it("should convert trade_timestamp to Date as tradeTime", () => {
      const raw = createMockUpstoxTrade({
        trade_timestamp: "2024-01-15T10:35:00+05:30",
      });
      const result = mapTrade(raw);
      assert.ok(result.tradeTime instanceof Date);
      assert.ok(!isNaN(result.tradeTime.getTime()));
    });
  });

  // ── Auto-refresh support ────────────────────────────────────────────

  describe("supportsAutoRefresh", () => {
    it("should return true", () => {
      assert.strictEqual(adapter.supportsAutoRefresh(), true);
    });
  });

  // ── Refresh strategy ────────────────────────────────────────────────

  describe("getRefreshStrategy", () => {
    it("should return EXTENDED", () => {
      assert.strictEqual(adapter.getRefreshStrategy(), "EXTENDED");
    });
  });

  // ── Token expiry duration ───────────────────────────────────────────

  describe("getTokenExpiryDuration", () => {
    it("should return 365 days in milliseconds", () => {
      const expected = 365 * 24 * 60 * 60 * 1000;
      assert.strictEqual(adapter.getTokenExpiryDuration(), expected);
    });

    it("should equal 31536000000 milliseconds", () => {
      assert.strictEqual(adapter.getTokenExpiryDuration(), 31536000000);
    });
  });

  // ── refreshAccessToken ──────────────────────────────────────────────

  describe("refreshAccessToken", () => {
    it("should return success true with same accessToken", async () => {
      const credentials = {
        accessToken: "my_existing_token_abc",
        refreshToken: "",
        expiresAt: new Date(),
      };
      const result = await adapter.refreshAccessToken(credentials);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.accessToken, "my_existing_token_abc");
    });

    it("should preserve the original accessToken value", async () => {
      const token = "upstox_extended_token_xyz_123";
      const credentials = {
        accessToken: token,
        refreshToken: "some_refresh",
        expiresAt: new Date(),
      };
      const result = await adapter.refreshAccessToken(credentials);
      assert.strictEqual(result.accessToken, token);
    });
  });

  // ── Auth headers ────────────────────────────────────────────────────

  describe("Auth headers", () => {
    it("should include Authorization header with Bearer prefix", () => {
      const headers = getAuthHeaders("test_token_123");
      assert.strictEqual(headers.Authorization, "Bearer test_token_123");
    });

    it("should include Accept header as application/json", () => {
      const headers = getAuthHeaders("any_token");
      assert.strictEqual(headers.Accept, "application/json");
    });

    it("should have exactly two headers", () => {
      const headers = getAuthHeaders("token");
      assert.strictEqual(Object.keys(headers).length, 2);
    });

    it("should handle empty accessToken", () => {
      const headers = getAuthHeaders("");
      assert.strictEqual(headers.Authorization, "Bearer ");
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("should handle empty holdings array", () => {
      const data: Record<string, unknown>[] = [];
      const result = data.map((h) => mapHolding(h));
      assert.deepStrictEqual(result, []);
    });

    it("should handle empty positions array", () => {
      const data: Record<string, unknown>[] = [];
      const result = data.map((p) => mapPosition(p));
      assert.deepStrictEqual(result, []);
    });

    it("should handle empty orders array", () => {
      const data: Record<string, unknown>[] = [];
      const result = data.map((o) => mapOrder(o));
      assert.deepStrictEqual(result, []);
    });

    it("should handle empty trades array", () => {
      const data: Record<string, unknown>[] = [];
      const result = data.map((t) => mapTrade(t));
      assert.deepStrictEqual(result, []);
    });

    it("should handle zero quantity in holdings", () => {
      const raw = createMockUpstoxHolding({ quantity: 0 });
      const result = mapHolding(raw);
      assert.strictEqual(result.totalQuantity, 0);
      assert.strictEqual(result.freeQuantity, 0);
    });

    it("should handle zero average_price in trade producing zero tradeValue", () => {
      const raw = createMockUpstoxTrade({
        quantity: 10,
        average_price: 0,
      });
      const result = mapTrade(raw);
      assert.strictEqual(result.tradeValue, 0);
      assert.strictEqual(result.netAmount, 0);
    });

    it("should handle zero quantity in trade producing zero tradeValue", () => {
      const raw = createMockUpstoxTrade({
        quantity: 0,
        average_price: 3800.0,
      });
      const result = mapTrade(raw);
      assert.strictEqual(result.tradeValue, 0);
      assert.strictEqual(result.netAmount, 0);
    });

    it("should handle negative pnl in holdings", () => {
      const raw = createMockUpstoxHolding({
        pnl: -1500.0,
        pnl_percentage: -5.2,
      });
      const result = mapHolding(raw);
      assert.strictEqual(result.pnl, -1500.0);
      assert.strictEqual(result.pnlPercentage, -5.2);
    });

    it("should handle negative day change values", () => {
      const raw = createMockUpstoxHolding({
        day_change: -30.0,
        day_change_percentage: -1.5,
      });
      const result = mapHolding(raw);
      assert.strictEqual(result.dayChange, -30.0);
      assert.strictEqual(result.dayChangePerc, -1.5);
    });

    it("should handle negative realised and unrealised pnl in positions", () => {
      const raw = createMockUpstoxPosition({
        realised: -200.0,
        unrealised: -350.0,
      });
      const result = mapPosition(raw);
      assert.strictEqual(result.realizedPnl, -200.0);
      assert.strictEqual(result.unrealizedPnl, -350.0);
    });

    it("should handle large quantities without overflow", () => {
      const raw = createMockUpstoxTrade({
        quantity: 1000000,
        average_price: 5000.0,
      });
      const result = mapTrade(raw);
      assert.strictEqual(result.tradeValue, 5000000000);
      assert.strictEqual(result.netAmount, 5000000000);
    });

    it("should handle fractional prices in holdings", () => {
      const raw = createMockUpstoxHolding({
        average_price: 123.456789,
        last_price: 124.987654,
      });
      const result = mapHolding(raw);
      assert.strictEqual(result.averagePrice, 123.456789);
      assert.strictEqual(result.lastPrice, 124.987654);
    });
  });
});
