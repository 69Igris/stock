/* =====================================================================
   Tiingo US master — the ONE-ROW-PER-TICKER collapse  (MONEY-980)
   ---------------------------------------------------------------------
   Pure. No Prisma, no network, no clock.

   ## THIS FILE NO LONGER WRITES ANYTHING (MONEY-980 TASK B1)

   It used to back `TiingoInstrumentProvider`, which rode
   `syncInstruments()` and wrote the US universe into
   `instrument_mappings`. That provider is GONE — deleted, along with
   `tiingo-instruments.ts` — and US securities live in `us_instruments`,
   written by `us-instrument-sync.ts`. The audit behind the move is in
   that file's header and in the `UsInstrument` model's own comments; the
   one-line version is that `deactivateStaleInstruments`'s scope is
   `exchangeFilter?.length ? {...} : {}`, so one forgotten argument
   retired the other market's whole universe, and two collections make
   that unreachable rather than merely unlikely.

   ## What survives, and why it is still the RIGHT shape for its callers

   `selectPrimaryListings` collapses the master to exactly one listing
   per TICKER. That is now used by the price-side jobs —
   `scripts/jobs/tiingo-us-backfill.ts` and
   `scripts/jobs/tiingo-us-corp-actions-backfill.ts` — and for them the
   collapse is not a compromise, it is the correct scope:
   `/tiingo/daily/<ticker>/prices` takes no venue qualifier and serves
   only the CURRENT occupant of a recycled ticker, so one request per
   ticker IS the fetchable universe. Asking twice for `DOW` returns Dow
   Inc. both times.

   The INSTRUMENT side needs the opposite and gets it from
   `us-instrument-sync-logic.ts`: one row per LISTING ID, keeping the
   delisted and recycled tail that `@@unique([yahooSymbol])` could never
   hold. The two selections share `beatsListing` — exported below — so
   the tie-break order cannot drift between them.

   ## The constraint this collapse was written for

   `InstrumentMapping` carries TWO unique keys:

       @@unique([symbol, exchange])
       @@unique([yahooSymbol])

   and a US Yahoo symbol has NO SUFFIX — `AAPL`, not `AAPL.NS`. So for
   the US universe the second key degenerated to "one row per TICKER,
   globally", strictly tighter than the first.

   ## Measurements, re-taken against the live master 2026-08-28

   The numbers this header used to carry were from the equity-only scope
   (24,328 rows) and are stale now that mutual funds are in scope:

     108,489 rows total
      74,217 in the US core scope (USD + 8 venues + Stock|ETF|Mutual Fund)
      72,685 distinct tickers   <- what `selectPrimaryListings` emits
      41,371 active / 31,314 delisted (of the emitted listings)
       1,461 tickers appear more than once, over 2,993 rows
         330 of those repeat ACROSS exchanges (123 with overlapping
             windows, i.e. a real dual listing; 207 sequential)
       1,131 repeat on ONE venue — genuine ticker recycling

   `permaTicker` — Tiingo's own stable security id — is not obtainable
   for the securities that need it (`DOW` and `BRKL` both return zero
   corporate-action rows), so it cannot replace this. The master's
   columns are exactly `ticker,exchange,assetType,priceCurrency,
   startDate,endDate`: no security id, no status column, AND NO NAME.
   ===================================================================== */

import {
  buildListingId,
  deriveListingStatus,
  isUsCoreSecurity,
  maxEndDate,
  type TiingoMasterRow,
} from "../tiingo/tiingo-logic";
import { US_EXCHANGES, type RawInstrument } from "./types";

/**
 * Venue preference when ONE ticker lists on SEVERAL exchanges (330 of them).
 *
 * Ordered by how likely the venue is to be a security's PRIMARY listing:
 * NASDAQ and NYSE first, then NYSE ARCA (where most US ETFs primary-list),
 * then the smaller boards, and BATS/NYSE NAT last — those are execution venues
 * that report a listing for securities primary-listed elsewhere.
 *
 * The choice is mostly cosmetic for PRICES: `/tiingo/daily/<ticker>/prices`
 * takes no exchange qualifier, so every candidate row would be filled from the
 * identical response. It is NOT cosmetic for the ROW, because `exchange` is
 * half of `@@unique([symbol, exchange])` — see `pickPrimary` on why this
 * ordering has to be total and deterministic.
 */
export const US_EXCHANGE_PREFERENCE: readonly string[] = [
  "NASDAQ",
  "NYSE",
  "NYSE ARCA",
  "NYSE MKT",
  "AMEX",
  "NYSE NAT",
  "BATS",
  // Last, and it never actually competes: NMFQS is the sole venue for mutual
  // funds, and no fund ticker appears on an equity board. Its position is
  // therefore arbitrary — but the ordering must stay TOTAL, so it is listed
  // rather than left to `preferenceRank`'s unknown-venue fallback.
  "NMFQS",
];

