/**
 * Zerodha Adapter Tests (Core Package)
 *
 * Tests the REAL Zerodha adapter + its pure normalizers:
 *   packages/core/src/brokers/adapters/zerodha.ts → ZerodhaAdapter
 *     (BROKER_INFO via getInfo(), getAuthUrl, getTokenExpiryDuration,
 *      supportsAutoRefresh, getRefreshStrategy, refreshAccessToken)
 *   packages/core/src/brokers/adapters/zerodha-normalize.ts
 *     (normalizeZerodhaHolding/Position/Order/Trade/MutualFund,
 *      zerodhaSegmentForExchange) — the adapter's fetch methods delegate to
 *      these, so this exercises production code (no inline reimplementation).
 *   packages/core/src/brokers/mock-data.ts → shouldUseMockData
 *
 * Uses Node.js native test runner (node:test) and assertions.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ZerodhaAdapter, shouldUseMockData } from "@usemoney/core/brokers";
import {
  normalizeZerodhaHolding,
  normalizeZerodhaPosition,
  normalizeZerodhaOrder,
  normalizeZerodhaTrade,
  normalizeZerodhaMutualFund,
  zerodhaSegmentForExchange,
} from "@usemoney/core/brokers/adapters/zerodha-normalize";

// Real adapter instance; getInfo() returns the production BROKER_INFO.
const adapter = new ZerodhaAdapter();
const ZERODHA_INFO = adapter.getInfo();

// ---------------------------------------------------------------------------
// Raw Kite row fixtures (test inputs; not source logic)
//
// These MUST be `type` aliases, not `interface`s. The normalizers take
// `Row = Record<string, unknown>` (the untyped Kite wire shape). TypeScript
// grants an *implicit index signature* to object-literal type aliases but NOT
// to interfaces (an interface can be re-opened by declaration merging, so its
// key set is not final) — so an `interface` fixture is rejected as an argument
// while a structurally identical `type` is accepted. Keeping them as `type`
// preserves the precise per-field typing with no cast.
// ---------------------------------------------------------------------------

type ZerodhaRawHolding = {
  tradingsymbol: string;
  isin?: string;
  exchange: string;
  quantity: number;
  average_price: number;
  last_price: number;
  close_price?: number;
  pnl: number;
  t1_quantity?: number;
  collateral_quantity?: number;
  product?: string;
  day_change?: number;
  day_change_percentage?: number;
};

type ZerodhaRawPosition = {
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
  expiry?: string;
  strike?: number;
  option_type?: string;
  lot_size?: number;
  multiplier?: number;
};

type ZerodhaRawOrder = {
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
  status_message: string;
  validity: string;
  order_timestamp: string;
  exchange_update_timestamp?: string;
  exchange_timestamp?: string;
  tag?: string;
};

type ZerodhaRawTrade = {
  trade_id: string;
  order_id: string;
  tradingsymbol: string;
  exchange: string;
  transaction_type: "BUY" | "SELL";
  product: string;
  quantity: number;
  average_price: number;
  fill_timestamp: string;
  brokerage?: number;
  exchange_fee?: number;
  gst?: number;
  sebi_charges?: number;
  stamp_duty?: number;
  transaction_tax?: number;
};

type ZerodhaRawMutualFund = {
  fund: string;
  tradingsymbol: string;
  folio: string;
  quantity: number;
  average_price: number;
  last_price: number;
  last_price_date?: string;
};

function createMockRawHolding(
  overrides: Partial<ZerodhaRawHolding> = {}
): ZerodhaRawHolding {
  return {
    tradingsymbol: "RELIANCE",
    isin: "INE002A01018",
    exchange: "NSE",
    quantity: 10,
    average_price: 2400,
    last_price: 2520,
    close_price: 2480,
    pnl: 1200,
    t1_quantity: 0,
    collateral_quantity: 0,
    product: "CNC",
    day_change: 40,
    day_change_percentage: 1.64,
    ...overrides,
  };
}

function createMockRawPosition(
  overrides: Partial<ZerodhaRawPosition> = {}
): ZerodhaRawPosition {
  return {
    tradingsymbol: "INFY",
    exchange: "NSE",
    product: "MIS",
    buy_quantity: 20,
    sell_quantity: 0,
    quantity: 20,
    buy_price: 1500,
    sell_price: 0,
    average_price: 1500,
    last_price: 1550,
    realised: 0,
    unrealised: 1000,
    multiplier: 1,
    ...overrides,
  };
}

function createMockRawOrder(
  overrides: Partial<ZerodhaRawOrder> = {}
): ZerodhaRawOrder {
  return {
    order_id: "ORD-001",
    tradingsymbol: "TCS",
    exchange: "NSE",
    order_type: "LIMIT",
    transaction_type: "BUY",
    product: "CNC",
    variety: "regular",
    quantity: 5,
    filled_quantity: 5,
    price: 3800,
    trigger_price: 0,
    average_price: 3795,
    status: "COMPLETE",
    status_message: "",
    validity: "DAY",
    order_timestamp: "2025-01-15T09:30:00+05:30",
    exchange_update_timestamp: "2025-01-15T09:30:01+05:30",
    exchange_timestamp: "2025-01-15T09:30:01+05:30",
    tag: "",
    ...overrides,
  };
}

function createMockRawTrade(
  overrides: Partial<ZerodhaRawTrade> = {}
): ZerodhaRawTrade {
  return {
    trade_id: "TRD-001",
    order_id: "ORD-001",
    tradingsymbol: "HDFCBANK",
    exchange: "NSE",
    transaction_type: "BUY",
    product: "CNC",
    quantity: 15,
    average_price: 1680,
    fill_timestamp: "2025-01-15T10:15:00+05:30",
    brokerage: 0,
    exchange_fee: 3.5,
    gst: 0.63,
    sebi_charges: 0.25,
    stamp_duty: 0.38,
    transaction_tax: 0,
    ...overrides,
  };
}

function createMockRawMutualFund(
  overrides: Partial<ZerodhaRawMutualFund> = {}
): ZerodhaRawMutualFund {
  return {
    fund: "Axis Bluechip Fund - Direct Growth",
    tradingsymbol: "INF846K01DP8",
    folio: "1234567890",
    quantity: 100.5,
    average_price: 45.5,
    last_price: 52.3,
    last_price_date: "2025-01-14",
    ...overrides,
  };
}

let savedEnv: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Zerodha Adapter (Core Package)", () => {
  // ======================================================================
  // ZERODHA_INFO
  // ======================================================================

  describe("ZERODHA_INFO", () => {
    it("should have id set to ZERODHA", () => {
      assert.strictEqual(ZERODHA_INFO.id, "ZERODHA");
    });

    it("should have name set to Zerodha", () => {
      assert.strictEqual(ZERODHA_INFO.name, "Zerodha");
    });

    it("should have autoRefresh set to false", () => {
      assert.strictEqual(ZERODHA_INFO.autoRefresh, false);
    });

    it("should have mfSupport set to true", () => {
      assert.strictEqual(ZERODHA_INFO.mfSupport, true);
    });

    it("should have a non-empty description", () => {
      assert.ok(ZERODHA_INFO.description.length > 0);
    });

    it("should have a hex color code", () => {
      assert.match(ZERODHA_INFO.color, /^#[0-9a-fA-F]{6}$/);
    });

    it("should list 4 segments (Equity, F&O, Currency, Commodity)", () => {
      assert.strictEqual(ZERODHA_INFO.segments.length, 4);
      assert.ok(ZERODHA_INFO.segments.includes("Equity"));
      assert.ok(ZERODHA_INFO.segments.includes("F&O"));
      assert.ok(ZERODHA_INFO.segments.includes("Currency"));
      assert.ok(ZERODHA_INFO.segments.includes("Commodity"));
    });

    it("should list 5 features including MF", () => {
      assert.strictEqual(ZERODHA_INFO.features.length, 5);
      assert.ok(ZERODHA_INFO.features.some((f) => f.includes("MF")));
    });

    it("should have a valid docs URL", () => {
      // `docsUrl` is optional on BrokerInfo — assert Zerodha actually supplies
      // one before checking the scheme (an absent URL must fail, not throw).
      const docsUrl = ZERODHA_INFO.docsUrl;
      assert.strictEqual(typeof docsUrl, "string");
      assert.ok(docsUrl?.startsWith("https://"));
    });
  });

  // ======================================================================
  // getAuthUrl
  // ======================================================================

  describe("getAuthUrl", () => {
    const LOGIN_URL = "https://kite.zerodha.com/connect/login";
    const API_KEY = "test_api_key";

    let savedKey: string | undefined;
    let savedSysKey: string | undefined;
    beforeEach(() => {
      savedKey = process.env.ZERODHA_API_KEY;
      savedSysKey = process.env.ZERODHA_SYSTEM_API_KEY;
      delete process.env.ZERODHA_SYSTEM_API_KEY;
      process.env.ZERODHA_API_KEY = API_KEY;
    });
    afterEach(() => {
      if (savedKey === undefined) delete process.env.ZERODHA_API_KEY;
      else process.env.ZERODHA_API_KEY = savedKey;
      if (savedSysKey === undefined) delete process.env.ZERODHA_SYSTEM_API_KEY;
      else process.env.ZERODHA_SYSTEM_API_KEY = savedSysKey;
    });

    it("should build URL with api_key param", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      assert.ok(url.includes(`api_key=${API_KEY}`));
    });

    it("should include v=3 param", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      assert.ok(url.includes("v=3"));
    });

    it("should start with Zerodha login URL", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      assert.ok(url.startsWith(LOGIN_URL));
    });

    it("should include state param when provided", () => {
      const url = adapter.getAuthUrl(
        "https://example.com/callback",
        "my-state-123"
      );
      assert.ok(url.includes("state=my-state-123"));
    });

    it("should not include state param when not provided", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      assert.ok(!url.includes("state="));
    });

    it("should produce a well-formed URL with question mark separator", () => {
      const url = adapter.getAuthUrl("https://example.com/callback");
      const [base, queryString] = url.split("?");
      assert.strictEqual(base, LOGIN_URL);
      assert.ok(queryString.length > 0);
    });
  });

  // ======================================================================
  // Segment Mapping
  // ======================================================================

  describe("Segment Mapping", () => {
    it("should map NSE to CASH", () => {
      assert.strictEqual(zerodhaSegmentForExchange("NSE"), "CASH");
    });

    it("should map BSE to CASH", () => {
      assert.strictEqual(zerodhaSegmentForExchange("BSE"), "CASH");
    });

    it("should map NFO to FNO", () => {
      assert.strictEqual(zerodhaSegmentForExchange("NFO"), "FNO");
    });

    it("should map BFO to FNO", () => {
      assert.strictEqual(zerodhaSegmentForExchange("BFO"), "FNO");
    });

    it("should map CDS to FNO", () => {
      assert.strictEqual(zerodhaSegmentForExchange("CDS"), "FNO");
    });

    it("should map MCX to FNO", () => {
      assert.strictEqual(zerodhaSegmentForExchange("MCX"), "FNO");
    });

    it("should default unknown exchange to CASH", () => {
      assert.strictEqual(zerodhaSegmentForExchange("UNKNOWN"), "CASH");
    });

    it("should default empty string to CASH", () => {
      assert.strictEqual(zerodhaSegmentForExchange(""), "CASH");
    });
  });

  // ======================================================================
  // fetchHoldings normalization
  // ======================================================================

  describe("fetchHoldings normalization", () => {
    it("should map tradingsymbol to symbol", () => {
      const raw = createMockRawHolding({ tradingsymbol: "TCS" });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.symbol, "TCS");
      assert.strictEqual(result.tradingSymbol, "TCS");
    });

    it("should map isin correctly", () => {
      const raw = createMockRawHolding({ isin: "INE467B01029" });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.isin, "INE467B01029");
    });

    it("should map exchange correctly", () => {
      const raw = createMockRawHolding({ exchange: "BSE" });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should map quantity to totalQuantity", () => {
      const raw = createMockRawHolding({ quantity: 25 });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.totalQuantity, 25);
    });

    it("should calculate freeQuantity as quantity minus t1_quantity", () => {
      const raw = createMockRawHolding({ quantity: 30, t1_quantity: 5 });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.freeQuantity, 25);
    });

    it("should default t1Quantity to 0 when missing", () => {
      const raw = createMockRawHolding();
      delete (raw as unknown as Record<string, unknown>).t1_quantity;
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.t1Quantity, 0);
    });

    it("should map collateral_quantity to pledgedQuantity", () => {
      const raw = createMockRawHolding({ collateral_quantity: 3 });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 3);
      assert.strictEqual(result.collateralQty, 3);
    });

    it("should default pledgedQuantity to 0 when missing", () => {
      const raw = createMockRawHolding();
      delete (raw as unknown as Record<string, unknown>).collateral_quantity;
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 0);
    });

    it("should map average_price to averagePrice", () => {
      const raw = createMockRawHolding({ average_price: 1234.56 });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.averagePrice, 1234.56);
    });

    it("should map last_price to lastPrice", () => {
      const raw = createMockRawHolding({ last_price: 2600 });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.lastPrice, 2600);
    });

    it("should map close_price to closePrice", () => {
      const raw = createMockRawHolding({ close_price: 2490 });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.closePrice, 2490);
    });

    it("should pass through pnl directly", () => {
      const raw = createMockRawHolding({ pnl: -500.25 });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.pnl, -500.25);
    });

    it("should calculate pnlPercentage as ((lastPrice-avgPrice)/avgPrice)*100", () => {
      const raw = createMockRawHolding({
        average_price: 1000,
        last_price: 1150,
      });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.pnlPercentage, 15);
    });

    it("should return pnlPercentage=0 when averagePrice is 0", () => {
      const raw = createMockRawHolding({
        average_price: 0,
        last_price: 100,
      });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should calculate negative pnlPercentage for loss", () => {
      const raw = createMockRawHolding({
        average_price: 2000,
        last_price: 1800,
      });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.pnlPercentage, -10);
    });

    it("should map product correctly", () => {
      const raw = createMockRawHolding({ product: "CNC" });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.product, "CNC");
    });

    it("should map day_change and day_change_percentage", () => {
      const raw = createMockRawHolding({
        day_change: 55.5,
        day_change_percentage: 2.25,
      });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.dayChange, 55.5);
      assert.strictEqual(result.dayChangePerc, 2.25);
    });

    it("should default dayChange to 0 when missing", () => {
      const raw = createMockRawHolding();
      delete (raw as unknown as Record<string, unknown>).day_change;
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.dayChange, 0);
    });

    it("should default dayChangePerc to 0 when missing", () => {
      const raw = createMockRawHolding();
      delete (raw as unknown as Record<string, unknown>).day_change_percentage;
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.dayChangePerc, 0);
    });
  });

  // ======================================================================
  // fetchPositions normalization
  // ======================================================================

  describe("fetchPositions normalization", () => {
    it("should map tradingsymbol to symbol", () => {
      const raw = createMockRawPosition({ tradingsymbol: "SBIN" });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.symbol, "SBIN");
      assert.strictEqual(result.tradingSymbol, "SBIN");
    });

    it("should map exchange correctly", () => {
      const raw = createMockRawPosition({ exchange: "BSE" });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should map NSE exchange to CASH segment", () => {
      const raw = createMockRawPosition({ exchange: "NSE" });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.segment, "CASH");
    });

    it("should map NFO exchange to FNO segment", () => {
      const raw = createMockRawPosition({ exchange: "NFO" });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map MCX exchange to FNO segment", () => {
      const raw = createMockRawPosition({ exchange: "MCX" });
      const result = normalizeZerodhaPosition(raw, "DAY");
      assert.strictEqual(result.segment, "FNO");
    });

    it("should set positionType to DAY when type is DAY", () => {
      const raw = createMockRawPosition();
      const result = normalizeZerodhaPosition(raw, "DAY");
      assert.strictEqual(result.positionType, "DAY");
    });

    it("should set positionType to NET when type is NET", () => {
      const raw = createMockRawPosition();
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.positionType, "NET");
    });

    it("should map buy_quantity and sell_quantity", () => {
      const raw = createMockRawPosition({
        buy_quantity: 50,
        sell_quantity: 20,
      });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.buyQuantity, 50);
      assert.strictEqual(result.sellQuantity, 20);
    });

    it("should map quantity to netQuantity", () => {
      const raw = createMockRawPosition({ quantity: 30 });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.netQuantity, 30);
    });

    it("should map buy_price and sell_price", () => {
      const raw = createMockRawPosition({
        buy_price: 1500,
        sell_price: 1550,
      });
      const result = normalizeZerodhaPosition(raw, "DAY");
      assert.strictEqual(result.buyPrice, 1500);
      assert.strictEqual(result.sellPrice, 1550);
    });

    it("should map realised to realizedPnl and unrealised to unrealizedPnl", () => {
      const raw = createMockRawPosition({
        realised: 500,
        unrealised: 250,
      });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.realizedPnl, 500);
      assert.strictEqual(result.unrealizedPnl, 250);
    });

    it("should map expiry to expiryDate as Date object", () => {
      const raw = createMockRawPosition({ expiry: "2025-02-27" });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.ok(result.expiryDate instanceof Date);
    });

    it("should set expiryDate to undefined when expiry not present", () => {
      const raw = createMockRawPosition();
      delete (raw as unknown as Record<string, unknown>).expiry;
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.expiryDate, undefined);
    });

    it("should map strike and option_type", () => {
      const raw = createMockRawPosition({
        exchange: "NFO",
        strike: 25000,
        option_type: "CE",
      });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.strikePrice, 25000);
      assert.strictEqual(result.optionType, "CE");
    });

    it("should map lot_size and multiplier", () => {
      const raw = createMockRawPosition({
        lot_size: 50,
        multiplier: 1,
      });
      const result = normalizeZerodhaPosition(raw, "NET");
      assert.strictEqual(result.lotSize, 50);
      assert.strictEqual(result.multiplier, 1);
    });
  });

  // ======================================================================
  // fetchOrders normalization
  // ======================================================================

  describe("fetchOrders normalization", () => {
    it("should map order_id to orderId", () => {
      const raw = createMockRawOrder({ order_id: "ORD-999" });
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.orderId, "ORD-999");
    });

    it("should map tradingsymbol to symbol and tradingSymbol", () => {
      const raw = createMockRawOrder({ tradingsymbol: "BHARTIARTL" });
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.symbol, "BHARTIARTL");
      assert.strictEqual(result.tradingSymbol, "BHARTIARTL");
    });

    it("should set segment to CASH for NSE exchange", () => {
      const raw = createMockRawOrder({ exchange: "NSE" });
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should set segment to FNO for NFO exchange", () => {
      const raw = createMockRawOrder({ exchange: "NFO" });
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map order_type, transaction_type, product, variety", () => {
      const raw = createMockRawOrder({
        order_type: "MARKET",
        transaction_type: "SELL",
        product: "MIS",
        variety: "amo",
      });
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.orderType, "MARKET");
      assert.strictEqual(result.transactionType, "SELL");
      assert.strictEqual(result.productType, "MIS");
      assert.strictEqual(result.variety, "amo");
    });

    it("should map quantity and filled_quantity", () => {
      const raw = createMockRawOrder({
        quantity: 100,
        filled_quantity: 75,
      });
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.quantity, 100);
      assert.strictEqual(result.filledQuantity, 75);
    });

    it("should map price, trigger_price, average_price", () => {
      const raw = createMockRawOrder({
        price: 1500,
        trigger_price: 1490,
        average_price: 1498.5,
      });
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.price, 1500);
      assert.strictEqual(result.triggerPrice, 1490);
      assert.strictEqual(result.averagePrice, 1498.5);
    });

    it("should map status and validity", () => {
      const raw = createMockRawOrder({
        status: "REJECTED",
        validity: "IOC",
      });
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.status, "REJECTED");
      assert.strictEqual(result.validity, "IOC");
    });

    it("should convert order_timestamp to Date", () => {
      const raw = createMockRawOrder({
        order_timestamp: "2025-06-15T09:30:00+05:30",
      });
      const result = normalizeZerodhaOrder(raw);
      assert.ok(result.orderTime instanceof Date);
    });

    it("should convert exchange_update_timestamp to Date when present", () => {
      const raw = createMockRawOrder({
        exchange_update_timestamp: "2025-06-15T09:30:05+05:30",
      });
      const result = normalizeZerodhaOrder(raw);
      assert.ok(result.updateTime instanceof Date);
    });

    it("should set updateTime to undefined when exchange_update_timestamp is missing", () => {
      const raw = createMockRawOrder();
      delete (raw as unknown as Record<string, unknown>)
        .exchange_update_timestamp;
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.updateTime, undefined);
    });

    it("should set exchangeTime to undefined when exchange_timestamp is missing", () => {
      const raw = createMockRawOrder();
      delete (raw as unknown as Record<string, unknown>).exchange_timestamp;
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.exchangeTime, undefined);
    });

    it("should map tag correctly", () => {
      const raw = createMockRawOrder({ tag: "algo-v2" });
      const result = normalizeZerodhaOrder(raw);
      assert.strictEqual(result.tag, "algo-v2");
    });
  });

  // ======================================================================
  // fetchTrades normalization
  // ======================================================================

  describe("fetchTrades normalization", () => {
    it("should map trade_id to tradeId", () => {
      const raw = createMockRawTrade({ trade_id: "T-12345" });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.tradeId, "T-12345");
    });

    it("should map order_id to orderId", () => {
      const raw = createMockRawTrade({ order_id: "O-99999" });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.orderId, "O-99999");
    });

    it("should map tradingsymbol to symbol", () => {
      const raw = createMockRawTrade({ tradingsymbol: "ICICIBANK" });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.symbol, "ICICIBANK");
      assert.strictEqual(result.tradingSymbol, "ICICIBANK");
    });

    it("should set segment based on exchange", () => {
      const raw = createMockRawTrade({ exchange: "BFO" });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map average_price to price", () => {
      const raw = createMockRawTrade({ average_price: 1680.25 });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.price, 1680.25);
    });

    it("should calculate tradeValue as quantity * average_price", () => {
      const raw = createMockRawTrade({ quantity: 10, average_price: 500 });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.tradeValue, 5000);
    });

    it("should extract all fee components", () => {
      const raw = createMockRawTrade({
        brokerage: 20,
        exchange_fee: 5.5,
        gst: 4.59,
        sebi_charges: 0.5,
        stamp_duty: 0.75,
        transaction_tax: 2.5,
      });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.brokerage, 20);
      assert.strictEqual(result.exchangeFee, 5.5);
      assert.strictEqual(result.gst, 4.59);
      assert.strictEqual(result.sebiCharges, 0.5);
      assert.strictEqual(result.stampDuty, 0.75);
      assert.strictEqual(result.transactionTax, 2.5);
    });

    it("should calculate totalCharges as sum of all fees", () => {
      const raw = createMockRawTrade({
        brokerage: 20,
        exchange_fee: 5,
        gst: 4.5,
        sebi_charges: 0.5,
        stamp_duty: 0.75,
        transaction_tax: 2.5,
      });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.totalCharges, 20 + 5 + 4.5 + 0.5 + 0.75 + 2.5);
    });

    it("should default all fees to 0 when missing", () => {
      const raw = createMockRawTrade();
      delete (raw as unknown as Record<string, unknown>).brokerage;
      delete (raw as unknown as Record<string, unknown>).exchange_fee;
      delete (raw as unknown as Record<string, unknown>).gst;
      delete (raw as unknown as Record<string, unknown>).sebi_charges;
      delete (raw as unknown as Record<string, unknown>).stamp_duty;
      delete (raw as unknown as Record<string, unknown>).transaction_tax;
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.totalCharges, 0);
    });

    it("should calculate netAmount for BUY as tradeValue + totalCharges", () => {
      const raw = createMockRawTrade({
        transaction_type: "BUY",
        quantity: 10,
        average_price: 1000,
        brokerage: 20,
        exchange_fee: 5,
        gst: 0,
        sebi_charges: 0,
        stamp_duty: 0,
        transaction_tax: 0,
      });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.netAmount, 10000 + 25);
    });

    it("should calculate netAmount for SELL as tradeValue - totalCharges", () => {
      const raw = createMockRawTrade({
        transaction_type: "SELL",
        quantity: 10,
        average_price: 1000,
        brokerage: 20,
        exchange_fee: 5,
        gst: 0,
        sebi_charges: 0,
        stamp_duty: 0,
        transaction_tax: 0,
      });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.netAmount, 10000 - 25);
    });

    it("should convert fill_timestamp to tradeTime Date", () => {
      const raw = createMockRawTrade({
        fill_timestamp: "2025-03-10T14:30:00+05:30",
      });
      const result = normalizeZerodhaTrade(raw);
      assert.ok(result.tradeTime instanceof Date);
    });

    it("should map CDS exchange to FNO segment", () => {
      const raw = createMockRawTrade({ exchange: "CDS" });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map NSE exchange to CASH segment", () => {
      const raw = createMockRawTrade({ exchange: "NSE" });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.segment, "CASH");
    });
  });

  // ======================================================================
  // fetchMutualFunds normalization
  // ======================================================================

  describe("fetchMutualFunds normalization", () => {
    it("should map fund to fundName and schemeName", () => {
      const raw = createMockRawMutualFund({
        fund: "Parag Parikh Flexi Cap Fund",
      });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.fundName, "Parag Parikh Flexi Cap Fund");
      assert.strictEqual(result.schemeName, "Parag Parikh Flexi Cap Fund");
    });

    it("should map tradingsymbol to isin", () => {
      const raw = createMockRawMutualFund({
        tradingsymbol: "INF879O01027",
      });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.isin, "INF879O01027");
    });

    it("should map folio correctly", () => {
      const raw = createMockRawMutualFund({ folio: "FOLIO-999" });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.folio, "FOLIO-999");
    });

    it("should map quantity to units", () => {
      const raw = createMockRawMutualFund({ quantity: 250.75 });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.units, 250.75);
    });

    it("should map average_price to averageNav", () => {
      const raw = createMockRawMutualFund({ average_price: 45.5 });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.averageNav, 45.5);
    });

    it("should map last_price to currentNav", () => {
      const raw = createMockRawMutualFund({ last_price: 52.3 });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.currentNav, 52.3);
    });

    it("should calculate investedValue as units * averageNav", () => {
      const raw = createMockRawMutualFund({
        quantity: 100,
        average_price: 50,
      });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.investedValue, 5000);
    });

    it("should calculate currentValue as units * currentNav", () => {
      const raw = createMockRawMutualFund({
        quantity: 100,
        last_price: 55,
      });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.currentValue, 5500);
    });

    it("should calculate pnl as currentValue - investedValue", () => {
      const raw = createMockRawMutualFund({
        quantity: 100,
        average_price: 50,
        last_price: 55,
      });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.pnl, 500);
    });

    it("should calculate pnlPercentage correctly", () => {
      const raw = createMockRawMutualFund({
        quantity: 100,
        average_price: 50,
        last_price: 55,
      });
      const result = normalizeZerodhaMutualFund(raw);
      // pnl = 500, investedValue = 5000, pnlPercentage = 10%
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should return pnlPercentage=0 when investedValue is 0 (averageNav=0)", () => {
      const raw = createMockRawMutualFund({
        quantity: 100,
        average_price: 0,
        last_price: 55,
      });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should convert last_price_date to lastNavDate Date", () => {
      const raw = createMockRawMutualFund({
        last_price_date: "2025-01-14",
      });
      const result = normalizeZerodhaMutualFund(raw);
      assert.ok(result.lastNavDate instanceof Date);
    });

    it("should set lastNavDate to undefined when missing", () => {
      const raw = createMockRawMutualFund();
      delete (raw as unknown as Record<string, unknown>).last_price_date;
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.lastNavDate, undefined);
    });

    it("should always set isSIP to false", () => {
      const raw = createMockRawMutualFund();
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.isSIP, false);
    });
  });

  // ======================================================================
  // supportsAutoRefresh / getRefreshStrategy / refreshAccessToken
  // ======================================================================

  describe("supportsAutoRefresh", () => {
    it("should return false", () => {
      assert.strictEqual(adapter.supportsAutoRefresh(), false);
    });
  });

  describe("getRefreshStrategy", () => {
    it("should return NONE", () => {
      assert.strictEqual(adapter.getRefreshStrategy(), "NONE");
    });
  });

  describe("refreshAccessToken", () => {
    it("should return success:false with re-authentication message", async () => {
      // Zerodha cannot refresh: the adapter takes NO credentials and always
      // rejects. (This previously passed a fabricated `{accessToken}` through
      // an `as unknown as` cast, which silently outlived the signature change.)
      const result = await adapter.refreshAccessToken();
      assert.strictEqual(result.success, false);
      assert.strictEqual(
        result.error,
        "Zerodha requires daily re-authentication"
      );
    });
  });

  // ======================================================================
  // getTokenExpiryDuration
  // ======================================================================

  describe("getTokenExpiryDuration", () => {
    it("should return a positive number of milliseconds", () => {
      const duration = adapter.getTokenExpiryDuration();
      assert.ok(duration > 0, "Token expiry duration should be positive");
    });

    it("should return a value less than 24 hours", () => {
      const duration = adapter.getTokenExpiryDuration();
      const twentyFourHours = 24 * 60 * 60 * 1000;
      assert.ok(
        duration <= twentyFourHours,
        "Token expiry should be at most 24 hours"
      );
    });

    it("should represent time remaining until end of day", () => {
      const now = new Date();
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);
      const expected = endOfDay.getTime() - now.getTime();
      const actual = adapter.getTokenExpiryDuration();
      // Allow 100ms tolerance for execution time
      assert.ok(
        Math.abs(actual - expected) < 100,
        `Expected ~${expected}ms, got ${actual}ms`
      );
    });
  });

  // ======================================================================
  // shouldUseMockData
  // ======================================================================

  describe("shouldUseMockData", () => {
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

    it("should return true when ZERODHA_API_KEY is missing", () => {
      delete process.env.ZERODHA_API_KEY;
      process.env.ZERODHA_API_SECRET = "some_secret";
      assert.strictEqual(shouldUseMockData("ZERODHA"), true);
    });

    it("should return true when ZERODHA_API_SECRET is missing", () => {
      process.env.ZERODHA_API_KEY = "some_key";
      delete process.env.ZERODHA_API_SECRET;
      assert.strictEqual(shouldUseMockData("ZERODHA"), true);
    });

    it("should return true when both env vars are missing", () => {
      delete process.env.ZERODHA_API_KEY;
      delete process.env.ZERODHA_API_SECRET;
      assert.strictEqual(shouldUseMockData("ZERODHA"), true);
    });

    it("should return false when both env vars are set", () => {
      process.env.ZERODHA_API_KEY = "key_123";
      process.env.ZERODHA_API_SECRET = "secret_456";
      assert.strictEqual(shouldUseMockData("ZERODHA"), false);
    });

    it("should return true for unknown broker (no env keys configured)", () => {
      assert.strictEqual(shouldUseMockData("UNKNOWN_BROKER"), false);
    });
  });

  // ======================================================================
  // Edge cases
  // ======================================================================

  describe("Edge cases", () => {
    it("should handle empty holdings array gracefully", () => {
      const holdings: ZerodhaRawHolding[] = [];
      const normalized = holdings.map((h) => normalizeZerodhaHolding(h));
      assert.strictEqual(normalized.length, 0);
    });

    it("should handle empty positions arrays gracefully", () => {
      const dayPositions: ZerodhaRawPosition[] = [];
      const netPositions: ZerodhaRawPosition[] = [];
      const allPositions = [
        ...dayPositions.map((p) => normalizeZerodhaPosition(p, "DAY")),
        ...netPositions.map((p) => normalizeZerodhaPosition(p, "NET")),
      ];
      assert.strictEqual(allPositions.length, 0);
    });

    it("should handle empty orders array gracefully", () => {
      const orders: ZerodhaRawOrder[] = [];
      const normalized = orders.map((o) => normalizeZerodhaOrder(o));
      assert.strictEqual(normalized.length, 0);
    });

    it("should handle empty trades array gracefully", () => {
      const trades: ZerodhaRawTrade[] = [];
      const normalized = trades.map((t) => normalizeZerodhaTrade(t));
      assert.strictEqual(normalized.length, 0);
    });

    it("should handle empty mutual funds array gracefully", () => {
      const mfs: ZerodhaRawMutualFund[] = [];
      const normalized = mfs.map((m) => normalizeZerodhaMutualFund(m));
      assert.strictEqual(normalized.length, 0);
    });

    it("should handle zero prices in holdings without NaN", () => {
      const raw = createMockRawHolding({
        average_price: 0,
        last_price: 0,
        close_price: 0,
        pnl: 0,
      });
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.pnlPercentage, 0);
      assert.strictEqual(Number.isNaN(result.pnlPercentage), false);
    });

    it("should handle zero quantity in trades", () => {
      const raw = createMockRawTrade({
        quantity: 0,
        average_price: 100,
      });
      const result = normalizeZerodhaTrade(raw);
      assert.strictEqual(result.tradeValue, 0);
      assert.strictEqual(result.netAmount, result.totalCharges);
    });

    it("should handle zero quantity and zero price in mutual funds", () => {
      const raw = createMockRawMutualFund({
        quantity: 0,
        average_price: 0,
        last_price: 0,
      });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.investedValue, 0);
      assert.strictEqual(result.currentValue, 0);
      assert.strictEqual(result.pnl, 0);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should handle negative pnl in holdings", () => {
      const raw = createMockRawHolding({
        average_price: 2500,
        last_price: 2000,
        pnl: -5000,
      });
      const result = normalizeZerodhaHolding(raw);
      assert.ok(result.pnlPercentage < 0);
      assert.strictEqual(result.pnl, -5000);
    });

    it("should handle fractional mutual fund units", () => {
      const raw = createMockRawMutualFund({
        quantity: 123.456789,
        average_price: 45.67,
        last_price: 48.92,
      });
      const result = normalizeZerodhaMutualFund(raw);
      assert.strictEqual(result.units, 123.456789);
      const expectedInvested = 123.456789 * 45.67;
      const expectedCurrent = 123.456789 * 48.92;
      assert.strictEqual(result.investedValue, expectedInvested);
      assert.strictEqual(result.currentValue, expectedCurrent);
    });

    it("should handle missing optional fields in holdings without crashing", () => {
      const raw: ZerodhaRawHolding = {
        tradingsymbol: "TEST",
        exchange: "NSE",
        quantity: 1,
        average_price: 100,
        last_price: 110,
        pnl: 10,
      };
      const result = normalizeZerodhaHolding(raw);
      assert.strictEqual(result.symbol, "TEST");
      assert.strictEqual(result.t1Quantity, 0);
      assert.strictEqual(result.pledgedQuantity, 0);
      assert.strictEqual(result.dayChange, 0);
      assert.strictEqual(result.dayChangePerc, 0);
    });

    it("should handle a large batch of holdings normalization", () => {
      const holdings = Array.from({ length: 100 }, (_, i) =>
        createMockRawHolding({
          tradingsymbol: `STOCK${i}`,
          quantity: i + 1,
          average_price: (i + 1) * 100,
          last_price: (i + 1) * 105,
        })
      );
      const normalized = holdings.map((h) => normalizeZerodhaHolding(h));
      assert.strictEqual(normalized.length, 100);
      assert.strictEqual(normalized[0].symbol, "STOCK0");
      assert.strictEqual(normalized[99].symbol, "STOCK99");
    });
  });
});
