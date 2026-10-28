/**
 * Advanced Stock Screener Tool
 *
 * Uses Tickertape.in's screener API with 150+ filter dimensions:
 * Price/Volume, Profitability, Growth, Valuation, Ownership, Technicals, F&O
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  screenStocksTickertape,
  type ScreenerFilter,
} from "../data-sources/tickertape-client";

export const screenStocksAdvancedTool: ResearchToolDef = {
  name: "screen_stocks_advanced",
  description:
    "Advanced stock screener with 150+ filters via Tickertape - market cap, PE, ROE, ROCE, debt-to-equity, revenue growth, dividend yield, and more",
  category: "data",
  parameters: {
    filters: {
      type: "object",
      description:
        'Filter object. Keys are metric codes, values have g (greater than) and/or l (less than). Example: { "mrktCapf": { "g": 100000 }, "roe": { "g": 15 }, "pe": { "l": 25 } }',
      required: true,
    },
    limit: {
      type: "number",
      description: "Max results to return (default: 50)",
    },
  },
  cacheTTL: 3600, // 1h
  execute: async (params): Promise<ToolOutput> => {
    const filters = params.filters as ScreenerFilter;
    const limit = (params.limit as number) || 50;

    if (!filters || typeof filters !== "object") {
      return { success: false, error: "filters object is required" };
    }

    try {
      const results = await screenStocksTickertape(filters, limit);

      if (results.length === 0) {
        return {
          success: true,
          data: [],
          metadata: {
            source: "tickertape.in",
            message: "No stocks matched the given filters",
          },
        };
      }

      return {
        success: true,
        data: results,
        metadata: {
          source: "tickertape.in",
          matchCount: results.length,
          filters,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Screener query failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
