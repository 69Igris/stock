/**
 * Company financials from NSE's own XBRL — MONEY-1113 (Data Engine P10 F1).
 *
 * ## What this job is
 *
 * The ingestion half of "we read the filing, not somebody's reading of it".
 * NSE indexes every result filed in a date window; each record points at an
 * XBRL XML on `nsearchives.nseindia.com`. This job walks a trailing window,
 * downloads the XMLs it does not already hold, parses them with the pure
 * `parseXbrlDocument`, and upserts `XbrlFiling`.
 *
 * Three pure modules carry the judgement, and this file does I/O only:
 *   `xbrl-filing-index`      — what the INDEX means (two eras, the page cap,
 *                              the four non-boolean flags, the stub URL)
 *   `xbrl-financials-logic`  — what a DOCUMENT means (namespace dispatch across
 *                              BOTH taxonomies, the four entry points, context
 *                              resolution, bank-vs-Ind-AS-vs-NBFC tags)
 *   `xbrl-sync-logic`        — what a RUN means (which counter an outcome
 *                              moves, the parse-health verdict, and whether a
 *                              failure is worth retrying)
 *
 * ## Two TAXONOMIES as well as two indexes — MONEY-1200
 *
 * `parseXbrlDocument` returns a discriminated outcome rather than
 * financials-or-null, and every arm is counted separately here. The reason is
 * the defect this job shipped with: it collapsed "well-formed filing in a
 * taxonomy we were never taught", "governance filing that correctly has no
 * numbers" and "not a document at all" into one `unparseable` counter, then
 * reported `ok: true` regardless. One prod run downloaded 1,500 filings,
 * understood 1,499 as nothing, wrote 0 rows, and looked healthy.
 *
 * ## Two indexes, and building against the obvious one produces a silent no-op
 *
 * SEBI's integrated-filing regime took effect for the quarter ending Dec-2024.
 * The legacy `/api/corporates-financial-results` stopped receiving new filings
 * at that point — it served 2,402 records for Nov-2024 and 31 for Nov-2025 —
 * while `/api/integrated-filing-results` took over. A daily job built on the
 * legacy endpoint alone finds nothing, forever, and reports success.
 *
 * ## The legacy index needs `period=`, and asking for one of two values hid half
 *
 * MONEY-1114. `?period=` is REQUIRED on the legacy index — omit it and a
 * perfectly successful 200 returns an empty array — and it takes exactly two
 * values, `Quarterly` and `Annual`. This job hardcoded `Quarterly`, so for its
 * entire life annual filings were not missing, they were never REQUESTED:
 * 1,539 annual records against 1,467 quarterly ones in May-2019 alone. It is
 * also why all 2,152 rows in prod were `periodType: "QUARTERLY"`.
 *
 * Both are now walked. NSE lists the same Q4 document under both (1,379 of
 * 1,491 annual URLs in May-2019 are also quarterly URLs), so the entries are
 * deduplicated by document before anything is downloaded.
 *
 * The MODERN index has no period vocabulary at all — measured byte-identical
 * responses for `Annual`, `Quarterly`, a bogus value and no parameter — so
 * there the period comes from the document, which is where it comes from for
 * BOTH eras now: see `classifyFilingPeriod` and `storeFiling`.
 *
 * ## The annual row is INSIDE the quarterly document
 *
 * A March-quarter filing declares the quarter and the financial year as two
 * contexts. The parser picks the quarter (correctly) and used to discard the
 * year. `storeAnnualCompanion` re-reads the same bytes for the year's context
 * and writes a second row — no extra download, and it is the only way to get
 * one, because `XbrlFiling.facts` holds the quarter's values and dates-only
 * metadata for everything else.
 *
 * ## The modern index silently caps at 20 records
 *
 * Measured: a 46-day window and a 6-day window both returned the same 20
 * records; the same window with `&size=5000` returned 5,000 across 2,101
 * symbols. Twenty is a plausible number of filings for a day, so the truncation
 * reads as a fact about the market.
 *
 * It is not literally silent — the envelope carries
 * `{size: 20, page: -1, totalCount: 7091}` — but it is easy to throw away,
 * because the LEGACY index returns a bare array and any unwrapping written for
 * both reaches past `data` and drops the rest. `detectTruncation` reads
 * `totalCount` first and falls back to the structural signal for the legacy
 * index, which genuinely has no envelope.
 *
 * Hence `PAGE_SIZE` below, real pagination, AND the truncation check as a belt —
 * a run that suspects truncation must say so rather than return a tidy number.
 *
 * ## Why a TRAILING WINDOW
 *
 * Unlike `surveillance-sync` and `institutional-flow-sync`, this feed CAN be
 * backfilled — the index takes from/to and the archives host keeps the XML. So
 * the schedule is not load-bearing, and a trailing window heals a lost run
 * instead of costing a day of filings permanently. It also absorbs late
 * broadcasts, which are routine.
 *
 * The overlap is nearly free: existing filings are skipped before the DOWNLOAD,
 * so a re-read costs one indexed query rather than a network round trip.
 *
 * ## Why PROD-ONLY
 *
 * One XML download per filing, which in earnings season is thousands per day —
 * the same per-symbol fan-out that makes `ownership-sync` prod-only. QA receives
 * `xbrl_filings` through `sync-prod-to-qa.sh`'s REFERENCE_COLLECTIONS.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { fetchNseApiJson } from "@usemoney/research/data-sources/nse-filings";
import {
  parseXbrlDocument,
  parseFilingIndexPage,
  detectTruncation,
  getFeedAsset,
  buildFilingIndexPath,
  classifyFilingPeriod,
  indexSupportsPaging,
  bseInstanceUrlCandidates,
  LEGACY_PERIOD_PARAMS,
  // MONEY-1255 — the exchange seam. `filingExchange` is the ONLY read of
  // `FilingIndexEntry.exchange`; see its doc for why the NSE default lives in
  // one place rather than at each write site.
  filingExchange,
  type FilingExchange,
  type FilingIndexEntry,
  type FilingIndexEra,
  type LegacyPeriodParam,
  type XbrlFinancials,
} from "@usemoney/core/market-data";
import {
  rankIsinCandidates,
  judgeXbrlParseHealth,
  bucketForOutcome,
  isNonFinancialFilingUrl,
  // MONEY-1250 — the era seam. Both indexes are live across Jan-Jun 2025, and a
  // monthly window can never straddle a boundary, so "straddles" was not a
  // condition that could ever fire for the backfill.
  erasForWindow,
  archiveDayForFiling,
  pickAnnualCompanion,
  // MONEY-1235 — the write order for one unique key, and the budget arithmetic
  // that charges index paging to the run's own ack-deadline budget.
  orderFilingsForWrite,
  downloadBudgetAfterIndexing,
  // MONEY-1252 — the archive-key grammar, shared with the re-parse job and the
  // backfill's `--archive-existing` probe so the three can never drift.
  XBRL_FEED_SLUG,
  candidateArchiveKeysForFiling,
  type XbrlOutcomeBucket,
  type ArchivedFilingRef,
} from "./xbrl-sync-logic";

/**
 * Which SYMBOLS the time-bounded download loop reaches first — MONEY-1238.
 *
 * ## The defect
 *
 * `orderFilingsForWrite` sorts the whole window OLDEST-FIRST, and it is right
 * to: for one `XbrlFiling` unique key the newest filing must be the LAST write,
 * or a Revision is overwritten by the Original it supersedes. But that ordering
 * is about WRITES, and the loop it feeds is bounded by WALL CLOCK
 * (`RUN_TIME_BUDGET_MS`, 480 s of the 600 s ack deadline). When the budget
 * binds — results season, when 2,000+ filings land in one window and NSE is
 * served at `DOWNLOAD_DELAY_MS` = 600 ms apiece — the loop stops partway
 * through a stream sorted oldest-first, so what it drops is the NEWEST filings
 * in the window. The results that just published are systematically last in
 * line, every night, for as many nights as the backlog takes to drain.
 *
 * ## The fix, and why it is a REGROUPING rather than a re-sort
 *
 * "Download in index order, order the upserts only" cannot be done literally
 * here: the download and the upsert are one loop, and separating them means
 * holding every XML in memory for the window. What CAN be separated is the
 * order symbols are VISITED from the order filings are written WITHIN a symbol.
 *
 * A `XbrlFiling` unique key carries `symbol`, so two entries for different
 * symbols can never collide on a row. Grouping by symbol and reordering the
 * GROUPS therefore cannot touch the invariant: within every group the relative
 * order `orderFilingsForWrite` produced is preserved EXACTLY, so the newest
 * filing for any key is still the last write for that key.
 *
 * Groups are ranked by their NEWEST member's position in the oldest-first
 * stream, descending — the symbol whose most recent filing is the most recent
 * overall goes first. A budget cut then drops the symbols that have been quiet
 * longest, which is the correct thing to defer: their filings are already old,
 * the trailing window will collect them, and `skippedExisting` means the ones
 * already downloaded cost nothing next run.
 *
 * TOTAL and stable: ties break on the group's first index, which is unique.
 * Exported for the test that proves both halves — the group order AND the
 * within-symbol order.
 */
export function downloadOrder(
  ordered: readonly FilingIndexEntry[],
): FilingIndexEntry[] {
  const groups = new Map<
    string,
    { newestAt: number; rows: FilingIndexEntry[] }
  >();
  ordered.forEach((entry, i) => {
    const g = groups.get(entry.symbol);
    if (g) {
      g.newestAt = i;
      g.rows.push(entry);
    } else {
      groups.set(entry.symbol, { newestAt: i, rows: [entry] });
    }
  });
  return [...groups.values()]
    .sort((a, b) => b.newestAt - a.newestAt)
    .flatMap((g) => g.rows);
}

