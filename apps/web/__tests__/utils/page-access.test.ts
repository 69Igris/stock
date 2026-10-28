/**
 * Page Access & Feature Access Control Tests
 *
 * DE-SHADOWED (MONEY-620). This file used to re-implement getPageAccessInfo,
 * FEATURE_ACCESS, hasFeatureAccess, isPlanAtLeast, getMinimumPlanForFeature, and
 * PAGE_TO_FEATURE_MAP inline and assert the copies. The copies had DRIFTED from
 * source and the tests were green against fiction:
 *   - inline isPlanAtLeast used ULTIMATE: 2 (== PREMIUM); real source is
 *     ULTIMATE: 3, so "PREMIUM >= ULTIMATE" is FALSE, not TRUE.
 *   - inline getPageAccessInfo had NO upgrade branch at all (showUpgrade was
 *     always false) — the real action returns showUpgrade + requiredPlan.
 *   - inline PAGE_TO_FEATURE_MAP mapped /tradebook→tradebookSync,
 *     /analysis→aiAnalysis, /discover→stockDiscovery, had a /tutor route, and
 *     claimed 10 routes; the REAL map (post-MONEY-394) makes those null, has
 *     /sage-tutor (not /tutor), and has 16 routes (incl. /discover/scans).
 *
 * These now assert the REAL exported symbols:
 *   - decidePageAccess  (apps/web/lib/utils/page-access-logic.ts — the pure seam
 *     getPageAccessInfo calls after resolving the plan)
 *   - hasFeatureAccess / isPlanAtLeast / getMinimumPlanForFeature / FEATURE_ACCESS
 *     (@usemoney/core/subscription)
 *   - PAGE_TO_FEATURE_MAP (@/lib/constants/page-features)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasFeatureAccess,
  isPlanAtLeast,
  getMinimumPlanForFeature,
  FEATURE_ACCESS,
  type Feature,
} from "@usemoney/core/subscription";
import { decidePageAccess } from "@/lib/utils/page-access-logic";
import { PAGE_TO_FEATURE_MAP } from "@/lib/constants/page-features";
import type { PageRoute } from "@/lib/types/feature-flags";

// Thin wrapper matching the historical 3-arg signature, defaulting the plan to
// FREE (what the action does for callers without a subscription).
function access(
  route: PageRoute,
  isFeatureFlagEnabled: boolean,
  isDemoMode: boolean,
  planId = "FREE"
) {
  return decidePageAccess({ route, isFeatureFlagEnabled, isDemoMode, planId });
}

describe("Page Access Control (decidePageAccess — real source)", () => {
  // -- Demo Mode --

  describe("Demo mode", () => {
    it("should always allow access in demo mode", () => {
      const result = access("/tradebook", false, true);
      assert.strictEqual(result.isEnabled, true);
      assert.strictEqual(result.showComingSoon, false);
      assert.strictEqual(result.showUpgrade, false);
    });

    it("should allow a PREMIUM-gated page in demo mode even for FREE", () => {
      // /risk requires riskAnalysis (PREMIUM) but demo overrides everything.
      const result = access("/risk", true, true, "FREE");
      assert.strictEqual(result.isEnabled, true);
      assert.strictEqual(result.showUpgrade, false);
    });

    it("should include route in demo mode result", () => {
      assert.strictEqual(access("/tradebook", false, true).route, "/tradebook");
    });
  });

  // -- Feature Flag Disabled --

  describe("Feature flag disabled → Coming Soon", () => {
    it("should show Coming Soon when flag disabled (non-demo)", () => {
      const result = access("/risk", false, false);
      assert.strictEqual(result.isEnabled, false);
      assert.strictEqual(result.showComingSoon, true);
      assert.strictEqual(result.showUpgrade, false);
    });

    it("disabled flag beats the upgrade gate (Coming Soon, not Upgrade)", () => {
      // Even for a gated page + FREE plan, a disabled flag short-circuits first.
      const result = access("/risk", false, false, "FREE");
      assert.strictEqual(result.showComingSoon, true);
      assert.strictEqual(result.showUpgrade, false);
    });
  });

  // -- Feature Flag Enabled + no-feature route --

  describe("Feature flag enabled — null-feature routes always allowed", () => {
    it("allows /tradebook (null feature post-MONEY-394) for FREE", () => {
      const result = access("/tradebook", true, false, "FREE");
      assert.strictEqual(result.isEnabled, true);
      assert.strictEqual(result.showUpgrade, false);
    });

    it("allows /analysis (null feature post-MONEY-394) for FREE", () => {
      const result = access("/analysis", true, false, "FREE");
      assert.strictEqual(result.isEnabled, true);
      assert.strictEqual(result.showUpgrade, false);
    });
  });

  // -- Upgrade branch (the branch the shadow NEVER had) --

  describe("Upgrade branch (flag on, plan lacks the feature)", () => {
    it("FREE on /risk → upgrade with requiredPlan PREMIUM", () => {
      const result = access("/risk", true, false, "FREE");
      assert.strictEqual(result.isEnabled, false);
      assert.strictEqual(result.showComingSoon, false);
      assert.strictEqual(result.showUpgrade, true);
      assert.strictEqual(result.requiredPlan, "PREMIUM");
    });

    it("FREE on /tax → upgrade with requiredPlan PREMIUM", () => {
      const result = access("/tax", true, false, "FREE");
      assert.strictEqual(result.showUpgrade, true);
      assert.strictEqual(result.requiredPlan, "PREMIUM");
    });

    it("PRO on /risk → still upgrade (riskAnalysis is PREMIUM+)", () => {
      const result = access("/risk", true, false, "PRO");
      assert.strictEqual(result.showUpgrade, true);
      assert.strictEqual(result.requiredPlan, "PREMIUM");
    });

    it("PREMIUM on /risk → allowed (has the feature)", () => {
      const result = access("/risk", true, false, "PREMIUM");
      assert.strictEqual(result.isEnabled, true);
      assert.strictEqual(result.showUpgrade, false);
    });

    it("ULTIMATE on /risk → allowed", () => {
      const result = access("/risk", true, false, "ULTIMATE");
      assert.strictEqual(result.isEnabled, true);
    });

    it("FREE on /strategies → upgrade to PREMIUM (aiStrategies)", () => {
      const result = access("/strategies", true, false, "FREE");
      assert.strictEqual(result.showUpgrade, true);
      assert.strictEqual(result.requiredPlan, "PREMIUM");
    });
  });

  // -- Mutual exclusivity invariant across every real route × plan × flags --

  describe("Invariants across all real routes", () => {
    const ALL_ROUTES = Object.keys(PAGE_TO_FEATURE_MAP) as PageRoute[];
    const PLANS = ["FREE", "PRO", "PREMIUM", "ULTIMATE", "UNKNOWN"];

    it("never sets both comingSoon and upgrade", () => {
      for (const route of ALL_ROUTES) {
        for (const flag of [true, false]) {
          for (const demo of [true, false]) {
            for (const plan of PLANS) {
              const r = access(route, flag, demo, plan);
              assert.ok(
                !(r.showComingSoon && r.showUpgrade),
                `${route} flag=${flag} demo=${demo} plan=${plan}`
              );
              // requiredPlan only ever accompanies an upgrade.
              if (r.requiredPlan !== undefined) {
                assert.strictEqual(r.showUpgrade, true);
              }
              // isEnabled true ⇒ neither coming-soon nor upgrade.
              if (r.isEnabled) {
                assert.ok(!r.showComingSoon && !r.showUpgrade);
              }
            }
          }
        }
      }
    });

    it("demo mode enables every real route regardless of plan/flag", () => {
      for (const route of ALL_ROUTES) {
        const r = access(route, false, false, "FREE");
        const demo = access(route, false, true, "FREE");
        assert.strictEqual(demo.isEnabled, true, `demo ${route}`);
        // sanity: the non-demo path is allowed to differ
        assert.strictEqual(demo.route, r.route);
      }
    });
  });
});

describe("Feature Access Control (real @usemoney/core/subscription)", () => {
  describe("hasFeatureAccess", () => {
    it("FREE can access manualTradebook + paperTrading", () => {
      assert.strictEqual(hasFeatureAccess("FREE", "manualTradebook"), true);
      assert.strictEqual(hasFeatureAccess("FREE", "paperTrading"), true);
    });

    it("FREE can access aiQueries (Flash chat is free) — MONEY-394", () => {
      // The shadow asserted aiQueries was PRO-only; the real matrix opened it to
      // FREE. Pin the real contract so a regression here is caught.
      assert.strictEqual(hasFeatureAccess("FREE", "aiQueries"), true);
    });

    it("FREE cannot access unlimitedConnections / aiAnalysis", () => {
      assert.strictEqual(
        hasFeatureAccess("FREE", "unlimitedConnections"),
        false
      );
      assert.strictEqual(hasFeatureAccess("FREE", "aiAnalysis"), false);
    });

    it("PRO can access portfolioRoast + aiAnalysis but NOT aiStrategies", () => {
      assert.strictEqual(hasFeatureAccess("PRO", "portfolioRoast"), true);
      assert.strictEqual(hasFeatureAccess("PRO", "aiAnalysis"), true);
      assert.strictEqual(hasFeatureAccess("PRO", "aiStrategies"), false);
    });

    it("PREMIUM and ULTIMATE access documentVault", () => {
      assert.strictEqual(hasFeatureAccess("PREMIUM", "documentVault"), true);
      assert.strictEqual(hasFeatureAccess("ULTIMATE", "documentVault"), true);
    });

    // -- adversarial / negative inputs --
    it("unknown / empty / mis-cased / null-ish plans deny every feature", () => {
      for (const bad of [
        "",
        "UNKNOWN",
        "free",
        "Premium",
        "null",
        "undefined",
        " FREE ",
      ]) {
        assert.strictEqual(
          hasFeatureAccess(bad, "manualTradebook"),
          false,
          `plan="${bad}"`
        );
      }
    });
  });

  describe("isPlanAtLeast", () => {
    it("every plan is at least itself", () => {
      for (const p of ["FREE", "PRO", "PREMIUM", "ULTIMATE"]) {
        assert.strictEqual(isPlanAtLeast(p, p), true, p);
      }
    });

    it("strict tier ordering FREE < PRO < PREMIUM < ULTIMATE", () => {
      assert.strictEqual(isPlanAtLeast("PRO", "FREE"), true);
      assert.strictEqual(isPlanAtLeast("PREMIUM", "PRO"), true);
      assert.strictEqual(isPlanAtLeast("ULTIMATE", "PREMIUM"), true);
      assert.strictEqual(isPlanAtLeast("FREE", "PRO"), false);
      assert.strictEqual(isPlanAtLeast("PRO", "PREMIUM"), false);
    });

    it("ULTIMATE is STRICTLY above PREMIUM (real ULTIMATE: 3) — shadow had this wrong", () => {
      assert.strictEqual(isPlanAtLeast("ULTIMATE", "PREMIUM"), true);
      // The stale shadow asserted this was TRUE (ULTIMATE: 2). It is FALSE.
      assert.strictEqual(isPlanAtLeast("PREMIUM", "ULTIMATE"), false);
    });

    it("unknown plans collapse to tier 0", () => {
      assert.strictEqual(isPlanAtLeast("UNKNOWN", "FREE"), true);
      assert.strictEqual(isPlanAtLeast("UNKNOWN", "PRO"), false);
      assert.strictEqual(isPlanAtLeast("PLAN_A", "PLAN_B"), true);
    });
  });

  describe("getMinimumPlanForFeature", () => {
    it("FREE-tier features → FREE", () => {
      for (const f of [
        "manualTradebook",
        "paperTrading",
        "aiQueries",
      ] as Feature[]) {
        assert.strictEqual(getMinimumPlanForFeature(f), "FREE", f);
      }
    });

    it("PRO-tier features → PRO", () => {
      for (const f of [
        "tradebookSync",
        "portfolioRoast",
        "aiAnalysis",
      ] as Feature[]) {
        assert.strictEqual(getMinimumPlanForFeature(f), "PRO", f);
      }
    });

    it("PREMIUM-tier features → PREMIUM", () => {
      for (const f of [
        "aiStrategies",
        "taxAnalysis",
        "riskAnalysis",
        "documentVault",
      ] as Feature[]) {
        assert.strictEqual(getMinimumPlanForFeature(f), "PREMIUM", f);
      }
    });

    it("the minimum plan it returns actually has access (round-trip)", () => {
      for (const feature of Object.keys(FEATURE_ACCESS) as Feature[]) {
        const min = getMinimumPlanForFeature(feature);
        assert.strictEqual(
          hasFeatureAccess(min, feature),
          true,
          `${feature} min=${min} should self-grant`
        );
      }
    });
  });
});

describe("PAGE_TO_FEATURE_MAP (real constant — post-MONEY-394 shape)", () => {
  it("has 16 routes (15 + /discover/scans, MONEY-1058)", () => {
    assert.strictEqual(Object.keys(PAGE_TO_FEATURE_MAP).length, 16);
  });

  it("/tradebook, /analysis, /discover, /roast are null (free surfaces)", () => {
    assert.strictEqual(PAGE_TO_FEATURE_MAP["/tradebook"], null);
    assert.strictEqual(PAGE_TO_FEATURE_MAP["/analysis"], null);
    assert.strictEqual(PAGE_TO_FEATURE_MAP["/discover"], null);
    assert.strictEqual(PAGE_TO_FEATURE_MAP["/roast"], null);
  });

  it("/risk→riskAnalysis, /tax→taxAnalysis, /documents→documentVault", () => {
    assert.strictEqual(PAGE_TO_FEATURE_MAP["/risk"], "riskAnalysis");
    assert.strictEqual(PAGE_TO_FEATURE_MAP["/tax"], "taxAnalysis");
    assert.strictEqual(PAGE_TO_FEATURE_MAP["/documents"], "documentVault");
  });

  it("uses /sage-tutor (not the deleted /tutor)", () => {
    assert.ok("/sage-tutor" in PAGE_TO_FEATURE_MAP);
    assert.ok(!("/tutor" in PAGE_TO_FEATURE_MAP));
    assert.strictEqual(PAGE_TO_FEATURE_MAP["/sage-tutor"], "aiLearning");
  });

  it("every non-null feature exists in the real FEATURE_ACCESS matrix", () => {
    for (const [route, feature] of Object.entries(PAGE_TO_FEATURE_MAP)) {
      if (feature !== null) {
        assert.ok(
          FEATURE_ACCESS[feature] !== undefined,
          `feature ${feature} for ${route} missing from FEATURE_ACCESS`
        );
      }
    }
  });
});
