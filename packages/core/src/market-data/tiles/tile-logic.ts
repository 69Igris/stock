/**
 * D1 tiles — the pure half. MONEY-1467 (data-platform A2).
 *
 * A tile is an immutable JSON object holding adjusted daily bars for ONE
 * listing, so `/udf/history` can answer a five-year chart from a single object
 * read instead of a Mongo range scan plus a live vendor fetch. Two shapes:
 *
 *   5y      rebuilt nightly, the last five CALENDAR years, ascending
 *   {year}  one per CLOSED year, written once, rewritten only when an
 *           adjustment changes (the manifest records which)
 *
 * This module imports nothing but `price-adjust` and the pure
 * `prices/yahoo-price-logic`, so nothing here opens a handle and every rule
 * below is unit-testable without a database.
 *
 * ## THE KEYS LIVE UNDER `tiles/`, NOT `bars/`
 *
 * The A2 brief keys year tiles `bars/d1/{market}/{listing_id}/{year}.json`.
 * `bars/` is in NEITHER `LAKE_PREFIXES` nor `CONTENT_PREFIXES`
 * (`ops/lake-layout.ts`), so `bucketForPrefix("bars/…")` THROWS — measured, not
 * assumed. `tiles/` is in the contract, MONEY-1466 already resolved the same
 * question the same way, and giving one class of object two prefixes is how a
 * lake grows a second spelling of one fact. The brief is also inconsistent with
 * itself about segment order (`tiles/{market}/d1/…` vs `bars/d1/{market}/…`);
 * one order is used here.
 *
 * ## THE YEAR SPLIT IS IN THE VENUE'S TIMEZONE, AND THAT IS THE WHOLE POINT
 *
 * India's session closes 15:30 IST = 10:00 UTC, so a UTC split happens to work
 * for NSE closes and breaks the moment a bar is stamped near midnight local.
 * `2023-12-31T19:00:00Z` is **1 January 2024, 00:30 IST** — year 2024 in the
 * venue and 2023 in UTC. A UTC-split tile files that bar in the wrong year
 * object, and the reader then returns a chart that is silently missing a
 * session at a boundary nobody looks at. There is no error at any point.
 */
import {
  buildAdjustmentTimeline,
  type AdjustingAction,
  type RawBar,
} from "../price-adjust";
import { adjustBarsForBasis } from "../prices/yahoo-price-logic";

/**
 * The chart's own action loader, re-exported for the builder — MONEY-1541,
 * MONEY-1543. The job imports this subpath and nothing heavier;
 * `price-adjust` has none.
 */
export { loadAdjustingActions } from "../price-adjust";

/**
 * Bumped when the ENCODED SHAPE changes. `decodeTile` refuses anything it does
 * not know rather than guessing — a tile written by a future build must not be
 * read as if it were this one, because every field would parse and the prices
 * would be wrong.
 */
export const TILE_FORMAT_VERSION = 1;

/**
 * Bumped when the ADJUSTMENT POLICY changes (not the format).
 *
 * It is a separate number from the format version because they answer different
 * questions: the format version decides whether the reader can parse the bytes,
 * this one decides whether a tile built earlier is still CORRECT. A tile whose
 * stored value is lower than this must be rebuilt even though it decodes
 * perfectly — which is exactly the case a single version number cannot express.
 */
export const ADJUSTMENT_POLICY_VERSION = 2;
/*
 * 2 — MONEY-1541. India tiles now adjust exactly as the live chart does: the
 * company's actions across both exchanges, every former symbol and the ISIN;
 * the detector's OBSERVED gap and the DERIVED rules (they need `source` and
 * `details`, which the builder did not select); and a Yahoo row only for the
 * actions after we fetched it (MONEY-1382 — Yahoo had already applied the
 * rest). Every closed year built under 1 is on the old basis, so all of them
 * are rewritten once. The US tiles rebuild too, from gold, unchanged — the
 * price of one number for both markets.
 */

/** The 5y tile holds this many calendar years, inclusive of the current one. */
export const FIVE_YEAR_WINDOW = 5;

export type TileMarket = "IN" | "US";

/**
 * The venue clock per market. NOT a display preference — it decides which year
 * object a bar is filed under, so changing it silently re-files history.
 */
export const VENUE_TIMEZONE: Readonly<Record<TileMarket, string>> = {
  IN: "Asia/Kolkata",
  US: "America/New_York",
};

/**
 * One bar, as TradingView wants to receive it: `[t, o, h, l, c, v]` with `t` in
 * unix SECONDS.
 *
 * A tuple rather than an object because a 5y tile is ~1,250 bars and the key
 * names would be ~85% of the payload. Seconds rather than milliseconds because
 * the UDF spec reads them as seconds — milliseconds put the chart ~55,000 years
 * in the future and render an EMPTY CHART rather than an error.
 */
