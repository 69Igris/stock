/**
 * MOVED to `@usemoney/core/market-data/udf/history-cache-logic` (MONEY-1467).
 *
 * `apps/market-data` needs the same market-hours-aware TTL decision for its own
 * `/udf/history`, and two copies of a caching policy agree until the day they
 * do not. This file remains as a re-export shim because
 * `apps/web/__tests__/market/udf-history-cache.test.ts` and
 * `udf-history-cache.ts` both import it by this path.
 *
 * NOTE what did NOT move: the CDN `Cache-Control` values. Web caches in Redis
 * per user-facing request; the Cloud Run service emits an `s-maxage` for a
 * shared CDN. Same market-hours QUESTION, different answers — see
 * `cdnCacheControlForHistory` in core, which sits beside this and is
 * deliberately a separate function rather than a second return value.
 */
export * from "@usemoney/core/market-data/udf/history-cache-logic";
