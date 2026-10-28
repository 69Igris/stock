/**
 * Pure read-side helpers for the stock page's DOCUMENT-backed sections —
 * MONEY-1204 (P14 / 14c.7 · 14c.8 · 14c.9).
 *
 * Three surfaces share this module:
 *
 *   14c.7  filings & documents timeline  ← `stock_documents` + `upcoming_events`
 *   14c.8  financials source badge       ← `stock_financials.source`
 *          + basis / cumulative toggle   ← `xbrl_filings`
 *   14c.9  funds holding this stock      ← `mf_portfolio_holdings` (INVERSE)
 *
 * Everything here is a PURE function over rows the service already fetched: no
 * Prisma, no network, no clock (the clock arrives as an argument). That is what
 * makes the judgement calls below testable, because each is a place where the
 * obvious implementation is quietly wrong:
 *
 * 1. **`StockDocument` has NO filing-date column.** Only `period` (free-form:
 *    `"2024"`, `"Q3-2024"`, and for announcements `"nse-{seq_id}"` — not a date
 *    at all) and `fetchedAt`, which every writer sets to `new Date()` at ingest
 *    (`workers/src/processors/nse-announcements-sync.ts:421`, `bse-…:323`,
 *    `annual-reports-sync.ts:421`). The surfaced field is therefore `indexedAt`,
 *    never `filedAt` — calling ingest time a filing date would put a 2019 annual
 *    report at the top of the timeline the day a backfill runs.
 *
 *    ORDER, however, leads with `period` rather than `indexedAt` (MONEY-1255).
 *    Ingest time cannot order a backfill: it writes a whole document history
 *    inside one second, so every row ties and the sort collapses to insertion
 *    order. `parseDocumentPeriod` reads what it can out of the free-form string
 *    and says NULL for the rest — and for those rows, and ONLY those, ingest
 *    day is the fallback key, because a weaker date still beats no date. See
 *    {@link compareTimelineDocuments}.
 *
 * 2. **A document that is not READY still EXISTS.** `processingStatus` describes
 *    OUR extraction pipeline, not the filing. Filtering `PENDING`/`FAILED` rows
 *    out of the timeline would hide real, published filings behind an internal
 *    job's state — and make a stalled extractor look like a quiet company. Every
 *    row appears; only `readable` (our searchable copy) is gated on `READY`.
 *
 * 3. **`UpcomingEvent` has NO unique constraint and a NULLABLE symbol.** The
 *    writer is delete-then-`createMany` per (symbol, category) window
 *    (`workers/src/processors/events-sync.ts:352`), with two feeds — NSE and a
 *    per-symbol Yahoo fallback — able to describe the same board meeting. So the
 *    reader dedupes, and it filters on symbol EXPLICITLY: `symbol` is null for
 *    macro rows (RBI policy, US CPI), and a null-tolerant filter pins an RBI
 *    date onto every stock on the platform.
 *
 * 4. **A quarterly filing and the nine-month cumulative share a `periodEnd`.**
 *    They are DIFFERENT facts — the schema puts `cumulative` in
 *    `@@unique([symbol, exchange, periodEnd, periodType, basis, cumulative])`
 *    precisely so they cannot collide. A chart that filters on neither merges
 *    them; one that filters on basis alone plots consolidated revenue (which for
 *    a holding company can be a multiple of standalone) against standalone and
 *    produces a step change that reads as growth. Both filters, always.
 *
 * 5. **`percentToNav` of 0 is a disclosed weight; absent is not 0.** The whole
 *    absence discipline: `""` / `"-"` / blank / unparseable ⇒ `null`, at parse
 *    AND at render. A sum over an all-null set is `null`, not `0`.
 *
 * Wire shape: every date crossing a function boundary here is an ISO string,
 * not a `Date`. The same payloads travel a Next server action AND an `apps/api`
 * JSON response, and only one of those preserves `Date`.
 */

import { finiteOrNull, isoOrNull, textOrNull } from "./stock-section-logic";
import {
  existingDisplacement,
  FINANCIALS_AUTHORITY,
  periodLabel,
} from "./xbrl-projection";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC calendar day of a date-ish value, or null. */
function dayKey(v: Date | string | number | null | undefined): string | null {
  const iso = isoOrNull(v ?? null);
  return iso === null ? null : iso.slice(0, 10);
}

