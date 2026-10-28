/**
 * Feature Access Control Tests
 *
 * Exercises the REAL feature-access map + helpers exported from
 * packages/core/src/subscription/features.ts (via `@usemoney/core/subscription`).
 * No inline reimplementation — these pin the production `FEATURE_ACCESS` map and
 * the real `hasFeatureAccess` / `getFeaturesForPlan` / `isPlanAtLeast` /
 * `getMinimumPlanForFeature` logic (all of which resolve legacy plan IDs first).
 *
 * Divergences the old shadow hid (its inline copy was stale and INVERTED real
 * behavior — and still "passed" because it asserted the copy):
 *   1. `aiQueries` is granted to FREE in real source (Flash chat free + 5
 *      research credits — see the MONEY comment in features.ts). The shadow
 *      excluded FREE and asserted `hasFeatureAccess("FREE","aiQueries") === false`
 *      and min plan "PRO". REAL: true / "FREE".
 *   2. `isPlanAtLeast` puts ULTIMATE at tier 3 (above PREMIUM=2). The shadow
 *      put ULTIMATE at tier 2 and asserted "PREMIUM >= ULTIMATE === true".
 *      REAL: PREMIUM >= ULTIMATE === false.
 *   3. The real map has 25 features incl. `documentVault`; the shadow's inline
 *      map omitted it (and several free entries), giving wrong per-plan counts.
 *
 * Source: packages/core/src/subscription/features.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FEATURE_ACCESS,
  hasFeatureAccess,
  getFeaturesForPlan,
  isPlanAtLeast,
  getMinimumPlanForFeature,
  type Feature,
} from "@usemoney/core/subscription";

// ============================================================================
// Tests
// ============================================================================

describe("Feature Access Control (real @usemoney/core exports)", () => {
  // --------------------------------------------------------------------------
  // FEATURE_ACCESS map structure
  // --------------------------------------------------------------------------
  describe("FEATURE_ACCESS map", () => {
    it("should contain exactly 25 features", () => {
      assert.strictEqual(Object.keys(FEATURE_ACCESS).length, 25);
    });

    it("should include documentVault (omitted by the old shadow)", () => {
      assert.ok("documentVault" in FEATURE_ACCESS);
      assert.deepStrictEqual(FEATURE_ACCESS.documentVault, [
        "PREMIUM",
        "ULTIMATE",
      ]);
    });

    it("should have arrays of plan IDs for every feature", () => {
      for (const [feature, plans] of Object.entries(FEATURE_ACCESS)) {
        assert.ok(Array.isArray(plans), `${feature} should be an array`);
        assert.ok(plans.length > 0, `${feature} should have at least one plan`);
      }
    });

    it("should only contain valid plan IDs", () => {
      const validPlans = new Set(["FREE", "PRO", "PREMIUM", "ULTIMATE"]);
      for (const [feature, plans] of Object.entries(FEATURE_ACCESS)) {
        for (const plan of plans) {
          assert.ok(
            validPlans.has(plan),
            `Invalid plan '${plan}' in ${feature}`
          );
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Free features (available to all)
  // --------------------------------------------------------------------------
  describe("Free features", () => {
    const freeFeatures: Feature[] = [
      "manualTradebook",
      "fireCalculator",
      "paperTrading",
      "basicPortfolio",
    ];

    for (const feature of freeFeatures) {
      it(`should grant '${feature}' to FREE plan`, () => {
        assert.ok(FEATURE_ACCESS[feature].includes("FREE"));
      });
    }

    it("brokerSync should be available to FREE (1 broker)", () => {
      assert.ok(FEATURE_ACCESS.brokerSync.includes("FREE"));
    });

    it("aiQueries SHOULD be available to FREE (real source — shadow inverted this)", () => {
      assert.ok(FEATURE_ACCESS.aiQueries.includes("FREE"));
    });
  });

  // --------------------------------------------------------------------------
  // Pro features
  // --------------------------------------------------------------------------
  describe("Pro features", () => {
    const proOnlyFeatures: Feature[] = [
      "unlimitedConnections",
      "autoSyncHoldings",
      "positionsTracking",
      "tradebookSync",
      "stockDiscovery",
      "aiAnalysis",
      "portfolioRoast",
    ];

    for (const feature of proOnlyFeatures) {
      it(`should NOT grant '${feature}' to FREE plan`, () => {
        assert.ok(!FEATURE_ACCESS[feature].includes("FREE"));
      });

      it(`should grant '${feature}' to PRO plan`, () => {
        assert.ok(FEATURE_ACCESS[feature].includes("PRO"));
      });
    }
  });

  // --------------------------------------------------------------------------
  // Premium features
  // --------------------------------------------------------------------------
  describe("Premium features", () => {
    const premiumFeatures: Feature[] = [
      "aiStrategies",
      "aiLearning",
      "unlimitedSlowQueries",
      "unlimitedFastQueries",
      "prioritySupport",
      "learningContent",
      "learningVideos",
      "learningAudio",
      "advancedCourses",
      "taxAnalysis",
      "riskAnalysis",
      "documentVault",
    ];

    for (const feature of premiumFeatures) {
      it(`should NOT grant '${feature}' to FREE`, () => {
        assert.ok(!FEATURE_ACCESS[feature].includes("FREE"));
      });

      it(`should NOT grant '${feature}' to PRO`, () => {
        assert.ok(!FEATURE_ACCESS[feature].includes("PRO"));
      });

      it(`should grant '${feature}' to PREMIUM`, () => {
        assert.ok(FEATURE_ACCESS[feature].includes("PREMIUM"));
      });

      it(`should grant '${feature}' to ULTIMATE`, () => {
        assert.ok(FEATURE_ACCESS[feature].includes("ULTIMATE"));
      });
    }
  });

  // --------------------------------------------------------------------------
  // hasFeatureAccess
  // --------------------------------------------------------------------------
  describe("hasFeatureAccess", () => {
    it("should return true for FREE + manualTradebook", () => {
      assert.strictEqual(hasFeatureAccess("FREE", "manualTradebook"), true);
    });

    it("should return TRUE for FREE + aiQueries (real source)", () => {
      assert.strictEqual(hasFeatureAccess("FREE", "aiQueries"), true);
    });

    it("should return true for PRO + aiQueries", () => {
      assert.strictEqual(hasFeatureAccess("PRO", "aiQueries"), true);
    });

    it("should return true for PRO + aiAnalysis", () => {
      assert.strictEqual(hasFeatureAccess("PRO", "aiAnalysis"), true);
    });

    it("should return false for PRO + aiStrategies", () => {
      assert.strictEqual(hasFeatureAccess("PRO", "aiStrategies"), false);
    });

    it("should return false for PRO + documentVault", () => {
      assert.strictEqual(hasFeatureAccess("PRO", "documentVault"), false);
    });

    it("should return true for PREMIUM + aiStrategies", () => {
      assert.strictEqual(hasFeatureAccess("PREMIUM", "aiStrategies"), true);
    });

    it("should return true for PREMIUM + documentVault", () => {
      assert.strictEqual(hasFeatureAccess("PREMIUM", "documentVault"), true);
    });

    it("should return true for ULTIMATE + learningVideos", () => {
      assert.strictEqual(hasFeatureAccess("ULTIMATE", "learningVideos"), true);
    });

    it("should resolve a legacy plan ID before checking (AI_PRO -> PREMIUM)", () => {
      // AI_PRO maps to PREMIUM, which has aiStrategies
      assert.strictEqual(hasFeatureAccess("AI_PRO", "aiStrategies"), true);
    });

    it("should return false for unknown plan", () => {
      assert.strictEqual(hasFeatureAccess("UNKNOWN", "basicPortfolio"), false);
    });
  });

  // --------------------------------------------------------------------------
  // getFeaturesForPlan
  // --------------------------------------------------------------------------
  describe("getFeaturesForPlan", () => {
    it("should return 6 features for FREE plan", () => {
      const features = getFeaturesForPlan("FREE");
      assert.strictEqual(features.length, 6);
    });

    it("should include manualTradebook and aiQueries for FREE", () => {
      const features = getFeaturesForPlan("FREE");
      assert.ok(features.includes("manualTradebook"));
      assert.ok(features.includes("aiQueries"));
    });

    it("should return 13 features for PRO plan", () => {
      const features = getFeaturesForPlan("PRO");
      assert.strictEqual(features.length, 13);
    });

    it("should return all 25 features for PREMIUM plan", () => {
      const features = getFeaturesForPlan("PREMIUM");
      assert.strictEqual(features.length, 25);
    });

    it("should return all 25 features for ULTIMATE plan", () => {
      const features = getFeaturesForPlan("ULTIMATE");
      assert.strictEqual(features.length, 25);
    });

    it("should resolve legacy IDs (AI_UNLIMITED -> PREMIUM -> 25 features)", () => {
      assert.strictEqual(getFeaturesForPlan("AI_UNLIMITED").length, 25);
    });

    it("should return empty array for unknown plan", () => {
      const features = getFeaturesForPlan("UNKNOWN");
      assert.strictEqual(features.length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // isPlanAtLeast
  // --------------------------------------------------------------------------
  describe("isPlanAtLeast", () => {
    it("FREE >= FREE should be true", () => {
      assert.strictEqual(isPlanAtLeast("FREE", "FREE"), true);
    });

    it("FREE >= PRO should be false", () => {
      assert.strictEqual(isPlanAtLeast("FREE", "PRO"), false);
    });

    it("FREE >= PREMIUM should be false", () => {
      assert.strictEqual(isPlanAtLeast("FREE", "PREMIUM"), false);
    });

    it("PRO >= FREE should be true", () => {
      assert.strictEqual(isPlanAtLeast("PRO", "FREE"), true);
    });

    it("PRO >= PRO should be true", () => {
      assert.strictEqual(isPlanAtLeast("PRO", "PRO"), true);
    });

    it("PRO >= PREMIUM should be false", () => {
      assert.strictEqual(isPlanAtLeast("PRO", "PREMIUM"), false);
    });

    it("PREMIUM >= FREE should be true", () => {
      assert.strictEqual(isPlanAtLeast("PREMIUM", "FREE"), true);
    });

    it("PREMIUM >= PRO should be true", () => {
      assert.strictEqual(isPlanAtLeast("PREMIUM", "PRO"), true);
    });

    it("PREMIUM >= PREMIUM should be true", () => {
      assert.strictEqual(isPlanAtLeast("PREMIUM", "PREMIUM"), true);
    });

    it("ULTIMATE >= PREMIUM should be true (ULTIMATE is a higher tier)", () => {
      assert.strictEqual(isPlanAtLeast("ULTIMATE", "PREMIUM"), true);
    });

    it("PREMIUM >= ULTIMATE should be FALSE (real source — shadow inverted this)", () => {
      assert.strictEqual(isPlanAtLeast("PREMIUM", "ULTIMATE"), false);
    });

    it("ULTIMATE >= ULTIMATE should be true", () => {
      assert.strictEqual(isPlanAtLeast("ULTIMATE", "ULTIMATE"), true);
    });

    it("should resolve legacy IDs on both sides (AI_UNLIMITED >= PRO)", () => {
      // AI_UNLIMITED -> PREMIUM (tier 2) >= PRO (tier 1)
      assert.strictEqual(isPlanAtLeast("AI_UNLIMITED", "PRO"), true);
    });

    it("unknown plan defaults to tier 0 (same as FREE)", () => {
      assert.strictEqual(isPlanAtLeast("UNKNOWN", "FREE"), true);
    });

    it("unknown plan is below PRO", () => {
      assert.strictEqual(isPlanAtLeast("UNKNOWN", "PRO"), false);
    });
  });

  // --------------------------------------------------------------------------
  // getMinimumPlanForFeature
  // --------------------------------------------------------------------------
  describe("getMinimumPlanForFeature", () => {
    it("should return FREE for manualTradebook", () => {
      assert.strictEqual(getMinimumPlanForFeature("manualTradebook"), "FREE");
    });

    it("should return FREE for basicPortfolio", () => {
      assert.strictEqual(getMinimumPlanForFeature("basicPortfolio"), "FREE");
    });

    it("should return FREE for brokerSync", () => {
      assert.strictEqual(getMinimumPlanForFeature("brokerSync"), "FREE");
    });

    it("should return FREE for aiQueries (real source — shadow said PRO)", () => {
      assert.strictEqual(getMinimumPlanForFeature("aiQueries"), "FREE");
    });

    it("should return PRO for unlimitedConnections", () => {
      assert.strictEqual(
        getMinimumPlanForFeature("unlimitedConnections"),
        "PRO"
      );
    });

    it("should return PRO for aiAnalysis", () => {
      assert.strictEqual(getMinimumPlanForFeature("aiAnalysis"), "PRO");
    });

    it("should return PRO for portfolioRoast", () => {
      assert.strictEqual(getMinimumPlanForFeature("portfolioRoast"), "PRO");
    });

    it("should return PREMIUM for aiStrategies", () => {
      assert.strictEqual(getMinimumPlanForFeature("aiStrategies"), "PREMIUM");
    });

    it("should return PREMIUM for learningContent", () => {
      assert.strictEqual(
        getMinimumPlanForFeature("learningContent"),
        "PREMIUM"
      );
    });

    it("should return PREMIUM for documentVault", () => {
      assert.strictEqual(getMinimumPlanForFeature("documentVault"), "PREMIUM");
    });

    it("should return PREMIUM for prioritySupport", () => {
      assert.strictEqual(
        getMinimumPlanForFeature("prioritySupport"),
        "PREMIUM"
      );
    });
  });
});
