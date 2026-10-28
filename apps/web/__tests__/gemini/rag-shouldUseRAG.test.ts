/**
 * shouldUseRAG - Stock Analysis Keywords & Edge Cases
 *
 * Focused tests for the updated shouldUseRAG function that now includes
 * stock analysis keywords (annual report, quarterly result, analyse, etc.)
 * alongside the existing personal keywords, greetings, meta questions,
 * page-based triggers, and length heuristics.
 *
 * Source: apps/web/lib/gemini/rag.ts
 *
 * NOTE: Pure function re-implemented inline to avoid importing modules
 * with pino logger / Next.js dependencies.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL shouldUseRAG. The source keyword list
// is a superset of the copy that used to live here (it also covers "balance
// sheet", "dividend", "shareholding", …), so every assertion below still holds
// against the real export — and any future change to the source is now caught.
import { shouldUseRAG } from "@/lib/gemini/rag";

// ============== TESTS ==============

describe("shouldUseRAG - Stock Analysis Keywords", () => {
  // ───────────────────── Stock analysis keywords trigger RAG ─────────────────────

  describe("Stock analysis keywords trigger RAG", () => {
    it("should return true for 'annual report' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("Show me the annual report of Reliance", "/dashboard"),
        true
      );
    });

    it("should return true for 'quarterly result' keyword", () => {
      assert.strictEqual(
        shouldUseRAG(
          "What were the quarterly result highlights?",
          "/dashboard"
        ),
        true
      );
    });

    it("should return true for 'latest news' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("What is the latest news on TCS?", "/dashboard"),
        true
      );
    });

    it("should return true for 'analyse' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("Analyse HDFC Bank fundamentals", "/dashboard"),
        true
      );
    });

    it("should return true for 'analyze' keyword (US spelling)", () => {
      assert.strictEqual(
        shouldUseRAG("Analyze Infosys stock performance", "/dashboard"),
        true
      );
    });

    it("should return true for 'research' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("Research ITC for long term investment", "/dashboard"),
        true
      );
    });

    it("should return true for 'evaluate' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("Evaluate this company for investment", "/dashboard"),
        true
      );
    });

    it("should return true for 'filing' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("Check the latest filing from SEBI", "/dashboard"),
        true
      );
    });

    it("should return true for 'management commentary' keyword", () => {
      assert.strictEqual(
        shouldUseRAG(
          "What did the management commentary say about growth?",
          "/dashboard"
        ),
        true
      );
    });

    it("should return true for 'concall' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("Summarize the concall highlights", "/dashboard"),
        true
      );
    });

    it("should return true for 'conference call' keyword", () => {
      assert.strictEqual(
        shouldUseRAG(
          "Key takeaways from the conference call this quarter",
          "/dashboard"
        ),
        true
      );
    });

    it("should return true for 'guidance' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("What guidance did the company give?", "/dashboard"),
        true
      );
    });

    it("should return true for 'outlook' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("What is the outlook for next quarter?", "/dashboard"),
        true
      );
    });

    it("should return true for 'recent news' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("Any recent news about Adani group?", "/dashboard"),
        true
      );
    });

    it("should return true for 'what happened' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("What happened to Paytm stock today?", "/dashboard"),
        true
      );
    });

    it("should return true for 'management said' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("What management said about margins?", "/dashboard"),
        true
      );
    });
  });

  // ───────────────────── Greetings still skip RAG ─────────────────────

  describe("Greetings still skip RAG", () => {
    it("should return false for 'hi' greeting", () => {
      assert.strictEqual(
        shouldUseRAG("hi there, help me with something", "/dashboard"),
        false
      );
    });

    it("should return false for 'hello' greeting", () => {
      assert.strictEqual(
        shouldUseRAG("hello, I need your assistance today", "/dashboard"),
        false
      );
    });

    it("should return false for 'good morning' greeting", () => {
      assert.strictEqual(
        shouldUseRAG("good morning, how are things going?", "/dashboard"),
        false
      );
    });
  });

  // ───────────────────── Meta questions skip RAG ─────────────────────

  describe("Meta questions skip RAG", () => {
    it("should return false for 'what can you do' query", () => {
      assert.strictEqual(
        shouldUseRAG(
          "Tell me what can you do with my data here?",
          "/dashboard"
        ),
        false
      );
    });

    it("should return false for 'who are you' query", () => {
      assert.strictEqual(
        shouldUseRAG(
          "I want to understand who are you and your role",
          "/dashboard"
        ),
        false
      );
    });
  });

  // ───────────────────── Personal keywords trigger RAG ─────────────────────

  describe("Personal keywords trigger RAG", () => {
    it("should return true for 'my portfolio' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("How is my portfolio performing?", "/dashboard"),
        true
      );
    });

    it("should return true for 'i own' keyword", () => {
      assert.strictEqual(
        shouldUseRAG("How many shares do i own in total?", "/dashboard"),
        true
      );
    });
  });

  // ───────────────────── Page-based RAG triggers ─────────────────────

  describe("Page-based RAG triggers", () => {
    it("should return true for /fire page", () => {
      assert.strictEqual(
        shouldUseRAG("How do I plan for this goal?", "/fire"),
        true
      );
    });

    it("should return true for /holdings page", () => {
      assert.strictEqual(
        shouldUseRAG("What is the current value here?", "/holdings"),
        true
      );
    });

    it("should return true for /analysis page", () => {
      assert.strictEqual(
        shouldUseRAG("What are the key ratios here?", "/analysis"),
        true
      );
    });

    it("should return true for /tradebook page", () => {
      assert.strictEqual(
        shouldUseRAG("Show me recent entries here", "/tradebook"),
        true
      );
    });

    it("should return true for /documents page", () => {
      assert.strictEqual(
        shouldUseRAG("What is in this document?", "/documents"),
        true
      );
    });
  });

  // ───────────────────── Short generic queries skip RAG ─────────────────────

  describe("Short generic queries (< 15 chars) skip RAG", () => {
    it("should return false for short generic query", () => {
      assert.strictEqual(shouldUseRAG("help me", "/dashboard"), false);
    });

    it("should return false for very short query", () => {
      assert.strictEqual(shouldUseRAG("ok", "/dashboard"), false);
    });

    it("should return false for 14-char generic query", () => {
      const query = "tell me a joke"; // 14 chars
      assert.ok(query.length < 15);
      assert.strictEqual(shouldUseRAG(query, "/settings"), false);
    });
  });

  // ───────────────────── Substantive queries (> 50 chars) enable RAG ─────────────────────

  describe("Substantive queries (> 50 chars) enable RAG", () => {
    it("should return true for long generic query without keywords", () => {
      const longQuery =
        "Can you please tell me something about how the economy works in detail?";
      assert.ok(longQuery.length > 50);
      assert.strictEqual(shouldUseRAG(longQuery, "/settings"), true);
    });

    it("should return false for medium-length query (15-50 chars) without keywords", () => {
      const mediumQuery = "explain something to me now"; // ~27 chars
      assert.ok(mediumQuery.length >= 15 && mediumQuery.length <= 50);
      assert.strictEqual(shouldUseRAG(mediumQuery, "/settings"), false);
    });
  });

  // ───────────────────── Interaction between keyword + length ─────────────────────

  describe("Stock analysis keyword overrides length heuristic", () => {
    it("should return true for short query with 'analyse' keyword even under 15 chars", () => {
      // "analyse TCS" is 11 chars - under 15, but has stock analysis keyword
      const query = "analyse TCS";
      assert.ok(query.length < 15);
      assert.strictEqual(shouldUseRAG(query, "/dashboard"), true);
    });

    it("should return true for 'results' keyword in medium query", () => {
      const query = "Q3 results of HDFC?"; // 19 chars, has 'results'
      assert.ok(query.length >= 15 && query.length <= 50);
      assert.strictEqual(shouldUseRAG(query, "/dashboard"), true);
    });

    it("should return true for 'earnings' in a short query", () => {
      const query = "earnings TCS"; // 12 chars
      assert.ok(query.length < 15);
      assert.strictEqual(shouldUseRAG(query, "/dashboard"), true);
    });
  });
});