export type TileBar = readonly [
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
];

/** Where a bar came from. Parallel array, not a per-bar field, to stay small. */
export type BarSource =
  | "BHAVCOPY"
  | "BHAVCOPY_HIST"
  | "YAHOO"
  | "TIINGO"
  | "DATABENTO"
  | "LIVE"
  | "UNKNOWN";

export interface TileHeader {
  /** Format version. `decodeTile` refuses an unknown value. */
  v: number;
  listing_id: string;
  market: TileMarket;
  adjustment_policy_version: number;
  /** ISO-8601. Also the Redis cache key discriminator for the reader. */
  built_at: string;
  /** Unix seconds of the first/last bar, or null for an empty tile. */
  first_bar: number | null;
  last_bar: number | null;
  /**
   * India only: the `InstrumentMapping` id. Kept in the HEADER rather than the
   * key because `listing_id` is `{symbol}:{exchange}` for now and the Mongo id
   * is environment-specific — QA holds its own ObjectIds for
   * `instrument_mappings` (it is QA-DIRECT), so a key carrying one would not be
   * portable between environments while the bars themselves are.
   */
  instrument_id?: string;
}

export interface Tile {
  header: TileHeader;
  bars: TileBar[];
  /** Parallel to `bars`. Same length, always. */
  sources: BarSource[];
}

/* ─────────────────────────────────────────────────────────────────────────
   Keys
   ──────────────────────────────────────────────────────────────────────── */

/**
 * A listing id is DATA, and it becomes part of an object key.
 *
 * `{symbol}:{exchange}` for India and `{symbol}:{exchange}:{listingStart}` for
 * US both come out of the database, so a stray `/` would silently change the
 * key's shape and a `..` segment would escape the prefix entirely — and
 * `bucketForPrefix` only inspects the FIRST segment, so neither would be
 * refused there. Colons are deliberately allowed: they are legal in a GCS
 * object name and they are the format `Candle.listingId` already uses.
 *
 * ## `&` IS ALLOWED, AND LEAVING IT OUT BROKE 20 TILES A NIGHT
 *
 * Measured on prod from the nightly job outcome: `tile-build-d1-in` exits 1
 * every run on TEN symbols across BOTH exchanges — `M&M` (a NIFTY 50
 * constituent), `M&MFIN`, `J&KBANK`, `IL&FSTRANS`, `IL&FSENGG`, `GVT&D`,
 * `GMRP&UI`, `ARE&M`, `S&SPOWER`, `SURANAT&P`. So Mahindra & Mahindra has had
 * no D1 tile in either environment, and the chart for it is blank on the tile
 * origin.
 *
 * The ampersand is NOT a safety problem — the property this charset protects is
 * "nothing that changes the key's SHAPE", i.e. `/` and `..`. `&` is an ordinary
 * character in a GCS object name, it is not a path separator, and the storage
 * client percent-encodes it on the wire. It was simply never in the set,
 * because the set was written from the US listing ids.
 *
 * It is ALLOWED rather than FOLDED, deliberately: a fold needs a target
 * character that cannot collide with a real id, and the space fold already
 * spent the only one that qualifies (`_`). Folding `&` to `_` too would map
 * `A&B` and `A B` onto ONE key — two different instruments sharing a tile,
 * which is worse than the failure it replaces.
 */
const SAFE_LISTING_ID = /^[A-Za-z0-9._:+&-]{1,200}$/;

export class UnsafeListingIdError extends Error {
  constructor(listingId: string) {
    super(
      `refusing to build a tile key for listing id ${JSON.stringify(listingId)}: ` +
        "it must match [A-Za-z0-9._:+&-]{1,200}. A separator here would move the " +
        "object outside its prefix, and bucketForPrefix only inspects the first segment.",
    );
    this.name = "UnsafeListingIdError";
  }
}

/**
 * Can a tile key be built for this listing id at all? MONEY-1476.
 *
 * Exported so a CALLER can refuse BEFORE the key builder throws. `/udf/symbols`
 * resolved `NSE:NIFTY 50` — a real, chartable-looking `instrument_mappings` row
 * — and `/udf/history` then threw here, and its `err.message` reached the
 * browser: the user's chart displayed this class's internal explanation about
 * GCS prefixes. Every index whose name carries a space is in that population.
 *
 * A resolver that says yes to a symbol the key builder says no to is the
 * defect; asking the same predicate is how they stop disagreeing.
 */
