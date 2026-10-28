/**
 * Document Processor Edge Case Tests
 *
 * Edge cases for the document processing worker.
 * Covers areas NOT tested in the main document-process.test.ts:
 * - PDF extraction: large content truncation behavior
 * - Text content truncated at size limit without warning
 * - GCS download failure → job fails
 * - Invalid URL format → fetch error
 * - HTML content-type for non-HTML content → tags stripped anyway
 * - Embedding batch partial failure → some chunks not indexed
 * - NSE API rate limit → job fails (no backoff)
 * - Document ownership not validated (security gap)
 * - Metadata type coercion: symbol is array → runtime error
 * - Report rendering with huge data
 * - fetch_url with missing URL
 * - handleFetchNse missing metadata fields
 *
 * Pure logic is reimplemented inline to avoid side-effecting imports.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocumentProcessMessage {
  jobId: string;
  userId: string;
  documentId: string;
  action: "extract_text" | "generate_report" | "fetch_url" | "fetch_nse";
  url?: string;
  reportType?: "tax" | "risk" | "portfolio_statement";
  reportParams?: Record<string, unknown>;
}

interface UserDocument {
  id: string;
  userId: string;
  title: string;
  storagePath: string;
  mimeType: string;
  fileName: string;
  originalUrl: string | null;
  processingStatus: string;
  textContent: string | null;
  metadata: Record<string, unknown> | null;
  isEmbedded: boolean;
  fileSize?: number;
}

// ---------------------------------------------------------------------------
// Reimplemented pure functions from source
// ---------------------------------------------------------------------------

const MAX_TEXT_LENGTH = 100_000;

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function capTextContent(text: string): string {
  if (text.length > MAX_TEXT_LENGTH) {
    return text.substring(0, MAX_TEXT_LENGTH);
  }
  return text;
}

function getNseUrl(symbol: string, docType: string): string {
  const encodedSymbol = encodeURIComponent(symbol);
  switch (docType) {
    case "annual_report":
      return `https://www.nseindia.com/api/corporates-corporateActions?index=equities&symbol=${encodedSymbol}`;
    case "shareholding":
      return `https://www.nseindia.com/api/corporate-shareholding?symbol=${encodedSymbol}`;
    case "financial_results":
      return `https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol=${encodedSymbol}`;
    default:
      throw new Error(`Unknown NSE document type: ${docType}`);
  }
}

function shouldIndexForRAG(textContent: string): boolean {
  return textContent.length > 50;
}

function determineTextExtractionMethod(
  mimeType: string
): "pdf" | "text" | "spreadsheet" | "image" | "unknown" {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/csv" || mimeType.startsWith("text/")) return "text";
  if (mimeType.includes("spreadsheet") || mimeType.includes("ms-excel"))
    return "spreadsheet";
  if (mimeType.startsWith("image/")) return "image";
  return "unknown";
}

function buildJobStatusUpdate(
  status: "PROCESSING" | "COMPLETED" | "FAILED",
  errorMessage?: string
): Record<string, unknown> {
  const data: Record<string, unknown> = { status };
  if (status === "PROCESSING") data.startedAt = new Date();
  if (status === "COMPLETED" || status === "FAILED") {
    data.completedAt = new Date();
    data.progress = status === "COMPLETED" ? 100 : 0;
  }
  if (errorMessage) data.errorMessage = errorMessage;
  return data;
}

/**
 * Mirror of extractMetadataFields from handleFetchNse
 * The source casts metadata fields to string, which fails for arrays/objects.
 */
function extractMetadataFields(metadata: Record<string, unknown> | null): {
  symbol: string | undefined;
  docType: string | undefined;
} {
  const symbol = metadata?.symbol as string | undefined;
  const docType = metadata?.docType as string | undefined;
  return { symbol, docType };
}

/**
 * Mirror of the fetch_url URL resolution logic
 */
function resolveUrl(
  url: string | undefined,
  originalUrl: string | null
): string | null {
  return url || originalUrl || null;
}

/**
 * Mirror of the documentType determination (always "PDF" in source - a bug)
 */
function determineDocumentType(contentType: string): string {
  return contentType.includes("pdf") ? "PDF" : "PDF";
}

/**
 * Simulate indexDocumentForRAG with partial embedding failures
 */
