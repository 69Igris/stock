/**
 * NSE whole-market corporate announcements — PURE decisions (MONEY-1098 P5.1).
 *
 * Everything in this file is a total function of its arguments: no network, no
 * DB, no clock, no env. The I/O orchestration lives in
 * `nse-announcements-sync.ts`, which is deliberately thin — every judgement call
 * the sync makes (which window to ask for, what a filing IS, whether we already
 * have it from BSE, whether we're allowed to hit the attachment host again)
 * happens here so it can be tested without touching NSE.
 *
 * ## Why the dedupe lives here and not inline
 *
 * SEBI's single-filing regime (2025) means a company files ONCE and both
 * exchanges cross-disseminate the SAME document. We already ingest the BSE side
 * (`bse-announcements-sync.ts`), so the NSE leg would double every filing into
 * `StockDocument` — and a duplicate document is not a visible failure. It
 * embeds fine, it cites fine, it just quietly makes every RAG answer cite the
 * same PDF twice and inflates every per-symbol document count. Nothing turns
 * red. That is exactly the failure shape that needs a pure, exhaustively-tested
 * decision function rather than a condition buried in a loop.
 */

import {
  categorizeNseAnnouncement,
  type NseAnnouncementDocType,
} from "@usemoney/research/data-sources/nse-filings-logic";

// ── Constants ─────────────────────────────────────────────────────────────

/** The WHOLE-MARKET announcements endpoint (no `symbol` param). */
export const NSE_ANNOUNCEMENTS_PATH = "/api/corporate-announcements";

/** Attachment host. Cookieless — the PDFs are served without the API session. */
export const NSE_ARCHIVES_BASE = "https://nsearchives.nseindia.com";

/** Hosts an announcement attachment is allowed to live on. */
export const ALLOWED_ATTACHMENT_HOST_SUFFIX = "nseindia.com";

const DAY_MS = 24 * 60 * 60 * 1000;

/** IST is UTC+5:30 with no DST — a constant offset, so plain arithmetic works. */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Default fetch window, in CALENDAR DAYS INCLUSIVE. 2 = [yesterday, today].
 *
 * One day would be enough on paper (the job runs at 21:15 IST, after the 18:00
 * dissemination cut-off), but a filing broadcast after the run — or a run that
 * fails and is retried the next evening — would then be lost forever, because
 * nothing else ever revisits that date. The overlap day costs one extra API
 * call and makes a missed run self-healing.
 */
export const DEFAULT_WINDOW_DAYS = 2;

/** Refuse an absurd operator override; NSE rejects very wide windows anyway. */
export const MAX_WINDOW_DAYS = 31;

/** A real PDF is well over this; smaller responses are NSE error/challenge pages. */
export const MIN_PDF_BYTES = 1000;

/**
 * Wall-clock budget for one run's attachment downloading, in ms.
 *
 * 420s against the 600s Pub/Sub ack deadline (`--ack-deadline=600` in
 * setup-pubsub.sh), matching ownership-sync and report-archive-sync. The
 * per-run download CAP cannot serve this purpose: 500 downloads x 1500ms is
 * ~750s of sleep alone, so the cap's own comment about protecting the ack
 * deadline was arithmetically unable to hold.
 */
export const RUN_BUDGET_MS = 420_000;

/** Pace attachment downloads so nsearchives isn't hammered (matches BSE's leg). */
export const DELAY_BETWEEN_DOWNLOADS_MS = 1500;

/**
 * Per-run cap on attachment downloads. A whole-market 2-day window can surface
 * thousands of filings; at 1.5s each that would blow the Pub/Sub ack deadline
 * long before it finished. Filings past the cap are simply NOT recorded, so the
 * next run's window still covers them — see the "no row on failure" note on
 * {@link decideNseAnnouncementDedupe}'s caller.
 */
export const MAX_PDF_DOWNLOADS_PER_RUN = 500;

