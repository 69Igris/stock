/**
 * Portfolio Concentration Analysis
 *
 * Computes HHI (Herfindahl-Hirschman Index), sector grouping,
 * and flags single-stock concentration >20%.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { ConcentrationResult } from "../types";

export const computePortfolioConcentrationTool: ResearchToolDef = {
  name: "compute_portfolio_concentration",
  description:
    "Analyze portfolio concentration via HHI index and sector weights",
  category: "computation",
  parameters: {
    holdings: {
      type: "array",
      description:
        "Array of { symbol, value, sector? } representing current holdings",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const holdings = params.holdings as
      | Array<{ symbol: string; value: number; sector?: string }>
      | undefined;

    if (!holdings?.length) {
      return { success: false, error: "holdings array is required" };
    }

    try {
      const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);
      if (totalValue <= 0) {
        return { success: false, error: "Total portfolio value must be > 0" };
      }

      // Compute weights and HHI
      const weighted = holdings
        .map((h) => ({
          symbol: h.symbol,
          weight: h.value / totalValue,
          value: h.value,
          sector: h.sector || "Unknown",
        }))
        .sort((a, b) => b.weight - a.weight);

      const hhi = Math.round(
        weighted.reduce((sum, h) => sum + Math.pow(h.weight * 100, 2), 0),
      );

      // Sector grouping
      const sectorMap = new Map<string, { weight: number; count: number }>();
      for (const h of weighted) {
        const existing = sectorMap.get(h.sector) || {
          weight: 0,
          count: 0,
        };
        existing.weight += h.weight;
        existing.count += 1;
        sectorMap.set(h.sector, existing);
      }

      const sectorWeights = Array.from(sectorMap.entries())
        .map(([sector, data]) => ({
          sector,
          weight: Math.round(data.weight * 10000) / 10000,
          count: data.count,
        }))
        .sort((a, b) => b.weight - a.weight);

      // Warnings
      const warnings: string[] = [];
      for (const h of weighted) {
        if (h.weight > 0.2) {
          warnings.push(
            `${h.symbol} is ${(h.weight * 100).toFixed(1)}% of portfolio (>20%)`,
          );
        }
      }
      for (const s of sectorWeights) {
        if (s.weight > 0.4) {
          warnings.push(
            `${s.sector} sector is ${(s.weight * 100).toFixed(1)}% of portfolio (>40%)`,
          );
        }
      }

      const level: ConcentrationResult["level"] =
        hhi < 1500 ? "low" : hhi < 2500 ? "moderate" : "high";

      const result: ConcentrationResult = {
        hhi,
        level,
        topHoldings: weighted.slice(0, 10).map((h) => ({
          symbol: h.symbol,
          weight: Math.round(h.weight * 10000) / 10000,
          value: h.value,
        })),
        sectorWeights,
        warnings,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Concentration analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
