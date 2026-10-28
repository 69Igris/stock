/**
 * Pure, side-effect-free logic for the candle store — MONEY-980, TASK 4.
 *
 * Zero I/O by construction: no Prisma, no GCS, no `fetch`, no timers, no
 * streams. Everything here is arithmetic over plain objects and strings, so its
 * unit test cannot orphan a handle and cannot need a database. The two modules
 * that DO perform I/O (`candle-cold-store.ts`, `candle-repository.ts`) import
 * their decisions from here rather than restating them — the "one rule, stated
 * twice, disagreeing" defect (MONEY-1255) is the single most expensive class in
 * this repo's history and every restatement is a fresh instance of it.
 *
 * The one apparent exception is {@link encodeColdShard} / {@link decodeColdShard},
 * which import `node:zlib`. That is deliberate and it is still I/O-free: the
 * `*Sync` entry points are pure CPU over a Buffer and allocate NO handle, NO
 * file descriptor and NO libuv work item — unlike `zlib.createGzip()`, which is
 * a stream and would keep the event loop alive. Round-tripping the shard format
 * is the highest-value test in this file, so it belongs where a test can reach
 * it without GCP.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import {
  computeAdjustedSeries,
  TIINGO_US_EXCHANGES,
  type AdjustedBar,
  type TiingoEodBar,
} from "../tiingo/tiingo-logic";
import { shouldUpgradePriceSource } from "../price-source-authority";

/* ─────────────────────────────────────────────────────────────────────────
   Types
   ──────────────────────────────────────────────────────────────────────── */

/**
 * One stored bar, as every reader sees it.
 *
 * `volume` is a `number` here while the column is a Prisma `BigInt`, and that
 * narrowing is safe with a wide margin rather than by luck: the largest single
 * -session US composite volume ever printed is ~10^10 shares, and `Number` is
 * exact to 2^53 ≈ 9.0 × 10^15 — five orders of magnitude of headroom. The
 * column is BigInt because it must survive Int32 (2.1 × 10^9), which composite
 * volume clears routinely; it does not need to survive 2^53, which no equity
 * ever will. Handing callers a `bigint` instead would poison every downstream
 * average and chart library with `TypeError: Cannot mix BigInt and other
 * types`, so the conversion happens once, here, at the store boundary.
 */
export interface CandleBar {
  symbol: string;
  exchange: string;
  timeframe: string;
  /** Bar OPEN, UTC. For D1 this is UTC midnight of the session. */
  ts: Date;
  listingId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Adjustment INPUTS, stored raw — see {@link adjustCandleSeries}. */
  divCash: number;
  splitFactor: number;
  source: string;
}

/** A bar carrying the back-adjusted series computed at read time. */
export interface AdjustedCandleBar extends CandleBar {
  adjOpen: number;
  adjHigh: number;
  adjLow: number;
  adjClose: number;
  adjVolume: number;
}

/**
 * A bar as a WRITER hands it in.
 *
 * `volume` accepts `number | bigint` because the two upstreams disagree: the
 * Tiingo CSV parser produces a `number`, while a row read back out of Prisma
 * produces a `bigint`. Normalising at the door (see {@link sanitizeCandleWrites})
 * means neither caller has to know, and neither can accidentally feed a `bigint`
 * into arithmetic that also touches a `number`.
 */
export interface CandleWriteRow {
  symbol: string;
  exchange: string;
  timeframe: string;
  ts: Date;
  listingId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | bigint;
  divCash?: number;
  splitFactor?: number;
  /** Defaults to `TIINGO` — the value the column itself defaults to. */
  source?: string;
  /**
   * `ACTIVE` | `DELISTED` — the LISTING's status, not the bar's.
   *
   * Half of the hot/cold routing rule (see {@link resolveCandleDestination}),
   * and the half a caller has to supply because a bar does not carry it.
   * Absent or empty means ACTIVE, which is the right default for the nightly
   * (it only ever walks active listings) and is nearly free of consequence for
   * anyone else: a delisted listing's bars are all older than the window by
   * definition, so the YEAR test routes them cold on its own.
   *
   * The BACKFILL is the exception and must set it. It is the only writer whose
   * batch contains recent-year bars for securities that are no longer trading,
   * and omitting it there is what would put all ~10,287 delisted issues in
   * Mongo — the outcome the hot/cold split exists to prevent.
   */
  listingStatus?: string | null;
  /**
   * Force the storage tier instead of deriving it.
   *
   * ONE legitimate use: `LOADED`, the on-request write-back of a cold year into
   * Mongo. That is the single case the data cannot decide — the bar's year and
   * the listing's status both say "cold", and what makes it hot is a fact
   * outside the row entirely (somebody asked for it).
   *
   * Do NOT pass `WINDOW`. It is what the routing already computes for exactly
   * the rows it belongs to, and hardcoding it at a call site turns a rule into
   * a flag somebody has to remember — which is how the cold tier stayed unused
   * on this branch in the first place.
   */
  tier?: CandleTier;
}

/** A write row with every field resolved and every value proven finite. */
export interface NormalizedCandleWrite {
  symbol: string;
  exchange: string;
  timeframe: string;
  ts: Date;
  listingId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  divCash: number;
  splitFactor: number;
  source: string;
  /** Resolved: `ACTIVE` unless the writer said otherwise. */
  listingStatus: string;
  /** The caller's explicit override, or `null` for "derive it". */
  tier: CandleTier | null;
}

/* ─────────────────────────────────────────────────────────────────────────
   Identity + keys
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The row's natural key, matching `@@unique([symbol, exchange, timeframe, ts])`.
 *
 * `ts.getTime()` rather than `toISOString()` on purpose: two `Date`s for the
 * same instant can serialise differently if one carries sub-millisecond drift
 * from a parse, and a key that disagrees with the database's unique index turns
 * an idempotent write into a duplicate-key throw that aborts a whole
 * `createMany`.
 *
 * The separator is NUL (`\u0000`) rather than `:` or `|`, because a separator a
 * FIELD can contain is not a separator: `listingId` is itself `{symbol}:{exchange}:{date}`
 * and exchange names carry spaces (`NYSE ARCA`), so a printable delimiter makes
 * two different tuples collide onto one key. Nothing in a ticker, an exchange
 * name or a timeframe can be a NUL.
 */
export function candleKey(row: {
  symbol: string;
  exchange: string;
  timeframe: string;
  ts: Date;
}): string {
  return `${row.symbol}\u0000${row.exchange}\u0000${row.timeframe}\u0000${row.ts.getTime()}`;
}

/**
 * Which market a listing belongs to.
 *
 * Derived from the exchange rather than stored on the candle row, and derived
 * from `TIINGO_US_EXCHANGES` rather than from a private copy of that list: a
 * second spelling of "which venues are American" is exactly how the sector
 * taxonomy ended up with two answers (MONEY-1093). Anything not in the US set
 * is India, because those are the only two markets this table serves; a third
 * market must widen this function deliberately rather than fall through.
 */
export function marketForExchange(exchange: string): string {
  return TIINGO_US_EXCHANGES.has(exchange) ? "US" : "IN";
}

/**
 * Object key for one cold shard: `candles/{market}/{timeframe}/{symbol}/{year}`.
 *
 * ## Why the exchange is NOT in the key
 *
 * A shard is "everything we hold for this TICKER, in this timeframe, in this
 * year" — across every exchange it traded on. That looks like an ambiguity and
 * is in fact the safer arrangement, for two measured reasons:
 *
 *   - 928 tickers in Tiingo's master appear on more than one exchange, and US
 *     uplisting (NASDAQ -> NYSE, or off AMEX) is routine. With the exchange in
 *     the key, one security's history would SPLIT across two object trees at
 *     the moment it uplisted, and a reader asking under the new exchange would
 *     silently get a truncated series. With it out, the shard follows the
 *     security.
 *   - Every JSONL row carries its own `exchange` AND `listingId`, so the reader
 *     filters precisely. Disambiguation lives on the row, where it is checkable,
 *     not in the key, where it is only implied.
 *
 * ## Why there is NO file extension
 *
 * The on-disk format is an implementation detail this seam exists to hide (see
 * the module note on {@link encodeColdShard}). Spelling `.jsonl.gz` into the key
 * would bake today's format into the ADDRESS, so a later move to parquet would
 * have to rewrite ~231,825 object names — and `buildFeedArchiveKey`'s frozen-
 * grammar note is the standing record of how expensive a key-grammar change
 * becomes once objects exist. The format is carried by the object's magic bytes
 * instead, which {@link sniffColdShardFormat} reads, so a parquet writer can
 * publish to the SAME key and every reader keeps working.
 */
export function buildCandleColdKey(args: {
  market: string;
  timeframe: string;
  symbol: string;
  year: number;
}): string {
  const { market, timeframe, symbol, year } = args;
  if (!Number.isInteger(year)) {
    throw new Error(`buildCandleColdKey: year must be an integer, got ${year}`);
  }
  return [
    "candles",
    keySegment("market", market),
    keySegment("timeframe", timeframe),
    keySegment("symbol", symbol),
    String(year),
  ].join("/");
}

/**
 * Reject anything that would silently RESHAPE the key hierarchy.
 *
 * A `/` in a symbol does not error at any layer — GCS treats the whole key as
 * an opaque string with `/` as a display convention — it just files the object
 * one level deeper, where the reader that computed the same key would still
 * find it and a `list` over the prefix would not. Tiingo tickers use dashes
 * rather than periods or slashes (`BRK-A`, `SPG-P-J`), so this should never
 * fire; it exists because the failure it prevents is invisible.
 */
