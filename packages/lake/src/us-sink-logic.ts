/**
 * Pure decisions for the US replay — MONEY-1513 (B2-US).
 *
 * No GCS, no BigQuery, no Mongo, no clock, nothing from `@usemoney/core`. The
 * one rule shared with core, `latestOccupantOf`, is a deliberate TWIN of
 * `packages/core/src/market-data/databento/databento-symbology.ts`'s, held
 * together by `packages/core/__tests__/market-data/latest-occupant-agreement.test.ts`
 * (the `numeric()` / `istDateKey` arrangement). Everything is a
 * function of its arguments, so every trap below is assertable without
 * provisioning anything.
 *
 * `scripts/jobs/lake-replay-us.ts` is the I/O shell. It owns the reads —
 * `CandleRepository`'s two tiers (Mongo hot rows + the gzipped-JSONL cold
 * shards on GCS) and `UsFundNav` — and supplies the narrow inputs declared
 * here.
 *
 * ## WHY THIS IS NOT IN `price-bar-logic.ts`
 *
 * That module is SHARED by both markets: `toPriceBarRow`, `numeric`,
 * `priceBarPartitionKey` and `priceBarSourceHash` are called by the India
 * replay too. What lives here is US-ONLY — the listing gate, the fund-NAV row,
 * the D1 session-date rule — and putting it there would make an India change
 * and a US change touch one file for no shared behaviour. Same split, and the
 * same reasoning, as `india-sink-logic.ts`.
 *
 * ## `isSessionInPartition` AND `classifyPricedRow` ARE IMPORTED, NOT RESTATED
 *
 * They sit in `india-sink-logic.ts` because that job needed them first, and
 * both are MARKET-GENERIC: one is a string-prefix test against
 * `{MARKET}/{YYYY-MM}`, the other asks whether a bar has any price at all.
 * Copying them here would be a second spelling of two rules whose whole job is
 * to be the only spelling — `priceBarPartitionKey` already puts the market IN
 * the key precisely so one partition-key rule can serve both loaders.
 */

import {
  classifyPricedRow,
  decideMonth,
  isSessionInPartition,
  type MonthVerdict,
} from "./india-sink-logic";
import {
  PRICE_BAR_PARSER_VERSION,
  numeric,
  type RowProvenance,
} from "./price-bar-logic";

/** Re-exported so the shell imports ONE subpath rather than two in agreement. */
export type { RowProvenance };

/** The one market this replay writes. */
export const US_MARKET = "US" as const;

/**
 * The silver tables this replay writes.
 *
 * `price_bar_d1` is shared with the India replay — `market` is a COLUMN, never
 * a second dataset. `fund_nav_d1` is US-only and had NO writer at all before
 * this job (MONEY-1513): the table shipped with `002_silver_price_bars.sql` and
 * `fund_nav_d1` appeared in no source file outside a test asserting it is not
 * an India table.
 */
export const US_TABLES = ["price_bar_d1", "fund_nav_d1"] as const;
export type UsTable = (typeof US_TABLES)[number];

export function isUsTable(v: unknown): v is UsTable {
  return typeof v === "string" && (US_TABLES as readonly string[]).includes(v);
}

/**
 * ONE PARSER VERSION PER TABLE, for `india-sink-logic`'s reason: the version is
 * part of the ledger's five-part identity, so bumping it makes every partition
 * of THAT table re-loadable without deleting anything. A single job-wide
 * version would mean a fund-NAV mapper fix forces a re-load of ten years of
 * bars, which is the cost that makes people not bump it.
 *
 * `price_bar_d1` takes B2's own {@link PRICE_BAR_PARSER_VERSION} rather than a
 * new string. That constant was written FOR the US bar mapping — `toPriceBarRow`
 * is what it versions — and the India replay already stamps its own
 * `in-bhavcopy-v1` instead, so the two markets stay independently bumpable
 * without a third name for the US one.
 */
export const US_PARSER_VERSIONS: Readonly<Record<UsTable, string>> = {
  price_bar_d1: PRICE_BAR_PARSER_VERSION,
  fund_nav_d1: "us-fund-nav-v1",
};