const logger = {
  info: (data: unknown, msg: string) => console.log(`[xbrl-sync] ${msg}`, data),
  warn: (data: unknown, msg: string) =>
    console.warn(`[xbrl-sync] ${msg}`, data),
  error: (data: unknown, msg: string) =>
    console.error(`[xbrl-sync] ${msg}`, data),
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Seven days covers a long weekend plus a failed run plus a late broadcast. */
const DEFAULT_WINDOW_DAYS = 7;

/**
 * Records per index request. Explicit BECAUSE the default is 20 and silent —
 * see the header. Large enough that an ordinary day needs one request, small
 * enough that a page is a reasonable unit of retry.
 */
const PAGE_SIZE = 500;

/** Runaway guard on the paging loop, not an expected limit. */
const MAX_PAGES = 40;

/** Politeness between XML downloads. Mirrors NSE_PER_SYMBOL_DELAY_MS. */
export const DOWNLOAD_DELAY_MS = 600;

/**
 * Hard stop per run so one enormous window cannot run for hours.
 *
 * Kept as a runaway guard only. The BINDING limit is {@link RUN_TIME_BUDGET_MS}
 * below — a count cannot express the constraint that actually matters.
 */
const MAX_DOWNLOADS_PER_RUN = 1500;

/**
 * Wall-clock budget for the download phase — MONEY-1200.
 *
 * ## Why a count was the wrong limit
 *
 * The Pub/Sub push subscription has `ackDeadlineSeconds: 600` (verified live on
 * `xbrl-sync-prod-push`), and 600 is Pub/Sub's MAXIMUM — the deadline cannot be
 * raised. `MAX_DOWNLOADS_PER_RUN` (1500) × `DOWNLOAD_DELAY_MS` (600 ms) is 900 s
 * of SLEEPING alone, before a single HTTP round trip or indexed read. A full run
 * was arithmetically incapable of finishing inside its own deadline, so Pub/Sub
 * redelivered while the first attempt was still running and each redelivery
 * began another complete pass. That fits the ~11 deliveries in 57 minutes
 * observed on 2026-08-14 far better than a NACK chain does, since
 * `--max-delivery-attempts=5` caps that at five.
 *
 * Halving the count would have moved the cliff rather than removed it: the true
 * budget is TIME, and per-document cost is not a constant we control — it is a
 * fixed delay plus a network round trip plus an indexed read, and the network
 * half varies. A count only holds while every one of those stays put.
 *
 * ## What this does instead
 *
 * Stop when the elapsed wall clock passes this budget, set
 * `truncatedByBudget`, and let the TRAILING WINDOW collect the remainder on the
 * following runs — which is exactly what the trailing window is for, and why
 * this job is backfillable in the first place.
 *
 * 480 s of 600 s leaves 120 s of headroom. Deliberately not 590: the budget must
 * be beaten comfortably, because being wrong here does not slow a run down, it
 * duplicates the entire run.
 *
 * ## MONEY-1235 — the headroom is for the WRITES, not for the index
 *
 * This comment used to say the 120 s covered "the index paging that precedes
 * this loop and the writes that follow it", and the code then measured the
 * budget from AFTER paging. Both statements were individually reasonable and
 * together they double-spent the headroom: paging drew on it, and the download
 * loop still got its full 480 s afterwards. Index paging is now charged against
 * this same budget (`downloadBudgetAfterIndexing`), so the headroom protects
 * only what genuinely happens after the loop.
 */
export const RUN_TIME_BUDGET_MS = 480_000;

const XML_TIMEOUT_MS = 20_000;

/**
 * The page a browser would be on when it downloads one of these files.
 *
 * Passed as `getFeedAsset`'s positional `referer`, which is also why `Origin`
 * has to be dropped below: the seam derives `Origin` as
 * `referer.replace(/\/$/, "")`, which is correct only when the referer IS an
 * origin (`https://www.bseindia.com/`). Here it is a deep page, so the derived
 * value would be an Origin header carrying a path — a shape no browser sends.
 */
const XML_REFERER =
  "https://www.nseindia.com/companies-listing/corporate-filings-financial-results";

/**
 * Feed slug for the archive key — MOVED to `xbrl-sync-logic.ts` by MONEY-1252.
 *
 * Re-exported here so every existing importer (`scripts/jobs/xbrl-backfill.ts`)
 * is unchanged. It moved because it now has a SECOND reader that must agree
 * with this one byte-for-byte — `candidateArchiveKeysForFiling`, which is how a
 * stored row finds the object this fetch wrote — and the module those two share
 * has to be importable without Prisma.
 */
export { XBRL_FEED_SLUG } from "./xbrl-sync-logic";

/**
 * Headers merged OVER `fetchExchangeAsset`'s browser defaults.
 *
 * A browser UA is required — the archives host serves a challenge to a bare
 * client. Cookies are NOT: verified 2026-08-13 that the XML returns 200 with
 * `application/xml` and no session, unlike the JSON API on www.
 *
 * The seam's own defaults are shaped for the bhavcopy hosts: a Windows Chrome
 * UA, `Accept: text/csv,application/zip,…`, and an `Origin`. Only the three
 * that would change THIS request are overridden — the UA and `Accept` because
 * they are the verified pair, `Origin` to `null` because the request that was
 * verified did not carry one and it cannot be derived correctly from a
 * page-level referer anyway. `Accept-Language` is left as the seam sends it:
 * every real browser sends one, so keeping it makes the request more
 * browser-like, not less, which is the only axis these hosts fingerprint on.
 */
const XML_HEADER_OVERRIDES: Record<string, string | null> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  accept: "application/xml,text/xml,*/*",
  Origin: null,
};

/**
 * Per-exchange referer for an instance fetch — MONEY-1255.
 *
 * A referer is not decoration on these hosts. NSE's is the filings page the
 * link is reached from; BSE's must be its own origin, because BSE serves a
 * challenge page — 200, `text/html` — to requests whose referer is a different
 * site, and the `<!` guard in {@link fetchXml} would then record that as a
 * transport failure with no hint as to why.
 *
 * Keyed by exchange rather than sniffed from the URL host: the archive REPLAY
 * path hands back bytes from GCS, so at the moment the descriptor is built the
 * URL may not be the exchange's at all.
 */
const XML_REFERER_BY_EXCHANGE: Readonly<Record<FilingExchange, string>> = {
  NSE: XML_REFERER,
  BSE: "https://www.bseindia.com/",
};

/**
 * Per-exchange header overrides.
 *
 * BSE gets an `Origin` where NSE explicitly suppresses one. That asymmetry is
 * the verified behaviour of the two hosts, not tidiness: NSE's archives host
 * was confirmed to serve the XML without an Origin (and the one that could be
 * derived from a page-level referer would carry a path, which no browser
 * sends), while every working BSE call in this repo — the bhavcopy, the scrip
 * master, the announcements API — sends `Origin: https://www.bseindia.com`.
 */
const XML_HEADER_OVERRIDES_BY_EXCHANGE: Readonly<
  Record<FilingExchange, Record<string, string | null>>
> = {
  NSE: XML_HEADER_OVERRIDES,
  BSE: {
    ...XML_HEADER_OVERRIDES,
    Origin: "https://www.bseindia.com",
  },
};

/** The index's query format, `DD-MM-YYYY`. Not the ISO dates inside the XBRL. */
function toApiDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

function istToday(): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The `?period=` values to walk for an index.
 *
 * LEGACY: both, because the param is REQUIRED and matches exactly — see
 * `LEGACY_PERIOD_PARAMS`. This is the MONEY-1114 fix: the hardcoded
 * `?period=Quarterly&` meant annual filings were never REQUESTED, which is why
 * every one of the 2,152 stored rows was QUARTERLY.
 *
 * MODERN: `null`, i.e. send no period at all. Measured 2026-08-19 — the
 * integrated index IGNORES the parameter: `period=Annual`, `period=Quarterly`,
 * `period=Zzzz` and no period returned byte-identical 228,934-byte bodies for
 * 01-06-2025 → 30-06-2025. It serves every filing regardless of period, and the
 * period is a property of the DOCUMENT there.
 */
function periodParamsFor(
  era: FilingIndexEra,
): readonly (LegacyPeriodParam | null)[] {
  return era === "legacy" ? LEGACY_PERIOD_PARAMS : [null];
}

/**
 * The `pageSize` to hand `detectTruncation` for an index that does not page.
 *
 * `Infinity`, because its rule "a full page means there is more" has no meaning
 * where there are no pages. The legacy index answers the whole window in one
 * body (verified byte-identical across page=1/2/3 and no paging), so 1,467
 * records in it is the complete answer, not evidence of a cap. Passing the real
 * PAGE_SIZE would mark every legacy window truncated, forever.
 */
const UNPAGED_PAGE_SIZE = Number.POSITIVE_INFINITY;

export interface XbrlSyncResult {
  ok: boolean;
  /** Which index/indexes this run walked. */
  eras: FilingIndexEra[];
  /** Index records seen, before filtering. */
  listed: number;
  /**
   * Records whose `xbrl` is the `/-` stub rather than a `.xml`. NOT an error —
   * it is the normal state of a pre-2018 filing, and the single most important
   * number here, because it is what a `startsWith("http")` check would have
   * counted as coverage.
   */
  stubbed: number;
  /** Index records the parser could not normalise at all. */
  rejected: number;
  /** Already stored, so not downloaded again. */
  skippedExisting: number;
  /**
   * Recognised as non-financial from the URL and skipped WITHOUT downloading —
   * MONEY-1250. Counted separately from `skippedExisting` because the reason is
   * different: not "we have it", but "it was never ours to have". Also added to
   * `nonFinancial`, so that total keeps meaning "documents this window contained
   * that carry no financials", whether or not we spent a request on them.
   */
  skippedNonFinancialByUrl: number;
  downloaded: number;
  /**
   * Bytes arrived but nothing in them was a recognisable XBRL instance —
   * truncated uploads, a body that is not a document at all.
   *
   * NARROWER than it used to be, and deliberately so: it previously absorbed
   * every non-financials outcome, including 1,499 perfectly well-formed filings
   * in a taxonomy the parser had never been taught, and including every
   * governance filing. One number covering "malformed", "not taught yet" and
   * "correctly has no financials" cannot distinguish a broken run from a
   * healthy one — see `unknownTaxonomy` and `nonFinancial` below.
   */
  unparseable: number;
  /**
   * Well-formed XBRL in a taxonomy or entry point this parser cannot read.
   *
   * THE MONEY-1200 COUNTER. This is the one that would have been 1,499 while
   * every other number looked ordinary.
   */
  unknownTaxonomy: number;
  /**
   * The namespaces / entry points behind `unknownTaxonomy`, deduplicated and
   * capped. The fix for an unknown taxonomy is a table entry; this is what
   * makes finding it a log read rather than an investigation.
   */
  unknownTaxonomySamples: string[];
  /**
   * Recognised filings that legitimately carry NO financials — governance
   * filings, ~6% of a normal window.
   *
   * A HEALTHY outcome, counted separately precisely so it does not inflate
   * `unparseable` and put a permanent floor under the failure ratio.
   */
  nonFinancial: number;
  /**
   * Filings whose statement shape we RECOGNISE and deliberately do not map —
   * MONEY-1220. Today that is General Insurance (`IntegratedFinance_GI`), which
   * files the IRDAI Revenue Account rather than the Revenue → PBT → PAT ladder.
   *
   * Its own counter because neither neighbour tells the truth about it.
   * `unknownTaxonomy` would claim we do not know what it is (we do, and no code
   * change will ever clear the count); `nonFinancial` would claim it carries no
   * numbers (it carries the insurer's actual quarterly PAT). This number is the
   * size of a known product gap, and it should stay readable as one.
   */
  unmappedFamily: number;
  /**
   * The entry points behind `unmappedFamily`, deduplicated and capped — so the
   * log says WHICH shape is being skipped, not merely how many.
   */
  unmappedFamilySamples: string[];
  /** Parsed but with no usable period, so not storable. */
  noPeriod: number;
  /**
   * Parsed, dated, and REFUSED because the span matches no known period band —
   * MONEY-1114. A 14-month transition year, a 40-day stub period.
   *
   * Its own counter rather than a silent coercion: the ladder this replaced had
   * no gaps, so every one of these was stored under the nearest label with
   * nothing anywhere to say so. Non-zero here is a real signal — either a filer
   * shape worth adding a band for, or a parse that resolved the wrong context.
   */
  unclassifiedPeriod: number;
  /**
   * Filings carrying an ISIN that matches NO row in `instrument_mappings` —
   * MONEY-1299. The size of the mapping gap, stated as a number.
   *
   * READ IT WITH THE `symbol-exchange` RUNG, not alone. An ISIN miss is not the
   * same as an unresolved filing: the symbol leg runs next and rescues most of
   * them. Measured over prod's whole table, 25,016 filings have an ISIN no
   * mapping bears, and 18,284 of those — 73% — were nonetheless resolved by
   * symbol. So `unresolvedIsin - rungs["symbol-exchange"]` is what actually
   * landed with a null `instrumentId`, which is 6,732 filings over 275 symbols.
   * Collapsing the two into one counter would report a mapping gap four times
   * its real size and make the number useless for deciding anything.
   *
   * NOT a failure of this job and deliberately outside `judgeXbrlParseHealth`'s
   * ratio: the filing parsed perfectly, we simply do not carry the issuer. Of
   * the 6,732, 6,536 over 269 symbols are delisted or suspended issuers whose
   * ISIN is in no row at all — which is why no resolver change can close that
   * gap, and why this counter exists instead of a fix.
   */
  unresolvedIsin: number;
  /**
   * Census of which rung of the resolution ladder produced each `instrumentId`
   * — MONEY-1299. Keyed by {@link InstrumentRung}.
   *
   * Reported because the choice between a company's NSE and BSE rows is one
   * this job makes silently, got wrong for 78.3% of prod's filings, and can only
   * be checked against the filings' own exchange from OUTSIDE the decision. A
   * healthy NSE window is dominated by `isin-own-active`; a run drifting back
   * toward `isin-other-active` is the old defect returning, and it is otherwise
   * indistinguishable from a completely ordinary run.
   */
  instrumentRungs: Record<string, number>;
  written: number;
  /**
   * ANNUAL rows recovered from a document whose PRIMARY period is the quarter —
   * MONEY-1114. Costs no network: the same bytes, re-parsed for the year's
   * contextRef. See {@link storeAnnualCompanion}.
   */
  writtenAnnual: number;
  /** Documents carrying more than one full-year period. Refused, not guessed. */
  annualAmbiguous: number;
  /**
   * Documents whose full-year context was found but could not be read back or
   * stored. Should be 0; non-zero means the selector and the ranking disagree.
   */
  annualUnreadable: number;
  /** Transport failures. The trailing window retries them tomorrow. */
  fetchFailed: number;
  /** Stopped at MAX_DOWNLOADS_PER_RUN with work left. */
  truncatedByBudget: boolean;
  /**
   * The index itself looked capped. Distinct from `truncatedByBudget`: that is
   * OUR limit and is expected, this is THEIRS and is a bug signal.
   */
  indexTruncationSuspected: string[];
  /**
   * Why `ok` is false, when the cause is parse health rather than the index.
   * `null` on a healthy run. See `xbrl-sync-logic.ts` for the threshold.
   */
  parseHealthFailure: string | null;
  window: { from: string; to: string };
}