function keySegment(field: string, value: string): string {
  // The class is `/` plus C0/DEL control characters ONLY. A dash must NOT be
  // in it: Tiingo spells share classes and preferreds with dashes rather than
  // periods (`BRK-A`, `SPG-P-J`), so a rule that rejected `-` would refuse a
  // cold key for several thousand perfectly ordinary securities.
  // `typeof` first, and not merely for tidiness: an `undefined` reaching here
  // fails BOTH of the other arms — `undefined === ""` is false, and
  // `RegExp.test` stringifies its argument to "undefined", which matches
  // nothing — so it returned unchanged and `join("/")` rendered it as an empty
  // segment. `candles//D1/AAPL/2019` is a perfectly valid GCS key that no
  // reader computes and no prefix lists, which is the invisible reshape this
  // function exists to stop. TypeScript rejects the call, but a `as` cast, a
  // JS caller, or a widened object literal does not.
  // eslint-disable-next-line no-control-regex
  if (
    typeof value !== "string" ||
    value === "" ||
    /[/\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new Error(
      `buildCandleColdKey: ${field} "${value}" is empty or contains a path separator / control character`,
    );
  }
  return value;
}

/**
 * The UTC years a `[from, to]` range touches, ascending.
 *
 * UTC and not IST: `Candle.ts` is a UTC instant by definition, and a shard whose
 * boundary is computed in a different zone than the rows it holds puts December
 * 31st in two places. `buildFeedArchiveKey` had the mirror-image version of this
 * bug and its fix was the same — pick ONE calendar and use it on both sides.
 */
export function coldYearsForRange(from: Date, to: Date): number[] {
  const first = from.getUTCFullYear();
  const last = to.getUTCFullYear();
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
    return [];
  }
  const out: number[] = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   Tier routing — which STORE a bar belongs in
   ──────────────────────────────────────────────────────────────────────── */

/**
 * How many years back the Mongo hot window reaches.
 *
 * ## Why 10, and why the number is load-bearing rather than a knob
 *
 * Measured against Tiingo's master on 2026-08-28: 72,685 primary US listings
 * spanning 231,825 symbol-years back to 1962. A 10-year window over the
 * EQUITY + ETF population (23,271 listings) is ~33.8M daily rows, which Atlas
 * carries. The same window WITH the 49,414 mutual funds is 105.9M rows — 72% of
 * it funds — which it does not, and that measurement is why fund NAVs left this
 * table entirely for `UsFundNav` rather than being window-tuned around.
 *
 * The window is a rolling one anchored on the CURRENT year, so it moves once a
 * year and moves for every symbol at the same instant. That is the property the
 * eviction job needs and the reason the clock is injected everywhere below: a
 * boundary computed from a hidden `new Date()` is a boundary no test can stand
 * on either side of.
 */
export const HOT_WINDOW_YEARS = 10;

/**
 * The timeframes the YEAR rule must NEVER be applied to — MONEY-1373.
 *
 * ## Why an intraday bar cannot be routed by its year
 *
 * {@link HOT_WINDOW_YEARS} is right for D1 and catastrophic for M1, and the
 * difference is three orders of magnitude rather than a matter of taste. A D1
 * symbol-year is ~252 rows, which is why a 10-year window over 23,271 listings
 * is the ~33.8M rows Atlas already carries. An M1 symbol-year is ~960 bars a
 * session x ~252 sessions = ~242,000 rows. Apply the year rule unchanged to the
 * Databento intraday feed (3.4 years, ~510 symbols) and every one of those bars
 * passes `barYear >= floor` — ~1.2 BILLION rows routed into Mongo, silently,
 * because nothing in the rule can tell a minute from a day.
 *
 * The literals are the ones `Candle.timeframe` itself declares ("D1 today.
 * M1 | M5 | M15 | H1 | W1 reserved"), plus `S1`: a second bar is unambiguously
 * intraday, and naming a timeframe that never arrives costs nothing while
 * omitting one that does hands it back to the year rule.
 *
 * `W1` is deliberately NOT here. A weekly bar is ~52 rows a year — SPARSER than
 * D1, not denser — so it belongs on the year rule with everything else, and
 * putting it in this set would evict two years of weekly history for no reason.
 */
export const INTRADAY_TIMEFRAMES: ReadonlySet<string> = new Set([
  "S1",
  "M1",
  "M5",
  "M15",
  "H1",
]);

/** True when `timeframe` is one the intraday window governs, not the year rule. */
export function isIntradayTimeframe(
  timeframe: string | null | undefined,
): boolean {
  return typeof timeframe === "string" && INTRADAY_TIMEFRAMES.has(timeframe);
}

/**
 * How far back the intraday hot window reaches. DAYS, not years — MONEY-1373.
 *
 * ## Why 45, in two halves
 *
 * **(a) It is the append job's SELF-HEAL HORIZON.** The intraday append
 * re-fetches a trailing window, so a leg that went dark for a month comes back
 * and re-writes bars that are still INSIDE this window — where a displacement
 * is a Mongo `deleteMany` plus an insert. Outside it, the same repair is a cold
 * shard READ-MODIFY-WRITE: GET the object, `mergeColdBars`, PUT it back, on a
 * key the eviction job may be rewriting in the same minute. A window shorter
 * than the longest outage we expect to survive converts every catch-up into the
 * expensive, racy path, and it does so exactly when the system is already
 * unwell.
 *
 * **(b) It BOUNDS the hot store**, which is the entire reason the split exists:
 *
 *       507 symbols x 45 sessions x ~960 M1 bars/session  =  ~21.9M rows
 *       ~3 GB, against the ~33.8M D1 rows `candles` already holds.
 *
 * So the intraday feed roughly DOUBLES the hot store rather than multiplying
 * it. (45 calendar days is ~31 trading sessions; the arithmetic is deliberately
 * run at 45 SESSIONS so the figure is a ceiling and not an estimate.) At the
 * year rule's 10 years the same symbols come to ~1.2 billion rows.
 *
 * Expressed against the CLOCK rather than a calendar edge, and that is the
 * difference from {@link hotWindowFloorYear}: the year window rolls once a year
 * for every symbol at the same instant, which is what makes `WINDOW` eviction a
 * once-a-year event. An intraday window has to roll every single day.
 */
export const INTRADAY_HOT_WINDOW_DAYS = 45;

/**
 * The oldest bar INSTANT the intraday hot window still covers, given a clock.
 *
 * Clock-injected for the same reason every other boundary here is: a `new
 * Date()` read inside makes the one boundary with a whole class of off-by-one
 * bugs behind it testable only from whichever side today happens to be on.
 */
export function intradayHotFloorTs(now: Date): Date {
  return new Date(
    now.getTime() - INTRADAY_HOT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
}

/**
 * How far a split factor must sit from 1 before it counts as a real split.
 *
 * NOT `factor !== 1`, and that is the whole reason this constant exists.
 * Upstream stores split factors as inexact floats — AAPL's 2014 seven-for-one
 * arrives as `7.000007000007001` and UNTY's as `1.09999989` — so an equality
 * test against 1 is wrong against the live data in both directions: it lets
 * float noise through as a "split", and a factor that ought to compare equal
 * to 1 may not.
 *
 * Declared HERE, in core, rather than beside either writer, because there are
 * TWO writers of a sparse `splitFactor`: the nightly leg in
 * `workers/src/processors/us-eod-sync*` and the historical backfill in
 * `scripts/jobs/tiingo-us-backfill.ts`. A threshold spelled twice is the same
 * rule free to drift, and on this column drift is not a rounding difference —
 * `UsFundNav.splitFactor` is SPARSE, so a disagreement about what counts as a
 * split is a disagreement about whether the field exists, and absent means
 * exactly "no split".
 */
export const SPLIT_EPSILON = 1e-9;

/** True when `factor` is far enough from 1 to be a real corporate action. */
export function isRealSplit(factor: number): boolean {
  return Number.isFinite(factor) && Math.abs(factor - 1) > SPLIT_EPSILON;
}

/**
 * `Candle.tier` — which TIER put a row in Mongo. Mirrors the column exactly.
 *
 * `WINDOW` is a rolling-window row, evicted when the window rolls past its
 * year. `LOADED` is a row pulled back out of a cold shard because somebody
 * asked for it, evicted 30 days after `hotLoadedAt`. Two rules that disagree
 * about the same row, which is why the column exists.
 */
export type CandleTier = "WINDOW" | "LOADED";

/**
 * Where one bar is stored. `COLD` is not a tier — a cold bar is not in Mongo at
 * all, so it has no `tier` column to carry.
 */
export type CandleDestination = "HOT_WINDOW" | "HOT_LOADED" | "COLD";

/**
 * The oldest bar YEAR the hot window still covers, given a clock.
 *
 * UTC, matching {@link coldYearsForRange} and `Candle.ts`'s own definition. A
 * boundary computed in a different calendar than the rows it partitions puts
 * December 31st on both sides of itself — `buildFeedArchiveKey` had the
 * mirror-image of that bug.
 */
export function hotWindowFloorYear(now: Date): number {
  return now.getUTCFullYear() - HOT_WINDOW_YEARS;
}

/**
 * Is this listing still trading?
 *
 * Absent / empty is ACTIVE — see {@link CandleWriteRow.listingStatus} for why
 * that default is safe. Anything else is compared POSITIVELY against `ACTIVE`,
 * so an unrecognised status (`SUSPENDED`, a typo, a future value) routes COLD.
 * That is the conservative direction: a cold bar is archived and still readable
 * through `readColdShard`, whereas guessing "active" adds rows to the store
 * whose size is the entire design constraint.
 */
export function isActiveListing(status?: string | null): boolean {
  if (status === undefined || status === null) return true;
  const s = status.trim().toUpperCase();
  if (s === "") return true;
  return s === "ACTIVE";
}

/**
 * WHERE ONE BAR GOES. Pure, clock-injected, and the only statement of the rule.
 *
 *   an explicit `tier: "LOADED"`
 *        -> `HOT_LOADED`   Mongo, `tier: "LOADED"`, `hotLoadedAt` stamped
 *   an INTRADAY timeframe, `ts` within INTRADAY_HOT_WINDOW_DAYS of `now`
 *        -> `HOT_WINDOW`   Mongo, `tier: "WINDOW"`
 *   bar year >= (UTC year of `now` - HOT_WINDOW_YEARS)  AND  listing ACTIVE
 *        -> `HOT_WINDOW`   Mongo, `tier: "WINDOW"`
 *   everything else
 *        -> `COLD`         a GCS shard, and NOT Mongo
 *
 * ## The override is checked FIRST, deliberately
 *
 * `LOADED` exists precisely for a row the data tests all send to cold: a
 * pre-window year, a delisted security, or an intraday bar older than 45 days,
 * that a reader has just pulled back. Checking the data first and the override
 * second would make the override unreachable in every case it is for.
 *
 * `WINDOW` as an override is accepted and means the same as deriving it — it
 * cannot force a pre-window bar into the hot store, because a caller who could
 * do that could refill Mongo with the 200M rows this split removed. The
 * override widens what a caller may ask for by exactly one value.
 *
 * ## The INTRADAY arm, and the two things it deliberately does NOT do
 *
 * Added by MONEY-1373, ahead of Databento writing M1/H1 bars into this same
 * store. See {@link INTRADAY_TIMEFRAMES} for why the year rule cannot be reused
 * (~1.2 billion rows) and {@link INTRADAY_HOT_WINDOW_DAYS} for where 45 comes
 * from.
 *
 *   - **`listingStatus` is NOT consulted on this arm.** That looks like an
 *     omission and is the point: the intraday window is about RECENCY, not
 *     liveness. A security that delisted last week still has 45 days of real
 *     one-minute bars behind it, and they are exactly the bars somebody looks
 *     at when they ask what happened. The year rule's status test exists to
 *     stop ~10,287 delisted issues parking a DECADE of daily history in Mongo;
 *     45 days of an already-bounded feed is not that problem.
 *   - **A non-finite `tsMs` is COLD**, matching the existing non-finite
 *     `barYear` check one line down. Fail-to-cold is the conservative direction
 *     in both places: a cold bar is archived and still readable through
 *     `readColdShard`, while a NaN comparison that fell through to hot would add
 *     rows to the store whose size is the entire design constraint.
 *
 * `timeframe` and `tsMs` are OPTIONAL, and their absence means "use the year
 * rule" — which is D1's behaviour, and therefore exactly what every caller had
 * before this arm existed. `scripts/jobs/tiingo-us-backfill.ts` injects this
 * function as `splitByDestination`'s `destinationOf` under a narrower
 * structural type and is D1-only; making the two required would turn that seam
 * into a compile error over a fact it has no way to supply.
 *
 * ## Why the clock is a parameter
 *
 * The year window rolls on 1 January and the intraday window rolls every day. A
 * `new Date()` read inside this function makes both rollovers — the boundaries
 * with a whole class of off-by-one bugs behind them — untestable except from
 * whichever side today happens to be on.
 */
export function resolveCandleDestination(args: {
  /** The bar's UTC year. Read by the YEAR rule only. */
  barYear: number;
  listingStatus?: string | null;
  tier?: CandleTier | null;
  now: Date;
  /** The bar's timeframe. Absent -> the year rule, which is D1's behaviour. */
  timeframe?: string;
  /** The bar's instant, epoch ms. Read by the INTRADAY arm only. */
  tsMs?: number;
}): CandleDestination {
  if (args.tier === "LOADED") return "HOT_LOADED";
  if (isIntradayTimeframe(args.timeframe)) {
    const tsMs = args.tsMs;
    // `typeof` first, and not merely to satisfy the compiler: `Number.isFinite`
    // is declared over `unknown` and narrows nothing, so without it the
    // comparison below needs a cast — and a cast is exactly how a `string`
    // arriving from a widened object literal or a JS caller would reach `>=`,
    // where `"5" >= 17...` coerces and answers rather than refusing.
    if (typeof tsMs !== "number" || !Number.isFinite(tsMs)) return "COLD";
    return tsMs >= intradayHotFloorTs(args.now).getTime()
      ? "HOT_WINDOW"
      : "COLD";
  }
  if (!Number.isFinite(args.barYear)) return "COLD";
  if (!isActiveListing(args.listingStatus)) return "COLD";
  return args.barYear >= hotWindowFloorYear(args.now) ? "HOT_WINDOW" : "COLD";
}

/** A batch split by destination. Every input row lands in exactly one bucket. */
export interface CandleDestinationPartition {
  /** Mongo, `tier: "WINDOW"`. */
  hotWindow: NormalizedCandleWrite[];
  /** Mongo, `tier: "LOADED"` — the on-request write-back. */
  hotLoaded: NormalizedCandleWrite[];
  /** A GCS shard. NOT Mongo. */
  cold: NormalizedCandleWrite[];
}

/**
 * Route a whole batch, reading the clock ONCE.
 *
 * Once, and not per row, because a batch that straddles midnight on 31
 * December would otherwise send two bars of the same symbol-year to two
 * different stores — half the year in Mongo, half in a shard, and a merged read
 * that looks complete. One `now` for the batch makes that impossible rather
 * than unlikely.
 */
export function partitionCandlesByDestination(
  rows: readonly NormalizedCandleWrite[],
  now: Date,
): CandleDestinationPartition {
  const out: CandleDestinationPartition = {
    hotWindow: [],
    hotLoaded: [],
    cold: [],
  };
  for (const row of rows) {
    const dest = resolveCandleDestination({
      barYear: row.ts.getUTCFullYear(),
      listingStatus: row.listingStatus,
      tier: row.tier,
      // MONEY-1373: a batch reaching here can hold BOTH timeframes, so the two
      // intraday fields are always passed rather than passed when somebody
      // remembers. Omitting them is not a compile error — they are optional so
      // the D1-only backfill seam keeps working — which makes this the one call
      // site where forgetting them would silently route M1 by its YEAR.
      timeframe: row.timeframe,
      tsMs: row.ts.getTime(),
      now,
    });
    if (dest === "HOT_WINDOW") out.hotWindow.push(row);
    else if (dest === "HOT_LOADED") out.hotLoaded.push(row);
    else out.cold.push(row);
  }
  return out;
}

/** One cold object's worth of bars: `candles/{market}/{timeframe}/{symbol}/{year}`. */
export interface ColdShardGroup {
  market: string;
  timeframe: string;
  symbol: string;
  year: number;
  bars: CandleBar[];
}

/**
 * Group cold-destined rows into the shard objects they belong to.
 *
 * The grouping key deliberately OMITS the exchange, matching
 * {@link buildCandleColdKey}: a shard is everything we hold for a ticker in a
 * year across every venue it traded on, and each row carries its own `exchange`
 * and `listingId` so the reader can filter precisely. Grouping by exchange here
 * would write two objects to one key and each would silently overwrite the
 * other.
 *
 * Bars come out ascending by `ts` so an appended shard reads the same as a
 * freshly written one.
 */
export function groupColdShards(
  rows: readonly NormalizedCandleWrite[],
): ColdShardGroup[] {
  const groups = new Map<string, ColdShardGroup>();
  for (const row of rows) {
    const market = marketForExchange(row.exchange);
    const year = row.ts.getUTCFullYear();
    const key = `${market}\u0000${row.timeframe}\u0000${row.symbol}\u0000${year}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        market,
        timeframe: row.timeframe,
        symbol: row.symbol,
        year,
        bars: [],
      };
      groups.set(key, group);
    }
    group.bars.push(toColdBar(row));
  }
  for (const group of groups.values()) {
    group.bars = sortBarsAscending(group.bars);
  }
  return [...groups.values()];
}

/**
 * A normalised write as a shard row.
 *
 * `volume` narrows from `bigint` to `number` here for the same reason
 * `readHot` does it: a shard round-trips through JSON, where a `bigint` throws
 * outright (`Do not know how to serialize a BigInt`). Exact to 2^53 — five
 * orders of magnitude above any equity's composite volume.
 */
export function toColdBar(row: NormalizedCandleWrite): CandleBar {
  return {
    symbol: row.symbol,
    exchange: row.exchange,
    timeframe: row.timeframe,
    ts: row.ts,
    listingId: row.listingId,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: Number(row.volume),
    divCash: row.divCash,
    splitFactor: row.splitFactor,
    source: row.source,
  };
}

/**
 * Union an existing shard with incoming bars. INCOMING WINS on a key collision.
 *
 * ## Why a write has to merge at all
 *
 * A GCS object write is a REPLACE. `writeColdShard` given one month of 2014
 * would otherwise leave the object holding one month of 2014 and nothing else —
 * eleven months deleted, no error, and a chart that simply draws a shorter
 * line. That is the same silent-truncation failure `ColdShardOutcome` splits
 * `failed` from `absent` to prevent, arriving from the write side instead.
 *
 * Incoming wins because the caller has just fetched it; the alternative
 * (existing wins) would make a repair re-run a no-op, which is the one thing a
 * repair must not be. Provenance precedence is NOT applied here — the hot path
 * has `partitionCandleWrites` for that, and a cold shard has no `id` to compare
 * against, so a rule that pretended to rank sources would be a rule with
 * nothing to rank.
 */
export function mergeColdBars(
  existing: readonly CandleBar[],
  incoming: readonly CandleBar[],
): CandleBar[] {
  const byKey = new Map<string, CandleBar>();
  for (const bar of existing) byKey.set(candleKey(bar), bar);
  for (const bar of incoming) byKey.set(candleKey(bar), bar);
  return sortBarsAscending([...byKey.values()]);
}

/* ─────────────────────────────────────────────────────────────────────────
   Cold shard format — gzipped JSONL or parquet, behind the seam
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The formats a cold shard can be read as.
 *
 * `UNKNOWN` is a READ verdict and never a write choice — see
 * {@link ColdShardWriteFormat}. Keeping it in this union is what lets
 * {@link decodeColdShard} refuse unrecognised bytes loudly instead of parsing
 * them as an empty year, which is the MONEY-1189 shape: a completeness check
 * that reports SUCCESS for work that never happened.
 */
export type ColdShardFormat = "JSONL_GZ" | "PARQUET" | "UNKNOWN";

/** The formats a writer may CHOOSE. `UNKNOWN` is not one of them. */
export type ColdShardWriteFormat = Exclude<ColdShardFormat, "UNKNOWN">;

/** Content type for a gzipped-JSONL shard. */
export const CANDLE_COLD_CONTENT_TYPE = "application/gzip";

/**
 * Content type stamped on the object, which is METADATA and never the thing a
 * reader trusts — {@link sniffColdShardFormat} reads the bytes. It matters for
 * the human with `gsutil stat` and for a downstream Python reader that filters
 * a listing, so a parquet shard must not go up labelled `application/gzip`.
 */
export function coldShardContentType(format: ColdShardWriteFormat): string {
  return format === "PARQUET"
    ? "application/vnd.apache.parquet"
    : CANDLE_COLD_CONTENT_TYPE;
}

/**
 * Which format this process WRITES. `CANDLE_COLD_FORMAT=parquet` selects
 * parquet; anything else, unset included, is gzipped JSONL.
 *
 * Read PER CALL through a default parameter, never captured in a module-scope
 * const. A module-level read freezes at import, and on a warm Cloud Run
 * container that turns a redeployed switch into no switch at all — the trap
 * already written down for `TIINGO_PLAN` and `bse-client.ts`'s retry config.
 *
 * Compared against the LITERAL string. `Boolean(process.env.X)` is true for
 * the string "false", which is how a flag arms itself in the one configuration
 * meant to keep it off.
 */
export function resolveColdShardFormat(
  raw: string | undefined = process.env.CANDLE_COLD_FORMAT,
): ColdShardWriteFormat {
  return raw?.trim().toLowerCase() === "parquet" ? "PARQUET" : "JSONL_GZ";
}

/**
 * ## The format decision (MONEY-980 TASK 4, reopened by MONEY-1384 B1)
 *
 * `JSONL_GZ` is still the DEFAULT and still what every shard on GCS holds
 * today. What changed is that parquet stopped being a documented refusal and
 * became a real choice: {@link decodeColdShard} reads BOTH,
 * {@link encodeColdShard} writes either, and {@link resolveColdShardFormat}
 * picks the write side per process.
 *
 * The original note (2026-08-28) framed the honest comparison as "gzipped JSONL
 * today" against "a new runtime dependency, shipped into the Cloud Run workers
 * image and the Vercel bundle, for a store that does not exist yet". Two of
 * those three premises expired. The store EXISTS and is written nightly by
 * `candle-evict`; and the dependency measured far cheaper than assumed —
 * `hyparquet@1.30.0` and `hyparquet-writer@0.16.9` are MIT, pure ESM
 * JavaScript with NO native addon, no wasm and no install script, and
 * `hyparquet` carries zero runtime dependencies of its own.
 *
 * The DISK cost is 767 KB, not the 503 KB the two packages' own unpacked sizes
 * suggest (284 KB + 219 KB). `hyparquet-writer` pins an EXACT
 * `hyparquet@1.29.2`, which does not satisfy the top-level `^1.30.0`, so a
 * third 282 KB copy is installed nested under the writer. Measured on the real
 * tree, 2026-09-08: 284,480 + 219,428 + 281,904 = 785,812 B.
 *
 * The third premise still stands, and it is what
 * {@link encodeColdShardParquet}'s note is about — but read that note before
 * assuming the dynamic import is the mechanism. It is NOT. The bundle exclusion
 * is `serverExternalPackages` in `apps/web/next.config.js` and
 * `apps/admin/next.config.js`; a dynamic import changes WHEN a chunk evaluates,
 * never whether the bytes ship.
 *
 * PARQUET IS BIGGER HERE, and that is not a defect to tune away. Measured
 * 2026-09-08 on a typical 252-bar D1 symbol-year: 5,809 bytes gzipped JSONL
 * against 9,776 bytes parquet — 68% LARGER — and 20 against 162 for an empty
 * shard. Parquet's footer, schema and per-page metadata are a fixed cost that a
 * few-hundred-row file cannot amortise, while DEFLATE over JSONL already
 * exploits the repetition parquet's dictionary encoding would. So do NOT reach
 * for `CANDLE_COLD_FORMAT=parquet` to save storage; it costs storage.
 *
 * AND IT IS STILL BIGGER AT M1 — the open question is CLOSED (MONEY-1518).
 * This note used to say "M1 shards are ~86k rows per symbol-year and may well
 * invert the ratio; MEASURE before converting them", and MONEY-1384's ticket
 * carried the same hypothesis. Measured 2026-09-22 through THESE functions, on
 * the real prod objects `candles/US/M1/AAPL/{2024,2025}`:
 *
 *   rows      JSONL_GZ      PARQUET      delta
 *   123,072   1,912,970 B   2,364,453 B  +23.6%
 *   125,527   1,996,426 B   2,454,335 B  +22.9%
 *
 * The fixed overhead does amortise — D1's +68% falls to +23% — and never
 * crosses zero. Nor is the curve monotonic: truncating those same real bars
 * gives +93.2% at 252 rows, +21.6% at 5,000, +8.5% at 20,000, +7.1% at 50,000
 * and back up to +25.3% at 100,000, so a row-group boundary can make a BIGGER
 * shard worse. **There is no timeframe at which converting this store saves
 * space.** What parquet is worth buying for is a purpose-built RELEASE
 * artifact (`releases/{release_id}/`, MONEY-1518) laid out `market=`/`year=`
 * for partition pruning — not a re-encoding of these keys.
 *
 * What parquet buys is still NOT columnar projection or predicate pushdown:
 * this store's read is "every column of every bar in one symbol-year", a full
 * scan of the object in any format. What it buys is the PYTHON side — the quant engine reads our collections directly,
 * and a parquet shard loads in pandas/duckdb/pyarrow without a second JSONL
 * decoder written in a second language, which is the "one rule, stated twice,
 * disagreeing" class this file's header names.
 *
 * The key layout is UNCHANGED and needs no migration, which is the whole point
 * of sniffing magic bytes instead of spelling an extension into the key: a
 * half-converted bucket reads correctly, because the decoder asks the BYTES
 * what they are and never the key. The read-modify-write in
 * `writeColdShard` therefore decodes whatever is there and re-encodes in the
 * configured format, so a bucket may be mid-conversion indefinitely.
 */
const GZIP_MAGIC = [0x1f, 0x8b] as const;
/** Parquet files begin AND end with the four bytes `PAR1`. */
const PARQUET_MAGIC = "PAR1";

export function sniffColdShardFormat(body: Buffer): ColdShardFormat {
  if (
    body.length >= 2 &&
    body[0] === GZIP_MAGIC[0] &&
    body[1] === GZIP_MAGIC[1]
  ) {
    return "JSONL_GZ";
  }
  if (
    body.length >= 4 &&
    body.subarray(0, 4).toString("latin1") === PARQUET_MAGIC
  ) {
    return "PARQUET";
  }
  return "UNKNOWN";
}

/**
 * One stored ROW — a JSONL line, or one row of the parquet shard's columns.
 * ONE definition, shared by both codecs, because a second copy of this schema
 * is the "one rule, stated twice, disagreeing" defect by construction.
 *
 * Deliberately SELF-DESCRIBING — `symbol` and `timeframe` are
 * already in the object key and are stored again anyway.
 *
 * The redundancy costs almost nothing (identical strings on every row are what
 * DEFLATE is best at) and buys the property the feed archive learned to value
 * the hard way in MONEY-1204: an archived object that cannot be identified from
 * its own bytes is an unidentifiable blob. `gsutil cat … | gunzip | head -1`
 * must produce a complete, unambiguous bar.
 *
 * `volume` is a NUMBER in both codecs, not a string and not a 64-bit integer.
 * `JSON.stringify` THROWS outright on a `bigint` ("Do not know how to serialize
 * a BigInt"), and parquet's INT64 decodes BACK as a `bigint`, which
 * {@link finite} would then reject and drop the bar. Both codecs therefore use
 * the double, and the 2^53 headroom argument on {@link CandleBar.volume} is
 * what makes that safe.
 */
interface ColdShardRow {
  s: string; // symbol
  x: string; // exchange
  tf: string; // timeframe
  t: string; // ts, ISO-8601 UTC
  l: string; // listingId
  o: number;
  h: number;
  lo: number;
  c: number;
  v: number;
  d: number; // divCash
  sf: number; // splitFactor
  src: string;
}

/** Bar -> stored row. The ONE place the wire schema is written down. */
function toColdShardRow(b: CandleBar): ColdShardRow {
  return {
    s: b.symbol,
    x: b.exchange,
    tf: b.timeframe,
    t: b.ts.toISOString(),
    l: b.listingId,
    o: b.open,
    h: b.high,
    lo: b.low,
    c: b.close,
    v: b.volume,
    d: b.divCash,
    sf: b.splitFactor,
    src: b.source,
  };
}

/**
 * Stored row -> bar, or `null` for a row that is not a bar.
 *
 * Tolerant PER ROW and strict about nothing else: one corrupt row is dropped
 * rather than thrown, for the same reason `parseTiingoMasterCsv` drops a bad
 * line — one damaged row must not cost a whole symbol-year. A row whose price
 * or timestamp is non-finite is dropped too, because a `NaN` bar is not a bar;
 * it is the "₹NaN" poison this codebase has chased through five subsystems.
 */
function coldShardRowToBar(row: Partial<ColdShardRow>): CandleBar | null {
  const ts = new Date(String(row.t ?? ""));
  if (Number.isNaN(ts.getTime())) return null;

  const open = finite(row.o);
  const high = finite(row.h);
  const low = finite(row.lo);
  const close = finite(row.c);
  if (open === null || high === null || low === null || close === null) {
    return null;
  }
  if (
    typeof row.s !== "string" ||
    typeof row.x !== "string" ||
    typeof row.tf !== "string"
  ) {
    return null;
  }

  return {
    symbol: row.s,
    exchange: row.x,
    timeframe: row.tf,
    ts,
    listingId: typeof row.l === "string" ? row.l : "",
    open,
    high,
    low,
    close,
    volume: finite(row.v) ?? 0,
    divCash: finite(row.d) ?? 0,
    // A zero or negative split factor divides by zero in the adjustment.
    splitFactor: positiveOr(row.sf, 1),
    source: typeof row.src === "string" ? row.src : "TIINGO",
  };
}

/** Bars -> the shard's uncompressed text. Ascending by ts, one JSON per line. */
export function serializeColdShard(bars: readonly CandleBar[]): string {
  return sortBarsAscending(bars)
    .map((b) => JSON.stringify(toColdShardRow(b)))
    .join("\n");
}

/**
 * Shard text -> bars. Blank lines skipped, unparseable lines dropped;
 * {@link coldShardRowToBar} owns every rule about what a row must contain.
 */
export function parseColdShard(text: string): CandleBar[] {
  const out: CandleBar[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: Partial<ColdShardRow>;
    try {
      row = JSON.parse(trimmed) as Partial<ColdShardRow>;
    } catch {
      continue;
    }
    const bar = coldShardRowToBar(row);
    if (bar !== null) out.push(bar);
  }
  return sortBarsAscending(out);
}

/**
 * The parquet column layout: every {@link ColdShardRow} field, no more.
 *
 * Split by physical type rather than listed once, because the writer needs a
 * `type` per column and the two groups are the only two types in the schema.
 * The order here is the column order in the file; row ORDER is `ts` ascending,
 * the same guarantee JSONL gives, so a consumer that reads the file top to
 * bottom gets a sorted series without sorting it.
 */
const PARQUET_STRING_COLUMNS = ["s", "x", "tf", "t", "l", "src"] as const;
const PARQUET_NUMBER_COLUMNS = ["o", "h", "lo", "c", "v", "d", "sf"] as const;

/**
 * ## What actually keeps the codec out of the Next bundles — and what does not
 *
 * `import("hyparquet-writer")` is DYNAMIC and stays inside this function, but
 * THAT IS NOT WHAT EXCLUDES IT. This comment used to claim it was, and the
 * claim was measured false: `apps/web` has no `transpilePackages` and had no
 * `serverExternalPackages` entry, so webpack compiled this file from source and
 * INLINED the codec into local chunks — `.next/server/chunks/2975.js` and
 * `3311.js` (reader, 54,418 B each), `4713.js` and `5474.js` (writer,
 * ~55,841 B each) — reachable from 133 route traces. `apps/admin` got the same
 * through the root `@usemoney/core` barrel. A dynamic import changes WHEN a
 * chunk evaluates, never whether the bytes ship.
 *
 * The exclusion is `serverExternalPackages: ["hyparquet", "hyparquet-writer"]`
 * in `apps/web/next.config.js` and `apps/admin/next.config.js`. Deleting either
 * entry puts the codec back into a bundle to serve a branch neither app can
 * execute — both deliberately register no cold store, so they can reach this
 * MODULE and never this BRANCH.
 *
 * MEASURED, by building `apps/web` on both sides of the config change
 * (2026-09-08). With the entries, webpack emits the two specifiers as external
 * stubs — `a.exports=import("hyparquet-writer")` and `a.exports=import(
 * "hyparquet")` — and all four dedicated codec chunks disappear: 220,519 B of
 * inlined codec gone, and the string `hyparquet` no longer occurs anywhere in
 * `.next/server/chunks/`.
 *
 * IT MOVES A RESIDUE RATHER THAN ERASING IT, which is worth knowing before
 * anyone cites this as a pure win. Next's output file tracing then pulls the
 * REAL package files into the same 133 route traces — 53 files, 353,055 B,
 * including the nested `hyparquet-writer/node_modules/hyparquet` copy. So the
 * compiled BUNDLE shrinks (nothing to parse or evaluate) while the function's
 * traced disk grows by ~129 KB. `outputFileTracingExcludes` below would remove
 * that too, and is deliberately NOT set: it would turn any future cold-store
 * registration in these apps from working code into a runtime MODULE_NOT_FOUND,
 * which is a worse failure than 129 KB.
 *
 * The dynamic import still earns its place on top of all that: externalizing
 * makes the specifier a runtime import, and keeping it inside the branch is
 * what stops that import from resolving at module-load time in every process —
 * including the ones (Vercel functions, local dev) where the package may not
 * be present at all.
 */
async function encodeColdShardParquet(
  bars: readonly CandleBar[],
): Promise<Buffer> {
  const { parquetWriteBuffer } = await import("hyparquet-writer");
  const rows = sortBarsAscending(bars).map(toColdShardRow);
  return Buffer.from(
    parquetWriteBuffer({
      columnData: [
        ...PARQUET_STRING_COLUMNS.map((name) => ({
          name,
          data: rows.map((r) => r[name]),
          type: "STRING" as const,
        })),
        ...PARQUET_NUMBER_COLUMNS.map((name) => ({
          name,
          data: rows.map((r) => r[name]),
          type: "DOUBLE" as const,
        })),
      ],
    }),
  );
}

/**
 * Parquet bytes -> bars, through the SAME {@link coldShardRowToBar} the JSONL
 * path uses, so the two formats cannot disagree about what a row means.
 *
 * ## The `Buffer` -> `ArrayBuffer` trap
 *
 * hyparquet wants an `AsyncBuffer`: a `byteLength` plus a `slice` returning
 * `ArrayBuffer`. Handing it `body.buffer` is WRONG and silently so — Node
 * allocates Buffers under 4 KB out of an 8 KB shared pool, so `body.buffer` is
 * the whole pool and `body.byteOffset` is very often not zero. The reader would
 * then parse a neighbouring allocation's bytes as parquet. Slicing through the
 * Buffer's own view is what keeps the offset applied.
 */
async function decodeColdShardParquet(body: Buffer): Promise<CandleBar[]> {
  const { parquetReadObjects } = await import("hyparquet");
  const rows: Record<string, unknown>[] = await parquetReadObjects({
    file: {
      byteLength: body.byteLength,
      slice: (start: number, end?: number): ArrayBuffer =>
        new Uint8Array(body.subarray(start, end)).buffer,
    },
  });
  const out: CandleBar[] = [];
  for (const row of rows) {
    const bar = coldShardRowToBar(row as Partial<ColdShardRow>);
    if (bar !== null) out.push(bar);
  }
  return sortBarsAscending(out);
}

/**
 * Bars -> the exact bytes stored at the cold key.
 *
 * `format` defaults to the LITERAL `"JSONL_GZ"` rather than to
 * {@link resolveColdShardFormat}, so only the write path
 * (`writeColdShard`) consults the environment. A default that read the env
 * would make every incidental caller — a test fixture, a benchmark — silently
 * change shape when an operator flips a switch for the eviction job.
 */
export async function encodeColdShard(
  bars: readonly CandleBar[],
  format: ColdShardWriteFormat = "JSONL_GZ",
): Promise<Buffer> {
  if (format === "PARQUET") return encodeColdShardParquet(bars);
  return gzipSync(Buffer.from(serializeColdShard(bars), "utf8"));
}

/**
 * Stored bytes -> bars, format chosen by magic bytes rather than by key.
 *
 * ASYNC because the parquet codec is dynamically imported, and there is
 * deliberately only ONE decoder rather than a sync one beside an async one: two
 * doors means a future caller picks the sync door and cannot read half the
 * bucket, which is precisely the silent-truncation shape this seam exists to
 * prevent. All three production call sites were already inside `async`
 * functions, so the cost was three `await`s.
 *
 * Unrecognised bytes still THROW, because the alternative — treating them as an
 * empty year — is the MONEY-1189 shape: a completeness check that reports
 * SUCCESS for work that never happened. Absence and unreadability must never
 * look alike.
 */
export async function decodeColdShard(body: Buffer): Promise<CandleBar[]> {
  const format = sniffColdShardFormat(body);
  if (format === "JSONL_GZ") {
    return parseColdShard(gunzipSync(body).toString("utf8"));
  }
  if (format === "PARQUET") {
    return decodeColdShardParquet(body);
  }
  throw new Error(
    `decodeColdShard: unrecognised shard format (first bytes ${body
      .subarray(0, 4)
      .toString("hex")}). Expected gzip (1f8b) or parquet (PAR1).`,
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Merge + listing selection
   ──────────────────────────────────────────────────────────────────────── */

/** Ascending by `ts`. Non-mutating. */
export function sortBarsAscending<T extends { ts: Date }>(
  bars: readonly T[],
): T[] {
  return [...bars].sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

/**
 * Merge the Mongo hot window with the GCS cold shards into ONE ascending
 * series, with HOT winning any overlap.
 *
 * Hot wins because it is the writable copy. A cold shard is a snapshot taken
 * when the year was evicted; if a corporate action or a vendor restatement has
 * since corrected a bar, the correction lands in Mongo and the shard still
 * carries the superseded value. Preferring cold there would resurrect the old
 * number on every read — and, worse, only for the years that happen to have been
 * evicted, so the series would be right at one end and wrong at the other.
 */
export function mergeHotAndCold(
  hot: readonly CandleBar[],
  cold: readonly CandleBar[],
): CandleBar[] {
  const byKey = new Map<string, CandleBar>();
  for (const bar of cold) byKey.set(candleKey(bar), bar);
  for (const bar of hot) byKey.set(candleKey(bar), bar);
  return sortBarsAscending([...byKey.values()]);
}

/* ─────────────────────────────────────────────────────────────────────────
   Venue scoping — the ONE rule every cold read filters by
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The identity a cold shard's rows have to be narrowed to before they mean
 * anything.
 *
 * A shard is keyed by TICKER, not by venue — see {@link buildCandleColdKey} for
 * why that is the safer layout — so `candles/US/D1/DOW/2019` legitimately holds
 * NYSE bars beside NASDAQ ones for the 928 tickers that trade on more than one
 * exchange, and US uplisting makes that routine rather than exotic. `timeframe`
 * IS already in the key and is re-checked anyway: a future producer that batched
 * two timeframes into one object would otherwise interleave them into a single
 * series, and that failure looks exactly like a denser chart rather than an
 * error.
 */
export interface CandleVenue {
  exchange: string;
  timeframe: string;
}

/**
 * Does this bar belong to the venue the caller asked for?
 *
 * Exported and shared rather than restated at each call site (MONEY-980). Both
 * cold-read paths in `candle-repository.ts` — the range read and `latestTs`'s
 * probe — narrow a shard with THIS predicate, so they cannot drift apart. The
 * "one rule, stated twice, disagreeing" class (MONEY-1255) is the single most
 * expensive defect family in this repo's history, and a filter that two readers
 * spell differently produces two different series from one object with nothing
 * on either to say so.
 */
export function barMatchesVenue(
  bar: { exchange: string; timeframe: string },
  venue: CandleVenue,
): boolean {
  return bar.exchange === venue.exchange && bar.timeframe === venue.timeframe;
}

/**
 * Newest `ts` among the bars belonging to `venue`, or `null` when the shard
 * holds NONE of them.
 *
 * ## The bug this function's shape exists to make impossible (MONEY-980)
 *
 * The obvious loop seeds its running maximum from `bars[0]` and only THEN
 * applies the venue filter. That is wrong twice over on a ticker-keyed shard:
 *
 *   - the seed is whatever venue happens to sort first in the object, so
 *     probing NYSE against a shard whose first row is NASDAQ returns a NASDAQ
 *     bar's timestamp — a resume point for a series we were not asked about; and
 *   - a shard containing NO bars for the requested exchange still yields a
 *     non-null answer, so the caller stops walking backward through the years
 *     and never reaches the year that actually holds its data.
 *
 * `null` is therefore a REQUIRED return value and not an edge case: it is the
 * signal that says "keep looking". Seeding from the first bar that PASSES the
 * filter is what makes both properties hold at once.
 *
 * A bar whose `ts` is not a real instant is skipped rather than returned. An
 * `Invalid Date` handed back as a resume point becomes a `ts` predicate that
 * matches nothing, which reads downstream as "no data" instead of "bad row" —
 * the MONEY-1050/1234/1235 shape.
 */
export function newestTsForVenue(
  bars: readonly { exchange: string; timeframe: string; ts: Date }[],
  venue: CandleVenue,
): Date | null {
  let newest: Date | null = null;
  for (const bar of bars) {
    if (!barMatchesVenue(bar, venue)) continue;
    const t = bar.ts.getTime();
    if (!Number.isFinite(t)) continue;
    if (newest === null || t > newest.getTime()) newest = bar.ts;
  }
  return newest;
}

/** Inclusive `[from, to]` window over an ascending series. */
export function sliceRange<T extends { ts: Date }>(
  bars: readonly T[],
  from: Date,
  to: Date,
): T[] {
  const lo = from.getTime();
  const hi = to.getTime();
  return bars.filter((b) => {
    const t = b.ts.getTime();
    return t >= lo && t <= hi;
  });
}

/** How the read decided which security's bars it was allowed to return. */
export type ListingResolution =
  | "explicit" // caller named a listingId
  | "instrument" // resolved from InstrumentMapping.listingId
  | "inferred" // resolved from the data: the group holding the newest bar
  | "single" // only one listing present — nothing to choose between
  | "none"; // no bars at all

export interface ListingSelection {
  bars: CandleBar[];
  listingId: string | null;
  resolution: ListingResolution;
  /** Bars discarded because they belong to a DIFFERENT occupancy window. */
  dropped: number;
}

/**
 * Keep exactly ONE security's bars.
 *
 * ## The corruption this prevents
 *
 * A ticker is not a security. `DOW` on NYSE is Dow Chemical (1972-2017) AND Dow
 * Inc. (2019-2026): identical symbol, identical exchange, non-overlapping
 * windows. The `@@unique([symbol, exchange, timeframe, ts])` index cannot catch
 * it, and that is not an oversight — the windows never overlap, so there is no
 * key collision to detect. The damage is purely SEMANTIC: a full-range read
 * returns one company's bars followed by another's as a single continuous
 * series, with nothing on any row saying so. 2,196 tickers repeat in Tiingo's
 * master and 834 delisted US rows share a ticker with a live one, so this is
 * ~8% of the delisted universe, not a corner case.
 *
 * ## Why "the newest group" is the right default, and why it is never a guess
 *
 * A bare-symbol read means "the security trading under this ticker today", so
 * the default is the group containing the newest bar. When the caller named a
 * `listingId`, or `InstrumentMapping` supplied one, that wins outright — the
 * historical window is reachable, it just has to be ASKED for.
 *
 * The inference is applied even when a `listingId` was pushed into the database
 * query, and that redundancy is the point: the cold shards are keyed by ticker
 * (see {@link buildCandleColdKey}) and therefore contain every listing, so the
 * push-down filters the hot half only. One filter, applied to the merged series,
 * is what makes the two halves agree.
 */
export function selectSingleListing(
  bars: readonly CandleBar[],
  preferred: string | null,
  preferredResolution: "explicit" | "instrument",
): ListingSelection {
  if (bars.length === 0) {
    return { bars: [], listingId: preferred, resolution: "none", dropped: 0 };
  }

  if (preferred !== null && preferred !== "") {
    const kept = bars.filter((b) => b.listingId === preferred);
    // ── The one case where a preference is overruled ──────────────────────
    //
    // An `explicit` id is the CALLER's assertion about which security it wants;
    // if that window holds no bars, empty is the honest answer and inventing a
    // different company's series would be the corruption this whole function
    // exists to prevent.
    //
    // An `instrument` id is a HINT derived from `InstrumentMapping.listingId`,
    // and that hint can be stale in a way the bars are not: candles written
    // before the instrument row was enriched carry a `listingId` the mapping has
    // since changed, and `InstrumentMapping` is unique on `(symbol, exchange)`
    // so it can only ever hold ONE of a recycled ticker's windows. Filtering a
    // full table of bars down to nothing on the strength of a stale hint would
    // blank the chart for a security we demonstrably hold prices for — the
    // MONEY-1050/1234/1235 shape, where a filter matching zero rows reads as
    // "no data" rather than "wrong filter". So fall through to the inference,
    // which cannot concatenate two companies either, and SAY SO in `resolution`.
    if (kept.length === 0 && preferredResolution === "instrument") {
      return selectSingleListing(bars, null, preferredResolution);
    }
    return {
      bars: kept,
      listingId: preferred,
      resolution: preferredResolution,
      dropped: bars.length - kept.length,
    };
  }

  const groups = new Map<string, CandleBar[]>();
  for (const bar of bars) {
    const list = groups.get(bar.listingId);
    if (list) list.push(bar);
    else groups.set(bar.listingId, [bar]);
  }

  if (groups.size <= 1) {
    return {
      bars: [...bars],
      listingId: bars[0]!.listingId || null,
      resolution: "single",
      dropped: 0,
    };
  }

  let winner: string | null = null;
  let newest = -Infinity;
  for (const [listingId, list] of groups) {
    for (const bar of list) {
      const t = bar.ts.getTime();
      if (t > newest) {
        newest = t;
        winner = listingId;
      }
    }
  }
  const kept = groups.get(winner ?? "") ?? [];
  return {
    bars: kept,
    listingId: winner,
    resolution: "inferred",
    dropped: bars.length - kept.length,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Adjustment
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Back-adjust a series by delegating to the ALREADY-VALIDATED
 * `computeAdjustedSeries` (CRSP methodology, walking backward from the most
 * recent bar).
 *
 * NOT reimplemented here, deliberately. That function was validated against
 * Tiingo's own `adjClose` on 11,517 real AAPL bars — worst error 0.023%, zero
 * bars off by more than 0.1%. A second implementation would be a second thing
 * to validate, and the "naming a bug is not protection from it" lesson says the
 * copy is where the drift lands.
 *
 * The mapping to `TiingoEodBar` uses `ts.toISOString().slice(0, 10)` for the
 * `date` field. For D1 that is exact. For a reserved intraday timeframe several
 * bars would share one `date` string — harmless, because `computeAdjustedSeries`
 * only CARRIES `date`; every factor it computes comes from `close`, `divCash`
 * and `splitFactor`, and it is index-ordered, not date-keyed.
 *
 * The input MUST be ascending; `computeAdjustedSeries` states that as a
 * precondition and produces a silently wrong series otherwise, so this sorts
 * rather than trusting its caller.
 */
export function adjustCandleSeries(
  bars: readonly CandleBar[],
): AdjustedCandleBar[] {
  const ordered = sortBarsAscending(bars);
  const raw: TiingoEodBar[] = ordered.map((b) => ({
    date: b.ts.toISOString().slice(0, 10),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    divCash: b.divCash,
    splitFactor: b.splitFactor,
  }));

  const adjusted: AdjustedBar[] = computeAdjustedSeries(raw);
  // 1:1 and order-preserving (`bars.map` inside computeAdjustedSeries), so the
  // zip by index is sound. Asserted rather than assumed: a length mismatch here
  // would silently pair one bar's prices with another's factors.
  if (adjusted.length !== ordered.length) {
    throw new Error(
      `adjustCandleSeries: adjusted length ${adjusted.length} != input ${ordered.length}`,
    );
  }

  return ordered.map((bar, i) => {
    const a = adjusted[i]!;
    return {
      ...bar,
      adjOpen: a.adjOpen,
      adjHigh: a.adjHigh,
      adjLow: a.adjLow,
      adjClose: a.adjClose,
      adjVolume: a.adjVolume,
    };
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   Write-side partitioning
   ──────────────────────────────────────────────────────────────────────── */

export interface CandleSanitizeResult {
  rows: NormalizedCandleWrite[];
  /** Dropped: a non-finite price, or a `ts` that is not a real instant. */
  droppedNonFinite: number;
  /** Negative volume clamped to 0 (kept, not dropped — the bar is still real). */
  clampedVolume: number;
}

const DEFAULT_CANDLE_SOURCE = "TIINGO";
/** What an unstated `listingStatus` resolves to. See {@link isActiveListing}. */
const DEFAULT_LISTING_STATUS = "ACTIVE";

/**
 * Normalise and hard-reject write rows BEFORE they can reach a batch.
 *
 * A `NaN` price stored once is permanent: it poisons every average, every
 * adjustment factor (a single `NaN` close propagates through the whole
 * cumulative product), and renders as "₹NaN". `feed-parse`'s `writeCash` learned
 * to repair-or-drop before the write for exactly this reason, and the repair
 * runs in the writer rather than in a migration so a re-parse cannot undo it.
 *
 * `volume` becomes a `bigint` here because the column is one; `BigInt(NaN)`
 * THROWS, so the finiteness check has to happen first rather than being
 * discovered as a 500 from inside a Prisma call.
 */
export function sanitizeCandleWrites(
  rows: readonly CandleWriteRow[],
): CandleSanitizeResult {
  const out: NormalizedCandleWrite[] = [];
  let droppedNonFinite = 0;
  let clampedVolume = 0;

  for (const row of rows) {
    const open = finite(row.open);
    const high = finite(row.high);
    const low = finite(row.low);
    const close = finite(row.close);
    const tsMs = row.ts instanceof Date ? row.ts.getTime() : NaN;
    if (
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      !Number.isFinite(tsMs)
    ) {
      droppedNonFinite++;
      continue;
    }

    // `BigInt(0)` rather than the `0n` literal, throughout. This module is
    // compiled by apps/web from source, and that app targets es2017 — a BigInt
    // LITERAL is a syntax-level feature gated on es2020 (TS2737), while the
    // BigInt() call is an ordinary function call at any target. packages/core
    // type-checks clean on its own either way, so the failure only appears in
    // the repo-wide `yarn type-check`, which is exactly why that runs first.
    const ZERO = BigInt(0);
    let volume: bigint;
    if (typeof row.volume === "bigint") {
      volume = row.volume;
    } else {
      const v = finite(row.volume);
      if (v === null) {
        // A missing volume is a real state for some venues; a NON-FINITE one is
        // a parse failure. Neither justifies discarding a valid price bar, so
        // it lands at zero and is counted.
        volume = ZERO;
        clampedVolume++;
      } else {
        volume = BigInt(Math.round(v));
      }
    }
    if (volume < ZERO) {
      volume = ZERO;
      clampedVolume++;
    }

    out.push({
      symbol: row.symbol,
      exchange: row.exchange,
      timeframe: row.timeframe,
      ts: new Date(tsMs),
      listingId: row.listingId,
      open,
      high,
      low,
      close,
      volume,
      divCash: finite(row.divCash) ?? 0,
      splitFactor: positiveOr(row.splitFactor, 1),
      source: row.source ?? DEFAULT_CANDLE_SOURCE,
      // Resolved here, once, so every consumer downstream sees a string rather
      // than re-deriving "absent means ACTIVE" — a default spelled twice is a
      // default that will eventually be spelled two ways.
      listingStatus: isActiveListing(row.listingStatus)
        ? DEFAULT_LISTING_STATUS
        : (row.listingStatus ?? "").trim().toUpperCase(),
      // Only `LOADED` survives. A caller passing `WINDOW` is asking for what the
      // routing already computes, so it is normalised away to `null` rather than
      // carried as an override that could later be read as one.
      tier: row.tier === "LOADED" ? "LOADED" : null,
    });
  }

  return { rows: out, droppedNonFinite, clampedVolume };
}

export interface CandleWritePartition {
  create: NormalizedCandleWrite[];
  upgrade: Array<{
    row: NormalizedCandleWrite;
    existingId: string;
    existingSource: string | null;
  }>;
  /** Existing rows held by an equal-or-stronger source. */
  preserved: number;
  /** Repeats of the same natural key WITHIN the batch. First occurrence wins. */
  dupInBatch: number;
}

/**
 * Split a batch into create / upgrade / preserve using the SHARED precedence
 * table.
 *
 * ## Why this is not `partitionPriceWrites`
 *
 * That function is the same policy for `DailyPrice`, and it keys on a single
 * `instrumentId` because `DailyPrice` is unique on `(instrumentId, date)` and
 * every call site processes exactly one date. `Candle` is unique on a FOUR-part
 * natural key and a batch spans many timestamps, so reusing it would mean
 * smuggling a composite key through a field named `instrumentId` — a rename that
 * would read as a bug to the next person and would collide the moment someone
 * batched two timeframes together.
 *
 * What is NOT duplicated is the DECISION: `shouldUpgradePriceSource` is imported
 * from `price-source-authority.ts`, so there is still exactly one authority
 * table and exactly one "strictly greater wins" rule. Equal authority must not
 * overwrite — it keeps a re-run idempotent (at equal rank every row would be
 * rewritten, turning a no-op into millions of pointless writes and a churned
 * oplog) and it stops a historical replay clobbering the nightly's copy of the
 * same bar.
 */
export function partitionCandleWrites(
  incoming: readonly NormalizedCandleWrite[],
  existing: ReadonlyMap<string, { id: string; source: string | null }>,
): CandleWritePartition {
  const create: NormalizedCandleWrite[] = [];
  const upgrade: CandleWritePartition["upgrade"] = [];
  let preserved = 0;
  let dupInBatch = 0;

  const seen = new Set<string>();
  for (const row of incoming) {
    const key = candleKey(row);
    if (seen.has(key)) {
      // A repeat reaching `createMany` aborts the ENTIRE chunk on the unique
      // index — Prisma-Mongo has no usable `skipDuplicates`. Collapse here.
      dupInBatch++;
      continue;
    }
    seen.add(key);

    const current = existing.get(key);
    if (!current) {
      create.push(row);
      continue;
    }
    if (shouldUpgradePriceSource(current.source, row.source)) {
      upgrade.push({
        row,
        existingId: current.id,
        existingSource: current.source,
      });
    } else {
      preserved++;
    }
  }

  return { create, upgrade, preserved, dupInBatch };
}

/**
 * Which counter a FAILED single-row insert lands in.
 *
 * Only the two the decision can produce. `created` is not here because a row
 * that threw was, by definition, not created.
 */
export type CandleRowWriteOutcome = "preserved" | "failed";

/**
 * Classify the error from the per-row insert fallback — MONEY-980.
 *
 * ## Why a duplicate must NOT be counted as a failure
 *
 * The per-row fallback only ever runs AFTER a bulk `createMany` collided, so its
 * overwhelmingly common input is a chunk of rows a concurrent writer already
 * landed between our diff and our write. Counting each of those as `failed` was
 * not merely untidy bookkeeping, it PAGED SOMEBODY for correct behaviour, in two
 * places at once:
 *
 *   - `us-eod-sync` adds `CandleWriteResult.failed` into `state.failed` and
 *     reports it as `reportJobOutcome({ failed })`; and
 *   - the same number is inside `owed` (`created + upgraded + failed +
 *     droppedNonFinite`), which becomes the `selected` half of the
 *     clamped-difference freshness monitor — so a benign race raised
 *     `selected` with no matching `written` and the monitor fired.
 *
 * `tiingo-us-backfill` has the third instance: `res.failed > 0` increments its
 * error tally AND writes `"N row(s) failed to write"` into the symbol's
 * checkpoint `detail`, so a race left a permanent, false record on a row that is
 * in fact stored correctly.
 *
 * ## Why the match is on CODES only, never on the message
 *
 * `P2002` is Prisma's unique-constraint violation; `11000` is MongoDB's
 * `DuplicateKey`, which is what surfaces when a raw driver error escapes
 * Prisma's mapping. Both are exact, unambiguous identifiers. A substring test
 * against the message ("duplicate", "already exists") is deliberately NOT here:
 * this classifier's job is to SUPPRESS a failure count, so a loose match
 * silences real errors, and the direction of a miss matters — an unrecognised
 * duplicate is counted as `failed`, which is exactly today's behaviour and
 * merely noisy, while a mis-recognised hard failure is a write we lost and never
 * hear about.
 */
export function classifyCandleRowWriteError(
  error: unknown,
): CandleRowWriteOutcome {
  if (error === null || typeof error !== "object") return "failed";
  const code = (error as { code?: unknown }).code;
  if (code === "P2002" || code === 11000 || code === "11000") {
    return "preserved";
  }
  return "failed";
}

/**
 * Group a batch into the `(symbol, exchange, timeframe)` series it touches, each
 * with its own `ts` bounds.
 *
 * The diff query that follows has to be ONE bounded `findMany` per chunk rather
 * than one per row — `writeCash` is the model here — and the only way to bound
 * it is to know the exact series and the exact `ts` window. A query built from
 * the batch's global min/max `ts` and a flat `symbol: { in: [...] }` would be a
 * CROSS PRODUCT: batching one symbol's 46-year history together with today's
 * 24,328-symbol EOD run would ask Mongo for 24,328 symbols × 46 years.
 */
export interface CandleSeriesGroup {
  symbol: string;
  exchange: string;
  timeframe: string;
  minTs: Date;
  maxTs: Date;
  rows: NormalizedCandleWrite[];
}

export function groupWritesBySeries(
  rows: readonly NormalizedCandleWrite[],
): CandleSeriesGroup[] {
  const groups = new Map<string, CandleSeriesGroup>();
  for (const row of rows) {
    const key = `${row.symbol}\u0000${row.exchange}\u0000${row.timeframe}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        symbol: row.symbol,
        exchange: row.exchange,
        timeframe: row.timeframe,
        minTs: row.ts,
        maxTs: row.ts,
        rows: [row],
      });
      continue;
    }
    existing.rows.push(row);
    if (row.ts.getTime() < existing.minTs.getTime()) existing.minTs = row.ts;
    if (row.ts.getTime() > existing.maxTs.getTime()) existing.maxTs = row.ts;
  }
  return [...groups.values()];
}

