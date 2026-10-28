/**
 * Sparkline Service
 *
 * Cached wrapper around @usemoney/core's fetchSparklines() for use by:
 * - apps/web API route /api/market/sparkline
 * - apps/web server actions
 * - workers/ sparkline-sync processor (pre-compute)
 *
 * Cache shape: single entry per (symbol, exchange, window) - 1D has a short TTL
 * (bars move intraday), 1W/1M have long TTLs (daily bars don't change).
 */

import {
  fetchSparklines,
  sparklineCacheKey,
  type SparklineResult,
  type SparklineSymbol,
  type SparklineWindow,
} from "@usemoney/core";
// Subpath, NOT the root barrel — see the note in holdings.service.ts: the
// service tests stub the ROOT `@usemoney/core` with a catch-all Proxy, which
// would answer these with no-ops. These three are pure/in-process (an LRU-backed
// client handle, a string builder and a config lookup).
import {
  cacheClient,
  generateCacheKey,
  getCacheConfig,
} from "@usemoney/core/cache";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import { sanitizeCloses } from "./sparkline-logic";

/**
 * Strip any non-finite bar from a result's `closes` before it leaves the
 * service. The upstream `fetchSparkline` already filters Yahoo bars, but a
 * corrupt cache write or a worker-precomputed series can still carry a
 * `NaN`/`Infinity` — and the list-view renderer's `Math.min(...closes)` /
 * `Math.max(...closes)` scaling blanks the whole sparkline from a single such
 * bar (see ./sparkline-logic.ts). Sanitising here makes the LIVE path run the
 * same guarded normalisation the regression tests assert.
 */
function sanitizeResult(result: SparklineResult): SparklineResult {
  const closes = sanitizeCloses(result.closes);
  return closes.length === result.closes.length
    ? result
    : { ...result, closes };
}

/** Sparkline TTL by window. 1D gets a short TTL because intraday bars tick. */
const TTL_SECONDS_BY_WINDOW: Record<SparklineWindow, number> = {
  "1D": 10 * 60, // 10 min
  "1W": 60 * 60, // 1 hour
  "1M": 6 * 60 * 60, // 6 hours
};

export interface GetSparklinesOptions {
  /** Bypass cache and re-fetch. Useful for worker pre-compute passes. */
  forceRefresh?: boolean;
}

/** Cache namespace + scope this service has always used. Do NOT change. */
const CACHE_MODULE = "market" as const;
const CACHE_SCOPE = "_global";

/**
 * The exact key `getCached("market", "_global", sparklineCacheKey(...))` used to
 * derive internally — `generateCacheKey` is the same function that pair called,
 * given the same arguments (no `filters`, so the version segment stays
 * "default"). Keeping this byte-identical is what lets entries written by the
 * currently deployed build stay readable after MONEY-705 deploys.
 */
function sparklineKey(
  symbol: string,
  exchange: "NSE" | "BSE",
  window: SparklineWindow,
): string {
  return generateCacheKey(
    CACHE_MODULE,
    CACHE_SCOPE,
    sparklineCacheKey(symbol, exchange, window),
  );
}

/**
 * Test seam for the upstream fetch (mirrors `__setRedisFactoryForTests` /
 * `__setCacheClockForTests` in @usemoney/core). `fetchSparklines` talks to
 * Yahoo, so without this the batching behaviour of {@link getSparklines} — how
 * many Redis round trips it makes, and which symbols it re-fetches on a partial
 * hit — could only be asserted on the all-cached path. Production NEVER calls
 * this; the default is the real fetcher.
 */
type SparklineFetcher = typeof fetchSparklines;
let sparklineFetcher: SparklineFetcher = fetchSparklines;

/** Override the upstream fetcher. Pass `null` to restore the real one. */
export function __setSparklineFetcherForTests(
  fn: SparklineFetcher | null,
): void {
  sparklineFetcher = fn ?? fetchSparklines;
}

/**
 * Returns a map keyed by `${symbol}|${exchange}` → close-price array.
 * Never throws; missing symbols map to empty arrays so the caller can
 * still render a muted placeholder.
 */
export async function getSparklines(
  symbols: SparklineSymbol[],
  window: SparklineWindow,
  options: GetSparklinesOptions = {},
): Promise<ServiceResult<Record<string, SparklineResult>>> {
  if (symbols.length === 0) {
    return { success: true, data: {} };
  }

  if (symbols.length > 100) {
    return {
      success: false,
      error: "Too many symbols in sparkline request (max 100)",
      code: "BATCH_TOO_LARGE",
    };
  }

  const ttl = TTL_SECONDS_BY_WINDOW[window];
  // Same config object `getCached`/`setCached` built from ("market" defaults
  // with the per-window TTL override) — unchanged TTL, unchanged layer enables.
  const cacheConfig = getCacheConfig(CACHE_MODULE, { ttl });
  const missing: SparklineSymbol[] = [];
  const out: Record<string, SparklineResult> = {};

  // MONEY-705: ONE `MGET` for the whole batch, not one `GET` per symbol. This
  // path used to issue up to 100 individual Redis reads inside a Promise.all
  // (and then up to 100 individual writes) for a single request — up to 200
  // round trips where 2 will do. Per-symbol miss handling is unchanged: every
  // slot is evaluated on its own and anything empty/corrupt falls into
  // `missing` exactly as before.
  if (!options.forceRefresh) {
    const keys = symbols.map(({ symbol, exchange }) =>
      sparklineKey(symbol, exchange, window),
    );

    let cachedRows: Array<SparklineResult | null> = [];
    try {
      cachedRows = await cacheClient.getMany<SparklineResult>(
        keys,
        cacheConfig,
      );
    } catch (error) {
      // Fail-open: a cache failure must degrade to "compute", never throw.
      logger.warn(
        { error, symbolCount: symbols.length, window },
        "Sparkline cache batch read failed - treating all as misses",
      );
      cachedRows = [];
    }

    symbols.forEach(({ symbol, exchange }, i) => {
      const cached = cachedRows[i];
      if (cached && sanitizeCloses(cached.closes).length > 0) {
        // A corrupt cache write could carry NaN/Infinity bars; strip them so
        // the renderer's min/max scaling never blanks the chart.
        out[`${symbol}|${exchange}`] = sanitizeResult(cached);
      } else {
        missing.push({ symbol, exchange });
      }
    });
  } else {
    missing.push(...symbols);
  }

  if (missing.length === 0) {
    return { success: true, data: out };
  }

  // Fetch missing from Yahoo
  try {
    const fetched = await sparklineFetcher(missing, window);
    const writes: Array<{ key: string; data: SparklineResult }> = [];
    for (const rawResult of Array.from(fetched.values())) {
      const result = sanitizeResult(rawResult);
      out[`${result.symbol}|${result.exchange}`] = result;
      if (result.closes.length > 0) {
        writes.push({
          key: sparklineKey(
            result.symbol,
            result.exchange as "NSE" | "BSE",
            window,
          ),
          data: result,
        });
      }
    }

    if (writes.length > 0) {
      // One pipelined flush. Its own try/catch so a write failure is never
      // mislabelled as a Yahoo fetch failure — the data is already in `out`.
      try {
        await cacheClient.setMany(writes, cacheConfig);
      } catch (error) {
        logger.warn(
          { error, symbolCount: writes.length, window },
          "Sparkline cache batch write failed (non-fatal)",
        );
      }
    }

    return { success: true, data: out };
  } catch (error) {
    logger.error(
      { error, symbolCount: missing.length, window },
      "Sparkline service fetch failed",
    );
    // Partial success: return whatever we have from cache
    return { success: true, data: out };
  }
}