/** How many distinct unknown-taxonomy strings a result carries. */
const MAX_UNKNOWN_SAMPLES = 5;

/**
 * Download one filing's XBRL, through the GCS feed archive — MONEY-1204 (P0.2).
 *
 * ## Why the seam and not `fetch`
 *
 * This used to be a bare `fetch`, which meant NSE's filings were the one
 * exchange feed we downloaded every night and archived nowhere. That is
 * invisible by construction: the ingest works, the counters look right, and the
 * bytes are gone the moment NSE prunes them — which for `nsearchives` is a
 * measured behaviour, not a hypothesis (MONEY-1096). `getFeedAsset` is the one
 * place that knows `FEED_ARCHIVE_MODE`, so routing through it is what makes
 * prod archive these and QA able to replay them.
 *
 * ## The four contracts this function keeps
 *
 *  1. **It NEVER throws.** Every failure — non-2xx, timeout, DNS, a challenge
 *     page, anything the archive layer could raise — collapses to `null`, which
 *     the caller turns into `fetchFailed++`. The seam THROWS on a non-404
 *     non-OK, so the outer try/catch is load-bearing, not decoration. It is
 *     also wider than any status policy inside the seam could be, which is why
 *     no such policy was added there.
 *  2. **20 s**, not the seam's 30 s default: `timeoutMs` is passed explicitly.
 *     1,500 filings against a 480 s run budget cannot afford a 30 s stall.
 *  3. **The verified header set** — see {@link XML_HEADER_OVERRIDES}.
 *  4. **The `<!` challenge guard stays HERE.** `validateFeedPayload` runs only
 *     on the archive-write and replay-read paths, so with `FEED_ARCHIVE_MODE`
 *     unset (local dev, and the documented default for a new env) nothing would
 *     check the bytes at all. Both layers keep their own guard because they
 *     protect different things: this one protects the PARSE (an HTML page
 *     handed to `parseXbrlDocument` becomes a misleading `unparseable`), the
 *     other protects the ARCHIVE (an HTML page written to GCS is replayed as
 *     data forever).
 *
 * `archiveDay` is the filing's own day — see `archiveDayForFiling`, which owns
 * that judgement and is unit-tested.
 *
 * EXPORTED for `scripts/jobs/xbrl-backfill.ts --archive-existing`, which is a
 * separate entry point that needs to re-fetch a filing whose archived object is
 * missing. It calls this rather than reimplementing the request: the header set
 * is verified against a live host, and a second copy of it is a second thing to
 * get 403'd on its own schedule.
 */
export interface InstanceFetchPlan {
  /** `Referer` for the request. */
  referer: string;
  /** The archive descriptor — what `getFeedAsset` keys the GCS object on. */
  descriptor: {
    exchange: FilingExchange;
    feed: string;
    date: Date | undefined;
  };
  /** Headers merged OVER the seam's browser defaults. */
  headers: Record<string, string | null>;
}

/**
 * Everything about an instance fetch that depends on the EXCHANGE, as data.
 *
 * Pure, exported, and separate from {@link fetchXml} for one reason: the thing
 * this ticket had to change is the DESCRIPTOR, and a descriptor built inline
 * inside an async function that talks to GCS can only be tested by asserting
 * on the source text — which is a literal-vs-literal check that passes just as
 * happily against a re-hardcoded `"NSE"` if the string appears anywhere else in
 * the file.
 *
 * As a pure function it is asserted on its actual output, so re-hardcoding the
 * exchange makes the test fail on a value rather than on a substring.
 */
export function buildInstanceFetchPlan(
  exchange: FilingExchange,
  archiveDay: Date | undefined,
): InstanceFetchPlan {
  return {
    referer: XML_REFERER_BY_EXCHANGE[exchange],
    descriptor: { exchange, feed: XBRL_FEED_SLUG, date: archiveDay },
    headers: XML_HEADER_OVERRIDES_BY_EXCHANGE[exchange],
  };
}

/**
 * Observability for BSE's wrong-directory defect — MONEY-1255.
 *
 * Called ONLY when the URL the index gave us failed and a rewritten candidate
 * succeeded. It exists so the workaround cannot go quietly stale in either
 * direction: a recovery count that falls to zero while BSE-NBFC filings still
 * arrive means BSE fixed its index (delete the rewrite), and one that falls
 * while `fetchFailed` RISES means BSE moved the sibling directory (fix the
 * rewrite). Without it, both look identical from the outside.
 */
export type CandidateRecoveryHook = (info: {
  indexed: string;
  recovered: string;
}) => void;

export async function fetchXml(
  url: string,
  archiveDay: Date | undefined,
  exchange: FilingExchange = "NSE",
  onRecovery?: CandidateRecoveryHook,
): Promise<string | null> {
  const plan = buildInstanceFetchPlan(exchange, archiveDay);

  // NSE is unchanged: `candidates` is exactly the URL it was given, so the loop
  // runs once and this behaves as it always has. Only BSE can produce a second
  // candidate, and only for the one filename prefix BSE indexes into the wrong
  // directory — see `bseInstanceUrlCandidates`.
  //
  // The `getFeedAsset` call stays INSIDE this function rather than moving to a
  // per-attempt helper. `no-feed-fetch-bypass.test.ts` (MONEY-1204) asserts by
  // scanning this function's own body that the XBRL fetch still routes through
  // the archive seam, and a helper — however correct — reads to that guard as a
  // bypass. Keeping the call here keeps the guard meaningful instead of
  // requiring it to be taught about an indirection.
  const candidates = exchange === "BSE" ? bseInstanceUrlCandidates(url) : [url];

  for (const [i, candidate] of candidates.entries()) {
    let text: string | null = null;
    try {
      const resp = await getFeedAsset(
        candidate,
        plan.referer,
        plan.descriptor,
        // No per-call outcome: nothing here branches on whether the archive
        // write landed. Unlike report-archive-sync there is no terminal "done
        // for the day" state to poison — the trailing window re-reads the index
        // anyway, and a filing already in `xbrl_filings` is skipped before
        // download.
        undefined,
        { headers: plan.headers, timeoutMs: XML_TIMEOUT_MS },
      );
      if (resp) {
        const body = await resp.text();
        // A challenge page arrives as a 200 with HTML. Treat it as a transport
        // failure rather than handing it to the parser — the parser would
        // correctly return null and it would be counted as `unparseable`,
        // which is a different and misleading number.
        if (body.trim() && !body.trimStart().startsWith("<!")) text = body;
      }
    } catch {
      text = null;
    }

    if (text !== null) {
      if (i > 0)
        onRecovery?.({ indexed: candidates[0]!, recovered: candidate });
      return text;
    }
  }
  return null;
}

/**
 * Walk one (index, period) across the window.
 *
 * ## Only ONE of the two indexes pages, and pretending otherwise costs 40x
 *
 * The modern index pages properly — 1-based on the wire, echoed 0-based,
 * consecutive pages disjoint. The LEGACY index accepts `size` and `page` and
 * IGNORES them: measured on 01-05-2019 → 31-05-2019, `page=1`, `page=2`,
 * `page=3` and no paging params returned byte-identical 1,119,778-byte bodies
 * holding the same 1,467 seqNumbers in the same order.
 *
 * A "page until a short page" loop therefore never terminates on legacy data.
 * 1,467 is not < 500, so it re-requested the identical body until MAX_PAGES,
 * collecting the same entries forty times — forty index round trips per month
 * per period, an `entries` array forty times too long, and forty times the
 * per-entry `findFirst` in the download loop. That is invisible in the nightly
 * job (2026 windows are integrated-era only) and lands squarely on the
 * BACKFILL, which is legacy for every month from 2018 to 2024.
 *
 * `indexSupportsPaging` is the fact; this is the only place it is applied.
 *
 * Returns null only when the FIRST page is unreadable; a later failed page ends
 * the walk with whatever was collected, because partial coverage that says so
 * beats none.
 */
async function collectIndex(
  era: FilingIndexEra,
  period: LegacyPeriodParam | null,
  from: string,
  to: string,
  windowDays: number,
  out: XbrlSyncResult,
): Promise<FilingIndexEntry[] | null> {
  const entries: FilingIndexEntry[] = [];
  const paged = indexSupportsPaging(era);
  const maxPages = paged ? MAX_PAGES : 1;
  const pageSize = paged ? PAGE_SIZE : UNPAGED_PAGE_SIZE;
  const label = period === null ? era : `${era}/${period}`;
  /** Records seen across every page of THIS query — the totalCount denominator. */
  let collected = 0;

  for (let page = 1; page <= maxPages; page++) {
    const payload = await fetchNseApiJson<unknown>(
      buildFilingIndexPath({
        era,
        from,
        to,
        size: PAGE_SIZE,
        page,
        period,
      }),
    );
    if (payload === null) {
      if (page === 1) return null;
      logger.warn(
        { era, period, page },
        "index page failed — stopping the walk here",
      );
      break;
    }

    const parsed = parseFilingIndexPage(payload, era);
    if (parsed === null) {
      if (page === 1) return null;
      logger.warn(
        { era, period, page },
        "index page had an UNRECOGNISED shape",
      );
      break;
    }

    out.listed += parsed.listed;
    out.stubbed += parsed.stubbed;
    out.rejected += parsed.rejected.length;
    entries.push(...parsed.entries);
    collected += parsed.listed;

    // `distinctDays` is deliberately NOT passed: the module owns that
    // computation now. Three of every twenty modern records are Revisions with
    // a null broadcast date, so the obvious call-site version counts one bucket
    // too many and silently disables the guard.
    //
    // `collected` IS passed, and it is the MONEY-1114 fix to the warning that
    // fired on every healthy prod run: `totalCount` describes the QUERY, so it
    // has to be compared against what the WALK has, not against the last page.
    // The nightly 7-day window is 1,446 records at size 500 — pages of
    // 500/500/446 — and the final short page was reported as
    // "totalCount=1446 but returned 446" on a complete walk.
    const verdict = detectTruncation(parsed, {
      pageSize,
      windowDays,
      collected,
    });

    if (!paged) {
      // One shot: the body IS the window. Rule 2 is disabled via
      // UNPAGED_PAGE_SIZE, so anything `verdict` says here is either the
      // server's own count or the structural newest-N signature — both real.
      if (verdict.truncated) {
        out.indexTruncationSuspected.push(`${label}: ${verdict.reason}`);
      }
      break;
    }

    // A full page means "there is more", which is normal and is exactly why we
    // page. It is only worth REPORTING when the loop has ended anyway — the
    // structural signal (everything on one or two days) is the one that means
    // a cap we do not control.
    if (parsed.listed < PAGE_SIZE) {
      // A short page normally ends the walk. It does NOT when the server's own
      // totalCount says there is more — that is the exact signal, and trusting
      // "short page means done" over it is how the 20-record cap looked like a
      // complete answer in the first place.
      //
      // THE COMMENT ABOVE WAS TRUE AND THE CODE BELOW IT WAS NOT — MONEY-1237.
      // The `break` was unconditional, so on the documented failure shape (NSE
      // applying its 20-record default while totalCount reports thousands) the
      // walk recorded a suspicion into `indexTruncationSuspected` — consumed by
      // ONE logger.warn — and stopped at page 1 with 20 of, say, 7,091 filings.
      // No error, no bad status: a healthy-looking run short by 99.7% of its
      // window, while an auditor reading the comment concluded the hole was
      // closed. The signal was computed and inert — this ticket family's defining
      // defect. The walk now KEEPS PAGING on that signal, safely: the for-loop is
      // bounded by maxPages.
      //
      // AND THE EXHAUSTION REPORT HAS TO LIVE HERE — MONEY-1236. This comment
      // used to point at the `page === MAX_PAGES` guard below, but that guard
      // sits AFTER this whole block and is therefore only reachable on a FULL
      // page. On the exact failure named above — NSE applying a 20-record
      // default while PAGE_SIZE is 500 — EVERY page is short, so control always
      // lands here and leaves through the `break`, and the guard never ran. The
      // cited protection did not exist for the case it was cited for.
      if (verdict.truncated) {
        out.indexTruncationSuspected.push(
          `${label} p${page}: ${verdict.reason}`,
        );
        if (page < maxPages) continue;
        out.indexTruncationSuspected.push(
          `${label}: EXHAUSTED ${maxPages} page(s) still reporting truncation ` +
            `after ${collected} record(s) — the walk stopped because it ran out ` +
            `of pages, NOT because the window was complete. Filings are missing.`,
        );
      }
      break;
    }
    if (page === MAX_PAGES) {
      out.indexTruncationSuspected.push(
        `${label}: hit MAX_PAGES (${MAX_PAGES}) with a full page — the window ` +
          `is too wide for one run and filings are being missed`,
      );
    }
  }

  return entries;
}