/** Split any list into fixed-size chunks. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk: size must be positive, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   Small numeric guards
   ──────────────────────────────────────────────────────────────────────── */

function finite(value: unknown): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) ? value : null;
}

/** A split factor must be strictly positive; anything else means "no split". */
function positiveOr(value: unknown, fallback: number): number {
  const n = finite(value);
  return n !== null && n > 0 ? n : fallback;
}

/* ─────────────────────────────────────────────────────────────────────────
   Hot-load promotion — the READ-side cold -> hot write-back
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The bars a cold HIT should promote into Mongo as `tier: "LOADED"`.
 *
 * ## Three filters, and each one removes a distinct way to corrupt the store
 *
 *   1. **Served.** Only bars that survived {@link selectSingleListing} are
 *      promoted. A ticker-keyed shard legitimately carries a RECYCLED ticker's
 *      OTHER occupant (`candles/US/D1/DOW/2019` holds Dow Inc.; the 2015 shard
 *      holds Dow Chemical), and promoting the company the reader was NOT asking
 *      about spends hot-window rows on data nobody requested.
 *   2. **Not already hot.** A key present in the hot read came out of Mongo, so
 *      writing it back is at best a no-op. At worst it is a corruption: an
 *      in-window `WINDOW` row whose key also appears in a stale shard would be
 *      re-stamped `LOADED` and would then be deleted 30 days later by a rule
 *      that has no business touching it — the window is what governs that row.
 *      Excluding the hot keys makes that impossible at the SELECTION step, and
 *      {@link buildHotLoadStampUpdates}'s positive `tier` predicate makes it
 *      impossible again at the WRITE step.
 *   3. **Deduped by natural key.** `parseColdShard` is line-tolerant and does
 *      not dedupe, so a shard with a repeated line would otherwise put the same
 *      key in a `createMany` twice — which on Prisma-Mongo aborts the WHOLE
 *      chunk on the unique index rather than skipping the repeat.
 *
 * Deliberately NOT sliced to the caller's `[from, to]`. A cold READ pulls whole
 * symbol-YEARS (that is the shard's granularity) and `hotLoadedYears` is a
 * per-YEAR ledger, so promoting only the requested slice would leave the ledger
 * claiming a year is hot when eleven months of it are not — and the next read
 * with slightly different bounds would go back to GCS anyway.
 */