/**
 * What `replaceMonth` must be told about this table, and BOTH halves are a
 * property of its DDL rather than a preference.
 *
 * `fund_nav_d1` partitions on `nav_date` and HAS NO `market` COLUMN — it keys
 * on `perma_ticker`, which is not derivable from the instrument master, so it
 * was given its own table rather than a nullable column in `price_bar_d1`.
 * Getting either half wrong is silent in a different direction:
 *
 *   market "US" on fund_nav_d1     the DELETE names a column that does not
 *                                  exist and the statement fails — loud, and
 *                                  the harmless one.
 *   market null on price_bar_d1    the DELETE drops the market predicate.
 *                                  CORRECTED after review: this does NOT reach
 *                                  India's rows — the statement also carries
 *                                  `AND source = @source`, India is
 *                                  `BHAVCOPY_HIST` and the US replay passes
 *                                  `TIINGO`, so no India row can match. What it
 *                                  DOES do is widen the delete across every
 *                                  other US source in the month and then
 *                                  replace only the one being loaded. Silent,
 *                                  and still the reason this is a function with
 *                                  a test rather than a ternary at the call
 *                                  site. Stated exactly: a reader who measures
 *                                  the dramatic version and finds it false will
 *                                  conclude the GUARD is unnecessary rather
 *                                  than the PROSE wrong.
 *   the wrong dateColumn           `session_date` on `fund_nav_d1` fails;
 *                                  `nav_date` on `price_bar_d1` fails. Loud.
 */
export function usDeleteScope(table: UsTable): {
  market: string | null;
  dateColumn: string;
} {
  return table === "fund_nav_d1"
    ? { market: null, dateColumn: "nav_date" }
    : { market: US_MARKET, dateColumn: "session_date" };
}

export function usParserVersion(table: UsTable): string {
  const v = US_PARSER_VERSIONS[table];
  if (!v) {
    // Unreachable through the typed API and reachable through a widened string.
    // An empty `parser_version` is an empty component of the ledger's identity,
    // which collapses distinct partitions onto one and reads as ALREADY LOADED.
    throw new Error(`usParserVersion: no parser version for table "${table}"`);
  }
  return v;
}

/* ─────────────────────────────────────────────────────────────────────────
   The D1 session date — the off-by-one that would shift every US bar
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The SESSION date a D1 bar describes, from its timestamp.
 *
 * ## `usMarketDateKey` IS THE WRONG FUNCTION HERE, and it is the obvious one
 *
 * `Candle.ts` is documented as "Bar OPEN, UTC. **For D1 this is UTC midnight of
 * the session**", and `UsFundNav.date` the same ("the session the NAV
 * describes, UTC midnight"). So the UTC calendar date of the timestamp IS the
 * session date, by construction.
 *
 * `usMarketDateKey` converts an instant to the ET calendar day. UTC midnight of
 * session D is 19:00 or 20:00 ET on D-1, so it answers `D-1` for every single
 * bar — a whole market silently shifted back one day, landing January 1st in
 * the previous month's partition and every bar on the wrong side of every
 * corporate action. It is the right function for a Databento intraday row
 * (a real instant during a session) and the wrong one for a D1 bar whose
 * timestamp is already a session key.
 *
 * `toISOString` and not `getUTCFullYear` piecing: both are UTC, but one of them
 * cannot be written with a local-time getter by accident.
 */
export function d1SessionDate(ts: Date): string {
  const ms = ts.getTime();
  if (!Number.isFinite(ms)) {
    // An Invalid Date renders as "Invalid Date" and `slice(0,10)` of it is
    // "Invalid Da" — a perfectly shaped string that is not a date, which BigQuery
    // would refuse for the whole month at `maxBadRecords: 0`, naming a row rather
    // than the source.
    throw new RangeError("d1SessionDate: timestamp is not a valid instant");
  }
  return ts.toISOString().slice(0, 10);
}

/* ─────────────────────────────────────────────────────────────────────────
   The listing gate — a ticker is not a security
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `resolveListingForDate`'s answer, declared STRUCTURALLY.
 *
 * `packages/lake` must not import `packages/core` (`databento-repo.ts:911`
 * states the rule from the other side), so the core type is not named here —
 * but it IS assignable to this one, so the shell passes the resolver's result
 * straight through and `yarn type-check` holds the two in agreement.
 */
export type ListingResolutionLike =
  | { ok: true; listing: { listingId: string }; multiVenue: boolean }
  | { ok: false; reason: string };

/**
 * HOW a bar's `listing_id` was decided. Stored in `resolution_method`.
 *
 * The first two mean "the bar carried its own id and the master agrees"; they
 * differ in whether the master had ONE window covering that session or several
 * venues of one security. Distinguishing them costs nothing and is the only
 * way a coverage report can tell a clean single-venue hit from a venue choice.
 *
 * `LATEST_OCCUPANT` (MONEY-1616) is a WEAKER claim and is named so a reader can
 * exclude it: several windows of a recycled ticker covered the session, and the
 * bar was admitted because its stored id is the ticker's current occupant —
 * see {@link classifyBarListing}.
 */
