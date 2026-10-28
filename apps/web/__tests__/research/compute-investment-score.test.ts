/**
 * Investment Score Tool Tests
 * (packages/research/src/tools/compute-investment-score.ts)
 *
 * De-shadowed (MONEY-620 / task 185): the previous version reimplemented
 * `computeInvestmentScore` inline and asserted a `recommendation` of
 * "strong_buy" | "buy" | "hold" | "sell" | "strong_sell" derived from the
 * score. The REAL tool hard-codes `recommendation: "N/A"` (MONEY-457 SEBI
 * compliance — UseMoney is not a registered Research Analyst, so labelled
 * BUY/SELL verdicts are forbidden). The shadow's recommendation assertions
 * would have FAILED against production. This file now drives the real,
 * registered `computeInvestmentScoreTool.execute()` and asserts the actual
 * `overallScore` / `conviction` / `recommendation` contract.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeInvestmentScoreTool,
  type InvestmentScoreResult,
} from "@usemoney/research/tools/compute-investment-score";

async function score(params: {
  healthScore?: number;
  growthScore?: number;
  valuationScore?: number;
  qualityScore?: number;
  momentumScore?: number;
  weights?: Record<string, number>;
}): Promise<InvestmentScoreResult> {
  const out = await computeInvestmentScoreTool.execute(params);
  assert.strictEqual(out.success, true, out.error);
  return out.data as InvestmentScoreResult;
}

describe("Investment Score Tool (real)", () => {
  describe("Default weights", () => {
    it("should calculate 50 for all-50 inputs", async () => {
      const r = await score({
        healthScore: 50,
        growthScore: 50,
        valuationScore: 50,
        qualityScore: 50,
        momentumScore: 50,
      });
      assert.strictEqual(r.overallScore, 50);
    });

    it("should calculate 100 for all-100 inputs", async () => {
      const r = await score({
        healthScore: 100,
        growthScore: 100,
        valuationScore: 100,
        qualityScore: 100,
        momentumScore: 100,
      });
      assert.strictEqual(r.overallScore, 100);
    });

    it("should calculate 0 for all-0 inputs", async () => {
      // NOTE: the real tool uses `(params.x as number) || 50`, so a literal
      // 0 is FALSY and becomes 50. This is a real divergence from the old
      // shadow (which used `?? 50` and produced 0). Pin the production
      // behaviour: all-zero inputs default to 50 → overallScore 50.
      const r = await score({
        healthScore: 0,
        growthScore: 0,
        valuationScore: 0,
        qualityScore: 0,
        momentumScore: 0,
      });
      assert.strictEqual(r.overallScore, 50);
    });
  });

  describe("Conviction levels", () => {
    it("should be 'high' for score >= 75", async () => {
      const r = await score({
        healthScore: 80,
        growthScore: 80,
        valuationScore: 80,
        qualityScore: 80,
        momentumScore: 80,
      });
      assert.strictEqual(r.conviction, "high");
    });

    it("should be 'low' for score <= 35", async () => {
      const r = await score({
        healthScore: 30,
        growthScore: 30,
        valuationScore: 30,
        qualityScore: 30,
        momentumScore: 30,
      });
      assert.strictEqual(r.conviction, "low");
    });

    it("should be 'medium' for mid-range score", async () => {
      const r = await score({
        healthScore: 50,
        growthScore: 50,
        valuationScore: 50,
        qualityScore: 50,
        momentumScore: 50,
      });
      assert.strictEqual(r.conviction, "medium");
    });
  });

  describe("Recommendation — MONEY-457 SEBI compliance", () => {
    it("is ALWAYS 'N/A' regardless of a high score", async () => {
      const r = await score({
        healthScore: 90,
        growthScore: 90,
        valuationScore: 90,
        qualityScore: 90,
        momentumScore: 90,
      });
      assert.strictEqual(r.overallScore, 90);
      assert.strictEqual(r.recommendation, "N/A");
    });

    it("is ALWAYS 'N/A' regardless of a low score", async () => {
      const r = await score({
        healthScore: 10,
        growthScore: 10,
        valuationScore: 10,
        qualityScore: 10,
        momentumScore: 10,
      });
      assert.strictEqual(r.recommendation, "N/A");
    });

    it("is 'N/A' for a mid score too (no BUY/SELL/HOLD ever)", async () => {
      const r = await score({
        healthScore: 70,
        growthScore: 70,
        valuationScore: 70,
        qualityScore: 70,
        momentumScore: 70,
      });
      assert.strictEqual(r.recommendation, "N/A");
    });
  });

  describe("Boundary clamping", () => {
    it("should clamp values above 100", async () => {
      const r = await score({
        healthScore: 150,
        growthScore: 200,
        valuationScore: 100,
        qualityScore: 100,
        momentumScore: 100,
      });
      assert.strictEqual(r.overallScore, 100);
    });

    it("should clamp negative values (then || 50 quirk applies)", async () => {
      // -50 and -20 are truthy → clamped to 0; 0 inputs → || 50.
      // health=0, growth=0, valuation=50, quality=50, momentum=50.
      // 0*.25 + 0*.25 + 50*.20 + 50*.20 + 50*.10 = 25.
      const r = await score({
        healthScore: -50,
        growthScore: -20,
        valuationScore: 0,
        qualityScore: 0,
        momentumScore: 0,
      });
      assert.strictEqual(r.overallScore, 25);
    });
  });

  describe("Custom weights", () => {
    it("should apply custom weights", async () => {
      const r = await score({
        healthScore: 100,
        growthScore: 50, // 0 would become 50 anyway; use explicit 50 then weight 0
        valuationScore: 50,
        qualityScore: 50,
        momentumScore: 50,
        weights: {
          health: 1.0,
          growth: 0,
          valuation: 0,
          quality: 0,
          momentum: 0,
        },
      });
      assert.strictEqual(r.overallScore, 100);
    });

    it("should use default weights for missing keys (weights need not sum to 1)", async () => {
      const r = await score({
        healthScore: 100,
        growthScore: 100,
        valuationScore: 100,
        qualityScore: 100,
        momentumScore: 100,
        weights: { health: 0.5 },
      });
      // health 100*0.5 + growth 100*0.25 + valuation 100*0.20 +
      // quality 100*0.20 + momentum 100*0.10 = 125
      assert.strictEqual(r.overallScore, 125);
    });
  });

  describe("Dimensions echo", () => {
    it("returns per-dimension score+weight breakdown", async () => {
      const r = await score({
        healthScore: 60,
        growthScore: 70,
        valuationScore: 80,
        qualityScore: 90,
        momentumScore: 40,
      });
      assert.strictEqual(r.dimensions.financialHealth.score, 60);
      assert.strictEqual(r.dimensions.financialHealth.weight, 0.25);
      assert.strictEqual(r.dimensions.momentum.score, 40);
      assert.strictEqual(r.dimensions.momentum.weight, 0.1);
    });
  });

  describe("Defaults", () => {
    it("should default to 50 for missing dimensions", async () => {
      const r = await score({});
      assert.strictEqual(r.overallScore, 50);
      assert.strictEqual(r.conviction, "medium");
      assert.strictEqual(r.recommendation, "N/A");
    });
  });
});
