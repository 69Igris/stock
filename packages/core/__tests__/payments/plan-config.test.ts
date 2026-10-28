/**
 * Dodo Payments CATALOG config tests.
 *
 * De-shadowed (MONEY-620): imports the REAL exports from the SDK-free single
 * source of truth `@usemoney/core/payments/plan-config`, so the assertions
 * track production.
 *
 * MONEY-1062 review: the FEATURE_ACCESS / hasFeatureAccess / getDodoMode /
 * getDodoEnvironment / validateApiKey suites were removed with the symbols —
 * they duplicated the canonical `@usemoney/core/subscription` entitlement map
 * (tested in apps/web/__tests__/subscription/access.test.ts) and env logic
 * that lives inlined in `dodo.ts`.
 *
 * Source: packages/core/src/payments/plan-config.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PLAN_CONFIG } from "../../src/payments/plan-config";

// ============== TESTS ==============

describe("Dodo Payments Client", () => {
  // ── PLAN_CONFIG validation ──────────────────────────────────

  describe("PLAN_CONFIG", () => {
    it("should have 4 plan entries", () => {
      assert.strictEqual(Object.keys(PLAN_CONFIG).length, 4);
    });

    it("FREE should have zero price", () => {
      assert.strictEqual(PLAN_CONFIG.FREE.price, 0);
    });

    it("FREE should have zero query limits", () => {
      assert.strictEqual(PLAN_CONFIG.FREE.fastQueries, 0);
      assert.strictEqual(PLAN_CONFIG.FREE.advancedQueries, 0);
      assert.strictEqual(PLAN_CONFIG.FREE.aiQueries, 0);
    });

    it("PRO should cost 999 INR", () => {
      assert.strictEqual(PLAN_CONFIG.PRO.price, 999);
      assert.strictEqual(PLAN_CONFIG.PRO.currency, "INR");
    });

    it("PRO should have original price of 3999", () => {
      assert.strictEqual(PLAN_CONFIG.PRO.originalPrice, 3999);
    });

    it("PRO should be one-time payment", () => {
      assert.strictEqual(PLAN_CONFIG.PRO.period, "one-time");
    });

    it("PRO should have 20 fast + 5 advanced queries", () => {
      assert.strictEqual(PLAN_CONFIG.PRO.fastQueries, 20);
      assert.strictEqual(PLAN_CONFIG.PRO.advancedQueries, 5);
    });

    it("QUERY_PACK should cost 199 INR", () => {
      assert.strictEqual(PLAN_CONFIG.QUERY_PACK.price, 199);
    });

    it("QUERY_PACK should provide 200 fast + 50 advanced queries", () => {
      assert.strictEqual(PLAN_CONFIG.QUERY_PACK.fastQueries, 200);
      assert.strictEqual(PLAN_CONFIG.QUERY_PACK.advancedQueries, 50);
    });

    it("QUERY_PACK should be one-time payment", () => {
      assert.strictEqual(PLAN_CONFIG.QUERY_PACK.period, "one-time");
    });

    it("PREMIUM should have unlimited fast queries (-1)", () => {
      assert.strictEqual(PLAN_CONFIG.PREMIUM.fastQueries, -1);
    });

    it("PREMIUM should have 200 advanced queries", () => {
      assert.strictEqual(PLAN_CONFIG.PREMIUM.advancedQueries, 200);
    });

    it("PREMIUM should be monthly billing", () => {
      assert.strictEqual(PLAN_CONFIG.PREMIUM.period, "monthly");
    });

    it("PREMIUM should have annual price option", () => {
      assert.strictEqual(PLAN_CONFIG.PREMIUM.annualPrice, 9999);
      assert.strictEqual(PLAN_CONFIG.PREMIUM.annualOriginalPrice, 18999);
    });

    it("all plans should have INR currency", () => {
      for (const [, config] of Object.entries(PLAN_CONFIG)) {
        assert.strictEqual(config.currency, "INR");
      }
    });
  });
});
