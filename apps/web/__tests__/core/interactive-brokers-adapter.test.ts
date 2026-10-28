/**
 * Interactive Brokers Adapter Tests — REAL SOURCE
 *
 * Exercises the REAL `InteractiveBrokersAdapter` class and the REAL exported
 * mapping helpers from `@usemoney/core/brokers`
 * (packages/core/src/brokers/adapters/interactive-brokers.ts) — NOT inline
 * copies. Covers:
 * - Broker info (via the real getInfo())
 * - getClientId / getClientSecret / getAuthHeaders (via a probe subclass that
 *   exposes the adapter's own private methods — no reimplementation)
 * - getAuthUrl() query-param construction (real method; clientId read from env)
 * - mapIBKRExchange / mapIBKROrderStatus / mapIBKRSegment (real exported helpers)
 * - mapIBKRHolding / mapIBKRPosition / mapIBKROrder / mapIBKRTrade (real exported
 *   functions that the adapter's private map* methods delegate to)
 * - token strategy + fetchMutualFunds + validateToken mock branch
 *
 * (Replaces the previous shadow version, which reimplemented BROKER_INFO and
 * every map/helper function inline and asserted the copies.)
 *
 * Pure/offline: the only env-dependent branch exercised is the validateToken
 * mock branch (env removed inside that test, save/restore), so there is no
 * network, timer, or open handle.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  InteractiveBrokersAdapter,
  mapIBKRExchange,
  mapIBKROrderStatus,
  mapIBKRSegment,
  mapIBKRHolding,
  mapIBKRPosition,
  mapIBKROrder,
  mapIBKRTrade,
} from "@usemoney/core/brokers";

// Probe subclass to reach the adapter's own private credential + header methods
// without reimplementing them.
class IBKRProbe extends InteractiveBrokersAdapter {
  publicGetClientId(): string {
    return (this as unknown as { getClientId(): string }).getClientId();
  }
  publicGetClientSecret(): string {
    return (this as unknown as { getClientSecret(): string }).getClientSecret();
  }
  publicGetAuthHeaders(
    credentials: Parameters<
      (typeof InteractiveBrokersAdapter.prototype)["validateToken"]
    >[0]
  ): Record<string, string> {
    return (
      this as unknown as {
        getAuthHeaders(c: typeof credentials): Record<string, string>;
      }
    ).getAuthHeaders(credentials);
  }
}

describe("InteractiveBrokersAdapter", () => {
  const adapter = new InteractiveBrokersAdapter();
  const info = adapter.getInfo();

  // ---------- Broker Info ----------
  describe("Broker Info", () => {
    it("should have id INTERACTIVE_BROKERS", () => {
      assert.strictEqual(info.id, "INTERACTIVE_BROKERS");
    });

    it("should have name Interactive Brokers", () => {
      assert.strictEqual(info.name, "Interactive Brokers");
    });

    it("should have correct color #D81B3C", () => {
      assert.strictEqual(info.color, "#D81B3C");
    });

    it("should support 5 segments", () => {
      assert.strictEqual(info.segments.length, 5);
    });

    it("should include Equity segment", () => {
      assert.ok(info.segments.includes("Equity"));
    });

    it("should include Bonds segment", () => {
      assert.ok(info.segments.includes("Bonds"));
    });

    it("should have 4 features", () => {
      assert.strictEqual(info.features.length, 4);
    });

    it("should include Holdings feature", () => {
      assert.ok(info.features.includes("Holdings"));
    });

    it("should have autoRefresh=true", () => {
      assert.strictEqual(info.autoRefresh, true);
    });

    it("should have mfSupport=false", () => {
      assert.strictEqual(info.mfSupport, false);
    });

    it("should have cost FREE", () => {
      assert.strictEqual(info.cost, "FREE");
    });

    it("should have tokenExpiry of 24 hours", () => {
      assert.strictEqual(info.tokenExpiry, "24 hours");
    });

    it("should have docsUrl pointing to IBKR API docs", () => {
      assert.strictEqual(
        info.docsUrl,
        "https://www.interactivebrokers.com/api/doc.html"
      );
    });
  });

  // ---------- Credential Access ----------
  describe("Credential Access", () => {
    const savedClientId = process.env.INTERACTIVE_BROKERS_CLIENT_ID;
    const savedClientSecret = process.env.INTERACTIVE_BROKERS_CLIENT_SECRET;
    const probe = new IBKRProbe();

    afterEach(() => {
      if (savedClientId !== undefined) {
        process.env.INTERACTIVE_BROKERS_CLIENT_ID = savedClientId;
      } else {
        delete process.env.INTERACTIVE_BROKERS_CLIENT_ID;
      }
      if (savedClientSecret !== undefined) {
        process.env.INTERACTIVE_BROKERS_CLIENT_SECRET = savedClientSecret;
      } else {
        delete process.env.INTERACTIVE_BROKERS_CLIENT_SECRET;
      }
    });

    it("getClientId should return empty string when env var is not set", () => {
      delete process.env.INTERACTIVE_BROKERS_CLIENT_ID;
      assert.strictEqual(probe.publicGetClientId(), "");
    });

    it("getClientId should return env var when set", () => {
      process.env.INTERACTIVE_BROKERS_CLIENT_ID = "test-client-id";
      assert.strictEqual(probe.publicGetClientId(), "test-client-id");
    });

    it("getClientSecret should return empty string when env var is not set", () => {
      delete process.env.INTERACTIVE_BROKERS_CLIENT_SECRET;
      assert.strictEqual(probe.publicGetClientSecret(), "");
    });

    it("getClientSecret should return env var when set", () => {
      process.env.INTERACTIVE_BROKERS_CLIENT_SECRET = "test-secret";
      assert.strictEqual(probe.publicGetClientSecret(), "test-secret");
    });
  });

  // ---------- Auth URL ----------
  describe("Auth URL Construction", () => {
    const savedClientId = process.env.INTERACTIVE_BROKERS_CLIENT_ID;

    afterEach(() => {
      if (savedClientId !== undefined) {
        process.env.INTERACTIVE_BROKERS_CLIENT_ID = savedClientId;
      } else {
        delete process.env.INTERACTIVE_BROKERS_CLIENT_ID;
      }
    });

    it("should generate correct base authorize URL", () => {
      const url = adapter.getAuthUrl("https://example.com/cb");
      assert.ok(
        url.startsWith("https://www.interactivebrokers.com/authorize?")
      );
    });

    it("should include client_id parameter from env", () => {
      process.env.INTERACTIVE_BROKERS_CLIENT_ID = "my-client";
      const url = adapter.getAuthUrl("https://example.com/cb");
      assert.ok(url.includes("client_id=my-client"));
    });

    it("should include response_type=code", () => {
      const url = adapter.getAuthUrl("https://example.com/cb");
      assert.ok(url.includes("response_type=code"));
    });

    it("should include scope=trading", () => {
      const url = adapter.getAuthUrl("https://example.com/cb");
      assert.ok(url.includes("scope=trading"));
    });

    it("should include state parameter when provided", () => {
      const url = adapter.getAuthUrl("https://example.com/cb", "my-state");
      assert.ok(url.includes("state=my-state"));
    });

    it("should omit state parameter when not provided", () => {
      const url = adapter.getAuthUrl("https://example.com/cb");
      assert.ok(!url.includes("state="));
    });
  });

  // ---------- Auth Headers ----------
  describe("Auth Header Construction", () => {
    const probe = new IBKRProbe();

    it("should include Bearer token in Authorization", () => {
      const headers = probe.publicGetAuthHeaders({
        accessToken: "ibkr-token-123",
      });
      assert.strictEqual(headers["Authorization"], "Bearer ibkr-token-123");
    });

    it("should include Accept application/json", () => {
      const headers = probe.publicGetAuthHeaders({ accessToken: "tok" });
      assert.strictEqual(headers["Accept"], "application/json");
    });

    it("should produce exactly 2 headers", () => {
      const headers = probe.publicGetAuthHeaders({ accessToken: "tok" });
      assert.strictEqual(Object.keys(headers).length, 2);
    });
  });

  // ---------- Exchange Mapping ----------
  describe("Exchange Mapping (mapIBKRExchange)", () => {
    it("should map ARCA to NYSE", () => {
      assert.strictEqual(mapIBKRExchange("ARCA"), "NYSE");
    });

    it("should map AMEX to NYSE", () => {
      assert.strictEqual(mapIBKRExchange("AMEX"), "NYSE");
    });

    it("should map LSE to LSE", () => {
      assert.strictEqual(mapIBKRExchange("LSE"), "LSE");
    });

    it("should map IDEALPRO to FOREX", () => {
      assert.strictEqual(mapIBKRExchange("IDEALPRO"), "FOREX");
    });

    it("should NOT resolve SMART to an Indian venue (MONEY-980)", () => {
      // This case used to assert `mapIBKRExchange("SMART") === "NSE"` — it
      // ENCODED the bug. SMART is IBKR's smart-ORDER-ROUTER pseudo-venue, not a
      // place: it means "IBKR chose where to execute" and does not report the
      // choice back. Resolving it to NSE stamped every SMART-routed holding in
      // every market as Indian, and `exchange` is half of the corp-action match
      // key in `corpActionAppliesToLot` — so a US ACC lot absorbed ACC Ltd's
      // splits. Full reasoning + the pairing-level proof:
      // packages/core/__tests__/brokers/ibkr-smart-router-venue.test.ts
      assert.strictEqual(mapIBKRExchange("SMART", "USD"), "SMART");
      // An ABSENT currency is unresolved, never assumed Indian.
      assert.strictEqual(mapIBKRExchange("SMART"), "SMART");
      // INR is the one currency that pins a single market with one default
      // venue, so the pre-existing India behaviour is retained.
      assert.strictEqual(mapIBKRExchange("SMART", "INR"), "NSE");
    });

    it("should return unknown exchanges as-is", () => {
      assert.strictEqual(mapIBKRExchange("TSE"), "TSE");
    });
  });

  // ---------- Order Status Mapping ----------
  describe("Order Status Mapping (mapIBKROrderStatus)", () => {
    it("should map Submitted to PENDING", () => {
      assert.strictEqual(mapIBKROrderStatus("Submitted"), "PENDING");
    });

    it("should map Filled to COMPLETE", () => {
      assert.strictEqual(mapIBKROrderStatus("Filled"), "COMPLETE");
    });

    it("should map Cancelled to CANCELLED", () => {
      assert.strictEqual(mapIBKROrderStatus("Cancelled"), "CANCELLED");
    });

    it("should map Inactive to REJECTED", () => {
      assert.strictEqual(mapIBKROrderStatus("Inactive"), "REJECTED");
    });

    it("should map ApiCancelled to CANCELLED", () => {
      assert.strictEqual(mapIBKROrderStatus("ApiCancelled"), "CANCELLED");
    });

    it("should default unknown statuses to PENDING", () => {
      assert.strictEqual(mapIBKROrderStatus("WeirdStatus"), "PENDING");
    });
  });

  // ---------- Segment Mapping ----------
  describe("Segment Mapping (mapIBKRSegment)", () => {
    it("should map STK to CASH", () => {
      assert.strictEqual(mapIBKRSegment("STK"), "CASH");
    });

    it("should map FUT to FNO", () => {
      assert.strictEqual(mapIBKRSegment("FUT"), "FNO");
    });

    it("should map FOP to FNO", () => {
      assert.strictEqual(mapIBKRSegment("FOP"), "FNO");
    });

    it("should map WAR to CASH", () => {
      assert.strictEqual(mapIBKRSegment("WAR"), "CASH");
    });

    it("should map FUND to MF", () => {
      assert.strictEqual(mapIBKRSegment("FUND"), "MF");
    });

    it("should default unknown asset classes to CASH", () => {
      assert.strictEqual(mapIBKRSegment("CFD"), "CASH");
    });
  });

  // ---------- Token & Refresh Strategy ----------
  describe("Token and Refresh Strategy", () => {
    it("supportsAutoRefresh should return true", () => {
      assert.strictEqual(adapter.supportsAutoRefresh(), true);
    });

    it("getRefreshStrategy should return TOKEN_REFRESH", () => {
      assert.strictEqual(adapter.getRefreshStrategy(), "TOKEN_REFRESH");
    });

    it("getTokenExpiryDuration should return 24 hours in ms", () => {
      assert.strictEqual(adapter.getTokenExpiryDuration(), 86400000);
    });

    it("getTokenExpiryDuration should equal 24 * 60 * 60 * 1000", () => {
      assert.strictEqual(adapter.getTokenExpiryDuration(), 24 * 60 * 60 * 1000);
    });
  });

  // ---------- Holdings Normalization ----------
  describe("Holdings Normalization (mapIBKRHolding)", () => {
    it("should normalize a basic holding", () => {
      const raw = {
        ticker: "AAPL",
        isin: "US0378331005",
        listingExchange: "NASDAQ",
        position: 10,
        avgCost: 150,
        mktPrice: 175,
        unrealizedPnl: 250,
        priorClose: 170,
        conid: 265598,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.symbol, "AAPL");
      assert.strictEqual(result.isin, "US0378331005");
      assert.strictEqual(result.exchange, "NASDAQ");
      assert.strictEqual(result.totalQuantity, 10);
      assert.strictEqual(result.freeQuantity, 10);
      assert.strictEqual(result.averagePrice, 150);
      assert.strictEqual(result.lastPrice, 175);
    });

    it("should always set t1Quantity to 0", () => {
      const raw = {
        ticker: "X",
        position: 5,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 50,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.t1Quantity, 0);
    });

    it("should always set pledgedQuantity to 0", () => {
      const raw = {
        ticker: "X",
        position: 5,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 50,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 0);
    });

    it("should always set product to CNC", () => {
      const raw = {
        ticker: "X",
        position: 5,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 50,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.product, "CNC");
    });

    it("should calculate pnlPercentage rounded to 2 decimals", () => {
      const raw = {
        ticker: "X",
        position: 3,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 30,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should handle zero investedValue (pnlPercentage = 0)", () => {
      const raw = {
        ticker: "X",
        position: 0,
        avgCost: 0,
        mktPrice: 100,
        unrealizedPnl: 0,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should calculate dayChange correctly", () => {
      const raw = {
        ticker: "X",
        position: 1,
        avgCost: 100,
        mktPrice: 105,
        unrealizedPnl: 5,
        priorClose: 102,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.dayChange, 3);
    });

    it("should set dayChangePerc to 0 when priorClose is missing", () => {
      const raw = {
        ticker: "X",
        position: 1,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 10,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.dayChangePerc, 0);
    });

    it("should fallback symbol to contractDesc", () => {
      const raw = {
        contractDesc: "MSFT Corp",
        position: 1,
        avgCost: 300,
        mktPrice: 310,
        unrealizedPnl: 10,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.symbol, "MSFT Corp");
    });

    it("should fallback symbol to CONID_xxx", () => {
      const raw = {
        conid: 99999,
        position: 1,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 10,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.symbol, "CONID_99999");
    });

    it("should set isin to undefined when missing", () => {
      const raw = {
        ticker: "X",
        position: 1,
        avgCost: 100,
        mktPrice: 110,
        unrealizedPnl: 10,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.isin, undefined);
    });
  });

  // ---------- Positions Normalization ----------
  describe("Positions Normalization (mapIBKRPosition)", () => {
    it("should normalize a long STK position", () => {
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
      const result = mapIBKRPosition(raw);
      assert.strictEqual(result.symbol, "GOOGL");
      assert.strictEqual(result.segment, "CASH");
      assert.strictEqual(result.productType, "CNC");
      assert.strictEqual(result.buyQuantity, 20);
      assert.strictEqual(result.sellQuantity, 0);
      assert.strictEqual(result.netQuantity, 20);
    });

    it("should normalize a short position", () => {
      const raw = {
        ticker: "TSLA",
        listingExchange: "NASDAQ",
        assetClass: "STK",
        position: -5,
        avgCost: 250,
        mktPrice: 240,
        unrealizedPnl: 50,
        realizedPnl: 0,
      };
      const result = mapIBKRPosition(raw);
      assert.strictEqual(result.buyQuantity, 0);
      assert.strictEqual(result.sellQuantity, 5);
      assert.strictEqual(result.buyPrice, 0);
      assert.strictEqual(result.sellPrice, 250);
      assert.strictEqual(result.netQuantity, -5);
    });

    it("should set positionType to DAY", () => {
      const raw = {
        ticker: "X",
        assetClass: "STK",
        position: 1,
        avgCost: 100,
        mktPrice: 110,
      };
      const result = mapIBKRPosition(raw);
      assert.strictEqual(result.positionType, "DAY");
    });

    it("should set productType to NRML for OPT", () => {
      const raw = {
        ticker: "NIFTY",
        assetClass: "OPT",
        position: 50,
        avgCost: 200,
        mktPrice: 220,
      };
      const result = mapIBKRPosition(raw);
      assert.strictEqual(result.productType, "NRML");
    });

    it("should map FUT to FNO segment", () => {
      const raw = {
        ticker: "NIFTY",
        assetClass: "FUT",
        position: 25,
        avgCost: 22000,
        mktPrice: 22200,
      };
      const result = mapIBKRPosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should default assetClass to STK when missing", () => {
      const raw = { ticker: "X", position: 1, avgCost: 100, mktPrice: 110 };
      const result = mapIBKRPosition(raw);
      assert.strictEqual(result.segment, "CASH");
      assert.strictEqual(result.productType, "CNC");
    });
  });

  // ---------- Orders Normalization ----------
  describe("Orders Normalization (mapIBKROrder)", () => {
    it("should normalize a basic BUY order", () => {
      const raw = {
        orderId: "ORD001",
        ticker: "AAPL",
        listingExchange: "NASDAQ",
        secType: "STK",
        side: "BUY",
        orderType: "LMT",
        totalSize: 10,
        filledQuantity: 10,
        price: 175,
        avgPrice: 175,
        status: "Filled",
        lastExecutionTime: "2024-06-15T10:30:00Z",
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.orderId, "ORD001");
      assert.strictEqual(result.symbol, "AAPL");
      assert.strictEqual(result.transactionType, "BUY");
      assert.strictEqual(result.status, "COMPLETE");
      assert.strictEqual(result.quantity, 10);
    });

    it("should detect SELL transaction type", () => {
      const raw = {
        orderId: "ORD002",
        ticker: "X",
        side: "SELL",
        totalSize: 5,
        price: 100,
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should use cumFill as fallback for filledQuantity", () => {
      const raw = {
        orderId: "ORD003",
        ticker: "X",
        side: "BUY",
        totalSize: 10,
        cumFill: 7,
        price: 100,
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.filledQuantity, 7);
    });

    it("should use totalQuantity as fallback for quantity", () => {
      const raw = {
        orderId: "ORD004",
        ticker: "X",
        side: "BUY",
        totalQuantity: 15,
        price: 100,
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.quantity, 15);
    });

    it("should set variety to regular", () => {
      const raw = {
        orderId: "ORD005",
        ticker: "X",
        side: "BUY",
        totalSize: 1,
        price: 100,
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.variety, "regular");
    });

    it("should set validity to DAY", () => {
      const raw = {
        orderId: "ORD006",
        ticker: "X",
        side: "BUY",
        totalSize: 1,
        price: 100,
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.validity, "DAY");
    });

    it("should default orderType to MKT", () => {
      const raw = {
        orderId: "ORD007",
        ticker: "X",
        side: "BUY",
        totalSize: 1,
        price: 100,
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.orderType, "MKT");
    });

    it("should set triggerPrice from auxPrice", () => {
      const raw = {
        orderId: "ORD008",
        ticker: "X",
        side: "BUY",
        totalSize: 1,
        price: 100,
        auxPrice: 95,
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.triggerPrice, 95);
    });

    it("should set statusMessage from warningText", () => {
      const raw = {
        orderId: "ORD009",
        ticker: "X",
        side: "BUY",
        totalSize: 1,
        price: 100,
        warningText: "Low margin",
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.statusMessage, "Low margin");
    });

    it("should set statusMessage to undefined when warningText is missing", () => {
      const raw = {
        orderId: "ORD010",
        ticker: "X",
        side: "BUY",
        totalSize: 1,
        price: 100,
      };
      const result = mapIBKROrder(raw);
      assert.strictEqual(result.statusMessage, undefined);
    });
  });

  // ---------- Trades Normalization ----------
  describe("Trades Normalization (mapIBKRTrade)", () => {
    it("should normalize a basic trade", () => {
      const raw = {
        execution_id: "EX001",
        orderId: "ORD001",
        ticker: "AAPL",
        listingExchange: "NASDAQ",
        secType: "STK",
        side: "BUY",
        size: 10,
        price: 175.5,
        commission: -1.25,
        tradeTime: "2024-06-15T10:30:00Z",
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.tradeId, "EX001");
      assert.strictEqual(result.symbol, "AAPL");
      assert.strictEqual(result.transactionType, "BUY");
      assert.strictEqual(result.quantity, 10);
    });

    it("should calculate tradeValue as qty * price", () => {
      const raw = {
        execution_id: "EX002",
        side: "BUY",
        size: 5,
        price: 200,
        ticker: "X",
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.tradeValue, 1000);
    });

    it("should convert negative commission to positive (absolute value)", () => {
      const raw = {
        execution_id: "EX003",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
        commission: -2.5,
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.brokerage, 2.5);
    });

    it("should set totalCharges equal to commission", () => {
      const raw = {
        execution_id: "EX004",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
        commission: -3.0,
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.totalCharges, 3.0);
    });

    it("should set exchangeFee, gst, sebiCharges, stampDuty, transactionTax to 0", () => {
      const raw = {
        execution_id: "EX005",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.exchangeFee, 0);
      assert.strictEqual(result.gst, 0);
      assert.strictEqual(result.sebiCharges, 0);
      assert.strictEqual(result.stampDuty, 0);
      assert.strictEqual(result.transactionTax, 0);
    });

    it("should set netAmount equal to tradeValue", () => {
      const raw = {
        execution_id: "EX006",
        side: "BUY",
        size: 10,
        price: 50,
        ticker: "X",
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.netAmount, 500);
    });

    it("should detect BOT as BUY", () => {
      const raw = {
        execution_id: "EX007",
        side: "BOT",
        size: 5,
        price: 100,
        ticker: "X",
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.transactionType, "BUY");
    });

    it("should detect SLD as SELL", () => {
      const raw = {
        execution_id: "EX008",
        side: "SLD",
        size: 5,
        price: 100,
        ticker: "X",
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should use shares field if size is missing", () => {
      const raw = {
        execution_id: "EX009",
        side: "BUY",
        shares: 7,
        price: 200,
        ticker: "X",
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.quantity, 7);
    });

    it("should use executionId as fallback for tradeId", () => {
      const raw = {
        executionId: "EXEC_123",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.tradeId, "EXEC_123");
    });

    it("should use order_ref as fallback for orderId", () => {
      const raw = {
        execution_id: "EX010",
        order_ref: "REF_456",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.orderId, "REF_456");
    });
  });

  // ---------- MF Support ----------
  describe("Mutual Fund Support", () => {
    it("should have mfSupport=false in broker info", () => {
      assert.strictEqual(info.mfSupport, false);
    });

    it("should not include MF in features", () => {
      assert.ok(!info.features.includes("MF"));
    });

    it("fetchMutualFunds should resolve to an empty array", async () => {
      const result = await adapter.fetchMutualFunds({ accessToken: "x" });
      assert.deepStrictEqual(result, []);
    });
  });

  // ---------- validateToken (mock branch) ----------
  describe("validateToken", () => {
    const savedId = process.env.INTERACTIVE_BROKERS_CLIENT_ID;
    const savedSecret = process.env.INTERACTIVE_BROKERS_CLIENT_SECRET;

    afterEach(() => {
      if (savedId !== undefined) {
        process.env.INTERACTIVE_BROKERS_CLIENT_ID = savedId;
      } else {
        delete process.env.INTERACTIVE_BROKERS_CLIENT_ID;
      }
      if (savedSecret !== undefined) {
        process.env.INTERACTIVE_BROKERS_CLIENT_SECRET = savedSecret;
      } else {
        delete process.env.INTERACTIVE_BROKERS_CLIENT_SECRET;
      }
    });

    it("should return true in mock mode (missing credentials)", async () => {
      // Remove a required key so shouldUseMockData("INTERACTIVE_BROKERS") is
      // true and the offline mock branch runs (no network).
      delete process.env.INTERACTIVE_BROKERS_CLIENT_ID;
      const result = await adapter.validateToken({ accessToken: "x" });
      assert.strictEqual(result, true);
    });
  });

  // ---------- Edge Cases ----------
  describe("Edge Cases", () => {
    it("should handle empty holdings array", () => {
      const holdings: Record<string, unknown>[] = [];
      assert.deepStrictEqual(holdings.map(mapIBKRHolding), []);
    });

    it("should handle empty positions array", () => {
      const positions: Record<string, unknown>[] = [];
      assert.deepStrictEqual(positions.map(mapIBKRPosition), []);
    });

    it("should handle empty trades array", () => {
      const trades: Record<string, unknown>[] = [];
      assert.deepStrictEqual(trades.map(mapIBKRTrade), []);
    });

    it("should handle holding with negative unrealizedPnl", () => {
      const raw = {
        ticker: "LOSS",
        position: 10,
        avgCost: 200,
        mktPrice: 180,
        unrealizedPnl: -200,
      };
      const result = mapIBKRHolding(raw);
      assert.strictEqual(result.pnl, -200);
      assert.strictEqual(result.pnlPercentage, -10);
    });

    it("should handle trade with zero commission", () => {
      const raw = {
        execution_id: "EX_ZERO",
        side: "BUY",
        size: 1,
        price: 100,
        ticker: "X",
        commission: 0,
      };
      const result = mapIBKRTrade(raw);
      assert.strictEqual(result.brokerage, 0);
      assert.strictEqual(result.totalCharges, 0);
    });
  });
});
