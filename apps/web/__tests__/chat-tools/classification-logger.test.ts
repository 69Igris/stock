/**
 * Classification Logger Tests (lib/chat-tools/classification-logger.ts)
 *
 * Tests for the self-learning loop:
 *   - ClassificationData interface shape validation
 *   - jaccardSimilarity: word-level Jaccard similarity algorithm
 *   - Misclassification signal detection logic (rephrase, escalation)
 *
 * The async DB-writing functions (logClassification, detectMisclassificationSignal)
 * are tested via interface shape and logic validation. The jaccardSimilarity
 * pure function is reimplemented inline.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): import & assert the REAL exports. `jaccardSimilarity`
// and `classifyMisclassificationSignals` were promoted to exports (the latter is
// called by detectMisclassificationSignal, so neither is dead). Importing
// classification-logger.ts is safe under node:test — Prisma is lazy and opens no
// connection at module load.
import {
  jaccardSimilarity,
  classifyMisclassificationSignals,
  type ClassificationData,
} from "@/lib/chat-tools/classification-logger";

/** Adapter to the de-shadowed signal classifier (same arg order). */
const detectSignals = classifyMisclassificationSignals;

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Classification Logger", () => {
  // ── ClassificationData shape ────────────────────────────────────────────

  describe("ClassificationData interface", () => {
    it("should accept a complete classification data object", () => {
      const data: ClassificationData = {
        message: "analyse TCS",
        intent: "quick_research",
        tier: "L2",
        persona: "equity_research",
        tool: "run_research",
        confidence: 0.85,
        source: "flash",
        flashFailed: false,
        safetyNetActivated: false,
        userId: "user123",
        chatId: "chat456",
        pagePath: "/dashboard",
        requestId: "req-789",
      };
      assert.ok(data.message);
      assert.strictEqual(data.tier, "L2");
      assert.strictEqual(data.source, "flash");
    });

    it("should accept minimal required fields", () => {
      const data: ClassificationData = {
        message: "hello",
        tier: "L1",
        source: "regex",
        flashFailed: true,
        safetyNetActivated: false,
        userId: "u1",
        requestId: "r1",
      };
      assert.ok(data.message);
      assert.strictEqual(data.intent, undefined);
      assert.strictEqual(data.persona, undefined);
    });

    it("should handle message truncation (500 char limit in logClassification)", () => {
      const longMessage = "x".repeat(600);
      const truncated = longMessage.slice(0, 500);
      assert.strictEqual(truncated.length, 500);
    });
  });

  // ── jaccardSimilarity ──────────────────────────────────────────────────

  describe("jaccardSimilarity", () => {
    it("should return 1 for identical strings", () => {
      assert.strictEqual(jaccardSimilarity("hello world", "hello world"), 1);
    });

    it("should return 0 for completely different strings", () => {
      assert.strictEqual(jaccardSimilarity("foo bar", "baz qux"), 0);
    });

    it("should return 1 for two empty strings", () => {
      assert.strictEqual(jaccardSimilarity("", ""), 1);
    });

    it("should return 0 when one string is empty", () => {
      assert.strictEqual(jaccardSimilarity("hello", ""), 0);
      assert.strictEqual(jaccardSimilarity("", "hello"), 0);
    });

    it("should be case-insensitive", () => {
      assert.strictEqual(jaccardSimilarity("Hello World", "hello world"), 1);
    });

    it("should handle duplicate words (set dedup)", () => {
      assert.strictEqual(jaccardSimilarity("hello hello hello", "hello"), 1);
    });

    it("should calculate partial overlap correctly", () => {
      // "analyse TCS stock" vs "TCS stock price" → {analyse, TCS, stock} ∩ {TCS, stock, price} = {TCS, stock}
      // union = 4, intersection = 2, J = 2/4 = 0.5
      const sim = jaccardSimilarity("analyse TCS stock", "TCS stock price");
      assert.strictEqual(sim, 0.5);
    });

    it("should handle single words", () => {
      assert.strictEqual(jaccardSimilarity("hello", "hello"), 1);
      assert.strictEqual(jaccardSimilarity("hello", "world"), 0);
    });

    it("should handle whitespace-only strings", () => {
      assert.strictEqual(jaccardSimilarity("   ", "   "), 1); // empty sets after filter
    });

    it("should handle many overlapping words", () => {
      const sim = jaccardSimilarity(
        "show me stocks with low PE and high ROE",
        "list stocks with low PE ratio and high ROE percentage"
      );
      // intersection: {stocks, with, low, pe, and, high, roe} = 7
      // A: {show, me, stocks, with, low, pe, and, high, roe} = 9
      // B: {list, stocks, with, low, pe, ratio, and, high, roe, percentage} = 10
      // union = 9+10-7 = 12, J = 7/12 ≈ 0.583
      assert.ok(sim > 0.5 && sim < 0.7);
    });
  });

  // ── Misclassification signal detection ──────────────────────────────────

  describe("detectSignals (misclassification detection logic)", () => {
    describe("rephrase detection (Jaccard 0.3-0.9)", () => {
      it("should detect rephrase when similarity is in range", () => {
        // "analyse TCS stock" vs "TCS stock analysis" → J = 0.5
        const { isRephrase } = detectSignals(
          "analyse TCS stock",
          "L1",
          "TCS stock analysis",
          "L1"
        );
        assert.ok(isRephrase);
      });

      it("should NOT detect rephrase when strings are identical (J=1.0)", () => {
        const { isRephrase } = detectSignals(
          "show me TCS PE",
          "L1",
          "show me TCS PE",
          "L1"
        );
        assert.ok(!isRephrase);
      });

      it("should NOT detect rephrase when strings are completely different (J=0)", () => {
        const { isRephrase } = detectSignals(
          "hello world",
          "L1",
          "foo bar baz",
          "L1"
        );
        assert.ok(!isRephrase);
      });

      it("should detect rephrase at lower boundary (J≈0.3)", () => {
        // "analyse TCS stock fundamentals deeply" vs "show TCS price target"
        // Only "TCS" overlaps → J = 1/7 ≈ 0.14 (below threshold)
        // Need: J ≥ 0.3
        // "show me stocks with low PE" vs "list stocks having PE below average"
        // intersection: {stocks, pe} = 2, A=6, B=6, union=10, J=0.2 (below)
        // Let's use: "analyse TCS stock" vs "research TCS fundamentals stock"
        // int: {TCS, stock} = 2, A=3, B=4, union=5, J=0.4
        const { isRephrase } = detectSignals(
          "analyse TCS stock",
          "L1",
          "research TCS fundamentals stock",
          "L2"
        );
        assert.ok(isRephrase);
      });
    });

    describe("escalation detection (L1 → L2/L3 with tool)", () => {
      it("should detect escalation from L1 to L2 with tool", () => {
        const { isEscalation } = detectSignals(
          "what is RSI",
          "L1",
          "screen stocks with RSI < 30",
          "L2",
          "run_screener"
        );
        assert.ok(isEscalation);
      });

      it("should detect escalation from L1 to L3 with tool", () => {
        const { isEscalation } = detectSignals(
          "what is TCS",
          "L1",
          "deep analysis of TCS",
          "L3",
          "run_research"
        );
        assert.ok(isEscalation);
      });

      it("should NOT detect escalation without tool", () => {
        const { isEscalation } = detectSignals(
          "what is RSI",
          "L1",
          "explain RSI in detail",
          "L2",
          undefined
        );
        assert.ok(!isEscalation);
      });

      it("should NOT detect escalation from L2 to L3", () => {
        const { isEscalation } = detectSignals(
          "analyse TCS",
          "L2",
          "deep analyse TCS",
          "L3",
          "run_research"
        );
        assert.ok(!isEscalation); // only L1 → L2/L3 counts
      });

      it("should NOT detect escalation staying at same tier", () => {
        const { isEscalation } = detectSignals(
          "screen stocks",
          "L2",
          "screen more stocks",
          "L2",
          "run_screener"
        );
        assert.ok(!isEscalation);
      });
    });

    describe("combined signals", () => {
      it("can detect both rephrase AND escalation simultaneously", () => {
        const { isRephrase, isEscalation } = detectSignals(
          "analyse TCS stock",
          "L1",
          "TCS stock deep analysis",
          "L2",
          "run_research"
        );
        // J ≈ 0.4 (rephrase range) AND L1→L2 with tool
        assert.ok(isRephrase);
        assert.ok(isEscalation);
      });

      it("should detect neither for unrelated consecutive queries", () => {
        const { isRephrase, isEscalation } = detectSignals(
          "show my portfolio",
          "L1",
          "what is RSI?",
          "L1"
        );
        assert.ok(!isRephrase);
        assert.ok(!isEscalation);
      });
    });
  });
});
