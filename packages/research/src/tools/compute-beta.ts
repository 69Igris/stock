/**
 * Compute portfolio beta vs benchmark (typically NIFTY 50).
 *
 * Beta = Cov(R_p, R_m) / Var(R_m)
 *
 * Requires aligned daily-return series for the portfolio and the
 * benchmark. Caller is responsible for date-aligning the two series
 * (this tool assumes they're already paired by index).
 *
 * Interpretation:
 *   β < 0.85 → defensive (less volatile than benchmark)
 *   0.85 ≤ β ≤ 1.15 → moderate (tracks the market)
 *   β > 1.15 → aggressive (more volatile than benchmark)
 *
 * MONEY-801 (benchmark run-param): this tool's benchmark series is
 * PORTFOLIO-LAYER-DRIVEN — `benchmarkReturns` (and `portfolioReturns`) arrive
 * pre-computed from the portfolio/server-action layer, NOT from a plan-time
 * `fetch_price_history` dependency. So the `params.benchmark` index id that
 * `applyRunParameters` stamps onto a `compute_beta` task (agent-logic.ts) is
 * INERT here: `execute` reads only the two return arrays and never the
 * `benchmark` field. The run-param IS honoured by `compute_beta_decomposition`
 * instead, which derives its returns from the benchmark `fetch_price_history`
 * series (the stamp disambiguates which index that fetch swaps to). Recommend
 * dropping the `compute_beta` branch of the benchmark stamp in agent-logic.ts
 * (out of this file's surface) so it no longer plants a param no consumer reads.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { insufficientInput } from "./insufficient-input";

export interface BetaResult {
  beta: number;
  /** Correlation coefficient (|β × σ_m| / σ_p in math; reported separately) */
  correlation: number;
  /** Number of paired daily returns used in the computation */
  observations: number;
  /** Annualized volatility of portfolio (×√252) */
  portfolioVol: number;
  /** Annualized volatility of benchmark (×√252) */
  benchmarkVol: number;
}

const TRADING_DAYS_PER_YEAR = 252;

export const computeBetaTool: ResearchToolDef = {
  name: "compute_beta",
  description:
    "Calculate portfolio beta vs a benchmark from paired daily-return series",
  category: "computation",
  parameters: {
    portfolioReturns: {
      type: "array",
      description: "Array of portfolio daily returns (decimals)",
      required: true,
    },
    benchmarkReturns: {
      type: "array",
      description:
        "Array of benchmark daily returns (decimals), aligned by index with portfolioReturns",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const portfolioReturns = params.portfolioReturns as number[] | undefined;
    const benchmarkReturns = params.benchmarkReturns as number[] | undefined;

    if (!portfolioReturns?.length || !benchmarkReturns?.length) {
      return { success: false, error: "Both return series are required" };
    }

    const n = Math.min(portfolioReturns.length, benchmarkReturns.length);
    if (n < 20) {
      // MONEY-1274 (#30) — thin input, not a failure. See insufficient-input.ts.
      return insufficientInput(
        "At least 20 paired daily returns are required",
        {
          needed: "20 paired daily returns",
          got: n,
        },
      );
    }

    try {
      // Use the last `n` paired observations so the series align tail-first.
      const pSlice = portfolioReturns.slice(-n);
      const bSlice = benchmarkReturns.slice(-n);

      const pMean = pSlice.reduce((s, r) => s + r, 0) / n;
      const bMean = bSlice.reduce((s, r) => s + r, 0) / n;

      let covariance = 0;
      let bVariance = 0;
      let pVariance = 0;

      for (let i = 0; i < n; i++) {
        const pDev = pSlice[i]! - pMean;
        const bDev = bSlice[i]! - bMean;
        covariance += pDev * bDev;
        bVariance += bDev * bDev;
        pVariance += pDev * pDev;
      }

      // Sample-style denominator (n-1) is conventional; both terms use the
      // same divisor so the division cancels - leaving the same beta.
      covariance /= n - 1;
      bVariance /= n - 1;
      pVariance /= n - 1;

      const beta = bVariance > 0 ? covariance / bVariance : 0;
      const pStd = Math.sqrt(pVariance);
      const bStd = Math.sqrt(bVariance);
      const correlation = pStd > 0 && bStd > 0 ? covariance / (pStd * bStd) : 0;

      const result: BetaResult = {
        beta: Math.round(beta * 1000) / 1000,
        correlation: Math.round(correlation * 1000) / 1000,
        observations: n,
        portfolioVol:
          Math.round(pStd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 10000) / 10000,
        benchmarkVol:
          Math.round(bStd * Math.sqrt(TRADING_DAYS_PER_YEAR) * 10000) / 10000,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Beta computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
