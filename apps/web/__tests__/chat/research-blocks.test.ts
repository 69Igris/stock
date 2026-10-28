/**
 * Research Blocks Tests (lib/chat/research-blocks.ts)
 *
 * De-shadowed (MONEY-620). This file previously inlined `isValidContentBlock`,
 * `isStructuredReport`, `isComparisonRec`, `formatRecForDisplay`,
 * `normalizeQualityScore`, AND a full copy of `convertResearchToBlocks` /
 * `convertStructuredReportToBlocks`, then asserted the copies. Importing the
 * REAL exports exposed several drifts the shadow hid:
 *   - `isValidContentBlock` now accepts ~26 block types (scorecard, portfolio,
 *     dividend, …); the inline copy only knew 8.
 *   - `formatRecForDisplay` now collapses every comparison code to "Comparison"
 *     (it is deprecated); the copy still produced "RELIANCE Preferred" etc.
 *   - the structured-report path now emits a `scorecard` block (MONEY-587), not
 *     the old `card` with a "72/100" value the copy built.
 *
 * The helpers are now exported (and are all reached by the exported converters,
 * so none are dead). Tests assert the real exports + drive the real
 * `convertResearchToBlocks` for block assembly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isStructuredReport,
  isComparisonRec,
  formatRecForDisplay,
  normalizeQualityScore,
  isValidContentBlock,
  convertResearchToBlocks,
} from "@/lib/chat/research-blocks";
import type { ContentBlock, ScorecardBlock } from "@usemoney/types";

/**
 * Narrow an emitted block to the REAL `ScorecardBlock` type.
 *
 * These assertions used to read fields through `as Record<string, unknown>`,
 * which silently accepted ANY key — a renamed/removed scorecard field would
 * have read back `undefined` instead of failing to compile. Narrowing on the
 * discriminant pins the production field names and types instead.
 */
function expectScorecard(block: ContentBlock | undefined): ScorecardBlock {
  assert.ok(block, "expected a content block");
  assert.strictEqual(block.type, "scorecard");
  return block;
}

interface StructuredReport {
  score?: number;
  recommendation?: string;
  confidence?: number;
  summary?: string;
  keyMetrics?: Array<{ label: string; value: string; verdict?: string }>;
  strengths?: string[];
  risks?: string[];
  priceTarget?: {
    low?: number;
    mid?: number;
    high?: number;
    current?: number;
  };
}

interface ResearchResult {
  report: unknown;
  contentBlocks: unknown[];
  qualityScore?: number;
  tokensUsed: number;
  symbols: string[];
  sessionId?: string;
}