export const US_RESOLUTION_METHODS = [
  "VENDOR_LISTING_ID",
  "VENDOR_LISTING_ID_MULTIVENUE",
  "LATEST_OCCUPANT",
] as const;
export type UsResolutionMethod = (typeof US_RESOLUTION_METHODS)[number];

/**
 * Why a US row was refused. NAMED, never a boolean — a count without a reason
 * sends the next operator to read sixty years of shards.
 */
export const US_QUARANTINE_REASONS = [
  /** No master window covers this session. The master is short a row. */
  "LISTING_UNRESOLVED",
  /**
   * The ticker was recycled and the windows OVERLAP, so nothing in the data
   * says which occupant printed the bar. 2,196 US tickers repeat and 834
   * delisted rows share a ticker with a live one.
   */
  "LISTING_AMBIGUOUS",
  /**
   * The bar's STORED `listingId` is not the one the master resolves for that
   * session. A drift, and the one that must never be written: a bar filed under
   * the wrong occupant is indistinguishable from a correct one for ever after,
   * and it is exactly the DOW hazard (`DOW:NYSE` is Dow Chemical to 2017 and
   * Dow Inc. from 2019) the `listing_id` column exists to prevent.
   */
  "LISTING_MISMATCH",
  /** Every price on the row was non-finite. A bar with no prices is not a bar. */
  "NO_FINITE_PRICE",
  /** The NAV was non-finite. A fund row with no NAV carries nothing. */
  "NO_FINITE_NAV",
  /**
   * The row's own session date falls outside the partition being loaded.
   *
   * `replaceMonth` deletes ONE month before it loads, so a row landing in an
   * adjacent month is outside every later reload's predicate: it can never be
   * corrected, only accumulated. Reachable here through a cold shard —
   * `candles/US/D1/{symbol}/{year}` is keyed by YEAR, and a shard written with
   * a stray bar puts it in a month nothing is replacing.
   */
  "WRONG_MONTH",
] as const;
export type UsQuarantineReason = (typeof US_QUARANTINE_REASONS)[number];

export type ListingVerdict =
  | { ok: true; method: UsResolutionMethod }
  | { ok: false; reason: UsQuarantineReason };

/** A master window, declared structurally for `ListingResolutionLike`'s reason. */
export interface OccupancyWindowLike {
  listingId: string;
  listingStartDate: Date | null;
  listingEndDate: Date | null;
}

/**
 * The symbol's UNIQUE latest-ending window — its current occupant — or null.
 *
 * ## WHY "LATEST-ENDING" IS THE CURRENT OCCUPANT — MONEY-1616
 *
 * Tiingo dates a SECURITY's price history, not the time it has held a ticker.
 * Barrick's `B` row starts in 1985 (its history under ABX) and so overlaps
 * Barnes Group's `B` to 2025; the master holds 437 such overlapping pairs.
 * Tiingo also serves a ticker's CURRENT occupant only, so the one series the
 * store holds under `B` is Barrick's, and it is stamped with Barrick's id.
 * The occupant is the window that runs latest: measured 2026-09-24, 177,550
 * of the 196,569 AMBIGUOUS rows carry it, and 7 of 7 price-level spot checks
 * confirmed the label (B 2024 at $17.42 on 18.6M shares is Barrick).
 *
 * A TIE IS NULL, never a pick. Two windows ending together (two ACTIVE rows,
 * or WNS's two rows both ending 2025-10-16) say nothing about which one the
 * series belongs to. An open end is later than any date. A single window is
 * null too: one window is never ambiguous, so there is no question to answer.
 * An Invalid Date end is null rather than skipped — skipping it would make the
 * window beside it "unique" on no evidence.
 *
 * DELIBERATELY A SECOND COPY (MONEY-1617): the candle writer's clip reads the
 * twin in `@usemoney/core`'s `databento-symbology.ts`, which this package must
 * not import. `latest-occupant-agreement.test.ts` in core runs both over one
 * table of cases, so the writer and this gate cannot disagree about who owns a
 * shared session.
 */
