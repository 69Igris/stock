/**
 * Scorecard block emission tests (MONEY-587).
 *
 * Re-implements the pure helpers + section mapping from
 * apps/web/lib/chat/research-blocks.ts (confidenceLabel, firstSentence, the
 * scoreBreakdown→scorecard.sections transform) and the widened
 * isValidContentBlock type list, so the test runs without importing the
 * Next.js server module — matches the repo's pure-logic test convention.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): assert the REAL exports. confidenceLabel,
// firstSentence and buildScorecardSections are now exported from
// research-blocks.ts; buildScorecardSections is CALLED by both
// convertResearchToBlocks and convertFullReportToBlocks (so it isn't dead) and
// scrubs label/value strings via the source's safeScrub. The block-type list is
// asserted through the real isValidContentBlock instead of a hand-synced copy.
import {
  confidenceLabel,
  firstSentence,
  buildScorecardSections,
  isValidContentBlock,
} from "@/lib/chat/research-blocks";

describe("Scorecard block (MONEY-587)", () => {
  describe("confidenceLabel", () => {
    it("maps >=70 to High", () => assert.equal(confidenceLabel(78), "High"));
    it("maps 45–69 to Medium", () =>
      assert.equal(confidenceLabel(50), "Medium"));
    it("maps <45 to Low", () => assert.equal(confidenceLabel(30), "Low"));
    it("returns undefined when missing", () =>
      assert.equal(confidenceLabel(undefined), undefined));
    it("boundary 70 → High", () => assert.equal(confidenceLabel(70), "High"));
    it("boundary 45 → Medium", () =>
      assert.equal(confidenceLabel(45), "Medium"));
    it("boundary 44 → Low", () => assert.equal(confidenceLabel(44), "Low"));
  });

  describe("firstSentence", () => {
    it("takes the first sentence", () =>
      assert.equal(
        firstSentence("INFY is cash-generative. It trades at a premium."),
        "INFY is cash-generative."
      ));
    it("returns the whole string when there is no terminator", () =>
      assert.equal(firstSentence("strong franchise"), "strong franchise"));
    it("caps the verdict at 240 chars", () =>
      assert.ok(firstSentence("x".repeat(400)).length <= 240));
    it("trims surrounding whitespace", () =>
      assert.equal(firstSentence("   hello world.  "), "hello world."));
  });

  describe("scorecard sections", () => {
    it("normalizes scoreBreakdown to /100 and prepends a Key metrics section", () => {
      const sections = buildScorecardSections({
        score: 78,
        keyMetrics: [{ label: "ROE", value: "31%" }],
        scoreBreakdown: [
          {
            criterion: "Financial health",
            score: 8,
            maxScore: 10,
            comment: "zero debt",
          },
        ],
      });
      assert.equal(sections.length, 2);
      assert.equal(sections[0]!.title, "Key metrics");
      assert.equal(sections[0]!.score, 78);
      assert.deepEqual(sections[0]!.metrics, [["ROE", "31%"]]);
      assert.equal(sections[1]!.title, "Financial health");
      assert.equal(sections[1]!.score, 80); // 8/10 → 80
      assert.equal(sections[1]!.summary, "zero debt");
    });

    it("caps key metrics at 8", () => {
      const km = Array.from({ length: 12 }, (_, i) => ({
        label: `m${i}`,
        value: `${i}`,
      }));
      const sections = buildScorecardSections({ score: 50, keyMetrics: km });
      // `metrics` is optional on a scorecard section — an absent list must
      // fail here, not be silently treated as "capped".
      const metrics = sections[0]?.metrics;
      assert.ok(metrics, "expected metrics on the first section");
      assert.equal(metrics.length, 8);
    });

    it("returns no sections for a bare score report", () => {
      assert.deepEqual(buildScorecardSections({ score: 50 }), []);
    });
  });

  describe("isValidContentBlock type list", () => {
    it("accepts the new typed financial blocks", () => {
      for (const type of [
        "scorecard",
        "portfolio",
        "holdings",
        "risk",
        "tax",
        "mf",
        "fire",
        "sector",
        "technical",
        "news",
        "pnl",
        "dividend",
      ]) {
        assert.ok(
          isValidContentBlock({ type }),
          `expected ${type} to be valid`
        );
      }
    });

    it("still accepts the legacy blocks", () => {
      for (const type of [
        "text",
        "table",
        "card",
        "navigation",
        "research-stream",
      ]) {
        assert.ok(isValidContentBlock({ type }));
      }
    });

    it("rejects an unknown block type", () => {
      assert.ok(!isValidContentBlock({ type: "hologram" }));
    });
  });
});
