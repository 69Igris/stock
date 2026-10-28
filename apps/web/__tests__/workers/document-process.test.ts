/**
 * Document Processor Worker Tests — REAL imports (de-shadowed).
 *
 * De-shadow (MONEY-620): this file previously RE-DECLARED stripHtmlTags,
 * getNseUrl, capTextContent, the MIME router, action validation, job-status
 * builder and the embedding-record builder inline ("Reimplemented pure
 * functions from source") and asserted the copies — a shadow that stays green
 * even if the worker's real logic breaks. The pure helpers now live in
 * `workers/src/processors/document-process-logic.ts`, `document-process.ts`
 * imports + calls them, and these tests assert the REAL exports.
 *
 * Targets (negative / edge focus):
 *   - stripHtmlTags        — empty, unicode, malformed/unclosed, nested script
 *   - getNseUrl            — unknown/empty docType, special chars, 0-byte symbol
 *   - capTextContent       — 0-byte, exactly-at-limit, oversized, unicode
 *   - classifyExtractionMethod — spoofed / unknown / empty MIME
 *   - isValidAction        — unknown / empty / case / spoofed
 *   - buildJobStatusUpdate — lifecycle stamping, error attach
 *   - buildEmbeddingRecords — failed / empty embeddings, NO `documentId` column
 *   - chunkText (embeddings.ts) — 0-byte, oversized, unicode, NaN-free indices
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TEXT_LENGTH,
  DOCUMENT_ACTIONS,
  stripHtmlTags,
  getNseUrl,
  capTextContent,
  classifyExtractionMethod,
  documentTypeFromContentType,
  isValidAction,
  shouldIndexForRAG,
  buildJobStatusUpdate,
  buildEmbeddingRecords,
} from "../../../../workers/src/processors/document-process-logic";
import {
  chunkText,
  type ChunkedText,
} from "../../../../workers/src/lib/embeddings";

// ===========================================================================
// stripHtmlTags
// ===========================================================================

describe("DocProcessor(real) - stripHtmlTags", () => {
  it("strips basic tags + decodes entities + collapses whitespace", () => {
    assert.equal(stripHtmlTags("<p>Hello</p>"), "Hello");
    assert.equal(stripHtmlTags("&amp; &lt; &gt; &nbsp;"), "& < >");
    assert.equal(
      stripHtmlTags("<p>Hello</p>   <p>  World  </p>"),
      "Hello World"
    );
  });

  it("removes <script>/<style> BODIES (XSS payload never leaks to RAG)", () => {
    assert.equal(
      stripHtmlTags('<p>Hi</p><script>alert("xss")</script><p>Bye</p>'),
      "Hi Bye"
    );
    assert.equal(stripHtmlTags("<style>body{color:red}</style><p>T</p>"), "T");
  });

  // ── negative / edge ──
  it("empty string → empty string (no throw)", () => {
    assert.equal(stripHtmlTags(""), "");
  });

  it("whitespace-only / tags-only collapses to empty", () => {
    assert.equal(stripHtmlTags("   \n\t  "), "");
    assert.equal(stripHtmlTags("<div></div><br/>"), "");
  });

  it("malformed / unclosed tags do not throw and strip what they can", () => {
    // Unclosed script: the regex won't match (needs </script>), but the bare
    // `<` opener is still stripped by the generic tag rule → readable remainder.
    const out = stripHtmlTags("<p>safe<script>evil()");
    assert.equal(typeof out, "string");
    assert.ok(out.includes("safe"));
    assert.doesNotThrow(() => stripHtmlTags("<<<>>><a href="));
  });

  it("preserves unicode / emoji content between tags", () => {
    assert.equal(
      stripHtmlTags("<b>नमस्ते</b> 🚀 <i>café</i>"),
      "नमस्ते 🚀 café"
    );
  });

  it("nested tags reduce to their text", () => {
    assert.equal(
      stripHtmlTags("<div><span><b>Bold</b> txt</span></div>"),
      "Bold txt"
    );
  });
});

// ===========================================================================
// getNseUrl
// ===========================================================================

describe("DocProcessor(real) - getNseUrl", () => {
  it("builds the three known doc-type URLs on nseindia.com", () => {
    assert.ok(
      getNseUrl("RELIANCE", "annual_report").startsWith(
        "https://www.nseindia.com/"
      )
    );
    assert.ok(
      getNseUrl("TCS", "shareholding").includes("corporate-shareholding")
    );
    assert.ok(
      getNseUrl("INFY", "financial_results").includes(
        "corporates-financial-results"
      )
    );
  });

  it("URL-encodes special characters in the symbol", () => {
    assert.ok(getNseUrl("M&M", "annual_report").includes("M%26M"));
    // A spoofed query-injection symbol is encoded, not interpolated raw.
    const u = getNseUrl("X&foo=bar", "shareholding");
    assert.ok(u.includes("X%26foo%3Dbar"));
    assert.ok(!u.includes("X&foo=bar"));
  });

  // ── negative / edge ──
  it("throws on unknown docType", () => {
    assert.throws(() => getNseUrl("RELIANCE", "unknown_type"), {
      message: /Unknown NSE document type/,
    });
  });

  it("throws on empty docType (no silent wrong-endpoint fetch)", () => {
    assert.throws(() => getNseUrl("RELIANCE", ""), {
      message: /Unknown NSE document type/,
    });
  });

  it("0-byte symbol still produces a valid known-type URL (no throw)", () => {
    const u = getNseUrl("", "annual_report");
    assert.ok(u.startsWith("https://www.nseindia.com/"));
    assert.ok(u.endsWith("symbol="));
  });
});

// ===========================================================================
// capTextContent
// ===========================================================================

describe("DocProcessor(real) - capTextContent", () => {
  it("leaves text under the limit untouched", () => {
    assert.equal(capTextContent("Short text"), "Short text");
  });

  it("0-byte string → 0-byte (no throw)", () => {
    assert.equal(capTextContent(""), "");
  });

  it("exactly at the limit is not truncated", () => {
    const text = "x".repeat(MAX_TEXT_LENGTH);
    assert.equal(capTextContent(text).length, MAX_TEXT_LENGTH);
  });

  it("oversized (limit+1 and far beyond) truncates to exactly the limit", () => {
    assert.equal(
      capTextContent("x".repeat(MAX_TEXT_LENGTH + 1)).length,
      MAX_TEXT_LENGTH
    );
    assert.equal(
      capTextContent("y".repeat(MAX_TEXT_LENGTH * 3)).length,
      MAX_TEXT_LENGTH
    );
  });

  it("counts UTF-16 code units (multibyte content is still bounded)", () => {
    const emoji = "🚀".repeat(MAX_TEXT_LENGTH); // each = 2 code units
    const capped = capTextContent(emoji);
    assert.equal(capped.length, MAX_TEXT_LENGTH);
  });
});

// ===========================================================================
// classifyExtractionMethod  (MIME routing — spoof / unknown)
// ===========================================================================

describe("DocProcessor(real) - classifyExtractionMethod", () => {
  it("routes the known families", () => {
    assert.equal(classifyExtractionMethod("application/pdf"), "pdf");
    assert.equal(classifyExtractionMethod("text/csv"), "text");
    assert.equal(classifyExtractionMethod("text/plain"), "text");
    assert.equal(classifyExtractionMethod("image/png"), "image");
    assert.equal(
      classifyExtractionMethod("application/vnd.ms-excel"),
      "spreadsheet"
    );
    assert.equal(
      classifyExtractionMethod(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ),
      "spreadsheet"
    );
  });

  // ── negative / edge ──
  it("unknown / empty MIME → 'unknown' (worker leaves text empty, no guess)", () => {
    assert.equal(classifyExtractionMethod("application/zip"), "unknown");
    assert.equal(classifyExtractionMethod(""), "unknown");
    assert.equal(
      classifyExtractionMethod("application/octet-stream"),
      "unknown"
    );
  });

  it("is case-sensitive: an upper-case spoof of PDF is NOT treated as pdf", () => {
    // Real source compares lowercase literals; a spoofed 'APPLICATION/PDF'
    // falls through to unknown rather than being mis-parsed as a PDF.
    assert.equal(classifyExtractionMethod("APPLICATION/PDF"), "unknown");
  });

  it("a parameterized text type (charset) still routes to text", () => {
    assert.equal(classifyExtractionMethod("text/html; charset=utf-8"), "text");
  });
});

// ===========================================================================
// isValidAction
// ===========================================================================

describe("DocProcessor(real) - isValidAction", () => {
  it("accepts every declared action", () => {
    for (const a of DOCUMENT_ACTIONS) assert.ok(isValidAction(a));
    assert.equal(DOCUMENT_ACTIONS.length, 4);
  });

  // ── negative / edge ──
  it("rejects unknown / empty / spoofed / wrong-case actions", () => {
    assert.ok(!isValidAction("unknown"));
    assert.ok(!isValidAction(""));
    assert.ok(!isValidAction("delete"));
    assert.ok(!isValidAction("Extract_Text")); // case-sensitive
    assert.ok(!isValidAction(" extract_text ")); // padded
  });
});

// ===========================================================================
// shouldIndexForRAG  (boundary)
// ===========================================================================

describe("DocProcessor(real) - shouldIndexForRAG", () => {
  it("indexes only > 50 chars (50 = false, 51 = true)", () => {
    assert.ok(!shouldIndexForRAG(""));
    assert.ok(!shouldIndexForRAG("x".repeat(50)));
    assert.ok(shouldIndexForRAG("x".repeat(51)));
  });
});

// ===========================================================================
// buildJobStatusUpdate
// ===========================================================================

describe("DocProcessor(real) - buildJobStatusUpdate", () => {
  it("PROCESSING stamps startedAt, no completedAt/progress", () => {
    const u = buildJobStatusUpdate("PROCESSING");
    assert.equal(u.status, "PROCESSING");
    assert.ok(u.startedAt instanceof Date);
    assert.equal(u.completedAt, undefined);
    assert.equal(u.progress, undefined);
  });

  it("COMPLETED → progress 100 + completedAt", () => {
    const u = buildJobStatusUpdate("COMPLETED");
    assert.equal(u.progress, 100);
    assert.ok(u.completedAt instanceof Date);
  });

  it("FAILED → progress 0 + completedAt + error message", () => {
    const u = buildJobStatusUpdate("FAILED", "boom");
    assert.equal(u.progress, 0);
    assert.equal(u.errorMessage, "boom");
    assert.ok(u.completedAt instanceof Date);
  });

  it("omits errorMessage when not supplied / empty", () => {
    assert.equal(buildJobStatusUpdate("COMPLETED").errorMessage, undefined);
    // empty-string message is falsy → not attached
    assert.equal(buildJobStatusUpdate("FAILED", "").errorMessage, undefined);
  });
});

// ===========================================================================
// buildEmbeddingRecords  (schema-correctness + failure handling)
// ===========================================================================

function mkChunks(texts: string[]): ChunkedText[] {
  return texts.map((t, i) => ({
    text: t,
    chunkIndex: i,
    originalLength: t.length,
  }));
}

describe("DocProcessor(real) - buildEmbeddingRecords", () => {
  const userId = "user_1";
  const documentId = "doc_1";
  const title = "Annual Report";

  it("writes docId + chunkId schema fields, NEVER a `documentId` column", () => {
    const chunks = mkChunks(["a", "b"]);
    const records = buildEmbeddingRecords(
      userId,
      documentId,
      title,
      chunks,
      ["wrapped a", "wrapped b"],
      [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      []
    );
    assert.equal(records.length, 2);
    for (const r of records) {
      assert.equal(r.docId, documentId);
      assert.equal(typeof r.chunkId, "number");
      assert.equal(r.docType, "document");
      // The historical bug: writing a non-existent `documentId` column made the
      // createMany silently fail → doc un-citable.
      assert.ok(!("documentId" in r));
    }
  });

  it("uses chunk.chunkIndex (not array position) for chunkId", () => {
    // Hand a chunk whose chunkIndex != array position; the record must follow
    // the chunk's own index, matching the DocumentEmbedding unique key.
    const chunks: ChunkedText[] = [
      { text: "only", chunkIndex: 7, originalLength: 4 },
    ];
    const records = buildEmbeddingRecords(
      userId,
      documentId,
      title,
      chunks,
      ["t"],
      [[0.5]],
      []
    );
    assert.equal(records[0]!.chunkId, 7);
    assert.equal(records[0]!.metadata.chunkIndex, 7);
  });

  // ── negative / edge ──
  it("skips failed indices AND empty embeddings", () => {
    const chunks = mkChunks(["good", "failed", "empty"]);
    const records = buildEmbeddingRecords(
      userId,
      documentId,
      title,
      chunks,
      ["g", "f", "e"],
      [[0.9], [], []],
      [1] // index 1 reported failed; index 2 has empty vector
    );
    assert.equal(records.length, 1);
    assert.equal(records[0]!.chunkId, 0);
    assert.equal(records[0]!.content, "g");
  });

  it("all-failed → empty array (so isEmbedded stays false)", () => {
    const chunks = mkChunks(["a", "b"]);
    const records = buildEmbeddingRecords(
      userId,
      documentId,
      title,
      chunks,
      ["a", "b"],
      [[], []],
      [0, 1]
    );
    assert.equal(records.length, 0);
  });

  it("empty chunk list → empty array (no throw)", () => {
    assert.deepEqual(
      buildEmbeddingRecords(userId, documentId, title, [], [], [], []),
      []
    );
  });

  it("carries title + sourceDocumentId into metadata", () => {
    const chunks = mkChunks(["a", "b"]);
    const records = buildEmbeddingRecords(
      userId,
      documentId,
      title,
      chunks,
      ["a", "b"],
      [[1], [2]],
      []
    );
    assert.equal(records[1]!.metadata.title, title);
    assert.equal(records[1]!.metadata.sourceDocumentId, documentId);
  });
});

// ===========================================================================
// chunkText  (real export from workers/src/lib/embeddings.ts)
// ===========================================================================

describe("DocProcessor(real) - chunkText (embeddings.ts)", () => {
  it("short text → single chunk indexed 0, originalLength preserved", () => {
    const c = chunkText("hello world.");
    assert.equal(c.length, 1);
    assert.equal(c[0]!.chunkIndex, 0);
    assert.equal(c[0]!.originalLength, "hello world.".length);
  });

  // ── negative / edge ──
  it("0-byte input → exactly one empty chunk (no throw, no NaN)", () => {
    const c = chunkText("");
    assert.equal(c.length, 1);
    assert.equal(c[0]!.text, "");
    assert.equal(c[0]!.chunkIndex, 0);
    assert.ok(Number.isFinite(c[0]!.originalLength));
  });

  it("oversized input splits into multiple, monotonically-indexed chunks", () => {
    // maxChunkTokens=10 → 40 chars/chunk; 2000 chars forces many chunks.
    const text = "word ".repeat(400); // 2000 chars
    const chunks = chunkText(text, 10, 2);
    assert.ok(chunks.length > 1);
    // chunkIndex is a finite integer sequence with no NaN holes.
    chunks.forEach((ch, i) => {
      assert.equal(ch.chunkIndex, i);
      assert.ok(Number.isInteger(ch.chunkIndex));
      assert.equal(ch.originalLength, text.length);
    });
  });

  it("terminates (no infinite loop) when overlap ≥ chunk size", () => {
    // Degenerate config: overlap chars can equal/exceed chunk advance. The
    // loop must still make forward progress and return a finite result.
    const text = "a".repeat(500);
    const chunks = chunkText(text, 10, 10); // 40-char chunk, 40-char overlap
    assert.ok(Array.isArray(chunks));
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((c) => Number.isFinite(c.chunkIndex)));
  });

  it("unicode content is chunked without throwing", () => {
    const text = "नमस्ते दुनिया। 🚀 café ".repeat(200).normalize();
    const chunks = chunkText(text, 20, 5);
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((c) => typeof c.text === "string"));
  });
});

// ── documentTypeFromContentType (MONEY-1166) ────────────────────────

/**
 * `handleFetchUrl` used to derive the stored type with
 * `contentType.includes("pdf") ? "PDF" : "PDF"` — both branches identical, so
 * the type was never actually derived from the fetched content even though the
 * import action deliberately deferred to it. Every URL import was typed PDF.
 */
