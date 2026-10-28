/**
 * Stock Document Fetcher
 *
 * Downloads financial documents (NSE PDFs, formatted financial data)
 * and stores them in GCS for RAG indexing.
 *
 * Follows the getOrFetch pattern from db-store.ts.
 */

import prisma from "@usemoney/database";
import { uploadFile as storageUploadFile } from "@usemoney/storage";
import { toIstDateKey } from "@usemoney/core/market-data/nse-holidays";
import { isStale } from "@usemoney/core/market-data/staleness";
// MONEY-1255 — one rule for "what is a PDF" and "is this queued for
// extraction", shared with the worker that writes the same column.
import {
  CANONICAL_PDF_MIME_TYPE,
  normalizeDocMimeType,
  initialProcessingStatus,
} from "@usemoney/core/market-data/doc-mime";
// MONEY-1319 — the media type comes from the BYTES, not from a literal.
import { resolveStoredMimeType } from "@usemoney/core/market-data/doc-container";

/**
 * Upload function type - can be overridden by the worker to use its own GCS client.
 * Default uses @usemoney/storage which works locally but may fail on Cloud Run.
 */
type UploadFn = (
  path: string,
  content: Buffer,
  contentType: string,
) => Promise<void>;

let _uploadFn: UploadFn = async (path, content, contentType) => {
  await storageUploadFile({
    file: content,
    fileName: path,
    contentType,
    isPublic: false,
  });
};

/**
 * Set a custom upload function (used by workers to inject their own GCS client).
 */
export function setUploadFunction(fn: UploadFn): void {
  _uploadFn = fn;
}

async function uploadToStorage(
  path: string,
  content: Buffer,
  contentType: string,
  metadata?: Record<string, string>,
): Promise<void> {
  await _uploadFn(path, content, contentType);
}
import ky from "ky";
import {
  fetchNSEFinancialResults,
  fetchAnnualReports,
  type NSEFiling,
} from "./nse-filings";
import { getOrFetchFinancials, type FinancialsResult } from "./db-store";
import { buildFullDocPath, type StockDocType } from "./stock-document-paths";
import {
  fetchScreenerDocuments,
  type ScreenerDocument,
} from "./screener-client";
// MONEY-1315 (B) — the BODY sniff. `document-body-guard.ts` says in its own
// header that it lives in THIS directory because "`stock-document-fetcher.ts`
// — the second writer of this table from a raw header — is already here … it is
// the only one BOTH writers can reach". It was placed to reach this file and
// then never imported by it, which left the request-time path able to undo the
// quarantine migration one research query at a time.
import {
  mayStoreDocumentBody,
  ABSENT_GCS_PATH,
  HTML_QUARANTINE_STATUS,
} from "./document-body-guard";

const logger = {
  info: (...args: unknown[]) => console.log("[stock-doc-fetcher]", ...args),
  warn: (...args: unknown[]) => console.warn("[stock-doc-fetcher]", ...args),
  error: (...args: unknown[]) => console.error("[stock-doc-fetcher]", ...args),
};

const NSE_BASE = "https://www.nseindia.com";
const FETCH_DELAY_MS = 2000; // 2s between NSE PDF downloads

// System userId for shared stock document embeddings
export const SYSTEM_USER_ID = "000000000000000000000001";

// ── Types ──────────────────────────────────────────────────────────

interface StockDocRecord {
  id: string;
  symbol: string;
  exchange: string;
  docType: string;
  period: string;
  title: string;
  gcsPath: string;
  processingStatus: string;
  isEmbedded: boolean;
}

// ── The HTML refusal — MONEY-1315 (B) ──────────────────────────────

/**
 * The refusal counter for ONE `getOrFetchStockDocuments` call.
 *
 * A mutable accumulator threaded through the store helpers, which is the shape
 * `stock-document-sync`'s `run.htmlRefusals` already uses — deliberately, so
 * the two writers of this table count the same event the same way. It is
 * per-CALL rather than module-scope: a module-level counter on a request-time
 * path is a number that only grows and that nothing ever reads, and a warm
 * process would make it a lifetime total attributable to no symbol.
 *
 * This path has no `reportJobOutcome` to report into — it is a request-time
 * fetch, not a scheduled job — so the outcome it is visible in is the summary
 * line `getOrFetchStockDocuments` logs for the symbol. That matters for the
 * same reason it matters in the worker: a source whose links have all rotted
 * into landing pages otherwise reads exactly like a source with nothing new to
 * give.
 */
