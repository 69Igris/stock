/**
 * FeatureGate Tests
 *
 * De-shadowed (MONEY-620): imports the REAL PLAN_NAMES, TIER_ORDER,
 * resolveAccess, and resolveRenderPath from components/feature-gate-logic.ts.
 * FeatureGate.tsx's checkAccess callback calls resolveAccess and its render
 * branches call resolveRenderPath — so these assertions exercise the production
 * decision logic, not an inline copy.
 *
 * (The old shadow also re-implemented a `getHOCGateProps` helper that didn't
 * exist in source — withFeatureGate just renders <FeatureGate><Component/></>,
 * which is a JSX wrapper with no extractable pure logic — so those copy-only
 * assertions are dropped.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_NAMES,
  TIER_ORDER,
  resolveAccess,
  resolveRenderPath,
} from "../../components/feature-gate-logic";

describe("FeatureGate", () => {
  // -----------------------------------------------------------------------
  // Tier Comparison Logic
  // -----------------------------------------------------------------------
  describe("TIER_ORDER", () => {
    it("orders FREE < PRO < PREMIUM < ULTIMATE", () => {
      assert.ok(TIER_ORDER["FREE"]! < TIER_ORDER["PRO"]!);
      assert.ok(TIER_ORDER["PRO"]! < TIER_ORDER["PREMIUM"]!);
      assert.ok(TIER_ORDER["PREMIUM"]! < TIER_ORDER["ULTIMATE"]!);
    });

    it("FREE is 0, ULTIMATE is 3", () => {
      assert.equal(TIER_ORDER["FREE"], 0);
      assert.equal(TIER_ORDER["ULTIMATE"], 3);
    });

    it("unknown plan defaults to tier 0 via nullish coalescing", () => {
      assert.equal(TIER_ORDER["UNKNOWN_PLAN"] ?? 0, 0);
    });

    it("an unknown planId is treated as FREE for access (cannot reach PRO)", () => {
      const r = resolveAccess(
        false,
        { ok: true, data: { planId: "NONSENSE" } },
        "PRO"
      );
      assert.equal(r.hasAccess, false);
    });
  });

  // -----------------------------------------------------------------------
  // PLAN_NAMES
  // -----------------------------------------------------------------------
  describe("PLAN_NAMES", () => {
    it("maps PRO/PREMIUM/ULTIMATE to friendly names", () => {
      assert.equal(PLAN_NAMES["PRO"], "Pro");
      assert.equal(PLAN_NAMES["PREMIUM"], "Premium");
      assert.equal(PLAN_NAMES["ULTIMATE"], "Ultimate");
    });

    it("does not contain FREE", () => {
      assert.equal(PLAN_NAMES["FREE"], undefined);
    });
  });

  // -----------------------------------------------------------------------
  // Demo Mode
  // -----------------------------------------------------------------------
  describe("demo mode", () => {
    it("grants access as PRO regardless of the requiredPlan or fetch state", () => {
      const r1 = resolveAccess(true, { ok: false }, "PREMIUM");
      assert.equal(r1.hasAccess, true);
      assert.equal(r1.currentPlan, "PRO");

      const r2 = resolveAccess(true, "error", "ULTIMATE");
      assert.equal(r2.hasAccess, true);
      assert.equal(r2.currentPlan, "PRO");
    });
  });

  // -----------------------------------------------------------------------
  // API Fetch Failure
  // -----------------------------------------------------------------------
  describe("API fetch failure", () => {
    it("no access + plan stays FREE on a thrown fetch", () => {
      const r = resolveAccess(false, "error", "PRO");
      assert.equal(r.hasAccess, false);
      assert.equal(r.currentPlan, "FREE");
    });

    it("no access on a non-OK response", () => {
      const r = resolveAccess(false, { ok: false }, "PRO");
      assert.equal(r.hasAccess, false);
      assert.equal(r.currentPlan, "FREE");
    });
  });

  // -----------------------------------------------------------------------
  // API Returns null/undefined planId
  // -----------------------------------------------------------------------
  describe("API returns null/undefined planId", () => {
    it("defaults to FREE when data is missing", () => {
      const r = resolveAccess(false, { ok: true, data: null }, "PRO");
      assert.equal(r.currentPlan, "FREE");
      assert.equal(r.hasAccess, false);
    });

    it("defaults to FREE when data.planId is missing", () => {
      const r = resolveAccess(false, { ok: true, data: {} }, "PRO");
      assert.equal(r.currentPlan, "FREE");
    });

    it("FREE planId still satisfies a FREE-tier (or unknown) requirement", () => {
      // both default to tier 0: 0 >= 0 => true
      const r = resolveAccess(false, { ok: true, data: {} }, "NONEXISTENT");
      assert.equal(r.hasAccess, true);
    });
  });

  // -----------------------------------------------------------------------
  // Access Check: Plan Meets Requirement
  // -----------------------------------------------------------------------
  describe("access check - plan meets requirement", () => {
    it("equal/higher tiers gain access", () => {
      assert.equal(
        resolveAccess(false, { ok: true, data: { planId: "PRO" } }, "PRO")
          .hasAccess,
        true
      );
      assert.equal(
        resolveAccess(false, { ok: true, data: { planId: "PREMIUM" } }, "PRO")
          .hasAccess,
        true
      );
      assert.equal(
        resolveAccess(
          false,
          { ok: true, data: { planId: "ULTIMATE" } },
          "PREMIUM"
        ).hasAccess,
        true
      );
    });

    it("lower tiers are denied", () => {
      assert.equal(
        resolveAccess(false, { ok: true, data: { planId: "FREE" } }, "PRO")
          .hasAccess,
        false
      );
      assert.equal(
        resolveAccess(false, { ok: true, data: { planId: "PRO" } }, "PREMIUM")
          .hasAccess,
        false
      );
      assert.equal(
        resolveAccess(false, { ok: true, data: { planId: "FREE" } }, "ULTIMATE")
          .hasAccess,
        false
      );
    });
  });

  // -----------------------------------------------------------------------
  // Render Path Selection
  // -----------------------------------------------------------------------
  describe("resolveRenderPath", () => {
    it("loading wins regardless of other inputs", () => {
      assert.equal(resolveRenderPath(true, null, false, true), "loading");
      assert.equal(resolveRenderPath(true, null, true, true), "loading");
    });

    it("renders children when hasAccess (over fallback)", () => {
      assert.equal(resolveRenderPath(false, true, false, true), "children");
      assert.equal(resolveRenderPath(false, true, true, true), "children");
    });

    it("renders fallback when no access and fallback exists (over upgrade/null)", () => {
      assert.equal(resolveRenderPath(false, false, true, true), "fallback");
      assert.equal(resolveRenderPath(false, false, true, false), "fallback");
    });

    it("renders the upgrade prompt when no fallback and showUpgradePrompt", () => {
      assert.equal(resolveRenderPath(false, false, false, true), "upgrade");
    });

    it("renders null when no fallback and upgrade prompt suppressed", () => {
      assert.equal(resolveRenderPath(false, false, false, false), "null");
    });
  });
});