export function latestOccupantOf(
  windows: readonly OccupancyWindowLike[],
): OccupancyWindowLike | null {
  if (windows.length < 2) return null;
  let best: OccupancyWindowLike | null = null;
  let bestEnd = -Infinity;
  let tie = false;
  for (const w of windows) {
    const end =
      w.listingEndDate === null ? Infinity : w.listingEndDate.getTime();
    if (Number.isNaN(end)) return null;
    if (end > bestEnd) {
      best = w;
      bestEnd = end;
      tie = false;
    } else if (end === bestEnd) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/**
 * Has the store stitched a PREDECESSOR's history into the occupant's series?
 *
 * The signal is a bar carrying the occupant's id on a session BEFORE its own
 * window starts. Tiingo sometimes prepends the ticker's previous occupant to
 * the current series (WUSA, DEFI, MJUS, HZON-WS, PACI-U, ALLG-WS measured
 * 2026-09-24), and a series that is visibly stitched before the window may be
 * stitched inside the overlap too — which is exactly the part no bar can show.
 * So one stitched bar withdraws the whole symbol from `LATEST_OCCUPANT`.
 *
 * BEFORE the start only, never after the end. An ACTIVE window ends on the
 * master's last price date, so a bar newer than the last master sync sits
 * past it: that is master lag (it quarantines as UNRESOLVED already), and
 * counting it here would withdraw every live ticker for a day's staleness.
 *
 * The caller must hand over the symbol's WHOLE stored series, not the run
 * window's slice: stitched bars predate the overlap by construction, so a run
 * sharded by date would never see them from the shard that admits.
 *
 * The date key is the stored start's UTC calendar date, the same parts
 * `windowCoversDate` reads, and a D1 `sessionDate` is on that calendar.
 *
 * ## THE SECOND SIGNAL: A PRICE BREAK AT ANOTHER WINDOW'S BOUNDARY
 *
 * Stitching INSIDE the overlap leaves no bar outside the window, but it does
 * leave a seam: the series switches security on the day another window starts
 * or ends. So a split-adjusted close-to-close move above
 * {@link BOUNDARY_BREAK_LOG_RETURN} between ADJACENT stored sessions, on the
 * first session at another window's start or after its end, also withdraws
 * the symbol. Measured 2026-09-24 over the 288 admitted symbols: 12 break
 * (2,698 rows) against ~1 expected at random sessions of single-window
 * tickers. Five are one-day handovers whose overlap bar IS the predecessor's —
 * BTDR 2023-04-13 at $10 is Blue Safari's SPAC price, not Bitdeer's — and the
 * rest are same-company listing events (uplistings, a foreign line becoming
 * primary). Those are withheld too: a seam cannot say which kind it is, and a
 * row left in quarantine is recoverable where a row filed under the wrong
 * company is not.
 */
export function hasStitchedHistory(args: {
  occupant: OccupancyWindowLike;
  /** Every window of the symbol — the boundaries a seam would sit on. */
  windows: readonly OccupancyWindowLike[];
  bars: Iterable<{
    listingId: string;
    sessionDate: string;
    close: number | null;
    splitFactor?: number | null;
  }>;
}): boolean {
  const key = (d: Date | null): string | null =>
    d === null ? null : d.toISOString().slice(0, 10);
  const startKey = key(args.occupant.listingStartDate);
  const series: { sessionDate: string; close: number; sf: number }[] = [];
  for (const b of args.bars) {
    if (b.listingId !== args.occupant.listingId) continue;
    if (startKey !== null && b.sessionDate < startKey) return true;
    if (
      typeof b.close === "number" &&
      Number.isFinite(b.close) &&
      b.close > 0
    ) {
      const sf = b.splitFactor;
      series.push({
        sessionDate: b.sessionDate,
        close: b.close,
        sf: typeof sf === "number" && Number.isFinite(sf) && sf > 0 ? sf : 1,
      });
    }
  }
  series.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : 1));

  const breaksAt = (i: number): boolean => {
    if (i <= 0) return false;
    const prev = series[i - 1]!;
    const cur = series[i]!;
    const days =
      (Date.parse(cur.sessionDate) - Date.parse(prev.sessionDate)) / 86_400_000;
    return (
      days <= BOUNDARY_ADJACENT_DAYS &&
      Math.abs(Math.log((cur.close * cur.sf) / prev.close)) >
        BOUNDARY_BREAK_LOG_RETURN
    );
  };
  for (const w of args.windows) {
    if (w.listingId === args.occupant.listingId) continue;
    const s = key(w.listingStartDate);
    const e = key(w.listingEndDate);
    if (s !== null && breaksAt(series.findIndex((b) => b.sessionDate >= s))) {
      return true;
    }
    if (e !== null && breaksAt(series.findIndex((b) => b.sessionDate > e))) {
      return true;
    }
  }
  return false;
}

/** |ln(close·splitFactor / previous close)| above this is a seam (~28%). */
export const BOUNDARY_BREAK_LOG_RETURN = 0.25;
/** Stored sessions further apart than this are a gap, not a seam. */
const BOUNDARY_ADJACENT_DAYS = 5;

