/**
 * Correlation Matrix Computation
 *
 * Computes Pearson correlation on daily log returns.
 * Diversification score = 100 × (1 - avg|corr|).
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { CorrelationMatrixResult } from "../types";
import { insufficientInput } from "./insufficient-input";

function computeLogReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0 && prices[i]! > 0) {
      returns.push(Math.log(prices[i]! / prices[i - 1]!));
    }
  }
  return returns;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;

  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0,
    sumY2 = 0;

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

export const computeCorrelationMatrixTool: ResearchToolDef = {
  name: "compute_correlation_matrix",
  description:
    "Compute correlation matrix and diversification score from price histories",
  category: "computation",
  parameters: {
    priceHistories: {
      type: "object",
      description:
        "Map of symbol → array of { date, close } sorted chronologically",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const priceHistories = params.priceHistories as
      | Record<string, Array<{ date: string; close: number }>>
      | undefined;

    if (!priceHistories || typeof priceHistories !== "object") {
      return { success: false, error: "price_histories object is required" };
    }
    if (Object.keys(priceHistories).length < 2) {
      // MONEY-1274 (#30) — thin input, not a failure. See insufficient-input.ts.
      return insufficientInput(
        "At least 2 price histories are required for a correlation",
        {
          needed: "2 price histories",
          got: priceHistories ? Object.keys(priceHistories).length : 0,
        },
      );
    }

    try {
      const symbols = Object.keys(priceHistories);
      const returnsMap = new Map<string, number[]>();

      for (const symbol of symbols) {
        const prices = priceHistories[symbol]!.map((p) => p.close);
        returnsMap.set(symbol, computeLogReturns(prices));
      }

      // Build NxN correlation matrix
      const n = symbols.length;
      const matrix: number[][] = Array.from(
        { length: n },
        () => Array(n).fill(0) as number[],
      );

      let totalAbsCorr = 0;
      let pairCount = 0;
      const highPairs: CorrelationMatrixResult["highCorrelationPairs"] = [];

      for (let i = 0; i < n; i++) {
        matrix[i]![i] = 1.0; // Self-correlation
        const ri = returnsMap.get(symbols[i]!)!;

        for (let j = i + 1; j < n; j++) {
          const rj = returnsMap.get(symbols[j]!)!;
          const corr = Math.round(pearsonCorrelation(ri, rj) * 1000) / 1000;

          matrix[i]![j] = corr;
          matrix[j]![i] = corr;

          totalAbsCorr += Math.abs(corr);
          pairCount++;

          if (Math.abs(corr) > 0.7) {
            highPairs.push({
              symbol1: symbols[i]!,
              symbol2: symbols[j]!,
              correlation: corr,
            });
          }
        }
      }

      const avgCorrelation =
        pairCount > 0
          ? Math.round((totalAbsCorr / pairCount) * 1000) / 1000
          : 0;
      const diversificationScore = Math.round((1 - avgCorrelation) * 100);

      const result: CorrelationMatrixResult = {
        symbols,
        matrix,
        avgCorrelation,
        diversificationScore,
        highCorrelationPairs: highPairs.sort(
          (a, b) => Math.abs(b.correlation) - Math.abs(a.correlation),
        ),
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Correlation computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
