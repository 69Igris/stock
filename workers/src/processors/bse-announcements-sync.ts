/**
 * BSE Corporate Announcements Sync Processor — MONEY-852, repaired MONEY-1255,
 * unstarved MONEY-1285.
 *
 * Pulls BSE corporate announcements for ALL scrips over a date window, ONE
 * CATEGORY AT A TIME, resolves each row to an InstrumentMapping, archives the
 * attached PDF to GCS, and writes a `StockDocument` so the filing is
 * searchable + embeddable alongside NSE / Screener documents.
 *
 * ## THIS JOB HAD WRITTEN ZERO ROWS, EVER
 *
 * Measured on prod 2026-08-26: `stock_documents` where
 * `docType: "corporate_filing"` = **0**, newest `fetchedAt` = NONE. The job ran
 * nightly at 21:30 IST and exited 0 every single time. Two independent defects
 * were stacked, and either one alone would have been survivable:
 *
 * **1. The query matched nothing.** The client sent `strCat=-1`, reading `-1`
 * as "every category" the way an empty `strScrip` means "every scrip". `strCat`
 * takes a category NAME. BSE answered **200 with a body of `{}`**, the page
 * walk read zero rows as "no more pages", and the job logged
 * "Fetched 0 announcements". See `BSE_ANNOUNCEMENT_CATEGORIES` in
 * `@usemoney/research/data-sources/bse-client` for the full account.
 *
 * **2. Nothing was reported, so no monitor could fire.** `reportJobOutcome`
 * sat at the BOTTOM of the function, below THREE early returns — the
 * rate-limited path, the fetch-failed path, and `if (announcements.length === 0)
 * return`. Defect 1 made that third one true on every run, so the job emitted
 * **no metric at all**, every night, since inception. `apply-monitors.sh` has
 * carried `bse-announcements-sync|96h|weekdays 21:30` since MONEY-1238 and
 * `notify_no_data: true` means that monitor sat in NO DATA from birth rather
 * than alerting — exactly the state that file's own comment warns about ("a
 * monitor that has never been green is a monitor somebody mutes").
 *
 * The report now lives in a `finally`, so EVERY exit path emits: a throw, a 429
 * abort, a fetch failure, and a genuinely-empty run alike. Same shape
 * `stock-document-extract` adopted for the same reason. Fixing only the query
 * would have left the reporting gap live, and the next regression just as
 * invisible as this one.
 *
 * ## THEN IT WROTE ROWS WITHOUT THEIR PDFs — MONEY-1285
 *
 * Measured on prod 2026-08-30, `stock_documents` where `sourceType: "BSE"`:
 *
 *     docType             rows     with bytes   gcsPath: ""
 *     corporate_filing    4,268     1,929        2,339
 *     quarterly_result   30,956    27,170        3,786
 *
 * The quarterly 3,786 are pre-2018 filings BSE no longer serves (the retention
 * table in the root `CLAUDE.md`) and are not recoverable. The `corporate_filing`
 * 2,339 are all from the last FOUR DAYS, and BSE is serving those attachments
 * right now. Four mechanisms produced them, and all four are fixed here:
 *
 *   1. **The retry arm could not see them.** `if (existing && !isQuarterly)
 *      continue;` skipped every already-seen `corporate_filing`, and the
 *      `existingHasBytes` arm below it — whose own comment says a `gcsPath: ""`
 *      row is terminal-FAILed by the parse lane and would be "stranded
 *      permanently" — was gated on `isQuarterly`. The comment named the exact
 *      failure and the branch it protected could not reach it. The decision is
 *      now ONE docType-independent function,
 *      {@link decideBseAnnouncementWrite}: bytes present means skip, and
 *      nothing else does.
 *   2. **The download cap starved the same tail every night.** The client
 *      returns "every row from every category, in category order" and
 *      `MAX_PDF_DOWNLOADS_PER_RUN = 500` binds on every run (three post-fix
 *      prod runs archived EXACTLY 500 each). A cap over a category-major list
 *      takes a PREFIX, not a sample — which is why AGM/EGM and Board Meeting
 *      are ~100% complete while Corp. Action, Insider Trading/SAST, New
 *      Listing, Result and Others are 100% byte-less. {@link interleaveByCategory}
 *      round-robins the list before the loop spends a single download.
 *   3. **The run could not finish inside its ack deadline.** Runs take 19-21
 *      minutes against a 600s Pub/Sub deadline, so Pub/Sub REDELIVERED while
 *      the first copy was still running — a second concurrent walk of the same
 *      window every night. Bounded now by `BSE_RUN_TIME_BUDGET_MS` checked
 *      BETWEEN announcements, with a self-chain carrying the remaining work.
 *      `DELAY_BETWEEN_DOWNLOADS_MS` is deliberately NOT the lever: cutting it
 *      trades the ack deadline for a 429 from a host that has already blocked
 *      this repo (MONEY-853).
 *   4. **~420 rows a night were discarded unresolved.** `resolveInstrument`
 *      tried the alpha symbol and then a fuzzy company name, and never used
 *      `ann.scripCode` — the identifier BSE itself issues — against
 *      `InstrumentMapping.bseScripCode`. That rung is now FIRST.
 *
 * ## What the run produces
 *
 * Per the MONEY-852 surface contract this writes GCS + `prisma.stockDocument`
 * DIRECTLY rather than importing the stock-document-sync helpers.
 *
 * Best-effort + per-row isolated: a row we can't map to an instrument, or a PDF
 * download that fails, logs and continues. Every pure judgement — the
 * classification, the period derivation, the write decision, the ordering, the
 * budget and the chain — is delegated to `bse-announcements-sync-logic.ts` so
 * it can be tested without BSE.
 *
 * Cron: daily 21:30 IST Mon-Fri, prod-only.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import type { BseAnnouncementsSyncMessage } from "@usemoney/types/pubsub";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";
import { getPubSubClient } from "@usemoney/pubsub/client";
import {
  normalizeDocMimeType,
  initialProcessingStatus,
} from "@usemoney/core/market-data/doc-mime";
import {
  fetchBSEAnnouncementsByCategory,
  BseRateLimitError,
  type BseAnnouncement,
  type BseAnnouncementsFetch,
} from "@usemoney/research/data-sources/bse-client";
import {
  buildStockDocPath,
  type StockDocType,
} from "@usemoney/research/data-sources/stock-document-paths";
// MONEY-1315 (B) — the BODY sniff, imported by the writer whose own comment
// (see `archivePdf`) already wrote down the failure it prevents.
import {
  mayStoreDocumentBody,
  ABSENT_GCS_PATH,
  HTML_QUARANTINE_STATUS,
} from "@usemoney/research/data-sources/document-body-guard";
import { uploadToGCS } from "../lib/gcs";
import {
  BSE_DOC_TYPE_QUARTERLY_RESULT,
  BSE_MAX_CHAIN_DEPTH,
  BSE_RUN_TIME_BUDGET_MS,
  bseAttachmentCandidates,
  bseCompactToIsoDate,
  bseDecisionWrites,
  buildBseDocumentDescription,
  classifyBseAnnouncement,
  decideBseAnnouncementWrite,
  interleaveByCategory,
  isWithinBseRunBudget,
  judgeBseAnnouncementsHealth,
  normalizeBseChainDepth,
  normalizeBseResumeIndex,
  parseBseDocumentBreadcrumb,
  shouldChainBseAnnouncements,
  summarizeCategoryCounts,
  windowDays,
  type BseClassification,
} from "./bse-announcements-sync-logic";
import { publishDocumentIngest } from "../lib/doc-ingest-publish";

const logger = {
  info: (...args: unknown[]) => console.log("[bse-ann-sync]", ...args),
  warn: (...args: unknown[]) => console.warn("[bse-ann-sync]", ...args),
  error: (...args: unknown[]) => console.error("[bse-ann-sync]", ...args),
};

/** Default pages to paginate PER CATEGORY when the message omits maxPages. */
const DEFAULT_MAX_PAGES = 5;
/** Default look-back window (days) when the message omits a date range. */
const DEFAULT_WINDOW_DAYS = 2;
/** A real PDF is well over this; smaller responses are error pages. */
const MIN_PDF_BYTES = 1000;
/**
 * Pace PDF downloads so BSE's attachment host isn't hammered.
 *
 * MONEY-1285 — do NOT reduce this to buy throughput. It is the only thing
 * standing between a 1,650-attachment night and the per-IP 429 wall MONEY-853
 * hit, and a block is permanent where an overrun is merely slow. The throughput
 * lever is the self-chain below.
 */