/** What `classifyBarListing` needs to decide an AMBIGUOUS session. */
export interface LatestOccupancy {
  /** Ids of every master window covering the session — the resolver's candidates. */
  candidateIds: readonly string[];
  /** {@link latestOccupantOf} for the symbol, by id. */
  latestOccupantId: string | null;
  /** {@link hasStitchedHistory} for the symbol, over its whole series. */
  stitched: boolean;
}

/**
 * Does the master agree with the `listingId` this bar already carries?
 *
 * ## THE STORED ID IS WHAT GETS WRITTEN — the resolver is the GATE
 *
 * Both halves of that sentence are deliberate.
 *
 * The bar's own `listingId` was produced by `buildListingId` when the bar was
 * ingested, and it is what `Candle`'s `[listingId, timeframe, ts]` index, the
 * cold shard's own rows and `identity-sync`'s `listing` table all already use.
 * OVERWRITING it with the resolver's answer would make the lake disagree with
 * every other store over the same bar, silently, whenever the master moved a
 * window — and the lake is the copy nobody reads row by row.
 *
 * Taking it on trust is the other failure. So the master decides whether it may
 * be written at all: a disagreement is QUARANTINED, not corrected and not
 * passed through. That keeps the two stores in agreement or keeps the row out,
 * and never produces a third answer.
 *
 * ## `multiVenue` IS ACCEPTED WITHOUT COMPARING IDS, and that is not laxity
 *
 * `resolveListingForDate` returns `multiVenue: true` only when every matching
 * window shares an IDENTICAL `listingStartDate` on DIFFERENT venues — one
 * security listed on several boards, which it has already certified. It then
 * picks one by `US_EXCHANGE_PRIORITY`, and that pick is a tie-break for a
 * consolidated feed, not a claim that the other venues are a different company.
 * A bar carrying the NYSE id when the priority table prefers NASDAQ is the same
 * security, so refusing it would quarantine healthy rows for a venue
 * preference. The method records which arm ran, so a report can still separate
 * them.
 *
 * ## AN AMBIGUOUS SESSION IS ADMITTED ONLY FOR THE CURRENT OCCUPANT — MONEY-1616
 *
 * Every condition must hold, and the stored id is still what gets written:
 *
 *   the stored id is one of the windows covering the session
 *   it is the symbol's UNIQUE latest-ending window ({@link latestOccupantOf})
 *   the symbol shows no stitched history ({@link hasStitchedHistory})
 *
 * Anything else stays LISTING_AMBIGUOUS — a delisted stored id beside an ACTIVE
 * candidate (TOPW), a phantom window's id (GAB), a tie, a stitched symbol.
 * What it still cannot see is a predecessor stitched inside the overlap whose
 * seam happens to be price-continuous (under a 28% move); the seam check in
 * {@link hasStitchedHistory} covers the rest, and `LATEST_OCCUPANT` names
 * every row admitted so a reader can exclude them.
 * MISMATCH and UNRESOLVED are untouched.
 */
export function classifyBarListing(args: {
  resolution: ListingResolutionLike;
  barListingId: string;
  occupancy?: LatestOccupancy;
}): ListingVerdict {
  const { resolution, barListingId, occupancy } = args;
  if (!resolution.ok) {
    if (resolution.reason !== "ambiguous") {
      return { ok: false, reason: "LISTING_UNRESOLVED" };
    }
    const admit =
      occupancy !== undefined &&
      !occupancy.stitched &&
      occupancy.latestOccupantId === barListingId &&
      occupancy.candidateIds.includes(barListingId);
    return admit
      ? { ok: true, method: "LATEST_OCCUPANT" }
      : { ok: false, reason: "LISTING_AMBIGUOUS" };
  }
  if (resolution.multiVenue) {
    return { ok: true, method: "VENDOR_LISTING_ID_MULTIVENUE" };
  }
  // A BLANK stored id is a MISMATCH, never a pass. `!==` already refuses it
  // (no resolved listing has an empty id), and it is called out because the
  // tempting "trust it when we have nothing better" would write an empty
  // `listing_id` into a NOT NULL column's worth of rows that join to nothing.
  return resolution.listing.listingId === barListingId
    ? { ok: true, method: "VENDOR_LISTING_ID" }
    : { ok: false, reason: "LISTING_MISMATCH" };
}

/**
 * The full classifier for one mapped `price_bar_d1` row.
 *
 * ## THERE IS NO `WRONG_MONTH` RUNG HERE, and that is a design property
 *
 * The India replay needs one because its partition is FIXED by the month being
 * walked while the row's date comes off the file's own column, and the two can
 * disagree. This job derives the partition FROM the row (`priceBarPartitionKey`
 * of the bar's own session date), so a stray bar in a cold shard lands in its
 * OWN correct month rather than in a neighbouring one — there is no
 * disagreement to detect, and a rung asserting one would be a tautology no
 * mutation could kill.
 *
 * What replaces it is the SHELL's range check: a cold shard is a whole YEAR and
 * the run window is days, so bars outside the window are excluded before they
 * reach a partition at all. That exclusion is not a quarantine — it is the
 * correct answer, the same way the India job names a family it does not walk.
 */
