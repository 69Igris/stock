/**
 * Stock Document Sync Worker
 *
 * Fetches and stores financial documents from all sources:
 * - "Tickertape" financial statements — see the warning below; this leg makes
 *   NO network call at all.
 * - NSE: Quarterly result PDFs, categorised announcement PDFs
 * - Screener: Concall transcripts, PPTs, annual reports, structured snapshots
 *
 * ## MONEY-1255 — 76.3% of active equities had NO document, and the cause was
 * ## that the batch never rotated
 *
 * Measured on prod 2026-08-26: 15,866 of 20,804 active equity rows carry no
 * document of any kind; only 2,614 of 18,331 distinct active symbols have one.
 *
 * The selection was `orderBy: { analysisCount: "desc" }` over a population
 * where `analysisCount` is 0 on ALL 10,444 active NSE equities (this repo
 * measured that itself and wrote it down in `news-sync-logic.ts`). With no
 * tiebreak and nothing in the run mutating the key, every trigger resolved the
 * identical order and re-synced the same ~250 symbols forever. Three things
 * were fixed together, because any one of them alone leaves the job broken:
 *
 *   - **The rotation.** Stale-first on `documentsSyncedAt`
 *     (`buildDocumentSyncOrderBy`), and every visited row is STAMPED — on
 *     success, on failure, on "nothing to fetch", and on the excluded-symbol
 *     path. A row that is selected and not stamped owns the head of a
 *     stale-first sort forever, which is how `annual-reports-sync` stalled.
 *   - **The deadline.** 249 x 2,000ms of politeness sleep plus 250 x 3,000ms
 *     of Screener self-throttle is 1,248s against a 600s ack deadline, before
 *     one HTTP round trip. The run is now bounded by
 *     `SYNC_RUN_TIME_BUDGET_MS` and continues by SELF-CHAINING, bounded by
 *     `MAX_SYNC_CHAIN_DEPTH` — a bound that never consults the database.
 *   - **The accounting.** Every per-source counter was incremented BEFORE the
 *     call it counted, so a source that 403s every request still reported a
 *     full count, and the run-health condition flagged `apiCalls.nse === 0` on
 *     a schedule that gates the NSE legs off by design — an alarm asserted on
 *     every healthy run. Counts are now documents WRITTEN, and the condition is
 *     leg-aware.
 */

import prisma from "@usemoney/database";
import type { StockDocumentSyncMessage } from "@usemoney/types/pubsub";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";
import { getOrFetchFinancials } from "@usemoney/research/data-sources/db-store";
import { getPubSubClient } from "@usemoney/pubsub/client";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { formatFinancialsForDocument } from "@usemoney/research/data-sources/stock-document-fetcher";
import { buildFullDocPath } from "@usemoney/research/data-sources/stock-document-paths";
import type { StockDocType } from "@usemoney/research/data-sources/stock-document-paths";
// MONEY-1315 (B) — the BODY sniff. `initialProcessingStatus` below decides from
// the DECLARED HEADER and is blind to a 200 that carries an HTML page under
// `application/pdf`; this one opens the bytes. See `document-body-guard.ts`.
import {
  mayStoreDocumentBody,
  HTML_QUARANTINE_STATUS,
  ABSENT_GCS_PATH,
} from "@usemoney/research/data-sources/document-body-guard";
import {
  fetchNSEFinancialResults,
  fetchCategorizedAnnouncements,
  type NSEFiling,
} from "@usemoney/research/data-sources/nse-filings";
import {
  scrapeScreenerFullPage,
  ScreenerRateLimitError,
  type ScreenerCompoundedGrowth,
} from "@usemoney/research/data-sources/screener-full-scraper";
// MONEY-1255 (A2) — screener COMPANY IDENTITY for the 2,389 companies listed
// only on BSE.
//
// The slug is the BSE SCRIP CODE, and BSE publishes the authority on scrip
// codes: `fetchBseScripMaster` is the same feed `instrument-sync-daily` already
// pulls nightly (through `getFeedAsset`, so it is archived/replayed like every
// other exchange file). Resolution is therefore an ISIN JOIN on an
// exchange-published key — no similarity judgement, no threshold, and ZERO
// extra requests to screener, which has 429'd us before (MONEY-853).
//
// `planScreenerSlugResolution` decides in CODE, from a row already in hand,
// because a Mongo `where` on either new field matches ZERO rows.
import {
  buildBseScripIndex,
  resolveScreenerSlugFromBse,
  planScreenerSlugResolution,
  SCREENER_SLUG_TTL_MS,
  type BseScripIndex,
} from "@usemoney/research/data-sources/screener-resolve";
import { fetchBseScripMaster } from "@usemoney/core/market-data/instruments/bse-master-instruments";
import { uploadToGCS } from "../lib/gcs";
import { publishDocumentIngest } from "../lib/doc-ingest-publish";
// getPubSubClient removed - no self-pagination needed
import ky from "ky";
import {
  DELAY_BETWEEN_SYMBOLS_MS,
  NSE_BASE,
  MIN_DOC_BUFFER_BYTES,
  MAX_SYMBOLS_PER_RUN,
  extractPeriod,
  cleanSymbol,
  isWithinApiLimit,
  normalizeScreenerDocType,
  inferExtension,
  buildNseUrl,
  buildTickertapeUrl,
  buildScreenerUrl,
  boundSymbolBatch,
  // MONEY-1255 — rotation, throughput and leg accounting. All pure and
  // unit-tested; the arithmetic that sizes each one lives on its declaration.
  buildDocumentSyncOrderBy,
  buildDocumentSyncWhere,
  isTickertapeOnlyRun,
  resolveSymbolPageSize,
  partitionSymbolPage,
  SYNC_RUN_TIME_BUDGET_MS,
  MAX_SYNC_CHAIN_DEPTH,
  isWithinSyncRunBudget,
  normalizeSyncChainDepth,
  shouldChainAnotherSyncBatch,
  NSE_ANNOUNCEMENT_DOC_TYPES,
  SCREENER_PAGE_DOC_TYPES,
  resolveEnabledLegs,
  resolveLegsForTarget,
  describeSyncShortfall,
  type EnabledLegs,
  type WritesBySource,
  type BseOnlyCounters,
} from "./stock-document-sync-logic";
// MONEY-1255 — the stored mimeType and the initial processingStatus are decided
// by the EXTRACTOR's own definition of what it can read, so both come from
// there rather than being restated at each write site.
import { initialProcessingStatus } from "@usemoney/core/market-data/doc-mime";
// MONEY-1319 — the media type comes from the BYTES. `storeNSEFiling` is one of
// the four writers that stamped a literal, which is how a ZIP came to be
// recorded as a PDF.
import { resolveStoredMimeType } from "@usemoney/core/market-data/doc-container";

const logger = {
  info: (...args: unknown[]) => console.log("[stock-doc-sync]", ...args),
  warn: (...args: unknown[]) => console.warn("[stock-doc-sync]", ...args),
  error: (...args: unknown[]) => console.error("[stock-doc-sync]", ...args),
};

/** The Prisma surface this job touches, so a test can hand in a fake. */
type Db = typeof prisma;

/**
 * Per-RUN state — MONEY-1238, and the urgent half of it.
 *
 * ## The bug this shape exists to make impossible
 *
 * `const apiCalls = { tickertape: 0, nse: 0, screener: 0, gcsUploads: 0 }` used
 * to sit at MODULE scope. Cloud Run keeps a container warm between invocations
 * and this module is loaded once per container, so the counters were never
 * reset: every invocation on that instance ADDED to the previous one's total.
 *
 * `API_LIMITS.screener` is 500 and a run works at most `MAX_SYMBOLS_PER_RUN`
 * (250) symbols, incrementing the screener counter once per symbol. So the
 * budget was exhausted after ~2 invocations and STAYED exhausted for the life
 * of the instance — `isWithinApiLimit("screener", 500)` is false forever. NSE
 * (2 per symbol, cap 2000) followed after ~4, Tickertape (2 per symbol, cap
 * 5000) after ~10. No error, no counter, no log line: the legs simply stopped
 * being entered, and the run still reported success.
 *
 * That is MONEY-853 rebuilt from the inside — a run where ZERO screener data
 * reaches GCS while another source's leg lands normally, which is the exact
 * silent-partial-failure shape the per-source counts in `skippedReason` were
 * added to expose. It does not need an unusual event to trigger: a run is 250
 * symbols x `DELAY_BETWEEN_SYMBOLS_MS` (2000ms) = 500s of sleeping alone,
 * before any network, against Pub/Sub's 600s ack deadline — which is Pub/Sub's
 * MAXIMUM and cannot be raised. Redelivery onto a warm instance is the NORMAL
 * case here, not the exceptional one.
 *
 * The tally is now created inside `processStockDocumentSync` and threaded to
 * every helper that spends budget. There is nothing left at module scope for a
 * second invocation to inherit.
 */
