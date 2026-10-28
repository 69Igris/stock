/**
 * Earnings Quality Analysis
 *
 * Accruals ratio, recurring vs non-recurring income,
 * tax rate consistency, revenue quality assessment.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { EarningsQualityResult } from "../types";

export const computeEarningsQualityTool: ResearchToolDef = {
  name: "compute_earnings_quality",
  description:
    "Assess earnings quality - accruals ratio, recurring %, tax consistency, revenue quality",
  category: "computation",
  parameters: {
    netIncome: {
      type: "number",
      description: "Latest annual net income",
      required: true,
    },
    operatingCashFlow: {
      type: "number",
      description: "Latest annual operating cash flow",
      required: true,
    },
    totalAssets: {
      type: "number",
      description: "Total assets",
      required: true,
    },
    operatingIncome: {
      type: "number",
      description: "Operating income (recurring proxy)",
    },
    revenue: { type: "number", description: "Total revenue" },
    historicalTaxRates: {
      type: "array",
      description: "Array of effective tax rates over recent years",
    },
    revenueGrowth: {
      type: "number",
      description: "Revenue growth rate (decimal)",
    },
    receivablesGrowth: {
      type: "number",
      description: "Receivables growth rate (decimal)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const netIncome = params.netIncome as number;
    const ocf = params.operatingCashFlow as number;
    const totalAssets = params.totalAssets as number;
    const operatingIncome = (params.operatingIncome as number) || 0;
    const revenue = (params.revenue as number) || 0;
    const historicalTaxRates = (params.historicalTaxRates as number[]) || [];
    const revenueGrowth = (params.revenueGrowth as number) || 0;
    const receivablesGrowth = (params.receivablesGrowth as number) || 0;

    if (netIncome == null) {
      return {
        success: false,
        error: "netIncome is required for earnings quality analysis",
      };
    }

    // Use defaults for missing optional data instead of hard-failing
    const effectiveOcf = ocf ?? netIncome;
    const effectiveAssets = totalAssets || 1; // Avoid division by zero

    try {
      const flags: string[] = [];

      // Accruals ratio: (NI - OCF) / Total Assets
      // Lower is better - high accruals suggest earnings manipulation
      const accrualRatio =
        Math.round(((netIncome - effectiveOcf) / effectiveAssets) * 10000) /
        10000;

      if (accrualRatio > 0.1) {
        flags.push(
          `High accruals ratio (${(accrualRatio * 100).toFixed(1)}%) - earnings may not be backed by cash`,
        );
      }

      // Recurring vs non-recurring
      const recurringPercent =
        netIncome !== 0 && operatingIncome !== 0
          ? Math.round(Math.min(1, Math.abs(operatingIncome / netIncome)) * 100)
          : 50;

      if (recurringPercent < 70) {
        flags.push(
          `Only ${recurringPercent}% of earnings from recurring operations - reliance on one-time items`,
        );
      }

      // Tax rate consistency
      let taxRateConsistency = 0;
      if (historicalTaxRates.length >= 3) {
        const mean =
          historicalTaxRates.reduce((s, r) => s + r, 0) /
          historicalTaxRates.length;
        const variance =
          historicalTaxRates.reduce((s, r) => s + Math.pow(r - mean, 2), 0) /
          historicalTaxRates.length;
        taxRateConsistency = Math.round(Math.sqrt(variance) * 10000) / 10000;

        if (taxRateConsistency > 0.05) {
          flags.push(
            "Inconsistent effective tax rates - may indicate aggressive tax planning or unusual items",
          );
        }
      }

      // Revenue quality
      let revenueQuality: EarningsQualityResult["revenueQuality"] = "moderate";
      if (receivablesGrowth > 0 && revenueGrowth > 0) {
        if (receivablesGrowth > revenueGrowth * 1.5) {
          revenueQuality = "low";
          flags.push(
            "Receivables growing faster than revenue - potential channel stuffing or collection issues",
          );
        } else if (receivablesGrowth <= revenueGrowth) {
          revenueQuality = "high";
        }
      } else if (revenueGrowth > 0.1) {
        revenueQuality = "high";
      }

      // Quality score (0-100)
      let qualityScore = 50;
      if (accrualRatio < 0.05) qualityScore += 15;
      else if (accrualRatio > 0.1) qualityScore -= 15;

      if (recurringPercent >= 90) qualityScore += 15;
      else if (recurringPercent >= 70) qualityScore += 5;
      else qualityScore -= 10;

      if (taxRateConsistency < 0.03) qualityScore += 10;
      else if (taxRateConsistency > 0.05) qualityScore -= 10;

      if (revenueQuality === "high") qualityScore += 10;
      else if (revenueQuality === "low") qualityScore -= 15;

      qualityScore = Math.max(0, Math.min(100, qualityScore));

      const result: EarningsQualityResult = {
        accrualRatio,
        recurringPercent,
        taxRateConsistency,
        revenueQuality,
        qualityScore,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Earnings quality analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
