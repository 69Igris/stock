/**
 * Roast Utils Tests
 *
 * Tests for `buildRoastContext` from apps/web/components/roast/utils.ts.
 *
 * MONEY-620 de-shadow: this file previously re-declared `buildRoastContext`
 * (and the StructuredRoastResult type) inline and asserted the copy. That
 * shadow had DRIFTED from the real source — it pinned the OLD system-prompt
 * preamble ("You are discussing a Portfolio Roast result… Refuse unrelated
 * topics.") which the real function no longer emits (it now leads with "THIS
 * SPECIFIC Portfolio Roast result …" and "politely refuse unrelated topics").
 * The shadow stayed green against a prompt production had already changed.
 *
 * It now imports the REAL exported symbol (the function is pure — it only
 * pulls a type from @usemoney/types — so a direct import is safe) and the
 * preamble assertions are updated to match the live source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StructuredRoastResult } from "@usemoney/types";
import { buildRoastContext } from "@/components/roast/utils";

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

function makeResult(
  overrides?: Partial<StructuredRoastResult>
): StructuredRoastResult {
  return {
    overallScore: 65,
    scoreBreakdown: {
      diversification: { score: 50, comment: "Needs work" },
      riskManagement: { score: 60, comment: "Average risk management" },
      stockPicking: { score: 70, comment: "Decent picks overall" },
      timing: { score: 80, comment: "Good timing sense" },
    },
    roastHighlights: [
      {
        type: "burn",
        emoji: "🔥",
        title: "Energy Overload",
        description: "Your portfolio is basically an oil rig.",
      },
      {
        type: "praise",
        emoji: "🌟",
        title: "Good Entry",
        description: "At least you timed the entry well.",
      },
    ],
    topPerformers: [
      {
        symbol: "RELIANCE",
        pnlPercent: 10.4,
        roast: "The only bright spot.",
      },
    ],
    worstPerformers: [
      {
        symbol: "TCS",
        pnlPercent: -8.6,
        roast: "IT sector is suffering.",
      },
    ],
    sectorAnalysis: [
      {
        sector: "Energy",
        percentage: 62.4,
        verdict: "overweight",
        comment: "Way too much energy.",
      },
      {
        sector: "IT",
        percentage: 37.6,
        verdict: "fair",
        comment: "Reasonable allocation.",
      },
    ],
    constructiveAdvice: [
      {
        title: "Diversify",
        description: "Add FMCG and banking stocks.",
      },
    ],
    roastNarrative: "A funny narrative about your portfolio.",
    disclaimer:
      "This is entertainment, not financial advice. Always consult a qualified financial advisor.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildRoastContext", () => {
  describe("system instruction", () => {
    it("should start with the system instruction about THIS SPECIFIC roast (live source)", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(
        context.startsWith(
          "You are discussing THIS SPECIFIC Portfolio Roast result"
        )
      );
    });

    it("should instruct the model to refuse unrelated topics", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("refuse unrelated topics"));
    });

    it("should ground answers in the specific numbers (anti-generic instruction)", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("cite the actual numbers"));
    });
  });

  describe("overall score", () => {
    it("should include 'Overall Score: X/100'", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("Overall Score: 65/100"));
    });

    it("should include score 0", () => {
      const context = buildRoastContext(makeResult({ overallScore: 0 }));
      assert.ok(context.includes("Overall Score: 0/100"));
    });

    it("should include score 100", () => {
      const context = buildRoastContext(makeResult({ overallScore: 100 }));
      assert.ok(context.includes("Overall Score: 100/100"));
    });
  });

  describe("score breakdown", () => {
    it("should include SCORE BREAKDOWN section header", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("SCORE BREAKDOWN:"));
    });

    it("should include all 4 score categories", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("diversification"));
      assert.ok(context.includes("risk Management"));
      assert.ok(context.includes("stock Picking"));
      assert.ok(context.includes("timing"));
    });

    it("should convert camelCase keys with regex: riskManagement becomes 'risk Management'", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("risk Management: 60/100"));
    });

    it("should convert camelCase keys: stockPicking becomes 'stock Picking'", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("stock Picking: 70/100"));
    });

    it("should include score values and comments", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("50/100 - Needs work"));
      assert.ok(context.includes("60/100 - Average risk management"));
      assert.ok(context.includes("70/100 - Decent picks overall"));
      assert.ok(context.includes("80/100 - Good timing sense"));
    });
  });

  describe("top performers", () => {
    it("should include TOP PERFORMERS section", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("TOP PERFORMERS:"));
    });

    it("should include symbol and pnlPercent with + prefix", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("RELIANCE: +10.4%"));
    });

    it("should include roast comment", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("The only bright spot."));
    });

    it("should omit section when topPerformers is empty", () => {
      const context = buildRoastContext(makeResult({ topPerformers: [] }));
      assert.ok(!context.includes("TOP PERFORMERS:"));
    });
  });

  describe("worst performers", () => {
    it("should include WORST PERFORMERS section", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("WORST PERFORMERS:"));
    });

    it("should include symbol and negative pnlPercent without extra prefix", () => {
      const context = buildRoastContext(makeResult());
      // Negative: toFixed(1) produces "-8.6", no "+" prefix added
      assert.ok(context.includes("TCS: -8.6%"));
    });

    it("should include roast comment for worst performers", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("IT sector is suffering."));
    });

    it("should omit section when worstPerformers is empty", () => {
      const context = buildRoastContext(makeResult({ worstPerformers: [] }));
      assert.ok(!context.includes("WORST PERFORMERS:"));
    });
  });

  describe("sector analysis", () => {
    it("should include SECTOR ANALYSIS section", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("SECTOR ANALYSIS:"));
    });

    it("should include sector, percentage, and verdict", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("Energy: 62.4% (overweight)"));
      assert.ok(context.includes("IT: 37.6% (fair)"));
    });

    it("should include comment after dash separator", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(
        context.includes("Energy: 62.4% (overweight) - Way too much energy.")
      );
    });

    it("should omit comment dash when comment is empty", () => {
      const result = makeResult({
        sectorAnalysis: [
          {
            sector: "Banking",
            percentage: 20,
            verdict: "fair",
            comment: "",
          },
        ],
      });
      const context = buildRoastContext(result);
      assert.ok(context.includes("Banking: 20% (fair)"));
      // Should NOT have trailing " - "
      assert.ok(!context.includes("Banking: 20% (fair) -"));
    });

    it("should omit section when sectorAnalysis is empty", () => {
      const context = buildRoastContext(makeResult({ sectorAnalysis: [] }));
      assert.ok(!context.includes("SECTOR ANALYSIS:"));
    });
  });

  describe("roast highlights", () => {
    it("should include ROAST HIGHLIGHTS section", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("ROAST HIGHLIGHTS:"));
    });

    it("should include type in brackets and title", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("[burn] Energy Overload:"));
      assert.ok(context.includes("[praise] Good Entry:"));
    });

    it("should include description", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("Your portfolio is basically an oil rig."));
    });

    it("should omit section when roastHighlights is empty", () => {
      const context = buildRoastContext(makeResult({ roastHighlights: [] }));
      assert.ok(!context.includes("ROAST HIGHLIGHTS:"));
    });
  });

  describe("constructive advice", () => {
    it("should include CONSTRUCTIVE ADVICE section", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("CONSTRUCTIVE ADVICE:"));
    });

    it("should include title and description", () => {
      const context = buildRoastContext(makeResult());
      assert.ok(context.includes("Diversify: Add FMCG and banking stocks."));
    });

    it("should omit section when constructiveAdvice is empty", () => {
      const context = buildRoastContext(makeResult({ constructiveAdvice: [] }));
      assert.ok(!context.includes("CONSTRUCTIVE ADVICE:"));
    });
  });

  describe("missing/empty arrays omit sections", () => {
    it("should omit all optional sections when arrays are empty", () => {
      const result = makeResult({
        topPerformers: [],
        worstPerformers: [],
        sectorAnalysis: [],
        roastHighlights: [],
        constructiveAdvice: [],
      });
      const context = buildRoastContext(result);
      assert.ok(!context.includes("TOP PERFORMERS:"));
      assert.ok(!context.includes("WORST PERFORMERS:"));
      assert.ok(!context.includes("SECTOR ANALYSIS:"));
      assert.ok(!context.includes("ROAST HIGHLIGHTS:"));
      assert.ok(!context.includes("CONSTRUCTIVE ADVICE:"));
      // But score breakdown and overall score should still be present
      assert.ok(context.includes("SCORE BREAKDOWN:"));
      assert.ok(context.includes("Overall Score:"));
    });
  });

  describe("pnlPercent formatting", () => {
    it("should add + prefix for positive pnlPercent in top performers", () => {
      const result = makeResult({
        topPerformers: [
          { symbol: "TEST", pnlPercent: 25.3, roast: "Good job" },
        ],
      });
      const context = buildRoastContext(result);
      assert.ok(context.includes("TEST: +25.3%"));
    });

    it("should not add + prefix for negative pnlPercent in worst performers", () => {
      const result = makeResult({
        worstPerformers: [{ symbol: "BAD", pnlPercent: -15.2, roast: "Ouch" }],
      });
      const context = buildRoastContext(result);
      assert.ok(context.includes("BAD: -15.2%"));
      // Should NOT have "+-"
      assert.ok(!context.includes("BAD: +-15.2%"));
    });

    it("should handle zero pnlPercent in top performers", () => {
      const result = makeResult({
        topPerformers: [
          { symbol: "FLAT", pnlPercent: 0, roast: "Just sitting there" },
        ],
      });
      const context = buildRoastContext(result);
      assert.ok(context.includes("FLAT: +0.0%"));
    });
  });

  describe("special characters in descriptions", () => {
    it("should handle special characters in advice descriptions", () => {
      const result = makeResult({
        constructiveAdvice: [
          {
            title: "Check P/E ratios",
            description:
              "Look at P/E < 20 & debt/equity < 1.5 for better picks.",
          },
        ],
      });
      const context = buildRoastContext(result);
      assert.ok(
        context.includes(
          "Check P/E ratios: Look at P/E < 20 & debt/equity < 1.5 for better picks."
        )
      );
    });
  });
});