export function canBuildTileKey(listingId: string): boolean {
  const id = foldListingIdForKey(listingId);
  if (!SAFE_LISTING_ID.test(id)) return false;
  // The charset ALONE is not enough — see `assertSafeListingId`. This used to
  // test only the regex, so it answered TRUE for "..:NSE" while the builder
  // threw: the predicate said a symbol was chartable and the key builder then
  // leaked its refusal into the user's chart. That is the exact disagreement
  // this function was added to prevent, so the two now share ONE rule.
  return !(id.includes("..") || id === ".");
}

/**
 * A SPACE is the one unsafe character real listing ids actually contain, and
 * it is in the EXCHANGE name. MONEY-1479.
 *
 * Measured on prod: 284 of 14,258 US listings could not be tiled, ALL of them
 * `NYSE ARCA` (244) and `NYSE MKT` (40) — e.g. `ESSC:NYSE ARCA:2025-09-30`.
 * 244 are ETFs. That is not a data error to clean up; those are the exchanges'
 * real names.
 *
 * So the space is FOLDED TO AN UNDERSCORE when the key is built, rather than
 * the stored `Candle.listingId` being migrated. Underscore is outside the
 * charset that appears in any listing id, so the mapping cannot collide with a
 * real one — `NYSE ARCA` and a hypothetical `NYSE_ARCA` would, but no exchange
 * uses an underscore, and `assertSafeListingId` still refuses everything else.
 *
 * READERS MUST APPLY THE SAME FOLD, which is why it lives here beside the key
 * builders and is not inlined at either call site: a key written with the fold
 * and read without it is a 404 that renders as a blank chart.
 */
export function foldListingIdForKey(listingId: string): string {
  return listingId.replace(/ /g, "_");
}

function assertSafeListingId(listingId: string): void {
  // ONE rule, asked rather than restated. `canBuildTileKey` folds the space and
  // applies both the charset and the traversal check; duplicating either here
  // is how the two drifted apart in the first place.
  if (!canBuildTileKey(listingId)) throw new UnsafeListingIdError(listingId);
}

/** `tiles/{market}/d1/{listing_id}/5y.json` */
export function tileKey5y(market: TileMarket, listingId: string): string {
  const id = foldListingIdForKey(listingId);
  assertSafeListingId(id);
  return `tiles/${market}/d1/${id}/5y.json`;
}

/** `tiles/{market}/d1/{listing_id}/{year}.json` */
export function tileKeyYear(
  market: TileMarket,
  listingId: string,
  year: number,
): string {
  const id = foldListingIdForKey(listingId);
  assertSafeListingId(id);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new RangeError(`tileKeyYear: implausible year ${year}`);
  }
  return `tiles/${market}/d1/${id}/${year}.json`;
}

/** `tiles/{market}/d1/manifest.json` — one manifest per market. */
export function tileManifestKey(market: TileMarket): string {
  return `tiles/${market}/d1/manifest.json`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Venue-local calendar years
   ──────────────────────────────────────────────────────────────────────── */

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = offsetFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatters.set(timeZone, f);
  }
  return f;
}

/** The zone's UTC offset in ms AT a given instant (so DST is handled). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(at);
  const pick = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  // `hour12: false` can render midnight as 24 in some ICU versions.
  const asIfUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    pick("hour") % 24,
    pick("minute"),
    pick("second"),
  );
  return asIfUtc - at.getTime();
}

/**
 * Unix SECONDS of 1 January `year`, 00:00:00, in the venue's own clock.
 *
 * Computed once per year and then used for numeric comparisons, rather than
 * formatting every bar: a full build is ~5,000 listings x ~1,250 bars, and an
 * `Intl` format call per bar is six million of them. Same answer, and the
 * difference is minutes.
 */
export function venueYearStartSec(year: number, market: TileMarket): number {
  const tz = VENUE_TIMEZONE[market];
  const naive = Date.UTC(year, 0, 1, 0, 0, 0);
  // Two passes: the offset AT the naive instant may differ from the offset at
  // the corrected one across a DST edge. January is never a DST boundary for
  // either venue today, but the correction costs one format call per year and
  // removes the assumption rather than documenting it.
  const first = zoneOffsetMs(new Date(naive), tz);
  const corrected = naive - first;
  const second = zoneOffsetMs(new Date(corrected), tz);
  const finalMs = second === first ? corrected : naive - second;
  return Math.floor(finalMs / 1000);
}

/** The venue-local calendar year a unix-seconds instant falls in. */
export function venueYear(tsSec: number, market: TileMarket): number {
  const tz = VENUE_TIMEZONE[market];
  const at = new Date(tsSec * 1000);
  const parts = formatterFor(tz).formatToParts(at);
  const y = parts.find((p) => p.type === "year");
  return y ? Number(y.value) : new Date(tsSec * 1000).getUTCFullYear();
}