describe("Research Blocks", () => {
  // ══════════════════════ isStructuredReport ══════════════════════

  describe("isStructuredReport", () => {
    it("should return true when score is a number", () => {
      assert.ok(isStructuredReport({ score: 75 }));
    });

    it("should return true when recommendation is a string", () => {
      assert.ok(isStructuredReport({ recommendation: "BUY" }));
    });

    it("should return true when both present", () => {
      assert.ok(
        isStructuredReport({ score: 80, recommendation: "STRONG_BUY" })
      );
    });

    it("should return true for score 0", () => {
      assert.ok(isStructuredReport({ score: 0 }));
    });

    it("should return true for negative score", () => {
      assert.ok(isStructuredReport({ score: -5 }));
    });

    it("should return true for fractional score", () => {
      assert.ok(isStructuredReport({ score: 72.5 }));
    });

    it("should return true for empty-string recommendation", () => {
      assert.ok(isStructuredReport({ recommendation: "" }));
    });

    it("should return false for empty object", () => {
      assert.ok(!isStructuredReport({}));
    });

    it("should return false when score is a string", () => {
      assert.ok(!isStructuredReport({ score: "75" }));
    });

    it("should return false when recommendation is a number", () => {
      assert.ok(!isStructuredReport({ recommendation: 42 }));
    });

    it("should return false for null / undefined / primitives / arrays", () => {
      assert.ok(!isStructuredReport(null));
      assert.ok(!isStructuredReport(undefined));
      assert.ok(!isStructuredReport("BUY"));
      assert.ok(!isStructuredReport(80));
      assert.ok(!isStructuredReport([]));
    });
  });

  // ══════════════════════ isComparisonRec ══════════════════════

  describe("isComparisonRec", () => {
    it("should detect STOCK_A_PREFERRED / STOCK_B_PREFERRED", () => {
      assert.ok(isComparisonRec("STOCK_A_PREFERRED"));
      assert.ok(isComparisonRec("STOCK_B_PREFERRED"));
    });

    it("should detect EQUAL", () => {
      assert.ok(isComparisonRec("EQUAL"));
    });

    it("should detect any *_PREFERRED code", () => {
      assert.ok(isComparisonRec("RELIANCE_PREFERRED"));
      assert.ok(isComparisonRec("TCS_NS_PREFERRED"));
    });

    it("should NOT detect plain recommendations", () => {
      assert.ok(!isComparisonRec("STRONG_BUY"));
      assert.ok(!isComparisonRec("BUY"));
      assert.ok(!isComparisonRec("HOLD"));
      assert.ok(!isComparisonRec("SELL"));
      assert.ok(!isComparisonRec("N/A"));
    });

    it("should NOT detect empty / bare PREFERRED / wrong case", () => {
      assert.ok(!isComparisonRec(""));
      assert.ok(!isComparisonRec("PREFERRED"));
      assert.ok(!isComparisonRec("STOCK_A_PREFERRED_EXTRA"));
      assert.ok(!isComparisonRec("STOCK_A_preferred"));
      assert.ok(!isComparisonRec("equal"));
    });
  });

  // ══════════════════════ formatRecForDisplay (deprecated) ══════════════════

  describe("formatRecForDisplay", () => {
    // The REAL function collapses every comparison code to "Comparison" and
    // passes non-comparison recs through unchanged. (The old shadow asserted a
    // since-removed "<SYMBOL> Preferred" / "No Clear Winner" mapping.)
    it("should map EQUAL to 'Comparison'", () => {
      assert.strictEqual(
        formatRecForDisplay("EQUAL", ["RELIANCE.NS", "IOC.NS"]),
        "Comparison"
      );
    });

    it("should map STOCK_A_PREFERRED to 'Comparison'", () => {
      assert.strictEqual(
        formatRecForDisplay("STOCK_A_PREFERRED", ["RELIANCE.NS", "IOC.NS"]),
        "Comparison"
      );
    });

    it("should map STOCK_B_PREFERRED to 'Comparison'", () => {
      assert.strictEqual(
        formatRecForDisplay("STOCK_B_PREFERRED", ["RELIANCE.NS", "IOC.NS"]),
        "Comparison"
      );
    });

    it("should map any *_PREFERRED to 'Comparison' regardless of symbols", () => {
      assert.strictEqual(
        formatRecForDisplay("RELIANCE_PREFERRED", []),
        "Comparison"
      );
      assert.strictEqual(
        formatRecForDisplay("LARGE_CAP_PREFERRED", []),
        "Comparison"
      );
    });

    it("should pass non-comparison recs through unchanged", () => {
      assert.strictEqual(formatRecForDisplay("BUY", ["TCS.NS"]), "BUY");
      assert.strictEqual(formatRecForDisplay("STRONG_BUY", []), "STRONG_BUY");
    });
  });

  // ══════════════════════ normalizeQualityScore ══════════════════════

  describe("normalizeQualityScore", () => {
    it("should multiply 0-1 range by 100 and round", () => {
      assert.strictEqual(normalizeQualityScore(0.85), 85);
      assert.strictEqual(normalizeQualityScore(1.0), 100);
      assert.strictEqual(normalizeQualityScore(0.0), 0);
      assert.strictEqual(normalizeQualityScore(0.876), 88);
      assert.strictEqual(normalizeQualityScore(0.5), 50);
    });

    it("should pass through scores > 1 with rounding", () => {
      assert.strictEqual(normalizeQualityScore(75), 75);
      assert.strictEqual(normalizeQualityScore(100), 100);
      assert.strictEqual(normalizeQualityScore(82.7), 83);
    });

    it("should treat exactly 1 as the 0-1 scale (→ 100)", () => {
      assert.strictEqual(normalizeQualityScore(1), 100);
    });

    it("should treat just-above-1 as already-100-scale (1.1 → 1)", () => {
      assert.strictEqual(normalizeQualityScore(1.1), 1);
    });
  });

  // ══════════════════════ isValidContentBlock ══════════════════════

  describe("isValidContentBlock", () => {
    it("should accept the core block types", () => {
      for (const type of [
        "text",
        "table",
        "card",
        "chart",
        "navigation",
        "comparison",
        "error",
      ]) {
        assert.ok(isValidContentBlock({ type }), `expected ${type} valid`);
      }
    });

    it("should accept the MONEY-587 typed financial block types", () => {
      // These were ADDED to the source after the shadow was written.
      for (const type of [
        "scorecard",
        "portfolio",
        "holdings",
        "tax",
        "risk",
        "mf",
        "fire",
        "sector",
        "technical",
        "news",
        "pnl",
        "dividend",
        "stock-list",
        "roast-summary",
        "refusal",
      ]) {
        assert.ok(isValidContentBlock({ type }), `expected ${type} valid`);
      }
    });

    it("should reject unknown type / null / missing type / non-object", () => {
      assert.ok(!isValidContentBlock({ type: "unknown" }));
      assert.ok(!isValidContentBlock(null));
      assert.ok(!isValidContentBlock({ content: "text only" }));
      assert.ok(!isValidContentBlock("text"));
    });
  });

  // ══════════════════════ convertResearchToBlocks (structured) ═══════════════

  describe("convertResearchToBlocks (structured report → scorecard)", () => {
    function makeResult(
      report: StructuredReport,
      overrides?: Partial<ResearchResult>
    ): ResearchResult {
      return {
        report,
        contentBlocks: [],
        tokensUsed: 1000,
        symbols: ["TCS.NS"],
        sessionId: "sess-123",
        ...overrides,
      };
    }

    it("emits a scorecard as the first block (MONEY-587 shape)", () => {
      const blocks = convertResearchToBlocks(
        makeResult({ score: 72, recommendation: "BUY", confidence: 80 })
      );
      const first = expectScorecard(blocks[0]);
      assert.strictEqual(first.overall, 72);
      assert.strictEqual(first.symbol, "TCS"); // .NS stripped
    });

    it("maps confidence to the High/Medium/Low pill", () => {
      const high = expectScorecard(
        convertResearchToBlocks(
          makeResult({ score: 50, recommendation: "HOLD", confidence: 80 })
        )[0]
      );
      assert.strictEqual(high.confidence, "High");

      const low = expectScorecard(
        convertResearchToBlocks(
          makeResult({ score: 50, recommendation: "HOLD", confidence: 20 })
        )[0]
      );
      assert.strictEqual(low.confidence, "Low");
    });

    it("derives the verdict from the first sentence of the summary", () => {
      const first = expectScorecard(
        convertResearchToBlocks(
          makeResult({
            score: 72,
            recommendation: "BUY",
            summary: "Strong fundamentals. Lots more detail follows here.",
          })
        )[0]
      );
      assert.strictEqual(first.verdict, "Strong fundamentals.");
    });

    it("joins multiple symbols for the scorecard label", () => {
      const first = expectScorecard(
        convertResearchToBlocks(
          makeResult(
            { score: 80, recommendation: "STOCK_A_PREFERRED", confidence: 70 },
            { symbols: ["RELIANCE.NS", "IOC.NS"] }
          )
        )[0]
      );
      assert.strictEqual(first.symbol, "RELIANCE vs IOC");
    });

    it("forwards the sessionId onto the scorecard", () => {
      const first = expectScorecard(
        convertResearchToBlocks(
          makeResult({ score: 72, recommendation: "BUY" }, { sessionId: "abc" })
        )[0]
      );
      assert.strictEqual(first.sessionId, "abc");
    });

    it("every emitted block passes isValidContentBlock", () => {
      const blocks = convertResearchToBlocks(
        makeResult({
          score: 72,
          recommendation: "BUY",
          confidence: 80,
          summary: "Good.",
          keyMetrics: [{ label: "PE", value: "25" }],
          strengths: ["A"],
          risks: ["X"],
        })
      );
      assert.ok(blocks.length > 0);
      for (const b of blocks) {
        assert.ok(
          isValidContentBlock(b),
          `invalid block: ${JSON.stringify(b)}`
        );
      }
    });
  });

  // ══════════════════════ convertResearchToBlocks (quality fallback) ═════════

  describe("convertResearchToBlocks (non-structured quality fallback)", () => {
    it("emits a scorecard from a 0-1 qualityScore (normalised to 0-100)", () => {
      const blocks = convertResearchToBlocks({
        report: { freeform: "no score here" },
        contentBlocks: [],
        qualityScore: 0.82,
        tokensUsed: 10,
        symbols: ["INFY.NS"],
        sessionId: "s9",
      });
      const sc = expectScorecard(blocks.find((b) => b.type === "scorecard"));
      assert.strictEqual(sc.overall, 82);
    });

    it("does not throw on an empty result and yields valid blocks", () => {
      const blocks = convertResearchToBlocks({
        report: null,
        contentBlocks: [],
        tokensUsed: 0,
        symbols: [],
      });
      for (const b of blocks) {
        assert.ok(isValidContentBlock(b));
      }
    });
  });
});
