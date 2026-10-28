/**
 * Stock-document-embed processor — PURE helpers (no Prisma / Vertex AI).
 *
 * `stock-document-embed.ts` kept its section-aware chunker, its query builder,
 * the constants and the min-length skip inline; the test re-declared copies of
 * all of them and asserted the copies — a SHADOW that had already DRIFTED from
 * the source (the inline copy prefixed chunks with an em-dash "—" while the real
 * code uses a hyphen "-"). These side-effect-free bits now live here, the
 * processor imports + CALLS them, and the test asserts the REAL code.
 *
 * @see workers/src/processors/stock-document-embed.ts (caller)
 * @see apps/web/__tests__/workers/processor-stock-document-embed.test.ts
 */

import { chunkText } from "../lib/embeddings";

/** Well-known system userId for shared stock document embeddings. */
export const SYSTEM_USER_ID = "000000000000000000000001";

/** Delay between embedding batches to avoid Vertex AI rate limits (ms). */
export const DELAY_BETWEEN_BATCHES_MS = 1000;

/** Max chunk tokens (~2048 chars) — the sweet spot for embedding search. */
export const MAX_CHUNK_TOKENS = 512;

/**
 * Hard cap on the number of chunks ANY single document may produce.
 *
 * RESOURCE BOUND (security): every chunk becomes one embedding API call, so an
 * adversarial / pathological document — a 300-page annual report, a giant OCR'd
 * PDF, or a transcript with thousands of one-line speaker turns — could
 * otherwise fan out into tens of thousands of Vertex calls in a single embed
 * run (cost + rate-limit storm, and a Pub/Sub retry amplifies it). 600 chunks
 * at ~512 tokens covers ~1.2M characters of a document — well past any genuine
 * filing — while bounding the blast radius of a hostile input. Applied by
 * `capChunks` at the tail of every chunker.
 */
export const MAX_CHUNKS_PER_DOC = 600;

/**
 * Truncate a chunk list to {@link MAX_CHUNKS_PER_DOC}. Pure + total: returns the
 * same array (reference) when already within the cap, otherwise a bounded slice.
 * Keeps the head of the document (cover / MD&A / first turns) which is the most
 * information-dense part of a filing.
 */
export function capChunks(chunks: FinancialChunk[]): FinancialChunk[] {
  return chunks.length > MAX_CHUNKS_PER_DOC
    ? chunks.slice(0, MAX_CHUNKS_PER_DOC)
    : chunks;
}

/** Known financial section headers used to split documents. */
export const SECTION_HEADERS: string[] = [
  "Income Statement",
  "Balance Sheet",
  "Cash Flow Statement",
  "Profit & Loss",
  "Profit and Loss",
  "Key Ratios",
  "Ratios",
  "Shareholding Pattern",
  "Quarterly Results",
  "Compounded Sales Growth",
  "Compounded Profit Growth",
  "Stock Price CAGR",
  "Return on Equity",
  "Cash Flows",
  "Cash Flow",
  "Source:",
];

export interface FinancialChunk {
  text: string;
  chunkIndex: number;
}

/**
 * Split financial text into section-aware chunks.
 *
 * 1. Try to split at known financial section headers (case-insensitive).
 * 2. If no headers match, fall back to the generic `chunkText`, prefixing each
 *    chunk with "{SYMBOL}".
 * 3. Otherwise emit one chunk per section (sub-chunking oversized sections),
 *    prefixing with "{SYMBOL} - {section}" for better embedding context.
 */
