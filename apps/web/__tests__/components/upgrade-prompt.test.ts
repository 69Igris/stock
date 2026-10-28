/**
 * UpgradePrompt Tests
 *
 * De-shadowed (MONEY-620): imports the REAL PLAN_DISPLAY_NAMES, PLAN_FEATURES,
 * and resolveUpgradeCopy from components/upgrade-prompt-logic.ts, which
 * UpgradePrompt.tsx renders from.
 *
 * The old shadow asserted constants that DO NOT exist in the current component
 * (PLAN_HIGHLIGHTS, a PLAN_PRICE `{amount, period}` map, a "View Plans"/"Unlock
 * Premium Features" CTA/heading, a /pricing href) — it was a green copy of an
 * old version. MONEY-484 replaced that surface with PLAN_FEATURES + an inline
 * ₹249/₹1,499 price and no CTA-label logic. These assertions now pin the REAL
 * copy + price derivation and would fail if the component regressed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_DISPLAY_NAMES,
  PLAN_FEATURES,
  resolveUpgradeCopy,
} from "../../components/upgrade-prompt-logic";

describe("UpgradePrompt", () => {
  // -----------------------------------------------------------------------
  // PLAN_DISPLAY_NAMES
  // -----------------------------------------------------------------------
  describe("PLAN_DISPLAY_NAMES", () => {
    it("maps PRO/PREMIUM/ULTIMATE to friendly names", () => {
      assert.equal(PLAN_DISPLAY_NAMES["PRO"], "Pro");
      assert.equal(PLAN_DISPLAY_NAMES["PREMIUM"], "Premium");
      assert.equal(PLAN_DISPLAY_NAMES["ULTIMATE"], "Ultimate");
    });

    it("does not contain FREE", () => {
      assert.equal(PLAN_DISPLAY_NAMES["FREE"], undefined);
    });
  });

  // -----------------------------------------------------------------------
  // PLAN_FEATURES (the real checklist)
  // -----------------------------------------------------------------------
  describe("PLAN_FEATURES", () => {
    it("PRO has 6 checklist items, first is the unlocked feature", () => {
      assert.equal(PLAN_FEATURES["PRO"]!.length, 6);
      assert.equal(PLAN_FEATURES["PRO"]![0], "This feature (now unlocked)");
    });

    it("PRO checklist includes the StockSage analysis + parallel runs lines", () => {
      assert.ok(
        PLAN_FEATURES["PRO"]!.includes("Portfolio analysis with StockSage")
      );
      assert.ok(PLAN_FEATURES["PRO"]!.includes("5 parallel L2 research runs"));
    });

    it("PREMIUM has 6 checklist items incl. Document Vault + Tax tools", () => {
      assert.equal(PLAN_FEATURES["PREMIUM"]!.length, 6);
      assert.ok(
        PLAN_FEATURES["PREMIUM"]!.includes("Document Vault + Tax tools")
      );
    });

    it("both tiers end with Priority support", () => {
      assert.equal(PLAN_FEATURES["PRO"]!.at(-1), "Priority support");
      assert.equal(PLAN_FEATURES["PREMIUM"]!.at(-1), "Priority support");
    });

    it("ULTIMATE / FREE have no checklist (undefined)", () => {
      assert.equal(PLAN_FEATURES["ULTIMATE"], undefined);
      assert.equal(PLAN_FEATURES["FREE"], undefined);
    });
  });

  // -----------------------------------------------------------------------
  // resolveUpgradeCopy
  // -----------------------------------------------------------------------
  describe("resolveUpgradeCopy", () => {
    it("PRO → Pro name, ₹249/₹499, PRO checklist", () => {
      const c = resolveUpgradeCopy("PRO");
      assert.equal(c.displayPlan, "Pro");
      assert.equal(c.price, "₹249");
      assert.equal(c.origPrice, "₹499");
      assert.deepEqual(c.checklist, PLAN_FEATURES.PRO);
    });

    it("PREMIUM → Premium name, ₹1,499/₹2,999, PREMIUM checklist", () => {
      const c = resolveUpgradeCopy("PREMIUM");
      assert.equal(c.displayPlan, "Premium");
      assert.equal(c.price, "₹1,499");
      assert.equal(c.origPrice, "₹2,999");
      assert.deepEqual(c.checklist, PLAN_FEATURES.PREMIUM);
    });

    it("unknown plan falls back to the raw id + Premium-tier price + PRO checklist", () => {
      const c = resolveUpgradeCopy("GALAXY");
      assert.equal(c.displayPlan, "GALAXY");
      // Only PRO is special-cased on price; everything else gets the higher price.
      assert.equal(c.price, "₹1,499");
      assert.equal(c.origPrice, "₹2,999");
      assert.deepEqual(c.checklist, PLAN_FEATURES.PRO);
    });

    it("ULTIMATE keeps its friendly name but falls back to the PRO checklist", () => {
      const c = resolveUpgradeCopy("ULTIMATE");
      assert.equal(c.displayPlan, "Ultimate");
      assert.deepEqual(c.checklist, PLAN_FEATURES.PRO);
    });

    it("never returns an empty checklist (always at least the PRO fallback)", () => {
      for (const plan of ["PRO", "PREMIUM", "ULTIMATE", "FREE", "WHATEVER"]) {
        assert.ok(resolveUpgradeCopy(plan).checklist.length > 0);
      }
    });
  });
});
