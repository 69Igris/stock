/**
 * Gemini Pricing and Cost Calculation Tests
 *
 * Exercises the REAL pricing utilities exported from
 * packages/core/src/gemini/pricing.ts (via `@usemoney/core/gemini`). No inline
 * reimplementation — `GEMINI_PRICING`, `calculateCost`, `convertToINR`,
 * `getUsdToInrRate`, `getModelForQueryType`, `estimateQueryCost`,
 * `getModelPricing`, `getAllModelPricing`, `isFlashModel`, and `isProModel`
 * all run the source code asserted here.
 *
 * Divergence the old shadow hid: its inline `GEMINI_PRICING` had only 6 models
 * and asserted `Object.keys === 6`. The real table now has 12 — the 2.5 family,
 * the live Developer-API 3.x ids (gemini-3-flash-preview, gemini-3.5-flash,
 * gemini-3.1-pro-preview, MONEY-650), the bare gemini-3-flash / gemini-3-pro
 * back-compat aliases, and the 1.5 / 2.0 legacy fallbacks. Counts below match
 * the real table.
 *
 * Source: packages/core/src/gemini/pricing.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GEMINI_PRICING,
  calculateCost,
  convertToINR,
  getUsdToInrRate,
  getModelForQueryType,
  estimateQueryCost,
  getModelPricing,
  getAllModelPricing,
  isFlashModel,
  isProModel,
} from "@usemoney/core/gemini";

const TOTAL_MODELS = 12;

// ============== TESTS ==============

describe("Gemini Pricing Utilities (real @usemoney/core exports)", () => {
  // ---- GEMINI_PRICING constant ----

  describe("GEMINI_PRICING", () => {
    it("should have pricing for gemini-2.5-flash", () => {
      assert.ok(GEMINI_PRICING["gemini-2.5-flash"]);
      assert.equal(GEMINI_PRICING["gemini-2.5-flash"]!.inputCostPer1M, 0.075);
      assert.equal(GEMINI_PRICING["gemini-2.5-flash"]!.outputCostPer1M, 0.3);
    });

    it("should have pricing for gemini-2.5-pro", () => {
      assert.ok(GEMINI_PRICING["gemini-2.5-pro"]);
      assert.equal(GEMINI_PRICING["gemini-2.5-pro"]!.inputCostPer1M, 1.25);
      assert.equal(GEMINI_PRICING["gemini-2.5-pro"]!.outputCostPer1M, 5.0);
    });

    it("should have pricing for gemini-1.5-pro", () => {
      assert.ok(GEMINI_PRICING["gemini-1.5-pro"]);
      assert.equal(GEMINI_PRICING["gemini-1.5-pro"]!.inputCostPer1M, 1.25);
      assert.equal(GEMINI_PRICING["gemini-1.5-pro"]!.outputCostPer1M, 5.0);
    });

    it("should have pricing for gemini-1.5-flash", () => {
      assert.ok(GEMINI_PRICING["gemini-1.5-flash"]);
      assert.equal(GEMINI_PRICING["gemini-1.5-flash"]!.inputCostPer1M, 0.075);
      assert.equal(GEMINI_PRICING["gemini-1.5-flash"]!.outputCostPer1M, 0.3);
    });

    it("should have pricing for gemini-2.0-flash-exp", () => {
      assert.ok(GEMINI_PRICING["gemini-2.0-flash-exp"]);
    });

    it("should have pricing for gemini-2.0-pro-exp", () => {
      assert.ok(GEMINI_PRICING["gemini-2.0-pro-exp"]);
    });

    it("should have pricing for the MONEY-619 3.x models the shadow omitted", () => {
      assert.equal(
        GEMINI_PRICING["gemini-2.5-flash-lite"]!.inputCostPer1M,
        0.05
      );
      assert.equal(GEMINI_PRICING["gemini-3-flash"]!.inputCostPer1M, 0.5);
      assert.equal(GEMINI_PRICING["gemini-3.5-flash"]!.inputCostPer1M, 0.6);
      assert.equal(GEMINI_PRICING["gemini-3-pro"]!.inputCostPer1M, 2.0);
      assert.equal(GEMINI_PRICING["gemini-3-pro"]!.outputCostPer1M, 12.0);
    });

    it(`should have ${TOTAL_MODELS} models total`, () => {
      assert.equal(Object.keys(GEMINI_PRICING).length, TOTAL_MODELS);
    });
  });

  // ---- calculateCost ----

  describe("calculateCost", () => {
    it("should calculate cost for gemini-2.5-flash with 1M input and 1M output tokens", () => {
      const cost = calculateCost("gemini-2.5-flash", 1_000_000, 1_000_000);
      // 0.075 + 0.3 = 0.375
      assert.equal(cost, 0.375);
    });

    it("should calculate cost for gemini-2.5-pro with 1M input and 1M output tokens", () => {
      const cost = calculateCost("gemini-2.5-pro", 1_000_000, 1_000_000);
      // 1.25 + 5.0 = 6.25
      assert.equal(cost, 6.25);
    });

    it("should return 0 for 0 input and 0 output tokens", () => {
      assert.equal(calculateCost("gemini-2.5-flash", 0, 0), 0);
    });

    it("should return 0 for unknown model", () => {
      assert.equal(calculateCost("unknown-model", 1000, 1000), 0);
    });

    it("should calculate cost for only input tokens", () => {
      const cost = calculateCost("gemini-2.5-flash", 1_000_000, 0);
      assert.equal(cost, 0.075);
    });

    it("should calculate cost for only output tokens", () => {
      const cost = calculateCost("gemini-2.5-flash", 0, 1_000_000);
      assert.equal(cost, 0.3);
    });

    it("should calculate cost for small token counts", () => {
      const cost = calculateCost("gemini-2.5-flash", 1000, 500);
      // (1000/1M)*0.075 + (500/1M)*0.3 = 0.000075 + 0.00015 = 0.000225
      assert.ok(Math.abs(cost - 0.000225) < 1e-10);
    });

    it("should calculate cost for large token counts", () => {
      const cost = calculateCost("gemini-2.5-pro", 10_000_000, 5_000_000);
      // (10M/1M)*1.25 + (5M/1M)*5.0 = 12.5 + 25.0 = 37.5
      assert.equal(cost, 37.5);
    });

    it("should calculate cost correctly for gemini-1.5-flash", () => {
      const cost = calculateCost("gemini-1.5-flash", 1_000_000, 1_000_000);
      assert.equal(cost, 0.375);
    });

    it("should calculate cost correctly for gemini-2.0-flash-exp", () => {
      const cost = calculateCost("gemini-2.0-flash-exp", 1_000_000, 1_000_000);
      assert.equal(cost, 0.375);
    });

    it("should calculate cost correctly for gemini-2.0-pro-exp", () => {
      const cost = calculateCost("gemini-2.0-pro-exp", 1_000_000, 1_000_000);
      assert.equal(cost, 6.25);
    });

    it("should calculate cost correctly for gemini-3-pro", () => {
      const cost = calculateCost("gemini-3-pro", 1_000_000, 1_000_000);
      // 2.0 + 12.0 = 14.0
      assert.equal(cost, 14.0);
    });

    it("should handle fractional token counts", () => {
      const cost = calculateCost("gemini-2.5-flash", 500_000, 500_000);
      // (0.5)*0.075 + (0.5)*0.3 = 0.0375 + 0.15 = 0.1875
      assert.equal(cost, 0.1875);
    });
  });

  // ---- convertToINR ----

  describe("convertToINR", () => {
    it("should convert 0 USD to 0 INR", () => {
      assert.equal(convertToINR(0), 0);
    });

    it("should convert 1 USD to 83 INR", () => {
      assert.equal(convertToINR(1), 83);
    });

    it("should convert 10 USD to 830 INR", () => {
      assert.equal(convertToINR(10), 830);
    });

    it("should convert fractional USD", () => {
      const result = convertToINR(0.5);
      assert.equal(result, 41.5);
    });

    it("should convert very small amounts", () => {
      const result = convertToINR(0.000225);
      assert.ok(Math.abs(result - 0.018675) < 1e-10);
    });

    it("should convert large amounts", () => {
      assert.equal(convertToINR(100), 8300);
    });
  });

  // ---- getUsdToInrRate ----

  describe("getUsdToInrRate", () => {
    it("should return 83", () => {
      assert.equal(getUsdToInrRate(), 83);
    });

    it("should always return the same value", () => {
      assert.equal(getUsdToInrRate(), getUsdToInrRate());
    });
  });

  // ---- getModelForQueryType ----

  describe("getModelForQueryType", () => {
    it("should return gemini-2.5-flash for fast query type", () => {
      assert.equal(getModelForQueryType("fast"), "gemini-2.5-flash");
    });

    it("should return gemini-2.5-pro for advanced query type", () => {
      assert.equal(getModelForQueryType("advanced"), "gemini-2.5-pro");
    });
  });

  // ---- estimateQueryCost ----

  describe("estimateQueryCost", () => {
    it("should estimate cost for fast query", () => {
      const result = estimateQueryCost("fast", 1_000_000, 1_000_000);
      // gemini-2.5-flash: 0.075 + 0.3 = 0.375
      assert.equal(result.costUSD, 0.375);
      assert.equal(result.costINR, 0.375 * 83);
    });

    it("should estimate cost for advanced query", () => {
      const result = estimateQueryCost("advanced", 1_000_000, 1_000_000);
      // gemini-2.5-pro: 1.25 + 5.0 = 6.25
      assert.equal(result.costUSD, 6.25);
      assert.equal(result.costINR, 6.25 * 83);
    });

    it("should return 0 cost for 0 tokens", () => {
      const result = estimateQueryCost("fast", 0, 0);
      assert.equal(result.costUSD, 0);
      assert.equal(result.costINR, 0);
    });

    it("should return both costUSD and costINR properties", () => {
      const result = estimateQueryCost("fast", 1000, 1000);
      assert.ok("costUSD" in result);
      assert.ok("costINR" in result);
    });

    it("should have costINR equal to costUSD * 83", () => {
      const result = estimateQueryCost("advanced", 500_000, 250_000);
      assert.ok(Math.abs(result.costINR - result.costUSD * 83) < 1e-10);
    });
  });

  // ---- getModelPricing ----

  describe("getModelPricing", () => {
    it("should return pricing for gemini-2.5-flash", () => {
      const pricing = getModelPricing("gemini-2.5-flash");
      assert.ok(pricing);
      assert.equal(pricing.inputCostPer1M, 0.075);
      assert.equal(pricing.outputCostPer1M, 0.3);
    });

    it("should return pricing for gemini-2.5-pro", () => {
      const pricing = getModelPricing("gemini-2.5-pro");
      assert.ok(pricing);
      assert.equal(pricing.inputCostPer1M, 1.25);
      assert.equal(pricing.outputCostPer1M, 5.0);
    });

    it("should return undefined for unknown model", () => {
      assert.equal(getModelPricing("unknown-model"), undefined);
    });

    it("should return undefined for empty string model name", () => {
      assert.equal(getModelPricing(""), undefined);
    });

    it("should return pricing for legacy model gemini-2.0-flash-exp", () => {
      const pricing = getModelPricing("gemini-2.0-flash-exp");
      assert.ok(pricing);
      assert.equal(pricing.inputCostPer1M, 0.075);
    });

    it("should return pricing for legacy model gemini-2.0-pro-exp", () => {
      const pricing = getModelPricing("gemini-2.0-pro-exp");
      assert.ok(pricing);
      assert.equal(pricing.inputCostPer1M, 1.25);
    });
  });

  // ---- getAllModelPricing ----

  describe("getAllModelPricing", () => {
    it(`should return all ${TOTAL_MODELS} models`, () => {
      const all = getAllModelPricing();
      assert.equal(Object.keys(all).length, TOTAL_MODELS);
    });

    it("should return a copy (not the original object)", () => {
      const all = getAllModelPricing();
      all["new-model"] = { inputCostPer1M: 999, outputCostPer1M: 999 };
      // Original should be unchanged
      assert.equal(GEMINI_PRICING["new-model"], undefined);
    });

    it("should contain all expected model names", () => {
      const all = getAllModelPricing();
      const expectedModels = [
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-pro",
        // Live Developer-API 3.x ids (MONEY-650) ...
        "gemini-3-flash-preview",
        "gemini-3.5-flash",
        "gemini-3.1-pro-preview",
        // ... plus the bare ids retained as back-compat aliases
        "gemini-3-flash",
        "gemini-3-pro",
        "gemini-1.5-pro",
        "gemini-1.5-flash",
        "gemini-2.0-flash-exp",
        "gemini-2.0-pro-exp",
      ];
      for (const model of expectedModels) {
        assert.ok(all[model], `Missing model: ${model}`);
      }
    });

    it("should have valid pricing for all models (inputCost > 0)", () => {
      const all = getAllModelPricing();
      for (const [name, pricing] of Object.entries(all)) {
        assert.ok(
          pricing.inputCostPer1M > 0,
          `${name} input cost should be > 0`
        );
        assert.ok(
          pricing.outputCostPer1M > 0,
          `${name} output cost should be > 0`
        );
      }
    });
  });

  // ---- isFlashModel ----

  describe("isFlashModel", () => {
    it("should return true for gemini-2.5-flash", () => {
      assert.equal(isFlashModel("gemini-2.5-flash"), true);
    });

    it("should return true for gemini-1.5-flash", () => {
      assert.equal(isFlashModel("gemini-1.5-flash"), true);
    });

    it("should return true for gemini-2.0-flash-exp", () => {
      assert.equal(isFlashModel("gemini-2.0-flash-exp"), true);
    });

    it("should return false for gemini-2.5-pro", () => {
      assert.equal(isFlashModel("gemini-2.5-pro"), false);
    });

    it("should return false for unknown model without flash", () => {
      assert.equal(isFlashModel("some-other-model"), false);
    });

    it("should be case-insensitive", () => {
      assert.equal(isFlashModel("GEMINI-2.5-FLASH"), true);
    });

    it("should return false for empty string", () => {
      assert.equal(isFlashModel(""), false);
    });

    it("should return true if flash appears anywhere in the name", () => {
      assert.equal(isFlashModel("custom-flash-model"), true);
    });
  });

  // ---- isProModel ----

  describe("isProModel", () => {
    it("should return true for gemini-2.5-pro", () => {
      assert.equal(isProModel("gemini-2.5-pro"), true);
    });

    it("should return true for gemini-1.5-pro", () => {
      assert.equal(isProModel("gemini-1.5-pro"), true);
    });

    it("should return true for gemini-2.0-pro-exp", () => {
      assert.equal(isProModel("gemini-2.0-pro-exp"), true);
    });

    it("should return false for gemini-2.5-flash", () => {
      assert.equal(isProModel("gemini-2.5-flash"), false);
    });

    it("should return false for unknown model without pro", () => {
      assert.equal(isProModel("some-other-model"), false);
    });

    it("should be case-insensitive", () => {
      assert.equal(isProModel("GEMINI-2.5-PRO"), true);
    });

    it("should return false for empty string", () => {
      assert.equal(isProModel(""), false);
    });

    it("should return true if pro appears anywhere in the name", () => {
      assert.equal(isProModel("custom-pro-model"), true);
    });
  });
});
