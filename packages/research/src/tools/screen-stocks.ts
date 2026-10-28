/**
 * Stock Screener - Yahoo Finance data → Tickertape screener fallback
 */

import { yahooFetchQuotes } from "@usemoney/core/market-data";
import { screenStocksChain } from "../data-sources/data-source-chain";
import type { ResearchToolDef, ToolOutput } from "./types";

export const screenStocksTool: ResearchToolDef = {
  name: "screen_stocks",
  description:
    "Screen/filter stocks by fundamental criteria (PE, PB, market cap, etc.)",
  category: "computation",
  parameters: {
    symbols: {
      type: "string[]",
      description: "Array of Yahoo symbols to screen",
      required: true,
    },
    maxPE: { type: "number", description: "Maximum PE ratio" },
    minPE: { type: "number", description: "Minimum PE ratio" },
    maxMarketCap: { type: "number", description: "Maximum market cap" },
    minMarketCap: { type: "number", description: "Minimum market cap" },
    sortBy: {
      type: "string",
      description: "Sort field: pe, marketCap, price, changePercent",
      default: "marketCap",
    },
    sortOrder: {
      type: "string",
      description: "Sort order: asc, desc",
      default: "desc",
    },
    limit: { type: "number", description: "Max results", default: 20 },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbols = params.symbols as string[];
    if (!symbols?.length)
      return { success: false, error: "symbols array is required" };

    // Extract filter params up front so they're accessible in the catch block
    const maxPE = params.maxPE as number | undefined;
    const minPE = params.minPE as number | undefined;
    const maxMC = params.maxMarketCap as number | undefined;
    const minMC = params.minMarketCap as number | undefined;
    const limit = (params.limit as number) || 20;

    try {
      const quotesMap = await yahooFetchQuotes(symbols);
      let results = Array.from(quotesMap.values()).map((q) => ({
        symbol: q.symbol,
        name: q.shortName || q.longName,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        pe: q.trailingPE,
        marketCap: q.marketCap,
        fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: q.fiftyTwoWeekLow,
      }));

      // Apply filters
      if (maxPE != null)
        results = results.filter((r) => r.pe != null && r.pe <= maxPE);
      if (minPE != null)
        results = results.filter((r) => r.pe != null && r.pe >= minPE);
      if (maxMC != null)
        results = results.filter(
          (r) => r.marketCap != null && r.marketCap <= maxMC,
        );
      if (minMC != null)
        results = results.filter(
          (r) => r.marketCap != null && r.marketCap >= minMC,
        );

      // Sort
      const sortBy = (params.sortBy as string) || "marketCap";
      const sortOrder = (params.sortOrder as string) || "desc";
      results.sort((a, b) => {
        const aVal = ((a as Record<string, unknown>)[sortBy] as number) || 0;
        const bVal = ((b as Record<string, unknown>)[sortBy] as number) || 0;
        return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
      });

      results = results.slice(0, limit);

      return {
        success: true,
        data: results,
        metadata: {
          total: results.length,
          filters: { maxPE, minPE, maxMC, minMC },
        },
      };
    } catch (yahooError) {
      // Fallback: try Tickertape screener via data source chain
      try {
        // Convert to Tickertape filter format: { metric: { g: min, l: max } }
        const ttFilters: Record<string, { g?: number; l?: number }> = {};
        if (maxPE != null) ttFilters.pe = { ...ttFilters.pe, l: maxPE };
        if (minPE != null) ttFilters.pe = { ...ttFilters.pe, g: minPE };
        if (maxMC != null)
          ttFilters.mrktCapf = { ...ttFilters.mrktCapf, l: maxMC };
        if (minMC != null)
          ttFilters.mrktCapf = { ...ttFilters.mrktCapf, g: minMC };

        const chainResults = await screenStocksChain(ttFilters, limit);
        if (chainResults.length > 0) {
          return {
            success: true,
            data: chainResults,
            metadata: {
              source: "tickertape",
              fallback: true,
              total: chainResults.length,
            },
          };
        }
      } catch {
        // Chain also failed
      }

      return {
        success: false,
        error: `Screening failed: ${yahooError instanceof Error ? yahooError.message : String(yahooError)}`,
      };
    }
  },
};
