/**
 * Earnings Estimates & EPS Analysis
 *
 * Computes beat/miss ratio, average surprise, EPS momentum,
 * stability (coefficient of variation), and forward EPS extrapolation
 * via linear regression on recent quarters.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { insufficientInput } from "./insufficient-input";

interface ActualEPS {
  quarter: string;
  eps: number;
}

interface EstimateEPS {
  quarter: string;
  estimated_eps: number;
}

interface SurpriseEntry {
  quarter: string;
  actual: number;
  estimated: number;
  surprise: number;
  surprisePercent: number;
  beat: boolean;
}

interface EarningsEstimatesResult {
  beatRatio: number | null;
  avgSurprise: number | null;
  avgSurprisePercent: number | null;
  epsMomentum: "accelerating" | "decelerating" | "stable" | "volatile";
  epsStability: number;
  coefficientOfVariation: number;
  forwardEstimate: {
    nextQuarterEPS: number;
    nextYearEPS: number;
    growthRate: number;
    confidence: "high" | "medium" | "low";
    r_squared: number;
  };
  trend: "improving" | "declining" | "flat";
  surprises: SurpriseEntry[];
  quarterlyEPS: Array<{
    quarter: string;
    eps: number;
    qoqGrowth: number | null;
  }>;
  flags: string[];
}

function linearRegression(y: number[]): {
  slope: number;
  intercept: number;
  rSquared: number;
} {
  const n = y.length;
  if (n < 3) return { slope: 0, intercept: y[0] || 0, rSquared: 0 };

  // x = 0, 1, 2, ..., n-1
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += y[i]!;
    sumXY += i * y[i]!;
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, rSquared: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R-squared
  const meanY = sumY / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssRes += (y[i]! - predicted) ** 2;
    ssTot += (y[i]! - meanY) ** 2;
  }
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return {
    slope: Math.round(slope * 10000) / 10000,
    intercept: Math.round(intercept * 10000) / 10000,
    rSquared: Math.round(Math.max(0, Math.min(1, rSquared)) * 10000) / 10000,
  };
}

export const computeEarningsEstimatesTool: ResearchToolDef = {
  name: "compute_earnings_estimates",
  description:
    "Analyze EPS estimates - beat/miss ratio, surprise trend, EPS momentum, stability, forward extrapolation via linear regression",
  category: "computation",
  parameters: {
    actual_eps: {
      type: "array",
      description:
        "Array of { quarter: string, eps: number } for actual EPS, ordered chronologically (oldest first)",
      required: true,
    },
    estimates: {
      type: "array",
      description:
        "Array of { quarter: string, estimated_eps: number } for consensus estimates (optional - if not provided, only momentum/stability analysis is performed)",
    },
  },
  cacheTTL: 1800,
  execute: async (params): Promise<ToolOutput> => {
    const actualEps = params.actual_eps as ActualEPS[] | undefined;
    const estimates = params.estimates as EstimateEPS[] | undefined;

    if (!actualEps || !Array.isArray(actualEps)) {
      return { success: false, error: "actual_eps array is required" };
    }
    if (actualEps.length === 0) {
      return insufficientInput(
        "actual_eps array with at least 1 entry is required",
        { needed: "1 entry", got: 0 },
      );
    }

    try {
      const flags: string[] = [];

      // Build quarterly EPS with Q-o-Q growth
      const quarterlyEPS: Array<{
        quarter: string;
        eps: number;
        qoqGrowth: number | null;
      }> = actualEps.map((a, i) => ({
        quarter: a.quarter,
        eps: a.eps,
        qoqGrowth:
          i > 0 && actualEps[i - 1]!.eps !== 0
            ? Math.round(
                ((a.eps - actualEps[i - 1]!.eps) /
                  Math.abs(actualEps[i - 1]!.eps)) *
                  10000,
              ) / 100
            : null,
      }));

      // EPS Momentum (direction of Q-o-Q growth changes)
      const growths = quarterlyEPS
        .map((q) => q.qoqGrowth)
        .filter((g): g is number => g != null);

      let epsMomentum: EarningsEstimatesResult["epsMomentum"] = "stable";
      if (growths.length >= 3) {
        const recentGrowths = growths.slice(-3);
        const allPositive = recentGrowths.every((g) => g > 0);
        const allNegative = recentGrowths.every((g) => g < 0);
        const increasing =
          recentGrowths.length >= 2 &&
          recentGrowths.every((g, i) => i === 0 || g >= recentGrowths[i - 1]!);
        const decreasing =
          recentGrowths.length >= 2 &&
          recentGrowths.every((g, i) => i === 0 || g <= recentGrowths[i - 1]!);

        if (allPositive && increasing) {
          epsMomentum = "accelerating";
        } else if (allNegative || decreasing) {
          epsMomentum = "decelerating";
        } else {
          // Check variance
          const mean =
            recentGrowths.reduce((a, b) => a + b, 0) / recentGrowths.length;
          const variance =
            recentGrowths.reduce((sum, g) => sum + (g - mean) ** 2, 0) /
            recentGrowths.length;
          if (Math.sqrt(variance) > 30) {
            epsMomentum = "volatile";
          } else {
            epsMomentum = "stable";
          }
        }
      }

      // EPS Stability - coefficient of variation
      const epsValues = actualEps.map((a) => a.eps);
      const mean =
        epsValues.length > 0
          ? epsValues.reduce((a, b) => a + b, 0) / epsValues.length
          : 0;
      const variance =
        epsValues.length > 1
          ? epsValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
            (epsValues.length - 1)
          : 0;
      const stdDev = Math.sqrt(variance);
      const coefficientOfVariation =
        mean !== 0 ? Math.round((stdDev / Math.abs(mean)) * 10000) / 10000 : 0;

      // Stability score: 100 = perfectly stable, 0 = highly volatile
      const epsStability = Math.round(
        Math.max(
          0,
          Math.min(100, 100 * (1 - Math.min(1, coefficientOfVariation))),
        ),
      );

      // Forward EPS extrapolation via linear regression on last 8 quarters
      const recentEps = epsValues.slice(-8);
      const regression = linearRegression(recentEps);
      const n = recentEps.length;
      const nextQuarterEPS =
        Math.round((regression.intercept + regression.slope * n) * 100) / 100;
      const nextYearEPS =
        Math.round(
          (regression.intercept + regression.slope * (n + 3)) * 4 * 100,
        ) / 100; // annualized from quarterly

      // Actually compute next 4 quarters sum for yearly estimate
      let nextYearSum = 0;
      for (let i = 0; i < 4; i++) {
        nextYearSum += regression.intercept + regression.slope * (n + i);
      }
      const nextYearEPSAnnual = Math.round(nextYearSum * 100) / 100;

      const growthRate =
        mean !== 0
          ? Math.round((regression.slope / Math.abs(mean)) * 10000) / 100
          : 0;

      let confidence: "high" | "medium" | "low" = "medium";
      if (regression.rSquared >= 0.7 && n >= 6) {
        confidence = "high";
      } else if (regression.rSquared < 0.3 || n < 4) {
        confidence = "low";
      }

      // Trend detection
      let trend: EarningsEstimatesResult["trend"] = "flat";
      if (regression.slope > 0 && regression.rSquared > 0.3) {
        trend = "improving";
      } else if (regression.slope < 0 && regression.rSquared > 0.3) {
        trend = "declining";
      }

      // Surprise analysis (if estimates provided)
      let beatRatio: number | null = null;
      let avgSurprise: number | null = null;
      let avgSurprisePercent: number | null = null;
      const surprises: SurpriseEntry[] = [];

      if (estimates && Array.isArray(estimates) && estimates.length > 0) {
        // Match estimates with actuals by quarter
        for (const est of estimates) {
          const actual = actualEps.find((a) => a.quarter === est.quarter);
          if (actual) {
            const surprise = actual.eps - est.estimated_eps;
            const surprisePercent =
              est.estimated_eps !== 0
                ? Math.round((surprise / Math.abs(est.estimated_eps)) * 10000) /
                  100
                : 0;

            surprises.push({
              quarter: est.quarter,
              actual: actual.eps,
              estimated: est.estimated_eps,
              surprise: Math.round(surprise * 10000) / 10000,
              surprisePercent,
              beat: actual.eps >= est.estimated_eps,
            });
          }
        }

        if (surprises.length > 0) {
          const beats = surprises.filter((s) => s.beat).length;
          beatRatio = Math.round((beats / surprises.length) * 100) / 100;
          avgSurprise =
            Math.round(
              (surprises.reduce((sum, s) => sum + s.surprise, 0) /
                surprises.length) *
                10000,
            ) / 10000;
          avgSurprisePercent =
            Math.round(
              (surprises.reduce((sum, s) => sum + s.surprisePercent, 0) /
                surprises.length) *
                100,
            ) / 100;
        }
      }

      // Generate flags
      if (epsMomentum === "accelerating") {
        flags.push("EPS momentum is accelerating - strong execution trend");
      } else if (epsMomentum === "decelerating") {
        flags.push(
          "EPS momentum decelerating - watch for deteriorating business conditions",
        );
      }

      if (coefficientOfVariation > 0.5) {
        flags.push(
          `High EPS volatility (CV: ${coefficientOfVariation}) - earnings are unpredictable`,
        );
      }

      if (beatRatio != null && beatRatio >= 0.8) {
        flags.push(
          `Consistently beats estimates (${Math.round(beatRatio * 100)}% beat rate) - management tends to underpromise`,
        );
      } else if (beatRatio != null && beatRatio <= 0.3) {
        flags.push(
          `Frequently misses estimates (${Math.round(beatRatio * 100)}% beat rate) - guidance may be overly optimistic`,
        );
      }

      if (trend === "declining" && confidence !== "low") {
        flags.push("EPS trend is declining - structural headwinds may exist");
      }

      if (confidence === "low") {
        flags.push(
          "Forward EPS estimate has low confidence - limited data or erratic earnings pattern",
        );
      }

      // Check for recent EPS misses
      if (surprises.length >= 2) {
        const recentTwo = surprises.slice(-2);
        if (recentTwo.every((s) => !s.beat)) {
          flags.push(
            "Missed estimates in last 2 quarters - potential operational issues",
          );
        }
      }

      const result: EarningsEstimatesResult = {
        beatRatio,
        avgSurprise,
        avgSurprisePercent,
        epsMomentum,
        epsStability,
        coefficientOfVariation,
        forwardEstimate: {
          nextQuarterEPS,
          nextYearEPS: nextYearEPSAnnual,
          growthRate,
          confidence,
          r_squared: regression.rSquared,
        },
        trend,
        surprises,
        quarterlyEPS,
        flags,
      };

      return {
        success: true,
        data: result,
        metadata: {
          quartersAnalyzed: actualEps.length,
          estimatesMatched: surprises.length,
          rSquared: regression.rSquared,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Earnings estimates analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
