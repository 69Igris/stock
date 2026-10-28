/**
 * Cache Module
 *
 * Provides dual-layer caching (Memory + Redis) with automatic management.
 * Re-exports key utilities from @usemoney/cache for convenience.
 */

// Redis client — the CANONICAL ioredis singleton (MONEY-1127). Never construct
// `new Redis(...)` in the apps/web runtime: a warm lambda must hold exactly one
// connection against a node whose documented ceiling is ~50.
export {
  getRedisClient,
  getRedisClientAsync,
  closeRedisConnection,
  resetRedisClient,
  isRedisConfigured,
  isRedisConnected,
  __setRedisClockForTests,
  __setRedisFactoryForTests,
  type RedisClientFactory,
} from "./redis";

// Cache client
export {
  CacheClient,
  cacheClient,
  getCacheStats,
  resetCacheStats,
  __setCacheClockForTests,
} from "./client";

// Cache wrapper utilities
export {
  DEFAULT_CACHE_CONFIGS,
  getCacheConfig,
  withCache,
  getCached,
  setCached,
  deleteCached,
} from "./wrapper";

// Stale-while-error + single-flight (MONEY-1092)
export {
  resolveWithStaleFallback,
  cachedWithStaleFallback,
  singleFlight,
  __resetSingleFlight,
  type Stamped,
  type ResolveOutcome,
  type StaleWhileErrorPorts,
  type CachedWithStaleFallbackArgs,
} from "./stale-while-error";

// Cache invalidation
export {
  clearUserCache,
  clearBrokerSyncCache,
  clearTradeCache,
  clearPositionCache,
  clearHoldingsCache,
  clearFireCache,
  clearSubscriptionCache,
  clearBrokerConnectionCache,
  clearChatCache,
  clearWatchlistCache,
  clearAllUserCache,
  clearCachePattern,
} from "./invalidation";

// Re-export from @usemoney/cache for convenience
export {
  generateVersionHash,
  generateCacheKey,
  parseCacheKey,
  generateCachePattern,
  sanitizeUserId,
  DEFAULT_TTL,
  type CacheModule,
  type CacheConfig,
  type CacheEntry,
  type CacheStats,
  type CacheKey,
  type CacheOperationResult,
} from "@usemoney/cache";