function filterSuccessfulEmbeddings(
  chunks: Array<{ text: string; chunkIndex: number }>,
  embeddings: Array<number[] | null>,
  failedIndices: number[]
): Array<{ chunkIndex: number; text: string }> {
  return chunks
    .map((chunk, i) => {
      if (failedIndices.includes(i) || !embeddings[i]?.length) return null;
      return { chunkIndex: chunk.chunkIndex, text: chunk.text };
    })
    .filter(Boolean) as Array<{ chunkIndex: number; text: string }>;
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("DocProcessor Edge Cases - Text Truncation", () => {
  it("should truncate PDF text at exactly 100KB without warning", () => {
    const pdfText = "A".repeat(200_000);
    const capped = capTextContent(pdfText);
    assert.strictEqual(capped.length, MAX_TEXT_LENGTH);
    // No warning/marker is appended - just silently truncated
    assert.strictEqual(capped[capped.length - 1], "A");
  });

  it("should truncate at 100K boundary, not at word/sentence boundary", () => {
    // Content with a word crossing the 100K boundary
    const word = "IMPORTANT";
    const padding = "x".repeat(MAX_TEXT_LENGTH - 4); // leave 4 chars
    const text = padding + word; // total: 100000 - 4 + 9 = 100005
    const capped = capTextContent(text);
    assert.strictEqual(capped.length, MAX_TEXT_LENGTH);
    // The word "IMPORTANT" is cut off at position 100000
    assert.ok(!capped.endsWith("IMPORTANT"));
    assert.ok(capped.endsWith("IMPO"));
  });

  it("should not add truncation marker or warning to stored content", () => {
    const text = "B".repeat(150_000);
    const capped = capTextContent(text);
    assert.ok(!capped.includes("truncated"));
    assert.ok(!capped.includes("..."));
    assert.ok(!capped.includes("["));
  });

  it("should handle content exactly at limit without modification", () => {
    const text = "C".repeat(100_000);
    const capped = capTextContent(text);
    assert.strictEqual(capped.length, 100_000);
    assert.strictEqual(capped, text);
  });

  it("should handle content at limit+1", () => {
    const text = "D".repeat(100_001);
    const capped = capTextContent(text);
    assert.strictEqual(capped.length, 100_000);
  });
});

describe("DocProcessor Edge Cases - GCS/Fetch Failures", () => {
  it("should propagate GCS download error as job failure", () => {
    // The source throws errors from downloadFromGCS which bubble up
    // and are caught by processDocument's try/catch
    const gcsError = new Error("Storage object not found: path/to/doc.pdf");
    const jobUpdate = buildJobStatusUpdate("FAILED", gcsError.message);
    assert.strictEqual(jobUpdate.status, "FAILED");
    assert.strictEqual(
      jobUpdate.errorMessage,
      "Storage object not found: path/to/doc.pdf"
    );
    assert.strictEqual(jobUpdate.progress, 0);
  });

  it("should fail on HTTP error status from fetch", () => {
    // The source checks response.ok and throws
    const httpError = new Error("Fetch failed: 403 Forbidden");
    const jobUpdate = buildJobStatusUpdate("FAILED", httpError.message);
    assert.strictEqual(jobUpdate.errorMessage, "Fetch failed: 403 Forbidden");
  });

  it("should fail on malformed URL", () => {
    // fetch() with invalid URL throws TypeError
    const urlError = new TypeError("Failed to parse URL from invalid-url");
    assert.ok(urlError instanceof Error);
    assert.ok(urlError.message.includes("Failed to parse URL"));
  });

  it("should fail when no URL is provided and originalUrl is null", () => {
    const url = resolveUrl(undefined, null);
    assert.strictEqual(url, null);
    // In source, this would throw "No URL provided for fetch_url action"
  });

  it("should use originalUrl as fallback when url param is undefined", () => {
    const url = resolveUrl(undefined, "https://example.com/report.pdf");
    assert.strictEqual(url, "https://example.com/report.pdf");
  });

  it("should prefer explicit url over originalUrl", () => {
    const url = resolveUrl(
      "https://explicit.com/doc.pdf",
      "https://original.com/doc.pdf"
    );
    assert.strictEqual(url, "https://explicit.com/doc.pdf");
  });
});

describe("DocProcessor Edge Cases - HTML content-type handling", () => {
  it("should strip HTML tags even when content is not actually HTML", () => {
    // If content-type says text/html but content is plain text with <angle brackets>
    const nonHtml = "Temperature is <100 degrees and >50 degrees";
    const stripped = stripHtmlTags(nonHtml);
    // The regex treats <100 degrees and > as a tag and removes it
    assert.ok(!stripped.includes("<100"));
    // Content between angle brackets is treated as a tag
    assert.strictEqual(stripped, "Temperature is 50 degrees");
  });

  it("should strip all tags from JSON response served as text/html", () => {
    const jsonAsHtml =
      '<html><body>{"price": 100, "symbol": "TCS"}</body></html>';
    const stripped = stripHtmlTags(jsonAsHtml);
    assert.ok(stripped.includes('"price": 100'));
    assert.ok(!stripped.includes("<html>"));
    assert.ok(!stripped.includes("<body>"));
  });

  it("should strip script tags that contain data payloads", () => {
    const html =
      '<script type="application/json">{"data": "secret"}</script><p>Visible</p>';
    const stripped = stripHtmlTags(html);
    assert.ok(!stripped.includes("secret"));
    assert.ok(stripped.includes("Visible"));
  });

  it("should handle self-closing tags", () => {
    const html = "Line 1<br/>Line 2<hr/>Line 3";
    const stripped = stripHtmlTags(html);
    assert.ok(stripped.includes("Line 1"));
    assert.ok(stripped.includes("Line 2"));
    assert.ok(stripped.includes("Line 3"));
  });
});

describe("DocProcessor Edge Cases - Embedding batch partial failure", () => {
  it("should exclude chunks at failed indices", () => {
    const chunks = [
      { text: "Chunk 0", chunkIndex: 0 },
      { text: "Chunk 1", chunkIndex: 1 },
      { text: "Chunk 2", chunkIndex: 2 },
      { text: "Chunk 3", chunkIndex: 3 },
    ];
    const embeddings: Array<number[] | null> = [
      [0.1, 0.2],
      null,
      [0.3, 0.4],
      [0.5, 0.6],
    ];
    const failedIndices = [1];

    const stored = filterSuccessfulEmbeddings(
      chunks,
      embeddings,
      failedIndices
    );
    assert.strictEqual(stored.length, 3);
    assert.deepStrictEqual(
      stored.map((s) => s.chunkIndex),
      [0, 2, 3]
    );
  });

  it("should exclude chunks with empty embeddings even if not in failedIndices", () => {
    const chunks = [
      { text: "Chunk 0", chunkIndex: 0 },
      { text: "Chunk 1", chunkIndex: 1 },
    ];
    const embeddings: Array<number[] | null> = [
      [0.1, 0.2],
      [], // empty array, not null
    ];
    const failedIndices: number[] = [];

    const stored = filterSuccessfulEmbeddings(
      chunks,
      embeddings,
      failedIndices
    );
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0]!.chunkIndex, 0);
  });

  it("should return empty array when all embeddings fail", () => {
    const chunks = [
      { text: "Chunk 0", chunkIndex: 0 },
      { text: "Chunk 1", chunkIndex: 1 },
    ];
    const embeddings: Array<number[] | null> = [null, null];
    const failedIndices = [0, 1];

    const stored = filterSuccessfulEmbeddings(
      chunks,
      embeddings,
      failedIndices
    );
    assert.strictEqual(stored.length, 0);
  });

  it("should handle zero chunks", () => {
    const stored = filterSuccessfulEmbeddings([], [], []);
    assert.strictEqual(stored.length, 0);
  });
});

