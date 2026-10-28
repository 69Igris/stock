/**
 * BSE India API Client (MONEY-852)
 *
 * Free, public BSE endpoints for ALL-stock corporate actions + corporate
 * announcements. Unlike NSE, BSE's `api.bseindia.com` does NOT use a cookie
 * session — it gates on browser-like headers instead (an `Origin` / `Referer`
 * of `https://www.bseindia.com/` plus a real `User-Agent`). Sending a cookie is
 * unnecessary and the calls 403 without the Origin/Referer pair.
 *
 * Two surfaces:
 *   1. {@link fetchBSECorporateActions} — `DefaultData/w` (blank `scripcode` =
 *      every scrip in the window). BSE encodes the action class as a numeric
 *      `Purposecode` (P5 Bonus, P6 Buyback, P9 Dividend, P26 Split, P29
 *      Delisting, …) AND repeats it as free-text in `Purpose`; we map the code
 *      first, fall back to the NSE/Screener free-text parser for ratio/FV/
 *      dividend so a BSE split/bonus merges cleanly with the NSE rows in the
 *      `CorporateAction` table.
 *   2. {@link fetchBSEAnnouncementsByCategory} — `AnnSubCategoryGetData/w`
 *      (blank `strScrip` = all scrips), paginated by `pageno` and walked ONCE
 *      PER CATEGORY. `strCat` takes a category NAME and has no "all" value —
 *      the `-1` this used to send matched nothing and returned `{}` under a
 *      200, which is why the job wrote zero rows for its whole life
 *      (MONEY-1255). Each row points at a PDF under
 *      `bseindia.com/xml-data/corpfiling/AttachLive/{file}` which the worker
 *      archives to GCS + a `StockDocument`.
 *
 * The pure parse/normalize helpers (`mapBsePurposeCode`, `parseBseActionRow`,
 * `parseBseAnnouncementRow`, `formatBseDate`) are exported for unit testing
 * WITHOUT network IO — the network fns delegate to them.
 */

import { parseActionSubject, safeOptionalDate } from "./nse-filings-logic";
import {
  fetchInWindows,
  type WindowedFetchResult,
  toUtcDay,
  MAX_CORP_ACTION_WINDOW_DAYS,
} from "./corp-actions-window";
import type {
  NSECorporateAction,
  CorporateActionType,
} from "./nse-filings-types";

const logger = {
  info: (...args: unknown[]) => console.log("[bse-client]", ...args),
  warn: (...args: unknown[]) => console.warn("[bse-client]", ...args),
  error: (...args: unknown[]) => console.error("[bse-client]", ...args),
};

const BSE_API_BASE =
  process.env.BSE_API_BASE_URL || "https://api.bseindia.com/BseIndiaAPI/api";
/** PDF attachments live on the main site, not the API host. */
export const BSE_ATTACHMENT_BASE =
  "https://www.bseindia.com/xml-data/corpfiling/AttachLive";
const API_TIMEOUT_MS = 15_000;

// BSE's `api.bseindia.com` rate-limits with HTTP 429 under heavy pagination /
// whole-market pulls. Mirror the Screener treatment (see screener-full-scraper):
// retry with exponential backoff (honouring `Retry-After`) and, on a PERSISTENT
// 429, throw `BseRateLimitError` so the worker can circuit-break the run instead
// of hammering a tarpit. The defaults are env-overridable AND read per-call so
// tests can shrink the backoff (a 5s base × 4 retries would be ~75s otherwise).
const BSE_MAX_RETRIES_DEFAULT = 4;
const BSE_BACKOFF_BASE_MS_DEFAULT = 5_000;

/**
 * Ceiling on ONE window's whole request cycle, retries included.
 *
 * `AbortSignal.timeout` already bounds each individual `fetch`, which is not the
 * same thing as bounding the operation: on the MONEY-1189 heal run the backfill
 * sat for 14+ minutes inside a single BSE window with **zero open sockets and
 * zero CPU** — no network in flight, no 429 backoff (each of those logs, and
 * none did), just a promise that was never going to settle. Nothing downstream
 * could tell that from slow progress, and the run had to be killed by hand.
 *
 * Generous enough to clear the legitimate worst case (4 retries at a 5s
 * exponential base is ~75s, plus four 15s fetches), because killing a healthy
 * whole-market pull would trade a rare hang for a common failure. It only has
 * to be shorter than forever.
 *
 * READ PER CALL, exactly like {@link bseRetryConfig} above and for the same
 * stated reason — a module-level `const` captures the value at import, so a
 * test setting the env var afterwards silently gets the 180s default. That is
 * not a hypothetical: the first version was a const, its own test therefore
 * waited the full three minutes, and the file blew the 30s per-file limit.
 */
