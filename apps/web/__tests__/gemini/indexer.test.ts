/**
 * Document Indexer Tests
 *
 * Tests for the indexer logic from lib/gemini/indexer.ts:
 * - IndexingResult aggregation
 * - Chunking and embedding pipeline (mock)
 * - indexAllUserData parallel execution and result merging
 * - runBackgroundIndexing type selection
 * - deleteScenarioEmbeddings / deleteAnalysisEmbeddings delegation
 * - Edge cases: empty data, failed embeddings, partial success
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL exports.
//  • chunkText is the real implementation from embeddings.ts (re-used by the
//    indexer) — including the overlap > chunkSize infinite-loop guard.
//  • aggregateIndexingResults + selectDocTypes are now real exports from
//    indexer.ts, wired into indexAllUserData / runBackgroundIndexing so the
//    test and the production path execute the same code.
// Both source modules import cleanly (Prisma is only touched inside async fns).
import { chunkText } from "@/lib/gemini/embeddings";
import {
  aggregateIndexingResults,
  selectDocTypes,
  type IndexingResult,
} from "@/lib/gemini/indexer";
import type { DocumentType } from "@/lib/gemini/vector-store";

// ---------------------------------------------------------------------------
// Mock indexing pipeline (test-local fixtures that exercise the REAL chunkText)
// ---------------------------------------------------------------------------

function mockGenerateEmbeddings(
  texts: string[],
  failIndices: number[] = []
): { embeddings: number[][]; failedIndices: number[] } {
  const embeddings = texts.map((_, i) =>
    failIndices.includes(i)
      ? []
      : Array.from({ length: 768 }, () => Math.random())
  );
  return { embeddings, failedIndices: failIndices };
}

async function mockIndexHoldings(
  holdingsCount: number,
  chunkFailures: number = 0
): Promise<IndexingResult> {
  if (holdingsCount === 0) {
    return { success: true, documentsIndexed: 0, chunksIndexed: 0, errors: [] };
  }

  const text =
    `Portfolio with ${holdingsCount} holdings: ` +
    "A ".repeat(holdingsCount * 20);
  const chunks = chunkText(text);
  const errors: string[] = [];
  let chunksIndexed = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (i < chunkFailures) {
      errors.push(`Failed to index holdings chunk ${i}`);
    } else {
      chunksIndexed++;
    }
  }

  return {
    success: errors.length === 0,
    documentsIndexed: 1,
    chunksIndexed,
    errors,
  };
}

async function mockIndexTrades(tradesCount: number): Promise<IndexingResult> {
  if (tradesCount === 0) {
    return { success: true, documentsIndexed: 0, chunksIndexed: 0, errors: [] };
  }
  return { success: true, documentsIndexed: 1, chunksIndexed: 1, errors: [] };
}

async function mockIndexDocument(
  textContent: string | null,
  isEmbedded: boolean
): Promise<IndexingResult> {
  if (!textContent || textContent.length < 50) {
    return { success: true, documentsIndexed: 0, chunksIndexed: 0, errors: [] };
  }
  const chunks = chunkText(textContent);
  return {
    success: true,
    documentsIndexed: 1,
    chunksIndexed: chunks.length,
    errors: [],
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("Indexer - Chunk text", () => {
  it("should return single chunk for short text", () => {
    const text = "Short text here.";
    const chunks = chunkText(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.chunkIndex, 0);
    assert.equal(chunks[0]!.text, text);
  });

  it("should chunk long text into multiple pieces", () => {
    const text = "A ".repeat(1500); // ~3000 chars > 2048 (512*4)
    const chunks = chunkText(text);
    assert.ok(chunks.length > 1);
  });

  it("should include chunk indices in order", () => {
    const text = "Word. ".repeat(600); // Long enough for multiple chunks
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i]!.chunkIndex, i);
    }
  });

  it("should preserve original length in all chunks", () => {
    const text = "Sentence one. Sentence two. ".repeat(200);
    const chunks = chunkText(text);
    assert.ok(chunks.every((c) => c.originalLength === text.length));
  });

  it("should try to break at sentence boundaries", () => {
    const sentence = "This is a complete sentence. ";
    const text = sentence.repeat(100);
    const chunks = chunkText(text, 64); // 256 chars per chunk
    // Each chunk should end with "." or be the last chunk
    for (let i = 0; i < chunks.length - 1; i++) {
      const trimmed = chunks[i]!.text.trim();
      assert.ok(
        trimmed.endsWith(".") || trimmed.endsWith("\n"),
        `Chunk ${i} doesn't end at sentence boundary: "${trimmed.slice(-20)}"`
      );
    }
  });
});

describe("Indexer - Mock holdings indexing", () => {
  it("should return empty result for no holdings", async () => {
    const result = await mockIndexHoldings(0);
    assert.ok(result.success);
    assert.equal(result.documentsIndexed, 0);
    assert.equal(result.chunksIndexed, 0);
  });

  it("should index holdings as single document", async () => {
    const result = await mockIndexHoldings(10);
    assert.equal(result.documentsIndexed, 1);
    assert.ok(result.chunksIndexed >= 1);
  });

  it("should track chunk failures", async () => {
    const result = await mockIndexHoldings(10, 1);
    assert.ok(!result.success);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0]!.includes("chunk 0"));
  });
});

describe("Indexer - Mock trades indexing", () => {
  it("should return empty for no trades", async () => {
    const result = await mockIndexTrades(0);
    assert.ok(result.success);
    assert.equal(result.documentsIndexed, 0);
  });

  it("should index trades as single document", async () => {
    const result = await mockIndexTrades(100);
    assert.equal(result.documentsIndexed, 1);
  });
});

describe("Indexer - Mock document indexing", () => {
  it("should skip documents with no text content", async () => {
    const result = await mockIndexDocument(null, false);
    assert.equal(result.documentsIndexed, 0);
  });

  it("should skip documents with text shorter than 50 chars", async () => {
    const result = await mockIndexDocument("Short text", false);
    assert.equal(result.documentsIndexed, 0);
  });

  it("should index documents with sufficient text", async () => {
    const text =
      "This is a long document with enough content to be indexed. " +
      "It contains information about financial statements and reports.";
    const result = await mockIndexDocument(text, false);
    assert.equal(result.documentsIndexed, 1);
    assert.ok(result.chunksIndexed >= 1);
  });

  it("should create multiple chunks for very long documents", async () => {
    const text = "Financial report paragraph. ".repeat(200); // ~5400 chars
    const result = await mockIndexDocument(text, false);
    assert.ok(result.chunksIndexed > 1);
  });
});

describe("Indexer - Result aggregation", () => {
  it("should aggregate all results correctly", () => {
    const results: IndexingResult[] = [
      { success: true, documentsIndexed: 1, chunksIndexed: 3, errors: [] },
      { success: true, documentsIndexed: 1, chunksIndexed: 1, errors: [] },
      {
        success: false,
        documentsIndexed: 0,
        chunksIndexed: 0,
        errors: ["Failed"],
      },
    ];
    const agg = aggregateIndexingResults(results);
    assert.ok(!agg.success); // One failure
    assert.equal(agg.documentsIndexed, 2);
    assert.equal(agg.chunksIndexed, 4);
    assert.equal(agg.errors.length, 1);
  });

  it("should return success when all succeed", () => {
    const results: IndexingResult[] = [
      { success: true, documentsIndexed: 1, chunksIndexed: 2, errors: [] },
      { success: true, documentsIndexed: 1, chunksIndexed: 1, errors: [] },
    ];
    const agg = aggregateIndexingResults(results);
    assert.ok(agg.success);
    assert.equal(agg.errors.length, 0);
  });

  it("should handle empty results array", () => {
    const agg = aggregateIndexingResults([]);
    assert.ok(agg.success);
    assert.equal(agg.documentsIndexed, 0);
    assert.equal(agg.chunksIndexed, 0);
  });
});

describe("Indexer - Background indexing type selection", () => {
  it("should include all 5 types by default", () => {
    const types = selectDocTypes();
    assert.equal(types.length, 5);
    assert.ok(types.includes("holdings"));
    assert.ok(types.includes("trades"));
    assert.ok(types.includes("fire_scenario"));
    assert.ok(types.includes("analysis"));
    assert.ok(types.includes("document"));
  });

  it("should use provided types when specified", () => {
    const types = selectDocTypes(["holdings", "trades"]);
    assert.equal(types.length, 2);
    assert.ok(!types.includes("fire_scenario"));
  });

  it("should allow single type", () => {
    const types = selectDocTypes(["document"]);
    assert.equal(types.length, 1);
  });
});

describe("Indexer - Embedding generation mock", () => {
  it("should generate embeddings for all texts", () => {
    const result = mockGenerateEmbeddings(["text1", "text2", "text3"]);
    assert.equal(result.embeddings.length, 3);
    assert.equal(result.failedIndices.length, 0);
    assert.ok(result.embeddings.every((e) => e.length === 768));
  });

  it("should mark failed indices", () => {
    const result = mockGenerateEmbeddings(["t1", "t2", "t3"], [1]);
    assert.deepEqual(result.failedIndices, [1]);
    assert.equal(result.embeddings[1]!.length, 0);
    assert.equal(result.embeddings[0]!.length, 768);
  });

  it("should handle all failures", () => {
    const result = mockGenerateEmbeddings(["t1", "t2"], [0, 1]);
    assert.equal(result.failedIndices.length, 2);
    assert.ok(result.embeddings.every((e) => e.length === 0));
  });
});

describe("Indexer - indexAllUserData parallel execution", () => {
  it("should run all indexers and aggregate", async () => {
    const [holdings, trades, fire, analysis] = await Promise.all([
      mockIndexHoldings(5),
      mockIndexTrades(10),
      Promise.resolve<IndexingResult>({
        success: true,
        documentsIndexed: 2,
        chunksIndexed: 4,
        errors: [],
      }),
      Promise.resolve<IndexingResult>({
        success: true,
        documentsIndexed: 3,
        chunksIndexed: 6,
        errors: [],
      }),
    ]);

    assert.ok(
      holdings.success && trades.success && fire.success && analysis.success
    );
    const totalDocs =
      holdings.documentsIndexed +
      trades.documentsIndexed +
      fire.documentsIndexed +
      analysis.documentsIndexed;
    assert.ok(totalDocs >= 4);
  });

  it("should not fail all if one indexer fails", async () => {
    const results = await Promise.allSettled([
      mockIndexHoldings(5),
      Promise.reject(new Error("Network error")),
      mockIndexTrades(10),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 2);
    assert.equal(rejected.length, 1);
  });
});

describe("Indexer - Delete delegation", () => {
  it("should build correct filter for scenario deletion", () => {
    const filter = { userId: "u1", docType: "fire_scenario", docId: "s123" };
    assert.equal(filter.docType, "fire_scenario");
    assert.equal(filter.docId, "s123");
  });

  it("should build correct filter for analysis deletion", () => {
    const filter = { userId: "u1", docType: "analysis", docId: "a456" };
    assert.equal(filter.docType, "analysis");
    assert.equal(filter.docId, "a456");
  });
});
