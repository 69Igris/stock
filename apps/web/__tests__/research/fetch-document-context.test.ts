/**
 * Document-RAG tool + shared embedding tests (MONEY-613).
 *
 * The happy path (Atlas $vectorSearch + Vertex embeddings) is prod-only, so
 * these lock the deterministic pieces: cosineSimilarity (the dev-fallback
 * ranker) and the tool's GRACEFUL degradation — no GCP creds must yield
 * success:true + available:false (never a throw, never a hang on the DB).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { cosineSimilarity } from "../../../../packages/core/src/embeddings";
import { fetchDocumentContextTool } from "../../../../packages/research/src/tools/fetch-document-context";

test("cosineSimilarity: identical / orthogonal / opposite / mismatched", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(cosineSimilarity([1, 2, 3], [2, 4, 6]), 1); // colinear → 1
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0); // length mismatch
  assert.equal(cosineSimilarity([], []), 0); // empty
});

test("tool metadata + required symbol", async () => {
  assert.equal(fetchDocumentContextTool.name, "fetch_document_context");
  assert.equal(fetchDocumentContextTool.category, "data");
  const r = await fetchDocumentContextTool.execute({});
  assert.equal(r.success, false); // symbol required
});

test("graceful: no GCP creds → success:true + available:false (no throw)", async () => {
  const prev = process.env.GCP_PROJECT_ID;
  delete process.env.GCP_PROJECT_ID; // force generateEmbedding to bail early
  try {
    const r = await fetchDocumentContextTool.execute({
      symbol: "RELIANCE.NS",
      query: "revenue growth",
    });
    assert.equal(r.success, true); // degrades, never errors the run
    const data = r.data as {
      available?: boolean;
      chunks?: unknown[];
      reason?: string;
    };
    assert.equal(data.available, false);
    assert.ok(Array.isArray(data.chunks) && data.chunks.length === 0);
    assert.equal(typeof data.reason, "string");
  } finally {
    if (prev !== undefined) process.env.GCP_PROJECT_ID = prev;
  }
});
