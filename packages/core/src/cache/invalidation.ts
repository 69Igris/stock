/**
 * Cache Invalidation Utilities
 *
 * Provides functions for clearing cache when data changes.
 * Use these functions after mutations to keep cache consistent.
 */

import { cacheClient } from "./client";
import {
  generateCachePattern,
  sanitizeUserId,
  type CacheModule,
} from "@usemoney/cache";
import { cacheLogger as logger } from "@usemoney/logger";

/**
 * Clear cache for specific user and module(s)
 *
 * @param userId - User ID
 * @param modules - Single module or array of modules to clear
 *
 * @example
 * ```typescript
 * // Clear single module
 * await clearUserCache(userId, 'dashboard');
 *
 * // Clear multiple modules
 * await clearUserCache(userId, ['dashboard', 'positions', 'holdings']);
 * ```
 */
export async function clearUserCache(
  userId: string,
  modules: CacheModule | CacheModule[],
): Promise<void> {
  const moduleArray = Array.isArray(modules) ? modules : [modules];

  logger.info(
    { userId: sanitizeUserId(userId), modules: moduleArray },
    "Clearing user cache",
  );

  const clearPromises = moduleArray.map((module) => {
    const pattern = generateCachePattern(module, userId);
    return cacheClient.deletePattern(pattern);
  });

  await Promise.all(clearPromises);
}

/**
 * Clear cache when broker sync happens
 * Invalidates: dashboard, positions, holdings, trades, mutual-funds
 *
 * @param userId - User ID
 *
 * @example
 * ```typescript
 * // In lib/actions/broker-connection.ts after successful sync
 * await clearBrokerSyncCache(userId);
 * ```
 */
export async function clearBrokerSyncCache(userId: string): Promise<void> {
  logger.info({ userId: sanitizeUserId(userId) }, "Clearing broker sync cache");

  await Promise.all([
    clearUserCache(userId, "dashboard"),
    clearUserCache(userId, "positions"),
    clearUserCache(userId, "holdings"),
    clearUserCache(userId, "trades"),
    clearUserCache(userId, "mutual-funds"),
  ]);
}

/**
 * Clear cache when trade is created/updated/deleted
 * Invalidates: dashboard, trades
 *
 * @param userId - User ID
 *
 * @example
 * ```typescript
 * // In lib/actions/trades.ts after trade mutation
 * await clearTradeCache(userId);
 * ```
 */
export async function clearTradeCache(userId: string): Promise<void> {
  logger.info({ userId: sanitizeUserId(userId) }, "Clearing trade cache");

  await Promise.all([
    clearUserCache(userId, "dashboard"),
    clearUserCache(userId, "trades"),
  ]);
}

/**
 * Clear cache when position is closed
 * Invalidates: dashboard, positions (holdings and trades not affected by position close)
 *
 * @param userId - User ID
 *
 * @example
 * ```typescript
 * // In lib/actions/trades.ts after closing position
 * await clearPositionCache(userId);
 * ```
 */
export async function clearPositionCache(userId: string): Promise<void> {
  logger.info({ userId: sanitizeUserId(userId) }, "Clearing position cache");

  await Promise.all([
    clearUserCache(userId, "dashboard"),
    clearUserCache(userId, "positions"),
  ]);
}

/**
 * Clear only holdings cache
 *
 * @param userId - User ID
 */
export async function clearHoldingsCache(userId: string): Promise<void> {
  logger.info({ userId: sanitizeUserId(userId) }, "Clearing holdings cache");

  await Promise.all([
    clearUserCache(userId, "dashboard"),
    clearUserCache(userId, "holdings"),
  ]);
}

/**
 * Clear cache when FIRE scenario is saved/deleted
 * Invalidates: fire cache (specific scenario or all)
 *
 * @param userId - User ID
 * @param scenarioId - Optional specific scenario ID
 *
 * @example
 * ```typescript
 * // Clear specific scenario
 * await clearFireCache(userId, 'scenario-abc-123');
 *
 * // Clear all scenarios
 * await clearFireCache(userId);
 * ```
 */