const DELAY_BETWEEN_DOWNLOADS_MS = 1500;
/**
 * Pace the ANNOUNCEMENT API requests too — new with the nine-category walk.
 *
 * The old single walk made at most `maxPages` requests per run; nine categories
 * make up to nine times that against a host this repo has already been 429'd by
 * (MONEY-853, where a whole-market run hit a per-IP wall and ZERO data landed).
 * The 429 ladder in `bseGetJson` is the recovery; this is the avoidance.
 */
const DELAY_BETWEEN_API_PAGES_MS = 400;
/**
 * Per-run cap on PDF downloads from BSE's attachment host. Mirrors the Screener
 * per-run cap (MONEY-853): the attachment host 429s under sustained load, so
 * bound the volume even when a wide window / high `maxPages` surfaces thousands
 * of filings.
 *
 * MONEY-1285 — this is a RUNAWAY GUARD now, not the throughput control. At
 * ~2.3s per download (measured: 500 attachments inside a 19-21 minute run) a
 * 420s link fits ~165, so the wall clock binds long before the count does. It
 * ENDS the loop rather than continuing to write byte-less rows past it: those
 * rows were a source of the 2,339, and the chained follow-up resumes at exactly
 * the announcement the cap stopped on.
 */
const MAX_PDF_DOWNLOADS_PER_RUN = 500;
/** Attachment fetch timeout. Doubles as the in-flight term of the run budget's
 *  headroom arithmetic — see `BSE_RUN_TIME_BUDGET_MS`. */
const ATTACHMENT_TIMEOUT_MS = 30_000;

/**
 * A resolved instrument for a BSE announcement (the StockDocument needs a real
 * instrumentId + a canonical symbol/exchange for the unique key).
 */
export interface ResolvedInstrument {
  id: string;
  symbol: string;
  exchange: string;
}

/** A candidate for the fuzzy company-name rung — carries the name to compare. */
export interface NamedInstrument extends ResolvedInstrument {
  name: string;
}

/** The `StockDocument` columns the write decision and the breadcrumb read. */
export interface ExistingBseDocument {
  description: string | null;
  sourceUrl: string | null;
  gcsPath: string;
  fileSize: number;
}

/** What an attachment fetch produced. Modelled on `Response` but flattened, so
 *  the seam carries no stream and a test needs no `Response` polyfill. */
export interface BseAttachmentResponse {
  ok: boolean;
  status: number;
  /** The RAW `content-type` header, empty string when absent. */
  contentType: string;
  body: Buffer;
}

/** The `StockDocument` fields both branches of the upsert share. */
interface BseDocumentFields {
  title: string;
  description: string;
  sourceUrl: string | undefined;
  sourceType: string;
  gcsPath: string;
  fileSize: number;
  mimeType: string;
  processingStatus: string;
  fetchedAt: Date;
}

/** The upsert args, spelled out so the seam is typed without importing Prisma's
 *  generated argument types into the tests. */
export interface BseDocumentUpsertArgs {
  where: {
    symbol_exchange_docType_period: {
      symbol: string;
      exchange: string;
      docType: string;
      period: string;
    };
  };
  create: BseDocumentFields & {
    instrumentId: string;
    symbol: string;
    exchange: string;
    docType: string;
    period: string;
  };
  update: BseDocumentFields & {
    isEmbedded: boolean;
    textContent: null;
    parseStatus: string;
    parsedAt: null;
  };
}

/**
 * The I/O seam — MONEY-1285.
 *
 * Every default closes over the REAL client, so production behaviour is
 * unchanged and a test drives the same function the scheduler does. The seam
 * exists because the four properties this ticket is about — a byte-less row is
 * retried, no category is starved by the cap, the run stops inside its budget
 * and publishes ONE follow-up, and a scrip code resolves an instrument — are
 * all properties of the ORCHESTRATION. None of them can be asserted against the
 * pure helpers alone, and MONEY-1092/1093 is this repo's standing example of a
 * fix that was correct in the unit and inert at the call site.
 */
