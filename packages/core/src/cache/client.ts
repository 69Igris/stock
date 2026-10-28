/**
 * Dual-Layer Cache Client
 *
 * Implements two-tier caching: Memory (Layer 1) → Redis (Layer 2)
 * Provides fast in-memory access with Redis persistence.
 */

import { LRUCache } from "lru-cache";
import { getRedisClient } from "./redis";
import { cacheLogger as logger } from "@usemoney/logger";
import type {
  CacheEntry,
  CacheConfig,
  CacheKey,
  CacheStats,
} from "@usemoney/cache";

/**
 * In-memory LRU cache (Layer 1)
 * Fast local cache with automatic eviction
 *
 * KNOWN LIMIT (MONEY-1127, deferred): `max` bounds this cache by ENTRY COUNT,
 * not by bytes. The `discover` / `discover-mf` universes are multi-MB blobs and
 * count as one entry each, so a handful of them can sit alongside 1000 small
 * entries without triggering any eviction. Bounding by size needs
 * `maxSize` + `sizeCalculation` and a measured budget — its own ticket.
 */
const memoryCache = new LRUCache<CacheKey, CacheEntry<unknown>>({
  max: 1000, // Store up to 1000 entries
  ttl: 5 * 60 * 1000, // Default 5 minutes in milliseconds
  updateAgeOnGet: true,
  allowStale: false,
});

/**
 * Cache statistics for monitoring
 * Tracks memory and Redis stats separately
 */
const stats = {
  memory: {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    errors: 0,
  },
  redis: {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    errors: 0,
  },
};

/**
 * Check if cache is globally enabled via environment variable
 */
function isCacheEnabled(): boolean {
  return process.env.CACHE_ENABLED !== "false";
}

/**
 * Injectable clock (MONEY-1127). L1 expiry is decided by comparing `now`
 * against the entry's write timestamp, so tests drive `memoryTtl` expiry with
 * a fake clock instead of real waits (which would be slow and flaky).
 */
let nowFn: () => number = Date.now;

/** Test seam: override the cache clock. Pass null to restore `Date.now`. */
export function __setCacheClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? Date.now;
}

/**
 * Effective L1 lifetime for a config, in seconds (MONEY-1127).
 *
 * Defaults to `config.ttl` so an unset `memoryTtl` behaves exactly as before.
 * Clamped to `ttl` because L1 must never outlive L2, and guarded against
 * non-finite / non-positive input (a NaN here would make `now - ts < NaN`
 * false forever, i.e. a permanently cold L1).
 */
function memoryTtlSeconds(config: CacheConfig): number {
  const raw = config.memoryTtl;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return config.ttl;
  }
  return Math.min(raw, config.ttl);
}

/**
 * Log cache statistics periodically (every 100 operations)
 */
function logStatsIfNeeded(): void {
  const memTotal = stats.memory.hits + stats.memory.misses;
  const redisTotal = stats.redis.hits + stats.redis.misses;
  const total = memTotal + redisTotal;

  if (total > 0 && total % 100 === 0) {
    const memHitRate =
      memTotal > 0 ? ((stats.memory.hits / memTotal) * 100).toFixed(2) : "0.00";
    const redisHitRate =
      redisTotal > 0
        ? ((stats.redis.hits / redisTotal) * 100).toFixed(2)
        : "0.00";
    const overallHitRate = (
      ((stats.memory.hits + stats.redis.hits) / total) *
      100
    ).toFixed(2);

    logger.info(
      {
        memory: {
          hitRate: `${memHitRate}%`,
          hits: stats.memory.hits,
          misses: stats.memory.misses,
        },
        redis: {
          hitRate: `${redisHitRate}%`,
          hits: stats.redis.hits,
          misses: stats.redis.misses,
        },
        overall: {
          hitRate: `${overallHitRate}%`,
          total,
        },
      },
      "Cache statistics",
    );
  }
}

/**
 * Dual-layer cache client
 * Implements two-tier caching: Memory (Layer 1) → Redis (Layer 2)
 *
 * Cache lookup flow:
 * 1. Try memory cache (fastest)
 * 2. If miss, try Redis cache
 * 3. If Redis hit, populate memory cache
 * 4. If both miss, return null
 *
 * Cache write flow:
 * 1. Write to memory cache
 * 2. Write to Redis cache (if enabled)
 * 3. Both operations are fire-and-forget for performance
 */
