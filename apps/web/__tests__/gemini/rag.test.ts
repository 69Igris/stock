/**
 * RAG (Retrieval-Augmented Generation) Pipeline Tests
 *
 * Tests for pure functions from lib/gemini/rag.ts that handle:
 * - shouldUseRAG: Heuristic logic for deciding when to use RAG
 * - mergeContexts: String concatenation with formatting
 * - summarizeRetrievedContext: Document type counting from context
 * - getDocTypesForPage: Maps page paths to document types
 * - fitToTokenBudget: Filters documents to fit within token budget
 * - formatContextForPrompt: Formats retrieved documents for prompt
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL exports from rag.ts. Importing rag.ts
// is side-effect-free (its Prisma dep is only touched inside async functions).
// The previous inline copy had DRIFTED: its getDocTypesForPage returned
// ["analysis","holdings"] for analysis/stock pages, but the real source now
// returns the 6-type financial-document set. Asserting the copy hid that.
import {
  shouldUseRAG,
  mergeContexts,
  summarizeRetrievedContext,
  getDocTypesForPage,
  contentFingerprint,
  fitToTokenBudget,
  formatContextForPrompt,
  type RetrievedDocument,
  type RAGContext,
} from "@/lib/gemini/rag";
import type { SearchResult, DocumentType } from "@/lib/gemini/vector-store";

// Expected labels for the base doc types (mirrors the real DOC_TYPE_LABELS for
// the subset these tests format; used only to build expected output strings).
const DOC_TYPE_LABELS: Record<string, string> = {
  holdings: "Portfolio Holdings",
  trades: "Trading Activity",
  fire_scenario: "FIRE Scenario",
  analysis: "Stock Analysis",
  user_preferences: "User Preferences",
  document: "Uploaded Document",
};

// ============== FACTORY FUNCTIONS ==============

function createMockSearchResult(
  overrides: Partial<SearchResult> = {}
): SearchResult {
  return {
    content: "RELIANCE: 50 shares @ 2450.00",
    docType: "holdings",
    docId: "doc-1",
    score: 0.85,
    metadata: {},
    ...overrides,
  };
}

function createMockRetrievedDocument(
  overrides: Partial<RetrievedDocument> = {}
): RetrievedDocument {
  return {
    content: "RELIANCE: 50 shares @ 2450.00",
    docType: "holdings",
    score: 0.85,
    metadata: {},
    ...overrides,
  };
}

function createMockRAGContext(overrides: Partial<RAGContext> = {}): RAGContext {
  return {
    documents: [],
    formattedContext: "",
    tokenEstimate: 0,
    ...overrides,
  };
}

// ============== TESTS ==============

describe("RAG Pipeline", () => {
  // ───────────────────── shouldUseRAG ─────────────────────

  describe("shouldUseRAG", () => {
    describe("Short queries (< 15 chars)", () => {
      it("should return false for very short generic queries", () => {
        assert.strictEqual(shouldUseRAG("hello", "/dashboard"), false);
      });

      it("should return true for short query with keyword (keywords override length)", () => {
        assert.strictEqual(shouldUseRAG("my stocks", "/dashboard"), true);
      });

      it("should return false for empty string", () => {
        assert.strictEqual(shouldUseRAG("", "/dashboard"), false);
      });

      it("should return true for short query with personal keyword", () => {
        assert.strictEqual(shouldUseRAG("portfolio", "/dashboard"), true);
      });

      it("should return false for short generic query without keyword", () => {
        assert.strictEqual(shouldUseRAG("tell me more", "/dashboard"), false);
      });
    });

    describe("Generic greetings", () => {
      it("should return false for 'hello' greeting", () => {
        assert.strictEqual(
          shouldUseRAG("hello how are you doing today?", "/dashboard"),
          false
        );
      });

      it("should return false for 'hi' greeting", () => {
        assert.strictEqual(
          shouldUseRAG("hi there, nice to meet you!", "/dashboard"),
          false
        );
      });

      it("should return false for 'hey' greeting", () => {
        assert.strictEqual(
          shouldUseRAG("hey what is going on today?", "/dashboard"),
          false
        );
      });

      it("should return false for 'good morning' greeting", () => {
        assert.strictEqual(
          shouldUseRAG("good morning, hope you are well!", "/dashboard"),
          false
        );
      });

      it("should return false for 'good afternoon' greeting", () => {
        assert.strictEqual(
          shouldUseRAG("good afternoon, can you help?", "/dashboard"),
          false
        );
      });

      it("should return false for 'good evening' greeting", () => {
        assert.strictEqual(
          shouldUseRAG("good evening everyone here!", "/dashboard"),
          false
        );
      });
    });

    describe("Meta questions about the AI", () => {
      it("should return false for 'what can you do' query", () => {
        assert.strictEqual(
          shouldUseRAG("I want to know what can you do for me", "/dashboard"),
          false
        );
      });

      it("should return false for 'who are you' query", () => {
        assert.strictEqual(
          shouldUseRAG("Can you tell me who are you exactly?", "/dashboard"),
          false
        );
      });

      it("should return false for 'how do you work' query", () => {
        assert.strictEqual(
          shouldUseRAG(
            "I am curious about how do you work internally",
            "/dashboard"
          ),
          false
        );
      });
    });

    describe("Personal keyword triggers", () => {
      it("should return true for 'my portfolio' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Show me my portfolio summary", "/dashboard"),
          true
        );
      });

      it("should return true for 'my holdings' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("What are my holdings right now?", "/dashboard"),
          true
        );
      });

      it("should return true for 'i have' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("I have invested in Reliance shares", "/dashboard"),
          true
        );
      });

      it("should return true for 'i own' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("How many shares do i own currently?", "/dashboard"),
          true
        );
      });

      it("should return true for 'trades' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Show me all my recent trades please", "/dashboard"),
          true
        );
      });

      it("should return true for 'stocks' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Which stocks should I buy today?", "/dashboard"),
          true
        );
      });

      it("should return true for 'retirement' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Plan my retirement for age 50", "/dashboard"),
          true
        );
      });

      it("should return true for 'fire' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("How do I achieve fire by age 45?", "/dashboard"),
          true
        );
      });

      it("should return true for 'bought' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("I recently bought some shares of HDFC", "/dashboard"),
          true
        );
      });

      it("should return true for 'sold' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("I recently sold my Infosys shares", "/dashboard"),
          true
        );
      });

      it("should return true for 'invested' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("I have invested in index funds too", "/dashboard"),
          true
        );
      });

      it("should return true for 'returns' keyword", () => {
        assert.strictEqual(
          shouldUseRAG(
            "What are my portfolio returns this year?",
            "/dashboard"
          ),
          true
        );
      });

      it("should return true for 'profit' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("How much profit have I made overall?", "/dashboard"),
          true
        );
      });

      it("should return true for 'loss' keyword", () => {
        assert.strictEqual(
          shouldUseRAG(
            "Am I currently making a loss on anything?",
            "/dashboard"
          ),
          true
        );
      });

      it("should return true for 'pnl' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Show me my total pnl for this month", "/dashboard"),
          true
        );
      });

      it("should return true for 'analysis' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Give me an analysis of my portfolio", "/dashboard"),
          true
        );
      });

      it("should return true for 'scenario' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Create a new scenario for retirement", "/dashboard"),
          true
        );
      });
    });

    describe("Page-based context triggers", () => {
      it("should return true for /fire page path", () => {
        assert.strictEqual(
          shouldUseRAG("How much corpus do I need to save?", "/fire"),
          true
        );
      });

      it("should return true for /holdings page path", () => {
        assert.strictEqual(
          shouldUseRAG("What is the current market value?", "/holdings"),
          true
        );
      });

      it("should return true for /analysis page path", () => {
        assert.strictEqual(
          shouldUseRAG("What is the PE ratio of this company?", "/analysis"),
          true
        );
      });

      it("should return true for /tradebook page path", () => {
        assert.strictEqual(
          shouldUseRAG("Show me the most recent entry here", "/tradebook"),
          true
        );
      });

      it("should return true for /documents page path", () => {
        assert.strictEqual(
          shouldUseRAG("What is in this file that was uploaded?", "/documents"),
          true
        );
      });

      it("should not trigger on non-context page paths", () => {
        assert.strictEqual(
          shouldUseRAG(
            "Tell me something interesting and fun now",
            "/settings"
          ),
          false
        );
      });
    });

    describe("Substantive query length (> 50 chars)", () => {
      it("should return true for long query without keywords on non-context page", () => {
        const longQuery =
          "Can you explain how the general economic conditions affect growth?";
        assert.ok(longQuery.length > 50);
        assert.strictEqual(shouldUseRAG(longQuery, "/settings"), true);
      });

      it("should return false for medium query without keywords (15-50 chars)", () => {
        const mediumQuery = "Tell me about something fun!"; // ~28 chars
        assert.ok(mediumQuery.length >= 15 && mediumQuery.length <= 50);
        assert.strictEqual(shouldUseRAG(mediumQuery, "/settings"), false);
      });
    });

    describe("New document-related keywords", () => {
      it("should return true for 'document' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Show me my document from last week", "/dashboard"),
          true
        );
      });

      it("should return true for 'uploaded' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("What was uploaded yesterday?", "/dashboard"),
          true
        );
      });

      it("should return true for 'report' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Generate a tax report for FY24", "/dashboard"),
          true
        );
      });

      it("should return true for 'statement' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("My broker statement shows discrepancy", "/dashboard"),
          true
        );
      });

      it("should return true for 'contract note' keyword", () => {
        assert.strictEqual(
          shouldUseRAG("Check my contract note from Zerodha", "/dashboard"),
          true
        );
      });
    });
  });

  // ───────────────────── mergeContexts ─────────────────────

  describe("mergeContexts", () => {
    it("should merge both RAG and existing context", () => {
      const result = mergeContexts("RAG data here", "Existing page data");
      assert.ok(result.includes("## Current Page Data"));
      assert.ok(result.includes("Existing page data"));
      assert.ok(result.includes("## Relevant Historical Data"));
      assert.ok(result.includes("RAG data here"));
    });

    it("should include only RAG context when no existing context", () => {
      const result = mergeContexts("RAG data here");
      assert.ok(!result.includes("## Current Page Data"));
      assert.ok(result.includes("## Relevant Historical Data"));
      assert.ok(result.includes("RAG data here"));
    });

    it("should include only existing context when RAG is empty", () => {
      const result = mergeContexts("", "Existing page data");
      assert.ok(result.includes("## Current Page Data"));
      assert.ok(result.includes("Existing page data"));
      assert.ok(!result.includes("## Relevant Historical Data"));
    });

    it("should return empty string when both are empty", () => {
      const result = mergeContexts("", undefined);
      assert.strictEqual(result, "");
    });

    it("should return empty string when both are empty strings", () => {
      const result = mergeContexts("", "");
      assert.strictEqual(result, "");
    });

    it("should put existing context before RAG context", () => {
      const result = mergeContexts("RAG data", "Page data");
      const pageDataIndex = result.indexOf("Page data");
      const ragDataIndex = result.indexOf("RAG data");
      assert.ok(pageDataIndex < ragDataIndex);
    });

    it("should separate sections with double newlines", () => {
      const result = mergeContexts("RAG data", "Page data");
      assert.ok(result.includes("\n\n"));
    });
  });

  // ───────────────────── summarizeRetrievedContext ─────────────────────

  describe("summarizeRetrievedContext", () => {
    it("should return empty object for empty documents", () => {
      const context = createMockRAGContext({ documents: [] });
      const summary = summarizeRetrievedContext(context);
      assert.deepStrictEqual(summary, {});
    });

    it("should count single document type", () => {
      const context = createMockRAGContext({
        documents: [
          createMockRetrievedDocument({ docType: "holdings" }),
          createMockRetrievedDocument({ docType: "holdings" }),
        ],
      });
      const summary = summarizeRetrievedContext(context);
      assert.deepStrictEqual(summary, { holdings: 2 });
    });

    it("should count multiple document types", () => {
      const context = createMockRAGContext({
        documents: [
          createMockRetrievedDocument({ docType: "holdings" }),
          createMockRetrievedDocument({ docType: "trades" }),
          createMockRetrievedDocument({ docType: "holdings" }),
          createMockRetrievedDocument({ docType: "fire_scenario" }),
        ],
      });
      const summary = summarizeRetrievedContext(context);
      assert.deepStrictEqual(summary, {
        holdings: 2,
        trades: 1,
        fire_scenario: 1,
      });
    });

    it("should handle single document", () => {
      const context = createMockRAGContext({
        documents: [createMockRetrievedDocument({ docType: "analysis" })],
      });
      const summary = summarizeRetrievedContext(context);
      assert.deepStrictEqual(summary, { analysis: 1 });
    });

    it("should handle all six document types", () => {
      const context = createMockRAGContext({
        documents: [
          createMockRetrievedDocument({ docType: "holdings" }),
          createMockRetrievedDocument({ docType: "trades" }),
          createMockRetrievedDocument({ docType: "fire_scenario" }),
          createMockRetrievedDocument({ docType: "analysis" }),
          createMockRetrievedDocument({ docType: "user_preferences" }),
          createMockRetrievedDocument({ docType: "document" }),
        ],
      });
      const summary = summarizeRetrievedContext(context);
      assert.deepStrictEqual(summary, {
        holdings: 1,
        trades: 1,
        fire_scenario: 1,
        analysis: 1,
        user_preferences: 1,
        document: 1,
      });
    });
  });

  // ───────────────────── getDocTypesForPage ─────────────────────

  describe("getDocTypesForPage", () => {
    it("should return fire types for /fire path", () => {
      const result = getDocTypesForPage("/fire");
      assert.deepStrictEqual(result, [
        "fire_scenario",
        "holdings",
        "user_preferences",
      ]);
    });

    it("should return fire types for /retirement path", () => {
      const result = getDocTypesForPage("/retirement");
      assert.deepStrictEqual(result, [
        "fire_scenario",
        "holdings",
        "user_preferences",
      ]);
    });

    it("should return fire types for path containing 'fire'", () => {
      const result = getDocTypesForPage("/fire/scenarios");
      assert.deepStrictEqual(result, [
        "fire_scenario",
        "holdings",
        "user_preferences",
      ]);
    });

    it("should be case-insensitive for fire", () => {
      const result = getDocTypesForPage("/FIRE/calculator");
      assert.deepStrictEqual(result, [
        "fire_scenario",
        "holdings",
        "user_preferences",
      ]);
    });

    it("should return holdings types for /holdings path", () => {
      const result = getDocTypesForPage("/holdings");
      assert.deepStrictEqual(result, ["holdings", "trades", "analysis"]);
    });

    it("should return holdings types for /portfolio path", () => {
      const result = getDocTypesForPage("/portfolio");
      assert.deepStrictEqual(result, ["holdings", "trades", "analysis"]);
    });

    it("should return trade types for /tradebook path", () => {
      const result = getDocTypesForPage("/tradebook");
      assert.deepStrictEqual(result, ["trades", "holdings"]);
    });

    it("should return trade types for /trade path", () => {
      const result = getDocTypesForPage("/trade");
      assert.deepStrictEqual(result, ["trades", "holdings"]);
    });

    it("should return trade types for /journal path", () => {
      const result = getDocTypesForPage("/journal");
      assert.deepStrictEqual(result, ["trades", "holdings"]);
    });

    it("should return analysis + financial-doc types for /analysis path", () => {
      // Real source (post stock-RAG expansion) includes the financial document
      // types so stock-analysis pages pull filings/statements into context.
      const result = getDocTypesForPage("/analysis");
      assert.deepStrictEqual(result, [
        "analysis",
        "holdings",
        "financial_statement",
        "corporate_filing",
        "annual_report",
        "quarterly_result",
      ]);
    });

    it("should return analysis + financial-doc types for /stock path", () => {
      const result = getDocTypesForPage("/stock/RELIANCE");
      assert.deepStrictEqual(result, [
        "analysis",
        "holdings",
        "financial_statement",
        "corporate_filing",
        "annual_report",
        "quarterly_result",
      ]);
    });

    it("should return dashboard types for /dashboard path", () => {
      const result = getDocTypesForPage("/dashboard");
      assert.deepStrictEqual(result, ["holdings", "trades", "fire_scenario"]);
    });

    it("should return document types for /documents path", () => {
      const result = getDocTypesForPage("/documents");
      assert.deepStrictEqual(result, ["document", "holdings", "trades"]);
    });

    it("should return empty array for unknown path", () => {
      const result = getDocTypesForPage("/settings");
      assert.deepStrictEqual(result, []);
    });

    it("should return empty array for root path", () => {
      const result = getDocTypesForPage("/");
      assert.deepStrictEqual(result, []);
    });

    it("should return empty array for /about path", () => {
      const result = getDocTypesForPage("/about");
      assert.deepStrictEqual(result, []);
    });

    it("should prioritize fire over other matches for /fire-holdings", () => {
      // 'fire' check comes first, so even if 'holdings' is in the path, fire wins
      const result = getDocTypesForPage("/fire-holdings");
      assert.deepStrictEqual(result, [
        "fire_scenario",
        "holdings",
        "user_preferences",
      ]);
    });
  });

  // ───────────────────── fitToTokenBudget ─────────────────────

  describe("fitToTokenBudget", () => {
    it("should include all documents when within budget", () => {
      const results = [
        createMockSearchResult({ content: "Short content" }), // ~4 tokens + 50 overhead = ~54
        createMockSearchResult({ content: "Another short" }), // ~4 tokens + 50 overhead = ~54
      ];
      const { documents, tokenEstimate } = fitToTokenBudget(results, 2000, 5);
      assert.strictEqual(documents.length, 2);
      assert.ok(tokenEstimate > 0);
      assert.ok(tokenEstimate <= 2000);
    });

    it("should return empty when no results", () => {
      const { documents, tokenEstimate } = fitToTokenBudget([], 2000, 5);
      assert.strictEqual(documents.length, 0);
      assert.strictEqual(tokenEstimate, 0);
    });

    it("should respect maxDocuments limit", () => {
      const results = [
        createMockSearchResult({ content: "Doc 1" }),
        createMockSearchResult({ content: "Doc 2" }),
        createMockSearchResult({ content: "Doc 3" }),
      ];
      const { documents } = fitToTokenBudget(results, 10000, 2);
      assert.strictEqual(documents.length, 2);
    });

    it("should truncate first document when it exceeds budget", () => {
      // Create a very large document that exceeds budget
      const bigContent = "A".repeat(10000); // 2500 tokens + 50 overhead > 100 max
      const results = [createMockSearchResult({ content: bigContent })];
      const { documents, tokenEstimate } = fitToTokenBudget(results, 100, 5);
      assert.strictEqual(documents.length, 1);
      assert.ok(documents[0].content.endsWith("..."));
      assert.ok(documents[0].content.length < bigContent.length);
      assert.strictEqual(tokenEstimate, 100); // set to maxTokens
    });

    it("should not include second document that exceeds remaining budget", () => {
      const results = [
        createMockSearchResult({ content: "A".repeat(200) }), // 50 tokens + 50 overhead = 100
        createMockSearchResult({ content: "B".repeat(200) }), // 50 tokens + 50 overhead = 100
      ];
      // Budget only allows ~1 document
      const { documents } = fitToTokenBudget(results, 120, 5);
      assert.strictEqual(documents.length, 1);
      assert.ok(documents[0].content.includes("A"));
    });

    it("should preserve metadata in output documents", () => {
      const results = [
        createMockSearchResult({
          content: "Small",
          metadata: { symbol: "RELIANCE" },
        }),
      ];
      const { documents } = fitToTokenBudget(results, 2000, 5);
      assert.strictEqual(documents.length, 1);
      assert.deepStrictEqual(documents[0].metadata, { symbol: "RELIANCE" });
    });

    it("should preserve docType and score in output", () => {
      const results = [
        createMockSearchResult({
          content: "Test",
          docType: "trades",
          score: 0.92,
        }),
      ];
      const { documents } = fitToTokenBudget(results, 2000, 5);
      assert.strictEqual(documents[0].docType, "trades");
      assert.strictEqual(documents[0].score, 0.92);
    });

    it("should calculate token estimate using CHARS_PER_TOKEN = 4", () => {
      // content with exactly 40 chars = 10 tokens + 50 overhead = 60
      const results = [createMockSearchResult({ content: "A".repeat(40) })];
      const { tokenEstimate } = fitToTokenBudget(results, 2000, 5);
      assert.strictEqual(tokenEstimate, 60); // 10 + 50
    });

    it("should handle maxTokens of 0", () => {
      const results = [createMockSearchResult({ content: "Test" })];
      const { documents } = fitToTokenBudget(results, 0, 5);
      // First doc would have contentTokens + 50 overhead > 0,
      // so it tries to truncate as first doc: availableChars = (0 - 50) * 4 = -200
      // slice(0, -200) returns empty string, but still pushed with "..."
      assert.strictEqual(documents.length, 1);
      assert.strictEqual(documents[0].content, "...");
    });

    it("should handle maxDocuments of 0", () => {
      const results = [createMockSearchResult({ content: "Test" })];
      const { documents } = fitToTokenBudget(results, 2000, 0);
      assert.strictEqual(documents.length, 0);
    });
  });

  // ───────────────────── formatContextForPrompt ─────────────────────

  describe("formatContextForPrompt", () => {
    it("should return empty string for empty documents", () => {
      const result = formatContextForPrompt([], false);
      assert.strictEqual(result, "");
    });

    it("should format single document with correct label", () => {
      const docs = [
        createMockRetrievedDocument({
          docType: "holdings",
          content: "RELIANCE: 50 shares",
        }),
      ];
      const result = formatContextForPrompt(docs, false);
      assert.ok(result.includes("### Portfolio Holdings"));
      assert.ok(result.includes("RELIANCE: 50 shares"));
    });

    it("should use correct labels for all document types", () => {
      const allTypes: DocumentType[] = [
        "holdings",
        "trades",
        "fire_scenario",
        "analysis",
        "user_preferences",
      ];
      for (const docType of allTypes) {
        const docs = [
          createMockRetrievedDocument({ docType, content: "test" }),
        ];
        const result = formatContextForPrompt(docs, false);
        assert.ok(result.includes(`### ${DOC_TYPE_LABELS[docType]}`));
      }
    });

    it("should include relevance scores when includeScores is true", () => {
      const docs = [
        createMockRetrievedDocument({ score: 0.85, content: "Test" }),
      ];
      const result = formatContextForPrompt(docs, true);
      assert.ok(result.includes("[Relevance: 85%]"));
    });

    it("should not include relevance scores when includeScores is false", () => {
      const docs = [
        createMockRetrievedDocument({ score: 0.85, content: "Test" }),
      ];
      const result = formatContextForPrompt(docs, false);
      assert.ok(!result.includes("[Relevance:"));
    });

    it("should group documents by type", () => {
      const docs = [
        createMockRetrievedDocument({
          docType: "holdings",
          content: "Holding 1",
        }),
        createMockRetrievedDocument({
          docType: "trades",
          content: "Trade 1",
        }),
        createMockRetrievedDocument({
          docType: "holdings",
          content: "Holding 2",
        }),
      ];
      const result = formatContextForPrompt(docs, false);
      // Holdings should be grouped together
      const holdingsSection = result.indexOf("### Portfolio Holdings");
      const tradesSection = result.indexOf("### Trading Activity");
      assert.ok(holdingsSection >= 0);
      assert.ok(tradesSection >= 0);
      // Both holdings should appear before trades section
      assert.ok(result.indexOf("Holding 1") < tradesSection);
      assert.ok(result.indexOf("Holding 2") < tradesSection);
    });

    it("should separate sections with double newlines", () => {
      const docs = [
        createMockRetrievedDocument({ docType: "holdings", content: "H1" }),
        createMockRetrievedDocument({ docType: "trades", content: "T1" }),
      ];
      const result = formatContextForPrompt(docs, false);
      assert.ok(result.includes("\n\n"));
    });

    it("should format score as integer percentage", () => {
      const docs = [
        createMockRetrievedDocument({ score: 0.756, content: "Test" }),
      ];
      const result = formatContextForPrompt(docs, true);
      assert.ok(result.includes("[Relevance: 76%]"));
    });

    it("should handle score of 1.0", () => {
      const docs = [
        createMockRetrievedDocument({ score: 1.0, content: "Test" }),
      ];
      const result = formatContextForPrompt(docs, true);
      assert.ok(result.includes("[Relevance: 100%]"));
    });

    it("should handle score of 0.0", () => {
      const docs = [
        createMockRetrievedDocument({ score: 0.0, content: "Test" }),
      ];
      const result = formatContextForPrompt(docs, true);
      assert.ok(result.includes("[Relevance: 0%]"));
    });
  });

  // ───────────────────── contentFingerprint ─────────────────────

  describe("contentFingerprint", () => {
    it("should normalize whitespace", () => {
      const fp1 = contentFingerprint("hello   world");
      const fp2 = contentFingerprint("hello world");
      assert.strictEqual(fp1, fp2);
    });

    it("should be case-insensitive", () => {
      const fp1 = contentFingerprint("RELIANCE Holdings");
      const fp2 = contentFingerprint("reliance holdings");
      assert.strictEqual(fp1, fp2);
    });

    it("should truncate to 200 chars", () => {
      const longContent = "A".repeat(500);
      const fp = contentFingerprint(longContent);
      assert.strictEqual(fp.length, 200);
    });

    it("should trim leading/trailing whitespace", () => {
      const fp1 = contentFingerprint("  hello world  ");
      const fp2 = contentFingerprint("hello world");
      assert.strictEqual(fp1, fp2);
    });

    it("should treat tab/newline as whitespace", () => {
      const fp1 = contentFingerprint("hello\tworld\nfoo");
      const fp2 = contentFingerprint("hello world foo");
      assert.strictEqual(fp1, fp2);
    });
  });

  // ───────────────────── fitToTokenBudget deduplication ─────────────────────

  describe("fitToTokenBudget - deduplication", () => {
    it("should skip exact duplicate content", () => {
      const results = [
        createMockSearchResult({ content: "RELIANCE: 50 shares", score: 0.9 }),
        createMockSearchResult({ content: "RELIANCE: 50 shares", score: 0.85 }),
        createMockSearchResult({ content: "TCS: 100 shares", score: 0.8 }),
      ];
      const { documents } = fitToTokenBudget(results, 10000, 5);
      assert.strictEqual(documents.length, 2);
      assert.ok(documents[0].content.includes("RELIANCE"));
      assert.ok(documents[1].content.includes("TCS"));
    });

    it("should skip near-duplicates with different whitespace", () => {
      const results = [
        createMockSearchResult({
          content: "RELIANCE:  50  shares",
          score: 0.9,
        }),
        createMockSearchResult({ content: "RELIANCE: 50 shares", score: 0.85 }),
      ];
      const { documents } = fitToTokenBudget(results, 10000, 5);
      assert.strictEqual(documents.length, 1);
    });

    it("should skip near-duplicates with different casing (first 200 chars)", () => {
      const results = [
        createMockSearchResult({
          content: "Reliance Industries Holdings",
          score: 0.9,
        }),
        createMockSearchResult({
          content: "reliance industries holdings",
          score: 0.8,
        }),
      ];
      const { documents } = fitToTokenBudget(results, 10000, 5);
      assert.strictEqual(documents.length, 1);
    });

    it("should keep documents with different first 200 chars", () => {
      const results = [
        createMockSearchResult({
          content: "RELIANCE: 50 shares @ 2450",
          score: 0.9,
        }),
        createMockSearchResult({
          content: "TCS: 100 shares @ 3800",
          score: 0.85,
        }),
        createMockSearchResult({
          content: "INFY: 200 shares @ 1500",
          score: 0.8,
        }),
      ];
      const { documents } = fitToTokenBudget(results, 10000, 5);
      assert.strictEqual(documents.length, 3);
    });

    it("should keep highest-scoring duplicate (first in sorted results)", () => {
      const results = [
        createMockSearchResult({ content: "Same content", score: 0.95 }),
        createMockSearchResult({ content: "Same content", score: 0.7 }),
      ];
      const { documents } = fitToTokenBudget(results, 10000, 5);
      assert.strictEqual(documents.length, 1);
      assert.strictEqual(documents[0].score, 0.95);
    });

    it("should count deduplicated docs toward maxDocuments correctly", () => {
      const results = [
        createMockSearchResult({ content: "Doc A", score: 0.9 }),
        createMockSearchResult({ content: "Doc A", score: 0.85 }), // duplicate
        createMockSearchResult({ content: "Doc B", score: 0.8 }),
        createMockSearchResult({ content: "Doc C", score: 0.7 }),
      ];
      const { documents } = fitToTokenBudget(results, 10000, 2);
      // Only 2 unique docs allowed: Doc A + Doc B
      assert.strictEqual(documents.length, 2);
      assert.ok(documents[0].content.includes("Doc A"));
      assert.ok(documents[1].content.includes("Doc B"));
    });
  });
});
