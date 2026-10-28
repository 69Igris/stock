/**
 * Tax Loss Harvesting Analysis
 *
 * Identifies unrealized losses that could be realized to offset gains.
 * Includes GAAR (General Anti-Avoidance Rules) warning.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { TaxHarvestingResult } from "../types";

// Budget 2024 tax rates
const STCG_RATE = 0.2;
const LTCG_RATE = 0.125;

interface HoldingInput {
  symbol: string;
  currentValue: number;
  costBasis: number;
  buyDate: string;
}

function daysSince(date: string): number {
  return Math.floor(
    (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24),
  );
}

export const computeTaxHarvestingTool: ResearchToolDef = {
  name: "compute_tax_harvesting",
  description:
    "Identify tax loss harvesting opportunities from unrealized portfolio losses",
  category: "computation",
  parameters: {
    holdings: {
      type: "array",
      description: "Array of { symbol, currentValue, costBasis, buyDate }",
      required: true,
    },
    realizedGains: {
      type: "number",
      description: "Total realized gains in current FY (to estimate savings)",
      default: 0,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const holdings = params.holdings as HoldingInput[] | undefined;
    const realizedGains = (params.realizedGains as number) || 0;

    if (!holdings?.length) {
      return { success: false, error: "holdings array is required" };
    }

    try {
      const opportunities: TaxHarvestingResult["opportunities"] = [];

      for (const h of holdings) {
        const unrealizedLoss = h.currentValue - h.costBasis;
        if (unrealizedLoss >= 0) continue; // Only losses

        const holdingDays = daysSince(h.buyDate);
        const type = holdingDays <= 365 ? "STCG" : "LTCG";
        const taxRate = type === "STCG" ? STCG_RATE : LTCG_RATE;
        const potentialTaxSaving = Math.round(
          Math.abs(unrealizedLoss) * taxRate,
        );

        opportunities.push({
          symbol: h.symbol,
          currentValue: h.currentValue,
          costBasis: h.costBasis,
          unrealizedLoss: Math.round(unrealizedLoss),
          potentialTaxSaving,
          holdingDays,
          type,
        });
      }

      // Sort by potential saving descending
      opportunities.sort((a, b) => b.potentialTaxSaving - a.potentialTaxSaving);

      const totalPotentialSaving = opportunities.reduce(
        (sum, o) => sum + o.potentialTaxSaving,
        0,
      );

      const result: TaxHarvestingResult = {
        opportunities,
        totalPotentialSaving,
        gaarWarning:
          "Tax loss harvesting must be done with genuine intent to manage portfolio. Selling and immediately repurchasing the same stock solely for tax benefit may attract GAAR provisions under the Income Tax Act. Maintain a minimum 30-day gap before repurchasing the same security.",
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Tax harvesting analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