/**
 * Consecutive attachment failures that trip the run-level circuit breaker.
 *
 * NSE has no typed 429 (BSE does — `BseRateLimitError`); Akamai answers a
 * throttled client with a 403 challenge PAGE carrying a 200, which is
 * indistinguishable from "this one PDF is missing" at a single call site. Only
 * the RUN of failures carries the signal, so the breaker keys on consecutive
 * misses instead of on a status code.
 */
export const DOWNLOAD_FAILURE_BREAKER_THRESHOLD = 8;

/** GCS write deadline — bounded so one slow upload can't eat the ack budget. */
export const GCS_WRITE_TIMEOUT_MS = 30_000;

/** Attachment download deadline. */
export const ATTACHMENT_TIMEOUT_MS = 30_000;

/**
 * Title similarity at or above which two filings are considered the same
 * document. See {@link titleSimilarity} for why 0.9 on token-set Dice.
 */
export const DEDUPE_TITLE_SIMILARITY_THRESHOLD = 0.9;

/** Half-width of the dedupe time window, in days (±1 day). */
export const DEDUPE_WINDOW_DAYS = 1;

export const DEDUPE_WINDOW_MS = DEDUPE_WINDOW_DAYS * DAY_MS;

/** Max candidate rows to weigh per incoming filing (a bound, not a filter). */
export const DEDUPE_CANDIDATE_LIMIT = 200;

/**
 * The one desc this file adds a rule for.
 *
 * NSE ships transcripts and the intimations that PRECEDE them under a single
 * subject line — "Analysts/Institutional Investor Meet/Con. Call Updates" — so
 * the subject alone cannot tell them apart. The distinguishing evidence is in
 * `attchmntText` (NSE's own one-line description of the attached file), which
 * says "Transcript" for the real thing.
 *
 * Stored NORMALISED (see {@link normalizeDesc}) so punctuation drift on NSE's
 * side ("Con. Call" vs "Con Call", "Analysts /Institutional") cannot silently
 * stop matching it.
 */
export const CONCALL_UPDATE_DESC_KEY =
  "analysts institutional investor meet con call updates";

/**
 * docTypes a BSE `StockDocument` can ONLY be carrying because our own
 * title/attachment-name heuristics put it there (P1-FINDINGS).
 *
 * `bse-announcements-sync` writes every row as `corporate_filing`; anything
 * more specific on a BSE row came from a keyword classifier reading a title,
 * not from a field BSE published. That is what makes such a row `heuristic`
 * even before a `sourceConfidence` column exists to say so.
 */
export const BSE_HEURISTIC_DOC_TYPES: readonly string[] = [
  "concall_transcript",
  "earnings_call_intimation",
];

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * How much we trust a row's docType.
 *
 * `"unknown"` is a first-class value on purpose. The alternative — defaulting a
 * missing signal to `"confirmed"` — is a fail-open: it would silently grant
 * every legacy row the precedence that only evidence should earn.
 */
export type SourceConfidence = "confirmed" | "heuristic" | "unknown";

/**
 * The docTypes this worker can produce. Every member is also a member of
 * `StockDocType` (@usemoney/research/data-sources/stock-document-paths), so the
 * processor can hand these straight to the path builders.
 */
export type NseAnnouncementDocTypeExt =
  | NseAnnouncementDocType
  | "concall_transcript";

export interface ClassifiedAnnouncement {
  docType: NseAnnouncementDocTypeExt;
  confidence: SourceConfidence;
}

/** One normalised row of the whole-market announcements feed. */
export interface NseAnnouncementRow {
  /** NSE trading symbol, upper-cased. Always non-empty (rows without one are dropped). */
  symbol: string;
  /** The subject line (`desc`). */
  desc: string;
  /** NSE's description of the attached file (`attchmntText`). */
  attachmentText: string;
  /** Absolute, host-checked attachment URL, or null. */
  attachmentUrl: string | null;
  /** NSE's globally-unique announcement id (`seq_id`), as a string. */
  seqId: string | null;
  /** Company long name (`sm_name`), best-effort. */
  companyName: string;
  /** Broadcast timestamp, or null when NSE sent nothing parseable. */
  filedAt: Date | null;
}

