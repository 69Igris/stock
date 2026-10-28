/**
 * Fetch Analyst Recommendations - Yahoo quoteSummary (recommendationTrend)
 *
 * TODO: SEBI-compliance review — flag at fetch-analyst-recommendations.ts.
 *   This tool surfaces third-party (Yahoo / Refinitiv) analyst consensus —
 *   raw buy / hold / sell counts from external research desks. The data
 *   itself is observable market intelligence (not UseMoney's verdict), but
 *   re-publishing aggregated analyst recommendations may still fall under
 *   SEBI Research Analyst Regulations 2014 if framed as a recommendation
 *   to the user. Recommended treatment: keep the counts as raw consensus
 *   data and ensure every render site labels it explicitly ("Street view
 *   (per Refinitiv consensus): 5 strong-buy, 12 buy, 8 hold") with a
 *   third-party citation, and never let the synthesizer summarise it as
 *   "Street says BUY". Not auto-rewriting because the tool only surfaces
 *   data; framing happens at render time and needs human review of every
 *   call site.
 */

import { yahooFetchQuoteSummary } from "@usemoney/core/market-data";
import type { ResearchToolDef, ToolOutput } from "./types";
import type { AnalystRecommendation } from "../types";

export const fetchAnalystRecommendationsTool: ResearchToolDef = {
  name: "fetch_analyst_recommendations",
  description: "Fetch analyst buy/hold/sell recommendations",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Yahoo Finance symbol",
      required: true,
    },
  },
  cacheTTL: 21600, // 6h
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      const data = await yahooFetchQuoteSummary(symbol, [
        "recommendationTrend",
      ]);
      if (!data)
        return { success: false, error: `No data found for ${symbol}` };

      const trend = data.recommendationTrend as
        | Record<string, unknown>
        | undefined;
      const trendArr = trend?.trend as unknown[];

      const recommendations: AnalystRecommendation[] = [];
      if (Array.isArray(trendArr)) {
        for (const t of trendArr) {
          const rec = t as Record<string, unknown>;
          recommendations.push({
            period: (rec.period as string) || "",
            strongBuy: (rec.strongBuy as number) || 0,
            buy: (rec.buy as number) || 0,
            hold: (rec.hold as number) || 0,
            sell: (rec.sell as number) || 0,
            strongSell: (rec.strongSell as number) || 0,
          });
        }
      }

      return { success: true, data: recommendations };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch recommendations: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
