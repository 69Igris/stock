/**
 * Stale-While-Revalidate Cache Wrapper
 *
 * Industry-standard caching pattern that:
 * 1. Returns cached data immediately (if available)
 * 2. Revalidates in background
 * 3. Updates cache with fresh data
 *
 * This provides instant perceived performance while ensuring data freshness.
 */

import { cacheClient } from "./client";
import type { CacheConfig } from "@usemoney/cache";

interface SWROptions {
  /** Cache key */
  key: string;
  /** Function to fetch fresh data */
  fetcher: () => Promise<any>;
  /** TTL in seconds for cache */
  ttl?: number;
  /** Stale time in seconds (how long to serve stale data) */
  staleTime?: number;
  /** Enable memory cache */
  enableMemory?: boolean;
  /** Enable Redis cache */
  enableRedis?: boolean;
}

interface SWRResult<T> {
  data: T | null;
  isStale: boolean;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Default cache configuration
 */
const DEFAULT_CONFIG: CacheConfig = {
  ttl: 300, // 5 minutes
  enableMemory: true,
  enableRedis: true,
};

/**
 * In-flight requests map to prevent duplicate fetches
 */
const inFlightRequests = new Map<string, Promise<any>>();

/**
 * SWR cache wrapper for server-side data fetching
 *
 * Usage:
 * ```ts
 * const result = await swrCache({
 *   key: `dashboard:${userId}`,
 *   fetcher: () => getDashboardStats(userId),
 *   ttl: 60,
 *   staleTime: 300,
 * });
 * ```
 */
export async function swrCache<T>({
  key,
  fetcher,
  ttl = DEFAULT_CONFIG.ttl,
  staleTime = ttl * 2, // Default stale time is 2x TTL
  enableMemory = true,
  enableRedis = true,
}: SWROptions): Promise<SWRResult<T>> {
  const config: CacheConfig = {
    ttl,
    enableMemory,
    enableRedis,
  };

  try {
    // Try to get from cache first
    const cached = await cacheClient.get<{ data: T; timestamp: number }>(
      key,
      config
    );

    if (cached) {
      const age = Date.now() - cached.timestamp;
      const isStale = age > ttl * 1000;
      const isTooOld = age > staleTime * 1000;

      // If data is stale but not too old, revalidate in background
      if (isStale && !isTooOld) {
        // Trigger background revalidation (don't await)
        revalidateInBackground(key, fetcher, config);
      }

      // If data is too old, fetch fresh data
      if (isTooOld) {
        const freshData = await fetchWithDedup(key, fetcher);
        await cacheClient.set(
          key,
          { data: freshData, timestamp: Date.now() },
          config
        );
        return {
          data: freshData,
          isStale: false,
          isLoading: false,
          error: null,
        };
      }

      return { data: cached.data, isStale, isLoading: false, error: null };
    }

    // No cache, fetch fresh data
    const freshData = await fetchWithDedup(key, fetcher);
    await cacheClient.set(
      key,
      { data: freshData, timestamp: Date.now() },
      config
    );
    return { data: freshData, isStale: false, isLoading: false, error: null };
  } catch (error) {
    console.error(`SWR cache error for key ${key}:`, error);
    return {
      data: null,
      isStale: false,
      isLoading: false,
      error: error as Error,
    };
  }
}

/**
 * Fetch with deduplication to prevent multiple concurrent requests for same key
 */
async function fetchWithDedup<T>(
  key: string,
  fetcher: () => Promise<T>
): Promise<T> {
  // Check if there's already an in-flight request
  const existing = inFlightRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  // Create new request
  const promise = fetcher();
  inFlightRequests.set(key, promise);

  try {
    const result = await promise;
    return result;
  } finally {
    // Clean up after request completes
    inFlightRequests.delete(key);
  }
}

/**
 * Revalidate cache in background (fire and forget)
 */
function revalidateInBackground<T>(
  key: string,
  fetcher: () => Promise<T>,
  config: CacheConfig
): void {
  // Don't await - let it run in background
  fetchWithDedup(key, fetcher)
    .then(async (freshData) => {
      await cacheClient.set(
        key,
        { data: freshData, timestamp: Date.now() },
        config
      );
    })
    .catch((error) => {
      console.error(`Background revalidation failed for key ${key}:`, error);
    });
}

/**
 * Invalidate cache for a specific key
 */
export async function invalidateCache(key: string): Promise<void> {
  await cacheClient.delete(key);
}

/**
 * Invalidate cache by pattern
 */
export async function invalidateCachePattern(pattern: string): Promise<number> {
  return cacheClient.deletePattern(pattern);
}

/**
 * Pre-warm cache with data
 */
export async function prewarmCache<T>(
  key: string,
  data: T,
  ttl: number = DEFAULT_CONFIG.ttl
): Promise<void> {
  const config: CacheConfig = {
    ttl,
    enableMemory: true,
    enableRedis: true,
  };
  await cacheClient.set(key, { data, timestamp: Date.now() }, config);
}

/**
 * Cache key generators for common patterns
 */
export const cacheKeys = {
  dashboard: (userId: string) => `dashboard:${userId}`,
  holdings: (userId: string, broker?: string) =>
    broker ? `holdings:${userId}:${broker}` : `holdings:${userId}:all`,
  positions: (userId: string) => `positions:${userId}`,
  trades: (userId: string, page?: number) =>
    page ? `trades:${userId}:page${page}` : `trades:${userId}`,
  pairedTrades: (userId: string, filters?: string) =>
    filters ? `pairedTrades:${userId}:${filters}` : `pairedTrades:${userId}`,
  mutualFunds: (userId: string) => `mutualFunds:${userId}`,
  paperTrading: (userId: string) => `paperTrading:${userId}`,
  brokerConnections: (userId: string) => `brokerConnections:${userId}`,
  fireScenarios: (userId: string) => `fireScenarios:${userId}`,
  // Content (public)
  blogPosts: (filters?: string) =>
    filters
      ? `content:public:blog-posts:${filters}`
      : `content:public:blog-posts`,
  blogPost: (slug: string) => `content:public:blog-post:${slug}`,
  featuredBlogPosts: (limit: number) => `content:public:featured-blog:${limit}`,
  latestBlogPosts: (limit: number) => `content:public:latest-blog:${limit}`,
  glossaryTerms: (search?: string) =>
    search ? `content:public:glossary:${search}` : `content:public:glossary`,
  glossaryTerm: (slug: string) => `content:public:glossary-term:${slug}`,
  newsletters: (filters?: string) =>
    filters
      ? `content:public:newsletters:${filters}`
      : `content:public:newsletters`,
  newsletter: (slug: string) => `content:public:newsletter:${slug}`,
  docs: (filters?: string) =>
    filters ? `content:public:docs:${filters}` : `content:public:docs`,
  doc: (slug: string) => `content:public:doc:${slug}`,
  tags: () => `content:public:tags`,
  tagBySlug: (slug: string) => `content:public:tag:${slug}`,
  helpGlossary: () => `content:public:help-glossary`,
};