export interface AnnouncementWindow {
  /** `DD-MM-YYYY` — the format NSE's query params take. */
  from: string;
  to: string;
  /** Effective inclusive span in calendar days. */
  windowDays: number;
}

/** The filing we are deciding whether to archive. */
export interface IncomingAnnouncement {
  symbol: string;
  docType: string;
  title: string;
  /**
   * Byte size of the fetched attachment. `null` (or <= 0) means WE DO NOT KNOW —
   * never that it matched something else of unknown size.
   */
  fileSize: number | null;
  /** Filing timestamp in ms. */
  filedAtMs: number;
  confidence: SourceConfidence;
}

/** An existing `StockDocument` the incoming filing might duplicate. */
export interface DedupeCandidate {
  id: string;
  symbol: string;
  docType: string;
  title: string;
  fileSize: number | null;
  /**
   * Best available timestamp. `StockDocument` has no filing-date column, so the
   * caller passes `fetchedAt` — both legs sync within an hour of each other on
   * the same evening, well inside the ±1 day window.
   */
  filedAtMs: number;
  sourceType: string;
  /** Present only once the BSE leg persists it; absent today (see derive helper). */
  sourceConfidence?: string | null;
}

export type DedupeReason =
  /** Nothing to compare against. */
  | "no-candidates"
  /** A candidate cleared every gate — this filing is already stored. */
  | "duplicate"
  /** Gates cleared, but a CONFIRMED transcript outranks a heuristic row of another docType. */
  | "confirmed-over-heuristic"
  /** Candidates existed but none cleared the gates. */
  | "no-match";

export interface DedupeDecision {
  /** True = do not archive; the document is already in `StockDocument`. */
  skip: boolean;
  reason: DedupeReason;
  /** The row that decided it (the duplicate, or the one we overrode). */
  matchedId: string | null;
  /** Title similarity of {@link matchedId}, when one was chosen. */
  similarity: number | null;
}

export interface PacingState {
  /** Downloads ATTEMPTED so far this run (successes and failures alike). */
  attempted: number;
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
}

export type PacingReason =
  | "ok"
  | "no-attachment"
  | "run-cap"
  | "circuit-open"
  /**
   * Wall-clock budget spent. MONEY-1098: the run cap alone cannot bound this
   * job — MAX_PDF_DOWNLOADS_PER_RUN × DELAY_BETWEEN_DOWNLOADS_MS is ~750s of
   * pure sleep, PAST the 600s Pub/Sub ack deadline the cap exists to protect.
   * Once the deadline expires Pub/Sub redelivers onto the still-live run (the
   * Cloud Run timeout is 3600s), so a second concurrent whole-market NSE walk
   * starts re-downloading everything, and after 5 attempts the message
   * dead-letters. Same guard the ownership / report-archive / annual-reports
   * siblings already carry.
   */
  | "budget-spent";

export interface PacingPlan {
  shouldDownload: boolean;
  /** ms to sleep BEFORE this download. 0 for the first one and for every skip. */
  delayMs: number;
  reason: PacingReason;
}

// ── Window ────────────────────────────────────────────────────────────────

/**
 * Format an instant as NSE's `DD-MM-YYYY` **in IST**.
 *
 * The date must be the Indian calendar date, not the UTC one. The job runs at
 * 21:15 IST (15:45 UTC) so today they agree — but a manual re-run, a retry that
 * slips past 05:30 IST, or a backfill anchored on an explicit date would ask
 * NSE for the wrong day if this used UTC. Cheap to get right, invisible when
 * wrong.
 */
