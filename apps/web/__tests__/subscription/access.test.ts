/**
 * Subscription Access Tests (MONEY-620) — DE-SHADOWED.
 *
 * The previous version reimplemented FEATURE_ACCESS, hasFeatureAccess,
 * DEFAULT_FREE_ACCESS, calculateTotalQueryLimits, canUseQueryType and
 * buildSubscriptionAccess INLINE and asserted the copies. Worse, the inline
 * copy was STALE and WRONG: it had `aiQueries: ["PRO","PREMIUM","ULTIMATE"]`
 * (missing FREE) and `DEFAULT_FREE_ACCESS.canAccessAIQueries = false` — the
 * exact opposite of the real source (`packages/core/src/subscription/features.ts`
 * grants FREE aiQueries; `apps/web/lib/subscription/access.ts` DEFAULT_FREE_ACCESS
 * sets it `true`, see MONEY-295). The shadow would have stayed green even if the
 * real access map regressed.
 *
 * This rewrite asserts the REAL exported feature-access map + the REAL
 * entitlement logic (which gates the EFFECTIVE plan, applying status + expiry).
 *
 * Sources:
 *   - packages/core/src/subscription/features.ts (FEATURE_ACCESS, hasFeatureAccess)
 *   - packages/services/src/subscription-logic.ts (isFeatureEntitled, getEffectivePlan)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FEATURE_ACCESS,
  hasFeatureAccess,
  getMinimumPlanForFeature,
  isPlanAtLeast,
  type Feature,
} from "../../../../packages/core/src/subscription/features";
import {
  isFeatureEntitled,
  getEffectivePlan,
  type EntitlementInput,
} from "../../../../packages/services/src/subscription-logic";

const NOW = new Date("2026-06-05T12:00:00.000Z");

// ── REAL FEATURE_ACCESS / hasFeatureAccess ───────────────────────────

describe("Subscription Access: real hasFeatureAccess (per-plan map)", () => {
  it("FREE retains the universal free features", () => {
    for (const f of [
      "manualTradebook",
      "fireCalculator",
      "paperTrading",
      "basicPortfolio",
      "brokerSync",
    ] as const) {
      assert.equal(hasFeatureAccess("FREE", f), true, `FREE should have ${f}`);
    }
  });

  it("[regression] FREE has aiQueries (Flash chat free) — guards MONEY-295", () => {
    assert.equal(hasFeatureAccess("FREE", "aiQueries"), true);
    assert.ok(FEATURE_ACCESS.aiQueries.includes("FREE"));
  });

  it("FREE is denied every paid feature", () => {
    for (const f of [
      "unlimitedConnections",
      "aiStrategies",
      "aiLearning",
      "stockDiscovery",
      "portfolioRoast",
      "taxAnalysis",
      "riskAnalysis",
      "documentVault",
    ] as const) {
      assert.equal(
        hasFeatureAccess("FREE", f),
        false,
        `FREE must NOT have ${f}`
      );
    }
  });

  it("PRO has portfolioRoast/aiAnalysis/unlimitedConnections but NOT PREMIUM-only features", () => {
    assert.equal(hasFeatureAccess("PRO", "portfolioRoast"), true);
    assert.equal(hasFeatureAccess("PRO", "aiAnalysis"), true);
    assert.equal(hasFeatureAccess("PRO", "unlimitedConnections"), true);
    assert.equal(hasFeatureAccess("PRO", "aiStrategies"), false);
    assert.equal(hasFeatureAccess("PRO", "taxAnalysis"), false);
    assert.equal(hasFeatureAccess("PRO", "learningContent"), false);
  });

  it("PREMIUM & ULTIMATE have the premium features", () => {
    for (const plan of ["PREMIUM", "ULTIMATE"] as const) {
      assert.equal(hasFeatureAccess(plan, "aiStrategies"), true);
      assert.equal(hasFeatureAccess(plan, "taxAnalysis"), true);
      assert.equal(hasFeatureAccess(plan, "riskAnalysis"), true);
      assert.equal(hasFeatureAccess(plan, "learningContent"), true);
      assert.equal(hasFeatureAccess(plan, "documentVault"), true);
    }
  });

  it("[SECURITY] unknown plan / unknown feature -> false (fail closed)", () => {
    assert.equal(hasFeatureAccess("GOLD", "aiQueries"), false);
    assert.equal(hasFeatureAccess("", "manualTradebook"), false);
    // Cast simulates a bad runtime feature key reaching the guard.
    assert.equal(
      hasFeatureAccess("PRO", "nonexistentFeature" as Feature),
      false
    );
  });

  it("getMinimumPlanForFeature returns the lowest tier that unlocks it", () => {
    assert.equal(getMinimumPlanForFeature("basicPortfolio"), "FREE");
    assert.equal(getMinimumPlanForFeature("portfolioRoast"), "PRO");
    assert.equal(getMinimumPlanForFeature("taxAnalysis"), "PREMIUM");
  });

  it("isPlanAtLeast orders FREE<PRO<PREMIUM<ULTIMATE; unknown floors to FREE", () => {
    assert.equal(isPlanAtLeast("PREMIUM", "PRO"), true);
    assert.equal(isPlanAtLeast("PRO", "PREMIUM"), false);
    assert.equal(isPlanAtLeast("HACK", "PRO"), false); // unknown -> 0
  });
});

// ── REAL entitlement gate (status + expiry applied) ──────────────────

describe("Subscription Access: isFeatureEntitled gates on EFFECTIVE plan", () => {
  it("ACTIVE PREMIUM is entitled to premium features", () => {
    const s: EntitlementInput = { planId: "PREMIUM", status: "ACTIVE" };
    assert.equal(isFeatureEntitled(s, "taxAnalysis", NOW), true);
    assert.equal(isFeatureEntitled(s, "documentVault", NOW), true);
  });

  it("[BYPASS] EXPIRED / CANCELLED PREMIUM is DENIED premium features", () => {
    assert.equal(
      isFeatureEntitled(
        { planId: "PREMIUM", status: "EXPIRED" },
        "taxAnalysis",
        NOW
      ),
      false
    );
    assert.equal(
      isFeatureEntitled(
        { planId: "PREMIUM", status: "CANCELLED" },
        "riskAnalysis",
        NOW
      ),
      false
    );
  });

  it("[BYPASS] PREMIUM past its grace endDate (no PRO ent) is DENIED premium features", () => {
    const s: EntitlementInput = {
      planId: "PREMIUM",
      status: "ACTIVE",
      endDate: new Date("2026-01-01"),
    };
    assert.equal(isFeatureEntitled(s, "taxAnalysis", NOW), false);
    assert.equal(getEffectivePlan(s, NOW), "FREE");
  });

  it("downgraded-to-FREE row loses premium features immediately, keeps free ones", () => {
    const s: EntitlementInput = { planId: "FREE", status: "ACTIVE" };
    assert.equal(isFeatureEntitled(s, "taxAnalysis", NOW), false);
    assert.equal(isFeatureEntitled(s, "fireCalculator", NOW), true);
    assert.equal(isFeatureEntitled(s, "aiQueries", NOW), true);
  });

  it("[SECURITY] unknown plan -> only universal free features", () => {
    const s: EntitlementInput = { planId: "SUPER", status: "ACTIVE" };
    assert.equal(isFeatureEntitled(s, "basicPortfolio", NOW), true);
    assert.equal(isFeatureEntitled(s, "taxAnalysis", NOW), false);
    assert.equal(isFeatureEntitled(s, "unlimitedConnections", NOW), false);
  });
});