export class CacheClient {
  /**
   * Get cached data with dual-layer lookup
   *
   * @param key - Cache key
   * @param config - Cache configuration (TTL, layer enables)
   * @returns Cached data or null if miss
   */
  async get<T>(key: CacheKey, config: CacheConfig): Promise<T | null> {
    // Check if caching is globally disabled
    if (!isCacheEnabled()) {
      return null;
    }

    const now = nowFn();

    // Layer 1: Try memory cache
    if (config.enableMemory) {
      const memEntry = memoryCache.get(key);
      // MONEY-1127: L1 validity is `min(memoryTtl, entry.ttl)`, not `entry.ttl`.
      // With `memoryTtl` unset the two are equal, so this is a no-op for every
      // module that has not opted in.
      const memTtl = Math.min(memoryTtlSeconds(config), memEntry?.ttl ?? 0);
      if (memEntry && now - memEntry.timestamp < memTtl * 1000) {
        stats.memory.hits++;
        const age = Math.round((now - memEntry.timestamp) / 1000);
        logger.trace({ key, age, layer: "memory" }, "Cache hit");
        logStatsIfNeeded();
        return memEntry.data as T;
      }
    }

    // Layer 2: Try Redis cache
    if (config.enableRedis) {
      const redis = getRedisClient();
      if (redis) {
        try {
          const cached = await redis.get(key);
          if (cached) {
            const entry: CacheEntry<T> = JSON.parse(cached);

            // Check if still valid
            if (now - entry.timestamp < entry.ttl * 1000) {
              stats.redis.hits++;
              const age = Math.round((now - entry.timestamp) / 1000);
              logger.trace({ key, age, layer: "redis" }, "Cache hit");

              // Populate memory cache for next access.
              //
              // MONEY-1127, two fixes here:
              //  1. This path previously passed no `ttl` at all, so a promoted
              //     entry silently inherited the LRU's 5-minute DEFAULT
              //     regardless of config — a 24h `discover` blob promoted from
              //     Redis survived only 5 minutes in memory.
              //  2. The L1 copy is RE-STAMPED. `memoryTtl` bounds how long THIS
              //     process may serve a value without re-checking Redis,
              //     measured from when it read it. Keeping the original write
              //     timestamp would promote an entry that is already older than
              //     `memoryTtl` — instantly stale, so every subsequent read
              //     would round-trip to Redis and L1 would never hit at all.
              //     `ttl` is narrowed to the REMAINING L2 lifetime so the L1
              //     copy still can never outlive L2.
              if (config.enableMemory) {
                const remainingMs = entry.timestamp + entry.ttl * 1000 - now;
                if (remainingMs > 0) {
                  const promoteMs = Math.min(
                    memoryTtlSeconds(config) * 1000,
                    remainingMs,
                  );
                  const l1Entry: CacheEntry<T> = {
                    ...entry,
                    timestamp: now,
                    ttl: remainingMs / 1000,
                  };
                  memoryCache.set(key, l1Entry, { ttl: promoteMs });
                }
              }

              logStatsIfNeeded();
              return entry.data;
            }
          }
        } catch (error) {
          stats.redis.errors++;
          logger.error({ error, key }, "Redis cache get error");
        }
      }
    }

    // Cache miss - track in both if both were tried
    if (config.enableMemory) stats.memory.misses++;
    if (config.enableRedis && getRedisClient()) stats.redis.misses++;
    logger.trace({ key }, "Cache miss");
    logStatsIfNeeded();
    return null;
  }

  /**
   * Batched dual-layer read — ONE Redis `MGET` for every L1 miss (MONEY-705).
   *
   * `get()` costs one Redis round trip per key. Callers that need N keys at
   * once (the sparkline service asks for up to 100 symbols in a single request)
   * paid N round trips for what Redis can answer in one. The lookup order,
   * validity rules, L1 promotion and re-stamping are byte-for-byte the same as
   * {@link get} — this only changes how many times we talk to Redis.
   *
   * @returns One slot per input key, positionally aligned, `null` on a miss.
   *          Duplicate keys are fine (each slot is filled independently).
   *
   * FAIL-OPEN: a Redis failure, an unparseable payload, or a single corrupt
   * entry degrades that slot to `null` (i.e. "compute it"), never throws.
   */
  async getMany<T>(
    keys: CacheKey[],
    config: CacheConfig,
  ): Promise<Array<T | null>> {
    const out: Array<T | null> = new Array<T | null>(keys.length).fill(null);
    if (!isCacheEnabled() || keys.length === 0) return out;

    const now = nowFn();
    // Indices still unresolved after L1. Everything is a miss when L1 is off.
    const missIdx: number[] = [];

    // Layer 1: memory
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (!config.enableMemory) {
        missIdx.push(i);
        continue;
      }
      const memEntry = memoryCache.get(key);
      const memTtl = Math.min(memoryTtlSeconds(config), memEntry?.ttl ?? 0);
      if (memEntry && now - memEntry.timestamp < memTtl * 1000) {
        stats.memory.hits++;
        out[i] = memEntry.data as T;
      } else {
        missIdx.push(i);
      }
    }

