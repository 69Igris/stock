/**
 * BSE announcements sync — PURE helpers (no Prisma, no GCS, no network).
 *
 * Side-effect-free decisions lifted out of `bse-announcements-sync.ts` so they
 * can be unit-tested by importing the REAL symbol — no shadow copies — without
 * booting Prisma. The processor imports and CALLS every export here, so the
 * production path and the tests run the SAME code. Mirrors
 * `stock-document-parse-logic.ts` and `nse-announcements-sync-logic.ts`.
 *
 * ## Why this file exists at all (MONEY-1255)
 *
 * `bse-announcements-sync` has written **zero rows since it was created**.
 * Measured on prod 2026-08-26: `stock_documents` where
 * `docType: "corporate_filing"` = 0, newest `fetchedAt` = NONE. The job ran
 * nightly and exited 0 every time.
 *
 * The proximate cause was one query parameter — see
 * `BSE_ANNOUNCEMENT_CATEGORIES` in `@usemoney/research/data-sources/bse-client`
 * — but the reason nobody noticed for the life of the job was that every
 * judgement it made lived inline in an I/O function, so none of them could be
 * tested and none of them reported anything. The classification, the period
 * derivation and the health verdict are all here now, and all of them are
 * asserted against real observed `NEWSSUB` strings.
 *
 * @see workers/src/processors/bse-announcements-sync.ts (caller)
 * @see workers/__tests__/processors/bse-announcements-sync-logic.test.ts
 */

import type {
  BseAnnouncement,
  BseCategoryOutcome,
} from "@usemoney/research/data-sources/bse-client";
import { BSE_RESULT_CATEGORIES } from "@usemoney/research/data-sources/bse-client";
import { toIstDateKey } from "@usemoney/core/market-data/nse-holidays";
import type { StockDocType } from "@usemoney/research/data-sources/stock-document-paths";

// ---------------------------------------------------------------------------
// DOC TYPES — one constant per string, used by BOTH the row and the GCS path
// ---------------------------------------------------------------------------

/**
 * The docType for an announcement we could NOT resolve to a filed period.
 *
 * ## Two literals that must move together
 *
 * Before MONEY-1255 the processor spelled this string TWICE: the DB row read
 * the `DOC_TYPE` constant while `buildStockDocPath` was handed a hard-coded
 * `"corporate_filing"` literal eleven lines away. Changing one without the
 * other splits the GCS path from the row that points at it — the object lands
 * under `stocks/{SYM}/corporate_filing/` while the row claims
 * `quarterly_result`, and nothing fails: the upload succeeds, the insert
 * succeeds, and the only symptom is a `gcsPath` that no reader derives the
 * same way twice.
 *
 * Both sites now read {@link bseDocTypeFor}, so the path and the row are ONE
 * decision.
 */
export const BSE_DOC_TYPE_CORPORATE_FILING: StockDocType = "corporate_filing";

/**
 * The docType for a results announcement with a DERIVABLE period end.
 *
 * In `PARSEABLE_DOC_TYPES` (`stock-document-parse-logic.ts`), which is the
 * whole point: a `corporate_filing` is prose the financials parser is
 * deliberately told to skip, and a `quarterly_result` is a filed statement it
 * is meant to read. Promoting a row into this type is therefore a claim that
 * the PDF contains a statement for a specific period — which is exactly why
 * {@link derivePeriodEnd} refuses to guess.
 */
export const BSE_DOC_TYPE_QUARTERLY_RESULT: StockDocType = "quarterly_result";

// ---------------------------------------------------------------------------
// PERIOD-END DERIVATION — real or absent, never fabricated
// ---------------------------------------------------------------------------

/** Plausibility band for a filed period's year. Narrower than the timeline
 *  parser's 1900..2100 because a RESULTS period predating BSE's electronic
 *  filing era is a parse artefact, not a filing. */
const MIN_PERIOD_YEAR = 1990;
const MAX_PERIOD_YEAR = 2100;

/** Months an Indian quarterly results period ends in. */
const QUARTER_END_MONTHS = new Set([3, 6, 9, 12]);

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTH_NAME_TO_INDEX: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * `DD/MM/YYYY`, `DD.MM.YYYY`, `DD-MM-YYYY` — the three separators BSE's
 * `NEWSSUB` free text uses, observed live:
 *
 *   "UNAUDITED RESULTS QUARTER ENDED 30/06/2026"
 *   "AUDITED FIN RESULTS 31.03.2026"
 *
 * DAY FIRST, unconditionally. BSE is an Indian exchange writing for an Indian
 * audience and every observed string is day-first; `03/06/2026` is 3 June, not
 * 6 March. There is no field on the row that disambiguates, so this is a
 * documented convention rather than a detection — and it is why
 * {@link isMonthEnd} does the real filtering below: a US-order misread almost
 * never lands on the last day of its month, so the month-end gate rejects it
 * instead of filing a quarter under the wrong date.
 */
const EXPLICIT_DATE_RE = /(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?!\d)/g;

/**
 * `QUARTER ENDED JUNE 2026`, `YEAR ENDING MARCH 2026` — a named month with no
 * day, ONLY when the text carries an "ended/ending" cue.
 *
 * Deriving the last day of a named month is arithmetic, not invention: "quarter
 * ended June 2026" states a period end of 30 June 2026 and nothing else. The
 * cue is required so a stray "JUNE 2026" elsewhere in a subject line (a meeting
 * month, an AGM notice) cannot be promoted into a filed period.
 */
const ENDED_CUE_RE = /\bend(?:ed|ing)\b/i;
const MONTH_NAME_YEAR_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*,?\s*(\d{4})(?!\d)\b/gi;

/** How the period end was obtained. Carried so a reviewer can see which rule
 *  fired without re-deriving it. */
export type PeriodEndSource =
  | "NEWSSUB_EXPLICIT_DATE"
  | "NEWSSUB_MONTH_NAME"
  | "QUARTER_ID";

export interface DerivedPeriodEnd {
  /** Midnight UTC of the period's last day. */
  date: Date;
  source: PeriodEndSource;
  /** True when `QUARTER_ID` decoded and agreed. Purely informational. */
  quarterIdCorroborated: boolean;
}

