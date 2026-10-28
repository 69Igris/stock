/**
 * Growth Metrics Calculator
 *
 * Computes revenue/profit CAGR, growth consistency, and margin trends.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { GrowthMetrics, FinancialStatement } from "../types";
import { insufficientInput } from "./insufficient-input";

function computeCAGR(
  startValue: number,
  endValue: number,
  years: number,
): number {
  if (startValue <= 0 || endValue <= 0 || years <= 0) return 0;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

function assessMarginTrend(
  margins: number[],
): "improving" | "stable" | "declining" {
  if (margins.length < 2) return "stable";

  let improving = 0;
  let declining = 0;
  for (let i = 1; i < margins.length; i++) {
    const diff = margins[i]! - margins[i - 1]!;
    if (diff > 0.005) improving++;
    else if (diff < -0.005) declining++;
  }

  if (improving > declining) return "improving";
  if (declining > improving) return "declining";
  return "stable";
}

function computeConsistency(values: number[]): number {
  if (values.length < 2) return 1;
  let positive = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! > values[i - 1]!) positive++;
  }
  return positive / (values.length - 1);
}

export const computeGrowthMetricsTool: ResearchToolDef = {
  name: "compute_growth_metrics",
  description:
    "Calculate revenue/profit CAGR, growth consistency, and margin trends from financial statements",
  category: "computation",
  parameters: {
    statements: {
      type: "object[]",
      description:
        "Array of annual financial statements (oldest first) with revenue, netIncome, operatingMargin fields",
      required: true,
    },
    eps: {
      type: "number[]",
      description: "Array of annual EPS values (oldest first)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const statements = params.statements as FinancialStatement[];
    if (!statements?.length || statements.length < 2) {
      // MONEY-1274 (#30) — thin INPUT, not a failed computation. Returning
      // success:false here marked the task FAILED and the report read as
      // "the analysis engine broke" when the real cause was an empty
      // upstream fetch. See insufficient-input.ts.
      return insufficientInput("At least 2 annual statements are required", {
        needed: "2 annual statements",
        got: statements?.length ?? 0,
      });
    }

    try {
      const years = statements.length - 1;
      const revenues = statements
        .map((s) => s.revenue)
        .filter((v): v is number => v != null);
      const profits = statements
        .map((s) => s.netIncome)
        .filter((v): v is number => v != null);
      const margins = statements
        .map((s) =>
          s.revenue && s.operatingIncome
            ? s.operatingIncome / s.revenue
            : undefined,
        )
        .filter((v): v is number => v != null);

      const revenueCAGR =
        revenues.length >= 2
          ? computeCAGR(revenues[0]!, revenues[revenues.length - 1]!, years)
          : 0;

      const profitCAGR =
        profits.length >= 2
          ? computeCAGR(
              Math.abs(profits[0]!),
              Math.abs(profits[profits.length - 1]!),
              years,
            )
          : 0;

      const epsArr = params.eps as number[] | undefined;
      const epsCAGR =
        epsArr && epsArr.length >= 2
          ? computeCAGR(
              Math.abs(epsArr[0]!),
              Math.abs(epsArr[epsArr.length - 1]!),
              epsArr.length - 1,
            )
          : 0;

      const result: GrowthMetrics = {
        revenueCAGR: Math.round(revenueCAGR * 10000) / 10000,
        profitCAGR: Math.round(profitCAGR * 10000) / 10000,
        epsCAGR: Math.round(epsCAGR * 10000) / 10000,
        marginTrend: assessMarginTrend(margins),
        growthConsistency: Math.round(computeConsistency(revenues) * 100) / 100,
        details: statements.map((s) => ({
          period: s.period,
          revenue: s.revenue,
          netIncome: s.netIncome,
          operatingMargin:
            s.revenue && s.operatingIncome
              ? Math.round((s.operatingIncome / s.revenue) * 10000) / 10000
              : undefined,
        })),
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Growth metrics failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