/* ─────────────────────────────────────────────────────────────────────────
   Adjustment
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Back-adjust bars using the SAME code path the live chart already uses.
 *
 * Deliberately a thin wrapper over `buildAdjustmentTimeline` +
 * `adjustBarsForBasis` rather than a reimplementation: A3's acceptance is that a
 * tile and the old path agree on sampled dates, and two implementations of one
 * policy agree until the day they do not. The only thing added here is the
 * count, which the builder writes to the manifest.
 *
 * `adjustBarsForBasis`, not `applyAdjustment` — MONEY-1541. Prod charts have
 * read TILES since 2026-09-17, and a Yahoo row arrives already divided by every
 * action up to the moment we fetched it (`adjustedThrough`). Dividing it by the
 * whole timeline again is the MONEY-1382 double adjustment, on the path users
 * are actually served. A bar with no `adjustedThrough` is adjusted exactly as
 * before.
 */
export function applyAdjustments<T extends RawBar & { adjustedThrough?: Date }>(
  bars: readonly T[],
  actions: readonly AdjustingAction[],
): { bars: readonly T[]; actionsUsed: number; actionsIgnored: number } {
  const { steps, used, ignored } = buildAdjustmentTimeline(actions);
  return {
    bars: adjustBarsForBasis(bars, steps),
    actionsUsed: used,
    actionsIgnored: ignored,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Building
   ──────────────────────────────────────────────────────────────────────── */

export interface SourcedBar extends RawBar {
  /** Provenance, carried through so the reader can badge it. */
  source?: string;
  /** A Yahoo row's fetch instant — see `applyAdjustments`. */
  adjustedThrough?: Date;
}

export interface BuildTilesOptions {
  market: TileMarket;
  listingId: string;
  /** India: the InstrumentMapping id, stored in the header only. */
  instrumentId?: string;
}

export interface BuiltTiles {
  fiveY: Tile;
  /** CLOSED years only — the current venue year is never a year tile. */
  years: { year: number; tile: Tile }[];
}

function toTileBar(bar: SourcedBar): TileBar {
  return [
    Math.floor(bar.date.getTime() / 1000),
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
  ];
}

function normaliseSource(raw: string | undefined): BarSource {
  switch (raw) {
    case "BHAVCOPY":
    // The same exchange file, replayed — 10.2M of prod's 10.8M `daily_prices`
    // rows. It fell to UNKNOWN, so nearly every India bar was badged as
    // provenance we could not name. MONEY-1541.
    case "BHAVCOPY_HIST":
    case "YAHOO":
    case "TIINGO":
    case "DATABENTO":
    case "LIVE":
      return raw;
    default:
      // A NAMED value, never an absent one. `undefined` in a parallel array
      // would shift every later index if it were dropped, and "we do not know"
      // is a different statement from "Yahoo filled it".
      return "UNKNOWN";
  }
}

function makeTile(
  bars: readonly SourcedBar[],
  opts: BuildTilesOptions,
  builtAt: Date,
): Tile {
  const tileBars = bars.map(toTileBar);
  const header: TileHeader = {
    v: TILE_FORMAT_VERSION,
    listing_id: opts.listingId,
    market: opts.market,
    adjustment_policy_version: ADJUSTMENT_POLICY_VERSION,
    built_at: builtAt.toISOString(),
    first_bar: tileBars.length ? tileBars[0]![0] : null,
    last_bar: tileBars.length ? tileBars[tileBars.length - 1]![0] : null,
  };
  if (opts.instrumentId) header.instrument_id = opts.instrumentId;
  return {
    header,
    bars: tileBars,
    sources: bars.map((b) => normaliseSource(b.source)),
  };
}

/**
 * Split adjusted, ascending bars into the 5y tile and one tile per CLOSED year.
 *
 * `now` is passed in rather than read from the clock so the boundary behaviour
 * is testable — a year-split bug is invisible except on two days a year.
 */
export function buildTilesFromBars(
  bars: readonly SourcedBar[],
  now: Date,
  opts: BuildTilesOptions,
): BuiltTiles {
  const nowSec = Math.floor(now.getTime() / 1000);
  const currentYear = venueYear(nowSec, opts.market);
  const windowStartYear = currentYear - (FIVE_YEAR_WINDOW - 1);
  const windowStartSec = venueYearStartSec(windowStartYear, opts.market);

  // Precomputed numeric boundaries, so bucketing is a comparison per bar
  // rather than a timezone format per bar.
  const boundaries = new Map<number, number>();
  for (let y = windowStartYear - 1; y <= currentYear + 1; y++) {
    boundaries.set(y, venueYearStartSec(y, opts.market));
  }

  const yearOf = (tsSec: number): number => {
    // Walk from the current year down; a bar older than every precomputed
    // boundary falls back to the exact (slower) answer rather than guessing.
    for (let y = currentYear + 1; y >= windowStartYear - 1; y--) {
      const start = boundaries.get(y);
      if (start !== undefined && tsSec >= start) return y;
    }
    return venueYear(tsSec, opts.market);
  };

  const inWindow: SourcedBar[] = [];
  const byYear = new Map<number, SourcedBar[]>();

  for (const bar of bars) {
    const tsSec = Math.floor(bar.date.getTime() / 1000);
    if (tsSec >= windowStartSec) inWindow.push(bar);
    const y = yearOf(tsSec);
    // CLOSED years only. The current year is still accumulating sessions, so a
    // year tile written for it would be "written once" and immediately wrong —
    // the one property the year tiles exist to have.
    if (y < currentYear) {
      let bucket = byYear.get(y);
      if (!bucket) {
        bucket = [];
        byYear.set(y, bucket);
      }
      bucket.push(bar);
    }
  }

  return {
    fiveY: makeTile(inWindow, opts, now),
    years: [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, yearBars]) => ({
        year,
        tile: makeTile(yearBars, opts, now),
      })),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Encoding
   ──────────────────────────────────────────────────────────────────────── */

export class TileDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TileDecodeError";
  }
}

