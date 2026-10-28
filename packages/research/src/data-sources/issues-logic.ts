/**
 * NSE issues / annual-reports / integrated-filings — PURE parsing + sharding
 * logic (no network, no Prisma, no GCS, no timers).
 *
 * MONEY-1098 (P5.5 + P5.6 + integrated filings). Extracted out of
 * `nse-issues.ts` for the same reason `nse-filings-logic.ts` was extracted out
 * of `nse-filings.ts`: the response-mapping is the part worth testing, and
 * importing the fetcher would drag `fetch` (and its cookie handshake) into the
 * test process. `nse-issues.ts` imports and CALLS every parser below, so the
 * production path and the tests execute the SAME code — no shadow copies.
 *
 * ## Why every field read goes through `pickString` / `pickNumber`
 *
 * Exactly ONE of the four endpoints this file parses has a CONFIRMED response
 * shape: `/api/integrated-filing-results`, probed in MONEY-1097 P1 (see
 * `docs/reference/exchange-archive-probe.json` → `nse-api/integrated-filing-
 * results/bulk`, 200 / 15,066 bytes). Its preview proves six keys and nothing
 * more:
 *
 *     {"data":[{"attFileSize":"0 Bytes","audited":"Un-Audited",
 *       "broadcast_Date":"07-Aug-2026 23:00:20",
 *       "cmName":"Excelsoft Technologies Limited",
 *       "consolidated":"Standalone","creation_Date":"07-Aug-2026 23:0…
 *
 * Every OTHER key in this file — and every key of `/api/annual-reports`,
 * `/api/all-upcoming-issues`, `/api/ipo-current-issue` and
 * `/api/public-past-issues` — is a GUESS. A guessed key that is wrong does not
 * throw: it reads `undefined`, the row becomes an empty husk, and the job logs
 * "0 rows" — indistinguishable from "NSE had nothing today". That failure mode
 * (silent, and it LOOKS like correct behaviour) is the one this codebase keeps
 * getting bitten by, so the parsers here:
 *
 *   1. accept a CANDIDATE LIST per field, not a single key — NSE spells the
 *      same concept `symbol` / `sym` / `SYMBOL` across its own endpoints;
 *   2. report what they could NOT resolve via {@link summarizeUnmappedKeys},
 *      so the FIRST prod run prints the real key names instead of a zero;
 *   3. never invent a value — an unresolvable date is `null`, never
 *      `new Date(undefined)` (an Invalid Date, the MONEY-620 poison class).
 *
 * @see packages/research/src/data-sources/nse-issues.ts (the I/O callers)
 * @see workers/__tests__/issues-logic.test.ts (tests the real exports)
 */

// ── Primitive readers ────────────────────────────────────────────────────

/** A raw upstream JSON row. Every parser takes these, never a typed shape. */
export type RawRow = Record<string, unknown>;

/**
 * First candidate key that resolves to a NON-EMPTY string.
 *
 * Case-insensitive on the second pass: NSE's own endpoints disagree about
 * capitalisation for the same field (`symbol` on corporate-announcements vs
 * `SYMBOL` on some archive JSONs), and a case-sensitive miss is invisible.
 * Trims, because several NSE string fields carry trailing spaces that would
 * otherwise fragment a unique key ("RELIANCE " ≠ "RELIANCE").
 */