export function promotableColdBars(args: {
  /** Bars the cold store answered with, already venue-filtered. */
  cold: readonly CandleBar[];
  /** Bars the read is actually serving, post-{@link selectSingleListing}. */
  served: readonly CandleBar[];
  /**
   * Bars Mongo already held for this read.
   *
   * Note what this filter costs, and where the cost is paid back: after the
   * FIRST promotion these very bars come back out of Mongo, so `hot` contains
   * them, so this function returns NOTHING on every subsequent read. That is
   * correct — re-promoting a row already in Mongo is at best a no-op — but it
   * means an empty result here is NOT "this read has no hot-load work". The
   * stamp side of the work is selected by {@link barsNeedingHotLoadStamp}
   * instead, from the rows the read got BACK rather than from the ones it is
   * about to write. Driving both halves off this one list is exactly how the
   * refresh became unreachable on a repeat read.
   */
  hot: readonly CandleBar[];
}): CandleBar[] {
  const servedKeys = new Set(args.served.map(candleKey));
  const hotKeys = new Set(args.hot.map(candleKey));
  const seen = new Set<string>();
  const out: CandleBar[] = [];
  for (const bar of args.cold) {
    const key = candleKey(bar);
    if (!servedKeys.has(key)) continue;
    if (hotKeys.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bar);
  }
  return sortBarsAscending(out);
}