function bseWindowCeilingMs(): number {
  const v = Number(process.env.BSE_WINDOW_CEILING_MS);
  return Number.isFinite(v) && v > 0 ? v : 180_000;
}

/**
 * Reject if `fn` has not settled within `ms`, always clearing the timer.
 *
 * Local rather than imported: `@usemoney/research` does not depend on
 * `@usemoney/core`, and this file already owns its own HTTP concerns.
 */
async function withCeiling<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`BSE window exceeded ${ms}ms ceiling: ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown when BSE keeps returning 429 after the retry budget is exhausted. */
export class BseRateLimitError extends Error {
  constructor(context: string) {
    super(`BSE rate-limited (429) for ${context} after retries`);
    this.name = "BseRateLimitError";
  }
}

/** Per-call 429 retry/backoff config (env-tunable; read per-call for tests). */
function bseRetryConfig(): { maxRetries: number; backoffBaseMs: number } {
  const r = Number(process.env.BSE_MAX_RETRIES);
  const b = Number(process.env.BSE_BACKOFF_BASE_MS);
  return {
    maxRetries: Number.isFinite(r) && r >= 0 ? r : BSE_MAX_RETRIES_DEFAULT,
    backoffBaseMs:
      Number.isFinite(b) && b > 0 ? b : BSE_BACKOFF_BASE_MS_DEFAULT,
  };
}

function bseDelay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Required browser-like headers. BSE 403s without the Origin/Referer pair; a
 * cookie is NOT needed (and is deliberately omitted). Shared by both endpoints.
 */
const BSE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.bseindia.com",
  Referer: "https://www.bseindia.com/",
};

// ── Purpose-code → normalized type ────────────────────────────────────────
//
// BSE's `DefaultData/w` keys the action class on a numeric purpose code. The
// codes are stable; the free-text `Purpose` repeats the same class plus the
// ratio/amount detail. Map the code first (reliable), and only fall back to the
// free-text classifier when the code is unknown.

/** Known BSE corporate-action purpose codes → {@link CorporateActionType}. */
export const BSE_PURPOSE_CODE_MAP: Record<string, CorporateActionType> = {
  P5: "BONUS", // Bonus issue
  P6: "BUYBACK", // Buy Back of Shares
  P9: "DIVIDEND", // Dividend
  P26: "SPLIT", // Stock / Sub-Division (Face Value Split)
  P29: "OTHER", // Delisting of Shares (no dedicated enum; kept as OTHER)
};

/**
 * Map a BSE purpose code (e.g. "P26" or bare "26") to a normalized action type.
 * Falls back to classifying the free-text purpose when the code is missing /
 * unknown, so a new BSE code we haven't enumerated still lands on the right type
 * whenever the free text is descriptive (e.g. "Bonus issue 1:1").
 */
export function mapBsePurposeCode(
  code: string | null | undefined,
  purposeText = "",
): CorporateActionType {
  const raw = (code || "").trim().toUpperCase();
  const normalized = raw.startsWith("P") ? raw : raw ? `P${raw}` : "";
  const mapped = BSE_PURPOSE_CODE_MAP[normalized];
  // A concrete code wins. Only when the code is missing/unknown — OR it's the
  // catch-all OTHER and we have descriptive free text — do we fall back to the
  // shared free-text classifier (so "Bonus issue 1:1" still lands on BONUS).
  if (mapped && mapped !== "OTHER") return mapped;
  const fromText = parseActionSubject(purposeText).type;
  if (fromText !== "OTHER") return fromText;
  return mapped ?? "OTHER";
}

// ── Date formatting (dd MMM yyyy) ─────────────────────────────────────────

const BSE_MONTH_ABBR = [
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

/**
 * Format a `Date` as BSE's `DefaultData/w` window format `dd MMM yyyy`
 * (e.g. `15 Mar 2024`). Accepts a `Date` or a `YYYY-MM-DD` string.
 */
export function formatBseDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(`${d}T00:00:00Z`) : d;
  if (Number.isNaN(date.getTime())) return "";
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mmm = BSE_MONTH_ABBR[date.getUTCMonth()];
  const yyyy = date.getUTCFullYear();
  return `${dd} ${mmm} ${yyyy}`;
}

/**
 * Format a `Date` as BSE's `AnnSubCategoryGetData/w` window format `yyyymmdd`
 * (e.g. `20240315`). Accepts a `Date` or a `YYYY-MM-DD` string.
 */
export function formatBseCompactDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(`${d}T00:00:00Z`) : d;
  if (Number.isNaN(date.getTime())) return "";
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// ── Corporate-action row parsing ──────────────────────────────────────────

/**
 * Parse ONE BSE `DefaultData/w` corporate-action row into the shared
 * `NSECorporateAction` shape so it merges with the NSE rows downstream.
 *
 * BSE field names (observed): `scrip_code` / `scripcode`, `short_name` /
 * `Short_Name`, `Purpose` (free text), `Purposecode` / `purpose_code`,
 * `Ex_date` / `ExDate`, `RD_Date` / `RecordDate`. We tolerate the casing
 * variants. Returns `null` when there's no usable symbol AND no scrip code (the
 * row can't be keyed). The ratio / face-value / dividend come from the SAME
 * free-text parser the NSE source uses (`parseActionSubject`), so a BSE
 * "Stock 1:5" or "Bonus 1:1" yields the identical structured ratio.
 */
export function parseBseActionRow(
  row: Record<string, unknown>,
): NSECorporateAction | null {
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return "";
  };

  const purpose = str("Purpose", "purpose", "LongName", "long_name");
  const purposeCode = str("Purposecode", "purpose_code", "PurposeCode");
  const symbolText = str("short_name", "Short_Name", "scrip_name", "ScripName");
  const scripCode = str("scrip_code", "scripcode", "ScripCode", "Scrip_Cd");

  // Prefer the alpha short_name as the symbol; fall back to the numeric scrip
  // code so the row is still keyable (BSE scrip codes are stable identifiers).
  const symbol = (symbolText || scripCode).toUpperCase();
  if (!symbol) return null;

  const type = mapBsePurposeCode(purposeCode, purpose);
  const parsed = parseActionSubject(purpose);

  return {
    symbol,
    actionType: purpose.toUpperCase(),
    type,
    exDate: safeOptionalDate(str("Ex_date", "ExDate", "ex_date")),
    recordDate: safeOptionalDate(str("RD_Date", "RecordDate", "record_date")),
    // The free-text parser only fills ratio/FV/dividend for the type it
    // classified; when the purpose CODE disagrees (e.g. code=SPLIT but text is
    // terse) the structured fields fall back to null rather than mis-attribute.
    ratio: parsed.type === type ? parsed.ratio : null,
    oldFaceValue: parsed.type === type ? parsed.oldFaceValue : null,
    newFaceValue: parsed.type === type ? parsed.newFaceValue : null,
    dividendPerShare: parsed.type === type ? parsed.dividendPerShare : null,
    details: purpose,
    rawData: row,
  };
}

/**
 * Parse a full BSE `DefaultData/w` response (an array, or `{ Table: [...] }`)
 * into `NSECorporateAction[]`. Non-array / empty payloads → `[]`.
 */
export function parseBseCorporateActions(resp: unknown): NSECorporateAction[] {
  const rows = extractBseRows(resp);
  const out: NSECorporateAction[] = [];
  for (const row of rows) {
    const parsed = parseBseActionRow(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ── Announcement row parsing ──────────────────────────────────────────────

/**
 * A normalized BSE corporate announcement, ready to upsert as a `StockDocument`.
 * `pdfUrl` is the absolute attachment URL (null when the row has no attachment).
 */
export interface BseAnnouncement {
  /** BSE numeric scrip code (e.g. "500325"). */
  scripCode: string;
  /** Alpha symbol / short name when present (e.g. "RELIANCE"). */
  symbol: string;
  /** Company long name (e.g. "Reliance Industries Ltd") — most reliable field
   *  for instrument resolution when no alpha symbol is present. */
  company: string;
  /** Headline / subject. */
  title: string;
  /** Longer body text when present. */
  description: string;
  /**
   * BSE's TOP-LEVEL category — `CATEGORYNAME` and nothing else.
   *
   * One of {@link BSE_ANNOUNCEMENT_CATEGORIES}; the same nine strings
   * `strCat` is queried with. This field used to be
   * `CATEGORYNAME || SUBCATNAME`, which made classification impossible: a
   * "Result" row and a "Financial Results" row were the same value to every
   * reader, and a row whose CATEGORYNAME was absent silently presented its
   * SUBCATNAME as a category that `strCat` would never accept.
   */
  category: string;
  /**
   * BSE's SECOND-LEVEL label — `SUBCATNAME` and nothing else (e.g. "Financial
   * Results" under "Result"). Empty when the row carries none.
   */
  subcategory: string;
  /** Absolute PDF attachment URL, or null. */
  pdfUrl: string | null;
  /** Stable BSE news id (dedupe key component). */
  newsId: string;
  /**
   * `XML_NAME` — BSE's own filing identifier, e.g.
   * `ANN_530127_AD76AC5C-…`.
   *
   * Carried through because it is the BREADCRUMB from an announcement row to
   * BSE's XBRL corpus: the announcement API never returns the XBRL document,
   * and this string is what a later discovery pass has to resolve it by. It
   * was parsed off the wire and dropped on the floor before MONEY-1255, so a
   * consumer had no way to get it back short of re-fetching the window.
   */
  xmlName: string;
  /**
   * `QUARTER_ID` — BSE's own period identifier, verbatim and UNINTERPRETED.
   *
   * Kept as the raw string because no sample of its encoding was available:
   * `derivePeriodEnd` uses it only as a CROSS-CHECK on the subject line and
   * only when it is self-evidently a date, never as a source. Storing it
   * parsed would have meant inventing a decoding.
   */
  quarterId: string;
  /** Publish timestamp (valid Date or null — never Invalid Date). */
  publishedAt: Date | null;
}

/**
 * Parse ONE BSE `AnnSubCategoryGetData/w` row into a {@link BseAnnouncement}.
 *
 * Field names (observed): `SCRIP_CD` / `scrip_cd`, `SLONGNAME` / `slongname`
 * (company), `NEWSSUB` / `HEADLINE` (subject), `NEWSID` / `NEWS_ID`,
 * `ATTACHMENTNAME` / `Attachment` (PDF file name), `NEWS_DT` / `News_submission_dt`
 * (timestamp), `CATEGORYNAME` / `SUBCATNAME` (category). Returns `null` when the
 * row has no scrip code (can't resolve to an instrument).
 */
export function parseBseAnnouncementRow(
  row: Record<string, unknown>,
): BseAnnouncement | null {
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return "";
  };

  const scripCode = str("SCRIP_CD", "scrip_cd", "Scrip_Cd", "ScripCode");
  if (!scripCode) return null;

  const attachment = str("ATTACHMENTNAME", "Attachment", "attachmentname");
  const pdfUrl = attachment
    ? `${BSE_ATTACHMENT_BASE}/${attachment.replace(/^\/+/, "")}`
    : null;

  const symbol = str("NSURL", "SYMBOL", "slongname_symbol").toUpperCase();
  const company = str("SLONGNAME", "slongname", "SCRIP_NAME", "scrip_name");

  return {
    scripCode,
    symbol: symbol || "",
    company,
    title: str("NEWSSUB", "HEADLINE", "Headline", "newssub") || company,
    description: str("MORE", "NEWSBODY", "News_Body", "ANNOUNCEMENT") || "",
    // CATEGORYNAME ONLY. The `|| SUBCATNAME` fallback this used to carry
    // collapsed two different levels of BSE's taxonomy into one column — see
    // the field doc on `BseAnnouncement.category`.
    category: str("CATEGORYNAME", "Category", "category") || "",
    subcategory: str("SUBCATNAME", "SubCatName", "subcatname") || "",
    pdfUrl,
    newsId: str("NEWSID", "NEWS_ID", "news_id", "ROWID"),
    xmlName: str("XML_NAME", "XMLNAME", "xml_name"),
    quarterId: str("QUARTER_ID", "QuarterId", "quarter_id"),
    publishedAt: safeOptionalDate(
      str("NEWS_DT", "News_submission_dt", "DT_TM", "News_Dt"),
    ),
  };
}

/**
 * Parse a full BSE `AnnSubCategoryGetData/w` response into
 * `BseAnnouncement[]`. Non-array / empty payloads → `[]`.
 */
export function parseBseAnnouncements(resp: unknown): BseAnnouncement[] {
  const rows = extractBseRows(resp);
  const out: BseAnnouncement[] = [];
  for (const row of rows) {
    const parsed = parseBseAnnouncementRow(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * BSE wraps list payloads inconsistently: sometimes a bare array, sometimes
 * `{ Table: [...] }`, sometimes `{ Table: [...], Table1: [...] }` where Table1
 * holds paging metadata. Normalize to the row array (first non-empty `Table*`),
 * tolerating a bare array too.
 */
function extractBseRows(resp: unknown): Record<string, unknown>[] {
  if (Array.isArray(resp)) return resp as Record<string, unknown>[];
  if (resp && typeof resp === "object") {
    const obj = resp as Record<string, unknown>;
    if (Array.isArray(obj.Table)) return obj.Table as Record<string, unknown>[];
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
  }
  return [];
}

// ── Network fetchers ──────────────────────────────────────────────────────

async function bseGetJson(url: string, context = url): Promise<unknown> {
  const { maxRetries, backoffBaseMs } = bseRetryConfig();

  let res = await fetch(url, {
    headers: BSE_HEADERS,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  // 429-aware retry: back off (honouring Retry-After) and try again before
  // giving up. `res.headers` is guarded with `?.` so a minimal test stub (no
  // headers) still works — it simply falls back to the computed backoff.
  for (
    let attempt = 1;
    res.status === 429 && attempt <= maxRetries;
    attempt++
  ) {
    const retryAfter = Number(res.headers?.get?.("retry-after"));
    const backoffMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoffBaseMs * 2 ** (attempt - 1);
    logger.warn(
      `BSE 429 for ${context} (retry ${attempt}/${maxRetries}, backoff ${backoffMs}ms)`,
    );
    await bseDelay(backoffMs);
    res = await fetch(url, {
      headers: BSE_HEADERS,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  }

  // Persistent 429 after the retry budget → signal the caller to circuit-break.
  if (res.status === 429) {
    throw new BseRateLimitError(context);
  }
  if (!res.ok) {
    throw new Error(`BSE API returned ${res.status} for ${url}`);
  }
  // BSE sometimes returns text/plain JSON; parse defensively.
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null; // HTML error page / empty body
  }
}

/**
 * ONE `DefaultData/w` request for a single window. Split out of
 * {@link fetchBSECorporateActions} by MONEY-1098 so the public entry point can
 * chunk a wide range without duplicating the URL build / error contract.
 *
 * Error contract (unchanged, and deliberately asymmetric):
 *   - persistent 429 (`BseRateLimitError`) PROPAGATES so the worker can
 *     circuit-break the whole run rather than tarpit through 41 windows;
 *   - every other failure degrades to `null` — best-effort, this is one of three
 *     corroborating sources, and one flaky window must not cost the other 40.
 *
 * `null`, not `[]`, since MONEY-1189: BSE answered a 500 for
 * 16-Aug-2014..11-Feb-2015 on the 20-year backfill and the empty array it
 * returned was indistinguishable from "BSE listed nothing for six months", so
 * the window was never retried. `[]` now means only what it says.
 */
async function fetchBseCorporateActionsWindow(
  fromDate: Date | string,
  toDate: Date | string,
): Promise<NSECorporateAction[] | null> {
  const fdate = formatBseDate(fromDate);
  const tdate = formatBseDate(toDate);
  const url =
    `${BSE_API_BASE}/DefaultData/w?segment=Equity` +
    `&Fdate=${encodeURIComponent(fdate)}&TDate=${encodeURIComponent(tdate)}` +
    `&Purposecode=&scripcode=`;

  try {
    const json = await withCeiling(
      () => bseGetJson(url, `corp-actions ${fdate}..${tdate}`),
      bseWindowCeilingMs(),
      `${fdate}..${tdate}`,
    );
    return parseBseCorporateActions(json);
  } catch (err) {
    if (err instanceof BseRateLimitError) throw err;
    logger.error(
      `Failed to fetch BSE corporate actions ${fdate}..${tdate}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * MONEY-852 — fetch BSE corporate actions for the WHOLE market over a window
 * (blank `scripcode` = all scrips). `Purposecode` is left blank so every action
 * class is returned.
 *
 * MONEY-1098 (P5.2) — the window is now CHUNKED internally into `<=180`-day
 * requests. `DefaultData/w` does not answer an arbitrarily wide range: a 20-year
 * `Fdate`/`TDate` pair comes back truncated to a recent slice, which reads as
 * "BSE listed no corporate actions before 2024" — a silent hole, not an error.
 * The public signature is unchanged, so no call site moves.
 *
 * `Date | string` inputs that {@link formatBseDate} understands but the splitter
 * can't turn into a range fall back to a SINGLE unwindowed request, preserving
 * the pre-chunking behaviour exactly.
 */