    if (missIdx.length === 0) {
      logStatsIfNeeded();
      return out;
    }

    // Layer 2: ONE MGET covering every L1 miss.
    const redis = config.enableRedis ? getRedisClient() : null;
    if (redis) {
      try {
        const missKeys = missIdx.map((i) => keys[i]!);
        const raw = await redis.mget(...missKeys);
        for (let j = 0; j < missIdx.length; j++) {
          const cached = raw[j];
          if (!cached) continue;

          let entry: CacheEntry<T>;
          try {
            entry = JSON.parse(cached) as CacheEntry<T>;
          } catch {
            // One corrupt value must not fail the whole batch.
            continue;
          }
          if (!(now - entry.timestamp < entry.ttl * 1000)) continue;

          stats.redis.hits++;
          out[missIdx[j]!] = entry.data;

          // Same promotion + re-stamp as get() — see the comment there.
          if (config.enableMemory) {
            const remainingMs = entry.timestamp + entry.ttl * 1000 - now;
            if (remainingMs > 0) {
              const promoteMs = Math.min(
                memoryTtlSeconds(config) * 1000,
                remainingMs,
              );
              const l1Entry: CacheEntry<T> = {
                ...entry,
                timestamp: now,
                ttl: remainingMs / 1000,
              };
              memoryCache.set(keys[missIdx[j]!]!, l1Entry, { ttl: promoteMs });
            }
          }
        }
      } catch (error) {
        stats.redis.errors++;
        logger.error(
          { error, keyCount: missIdx.length },
          "Redis cache mget error",
        );
      }
    }

