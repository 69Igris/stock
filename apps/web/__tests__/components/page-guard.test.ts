/**
 * PageGuard Tests
 *
 * De-shadowed (MONEY-620): imports the REAL guard logic from
 * components/page-guard-logic.ts (which PageGuard.tsx renders from), the REAL
 * route→feature map (@/lib/constants/page-features), and the REAL subscription
 * predicates (@usemoney/core/subscription).
 *
 * The old shadow re-declared a STALE PAGE_TO_FEATURE_MAP + PAGE_CONFIG: it
 * mapped /roast→portfolioRoast, /tradebook→tradebookSync, /documents→null, etc.
 * MONEY-394 had since flipped most routes to `null` (free page access, gated at
 * the action level) — so the shadow was green while asserting behavior the
 * product no longer has. These assertions now pin the REAL map + the real
 * decision, and would fail if PageGuard regressed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeGuardDecision,
  PAGE_META,
  KILL_SWITCH_REDIRECT_ROUTES,
} from "../../components/page-guard-logic";
import { PAGE_TO_FEATURE_MAP } from "@/lib/constants/page-features";
import { isPlanAtLeast } from "@usemoney/core/subscription";
import type { PageRoute } from "@/lib/types/feature-flags";

const ALL_ROUTES: PageRoute[] = [
  "/tradebook",
  "/positions",
  "/holdings",
  "/paper-trading",
  "/discover",
  "/analysis",
  "/sage-tutor",
  "/learning",
  "/watchlist",
  "/roast",
  "/risk",
  "/tax",
  "/documents",
  "/strategies",
  "/quizzes",
  "/discover/scans",
];

function decide(
  route: PageRoute,
  flags: Record<string, boolean>,
  isDemoMode: boolean,
  planId: string,
  isLoading: boolean,
  isShipped = false
) {
  return computeGuardDecision({
    route,
    flags,
    isDemoMode,
    planId,
    isLoading,
    isShipped,
  });
}

function renderPath(d: ReturnType<typeof decide>): string {
  if (d.shouldRedirect) return "redirect";
  if (d.shouldShowComingSoon) return "comingSoon";
  if (d.showUpgrade) return "upgrade";
  return "children";
}

describe("PageGuard", () => {
  // -----------------------------------------------------------------------
  // PAGE_META (the real per-route copy used by ComingSoon / Upgrade)
  // -----------------------------------------------------------------------
  describe("PAGE_META", () => {
    it("has an entry for every PageRoute", () => {
      for (const route of ALL_ROUTES) {
        assert.ok(PAGE_META[route], `Missing PAGE_META entry for ${route}`);
      }
    });

    it("each entry has a non-empty name and description", () => {
      for (const route of ALL_ROUTES) {
        const meta = PAGE_META[route];
        assert.equal(typeof meta.name, "string");
        assert.ok(meta.name.length > 0, `Empty name for ${route}`);
        assert.equal(typeof meta.description, "string");
        assert.ok(
          meta.description.length > 0,
          `Empty description for ${route}`
        );
      }
    });

    it("has exactly 16 route entries", () => {
      assert.equal(Object.keys(PAGE_META).length, 16);
    });
  });

  // -----------------------------------------------------------------------
  // PAGE_TO_FEATURE_MAP — assert the REAL (MONEY-394) mapping.
  // -----------------------------------------------------------------------
  describe("PAGE_TO_FEATURE_MAP (real)", () => {
    it("/roast is free (null) post-MONEY-394, not portfolioRoast", () => {
      assert.equal(PAGE_TO_FEATURE_MAP["/roast"], null);
    });

    it("/tradebook is free (null), gated at import-time instead", () => {
      assert.equal(PAGE_TO_FEATURE_MAP["/tradebook"], null);
    });

    it("/analysis and /discover are free (null) — credit-gated at the action", () => {
      assert.equal(PAGE_TO_FEATURE_MAP["/analysis"], null);
      assert.equal(PAGE_TO_FEATURE_MAP["/discover"], null);
    });

    it("/documents requires the documentVault feature", () => {
      assert.equal(PAGE_TO_FEATURE_MAP["/documents"], "documentVault");
    });

    it("/risk requires riskAnalysis, /tax requires taxAnalysis", () => {
      assert.equal(PAGE_TO_FEATURE_MAP["/risk"], "riskAnalysis");
      assert.equal(PAGE_TO_FEATURE_MAP["/tax"], "taxAnalysis");
    });

    it("/sage-tutor requires aiLearning; /learning is open (MONEY-1149)", () => {
      assert.equal(PAGE_TO_FEATURE_MAP["/sage-tutor"], "aiLearning");
      // MONEY-1149: this asserted "learningContent", which PageGuard enforced
      // while the lesson text behind the page was gated only by
      // `advancedCourses` — so a FREE user was blocked from a page whose
      // content the server would hand them on direct request. Resolved in
      // favour of the code: the page is open, the ADVANCED gate is the paywall
      // on text, and premium media stays gated in /api/storage/stream.
      assert.equal(PAGE_TO_FEATURE_MAP["/learning"], null);
    });

    it("an unknown route is not in the map (undefined)", () => {
      assert.equal(PAGE_TO_FEATURE_MAP["/nonexistent" as PageRoute], undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Demo mode bypass
  // -----------------------------------------------------------------------
  describe("demo mode", () => {
    it("bypasses the feature flag (disabled flag still grants access)", () => {
      const d = decide("/risk", { "/risk": false }, true, "FREE", false);
      assert.equal(renderPath(d), "children");
    });

    it("bypasses the subscription check (FREE on a PREMIUM feature)", () => {
      const d = decide("/tax", { "/tax": true }, true, "FREE", false);
      assert.equal(renderPath(d), "children");
    });

    it("STILL redirects kill-switch routes in demo (paper-trading)", () => {
      const d = decide(
        "/paper-trading",
        { "/paper-trading": true },
        true,
        "FREE",
        false
      );
      assert.equal(renderPath(d), "redirect");
    });
  });

  // -----------------------------------------------------------------------
  // Feature flag disabled → ComingSoon (or redirect for kill-switch)
  // -----------------------------------------------------------------------
  describe("feature flag disabled", () => {
    it("shows ComingSoon when a non-kill-switch flag is false", () => {
      const d = decide("/risk", { "/risk": false }, false, "PREMIUM", false);
      assert.equal(renderPath(d), "comingSoon");
    });

    it("redirects (not ComingSoon) when a kill-switch flag is false", () => {
      const d = decide(
        "/paper-trading",
        { "/paper-trading": false },
        false,
        "PREMIUM",
        false
      );
      assert.equal(renderPath(d), "redirect");
    });

    it("a shipped (ALWAYS_ON) route ignores a false flag", () => {
      // isShipped short-circuits the flag check; with no feature gate it renders.
      const d = decide(
        "/holdings",
        { "/holdings": false },
        false,
        "FREE",
        false,
        true
      );
      assert.equal(renderPath(d), "children");
    });
  });

  // -----------------------------------------------------------------------
  // Feature flag enabled + insufficient plan → Upgrade
  // -----------------------------------------------------------------------
  describe("feature flag enabled + insufficient plan", () => {
    it("FREE user on /risk (requires PREMIUM via riskAnalysis) sees upgrade", () => {
      const d = decide("/risk", { "/risk": true }, false, "FREE", false);
      assert.equal(renderPath(d), "upgrade");
      assert.equal(d.requiredPlan, "PREMIUM");
    });

    it("PRO user on /tax (requires PREMIUM) sees upgrade", () => {
      const d = decide("/tax", { "/tax": true }, false, "PRO", false);
      assert.equal(renderPath(d), "upgrade");
      assert.equal(d.requiredPlan, "PREMIUM");
    });

    it("FREE user on /documents (requires documentVault) sees upgrade", () => {
      const d = decide(
        "/documents",
        { "/documents": true },
        false,
        "FREE",
        false
      );
      assert.equal(renderPath(d), "upgrade");
    });
  });

  // -----------------------------------------------------------------------
  // Free routes + sufficient plans → children
  // -----------------------------------------------------------------------
  describe("feature flag enabled + access granted", () => {
    it("FREE user reaches /roast (null mapping — free page)", () => {
      const d = decide("/roast", { "/roast": true }, false, "FREE", false);
      assert.equal(renderPath(d), "children");
    });

    it("FREE user reaches /tradebook (null mapping)", () => {
      const d = decide(
        "/tradebook",
        { "/tradebook": true },
        false,
        "FREE",
        false
      );
      assert.equal(renderPath(d), "children");
    });

    it("PREMIUM user reaches /risk (requires PREMIUM)", () => {
      const d = decide("/risk", { "/risk": true }, false, "PREMIUM", false);
      assert.equal(renderPath(d), "children");
    });

    it("ULTIMATE user reaches /strategies (requires PREMIUM)", () => {
      const d = decide(
        "/strategies",
        { "/strategies": true },
        false,
        "ULTIMATE",
        false
      );
      assert.equal(renderPath(d), "children");
    });

    it("FREE user reaches /watchlist (null mapping)", () => {
      const d = decide(
        "/watchlist",
        { "/watchlist": true },
        false,
        "FREE",
        false
      );
      assert.equal(renderPath(d), "children");
    });
  });

  // -----------------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------------
  describe("loading state", () => {
    it("returns no-gate defaults while loading", () => {
      const d = decide("/risk", {}, false, "FREE", true);
      assert.equal(renderPath(d), "children"); // caller renders skeleton on isLoading first
      assert.equal(d.shouldShowComingSoon, false);
      assert.equal(d.showUpgrade, false);
      assert.equal(d.shouldRedirect, false);
    });

    it("loading suppresses ComingSoon even when the flag is false", () => {
      const d = decide("/risk", { "/risk": false }, false, "FREE", true);
      assert.equal(d.shouldShowComingSoon, false);
    });
  });

  // -----------------------------------------------------------------------
  // Kill-switch set
  // -----------------------------------------------------------------------
  describe("KILL_SWITCH_REDIRECT_ROUTES", () => {
    it("contains /paper-trading", () => {
      assert.ok(KILL_SWITCH_REDIRECT_ROUTES.has("/paper-trading"));
    });

    it("does not contain /risk", () => {
      assert.ok(!KILL_SWITCH_REDIRECT_ROUTES.has("/risk"));
    });

    it("contains /discover/scans (founder-only, MONEY-1058)", () => {
      assert.ok(KILL_SWITCH_REDIRECT_ROUTES.has("/discover/scans"));
    });
  });

  // -----------------------------------------------------------------------
  // Scans — founder-only gate (MONEY-1058). Kill-switch route: the flag is
  // true only for the founder; everyone else + demo redirect to /dashboard
  // (never a ComingSoon teaser for an unfinished surface).
  // -----------------------------------------------------------------------
  describe("/discover/scans (founder-only)", () => {
    it("founder (flag on, real session) reaches the page", () => {
      const d = decide(
        "/discover/scans",
        { "/discover/scans": true },
        false,
        "FREE",
        false
      );
      assert.equal(renderPath(d), "children");
    });

    it("non-allowlisted user (flag off) is redirected, NOT shown ComingSoon", () => {
      const d = decide(
        "/discover/scans",
        { "/discover/scans": false },
        false,
        "PREMIUM",
        false
      );
      assert.equal(renderPath(d), "redirect");
    });

    it("demo mode is redirected even though demo normally bypasses gates", () => {
      const d = decide(
        "/discover/scans",
        { "/discover/scans": true },
        true,
        "FREE",
        false
      );
      assert.equal(renderPath(d), "redirect");
    });
  });

  // -----------------------------------------------------------------------
  // Kill-switch fail-closed on UNDEFINED flags (MONEY-1053). Kill-switch
  // routes require an EXPLICIT `true`: a stale pre-deploy flag map
  // (localStorage/Redis cache written before the route's key existed →
  // `undefined`) must REDIRECT, not fall through to the founder-only page.
  // Non-kill-switch gated routes keep the optimistic-true default
  // (`undefined` → children) — pinned here so the two semantics never merge.
  // -----------------------------------------------------------------------
  describe("kill-switch fail-closed on undefined flags (MONEY-1053)", () => {
    it("undefined flag on /discover/scans (stale cache, non-demo) redirects — never renders the founder-only page", () => {
      const d = decide("/discover/scans", {}, false, "PREMIUM", false);
      assert.equal(renderPath(d), "redirect");
    });

    it("undefined flag on /discover/scans redirects regardless of plan", () => {
      for (const plan of ["FREE", "PREMIUM", "PRO", "ULTIMATE"]) {
        const d = decide("/discover/scans", {}, false, plan, false);
        assert.equal(renderPath(d), "redirect", `plan ${plan} must redirect`);
      }
    });

    it("undefined flag on /paper-trading redirects (pins the undefined case, not just false)", () => {
      const d = decide("/paper-trading", {}, false, "PREMIUM", false);
      assert.equal(renderPath(d), "redirect");
    });

    it("explicit true on /discover/scans still renders children", () => {
      const d = decide(
        "/discover/scans",
        { "/discover/scans": true },
        false,
        "FREE",
        false
      );
      assert.equal(renderPath(d), "children");
    });

    it("undefined flag on NON-kill-switch /risk keeps optimistic-true (children, not ComingSoon)", () => {
      // /risk is flag-gated but NOT a kill-switch: an undefined flag must
      // still fall through to the plan check (PREMIUM here → children) so a
      // briefly-missing key never flashes ComingSoon over a live surface.
      const d = decide("/risk", {}, false, "PREMIUM", false);
      assert.equal(renderPath(d), "children");
    });

    it("a shipped (ALWAYS_ON) kill-switch route skips the fail-closed gate", () => {
      // isShipped short-circuits both flag checks: if a kill-switch route
      // ever graduates to ALWAYS_ON, an undefined flag must not redirect it.
      const d = decide("/paper-trading", {}, false, "FREE", false, true);
      assert.equal(renderPath(d), "children");
    });
  });

  // -----------------------------------------------------------------------
  // isPlanAtLeast boundary tests (the REAL shared predicate)
  // -----------------------------------------------------------------------
  describe("isPlanAtLeast (real)", () => {
    it("exact match grants access (PRO >= PRO)", () => {
      assert.equal(isPlanAtLeast("PRO", "PRO"), true);
    });

    it("higher grants access (PREMIUM >= PRO)", () => {
      assert.equal(isPlanAtLeast("PREMIUM", "PRO"), true);
    });

    it("lower denies access (FREE < PRO)", () => {
      assert.equal(isPlanAtLeast("FREE", "PRO"), false);
    });

    it("FREE meets FREE, ULTIMATE meets ULTIMATE", () => {
      assert.equal(isPlanAtLeast("FREE", "FREE"), true);
      assert.equal(isPlanAtLeast("ULTIMATE", "ULTIMATE"), true);
    });

    it("an unknown plan id defaults to tier 0 (same as FREE)", () => {
      assert.equal(isPlanAtLeast("RANDOM", "FREE"), true);
      assert.equal(isPlanAtLeast("RANDOM", "PRO"), false);
    });
  });
});
