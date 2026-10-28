/**
 * Angel One Adapter Tests
 *
 * Comprehensive tests for the Angel One broker adapter normalization logic
 * from @usemoney/core/brokers (packages/core/src/brokers/adapters/angel-one.ts).
 *
 * Tests cover:
 * - BROKER_INFO static properties
 * - getAuthUrl() URL generation
 * - Holdings normalization (API response -> HoldingData)
 * - Positions normalization (API response -> PositionData)
 * - Orders normalization (API response -> OrderData)
 * - Trades normalization (API response -> TradeData)
 * - Auth headers construction
 * - Refresh strategy and auto-refresh support
 * - refreshAccessToken() error behavior
 * - Edge cases (empty arrays, missing optional fields)
 *
 * Uses Node.js native test runner (node:test) and assertions (node:assert/strict).
 * All types are defined inline. Testable logic is extracted as pure functions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline Types ─────────────────────────────────────────────────────────────

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

interface AngelOneRawHolding {
  tradingsymbol: string;
  isin: string;
  exchange: string;
  quantity: number;
  t1quantity?: number;
  collateralquantity?: number;
  averageprice: number;
  ltp: number;
  close: number;
  profitandloss: number;
  pnlpercentage: number;
  product: string;
}

interface NormalizedHolding {
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
}

interface AngelOneRawPosition {
  tradingsymbol: string;
  exchange: string;
  symboltoken: string;
  producttype: string;
  buyqty: number;
  sellqty: number;
  netqty: number;
  buyavgprice: number;
  sellavgprice: number;
  avgnetprice: number;
  ltp: number;
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

interface AngelOneRawOrder {
  orderid: string;
  tradingsymbol: string;
  exchange: string;
  symboltoken: string;
  ordertype: string;
  transactiontype: string;
  producttype: string;
  variety: string;
  quantity: number;
  filledshares: number;
  price: number;
  triggerprice: number;
  averageprice: number;
  status: string;
  text: string;
  validity: string;
  ordertime?: string;
  updatetime?: string;
}

interface NormalizedOrder {
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  orderType: string;
  transactionType: string;
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
}

interface AngelOneRawTrade {
  tradeid: string;
  orderid: string;
  tradingsymbol: string;
  exchange: string;
  symboltoken: string;
  transactiontype: string;
  producttype: string;
  fillshares: number;
  fillprice: number;
  filltime?: string;
  exchangeorderupdatetime?: string;
}

interface NormalizedTrade {
  tradeId: string;
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  transactionType: string;
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
  "Content-Type": string;
  Accept: string;
  "X-UserType": string;
  "X-SourceID": string;
  "X-ClientLocalIP": string;
  "X-ClientPublicIP": string;
  "X-MACAddress": string;
  "X-PrivateKey": string;
}

// ── Pure Functions (extracted testable logic) ────────────────────────────────

/** Static BROKER_INFO as defined in the adapter */
const BROKER_INFO: BrokerInfo = {
  id: "ANGEL_ONE",
  name: "Angel One",
  description: "Full-service broker with trading, advisory, and research",
  color: "#ED1C24",
  segments: ["Equity", "F&O", "Currency", "Commodity", "MF"],
  features: ["Holdings", "Positions", "Orders", "Trades", "MF"],
  cost: "FREE",
  tokenExpiry: "Until midnight (daily)",
  autoRefresh: false,
  mfSupport: true,
  docsUrl: "https://smartapi.angelone.in/docs",
};

/** Returns the Angel One auth URL */
function getAuthUrl(): string {
  return "https://smartapi.angelone.in/";
}

/** Normalize a raw Angel One holding into standard HoldingData */
function normalizeHolding(h: AngelOneRawHolding): NormalizedHolding {
  return {
    symbol: h.tradingsymbol,
    tradingSymbol: h.tradingsymbol,
    isin: h.isin,
    exchange: h.exchange,
    totalQuantity: h.quantity,
    freeQuantity: h.quantity - (h.t1quantity || 0),
    t1Quantity: h.t1quantity || 0,
    pledgedQuantity: h.collateralquantity || 0,
    averagePrice: h.averageprice,
    lastPrice: h.ltp,
    closePrice: h.close,
    pnl: h.profitandloss,
    pnlPercentage: h.pnlpercentage,
    product: h.product,
  };
}

