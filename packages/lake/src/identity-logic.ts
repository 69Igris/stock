/**
 * Security identity — the lake's answer to "which company is this?".
 * MONEY-1498 (data-platform B3).
 *
 * Pure: no BigQuery, no Mongo, no clock, no filesystem. `scripts/jobs/identity-sync.ts`
 * is the I/O shell. Every join in the lake and every linker in Track C reads
 * this, so a wrong answer here is two companies rendered as one series.
 *
 * ## THE PROBLEM, IN ONE ROW PAIR
 *
 * Tiingo's master carries two rows for `DOW` on NYSE, identical in exchange,
 * assetType and currency:
 *
 *     DOW,NYSE,Stock,USD,1972-06-01,2017-08-31   <- Dow Chemical
 *     DOW,NYSE,Stock,USD,2019-03-20,2026-08-27   <- Dow Inc.
 *
 * 2,196 tickers repeat; 834 delisted rows share a ticker with a live one
 * (measured 2026-08-28, `model Candle` in schema.prisma). Tiingo serves only
 * the CURRENT occupant, and `permaTicker` cannot name a delisted predecessor —
 * so identity has to be `(symbol, venue, window)`, and every lookup has to
 * carry an AS-OF date. A lookup without one silently means "as of now", which
 * is the fourth clock in `lake-layout.md` §6 and the one that flatters a
 * backtest.
 *
 * ## HALF-OPEN INTERVALS, `[valid_from, valid_to)`
 *
 * This is the single most load-bearing decision in the file. SCD-2 closes a row
 * with `valid_to = today` and opens its successor with `valid_from = today`. If
 * the interval were closed at both ends, `today` would match BOTH rows — the
 * exact ambiguity versioning exists to remove — and whichever the query planner
 * happened to return first would win.
 *
 * It also means a vendor's INCLUSIVE last-traded date must be converted:
 * Tiingo's `2017-08-31` for Dow Chemical is the last day it traded, so
 * `valid_to` is `2017-09-01`. `endDateToValidTo` does that, and a query for
 * exactly 2017-08-31 must still find Dow Chemical. That is a test.
 *
 * ## DATES ARE ISO STRINGS, COMPARED LEXICOGRAPHICALLY
 *
 * `YYYY-MM-DD`, never a `Date`. BigQuery's DATE has no time and no zone; a JS
 * `Date` has both, and every conversion is a chance to move a boundary by a day
 * in one direction for half the planet. Zero-padded ISO dates sort correctly as
 * strings, so `<=` on the string IS the date comparison.
 */

/* ─────────────────────────────────────────────────────────────────────────
   Closed vocabularies
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Stamped into `parser_version` on every identity row.
 *
 * BUMP IT whenever the MEANING of a column changes — a new `valid_to`
 * convention, a different confidence for a method. It is what makes a reparse
 * identifiable: without it a corrected row and an uncorrected one are the same
 * shape, and the only available repair is to rebuild everything
 * (`lake-layout.md` §5). It lives here rather than in the job so a future
 * reparse script cannot spell it differently from the writer.
 *
 * `identity/2` (MONEY-1544): a listing's FIRST version starts at the source's
 * listing date ({@link firstVersions}), not on the day identity-sync first
 * ran. Every `identity/1` listing row was opened on 2026-09-22, both markets;
 * `planRebase` is the repair, and it is what `--rebase-history` applies.
 */
export const IDENTITY_PARSER_VERSION = "identity/2";

/** The seed run's stamp: every first version it wrote starts on the day it ran. */
export const SEED_PARSER_VERSION = "identity/1";

/**
 * MARKET IS A COLUMN, never a second dataset — the 14-Sep region rule
 * (`lake-layout.md` §2). A `lake_silver_us` created "just for now" is how a
 * single-region plane quietly becomes two.
 */
export const MARKETS = ["US", "IN"] as const;
export type Market = (typeof MARKETS)[number];

/**
 * Every system that can name a security to us.
 *
 * STRINGS validated on write, not a BigQuery ENUM — BigQuery has none, and a
 * hand-rolled one costs a schema migration per value (the `ledger-logic.ts`
 * precedent). The set is closed HERE, which is the last place an unknown value
 * can still be refused.
 *
 * Brokers are in the list because a user's holding arrives keyed by the
 * BROKER's identifier (a Zerodha token, an Upstox `NSE_EQ|INE002A01018`), and
 * Track C has to resolve that to a listing without inventing a second identity
 * table per broker.
 */
export const SOURCE_SYSTEMS = [
  "TIINGO",
  "DATABENTO",
  "SEC",
  "NSE",
  "BSE",
  "KITE",
  "UPSTOX",
  "GROWW",
  "ANGEL",
  "DHAN",
  "FYERS",
  "ICICI",
  "HDFC",
  "IBKR",
  "YAHOO",
] as const;
export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

