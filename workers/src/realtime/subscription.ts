/**
 * The subscription refresh — the leg that was MISSING.
 *
 * `main.ts` documented three timers and created two. `planSubscriptions` and
 * `TiingoSocket.applyDelta` were written, exported, tested, and called by
 * NOTHING, so `this.subscribed` stayed empty forever. That is not a partial
 * failure, it is a total one, and the chain is worth writing down because every
 * link looked healthy on its own:
 *
 *   no subscribe frame  ->  the AUTH TOKEN never leaves (it rides inside the
 *                           subscribe payload, not the handshake), so the socket
 *                           never authenticates
 *                       ->  no quote frames
 *                       ->  `rt:us:quote:*` never written
 *                       ->  every US quote falls back to the EOD close, forever,
 *                           with an honest badge saying so
 *
 * `/health` answered `{ok: true, socket: false, subscribed: 0}` throughout, and
 * the suite was green because each piece was correct in isolation. The repo's
 * own rule names this exactly: an exported helper nothing calls is a fix that
 * shipped disarmed.
 *
 * ## What populates the two sets
 *
 *   BASE       this module, from holdings + watchlists + the index ETFs.
 *              Rebuilt on a slow cadence; changes rarely.
 *   EPHEMERAL  `pingUsSymbolInterest` in the read path, when a user opens a US
 *              symbol page. Sliding TTL, scored by expiry.
 *
 * Base is rebuilt HERE rather than in a separate scheduled job on purpose: the
 * socket holder is the only process that needs the answer, it already runs
 * always-on, and a Pub/Sub job would add a second thing that can be
 * independently broken while the socket sits idle believing it is fine — which
 * is the failure this file exists to repair.
 */

import { prisma } from "@usemoney/database";
import { getRedisClient } from "@usemoney/core/cache";
import {
  planSubscriptions,
  type EphemeralEntry,
  type DegradeStage,
} from "@usemoney/core/market-data/tiingo/tiingo-rt-subscription-logic";
import { readTiingoBytesStage } from "@usemoney/core/market-data/tiingo/tiingo-budget";
import {
  RT_BASE_SET_KEY,
  RT_EPHEMERAL_SET_KEY,
} from "@usemoney/core/market-data/tiingo/tiingo-rt-keys";
import { US_EXCHANGES } from "@usemoney/core/market-data/instruments/types";
import type { TiingoSocket } from "./tiingo-socket";

/** Always subscribed: the index ETFs every US surface references. */
export const ALWAYS_SUBSCRIBED = ["SPY", "QQQ", "DIA", "IWM"] as const;

/** Rebuild the base set at most this often. It changes on human timescales. */
export const BASE_REFRESH_MS = 15 * 60_000;

/**
 * `SADD key a b c …` spreads into argv, so a large set is one enormous command.
 * Chunked because the cap is 3,000 symbols and a 3,000-argument call is a
 * needless cliff — not because any limit is known to bite at that size.
 */
const SADD_CHUNK = 500;

/**
 * Where a rebuild is assembled before it replaces the live set.
 *
 * See `rebuildBaseSet` — the two-key dance is what makes a FAILED rebuild leave
 * the previous set intact instead of destroying it.
 */
const RT_BASE_BUILD_KEY = `${RT_BASE_SET_KEY}:building`;

const US_EXCHANGE_LIST = [...US_EXCHANGES];

export interface SubscriptionCounters {
  refreshes: number;
  baseRebuilds: number;
  baseRebuildFailures: number;
  baseSize: number;
  ephemeralSize: number;
  subscribed: number;
  unsubscribed: number;
  evicted: number;
  expired: number;
  baseTruncated: number;
  failures: number;
}