/** Days in `month` (1-12) of `year`, Gregorian. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Midnight-UTC date, or null when the triple is not a real calendar day. */
function utcDate(year: number, month: number, day: number): Date | null {
  if (year < MIN_PERIOD_YEAR || year > MAX_PERIOD_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

/** True when `d` is the last day of its month. */
function isMonthEnd(d: Date): boolean {
  return (
    d.getUTCDate() === daysInMonth(d.getUTCFullYear(), d.getUTCMonth() + 1)
  );
}

/**
 * Decode `QUARTER_ID` when — and only when — it is self-evidently a date.
 *
 * BSE's `QUARTER_ID` is an internal identifier and NO sample of it was
 * available when this was written, so this is deliberately inert for anything
 * that is not an unambiguous `YYYYMMDD` or `YYYYMM`. It is a CROSS-CHECK, never
 * a source: `derivePeriodEnd` will not mint a period from it, and a decodable
 * value that CONTRADICTS the subject line causes the whole derivation to be
 * abandoned rather than arbitrated. Two sources disagreeing about which quarter
 * a filing covers is not a tie to break — it is a reason to store the row as a
 * `corporate_filing` and lose nothing.
 */
export function decodeQuarterId(raw: unknown): Date | null {
  const s = String(raw ?? "").trim();
  if (/^\d{8}$/.test(s)) {
    return utcDate(
      Number(s.slice(0, 4)),
      Number(s.slice(4, 6)),
      Number(s.slice(6, 8)),
    );
  }
  if (/^\d{6}$/.test(s)) {
    const year = Number(s.slice(0, 4));
    const month = Number(s.slice(4, 6));
    if (month < 1 || month > 12) return null;
    if (year < MIN_PERIOD_YEAR || year > MAX_PERIOD_YEAR) return null;
    return utcDate(year, month, daysInMonth(year, month));
  }
  return null;
}

/**
 * Read a filed period end out of an announcement's subject line, or return
 * null.
 *
 * **Null is the safe answer and it is taken often.** A row with no derivable
 * period stays a `corporate_filing`, which costs nothing: the PDF is still
 * archived, still embedded, still searchable. A FABRICATED period costs a great
 * deal — `stock_documents` is `@@unique([symbol, exchange, docType, period])`,
 * so a wrong period files a company's quarter under a date it will keep
 * forever, and the downstream Gemini parse pipeline (which rejects rows with no
 * genuine period end by design) would then read a real statement against the
 * wrong quarter.
 *
 * The rules, in order:
 *
 *   1. Collect EVERY explicit `DD?MM?YYYY` in the subject.
 *   2. Keep only the ones that fall on the LAST DAY OF A MONTH. This is what
 *      separates a period end from a submission or board-meeting date —
 *      "Results submitted on 14/08/2026 for quarter ended 30/06/2026" keeps
 *      only the second — and it is also what makes the day-first convention
 *      safe, since a US-order misread lands on a month end only by accident.
 *   3. Prefer quarter-end months (Mar/Jun/Sep/Dec) when any candidate is one.
 *   4. Take the LATEST survivor. A results subject names the period it reports
 *      PLUS its comparatives, and a comparative is always EARLIER.
 *   5. Only if nothing survived, fall back to a named month with an
 *      "ended/ending" cue, restricted to quarter-end months.
 *   6. Cross-check `QUARTER_ID`; a decodable contradiction returns null.
 */
export function derivePeriodEnd(
  newssub: string | null | undefined,
  quarterId?: unknown,
): DerivedPeriodEnd | null {
  const text = String(newssub ?? "");
  if (!text.trim()) return null;

  // 1. Every explicit date.
  const explicit: Date[] = [];
  EXPLICIT_DATE_RE.lastIndex = 0;
  for (
    let m = EXPLICIT_DATE_RE.exec(text);
    m !== null;
    m = EXPLICIT_DATE_RE.exec(text)
  ) {
    const d = utcDate(Number(m[3]), Number(m[2]), Number(m[1]));
    if (d) explicit.push(d);
  }

  // 2 + 3. Month-end filter, then the quarter-end preference.
  let candidates = explicit.filter(isMonthEnd);
  const quarterEnds = candidates.filter((d) =>
    QUARTER_END_MONTHS.has(d.getUTCMonth() + 1),
  );
  if (quarterEnds.length > 0) candidates = quarterEnds;

  let picked: Date | null = null;
  let source: PeriodEndSource = "NEWSSUB_EXPLICIT_DATE";

  // 4. Latest survivor.
  for (const d of candidates) {
    if (picked === null || d.getTime() > picked.getTime()) picked = d;
  }

  // 5. Named-month fallback, cue-gated and quarter-end-only.
  if (picked === null && ENDED_CUE_RE.test(text)) {
    MONTH_NAME_YEAR_RE.lastIndex = 0;
    for (
      let m = MONTH_NAME_YEAR_RE.exec(text);
      m !== null;
      m = MONTH_NAME_YEAR_RE.exec(text)
    ) {
      const month = MONTH_NAME_TO_INDEX[(m[1] ?? "").toLowerCase()];
      const year = Number(m[2]);
      if (month === undefined || !QUARTER_END_MONTHS.has(month)) continue;
      const d = utcDate(year, month, daysInMonth(year, month));
      if (d && (picked === null || d.getTime() > picked.getTime())) {
        picked = d;
        source = "NEWSSUB_MONTH_NAME";
      }
    }
  }

  if (picked === null) return null;

  // 6. QUARTER_ID cross-check. Agreement corroborates; a decodable
  //    disagreement abandons the derivation entirely.
  const decoded = decodeQuarterId(quarterId);
  if (decoded !== null) {
    const sameMonth =
      decoded.getUTCFullYear() === picked.getUTCFullYear() &&
      decoded.getUTCMonth() === picked.getUTCMonth();
    if (!sameMonth) return null;
    return { date: picked, source, quarterIdCorroborated: true };
  }

  return { date: picked, source, quarterIdCorroborated: false };
}

// ---------------------------------------------------------------------------
// PERIOD LABEL — must live inside the timeline sorter's MEASURED vocabulary
// ---------------------------------------------------------------------------

/**
 * The `period` string a `quarterly_result` row is keyed and SORTED by.
 *
 * Month-name-of-quarter-end: `"Jun 2026"`, `"Mar 2026"`.
 *
 * This shape is not a preference, it is a constraint read off
 * `parseDocumentPeriod` (`@usemoney/core/market-data/docs-section-logic`),
 * which is what orders the stock-detail Documents timeline. That parser
 * recognises four shapes, most precise first: an ISO date, `Q3-2024`,
 * `Feb 2026`, and a bare year. A label OUTSIDE that vocabulary does not error —
 * it returns null, which routes the document to the unparseable-sorts-LAST
 * branch, so the row would exist and be invisible at the bottom of the
 * timeline forever.
 *
 * `Feb 2026` (MONTH_NAME_RE) was chosen over `Q1-2026` (QUARTER_RE) for a
 * reason the parser's own comment supplies: `periodLabel` elsewhere in this
 * repo mints the FY-END year, so `Q3-2026` denotes Oct-Dec **2025**, and a
 * quarter label would sort against a calendar-dated document by a year that
 * does not mean what it appears to. The quarter-END MONTH has no such
 * ambiguity — it is a calendar fact — and it round-trips through
 * `parseDocumentPeriod` to `kind: "month"` with the exact year and month.
 * The test asserts that round trip against the REAL parser rather than
 * restating the regex.
 */
export function quarterlyPeriodLabel(periodEnd: Date): string {
  const mmm = MONTH_ABBR[periodEnd.getUTCMonth()];
  return `${mmm} ${periodEnd.getUTCFullYear()}`;
}

/**
 * A stable `period` for an announcement that is NOT a results filing.
 *
 * Keyed on BSE's globally-unique news id so two filings on the same day for
 * the same scrip cannot collide, while a re-run of the SAME filing lands on
 * its own row and is skipped. Unchanged from MONEY-852 except that it now
 * lives where it can be tested.
 */
export function announcementPeriod(ann: BseAnnouncement): string {
  if (ann.newsId) return `bse-${ann.newsId}`;
  const d = ann.publishedAt ?? new Date(0);
  // The filing's IST day — MONEY-1536. `NEWS_DT` is IST wall-clock and is now
  // parsed as the instant it names, so a UTC slice would move a filing made
  // before 05:30 IST onto the day before; the IST day is what the Cloud Run
  // (UTC) parse always produced. Measured 2026-09-23: 0 of 19,734 stored BSE
  // announcement keys use this fallback (every live row carries a NEWSID).
  const stamp = toIstDateKey(d).replace(/-/g, "");
  let h = 0;
  for (let i = 0; i < ann.title.length; i++) {
    h = (Math.imul(h, 31) + ann.title.charCodeAt(i)) >>> 0;
  }
  return `bse-${stamp}-${h.toString(36)}`;
}

// ---------------------------------------------------------------------------
// CLASSIFICATION
// ---------------------------------------------------------------------------

export interface BseClassification {
  docType: StockDocType;
  period: string;
  /** Null for every `corporate_filing`; set for every `quarterly_result`. */
  periodEnd: Date | null;
  /** Why this row landed where it did — logged, and asserted in tests. */
  reason:
    | "result-with-period"
    | "result-without-period"
    | "not-a-result-category";
  periodEndSource: PeriodEndSource | null;
}

/**
 * Decide a BSE announcement's docType + period.
 *
 * A row is a `quarterly_result` when BOTH hold:
 *   - its CATEGORY is one of {@link BSE_RESULT_CATEGORIES}, and
 *   - a period end is DERIVABLE from its subject line.
 *
 * Everything else is a `corporate_filing`. The conjunction matters in both
 * directions. Category alone is not enough — the "Result" category carries
 * board-meeting outcomes and re-submissions whose subject names no period —
 * and a period alone is not enough, because plenty of non-results subjects
 * contain a month-end date.
 */
export function classifyBseAnnouncement(
  ann: BseAnnouncement,
  quarterId?: unknown,
): BseClassification {
  const isResultCategory = BSE_RESULT_CATEGORIES.some(
    (c) => c.toLowerCase() === (ann.category ?? "").trim().toLowerCase(),
  );
  if (!isResultCategory) {
    return {
      docType: BSE_DOC_TYPE_CORPORATE_FILING,
      period: announcementPeriod(ann),
      periodEnd: null,
      reason: "not-a-result-category",
      periodEndSource: null,
    };
  }

  const derived = derivePeriodEnd(ann.title, quarterId);
  if (derived === null) {
    return {
      docType: BSE_DOC_TYPE_CORPORATE_FILING,
      period: announcementPeriod(ann),
      periodEnd: null,
      reason: "result-without-period",
      periodEndSource: null,
    };
  }

  return {
    docType: BSE_DOC_TYPE_QUARTERLY_RESULT,
    period: quarterlyPeriodLabel(derived.date),
    periodEnd: derived.date,
    reason: "result-with-period",
    periodEndSource: derived.source,
  };
}

/** The docType a row's GCS OBJECT PATH must be built under — the same value
 *  the row itself carries. See {@link BSE_DOC_TYPE_CORPORATE_FILING}. */
export function bseDocTypeFor(classification: BseClassification): StockDocType {
  return classification.docType;
}

// ---------------------------------------------------------------------------
// THE BREADCRUMB — XML_NAME + the superseded attachment, on the row
// ---------------------------------------------------------------------------

/**
 * Marker that opens the machine-readable tail of a BSE `description`.
 *
 * `StockDocument` has no column for BSE's `XML_NAME`, and adding one is a
 * schema change owned elsewhere. This encodes it (and the attachment name, the
 * news id, and the category pair) as a deterministic single line appended to
 * `description`, so the breadcrumb survives on the row and can be read back
 * with {@link parseBseDocumentBreadcrumb} rather than with a regex each
 * consumer invents for itself.
 */
export const BSE_BREADCRUMB_PREFIX = "bse-meta ";

/** Characters that would break the `k=v;` encoding, stripped from values. */
function breadcrumbSafe(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/[;\r\n=]+/g, " ")
    .trim();
}

export interface BseBreadcrumb {
  xmlName: string;
  attachment: string;
  newsId: string;
  category: string;
  subcategory: string;
  /** Attachment names this row previously pointed at, oldest first. */
  superseded: string[];
}

/** Cap on the retained supersession trail. A revision chain longer than this
 *  is a story the row does not need to tell in full, and an unbounded list on
 *  a `String?` column is a column that grows without limit. */
export const MAX_SUPERSEDED_TRAIL = 5;

/**
 * Build the `description` for a BSE `StockDocument` row.
 *
 * Human text first (whatever BSE gave us, else the category pair), then the
 * breadcrumb line. On a D-v "latest wins" upsert the attachment being REPLACED
 * is carried into `superseded`, so a revision is auditable from the row alone:
 * without it, `latest wins` silently destroys the only pointer to the
 * superseded PDF.
 */
export function buildBseDocumentDescription(input: {
  ann: BseAnnouncement;
  /** The row's PREVIOUS description, when upserting over an existing row. */
  previousDescription?: string | null;
  /** The attachment name being replaced, when this write supersedes one. */
  supersededAttachment?: string | null;
}): string {
  const { ann } = input;
  const human =
    breadcrumbSafe(ann.description) ||
    [ann.category, ann.subcategory].filter(Boolean).join(" / ") ||
    "";

  const prior = parseBseDocumentBreadcrumb(input.previousDescription);
  const superseded = [...(prior?.superseded ?? [])];
  const replacing = breadcrumbSafe(input.supersededAttachment);
  if (replacing && !superseded.includes(replacing)) superseded.push(replacing);
  while (superseded.length > MAX_SUPERSEDED_TRAIL) superseded.shift();

  const attachment = attachmentNameFromUrl(ann.pdfUrl);
  const fields = [
    `xml=${breadcrumbSafe(ann.xmlName)}`,
    `attach=${attachment}`,
    `newsid=${breadcrumbSafe(ann.newsId)}`,
    `cat=${breadcrumbSafe(ann.category)}`,
    `sub=${breadcrumbSafe(ann.subcategory)}`,
    ...(superseded.length > 0 ? [`superseded=${superseded.join(",")}`] : []),
  ].join(";");

  return `${human ? `${human}\n` : ""}${BSE_BREADCRUMB_PREFIX}${fields}`;
}

/**
 * BSE serves attachments from TWO directories, and which one is live depends on
 * the filing's AGE — MONEY-1258.
 *
 *     .../corpfiling/AttachLive/<file>   recent filings
 *     .../corpfiling/AttachHis/<file>    everything older
 *
 * `parseBseAnnouncementRow` builds `pdfUrl` against `AttachLive`
 * unconditionally, which is right for the nightly job (it walks the last few
 * days) and wrong for every historical walk. Measured 2026-08-27 on two real
 * 2025 filings:
 *
 *     AttachLive/e77330e4-….pdf   HTTP 404, 8,406 bytes
 *     AttachHis /e77330e4-….pdf   HTTP 200, 4,376,543 bytes
 *     AttachLive/a6d73f10-….pdf   HTTP 404, 8,406 bytes
 *     AttachHis /a6d73f10-….pdf   HTTP 200,   738,768 bytes
 *
 * The backfill therefore 404'd on EVERY attachment and wrote rows with
 * `gcsPath: ""`, which the parse lane terminal-FAILs. It reported a clean
 * summary because the download sits in a best-effort catch.
 *
 * NOTE the 404 body is 8,406 bytes of HTML — comfortably over `MIN_PDF_BYTES`
 * (1,000). Only the `res.ok` check stands between that and storing error pages
 * as PDFs, so callers MUST keep checking the status and not just the length.
 *
 * ## Why ordered rather than "always try both"
 *
 * Both are returned so a caller can fall through, but the LIKELY one comes
 * first: at ~4,500 attachments a wrong-first guess is ~4,500 extra requests
 * against a host that rate-limits and has 429'd us before (MONEY-853). Age is
 * the discriminator BSE itself uses.
 *
 * An unknown `publishedAt` orders LIVE first — that is the nightly job's case,
 * and it is the one where an extra request costs the most relative to the work
 * being done.
 */
/**
 * How this run should confirm a write — MONEY-1258.
 *
 * ## Why the TTY guard exists
 *
 * `--apply` writes to prod and uploads to GCS. The prompt is a deliberate
 * anti-wrapper guard: an unattended caller must not be able to apply, and a
 * PROMPT ON A CLOSED STDIN IS WORSE THAN A REFUSAL — it hangs, then exits 0,
 * which a wrapper's `&&` reads as success.
 *
 * ## Why a Cloud Run JOB is different
 *
 * The full 2015-2025 walk is ~30 hours (61,800 filings x 1.5s of PDF pacing
 * plus 4.8h of index pacing). That cannot run on a laptop: this repo already
 * lost two runs to machine sleep (see `setup-xbrl-backfill-job.sh`). It belongs
 * on a Cloud Run Job, which has no TTY by construction.
 *
 * The guard's PURPOSE still holds there. What it defends against is a write
 * nobody chose; `gcloud run jobs execute bse-backfill-prod --args=--apply,...`
 * is a human choosing, exactly as much as typing "yes". `xbrl-reparse` is the
 * existing precedent — it takes `--apply` on Cloud Run with no prompt at all.
 *
 * ## Why `CLOUD_RUN_JOB` specifically
 *
 * Cloud Run sets it in the job container and nothing else does. It is NOT a
 * flag: there is deliberately no `--yes`, because a flag is exactly what a
 * wrapper would learn to pass. An operator who exports `CLOUD_RUN_JOB` locally
 * to skip the prompt has gone out of their way to defeat a guard, which no
 * mechanism prevents and which is not the failure mode this defends against.
 */
export type ApplyConfirmation = "prompt" | "cloud-run-job" | "refuse";

export function resolveApplyConfirmation(input: {
  isTTY: boolean;
  cloudRunJob?: string | undefined;
}): ApplyConfirmation {
  if (input.cloudRunJob) return "cloud-run-job";
  return input.isTTY ? "prompt" : "refuse";
}

/**
 * The BSE historical walk, split into executions that fit — MONEY-1258.
 *
 * ONE YEAR PER SHARD, measured rather than estimated.
 *
 * The first sizing used three-year shards on the theory that per-filing cost is
 * `PDF_PACE_MS` (1500ms). It is not: the attachments average 5.7 MB, so the
 * DOWNLOAD dominates. Measured over 742 stored filings across 299 symbols in
 * 118 minutes of a real run:
 *
 *     9.5 s per filing        (6x the pace alone)
 *     23.6 s per symbol
 *     2.48 filings per symbol-year
 *
 *     1-year shard over 2,255 symbols  ~= 14.8 h
 *     3-year shard                     ~= 38 h    <- over the 24h task cap
 *
 * A shard that overruns is not merely slow. Cloud Run kills the task, and a
 * killed task CANNOT publish its follow-up — so the chain stalls with no error
 * and no next execution, which is the failure shape this whole ticket has been
 * about. One year fits with ~9h of headroom even at the laptop bandwidth this
 * was measured on; Cloud Run's egress should be faster, and being early is free
 * while being late costs the chain.
 *
 * Newest first, because that is the order the data becomes useful: ~19 of the
 * 26 owned StockRatios columns need only the latest annual period, and the
 * Financials tab reads most-recent-first.
 *
 * 2025 is absent: the interactive shard covers it. Add it to the head if that
 * run did not complete.
 */
export interface BseShard {
  fromYear: number;
  toYear: number;
}

export const BSE_SHARD_PLAN: readonly BseShard[] = Object.freeze([
  { fromYear: 2024, toYear: 2024 },
  { fromYear: 2023, toYear: 2023 },
  { fromYear: 2022, toYear: 2022 },
  { fromYear: 2021, toYear: 2021 },
  { fromYear: 2020, toYear: 2020 },
  { fromYear: 2019, toYear: 2019 },
  { fromYear: 2018, toYear: 2018 },
  { fromYear: 2017, toYear: 2017 },
  { fromYear: 2016, toYear: 2016 },
  { fromYear: 2015, toYear: 2015 },
]);

/**
 * The shard that follows this one, or null at the end of the plan.
 *
 * Matched on BOTH years, not just `fromYear`. A partial match would let an
 * operator's ad-hoc window (`--from-year=2022 --to-year=2022`) silently adopt
 * the plan's successor and walk years nobody asked for.
 *
 * A window that is not in the plan returns null — an ad-hoc run does not chain.
 * That is the safe direction: chaining is for the known sequence, and inventing
 * a successor for an unknown window is how a one-off probe turns into a
 * 30-hour walk.
 */
export function nextShard(current: BseShard): BseShard | null {
  const i = BSE_SHARD_PLAN.findIndex(
    (s) => s.fromYear === current.fromYear && s.toYear === current.toYear,
  );
  if (i < 0 || i + 1 >= BSE_SHARD_PLAN.length) return null;
  return BSE_SHARD_PLAN[i + 1] ?? null;
}

/**
 * The argv a shard execution takes — MONEY-1261.
 *
 * SPACE-SEPARATED, never `--flag=value`. `backfill-bse-results.ts` REJECTS the
 * equals form outright:
 *
 *     Use "--flag value", not "--sample=2". The equals form is not parsed, and
 *     an unparsed --env would leave APPLY mode pointed at the ambient
 *     DATABASE_URL.
 *
 * That guard is correct and load-bearing — an unparsed `--env` silently aims an
 * APPLY run at whatever DATABASE_URL happens to be in scope.
 *
 * Both producers of these args got it WRONG on the first pass: the chain
 * trigger emitted `--from-year=2024` and the setup script printed
 * `--args=--apply,--from-year=2024,...`. Every chain link and the very first
 * manual trigger would have exited 1 within seconds. Caught by executing
 * `--probe` in Cloud Run before triggering the real 15h shard; nothing in the
 * type system or the tests would have said a word, because both sides agreed
 * with each other and disagreed with the parser.
 *
 * It lives here, exported, so the two producers cannot drift apart again and so
 * the format can be asserted against the parser's own rule.
 */
export function buildShardArgs(shard: BseShard): string[] {
  return [
    "--apply",
    "--from-year",
    String(shard.fromYear),
    "--to-year",
    String(shard.toYear),
  ];
}

/**
 * The parser's rejection rule, restated so a test can apply it — MONEY-1261.
 *
 * Mirrors `assertNoEqualsForm` in backfill-bse-results.ts. Duplicated rather
 * than imported ONLY because that module calls `main()` at load and cannot be
 * imported; a test asserts the two regexes stay identical.
 */
export const BSE_EQUALS_FORM = /^--[a-z-]+=/;

/** Why a shard did NOT chain — every value is a distinct, reportable reason. */
export type ChainDecision =
  | "chain"
  | "not-a-job"
  | "rate-limited"
  | "breaker-tripped"
  | "no-attachments"
  | "plan-complete";

/**
 * Should this shard trigger the next one?
 *
 * ## Why chaining is guarded rather than unconditional
 *
 * This walk FETCHES — one index call per company plus one download per filing,
 * against a host that rate-limits and has 429'd this repo before (MONEY-853).
 * `stock-document-sync` already established the rule and the reason: a run that
 * circuit-broke on a 429 does NOT chain, because the limiter state is PER RUN
 * and a fresh link re-arms the breaker straight back into the tarpit.
 *
 * Applied here the stakes are higher, because a shard is ~9-12h. Chaining after
 * a block would spend another half-day being refused, unattended, and the
 * evidence would be a log nobody is reading.
 *
 * ## The four refusals
 *
 *   - `rate-limited`    a 429 broke the walk. The next shard would meet the
 *                       same block.
 *   - `breaker-tripped` CONSECUTIVE_FAILURE_BREAKER fired: something is wrong
 *                       upstream and it is not one bad scrip.
 *   - `no-attachments`  filings were offered and NONE stored. That is the
 *                       MONEY-1258 signature — missing GCS config, or a
 *                       directory rotation we do not handle. Chaining would
 *                       repeat it for another ~20 hours.
 *   - `not-a-job`       an interactive run never chains. A laptop shard is a
 *                       deliberate short action; turning it into a 30-hour
 *                       sequence is precisely what an operator did not ask for.
 *
 * Terminating is structural, not a matter of luck: the plan is a fixed array
 * and `nextShard` only ever walks FORWARD from a matched entry, so a chain is
 * at most `BSE_SHARD_PLAN.length - 1` links whatever the data does.
 */
export function shouldChainShard(input: {
  current: BseShard;
  inCloudRunJob: boolean;
  rateLimited: boolean;
  breakerTripped: boolean;
  attachmentsOffered: number;
  attachmentsStored: number;
}): { decision: ChainDecision; next: BseShard | null } {
  const next = nextShard(input.current);
  if (!input.inCloudRunJob) return { decision: "not-a-job", next };
  if (input.rateLimited) return { decision: "rate-limited", next };
  if (input.breakerTripped) return { decision: "breaker-tripped", next };
  if (input.attachmentsOffered > 0 && input.attachmentsStored === 0) {
    return { decision: "no-attachments", next };
  }
  if (!next) return { decision: "plan-complete", next: null };
  return { decision: "chain", next };
}

export const BSE_ATTACH_LIVE_DIR = "AttachLive";
export const BSE_ATTACH_HIST_DIR = "AttachHis";

/**
 * How recent a filing must be for `AttachLive` to be the better first guess.
 *
 * Not a claim about BSE's exact rotation, which is unpublished — it is the
 * ordering heuristic only. Both URLs are always returned, so being wrong costs
 * ONE extra request and never a missed attachment.
 */
export const BSE_ATTACH_LIVE_WINDOW_DAYS = 30;

/**
 * Candidate attachment URLs, most-likely first. Empty when there is no URL.
 *
 * Pure: `now` is injected rather than read, so the ordering is testable.
 */
export function bseAttachmentCandidates(
  pdfUrl: string | null | undefined,
  publishedAt?: Date | null,
  now: Date = new Date(),
): string[] {
  if (!pdfUrl) return [];
  const live = pdfUrl.replace(
    `/${BSE_ATTACH_HIST_DIR}/`,
    `/${BSE_ATTACH_LIVE_DIR}/`,
  );
  const hist = pdfUrl.replace(
    `/${BSE_ATTACH_LIVE_DIR}/`,
    `/${BSE_ATTACH_HIST_DIR}/`,
  );
  // Same string on both sides means the URL matched neither directory — an
  // unrecognised shape. Return it ALONE rather than inventing a sibling.
  if (live === hist) return [pdfUrl];

  const ts = publishedAt instanceof Date ? publishedAt.getTime() : NaN;
  if (!Number.isFinite(ts)) return [live, hist];
  const ageDays = (now.getTime() - ts) / 86_400_000;
  return ageDays > BSE_ATTACH_LIVE_WINDOW_DAYS ? [hist, live] : [live, hist];
}

/** The bare file name of a BSE attachment URL (`…/AttachLive/<name>`). */
export function attachmentNameFromUrl(url: string | null | undefined): string {
  const s = String(url ?? "").trim();
  if (!s) return "";
  const last = s.split("/").pop() ?? "";
  return breadcrumbSafe(last.split("?")[0]);
}

/** Read back a breadcrumb written by {@link buildBseDocumentDescription}. */
export function parseBseDocumentBreadcrumb(
  description: string | null | undefined,
): BseBreadcrumb | null {
  const text = String(description ?? "");
  const at = text.lastIndexOf(BSE_BREADCRUMB_PREFIX);
  if (at < 0) return null;
  const tail =
    text.slice(at + BSE_BREADCRUMB_PREFIX.length).split("\n")[0] ?? "";
  const out: Record<string, string> = {};
  for (const part of tail.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (Object.keys(out).length === 0) return null;
  return {
    xmlName: out.xml ?? "",
    attachment: out.attach ?? "",
    newsId: out.newsid ?? "",
    category: out.cat ?? "",
    subcategory: out.sub ?? "",
    superseded: (out.superseded ?? "").split(",").filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// HEALTH — the verdict that makes this defect impossible to repeat
// ---------------------------------------------------------------------------

export interface BseAnnouncementsHealth {
  healthy: boolean;
  /** Always present, always carries the per-category counts. */
  reason: string;
  /** Categories that returned zero rows and did NOT fail. */
  emptyCategories: string[];
}

/** `Result=12 Board Meeting=0 …` — the per-category census, one line. */
export function summarizeCategoryCounts(
  byCategory: readonly BseCategoryOutcome[],
): string {
  if (byCategory.length === 0) return "no categories queried";
  return byCategory
    .map(
      (c) =>
        `${c.category}=${c.count}` +
        (c.stop === "failed" ? "(FAILED)" : "") +
        (c.stop === "maxPages" ? "(CAPPED)" : ""),
    )
    .join(" ");
}

/**
 * Judge a run's fetch. **Zero across every category is UNHEALTHY, not idle.**
 *
 * ## The condition, and why it is unconditional
 *
 * `bse-announcements-sync` produced `selected: 0, written: 0` on every run for
 * its whole life and no monitor could fire, because
 * `monitor-zero-write.json`'s own truth table lists `0 selected / 0 written`
 * as the GENUINELY IDLE row — deliberately silent. For a job that reads a
 * whole-market feed, idle is not a state that exists: BSE takes hundreds of
 * filings a day across these nine categories, so zero from all nine is a
 * broken query, a blocked egress or a renamed category, never a quiet market.
 * A per-job "is idle plausible here" answer is the only thing that separates
 * the two, and it belongs next to the job.
 *
 * Deliberately NOT thresholded on the window length. A one-day window on a
 * market holiday is the closest thing to a legitimate all-zero run, and it is
 * still worth a warning: the job is scheduled Mon-Fri and a holiday is a
 * knowable, occasional false positive, whereas the failure it catches is
 * permanent and silent. The reason string names the window so an operator can
 * dismiss it in one read.
 *
 * A SINGLE empty category is NOT unhealthy — "New Listing" over a two-day
 * window is genuinely often zero — but every empty category is NAMED, because
 * one silently-empty category is what a near-miss `strCat` spelling looks like
 * and it is far harder to see than the whole-job version was.
 */
export function judgeBseAnnouncementsHealth(input: {
  byCategory: readonly BseCategoryOutcome[];
  transportFailures: number;
  windowDays: number;
}): BseAnnouncementsHealth {
  const { byCategory, transportFailures, windowDays } = input;
  const census = summarizeCategoryCounts(byCategory);
  const emptyCategories = byCategory
    .filter((c) => c.count === 0 && c.stop !== "failed")
    .map((c) => c.category);

  if (byCategory.length === 0) {
    return {
      healthy: false,
      reason: `no category was queried — the category list was empty (${census})`,
      emptyCategories,
    };
  }

  const total = byCategory.reduce((n, c) => n + c.count, 0);

  if (transportFailures >= byCategory.length) {
    return {
      healthy: false,
      reason:
        `every one of ${byCategory.length} category walks FAILED over a ` +
        `${windowDays}-day window — upstream is not answering: ${census}`,
      emptyCategories,
    };
  }

  if (total === 0) {
    return {
      healthy: false,
      reason:
        `0 announcements across ALL ${byCategory.length} categories over a ` +
        `${windowDays}-day window — a whole-market feed is never idle, so ` +
        `this is a broken query, a blocked egress or a renamed category, ` +
        `NOT a quiet market: ${census}`,
      emptyCategories,
    };
  }

  if (transportFailures > 0) {
    return {
      healthy: false,
      reason:
        `${transportFailures} of ${byCategory.length} category walks failed ` +
        `(${total} announcements from the rest): ${census}`,
      emptyCategories,
    };
  }

  return {
    healthy: true,
    reason:
      `${total} announcements over a ${windowDays}-day window: ${census}` +
      (emptyCategories.length > 0
        ? ` — empty: ${emptyCategories.join(", ")}`
        : ""),
    emptyCategories,
  };
}

/** Whole days between two window bounds, floor 1. Used only for the reason
 *  string, so a same-day window reads as "1-day" rather than "0-day". */
export function windowDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms)) return 1;
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
}

// ---------------------------------------------------------------------------
// MONEY-1285 — THE FOUR MECHANISMS THAT LEFT 2,339 FILINGS WITHOUT THEIR PDF
// ---------------------------------------------------------------------------

/**
 * Should this announcement be WRITTEN, and if so why — MONEY-1285.
 *
 * ## The measurement
 *
 * Prod, 2026-08-30, `stock_documents` where `sourceType: "BSE"`:
 *
 *     docType             rows     with bytes   gcsPath: ""
 *     corporate_filing    4,268     1,929        2,339
 *     quarterly_result   30,956    27,170        3,786
 *
 * The quarterly 3,786 are pre-2018 filings BSE no longer serves at all (the
 * retention table in the root `CLAUDE.md`) and are not recoverable. The
 * `corporate_filing` 2,339 are **from the last four days**, and BSE is serving
 * those attachments right now. They were unreachable for a reason that lived
 * in the control flow rather than in the data.
 *
 * ## Why they were stranded
 *
 * The processor's skip read, in full:
 *
 *     if (existing && !isQuarterly) { skippedExisting++; continue; }
 *
 * and the `existingHasBytes` arm four lines below it — the one whose own
 * comment says a row with `gcsPath: ""` is terminal-FAILed by the parse lane
 * on its first `downloadFromGCS("")`, so skipping it "strands that
 * company-quarter permanently" — was gated on `isQuarterly` and therefore
 * never ran for a `corporate_filing`.
 *
 * A `corporate_filing`'s period is `bse-{newsId}`, which is globally unique per
 * filing, so the existing row ALWAYS matches on a re-run. The comment named the
 * exact failure and the branch it protected could not see it. That is why this
 * decision is now ONE function covering BOTH docTypes: the bytes test is the
 * rule, and `isQuarterly` only decides whether a CHANGED attachment supersedes.
 *
 * ## The four outcomes
 *
 *     write-new           no row exists yet
 *     write-retry-bytes   a row exists with NO bytes — the 2,339
 *     write-superseding   a quarterly row exists under a DIFFERENT attachment
 *                         (founder decision D-v, latest wins)
 *     skip-has-bytes      the row already carries its PDF; nothing to do
 *
 * `skip-has-bytes` is the ONLY skip. Every other outcome attempts the download.
 */
export type BseWriteDecision =
  | "write-new"
  | "write-retry-bytes"
  | "write-superseding"
  | "skip-has-bytes";

export interface BseExistingRow {
  /** Empty string when the attachment never archived. */
  gcsPath: string;
  /** 0 when the attachment never archived. */
  fileSize: number;
}

export function decideBseAnnouncementWrite(input: {
  existing: BseExistingRow | null;
  isQuarterly: boolean;
  /** Attachment name the STORED row points at. */
  priorAttachment: string;
  /** Attachment name this announcement carries. */
  incomingAttachment: string;
}): BseWriteDecision {
  const { existing, isQuarterly, priorAttachment, incomingAttachment } = input;
  if (!existing) return "write-new";

  // A quarterly row keyed on the QUARTER may be a different, earlier filing.
  // A changed attachment is a revision and wins regardless of bytes — carrying
  // the superseded name into the breadcrumb is what makes it auditable.
  if (isQuarterly && priorAttachment !== incomingAttachment) {
    return "write-superseding";
  }

  // THE RULE, and it is docType-independent: bytes present means done.
  const hasBytes = Boolean(existing.gcsPath) && existing.fileSize > 0;
  return hasBytes ? "skip-has-bytes" : "write-retry-bytes";
}

/** True when the decision means "attempt the attachment and upsert the row". */
export function bseDecisionWrites(decision: BseWriteDecision): boolean {
  return decision !== "skip-has-bytes";
}

/**
 * Round-robin one flat announcement list across its categories — MONEY-1285.
 *
 * ## Why the order was the whole bug
 *
 * `BseAnnouncementsFetch.announcements` is documented as "every row from every
 * category, in category order", and `MAX_PDF_DOWNLOADS_PER_RUN = 500` binds on
 * every run (three post-fix prod runs each archived EXACTLY 500). A cap applied
 * to a category-major list does not sample the window — it takes a PREFIX of
 * it, and the prefix is the same categories every single night.
 *
 * The categories are queried in this fixed order:
 *
 *     0 AGM/EGM              ~100% complete
 *     1 Board Meeting        ~100% complete
 *     2 Company Update       partial
 *     3 Corp. Action         100% byte-less
 *     4 Insider Trading/SAST 100% byte-less
 *     5 New Listing          100% byte-less
 *     6 Result               100% byte-less
 *     7 Integrated Filing
 *     8 Others               100% byte-less
 *
 * That is not a coincidence to be explained, it is the cap read off the data:
 * the split falls exactly where 500 downloads run out. Five categories were not
 * failing to download — they were never REACHED.
 *
 * ## Why here and not in the client
 *
 * The client's job is to report what each category walk produced, and
 * `byCategory` is the health signal `judgeBseAnnouncementsHealth` reads. The
 * ORDER a consumer spends its download budget in is the consumer's decision.
 * Interleaving in the client would also silently re-order the backfill script's
 * per-scrip walks, which have no cap and no reason to change.
 *
 * ## Determinism is load-bearing
 *
 * The self-chain resumes by INDEX into this permutation, so it must be a pure
 * function of the input list: groups in first-seen order, original order kept
 * inside each group, one row from each group per pass. Same input, same output,
 * every link.
 */
export function interleaveByCategory<T>(
  items: readonly T[],
  categoryOf: (item: T) => string,
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = categoryOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  const buckets = [...groups.values()];
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) {
    let placed = false;
    for (const bucket of buckets) {
      const item = bucket[round];
      if (item !== undefined) {
        out.push(item);
        placed = true;
      }
    }
    // Defensive: an `undefined` MEMBER of the input would otherwise spin here.
    // The loop must terminate on the input's length, never on its contents.
    if (!placed) break;
  }
  return out;
}