interface DocFetchRun {
  htmlRefusals: number;
}

/**
 * Record a download whose body turned out to be an HTML page.
 *
 * The twin of `quarantineHtmlDownload` in
 * `workers/src/processors/stock-document-sync.ts`, and it must stay one: both
 * import `ABSENT_GCS_PATH` and `HTML_QUARANTINE_STATUS` from
 * `document-body-guard.ts` rather than spelling them out, so a row refused by
 * the weekly worker and a row refused by a research query can never end up in
 * two different states.
 *
 * It COUNTS the refusal on the refusal itself — after the body has been
 * inspected, never at the top of the download it describes. A counter
 * incremented before the call it counts is how Tickertape's 403 reported a full
 * five months of work it never did.
 *
 * `upsert` with an EMPTY update arm, not `create`. The callers check for an
 * existing row first, so this is normally reached with none; but a stale-refetch
 * can reach it with a real PDF already stored under the key, and blanking that
 * row's `gcsPath` because today's fetch hit a transient challenge page would
 * destroy a document with nothing to recover it from. `sourceUrl`, `title` and
 * `description` are KEPT — the BSE-retention precedent (7,234 rows carry
 * `gcsPath: ""` with every other column intact; `ABSENT_GCS_PATH` is where that
 * number is spelled once), so the citation still resolves and a later pass can
 * re-fetch.
 */
async function quarantineHtmlDownload(
  run: DocFetchRun,
  args: {
    instrumentId: string;
    symbol: string;
    exchange: string;
    docType: StockDocType;
    period: string;
    title: string;
    description?: string | undefined;
    sourceUrl: string;
    sourceType: string;
    reason: string;
  },
): Promise<void> {
  run.htmlRefusals++;

  await prisma.stockDocument.upsert({
    where: {
      symbol_exchange_docType_period: {
        symbol: args.symbol,
        exchange: args.exchange,
        docType: args.docType,
        period: args.period,
      },
    },
    create: {
      instrumentId: args.instrumentId,
      symbol: args.symbol,
      exchange: args.exchange,
      docType: args.docType,
      period: args.period,
      title: args.title,
      ...(args.description ? { description: args.description } : {}),
      sourceUrl: args.sourceUrl,
      sourceType: args.sourceType,
      gcsPath: ABSENT_GCS_PATH,
      fileSize: 0,
      mimeType: "text/html",
      processingStatus: HTML_QUARANTINE_STATUS,
      fetchedAt: new Date(),
    },
    update: {},
  });

  logger.warn(
    `REFUSED ${args.sourceType} ${args.docType} for ${args.symbol} ${args.period}: ` +
      `${args.reason} (${args.sourceUrl})`,
  );
}

// ── Core: getOrFetchStockDocuments ──────────────────────────────────

/**
 * Get stock documents from DB, or fetch+store if missing/stale.
 * Returns existing documents if fresh, or newly fetched documents.
 */