// MONEY-1299 — the instrument ladder is PURE and lives in the logic sibling, so
// `scripts/data/reresolve-xbrl-instruments.ts` can import it WITHOUT dragging in
// this module's Prisma client. That matters: an ops script that constructs a DB
// client before `--env` is resolved connects to whatever ambient DATABASE_URL
// happens to be set, which is the documented trap on `reclassify-instruments.ts`.
// Re-exported here so the resolver, its tests and the reparse script keep one
// import site.
export {
  rankIsinCandidates,
  type InstrumentRung,
  type InstrumentCandidate,
  type InstrumentChoice,
  type InstrumentResolutionTally,
} from "./xbrl-sync-logic";
// `export ... from` re-exports without BINDING locally; the resolver below uses
// these names, so they are imported as well.
import type {
  InstrumentRung,
  InstrumentCandidate,
  InstrumentChoice,
  InstrumentResolutionTally,
} from "./xbrl-sync-logic";

/**
 * Resolve our instrument, best-effort. ISIN first — it survives symbol changes,
 * which is precisely when a filing is most likely to be mis-joined.
 *
 * Returns null freely. `XbrlFiling.instrumentId` is nullable BECAUSE a filing
 * from an issuer we do not carry is still a real filing; dropping it here would
 * discard exactly the rows that reveal a mapping gap. That is the DOMINANT
 * case, and it is worth stating plainly so nobody re-opens MONEY-1299 expecting
 * this function to close it: of the 6,732 filings across 275 symbols that carry
 * an ISIN and no `instrumentId` (measured on prod 2026-08-30), **6,536 across
 * 269 symbols have no row in `instrument_mappings` bearing that ISIN at all** —
 * verified by a control join and by case-insensitive probes. They are delisted
 * or suspended issuers (RELCAPITAL, JPASSOCIAT, TALWALKARS, TATACOFFEE
 * post-merger) whose filings we archived and whose instrument rows we never
 * carried. No ranking can conjure a row that is not there; they are COUNTED as
 * {@link InstrumentResolutionTally.unresolvedIsin} instead, so the gap is a
 * number in the job log rather than a silent null.
 */
async function resolveInstrumentId(
  symbol: string,
  isin: string | null,
  deps?: XbrlStoreDeps,
  exchange: FilingExchange = "NSE",
  tally?: InstrumentResolutionTally,
): Promise<InstrumentChoice | null> {
  const db = deps ?? prisma;
  const record = (choice: InstrumentChoice): InstrumentChoice => {
    if (tally) {
      tally.instrumentRungs[choice.rung] =
        (tally.instrumentRungs[choice.rung] ?? 0) + 1;
    }
    return choice;
  };

  if (isin) {
    const finder = db.instrumentMapping.findMany;
    if (finder) {
      const rows = (await finder.call(db.instrumentMapping, {
        where: { isin },
        select: { id: true, exchange: true, isActive: true },
      })) as InstrumentCandidate[];
      const choice = rankIsinCandidates(rows ?? [], exchange);
      if (choice) return record(choice);
    } else {
      // A double that predates MONEY-1299. NOT a silent equivalence: the
      // resolution is reported under its own rung, so "we did not rank" can
      // never be read off the log as "we ranked and this won". The nightly job
      // calls `storeFiling` with NO deps, so it always takes the branch above.
      const byIsin = await db.instrumentMapping.findFirst({
        where: { isin },
        select: { id: true },
      });
      if (byIsin) return record({ id: byIsin.id, rung: "isin-unranked" });
    }
    if (tally) tally.unresolvedIsin++;
  }
  // The symbol leg must be scoped to the exchange the SYMBOL belongs to. A BSE
  // filing whose symbol was recovered through the bridge names an NSE-listed
  // instrument (the bridge resolves via the BSE scrip code and returns the
  // mapping's own symbol), so the lookup that follows is still exchange-keyed
  // and must be told which one rather than assuming.
  //
  // Deterministic without an `orderBy`: `InstrumentMapping` carries
  // `@@unique([symbol, exchange])`, so this pair selects at most one row.
  const bySymbol = await db.instrumentMapping.findFirst({
    where: { symbol, exchange },
    select: { id: true },
  });
  return bySymbol ? record({ id: bySymbol.id, rung: "symbol-exchange" }) : null;
}

/**
 * Symbol values that are PRESENT in a filing and mean "there is no symbol".
 *
 * ## Why this exists at all — MONEY-1255
 *
 * A BSE-only issuer's integrated-era instance does not OMIT the symbol fact. It
 * files `<in-capmkt:Symbol>NOTLISTED</in-capmkt:Symbol>` — verified on NPR
 * Finance (530127) and Apollo Finvest (512437), both in-capmkt, 2025-01-31 and
 * 2026-01-31. `resolveSymbol` correctly skips the scrip-code-schemed entity
 * identifier and falls through to that fact, so without this list the string
 * `"NOTLISTED"` is what reaches the write.
 *
 * That is not a cosmetic wrong label. `XbrlFiling`'s unique key is
 * `symbol + exchange + periodEnd + periodType + basis + cumulative`, so EVERY
 * BSE-only issuer filing a given quarter on a given basis collapses onto ONE
 * row and they overwrite each other — a silent cross-company data merge that
 * looks like a working ingest with a suspiciously low row count.
 *
 * Compared case-insensitively after trimming, because it is a filer-entered
 * field and the ones observed are not internally consistent about spacing.
 */
const UNUSABLE_SYMBOLS: ReadonlySet<string> = new Set([
  "NOTLISTED",
  "NOT LISTED",
  "NOTAPPLICABLE",
  "NOT APPLICABLE",
  "NA",
  "N.A.",
  "NIL",
  "-",
]);

/** Is this a symbol we can key a filing on? */
export function isUsableSymbol(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim();
  if (v.length === 0) return false;
  return !UNUSABLE_SYMBOLS.has(v.toUpperCase());
}

/**
 * The symbol a filing will be WRITTEN under, or `null` if it has none.
 *
 * ## The bridge, and why it must run BEFORE the write
 *
 * `XbrlFiling.symbol` is a required non-null column and it is part of the
 * unique key. A BSE filing may identify its issuer ONLY by scrip code, so
 * something has to turn that into a symbol, and it has to happen before the
 * upsert — after it, the row is already in the wrong place.
 *
 * Resolution order, most specific first:
 *
 *  1. The symbol the index or the document states, IF it is usable. NSE
 *     filings and dual-listed BSE filings (RELIANCE files `<Symbol>RELIANCE`)
 *     stop here, which is why this is a pure addition for NSE.
 *  2. `InstrumentMapping.bseScripCode` — the direct bridge.
 *  3. ISIN. Kept as a second leg because it is present in every BSE instance
 *     observed, and `bseScripCode` is a recently-populated column: a filing
 *     that arrives before the scrip-code backfill reaches its issuer would
 *     otherwise be dropped for a reason that has nothing to do with the filing.
 *
 * An unresolvable filing is COUNTED and skipped — never guessed at, and never
 * allowed to throw. Writing a filing under a symbol we inferred would put real
 * numbers on the wrong company, which is strictly worse than not having them.
 */
export async function resolveWritableSymbol(
  candidate: string | null | undefined,
  identity: { scripCode?: string | null; isin?: string | null },
  deps?: XbrlStoreDeps,
): Promise<string | null> {
  if (isUsableSymbol(candidate)) return candidate!.trim().toUpperCase();

  const db = deps ?? prisma;
  const scripCode = identity.scripCode?.trim();
  // `"000000"` is what an NSE-only filer states for "not listed on BSE". It is
  // a real value in the data and joins to nothing, so it is rejected here
  // rather than sent to the database as a lookup that can only ever miss.
  if (scripCode && /^\d+$/.test(scripCode) && Number(scripCode) > 0) {
    const byScrip = await pickWritableSymbol(db, { bseScripCode: scripCode });
    if (byScrip) return byScrip;
  }

  const isin = identity.isin?.trim();
  if (isin) {
    const byIsin = await pickWritableSymbol(db, { isin });
    if (byIsin) return byIsin;
  }

  return null;
}

/**
 * One `where`, ranked — never `findFirst`.
 *
 * MONEY-1299 removed exactly this shape from the instrument resolver 200 lines
 * below, and it survived up here. An unordered `findFirst` "reads as 'any row
 * with this ISIN will do', and it is not": 2,155 ISINs in this table carry more
 * than one row, and the branch's own evidence is 163 filings whose BSE row
 * holds a DIFFERENT company's symbol — GILLETTE/PGHH, GLOBOFFS/GARWAOFFS,
 * OCCL/AGVENTURES.
 *
 * That matters more here than at the other site, not less. This decides
 * `XbrlFiling.symbol`, which is a required column AND part of the unique key,
 * so an arbitrary pick does not merely mis-attribute one row — it files the
 * company's numbers under another company's key, which is the outcome the
 * function's own docstring calls "strictly worse than not having them".
 *
 * Reuses `rankIsinCandidates` rather than restating a ladder: own-exchange
 * before other, active before inactive, and a final tie-break on `id` so the
 * order is TOTAL. Repeated calls, and calls from different runs, must agree —
 * storage order is not a decision.
 *
 * The exchange is `"BSE"` because this bridge only runs for BSE filers that
 * state `<Symbol>NOTLISTED`; an NSE filing has a usable symbol and returned
 * before reaching here.
 *
 * Falls back to `findFirst` when a caller's double supplies no `findMany`, the
 * same way the resolver below does — but the fallback now also carries an
 * `orderBy`, so even that path is deterministic rather than storage-ordered.
 */
