/**
 * Web Redis client — a THIN DELEGATE over the canonical core singleton.
 *
 * MONEY-1127 (FIX 2): this module used to own its own `new Redis(...)`
 * singleton, independent of `packages/core/src/cache/redis.ts` and of the
 * third one in `packages/core/src/screener/index-constituents.ts`. A single
 * warm lambda therefore held 2-3 TCP connections to a managed node whose
 * documented ceiling is ~50 connections (`docs/reference/scaling-roadmap.md`).
 *
 * Every function below keeps its exact exported signature — `lib/cache/client.ts`,
 * `lib/redis/cache.ts` (feature flags), `lib/chat-tools/turn-context.ts` and
 * `lib/chat-tools/learned-patterns.ts` all call these — but the connection now
 * comes from `@usemoney/core/cache`.
 *
 * Provider support is unchanged. The core client reads REDIS_URL /
 * UPSTASH_REDIS_REST_URL / KV_URL and, since MONEY-1127, also synthesises a URL
 * from REDIS_HOST + REDIS_PORT (+ REDIS_AUTH_STRING) for Google Cloud
 * Memorystore — the one provider shape that only this file used to understand.
 *
 * Behavioural note vs. the old local copy: core's getter bounds its retries and
 * backs off after a burst of failures, so `getRedisClient()` can return null
 * during a cooldown where the old copy returned a permanently-broken client.
 * Every caller here already treats null as "no cache" and falls through, which
 * is the required fail-open behaviour.
 */

import type Redis from "ioredis";
import {
  getRedisClient as getCoreRedisClient,
  closeRedisConnection,
} from "@usemoney/core/cache";
import { cacheLogger as logger } from "@usemoney/logger";

/**
 * Get or create the Redis client singleton.
 *
 * Supports (via the core client):
 * - DigitalOcean Redis (REDIS_URL with rediss:// for TLS)
 * - Redis Cloud / Upstash / Vercel KV (REDIS_URL, UPSTASH_REDIS_REST_URL, KV_URL)
 * - Google Cloud Memorystore (REDIS_HOST + REDIS_PORT + REDIS_AUTH_STRING)
 * - Self-hosted Redis (either shape)
 *
 * Returns null when Redis is unconfigured or unavailable — callers MUST fall
 * back rather than throw.
 */
export function getRedisClient(): Redis | null {
  const client = getCoreRedisClient();
  if (!client && process.env.NODE_ENV === "production") {
    logger.warn(
      {},
      "Redis unavailable in production - using in-memory cache only"
    );
  }
  return client;
}

/**
 * Close the Redis connection gracefully.
 *
 * Delegates to the core singleton, so this closes the ONE process-wide
 * connection (previously it closed only the web-local copy and left core's
 * connection open).
 */
export async function closeRedisClient(): Promise<void> {
  await closeRedisConnection();
  logger.info({}, "Redis client closed");
}

/**
 * Check if Redis is available (round-trips a PING).
 */
export async function isRedisAvailable(): Promise<boolean> {
  const client = getRedisClient();
  if (!client) {
    return false;
  }

  try {
    await client.ping();
    return true;
  } catch (error) {
    logger.error({ error }, "Redis ping failed");
    return false;
  }
}