/**
 * Wall-clock budget for one run — MONEY-1285.
 *
 * Runs take **19-21 minutes** today against a **600s** Pub/Sub ack deadline
 * (Pub/Sub's maximum; Cloud Run's 3600s never binds). That is not a slow job,
 * it is a job Pub/Sub REDELIVERS while the first copy is still running — a
 * second concurrent walk of the same window, downloading the same attachments,
 * every night.
 *
 *   600s  ack deadline
 *  -420s  BSE_RUN_TIME_BUDGET_MS — no NEW announcement is started past this
 *  ------
 *   180s  headroom, which absorbs, in order:
 *
 *   ~62s  the ONE announcement in flight when the budget expires. The check is
 *         BETWEEN announcements, so the true wall is `budget + one item`. Worst
 *         case is BOTH attachment candidates timing out at the 30s
 *         `AbortSignal.timeout` in `archivePdf`, plus a GCS upload of a ~5.7 MB
 *         average attachment. Note this term is genuinely BOUNDED here, unlike
 *         `stock-document-extract`, whose Document AI call carries no
 *         client-side timeout at all.
 *    ~2s  the 1500ms inter-download pace that precedes it.
 *    ~1s  reportJobOutcome + the ONE chain publish, both in the `finally`.
 *   ----
 *   ~65s  used, ~115s spare.
 *
 * The index walk is NOT in that headroom, deliberately: the clock starts at the
 * top of the run, so the nine category walks are spent out of the 420s like any
 * other work. Starting it at the download loop would leave the index unbounded,
 * which is the term most likely to blow up when BSE is slow.
 *
 * 420s is the same wall `stock-document-extract` and `mf-nav-backfill` stop on.
 *
 * **`DELAY_BETWEEN_DOWNLOADS_MS` is NOT the lever.** Cutting the 1500ms pace
 * would buy throughput by spending the 429 headroom on a host that has already
 * 429'd this repo (MONEY-853), trading an ack-deadline overrun for a block.
 */
