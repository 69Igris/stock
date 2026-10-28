/**
 * Pure decisions for the silver bar loaders — MONEY-1496 (B2) + MONEY-1497
 * (B2-IN).
 *
 * No BigQuery, no GCS, no Mongo, no clock. Everything here is a function of its
 * arguments, so the traps below can be tested without provisioning anything.
 *
 * ## ONE MODULE, TWO MARKETS
 *
 * US bars come from Tiingo (Mongo hot rows + GCS cold shards); India bars come
 * from the archived exchange files through `feed-parse`. They share this module
 * because they share the TABLE — `market` is a column, never a second dataset —
 * and two loaders computing partition keys differently would write rows that
 * cannot be pruned by one query.
 */

import { createHash } from "node:crypto";

/** The markets `price_bar_d1` holds. Closed: an unknown market is a bug. */
export const BAR_MARKETS = ["US", "IN"] as const;
export type BarMarket = (typeof BAR_MARKETS)[number];

/** The composite separator, matching `ledger-logic.ts`'s reasoning. */
const NUL = "\u0000";

/**
 * Bump when the mapping below changes in a way that alters stored VALUES.
 *
 * It is part of the ledger's five-part identity, so bumping it makes every
 * partition re-loadable without deleting anything: the new
 * (dataset, table, key, hash, parser_version) tuple simply has no ACCEPTED row
 * yet. That is why the version belongs in the key rather than in a comment.
 *
 * Only the US replay stamps it (India stamps its own `indiaParserVersion`,
 * currently `in-bhavcopy-v2`, so a bump here never reloads India).
 *   v2  MONEY-1616 — the `LATEST_OCCUPANT` arm admits rows v1 quarantined, over
 *       unchanged bytes, so every US month must reload.
 */
export const PRICE_BAR_PARSER_VERSION = "price-bar-v2";

/**
 * The partition key for one month of one market.
 *
 * `price_bar_d1` is PARTITION BY DATE_TRUNC(session_date, MONTH), so the ledger
 * key must be the MONTH too. A per-day key would claim ~21 partitions for what
 * BigQuery stores as one, and `claimPartition` would then report ACCEPTED for a
 * month that is 1/21 loaded.
 *
 * MARKET IS IN THE KEY. Both markets write this table, and a bare `2024-03`
 * would let the US loader's ACCEPTED row make the India loader skip a month it
 * has never touched — the two would silently share one claim.
 */
export function priceBarPartitionKey(
  market: BarMarket,
  sessionDate: string,
): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(sessionDate);
  if (!m) {
    throw new Error(
      `session_date must be YYYY-MM-DD, got ${JSON.stringify(sessionDate)} — ` +
        `a malformed date produces a partition key that never matches the one ` +
        `the next run computes, so every run reloads it`,
    );
  }
  return `${market}/${m[1]}-${m[2]}`;
}

/**
 * The source hash: what this partition was built FROM.
 *
 * Per the B2 spec — sha256 over the cold-shard GCS generations plus the hot
 * window's max ts. Both halves are load-bearing:
 *
 * - GENERATIONS, not object names. A shard rewritten in place keeps its name
 *   and changes its generation; hashing names would make a corrected shard
 *   invisible to the ledger, and the partition would never reload.
 * - The HOT max ts, because the newest sessions live in Mongo and are in no
 *   shard at all. Without it, today's bar lands in a partition whose hash is
 *   unchanged since yesterday, `claimPartition` says skip, and the day is
 *   never written.
 *
 * Inputs are SORTED before hashing: GCS listing order and Mongo cursor order
 * are both incidental, and an unsorted hash would differ run-to-run over
 * identical bytes — turning every claim into a reload.
 */
export function priceBarSourceHash(args: {
  shardGenerations: readonly string[];
  hotMaxTsMs: number | null;
}): string {
  const gens = [...args.shardGenerations].sort();
  const hot = args.hotMaxTsMs === null ? "none" : String(args.hotMaxTsMs);
  return createHash("sha256")
    .update(gens.join(NUL))
    .update(`${NUL}hot=`)
    .update(hot)
    .digest("hex");
}

/** A bar as the loaders hand it over, before provenance is attached. */
export interface RawBar {
  market: BarMarket;
  listingId: string;
  symbol: string;
  exchange: string;
  /** `YYYY-MM-DD`, the VENUE's session day. */
  sessionDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /**
   * May be bigint. No real security exceeds 2^53 shares in a day, but the cold
   * shards decode INT64 as bigint and `CandleWriteRow` already accepts
   * `number | bigint`, so refusing one here would drop real rows.
   */
  volume: number | bigint | null;
  divCash?: number | null;
  splitFactor?: number | null;
  source: string;
  resolutionMethod?: string | null;
}

