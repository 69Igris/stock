/**
 * Tier Classifier Tests (lib/chat-tools/tier-classifier.ts)
 *
 * Tests for:
 *   - L3 keyword detection (comprehensive, full analysis, etc.)
 *   - L2 keyword detection (analyze, research, should I buy, etc.)
 *   - L1 default tier for simple queries
 *   - Priority: L3 > L2 > L1
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): assert the REAL classifier, not an outdated copy.
// The old inline L2_PATTERNS was a stale subset (missing the screener/risk/tax
// patterns the source added) — importing the real export pins production logic.
import { classifyTier } from "@/lib/chat-tools/tier-classifier";

// ── Tests ──────────────────────────────────────────────────────────

describe("Tier Classifier", () => {
  describe("L1 Flash (default)", () => {
    it("should classify simple metric questions as L1", () => {
      assert.strictEqual(
        classifyTier("What is RELIANCE PE?", "/dashboard"),
        "L1"
      );
    });

    it("should classify definition questions as L1", () => {
      assert.strictEqual(
        classifyTier("What is a PE ratio?", "/dashboard"),
        "L1"
      );
    });

    it("should classify price lookups as L1", () => {
      assert.strictEqual(classifyTier("INFY revenue?", "/dashboard"), "L1");
    });

    it("should classify portfolio queries as L1", () => {
      assert.strictEqual(classifyTier("Show my holdings", "/dashboard"), "L1");
    });

    it("should classify greeting as L1", () => {
      assert.strictEqual(classifyTier("Hello", "/dashboard"), "L1");
    });
  });

  describe("L2 Deep Dive", () => {
    it("should detect 'analyze' keyword", () => {
      assert.strictEqual(classifyTier("Analyze TCS", "/dashboard"), "L2");
    });

    it("should detect 'should I buy'", () => {
      assert.strictEqual(
        classifyTier("Should I buy HDFC Bank?", "/dashboard"),
        "L2"
      );
    });

    it("should detect 'dcf' keyword", () => {
      assert.strictEqual(classifyTier("DCF of Reliance", "/dashboard"), "L2");
    });

    it("should detect 'deep dive'", () => {
      assert.strictEqual(
        classifyTier("Deep dive into TCS", "/dashboard"),
        "L2"
      );
    });

    it("should detect 'investment thesis'", () => {
      assert.strictEqual(
        classifyTier("Investment thesis for INFY", "/dashboard"),
        "L2"
      );
    });

    it("should detect 'earnings analysis'", () => {
      assert.strictEqual(
        classifyTier("Earnings analysis of TCS", "/dashboard"),
        "L2"
      );
    });

    it("should detect 'bull case'", () => {
      assert.strictEqual(
        classifyTier("Bull case for HDFC", "/dashboard"),
        "L2"
      );
    });

    it("should detect 2-stock comparison", () => {
      assert.strictEqual(classifyTier("TCS vs INFY", "/dashboard"), "L2");
    });

    it("should detect 'screen stocks'", () => {
      assert.strictEqual(
        classifyTier("Screen stocks with PE < 15", "/dashboard"),
        "L2"
      );
    });

    it("should detect '@mention' trigger", () => {
      assert.strictEqual(
        classifyTier("[Mentioned: @TCS] analyze this", "/dashboard"),
        "L2"
      );
    });

    it("should detect 'good to buy'", () => {
      assert.strictEqual(
        classifyTier("Is RELIANCE good to buy?", "/dashboard"),
        "L2"
      );
    });
  });

  describe("L3 Comprehensive", () => {
    it("should detect 'comprehensive' keyword", () => {
      assert.strictEqual(
        classifyTier("Comprehensive analysis of RELIANCE", "/dashboard"),
        "L3"
      );
    });

    it("should detect 'full analysis'", () => {
      assert.strictEqual(
        classifyTier("Full analysis of TCS", "/dashboard"),
        "L3"
      );
    });

    it("should detect 'complete analysis'", () => {
      assert.strictEqual(
        classifyTier("Complete analysis of HDFC Bank", "/dashboard"),
        "L3"
      );
    });

    it("should detect 'institutional'", () => {
      assert.strictEqual(
        classifyTier("Institutional analysis of INFY", "/dashboard"),
        "L3"
      );
    });

    it("should detect 'portfolio optimization'", () => {
      assert.strictEqual(
        classifyTier("Portfolio optimization", "/dashboard"),
        "L3"
      );
    });

    it("should detect 'compare in detail'", () => {
      assert.strictEqual(
        classifyTier("Compare TCS and INFY in detail", "/dashboard"),
        "L3"
      );
    });

    it("should detect 3+ stock comparison", () => {
      assert.strictEqual(
        classifyTier("TCS vs INFY vs WIPRO", "/dashboard"),
        "L3"
      );
    });

    it("should detect 'detailed report'", () => {
      assert.strictEqual(
        classifyTier("Detailed report on RELIANCE", "/dashboard"),
        "L3"
      );
    });
  });

  describe("Priority: L3 > L2 > L1", () => {
    it("should prefer L3 when both L3 and L2 keywords present", () => {
      assert.strictEqual(
        classifyTier(
          "Comprehensive analysis - should I buy RELIANCE?",
          "/dashboard"
        ),
        "L3"
      );
    });

    it("should prefer L2 over L1 for research queries", () => {
      assert.strictEqual(
        classifyTier("Research HDFC stock details", "/dashboard"),
        "L2"
      );
    });
  });

  // Coverage for the screener/risk/tax L2 patterns the source added after the
  // original shadow was written (these were absent from the stale inline copy).
  describe("L2 screener / risk / tax (regression vs stale shadow)", () => {
    it("should detect natural-language screener phrasing", () => {
      assert.strictEqual(
        classifyTier("Show me stocks with PE below 20", "/dashboard"),
        "L2"
      );
    });

    it("should detect indicator-threshold screener queries", () => {
      assert.strictEqual(
        classifyTier("stocks with RSI under 30", "/dashboard"),
        "L2"
      );
    });

    it("should detect index-scoped screener queries", () => {
      assert.strictEqual(
        classifyTier("nifty 50 stocks with high ROE", "/dashboard"),
        "L2"
      );
    });

    it("should detect undervalued/oversold screener queries", () => {
      assert.strictEqual(
        classifyTier("undervalued stocks in nifty", "/dashboard"),
        "L2"
      );
    });

    it("should detect portfolio risk queries", () => {
      // The source pattern is /\b(portfolio|my)\s*(risk|risky|...)\b/ which
      // requires the risk word adjacent to "portfolio"/"my" — "portfolio risk"
      // matches, but "how risky is my portfolio" intentionally does not.
      assert.strictEqual(
        classifyTier("portfolio risk breakdown", "/dashboard"),
        "L2"
      );
      assert.strictEqual(
        classifyTier("my volatility this year", "/dashboard"),
        "L2"
      );
    });

    it("should detect VaR / drawdown queries", () => {
      assert.strictEqual(
        classifyTier("what is the drawdown on my portfolio", "/dashboard"),
        "L2"
      );
    });

    it("should detect capital-gains/tax queries", () => {
      assert.strictEqual(
        classifyTier("capital gains tax report", "/dashboard"),
        "L2"
      );
    });

    it("should detect STCG/LTCG queries", () => {
      assert.strictEqual(
        classifyTier("STCG tax on my trades", "/dashboard"),
        "L2"
      );
    });
  });

  // Blind-spot 2 coverage: adversarial / empty inputs must not throw and must
  // default to L1.
  describe("edge cases", () => {
    it("should default empty string to L1", () => {
      assert.strictEqual(classifyTier("", "/dashboard"), "L1");
    });

    it("should default whitespace-only to L1", () => {
      assert.strictEqual(classifyTier("   \n\t ", "/dashboard"), "L1");
    });

    it("should not throw on punctuation-only input", () => {
      assert.strictEqual(classifyTier("?!.,", "/dashboard"), "L1");
    });
  });
});
