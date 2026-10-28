/**
 * Annual Reports + Integrated Filings Sync (MONEY-1098 — P5.5 + integrated
 * filings). I/O seam only: every decision worth testing lives in
 * `@usemoney/research/data-sources/issues-logic`, which this file imports and
 * CALLS (no shadow copies).
 *
 * ## Two legs, one daily job
 *
 * **Leg A — annual reports, weekly shard.** `stock-document-sync` only reaches
 * the hot tier (top-250 by `analysisCount`), so the long tail of listed
 * equities has never had an annual report ingested. This leg walks the WHOLE
 * active NSE equity universe on a 7-day rotation — roughly 600 symbols a day —
 * hitting `/api/annual-reports` per symbol and storing new PDFs exactly the way
 * `stock-document-sync` does: dedupe on the existing `(symbol, exchange,
 * docType, period)` row, upload to `stocks/{SYMBOL}/annual_report/`, upsert a
 * `PENDING` `StockDocument`, and let the extract → embed chain take it from
 * there.
 *
 * **Leg B — integrated filings, market-wide window.** SEBI's integrated-filing
 * regime publishes results filings through
 * `/api/integrated-filing-results?index=equities&from_date=&to_date=`, a
 * WINDOW query that returns the whole segment in one call — so it does not fan
 * out per symbol and does not belong on a per-symbol shard. It rides this job
 * as a second, independent leg (P1-verified endpoint; see
 * `docs/reference/exchange-archive-probe.json`), giving us a SECOND
 * results/filings metadata source alongside corporate-announcements.
 *
 * ## The legs are independent
 *
 * Each leg is wrapped in its own try/catch and emits its OWN summary line
 * (`[annual-reports-sync] leg A …` / `leg B …`), so a leg-B failure can never
 * be read as leg-A silence. Neither leg rethrows: both are idempotent, so a
 * Pub/Sub retry of the whole job would be SAFE — but it would also re-scrape
 * NSE for ~600 symbols to recover a failure in a single market-wide call, so a
 * partial failure is logged and ACKed rather than retried. Only a failure
 * before either leg starts (e.g. the DB is unreachable) escapes and 500s.
 *
 * ## Why both legs are idempotent
 *
 * Leg A keys on `period` = the report's own financial year, and skips any
 * `(symbol, period)` already stored — plus any report whose `sourceUrl` we have
 * already downloaded, which catches NSE re-publishing one PDF under two year
 * labels. Leg B keys on `IF-{broadcast day IST}-{basis+period}` derived from
 * the FILING's fields, never from "now", so the deliberately overlapping daily
 * windows (a filing broadcast at 23:00 IST lands after that evening's run)
 * re-read the same filings and update the same rows instead of duplicating
 * them.
 *
 * @see packages/research/src/data-sources/nse-issues.ts (fetchers)
 * @see packages/research/src/data-sources/issues-logic.ts (pure parsers/shard)
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import ky from "ky";
import prisma from "@usemoney/database";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";
import { getPubSubClient } from "@usemoney/pubsub/client";
import {
  fetchAnnualReports,
  fetchIntegratedFilings,
  buildNseAttachmentUrl,
} from "@usemoney/research/data-sources/nse-issues";
import {
  dedupeAnnualReports,
  dedupeIntegratedFilings,
  orderShardByStaleness,
  renderIntegratedFilingText,
  selectWeeklyShard,
  weekShardIndex,
  WEEKLY_SHARD_COUNT,
  type IntegratedFiling,
  type NseAnnualReport,
} from "@usemoney/research/data-sources/issues-logic";
import { buildFullDocPath } from "@usemoney/research/data-sources/stock-document-paths";
// MONEY-1315 (B) — the BODY sniff. The comment on the size floor below already
// named the exact failure ('A "PDF" this small is an error page NSE served with
// a 200') and defended against it with a LENGTH test, which only catches the
// error pages that happen to be short. The measured SEBI/NSE interstitials are
// 7,853-8,292 bytes, comfortably over `MIN_DOC_BUFFER_BYTES` (500), so the
// heuristic was blind to the population it was written for.
import {
  mayStoreDocumentBody,
  ABSENT_GCS_PATH,
  HTML_QUARANTINE_STATUS,
} from "@usemoney/research/data-sources/document-body-guard";
// MONEY-1319 — the media type comes from the BYTES, not from a literal. See the
// call site below for the 172 NSE ZIPs that literal produced.
import { resolveStoredMimeType } from "@usemoney/core/market-data/doc-container";
import { initialProcessingStatus } from "@usemoney/core/market-data/doc-mime";
import {
  NSE_BASE,
  MIN_DOC_BUFFER_BYTES,
  cleanSymbol,
  isValidEquitySymbol,
} from "./stock-document-sync-logic";
import { uploadToGCS } from "../lib/gcs";
import { publishDocumentIngest } from "../lib/doc-ingest-publish";

const logger = {
  info: (...args: unknown[]) => console.log("[annual-reports-sync]", ...args),
  warn: (...args: unknown[]) => console.warn("[annual-reports-sync]", ...args),
  error: (...args: unknown[]) => console.error("[annual-reports-sync]", ...args),
};

export type AnnualReportsSyncLeg = "annual_reports" | "integrated_filings";

export interface AnnualReportsSyncMessage {
  /** Explicit symbol list — bypasses the weekly shard (backfill / debugging). */
  symbols?: string[];
  /** Override today's shard (0-based). Lets ops replay a missed weekday. */
  shardIndex?: number;
  shardCount?: number;
  /** Hard cap on symbols visited this run, on top of the wall-clock budget. */
  maxSymbols?: number;
  /** Hard cap on PDF downloads this run (a cold shard would blow the budget). */
  maxDownloads?: number;
  /** Wall-clock budget for leg A, in ms. */
  budgetMs?: number;
  /** Politeness delay between symbols, in ms. */
  delayMs?: number;
  /** Re-download and re-upsert even when the row already exists. */
  forceRefresh?: boolean;
  /** Which legs to run. Default: both. */
  legs?: AnnualReportsSyncLeg[];
  /** Integrated-filing lookback window, in days. */
  filingWindowDays?: number;
  /**
   * Download integrated-filing attachments when a plausible attachment key
   * resolves. DEFAULT OFF — the attachment key name is UNVERIFIED (only
   * `attFileSize` is confirmed to exist), so downloading on a guessed key would
   * quietly fetch nothing and look identical to "these filings have no files".
   * Flip it on once a prod run reports a non-zero `withAttachment` count.
   */
  downloadFilingAttachments?: boolean;
  /** Override "now" for replay / deterministic runs (ISO string). */
  now?: string;
}

