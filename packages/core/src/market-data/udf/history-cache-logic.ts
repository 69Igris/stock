/**
 * UDF History Cache — pure logic (MONEY-122 / MONEY-620).
 *
 * The dependency-free pieces of `udf-history-cache.ts`: the cache-key builder,
 * the market-hours-aware TTL picker, and the negative-cache TTL constant. They
 * live here so the unit tests assert the REAL exported symbols (no shadow) WITHOUT
 * importing `udf-history-cache.ts`, which pulls in `@/lib/cache/client` →
 * `@usemoney/datadog` → the Redis client chain (and would open a handle at module
 * load, orphaning the test runner).
 *
 * `udf-history-cache.ts` CALLS every export here, so the production cache path and
 * the tests execute the same bytes. This module imports nothing — importing it
 * never opens a DB/Redis/socket handle, so the tests stay pure and exit clean.
 *
 * @see apps/web/__tests__/market/udf-history-cache.test.ts
 */

export interface UdfHistoryCacheKeyInput {
  exchange: string;
  symbol: string;
  interval: string;
  fromSec: number;
  toSec: number;
  /**
   * MONEY-1176 — whether the payload is corporate-action ADJUSTED, and a
   * fingerprint of the actions used.
   *
   * Both parts are mandatory for correctness, not tidiness. Without the flag,
   * an `adj=0` request and a default request share a slot and one of them gets
   * the wrong basis. Without the fingerprint, a newly backfilled split serves
   * stale UNadjusted bars for the whole TTL — and worse, adjacent windows
   * cached either side of the backfill disagree with EACH OTHER, so a single
   * chart draws part of its history on one basis and part on another.
   *
   * Omitted (undefined) reproduces the pre-MONEY-1176 key exactly, so existing
   * callers and cached entries are unaffected.
   */
  adjusted?: boolean;
  actionsFingerprint?: string;
}

/**
 * Build a deterministic cache key for a UDF history request.
 *
 * Format: `udf:history:{EXCHANGE}:{SYMBOL}:{interval}:{fromSec}-{toSec}`
 *
 * Exchange and symbol are uppercased so `nse:tcs` and `NSE:TCS` hit the same
 * slot. The interval is NOT uppercased — TradingView resolution casing is
 * significant (`1D` daily vs `1d`… they must not collide). fromSec/toSec are
 * embedded verbatim as integer seconds; historical scroll-back repeats the same
 * window exactly, which is what makes the cache worthwhile. No user ID in the key
 * — these responses are identical across users.
 */
export function buildUdfHistoryCacheKey(
  input: UdfHistoryCacheKeyInput,
): string {
  const {
    exchange,
    symbol,
    interval,
    fromSec,
    toSec,
    adjusted,
    actionsFingerprint,
  } = input;
  const base = `udf:history:${exchange.toUpperCase()}:${symbol.toUpperCase()}:${interval}:${fromSec}-${toSec}`;
  // Back-compat: with no adjustment info the key is byte-identical to the
  // pre-MONEY-1176 one, so nothing already cached is orphaned.
  if (adjusted === undefined) return base;
  return `${base}:adj${adjusted ? 1 : 0}:${actionsFingerprint ?? "none"}`;
}

/** TradingView resolutions we treat as intraday for TTL selection. */
const INTRADAY_INTERVALS = new Set([
  "1m",
  "3m",
  "5m",
  "10m",
  "15m",
  "30m",
  "60m",
  "1h",
]);

/**
 * Pick a TTL (seconds) for a cache entry, given the interval and whether the NSE
 * session is live right now.
 *
 *   | Interval class           | Market hours | Off hours |
 *   | ------------------------ | ------------ | --------- |
 *   | Daily / weekly / monthly | 5 min        | 1 hour    |
 *   | Intraday (1m–60m / 1h)   | 30 sec       | 5 min     |
 *
 * During market hours the close of "today's bar" moves continuously, so a request
 * with `to > now - ttl` needs a short TTL to stay fresh. After hours, all bars are
 * immutable and can be cached generously.
 *
 * Pure: the live/off-hours decision is supplied by the caller (`inMarket`) rather
 * than read from the wall clock here, so it can be unit-tested deterministically.
 */
export function pickHistoryCacheTtlSeconds(
  interval: string,
  inMarket: boolean,
): number {
  const isIntraday = INTRADAY_INTERVALS.has(interval);
  if (isIntraday) {
    return inMarket ? 30 : 300; // 30s live, 5min off-hours
  }
  return inMarket ? 300 : 3600; // 5min live, 1h off-hours
}

/**
 * Shorter TTL for negative cache entries (no_data / error responses).
 *
 * Cached for a minute so consecutive identical scroll-past-history requests don't
 * re-hit the DB + upstream, but short enough that a user's next backfill round-trip
 * (which could legitimately populate the window) is visible quickly.
 */
export const NEGATIVE_CACHE_TTL_SECONDS = 60;

/* ─────────────────────────────────────────────────────────────────────────
   CDN caching — MONEY-1467 (A2)
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `Cache-Control` for `/udf/history` served by `apps/market-data`.
 *
 * DELIBERATELY a separate function from `pickHistoryCacheTtlSeconds` rather
 * than a second return value, because the two answer the same QUESTION ("is
 * the session live?") with different answers, and folding them together is how
 * one of the two silently becomes wrong:
 *
 *   `pickHistoryCacheTtlSeconds`  a REDIS TTL, per origin process
 *   this                          an `s-maxage` for a SHARED CDN
 *
 * During market hours the current session's bar moves continuously, so 60s
 * with `stale-while-revalidate` — the edge keeps answering instantly while it
 * refreshes behind the request, which is the difference between a chart that
 * redraws and one that stalls. Off hours every bar is immutable and an hour
 * costs nothing.
 *
 * `public` is required for a shared cache to store it at all. That is safe
 * here and NOT safe on web's equivalent route: this service's history is the
 * same bytes for every caller, while web's sits behind Clerk.
 */
export function cdnCacheControlForHistory(inMarket: boolean): string {
  return inMarket
    ? "public, s-maxage=60, stale-while-revalidate=300"
    : "public, s-maxage=3600, stale-while-revalidate=300";
}