interface SyncRun {
  /**
   * ATTEMPTS spent by THIS invocation, per source — what the `API_LIMITS`
   * budget is drawn against. Deliberately NOT the health signal: every one of
   * these is incremented before the call it counts, so a source that 403s on
   * every request still produces a full-looking number. `wrote` is the health
   * signal.
   *
   * `tickertape` is the sharpest case and is worth naming: that leg issues NO
   * HTTP REQUEST AT ALL (see `getOrFetchFinancials` below), so this counter has
   * always been a count of Prisma reads. `TT=250` meant 250 database lookups
   * and `TT=0` could never occur.
   */
  api: {
    tickertape: number;
    nse: number;
    screener: number;
    gcsUploads: number;
  };
  /**
   * Documents that reached `stock_documents`, per source — MONEY-1255.
   *
   * The number the run-health condition reads. Incremented only after an
   * `upsert` returns, never before a call.
   */
  wrote: WritesBySource;
  /**
   * Documents skipped because we already hold a fresh copy. Counted, never
   * added to `written`: a freshness skip is the opposite of a write, and
   * counting it as one is what let `written: 500` mean "every source is dark".
   */
  skippedFresh: number;
  /**
   * Upstream calls that failed to produce an answer — an NSE/Screener throw, a
   * non-2xx download, a persistent 429. Passed to `reportJobOutcome` as
   * `transportFailures`, which is the only input to the "wrote 0 after N
   * UPSTREAM failure(s)" branch in `job-outcome.ts`; without it a total block
   * emits a clean 0/0/0, indistinguishable from a quiet week.
   */
  transportFailures: number;
  /**
   * Downloads REFUSED because the body sniffed as HTML — MONEY-1315 (B).
   *
   * A 200 carrying a SEBI landing page, an NSE cookie challenge or a rating
   * agency's error page is not a transport failure — the request succeeded —
   * and it is not a freshness skip either. It is a THIRD outcome, so it gets a
   * third counter rather than being folded into one of the two, which would
   * make a permanently-broken upstream link read as either a network blip or a
   * healthy no-op.
   *
   * Incremented on the ACTUAL refusal, after the sniff has looked at the bytes
   * — never before the download it describes. Every per-source counter in
   * `run.api` is incremented BEFORE its call, which is why a source that 403s
   * on every request still produces a full-looking number (MONEY-1255); this
   * one cannot do that, because there is nothing to count until the body
   * exists.
   */
  htmlRefusals: number;
  /**
   * Selected symbols whose only active listing is BSE — MONEY-1255.
   *
   * The page selects `exchange: { in: ["NSE","BSE"] }` but every leg here is
   * NSE-only, and the old code hardcoded `const exchange = "NSE"`, found no
   * instrument, and `continue`d with NO log line and NO counter. A BSE-only
   * symbol therefore consumed a slot and produced nothing, invisibly. It is
   * skipped, COUNTED and STAMPED, so it rotates to the back instead of
   * re-occupying the head.
   *
   * MONEY-1255 (A2) — it is no longer skipped. The sentence that used to stand
   * here, "nothing in this job can source an annual report for a BSE-only
   * company", was true of the NSE legs and of `stock_financials`, and false of
   * screener.in, which carries 8-13 years of annual reports for 11 of 12
   * sampled BSE-only companies. This counter now means "symbols the NSE legs
   * cannot serve", which is what it always measured; `bseOnly.served` says how
   * many of them the Screener leg actually reached.
   */
  noNseListing: number;
  /** What the BSE-only Screener path did — MONEY-1255 (A2). */
  bseOnly: BseOnlyCounters;
  /** Rows whose `documentsSyncedAt` was advanced. The rotation's progress. */
  stamped: number;
}

/** A fresh, zeroed tally. One per invocation, never shared. */
function newSyncRun(): SyncRun {
  return {
    api: { tickertape: 0, nse: 0, screener: 0, gcsUploads: 0 },
    wrote: { tickertape: 0, nse: 0, screener: 0 },
    skippedFresh: 0,
    transportFailures: 0,
    htmlRefusals: 0,
    noNseListing: 0,
    bseOnly: {
      served: 0,
      slugResolved: 0,
      slugMiss: 0,
      slugAmbiguous: 0,
      masterUnavailable: false,
    },
    stamped: 0,
  };
}

/**
 * Injectable seams — MONEY-1238. Production passes none of them, so the
 * defaults ARE the production path and the tests drive the same loop the
 * scheduler does.
 */
export interface StockDocumentSyncDeps {
  prisma?: Db;
  getOrFetchFinancials?: typeof getOrFetchFinancials;
  fetchNSEFinancialResults?: typeof fetchNSEFinancialResults;
  fetchCategorizedAnnouncements?: typeof fetchCategorizedAnnouncements;
  scrapeScreenerFullPage?: typeof scrapeScreenerFullPage;
  /**
   * BSE's scrip master — MONEY-1255 (A2), the authority the slug comes from.
   *
   * Injected like every other upstream so a test drives the real loop without
   * opening a socket. The default is the REAL fetcher, which means a fixture
   * that produces a BSE-only instrument and forgets this dep reaches
   * api.bseindia.com. That is deliberate: a default that quietly returned `[]`
   * would make the production path different from the tested one, and `[]` is
   * ALSO the real fetcher's "outage" answer — so the forgetful fixture would
   * silently exercise the outage branch while looking like a resolution test.
   */
  fetchBseScripMaster?: typeof fetchBseScripMaster;
  uploadToGCS?: typeof uploadToGCS;
  /** Chain the extract job. Injected so a test never opens a Pub/Sub client. */
  publishExtractJob?: () => Promise<void>;
  /**
   * Publish the NEXT link of the drain chain. Injected for the same reason, and
   * separately from the extract chain because the two fire on different
   * conditions and a test has to be able to observe them apart.
   */
  publishNextBatch?: (message: StockDocumentSyncMessage) => Promise<void>;
  /**
   * The raw document download, used by BOTH the NSE and Screener store helpers.
   *
   * MONEY-1255 — added as a seam because the per-source WRITE counters and the
   * non-2xx `transportFailures` ticks live inside those helpers, and with a
   * bare `ky.get` there was no way to reach either from a test. A counter no
   * test can observe is a counter no mutation can be caught in: deleting
   * `run.wrote.nse++` passed the entire suite. The default IS `ky.get`, so
   * production behaviour (headers, timeouts, abort signal) is unchanged — each
   * call site still passes its own options.
   */
  httpGet?: typeof ky.get;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, so the wall-clock budget is testable without waiting. */
  now?: () => number;
}

type ResolvedDeps = Required<StockDocumentSyncDeps>;

function resolveDeps(deps: StockDocumentSyncDeps): ResolvedDeps {
  return {
    prisma: deps.prisma ?? prisma,
    getOrFetchFinancials: deps.getOrFetchFinancials ?? getOrFetchFinancials,
    fetchNSEFinancialResults:
      deps.fetchNSEFinancialResults ?? fetchNSEFinancialResults,
    fetchCategorizedAnnouncements:
      deps.fetchCategorizedAnnouncements ?? fetchCategorizedAnnouncements,
    scrapeScreenerFullPage:
      deps.scrapeScreenerFullPage ?? scrapeScreenerFullPage,
    fetchBseScripMaster: deps.fetchBseScripMaster ?? fetchBseScripMaster,
    uploadToGCS: deps.uploadToGCS ?? uploadToGCS,
    publishExtractJob: deps.publishExtractJob ?? publishExtractJobViaPubSub,
    publishNextBatch: deps.publishNextBatch ?? publishNextBatchViaPubSub,
    httpGet: deps.httpGet ?? ky.get,
    sleep:
      deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? (() => Date.now()),
  };
}

/** What the run actually did. `written` is documents that reached the DB. */
export interface StockDocumentSyncResult {
  /** Symbols the job chose to work on. */
  selected: number;
  /** Documents created or updated in `stock_documents`. */
  written: number;
  /** Documents created or updated, split by the source that produced them. */
  wrote: WritesBySource;
  /** Documents we already held a fresh copy of, so nothing was written. */
  skippedFresh: number;
  /** Symbols whose whole pass threw. */
  failed: number;
  /** Upstream calls that failed to produce an answer. */
  transportFailures: number;
  /**
   * Downloads refused because the body was an HTML page — MONEY-1315 (B).
   * Their rows are written terminal (`gcsPath: ""`, `UNSUPPORTED`), never left
   * PENDING against bytes that are not a document.
   */
  htmlRefusals: number;
  /** Selected symbols with no active NSE listing (BSE-only). */
  noNseListing: number;
  /** What the BSE-only Screener path did — MONEY-1255 (A2). */
  bseOnly: BseOnlyCounters;
  /** Rows whose `documentsSyncedAt` was advanced — the rotation's progress. */
  stamped: number;
  /** Instrument ROWS the page returned (pre-dedupe, pre-filter). */
  rowsSelected: number;
  /** True when the wall-clock budget stopped the run short of the page. */
  stoppedOnBudget: boolean;
  /** True when a follow-up batch was published. */
  chained: boolean;
  /** External call ATTEMPTS THIS invocation spent, per source. */
  api: SyncRun["api"];
}

