/**
 * Page Access & Feature Access Control - Extended (exhaustive matrices)
 *
 * DE-SHADOWED (MONEY-620). Previously re-implemented every helper inline with
 * the same stale drift as page-access.test.ts (ULTIMATE: 2, 10-route map, no
 * upgrade branch). Now drives the REAL exported symbols exhaustively:
 *   - decidePageAccess (the pure seam getPageAccessInfo calls)
 *   - hasFeatureAccess / isPlanAtLeast / getMinimumPlanForFeature / FEATURE_ACCESS
 *   - PAGE_TO_FEATURE_MAP
 *
 * The base file pins specific contract points; this file proves the
 * cross-product invariants that an inline copy can never keep honest.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasFeatureAccess,
  isPlanAtLeast,
  getMinimumPlanForFeature,
  getFeaturesForPlan,
  FEATURE_ACCESS,
  type Feature,
} from "@usemoney/core/subscription";
import { decidePageAccess } from "@/lib/utils/page-access-logic";
import { PAGE_TO_FEATURE_MAP } from "@/lib/constants/page-features";
import type { PageRoute } from "@/lib/types/feature-flags";

const ALL_ROUTES = Object.keys(PAGE_TO_FEATURE_MAP) as PageRoute[];
const ALL_FEATURES = Object.keys(FEATURE_ACCESS) as Feature[];
const TIERS = ["FREE", "PRO", "PREMIUM", "ULTIMATE"] as const;

describe("decidePageAccess — exhaustive route × plan", () => {
  describe("Demo mode enables every route for every plan", () => {
    for (const route of ALL_ROUTES) {
      it(`demo: ${route} enabled for all plans`, () => {
        for (const plan of TIERS) {
          const r = decidePageAccess({
            route,
            isFeatureFlagEnabled: false,
            isDemoMode: true,
            planId: plan,
          });
          assert.strictEqual(r.isEnabled, true);
          assert.strictEqual(r.showComingSoon, false);
          assert.strictEqual(r.showUpgrade, false);
          assert.strictEqual(r.route, route);
        }
      });
    }
  });

  describe("Flag OFF (non-demo) → Coming Soon for every route", () => {
    for (const route of ALL_ROUTES) {
      it(`flag off: ${route} → coming soon`, () => {
        const r = decidePageAccess({
          route,
          isFeatureFlagEnabled: false,
          isDemoMode: false,
          planId: "ULTIMATE", // even the top plan sees Coming Soon when flag off
        });
        assert.strictEqual(r.isEnabled, false);
        assert.strictEqual(r.showComingSoon, true);
        assert.strictEqual(r.showUpgrade, false);
      });
    }
  });

  describe("Flag ON: gating exactly tracks PAGE_TO_FEATURE_MAP × FEATURE_ACCESS", () => {
    for (const route of ALL_ROUTES) {
      const feature = PAGE_TO_FEATURE_MAP[route];
      for (const plan of TIERS) {
        const expectAllowed =
          feature === null ? true : hasFeatureAccess(plan, feature);
        it(`flag on: ${route} for ${plan} → ${expectAllowed ? "allow" : "upgrade"}`, () => {
          const r = decidePageAccess({
            route,
            isFeatureFlagEnabled: true,
            isDemoMode: false,
            planId: plan,
          });
          if (expectAllowed) {
            assert.strictEqual(r.isEnabled, true, `${route}/${plan}`);
            assert.strictEqual(r.showUpgrade, false);
          } else {
            assert.strictEqual(r.isEnabled, false, `${route}/${plan}`);
            assert.strictEqual(r.showUpgrade, true);
            assert.strictEqual(
              r.requiredPlan,
              getMinimumPlanForFeature(feature as Feature)
            );
          }
        });
      }
    }
  });
});

describe("FEATURE_ACCESS matrix — per-plan exhaustive", () => {
  describe("hasFeatureAccess is monotonic up the tier ladder", () => {
    // If a lower tier has a feature, every higher tier must too (no
    // "feature lost on upgrade" regressions). FREE→PRO→PREMIUM→ULTIMATE.
    it("no feature is granted to a lower tier but denied to a higher one", () => {
      for (const feature of ALL_FEATURES) {
        let seenGranted = false;
        for (const plan of TIERS) {
          const has = hasFeatureAccess(plan, feature);
          if (has) seenGranted = true;
          if (seenGranted) {
            assert.strictEqual(
              has,
              true,
              `${feature}: ${plan} must keep access once a lower tier had it`
            );
          }
        }
      }
    });
  });

  describe("getFeaturesForPlan ⇔ hasFeatureAccess agree", () => {
    for (const plan of TIERS) {
      it(`${plan}: the two views are consistent`, () => {
        const list = new Set(getFeaturesForPlan(plan));
        for (const feature of ALL_FEATURES) {
          assert.strictEqual(
            list.has(feature),
            hasFeatureAccess(plan, feature),
            `${plan} / ${feature}`
          );
        }
      });
    }
  });

  describe("ULTIMATE is a superset of PREMIUM (and PREMIUM of PRO, PRO of FREE)", () => {
    const pairs: Array<[string, string]> = [
      ["ULTIMATE", "PREMIUM"],
      ["PREMIUM", "PRO"],
      ["PRO", "FREE"],
    ];
    for (const [hi, lo] of pairs) {
      it(`${hi} ⊇ ${lo}`, () => {
        for (const feature of ALL_FEATURES) {
          if (hasFeatureAccess(lo, feature)) {
            assert.strictEqual(
              hasFeatureAccess(hi, feature),
              true,
              `${hi} should also grant ${feature}`
            );
          }
        }
      });
    }
  });
});

describe("isPlanAtLeast — full ordering matrix", () => {
  // Real tiers: FREE 0 < PRO 1 < PREMIUM 2 < ULTIMATE 3.
  const rank: Record<string, number> = {
    FREE: 0,
    PRO: 1,
    PREMIUM: 2,
    ULTIMATE: 3,
  };
  for (const a of TIERS) {
    for (const b of TIERS) {
      it(`${a} >= ${b} ⇔ rank(${a}) >= rank(${b})`, () => {
        assert.strictEqual(isPlanAtLeast(a, b), rank[a] >= rank[b]);
      });
    }
  }

  it("unknown plans behave as tier 0 on both sides", () => {
    assert.strictEqual(isPlanAtLeast("WAT", "FREE"), true);
    assert.strictEqual(isPlanAtLeast("WAT", "PRO"), false);
    assert.strictEqual(isPlanAtLeast("FREE", "WAT"), true);
  });
});

describe("getMinimumPlanForFeature — exhaustive self-consistency", () => {
  it("returned min plan grants the feature; the tier just below does NOT", () => {
    const order = ["FREE", "PRO", "PREMIUM", "ULTIMATE"];
    for (const feature of ALL_FEATURES) {
      const min = getMinimumPlanForFeature(feature);
      assert.strictEqual(
        hasFeatureAccess(min, feature),
        true,
        `${feature} min`
      );
      const idx = order.indexOf(min);
      if (idx > 0) {
        const below = order[idx - 1]!;
        assert.strictEqual(
          hasFeatureAccess(below, feature),
          false,
          `${feature}: ${below} (below min ${min}) must NOT have access`
        );
      }
    }
  });
});