async function pickWritableSymbol(
  db: typeof prisma | XbrlStoreDeps,
  where: { isin?: string; bseScripCode?: string },
): Promise<string | null> {
  const finder = db.instrumentMapping.findMany;
  if (finder) {
    const rows = (await finder.call(db.instrumentMapping, {
      where,
      select: { id: true, symbol: true, exchange: true, isActive: true },
    })) as (InstrumentCandidate & { symbol?: string | null })[];
    const usable = (rows ?? []).filter((r) => isUsableSymbol(r.symbol));
    const choice = rankIsinCandidates(usable, "BSE");
    if (choice) {
      const won = usable.find((r) => r.id === choice.id);
      if (isUsableSymbol(won?.symbol)) return won!.symbol!.trim().toUpperCase();
    }
    return null;
  }
  const row = await db.instrumentMapping.findFirst!({
    where,
    // Deterministic even on the degraded path. Not the full ladder — that needs
    // the candidate set — but never storage order.
    orderBy: [{ isActive: "desc" }, { id: "asc" }],
    select: { id: true, symbol: true },
  });
  return isUsableSymbol(row?.symbol) ? row!.symbol!.trim().toUpperCase() : null;
}

/** ISO `YYYY-MM-DD` from the XBRL to a UTC-midnight Date. */
function isoToUtc(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Why a parsed filing was not stored. Every arm is a REFUSAL, never a guess. */
export type StoreOutcome =
  | "written"
  | "no-symbol"
  | "no-period"
  | "unclassified";

/**
 * The slice of Prisma the write path uses.
 *
 * Injected so `storeFiling` and `storeAnnualCompanion` can be exercised for
 * real — the period-authority rule below is the highest-consequence decision in
 * this file and it is not expressible as a pure function, because what it
 * asserts is that a particular input (`entry.periodType`) is NOT consulted.
 * Only a functional test over the actual write can prove an absence.
 */
export interface XbrlStoreDeps {
  instrumentMapping: {
    /**
     * `symbol` is OPTIONAL on the result so existing doubles that resolve
     * `{ id }` keep compiling. The scrip-code bridge selects it explicitly and
     * treats an absent one as "unresolved" — see {@link resolveWritableSymbol},
     * which requires a USABLE symbol rather than merely a row, so a double that
     * returns `{ id }` alone can never silently supply an empty symbol to the
     * unique key.
     */
    findFirst: (
      args: unknown,
    ) => Promise<{ id: string; symbol?: string | null } | null>;
    /**
     * OPTIONAL — MONEY-1299, and its absence does NOT fail open.
     *
     * The ISIN leg ranks EVERY row bearing the ISIN (see
     * {@link rankIsinCandidates}: a dual listing is two rows for one company,
     * and 78.3% of prod's resolved filings were attached to the wrong one). It
     * therefore needs `findMany`, which the doubles written before this ticket
     * do not supply — and `scripts/jobs/xbrl-reparse.ts` builds one of them.
     *
     * Required would break those at compile time; optional-and-silent would let
     * an unranked resolution be read off the log as a ranked one. So a double
     * without it gets the pre-MONEY-1299 lookup reported under the DISTINCT rung
     * `isin-unranked`. The nightly path calls `storeFiling` with no deps at all
     * and always ranks.
     */
    findMany?: (args: unknown) => Promise<InstrumentCandidate[]>;
  };
  xbrlFiling: {
    upsert: (args: unknown) => Promise<unknown>;
    /**
     * OPTIONAL, and its absence FAILS OPEN — MONEY-1238.
     *
     * `storeFiling` reads the incumbent to decide whether the update must clear
     * `projectedAt` (see {@link projectionInputChanged}). A deps double that
     * does not supply it gets the old unconditional clear, which is the SAFE
     * direction: an unnecessary re-projection costs one nightly no-op, while a
     * missed one leaves `stock_financials` serving superseded numbers, which is
     * the defect the clear was added for in the first place.
     */
    findUnique?: (
      args: unknown,
    ) => Promise<{ sourceUrl?: string | null; facts?: unknown } | null>;
  };
}

/**
 * Would re-storing this filing change anything the PROJECTION reads?
 *
 * ## Why `storeFiling` has to ask at all — MONEY-1238
 *
 * The `update:` branch clears `projectedAt` unconditionally, and its own
 * comment argues that this is cheap "by construction ... because an unchanged
 * filing is short-circuited by the `sourceUrl` skip before it is ever
 * downloaded". That is true of `processXbrlSync`'s download loop and FALSE of
 * `scripts/jobs/xbrl-backfill.ts --annual-existing`, which exists precisely to
 * re-read stored rows' XML and reaches this same upsert through
 * `backfillAnnualFromXml` -> `storeAnnualCompanion` -> `storeFiling`. There is
 * no `sourceUrl` skip on that path — skipping is the one thing it must not do.
 *
 * So every ANNUAL companion it touches has its projection cursor reset, whether
 * or not a single number changed. Run against a window whose annual rows have
 * already been drained, that RE-INFLATES the backlog the drain just cleared,
 * and the projection then re-decides a page of filings per night that it
 * already decided. The switchover runbook's drain arithmetic is computed off
 * the unprojected count; a pass that silently grows it makes that number a
 * moving target with nothing to say so.
 *
 * ## What "changed" means, and why it is not a deep equality
 *
 * The projection reads `facts.values` and `facts.family`; the write plan
 * compares `sourceUrl` through `sameProvenance`. Those three are the inputs, so
 * those three are what is compared — key-by-key over the union, never
 * `JSON.stringify`, because an object that has round-tripped through Mongo does
 * not preserve construction key order and a stringify comparison would differ
 * every run in production while matching perfectly in a test.
 *
 * ## It FAILS OPEN, deliberately
 *
 * Anything unreadable, absent or ambiguous returns TRUE (clear the cursor). A
 * false "changed" costs one re-projection that `planFinancialsWrite` answers
 * with SKIP/UNCHANGED; a false "unchanged" leaves the reader-facing table on
 * superseded numbers forever, which is strictly worse and silent.
 */
export function projectionInputChanged(
  stored: { sourceUrl?: string | null; facts?: unknown } | null | undefined,
  next: { sourceUrl: string; financials: XbrlFinancials },
): boolean {
  if (!stored) return true;
  if (stored.sourceUrl !== next.sourceUrl) return true;
  const facts = stored.facts;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return true;
  const f = facts as { family?: unknown; values?: unknown };
  if (f.family !== next.financials.family) return true;
  const storedValues = f.values;
  if (
    !storedValues ||
    typeof storedValues !== "object" ||
    Array.isArray(storedValues)
  ) {
    return true;
  }
  const a = storedValues as Record<string, unknown>;
  const b = next.financials.values as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] !== b[key]) return true;
  }
  return false;
}

export async function storeFiling(
  entry: FilingIndexEntry,
  financials: XbrlFinancials,
  deps?: XbrlStoreDeps,
  /**
   * MONEY-1299 — where the instrument-resolution census is accumulated. OPTIONAL
   * because two callers (the reparse script, the annual companion) have no run
   * outcome to hand it; the nightly loop passes its own `out`, which satisfies
   * this structurally, so the rung breakdown and `unresolvedIsin` reach the log.
   */
  tally?: InstrumentResolutionTally,
): Promise<StoreOutcome> {
  // The exchange the filing belongs to. Read ONCE, here, and threaded through
  // every write below — the four places that used to say `"NSE"` outright.
  const exchange = filingExchange(entry);

  // The symbol bridge. `entry.symbol` is preferred over the document's for the
  // same reason as before; what is new is that neither is trusted merely for
  // being non-empty, because a BSE-only issuer states `"NOTLISTED"` rather than
  // stating nothing. An unresolvable filing is counted as `no-symbol`, exactly
  // as an absent one always was.
  const symbol = await resolveWritableSymbol(
    entry.symbol || financials.symbol,
    {
      scripCode: financials.scripCode ?? entry.scripCode,
      isin: financials.isin ?? entry.isin,
    },
    deps,
  );
  if (!symbol) return "no-symbol";

  const periodStart = isoToUtc(financials.period.start);
  const periodEnd = isoToUtc(financials.period.end);
  if (!periodStart || !periodEnd) return "no-period";

  // The DOCUMENT's basis wins over the index's: the document is the filing, the
  // index is a catalogue of it. The index is the fallback only when the
  // document does not say.
  const basis =
    financials.basis === "consolidated"
      ? "CONSOLIDATED"
      : financials.basis === "standalone"
        ? "STANDALONE"
        : entry.basis;

  // ── The period type and the cumulative flag come from the DOCUMENT'S OWN
  //    SPAN, never from the index. MONEY-1114.
  //
  // This used to be `entry.periodType ?? inferPeriodType(days)`, i.e. the
  // index's word first. That was harmless only while the index was asked for
  // `period=Quarterly` and nothing else. The moment `period=Annual` is
  // requested — which is the point of this ticket — it becomes the worst bug
  // available here: NSE lists the SAME Q4 document under both periods (1,379 of
  // 1,491 annual URLs in May-2019 are also quarterly URLs), so an `entry` from
  // the Annual page carries `periodType: "ANNUAL"` while the document's primary
  // period is the January-March QUARTER. Trusting the index would store three
  // months of revenue as the financial year, under a unique key that makes it
  // the incumbent for that year.
  //
  // Same principle as `basis` above, and for the same reason: the document is
  // the filing, the index is a catalogue of it.
  //
  // `classifyFilingPeriod` REFUSES a span it does not recognise rather than
  // rounding it into the nearest bucket — see its own doc for the three ways
  // the old ladder mislabelled real filings without a single log line.
  const periodClass = classifyFilingPeriod(financials.period.days);
  if (periodClass === null) return "unclassified";
  const { periodType, cumulative } = periodClass;

  const isin = financials.isin ?? entry.isin;
  const resolved = await resolveInstrumentId(
    symbol,
    isin,
    deps,
    exchange,
    tally,
  );
  const instrumentId = resolved?.id ?? null;
  const db = deps ?? prisma;

  // EXPECTED concepts only, both sides — MONEY-1250 review.
  //
  // `coverage.present` lists every concept FOUND, including ones declared
  // `expectedIn: OPTIONAL`; `coverage.missing` lists only concepts that were
  // EXPECTED and absent. So an optional concept was a numerator credit that no
  // denominator could ever debit, and the stored score drifted upward for
  // newly-parsed lender filings while older rows kept the old basis — with
  // `selectFilingForPeriod` using this value as a same-basis tiebreak.
  //
  // `byGroup` already carries the expected-only pair, so the score now means
  // "how much of what we REQUIRE did this filing supply" and stays stable as
  // optional concepts are added.
  const byGroup = Object.values(financials.coverage.byGroup);
  const presentCount = byGroup.reduce((n, g) => n + g.present, 0);
  const missingCount =
    byGroup.reduce((n, g) => n + g.expected, 0) - presentCount;

  const data = {
    instrumentId,
    symbol,
    exchange,
    isin,
    periodType,
    periodStart,
    periodEnd,
    cumulative,
    basis,
    audited: financials.audited ?? entry.audited ?? false,
    filerKind: entry.filerKind,
    taxonomyVersion: financials.taxonomy.version,
    // The whole parsed result, not just `values`. The taxonomy, the resolved
    // context and its `source` ("reported-facts" vs "context-period") are what
    // make a stored number defensible later: F3 needs to know whether a period
    // was pinned by the filer's own start/end facts or merely inferred from
    // document order, because the second cannot separate a quarter from the YTD
    // column that shares its declared period.
    facts: financials as unknown as object,
    conceptsFound: financials.coverage.present,
    coverage:
      presentCount + missingCount === 0
        ? 0
        : presentCount / (presentCount + missingCount),
    sourceUrl: entry.xbrlUrl,
  };

  // ── `filedAt` — a REVISION must never blank the date its Original supplied.
  //
  // MONEY-1235. A modern Revision record carries `broadcast_Date: null` and
  // states its date in `revised_Date` instead — 3 of the 20 records in
  // `integrated-capped-20.sample.json`, 16 of 20 in the 2025-06 capture, so
  // this is the common shape of a revision, not an edge case. Writing
  // `filedAt: entry.broadcastAt` straight through therefore had a revision
  // overwrite a perfectly good `filedAt` with null.
  //
  // `broadcastAt ?? revisedAt` first, then — when the entry states NEITHER —
  // the key is OMITTED from the update payload entirely rather than sent as
  // null. `update:` replaces every key it names, so "leave it alone" has to be
  // expressed as absence; there is no null that means "keep". `create:` still
  // carries it, because a new row genuinely has no incumbent to preserve and an
  // explicitly-null `filedAt` is the honest record of "NSE gave no date".
  const filedAt = entry.broadcastAt ?? entry.revisedAt;

  // MONEY-1238 — read the incumbent to decide whether the update must clear the
  // projection cursor. One indexed read on the write path; see
  // `projectionInputChanged` for why the unconditional clear was wrong and why
  // an ABSENT `findUnique` falls back to clearing.
  // MONEY-1255: this is the FIFTH `exchange` literal in this file and the one
  // easiest to miss, because it is a READ rather than a write. It fetches the
  // incumbent row to decide whether `projectedAt` must be cleared
  // (`projectionInputChanged`). Left hardcoded, a BSE filing would compare
  // itself against the NSE row for the same symbol and period and conclude
  // "nothing changed" from a document it has never seen.
  const filingKey = {
    symbol,
    exchange,
    periodEnd,
    periodType,
    basis,
    cumulative,
  };
  const storedFiling = db.xbrlFiling.findUnique
    ? await db.xbrlFiling.findUnique({
        where: {
          symbol_exchange_periodEnd_periodType_basis_cumulative: filingKey,
        },
        select: { sourceUrl: true, facts: true },
      })
    : null;
  const resetProjection = projectionInputChanged(storedFiling, {
    sourceUrl: entry.xbrlUrl,
    financials,
  });

  await db.xbrlFiling.upsert({
    where: {
      symbol_exchange_periodEnd_periodType_basis_cumulative: {
        symbol,
        exchange,
        periodEnd,
        periodType,
        basis,
        cumulative,
      },
    },
    create: { ...data, filedAt },
    // A re-read overwrites. NSE re-publishes corrected filings (the modern index
    // even flags them, `type_Sub: "Revision"`), and the later reading is the
    // better one — which is also why `sourceUrl` is not in the key: a correction
    // at a new URL must UPDATE the period, not fork it.
    //
    // Which order the siblings arrive in is NOT left to the index: entries are
    // sorted oldest-first before the download loop, so for one unique key the
    // newest filing is always the last write. See `orderFilingsForWrite`.
    update: {
      ...data,
      ...(filedAt !== null ? { filedAt } : {}),
      // ── MONEY-1235: clearing the projection's ONLY cursor.
      //
      // `projectedAt` is stamped by `xbrl-projection` and was unset by nothing,
      // anywhere in the repo. The projection selects with
      // `unprojectedOnly: true` → `UNPROJECTED_FILING_WHERE`
      // (`{OR: [{projectedAt: null}, {projectedAt: {isSet: false}}]}`), so a
      // filing that had already been projected and then had its `facts`
      // rewritten was invisible to the projection FOREVER and `stock_financials`
      // kept serving the superseded numbers.
      //
      // Explicit `null`, which is exactly what the `{projectedAt: null}` arm of
      // that filter exists for — "a row explicitly reset later", as distinct
      // from `isSet: false` for a row never stamped at all. On Mongo those are
      // two different states and a filter for one does not match the other
      // (MONEY-1234).
      //
      // UPDATE ONLY. The `create:` branch must keep omitting it: a new row is
      // absent-and-therefore-selected via `isSet: false`, and writing an
      // explicit null there would be a second way of saying the same thing.
      //
      // CONDITIONAL since MONEY-1238. The claim this used to carry — "cheap by
      // construction: this branch fires precisely and only for a revision,
      // because an unchanged filing is short-circuited by the `sourceUrl` skip
      // before it is ever downloaded" — is true of `processXbrlSync` and FALSE
      // of `xbrl-backfill.ts --annual-existing`, which re-reads stored rows by
      // design and has no such skip. Clearing there re-inflates a drained
      // projection backlog with nothing changed and nothing logged.
      //
      // A genuine revision still clears: it arrives at a new `sourceUrl`, and
      // even a same-URL re-parse that moves a value is caught by the values
      // comparison. See `projectionInputChanged` — it fails OPEN.
      ...(resetProjection ? { projectedAt: null } : {}),
    },
  });
  return "written";
}

