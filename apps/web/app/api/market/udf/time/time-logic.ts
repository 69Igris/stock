/**
 * Server-time computation for the TradingView UDF `time` endpoint.
 *
 * Extracted from `route.ts` so the exact payload (a unix timestamp in
 * **seconds** as a plain integer string — NOT milliseconds, NOT JSON) can be
 * asserted directly. The route returns this string verbatim.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#time
 */

/** Content-Type the time endpoint replies with (plain text, not JSON). */
export const UDF_TIME_CONTENT_TYPE = "text/plain";

/**
 * Current server time as a unix-**seconds** integer string.
 * Mirrors `String(Math.floor(Date.now() / 1000))`.
 */
export function getServerTimeSeconds(now: number = Date.now()): string {
  return String(Math.floor(now / 1000));
}
