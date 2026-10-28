/**
 * Financial Document Chunker
 *
 * Domain-aware chunking for financial documents.
 * - Financial statements: split by statement type first, then by size
 * - PDFs: sentence-boundary chunking
 * - Each chunk gets a symbol/context prefix for better embeddings
 */

const CHARS_PER_TOKEN = 4;
const DEFAULT_CHUNK_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 50;

export interface ChunkedText {
  text: string;
  chunkId: number;
  metadata: {
    symbol: string;
    docType: string;
    period: string;
    section?: string;
  };
}

/**
 * Chunk a financial document with domain awareness.
 */
export function chunkFinancialDocument(
  text: string,
  symbol: string,
  docType: string,
  period: string,
  maxChunkTokens: number = DEFAULT_CHUNK_TOKENS,
  overlapTokens: number = DEFAULT_OVERLAP_TOKENS,
): ChunkedText[] {
  if (!text || text.length < 50) return [];

  const maxChunkChars = maxChunkTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  const prefix = `${symbol} ${docType.replace(/_/g, " ")} ${period}: `;

  // For financial statements, split by section first
  if (docType === "financial_statement") {
    return chunkBySection(
      text,
      symbol,
      docType,
      period,
      prefix,
      maxChunkChars,
      overlapChars,
    );
  }

  // For PDFs and other docs, use standard paragraph/sentence chunking
  return chunkByParagraph(
    text,
    symbol,
    docType,
    period,
    prefix,
    maxChunkChars,
    overlapChars,
  );
}

/**
 * Split financial statements by section (Income / Balance / CashFlow),
 * then chunk within each section.
 */
function chunkBySection(
  text: string,
  symbol: string,
  docType: string,
  period: string,
  prefix: string,
  maxChunkChars: number,
  overlapChars: number,
): ChunkedText[] {
  const sections = text.split(
    /\n(?=(?:Income Statement|Balance Sheet|Cash Flow Statement)\b)/,
  );
  const chunks: ChunkedText[] = [];
  let chunkId = 0;

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Detect section name from first line
    const firstLine = trimmed.split("\n")[0] || "";
    const sectionName = firstLine.includes("Income")
      ? "income_statement"
      : firstLine.includes("Balance")
        ? "balance_sheet"
        : firstLine.includes("Cash Flow")
          ? "cash_flow"
          : "overview";

    // If section fits in one chunk, use it directly
    if (trimmed.length + prefix.length <= maxChunkChars) {
      chunks.push({
        text: prefix + trimmed,
        chunkId: chunkId++,
        metadata: { symbol, docType, period, section: sectionName },
      });
    } else {
      // Split large sections by line groups
      const subChunks = splitWithOverlap(
        trimmed,
        maxChunkChars - prefix.length,
        overlapChars,
      );
      for (const sub of subChunks) {
        chunks.push({
          text: prefix + sub,
          chunkId: chunkId++,
          metadata: { symbol, docType, period, section: sectionName },
        });
      }
    }
  }

  return chunks;
}

/**
 * Standard paragraph-based chunking for PDFs and other documents.
 */
function chunkByParagraph(
  text: string,
  symbol: string,
  docType: string,
  period: string,
  prefix: string,
  maxChunkChars: number,
  overlapChars: number,
): ChunkedText[] {
  const effectiveMax = maxChunkChars - prefix.length;
  const pieces = splitWithOverlap(text, effectiveMax, overlapChars);
  return pieces.map((piece, i) => ({
    text: prefix + piece,
    chunkId: i,
    metadata: { symbol, docType, period },
  }));
}

/**
 * Split text into chunks with overlap, breaking at sentence boundaries.
 */
function splitWithOverlap(
  text: string,
  maxChars: number,
  overlapChars: number,
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // Try to break at a sentence boundary (. ! ? \n\n)
    if (end < text.length) {
      const searchWindow = text.slice(
        Math.max(start + maxChars * 0.7, start),
        end,
      );
      const lastBreak = Math.max(
        searchWindow.lastIndexOf(". "),
        searchWindow.lastIndexOf(".\n"),
        searchWindow.lastIndexOf("\n\n"),
      );
      if (lastBreak > 0) {
        end = start + Math.floor(maxChars * 0.7) + lastBreak + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = end - overlapChars;

    // Prevent infinite loop
    if (start >= text.length - 10) break;
  }

  return chunks.filter((c) => c.length > 20);
}
