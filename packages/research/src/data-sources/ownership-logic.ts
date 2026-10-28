/**
 * Ownership parsers + the weekly sharder — MONEY-1098 (P5.4).
 *
 * PURE. No network, no Prisma, no timers, no clock reads except through the
 * `now` arguments callers pass in. Everything here is response-shape → row
 * translation and deterministic scheduling arithmetic, so it can be unit-tested
 * against inline synthetic fixtures and mutation-checked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PARSERS ARE KEY-DRIVEN AND NEVER THROW
 *
 * All FOUR upstream shapes are UNVERIFIED. NSE publishes no schema for
 * `corporate-share-holdings-master`, `corporates-pit`, `corporate-sast-reg29`
 * or `corporate-pledgedata`, and MONEY-1097's probe run proved the failure mode
 * is silent: NSE answers a request it does not like with `200 {"data":[]}` — a
 * well-formed empty response, not an error (see docs/reference/
 * exchange-archive-ranges.md, where `corporates-pit` bulk mode returned
 * `{"acqNameList":[],"data":[]}` twice and it took a live DevTools capture to
 * learn the endpoint was actually `corporates-pit-gg` with an UNPADDED day).
 *
 * A hard-coded field access against a guessed shape would therefore fail the
 * same silent way: `row.promoterPct` reads `undefined`, the row is dropped, the
 * job logs "0 rows", and nobody can tell that from "this symbol filed nothing".
 * So instead every field is resolved through an ALIAS LIST, every rejection is
 * COUNTED with a reason, and every successful alias match is counted BY NAME in
 * `keyHits`. The first prod run's counters are the experiment: if
 * `keyHits["promoter:pr_and_prgrp"]` is 0 and `reasons.noPct` equals the row
 * count, the guessed key set is wrong and the log says exactly that.
 *
 * Nothing here throws. A parser that throws on a shape change turns one bad
 * symbol into a failed scheduled job.
 */

// TYPE-ONLY, and that is load-bearing rather than stylistic: this module has no
// runtime imports at all, which is what lets `workers/__tests__` exercise it
// without pulling a Prisma client or a fetch stack into the runner. `import
// type` is erased at compile time, so the property survives (MONEY-1205).
import type {
  BseShpQuarter,
  ShareholdingReconcileVerdict,
} from "@usemoney/core/market-data";

// ── Row shapes ───────────────────────────────────────────────────────────────

/** One quarter of one symbol's shareholding pattern. Upserted on (symbol, quarter). */
export interface ShareholdingRow {
  symbol: string;
  /**
   * Canonical quarter label — `YYYY-MM` of the quarter END when the source
   * value parses as a date, else the verbatim trimmed/upper-cased label. This
   * IS the second half of the unique key, so its stability is load-bearing:
   * `31-Mar-2026`, `2026-03-31` and `31/03/2026` must all collapse to
   * `2026-03`, or the same quarter lands twice under two spellings.
   */
  quarter: string;
  promoterPct: number | null;
  pledgedPct: number | null;
  fiiPct: number | null;
  diiPct: number | null;
  publicPct: number | null;
  /**
   * `employeeTrusts` / `underlyingDrs` from the same summary payload — present
   * on 100% of the 7,953 stored rows and previously dropped on the floor
   * because no alias list named them (MONEY-1207).
   *
   * `employeeTrusts` is very often the STRING `"0"`, which is a filer-reported
   * zero and must stay 0. Only `-`/blank/absent become null. Measured on prod:
   * 771 of 7,953 rows carry a non-zero value, the rest report an explicit 0.
   */
  employeeTrustsPct: number | null;
  underlyingDrsPct: number | null;
  /** The source row verbatim, JSON-stringified. Never lossy, never parsed back. */
  raw: string;
}

/**
 * PIT  = SEBI (Prohibition of Insider Trading) Reg 7 disclosure.
 * SAST = SEBI (Substantial Acquisition of Shares and Takeovers) Reg 29.
 * PLEDGE = promoter share pledge creation / release / invocation.
 */
export type InsiderCategory = "PIT" | "SAST" | "PLEDGE";

export interface InsiderEventRow {
  symbol: string;
  /** UTC midnight of the IST calendar day the filing names. */
  date: Date;
  /** The disclosing/acquiring person or entity. `""` when the feed omits it. */
  person: string;
  category: InsiderCategory;
  /**
   * Normalized where recognizable (BUY / SELL / PLEDGE_CREATION / …), else the
   * verbatim upper-cased source value. NEVER bucketed into an "OTHER" that
   * discards the text — a precise mapping without a catch-all shrinks coverage
   * the moment the exchange invents a new transaction type.
   */
  action: string;
  /** Share count. `null` when not disclosed — never 0. */
  qty: number | null;
  /** Rupee value. `null` when not disclosed — never 0. */
  value: number | null;
  raw: string;
}

/**
 * What a parse produced AND what it refused, with the reasons broken out.
 *
 * `skipped` is the count of source rows that produced no output row; `reasons`
 * says why (envelope/noSymbol/noDate/noQuarter/noPct/…); `keyHits` says which
 * guessed alias actually matched, per canonical field. The processor writes all
 * three into the sync log — that is the whole falsification mechanism.
 */
export interface ParseOutcome<T> {
  rows: T[];
  skipped: number;
  reasons: Record<string, number>;
  keyHits: Record<string, number>;
  /**
   * COMPLETENESS ASSERTION (MONEY-1207). Counted per `field:key` when a source
   * row CARRIES a key we have verified against the live payload, and that key
   * still failed to produce a value.
   *
   * `keyHits` alone cannot say this. It is a positive counter: when an alias
   * list loses an entry the hit simply stops appearing, and an absent counter
   * reads exactly like "the feed did not send that field". That is precisely
   * how `public_val` stayed unmapped for 7,953 consecutive rows while the sync
   * log reported `keyHits: {"quarter:date","promoter:pr_and_prgrp"}` and no
   * error at all — the run looked clean because the missing mapping was
   * invisible by construction.
   *
   * A non-empty `unmapped` is therefore a LOUD failure of our own key set, not
   * a property of the market. The processor error-logs it and records it in
   * the sync log.
   */
  unmapped: Record<string, number>;
}

function emptyOutcome<T>(): ParseOutcome<T> {
  return { rows: [], skipped: 0, reasons: {}, keyHits: {}, unmapped: {} };
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

// ── Guessed key sets (the falsifiable part) ──────────────────────────────────
//
// Ordered BEST-GUESS FIRST. `pick` takes the first alias that is present and
// non-blank, so ordering encodes preference, not just membership.

/**
 * Shareholding-pattern field aliases.
 *
 * The `quarter` list deliberately puts PERIOD-ish keys ahead of DATE-ish ones:
 * a submission date is NOT the period it describes (a Q1 pattern filed in July
 * would key as `2026-07` instead of `2026-06`), so a period field — if the feed
 * has one — must win over `date`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERIFIED 2026-08-18 against the 7,953 `raw` rows this job has already stored
 * on prod. The live payload is 33 keys wide and every one of them is present on
 * 100% of rows:
 *
 *   broadcastDate cgTimeStamp countString date desc employeeTrusts format index
 *   industry isin name newColumn pr_and_prgrp promoterDematNotes
 *   publicShareholdingNotes public_val recordId remarksWeb revisedData
 *   revisedDate revisedRemark revisedStatus revisionDate revisionRemark
 *   shareholdingPatternNotes submissionDate symbol systemDate timeDifference
 *   typeOfSubmission underlyingDrs xbrl xbrlFileSize
 *
 * Consequences that were NOT obvious from the guessed shape:
 *
 *   - the public float is `public_val`, which no alias named. `publicPct` was
 *     null on 100% of 7,953 rows while `public_val` was a non-blank string on
 *     100% of them. It now leads the `public` list because it is the only
 *     spelling we have ever actually seen.
 *   - `employeeTrusts` and `underlyingDrs` are their own lines and now have
 *     their own columns. They are NOT part of `public`: adding them there
 *     would have silently overwritten the float with a 0.75% ESOP trust.
 *   - FII / DII / pledged are genuinely NOT in this endpoint. The columns stay
 *     (they are part of the row contract) but they resolve to null here BY
 *     DESIGN; the split lives in the linked `xbrl` document and is written to
 *     `ShareholdingBreakdown` by a different job.
 */
export const SHAREHOLDING_KEYS = {
  symbol: ["symbol", "Symbol", "SYMBOL", "scripCode", "nseSymbol"],
  quarter: [
    "period",
    "quarter",
    "periodEnded",
    "period_ended",
    "asOnDate",
    "as_on_date",
    "xbrlPeriod",
    "qtr",
    "date",
    "submissionDate",
  ],
  promoter: [
    "pr_and_prgrp",
    "promoterAndPromoterGroup",
    "promoterAndPromoterGroupPercentage",
    "promoter",
    "promoterPercentage",
    "promoterHolding",
    "prmtrPct",
  ],
  pledged: [
    "pledged",
    "pledgedPercentage",
    "pledgedPct",
    "promoterPledge",
    "prmotrPldgPct",
    "encumbered",
    "encumberedPercentage",
    "shareholdingEncumbered",
  ],
  fii: [
    "fii",
    "fiiPercentage",
    "fpi",
    "fpiPercentage",
    "foreignInstitutions",
    "foreignPortfolioInvestors",
  ],
  dii: [
    "dii",
    "diiPercentage",
    "domesticInstitutions",
    "domesticInstitutionalInvestors",
  ],
  public: [
    // VERIFIED — the only spelling the live endpoint has ever used.
    "public_val",
    "publicVal",
    "public",
    "publicPercentage",
    "publicShareholding",
    "publicAndOthers",
    "nonPromoter",
    "nonPromoterNonPublic",
  ],
  /** VERIFIED — `employeeTrusts`, an ESOP/welfare trust line. Often a real 0. */
  employeeTrusts: [
    "employeeTrusts",
    "employeeTrust",
    "employee_trusts",
    "sharesHeldByEmployeeTrusts",
  ],
  /** VERIFIED — `underlyingDrs`, shares underlying depository receipts. */
  underlyingDrs: [
    "underlyingDrs",
    "underlyingDRs",
    "underlying_drs",
    "sharesUnderlyingDrs",
  ],
} as const;

/**
 * Field -> the key(s) we have VERIFIED are present in the live payload.
 *
 * This is the completeness assertion's input, and it is deliberately NOT the
 * same thing as {@link SHAREHOLDING_KEYS}. The alias list is a set of GUESSES
 * ordered by preference; this is the much shorter set of spellings measured
 * against real stored rows. When a row carries one of these keys with a
 * non-blank value and the field still comes out null, our key set has regressed
 * — and `ParseOutcome.unmapped` says so by name.
 *
 * `quarter:date` is included because `date` is the quarter-END the payload
 * actually names (`30-JUN-2026`), and losing it would silently re-key every row
 * onto `submissionDate` — a different month.
 */
export const SHAREHOLDING_VERIFIED_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  quarter: ["date"],
  promoter: ["pr_and_prgrp"],
  public: ["public_val"],
  employeeTrusts: ["employeeTrusts"],
  underlyingDrs: ["underlyingDrs"],
};

