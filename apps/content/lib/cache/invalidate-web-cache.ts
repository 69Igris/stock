/**
 * Invalidate web app content caches after CMS mutations.
 *
 * Connects directly to the shared Redis instance and deletes
 * content cache keys so the web app serves fresh data immediately.
 *
 * Fire-and-forget - errors are logged but never block the CMS action.
 */

import Redis from "ioredis";
import {
  getAllSlugPatterns,
  getListingPatterns,
  getSlugPattern,
} from "./invalidate-web-cache-logic";

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    redis = new Redis(url, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    redis.on("error", () => {
      // Suppress unhandled error events - invalidation is best-effort
    });
    return redis;
  } catch {
    return null;
  }
}

/**
 * Delete Redis keys matching a pattern using SCAN + DEL.
 * Returns the number of keys deleted.
 */
async function deletePattern(client: Redis, pattern: string): Promise<number> {
  let cursor = "0";
  let deleted = 0;

  do {
    const [next, keys] = await client.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length > 0) {
      await client.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== "0");

  return deleted;
}

// ── Public API ──

interface InvalidateOptions {
  contentType?: string;
  slug?: string;
  action: "create" | "update" | "delete" | "publish" | "unpublish";
}

/**
 * Invalidate web app content cache after a CMS mutation.
 * Connects directly to Redis - no HTTP endpoint or shared secret needed.
 * Runs as fire-and-forget - never throws.
 */
export async function invalidateWebContentCache(
  options: InvalidateOptions,
): Promise<void> {
  const client = getRedis();
  if (!client) return; // No Redis configured - skip (local dev)

  try {
    await client.connect().catch(() => {}); // ensure connected (lazy)

    const { contentType, slug } = options;
    let total = 0;

    // 1. Clear listing patterns (narrowed by type if known)
    for (const p of getListingPatterns(contentType)) {
      total += await deletePattern(client, p);
    }

    // 2. Clear specific post cache if slug provided
    if (slug) {
      const specificPattern = contentType
        ? getSlugPattern(contentType, slug)
        : "";
      if (specificPattern) {
        total += await deletePattern(client, specificPattern);
      } else {
        for (const p of getAllSlugPatterns(slug)) {
          total += await deletePattern(client, p);
        }
      }
    }

    if (total > 0) {
      console.log(
        `[Cache] Invalidated ${total} keys (${options.action} ${contentType ?? "all"}${slug ? ` / ${slug}` : ""})`,
      );
    }
  } catch (error) {
    // Log but never block CMS operations
    console.error("[Cache] Redis invalidation error:", error);
  }
}