const DEFAULTS = {
  /**
   * 600ms between symbols. `stock-document-sync` uses 2,000ms because each of
   * its symbols fans out into Tickertape + NSE + Screener; this leg makes ONE
   * JSON call per symbol, and 2s would cap a run at ~240 of the ~600-symbol
   * shard.
   */
  delayMs: 600,
  /**
   * 480s of leg-A work against Cloud Run's 600s request timeout. The remaining
   * ~2 minutes is headroom for leg B plus the final chain publish. Exceeding
   * the timeout is not a slow run — it is a redelivered Pub/Sub message that
   * re-processes the same head forever.
   */
  budgetMs: 480_000,
  /** Bounded so a cold shard cannot spend the whole budget on PDF bytes. */
  maxDownloads: 300,
  /**
   * The last 3 financial years per symbol. Older reports are rarely asked
   * about and each is a multi-MB PDF; the cap is what keeps a first run over a
   * cold shard from being download-bound.
   */
  maxReportsPerSymbol: 3,
  /**
   * 3-day lookback. The window is deliberately WIDER than the 1-day cadence:
   * filings broadcast late at night land after that evening's run, and a
   * missed job (deploy, outage) would otherwise leave a permanent hole. Safe
   * because the period key is filing-derived, so re-reads update in place.
   */
  filingWindowDays: 3,
} as const;

