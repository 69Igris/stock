/**
 * UDF History Response Cache - MONEY-122
 *
 * Redis-backed cache layer in front of the TradingView UDF `/history`
 * endpoint. Keyed by the request shape (exchange + symbol + interval +
 * [fromSec, toSec]) so entries are shared across all users - the candles
 * for NSE:TCS 1D Jan-Feb 2026 are the same whether user A or user B asks.
 *
 * Why a custom helper (not the generic `withCache` wrapper):
 *
 *   - `withCache()` in `lib/cache/wrapper.ts` bakes in a per-user cache
 *     key convention (first arg is `userId`). UDF history responses are
 *     NOT per-user - caching them per-user would fragment the cache and
 *     miss the whole point. We bypass the wrapper and talk to
 *     `cacheClient` directly with a global key.
 *
 *   - TTLs need to be market-hours aware. During the live session, any
 *     cached bar for "today" is stale within seconds; after hours, bars
 *     are immutable and can be cached for an hour. The existing
 *     DEFAULT_CACHE_CONFIGS doesn't have that concept.
 *
 *   - Negative caching (no_data responses) needs a separate, shorter
 *     TTL so a mis-scrolled range doesn't get stuck for 5 minutes.
 *
 * Cache hierarchy:
 *
 *      Request
 *         │
 *         ▼
 *   ┌─────────────────┐
 *   │ Redis/memory    │ ← this module
 *   │ (by request     │
 *   │  shape)         │
 *   └────────┬────────┘
 *            │ miss
 *            ▼
 *   ┌─────────────────┐
 *   │ IntradayBar /   │ ← MONEY-123 Part A
 *   │ DailyPrice DB   │
 *   └────────┬────────┘
 *            │ miss
 *            ▼
 *   ┌─────────────────┐
 *   │ Zerodha / Yahoo │ ← fetchHistoricalBars
 *   └─────────────────┘
 *
 * This layer protects the DB path from duplicate reads and the upstream
 * path from duplicate live fetches.
 */

import { cacheClient } from "@/lib/cache/client";
import type { CacheConfig } from "@usemoney/cache";
import {
  buildUdfHistoryCacheKey,
  pickHistoryCacheTtlSeconds as pickHistoryCacheTtlSecondsPure,
  NEGATIVE_CACHE_TTL_SECONDS,
  type UdfHistoryCacheKeyInput,
} from "@/lib/market/udf-history-cache-logic";

// ============== KEY BUILDER ==============

// The pure key builder, TTL picker, and negative-cache TTL live in
// `udf-history-cache-logic.ts` (dependency-free) so they can be unit-tested
// against the REAL exports without dragging the Redis client into the test
// runner. Re-exported here so existing importers of this module keep working.
export type { UdfHistoryCacheKeyInput } from "@/lib/market/udf-history-cache-logic";
export {
  buildUdfHistoryCacheKey,
  NEGATIVE_CACHE_TTL_SECONDS,
} from "@/lib/market/udf-history-cache-logic";

// ============== MARKET-HOURS TTL ==============

/**
 * NSE trading hours: 09:15 – 15:30 IST, Mon – Fri.
 *
 * We only bother with time-of-day + day-of-week detection - no holiday
 * calendar. Holidays generate the same "empty response" the rest of
 * off-hours produce, so the longer TTL just caches that no_data for the
 * day, which is correct behavior.
 */
function isNseMarketHoursNow(): boolean {
  const now = new Date();
  // Convert to IST: server may be in UTC on Vercel. IST = UTC+5:30.
  // Use toLocaleString to avoid manual offset math + daylight-time
  // bugs (not relevant to IST but future-proof for other exchanges).
  const istParts = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const day = istParts.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;
  const hour = istParts.getHours();
  const minute = istParts.getMinutes();
  const hhmm = hour * 100 + minute;
  return hhmm >= 915 && hhmm <= 1530;
}

/**
 * Pick a TTL for a cache entry.
 *
 *   | Interval class          | Market hours | Off hours |
 *   | ----------------------- | ------------ | --------- |
 *   | Daily / weekly / monthly| 5 min        | 1 hour    |
 *   | Intraday (1m–60m)       | 30 sec       | 5 min     |
 *
 * During market hours the close of "today's bar" moves continuously, so
 * a request with `to > now - ttl` needs a short TTL to stay fresh. After
 * hours, all bars are immutable and can be cached generously.
 *
 * The intraday TTLs are deliberately short during market hours (30 s)
 * because the TradingView widget polls for the tail of its visible
 * range every ~10 s, and we want the "latest bar just closed" case to
 * refresh quickly. 30 s is tight enough to keep the chart responsive
 * without thrashing the upstream.
 */
export function pickHistoryCacheTtlSeconds(interval: string): number {
  // Delegate to the pure picker, supplying the live/off-hours flag from the
  // wall clock here so the picker itself stays deterministic + unit-testable.
  return pickHistoryCacheTtlSecondsPure(interval, isNseMarketHoursNow());
}

// ============== PUBLIC API ==============

/**
 * Read a cached response for a UDF history request.
 *
 * The cached value is the COMPLETE UDF response payload - shape
 * `{s:"ok", t, o, h, l, c, v}` OR `{s:"no_data", nextTime?}` OR
 * `{s:"error", errmsg}`. The route handler just JSON.stringify's
 * whatever comes out of here.
 *
 * Returns null on miss. Never throws - any Redis error just degrades
 * to a cache miss, logged by `cacheClient` internally.
 */
export async function getCachedUdfHistory<T>(
  input: UdfHistoryCacheKeyInput
): Promise<T | null> {
  const key = buildUdfHistoryCacheKey(input);
  // We use the "market" module's default config just for the layer
  // flags (memory + redis enabled). The TTL field is NOT read by
  // cacheClient.get - the entry's own embedded TTL from set() governs
  // expiry. So the TTL here is a no-op on the read path.
  const config: CacheConfig = {
    ttl: 0,
    enableMemory: true,
    enableRedis: true,
  };
  return cacheClient.get<T>(key, config);
}

/**
 * Write a UDF history response to the cache.
 *
 * Pass `negative: true` when caching a no_data / error response - that
 * overrides the normal market-hours TTL with `NEGATIVE_CACHE_TTL_SECONDS`.
 *
 * `fireAndForget` semantics: we don't await the set result in the
 * caller's critical path. Any Redis hiccup is logged and swallowed.
 */
export async function setCachedUdfHistory<T>(
  input: UdfHistoryCacheKeyInput,
  value: T,
  options: { negative?: boolean } = {}
): Promise<void> {
  const key = buildUdfHistoryCacheKey(input);
  const ttl = options.negative
    ? NEGATIVE_CACHE_TTL_SECONDS
    : pickHistoryCacheTtlSeconds(input.interval);
  const config: CacheConfig = {
    ttl,
    enableMemory: true,
    enableRedis: true,
  };
  try {
    await cacheClient.set(key, value, config);
  } catch {
    // cacheClient already logs internally; swallow here so a cache
    // error never fails the response.
  }
}

// ============== TEST HELPERS ==============

/**
 * Exported for tests only. Lets test code freeze "now" when checking
 * market-hours TTL selection without monkey-patching `Date`.
 */
export const __test__ = {
  isNseMarketHoursNow,
};