export async function getOrFetchStockDocuments(
  symbol: string,
  docType?: StockDocType,
  exchange?: string,
): Promise<StockDocRecord[]> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const ex = exchange || "NSE";

  // 1. Check DB for existing documents
  const existing = await prisma.stockDocument.findMany({
    where: {
      symbol: clean,
      exchange: ex,
      ...(docType ? { docType } : {}),
    },
    orderBy: { fetchedAt: "desc" },
  });

  // 2. Check staleness
  if (existing.length > 0) {
    const newest = existing[0]!;
    const stalenessKey = getStalenessKey(newest.docType);
    if (!isStale(newest.fetchedAt, stalenessKey)) {
      return existing;
    }
  }

  // 3. Fetch missing/stale documents
  const instrumentId = await resolveInstrumentId(clean, ex);
  if (!instrumentId) {
    logger.warn(`No instrument mapping for ${clean}:${ex}`);
    return existing; // Return whatever we have
  }

  const fetched: StockDocRecord[] = [];
  const run: DocFetchRun = { htmlRefusals: 0 };

  // Fetch financial statements from structured data (fast, synchronous-capable)
  if (!docType || docType === "financial_statement") {
    const docs = await fetchAndStoreFinancials(clean, ex, instrumentId);
    fetched.push(...docs);
  }

  // Fetch quarterly result PDFs from NSE
  if (!docType || docType === "quarterly_result") {
    const docs = await fetchAndStoreNSEFilings(
      clean,
      ex,
      instrumentId,
      "quarterly_result",
      () => fetchNSEFinancialResults(clean),
      run,
    );
    fetched.push(...docs);
  }

  // Fetch annual report PDFs from NSE
  if (!docType || docType === "annual_report") {
    const docs = await fetchAndStoreNSEFilings(
      clean,
      ex,
      instrumentId,
      "annual_report",
      () => fetchAnnualReports(clean),
      run,
    );
    fetched.push(...docs);
  }

  // Fetch concall transcripts and other docs from Screener.in (with timeout)
  if (
    !docType ||
    docType === "concall_transcript" ||
    docType === "concall_ppt"
  ) {
    try {
      const screenerTimeout = new Promise<StockDocRecord[]>((resolve) =>
        setTimeout(() => resolve([]), 30_000),
      );
      const screenerFetch = fetchAndStoreScreenerDocs(
        clean,
        ex,
        instrumentId,
        run,
        docType,
      );
      const docs = await Promise.race([screenerFetch, screenerTimeout]);
      fetched.push(...docs);
    } catch {
      logger.warn(`Screener docs timed out for ${clean}`);
    }
  }

  // MONEY-1315 (B) — the refusals, said out loud. This is a request-time path
  // with no `reportJobOutcome`, so this line IS the outcome. Printed only when
  // it happened: a zeroed clause on every call is how a summary becomes noise
  // nobody reads, the same rule `describeSyncShortfall` follows in the worker.
  //
  // `run` is mutated by the Screener helper even when the 30s race above times
  // out and abandons its result, which is correct — the refusal was recorded in
  // the database whether or not this call waited for the records.
  if (run.htmlRefusals > 0) {
    logger.warn(
      `${clean}: ${run.htmlRefusals} download(s) refused as HTML pages ` +
        `(stored with gcsPath "" and ${HTML_QUARANTINE_STATUS}, sourceUrl kept)`,
    );
  }

  // Update instrument sync timestamp
  await prisma.instrumentMapping
    .update({
      where: { id: instrumentId },
      data: { documentsSyncedAt: new Date() },
    })
    .catch(() => {}); // Non-critical

  return [...fetched, ...existing];
}

/**
 * Ensure stock documents exist for a symbol.
 * Used by chat on-demand trigger - non-blocking for PDFs.
 */
export async function ensureStockDocumentsExist(
  symbol: string,
  exchange?: string,
): Promise<{ available: boolean; documentsCount: number }> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const ex = exchange || "NSE";

  const count = await prisma.stockDocument.count({
    where: { symbol: clean, exchange: ex },
  });

  if (count > 0) {
    return { available: true, documentsCount: count };
  }

  // Fetch documents (financial_statement is synchronous, PDFs are stored but not yet embedded)
  const docs = await getOrFetchStockDocuments(clean, undefined, ex);
  return {
    available: docs.length > 0,
    documentsCount: docs.length,
  };
}

// ── Financials: JSON → formatted text → GCS ────────────────────────

