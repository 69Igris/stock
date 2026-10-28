/**
 * Fetch Global Fund Data - Yahoo Finance for international funds
 *
 * Retrieves NAV, returns, expense ratio, holdings, and performance
 * for global/international funds and ETFs (e.g., VFIAX, SPY, VOO).
 */

import { yahooFetchQuoteSummary } from "@usemoney/core/market-data";
import type { ResearchToolDef, ToolOutput } from "./types";

export const fetchGlobalFundTool: ResearchToolDef = {
  name: "fetch_global_fund",
  description:
    "Fetch global/international fund data including NAV, returns, expense ratio, and holdings",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Yahoo Finance fund symbol (e.g., VFIAX, SPY, VOO)",
      required: true,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      const data = await yahooFetchQuoteSummary(symbol, [
        "price",
        "defaultKeyStatistics",
        "fundProfile",
        "topHoldings",
        "fundPerformance",
      ]);

      if (!data)
        return { success: false, error: `No data found for ${symbol}` };

      const price = data.price as Record<string, unknown> | undefined;
      const stats = data.defaultKeyStatistics as
        | Record<string, unknown>
        | undefined;
      const profile = data.fundProfile as Record<string, unknown> | undefined;
      const holdings = data.topHoldings as Record<string, unknown> | undefined;
      const performance = data.fundPerformance as
        | Record<string, unknown>
        | undefined;

      const extractRaw = (obj: unknown): number | undefined => {
        if (typeof obj === "number") return obj;
        if (typeof obj === "object" && obj !== null && "raw" in obj) {
          return (obj as Record<string, unknown>).raw as number;
        }
        return undefined;
      };

      return {
        success: true,
        data: {
          symbol,
          name:
            (price?.longName as string) ||
            (price?.shortName as string) ||
            symbol,
          currency: (price?.currency as string) || "USD",
          nav: extractRaw(price?.regularMarketPrice),
          change: extractRaw(price?.regularMarketChange),
          changePercent: extractRaw(price?.regularMarketChangePercent),
          expenseRatio: extractRaw(stats?.annualReportExpenseRatio),
          totalAssets: extractRaw(stats?.totalAssets),
          yield: extractRaw(stats?.yield),
          beta: extractRaw(stats?.beta3Year),
          category: (profile?.categoryName as string) || undefined,
          family: (profile?.family as string) || undefined,
          topHoldings: Array.isArray(holdings?.holdings)
            ? (holdings!.holdings as Array<Record<string, unknown>>)
                .slice(0, 10)
                .map((h) => ({
                  symbol: h.symbol as string,
                  name: h.holdingName as string,
                  percent: extractRaw(h.holdingPercent),
                }))
            : [],
          sectorWeightings: holdings?.sectorWeightings || [],
          performanceOverview: performance?.performanceOverview || {},
          trailingReturns: performance?.trailingReturns || {},
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