export async function fetchBSECorporateActions(opts: {
  fromDate: Date | string;
  toDate: Date | string;
  /** Override the chunk size (days). Tests + one-off backfills only. */
  maxWindowDays?: number;
  /** Override the inter-window pause (ms). Tests only. */
  paceMs?: number;
}): Promise<WindowedFetchResult<NSECorporateAction>> {
  const from = toUtcDay(asDate(opts.fromDate));
  const to = toUtcDay(asDate(opts.toDate));
  if (!from || !to) {
    const rows = await fetchBseCorporateActionsWindow(
      opts.fromDate,
      opts.toDate,
    );
    return rows === null
      ? {
          rows: [],
          failedWindows: [{ from: new Date(NaN), to: new Date(NaN) }],
        }
      : { rows, failedWindows: [] };
  }

  return fetchInWindows(
    from,
    to,
    (w) => fetchBseCorporateActionsWindow(w.from, w.to),
    {
      label: "BSE corp-actions",
      maxDays: opts.maxWindowDays ?? MAX_CORP_ACTION_WINDOW_DAYS,
      ...(opts.paceMs === undefined ? {} : { paceMs: opts.paceMs }),
      log: (m) => logger.info(m),
    },
  );
}

/**
 * Coerce the `Date | string` the BSE fetchers accept into a real Date, using the
 * SAME string convention {@link formatBseDate} does (`YYYY-MM-DD` read as UTC).
 * Returns null for anything unparseable so the caller can degrade rather than
 * build a window out of an Invalid Date.
 */
