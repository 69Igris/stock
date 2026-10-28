/**
 * ⚠️ MONEY-866: This is a LEGACY, app-local cache copy that has drifted from the
 * canonical implementation in `@usemoney/core/cache`. It is intentionally NOT
 * the portfolio cache path — all portfolio/broker server actions use
 * `@usemoney/core` (withCache + clearUserCache/clearTradeCache/...), which is
 * where the MONEY-705 single-flight + cross-instance lock live.
 *
 * Remaining consumers of THIS copy are narrow and low-volatility:
 *   - lib/actions/content.ts (getCached/setCached)
 *   - app/api/research/preview-plan/* and lib/market/udf-history-cache.ts
 *     (cacheClient directly), and lib/cache/swr-wrapper.ts (own in-flight dedup)
 *
 * Do NOT add new portfolio caching here — import from `@usemoney/core` instead.
 * Migrating the remaining consumers onto core is tracked as follow-up.
 */
import { cacheClient } from "./client";
import { generateCacheKey, sanitizeUserId } from "./keys";
import { cacheLogger as logger } from "@usemoney/logger";
import type { CacheModule, CacheConfig } from "@usemoney/cache";

/**
 * Default cache configurations by module
 * These can be overridden per-operation if needed
 */
export const DEFAULT_CACHE_CONFIGS: Record<CacheModule, CacheConfig> = {
  dashboard: { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5 min
  positions: { ttl: 3 * 60, enableMemory: true, enableRedis: true }, // 3 min
  holdings: { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5 min
  trades: { ttl: 3 * 60, enableMemory: true, enableRedis: true }, // 3 min
  fire: { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5 min
  user: { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5 min
  brokers: { ttl: 60 * 60, enableMemory: true, enableRedis: true }, // 1 hour
  chat: { ttl: 30, enableMemory: true, enableRedis: false }, // 30 sec, memory only
  subscription: { ttl: 1 * 60, enableMemory: true, enableRedis: true }, // 1 min
  "mutual-funds": { ttl: 10 * 60, enableMemory: true, enableRedis: true }, // 10 min
  discover: { ttl: 15 * 60, enableMemory: true, enableRedis: true }, // 15 min
  "discover-mf": { ttl: 30 * 60, enableMemory: true, enableRedis: true }, // 30 min
  market: { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5 min
  instrument: { ttl: 6 * 60 * 60, enableMemory: true, enableRedis: true }, // 6 hours
  content: { ttl: 60 * 60, enableMemory: true, enableRedis: true }, // 1 hour
  "content-search": { ttl: 5 * 60, enableMemory: true, enableRedis: true }, // 5 min (search queries)
};

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
export function withCache<TArgs extends any[], TResult>(
  module: CacheModule,
  identifier: string,
  fn: (...args: TArgs) => Promise<TResult>,
  config?: Partial<CacheConfig>
) {
  const cacheConfig: CacheConfig = {
    ...DEFAULT_CACHE_CONFIGS[module],
    ...config,
  };

  return async (...args: TArgs): Promise<TResult> => {
    // Extract userId from first arg (convention)
    const userId = args[0] as string;

    // Extract filters from second arg if present
    const filters = args[1] || undefined;

    // Generate cache key
    const cacheKey = generateCacheKey(module, userId, identifier, filters);

    // Try to get from cache
    const startTime = Date.now();
    const cached = await cacheClient.get<TResult>(cacheKey, cacheConfig);

    if (cached !== null) {
      const duration = Date.now() - startTime;
      logger.info(
        {
          module,
          identifier,
          userId: sanitizeUserId(userId),
          duration,
          cacheHit: true,
        },
        "Cache hit"
      );
      return cached;
    }

    // Cache miss - execute function
    logger.debug(
      { module, identifier, userId: sanitizeUserId(userId) },
      "Cache miss - executing function"
    );

    const execStart = Date.now();
    const result = await fn(...args);
    const execDuration = Date.now() - execStart;

    // Store in cache
    await cacheClient.set(cacheKey, result, cacheConfig);

    logger.info(
      {
        module,
        identifier,
        userId: sanitizeUserId(userId),
        execDuration,
        cacheHit: false,
      },
      "Function executed and cached"
    );

    return result;
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
  filters?: any,
  config?: Partial<CacheConfig>
): Promise<T | null> {
  const cacheKey = generateCacheKey(module, userId, identifier, filters);
  const cacheConfig: CacheConfig = {
    ...DEFAULT_CACHE_CONFIGS[module],
    ...config,
  };
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
  filters?: any,
  config?: Partial<CacheConfig>
): Promise<void> {
  const cacheKey = generateCacheKey(module, userId, identifier, filters);
  const cacheConfig: CacheConfig = {
    ...DEFAULT_CACHE_CONFIGS[module],
    ...config,
  };
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
  filters?: any
): Promise<void> {
  const cacheKey = generateCacheKey(module, userId, identifier, filters);
  await cacheClient.delete(cacheKey);
}
