/**
 * NSE Corporate Announcements Sync Processor — MONEY-1098 (P5.1).
 *
 * Pulls the WHOLE-MARKET NSE announcements feed
 * (`/api/corporate-announcements`, no `symbol` param) over a 2-day window
 * through the existing cookie client, classifies each row into a docType,
 * archives the attachment PDF to GCS and upserts a `StockDocument` so the
 * filing flows through the same extract → embed chain as every other document.
 *
 * ## Shape
 *
 * Deliberately the same shape as `bse-announcements-sync.ts` — same constants
 * style, same per-symbol GCS layout (`stocks/{SYMBOL}/{docType}/`), same
 * per-row isolation, same paced+capped attachment downloads behind a run-level
 * circuit breaker. Every judgement it makes is delegated to the pure
 * `nse-announcements-sync-logic.ts` so it can be tested without NSE.
 *
 * ## Two deliberate differences from the BSE leg
 *
 * 1. **Dedupe against BSE.** SEBI's single-filing regime (2025) means both
 *    exchanges disseminate the SAME document, so without a check this worker
 *    would double every filing already ingested by `bse-announcements-sync`.
 *    See {@link decideNseAnnouncementDedupe}.
 * 2. **No row when the attachment can't be fetched.** BSE stores a `FAILED`
 *    row with `fileSize: 0`; because the unique key is the filing id, that row
 *    then makes the sync skip the filing forever and never retry the PDF. Here
 *    a failed download writes NOTHING, so the next run's overlapping window
 *    picks it up again. It also keeps size-0 rows — which are poison as dedupe
 *    targets — out of the table.
 *
 * Idempotent per day: the `@@unique([symbol, exchange, docType, period])` key on
 * `period = nse-{seq_id}` means a re-run finds its own rows and skips before
 * spending a download.
 *
 * Cron: daily 21:15 IST, prod-only (scrape-once).
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import { uploadFile } from "@usemoney/storage";
import { fetchNseApiJson } from "@usemoney/research/data-sources/nse-filings";
import {
  buildFullDocPath,
  type StockDocType,
} from "@usemoney/research/data-sources/stock-document-paths";
import {
  ATTACHMENT_TIMEOUT_MS,
  DEDUPE_CANDIDATE_LIMIT,
  DEDUPE_WINDOW_MS,
  GCS_WRITE_TIMEOUT_MS,
  MAX_PDF_DOWNLOADS_PER_RUN,
  RUN_BUDGET_MS,
  buildAnnouncementPeriod,
  buildAnnouncementsPath,
  classifyNseAnnouncement,
  computeAnnouncementWindow,
  decideNseAnnouncementDedupe,
  isUsablePdf,
  parseNseAnnouncementRows,
  planPdfDownload,
  splitGcsPath,
  type DedupeCandidate,
  type PacingReason,
  type PacingState,
} from "./nse-announcements-sync-logic";
import { publishDocumentIngest } from "../lib/doc-ingest-publish";
// MONEY-1319 — the media type comes from the BYTES, not from a literal. See
// the call site below for the 7 NSE ZIPs this leg's literal produced.
import { resolveStoredMimeType } from "@usemoney/core/market-data/doc-container";
import { initialProcessingStatus } from "@usemoney/core/market-data/doc-mime";

const logger = {
  info: (...args: unknown[]) => console.log("[nse-ann-sync]", ...args),
  warn: (...args: unknown[]) => console.warn("[nse-ann-sync]", ...args),
  error: (...args: unknown[]) => console.error("[nse-ann-sync]", ...args),
};

/**
 * Pub/Sub payload. Declared here rather than in `@usemoney/types/pubsub`
 * because that file is outside this change's surface — promote it there when
 * the route is wired (see the P5.1 report).
 */
export interface NseAnnouncementsSyncMessage {
  /** Window bounds as `YYYY-MM-DD`; omitted = the default 2-day window. */
  fromDate?: string;
  toDate?: string;
  /** Inclusive window width in calendar days (default 2, max 31). */
  windowDays?: number;
}

/** Browser-ish headers — nsearchives 403s an obviously scripted client. */
const ATTACHMENT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://www.nseindia.com/",
} as const;