function asDate(value: Date | string): Date | null {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Announcement categories, the window clamp, and the API-error envelope ──

/**
 * The NINE categories BSE's announcement API exposes, and the ONLY values
 * `strCat` accepts — MONEY-1255.
 *
 * ## The defect this constant exists to close
 *
 * This client used to build the URL with `strCat=-1&subcategory=-1`, reading
 * `-1` as "every category" the way `strScrip=` empty means "every scrip". It
 * does not. `strCat` takes the category NAME, and `-1` matches nothing:
 * `api.bseindia.com` answers **HTTP 200 with a body of `{}`** — a working
 * endpoint correctly reporting that a filter matching nothing matched nothing.
 *
 * `fetchBSEAnnouncements` then read the zero-row page as "no more pages" and
 * stopped, the worker logged "Fetched 0 announcements" and returned cleanly,
 * and `stock_documents` took **zero `corporate_filing` rows for the entire
 * life of the job**. Nothing errored, nothing 4xx'd, nothing alerted.
 *
 * Our own repo recorded the evidence and then did not act on it:
 * `docs/reference/exchange-archive-probe.json` carries the `strCat=-1` probe
 * at verdict EMPTY / 2 bytes for BOTH a recent window and a 2011 window, and
 * `docs/reference/exchange-archive-ranges.md` says "param set NOT confirmed".
 * The correction — "strCat takes the category NAME, not -1" — was applied to
 * `scripts/data/probe-exchange-archives.ts` and never to this file, which is
 * the one that runs nightly.
 *
 * The list itself was captured live from `DDLSubCategoryData/w` (MONEY-1097),
 * not guessed. Spellings are EXACT and load-bearing: `"Corp. Action"` has the
 * period, `"Insider Trading / SAST"` has spaces around the slash. A near-miss
 * spelling reproduces the original defect exactly — 200, `{}`, zero rows, no
 * error — for that one category only, which is strictly harder to notice than
 * the whole-job version was.
 */
export const BSE_ANNOUNCEMENT_CATEGORIES: readonly string[] = [
  "AGM/EGM",
  "Board Meeting",
  "Company Update",
  "Corp. Action",
  "Insider Trading / SAST",
  "New Listing",
  "Result",
  "Integrated Filing",
  "Others",
];

/**
 * The two categories that carry filed financial results.
 *
 * `Result` is the legacy/ordinary results category; `Integrated Filing` is
 * SEBI's post-2024 integrated-filing regime, the same split
 * `workers/src/processors/xbrl-sync.ts` documents for NSE's two indexes.
 * Exported so the worker's classifier and the backfill script name the same
 * two strings rather than two hand-typed copies.
 */
export const BSE_RESULT_CATEGORIES: readonly string[] = [
  "Result",
  "Integrated Filing",
];

/** IST is UTC+5:30. Used only to decide which CALENDAR day "now" is. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Midnight-UTC of the IST calendar day containing `at`. */
function istCalendarDay(at: Date): Date {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ),
  );
}