/* ─────────────────────────────────────────────────────────────────────────
   Hot-load STAMP refresh — the half `promotableColdBars` structurally cannot do
   ──────────────────────────────────────────────────────────────────────── */

/**
 * A hot row as Mongo returns it: a bar PLUS the two columns that exist only in
 * the hot store.
 *
 * They are not on {@link CandleBar} deliberately. `CandleBar` is also the cold
 * shard's serialised shape ({@link serializeColdShard}), and `tier` /
 * `hotLoadedAt` are facts about a row's residency in MONGO — meaningless in a
 * GCS object, and actively misleading if one were ever written into a shard and
 * read back years later as though it still applied.
 */
export interface HotCandleRow extends CandleBar {
  /**
   * `WINDOW` | `LOADED`, carried RAW.
   *
   * Typed `string` rather than {@link CandleTier} because it is a value read
   * back out of a database, not one this process chose, and narrowing it at the
   * boundary would turn an unexpected value into a type assertion. Every test of
   * it goes through {@link isLoadedTier} and is POSITIVE — `=== "LOADED"`,
   * never `!== "WINDOW"` — so an absent or unrecognised tier fails CLOSED
   * (treated as not-loaded) instead of quietly joining the 30-day lane.
   */
  tier: string;
  /** When this row was last hot-loaded. `null` on a `WINDOW` row. */
  hotLoadedAt: Date | null;
}

