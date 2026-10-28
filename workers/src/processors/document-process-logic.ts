/**
 * Document Processor — Pure Logic
 *
 * Side-effect-free helpers extracted out of `document-process.ts` so they can
 * be unit-tested by importing the REAL symbol (no shadow copies) without
 * booting Prisma / GCS / pdf-parse at module load.
 *
 * `document-process.ts` imports and calls every export here; the production
 * code path and the tests execute the SAME code.
 */

import type { ChunkedText } from "../lib/embeddings";

/** Text content cap (~100KB) applied before persisting extracted text. */
export const MAX_TEXT_LENGTH = 100_000;

/** The four document-process actions the worker accepts. */
export const DOCUMENT_ACTIONS = [
  "extract_text",
  "generate_report",
  "fetch_url",
  "fetch_nse",
] as const;

export type DocumentAction = (typeof DOCUMENT_ACTIONS)[number];

/** How a document's text is extracted, derived from its MIME type. */
export type ExtractionMethod =
  | "pdf"
  | "text"
  | "spreadsheet"
  | "image"
  | "unknown";

/**
 * Strip HTML to plain text: removes <script>/<style> bodies, all tags, decodes
 * a small set of entities, and collapses whitespace. Defensive against an
 * unguarded fetched HTML body (the result is RAG-indexed).
 */
export function stripHtmlTags(html: string): string {
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

/**
 * Build the NSE corporate-data API URL for a symbol + doc type.
 * Throws on an unknown doc type so the caller fails the job loudly rather than
 * fetching a wrong/empty endpoint.
 */
export function getNseUrl(symbol: string, docType: string): string {
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

/** Cap extracted text at MAX_TEXT_LENGTH (DB / RAG bound). */
export function capTextContent(text: string): string {
  if (text.length > MAX_TEXT_LENGTH) {
    return text.substring(0, MAX_TEXT_LENGTH);
  }
  return text;
}

/**
 * Classify which extraction strategy a MIME type maps to. Mirrors the
 * branching inside `handleExtractText`. Anything unrecognized → "unknown"
 * (the worker leaves textContent empty rather than guessing).
 */
export function classifyExtractionMethod(mimeType: string): ExtractionMethod {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/csv" || mimeType.startsWith("text/")) return "text";
  if (mimeType.includes("spreadsheet") || mimeType.includes("ms-excel")) {
    return "spreadsheet";
  }
  if (mimeType.startsWith("image/")) return "image";
  return "unknown";
}

/**
 * Map a fetched response's content-type onto `DocumentFileType` (MONEY-1166).
 *
 * `handleFetchUrl` previously did this inline as
 * `contentType.includes("pdf") ? "PDF" : "PDF"` — both branches identical, so
 * the type was never actually derived from the content, despite the import
 * action deliberately deferring to it ("Will be updated by processor based on
 * content"). Every URL import ended up typed PDF, fetched CSVs and
 * spreadsheets included.
 *
 * `DocumentFileType` has no HTML member, so a web page still resolves to PDF.
 * That is the historical fallback, kept on purpose rather than quietly changed.
 */
export function documentTypeFromContentType(
  contentType: string,
): "PDF" | "IMAGE" | "CSV" | "SPREADSHEET" {
  const ct = contentType.toLowerCase();
  if (ct.includes("pdf")) return "PDF";
  if (ct.includes("image/")) return "IMAGE";
  if (ct.includes("csv")) return "CSV";
  if (ct.includes("spreadsheet") || ct.includes("ms-excel")) {
    return "SPREADSHEET";
  }
  return "PDF";
}

/** Whether an action string is one the worker knows how to dispatch. */
export function isValidAction(action: string): action is DocumentAction {
  return (DOCUMENT_ACTIONS as readonly string[]).includes(action);
}

/** RAG indexing only runs once we have meaningful text (> 50 chars). */
export function shouldIndexForRAG(textContent: string): boolean {
  return textContent.length > 50;
}

/**
 * Build the BackgroundJob status-update patch. PROCESSING stamps `startedAt`;
 * terminal states stamp `completedAt` + a 0/100 progress; an error message is
 * attached only when present.
 */
export function buildJobStatusUpdate(
  status: "PROCESSING" | "COMPLETED" | "FAILED",
  errorMessage?: string,
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
 * A DocumentEmbedding row to persist.
 *
 * The DocumentEmbedding model keys on `docId` + `chunkId`
 * (unique [userId, docType, docId, chunkId]) — there is NO `documentId`
 * column. Writing `documentId` silently fails the createMany, leaving the
 * document un-embedded and un-citable, so we map to the real schema fields.
 */
export interface DocumentEmbeddingRecord {
  userId: string;
  docId: string;
  chunkId: number;
  docType: "document";
  content: string;
  embedding: number[];
  metadata: { title: string; chunkIndex: number; sourceDocumentId: string };
}

/**
 * Build the createMany payload for `indexDocumentForRAG`: pairs each surviving
 * chunk with its embedding, skipping any chunk whose embedding failed
 * (`failedIndices`) or came back empty. Keyed on `chunk.chunkIndex` so the
 * delete/upsert path lines up with the real schema.
 */
export function buildEmbeddingRecords(
  userId: string,
  documentId: string,
  title: string,
  chunks: ChunkedText[],
  texts: string[],
  embeddings: number[][],
  failedIndices: number[],
): DocumentEmbeddingRecord[] {
  const failed = new Set(failedIndices);
  return chunks
    .map((chunk, i): DocumentEmbeddingRecord | null => {
      if (failed.has(i) || !embeddings[i]?.length) return null;
      return {
        userId,
        docId: documentId,
        chunkId: chunk.chunkIndex,
        docType: "document",
        content: texts[i]!,
        embedding: embeddings[i]!,
        metadata: {
          title,
          chunkIndex: chunk.chunkIndex,
          sourceDocumentId: documentId,
        },
      };
    })
    .filter((r): r is DocumentEmbeddingRecord => r !== null);
}
