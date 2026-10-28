/**
 * Pure helpers for the useStockSearch hook (no React).
 *
 * The hook CALLS these so the URL-param building, the index-filter for quote
 * fetching, the quote/result merge and the default-price fallback are defined
 * once. Previously they were inlined in the hook and re-implemented inside
 * `__tests__/hooks/use-stock-search.test.ts` (a shadow).
 */

import type { StockSearchResult, StockWithPrice } from "./useStockSearch";

/** Resolved option defaults. Mirrors the hook's `= ` destructuring defaults. */
export function resolveStockSearchOptions(
  options: {
    includeIndices?: boolean;
    limit?: number;
    debounceMs?: number;
  } = {}
): { includeIndices: boolean; limit: number; debounceMs: number } {
  return {
    includeIndices: options.includeIndices ?? false,
    limit: options.limit ?? 20,
    debounceMs: options.debounceMs ?? 300,
  };
}

/** True when a query is blank (whitespace-only) → triggers popular-stocks path. */
export function isQueryEmpty(query: string): boolean {
  return !query.trim();
}

/** URL params for a non-empty search query. */
export function buildSearchParams(
  query: string,
  limit: number,
  includeIndices: boolean
): Record<string, string> {
  return {
    q: query,
    limit: limit.toString(),
    includeIndices: includeIndices.toString(),
  };
}

/** URL params for the popular-stocks (empty query) path. */
export function buildPopularParams(
  limit: number,
  includeIndices: boolean
): Record<string, string> {
  return {
    limit: limit.toString(),
    includeIndices: includeIndices.toString(),
  };
}

/** Non-INDEX symbols to fetch quotes for, capped at `maxSymbols`. */
export function extractSymbolsForQuotes(
  results: StockSearchResult[],
  maxSymbols = 20
): string[] {
  return results
    .filter((r) => r.type !== "INDEX")
    .map((r) => r.symbol)
    .slice(0, maxSymbols);
}

/** A result with all prices zeroed (the no-quote fallback). */
export function createDefaultPriceResult(
  result: StockSearchResult
): StockWithPrice {
  return {
    ...result,
    price: 0,
    change: 0,
    changePercent: 0,
    volume: 0,
    dayHigh: 0,
    dayLow: 0,
  };
}

interface QuoteData {
  price?: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  high?: number;
  low?: number;
}

/** Merge search results with a symbol→quote map (0 defaults for gaps). */
export function mergeWithQuotes(
  searchResults: StockSearchResult[],
  quoteMap: Record<string, QuoteData>
): StockWithPrice[] {
  return searchResults.map((result) => {
    const quote = quoteMap[result.symbol];
    return {
      ...result,
      price: quote?.price || 0,
      change: quote?.change || 0,
      changePercent: quote?.changePercent || 0,
      volume: quote?.volume || 0,
      dayHigh: quote?.high || 0,
      dayLow: quote?.low || 0,
    };
  });
}

/** Report an error only when it's a non-AbortError Error (the hook's guard). */
export function shouldReportError(err: unknown): boolean {
  return err instanceof Error && err.name !== "AbortError";
}
