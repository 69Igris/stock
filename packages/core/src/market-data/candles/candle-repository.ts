/**
 * `CandleRepository` — the single door to OHLCV bars (MONEY-980, TASK 4).
 *
 * Three responsibilities, none of which a caller should have to know about:
 *
 *   1. **Hot + cold, merged transparently.** Mongo holds a hot window — an
 *      ACTIVE listing's last `HOT_WINDOW_YEARS` (10) — and everything else
 *      (every year of a delisted listing, a live one's pre-window years) is a
 *      gzipped object per
 *      symbol-year in GCS. 24,328 US securities × ~9.5y ≈ 231,825 symbol-years
 *      and 200M+ daily rows in total, which is why they are not all in Mongo.
 *      A read spans both and returns one series; nothing downstream can tell
 *      which half answered, and nothing downstream should have to.
 *   2. **Adjustment at read time.** Raw prices are stored; the split/dividend
 *      -adjusted series is computed per request from `divCash` + `splitFactor`.
 *      Storing adjusted closes instead would restate up to 11,517 rows (AAPL,
 *      measured) on every corporate action; computing on read turns the same
 *      event into a cache invalidation. It is also the MONEY-1175 lesson stated
 *      in a schema: Yahoo's stored `close` is split-ADJUSTED while bhavcopy's is
 *      RAW, and mixing the two in one series draws a cliff at every action.
 *   3. **Listing identity.** A bare-symbol read returns ONE security. `DOW` on
 *      NYSE is Dow Chemical (1972-2017) AND Dow Inc. (2019-2026) and the unique
 *      index cannot separate them, because their windows never overlap and there
 *      is no key collision to detect. See `selectSingleListing`.
 *
 * Every non-trivial decision lives in `candle-logic.ts`, which has zero I/O.
 * This file is the wiring: Prisma, the cold-store port, and the ordering between
 * them.
 */

import { prisma } from "@usemoney/database";
import {
  adjustCandleSeries,
  barMatchesVenue,
  barsNeedingHotLoadStamp,
  buildHotLoadStampUpdates,
  candleKey,
  chunk,
  classifyCandleRowWriteError,
  coldYearsForRange,
  groupColdShards,
  groupWritesBySeries,
  hotLoadedYearsForBars,
  marketForExchange,
  mergeHotAndCold,
  newestTsForVenue,
  partitionCandlesByDestination,
  partitionCandleWrites,
  promotableColdBars,
  sanitizeCandleWrites,
  selectSingleListing,
  sliceRange,
  toHotLoadWriteRows,
  HOT_WINDOW_YEARS,
  type AdjustedCandleBar,
  type CandleBar,
  type CandleTier,
  type CandleWriteRow,
  type HotCandleRow,
  type ListingResolution,
  type NormalizedCandleWrite,
} from "./candle-logic";
import {
  ColdStoreUnavailableError,
  evictColdShard,
  getCandleColdStore,
  readColdShard,
  writeColdShard,
} from "./candle-cold-store";

/* ─────────────────────────────────────────────────────────────────────────
   Tuning constants
   ──────────────────────────────────────────────────────────────────────── */

/**
 * How many `(symbol, exchange, timeframe, ts-range)` predicates go into ONE
 * diff query's `OR`.
 *
 * The diff has to be one bounded `findMany` per chunk rather than one per row —
 * `feed-parse`'s `writeCash` is the model, and the per-row shape it replaced
 * turned a single backfilled year into over a million sequential calls. An `OR`
 * of narrow per-series predicates is used instead of a flat
 * `symbol: { in: [...] }` + global `ts` range because the latter is a CROSS
 * PRODUCT: batching one symbol's 46-year history alongside today's 24,328-symbol
 * EOD run would ask Mongo for every symbol over every year. Each `OR` branch is
 * served by `@@index([symbol, exchange, timeframe, ts])`.
 */
export const CANDLE_DIFF_OR_BRANCHES = 200;

/** Rows per `createMany` / per bulk-update command. */
export const CANDLE_WRITE_CHUNK = 1_000;

/**
 * How long a READ may spend on its own write-back before it stops waiting.
 *
 * The write-back is inline by default (see {@link HotLoadLane}), so a wedged
 * Mongo would otherwise hold a chart request open for as long as the driver's
 * own timeout. This bounds the READER's wait only: the work keeps running, and
 * it stays in `inFlightHotLoads` so {@link CandleRepository.settleHotLoads}
 * still awaits it. Nothing is cancelled, so no state is torn — the outcome is
 * reported as `deadline` and the next read repairs whatever did not finish.
 */
export const HOT_LOAD_INLINE_DEADLINE_MS = 2_000;

/* ─────────────────────────────────────────────────────────────────────────
   Public shapes
   ──────────────────────────────────────────────────────────────────────── */

export interface CandleQuery {
  symbol: string;
  exchange: string;
  timeframe: string;
  /** Inclusive lower bound. */
  from: Date;
  /** Inclusive upper bound. */
  to: Date;
  /** Return the back-adjusted series alongside the raw one. */
  adjusted?: boolean;
  /**
   * Select a SPECIFIC occupancy window (`{symbol}:{exchange}:{listingStartDate}`).
   * Omit for "the security trading under this ticker today".
   */
  listingId?: string;
  /** Overrides the exchange-derived market used in the cold key. */
  market?: string;
  /** Consult the cold store. Default true. */
  cold?: boolean;
  /**
   * What to do when a cold shard could not be READ (as opposed to being absent).
   *
   * `throw` (default) — a truncated price series is worse than an error,
   * because it is not visibly wrong: it just draws a shorter chart and computes
   * a smaller CAGR. `degrade` returns what we have with `meta.degraded = true`
   * and the failing years listed, for a caller that has explicitly decided a
   * partial series is better than none.
   */
  onColdFailure?: "throw" | "degrade";
  /**
   * Promote a cold HIT into Mongo as `tier: "LOADED"`. Default true.
   *
   * Turn it OFF for a read that must not change what the store holds — a
   * reconcile, an audit, a one-shot deep-history export whose 46 years would
   * otherwise be pulled into a hot window sized for 10. It never affects the
   * bars returned: the promotion is decided AFTER the answer is assembled (see
   * {@link CandleRepository.planHotLoad}).
   */
  writeBack?: boolean;
  /**
   * Which lane the write-back runs in. Default `inline` — see {@link HotLoadLane}.
   *
   * Per-read rather than per-repository because the RUNTIME is what decides it
   * and one process can serve both shapes: a worker looping over symbols wants
   * `background`, a request handler in the same binary does not.
   */
  hotLoadLane?: HotLoadLane;
  /**
   * Refresh `hotLoadedAt` on a served `LOADED` row only once it is this old.
   * Default `HOT_LOAD_STAMP_MAX_AGE_MS` (24h); `0` refreshes on every read.
   *
   * Exposed for tests and for a caller that has measured a reason. It is a
   * WRITE BUDGET, not a correctness knob — see the constant's doc for why it is
   * deliberately not derived from the eviction TTL.
   */
  hotLoadStampMaxAgeMs?: number;
}

/**
 * WHERE the read's write-back runs, and the one thing each lane costs.
 *
 * ## `inline` — the default, and the only one that is safe on Vercel
 *
 * The write-back is AWAITED before `getCandles` returns, bounded by
 * {@link HOT_LOAD_INLINE_DEADLINE_MS}.
 *
 * The lane exists because the obvious alternative is wrong in the runtime this
 * repository's first reader will live in. A floating promise on Vercel is not
 * "work that finishes slightly later" — post-response async work is SUSPENDED,
 * there is no `after()` or `waitUntil` anywhere in `apps/web`, and the
 * suspension is silent. `stale-while-error.ts`'s `run.catch(() => {})` is not a
 * precedent for it either: that promise is a single-flight leader the request
 * still AWAITS through `withDeadline`. So a fire-and-forget default would have
 * reported `hotLoadScheduled: true` on every serverless read while the
 * promotion never happened.
 *
 * The cost is latency, and it is bounded by design rather than by hope. The
 * expensive step is `putCandles`, which only runs on a read that actually
 * pulled a cold year back — the read that most needs it and the one that makes
 * every later read cheap. On a warm repeat read the whole write-back is a stamp
 * refresh, and the 24h staleness budget skips even that on all but one read a
 * day; the common case is ZERO extra work and outcome `idle`.
 *
 * ## `background` — opt-in, and only for a runtime that outlives the response
 *
 * The old default: started, not awaited, deduped by series through
 * `inFlightHotLoads`, drained by {@link CandleRepository.settleHotLoads}.
 * Correct in a worker or a script, where the process is still there when the
 * write lands. NEVER select it from a serverless request handler.
 */