/** Whole-day arithmetic on a midnight-UTC day marker. */
function addUtcDays(day: Date, delta: number): Date {
  return new Date(day.getTime() + delta * 24 * 60 * 60 * 1000);
}

/**
 * How many days the window end may be walked back when BSE calls it FUTURE.
 *
 * Bounded, and the bound is the termination proof: each step-back is taken at
 * most this many times PER RUN (not per page and not per category), so the
 * page walk cannot loop on a server that rejects every date it is handed.
 */
export const MAX_FUTURE_DATE_STEP_BACKS = 3;

/**
 * Clamp an announcement window's END to a date BSE will accept.
 *
 * ## The trap
 *
 * `AnnSubCategoryGetData/w` rejects a `strToDate` it considers to be in the
 * future — and it does so with **HTTP 200** and the body
 * `{"Table":[{"Column1":"Future Date cannot be selected"}]}`. That payload
 * unwraps to one row, the row has no `SCRIP_CD`, `parseBseAnnouncementRow`
 * returns null for it, and the page reads as EMPTY. Left undetected it is the
 * `strCat=-1` defect a second time, from a different direction.
 *
 * ## Why this clamps to TODAY-in-IST and not to yesterday
 *
 * A hard "always ask for yesterday" clamp would make the 21:30 IST daily run
 * structurally incapable of ever ingesting a filing on the day it was filed —
 * trading a rare, self-announcing error for a permanent one-day blind spot,
 * which is the same trade the original bug made. What this does instead:
 *
 *   1. clamp here, so a caller-supplied window end that is genuinely in the
 *      future (a typo in a Pub/Sub message, a `--to` a year out) can never
 *      poison a whole run; then
 *   2. **detect** the future-date envelope at runtime and step the end back a
 *      day, up to {@link MAX_FUTURE_DATE_STEP_BACKS}.
 *
 * So when BSE's clock is behind IST the effective window end BECOMES
 * yesterday, on evidence, and when it is not we keep today's filings. The
 * step-back count is reported in the fetch result so an operator can see it
 * happening rather than inferring it from a hole in the data.
 */
