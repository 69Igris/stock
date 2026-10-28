/**
 * Fetch Mutual Fund Peers - Tickertape MF API
 *
 * Retrieves peer funds in the same category for comparison.
 */

import { fetchTickertapeMfPeers } from "../data-sources/tickertape-mf-client";
import type { ResearchToolDef, ToolOutput } from "./types";

export const fetchMfPeersTool: ResearchToolDef = {
  name: "fetch_mf_peers",
  description:
    "Fetch peer mutual funds for comparison (same category, returns, AUM)",
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
      const data = await fetchTickertapeMfPeers(symbol);
      if (!data)
        return { success: false, error: `No peer data found for ${symbol}` };

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: `Failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