/** Provenance every silver row carries. lake-layout.md §5 — all six, always. */
export interface RowProvenance {
  sourceObjectUri: string;
  sourceRecordKey: string;
  pipelineRunId: string;
  /** When the SOURCE asserted it. */
  observedAtMs: number;
  /** When WE wrote it. */
  ingestedAtMs: number;
  /**
   * Which parser wrote the row. Defaults to {@link PRICE_BAR_PARSER_VERSION}.
   *
   * MONEY-1497. `toPriceBarRow` stamped that constant UNCONDITIONALLY, and
   * `price_bar_d1` holds two markets fed by two entirely different parsers —
   * Tiingo cold shards for US, the bhavcopy parsers for India. One string
   * across both is wrong in both directions: a US parser fix would appear to
   * have covered India, and an India fix could not bump the version without
   * making every US partition re-loadable. `parser_version` is in the ledger's
   * five-part key precisely so a fix can re-run over unchanged bytes, so a
   * shared value costs that mechanism for whichever market did not change.
   *
   * Optional, so B2's US call sites are unchanged.
   */
  parserVersion?: string;
}

export interface PriceBarRow {
  market: string;
  listing_id: string;
  symbol: string;
  exchange: string;
  session_date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: string | null;
  div_cash: number | null;
  split_factor: number | null;
  source: string;
  resolution_method: string | null;
  source_object_uri: string;
  source_record_key: string;
  parser_version: string;
  pipeline_run_id: string;
  observed_at: string;
  ingested_at: string;
}