/**
 * The ANNUAL row hiding inside a March-quarter filing — MONEY-1114.
 *
 * ## Why there is a second row at all
 *
 * A Q4 filing declares two undimensioned periods: the quarter (`OneD`) and the
 * financial year (`FourD`). The parser's primary rule picks the shortest
 * candidate sharing the latest end date, which is the quarter — correctly — and
 * the year's fifty-odd facts were parsed, ranked and dropped. `otherPeriods`
 * recorded that the year existed but carries DATES ONLY, so nothing downstream
 * could reach the figures.
 *
 * Measured on RELIANCE Q4-FY19 consolidated: `FourD` holds
 * `RevenueFromOperations` 5,810,200,000,000 — the published ₹5,81,020 Cr FY19
 * consolidated revenue — and none of it reached `values`.
 *
 * ## Why it is done HERE, at write time, and not as a pass over stored rows
 *
 * Because a pass over stored rows CANNOT WORK. `XbrlFiling.facts` is the parsed
 * `XbrlFinancials`, whose `values` belong to the quarter and whose
 * `otherPeriods` are dates. There is no annual figure in the database to
 * project from; the only source is the XML. Doing it at write time means the
 * bytes are already in hand and the annual row costs one re-parse and zero
 * network — which is also why this is not gated behind a flag.
 *
 * The rows already stored before this shipped are reached by
 * `scripts/jobs/xbrl-backfill.ts --annual-existing`, which re-reads their XML.
 *
 * ## The three refusals
 *
 * No full-year candidate → not a Q4 filing, and that is the common case (a Q1
 * filing's YTD column IS its quarter, so there is no second period at all).
 * More than one → ambiguous, refuse rather than pick. The re-parse not
 * returning financials → refuse; `parseXbrlDocument` is documented to refuse an
 * unmatched contextRef rather than fall back to the primary, and that refusal is
 * the whole safety property being relied on here.
 */
export async function storeAnnualCompanion(
  entry: FilingIndexEntry,
  financials: XbrlFinancials,
  xml: string,
  out: XbrlSyncResult,
  deps?: XbrlStoreDeps,
): Promise<void> {
  const pick = pickAnnualCompanion(
    financials.otherPeriods,
    (days) => classifyFilingPeriod(days)?.periodType === "ANNUAL",
  );
  if (pick.kind === "none") return;
  if (pick.kind === "ambiguous") {
    out.annualAmbiguous++;
    logger.warn(
      {
        symbol: entry.symbol,
        url: entry.xbrlUrl,
        contexts: pick.contextRefs,
      },
      "more than one full-year period in one document — refusing to pick",
    );
    return;
  }

  // Re-parse the SAME bytes for the year's contextRef. No download.
  const outcome = parseXbrlDocument(xml, {
    periodContextRef: pick.contextRef,
  });
  if (outcome.kind !== "financials") {
    out.annualUnreadable++;
    return;
  }
  const stored = await storeFiling(entry, outcome.financials, deps);
  if (stored === "written") out.writtenAnnual++;
  else out.annualUnreadable++;
}

/**
 * A row already in `xbrl_filings`, reduced to what re-deriving its ANNUAL
 * companion needs. Exported for `scripts/jobs/xbrl-backfill.ts --annual-existing`.
 */
export interface StoredFilingRef {
  symbol: string;
  sourceUrl: string;
  isin: string | null;
  basis: string;
  filerKind: string;
  audited: boolean | null;
  filedAt: Date | null;
}

export type AnnualBackfillOutcome =
  | "written"
  | "no-annual-period"
  | "ambiguous"
  | "unreadable";

/**
 * A stored row, restated as the index entry the write path expects.
 *
 * Extracted by MONEY-1252 so the ANNUAL backfill and the re-parse job build it
 * ONE way. Two hand-rolled copies of this object would be two chances to differ
 * on `filerKind` or `broadcastAt` — both of which land in the stored row — and
 * the disagreement would be invisible: every field here is a FALLBACK that the
 * document normally overrides, so a wrong one only surfaces on the filings
 * whose document happens to be silent.
 */
export function entryFromStoredFiling(ref: StoredFilingRef): FilingIndexEntry {
  // Every field this feeds is a FALLBACK inside `storeFiling` — the document
  // wins on basis, audited, isin, and (since MONEY-1114) unconditionally on
  // periodType and cumulative — so reconstructing it from the stored row cannot
  // change what gets written.
  return {
    era: "legacy",
    symbol: ref.symbol,
    isin: ref.isin,
    xbrlUrl: ref.sourceUrl,
    ixbrlUrl: null,
    basis: ref.basis === "CONSOLIDATED" ? "CONSOLIDATED" : "STANDALONE",
    audited: ref.audited,
    cumulative: null,
    periodType: null,
    filerKind:
      ref.filerKind === "BANK"
        ? "BANK"
        : ref.filerKind === "NBFC"
          ? "NBFC"
          : "GENERIC",
    quarterEnd: null,
    broadcastAt: ref.filedAt,
    companyName: "",
    // MONEY-1235 — no revision metadata is recoverable from a stored row: the
    // schema keeps `sourceUrl` and `filedAt`, not `type_Sub` / `seq_Id`. That is
    // fine here and must stay fine: these paths re-derive rows from bytes we
    // already hold, they do not decide write order against a sibling.
    // `broadcastAt: ref.filedAt` preserves the row's own stamp, so the
    // `broadcastAt ?? revisedAt` fallback in `storeFiling` cannot null it out.
    revisionKind: null,
    revisedAt: null,
    createdAt: null,
    indexSequence: null,
  };
}

/**
 * Derive the ANNUAL row for a filing we ALREADY hold, from its XML.
 *
 * The `--annual-existing` half of MONEY-1114, and the reason it cannot be a
 * database-only pass: `XbrlFiling.facts` stores the parsed quarter, and its
 * `otherPeriods` are dates with no figures attached. The numbers only exist in
 * the document.
 *
 * This exists as an exported function rather than being re-implemented in the
 * script for the same reason `fetchXml` is: it must go through the SAME
 * `storeAnnualCompanion` the nightly ingest uses, or the two writers eventually
 * disagree about `periodType`/`cumulative` and produce two annual rows per year
 * that differ only in a boolean.
 */
export async function backfillAnnualFromXml(
  ref: StoredFilingRef,
  xml: string,
  deps?: XbrlStoreDeps,
): Promise<AnnualBackfillOutcome> {
  const outcome = parseXbrlDocument(xml);
  if (outcome.kind !== "financials") return "unreadable";

  const entry = entryFromStoredFiling(ref);

  const probe: XbrlSyncResult = emptyXbrlSyncResult({ from: "", to: "" });
  await storeAnnualCompanion(entry, outcome.financials, xml, probe, deps);
  if (probe.writtenAnnual > 0) return "written";
  if (probe.annualAmbiguous > 0) return "ambiguous";
  if (probe.annualUnreadable > 0) return "unreadable";
  return "no-annual-period";
}

/* -------------------------------------------------------------------------- */
/* RE-PARSE a stored filing from bytes we already hold — MONEY-1252           */
/* -------------------------------------------------------------------------- */

/**
 * What one re-parse did. Every arm is a COUNTER the job keeps separately.
 *
 * `bucket` is `bucketForOutcome`'s verdict on the document. It is `financials`
 * exactly when the parse succeeded, and in that case — and only that case —
 * `refusal` and `annual` are meaningful.
 */
