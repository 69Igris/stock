/**
 * Dividend Discount Model (DDM) - Gordon Growth & 2-Stage DDM
 *
 * Computes intrinsic value from dividend projections using:
 * 1. Single-stage (Gordon Growth): D1 / (ke - g)
 * 2. Two-stage: high growth for N years, then terminal stable growth
 * Includes sensitivity matrix varying growth and cost of equity.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

interface SensitivityCell {
  growthRate: number;
  costOfEquity: number;
  intrinsicValue: number;
}

interface DdmStageResult {
  intrinsicValue: number;
  dividendYieldImplied: number;
  assumptions: {
    currentDividend: number;
    growthRate: number;
    costOfEquity: number;
  };
}

interface TwoStageDdmResult {
  intrinsicValue: number;
  highGrowthPV: number;
  terminalPV: number;
  projections: Array<{
    year: number;
    dividend: number;
    discountedDividend: number;
    phase: "high_growth" | "stable";
  }>;
  assumptions: {
    currentDividend: number;
    highGrowthRate: number;
    terminalGrowthRate: number;
    costOfEquity: number;
    highGrowthYears: number;
  };
}

interface DdmResult {
  singleStage: DdmStageResult | null;
  twoStage: TwoStageDdmResult;
  sensitivityMatrix: SensitivityCell[];
  currentPrice: number | null;
  upside: number | null;
  marginOfSafety: number | null;
  verdict: "undervalued" | "fairly_valued" | "overvalued" | "not_applicable";
  flags: string[];
}

export const computeDdmTool: ResearchToolDef = {
  name: "compute_ddm",
  description:
    "Dividend Discount Model - Gordon Growth (single-stage) and 2-stage DDM with sensitivity analysis",
  category: "computation",
  parameters: {
    current_dividend: {
      type: "number",
      description: "Current annual dividend per share (D0)",
      required: true,
    },
    growth_rate: {
      type: "number",
      description:
        "Expected dividend growth rate during high-growth phase (decimal, e.g., 0.12 for 12%)",
      required: true,
    },
    cost_of_equity: {
      type: "number",
      description:
        "Cost of equity / required return (decimal, e.g., 0.12 for 12%)",
      required: true,
    },
    terminal_growth: {
      type: "number",
      description: "Terminal / stable growth rate (decimal)",
      default: 0.05,
    },
    high_growth_years: {
      type: "number",
      description: "Number of years of high growth before terminal phase",
      default: 5,
    },
    current_price: {
      type: "number",
      description:
        "Current stock price (for upside/margin of safety calculation)",
    },
  },
  cacheTTL: 1800,
  execute: async (params): Promise<ToolOutput> => {
    const currentDividend = params.current_dividend as number;
    const growthRate = params.growth_rate as number;
    const costOfEquity = params.cost_of_equity as number;
    const terminalGrowth = (params.terminal_growth as number) ?? 0.05;
    const highGrowthYears = (params.high_growth_years as number) ?? 5;
    const currentPrice = (params.current_price as number) || null;

    if (currentDividend == null || currentDividend < 0) {
      return {
        success: false,
        error: "current_dividend must be a non-negative number",
      };
    }

    if (costOfEquity == null || costOfEquity <= 0) {
      return {
        success: false,
        error: "cost_of_equity must be a positive number",
      };
    }

    if (growthRate == null) {
      return { success: false, error: "growth_rate is required" };
    }

    try {
      const flags: string[] = [];

      // Validate growth < cost of equity for single stage
      let singleStage: DdmStageResult | null = null;

      if (costOfEquity > growthRate && currentDividend > 0) {
        const d1 = currentDividend * (1 + growthRate);
        const intrinsicValue =
          Math.round((d1 / (costOfEquity - growthRate)) * 100) / 100;
        const dividendYieldImplied =
          Math.round((d1 / intrinsicValue) * 10000) / 10000;

        singleStage = {
          intrinsicValue,
          dividendYieldImplied,
          assumptions: {
            currentDividend,
            growthRate,
            costOfEquity,
          },
        };
      } else if (currentDividend > 0) {
        flags.push(
          "Single-stage DDM not applicable: growth rate >= cost of equity (use two-stage model)",
        );
      }

      // Two-stage DDM
      if (costOfEquity <= terminalGrowth) {
        return {
          success: false,
          error: `Cost of equity (${costOfEquity}) must be greater than terminal growth rate (${terminalGrowth})`,
        };
      }

      const projections: TwoStageDdmResult["projections"] = [];
      let highGrowthPV = 0;

      // Phase 1: High growth
      for (let i = 1; i <= highGrowthYears; i++) {
        const dividend = currentDividend * Math.pow(1 + growthRate, i);
        const discountFactor = Math.pow(1 + costOfEquity, i);
        const discountedDividend = dividend / discountFactor;
        highGrowthPV += discountedDividend;

        projections.push({
          year: i,
          dividend: Math.round(dividend * 100) / 100,
          discountedDividend: Math.round(discountedDividend * 100) / 100,
          phase: "high_growth",
        });
      }

      // Phase 2: Terminal value (Gordon Growth on terminal dividend)
      const terminalDividend =
        currentDividend *
        Math.pow(1 + growthRate, highGrowthYears) *
        (1 + terminalGrowth);
      const terminalValue = terminalDividend / (costOfEquity - terminalGrowth);
      const terminalPV =
        terminalValue / Math.pow(1 + costOfEquity, highGrowthYears);

      // Add a couple of terminal phase projections for illustration
      for (let i = 1; i <= 3; i++) {
        const year = highGrowthYears + i;
        const dividend =
          currentDividend *
          Math.pow(1 + growthRate, highGrowthYears) *
          Math.pow(1 + terminalGrowth, i);
        const discountFactor = Math.pow(1 + costOfEquity, year);
        const discountedDividend = dividend / discountFactor;

        projections.push({
          year,
          dividend: Math.round(dividend * 100) / 100,
          discountedDividend: Math.round(discountedDividend * 100) / 100,
          phase: "stable",
        });
      }

      const twoStageValue = Math.round((highGrowthPV + terminalPV) * 100) / 100;

      const twoStage: TwoStageDdmResult = {
        intrinsicValue: twoStageValue,
        highGrowthPV: Math.round(highGrowthPV * 100) / 100,
        terminalPV: Math.round(terminalPV * 100) / 100,
        projections,
        assumptions: {
          currentDividend,
          highGrowthRate: growthRate,
          terminalGrowthRate: terminalGrowth,
          costOfEquity,
          highGrowthYears,
        },
      };

      // Sensitivity matrix: vary growth ±2% and cost of equity ±2%
      const sensitivityMatrix: SensitivityCell[] = [];
      const growthSteps = [-0.02, -0.01, 0, 0.01, 0.02];
      const keSteps = [-0.02, -0.01, 0, 0.01, 0.02];

      for (const gDelta of growthSteps) {
        for (const kDelta of keSteps) {
          const g = growthRate + gDelta;
          const ke = costOfEquity + kDelta;

          if (ke <= terminalGrowth || ke <= 0) continue;

          // Two-stage calculation for this scenario
          let pvHigh = 0;
          for (let i = 1; i <= highGrowthYears; i++) {
            const div = currentDividend * Math.pow(1 + g, i);
            pvHigh += div / Math.pow(1 + ke, i);
          }
          const tDiv =
            currentDividend *
            Math.pow(1 + g, highGrowthYears) *
            (1 + terminalGrowth);
          const tVal = tDiv / (ke - terminalGrowth);
          const pvTerminal = tVal / Math.pow(1 + ke, highGrowthYears);

          sensitivityMatrix.push({
            growthRate: Math.round(g * 10000) / 10000,
            costOfEquity: Math.round(ke * 10000) / 10000,
            intrinsicValue: Math.round((pvHigh + pvTerminal) * 100) / 100,
          });
        }
      }

      // Compute upside/margin if current price given
      let upside: number | null = null;
      let marginOfSafety: number | null = null;
      let verdict: DdmResult["verdict"] = "not_applicable";

      if (currentPrice && currentPrice > 0 && twoStageValue > 0) {
        upside =
          Math.round(((twoStageValue - currentPrice) / currentPrice) * 10000) /
          100;
        marginOfSafety =
          Math.round(((twoStageValue - currentPrice) / twoStageValue) * 10000) /
          100;

        if (upside > 30) verdict = "undervalued";
        else if (upside > -15) verdict = "fairly_valued";
        else verdict = "overvalued";
      }

      // Flags
      if (currentDividend === 0) {
        flags.push(
          "Company does not pay dividends - DDM may not be the best valuation method",
        );
      }

      const terminalPercent =
        twoStageValue > 0 ? Math.round((terminalPV / twoStageValue) * 100) : 0;
      if (terminalPercent > 80) {
        flags.push(
          `Terminal value accounts for ${terminalPercent}% of total value - highly sensitive to terminal growth assumptions`,
        );
      }

      if (growthRate > 0.25) {
        flags.push(
          `High growth rate assumption (${(growthRate * 100).toFixed(1)}%) - may be unsustainable`,
        );
      }

      if (
        verdict === "undervalued" &&
        marginOfSafety != null &&
        marginOfSafety > 40
      ) {
        flags.push(
          "Significant margin of safety - verify dividend is sustainable before acting",
        );
      }

      const result: DdmResult = {
        singleStage,
        twoStage,
        sensitivityMatrix,
        currentPrice,
        upside,
        marginOfSafety,
        verdict,
        flags,
      };

      return {
        success: true,
        data: result,
        metadata: {
          method: "DDM",
          twoStageValue,
          singleStageValue: singleStage?.intrinsicValue ?? null,
          terminalPercent,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `DDM computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