export function clampBseWindowEnd(
  requested: Date,
  now: Date = new Date(),
): Date {
  const today = istCalendarDay(now);
  if (Number.isNaN(requested.getTime())) return today;
  const day = new Date(
    Date.UTC(
      requested.getUTCFullYear(),
      requested.getUTCMonth(),
      requested.getUTCDate(),
    ),
  );
  return day.getTime() > today.getTime() ? today : day;
}

/**
 * BSE's in-band error envelope: `{ Table: [{ Column1: "<message>" }] }`.
 *
 * Returned with HTTP 200, so nothing in the transport layer sees it. Every key
 * on every row must match `Column<N>` — a real announcement row has 28 named
 * columns and cannot be mistaken for one of these.
 *
 * Returns null for a normal payload (including a genuinely empty `{}`, which
 * is a legitimate answer for a quiet category over a short window).
 */
export function detectBseApiError(
  resp: unknown,
): { message: string; futureDate: boolean } | null {
  const rows = extractBseRows(resp);
  if (rows.length === 0) return null;
  const messages: string[] = [];
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length === 0) return null;
    if (!keys.every((k) => /^Column\d+$/i.test(k))) return null;
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "string" && v.trim()) messages.push(v.trim());
    }
  }
  if (messages.length === 0) return null;
  const message = messages.join("; ");
  return { message, futureDate: /future\s*date/i.test(message) };
}