export function pickString(
  row: RawRow,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  const lowered = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) lowered.set(k.toLowerCase(), v);
  for (const k of keys) {
    const v = lowered.get(k.toLowerCase());
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * First candidate key that resolves to a FINITE number.
 *
 * NSE serves numbers as display strings far more often than as JSON numbers:
 * `"1,20,000"` (Indian digit grouping), `"₹ 450.00"`, `"450 - 475"` (a band —
 * only the FIRST number is taken here; the band is split by
 * {@link parsePriceBand}). Returns `null` rather than `NaN`, because `NaN`
 * poisons every downstream comparison and still writes to Mongo.
 */
export function pickNumber(
  row: RawRow,
  keys: readonly string[],
): number | null {
  for (const k of keys) {
    const parsed = parseIndianNumber(row[k]);
    if (parsed !== null) return parsed;
  }
  const lowered = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) lowered.set(k.toLowerCase(), v);
  for (const k of keys) {
    const parsed = parseIndianNumber(lowered.get(k.toLowerCase()));
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Parse a number out of an NSE display value. Handles JSON numbers, Indian
 * digit grouping (`"1,20,000"`), currency/unit noise (`"₹ 450.00"`, `"Rs.10"`,
 * `"0 Bytes"` → 0) and a leading sign. Returns `null` for anything with no
 * digits at all, and for non-finite results.
 */
export function parseIndianNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  // Commas are digit grouping, not separators — remove them before matching so
  // "1,20,00,000" stays one token.
  const cleaned = raw.replace(/,/g, "");
  // Match the FIRST token that STARTS with a digit (after an optional sign).
  // Anchoring on a digit is load-bearing: an earlier version blanked every
  // non-numeric character and took the first whitespace-delimited token, which
  // turned "Rs.10" into ".10" → 0.1 — a 100× error that still type-checks,
  // still writes to Mongo, and is invisible in a log line. The decimal point is
  // only accepted BETWEEN digits.
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an NSE date string. Returns `null` (never an Invalid Date) when the
 * value is missing or unparseable — the MONEY-620 guard, applied to a feed
 * where dates are the PRIMARY KEY material (`issueStart`), so an Invalid Date
 * here would land in a unique index.
 *
 * Formats seen across NSE's JSON APIs, in the order tried:
 *   - `07-Aug-2026 23:00:20` / `07-Aug-2026`  (integrated-filing broadcast_Date)
 *   - `07-08-2026`                            (DD-MM-YYYY query/echo format)
 *   - `2026-08-07…`                           (ISO — handed to `Date` directly)
 *
 * ALL of these are wall-clock IST with no zone marker. We interpret them AS IST
 * and return the correct UTC instant. Letting `new Date("07-Aug-2026")` do it
 * would parse as UTC midnight, i.e. 05:30 IST — which silently moves an IPO's
 * `issueStart` back a day for anything filed before 05:30 IST and, because
 * `issueStart` is half of the upsert key, would create a DUPLICATE row for the
 * same issue rather than update it.
 */
export function parseNseDate(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw);
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  const dmy = s.match(
    /^(\d{1,2})[-/\s]([A-Za-z]{3,}|\d{1,2})[-/\s](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (dmy) {
    const day = Number(dmy[1]);
    const monthToken = dmy[2] ?? "";
    const year = Number(dmy[3]);
    const month = /^\d+$/.test(monthToken)
      ? Number(monthToken) - 1
      : MONTH_INDEX[monthToken.slice(0, 3).toLowerCase()];
    if (month !== undefined && month >= 0 && month <= 11) {
      const hh = Number(dmy[4] ?? 0);
      const mm = Number(dmy[5] ?? 0);
      const ss = Number(dmy[6] ?? 0);
      const utcMs = Date.UTC(year, month, day, hh, mm, ss) - IST_OFFSET_MS;
      const d = new Date(utcMs);
      if (Number.isNaN(d.getTime())) return null;
      // Reject what JS would silently roll over: "31-02-2026" must be null,
      // not 03-Mar. Every sibling parser in this repo rejects it, and a
      // rolled-over date lands in `issueStart` — half the UpcomingIpo upsert
      // key — as a plausible-looking wrong day.
      const ist = new Date(d.getTime() + IST_OFFSET_MS);
      if (
        ist.getUTCFullYear() !== year ||
        ist.getUTCMonth() !== month ||
        ist.getUTCDate() !== day
      ) {
        return null;
      }
      return d;
    }
  }

  // Zone-less ISO / space-separated datetime — SAME IST interpretation as the
  // DMY branch above. Falling through to `new Date(s)` made the branch decide
  // the timezone: a bare "2026-08-11" parsed as UTC midnight (unshifted) while
  // "11-08-2026" became 2026-08-10T18:30Z, and "2026-08-11 09:00:00" parsed in
  // SERVER-LOCAL time — three spellings of one day, three instants. NSE's IPO
  // endpoints emit both DD-MM-YYYY and ISO, `issueStart` is half of
  // @@unique([symbol, issueStart]) and of the mergeIpoIssues key, so the drift
  // produced exactly the duplicate UpcomingIpo rows this function's own
  // docstring says the IST interpretation exists to prevent.
  const isoish = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (isoish) {
    const year = Number(isoish[1]);
    const month = Number(isoish[2]) - 1;
    const day = Number(isoish[3]);
    const utcMs =
      Date.UTC(
        year,
        month,
        day,
        Number(isoish[4] ?? 0),
        Number(isoish[5] ?? 0),
        Number(isoish[6] ?? 0),
      ) - IST_OFFSET_MS;
    const d = new Date(utcMs);
    if (Number.isNaN(d.getTime())) return null;
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    if (
      ist.getUTCFullYear() !== year ||
      ist.getUTCMonth() !== month ||
      ist.getUTCDate() !== day
    ) {
      return null;
    }
    return d;
  }

  // Anything else Date understands — an explicit zone makes it unambiguous,
  // so it is NOT shifted.
  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

const MONTH_INDEX: Readonly<Record<string, number>> = {
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

/** IST is UTC+05:30 with no DST — a constant offset, so arithmetic is exact. */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Format a `Date` as NSE's `DD-MM-YYYY` query format, in IST. */
export function formatNseQueryDate(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${ist.getUTCFullYear()}`;
}

/**
 * Strip a `.NS` / `.BO` suffix and upper-case — same rule as nse-filings.
 *
 * TRIM FIRST. The suffix pattern is end-anchored, so `" tcs.BO "` (NSE pads
 * plenty of its string fields) would keep its `.BO` and yield `"TCS.BO"` — a
 * symbol that matches no instrument and no `StockDocument` row, silently
 * turning one company into two.
 */
export function normalizeIssueSymbol(symbol: string): string {
  return String(symbol || "")
    .trim()
    .replace(/\.(NS|BO)$/i, "")
    .trim()
    .toUpperCase();
}

/**
 * Split a price band (`"450 - 475"`, `"₹450 to ₹475"`, `"475"`) into
 * `{ min, max }`. A single value yields `min === max`; an unparseable value
 * yields two `null`s. IPO price bands are quoted as a range far more often than
 * as two separate fields, and storing only the first number would silently
 * halve every band.
 */
export function parsePriceBand(raw: unknown): {
  min: number | null;
  max: number | null;
} {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { min: raw, max: raw };
  }
  if (typeof raw !== "string") return { min: null, max: null };
  const nums = raw
    .replace(/,/g, "")
    .match(/\d+(?:\.\d+)?/g)
    ?.map(Number)
    .filter((n) => Number.isFinite(n));
  if (!nums || nums.length === 0) return { min: null, max: null };
  const first = nums[0] as number;
  const last = nums[nums.length - 1] as number;
  return { min: Math.min(first, last), max: Math.max(first, last) };
}

// ── Annual reports (P5.5) ────────────────────────────────────────────────

export interface NseAnnualReport {
  symbol: string;
  companyName: string | null;
  /** Financial-year start as printed by NSE (e.g. "2023"), when present. */
  fromYear: string | null;
  /** Financial-year end as printed by NSE (e.g. "2024"), when present. */
  toYear: string | null;
  /**
   * The DEDUPE KEY. Half of `StockDocument`'s
   * `(symbol, exchange, docType, period)` unique index, so it must be stable
   * across runs for the same report — see {@link annualReportPeriod}.
   */
  period: string;
  /** Absolute or NSE-relative PDF path; `null` when the row has no file. */
  attachmentUrl: string | null;
  fileSizeBytes: number | null;
  raw: RawRow;
}

/**
 * Candidate keys for the annual-report PDF. `fileName` is NSE's spelling on the
 * annual-reports page payload; the rest cover the neighbouring endpoints, which
 * NSE has historically reused wholesale.
 */
export const ANNUAL_REPORT_FILE_KEYS = [
  "fileName",
  "file",
  "attchmntFile",
  "attachmentFile",
  "attachment",
  "pdfLink",
  "companyReportFile",
] as const;

/**
 * Build the period key for an annual report.
 *
 * Prefers the printed financial year (`FY2024` from a 2023→2024 row, i.e. the
 * END year — the Indian convention for "FY24"). Falls back to a single year
 * when only one is present, and finally to a filename-derived year so a row
 * with no year fields still gets a STABLE key rather than a per-run one.
 *
 * Stability is the whole point: the key is used to answer "do we already have
 * this PDF?". A key that includes anything run-dependent (a timestamp, an array
 * index) would re-download every report on every run and pile up duplicate
 * `StockDocument` rows that all point at the same PDF.
 */
export function annualReportPeriod(
  fromYear: string | null,
  toYear: string | null,
  fileName?: string | null,
): string {
  const to = toYear && /^\d{4}$/.test(toYear) ? toYear : null;
  const from = fromYear && /^\d{4}$/.test(fromYear) ? fromYear : null;
  if (to) return `FY${to}`;
  if (from) return `FY${Number(from) + 1}`;
  const fromFile = fileName?.match(/(19|20)\d{2}/)?.[0];
  if (fromFile) return `FY${fromFile}`;
  return "unknown-year";
}

/**
 * Map `/api/annual-reports?index=equities&symbol=X` into {@link NseAnnualReport}.
 *
 * Accepts BOTH envelope shapes without deciding which is real: a bare array and
 * `{ data: [...] }`. NSE is inconsistent about this across its own endpoints
 * (corporates-announcements returns an array, integrated-filing-results returns
 * `{data}`), and guessing wrong would return `[]` — a silent zero.
 */
export function parseAnnualReports(
  symbol: string,
  resp: unknown,
): NseAnnualReport[] {
  const clean = normalizeIssueSymbol(symbol);
  const rows = unwrapRows(resp);

  return rows.map((row) => {
    const fromYear = pickString(row, [
      "from_yr",
      "fromYr",
      "fromYear",
      "from_year",
    ]);
    const toYear = pickString(row, ["to_yr", "toYr", "toYear", "to_year"]);
    const attachmentUrl = pickString(row, ANNUAL_REPORT_FILE_KEYS);
    return {
      // The row's own symbol wins when present (it is authoritative for a
      // multi-symbol payload); the requested symbol is the fallback.
      symbol: normalizeIssueSymbol(
        pickString(row, ["symbol", "sym", "tradingSymbol"]) ?? clean,
      ),
      companyName: pickString(row, [
        "companyName",
        "cmName",
        "company",
        "name",
      ]),
      fromYear,
      toYear,
      period: annualReportPeriod(fromYear, toYear, attachmentUrl),
      attachmentUrl,
      fileSizeBytes: pickNumber(row, ["fileSize", "attFileSize", "size"]),
      raw: row,
    };
  });
}

/**
 * Drop annual-report rows we cannot store, and collapse duplicates.
 *
 * Two rows sharing a period key would fight over ONE `StockDocument` row (the
 * unique index is `(symbol, exchange, docType, period)`), so the second would
 * overwrite the first's `gcsPath` — a download paid for and then orphaned. The
 * FIRST row wins because NSE serves these newest-first.
 */
export function dedupeAnnualReports(
  reports: readonly NseAnnualReport[],
): NseAnnualReport[] {
  const seen = new Set<string>();
  const out: NseAnnualReport[] = [];
  for (const r of reports) {
    if (!r.attachmentUrl) continue;
    const key = `${r.symbol}|${r.period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ── IPO issues (P5.6) ────────────────────────────────────────────────────

/**
 * Where an issue row came from. Kept on the parsed row because the three
 * endpoints disagree about the same issue and the merge needs to know which
 * one to trust — see {@link mergeIpoIssues}.
 */
export type IpoSource = "upcoming" | "current" | "past";

export type IpoStatus = "UPCOMING" | "OPEN" | "CLOSED" | "LISTED";

export interface IpoIssue {
  symbol: string;
  companyName: string | null;
  /** NSE series: `EQ` for the mainboard, `SME`/`ST` for the SME platform. */
  series: string | null;
  /** Bid open date. HALF THE UPSERT KEY — a row without it cannot be stored. */
  issueStart: Date | null;
  issueEnd: Date | null;
  status: IpoStatus;
  priceMin: number | null;
  priceMax: number | null;
  /** Issue size AS PRINTED. Unit is NOT normalised — see the report notes. */
  issueSize: number | null;
  lotSize: number | null;
  listingDate: Date | null;
  isSme: boolean;
  source: IpoSource;
  raw: RawRow;
}

/**
 * Derive the lifecycle status from the dates rather than trusting a `status`
 * field that may not exist.
 *
 * `source` alone is NOT enough: `/api/all-upcoming-issues` keeps an issue in
 * its payload while it is open, and `/api/public-past-issues` carries issues
 * that have not listed yet. Dates are the only thing all three agree on.
 * Comparison is instant-vs-instant (both already UTC), so no zone maths here.
 */
export function deriveIpoStatus(
  issue: Pick<IpoIssue, "issueStart" | "issueEnd" | "listingDate">,
  now: Date,
): IpoStatus {
  const t = now.getTime();
  if (issue.listingDate && issue.listingDate.getTime() <= t) return "LISTED";
  if (issue.issueEnd && issue.issueEnd.getTime() < t) return "CLOSED";
  if (issue.issueStart && issue.issueStart.getTime() <= t) return "OPEN";
  return "UPCOMING";
}

/** Candidate keys per IpoIssue field. Exported so the report can list them. */
export const IPO_KEYS = {
  symbol: ["symbol", "sym", "issueSymbol", "scripCode"],
  companyName: ["companyName", "company", "issuerName", "name", "cmName"],
  series: ["series", "issueType", "category", "sr"],
  issueStart: [
    "issueStartDate",
    "issueOpenDate",
    "biddingStartDate",
    // `/api/public-past-issues` names them ipoStartDate / ipoEndDate. Verified
    // against the live payload after the first prod run reported
    // `upserted=11 skippedNoStartDate=1343` — the counter's own diagnostic
    // ("the issueStart key moved, see IPO_KEYS") pointing straight here. Every
    // past issue was being dropped for want of one field name, and issueStart
    // is half the UpcomingIpo unique key so it cannot be defaulted.
    "ipoStartDate",
    "startDate",
    "from_date",
    "openDate",
  ],
  issueEnd: [
    "issueEndDate",
    "issueCloseDate",
    "biddingEndDate",
    "ipoEndDate",
    "endDate",
    "to_date",
    "closeDate",
  ],
  // `priceRange` ("Rs.50 to Rs.53") is the past endpoint's band field; its
  // `issuePrice` is a literal "-" placeholder on the same rows.
  priceBand: [
    "issuePrice",
    "priceBand",
    "price",
    "issuePriceRange",
    "priceRange",
  ],
  priceMin: ["minPrice", "issuePriceLower", "lowerPrice"],
  priceMax: ["maxPrice", "issuePriceUpper", "upperPrice"],
  issueSize: ["issueSize", "size", "totalIssueSize", "noOfSharesOffered"],
  lotSize: ["lotSize", "minBidQuantity", "marketLot", "bidLot"],
  listingDate: ["listingDate", "dateOfListing", "listing_date"],
  status: ["status", "issueStatus"],
} as const;

/**
 * Map ONE raw issue row (from any of the three endpoints) into {@link IpoIssue}.
 *
 * `source` is threaded through rather than inferred, because the three payloads
 * are believed to share a shape — which is exactly why a parsed row must still
 * remember where it came from.
 */
export function parseIpoRow(
  row: RawRow,
  source: IpoSource,
  now: Date,
): IpoIssue {
  const series = pickString(row, IPO_KEYS.series);
  const band = parsePriceBand(row[firstPresentKey(row, IPO_KEYS.priceBand)]);
  const issueStart = parseNseDate(pickRaw(row, IPO_KEYS.issueStart));
  const issueEnd = parseNseDate(pickRaw(row, IPO_KEYS.issueEnd));
  const listingDate = parseNseDate(pickRaw(row, IPO_KEYS.listingDate));
  const partial = { issueStart, issueEnd, listingDate };

  return {
    symbol: normalizeIssueSymbol(pickString(row, IPO_KEYS.symbol) ?? ""),
    companyName: pickString(row, IPO_KEYS.companyName),
    series,
    issueStart,
    issueEnd,
    // A `status` STRING from NSE is only trusted when it maps cleanly; the
    // date-derived value is the default because it cannot go stale between
    // NSE publishing the payload and us reading it.
    status:
      normalizeIpoStatus(pickString(row, IPO_KEYS.status)) ??
      deriveIpoStatus(partial, now),
    priceMin: pickNumber(row, IPO_KEYS.priceMin) ?? band.min,
    priceMax: pickNumber(row, IPO_KEYS.priceMax) ?? band.max,
    issueSize: pickNumber(row, IPO_KEYS.issueSize),
    lotSize: pickNumber(row, IPO_KEYS.lotSize),
    listingDate,
    // SME issues are a different platform with different lot economics, so the
    // flag is derived from BOTH the series and the free-text category — either
    // one alone misses roughly half the SME rows.
    isSme: /\b(sme|st)\b/i.test(
      `${series ?? ""} ${pickString(row, ["category", "platform", "market"]) ?? ""}`,
    ),
    source,
    raw: row,
  };
}

/** Map a whole issues payload. Tolerates both envelope shapes. */
export function parseIpoIssues(
  resp: unknown,
  source: IpoSource,
  now: Date,
): IpoIssue[] {
  return unwrapRows(resp).map((row) => parseIpoRow(row, source, now));
}

/**
 * Merge the three endpoints into one row per `(symbol, issueStart)`.
 *
 * Precedence `current > upcoming > past` — `/api/ipo-current-issue` is the live
 * bidding feed and is the only one that can carry a same-day revision (bands
 * get revised and windows get EXTENDED mid-issue, which is precisely why every
 * date/price column is nullable). Lower-precedence rows still FILL GAPS:
 * `past` is usually the only source of `listingDate`, so a plain "last write
 * wins" would drop it.
 *
 * Rows with no `issueStart` are kept here and dropped by the CALLER (with a
 * count), not silently: the compound unique key needs the date, but a run that
 * quietly discards half its rows must still say so.
 */
export function mergeIpoIssues(...groups: readonly IpoIssue[][]): IpoIssue[] {
  const rank: Record<IpoSource, number> = { past: 0, upcoming: 1, current: 2 };
  const byKey = new Map<string, IpoIssue>();

  for (const issue of groups.flat()) {
    if (!issue.symbol) continue;
    const key = ipoKey(issue);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, issue);
      continue;
    }
    const winner =
      rank[issue.source] >= rank[existing.source] ? issue : existing;
    const loser = winner === issue ? existing : issue;
    byKey.set(key, fillGaps(winner, loser));
  }
  return [...byKey.values()];
}

/** The upsert key, as a string. `null` start collapses to a stable token. */
export function ipoKey(issue: Pick<IpoIssue, "symbol" | "issueStart">): string {
  return `${issue.symbol}|${issue.issueStart?.toISOString() ?? "no-start"}`;
}

/** Copy non-null fields from `loser` into holes in `winner`. */
function fillGaps(winner: IpoIssue, loser: IpoIssue): IpoIssue {
  const merged: IpoIssue = { ...winner };
  const keys = [
    "companyName",
    "series",
    "issueEnd",
    "priceMin",
    "priceMax",
    "issueSize",
    "lotSize",
    "listingDate",
  ] as const;
  for (const k of keys) {
    if (merged[k] === null || merged[k] === undefined) {
      // Index-signature-free assignment: each key is copied under its own type.
      switch (k) {
        case "companyName":
          merged.companyName = loser.companyName;
          break;
        case "series":
          merged.series = loser.series;
          break;
        case "issueEnd":
          merged.issueEnd = loser.issueEnd;
          break;
        case "priceMin":
          merged.priceMin = loser.priceMin;
          break;
        case "priceMax":
          merged.priceMax = loser.priceMax;
          break;
        case "issueSize":
          merged.issueSize = loser.issueSize;
          break;
        case "lotSize":
          merged.lotSize = loser.lotSize;
          break;
        case "listingDate":
          merged.listingDate = loser.listingDate;
          break;
      }
    }
  }
  merged.isSme = winner.isSme || loser.isSme;
  return merged;
}

/** Map a free-text NSE status onto {@link IpoStatus}; `null` when unrecognised. */
export function normalizeIpoStatus(raw: string | null): IpoStatus | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/listed/.test(s)) return "LISTED";
  if (/clos|withdraw/.test(s)) return "CLOSED";
  if (/open|active|live|current/.test(s)) return "OPEN";
  if (/forthcoming|upcoming|announc/.test(s)) return "UPCOMING";
  return null;
}

// ── Integrated filings (SEBI integrated-filing regime) ───────────────────

export interface IntegratedFiling {
  symbol: string;
  companyName: string | null;
  /** `Audited` / `Un-Audited` — CONFIRMED key `audited`. */
  audited: string | null;
  /** `Standalone` / `Consolidated` — CONFIRMED key `consolidated`. */
  consolidated: string | null;
  /** Broadcast instant — CONFIRMED key `broadcast_Date` (IST wall clock). */
  broadcastAt: Date | null;
  /** The period the filing RELATES TO (e.g. "Quarterly", "30-Jun-2026"). */
  relatingTo: string | null;
  /** Dedupe key half; see {@link integratedFilingPeriod}. */
  period: string;
  /** Resolved attachment path, when a plausible key is present. */
  attachmentUrl: string | null;
  /** CONFIRMED key `attFileSize` — `"0 Bytes"` means "no file on this row". */
  attachmentSizeBytes: number | null;
  raw: RawRow;
}

/**
 * Candidate attachment keys for an integrated filing.
 *
 * NOTHING here is confirmed. What IS confirmed is `attFileSize` — a row that
 * advertises an attachment SIZE almost certainly has a sibling carrying the
 * path, and `attFileSize: "0 Bytes"` on the sampled row says that particular
 * filing had no file. This list is the falsifiable guess; the first prod run
 * reports which of these (if any) ever resolved.
 */
export const INTEGRATED_FILING_FILE_KEYS = [
  "attFile",
  "attFileName",
  "attachmentFile",
  "attchmntFile",
  "fileName",
  "xbrl",
  "pdfLink",
] as const;

/**
 * Period key for an integrated filing.
 *
 * Built from the filing's OWN fields, never from "now": the daily window job
 * re-reads overlapping windows on purpose (a filing broadcast at 23:00 IST
 * lands after that evening's run), so a now-derived key would create a second
 * row for a filing we already have — the exact duplicate-on-re-read bug the
 * period key exists to prevent.
 *
 * Shape: `IF-{YYYY-MM-DD}-{seq}` where the date is the broadcast day in IST and
 * `seq` disambiguates two filings by the same company on the same day
 * (standalone + consolidated is the common pair).
 */
export function integratedFilingPeriod(
  broadcastAt: Date | null,
  discriminator?: string | null,
): string {
  const day = broadcastAt
    ? new Date(broadcastAt.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
    : "unknown-date";
  const seq = (discriminator ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return seq ? `IF-${day}-${seq}` : `IF-${day}`;
}

/** Map `/api/integrated-filing-results` rows into {@link IntegratedFiling}. */
export function parseIntegratedFilings(resp: unknown): IntegratedFiling[] {
  return unwrapRows(resp).map((row) => {
    const broadcastAt = parseNseDate(
      pickRaw(row, [
        "broadcast_Date",
        "broadcastDate",
        "broadcastDt",
        "creation_Date",
        "exchdisstime",
      ]),
    );
    const consolidated = pickString(row, ["consolidated", "consolidatedFlag"]);
    const relatingTo = pickString(row, [
      "relatingTo",
      "period",
      "periodEnded",
      "qe",
      "toDate",
    ]);
    return {
      symbol: normalizeIssueSymbol(
        pickString(row, ["symbol", "sym", "tradingSymbol"]) ?? "",
      ),
      companyName: pickString(row, ["cmName", "companyName", "company"]),
      audited: pickString(row, ["audited", "auditedFlag"]),
      consolidated,
      broadcastAt,
      relatingTo,
      period: integratedFilingPeriod(
        broadcastAt,
        `${consolidated ?? ""}${relatingTo ?? ""}`,
      ),
      attachmentUrl: pickString(row, INTEGRATED_FILING_FILE_KEYS),
      attachmentSizeBytes: pickNumber(row, ["attFileSize", "fileSize"]),
      raw: row,
    };
  });
}

/**
 * Drop filings we cannot key, and collapse duplicates on
 * `(symbol, period)` — the half of `StockDocument`'s unique index we control.
 *
 * A filing with no symbol is unusable: `StockDocument` requires an
 * `instrumentId`, which is resolved BY symbol.
 */
export function dedupeIntegratedFilings(
  filings: readonly IntegratedFiling[],
): IntegratedFiling[] {
  const seen = new Set<string>();
  const out: IntegratedFiling[] = [];
  for (const f of filings) {
    if (!f.symbol) continue;
    const key = `${f.symbol}|${f.period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Render an integrated filing as the RAG-indexable text stored in
 * `StockDocument.textContent`.
 *
 * Metadata rows are useless to retrieval as a JSON blob — this is the layer
 * that makes "was Excelsoft's Q1 filing audited and standalone?" answerable.
 * Unknown/absent fields are OMITTED rather than printed as "null", which would
 * teach the embedder that the word "null" is a property of the company.
 */
export function renderIntegratedFilingText(f: IntegratedFiling): string {
  const lines: string[] = [
    `${f.symbol} - Integrated Filing (NSE)`,
    f.companyName ? `Company: ${f.companyName}` : null,
    f.relatingTo ? `Relating to: ${f.relatingTo}` : null,
    f.consolidated ? `Basis: ${f.consolidated}` : null,
    f.audited ? `Audit status: ${f.audited}` : null,
    f.broadcastAt ? `Broadcast: ${f.broadcastAt.toISOString()}` : null,
    f.attachmentUrl ? `Attachment: ${f.attachmentUrl}` : null,
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

// ── Weekly sharding (P5.5) ───────────────────────────────────────────────

/**
 * Days in the shard rotation. Seven so each symbol is visited exactly once a
 * week by a job that runs daily.
 *
 * NOTE FOR INTEGRATION: P5.4 introduces its own `weekShard`. This one is
 * deliberately written standalone (the two agents are working in parallel and a
 * shared helper would be a merge race), and the two MUST be unified — see the
 * hand-off note in the final report. The contract to preserve is
 * "hash-by-symbol, not by list position"; anything index-based reshuffles the
 * whole universe whenever the instrument list grows.
 */
export const WEEKLY_SHARD_COUNT = 7;

/**
 * FNV-1a over the symbol → the shard it belongs to, forever.
 *
 * The obvious alternative — `index % 7` over the resolved instrument list — is
 * WRONG in a way that is invisible in tests: the list is re-resolved every run
 * and its length changes with every listing/delisting, so one new instrument
 * shifts every subsequent symbol into a different day. Symbols would then be
 * re-fetched up to 7× a week while others go months without a visit, and the
 * only symptom is a bandwidth bill. Hashing the SYMBOL pins it: `RELIANCE` is a
 * Tuesday symbol whether the universe holds 4,000 names or 40,000.
 */
export function symbolShard(
  symbol: string,
  shardCount: number = WEEKLY_SHARD_COUNT,
): number {
  const count =
    Number.isFinite(shardCount) && shardCount > 0 ? Math.floor(shardCount) : 1;
  let hash = 0x811c9dc5; // FNV offset basis
  const s = normalizeIssueSymbol(symbol);
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // FNV prime 16777619, via shifts to stay in 32-bit land without bigints.
    hash =
      (hash +
        ((hash << 1) +
          (hash << 4) +
          (hash << 7) +
          (hash << 8) +
          (hash << 24))) >>>
      0;
  }
  return hash % count;
}

/**
 * Which shard TODAY is, in IST.
 *
 * The Cloud Scheduler jobs run with `--time-zone=Asia/Kolkata`, but the worker
 * computes in UTC — and 09:30 IST is 04:00 UTC the SAME day, so a naive
 * `getUTCDay()` happens to agree. It would NOT agree for any job scheduled
 * after 18:30 IST, and this helper is the one another job would copy. Shifting
 * into IST first makes it correct for every hour instead of for this one.
 */
export function weekShardIndex(
  now: Date,
  shardCount: number = WEEKLY_SHARD_COUNT,
): number {
  const count =
    Number.isFinite(shardCount) && shardCount > 0 ? Math.floor(shardCount) : 1;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  // Days since epoch in IST — not `getUTCDay()`, so a shardCount other than 7
  // still rotates instead of aliasing onto a 7-day cycle.
  return Math.floor(ist.getTime() / 86_400_000) % count;
}

/** The subset of `symbols` assigned to `shardIndex`. Order is preserved. */
export function selectWeeklyShard(
  symbols: readonly string[],
  shardIndex: number,
  shardCount: number = WEEKLY_SHARD_COUNT,
): string[] {
  const count =
    Number.isFinite(shardCount) && shardCount > 0 ? Math.floor(shardCount) : 1;
  const target = ((Math.floor(shardIndex) % count) + count) % count;
  return symbols.filter((s) => symbolShard(s, count) === target);
}

/**
 * Order a shard so the STALEST symbols are fetched first.
 *
 * Without this, a run that hits its wall-clock budget always stops at the same
 * place, so the tail of the shard is never reached — the documented flaw in
 * `stock-document-sync`'s `MAX_SYMBOLS_PER_RUN` ("the remainder is DROPPED this
 * run … no cursor"). Sorting by "when did we last store an annual report for
 * this symbol", never-fetched first, makes the truncation point MOVE: whatever
 * got cut last week is at the head this week, so the shard drains completely
 * over a few weeks with no cursor to persist.
 *
 * Ties break on symbol so the order is deterministic (a stable order is what
 * makes a re-run idempotent rather than a reshuffle).
 */
export function orderShardByStaleness(
  symbols: readonly string[],
  lastFetchedAt: ReadonlyMap<string, Date>,
): string[] {
  return [...symbols].sort((a, b) => {
    const ta = lastFetchedAt.get(a)?.getTime() ?? -Infinity;
    const tb = lastFetchedAt.get(b)?.getTime() ?? -Infinity;
    if (ta !== tb) return ta - tb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// ── Shape falsification ──────────────────────────────────────────────────

/**
 * Report which candidate-key groups NEVER resolved across a payload.
 *
 * This is the falsification hook the header talks about: it turns "the job
 * found 0 rows" into "the job saw 240 rows and could not find a symbol key in
 * any of them, and here are the keys those rows actually have". Without it, a
 * wrong guess and an empty upstream are the same log line.
 */
export function summarizeUnmappedKeys(
  rows: readonly RawRow[],
  groups: Readonly<Record<string, readonly string[]>>,
): { unresolved: string[]; observedKeys: string[] } {
  const unresolved: string[] = [];
  for (const [field, keys] of Object.entries(groups)) {
    const anyResolved = rows.some((row) => pickRaw(row, keys) !== undefined);
    if (!anyResolved) unresolved.push(field);
  }
  const observed = new Set<string>();
  for (const row of rows.slice(0, 5)) {
    for (const k of Object.keys(row)) observed.add(k);
  }
  return { unresolved, observedKeys: [...observed].sort() };
}

// ── Shared internals ─────────────────────────────────────────────────────

/**
 * Pull the row array out of whatever envelope NSE used.
 *
 * Handles a bare array, `{data:[...]}`, `{results:[...]}` and `{rows:[...]}`.
 * Non-object entries are dropped rather than coerced — a payload of strings is
 * a shape change, and mapping it into husk rows would hide that.
 */
export function unwrapRows(resp: unknown): RawRow[] {
  const candidate = Array.isArray(resp)
    ? resp
    : isRecord(resp)
      ? ((resp.data ?? resp.results ?? resp.rows) as unknown)
      : null;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(isRecord);
}

function isRecord(v: unknown): v is RawRow {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Raw (untyped, untrimmed) value for the first candidate key that EXISTS. */
export function pickRaw(row: RawRow, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  const lowered = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) lowered.set(k.toLowerCase(), v);
  for (const k of keys) {
    const v = lowered.get(k.toLowerCase());
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** The first candidate key literally present on the row (for `row[key]` reads). */
function firstPresentKey(row: RawRow, keys: readonly string[]): string {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") return k;
  }
  const lowered = new Map<string, string>();
  for (const k of Object.keys(row)) lowered.set(k.toLowerCase(), k);
  for (const k of keys) {
    const actual = lowered.get(k.toLowerCase());
    if (actual !== undefined && row[actual] !== undefined) return actual;
  }
  // A key that cannot exist — `row[""]` is `undefined`, which every reader
  // handles, so the caller needs no null check.
  return "";
}