export async function clearFireCache(
  userId: string,
  scenarioId?: string,
): Promise<void> {
  logger.info(
    { userId: sanitizeUserId(userId), scenarioId },
    "Clearing FIRE cache",
  );

  if (scenarioId) {
    const pattern = generateCachePattern("fire", userId, scenarioId);
    await cacheClient.deletePattern(pattern);
  } else {
    await clearUserCache(userId, "fire");
  }
}

/**
 * Clear cache when subscription changes
 * Invalidates: subscription, user
 *
 * @param userId - User ID
 *
 * @example
 * ```typescript
 * // After subscription upgrade/downgrade
 * await clearSubscriptionCache(userId);
 * ```
 */
export async function clearSubscriptionCache(userId: string): Promise<void> {
  logger.info(
    { userId: sanitizeUserId(userId) },
    "Clearing subscription cache",
  );

  await Promise.all([
    clearUserCache(userId, "subscription"),
    clearUserCache(userId, "user"),
  ]);
}

/**
 * Clear cache when broker connection is updated
 * Invalidates: brokers
 *
 * @param userId - User ID
 *
 * @example
 * ```typescript
 * // After connecting/disconnecting broker
 * await clearBrokerConnectionCache(userId);
 * ```
 */
export async function clearBrokerConnectionCache(
  userId: string,
): Promise<void> {
  logger.info(
    { userId: sanitizeUserId(userId) },
    "Clearing broker connection cache",
  );

  await clearUserCache(userId, "brokers");
}

/**
 * Clear cache when chat history is updated
 * Invalidates: chat
 *
 * @param userId - User ID
 *
 * @example
 * ```typescript
 * // After creating/archiving chat
 * await clearChatCache(userId);
 * ```
 */
export async function clearChatCache(userId: string): Promise<void> {
  logger.info({ userId: sanitizeUserId(userId) }, "Clearing chat cache");

  await clearUserCache(userId, "chat");
}

/**
 * Clear cache when watchlist is created/updated/deleted or items change
 * Invalidates: watchlist
 *
 * @param userId - User ID
 *
 * @example
 * ```typescript
 * // After creating/deleting watchlist or adding/removing items
 * await clearWatchlistCache(userId);
 * ```
 */
export async function clearWatchlistCache(userId: string): Promise<void> {
  logger.info({ userId: sanitizeUserId(userId) }, "Clearing watchlist cache");

  await clearUserCache(userId, "watchlist");
}

/**
 * Clear all cache for a user (nuclear option)
 * Use sparingly - only when necessary (e.g., user logout, account deletion)
 *
 * @param userId - User ID
 *
 * @example
 * ```typescript
 * // On user logout or account deletion
 * await clearAllUserCache(userId);
 * ```
 */
export async function clearAllUserCache(userId: string): Promise<void> {
  logger.warn({ userId: sanitizeUserId(userId) }, "Clearing ALL user cache");

  const allModules: CacheModule[] = [
    "dashboard",
    "positions",
    "holdings",
    "trades",
    "fire",
    "user",
    "brokers",
    "chat",
    "subscription",
    "mutual-funds",
  ];

  await clearUserCache(userId, allModules);
}

/**
 * Clear specific cache entry (for manual cache management)
 *
 * @param pattern - Redis key pattern to delete
 * @returns Number of keys deleted
 *
 * @example
 * ```typescript
 * // Clear specific pattern
 * const deleted = await clearCachePattern('dashboard:user123:stats:*');
 * console.log(`Deleted ${deleted} keys`);
 * ```
 */
export async function clearCachePattern(pattern: string): Promise<number> {
  logger.info({ pattern }, "Clearing cache pattern");
  return cacheClient.deletePattern(pattern);
}
