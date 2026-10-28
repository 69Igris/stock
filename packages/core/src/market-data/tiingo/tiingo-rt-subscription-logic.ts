/**
 * What the socket should be subscribed to — PURE.
 *
 * The effective set is the union of two populations with very different
 * lifetimes:
 *
 *   BASE       watchlists, holdings, the S&P baseline, the index ETFs.
 *              Rebuilt on a schedule; changes slowly; nobody is waiting on it.
 *   EPHEMERAL  "a user just opened this symbol's page". Sliding TTL, seconds
 *              old, and the one a human is actually staring at.
 *
 * ## Why the cap evicts EPHEMERALS first, which looks backwards
 *
 * The instinct is to protect the thing a user is looking at right now. But an
 * ephemeral entry is by construction about to expire on its own, and dropping
 * one costs a page a live tick for a few seconds; dropping a BASE entry silently
 * removes a symbol someone holds from every downstream surface — the staleness
 * alarm's population, the minute-bar series, the quote a portfolio row reads —
 * and nothing expires to bring it back. The cheap loss is the recoverable one.
 *
 * Within the ephemerals the soonest-to-expire goes first, which is why they are
 * stored in a sorted set scored by expiry rather than as N keys with their own
 * TTLs: eviction order has to be a range query, not a guess.
 *
 * ## Why a cap at all
 *
 * One socket, one budget. The reconnect path issues a REST snapshot for the
 * WHOLE subscribed set, so an unbounded set turns a reconnect into an unbounded
 * burst against a metered API — the failure this layer's budget guard exists to
 * make impossible.
 */

import type { TiingoBytesStage } from "./tiingo-budget";

/** Default ceiling on simultaneously subscribed symbols. */
export const DEFAULT_MAX_SYMBOLS = 3000;

/** How long a page view keeps a symbol subscribed, refreshed on each ping. */
export const DEFAULT_EPHEMERAL_TTL_MS = 15 * 60_000;

/**
 * Bandwidth pressure, written by the budget guard and read here.
 *
 * The ladder is deliberately about SHRINKING THE SET rather than sampling ticks
 * or reconnecting less: fewer symbols is the only lever that reduces inbound
 * bytes on a feed we do not control the verbosity of.
 *
 * DERIVED from the producer's union, never re-spelled. The two were written
 * independently and disagreed on two of three rungs, which cost the ladder its
 * two shedding rungs without any error — see the note on `TiingoBytesStage`.
 * `"none"` is ours alone: the producer has no rung for "no pressure", it simply
 * returns null, and a reader needs a value to switch on.
 */
export type DegradeStage = "none" | TiingoBytesStage;

/**
 * Severity as an ORDINAL, so the two halves of this module cannot disagree.
 *
 * They did. `planSubscriptions` tested `stage === "baseline-only"` while
 * `ephemeralTtlMs` switched on `"baseline-only" | "alarm"`, and the ladder came
 * out NON-MONOTONIC: escalating from `baseline-only` to `alarm` GREW the
 * subscribed set from 1 symbol back to 3, because the top rung fell through
 * `planSubscriptions`' equality test to the default. Measured:
 *
 *   stage=baseline-only  effective=["AAPL"]                ttl=0
 *   stage=alarm          effective=["AAPL","NVDA","TSLA"]  ttl=0   <-- backwards
 *
 * A ladder whose top rung sheds LESS than the rung below it is worse than no
 * ladder, because it is invoked exactly when the budget is nearly gone. Rank
 * makes every comparison `>=` rather than `===`, so a rung inserted anywhere in
 * the order inherits the behaviour of everything below it instead of silently
 * hitting a default.
 */
const STAGE_RANK: Readonly<Record<DegradeStage, number>> = {
  none: 0,
  "shrink-ephemeral": 1,
  "baseline-only": 2,
  alarm: 3,
};

/** The shortened window at the first rung. */
export const SHRUNK_EPHEMERAL_TTL_MS = 5 * 60_000;

/**
 * At this rung and above, ephemeral page interest is shed ENTIRELY: we trade
 * the live page experience for staying inside the monthly byte budget.
 */
export function stageShedsEphemerals(stage: DegradeStage): boolean {
  return STAGE_RANK[stage] >= STAGE_RANK["baseline-only"];
}

export interface EphemeralEntry {
  symbol: string;
  /** Epoch ms at which this interest lapses. */
  expiresAtMs: number;
}

export interface SubscriptionPlanInput {
  base: readonly string[];
  ephemeral: readonly EphemeralEntry[];
  /** Currently subscribed on the live socket. */
  current: readonly string[];
  nowMs: number;
  maxSymbols?: number;
  stage?: DegradeStage;
}

export interface SubscriptionPlan {
  /** The full set the socket should hold, sorted for determinism. */
  effective: string[];
  /** Sent to the socket as a subscribe. */
  toSubscribe: string[];
  /** Sent to the socket as an unsubscribe. */
  toUnsubscribe: string[];
  /** Ephemerals dropped because the cap was reached. */
  evicted: string[];
  /** Ephemerals dropped because their TTL had passed. */
  expired: string[];
  /** Base symbols refused by the cap — should be zero; non-zero is a red flag. */
  baseTruncated: number;
}

