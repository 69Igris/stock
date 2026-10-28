/**
 * Cache module names for key generation
 */
export type CacheModule =
  | "dashboard"
  | "positions"
  | "holdings"
  | "trades"
  | "fire"
  | "user"
  | "brokers"
  | "chat"
  | "subscription"
  | "mutual-funds"
  | "content"
  | "learning"
  | string; // Allow custom module names

/**
 * Cache configuration options
 */
export interface CacheConfig {
  /** Time-to-live in seconds */
  ttl: number;
  /**
   * Optional L1 (in-memory) time-to-live in seconds. MONEY-1127.
   *
   * Defaults to `ttl`, so OMITTING it preserves the historical behaviour where
   * both tiers expired together. It is clamped to `ttl` — L1 must never outlive
   * L2.
   *
   * **Set it shorter than `ttl`** for small, hot, user-scoped entries that
   * mutations invalidate. Invalidation is asymmetric: `deletePattern` issues a
   * global Redis `DEL` but only clears the L1 of the process that ran it, so
   * every OTHER warm instance keeps serving an entry that has already been
   * invalidated everywhere else, for the remainder of `ttl`. A short L1 bounds
   * that cross-instance staleness.
   *
   * **Leave it unset** for large, long-lived, global blobs (`discover`,
   * `discover-mf`: multi-MB universes on a 24h TTL). Shortening L1 there would
   * force a Redis GET plus a multi-MB `JSON.parse` on every expiry, and — since
   * nothing invalidates those keys — the value returned would be byte-identical.
   * Strictly worse.
   */
  memoryTtl?: number;
  /** Enable in-memory LRU cache layer */
  enableMemory: boolean;
  /** Enable Redis cache layer */
  enableRedis: boolean;
}

/**
 * Cache entry structure stored in both memory and Redis
 */
export interface CacheEntry<T> {
  /** Actual cached data */
  data: T;
  /** Version hash for cache invalidation */
  version: string;
  /** Timestamp when cached (milliseconds) */
  timestamp: number;
  /** TTL in seconds */
  ttl: number;
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
}

/**
 * Cache key type (string)
 */
export type CacheKey = string;

/**
 * Cache operation result
 */
export interface CacheOperationResult {
  success: boolean;
  error?: string;
}

/**
 * Default TTL values in seconds
 */
export const DEFAULT_TTL = {
  SHORT: 60, // 1 minute
  MEDIUM: 300, // 5 minutes
  LONG: 900, // 15 minutes
  HOUR: 3600, // 1 hour
  DAY: 86400, // 24 hours
} as const;
