/**
 * Vector Store Tests (lib/gemini/vector-store.ts + vector-store-logic.ts)
 *
 * De-shadowed (MONEY-620). The previous version re-implemented the ranking,
 * upsert-key and cosine logic inline and asserted the copies. The pure ranking
 * + key logic now live in vector-store-logic.ts (rankBySimilarity,
 * buildEmbeddingUpsertKey) and are CALLED by vector-store.ts'
 * searchSimilarAppLevel / searchStockDocuments / storeEmbedding /
 * storeBatchEmbeddings — so these tests and production execute the same code.
 *
 * cosineSimilarity is the REAL estimator from embeddings.ts (note: it THROWS on
 * a dimension mismatch — the old copy silently returned 0, which never matched
 * production). The DB-layer concerns (docType filtering, stats aggregation,
 * delete filters, last-indexed lookup) are thin Prisma calls with no pure seam
 * and are covered by the action/integration suites, not re-mocked here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity } from "@/lib/gemini/embeddings";
import {
  rankBySimilarity,
  buildEmbeddingUpsertKey,
  type ScorableDocument,
} from "@/lib/gemini/vector-store-logic";
import type { DocumentType } from "@/lib/gemini/vector-store";

describe("VectorStore - DocumentType coverage", () => {
  it("should include the 6 user-level document types", () => {
    const types: DocumentType[] = [
      "holdings",
      "trades",
      "fire_scenario",
      "analysis",
      "user_preferences",
      "document",
    ];
    assert.equal(types.length, 6);
  });
});

describe("VectorStore - cosineSimilarity (real estimator)", () => {
  it("should return 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    const score = cosineSimilarity(v, v);
    assert.ok(Math.abs(score - 1.0) < 0.0001);
  });

  it("should return ~0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.0001);
  });

  it("should return -1 for opposite vectors", () => {
    const a = [1, 0];
    const b = [-1, 0];
    assert.ok(Math.abs(cosineSimilarity(a, b) + 1.0) < 0.0001);
  });

  it("should THROW for mismatched dimensions (real contract)", () => {
    // The old shadow returned 0 here; the real estimator throws. The source
    // only ever compares same-dimension vectors so this never fires in prod.
    assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /same length/);
  });

  it("should return 0 for zero vectors", () => {
    assert.equal(cosineSimilarity([0, 0, 0], [0, 0, 0]), 0);
  });

  it("should handle high-dimensional vectors", () => {
    const dim = 768;
    const a = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const b = Array.from({ length: dim }, (_, i) => Math.sin(i + 0.1));
    const score = cosineSimilarity(a, b);
    assert.ok(score > 0.9);
  });
});

describe("VectorStore - rankBySimilarity (app-level ranking)", () => {
  const mockDocs: ScorableDocument[] = [
    {
      docType: "holdings",
      docId: null,
      content: "Portfolio summary",
      embedding: [1, 0, 0],
      metadata: { symbol: "RELIANCE" },
    },
    {
      docType: "trades",
      docId: null,
      content: "Recent trades",
      embedding: [0, 1, 0],
      metadata: undefined,
    },
    {
      docType: "fire_scenario",
      docId: "s1",
      content: "Retirement plan",
      embedding: [0, 0, 1],
      metadata: { scenarioName: "Base" },
    },
    {
      docType: "analysis",
      docId: "a1",
      content: "Analysis report",
      embedding: [0.7, 0.7, 0],
      metadata: { symbol: "TCS" },
    },
  ];

  it("should return top results sorted by score (desc)", () => {
    const results = rankBySimilarity(mockDocs, [1, 0, 0], { minScore: 0 });
    assert.equal(results[0]!.content, "Portfolio summary");
    assert.ok(results[0]!.score > results[1]!.score);
  });

  it("should filter by minScore", () => {
    const results = rankBySimilarity(mockDocs, [1, 0, 0], { minScore: 0.9 });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.docType, "holdings");
  });

  it("should respect topK limit", () => {
    const results = rankBySimilarity(mockDocs, [0.5, 0.5, 0.5], {
      topK: 2,
      minScore: 0,
    });
    assert.equal(results.length, 2);
  });

  it("should return empty for no matches above minScore", () => {
    const results = rankBySimilarity(mockDocs, [1, 0, 0], { minScore: 1.1 });
    assert.equal(results.length, 0);
  });

  it("should return empty for empty document set", () => {
    const results = rankBySimilarity([], [1, 0, 0]);
    assert.equal(results.length, 0);
  });

  it("should preserve metadata in results", () => {
    const results = rankBySimilarity(mockDocs, [1, 0, 0], { minScore: 0.9 });
    assert.equal(results[0]!.metadata?.symbol, "RELIANCE");
  });

  it("should default topK to 5", () => {
    const manyDocs: ScorableDocument[] = Array.from({ length: 10 }, (_, i) => ({
      docType: "holdings",
      docId: null,
      content: `Doc ${i}`,
      embedding: [1, 0.1 * i, 0],
    }));
    const results = rankBySimilarity(manyDocs, [1, 0, 0], { minScore: 0 });
    assert.equal(results.length, 5);
  });

  it("should preserve docType and docId on results", () => {
    const results = rankBySimilarity(mockDocs, [0, 0, 1], { minScore: 0 });
    assert.equal(results[0]!.docType, "fire_scenario");
    assert.equal(results[0]!.docId, "s1");
  });
});

describe("VectorStore - buildEmbeddingUpsertKey", () => {
  it("should build a key with all fields", () => {
    const key = buildEmbeddingUpsertKey("user1", "holdings", "doc123", 0);
    assert.deepEqual(key, {
      userId: "user1",
      docType: "holdings",
      docId: "doc123",
      chunkId: 0,
    });
  });

  it("should normalize a null docId to empty string", () => {
    const key = buildEmbeddingUpsertKey("user1", "holdings", null, 0);
    assert.equal(key.docId, "");
  });

  it("should distinguish chunks of the same document", () => {
    const key0 = buildEmbeddingUpsertKey("user1", "document", "d1", 0);
    const key1 = buildEmbeddingUpsertKey("user1", "document", "d1", 1);
    assert.notDeepEqual(key0, key1);
  });
});