export const BSE_RUN_TIME_BUDGET_MS = 420_000;

/**
 * Hard ceiling on how many times one trigger may re-publish itself.
 *
 * THE TERMINATION PROOF LIVES HERE and it consults no database, clock or queue:
 * every published follow-up carries `chainDepth + 1`, and
 * {@link shouldChainBseAnnouncements} refuses once the NEXT depth would reach
 * this value. So a chain is at most `BSE_MAX_CHAIN_DEPTH` messages long
 * whatever the window contains. Every other stop condition can only end it
 * SOONER, so none of them can break the bound.
 *
 * Sizing: ~2.3s per download measured on prod (500 attachments inside a 19-21
 * minute run), so ~165 downloads fit a 420s link once the index walk is paid.
 * 10 links x 420s = 70 minutes from the 21:30 IST trigger, landing before
 * 22:45, and ~1,650 attachments a night against today's flat 500.
 *
 * Ten rather than `stock-document-extract`'s twenty because each link
 * RE-WALKS the nine-category index — ~45 requests against a host that
 * rate-limits — where that job's follow-up costs one indexed `findMany`.
 * The 2,339-row corporate_filing backlog clears in ~2 nights at this rate.
 */
export const BSE_MAX_CHAIN_DEPTH = 10;

/**
 * Sanitise a `chainDepth` carried on an inbound Pub/Sub payload.
 *
 * The value is `unknown` until proven otherwise: missing, negative, fractional,
 * NaN or absurd must not be able to buy extra links. Anything that is not a
 * finite non-negative number reads as depth 0, and anything above the ceiling
 * clamps TO the ceiling — so a forged large value ENDS the chain rather than
 * wrapping it.
 */