/** The one place `tier` is compared. Positive, always. */
export function isLoadedTier(tier: string | null | undefined): boolean {
  return tier === "LOADED";
}

/**
 * How stale a `hotLoadedAt` may get before a read refreshes it.
 *
 * ## Why there is a throttle at all
 *
 * Without one, EVERY read of a hot-loaded series issues an `updateMany` per 500
 * bars plus a ledger command — six writes and a raw command for a decade of
 * daily bars, on every pan of a chart, to move a timestamp by a few seconds.
 * With it, a series read a thousand times a day is stamped once.
 *
 * ## Why it is NOT derived from the eviction TTL
 *
 * `HOT_LOAD_TTL_DAYS` is declared in `workers/src/processors/candle-evict-logic.ts`
 * and its own doc says the stamping side "does not know it and must not: a
 * writer that knew the TTL would be free to disagree with the deleter about
 * it". That still holds and is not worked around here. This constant is a
 * WRITE BUDGET — "at most one stamp per series per day" — and its safety
 * argument is a MARGIN, not an equality: any refresh interval far below the
 * deleter's TTL keeps a continuously-read series hot, and 1 day against 30 is
 * 30× of it. The relation is asserted from the deleter's side by a test in
 * `candle-hot-load.test.ts`, which reads the workers constant from SOURCE, so
 * the day somebody retunes the TTL down to hours the margin fails a build
 * instead of failing silently.
 */