export function classifyUsPriceBarRow(args: {
  row: {
    listing_id: string;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
  };
  resolution: ListingResolutionLike;
  occupancy?: LatestOccupancy;
}):
  | { keep: true; method: UsResolutionMethod }
  | { keep: false; reason: UsQuarantineReason } {
  const { row, resolution, occupancy } = args;
  const listing = classifyBarListing({
    resolution,
    barListingId: row.listing_id,
    occupancy,
  });
  if (!listing.ok) return { keep: false, reason: listing.reason };
  if (classifyPricedRow(row) !== null) {
    return { keep: false, reason: "NO_FINITE_PRICE" };
  }
  return { keep: true, method: listing.method };
}

/**
 * Widen a `[from, to]` request to WHOLE MONTHS.
 *
 * ## `replaceMonth` DELETES A MONTH, so a partial window destroys data
 *
 * `price_bar_d1` and `fund_nav_d1` are both `PARTITION BY DATE_TRUNC(…, MONTH)`
 * and the ledger claims a month, so `replaceMonth`'s DELETE covers
 * `[month-01, next-month-01)` whatever the operator asked for. A run of
 * `--from 2024-03-15 --to 2024-03-31 --apply` would therefore delete the first
 * fortnight of March and reload only the second — a two-week hole in a table
 * that reports the month ACCEPTED, produced by a flag that looks like a
 * narrowing.
 *
 * Snapping is the only answer that cannot lose rows. Refusing a partial window
 * outright was the alternative and it is worse in practice: the operator's next
 * move is to widen it by hand to exactly this, and a hand-widened window is one
 * typo away from the hole again.
 *
 * The caller LOGS the snap. Loading more than was asked for is surprising, and
 * a surprise stated in the run header is a different thing from a silent one.
 */
export function snapWindowToMonths(
  from: string,
  to: string,
): { from: string; to: string } {
  const parse = (d: string, field: string): { y: number; m: number } => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (!m) {
      throw new Error(
        `--${field} must be YYYY-MM-DD, got ${JSON.stringify(d)}`,
      );
    }
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`--${field} ${JSON.stringify(d)} is not a real date`);
    }
    return { y: Number(m[1]), m: month };
  };
  const a = parse(from, "from");
  const b = parse(to, "to");
  if (b.y < a.y || (b.y === a.y && b.m < a.m)) {
    throw new Error(`--from ${from} is after --to ${to}`);
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  // The last day of month M is day 0 of month M+1, and `Date.UTC` rolls the
  // YEAR over on its own — the December case a hand-written `month + 1` gets
  // wrong by producing `2024-13-01` (`monthDeleteBounds` carries the same note).
  const end = new Date(Date.UTC(b.y, b.m, 0));
  return { from: `${a.y}-${pad(a.m)}-01`, to: end.toISOString().slice(0, 10) };
}

/* ─────────────────────────────────────────────────────────────────────────
   fund_nav_d1
   ──────────────────────────────────────────────────────────────────────── */

/** A NAV as the shell hands it over, before provenance is attached. */
export interface RawFundNav {
  permaTicker: string;
  symbol: string | null;
  /** `YYYY-MM-DD`, the session the NAV describes. */
  navDate: string;
  nav: number | null;
  source: string;
}

/** One `fund_nav_d1` row, snake_case because the loader writes NDJSON by name. */
export interface FundNavRow {
  perma_ticker: string;
  symbol: string | null;
  nav_date: string;
  nav: number | null;
  source: string;
  source_object_uri: string;
  source_record_key: string;
  parser_version: string;
  pipeline_run_id: string;
  observed_at: string;
  ingested_at: string;
}