/**
 * The exchanges to hand `syncInstruments` as `options.exchanges`.
 *
 * NO LONGER PASSED TO `syncInstruments` BY ANY US JOB — the provider that
 * needed it is gone (see the header). It survives as the US venue LIST that
 * `scripts/jobs/tiingo-us-news-seed.ts` scopes its query by, and as the
 * documented reason the argument existed: `deactivateStaleInstruments` flips
 * every `isActive` row that is not in the current run's symbol@exchange set and
 * has not synced in 7 days, so running a US provider with no exchange filter
 * deactivated the entire ~20,804-row Indian universe in one pass, with no error
 * and a "COMPLETED" sync log. That is the failure two collections now make
 * structurally impossible rather than merely guarded.
 */
export const TIINGO_SYNC_EXCHANGES: readonly string[] = [
  ...US_EXCHANGE_PREFERENCE,
];

/**
 * Tiingo `assetType` -> `InstrumentMapping.instrumentType`.
 *
 * Exactly three values survive `isUsCoreSecurity` (`Stock`, `ETF`,
 * `Mutual Fund`), so this is a total function over the in-scope universe rather
 * than a lookup with a fallback. Anything else returning EQUITY would be a
 * guess, and the create path is the one place a guess is allowed — but there is
 * nothing to guess here, so it does not.
 *
 * `MF` and not `MUTUAL_FUND`: `us-eod-sync` selects on BOTH spellings because
 * the wider codebase uses both, but this writer emits one, and it is the one
 * `InstrumentMapping.instrumentType`'s own comment lists.
 */
export function usInstrumentTypeFor(
  assetType: string,
): "EQUITY" | "ETF" | "MF" {
  if (assetType === "ETF") return "ETF";
  if (assetType === "Mutual Fund") return "MF";
  return "EQUITY";
}

/** One occupancy window, resolved and ready to become a row. */
export interface TiingoListing {
  symbol: string;
  exchange: string;
  instrumentType: "EQUITY" | "ETF" | "MF";
  /** `{symbol}:{exchange}:{startDate}` — see `buildListingId`. */
  listingId: string;
  listingStatus: "ACTIVE" | "DELISTED";
  /** ISO `YYYY-MM-DD` as the master prints it; converted to Date on write. */
  listingStartDate: string | null;
  listingEndDate: string | null;
}

export interface TiingoListingStats {
  /** Rows in the master, before any filter. */
  fetched: number;
  /** Rows passing `isUsCoreSecurity`. */
  inScope: number;
  /**
   * Windows dropped because a BETTER window for the same ticker won on the
   * SAME exchange — i.e. ticker recycling. Measured 1,196 on 2026-08-28.
   */
  recycledDropped: number;
  /**
   * Windows dropped because the ticker also lists on a preferred venue.
   * Measured 336 on 2026-08-28.
   */
  crossVenueDropped: number;
  /**
   * In-scope rows whose exchange is missing from `US_EXCHANGES`, and therefore
   * would be handed a `.NS` Yahoo symbol. Structurally 0 today; see the guard
   * in `selectPrimaryListings` for why it is a counter and not a comment.
   */
  unsuffixableDropped: number;
  active: number;
  delisted: number;
  /** The reference date `deriveListingStatus` graded against. */
  fileMaxEndDate: string | null;
  /**
   * Symbols emitted more than once. MUST be empty — the grouping makes it
   * structurally impossible — and it is measured anyway, because "the Map key
   * guarantees it" stops being true the moment someone changes the key.
   */
  duplicateSymbols: string[];
}

export interface TiingoListingSelection {
  listings: TiingoListing[];
  stats: TiingoListingStats;
}

/** Position in `US_EXCHANGE_PREFERENCE`; unknown venues sort last. */
function preferenceRank(exchange: string): number {
  const i = US_EXCHANGE_PREFERENCE.indexOf(exchange);
  return i === -1 ? US_EXCHANGE_PREFERENCE.length : i;
}