export const HOT_LOAD_STAMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The served bars whose `hotLoadedAt` this read must move forward.
 *
 * ## The bug this exists to close
 *
 * `hotLoadedAt` answers "when was this row last READ". The only writer that
 * ever set it was the promotion path, and {@link promotableColdBars} excludes
 * every key already in Mongo — which, after the first promotion, is all of
 * them. So the promotion list was empty on every repeat read, no write ran, and
 * a series read every single day kept the timestamp of its FIRST read for ever:
 * evicted at 30 days, re-promoted on the next read, a 30-day sawtooth with no
 * error and no log. Measured against the real functions before the fix: read 1
 * promoted 2 bars and issued 1 stamp update; reads 2 and 3 issued ZERO driver
 * calls of any kind.
 *
 * The information was always there and was simply never asked for — the read
 * gets the rows BACK from Mongo, and a row knows its own `tier` and its own
 * stamp. So this selects from `hot` (what the store returned) rather than from
 * `cold` (what the store is about to be given).
 *
 * ## Three filters, each closing a distinct way to keep the wrong row hot
 *
 *   1. **`LOADED` only**, tested positively via {@link isLoadedTier}. A
 *      `WINDOW` row's residency is governed by the rolling window and nothing
 *      else; stamping one would be inert today and a landmine the moment
 *      somebody widened the eviction query.
 *   2. **Served only.** A ticker-keyed read legitimately returns the OTHER
 *      occupant of a recycled ticker (`DOW` = Dow Chemical and Dow Inc.).
 *      Refreshing a listing nobody asked for would keep it in Mongo for ever on
 *      the strength of reads of a different company. Same rule, same reason, as
 *      {@link promotableColdBars} filter 1.
 *   3. **Stale only.** Fresher than `maxAgeMs` and the row is left alone — the
 *      write budget above. A `null`, absent or non-finite stamp is treated as
 *      STALE and refreshed: a `LOADED` row with no stamp is unreachable by the
 *      eviction's `{lt: cutoff}` and would otherwise be immortal, so repairing
 *      it is the point rather than a side effect.
 *
 * Returned bars are the hot rows themselves, typed down to {@link CandleBar}.
 * Nothing downstream of the stamp path reads `tier` or `hotLoadedAt` — the
 * builder takes the natural key, the ledger takes the year — and they are never
 * handed to {@link toHotLoadWriteRows}, so no database column is written from
 * a value that came out of one.
 */