/**
 * PIT (Reg 7) field aliases.
 *
 * `date` prefers the TRANSACTION window's end (`acqtoDt`) over the intimation
 * date, because the analytical question is "when did the insider trade", not
 * "when did the filing land" — and because the intimation date for the same
 * trade can be restated, which would mint a second dedupe key for one event.
 */
export const PIT_KEYS = {
  symbol: ["symbol", "Symbol", "SYMBOL", "nseSymbol"],
  person: ["acqName", "acquirerName", "name", "nameOfAcquirer", "personName"],
  date: [
    "acqtoDt",
    "acqToDt",
    "acqfromDt",
    "acqFromDt",
    "intimDt",
    "date",
    "timestamp",
  ],
  action: [
    "tdpTransactionType",
    "transactionType",
    "acqMode",
    "buySell",
    "mode",
  ],
  qty: ["secAcq", "noOfSecAcq", "securitiesAcquired", "qty", "noOfShares"],
  value: ["secVal", "securitiesValue", "value", "transactionValue"],
} as const;

/** SAST (Reg 29) field aliases. */
/**
 * SAST Reg-29 field aliases.
 *
 * VERIFIED against the live `/api/corporate-sast-reg29?symbol=RELIANCE`
 * payload, not guessed. The first prod audit found this parser dropping 100%
 * of a 20-row response, and the cause was NOT the symbol (rows carry none, and
 * the per-symbol query mode correctly falls back to the queried symbol) but
 * the DATE: NSE names it `acquirerDate` and prints a RANGE —
 * "27-MAR-2024 to 27-MAR-2024" — which no key here matched, so every row was
 * counted `noDate` and skipped.
 *
 * Real row keys: acqSaleType, acqType, acquirerDate, acquirerName,
 * acquisitionMode, noOfShareAcq, noOfShareAft, noOfShareSale, promoterType.
 */
export const SAST_KEYS = {
  symbol: ["symbol", "Symbol", "SYMBOL", "nseSymbol"],
  person: ["acqName", "nameOfAcq", "acquirerName", "name", "nameOfTheAcquirer"],
  date: [
    "acquirerDate",
    "date",
    "dateOfAllotment",
    "allotDate",
    "timestamp",
    "intimDt",
  ],
  // acqSaleType is the Buy/Sale direction — the field that actually carries
  // the action. acquisitionMode ("Others", "Open Market") is the mechanism.
  action: [
    "acqSaleType",
    "acquisitionMode",
    "acqMode",
    "mode",
    "transactionType",
    "natureOfTransaction",
  ],
  // A SALE puts the quantity in noOfShareSale and leaves noOfShareAcq null, so
  // both are needed or every disposal parses as a zero-quantity acquisition.
  qty: [
    "noOfShareAcq",
    "noOfShareSale",
    "noOfSharesAcq",
    "secAcq",
    "noOfShares",
    "qty",
  ],
  value: ["totShareAcq", "secVal", "value", "totalValue"],
} as const;

/**
 * Pledge field aliases. This feed is BULK (no `symbol` query param), so the
 * symbol MUST come off each row — a row without one cannot be attributed and is
 * counted as `noSymbol` rather than silently dropped.
 */
export const PLEDGE_KEYS = {
  symbol: ["symbol", "Symbol", "SYMBOL", "scripCode", "nseSymbol"],
  /**
   * The bulk feed identifies a company ONLY by name (`comName`), never by
   * symbol — verified against the live payload after this parser was found
   * dropping all 1,540 rows as `noSymbol`. Callers pass a name->symbol map so
   * the row can still be attributed; see {@link parsePledgeData}.
   */
  companyName: ["comName", "companyName", "company", "cmName"],
  person: ["pledgor", "nameOfPromoter", "promoterName", "name", "nameOfEntity"],
  // compBroadcastDate is the DISCLOSURE date (DD-MM-YYYY). broadcastDt is when
  // NSE published the feed and is identical on every row of a given pull, so
  // it is only a fallback — using it would file every disclosure under today.
  date: [
    "compBroadcastDate",
    "date",
    "dateOfCreation",
    "eventDate",
    "timestamp",
    "intimDt",
    "broadcastDt",
  ],
  action: ["pledgeType", "typeOfEvent", "eventType", "natureOfEvent", "type"],
  qty: [
    "numSharesPledged",
    "noOfSharesPledged",
    "pledgedShares",
    "noOfShares",
    "sharesPledged",
    "qty",
  ],
  value: ["value", "totalValue", "amount"],
} as const;

// ── Primitive readers ────────────────────────────────────────────────────────

/**
 * Blank sentinels. NSE tables use `-` (and its unicode dash cousins) for "not
 * reported"; a naive `Number("-")` is NaN and a naive `Number("")` is **0**,
 * which is how a not-disclosed promoter stake becomes a reported 0% holding.
 *
 * `NIL` is treated as NOT REPORTED, not as zero. It reads as zero in ordinary
 * English and often means it, but we cannot tell "nil pledge" from "nil column
 * because this filer does not report it", and inventing a 0 is the more harmful
 * error — a fabricated `pledgedPct: 0` is an all-clear governance signal.
 */
const BLANK_SENTINELS = new Set([
  "",
  "-",
  "--",
  "–",
  "—",
  "NA",
  "N.A",
  "N.A.",
  "N/A",
  "NIL",
  "NULL",
  "UNDEFINED",
]);

type NumReason = "ok" | "absent" | "nonNumeric" | "outOfRange";

interface NumRead {
  value: number | null;
  reason: NumReason;
}

/** Shared string→number normalization: strips `%`, `₹`, commas and whitespace. */
function readNumber(value: unknown): NumRead {
  if (value === null || value === undefined)
    return { value: null, reason: "absent" };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { value, reason: "ok" }
      : { value: null, reason: "nonNumeric" };
  }
  if (typeof value !== "string") return { value: null, reason: "nonNumeric" };

  const trimmed = value.trim();
  if (BLANK_SENTINELS.has(trimmed.toUpperCase())) {
    return { value: null, reason: "absent" };
  }
  // Indian digit grouping ("1,00,000") is just commas — stripping all of them
  // is correct for both 1,000 and 1,00,000.
  const cleaned = trimmed.replace(/[%₹,\s]/g, "");
  if (cleaned === "") return { value: null, reason: "absent" };
  const n = Number(cleaned);
  return Number.isFinite(n)
    ? { value: n, reason: "ok" }
    : { value: null, reason: "nonNumeric" };
}

/**
 * A percentage, range-checked to [0, 100].
 *
 * The range check is a SHAPE ASSERTION, not data cleaning: if a guessed alias
 * actually points at a share COUNT rather than a percentage, every row lands
 * out of range and `reasons.pctOutOfRange` lights up on the first prod run
 * instead of 12-digit "percentages" flowing into the model.
 */
export function readPct(value: unknown): NumRead {
  const r = readNumber(value);
  if (r.value === null) return r;
  if (r.value < 0 || r.value > 100)
    return { value: null, reason: "outOfRange" };
  return r;
}

/** Convenience wrapper — `-`/blank/absent → `null`, never `0`. */
export function parsePct(value: unknown): number | null {
  return readPct(value).value;
}

/**
 * A share count. Rounded to an integer because share counts are integral by
 * definition and the column is written to a `BigInt` — but a fractional input
 * is rounded rather than dropped, since losing the whole event to a stray
 * decimal is the worse outcome and `raw` still holds the truth.
 *
 * Negatives are ALLOWED: a disposal may be published as a negative quantity,
 * and clamping it to null (or to its absolute value) would erase the direction.
 */
export function parseQty(value: unknown): number | null {
  const r = readNumber(value);
  if (r.value === null) return null;
  // Beyond 2^53 an integer is no longer exactly representable; a share count
  // that large is a mis-mapped column, not a holding.
  if (Math.abs(r.value) > Number.MAX_SAFE_INTEGER) return null;
  return Math.round(r.value);
}