export type HotLoadLane = "inline" | "background";

/**
 * What the read's write-back actually did. One value per REACHABLE state.
 *
 * This replaces a `hotLoadScheduled: boolean` that could not tell the states
 * apart: `false` was returned for the India skip, for "nothing to do", and for
 * "another read is already doing it", and `hotLoadBars` was zeroed for all
 * three. Three different operational answers — a wiring bug, healthy, and
 * healthy-under-concurrency — collapsed into one number that read as the first.
 */
export type HotLoadOutcome =
  /** `writeBack: false`. The caller asked for a read that changes nothing. */
  | "off"
  /** `marketForExchange(exchange) !== "US"`. India has no rows to promote. */
  | "not-us"
  /** Nothing to promote and every served `LOADED` row's stamp is fresh. */
  | "idle"
  /** A concurrent read of the SAME series + listing already owns the work. */
  | "in-flight"
  /** `inline`: ran to completion inside the deadline. */
  | "applied"
  /** `inline`: still running when {@link HOT_LOAD_INLINE_DEADLINE_MS} expired. */
  | "deadline"
  /** `inline`: threw. Absorbed and logged; the bars returned are unaffected. */
  | "failed"
  /** `background`: started and deliberately not awaited. */
  | "started";

export interface CandleReadMeta {
  hotRows: number;
  coldRows: number;
  coldStoreRegistered: boolean;
  coldYearsRequested: number;
  coldYearsPresent: number;
  coldYearsAbsent: number;
  /** Cold keys whose read FAILED. Never confused with `absent`. */
  coldYearsFailed: string[];
  /** True when `onColdFailure: "degrade"` swallowed at least one failure. */
  degraded: boolean;
  listingId: string | null;
  listingResolution: ListingResolution;
  /** Bars discarded because they belong to a different occupancy window. */
  listingsDropped: number;
  adjusted: boolean;
  /**
   * Bars fetched BEYOND `to` purely to anchor the adjustment, then discarded.
   * See {@link CandleRepository.getCandles} for why they are mandatory.
   */
  adjustmentTailBars: number;

  /* ── hot-load write-back (MONEY-980) ────────────────────────────────── */

  /**
   * Cold bars this read HANDED to the promotion — a REQUEST count, taken before
   * the write.
   *
   * Zero is the ordinary steady state and says nothing is wrong: after the
   * first promotion the bars are in Mongo, so they come back in `hotRows` and
   * `promotableColdBars` correctly declines to re-promote them. Read
   * {@link hotLoadOutcome} for WHY a given read handed over nothing.
   */
  hotLoadBars: number;
  /**
   * Rows this read ASKED to re-stamp: promoted bars plus served `LOADED` rows
   * whose `hotLoadedAt` had aged past the staleness budget.
   *
   * Also a request count, and named so it cannot be mistaken for an applied
   * one — MONEY-1255's rule. The applied number is {@link hotLoadRestamped}.
   */
  hotLoadStampBars: number;
  /**
   * Rows whose `hotLoadedAt` the driver actually moved, from `updateMany`'s own
   * `count`.
   *
   * `null` when the answer is not knowable at return time — the `background`
   * lane (the write has not run yet) and a `deadline` (it is still running).
   * `null` is deliberately not `0`: "we did not wait to find out" and "we
   * waited and nothing matched" are different findings, and a job that reported
   * the second for the first is how a dead leg looks healthy.
   */
  hotLoadRestamped: number | null;
  /** WHY the write-back did what it did. See {@link HotLoadOutcome}. */
  hotLoadOutcome: HotLoadOutcome;
}

export interface CandleSeries<B extends CandleBar = CandleBar> {
  bars: B[];
  meta: CandleReadMeta;
}

export interface CandleWriteResult {
  created: number;
  upgraded: number;
  /**
   * Existing rows this batch did NOT overwrite. Two causes, both no-ops:
   *
   *   1. the row is held by an equal-or-stronger source (the diff saw it and
   *      `partitionCandleWrites` declined to upgrade it); and
   *   2. the row appeared BETWEEN our diff and our write, so the per-row
   *      fallback's insert hit the unique index (MONEY-980).
   *
   * Both are counted here rather than in `failed` deliberately, and `preserved`
   * is the right home rather than a new counter: it is the only bucket already
   * plumbed through every consumer (`us-eod-sync` logs it and returns it;
   * `computeSelected` correctly excludes it from `owed`), so a race is VISIBLE
   * without being mistaken for lost data. A fresh field would have been
   * dropped on the floor by every reader, which is invisibility, not precision.
   *
   * The two causes stay distinguishable in the logs: (2) is always immediately
   * preceded by the `[candles] bulk insert collided` warning, and (1) never is.
   */
  preserved: number;
  /** Repeats of one natural key within the batch. */
  dupInBatch: number;
  /** Rows dropped before the write: non-finite price or an invalid `ts`. */
  droppedNonFinite: number;
  /** Volumes clamped to 0 (negative or non-finite). The bar is still written. */
  clampedVolume: number;
  /**
   * Rows that could not be written ANYWHERE.
   *
   * Two sources, deliberately in one bucket: a hot row the per-row fallback
   * could not insert or update, and a cold row whose shard write threw. The
   * second is not a new category — "could not be written" is exactly what
   * happened — and folding it in is what keeps the caller's arithmetic
   * identity closed without every consumer learning a new term. The cold half
   * is ALSO reported on its own as {@link coldFailed} for triage.
   */
  failed: number;

  /* ── tier routing (MONEY-980 C4) ────────────────────────────────────── */

  /**
   * Bars persisted to a GCS cold shard INSTEAD of Mongo.
   *
   * Not in `created`/`upgraded`/`preserved` — those three count Mongo rows.
   * A caller reconciling a fetch against a write closes on
   *
   *   created + upgraded + preserved + dupInBatch + droppedNonFinite
   *           + failed + archivedCold  ===  bars handed in
   *
   * `clampedVolume` is NOT a term (a clamped bar is still written, so it is
   * already inside one of the others) and neither is `coldFellBackToHot`,
   * which is a subset of the Mongo buckets rather than an addend.
   */
  archivedCold: number;
  /** Distinct symbol-year objects {@link archivedCold} landed in. */
  coldShards: number;
  /**
   * Cold-destined bars whose shard write THREW. Already inside `failed`.
   *
   * Reported separately because the remedy differs entirely: a hot `failed` is
   * a Mongo problem, this is GCS credentials, a bucket, or a deadline.
   */
  coldFailed: number;
  /**
   * Cold-destined bars written to MONGO because NO COLD STORE IS REGISTERED.
   *
   * A subset of `created`/`upgraded`/`preserved`, never an addend.
   *
   * The alternative was dropping them, and dropping is the failure class this
   * whole module is written against — `ColdShardOutcome` splits `failed` from
   * `absent` for exactly this reason. A row in Mongo is readable and correct;
   * a row nowhere is a shorter chart nobody can see. So the fallback is the
   * data-preserving direction, it is LOUD (a `console.error` per call), and it
   * is counted here so "the cold tier is not actually running" is a number
   * rather than a suspicion.
   *
   * In the shipped runtimes this should be 0: the worker registers a store at
   * boot and the backfill refuses to start without one.
   */
  coldFellBackToHot: number;
}

/* ─────────────────────────────────────────────────────────────────────────
   Repository
   ──────────────────────────────────────────────────────────────────────── */