export function barsNeedingHotLoadStamp(args: {
  /** Rows Mongo answered this read with, carrying tier + stamp. */
  hot: readonly HotCandleRow[];
  /** Bars the read is actually serving, post-{@link selectSingleListing}. */
  served: readonly CandleBar[];
  now: Date;
  /** Default {@link HOT_LOAD_STAMP_MAX_AGE_MS}. `0` refreshes unconditionally. */
  maxAgeMs?: number;
}): CandleBar[] {
  const maxAgeMs =
    typeof args.maxAgeMs === "number" && Number.isFinite(args.maxAgeMs)
      ? Math.max(0, args.maxAgeMs)
      : HOT_LOAD_STAMP_MAX_AGE_MS;
  const nowMs = args.now.getTime();
  const servedKeys = new Set(args.served.map(candleKey));
  const seen = new Set<string>();
  const out: CandleBar[] = [];

  for (const row of args.hot) {
    if (!isLoadedTier(row.tier)) continue;
    const key = candleKey(row);
    if (!servedKeys.has(key)) continue;
    if (seen.has(key)) continue;
    const stampedAt = row.hotLoadedAt;
    const stampedMs = stampedAt === null ? Number.NaN : stampedAt.getTime();
    // A NaN age is a broken or absent stamp, and `NaN < maxAgeMs` is FALSE, so
    // it falls through to the refresh rather than being skipped as fresh. That
    // direction is the safe one and it is why the test is written as "skip when
    // provably fresh" instead of "refresh when provably stale".
    if (nowMs - stampedMs < maxAgeMs) continue;
    seen.add(key);
    out.push(row);
  }
  return sortBarsAscending(out);
}

/**
 * Cold bars as write rows carrying the ONE legitimate `tier` override.
 *
 * `listingStatus` is deliberately absent. It would be ignored anyway —
 * {@link resolveCandleDestination} checks the override FIRST — and supplying a
 * guess here would put a second, weaker statement of the listing's status next
 * to the authoritative one on `us_instruments`.
 */
export function toHotLoadWriteRows(
  bars: readonly CandleBar[],
): CandleWriteRow[] {
  return bars.map((bar) => ({
    symbol: bar.symbol,
    exchange: bar.exchange,
    timeframe: bar.timeframe,
    ts: bar.ts,
    listingId: bar.listingId,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    divCash: bar.divCash,
    splitFactor: bar.splitFactor,
    source: bar.source,
    tier: "LOADED",
  }));
}

/** Distinct UTC bar years, ascending. The `UsInstrument.hotLoadedYears` entry. */
export function hotLoadedYearsForBars(bars: readonly CandleBar[]): number[] {
  const years = new Set<number>();
  for (const bar of bars) {
    const year = bar.ts.getUTCFullYear();
    // An `Invalid Date` yields NaN, and a NaN in an `Int[]` column is a write
    // that either throws inside Prisma or lands as `null` in an array of
    // integers — both worse than dropping one bar's year.
    if (Number.isInteger(year)) years.add(year);
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * Timestamps per `(symbol, exchange, timeframe)` series, ascending.
 *
 * The separator is NUL for {@link candleKey}'s reason: exchange names carry
 * spaces (`NYSE ARCA`), so a printable delimiter lets two different series
 * collide onto one group.
 */
export function groupTimestampsBySeries(bars: readonly CandleBar[]): Array<{
  symbol: string;
  exchange: string;
  timeframe: string;
  timestamps: Date[];
}> {
  const groups = new Map<
    string,
    { symbol: string; exchange: string; timeframe: string; timestamps: Date[] }
  >();
  for (const bar of bars) {
    const key = `${bar.symbol}\u0000${bar.exchange}\u0000${bar.timeframe}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        symbol: bar.symbol,
        exchange: bar.exchange,
        timeframe: bar.timeframe,
        timestamps: [],
      };
      groups.set(key, group);
    }
    group.timestamps.push(bar.ts);
  }
  for (const group of groups.values()) {
    group.timestamps.sort((a, b) => a.getTime() - b.getTime());
  }
  return [...groups.values()];
}

/** Timestamps per `updateMany`. One `$in` term against the four-part index. */
export const HOT_LOAD_STAMP_CHUNK = 500;

/**
 * One `prisma.candle.updateMany` argument: refresh `hotLoadedAt`, nothing else.
 *
 * `where.tier` is the LITERAL type rather than `string`, so a call site cannot
 * widen it to a negative or absent test without failing the compile.
 */
export interface HotLoadStampUpdate {
  where: {
    symbol: string;
    exchange: string;
    timeframe: string;
    ts: { in: Date[] };
    /** POSITIVE, always. See {@link buildHotLoadStampUpdates}. */
    tier: "LOADED";
  };
  data: { hotLoadedAt: Date };
}

/**
 * THE FIX FOR THE TRAP: refresh `hotLoadedAt` INDEPENDENTLY of price-source
 * precedence.
 *
 * ## The trap, stated exactly
 *
 * The obvious write-back is `putCandles(rows, tier: "LOADED")` and nothing
 * else. That is correct exactly ONCE. On every repeat,
 * {@link partitionCandleWrites} finds the row already present at an
 * equal-or-stronger `source` and takes the PRESERVE path — no create, no
 * upgrade, no `$set`, and therefore no new `hotLoadedAt`. A series somebody
 * reads every single day would keep the timestamp of the FIRST read forever,
 * age past the eviction cutoff 30 days later, and be deleted out from under a
 * live reader; and the `hotLoadedYears` ledger would go on claiming a year that
 * is no longer hot. Nothing errors. The chart just gets slower, once, silently.
 *
 * Preserve-on-equal is not the bug and must not be "fixed" — it is what keeps a
 * re-run idempotent and stops a historical replay clobbering the nightly's copy
 * of a bar (see {@link partitionCandleWrites}). The two facts simply do not
 * belong to the same rule: `source` ranks WHO WROTE THE PRICE, `hotLoadedAt`
 * records WHEN SOMEBODY LAST READ IT. So the stamp gets its own write, naming
 * `hotLoadedAt` and NOTHING else — no price column, no `source`, nothing
 * precedence has an opinion about.
 *
 * ## Two properties this shape must keep, both pinned by tests
 *
 *   - `data` carries ONLY `hotLoadedAt`. The moment it also carried a price or
 *     a `source`, this write would need a precedence decision and the trap
 *     would be back by a different door.
 *   - `where.tier` is `"LOADED"`, matched POSITIVELY. It is what stops the
 *     refresh flipping a `WINDOW` row into the 30-day lane, and it is the query
 *     `@@index([tier, hotLoadedAt])` exists for. Testing `hotLoadedAt` for null
 *     instead would match ZERO rows on Mongo, where a `db push` creates indexes
 *     and not fields (MONEY-1050 / 1205 / 1234 / 1235).
 *
 * The clock is a parameter for the reason it is one everywhere else in this
 * module: a stamp read from a hidden `new Date()` is a stamp no test can put on
 * either side of the cutoff.
 */
export function buildHotLoadStampUpdates(
  bars: readonly CandleBar[],
  now: Date,
  chunkSize: number = HOT_LOAD_STAMP_CHUNK,
): HotLoadStampUpdate[] {
  const out: HotLoadStampUpdate[] = [];
  for (const group of groupTimestampsBySeries(bars)) {
    for (const slice of chunk(group.timestamps, chunkSize)) {
      out.push({
        where: {
          symbol: group.symbol,
          exchange: group.exchange,
          timeframe: group.timeframe,
          ts: { in: slice },
          tier: "LOADED",
        },
        data: { hotLoadedAt: now },
      });
    }
  }
  return out;
}
