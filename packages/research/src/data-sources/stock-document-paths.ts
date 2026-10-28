/**
 * GCS Path Utilities for Stock Documents
 *
 * Convention: stocks/{SYMBOL}/{docType}/{filename}
 *
 * Examples:
 *   stocks/RELIANCE/annual_report/RELIANCE-annual-report-2024.pdf
 *   stocks/TCS/financial_statement/TCS-financials-annual-FY2024.txt
 *   stocks/INFY/quarterly_result/INFY-Q3-2024-results.pdf
 *   stocks/RELIANCE/corporate_actions/RELIANCE-corporate-actions.json
 *   stocks/RELIANCE/screener_shareholding/RELIANCE-screener_shareholding-2024.json
 *   stocks/RELIANCE/screener_peers/RELIANCE-screener_peers-2024.json
 */

export type StockDocType =
  | "annual_report"
  | "quarterly_result"
  | "financial_statement"
  | "corporate_filing"
  | "concall_transcript"
  | "concall_ppt"
  | "concall_ai_summary"
  | "screener_financials"
  | "drhp"
  // MONEY-784 (P3b) — NSE announcement categories beyond annual reports.
  | "investor_presentation"
  | "credit_rating"
  | "press_release"
  | "earnings_call_intimation"
  // MONEY-785 (P4) — YouTube earnings-call / analyst / management-interview
  // transcripts ingested into the RAG corpus (text inline, no PDF).
  | "video_transcript"
  // MONEY-853 — structured JSON snapshots of the Screener sections that aren't
  // PDFs: the shareholding-pattern trend, the peer-comparison table, and the
  // compounded-growth numbers. Archived alongside the DB upsert for audit/RAG.
  | "screener_shareholding"
  | "screener_peers"
  | "screener_growth"
  // MONEY-853 — the exchange announcements feed surfaced in Screener's Documents.
  | "announcement"
  // MONEY-840/844 — per-symbol JSON snapshot of merged NSE + Screener corp
  // actions, archived alongside the DB upsert for audit/replay.
  | "corporate_actions"
  // MONEY-1098 — SEBI integrated-filing regime. A METADATA doc type: the
  // `/api/integrated-filing-results` window feed gives us who filed what, when,
  // audited-or-not and standalone-or-consolidated, but (on the P1-probed
  // sample) no attachment. Rows are archived as a JSON snapshot + a rendered
  // text summary, so the doc type exists to keep them distinguishable from the
  // announcement/corporate_filing buckets in RAG and the UI.
  | "integrated_filing";

/**
 * Sanitise a symbol for use as a GCS path SEGMENT. Allow-lists the only chars a
 * real ticker uses (A-Z 0-9 . & -) and strips everything else — critically the
 * `/` and `..` that would let a hostile/typo'd symbol like `../../secrets`
 * escape the `stocks/{SYMBOL}/…` prefix and read/write an arbitrary object.
 * Returns "UNKNOWN" if nothing safe remains so the path is still well-formed.
 */
function sanitizeSymbolSegment(symbol: string): string {
  const clean = String(symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9.&-]/g, "") // allow-list ticker chars
    .replace(/\.{2,}/g, ".") // collapse `..` (traversal token) → single dot
    .replace(/^[.-]+|[.-]+$/g, ""); // never lead/trail with a dot or dash
  // A segment with no alphanumerics is meaningless + path-unsafe → stable token.
  return /[A-Z0-9]/.test(clean) ? clean : "UNKNOWN";
}

/**
 * Build the GCS storage path for a stock document. The symbol is sanitised to a
 * path-safe segment so it can never escape the `stocks/{SYMBOL}/…` prefix.
 */
export function buildStockDocPath(
  symbol: string,
  docType: StockDocType,
  fileName: string,
): string {
  return `stocks/${sanitizeSymbolSegment(symbol)}/${docType}/${fileName}`;
}

/**
 * Build a standardized filename for a stock document.
 */
export function buildDocFileName(
  symbol: string,
  docType: StockDocType,
  period: string,
  extension: string = "pdf",
): string {
  const clean = symbol.toUpperCase().replace(/[^A-Z0-9&]/g, "");
  const safePeriod = period.replace(/[/\\:*?"<>|]/g, "-");
  return `${clean}-${docType}-${safePeriod}.${extension}`;
}

/**
 * Build the full GCS path from symbol + docType + period.
 */
export function buildFullDocPath(
  symbol: string,
  docType: StockDocType,
  period: string,
  extension: string = "pdf",
): string {
  const fileName = buildDocFileName(symbol, docType, period, extension);
  return buildStockDocPath(symbol, docType, fileName);
}
