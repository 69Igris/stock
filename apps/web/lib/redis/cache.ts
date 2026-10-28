import { getRedisClient } from "./client";
import type {
  FeatureFlagMap,
  FeatureFlagsResponse,
} from "@/lib/types/feature-flags";
import crypto from "crypto";
import { cacheLogger as logger } from "@usemoney/logger";

const CACHE_TTL_SECONDS = 5 * 60; // 5 minutes in seconds
const CACHE_KEY_PREFIX = "ff:"; // Feature flags prefix

/**
 * Generate a version hash from feature flags
 */
function generateFlagVersion(flags: FeatureFlagMap): string {
  const flagString = JSON.stringify(flags, Object.keys(flags).sort());
  return crypto.createHash("md5").update(flagString).digest("hex").slice(0, 8);
}

/**
 * Get cached feature flags for a user with version info
 */
export async function getCachedFlags(
  cacheKey: string
): Promise<FeatureFlagsResponse | null> {
  const client = getRedisClient();
  if (!client) {
    return null;
  }

  try {
    const key = `${CACHE_KEY_PREFIX}${cacheKey}`;
    const cached = await client.get(key);

    if (!cached) {
      return null;
    }

    const parsed = JSON.parse(cached) as FeatureFlagsResponse;
    logger.debug({ key }, "Cache hit");
    return parsed;
  } catch (error) {
    logger.error({ error, cacheKey }, "Error getting cached flags");
    return null;
  }
}

/**
 * Set cached feature flags for a user with version info
 */
export async function setCachedFlags(
  cacheKey: string,
  flags: FeatureFlagMap
): Promise<string> {
  const client = getRedisClient();

  const version = generateFlagVersion(flags);
  const timestamp = Date.now();

  const response: FeatureFlagsResponse = {
    flags,
    version,
    timestamp,
  };

  if (!client) {
    return version;
  }

  try {
    const key = `${CACHE_KEY_PREFIX}${cacheKey}`;
    await client.setex(key, CACHE_TTL_SECONDS, JSON.stringify(response));
    logger.debug({ cacheKey, version }, "Cached feature flags");
  } catch (error) {
    logger.error({ error, cacheKey }, "Error setting cached flags");
  }

  return version;
}

/**
 * Clear cached feature flags for a specific cache key
 */
export async function clearCachedFlags(cacheKey: string): Promise<void> {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  try {
    const key = `${CACHE_KEY_PREFIX}${cacheKey}`;
    await client.del(key);
    logger.debug({ cacheKey }, "Cleared cached flags");
  } catch (error) {
    logger.error({ error, cacheKey }, "Error clearing cached flags");
  }
}

/**
 * Clear all cached feature flags
 */
export async function clearAllCachedFlags(): Promise<void> {
  const client = getRedisClient();
  if (!client) {
    return;
  }

  try {
    const pattern = `${CACHE_KEY_PREFIX}*`;
    const keys = await client.keys(pattern);

    if (keys.length > 0) {
      await client.del(...keys);
      logger.info({ count: keys.length }, "Cleared all cached flag entries");
    }
  } catch (error) {
    logger.error({ error }, "Error clearing all cached flags");
  }
}