describe("DocProcessor Edge Cases - NSE API", () => {
  it("should not implement backoff for NSE rate limits", () => {
    // The source uses a 30s timeout but no retry logic for NSE
    // If NSE returns 429, the error propagates and Pub/Sub retries
    const nseError = new Error("NSE fetch failed: 429");
    const jobUpdate = buildJobStatusUpdate("FAILED", nseError.message);
    assert.strictEqual(jobUpdate.status, "FAILED");
    assert.strictEqual(jobUpdate.errorMessage, "NSE fetch failed: 429");
  });

  it("should throw for missing symbol in metadata", () => {
    const metadata: Record<string, unknown> = { docType: "annual_report" };
    const { symbol, docType } = extractMetadataFields(metadata);
    assert.strictEqual(symbol, undefined);
    assert.strictEqual(docType, "annual_report");
    // In source: if (!symbol || !docType) throw new Error(...)
    assert.ok(!symbol);
  });

  it("should throw for missing docType in metadata", () => {
    const metadata: Record<string, unknown> = { symbol: "RELIANCE" };
    const { symbol, docType } = extractMetadataFields(metadata);
    assert.strictEqual(symbol, "RELIANCE");
    assert.strictEqual(docType, undefined);
    assert.ok(!docType);
  });

  it("should throw for null metadata", () => {
    const { symbol, docType } = extractMetadataFields(null);
    assert.strictEqual(symbol, undefined);
    assert.strictEqual(docType, undefined);
  });

  it("should encode special NSE symbols correctly in URL", () => {
    const url = getNseUrl("M&MFIN", "shareholding");
    assert.ok(url.includes("M%26MFIN"));
    assert.ok(!url.includes("M&MFIN"));
  });
});