export function formatIstDate(instant: Date): string {
  const ist = new Date(instant.getTime() + IST_OFFSET_MS);
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${ist.getUTCFullYear()}`;
}

/** `YYYY-MM-DD` → the UTC instant of that IST calendar date, or null. */
function parseIsoDay(day: string | undefined): Date | null {
  if (!day) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Compute the `[from, to]` window to ask NSE for.
 *
 * `opts.toDate` / `opts.fromDate` are `YYYY-MM-DD` operator overrides (the
 * Pub/Sub message shape); anything unparseable is IGNORED rather than throwing,
 * because a typo'd manual publish should still archive the default window
 * rather than dead-letter the whole run.
 */
export function computeAnnouncementWindow(
  now: Date,
  opts: { fromDate?: string; toDate?: string; windowDays?: number } = {},
): AnnouncementWindow {
  const requested = Number(opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const windowDays = Number.isFinite(requested)
    ? Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(requested)))
    : DEFAULT_WINDOW_DAYS;

  const anchor = parseIsoDay(opts.toDate) ?? now;
  const explicitFrom = parseIsoDay(opts.fromDate);
  const from =
    explicitFrom ?? new Date(anchor.getTime() - (windowDays - 1) * DAY_MS);

  // An explicit from AFTER to is a mistake, not an empty window — swap rather
  // than silently asking NSE for a range it answers with [].
  const [lo, hi] =
    from.getTime() <= anchor.getTime() ? [from, anchor] : [anchor, from];

  return {
    from: formatIstDate(lo),
    to: formatIstDate(hi),
    windowDays: explicitFrom
      ? Math.max(1, Math.round((hi.getTime() - lo.getTime()) / DAY_MS) + 1)
      : windowDays,
  };
}

/** Build the cookie-gated API path (query string included) for a window. */
export function buildAnnouncementsPath(
  window: Pick<AnnouncementWindow, "from" | "to">,
  index = "equities",
): string {
  const params = new URLSearchParams({
    index,
    from_date: window.from,
    to_date: window.to,
  });
  return `${NSE_ANNOUNCEMENTS_PATH}?${params.toString()}`;
}

// ── Feed parsing ──────────────────────────────────────────────────────────

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parse an NSE timestamp (`an_dt` = "05-Aug-2026 18:14:59", `sort_date` =
 * "2026-08-05 18:14:59") into a real instant, treating the wall-clock as IST.
 *
 * Returns `null` — never an `Invalid Date`. `new Date("garbage")` is truthy and
 * poisons every downstream `getTime()` with NaN, which is precisely the
 * Invalid-Date class MONEY-620 fixed in the sibling NSE parser; the same guard
 * belongs here.
 */
export function parseNseTimestamp(raw: unknown): Date | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  const dmy = /^(\d{1,2})-([A-Za-z]{3,})-(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
    s,
  );
  if (dmy) {
    const month = MONTH_INDEX[dmy[2]!.slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return istWallClock(
      Number(dmy[3]),
      month,
      Number(dmy[1]),
      Number(dmy[4] ?? 0),
      Number(dmy[5] ?? 0),
      Number(dmy[6] ?? 0),
    );
  }

  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
    s,
  );
  if (ymd) {
    return istWallClock(
      Number(ymd[1]),
      Number(ymd[2]) - 1,
      Number(ymd[3]),
      Number(ymd[4] ?? 0),
      Number(ymd[5] ?? 0),
      Number(ymd[6] ?? 0),
    );
  }

  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function istWallClock(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date | null {
  const utc =
    Date.UTC(year, monthIndex, day, hour, minute, second) - IST_OFFSET_MS;
  const d = new Date(utc);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve `attchmntFile` into an absolute URL we are willing to fetch.
 *
 * Host-checked on purpose: the value is upstream-controlled text that this
 * worker turns into an outbound request. Restricting it to `*.nseindia.com`
 * means a compromised or malformed feed row cannot point our Cloud Run service
 * at an arbitrary host. Returns null for anything empty, non-http, or off-host.
 */
export function resolveAttachmentUrl(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;

  // Anything carrying a SCHEME is treated as absolute and must be http(s).
  // Testing only for `^https?://` and otherwise assuming "relative" is the bug
  // that lets `javascript:alert(1)` through as
  // `https://nsearchives.nseindia.com/javascript:alert(1)` — on-host, so the
  // host check below waves it past.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return null;

  const absolute = scheme
    ? value
    : `${NSE_ARCHIVES_BASE}${value.startsWith("/") ? "" : "/"}${value}`;

  let host: string;
  try {
    const parsed = new URL(absolute);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  const onHost =
    host === ALLOWED_ATTACHMENT_HOST_SUFFIX ||
    host.endsWith(`.${ALLOWED_ATTACHMENT_HOST_SUFFIX}`);
  return onHost ? absolute : null;
}

/**
 * Normalise the whole-market response into rows.
 *
 * Accepts the bare array NSE returns today and a `{ data: [...] }` envelope,
 * because the per-symbol and bulk NSE endpoints already disagree about that and
 * a shape change would otherwise read as "market holiday, zero filings".
 * Rows with no usable symbol are dropped — a `StockDocument` cannot be keyed
 * without one.
 */
export function parseNseAnnouncementRows(resp: unknown): NseAnnouncementRow[] {
  const list = Array.isArray(resp)
    ? resp
    : Array.isArray((resp as { data?: unknown } | null)?.data)
      ? ((resp as { data: unknown[] }).data)
      : [];

  const out: NseAnnouncementRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;

    const symbol =
      typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    if (!symbol) continue;

    const seqRaw = row.seq_id;
    const seqId =
      typeof seqRaw === "string" && seqRaw.trim()
        ? seqRaw.trim()
        : typeof seqRaw === "number" && Number.isFinite(seqRaw)
          ? String(seqRaw)
          : null;

    out.push({
      symbol,
      desc: typeof row.desc === "string" ? row.desc : "",
      attachmentText:
        typeof row.attchmntText === "string" ? row.attchmntText : "",
      attachmentUrl: resolveAttachmentUrl(row.attchmntFile),
      seqId,
      companyName: typeof row.sm_name === "string" ? row.sm_name : "",
      filedAt: parseNseTimestamp(row.an_dt) ?? parseNseTimestamp(row.sort_date),
    });
  }
  return out;
}