export function chunkFinancialText(
  text: string,
  symbol: string,
): FinancialChunk[] {
  // Build a header-boundary regex (escaping each header for regex safety).
  const sectionPattern = new RegExp(
    `^(${SECTION_HEADERS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gim",
  );

  const matches: { index: number; header: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = sectionPattern.exec(text)) !== null) {
    matches.push({ index: match.index, header: match[0] });
  }

  // No sections found → generic chunking.
  if (matches.length === 0) {
    const chunks = chunkText(text, MAX_CHUNK_TOKENS, 50);
    return capChunks(
      chunks.map((c) => ({
        text: `${symbol}\n\n${c.text}`,
        chunkIndex: c.chunkIndex,
      })),
    );
  }

  // Split into sections.
  const sections: { header: string; content: string }[] = [];

  // Content before the first section header.
  if (matches[0]!.index > 0) {
    const preamble = text.slice(0, matches[0]!.index).trim();
    if (preamble.length > 50) {
      sections.push({ header: "Overview", content: preamble });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index;
    const end = i + 1 < matches.length ? matches[i + 1]!.index : text.length;
    const content = text.slice(start, end).trim();
    if (content.length > 30) {
      sections.push({ header: matches[i]!.header, content });
    }
  }

  // Convert sections to chunks, sub-chunking when too long.
  const result: FinancialChunk[] = [];
  let globalIndex = 0;

  for (const section of sections) {
    const maxChars = MAX_CHUNK_TOKENS * 4; // ~4 chars per token
    if (section.content.length <= maxChars) {
      result.push({
        text: `${symbol} - ${section.header}\n\n${section.content}`,
        chunkIndex: globalIndex++,
      });
    } else {
      const subChunks = chunkText(section.content, MAX_CHUNK_TOKENS, 50);
      for (const sub of subChunks) {
        result.push({
          text: `${symbol} - ${section.header} (part ${sub.chunkIndex + 1})\n\n${sub.text}`,
          chunkIndex: globalIndex++,
        });
      }
    }
    // Resource bound: stop building once past the cap (a hostile doc with
    // thousands of section headers can't fan out into unbounded embed calls).
    if (result.length >= MAX_CHUNKS_PER_DOC) break;
  }

  return capChunks(result);
}

// ============== Per-docType chunkers (MONEY-784 P3b) ==============
// `chunkFinancialText` above is table/section-header oriented — great for
// financial statements, but concall transcripts and annual reports have a very
// different shape. These two chunkers split on the structures that ACTUALLY
// occur in those docs (speaker turns; AR section headings) and `chunkByDocType`
// dispatches on docType, falling back to `chunkFinancialText`.

/**
 * How many consecutive speaker turns to group into one concall chunk. A single
 * Q&A exchange (analyst question + management answer) lands in ~2-3 turns, so a
 * group of 4 keeps related context together without over-large chunks.
 */
export const CONCALL_TURNS_PER_CHUNK = 4;

/**
 * Common annual-report section headings used to split an AR into chunks. Matched
 * case-insensitively at a line start (see `chunkAnnualReport`).
 */
export const ANNUAL_REPORT_HEADINGS: string[] = [
  "Management Discussion and Analysis",
  "Management Discussion & Analysis",
  "Management Discussion",
  "MD&A",
  "Director's Report",
  "Directors' Report",
  "Directors Report",
  "Board's Report",
  "Boards Report",
  "Corporate Governance",
  "Risk Management",
  "Risk Factors",
  "Risks",
  "Risk",
  "Notes to the Financial Statements",
  "Notes to Financial Statements",
  "Notes to Accounts",
  "Auditor's Report",
  "Auditors' Report",
  "Independent Auditor's Report",
  "Balance Sheet",
  "Statement of Profit and Loss",
  "Cash Flow Statement",
];

/**
 * Speaker-turn chunking for concall transcripts.
 *
 * Concall transcripts are a sequence of speaker turns: a line that NAMES a
 * speaker (`Moderator:`, `Analyst:`, `John Doe – CFO:`, `Ramesh Kumar:`) followed
 * by what they said. We split on those speaker-name boundaries and group
 * `CONCALL_TURNS_PER_CHUNK` turns per chunk so a Q&A exchange stays intact.
 *
 * If no speaker turns are detected (not actually a transcript), it falls back to
 * the generic section-aware `chunkFinancialText`.
 */
export function chunkConcallTranscript(
  text: string,
  symbol: string,
): FinancialChunk[] {
  // A speaker line: start-of-line, a Name / Role (letters, spaces, .&-/ and a
  // dash for "Name – Role"), then a colon. Capped length avoids matching prose
  // sentences that happen to contain a colon.
  const speakerPattern =
    /^[ \t]*([A-Z][A-Za-z.\-&/' ]{1,60}?):[ \t]/gm;

  const boundaries: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = speakerPattern.exec(text)) !== null) {
    boundaries.push(m.index);
  }

  // Not a transcript shape → generic chunking.
  if (boundaries.length < 2) {
    return chunkFinancialText(text, symbol);
  }

  // Slice the text into per-speaker turns.
  const turns: string[] = [];
  // Preamble before the first speaker line (call intro / disclaimer).
  if (boundaries[0]! > 0) {
    const pre = text.slice(0, boundaries[0]!).trim();
    if (pre.length > 0) turns.push(pre);
  }
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i]!;
    const end = i + 1 < boundaries.length ? boundaries[i + 1]! : text.length;
    const turn = text.slice(start, end).trim();
    if (turn.length > 0) turns.push(turn);
  }

  // Group N turns per chunk.
  const result: FinancialChunk[] = [];
  let chunkIndex = 0;
  for (let i = 0; i < turns.length; i += CONCALL_TURNS_PER_CHUNK) {
    const group = turns.slice(i, i + CONCALL_TURNS_PER_CHUNK).join("\n\n");
    if (group.trim().length === 0) continue;
    result.push({
      text: `${symbol} - Earnings Call\n\n${group}`,
      chunkIndex: chunkIndex++,
    });
    // Resource bound: a transcript with tens of thousands of one-line speaker
    // turns can't fan out into unbounded embedding calls.
    if (result.length >= MAX_CHUNKS_PER_DOC) break;
  }

  return capChunks(result);
}

/**
 * Heading/section chunking for annual reports.
 *
 * Splits the AR at well-known section headings (`ANNUAL_REPORT_HEADINGS`), one
 * chunk per section, sub-chunking oversized sections via the generic `chunkText`.
 * When no headings match (e.g. an OCR'd PDF with mangled headers) it falls back
 * to the section-aware `chunkFinancialText`.
 */
export function chunkAnnualReport(
  text: string,
  symbol: string,
): FinancialChunk[] {
  const headingPattern = new RegExp(
    `^[ \\t]*(${ANNUAL_REPORT_HEADINGS.map((h) =>
      h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ).join("|")})`,
    "gim",
  );

  const matches: { index: number; header: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(text)) !== null) {
    matches.push({ index: match.index, header: match[1]!.trim() });
  }

  // No AR headings found → generic section-aware chunking.
  if (matches.length === 0) {
    return chunkFinancialText(text, symbol);
  }

  const sections: { header: string; content: string }[] = [];

  // Content before the first heading (cover / chairman's letter).
  if (matches[0]!.index > 0) {
    const preamble = text.slice(0, matches[0]!.index).trim();
    if (preamble.length > 50) {
      sections.push({ header: "Overview", content: preamble });
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index;
    const end = i + 1 < matches.length ? matches[i + 1]!.index : text.length;
    const content = text.slice(start, end).trim();
    if (content.length > 30) {
      sections.push({ header: matches[i]!.header, content });
    }
  }

  const result: FinancialChunk[] = [];
  let globalIndex = 0;
  const maxChars = MAX_CHUNK_TOKENS * 4; // ~4 chars per token

  for (const section of sections) {
    if (section.content.length <= maxChars) {
      result.push({
        text: `${symbol} - ${section.header}\n\n${section.content}`,
        chunkIndex: globalIndex++,
      });
    } else {
      const subChunks = chunkText(section.content, MAX_CHUNK_TOKENS, 50);
      for (const sub of subChunks) {
        result.push({
          text: `${symbol} - ${section.header} (part ${sub.chunkIndex + 1})\n\n${sub.text}`,
          chunkIndex: globalIndex++,
        });
      }
    }
    // Resource bound: a 300-page AR with thousands of headings can't fan out
    // into unbounded embedding calls.
    if (result.length >= MAX_CHUNKS_PER_DOC) break;
  }

  return capChunks(result);
}

/**
 * Dispatch to the right chunker for a document's `docType` (MONEY-784 P3b):
 *   - `concall_transcript` → speaker-turn chunking
 *   - `video_transcript`   → speaker-turn chunking (MONEY-785 P4; YouTube
 *                            earnings-call / interview transcripts are concall-
 *                            shaped, and the chunker falls back to
 *                            `chunkFinancialText` when no speaker turns exist)
 *   - `annual_report`      → heading/section chunking
 *   - everything else      → the generic section-aware `chunkFinancialText`
 */
export function chunkByDocType(
  docType: string,
  text: string,
  symbol: string,
): FinancialChunk[] {
  switch (docType) {
    case "concall_transcript":
    case "video_transcript":
      return chunkConcallTranscript(text, symbol);
    case "annual_report":
      return chunkAnnualReport(text, symbol);
    default:
      return chunkFinancialText(text, symbol);
  }
}

/** Build the `StockDocument.findMany` WHERE for the embed query. */
export function buildEmbedQuery(opts: {
  forceReindex?: boolean;
  symbols?: string[];
  docTypes?: string[];
}): Record<string, unknown> {
  const where: Record<string, unknown> = {
    processingStatus: "READY",
    textContent: { not: null },
  };

  if (!opts.forceReindex) {
    where.isEmbedded = false;
  }

  if (opts.symbols && opts.symbols.length > 0) {
    where.symbol = { in: opts.symbols.map((s) => s.toUpperCase()) };
  }

  if (opts.docTypes && opts.docTypes.length > 0) {
    where.docType = { in: opts.docTypes };
  }

  return where;
}

/** Skip documents that have no/too-little text to embed (< 50 chars). */
export function shouldSkipDocument(
  textContent: string | null | undefined,
): boolean {
  return !textContent || textContent.length < 50;
}

// ============== Vertex RAG re-import (MONEY-804 P3c) ==============
// After a doc is embedded into Atlas, the worker ALSO best-effort imports the
// doc's GCS object into the managed Vertex corpus so it stays fresh. The GCS
// object name lives in `StockDocument.gcsPath` (a path within the bucket); the
// Vertex import API wants a full `gs://bucket/object` URI. This pure helper
// builds that URI so the I/O processor stays a thin wrapper (and is testable
// without GCS / Vertex). Everything stays INERT behind `vertexRagConfigured()`
// in the processor — this helper never decides to import, it only shapes the URI.

/** GCS bucket the worker reads/writes (mirrors `lib/gcs.ts getBucketName`). */
export function embedGcsBucket(): string {
  return process.env.GCP_STORAGE_BUCKET || "stockbook-learning-content";
}

/**
 * Build the `gs://bucket/object` URI for a doc's GCS object, or `null` when the
 * doc has no usable `gcsPath` (text-source docs that were never stored as a
 * file). Pure: the bucket is read once from env, the object path is trimmed of a
 * leading slash so `gs://bucket//x` can't form.
 */
export function gcsUriForDocument(
  gcsPath: string | null | undefined,
): string | null {
  const path = gcsPath?.trim();
  if (!path) return null;
  return `gs://${embedGcsBucket()}/${path.replace(/^\/+/, "")}`;
}
