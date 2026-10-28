/**
 * Chartink.com Data Client
 *
 * Chartink provides technical screening with candlestick patterns,
 * moving averages, volume indicators. Their screener page at
 * chartink.com/screener uses POST to /screener/process with
 * a Chartink query language string.
 *
 * Rate limited: 1 request per 2 seconds.
 */

import ky from "ky";
import { cacheGet, cacheSet } from "./cache";

const BASE_URL = "https://chartink.com";
const API_TIMEOUT_MS = 15_000;
const REQUEST_DELAY_MS = 2_000;
const CACHE_TTL_SECONDS = 3600;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ChartinkResult {
  nsecode: string;
  bsecode: string;
  name: string;
  close: number;
  volume: number;
  per_chg: number;
  [key: string]: unknown;
}

/**
 * Run a Chartink scan query.
 * Query language example: "( {cash} ( latest close > latest sma( close,200 ) ) )"
 *
 * Cache-first: returns cached results immediately (no delay).
 * Only hits Chartink API on cache miss (with rate-limiting delays).
 */
export async function runChartinkScan(
  scanQuery: string,
): Promise<ChartinkResult[]> {
  const cacheKey = `ci:scan:${Buffer.from(scanQuery).toString("base64").slice(0, 40)}`;

  // Check cache first - no delay for cache hits
  const cached = await cacheGet<ChartinkResult[]>(cacheKey);
  if (cached) {
    return cached;
  }

  // Cache miss - fetch from Chartink with rate limiting
  try {
    await delay(REQUEST_DELAY_MS);

    // Step 1: Get CSRF token from the screener page
    const pageHtml = await ky
      .get(`${BASE_URL}/screener/process`, {
        timeout: API_TIMEOUT_MS,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; UseMoney/1.0)",
          Accept: "text/html",
        },
      })
      .text();

    // Extract CSRF token from meta tag
    const csrfMatch = pageHtml.match(
      /meta\s+name="csrf-token"\s+content="([^"]+)"/,
    );
    if (!csrfMatch) {
      console.warn("[chartink] Could not extract CSRF token");
      return [];
    }
    const csrfToken = csrfMatch[1]!;

    await delay(REQUEST_DELAY_MS);

    // Step 2: POST scan query
    const resp = await ky
      .post(`${BASE_URL}/screener/process`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; UseMoney/1.0)",
          "X-CSRF-TOKEN": csrfToken,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `scan_clause=${encodeURIComponent(scanQuery)}`,
        timeout: API_TIMEOUT_MS,
      })
      .json<{ data?: ChartinkResult[] }>();

    const results = resp?.data ?? [];

    // Store in cache
    await cacheSet(cacheKey, results, CACHE_TTL_SECONDS);

    return results;
  } catch (error) {
    console.warn(
      "[chartink] Scan failed:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * Pre-built Chartink scan queries for common technical patterns.
 */
export const CHARTINK_PREBUILT_SCANS: Record<string, string> = {
  golden_cross:
    "( {cash} ( latest sma( close,50 ) > latest sma( close,200 ) and 1 day ago sma( close,50 ) < 1 day ago sma( close,200 ) ) )",
  death_cross:
    "( {cash} ( latest sma( close,50 ) < latest sma( close,200 ) and 1 day ago sma( close,50 ) > 1 day ago sma( close,200 ) ) )",
  rsi_oversold: "( {cash} ( latest rsi( close,14 ) < 30 ) )",
  rsi_overbought: "( {cash} ( latest rsi( close,14 ) > 70 ) )",
  volume_breakout:
    "( {cash} ( latest volume > 2 * latest sma( volume,20 ) and latest close > latest sma( close,20 ) ) )",
  bullish_macd:
    "( {cash} ( latest macd( close,12,26,9 ) > latest macd signal( close,12,26,9 ) and 1 day ago macd( close,12,26,9 ) < 1 day ago macd signal( close,12,26,9 ) ) )",
  above_200dma: "( {cash} ( latest close > latest sma( close,200 ) ) )",
  near_52w_high:
    "( {cash} ( latest close > latest max( 250, close ) * 0.95 ) )",
  near_52w_low: "( {cash} ( latest close < latest min( 250, close ) * 1.05 ) )",
};