export interface CandleRepositoryOptions {
  /** Injected for deterministic tests. */
  now?: () => Date;
  /**
   * Lane for reads that do not name one. Default `inline`.
   *
   * A worker or script that reads in a loop can flip its whole process to
   * `background` here instead of threading the option through every call site.
   * A serverless runtime must leave it alone.
   */
  hotLoadLane?: HotLoadLane;
  /** How long an `inline` write-back may hold the read. Default 2s. */
  hotLoadDeadlineMs?: number;
}

export class CandleRepository {
  private readonly now: () => Date;
  private readonly defaultHotLoadLane: HotLoadLane;
  private readonly hotLoadDeadlineMs: number;
  /**
   * Write-backs in flight, keyed by series + listing.
   *
   * A MAP rather than a Set because the values are what {@link
   * CandleRepository.settleHotLoads} awaits. Every stored promise has already
   * absorbed its own error, so nothing here can reject.
   *
   * BOTH lanes register here, and that is what stops the inline lane's deadline
   * from orphaning a handle: an `inline` read that stops waiting leaves the work
   * running, and a test still drains it through `settleHotLoads()`.
   */
  private readonly inFlightHotLoads = new Map<string, Promise<void>>();

  constructor(options: CandleRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.defaultHotLoadLane = options.hotLoadLane ?? "inline";
    const deadline = options.hotLoadDeadlineMs;
    this.hotLoadDeadlineMs =
      typeof deadline === "number" && Number.isFinite(deadline) && deadline > 0
        ? deadline
        : HOT_LOAD_INLINE_DEADLINE_MS;
  }

  /**
   * Read a series, hot + cold, optionally adjusted, for exactly one security.
   *
   * ## Why an adjusted read fetches PAST `to`
   *
   * `computeAdjustedSeries` walks BACKWARD from the most recent bar, so the
   * factor applied to any bar is the product of every corporate action that
   * happened AFTER it. Adjust only the requested window and the last bar in that
   * window gets factor 1 — a series that is internally consistent, differs from
   * the full-range answer for the same dates, and CHANGES every time the caller
   * moves `to`. A chart would jump on every pan.
   *
   * So an adjusted read extends its fetch to the latest bar and slices back
   * afterwards. The cost is the tail, and it is bounded and cheap in the shape
   * that matters: `to = today` (the overwhelmingly common case) has no tail at
   * all, and a deep-history request pays a handful of extra symbol-year objects
   * that are small, immutable and cached for hours.
   *
   * A cheaper variant exists if that ever stops being true — the tail's
   * contribution is a product over ACTION bars only (`divCash > 0` or
   * `splitFactor != 1`), which is a few rows per year rather than 252. It is not
   * built because it needs each action bar's PREDECESSOR close, which is a
   * second query across the hot/cold seam for a saving nobody has measured a
   * need for. Named here so the next person does not have to rediscover it.
   */
  async getCandles(
    query: CandleQuery & { adjusted: true },
  ): Promise<CandleSeries<AdjustedCandleBar>>;
  async getCandles(query: CandleQuery): Promise<CandleSeries<CandleBar>>;
  async getCandles(query: CandleQuery): Promise<CandleSeries<CandleBar>> {
    const {
      symbol,
      exchange,
      timeframe,
      from,
      to,
      adjusted = false,
      listingId,
      cold = true,
      onColdFailure = "throw",
      writeBack = true,
    } = query;
    const market = query.market ?? marketForExchange(exchange);

    // ONE clock for the whole read, for `putCandles`' reason: the adjustment's
    // fetch bound and the stamp this read writes must be the same instant, or a
    // read that straddles midnight compares a bar against one `now` and stamps
    // it with another.
    const now = this.now();

    // The upper bound the FETCH uses, which is not the upper bound the caller
    // asked for when an adjustment is in play — see the method doc.
    const fetchTo = adjusted ? now : to;
    // A `from` after `to` is a caller bug, not an empty market. Answer empty
    // rather than issuing a query whose range can never match.
    const effectiveTo = fetchTo.getTime() < from.getTime() ? from : fetchTo;

    const [hot, coldResult] = await Promise.all([
      this.readHot({
        symbol,
        exchange,
        timeframe,
        from,
        to: effectiveTo,
        // Push the filter down ONLY for an explicit id. A hint resolved from
        // `UsInstrument` is filtered in memory instead, so a stale hint
        // costs a slightly wider scan rather than an empty result — see
        // `selectSingleListing`, which owns that rule.
        listingId,
      }),
      cold
        ? this.readCold({
            market,
            timeframe,
            symbol,
            exchange,
            from,
            to: effectiveTo,
          })
        : Promise.resolve(emptyColdResult()),
    ]);

    if (coldResult.failed.length > 0 && onColdFailure === "throw") {
      throw new ColdStoreUnavailableError(
        coldResult.failed,
        coldResult.firstError,
      );
    }

    const merged = mergeHotAndCold(hot, coldResult.bars);

    // Resolve the listing only when the caller did not name one — one indexed
    // lookup, skipped entirely on the explicit path.
    let preferred: string | null = listingId ?? null;
    let preferredKind: "explicit" | "instrument" = "explicit";
    if (preferred === null) {
      preferred = await this.resolveCurrentListingId(symbol, exchange);
      preferredKind = "instrument";
    }

    const selected = selectSingleListing(merged, preferred, preferredKind);

    // THE WRITE-BACK, in two steps that must not be collapsed: decide, then
    // run. `planHotLoad` is pure selection and owns every reason to decline;
    // `runHotLoad` owns the lane, the dedupe and the deadline. Both are decided
    // from data already computed above and neither changes a bar returned below.
    const plan = this.planHotLoad({
      writeBack,
      exchange,
      cold: coldResult.bars,
      hot,
      served: selected.bars,
      now,
      stampMaxAgeMs: query.hotLoadStampMaxAgeMs,
    });
    // What the read SELECTED, which is reported whatever the run then did with
    // it. A decline selected nothing by definition.
    const planned: HotLoadPlan =
      typeof plan === "string" ? { promote: [], restamp: [] } : plan;
    const hotLoad =
      typeof plan === "string"
        ? { outcome: plan, restamped: null }
        : await this.runHotLoad({
            symbol,
            exchange,
            timeframe,
            listingId: selected.listingId,
            plan,
            now,
            lane: query.hotLoadLane ?? this.defaultHotLoadLane,
          });

    const beforeSlice = selected.bars.length;
    let bars: CandleBar[] = selected.bars;
    let tailBars = 0;

    if (adjusted) {
      // Adjust over the FULL fetched span (including the tail), then slice.
      const adjustedBars = adjustCandleSeries(bars);
      const sliced = sliceRange(adjustedBars, from, to);
      tailBars = beforeSlice - sliced.length;
      bars = sliced;
    } else {
      bars = sliceRange(bars, from, to);
    }

    return {
      bars,
      meta: {
        hotRows: hot.length,
        coldRows: coldResult.bars.length,
        coldStoreRegistered: getCandleColdStore() !== null,
        coldYearsRequested: coldResult.requested,
        coldYearsPresent: coldResult.present,
        coldYearsAbsent: coldResult.absent,
        coldYearsFailed: coldResult.failed,
        degraded: coldResult.failed.length > 0,
        listingId: selected.listingId,
        listingResolution: selected.resolution,
        listingsDropped: selected.dropped,
        adjusted,
        adjustmentTailBars: tailBars,
        // The counts come from the PLAN, not from whether the work ran. A read
        // whose write-back hit the deadline still selected those bars, and
        // zeroing the count on a non-terminal outcome is precisely how
        // `hotLoadScheduled ? promote.length : 0` made three different states
        // report the same `(0, false)`.
        hotLoadBars: planned.promote.length,
        hotLoadStampBars: planned.promote.length + planned.restamp.length,
        hotLoadRestamped: hotLoad.restamped,
        hotLoadOutcome: hotLoad.outcome,
      },
    };
  }