/**
 * Every US symbol any user holds or watches.
 *
 * `exchange` is the ONLY thing marking a row as US — there is no `market`
 * column on `Holding` or `WatchlistItem`, and `instrumentId` points at the
 * INDIA table, so it cannot be used here. Neither model has a standalone
 * `exchange` index, which is why this runs on a slow cadence: it is a scan.
 *
 * BOTH LEGS RETURN ZERO TODAY, and that is expected rather than a bug worth
 * chasing. Measured on PROD 2026-09-01:
 *
 *   Holding          99 rows   exchanges ["BSE","NSE"]                 US: 0
 *   watchlist_items  38 rows   exchanges ["BSE","NSE","IL&FS …(IDF)"]  US: 0
 *
 * Every supported broker is Indian and `Holding.exchange` defaults to "NSE", so
 * a US row can only arrive once US positions exist. Until then the base set is
 * `ALWAYS_SUBSCRIBED` alone and the EPHEMERAL path — a user opening a US symbol
 * page — is the only thing producing real coverage. Worth knowing before
 * reading a base size of 4 as a broken query.
 *
 * (`WatchlistItem` is `@@map("watchlist_items")`; `Holding` has no `@@map` and
 * is the literal collection `Holding`. Counting the wrong name returns 0 from a
 * collection that does not exist, which looks identical to this real 0.)
 *
 * The result is never empty — it is seeded with `ALWAYS_SUBSCRIBED` — which
 * matters downstream: an empty base set would unsubscribe everything.
 */
async function loadDemandSymbols(): Promise<string[]> {
  const [holdings, watched] = await Promise.all([
    prisma.holding.findMany({
      where: { exchange: { in: US_EXCHANGE_LIST } },
      select: { symbol: true },
      distinct: ["symbol"],
    }),
    prisma.watchlistItem.findMany({
      where: { exchange: { in: US_EXCHANGE_LIST } },
      select: { symbol: true },
      distinct: ["symbol"],
    }),
  ]);
  const out = new Set<string>(ALWAYS_SUBSCRIBED);
  for (const r of [...holdings, ...watched]) {
    const s = r.symbol?.trim().toUpperCase();
    if (s) out.add(s);
  }
  return [...out];
}

/**
 * Replace the base set ATOMICALLY, via a build key and a RENAME.
 *
 * The obvious spelling — `DEL` then `SADD` — is wrong in a way that is easy to
 * talk yourself out of. It reads as "a half-second window with an empty base
 * costs one refresh", which is true ONLY IF BOTH COMMANDS RUN. If the `SADD`
 * throws, the `DEL` has already committed: the base set is left empty AND
 * PERSISTED. The next pass runs with `rebuildBase: false`, reads `base: []`,
 * and the planner correctly concludes that nothing should be subscribed:
 *
 *   base: [], current: ["SPY","QQQ","DIA","IWM","AAPL","TSLA"]
 *     -> toUnsubscribe: ["AAPL","DIA","IWM","QQQ","SPY"]
 *
 * Every held symbol is actively unsubscribed and stays that way until the next
 * successful rebuild — fifteen minutes later, at best.
 *
 * `RENAME` is atomic and only runs if the build key was populated, so a failed
 * build leaves the live set exactly as it was. Returns false on failure so the
 * caller can decline to plan against a set it could not refresh.
 */
async function rebuildBaseSet(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  counters: SubscriptionCounters,
): Promise<boolean> {
  try {
    const demand = await loadDemandSymbols();
    await redis.del(RT_BASE_BUILD_KEY);
    for (let i = 0; i < demand.length; i += SADD_CHUNK) {
      await redis.sadd(RT_BASE_BUILD_KEY, ...demand.slice(i, i + SADD_CHUNK));
    }
    await redis.rename(RT_BASE_BUILD_KEY, RT_BASE_SET_KEY);
    counters.baseRebuilds++;
    return true;
  } catch (err) {
    counters.baseRebuildFailures++;
    console.error(`[tiingo-rt] base rebuild failed: ${String(err)}`);
    // Best effort. A leftover build key is harmless — the next rebuild deletes
    // it first — but leaving it costs memory for no reason.
    await redis.del(RT_BASE_BUILD_KEY).catch(() => {});
    return false;
  }
}

/** Read the ephemeral zset as entries. Score IS the expiry, epoch ms. */
async function readEphemeral(): Promise<EphemeralEntry[]> {
  const redis = getRedisClient();
  if (!redis) return [];
  // WITHSCORES, because the score is not metadata here — it is the expiry the
  // planner evicts by, and reading members alone would make the cap evict in
  // arbitrary order.
  const raw = await redis.zrange(RT_EPHEMERAL_SET_KEY, 0, -1, "WITHSCORES");
  const out: EphemeralEntry[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const symbol = raw[i]!;
    const score = Number(raw[i + 1]);
    if (Number.isFinite(score)) out.push({ symbol, expiresAtMs: score });
  }
  return out;
}

