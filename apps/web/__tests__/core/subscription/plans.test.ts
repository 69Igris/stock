/**
 * Subscription Plans Configuration Tests
 *
 * Exercises the REAL plan configuration + helpers exported from
 * packages/core/src/subscription/plans.ts (via `@usemoney/core/subscription/plans`).
 * No inline reimplementation — these assertions pin the production pricing
 * constants and the real `resolvePlanId` / `getPlanConfig` / `getPlanCredits` /
 * `getCreditCost` / `isFreeAction` / `isPaidPlan` / `hasUnlimitedFastQueries`
 * logic that drives checkout amounts and credit accounting.
 *
 * NOTE: the old shadow this replaced re-declared a stale inline `PLAN_CONFIG`
 * that had only 4 plans and asserted WRONG pricing (PREMIUM price 999 /
 * annual 9999, PRO name "AI Pro"). The real config has 5 plans and different
 * money — the divergence was invisible because the test asserted its own copy.
 * These tests now assert the real numbers (single source of truth for
 * apps/web/lib/actions/subscription.ts checkout amounts).
 *
 * Source: packages/core/src/subscription/plans.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_CONFIG,
  CREDIT_COSTS,
  CREDIT_PACKS,
  CONCURRENT_LIMITS,
  LEGACY_PLAN_ID_MAP,
  getPlanConfig,
  getAvailablePlans,
  isPaidPlan,
  hasUnlimitedFastQueries,
  resolvePlanId,
  getPlanCredits,
  getCreditCost,
  isFreeAction,
  type PlanId,
} from "@usemoney/core/subscription/plans";

// ============================================================================
// Tests
// ============================================================================

describe("Subscription Plans Configuration (real @usemoney/core exports)", () => {
  // --------------------------------------------------------------------------
  // PLAN_CONFIG structure
  // --------------------------------------------------------------------------
  describe("PLAN_CONFIG", () => {
    it("should have exactly 5 plan entries", () => {
      assert.strictEqual(Object.keys(PLAN_CONFIG).length, 5);
    });

    it("should contain all expected plan IDs", () => {
      const ids: PlanId[] = [
        "FREE",
        "PRO",
        "QUERY_PACK",
        "PREMIUM",
        "ULTIMATE",
      ];
      for (const id of ids) {
        assert.ok(PLAN_CONFIG[id], `Missing plan: ${id}`);
      }
    });

    it("should have string id on every plan", () => {
      for (const plan of Object.values(PLAN_CONFIG)) {
        assert.strictEqual(typeof plan.id, "string");
      }
    });

    it("should have INR currency on every plan", () => {
      for (const plan of Object.values(PLAN_CONFIG)) {
        assert.strictEqual(plan.currency, "INR");
      }
    });

    it("should have numeric price on every plan", () => {
      for (const plan of Object.values(PLAN_CONFIG)) {
        assert.strictEqual(typeof plan.price, "number");
      }
    });

    it("should have a numeric monthly credits allocation on every plan", () => {
      for (const plan of Object.values(PLAN_CONFIG)) {
        assert.strictEqual(typeof plan.credits, "number");
      }
    });
  });

  // --------------------------------------------------------------------------
  // FREE plan
  // --------------------------------------------------------------------------
  describe("FREE plan", () => {
    const free = PLAN_CONFIG.FREE;

    it("should have id 'FREE'", () => {
      assert.strictEqual(free.id, "FREE");
    });

    it("should have name 'Free Forever'", () => {
      assert.strictEqual(free.name, "Free Forever");
    });

    it("should have price 0", () => {
      assert.strictEqual(free.price, 0);
    });

    it("should have period 'one-time'", () => {
      assert.strictEqual(free.period, "one-time");
    });

    it("should have 0 fast queries", () => {
      assert.strictEqual(free.fastQueries, 0);
    });

    it("should have 0 advanced queries", () => {
      assert.strictEqual(free.advancedQueries, 0);
    });

    it("should have 0 AI queries", () => {
      assert.strictEqual(free.aiQueries, 0);
    });

    it("should grant 5 monthly credits", () => {
      assert.strictEqual(free.credits, 5);
    });

    it("should not have an originalPrice", () => {
      assert.strictEqual(free.originalPrice, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // PRO plan
  // --------------------------------------------------------------------------
  describe("PRO plan", () => {
    const pro = PLAN_CONFIG.PRO;

    it("should have id 'PRO'", () => {
      assert.strictEqual(pro.id, "PRO");
    });

    it("should have name 'Pro'", () => {
      assert.strictEqual(pro.name, "Pro");
    });

    it("should have lifetime price 999", () => {
      assert.strictEqual(pro.price, 999);
    });

    it("should have originalPrice 3999", () => {
      assert.strictEqual(pro.originalPrice, 3999);
    });

    it("should have period 'one-time' (legacy lifetime SKU)", () => {
      assert.strictEqual(pro.period, "one-time");
    });

    it("should have 20 fast queries", () => {
      assert.strictEqual(pro.fastQueries, 20);
    });

    it("should have 5 advanced queries", () => {
      assert.strictEqual(pro.advancedQueries, 5);
    });

    it("should grant 50 monthly credits", () => {
      assert.strictEqual(pro.credits, 50);
    });

    it("should carry MONEY-438 monthly launch pricing (249 / 499)", () => {
      assert.strictEqual(pro.monthlyPrice, 249);
      assert.strictEqual(pro.monthlyOriginalPrice, 499);
    });

    it("should carry MONEY-438 annual launch pricing (1999 / 4999)", () => {
      assert.strictEqual(pro.annualPrice, 1999);
      assert.strictEqual(pro.annualOriginalPrice, 4999);
    });

    it("should have a description", () => {
      assert.ok(pro.description);
    });
  });

  // --------------------------------------------------------------------------
  // QUERY_PACK plan
  // --------------------------------------------------------------------------
  describe("QUERY_PACK plan", () => {
    const addon = PLAN_CONFIG.QUERY_PACK;

    it("should have id 'QUERY_PACK'", () => {
      assert.strictEqual(addon.id, "QUERY_PACK");
    });

    it("should have name 'Query Pack'", () => {
      assert.strictEqual(addon.name, "Query Pack");
    });

    it("should have price 199", () => {
      assert.strictEqual(addon.price, 199);
    });

    it("should have period 'one-time'", () => {
      assert.strictEqual(addon.period, "one-time");
    });

    it("should have 200 fast queries", () => {
      assert.strictEqual(addon.fastQueries, 200);
    });

    it("should have 50 advanced queries", () => {
      assert.strictEqual(addon.advancedQueries, 50);
    });

    it("should grant 0 credits (handled by CREDIT_PACKS instead)", () => {
      assert.strictEqual(addon.credits, 0);
    });
  });

  // --------------------------------------------------------------------------
  // PREMIUM plan
  // --------------------------------------------------------------------------
  describe("PREMIUM plan", () => {
    const premium = PLAN_CONFIG.PREMIUM;

    it("should have id 'PREMIUM'", () => {
      assert.strictEqual(premium.id, "PREMIUM");
    });

    it("should have name 'Premium'", () => {
      assert.strictEqual(premium.name, "Premium");
    });

    it("should have price 1499", () => {
      assert.strictEqual(premium.price, 1499);
    });

    it("should have originalPrice 2999", () => {
      assert.strictEqual(premium.originalPrice, 2999);
    });

    it("should have period 'monthly'", () => {
      assert.strictEqual(premium.period, "monthly");
    });

    it("should have unlimited fast queries (-1)", () => {
      assert.strictEqual(premium.fastQueries, -1);
    });

    it("should have 200 advanced queries", () => {
      assert.strictEqual(premium.advancedQueries, 200);
    });

    it("should grant 200 monthly credits", () => {
      assert.strictEqual(premium.credits, 200);
    });

    it("should have annualPrice 14990", () => {
      assert.strictEqual(premium.annualPrice, 14990);
    });

    it("should have annualOriginalPrice 17988", () => {
      assert.strictEqual(premium.annualOriginalPrice, 17988);
    });
  });

  // --------------------------------------------------------------------------
  // ULTIMATE plan (entirely absent from the old shadow)
  // --------------------------------------------------------------------------
  describe("ULTIMATE plan", () => {
    const ultimate = PLAN_CONFIG.ULTIMATE;

    it("should have id 'ULTIMATE'", () => {
      assert.strictEqual(ultimate.id, "ULTIMATE");
    });

    it("should have name 'Ultimate'", () => {
      assert.strictEqual(ultimate.name, "Ultimate");
    });

    it("should have price 4999", () => {
      assert.strictEqual(ultimate.price, 4999);
    });

    it("should have period 'monthly'", () => {
      assert.strictEqual(ultimate.period, "monthly");
    });

    it("should have unlimited fast and advanced queries (-1)", () => {
      assert.strictEqual(ultimate.fastQueries, -1);
      assert.strictEqual(ultimate.advancedQueries, -1);
    });

    it("should grant 750 monthly credits", () => {
      assert.strictEqual(ultimate.credits, 750);
    });

    it("should have annualPrice 49990", () => {
      assert.strictEqual(ultimate.annualPrice, 49990);
    });
  });

  // --------------------------------------------------------------------------
  // getPlanConfig
  // --------------------------------------------------------------------------
  describe("getPlanConfig", () => {
    it("should return FREE config for 'FREE'", () => {
      const config = getPlanConfig("FREE");
      assert.deepStrictEqual(config, PLAN_CONFIG.FREE);
    });

    it("should return PRO config for 'PRO'", () => {
      const config = getPlanConfig("PRO");
      assert.deepStrictEqual(config, PLAN_CONFIG.PRO);
    });

    it("should return QUERY_PACK config for 'QUERY_PACK'", () => {
      const config = getPlanConfig("QUERY_PACK");
      assert.deepStrictEqual(config, PLAN_CONFIG.QUERY_PACK);
    });

    it("should return PREMIUM config for 'PREMIUM'", () => {
      const config = getPlanConfig("PREMIUM");
      assert.deepStrictEqual(config, PLAN_CONFIG.PREMIUM);
    });

    it("should return ULTIMATE config for 'ULTIMATE'", () => {
      const config = getPlanConfig("ULTIMATE");
      assert.deepStrictEqual(config, PLAN_CONFIG.ULTIMATE);
    });

    it("should resolve a legacy plan ID to its current config", () => {
      // AI_UNLIMITED -> PREMIUM (LEGACY_PLAN_ID_MAP)
      assert.deepStrictEqual(
        getPlanConfig("AI_UNLIMITED"),
        PLAN_CONFIG.PREMIUM
      );
    });

    it("should return undefined for unknown plan", () => {
      assert.strictEqual(getPlanConfig("UNKNOWN"), undefined);
    });

    it("should return undefined for empty string", () => {
      assert.strictEqual(getPlanConfig(""), undefined);
    });
  });

  // --------------------------------------------------------------------------
  // resolvePlanId + LEGACY_PLAN_ID_MAP
  // --------------------------------------------------------------------------
  describe("resolvePlanId", () => {
    it("should pass through current plan IDs unchanged", () => {
      assert.strictEqual(resolvePlanId("FREE"), "FREE");
      assert.strictEqual(resolvePlanId("PREMIUM"), "PREMIUM");
      assert.strictEqual(resolvePlanId("ULTIMATE"), "ULTIMATE");
    });

    it("should map AI_UNLIMITED -> PREMIUM", () => {
      assert.strictEqual(resolvePlanId("AI_UNLIMITED"), "PREMIUM");
    });

    it("should map AI_PRO -> PREMIUM", () => {
      assert.strictEqual(resolvePlanId("AI_PRO"), "PREMIUM");
    });

    it("should map AI_ADDON -> QUERY_PACK", () => {
      assert.strictEqual(resolvePlanId("AI_ADDON"), "QUERY_PACK");
    });

    it("should expose the legacy map entries", () => {
      assert.strictEqual(LEGACY_PLAN_ID_MAP.AI_UNLIMITED, "PREMIUM");
      assert.strictEqual(LEGACY_PLAN_ID_MAP.AI_ADDON, "QUERY_PACK");
      assert.strictEqual(LEGACY_PLAN_ID_MAP.AI_PRO, "PREMIUM");
    });
  });

  // --------------------------------------------------------------------------
  // getAvailablePlans
  // --------------------------------------------------------------------------
  describe("getAvailablePlans", () => {
    it("should return exactly 4 plans (ULTIMATE excluded as placeholder)", () => {
      assert.strictEqual(getAvailablePlans().length, 4);
    });

    it("should include FREE plan", () => {
      const plans = getAvailablePlans();
      assert.ok(plans.some((p) => p.id === "FREE"));
    });

    it("should include PRO plan", () => {
      const plans = getAvailablePlans();
      assert.ok(plans.some((p) => p.id === "PRO"));
    });

    it("should include PREMIUM plan", () => {
      const plans = getAvailablePlans();
      assert.ok(plans.some((p) => p.id === "PREMIUM"));
    });

    it("should include QUERY_PACK plan", () => {
      const plans = getAvailablePlans();
      assert.ok(plans.some((p) => p.id === "QUERY_PACK"));
    });

    it("should NOT include ULTIMATE plan", () => {
      const plans = getAvailablePlans();
      assert.ok(!plans.some((p) => p.id === "ULTIMATE"));
    });

    it("should return plans in expected order (FREE, PRO, PREMIUM, QUERY_PACK)", () => {
      const plans = getAvailablePlans();
      assert.strictEqual(plans[0]!.id, "FREE");
      assert.strictEqual(plans[1]!.id, "PRO");
      assert.strictEqual(plans[2]!.id, "PREMIUM");
      assert.strictEqual(plans[3]!.id, "QUERY_PACK");
    });
  });

  // --------------------------------------------------------------------------
  // isPaidPlan
  // --------------------------------------------------------------------------
  describe("isPaidPlan", () => {
    it("should return false for FREE", () => {
      assert.strictEqual(isPaidPlan("FREE"), false);
    });

    it("should return true for PRO", () => {
      assert.strictEqual(isPaidPlan("PRO"), true);
    });

    it("should return true for QUERY_PACK", () => {
      assert.strictEqual(isPaidPlan("QUERY_PACK"), true);
    });

    it("should return true for PREMIUM", () => {
      assert.strictEqual(isPaidPlan("PREMIUM"), true);
    });

    it("should return true for ULTIMATE", () => {
      assert.strictEqual(isPaidPlan("ULTIMATE"), true);
    });

    it("should return true for a legacy paid alias (AI_UNLIMITED -> PREMIUM)", () => {
      assert.strictEqual(isPaidPlan("AI_UNLIMITED"), true);
    });

    it("should return true for unknown plan id", () => {
      assert.strictEqual(isPaidPlan("UNKNOWN"), true);
    });

    it("should return true for empty string", () => {
      assert.strictEqual(isPaidPlan(""), true);
    });
  });

  // --------------------------------------------------------------------------
  // hasUnlimitedFastQueries
  // --------------------------------------------------------------------------
  describe("hasUnlimitedFastQueries", () => {
    it("should return false for FREE", () => {
      assert.strictEqual(hasUnlimitedFastQueries("FREE"), false);
    });

    it("should return false for PRO", () => {
      assert.strictEqual(hasUnlimitedFastQueries("PRO"), false);
    });

    it("should return false for QUERY_PACK", () => {
      assert.strictEqual(hasUnlimitedFastQueries("QUERY_PACK"), false);
    });

    it("should return true for PREMIUM", () => {
      assert.strictEqual(hasUnlimitedFastQueries("PREMIUM"), true);
    });

    it("should return true for ULTIMATE", () => {
      assert.strictEqual(hasUnlimitedFastQueries("ULTIMATE"), true);
    });

    it("should return false for unknown plan", () => {
      assert.strictEqual(hasUnlimitedFastQueries("UNKNOWN"), false);
    });
  });

  // --------------------------------------------------------------------------
  // getPlanCredits
  // --------------------------------------------------------------------------
  describe("getPlanCredits", () => {
    it("should return 5 for FREE", () => {
      assert.strictEqual(getPlanCredits("FREE"), 5);
    });

    it("should return 50 for PRO", () => {
      assert.strictEqual(getPlanCredits("PRO"), 50);
    });

    it("should return 200 for PREMIUM", () => {
      assert.strictEqual(getPlanCredits("PREMIUM"), 200);
    });

    it("should return 750 for ULTIMATE", () => {
      assert.strictEqual(getPlanCredits("ULTIMATE"), 750);
    });

    it("should default to 5 credits for an unknown plan", () => {
      assert.strictEqual(getPlanCredits("UNKNOWN"), 5);
    });

    it("should resolve a legacy ID before reading credits (AI_UNLIMITED -> 200)", () => {
      assert.strictEqual(getPlanCredits("AI_UNLIMITED"), 200);
    });
  });

  // --------------------------------------------------------------------------
  // getCreditCost + isFreeAction + CREDIT_COSTS
  // --------------------------------------------------------------------------
  describe("getCreditCost / isFreeAction", () => {
    it("should return 0 for free actions", () => {
      assert.strictEqual(getCreditCost("l1_flash"), 0);
      assert.strictEqual(getCreditCost("portfolio_query"), 0);
    });

    it("should return the real cost for paid actions", () => {
      assert.strictEqual(getCreditCost("portfolio_roast"), 5);
      assert.strictEqual(getCreditCost("risk_analysis"), 3);
      assert.strictEqual(getCreditCost("l3_comprehensive_stock"), 10);
      assert.strictEqual(getCreditCost("l3_multi_comparison_per_stock"), 8);
      // MONEY-1049 — Ask FIRE LLM-backed turn (the deterministic tier is free).
      assert.strictEqual(getCreditCost("fire_chat"), 1);
      assert.strictEqual(isFreeAction("fire_chat"), false);
    });

    it("should default unknown actions to 0", () => {
      assert.strictEqual(getCreditCost("does_not_exist"), 0);
    });

    it("every action a PAID model call is metered under is IN the table", () => {
      // The zero-default above is the trap, seen from the consume side:
      // `consumeCredits` treats a cost of 0 as a FREE action that is always
      // allowed, so an action id that never made it into `CREDIT_COSTS` is
      // metered by a meter that authorises everything — silently, and while
      // reading exactly like a meter that works. MONEY-1405 nearly shipped
      // `fund_composition_extract` that way; it survived only because the call
      // site passed a `costOverride`, which is a second spelling of a number
      // that belongs here.
      //
      // So the guard is on the TABLE, not on any one call site: every id below
      // drives at least one paid model call, and a zero here is a free one.
      // MUTATION: remove any entry from CREDIT_COSTS -> RED by name.
      for (const action of [
        "fund_composition_extract", // gemini-2.5-pro thinking, MONEY-1405
        "document_analysis",
        "portfolio_roast",
        "risk_analysis",
        "l2_research_advanced",
        "fire_chat",
      ]) {
        assert.ok(
          getCreditCost(action) > 0,
          `${action} costs 0 credits — consumeCredits will allow it always`,
        );
        assert.strictEqual(isFreeAction(action), false, action);
      }
      // And the one this ticket added is priced like its nearest neighbour:
      // one pro-tier call over one document.
      assert.strictEqual(
        getCreditCost("fund_composition_extract"),
        getCreditCost("document_analysis"),
      );
    });

    it("isFreeAction should be true for 0-credit actions", () => {
      assert.strictEqual(isFreeAction("l1_flash"), true);
      assert.strictEqual(isFreeAction("follow_up"), true);
    });

    it("isFreeAction should be false for paid actions", () => {
      assert.strictEqual(isFreeAction("portfolio_roast"), false);
      assert.strictEqual(isFreeAction("l2_research_advanced"), false);
    });

    it("isFreeAction should treat unknown actions as free (cost 0)", () => {
      assert.strictEqual(isFreeAction("does_not_exist"), true);
    });

    it("CREDIT_COSTS should mark every l1_* action as 0 credits", () => {
      for (const [action, cost] of Object.entries(CREDIT_COSTS)) {
        if (action.startsWith("l1_")) {
          assert.strictEqual(cost, 0, `${action} should be free`);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // CREDIT_PACKS + CONCURRENT_LIMITS
  // --------------------------------------------------------------------------
  describe("CREDIT_PACKS", () => {
    it("should offer 5 packs", () => {
      assert.strictEqual(CREDIT_PACKS.length, 5);
    });

    it("should have monotonically increasing credits and decreasing per-credit price", () => {
      for (let i = 1; i < CREDIT_PACKS.length; i++) {
        assert.ok(
          CREDIT_PACKS[i]!.credits > CREDIT_PACKS[i - 1]!.credits,
          "credits should increase"
        );
        assert.ok(
          CREDIT_PACKS[i]!.perCredit <= CREDIT_PACKS[i - 1]!.perCredit,
          "per-credit price should not increase"
        );
      }
    });
  });

  describe("CONCURRENT_LIMITS", () => {
    it("should disallow L3 and roast concurrency on FREE", () => {
      assert.strictEqual(CONCURRENT_LIMITS.FREE.l3, 0);
      assert.strictEqual(CONCURRENT_LIMITS.FREE.roast, 0);
    });

    it("should grant the highest concurrency to ULTIMATE", () => {
      assert.strictEqual(CONCURRENT_LIMITS.ULTIMATE.l2, 10);
      assert.strictEqual(CONCURRENT_LIMITS.ULTIMATE.l3, 3);
      assert.strictEqual(CONCURRENT_LIMITS.ULTIMATE.roast, 2);
    });

    it("should define limits for every plan id", () => {
      const ids: PlanId[] = [
        "FREE",
        "PRO",
        "QUERY_PACK",
        "PREMIUM",
        "ULTIMATE",
      ];
      for (const id of ids) {
        assert.ok(CONCURRENT_LIMITS[id], `Missing concurrency limit: ${id}`);
      }
    });
  });
});
