/**
 * Fetch Mutual Fund Holdings - Tickertape MF API
 *
 * Retrieves top holdings with allocation percentages and sector weights.
 */

import { fetchTickertapeMfHoldings } from "../data-sources/tickertape-mf-client";
import type { ResearchToolDef, ToolOutput } from "./types";

export const fetchMfHoldingsTool: ResearchToolDef = {
  name: "fetch_mf_holdings",
  description:
    "Fetch mutual fund top holdings with allocation percentages and sector weights",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Mutual fund scheme code or name",
      required: true,
    },
  },
  cacheTTL: 86400,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      const data = await fetchTickertapeMfHoldings(symbol);
      if (!data)
        return {
          success: false,
          error: `No holdings data found for ${symbol}`,
        };

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: `Failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