/** A resolved instrument — a `StockDocument` needs a real instrumentId. */
interface ResolvedInstrument {
  id: string;
  symbol: string;
  exchange: string;
}

/**
 * Resolve an NSE trading symbol to an InstrumentMapping, preferring the NSE
 * listing (these rows ARE NSE's, so a dual-listed company must not be filed
 * under its BSE row). Memoised per run — a busy day repeats the same handful of
 * symbols dozens of times and each miss is a round trip.
 */
async function resolveInstrument(
  symbol: string,
  cache: Map<string, ResolvedInstrument | null>,
): Promise<ResolvedInstrument | null> {
  const cached = cache.get(symbol);
  if (cached !== undefined) return cached;

  const hit = await prisma.instrumentMapping.findFirst({
    where: {
      symbol,
      exchange: { in: ["NSE", "BSE"] },
      isActive: true,
      instrumentType: "EQUITY",
    },
    select: { id: true, symbol: true, exchange: true },
    orderBy: { exchange: "desc" }, // "NSE" sorts after "BSE" → desc puts NSE first
  });

  const resolved = hit ?? null;
  cache.set(symbol, resolved);
  return resolved;
}

/**
 * Download an attachment PDF. Returns the bytes, or null on any failure
 * (non-2xx, an NSE challenge page, a body too small to be a PDF, a timeout).
 *
 * Never throws: the caller turns a null into a breaker tick, and a run of them
 * into a stopped run. Distinguishing "this PDF is missing" from "we are being
 * throttled" is impossible at a single call site here — NSE answers a throttled
 * client with a 200-carrying HTML challenge — so the two are handled the same
 * way and only the CONSECUTIVE count is treated as a signal.
 *
 * MONEY-1319 — the `content-type` comes back WITH the bytes. It does not decide
 * the stored media type (the bytes do, via `resolveStoredMimeType`), but it is
 * the fallback for a body the sniffer cannot identify, and dropping it here
 * would leave that fallback as the hardcoded literal this ticket removes.
 */