/**
 * Map one NAV onto its silver row.
 *
 * ## `nav` GOES THROUGH `numeric()` FROM THE FIRST LINE — MONEY-1512
 *
 * `fund_nav_d1.nav` is `NUMERIC(18, 6)` and BigQuery REFUSES a NUMERIC carrying
 * more decimal places than its column declares. The load path runs
 * `maxBadRecords: 0`, so ONE such row fails the whole month — which is how
 * `derivatives_eod_in` could not load a single row, for any window, from the
 * day it shipped.
 *
 * `UsFundNav.nav` is a Mongo `Float` (IEEE-754 binary), so any NAV that was
 * ever the result of arithmetic can carry a seventeen-digit tail — and Tiingo's
 * own fund rows arrive from a CSV whose values we divide nowhere but store
 * verbatim, which is exactly the "it has two decimals today" reasoning that
 * `delivery_pct` had to correct. Rounding at the ROW boundary is the rule
 * `toPriceBarRow` already follows; stating it per producer instead is a rule
 * that can disagree with itself.
 *
 * ## A NON-FINITE NAV BECOMES NULL, NEVER 0
 *
 * A NAV of 0 is a fund that went to zero. `numeric()` returns null, and
 * {@link classifyFundNavRow} then refuses the row outright — the two together
 * keep "we have this session" and "we have a NAV for this session" the same
 * answer, which is what a coverage query counting sessions depends on.
 */
export function toFundNavRow(nav: RawFundNav, prov: RowProvenance): FundNavRow {
  return {
    perma_ticker: nav.permaTicker,
    symbol: nav.symbol,
    nav_date: nav.navDate,
    nav: numeric(nav.nav),
    source: nav.source,
    source_object_uri: prov.sourceObjectUri,
    source_record_key: prov.sourceRecordKey,
    parser_version: prov.parserVersion ?? US_PARSER_VERSIONS.fund_nav_d1,
    pipeline_run_id: prov.pipelineRunId,
    observed_at: new Date(prov.observedAtMs).toISOString(),
    ingested_at: new Date(prov.ingestedAtMs).toISOString(),
  };
}

/**
 * The classifier for one mapped `fund_nav_d1` row.
 *
 * WRONG_MONTH is checked even though the shell queries Mongo BY month: the
 * partition key and the query bound are two spellings of one month, and this is
 * the cheap place to hold them in agreement. There is no listing rung — a NAV
 * keys on `permaTicker`, which is not in the master and not derivable from it,
 * so there is no window to resolve against.
 */
export function classifyFundNavRow(args: {
  row: { nav_date: string; nav: number | null };
  partitionKey: string;
}): UsQuarantineReason | null {
  if (!isSessionInPartition(args.partitionKey, args.row.nav_date)) {
    return "WRONG_MONTH";
  }
  return args.row.nav === null ? "NO_FINITE_NAV" : null;
}

/* ─────────────────────────────────────────────────────────────────────────
   Coverage
   ──────────────────────────────────────────────────────────────────────── */

export type { MonthVerdict };

/**
 * May this US month be loaded, and what does coverage mean for it?
 *
 * ## THE ARITHMETIC IS `decideMonth`'s, DELIBERATELY NOT A SECOND COPY
 *
 * The rule is the same rule: a partition may be ACCEPTED only when every
 * session we OBSERVED actually produced rows, because `ACCEPTED` is what makes
 * every future run skip and accepting a partial month freezes the gap for ever.
 * Restating the three branches here would be one rule with two spellings, free
 * to disagree — and the version that drifts would be the one nobody re-reads.
 *
 * The US calendar cannot supply a stronger `expected`. `US_MARKET_HOLIDAYS`
 * covers 2023-2028 only (`US_HOLIDAY_TABLE_YEARS`), and this replay reaches
 * 1962 — so counting weekdays would make every month containing a holiday read
 * partial, the gate would be useless, and the obvious next move would be to
 * weaken it to `>= 1`, which is the not-measured-is-not-passed defect this repo
 * has shipped four times.
 *
 * What differs is only the SENTENCE. `decideMonth`'s skip reasons name day-files
 * and family floors, which do not exist here: this job's sources are a Mongo
 * window and a set of per-symbol year shards. An operator reading "before the
 * family's floor" about a US month would go looking for a registry that has no
 * US entry, so the reasons are re-spelled — and only the reasons.
 */