/** A rupee amount. Same blank rules; no rounding (paise are real). */
export function parseAmount(value: unknown): number | null {
  return readNumber(value).value;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/** Reject anything outside a plausible filing window (catches epoch-0 and typos). */
function plausibleYear(y: number): boolean {
  return y >= 1990 && y <= 2100;
}

/**
 * Build a UTC-midnight Date, verifying the round-trip so `31-02-2026` is
 * REJECTED instead of silently rolling forward to 3 March (which `Date.UTC`
 * does happily, and which would file an event under a day that never existed).
 */
function utcDay(y: number, m: number, d: number): Date | null {
  if (!plausibleYear(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

/**
 * Parse the date formats NSE actually emits, to UTC midnight of the IST
 * calendar day named.
 *
 * Handled: ISO (`2026-07-09`, with or without a time), `09-Jul-2026`,
 * `09-07-2026`, the UNPADDED `9-07-2026` (MONEY-1097 caught NSE emitting and
 * *requiring* that form), `09/07/2026`, and epoch milliseconds.
 *
 * `DD-MM-YYYY` is assumed, never `MM-DD-YYYY` — NSE is an Indian exchange and
 * every dated endpoint in this codebase already builds `DD-MM-YYYY`
 * (`formatNSEDate`). The round-trip check above means a genuine US-format feed
 * would surface as a wave of rejects for days > 12, not as silently swapped
 * months for days <= 12. That residual ambiguity is unavoidable and documented.
 */
export function parseEventDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? utcDay(
          value.getUTCFullYear(),
          value.getUTCMonth() + 1,
          value.getUTCDate(),
        )
      : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const dt = new Date(value);
    if (!Number.isFinite(dt.getTime())) return null;
    return utcDay(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  if (typeof value !== "string") return null;

  let s = value.trim();
  if (s === "" || BLANK_SENTINELS.has(s.toUpperCase())) return null;

  // NSE's SAST feed prints acquirerDate as a RANGE — "27-MAR-2024 to
  // 27-MAR-2024" — because a disclosure can span several sessions. Take the
  // FIRST date: it is when the acquisition/disposal began, which is the day
  // the event belongs to. Verified against the live payload; before this,
  // every SAST row was counted `unparsedDate` and dropped.
  const range = /^(.+?)\s+to\s+(.+)$/i.exec(s);
  if (range) s = (range[1] ?? "").trim();

  // ISO first — unambiguous because the year leads.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (iso) {
    return utcDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // `09-Jul-2026` / `9 Jul 2026` / `09/Jul/2026`, optionally followed by a
  // time we do not need — the ISO branch above already tolerates one, and the
  // pledge feed's `broadcastDt` ("11-Aug-2026 16:31:32") is exactly this shape.
  // Anchoring at the year dropped 759 of 1,540 pledge rows as `unparsedDate`.
  const named =
    /^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{4})(?:[T\s]+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(
      s,
    );
  if (named) {
    const m = MONTHS[named[2]!.slice(0, 3).toUpperCase()];
    if (m === undefined) return null;
    return utcDay(Number(named[3]), m, Number(named[1]));
  }

  // `09-07-2026` / `9-07-2026` / `09/07/2026`
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (dmy) {
    return utcDay(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  }

  return null;
}

/**
 * Canonical quarter label for the `(symbol, quarter)` unique key.
 *
 * Date-ish input → `YYYY-MM` of the named month. Anything else that still
 * carries meaning (`Q1FY26`, `Jun 2026`) is kept as a squeezed upper-cased
 * string rather than dropped — a symbol whose period label we cannot parse is
 * still worth storing, and `raw` holds the original either way. Returns null
 * only for genuinely empty input, because a row with no period at all cannot be
 * keyed.
 */
export function normalizeQuarter(value: unknown): string | null {
  const asDate = parseEventDate(value);
  if (asDate) {
    const y = asDate.getUTCFullYear();
    const m = String(asDate.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") return null;
  const squeezed = value.trim().replace(/\s+/g, " ").toUpperCase();
  if (squeezed === "" || BLANK_SENTINELS.has(squeezed)) return null;
  // Cap the length: an unparsed label is a key, and an unbounded free-text key
  // is an unbounded index entry.
  return squeezed.slice(0, 32);
}

// ── Envelope + field access ──────────────────────────────────────────────────

/**
 * Pull the row array out of whatever envelope the endpoint used. NSE is not
 * consistent across `/api/*`: some routes answer a bare array, some
 * `{data:[…]}`, some `{data:[…], acqNameList:[…]}`. Anything else yields `null`
 * so the caller can count an `envelope` skip instead of guessing.
 */
export function extractRows(
  payload: unknown,
): Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return null;
  for (const key of ["data", "rows", "result", "records", "response"]) {
    const v = payload[key];
    if (Array.isArray(v)) return v.filter(isRecord);
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Picked {
  value: unknown;
  key: string | null;
}

/**
 * First alias that is PRESENT and non-blank, plus which one matched.
 *
 * "Present but blank" must keep scanning: a feed that carries both `promoter:""`
 * and `pr_and_prgrp:"52.3"` would otherwise resolve to the empty one purely
 * because of key order.
 */
function pick(
  row: Record<string, unknown>,
  aliases: readonly string[],
): Picked {
  for (const key of aliases) {
    if (!(key in row)) continue;
    const v = row[key];
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && BLANK_SENTINELS.has(v.trim().toUpperCase())) {
      continue;
    }
    return { value: v, key };
  }
  return { value: undefined, key: null };
}

/** Record which alias won, namespaced by field, so misses are visible per key. */
function noteKey(
  keyHits: Record<string, number>,
  field: string,
  picked: Picked,
): void {
  if (picked.key) bump(keyHits, `${field}:${picked.key}`);
}

/** True when `row[key]` exists and is not one of the not-reported sentinels. */
function hasNonBlank(row: Record<string, unknown>, key: string): boolean {
  if (!(key in row)) return false;
  const v = row[key];
  if (v === null || v === undefined) return false;
  if (typeof v === "string")
    return !BLANK_SENTINELS.has(v.trim().toUpperCase());
  return true;
}

/**
 * The completeness assertion — see {@link ParseOutcome.unmapped}.
 *
 * Fires when the row CARRIES a verified key with a real value and the field
 * still resolved to nothing. Two distinct regressions produce that, and both
 * matter: the alias list lost the key (`picked.key` is some other alias, or
 * null), or the key was picked and the value would not parse.
 *
 * It deliberately does NOT fire when the verified key is absent or blank — a
 * feed that stops sending a field is news for a different counter, and firing
 * here would drown the signal in rows where `underlyingDrs` is legitimately
 * null (which is 7,953 of 7,953 today).
 */
function noteUnmapped(
  unmapped: Record<string, number>,
  field: string,
  row: Record<string, unknown>,
  picked: Picked,
  resolved: unknown,
): void {
  const verified = SHAREHOLDING_VERIFIED_KEYS[field];
  if (!verified) return;
  for (const key of verified) {
    if (!hasNonBlank(row, key)) continue;
    if (picked.key === key && resolved !== null && resolved !== undefined) {
      continue;
    }
    bump(unmapped, `${field}:${key}`);
  }
}

function cleanSymbol(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/\.(NS|BO)$/i, "")
    .toUpperCase();
}

/**
 * Free text → squeezed, capped string; a not-reported sentinel → `""`.
 *
 * The sentinel check is deliberately duplicated here even though {@link pick}
 * already skips blanks: `cleanText` is reachable directly (via
 * {@link normalizeAction}), and a literal `"-"` surviving into `action` or
 * `person` would become part of the dedupe key — so a not-disclosed field and a
 * field literally containing a dash would key differently for the same event.
 */
function cleanText(value: unknown, max = 200): string {
  if (typeof value === "string") {
    const squeezed = value.trim().replace(/\s+/g, " ");
    if (BLANK_SENTINELS.has(squeezed.toUpperCase())) return "";
    return squeezed.slice(0, max);
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

// ── Action normalization ─────────────────────────────────────────────────────

/**
 * Normalize a transaction/event type where we recognize it, and fall through to
 * the VERBATIM upper-cased text where we do not.
 *
 * The catch-all is the point. A tight enum with an `OTHER` bucket looks cleaner
 * and is strictly worse: the day SEBI adds a transaction type, every row of it
 * becomes indistinguishable from every other unknown. Keeping the raw text
 * means an unrecognized action is still queryable and still tells you what
 * happened.
 */
export function normalizeAction(
  value: unknown,
  category: InsiderCategory,
): string {
  const text = cleanText(value, 120);
  if (text === "") return "";
  const upper = text.toUpperCase();

  if (category === "PLEDGE") {
    // Prefix matches, NOT `\b…\b` whole words: "CREATION" is not the word
    // "CREAT", and "INVOCATION" is not "INVOK" — a trailing `\b` silently
    // matched neither, which is how "Invocation" came out unnormalized.
    //
    // Release/invocation are tested BEFORE creation because "Release of pledge"
    // and "Invocation of pledge" both contain PLEDG; ordering is what keeps a
    // release from being recorded as a new pledge.
    if (/\b(RELEAS|REVOK|REVOC)/.test(upper)) return "PLEDGE_RELEASE";
    if (/\b(INVOC|INVOK)/.test(upper)) return "PLEDGE_INVOCATION";
    if (/\b(CREAT|PLEDG)/.test(upper)) return "PLEDGE_CREATION";
    return upper;
  }

  // PIT / SAST share the acquisition-vs-disposal vocabulary.
  if (
    /\b(BUY|BOUGHT|ACQUISITION|ACQUIRED|ACQUIRE|PURCHASE[D]?)\b/.test(upper)
  ) {
    return "BUY";
  }
  if (/\b(SELL|SOLD|SALE|DISPOSAL|DISPOSED)\b/.test(upper)) return "SELL";
  return upper;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

/**
 * `/api/corporate-share-holdings-master?symbol=X` → one row per quarter.
 *
 * `symbol` is passed in (not read off the row) because this endpoint is queried
 * PER SYMBOL — the query symbol is authoritative and a row-level symbol field,
 * if present, is only used to reject cross-contaminated rows.
 *
 * A row must yield a quarter AND at least one non-null percentage. All-null
 * rows are rejected on purpose: writing one would make "we have no ownership
 * data for this quarter" indistinguishable from "we fetched it and everything
 * was blank", and the whole point of the null-vs-0 discipline above is to keep
 * those apart.
 */
export function parseShareholdingMaster(
  symbol: string,
  payload: unknown,
): ParseOutcome<ShareholdingRow> {
  const out = emptyOutcome<ShareholdingRow>();
  const clean = cleanSymbol(symbol);
  if (clean === "") {
    bump(out.reasons, "noQuerySymbol");
    return out;
  }

  const rows = extractRows(payload);
  if (rows === null) {
    bump(out.reasons, "envelope");
    return out;
  }

  const seen = new Set<string>();

  for (const row of rows) {
    const rowSymbol = cleanSymbol(pick(row, SHAREHOLDING_KEYS.symbol).value);
    // A per-symbol endpoint answering with a DIFFERENT symbol means the query
    // did not take (NSE's silent-empty cousin: silent-wrong).
    if (rowSymbol !== "" && rowSymbol !== clean) {
      out.skipped++;
      bump(out.reasons, "symbolMismatch");
      continue;
    }

    const quarterPick = pick(row, SHAREHOLDING_KEYS.quarter);
    noteKey(out.keyHits, "quarter", quarterPick);
    const quarter = normalizeQuarter(quarterPick.value);
    noteUnmapped(out.unmapped, "quarter", row, quarterPick, quarter);
    if (!quarter) {
      out.skipped++;
      bump(out.reasons, "noQuarter");
      continue;
    }

    // `core` is the set that decides whether the row is worth writing at all —
    // see the anyPct gate below. `extra` is real data we also store but which
    // must NOT keep an otherwise-empty row alive.
    const core: Array<[keyof typeof SHAREHOLDING_KEYS, string]> = [
      ["promoter", "promoterPct"],
      ["pledged", "pledgedPct"],
      ["fii", "fiiPct"],
      ["dii", "diiPct"],
      ["public", "publicPct"],
    ];
    const extra: Array<[keyof typeof SHAREHOLDING_KEYS, string]> = [
      ["employeeTrusts", "employeeTrustsPct"],
      ["underlyingDrs", "underlyingDrsPct"],
    ];

    const pcts: Record<string, number | null> = {};
    for (const [aliasField, outField] of [...core, ...extra]) {
      const picked = pick(row, SHAREHOLDING_KEYS[aliasField]);
      const read = readPct(picked.value);
      if (read.value !== null) noteKey(out.keyHits, aliasField, picked);
      else if (read.reason === "outOfRange") bump(out.reasons, "pctOutOfRange");
      else if (read.reason === "nonNumeric") bump(out.reasons, "pctNonNumeric");
      noteUnmapped(out.unmapped, aliasField, row, picked, read.value);
      pcts[outField] = read.value;
    }

    // CORE only. `employeeTrusts` is the string "0" on ~90% of live rows — a
    // filer-reported zero, which `readPct` correctly keeps as 0 — so counting
    // it here would make the gate vacuous: every row would carry "a non-null
    // percentage" and the "we fetched it and everything was blank" case would
    // become unobservable again. That gate is the whole reason all-null rows
    // are refused, so widening it while adding columns would have quietly
    // undone it.
    const anyPct = core.some(([, outField]) => pcts[outField] !== null);
    if (!anyPct) {
      out.skipped++;
      bump(out.reasons, "noPct");
      continue;
    }

    // Last write wins within one response: NSE occasionally repeats a period
    // (restatement). The later row is the newer statement.
    const dupeIndex = seen.has(quarter)
      ? out.rows.findIndex((r) => r.quarter === quarter)
      : -1;

    const built: ShareholdingRow = {
      symbol: clean,
      quarter,
      promoterPct: pcts.promoterPct ?? null,
      pledgedPct: pcts.pledgedPct ?? null,
      fiiPct: pcts.fiiPct ?? null,
      diiPct: pcts.diiPct ?? null,
      publicPct: pcts.publicPct ?? null,
      employeeTrustsPct: pcts.employeeTrustsPct ?? null,
      underlyingDrsPct: pcts.underlyingDrsPct ?? null,
      raw: safeJson(row),
    };

    if (dupeIndex >= 0) {
      out.rows[dupeIndex] = built;
      bump(out.reasons, "quarterRestated");
    } else {
      seen.add(quarter);
      out.rows.push(built);
    }
  }

  return out;
}

/**
 * Shared insider-event row builder for the three event feeds. They differ only
 * in their alias sets and in whether the symbol comes from the query or the
 * row, so the validity rules live in one place.
 *
 * `querySymbol === null` means BULK mode (pledge): the symbol MUST come off the
 * row and a row without one is counted, not guessed at.
 */
function parseInsiderFeed(
  payload: unknown,
  category: InsiderCategory,
  keys: typeof PIT_KEYS | typeof SAST_KEYS | typeof PLEDGE_KEYS,
  querySymbol: string | null,
  /**
   * BULK mode only: resolves a company NAME to a symbol. Passed in as plain
   * data so this module stays pure and testable — the caller builds it from
   * InstrumentMapping.
   */
  nameToSymbol?: ReadonlyMap<string, string> | undefined,
): ParseOutcome<InsiderEventRow> {
  const out = emptyOutcome<InsiderEventRow>();

  const expected = querySymbol === null ? null : cleanSymbol(querySymbol);
  if (expected === "") {
    bump(out.reasons, "noQuerySymbol");
    return out;
  }

  const rows = extractRows(payload);
  if (rows === null) {
    bump(out.reasons, "envelope");
    return out;
  }

  for (const row of rows) {
    const symbolPick = pick(row, keys.symbol);
    const rowSymbol = cleanSymbol(symbolPick.value);
    if (rowSymbol !== "") noteKey(out.keyHits, "symbol", symbolPick);

    let symbol: string;
    if (expected === null) {
      if (rowSymbol === "") {
        // No symbol on the row: try the company name before giving up. The
        // pledge feed has NO symbol field at all, so without this every row
        // is unattributable and the whole feed parses to nothing.
        const namePick = pick(
          row,
          ("companyName" in keys ? keys.companyName : []) as readonly string[],
        );
        const resolved = nameToSymbol?.get(
          normalizeCompanyName(cleanText(namePick.value)),
        );
        if (!resolved) {
          out.skipped++;
          bump(out.reasons, namePick.key ? "unresolvedName" : "noSymbol");
          continue;
        }
        noteKey(out.keyHits, "companyName", namePick);
        symbol = resolved;
      } else {
        symbol = rowSymbol;
      }
    } else {
      if (rowSymbol !== "" && rowSymbol !== expected) {
        out.skipped++;
        bump(out.reasons, "symbolMismatch");
        continue;
      }
      symbol = expected;
    }

    const datePick = pick(row, keys.date);
    const date = parseEventDate(datePick.value);
    if (!date) {
      out.skipped++;
      bump(out.reasons, datePick.key ? "unparsedDate" : "noDate");
      continue;
    }
    noteKey(out.keyHits, "date", datePick);

    const personPick = pick(row, keys.person);
    const person = cleanText(personPick.value);
    if (person !== "") noteKey(out.keyHits, "person", personPick);

    const actionPick = pick(row, keys.action);
    const action = normalizeAction(actionPick.value, category);
    if (action !== "") noteKey(out.keyHits, "action", actionPick);

    const qtyPick = pick(row, keys.qty);
    const qty = parseQty(qtyPick.value);
    if (qty !== null) noteKey(out.keyHits, "qty", qtyPick);

    const valuePick = pick(row, keys.value);
    const value = parseAmount(valuePick.value);
    if (value !== null) noteKey(out.keyHits, "value", valuePick);

    // A row with a date and nothing else is an empty shell — it would produce a
    // dedupe key made almost entirely of blanks and collide with every other
    // shell for that symbol/day.
    if (person === "" && action === "" && qty === null && value === null) {
      out.skipped++;
      bump(out.reasons, "emptyRow");
      continue;
    }

    out.rows.push({
      symbol,
      date,
      person,
      category,
      action,
      qty,
      value,
      raw: safeJson(row),
    });
  }

  return out;
}

/** `/api/corporates-pit?symbol=X` — SEBI PIT Reg 7 insider disclosures. */
export function parseInsiderPit(
  symbol: string,
  payload: unknown,
): ParseOutcome<InsiderEventRow> {
  return parseInsiderFeed(payload, "PIT", PIT_KEYS, symbol);
}

/** `/api/corporate-sast-reg29?symbol=X` — SAST Reg 29 substantial-acquisition. */
export function parseSastReg29(
  symbol: string,
  payload: unknown,
): ParseOutcome<InsiderEventRow> {
  return parseInsiderFeed(payload, "SAST", SAST_KEYS, symbol);
}

/**
 * `/api/corporate-pledgedata` — BULK (one request for the whole market).
 *
 * Rows identify the company by NAME only, so `nameToSymbol` is what makes the
 * feed usable. Omit it and every row is counted `unresolvedName` rather than
 * silently attributed to the wrong company.
 */
export function parsePledgeData(
  payload: unknown,
  nameToSymbol?: ReadonlyMap<string, string>,
): ParseOutcome<InsiderEventRow> {
  return parseInsiderFeed(payload, "PLEDGE", PLEDGE_KEYS, null, nameToSymbol);
}

/**
 * Company-name normal form for the pledge join: upper-cased, punctuation
 * stripped, and the corporate suffix removed, so "20 Microns Limited"
 * (NSE feed) and "20 Microns Ltd." (InstrumentMapping.name) collapse together.
 */
export function normalizeCompanyName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(
      /\b(LIMITED|LTD|PRIVATE|PVT|CORPORATION|CORP|COMPANY|CO|INDIA|THE)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** JSON.stringify that cannot throw on a cyclic/BigInt payload. */
function safeJson(row: unknown): string {
  try {
    return JSON.stringify(row, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  } catch {
    return "{}";
  }
}

// ── Dedupe identity ──────────────────────────────────────────────────────────

const KEY_SEP = "|";

/**
 * Escape before joining. `[a, b].join("|")` is not injective: a person name
 * containing the separator merges into the neighbouring field, so
 *
 *   person "Y|ACME", action "BUY"   → "…|Y|ACME|BUY|…"
 *   person "Y",      action "ACME|BUY" → "…|Y|ACME|BUY|…"
 *
 * collide and one of two genuinely different disclosures is dropped as a
 * duplicate. Acquirer names are free-text filer strings we do not control.
 */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * The identity of an insider/SAST/pledge event: ALL business fields.
 *
 * WHY A DERIVED KEY AT ALL — insider filings ship no stable identifier. There
 * is no filing id, no ack number, no URL that survives a restatement in any of
 * the three feeds, and NSE's per-symbol endpoints serve a ROLLING window, so
 * every scheduled run re-reads the same disclosures. Without an identity the
 * table grows by one duplicate set per run.
 *
 * WHY ALL FIELDS — the same promoter can legitimately file two trades in the
 * same name on the same day at different quantities, and both must survive. So
 * qty and value are part of the identity, not attributes of it. Only a
 * byte-identical repeat (the same disclosure served again tomorrow) collapses.
 *
 * WHY NOT `raw` — the raw payload carries volatile fields (attachment URLs with
 * rotating tokens, "days ago" style counters). Including it would mint a new key
 * for an unchanged event on every run, which is exactly the failure the key
 * exists to prevent.
 *
 * The write site HASHES this (sha256 → the fixed-width `dedupeKey` column). Do
 * not hash here: this function returns the key's MEANING, hashing is storage —
 * the same split P4.6 uses for `exactDealKey`.
 */
export function insiderEventKey(row: InsiderEventRow): string {
  return [
    row.category,
    row.symbol,
    row.date.toISOString().slice(0, 10),
    row.person,
    row.action,
    // Numbers enter as their PARSED values, so "1,000" and "1000" are one key
    // (correct — one quantity) while 1000 and 1000.5 differ. `null` and an empty
    // string collapse; both mean "not disclosed".
    row.qty === null ? "" : String(row.qty),
    row.value === null ? "" : String(row.value),
  ]
    .map(esc)
    .join(KEY_SEP);
}

// ── The weekly sharder — SUPERSEDED for ownership-sync (MONEY-1207) ──────────
//
// `weekShard` + `rotateSlice` were how ownership-sync picked its symbols until
// the first eight prod runs measured what they actually do. They are kept
// (exported, tested) because the failure they encode is worth keeping legible,
// and because the sharder itself is sound — it was the FIXED STRIDE that was
// wrong. What replaced them is the priority queue below.
//
// WHAT WENT WRONG, measured over runs 1-8 (2026-08-11 .. 2026-08-17) and
// re-simulated against the real 10,437-symbol prod universe:
//
//   `rotateSlice(shard, 600, weekIndex * 600)` hands the walk 600 symbols and
//   advances the window by 600 EVERY WEEK. The walk never got through 600: the
//   420s budget consumed 310-410, reporting `skippedForBudget` 190-290 on every
//   single run. The stride was ~220 symbols LONGER than throughput, so the tail
//   of each window was abandoned and the window then moved past it.
//
//   IT IS NOT A PERMANENT BLIND SPOT — that was this comment's first claim and
//   the simulation falsified it. Because the window start walks by
//   `gcd(600, shardSize)` each week, the abandoned tails ARE eventually reached:
//   a full NSE pass completes in 7 WEEKS (50% at week 3, 90% at week 5). Seven
//   weeks against a 7-DAY target, over NSE alone, is the actual defect.
//
//   WHAT IS GENUINELY UNSAFE is that the 7 weeks are an ACCIDENT. Coverage
//   closes only while `gcd(600, shardSize) <= symbols-actually-consumed`, and
//   shard sizes are an artefact of a universe that moved 10,340 -> 10,506 in six
//   days. Measured today: shard 6 is EXACTLY 1,500 symbols, gcd(600, 1500) =
//   300, which gives it precisely FIVE distinct window starts ever. It closes
//   only because 310-410 consumed happens to exceed the 300-symbol step. Had the
//   budget bought 290, that shard would carry five permanent 10-symbol holes,
//   for as long as its size stayed at 1,500, and nothing would have said so.
//
//   `weekShard` returns a SORTED array, so the reachable prefix of each shard is
//   an alphabetical band — and the universe is 23% bond symbols (MONEY-1093), so
//   2,421 of the 5,040 symbols reached in the first two weeks begin with the
//   digit "7". HDFCBANK hashes to shard 1 and was NOT reached in either week.
//   Coverage after 8 runs: NIFTY50 13/50 with data (21/50 even visited),
//   NIFTY500 108/500.
//
// THE FIX IS NOT A BIGGER CAP. A stride that exceeds throughput leaves coverage
// dependent on a number-theoretic coincidence; a stride equal to what the run
// ACTUALLY consumed cannot. So the replacement advances a persisted cursor by
// the measured consumption ({@link advanceCursor}) instead of by a constant, and
// orders the queue by priority instead of by hash ({@link buildOwnershipQueue}).

/**
 * FNV-1a (32-bit). Chosen because it is DETERMINISTIC ACROSS PROCESSES AND
 * VERSIONS — the shard a symbol lands in must never depend on V8 internals,
 * iteration order, or the order the universe query happened to return.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Which of the 7 shards a symbol belongs to. Depends on the symbol ALONE. */
export function shardOf(symbol: string): number {
  return fnv1a32(cleanSymbol(symbol)) % 7;
}

/**
 * Deterministic 1-of-7 partition of the active universe: the symbols whose turn
 * it is on `dayOfWeek` (0 = Sunday, matching `Date#getUTCDay`).
 *
 * WHY HASH-OF-SYMBOL AND NOT `index % 7` — the obvious sharder is positional,
 * and positional sharding is NOT stable under universe growth. A single new
 * listing sorting into the middle shifts every symbol after it to a different
 * day, so in the week a company lists, some symbols are fetched twice and
 * others are skipped entirely. Hashing the symbol makes a symbol's day depend on
 * its own name and nothing else: new listings land wherever their own hash says
 * and no existing symbol ever moves.
 *
 * Coverage is exact by construction — every symbol maps to exactly one shard, so
 * the seven shards are disjoint and their union is the universe. Shard SIZES are
 * only approximately equal (hash buckets, not a balanced split); at ~4,200 NSE
 * equities the spread is a few percent around 600, which is why the cadence is
 * "~600/day" and not a promise.
 *
 * Input is deduped and sorted so the walk order is stable across runs (the
 * universe query has no guaranteed order) — that stability is what makes the
 * budget-cut rotation in {@link rotateSlice} meaningful.
 */
export function weekShard(symbols: string[], dayOfWeek: number): string[] {
  const day = Number.isFinite(dayOfWeek)
    ? ((Math.trunc(dayOfWeek) % 7) + 7) % 7
    : 0;

  const seen = new Set<string>();
  for (const s of symbols) {
    const clean = cleanSymbol(s);
    if (clean === "") continue;
    if (shardOf(clean) === day) seen.add(clean);
  }
  return Array.from(seen).sort();
}

/**
 * IST day-of-week (0 = Sunday) for a given instant.
 *
 * The shard must key off the IST calendar day, not UTC. At the 20:30 IST cron
 * the two agree (15:00 UTC), but a retry, a backfill, or a schedule change past
 * 05:30 IST would silently shard against yesterday — one shard fetched twice,
 * another never.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function istDayOfWeek(now: Date): number {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCDay();
}

/** Whole weeks since the epoch in IST — a stable, monotone rotation counter. */
export function istWeekIndex(now: Date): number {
  return Math.floor(
    (now.getTime() + IST_OFFSET_MS) / (7 * 24 * 60 * 60 * 1000),
  );
}

/**
 * Take at most `cap` items starting at `offset`, WRAPPING around the end.
 *
 * Exists because the run has a hard wall-clock budget (the Pub/Sub ack
 * deadline). A plain `slice(0, cap)` would cut the same tail off the same
 * shard every single week — a permanent, silent blind spot in exactly the
 * alphabetical region the cut lands in. Rotating the start by the week index
 * means the cut moves, so every symbol is reached within `ceil(shard/cap)`
 * weeks instead of never.
 *
 * `cap <= 0` or `cap >= length` returns everything (no rotation, so the common
 * "budget is sufficient" case stays trivially stable).
 */
export function rotateSlice<T>(items: T[], cap: number, offset: number): T[] {
  const n = items.length;
  if (n === 0) return [];
  if (!Number.isFinite(cap) || cap <= 0 || cap >= n) return [...items];

  const start = ((Math.trunc(offset) % n) + n) % n;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) {
    out.push(items[(start + i) % n]!);
  }
  return out;
}

// ── The priority queue + resumable cursor (MONEY-1207) ───────────────────────
//
// Replaces the hash-shard + fixed-stride rotation above. Two properties the old
// scheme did not have:
//
//   1. PRIORITY. The queue is ordered Nifty 50 -> Nifty 100 family -> Nifty 500
//      family -> the rest of NSE -> BSE-only, so the names anyone actually looks
//      at are reached on the FIRST run after a deploy rather than whenever their
//      hash bucket came up. Under the old sharder HDFCBANK was 6 days out in the
//      best case and unreachable in practice.
//
//   2. NO STRIDE. The cursor advances by what the run CONSUMED, so a run that
//      falls short of its cap resumes exactly where it stopped. Full coverage
//      then takes ceil(queue / consumed-per-run) runs with no blind spot,
//      whatever the budget turns out to buy. This is the whole defect: the old
//      code advanced by a constant that was never once achieved.

/** One instrument in the ownership universe. */
export interface OwnershipUniverseEntry {
  symbol: string;
  /** "NSE" | "BSE". Kept verbatim; unknown values sort into the BSE-only tail. */
  exchange: string;
}

/**
 * Priority tiers. LOWER IS FETCHED FIRST.
 *
 * Tier 4 is not a second-class citizen, it is a HONEST ordering: all four NSE
 * endpoints are `www.nseindia.com/api/*` keyed on the NSE trading symbol, so a
 * BSE-only listing has, at best, an unproven chance of answering. Founder
 * decision (MONEY-1207) is to cover it anyway rather than shrink the universe —
 * so it is covered, LAST, and the per-tier `emptyResponses` counters in the sync
 * log are what will eventually decide whether it is worth the requests. Nothing
 * here assumes the answer.
 */
export const OWNERSHIP_TIER = {
  NIFTY50: 0,
  NIFTY100: 1,
  NIFTY500: 2,
  NSE_OTHER: 3,
  BSE_ONLY: 4,
} as const;

export type OwnershipTier =
  (typeof OWNERSHIP_TIER)[keyof typeof OWNERSHIP_TIER];

/** Human labels for the sync log, so a tier count is readable without this file. */
export const OWNERSHIP_TIER_LABEL: Readonly<Record<number, string>> = {
  [OWNERSHIP_TIER.NIFTY50]: "nifty50",
  [OWNERSHIP_TIER.NIFTY100]: "nifty100",
  [OWNERSHIP_TIER.NIFTY500]: "nifty500",
  [OWNERSHIP_TIER.NSE_OTHER]: "nseOther",
  [OWNERSHIP_TIER.BSE_ONLY]: "bseOnly",
};

/**
 * `index_memberships.indexId` -> tier.
 *
 * The eight ids below are the COMPLETE set that collection holds (measured on
 * prod 2026-08-18: nifty50 50, niftynext50 50, nifty100 100, nifty500 500,
 * banknifty 14, niftyit 10, niftymidcap100 100, niftysmallcap100 100 — all with
 * `removedOn: null`). There is NO `nifty200` row, so "Nifty 100/200/500" is
 * served by the ids that exist; an id we do not know simply does not promote its
 * members, which degrades to `NSE_OTHER` rather than throwing.
 */
export const INDEX_TIER_BY_ID: Readonly<Record<string, number>> = {
  nifty50: OWNERSHIP_TIER.NIFTY50,
  nifty100: OWNERSHIP_TIER.NIFTY100,
  niftynext50: OWNERSHIP_TIER.NIFTY100,
  banknifty: OWNERSHIP_TIER.NIFTY100,
  niftyit: OWNERSHIP_TIER.NIFTY100,
  nifty500: OWNERSHIP_TIER.NIFTY500,
  niftymidcap100: OWNERSHIP_TIER.NIFTY500,
  niftysmallcap100: OWNERSHIP_TIER.NIFTY500,
};

export interface OwnershipQueueEntry {
  symbol: string;
  exchange: string;
  tier: number;
}

export interface OwnershipQueue {
  /** Priority-ordered, deduped. This is the walk order. */
  symbols: string[];
  /** symbol -> where it came from. Callers need `exchange` at write time. */
  entries: ReadonlyMap<string, OwnershipQueueEntry>;
  /** Tier label -> count. Straight into the sync log. */
  tierCounts: Record<string, number>;
}

/**
 * Build the priority-ordered ownership queue.
 *
 * DEDUPE IS BY SYMBOL, LOWEST TIER WINS. A company listed on both exchanges
 * appears once (measured: 2,465 of 10,604 BSE rows share their symbol with an
 * NSE row) and is fetched under its NSE identity, which is the only identity
 * these endpoints accept. ISIN was evaluated as a second dedupe key and rejected
 * on evidence: it merges ZERO additional rows, because only 3,165 of 10,437 NSE
 * rows carry an ISIN at all (the Kite dump has no ISIN column — MONEY-1085).
 *
 * The residual is 7 symbols that exist on BOTH exchanges with DIFFERENT ISINs,
 * i.e. genuinely different companies sharing a ticker (SEL, MAL, RAJPUTANA,
 * ZEAL, GSTL, +2). NSE wins the symbol, so the BSE company is not reached. That
 * is not a choice this function can make differently: `ShareholdingPattern` is
 * unique on `(symbol, quarter)`, so writing both would collide, and the NSE API
 * cannot serve the BSE one anyway.
 *
 * Order WITHIN a tier is `sort()` — stable across runs, which is what makes the
 * cursor's index meaningful.
 */
export function buildOwnershipQueue(
  universe: readonly OwnershipUniverseEntry[],
  indexMembers: ReadonlyMap<string, readonly string[]>,
): OwnershipQueue {
  // symbol -> best (lowest) tier seen from any index it belongs to.
  const indexTier = new Map<string, number>();
  for (const [indexId, members] of indexMembers) {
    const tier = INDEX_TIER_BY_ID[indexId.trim().toLowerCase()];
    if (tier === undefined) continue;
    for (const member of members) {
      const clean = cleanSymbol(member);
      if (clean === "") continue;
      const prev = indexTier.get(clean);
      if (prev === undefined || tier < prev) indexTier.set(clean, tier);
    }
  }

  const best = new Map<string, OwnershipQueueEntry>();
  for (const row of universe) {
    const symbol = cleanSymbol(row.symbol);
    if (symbol === "") continue;
    const exchange = (row.exchange ?? "").trim().toUpperCase();
    const tier =
      exchange === "NSE"
        ? (indexTier.get(symbol) ?? OWNERSHIP_TIER.NSE_OTHER)
        : OWNERSHIP_TIER.BSE_ONLY;
    const prev = best.get(symbol);
    // Lowest tier wins; on a tie the first writer wins, so the result does not
    // depend on the order Mongo happened to return.
    if (prev === undefined || tier < prev.tier) {
      best.set(symbol, { symbol, exchange, tier });
    }
  }

  const symbols = Array.from(best.values())
    .sort((a, b) =>
      a.tier !== b.tier
        ? a.tier - b.tier
        : a.symbol < b.symbol
          ? -1
          : a.symbol > b.symbol
            ? 1
            : 0,
    )
    .map((e) => e.symbol);

  const tierCounts: Record<string, number> = {};
  for (const entry of best.values()) {
    const label = OWNERSHIP_TIER_LABEL[entry.tier] ?? String(entry.tier);
    tierCounts[label] = (tierCounts[label] ?? 0) + 1;
  }

  return { symbols, entries: best, tierCounts };
}

/**
 * Where the next run resumes.
 *
 * Persisted in `MarketDataSyncLog.metadata`, one per leg — see the processor.
 * `lastSymbol` is the authority and `index` is the fallback, in that order, and
 * the ordering is the point: the queue GROWS (the universe moved 10,340 ->
 * 10,506 in six days), and a bare index would silently shift its meaning under
 * every new listing — the same positional-instability that made `index % 7`
 * unusable as a sharder.
 */
export interface OwnershipCursor {
  index: number;
  lastSymbol: string | null;
}

/**
 * Resolve a stored cursor against the CURRENT queue.
 *
 * `lastSymbol` found -> resume immediately after it, exactly. Not found (the
 * symbol delisted, or the tiering moved it) -> fall back to the stored index,
 * clamped. No cursor at all -> start at the head, which is Nifty 50.
 *
 * Wraps: a cursor at the end resumes at 0, so a completed pass rolls straight
 * into the next one.
 */
export function resolveCursorIndex(
  symbols: readonly string[],
  prev: OwnershipCursor | null | undefined,
): number {
  const n = symbols.length;
  if (n === 0) return 0;
  if (!prev) return 0;

  if (prev.lastSymbol) {
    const at = symbols.indexOf(cleanSymbol(prev.lastSymbol));
    if (at >= 0) return (at + 1) % n;
  }

  if (Number.isFinite(prev.index)) {
    const i = Math.trunc(prev.index);
    return ((i % n) + n) % n;
  }
  return 0;
}

/**
 * Take at most `cap` symbols starting at `start`, wrapping once.
 *
 * Never returns the same symbol twice in one slice: `cap` is clamped to the
 * queue length. A run that re-fetched a symbol inside its own slice would burn
 * budget it does not have.
 */
export function sliceQueue(
  symbols: readonly string[],
  start: number,
  cap: number,
): string[] {
  const n = symbols.length;
  if (n === 0) return [];
  if (!Number.isFinite(cap) || cap <= 0) return [];
  const take = Math.min(Math.trunc(cap), n);
  const from = ((Math.trunc(start) % n) + n) % n;
  const out: string[] = [];
  for (let i = 0; i < take; i++) out.push(symbols[(from + i) % n]!);
  return out;
}

/**
 * Advance the cursor by what the run ACTUALLY consumed.
 *
 * `consumed` is symbols processed + symbols failed — a symbol whose fetch threw
 * has been paid for in wall clock and must not be retried ahead of 18,000 that
 * have never been tried at all. Symbols the budget never reached are NOT
 * consumed, so the next run picks them up first. That is the entire fix: the old
 * code advanced by a constant 600 while consuming 310-410.
 */
export function advanceCursor(
  symbols: readonly string[],
  start: number,
  consumed: number,
): OwnershipCursor {
  const n = symbols.length;
  if (n === 0) return { index: 0, lastSymbol: null };
  const from = ((Math.trunc(start) % n) + n) % n;
  const moved = Math.max(0, Math.min(Math.trunc(consumed), n));
  if (moved === 0) return { index: from, lastSymbol: null };
  const next = (from + moved) % n;
  return { index: next, lastSymbol: symbols[(next - 1 + n) % n] ?? null };
}

/** A full pass slower than this is reported as an ERROR, not a log line. */
export const FULL_PASS_ALERT_DAYS = 7;

/**
 * Days to walk the whole queue once, at the rate this run actually achieved.
 *
 * Returns `null` — not Infinity, not a large number — when it cannot be
 * determined (nothing consumed, or an unstated cadence). "Could not determine"
 * has to stay a distinct value: a fabricated 0 reads as "instant coverage" and a
 * fabricated Infinity fires the alert on every explicit-symbol backfill.
 */
export function projectedPassDays(
  queueLength: number,
  consumedPerRun: number,
  runsPerDay: number,
): number | null {
  if (!Number.isFinite(queueLength) || queueLength <= 0) return 0;
  if (!Number.isFinite(consumedPerRun) || consumedPerRun <= 0) return null;
  if (!Number.isFinite(runsPerDay) || runsPerDay <= 0) return null;
  return queueLength / (consumedPerRun * runsPerDay);
}

// ── Run verdict + sync-log shaping (MONEY-1207) ──────────────────────────────
//
// PURE, and living here rather than in the processor for one concrete reason:
// the processor imports Prisma at module scope, so a unit test that reached in
// for these would construct a PrismaClient and risk an orphaned handle. The
// decisions themselves are arithmetic over counters and belong beside the rest
// of this module's scheduling arithmetic anyway.

/**
 * A per-symbol leg is judged BARREN once it has this many non-empty payloads and
 * still zero rows. Below it, "nobody filed anything" is a real explanation.
 */
export const BARREN_MIN_PAYLOADS = 20;

export interface LegOutcome {
  leg: string;
  /** Payloads requested. */
  fetched: number;
  /** Of those, the ones that came back null / unusable. */
  emptyResponses: number;
  /** Rows the parser produced. */
  rows: number;
  /** Rows actually written. */
  written: number;
  /**
   * A leg that issues ONE bulk request for the whole market (pledge). Judged
   * against a threshold of 1 rather than {@link BARREN_MIN_PAYLOADS}, because
   * "one well-formed response containing nothing" is the entire signal it has.
   */
  bulk?: boolean;
}

export type RunStatus = "COMPLETED" | "PARTIAL" | "FAILED";

export interface RunVerdict {
  status: RunStatus;
  /** Human-readable, one per rule that fired. Goes straight into the log. */
  notes: string[];
  barrenLegs: string[];
}

/**
 * Decide the run status from the counters — the MONEY-1169/1189 class.
 *
 * The old code wrote `status: "COMPLETED"` unconditionally. On 2026-08-16 all
 * three per-symbol legs fetched ~390 non-empty payloads each and parsed ZERO
 * rows between them; the run was recorded COMPLETED with `recordsProcessed: 0`
 * and nothing anywhere said otherwise. A status field that cannot say "no" is
 * not a status field.
 *
 * BARREN is the sharp test, and it is deliberately about PAYLOADS rather than
 * rows: NSE answers a request it dislikes with a well-formed `{"data":[]}`, so
 * "we asked 390 times, got 390 answers, and produced nothing" is a failure of
 * our side of the contract — a broken parser, a changed shape, or a soft block —
 * whereas "we asked 5 times" is just a quiet week.
 *
 * FAILED vs PARTIAL: FAILED means the run produced no usable output at all
 * (nothing written despite real payloads, or the models are missing). PARTIAL
 * means some of it worked. Both are actionable; COMPLETED must mean COMPLETED.
 */
export function decideRunStatus(input: {
  legs: readonly LegOutcome[];
  totalWritten: number;
  writeFailed: number;
  symbolsAttempted: number;
  symbolsFailed: number;
  missingModels: readonly string[];
  /**
   * A per-symbol leg was asked to run and the queue came back EMPTY. Distinct
   * from "nothing to do": the universe query cannot legitimately return zero
   * active equities, so this is an infrastructure failure that would otherwise
   * present as a serene COMPLETED with every counter at 0 — the same shape the
   * 2026-08-16 run wore.
   */
  emptyQueue?: boolean;
}): RunVerdict {
  const notes: string[] = [];
  const barrenLegs: string[] = [];
  let nonEmptyTotal = 0;

  if (input.emptyQueue) {
    notes.push(
      "the symbol queue was EMPTY while per-symbol legs were requested — the " +
        "universe query returned nothing, which is never a real market state",
    );
    return { status: "FAILED", notes, barrenLegs };
  }

  for (const leg of input.legs) {
    const nonEmpty = Math.max(0, leg.fetched - leg.emptyResponses);
    nonEmptyTotal += nonEmpty;
    const threshold = leg.bulk ? 1 : BARREN_MIN_PAYLOADS;
    if (nonEmpty >= threshold && leg.rows === 0) {
      barrenLegs.push(leg.leg);
      notes.push(
        `leg ${leg.leg} parsed 0 rows from ${nonEmpty} non-empty payload(s) — ` +
          `that is a parser/shape failure, not an empty market` +
          (leg.bulk
            ? " (a market holiday is indistinguishable from this for a bulk leg)"
            : ""),
      );
    }
  }

  if (input.missingModels.length > 0) {
    notes.push(
      `Prisma models missing: ${input.missingModels.join(", ")} — nothing could be written`,
    );
    return { status: "FAILED", notes, barrenLegs };
  }

  if (nonEmptyTotal >= BARREN_MIN_PAYLOADS && input.totalWritten === 0) {
    notes.push(`0 rows written across ${nonEmptyTotal} non-empty payload(s)`);
    return { status: "FAILED", notes, barrenLegs };
  }

  if (barrenLegs.length > 0) {
    return { status: "PARTIAL", notes, barrenLegs };
  }

  if (input.writeFailed > 0) {
    notes.push(`${input.writeFailed} row write(s) failed`);
    return { status: "PARTIAL", notes, barrenLegs };
  }

  // A handful of transient NSE timeouts in a 700-symbol walk is normal and must
  // not cry wolf; losing 5% of the slice is not.
  const failureFloor = Math.max(5, Math.ceil(input.symbolsAttempted * 0.05));
  if (input.symbolsFailed >= failureFloor) {
    notes.push(
      `${input.symbolsFailed} of ${input.symbolsAttempted} symbols failed ` +
        `(>= the ${failureFloor} tolerance)`,
    );
    return { status: "PARTIAL", notes, barrenLegs };
  }

  return { status: "COMPLETED", notes, barrenLegs };
}

/**
 * Shallow-merge the completion metadata ONTO what the `create` wrote.
 *
 * The old completion `update` passed a fresh object, and Prisma replaces a Json
 * column wholesale — so `shardFull`, `skippedByCap` and `cycleWeeks`, the only
 * three fields that could have shown the starvation, were destroyed by every
 * SUCCESSFUL run and survived only on runs that crashed. Verified against prod:
 * all eight completed logs carry `shardSize: 600` and no `shardFull` at all.
 *
 * SHALLOW on purpose. A deep merge would combine the per-leg counter objects
 * from the start record with the final ones and silently double them.
 */
export function mergeSyncMetadata(
  previous: unknown,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    typeof previous === "object" &&
    previous !== null &&
    !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {};
  return { ...base, ...next };
}

/**
 * Read the per-leg cursors out of a stored `metadata` blob.
 *
 * Tolerant by design: this reads data written by an EARLIER DEPLOY, and a
 * malformed or absent cursor must degrade to "start from the head" rather than
 * throw inside a scheduled job.
 */
export function readStoredCursors(
  metadata: unknown,
): Record<string, OwnershipCursor> {
  const out: Record<string, OwnershipCursor> = {};
  if (typeof metadata !== "object" || metadata === null) return out;
  const cursors = (metadata as Record<string, unknown>).cursors;
  if (typeof cursors !== "object" || cursors === null) return out;
  for (const [leg, value] of Object.entries(
    cursors as Record<string, unknown>,
  )) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const index =
      typeof v.index === "number" && Number.isFinite(v.index) ? v.index : 0;
    const lastSymbol = typeof v.lastSymbol === "string" ? v.lastSymbol : null;
    out[leg] = { index, lastSymbol };
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// LEG 5 — NSE SHP XBRL -> ShareholdingBreakdown  (MONEY-1205)
// ═════════════════════════════════════════════════════════════════════════════
//
// The summary endpoint above carries NO FII/DII at all: `SHAREHOLDING_KEYS.fii`
// and `.dii` resolve to null on 100% of prod's 7,953 rows, which downstream
// reads as "this company has no institutional holders" rather than "we never
// fetched it". The split lives in the XBRL filing, and the SAME summary payload
// already links it (`xbrl`, alongside `xbrlFileSize`) — so the fetch list is
// already sitting in `shareholding_patterns.raw` and needs no new discovery
// endpoint. Measured on prod 2026-08-18 over a 4,000-row sample: 3,969 rows
// carry a real `.xml` link, 31 carry the `-` sentinel below, 0 carry nothing.
//
// The parse itself is `parseShareholdingXbrl` in @usemoney/core/market-data.
// What lives here is only the SELECTION and the WRITE POLICY — the two
// decisions the processor must not make inline, because they are exactly the
// decisions a unit test can falsify.

/** Archive feed slug for the filings. `feeds/NSE/shp-xbrl/{YYYY}/{MM}/…`. */
export const SHP_XBRL_FEED_SLUG = "shp-xbrl";

/** Referer the archive host answers to. Verified 200 + 146,564 bytes. */
export const SHP_XBRL_REFERER =
  "https://www.nseindia.com/companies-listing/corporate-filings-shareholding-pattern";

/**
 * The archive day for one filing: the QUARTER END, never the broadcast day.
 *
 * ## Why DATED and not `current/`
 *
 * These are thousands of IMMUTABLE per-(symbol, quarter) documents whose whole
 * value is the quarter SERIES. `buildFeedArchiveKey` files an undated
 * descriptor under `current/` and overwrites in place — correct for a master
 * that only ever means "as it stands now", and destructive here: every quarter
 * of a symbol would collapse onto one object and the trend this exists to build
 * would be gone.
 *
 * ## Why the QUARTER END and not the day we fetched
 *
 * A restatement is re-broadcast months later. Keying on the broadcast day would
 * file the re-broadcast under a different `{YYYY}/{MM}` prefix from the
 * original, so one quarter of one symbol would occupy two prefixes and neither
 * would be findable from the quarter alone.
 *
 * ## Why UTC noon on the 15th
 *
 * `buildFeedArchiveKey` runs the date through `toIstDateKey` (+5:30). Noon has
 * 12 hours of headroom, so the conversion cannot roll into an adjacent day, let
 * alone an adjacent MONTH — and the month is the whole content of the key. The
 * 15th is mid-month for the same reason: nothing about a month boundary can
 * move it.
 *
 * Returns `undefined` — which lands the object under `current/` — for a label
 * we cannot read. That is deliberate: an unparsed label is precisely the case
 * where a GUESSED month would file the object somewhere no reader will look,
 * and `current/` is at least honest about being unkeyed. `normalizeQuarter`
 * keeps such labels verbatim (`"Q1FY26"`), so they exist and are rare.
 */
export function shpXbrlArchiveDay(quarter: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})$/.exec(quarter.trim());
  if (m === null) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return undefined;
  return new Date(Date.UTC(year, month - 1, 15, 12));
}

/**
 * Is this `xbrl` value a document we can actually fetch?
 *
 * NSE emits `https://nsearchives.nseindia.com/corporate/xbrl/-` for filings
 * with NO XBRL — 31 of a 4,000-row prod sample, ~89 extrapolated over 7,953.
 * That URL answers **200 with an HTML page**, so it is not caught by a status
 * check, by `getFeedAsset`'s 404 → null, or by anything downstream of the
 * request. Fetching it is pure waste that lands in the unparseable counter and
 * — worse — puts an HTML page into the archive under a real quarter key, where
 * replay would serve it forever.
 *
 * So the gate is BEFORE the request, and it is the file extension, because that
 * is the only thing that distinguishes the two before bytes come back.
 */
export function isFetchableXbrlUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (!url.toLowerCase().startsWith("https://")) return false;
  return url.toLowerCase().endsWith(".xml");
}

/** One filing this run may fetch, with the summary row it must agree with. */
export interface ShpXbrlCandidate {
  symbol: string;
  quarter: string;
  url: string;
  /** From the stored summary row — the reconcile input, not the parse output. */
  promoterPct: number | null;
  publicPct: number | null;
  /** From the stored `raw`, when the payload carried one. */
  isin: string | null;
}

/** A stored `shareholding_patterns` row, reduced to what selection needs. */
export interface StoredShareholdingRow {
  symbol: string;
  quarter: string;
  raw: string;
  promoterPct: number | null;
  publicPct: number | null;
}

/**
 * Which of a symbol's stored summary rows still need their filing fetched.
 *
 * NEWEST FIRST (`quarter` is `YYYY-MM`, so a plain descending string sort is
 * the calendar order), because the most recent split is what a reader wants and
 * because a run that is cut short must have spent its budget on that.
 *
 * `done` is the set of quarters `shareholding_breakdown` already holds for this
 * symbol on this exchange. Everything refused is COUNTED rather than dropped:
 * `noXbrlLink` is the sentinel above, `alreadyStored` is the steady state, and
 * `overCap` is the per-run bound that stops one 47-quarter symbol eating a
 * whole leg.
 */
export function pendingShpFilings(
  rows: readonly StoredShareholdingRow[],
  done: ReadonlySet<string>,
  cap: number,
): { pending: ShpXbrlCandidate[]; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  const ordered = [...rows].sort((a, b) =>
    a.quarter < b.quarter ? 1 : a.quarter > b.quarter ? -1 : 0,
  );

  const pending: ShpXbrlCandidate[] = [];
  const limit = Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : 0;

  for (const row of ordered) {
    if (done.has(row.quarter)) {
      bump(reasons, "alreadyStored");
      continue;
    }
    const parsed = readStoredShpRaw(row.raw);
    if (!isFetchableXbrlUrl(parsed.xbrlUrl)) {
      bump(reasons, "noXbrlLink");
      continue;
    }
    if (pending.length >= limit) {
      bump(reasons, "overCap");
      continue;
    }
    pending.push({
      symbol: cleanSymbol(row.symbol),
      quarter: row.quarter,
      url: parsed.xbrlUrl,
      promoterPct: row.promoterPct,
      publicPct: row.publicPct,
      isin: parsed.isin,
    });
  }

  return { pending, reasons };
}

/**
 * The two fields Leg 5 needs out of the stored summary row.
 *
 * `raw` is a String column holding NSE's row verbatim, so this is a re-parse of
 * our own audit artifact rather than a second fetch. Never throws: `raw` is
 * unvalidated by construction (that is the whole point of storing it as a
 * string), and a scheduled job must not die on one malformed row.
 */
export function readStoredShpRaw(raw: string): {
  xbrlUrl: string | null;
  isin: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { xbrlUrl: null, isin: null };
  }
  if (!isRecord(parsed)) return { xbrlUrl: null, isin: null };
  const url = parsed.xbrl;
  const isin = cleanText(parsed.isin, 32);
  return {
    xbrlUrl: typeof url === "string" && url.trim() !== "" ? url.trim() : null,
    isin: isin === "" ? null : isin.toUpperCase(),
  };
}

/** What the processor does with one reconcile verdict. */
export interface BreakdownWriteDecision {
  write: boolean;
  /** Counter key. Goes straight into the sync log's per-leg `reasons`. */
  reason: string;
}

/**
 * Write, or refuse and record — the ONLY policy for a reconcile verdict.
 *
 * ## `disagree` is a REFUSAL, never an overwrite
 *
 * The XBRL URL comes out of the summary payload, so a mis-keyed row, a reused
 * `recordId` or a restated filing pointing at the wrong document all arrive
 * here as a perfectly valid filing for the WRONG company.
 * `ShareholdingBreakdown` upserts on `(symbol, exchange, quarter)` with
 * last-filing-wins, so writing anyway would silently replace a correct row with
 * another company's numbers and nothing downstream could tell. The verdict is
 * recorded in the sync log with both sides and the delta, which is the only
 * artifact that makes the disagreement investigable.
 *
 * ## `incomparable` splits, and the split is the point
 *
 * `noComparableValue` — identity was checked and matched; there was simply no
 * field with a non-null on BOTH sides. CUB files no promoter table at all (it
 * has no promoter), so its breakdown `promoterPct` is null against a summary
 * `0`. Refusing that would drop every promoter-less company, so it is WRITTEN
 * and counted under its own key, never folded into `agree`.
 *
 * `noSymbolOnOneSide` — identity could NOT be checked. That is the case the
 * whole reconciliation exists for: an unchecked document is exactly what a
 * mis-keyed `xbrl` link produces, and "we could not tell whose filing this is"
 * must not resolve to "write it". REFUSED.
 *
 * ## ISIN never decides anything
 *
 * NSE's own summary and NSE's own filing disagree on ISIN for 2 of 5 sampled
 * prod symbols (BANKBARODA `IN9028A01011` vs `INE028A01039`; CUB
 * `IN9491A01011` vs `INE491A01021`), both unambiguously the right company by
 * symbol, quarter and every percentage. Letting it block would reject 40% of a
 * healthy sample. It is surfaced by the counter suffix and nothing else.
 */
export function decideBreakdownWrite(
  verdict: ShareholdingReconcileVerdict,
): BreakdownWriteDecision {
  if (verdict.status === "agree") {
    return {
      write: true,
      reason: verdict.isinMismatch ? "agreeIsinMismatch" : "agree",
    };
  }
  if (verdict.status === "disagree") {
    return { write: false, reason: `disagree:${verdict.field}` };
  }
  if (verdict.reason === "noSymbolOnOneSide") {
    return { write: false, reason: "incomparableNoIdentity" };
  }
  return {
    write: true,
    reason: verdict.isinMismatch
      ? "incomparableIsinMismatch"
      : "incomparableNoValue",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// LEG 6 — BSE shareholding -> ShareholdingPattern + ShareholdingBreakdown
// ═════════════════════════════════════════════════════════════════════════════
//
// 8,139 BSE-only symbols have ZERO shareholding rows today and that is by
// construction, not by accident: every NSE endpoint above is keyed on the NSE
// trading symbol, so a company NSE does not list can never be reached through
// them however many times the queue comes round.
//
// BSE is keyed by SCRIP CODE, not by symbol, which is the one thing this leg
// has that the NSE legs do not. The lookup is established ONCE per run from the
// scrip master we already fetch nightly (`bse-master-instruments.ts`), never
// per symbol — a per-symbol resolution would be 10,604 requests to answer a
// question one 12,664-row payload answers completely.

/** BSE month-name labels seen in `/SHPQNewFormat/w`, e.g. "June 2026". */
const BSE_MONTH_BY_NAME: Readonly<Record<string, number>> = {
  JAN: 1,
  JANUARY: 1,
  FEB: 2,
  FEBRUARY: 2,
  MAR: 3,
  MARCH: 3,
  APR: 4,
  APRIL: 4,
  MAY: 5,
  JUN: 6,
  JUNE: 6,
  JUL: 7,
  JULY: 7,
  AUG: 8,
  AUGUST: 8,
  SEP: 9,
  SEPT: 9,
  SEPTEMBER: 9,
  OCT: 10,
  OCTOBER: 10,
  NOV: 11,
  NOVEMBER: 11,
  DEC: 12,
  DECEMBER: 12,
};

/**
 * BSE's quarter LABEL -> the `YYYY-MM` key, or null.
 *
 * This is a PRE-FILTER and nothing else. The authority for the stored quarter
 * is `fld_enddate` inside the summary payload, run through `normalizeQuarter`,
 * exactly as `parseBseShareholding` does it — because that is the field the row
 * is keyed on and the label is not.
 *
 * It exists because the index endpoint returns a scrip's ENTIRE history (106
 * quarters for RELIANCE, back to 2001) while the label alone cannot be handed
 * to `normalizeQuarter`: that function's date parser cannot read a day-less
 * `"June 2026"` and would keep it verbatim as `"JUNE 2026"`, which matches no
 * stored `2026-06` and would therefore re-fetch every quarter of every scrip on
 * every pass, forever.
 *
 * Both live shapes are handled, measured on scrip 500325 (2026-08-18): the
 * regular `"June 2026"` / `"December 2025"` form, and the off-cycle
 * `"29 Oct 2024"` form, which `parseEventDate` already reads.
 *
 * Returns null — never a guess — for anything else, and the caller's contract
 * is that a null means FETCH IT, not SKIP IT. An unreadable label must cost a
 * request, not a hole.
 */
export function bseQuarterLabelToKey(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const squeezed = label.trim().replace(/\s+/g, " ");
  if (squeezed === "") return null;

  // The dated form first: `parseEventDate` reads "29 Oct 2024" and every other
  // dialect the ownership feeds emit, and reusing it means the two paths cannot
  // drift.
  const asDate = parseEventDate(squeezed);
  if (asDate) {
    const y = asDate.getUTCFullYear();
    const m = String(asDate.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(squeezed);
  if (m === null) return null;
  const month = BSE_MONTH_BY_NAME[m[1]!.toUpperCase()];
  if (month === undefined) return null;
  const year = Number(m[2]);
  if (!plausibleYear(year)) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** A scrip-master row, reduced to the three fields identity needs. */
export interface BseScripMasterRow {
  scripId: string;
  scripCode: string;
  isin: string | null;
}

/** symbol -> scrip code, plus the evidence for how well it worked. */
export interface BseScripIndex {
  bySymbol: ReadonlyMap<string, string>;
  masterRows: number;
  resolvedBySymbol: number;
  resolvedByIsin: number;
  /** Stored ISIN present in the master more than once — never guessed at. */
  ambiguousIsin: number;
  unresolved: number;
}

/**
 * symbol -> BSE scrip code, built ONCE per run.
 *
 * `scrip_id` is BSE's trading symbol and matches our stored BSE `symbol` for
 * 10,254 of 10,604 active BSE equities (96.7%). ISIN is the fallback for the
 * remainder and is applied ONLY when it is unambiguous in the master — an ISIN
 * appearing against two scrip codes resolves to neither, and is counted so the
 * ambiguity is visible instead of being decided by iteration order.
 *
 * First writer wins on a duplicated `scrip_id` for the same reason
 * `buildNameToSymbolMap` does it: the result must not depend on the order the
 * feed happened to serialise its rows. Measured 2026-08-18, the master has
 * 12,664 rows and 12,664 DISTINCT `scrip_id`s, so that arm is a guard rather
 * than a live path.
 */
export function buildBseScripIndex(
  master: readonly BseScripMasterRow[],
  symbols: readonly { symbol: string; isin?: string | null }[],
): BseScripIndex {
  const byScripId = new Map<string, string>();
  const byIsin = new Map<string, string | null>();

  for (const row of master) {
    const id = cleanSymbol(row.scripId);
    const code = typeof row.scripCode === "string" ? row.scripCode.trim() : "";
    if (code === "") continue;
    if (id !== "" && !byScripId.has(id)) byScripId.set(id, code);

    const isin = cleanText(row.isin ?? undefined, 32).toUpperCase();
    if (isin === "") continue;
    // `null` is the AMBIGUOUS marker, distinct from absent. Collapsing the two
    // would let a second sighting silently overwrite the first.
    if (byIsin.has(isin)) {
      if (byIsin.get(isin) !== code) byIsin.set(isin, null);
    } else {
      byIsin.set(isin, code);
    }
  }

  const out = new Map<string, string>();
  let resolvedBySymbol = 0;
  let resolvedByIsin = 0;
  let ambiguousIsin = 0;
  let unresolved = 0;

  for (const entry of symbols) {
    const symbol = cleanSymbol(entry.symbol);
    if (symbol === "" || out.has(symbol)) continue;

    const direct = byScripId.get(symbol);
    if (direct !== undefined) {
      out.set(symbol, direct);
      resolvedBySymbol++;
      continue;
    }

    const isin = cleanText(entry.isin ?? undefined, 32).toUpperCase();
    if (isin !== "" && byIsin.has(isin)) {
      const code = byIsin.get(isin);
      if (code === null) {
        ambiguousIsin++;
        continue;
      }
      out.set(symbol, code!);
      resolvedByIsin++;
      continue;
    }
    unresolved++;
  }

  return {
    bySymbol: out,
    masterRows: master.length,
    resolvedBySymbol,
    resolvedByIsin,
    ambiguousIsin,
    unresolved,
  };
}

/** The BSE leg's own queue — its own symbols, so its own cursor. */
export interface BseShpQueue {
  /** Priority-ordered, deduped. The walk order and the cursor's coordinate. */
  symbols: string[];
  /** symbol -> scrip code, for the symbols in {@link symbols} only. */
  scripBySymbol: ReadonlyMap<string, string>;
  tierCounts: Record<string, number>;
  /** BSE-listed symbols the master could not place. Counted, never fetched. */
  unresolved: number;
}

/**
 * The BSE leg's queue: every ACTIVE BSE-listed equity whose scrip code we know.
 *
 * ## Why dual listings are IN, not deduped away
 *
 * `buildOwnershipQueue` deliberately collapses a dual-listed company onto its
 * NSE identity, because the NSE endpoints accept no other. This queue must do
 * the opposite: BSE publishes the SAME company's pattern separately, the widened
 * `(symbol, exchange, quarter)` unique gives the two filings two rows, and
 * dropping the 2,465 dual listings here would throw away BSE's statement about
 * exactly the largest companies in the market.
 *
 * ## Why it borrows the NSE tier
 *
 * `tierOf` is the main queue's symbol -> tier map, so RELIANCE's BSE listing is
 * fetched in tier 0 alongside its NSE one rather than sitting at the back with
 * the BSE-only tail. A symbol NSE does not list has no tier and lands in
 * `BSE_ONLY`, which is where it belongs.
 */
export function buildBseShpQueue(
  universe: readonly OwnershipUniverseEntry[],
  scripBySymbol: ReadonlyMap<string, string>,
  tierOf: ReadonlyMap<string, number>,
): BseShpQueue {
  const best = new Map<string, { symbol: string; tier: number }>();
  let unresolved = 0;

  for (const row of universe) {
    const exchange = (row.exchange ?? "").trim().toUpperCase();
    if (exchange !== "BSE") continue;
    const symbol = cleanSymbol(row.symbol);
    if (symbol === "" || best.has(symbol)) continue;
    if (!scripBySymbol.has(symbol)) {
      unresolved++;
      continue;
    }
    best.set(symbol, {
      symbol,
      tier: tierOf.get(symbol) ?? OWNERSHIP_TIER.BSE_ONLY,
    });
  }

  const ordered = Array.from(best.values()).sort((a, b) =>
    a.tier !== b.tier
      ? a.tier - b.tier
      : a.symbol < b.symbol
        ? -1
        : a.symbol > b.symbol
          ? 1
          : 0,
  );

  const tierCounts: Record<string, number> = {};
  for (const e of ordered) {
    const label = OWNERSHIP_TIER_LABEL[e.tier] ?? String(e.tier);
    tierCounts[label] = (tierCounts[label] ?? 0) + 1;
  }

  const symbols = ordered.map((e) => e.symbol);
  const scoped = new Map<string, string>();
  for (const s of symbols) scoped.set(s, scripBySymbol.get(s)!);

  return { symbols, scripBySymbol: scoped, tierCounts, unresolved };
}

/**
 * Which of a scrip's quarters still need fetching, newest first.
 *
 * `quarters` is `parseBseShpQuarters`' output, which BSE already serves
 * newest-first and which is already deduped by LABEL (a revision and its
 * original are two rows for one quarter — `130.01/June 2026/Revised` above
 * `130/June 2026/New` — and the revision, being first, wins).
 *
 * PRECISION WITH A CATCH-ALL: a label this cannot key is INCLUDED, never
 * skipped. Skipping on an unreadable label would open a permanent hole that
 * looks exactly like a scrip that never filed; including it costs one request
 * and an idempotent upsert.
 */
export function pendingBseQuarters(
  quarters: readonly BseShpQuarter[],
  stored: ReadonlySet<string>,
  cap: number,
): {
  pending: Array<{ quarter: BseShpQuarter; expectedKey: string | null }>;
  reasons: Record<string, number>;
} {
  const reasons: Record<string, number> = {};
  const pending: Array<{
    quarter: BseShpQuarter;
    expectedKey: string | null;
  }> = [];
  const limit = Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : 0;

  for (const q of quarters) {
    const key = bseQuarterLabelToKey(q.label);
    if (key !== null && stored.has(key)) {
      bump(reasons, "alreadyStored");
      continue;
    }
    if (key === null) bump(reasons, "unreadableLabel");
    if (pending.length >= limit) {
      bump(reasons, "overCap");
      continue;
    }
    pending.push({ quarter: q, expectedKey: key });
  }

  return { pending, reasons };
}
