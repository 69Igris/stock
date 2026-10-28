/**
 * The US transaction-cost model's ARITHMETIC — MONEY-1373. Pure, zero I/O.
 *
 * Turns a stream of top-of-book quotes into a median and a 75th-percentile
 * spread per `(listing, time-of-day)`, plus a liquidity tier per listing. The
 * builder does the reading and the writing; everything that can be silently
 * wrong lives here.
 *
 * ## Why a RESERVOIR and not a running quantile
 *
 * A year of `bbo-1m` over 503 symbols is ~50 million records. Holding every
 * spread to sort it is tens of gigabytes; a streaming quantile sketch (t-digest,
 * P²) is approximate in a way that is hard to test and harder to explain to
 * someone reading a backtest. A fixed 4,096-slot reservoir per cell is bounded,
 * EXACT whenever a cell has 4,096 samples or fewer, and uniformly random above
 * that — and the randomness is SEEDED, so two builds of the same input produce
 * the same model. A cost model that changed on re-run would make a backtest
 * unreproducible in exactly the way version-pinning exists to prevent.
 */

import {
  US_EARLY_CLOSE_MINUTES,
  US_POST_CLOSE_MINUTES,
  US_PRE_OPEN_MINUTES,
  US_RTH_CLOSE_MINUTES,
  US_RTH_OPEN_MINUTES,
  getUsEarlyClose,
  usEtMinutesFromMidnight,
} from "../us-market-hours";
import type { LiquidityTier, TodBucket } from "@usemoney/types/us-cost-model";

/* ─────────────────────────────────────────────────────────────────────────
   Bucketing
   ──────────────────────────────────────────────────────────────────────── */

/** Minutes of "the closing window", ahead of whatever the session's close is. */
const CLOSE_WINDOW_MINUTES = 30;
/** Minutes of "the opening window", after the bell. */
const OPEN_WINDOW_MINUTES = 30;

/**
 * Which time-of-day bucket an instant falls in.
 *
 * THE CLOSE IS THE SESSION'S OWN CLOSE, not a fixed 16:00. On an early-close
 * day the real closing auction is at 13:00, so `CLOSE30` is 12:30–12:59 and
 * `POST` starts at 13:00. A fixed grid would file that auction under `MID` and
 * leave `CLOSE30` measuring an empty post-market — a cell full of wide,
 * meaningless spreads that a backtest would then charge every closing trade.
 *
 * Before 04:00 and from 20:00 the market is shut. Those quotes are `null` and
 * the caller DROPS them rather than folding them into `PRE` or `POST`: a quote
 * outside the session is either a vendor artefact or a clock bug, and either
 * way it is not a cost anyone can pay.
 */
export function todBucketFor(at: Date): TodBucket | null {
  const ms = at.getTime();
  // MEMOISED ON THE UTC MINUTE, and that is exact rather than approximate:
  // every US timezone offset is a whole number of hours, so all instants
  // inside one UTC minute share one ET minute-of-day AND one ET calendar date
  // — which is everything the answer depends on.
  //
  // It is here because this is the fold's wall. Measured 2026-09-07 on node
  // 22: `todBucketFor` 0.145 M rows/s, of which `usEtMinutesFromMidnight` and
  // `getUsEarlyClose` are two Intl-backed conversions per call. The tbbo leg
  // folds ~250M rows in one build, so the uncached path is ~29 minutes of pure
  // date formatting inside a 2 h task timeout, before a single byte is parsed.
  // A `tbbo` file carries thousands of prints per minute and a `bbo-1m` file
  // carries one per symbol per minute, so both collapse onto the same key.
  //
  // ONE ENTRY, not a Map: rows within a file are time-ordered, so the last
  // answer is the next answer almost always, and a growing cache over a 92-day
  // fold would hold ~132,000 entries for no extra hit rate.
  const minuteKey = Math.floor(ms / 60_000);
  if (minuteKey === todCacheKey) return todCacheValue;

  const minutes = usEtMinutesFromMidnight(at);
  const close =
    getUsEarlyClose(at) === null
      ? US_RTH_CLOSE_MINUTES
      : US_EARLY_CLOSE_MINUTES;

  const bucket: TodBucket | null =
    minutes < US_PRE_OPEN_MINUTES
      ? null
      : minutes < US_RTH_OPEN_MINUTES
        ? "PRE"
        : minutes < US_RTH_OPEN_MINUTES + OPEN_WINDOW_MINUTES
          ? "OPEN30"
          : minutes < close - CLOSE_WINDOW_MINUTES
            ? "MID"
            : minutes < close
              ? "CLOSE30"
              : minutes < US_POST_CLOSE_MINUTES
                ? "POST"
                : null;
  todCacheKey = minuteKey;
  todCacheValue = bucket;
  return bucket;
}