function toDate(v: Date | string | number | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Round to `dp` decimals, preserving null. Never turns null into 0. */
function round(n: number | null, dp = 2): number | null {
  if (n === null) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Sum that preserves absence.
 *
 * `[null, null]` ⇒ null (nothing was disclosed), `[0, null]` ⇒ 0 (a zero WAS
 * disclosed). `[].reduce((a,b)=>a+b, 0)` — the obvious version — returns 0 for
 * both, which is exactly the silent-zero this codebase keeps re-learning about.
 */
function sumOrNull(values: ReadonlyArray<number | null>): number | null {
  let total = 0;
  let seen = false;
  for (const v of values) {
    if (v === null) continue;
    total += v;
    seen = true;
  }
  return seen ? total : null;
}

// ════════════════════════════════════════════════════════════════════
// 14c.7 — filings & documents timeline
// ════════════════════════════════════════════════════════════════════

/**
 * The four categories the timeline filters by, plus `other`.
 *
 * `other` is NOT a dumping ground to be hidden. `StockDocument.docType` is a
 * free-form string written by six different producers, and a type this module
 * has not seen is still a real document. It gets its own bucket and its own
 * count so a new upstream docType shows up as "3 other" rather than vanishing.
 */
export type DocCategory =
  | "result"
  | "annual_report"
  | "transcript"
  | "announcement"
  | "other";

/** Display order for the filter chips. `other` last. */
export const DOC_CATEGORY_ORDER: readonly DocCategory[] = [
  "result",
  "annual_report",
  "transcript",
  "announcement",
  "other",
];

export const DOC_CATEGORY_LABEL: Record<DocCategory, string> = {
  result: "Results",
  annual_report: "Annual reports",
  transcript: "Transcripts",
  announcement: "Announcements",
  other: "Other",
};

/**
 * The real `docType` vocabulary, gathered from every writer rather than from
 * the schema comment (which lists four values, none of which is what the
 * announcement syncs actually write).
 *
 *   `financial_statement`      packages/research/src/data-sources/stock-document-fetcher.ts:241
 *                              workers/src/processors/stock-document-sync.ts:187
 *   `screener_financials`      workers/src/processors/stock-document-sync.ts:421
 *   `annual_report`            workers/src/processors/annual-reports-sync.ts:261
 *   `integrated_filing`        workers/src/processors/annual-reports-sync.ts:503
 *   `corporate_filing`         workers/src/processors/bse-announcements-sync.ts:47
 *   `video_transcript`         packages/research/src/tools/fetch-youtube-transcript.ts:257
 *   `concall_transcript` …     packages/research/src/data-sources/stock-document-paths.ts:15
 *
 * Matching is case-insensitive and trimmed; anything unrecognised is `other`,
 * never dropped.
 */
const DOC_TYPE_CATEGORY: Record<string, DocCategory> = {
  // Results — the periodic financial statement, however it reached us.
  quarterly_result: "result",
  quarterly_report: "result",
  financial_statement: "result",
  financial_results: "result",
  integrated_filing: "result",

  annual_report: "annual_report",

  // Transcripts / calls. `earnings_call_intimation` is the notice rather than
  // the transcript, but it belongs to the same reading task.
  concall_transcript: "transcript",
  concall_ppt: "transcript",
  concall_ai_summary: "transcript",
  video_transcript: "transcript",
  earnings_call_intimation: "transcript",

  // Exchange announcements and the one-off disclosures filed alongside them.
  corporate_filing: "announcement",
  corporate_announcement: "announcement",
  announcement: "announcement",
  announcements: "announcement",
  press_release: "announcement",
  investor_presentation: "announcement",
  credit_rating: "announcement",
  drhp: "announcement",

  // Deliberately `other`: these are JSON snapshots archived for RAG/audit, not
  // documents a reader opens. Classifying `screener_financials` as a "result"
  // would put a machine-readable blob in a list of human filings.
  screener_financials: "other",
  screener_shareholding: "other",
  screener_peers: "other",
  screener_growth: "other",
  corporate_actions: "other",
};

export function classifyDocType(docType: unknown): DocCategory {
  const key = String(docType ?? "")
    .trim()
    .toLowerCase();
  return DOC_TYPE_CATEGORY[key] ?? "other";
}

/**
 * MONEY-1255 added `UNSUPPORTED`.
 *
 * `PENDING` means "queued for extraction", and 1,210 rows were carrying it
 * while being an HTML error page, an MP3 or a ZIP — file types no extractor in
 * this repo will ever read. They were not a backlog; they were noise that made
 * the backlog unreadable, and they would have sat PENDING for the life of the
 * table. `UNSUPPORTED` is terminal: the document exists, we hold the bytes,
 * and there is no text to get out of it.
 *
 * It is a distinct value rather than `FAILED` because the two are acted on
 * differently. FAILED means "we tried and it did not work", which `force:true`
 * re-runs; UNSUPPORTED means "we will never try", and a re-run is guaranteed
 * to produce the same nothing. Folding them together would put 1,210
 * permanent no-ops into every forced pass.
 */
export type DocProcessingStatus =
  | "PENDING"
  | "PROCESSING"
  | "READY"
  | "FAILED"
  | "UNSUPPORTED"
  | "UNKNOWN";

const DOC_STATUS_LABEL: Record<DocProcessingStatus, string> = {
  PENDING: "Queued for extraction",
  PROCESSING: "Extracting",
  READY: "Text available",
  FAILED: "Extraction failed",
  UNSUPPORTED: "No text to extract",
  UNKNOWN: "Unknown state",
};

export function normalizeProcessingStatus(v: unknown): DocProcessingStatus {
  const s = String(v ?? "")
    .trim()
    .toUpperCase();
  return s === "PENDING" ||
    s === "PROCESSING" ||
    s === "READY" ||
    s === "FAILED" ||
    s === "UNSUPPORTED"
    ? s
    : "UNKNOWN";
}

/**
 * Our extracted copy is searchable ONLY at `READY`.
 *
 * This gates the "read text" affordance, NOT the row's presence. See header
 * note 2 — the document exists either way and the timeline shows it either way.
 */
export function isReadableDocument(status: unknown): boolean {
  return normalizeProcessingStatus(status) === "READY";
}

// ── `period` → a sortable key ────────────────────────────────────────────────

/**
 * A `period` string resolved to something orderable — MONEY-1255.
 *
 * `key` is the whole point: a zero-padded `YYYYMMDD` so ordinary string
 * comparison orders it, with the coarser shapes padded to the START of their
 * span (`FY2025` ⇒ `20250000`). Padding to the start rather than the end is
 * deliberate: a label that names a whole YEAR must not outrank a document from
 * inside that year whose month we actually know. Coarse precision loses the
 * tie; it does not win it.
 */
export interface DocumentPeriod {
  /** Zero-padded `YYYYMMDD`. Lexicographically comparable; higher = later. */
  key: string;
  year: number;
  /** 1–12 when the label names a month or a quarter; 0 when only a year. */
  month: number;
  /** 1–31 when the label names a day; 0 otherwise. */
  day: number;
  kind: "date" | "quarter" | "month" | "year";
}

/**
 * The band a 4-digit run has to fall in to be read as a YEAR.
 *
 * This is not decoration. Measured on prod 2026-08-26, `stock_documents.period`
 * holds ten rows of the shape `dec 1087` / `AUG 9284` / `jan 2107` / `DEC 5120`
 * — a month name followed by a number that is plainly a mangled TIME or
 * sequence, not a year (1087, 4310, 1748, 1048, 0807, 2107, 9284, 0809, 9031,
 * 5120). A parser that takes "the 4 digits after a month name" at face value
 * files `AUG 9284` at the TOP of the timeline forever, which is precisely the
 * unknown-date-presented-as-newest failure this ordering exists to prevent.
 * The band rejects all ten, and rejecting them routes them to the
 * unparseable-sorts-LAST branch. 2100 is a plausibility ceiling, not a
 * prediction — it is what makes `jan 2107` (i.e. 21:07) fail.
 */
const MIN_PLAUSIBLE_PERIOD_YEAR = 1900;
const MAX_PLAUSIBLE_PERIOD_YEAR = 2100;

const MONTH_INDEX: Record<string, number> = {
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

/** `IF-2026-08-20`, `IF-2026-08-20-Standalone`, and `extractPeriod`'s `YYYY-MM-DD`. */
const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/;
/** `Q3-2024`, `Q3 2024`, `Q3-FY2024` — the shape `extractPeriod`/`periodLabel` mint. */
const QUARTER_RE = /Q([1-4])\s*[-–—/]?\s*(?:FY\s*)?(\d{4})(?!\d)/i;
/** `Feb 2026`, `MAR 2012`, `September 2025`. */
const MONTH_NAME_RE =
  /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*[-,]?\s*(\d{4})(?!\d)/i;
/**
 * A STANDALONE 4-digit run: `FY2025`, `screener-2026`, `annual-2026`, `2024`.
 *
 * Both guards are load-bearing. `nse-106748636` (2,344 rows on prod) is an
 * announcement sequence id, and without the digit lookaround `\d{4}` happily
 * reads `1067` out of the middle of it and files a 2026 announcement under the
 * year 1067 — or, with a different id, under a plausible one.
 */
const BARE_YEAR_RE = /(?<!\d)(\d{4})(?!\d)/;

function plausibleYear(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const y = Number(raw);
  if (!Number.isInteger(y)) return null;
  return y >= MIN_PLAUSIBLE_PERIOD_YEAR && y <= MAX_PLAUSIBLE_PERIOD_YEAR
    ? y
    : null;
}

function periodKey(year: number, month: number, day: number): string {
  return (
    String(year).padStart(4, "0") +
    String(month).padStart(2, "0") +
    String(day).padStart(2, "0")
  );
}

/**
 * Read a `stock_documents.period` string as a point in time, or return null.
 *
 * **Null is a real answer, and its meaning is "sort me last".** `StockDocument`
 * has no filing-date column (header note 1), so `period` is the only thing on
 * the row that describes WHEN the document is about — and a large minority of
 * periods describe nothing of the kind. Measured on prod 2026-08-26 across
 * 43,031 rows and 30 distinct shapes: `nse-{seq_id}` (2,344), `[1]`..`[4]`
 * (317 — a genuinely mis-parsed Screener table cell), `IPO` (593), and
 * `unknown-date` (`extractPeriod`'s explicit Invalid-Date sentinel). None of
 * these can be ordered, and guessing at them is worse than admitting it.
 *
 * The shapes it DOES read, most precise first:
 *
 *   `2026-08-20` / `IF-2026-08-20[-Basis]`   an actual date          (day)
 *   `Q3-2024`, `Q3 FY2024`                   a fiscal quarter        (month)
 *   `Feb 2026`, `MAR 2012`                   a calendar month        (month)
 *   `FY2025`, `screener-2026`, `2024`        a year                  (year)
 *
 * A quarter is positioned at its LABEL year's quarter-end month (Q1⇒03 …
 * Q4⇒12), so `Q3-2024` and `Q4-2024` order against each other and both stay
 * inside 2024. Note the known limit this accepts: `periodLabel` mints the
 * FY-END year, so `Q3-2026` really covers Oct–Dec 2025 and will sort above a
 * `Dec 2025` announcement that in wall-clock terms is contemporaneous. Placing
 * quarters by their true calendar span would fix that and would scatter a
 * single label year across two calendar years — worse for reading, and worse
 * for the case that actually occurs. `stock_documents` holds ZERO quarter-shaped
 * periods today; revisit this with real rows rather than in the abstract.
 */
export function parseDocumentPeriod(period: unknown): DocumentPeriod | null {
  const raw = textOrNull(period);
  if (raw === null) return null;

  const iso = ISO_DATE_RE.exec(raw);
  if (iso) {
    const year = plausibleYear(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (year !== null && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return {
        key: periodKey(year, month, day),
        year,
        month,
        day,
        kind: "date",
      };
    }
  }

  const quarter = QUARTER_RE.exec(raw);
  if (quarter) {
    const year = plausibleYear(quarter[2]);
    const q = Number(quarter[1]);
    if (year !== null && q >= 1 && q <= 4) {
      const month = q * 3;
      return {
        key: periodKey(year, month, 0),
        year,
        month,
        day: 0,
        kind: "quarter",
      };
    }
  }

  const named = MONTH_NAME_RE.exec(raw);
  if (named) {
    const year = plausibleYear(named[2]);
    const month = MONTH_INDEX[(named[1] ?? "").toLowerCase()];
    if (year !== null && month !== undefined) {
      return {
        key: periodKey(year, month, 0),
        year,
        month,
        day: 0,
        kind: "month",
      };
    }
  }

  const bare = BARE_YEAR_RE.exec(raw);
  if (bare) {
    const year = plausibleYear(bare[1]);
    if (year !== null) {
      return {
        key: periodKey(year, 0, 0),
        year,
        month: 0,
        day: 0,
        kind: "year",
      };
    }
  }

  return null;
}

/** The `period` sort key, or null when the label names no point in time. */
export function documentPeriodSortKey(period: unknown): string | null {
  return parseDocumentPeriod(period)?.key ?? null;
}

/**
 * The `stock_documents` columns this module reads.
 *
 * `textContent` is CONSCIOUSLY ABSENT and must never be added: it holds up to
 * ~100KB of extracted text per row, so selecting it for a list read moves
 * megabytes per request for data the timeline does not render.
 */
export interface StockDocumentRow {
  id: string;
  docType: string;
  period?: string | null;
  title?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
  processingStatus?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  /** Ingest time. NOT a filing date — see header note 1. */
  fetchedAt?: Date | string | null;
}

export interface TimelineDocument {
  id: string;
  docType: string;
  category: DocCategory;
  categoryLabel: string;
  period: string | null;
  title: string;
  description: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  status: DocProcessingStatus;
  statusLabel: string;
  /** True when OUR extracted copy is ready. The row shows regardless. */
  readable: boolean;
  /** When WE indexed it. There is no filing date on this model. */
  indexedAt: string | null;
  fileSizeBytes: number | null;
  mimeType: string | null;
}

/** `upcoming_events` columns. `symbol` is nullable — macro rows carry none. */
export interface UpcomingEventRow {
  id?: string | null;
  date: Date | string;
  symbol?: string | null;
  title?: string | null;
  category?: string | null;
  source?: string | null;
}

export interface PinnedEvent {
  date: string;
  title: string;
  category: string;
  /** "NSE" | "YAHOO" | null. Surfaced because the two disagree on dates. */
  source: string | null;
  /** Whole days from `now` to the event, floor'd. Null when undeterminable. */
  daysAway: number | null;
}

/**
 * Collapse duplicate upcoming events.
 *
 * `UpcomingEvent` has NO `@@unique` — the writer deletes the future window for
 * the symbols it is about to write and then `createMany`s
 * (`workers/src/processors/events-sync.ts:352`). Two feeds populate it (NSE for
 * the whole universe, Yahoo per-symbol for what NSE missed), and both can name
 * the same board meeting. Identity here is (day, category, normalised title).
 *
 * NSE wins a tie. It is the primary feed per the model's own `source` doc, and
 * picking deterministically matters more than which one wins: an alternating
 * choice would make the pinned event flicker between page loads.
 */
export function dedupeUpcomingEvents(
  rows: ReadonlyArray<UpcomingEventRow>,
): UpcomingEventRow[] {
  const best = new Map<string, UpcomingEventRow>();
  for (const r of rows) {
    const day = dayKey(r.date);
    if (day === null) continue;
    const category = (textOrNull(r.category) ?? "").toLowerCase();
    const title = (textOrNull(r.title) ?? "")
      .toLowerCase()
      .replace(/\s+/g, " ");
    const key = `${day}|${category}|${title}`;
    const incumbent = best.get(key);
    if (!incumbent) {
      best.set(key, r);
      continue;
    }
    const incumbentIsNse =
      (textOrNull(incumbent.source) ?? "").toUpperCase() === "NSE";
    const challengerIsNse =
      (textOrNull(r.source) ?? "").toUpperCase() === "NSE";
    if (!incumbentIsNse && challengerIsNse) best.set(key, r);
  }
  return [...best.values()];
}

/**
 * The next event for THIS symbol, or null.
 *
 * The symbol filter is explicit and case-insensitive, and a null `symbol`
 * NEVER matches: macro rows (RBI policy, US CPI) are stored with no symbol, and
 * a filter that lets them through pins one RBI date onto every stock page on
 * the platform. `today` is compared on the UTC calendar day so an event dated
 * today still counts as upcoming.
 */
export function nextUpcomingEvent(
  rows: ReadonlyArray<UpcomingEventRow>,
  opts: { symbol: string; now?: Date | string },
): PinnedEvent | null {
  const want = String(opts.symbol ?? "")
    .trim()
    .toUpperCase();
  if (want === "") return null;
  const now = toDate(opts.now ?? null) ?? new Date();
  const todayKey = dayKey(now);
  if (todayKey === null) return null;

  const candidates = dedupeUpcomingEvents(rows)
    .filter((r) => {
      const sym = textOrNull(r.symbol);
      if (sym === null) return false;
      if (sym.toUpperCase() !== want) return false;
      const day = dayKey(r.date);
      return day !== null && day >= todayKey;
    })
    .sort((a, b) => {
      const da = dayKey(a.date) ?? "";
      const db = dayKey(b.date) ?? "";
      if (da !== db) return da < db ? -1 : 1;
      const ta = textOrNull(a.title) ?? "";
      const tb = textOrNull(b.title) ?? "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });

  const pick = candidates[0];
  if (!pick) return null;
  const when = toDate(pick.date);
  const iso = isoOrNull(pick.date);
  if (!when || iso === null) return null;

  // Whole days between calendar days, not between instants — otherwise an
  // event 23h away reads as "0 days" and one 25h away as "1 day".
  const startOfToday = Date.parse(`${todayKey}T00:00:00.000Z`);
  const startOfEvent = Date.parse(`${dayKey(when)}T00:00:00.000Z`);
  const daysAway =
    Number.isFinite(startOfToday) && Number.isFinite(startOfEvent)
      ? Math.round((startOfEvent - startOfToday) / MS_PER_DAY)
      : null;

  return {
    date: iso,
    title: textOrNull(pick.title) ?? "Scheduled event",
    category: textOrNull(pick.category) ?? "event",
    source: textOrNull(pick.source),
    daysAway,
  };
}

export interface FilingsTimeline {
  /** The next scheduled event, pinned above the documents. */
  pinned: PinnedEvent | null;
  /** Newest first by `period`, falling back to ingest day. No date at all ⇒ last. */
  items: TimelineDocument[];
  /** Per-category counts BEFORE the category filter and the display cap. */
  counts: Record<DocCategory, number>;
  /** Documents present whose extracted copy is not READY. Shown, not hidden. */
  notReadyCount: number;
  /** Documents dropped by the category filter — visible, so nothing vanishes. */
  filteredOut: number;
  /** Newest ingest time across ALL documents, ISO. Drives the `asOf` chip. */
  latestIndexedAt: string | null;
}

const EMPTY_COUNTS = (): Record<DocCategory, number> => ({
  result: 0,
  annual_report: 0,
  transcript: 0,
  announcement: 0,
  other: 0,
});

export function toTimelineDocument(row: StockDocumentRow): TimelineDocument {
  const category = classifyDocType(row.docType);
  const status = normalizeProcessingStatus(row.processingStatus);
  const size = finiteOrNull(row.fileSize);
  return {
    id: String(row.id),
    docType: String(row.docType ?? "").trim(),
    category,
    categoryLabel: DOC_CATEGORY_LABEL[category],
    period: textOrNull(row.period),
    title:
      textOrNull(row.title) ??
      textOrNull(row.period) ??
      DOC_CATEGORY_LABEL[category],
    description: textOrNull(row.description),
    sourceUrl: textOrNull(row.sourceUrl),
    sourceType: textOrNull(row.sourceType),
    status,
    statusLabel: DOC_STATUS_LABEL[status],
    readable: status === "READY",
    indexedAt: isoOrNull(row.fetchedAt ?? null),
    // `fileSize Int @default(0)` — a 0 here is the default, not a measurement,
    // so it is reported as absent rather than as "0 bytes".
    fileSizeBytes: size === null || size <= 0 ? null : size,
    mimeType: textOrNull(row.mimeType),
  };
}

/**
 * `indexedAt` reduced to the SAME `YYYYMMDD` space a period key lives in.
 *
 * The two have to be commensurable for {@link compareTimelineDocuments} to fall
 * back from one to the other in a single ordering. Day granularity, not the
 * full instant, is deliberate: a period key can never be more precise than a
 * day, so carrying the time here would let an ingest-dated row beat a
 * period-dated row from the same day on nothing but scrape clock. The full
 * instant is still used, at full precision, as the tiebreak below.
 */
export function indexedAtSortKey(indexedAt: unknown): string | null {
  const iso = textOrNull(indexedAt);
  if (iso === null) return null;
  const day = iso.slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(day) ? day : null;
}

/**
 * Timeline order: newest first by the best date the row has — MONEY-1255.
 *
 * This used to sort on `indexedAt` (OUR scrape time) with `period` consulted
 * only when BOTH rows lacked one, and that is not a near-miss ordering — it is
 * no ordering at all for the common case. A backfill writes a company's whole
 * document history inside a few seconds, so every row shares a scrape instant
 * and the comparator falls through to its last tiebreak: Mongo `_id`. GOODYEAR's
 * seventeen documents, all scraped on two days in April 2026, rendered FY2011,
 * FY2013, FY2010, FY2012, FY2014 — insertion order wearing a timestamp.
 *
 * So `period` leads. Three rules, in order:
 *
 * 1. **The primary key is `period` and, ONLY where that names no date at all,
 *    `indexedAt`.** Both normalised to `YYYYMMDD`, compared DESC in one space.
 *
 * 2. **An unknown date must not masquerade as the newest — but `indexedAt` is
 *    not unknown.** This is the distinction the first cut of MONEY-1255 got
 *    wrong, and it was wrong in a way that measured badly. Sinking every
 *    unparseable period to the bottom sounds conservative, and on prod it
 *    buries the 2,344 rows whose period is `nse-{seq_id}` — every one of them
 *    ingested in the last FOURTEEN DAYS (2026-08-11 → 2026-08-25), and by
 *    docType 939 earnings-call intimations, 454 concall transcripts, 384 press
 *    releases, 299 investor presentations. Those arrive from a near-real-time
 *    NSE announcements feed where ingest time is an excellent proxy for
 *    publication time. Filing last week's earnings-call intimation below a
 *    FY2010 annual report is a worse bug than the one this function was
 *    written to fix. A weaker date is still a date; the honest move is to use
 *    it as a lower-confidence estimate, not to discard it.
 *
 *    This does NOT reintroduce the original defect. That defect was that
 *    EVERY row sorted by ingest, so FY2011 outranked FY2010 for being scraped
 *    four days later. Here a row with a readable period always uses its
 *    period — GOODYEAR's fifteen `FY####` rows are untouched by the fallback.
 *    Only a row with no period date at all reaches it.
 *
 *    Accepted cost, written down rather than discovered later: a `[1]` row (a
 *    mis-scraped Screener page-anchor, 317 on prod) sorts by when we scraped it
 *    instead of by the year it belongs to. GOODYEAR's `[1]` therefore leads its
 *    timeline. It is one row against 2,344, and it duplicates a correctly-dated
 *    one.
 *
 * 3. **Truly last means BOTH keys absent**, then ties break on the full
 *    `indexedAt` instant DESC, then on `id`. `id` at the end makes the order
 *    TOTAL — without it the sort is unstable across engines and the list can
 *    reshuffle between identical requests.
 */
export function compareTimelineDocuments(
  a: TimelineDocument,
  b: TimelineDocument,
): number {
  // `??`, not `||`: a period key is never "", but reaching for the fallback on
  // a falsy-but-present key is the kind of thing that would silently work here
  // and break the day someone changes the key format.
  const ka = documentPeriodSortKey(a.period) ?? indexedAtSortKey(a.indexedAt);
  const kb = documentPeriodSortKey(b.period) ?? indexedAtSortKey(b.indexedAt);
  // `null !== null` is false, so two rows with NEITHER key fall through to the
  // tiebreaks rather than being declared equal here.
  if (ka !== kb) {
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka < kb ? 1 : -1;
  }
  if (a.indexedAt !== b.indexedAt) {
    if (a.indexedAt === null) return 1;
    if (b.indexedAt === null) return -1;
    return a.indexedAt < b.indexedAt ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Build the timeline: the next event pinned on top, documents newest-first.
 *
 * `categories` is the filter chip state. Omitted ⇒ everything, because the
 * default view must not hide a docType this module has not learned yet.
 */
export function buildFilingsTimeline(input: {
  docs: ReadonlyArray<StockDocumentRow>;
  events?: ReadonlyArray<UpcomingEventRow>;
  symbol: string;
  now?: Date | string;
  categories?: ReadonlyArray<DocCategory>;
  limit?: number;
}): FilingsTimeline {
  const all = input.docs.map(toTimelineDocument);

  const counts = EMPTY_COUNTS();
  let notReadyCount = 0;
  let latest: string | null = null;
  for (const d of all) {
    counts[d.category] += 1;
    if (!d.readable) notReadyCount += 1;
    if (d.indexedAt !== null && (latest === null || d.indexedAt > latest)) {
      latest = d.indexedAt;
    }
  }

  const wanted =
    input.categories && input.categories.length > 0
      ? new Set<DocCategory>(input.categories)
      : null;
  const kept = wanted ? all.filter((d) => wanted.has(d.category)) : all;

  const sorted = [...kept].sort(compareTimelineDocuments);

  const limit = Math.max(0, Math.trunc(input.limit ?? sorted.length));
  const items = sorted.slice(0, limit);

  return {
    pinned: nextUpcomingEvent(input.events ?? [], {
      symbol: input.symbol,
      now: input.now,
    }),
    items,
    counts,
    notReadyCount,
    filteredOut: all.length - kept.length,
    latestIndexedAt: latest,
  };
}

// ════════════════════════════════════════════════════════════════════
// 14c.8 — financials source badge + basis / cumulative toggle
// ════════════════════════════════════════════════════════════════════

/** `stock_financials` columns the badge reads. */
export interface FinancialsSourceRow {
  period?: string | null;
  periodType?: string | null;
  statementType?: string | null;
  /** `String @default("TICKERTAPE")`. Read, never assumed — see below. */
  source?: string | null;
  fetchedAt?: Date | string | null;
  /** Carries `displacedByXbrl` when a projection write replaced a source. */
  rawData?: unknown;
}

export interface FinancialsSourceCount {
  source: string;
  rows: number;
  /** Position in `FINANCIALS_AUTHORITY`; an unknown source ranks LAST. */
  rank: number;
}

/**
 * A period whose incumbent numbers were replaced by an XBRL projection.
 *
 * This is the only surviving record of what the previous source said —
 * `StockFinancials` has no `source` in its `@@unique`, so two sources for one
 * period are ONE row and a write ERASES rather than duplicates. The projection
 * writer leaves a `DisplacementRecord` behind in `rawData` precisely so the
 * erasure is auditable.
 */
export interface FinancialsDisplacement {
  period: string | null;
  displacedSource: string;
  by: string;
  displacedAt: string | null;
}

export interface FinancialsSourceSummary {
  /**
   * The source the badge shows: the most common one, ties broken by authority.
   *
   * Read from the rows, NEVER hardcoded. The 14a.4 XBRL switchover is not armed
   * (its reconcile evidence run is founder-gated and has not happened), so today
   * every row reads `TICKERTAPE` — but a badge that asserts that is a badge that
   * lies on the day the switchover lands.
   */
  primary: string | null;
  breakdown: FinancialsSourceCount[];
  /**
   * True when the rows carry MORE THAN ONE source. That is not an error — a
   * partial XBRL backfill legitimately leaves a mixed table — but a single
   * chip over a mixed series is a claim about provenance that is not true, so
   * the UI has to be able to say so.
   */
  mixed: boolean;
  /** Newest `fetchedAt` across the rows, ISO. Null when none carry one. */
  asOf: string | null;
  /** Newest first. Empty until the switchover runs. */
  displacements: FinancialsDisplacement[];
}

function authorityRank(source: string): number {
  const i = (FINANCIALS_AUTHORITY as readonly string[]).indexOf(source);
  return i === -1 ? FINANCIALS_AUTHORITY.length : i;
}

export function summarizeFinancialsSource(
  rows: ReadonlyArray<FinancialsSourceRow>,
): FinancialsSourceSummary {
  const bySource = new Map<string, number>();
  let asOfMs: number | null = null;
  const displacements: FinancialsDisplacement[] = [];

  for (const r of rows) {
    const src = textOrNull(r.source);
    if (src !== null) bySource.set(src, (bySource.get(src) ?? 0) + 1);

    const fetched = toDate(r.fetchedAt ?? null);
    if (fetched && (asOfMs === null || fetched.getTime() > asOfMs)) {
      asOfMs = fetched.getTime();
    }

    const d = existingDisplacement(r.rawData);
    if (d) {
      displacements.push({
        period: textOrNull(r.period),
        displacedSource: d.displacedSource,
        by: d.by,
        displacedAt: isoOrNull(d.displacedAt ?? null),
      });
    }
  }

  const breakdown: FinancialsSourceCount[] = [...bySource.entries()]
    .map(([source, count]) => ({
      source,
      rows: count,
      rank: authorityRank(source),
    }))
    // Most rows first; a tie goes to the higher-authority source, so a table
    // half-migrated to XBRL labels itself NSE_XBRL rather than by coin flip.
    .sort((a, b) => b.rows - a.rows || a.rank - b.rank);

  displacements.sort((a, b) => {
    const da = a.displacedAt ?? "";
    const db = b.displacedAt ?? "";
    return da < db ? 1 : da > db ? -1 : 0;
  });

  return {
    primary: breakdown[0]?.source ?? null,
    breakdown,
    mixed: breakdown.length > 1,
    asOf: asOfMs === null ? null : new Date(asOfMs).toISOString(),
    displacements,
  };
}

export type FinancialsBasis = "CONSOLIDATED" | "STANDALONE";

export const FINANCIALS_BASES: readonly FinancialsBasis[] = [
  "CONSOLIDATED",
  "STANDALONE",
];

/**
 * Consolidated is the default view.
 *
 * It is the number the market quotes and the one a holding company's investors
 * mean. Standalone is available as an explicit toggle, never mixed in.
 */
export const DEFAULT_FINANCIALS_BASIS: FinancialsBasis = "CONSOLIDATED";

export function normalizeBasis(v: unknown): FinancialsBasis | null {
  const s = String(v ?? "")
    .trim()
    .toUpperCase();
  return s === "CONSOLIDATED" || s === "STANDALONE" ? s : null;
}

/** `xbrl_filings` columns the drill-down reads. `facts` is deliberately not one. */
export interface XbrlFilingRow {
  id: string;
  periodStart?: Date | string | null;
  periodEnd: Date | string;
  periodType: string;
  basis: string;
  cumulative?: boolean | null;
  audited?: boolean | null;
  /** 0–1, `Float @default(0)`. A stored 0 is real: nothing resolved. */
  coverage?: number | null;
  conceptsFound?: ReadonlyArray<string> | null;
  sourceUrl?: string | null;
  filedAt?: Date | string | null;
  taxonomyVersion?: string | null;
}

/**
 * Below this share of the canonical concept set, a filing explains a sparse
 * financials row rather than contradicting it — which is the whole reason
 * `coverage` is worth surfacing next to the numbers.
 */
export const SPARSE_COVERAGE_THRESHOLD = 0.5;

export interface FilingPeriodView {
  id: string;
  /** `Q3-2025` / `2025`, derived the SAME way the projection writer derives it. */
  period: string;
  periodType: string;
  periodStart: string | null;
  periodEnd: string;
  basis: FinancialsBasis;
  cumulative: boolean;
  audited: boolean;
  /** Null when absent. A stored 0 stays 0 — it means nothing resolved. */
  coverage: number | null;
  conceptCount: number | null;
  sourceUrl: string | null;
  filedAt: string | null;
  /** True when `coverage` is known and below the threshold. */
  sparse: boolean;
}

export interface FilingBasisAvailability {
  /** Which bases this issuer actually filed. A toggle to nothing is a dead end. */
  bases: FinancialsBasis[];
  hasCumulative: boolean;
  hasDiscrete: boolean;
}

export function availableFilingViews(
  rows: ReadonlyArray<XbrlFilingRow>,
): FilingBasisAvailability {
  const bases = new Set<FinancialsBasis>();
  let hasCumulative = false;
  let hasDiscrete = false;
  for (const r of rows) {
    const b = normalizeBasis(r.basis);
    if (b) bases.add(b);
    if (r.cumulative === true) hasCumulative = true;
    else hasDiscrete = true;
  }
  return {
    bases: FINANCIALS_BASES.filter((b) => bases.has(b)),
    hasCumulative,
    hasDiscrete,
  };
}

function toFilingPeriodView(row: XbrlFilingRow): FilingPeriodView | null {
  const basis = normalizeBasis(row.basis);
  const end = toDate(row.periodEnd);
  if (!basis || !end) return null;
  const coverage = finiteOrNull(row.coverage);
  const concepts = Array.isArray(row.conceptsFound)
    ? row.conceptsFound.length
    : null;
  return {
    id: String(row.id),
    period: periodLabel(end, String(row.periodType ?? "")),
    periodType: String(row.periodType ?? "").trim(),
    periodStart: isoOrNull(row.periodStart ?? null),
    periodEnd: end.toISOString(),
    basis,
    cumulative: row.cumulative === true,
    audited: row.audited === true,
    coverage,
    conceptCount: concepts,
    sourceUrl: textOrNull(row.sourceUrl),
    filedAt: isoOrNull(row.filedAt ?? null),
    sparse: coverage !== null && coverage < SPARSE_COVERAGE_THRESHOLD,
  };
}

/**
 * Filings for ONE (basis, cumulative) view, newest first.
 *
 * BOTH filters are mandatory, and that is the point of the function. Filtering
 * on basis alone merges Q3 with the nine-month cumulative that shares its
 * `periodEnd`; filtering on cumulative alone charts consolidated against
 * standalone. Either one on its own produces a series that looks plausible and
 * is wrong — no error, no empty result, just a number that moved.
 *
 * Dedupe: the DB key includes `exchange`, but this section reads by symbol
 * alone (these are NSE filings and a BSE view of a dual-listed name must not
 * come back empty), so the same period can arrive twice. Higher `coverage`
 * wins, then the later `filedAt` — a re-published correction supersedes.
 */
export function selectFilings(
  rows: ReadonlyArray<XbrlFilingRow>,
  opts: { basis: FinancialsBasis; cumulative: boolean; limit?: number },
): FilingPeriodView[] {
  const best = new Map<string, FilingPeriodView>();
  for (const r of rows) {
    const view = toFilingPeriodView(r);
    if (!view) continue;
    if (view.basis !== opts.basis) continue;
    if (view.cumulative !== opts.cumulative) continue;

    const key = `${view.periodEnd.slice(0, 10)}|${view.periodType}`;
    const incumbent = best.get(key);
    if (!incumbent) {
      best.set(key, view);
      continue;
    }
    const better =
      (view.coverage ?? -1) > (incumbent.coverage ?? -1) ||
      ((view.coverage ?? -1) === (incumbent.coverage ?? -1) &&
        (view.filedAt ?? "") > (incumbent.filedAt ?? ""));
    if (better) best.set(key, view);
  }

  const sorted = [...best.values()].sort((a, b) =>
    a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0,
  );
  const limit = Math.max(0, Math.trunc(opts.limit ?? sorted.length));
  return sorted.slice(0, limit);
}

export interface FilingDrilldown {
  basis: FinancialsBasis;
  cumulative: boolean;
  available: FilingBasisAvailability;
  periods: FilingPeriodView[];
  /** Filings the (basis, cumulative) filter excluded. Counted, not hidden. */
  filteredOut: number;
}

/**
 * The period → filing drill-down for the requested view.
 *
 * When the requested basis is not one this issuer filed, it falls back to a
 * basis that EXISTS rather than returning an empty panel — and the caller can
 * see the swap because `basis` in the result is the one actually used.
 */
export function buildFilingDrilldown(
  rows: ReadonlyArray<XbrlFilingRow>,
  opts: {
    basis?: FinancialsBasis | null;
    cumulative?: boolean;
    limit?: number;
  } = {},
): FilingDrilldown {
  const available = availableFilingViews(rows);
  const requested = opts.basis ?? DEFAULT_FINANCIALS_BASIS;
  const basis = available.bases.includes(requested)
    ? requested
    : (available.bases[0] ?? requested);
  const cumulative = opts.cumulative === true;
  const periods = selectFilings(rows, { basis, cumulative, limit: opts.limit });
  const matching = rows.filter((r) => {
    const v = toFilingPeriodView(r);
    return v !== null && v.basis === basis && v.cumulative === cumulative;
  }).length;
  return {
    basis,
    cumulative,
    available,
    periods,
    filteredOut: rows.length - matching,
  };
}

// ════════════════════════════════════════════════════════════════════
// 14c.9 — funds holding this stock
// ════════════════════════════════════════════════════════════════════

/**
 * Which `holdingType` values count as "a fund holding this STOCK".
 *
 * EQUITY is the obvious one. REIT_INVIT is included because a REIT/InvIT unit
 * IS an exchange-listed equity-like instrument with its own `InstrumentMapping`
 * — a fund that holds EMBASSY REIT holds that security, and excluding it would
 * make the REIT's own page claim no fund owns it. DEBT / CASH / DERIVATIVE /
 * GOLD / OTHER are excluded: a fund holding a company's BOND is not a
 * shareholder, and counting it in "funds holding this stock" would overstate
 * institutional equity ownership. Excluded rows are COUNTED, not silently
 * dropped (`nonEquityRowCount`).
 */
export const STOCK_HOLDING_TYPES: readonly string[] = ["EQUITY", "REIT_INVIT"];

/** `mf_portfolio_holdings` columns the inverse lookup reads. */
export interface StockFundHoldingRow {
  /** UTC midnight, anchored to the FIRST of the disclosure month. */
  period: Date | string;
  amc?: string | null;
  schemeName?: string | null;
  schemeKey?: string | null;
  /** Null is the honest and common case — it is not derivable from the files. */
  amfiSchemeCode?: string | null;
  isin?: string | null;
  instrumentId?: string | null;
  instrumentName?: string | null;
  holdingType?: string | null;
  quantity?: number | null;
  marketValue?: number | null;
  /** A 0 here is a disclosed weight. Absent is NOT 0. */
  percentToNav?: number | null;
}

export interface FundHolderRow {
  schemeKey: string;
  schemeName: string;
  amc: string | null;
  amfiSchemeCode: string | null;
  /** `/mf/{code}` when it resolved, else null — the row still renders. */
  href: string | null;
  percentToNav: number | null;
  quantity: number | null;
  /** ₹ LAKH, the AMCs' own unit, stored and returned unconverted. */
  marketValueLakh: number | null;
  /** Signed MoM change in weight. Null when either month is undisclosed. */
  deltaPct: number | null;
}

export interface FundHolderMove {
  schemeKey: string;
  schemeName: string;
  amc: string | null;
  amfiSchemeCode: string | null;
  href: string | null;
  percentToNav: number | null;
}

export interface FundsHoldingSection {
  /** The month the panel describes (the latest present), ISO. */
  period: string | null;
  /** The month compared against, ISO. Null when only one month exists. */
  priorPeriod: string | null;
  /**
   * True when `priorPeriod` is NOT the calendar month immediately before
   * `period`. The diff is still shown — a fund absent for two months really did
   * exit — but "entered since last month" is a different claim from "entered
   * since March", and only this flag distinguishes them.
   */
  monthGap: boolean;
  /** False when there is no prior month at all: entered/exited are unknowable. */
  comparable: boolean;
  fundCount: number;
  /**
   * Sum of DISCLOSED weights. Null when not one fund disclosed a weight.
   *
   * KEPT, BUT NOT RENDERED AS A HEADLINE. It is a sum of each scheme's weight
   * IN ITS OWN NAV — fractions with different denominators — so it is not a
   * percentage of anything and routinely exceeds 100 (measured on RELIANCE,
   * Aug 2026: 505.36% across 116 scheme rows). `valueHeldLakh` is the additive
   * quantity; this stays because per-scheme weights are still the right thing
   * to show PER ROW, and a caller may legitimately want their total.
   */
  combinedWeightPct: number | null;
  /**
   * Sum of DISCLOSED market values, in ₹ LAKH — the AMCs' own unit.
   *
   * THE ONE FIGURE THAT MAY BE SUMMED. Rupees share a denominator; percentages
   * of different NAVs do not. Null when not one scheme disclosed a value, which
   * is a different fact from zero and must stay distinguishable.
   *
   * IT IS A FLOOR, NEVER A TOTAL. `mf_portfolio_holdings` covers the AMCs whose
   * disclosure URLs are resolved — 17 of AMFI's 57 registered as of 2026-09-13
   * — so any reader-facing label must name the coverage ("across N disclosed
   * AMCs") rather than claim "funds hold".
   */
  valueHeldLakh: number | null;
  /** Schemes in the latest month that disclosed no market value. Counted, not zeroed. */
  undisclosedValueCount: number;
  /** Funds in the latest month that disclosed no weight. Counted, not zeroed. */
  undisclosedWeightCount: number;
  /** Funds with no AMFI code, so no `/mf/` link. They still render. */
  unlinkedFundCount: number;
  funds: FundHolderRow[];
  entered: FundHolderMove[];
  exited: FundHolderMove[];
  /** Rows matching neither an ISIN nor an instrument. Counted, not dropped. */
  unresolvedRowCount: number;
  /** Rows excluded because `holdingType` is not equity-like. */
  nonEquityRowCount: number;
}

interface SchemeAgg {
  schemeKey: string;
  schemeName: string;
  amc: string | null;
  amfiSchemeCode: string | null;
  percentToNav: number | null;
  quantity: number | null;
  marketValue: number | null;
}

function mfHref(code: string | null): string | null {
  return code === null ? null : `/mf/${encodeURIComponent(code)}`;
}

function toMoveRow(a: SchemeAgg): FundHolderMove {
  return {
    schemeKey: a.schemeKey,
    schemeName: a.schemeName,
    amc: a.amc,
    amfiSchemeCode: a.amfiSchemeCode,
    href: mfHref(a.amfiSchemeCode),
    percentToNav: a.percentToNav,
  };
}

/**
 * Is `prior` the calendar month immediately before `latest`?
 *
 * Done on UTC year/month rather than by subtracting 30 days, which gets
 * February wrong every year.
 */
function isPreviousMonth(latest: Date, prior: Date): boolean {
  const months =
    (latest.getUTCFullYear() - prior.getUTCFullYear()) * 12 +
    (latest.getUTCMonth() - prior.getUTCMonth());
  return months === 1;
}

/**
 * Collapse one month's rows to one row per scheme.
 *
 * A scheme can legitimately hold the same issuer under two `instrumentName`
 * spellings (partly-paid lines, a name change mid-month) — the unique key is
 * (period, amc, schemeKey, instrumentName), so both rows are valid and both are
 * this stock. Summing is the honest aggregate for "how much of this scheme is
 * in this stock"; `sumOrNull` keeps an all-undisclosed pair at null.
 */
function aggregateByScheme(
  rows: ReadonlyArray<StockFundHoldingRow>,
): Map<string, SchemeAgg> {
  const buckets = new Map<string, StockFundHoldingRow[]>();
  for (const r of rows) {
    const key =
      textOrNull(r.schemeKey) ??
      textOrNull(r.schemeName)?.toLowerCase().replace(/\s+/g, " ") ??
      null;
    if (key === null) continue;
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }

  const out = new Map<string, SchemeAgg>();
  for (const [schemeKey, list] of buckets) {
    const named = list.find((r) => textOrNull(r.schemeName) !== null);
    // The AMFI code is null for most rows; take the first row that HAS one
    // rather than the first row, so one unmapped line does not cost the link.
    const coded = list.find((r) => textOrNull(r.amfiSchemeCode) !== null);
    out.set(schemeKey, {
      schemeKey,
      schemeName: textOrNull(named?.schemeName) ?? schemeKey,
      amc: textOrNull(list.find((r) => textOrNull(r.amc) !== null)?.amc),
      amfiSchemeCode: textOrNull(coded?.amfiSchemeCode),
      percentToNav: round(
        sumOrNull(list.map((r) => finiteOrNull(r.percentToNav))),
        4,
      ),
      quantity: sumOrNull(list.map((r) => finiteOrNull(r.quantity))),
      marketValue: round(
        sumOrNull(list.map((r) => finiteOrNull(r.marketValue))),
        4,
      ),
    });
  }
  return out;
}

/**
 * "Which funds hold this stock, and how did that change last month?"
 *
 * The MoM diff compares the two most recent DISCLOSURE months present, not
 * "this month vs last month" — AMCs file at different times and Nippon keeps
 * only the current month, so demanding a specific pair would show an empty
 * panel for most of every month. When the two are not consecutive, `monthGap`
 * says so instead of the label quietly lying.
 */
export function buildFundsHoldingSection(
  rows: ReadonlyArray<StockFundHoldingRow>,
  opts: { holdingTypes?: ReadonlyArray<string>; limit?: number } = {},
): FundsHoldingSection {
  const allowed = new Set(
    (opts.holdingTypes ?? STOCK_HOLDING_TYPES).map((t) => t.toUpperCase()),
  );

  let nonEquityRowCount = 0;
  let unresolvedRowCount = 0;
  const byPeriod = new Map<string, StockFundHoldingRow[]>();

  for (const r of rows) {
    const type = (textOrNull(r.holdingType) ?? "OTHER").toUpperCase();
    if (!allowed.has(type)) {
      nonEquityRowCount += 1;
      continue;
    }
    // The inverse lookup keys on ISIN with an instrumentId fallback, so a row
    // carrying NEITHER cannot be attributed to this stock at all. It is counted
    // so the panel can say "n rows we could not resolve" rather than pretending
    // the universe it searched was complete.
    if (textOrNull(r.isin) === null && textOrNull(r.instrumentId) === null) {
      unresolvedRowCount += 1;
      continue;
    }
    const key = dayKey(r.period);
    if (key === null) continue;
    const list = byPeriod.get(key);
    if (list) list.push(r);
    else byPeriod.set(key, [r]);
  }

  const periods = [...byPeriod.keys()].sort((a, b) => (a < b ? 1 : -1));
  const latestKey = periods[0] ?? null;
  const priorKey = periods[1] ?? null;

  if (latestKey === null) {
    return {
      period: null,
      priorPeriod: null,
      monthGap: false,
      comparable: false,
      fundCount: 0,
      combinedWeightPct: null,
      valueHeldLakh: null,
      undisclosedValueCount: 0,
      undisclosedWeightCount: 0,
      unlinkedFundCount: 0,
      funds: [],
      entered: [],
      exited: [],
      unresolvedRowCount,
      nonEquityRowCount,
    };
  }

  const latest = aggregateByScheme(byPeriod.get(latestKey) ?? []);
  const prior =
    priorKey === null
      ? new Map<string, SchemeAgg>()
      : aggregateByScheme(byPeriod.get(priorKey) ?? []);

  const funds: FundHolderRow[] = [...latest.values()]
    .map((a) => {
      const before = prior.get(a.schemeKey)?.percentToNav ?? null;
      return {
        schemeKey: a.schemeKey,
        schemeName: a.schemeName,
        amc: a.amc,
        amfiSchemeCode: a.amfiSchemeCode,
        href: mfHref(a.amfiSchemeCode),
        percentToNav: a.percentToNav,
        quantity: a.quantity,
        marketValueLakh: a.marketValue,
        // Null in ⇒ null out. A fund that disclosed a weight this month and
        // not last month has an UNKNOWN change, not a change of +weight.
        deltaPct:
          a.percentToNav === null || before === null
            ? null
            : round(a.percentToNav - before, 4),
      };
    })
    // Heaviest disclosed weight first; undisclosed weights sink to the bottom
    // rather than sorting as 0 among the genuinely-tiny holders.
    .sort((a, b) => {
      if (a.percentToNav === null && b.percentToNav === null) {
        return a.schemeName < b.schemeName ? -1 : 1;
      }
      if (a.percentToNav === null) return 1;
      if (b.percentToNav === null) return -1;
      return b.percentToNav - a.percentToNav;
    });

  const comparable = priorKey !== null;
  const entered = comparable
    ? [...latest.values()].filter((a) => !prior.has(a.schemeKey)).map(toMoveRow)
    : [];
  const exited = comparable
    ? [...prior.values()].filter((a) => !latest.has(a.schemeKey)).map(toMoveRow)
    : [];

  const latestDate = new Date(`${latestKey}T00:00:00.000Z`);
  const priorDate =
    priorKey === null ? null : new Date(`${priorKey}T00:00:00.000Z`);

  const limit = Math.max(0, Math.trunc(opts.limit ?? funds.length));

  return {
    period: latestDate.toISOString(),
    priorPeriod: priorDate === null ? null : priorDate.toISOString(),
    monthGap: priorDate !== null && !isPreviousMonth(latestDate, priorDate),
    comparable,
    fundCount: latest.size,
    combinedWeightPct: round(sumOrNull(funds.map((f) => f.percentToNav)), 4),
    // Summed over EVERY scheme in the month, not the `limit`-sliced `funds`
    // rendered below — a total that silently described only the top 50 rows
    // would shrink as the display cap tightened.
    valueHeldLakh: round(sumOrNull(funds.map((f) => f.marketValueLakh)), 4),
    undisclosedValueCount: funds.filter((f) => f.marketValueLakh === null)
      .length,
    undisclosedWeightCount: funds.filter((f) => f.percentToNav === null).length,
    unlinkedFundCount: funds.filter((f) => f.amfiSchemeCode === null).length,
    funds: funds.slice(0, limit),
    entered,
    exited,
    unresolvedRowCount,
    nonEquityRowCount,
  };
}
