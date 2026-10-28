/**
 * Fetch Promoter Pledging Data
 *
 * Retrieves promoter shareholding and pledging data from NSE.
 * High pledging (>20%) is a red flag for governance risk.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { getNseClient } from "../data-sources/nse-client";

export interface PromoterPledgingResult {
  symbol: string;
  promoterHolding: number; // percentage
  pledgedPercent: number; // % of promoter holding pledged
  pledgedOfTotal: number; // % of total shares pledged
  riskLevel: "low" | "moderate" | "high" | "critical";
  flags: string[];
}

export const fetchPromoterPledgingTool: ResearchToolDef = {
  name: "fetch_promoter_pledging",
  description:
    "Fetch promoter shareholding and pledging data - flags high pledging as governance risk",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "NSE symbol (e.g., RELIANCE)",
      required: true,
    },
  },
  cacheTTL: 86400, // 24h - changes quarterly
  execute: async (params): Promise<ToolOutput> => {
    const symbol = (params.symbol as string)
      .replace(/\.(NS|BO)$/i, "")
      .toUpperCase();

    if (!symbol) {
      return { success: false, error: "symbol is required" };
    }

    try {
      const nse = getNseClient();
      const rawShareholding = await nse.getShareholdingPattern(symbol);

      if (!rawShareholding) {
        return {
          success: false,
          error: `No shareholding data found for ${symbol}`,
        };
      }

      // Parse unknown response shape
      const shareholding = rawShareholding as Record<string, unknown>;
      const promoterHolding = Number(
        shareholding.promoterHolding ?? shareholding.promoterPercentage ?? 0,
      );
      const pledgedPercent = Number(
        shareholding.pledgedPercent ?? shareholding.pledgedPercentage ?? 0,
      );
      const pledgedOfTotal =
        promoterHolding > 0 ? (pledgedPercent * promoterHolding) / 100 : 0;

      const flags: string[] = [];
      let riskLevel: PromoterPledgingResult["riskLevel"] = "low";

      if (pledgedPercent > 50) {
        riskLevel = "critical";
        flags.push(
          `CRITICAL: ${pledgedPercent.toFixed(1)}% of promoter holding is pledged - very high governance risk`,
        );
      } else if (pledgedPercent > 30) {
        riskLevel = "high";
        flags.push(
          `HIGH RISK: ${pledgedPercent.toFixed(1)}% of promoter holding pledged - margin call risk if stock declines`,
        );
      } else if (pledgedPercent > 10) {
        riskLevel = "moderate";
        flags.push(
          `MODERATE: ${pledgedPercent.toFixed(1)}% of promoter holding pledged - monitor for increases`,
        );
      }

      if (promoterHolding < 25) {
        flags.push(
          `Low promoter holding (${promoterHolding.toFixed(1)}%) - limited promoter skin in the game`,
        );
      }

      const result: PromoterPledgingResult = {
        symbol,
        promoterHolding,
        pledgedPercent,
        pledgedOfTotal: Math.round(pledgedOfTotal * 100) / 100,
        riskLevel,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Promoter pledging fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
