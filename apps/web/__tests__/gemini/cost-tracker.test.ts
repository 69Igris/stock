/**
 * Gemini Cost Tracker Tests
 *
 * Tests for token cost calculation, USD to INR conversion,
 * and token count estimation utilities.
 *
 * The pure functions are extracted inline because the source modules
 * (cost-tracker.ts, models.ts) have side-effecting imports
 * (@/lib/prisma, @google/genai) that aren't available in
 * the unit test environment. The logic tested here mirrors exactly
 * the implementations in:
 *   - apps/web/lib/gemini/cost-tracker.ts (calculateCost, convertToINR, GEMINI_PRICING)
 *   - apps/web/lib/gemini/models.ts (estimateTokenCount)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL exports. cost-tracker.ts imports
// cleanly here (Prisma is lazy); estimateTokenCount lives in models.ts.
import {
  GEMINI_PRICING,
  calculateCost,
  convertToINR,
} from "@/lib/gemini/cost-tracker";
import { estimateTokenCount } from "@/lib/gemini/models";

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Gemini Cost Tracker", () => {
  // ───────────────────── GEMINI_PRICING table ─────────────────────

  describe("GEMINI_PRICING", () => {
    it("should have pricing for gemini-2.5-flash", () => {
      const pricing = GEMINI_PRICING["gemini-2.5-flash"];
      assert.ok(pricing);
      assert.strictEqual(pricing.inputCostPer1M, 0.075);
      assert.strictEqual(pricing.outputCostPer1M, 0.3);
    });

    it("should have pricing for gemini-2.5-pro", () => {
      const pricing = GEMINI_PRICING["gemini-2.5-pro"];
      assert.ok(pricing);
      assert.strictEqual(pricing.inputCostPer1M, 1.25);
      assert.strictEqual(pricing.outputCostPer1M, 5.0);
    });

    it("should have pricing for gemini-1.5-pro", () => {
      const pricing = GEMINI_PRICING["gemini-1.5-pro"];
      assert.ok(pricing);
      assert.strictEqual(pricing.inputCostPer1M, 1.25);
      assert.strictEqual(pricing.outputCostPer1M, 5.0);
    });

    it("should have pricing for gemini-1.5-flash", () => {
      const pricing = GEMINI_PRICING["gemini-1.5-flash"];
      assert.ok(pricing);
      assert.strictEqual(pricing.inputCostPer1M, 0.075);
      assert.strictEqual(pricing.outputCostPer1M, 0.3);
    });

    it("should have pricing for legacy gemini-2.0-flash-exp", () => {
      const pricing = GEMINI_PRICING["gemini-2.0-flash-exp"];
      assert.ok(pricing);
      assert.strictEqual(pricing.inputCostPer1M, 0.075);
      assert.strictEqual(pricing.outputCostPer1M, 0.3);
    });

    it("should have pricing for legacy gemini-2.0-pro-exp", () => {
      const pricing = GEMINI_PRICING["gemini-2.0-pro-exp"];
      assert.ok(pricing);
      assert.strictEqual(pricing.inputCostPer1M, 1.25);
      assert.strictEqual(pricing.outputCostPer1M, 5.0);
    });

    it("should have all expected models (6 total)", () => {
      const models = Object.keys(GEMINI_PRICING);
      assert.strictEqual(models.length, 6);
    });
  });

  // ───────────────────── calculateCost ─────────────────────

  describe("calculateCost", () => {
    describe("gemini-2.5-flash pricing ($0.075/1M input, $0.30/1M output)", () => {
      it("should calculate cost for 1M input tokens and 0 output tokens", () => {
        const cost = calculateCost("gemini-2.5-flash", 1_000_000, 0);
        assert.strictEqual(cost, 0.075);
      });

      it("should calculate cost for 0 input tokens and 1M output tokens", () => {
        const cost = calculateCost("gemini-2.5-flash", 0, 1_000_000);
        assert.strictEqual(cost, 0.3);
      });

      it("should calculate combined input and output cost", () => {
        const cost = calculateCost("gemini-2.5-flash", 1_000_000, 1_000_000);
        // $0.075 + $0.30 = $0.375
        assert.strictEqual(cost, 0.375);
      });

      it("should calculate cost for typical query (500 input, 200 output)", () => {
        const cost = calculateCost("gemini-2.5-flash", 500, 200);
        const expected = (500 / 1_000_000) * 0.075 + (200 / 1_000_000) * 0.3;
        assert.ok(Math.abs(cost - expected) < 1e-10);
      });

      it("should calculate cost for large token counts", () => {
        const cost = calculateCost("gemini-2.5-flash", 10_000_000, 5_000_000);
        // (10M/1M) * 0.075 + (5M/1M) * 0.3 = 0.75 + 1.5 = 2.25
        assert.strictEqual(cost, 2.25);
      });
    });

    describe("gemini-2.5-pro pricing ($1.25/1M input, $5.00/1M output)", () => {
      it("should calculate cost for 1M input tokens and 0 output tokens", () => {
        const cost = calculateCost("gemini-2.5-pro", 1_000_000, 0);
        assert.strictEqual(cost, 1.25);
      });

      it("should calculate cost for 0 input tokens and 1M output tokens", () => {
        const cost = calculateCost("gemini-2.5-pro", 0, 1_000_000);
        assert.strictEqual(cost, 5.0);
      });

      it("should calculate combined input and output cost", () => {
        const cost = calculateCost("gemini-2.5-pro", 1_000_000, 1_000_000);
        // $1.25 + $5.00 = $6.25
        assert.strictEqual(cost, 6.25);
      });

      it("should be more expensive than flash for same token count", () => {
        const flashCost = calculateCost("gemini-2.5-flash", 1000, 500);
        const proCost = calculateCost("gemini-2.5-pro", 1000, 500);

        assert.ok(proCost > flashCost);
      });

      it("should calculate cost for typical advanced query (2000 input, 1000 output)", () => {
        const cost = calculateCost("gemini-2.5-pro", 2000, 1000);
        const expected = (2000 / 1_000_000) * 1.25 + (1000 / 1_000_000) * 5.0;
        assert.ok(Math.abs(cost - expected) < 1e-10);
      });
    });

    describe("Edge cases", () => {
      it("should return 0 for zero input and zero output tokens", () => {
        const cost = calculateCost("gemini-2.5-flash", 0, 0);
        assert.strictEqual(cost, 0);
      });

      it("should return 0 for unknown model (fallback)", () => {
        const cost = calculateCost("gemini-unknown-model", 1000, 500);
        assert.strictEqual(cost, 0);
      });

      it("should return 0 for empty model name", () => {
        const cost = calculateCost("", 1000, 500);
        assert.strictEqual(cost, 0);
      });

      it("should handle very small token counts (1 token)", () => {
        const cost = calculateCost("gemini-2.5-flash", 1, 1);
        const expected = (1 / 1_000_000) * 0.075 + (1 / 1_000_000) * 0.3;
        assert.ok(Math.abs(cost - expected) < 1e-15);
        assert.ok(cost > 0);
      });

      it("should handle very large token counts (100M)", () => {
        const cost = calculateCost("gemini-2.5-pro", 100_000_000, 50_000_000);
        // (100M/1M) * 1.25 + (50M/1M) * 5.0 = 125 + 250 = 375
        assert.strictEqual(cost, 375);
      });

      it("should calculate same cost for legacy models as modern equivalents", () => {
        const flashCost = calculateCost("gemini-2.5-flash", 1000, 500);
        const legacyFlashCost = calculateCost(
          "gemini-2.0-flash-exp",
          1000,
          500
        );
        assert.strictEqual(flashCost, legacyFlashCost);

        const proCost = calculateCost("gemini-2.5-pro", 1000, 500);
        const legacyProCost = calculateCost("gemini-2.0-pro-exp", 1000, 500);
        assert.strictEqual(proCost, legacyProCost);
      });

      it("should calculate same cost for 1.5 and 2.5 models with same pricing", () => {
        const flash25 = calculateCost("gemini-2.5-flash", 1000, 500);
        const flash15 = calculateCost("gemini-1.5-flash", 1000, 500);
        assert.strictEqual(flash25, flash15);

        const pro25 = calculateCost("gemini-2.5-pro", 1000, 500);
        const pro15 = calculateCost("gemini-1.5-pro", 1000, 500);
        assert.strictEqual(pro25, pro15);
      });
    });
  });

  // ───────────────────── convertToINR ─────────────────────

  describe("convertToINR (USD x 83)", () => {
    it("should convert $1 to INR 83", () => {
      const inr = convertToINR(1);
      assert.strictEqual(inr, 83);
    });

    it("should convert $0 to INR 0", () => {
      const inr = convertToINR(0);
      assert.strictEqual(inr, 0);
    });

    it("should convert small USD amounts correctly", () => {
      const inr = convertToINR(0.001);
      assert.strictEqual(inr, 0.083);
    });

    it("should convert $100 to INR 8300", () => {
      const inr = convertToINR(100);
      assert.strictEqual(inr, 8300);
    });

    it("should handle fractional USD values", () => {
      const inr = convertToINR(0.075);
      // 0.075 * 83 = 6.225
      assert.ok(Math.abs(inr - 6.225) < 1e-10);
    });

    it("should handle typical query cost conversion", () => {
      const costUSD = calculateCost("gemini-2.5-flash", 500, 200);
      const costINR = convertToINR(costUSD);

      assert.ok(costINR > 0);
      assert.strictEqual(costINR, costUSD * 83);
    });

    it("should handle negative values (refund scenario)", () => {
      const inr = convertToINR(-1);
      assert.strictEqual(inr, -83);
    });

    it("should handle very small values without losing precision", () => {
      const inr = convertToINR(0.0000001);
      assert.ok(inr > 0);
      assert.ok(Math.abs(inr - 0.0000083) < 1e-10);
    });

    it("should convert a flash query cost to INR", () => {
      // 1000 input + 500 output tokens on flash
      const costUSD = calculateCost("gemini-2.5-flash", 1000, 500);
      const costINR = convertToINR(costUSD);

      // USD cost: (1000/1M)*0.075 + (500/1M)*0.3 = 0.000075 + 0.00015 = 0.000225
      // INR cost: 0.000225 * 83 = 0.018675
      assert.ok(Math.abs(costINR - 0.018675) < 1e-10);
    });
  });

  // ───────────────────── estimateTokenCount (1 token ~ 4 chars) ──────────────

  describe("estimateTokenCount (1 token ~ 4 characters)", () => {
    it("should estimate 1 token per 4 characters", () => {
      const result = estimateTokenCount("abcd");
      assert.strictEqual(result, 1);
    });

    it("should estimate 2 tokens for 8 characters", () => {
      const result = estimateTokenCount("abcdefgh");
      assert.strictEqual(result, 2);
    });

    it("should round up for non-divisible lengths", () => {
      const result = estimateTokenCount("abcde"); // 5 chars -> ceil(5/4) = 2
      assert.strictEqual(result, 2);
    });

    it("should round up single character", () => {
      const result = estimateTokenCount("a"); // 1 char -> ceil(1/4) = 1
      assert.strictEqual(result, 1);
    });

    it("should return 0 for empty string", () => {
      const result = estimateTokenCount("");
      assert.strictEqual(result, 0);
    });

    it("should handle very long text", () => {
      const longText = "A".repeat(10000);
      const result = estimateTokenCount(longText);
      assert.strictEqual(result, 2500); // 10000 / 4
    });

    it("should handle text with spaces", () => {
      const text = "Hello world test here"; // 21 chars including spaces
      const result = estimateTokenCount(text);
      assert.strictEqual(result, 6); // ceil(21/4) = 6
    });

    it("should handle text with special characters", () => {
      const text = "P/E: 25.5x"; // 10 chars
      const result = estimateTokenCount(text);
      assert.strictEqual(result, 3); // ceil(10/4) = 3
    });

    it("should handle unicode characters by string length", () => {
      const text = "Hello World"; // .length gives JS string length
      const result = estimateTokenCount(text);
      assert.strictEqual(result, Math.ceil(text.length / 4));
    });

    it("should estimate correctly for a typical prompt", () => {
      const prompt =
        "What are the best mutual funds to invest in India for a 25-year old with moderate risk appetite?";
      const result = estimateTokenCount(prompt);
      assert.strictEqual(result, Math.ceil(prompt.length / 4));
    });

    it("should estimate correctly for a typical response", () => {
      const response =
        "Based on your age and risk profile, here are some recommendations:\n" +
        "1. Large-cap funds like SBI Bluechip Fund\n" +
        "2. Index funds like UTI Nifty Index Fund\n" +
        "3. Flexi-cap funds like Parag Parikh Flexi Cap Fund";
      const result = estimateTokenCount(response);
      assert.strictEqual(result, Math.ceil(response.length / 4));
    });

    it("should handle 3 characters (boundary case)", () => {
      const result = estimateTokenCount("abc"); // ceil(3/4) = 1
      assert.strictEqual(result, 1);
    });

    it("should handle exactly 4 characters", () => {
      const result = estimateTokenCount("abcd"); // ceil(4/4) = 1
      assert.strictEqual(result, 1);
    });

    it("should handle 5 characters", () => {
      const result = estimateTokenCount("abcde"); // ceil(5/4) = 2
      assert.strictEqual(result, 2);
    });
  });

  // ───────────────────── Cost calculation integration ─────────────────────

  describe("Cost Calculation Integration", () => {
    it("should calculate end-to-end cost for a typical flash query in INR", () => {
      const costUSD = calculateCost("gemini-2.5-flash", 500, 200);
      const costINR = convertToINR(costUSD);

      assert.ok(costUSD > 0);
      assert.ok(costINR > 0);
      assert.ok(costINR > costUSD); // INR should be larger than USD
    });

    it("should calculate end-to-end cost for a typical pro query in INR", () => {
      const costUSD = calculateCost("gemini-2.5-pro", 2000, 1000);
      const costINR = convertToINR(costUSD);

      assert.ok(costUSD > 0);
      assert.ok(costINR > 0);
    });

    it("should show pro is approximately 16.67x more expensive than flash", () => {
      const tokens = 1_000_000;
      const flashCost = calculateCost("gemini-2.5-flash", tokens, tokens);
      const proCost = calculateCost("gemini-2.5-pro", tokens, tokens);

      // Flash: 0.075 + 0.3 = 0.375
      // Pro: 1.25 + 5.0 = 6.25
      // Ratio: 6.25 / 0.375 = 16.667
      const ratio = proCost / flashCost;
      assert.ok(Math.abs(ratio - 16.667) < 0.01);
    });

    it("should estimate tokens from text and calculate cost", () => {
      const inputText =
        "What stocks should I buy in India for long term wealth?";
      const outputText =
        "Here are some recommendations for long-term wealth building in the Indian stock market...";

      const inputTokens = estimateTokenCount(inputText);
      const outputTokens = estimateTokenCount(outputText);
      const cost = calculateCost("gemini-2.5-flash", inputTokens, outputTokens);

      assert.ok(inputTokens > 0);
      assert.ok(outputTokens > 0);
      assert.ok(cost > 0);
      assert.ok(cost < 0.01); // Should be very small for short texts
    });

    it("should calculate total daily cost for 1000 flash queries", () => {
      // Assume average: 500 input, 300 output tokens per query
      const queryCost = calculateCost("gemini-2.5-flash", 500, 300);
      const dailyCostUSD = queryCost * 1000;
      const dailyCostINR = convertToINR(dailyCostUSD);

      // queryCost = (500/1M)*0.075 + (300/1M)*0.3 = 0.0000375 + 0.00009 = 0.0001275
      // dailyCostUSD = 0.0001275 * 1000 = 0.1275
      assert.ok(Math.abs(dailyCostUSD - 0.1275) < 1e-10);
      assert.ok(Math.abs(dailyCostINR - 10.5825) < 1e-6);
    });
  });
});