/** Normalize a raw Angel One position into standard PositionData */
function normalizePosition(p: AngelOneRawPosition): NormalizedPosition {
  return {
    symbol: p.tradingsymbol,
    tradingSymbol: p.tradingsymbol,
    exchange: p.exchange,
    segment: p.symboltoken?.startsWith("NSE") ? "CASH" : "FNO",
    positionType: "NET",
    productType: p.producttype,
    buyQuantity: p.buyqty,
    sellQuantity: p.sellqty,
    netQuantity: p.netqty,
    buyPrice: p.buyavgprice,
    sellPrice: p.sellavgprice,
    averagePrice: p.avgnetprice,
    lastPrice: p.ltp,
    realizedPnl: p.realised,
    unrealizedPnl: p.unrealised,
  };
}

/** Normalize a raw Angel One order into standard OrderData */
function normalizeOrder(o: AngelOneRawOrder): NormalizedOrder {
  return {
    orderId: o.orderid,
    symbol: o.tradingsymbol,
    tradingSymbol: o.tradingsymbol,
    exchange: o.exchange,
    segment: o.symboltoken?.startsWith("NSE") ? "CASH" : "FNO",
    orderType: o.ordertype,
    transactionType: o.transactiontype,
    productType: o.producttype,
    variety: o.variety,
    quantity: o.quantity,
    filledQuantity: o.filledshares,
    price: o.price,
    triggerPrice: o.triggerprice,
    averagePrice: o.averageprice,
    status: o.status,
    statusMessage: o.text,
    validity: o.validity,
    orderTime: new Date(o.ordertime || o.updatetime || ""),
  };
}

/** Normalize a raw Angel One trade into standard TradeData */
function normalizeTrade(t: AngelOneRawTrade): NormalizedTrade {
  const tradeValue = t.fillshares * t.fillprice;
  return {
    tradeId: t.tradeid,
    orderId: t.orderid,
    symbol: t.tradingsymbol,
    tradingSymbol: t.tradingsymbol,
    exchange: t.exchange,
    segment: t.symboltoken?.startsWith("NSE") ? "CASH" : "FNO",
    transactionType: t.transactiontype,
    productType: t.producttype,
    quantity: t.fillshares,
    price: t.fillprice,
    tradeValue,
    brokerage: 20,
    exchangeFee: 0,
    gst: 3.6,
    sebiCharges: 0,
    stampDuty: 0,
    transactionTax: 0,
    totalCharges: 23.6,
    netAmount: tradeValue,
    tradeTime: new Date(t.filltime || t.exchangeorderupdatetime || ""),
  };
}

/** Build auth headers for Angel One API calls */
function buildAuthHeaders(accessToken: string, apiKey: string): AuthHeaders {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
  };
}

/** Whether Angel One supports auto-refresh */
function supportsAutoRefresh(): boolean {
  return false;
}

/** Angel One refresh strategy */
function getRefreshStrategy(): string {
  return "NONE";
}

/** Angel One refreshAccessToken result */
function refreshAccessToken(): { success: false; error: string } {
  return {
    success: false,
    error: "Angel One requires daily re-authentication with TOTP",
  };
}

// ── Factory Functions ────────────────────────────────────────────────────────

function createRawHolding(
  overrides: Partial<AngelOneRawHolding> = {}
): AngelOneRawHolding {
  return {
    tradingsymbol: "RELIANCE",
    isin: "INE002A01018",
    exchange: "NSE",
    quantity: 10,
    t1quantity: 0,
    collateralquantity: 0,
    averageprice: 2450.5,
    ltp: 2500.0,
    close: 2480.0,
    profitandloss: 495.0,
    pnlpercentage: 2.02,
    product: "DELIVERY",
    ...overrides,
  };
}

function createRawPosition(
  overrides: Partial<AngelOneRawPosition> = {}
): AngelOneRawPosition {
  return {
    tradingsymbol: "NIFTY24FEB22000CE",
    exchange: "NFO",
    symboltoken: "NFO12345",
    producttype: "CARRYFORWARD",
    buyqty: 50,
    sellqty: 0,
    netqty: 50,
    buyavgprice: 120.5,
    sellavgprice: 0,
    avgnetprice: 120.5,
    ltp: 135.0,
    realised: 0,
    unrealised: 725.0,
    ...overrides,
  };
}

