/**
 * Compute Portfolio Delta
 *
 * Compares current portfolio value against a cached/historical snapshot
 * to determine changes since last visit. Used by login briefing.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface PortfolioDeltaResult {
  currentValue: number;
  previousValue: number;
  absoluteChange: number;
  percentChange: number;
  topGainers: Array<{ symbol: string; change: number; changePercent: number }>;
  topLosers: Array<{ symbol: string; change: number; changePercent: number }>;
  newPositions: string[];
  closedPositions: string[];
}

export const computePortfolioDeltaTool: ResearchToolDef = {
  name: "compute_portfolio_delta",
  description:
    "Compute portfolio value change between current holdings and a previous snapshot",
  category: "computation",
  parameters: {
    currentHoldings: {
      type: "array",
      description: "Array of { symbol, currentValue, previousValue } objects",
      required: true,
    },
    previousTotalValue: {
      type: "number",
      description: "Previous portfolio total value",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const holdings = params.currentHoldings as Array<{
      symbol: string;
      currentValue: number;
      previousValue?: number;
    }>;

    if (!holdings || !Array.isArray(holdings)) {
      return { success: false, error: "currentHoldings array is required" };
    }

    try {
      const currentValue = holdings.reduce(
        (sum, h) => sum + (h.currentValue || 0),
        0,
      );
      const previousValue =
        (params.previousTotalValue as number) ||
        holdings.reduce(
          (sum, h) => sum + (h.previousValue || h.currentValue),
          0,
        );

      const absoluteChange = currentValue - previousValue;
      const percentChange =
        previousValue > 0 ? (absoluteChange / previousValue) * 100 : 0;

      // Find movers
      const withChange = holdings
        .filter((h) => h.previousValue != null && h.previousValue > 0)
        .map((h) => ({
          symbol: h.symbol,
          change: h.currentValue - (h.previousValue || 0),
          changePercent:
            h.previousValue && h.previousValue > 0
              ? ((h.currentValue - h.previousValue) / h.previousValue) * 100
              : 0,
        }));

      const topGainers = withChange
        .filter((h) => h.changePercent > 0)
        .sort((a, b) => b.changePercent - a.changePercent)
        .slice(0, 5);

      const topLosers = withChange
        .filter((h) => h.changePercent < 0)
        .sort((a, b) => a.changePercent - b.changePercent)
        .slice(0, 5);

      // Detect new and closed positions
      const newPositions = holdings
        .filter((h) => !h.previousValue || h.previousValue === 0)
        .map((h) => h.symbol);

      const result: PortfolioDeltaResult = {
        currentValue: Math.round(currentValue),
        previousValue: Math.round(previousValue),
        absoluteChange: Math.round(absoluteChange),
        percentChange: Math.round(percentChange * 100) / 100,
        topGainers,
        topLosers,
        newPositions,
        closedPositions: [], // Would need previous snapshot to detect
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Portfolio delta computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
