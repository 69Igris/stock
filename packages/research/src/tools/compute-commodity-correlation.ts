/**
 * Commodity Correlation Analysis
 *
 * Computes Pearson correlation between stock and commodity prices,
 * rolling 60-day correlation, strength classification, and interpretation.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { insufficientInput } from "./insufficient-input";

interface CommodityCorrelationResult {
  correlation: number;
  rollingCorrelation60d: number[];
  avgRollingCorrelation: number;
  strength:
    | "strong_positive"
    | "moderate_positive"
    | "weak"
    | "moderate_negative"
    | "strong_negative";
  interpretation: string;
  pValueApprox: number;
  dailyReturnCorrelation: number;
  commodityName: string;
  dataPoints: number;
  flags: string[];
}

function computeReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0 && prices[i]! > 0) {
      returns.push((prices[i]! - prices[i - 1]!) / prices[i - 1]!);
    } else {
      returns.push(0);
    }
  }
  return returns;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += x[i]!;
    sumY += y[i]!;
    sumXY += x[i]! * y[i]!;
    sumX2 += x[i]! * x[i]!;
    sumY2 += y[i]! * y[i]!;
  }

  const denom = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY),
  );
  if (denom === 0) return 0;

  return (n * sumXY - sumX * sumY) / denom;
}

function approximatePValue(r: number, n: number): number {
  // Approximate p-value using t-distribution approximation
  // t = r * sqrt((n-2) / (1-r^2))
  if (n < 4 || Math.abs(r) >= 1) return 1;
  const rSquared = r * r;
  if (rSquared >= 1) return 0;
  const t = Math.abs(r) * Math.sqrt((n - 2) / (1 - rSquared));
  // Approximate two-tailed p-value using Cauchy CDF approximation
  // For large t, p ≈ 2 / (t^2 * π) ... simplified
  // Using a more practical approximation:
  const df = n - 2;
  // Rough approximation: p ≈ exp(-0.717 * t - 0.416 * t^2) for df > 20
  if (df > 20) {
    const p = Math.exp(-0.717 * t - (0.416 * t * t) / df);
    return Math.min(1, Math.max(0, Math.round(p * 10000) / 10000));
  }
  // For smaller df, use cruder approximation
  if (t > 4) return 0.001;
  if (t > 3) return 0.005;
  if (t > 2.5) return 0.02;
  if (t > 2) return 0.05;
  if (t > 1.5) return 0.15;
  if (t > 1) return 0.3;
  return 0.5;
}

function computeRollingCorrelation(
  x: number[],
  y: number[],
  window: number,
): number[] {
  const n = Math.min(x.length, y.length);
  const rolling: number[] = [];

  if (n < window) return rolling;

  for (let i = 0; i <= n - window; i++) {
    const xSlice = x.slice(i, i + window);
    const ySlice = y.slice(i, i + window);
    const corr = pearsonCorrelation(xSlice, ySlice);
    rolling.push(Math.round(corr * 1000) / 1000);
  }

  return rolling;
}

function classifyStrength(
  corr: number,
): CommodityCorrelationResult["strength"] {
  const abs = Math.abs(corr);
  if (abs >= 0.7) return corr > 0 ? "strong_positive" : "strong_negative";
  if (abs >= 0.3) return corr > 0 ? "moderate_positive" : "moderate_negative";
  return "weak";
}

function generateInterpretation(
  corr: number,
  commodityName: string,
  strength: CommodityCorrelationResult["strength"],
): string {
  const commodity = commodityName.toLowerCase();

  switch (strength) {
    case "strong_positive":
      return (
        `Stock has strong positive correlation (${corr}) with ${commodityName}. ` +
        `Rising ${commodity} prices tend to significantly boost this stock. ` +
        `Consider this as a ${commodity}-sensitive play.`
      );
    case "moderate_positive":
      return (
        `Stock has moderate positive correlation (${corr}) with ${commodityName}. ` +
        `There is a noticeable tendency for the stock to benefit from rising ${commodity} prices.`
      );
    case "weak":
      return (
        `Stock shows weak correlation (${corr}) with ${commodityName}. ` +
        `${commodityName} price movements have limited direct impact on this stock.`
      );
    case "moderate_negative":
      return (
        `Stock has moderate negative correlation (${corr}) with ${commodityName}. ` +
        `Rising ${commodity} prices tend to be a headwind for this stock (cost pressure or demand impact).`
      );
    case "strong_negative":
      return (
        `Stock has strong negative correlation (${corr}) with ${commodityName}. ` +
        `Rising ${commodity} prices significantly hurt this stock - likely a major input cost or demand dampener.`
      );
  }
}

export const computeCommodityCorrelationTool: ResearchToolDef = {
  name: "compute_commodity_correlation",
  description:
    "Compute Pearson correlation between stock and commodity prices - rolling 60-day correlation, strength, sensitivity interpretation",
  category: "computation",
  parameters: {
    stock_prices: {
      type: "array",
      description: "Array of stock closing prices (chronological order, daily)",
      required: true,
    },
    commodity_prices: {
      type: "array",
      description:
        "Array of commodity closing prices (same time period and length as stock_prices)",
      required: true,
    },
    commodity_name: {
      type: "string",
      description:
        "Name of the commodity (e.g., 'Crude Oil', 'Gold', 'Silver', 'Copper')",
      required: true,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const stockPrices = params.stock_prices as number[] | undefined;
    const commodityPrices = params.commodity_prices as number[] | undefined;
    const commodityName = params.commodity_name as string;

    if (!stockPrices || !Array.isArray(stockPrices)) {
      return { success: false, error: "stock_prices array is required" };
    }
    if (stockPrices.length < 10) {
      return insufficientInput(
        "stock_prices array with at least 10 data points is required",
        { needed: "10 data points", got: stockPrices.length },
      );
    }
    if (!commodityPrices || !Array.isArray(commodityPrices)) {
      return { success: false, error: "commodity_prices array is required" };
    }
    if (commodityPrices.length < 10) {
      return insufficientInput(
        "commodity_prices array with at least 10 data points is required",
        { needed: "10 data points", got: commodityPrices.length },
      );
    }
    if (!commodityName) {
      return { success: false, error: "commodity_name is required" };
    }

    try {
      // Ensure same length
      const minLen = Math.min(stockPrices.length, commodityPrices.length);
      const sp = stockPrices.slice(0, minLen);
      const cp = commodityPrices.slice(0, minLen);

      // Price-level correlation
      const priceCorrelation =
        Math.round(pearsonCorrelation(sp, cp) * 1000) / 1000;

      // Daily returns correlation (more meaningful)
      const stockReturns = computeReturns(sp);
      const commodityReturns = computeReturns(cp);
      const returnCorrelation =
        Math.round(pearsonCorrelation(stockReturns, commodityReturns) * 1000) /
        1000;

      // Rolling 60-day correlation on returns
      const rollingWindow = Math.min(60, Math.floor(stockReturns.length / 2));
      const rollingCorrelation60d =
        rollingWindow >= 20
          ? computeRollingCorrelation(
              stockReturns,
              commodityReturns,
              rollingWindow,
            )
          : [];

      const avgRollingCorrelation =
        rollingCorrelation60d.length > 0
          ? Math.round(
              (rollingCorrelation60d.reduce((a, b) => a + b, 0) /
                rollingCorrelation60d.length) *
                1000,
            ) / 1000
          : returnCorrelation;

      // Use return correlation as the primary measure
      const correlation = returnCorrelation;
      const strength = classifyStrength(correlation);
      const interpretation = generateInterpretation(
        correlation,
        commodityName,
        strength,
      );

      // Approximate p-value
      const pValueApprox = approximatePValue(correlation, stockReturns.length);

      // Flags
      const flags: string[] = [];

      if (Math.abs(correlation) >= 0.7) {
        flags.push(
          `High sensitivity to ${commodityName} - consider hedging commodity exposure`,
        );
      }

      // Check if correlation is unstable (high variance in rolling)
      if (rollingCorrelation60d.length > 5) {
        const rollMean = avgRollingCorrelation;
        const rollVariance =
          rollingCorrelation60d.reduce(
            (sum, v) => sum + (v - rollMean) ** 2,
            0,
          ) / rollingCorrelation60d.length;
        const rollStd = Math.sqrt(rollVariance);
        if (rollStd > 0.3) {
          flags.push(
            "Correlation is unstable over time - relationship may be regime-dependent",
          );
        }
      }

      // Check price vs return correlation divergence
      if (
        Math.abs(priceCorrelation) > 0.5 &&
        Math.abs(returnCorrelation) < 0.2
      ) {
        flags.push(
          "Price-level correlation is spurious (common trend) - return correlation is low, indicating limited true sensitivity",
        );
      }

      if (pValueApprox > 0.05) {
        flags.push(
          `Correlation may not be statistically significant (approx p-value: ${pValueApprox})`,
        );
      }

      const result: CommodityCorrelationResult = {
        correlation,
        rollingCorrelation60d,
        avgRollingCorrelation,
        strength,
        interpretation,
        pValueApprox,
        dailyReturnCorrelation: returnCorrelation,
        commodityName,
        dataPoints: minLen,
        flags,
      };

      return {
        success: true,
        data: result,
        metadata: {
          commodityName,
          dataPoints: minLen,
          priceCorrelation,
          returnCorrelation,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Commodity correlation analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
