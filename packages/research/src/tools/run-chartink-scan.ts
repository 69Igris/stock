/**
 * Run Chartink Technical Scan
 */

import {
  runChartinkScan,
  CHARTINK_PREBUILT_SCANS,
} from "../data-sources/chartink-client";
import type { ResearchToolDef, ToolOutput } from "./types";

export const runChartinkScanTool: ResearchToolDef = {
  name: "run_chartink_scan",
  description:
    "Run a technical analysis scan using Chartink (golden cross, RSI, MACD, volume breakout, etc.)",
  category: "data",
  parameters: {
    pattern: {
      type: "string",
      description:
        "Scan pattern name: golden_cross, death_cross, rsi_oversold, rsi_overbought, volume_breakout, bullish_macd, above_200dma, near_52w_high, near_52w_low",
      required: false,
    },
    query: {
      type: "string",
      description: "Custom Chartink scan query (advanced)",
      required: false,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const pattern = params.pattern as string | undefined;
    const customQuery = params.query as string | undefined;

    const scanQuery =
      customQuery || (pattern && CHARTINK_PREBUILT_SCANS[pattern]);
    if (!scanQuery) {
      return {
        success: false,
        error: `Invalid scan. Use a pattern name (${Object.keys(CHARTINK_PREBUILT_SCANS).join(", ")}) or provide a custom query.`,
      };
    }

    try {
      const results = await runChartinkScan(scanQuery);
      return {
        success: true,
        data: {
          pattern: pattern || "custom",
          count: results.length,
          stocks: results.slice(0, 50).map((r) => ({
            symbol: r.nsecode || r.bsecode,
            name: r.name,
            price: r.close,
            change: r.per_chg,
            volume: r.volume,
            exchange: r.nsecode ? "NSE" : "BSE",
          })),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Chartink scan failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