/** Compare two ISO date strings that may be null; null sorts lowest. */
function cmpDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/**
 * Does candidate `a` beat incumbent `b` for the right to be THE row for this
 * ticker?
 *
 * The ordering is TOTAL and DETERMINISTIC, and both properties are
 * load-bearing rather than tidy:
 *
 *   - `exchange` is half of `@@unique([symbol, exchange])`. A comparator that
 *     can return "either" for a genuine tie resolves by whatever order the CSV
 *     happened to arrive in, so the winner can differ between two runs over
 *     the same data. That does not merely churn a column — it creates a SECOND
 *     ROW under a different key while the first stays behind as a stale
 *     duplicate, and the two then alternate nightly. The last rule below exists
 *     purely to close that, and it must never be removed as redundant.
 *   - Every field it reads comes from the master. Nothing here consults the
 *     clock or the database, so the same file always yields the same winner.
 *
 * Rules, in order:
 *   1. ACTIVE beats DELISTED. Tiingo serves only the CURRENT occupant of a
 *      recycled ticker (measured: asking for `DOW` over 1962-2026 returns bars
 *      from 2019-03-20, Dow Inc.), so the live window is the only one whose
 *      prices exist to fetch.
 *   2. The more primary-looking venue wins (`US_EXCHANGE_PREFERENCE`).
 *   3. The LATER listing start wins — the current occupant of the ticker.
 *   4. The LATER listing end wins.
 *   5. Exchange name ascending. Arbitrary, and deliberately so: its only job is
 *      to make step 4's ties impossible to resolve two different ways.
 *
 * EXPORTED (MONEY-980 / TASK B1) because `us-instrument-sync-logic.ts` needs the
 * SAME total order to break `listingId` collisions — the master carries 83
 * listingIds twice or more (measured 2026-08-28, 92 surplus rows), and
 * `UsInstrument.@@unique([listingId])` admits one of them. Re-deriving the
 * ordering there would be a second copy of a rule this file's header already
 * says must not exist in two places, and the two copies would drift the first
 * time either grows a tiebreak.
 */
export function beatsListing(
  a: TiingoMasterRow,
  b: TiingoMasterRow,
  refDate: string,
): boolean {
  const aActive = deriveListingStatus(a, refDate) === "ACTIVE";
  const bActive = deriveListingStatus(b, refDate) === "ACTIVE";
  if (aActive !== bActive) return aActive;

  const ra = preferenceRank(a.exchange);
  const rb = preferenceRank(b.exchange);
  if (ra !== rb) return ra < rb;

  const startCmp = cmpDate(a.startDate, b.startDate);
  if (startCmp !== 0) return startCmp > 0;

  const endCmp = cmpDate(a.endDate, b.endDate);
  if (endCmp !== 0) return endCmp > 0;

  return a.exchange < b.exchange;
}

/**
 * Collapse the master to ONE listing per ticker.
 *
 * ## Why the losers are dropped rather than stored
 *
 * Requirement, stated plainly: a delisted predecessor of a recycled ticker is
 * NOT created. `DOW` on NYSE is two companies — Dow Chemical (1972-06-01 to
 * 2017-08-31) and Dow Inc. (2019-03-20 onward) — identical in exchange,
 * assetType and currency, separable only by window. `@@unique([symbol,
 * exchange])` admits one of them.
 *
 * The tempting answer is "keep both, disambiguate later". There is nothing to
 * disambiguate WITH: Tiingo's price endpoint is keyed by bare ticker, its own
 * docs bound delisted coverage to "tickers that have NOT YET been recycled",
 * and the measurement agrees — a full-range request for `DOW` returns Dow Inc.
 * only. A Dow Chemical row could therefore never be filled. It would sit in
 * `{market:"US"}` counts as a permanent hole that no run can close, page
 * whoever watches coverage, and — worst — invite exactly the mis-attribution
 * `isRecycledResponse` was written to refuse, because the one response
 * available for that ticker is the successor's. A row we can never fill is
 * worse than no row.
 *
 * The same logic one level up settles the 928 cross-venue repeats: two rows for
 * one ticker would be filled from the IDENTICAL response, so the second is a
 * duplicate of the first that additionally cannot exist under
 * `@@unique([yahooSymbol])`.
 *
 * ## The status reference date comes from the IN-SCOPE rows
 *
 * `deriveListingStatus` grades `endDate` against the newest date present rather
 * than against today's clock, so a Monday run, a holiday, or a replay of
 * yesterday's archived file cannot mark the whole market delisted. The
 * reference is computed over the rows being graded, NOT over all 108,489: the
 * file also carries CNY, HKD and AUD listings on venues we do not ingest, and a
 * single mis-stamped future date on one of those would silently redefine
 * "active" for the entire US universe. A denominator and a numerator from
 * different populations is how MONEY-1093-class defects read as healthy.
 *
 * With no in-scope rows at all there is no reference and nothing to grade, so
 * the selection returns EMPTY rather than defaulting everything to DELISTED.
 * The caller treats an empty result as a failure, which is the honest reading
 * of a master that suddenly contains no US securities.
 */