  /**
   * DECIDE the write-back. Pure selection: no I/O, no clock, no writes.
   *
   * Returns the two lists the work needs, or the single reason there is none.
   * Every decline is a NAMED {@link HotLoadOutcome}, which is the whole point of
   * splitting this out — a boolean "did we schedule it" could not tell "India"
   * from "nothing to do", and the operational answers are opposite.
   *
   * ## Two lists, because one list cannot express the work
   *
   *   `promote` — cold bars Mongo does not hold. Rows to CREATE.
   *   `restamp` — served rows Mongo DOES hold, already `LOADED`, whose
   *               `hotLoadedAt` has aged past the budget. Rows to TOUCH.
   *
   * They are disjoint by construction ({@link promotableColdBars} excludes
   * every key in the hot read; {@link barsNeedingHotLoadStamp} selects only
   * keys that ARE in it), and the second list is the fix for the defect this
   * whole path exists to prevent. Driving the write-back off `promote` alone
   * meant that after the first promotion there was nothing to promote, so
   * nothing ran, so the stamp never moved — and the series aged out at 30 days
   * while being read every single day. Reproduced against these exact functions:
   * read 1 promoted 2 bars and issued 1 stamp update, reads 2 and 3 issued zero
   * driver calls.
   *
   * ## It must never fire for India
   *
   * `marketForExchange(exchange)` is checked, NOT `query.market`. The `market`
   * option overrides the COLD KEY only, so honouring it here would let a caller
   * point the write-back at a market the row's exchange does not belong to.
   * `Candle` holds no India rows and `us_instruments` is US-only, so an India
   * read has no ledger row to stamp and nothing to promote into; the guard is
   * positive (`=== "US"`) so a future third market is excluded until somebody
   * widens it deliberately. It is stated ONCE, here, and the runner has no
   * market opinion of its own to drift from it.
   */
  private planHotLoad(args: {
    writeBack: boolean;
    exchange: string;
    cold: readonly CandleBar[];
    hot: readonly HotCandleRow[];
    served: readonly CandleBar[];
    now: Date;
    stampMaxAgeMs: number | undefined;
  }): HotLoadPlan | HotLoadDecline {
    if (!args.writeBack) return "off";
    // POSITIVE market test — see the doc above.
    if (marketForExchange(args.exchange) !== "US") return "not-us";

    const promote =
      args.cold.length > 0
        ? promotableColdBars({
            cold: args.cold,
            served: args.served,
            hot: args.hot,
          })
        : [];
    const restamp = barsNeedingHotLoadStamp({
      hot: args.hot,
      served: args.served,
      now: args.now,
      maxAgeMs: args.stampMaxAgeMs,
    });

    if (promote.length === 0 && restamp.length === 0) return "idle";
    return { promote, restamp };
  }

