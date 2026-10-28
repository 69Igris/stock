/**
 * Search Stocks - Yahoo Search (existing yahooFetchSearch)
 */

import { yahooFetchSearch } from "@usemoney/core/market-data";
import type { ResearchToolDef, ToolOutput } from "./types";

export const searchStocksTool: ResearchToolDef = {
  name: "search_stocks",
  description: "Search for stocks by name or symbol using Yahoo Finance",
  category: "data",
  parameters: {
    query: {
      type: "string",
      description: "Search query (company name or symbol)",
      required: true,
    },
    limit: { type: "number", description: "Max results", default: 10 },
  },
  cacheTTL: 3600, // 1h
  execute: async (params): Promise<ToolOutput> => {
    const query = params.query as string;
    const limit = (params.limit as number) || 10;

    if (!query) return { success: false, error: "query is required" };

    try {
      const results = await yahooFetchSearch(query, { quotesCount: limit });
      return {
        success: true,
        data: results.map((r) => ({
          symbol: r.symbol,
          name: r.shortname || r.longname,
          exchange: r.exchange,
          type: r.quoteType,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to search: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