    // Miss accounting mirrors get(): only a FULL miss counts against a layer.
    for (const i of missIdx) {
      if (out[i] !== null) continue;
      if (config.enableMemory) stats.memory.misses++;
      if (config.enableRedis && redis) stats.redis.misses++;
    }
    logStatsIfNeeded();
    return out;
  }

  /**
   * Set cached data in both layers
   *
   * @param key - Cache key
   * @param data - Data to cache
   * @param config - Cache configuration
   * @param version - Optional version string
   */
  async set<T>(
    key: CacheKey,
    data: T,
    config: CacheConfig,
    version?: string,
  ): Promise<void> {
    // Check if caching is globally disabled
    if (!isCacheEnabled()) {
      return;
    }

    const entry: CacheEntry<T> = {
      data,
      version: version || "default",
      timestamp: nowFn(),
      ttl: config.ttl,
    };

    // Layer 1: Set in memory
    if (config.enableMemory) {
      // MONEY-1127: L1 gets its own (never longer) lifetime so the LRU reclaims
      // short-lived entries early. `memoryTtl` unset → identical to before.
      const memTtl = memoryTtlSeconds(config);
      memoryCache.set(key, entry, { ttl: memTtl * 1000 });
      stats.memory.sets++;
      logger.trace({ key, ttl: memTtl, layer: "memory" }, "Cache set");
    }

    // Layer 2: Set in Redis
    if (config.enableRedis) {
      const redis = getRedisClient();
      if (redis) {
        try {
          await redis.setex(key, config.ttl, JSON.stringify(entry));
          stats.redis.sets++;
          logger.trace({ key, ttl: config.ttl, layer: "redis" }, "Cache set");
        } catch (error) {
          stats.redis.errors++;
          logger.error({ error, key }, "Redis cache set error");
        }
      }
    }
  }

  /**
   * Batched dual-layer write — ONE pipelined Redis round trip (MONEY-705).
   *
   * The counterpart to {@link getMany}. `set()` issues one `SETEX` per key;
   * writing back N freshly computed entries therefore cost N round trips. An
   * ioredis pipeline sends all N `SETEX` commands in a single flush.
   *
   * Every entry shares ONE timestamp so a batch expires as a batch (they were
   * computed together), and every entry gets the same `config.ttl` — identical
   * to calling {@link set} N times with the same config.
   *
   * FAIL-OPEN: cache writes are best-effort. A Redis failure is logged and
   * swallowed; the caller already holds the value it was trying to persist.
   */
  async setMany<T>(
    entries: Array<{ key: CacheKey; data: T }>,
    config: CacheConfig,
    version?: string,
  ): Promise<void> {
    if (!isCacheEnabled() || entries.length === 0) return;

    const timestamp = nowFn();
    const built = entries.map(({ key, data }) => ({
      key,
      entry: {
        data,
        version: version || "default",
        timestamp,
        ttl: config.ttl,
      } satisfies CacheEntry<T>,
    }));

    // Layer 1: memory
    if (config.enableMemory) {
      const memTtl = memoryTtlSeconds(config);
      for (const { key, entry } of built) {
        memoryCache.set(key, entry, { ttl: memTtl * 1000 });
        stats.memory.sets++;
      }
      logger.trace(
        { count: built.length, ttl: memTtl, layer: "memory" },
        "Cache setMany",
      );
    }

    // Layer 2: one pipelined flush
    if (config.enableRedis) {
      const redis = getRedisClient();
      if (redis) {
        try {
          const pipeline = redis.pipeline();
          for (const { key, entry } of built) {
            pipeline.setex(key, config.ttl, JSON.stringify(entry));
          }
          await pipeline.exec();
          stats.redis.sets += built.length;
          logger.trace(
            { count: built.length, ttl: config.ttl, layer: "redis" },
            "Cache setMany",
          );
        } catch (error) {
          stats.redis.errors++;
          logger.error(
            { error, keyCount: built.length },
            "Redis cache pipeline set error",
          );
        }
      }
    }
  }

  /**
   * Delete specific cache key from both layers
   *
   * @param key - Cache key to delete
   */
  async delete(key: CacheKey): Promise<void> {
    // Delete from memory
    memoryCache.delete(key);
    stats.memory.deletes++;

    // Delete from Redis
    const redis = getRedisClient();
    if (redis) {
      try {
        await redis.del(key);
        stats.redis.deletes++;
        logger.debug({ key }, "Cache key deleted");
      } catch (error) {
        stats.redis.errors++;
        logger.error({ error, key }, "Cache delete error");
      }
    }
  }

  /**
   * Best-effort cross-instance compute lock (Redis `SET key 1 PX ttl NX`).
   *
   * FAIL-OPEN by design — caching infra must never block or fail a request:
   * - no Redis configured → returns true (nothing to coordinate; caller computes)
   * - Redis throws        → returns true (compute rather than stall)
   * - lock already held   → returns false (a peer is computing)
   */
  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const redis = getRedisClient();
    if (!redis) return true;
    try {
      const res = await redis.set(key, "1", "PX", ttlMs, "NX");
      return res === "OK";
    } catch (error) {
      logger.error({ error, key }, "Cache lock acquire error (failing open)");
      return true;
    }
  }

  /** Release a lock acquired via {@link acquireLock} (best-effort). */
  async releaseLock(key: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    try {
      await redis.del(key);
    } catch (error) {
      logger.error({ error, key }, "Cache lock release error");
    }
  }

  /**
   * Delete keys matching a pattern (Redis only)
   * Used for bulk cache invalidation
   *
   * @param pattern - Redis key pattern (e.g., "dashboard:user123:*")
   * @returns Number of keys deleted
   */
  async deletePattern(pattern: string): Promise<number> {
    const redis = getRedisClient();
    if (!redis) {
      logger.warn({ pattern }, "Cannot delete pattern - Redis unavailable");
      return 0;
    }

    try {
      // Use SCAN instead of KEYS to avoid blocking the Redis event loop
      let cursor = "0";
      let totalDeleted = 0;

      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          100,
        );
        cursor = nextCursor;

        if (keys.length > 0) {
          await redis.del(...keys);
          totalDeleted += keys.length;
          stats.redis.deletes += keys.length;

          // Also delete from memory cache
          for (const key of keys) {
            memoryCache.delete(key);
            stats.memory.deletes++;
          }
        }
      } while (cursor !== "0");

      if (totalDeleted > 0) {
        logger.info({ pattern, count: totalDeleted }, "Cache pattern deleted");
      }
      return totalDeleted;
    } catch (error) {
      stats.redis.errors++;
      logger.error({ error, pattern }, "Cache pattern delete error");
      return 0;
    }
  }

  /**
   * Clear all cache from memory (use sparingly)
   * Note: Does NOT clear Redis to preserve feature flags and other data
   */
  async clearMemory(): Promise<void> {
    memoryCache.clear();
    logger.info("Memory cache cleared");
  }

  /**
   * Get current cache statistics (separated by layer)
   *
   * @returns Cache statistics object with memory and Redis stats
   */
  getStats(): { memory: CacheStats; redis: CacheStats } {
    return {
      memory: { ...stats.memory },
      redis: { ...stats.redis },
    };
  }

  /**
   * Reset cache statistics
   */
  resetStats(): void {
    stats.memory = { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0 };
    stats.redis = { hits: 0, misses: 0, sets: 0, deletes: 0, errors: 0 };
    logger.debug("Cache statistics reset");
  }
}

/**
 * Singleton cache client instance
 * Use this exported instance throughout the application
 */
export const cacheClient = new CacheClient();

/**
 * Get cache statistics (standalone function for API endpoint)
 * @returns Separated memory and Redis cache statistics
 */
export function getCacheStats(): { memory: CacheStats; redis: CacheStats } {
  return cacheClient.getStats();
}

/**
 * Reset cache statistics (standalone function for API endpoint)
 */
export function resetCacheStats(): void {
  cacheClient.resetStats();
}