/**
 * The one-entry memo behind {@link todBucketFor}.
 *
 * Module scope, and deliberately NOT reset between files: the key is an
 * absolute UTC minute, so a stale entry can only ever be hit by an instant
 * that would compute the same answer. `NaN` never equals itself, which is what
 * makes it a safe "empty" — an Invalid Date cannot collide with it either.
 */
let todCacheKey = Number.NaN;
let todCacheValue: TodBucket | null = null;

/* ─────────────────────────────────────────────────────────────────────────
   One quote
   ──────────────────────────────────────────────────────────────────────── */

export interface QuoteSample {
  spreadBps: number;
  quotedSizeShares: number;
}

export type QuoteRejection = "empty" | "nonpositive" | "crossed";

/**
 * A quote's spread in basis points, or the named reason it is unusable.
 *
 * `ask <= bid` is a CROSSED or locked book. It occurs in real consolidated
 * data — two venues at the top with no single clearing price — and it is not a
 * negative cost: the arithmetic would produce a zero or negative spread that
 * pulls a median down and makes a symbol look cheaper to trade than it is. The
 * `<=` matters as much as the `<`: a locked book (ask exactly equal to bid)
 * yields a spread of zero, which is the same lie with a friendlier face.
 */
export function quoteSample(
  bid: number,
  ask: number,
  bidSize: number,
  askSize: number,
): QuoteSample | { rejected: QuoteRejection } {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    return { rejected: "empty" };
  }
  if (bid <= 0 || ask <= 0) return { rejected: "nonpositive" };
  if (ask <= bid) return { rejected: "crossed" };
  const mid = (bid + ask) / 2;
  return {
    spreadBps: ((ask - bid) / mid) * 10_000,
    quotedSizeShares:
      Number.isFinite(bidSize) && Number.isFinite(askSize)
        ? (bidSize + askSize) / 2
        : NaN,
  };
}

/**
 * The EFFECTIVE spread of one trade against the prevailing mid.
 *
 * Doubled, and that is the convention rather than a mistake: the effective
 * half-spread is `|price - mid|`, and doubling it puts the number on the same
 * scale as the quoted spread so the two can sit in one row and be compared. A
 * trade at the ask on an uncrossed book gives exactly the quoted spread, which
 * is the property the golden test pins.
 */
export function effectiveSpreadBps(
  price: number,
  bid: number,
  ask: number,
): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const quote = quoteSample(bid, ask, NaN, NaN);
  if ("rejected" in quote) return null;
  const mid = (bid + ask) / 2;
  return (2 * Math.abs(price - mid) * 10_000) / mid;
}

/* ─────────────────────────────────────────────────────────────────────────
   The reservoir
   ──────────────────────────────────────────────────────────────────────── */

export const RESERVOIR_SIZE = 4_096;

