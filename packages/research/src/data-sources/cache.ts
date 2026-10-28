/**
 * Data Source Cache
 *
 * Simple Redis cache wrapper for external data source responses.
 * Falls back to in-memory Map when REDIS_URL is not set (e.g., tests).
 *
 * All keys are prefixed with "ds:" (data source) and have configurable TTL.
 * Uses dynamic require to avoid hard ioredis dependency at compile time.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

let redisClient: any = null;
let redisInitAttempted = false;

// In-memory fallback
const memoryCache = new Map<string, { data: string; expiresAt: number }>();

function getRedis(): any {
  if (redisClient) return redisClient;
  if (redisInitAttempted) return null;

  redisInitAttempted = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis");
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    return redisClient;
  } catch {
    // ioredis not available in this environment
    return null;
  }
}

const KEY_PREFIX = "ds:";

/**
 * Get a cached value by key.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const fullKey = `${KEY_PREFIX}${key}`;

  try {
    const redis = getRedis();
    if (redis) {
      const raw = await redis.get(fullKey);
      if (raw) return JSON.parse(raw) as T;
      return null;
    }
  } catch {
    // Fall through to memory
  }

  // Memory fallback
  const entry = memoryCache.get(fullKey);
  if (entry && entry.expiresAt > Date.now()) {
    return JSON.parse(entry.data) as T;
  }
  if (entry) memoryCache.delete(fullKey);
  return null;
}

/**
 * Set a cached value with TTL in seconds.
 */
export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  const fullKey = `${KEY_PREFIX}${key}`;
  const json = JSON.stringify(value);

  try {
    const redis = getRedis();
    if (redis) {
      await redis.set(fullKey, json, "EX", ttlSeconds);
      return;
    }
  } catch {
    // Fall through to memory
  }

  // Memory fallback
  memoryCache.set(fullKey, {
    data: json,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

/**
 * Get-or-compute pattern: return cached value or compute and cache.
 */
export async function cacheWrap<T>(
  key: string,
  fn: () => Promise<T | null>,
  ttlSeconds: number,
): Promise<T | null> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) return cached;

  const result = await fn();
  if (result !== null) {
    await cacheSet(key, result, ttlSeconds);
  }
  return result;
}
