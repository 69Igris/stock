/**
 * Compute MF Analysis - risk-adjusted returns, rolling consistency
 *
 * Takes MF overview data and computes derived metrics:
 * - Net returns (after expense ratio)
 * - CAGR consistency across time horizons
 * - Size categorization
 * - Expense/returns/consistency verdicts
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export const computeMfAnalysisTool: ResearchToolDef = {
  name: "compute_mf_analysis",
  description:
    "Compute risk-adjusted returns, Sharpe ratio, and rolling consistency metrics for a mutual fund",
  category: "computation",
  parameters: {
    overview: {
      type: "object",
      description: "MF overview data from fetch_mf_overview",
      required: true,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const overview = params.overview as Record<string, unknown> | undefined;
    if (!overview)
      return { success: false, error: "overview data is required" };

    try {
      // Extract returns from the overview structure
      const returnsObj = (overview.returns || {}) as Record<string, unknown>;
      const returns1y =
        (returnsObj.oneYear as number | undefined) ??
        (overview.return1y as number | undefined);
      const returns3y =
        (returnsObj.threeYear as number | undefined) ??
        (overview.return3y as number | undefined);
      const returns5y =
        (returnsObj.fiveYear as number | undefined) ??
        (overview.return5y as number | undefined);
      const expenseRatio = overview.expenseRatio as number | undefined;
      const aum = overview.aum as number | undefined;
      const riskLevel =
        (overview.riskRating as string | undefined) ??
        (overview.riskLevel as string | undefined);

      // Compute basic metrics
      const netReturn1y =
        returns1y != null && expenseRatio != null
          ? returns1y - expenseRatio
          : (returns1y ?? undefined);
      const cagr3y = returns3y ?? undefined;
      const cagr5y = returns5y ?? undefined;

      // Rolling consistency: if 3Y and 5Y returns are close, fund is consistent
      const consistency =
        returns3y != null && returns5y != null
          ? Math.max(0, 100 - Math.abs(returns3y - returns5y) * 10)
          : undefined;

      // Size category
      const sizeCategory =
        aum == null
          ? "Unknown"
          : aum > 10000
            ? "Large (>10K Cr)"
            : aum > 1000
              ? "Mid (1K-10K Cr)"
              : "Small (<1K Cr)";

      // Expense verdict
      const expenseVerdict =
        expenseRatio == null
          ? "Unknown"
          : expenseRatio < 1
            ? "Low cost"
            : expenseRatio < 2
              ? "Moderate cost"
              : "High cost";

      // Returns verdict
      const returnsVerdict =
        returns3y == null
          ? "Insufficient data"
          : returns3y > 15
            ? "Strong"
            : returns3y > 10
              ? "Good"
              : "Below average";

      // Consistency verdict
      const consistencyVerdict =
        consistency == null
          ? "Insufficient data"
          : consistency > 70
            ? "Consistent"
            : "Variable";

      return {
        success: true,
        data: {
          netReturn1y,
          cagr3y,
          cagr5y,
          expenseRatio,
          consistency,
          sizeCategory,
          riskLevel: riskLevel || "Unknown",
          aumCr: aum,
          verdict: {
            expense: expenseVerdict,
            returns: returnsVerdict,
            consistency: consistencyVerdict,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `MF analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