export interface ReparseOutcome {
  /** Which parse bucket the document fell into. */
  bucket: XbrlOutcomeBucket;
  /**
   * Why `storeFiling` declined the PRIMARY period, or null when it wrote.
   *
   * Kept apart from `bucket` because these are different failures at different
   * layers: `bucket` says "we could not read the document", `refusal` says "we
   * read it and it is not storable". Collapsing them is the mistake
   * `bucketForOutcome`'s own doc catalogues — a permanent floor under one
   * number makes the other unreadable.
   */
  refusal: Exclude<StoreOutcome, "written"> | null;
  /**
   * The ANNUAL companion verdict for the SAME bytes.
   *
   * `none` is the common, healthy case: a Q1 filing's year-to-date column IS
   * its quarter, so there is no second period at all.
   */
  annual: "written" | "none" | "ambiguous" | "unreadable";
}

/**
 * Re-parse a filing we already hold and rewrite BOTH rows it produces.
 *
 * ## Why this exists
 *
 * `xbrl-financials-logic.ts` gained `bankBalanceOther` and `currentInvestments`
 * in MONEY-1250, and `totalCash` became `sumPresent` of those two plus cash.
 * The concepts did not exist when the ~96,000 stored filings were parsed, so
 * their `facts.values` do not carry them and `totalCash` still publishes about
 * a quarter of a company's cash — the F3 gate reads `totalCash` 81.5%
 * disagreement. The numbers were always in the filings; only the concept table
 * was missing. Re-parsing the SAME bytes with the CURRENT parser is the whole
 * fix.
 *
 * ## Why BOTH legs, and why that is not optional
 *
 * The nightly download loop calls `storeFiling` and then
 * `storeAnnualCompanion` for every document, and the second one re-parses the
 * same bytes for the YEAR's contextRef and calls `storeFiling` again. A
 * re-parse that ran only the first leg would rewrite every QUARTERLY row and
 * leave every ANNUAL row on the old concept table — and ANNUAL is exactly what
 * the reconcile gate compares. Two rows per document, two writes, one function,
 * so the pairing cannot be forgotten at a call site.
 *
 * ## What it deliberately does NOT do
 *
 * It does not fetch. `xml` is handed in by the caller, which reads it from the
 * feed archive; there is no path from here to nseindia.com. That separation is
 * the safety property of the whole job: ~2,000 rows have no archived object,
 * and any code path that "helpfully" fell back to the network would turn a
 * counted skip into two thousand requests at a host that has already throttled
 * us once.
 *
 * It does not decide whether the projection cursor is cleared either.
 * `storeFiling` owns that (`projectionInputChanged` -> `projectedAt: null` on
 * UPDATE), and it is load-bearing: without the clear the nightly projection
 * skips these rows as already-projected and the corrected `totalCash` never
 * reaches `stock_financials`. Callers that want to COUNT the clears observe
 * them at the `deps` seam rather than re-deriving the decision.
 */
export async function reparseStoredFiling(
  ref: StoredFilingRef,
  xml: string,
  deps?: XbrlStoreDeps,
): Promise<ReparseOutcome> {
  const outcome = parseXbrlDocument(xml);
  const bucket = bucketForOutcome(outcome.kind);
  if (outcome.kind !== "financials") {
    return { bucket, refusal: null, annual: "none" };
  }

  const entry = entryFromStoredFiling(ref);
  const stored = await storeFiling(entry, outcome.financials, deps);
  if (stored !== "written") {
    // The document parsed; the row is not storable. The ANNUAL companion is
    // NOT attempted: it re-parses the same document and would refuse for the
    // same reason (no symbol, no period), turning one honest refusal into two.
    return { bucket, refusal: stored, annual: "none" };
  }

  const probe: XbrlSyncResult = emptyXbrlSyncResult({ from: "", to: "" });
  await storeAnnualCompanion(entry, outcome.financials, xml, probe, deps);
  const annual =
    probe.writtenAnnual > 0
      ? "written"
      : probe.annualAmbiguous > 0
        ? "ambiguous"
        : probe.annualUnreadable > 0
          ? "unreadable"
          : "none";
  return { bucket, refusal: null, annual };
}

/** A zeroed result. One initialiser, so a new counter cannot be forgotten. */
export function emptyXbrlSyncResult(window: {
  from: string;
  to: string;
}): XbrlSyncResult {
  return {
    ok: true,
    eras: [],
    listed: 0,
    stubbed: 0,
    rejected: 0,
    skippedExisting: 0,
    downloaded: 0,
    unparseable: 0,
    unknownTaxonomy: 0,
    unknownTaxonomySamples: [],
    nonFinancial: 0,
    skippedNonFinancialByUrl: 0,
    unmappedFamily: 0,
    unmappedFamilySamples: [],
    noPeriod: 0,
    unresolvedIsin: 0,
    instrumentRungs: {},
    unclassifiedPeriod: 0,
    written: 0,
    writtenAnnual: 0,
    annualAmbiguous: 0,
    annualUnreadable: 0,
    fetchFailed: 0,
    truncatedByBudget: false,
    indexTruncationSuspected: [],
    parseHealthFailure: null,
    window,
  };
}

/**
 * One job-outcome per xbrl-sync run — MONEY-1238.
 *
 * `xbrl-sync` is one of the eight jobs `scripts/ops/datadog/apply-monitors.sh`
 * watches for the zero-write class, and it emitted no metric at all: its monitor
 * was in NO DATA from the day it was created, which `notify_no_data` reports as
 * "this job did not run" and an operator eventually mutes.
 *
 * ## What the two numbers mean here, and why not the obvious ones
 *
 *   selected  Filings this run had to WORK on — the deduplicated, ordered index
 *             entries MINUS the ones the pre-download check found already
 *             stored. NOT `entries.length`: this job runs a TRAILING 7-day
 *             window on purpose, so on a normal night most entries are already
 *             held and `written` is legitimately 0 against a large
 *             `entries.length`. That would alert every quiet night and the
 *             alert would be off inside a week.
 *
 *             It DOES stay non-zero for the failures worth paging on — a
 *             taxonomy the parser cannot read, NSE 403ing every XML, or index
 *             paging eating the whole run budget so the loop downloads nothing
 *             (which the loop already warns about but could not alert on).
 *
 *   written   `XbrlFiling` rows persisted: the primary row plus the ANNUAL
 *             companion recovered from the same bytes. Both are real rows.
 *
 * `failed` counts documents ATTEMPTED and not persisted. `nonFinancial` and
 * `unmappedFamily` are deliberately excluded — a governance filing carries no
 * financials by design, and an unmapped statement family is a recorded decision
 * in ENTRY_POINT_KINDS. Counting either as a failure puts a permanent floor
 * under the number and makes the real ones unreadable, which is the same
 * mistake `judgeXbrlParseHealth` already avoids.
 *
 * NEVER THROWS: an observability helper must not be able to fail the run it
 * observes.
 */
function reportXbrlSyncOutcome(out: XbrlSyncResult, selected: number): void {
  try {
    const written = out.written + out.writtenAnnual;
    const failed =
      out.fetchFailed +
      out.unparseable +
      out.unknownTaxonomy +
      out.noPeriod +
      out.unclassifiedPeriod;
    const measurements =
      `window=${out.window.from}..${out.window.to} eras=${out.eras.join("+")} ` +
      `listed=${out.listed} stubbed=${out.stubbed} ` +
      `skippedExisting=${out.skippedExisting} downloaded=${out.downloaded} ` +
      `written=${out.written} writtenAnnual=${out.writtenAnnual} ` +
      `fetchFailed=${out.fetchFailed} unparseable=${out.unparseable} ` +
      `unknownTaxonomy=${out.unknownTaxonomy} nonFinancial=${out.nonFinancial} ` +
      `skippedNonFinancialByUrl=${out.skippedNonFinancialByUrl} ` +
      `unmappedFamily=${out.unmappedFamily} noPeriod=${out.noPeriod} ` +
      `unclassified=${out.unclassifiedPeriod} ` +
      // MONEY-1299 — the instrument join, stated rather than assumed. `rungs`
      // is emitted even when empty: an absent breakdown and an all-zero one
      // read identically otherwise, and this counter exists because a wrong
      // join looked exactly like a right one for 78.3% of the table.
      `unresolvedIsin=${out.unresolvedIsin} ` +
      `rungs=${
        Object.entries(out.instrumentRungs)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => `${k}:${v}`)
          .join(",") || "none"
      } ` +
      `truncatedByBudget=${out.truncatedByBudget} ` +
      `indexTruncationSuspected=${out.indexTruncationSuspected.length} ` +
      `ok=${out.ok}` +
      (out.parseHealthFailure ? ` parseHealth=${out.parseHealthFailure}` : "");

    reportJobOutcome({
      job: "xbrl-sync",
      selected,
      written,
      failed,
      skippedReason:
        selected > 0 && written === 0
          ? `no filing stored from ${selected} pending document(s): ${measurements}`
          : measurements,
    });
  } catch (err) {
    logger.warn({ err }, "job-outcome report failed (ignored)");
  }
}

