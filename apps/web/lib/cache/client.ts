import { LRUCache } from "lru-cache";
import { getRedisClient } from "@/lib/redis/client";
import { cacheLogger as logger } from "@usemoney/logger";
import { metrics } from "@usemoney/datadog";
import type {
  CacheEntry,
  CacheConfig,
  CacheKey,
  CacheStats,
} from "@usemoney/cache";

/**
 * In-memory LRU cache (Layer 1)
 * Fast local cache with automatic eviction
 */
const memoryCache = new LRUCache<CacheKey, CacheEntry<any>>({
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

    const now = Date.now();

    // Layer 1: Try memory cache
    if (config.enableMemory) {
      const memEntry = memoryCache.get(key);
      if (memEntry && now - memEntry.timestamp < memEntry.ttl * 1000) {
        stats.memory.hits++;
        metrics.increment("cache.hit", 1, { layer: "memory" });
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
              metrics.increment("cache.hit", 1, { layer: "redis" });
              const age = Math.round((now - entry.timestamp) / 1000);
              logger.trace({ key, age, layer: "redis" }, "Cache hit");

              // Populate memory cache for next access
              if (config.enableMemory) {
                memoryCache.set(key, entry);
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
    metrics.increment("cache.miss", 1);
    logger.trace({ key }, "Cache miss");
    logStatsIfNeeded();
    return null;
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
    version?: string
  ): Promise<void> {
    // Check if caching is globally disabled
    if (!isCacheEnabled()) {
      return;
    }

    const entry: CacheEntry<T> = {
      data,
      version: version || "default",
      timestamp: Date.now(),
      ttl: config.ttl,
    };

    // Layer 1: Set in memory
    if (config.enableMemory) {
      memoryCache.set(key, entry, { ttl: config.ttl * 1000 });
      stats.memory.sets++;
      logger.trace({ key, ttl: config.ttl, layer: "memory" }, "Cache set");
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
          100
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
  getStats() {
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
      "Cache statistics"
    );
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
export function getCacheStats() {
  return cacheClient.getStats();
}

/**
 * Reset cache statistics (standalone function for API endpoint)
 */
export function resetCacheStats() {
  cacheClient.resetStats();
}
