/**
 * Cache Wrapper Utilities
 *
 * Higher-order functions and utilities for adding caching to server actions.
 * Provides automatic caching with minimal boilerplate.
 */

import { cacheClient } from "./client";
import {
  generateCacheKey,
  sanitizeUserId,
  type CacheModule,
  type CacheConfig,
  type CacheKey,
} from "@usemoney/cache";
import { cacheLogger as logger } from "@usemoney/logger";

/**
 * Default cache configurations by module
 * These can be overridden per-operation if needed
 *
 * ## `memoryTtl` — why some modules have it and most don't (MONEY-1127)
 *
 * Before MONEY-1127 both tiers used the SAME `ttl`, so the "L1 = 10s hot tier"
 * that CLAUDE.md and `PERFORMANCE-IMPROVEMENTS.md` (moved to the UseMoneyAI archive) describe never
 * actually existed. `memoryTtl` makes the L1 lifetime explicit; leaving it
 * unset keeps the old behaviour exactly.
 *
 * The rule applied below is NOT "shorter is better" — it is:
 *
 * - **Shorten L1 only where invalidation is asymmetric.** `deletePattern`
 *   issues a global Redis `DEL` but clears only the L1 of the process that ran
 *   it. Every other warm instance keeps serving the invalidated entry for the
 *   rest of `ttl`. That is a correctness gap, and only the modules that some
 *   `clear*Cache()` in `./invalidation.ts` actually names can hit it.
 * - **Leave L1 alone where nothing invalidates the key.** L1 and L2 then hold
 *   the identical entry with the identical expiry, so a short L1 buys ZERO
 *   freshness and costs a Redis GET plus a re-`JSON.parse` on every expiry.
 *   That covers `content`, `instrument`, `risk`, `tax`, `fund-comparison`,
 *   `learning`, `market`, `mf-metadata`.
 * - **Never shorten L1 for the big global blobs.** `discover` / `discover-mf`
 *   hold multi-MB universes on a 24h TTL and are the pathological case: a 30s
 *   L1 would add a Redis GET + multi-MB parse every 30 seconds to return
 *   byte-identical data.
 * - `mf-nav` / `fund-composition` run `enableMemory: false` — no L1 to tune.
 */
