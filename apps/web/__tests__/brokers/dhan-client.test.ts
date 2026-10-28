/**
 * Dhan Adapter Tests — REAL SOURCE
 *
 * Exercises the REAL `DhanAdapter` class and the REAL exported normalization
 * helpers from `@usemoney/core/brokers`
 * (packages/core/src/brokers/adapters/dhan.ts) — NOT inline copies. Covers:
 * - Broker info (via the real getInfo())
 * - getAuthUrl()
 * - getAuthHeaders (via a probe subclass exposing the adapter's own private
 *   method; the default client-id falls back to DHAN_CLIENT_ID env)
 * - refreshAccessToken() error behaviour
 * - fetchMutualFunds() (always empty — Dhan has no MF API)
 * - supportsAutoRefresh / getRefreshStrategy / getTokenExpiryDuration
 * - normalizeDhan{Holding,Position,Order,Trade} — the real pure functions that
 *   the adapter's fetch* methods map each raw row through
 * - validateToken mock branch
 *
 * (Replaces the previous shadow version, which reimplemented BROKER_INFO and
 * every normalize/header function inline and asserted the copies.)
 *
 * Pure/offline: the only env-dependent branches exercised are the default
 * client-id fallback (DHAN_CLIENT_ID set/cleared, save/restore) and the
 * validateToken mock branch — no network, timers, or open handles.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DhanAdapter,
  normalizeDhanHolding,
  normalizeDhanPosition,
  normalizeDhanOrder,
  normalizeDhanTrade,
} from "@usemoney/core/brokers";
import type { BrokerCredentials } from "@usemoney/types";

// Probe subclass to reach the adapter's own private getAuthHeaders without
// reimplementing it.
class DhanProbe extends DhanAdapter {
  publicGetAuthHeaders(credentials: BrokerCredentials): Record<string, string> {
    return (
      this as unknown as {
        getAuthHeaders(c: BrokerCredentials): Record<string, string>;
      }
    ).getAuthHeaders(credentials);
  }
}

function withMockMode<T>(fn: () => T): T {
  const saved = process.env.DHAN_CLIENT_ID;
  delete process.env.DHAN_CLIENT_ID;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.DHAN_CLIENT_ID = saved;
  }
}

describe("DhanAdapter", () => {
  const adapter = new DhanAdapter();
  const info = adapter.getInfo();

  // ---------- Broker Info ----------
  describe("Broker Info", () => {
    it("should have id DHAN", () => {
      assert.strictEqual(info.id, "DHAN");
    });

    it("should have name Dhan", () => {
      assert.strictEqual(info.name, "Dhan");
    });

    it("should have correct color #00D09C", () => {
      assert.strictEqual(info.color, "#00D09C");
    });

    it("should have 4 segments", () => {
      assert.strictEqual(info.segments.length, 4);
    });

    it("should include Equity segment", () => {
      assert.ok(info.segments.includes("Equity"));
    });

    it("should include F&O segment", () => {
      assert.ok(info.segments.includes("F&O"));
    });

    it("should include Currency segment", () => {
      assert.ok(info.segments.includes("Currency"));
    });

    it("should include Commodity segment", () => {
      assert.ok(info.segments.includes("Commodity"));
    });

    it("should NOT include MF segment", () => {
      assert.ok(!info.segments.includes("MF"));
    });

    it("should have mfSupport=false", () => {
      assert.strictEqual(info.mfSupport, false);
    });

    it("should have autoRefresh=false", () => {
      assert.strictEqual(info.autoRefresh, false);
    });

    it("should have cost FREE", () => {
      assert.strictEqual(info.cost, "FREE");
    });

    it("should have tokenExpiry of 30 days", () => {
      assert.strictEqual(info.tokenExpiry, "30 days");
    });

    it("should have 4 features (no MF)", () => {
      assert.strictEqual(info.features.length, 4);
    });

    it("should include Holdings feature", () => {
      assert.ok(info.features.includes("Holdings"));
    });

    it("should include Positions feature", () => {
      assert.ok(info.features.includes("Positions"));
    });

    it("should include Orders feature", () => {
      assert.ok(info.features.includes("Orders"));
    });

    it("should include Trades feature", () => {
      assert.ok(info.features.includes("Trades"));
    });

    it("should NOT include MF feature", () => {
      assert.ok(!info.features.includes("MF"));
    });

    it("should have docsUrl", () => {
      assert.strictEqual(info.docsUrl, "https://dhanhq.co/docs/v1/");
    });
  });

  // ---------- Auth URL ----------
  describe("getAuthUrl", () => {
    it("should return dhanhq.co TradingView URL", () => {
      assert.strictEqual(adapter.getAuthUrl(), "https://dhanhq.co/tradingview");
    });

    it("should start with https://", () => {
      assert.ok(adapter.getAuthUrl().startsWith("https://"));
    });
  });

  // ---------- Auth Headers (API Key Auth, not OAuth) ----------
  describe("Auth Headers", () => {
    const probe = new DhanProbe();
    const savedClientId = process.env.DHAN_CLIENT_ID;

    /** Run getAuthHeaders with a deterministic DHAN_CLIENT_ID env default. */
    function headersWithDefault(
      defaultClientId: string,
      credentials: BrokerCredentials
    ): Record<string, string> {
      process.env.DHAN_CLIENT_ID = defaultClientId;
      try {
        return probe.publicGetAuthHeaders(credentials);
      } finally {
        if (savedClientId !== undefined)
          process.env.DHAN_CLIENT_ID = savedClientId;
        else delete process.env.DHAN_CLIENT_ID;
      }
    }

    it("should include access-token from credentials", () => {
      const headers = headersWithDefault("default-client", {
        accessToken: "my-dhan-token",
      });
      assert.strictEqual(headers["access-token"], "my-dhan-token");
    });

    it("should include client-id from credentials", () => {
      const headers = headersWithDefault("default-client", {
        accessToken: "tok",
        clientId: "my-client-id",
      });
      assert.strictEqual(headers["client-id"], "my-client-id");
    });

    it("should use default clientId (env) when credentials.clientId is missing", () => {
      const headers = headersWithDefault("env-client-id", {
        accessToken: "tok",
      });
      assert.strictEqual(headers["client-id"], "env-client-id");
    });

    it("should return empty access-token when accessToken is undefined", () => {
      const headers = headersWithDefault("client", {
        accessToken: undefined as unknown as string,
      });
      assert.strictEqual(headers["access-token"], "");
    });

    it("should produce exactly 2 headers", () => {
      const headers = headersWithDefault("default", {
        accessToken: "tok",
        clientId: "cid",
      });
      assert.strictEqual(Object.keys(headers).length, 2);
    });

    it("should NOT include Authorization Bearer header", () => {
      const headers = headersWithDefault("default", {
        accessToken: "tok",
        clientId: "cid",
      });
      assert.strictEqual(headers["Authorization"], undefined);
    });

    it("should NOT include Content-Type header", () => {
      const headers = headersWithDefault("default", {
        accessToken: "tok",
        clientId: "cid",
      });
      assert.strictEqual(headers["Content-Type"], undefined);
    });
  });

  // ---------- Refresh Access Token ----------
  describe("refreshAccessToken", () => {
    it("should return success=false", async () => {
      const result = await adapter.refreshAccessToken();
      assert.strictEqual(result.success, false);
    });

    it("should mention manual token renewal", async () => {
      const result = await adapter.refreshAccessToken();
      assert.ok(result.error!.includes("manual token renewal"));
    });

    it("should mention 30 days", async () => {
      const result = await adapter.refreshAccessToken();
      assert.ok(result.error!.includes("30 days"));
    });

    it("should mention Dhan", async () => {
      const result = await adapter.refreshAccessToken();
      assert.ok(result.error!.includes("Dhan"));
    });
  });

  // ---------- Mutual Funds (not supported) ----------
  describe("fetchMutualFunds", () => {
    it("should return empty array", async () => {
      const result = await adapter.fetchMutualFunds();
      assert.deepStrictEqual(result, []);
    });

    it("should return array with length 0", async () => {
      const result = await adapter.fetchMutualFunds();
      assert.strictEqual(result.length, 0);
    });
  });

  // ---------- Token Strategy ----------
  describe("Token Strategy", () => {
    it("supportsAutoRefresh should be false", () => {
      assert.strictEqual(adapter.supportsAutoRefresh(), false);
    });

    it("getRefreshStrategy should return MONTHLY", () => {
      assert.strictEqual(adapter.getRefreshStrategy(), "MONTHLY");
    });

    it("getTokenExpiryDuration should be 30 days in ms", () => {
      assert.strictEqual(
        adapter.getTokenExpiryDuration(),
        30 * 24 * 60 * 60 * 1000
      );
    });

    it("getTokenExpiryDuration should be 2592000000 ms", () => {
      assert.strictEqual(adapter.getTokenExpiryDuration(), 2592000000);
    });
  });

  // ---------- Holdings Normalization ----------
  describe("Holdings Normalization", () => {
    it("should normalize basic holding", () => {
      const raw = {
        tradingSymbol: "RELIANCE",
        isin: "INE002A01018",
        exchange: "NSE_EQ",
        totalQty: 10,
        availableQty: 10,
        t1Qty: 0,
        avgCostPrice: 2400,
        lastTradedPrice: 2500,
        unrealizedProfit: 1000,
      };
      const result = normalizeDhanHolding(raw);
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.totalQuantity, 10);
      assert.strictEqual(result.freeQuantity, 10);
      assert.strictEqual(result.averagePrice, 2400);
      assert.strictEqual(result.lastPrice, 2500);
    });

    it("should calculate pnlPercentage from avgCostPrice and lastTradedPrice", () => {
      const raw = {
        tradingSymbol: "INFY",
        exchange: "NSE_EQ",
        totalQty: 10,
        availableQty: 10,
        avgCostPrice: 1500,
        lastTradedPrice: 1650,
        unrealizedProfit: 1500,
      };
      const result = normalizeDhanHolding(raw);
      // (1650 - 1500) / 1500 * 100 = 10
      assert.strictEqual(result.pnlPercentage, 10);
    });

    it("should return pnlPercentage=0 when avgCostPrice is 0", () => {
      const raw = {
        tradingSymbol: "FREE",
        exchange: "NSE_EQ",
        totalQty: 5,
        availableQty: 5,
        avgCostPrice: 0,
        lastTradedPrice: 100,
      };
      const result = normalizeDhanHolding(raw);
      assert.strictEqual(result.pnlPercentage, 0);
    });

    it("should handle T1 quantities", () => {
      const raw = {
        tradingSymbol: "HDFC",
        exchange: "NSE_EQ",
        totalQty: 20,
        availableQty: 15,
        t1Qty: 5,
        avgCostPrice: 1600,
        lastTradedPrice: 1650,
      };
      const result = normalizeDhanHolding(raw);
      assert.strictEqual(result.t1Quantity, 5);
    });

    it("should default t1Quantity to 0 when missing", () => {
      const raw = {
        tradingSymbol: "TCS",
        exchange: "NSE_EQ",
        totalQty: 10,
        availableQty: 10,
        avgCostPrice: 3500,
        lastTradedPrice: 3600,
      };
      const result = normalizeDhanHolding(raw);
      assert.strictEqual(result.t1Quantity, 0);
    });

    it("should always set pledgedQuantity to 0", () => {
      const raw = {
        tradingSymbol: "SBIN",
        exchange: "NSE_EQ",
        totalQty: 50,
        availableQty: 50,
        avgCostPrice: 600,
        lastTradedPrice: 620,
      };
      const result = normalizeDhanHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 0);
    });

    it("should always set product to CNC", () => {
      const raw = {
        tradingSymbol: "TEST",
        exchange: "NSE_EQ",
        totalQty: 1,
        availableQty: 1,
        avgCostPrice: 100,
        lastTradedPrice: 105,
      };
      const result = normalizeDhanHolding(raw);
      assert.strictEqual(result.product, "CNC");
    });

    it("should set closePrice equal to lastTradedPrice", () => {
      const raw = {
        tradingSymbol: "TEST",
        exchange: "NSE_EQ",
        totalQty: 1,
        availableQty: 1,
        avgCostPrice: 100,
        lastTradedPrice: 110,
      };
      const result = normalizeDhanHolding(raw);
      assert.strictEqual(result.closePrice, result.lastPrice);
    });

    it("should handle negative pnl (loss)", () => {
      const raw = {
        tradingSymbol: "LOSS",
        exchange: "NSE_EQ",
        totalQty: 10,
        availableQty: 10,
        avgCostPrice: 200,
        lastTradedPrice: 150,
        unrealizedProfit: -500,
      };
      const result = normalizeDhanHolding(raw);
      assert.strictEqual(result.pnl, -500);
      assert.ok(result.pnlPercentage < 0);
    });
  });

  // ---------- Positions Normalization ----------
  describe("Positions Normalization", () => {
    it("should map NSE_EQ to CASH segment", () => {
      const raw = {
        tradingSymbol: "RELIANCE",
        exchangeSegment: "NSE_EQ",
        positionType: "LONG",
        productType: "CNC",
        buyQty: 10,
        sellQty: 0,
        netQty: 10,
        buyAvg: 2400,
        sellAvg: 0,
        costPrice: 2400,
        lastTradedPrice: 2450,
        realizedProfit: 0,
        unrealizedProfit: 500,
      };
      const result = normalizeDhanPosition(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should map non-NSE_EQ to FNO segment", () => {
      const raw = {
        tradingSymbol: "NIFTY25FEB25000CE",
        exchangeSegment: "NSE_FNO",
        positionType: "LONG",
        productType: "NRML",
        buyQty: 50,
        sellQty: 0,
        netQty: 50,
        buyAvg: 150,
        sellAvg: 0,
        costPrice: 150,
        lastTradedPrice: 165,
        realizedProfit: 0,
        unrealizedProfit: 750,
      };
      const result = normalizeDhanPosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should map LONG positionType to NET", () => {
      const raw = {
        tradingSymbol: "TEST",
        exchangeSegment: "NSE_EQ",
        positionType: "LONG",
        productType: "CNC",
        buyQty: 10,
        sellQty: 0,
        netQty: 10,
        buyAvg: 100,
        sellAvg: 0,
        costPrice: 100,
        lastTradedPrice: 105,
        realizedProfit: 0,
        unrealizedProfit: 50,
      };
      const result = normalizeDhanPosition(raw);
      assert.strictEqual(result.positionType, "NET");
    });

    it("should map non-LONG positionType to DAY", () => {
      const raw = {
        tradingSymbol: "TEST",
        exchangeSegment: "NSE_EQ",
        positionType: "SHORT",
        productType: "INTRADAY",
        buyQty: 0,
        sellQty: 10,
        netQty: -10,
        buyAvg: 0,
        sellAvg: 100,
        costPrice: 100,
        lastTradedPrice: 95,
        realizedProfit: 0,
        unrealizedProfit: 50,
      };
      const result = normalizeDhanPosition(raw);
      assert.strictEqual(result.positionType, "DAY");
    });

    it("should handle MCX exchange segment as FNO", () => {
      const raw = {
        tradingSymbol: "GOLDM25FEB",
        exchangeSegment: "MCX",
        positionType: "LONG",
        productType: "NRML",
        buyQty: 1,
        sellQty: 0,
        netQty: 1,
        buyAvg: 59000,
        sellAvg: 0,
        costPrice: 59000,
        lastTradedPrice: 59500,
        realizedProfit: 0,
        unrealizedProfit: 500,
      };
      const result = normalizeDhanPosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });
  });

  // ---------- Orders Normalization ----------
  describe("Orders Normalization", () => {
    it("should normalize basic order", () => {
      const raw = {
        orderId: "DORD001",
        tradingSymbol: "RELIANCE",
        exchangeSegment: "NSE_EQ",
        orderType: "LIMIT",
        transactionType: "BUY",
        productType: "CNC",
        quantity: 10,
        filledQty: 10,
        price: 2400,
        triggerPrice: 0,
        avgTradedPrice: 2400,
        orderStatus: "TRADED",
        validity: "DAY",
        orderTimestamp: "2024-01-15T10:30:00+05:30",
      };
      const result = normalizeDhanOrder(raw);
      assert.strictEqual(result.orderId, "DORD001");
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.transactionType, "BUY");
    });

    it("should always set variety to regular", () => {
      const raw = {
        orderId: "DORD002",
        tradingSymbol: "INFY",
        exchangeSegment: "NSE_EQ",
        orderType: "MARKET",
        transactionType: "SELL",
        productType: "MIS",
        quantity: 5,
        filledQty: 5,
        price: 0,
        avgTradedPrice: 1520,
        orderStatus: "TRADED",
        validity: "DAY",
        orderTimestamp: "2024-01-15T14:00:00+05:30",
      };
      const result = normalizeDhanOrder(raw);
      assert.strictEqual(result.variety, "regular");
    });

    it("should map NSE_EQ segment to CASH", () => {
      const raw = {
        orderId: "DORD003",
        tradingSymbol: "TCS",
        exchangeSegment: "NSE_EQ",
        orderType: "LIMIT",
        transactionType: "BUY",
        productType: "CNC",
        quantity: 1,
        filledQty: 0,
        price: 3500,
        avgTradedPrice: 0,
        orderStatus: "PENDING",
        validity: "DAY",
        orderTimestamp: "2024-01-15T09:30:00+05:30",
      };
      const result = normalizeDhanOrder(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should map FNO segment correctly", () => {
      const raw = {
        orderId: "DORD004",
        tradingSymbol: "NIFTY25FEB25000CE",
        exchangeSegment: "NSE_FNO",
        orderType: "MARKET",
        transactionType: "BUY",
        productType: "NRML",
        quantity: 50,
        filledQty: 50,
        price: 0,
        avgTradedPrice: 150,
        orderStatus: "TRADED",
        validity: "DAY",
        orderTimestamp: "2024-01-15T10:00:00+05:30",
      };
      const result = normalizeDhanOrder(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should parse orderTimestamp as Date", () => {
      const raw = {
        orderId: "DORD005",
        tradingSymbol: "TEST",
        exchangeSegment: "NSE_EQ",
        orderType: "MARKET",
        transactionType: "BUY",
        productType: "CNC",
        quantity: 1,
        filledQty: 1,
        price: 0,
        avgTradedPrice: 100,
        orderStatus: "TRADED",
        validity: "DAY",
        orderTimestamp: "2024-01-15T10:00:00",
      };
      const result = normalizeDhanOrder(raw);
      assert.ok(result.orderTime instanceof Date);
    });
  });

  // ---------- Trades Normalization ----------
  describe("Trades Normalization", () => {
    it("should normalize basic trade", () => {
      const raw = {
        tradeId: "DT001",
        orderId: "DORD001",
        tradingSymbol: "RELIANCE",
        exchangeSegment: "NSE_EQ",
        transactionType: "BUY",
        productType: "CNC",
        tradedQty: 10,
        tradedPrice: 2450.75,
        tradeTimestamp: "2024-01-15T10:30:05+05:30",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.tradeId, "DT001");
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.quantity, 10);
      assert.strictEqual(result.price, 2450.75);
    });

    it("should calculate tradeValue as tradedQty * tradedPrice", () => {
      const raw = {
        tradeId: "DT002",
        orderId: "DORD002",
        tradingSymbol: "INFY",
        exchangeSegment: "NSE_EQ",
        transactionType: "BUY",
        productType: "CNC",
        tradedQty: 5,
        tradedPrice: 1500,
        tradeTimestamp: "2024-01-15T11:00:00",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.tradeValue, 7500);
    });

    it("should have fixed brokerage of 20", () => {
      const raw = {
        tradeId: "DT003",
        orderId: "DORD003",
        tradingSymbol: "TCS",
        exchangeSegment: "NSE_EQ",
        transactionType: "SELL",
        productType: "CNC",
        tradedQty: 1,
        tradedPrice: 3600,
        tradeTimestamp: "2024-01-15T14:00:00",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.brokerage, 20);
    });

    it("should have fixed GST of 3.6", () => {
      const raw = {
        tradeId: "DT004",
        orderId: "DORD004",
        tradingSymbol: "HDFC",
        exchangeSegment: "NSE_EQ",
        transactionType: "BUY",
        productType: "CNC",
        tradedQty: 2,
        tradedPrice: 1600,
        tradeTimestamp: "2024-01-15T10:00:00",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.gst, 3.6);
    });

    it("should have totalCharges of 23.6", () => {
      const raw = {
        tradeId: "DT005",
        orderId: "DORD005",
        tradingSymbol: "SBIN",
        exchangeSegment: "NSE_EQ",
        transactionType: "BUY",
        productType: "CNC",
        tradedQty: 10,
        tradedPrice: 600,
        tradeTimestamp: "2024-01-15T09:30:00",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.totalCharges, 23.6);
    });

    it("should set netAmount equal to tradeValue", () => {
      const raw = {
        tradeId: "DT006",
        orderId: "DORD006",
        tradingSymbol: "TEST",
        exchangeSegment: "NSE_EQ",
        transactionType: "BUY",
        productType: "CNC",
        tradedQty: 100,
        tradedPrice: 50,
        tradeTimestamp: "2024-01-15T10:00:00",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.netAmount, result.tradeValue);
      assert.strictEqual(result.netAmount, 5000);
    });

    it("should map NSE_EQ segment to CASH in trades", () => {
      const raw = {
        tradeId: "DT007",
        orderId: "DORD007",
        tradingSymbol: "RELIANCE",
        exchangeSegment: "NSE_EQ",
        transactionType: "BUY",
        productType: "CNC",
        tradedQty: 1,
        tradedPrice: 2400,
        tradeTimestamp: "2024-01-15T10:00:00",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should map non-NSE_EQ to FNO in trades", () => {
      const raw = {
        tradeId: "DT008",
        orderId: "DORD008",
        tradingSymbol: "NIFTY25FEB25000CE",
        exchangeSegment: "NSE_FNO",
        transactionType: "BUY",
        productType: "NRML",
        tradedQty: 50,
        tradedPrice: 150,
        tradeTimestamp: "2024-01-15T10:00:00",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should parse tradeTimestamp as Date", () => {
      const raw = {
        tradeId: "DT009",
        orderId: "DORD009",
        tradingSymbol: "TEST",
        exchangeSegment: "NSE_EQ",
        transactionType: "BUY",
        productType: "CNC",
        tradedQty: 1,
        tradedPrice: 100,
        tradeTimestamp: "2024-01-15T10:00:00+05:30",
      };
      const result = normalizeDhanTrade(raw);
      assert.ok(result.tradeTime instanceof Date);
    });

    it("should set exchangeFee, sebiCharges, stampDuty, transactionTax to 0", () => {
      const raw = {
        tradeId: "DT010",
        orderId: "DORD010",
        tradingSymbol: "TEST",
        exchangeSegment: "NSE_EQ",
        transactionType: "BUY",
        productType: "CNC",
        tradedQty: 1,
        tradedPrice: 100,
        tradeTimestamp: "2024-01-15T10:00:00",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.exchangeFee, 0);
      assert.strictEqual(result.sebiCharges, 0);
      assert.strictEqual(result.stampDuty, 0);
      assert.strictEqual(result.transactionTax, 0);
    });
  });

  // ---------- validateToken (mock branch) ----------
  describe("validateToken", () => {
    it("should return true in mock mode", async () => {
      const result = await withMockMode(() =>
        adapter.validateToken({ accessToken: "x" })
      );
      assert.strictEqual(result, true);
    });
  });

  // ---------- Edge Cases ----------
  describe("Edge Cases", () => {
    it("should handle empty holdings array", () => {
      const holdings: Record<string, unknown>[] = [];
      assert.deepStrictEqual(holdings.map(normalizeDhanHolding), []);
    });

    it("should handle empty positions array", () => {
      const positions: Record<string, unknown>[] = [];
      assert.deepStrictEqual(positions.map(normalizeDhanPosition), []);
    });

    it("should handle empty trades array", () => {
      const trades: Record<string, unknown>[] = [];
      assert.deepStrictEqual(trades.map(normalizeDhanTrade), []);
    });

    it("should handle holding with very large quantity", () => {
      const raw = {
        tradingSymbol: "LARGE",
        exchange: "NSE_EQ",
        totalQty: 1000000,
        availableQty: 1000000,
        avgCostPrice: 100,
        lastTradedPrice: 105,
        unrealizedProfit: 5000000,
      };
      const result = normalizeDhanHolding(raw);
      assert.strictEqual(result.totalQuantity, 1000000);
    });

    it("should handle trade with zero quantity", () => {
      const raw = {
        tradeId: "DT_ZERO",
        orderId: "DORD_ZERO",
        tradingSymbol: "ZERO",
        exchangeSegment: "NSE_EQ",
        transactionType: "BUY",
        productType: "CNC",
        tradedQty: 0,
        tradedPrice: 100,
        tradeTimestamp: "2024-01-15T10:00:00",
      };
      const result = normalizeDhanTrade(raw);
      assert.strictEqual(result.tradeValue, 0);
      assert.strictEqual(result.netAmount, 0);
    });

    it("should handle decimal prices", () => {
      const raw = {
        tradingSymbol: "DEC",
        exchange: "NSE_EQ",
        totalQty: 10,
        availableQty: 10,
        avgCostPrice: 100.55,
        lastTradedPrice: 105.75,
        unrealizedProfit: 52,
      };
      const result = normalizeDhanHolding(raw);
      assert.ok(result.pnlPercentage > 0);
    });
  });
});