export interface BseAnnouncementsSyncDeps {
  fetchAnnouncements?: typeof fetchBSEAnnouncementsByCategory;
  findInstrumentByScripCode?: (
    scripCode: string,
  ) => Promise<ResolvedInstrument | null>;
  findInstrumentBySymbol?: (
    symbol: string,
  ) => Promise<ResolvedInstrument | null>;
  findInstrumentsByNamePrefix?: (
    prefix: string,
  ) => Promise<NamedInstrument[]>;
  findExistingDocument?: (key: {
    symbol: string;
    exchange: string;
    docType: string;
    period: string;
  }) => Promise<ExistingBseDocument | null>;
  upsertDocument?: (args: BseDocumentUpsertArgs) => Promise<void>;
  downloadAttachment?: (url: string) => Promise<BseAttachmentResponse>;
  uploadAttachment?: (
    path: string,
    body: Buffer,
    contentType: string,
  ) => Promise<void>;
  /** Publishes the ONE follow-up message. Called at most once per run. */
  publishFollowUp?: (message: Record<string, unknown>) => Promise<void>;
  /** Injectable clock (epoch ms) so the budget is exercisable without waiting. */
  now?: () => number;
  /** Injectable sleep so the 1500ms pace does not cost a test 1500ms. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultFindInstrumentByScripCode = async (
  scripCode: string,
): Promise<ResolvedInstrument | null> =>
  prisma.instrumentMapping.findFirst({
    where: { bseScripCode: scripCode, isActive: true },
    select: { id: true, symbol: true, exchange: true },
    orderBy: { exchange: "asc" }, // "BSE" sorts before "NSE"
  });

const defaultFindInstrumentBySymbol = async (
  symbol: string,
): Promise<ResolvedInstrument | null> =>
  prisma.instrumentMapping.findFirst({
    where: {
      symbol,
      exchange: { in: ["BSE", "NSE"] },
      isActive: true,
      instrumentType: "EQUITY",
    },
    select: { id: true, symbol: true, exchange: true },
    orderBy: { exchange: "asc" },
  });

const defaultFindInstrumentsByNamePrefix = async (
  prefix: string,
): Promise<NamedInstrument[]> =>
  prisma.instrumentMapping.findMany({
    where: {
      name: { contains: prefix, mode: "insensitive" },
      exchange: { in: ["BSE", "NSE"] },
      isActive: true,
      instrumentType: "EQUITY",
    },
    select: { id: true, symbol: true, exchange: true, name: true },
    orderBy: { exchange: "asc" },
    take: 25,
  });

const defaultFindExistingDocument = async (key: {
  symbol: string;
  exchange: string;
  docType: string;
  period: string;
}): Promise<ExistingBseDocument | null> =>
  prisma.stockDocument.findUnique({
    where: { symbol_exchange_docType_period: key },
    select: {
      description: true,
      sourceUrl: true,
      gcsPath: true,
      fileSize: true,
    },
  });

const defaultUpsertDocument = async (
  args: BseDocumentUpsertArgs,
): Promise<void> => {
  const storedDoc = await prisma.stockDocument.upsert(args);
  // MONEY-1314 — announce to the ingest lane. Placed in the SHARED helper
  // rather than at its callers, so every BSE document reaches the lane by
  // construction. A no-op unless DOC_INGEST_REALTIME="true" and the row is a
  // PDF; BSE quarterly_result is 30,956 rows, the largest docType we hold.
  await publishDocumentIngest(storedDoc);
};

const defaultDownloadAttachment = async (
  url: string,
): Promise<BseAttachmentResponse> => {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://www.bseindia.com/",
    },
    signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS),
  });
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers?.get?.("content-type") ?? "",
    body: Buffer.from(await res.arrayBuffer()),
  };
};

const defaultPublishFollowUp = async (
  message: Record<string, unknown>,
): Promise<void> => {
  const pubsub = getPubSubClient();
  const topic = pubsub.topic(getTopicName(PUBSUB_TOPICS.BSE_ANNOUNCEMENTS_SYNC));
  await topic.publishMessage({ json: message });
};

/** Every dep resolved to a concrete implementation, once per run. */
interface ResolvedDeps {
  fetchAnnouncements: typeof fetchBSEAnnouncementsByCategory;
  findInstrumentByScripCode: (
    scripCode: string,
  ) => Promise<ResolvedInstrument | null>;
  findInstrumentBySymbol: (symbol: string) => Promise<ResolvedInstrument | null>;
  findInstrumentsByNamePrefix: (prefix: string) => Promise<NamedInstrument[]>;
  findExistingDocument: (key: {
    symbol: string;
    exchange: string;
    docType: string;
    period: string;
  }) => Promise<ExistingBseDocument | null>;
  upsertDocument: (args: BseDocumentUpsertArgs) => Promise<void>;
  downloadAttachment: (url: string) => Promise<BseAttachmentResponse>;
  uploadAttachment: (
    path: string,
    body: Buffer,
    contentType: string,
  ) => Promise<void>;
  publishFollowUp: (message: Record<string, unknown>) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function resolveDeps(deps: BseAnnouncementsSyncDeps): ResolvedDeps {
  return {
    fetchAnnouncements: deps.fetchAnnouncements ?? fetchBSEAnnouncementsByCategory,
    findInstrumentByScripCode:
      deps.findInstrumentByScripCode ?? defaultFindInstrumentByScripCode,
    findInstrumentBySymbol:
      deps.findInstrumentBySymbol ?? defaultFindInstrumentBySymbol,
    findInstrumentsByNamePrefix:
      deps.findInstrumentsByNamePrefix ?? defaultFindInstrumentsByNamePrefix,
    findExistingDocument:
      deps.findExistingDocument ?? defaultFindExistingDocument,
    upsertDocument: deps.upsertDocument ?? defaultUpsertDocument,
    downloadAttachment: deps.downloadAttachment ?? defaultDownloadAttachment,
    uploadAttachment: deps.uploadAttachment ?? uploadToGCS,
    publishFollowUp: deps.publishFollowUp ?? defaultPublishFollowUp,
    now: deps.now ?? Date.now,
    sleep:
      deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
  };
}

/** Normalize a company name for fuzzy matching: lower-case, drop the common
 *  corporate suffixes + punctuation so "Reliance Industries Ltd" ≈
 *  "Reliance Industries Limited". */
function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|pvt|private|inc|corp|corporation|co)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Best-effort map a BSE announcement to an InstrumentMapping, in three rungs.
 *
 * ## Rung 1 is the scrip code, and it is FIRST for a reason — MONEY-1285
 *
 * This function used to start at the alpha symbol and end at a fuzzy company
 * name, discarding ~420 rows a night (`failed` 420-452 on each of the three
 * post-fix prod runs). `ann.scripCode` — BSE's own numeric identifier, present
 * on every announcement row — was never consulted, although
 * `InstrumentMapping.bseScripCode` exists precisely as that join key and the
 * schema comment calls it "AUTHORITATIVE, from the exchange that issues both
 * identifiers".
 *
 * It leads rather than merely preceding the fuzzy match because it is the only
 * rung that is an IDENTITY rather than a string comparison. A rename leaves the
 * two exchanges carrying different tickers for one company (MONEY-1177), so the
 * alpha symbol can point at a different issuer; a scrip code cannot.
 *
 * It deliberately does NOT filter `instrumentType: "EQUITY"` the way the two
 * string rungs do. Those need the filter because a symbol or a name can collide
 * across instrument classes; an exchange-issued identity cannot, and gating an
 * authoritative match on a DERIVED classification would drop it into the fuzzy
 * name rung — which is the one that can return the wrong company.
 *
 * **This rung is PARTIAL today and that is expected.** Only 581 of 10,381 BSE
 * rows carry `bseScripCode` (it is written by the screener-slug resolver, whose
 * backfill is a separate ticket). A miss falls through to rungs 2 and 3 exactly
 * as before, so the rung can only ever ADD resolutions.
 *
 * Returns null when nothing matches (the row is then skipped — a StockDocument
 * requires a real instrumentId).
 */
async function resolveInstrument(
  ann: BseAnnouncement,
  deps: ResolvedDeps,
): Promise<ResolvedInstrument | null> {
  // 1. BSE's own scrip code. Digits only — the value goes into a query, and a
  //    non-numeric "scrip code" is a parse artefact rather than an identifier.
  const scripCode = String(ann.scripCode ?? "").trim();
  if (/^\d+$/.test(scripCode)) {
    const byScrip = await deps.findInstrumentByScripCode(scripCode);
    if (byScrip) return byScrip;
  }

  // 2. Alpha symbol (when the row has one) — prefer the BSE listing, then NSE.
  if (ann.symbol) {
    const bySymbol = await deps.findInstrumentBySymbol(ann.symbol.toUpperCase());
    if (bySymbol) return bySymbol;
  }

  // 3. Company long-name → normalized match against a BSE/NSE equity. BSE's
  //    `company` is the most consistently present identifier. We do a
  //    case-insensitive contains on the raw name to bound the candidate set,
  //    then confirm with a normalized-equality check (suffix-insensitive).
  const company = ann.company.trim();
  if (company.length >= 4) {
    const wantNorm = normalizeCompany(company);
    if (wantNorm) {
      const candidates = await deps.findInstrumentsByNamePrefix(
        company.split(/\s+/)[0]!,
      );
      const hit = candidates.find(
        (c) => normalizeCompany(c.name) === wantNorm,
      );
      if (hit) {
        return { id: hit.id, symbol: hit.symbol, exchange: hit.exchange };
      }
    }
  }

  return null;
}

/**
 * What one attachment download produced — MONEY-1315 (B).
 *
 *   stored       bytes reached GCS; the row points at them
 *   refused-html the bytes were an HTML page; the row must be TERMINAL
 *   null         no attachment (no url, every candidate 404'd, under the floor,
 *                or the download threw) — RETRYABLE, the row stays FAILED
 *
 * The third state existed already and the second did not, which is the defect:
 * folding an HTML refusal into `null` would leave the row `FAILED`, and FAILED
 * is what the retry path selects. The interstitial is deterministic — BSE will
 * serve the same page tomorrow — so a retryable state means re-downloading it
 * every night forever.
 */
type BseArchiveOutcome =
  | { kind: "stored"; gcsPath: string; size: number; contentType: string }
  | { kind: "refused-html"; reason: string };

/**
 * Download the announcement PDF and archive it to GCS. Returns the gcsPath, the
 * byte size and the RAW `content-type` header, or null on any failure. The raw
 * header is returned rather than assumed because the row's `mimeType` is
 * derived from it — see the call site.
 */
async function archivePdf(
  ann: BseAnnouncement,
  symbol: string,
  docType: StockDocType,
  period: string,
  deps: ResolvedDeps,
): Promise<BseArchiveOutcome | null> {
  if (!ann.pdfUrl) return null;
  // BSE serves attachments from TWO directories and which one answers depends
  // on the filing's AGE: `AttachLive/` for recent, `AttachHis/` for older. A
  // wrong guess is a 404 whose BODY IS 8,406 BYTES OF HTML — comfortably over
  // MIN_PDF_BYTES, so only the `res.ok` check stands between that and storing
  // error pages as PDFs.
  //
  // This used to fetch `ann.pdfUrl` alone, which `parseBseAnnouncementRow`
  // always builds against AttachLive. Right for the nightly job, wrong for
  // every historical walk: the 2016 backfill 404'd on 4,299 of 4,299
  // attachments and wrote 4,299 rows with `gcsPath: ""`. MONEY-1258 measured
  // this, wrote `bseAttachmentCandidates`, exported it with ten tests — and
  // never called it from here. Defined, exported, wired to nothing.
  //
  // Candidates are ordered most-likely-first by age, so the common case still
  // costs ONE request; only a miss pays for the second.
  const candidates = bseAttachmentCandidates(ann.pdfUrl, ann.publishedAt);
  /**
   * Set when a candidate answered 200 with an HTML BODY — MONEY-1315 (B).
   *
   * Recorded rather than returned immediately, so an HTML answer from the FIRST
   * directory still lets the SECOND be tried. That is the same reasoning the
   * `!res.ok` branch below already applies to a 404: a wrong directory is not a
   * missing attachment, and the whole point of the candidate list is the retry.
   * Only when EVERY candidate is exhausted does an HTML body become the run's
   * verdict for this filing.
   */
  let htmlRefusalReason: string | null = null;
  try {
    for (const url of candidates) {
      const res = await deps.downloadAttachment(url);
      // A 429 from the attachment host means we're rate-limited — surface it so
      // the run circuit-breaks (vs. silently returning null, which reads as "no
      // PDF"). Thrown rather than `continue`d: the second directory is served by
      // the same host, so retrying it would spend another request into a limit
      // we have already hit.
      if (res.status === 429) throw new BseRateLimitError(`PDF ${symbol}`);
      // NOT `return null` — a 404 here is the WRONG DIRECTORY, not a missing
      // attachment, and the next candidate is the whole point.
      if (!res.ok) continue;
      const contentType = res.contentType;
      const buffer = res.body;
      if (buffer.length < MIN_PDF_BYTES) continue;

      const clean = symbol.toUpperCase().replace(/[^A-Z0-9&]/g, "");
      const safePeriod = period.replace(/[/\\:*?"<>|\s]/g, "-");
      // THE DOC TYPE COMES FROM THE CLASSIFICATION, not from a literal. It used
      // to be a hard-coded "corporate_filing" here while the row read a constant
      // eleven lines away — two spellings of one fact, and a `quarterly_result`
      // row would have pointed at a `corporate_filing/` object.
      const gcsPath = buildStockDocPath(
        symbol,
        docType,
        `${clean}-${docType.replace(/_/g, "-")}-${safePeriod}.pdf`,
      );

      // MONEY-1315 (B) — the check the comment at the top of this function has
      // been asking for. It already names the exact failure ("a 404 whose BODY
      // IS 8,406 BYTES OF HTML — comfortably over MIN_PDF_BYTES, so only the
      // `res.ok` check stands between that and storing error pages as PDFs")
      // and then defends against it with nothing but `res.ok`. `res.ok` cannot
      // help: the two shapes this leg actually meets are a 200 carrying an
      // interstitial, and a candidate directory that answers 200 for a filing
      // it does not hold. The body is the only thing that can tell them from a
      // PDF.
      //
      // Placed BEFORE the upload, not after: the point is that the object never
      // exists, so no reader can find an HTML page under a document key.
      const gate = mayStoreDocumentBody({ gcsPath, body: buffer });
      if (!gate.store) {
        htmlRefusalReason = gate.reason;
        continue;
      }

      await deps.uploadAttachment(gcsPath, buffer, contentType || "application/pdf");
      return { kind: "stored", gcsPath, size: buffer.length, contentType };
    }
    return htmlRefusalReason === null
      ? null
      : { kind: "refused-html", reason: htmlRefusalReason };
  } catch (err) {
    // Let a rate-limit signal bubble to the run loop's circuit-breaker; only
    // genuine per-PDF failures degrade to null (the row is still stored FAILED).
    if (err instanceof BseRateLimitError) throw err;
    logger.warn(
      `PDF archive failed for ${symbol} (${ann.newsId}): ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

/**
 * Write ONE announcement, choosing between skip-if-present and D-v upsert.
 *
 * `StockDocument` is `@@unique([symbol, exchange, docType, period])`, and the
 * two docTypes key differently, so they need different write strategies:
 *
 *   `corporate_filing`  period is `bse-{newsId}` — GLOBALLY UNIQUE per filing.
 *                       A row that exists IS this filing, so a re-run is a true
 *                       no-op ONCE THE BYTES ARE THERE. Before MONEY-1285 that
 *                       "once" was missing and the skip was unconditional,
 *                       which is what stranded 2,339 byte-less rows.
 *
 *   `quarterly_result`  period is `Jun 2026` — ONE ROW PER COMPANY-QUARTER, so
 *                       a revised filing for a quarter we already have COLLIDES
 *                       by design. Founder decision D-v is **latest wins**:
 *                       upsert, and carry the superseded `ATTACHMENTNAME` into
 *                       the description so the revision is auditable from the
 *                       row alone. Skipping instead would pin the FIRST filing
 *                       of a quarter forever and silently discard every
 *                       restatement.
 */
async function writeAnnouncement(input: {
  ann: BseAnnouncement;
  inst: ResolvedInstrument;
  classification: BseClassification;
  archive: BseArchiveOutcome | null;
  previousDescription: string | null;
  supersededAttachment: string | null;
  deps: ResolvedDeps;
}): Promise<void> {
  const { ann, inst, classification, archive } = input;
  const stored = archive?.kind === "stored" ? archive : null;
  const refusedHtml = archive?.kind === "refused-html";
  const contentType = stored?.contentType ?? null;

  const common = {
    title: ann.title || `${inst.symbol} BSE Filing`,
    description: buildBseDocumentDescription({
      ann,
      previousDescription: input.previousDescription,
      supersededAttachment: input.supersededAttachment,
    }),
    sourceUrl: ann.pdfUrl ?? undefined,
    sourceType: "BSE",
    // gcsPath is required (non-null) on the model; when the PDF couldn't be
    // archived we still record the source URL and flag the doc FAILED so a
    // later run can retry it.
    //
    // MONEY-1315 (B) — an HTML REFUSAL lands on the same empty `gcsPath` and is
    // the SAME convention (`ABSENT_GCS_PATH`, imported so this file and the
    // quarantine migration cannot spell it differently), but it is a different
    // STATUS. `FAILED` means "retry me", and BSE will serve the identical
    // interstitial tomorrow; `UNSUPPORTED` is terminal, which is what a
    // deterministic non-document deserves. `title`, `description` and
    // `sourceUrl` survive either way — the BSE-retention precedent this table
    // already carries on 7,234 rows (see `ABSENT_GCS_PATH`, which is where that
    // number is spelled once).
    gcsPath: stored?.gcsPath ?? ABSENT_GCS_PATH,
    fileSize: stored?.size ?? 0,
    // NORMALIZED, never the raw header. `mimeType` is what the extract and
    // parse lanes select on with an EXACT match, and a raw header is a media
    // type PLUS PARAMETERS: `application/pdf;charset=UTF-8` stored verbatim is
    // a row no extractor can ever take (MONEY-1255, 1,211 rows).
    mimeType: refusedHtml ? "text/html" : normalizeDocMimeType(contentType),
    // A non-PDF that nonetheless archived (an HTML error page over the size
    // floor) is UNSUPPORTED, not PENDING — PENDING would queue it for an
    // extractor that will never read it and inflate the backlog forever.
    processingStatus: refusedHtml
      ? HTML_QUARANTINE_STATUS
      : stored
        ? initialProcessingStatus(contentType)
        : "FAILED",
    fetchedAt: new Date(),
  };

  await input.deps.upsertDocument({
    where: {
      symbol_exchange_docType_period: {
        symbol: inst.symbol,
        exchange: inst.exchange,
        docType: classification.docType,
        period: classification.period,
      },
    },
    create: {
      instrumentId: inst.id,
      symbol: inst.symbol,
      exchange: inst.exchange,
      docType: classification.docType,
      period: classification.period,
      ...common,
    },
    update: {
      ...common,
      // A superseding write restarts BOTH downstream lanes: the bytes changed,
      // so the extracted text and every embedding derived from the old PDF
      // describe a document this row no longer points at.
      isEmbedded: false,
      textContent: null,
      parseStatus: "PENDING",
      parsedAt: null,
    },
  });
}

export async function processBseAnnouncementsSync(
  data: BseAnnouncementsSyncMessage,
  injected: BseAnnouncementsSyncDeps = {},
): Promise<void> {
  const deps = resolveDeps(injected);
  const startedAt = deps.now();
  const toDate = data.toDate ? new Date(`${data.toDate}T00:00:00Z`) : new Date();
  const fromDate = data.fromDate
    ? new Date(`${data.fromDate}T00:00:00Z`)
    : new Date(toDate.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const maxPages = data.maxPages ?? DEFAULT_MAX_PAGES;
  const days = windowDays(fromDate, toDate);

  // MONEY-1285 — the chain state. It rides on the Pub/Sub payload but is NOT on
  // `BseAnnouncementsSyncMessage` yet, so it is read defensively through the
  // pure normalizers rather than through the type. `parsePubSubMessage` is a
  // JSON.parse plus a cast, and `routes/bse-announcements.ts` forwards the whole
  // parsed object, so both fields survive the hop at runtime. Adding them to the
  // interface is a one-line follow-up; reading them through `unknown` is what
  // makes the chain work TODAY rather than being a field nobody forwards
  // (MONEY-1235's `createMissing`, inert in every production run it shipped in).
  const chainState = data as unknown as Record<string, unknown>;
  const chainDepth = normalizeBseChainDepth(chainState.chainDepth);
  const resumeIndex = normalizeBseResumeIndex(chainState.resumeIndex);

  logger.info(
    `BSE announcements sync ${fromDate.toISOString().slice(0, 10)}..` +
      `${toDate.toISOString().slice(0, 10)} (maxPages/category: ${maxPages}, ` +
      `chainDepth: ${chainDepth}/${BSE_MAX_CHAIN_DEPTH}, resumeIndex: ${resumeIndex}, ` +
      `budget: ${BSE_RUN_TIME_BUDGET_MS}ms)`,
  );

  let fetched: BseAnnouncementsFetch | null = null;
  /** Set when the FETCH itself could not run — distinct from "found nothing". */
  let fetchFailure: string | null = null;
  let rateLimited = false;
  let resolved = 0;
  let unresolved = 0;
  let stored = 0;
  let quarterlyResults = 0;
  let superseded = 0;
  /** Rows re-written only to fetch an attachment a prior run could not get. */
  let retriedBytes = 0;
  let pdfsArchived = 0;
  /**
   * Attachments REFUSED because the body sniffed as HTML — MONEY-1315 (B).
   *
   * Its own counter, beside `pdfsArchived` rather than folded into it or into
   * `writeFailures`. A refusal is not a failed write (the row IS written, and
   * it is terminal) and it is not an archive (no bytes reached GCS); with no
   * counter of its own, a night where every attachment came back as an
   * interstitial reports `pdfsArchived 0` — the same number as a night where
   * BSE simply had no attachments to serve.
   */
  let htmlRefusals = 0;
  let skippedExisting = 0;
  let writeFailures = 0;
  /** Announcements this run HANDLED — the chain's forward-progress signal. */
  let consumed = 0;
  /** Announcements after this run's stopping point — the chain's work signal. */
  let remaining = 0;
  let stoppedOnBudget = false;
  let stoppedOnCap = false;
  // Circuit-breaker: once BSE's attachment host 429s, stop downloading PDFs
  // for the rest of the run (rows are still written with status FAILED so a
  // later run retries the attachment).
  let pdfRateLimited = false;

  // MONEY-1255 — EVERY exit from this block reaches the `finally`, including
  // the three early returns that used to sit above the only report call. The
  // reporting gap, not the query bug, is why a monitor watched this job for
  // months and never once fired.
  try {
    try {
      fetched = await deps.fetchAnnouncements({
        fromDate,
        toDate,
        maxPages,
        paceMs: DELAY_BETWEEN_API_PAGES_MS,
      });
    } catch (err) {
      if (err instanceof BseRateLimitError) {
        rateLimited = true;
        fetchFailure =
          "BSE API rate-limited (429) after retries — run aborted, the daily cron retries tomorrow";
        logger.warn(fetchFailure);
        return;
      }
      fetchFailure = `fetch failed: ${err instanceof Error ? err.message : err}`;
      logger.error(fetchFailure);
      return;
    }

    logger.info(
      `Fetched ${fetched.announcements.length} announcements over ` +
        `${fetched.window.from}..${fetched.window.to}` +
        (fetched.futureDateStepBacks > 0
          ? ` (window end stepped back ${fetched.futureDateStepBacks}d — BSE rejected it as a future date)`
          : "") +
        ` — ${summarizeCategoryCounts(fetched.byCategory)}`,
    );
    if (fetched.announcements.length === 0) return;

    // MONEY-1285 — ROUND-ROBIN BEFORE THE CAP SPENDS ANYTHING. The client hands
    // back a category-MAJOR list; a 500-download cap over that takes a prefix,
    // and the same five categories were the tail every single night. This is
    // also the ordering `resumeIndex` indexes into, which is why it has to be a
    // deterministic pure function of the fetch.
    const ordered = interleaveByCategory(
      fetched.announcements,
      (a) => a.category,
    );
    const work = ordered.slice(resumeIndex);
    remaining = work.length;
    logger.info(
      `Interleaved ${ordered.length} announcements across ` +
        `${new Set(ordered.map((a) => a.category)).size} categories; ` +
        `${work.length} to handle from index ${resumeIndex}`,
    );

    let downloadIndex = 0;

    for (const ann of work) {
      // MONEY-1285 — the 600s Pub/Sub ack deadline is the binding constraint
      // and it is a TIME, so it is enforced with a clock rather than a count.
      // Overrunning it does not make the run slow: Pub/Sub redelivers and a
      // SECOND copy walks the same window. Checked BETWEEN announcements, so
      // the true wall is `budget + one announcement` — the headroom arithmetic
      // on BSE_RUN_TIME_BUDGET_MS pays for exactly that.
      if (!isWithinBseRunBudget(startedAt, deps.now())) {
        stoppedOnBudget = true;
        logger.info(
          `Run budget reached after ${deps.now() - startedAt}ms — stopping at ` +
            `${consumed}/${work.length}; the chained follow-up resumes at ` +
            `index ${resumeIndex + consumed}.`,
        );
        break;
      }

      try {
        const inst = await resolveInstrument(ann, deps);
        if (!inst) {
          unresolved++;
          consumed++;
          continue;
        }
        resolved++;

        const classification = classifyBseAnnouncement(ann, ann.quarterId);

        const existing = await deps.findExistingDocument({
          symbol: inst.symbol,
          exchange: inst.exchange,
          docType: classification.docType,
          period: classification.period,
        });

        const isQuarterly =
          classification.docType === BSE_DOC_TYPE_QUARTERLY_RESULT;
        const priorAttachment = existing
          ? (parseBseDocumentBreadcrumb(existing.description)?.attachment ??
            (existing.sourceUrl ?? "").split("/").pop() ??
            "")
          : "";
        const incomingAttachment = (ann.pdfUrl ?? "").split("/").pop() ?? "";

        // THE ONE WRITE DECISION — MONEY-1285. `skip-has-bytes` is the only
        // skip; a row with `gcsPath: ""` is retried whatever its docType. The
        // old shape skipped every existing `corporate_filing` outright and
        // reached the bytes test only for quarterlies, which is what made the
        // 2,339 permanent: a `corporate_filing`'s period is `bse-{newsId}`, so
        // the existing row matches on every subsequent run, forever.
        const decision = decideBseAnnouncementWrite({
          existing,
          isQuarterly,
          priorAttachment,
          incomingAttachment,
        });
        if (!bseDecisionWrites(decision)) {
          skippedExisting++;
          consumed++;
          continue;
        }

        // Archive the PDF (paced + capped + breaker-gated). The document is
        // stored even when the PDF can't be fetched — the metadata + sourceUrl
        // are still useful (status FAILED), and a later run retries it now that
        // the retry arm covers both docTypes.
        const wantsDownload = Boolean(ann.pdfUrl) && !pdfRateLimited;
        if (wantsDownload && downloadIndex >= MAX_PDF_DOWNLOADS_PER_RUN) {
          // The cap ENDS the loop rather than writing a byte-less row past it.
          // Those rows were a source of the 2,339, and the follow-up resumes at
          // exactly this announcement.
          stoppedOnCap = true;
          logger.info(
            `PDF cap (${MAX_PDF_DOWNLOADS_PER_RUN}) reached — stopping at ` +
              `${consumed}/${work.length}; the chained follow-up resumes at ` +
              `index ${resumeIndex + consumed}.`,
          );
          break;
        }

        let archive: BseArchiveOutcome | null = null;
        if (wantsDownload) {
          if (downloadIndex > 0) {
            await deps.sleep(DELAY_BETWEEN_DOWNLOADS_MS);
          }
          downloadIndex++;
          try {
            archive = await archivePdf(
              ann,
              inst.symbol,
              classification.docType,
              classification.period,
              deps,
            );
            // MONEY-1315 (B) — `pdfsArchived` counts BYTES THAT REACHED GCS, so
            // a refusal must not bump it. It used to be `if (archive)`, which
            // was correct while the only non-null result WAS an upload; with a
            // second non-null outcome the truthiness test would report an
            // archive that never happened — the counter-before-the-call shape,
            // one type change later.
            if (archive?.kind === "stored") pdfsArchived++;
            if (archive?.kind === "refused-html") {
              // Incremented HERE, on the refusal itself, with the body already
              // inspected — never at the top of the download it describes.
              htmlRefusals++;
              logger.warn(
                `REFUSED BSE ${classification.docType} for ${inst.symbol} ` +
                  `${classification.period}: ${archive.reason} (${ann.pdfUrl})`,
              );
            }
          } catch (err) {
            if (err instanceof BseRateLimitError) {
              pdfRateLimited = true;
              logger.warn(
                "BSE attachment host rate-limited (429) — skipping PDF downloads " +
                  "for the rest of this run (rows still recorded FAILED for retry)",
              );
            } else {
              throw err;
            }
          }
        }

        await writeAnnouncement({
          ann,
          inst,
          classification,
          archive,
          previousDescription: existing?.description ?? null,
          // A bytes-RETRY is not a supersession: the attachment is the same
          // one, so recording it as superseded would invent a revision.
          supersededAttachment:
            decision === "write-superseding" ? priorAttachment || null : null,
          deps,
        });
        stored++;
        if (decision === "write-retry-bytes") retriedBytes++;
        if (isQuarterly) {
          quarterlyResults++;
          if (decision === "write-superseding") superseded++;
        }
      } catch (err) {
        writeFailures++;
        logger.warn(
          `Failed to store BSE announcement ${ann.newsId} (${ann.scripCode}): ${err instanceof Error ? err.message : err}`,
        );
      }
      consumed++;
    }

    remaining = work.length - consumed;

    logger.info(
      `Sync complete: ${stored} stored (${quarterlyResults} quarterly_result, ` +
        `${superseded} superseding a prior filing, ${retriedBytes} retrying a ` +
        `missing attachment), ${pdfsArchived} PDFs archived, ` +
        // Printed only when it happened — a zeroed clause on every run is how a
        // summary line becomes noise nobody reads.
        (htmlRefusals > 0
          ? `${htmlRefusals} refused as HTML pages, `
          : "") +
        `${skippedExisting} already present, ${resolved} resolved / ${unresolved} unresolved` +
        (stoppedOnBudget ? " (budget-truncated)" : "") +
        (stoppedOnCap ? " (cap-truncated)" : "") +
        `, ${remaining} remaining`,
    );
  } finally {
    const health = judgeBseAnnouncementsHealth({
      byCategory: fetched?.byCategory ?? [],
      transportFailures: fetched?.transportFailures ?? (fetchFailure ? 1 : 0),
      windowDays: days,
    });

    if (fetchFailure) {
      logger.error(`UNHEALTHY — ${fetchFailure}`);
    } else if (!health.healthy) {
      // A whole-market feed returning nothing is an ERROR, not an info line.
      // This is the sentence that would have named the defect on night one.
      logger.error(`UNHEALTHY — ${health.reason}`);
    } else if (health.emptyCategories.length > 0) {
      logger.warn(`Empty categories: ${health.emptyCategories.join(", ")}`);
    }

    // `selected` EXCLUDES `skippedExisting` — already-stored announcements were
    // never write candidates, so a quiet re-run reports 0 rather than alarming.
    // A blocked or failed FETCH reports through `transportFailures`, which is
    // what makes it distinguishable from an idle run: without it a 429 abort
    // and a genuinely quiet night both emit 0/0/0.
    const transportFailures =
      (fetched?.transportFailures ?? 0) + (fetchFailure ? 1 : 0);
    const baseReason = fetchFailure ?? (health.healthy ? null : health.reason);

    // MONEY-1315 (B) — the refusals reach the OUTCOME, not only the log line.
    // APPENDED to whatever reason already applies rather than replacing it: a
    // rate-limited run that also refused twelve interstitials has two things
    // worth saying, and the fetch failure is the one that must lead. Emitted
    // even on a HEALTHY run, because "we stored 300 and refused 40" is the
    // shape that says the attachment host is degrading, and by definition a
    // healthy run has no other channel to say it in.
    const skippedReason =
      htmlRefusals > 0
        ? [baseReason, `${htmlRefusals} attachment(s) refused as HTML pages`]
            .filter((part): part is string => Boolean(part))
            .join("; ")
        : baseReason;

    reportJobOutcome({
      job: "bse-announcements-sync",
      selected: stored + unresolved + writeFailures,
      written: stored,
      failed: unresolved + writeFailures,
      ...(transportFailures > 0 ? { transportFailures } : {}),
      ...(skippedReason ? { skippedReason } : {}),
    });

    // MONEY-1285 — ONE follow-up per RUN, published from the `finally` so it is
    // reached on every exit path and cannot be reached twice. Deliberately NOT
    // inside the loop: a per-item publish is how `stock-document-extract`'s
    // sibling defect fans a chain out into a storm (MONEY-1307).
    await chainNextLink({
      deps,
      chainDepth,
      resumeIndex,
      consumed,
      remaining,
      maxPages,
      rateLimited: rateLimited || pdfRateLimited,
      fetchFailed: fetchFailure !== null,
      window: fetched?.window ?? null,
      fromDate,
      toDate,
    });

    if (rateLimited) {
      logger.warn(
        "Run aborted on a persistent 429; the daily cron retries tomorrow",
      );
    }
  }
}

/**
 * Publish the NEXT link of the drain chain — MONEY-1285.
 *
 * ## Why a chain rather than a bigger cap
 *
 * The run is bounded by a 600s Pub/Sub ack deadline (Pub/Sub's MAXIMUM, not a
 * setting), and per-announcement cost is a 1500ms pace plus an attachment
 * download whose average is 5.7 MB. Raising `MAX_PDF_DOWNLOADS_PER_RUN` makes
 * the overrun worse, not better; lowering `DELAY_BETWEEN_DOWNLOADS_MS` trades
 * the deadline for a 429 from a host that has already blocked this repo.
 * `workers/CLAUDE.md` states the rule: self-chaining is the lever.
 *
 * ## Why it terminates
 *
 * `shouldChainBseAnnouncements` refuses once `chainDepth + 1` reaches
 * `BSE_MAX_CHAIN_DEPTH`, and every published message carries `chainDepth + 1`.
 * That bound holds whatever the window contains. The other four conditions
 * (rate-limited, fetch-failed, window drained, no forward progress) only ever
 * stop it SOONER.
 *
 * ## Why the follow-up carries the EFFECTIVE window
 *
 * `resumeIndex` is an index into the ordering a PARTICULAR window produced. The
 * fetch clamps a future `toDate` and may step it back further on BSE's own
 * evidence, so forwarding the REQUESTED window would re-pay those step-back
 * requests and — if the count differed — resume into a different list.
 *
 * Never throws: a failed chain must leave a successful run successful. The cost
 * of a dropped link is one delayed batch; the daily scheduler starts a fresh
 * chain anyway, and every byte-less row it left behind is now retryable.
 */
async function chainNextLink(opts: {
  deps: ResolvedDeps;
  chainDepth: number;
  resumeIndex: number;
  consumed: number;
  remaining: number;
  maxPages: number;
  rateLimited: boolean;
  fetchFailed: boolean;
  window: { from: string; to: string } | null;
  fromDate: Date;
  toDate: Date;
}): Promise<void> {
  const { chain, reason } = shouldChainBseAnnouncements({
    chainDepth: opts.chainDepth,
    remaining: opts.remaining,
    consumed: opts.consumed,
    rateLimited: opts.rateLimited,
    fetchFailed: opts.fetchFailed,
  });

  if (!chain) {
    logger.info(
      `NOT CHAINING (${reason}) — depth ${opts.chainDepth}/${BSE_MAX_CHAIN_DEPTH}, ` +
        `consumed ${opts.consumed}, remaining ${opts.remaining}`,
    );
    return;
  }

  try {
    const from =
      (opts.window ? bseCompactToIsoDate(opts.window.from) : null) ??
      opts.fromDate.toISOString().slice(0, 10);
    const to =
      (opts.window ? bseCompactToIsoDate(opts.window.to) : null) ??
      opts.toDate.toISOString().slice(0, 10);

    await opts.deps.publishFollowUp({
      fromDate: from,
      toDate: to,
      maxPages: opts.maxPages,
      chainDepth: opts.chainDepth + 1,
      resumeIndex: opts.resumeIndex + opts.consumed,
    });
    logger.info(
      `Chained bse-announcements-sync link ${opts.chainDepth + 1}/${BSE_MAX_CHAIN_DEPTH} ` +
        `(${from}..${to}, resumeIndex ${opts.resumeIndex + opts.consumed}, ` +
        `${opts.remaining} remaining)`,
    );
  } catch (err) {
    logger.warn(
      `Failed to chain the next BSE announcements link: ${err instanceof Error ? err.message : err}`,
    );
  }
}