export const DEFAULT_CACHE_CONFIGS: Record<CacheModule, CacheConfig> = {
  // --- Invalidated on mutation → L1 shortened (see rule above) -------------
  // dashboard/positions/holdings/trades/mutual-funds are all cleared by
  // clearBrokerSyncCache + the trade/position/holding invalidators. Small
  // user-scoped payloads, so a ~20s L1 still absorbs the burst of repeated
  // reads inside one page load while bounding cross-instance staleness.
  dashboard: {
    ttl: 5 * 60,
    memoryTtl: 20,
    enableMemory: true,
    enableRedis: true,
  },
  // Intraday P&L — the most time-sensitive of the set.
  positions: {
    ttl: 3 * 60,
    memoryTtl: 20,
    enableMemory: true,
    enableRedis: true,
  },
  holdings: {
    ttl: 5 * 60,
    memoryTtl: 20,
    enableMemory: true,
    enableRedis: true,
  },
  trades: { ttl: 5 * 60, memoryTtl: 20, enableMemory: true, enableRedis: true },
  fire: { ttl: 5 * 60, memoryTtl: 30, enableMemory: true, enableRedis: true }, // user edits scenarios directly (clearFireCache)
  // clearSubscriptionCache clears subscription + user together.
  user: { ttl: 5 * 60, memoryTtl: 30, enableMemory: true, enableRedis: true },
  // 1h L1 on the broker list meant a just-connected broker could stay invisible
  // on another warm instance for an hour despite clearBrokerConnectionCache.
  brokers: {
    ttl: 60 * 60,
    memoryTtl: 30,
    enableMemory: true,
    enableRedis: true,
  },
  // Conversation history, read every turn and rewritten by deleteCached("chat")
  // + clearChatCache. A 1h L1 meant an instance could keep replaying a history
  // that was missing the latest turns. One Redis GET per turn is noise next to
  // the LLM call it precedes.
  chat: { ttl: 60 * 60, memoryTtl: 30, enableMemory: true, enableRedis: true },
  // Entitlements. After an upgrade the user must not stay gated, and a stale L1
  // on another instance is exactly that — shortest L1 in the table.
  subscription: {
    ttl: 5 * 60,
    memoryTtl: 15,
    enableMemory: true,
    enableRedis: true,
  },
  "mutual-funds": {
    ttl: 5 * 60,
    memoryTtl: 30,
    enableMemory: true,
    enableRedis: true,
  },
  // --- No invalidator → L1 deliberately left equal to ttl ------------------
  content: { ttl: 10 * 60, enableMemory: true, enableRedis: true }, // 10 min, public/global (keyed "public"), changes only on publish
  learning: { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5 min
  // 24h, and the TTL is the ONLY thing that refreshes these two. The comment
  // here used to read "invalidated on instrument sync" / "on MF sync"; neither
  // is true, and that mattered on MONEY-1093, where the fix depends on knowing
  // a stale universe cannot be flushed. Verified by exhaustion: `deleteCached`
  // is the only per-key invalidator and its sole non-test call site is
  // ("chat", …); `deletePattern`'s only callers are in `./invalidation.ts`,
  // which never names these modules (every invalidator there is user-scoped —
  // sync, import, pairing); and neither instrument-sync entry point
  // (`workers/src/processors/instrument-sync.ts`, the core orchestrator)
  // touches the cache at all. So changing what these entries CONTAIN requires
  // changing the cache IDENTIFIER too — see UNIVERSE_CACHE_KEY in
  // packages/services/src/discover.service.ts — or waiting out a full day.
  //
  // MONEY-1127: consequently these two get NO `memoryTtl`. They are multi-MB
  // universe blobs that nothing invalidates, so a short L1 would re-fetch and
  // re-parse megabytes from Redis to obtain the identical bytes. A warm lambda
  // serving them from memory for the full 24h with zero Redis traffic is the
  // desired behaviour, not an accident.
  discover: { ttl: 24 * 60 * 60, enableMemory: true, enableRedis: true },
  "discover-mf": { ttl: 24 * 60 * 60, enableMemory: true, enableRedis: true },
  market: { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5 min — no invalidator, no live call sites
  instrument: { ttl: 60 * 60, enableMemory: true, enableRedis: true }, // 1 hour — near-static global sector/industry metadata
  "mf-metadata": { ttl: 60 * 60, enableMemory: true, enableRedis: true }, // 1 hour
  "mf-nav": { ttl: 24 * 60 * 60, enableMemory: false, enableRedis: true }, // 24 hours — no L1 at all
  "fund-composition": {
    ttl: 24 * 60 * 60,
    enableMemory: false,
    enableRedis: true,
  }, // 24h — no L1 at all
  "fund-comparison": { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5min — derived compute, no invalidator
  // User-scoped and mutated by the user directly (clearWatchlistCache runs on
  // every create/delete/add/remove) — a stale L1 elsewhere reads as "I added it
  // and it vanished".
  watchlist: {
    ttl: 5 * 60,
    memoryTtl: 20,
    enableMemory: true,
    enableRedis: true,
  },
  // risk/tax: expensive derived compute that NO clear*Cache() names, so the TTL
  // is the only refresh. L1 and L2 hold the same entry with the same expiry —
  // shortening L1 would buy no freshness and cost a Redis GET + re-parse.
  risk: { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5 min
  tax: { ttl: 10 * 60, enableMemory: true, enableRedis: true }, // 10 min
};

/**
 * Get cache config for a module, with optional overrides
 */
export function getCacheConfig(
  module: CacheModule,
  overrides?: Partial<CacheConfig>,
): CacheConfig {
  const baseConfig = DEFAULT_CACHE_CONFIGS[module] || {
    ttl: 60,
    enableMemory: true,
    enableRedis: true,
  };
  return { ...baseConfig, ...overrides };
}

/**
 * In-process single-flight registry (MONEY-705). Concurrent cache misses on the
 * SAME key within one instance await a single fn() execution instead of each
 * recomputing — prevents a thundering herd on expensive risk / dashboard /
 * fund-composition / discover ops. Entries are cleared once execution settles.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** Cross-instance compute lock lifetime (auto-expires if a holder dies). */
const COMPUTE_LOCK_TTL_MS = 10_000;
/** Total time a peer waits for the lock holder to publish its value. */
const PEER_WAIT_TOTAL_MS = 3_000;
/** Poll interval while waiting for a peer's value. */
const PEER_WAIT_STEP_MS = 75;

/**
 * Poll the cache for a value a lock-holding peer is expected to publish.
 * Returns the value as soon as it appears, or null once the budget elapses
 * (the caller then computes itself — fail-open, never stalls a request).
 */
async function waitForPeerValue<T>(
  cacheKey: CacheKey,
  cacheConfig: CacheConfig,
): Promise<T | null> {
  const deadline = Date.now() + PEER_WAIT_TOTAL_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PEER_WAIT_STEP_MS));
    const value = await cacheClient.get<T>(cacheKey, cacheConfig);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Higher-order function to add caching to server actions
 * Wraps an async function with automatic caching logic
 *
 * @param module - Cache module name
 * @param identifier - Unique identifier for this operation
 * @param fn - Async function to wrap with caching
 * @param config - Optional cache config overrides
 * @returns Wrapped function with caching
 *
 * @example
 * ```typescript
 * // In lib/actions/dashboard.ts
 * export const getCachedDashboard = withCache(
 *   'dashboard',
 *   'stats',
 *   async (userId: string) => getDashboardStats(userId)
 * );
 * ```
 */
export function withCache<TArgs extends unknown[], TResult>(
  module: CacheModule,
  identifier: string,
  fn: (...args: TArgs) => Promise<TResult>,
  config?: Partial<CacheConfig>,
) {
  const cacheConfig = getCacheConfig(module, config);

  return async (...args: TArgs): Promise<TResult> => {
    // Extract userId from first arg (convention)
    const userId = args[0] as string;

    // Extract filters from second arg if present
    const filters = args[1] || undefined;

    // Generate cache key
    const cacheKey = generateCacheKey(module, userId, identifier, filters);

    // Try to get from cache
    const cached = await cacheClient.get<TResult>(cacheKey, cacheConfig);
    if (cached !== null) {
      logger.info(
        { module, identifier, userId: sanitizeUserId(userId), cacheHit: true },
        "Cache hit",
      );
      return cached;
    }

    // MONEY-705: in-process single-flight — concurrent misses on this key join
    // one execution instead of each stampeding fn().
    const inFlightKey = cacheKey as string;
    const joined = inFlight.get(inFlightKey);
    if (joined) {
      logger.debug(
        { module, identifier, userId: sanitizeUserId(userId) },
        "Cache miss - joined in-flight execution",
      );
      return (await joined) as TResult;
    }

    const compute = (async (): Promise<TResult> => {
      // Cross-instance single-flight (best-effort, fail-open): one instance
      // holds the lock + computes; peers briefly wait for its published value
      // before falling back to computing themselves.
      const lockKey = `lock:${cacheKey}`;
      const gotLock = await cacheClient.acquireLock(
        lockKey,
        COMPUTE_LOCK_TTL_MS,
      );
      if (!gotLock) {
        const peerValue = await waitForPeerValue<TResult>(
          cacheKey,
          cacheConfig,
        );
        if (peerValue !== null) return peerValue;
        // Peer didn't publish in time → compute anyway (never stall a request).
      }

      try {
        logger.debug(
          { module, identifier, userId: sanitizeUserId(userId) },
          "Cache miss - executing function",
        );
        const execStart = Date.now();
        const result = await fn(...args);
        const execDuration = Date.now() - execStart;
        await cacheClient.set(cacheKey, result, cacheConfig);
        logger.info(
          {
            module,
            identifier,
            userId: sanitizeUserId(userId),
            execDuration,
            cacheHit: false,
          },
          "Function executed and cached",
        );
        return result;
      } finally {
        if (gotLock) await cacheClient.releaseLock(lockKey);
      }
    })();

    inFlight.set(inFlightKey, compute);
    try {
      return await compute;
    } finally {
      inFlight.delete(inFlightKey);
    }
  };
}

/**
 * Manual cache get for more control
 * Use when you need fine-grained cache management
 *
 * @param module - Cache module name
 * @param userId - User ID
 * @param identifier - Cache identifier
 * @param filters - Optional filters for versioning
 * @param config - Optional cache config overrides
 * @returns Cached data or null
 *
 * @example
 * ```typescript
 * const cached = await getCached<DashboardStats>(
 *   'dashboard',
 *   userId,
 *   'stats'
 * );
 *
 * if (!cached) {
 *   // Fetch from database
 *   const data = await fetchFromDB();
 *   await setCached('dashboard', userId, 'stats', data);
 * }
 * ```
 */
export async function getCached<T>(
  module: CacheModule,
  userId: string,
  identifier: string,
  filters?: unknown,
  config?: Partial<CacheConfig>,
): Promise<T | null> {
  const cacheKey = generateCacheKey(module, userId, identifier, filters);
  const cacheConfig = getCacheConfig(module, config);
  return cacheClient.get<T>(cacheKey, cacheConfig);
}

/**
 * Manual cache set for more control
 *
 * @param module - Cache module name
 * @param userId - User ID
 * @param identifier - Cache identifier
 * @param data - Data to cache
 * @param filters - Optional filters for versioning
 * @param config - Optional cache config overrides
 *
 * @example
 * ```typescript
 * await setCached('dashboard', userId, 'stats', dashboardData);
 * ```
 */
export async function setCached<T>(
  module: CacheModule,
  userId: string,
  identifier: string,
  data: T,
  filters?: unknown,
  config?: Partial<CacheConfig>,
): Promise<void> {
  const cacheKey = generateCacheKey(module, userId, identifier, filters);
  const cacheConfig = getCacheConfig(module, config);
  await cacheClient.set(cacheKey, data, cacheConfig);
}

/**
 * Delete a specific cache entry
 *
 * @param module - Cache module name
 * @param userId - User ID
 * @param identifier - Cache identifier
 * @param filters - Optional filters used when caching
 */
export async function deleteCached(
  module: CacheModule,
  userId: string,
  identifier: string,
  filters?: unknown,
): Promise<void> {
  const cacheKey = generateCacheKey(module, userId, identifier, filters);
  await cacheClient.delete(cacheKey);
}
