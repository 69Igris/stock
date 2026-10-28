"use client";

/**
 * useStockSearch Hook
 *
 * Search for stocks using the market API and get live quotes.
 */

import { useState, useEffect, useCallback, useRef } from "react";
// Pure helpers — SINGLE SOURCE OF TRUTH (no shadows). The hook CALLS these so
// tests assert the same code that runs in production.
import {
  buildSearchParams,
  buildPopularParams,
  extractSymbolsForQuotes,
  createDefaultPriceResult,
  mergeWithQuotes,
  shouldReportError,
} from "./useStockSearch-logic";

// ============== TYPES ==============

export interface StockSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  yahooSymbol: string;
}

export interface StockWithPrice extends StockSearchResult {
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  dayHigh: number;
  dayLow: number;
  sector?: string;
}

export interface UseStockSearchOptions {
  /** Include indices in results */
  includeIndices?: boolean;
  /** Maximum results to return */
  limit?: number;
  /** Debounce delay in ms */
  debounceMs?: number;
  /** Filter by instrument types (e.g. ["EQUITY", "ETF"]) */
  types?: string[];
}

export interface UseStockSearchResult {
  /** Search results with prices */
  results: StockWithPrice[];
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Search function */
  search: (query: string) => void;
  /** Current query */
  query: string;
}

// ============== RESULT LRU (MONEY-1123) ==============

/**
 * Module-scoped LRU for search results.
 *
 * Backspacing (`RELIAN` → `RELIA` → `RELI`) walks back over queries that were
 * just fetched, and every one of those re-ran `/api/market/search` +
 * `/api/market/quote`. Module scope (not a ref) so the cache survives component
 * remounts — the picker unmounts every time it closes.
 *
 * TTL is deliberately short: entries carry live prices, so a stale entry is a
 * stale quote in the dropdown.
 */
export const SEARCH_CACHE_CAP = 50;
export const SEARCH_CACHE_TTL_MS = 60_000;

interface SearchCacheEntry {
  results: StockWithPrice[];
  expiresAt: number;
}

const searchCache = new Map<string, SearchCacheEntry>();

/**
 * Cache key. Includes every input that changes the response: the normalized
 * query plus the request-shaping options.
 */
export function buildSearchCacheKey(
  query: string,
  limit: number,
  includeIndices: boolean,
  typesKey: string
): string {
  return `${query.trim().toLowerCase()}|${limit}|${includeIndices}|${typesKey}`;
}

/**
 * Read a live entry, refreshing its LRU recency. Returns null on a miss or an
 * expired entry (which is evicted). `now` is injectable so tests use a fake
 * clock instead of sleeping.
 */
export function readSearchCache(
  key: string,
  now: number = Date.now()
): StockWithPrice[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    searchCache.delete(key);
    return null;
  }
  // Re-insert to move to the most-recently-used end.
  searchCache.delete(key);
  searchCache.set(key, entry);
  return entry.results;
}

/** Write an entry, evicting the least-recently-used ones past the cap. */
export function writeSearchCache(
  key: string,
  results: StockWithPrice[],
  now: number = Date.now()
): void {
  searchCache.delete(key);
  searchCache.set(key, { results, expiresAt: now + SEARCH_CACHE_TTL_MS });
  while (searchCache.size > SEARCH_CACHE_CAP) {
    const oldest = searchCache.keys().next();
    if (oldest.done) break;
    searchCache.delete(oldest.value);
  }
}

/** Test seam — drops every entry. */
export function clearSearchCache(): void {
  searchCache.clear();
}

// ============== HOOK ==============

export function useStockSearch(
  options: UseStockSearchOptions = {}
): UseStockSearchResult {
  const {
    includeIndices = false,
    limit = 20,
    debounceMs = 300,
    types,
  } = options;

  // Stable string key for types array - prevents infinite re-render loop
  // (array literals like ["EQUITY"] create a new reference every render)
  const typesKey = types?.join(",") ?? "";

  const [results, setResults] = useState<StockWithPrice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchSearchResults = useCallback(
    async (searchQuery: string) => {
      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      if (!searchQuery.trim()) {
        // Fetch popular stocks when no query
        try {
          setIsLoading(true);
          setError(null);

          abortControllerRef.current = new AbortController();

          const params = new URLSearchParams(
            buildPopularParams(limit, includeIndices)
          );
          if (types?.length) params.set("types", types.join(","));

          const response = await fetch(`/api/market/search?${params}`, {
            signal: abortControllerRef.current.signal,
          });

          if (!response.ok) {
            throw new Error("Failed to fetch popular stocks");
          }

          const data = await response.json();

          if (data.success && data.results) {
            // Fetch quotes for the results
            const symbols = extractSymbolsForQuotes(
              data.results as StockSearchResult[]
            );

            const quotesWithPrices = await fetchQuotesForSymbols(
              symbols,
              data.results
            );
            setResults(quotesWithPrices);
          }
        } catch (err) {
          if (shouldReportError(err)) {
            setError((err as Error).message);
          }
        } finally {
          setIsLoading(false);
        }
        return;
      }

      // MONEY-1123: a repeat of a recent query (backspacing, or re-opening the
      // picker) is served from memory - no /search + /quote round trip.
      const cacheKey = buildSearchCacheKey(
        searchQuery,
        limit,
        includeIndices,
        typesKey
      );
      const cachedResults = readSearchCache(cacheKey);
      if (cachedResults) {
        setResults(cachedResults);
        setError(null);
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);

        abortControllerRef.current = new AbortController();

        const params = new URLSearchParams(
          buildSearchParams(searchQuery, limit, includeIndices)
        );
        if (types?.length) params.set("types", types.join(","));

        const response = await fetch(`/api/market/search?${params}`, {
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error("Search failed");
        }

        const data = await response.json();

        if (data.success && data.results) {
          // Fetch quotes for the results
          const symbols = extractSymbolsForQuotes(
            data.results as StockSearchResult[]
          );

          const quotesWithPrices = await fetchQuotesForSymbols(
            symbols,
            data.results
          );
          setResults(quotesWithPrices);
          writeSearchCache(cacheKey, quotesWithPrices);
        }
      } catch (err) {
        if (shouldReportError(err)) {
          setError((err as Error).message);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [limit, includeIndices, typesKey]
  );

  const search = useCallback(
    (searchQuery: string) => {
      setQuery(searchQuery);

      // Clear previous debounce
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      // Debounce the search
      debounceRef.current = setTimeout(() => {
        fetchSearchResults(searchQuery);
      }, debounceMs);
    },
    [fetchSearchResults, debounceMs]
  );

  // Fetch initial popular stocks
  useEffect(() => {
    fetchSearchResults("");
  }, [fetchSearchResults]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    results,
    isLoading,
    error,
    search,
    query,
  };
}

// ============== HELPER FUNCTIONS ==============

async function fetchQuotesForSymbols(
  symbols: string[],
  searchResults: StockSearchResult[]
): Promise<StockWithPrice[]> {
  if (symbols.length === 0) {
    return searchResults.map(createDefaultPriceResult);
  }

  try {
    const params = new URLSearchParams({
      symbols: symbols.join(","),
      exchange: "NSE",
    });

    const response = await fetch(`/api/market/quote?${params}`);

    if (!response.ok) {
      throw new Error("Failed to fetch quotes");
    }

    const data = await response.json();

    if (data.success && data.data) {
      return mergeWithQuotes(searchResults, data.data);
    }
  } catch (error) {
    console.error("Failed to fetch quotes:", error);
  }

  // Return with zero prices on error
  return searchResults.map(createDefaultPriceResult);
}

export default useStockSearch;
