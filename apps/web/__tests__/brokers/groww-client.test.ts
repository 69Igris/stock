/**
 * Groww Adapter Tests — REAL SOURCE
 *
 * Exercises the REAL `GrowwAdapter` class from
 * `@usemoney/core/brokers` (packages/core/src/brokers/adapters/groww.ts) by
 * instantiating it and calling its actual methods — NOT an inline copy. Covers:
 * - Broker info (via the real getInfo())
 * - getAuthUrl()
 * - authenticate() mock-data flow (env-controlled so it stays offline)
 * - refreshAccessToken() error behaviour
 * - validateToken() mock-data flow
 * - supportsAutoRefresh / getRefreshStrategy / getTokenExpiryDuration
 * - the inherited addDays() helper (via a test-only subclass exposing it)
 *
 * (Replaces the previous shadow version, which reimplemented BROKER_INFO and
 * every method inline and asserted the copies — so it stayed green even as the
 * real adapter drifted, e.g. refresh strategy NONE vs the copy's MONTHLY and a
 * 1-day vs 30-day token expiry.)
 *
 * Pure/offline: the authenticate + validateToken mock branches run because the
 * GROWW_API_KEY env var is removed inside those tests (save/restore), so no
 * network, timers, or open handles are created.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GrowwAdapter,
  normalizeGrowwHolding,
  normalizeGrowwPosition,
  normalizeGrowwOrder,
} from "@usemoney/core/brokers";

// Test-only subclass to reach the protected addDays() helper that the real
// adapter inherits from BaseBrokerAdapter and uses in authenticate().
class GrowwAdapterProbe extends GrowwAdapter {
  publicAddDays(days: number): Date {
    return this.addDays(days);
  }
}

/**
 * Run `fn` with GROWW_API_KEY guaranteed unset so `shouldUseMockData("GROWW")`
 * returns true and the adapter takes its offline mock branch. Restores the
 * original env afterward.
 */
function withMockMode<T>(fn: () => T): T {
  const saved = process.env.GROWW_API_KEY;
  delete process.env.GROWW_API_KEY;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.GROWW_API_KEY = saved;
  }
}

