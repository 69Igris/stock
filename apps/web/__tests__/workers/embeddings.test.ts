/**
 * Workers Embeddings Utility Tests — chunkText (DE-SHADOWED)
 *
 * Asserts the REAL exported `chunkText` from
 * `workers/src/lib/embeddings.ts` (imported via relative path, the same
 * pattern other apps/web worker tests use). The previous version of this
 * file SHADOWED chunkText with an inline copy, so it kept passing against
 * the OLD buggy implementation even after the source was fixed for an
 * infinite-loop bug (a tail with no sentence boundary — CSV rows /
 * base64 / minified blobs — or overlap >= chunkSize used to spin forever).
 *
 * Only `chunkText` is import-safe + exported from the workers module:
 * `generateEmbedding` / `generateBatchEmbeddings` require Vertex network
 * I/O, and `estimateTokenCount` / `truncateToTokenLimit` are private
 * (non-exported) internals — so none of those can be asserted as a real
 * symbol here without either a shadow or a live network call, and the
 * no-shadow policy forbids re-declaring their logic to assert a copy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL source under test (no shadow). Relative path resolves from
// apps/web/__tests__/workers → repo-root workers/src/lib/embeddings.
import {
  chunkText,
  type ChunkedText,
} from "../../../../workers/src/lib/embeddings";

// Source constant, used ONLY to size fixtures (not to shadow any logic):
// chunkText measures everything in characters = tokens * 4.
const CHARS_PER_TOKEN = 4;

// The production call site is `chunkText(textContent, 512, 50)` in
// indexDocumentForRAG (workers/src/processors/document-process.ts).
const PROD_MAX_TOKENS = 512;
const PROD_OVERLAP = 50;

// A generous upper bound on how many chunks any finite input may emit, so a
// regression to the infinite-loop behavior trips an assertion (and the global
// test-timeout SIGKILL) instead of silently passing. Even a degenerate
// zero-progress window over N chars can only ever emit < N chunks.
function assertFinite(chunks: ChunkedText[], inputLen: number): void {
  assert.ok(Array.isArray(chunks), "chunkText must return an array");
  assert.ok(
    chunks.length <= inputLen + 1,
    `chunk count ${chunks.length} exceeds the safe bound for input length ${inputLen} — possible runaway loop`
  );
}

// ===========================================================================
// chunkText — single chunk
// ===========================================================================

describe("Embeddings - chunkText single chunk", () => {
  it("should return single chunk for short text", () => {
    const text = "Short text here.";
    const chunks = chunkText(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.chunkIndex, 0);
    assert.equal(chunks[0]!.text, text);
    assert.equal(chunks[0]!.originalLength, text.length);
  });

  it("should return single chunk at exactly max size", () => {
    const maxChars = 512 * CHARS_PER_TOKEN; // 2048
    const text = "x".repeat(maxChars);
    const chunks = chunkText(text);
    assert.equal(chunks.length, 1);
  });

  it("should return a single chunk for empty string", () => {
    const chunks = chunkText("");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text, "");
    assert.equal(chunks[0]!.originalLength, 0);
  });
});

// ===========================================================================
// chunkText — multiple chunks
// ===========================================================================

describe("Embeddings - chunkText multiple chunks", () => {
  it("should split long text into multiple chunks", () => {
    const text = "Sentence end. ".repeat(300); // ~4200 chars > 2048
    const chunks = chunkText(text);
    assert.ok(chunks.length > 1);
  });

  it("should maintain sequential chunk indices", () => {
    const text = "Word. ".repeat(600);
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i]!.chunkIndex, i);
    }
  });

  it("should preserve originalLength in all chunks", () => {
    const text = "Data point. ".repeat(400);
    const chunks = chunkText(text);
    assert.ok(chunks.every((c) => c.originalLength === text.length));
  });

  it("should try to break at sentence boundaries", () => {
    const sentence = "This is a complete sentence. ";
    const text = sentence.repeat(100);
    const chunks = chunkText(text);
    // Non-last chunks should end at a period or newline
    for (let i = 0; i < chunks.length - 1; i++) {
      const trimmed = chunks[i]!.text.trim();
      assert.ok(
        trimmed.endsWith(".") || trimmed.endsWith("\n"),
        `Chunk ${i} doesn't end at sentence boundary: "${trimmed.slice(-30)}"`
      );
    }
  });

  it("should handle text with no natural break points", () => {
    // Continuous chars with no periods or newlines
    const text = "x".repeat(5000);
    const chunks = chunkText(text);
    assert.ok(chunks.length > 1);
    // Should still produce valid (non-empty) chunks
    assert.ok(chunks.every((c) => c.text.length > 0));
  });
});

// ===========================================================================
// chunkText — custom parameters
// ===========================================================================

describe("Embeddings - chunkText custom parameters", () => {
  it("should respect custom maxChunkTokens", () => {
    const text = "Word. ".repeat(200); // ~1200 chars
    const chunks256 = chunkText(text, 128); // 512 chars per chunk
    const chunks512 = chunkText(text, 256); // 1024 chars per chunk
    assert.ok(chunks256.length >= chunks512.length);
  });

  it("should handle very small chunk size", () => {
    const text = "A short sentence. Another sentence. One more.";
    // With 32 tokens = 128 chars, text is 46 chars → single chunk
    const chunks = chunkText(text, 32);
    assert.equal(chunks.length, 1);
  });
});

// ===========================================================================
// chunkText — TERMINATION / infinite-loop REGRESSION (the fixed bug)
// ===========================================================================

describe("Embeddings - chunkText termination (infinite-loop regression)", () => {
  it("terminates and returns a finite array for a 5000-char no-boundary blob at production params", () => {
    // This is the exact shape that used to spin forever: a long unbroken
    // token whose tail contains no "." or "\n". With the production call
    // chunkText(text, 512, 50), the final window pinned end at text.length
    // while start stayed below it → infinite loop. Must now terminate.
    const text = "x".repeat(5000);
    const start = Date.now();
    const chunks = chunkText(text, PROD_MAX_TOKENS, PROD_OVERLAP);
    const elapsed = Date.now() - start;

    assertFinite(chunks, text.length);
    assert.ok(chunks.length > 1, "5000-char input should split into >1 chunk");
    assert.ok(
      elapsed < 1000,
      `chunkText should complete fast; took ${elapsed}ms (possible runaway loop)`
    );
  });

  it("terminates when overlap >= chunkSize (degenerate overlap can't stall the window)", () => {
    // overlap (in tokens) >= maxChunkTokens means end - overlapChars <= start,
    // which (pre-fix) parked the window in place forever. The fix falls back to
    // `end` so the window always advances.
    const text = "y".repeat(4000);
    const start = Date.now();
    // overlap (600) is larger than the chunk size (500).
    const chunks = chunkText(text, 500, 600);
    const elapsed = Date.now() - start;

    assertFinite(chunks, text.length);
    assert.ok(chunks.length >= 1);
    assert.ok(
      elapsed < 1000,
      `overlap>=chunkSize must terminate fast; took ${elapsed}ms`
    );
  });

  it("terminates with overlap exactly equal to chunkSize", () => {
    const text = "z".repeat(4000);
    const start = Date.now();
    const chunks = chunkText(text, 256, 256); // overlapChars === maxChunkChars
    const elapsed = Date.now() - start;

    assertFinite(chunks, text.length);
    assert.ok(chunks.length >= 1);
    assert.ok(
      elapsed < 1000,
      `overlap==chunkSize must terminate; took ${elapsed}ms`
    );
  });

  it("terminates on a CSV-like tail with no sentence boundary", () => {
    // A header sentence (gives an early break point) followed by a long wall of
    // comma-separated rows with NO trailing "." or "\n" — the real-world tail
    // that triggered the production hang.
    const header = "Holdings export. ";
    const csvWall = Array.from(
      { length: 1200 },
      (_, i) => `RELIANCE,NSE,${i},${i * 10},${i % 7}`
    ).join(",");
    const text = header + csvWall;

    const start = Date.now();
    const chunks = chunkText(text, PROD_MAX_TOKENS, PROD_OVERLAP);
    const elapsed = Date.now() - start;

    assertFinite(chunks, text.length);
    assert.ok(chunks.length > 1, "CSV wall should split into multiple chunks");
    assert.ok(
      elapsed < 1000,
      `CSV-tail input must terminate fast; took ${elapsed}ms (possible runaway loop)`
    );
  });

  it("terminates on a long base64-like blob with no whitespace or periods", () => {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let blob = "";
    for (let i = 0; i < 6000; i++) {
      blob += alphabet[i % alphabet.length];
    }
    const start = Date.now();
    const chunks = chunkText(blob, PROD_MAX_TOKENS, PROD_OVERLAP);
    const elapsed = Date.now() - start;

    assertFinite(chunks, blob.length);
    assert.ok(chunks.length > 1);
    assert.ok(
      elapsed < 1000,
      `base64 blob must terminate fast; took ${elapsed}ms`
    );
  });
});

// ===========================================================================
// chunkText — chunk index integrity (contiguous, NaN-free)
// ===========================================================================

describe("Embeddings - chunkText index integrity", () => {
  it("emits contiguous, NaN-free 0-based chunk indices for a no-boundary blob", () => {
    const text = "x".repeat(5000);
    const chunks = chunkText(text, PROD_MAX_TOKENS, PROD_OVERLAP);

    assertFinite(chunks, text.length);
    for (let i = 0; i < chunks.length; i++) {
      const idx = chunks[i]!.chunkIndex;
      assert.equal(
        Number.isNaN(idx),
        false,
        `chunkIndex at position ${i} must not be NaN`
      );
      assert.equal(
        idx,
        i,
        `chunkIndex must be contiguous: expected ${i}, got ${idx}`
      );
    }
  });

  it("emits contiguous, NaN-free indices for sentence-broken text", () => {
    const text = "A complete sentence here. ".repeat(200);
    const chunks = chunkText(text, PROD_MAX_TOKENS, PROD_OVERLAP);

    assertFinite(chunks, text.length);
    let prev = -1;
    for (const c of chunks) {
      assert.equal(
        Number.isNaN(c.chunkIndex),
        false,
        "chunkIndex must not be NaN"
      );
      assert.equal(
        c.chunkIndex,
        prev + 1,
        "chunkIndex must increase by exactly 1"
      );
      prev = c.chunkIndex;
      assert.equal(
        Number.isNaN(c.originalLength),
        false,
        "originalLength must not be NaN"
      );
      assert.equal(c.originalLength, text.length);
    }
  });

  it("keeps originalLength consistent across every chunk for a mixed input", () => {
    const text =
      "Intro paragraph with a period. " + "q".repeat(4000) + " trailing words";
    const chunks = chunkText(text, PROD_MAX_TOKENS, PROD_OVERLAP);

    assertFinite(chunks, text.length);
    assert.ok(
      chunks.every((c) => c.originalLength === text.length),
      "every chunk must record the same originalLength"
    );
  });
});
