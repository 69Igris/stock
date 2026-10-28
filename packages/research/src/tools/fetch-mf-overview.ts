/**
 * Fetch Mutual Fund Overview.
 *
 * Retrieves name, category, NAV, and trailing returns for a mutual fund scheme.
 *
 * MONEY-1073: Tickertape's public MF API no longer returns open-ended MFs (see
 * mfapi-mf-client for the investigation), so for a numeric AMFI scheme code we
 * resolve via MFAPI.in first and only fall back to Tickertape for non-numeric
 * identifiers (ETF tickers / names). Without this, fund research completed with
 * "Data Unavailable" because every upstream MF fetch returned null.
 */

import { fetchTickertapeMfOverview } from "../data-sources/tickertape-mf-client";
import { fetchMfApiOverview } from "../data-sources/mfapi-mf-client";
import type { ResearchToolDef, ToolOutput } from "./types";

export const fetchMfOverviewTool: ResearchToolDef = {
  name: "fetch_mf_overview",
  description:
    "Fetch mutual fund overview including NAV, AUM, expense ratio, returns, risk metrics",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Mutual fund scheme code or name",
      required: true,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      // MFAPI.in for a numeric AMFI scheme code (the chat @mention case);
      // Tickertape only as a fallback for non-numeric ids (ETF tickers / names).
      const data =
        (await fetchMfApiOverview(symbol)) ??
        (await fetchTickertapeMfOverview(symbol));
      if (!data)
        return { success: false, error: `No MF data found for ${symbol}` };

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: `Failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