describe("documentTypeFromContentType — MONEY-1166", () => {
  it("a PDF response types as PDF", () => {
    assert.equal(documentTypeFromContentType("application/pdf"), "PDF");
    assert.equal(
      documentTypeFromContentType("application/pdf; charset=binary"),
      "PDF"
    );
  });

  it("a CSV response types as CSV, not PDF", () => {
    assert.equal(documentTypeFromContentType("text/csv"), "CSV");
  });

  it("an image response types as IMAGE, not PDF", () => {
    assert.equal(documentTypeFromContentType("image/png"), "IMAGE");
    assert.equal(documentTypeFromContentType("image/jpeg"), "IMAGE");
  });

  it("a spreadsheet response types as SPREADSHEET, not PDF", () => {
    assert.equal(
      documentTypeFromContentType("application/vnd.ms-excel"),
      "SPREADSHEET"
    );
    assert.equal(
      documentTypeFromContentType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ),
      "SPREADSHEET"
    );
  });

  it("is case-insensitive (servers do not agree on casing)", () => {
    assert.equal(documentTypeFromContentType("APPLICATION/PDF"), "PDF");
    assert.equal(documentTypeFromContentType("Image/PNG"), "IMAGE");
  });

  it("html keeps the PDF fallback — DocumentFileType has no HTML member", () => {
    assert.equal(documentTypeFromContentType("text/html"), "PDF");
    assert.equal(documentTypeFromContentType(""), "PDF");
  });

  it("DISCRIMINATES: not every content-type collapses to PDF", () => {
    // The pre-fix ternary returned "PDF" for all four of these.
    const types = [
      "application/pdf",
      "text/csv",
      "image/png",
      "application/vnd.ms-excel",
    ].map(documentTypeFromContentType);
    assert.equal(new Set(types).size, 4, `expected 4 distinct, got ${types}`);
  });
});