export async function processXbrlSync(opts?: {
  windowDays?: number;
  from?: Date;
  to?: Date;
  /**
   * Wall-clock budget for the DOWNLOAD phase. Defaults to
   * {@link RUN_TIME_BUDGET_MS}, which is sized for the Pub/Sub push worker's
   * un-raisable 600 s ack deadline.
   *
   * The BACKFILL runs as a Cloud Run Job with a 24 h task timeout and no ack
   * deadline at all, so it raises this. Leaving it pinned at 480 s per monthly
   * window would abandon most of a ~3,000-filing month after eight minutes and
   * move on — the window would be reported `truncatedByBudget` and would need
   * six more passes, each re-paying the per-entry existence check, to finish a
   * month the job had hours to spend on.
   */
  timeBudgetMs?: number;
}): Promise<XbrlSyncResult> {
  const to = opts?.to ?? istToday();
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const from =
    opts?.from ?? new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const spanDays = Math.max(
    1,
    Math.round((to.getTime() - from.getTime()) / 86_400_000),
  );
  const window = { from: toApiDate(from), to: toApiDate(to) };

  const out: XbrlSyncResult = emptyXbrlSyncResult(window);

  // ── MONEY-1235: the budget clock starts HERE, not at the download loop.
  //
  // Index paging is inside the ack deadline whether or not it is inside the
  // budget, and it used to be outside the budget: `downloadStartedAt` was set
  // AFTER every `collectIndex` call had returned. The 120 s of headroom
  // `RUN_TIME_BUDGET_MS` deliberately keeps back for paging was therefore
  // available to paging AND still available in full to the downloads.
  //
  // The nightly 7-day window pages ~3 times and never noticed. The route
  // accepts `windowDays` up to 370: a catch-up window can page up to MAX_PAGES
  // (40) per era/period before the download phase begins, and only then spend
  // the whole 480 s. See `downloadBudgetAfterIndexing` for what an overrun
  // actually costs (a redelivered, duplicated run — not a late one).
  const runStartedAt = Date.now();

  // Which index(es) serve this window — MONEY-1250.
  //
  // This used to walk both ONLY when the window straddled the regime change,
  // which is a condition a whole-MONTH window (the backfill's stride) can never
  // meet. The Dec-2024 quarter was broadcast through the LEGACY index for a
  // full quarter after the boundary, so every 2025 window walked
  // integrated-only and 3,895 filings for periodEnd 2024-12-31 were unreachable
  // by construction: prod held 2,717 rows for 2024-09-30, 7,561 for 2025-03-31
  // and ZERO for 2024-12-31. `erasForWindow` adds the measured OVERLAP PERIOD
  // in which both indexes are live; the evidence and the cost asymmetry are on
  // `LEGACY_FINANCIALS_OVERLAP_END`.
  const eras: FilingIndexEra[] = erasForWindow(from, to);
  out.eras = eras;

  const collectedEntries: FilingIndexEntry[] = [];
  for (const era of eras) {
    for (const period of periodParamsFor(era)) {
      const got = await collectIndex(
        era,
        period,
        window.from,
        window.to,
        spanDays,
        out,
      );
      if (got === null) {
        // Throttle, challenge page and transport error all arrive as null. Never
        // treat that as "no filings this week".
        logger.error(
          { era, period, window },
          "index unreadable — NOT proceeding",
        );
        out.ok = false;
        // `selected: 0` is the honest number: the run never reached the point
        // of choosing filings. This exit is covered by the ROUTE instead —
        // `isRetriableFailure` makes it a 500, so Pub/Sub retries and, after
        // --max-delivery-attempts, the dead-letter consumer reaches a human.
        // Inflating `selected` here to force a page would double-alert on the
        // one failure that already has an escalation path.
        reportXbrlSyncOutcome(out, 0);
        return out;
      }
      collectedEntries.push(...got);
    }
  }

  // ── Deduplicate by document — MONEY-1114.
  //
  // NSE lists the SAME Q4 XML under BOTH `period=Quarterly` and
  // `period=Annual`: 1,379 of 1,491 annual URLs in May-2019 are also quarterly
  // URLs. Without this the download loop meets each of those twice; the second
  // pass is caught by the pre-download existence check and lands in
  // `skippedExisting`, so nothing is downloaded twice — but `listed` and the
  // loop's own length both double, and `skippedExisting` stops meaning "we
  // already had this from a previous run".
  //
  // Keyed on symbol + URL, not URL alone: the URL is per-filing unique in every
  // sample seen, and a shared URL across symbols would be a far stranger fact
  // than a duplicate row.
  const seen = new Set<string>();
  const deduped: FilingIndexEntry[] = [];
  for (const e of collectedEntries) {
    const key = `${e.symbol}|${e.xbrlUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  // ── Make the WRITE ORDER deterministic — MONEY-1235.
  //
  // The dedupe above keys on the DOCUMENT (symbol + URL), which is exactly what
  // it should do and exactly why it cannot help here: an Original and its
  // Revision are two different documents at two different URLs describing ONE
  // period, so both survive it and both upsert onto the same `XbrlFiling` row.
  // Whichever the loop reaches last wins, and the modern index is served
  // newest-first — so the winner was the SUPERSEDED Original, every night, with
  // no counter moved and no line logged.
  //
  // Sorting oldest-first makes the newest filing the last write for its key,
  // whatever order the index chose to return the records in. That is the
  // invariant; see `orderFilingsForWrite` for why the key is a SEQUENCE and not
  // `type_Sub` (one 20-record capture holds TWO Revisions of one period and no
  // Original at all), and for why the superseded sibling is re-downloaded
  // rather than dropped.
  //
  // …and then `downloadOrder` decides which SYMBOLS that oldest-first stream
  // visits first, because this loop is TIME-BOUNDED and a global oldest-first
  // stream spends the budget on the oldest filings in the window — MONEY-1238.
  const entries = downloadOrder(orderFilingsForWrite(deduped));

  const duplicateListings = collectedEntries.length - entries.length;
  if (duplicateListings > 0) {
    logger.info(
      { duplicateListings, distinct: entries.length },
      "the same document was listed under more than one period — deduplicated",
    );
  }

  if (out.indexTruncationSuspected.length > 0) {
    // Loud, because the whole failure mode is that a capped result looks like a
    // complete one. This is the line an operator must be able to grep for.
    logger.warn(
      { window, suspects: out.indexTruncationSuspected },
      "INDEX MAY BE TRUNCATED — the coverage below is a FLOOR, not a count",
    );
  }

  if (entries.length === 0) {
    logger.warn(
      { window, listed: out.listed, stubbed: out.stubbed },
      "no filings with XBRL in this window",
    );
    reportXbrlSyncOutcome(out, 0);
    return out;
  }

  // MONEY-1200 — the download phase is bounded by WALL CLOCK, not by a count.
  // A run that overruns its 600 s ack deadline does not merely finish late: it
  // is redelivered mid-flight and starts over, so the cost of overrunning is a
  // duplicated run, not a slow one. See RUN_TIME_BUDGET_MS.
  //
  // MONEY-1235 — and the paging that just happened is charged to it. What the
  // loop below gets is the run budget MINUS what the index already spent, so
  // the two phases can no longer each be given the whole 480 s.
  const downloadStartedAt = Date.now();
  const timeBudgetMs = opts?.timeBudgetMs ?? RUN_TIME_BUDGET_MS;
  const indexElapsedMs = downloadStartedAt - runStartedAt;
  const downloadBudgetMs = downloadBudgetAfterIndexing(
    timeBudgetMs,
    indexElapsedMs,
  );
  if (downloadBudgetMs <= 0) {
    // Not a silent stop. Paging alone consuming the entire run budget is the
    // signal that the window is too wide for one message, and it must be
    // legible in the log rather than inferred from `downloaded: 0`.
    logger.warn(
      { window, indexElapsedMs, timeBudgetMs, pending: entries.length },
      "index paging consumed the whole run budget — downloading NOTHING this " +
        "run; narrow the window or raise timeBudgetMs (the backfill does)",
    );
  }

  for (const entry of entries) {
    if (Date.now() - downloadStartedAt >= downloadBudgetMs) {
      out.truncatedByBudget = true;
      logger.warn(
        {
          downloaded: out.downloaded,
          remaining: entries.length - out.downloaded,
        },
        "run time budget reached — stopping; the trailing window collects the rest",
      );
      break;
    }
    // BEFORE the budget check, deliberately — MONEY-1250. A governance filing
    // is never STORED, so `skippedExisting` can never skip it and every run
    // re-downloads it. Once a window's financials are mostly done the remainder
    // is almost pure governance and the entire budget goes to re-fetching files
    // that will never be recorded: prod 2025-04 ran twice at exactly
    // `downloaded 1500 / nonFinancial ~1460`, with `skippedExisting` moving
    // 280 -> 269. Charging these to the budget is what made the window
    // non-convergent; the deny list is in `isNonFinancialFilingUrl`.
    if (isNonFinancialFilingUrl(entry.xbrlUrl)) {
      out.skippedNonFinancialByUrl++;
      out.nonFinancial++;
      continue;
    }
    if (out.downloaded >= MAX_DOWNLOADS_PER_RUN) {
      out.truncatedByBudget = true;
      break;
    }

    // Skip the DOWNLOAD, not just the write. This is what makes the trailing
    // window cheap: the overlap costs one indexed read per record instead of a
    // network round trip.
    const existing = await prisma.xbrlFiling.findFirst({
      where: {
        symbol: entry.symbol,
        exchange: filingExchange(entry),
        sourceUrl: entry.xbrlUrl,
      },
      select: { id: true },
    });
    if (existing) {
      out.skippedExisting++;
      continue;
    }

    const xml = await fetchXml(
      entry.xbrlUrl,
      archiveDayForFiling(entry),
      filingExchange(entry),
    );
    out.downloaded++;
    await sleep(DOWNLOAD_DELAY_MS);

    if (xml === null) {
      out.fetchFailed++;
      continue;
    }

    // Every non-financials outcome is counted APART. Collapsing them is what
    // let a taxonomy mismatch read as an empty market for months. The mapping
    // itself is pure and unit-tested — see `bucketForOutcome`.
    const outcome = parseXbrlDocument(xml);
    if (outcome.kind !== "financials") {
      out[
        bucketForOutcome(outcome.kind) as Exclude<
          XbrlOutcomeBucket,
          "financials"
        >
      ]++;
      if (outcome.kind === "unknown-taxonomy") {
        noteSample(out.unknownTaxonomySamples, outcome.namespaces.join(" "));
      } else if (outcome.kind === "unknown-entry-point") {
        noteSample(
          out.unknownTaxonomySamples,
          `${outcome.taxonomy.namespace} entryPoint=${outcome.entryPoint ?? "(none)"}`,
        );
      } else if (outcome.kind === "unmapped-family") {
        noteSample(
          out.unmappedFamilySamples,
          `${outcome.entryPoint} (${outcome.shape})`,
        );
      }
      continue;
    }
    const financials = outcome.financials;
    if (
      !isoToUtc(financials.period.start) ||
      !isoToUtc(financials.period.end)
    ) {
      out.noPeriod++;
      continue;
    }
    // Every arm of StoreOutcome moves a counter. A refusal that increments
    // nothing is a document downloaded, understood, discarded, and reported as
    // though the window simply held fewer filings — the exact shape of the
    // MONEY-1200 defect this file's counters exist to prevent.
    const stored = await storeFiling(entry, financials, undefined, out);
    switch (stored) {
      case "written":
        out.written++;
        // The ANNUAL row from the SAME bytes. Only ever produced by a filing
        // that declares a full financial year beside its quarter — see
        // `storeAnnualCompanion`. Zero network cost, so it is unconditional.
        await storeAnnualCompanion(entry, financials, xml, out);
        break;
      case "unclassified":
        out.unclassifiedPeriod++;
        break;
      // `no-period` is unreachable from here — the isoToUtc guard above already
      // caught it — and `no-symbol` is a filing with no symbol in either the
      // index or the document. Both are "parsed, refused, stored nothing", which
      // is what `noPeriod` means to `judgeXbrlParseHealth`.
      case "no-period":
      case "no-symbol":
        out.noPeriod++;
        break;
    }
  }

  // The verdict on what we READ, not on whether the index answered. `ok`
  // starting at `true` and only ever being cleared by an unreadable index is
  // the bug: 1,500 documents could fail without touching it.
  const health = judgeXbrlParseHealth(out);
  if (!health.ok) {
    out.ok = false;
    out.parseHealthFailure = health.reason;
    logger.error(
      {
        window,
        readable: health.readable,
        notUnderstood: health.notUnderstood,
        unknownTaxonomy: out.unknownTaxonomy,
        samples: out.unknownTaxonomySamples,
        reason: health.reason,
      },
      "PARSE HEALTH FAILURE — documents were downloaded and not understood",
    );
  } else if (out.unknownTaxonomy > 0) {
    // Under the threshold, so the run stands — but an unknown taxonomy is
    // always worth a line, because it is the leading edge of the next one.
    logger.warn(
      {
        window,
        count: out.unknownTaxonomy,
        samples: out.unknownTaxonomySamples,
      },
      "unknown XBRL taxonomy seen — add it to ENTRY_POINT_KINDS / DIALECT_PATTERNS",
    );
  }

  if (out.unmappedFamily > 0) {
    // INFO, and NOT an `else` of the branch above — MONEY-1220.
    //
    // Not a warning, because there is nothing to action: these filings are
    // recognised and skipped by a decision recorded in `ENTRY_POINT_KINDS`, and
    // a nightly warning that no code change can clear is how a real one stops
    // being read. Not silent either — this is the running size of a known gap,
    // and the day someone maps General Insurance they should be able to grep
    // for how much it was worth.
    //
    // Not an `else` because the two are independent facts: a window can hold
    // both a genuinely unknown taxonomy and a skipped insurance filing, and
    // chaining them would hide whichever came second.
    logger.info(
      {
        window,
        count: out.unmappedFamily,
        shapes: out.unmappedFamilySamples,
      },
      "recognised filings skipped — statement shape is deliberately not mapped",
    );
  }

  logger.info(out, "done");
  // `entries.length - skippedExisting` — the filings this run had to work on.
  // Computed here rather than counted in the loop so that entries the budget
  // never reached still count as selected: a run that downloads nothing because
  // paging spent the whole budget HAS work outstanding, and that is exactly the
  // shape the zero-write monitor exists to catch.
  reportXbrlSyncOutcome(out, entries.length - out.skippedExisting);
  return out;
}

/**
 * Record a distinct sample string, bounded and deduplicated.
 *
 * Takes the LIST rather than the result so the unknown-taxonomy and
 * unmapped-family sample sets share one implementation. They are bounded for
 * the same reason: a window in which every document is unreadable would
 * otherwise put 1,500 strings on one log line.
 */
function noteSample(samples: string[], sample: string): void {
  if (samples.length >= MAX_UNKNOWN_SAMPLES) return;
  if (samples.includes(sample)) return;
  samples.push(sample);
}