// ── Classification ────────────────────────────────────────────────────────

/** Lower-case and collapse every run of non-alphanumerics to a single space. */
export function normalizeDesc(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Classify an announcement, EXTENDING `categorizeNseAnnouncement` with the one
 * rule P5.1 adds. Returns `null` for announcements not worth ingesting.
 *
 * The added rule has to run FIRST, not last: the base categoriser sees
 * "Investor Meet" inside "Analysts/Institutional Investor Meet/Con. Call
 * Updates" and buckets the whole family as `investor_presentation`, so a
 * post-hoc refinement would never see the rows it is meant to fix. Under NSE's
 * single subject line that means every concall transcript on the exchange has
 * been landing as an investor presentation — right PDF, wrong shelf, and the
 * per-docType concall chunker (speaker-turn splitting) never ran on any of them.
 *
 * Confidence, and why it is not cosmetic:
 *   - `concall_transcript` here is `"confirmed"` — NSE's own `attchmntText`
 *     names the attachment a Transcript. That is published evidence.
 *   - Everything else is `"heuristic"` — our keyword match over a subject line.
 * {@link decideNseAnnouncementDedupe} lets the first outrank a heuristic BSE row
 * of a different docType, and nothing else does.
 */
export function classifyNseAnnouncement(
  desc: string,
  attachmentText: string,
): ClassifiedAnnouncement | null {
  if (normalizeDesc(desc).includes(CONCALL_UPDATE_DESC_KEY)) {
    return /transcript/i.test(attachmentText ?? "")
      ? { docType: "concall_transcript", confidence: "confirmed" }
      : { docType: "earnings_call_intimation", confidence: "heuristic" };
  }

  const base = categorizeNseAnnouncement(desc, attachmentText);
  return base ? { docType: base, confidence: "heuristic" } : null;
}

/**
 * `StockDocument.period` for an announcement.
 *
 * `nse-{seq_id}` per the P5.1 contract: `seq_id` is globally unique on NSE, so
 * two filings by the same company on the same day stay distinct while a re-run
 * of the SAME filing lands on the same `@@unique([symbol, exchange, docType,
 * period])` key and upserts in place. The fallback (date + a hash of the
 * subject) exists only for rows NSE sends without one; it keeps same-day
 * filings distinct without pretending to be stable across a re-worded subject.
 */
export function buildAnnouncementPeriod(
  seqId: string | null | undefined,
  fallback: { filedAt: Date | null; desc: string },
): string {
  const seq = (seqId ?? "").trim();
  if (seq) return `nse-${seq.replace(/[^A-Za-z0-9_-]/g, "")}`;

  const stamp = fallback.filedAt
    ? formatIstDate(fallback.filedAt).split("-").reverse().join("")
    : "unknown";
  let h = 0;
  for (let i = 0; i < fallback.desc.length; i++) {
    h = (Math.imul(h, 31) + fallback.desc.charCodeAt(i)) >>> 0;
  }
  return `nse-${stamp}-${h.toString(36)}`;
}

/** Split a full GCS object path into the `folder` + `fileName` `uploadFile` wants. */
export function splitGcsPath(path: string): {
  folder: string;
  fileName: string;
} {
  const i = path.lastIndexOf("/");
  return i < 0
    ? { folder: "", fileName: path }
    : { folder: path.slice(0, i), fileName: path.slice(i + 1) };
}

// ── Dedupe ────────────────────────────────────────────────────────────────

/**
 * Strip a trailing plural `s`, which is the ONE morphological difference that
 * actually shows up between the two exchanges' renderings of the same subject
 * ("Analysts/Institutional Investor Meet" vs "Analyst / Institutional Investor
 * Meet"; "Updates" vs "Update"). Without it that real pair scores 0.857 and
 * slips under the 0.9 threshold — a duplicate archived because of one letter.
 *
 * Guarded: only tokens of 4+ chars, and never one ending in `ss` ("loss",
 * "business", "class"). Both sides are normalised identically, so even a
 * clumsy stem stays consistent — the only way it could hurt is by collapsing
 * two genuinely different words, and that would have to happen to ~90% of a
 * title's tokens to change any decision.
 */
function singularize(token: string): string {
  return token.length >= 4 && token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}

/** Tokens of a title: lower-cased alphanumeric runs, de-pluralised, unordered. */
export function tokenizeTitle(title: unknown): string[] {
  const n = normalizeDesc(title);
  return n ? n.split(" ").map(singularize) : [];
}

/**
 * Similarity of two filing titles — **Sørensen–Dice over token SETS**:
 * `2·|A∩B| / (|A|+|B|)`, in [0, 1].
 *
 * Why token-set Dice and not character trigrams:
 *
 *  1. The variance we must tolerate is BOILERPLATE and PUNCTUATION, not
 *     spelling. The same SEBI filing reaches us as NSE's
 *     "Analysts/Institutional Investor Meet/Con. Call Updates" and BSE's
 *     "Analyst / Institutional Investor Meet - Con Call Updates". Tokenising on
 *     non-alphanumerics erases that difference completely; trigrams keep it,
 *     because every changed separator rewrites three grams around it.
 *  2. Word ORDER differs between the two front-ends ("Intimation of Board
 *     Meeting" vs "Board Meeting Intimation"). A set comparison is order-free by
 *     construction; a trigram profile is not.
 *  3. Cost. This runs for every candidate of every filing in a whole-market
 *     window — thousands of comparisons a night. A title yields ~10 tokens and
 *     ~90 trigrams, so trigrams would be an order of magnitude more allocation
 *     for a measure that is WORSE on (1) and (2).
 *
 * Two empty titles score 0, not 1. "Neither has a title" is not evidence that
 * they are the same document, and scoring it 1 would make an untitled row match
 * everything.
 */
export function titleSimilarity(a: unknown, b: unknown): number {
  const setA = new Set(tokenizeTitle(a));
  const setB = new Set(tokenizeTitle(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  return (2 * intersection) / (setA.size + setB.size);
}

/**
 * How much to trust an existing row's docType.
 *
 * Reads a persisted `sourceConfidence` when one exists (it does not today — see
 * the report), and otherwise DERIVES it: `bse-announcements-sync` writes every
 * row as `corporate_filing`, so a BSE row carrying `concall_transcript` or
 * `earnings_call_intimation` can only have got there through a title/
 * attachment-name heuristic. Anything else is `"unknown"` — deliberately not
 * `"confirmed"`, which is a claim no evidence supports.
 */
export function deriveCandidateConfidence(row: {
  sourceType: string;
  docType: string;
  sourceConfidence?: string | null;
}): SourceConfidence {
  const declared = row.sourceConfidence;
  if (declared === "confirmed" || declared === "heuristic") return declared;
  if (
    row.sourceType.toUpperCase() === "BSE" &&
    BSE_HEURISTIC_DOC_TYPES.includes(row.docType)
  ) {
    return "heuristic";
  }
  return "unknown";
}

/** A usable byte size, or null. 0 means "we never fetched it", not "empty file". */
function usableSize(size: number | null | undefined): number | null {
  return typeof size === "number" && Number.isFinite(size) && size > 0
    ? size
    : null;
}

/**
 * Decide whether an NSE filing is already stored (as the BSE leg's copy of the
 * same cross-disseminated document) and must NOT be archived again.
 *
 * All three gates must pass for a candidate to count as the same document:
 *   - same symbol,
 *   - IDENTICAL attachment byte size — cross-dissemination ships the same PDF,
 *     so this is near-conclusive on its own, and
 *   - title similarity >= {@link DEDUPE_TITLE_SIMILARITY_THRESHOLD}, within
 *     ±{@link DEDUPE_WINDOW_DAYS} day.
 *
 * A size of 0/null on EITHER side is "unknown", never a match. That distinction
 * is the whole ball game: `bse-announcements-sync` stores `fileSize: 0` on every
 * row whose PDF it failed to download, so treating 0 == 0 as equality would make
 * every failed BSE row a universal duplicate and silently suppress the NSE copy
 * of every filing that day — the one outcome worse than double-counting.
 *
 * **Precedence (P1-FINDINGS).** A heuristic BSE row is a perfectly good dedupe
 * TARGET — that is the normal case and it still wins. It is *not* a reason to
 * drop a CONFIRMED NSE transcript that it classified as something else: an
 * `earnings_call_intimation` guessed from a title is not the transcript, and
 * suppressing the transcript would leave the corpus permanently without it.
 * When the incoming filing is confirmed and the matching row is heuristic AND of
 * a different docType, we archive anyway — the `@@unique` key differs on
 * docType, so both rows coexist.
 */
export function decideNseAnnouncementDedupe(
  incoming: IncomingAnnouncement,
  candidates: readonly DedupeCandidate[],
): DedupeDecision {
  if (candidates.length === 0) {
    return {
      skip: false,
      reason: "no-candidates",
      matchedId: null,
      similarity: null,
    };
  }

  const incomingSize = usableSize(incoming.fileSize);
  let override: { id: string; similarity: number } | null = null;

  for (const candidate of candidates) {
    if (candidate.symbol !== incoming.symbol) continue;

    const candidateSize = usableSize(candidate.fileSize);
    if (incomingSize === null || candidateSize === null) continue;
    if (incomingSize !== candidateSize) continue;

    if (
      Math.abs(incoming.filedAtMs - candidate.filedAtMs) > DEDUPE_WINDOW_MS
    ) {
      continue;
    }

    const similarity = titleSimilarity(incoming.title, candidate.title);
    if (similarity < DEDUPE_TITLE_SIMILARITY_THRESHOLD) continue;

    const confidence = deriveCandidateConfidence(candidate);
    if (
      incoming.confidence === "confirmed" &&
      confidence === "heuristic" &&
      candidate.docType !== incoming.docType
    ) {
      // Remember it, but keep looking: another candidate may be a true
      // same-docType duplicate, and THAT still wins.
      override ??= { id: candidate.id, similarity };
      continue;
    }

    return {
      skip: true,
      reason: "duplicate",
      matchedId: candidate.id,
      similarity,
    };
  }

  if (override) {
    return {
      skip: false,
      reason: "confirmed-over-heuristic",
      matchedId: override.id,
      similarity: override.similarity,
    };
  }

  return { skip: false, reason: "no-match", matchedId: null, similarity: null };
}

// ── Pacing ────────────────────────────────────────────────────────────────

/**
 * Decide whether to download the next attachment, and how long to wait first.
 *
 * Pure so the four ways a run stops hitting nsearchives — no attachment, the
 * per-run cap, the consecutive-failure breaker, the wall-clock budget — are
 * testable without a clock or a socket (the caller passes elapsed ms rather
 * than this reading `Date.now()`). `delayMs` is 0 for the FIRST download and
 * for every skip: charging a 1.5s sleep to a row we then decline to fetch would
 * turn a window full of attachment-less announcements into a multi-minute
 * no-op.
 */
export function planPdfDownload(
  state: PacingState,
  opts: {
    hasAttachment: boolean;
    maxDownloads?: number;
    delayMs?: number;
    breakerThreshold?: number;
    /** Wall-clock ms already spent by this run. */
    elapsedMs?: number;
    /** Budget in ms (default {@link RUN_BUDGET_MS}). */
    budgetMs?: number;
  },
): PacingPlan {
  const maxDownloads = opts.maxDownloads ?? MAX_PDF_DOWNLOADS_PER_RUN;
  const delay = opts.delayMs ?? DELAY_BETWEEN_DOWNLOADS_MS;
  const threshold =
    opts.breakerThreshold ?? DOWNLOAD_FAILURE_BREAKER_THRESHOLD;
  const budget = opts.budgetMs ?? RUN_BUDGET_MS;

  if (!opts.hasAttachment) {
    return { shouldDownload: false, delayMs: 0, reason: "no-attachment" };
  }
  if (state.consecutiveFailures >= threshold) {
    return { shouldDownload: false, delayMs: 0, reason: "circuit-open" };
  }
  if (state.attempted >= maxDownloads) {
    return { shouldDownload: false, delayMs: 0, reason: "run-cap" };
  }
  // Checked AFTER the terminal reasons so their messages stay the ones an
  // operator sees when they are the real cause, and BEFORE issuing a fetch
  // that would carry the run past the ack deadline.
  if (opts.elapsedMs !== undefined && opts.elapsedMs >= budget) {
    return { shouldDownload: false, delayMs: 0, reason: "budget-spent" };
  }
  return {
    shouldDownload: true,
    delayMs: state.attempted > 0 ? delay : 0,
    reason: "ok",
  };
}

/**
 * Is a downloaded body actually a PDF — magic bytes AND plausible size?
 *
 * Size alone is not enough, and the gap was not theoretical: NSE answers a
 * throttled client with a 200-carrying Akamai challenge PAGE, ~3.9 KB in this
 * repo's own probe captures, which clears any byte-count floor. Those pages
 * were being uploaded to GCS as `application/pdf`, upserted as PENDING
 * `StockDocument` rows whose `nse-{seqId}` period key makes every later run
 * skip them as already-stored (so the real filing is never fetched again), fed
 * to the Document-AI extract chain, and — worst — counted as SUCCESSES that
 * reset the consecutive-failure breaker, disarming it exactly when NSE is
 * throttling.
 *
 * `%PDF` is the format's required header (ISO 32000 §7.5.2). This is the same
 * check `feed-repair.ts` applies for the same class of incident (MONEY-1169);
 * this ingest path simply never got it.
 *
 * Accepts the BYTES, not a length — a predicate that cannot see the content
 * cannot answer the question its own docstring claims to answer.
 */
export function isUsablePdf(body: Uint8Array | null | undefined): boolean {
  if (!body || body.length < MIN_PDF_BYTES) return false;
  // "%PDF" — allowed to sit after a small amount of leading junk, which some
  // real-world producers emit; the spec says the header is at the start, but
  // readers tolerate a short offset and so do we.
  const head = Buffer.from(
    body.subarray(0, Math.min(body.length, 1024)),
  ).toString("latin1");
  return head.includes("%PDF-");
}
