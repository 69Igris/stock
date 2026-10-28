/**
 * The UDF config PAYLOAD now lives in `@usemoney/core/market-data/udf/config`
 * (MONEY-1466 / A1) so `apps/market-data` can serve the identical body.
 *
 * The CACHE-CONTROL HEADER below stays here on purpose. This route is behind
 * Clerk, so its response is `private`; the Cloud Run service is fronted by a
 * CDN and sends `public`. Sharing one constant would have made one of the two
 * wrong, and a wrong `Cache-Control` is invisible until something is cached
 * that should not have been.
 */
export * from "@usemoney/core/market-data/udf/config";

/**
 * MONEY-1383 (L3) — measured 0.42s per chart load on prod, paid on every single
 * one, because the response carried no caching directive at all.
 *
 * `private` is not decoration. This route sits behind Clerk/demo auth, so a
 * shared cache must not retain the body — the `max-age` is for the browser that
 * already authenticated. The Cloud Run service sends `public` for the identical
 * body, which is correct there and would be a disclosure here.
 */
export const CONFIG_CACHE_CONTROL = "private, max-age=3600";