async function fetchAndStoreFinancials(
  symbol: string,
  exchange: string,
  instrumentId: string,
): Promise<StockDocRecord[]> {
  const results: StockDocRecord[] = [];

  for (const periodType of ["ANNUAL", "QUARTERLY"] as const) {
    const period =
      periodType === "ANNUAL"
        ? `annual-${new Date().getFullYear()}`
        : `quarterly-${new Date().getFullYear()}`;

    // Check if we already have this
    const exists = await prisma.stockDocument.findUnique({
      where: {
        symbol_exchange_docType_period: {
          symbol,
          exchange,
          docType: "financial_statement",
          period,
        },
      },
    });

    if (exists && !isStale(exists.fetchedAt, "stock_docs_financial")) {
      results.push(exists);
      continue;
    }

    try {
      const financials = await getOrFetchFinancials(
        symbol,
        exchange,
        periodType,
      );
      if (!financials) continue;

      const text = formatFinancialsForDocument(financials, symbol, periodType);
      if (!text || text.length < 100) continue;

      const gcsPath = buildFullDocPath(
        symbol,
        "financial_statement",
        period,
        "txt",
      );

      // Upload to GCS
      const buffer = Buffer.from(text, "utf-8");
      try {
        await uploadToStorage(gcsPath, buffer, "text/plain");
        logger.info(`Uploaded to GCS: ${gcsPath}`);
      } catch (gcsErr) {
        // GCS upload failed - still save to DB with text content (skip GCS)
        logger.warn(
          `GCS upload failed for ${symbol}, saving text to DB only: ${gcsErr instanceof Error ? gcsErr.message : gcsErr}`,
        );
      }

      // Upsert to DB
      const doc = await prisma.stockDocument.upsert({
        where: {
          symbol_exchange_docType_period: {
            symbol,
            exchange,
            docType: "financial_statement",
            period,
          },
        },
        create: {
          instrumentId,
          symbol,
          exchange,
          docType: "financial_statement",
          period,
          title: `${symbol} Financial Statements (${periodType})`,
          sourceType: "TICKERTAPE",
          gcsPath,
          fileSize: buffer.length,
          mimeType: "text/plain",
          processingStatus: "READY",
          textContent: text.slice(0, 100_000), // Cap at ~100KB
          fetchedAt: new Date(),
        },
        update: {
          gcsPath,
          fileSize: buffer.length,
          textContent: text.slice(0, 100_000),
          processingStatus: "READY",
          isEmbedded: false, // Re-embed on next processing
          fetchedAt: new Date(),
        },
      });

      results.push(doc);
      logger.info(`Stored financial_statement for ${symbol} (${periodType})`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack =
        err instanceof Error
          ? err.stack?.split("\n").slice(0, 5).join("\n")
          : "";
      logger.error(
        `Failed to store financials for ${symbol} (${periodType}): ${errMsg}\n${errStack}`,
      );
    }
  }

  return results;
}

// ── NSE Filings: PDF download → GCS ────────────────────────────────

async function fetchAndStoreNSEFilings(
  symbol: string,
  exchange: string,
  instrumentId: string,
  docType: StockDocType,
  fetchFn: () => Promise<NSEFiling[]>,
  run: DocFetchRun,
): Promise<StockDocRecord[]> {
  const results: StockDocRecord[] = [];

  try {
    const filings = await fetchFn();
    if (!filings.length) return results;

    // Take the 5 most recent filings with attachment URLs
    const withAttachments = filings.filter((f) => f.attachmentUrl).slice(0, 5);

    for (const filing of withAttachments) {
      const period = extractPeriod(filing);

      // Check if already stored
      const exists = await prisma.stockDocument.findUnique({
        where: {
          symbol_exchange_docType_period: {
            symbol,
            exchange,
            docType,
            period,
          },
        },
      });

      if (exists) {
        results.push(exists);
        continue;
      }

      try {
        // Download PDF from NSE
        const downloaded = await downloadPdfFromNSE(filing.attachmentUrl!);
        if (!downloaded || downloaded.buffer.length < 1000) continue; // Skip empty/invalid PDFs
        const pdfBuffer = downloaded.buffer;

        const gcsPath = buildFullDocPath(symbol, docType, period, "pdf");

        // MONEY-1315 (B) — the BODY, not the header. This arm used to hardcode
        // `application/pdf` at the upload AND `processingStatus: "PENDING"` on
        // the row, so an NSE cookie-challenge page served with a 200 landed here
        // as a PENDING "PDF" carrying a gcsPath — a row nothing header-based
        // could ever have caught, queued for an extractor that will never read
        // it. MONEY-1319 replaced both literals; this guard still runs first,
        // because "are these bytes a document at all" is a different question
        // from "which container are they in", and it must answer BEFORE the
        // object exists.
        const gate = mayStoreDocumentBody({ gcsPath, body: pdfBuffer });
        if (!gate.store) {
          await quarantineHtmlDownload(run, {
            instrumentId,
            symbol,
            exchange,
            docType,
            period,
            title: filing.title || `${symbol} ${docType} ${period}`,
            description: filing.description,
            sourceUrl: filing.attachmentUrl!,
            sourceType: "NSE",
            reason: gate.reason,
          });
          await delay(FETCH_DELAY_MS);
          continue;
        }

        // MONEY-1319 — one value from the BYTES for both the object's content
        // type and the column. The literal that stood here is one of the four
        // sources of the 179 NSE ZIPs recorded as PDFs (NSE bundles a filing
        // with an XML sidecar and serves it under a `.pdf` name).
        const storedMimeType = resolveStoredMimeType({
          body: pdfBuffer,
          contentType: downloaded.contentType,
        });

        // Upload to GCS
        await uploadToStorage(gcsPath, pdfBuffer, storedMimeType);

        // Create DB record (processingStatus = PENDING - needs text extraction + embedding)
        const doc = await prisma.stockDocument.create({
          data: {
            instrumentId,
            symbol,
            exchange,
            docType,
            period,
            title: filing.title || `${symbol} ${docType} ${period}`,
            description: filing.description,
            sourceUrl: filing.attachmentUrl,
            sourceType: "NSE",
            gcsPath,
            fileSize: pdfBuffer.length,
            mimeType: storedMimeType,
            // From the media type the BYTES imply. A body no extractor can read
            // is not queued for anything, and `PENDING` about it makes the
            // extraction backlog overstate itself.
            processingStatus: initialProcessingStatus(storedMimeType),
            fetchedAt: new Date(),
          },
        });

        results.push(doc);
        logger.info(`Stored ${docType} PDF for ${symbol}: ${period}`);

        // Rate limit between downloads
        await delay(FETCH_DELAY_MS);
      } catch (err) {
        logger.warn(
          `Failed to download filing for ${symbol} (${period}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    logger.error(`Failed to fetch ${docType} filings for ${symbol}:`, err);
  }

  return results;
}

// ── Screener.in Documents (Concalls, Annual Reports) ───────────────

async function fetchAndStoreScreenerDocs(
  symbol: string,
  exchange: string,
  instrumentId: string,
  run: DocFetchRun,
  filterDocType?: StockDocType,
): Promise<StockDocRecord[]> {
  const results: StockDocRecord[] = [];

  try {
    const screenerDocs = await fetchScreenerDocuments(symbol);
    if (!screenerDocs || screenerDocs.length === 0) return results;

    // Filter by docType if specified
    const filtered = filterDocType
      ? screenerDocs.filter((d) => d.type === filterDocType)
      : screenerDocs.filter(
          (d) =>
            d.type === "concall_transcript" ||
            d.type === "concall_ppt" ||
            d.type === "annual_report",
        );

    for (const doc of filtered.slice(0, 10)) {
      if (!doc.url) continue;

      const docType = (
        doc.type === "concall_transcript" || doc.type === "concall_ppt"
          ? doc.type
          : doc.type === "annual_report"
            ? "annual_report"
            : "corporate_filing"
      ) as StockDocType;

      const period = doc.period || "unknown";

      // Check if already stored
      const exists = await prisma.stockDocument.findUnique({
        where: {
          symbol_exchange_docType_period: {
            symbol,
            exchange,
            docType,
            period,
          },
        },
      });

      if (exists) {
        results.push(exists);
        continue;
      }

      try {
        // Download the document with hard timeout (AbortController)
        const abortController = new AbortController();
        const downloadTimeout = setTimeout(
          () => abortController.abort(),
          30_000,
        );

        const resp = await ky.get(doc.url, {
          timeout: 15_000,
          signal: abortController.signal,
          throwHttpErrors: false,
        });
        if (!resp.ok) {
          clearTimeout(downloadTimeout);
          continue;
        }

        const arrayBuffer = await resp.arrayBuffer();
        clearTimeout(downloadTimeout);
        const rawContentType =
          resp.headers.get("content-type") || "application/pdf";
        const buffer = Buffer.from(arrayBuffer);

        if (buffer.length < 500) continue;

        // MONEY-1255 — the SECOND writer of `mimeType` from a raw header. It
        // stored the header verbatim, so `application/pdf;charset=UTF-8` landed
        // in a column the extract worker matches EXACTLY and the row could
        // never be selected; and a `text/html` error page landed as PENDING,
        // queued for an extractor that will never read it. Both decisions now
        // come from the shared leaf rather than from a local substring test
        // that drifted from the one in the worker.
        const contentType = normalizeDocMimeType(rawContentType);
        const ext = inferDocExtension(rawContentType);
        const gcsPath = buildFullDocPath(symbol, docType, period, ext);

        // MONEY-1315 (B) — THE REQUEST-TIME TWIN OF THE LEG THAT PRODUCED THEM.
        // This is a near line-for-line copy of `storeScreenerDoc` in
        // `workers/src/processors/stock-document-sync.ts`: the same Screener
        // links, the same `sourceType: "SCREENER"`, the same
        // `initialProcessingStatus`. All 1,573 quarantined rows came through
        // that shape, so leaving this one unguarded means a SINGLE research
        // query for a company with a DRHP link re-creates rows the migration
        // just cleared — with `gcsPath` set, `UNSUPPORTED`, and no way to tell
        // them from the ones it was run to remove.
        //
        // Refusing on the BODY also covers what the header never could: SEBI's
        // landing page served under `application/pdf` passes
        // `normalizeDocMimeType`, gets a `.pdf` object name, and lands PENDING.
        const gate = mayStoreDocumentBody({ gcsPath, body: buffer });
        if (!gate.store) {
          await quarantineHtmlDownload(run, {
            instrumentId,
            symbol,
            exchange,
            docType,
            period,
            title: doc.title,
            sourceUrl: doc.url,
            sourceType: "SCREENER",
            reason: gate.reason,
          });
          await delay(FETCH_DELAY_MS);
          continue;
        }

        // The OBJECT keeps the header it was served under — GCS metadata is
        // never matched on, and the raw value is genuine provenance.
        await uploadToStorage(gcsPath, buffer, rawContentType);

        const record = await prisma.stockDocument.create({
          data: {
            instrumentId,
            symbol,
            exchange,
            docType,
            period,
            title: doc.title,
            sourceUrl: doc.url,
            sourceType: "SCREENER",
            gcsPath,
            fileSize: buffer.length,
            mimeType: contentType,
            processingStatus: initialProcessingStatus(rawContentType),
            fetchedAt: new Date(),
          },
        });

        results.push(record);
        logger.info(`Stored ${docType} from Screener for ${symbol}: ${period}`);

        await delay(FETCH_DELAY_MS);
      } catch (err) {
        logger.warn(
          `Failed to download Screener doc for ${symbol} (${doc.type} ${period}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    logger.error(`Failed to fetch Screener documents for ${symbol}:`, err);
  }

  return results;
}

// ── PDF Download from NSE ──────────────────────────────────────────

async function downloadPdfFromNSE(
  url: string,
): Promise<{ buffer: Buffer; contentType: string | null } | null> {
  try {
    // NSE attachment URLs can be relative or absolute
    const fullUrl = url.startsWith("http") ? url : `${NSE_BASE}${url}`;

    const resp = await ky.get(fullUrl, {
      timeout: 30_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: `${NSE_BASE}/`,
      },
    });

    const arrayBuffer = await resp.arrayBuffer();
    // MONEY-1319 — the header comes back with the bytes. It does not decide the
    // stored media type (the bytes do), but it is the only fallback for a body
    // the sniffer cannot identify, and dropping it here left that fallback as
    // the same hardcoded literal this ticket exists to remove.
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: resp.headers.get("content-type"),
    };
  } catch (err) {
    logger.warn(
      `PDF download failed for ${url}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── Format financial data as human-readable text ───────────────────

/**
 * Field name mapping - maps abbreviated/source-specific field names to human-readable labels.
 * Covers Yahoo Finance, Tickertape, and Screener.in field naming conventions.
 */
const FIELD_LABELS: Record<string, string> = {
  // Income - Yahoo Finance
  revenue: "Revenue",
  totalRevenue: "Revenue",
  costOfRevenue: "Cost of Revenue",
  grossProfit: "Gross Profit",
  operatingIncome: "Operating Income",
  netIncome: "Net Income",
  ebitda: "EBITDA",
  // Income - Tickertape (abbreviated)
  incTrev: "Revenue",
  incOpe: "Operating Profit",
  incEbi: "EBITDA",
  incDep: "Depreciation",
  incPbi: "Profit Before Interest",
  incIoi: "Interest & Other Income",
  incPbt: "Profit Before Tax",
  incToi: "Tax & Other Items",
  incNinc: "Net Income",
  incEps: "EPS",
  incDps: "DPS",
  incPyr: "Payout Ratio",
  revenuef: "Revenue",
  netPftf: "Net Profit",
  operPftf: "Operating Profit",
  ebitdaf: "EBITDA",
  // Balance Sheet - Yahoo Finance
  totalAssets: "Total Assets",
  totalLiab: "Total Liabilities",
  totalStockholderEquity: "Shareholder Equity",
  longTermDebt: "Long-Term Debt",
  cash: "Cash",
  // Balance Sheet - Tickertape (abbreviated)
  balCsti: "Cash & Short-Term Investments",
  balTrec: "Total Receivables",
  balTinv: "Total Inventory",
  balOca: "Other Current Assets",
  balTca: "Total Current Assets",
  balNppe: "Net PP&E",
  balGint: "Goodwill & Intangibles",
  balLti: "Long-Term Investments",
  balOtha: "Other Non-Current Assets",
  balTota: "Total Assets",
  balAccp: "Accounts Payable",
  balOcl: "Other Current Liabilities",
  balTcl: "Total Current Liabilities",
  balTltd: "Total Long-Term Debt",
  balTdeb: "Total Debt",
  balDit: "Deferred Income Tax",
  balMint: "Minority Interest",
  balOthl: "Other Liabilities",
  balTotl: "Total Liabilities",
  balComs: "Common Stock",
  balApic: "Additional Paid-In Capital",
  balRtne: "Retained Earnings",
  balOeq: "Other Equity",
  balTeq: "Total Equity",
  balTlse: "Total Liabilities & Equity",
  balTcso: "Shares Outstanding",
  balNca: "Non-Current Assets",
  balCa: "Current Assets",
  balNcl: "Non-Current Liabilities",
  balTast: "Total Assets",
  balTlia: "Total Liabilities",
  balSheq: "Shareholder Equity",
  balBorr: "Borrowings",
  balCash: "Cash",
  balCaeq: "Cash Equivalents",
  totAstf: "Total Assets",
  totLblf: "Total Liabilities",
  totEqtf: "Total Equity",
  totDbtf: "Total Debt",
  cashEqf: "Cash",
  // Cash Flow - Yahoo Finance
  totalCashFromOperatingActivities: "Operating Cash Flow",
  capitalExpenditures: "Capital Expenditure",
  operatingCashFlow: "Operating Cash Flow",
  capitalExpenditure: "Capital Expenditure",
  freeCashFlow: "Free Cash Flow",
  // Cash Flow - Tickertape (abbreviated)
  cafCiwc: "Changes in Working Capital",
  cafCfoa: "Cash from Operations",
  cafCexp: "Capital Expenditure",
  cafCfia: "Cash from Investing",
  cafTcdp: "Total Cash Dividends Paid",
  cafCffa: "Cash from Financing",
  cafNcic: "Net Change in Cash",
  cafFcf: "Free Cash Flow",
  cshCfo: "Operating Cash Flow",
  cshCapx: "Capital Expenditure",
  cshFcf: "Free Cash Flow",
  cfoAf: "Operating Cash Flow",
  capExf: "Capital Expenditure",
  fcff: "Free Cash Flow",
  // Income - Tickertape (additional abbreviated)
  incRaw: "Raw Materials Cost",
  incPfc: "Power & Fuel Cost",
  incEpc: "Employee Cost",
  incSga: "Selling & Admin Expenses",
};

/** Skip these metadata fields when dumping all numeric values */
const SKIP_FIELDS = new Set(["period", "endDate", "chunkId", "stepNumber"]);

/**
 * Format a row of financial data as human-readable text.
 * Dumps ALL numeric fields with labels from the mapping, or raw field name if unmapped.
 */
function formatRow(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(row)) {
    if (SKIP_FIELDS.has(key)) continue;
    if (typeof val !== "number" || isNaN(val)) continue;
    const label = FIELD_LABELS[key] || key;
    parts.push(`${label}: ${formatNum(val)}`);
  }
  return parts.join(" | ");
}

export function formatFinancialsForDocument(
  financials: FinancialsResult,
  symbol: string,
  periodType: string,
): string {
  const lines: string[] = [];
  const label = periodType === "ANNUAL" ? "Annual" : "Quarterly";
  lines.push(`${symbol} - ${label} Financial Statements\n`);

  // Income Statement
  if (financials.income.length > 0) {
    lines.push(`Income Statement (${label}):`);
    for (const row of financials.income.slice(0, 8)) {
      const period = (row.period as string) || (row.endDate as string) || "";
      const data = formatRow(row);
      if (data) lines.push(`  ${period}: ${data}`);
    }
    lines.push("");
  }

  // Balance Sheet
  if (financials.balanceSheet.length > 0) {
    lines.push(`Balance Sheet (${label}):`);
    for (const row of financials.balanceSheet.slice(0, 8)) {
      const period = (row.period as string) || (row.endDate as string) || "";
      const data = formatRow(row);
      if (data) lines.push(`  ${period}: ${data}`);
    }
    lines.push("");
  }

  // Cash Flow
  if (financials.cashFlow.length > 0) {
    lines.push(`Cash Flow Statement (${label}):`);
    for (const row of financials.cashFlow.slice(0, 8)) {
      const period = (row.period as string) || (row.endDate as string) || "";
      const data = formatRow(row);
      if (data) lines.push(`  ${period}: ${data}`);
    }
    lines.push("");
  }

  lines.push(`Source: ${financials.source}`);
  return lines.join("\n");
}

// ── Helpers ────────────────────────────────────────────────────────

function formatNum(value: number | undefined | null): string {
  if (value == null) return "N/A";
  if (Math.abs(value) >= 1e9)
    return `₹${(value / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
  if (Math.abs(value) >= 1e7)
    return `₹${(value / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
  if (Math.abs(value) >= 1e5)
    return `₹${(value / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 1 })} L`;
  return `₹${value.toLocaleString("en-IN")}`;
}

function getStalenessKey(docType: string): string {
  switch (docType) {
    case "financial_statement":
      return "stock_docs_financial";
    case "quarterly_result":
      return "stock_docs_quarterly";
    case "annual_report":
      return "stock_docs_annual";
    default:
      return "stock_documents";
  }
}

function extractPeriod(filing: NSEFiling): string {
  // Try to extract period from title (e.g., "Q3 2024", "FY2024-25")
  const qMatch = filing.title.match(/Q[1-4]\s*[-–]?\s*(\d{4})/i);
  if (qMatch) return `Q${filing.title.match(/Q([1-4])/i)?.[1]}-${qMatch[1]}`;

  const fyMatch = filing.title.match(/FY\s*(\d{4})/i);
  if (fyMatch) return `FY${fyMatch[1]}`;

  // Fall back to the filing's IST calendar day — MONEY-1536: `filingDate` is
  // an IST-correct instant now, so local date parts would key a filing made
  // before 05:30 IST on the previous day in any UTC process.
  return toIstDateKey(filing.filingDate);
}

async function resolveInstrumentId(
  symbol: string,
  exchange: string,
): Promise<string | null> {
  const inst = await prisma.instrumentMapping.findFirst({
    where: { symbol, exchange, isActive: true },
    select: { id: true },
  });
  return inst?.id || null;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * File extension for a downloaded document, decided by the SAME normalizer
 * that decides the stored `mimeType` (MONEY-1255).
 *
 * This used to be an inline ternary over `contentType.includes(…)`, a third
 * copy of a rule that already existed twice. Deriving it from
 * `normalizeDocMimeType` is what makes "the object is named `.pdf`" and "the
 * row says `application/pdf`" the same claim rather than two that can disagree
 * — which is precisely how 1,211 rows became unreachable while every filename
 * on disk looked right.
 */
function inferDocExtension(contentType: string): string {
  const mime = normalizeDocMimeType(contentType);
  if (mime === CANONICAL_PDF_MIME_TYPE) return "pdf";
  if (mime.startsWith("text/")) return "txt";
  return "pdf";
}