/** `null` for anything not finite. See `toPriceBarRow`. */
function finite(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * `null` for anything not finite, ROUNDED to a BigQuery `NUMERIC(_, scale)`
 * column's scale. Every NUMERIC column in the lake is scale 6 except
 * `delivery_pct`, which is scale 4 and must pass it explicitly.
 *
 * ## WHY THIS IS NOT `finite()` (MONEY-1512)
 *
 * BigQuery REFUSES a NUMERIC value carrying more decimal places than the column
 * declares, and our JSON load path runs with `max bad: 0` — so ONE row out of
 * 21,763 fails the whole load job. `derivatives_eod_in` could not load a single
 * row, for any window, from the day it shipped: `value_lakh` is
 * `TtlTrfVal / 100_000`, the source carries paise, so the quotient already needs
 * SEVEN decimals before IEEE-754 adds its own — `15029.864596500001`.
 *
 * It is armed on every quotient the lake stores, not just that one.
 * `split_factor` for a 1-for-3 split is `0.3333333333333333`, sixteen places,
 * and would have broken the US replay identically. So the rounding belongs at
 * the ONE row boundary they all pass through, never at each producer — a rule
 * stated twice is a rule that can disagree with itself.
 *
 * `toFixed` rounds in DECIMAL-STRING space, which is the point.
 * `Math.round(v * 10 ** scale) / 10 ** scale` is NOT a safe substitute:
 * `NUMERIC(18, 6)` admits twelve integer digits, and `1e12 * 1e6` is past
 * `Number.MAX_SAFE_INTEGER`, so the multiply loses the precision the round was
 * supposed to protect.
 *
 * INT64 COUNTS MUST NOT COME THROUGH HERE — they go through
 * `volumeToInt64String`, because a count above 2^53 cannot survive a JS number.
 */
export function numeric(
  n: number | null | undefined,
  scale = 6,
): number | null {
  const v = finite(n);
  return v === null ? null : Number(v.toFixed(scale));
}

/**
 * Map one bar onto its silver row.
 *
 * ## Non-finite prices become NULL, never 0
 *
 * A NaN close written as 0 is a bar that renders, charts and back-adjusts — it
 * produces a -100% return on the day before and a +infinite one on the day
 * after. NULL is queryable as "we do not have this" and cannot be mistaken for
 * a price. `sanitizeCandleWrites` makes the same call and COUNTS it; the loader
 * counts these too, so a feed emitting garbage stays visible.
 *
 * ## Volume is a STRING
 *
 * BigQuery INT64 over the JSON load path is written as a string. A JS number
 * loses precision above 2^53, and `bigint` does not survive `JSON.stringify`
 * at all — it THROWS. The decimal string is the only form that round-trips
 * both.
 */
export function toPriceBarRow(bar: RawBar, prov: RowProvenance): PriceBarRow {
  return {
    market: bar.market,
    listing_id: bar.listingId,
    symbol: bar.symbol,
    exchange: bar.exchange,
    session_date: bar.sessionDate,
    open: numeric(bar.open),
    high: numeric(bar.high),
    low: numeric(bar.low),
    close: numeric(bar.close),
    volume: volumeToInt64String(bar.volume),
    div_cash: numeric(bar.divCash),
    split_factor: numeric(bar.splitFactor),
    source: bar.source,
    resolution_method: bar.resolutionMethod ?? null,
    source_object_uri: prov.sourceObjectUri,
    source_record_key: prov.sourceRecordKey,
    parser_version: prov.parserVersion ?? PRICE_BAR_PARSER_VERSION,
    pipeline_run_id: prov.pipelineRunId,
    observed_at: new Date(prov.observedAtMs).toISOString(),
    ingested_at: new Date(prov.ingestedAtMs).toISOString(),
  };
}

/** Exported for its own test — the bigint path is the one that throws. */
export function volumeToInt64String(
  volume: number | bigint | null | undefined,
): string | null {
  if (volume === null || volume === undefined) return null;
  if (typeof volume === "bigint") return volume.toString();
  if (!Number.isFinite(volume)) return null;
  return Math.trunc(volume).toString();
}

/**
 * Group bars by the partition they belong to.
 *
 * A Map so the loader can claim, stage and accept ONE partition at a time.
 * Loading a listing's whole history as one unit would let a single bad month
 * reject a decade.
 */
export function groupBarsByPartition(
  bars: readonly RawBar[],
): Map<string, RawBar[]> {
  const out = new Map<string, RawBar[]>();
  for (const bar of bars) {
    const key = priceBarPartitionKey(bar.market, bar.sessionDate);
    const list = out.get(key);
    if (list) list.push(bar);
    else out.set(key, [bar]);
  }
  return out;
}

/**
 * Which cold-shard YEARS to read for one listing.
 *
 * ## The whole point: we never list, so the years must be COMPUTED
 *
 * `listFiles` fails open to `[]` — an empty listing is indistinguishable from
 * "no objects", so a loader driven by one silently loads nothing and reports
 * success. Every cold key is therefore built from
 * `buildCandleColdKey({market, timeframe, symbol, year})` and fetched; a `null`
 * body is a real absence, not an ambiguous one.
 *
 * That makes the YEAR RANGE the only thing standing between us and either
 * missing history or spending tens of thousands of pointless GETs.
 *
 * ## Both ends are inclusive and both are clamped
 *
 * `firstYear` is the listing's start year — earlier years cannot exist, and
 * Tiingo history floors at 1962 regardless of what a bad row claims.
 * `lastYear` is the listing's end year for a delisted security and the current
 * year otherwise, because a delisted listing has no shards after it stopped
 * trading.
 *
 * ## The hot window is NOT subtracted
 *
 * It is tempting to skip the last `hotWindowYears` because those rows are in
 * Mongo. They are — but the shard for the CURRENT year also exists once
 * `candle-evict` has archived part of it, and the hot window is a rolling
 * boundary that moves under a long replay. Reading both and de-duplicating on
 * (listing, session_date) costs a few GETs; guessing the boundary drops
 * whichever side of it moved.
 */
export function planShardYears(args: {
  listingStartYear: number;
  listingEndYear: number | null;
  currentYear: number;
  /** Tiingo's history floor. Nothing exists before this. */
  floorYear?: number;
}): number[] {
  const floor = args.floorYear ?? 1962;
  const first = Math.max(args.listingStartYear, floor);
  const last = Math.min(
    args.listingEndYear ?? args.currentYear,
    args.currentYear,
  );
  if (!Number.isInteger(first) || !Number.isInteger(last)) {
    throw new Error(
      `planShardYears needs integer years, got first=${first} last=${last}`,
    );
  }
  // NO `if (last < first) return []` HERE. There was one; mutation testing
  // could not kill it, because the loop below already yields [] for a reversed
  // range — its condition is false on the first evaluation. A guard no
  // mutation can kill reads as coverage and protects nothing, so it is gone
  // rather than kept with a test that cannot fail. The reversed-range CASE is
  // still tested; it is now enforced by the loop instead of by a line above it.
  const out: number[] = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}
