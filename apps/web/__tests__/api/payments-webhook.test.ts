/**
 * Payments Webhook CONTRACT tests.
 *
 * Exercises the REAL exported plan/addon helpers from the shared single source
 * of truth `@/lib/payments/plan-config` that the Dodo webhook route
 * (`app/api/webhooks/dodo/route.ts`) imports and calls — NOT inline copies.
 *
 * (Replaces the previous shadow version, which reimplemented PLANS /
 * getAddonQueries / calculateQueryPackLimits / determineEndDate / helpers inline
 * and asserted the copies.)
 *
 * The real-svix signature contract + the idempotency-claim "applied exactly
 * once" coverage live in `webhooks-dodo.test.ts`.
 *
 * Source: apps/web/app/api/webhooks/dodo/route.ts
 *       + apps/web/lib/payments/plan-config.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  WEBHOOK_PLANS as PLANS,
  getAddonQueries,
  isAddonPlan,
  isAddonEligible,
  calculateQueryPackLimits,
  determineEndDate,
  getReadablePlanName,
  determineQueryPackEndDate,
  type AddonQueries,
} from "@usemoney/core/payments/plan-config";

// Local helper that derives the active flag the same way the route does, so the
// query-pack tests can pass a SubscriptionState-shaped object.
interface SubscriptionState {
  planId: string;
  status: "ACTIVE" | "CANCELLED" | "EXPIRED";
  queryPackFastQueriesLimit: number | null;
  queryPackFastQueriesUsed: number | null;
  queryPackAdvancedQueriesLimit: number | null;
  queryPackAdvancedQueriesUsed: number | null;
  endDate: Date | null;
}

function carryForward(
  sub: SubscriptionState,
  additionalQueries: AddonQueries
): { fastLimit: number; advancedLimit: number } {
  return calculateQueryPackLimits(
    sub.queryPackFastQueriesLimit,
    sub.queryPackFastQueriesUsed,
    sub.queryPackAdvancedQueriesLimit,
    sub.queryPackAdvancedQueriesUsed,
    additionalQueries,
    sub.status === "ACTIVE"
  );
}

function createMockSubscription(
  overrides: Partial<SubscriptionState> = {}
): SubscriptionState {
  return {
    planId: "PRO",
    status: "ACTIVE",
    queryPackFastQueriesLimit: null,
    queryPackFastQueriesUsed: null,
    queryPackAdvancedQueriesLimit: null,
    queryPackAdvancedQueriesUsed: null,
    endDate: null,
    ...overrides,
  };
}

describe("Payments Webhook Logic (real shared helpers)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe("getAddonQueries", () => {
    it("should return 200 fast + 50 advanced for PRO plan", () => {
      const result = getAddonQueries("PRO");
      assert.strictEqual(result.fast, 200);
      assert.strictEqual(result.advanced, 50);
    });

    it("should return 0 fast + 200 advanced for PREMIUM plan", () => {
      const result = getAddonQueries("PREMIUM");
      assert.strictEqual(result.fast, 0);
      assert.strictEqual(result.advanced, 200);
    });

    it("should return 0 fast + 200 advanced for ULTIMATE plan", () => {
      const result = getAddonQueries("ULTIMATE");
      assert.strictEqual(result.fast, 0);
      assert.strictEqual(result.advanced, 200);
    });

    it("should resolve legacy AI_UNLIMITED to PREMIUM addon (0/200)", () => {
      const result = getAddonQueries("AI_UNLIMITED");
      assert.strictEqual(result.fast, 0);
      assert.strictEqual(result.advanced, 200);
    });

    it("should return 0/0 for FREE plan", () => {
      const result = getAddonQueries("FREE");
      assert.strictEqual(result.fast, 0);
      assert.strictEqual(result.advanced, 0);
    });

    it("should return 0/0 for unknown plan", () => {
      const result = getAddonQueries("UNKNOWN");
      assert.strictEqual(result.fast, 0);
      assert.strictEqual(result.advanced, 0);
    });

    it("should return 0/0 for empty string", () => {
      const result = getAddonQueries("");
      assert.strictEqual(result.fast, 0);
      assert.strictEqual(result.advanced, 0);
    });

    it("should be case-sensitive (pro !== PRO)", () => {
      const result = getAddonQueries("pro");
      assert.strictEqual(result.fast, 0);
      assert.strictEqual(result.advanced, 0);
    });
  });

  describe("Plan config mapping (WEBHOOK_PLANS)", () => {
    it("should have FREE plan with 0 queries and 0 price", () => {
      assert.strictEqual(PLANS["FREE"].aiQueries, 0);
      assert.strictEqual(PLANS["FREE"].price, 0);
    });

    it("should have PRO plan with 10 queries and 999 price", () => {
      assert.strictEqual(PLANS["PRO"].aiQueries, 10);
      assert.strictEqual(PLANS["PRO"].price, 999);
    });

    it("should have QUERY_PACK plan with 100 queries and 99 price", () => {
      assert.strictEqual(PLANS["QUERY_PACK"].aiQueries, 100);
      assert.strictEqual(PLANS["QUERY_PACK"].price, 99);
    });

    it("should have PREMIUM plan with -1 (unlimited) queries", () => {
      assert.strictEqual(PLANS["PREMIUM"].aiQueries, -1);
      assert.strictEqual(PLANS["PREMIUM"].price, 999);
    });

    it("should have exactly 4 plan types", () => {
      assert.strictEqual(Object.keys(PLANS).length, 4);
    });

    it("should return undefined for nonexistent plan", () => {
      assert.strictEqual(PLANS["ENTERPRISE"], undefined);
    });
  });

  describe("isAddonPlan", () => {
    it("should identify QUERY_PACK as addon", () => {
      assert.strictEqual(isAddonPlan("QUERY_PACK"), true);
    });

    it("should resolve legacy AI_ADDON to QUERY_PACK addon", () => {
      assert.strictEqual(isAddonPlan("AI_ADDON"), true);
    });

    it("should not identify PRO as addon", () => {
      assert.strictEqual(isAddonPlan("PRO"), false);
    });

    it("should not identify FREE as addon", () => {
      assert.strictEqual(isAddonPlan("FREE"), false);
    });

    it("should not identify PREMIUM as addon", () => {
      assert.strictEqual(isAddonPlan("PREMIUM"), false);
    });
  });

  describe("isAddonEligible", () => {
    it("should allow PRO users", () => {
      assert.strictEqual(isAddonEligible("PRO"), true);
    });

    it("should allow PREMIUM users", () => {
      assert.strictEqual(isAddonEligible("PREMIUM"), true);
    });

    it("should allow ULTIMATE users", () => {
      assert.strictEqual(isAddonEligible("ULTIMATE"), true);
    });

    it("should allow legacy AI_UNLIMITED users (resolves to PREMIUM)", () => {
      assert.strictEqual(isAddonEligible("AI_UNLIMITED"), true);
    });

    it("should not allow FREE users", () => {
      assert.strictEqual(isAddonEligible("FREE"), false);
    });

    it("should not allow QUERY_PACK users (can't stack)", () => {
      assert.strictEqual(isAddonEligible("QUERY_PACK"), false);
    });
  });

  describe("calculateQueryPackLimits (via subscription carry-forward)", () => {
    it("should carry forward remaining + add new when active", () => {
      const sub = createMockSubscription({
        queryPackFastQueriesLimit: 200,
        queryPackFastQueriesUsed: 50,
        queryPackAdvancedQueriesLimit: 50,
        queryPackAdvancedQueriesUsed: 10,
        status: "ACTIVE",
      });
      const result = carryForward(sub, { fast: 200, advanced: 50 });
      assert.strictEqual(result.fastLimit, 350);
      assert.strictEqual(result.advancedLimit, 90);
    });

    it("should not carry forward when inactive (cancelled)", () => {
      const sub = createMockSubscription({
        queryPackFastQueriesLimit: 200,
        queryPackFastQueriesUsed: 50,
        queryPackAdvancedQueriesLimit: 50,
        queryPackAdvancedQueriesUsed: 10,
        status: "CANCELLED",
      });
      const result = carryForward(sub, { fast: 200, advanced: 50 });
      assert.strictEqual(result.fastLimit, 200);
      assert.strictEqual(result.advancedLimit, 50);
    });

    it("should handle null existing limits", () => {
      const sub = createMockSubscription({ status: "ACTIVE" });
      const result = carryForward(sub, { fast: 200, advanced: 50 });
      assert.strictEqual(result.fastLimit, 200);
      assert.strictEqual(result.advancedLimit, 50);
    });

    it("should handle over-usage (remaining capped at 0)", () => {
      const sub = createMockSubscription({
        queryPackFastQueriesLimit: 100,
        queryPackFastQueriesUsed: 150,
        queryPackAdvancedQueriesLimit: 50,
        queryPackAdvancedQueriesUsed: 60,
        status: "ACTIVE",
      });
      const result = carryForward(sub, { fast: 200, advanced: 50 });
      assert.strictEqual(result.fastLimit, 200);
      assert.strictEqual(result.advancedLimit, 50);
    });

    it("should carry full remaining when nothing used", () => {
      const sub = createMockSubscription({
        queryPackFastQueriesLimit: 200,
        queryPackFastQueriesUsed: 0,
        queryPackAdvancedQueriesLimit: 50,
        queryPackAdvancedQueriesUsed: 0,
        status: "ACTIVE",
      });
      const result = carryForward(sub, { fast: 200, advanced: 50 });
      assert.strictEqual(result.fastLimit, 400);
      assert.strictEqual(result.advancedLimit, 100);
    });

    it("should handle expired subscription same as cancelled", () => {
      const sub = createMockSubscription({
        queryPackFastQueriesLimit: 100,
        queryPackFastQueriesUsed: 20,
        status: "EXPIRED",
      });
      const result = carryForward(sub, { fast: 200, advanced: 50 });
      assert.strictEqual(result.fastLimit, 200);
      assert.strictEqual(result.advancedLimit, 50);
    });
  });

  describe("determineEndDate", () => {
    it("should return null for FREE plan", () => {
      assert.strictEqual(determineEndDate("FREE"), null);
    });

    it("should return null for PRO plan (lifetime)", () => {
      assert.strictEqual(determineEndDate("PRO"), null);
    });

    it("should return ~30 days in future for PREMIUM (default monthly)", () => {
      const now = Date.now();
      const endDate = determineEndDate("PREMIUM", null, now);
      assert.ok(endDate instanceof Date);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      assert.strictEqual(endDate!.getTime(), now + thirtyDaysMs);
    });

    it("should return ~365 days in future for PREMIUM annual", () => {
      const now = Date.now();
      const endDate = determineEndDate("PREMIUM", "annual", now);
      assert.ok(endDate instanceof Date);
      const yearMs = 365 * 24 * 60 * 60 * 1000;
      assert.strictEqual(endDate!.getTime(), now + yearMs);
    });
  });

  describe("getReadablePlanName", () => {
    it("should map PREMIUM to Premium", () => {
      assert.strictEqual(getReadablePlanName("PREMIUM"), "Premium");
    });

    it("should map PRO to Pro", () => {
      assert.strictEqual(getReadablePlanName("PRO"), "Pro");
    });

    it("should return raw planId for unmapped plans", () => {
      assert.strictEqual(getReadablePlanName("QUERY_PACK"), "QUERY_PACK");
    });

    it("should return FREE as-is", () => {
      assert.strictEqual(getReadablePlanName("FREE"), "FREE");
    });
  });

  describe("determineQueryPackEndDate", () => {
    it("should use existing endDate when active with endDate", () => {
      const futureDate = new Date("2026-06-01");
      const result = determineQueryPackEndDate("ACTIVE", futureDate);
      assert.strictEqual(result.getTime(), futureDate.getTime());
    });

    it("should use 30 days from now when active without endDate", () => {
      const now = Date.now();
      const result = determineQueryPackEndDate("ACTIVE", null, now);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      assert.strictEqual(result.getTime(), now + thirtyDaysMs);
    });

    it("should use 30 days from now when not active", () => {
      const now = Date.now();
      const result = determineQueryPackEndDate("CANCELLED", null, now);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      assert.strictEqual(result.getTime(), now + thirtyDaysMs);
    });

    it("should NOT inherit endDate when status is not ACTIVE (even if set)", () => {
      const now = Date.now();
      const someDate = new Date("2026-12-31");
      const result = determineQueryPackEndDate("CANCELLED", someDate, now);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      assert.strictEqual(result.getTime(), now + thirtyDaysMs);
    });
  });
});
