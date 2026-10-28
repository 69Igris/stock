/**
 * Fetch Quarterly Results - Tickertape → Screener.in
 */

import { fetchQuarterlyResultsChain } from "../data-sources/data-source-chain";
import type { ResearchToolDef, ToolOutput } from "./types";

export const fetchQuarterlyResultsTool: ResearchToolDef = {
  name: "fetch_quarterly_results",
  description:
    "Fetch quarterly financial results (revenue, profit, EPS) for recent quarters",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Stock symbol (with or without .NS/.BO suffix)",
      required: true,
    },
  },
  cacheTTL: 21600, // 6h
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      const results = await fetchQuarterlyResultsChain(symbol);
      if (!results || results.length === 0) {
        return {
          success: false,
          error: `No quarterly results found for ${symbol}`,
        };
      }
      return { success: true, data: results };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch quarterly results: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