export function selectPrimaryListings(
  rows: readonly TiingoMasterRow[],
): TiingoListingSelection {
  const stats: TiingoListingStats = {
    fetched: rows.length,
    inScope: 0,
    recycledDropped: 0,
    crossVenueDropped: 0,
    unsuffixableDropped: 0,
    active: 0,
    delisted: 0,
    fileMaxEndDate: null,
    duplicateSymbols: [],
  };

  const inScope = rows.filter(isUsCoreSecurity);
  stats.inScope = inScope.length;

  /**
   * A venue `US_EXCHANGES` does not know is one `buildYahooSymbolForInstrument`
   * would suffix `.NS` — a US security filed under an Indian Yahoo symbol,
   * which is both wrong and a live collision risk (`INFY` is an NYSE ADR AND an
   * NSE listing, so `INFY.NS` is already taken).
   *
   * `TIINGO_US_EXCHANGES` and `US_EXCHANGES` hold the same seven venues today
   * and answer DIFFERENT questions — "what does this integration ingest" versus
   * "which exchange strings mean a suffix-free Yahoo symbol" — so they are
   * deliberately two constants. This filter is what stops that from being a
   * comment: if either list moves without the other, the affected rows are
   * dropped and COUNTED instead of being written with the wrong symbol.
   */
  const suffixable = inScope.filter((r) => US_EXCHANGES.has(r.exchange));
  stats.unsuffixableDropped = inScope.length - suffixable.length;

  const refDate = maxEndDate(suffixable);
  stats.fileMaxEndDate = refDate;
  if (refDate === null || suffixable.length === 0) {
    return { listings: [], stats };
  }

  /** ticker -> winning row so far, plus how the losers were lost. */
  const winners = new Map<string, TiingoMasterRow>();
  for (const row of suffixable) {
    const held = winners.get(row.ticker);
    if (!held) {
      winners.set(row.ticker, row);
      continue;
    }
    const loser = beatsListing(row, held, refDate) ? held : row;
    if (loser === held) winners.set(row.ticker, row);
    // Attribute the drop to the reason it actually happened, comparing the
    // LOSER against the row that displaced it.
    const kept = winners.get(row.ticker)!;
    if (loser.exchange === kept.exchange) stats.recycledDropped++;
    else stats.crossVenueDropped++;
  }

  const listings: TiingoListing[] = [];
  for (const row of winners.values()) {
    const listingStatus = deriveListingStatus(row, refDate);
    if (listingStatus === "ACTIVE") stats.active++;
    else stats.delisted++;
    listings.push({
      symbol: row.ticker,
      exchange: row.exchange,
      instrumentType: usInstrumentTypeFor(row.assetType),
      listingId: buildListingId(row.ticker, row.exchange, row.startDate),
      listingStatus,
      listingStartDate: row.startDate,
      listingEndDate: row.endDate,
    });
  }

  // Measured, not argued. The Map key makes this structurally impossible; a
  // future change to the grouping key would make it possible again, silently,
  // and the first symptom would be a unique-constraint violation in production.
  const seen = new Set<string>();
  for (const l of listings) {
    if (seen.has(l.symbol)) stats.duplicateSymbols.push(l.symbol);
    seen.add(l.symbol);
  }

  return { listings, stats };
}

/**
 * A resolved listing in the orchestrator's raw shape.
 *
 * `name` is THE SYMBOL, because the master has no name column — the six fields
 * are `ticker,exchange,assetType,priceCurrency,startDate,endDate` and that is
 * all Tiingo publishes here.
 *
 * KEPT ONLY FOR THE BACKFILL SCRIPTS, which read `RawInstrument.symbol` and
 * ignore the rest. Nothing writes this to a database any more: the provider
 * that did is gone, and `UsInstrument.name` starts NULL and is filled by
 * `us-instrument-names.ts` from `/tiingo/daily/<ticker>` — null being a
 * distinction search can rank on, which `name = symbol` erased.
 */
export function toRawUsInstrument(listing: TiingoListing): RawInstrument {
  return {
    symbol: listing.symbol,
    exchange: listing.exchange,
    name: listing.symbol,
    instrumentType: listing.instrumentType,
  };
}

/**
 * The listing fields keyed by `symbol::exchange`, so the provider can recover a
 * listing from the `RawInstrument` the orchestrator hands back to `mapToUpsert`.
 *
 * `InstrumentProvider.mapToUpsert(raw)` receives ONLY a `RawInstrument`, and
 * `RawInstrument` has nowhere to carry `listingId`, `listingStatus` or the two
 * dates — it is an India-shaped record (ISIN, series, lotSize, strike, expiry).
 * Widening it would push US-only fields onto every Indian provider; this index
 * keeps the US fields on the US side of the seam.
 */
export function indexListings(
  listings: readonly TiingoListing[],
): Map<string, TiingoListing> {
  const out = new Map<string, TiingoListing>();
  for (const l of listings) out.set(`${l.symbol}::${l.exchange}`, l);
  return out;
}

/** Parse an ISO `YYYY-MM-DD` to a UTC Date, or undefined when unusable. */
export function isoToDate(iso: string | null): Date | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}