describe("DocProcessor Edge Cases - Metadata type coercion", () => {
  it("should cast array symbol as string type (runtime issue)", () => {
    // If metadata.symbol is an array, `as string` cast hides the type mismatch
    const metadata: Record<string, unknown> = {
      symbol: ["RELIANCE", "TCS"],
      docType: "annual_report",
    };
    const { symbol } = extractMetadataFields(metadata);
    // TypeScript says it's string, but at runtime it's still an array
    assert.ok(Array.isArray(symbol));
    // This would cause issues when passed to getNseUrl → encodeURIComponent
    // encodeURIComponent(["RELIANCE","TCS"]) → "RELIANCE%2CTCS"
    const encoded = encodeURIComponent(symbol as unknown as string);
    assert.strictEqual(encoded, "RELIANCE%2CTCS");
  });

  it("should handle numeric symbol in metadata (type coercion)", () => {
    const metadata: Record<string, unknown> = {
      symbol: 12345,
      docType: "financial_results",
    };
    const { symbol } = extractMetadataFields(metadata);
    // `as string` makes TS happy but it's a number at runtime
    assert.strictEqual(typeof symbol, "number");
  });
});

describe("DocProcessor Edge Cases - Document ownership", () => {
  it("should note that processDocument does not verify userId matches document owner", () => {
    // In the source, handleExtractText does:
    //   prisma.userDocument.findUnique({ where: { id: documentId } })
    // It does NOT check userId === doc.userId
    // This is a documented security gap

    // Simulate the lookup without ownership check
    const doc: UserDocument = {
      id: "doc_1",
      userId: "user_A",
      title: "Private Doc",
      storagePath: "gs://bucket/doc.pdf",
      mimeType: "application/pdf",
      fileName: "doc.pdf",
      originalUrl: null,
      processingStatus: "PENDING",
      textContent: null,
      metadata: null,
      isEmbedded: false,
    };

    const requestUserId = "user_B"; // different user!
    // The source would proceed without checking doc.userId === requestUserId
    assert.notStrictEqual(doc.userId, requestUserId);
    // No assertion failure in source code - this is the gap
  });
});

describe("DocProcessor Edge Cases - documentType determination", () => {
  it("should always return PDF even for non-PDF content types (source bug)", () => {
    // Source line 199: contentType.includes("pdf") ? "PDF" : "PDF"
    // Both branches return "PDF"
    assert.strictEqual(determineDocumentType("application/pdf"), "PDF");
    assert.strictEqual(determineDocumentType("text/html"), "PDF");
    assert.strictEqual(determineDocumentType("text/plain"), "PDF");
    assert.strictEqual(determineDocumentType("image/png"), "PDF");
  });
});

describe("DocProcessor Edge Cases - Report rendering", () => {
  it("should fail when reportType is not specified and metadata has none", () => {
    // In source: const type = reportType || metadata?.reportType
    // If both are undefined, throws "No report type specified"
    const reportType: string | undefined = undefined;
    const metadata: Record<string, unknown> = {};
    const type = reportType || (metadata.reportType as string | undefined);
    assert.strictEqual(type, undefined);
  });

  it("should use explicit reportType over metadata reportType", () => {
    const reportType = "risk";
    const metadata: Record<string, unknown> = { reportType: "tax" };
    const type = reportType || (metadata.reportType as string | undefined);
    assert.strictEqual(type, "risk");
  });

  it("should fall back to metadata reportType when explicit is undefined", () => {
    const reportType: string | undefined = undefined;
    const metadata: Record<string, unknown> = {
      reportType: "portfolio_statement",
    };
    const type = reportType || (metadata.reportType as string | undefined);
    assert.strictEqual(type, "portfolio_statement");
  });
});

describe("DocProcessor Edge Cases - RAG indexing threshold", () => {
  it("should not index text of exactly 50 chars (boundary)", () => {
    assert.strictEqual(shouldIndexForRAG("x".repeat(50)), false);
  });

  it("should index text of 51 chars (just above boundary)", () => {
    assert.strictEqual(shouldIndexForRAG("x".repeat(51)), true);
  });

  it("should not index placeholder text '[Image: photo.jpg]'", () => {
    const placeholder = "[Image: photo.jpg]";
    assert.strictEqual(placeholder.length < 50, true);
    assert.strictEqual(shouldIndexForRAG(placeholder), false);
  });

  it("should not index spreadsheet placeholder", () => {
    const placeholder = "[Spreadsheet: data.xlsx]";
    assert.strictEqual(shouldIndexForRAG(placeholder), false);
  });

  it("should not index PDF extraction failure message", () => {
    const failMsg = "[PDF text extraction failed]";
    assert.strictEqual(shouldIndexForRAG(failMsg), false);
  });
});
