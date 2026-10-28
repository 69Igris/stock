/**
 * Symbol Mapper — pure logic (MONEY-620).
 *
 * The dependency-free pieces of `symbol-mapper.ts`: the in-memory instrument
 * cache primitives (key builder + TTL-aware get/set with size-bounded eviction),
 * the Yahoo→display reverse map, and the symbol normalize/validate helpers.
 *
 * They live here so the unit tests assert the REAL exported symbols (no shadow)
 * WITHOUT importing `symbol-mapper.ts`, which imports `@usemoney/database` and
 * instantiates a `PrismaClient` at module load — importing that into the test
 * runner risks an open handle / orphaned process.
 *
 * `symbol-mapper.ts` CALLS every export here (passing its module-level cache
 * Map), so the production resolution path and the tests execute the same bytes.
 * This module imports nothing — importing it never opens a DB handle.
 *
 * @see apps/web/__tests__/market/symbol-mapper-cache.test.ts
 */

// ============== IN-MEMORY CACHE PRIMITIVES ==============

export interface CachedInstrument {
  yahooSymbol: string;
  name: string;
  timestamp: number;
}

/** Default in-memory cache TTL: 60 seconds. */
export const CACHE_TTL_MS = 60 * 1000;

/** Soft cap before a TTL sweep runs on insert. */
export const MAX_CACHE_ENTRIES = 10000;

/** Build the uppercase `SYMBOL::EXCHANGE` cache key (case-insensitive lookups). */
export function getCacheKey(symbol: string, exchange: string): string {
  return `${symbol.toUpperCase()}::${exchange.toUpperCase()}`;
}

/**
 * Read a cached instrument from `cache` if present and within `ttlMs`.
 * Expired entries are deleted (lazy eviction) and treated as a miss.
 */
export function getCachedInstrument(
  cache: Map<string, CachedInstrument>,
  symbol: string,
  exchange: string,
  ttlMs: number = CACHE_TTL_MS
): CachedInstrument | null {
  const key = getCacheKey(symbol, exchange);
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < ttlMs) {
    return entry;
  }
  if (entry) {
    cache.delete(key);
  }
  return null;
}

/**
 * Write an instrument into `cache` stamped at `Date.now()`. When the map grows
 * past `MAX_CACHE_ENTRIES`, sweep out every entry older than `CACHE_TTL_MS`.
 */
export function setCachedInstrument(
  cache: Map<string, CachedInstrument>,
  symbol: string,
  exchange: string,
  yahooSymbol: string,
  name: string
): void {
  const key = getCacheKey(symbol, exchange);
  cache.set(key, { yahooSymbol, name, timestamp: Date.now() });

  if (cache.size > MAX_CACHE_ENTRIES) {
    const now = Date.now();
    Array.from(cache.entries()).forEach(([k, v]) => {
      if (now - v.timestamp > CACHE_TTL_MS) {
        cache.delete(k);
      }
    });
  }
}

// ============== REVERSE MAP & VALIDATORS ==============

/** Reverse mapping from Yahoo index symbols to display names. */
export const YAHOO_TO_DISPLAY: Record<string, string> = {
  "^NSEI": "NIFTY 50",
  "^NSEBANK": "NIFTY BANK",
  "^BSESN": "SENSEX",
  "^CNXIT": "NIFTY IT",
  "^CNXMDCP": "NIFTY MIDCAP 100",
  "^NSMIDCP": "NIFTY NEXT 50",
  "^CNXPHARMA": "NIFTY PHARMA",
  "^CNXAUTO": "NIFTY AUTO",
  "^CNXFMCG": "NIFTY FMCG",
  "^CNXMETAL": "NIFTY METAL",
  "^INDIAVIX": "INDIA VIX",
};

/** Uppercase, trim, and collapse internal whitespace runs to a single space. */
export function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().trim().replace(/\s+/g, " ");
}

/**
 * Check a symbol's surface format: non-empty, and only alphanumerics, spaces
 * (for index names), hyphens, underscores, and ampersands. Rejects dots (Yahoo
 * suffixes) and carets (Yahoo index markers) — those are not internal symbols.
 */
export function isValidSymbol(symbol: string): boolean {
  if (!symbol || symbol.length < 1) return false;
  const validPattern = /^[A-Z0-9\s\-_&]+$/i;
  return validPattern.test(symbol);
}