/**
 * A deterministic xorshift32.
 *
 * `Math.random()` would make the model differ between two builds of identical
 * input, which is the one thing a version-pinned cost model must not do — a
 * backtest re-run against "the same" model would produce a different P&L and
 * nothing in the output would say why. Seeded per cell from the cell's own
 * key, so cells are independent and the order files are read in does not
 * matter.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Zero is a fixed point of xorshift — it produces zero forever, which
    // would make one cell's reservoir keep only its first 4,096 samples while
    // every other cell sampled properly.
    this.state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  /** A non-negative integer below `bound`. */
  next(bound: number): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    // LOGICAL shift. `>>` is arithmetic and sign-extends, which breaks the
    // bijection xorshift32 depends on: measured, 400,000 distinct inputs
    // produced 399,976 distinct outputs, so the full period is not guaranteed.
    // Uniformity was clean in practice; this is the one-character fix.
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x % bound;
  }
}

/** FNV-1a over a cell key, so a cell's seed is stable across builds. */
export function seedForCell(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Algorithm R: uniform over the whole stream, in bounded memory.
 *
 * `count` keeps growing after the reservoir fills — it is the SAMPLE COUNT the
 * row reports, and it is what tells a reader that a 1.2 bps median came from
 * forty thousand quotes rather than four. Reporting `values.length` instead
 * would cap every busy cell at 4,096 and make a thin cell indistinguishable
 * from a thick one.
 */
export class Reservoir {
  readonly values: number[] = [];
  private countInternal = 0;
  private readonly rng: SeededRandom;

  constructor(
    seed: number,
    readonly capacity: number = RESERVOIR_SIZE,
  ) {
    this.rng = new SeededRandom(seed);
  }

  get count(): number {
    return this.countInternal;
  }

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    this.countInternal++;
    if (this.values.length < this.capacity) {
      this.values.push(value);
      return;
    }
    const j = this.rng.next(this.countInternal);
    if (j < this.capacity) this.values[j] = value;
  }
}

/**
 * The p-th percentile of a reservoir, by NEAREST RANK.
 *
 * Nearest-rank rather than interpolation, deliberately. An interpolated median
 * invents a value that no quote ever had; on a tick-constrained book — where
 * the spread really is one cent or two cents and nothing between — that
 * produces a "1.5 cent" median spread which is not a price anyone could have
 * traded at. The nearest-rank answer is always a spread that actually occurred.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  if (p < 0 || p > 1) {
    throw new RangeError(`percentile: p must be in [0,1], got ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[rank]!;
}

/* ─────────────────────────────────────────────────────────────────────────
   Cells
   ──────────────────────────────────────────────────────────────────────── */

export interface CostCell {
  listingId: string;
  symbol: string;
  todBucket: TodBucket;
  spread: Reservoir;
  quotedSize: Reservoir;
  effective: Reservoir;
}

export function cellKey(listingId: string, bucket: TodBucket): string {
  return `${listingId}|${bucket}`;
}

export function newCell(
  listingId: string,
  symbol: string,
  todBucket: TodBucket,
): CostCell {
  const key = cellKey(listingId, todBucket);
  // Three DIFFERENT seeds from one key. Sharing a seed would make the quoted
  // size reservoir keep exactly the records the spread reservoir kept, so a
  // cell's two statistics would be drawn from one sub-sample rather than two
  // independent ones.
  const base = seedForCell(key);
  return {
    listingId,
    symbol,
    todBucket,
    spread: new Reservoir(base),
    quotedSize: new Reservoir(base ^ 0x5bf03635),
    effective: new Reservoir(base ^ 0x27d4eb2f),
  };
}

export interface CostCellSummary {
  listingId: string;
  symbol: string;
  todBucket: TodBucket;
  medianSpreadBps: number;
  p75SpreadBps: number;
  sampleCount: number;
  medianQuotedSizeShares?: number;
  effectiveSpreadBps?: number;
  effectiveSampleCount?: number;
}

/**
 * A cell's row, or `null` when it has no usable quotes.
 *
 * `null`, not a row of zeros. A zero-spread row reads as a free-to-trade
 * listing and would make a backtest of an illiquid name look like its best
 * idea; an absent row makes the reader say "no estimate", which is the true
 * answer.
 */