export function normalizeBseChainDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), BSE_MAX_CHAIN_DEPTH);
}

/**
 * Sanitise a `resumeIndex` carried on an inbound Pub/Sub payload.
 *
 * Unclamped at the top end on purpose — an index past the end of the list
 * yields an EMPTY slice, which is a correct no-op run, where clamping it to the
 * last element would re-process one announcement forever.
 */
export function normalizeBseResumeIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/** True while the run may start ANOTHER announcement. Pure: the caller passes
 *  both clock readings, so the budget is testable without waiting. */
export function isWithinBseRunBudget(
  startedAtMs: number,
  nowMs: number,
  budgetMs: number = BSE_RUN_TIME_BUDGET_MS,
): boolean {
  return nowMs - startedAtMs < budgetMs;
}

/** Why a run did or did not publish a follow-up. Every value is reportable. */
export type BseChainReason =
  | "chain"
  | "rate-limited"
  | "fetch-failed"
  | "depth-exhausted"
  | "window-drained"
  | "no-progress";

/**
 * Should this run publish ONE follow-up message?
 *
 * Called exactly once per run, from the `finally`, so a chain link is a RUN and
 * never an item. The refusals, and what each is holding back:
 *
 *   - `rate-limited`    BSE's index or attachment host 429'd. Limiter state is
 *                       PER RUN, so a fresh link re-arms the breaker straight
 *                       back into the tarpit — the rule `stock-document-sync`
 *                       and `shouldChainShard` already established.
 *   - `fetch-failed`    the index walk itself did not run. There is nothing to
 *                       resume INTO; the daily cron retries tomorrow.
 *   - `depth-exhausted` the bound above.
 *   - `window-drained`  every announcement in the window was consumed.
 *   - `no-progress`     this link consumed ZERO announcements while work
 *                       remained — the index walk ate the whole budget. A
 *                       follow-up would resume at the identical index and do
 *                       the identical nothing, which is the runaway-poll shape.
 */
