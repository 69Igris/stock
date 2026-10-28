/**
 * The US transaction-cost model, as READ — MONEY-1373.
 *
 * ## Why this lives in `packages/types` and not in a `packages/quant`
 *
 * There is no quant workspace, and adding one for four interfaces would be a
 * build-graph entry, an eslint config and a tsconfig for a file that declares
 * no behaviour. Founder decision: the shapes go here, beside `pubsub.ts`, and
 * the workspace arrives when something needs to COMPUTE rather than describe.
 *
 * ## The field names ARE the Mongo field names
 *
 * That is the contract, and it is load-bearing rather than incidental. The
 * quant engine is PYTHON and reads these two collections directly from Mongo —
 * it cannot import this file, so a rename here that "only changes TypeScript"
 * silently breaks a consumer no TypeScript build can see. Rename a field only
 * alongside the Prisma model and the Python reader, in one change.
 *
 * ## Reads are VERSION-PINNED, always
 *
 * A backtest must stay re-runnable. Run against March's spreads and re-run in
 * September against September's, and the same strategy produces two different
 * P&Ls from identical inputs — with nothing in either result to say why. So
 * {@link UsCostModelQuery} makes `modelVersion` REQUIRED rather than defaulting
 * to the latest: "the newest model" is never a safe default for a number
 * somebody is going to compare against a number from last quarter.
 */

/**
 * Where a listing sits in the liquidity distribution.
 *
 * Terciles of trailing median daily dollar volume WITHIN THE BASELINE, not
 * against absolute thresholds. A fixed cut-off in dollars would re-tier the
 * whole universe on a market-wide move, which looks like every stock's
 * liquidity changing at once.
 */
export type LiquidityTier = "T1" | "T2" | "T3";

/**
 * Time-of-day bucket, on the ET clock.
 *
 *   PRE      04:00–09:29
 *   OPEN30   09:30–09:59
 *   MID      10:00–15:29
 *   CLOSE30  15:30–15:59
 *   POST     16:00–19:59
 *
 * The open and close are split out because a spread measured across the whole
 * session is an average of two regimes that differ by an order of magnitude,
 * and a backtest that trades the open would be costed at the midday number.
 *
 * ON AN EARLY-CLOSE DAY the boundaries MOVE: CLOSE30 is 12:30–12:59 and POST
 * begins at 13:00. The bucket is defined against the session's own close, not
 * against 16:00 — on a half day the real closing auction happens at 13:00, and
 * a fixed grid would file it under MID and leave CLOSE30 measuring an empty
 * post-market.
 */
export type TodBucket = "PRE" | "OPEN30" | "MID" | "CLOSE30" | "POST";

/** One BUILD of the model. */
export interface UsCostModelVersionRead {
  modelVersion: number;
  /** Inclusive ISO date of the first session sampled. */
  builtFrom: string;
  /** EXCLUSIVE ISO date — the same convention the vendor and the inventory use. */
  builtTo: string;
  builtAt: string;
  /**
   * `BUILDING` is written BEFORE the rows and is not a transient nobody sees:
   * a build that dies half-way leaves it, and a reader that treated any
   * existing version as usable would cost a backtest against a partial table.
   */
  status: "BUILDING" | "READY" | "FAILED";
  rowCount: number;
  symbolCount: number;
  /**
   * The window the EFFECTIVE-spread sample came from, when there was one.
   *
   * SEPARATE from `builtFrom`/`builtTo`, and it has to be. The quoted spread
   * is sampled over the 365 days those two describe; the effective spread is
   * sampled from the archived `tbbo` entry, which is `append: false` — bought
   * once and never topped up — so its window is anchored at the ARCHIVE and
   * stops moving the day the harvest finishes.
   *
   * Absent means no trade file was folded and `effectiveSpreadBps` is absent
   * from every row of this version. Present and OLD is the honest signal that
   * a reader needs: in year three a version stamped `builtFrom = now-365d`
   * carries an effective column sampled from a fixed 92 days two years
   * earlier, and without these two fields nothing in either collection says
   * so. The quant engine is PYTHON and reads these collections directly, so a
   * fact that lives only in a TypeScript comment does not reach it.
   */
  effectiveFrom?: string;
  /** EXCLUSIVE. See {@link UsCostModelVersionRead.effectiveFrom}. */
  effectiveTo?: string;
  /** How many `tbbo` files were folded. 0 when the leg found nothing. */
  effectiveFileCount?: number;
}

/** One `(listing, time-of-day)` cell of a build. */
export interface UsCostModelRowRead {
  modelVersion: number;
  /** `{symbol}:{exchange}:{listingStartDate}` — tickers recycle. */
  listingId: string;
  symbol: string;
  liquidityTier: LiquidityTier;
  todBucket: TodBucket;
  /** QUOTED half-spread doubled: `(ask - bid) / mid * 1e4`. */
  medianSpreadBps: number;
  /**
   * The tail, and the reason a median alone is not enough: a strategy sized to
   * the median pays the p75 on the days it most wants to trade.
   */
  p75SpreadBps: number;
  /**
   * Quotes behind the median. A cell built from four quotes is not a cost
   * estimate, and without this a reader cannot tell it from one built from
   * forty thousand.
   */
  sampleCount: number;
  medianQuotedSizeShares?: number;
  /**
   * From TRADES, where we have them: `2 * |price - mid| / mid * 1e4`.
   *
   * Optional because it is only sampled for the top-50 names — the quoted
   * spread is what every listing has, and the effective spread is what a
   * subset can be checked against.
   */
  effectiveSpreadBps?: number;
  effectiveSampleCount?: number;
}

/** A read. `modelVersion` is REQUIRED — see the module header. */
export interface UsCostModelQuery {
  modelVersion: number;
  listingIds?: string[];
  todBucket?: TodBucket;
}

/**
 * The Mongo collection names, for the Python side.
 *
 * Declared here rather than left to each reader because the Python engine
 * spells them as strings and nothing type-checks that spelling. Two consumers
 * hardcoding one name is how a collection ends up read under a name nothing
 * writes — the `db.trades` shape, where a missing `@@map` made a query return
 * zero rows from a collection that does not exist.
 */
export const US_COST_MODEL_COLLECTIONS = {
  versions: "us_cost_model_versions",
  rows: "us_cost_model_rows",
} as const;