export function summarizeCell(cell: CostCell): CostCellSummary | null {
  if (cell.spread.count === 0) return null;
  const summary: CostCellSummary = {
    listingId: cell.listingId,
    symbol: cell.symbol,
    todBucket: cell.todBucket,
    medianSpreadBps: percentile(cell.spread.values, 0.5),
    p75SpreadBps: percentile(cell.spread.values, 0.75),
    sampleCount: cell.spread.count,
  };
  if (cell.quotedSize.count > 0) {
    summary.medianQuotedSizeShares = percentile(cell.quotedSize.values, 0.5);
  }
  if (cell.effective.count > 0) {
    summary.effectiveSpreadBps = percentile(cell.effective.values, 0.5);
    summary.effectiveSampleCount = cell.effective.count;
  }
  return summary;
}

/* ─────────────────────────────────────────────────────────────────────────
   Liquidity tiers
   ──────────────────────────────────────────────────────────────────────── */

export interface ListingLiquidity {
  listingId: string;
  /** Trailing median of daily Σ(volume × close). */
  medianDollarVolume: number;
}

/**
 * Terciles of dollar volume WITHIN the population handed in.
 *
 * Relative, not absolute. Fixed dollar thresholds would re-tier the whole
 * universe on a market-wide move, which renders as every stock's liquidity
 * changing at once — and would silently reclassify a backtest's cost basis
 * between two builds that measured the same behaviour.
 *
 * Sorted DESCENDING with the ties broken by `listingId`, so two listings with
 * identical volume always land the same way round. Without that a re-build
 * could move a listing across a tier boundary on nothing but iteration order.
 */
export function assignTiers(
  listings: readonly ListingLiquidity[],
): Map<string, LiquidityTier> {
  const usable = listings.filter(
    (l) => Number.isFinite(l.medianDollarVolume) && l.medianDollarVolume > 0,
  );
  const out = new Map<string, LiquidityTier>();
  if (usable.length === 0) {
    // Everything unknown is T3, the most conservative tier. Defaulting to T1
    // would cost an unmeasurable listing as if it were the most liquid thing
    // in the universe.
    for (const l of listings) out.set(l.listingId, "T3");
    return out;
  }
  const sorted = [...usable].sort(
    (a, b) =>
      b.medianDollarVolume - a.medianDollarVolume ||
      (a.listingId < b.listingId ? -1 : 1),
  );
  const third = Math.ceil(sorted.length / 3);
  sorted.forEach((l, i) => {
    out.set(l.listingId, i < third ? "T1" : i < third * 2 ? "T2" : "T3");
  });
  for (const l of listings)
    if (!out.has(l.listingId)) out.set(l.listingId, "T3");
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   When to rebuild
   ──────────────────────────────────────────────────────────────────────── */

export interface LatestVersion {
  modelVersion: number;
  builtAt: Date;
  status: string;
}

/**
 * Monthly, or on demand.
 *
 * The version bumps HERE and nowhere else. Rebuilding on every append would
 * give a backtest a different cost basis every night and make two runs of one
 * strategy incomparable — and a model built from one extra day of quotes is
 * not meaningfully better than yesterday's.
 *
 * A `FAILED` or still-`BUILDING` latest version rebuilds regardless of the
 * month: a half-written table is not a model, and leaving it as the newest
 * version would have a reader pin to it.
 */
export function shouldRebuildCostModel(
  now: Date,
  latest: LatestVersion | null,
  forced = false,
): boolean {
  if (forced) return true;
  if (latest === null) return true;
  if (latest.status !== "READY") return true;
  return (
    latest.builtAt.getUTCFullYear() !== now.getUTCFullYear() ||
    latest.builtAt.getUTCMonth() !== now.getUTCMonth()
  );
}