/** Why one category's page walk stopped. */
export type BseCategoryStop = "exhausted" | "maxPages" | "failed";

/** What ONE category's walk produced — the per-category health signal. */
export interface BseCategoryOutcome {
  category: string;
  /** Rows parsed across this category's pages. */
  count: number;
  /** Pages actually requested. Page 1 counts even when it comes back empty. */
  pages: number;
  stop: BseCategoryStop;
  /** Present only when `stop === "failed"`. */
  error?: string;
}

/** The result of one whole-window, all-categories announcement fetch. */
export interface BseAnnouncementsFetch {
  /** Every row from every category, in category order. */
  announcements: BseAnnouncement[];
  /** ONE entry per category queried, in query order. */
  byCategory: BseCategoryOutcome[];
  /**
   * Category walks that ended in a transport or in-band API failure.
   *
   * Its own counter, not folded into a row count, for the reason
   * `JobOutcome.transportFailures` exists: a blocked upstream is not "rows
   * that failed to persist", it is a reason no rows were considered — and
   * without a separate counter it is byte-identical to a healthy quiet run.
   */
  transportFailures: number;
  /** The window ACTUALLY queried, `YYYYMMDD`, after clamp + step-backs. */
  window: { from: string; to: string };
  /** Days the effective end was walked back off the requested one. */
  futureDateStepBacks: number;
}

interface BseAnnouncementsFetchOptions {
  fromDate: Date | string;
  toDate: Date | string;
  /** Pages per CATEGORY (not per run). */
  maxPages?: number;
  /** Categories to walk. Defaults to all nine. */
  categories?: readonly string[];
  /** Restrict to ONE BSE scrip code (the backfill's per-scrip mode). */
  scripCode?: string;
  /** Pause between requests, ms. Default 0 — the caller owns run-level pace. */
  paceMs?: number;
  /** Injectable clock for {@link clampBseWindowEnd}. Tests only. */
  now?: Date;
}

function buildAnnouncementsUrl(opts: {
  page: number;
  category: string;
  from: string;
  to: string;
  scripCode: string;
}): string {
  return (
    `${BSE_API_BASE}/AnnSubCategoryGetData/w?pageno=${opts.page}` +
    `&strCat=${encodeURIComponent(opts.category)}&subcategory=-1` +
    `&strPrevDate=${opts.from}&strToDate=${opts.to}` +
    `&strSearch=P&strScrip=${encodeURIComponent(opts.scripCode)}&strType=C`
  );
}

/**
 * MONEY-1255 — fetch BSE announcements over a window, ONE CATEGORY AT A TIME,
 * reporting what each category produced.
 *
 * Founder decision D-vi: all nine categories are fetched. There is no
 * "everything" value for `strCat` to fall back on — see
 * {@link BSE_ANNOUNCEMENT_CATEGORIES} — so nine walks is not a choice between
 * broad and narrow, it is the only way to be broad at all.
 *
 * The per-category breakdown is the point of the return type. A run that pulls
 * 400 rows from eight categories and 0 from "Result" is a specific, nameable
 * failure (one wrong spelling, or one category BSE has renamed); a run that
 * returns a flat 400 cannot express it. `judgeBseAnnouncementsHealth` in the
 * worker reads this array.
 *
 * Error contract, unchanged in kind from the single-walk version:
 *   - a persistent 429 (`BseRateLimitError`) PROPAGATES so the worker can
 *     circuit-break the whole run rather than tarpit through nine categories;
 *   - any other failure ends THAT CATEGORY's walk, is counted in
 *     `transportFailures`, and the remaining categories still run.
 */
