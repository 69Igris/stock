/**
 * Rate Limiting Utilities
 * Uses LRU Cache for efficient token tracking
 */

import { LRUCache } from "lru-cache";

interface RateLimitOptions {
  interval: number; // Time window in ms
  uniqueTokenPerInterval: number; // Max unique tokens to track
}

interface RateLimitResult {
  success: boolean;
  remaining: number;
  reset: number; // Time in ms until reset
}

/**
 * Create a rate limiter with the specified options
 */
export function createRateLimiter(options: RateLimitOptions) {
  // Value is a fixed [count, windowStart] 2-tuple (not number[]) so the package
  // tsconfig's noUncheckedIndexedAccess doesn't type the indexed reads as
  // `number | undefined`. Behaviour is identical to the apps/web original.
  const tokenCache = new LRUCache<string, [number, number]>({
    max: options.uniqueTokenPerInterval || 500,
    ttl: options.interval || 60000,
  });

  return {
    /**
     * Check if a request is allowed
     */
    check: async (limit: number, token: string): Promise<RateLimitResult> => {
      const now = Date.now();
      const tokenCount = tokenCache.get(token) || [0, now];

      // Check if we need to reset (outside the time window)
      if (now - tokenCount[1] >= options.interval) {
        tokenCache.set(token, [1, now]);
        return {
          success: true,
          remaining: limit - 1,
          reset: options.interval,
        };
      }

      tokenCount[0] += 1;
      const currentUsage = tokenCount[0];
      const isRateLimited = currentUsage > limit;

      tokenCache.set(token, tokenCount);

      return {
        success: !isRateLimited,
        remaining: Math.max(0, limit - currentUsage),
        reset: options.interval - (now - tokenCount[1]),
      };
    },

    /**
     * Reset rate limit for a specific token
     */
    reset: (token: string): void => {
      tokenCache.delete(token);
    },

    /**
     * Get current usage for a token
     */
    getUsage: (token: string): number => {
      const tokenCount = tokenCache.get(token);
      return tokenCount ? tokenCount[0] : 0;
    },
  };
}

// Pre-configured rate limiters for different use cases

/**
 * API Rate Limiter
 * 60 requests per minute per user
 */
export const apiRateLimiter = createRateLimiter({
  interval: 60 * 1000, // 1 minute
  uniqueTokenPerInterval: 500,
});

/**
 * Auth Rate Limiter
 * 10 auth attempts per 15 minutes per IP
 */
export const authRateLimiter = createRateLimiter({
  interval: 15 * 60 * 1000, // 15 minutes
  uniqueTokenPerInterval: 100,
});

/**
 * Broker API Rate Limiter
 * More restrictive - 30 requests per minute per broker
 */
export const brokerRateLimiter = createRateLimiter({
  interval: 60 * 1000, // 1 minute
  uniqueTokenPerInterval: 200,
});

/**
 * Sync Rate Limiter
 * 5 syncs per hour per user-broker combo
 */
export const syncRateLimiter = createRateLimiter({
  interval: 60 * 60 * 1000, // 1 hour
  uniqueTokenPerInterval: 100,
});

/**
 * Helper to create a rate limit key
 */
export function createRateLimitKey(...parts: string[]): string {
  return parts.filter(Boolean).join(":");
}

/**
 * Check rate limit and throw error if exceeded
 */
export async function checkRateLimit(
  limiter: ReturnType<typeof createRateLimiter>,
  limit: number,
  token: string,
  errorMessage: string = "Rate limit exceeded. Please try again later.",
): Promise<void> {
  const result = await limiter.check(limit, token);

  if (!result.success) {
    const error = new Error(errorMessage) as Error & {
      code: string;
      retryAfter: number;
    };
    error.code = "RATE_LIMIT_EXCEEDED";
    error.retryAfter = Math.ceil(result.reset / 1000); // seconds
    throw error;
  }
}