  /**
   * RUN the write-back. Owns the lane, the in-flight dedupe and the deadline.
   *
   * ## Why the default lane AWAITS, after this shipped fire-and-forget
   *
   * The old shape started the work and returned. Its stated justification was
   * "a chart request must not wait on a bulk Mongo write" — true, but it
   * assumed a runtime that is still there afterwards. `apps/web` runs on
   * VERCEL, where post-response async work is SUSPENDED and there is no
   * `after()` or `waitUntil` anywhere in the app to hold it open. So on the
   * runtime this repository's first reader will live in, a floating promise is
   * not "slightly later", it is "never" — reported as success.
   *
   * The precedent cited for it was not one either. `stale-while-error.ts`'s
   * `run.catch(() => {})` guards a single-flight LEADER that the request still
   * awaits through `withDeadline`; nothing there escapes the response.
   *
   * ## What each lane costs, and what a truncation can leave behind
   *
   * `inline` awaits, bounded by {@link HOT_LOAD_INLINE_DEADLINE_MS}. The
   * expensive step only runs on a read that actually pulled a cold year back;
   * a warm repeat read does a stamp refresh at most once a day and otherwise
   * never reaches this method at all (outcome `idle`).
   *
   * `background` is the old behaviour, opt-in, for a process that outlives the
   * response.
   *
   * A suspension — or the deadline — can still cut the work at a step boundary,
   * so the ORDER inside {@link hotLoad} is chosen to make every prefix a state
   * a later read repairs rather than one that has to be cleaned up:
   *
   *   after step 1   rows exist as `LOADED`; some carry a stale stamp and the
   *                  ledger has not claimed the year. The NEXT read now sees
   *                  them in `hot`, puts them in `restamp`, and finishes the
   *                  job. Self-healing — and only because of the `restamp`
   *                  list, without which this prefix was permanent.
   *   after step 2   the ledger under-claims. Its only reader is the evictor's
   *                  `$pull`, for which a missing entry is a no-op, and the
   *                  next read re-adds it.
   *
   * The prefix that would NOT be safe is the inverse — a ledger claiming a year
   * whose rows never landed — which is exactly why the ledger is last.
   *
   * ## The dedupe, and why both lanes register in the map
   *
   * Concurrent readers of one symbol are the normal case; each would otherwise
   * start an identical bulk write. `inFlightHotLoads` is keyed by SERIES +
   * listing, so the second caller gets `in-flight` and the first one's write
   * serves both. The stored promise has already absorbed its own error, so
   * nothing in the map can reject. Registering the INLINE lane's promise too is
   * what keeps a deadline from orphaning a handle: the reader stops waiting,
   * the work does not stop, and {@link settleHotLoads} still drains it.
   *
   * The dedupe is deliberately APPROXIMATE, and it is now safe to be. Two
   * concurrent reads of one series can ask for different ranges, so the loser's
   * plan may name bars the winner's does not — those simply are not stamped
   * this time. Before the `restamp` list that was a permanent loss (nothing
   * would ever select them again); now it costs one read's delay, because the
   * next read of those bars finds them stale and stamps them.
   */
  private async runHotLoad(args: {
    symbol: string;
    exchange: string;
    timeframe: string;
    listingId: string | null;
    plan: HotLoadPlan;
    now: Date;
    lane: HotLoadLane;
  }): Promise<{ outcome: HotLoadOutcome; restamped: number | null }> {
    const key = [
      args.symbol,
      args.exchange,
      args.timeframe,
      args.listingId ?? "",
    ].join("\u0000");
    if (this.inFlightHotLoads.has(key)) {
      return { outcome: "in-flight", restamped: null };
    }

    let restamped: number | null = null;
    let threw = false;
    const work = (async (): Promise<void> => {
      try {
        const outcome = await this.hotLoad({
          symbol: args.symbol,
          exchange: args.exchange,
          timeframe: args.timeframe,
          listingId: args.listingId,
          promote: args.plan.promote,
          restamp: args.plan.restamp,
          now: args.now,
        });
        restamped = outcome.restamped;
      } catch (error) {
        // Swallowed on purpose, and LOUDLY. The read has already been answered
        // correctly from the merged series; a failed write-back costs one more
        // cold read next time and nothing else. In the background lane there is
        // no caller left to throw to, and in the inline lane throwing would
        // turn a slow cache-warm into a failed chart.
        threw = true;
        console.warn(
          `[candles] hot-load write-back failed for ` +
            `${args.symbol}/${args.exchange}/${args.timeframe} ` +
            `(${args.plan.promote.length} promoted, ` +
            `${args.plan.restamp.length} restamped); the read was unaffected: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.inFlightHotLoads.delete(key);
      }
    })();
    this.inFlightHotLoads.set(key, work);

    if (args.lane === "background") {
      return { outcome: "started", restamped: null };
    }

    const finished = await raceDeadline(work, this.hotLoadDeadlineMs);
    if (!finished) return { outcome: "deadline", restamped: null };
    if (threw) return { outcome: "failed", restamped: null };
    return { outcome: "applied", restamped };
  }

  /**
   * Await every promotion this repository has started.
   *
   * For tests and for a graceful worker shutdown. The stored promises have
   * already absorbed their own errors, so this never rejects.
   */
  async settleHotLoads(): Promise<void> {
    // Snapshot: a settling promise removes itself from the map in its own
    // `finally`, and iterating a Map being mutated mid-await is how a settle
    // silently misses the last entry.
    await Promise.all([...this.inFlightHotLoads.values()]);
  }

  /**
   * Write promoted bars into Mongo as `LOADED`, stamp, then record the ledger.
   *
   * THREE steps, in this order, and the order is the whole design. It is also
   * the TRUNCATION ORDER: every prefix of it is a state a later read repairs
   * (see {@link runHotLoad}), which is what makes it safe for the inline lane's
   * deadline to abandon the wait and for a serverless suspension to cut it.
   *
   *   1. `putCandles` with `tier: "LOADED"`, on `promote` ONLY. This CREATES
   *      the rows that are not there — the common case, a first read of a cold
   *      year — and applies source precedence to any that are. `restamp` rows
   *      are already in Mongo and are deliberately NOT sent through the
   *      precedence writer: every one of them would take the PRESERVE path, so
   *      it would buy a diff query per chunk and change nothing.
   *   2. `refreshHotLoadStamps`, on BOTH lists. THE FIX FOR THE TRAP, and it
   *      has two halves that are easy to mistake for one.
   *
   *        - For `promote`: step 1 stamps `hotLoadedAt` only on rows it created
   *          or upgraded; a row already held at an equal-or-stronger source
   *          takes `partitionCandleWrites`' PRESERVE path and keeps whatever
   *          timestamp it had. (A cold read pulls whole symbol-YEARS, so it
   *          routinely carries bars outside the hot read's `ts` bounds — which
   *          is how a promoted key can already exist in Mongo at all.)
   *        - For `restamp`: those rows were never handed to a writer, because
   *          after the first promotion there is nothing left to promote. This
   *          is the half that was missing, and without it the whole method was
   *          UNREACHABLE on every read after the first.
   *
   *      Either way the stamp is its own write, naming `hotLoadedAt` and
   *      nothing precedence has an opinion about, because "when was this last
   *      read" is not a question `source` ranks.
   *   3. The per-listing ledger, over BOTH lists. LAST, so `hotLoadedYears`
   *      cannot claim a year whose rows failed to land — steps 1 and 2 both
   *      throw upward, so a failure short-circuits before the claim is made.
   *      Including `restamp` here is what heals a ledger a truncated earlier
   *      attempt left un-written: `$addToSet` is idempotent, and a year holding
   *      served `LOADED` rows is a year the ledger should list.
   *
   * `now` is a PARAMETER, not `this.now()`. The stamp this writes and the
   * staleness test that selected `restamp` have to be the same instant, and a
   * clock read again here would let a row be selected as stale against one
   * `now` and stamped with another.
   */
  private async hotLoad(args: {
    symbol: string;
    exchange: string;
    timeframe: string;
    listingId: string | null;
    promote: readonly CandleBar[];
    restamp: readonly CandleBar[];
    now: Date;
  }): Promise<{
    written: CandleWriteResult | null;
    restamped: number;
    ledger: boolean;
  }> {
    const stampable = [...args.promote, ...args.restamp];

    const written =
      args.promote.length > 0
        ? await this.putCandles(toHotLoadWriteRows(args.promote))
        : null;
    const restamped = await this.refreshHotLoadStamps(stampable, args.now);
    const ledger = await this.recordHotLoadLedger(
      args.listingId,
      stampable,
      args.now,
    );

    return { written, restamped, ledger };
  }

  /**
   * Refresh `hotLoadedAt` on every key this read touched, INDEPENDENTLY of
   * precedence.
   *
   * The shape — one `updateMany` per series-chunk, `where.tier: "LOADED"`
   * matched positively, `data` naming `hotLoadedAt` and nothing else — is built
   * by {@link buildHotLoadStampUpdates}, which carries the full argument and is
   * unit-tested. This method is the wiring and deliberately adds no rule of its
   * own: a second statement of "which rows and which column" is exactly the
   * drift that class of bug lives in.
   *
   * `updateMany` rather than `$runCommandRaw`, and that is not a style
   * preference. Prisma's raw path takes `InputJsonValue`, whose `{ toJSON():
   * unknown }` arm ACCEPTS a `Date` and then serialises it to a JSON STRING —
   * so a raw `$set: { hotLoadedAt: now }` type-checks, runs, reports success and
   * stores a string in a `DateTime?` column, which the eviction's `{ lt: cutoff }`
   * can never match. Extended JSON (`{ $date: … }`) is the raw-path spelling;
   * `updateMany` needs neither, because Prisma encodes the column from its own
   * schema.
   */
  private async refreshHotLoadStamps(
    bars: readonly CandleBar[],
    now: Date,
  ): Promise<number> {
    let updated = 0;
    for (const update of buildHotLoadStampUpdates(bars, now)) {
      const res = await prisma.candle.updateMany(update);
      // AFTER the call, and from ITS return value rather than from the size of
      // the batch handed in — MONEY-1255's rule. A stamp that matched nothing
      // must read as zero, not as "however many we asked about".
      updated += res.count;
    }
    return updated;
  }

  /**
   * Record the per-listing hot-load ledger on `us_instruments`.
   *
   * `$addToSet` + `$set` through `$runCommandRaw`, for two reasons that are
   * both about correctness rather than speed:
   *
   *   - Prisma's scalar-list update offers `set` and `push`. `set` needs a
   *     read-modify-write, which loses a concurrent promotion of a DIFFERENT
   *     year; `push` appends duplicates, and this list is read by the eviction
   *     job. `$addToSet` is atomic and idempotent, which is what a ledger of
   *     "which years are hot" actually means.
   *   - The field is ABSENT (not `[]`) on every row written before the column
   *     existed, and `$addToSet` creates it. A read-modify-write would have to
   *     get that right a second time.
   *
   * `lastHotLoadAt` is spelled `{ $date: iso }` — Extended JSON — because on the
   * raw path a bare `Date` serialises to a plain JSON string and lands in a
   * `DateTime?` column as text. See {@link refreshHotLoadStamps}.
   *
   * A null or empty `listingId` skips the ledger and does NOT skip the rows: the
   * bars are still promoted, because `Candle.tier` / `hotLoadedAt` are the
   * authoritative per-row fact and this table is the summary. Inventing a
   * listing key to have something to write would be worse than writing nothing.
   */
  private async recordHotLoadLedger(
    listingId: string | null,
    bars: readonly CandleBar[],
    now: Date,
  ): Promise<boolean> {
    if (listingId === null || listingId === "") return false;
    const years = hotLoadedYearsForBars(bars);
    if (years.length === 0) return false;

    await prisma.$runCommandRaw({
      update: "us_instruments",
      updates: [
        {
          q: { listingId },
          u: {
            $addToSet: { hotLoadedYears: { $each: years } },
            $set: { lastHotLoadAt: { $date: now.toISOString() } },
          },
          // No `upsert`. A listing we hold no `us_instruments` row for is a
          // master-sync gap, and inventing a row here would create a second
          // writer of that table whose rows carry none of its other columns.
          multi: false,
        },
      ],
      ordered: false,
    });
    return true;
  }

  /**
   * Idempotent bulk write.
   *
   * ## Why this is diff-then-create rather than an upsert or `skipDuplicates`
   *
   * `createMany({ skipDuplicates: true })` is a SQL-ONLY Prisma feature; the
   * Mongo connector types it as `never`. And a bare `createMany` is worse than
   * useless at this scale: ONE duplicate key throws the WHOLE batch, which is
   * how bhavcopy-sync loses an entire leg's prices for a day to a single
   * collision. Per-row `upsert` would be correct but is 200M round trips.
   *
   * So collisions are resolved BEFORE the write, precedence is applied to the
   * ones that already exist, and a chunk that still collides (a concurrent run
   * landing a row between our diff and our write) falls back to per-row inserts
   * for THAT CHUNK ONLY — the `mf-nav-backfill` shape, where one collision costs
   * a chunk instead of the run.
   */
  async putCandles(
    batch: readonly CandleWriteRow[],
  ): Promise<CandleWriteResult> {
    const sanitized = sanitizeCandleWrites(batch);
    const result: CandleWriteResult = {
      created: 0,
      upgraded: 0,
      preserved: 0,
      dupInBatch: 0,
      droppedNonFinite: sanitized.droppedNonFinite,
      clampedVolume: sanitized.clampedVolume,
      failed: 0,
      archivedCold: 0,
      coldShards: 0,
      coldFailed: 0,
      coldFellBackToHot: 0,
    };
    if (sanitized.rows.length === 0) return result;

    // ONE clock for the whole batch — see `partitionCandlesByDestination` for
    // why reading it per row would split a symbol-year across two stores on 31
    // December.
    const now = this.now();
    const routed = partitionCandlesByDestination(sanitized.rows, now);

    // COLD FIRST, so a fallback to Mongo can join the hot batch below and be
    // diffed against what is already there. Doing it after would need a second
    // diff pass, and a second pass is a second place for precedence to be got
    // subtly differently.
    const fellBack = await this.archiveCold(routed.cold, result);
    result.coldFellBackToHot = fellBack.length;

    const hot: NormalizedCandleWrite[] = [
      ...routed.hotWindow,
      ...routed.hotLoaded,
      ...fellBack,
    ];
    if (hot.length === 0) return result;

    // Which tier each row is stamped with. A `LOADED` row also gets
    // `hotLoadedAt`, which is the only thing distinguishing "outside the window
    // but somebody is reading it" from "outside the window, delete" — the
    // distinction the column exists for.
    const tierOf = new Map<string, CandleTier>();
    for (const row of routed.hotLoaded) tierOf.set(candleKey(row), "LOADED");

    const groups = groupWritesBySeries(hot);

    for (const groupChunk of chunk(groups, CANDLE_DIFF_OR_BRANCHES)) {
      const existingRows = await prisma.candle.findMany({
        where: {
          OR: groupChunk.map((g) => ({
            symbol: g.symbol,
            exchange: g.exchange,
            timeframe: g.timeframe,
            ts: { gte: g.minTs, lte: g.maxTs },
          })),
        },
        select: {
          id: true,
          symbol: true,
          exchange: true,
          timeframe: true,
          ts: true,
          source: true,
        },
      });

      const existing = new Map(
        existingRows.map((row) => [
          candleKey(row),
          { id: row.id, source: row.source },
        ]),
      );

      const rows = groupChunk.flatMap((g) => g.rows);
      const partition = partitionCandleWrites(rows, existing);
      result.preserved += partition.preserved;
      result.dupInBatch += partition.dupInBatch;

      await this.insertNew(partition.create, result, tierOf, now);
      await this.applyUpgrades(partition.upgrade, result, tierOf, now);
    }

    return result;
  }

  /**
   * Write cold-destined bars to GCS shards. Returns what must fall back to Mongo.
   *
   * ## The two failure modes are answered DIFFERENTLY on purpose
   *
   *   no store registered   -> every row comes back for the Mongo path, LOUDLY,
   *                            and lands in `coldFellBackToHot`. Nothing is
   *                            lost, and the count says the cold tier is not
   *                            actually running.
   *   a shard write THREW   -> those rows are `coldFailed` (and `failed`), and
   *                            they are NOT retried into Mongo. A GCS error is
   *                            transient and the caller re-fetches; quietly
   *                            filing a whole delisted history into the hot
   *                            store on a credentials blip is the opposite of
   *                            what the split is for, and it would be
   *                            invisible.
   *
   * Both are counted after the call they count.
   */
  private async archiveCold(
    rows: readonly NormalizedCandleWrite[],
    result: CandleWriteResult,
  ): Promise<NormalizedCandleWrite[]> {
    if (rows.length === 0) return [];

    if (getCandleColdStore() === null) {
      // ERROR, not warn. This is the state in which the tier that the whole
      // storage design rests on is doing nothing, and a warning is what gets
      // filtered out of a log nobody reads on a green night.
      console.error(
        `[candles] NO COLD STORE REGISTERED — ${rows.length} bar(s) that belong ` +
          `outside the ${HOT_WINDOW_YEARS}-year hot window were written to MONGO ` +
          "instead. They are not lost, but the hot store is now carrying rows it " +
          "was sized against. Call setCandleColdStore() at process start " +
          "(workers: initCandleColdStore()).",
      );
      return [...rows];
    }

    for (const shard of groupColdShards(rows)) {
      try {
        await writeColdShard(shard);
        // AFTER the call. Before it, a shard that threw on every write would
        // still report a full number — MONEY-1255's rule, and the reason this
        // is not incremented alongside the loop variable.
        result.archivedCold += shard.bars.length;
        result.coldShards++;
      } catch (error) {
        result.coldFailed += shard.bars.length;
        result.failed += shard.bars.length;
        console.warn(
          `[candles] cold shard write failed for ` +
            `${shard.market}/${shard.timeframe}/${shard.symbol}/${shard.year} ` +
            `(${shard.bars.length} bar(s)): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return [];
  }

  /**
   * Drop the cached copies of these symbol-years. THE eviction entry point.
   *
   * ## What this is, and what it is deliberately NOT for
   *
   * `putCandles` already calls it for every shard it rewrites, which is why it
   * exists: a GCS object that has moved under a 6h cache is a stale read, and
   * `writeColdShard` cannot be correct without it. It is public because a
   * caller writing shards directly needs the same invalidation.
   *
   * It is NOT for `us-eod-sync`'s leg (c). `CA_EVICTION_UNAVAILABLE` gave two
   * reasons that leg applies nothing, and only ONE of them has stopped being
   * true. The entry point now exists — this method. The other reason stands
   * unchanged and is the whole argument on its own: `candles-cold` holds RAW
   * bars for CLOSED symbol-years, the adjusted series is recomputed on every
   * read and cached nowhere, and tonight's split lands in hot Mongo which wins
   * the merge. So a corporate action stales nothing here, and evicting on one
   * would discard entries that are still correct — pure cost against a cache
   * whose only job is keeping a decade of GCS round trips off the read path.
   *
   * Never throws: a cache that cannot be reached is a slow read, not a wrong
   * one, and a completed write must not be reported as a failure because its
   * invalidation could not run.
   */
  async evictColdShards(
    shards: ReadonlyArray<{
      market: string;
      timeframe: string;
      symbol: string;
      year: number;
    }>,
  ): Promise<{ evicted: number; failed: number }> {
    let evicted = 0;
    let failed = 0;
    for (const shard of shards) {
      // AFTER the call, and branching on its RESULT rather than assuming it —
      // `evictColdShard` swallows its own error and reports false.
      if (await evictColdShard(shard)) evicted++;
      else failed++;
    }
    return { evicted, failed };
  }

  /**
   * Newest bar we hold for a series, in the HOT store.
   *
   * ## Read the contract before using this as a resume point
   *
   * Hot-only by default, and that is a deliberate boundary rather than an
   * oversight. Probing cold for a "latest" would mean walking year keys backward
   * from today with no idea when to stop — `listFiles` cannot answer it (it
   * FAILS OPEN to `[]`, MONEY-941) and an arbitrary "probe the last N years" cap
   * would return a confidently wrong answer for anything delisted before the
   * cap. A cap that silently produces a wrong answer is worse than a narrow
   * contract.
   *
   * For an incremental sync the right resume point is
   * `BackfillCheckpoint.lastTs` (keyed `jobKey` + `itemKey` + `scope`), which
   * exists precisely because the
   * outcomes that must be remembered are the ones that write no rows (`ENE` ->
   * 404, `LEH` -> 200 with an empty array, a recycled ticker -> the successor's
   * bars, refused). Use that; use this for "what is the freshest bar a chart can
   * draw".
   *
   * `coldYearRange` is the escape hatch, and it is opt-in and CALLER-BOUNDED: a
   * caller that knows the listing's end date (`UsInstrument.listingEndDate`)
   * can name the years to probe, which is exact rather than capped.
   */
  async latestTs(args: {
    symbol: string;
    exchange: string;
    timeframe: string;
    market?: string;
    /** Inclusive year range to probe in cold storage after a hot miss. */
    coldYearRange?: { from: number; to: number };
  }): Promise<Date | null> {
    const { symbol, exchange, timeframe } = args;
    const row = await prisma.candle.findFirst({
      where: { symbol, exchange, timeframe },
      orderBy: { ts: "desc" },
      select: { ts: true },
    });
    if (row) return row.ts;

    const range = args.coldYearRange;
    if (!range || getCandleColdStore() === null) return null;

    const market = args.market ?? marketForExchange(exchange);
    // Newest year first — the first shard that answers is the answer, so a
    // symbol delisted in 2007 costs one hit and not the whole range.
    for (let year = range.to; year >= range.from; year--) {
      const outcome = await readColdShard({ market, timeframe, symbol, year });
      if (outcome.status === "failed") {
        throw new ColdStoreUnavailableError(
          [`${market}/${timeframe}/${symbol}/${year}`],
          outcome.error,
        );
      }
      if (outcome.status === "present") {
        // NARROW FIRST, then take the maximum — `newestTsForVenue` owns both
        // halves of that ordering and is shared with `readCold` below, so the
        // two cold paths cannot disagree about what "this series" means.
        //
        // A `null` here means the shard held bars, but none of them for the
        // venue asked for: a ticker-keyed shard legitimately carries every
        // exchange the ticker traded on. That is NOT an answer, so the walk
        // continues to the next candidate year. Returning early on it would
        // hand back another venue's timestamp — or, worse, stop the search at a
        // year whose data belongs to someone else entirely.
        const newest = newestTsForVenue(outcome.bars, { exchange, timeframe });
        if (newest !== null) return newest;
      }
    }
    return null;
  }

  /* ─── internals ───────────────────────────────────────────────────────── */

  /**
   * The hot half of a read.
   *
   * ## `tier` and `hotLoadedAt` are SELECTED, and that is load-bearing
   *
   * They are not part of a bar and no consumer of the series ever looks at
   * them. They are here because the write-back's stamp half has no other source
   * for them: `hotLoadedAt` records when a row was last READ, and the only
   * process that knows a row was just read is this one. Leaving them out is
   * what made the refresh unreachable — the promotion list is empty once the
   * bars are in Mongo, so with no tier on the returned rows there was nothing
   * left from which to decide that a stamp was due.
   *
   * Two extra projected columns per row, on a query that is already fetching
   * twelve.
   */
  private async readHot(args: {
    symbol: string;
    exchange: string;
    timeframe: string;
    from: Date;
    to: Date;
    listingId: string | undefined;
  }): Promise<HotCandleRow[]> {
    const rows = await prisma.candle.findMany({
      where: {
        symbol: args.symbol,
        exchange: args.exchange,
        timeframe: args.timeframe,
        ts: { gte: args.from, lte: args.to },
        ...(args.listingId ? { listingId: args.listingId } : {}),
      },
      orderBy: { ts: "asc" },
      select: {
        symbol: true,
        exchange: true,
        timeframe: true,
        ts: true,
        listingId: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        divCash: true,
        splitFactor: true,
        source: true,
        tier: true,
        hotLoadedAt: true,
      },
    });

    return rows.map((row) => ({
      symbol: row.symbol,
      exchange: row.exchange,
      timeframe: row.timeframe,
      ts: row.ts,
      listingId: row.listingId,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      // BigInt -> number at the store boundary. Safe by five orders of
      // magnitude, and mandatory: a `bigint` reaching any arithmetic that also
      // touches a `number` throws `Cannot mix BigInt and other types`. See the
      // note on `CandleBar.volume`.
      volume: Number(row.volume),
      divCash: row.divCash,
      splitFactor: row.splitFactor,
      source: row.source,
      // Carried RAW. The one comparison against it is `isLoadedTier`, which is
      // positive, so an unrecognised value fails closed rather than joining the
      // 30-day lane.
      tier: row.tier,
      hotLoadedAt: row.hotLoadedAt,
    }));
  }

  private async readCold(args: {
    market: string;
    timeframe: string;
    symbol: string;
    exchange: string;
    from: Date;
    to: Date;
  }): Promise<ColdReadResult> {
    if (getCandleColdStore() === null) return emptyColdResult();

    const years = coldYearsForRange(args.from, args.to);
    if (years.length === 0) return emptyColdResult();

    const outcomes = await Promise.all(
      years.map(async (year) => ({
        year,
        outcome: await readColdShard({
          market: args.market,
          timeframe: args.timeframe,
          symbol: args.symbol,
          year,
        }),
      })),
    );

    const result: ColdReadResult = {
      bars: [],
      requested: years.length,
      present: 0,
      absent: 0,
      failed: [],
      firstError: undefined,
    };

    for (const { year, outcome } of outcomes) {
      if (outcome.status === "failed") {
        result.failed.push(
          `${args.market}/${args.timeframe}/${args.symbol}/${year}`,
        );
        if (result.firstError === undefined) result.firstError = outcome.error;
        continue;
      }
      if (outcome.status === "absent") {
        result.absent++;
        continue;
      }
      result.present++;
      // A shard is keyed by TICKER and therefore holds every exchange that
      // ticker traded on (see `buildCandleColdKey` for why that is the safer
      // layout). Filter to the venue asked for; the LISTING filter is a separate
      // question and runs later, on the merged hot+cold series.
      //
      // Also re-filter by `timeframe`, which is already in the key: a shard
      // written by a future producer that batched two timeframes into one object
      // would otherwise interleave them into a single series, and that failure
      // would look exactly like a denser chart rather than an error.
      const venue = { exchange: args.exchange, timeframe: args.timeframe };
      for (const bar of outcome.bars) {
        if (!barMatchesVenue(bar, venue)) continue;
        result.bars.push(bar);
      }
    }

    return result;
  }

  /**
   * Resolve a bare ticker to the CURRENT listing, from `us_instruments`.
   *
   * ## `findFirst`, not `findUnique`, and that is the whole point of the model
   *
   * This used to read `InstrumentMapping`, which is unique on
   * `(symbol, exchange)` and therefore held exactly one occupancy window.
   * `UsInstrument` indexes that pair and DELIBERATELY does not make it unique —
   * a recycled ticker is two rows on one venue, `DOW`/`NYSE` being Dow Chemical
   * (1972-2017) and Dow Inc. (2019-) — so a `findUnique` is not merely wrong
   * here, it does not typecheck.
   *
   * `listingStatus: "ACTIVE"` is what narrows the pair back to one row, and it
   * is matched POSITIVELY: on Mongo the attribute is ABSENT rather than null on
   * anything predating the column, so a negative test matches zero
   * (MONEY-1050 / 1205 / 1234 / 1235).
   *
   * ## Ambiguity REFUSES rather than picks
   *
   * If the pair still resolves to more than one ACTIVE listing, this returns
   * `null` instead of taking the first. A wrong hint here would silently drop
   * the OTHER company's bars out of the series (`selectSingleListing` filters
   * to whatever it is handed), and half a chart is not visibly wrong. `null` is
   * safe: it hands the decision to `selectSingleListing`, which infers the
   * dominant listing from the data it actually has. Same discipline as
   * `resolveSearchMatch` in the permaTicker enrichment.
   *
   * A null answer is NOT an error and NOT a claim that the ticker has one
   * listing. India reads land here too and correctly get `null` — `us_instruments`
   * is US-only, and `Candle` today holds no India rows (MONEY-1043 is decided as
   * coexistence: `DailyPrice`/`IntradayBar` stay India's store).
   */
  private async resolveCurrentListingId(
    symbol: string,
    exchange: string,
  ): Promise<string | null> {
    const rows = await prisma.usInstrument.findMany({
      where: { symbol, exchange, listingStatus: "ACTIVE" },
      select: { listingId: true },
      // Two is all the question needs: one row answers it, two refuse it. A
      // `findMany` with no bound would read every row of a pathological ticker
      // to learn a fact the second row already settles.
      take: 2,
    });
    if (rows.length !== 1) return null;
    const value = rows[0]?.listingId;
    return typeof value === "string" && value !== "" ? value : null;
  }

  private async insertNew(
    rows: readonly NormalizedCandleWrite[],
    result: CandleWriteResult,
    tierOf: ReadonlyMap<string, CandleTier>,
    now: Date,
  ): Promise<void> {
    const input = (row: NormalizedCandleWrite): CandleCreateInput =>
      toCreateInput(row, tierOf.get(candleKey(row)) ?? "WINDOW", now);
    for (const slice of chunk(rows, CANDLE_WRITE_CHUNK)) {
      try {
        const res = await prisma.candle.createMany({
          data: slice.map(input),
        });
        result.created += res.count;
      } catch (error) {
        // A concurrent writer can land a row between our diff and our write; the
        // four-part unique then throws the WHOLE createMany. Fall back to
        // per-row inserts for this chunk only.
        console.warn(
          `[candles] bulk insert collided (${slice.length} rows), falling back to per-row: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        for (const row of slice) {
          try {
            await prisma.candle.create({ data: input(row) });
            result.created++;
          } catch (rowError) {
            // Already there — a no-op, not a failure — and that distinction has
            // to be MADE rather than merely stated. The comment here used to say
            // exactly this while the code counted every duplicate as `failed`,
            // which is the common case on this path (the fallback only runs
            // after a bulk collision) and which pages somebody for correct
            // behaviour: see `classifyCandleRowWriteError` for the three
            // downstream counters it corrupted.
            //
            // Anything NOT identifiable as a duplicate still lands in `failed`,
            // so a systematically failing write cannot report a clean run.
            result[classifyCandleRowWriteError(rowError)]++;
          }
        }
      }
    }
  }

  private async applyUpgrades(
    upgrades: ReadonlyArray<{ row: NormalizedCandleWrite; existingId: string }>,
    result: CandleWriteResult,
    tierOf: ReadonlyMap<string, CandleTier>,
    now: Date,
  ): Promise<void> {
    for (const slice of chunk(upgrades, CANDLE_WRITE_CHUNK)) {
      try {
        const res = (await prisma.$runCommandRaw({
          update: "candles",
          updates: slice.map(({ row, existingId }) => {
            const tier = tierOf.get(candleKey(row)) ?? "WINDOW";
            return {
              q: { _id: { $oid: existingId } },
              u: {
                // Names only the price columns, the adjustment inputs, the
                // provenance and the tier. A whole-document replace would erase
                // anything a DIFFERENT writer owns on the same row — the mistake
                // `writeCash` documents for the delivery columns on
                // `daily_prices`.
                $set: {
                  open: row.open,
                  high: row.high,
                  low: row.low,
                  close: row.close,
                  // Extended JSON. The column is a Mongo `long`; a bare JSON
                  // number would be stored as a `double`, and Prisma reading a
                  // BigInt field that holds a double is a type error at read time
                  // — a write that succeeds and poisons every later read.
                  volume: { $numberLong: row.volume.toString() },
                  divCash: row.divCash,
                  splitFactor: row.splitFactor,
                  source: row.source,
                  tier,
                  // `hotLoadedAt` moves only INTO `LOADED`, never out of it, and
                  // that asymmetry is deliberate. A row whose tier goes back to
                  // WINDOW (the window rolled far enough to cover the year it
                  // was loaded from) keeps a stale timestamp, which is inert:
                  // the schema requires the eviction job to select `tier`
                  // POSITIVELY — `{tier:"LOADED", hotLoadedAt:{lt}}` — precisely
                  // because a Mongo `db push` leaves the attribute ABSENT on
                  // pre-existing rows and both `{null}` and `{not:null}` match
                  // zero. Clearing it would need a `$unset` here and a `null`
                  // in the Prisma fallback below, which is one rule spelled two
                  // ways in two mechanisms, free to drift.
                  //
                  // `{ $date: iso }` — EXTENDED JSON, not a bare `Date`, and
                  // this is a live defect rather than a style note. Prisma's
                  // raw path takes `InputJsonValue`, whose `{ toJSON():
                  // unknown }` arm ACCEPTS a `Date`; it then serialises through
                  // `JSON.stringify`, so `hotLoadedAt: now` compiles, runs,
                  // reports `nModified`, and stores a STRING in a `DateTime?`
                  // column. The eviction's `{ hotLoadedAt: { lt: cutoff } }`
                  // cannot match a string, so every row written that way would
                  // be immortal — and Prisma reading the column back would type
                  // -error. `{ $oid }` and `{ $numberLong }` above are the same
                  // rule already applied; this line was the one that missed it.
                  // The Prisma `update()` fallback below needs no encoding: it
                  // knows the column's type from the schema.
                  ...(tier === "LOADED"
                    ? { hotLoadedAt: { $date: now.toISOString() } }
                    : {}),
                },
              },
              multi: false,
            };
          }),
          ordered: false,
        })) as { nModified?: number };
        result.upgraded += res.nModified ?? 0;
      } catch (error) {
        console.warn(
          `[candles] bulk update failed (${slice.length} rows), falling back to per-row: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        for (const { row, existingId } of slice) {
          const tier = tierOf.get(candleKey(row)) ?? "WINDOW";
          try {
            await prisma.candle.update({
              where: { id: existingId },
              data: {
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
                divCash: row.divCash,
                splitFactor: row.splitFactor,
                source: row.source,
                tier,
                ...(tier === "LOADED" ? { hotLoadedAt: now } : {}),
              },
            });
            result.upgraded++;
          } catch {
            // NOT classified the way the insert fallback is, and deliberately.
            // This is an update BY `_id` whose `$set` names no column of the
            // four-part unique, so it cannot raise a duplicate-key error at all.
            // What it CAN raise is P2025 — the row our diff just saw is gone —
            // and that is a genuine anomaly, not a benign race: the write we
            // owed did not land anywhere. It belongs in `failed`.
            result.failed++;
          }
        }
      }
    }
  }
}

/** Process-wide instance, matching how the other market-data services are used. */
export const candleRepository = new CandleRepository();

/* ─────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The two lists a write-back operates on. See {@link CandleRepository.hotLoad}.
 *
 * Never both empty — `planHotLoad` returns `"idle"` for that, so a plan object
 * always means there is work.
 */
interface HotLoadPlan {
  /** Cold bars Mongo does not hold. Rows to CREATE. */
  promote: CandleBar[];
  /** Served `LOADED` rows whose stamp has aged out. Rows to TOUCH. */
  restamp: CandleBar[];
}

/** The reasons there is no plan. A subset of {@link HotLoadOutcome}. */
type HotLoadDecline = Extract<HotLoadOutcome, "off" | "not-us" | "idle">;

/**
 * Wait for `work`, but not past `ms`. Returns whether `work` finished first.
 *
 * NOT a cancellation and not a `Promise.race` that leaks: the timer is always
 * cleared in the `finally`, so a fast path cannot leave a pending handle behind
 * and hold a test process open — the orphan class this repo treats as a
 * failure rather than a nuisance.
 *
 * `work` is already error-absorbing (its own try/catch/finally), so this cannot
 * reject and no `.catch` is bolted on here. A guard against a THROWING input
 * would be dead code that hides the day the invariant changes.
 */
async function raceDeadline(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      // Do not hold the event loop open for the deadline alone. `unref` is
      // Node-only; a runtime without it just keeps the (already cleared-on-exit)
      // timer, which is why this is a capability test and not an assumption.
      if (typeof timer.unref === "function") timer.unref();
    });
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ColdReadResult {
  bars: CandleBar[];
  requested: number;
  present: number;
  absent: number;
  failed: string[];
  firstError: unknown;
}

function emptyColdResult(): ColdReadResult {
  return {
    bars: [],
    requested: 0,
    present: 0,
    absent: 0,
    failed: [],
    firstError: undefined,
  };
}

interface CandleCreateInput {
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
  tier: CandleTier;
  hotLoadedAt?: Date;
}

/**
 * A normalised write as Prisma's create payload.
 *
 * `tier` is written EXPLICITLY even though the column defaults to `WINDOW`.
 * A schema default only applies to a create, so relying on it would leave the
 * upgrade path (a `$set` that names its columns) unable to move a row between
 * tiers — and the two writes would then disagree about the same fact.
 *
 * `hotLoadedAt` is set ONLY on a `LOADED` row and is otherwise OMITTED rather
 * than written as null. On Mongo an omitted attribute is ABSENT, which is what
 * the schema's own note requires: the eviction job must select `tier` POSITIVELY
 * because `{hotLoadedAt: null}` and `{hotLoadedAt: {not: null}}` BOTH return
 * zero for an absent field — MONEY-1050 / 1205 / 1234 / 1235.
 */
function toCreateInput(
  row: NormalizedCandleWrite,
  tier: CandleTier,
  now: Date,
): CandleCreateInput {
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
    volume: row.volume,
    divCash: row.divCash,
    splitFactor: row.splitFactor,
    source: row.source,
    tier,
    ...(tier === "LOADED" ? { hotLoadedAt: now } : {}),
  };
}
