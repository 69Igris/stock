/**
 * Gemini Embeddings Tests
 *
 * Tests for the vector embedding utilities used by RAG: text chunking,
 * document formatters, token estimation, cosine similarity, and model info.
 *
 * Tests cover:
 * - chunkText: splitting long text into overlapping chunks
 * - formatHoldingsForEmbedding: portfolio holdings -> embedding string
 * - formatTradesForEmbedding: trade activity -> embedding string
 * - formatFireScenarioForEmbedding: FIRE scenario -> embedding string
 * - formatAnalysisForEmbedding: stock analysis -> embedding string
 * - estimateTokenCount: token estimation (text.length / 4)
 * - cosineSimilarity: cosine similarity between two vectors
 * - getEmbeddingModelInfo: model metadata
 * - truncateToTokenLimit: text truncation at token boundary
 *
 * The pure functions are reimplemented inline because the source module
 * (embeddings.ts) has side-effecting imports (@usemoney/logger, google-auth)
 * that aren't available in the unit test environment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL embeddings.ts exports. Importing the
// module is side-effect-free (google-auth-library is dynamically imported only
// inside the network helper). The previous inline copy also CARRIED a bug fix
// the real source lacked — chunkText could loop forever for overlap >
// chunkSize/2; that guard is now in the source itself and regression-tested.
import {
  estimateTokenCount,
  truncateToTokenLimit,
  cosineSimilarity,
  getEmbeddingModelInfo,
  chunkText,
  formatHoldingsForEmbedding,
  formatTradesForEmbedding,
  formatFireScenarioForEmbedding,
  formatAnalysisForEmbedding,
} from "@/lib/gemini/embeddings";

// ─────────────────────────────────────────────────────────────────────────────
// Constants used only to build expected values in assertions (mirror source).
// ─────────────────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIMENSIONS = 768;
const MAX_TOKENS_PER_REQUEST = 2048;
const CHARS_PER_TOKEN = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Local type definitions
// ─────────────────────────────────────────────────────────────────────────────

interface ChunkedText {
  text: string;
  chunkIndex: number;
  originalLength: number;
}

interface HoldingInput {
  symbol: string;
  name?: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  pnlPercentage: number;
  sector?: string;
  broker?: string;
}

interface TradeInput {
  symbol: string;
  tradeType: string;
  quantity: number;
  price: number;
  tradeDate: Date;
  realizedPnL?: number;
  broker?: string;
}

interface FireScenarioInput {
  name: string;
  description?: string;
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  withdrawalRate: number;
  fireNumber?: number;
  yearsToFire?: number;
}

interface AnalysisInput {
  symbol: string;
  name?: string;
  recommendation: string;
  confidence?: number;
  targetPrice?: number;
  stopLoss?: number;
  strengths?: string[];
  weaknesses?: string[];
  commentary?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory functions
// ─────────────────────────────────────────────────────────────────────────────

function createMockHolding(
  overrides: Partial<HoldingInput> = {}
): HoldingInput {
  return {
    symbol: "RELIANCE",
    quantity: 10,
    averagePrice: 2400,
    currentPrice: 2600,
    pnlPercentage: 8.33,
    ...overrides,
  };
}

function createMockTrade(overrides: Partial<TradeInput> = {}): TradeInput {
  return {
    symbol: "TCS",
    tradeType: "BUY",
    quantity: 5,
    price: 3500,
    tradeDate: new Date("2024-06-15"),
    ...overrides,
  };
}

function createMockFireScenario(
  overrides: Partial<FireScenarioInput> = {}
): FireScenarioInput {
  return {
    name: "Early Retirement",
    currentAge: 30,
    retirementAge: 50,
    lifeExpectancy: 85,
    currentCorpus: 5000000,
    monthlySavings: 100000,
    withdrawalRate: 4,
    ...overrides,
  };
}

function createMockAnalysis(
  overrides: Partial<AnalysisInput> = {}
): AnalysisInput {
  return {
    symbol: "INFY",
    recommendation: "BUY",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Gemini Embeddings", () => {
  // ───────────────────── estimateTokenCount ─────────────────────

  describe("estimateTokenCount", () => {
    it("should estimate 1 token for 4 characters", () => {
      assert.strictEqual(estimateTokenCount("abcd"), 1);
    });

    it("should estimate 2 tokens for 8 characters", () => {
      assert.strictEqual(estimateTokenCount("abcdefgh"), 2);
    });

    it("should round up for 5 characters", () => {
      assert.strictEqual(estimateTokenCount("abcde"), 2);
    });

    it("should return 0 for empty string", () => {
      assert.strictEqual(estimateTokenCount(""), 0);
    });

    it("should return 1 for single character", () => {
      assert.strictEqual(estimateTokenCount("x"), 1);
    });

    it("should handle very long text", () => {
      assert.strictEqual(estimateTokenCount("A".repeat(10000)), 2500);
    });

    it("should handle 3 characters as 1 token", () => {
      assert.strictEqual(estimateTokenCount("abc"), 1);
    });

    it("should handle text with whitespace", () => {
      assert.strictEqual(estimateTokenCount("a b c"), 2); // 5 chars
    });
  });

  // ───────────────────── cosineSimilarity ─────────────────────

  describe("cosineSimilarity", () => {
    it("should return 1 for identical vectors", () => {
      const v = [1, 2, 3, 4, 5];
      const result = cosineSimilarity(v, v);
      assert.ok(Math.abs(result - 1) < 1e-10);
    });

    it("should return 1 for proportional vectors", () => {
      const a = [1, 2, 3];
      const b = [2, 4, 6];
      const result = cosineSimilarity(a, b);
      assert.ok(Math.abs(result - 1) < 1e-10);
    });

    it("should return -1 for opposite vectors", () => {
      const a = [1, 2, 3];
      const b = [-1, -2, -3];
      const result = cosineSimilarity(a, b);
      assert.ok(Math.abs(result - -1) < 1e-10);
    });

    it("should return 0 for orthogonal vectors", () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      const result = cosineSimilarity(a, b);
      assert.ok(Math.abs(result) < 1e-10);
    });

    it("should return 0 for zero vector a", () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      const result = cosineSimilarity(a, b);
      assert.strictEqual(result, 0);
    });

    it("should return 0 for zero vector b", () => {
      const a = [1, 2, 3];
      const b = [0, 0, 0];
      const result = cosineSimilarity(a, b);
      assert.strictEqual(result, 0);
    });

    it("should return 0 for both zero vectors", () => {
      const result = cosineSimilarity([0, 0], [0, 0]);
      assert.strictEqual(result, 0);
    });

    it("should throw for different-length vectors", () => {
      assert.throws(() => {
        cosineSimilarity([1, 2, 3], [1, 2]);
      }, /same length/);
    });

    it("should throw for empty vs non-empty vectors", () => {
      assert.throws(() => {
        cosineSimilarity([], [1]);
      }, /same length/);
    });

    it("should handle single-element vectors", () => {
      const result = cosineSimilarity([5], [3]);
      assert.ok(Math.abs(result - 1) < 1e-10);
    });

    it("should handle negative single-element vectors", () => {
      const result = cosineSimilarity([5], [-3]);
      assert.ok(Math.abs(result - -1) < 1e-10);
    });

    it("should handle large vectors", () => {
      const a = Array.from({ length: 768 }, (_, i) => Math.sin(i));
      const b = Array.from({ length: 768 }, (_, i) => Math.cos(i));
      const result = cosineSimilarity(a, b);
      // Just check it's a valid cosine similarity value
      assert.ok(result >= -1 && result <= 1);
    });

    it("should be commutative (a,b) == (b,a)", () => {
      const a = [1, 3, 5, 7];
      const b = [2, 4, 6, 8];
      assert.ok(
        Math.abs(cosineSimilarity(a, b) - cosineSimilarity(b, a)) < 1e-10
      );
    });

    it("should return high similarity for similar vectors", () => {
      const a = [1, 2, 3, 4, 5];
      const b = [1.1, 2.1, 3.1, 4.1, 5.1];
      const result = cosineSimilarity(a, b);
      assert.ok(result > 0.99);
    });

    it("should return lower similarity for less similar vectors", () => {
      const a = [1, 0, 0, 0];
      const b = [1, 1, 0, 0];
      const result = cosineSimilarity(a, b);
      // cos(45 degrees) ~= 0.707
      assert.ok(result > 0.7 && result < 0.72);
    });

    it("should handle empty vectors (both empty)", () => {
      // Two empty vectors have length 0, which is equal, so no throw
      const result = cosineSimilarity([], []);
      // magnitude = 0, so returns 0
      assert.strictEqual(result, 0);
    });

    it("should handle vectors with very small values", () => {
      const a = [1e-10, 1e-10];
      const b = [1e-10, 1e-10];
      const result = cosineSimilarity(a, b);
      assert.ok(Math.abs(result - 1) < 1e-5);
    });
  });

  // ───────────────────── chunkText ─────────────────────

  describe("chunkText", () => {
    it("should return single chunk for short text", () => {
      const text = "Short text.";
      const result = chunkText(text);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].text, "Short text.");
      assert.strictEqual(result[0].chunkIndex, 0);
      assert.strictEqual(result[0].originalLength, text.length);
    });

    it("should return single chunk when text equals max size", () => {
      const text = "x".repeat(512 * 4); // exactly maxChunkChars
      const result = chunkText(text, 512);
      assert.strictEqual(result.length, 1);
    });

    it("should split text exceeding max chunk size", () => {
      // Create text that exceeds 512 * 4 = 2048 chars
      const text = "A".repeat(3000);
      const result = chunkText(text, 512, 50);
      assert.ok(result.length > 1);
    });

    it("should set correct chunkIndex for each chunk", () => {
      const text = "A".repeat(5000);
      const result = chunkText(text, 512, 50);
      for (let i = 0; i < result.length; i++) {
        assert.strictEqual(result[i].chunkIndex, i);
      }
    });

    it("should set originalLength for all chunks", () => {
      const text = "B".repeat(5000);
      const result = chunkText(text, 512, 50);
      for (const chunk of result) {
        assert.strictEqual(chunk.originalLength, 5000);
      }
    });

    it("should handle overlap between chunks", () => {
      // With overlap, chunks should share some content
      // Use sentences so we can trace overlap
      const sentences = Array.from(
        { length: 30 },
        (_, i) => `Sentence ${i} has some content here.`
      );
      const text = sentences.join(" ");
      const result = chunkText(text, 100, 20); // small chunks with overlap
      assert.ok(result.length > 1);
      // All chunks should be non-empty
      for (const chunk of result) {
        assert.ok(chunk.text.length > 0);
      }
    });

    it("should try to break at sentence boundaries", () => {
      // Create text with clear sentence boundaries
      const text =
        "First sentence here. Second sentence here. Third sentence is a bit longer to make more tokens. " +
        "Fourth sentence. Fifth sentence is also rather long to fill up the chunk budget. " +
        "Sixth sentence. Seventh sentence wraps things up nicely for the test.";
      const result = chunkText(text, 30, 5); // ~120 chars per chunk
      // Each chunk should tend to end near a period
      for (const chunk of result) {
        assert.ok(chunk.text.length > 0);
      }
    });

    it("should handle empty text", () => {
      const result = chunkText("");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].text, "");
    });

    it("should handle custom maxChunkTokens", () => {
      const text = "A".repeat(500);
      const result = chunkText(text, 50, 10); // 50 tokens = 200 chars per chunk
      assert.ok(result.length > 1);
    });

    it("should handle zero overlap", () => {
      const text = "A".repeat(5000);
      const result = chunkText(text, 512, 0);
      assert.ok(result.length > 1);
    });

    it("should produce non-empty trimmed chunks", () => {
      const text = "Word. ".repeat(1000);
      const result = chunkText(text, 100, 20);
      for (const chunk of result) {
        assert.ok(chunk.text.length > 0);
        assert.strictEqual(chunk.text, chunk.text.trim());
      }
    });

    it("should terminate when overlap exceeds chunk size (no infinite loop)", () => {
      // Regression: overlap (60) > chunkSize/2 (50) made `end - overlapChars`
      // move start backwards, looping forever. The source now guards this.
      const text = "x".repeat(5000); // > 100*4 chars, forces multiple chunks
      const result = chunkText(text, 100, 60);
      assert.ok(result.length > 1);
      // Indices are strictly increasing (start always advances).
      for (let i = 0; i < result.length; i++) {
        assert.strictEqual(result[i]!.chunkIndex, i);
      }
    });

    it("should terminate with overlap equal to chunk size", () => {
      const text = "y".repeat(3000);
      const result = chunkText(text, 50, 50);
      assert.ok(result.length >= 1);
    });
  });

  // ───────────────────── truncateToTokenLimit ─────────────────────

  describe("truncateToTokenLimit", () => {
    it("should return text unchanged when under limit", () => {
      const text = "Short text.";
      assert.strictEqual(truncateToTokenLimit(text), text);
    });

    it("should return text unchanged when exactly at limit", () => {
      const text = "x".repeat(MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN);
      assert.strictEqual(truncateToTokenLimit(text), text);
    });

    it("should truncate text exceeding limit", () => {
      const text = "A".repeat(MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN + 100);
      const result = truncateToTokenLimit(text);
      assert.ok(result.length <= MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN);
    });

    it("should try to break at sentence boundary when available", () => {
      const padding = "A".repeat(
        MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN - 100
      );
      const text =
        padding + ". More text after the period that goes over limit.";
      const result = truncateToTokenLimit(text);
      // Should end at or after the period
      assert.ok(result.length <= MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN);
    });

    it("should use custom maxTokens", () => {
      const text = "A".repeat(500);
      const result = truncateToTokenLimit(text, 50); // 50 * 4 = 200 chars
      assert.strictEqual(result.length, 200);
    });

    it("should handle empty string", () => {
      assert.strictEqual(truncateToTokenLimit(""), "");
    });

    it("should handle text with no periods", () => {
      const text = "A".repeat(MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN + 500);
      const result = truncateToTokenLimit(text);
      // No period to break at, so just truncates at max chars
      assert.strictEqual(
        result.length,
        MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN
      );
    });

    it("should not break at a period that is too early in the text", () => {
      // Period at position 10 (very early), text is much longer
      const text =
        "Early stop." +
        "A".repeat(MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN + 100);
      const result = truncateToTokenLimit(text);
      // Period at position 10 is < 80% of max chars, so won't break there
      assert.strictEqual(
        result.length,
        MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN
      );
    });
  });

  // ───────────────────── formatHoldingsForEmbedding ─────────────────────

  describe("formatHoldingsForEmbedding", () => {
    it("should return empty string for empty holdings", () => {
      assert.strictEqual(formatHoldingsForEmbedding([]), "");
    });

    it("should include Portfolio Holdings Summary header", () => {
      const result = formatHoldingsForEmbedding([createMockHolding()]);
      assert.ok(result.includes("Portfolio Holdings Summary:"));
    });

    it("should format single holding correctly", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({
          symbol: "TCS",
          name: "Tata Consultancy",
          quantity: 5,
          averagePrice: 3400,
          currentPrice: 3600,
          pnlPercentage: 5.88,
        }),
      ]);
      assert.ok(result.includes("TCS"));
      assert.ok(result.includes("Tata Consultancy"));
      assert.ok(result.includes("5 shares"));
      assert.ok(result.includes("+5.9%"));
    });

    it("should group holdings by sector", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({ symbol: "TCS", sector: "IT" }),
        createMockHolding({ symbol: "HDFCBANK", sector: "Banking" }),
        createMockHolding({ symbol: "INFY", sector: "IT" }),
      ]);
      assert.ok(result.includes("IT:"));
      assert.ok(result.includes("Banking:"));
    });

    it("should use 'Other' for holdings without sector", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({ symbol: "ABC", sector: undefined }),
      ]);
      assert.ok(result.includes("Other:"));
    });

    it("should format negative P&L without plus sign", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({ pnlPercentage: -5.5 }),
      ]);
      assert.ok(result.includes("-5.5%"));
      assert.ok(!result.includes("+-5.5%"));
    });

    it("should format positive P&L with plus sign", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({ pnlPercentage: 10.0 }),
      ]);
      assert.ok(result.includes("+10.0%"));
    });

    it("should calculate total portfolio value", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({
          quantity: 10,
          currentPrice: 100,
          averagePrice: 90,
        }),
        createMockHolding({
          quantity: 5,
          currentPrice: 200,
          averagePrice: 180,
        }),
      ]);
      // Total value = 10*100 + 5*200 = 2000
      assert.ok(result.includes("Total Portfolio Value: 2000.00"));
    });

    it("should calculate total invested", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({
          quantity: 10,
          currentPrice: 100,
          averagePrice: 90,
        }),
        createMockHolding({
          quantity: 5,
          currentPrice: 200,
          averagePrice: 180,
        }),
      ]);
      // Total invested = 10*90 + 5*180 = 1800
      assert.ok(result.includes("Total Invested: 1800.00"));
    });

    it("should calculate overall P&L", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({
          quantity: 10,
          currentPrice: 100,
          averagePrice: 90,
          pnlPercentage: 11.1,
        }),
      ]);
      // P&L = (10*100) - (10*90) = 100
      assert.ok(result.includes("Overall P&L:"));
      assert.ok(result.includes("+100.00"));
    });

    it("should handle holdings without name", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({ symbol: "XYZ", name: undefined }),
      ]);
      assert.ok(result.includes("XYZ:"));
      assert.ok(!result.includes("(undefined)"));
    });

    it("should handle zero P&L percentage", () => {
      const result = formatHoldingsForEmbedding([
        createMockHolding({ pnlPercentage: 0 }),
      ]);
      assert.ok(result.includes("+0.0%"));
    });
  });

  // ───────────────────── formatTradesForEmbedding ─────────────────────

  describe("formatTradesForEmbedding", () => {
    it("should return empty string for empty trades", () => {
      assert.strictEqual(formatTradesForEmbedding([]), "");
    });

    it("should include Recent Trading Activity header", () => {
      const result = formatTradesForEmbedding([createMockTrade()]);
      assert.ok(result.includes("Recent Trading Activity:"));
    });

    it("should format single trade correctly", () => {
      const result = formatTradesForEmbedding([
        createMockTrade({
          symbol: "INFY",
          tradeType: "BUY",
          quantity: 10,
          price: 1500,
          tradeDate: new Date("2024-01-15"),
        }),
      ]);
      assert.ok(result.includes("INFY"));
      assert.ok(result.includes("1 buys"));
      assert.ok(result.includes("0 sells"));
      assert.ok(result.includes("2024-01-15"));
      assert.ok(result.includes("BUY 10 @ 1500.00"));
    });

    it("should group trades by symbol", () => {
      const result = formatTradesForEmbedding([
        createMockTrade({ symbol: "TCS" }),
        createMockTrade({ symbol: "INFY" }),
        createMockTrade({ symbol: "TCS", tradeType: "SELL" }),
      ]);
      assert.ok(result.includes("TCS:"));
      assert.ok(result.includes("INFY:"));
    });

    it("should count buys and sells separately", () => {
      const result = formatTradesForEmbedding([
        createMockTrade({ symbol: "TCS", tradeType: "BUY" }),
        createMockTrade({ symbol: "TCS", tradeType: "BUY" }),
        createMockTrade({ symbol: "TCS", tradeType: "SELL" }),
      ]);
      assert.ok(result.includes("2 buys"));
      assert.ok(result.includes("1 sells"));
    });

    it("should calculate realized P&L per symbol", () => {
      const result = formatTradesForEmbedding([
        createMockTrade({
          symbol: "TCS",
          tradeType: "SELL",
          realizedPnL: 5000,
        }),
        createMockTrade({
          symbol: "TCS",
          tradeType: "SELL",
          realizedPnL: -2000,
        }),
      ]);
      // Total: 5000 + (-2000) = 3000
      assert.ok(result.includes("+3000.00"));
    });

    it("should show negative P&L correctly", () => {
      const result = formatTradesForEmbedding([
        createMockTrade({
          symbol: "XYZ",
          tradeType: "SELL",
          realizedPnL: -1500,
        }),
      ]);
      assert.ok(result.includes("-1500.00"));
    });

    it("should sort trades by date descending", () => {
      const result = formatTradesForEmbedding([
        createMockTrade({
          symbol: "TCS",
          tradeDate: new Date("2024-01-01"),
        }),
        createMockTrade({
          symbol: "TCS",
          tradeDate: new Date("2024-06-01"),
        }),
        createMockTrade({
          symbol: "TCS",
          tradeDate: new Date("2024-03-01"),
        }),
      ]);
      const idx1 = result.indexOf("2024-06-01");
      const idx2 = result.indexOf("2024-03-01");
      const idx3 = result.indexOf("2024-01-01");
      assert.ok(idx1 < idx2);
      assert.ok(idx2 < idx3);
    });

    it("should limit to 5 trades per symbol", () => {
      const trades = Array.from({ length: 10 }, (_, i) =>
        createMockTrade({
          symbol: "TCS",
          tradeDate: new Date(`2024-${String(i + 1).padStart(2, "0")}-15`),
        })
      );
      const result = formatTradesForEmbedding(trades);
      // Count individual trade lines (starting with "  -")
      const tradeLines = result
        .split("\n")
        .filter((l) => l.trim().startsWith("-") && l.includes("@"));
      assert.ok(tradeLines.length <= 5);
    });

    it("should handle trades without realizedPnL", () => {
      const result = formatTradesForEmbedding([
        createMockTrade({ symbol: "ABC", realizedPnL: undefined }),
      ]);
      assert.ok(result.includes("+0.00"));
    });
  });

  // ───────────────────── formatFireScenarioForEmbedding ─────────────────────

  describe("formatFireScenarioForEmbedding", () => {
    it("should include scenario name", () => {
      const result = formatFireScenarioForEmbedding(
        createMockFireScenario({ name: "Lean FIRE" })
      );
      assert.ok(result.includes("FIRE Scenario: Lean FIRE"));
    });

    it("should include description when provided", () => {
      const result = formatFireScenarioForEmbedding(
        createMockFireScenario({ description: "My retirement plan" })
      );
      assert.ok(result.includes("Description: My retirement plan"));
    });

    it("should not include description when absent", () => {
      const result = formatFireScenarioForEmbedding(
        createMockFireScenario({ description: undefined })
      );
      assert.ok(!result.includes("Description:"));
    });

    it("should include personal details", () => {
      const result = formatFireScenarioForEmbedding(
        createMockFireScenario({
          currentAge: 28,
          retirementAge: 45,
          lifeExpectancy: 90,
        })
      );
      assert.ok(result.includes("Current Age: 28"));
      assert.ok(result.includes("Target Retirement Age: 45"));
      assert.ok(result.includes("Life Expectancy: 90"));
    });

    it("should include financial details", () => {
      const result = formatFireScenarioForEmbedding(
        createMockFireScenario({
          currentCorpus: 5000000,
          monthlySavings: 100000,
          withdrawalRate: 3.5,
        })
      );
      assert.ok(result.includes("Current Corpus:"));
      assert.ok(result.includes("Monthly Savings:"));
      assert.ok(result.includes("Safe Withdrawal Rate: 3.5%"));
    });

    it("should include calculated values when fireNumber is present", () => {
      const result = formatFireScenarioForEmbedding(
        createMockFireScenario({
          fireNumber: 30000000,
          yearsToFire: 15,
        })
      );
      assert.ok(result.includes("Calculated Values:"));
      assert.ok(result.includes("FIRE Number:"));
      assert.ok(result.includes("Years to FIRE: 15"));
    });

    it("should not include calculated values when fireNumber is absent", () => {
      const result = formatFireScenarioForEmbedding(
        createMockFireScenario({ fireNumber: undefined })
      );
      assert.ok(!result.includes("Calculated Values:"));
    });

    it("should include FIRE Number but not Years to FIRE when yearsToFire is undefined", () => {
      const result = formatFireScenarioForEmbedding(
        createMockFireScenario({
          fireNumber: 25000000,
          yearsToFire: undefined,
        })
      );
      assert.ok(result.includes("FIRE Number:"));
      assert.ok(!result.includes("Years to FIRE:"));
    });
  });

  // ───────────────────── formatAnalysisForEmbedding ─────────────────────

  describe("formatAnalysisForEmbedding", () => {
    it("should include stock symbol", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ symbol: "TCS" })
      );
      assert.ok(result.includes("Stock Analysis: TCS"));
    });

    it("should include company name when provided", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ name: "Infosys Ltd" })
      );
      assert.ok(result.includes("Company: Infosys Ltd"));
    });

    it("should not include company name when absent", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ name: undefined })
      );
      assert.ok(!result.includes("Company:"));
    });

    it("should include recommendation", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ recommendation: "BUY" })
      );
      assert.ok(result.includes("Recommendation: BUY"));
    });

    it("should include confidence when provided", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ confidence: 85 })
      );
      assert.ok(result.includes("Confidence: 85%"));
    });

    it("should not include confidence when zero (falsy)", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ confidence: 0 })
      );
      assert.ok(!result.includes("Confidence:"));
    });

    it("should include target price when provided", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ targetPrice: 1800 })
      );
      assert.ok(result.includes("Target Price: 1800"));
    });

    it("should include stop loss when provided", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ stopLoss: 1400 })
      );
      assert.ok(result.includes("Stop Loss: 1400"));
    });

    it("should include strengths when provided", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({
          strengths: ["Strong revenue growth", "High market share"],
        })
      );
      assert.ok(result.includes("Strengths:"));
      assert.ok(result.includes("- Strong revenue growth"));
      assert.ok(result.includes("- High market share"));
    });

    it("should not include strengths section when empty array", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ strengths: [] })
      );
      assert.ok(!result.includes("Strengths:"));
    });

    it("should include weaknesses when provided", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({
          weaknesses: ["High debt", "Declining margins"],
        })
      );
      assert.ok(result.includes("Weaknesses:"));
      assert.ok(result.includes("- High debt"));
    });

    it("should not include weaknesses section when empty array", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ weaknesses: [] })
      );
      assert.ok(!result.includes("Weaknesses:"));
    });

    it("should include commentary when provided", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ commentary: "Good long-term pick." })
      );
      assert.ok(result.includes("Commentary: Good long-term pick."));
    });

    it("should not include commentary when absent", () => {
      const result = formatAnalysisForEmbedding(
        createMockAnalysis({ commentary: undefined })
      );
      assert.ok(!result.includes("Commentary:"));
    });

    it("should format full analysis with all fields", () => {
      const result = formatAnalysisForEmbedding({
        symbol: "RELIANCE",
        name: "Reliance Industries",
        recommendation: "HOLD",
        confidence: 70,
        targetPrice: 2800,
        stopLoss: 2400,
        strengths: ["Diversified business"],
        weaknesses: ["Regulatory risk"],
        commentary: "Wait for better entry.",
      });
      assert.ok(result.includes("Stock Analysis: RELIANCE"));
      assert.ok(result.includes("Company: Reliance Industries"));
      assert.ok(result.includes("Recommendation: HOLD"));
      assert.ok(result.includes("Confidence: 70%"));
      assert.ok(result.includes("Target Price: 2800"));
      assert.ok(result.includes("Stop Loss: 2400"));
      assert.ok(result.includes("Strengths:"));
      assert.ok(result.includes("Weaknesses:"));
      assert.ok(result.includes("Commentary:"));
    });

    it("should format minimal analysis with only required fields", () => {
      const result = formatAnalysisForEmbedding({
        symbol: "TEST",
        recommendation: "SELL",
      });
      assert.ok(result.includes("Stock Analysis: TEST"));
      assert.ok(result.includes("Recommendation: SELL"));
      assert.ok(!result.includes("Company:"));
      assert.ok(!result.includes("Confidence:"));
      assert.ok(!result.includes("Target Price:"));
      assert.ok(!result.includes("Stop Loss:"));
      assert.ok(!result.includes("Strengths:"));
      assert.ok(!result.includes("Weaknesses:"));
      assert.ok(!result.includes("Commentary:"));
    });
  });

  // ───────────────────── getEmbeddingModelInfo ─────────────────────

  describe("getEmbeddingModelInfo", () => {
    it("should return correct model name", () => {
      const info = getEmbeddingModelInfo();
      assert.strictEqual(info.model, "text-embedding-004");
    });

    it("should return 768 dimensions", () => {
      const info = getEmbeddingModelInfo();
      assert.strictEqual(info.dimensions, 768);
    });

    it("should return 2048 maxTokens", () => {
      const info = getEmbeddingModelInfo();
      assert.strictEqual(info.maxTokens, 2048);
    });

    it("should return a consistent object", () => {
      const info1 = getEmbeddingModelInfo();
      const info2 = getEmbeddingModelInfo();
      assert.deepStrictEqual(info1, info2);
    });
  });

  // ───────────────────── Integration scenarios ─────────────────────

  describe("Integration scenarios", () => {
    it("should chunk and estimate tokens for formatted holdings", () => {
      const holdings = Array.from({ length: 20 }, (_, i) =>
        createMockHolding({
          symbol: `STOCK${i}`,
          name: `Company Number ${i}`,
          quantity: (i + 1) * 10,
          averagePrice: 100 + i * 10,
          currentPrice: 110 + i * 10,
          pnlPercentage: (10 / (100 + i * 10)) * 100,
          sector: i % 3 === 0 ? "IT" : i % 3 === 1 ? "Banking" : "Pharma",
        })
      );
      const formatted = formatHoldingsForEmbedding(holdings);
      assert.ok(formatted.length > 0);

      const tokens = estimateTokenCount(formatted);
      assert.ok(tokens > 0);

      if (formatted.length > 512 * CHARS_PER_TOKEN) {
        const chunks = chunkText(formatted, 512, 50);
        assert.ok(chunks.length > 1);
        for (const chunk of chunks) {
          assert.ok(chunk.text.length > 0);
        }
      }
    });

    it("should compute meaningful similarity between related embeddings", () => {
      // Simulate: two similar holdings descriptions should have vectors closer
      // than completely unrelated ones (we test the math, not actual embeddings)
      const similar1 = [0.5, 0.5, 0.1, 0.1, 0.8];
      const similar2 = [0.6, 0.4, 0.15, 0.1, 0.75];
      const different = [-0.5, -0.5, 0.9, 0.9, -0.8];

      const simScore = cosineSimilarity(similar1, similar2);
      const diffScore = cosineSimilarity(similar1, different);

      assert.ok(simScore > diffScore);
      assert.ok(simScore > 0.9);
      assert.ok(diffScore < 0);
    });

    it("should truncate very long formatted text before embedding", () => {
      // Create a large formatted string
      const trades = Array.from({ length: 50 }, (_, i) =>
        createMockTrade({
          symbol: `SYM${i % 10}`,
          tradeDate: new Date(
            `2024-${String((i % 12) + 1).padStart(2, "0")}-15`
          ),
          quantity: 10 + i,
          price: 100 + i * 5,
          realizedPnL: (i % 2 === 0 ? 1 : -1) * i * 10,
        })
      );
      const formatted = formatTradesForEmbedding(trades);
      const truncated = truncateToTokenLimit(formatted);
      assert.ok(truncated.length <= MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN);
    });
  });
});