export const LISTING_STATUSES = ["ACTIVE", "DELISTED"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export function isMarket(v: unknown): v is Market {
  return typeof v === "string" && (MARKETS as readonly string[]).includes(v);
}
export function isSourceSystem(v: unknown): v is SourceSystem {
  return (
    typeof v === "string" && (SOURCE_SYSTEMS as readonly string[]).includes(v)
  );
}
export function isListingStatus(v: unknown): v is ListingStatus {
  return (
    typeof v === "string" && (LISTING_STATUSES as readonly string[]).includes(v)
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Dates
   ──────────────────────────────────────────────────────────────────────── */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidDateError extends Error {
  constructor(value: unknown) {
    super(
      `"${String(value)}" is not a YYYY-MM-DD date — identity windows are ` +
        "compared as strings, so a malformed one sorts into the wrong place " +
        "rather than failing",
    );
    this.name = "InvalidDateError";
  }
}

/**
 * Refuse anything that is not a real calendar date.
 *
 * The round trip is the point: `2017-02-30` matches the regex, and a plain
 * pattern check would let it through to be compared as a string against real
 * dates — sorting after 2017-02-28 and before 2017-03-01, which is nowhere.
 */
export function assertIsoDate(v: unknown): asserts v is string {
  if (typeof v !== "string" || !ISO_DATE.test(v)) throw new InvalidDateError(v);
  const t = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new InvalidDateError(v);
  if (new Date(t).toISOString().slice(0, 10) !== v)
    throw new InvalidDateError(v);
}

/** `iso` shifted by `n` calendar days. UTC arithmetic — month, year and leap boundaries included. */
export function addDays(iso: string, n: number): string {
  assertIsoDate(iso);
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The next calendar day. */
export function nextDay(iso: string): string {
  return addDays(iso, 1);
}

/**
 * A vendor's INCLUSIVE last-traded date -> our EXCLUSIVE `valid_to`.
 *
 * Tiingo's master says Dow Chemical ran to `2017-08-31`, meaning it traded that
 * day. Storing that as `valid_to` directly would make a query for 2017-08-31
 * return NOTHING — the ticker would appear to belong to nobody on its own final
 * session, which is precisely the kind of gap that reads as "no data" rather
 * than as an error.
 *
 * `null` in means still open.
 */
export function endDateToValidTo(endDate: string | null): string | null {
  return endDate === null ? null : nextDay(endDate);
}

/**
 * The EXCLUSIVE end of a listing's traded window, from the vendor's inclusive
 * last-traded date — for a DELISTED listing only.
 *
 * An ACTIVE listing's vendor end date is its LATEST PRICE (Tiingo stamps every
 * active row with yesterday's session), not a delisting. Read as an end, it
 * closed all 81,093 active Tiingo map rows on prod at the run day, so no
 * active US listing resolved for any later as-of (measured 2026-09-23).
 */
export function tradedTo(
  status: ListingStatus,
  lastTraded: string | null,
): string | null {
  return status === "DELISTED" ? endDateToValidTo(lastTraded) : null;
}

/** Does `[validFrom, validTo)` contain `asOf`? */
export function windowContains(
  validFrom: string | null,
  validTo: string | null,
  asOf: string,
): boolean {
  assertIsoDate(asOf);
  if (validFrom !== null) {
    assertIsoDate(validFrom);
    if (asOf < validFrom) return false;
  }
  if (validTo !== null) {
    assertIsoDate(validTo);
    if (asOf >= validTo) return false;
  }
  return true;
}

/* ─────────────────────────────────────────────────────────────────────────
   Map confidence
   ──────────────────────────────────────────────────────────────────────── */

/**
 * HOW a source key was tied to a listing. The method IS the confidence — a
 * free-floating float would let two callers disagree about what 0.8 means.
 *
 *   VENDOR_NATIVE          the source's own durable key (a Kite token, a
 *                          Tiingo ticker+exchange from the master itself).
 *                          It is the vendor's identity, not our inference.
 *   EXACT_ISIN / _CIK      a regulator-issued identifier. ISIN is what let
 *                          Zomato-era prices reattach to ETERNAL (MONEY-1175).
 *   EXACT_PERMATICKER      Tiingo's durable id — exact, but ACTIVE-ONLY by
 *                          construction, so it can never name a predecessor.
 *   SYMBOL_VENUE_DATED     matched on (symbol, venue) with a real window.
 *   SYMBOL_VENUE_CURRENT   matched on (symbol, venue) with NO history behind
 *                          it. This is the India seed: `InstrumentMapping` is
 *                          overwritten on every instrument-sync, so the only
 *                          honest claim is about TODAY. A past `as_of` against
 *                          one of these is a guess, and the confidence says so.
 *   SYMBOL_ALIAS_UNDATED   `InstrumentMapping.previousSymbols` — we know the
 *                          security traded under this label, and not when.
 *   NAME_FUZZY             a string match on a company name. Below the join
 *                          floor deliberately: it is a triage hint, never a key.
 */
export const MAP_METHODS = [
  "VENDOR_NATIVE",
  "EXACT_ISIN",
  "EXACT_CIK",
  "EXACT_PERMATICKER",
  "SYMBOL_VENUE_DATED",
  "SYMBOL_VENUE_CURRENT",
  "SYMBOL_ALIAS_UNDATED",
  "NAME_FUZZY",
] as const;
export type MapMethod = (typeof MAP_METHODS)[number];

const METHOD_CONFIDENCE: Readonly<Record<MapMethod, number>> = {
  VENDOR_NATIVE: 1,
  EXACT_ISIN: 1,
  EXACT_CIK: 1,
  EXACT_PERMATICKER: 0.95,
  SYMBOL_VENUE_DATED: 0.9,
  SYMBOL_VENUE_CURRENT: 0.7,
  SYMBOL_ALIAS_UNDATED: 0.5,
  NAME_FUZZY: 0.3,
};

export function isMapMethod(v: unknown): v is MapMethod {
  return (
    typeof v === "string" && (MAP_METHODS as readonly string[]).includes(v)
  );
}

/** The confidence for a method. Throws on an unknown one rather than defaulting. */
export function confidenceFor(method: MapMethod): number {
  const c = METHOD_CONFIDENCE[method];
  if (c === undefined) {
    // A default here would be a number nobody chose, attached to a mapping
    // nobody can explain, passing a floor nobody set.
    throw new Error(
      `no confidence declared for map method "${String(method)}"`,
    );
  }
  return c;
}

/**
 * The floor for using a mapping as a JOIN KEY.
 *
 * 0.5 admits an undated alias and refuses a name match. A name match is a
 * plausible row to store — it is how an operator finds the candidates — and an
 * implausible row to silently join a price series on.
 */
export const MIN_JOIN_CONFIDENCE = 0.5;

/* ─────────────────────────────────────────────────────────────────────────
   resolveListing — the point of the ticket
   ──────────────────────────────────────────────────────────────────────── */

/** One row of `lake_silver.source_instrument_map`. */
export interface SourceMapRow {
  source: SourceSystem;
  sourceKey: string;
  listingId: string;
  /** `null` = unknown start. Only legitimate for `SYMBOL_ALIAS_UNDATED`. */
  validFrom: string | null;
  /** `null` = still open. */
  validTo: string | null;
  method: MapMethod;
  confidence: number;
}

export interface ResolvedListing {
  listingId: string;
  method: MapMethod;
  confidence: number;
  /**
   * TRUE only when the matched row carried a real `valid_from`.
   *
   * FALSE means the row matches EVERY as-of by construction, so the answer is
   * "this is the security that wears this key, and we do not know since when".
   * That is the whole India seed: `InstrumentMapping` is overwritten on every
   * instrument-sync and NSE symbol-change history is not archived by this repo
   * (`report-registry.ts` has 26 families and none of them is one), so the
   * only honest claim is about today.
   *
   * It is a FIELD rather than something a caller decodes from `method`,
   * because "answered from a window it never had" and "answered from a real
   * window" are otherwise the same shape, and the first one is a guess that
   * reads exactly like knowledge. A point-in-time reader (a backtest, the
   * Track C linker) should refuse an undated answer for an as-of it cares
   * about; a search box is perfectly happy with one.
   */
  dated: boolean;
  /**
   * Two or more candidates were indistinguishable — same datedness, same
   * confidence — and named DIFFERENT listings.
   *
   * Surfaced rather than swallowed. A silent pick here is how one company's
   * bars end up under another's id, which is the failure this whole module
   * exists to prevent, rebuilt one layer up.
   */
  ambiguous: boolean;
}

/**
 * Which security did `source` mean by `sourceKey` on `asOf`?
 *
 * `null` when nothing matched — an ABSENCE, which is the shape every caller in
 * this repo already reports. Never a guess.
 *
 * Ordering of candidates, and each rung earns its place:
 *
 *   1. DATED before UNDATED. An undated alias matches every `as_of` by
 *      construction, so without this rung a `previousSymbols` row would
 *      outrank the real dated listing on its own trading days.
 *   2. Higher confidence.
 *   3. LATER `valid_from`. Two dated windows that both contain `as_of` overlap,
 *      which is a data defect; the more recent claim is the more specific one.
 *
 * `sourceKey` is TRIMMED and compared exactly — never upper-cased. US tickers
 * carry dashes where a symbol has a class (`BRK-A`, `SPG-P-J`) and Upstox keys
 * carry a pipe and an ISIN; case-folding a key whose case the vendor chose is a
 * way to merge two vendors' distinct keys into one.
 */
export function resolveListing(
  rows: readonly SourceMapRow[],
  query: {
    source: SourceSystem;
    sourceKey: string;
    asOf: string;
    /** Defaults to {@link MIN_JOIN_CONFIDENCE}. */
    minConfidence?: number;
  },
): ResolvedListing | null {
  assertIsoDate(query.asOf);
  const floor = query.minConfidence ?? MIN_JOIN_CONFIDENCE;
  const key = query.sourceKey.trim();
  if (key === "") return null;

  const candidates = rows.filter(
    (r) =>
      r.source === query.source &&
      r.sourceKey.trim() === key &&
      r.confidence >= floor &&
      windowContains(r.validFrom, r.validTo, query.asOf),
  );
  if (candidates.length === 0) return null;

  const rank = (r: SourceMapRow): [number, number, string] => [
    r.validFrom === null ? 0 : 1, // dated wins
    r.confidence,
    r.validFrom ?? "",
  ];
  const sorted = [...candidates].sort((a, b) => {
    const [ad, ac, af] = rank(a);
    const [bd, bc, bf] = rank(b);
    if (ad !== bd) return bd - ad;
    if (ac !== bc) return bc - ac;
    if (af !== bf) return af < bf ? 1 : -1;
    return 0;
  });

  const best = sorted[0]!;
  const [bd, bc, bf] = rank(best);
  const ambiguous = sorted.some((r) => {
    if (r.listingId === best.listingId) return false;
    const [d, c, f] = rank(r);
    return d === bd && c === bc && f === bf;
  });

  return {
    listingId: best.listingId,
    method: best.method,
    confidence: best.confidence,
    dated: best.validFrom !== null,
    ambiguous,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   SCD-2
   ──────────────────────────────────────────────────────────────────────── */

/** A row of `lake_silver.listing`. Identity plus enrichment. */
export interface ListingRow {
  listingId: string;
  market: Market;
  venue: string;
  symbol: string;
  isin: string | null;
  name: string | null;
  assetType: string | null;
  currency: string | null;
  status: ListingStatus;
  validFrom: string;
  validTo: string | null;
  /** Enrichment — carried, never versioned. See {@link IDENTITY_FIELDS}. */
  permaTicker: string | null;
  cik10: string | null;
  cusip: string | null;
  sector: string | null;
  industry: string | null;
  source: SourceSystem;
}

/**
 * What today's sources assert, plus the one window a source can date.
 *
 * `listedFrom` / `listedTo` date ONLY a listing's first appearance in the
 * table ({@link firstVersions}); a change observed later is dated by the diff.
 * REQUIRED, never optional: a shell that forgot to pass them would otherwise
 * fall back to the run day silently, which is the defect MONEY-1544 fixes.
 */
export type IncomingListing = Omit<ListingRow, "validFrom" | "validTo"> & {
  /** First day the source says the listing traded, INCLUSIVE. `null` = no source dates it. */
  listedFrom: string | null;
  /**
   * EXCLUSIVE end of the traded window — already converted by
   * {@link endDateToValidTo}. Set only for a DELISTED listing: an ACTIVE
   * listing's vendor end date is its latest price, not a delisting.
   */
  listedTo: string | null;
};

function toRow(
  inc: IncomingListing,
  validFrom: string,
  validTo: string | null,
): ListingRow {
  const { listedFrom: _f, listedTo: _t, ...row } = inc;
  return { ...row, validFrom, validTo };
}

/**
 * The version(s) a listing gets when it FIRST enters the table.
 *
 * FIRST VERSIONS AND LATER ONES ARE DATED DIFFERENTLY, and that is the rule:
 *
 *   - FIRST: from the SOURCE. `validFrom = listedFrom` — US: Tiingo's
 *     `listingStartDate`; India: the listing's first session in
 *     `price_bar_d1` (there is no inception date, so the archive's first
 *     evidence of trading is the lower bound). With no source date it is the
 *     day identity-sync first observed the listing — "known since we started
 *     looking", never a fabricated listing date.
 *   - LATER: a status, name or other identity change on a listing that already
 *     has a version is dated the day identity-sync OBSERVES it
 *     (`diffListings`), exactly as before.
 *
 * A listing first seen DELISTED, with a source window, gets TWO rows: ACTIVE
 * over `[listedFrom, listedTo)` and DELISTED from `listedTo`, open. So the
 * listing is tradable on its last session, not the day after, and there is
 * still exactly one open row per listing for the nightly diff to compare. First
 * seen DELISTED with NO window, it is one DELISTED row from the observed day:
 * we know it is delisted, not when it traded, and an ACTIVE row would invent
 * a window.
 */
export function firstVersions(
  inc: IncomingListing,
  observedDay: string,
): ListingRow[] {
  assertIsoDate(observedDay);
  const { listedFrom, listedTo } = inc;
  if (listedFrom !== null) assertIsoDate(listedFrom);
  if (listedTo !== null) assertIsoDate(listedTo);

  if (inc.status === "DELISTED") {
    if (listedFrom === null || listedTo === null || listedTo <= listedFrom) {
      return [toRow(inc, observedDay, null)];
    }
    return [
      { ...toRow(inc, listedFrom, listedTo), status: "ACTIVE" },
      toRow(inc, listedTo, null),
    ];
  }
  return [toRow(inc, listedFrom ?? observedDay, null)];
}

/**
 * THE FIELDS THAT MAKE A NEW VERSION.
 *
 * A change to any of these closes the current row and opens a successor. A
 * change to anything else is enrichment and is written in place.
 *
 * The split is deliberate and it is the difference between a table that is
 * readable and one that is a churn log. `sector` is re-derived by a weekly
 * enrichment pass; versioning on it would open a row per symbol per correction
 * and bury the seven real renames of the year under thousands of them.
 * Enrichment carries no historical claim — nobody queries "what sector did we
 * think this was in March" — so nothing is lost by overwriting it.
 *
 * `isin` IS here: for an Indian security the ISIN is the durable identity, and
 * an ISIN changing under a stable symbol means the symbol has been REUSED,
 * which is the whole DOW problem wearing a rupee sign.
 */
export const IDENTITY_FIELDS = [
  "symbol",
  "venue",
  "market",
  "isin",
  "name",
  "assetType",
  "currency",
  "status",
] as const satisfies readonly (keyof IncomingListing)[];
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** Close an open row: set `valid_to`. Never touches anything else. */
export interface CloseOp {
  listingId: string;
  /** The row being closed, identified by its own start — two versions of one
   *  listing differ only by window, so `listing_id` alone does not address a row. */
  validFrom: string;
  validTo: string;
  reason: string;
  /** Where `validTo` came from — see {@link changeDate}. */
  datedBy: ChangeDating;
}

/**
 * Why a change is dated the OBSERVED day although the source named an end —
 * each a reason the source's date could not be used as-is.
 */
export const DATING_FALLBACKS = [
  "NO_SOURCE_END",
  "OTHER_FIELDS_CHANGED",
  "NOT_AFTER_OPEN_VERSION",
  "AFTER_OBSERVED_DAY",
] as const;
export type DatingFallback = (typeof DATING_FALLBACKS)[number];
/** `OBSERVED` = not a delisting, so no source dates it; not a fallback. */
export type ChangeDating = "SOURCE_END" | "OBSERVED" | DatingFallback;

/**
 * The day a change on an EXISTING listing takes effect — MONEY-1602.
 *
 * A DELISTING whose source names the end (Tiingo's `listingEndDate`, India's
 * last bar once the archive is current — both already `end+1`, EXCLUSIVE, in
 * `listedTo`) is dated from it, so the listing is tradable through its last
 * session and not until the day identity-sync happened to run. Everything else
 * is dated the observed day, as before. The source date is used only when it
 * is SANE:
 *
 *   OTHER_FIELDS_CHANGED    the source dates the delisting, not a rename that
 *                           arrived with it — so the whole change waits for
 *                           the day it was seen.
 *   NOT_AFTER_OPEN_VERSION  `end+1 <= valid_from` of the open version would
 *                           close it before (or as) it opens: a zero-length or
 *                           negative version, SCD order broken.
 *   AFTER_OBSERVED_DAY      a delisting dated after the day we saw it is a
 *                           claim about the future.
 */
export function changeDate(
  cur: ListingRow,
  inc: IncomingListing,
  changed: readonly IdentityField[],
  today: string,
): { on: string; datedBy: ChangeDating } {
  const fallback = (datedBy: ChangeDating) => ({ on: today, datedBy });
  // Not a delisting at all: nothing in the source dates it.
  if (!changed.includes("status") || inc.status !== "DELISTED")
    return fallback("OBSERVED");
  if (inc.listedTo === null) return fallback("NO_SOURCE_END");
  assertIsoDate(inc.listedTo);
  if (changed.some((f) => f !== "status"))
    return fallback("OTHER_FIELDS_CHANGED");
  if (inc.listedTo <= cur.validFrom) return fallback("NOT_AFTER_OPEN_VERSION");
  if (inc.listedTo > today) return fallback("AFTER_OBSERVED_DAY");
  return { on: inc.listedTo, datedBy: "SOURCE_END" };
}

/** Overwrite enrichment on the currently-open row. */
export interface EnrichOp {
  listingId: string;
  validFrom: string;
  fields: Partial<
    Pick<ListingRow, "permaTicker" | "cik10" | "cusip" | "sector" | "industry">
  >;
}

export interface ListingDiff {
  close: CloseOp[];
  open: ListingRow[];
  enrich: EnrichOp[];
  unchanged: number;
}

function identityDiffers(a: IncomingListing, b: ListingRow): IdentityField[] {
  return IDENTITY_FIELDS.filter((f) => a[f] !== b[f]);
}

export class IdentityEnrichError extends Error {
  constructor(field: string) {
    super(
      `"${field}" is an identity field and must not be written in place — ` +
        "an in-place identity edit rewrites history so that the previous value " +
        "never existed, which is the one thing SCD-2 is for",
    );
    this.name = "IdentityEnrichError";
  }
}

/**
 * Refuse an enrich op that touches an identity field.
 *
 * A guard rather than a convention: the whole point of this ticket is that an
 * update-in-place cannot happen, and "we agreed not to" is not a mechanism.
 */
export function assertEnrichIsSafe(op: EnrichOp): void {
  for (const f of Object.keys(op.fields)) {
    if ((IDENTITY_FIELDS as readonly string[]).includes(f)) {
      throw new IdentityEnrichError(f);
    }
  }
}

/**
 * Diff today's sources against the open rows, SCD-2 style.
 *
 * ## ABSENCE IS NOT A DELISTING
 *
 * A listing present in `current` and missing from `incoming` is left ALONE. It
 * is closed only when a source positively says `status: "DELISTED"`.
 *
 * This is the `listFiles` rule one layer up: that function fails open to `[]`,
 * so a credentials blip or a paging bug produces an empty answer that looks
 * exactly like an empty market. Closing on absence would let one bad fetch
 * retire the entire universe, and the repair is not a re-run — the rows are
 * already versioned shut, with a `valid_to` that asserts a delisting that never
 * happened. The cost of the other error is a stale ACTIVE row, which the next
 * good run corrects.
 *
 * `today` is passed, never read from a clock: a job that runs at 23:59 IST and
 * finishes at 00:01 would otherwise close a row on one day and open its
 * successor on the next, leaving a one-day hole where the security belongs to
 * nobody.
 */
export function diffListings(args: {
  current: readonly ListingRow[];
  incoming: readonly IncomingListing[];
  today: string;
}): ListingDiff {
  assertIsoDate(args.today);
  const { today } = args;

  const open = new Map<string, ListingRow>();
  for (const row of args.current) {
    if (row.validTo !== null) continue; // history, not the current version
    const prev = open.get(row.listingId);
    // Two open rows for one listing is a defect; the later start is the live one.
    if (!prev || row.validFrom > prev.validFrom) open.set(row.listingId, row);
  }

  const diff: ListingDiff = { close: [], open: [], enrich: [], unchanged: 0 };

  for (const inc of args.incoming) {
    const cur = open.get(inc.listingId);

    if (!cur) {
      diff.open.push(...firstVersions(inc, today));
      continue;
    }

    const changed = identityDiffers(inc, cur);
    if (changed.length > 0) {
      // CLOSE then OPEN — never a mutation of `cur`. They MEET at `on`.
      const { on, datedBy } = changeDate(cur, inc, changed, today);
      diff.close.push({
        listingId: cur.listingId,
        validFrom: cur.validFrom,
        validTo: on,
        reason: `identity changed: ${changed.join(", ")}`,
        datedBy,
      });
      diff.open.push(toRow(inc, on, null));
      continue;
    }

    const fields: EnrichOp["fields"] = {};
    if (inc.permaTicker !== cur.permaTicker)
      fields.permaTicker = inc.permaTicker;
    if (inc.cik10 !== cur.cik10) fields.cik10 = inc.cik10;
    if (inc.cusip !== cur.cusip) fields.cusip = inc.cusip;
    if (inc.sector !== cur.sector) fields.sector = inc.sector;
    if (inc.industry !== cur.industry) fields.industry = inc.industry;

    if (Object.keys(fields).length > 0) {
      const op: EnrichOp = {
        listingId: cur.listingId,
        validFrom: cur.validFrom,
        fields,
      };
      assertEnrichIsSafe(op);
      diff.enrich.push(op);
    } else {
      diff.unchanged++;
    }
  }

  return diff;
}

/* ─────────────────────────────────────────────────────────────────────────
   Rebase — re-date first versions written before the source dates existed
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Replace ONE stored row — a listing's FIRST version — with the rows
 * {@link firstVersions} gives it. `RESTAMP` rewrites it unchanged but for its
 * parser version: identity/2 looked at it and there is nothing to re-date.
 */
export interface RebaseOp {
  kind: "REDATE" | "RESTAMP";
  listingId: string;
  /** The stored row, addressed by its own start AND end — the writer deletes it
   *  only if it still has both, so a row changed since the read is left alone. */
  replaces: ListingRow;
  rows: ListingRow[];
}

export interface RebasePlan {
  ops: RebaseOp[];
  /** First version already starts where identity/2 would start it. */
  unchanged: number;
  /**
   * Named and left alone: re-dating would cross a boundary somebody observed
   * (the source's start is not before the first version's end), or the listing
   * is in the two-open-rows defect state.
   */
  cannotRedate: string[];
  /** In the table, absent from every source today — nothing to date them from. */
  notInSource: number;
}

/**
 * Plan the re-dating of every listing's FIRST version — MONEY-1544/1602.
 *
 * A first version's START is never a change somebody observed: nothing comes
 * before it, so it is the day the listing was first SEEN. identity/1 made that
 * the run day (2026-09-22 on prod, all 98,249); identity/2 makes it the
 * source's date ({@link firstVersions}). So the start may always move to the
 * source date — including on a listing that has versions after it, provided
 * the source date is before the first version's END. The end, and every row
 * after it, is an observed boundary and is never touched.
 *
 * The replacement keeps the STORED identity and takes only the dates from
 * today's source, with ONE exception: a first version that is DELISTED while
 * the source says ACTIVE. A first version DELISTED carries no window — it was
 * first seen already delisted — so it is no evidence the listing ever stopped
 * trading, and the source says it trades now (GAB:NYSE:1987-11-05 on prod:
 * DELISTED in identity/1's snapshot, ACTIVE since 1987 per Tiingo today). It is
 * a seed glitch, not a delisting we observed, so it is re-dated ACTIVE from the
 * source's start, rather than left to flip ACTIVE on the next night. ONLY a
 * SEED row (`SEED_PARSER_VERSION`): an identity/2 first version that is
 * DELISTED was written from a source that said so, and a source that says
 * ACTIVE today is a RE-listing, which the nightly dates the day it is seen —
 * rewriting it ACTIVE would erase the delisted period.
 *
 * `RESTAMP`: a first version identity/2 would not move — or cannot, because
 * no source carries the listing today — still stamped by an older parser, is
 * rewritten with the current stamp. That stamp is how a
 * reader (`lake.py` `universe()`) knows the table has been re-dated at all,
 * and a partially re-dated table must not be read as a dated one.
 *
 * IDEMPOTENT: once applied, every first version starts where identity/2 would
 * start it and carries identity/2's stamp, so a second plan is empty.
 */
export function planRebase(args: {
  current: readonly (ListingRow & { parserVersion?: string })[];
  incoming: readonly IncomingListing[];
}): RebasePlan {
  const stored = new Map<string, (ListingRow & { parserVersion?: string })[]>();
  for (const r of args.current) {
    const rows = stored.get(r.listingId) ?? [];
    rows.push(r);
    stored.set(r.listingId, rows);
  }
  const source = new Map(args.incoming.map((i) => [i.listingId, i]));

  const plan: RebasePlan = {
    ops: [],
    unchanged: 0,
    cannotRedate: [],
    notInSource: 0,
  };
  const stripped = ({
    parserVersion: _p,
    ...row
  }: ListingRow & { parserVersion?: string }): ListingRow => row;
  const stale = (v: string | undefined) =>
    v !== undefined && v !== IDENTITY_PARSER_VERSION;
  const restamp = (listingId: string, first: ListingRow) =>
    plan.ops.push({
      kind: "RESTAMP",
      listingId,
      replaces: first,
      rows: [first],
    });

  for (const [listingId, rows] of stored) {
    if (rows.filter((r) => r.validTo === null).length > 1) {
      plan.cannotRedate.push(listingId);
      continue;
    }
    const first = rows.reduce((a, b) => (b.validFrom < a.validFrom ? b : a));
    const inc = source.get(listingId);
    if (!inc) {
      // No source dates it: its start stays the day it was seen, which is
      // identity/2's own answer — so it is re-stamped, or a listing that left
      // every source would hold its market's floor at the seed day for ever.
      plan.notInSource++;
      if (stale(first.parserVersion)) restamp(listingId, stripped(first));
      continue;
    }
    const {
      validFrom: observedDay,
      validTo: end,
      parserVersion,
      ...identity
    } = first;
    const glitch =
      first.parserVersion === SEED_PARSER_VERSION &&
      first.status === "DELISTED" &&
      inc.status === "ACTIVE";
    const want = firstVersions(
      {
        ...identity,
        status: glitch ? "ACTIVE" : first.status,
        listedFrom: inc.listedFrom,
        listedTo: inc.listedTo,
      },
      observedDay,
    );
    const last = want[want.length - 1]!;
    // A closed first version keeps its END: what follows it was observed.
    want[want.length - 1] = { ...last, validTo: end };

    if (
      want.length === 1 &&
      want[0]!.validFrom === first.validFrom &&
      want[0]!.status === first.status
    ) {
      if (stale(parserVersion)) restamp(listingId, stripped(first));
      else plan.unchanged++;
      continue;
    }
    if (end !== null && last.validFrom >= end) {
      plan.cannotRedate.push(listingId);
      continue;
    }
    plan.ops.push({
      kind: "REDATE",
      listingId,
      replaces: stripped(first),
      rows: want,
    });
  }
  return plan;
}

/* ─────────────────────────────────────────────────────────────────────────
   India's INACTIVE instruments — MONEY-1602
   ──────────────────────────────────────────────────────────────────────── */

/** A listing's span in `price_bar_d1`, INCLUSIVE at both ends. */
export interface BarWindow {
  first: string;
  last: string;
}

/**
 * Per venue: the newest session `price_bar_d1` holds, and how many of its bar
 * ids are NOT filed under the one spelling identity-sync joins on (the
 * pre-MONEY-1522 `{symbol}:{exchange}`, i.e. `in-bhavcopy-v1` — measured
 * 2026-09-23 the two tests agree id for id).
 */
export interface ArchiveHead {
  newest: string;
  staleIds: number;
}

export function archiveHeads(
  bars: readonly { listingId: string; venue: string; last: string }[],
  joinable: ReadonlySet<string>,
): Map<string, ArchiveHead> {
  const heads = new Map<string, ArchiveHead>();
  for (const b of bars) {
    const h = heads.get(b.venue) ?? { newest: b.last, staleIds: 0 };
    if (b.last > h.newest) h.newest = b.last;
    if (!joinable.has(b.listingId)) h.staleIds++;
    heads.set(b.venue, h);
  }
  return heads;
}

/**
 * Is the venue's bar archive whole under the ids identity joins on?
 *
 * EVERY bar, not the newest one. The rewrite is not chronological by contract:
 * a catch-up replay of the current month, a replay resumed from a later
 * `--from`, or the gap between `replaceMonth`'s DELETE and its LOAD all put
 * the newest session on the new spelling while years in the middle are still
 * on the old one. A newest-only test admits a listing that traded 2000-2015 as
 * DELISTED in 2009 — and that window is permanent, because a later change is
 * dated the day it is observed.
 */
export function archiveIsCurrent(
  head: ArchiveHead | undefined,
  today: string,
): boolean {
  return (
    head !== undefined &&
    head.staleIds === 0 &&
    head.newest >= addDays(today, -ARCHIVE_MAX_LAG_DAYS)
  );
}

/**
 * How far behind TODAY a venue's newest session may be, in calendar days.
 *
 * `replaceMonth` deletes a month and then loads it, not atomically. A load that
 * fails on the newest month leaves every remaining bar on the new spelling —
 * so the spelling test reads CURRENT — with the newest session weeks old, and
 * every instrument that printed since would look like it stopped. The newest
 * session must therefore be recent as well. 10 days is the longest exchange
 * holiday run plus a weekend (about 5 days) with margin; a lost month is 28+.
 */
export const ARCHIVE_MAX_LAG_DAYS = 10;

/**
 * How long an instrument the master no longer lists may go without a print
 * and still count as TRADING, in calendar days, before its last bar ends it.
 *
 * The two errors are not symmetric. Too SHORT and an illiquid instrument is
 * closed on a quiet stretch and reopened on its next print — two permanent
 * boundaries per stretch, nightly churn (NSE InvITs print on 17-51 of the
 * last 60 sessions; NDRINVIT's longest quiet gap in two years is 83 days,
 * CUBEINVIT's 93). Too LONG and a genuinely delisted instrument stays ACTIVE
 * until the lookback passes — and is then closed at its EXACT last bar, because
 * `changeDate` dates a delisting from the source's end. One error is
 * permanent, the other corrects itself, so the lookback sits at the tail of
 * LISTED instruments' quiet gaps. Measured on prod 2026-09-23 over two years:
 * at 365 days, 3 of 3,518 active NSE listings (0.09%) and 35 of 5,489 active
 * BSE equities (0.64%) ever went quiet for longer; at 90 days it was 17 and
 * 381; at 30, 47 and 727. The cost at 365: 169 NSE and 1,012 BSE ids that
 * stopped within the last year stay ACTIVE until their year is up.
 */
export const STILL_TRADING_DAYS = 365;

export const INACTIVE_REFUSALS = [
  "ARCHIVE_NOT_CURRENT",
  "NO_BARS",
  "OVERLAPS_ACTIVE",
  "OVERLAPS_SIBLING",
] as const;
export type InactiveRefusal = (typeof INACTIVE_REFUSALS)[number];

export type InactiveVerdict =
  | {
      admit: true;
      status: ListingStatus;
      listedFrom: string;
      listedTo: string | null;
    }
  | { admit: false; reason: InactiveRefusal };

/**
 * An India instrument `InstrumentMapping` no longer lists — is it a listing,
 * and over what window?
 *
 * India's master is current-only, so an Indian company that stopped trading
 * would otherwise be in no universe at all. Its bars are the only record of
 * when it traded, so they decide:
 *
 *   ARCHIVE_NOT_CURRENT  any bar of the venue is still on the old spelling —
 *                        the MONEY-1522 bar rewrite is still running
 *                        ({@link archiveIsCurrent}). A first or last bar read
 *                        now may be the rewrite's frontier, not the listing's,
 *                        and a window written from it is frozen for good. So
 *                        nothing is admitted until the venue is whole.
 *   NO_BARS              no evidence it ever traded. Counted, never a listing.
 *   OVERLAPS_ACTIVE      an ACTIVE instrument with the same ISIN on the same
 *                        venue traded on the same days: one security, two ids,
 *                        and admitting it would count it twice on those days.
 *   OVERLAPS_SIBLING     the same, against an instrument the master no longer
 *                        lists that was admitted first ({@link
 *                        inactivePrecedence}).
 *                        A rename is NOT this — its old symbol's bars end the
 *                        day before the new one's start (all 9 measured on
 *                        prod), so it is admitted and carries the pre-rename
 *                        era, under the id its bars actually sit on.
 *
 * Admitted: ACTIVE from the first bar; DELISTED from the day after the last —
 * unless the last bar is within {@link STILL_TRADING_DAYS} of the venue's
 * newest session, in which case it is still trading (the 21 NSE InvITs and
 * REITs among them) and stays ACTIVE. A listing already open is never closed
 * by a quiet night, only by a year without a print.
 */
export function classifyInactive(args: {
  bars: BarWindow | null;
  head: ArchiveHead | undefined;
  today: string;
  activeSameIsin: readonly BarWindow[];
  /** Windows of instruments ADMITTED before this one with the same ISIN. */
  siblingSameIsin: readonly BarWindow[];
}): InactiveVerdict {
  const { bars, head } = args;
  if (!head || !archiveIsCurrent(head, args.today))
    return { admit: false, reason: "ARCHIVE_NOT_CURRENT" };
  if (!bars) return { admit: false, reason: "NO_BARS" };
  assertIsoDate(bars.first);
  assertIsoDate(bars.last);
  const overlaps = (ws: readonly BarWindow[]) =>
    ws.some((a) => a.first <= bars.last && bars.first <= a.last);
  if (overlaps(args.activeSameIsin))
    return { admit: false, reason: "OVERLAPS_ACTIVE" };
  if (overlaps(args.siblingSameIsin))
    return { admit: false, reason: "OVERLAPS_SIBLING" };
  return bars.last >= addDays(head.newest, -STILL_TRADING_DAYS)
    ? { admit: true, status: "ACTIVE", listedFrom: bars.first, listedTo: null }
    : {
        admit: true,
        status: "DELISTED",
        listedFrom: bars.first,
        listedTo: nextDay(bars.last),
      };
}

/**
 * The order in which instruments the master no longer lists are admitted, so
 * that of two with the same ISIN trading on the same days the WINNER is the
 * same every night: more bars first, then the listing id. The loser is refused
 * `OVERLAPS_SIBLING`, by name. On prod: 15 BSE pairs, all debt or sovereign
 * gold bonds filed under two symbols (`SGBOCT25` / `SGBOCT25A`).
 */
export function inactivePrecedence(
  a: { listingId: string; bars: number },
  b: { listingId: string; bars: number },
): number {
  if (a.bars !== b.bars) return b.bars - a.bars;
  return a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0;
}

/* ─────────────────────────────────────────────────────────────────────────
   symbol_history
   ──────────────────────────────────────────────────────────────────────── */

export interface SymbolHistoryRow {
  listingId: string;
  symbol: string;
  venue: string;
  /** `null` on an UNDATED alias — see the file header and `MAP_METHODS`. */
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Which listing traded as `symbol` on `venue` at `asOf`?
 *
 * Same ordering rule as `resolveListing`: a dated row beats an undated alias,
 * because an undated alias matches every date by construction.
 */
export function resolveSymbol(
  rows: readonly SymbolHistoryRow[],
  query: { symbol: string; venue: string; asOf: string },
): { listingId: string; dated: boolean } | null {
  assertIsoDate(query.asOf);
  const sym = query.symbol.trim();
  const venue = query.venue.trim();
  const hits = rows.filter(
    (r) =>
      r.symbol.trim() === sym &&
      r.venue.trim() === venue &&
      windowContains(r.validFrom, r.validTo, query.asOf),
  );
  if (hits.length === 0) return null;

  const dated = hits.filter((r) => r.validFrom !== null);
  const pool = dated.length > 0 ? dated : hits;
  const best = pool.reduce((a, b) =>
    (b.validFrom ?? "") > (a.validFrom ?? "") ? b : a,
  );
  return { listingId: best.listingId, dated: best.validFrom !== null };
}