export function shouldChainBseAnnouncements(input: {
  chainDepth: number;
  /** Announcements after this run's stopping point. */
  remaining: number;
  /** Announcements this run actually handled — the forward-progress signal. */
  consumed: number;
  rateLimited: boolean;
  fetchFailed: boolean;
}): { chain: boolean; reason: BseChainReason } {
  if (input.rateLimited) return { chain: false, reason: "rate-limited" };
  if (input.fetchFailed) return { chain: false, reason: "fetch-failed" };
  if (input.chainDepth + 1 >= BSE_MAX_CHAIN_DEPTH) {
    return { chain: false, reason: "depth-exhausted" };
  }
  if (input.remaining <= 0) return { chain: false, reason: "window-drained" };
  if (input.consumed <= 0) return { chain: false, reason: "no-progress" };
  return { chain: true, reason: "chain" };
}

/**
 * `"20260830"` -> `"2026-08-30"`, or null when the input is not that shape.
 *
 * The follow-up message must carry the EFFECTIVE window — the one left after
 * `clampBseWindowEnd` and any future-date step-backs — because `resumeIndex` is
 * an index into the ordering THAT window produced. Forwarding the REQUESTED
 * window would re-pay the step-back requests and, if the step-back count
 * differed, resume into a different list.
 *
 * `BseAnnouncementsFetch.window` reports it in BSE's compact form; the message
 * takes ISO. Null (rather than a guess) when the shape is unrecognised, so the
 * caller falls back to its own resolved dates instead of publishing a window
 * BSE will reject.
 */
export function bseCompactToIsoDate(compact: string): string | null {
  if (!/^\d{8}$/.test(compact)) return null;
  const year = compact.slice(0, 4);
  const month = compact.slice(4, 6);
  const day = compact.slice(6, 8);
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (Number(day) < 1 || Number(day) > 31) return null;
  return `${year}-${month}-${day}`;
}
