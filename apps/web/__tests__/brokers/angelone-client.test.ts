/**
 * Angel One Adapter Tests — REAL SOURCE
 *
 * Exercises the REAL `AngelOneAdapter` class and the REAL exported normalization
 * helpers from `@usemoney/core/brokers`
 * (packages/core/src/brokers/adapters/angel-one.ts) — NOT inline copies. Covers:
 * - Broker info (via the real getInfo())
 * - getAuthUrl()
 * - getAuthHeaders (via a probe subclass exposing the adapter's own private
 *   method; X-PrivateKey is read from ANGEL_API_KEY env)
 * - normalizeAngelOne{Holding,Position,Order,Trade} — the real pure functions
 *   that the adapter's fetch* methods map each raw row through
 * - getEndOfDay helper (protected, via the probe) + getTokenExpiryDuration
 * - token/refresh strategy + refreshAccessToken (real no-refresh-token branch)
 * - validateToken + fetchMutualFunds mock branches
 *
 * (Replaces the previous shadow version, which reimplemented BROKER_INFO and
 * every normalize/header function inline and asserted the copies — so it stayed
 * green even as the real adapter drifted, e.g. autoRefresh-strategy now
 * TOKEN_REFRESH / supportsAutoRefresh true, and a different refresh error.)
 *
 * Pure/offline: the only env-dependent branches exercised are the mock paths for
 * validateToken + fetchMutualFunds (ANGEL_API_KEY removed inside those tests,
 * save/restore) and a deliberately-set ANGEL_API_KEY for the header test — no
 * network, timers, or open handles.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AngelOneAdapter,
  normalizeAngelOneHolding,
  normalizeAngelOnePosition,
  normalizeAngelOneOrder,
  normalizeAngelOneTrade,
} from "@usemoney/core/brokers";
import type { BrokerCredentials } from "@usemoney/types";

// Probe subclass to reach the adapter's own private getAuthHeaders and the
// protected getEndOfDay helper without reimplementing them.
class AngelOneProbe extends AngelOneAdapter {
  publicGetAuthHeaders(credentials: BrokerCredentials): Record<string, string> {
    return (
      this as unknown as {
        getAuthHeaders(c: BrokerCredentials): Record<string, string>;
      }
    ).getAuthHeaders(credentials);
  }
  publicGetEndOfDay(): Date {
    return (this as unknown as { getEndOfDay(): Date }).getEndOfDay();
  }
}

function withMockMode<T>(fn: () => T): T {
  const saved = process.env.ANGEL_API_KEY;
  delete process.env.ANGEL_API_KEY;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.ANGEL_API_KEY = saved;
  }
}

describe("AngelOneAdapter", () => {
  const adapter = new AngelOneAdapter();
  const info = adapter.getInfo();

  // ---------- Broker Info ----------
  describe("Broker Info", () => {
    it("should have id ANGEL_ONE", () => {
      assert.strictEqual(info.id, "ANGEL_ONE");
    });

    it("should have name Angel One", () => {
      assert.strictEqual(info.name, "Angel One");
    });

    it("should have correct color", () => {
      assert.strictEqual(info.color, "#ED1C24");
    });

    it("should support 5 segments", () => {
      assert.strictEqual(info.segments.length, 5);
    });

    it("should include Equity segment", () => {
      assert.ok(info.segments.includes("Equity"));
    });

    it("should include F&O segment", () => {
      assert.ok(info.segments.includes("F&O"));
    });

    it("should include MF segment", () => {
      assert.ok(info.segments.includes("MF"));
    });

    it("should have mfSupport=true", () => {
      assert.strictEqual(info.mfSupport, true);
    });

    it("should have autoRefresh=false", () => {
      assert.strictEqual(info.autoRefresh, false);
    });

    it("should have cost FREE", () => {
      assert.strictEqual(info.cost, "FREE");
    });

    it("should have token expiry mentioning midnight", () => {
      assert.ok(info.tokenExpiry.includes("midnight"));
    });

    it("should have docsUrl pointing to SmartAPI", () => {
      assert.strictEqual(info.docsUrl, "https://smartapi.angelone.in/docs");
    });

    it("should have 5 features", () => {
      assert.strictEqual(info.features.length, 5);
    });

    it("should include Holdings feature", () => {
      assert.ok(info.features.includes("Holdings"));
    });

    it("should include MF feature", () => {
      assert.ok(info.features.includes("MF"));
    });
  });

  // ---------- Auth URL ----------
  describe("getAuthUrl", () => {
    it("should return the SmartAPI URL", () => {
      assert.strictEqual(adapter.getAuthUrl(), "https://smartapi.angelone.in/");
    });

    it("should start with https://", () => {
      assert.ok(adapter.getAuthUrl().startsWith("https://"));
    });
  });

  // ---------- Auth Headers ----------
  describe("Auth Header Construction", () => {
    const probe = new AngelOneProbe();
    const savedKey = process.env.ANGEL_API_KEY;

    function headersWithApiKey(
      apiKey: string,
      credentials: BrokerCredentials
    ): Record<string, string> {
      process.env.ANGEL_API_KEY = apiKey;
      try {
        return probe.publicGetAuthHeaders(credentials);
      } finally {
        if (savedKey !== undefined) process.env.ANGEL_API_KEY = savedKey;
        else delete process.env.ANGEL_API_KEY;
      }
    }

    it("should include Bearer token in Authorization", () => {
      const headers = headersWithApiKey("api-key-123", {
        accessToken: "my-jwt-token",
      });
      assert.strictEqual(headers["Authorization"], "Bearer my-jwt-token");
    });

    it("should include Content-Type application/json", () => {
      const headers = headersWithApiKey("key", { accessToken: "tok" });
      assert.strictEqual(headers["Content-Type"], "application/json");
    });

    it("should include Accept application/json", () => {
      const headers = headersWithApiKey("key", { accessToken: "tok" });
      assert.strictEqual(headers["Accept"], "application/json");
    });

    it("should include X-UserType USER", () => {
      const headers = headersWithApiKey("key", { accessToken: "tok" });
      assert.strictEqual(headers["X-UserType"], "USER");
    });

    it("should include X-SourceID WEB", () => {
      const headers = headersWithApiKey("key", { accessToken: "tok" });
      assert.strictEqual(headers["X-SourceID"], "WEB");
    });

    it("should include X-ClientLocalIP 127.0.0.1", () => {
      const headers = headersWithApiKey("key", { accessToken: "tok" });
      assert.strictEqual(headers["X-ClientLocalIP"], "127.0.0.1");
    });

    it("should include X-ClientPublicIP 127.0.0.1", () => {
      const headers = headersWithApiKey("key", { accessToken: "tok" });
      assert.strictEqual(headers["X-ClientPublicIP"], "127.0.0.1");
    });

    it("should include X-MACAddress 00:00:00:00:00:00", () => {
      const headers = headersWithApiKey("key", { accessToken: "tok" });
      assert.strictEqual(headers["X-MACAddress"], "00:00:00:00:00:00");
    });

    it("should include X-PrivateKey from the ANGEL_API_KEY env", () => {
      const headers = headersWithApiKey("my-api-key", { accessToken: "tok" });
      assert.strictEqual(headers["X-PrivateKey"], "my-api-key");
    });

    it("should produce exactly 9 headers", () => {
      const headers = headersWithApiKey("key", { accessToken: "tok" });
      assert.strictEqual(Object.keys(headers).length, 9);
    });

    it("should handle empty accessToken", () => {
      const headers = headersWithApiKey("key", { accessToken: "" });
      assert.strictEqual(headers["Authorization"], "Bearer ");
    });

    it("should handle empty apiKey env", () => {
      const headers = headersWithApiKey("", { accessToken: "tok" });
      assert.strictEqual(headers["X-PrivateKey"], "");
    });
  });

  // ---------- Holdings Normalization ----------
  describe("Holdings Normalization", () => {
    it("should normalize basic holding", () => {
      const raw = {
        tradingsymbol: "RELIANCE",
        isin: "INE002A01018",
        exchange: "NSE",
        quantity: 10,
        t1quantity: 0,
        collateralquantity: 0,
        averageprice: 2400,
        ltp: 2500,
        close: 2480,
        profitandloss: 1000,
        pnlpercentage: 4.17,
        product: "CNC",
      };
      const result = normalizeAngelOneHolding(raw);
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.totalQuantity, 10);
      assert.strictEqual(result.averagePrice, 2400);
      assert.strictEqual(result.lastPrice, 2500);
      assert.strictEqual(result.pnl, 1000);
    });

    it("should calculate freeQuantity excluding t1", () => {
      const raw = {
        tradingsymbol: "INFY",
        exchange: "NSE",
        quantity: 20,
        t1quantity: 5,
        averageprice: 1500,
        ltp: 1550,
      };
      const result = normalizeAngelOneHolding(raw);
      assert.strictEqual(result.totalQuantity, 20);
      assert.strictEqual(result.freeQuantity, 15);
      assert.strictEqual(result.t1Quantity, 5);
    });

    it("should handle missing t1quantity (default 0)", () => {
      const raw = {
        tradingsymbol: "TCS",
        exchange: "NSE",
        quantity: 10,
        averageprice: 3500,
        ltp: 3600,
      };
      const result = normalizeAngelOneHolding(raw);
      assert.strictEqual(result.freeQuantity, 10);
      assert.strictEqual(result.t1Quantity, 0);
    });

    it("should handle collateral quantity", () => {
      const raw = {
        tradingsymbol: "SBIN",
        exchange: "NSE",
        quantity: 50,
        collateralquantity: 20,
        averageprice: 600,
        ltp: 620,
      };
      const result = normalizeAngelOneHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 20);
    });

    it("should handle missing collateralquantity (default 0)", () => {
      const raw = {
        tradingsymbol: "HDFC",
        exchange: "NSE",
        quantity: 10,
        averageprice: 1600,
        ltp: 1650,
      };
      const result = normalizeAngelOneHolding(raw);
      assert.strictEqual(result.pledgedQuantity, 0);
    });

    it("should set tradingSymbol same as symbol", () => {
      const raw = {
        tradingsymbol: "TATAMOTORS",
        exchange: "NSE",
        quantity: 5,
        averageprice: 600,
        ltp: 650,
      };
      const result = normalizeAngelOneHolding(raw);
      assert.strictEqual(result.tradingSymbol, result.symbol);
    });
  });

  // ---------- Positions Normalization ----------
  describe("Positions Normalization", () => {
    it("should normalize basic position", () => {
      const raw = {
        tradingsymbol: "RELIANCE",
        exchange: "NSE",
        symboltoken: "NSE:RELIANCE",
        producttype: "CNC",
        buyqty: 10,
        sellqty: 0,
        netqty: 10,
        buyavgprice: 2400,
        sellavgprice: 0,
        avgnetprice: 2400,
        ltp: 2450,
        realised: 0,
        unrealised: 500,
      };
      const result = normalizeAngelOnePosition(raw);
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.netQuantity, 10);
      assert.strictEqual(result.averagePrice, 2400);
    });

    it("should detect CASH segment for NSE symboltoken", () => {
      const raw = {
        tradingsymbol: "INFY",
        exchange: "NSE",
        symboltoken: "NSE:INFY",
        producttype: "MIS",
        buyqty: 5,
        sellqty: 0,
        netqty: 5,
        buyavgprice: 1500,
        sellavgprice: 0,
        avgnetprice: 1500,
        ltp: 1520,
        realised: 0,
        unrealised: 100,
      };
      const result = normalizeAngelOnePosition(raw);
      assert.strictEqual(result.segment, "CASH");
    });

    it("should detect FNO segment for non-NSE symboltoken", () => {
      const raw = {
        tradingsymbol: "NIFTY25FEB25000CE",
        exchange: "NFO",
        symboltoken: "NFO:NIFTY25FEB25000CE",
        producttype: "NRML",
        buyqty: 50,
        sellqty: 0,
        netqty: 50,
        buyavgprice: 150,
        sellavgprice: 0,
        avgnetprice: 150,
        ltp: 165,
        realised: 0,
        unrealised: 750,
      };
      const result = normalizeAngelOnePosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });

    it("should always set positionType to NET", () => {
      const raw = {
        tradingsymbol: "TEST",
        exchange: "NSE",
        symboltoken: "NSE:TEST",
        producttype: "MIS",
        buyqty: 10,
        sellqty: 5,
        netqty: 5,
        buyavgprice: 100,
        sellavgprice: 110,
        avgnetprice: 100,
        ltp: 105,
        realised: 50,
        unrealised: 25,
      };
      const result = normalizeAngelOnePosition(raw);
      assert.strictEqual(result.positionType, "NET");
    });

    it("should handle sell-side positions (short)", () => {
      const raw = {
        tradingsymbol: "RELIANCE",
        exchange: "NSE",
        symboltoken: "NSE:RELIANCE",
        producttype: "MIS",
        buyqty: 0,
        sellqty: 10,
        netqty: -10,
        buyavgprice: 0,
        sellavgprice: 2500,
        avgnetprice: 2500,
        ltp: 2480,
        realised: 0,
        unrealised: 200,
      };
      const result = normalizeAngelOnePosition(raw);
      assert.strictEqual(result.netQuantity, -10);
      assert.strictEqual(result.sellQuantity, 10);
    });

    it("should handle undefined symboltoken (defaults to FNO)", () => {
      const raw = {
        tradingsymbol: "TEST",
        exchange: "NSE",
        producttype: "CNC",
        buyqty: 1,
        sellqty: 0,
        netqty: 1,
        buyavgprice: 100,
        sellavgprice: 0,
        avgnetprice: 100,
        ltp: 105,
        realised: 0,
        unrealised: 5,
      };
      const result = normalizeAngelOnePosition(raw);
      assert.strictEqual(result.segment, "FNO");
    });
  });

  // ---------- Orders Normalization ----------
  describe("Orders Normalization", () => {
    it("should normalize basic order", () => {
      const raw = {
        orderid: "ORD001",
        tradingsymbol: "RELIANCE",
        exchange: "NSE",
        symboltoken: "NSE:RELIANCE",
        ordertype: "LIMIT",
        transactiontype: "BUY",
        producttype: "CNC",
        variety: "NORMAL",
        quantity: 10,
        filledshares: 10,
        price: 2400,
        triggerprice: 0,
        averageprice: 2400,
        status: "complete",
        text: "",
        validity: "DAY",
        ordertime: "2024-01-15 10:30:00",
      };
      const result = normalizeAngelOneOrder(raw);
      assert.strictEqual(result.orderId, "ORD001");
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.transactionType, "BUY");
      assert.strictEqual(result.quantity, 10);
      assert.strictEqual(result.filledQuantity, 10);
    });

    it("should handle SELL orders", () => {
      const raw = {
        orderid: "ORD002",
        tradingsymbol: "INFY",
        exchange: "NSE",
        symboltoken: "NSE:INFY",
        ordertype: "MARKET",
        transactiontype: "SELL",
        producttype: "MIS",
        variety: "NORMAL",
        quantity: 5,
        filledshares: 5,
        price: 0,
        averageprice: 1520,
        status: "complete",
        validity: "DAY",
        ordertime: "2024-01-15 14:00:00",
      };
      const result = normalizeAngelOneOrder(raw);
      assert.strictEqual(result.transactionType, "SELL");
    });

    it("should use updatetime fallback when ordertime is missing", () => {
      const raw = {
        orderid: "ORD003",
        tradingsymbol: "TCS",
        exchange: "NSE",
        symboltoken: "NSE:TCS",
        ordertype: "LIMIT",
        transactiontype: "BUY",
        producttype: "CNC",
        variety: "NORMAL",
        quantity: 1,
        filledshares: 0,
        price: 3500,
        averageprice: 0,
        status: "open",
        validity: "DAY",
        updatetime: "2024-01-15 09:30:00",
      };
      const result = normalizeAngelOneOrder(raw);
      assert.ok(result.orderTime instanceof Date);
    });

    it("should detect CASH segment for NSE symboltoken in orders", () => {
      const raw = {
        orderid: "ORD004",
        tradingsymbol: "SBIN",
        exchange: "NSE",
        symboltoken: "NSE:SBIN",
        ordertype: "MARKET",
        transactiontype: "BUY",
        producttype: "CNC",
        variety: "NORMAL",
        quantity: 20,
        filledshares: 20,
        price: 0,
        averageprice: 600,
        status: "complete",
        validity: "DAY",
        ordertime: "2024-01-15 10:00:00",
      };
      const result = normalizeAngelOneOrder(raw);
      assert.strictEqual(result.segment, "CASH");
    });
  });

  // ---------- Trades Normalization ----------
  describe("Trades Normalization", () => {
    it("should normalize basic trade", () => {
      const raw = {
        tradeid: "T001",
        orderid: "ORD001",
        tradingsymbol: "RELIANCE",
        exchange: "NSE",
        symboltoken: "NSE:RELIANCE",
        transactiontype: "BUY",
        producttype: "CNC",
        fillshares: 10,
        fillprice: 2450.75,
        filltime: "2024-01-15 10:30:05",
      };
      const result = normalizeAngelOneTrade(raw);
      assert.strictEqual(result.tradeId, "T001");
      assert.strictEqual(result.orderId, "ORD001");
      assert.strictEqual(result.quantity, 10);
      assert.strictEqual(result.price, 2450.75);
    });

    it("should calculate tradeValue as fillshares * fillprice", () => {
      const raw = {
        tradeid: "T002",
        orderid: "ORD002",
        tradingsymbol: "INFY",
        exchange: "NSE",
        symboltoken: "NSE:INFY",
        transactiontype: "BUY",
        producttype: "CNC",
        fillshares: 5,
        fillprice: 1500,
        filltime: "2024-01-15 11:00:00",
      };
      const result = normalizeAngelOneTrade(raw);
      assert.strictEqual(result.tradeValue, 7500);
    });

    it("should have fixed brokerage of 20", () => {
      const raw = {
        tradeid: "T003",
        orderid: "ORD003",
        tradingsymbol: "TCS",
        exchange: "NSE",
        symboltoken: "NSE:TCS",
        transactiontype: "SELL",
        producttype: "CNC",
        fillshares: 1,
        fillprice: 3600,
        filltime: "2024-01-15 14:00:00",
      };
      const result = normalizeAngelOneTrade(raw);
      assert.strictEqual(result.brokerage, 20);
    });

    it("should have fixed GST of 3.6", () => {
      const raw = {
        tradeid: "T004",
        orderid: "ORD004",
        tradingsymbol: "HDFC",
        exchange: "NSE",
        symboltoken: "NSE:HDFC",
        transactiontype: "BUY",
        producttype: "CNC",
        fillshares: 2,
        fillprice: 1600,
        filltime: "2024-01-15 10:00:00",
      };
      const result = normalizeAngelOneTrade(raw);
      assert.strictEqual(result.gst, 3.6);
    });

    it("should have totalCharges of 23.6", () => {
      const raw = {
        tradeid: "T005",
        orderid: "ORD005",
        tradingsymbol: "SBIN",
        exchange: "NSE",
        symboltoken: "NSE:SBIN",
        transactiontype: "BUY",
        producttype: "CNC",
        fillshares: 10,
        fillprice: 600,
        filltime: "2024-01-15 09:30:00",
      };
      const result = normalizeAngelOneTrade(raw);
      assert.strictEqual(result.totalCharges, 23.6);
    });

    it("should set netAmount equal to tradeValue", () => {
      const raw = {
        tradeid: "T006",
        orderid: "ORD006",
        tradingsymbol: "TEST",
        exchange: "NSE",
        symboltoken: "NSE:TEST",
        transactiontype: "BUY",
        producttype: "CNC",
        fillshares: 100,
        fillprice: 50,
        filltime: "2024-01-15 10:00:00",
      };
      const result = normalizeAngelOneTrade(raw);
      assert.strictEqual(result.netAmount, result.tradeValue);
      assert.strictEqual(result.netAmount, 5000);
    });

    it("should use exchangeorderupdatetime as fallback for tradeTime", () => {
      const raw = {
        tradeid: "T007",
        orderid: "ORD007",
        tradingsymbol: "TEST",
        exchange: "NSE",
        symboltoken: "NSE:TEST",
        transactiontype: "BUY",
        producttype: "CNC",
        fillshares: 1,
        fillprice: 100,
        exchangeorderupdatetime: "2024-01-15 10:30:00",
      };
      const result = normalizeAngelOneTrade(raw);
      assert.ok(result.tradeTime instanceof Date);
    });

    it("should set exchangeFee, sebiCharges, stampDuty, transactionTax to 0", () => {
      const raw = {
        tradeid: "T008",
        orderid: "ORD008",
        tradingsymbol: "TEST",
        exchange: "NSE",
        symboltoken: "NSE:TEST",
        transactiontype: "BUY",
        producttype: "CNC",
        fillshares: 1,
        fillprice: 100,
        filltime: "2024-01-15 10:00:00",
      };
      const result = normalizeAngelOneTrade(raw);
      assert.strictEqual(result.exchangeFee, 0);
      assert.strictEqual(result.sebiCharges, 0);
      assert.strictEqual(result.stampDuty, 0);
      assert.strictEqual(result.transactionTax, 0);
    });
  });

  // ---------- Token & Refresh Strategy ----------
  describe("Token and Refresh Strategy", () => {
    it("refreshAccessToken with no refreshToken should return success=false", async () => {
      const result = await adapter.refreshAccessToken({ accessToken: "x" });
      assert.strictEqual(result.success, false);
    });

    it("refreshAccessToken should mention TOTP re-authentication when no refresh token", async () => {
      const result = await adapter.refreshAccessToken({ accessToken: "x" });
      assert.ok(result.error);
      assert.ok(result.error!.includes("TOTP re-authentication required"));
    });

    it("getEndOfDay should return end of today", () => {
      const eod = new AngelOneProbe().publicGetEndOfDay();
      assert.strictEqual(eod.getHours(), 23);
      assert.strictEqual(eod.getMinutes(), 59);
      assert.strictEqual(eod.getSeconds(), 59);
      assert.strictEqual(eod.getMilliseconds(), 999);
    });

    it("getTokenExpiryDuration should return positive value", () => {
      const duration = adapter.getTokenExpiryDuration();
      assert.ok(duration > 0, "Duration should be positive");
    });

    it("getTokenExpiryDuration should be less than 24 hours", () => {
      const duration = adapter.getTokenExpiryDuration();
      assert.ok(
        duration < 24 * 60 * 60 * 1000,
        "Duration should be less than 24 hours"
      );
    });

    it("supportsAutoRefresh should be true (generateTokens API)", () => {
      assert.strictEqual(adapter.supportsAutoRefresh(), true);
    });

    it("getRefreshStrategy should be TOKEN_REFRESH", () => {
      assert.strictEqual(adapter.getRefreshStrategy(), "TOKEN_REFRESH");
    });
  });

  // ---------- Mock-Branch Methods ----------
  describe("Mock-branch methods", () => {
    it("validateToken should return true in mock mode", async () => {
      const result = await withMockMode(() =>
        adapter.validateToken({ accessToken: "x" })
      );
      assert.strictEqual(result, true);
    });

    it("fetchMutualFunds should return mock funds in mock mode", async () => {
      const result = await withMockMode(() =>
        adapter.fetchMutualFunds({ accessToken: "x" })
      );
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 5);
    });
  });

  // ---------- Edge Cases ----------
  describe("Edge Cases", () => {
    it("should handle empty holdings array", () => {
      const holdings: Record<string, unknown>[] = [];
      assert.deepStrictEqual(holdings.map(normalizeAngelOneHolding), []);
    });

    it("should handle empty positions array", () => {
      const positions: Record<string, unknown>[] = [];
      assert.deepStrictEqual(positions.map(normalizeAngelOnePosition), []);
    });

    it("should handle empty trades array", () => {
      const trades: Record<string, unknown>[] = [];
      assert.deepStrictEqual(trades.map(normalizeAngelOneTrade), []);
    });

    it("should handle holding with zero quantity", () => {
      const raw = {
        tradingsymbol: "EMPTY",
        exchange: "NSE",
        quantity: 0,
        averageprice: 100,
        ltp: 110,
      };
      const result = normalizeAngelOneHolding(raw);
      assert.strictEqual(result.totalQuantity, 0);
      assert.strictEqual(result.freeQuantity, 0);
    });

    it("should handle trade with very small price (penny stock)", () => {
      const raw = {
        tradeid: "T100",
        orderid: "ORD100",
        tradingsymbol: "PENNY",
        exchange: "BSE",
        symboltoken: "BSE:PENNY",
        transactiontype: "BUY",
        producttype: "CNC",
        fillshares: 1000,
        fillprice: 0.5,
        filltime: "2024-01-15 10:00:00",
      };
      const result = normalizeAngelOneTrade(raw);
      assert.strictEqual(result.tradeValue, 500);
    });
  });
});
