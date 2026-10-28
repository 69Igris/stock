/**
 * Cost Tracker Edge Case Tests
 *
 * Edge cases for token cost calculation and usage tracking.
 * Covers areas NOT tested in the main cost-tracker.test.ts:
 * - exceedsCostThreshold: exactly at threshold (uses > not >=)
 * - trackTokenUsage: zero tokens, undefined queryType behavior
 * - getUserTokenUsage: no records returns zeros
 * - getDailyUsage: UTC vs local timezone boundary
 * - getAverageCostPerQuery: zero queries returns 0
 * - getUsageByModel: unknown model cost accumulation
 * - USD_TO_INR hardcoded at 83 (document gap)
 * - Cost precision with very large token counts (floating-point)
 * - Model name resolution from queryType
 *
 * Pure logic is reimplemented inline to avoid side-effecting imports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL helpers. The aggregation / threshold
// / model-resolution logic now lives in cost-tracker-logic.ts and is CALLED by
// cost-tracker.ts (getUserTokenUsage / getDailyUsage / getUsageByModel /
// trackTokenUsage / exceedsCostThreshold), so these tests and production run the
// same code. calculateCost / convertToINR come from cost-tracker.ts directly.
import { calculateCost, convertToINR } from "@/lib/gemini/cost-tracker";
import {
  resolveModelName,
  exceedsThreshold as exceedsCostThreshold,
  aggregateUsage,
  groupDailyUsage as groupByDate,
  breakdownByModel,
} from "@/lib/gemini/cost-tracker-logic";

// getAverageCostPerQuery delegates averaging to Prisma's `_avg` (no pure seam);
// the only deterministic contract is the empty→0 fallback + INR conversion.
// This thin helper documents that fallback for the edge tests below.
function getAverageCost(estimatedCosts: number[]): {
  avgCostUSD: number;
  avgCostINR: number;
} {
  const avgCostUSD =
    estimatedCosts.length === 0
      ? 0 // _avg returns null → fallback to 0
      : estimatedCosts.reduce((a, b) => a + b, 0) / estimatedCosts.length;
  return { avgCostUSD, avgCostINR: convertToINR(avgCostUSD) };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("Cost Tracker Edge Cases", () => {
  // ── exceedsCostThreshold: exactly at $2.00 → returns false ────────

  describe("exceedsCostThreshold boundary", () => {
    it("should return false when cost is exactly at threshold (uses > not >=)", () => {
      assert.strictEqual(exceedsCostThreshold(2.0, 2.0), false);
    });

    it("should return true when cost is just above threshold", () => {
      assert.strictEqual(exceedsCostThreshold(2.000001, 2.0), true);
    });

    it("should return false when cost is just below threshold", () => {
      assert.strictEqual(exceedsCostThreshold(1.999999, 2.0), false);
    });

    it("should return false when cost is 0 and threshold is 0", () => {
      assert.strictEqual(exceedsCostThreshold(0, 0), false);
    });

    it("should return true for any positive cost when threshold is 0", () => {
      assert.strictEqual(exceedsCostThreshold(0.001, 0), true);
    });
  });

  // ── trackTokenUsage: zero tokens → record created ────────────────

  describe("trackTokenUsage with zero tokens", () => {
    it("should calculate $0 cost for zero input and output tokens", () => {
      const modelName = resolveModelName("fast");
      const cost = calculateCost(modelName, 0, 0);
      assert.strictEqual(cost, 0);
    });

    it("should resolve model name for 'fast' queryType to gemini-2.5-flash", () => {
      assert.strictEqual(resolveModelName("fast"), "gemini-2.5-flash");
    });

    it("should resolve model name for 'advanced' queryType to gemini-2.5-pro", () => {
      assert.strictEqual(resolveModelName("advanced"), "gemini-2.5-pro");
    });
  });

  // ── trackTokenUsage: undefined queryType → defaults to pro ───────

  describe("trackTokenUsage with undefined/unexpected queryType", () => {
    it("should default to gemini-2.5-pro when queryType is undefined", () => {
      // In the source: queryType === "fast" ? flash : pro
      // undefined !== "fast", so defaults to pro
      const modelName = resolveModelName(undefined);
      assert.strictEqual(modelName, "gemini-2.5-pro");
    });

    it("should default to gemini-2.5-pro when queryType is empty string", () => {
      const modelName = resolveModelName("");
      assert.strictEqual(modelName, "gemini-2.5-pro");
    });

    it("should default to gemini-2.5-pro for any non-fast queryType", () => {
      assert.strictEqual(resolveModelName("slow"), "gemini-2.5-pro");
      assert.strictEqual(resolveModelName("premium"), "gemini-2.5-pro");
      assert.strictEqual(resolveModelName("FAST"), "gemini-2.5-pro"); // case-sensitive
    });

    it("should result in higher cost when queryType is accidentally non-fast", () => {
      // If someone passes "Fast" instead of "fast", they get pro pricing
      const flashCost = calculateCost("gemini-2.5-flash", 1000, 500);
      const proCost = calculateCost(resolveModelName("Fast"), 1000, 500);
      assert.ok(proCost > flashCost);
    });
  });

  // ── getUserTokenUsage: no records → returns all zeros ─────────────

  describe("getUserTokenUsage with no records", () => {
    it("should return all zeros when aggregating empty array", () => {
      const stats = aggregateUsage([]);
      assert.strictEqual(stats.totalInputTokens, 0);
      assert.strictEqual(stats.totalOutputTokens, 0);
      assert.strictEqual(stats.totalCostUSD, 0);
      assert.strictEqual(stats.totalCostINR, 0);
      assert.strictEqual(stats.queryCount, 0);
    });

    it("should compute INR as 0 when USD cost is 0", () => {
      const stats = aggregateUsage([]);
      assert.strictEqual(stats.totalCostINR, 0);
    });
  });

  // ── getDailyUsage: UTC vs local timezone boundary ─────────────────

  describe("getDailyUsage timezone boundary", () => {
    it("should group by UTC date via toISOString (not local time)", () => {
      // 2026-03-13T23:59:59Z and 2026-03-14T00:00:01Z should be on different dates
      const records = [
        {
          createdAt: new Date("2026-03-13T23:59:59.000Z"),
          inputTokens: 100,
          outputTokens: 50,
          estimatedCost: 0.001,
        },
        {
          createdAt: new Date("2026-03-14T00:00:01.000Z"),
          inputTokens: 200,
          outputTokens: 100,
          estimatedCost: 0.002,
        },
      ];

      const daily = groupByDate(records);
      assert.strictEqual(daily.length, 2);
      assert.strictEqual(daily[0]!.date, "2026-03-13");
      assert.strictEqual(daily[1]!.date, "2026-03-14");
    });

    it("should combine multiple queries on the same UTC date", () => {
      const records = [
        {
          createdAt: new Date("2026-03-14T05:30:00.000Z"),
          inputTokens: 100,
          outputTokens: 50,
          estimatedCost: 0.001,
        },
        {
          createdAt: new Date("2026-03-14T18:30:00.000Z"),
          inputTokens: 200,
          outputTokens: 100,
          estimatedCost: 0.002,
        },
      ];

      const daily = groupByDate(records);
      assert.strictEqual(daily.length, 1);
      assert.strictEqual(daily[0]!.queries, 2);
      assert.strictEqual(daily[0]!.tokens, 450); // 100+50+200+100
    });

    it("should return empty array for no records", () => {
      const daily = groupByDate([]);
      assert.strictEqual(daily.length, 0);
    });
  });

  // ── getAverageCostPerQuery: zero queries → returns 0 ──────────────

  describe("getAverageCostPerQuery edge cases", () => {
    it("should return 0 avgCostUSD when no queries exist", () => {
      const result = getAverageCost([]);
      assert.strictEqual(result.avgCostUSD, 0);
      assert.strictEqual(result.avgCostINR, 0);
    });

    it("should calculate correct average for single query", () => {
      const result = getAverageCost([0.005]);
      assert.strictEqual(result.avgCostUSD, 0.005);
      assert.ok(Math.abs(result.avgCostINR - 0.005 * 83) < 1e-10);
    });

    it("should calculate correct average for multiple queries", () => {
      const result = getAverageCost([0.001, 0.003, 0.002]);
      assert.ok(Math.abs(result.avgCostUSD - 0.002) < 1e-10);
    });
  });

  // ── getUsageByModel: unknown model → cost still accumulated ───────

  describe("getUsageByModel with unknown model names", () => {
    it("should accumulate cost for unknown model name in breakdown", () => {
      const records = [
        {
          modelName: "gemini-3.0-ultra",
          inputTokens: 1000,
          outputTokens: 500,
          estimatedCost: 0.05, // manually set cost
        },
      ];

      const breakdown = breakdownByModel(records);
      assert.strictEqual(breakdown.length, 1);
      assert.strictEqual(breakdown[0]!.modelName, "gemini-3.0-ultra");
      assert.strictEqual(breakdown[0]!.totalCost, 0.05);
      assert.strictEqual(breakdown[0]!.queryCount, 1);
    });

    it("should keep unknown and known models separate", () => {
      const records = [
        {
          modelName: "gemini-2.5-flash",
          inputTokens: 100,
          outputTokens: 50,
          estimatedCost: 0.001,
        },
        {
          modelName: "gemini-unknown",
          inputTokens: 200,
          outputTokens: 100,
          estimatedCost: 0,
        },
      ];

      const breakdown = breakdownByModel(records);
      assert.strictEqual(breakdown.length, 2);
    });

    it("should calculateCost return 0 for unknown model but still record it", () => {
      const cost = calculateCost("gemini-4.0-experimental", 1000, 500);
      assert.strictEqual(cost, 0);
      // The record would still be created in DB with estimatedCost=0
    });
  });

  // ── USD_TO_INR hardcoded at 83 ────────────────────────────────────

  describe("USD_TO_INR hardcoded constant", () => {
    it("should use exactly 83 as the conversion rate (via convertToINR)", () => {
      // The rate is a private const in the source; assert it through the
      // exported convertToINR so we exercise the real value, not a copy.
      assert.strictEqual(convertToINR(1), 83);
    });

    it("should convert $1 to exactly 83 INR", () => {
      assert.strictEqual(convertToINR(1), 83);
    });

    it("should propagate through aggregateUsage correctly", () => {
      const stats = aggregateUsage([
        { inputTokens: 1000, outputTokens: 500, estimatedCost: 1.0 },
      ]);
      assert.strictEqual(stats.totalCostINR, 83);
    });
  });

  // ── Cost precision with very large token counts ───────────────────

  describe("Floating-point precision with large token counts", () => {
    it("should handle 100M tokens without overflow", () => {
      const cost = calculateCost("gemini-2.5-pro", 100_000_000, 50_000_000);
      // (100/1) * 1.25 + (50/1) * 5.0 = 125 + 250 = 375
      assert.strictEqual(cost, 375);
    });

    it("should handle 1B input tokens", () => {
      const cost = calculateCost("gemini-2.5-flash", 1_000_000_000, 0);
      // (1000) * 0.075 = 75
      assert.strictEqual(cost, 75);
    });

    it("should maintain precision for small token counts amid large ones", () => {
      const smallCost = calculateCost("gemini-2.5-flash", 1, 1);
      // (1/1M) * 0.075 + (1/1M) * 0.3 = 7.5e-8 + 3e-7 = 3.75e-7
      const expected = 0.075 / 1_000_000 + 0.3 / 1_000_000;
      assert.ok(Math.abs(smallCost - expected) < 1e-15);
    });

    it("should accumulate many tiny costs without losing precision", () => {
      // Simulate 10000 queries of 100 tokens each
      const records = Array.from({ length: 10000 }, () => ({
        inputTokens: 100,
        outputTokens: 50,
        estimatedCost: calculateCost("gemini-2.5-flash", 100, 50),
      }));

      const stats = aggregateUsage(records);
      // Single query: (100/1M)*0.075 + (50/1M)*0.3 = 0.0000075 + 0.000015 = 0.0000225
      // 10000 queries: 0.225
      assert.ok(Math.abs(stats.totalCostUSD - 0.225) < 1e-8);
      assert.strictEqual(stats.queryCount, 10000);
    });

    it("should handle negative token counts gracefully (produces negative cost)", () => {
      // While semantically invalid, the math should still work
      const cost = calculateCost("gemini-2.5-flash", -1000, 500);
      assert.ok(cost < calculateCost("gemini-2.5-flash", 0, 500));
    });
  });
});
