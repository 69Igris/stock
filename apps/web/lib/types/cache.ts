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
  | "mutual-funds";

/**
 * Cache configuration options
 */
export interface CacheConfig {
  /** Time-to-live in seconds */
  ttl: number;
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
