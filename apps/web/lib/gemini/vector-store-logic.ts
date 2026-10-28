/**
 * Vector Store — pure logic
 *
 * Pure, dependency-free helpers extracted from vector-store.ts so they can be
 * unit-tested without importing the Prisma-backed module. vector-store.ts
 * imports and CALLS these (no dead exports): the production search path and the
 * tests execute the same code.
 */

import { cosineSimilarity } from "./embeddings";
// Type-only import (erased at runtime, so no import cycle with vector-store.ts).
import type {
  DocumentType,
  DocumentMetadata,
  SearchResult,
  SearchOptions,
} from "./vector-store";

/** A stored embedding row as fetched for application-level cosine search. */
export interface ScorableDocument {
  content: string;
  docType: DocumentType | string;
  docId: string | null;
  embedding: number[];
  // Prisma rows surface this as JsonValue; accept `unknown` and narrow on read.
  metadata?: unknown;
}

/**
 * Score, filter (≥ minScore), sort (desc) and slice (topK) a set of stored
 * documents against a query embedding. This is the application-level ranking
 * shared by searchSimilarAppLevel + searchStockDocuments' app-level fallback.
 *
 * Note: cosineSimilarity throws on a length mismatch (it is the same estimator
 * used everywhere); callers always compare same-dimension vectors.
 */
export function rankBySimilarity(
  documents: ScorableDocument[],
  queryEmbedding: number[],
  options: SearchOptions = {}
): SearchResult[] {
  const { topK = 5, minScore = 0.5 } = options;

  return documents
    .map((doc) => ({
      content: doc.content,
      docType: doc.docType as DocumentType,
      docId: doc.docId,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
      metadata: (doc.metadata as DocumentMetadata) || undefined,
    }))
    .filter((doc) => doc.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Build the composite upsert key for a DocumentEmbedding row. A null docId is
 * normalized to the empty string so the unique index is stable.
 */
export function buildEmbeddingUpsertKey(
  userId: string,
  docType: DocumentType,
  docId: string | null,
  chunkId: number
): { userId: string; docType: DocumentType; docId: string; chunkId: number } {
  return { userId, docType, docId: docId || "", chunkId };
}