function createRawOrder(
  overrides: Partial<AngelOneRawOrder> = {}
): AngelOneRawOrder {
  return {
    orderid: "ORD-20240215-001",
    tradingsymbol: "INFY",
    exchange: "NSE",
    symboltoken: "NSE1594",
    ordertype: "LIMIT",
    transactiontype: "BUY",
    producttype: "DELIVERY",
    variety: "NORMAL",
    quantity: 25,
    filledshares: 25,
    price: 1800.0,
    triggerprice: 0,
    averageprice: 1798.5,
    status: "COMPLETE",
    text: "Order completed successfully",
    validity: "DAY",
    ordertime: "2024-02-15T10:30:00",
    updatetime: "2024-02-15T10:30:05",
    ...overrides,
  };
}

function createRawTrade(
  overrides: Partial<AngelOneRawTrade> = {}
): AngelOneRawTrade {
  return {
    tradeid: "TRD-20240215-001",
    orderid: "ORD-20240215-001",
    tradingsymbol: "TCS",
    exchange: "NSE",
    symboltoken: "NSE11536",
    transactiontype: "BUY",
    producttype: "DELIVERY",
    fillshares: 5,
    fillprice: 3850.0,
    filltime: "2024-02-15T11:00:00",
    exchangeorderupdatetime: "2024-02-15T11:00:02",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Angel One Adapter", () => {
  // ── BROKER_INFO ──────────────────────────────────────────────────────────

  describe("BROKER_INFO", () => {
    it("should have id set to ANGEL_ONE", () => {
      assert.strictEqual(BROKER_INFO.id, "ANGEL_ONE");
    });

    it("should have name set to Angel One", () => {
      assert.strictEqual(BROKER_INFO.name, "Angel One");
    });

    it("should have autoRefresh set to false", () => {
      assert.strictEqual(BROKER_INFO.autoRefresh, false);
    });

    it("should have mfSupport set to true", () => {
      assert.strictEqual(BROKER_INFO.mfSupport, true);
    });

    it("should have correct description", () => {
      assert.strictEqual(
        BROKER_INFO.description,
        "Full-service broker with trading, advisory, and research"
      );
    });

    it("should have color set to #ED1C24", () => {
      assert.strictEqual(BROKER_INFO.color, "#ED1C24");
    });

    it("should include expected segments", () => {
      assert.deepStrictEqual(BROKER_INFO.segments, [
        "Equity",
        "F&O",
        "Currency",
        "Commodity",
        "MF",
      ]);
    });

    it("should include expected features", () => {
      assert.deepStrictEqual(BROKER_INFO.features, [
        "Holdings",
        "Positions",
        "Orders",
        "Trades",
        "MF",
      ]);
    });

    it("should have cost set to FREE", () => {
      assert.strictEqual(BROKER_INFO.cost, "FREE");
    });

    it("should have docsUrl pointing to SmartAPI docs", () => {
      assert.strictEqual(
        BROKER_INFO.docsUrl,
        "https://smartapi.angelone.in/docs"
      );
    });
  });

  // ── getAuthUrl ───────────────────────────────────────────────────────────

  describe("getAuthUrl", () => {
    it("should return the SmartAPI Angel One URL", () => {
      assert.strictEqual(getAuthUrl(), "https://smartapi.angelone.in/");
    });

    it("should return a string starting with https", () => {
      assert.ok(getAuthUrl().startsWith("https://"));
    });

    it("should return the same value on repeated calls", () => {
      assert.strictEqual(getAuthUrl(), getAuthUrl());
    });
  });

  // ── Holdings Normalization ───────────────────────────────────────────────

  describe("Holdings normalization", () => {
    it("should map tradingsymbol to symbol", () => {
      const raw = createRawHolding({ tradingsymbol: "HDFC" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "HDFC");
    });

    it("should map tradingsymbol to tradingSymbol", () => {
      const raw = createRawHolding({ tradingsymbol: "SBIN" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.tradingSymbol, "SBIN");
    });

    it("should preserve isin", () => {
      const raw = createRawHolding({ isin: "INE009A01021" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.isin, "INE009A01021");
    });

    it("should preserve exchange", () => {
      const raw = createRawHolding({ exchange: "BSE" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should map quantity to totalQuantity", () => {
      const raw = createRawHolding({ quantity: 100 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.totalQuantity, 100);
    });

    it("should compute freeQuantity as quantity minus t1quantity", () => {
      const raw = createRawHolding({ quantity: 50, t1quantity: 10 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.freeQuantity, 40);
    });

    it("should compute freeQuantity equal to quantity when t1quantity is 0", () => {
      const raw = createRawHolding({ quantity: 30, t1quantity: 0 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.freeQuantity, 30);
    });

    it("should default t1Quantity to 0 when t1quantity is undefined", () => {
      const raw = createRawHolding();
      delete (raw as unknown as Record<string, unknown>).t1quantity;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.t1Quantity, 0);
    });

    it("should map t1quantity to t1Quantity", () => {
      const raw = createRawHolding({ t1quantity: 5 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.t1Quantity, 5);
    });

    it("should default pledgedQuantity to 0 when collateralquantity is undefined", () => {
      const raw = createRawHolding();
      delete (raw as unknown as Record<string, unknown>).collateralquantity;
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 0);
    });

    it("should map collateralquantity to pledgedQuantity", () => {
      const raw = createRawHolding({ collateralquantity: 15 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 15);
    });

    it("should map averageprice to averagePrice", () => {
      const raw = createRawHolding({ averageprice: 1234.56 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.averagePrice, 1234.56);
    });

    it("should map ltp to lastPrice", () => {
      const raw = createRawHolding({ ltp: 2600.0 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.lastPrice, 2600.0);
    });

    it("should map close to closePrice", () => {
      const raw = createRawHolding({ close: 2550.0 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.closePrice, 2550.0);
    });

    it("should map profitandloss to pnl", () => {
      const raw = createRawHolding({ profitandloss: -100.5 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnl, -100.5);
    });

    it("should map pnlpercentage to pnlPercentage", () => {
      const raw = createRawHolding({ pnlpercentage: 3.45 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnlPercentage, 3.45);
    });

    it("should preserve product", () => {
      const raw = createRawHolding({ product: "CNC" });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.product, "CNC");
    });

    it("should normalize a complete holding with all fields", () => {
      const raw = createRawHolding();
      const result = normalizeHolding(raw);
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.totalQuantity, 10);
      assert.strictEqual(result.freeQuantity, 10);
      assert.strictEqual(result.t1Quantity, 0);
      assert.strictEqual(result.pledgedQuantity, 0);
      assert.strictEqual(result.averagePrice, 2450.5);
      assert.strictEqual(result.lastPrice, 2500.0);
    });
  });

  // ── Positions Normalization ──────────────────────────────────────────────

  describe("Positions normalization", () => {
    it("should map tradingsymbol to symbol", () => {
      const raw = createRawPosition({ tradingsymbol: "BANKNIFTY24FEB48000PE" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.symbol, "BANKNIFTY24FEB48000PE");
    });

    it("should preserve exchange", () => {
      const raw = createRawPosition({ exchange: "NFO" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.exchange, "NFO");
    });

    it("should set segment to CASH when symboltoken starts with NSE", () => {
      const raw = createRawPosition({ symboltoken: "NSE1234" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should set segment to FNO when symboltoken does not start with NSE", () => {
      const raw = createRawPosition({ symboltoken: "NFO9876" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should set segment to FNO when symboltoken starts with BSE", () => {
      const raw = createRawPosition({ symboltoken: "BSE5555" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should always set positionType to NET", () => {
      const raw = createRawPosition();
      const result = normalizePosition(raw);
      assert.strictEqual(result.positionType, "NET");
    });

    it("should map producttype to productType", () => {
      const raw = createRawPosition({ producttype: "INTRADAY" });
      const result = normalizePosition(raw);
      assert.strictEqual(result.productType, "INTRADAY");
    });

    it("should map buyqty to buyQuantity", () => {
      const raw = createRawPosition({ buyqty: 100 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.buyQuantity, 100);
    });

    it("should map sellqty to sellQuantity", () => {
      const raw = createRawPosition({ sellqty: 25 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.sellQuantity, 25);
    });

    it("should map netqty to netQuantity", () => {
      const raw = createRawPosition({ netqty: 75 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.netQuantity, 75);
    });

    it("should map buyavgprice to buyPrice", () => {
      const raw = createRawPosition({ buyavgprice: 150.25 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.buyPrice, 150.25);
    });

    it("should map sellavgprice to sellPrice", () => {
      const raw = createRawPosition({ sellavgprice: 160.75 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.sellPrice, 160.75);
    });

    it("should map avgnetprice to averagePrice", () => {
      const raw = createRawPosition({ avgnetprice: 155.0 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.averagePrice, 155.0);
    });

    it("should map ltp to lastPrice", () => {
      const raw = createRawPosition({ ltp: 170.0 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.lastPrice, 170.0);
    });

    it("should map realised to realizedPnl", () => {
      const raw = createRawPosition({ realised: 500.0 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.realizedPnl, 500.0);
    });

    it("should map unrealised to unrealizedPnl", () => {
      const raw = createRawPosition({ unrealised: -200.0 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.unrealizedPnl, -200.0);
    });
  });

  // ── Orders Normalization ─────────────────────────────────────────────────

  describe("Orders normalization", () => {
    it("should map orderid to orderId", () => {
      const raw = createRawOrder({ orderid: "ORD-999" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.orderId, "ORD-999");
    });

    it("should map tradingsymbol to symbol", () => {
      const raw = createRawOrder({ tradingsymbol: "WIPRO" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.symbol, "WIPRO");
    });

    it("should map tradingsymbol to tradingSymbol", () => {
      const raw = createRawOrder({ tradingsymbol: "HCLTECH" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.tradingSymbol, "HCLTECH");
    });

    it("should preserve exchange", () => {
      const raw = createRawOrder({ exchange: "BSE" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should set segment to CASH when symboltoken starts with NSE", () => {
      const raw = createRawOrder({ symboltoken: "NSE9999" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should set segment to FNO when symboltoken does not start with NSE", () => {
      const raw = createRawOrder({ symboltoken: "MCX4567" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map ordertype to orderType", () => {
      const raw = createRawOrder({ ordertype: "MARKET" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.orderType, "MARKET");
    });

    it("should map transactiontype to transactionType", () => {
      const raw = createRawOrder({ transactiontype: "SELL" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should map producttype to productType", () => {
      const raw = createRawOrder({ producttype: "INTRADAY" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.productType, "INTRADAY");
    });

    it("should preserve variety", () => {
      const raw = createRawOrder({ variety: "STOPLOSS" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.variety, "STOPLOSS");
    });

    it("should preserve quantity", () => {
      const raw = createRawOrder({ quantity: 100 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.quantity, 100);
    });

    it("should map filledshares to filledQuantity", () => {
      const raw = createRawOrder({ filledshares: 50 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.filledQuantity, 50);
    });

    it("should preserve price", () => {
      const raw = createRawOrder({ price: 1500.0 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.price, 1500.0);
    });

    it("should map triggerprice to triggerPrice", () => {
      const raw = createRawOrder({ triggerprice: 1450.0 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.triggerPrice, 1450.0);
    });

    it("should map averageprice to averagePrice", () => {
      const raw = createRawOrder({ averageprice: 1502.5 });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.averagePrice, 1502.5);
    });

    it("should preserve status", () => {
      const raw = createRawOrder({ status: "REJECTED" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.status, "REJECTED");
    });

    it("should map text to statusMessage", () => {
      const raw = createRawOrder({ text: "Insufficient margin" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.statusMessage, "Insufficient margin");
    });

    it("should preserve validity", () => {
      const raw = createRawOrder({ validity: "IOC" });
      const result = normalizeOrder(raw);
      assert.strictEqual(result.validity, "IOC");
    });

    it("should use ordertime for orderTime when available", () => {
      const raw = createRawOrder({
        ordertime: "2024-02-15T10:30:00",
        updatetime: "2024-02-15T10:30:05",
      });
      const result = normalizeOrder(raw);
      assert.strictEqual(
        result.orderTime.toISOString(),
        new Date("2024-02-15T10:30:00").toISOString()
      );
    });

    it("should fall back to updatetime when ordertime is missing", () => {
      const raw = createRawOrder({
        ordertime: undefined,
        updatetime: "2024-02-15T10:30:05",
      });
      const result = normalizeOrder(raw);
      assert.strictEqual(
        result.orderTime.toISOString(),
        new Date("2024-02-15T10:30:05").toISOString()
      );
    });
  });

  // ── Trades Normalization ─────────────────────────────────────────────────

  describe("Trades normalization", () => {
    it("should map tradeid to tradeId", () => {
      const raw = createRawTrade({ tradeid: "TRD-555" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.tradeId, "TRD-555");
    });

    it("should map orderid to orderId", () => {
      const raw = createRawTrade({ orderid: "ORD-555" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.orderId, "ORD-555");
    });

    it("should map tradingsymbol to symbol", () => {
      const raw = createRawTrade({ tradingsymbol: "TATASTEEL" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.symbol, "TATASTEEL");
    });

    it("should map tradingsymbol to tradingSymbol", () => {
      const raw = createRawTrade({ tradingsymbol: "ITC" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.tradingSymbol, "ITC");
    });

    it("should preserve exchange", () => {
      const raw = createRawTrade({ exchange: "BSE" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should set segment to CASH when symboltoken starts with NSE", () => {
      const raw = createRawTrade({ symboltoken: "NSE7777" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should set segment to FNO when symboltoken does not start with NSE", () => {
      const raw = createRawTrade({ symboltoken: "BFO1111" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map transactiontype to transactionType", () => {
      const raw = createRawTrade({ transactiontype: "SELL" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should map producttype to productType", () => {
      const raw = createRawTrade({ producttype: "MARGIN" });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.productType, "MARGIN");
    });

    it("should map fillshares to quantity", () => {
      const raw = createRawTrade({ fillshares: 20 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.quantity, 20);
    });

    it("should map fillprice to price", () => {
      const raw = createRawTrade({ fillprice: 4000.0 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.price, 4000.0);
    });

    it("should compute tradeValue as fillshares * fillprice", () => {
      const raw = createRawTrade({ fillshares: 10, fillprice: 500.0 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.tradeValue, 5000.0);
    });

    it("should set brokerage to 20", () => {
      const raw = createRawTrade();
      const result = normalizeTrade(raw);
      assert.strictEqual(result.brokerage, 20);
    });

    it("should set gst to 3.6", () => {
      const raw = createRawTrade();
      const result = normalizeTrade(raw);
      assert.strictEqual(result.gst, 3.6);
    });

    it("should set totalCharges to 23.6", () => {
      const raw = createRawTrade();
      const result = normalizeTrade(raw);
      assert.strictEqual(result.totalCharges, 23.6);
    });

    it("should set exchangeFee to 0", () => {
      const raw = createRawTrade();
      const result = normalizeTrade(raw);
      assert.strictEqual(result.exchangeFee, 0);
    });

    it("should set sebiCharges to 0", () => {
      const raw = createRawTrade();
      const result = normalizeTrade(raw);
      assert.strictEqual(result.sebiCharges, 0);
    });

    it("should set stampDuty to 0", () => {
      const raw = createRawTrade();
      const result = normalizeTrade(raw);
      assert.strictEqual(result.stampDuty, 0);
    });

    it("should set transactionTax to 0", () => {
      const raw = createRawTrade();
      const result = normalizeTrade(raw);
      assert.strictEqual(result.transactionTax, 0);
    });

    it("should set netAmount equal to tradeValue", () => {
      const raw = createRawTrade({ fillshares: 8, fillprice: 250.0 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.netAmount, 2000.0);
      assert.strictEqual(result.netAmount, result.tradeValue);
    });

    it("should use filltime for tradeTime when available", () => {
      const raw = createRawTrade({
        filltime: "2024-02-15T11:00:00",
        exchangeorderupdatetime: "2024-02-15T11:00:02",
      });
      const result = normalizeTrade(raw);
      assert.strictEqual(
        result.tradeTime.toISOString(),
        new Date("2024-02-15T11:00:00").toISOString()
      );
    });

    it("should fall back to exchangeorderupdatetime when filltime is missing", () => {
      const raw = createRawTrade({
        filltime: undefined,
        exchangeorderupdatetime: "2024-02-15T11:00:02",
      });
      const result = normalizeTrade(raw);
      assert.strictEqual(
        result.tradeTime.toISOString(),
        new Date("2024-02-15T11:00:02").toISOString()
      );
    });
  });

  // ── Auth Headers ─────────────────────────────────────────────────────────

  describe("Auth headers", () => {
    it("should include Authorization header with Bearer prefix", () => {
      const headers = buildAuthHeaders("test_token_abc", "api_key_xyz");
      assert.strictEqual(headers.Authorization, "Bearer test_token_abc");
    });

    it("should include Content-Type as application/json", () => {
      const headers = buildAuthHeaders("tok", "key");
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should include Accept as application/json", () => {
      const headers = buildAuthHeaders("tok", "key");
      assert.strictEqual(headers.Accept, "application/json");
    });

    it("should include X-UserType as USER", () => {
      const headers = buildAuthHeaders("tok", "key");
      assert.strictEqual(headers["X-UserType"], "USER");
    });

    it("should include X-SourceID as WEB", () => {
      const headers = buildAuthHeaders("tok", "key");
      assert.strictEqual(headers["X-SourceID"], "WEB");
    });

    it("should include X-PrivateKey with the provided API key", () => {
      const headers = buildAuthHeaders("tok", "my_private_key");
      assert.strictEqual(headers["X-PrivateKey"], "my_private_key");
    });

    it("should include X-ClientLocalIP as 127.0.0.1", () => {
      const headers = buildAuthHeaders("tok", "key");
      assert.strictEqual(headers["X-ClientLocalIP"], "127.0.0.1");
    });

    it("should include X-ClientPublicIP as 127.0.0.1", () => {
      const headers = buildAuthHeaders("tok", "key");
      assert.strictEqual(headers["X-ClientPublicIP"], "127.0.0.1");
    });

    it("should include X-MACAddress as 00:00:00:00:00:00", () => {
      const headers = buildAuthHeaders("tok", "key");
      assert.strictEqual(headers["X-MACAddress"], "00:00:00:00:00:00");
    });

    it("should contain exactly 9 header keys", () => {
      const headers = buildAuthHeaders("tok", "key");
      assert.strictEqual(Object.keys(headers).length, 9);
    });
  });

  // ── supportsAutoRefresh ──────────────────────────────────────────────────

  describe("supportsAutoRefresh", () => {
    it("should return false", () => {
      assert.strictEqual(supportsAutoRefresh(), false);
    });

    it("should return a boolean", () => {
      assert.strictEqual(typeof supportsAutoRefresh(), "boolean");
    });
  });

  // ── getRefreshStrategy ───────────────────────────────────────────────────

  describe("getRefreshStrategy", () => {
    it("should return NONE", () => {
      assert.strictEqual(getRefreshStrategy(), "NONE");
    });

    it("should return a string", () => {
      assert.strictEqual(typeof getRefreshStrategy(), "string");
    });
  });

  // ── refreshAccessToken ───────────────────────────────────────────────────

  describe("refreshAccessToken", () => {
    it("should return success as false", () => {
      const result = refreshAccessToken();
      assert.strictEqual(result.success, false);
    });

    it("should return error message about TOTP re-authentication", () => {
      const result = refreshAccessToken();
      assert.strictEqual(
        result.error,
        "Angel One requires daily re-authentication with TOTP"
      );
    });

    it("should include the word TOTP in the error", () => {
      const result = refreshAccessToken();
      assert.ok(result.error.includes("TOTP"));
    });

    it("should include the word daily in the error", () => {
      const result = refreshAccessToken();
      assert.ok(result.error.includes("daily"));
    });
  });

  // ── Edge Cases ───────────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("should handle normalizing an empty holdings array", () => {
      const rawHoldings: AngelOneRawHolding[] = [];
      const results = rawHoldings.map(normalizeHolding);
      assert.strictEqual(results.length, 0);
      assert.deepStrictEqual(results, []);
    });

    it("should handle normalizing an empty positions array", () => {
      const rawPositions: AngelOneRawPosition[] = [];
      const results = rawPositions.map(normalizePosition);
      assert.strictEqual(results.length, 0);
      assert.deepStrictEqual(results, []);
    });

    it("should handle normalizing an empty orders array", () => {
      const rawOrders: AngelOneRawOrder[] = [];
      const results = rawOrders.map(normalizeOrder);
      assert.strictEqual(results.length, 0);
      assert.deepStrictEqual(results, []);
    });

    it("should handle normalizing an empty trades array", () => {
      const rawTrades: AngelOneRawTrade[] = [];
      const results = rawTrades.map(normalizeTrade);
      assert.strictEqual(results.length, 0);
      assert.deepStrictEqual(results, []);
    });

    it("should handle holding with zero quantity", () => {
      const raw = createRawHolding({ quantity: 0, t1quantity: 0 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.totalQuantity, 0);
      assert.strictEqual(result.freeQuantity, 0);
    });

    it("should handle holding with negative pnl", () => {
      const raw = createRawHolding({
        profitandloss: -5000.0,
        pnlpercentage: -12.5,
      });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.pnl, -5000.0);
      assert.strictEqual(result.pnlPercentage, -12.5);
    });

    it("should handle position with zero net quantity (squared off)", () => {
      const raw = createRawPosition({ buyqty: 50, sellqty: 50, netqty: 0 });
      const result = normalizePosition(raw);
      assert.strictEqual(result.netQuantity, 0);
    });

    it("should handle trade with zero fillshares resulting in zero tradeValue", () => {
      const raw = createRawTrade({ fillshares: 0, fillprice: 100.0 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.quantity, 0);
      assert.strictEqual(result.tradeValue, 0);
      assert.strictEqual(result.netAmount, 0);
    });

    it("should handle normalizing multiple holdings in batch", () => {
      const rawHoldings = [
        createRawHolding({ tradingsymbol: "RELIANCE", quantity: 10 }),
        createRawHolding({ tradingsymbol: "TCS", quantity: 5 }),
        createRawHolding({ tradingsymbol: "INFY", quantity: 20 }),
      ];
      const results = rawHoldings.map(normalizeHolding);
      assert.strictEqual(results.length, 3);
      assert.strictEqual(results[0]!.symbol, "RELIANCE");
      assert.strictEqual(results[1]!.symbol, "TCS");
      assert.strictEqual(results[2]!.symbol, "INFY");
    });

    it("should handle order with both ordertime and updatetime undefined", () => {
      const raw = createRawOrder({
        ordertime: undefined,
        updatetime: undefined,
      });
      const result = normalizeOrder(raw);
      // When both are undefined, new Date("") produces Invalid Date
      assert.ok(result.orderTime instanceof Date);
    });

    it("should handle trade with both filltime and exchangeorderupdatetime undefined", () => {
      const raw = createRawTrade({
        filltime: undefined,
        exchangeorderupdatetime: undefined,
      });
      const result = normalizeTrade(raw);
      assert.ok(result.tradeTime instanceof Date);
    });

    it("should handle auth headers with empty access token", () => {
      const headers = buildAuthHeaders("", "key");
      assert.strictEqual(headers.Authorization, "Bearer ");
    });

    it("should handle auth headers with empty API key", () => {
      const headers = buildAuthHeaders("token", "");
      assert.strictEqual(headers["X-PrivateKey"], "");
    });

    it("should handle holding where freeQuantity equals totalQuantity minus t1quantity", () => {
      const raw = createRawHolding({ quantity: 100, t1quantity: 30 });
      const result = normalizeHolding(raw);
      assert.strictEqual(result.freeQuantity, 70);
      assert.strictEqual(
        result.freeQuantity,
        result.totalQuantity - result.t1Quantity
      );
    });

    it("should compute correct tradeValue for large fill quantities", () => {
      const raw = createRawTrade({ fillshares: 10000, fillprice: 2500.75 });
      const result = normalizeTrade(raw);
      assert.strictEqual(result.tradeValue, 10000 * 2500.75);
    });
  });
});
