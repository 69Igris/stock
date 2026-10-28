/**
 * Assemble Result Tests
 *
 * Tests for the pure `assembleResult` function from
 * packages/roast/src/steps/assemble-result.ts.
 *
 * MONEY-620 de-shadow: previously this file re-declared `assembleResult`
 * inline and asserted the copy (a shadow — green even if the real source
 * drifted). It now imports the REAL exported symbol via a relative source
 * path (the same pure-import pattern used by parse-llm-json.test.ts — the
 * step file has no DB/network side-effects at import beyond pulling the
 * shared types).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assembleResult } from "../../../../packages/roast/src/steps/assemble-result";
import type {
  ScoresResult,
  RoastContentResult,
  PortfolioData,
} from "../../../../packages/roast/src/types";

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeScores(overrides?: Partial<ScoresResult>): ScoresResult {
  return {
    overallScore: 65,
    scoreBreakdown: {
      diversification: { score: 50, comment: "Needs work" },
      riskManagement: { score: 60, comment: "Average risk management" },
      stockPicking: { score: 70, comment: "Decent picks" },
      timing: { score: 80, comment: "Good timing" },
    },
    ...overrides,
  };
}

function makeRoastContent(
  overrides?: Partial<RoastContentResult>
): RoastContentResult {
  return {
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
        title: "Good Timing",
        description: "At least you got in at the right time.",
      },
    ],
    topPerformers: [
      { symbol: "RELIANCE", pnlPercent: 10.4, roast: "The only bright spot." },
    ],
    worstPerformers: [
      {
        symbol: "TCS",
        pnlPercent: -8.6,
        roast: "IT sector having a tough time.",
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
        title: "Diversify sectors",
        description: "Add FMCG and banking stocks.",
      },
      {
        title: "Reduce concentration",
        description: "No single sector above 30%.",
      },
    ],
    roastNarrative:
      "Your portfolio walks into a bar and the bartender says 'We only serve energy drinks here.'",
    ...overrides,
  };
}

// assembleResult ignores its portfolio argument entirely (it's `_portfolio`),
// so the tests only need *some* PortfolioData-shaped value. We cast minimal
// literals through `unknown` to satisfy the real type without re-declaring the
// full StockHolding/MfHolding shapes (no `any`).
function makePortfolio(): PortfolioData {
  return {
    holdings: [{ symbol: "RELIANCE" }, { symbol: "TCS" }],
    mfs: [{ schemeName: "Axis Bluechip" }],
    summary: { stockCount: 2, mfCount: 1 },
  } as unknown as PortfolioData;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assembleResult", () => {
  describe("overallScore mapping", () => {
    it("should map overallScore from scores", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.overallScore, 65);
    });

    it("should map overallScore of 0", () => {
      const result = assembleResult(
        makeScores({ overallScore: 0 }),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.overallScore, 0);
    });

    it("should map overallScore of 100", () => {
      const result = assembleResult(
        makeScores({ overallScore: 100 }),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.overallScore, 100);
    });
  });

  describe("scoreBreakdown mapping", () => {
    it("should map diversification score and comment", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.scoreBreakdown.diversification.score, 50);
      assert.strictEqual(
        result.scoreBreakdown.diversification.comment,
        "Needs work"
      );
    });

    it("should map riskManagement score and comment", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.scoreBreakdown.riskManagement.score, 60);
      assert.strictEqual(
        result.scoreBreakdown.riskManagement.comment,
        "Average risk management"
      );
    });

    it("should map stockPicking score and comment", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.scoreBreakdown.stockPicking.score, 70);
      assert.strictEqual(
        result.scoreBreakdown.stockPicking.comment,
        "Decent picks"
      );
    });

    it("should map timing score and comment", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.scoreBreakdown.timing.score, 80);
      assert.strictEqual(result.scoreBreakdown.timing.comment, "Good timing");
    });
  });

  describe("roastContent field mapping", () => {
    it("should map roastHighlights", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.roastHighlights.length, 2);
      assert.strictEqual(result.roastHighlights[0]!.type, "burn");
      assert.strictEqual(result.roastHighlights[0]!.title, "Energy Overload");
      assert.strictEqual(result.roastHighlights[1]!.type, "praise");
    });

    it("should map topPerformers", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.topPerformers.length, 1);
      assert.strictEqual(result.topPerformers[0]!.symbol, "RELIANCE");
      assert.strictEqual(result.topPerformers[0]!.pnlPercent, 10.4);
    });

    it("should map worstPerformers", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.worstPerformers.length, 1);
      assert.strictEqual(result.worstPerformers[0]!.symbol, "TCS");
      assert.strictEqual(result.worstPerformers[0]!.pnlPercent, -8.6);
    });

    it("should map sectorAnalysis", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.sectorAnalysis.length, 2);
      assert.strictEqual(result.sectorAnalysis[0]!.sector, "Energy");
      assert.strictEqual(result.sectorAnalysis[0]!.verdict, "overweight");
    });

    it("should map constructiveAdvice", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(result.constructiveAdvice.length, 2);
      assert.strictEqual(
        result.constructiveAdvice[0]!.title,
        "Diversify sectors"
      );
      assert.strictEqual(
        result.constructiveAdvice[0]!.description,
        "Add FMCG and banking stocks."
      );
    });

    it("should map roastNarrative", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.ok(result.roastNarrative.includes("portfolio walks into a bar"));
    });
  });

  describe("disclaimer", () => {
    it("should always include disclaimer", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.ok(result.disclaimer.length > 0);
    });

    it("should have exact disclaimer text", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent(),
        makePortfolio()
      );
      assert.strictEqual(
        result.disclaimer,
        "This is entertainment, not financial advice. Always consult a qualified financial advisor."
      );
    });
  });

  describe("portfolio parameter unused", () => {
    it("should return same result with different portfolio objects", () => {
      const scores = makeScores();
      const content = makeRoastContent();

      const portfolioA = {
        holdings: [{ symbol: "A" }],
        mfs: [],
        summary: { stockCount: 1 },
      } as unknown as PortfolioData;
      const portfolioB = {
        holdings: [{ symbol: "B" }, { symbol: "C" }],
        mfs: [{ schemeName: "X" }],
        summary: { stockCount: 2, mfCount: 1 },
      } as unknown as PortfolioData;

      const resultA = assembleResult(scores, content, portfolioA);
      const resultB = assembleResult(scores, content, portfolioB);

      assert.strictEqual(resultA.overallScore, resultB.overallScore);
      assert.strictEqual(resultA.disclaimer, resultB.disclaimer);
      assert.strictEqual(resultA.roastNarrative, resultB.roastNarrative);
      assert.deepStrictEqual(resultA.scoreBreakdown, resultB.scoreBreakdown);
      assert.deepStrictEqual(resultA.roastHighlights, resultB.roastHighlights);
    });

    it("should return same result with empty portfolio", () => {
      const scores = makeScores();
      const content = makeRoastContent();
      const emptyPortfolio = {
        holdings: [],
        mfs: [],
        summary: {},
      } as unknown as PortfolioData;

      const resultEmpty = assembleResult(scores, content, emptyPortfolio);
      const resultFull = assembleResult(scores, content, makePortfolio());

      assert.strictEqual(resultEmpty.overallScore, resultFull.overallScore);
      assert.strictEqual(resultEmpty.disclaimer, resultFull.disclaimer);
    });
  });

  describe("empty arrays in roastContent", () => {
    it("should handle empty roastHighlights", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent({ roastHighlights: [] }),
        makePortfolio()
      );
      assert.deepStrictEqual(result.roastHighlights, []);
    });

    it("should handle empty topPerformers", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent({ topPerformers: [] }),
        makePortfolio()
      );
      assert.deepStrictEqual(result.topPerformers, []);
    });

    it("should handle empty worstPerformers", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent({ worstPerformers: [] }),
        makePortfolio()
      );
      assert.deepStrictEqual(result.worstPerformers, []);
    });

    it("should handle empty sectorAnalysis", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent({ sectorAnalysis: [] }),
        makePortfolio()
      );
      assert.deepStrictEqual(result.sectorAnalysis, []);
    });

    it("should handle empty constructiveAdvice", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent({ constructiveAdvice: [] }),
        makePortfolio()
      );
      assert.deepStrictEqual(result.constructiveAdvice, []);
    });

    it("should handle all arrays empty simultaneously", () => {
      const result = assembleResult(
        makeScores(),
        makeRoastContent({
          roastHighlights: [],
          topPerformers: [],
          worstPerformers: [],
          sectorAnalysis: [],
          constructiveAdvice: [],
          roastNarrative: "",
        }),
        makePortfolio()
      );
      assert.deepStrictEqual(result.roastHighlights, []);
      assert.deepStrictEqual(result.topPerformers, []);
      assert.deepStrictEqual(result.worstPerformers, []);
      assert.deepStrictEqual(result.sectorAnalysis, []);
      assert.deepStrictEqual(result.constructiveAdvice, []);
      assert.strictEqual(result.roastNarrative, "");
      // Disclaimer should still be present
      assert.ok(result.disclaimer.length > 0);
    });
  });
});
