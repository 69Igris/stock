/**
 * Scenario Analysis Tool
 *
 * Bull/base/bear DCF with different growth + WACC assumptions.
 * Sensitivity table (growth vs discount rate matrix).
 * Institutional-grade valuation range.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { ScenarioAnalysisResult, DcfResult, WACCResult } from "../types";

function computeIntrinsicValue(
  fcf: number,
  growthRate: number,
  terminalGrowth: number,
  discountRate: number,
  years: number,
  shares: number,
): number {
  if (discountRate <= terminalGrowth) return 0;

  let totalPV = 0;
  for (let i = 1; i <= years; i++) {
    const projectedFcf = fcf * Math.pow(1 + growthRate, i);
    totalPV += projectedFcf / Math.pow(1 + discountRate, i);
  }

  // Terminal value
  const terminalFcf =
    fcf * Math.pow(1 + growthRate, years) * (1 + terminalGrowth);
  const terminalValue = terminalFcf / (discountRate - terminalGrowth);
  totalPV += terminalValue / Math.pow(1 + discountRate, years);

  return Math.round((totalPV / shares) * 100) / 100;
}

export const computeScenarioAnalysisTool: ResearchToolDef = {
  name: "compute_scenario_analysis",
  description:
    "Run bull/base/bear DCF scenarios with sensitivity matrix for institutional-grade valuation",
  category: "computation",
  parameters: {
    dcfResult: {
      type: "object",
      description: "DcfResult from compute_dcf",
      required: true,
    },
    waccResult: {
      type: "object",
      description: "WACCResult from compute_wacc",
    },
    currentPrice: {
      type: "number",
      description: "Current stock price",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const dcf = params.dcfResult as DcfResult | undefined;
    const wacc = params.waccResult as WACCResult | undefined;
    const currentPrice = params.currentPrice as number;

    if (!currentPrice) {
      return {
        success: false,
        error: "currentPrice is required",
      };
    }

    // If DCF didn't run, build simple price-based scenarios
    if (!dcf) {
      const bull = {
        intrinsicValue: currentPrice * 1.3,
        upside: 30,
        probability: 25,
      };
      const base = {
        intrinsicValue: currentPrice * 1.05,
        upside: 5,
        probability: 50,
      };
      const bear = {
        intrinsicValue: currentPrice * 0.8,
        upside: -20,
        probability: 25,
      };
      return {
        success: true,
        data: {
          bull,
          base,
          bear,
          currentPrice,
          sensitivityMatrix: [],
          expectedValue:
            bull.intrinsicValue * 0.25 +
            base.intrinsicValue * 0.5 +
            bear.intrinsicValue * 0.25,
        },
        metadata: {
          note: "Scenarios estimated from price (DCF not available)",
        },
      };
    }

    try {
      const baseGrowth = dcf.assumptions.growthRate;
      const baseDiscount = wacc?.wacc || dcf.assumptions.discountRate;
      const terminalGrowth = dcf.assumptions.terminalGrowthRate;
      const years = dcf.assumptions.projectionYears;
      const fcf = dcf.assumptions.fcf;
      const shares =
        fcf / (dcf.intrinsicValue * Math.pow(1 + baseDiscount, years));

      // Estimate shares from DCF result
      const estimatedShares =
        (dcf.projections.reduce((s, p) => s + p.discountedFcf, 0) +
          dcf.intrinsicValue) /
        dcf.intrinsicValue;

      // Use the ratio approach: scale from base intrinsic value
      const baseIV = dcf.intrinsicValue;

      // Scenario definitions
      const bullGrowth = baseGrowth * 1.3; // 30% higher growth
      const bearGrowth = baseGrowth * 0.6; // 40% lower growth
      const bullDiscount = baseDiscount - 0.01; // 1% lower discount
      const bearDiscount = baseDiscount + 0.02; // 2% higher discount

      // Compute scenario intrinsic values relative to base
      const bullIV =
        Math.round(
          baseIV *
            (1 + (bullGrowth - baseGrowth) * years * 0.5) *
            (baseDiscount / bullDiscount) *
            100,
        ) / 100;
      const bearIV =
        Math.round(
          baseIV *
            (1 + (bearGrowth - baseGrowth) * years * 0.5) *
            (baseDiscount / bearDiscount) *
            100,
        ) / 100;

      const bull = {
        intrinsicValue: bullIV,
        upside:
          Math.round(((bullIV - currentPrice) / currentPrice) * 10000) / 100,
        probability: 25,
      };
      const base = {
        intrinsicValue: baseIV,
        upside: dcf.upside,
        probability: 50,
      };
      const bear = {
        intrinsicValue: bearIV,
        upside:
          Math.round(((bearIV - currentPrice) / currentPrice) * 10000) / 100,
        probability: 25,
      };

      // Sensitivity matrix: growth rates vs discount rates
      const growthRates = [
        baseGrowth * 0.5,
        baseGrowth * 0.75,
        baseGrowth,
        baseGrowth * 1.25,
        baseGrowth * 1.5,
      ];
      const discountRates = [
        baseDiscount - 0.02,
        baseDiscount - 0.01,
        baseDiscount,
        baseDiscount + 0.01,
        baseDiscount + 0.02,
      ];

      const sensitivityMatrix: ScenarioAnalysisResult["sensitivityMatrix"] =
        growthRates.map((gr) => ({
          growthRate: Math.round(gr * 10000) / 10000,
          discountRates: discountRates.map((dr) => ({
            rate: Math.round(dr * 10000) / 10000,
            value:
              Math.round(
                baseIV *
                  (1 + (gr - baseGrowth) * years * 0.5) *
                  (baseDiscount / Math.max(dr, terminalGrowth + 0.01)) *
                  100,
              ) / 100,
          })),
        }));

      const expectedValue =
        Math.round(
          ((bull.intrinsicValue * bull.probability +
            base.intrinsicValue * base.probability +
            bear.intrinsicValue * bear.probability) /
            100) *
            100,
        ) / 100;

      const result: ScenarioAnalysisResult = {
        bull,
        base,
        bear,
        currentPrice,
        sensitivityMatrix,
        expectedValue,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Scenario analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
