/**
 * Fetch Screener.in Ratios - direct Screener.in data
 *
 * Extracts PE, ROCE, ROE, book value, dividend yield, shareholding
 * from Screener.in company page. Useful as primary data source for
 * BSE-only stocks where Yahoo/Tickertape may have limited data.
 */

import { fetchScreenerFinancials } from "../data-sources/screener-client";
import type { ResearchToolDef, ToolOutput } from "./types";

export const fetchScreenerRatiosTool: ResearchToolDef = {
  name: "fetch_screener_ratios",
  description:
    "Fetch key ratios and shareholding from Screener.in (PE, ROCE, ROE, promoter holding)",
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
      const data = await fetchScreenerFinancials(symbol);
      if (!data) {
        return {
          success: false,
          error: `No Screener.in data found for ${symbol}`,
        };
      }
      return {
        success: true,
        data: {
          companyName: data.companyName,
          marketCap: data.marketCap,
          currentPrice: data.currentPrice,
          pe: data.pe,
          bookValue: data.bookValue,
          dividendYield: data.dividendYield,
          roce: data.roce,
          roe: data.roe,
          promoterHolding: data.promoterHolding,
          fiiHolding: data.fiiHolding,
          diiHolding: data.diiHolding,
          publicHolding: data.publicHolding,
          annualRevenue: data.annualRevenue,
          annualProfit: data.annualProfit,
        },
        metadata: { source: "screener.in" },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch Screener.in ratios: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