async function downloadAttachment(
  url: string,
): Promise<{ buffer: Buffer; contentType: string | null } | null> {
  try {
    const res = await fetch(url, {
      headers: { ...ATTACHMENT_HEADERS },
      signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    // `isUsablePdf` scans a 1 KB WINDOW for `%PDF-`, and that is precisely how
    // 7 of the 179 NSE ZIPs got in under this job: a STORED first member puts
    // the contained PDF's own header ~40 bytes into the archive, inside the
    // window. It stays as the "are these bytes worth keeping at all" gate;
    // WHICH container they are is `resolveStoredMimeType`'s call at the write,
    // where the offset-0 magics are tested before any window scan.
    return isUsablePdf(buffer)
      ? { buffer, contentType: res.headers.get("content-type") }
      : null;
  } catch (err) {
    logger.warn(
      `attachment fetch failed (${url}): ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Existing `StockDocument` rows this filing might duplicate.
 *
 * Not restricted to `sourceType: "BSE"`. The BSE leg is the reason this check
 * exists, but NSE also re-broadcasts a filing under a NEW `seq_id` often enough
 * that the unique-key skip alone would let those through, and an intra-NSE
 * duplicate counts exactly as much as a cross-exchange one.
 *
 * `fetchedAt` stands in for the filing date — `StockDocument` has no filing-date
 * column, and both legs run within an hour of each other on the same evening,
 * so the ±1 day window covers the gap comfortably.
 */
async function loadDedupeCandidates(
  symbol: string,
  filedAtMs: number,
): Promise<DedupeCandidate[]> {
  const rows = await prisma.stockDocument.findMany({
    where: {
      symbol,
      fetchedAt: {
        gte: new Date(filedAtMs - DEDUPE_WINDOW_MS),
        lte: new Date(filedAtMs + DEDUPE_WINDOW_MS),
      },
    },
    select: {
      id: true,
      symbol: true,
      docType: true,
      title: true,
      fileSize: true,
      fetchedAt: true,
      sourceType: true,
    },
    take: DEDUPE_CANDIDATE_LIMIT,
  });

  return rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    docType: row.docType,
    title: row.title,
    fileSize: row.fileSize,
    filedAtMs: row.fetchedAt.getTime(),
    sourceType: row.sourceType,
  }));
}

/**
 * The two collaborators a test needs to reach this job's exits — MONEY-1328.
 *
 * Defaults ARE the production path, so the route passes nothing. Deliberately
 * NARROW: `fetchJson` is the only upstream, and the three exits this ticket is
 * about (the fetch throw, the empty window, and the ordinary fall-through over
 * rows that classify as noise or carry no attachment) are all reachable with no
 * Prisma handle and no GCS client. Widening this to the write path would be a
 * different test with a different subject.
 */
export interface NseAnnouncementsSyncDeps {
  fetchJson?: (path: string) => Promise<unknown>;
  reportOutcome?: typeof reportJobOutcome;
}

export async function processNseAnnouncementsSync(
  data: NseAnnouncementsSyncMessage,
  deps: NseAnnouncementsSyncDeps = {},
): Promise<void> {
  const fetchJson =
    deps.fetchJson ?? ((p: string) => fetchNseApiJson<unknown>(p));
  const report = deps.reportOutcome ?? reportJobOutcome;
  const fetchWindow = computeAnnouncementWindow(new Date(), {
    ...(data.fromDate !== undefined ? { fromDate: data.fromDate } : {}),
    ...(data.toDate !== undefined ? { toDate: data.toDate } : {}),
    ...(data.windowDays !== undefined ? { windowDays: data.windowDays } : {}),
  });

  logger.info(
    `NSE announcements sync ${fetchWindow.from}..${fetchWindow.to} ` +
      `(${fetchWindow.windowDays}d window)`,
  );

  const raw = await fetchJson(buildAnnouncementsPath(fetchWindow));
  if (raw === null) {
    // Null is "we could not read it" — a 403 challenge, a timeout, a shape we
    // can't parse. THROW so the route answers 500 and Pub/Sub retries: NSE's
    // announcement archive thins out over time, so a lost evening is not
    // recoverable later by simply waiting.
    throw new Error(
      `NSE announcements fetch returned nothing for ` +
        `${fetchWindow.from}..${fetchWindow.to}`,
    );
  }

  const rows = parseNseAnnouncementRows(raw);
  logger.info(`Fetched ${rows.length} announcement rows`);
  // MONEY-1328 — there is deliberately NO `if (rows.length === 0) return;`
  // here, and its absence is the fix rather than an oversight.
  //
  // That early return sat ~215 lines above the only `reportJobOutcome` in this
  // file, so an empty window left the job having emitted NOTHING: the route
  // ACKed 200, the 21:15 schedule looked like it ran, and the metric series
  // simply had a hole in it that no query can tell from a quiet market. It is
  // `stock-document-extract`'s defect verbatim (MONEY-1255), in the whole-market
  // NSE announcements leg.
  //
  // The exit is REMOVED rather than given a second report site. It bought
  // nothing but skipping a `Map` allocation and a loop over zero rows, and
  // falling through reports `selected 0 / written 0` from the one place that
  // already knows how to describe this run — so there is no second copy of the
  // outcome shape to drift from the first. A row-less window is genuinely idle
  // (a holiday), and 0/0 is exactly the "genuinely idle" row of the
  // clamped-difference monitor's truth table; an upstream that would not answer
  // does NOT arrive here at all, it throws above.
  const instrumentCache = new Map<string, ResolvedInstrument | null>();
  const pacing: PacingState = { attempted: 0, consecutiveFailures: 0 };
  // Wall-clock start for the run budget. The per-run download cap cannot bound
  // this job on its own — 500 x 1500ms is ~750s of sleep against a 600s ack
  // deadline — so a redelivery would land on top of a still-live run.
  const runStartedAt = Date.now();

  let ingestible = 0;
  let dropped = 0;
  let unresolved = 0;
  let noAttachment = 0;
  let alreadyStored = 0;
  let dedupedAgainstExisting = 0;
  let transcriptPrecedence = 0;
  let downloadFailed = 0;
  let deferred = 0;
  let stored = 0;
  /**
   * Set once the run stops downloading (per-run cap or circuit breaker). Both
   * are terminal for the run, so the remaining rows are counted and skipped
   * rather than each costing an `existing` lookup that can't lead anywhere.
   * Nothing is recorded for them, so tomorrow's overlapping window retries.
   */
  let stopReason: PacingReason | null = null;

  for (const row of rows) {
    if (stopReason) {
      deferred++;
      continue;
    }
    try {
      const classified = classifyNseAnnouncement(row.desc, row.attachmentText);
      if (!classified) {
        dropped++;
        continue;
      }
      ingestible++;

      if (!row.attachmentUrl) {
        // Text-only announcements (or an off-host attachment URL we refuse to
        // fetch). There is no document to archive, so there is no row to write.
        noAttachment++;
        continue;
      }

      const instrument = await resolveInstrument(row.symbol, instrumentCache);
      if (!instrument) {
        unresolved++;
        continue;
      }

      // Not a cast: an explicit annotation, so a docType this worker can emit
      // that ISN'T a member of StockDocType fails the build instead of writing
      // a row nothing downstream knows how to path or chunk.
      const docType: StockDocType = classified.docType;
      const period = buildAnnouncementPeriod(row.seqId, {
        filedAt: row.filedAt,
        desc: row.desc,
      });

      // Idempotency, BEFORE spending a download: our own prior run's row.
      const existing = await prisma.stockDocument.findUnique({
        where: {
          symbol_exchange_docType_period: {
            symbol: instrument.symbol,
            exchange: instrument.exchange,
            docType,
            period,
          },
        },
        select: { id: true },
      });
      if (existing) {
        alreadyStored++;
        continue;
      }

      // `hasAttachment` is true here, so the only non-ok reasons are the two
      // terminal ones — both end the run's downloading for good.
      const plan = planPdfDownload(pacing, {
        hasAttachment: true,
        elapsedMs: Date.now() - runStartedAt,
      });
      if (!plan.shouldDownload) {
        stopReason = plan.reason;
        deferred++;
        logger.warn(
          plan.reason === "circuit-open"
            ? `nsearchives failed ${pacing.consecutiveFailures} times in a row — ` +
                `stopping attachment downloads for this run; nothing is recorded ` +
                `for them, so tomorrow's overlapping window retries them`
            : plan.reason === "budget-spent"
              ? `spent the ${Math.round(RUN_BUDGET_MS / 1000)}s run budget after ` +
                `${pacing.attempted} downloads — stopping before the Pub/Sub ack ` +
                `deadline so a redelivery cannot land on a live run; the rest of ` +
                `this window is deferred to the next run`
              : `hit the ${MAX_PDF_DOWNLOADS_PER_RUN}-download run cap — the rest ` +
                `of this window is deferred to the next run`,
        );
        continue;
      }
      if (plan.delayMs > 0) {
        await new Promise((r) => setTimeout(r, plan.delayMs));
      }

      pacing.attempted++;
      const downloaded = await downloadAttachment(row.attachmentUrl);
      if (!downloaded) {
        pacing.consecutiveFailures++;
        downloadFailed++;
        continue;
      }
      const buffer = downloaded.buffer;
      pacing.consecutiveFailures = 0;

      // The byte-size gate needs the bytes, so dedupe necessarily runs AFTER
      // the download. We still save the GCS write and — the point of the whole
      // exercise — the duplicate row.
      const filedAtMs = (row.filedAt ?? new Date()).getTime();
      const decision = decideNseAnnouncementDedupe(
        {
          symbol: instrument.symbol,
          docType,
          title: row.desc,
          fileSize: buffer.length,
          filedAtMs,
          confidence: classified.confidence,
        },
        await loadDedupeCandidates(instrument.symbol, filedAtMs),
      );

      if (decision.skip) {
        dedupedAgainstExisting++;
        logger.info(
          `Skipping ${instrument.symbol} ${period} (${docType}) — duplicate of ` +
            `StockDocument ${decision.matchedId} (title similarity ` +
            `${decision.similarity?.toFixed(3)})`,
        );
        continue;
      }
      if (decision.reason === "confirmed-over-heuristic") {
        transcriptPrecedence++;
        logger.info(
          `Archiving ${instrument.symbol} ${period} as CONFIRMED ${docType} ` +
            `despite heuristic row ${decision.matchedId} of a different docType`,
        );
      }

      const gcsPath = buildFullDocPath(
        instrument.symbol,
        docType,
        period,
        "pdf",
      );
      const { folder, fileName } = splitGcsPath(gcsPath);

      // MONEY-1319 — this leg was the FIFTH writer stamping a literal
      // `application/pdf` on the object AND on the column, and it is the leg
      // that hits `nsearchives`, the single upstream behind 100% of the 179
      // ZIPs-stored-as-PDFs. 7 of them are `announcement` rows, i.e. this
      // job's. NSE bundles a filing with an XML sidecar and serves it under a
      // `.pdf` name; the row then PASSED `buildExtractQuery` and burned a
      // Document AI round trip every cycle.
      //
      // ONE value from the BYTES for both the object's content type and the
      // column, so the file and the row can never disagree the way MONEY-1255's
      // filename and column did. The `undecidable` policy is left at its
      // default (`stay-queued`): this leg previously hardcoded PENDING, so an
      // uncorroborated header must not now condemn a row to a terminal status
      // it would never have reached (MONEY-1319 review, M8).
      const storedMimeType = resolveStoredMimeType({
        body: buffer,
        contentType: downloaded.contentType,
      });

      await uploadFile({
        file: buffer,
        fileName,
        contentType: storedMimeType,
        ...(folder ? { folder } : {}),
        isPublic: false,
        timeoutMs: GCS_WRITE_TIMEOUT_MS,
      });

      // Upsert rather than create: the findUnique above is a read, so a Pub/Sub
      // redelivery running concurrently could otherwise lose the race on the
      // unique key and throw a row we already have.
      const storedDoc = await prisma.stockDocument.upsert({
        where: {
          symbol_exchange_docType_period: {
            symbol: instrument.symbol,
            exchange: instrument.exchange,
            docType,
            period,
          },
        },
        create: {
          instrumentId: instrument.id,
          symbol: instrument.symbol,
          exchange: instrument.exchange,
          docType,
          period,
          title: row.desc || `${instrument.symbol} NSE Announcement`,
          description: row.attachmentText || undefined,
          sourceUrl: row.attachmentUrl,
          sourceType: "NSE",
          gcsPath,
          fileSize: buffer.length,
          mimeType: storedMimeType,
          // Read off the media type the BYTES imply rather than a hardcoded
          // `PENDING`. It still resolves to PENDING for a PDF and for an
          // archive (the extract lane opens one since MONEY-1319), which is
          // what feeds the daily `stock-document-extract` cron 45 min after
          // this job and from there the embed chain — so no explicit chain
          // publish is needed here. A body no extractor can read is not queued
          // for anything, and `PENDING` about it makes the backlog overstate
          // itself.
          processingStatus: initialProcessingStatus(storedMimeType),
          fetchedAt: new Date(),
        },
        update: {
          gcsPath,
          fileSize: buffer.length,
          // Refreshed on update too: without it a row keeps the container it
          // was FIRST stored with, so an upstream switching between a bundled
          // ZIP and a bare PDF leaves the column describing bytes that are gone.
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
      stored++;
    } catch (err) {
      // Per-row isolation: a single bad row must not cost the rest of the
      // window. Run-level failures (the fetch above) still throw.
      logger.warn(
        `Failed to ingest ${row.symbol} (${row.seqId ?? "no seq_id"}): ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // `selected` is the INGESTIBLE rows — what survived noise-dropping and was
  // meant to land. `alreadyStored` and `dropped` were never candidates, so
  // neither can make a healthy run look like a failure.
  report({
    job: "nse-announcements-sync",
    selected: ingestible,
    written: stored,
    failed: downloadFailed + unresolved,
    ...(stopReason ? { skippedReason: stopReason } : {}),
  });

  logger.info(
    `Sync complete: ${stored} stored, ${dedupedAgainstExisting} deduped vs ` +
      `existing, ${transcriptPrecedence} confirmed-transcript overrides, ` +
      `${alreadyStored} already present, ${downloadFailed} download failures, ` +
      `${deferred} deferred${stopReason ? ` (${stopReason})` : ""}, ` +
      `${noAttachment} without an attachment, ${unresolved} unresolved ` +
      `symbols, ${dropped} dropped as noise ` +
      `(${ingestible} ingestible of ${rows.length})`,
  );
}
