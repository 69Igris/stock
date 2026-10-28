/**
 * Shareholding Pattern Fetcher
 *
 * Gets promoter, FII, DII, public shareholding from NSE
 * with quarter-over-quarter trend analysis.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { ShareholdingResult } from "../types";
import { getNseClient } from "../data-sources/nse-client";
import { toNseSymbol } from "../data-sources/symbol-resolver";

interface ShareholdingData {
  date?: string;
  promoterAndPromoterGroup?: number;
  publicShareholding?: number;
  fiiDii?: {
    fii?: number;
    dii?: number;
  };
  // Alternative structure from NSE
  promotersPer?: number;
  fiisPer?: number;
  diisPer?: number;
  publicPer?: number;
  pledgedPer?: number;
}

export const fetchShareholdingPatternTool: ResearchToolDef = {
  name: "fetch_shareholding_pattern",
  description:
    "Fetch shareholding pattern from NSE - promoter, FII, DII, public with trend analysis",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Stock symbol (NSE format, e.g., RELIANCE or RELIANCE.NS)",
      required: true,
    },
  },
  cacheTTL: 86400, // 24 hours - shareholding data is quarterly
  execute: async (params): Promise<ToolOutput> => {
    const rawSymbol = params.symbol as string;
    if (!rawSymbol) {
      return { success: false, error: "symbol is required" };
    }

    const symbol = toNseSymbol(rawSymbol);

    try {
      const nseClient = getNseClient();
      const data = await nseClient.getShareholdingPattern(symbol);

      if (!data) {
        return {
          success: false,
          error: `No shareholding data found for ${symbol}`,
        };
      }

      // NSE returns an array of quarterly data
      const rawData = data as ShareholdingData[] | Record<string, unknown>;
      const quarters: ShareholdingResult["quarters"] = [];

      // Parse NSE response - handle different formats
      const dataArray = Array.isArray(rawData)
        ? rawData
        : (rawData as Record<string, unknown>).data
          ? ((rawData as Record<string, unknown>).data as ShareholdingData[])
          : [];

      if (!dataArray.length) {
        return {
          success: false,
          error: `Shareholding data not available from NSE for ${symbol}`,
        };
      }

      for (const item of dataArray.slice(0, 8)) {
        const promoter =
          item.promotersPer ?? item.promoterAndPromoterGroup ?? 0;
        const fii = item.fiisPer ?? item.fiiDii?.fii ?? 0;
        const dii = item.diisPer ?? item.fiiDii?.dii ?? 0;
        const pub = item.publicPer ?? item.publicShareholding ?? 0;

        quarters.push({
          quarter: item.date || "Unknown",
          promoter,
          fii,
          dii,
          public: pub,
        });
      }

      const current = quarters[0] || {
        promoter: 0,
        fii: 0,
        dii: 0,
        public: 0,
      };
      const previous = quarters[1] || current;
      const pledgedPercent =
        (dataArray[0] as ShareholdingData)?.pledgedPer || 0;

      const signals: string[] = [];

      // Trend signals
      if (current.fii > previous.fii) {
        signals.push(
          `FII increasing stake (+${(current.fii - previous.fii).toFixed(1)}%) - institutional conviction`,
        );
      } else if (current.fii < previous.fii) {
        signals.push(
          `FII reducing stake (${(current.fii - previous.fii).toFixed(1)}%) - watch for trend`,
        );
      }

      if (current.promoter < previous.promoter - 1) {
        signals.push(
          `Promoter stake declining (${(current.promoter - previous.promoter).toFixed(1)}%) - needs investigation`,
        );
      }

      if (pledgedPercent > 20) {
        signals.push(
          `High promoter pledge (${pledgedPercent.toFixed(1)}%) - significant risk`,
        );
      } else if (pledgedPercent > 10) {
        signals.push(
          `Moderate promoter pledge (${pledgedPercent.toFixed(1)}%) - monitor closely`,
        );
      }

      if (current.dii > previous.dii) {
        signals.push("DII increasing stake - domestic institutional support");
      }

      const result: ShareholdingResult = {
        promoter: {
          current: current.promoter,
          previous: previous.promoter,
          change:
            Math.round((current.promoter - previous.promoter) * 100) / 100,
        },
        fii: {
          current: current.fii,
          previous: previous.fii,
          change: Math.round((current.fii - previous.fii) * 100) / 100,
        },
        dii: {
          current: current.dii,
          previous: previous.dii,
          change: Math.round((current.dii - previous.dii) * 100) / 100,
        },
        public: {
          current: current.public,
          previous: previous.public,
          change: Math.round((current.public - previous.public) * 100) / 100,
        },
        pledgedPercent,
        quarters: quarters.slice(0, 4),
        signals,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Shareholding data fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