/**
 * The bandwidth rung, read from the budget guard's OWN key.
 *
 * There used to be a second key here (`rt:us:degrade`) whose doc-comment said
 * it was "written by the budget guard". It was not — the budget guard writes
 * `tiingo:budget:stage:m:<YYYYMM>` and nothing in the repo ever wrote the
 * realtime one. So this read returned "none" on every pass and the ladder never
 * reached the socket, which is the failure mode that key's own header warns
 * about: a spelling that differs between writer and reader is not a crash, it
 * is a permanently empty read that looks exactly like "no pressure".
 *
 * Reading the producer's key directly deletes the whole class: one key, one
 * writer, one reader, and no third place for the two to disagree. `null` means
 * "below the first rung", which is this layer's "none".
 */
async function readDegradeStage(): Promise<DegradeStage> {
  try {
    return (await readTiingoBytesStage()) ?? "none";
  } catch {
    // Never let a budget read take the socket down. "none" is the fail-open
    // value, and it is the right one here: shedding subscriptions because we
    // could not read a counter would be a self-inflicted outage.
    return "none";
  }
}

/**
 * One refresh pass: read both sets, plan, apply the deltas to the socket.
 *
 * Never throws. A refresh that fails leaves the socket holding what it already
 * had, which is strictly better than tearing down a working subscription
 * because Redis blinked.
 */
export async function refreshSubscriptions(args: {
  socket: TiingoSocket;
  counters: SubscriptionCounters;
  nowMs: number;
  /** Rebuild the base set from the database on this pass. */
  rebuildBase: boolean;
  maxSymbols: number;
}): Promise<void> {
  const { socket, counters, nowMs } = args;
  const redis = getRedisClient();
  if (!redis) {
    counters.failures++;
    return;
  }
  try {
    if (args.rebuildBase && !(await rebuildBaseSet(redis, counters))) {
      // Plan nothing. The live set is intact but we cannot vouch for it being
      // current, and the cost of skipping is one cycle of slightly stale
      // subscriptions — against the cost of acting on a set we failed to build.
      return;
    }

    const [base, ephemeral, stage] = await Promise.all([
      redis.smembers(RT_BASE_SET_KEY),
      readEphemeral(),
      readDegradeStage(),
    ]);

    const plan = planSubscriptions({
      base,
      ephemeral,
      current: socket.subscribedSymbols(),
      nowMs,
      maxSymbols: args.maxSymbols,
      stage,
    });

    // Drop what the planner says has lapsed, so the zset does not grow without
    // bound. Scored by expiry, so this is a range delete rather than a scan.
    if (plan.expired.length > 0) {
      await redis.zremrangebyscore(RT_EPHEMERAL_SET_KEY, "-inf", nowMs);
    }

    socket.applyDelta(plan.toSubscribe, plan.toUnsubscribe);

    counters.refreshes++;
    counters.baseSize = base.length;
    counters.ephemeralSize = ephemeral.length;
    counters.subscribed += plan.toSubscribe.length;
    counters.unsubscribed += plan.toUnsubscribe.length;
    counters.evicted += plan.evicted.length;
    counters.expired += plan.expired.length;
    counters.baseTruncated = plan.baseTruncated;

    if (plan.baseTruncated > 0) {
      // Never silent: base exceeding the cap means somebody's holding is not
      // being watched, and the number has to be visible rather than inferred
      // from a short set.
      console.error(
        `[tiingo-rt] base set exceeds TIINGO_RT_MAX_SYMBOLS by ${plan.baseTruncated} — ` +
          "symbols users hold are NOT subscribed",
      );
    }
    if (plan.toSubscribe.length > 0 || plan.toUnsubscribe.length > 0) {
      console.log(
        `[tiingo-rt] +${plan.toSubscribe.length} -${plan.toUnsubscribe.length} ` +
          `(base ${base.length}, eph ${ephemeral.length}, stage ${stage})`,
      );
    }
  } catch (err) {
    counters.failures++;
    console.error(`[tiingo-rt] subscription refresh failed: ${String(err)}`);
  }
}

export function emptySubscriptionCounters(): SubscriptionCounters {
  return {
    refreshes: 0,
    baseRebuilds: 0,
    baseRebuildFailures: 0,
    baseSize: 0,
    ephemeralSize: 0,
    subscribed: 0,
    unsubscribed: 0,
    evicted: 0,
    expired: 0,
    baseTruncated: 0,
    failures: 0,
  };
}