describe("GrowwAdapter", () => {
  const adapter = new GrowwAdapter();
  const info = adapter.getInfo();

  // ---------- Broker Info ----------
  describe("Broker Info", () => {
    it("should have id GROWW", () => {
      assert.strictEqual(info.id, "GROWW");
    });

    it("should have name Groww", () => {
      assert.strictEqual(info.name, "Groww");
    });

    it("should have correct color #5367FF", () => {
      assert.strictEqual(info.color, "#5367FF");
    });

    it("should have description mentioning stocks and Trade API", () => {
      assert.ok(info.description.includes("stocks"));
      assert.ok(info.description.includes("Trade API"));
    });

    it("should have 3 segments", () => {
      assert.strictEqual(info.segments.length, 3);
    });

    it("should include Equity segment", () => {
      assert.ok(info.segments.includes("Equity"));
    });

    it("should include F&O segment", () => {
      assert.ok(info.segments.includes("F&O"));
    });

    it("should include Commodity segment", () => {
      assert.ok(info.segments.includes("Commodity"));
    });

    it("should NOT include MF segment", () => {
      assert.ok(!info.segments.includes("MF"));
    });

    it("should have 4 features", () => {
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

    it("should have paid cost (₹499+/month)", () => {
      assert.strictEqual(info.cost, "₹499+/month");
    });

    it("should have mfSupport=false (Trade API has no MF)", () => {
      assert.strictEqual(info.mfSupport, false);
    });

    it("should have autoRefresh=false", () => {
      assert.strictEqual(info.autoRefresh, false);
    });

    it("should have tokenExpiry mentioning 1 day", () => {
      assert.ok(info.tokenExpiry.includes("1 day"));
    });

    it("should have docsUrl pointing to the Groww Trade API docs", () => {
      assert.strictEqual(info.docsUrl, "https://groww.in/trade-api/docs");
    });
  });

  // ---------- Auth URL ----------
  describe("getAuthUrl", () => {
    it("should return the Groww Trade API docs URL", () => {
      assert.strictEqual(
        adapter.getAuthUrl(),
        "https://groww.in/trade-api/docs"
      );
    });

    it("should start with https://", () => {
      assert.ok(adapter.getAuthUrl().startsWith("https://"));
    });
  });

  // ---------- Authentication (mock branch) ----------
  describe("authenticate", () => {
    it("should return success=true in mock mode", async () => {
      const result = await withMockMode(() =>
        adapter.authenticate("code", "redirect")
      );
      assert.strictEqual(result.success, true);
    });

    it("should return a mock access token", async () => {
      const result = await withMockMode(() =>
        adapter.authenticate("code", "redirect")
      );
      assert.ok(result.accessToken);
      assert.ok(result.accessToken!.startsWith("mock_groww_token_"));
    });

    it("should return expiresAt ~1 day in the future", async () => {
      const result = await withMockMode(() =>
        adapter.authenticate("code", "redirect")
      );
      assert.ok(result.expiresAt instanceof Date);
      const diff = result.expiresAt!.getTime() - Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      assert.ok(
        Math.abs(diff - oneDayMs) < 5000,
        "Expiry should be ~1 day from now"
      );
    });

    it("should use provided userName in metadata", async () => {
      const result = await withMockMode(() =>
        adapter.authenticate("code", "redirect", { userName: "Test User" })
      );
      assert.strictEqual(result.metadata?.userName, "Test User");
    });

    it("should default userName to Demo User", async () => {
      const result = await withMockMode(() =>
        adapter.authenticate("code", "redirect")
      );
      assert.strictEqual(result.metadata?.userName, "Demo User");
    });

    it("should set broker to Groww in metadata", async () => {
      const result = await withMockMode(() =>
        adapter.authenticate("code", "redirect")
      );
      assert.strictEqual(result.metadata?.broker, "Groww");
    });

    it("should not return a refreshToken", async () => {
      const result = await withMockMode(() =>
        adapter.authenticate("code", "redirect")
      );
      assert.strictEqual(result.refreshToken, undefined);
    });
  });

  // ---------- Refresh Access Token ----------
  describe("refreshAccessToken", () => {
    it("should return success=false", async () => {
      const result = await adapter.refreshAccessToken({ accessToken: "x" });
      assert.strictEqual(result.success, false);
    });

    it("should return an error about daily re-authentication", async () => {
      const result = await adapter.refreshAccessToken({ accessToken: "x" });
      assert.ok(result.error);
      assert.ok(result.error!.includes("daily re-authentication"));
    });

    it("should mention Groww in the error", async () => {
      const result = await adapter.refreshAccessToken({ accessToken: "x" });
      assert.ok(result.error!.includes("Groww"));
    });

    it("should not return an accessToken", async () => {
      const result = await adapter.refreshAccessToken({ accessToken: "x" });
      assert.strictEqual(result.accessToken, undefined);
    });
  });

  // ---------- Token Validation (mock branch) ----------
  describe("validateToken", () => {
    it("should return true in mock mode", async () => {
      const result = await withMockMode(() =>
        adapter.validateToken({ accessToken: "x" })
      );
      assert.strictEqual(result, true);
    });
  });

  // ---------- Auto Refresh ----------
  describe("supportsAutoRefresh", () => {
    it("should return false", () => {
      assert.strictEqual(adapter.supportsAutoRefresh(), false);
    });
  });

  // ---------- Refresh Strategy ----------
  describe("getRefreshStrategy", () => {
    it("should return NONE", () => {
      assert.strictEqual(adapter.getRefreshStrategy(), "NONE");
    });
  });

  // ---------- Token Expiry Duration ----------
  describe("getTokenExpiryDuration", () => {
    it("should return 1 day in milliseconds", () => {
      const expected = 24 * 60 * 60 * 1000;
      assert.strictEqual(adapter.getTokenExpiryDuration(), expected);
    });

    it("should be exactly 86400000 ms", () => {
      assert.strictEqual(adapter.getTokenExpiryDuration(), 86400000);
    });
  });

  // ---------- addDays helper (inherited from BaseBrokerAdapter) ----------
  describe("addDays helper", () => {
    const probe = new GrowwAdapterProbe();

    it("should work for 1 day", () => {
      const future = probe.publicAddDays(1);
      const diff = future.getTime() - Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      assert.ok(Math.abs(diff - oneDayMs) < 1000, "Should be ~1 day ahead");
    });

    it("should work for 0 days", () => {
      const today = probe.publicAddDays(0);
      const diff = Math.abs(today.getTime() - Date.now());
      assert.ok(diff < 1000, "Should be approximately now");
    });

    it("should work for negative days", () => {
      const past = probe.publicAddDays(-1);
      assert.ok(past < new Date(), "Should be in the past");
    });
  });
});

describe("Groww row normalisation (MONEY-1093 — previously ZERO coverage)", () => {
  // Deleting the shadow `groww-adapter.test.ts` was right — it re-declared
  // BROKER_INFO inline and contradicted the real adapter on ~19 values — but its
  // replacement covered only metadata and auth. fetchHoldings/Positions/Orders/
  // Trades/MutualFunds had no coverage at all, and extracting these mappers to
  // test them immediately surfaced a real bug: the inline holding mapper emitted
  // `quantity`, which is NOT a field of HoldingData (the contract wants
  // totalQuantity/freeQuantity/tradingSymbol/pnl/product). It compiled only
  // because `.json<any>()` made the mapped array `any`, so the declared
  // `Promise<HoldingData[]>` was never checked.

  describe("holdings", () => {
    it("maps to the HoldingData contract, not an ad-hoc shape", () => {
      const h = normalizeGrowwHolding({
        trading_symbol: "RELIANCE",
        isin: "INE002A01018",
        quantity: 10,
        average_price: 2400,
        t1_quantity: 2,
      });
      assert.equal(h.symbol, "RELIANCE");
      assert.equal(h.tradingSymbol, "RELIANCE");
      assert.equal(h.isin, "INE002A01018");
      assert.equal(h.exchange, "NSE");
      // The fields the old shape omitted entirely.
      assert.equal(h.totalQuantity, 10);
      assert.equal(h.freeQuantity, 10);
      assert.equal(h.t1Quantity, 2);
      assert.equal(h.averagePrice, 2400);
      assert.equal(h.product, "CNC");
    });

    it("falls back to the ISIN when there is no trading symbol", () => {
      assert.equal(
        normalizeGrowwHolding({ isin: "INE002A01018" }).symbol,
        "INE002A01018"
      );
    });

    it("leaves lastPrice and pnl at 0 rather than inventing them", () => {
      // Groww's holdings response carries no LTP, so a computed pnl would be
      // fiction. The sync fills the price separately.
      const h = normalizeGrowwHolding({
        trading_symbol: "X",
        quantity: 5,
        average_price: 100,
      });
      assert.equal(h.lastPrice, 0);
      assert.equal(h.pnl, 0);
      assert.equal(h.pnlPercentage, 0);
    });

    it("defaults every numeric field on an empty row", () => {
      const h = normalizeGrowwHolding({});
      assert.equal(h.totalQuantity, 0);
      assert.equal(h.averagePrice, 0);
      assert.equal(h.symbol, "");
    });
  });

  describe("positions", () => {
    it("maps to the PositionData contract", () => {
      const p = normalizeGrowwPosition({
        trading_symbol: "INFY",
        exchange: "NSE",
        segment: "CASH",
        product: "MIS",
        quantity: 7,
        credit_quantity: 10,
        debit_quantity: 3,
        credit_price: 1500,
        debit_price: 1550,
        realised_pnl: 150,
      });
      assert.equal(p.tradingSymbol, "INFY");
      assert.equal(p.netQuantity, 7);
      assert.equal(p.buyQuantity, 10);
      assert.equal(p.sellQuantity, 3);
      assert.equal(p.productType, "MIS");
      assert.equal(p.positionType, "NET");
      assert.equal(p.realizedPnl, 150);
    });

    it("prefers `quantity`, falling back to `net_quantity`", () => {
      assert.equal(normalizeGrowwPosition({ net_quantity: 4 }).netQuantity, 4);
      assert.equal(
        normalizeGrowwPosition({ quantity: 9, net_quantity: 4 }).netQuantity,
        9
      );
    });

    it("keeps a zero quantity as zero, not a fallback", () => {
      // `??` not `||`: a flat position is 0, and `||` would silently prefer
      // net_quantity for it.
      assert.equal(
        normalizeGrowwPosition({ quantity: 0, net_quantity: 5 }).netQuantity,
        0
      );
    });
  });

  describe("orders", () => {
    it("maps to the OrderData contract", () => {
      const o = normalizeGrowwOrder({
        groww_order_id: "G123",
        trading_symbol: "TCS",
        transaction_type: "SELL",
        order_type: "LIMIT",
        product: "CNC",
        quantity: 5,
        filled_quantity: 5,
        price: 3500,
        average_fill_price: 3499,
        order_status: "COMPLETE",
        created_at: "2026-07-30T04:00:00Z",
      });
      assert.equal(o.orderId, "G123");
      assert.equal(o.transactionType, "SELL");
      assert.equal(o.orderType, "LIMIT");
      assert.equal(o.filledQuantity, 5);
      assert.equal(o.averagePrice, 3499);
      assert.ok(o.orderTime instanceof Date);
    });

    it("NARROWS an unexpected side to BUY rather than typing it as valid", () => {
      // transactionType is a "BUY" | "SELL" union; passing the raw string
      // through would let any value be typed as a legitimate side.
      assert.equal(
        normalizeGrowwOrder({ transaction_type: "garbage" }).transactionType,
        "BUY"
      );
      assert.equal(
        normalizeGrowwOrder({ transaction_type: "sell" }).transactionType,
        "SELL"
      );
      assert.equal(normalizeGrowwOrder({}).transactionType, "BUY");
    });

    it("uses a real Date when created_at is absent", () => {
      assert.ok(normalizeGrowwOrder({}).orderTime instanceof Date);
    });
  });
});