export async function fetchBSEAnnouncementsByCategory(
  opts: BseAnnouncementsFetchOptions,
): Promise<BseAnnouncementsFetch> {
  const maxPages = Math.max(1, opts.maxPages ?? 5);
  const categories =
    opts.categories && opts.categories.length > 0
      ? opts.categories
      : BSE_ANNOUNCEMENT_CATEGORIES;
  const scripCode = opts.scripCode ?? "";
  const paceMs = Math.max(0, opts.paceMs ?? 0);

  const from = formatBseCompactDate(opts.fromDate);
  const requestedEnd = asDate(opts.toDate);
  let effectiveEnd =
    requestedEnd === null
      ? null
      : clampBseWindowEnd(requestedEnd, opts.now ?? new Date());
  let to =
    effectiveEnd === null
      ? formatBseCompactDate(opts.toDate)
      : formatBseCompactDate(effectiveEnd);

  const announcements: BseAnnouncement[] = [];
  const byCategory: BseCategoryOutcome[] = [];
  let transportFailures = 0;
  let futureDateStepBacks = 0;

  for (const category of categories) {
    let count = 0;
    let pages = 0;
    let stop: BseCategoryStop = "maxPages";
    let error: string | undefined;

    // NOTE the `page` increment is INSIDE the body, not in the header: a
    // future-date step-back re-requests the SAME page against the new window
    // end. Termination is guaranteed by `futureDateStepBacks`, which is
    // run-scoped and bounded by MAX_FUTURE_DATE_STEP_BACKS.
    for (let page = 1; page <= maxPages; ) {
      if (paceMs > 0 && pages > 0) await bseDelay(paceMs);
      const url = buildAnnouncementsUrl({
        page,
        category,
        from,
        to,
        scripCode,
      });
      let json: unknown;
      try {
        json = await bseGetJson(url, `announcements ${category} page ${page}`);
      } catch (err) {
        // A persistent 429 PROPAGATES — the run must circuit-break, not walk
        // eight more categories into the same tarpit.
        if (err instanceof BseRateLimitError) throw err;
        stop = "failed";
        error = err instanceof Error ? err.message : String(err);
        logger.warn(
          `BSE announcements ${category} page ${page} failed (${from}..${to}): ${error}`,
        );
        break;
      }
      pages++;

      const apiError = detectBseApiError(json);
      if (apiError) {
        if (
          apiError.futureDate &&
          futureDateStepBacks < MAX_FUTURE_DATE_STEP_BACKS &&
          effectiveEnd !== null
        ) {
          futureDateStepBacks++;
          effectiveEnd = addUtcDays(effectiveEnd, -1);
          to = formatBseCompactDate(effectiveEnd);
          logger.warn(
            `BSE rejected the window end as a future date — stepping back to ` +
              `${to} (step ${futureDateStepBacks}/${MAX_FUTURE_DATE_STEP_BACKS})`,
          );
          continue; // SAME page, new window end.
        }
        stop = "failed";
        error = apiError.message;
        logger.warn(
          `BSE announcements ${category} page ${page} returned an API error ` +
            `(${from}..${to}): ${apiError.message}`,
        );
        break;
      }

      const rows = parseBseAnnouncements(json);
      if (rows.length === 0) {
        stop = "exhausted";
        break;
      }
      announcements.push(...rows);
      count += rows.length;
      page++;
    }

    if (stop === "failed") transportFailures++;
    byCategory.push({
      category,
      count,
      pages,
      stop,
      ...(error ? { error } : {}),
    });
  }

  return {
    announcements,
    byCategory,
    transportFailures,
    window: { from, to },
    futureDateStepBacks,
  };
}

/**
 * MONEY-852 — fetch BSE corporate announcements for a window as ONE flat list.
 *
 * A thin flattening wrapper over {@link fetchBSEAnnouncementsByCategory}, kept
 * for callers that do not need the per-category breakdown. Since MONEY-1255
 * the default is ALL NINE categories: the old `strCat=-1` "every category"
 * spelling was never a thing BSE accepted, so there is no wider default to
 * fall back to.
 */
export async function fetchBSEAnnouncements(
  opts: BseAnnouncementsFetchOptions,
): Promise<BseAnnouncement[]> {
  const { announcements } = await fetchBSEAnnouncementsByCategory(opts);
  return announcements;
}