export function decideUsMonth(args: {
  /** Session dates OBSERVED in the source, before any quarantine. A SET. */
  sessionsSeen: ReadonlySet<string>;
  /** Session dates PRESENT in the rows that survived. Also a set. */
  sessionsWritten: ReadonlySet<string>;
  rowCount: number;
}): MonthVerdict {
  const verdict = decideMonth({
    datesRead: args.sessionsSeen,
    sessionDates: args.sessionsWritten,
    rowCount: args.rowCount,
  });
  if (verdict.action !== "skip") return verdict;
  return {
    action: "skip",
    reason:
      args.sessionsSeen.size === 0
        ? "no hot row and no cold-shard row fell in this month — before the " +
          "first session we hold, or a month the store genuinely does not " +
          "cover. Not a failure; nothing to load."
        : `${args.sessionsSeen.size} session(s) observed and zero rows survived ` +
          `— quarantine explains why`,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Provenance URIs
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `source_object_uri` for a row that came out of MONGO rather than an object.
 *
 * `events-logic.ts` already set this convention for a producer-asserted row
 * (`event://SEC_EDGAR/…`): there is no archived object behind it, so the column
 * names the ASSERTION instead. It keeps lake-layout.md §5's promise — a wrong
 * number can be traced to what produced it — to the extent that is true here.
 *
 * It also does real work beyond bookkeeping: a US bar can arrive from the hot
 * window OR from a cold shard, and those two have genuinely different failure
 * modes. The shard form is a real `gs://` object the operator can fetch; this
 * form says "Mongo held this and no shard did", which is the only way to tell,
 * after the fact, that a partition was loaded before `candle-evict` archived it.
 */
export function mongoSourceUri(collection: string, key: string): string {
  if (!collection.trim() || !key.trim()) {
    throw new Error(
      `mongoSourceUri: both parts are required (got "${collection}", "${key}") — ` +
        `an empty half produces a uri that traces back to nothing`,
    );
  }
  return `mongo://${collection}/${key}`;
}

/**
 * A stage `part` name that scopes a `bq load` wildcard to ONE source.
 *
 * ## WHY THE SOURCE IS IN THE OBJECT NAME
 *
 * `price_bar_d1.source` is NOT NULL and a cluster key because it is what
 * disambiguates a volume of 0 — structural (a quote-derived feed reports none)
 * versus nothing traded. So the replay carries each bar's OWN source rather
 * than stamping one, and `replaceMonth` scopes its DELETE by source: a month
 * holding two sources needs one delete-and-load per source, or the second load
 * deletes the first's rows.
 *
 * That requires a wildcard that matches one source's shards and not the other's,
 * and the separator is what makes it safe. `TIINGO` is a PREFIX of `TIINGO_RT`,
 * so `TIINGO*` would swallow both; `TIINGO-*` cannot, because the next
 * character differs. The charset is asserted for exactly that reason — a source
 * containing `-` or `*` would reintroduce the collision silently, and the
 * symptom would be a month loaded twice under one source and not at all under
 * the other.
 *
 * Measured on prod 2026-09-22: every D1 candle row is `TIINGO` and every
 * `UsFundNav` row is `TIINGO`, so the multi-source path is unexercised today.
 * It is built anyway because the alternative — assuming one source and stamping
 * it — is wrong in a way the row count cannot reveal.
 */
export function stagePartForSource(source: string, sequence: number): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(source)) {
    throw new Error(
      `stagePartForSource: source ${JSON.stringify(source)} is not ` +
        `[A-Z][A-Z0-9_]* — a "-" or "*" in a source makes the per-source ` +
        `bq load wildcard match another source's shards`,
    );
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(
      `stagePartForSource: sequence must be a non-negative integer, got ${sequence}`,
    );
  }
  return `${source}-${String(sequence).padStart(6, "0")}`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Symbol failures during the walk — MONEY-1608 review
   ──────────────────────────────────────────────────────────────────────── */

/** Consecutive symbol failures after which the walk stops. */
export const MAX_CONSECUTIVE_SYMBOL_FAILURES = 50;

export class WalkAbortedError extends Error {
  constructor(count: number, last: string) {
    super(
      `WALK ABORTED: ${count} consecutive symbols failed — this is systemic ` +
        `(a missing grant, a dead bucket or database), not a bad symbol. ` +
        `Last: ${last}`,
    );
    this.name = "WalkAbortedError";
  }
}

/**
 * Tracks symbol failures AS THEY HAPPEN.
 *
 * A failed symbol used to be collected silently and reported only after the
 * whole walk — 8 h later, or never if the run died first. So every failure
 * yields its log line immediately, and a RUN of failures stops the walk: 50
 * symbols in a row failing is not 50 bad symbols, it is one broken
 * dependency, and walking the other 23,000 into it only delays the report.
 * A success resets the run.
 */
export function createSymbolFailureTracker(
  limit: number = MAX_CONSECUTIVE_SYMBOL_FAILURES,
): {
  ok(): void;
  /** Returns the line to log now; throws `WalkAbortedError` at the limit. */
  fail(symbol: string, err: unknown): string;
} {
  let consecutive = 0;
  return {
    ok() {
      consecutive = 0;
    },
    fail(symbol, err) {
      consecutive++;
      const line = `symbol ${symbol} FAILED (${consecutive} in a row): ${
        err instanceof Error ? err.message : String(err)
      }`;
      if (consecutive >= limit) throw new WalkAbortedError(consecutive, line);
      return line;
    },
  };
}