export function encodeTile(tile: Tile): Buffer {
  return Buffer.from(JSON.stringify(tile), "utf8");
}

/**
 * Parse a tile, REFUSING anything this build does not understand.
 *
 * Fail-closed on the version is the whole reason the field exists. A tile
 * written by a later format would very likely still parse as JSON, produce
 * numbers of the right type in the right places, and render a chart that is
 * quietly wrong — which is indistinguishable from a correct one to everybody
 * except the person reconciling a price months later.
 *
 * The parallel `sources` array is length-checked for the same reason: a short
 * array does not fail, it mis-attributes every bar after the gap.
 */
export function decodeTile(body: Buffer | string): Tile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof body === "string" ? body : body.toString("utf8"),
    );
  } catch (err) {
    throw new TileDecodeError(
      `tile is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object")
    throw new TileDecodeError("tile is not an object");

  const tile = parsed as Partial<Tile>;
  const header = tile.header;
  if (!header || typeof header !== "object")
    throw new TileDecodeError("tile has no header");
  if (header.v !== TILE_FORMAT_VERSION) {
    throw new TileDecodeError(
      `tile format version ${String(header.v)} is not ${TILE_FORMAT_VERSION} — refusing to ` +
        "read it as if it were. Every field would parse and the prices could be wrong.",
    );
  }
  if (!Array.isArray(tile.bars))
    throw new TileDecodeError("tile has no bars array");
  const sources = Array.isArray(tile.sources) ? tile.sources : [];
  if (sources.length !== tile.bars.length) {
    throw new TileDecodeError(
      `tile has ${tile.bars.length} bars but ${sources.length} sources — a short ` +
        "parallel array does not fail, it mis-attributes every bar after the gap",
    );
  }
  return {
    header: header as TileHeader,
    bars: tile.bars as TileBar[],
    sources: sources as BarSource[],
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   The manifest, and the decision to rebuild
   ──────────────────────────────────────────────────────────────────────── */

/** Where a tile's bars came from. The manifest records it PER TILE. */
export type TileBuiltFrom = "dailyprice" | "gold" | "candles";

export interface ManifestEntry {
  /** CLOSED years for which a year tile exists. */
  years: number[];
  five_y_built_at: string;
  adjustment_policy_version: number;
  tile_format_version: number;
  /** ISO date of the newest bar the SOURCE held when this was built. */
  source_max_date: string | null;
  built_from: TileBuiltFrom;
  /**
   * A fingerprint of the corporate actions the tile was built with.
   *
   * The ACTIONS are part of a tile's identity, not just the bars. A new split
   * re-bases every bar BEFORE its ex-date — which is mostly deep history, i.e.
   * the YEAR tiles — so comparing only `source_max_date` rebuilds the 5y tile
   * on the new basis and leaves the year tiles on the old one. The chart then
   * shows a step discontinuity exactly at the five-year boundary, on a real
   * price series, with nothing reporting an error.
   */
  actions_fingerprint?: string;
  /**
   * How many sessions in the 5y window came from YAHOO rather than the
   * exchange file.
   *
   * A RISING number is a `bhavcopy-sync` defect, not a tile defect —
   * `yahoo-price-service` only gap-fills what bhavcopy did not deliver. It is
   * recorded per listing so the job can emit it as a metric; a platform-wide
   * total would hide a single instrument going dark.
   */
  yahoo_fill_sessions: number;
}

export type TileManifest = Record<string, ManifestEntry>;

/**
 * Should this listing be rebuilt?
 *
 * SIX reasons, and they are six because collapsing them loses the ability to
 * say why a nightly run did work:
 *
 *   no-entry            never built
 *   source-advanced     the source has a newer bar than the tile was built from
 *   policy-changed      the ADJUSTMENT policy moved — the tile decodes
 *                       perfectly and its prices are on the old basis
 *   format-changed      the tile FORMAT moved — the reader would refuse it
 *   actions-changed     a corporate action landed — every bar before its
 *                       ex-date is on a stale basis, and most of those live in
 *                       the YEAR tiles
 *   source-changed      the tile was built from a DIFFERENT producer than this
 *                       run reads from
 *
 * The default is REBUILD. An unrecognised state must not read as "up to date":
 * a skip is invisible, and a listing silently skipped every night is a chart
 * frozen at whatever day the last successful build happened on.
 *
 * ## WHY `source-changed` EXISTS — MONEY-1506
 *
 * B4 moves the US bars from `CandleRepository` to `gold.adjusted_bar_d1`, and
 * the manifest already records which one a tile came from (`built_from`). Left
 * out of this decision, the switch would take effect for the 5-year tile alone
 * — that one rebuilds nightly anyway because `source_max_date` advances — while
 * every CLOSED YEAR tile kept the old producer's numbers for ever, because a
 * closed year is written once. The chart would then step at exactly the
 * five-year boundary wherever the two producers disagree, which is precisely
 * the disagreement the switch exists to settle.
 *
 * COMPARED ONLY WHEN THE CALLER STATES ONE, like `actionsFingerprint` above: an
 * entry written before this existed must not be rebuilt on every run for ever.
 */
export function rebuildReason(
  entry: ManifestEntry | undefined,
  now: {
    sourceMaxDate: Date | null;
    policyVersion: number;
    formatVersion: number;
    actionsFingerprint?: string;
    builtFrom?: TileBuiltFrom;
  },
):
  | "no-entry"
  | "source-advanced"
  | "policy-changed"
  | "format-changed"
  | "actions-changed"
  | "source-changed"
  | null {
  if (!entry) return "no-entry";
  if (entry.tile_format_version !== now.formatVersion) return "format-changed";
  if (now.builtFrom !== undefined && entry.built_from !== now.builtFrom) {
    return "source-changed";
  }
  if (entry.adjustment_policy_version !== now.policyVersion)
    return "policy-changed";
  // A NEW corporate action re-bases every bar BEFORE its ex-date, which is
  // mostly deep history — i.e. the YEAR tiles. Comparing only `source_max_date`
  // rebuilds the 5y tile on the new basis and leaves the year tiles on the old
  // one, so the chart steps at exactly the five-year boundary on a real price
  // series, with nothing reporting an error.
  //
  // Only when BOTH sides have one: an entry written before fingerprints existed
  // must not be rebuilt on every run for ever.
  if (
    now.actionsFingerprint !== undefined &&
    entry.actions_fingerprint !== undefined &&
    entry.actions_fingerprint !== now.actionsFingerprint
  ) {
    return "actions-changed";
  }

  // A source with NO bars cannot advance. Note this is not the same as "the
  // entry has no source_max_date", which means the last build did not record
  // one and must be treated as stale rather than current.
  if (now.sourceMaxDate === null)
    return entry.source_max_date === null ? null : "source-advanced";
  if (entry.source_max_date === null) return "source-advanced";

  const built = Date.parse(entry.source_max_date);
  if (!Number.isFinite(built)) return "source-advanced";
  return now.sourceMaxDate.getTime() > built ? "source-advanced" : null;
}

/** A reason that re-bases CLOSED year tiles, not just the 5y one. */
export function rewritesClosedYears(
  reason: ReturnType<typeof rebuildReason>,
): boolean {
  return (
    reason === "policy-changed" ||
    reason === "format-changed" ||
    reason === "actions-changed" ||
    reason === "source-changed"
  );
}

/**
 * Must this build READ the whole history? — MONEY-1541.
 *
 * A closed year is rewritten only from bars the run READ, and an incremental
 * build reads the 5y window. So `policy-changed` or `actions-changed` rewrote
 * the last five or six year tiles and left every older one on the old basis:
 * SUDARSCHEM's 2014 composition, TORNTPHARM's 2006 cliff and TITAN's 2011
 * bonus would have stayed wrong in exactly the years they touch, with the
 * chart stepping at the boundary. The decision needs no bars — it is the entry
 * against the current identity, with the source-advance question held still.
 */
export function mustReadDeepHistory(
  entry: ManifestEntry | undefined,
  now: {
    policyVersion: number;
    formatVersion: number;
    actionsFingerprint?: string;
    builtFrom?: TileBuiltFrom;
  },
): boolean {
  if (!entry?.years?.length) return true;
  return rewritesClosedYears(
    rebuildReason(entry, {
      ...now,
      sourceMaxDate:
        entry.source_max_date === null ? null : new Date(entry.source_max_date),
    }),
  );
}

/**
 * Stable shard for a listing, for Cloud Run Jobs fan-out.
 *
 * A HASH rather than an index range, for two reasons. It keeps each shard's
 * work roughly equal whatever order the query returns; and it keeps a given
 * listing on the SAME shard between runs, so two shards can never both decide
 * to rebuild it and race the same object.
 *
 * FNV-1a, because it needs to be stable across processes and Node versions —
 * `String.hashCode`-style arithmetic on `Math.imul` is deterministic where
 * anything involving floats is not.
 */
export function shardOf(listingId: string, shardCount: number): number {
  if (!Number.isInteger(shardCount) || shardCount <= 1) return 0;
  let h = 2166136261;
  for (let i = 0; i < listingId.length; i++) {
    h ^= listingId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % shardCount;
}

/**
 * A stable fingerprint of the corporate actions a tile was built with.
 *
 * Order-independent (the actions are sorted first) so a reordered query result
 * does not look like a change, and it carries the RATIO as well as the date —
 * a corrected 1:2 that should have been 1:5 keeps its ex-date and changes every
 * price before it.
 */
/*
 * THIS ONE STAYS ON UTC — MONEY-1527, and it is a deliberate exception.
 *
 * Six other readers of `exDate` were moved to IST because a UTC slice reads
 * the 48,224-row 18:30Z convention a calendar day early. This is not one of
 * them: it is a CHANGE DETECTOR, not a date. Its output is only ever compared
 * against another string from this same function over the same Mongo rows, so
 * a uniform rendering — whichever one — answers "are these the same actions"
 * correctly. The day it names is never shown and never joined to a bar.
 *
 * Changing it would invalidate every cached India tile and force a full
 * rebuild, for no correctness gain. Do not.
 *
 * The rule to carry away: render in IST when the day is a FACT (a label, a
 * join key against a bar, an exclusion set); leave it alone when the string is
 * only an identity compared with itself.
 */
export function fingerprintActions(
  actions: readonly Pick<
    AdjustingAction,
    "exDate" | "type" | "ratio" | "source" | "details"
  >[],
): string {
  if (actions.length === 0) return "none";
  // SOURCE and the OBSERVED gap too — MONEY-1541. Both now move the adjustment
  // (a DERIVED row is weighed against the feed's filings; a CAPITAL_ADJUSTMENT
  // divides by its observed gap), and a detector re-run rewrites
  // `details.observedRatio` on the SAME row, which a date/type/ratio string
  // cannot see.
  const parts = actions
    .map((a) => {
      const observed = (a.details as { observedRatio?: unknown } | null)
        ?.observedRatio;
      return `${a.exDate.toISOString().slice(0, 10)}:${a.type ?? "?"}:${a.ratio ?? "?"}:${a.source ?? "?"}:${typeof observed === "number" ? observed : "?"}`;
    })
    .sort();
  // FNV-1a over the joined parts — short, stable across processes, and enough
  // to tell "these are the same actions" from "these are not".
  let h = 2166136261;
  const joined = parts.join("|");
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${parts.length}-${(h >>> 0).toString(16)}`;
}

/**
 * Why a completed run should be REFUSED rather than reported as success.
 * MONEY-1479. Returns null when the run is legitimate.
 *
 * This is the state that hid `tile-build-d1-us` for weeks: OOM-killed every
 * night before the first write, zero objects, and an execution carrying a
 * completionTime that read as finished. The existing `counters.failed > 0`
 * exit cannot see it — a job that dies before building anything has nothing to
 * count as failed.
 *
 * PURE, and it lives HERE rather than in the job: a `packages/core` test
 * cannot import a script without dragging `prisma` in at module scope, and a
 * guard that cannot be imported ends up asserted only by a source scan.
 */
export function zeroWriteRefusal(r: {
  apply: boolean;
  walked: number;
  built: number;
  builtEmpty: number;
  skipped: number;
  /**
   * The WHOLE run's population, before sharding. Optional so an existing caller
   * keeps working; when given, it is what decides whether an empty walk is
   * healthy.
   */
  population?: number;
}): string | null {
  // A dry run legitimately writes nothing.
  if (!r.apply) return null;

  // AN EMPTY SHARD IS FINE. AN EMPTY POPULATION IS THE FAULT THIS EXISTS FOR.
  //
  // `walked` is the POST-SHARD slice, so `walked === 0` is the ordinary state
  // of a leaf whose shard matched nothing (MONEY-1379's lesson from
  // broker-sync). But it is ALSO the state when the selector itself drifts and
  // matches zero rows platform-wide: every shard walks 0, every shard is
  // exempted, every task exits 0, and `tiles/US/` quietly stops being
  // refreshed behind a green dashboard — which is verbatim the failure this
  // guard was written to end, slipping through the guard.
  //
  // So the exemption is narrowed to what it was actually FOR: this shard got
  // none of a population that HAS rows. A caller that reports `population: 0`
  // is refused.
  if (r.population === 0) {
    return (
      "selected ZERO listings for the whole run — not an empty shard, an " +
      "empty POPULATION. Every task would exit 0 and nothing would be " +
      "refreshed, which is the silent-success state this refusal exists to " +
      "end. Check the listing selector before re-running."
    );
  }
  if (r.walked === 0) return null;
  // `builtEmpty` and `skipped` COUNT: a listing with no bars, or one already
  // current, are real decisions the builder made. What must never pass is a
  // shard that walked listings and produced no outcome at all.
  const produced = r.built + r.builtEmpty + r.skipped;
  if (produced > 0) return null;
  return (
    `walked ${r.walked} listing(s) and produced NOTHING — none built, none ` +
    `empty, none skipped as current. A tile builder that writes nothing is ` +
    `never a healthy outcome: this is the state that left tiles/US/ absent ` +
    `for weeks while the job reported success every night.`
  );
}

/**
 * Why a run whose COUNTERS look healthy should still be refused — the tile the
 * manifest claims is built is not in the bucket. MONEY-1479.
 *
 * `zeroWriteRefusal` above asks what the run DID; this asks what the BUCKET
 * HOLDS, and the two cannot substitute for each other. Every counter is
 * in-process bookkeeping, and the dominant steady state is `skipped` — 2,255
 * of 3,492 listings on the 2026-09-22 prod run — which asserts only that a
 * manifest entry says the tile is current. Delete the objects and leave the
 * manifest (they share the `tiles/{market}/d1/` prefix, but nothing writes
 * them together) and every listing is skipped, `zeroWriteRefusal` passes on
 * `skipped > 0`, all four tasks exit 0, and every chart is blank for ever.
 * That is strictly WORSE than the OOM this ticket was filed for, which at
 * least failed the execution.
 *
 * THE INVARIANT IS EXACT, so this has no false-alarm case. A listing is
 * counted `skipped` only via `rebuildReason(...) === null`, which requires a
 * manifest entry; an entry is written only after `store.put` of the 5y key
 * returned; and the no-bars listings that write no tile return EARLIER, at
 * `skippedNoBars`, without an entry. So a skipped listing's 5y object must
 * exist.
 *
 * ONE listing, not a sweep: the question is whether the prefix is real, and a
 * per-listing audit would cost 14,258 billed GETs a night to answer it 14,258
 * times over.
 *
 * `failed` REFUSES, matching `loadManifest` one file over — "cannot read" is
 * not "absent", and a read that cannot answer must not be recorded as an
 * answer. A verification that fails open is the defect it was added to catch.
 */
export function missingTileRefusal(r: {
  apply: boolean;
  /** A listing this run counted `skipped`, or null if it skipped none. */
  listingId: string | null;
  /** The outcome of reading that listing's 5y key back. */
  outcome: "present" | "absent" | "failed";
}): string | null {
  // A dry run writes nothing and reads nothing back.
  if (!r.apply) return null;
  // NOTHING WAS SKIPPED, so there is nothing this check can add: every listing
  // this run touched was written by `store.put`, which throws on failure.
  if (r.listingId === null) return null;
  if (r.outcome === "present") return null;
  if (r.outcome === "failed") {
    return (
      `could not read back the 5y tile for ${r.listingId} to verify the ` +
      `bucket — refusing to record an unanswerable read as a healthy run, ` +
      `for the reason loadManifest refuses an unreadable manifest.`
    );
  }
  return (
    `the manifest says ${r.listingId} is current but its 5y tile is NOT in ` +
    `the bucket. Every counter reports success because the listing was ` +
    `SKIPPED, which asserts only what the manifest says — the objects ` +
    `themselves are gone. Charts are blank and no nightly run will rebuild ` +
    `them: a skipped listing is never re-put.`
  );
}