export async function processAnnualReportsSync(
  message: AnnualReportsSyncMessage = {},
): Promise<void> {
  const now = resolveNow(message.now);
  const legs: AnnualReportsSyncLeg[] = message.legs ?? [
    "annual_reports",
    "integrated_filings",
  ];

  let docsCreated = 0;
  /** Downloads refused as HTML pages this run — MONEY-1315 (B). */
  let htmlRefusals = 0;

  if (legs.includes("annual_reports")) {
    try {
      const legA = await runAnnualReportsLeg(message, now);
      docsCreated += legA.created;
      htmlRefusals += legA.htmlRefusals;
    } catch (err) {
      // Leg-scoped: leg B must still run, and must still be able to report its
      // own outcome rather than inheriting leg A's silence.
      logger.error(
        `leg A ABORTED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (legs.includes("integrated_filings")) {
    try {
      docsCreated += await runIntegratedFilingsLeg(message, now);
    } catch (err) {
      logger.error(
        `leg B ABORTED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Same chain as stock-document-sync: newly stored PDFs land PENDING with
  // `textContent: null` and are invisible to the embedder until extracted. The
  // extract job no-ops when there is nothing PENDING and chains embed itself.
  // `selected` is the LEGS this run was asked to execute, `written` the
  // documents they stored — MONEY-1238.
  //
  // Legs rather than reports, because that is the granularity this function
  // actually has: each leg swallows its own failure so the other still runs, and
  // returns only a count of what it created. `selected > 0 && written === 0`
  // therefore means "we ran the legs and nothing landed", which IS the anomaly
  // the monitor is for. A run with no legs selected reports 0 and cannot alarm.
  //
  // Emitted BEFORE the conditional publish below and outside it, so a run that
  // created nothing — and therefore never publishes — still reports.
  const legsRun =
    (legs.includes("annual_reports") ? 1 : 0) +
    (legs.includes("integrated_filings") ? 1 : 0);
  // MONEY-1315 (B) — the refusals reach the OUTCOME, not only the leg's log
  // line. A shard whose NSE links have all rotted into interstitial pages
  // produces `written: 0` with zero transport failures, which is byte-identical
  // to a shard with nothing new to fetch; this clause is the only thing that
  // separates them. Appended to the existing reason rather than replacing it,
  // and emitted even on a run that DID write, because "we stored 12 and refused
  // 40" is the shape that says the source is degrading.
  const refusalClause =
    htmlRefusals > 0
      ? `${htmlRefusals} download(s) refused as HTML pages`
      : null;
  const zeroWriteReason =
    legsRun > 0 && docsCreated === 0
      ? `${legsRun} leg(s) ran and stored no documents`
      : null;
  const skippedReason = [zeroWriteReason, refusalClause]
    .filter((part): part is string => part !== null)
    .join("; ");

  reportJobOutcome({
    job: "annual-reports-sync",
    selected: legsRun,
    written: docsCreated,
    ...(skippedReason ? { skippedReason } : {}),
  });

  if (docsCreated > 0) {
    try {
      const pubsub = getPubSubClient();
      await pubsub
        .topic(getTopicName(PUBSUB_TOPICS.STOCK_DOCUMENT_EXTRACT))
        .publishMessage({ json: { batchSize: 50 } });
      logger.info(
        `Published stock-document-extract for ${docsCreated} new documents`,
      );
    } catch (err) {
      logger.warn(
        `Failed to trigger extraction: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

// ── Leg A: annual reports, weekly shard ──────────────────────────────────

async function runAnnualReportsLeg(
  message: AnnualReportsSyncMessage,
  now: Date,
): Promise<{ created: number; htmlRefusals: number }> {
  const startedAt = Date.now();
  const shardCount = positiveInt(message.shardCount, WEEKLY_SHARD_COUNT);
  const shardIndex =
    message.shardIndex !== undefined && Number.isFinite(message.shardIndex)
      ? Math.floor(message.shardIndex)
      : weekShardIndex(now, shardCount);
  const delayMs = nonNegativeInt(message.delayMs, DEFAULTS.delayMs);
  const budgetMs = positiveInt(message.budgetMs, DEFAULTS.budgetMs);
  const maxDownloads = positiveInt(message.maxDownloads, DEFAULTS.maxDownloads);

  // The universe: active NSE equities. `isValidEquitySymbol` is the SAME filter
  // stock-document-sync applies (indices, ETFs and debt series are not
  // companies and have no annual report), imported rather than re-declared.
  const universe = message.symbols?.length
    ? message.symbols.map(cleanSymbol).filter((s) => isValidEquitySymbol(s))
    : (
        await prisma.instrumentMapping.findMany({
          where: {
            isActive: true,
            instrumentType: "EQUITY",
            exchange: "NSE",
          },
          select: { symbol: true },
        })
      )
        .map((i) => cleanSymbol(i.symbol))
        .filter((s) => isValidEquitySymbol(s));

  const deduped = [...new Set(universe)];
  // An explicit `symbols` request is a backfill — it must NOT be re-sharded,
  // or asking for one symbol would usually return nothing.
  const shard = message.symbols?.length
    ? deduped
    : selectWeeklyShard(deduped, shardIndex, shardCount);

  if (shard.length === 0) {
    logger.info(
      `leg A summary | shard ${shardIndex}/${shardCount} | universe=${deduped.length} shard=0 — nothing to do`,
    );
    return { created: 0, htmlRefusals: 0 };
  }

  // ONE query serves three purposes: the staleness order, the already-stored
  // period set, and the already-downloaded sourceUrl set. Three separate
  // round-trips per symbol would be ~1,800 queries per run.
  const existingRows = await prisma.stockDocument.findMany({
    where: {
      exchange: "NSE",
      docType: "annual_report",
      symbol: { in: shard },
    },
    select: { symbol: true, period: true, fetchedAt: true, sourceUrl: true },
  });

  const lastFetchedAt = new Map<string, Date>();
  const storedPeriods = new Set<string>();
  const storedSourceUrls = new Set<string>();
  for (const row of existingRows) {
    const prev = lastFetchedAt.get(row.symbol);
    if (!prev || row.fetchedAt > prev) lastFetchedAt.set(row.symbol, row.fetchedAt);
    storedPeriods.add(`${row.symbol}|${row.period}`);
    if (row.sourceUrl) storedSourceUrls.add(`${row.symbol}|${row.sourceUrl}`);
  }

  // Stalest first, so the symbols the budget cut off LAST week are the ones
  // processed FIRST this week — the truncation point moves, and the shard
  // drains over a few cycles instead of the tail never being reached (the
  // documented failure of stock-document-sync's fixed head slice).
  const ordered = orderShardByStaleness(shard, lastFetchedAt).slice(
    0,
    positiveInt(message.maxSymbols, Number.MAX_SAFE_INTEGER),
  );

  const instruments = await prisma.instrumentMapping.findMany({
    where: { symbol: { in: ordered }, exchange: "NSE", isActive: true },
    select: { id: true, symbol: true },
  });
  const instrumentBySymbol = new Map(
    instruments.map((i) => [cleanSymbol(i.symbol), i.id]),
  );

  let visited = 0;
  let withReports = 0;
  let created = 0;
  let downloads = 0;
  let failed = 0;
  /** Downloads whose BODY sniffed as HTML — MONEY-1315 (B). */
  let htmlRefusals = 0;
  let budgetHit = false;

  for (const symbol of ordered) {
    if (Date.now() - startedAt > budgetMs) {
      budgetHit = true;
      break;
    }
    const instrumentId = instrumentBySymbol.get(symbol);
    if (!instrumentId) continue;

    try {
      visited++;
      const reports = dedupeAnnualReports(await fetchAnnualReports(symbol));
      if (reports.length > 0) withReports++;

      const fresh = reports
        .filter((r) => {
          if (message.forceRefresh) return true;
          if (storedPeriods.has(`${symbol}|${r.period}`)) return false;
          return !(
            r.attachmentUrl &&
            storedSourceUrls.has(`${symbol}|${r.attachmentUrl}`)
          );
        })
        .slice(0, DEFAULTS.maxReportsPerSymbol);

      for (const report of fresh) {
        if (downloads >= maxDownloads) break;
        downloads++;
        const outcome = await storeAnnualReport(report, symbol, instrumentId);
        // Counted on the ACTUAL refusal, after the body was inspected — never
        // before the download it describes. A counter incremented ahead of its
        // call is how Tickertape's 403 reported five months of work it never
        // did (MONEY-1255).
        if (outcome === "refused") htmlRefusals++;
        // A refusal also marks the (symbol, period) DONE for this run: the row
        // exists and is terminal, so re-attempting it inside the same run would
        // spend another NSE request to reach the identical verdict.
        if (outcome !== "none") {
          if (outcome === "stored") created++;
          storedPeriods.add(`${symbol}|${report.period}`);
          if (report.attachmentUrl) {
            storedSourceUrls.add(`${symbol}|${report.attachmentUrl}`);
          }
        }
      }
    } catch (err) {
      failed++;
      logger.warn(
        `${symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  logger.info(
    `leg A summary | shard ${shardIndex}/${shardCount} | universe=${deduped.length} ` +
      `shard=${shard.length} visited=${visited} withReports=${withReports} ` +
      `created=${created} downloads=${downloads} failed=${failed} ` +
      // Printed only when it happened, on the `describeSyncShortfall`
      // precedent: a zeroed clause on every run is how a summary becomes noise
      // nobody reads.
      (htmlRefusals > 0 ? `htmlRefusals=${htmlRefusals} ` : "") +
      `budgetHit=${budgetHit} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s` +
      (budgetHit
        ? ` — remainder deferred to the next run of this shard (stalest-first ordering picks it up)`
        : ""),
  );
  return { created, htmlRefusals };
}

/**
 * What ONE download attempt produced — MONEY-1315 (B).
 *
 *   stored    a real document reached GCS and the row points at it
 *   refused   the bytes were an HTML page; the row is TERMINAL and claims nothing
 *   none      nothing happened (no url, non-2xx, under the size floor, threw)
 *
 * A boolean could not carry this. `refused` is neither a success (nothing was
 * stored) nor a nothing (a row WAS written, and the count is the one number that
 * separates "NSE has nothing new" from "NSE is serving us interstitials"), and
 * folding it into `false` is exactly the silent `return 0` the guard was added
 * to remove in the sibling job.
 */
type AnnualReportStoreOutcome = "stored" | "refused" | "none";

/**
 * Download ONE annual report and upsert its `StockDocument`.
 * Never throws — one bad PDF must not end the symbol loop.
 */
async function storeAnnualReport(
  report: NseAnnualReport,
  symbol: string,
  instrumentId: string,
): Promise<AnnualReportStoreOutcome> {
  if (!report.attachmentUrl) return "none";
  const url = buildNseAttachmentUrl(report.attachmentUrl);

  try {
    const resp = await ky.get(url, {
      timeout: 30_000,
      throwHttpErrors: false,
      headers: {
        // NSE 403s a bot UA on the attachment host, and rejects a request with
        // no Referer — the same header pair `stock-document-sync` uses.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: `${NSE_BASE}/`,
      },
    });
    if (!resp.ok) return "none";

    const buffer = Buffer.from(await resp.arrayBuffer());
    // A "PDF" this small is an error page NSE served with a 200. Storing it
    // would create a READY-looking document with no content.
    //
    // MONEY-1315 (B) — that sentence is right about the cause and wrong about
    // the size. It is a SIZE test standing in for a CONTENT question, and it
    // only catches the short error pages: the interstitials measured on prod
    // are 7,853-8,292 bytes, sixteen times this floor. The body sniff below is
    // the test this comment was always describing.
    if (buffer.length < MIN_DOC_BUFFER_BYTES) return "none";

    const gcsPath = buildFullDocPath(
      symbol,
      "annual_report",
      report.period,
      "pdf",
    );

    // The BODY, not the header. 38 of the 1,573 rows the quarantine migration
    // found are `annual_report`, and their `sourceUrl` ENDS IN `.pdf`
    // (`bseindia.com/bseplus/AnnualReport/543766/74205590122.pdf`) while the
    // bytes are an interstitial page. The URL, the extension and the header can
    // all say PDF at once.
    const gate = mayStoreDocumentBody({ gcsPath, body: buffer });
    if (!gate.store) {
      await quarantineHtmlAnnualReport(report, symbol, instrumentId, gate.reason);
      return "refused";
    }

    // MONEY-1319 — this line used to be a literal `"application/pdf"`, and so
    // did the `mimeType` column below. That literal is how 172 NSE ZIPs came to
    // be recorded as PDFs: NSE serves an annual report BUNDLED
    // (`ACCELYA-annual_report-FY2023.pdf` unzips to a 1.75 MB
    // `AR_23907_ACCELYA_…pdf`), this leg named the object `.pdf` and stamped the
    // media type regardless. The rows then PASSED the extract query, were
    // selected every cycle, and failed — 126 of the 179 are already `FAILED`.
    //
    // The bytes decide, and the SAME value goes to the object's content type and
    // to the column, so the file and the row can never disagree the way
    // MONEY-1255's filename and column did.
    const storedMimeType = resolveStoredMimeType({
      body: buffer,
      contentType: resp.headers.get("content-type"),
    });

    await uploadToGCS(gcsPath, buffer, storedMimeType);

    const storedDoc = await prisma.stockDocument.upsert({
      where: {
        symbol_exchange_docType_period: {
          symbol,
          exchange: "NSE",
          docType: "annual_report",
          period: report.period,
        },
      },
      create: {
        instrumentId,
        symbol,
        exchange: "NSE",
        docType: "annual_report",
        period: report.period,
        title: `${report.companyName ?? symbol} Annual Report ${report.period}`,
        description: report.companyName ?? undefined,
        sourceUrl: report.attachmentUrl,
        sourceType: "NSE",
        gcsPath,
        fileSize: buffer.length,
        mimeType: storedMimeType,
        // Read off the media type the BYTES imply rather than hardcoded
        // `PENDING`: a body no extractor can read is not queued for anything,
        // and saying `PENDING` about it makes the backlog overstate itself.
        processingStatus: initialProcessingStatus(storedMimeType),
        fetchedAt: new Date(),
      },
      update: {
        sourceUrl: report.attachmentUrl,
        gcsPath,
        fileSize: buffer.length,
        // The column is refreshed on an update too. Without it a row keeps
        // whatever container it was FIRST stored with, so an upstream that
        // switches from a bundled ZIP to a bare PDF (or back) leaves the row
        // describing bytes that are no longer there.
        mimeType: storedMimeType,
        processingStatus: initialProcessingStatus(storedMimeType),
        isEmbedded: false,
        fetchedAt: new Date(),
      },
    });
    // MONEY-1314 — announce to the ingest lane. A no-op unless
    // DOC_INGEST_REALTIME="true" AND the row is a PDF, so it is safe to call
    // unconditionally; the gate lives in ONE place, not at fifteen writers.
    await publishDocumentIngest(storedDoc);

    logger.info(
      `Stored annual report ${symbol} ${report.period} (${buffer.length} bytes)`,
    );
    return "stored";
  } catch (err) {
    logger.warn(
      `Annual report download failed for ${symbol} ${report.period}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "none";
  }
}

/**
 * Record an annual-report download whose body turned out to be an HTML page —
 * MONEY-1315 (B).
 *
 * A separate function rather than an inline block inside `storeAnnualReport`,
 * for the same reason `quarantineHtmlDownload` is one in `stock-document-sync`:
 * the refusal must stay far from the real store's `publishDocumentIngest`.
 * `doc-ingest-publish-coverage.test.ts` decides whether a write "announces" by
 * scanning the 3,000 characters after it, so an inline refusal forty lines
 * above the real upsert reads as ANNOUNCING and silently leaves that scan blind
 * at this site — a check passing for the wrong reason.
 *
 * It must NOT announce: there are no document bytes. The row exists to hold the
 * citation, not a key the ingest lane could read.
 */
async function quarantineHtmlAnnualReport(
  report: NseAnnualReport,
  symbol: string,
  instrumentId: string,
  reason: string,
): Promise<void> {
  await prisma.stockDocument.upsert({
    where: {
      symbol_exchange_docType_period: {
        symbol,
        exchange: "NSE",
        docType: "annual_report",
        period: report.period,
      },
    },
    create: {
      instrumentId,
      symbol,
      exchange: "NSE",
      docType: "annual_report",
      period: report.period,
      title: `${report.companyName ?? symbol} Annual Report ${report.period}`,
      description: report.companyName ?? undefined,
      sourceUrl: report.attachmentUrl,
      sourceType: "NSE",
      // The shared terminal state, imported from the module the quarantine
      // MIGRATION writes from, so a row refused here and a row cleaned up there
      // can never end in two different states.
      gcsPath: ABSENT_GCS_PATH,
      fileSize: 0,
      mimeType: "text/html",
      processingStatus: HTML_QUARANTINE_STATUS,
      fetchedAt: new Date(),
    },
    // EMPTY on purpose. `forceRefresh` re-downloads reports we already hold;
    // blanking a good `gcsPath` because today's fetch hit a transient challenge
    // page would destroy the document and leave only `sourceUrl` to recover it
    // from. The refusal is still counted and logged.
    update: {},
  });

  logger.warn(
    `REFUSED NSE annual_report for ${symbol} ${report.period}: ` +
      `${reason} (${report.attachmentUrl})`,
  );
}

// ── Leg B: integrated filings, market-wide window ────────────────────────

async function runIntegratedFilingsLeg(
  message: AnnualReportsSyncMessage,
  now: Date,
): Promise<number> {
  const startedAt = Date.now();
  const windowDays = positiveInt(
    message.filingWindowDays,
    DEFAULTS.filingWindowDays,
  );
  const from = new Date(now.getTime() - windowDays * 86_400_000);

  const fetched = await fetchIntegratedFilings(from, now);

  // A failed FETCH and an empty WINDOW are different facts and must not share a
  // log line. The previous version claimed to distinguish them but could not —
  // the fetcher collapsed both to `[]` — so a transport failure was reported as
  // probable shape drift, sending the reader to look for a parser bug that did
  // not exist. It also explains a missing archive object, which a genuinely
  // empty 200 would still have produced.
  if (fetched === null) {
    logger.warn(
      `leg B summary | window ${windowDays}d | FETCH FAILED — no response from ` +
        `NSE (non-2xx, challenge page or timeout). Nothing was parsed and ` +
        `nothing was archived; this is NOT an empty window.`,
    );
    return 0;
  }

  const filings = dedupeIntegratedFilings(fetched);

  if (filings.length === 0) {
    // Now genuinely distinguished: NSE answered, so a zero here after a 200 is
    // the shape-drift signature this feed is most likely to fail with.
    logger.info(
      `leg B summary | window ${windowDays}d | filings=0 — NSE returned no ` +
        `usable rows (empty window, or the response shape changed: only ` +
        `attFileSize/audited/broadcast_Date/cmName/consolidated/creation_Date ` +
        `are confirmed keys)`,
    );
    return 0;
  }

  const symbols = [...new Set(filings.map((f) => f.symbol))];
  const instruments = await prisma.instrumentMapping.findMany({
    where: { symbol: { in: symbols }, exchange: "NSE", isActive: true },
    select: { id: true, symbol: true },
  });
  const instrumentBySymbol = new Map(
    instruments.map((i) => [cleanSymbol(i.symbol), i.id]),
  );

  const existing = await prisma.stockDocument.findMany({
    where: {
      exchange: "NSE",
      docType: "integrated_filing",
      symbol: { in: symbols },
    },
    select: { symbol: true, period: true },
  });
  const storedPeriods = new Set(
    existing.map((row) => `${row.symbol}|${row.period}`),
  );

  let created = 0;
  let skippedExisting = 0;
  let unresolvedSymbol = 0;
  let withAttachment = 0;
  let failed = 0;

  for (const filing of filings) {
    if (filing.attachmentUrl) withAttachment++;
    const instrumentId = instrumentBySymbol.get(filing.symbol);
    if (!instrumentId) {
      // Not an error: NSE's equities window includes symbols we do not carry
      // (newly listed, SME, suspended). Counted so a SPIKE is visible — a
      // sudden all-unresolved run means the symbol key moved, not that the
      // market delisted.
      unresolvedSymbol++;
      continue;
    }
    if (!message.forceRefresh && storedPeriods.has(`${filing.symbol}|${filing.period}`)) {
      skippedExisting++;
      continue;
    }
    try {
      if (await storeIntegratedFiling(filing, instrumentId)) {
        created++;
        storedPeriods.add(`${filing.symbol}|${filing.period}`);
      }
    } catch (err) {
      failed++;
      logger.warn(
        `${filing.symbol} ${filing.period}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  logger.info(
    `leg B summary | window ${windowDays}d (${from.toISOString().slice(0, 10)}..${now
      .toISOString()
      .slice(0, 10)}) | filings=${filings.length} created=${created} ` +
      `skippedExisting=${skippedExisting} unresolvedSymbol=${unresolvedSymbol} ` +
      `withAttachment=${withAttachment} failed=${failed} ` +
      `elapsed=${Math.round((Date.now() - startedAt) / 1000)}s` +
      (withAttachment === 0
        ? ` — no row carried a resolvable attachment key; the metadata-only ` +
          `decision holds (see INTEGRATED_FILING_FILE_KEYS)`
        : ` — attachment keys DO resolve; revisit downloadFilingAttachments`),
  );
  return created;
}

/**
 * Store ONE integrated filing as a metadata `StockDocument`.
 *
 * METADATA, NOT A PDF — deliberately. The P1 sample carries `attFileSize:
 * "0 Bytes"` and no confirmed attachment-path key, so there is nothing to
 * download; and a row whose `gcsPath` pointed at a non-existent object would be
 * a landmine for every consumer that trusts the path. Instead the raw row is
 * archived as JSON (the `screener_shareholding` / `corporate_actions` snapshot
 * precedent) and a rendered summary goes into `textContent`, so the filing is
 * retrievable by RAG immediately: status `READY`, no extraction needed.
 *
 * When an attachment key DOES resolve it is preserved in `sourceUrl` — the
 * citation link works today, and a later pass can fetch the bytes without
 * re-reading the window.
 */
async function storeIntegratedFiling(
  filing: IntegratedFiling,
  instrumentId: string,
): Promise<boolean> {
  const text = renderIntegratedFilingText(filing);
  const json = JSON.stringify(filing.raw, null, 2);
  const buffer = Buffer.from(json, "utf-8");
  const gcsPath = buildFullDocPath(
    filing.symbol,
    "integrated_filing",
    filing.period,
    "json",
  );

  await uploadToGCS(gcsPath, buffer, "application/json");

  await prisma.stockDocument.upsert({
    where: {
      symbol_exchange_docType_period: {
        symbol: filing.symbol,
        exchange: "NSE",
        docType: "integrated_filing",
        period: filing.period,
      },
    },
    create: {
      instrumentId,
      symbol: filing.symbol,
      exchange: "NSE",
      docType: "integrated_filing",
      period: filing.period,
      title: `${filing.companyName ?? filing.symbol} Integrated Filing ${filing.period}`,
      description: filing.relatingTo ?? undefined,
      sourceUrl: filing.attachmentUrl
        ? buildNseAttachmentUrl(filing.attachmentUrl)
        : `${NSE_BASE}/companies-listing/corporate-filings-integrated-filing`,
      sourceType: "NSE",
      gcsPath,
      fileSize: buffer.length,
      mimeType: "application/json",
      // READY, not PENDING: the text is already here. PENDING would send the
      // extract worker after a JSON file it cannot parse as a PDF, and mark it
      // FAILED.
      processingStatus: "READY",
      textContent: text,
      fetchedAt: new Date(),
    },
    update: {
      sourceUrl: filing.attachmentUrl
        ? buildNseAttachmentUrl(filing.attachmentUrl)
        : undefined,
      gcsPath,
      fileSize: buffer.length,
      textContent: text,
      processingStatus: "READY",
      isEmbedded: false,
      fetchedAt: new Date(),
    },
  });
  return true;
}

// ── Small helpers ────────────────────────────────────────────────────────

function resolveNow(raw?: string): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  // An unparseable override must not become an Invalid Date: every window and
  // shard computation downstream would silently become NaN.
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