export async function processStockDocumentSync(
  message: StockDocumentSyncMessage,
  injected: StockDocumentSyncDeps = {},
): Promise<StockDocumentSyncResult> {
  const deps = resolveDeps(injected);
  const prisma = deps.prisma;
  // MONEY-1238 — created HERE, per invocation. See `SyncRun`.
  const run = newSyncRun();
  const apiCalls = run.api;
  const {
    symbols: requestedSymbols,
    forceRefresh = false,
    docTypes,
    batchSize = 10000,
  } = message;

  const explicitSymbols = !!requestedSymbols && requestedSymbols.length > 0;
  const chainDepth = normalizeSyncChainDepth(message.chainDepth);
  const startedAt = deps.now();
  const legs = resolveEnabledLegs(docTypes, message.sources);
  // MONEY-1255 — one predicate, checked before every new SYMBOL, before every
  // LEG and before every DOCUMENT DOWNLOAD. Checking only between symbols would
  // leave the in-flight term unbounded: one symbol can fan out to 5 quarterly
  // PDFs plus 5 announcement categories x 5 PDFs, each with a 30s timeout, so
  // the "one more unit" after the budget expires would be ~960s on its own —
  // larger than the entire deadline it is supposed to fit inside.
  const withinBudget = (): boolean =>
    isWithinSyncRunBudget(startedAt, deps.now());
  // MONEY-1255 (A2) — BSE's scrip master, fetched AT MOST ONCE per invocation
  // and only if a BSE-only symbol actually needs it. Held in a per-invocation
  // closure, never at module scope: Cloud Run keeps containers warm between
  // invocations, and module-scope run state is the exact bug MONEY-1238 fixed
  // in this file (counters that were never reset, so the API budget stayed
  // exhausted for the life of the instance).
  let bseIndexPromise: Promise<BseScripIndex> | null = null;
  const loadBseIndex = (): Promise<BseScripIndex> => {
    bseIndexPromise ??= deps
      .fetchBseScripMaster()
      .then(buildBseScripIndex)
      .catch((err) => {
        // `fetchBseScripMaster` already swallows its own failures and returns
        // [], so reaching here means something unexpected. An empty index is
        // the SAFE answer: it reports `unavailable`, which persists nothing.
        logger.warn(
          `BSE scrip master threw: ${err instanceof Error ? err.message : err}`,
        );
        return buildBseScripIndex([]);
      });
    return bseIndexPromise;
  };
  let stoppedOnBudget = false;
  let rowsSelected = 0;
  let pageSize = 0;

  logger.info(
    `Starting stock document sync (force: ${forceRefresh}, docTypes: ${docTypes?.join(",") || "all"}, ` +
      `sources: ${message.sources?.join(",") || "all"}, ` +
      `legs: TT=${legs.tickertape} NSE=${legs.nse} SCR=${legs.screener}, ` +
      `chainDepth: ${chainDepth}/${MAX_SYNC_CHAIN_DEPTH}, budget: ${SYNC_RUN_TIME_BUDGET_MS}ms)`,
  );

  // Resolve the symbols to process. MONEY-1255 — the SELECTION now carries the
  // exchange (`select: { symbol: true, exchange: true }`) so `partitionSymbolPage`
  // can prefer a dual-listed company's NSE row; the authoritative per-symbol
  // exchange is still re-read in the loop, because `cleanSymbol` can rewrite the
  // ticker and only the second lookup sees the value the writes are keyed on.
  let targets: Array<{ symbol: string; exchange: string | null }>;
  if (explicitSymbols) {
    // A caller-named list has not chosen a listing, so `null` means "resolve it
    // below" — the same NSE-preferring lookup a discovered row already went
    // through at selection time.
    targets = boundSymbolBatch(requestedSymbols!, batchSize).map((symbol) => ({
      symbol,
      exchange: null,
    }));
  } else {
    // MONEY-1255 — the page. `take` is the CLAMPED size, because that same
    // number is what `shouldChainAnotherSyncBatch` compares `rowsSelected`
    // against: passing `take: 8000` (what the scheduler sends) and then
    // clamping in code would make every page look drained.
    pageSize = resolveSymbolPageSize(batchSize);
    const instruments = await prisma.instrumentMapping.findMany({
      where: buildDocumentSyncWhere(isTickertapeOnlyRun(docTypes)),
      // The exchange is SELECTED, not assumed. See `SyncRun.noNseListing`.
      // `isin` is selected for MONEY-1257: it is what distinguishes a
      // digit-leading COMPANY symbol (3MINDIA, 360ONE) from the 3,766
      // digit-leading DEBT instruments that carry no ISIN at all.
      select: { symbol: true, exchange: true, isin: true },
      // Stale-first. The marker appears ONLY here and never in the `where` —
      // `{ documentsSyncedAt: null }` matches ZERO rows on Mongo because the
      // field is ABSENT rather than null on every pre-existing row. See
      // `buildDocumentSyncOrderBy`.
      orderBy: buildDocumentSyncOrderBy(),
      take: pageSize,
    });
    rowsSelected = instruments.length;

    const { eligible, bseOnly, excluded } = partitionSymbolPage(instruments);
    targets = eligible;
    if (bseOnly.length > 0) {
      // MONEY-1255 (A2) — sized BEFORE the loop spends the budget. A BSE-only
      // symbol costs a slug resolution plus a page scrape and can never enter
      // the two NSE legs, so this is the fraction of the page that is
      // Screener-only work.
      logger.info(
        `${bseOnly.length}/${eligible.length} selected symbol(s) are BSE-only ` +
          `— Screener leg only (${legs.screener ? "enabled" : "gated OFF by docTypes"})`,
      );
    }

    // The excluded rows are STAMPED, and that is not tidiness. They are
    // rejected by symbol PATTERN (index pseudo-symbols, ETF/debt prefixes
    // misfiled as EQUITY), so under a stale-first sort an unstamped excluded
    // row is selected first on every run, consumes a page slot, and is
    // filtered out again — forever. That is the same stall being fixed, one
    // level down.
    if (excluded.length > 0) {
      const n = await stampVisited(prisma, excluded);
      run.stamped += n;
      logger.info(
        `Skipped ${excluded.length} non-equity symbol(s) and stamped ${n} row(s) so they rotate`,
      );
    }
  }

  // MONEY-1255 — the "no symbols" EARLY RETURN is gone, and that is a fix
  // rather than a simplification. A page can come back FULL of rows and still
  // produce zero targets (every symbol excluded by pattern, or every row
  // BSE-only). The early return skipped the chain, so the run stopped with the
  // page unfinished; it also duplicated the outcome call, which is how the two
  // copies of `skippedReason` were free to drift. An empty `targets` now walks
  // the same tail as any other run: the loop is a no-op, `describeSyncShortfall`
  // returns "population gate selected no symbols" for `selected === 0`, and
  // `reportJobOutcome` does NOT warn on 0/0 — an empty population was never the
  // alarm, it was only ever meant not to be ABSENT (MONEY-1220).
  //
  // The old resource clamp that sat here is gone too, because it was applied to
  // the WRONG list. The discovered page is clamped by its own `take`
  // (`resolveSymbolPageSize`) and a caller-supplied list is clamped where it is
  // built. Re-slicing here re-imposed the "head-only, no cursor, tail DROPPED"
  // behaviour its own comment described — which, under a constant sort order,
  // is exactly why the same 250 symbols were processed forever.
  logger.info(
    `Processing ${targets.length} symbol(s) from ${rowsSelected || targets.length} row(s) ` +
      `(page ${pageSize || targets.length}, cap ${MAX_SYMBOLS_PER_RUN})`,
  );

  let processed = 0;
  let failed = 0;
  let totalDocs = 0;
  // MONEY-853 fix: once Screener starts a SUSTAINED 429 (per-IP rate limit /
  // quota exhaustion), stop hitting it for the rest of this run — otherwise the
  // whole-market loop hammers a tarpit for hours and every symbol 429s, so
  // ZERO screener data reaches GCS (the bug: only Tickertape landed).
  let screenerRateLimited = false;

  for (const target of targets) {
    const symbol = target.symbol;
    // MONEY-1255 — the wall clock, checked BEFORE the symbol is started. The
    // remainder of the page is left for the chained follow-up; it is NOT
    // dropped, because it was never stamped and therefore sorts first on the
    // next selection.
    if (!withinBudget()) {
      stoppedOnBudget = true;
      logger.warn(
        `Run budget reached after ${deps.now() - startedAt}ms — stopping at ` +
          `${processed}/${targets.length} symbols; the remainder keeps its ` +
          `stale marker and leads the next page`,
      );
      break;
    }
    try {
      const clean = cleanSymbol(symbol);
      let docsCreated = 0;

      // ONE authority for the listing. A DISCOVERED row already chose it at
      // selection time (`partitionSymbolPage` prefers NSE), so this lookup is
      // pinned to that exchange; a caller-supplied symbol has chosen nothing,
      // so it resolves the `nse-announcements-sync` way — `exchange: "desc"`
      // puts "NSE" before "BSE". Which listing wins is not cosmetic: every
      // write below is keyed on `(symbol, exchange, docType, period)`, so
      // filing a dual-listed company under its BSE row keys its documents to an
      // exchange that cannot source them.
      const instrument = await prisma.instrumentMapping.findFirst({
        where: {
          symbol: clean,
          exchange: target.exchange ?? { in: ["NSE", "BSE"] },
          isActive: true,
        },
        // tickertapeSid → build the Tickertape citation URL (MONEY-784 P3b).
        // MONEY-1255 (A2) — `name` and the three screener-identity columns are
        // SELECTED, not queried on. Both `{screenerSlug: null}` and
        // `{screenerSlug: {not: null}}` match ZERO rows on Mongo (the attribute
        // is ABSENT, not null, on all ~20,804 pre-existing rows), so the cache
        // decision has to be taken in code from a row already in hand —
        // `planScreenerSlugResolution`. `name` is the second search query.
        select: {
          id: true,
          exchange: true,
          tickertapeSid: true,
          name: true,
          isin: true,
          screenerSlug: true,
          screenerSlugCheckedAt: true,
          bseScripCode: true,
        },
        orderBy: { exchange: "desc" },
      });
      if (!instrument) {
        // Stamped: a symbol with no active row is still a VISIT. Leaving it
        // unstamped pins it to the head of a stale-first sort forever, which is
        // precisely how `annual-reports-sync` stalled.
        run.stamped += await stampVisited(prisma, [symbol]);
        processed++;
        continue;
      }

      // MONEY-1255 — a BSE-only symbol used to be dropped HERE, silently: the
      // lookup was hardcoded to `exchange: "NSE"`, missed, and `continue`d with
      // no log and no counter, having consumed one of the page's slots. The
      // rotation fix made the skip COUNTED and STAMPED. A2 removes the skip.
      //
      // What changed is a FACT, not a policy. The note this file used to end
      // with said "no producer in this repo can give a BSE-only company an
      // annual_report" — true of both NSE legs (they read NSE endpoints) and
      // true of the `stock_financials` read (NSE-filers-only XBRL), and FALSE
      // of screener.in, which carries 8-13 years of annual reports for 11 of 12
      // sampled BSE-only companies. So the two legs that cannot work stay off
      // (`resolveLegsForTarget`), and the one that can, runs.
      //
      // `exchange` is `instrument.exchange` — it always was; the difference is
      // that "BSE" now reaches the writes instead of a `continue`. Every write
      // below is keyed `(symbol, exchange, docType, period)`, so these land on
      // the BSE side of that unique with the BSE row's `instrumentId`.
      const exchange = instrument.exchange;
      const bseOnly = exchange !== "NSE";
      const targetLegs = resolveLegsForTarget(legs, bseOnly);
      if (bseOnly) {
        run.noNseListing++;
      }

      // === TICKERTAPE FINANCIAL STATEMENTS ===
      // MONEY-1255 — READ THIS BEFORE TRUSTING THE NAME. This leg makes NO
      // NETWORK CALL. `getOrFetchFinancials` is a pure Prisma read of
      // `stock_financials` (`packages/research/src/data-sources/db-store.ts`,
      // "Deliberately NO external fetch here"), and `TICKERTAPE_BASE` is used
      // only by `buildTickertapeUrl` to populate the `sourceUrl` COLUMN below.
      // So `api.tickertape` counts DATABASE LOOKUPS, `TT=0` can never occur,
      // and this job is NOT the probe for whether `www.tickertape.in` blocks
      // our egress (MONEY-1228). The rows it writes are ours, re-formatted.
      // `targetLegs`, not `legs` — MONEY-1255 (A2). For a BSE-only company this
      // is a read of `stock_financials`, a table filled by `xbrl-projection`
      // from an NSE-FILERS-ONLY ingest. There is no row to find, so entering
      // costs a Prisma lookup per period to learn nothing.
      if (
        targetLegs.tickertape &&
        isWithinApiLimit("tickertape", apiCalls.tickertape) &&
        withinBudget()
      ) {
        for (const periodType of ["ANNUAL", "QUARTERLY"] as const) {
          const period =
            periodType === "ANNUAL"
              ? `annual-${new Date().getFullYear()}`
              : `quarterly-${new Date().getFullYear()}`;

          if (!forceRefresh) {
            const exists = await prisma.stockDocument.findUnique({
              where: {
                symbol_exchange_docType_period: {
                  symbol: clean,
                  exchange,
                  docType: "financial_statement",
                  period,
                },
              },
            });
            if (
              exists &&
              exists.fetchedAt > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
            ) {
              // MONEY-1238 — this used to be `docsCreated++`. A FRESHNESS SKIP
              // is not a write: with every source dark, a full run of 250
              // symbols reported `written: 500` and the zero-write monitor
              // could only ever fire against a virgin database.
              run.skippedFresh++;
              continue;
            }
          }

          try {
            apiCalls.tickertape++;
            const financials = await deps.getOrFetchFinancials(
              clean,
              exchange,
              periodType,
            );
            if (!financials) {
              logger.warn(`No financials for ${clean} (${periodType})`);
              continue;
            }

            const text = formatFinancialsForDocument(
              financials,
              clean,
              periodType,
            );
            // Header-only text (no actual data rows) = skip
            const hasData = text.includes(": ") && text.split("\n").length > 5;
            if (!text || !hasData) {
              logger.warn(`No financial data for ${clean} (${periodType})`);
              continue;
            }
            logger.info(
              `Uploading ${clean} (${periodType}): ${text.length} chars`,
            );

            const gcsPath = buildFullDocPath(
              clean,
              "financial_statement",
              period,
              "txt",
            );
            const buffer = Buffer.from(text, "utf-8");

            await deps.uploadToGCS(gcsPath, buffer, "text/plain");
            apiCalls.gcsUploads++;

            await prisma.stockDocument.upsert({
              where: {
                symbol_exchange_docType_period: {
                  symbol: clean,
                  exchange,
                  docType: "financial_statement",
                  period,
                },
              },
              create: {
                instrumentId: instrument.id,
                symbol: clean,
                exchange,
                docType: "financial_statement",
                period,
                title: `${clean} Financial Statements (${periodType})`,
                sourceType: "TICKERTAPE",
                // MONEY-784 (P3b): carry a citation URL so embedded chunks from
                // the Tickertape financials are clickable (MONEY-670 propagates
                // sourceUrl into chunk metadata).
                sourceUrl: buildTickertapeUrl(clean, instrument.tickertapeSid),
                gcsPath,
                fileSize: buffer.length,
                mimeType: "text/plain",
                processingStatus: "READY",
                textContent: text.slice(0, 100_000),
                fetchedAt: new Date(),
              },
              update: {
                sourceUrl: buildTickertapeUrl(clean, instrument.tickertapeSid),
                gcsPath,
                fileSize: buffer.length,
                textContent: text.slice(0, 100_000),
                processingStatus: "READY",
                isEmbedded: false,
                fetchedAt: new Date(),
              },
            });
            docsCreated++;
            run.wrote.tickertape++;
          } catch (err) {
            logger.warn(
              `Tickertape financials failed for ${clean} (${periodType}): ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }

      // === NSE QUARTERLY RESULTS ===
      // `targetLegs.nse` is ANDed with the existing docTypes clause rather than
      // replacing it — MONEY-1255 (A2). The two are not the same predicate:
      // `legs.nse` is also true for an announcement-only request, which this
      // leg must still decline. ANDing can only ever REMOVE the BSE-only case,
      // so NSE behaviour is byte-identical.
      if (
        targetLegs.nse &&
        (!docTypes || docTypes.includes("quarterly_result")) &&
        isWithinApiLimit("nse", apiCalls.nse) &&
        withinBudget()
      ) {
        try {
          apiCalls.nse++;
          const filings = await deps.fetchNSEFinancialResults(clean);
          const withPdf = filings.filter((f) => f.attachmentUrl).slice(0, 5);
          for (const filing of withPdf) {
            // Budget checked per DOCUMENT: five filings at a 30s timeout plus a
            // 2s inter-download sleep is ~160s for one symbol, which would
            // otherwise all land after the budget expired.
            if (!withinBudget()) break;
            const count = await storeNSEFiling(
              run,
              deps,
              filing,
              clean,
              exchange,
              instrument.id,
              "quarterly_result",
              forceRefresh,
            );
            docsCreated += count;
          }
        } catch (err) {
          // An upstream that would not answer, counted as such: this is the
          // only input to `job-outcome`'s "wrote 0 after N UPSTREAM failure(s)"
          // branch, which otherwise cannot fire.
          run.transportFailures++;
          logger.warn(
            `NSE quarterly failed for ${clean}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // === NSE ANNOUNCEMENTS (categorized — MONEY-784 P3b) ===
      // The NSE announcement feed carries far more than annual reports: investor
      // presentations, credit-rating intimations, press releases and
      // earnings-call intimations. `fetchCategorizedAnnouncements` buckets each
      // useful filing into its docType (dropping the noise); we then store the
      // top-N PDFs PER category. These land as PENDING and flow through the P3
      // extract → embed chain like any other NSE PDF.
      // MONEY-1255 — the category list moved to the logic module. The
      // run-health condition has to ask the same question this gate asks, and
      // two copies of the list is how a gate and the alarm describing it drift.
      const nseAnnouncementCats: readonly string[] = NSE_ANNOUNCEMENT_DOC_TYPES;
      if (
        targetLegs.nse &&
        (!docTypes ||
          nseAnnouncementCats.some((dt) => docTypes.includes(dt))) &&
        isWithinApiLimit("nse", apiCalls.nse) &&
        withinBudget()
      ) {
        try {
          apiCalls.nse++;
          const categorized = await deps.fetchCategorizedAnnouncements(clean);
          // Bucket by docType, keep only those with an attachment, cap top-N each.
          const PER_CATEGORY_CAP = 5;
          const byCategory = new Map<StockDocType, NSEFiling[]>();
          for (const { filing, docType } of categorized) {
            if (!filing.attachmentUrl) continue;
            if (docTypes && !docTypes.includes(docType)) continue;
            const bucket = byCategory.get(docType) ?? [];
            if (bucket.length < PER_CATEGORY_CAP) {
              bucket.push(filing);
              byCategory.set(docType, bucket);
            }
          }
          for (const [docType, filings] of byCategory) {
            for (const filing of filings) {
              // Five categories x five filings x (30s timeout + 2s sleep) is
              // ~800s for ONE symbol — larger than the whole ack deadline. The
              // budget has to be checked here, not only between symbols.
              if (!withinBudget()) break;
              const count = await storeNSEFiling(
                run,
                deps,
                filing,
                clean,
                exchange,
                instrument.id,
                docType,
                forceRefresh,
              );
              docsCreated += count;
            }
          }
        } catch (err) {
          run.transportFailures++;
          logger.warn(
            `NSE announcements failed for ${clean}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      // === SCREENER FULL SCRAPE (concalls, annual reports, financials text,
      //     shareholding, peers, growth, credit ratings, announcements) ===
      // ONE page fetch returns ALL of these sections — listed here so a targeted
      // docTypes request for any one of them still triggers the single fetch
      // (MONEY-853). No extra requests; the 3s self-throttle lives in the scraper.
      const screenerDocTypes: readonly string[] = SCREENER_PAGE_DOC_TYPES;
      if (
        targetLegs.screener &&
        !screenerRateLimited &&
        (!docTypes || screenerDocTypes.some((dt) => docTypes.includes(dt))) &&
        isWithinApiLimit("screener", apiCalls.screener) &&
        // The single largest unit of work in the run — a 3s pre-delay plus up
        // to five 20s fetches and four backoffs when Screener 429s. It is the
        // term the budget's headroom is sized on; starting one past the budget
        // is what would overrun the deadline.
        withinBudget()
      ) {
        try {
          // MONEY-1255 (A2) — an NSE company is reachable by TICKER and this is
          // unchanged for it (`slug` stays null → the scraper builds the exact
          // URL it always did). A BSE-only company is not: screener keys its
          // page by a slug that is usually the BSE scrip code, so the slug has
          // to be resolved once and cached, or the page cannot be found at all.
          //
          // The resolution sits INSIDE this try on purpose: it can throw
          // `ScreenerRateLimitError`, and the catch below is what trips
          // `screenerRateLimited` — which both skips Screener for the rest of
          // the run and refuses to chain (a fresh link re-arms the breaker
          // straight back into the MONEY-853 tarpit).
          let slug: string | null = null;
          let canScrape = true;
          if (bseOnly) {
            slug = await resolveSlugForRow(
              run,
              deps,
              instrument,
              clean,
              loadBseIndex,
            );
            canScrape = slug !== null;
            if (canScrape) {
              run.bseOnly.served++;
            } else {
              // A COUNTED SKIP, not a silent one — and note what does NOT
              // happen here: no `continue`. The symbol falls through to the
              // end-of-loop stamp like every other visit, because a company we
              // asked about and could not place must still rotate to the back
              // of the queue. Stamping only on a WRITE is exactly how the
              // sibling `annual-reports-sync` stalled.
              // "No usable slug" covers all four ways this returns null — a
              // miss, a refusal, a fresh finding we did not re-ask, and a
              // spent budget. `run.bseOnly.*` is what tells them apart; the
              // per-symbol line only has to say the leg did not run.
              logger.info(
                `[${processed + 1}/${targets.length}] ${clean}: BSE-only, no usable screener slug — skipped`,
              );
            }
          }

          let scraped: Awaited<
            ReturnType<ResolvedDeps["scrapeScreenerFullPage"]>
          > = null;
          if (canScrape) {
            apiCalls.screener++;
            scraped = await deps.scrapeScreenerFullPage(
              clean,
              slug ? { slug } : undefined,
            );
          }
          if (scraped) {
            // 1. Store full financial text (P&L + BS + CF + Ratios - 10+ years)
            if (
              (!docTypes || docTypes.includes("screener_financials")) &&
              scraped.fullText.length > 200
            ) {
              const textPeriod = `screener-${new Date().getFullYear()}`;
              if (
                forceRefresh ||
                !(await docExists(
                  deps.prisma,
                  clean,
                  exchange,
                  "screener_financials",
                  textPeriod,
                ))
              ) {
                const buffer = Buffer.from(scraped.fullText, "utf-8");
                const gcsPath = buildFullDocPath(
                  clean,
                  "screener_financials" as StockDocType,
                  textPeriod,
                  "txt",
                );
                await deps.uploadToGCS(gcsPath, buffer, "text/plain");
                apiCalls.gcsUploads++;
                await prisma.stockDocument.upsert({
                  where: {
                    symbol_exchange_docType_period: {
                      symbol: clean,
                      exchange,
                      docType: "screener_financials",
                      period: textPeriod,
                    },
                  },
                  create: {
                    instrumentId: instrument.id,
                    symbol: clean,
                    exchange,
                    docType: "screener_financials",
                    period: textPeriod,
                    title: `${clean} Screener Financials (10Y)`,
                    sourceType: "SCREENER",
                    // MONEY-784 (P3b): citation URL for the Screener financials
                    // text so its embedded chunks are clickable (MONEY-670).
                    sourceUrl: buildScreenerUrl(clean),
                    gcsPath,
                    fileSize: buffer.length,
                    mimeType: "text/plain",
                    processingStatus: "READY",
                    textContent: scraped.fullText.slice(0, 100_000),
                    fetchedAt: new Date(),
                  },
                  update: {
                    sourceUrl: buildScreenerUrl(clean),
                    gcsPath,
                    fileSize: buffer.length,
                    textContent: scraped.fullText.slice(0, 100_000),
                    processingStatus: "READY",
                    isEmbedded: false,
                    fetchedAt: new Date(),
                  },
                });
                docsCreated++;
                run.wrote.screener++;
                logger.info(
                  `Stored Screener financials for ${clean}: ${buffer.length} bytes`,
                );
              }
            }

            // 2. Archive the NEW structured sections as JSON snapshots
            //    (shareholding pattern, peer comparison, compounded growth).
            //    MONEY-853 — same ONE page fetch above already returned these;
            //    no extra request. Each is a per-symbol latest-wins snapshot.
            const snapshotYear = `screener-${new Date().getFullYear()}`;
            if (
              (!docTypes || docTypes.includes("screener_shareholding")) &&
              scraped.shareholding.length > 0
            ) {
              docsCreated += await storeScreenerJsonSnapshot(
                run,
                deps,
                "screener_shareholding",
                scraped.shareholding,
                `${clean} Screener Shareholding Pattern`,
                clean,
                exchange,
                instrument.id,
                snapshotYear,
                forceRefresh,
              );
            }
            if (
              (!docTypes || docTypes.includes("screener_peers")) &&
              scraped.peers.length > 0
            ) {
              docsCreated += await storeScreenerJsonSnapshot(
                run,
                deps,
                "screener_peers",
                scraped.peers,
                `${clean} Screener Peer Comparison`,
                clean,
                exchange,
                instrument.id,
                snapshotYear,
                forceRefresh,
              );
            }
            if (
              (!docTypes || docTypes.includes("screener_growth")) &&
              hasGrowthData(scraped.compoundedGrowthData)
            ) {
              docsCreated += await storeScreenerJsonSnapshot(
                run,
                deps,
                "screener_growth",
                scraped.compoundedGrowthData,
                `${clean} Screener Compounded Growth`,
                clean,
                exchange,
                instrument.id,
                snapshotYear,
                forceRefresh,
              );
            }

            // 3. Download document PDFs (annual reports, concall transcripts, AI
            //    summaries, PPTs, credit-rating PDFs, announcement filings)
            for (const doc of scraped.documents) {
              if (docTypes && !docTypes.includes(doc.type)) continue;
              // Each download is a 15s timeout plus a 3s sleep, and a company
              // can carry dozens.
              if (!withinBudget()) break;
              const count = await storeScreenerDoc(
                run,
                deps,
                {
                  type: doc.type,
                  title: doc.title,
                  url: doc.url,
                  period: doc.period,
                },
                clean,
                exchange,
                instrument.id,
                forceRefresh,
              );
              docsCreated += count;
            }
          }
        } catch (err) {
          run.transportFailures++;
          if (err instanceof ScreenerRateLimitError) {
            screenerRateLimited = true;
            logger.warn(
              `Screener rate-limited (429) — skipping Screener for the remaining symbols this run`,
            );
          } else {
            logger.warn(
              `Screener failed for ${clean}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }

      totalDocs += docsCreated;
      processed++;
      // STAMPED ON VISIT, not on write — MONEY-1255. A symbol that legitimately
      // has no documents (a small cap NSE has never published a PDF for) must
      // still move to the back of the queue. Stamping only on a write would
      // leave every empty symbol pinned to the head of a stale-first sort,
      // re-selected on every run, blocking the tail forever — which is how the
      // sibling `annual-reports-sync` stalled.
      run.stamped += await stampVisited(prisma, [symbol]);
      if (docsCreated > 0) {
        logger.info(
          `[${processed}/${targets.length}] ${clean}: ${docsCreated} documents`,
        );
      }

      if (processed < targets.length) {
        await deps.sleep(DELAY_BETWEEN_SYMBOLS_MS);
      }
    } catch (err) {
      failed++;
      // Stamped on failure too, for the same reason: an unfetchable symbol that
      // keeps its stale marker owns a slot on every future run. `news-sync`
      // makes the identical call and says so at `stampSyncMarker`.
      run.stamped += await stampVisited(prisma, [symbol]);
      logger.error(
        `Failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  logger.info(
    `Sync complete: ${processed}/${targets.length} processed, ${failed} failed, ` +
      `${totalDocs} written (TT=${run.wrote.tickertape} NSE=${run.wrote.nse} SCR=${run.wrote.screener}), ` +
      `${run.skippedFresh} already-fresh, ${run.noNseListing} BSE-only ` +
      `(${run.bseOnly.served} served, slugs ${run.bseOnly.slugResolved}/${run.bseOnly.slugMiss}/${run.bseOnly.slugAmbiguous} resolved/no-page/ambiguous), ` +
      `${run.transportFailures} upstream failure(s), ` +
      `${run.htmlRefusals} HTML page(s) refused, ${run.stamped} row(s) stamped` +
      (stoppedOnBudget ? " (budget-truncated)" : "") +
      ` | attempts: TT=${apiCalls.tickertape} NSE=${apiCalls.nse} SCR=${apiCalls.screener} GCS=${apiCalls.gcsUploads}`,
  );

  // MONEY-1220. The line above is this job's own shape and nothing queries
  // across jobs, so a run that selected symbols and produced no documents looked
  // exactly like a healthy one on every dashboard. Six scheduled jobs did that
  // in a single week while returning 200 throughout.
  //
  // MONEY-1238 — `totalDocs` counts documents that were WRITTEN. It used to
  // count freshness skips too (three sites: the Tickertape period loop and both
  // `if (exists) return 1` helpers), so a run in which every source was dark
  // still reported `written: 500` on an already-populated table.
  //
  // MONEY-1255 — TWO corrections to the condition that reads those numbers, and
  // one to the claim this comment used to make.
  //
  //  1. It was `apiCalls.tickertape === 0 || apiCalls.nse === 0`. On the
  //     `stock-document-sync-tickertape-daily` schedule `docTypes` is
  //     `["financial_statement"]`, which gates BOTH NSE legs off BY DESIGN — so
  //     `apiCalls.nse === 0` was true on every healthy weekday run and the
  //     alarm was permanently asserted. A condition that always fires carries
  //     no information. It never checked `screener` at all, so the one failure
  //     it was written for — the MONEY-853 429 circuit-break — was invisible.
  //     `describeSyncShortfall` only reports a source the run ENABLED.
  //  2. It counted ATTEMPTS. Every per-source counter is incremented BEFORE the
  //     call it counts, so a source that 403s on every request still reports a
  //     full number. The condition now reads `run.wrote.*` — rows that reached
  //     `stock_documents`.
  //
  // And the retracted claim: this comment used to say `www.tickertape.in` is
  // "which this job scrapes", and that `TT=0` would reveal a block of that
  // host. Both halves are false. `TICKERTAPE_BASE` is used only by
  // `buildTickertapeUrl` to fill the `sourceUrl` column; the leg's data source
  // is `getOrFetchFinancials`, a pure Prisma read. This job issues no request
  // to any Tickertape host, so it can never be the MONEY-1228 probe.
  reportJobOutcome({
    job: "stock-document-sync",
    selected: targets.length,
    written: totalDocs,
    failed,
    transportFailures: run.transportFailures,
    skippedReason: describeSyncShortfall({
      selected: targets.length,
      written: totalDocs,
      skippedFresh: run.skippedFresh,
      legs,
      wrote: run.wrote,
      transportFailures: run.transportFailures,
      htmlRefusals: run.htmlRefusals,
      noNseListing: run.noNseListing,
      bseOnly: run.bseOnly,
    }),
  });

  // Auto-trigger extraction for newly synced documents (MONEY-783).
  // Newly synced NSE/Screener PDFs land as PENDING with textContent:null — they
  // must be extracted (Document AI / pdf-parse) to READY before they can be
  // embedded. The extract job no-ops if there are no PENDING PDFs (text-source
  // docs are already READY) and then chains STOCK_DOCUMENT_EMBED itself.
  //
  // MONEY-1238 — the gate is now "something was WRITTEN", which is what the
  // comment always claimed. Before the count fix a fully-fresh run published an
  // extract job with nothing new to extract; `stock-document-extract-daily`
  // covers any PENDING backlog on its own schedule regardless.
  if (totalDocs > 0) {
    try {
      await deps.publishExtractJob();
      logger.info("Published stock-document-extract job for newly synced docs");
    } catch (err) {
      logger.warn(
        `Failed to trigger extraction: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const chained = await chainAnotherBatch({
    deps,
    message,
    chainDepth,
    rowsSelected,
    pageSize,
    stamped: run.stamped,
    explicitSymbols,
    upstreamCircuitBroken: screenerRateLimited,
  });

  return {
    selected: targets.length,
    written: totalDocs,
    wrote: { ...run.wrote },
    skippedFresh: run.skippedFresh,
    failed,
    transportFailures: run.transportFailures,
    htmlRefusals: run.htmlRefusals,
    noNseListing: run.noNseListing,
    bseOnly: { ...run.bseOnly },
    stamped: run.stamped,
    rowsSelected,
    stoppedOnBudget,
    chained,
    api: { ...run.api },
  };
}

/**
 * Advance the rotation marker for every symbol the run VISITED.
 *
 * `updateMany` on `symbol` (no exchange arm), like `news-sync`'s
 * `stampSyncMarker`: the unit of work here is the SYMBOL, so a dual-listed
 * company's NSE and BSE rows must rotate together or the BSE row keeps leading
 * the page for work that was already done under the NSE one.
 *
 * Best-effort — a stamp failure must not fail the run — but LOGGED rather than
 * swallowed, because silent stamp loss is indistinguishable from a rotation
 * that never advances, which is the entire defect. Returns the number of rows
 * actually moved, which is what the chain reads as progress.
 */
async function stampVisited(db: Db, symbols: string[]): Promise<number> {
  if (symbols.length === 0) return 0;
  try {
    const res = await db.instrumentMapping.updateMany({
      where: { symbol: { in: symbols } },
      data: { documentsSyncedAt: new Date() },
    });
    return res?.count ?? 0;
  } catch (err) {
    logger.warn(
      `documentsSyncedAt stamp failed for ${symbols.length} symbol(s): ${err instanceof Error ? err.message : err}`,
    );
    return 0;
  }
}

/** The screener-identity columns this job reads off an instrument row. */
interface ScreenerIdentityRow {
  id: string;
  name: string;
  isin?: string | null;
  screenerSlug?: string | null;
  screenerSlugCheckedAt?: Date | null;
  bseScripCode?: string | null;
}

/**
 * The screener slug for ONE BSE-only company — cached, resolved, or refused.
 *
 * ## Three states, and why `null` is two of them
 *
 * `planScreenerSlugResolution` reads the row we already have (never a `where`
 * — both `{screenerSlug: null}` and `{screenerSlug: {not: null}}` match ZERO
 * rows on Mongo, because `db push` creates indexes and never fields and the
 * attribute is ABSENT on all ~20,804 pre-existing rows; MONEY-1050 / 1205 /
 * 1234 / 1236). It answers:
 *
 *   cached  — a slug is stored. Use it; spend nothing.
 *   skip    — we asked within the TTL and screener had no page for this
 *             company. `null` + a FRESH timestamp is a FINDING, and re-asking
 *             it every week is how a 2,389-company population burns its whole
 *             screener budget re-learning the same negative.
 *   resolve — never asked, or that finding has EXPIRED. New companies list;
 *             a cached "no" that never expires is a fail-open default frozen
 *             into the database.
 *
 * ## What it refuses to do
 *
 * Return a slug it is not sure of. `resolveScreenerSlug` accepts a candidate
 * only on slug identity or a strict name overlap, and only when exactly one
 * candidate clears the bar — otherwise `ambiguous`, which stores `null` and is
 * counted separately from `miss`. A wrong slug files ANOTHER COMPANY's annual
 * reports under our symbol, where nothing downstream can tell the difference:
 * the PDF parses, the numbers project into `stock_financials` under our key,
 * and every dashboard reads green. That is strictly worse than no document.
 *
 * ## Never throws its own error, always propagates a rate limit
 *
 * A persist failure is logged and swallowed — the resolution is still valid for
 * THIS run and the next one simply re-resolves. A `ScreenerRateLimitError` is
 * deliberately NOT caught: the caller's catch trips the run-level breaker,
 * which both skips Screener for every remaining symbol and refuses to chain.
 */
async function resolveSlugForRow(
  run: SyncRun,
  deps: ResolvedDeps,
  instrument: ScreenerIdentityRow,
  symbol: string,
  loadBseIndex: () => Promise<BseScripIndex>,
): Promise<string | null> {
  const plan = planScreenerSlugResolution(instrument, deps.now());
  if (plan === "cached") return (instrument.screenerSlug ?? "").trim();
  if (plan === "skip") {
    logger.info(
      `${symbol}: no screener slug (checked within ${Math.round(
        SCREENER_SLUG_TTL_MS / 86_400_000,
      )}d) — not re-asking`,
    );
    return null;
  }

  // ONE master fetch per run, lazily, shared by every BSE-only symbol on the
  // page — and it is a BSE fetch, not a screener one, so it spends nothing from
  // `API_LIMITS.screener` and cannot move the 429 breaker.
  const index = await loadBseIndex();
  // `symbol` is the CLEANED ticker the loop resolved the instrument on, not a
  // field of the row — `cleanSymbol` can rewrite it, and the scrip-id fallback
  // must match on the value we actually looked the instrument up by.
  const resolution = resolveScreenerSlugFromBse(
    { symbol, isin: instrument.isin },
    index,
  );

  // `unavailable` IS NOT A FINDING. `fetchBseScripMaster` returns `[]` both on
  // a failed fetch and under `BSE_MASTER_ENRICH=off`, so counting an empty
  // master as "no match" would stamp a 90-day "screener has no page" onto every
  // BSE-only company on the page during a transient BSE outage — caching a
  // failure as a fact. Nothing is counted and nothing is persisted; the symbol
  // is still STAMPED by the ordinary end-of-loop site, so it rotates and is
  // re-resolved on a later run.
  if (resolution.outcome === "unavailable") {
    if (!run.bseOnly.masterUnavailable) {
      run.bseOnly.masterUnavailable = true;
      logger.warn(
        `BSE scrip master unavailable — BSE-only symbols cannot resolve a ` +
          `screener slug this run, and NOTHING is cached as a finding ` +
          `(${resolution.reason})`,
      );
    }
    return null;
  }

  if (resolution.outcome === "resolved") run.bseOnly.slugResolved++;
  else if (resolution.outcome === "miss") run.bseOnly.slugMiss++;
  else run.bseOnly.slugAmbiguous++;

  logger.info(
    `${symbol}: screener slug ${resolution.outcome}` +
      (resolution.slug ? ` -> /company/${resolution.slug}/` : "") +
      ` (${resolution.reason})`,
  );

  try {
    await deps.prisma.instrumentMapping.update({
      where: { id: instrument.id },
      data: {
        // Slug and timestamp move TOGETHER. A slug written without a timestamp
        // is un-expirable; a timestamp written without the slug would make a
        // crash between the two look like a fresh "no page".
        screenerSlug: resolution.slug,
        screenerSlugCheckedAt: new Date(),
        // Only ever SET, never cleared. It is authoritative here — BSE issues
        // both the ISIN and the scrip code — but a miss knows no scrip code,
        // and blanking a value another job may have supplied is a claim we
        // cannot make.
        ...(resolution.bseScripCode
          ? { bseScripCode: resolution.bseScripCode }
          : {}),
      },
    });
  } catch (err) {
    logger.warn(
      `screener slug persist failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
    );
  }

  return resolution.slug;
}

/**
 * Publish the NEXT link of the drain chain — MONEY-1255.
 *
 * ## Why a chain rather than a bigger batch
 *
 * The population is ~18,300 distinct active symbols and the scheduler fires
 * twice a week. A batch cannot be raised to cover that: the run is bounded by a
 * 600s Pub/Sub ack deadline (Pub/Sub's maximum, not a setting), and the
 * per-symbol cost is already 2s of politeness sleep plus a 3s Screener
 * self-throttle before any network. `workers/CLAUDE.md` says it plainly —
 * raising a batch is not the way to catch up; self-chaining is the lever.
 *
 * ## Why this terminates
 *
 * `shouldChainAnotherSyncBatch` refuses once `chainDepth + 1` reaches
 * `MAX_SYNC_CHAIN_DEPTH`, and every published message carries `chainDepth + 1`.
 * That bound is a pure function of a number on the message: it consults no
 * database, no clock and no queue state, so nothing the population does can
 * extend it. The other five conditions (explicit symbols, drained page, no
 * stamps, non-positive page, a circuit-broken upstream) can only stop it
 * SOONER, so none of them can break the bound.
 *
 * Never throws: a failed chain must leave a successful sync run successful. The
 * cost of a dropped link is a delayed page, and the marker means the next
 * scheduled run picks up exactly where this one stopped.
 */
async function chainAnotherBatch(opts: {
  deps: ResolvedDeps;
  message: StockDocumentSyncMessage;
  chainDepth: number;
  rowsSelected: number;
  pageSize: number;
  stamped: number;
  explicitSymbols: boolean;
  upstreamCircuitBroken: boolean;
}): Promise<boolean> {
  const {
    deps,
    message,
    chainDepth,
    rowsSelected,
    pageSize,
    stamped,
    explicitSymbols,
    upstreamCircuitBroken,
  } = opts;

  if (
    !shouldChainAnotherSyncBatch({
      rowsSelected,
      pageSize,
      chainDepth,
      stamped,
      explicitSymbols,
      upstreamCircuitBroken,
    })
  ) {
    logger.info(
      `Not chaining (depth ${chainDepth}/${MAX_SYNC_CHAIN_DEPTH}, rows ${rowsSelected}/${pageSize}, ` +
        `stamped ${stamped}, explicitSymbols ${explicitSymbols}, circuitBroken ${upstreamCircuitBroken})`,
    );
    return false;
  }

  try {
    // The follow-up inherits the ORIGINAL scope (docTypes / forceRefresh /
    // batchSize) so a targeted schedule stays targeted. Only the depth moves —
    // there is no cursor to carry, because `documentsSyncedAt` IS the cursor
    // and it lives in the database.
    await deps.publishNextBatch({
      ...message,
      chainDepth: chainDepth + 1,
    });
    logger.info(
      `Chained stock-document-sync batch ${chainDepth + 1}/${MAX_SYNC_CHAIN_DEPTH}`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `Failed to chain the next sync batch: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/** The real drain chain. Extracted so `deps` has something to default to. */
async function publishNextBatchViaPubSub(
  message: StockDocumentSyncMessage,
): Promise<void> {
  const pubsub = getPubSubClient();
  const topic = pubsub.topic(getTopicName(PUBSUB_TOPICS.STOCK_DOCUMENT_SYNC));
  await topic.publishMessage({ json: message });
}

/** The real extract-job chain. Extracted so `deps` has something to default to. */
async function publishExtractJobViaPubSub(): Promise<void> {
  const pubsub = getPubSubClient();
  const topic = pubsub.topic(
    getTopicName(PUBSUB_TOPICS.STOCK_DOCUMENT_EXTRACT),
  );
  await topic.publishMessage({ json: { batchSize: 50 } });
}

// === Helpers ===

async function docExists(
  db: Db,
  symbol: string,
  exchange: string,
  docType: string,
  period: string,
): Promise<boolean> {
  const doc = await db.stockDocument.findUnique({
    where: {
      symbol_exchange_docType_period: { symbol, exchange, docType, period },
    },
  });
  return !!doc;
}

/** True when at least one compounded-growth bucket has a value worth storing. */
function hasGrowthData(g: ScreenerCompoundedGrowth): boolean {
  return (
    Object.keys(g.salesGrowth).length > 0 ||
    Object.keys(g.profitGrowth).length > 0 ||
    Object.keys(g.stockPriceCagr).length > 0 ||
    Object.keys(g.returnOnEquity).length > 0
  );
}

// === Screener Structured-Section Helper (MONEY-853) ===

/**
 * Archive a structured Screener section (shareholding / peers / growth) as a
 * pretty-printed JSON snapshot in GCS + a StockDocument row. Latest-wins per
 * (symbol, exchange, docType, period); skips when a row already exists unless
 * `forceRefresh`. The JSON text is also stored in `textContent` so the embedder
 * can index it for RAG just like the financials text. Returns 1 when stored.
 */
async function storeScreenerJsonSnapshot(
  run: SyncRun,
  deps: ResolvedDeps,
  docType: StockDocType,
  payload: unknown,
  title: string,
  symbol: string,
  exchange: string,
  instrumentId: string,
  period: string,
  forceRefresh: boolean,
): Promise<number> {
  if (
    !forceRefresh &&
    (await docExists(deps.prisma, symbol, exchange, docType, period))
  ) {
    // This one ALREADY returned 0 on a skip — the only one of the four that
    // did. It is counted now so the skip is visible rather than merely absent.
    run.skippedFresh++;
    return 0;
  }

  try {
    const json = JSON.stringify(payload, null, 2);
    const buffer = Buffer.from(json, "utf-8");
    const gcsPath = buildFullDocPath(symbol, docType, period, "json");

    await deps.uploadToGCS(gcsPath, buffer, "application/json");
    run.api.gcsUploads++;

    await deps.prisma.stockDocument.upsert({
      where: {
        symbol_exchange_docType_period: { symbol, exchange, docType, period },
      },
      create: {
        instrumentId,
        symbol,
        exchange,
        docType,
        period,
        title,
        sourceType: "SCREENER",
        gcsPath,
        fileSize: buffer.length,
        mimeType: "application/json",
        processingStatus: "READY",
        textContent: json.slice(0, 100_000),
        fetchedAt: new Date(),
      },
      update: {
        gcsPath,
        fileSize: buffer.length,
        textContent: json.slice(0, 100_000),
        processingStatus: "READY",
        isEmbedded: false,
        fetchedAt: new Date(),
      },
    });

    logger.info(
      `Stored Screener ${docType} for ${symbol}: ${buffer.length} bytes`,
    );
    run.wrote.screener++;
    return 1;
  } catch (err) {
    logger.warn(
      `Screener ${docType} snapshot failed for ${symbol}: ${err instanceof Error ? err.message : err}`,
    );
    return 0;
  }
}

// ===========================================================================
// THE HTML REFUSAL — MONEY-1315 (B)
// ===========================================================================

/**
 * Record a download whose body turned out to be an HTML page.
 *
 * Called by BOTH download-and-store paths below, so the two can never disagree
 * about what a refusal leaves behind. It does three things and no more:
 *
 *  1. COUNTS it (`run.htmlRefusals`), so the refusal is visible in the run
 *     outcome instead of being a silent `return 0` — a source whose links have
 *     all rotted to landing pages would otherwise look exactly like a source
 *     with nothing new to give.
 *  2. Leaves the row TERMINAL rather than PENDING: `gcsPath: ""`
 *     (`ABSENT_GCS_PATH`) and `UNSUPPORTED` (`HTML_QUARANTINE_STATUS`), the
 *     same pair `quarantine-html-stock-documents.ts` writes, imported from the
 *     same module so the writer and the migration cannot drift apart.
 *  3. KEEPS `title`, `sourceUrl` and `description`. That is the useful part —
 *     the citation still resolves, the UI can still name the document, and a
 *     later pass can re-fetch from `sourceUrl` if SEBI ever starts serving the
 *     PDF at that link. It is the BSE-retention precedent (7,234 rows with
 *     `gcsPath: ""` and every other column intact — the single spelling of
 *     that number lives on `ABSENT_GCS_PATH` in `document-body-guard.ts`,
 *     which also records why the older 6,125 is superseded) applied to a
 *     different cause.
 *
 * ## The UPDATE arm is deliberately EMPTY
 *
 * A refusal must never overwrite a document we already hold. The freshness
 * check upstream returns early when a row exists, so this is only reached with
 * no row — EXCEPT under `forceRefresh: true`, where a real PDF stored last
 * month sits under the key and today's fetch hits a transient challenge page.
 * Clobbering `gcsPath` to `""` there would destroy a good document and leave
 * nothing to recover it from. `update: {}` means the pre-existing row wins;
 * the refusal is still counted and logged.
 */
async function quarantineHtmlDownload(
  run: SyncRun,
  deps: ResolvedDeps,
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
  // Incremented HERE, on the refusal itself, with the body already inspected —
  // never at the top of the download it describes.
  run.htmlRefusals++;

  await deps.prisma.stockDocument.upsert({
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
    // See the note above: a refusal never displaces a document we already hold.
    update: {},
  });

  logger.warn(
    `REFUSED ${args.sourceType} ${args.docType} for ${args.symbol} ${args.period}: ` +
      `${args.reason} (${args.sourceUrl})`,
  );
}

// === NSE Filing Helper ===

async function storeNSEFiling(
  run: SyncRun,
  deps: ResolvedDeps,
  filing: NSEFiling,
  symbol: string,
  exchange: string,
  instrumentId: string,
  docType: StockDocType,
  forceRefresh: boolean,
): Promise<number> {
  if (!filing.attachmentUrl) return 0;

  const period = extractPeriod(filing);

  if (!forceRefresh) {
    const exists = await deps.prisma.stockDocument.findUnique({
      where: {
        symbol_exchange_docType_period: { symbol, exchange, docType, period },
      },
    });
    // MONEY-1238 — was `return 1`. Already having the document is the reason we
    // are NOT writing one; see the tickertape site above.
    if (exists) {
      run.skippedFresh++;
      return 0;
    }
  }

  try {
    const fullUrl = buildNseUrl(filing.attachmentUrl);

    const resp = await deps.httpGet(fullUrl, {
      timeout: 30_000,
      throwHttpErrors: false,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: `${NSE_BASE}/`,
      },
    });

    // MONEY-1255 — a non-2xx from NSE is an UPSTREAM failure, not a quiet
    // nothing. It is the difference between "NSE has no PDF here" and "NSE will
    // not serve us", and only the second one should read as a problem.
    if (!resp.ok) {
      run.transportFailures++;
      return 0;
    }

    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < 1000) return 0;

    const gcsPath = buildFullDocPath(symbol, docType, period, "pdf");

    // MONEY-1315 (B) — the BODY, not the header. This leg used to HARDCODE
    // `application/pdf` two lines down, so `initialProcessingStatus` could
    // never have caught an NSE cookie-challenge page here: the media type it
    // would classify was one WE wrote, not one NSE claimed. MONEY-1319 replaced
    // that literal (below), but the guard still reads the bytes — a media type
    // derived from the bytes and a body sniff answer different questions, and
    // this one has to run BEFORE the upload so the object never exists.
    const nseGate = mayStoreDocumentBody({ gcsPath, body: buffer });
    if (!nseGate.store) {
      await quarantineHtmlDownload(run, deps, {
        instrumentId,
        symbol,
        exchange,
        docType,
        period,
        title: filing.title || `${symbol} ${docType} ${period}`,
        description: filing.description,
        sourceUrl: filing.attachmentUrl,
        sourceType: "NSE",
        reason: nseGate.reason,
      });
      return 0;
    }

    // MONEY-1319 — the literal `"application/pdf"` that stood here (and on the
    // `mimeType` column below) is one of the four sources of the 179 NSE ZIPs
    // recorded as PDFs. `nsearchives.nseindia.com` serves a filing BUNDLED with
    // an XML sidecar; this leg named the object `.pdf` and stamped the media
    // type regardless, so the rows passed `buildExtractQuery` and burned a
    // Document AI round trip each cycle. One value, from the bytes, used for
    // both the object's content type and the column.
    const storedMimeType = resolveStoredMimeType({
      body: buffer,
      contentType: resp.headers.get("content-type"),
    });

    await deps.uploadToGCS(gcsPath, buffer, storedMimeType);
    run.api.gcsUploads++;

    const storedDoc = await deps.prisma.stockDocument.upsert({
      where: {
        symbol_exchange_docType_period: { symbol, exchange, docType, period },
      },
      create: {
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
        fileSize: buffer.length,
        mimeType: storedMimeType,
        // From the media type the BYTES imply rather than a hardcoded
        // `PENDING`. A body no extractor can read is not queued for anything.
        processingStatus: initialProcessingStatus(storedMimeType),
        fetchedAt: new Date(),
      },
      update: {
        gcsPath,
        fileSize: buffer.length,
        // Refreshed on update too: without it a row keeps the container it was
        // FIRST stored with, so an upstream switching between a bundled ZIP and
        // a bare PDF leaves the column describing bytes that are gone.
        mimeType: storedMimeType,
        processingStatus: initialProcessingStatus(storedMimeType),
        isEmbedded: false,
        fetchedAt: new Date(),
      },
    });

    // MONEY-1314 — announce it to the ingest lane. A no-op unless
    // DOC_INGEST_REALTIME="true" AND the row is a PDF, so this is safe to
    // call unconditionally; the gate lives in ONE place rather than at the
    // fifteen `stock_documents` writers, where the sixteenth would forget it.
    await publishDocumentIngest(storedDoc);

    logger.info(
      `Stored NSE ${docType} for ${symbol}: ${period} (${buffer.length} bytes)`,
    );
    run.api.nse++;
    run.wrote.nse++;
    await deps.sleep(2000);
    return 1;
  } catch (err) {
    run.transportFailures++;
    logger.warn(
      `NSE download failed for ${symbol} ${period}: ${err instanceof Error ? err.message : err}`,
    );
    return 0;
  }
}

// === Screener Doc Helper ===

async function storeScreenerDoc(
  run: SyncRun,
  deps: ResolvedDeps,
  doc: { type: string; title: string; url: string | null; period: string },
  symbol: string,
  exchange: string,
  instrumentId: string,
  forceRefresh: boolean,
): Promise<number> {
  if (!doc.url) return 0;

  const docType = normalizeScreenerDocType(doc.type) as StockDocType;
  const period = doc.period || "unknown";

  if (!forceRefresh) {
    const exists = await deps.prisma.stockDocument.findUnique({
      where: {
        symbol_exchange_docType_period: { symbol, exchange, docType, period },
      },
    });
    // MONEY-1238 — was `return 1`. Same defect, third site.
    if (exists) {
      run.skippedFresh++;
      return 0;
    }
  }

  try {
    const abortController = new AbortController();
    const downloadTimeout = setTimeout(() => abortController.abort(), 30_000);

    const resp = await deps.httpGet(doc.url, {
      timeout: 15_000,
      signal: abortController.signal,
      throwHttpErrors: false,
    });
    clearTimeout(downloadTimeout);

    if (!resp.ok) {
      run.transportFailures++;
      return 0;
    }

    const arrayBuffer = await resp.arrayBuffer();
    const rawContentType =
      resp.headers.get("content-type") || "application/pdf";
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length < MIN_DOC_BUFFER_BYTES) return 0;

    // MONEY-1255 — store the NORMALIZED media type, not the raw header.
    //
    // Screener answers `application/pdf;charset=UTF-8` for some documents. The
    // extract worker's `mimeType: { in: [...] }` is an EXACT match, so the raw
    // spelling was stored, never selected, and the row stayed PENDING forever
    // while its GCS object was correctly named `.pdf` (inferExtension used a
    // substring test). Normalising here is what makes the name and the
    // eligibility one decision.
    //
    // The status follows from the same value: a `text/html` error page, an MP3
    // or a ZIP is not queued for anything — no extractor in this repo reads
    // them — so PENDING would overstate the backlog forever. `UNSUPPORTED` is
    // terminal. Applied HERE and not only in the one-off repair, because this
    // writer runs every week and would rebuild the pile.
    // MONEY-1319 — the BYTES decide, and the header is the fallback for a body
    // the sniffer declines to identify (where it resolves to exactly what
    // `normalizeDocMimeType(rawContentType)` produced, so nothing moves).
    //
    // This is not a hypothetical for this leg. The MONEY-1315 scan measured the
    // header disagreeing with the bytes in BOTH directions on 13 rows, and TEN
    // of them are this shape: stored `text/html`, holding something that is not
    // an HTML page (9 `credit_rating`, 1 `concall_transcript`). Every one was
    // written here, from an honest-looking header, and every one is terminally
    // `UNSUPPORTED` over bytes an extractor could have read.
    //
    // The EXTENSION is derived from the same resolved value rather than from
    // the raw header, because the MONEY-1255 defect was precisely a filename
    // and a column deciding separately and disagreeing.
    //
    // `undecidable: "trust-header"` is the OPT-IN, and this is the one leg in
    // the repo that takes it (MONEY-1319 review, M8). Everywhere else an
    // uncorroborated header may refine a type but not condemn a row to a
    // terminal status. Here it may, because that is exactly what this leg did
    // BEFORE MONEY-1319 — `normalizeDocMimeType(rawContentType)` +
    // `initialProcessingStatus(rawContentType)` — and it is what MONEY-1255
    // built the rule for: Screener's `text/html` for a SEBI landing page and
    // its `audio/mpeg` for a concall recording are honest, and `PENDING` about
    // either overstated the backlog by 1,210 rows. So this line changes nothing
    // for undecidable bytes and everything for bytes the sniffer CAN read.
    const contentType = resolveStoredMimeType({
      body: buffer,
      contentType: rawContentType,
      undecidable: "trust-header",
    });
    const status = initialProcessingStatus(contentType);

    const ext = inferExtension(contentType);
    const gcsPath = buildFullDocPath(symbol, docType, period, ext);

    // MONEY-1315 (B) — THIS IS THE LEG THAT PRODUCED THEM, and the two lines
    // above are how it did it. Screener's Documents section links a DRHP to
    // SEBI's HTML LANDING PAGE for the issue rather than to the prospectus PDF
    // (`.../filings/public-issues/mar-2018/advitiya-trade-india-limited_38237.html`),
    // and the rating-agency links behave the same way. SEBI answers 200 with an
    // honest `text/html; charset=UTF-8`, so:
    //
    //   normalizeDocMimeType → "text/html"
    //   initialProcessingStatus → "UNSUPPORTED"     ← fired, correctly
    //   inferExtension → "txt"  (the `text/` branch) ← named the object .txt
    //   uploadToGCS(...)                             ← STORED IT ANYWAY
    //
    // The MONEY-1255 guard decided the row's STATUS and never the WRITE, so all
    // 1,580 rows are correctly `UNSUPPORTED` and every one of them still
    // carries a `gcsPath` pointing at a SEBI web page. `gcsPath` is the column
    // every reader takes as proof the bytes are there, which makes a claiming
    // row worse than no row at all.
    //
    // Refusing on the BODY also covers what a header never could: the same
    // landing page served under `application/pdf` would have passed every check
    // above and landed as a PENDING "PDF".
    const gate = mayStoreDocumentBody({ gcsPath, body: buffer });
    if (!gate.store) {
      await quarantineHtmlDownload(run, deps, {
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
      return 0;
    }

    // The OBJECT keeps the header it was served under — GCS metadata is not
    // matched on, and the raw value is genuine provenance for the bytes. Only
    // the COLUMN (and the object NAME, which the column must agree with) is
    // corrected from the bytes.
    await deps.uploadToGCS(gcsPath, buffer, rawContentType);
    run.api.gcsUploads++;

    const storedDoc = await deps.prisma.stockDocument.upsert({
      where: {
        symbol_exchange_docType_period: { symbol, exchange, docType, period },
      },
      create: {
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
        processingStatus: status,
        fetchedAt: new Date(),
      },
      update: {
        gcsPath,
        fileSize: buffer.length,
        // MONEY-1255 — the UPDATE arm carried `processingStatus: "PENDING"` and
        // did NOT touch mimeType, so a re-fetch re-queued the row under
        // whatever spelling it was first stored with. Both now come from THIS
        // response, or the repair is undone by the next weekly sync.
        mimeType: contentType,
        processingStatus: status,
        isEmbedded: false,
        fetchedAt: new Date(),
      },
    });

    // MONEY-1314 — announce it to the ingest lane. A no-op unless
    // DOC_INGEST_REALTIME="true" AND the row is a PDF, so this is safe to
    // call unconditionally; the gate lives in ONE place rather than at the
    // fifteen `stock_documents` writers, where the sixteenth would forget it.
    await publishDocumentIngest(storedDoc);

    logger.info(
      `Stored Screener ${docType} for ${symbol}: ${period} (${buffer.length} bytes, ${contentType}, ${status})`,
    );
    run.wrote.screener++;
    await deps.sleep(3000);
    return 1;
  } catch (err) {
    run.transportFailures++;
    logger.warn(
      `Screener download failed for ${symbol} ${period}: ${err instanceof Error ? err.message : err}`,
    );
    return 0;
  }
}

// ===========================================================================
// THE GAP THAT WAS CLOSED, AND THE ONE THAT WAS NOT — MONEY-1255 (A2)
// ===========================================================================
//
// This file used to end with a note titled "A STRUCTURAL GAP THIS TICKET DID
// NOT CLOSE", claiming that NO PRODUCER IN THIS REPO CAN GIVE A BSE-ONLY
// COMPANY AN `annual_report`. Three of its four clauses were right and the
// conclusion was wrong, so it is replaced rather than amended.
//
// STILL TRUE:
//   - Both NSE legs here read NSE endpoints (`fetchNSEFinancialResults`,
//     `fetchCategorizedAnnouncements`) and return nothing for a company NSE
//     does not list.
//   - The "Tickertape" leg is a read of `stock_financials`, filled by
//     `xbrl-projection` from an ingest that is NSE-FILERS ONLY.
//   - `bse-announcements-sync` writes exactly one docType, `corporate_filing`.
//
// WHAT THE NOTE MISSED: screener.in is not an NSE mirror. Probed live
// 2026-08-27 — 24 of 24 sampled BSE-only companies resolve through its company
// search, and 11 of 12 sampled pages carry 8-13 years of annual reports hosted
// on `bseindia.com/bseplus/AnnualReport/<scripcode>/`. The obstacle was never
// that the documents do not exist; it was that screener keys its page by a
// SLUG (usually the BSE scrip code) and this job only ever had a ticker.
// `screener-resolve.ts` is that missing lookup, and `InstrumentMapping`
// now carries the answer so it is resolved once per company, not once per run.
//
// ── WHAT IS STILL OPEN, and it is NOT in this file ─────────────────────────
//
// A `StockDocument(exchange: "BSE")` row survives every WORKER hop — the
// extract, parse, projection and embed selections carry no `exchange`
// predicate, and `stock-document-parse` stamps `doc.exchange` onto
// `DocumentFinancialExtract`, which the projection carries into the
// `StockFinancials` unique key. The Documents/Filings tab reads on `symbol`
// ALONE, so the annual reports DO surface.
//
// The NUMERIC surfaces do not, and the break is one line:
// `apps/web/app/stock/[symbol]/page.tsx:43` defaults `exchange` to `"NSE"`
// from the query string, `:74-79` looks the instrument up on that exchange
// with no BSE fallback, and `:113-116` synthesises `exchange: "NSE"` on a miss
// anyway. Every downstream numeric read is then exchange-scoped
// (`apps/web/lib/actions/stock-tabs.ts:226`,
// `packages/services/src/stock-tabs.service.ts:474`), so a BSE-only company
// opened at `/stock/SYM` queries `stock_financials WHERE exchange="NSE"` and
// renders an empty Financials tab beside a populated Documents tab.
// Secondary: the projection's CREATE branch is gated behind `createMissing`
// (default false), and a BSE-only company has no incumbent row — so its
// financials are a CREATE. Both are outside this job.