/** Upper-case, trimmed, de-duplicated. The feed is lower-case; we are not. */
function norm(symbols: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const s of symbols) {
    const v = s.trim().toUpperCase();
    if (v.length > 0) seen.add(v);
  }
  return [...seen];
}

/**
 * Decide the subscription set and the deltas to apply.
 *
 * Deterministic: the same inputs must produce the same plan, because the socket
 * applies the deltas and a plan that reshuffles under a stable input would
 * churn subscribe/unsubscribe traffic forever.
 */
export function planSubscriptions(
  input: SubscriptionPlanInput,
): SubscriptionPlan {
  const max = input.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const stage = input.stage ?? "none";

  const base = norm(input.base).sort();

  // Expiry first, so an expired entry is reported as EXPIRED rather than
  // silently counted as an eviction. The two mean different things: one is the
  // design working, the other is the cap biting.
  const live: EphemeralEntry[] = [];
  const expired: string[] = [];
  for (const e of input.ephemeral) {
    const symbol = e.symbol.trim().toUpperCase();
    if (symbol.length === 0) continue;
    if (e.expiresAtMs <= input.nowMs) expired.push(symbol);
    else live.push({ symbol, expiresAtMs: e.expiresAtMs });
  }

  // At `baseline-only` and above, every ephemeral is dropped. Ordinal, not
  // equality — see `stageShedsEphemerals`.
  const admissible = stageShedsEphemerals(stage) ? [] : live;

  // Soonest-to-expire evicted first — the entry with least remaining value.
  // Symbol breaks ties so the plan is stable when two expire in the same ms.
  //
  // The equal-symbol case MUST return 0. Returning 1 for `a.symbol === b.symbol`
  // is an inconsistent comparator (it claims a > a), which is unsound for any
  // sort and reachable on exactly the duplicate input collapsed just below.
  const ordered = [...admissible].sort((a, b) =>
    a.expiresAtMs === b.expiresAtMs
      ? a.symbol < b.symbol
        ? -1
        : a.symbol > b.symbol
          ? 1
          : 0
      : b.expiresAtMs - a.expiresAtMs,
  );

  const baseSet = new Set(base);
  const effective: string[] = [];
  const evicted: string[] = [];

  // BASE FIRST and never evicted. If base alone exceeds the cap that is a
  // configuration problem, not a runtime decision to make quietly — it is
  // reported so the number is visible rather than inferred from a short set.
  let baseTruncated = 0;
  for (const s of base) {
    if (effective.length < max) effective.push(s);
    else baseTruncated++;
  }

  // `admitted` tracks what is already in `effective`, because the ephemeral
  // population is NOT de-duplicated on the way in — `norm()` collapses `base`
  // and `current` but cannot be applied to a list of {symbol, expiresAtMs}
  // records without deciding which expiry wins. Two pings for one symbol are a
  // normal race (two tabs, same stock), and without this check each copy
  // consumed a cap slot and could EVICT a distinct symbol:
  //
  //   eph=[aapl(10m), AAPL(9m), NVDA(8m)], max=2
  //     -> effective ["AAPL","AAPL"]   evicted ["NVDA"]
  //
  // The first copy encountered wins, and `ordered` is sorted by expiry
  // descending, so that is the copy with the MOST remaining life — the same
  // rule the eviction policy uses everywhere else.
  const admitted = new Set(base);

  for (const e of ordered) {
    if (baseSet.has(e.symbol)) continue; // already covered by base
    if (admitted.has(e.symbol)) continue; // duplicate ping for one symbol
    if (effective.length < max) {
      effective.push(e.symbol);
      admitted.add(e.symbol);
    } else {
      evicted.push(e.symbol);
    }
  }

  effective.sort();
  const effectiveSet = new Set(effective);
  const currentSet = new Set(norm(input.current));

  return {
    effective,
    toSubscribe: effective.filter((s) => !currentSet.has(s)),
    toUnsubscribe: [...currentSet].filter((s) => !effectiveSet.has(s)).sort(),
    evicted: evicted.sort(),
    expired: [...new Set(expired)].sort(),
    baseTruncated,
  };
}

/**
 * The TTL an ephemeral interest gets, given the degradation stage.
 *
 * Shortening the window is the FIRST rung because it costs the least: a user
 * still watching keeps pinging and keeps their symbol, while a tab left open in
 * another window falls off in five minutes instead of fifteen.
 */
export function ephemeralTtlMs(
  stage: DegradeStage,
  base = DEFAULT_EPHEMERAL_TTL_MS,
): number {
  // Ordinal, and reading the SAME rank table `planSubscriptions` reads, so the
  // two can no longer disagree about what a rung means.
  if (stageShedsEphemerals(stage)) return 0;
  if (STAGE_RANK[stage] >= STAGE_RANK["shrink-ephemeral"]) {
    return SHRUNK_EPHEMERAL_TTL_MS;
  }
  return base;
}
