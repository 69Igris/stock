/**
 * Cash Flow Quality Analysis
 *
 * CF/NI ratio, CapEx intensity, FCF yield, cash conversion.
 * Identifies potential earnings manipulation (Satyam-style red flags).
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { CashFlowQualityResult } from "../types";
import { insufficientInput } from "./insufficient-input";

export const computeCashFlowQualityTool: ResearchToolDef = {
  name: "compute_cash_flow_quality",
  description:
    "Analyze cash flow quality - CF/NI ratio, FCF yield, CapEx intensity, cash conversion",
  category: "computation",
  parameters: {
    operatingCashFlow: {
      type: "number",
      description: "Latest annual operating cash flow",
      required: true,
    },
    netIncome: {
      type: "number",
      description: "Latest annual net income",
      required: true,
    },
    capitalExpenditure: {
      type: "number",
      description: "Latest annual CapEx (positive number)",
    },
    revenue: { type: "number", description: "Latest annual revenue" },
    marketCap: { type: "number", description: "Current market capitalization" },
    freeCashFlow: { type: "number", description: "Latest annual FCF" },
    historicalOCF: {
      type: "array",
      description: "Array of historical operating CF values (oldest to newest)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const ocf = params.operatingCashFlow as number;
    const netIncome = params.netIncome as number;
    const capex = Math.abs((params.capitalExpenditure as number) || 0);
    const revenue = (params.revenue as number) || 0;
    const marketCap = (params.marketCap as number) || 0;
    const fcfParam = params.freeCashFlow as number | undefined;
    const historicalOCF = (params.historicalOCF as number[]) || [];

    if (ocf == null && netIncome == null) {
      return insufficientInput(
        "At least one of operatingCashFlow or netIncome is required",
      );
    }

    // If OCF is missing, estimate from net income (conservative proxy)
    const effectiveOcf = ocf ?? netIncome! * 1.1;
    const effectiveNetIncome = netIncome ?? effectiveOcf;

    try {
      const flags: string[] = [];

      // CF to Net Income ratio (>1 = quality)
      const cfToNetIncome =
        effectiveNetIncome !== 0
          ? Math.round((effectiveOcf / effectiveNetIncome) * 100) / 100
          : 0;
      const fcf = fcfParam ?? effectiveOcf - capex;

      if (cfToNetIncome < 0.8 && effectiveNetIncome > 0) {
        flags.push(
          `Operating CF is significantly lower than Net Income - potential earnings quality concern`,
        );
      }
      if (effectiveNetIncome > 0 && effectiveOcf < 0) {
        flags.push(
          "Negative operating cash flow despite positive earnings - major red flag for earnings manipulation",
        );
      }

      // CapEx intensity
      const capexIntensity =
        revenue > 0 ? Math.round((capex / revenue) * 10000) / 10000 : 0;
      if (capexIntensity > 0.15) {
        flags.push(
          `High CapEx intensity (${(capexIntensity * 100).toFixed(1)}% of revenue) - capital-intensive business`,
        );
      }

      // FCF yield
      const fcfYield =
        marketCap > 0 ? Math.round((fcf / marketCap) * 10000) / 10000 : 0;

      // Cash conversion (FCF / OCF)
      const cashConversion =
        effectiveOcf !== 0 ? Math.round((fcf / effectiveOcf) * 100) / 100 : 0;

      // Operating CF trend
      let operatingCFTrend: CashFlowQualityResult["operatingCFTrend"] =
        "stable";
      if (historicalOCF.length >= 3) {
        const recent = historicalOCF.slice(-3);
        const allIncreasing =
          recent[1]! > recent[0]! && recent[2]! > recent[1]!;
        const allDecreasing =
          recent[1]! < recent[0]! && recent[2]! < recent[1]!;
        if (allIncreasing) operatingCFTrend = "improving";
        else if (allDecreasing) {
          operatingCFTrend = "declining";
          flags.push("Operating cash flow declining over last 3 years");
        }
      }

      // Quality score (0-100)
      let qualityScore = 50;
      if (cfToNetIncome >= 1.2) qualityScore += 20;
      else if (cfToNetIncome >= 0.8) qualityScore += 10;
      else if (cfToNetIncome < 0.5) qualityScore -= 15;

      if (fcfYield > 0.05) qualityScore += 15;
      else if (fcfYield > 0.02) qualityScore += 5;
      else if (fcfYield < 0) qualityScore -= 10;

      if (cashConversion > 0.7) qualityScore += 10;
      if (operatingCFTrend === "improving") qualityScore += 5;
      else if (operatingCFTrend === "declining") qualityScore -= 10;

      qualityScore = Math.max(0, Math.min(100, qualityScore));

      const result: CashFlowQualityResult = {
        cfToNetIncome,
        capexIntensity,
        fcfYield,
        cashConversion,
        operatingCFTrend,
        qualityScore,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Cash flow quality analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
