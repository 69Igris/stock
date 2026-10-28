/**
 * Risk-Adjusted Returns
 *
 * Sharpe = (R - Rf) / σ
 * Sortino uses downside σ only
 * Calmar = R / maxDD
 * Rf = 6.5% (RBI repo rate)
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { RiskAdjustedReturnsResult } from "../types";
import { insufficientInput } from "./insufficient-input";

const TRADING_DAYS_PER_YEAR = 252;
const RISK_FREE_RATE = 0.065; // 6.5% RBI repo rate

export const computeRiskAdjustedReturnsTool: ResearchToolDef = {
  name: "compute_risk_adjusted_returns",
  description:
    "Calculate Sharpe, Sortino, and Calmar ratios from portfolio returns",
  category: "computation",
  parameters: {
    dailyReturns: {
      type: "array",
      description: "Array of daily portfolio returns (decimals)",
      required: true,
    },
    maxDrawdown: {
      type: "number",
      description: "Maximum drawdown (negative decimal)",
    },
    riskFreeRate: {
      type: "number",
      description: "Annual risk-free rate (decimal, default 0.065)",
      default: 0.065,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const dailyReturns = params.dailyReturns as number[] | undefined;
    const maxDrawdown = params.maxDrawdown as number | undefined;
    const rf = (params.riskFreeRate as number) || RISK_FREE_RATE;

    if (!dailyReturns?.length || dailyReturns.length < 20) {
      return insufficientInput("At least 20 daily returns required");
    }

    // A single non-finite return (NaN / ±Infinity) poisons the variance and
    // annualized-volatility math (→ NaN). Reject malformed input rather than
    // emitting NaN ratios.
    if (!dailyReturns.every((r) => Number.isFinite(r))) {
      return {
        success: false,
        error: "dailyReturns must contain only finite numbers",
      };
    }

    try {
      const n = dailyReturns.length;

      // Daily stats
      const dailyMean = dailyReturns.reduce((s, r) => s + r, 0) / n;
      const dailyVariance =
        dailyReturns.reduce((s, r) => s + Math.pow(r - dailyMean, 2), 0) /
        (n - 1);
      const dailyStdDev = Math.sqrt(dailyVariance);

      // Annualize
      const annualizedReturn = dailyMean * TRADING_DAYS_PER_YEAR;
      const annualizedVol = dailyStdDev * Math.sqrt(TRADING_DAYS_PER_YEAR);

      // Sharpe ratio
      const sharpeRatio =
        annualizedVol > 0 ? (annualizedReturn - rf) / annualizedVol : 0;

      // Sortino ratio - downside deviation only
      const dailyRf = rf / TRADING_DAYS_PER_YEAR;
      const downsideReturns = dailyReturns.filter((r) => r < dailyRf);
      const downsideVariance =
        downsideReturns.length > 0
          ? downsideReturns.reduce((s, r) => s + Math.pow(r - dailyRf, 2), 0) /
            downsideReturns.length
          : 0;
      const downsideDeviation =
        Math.sqrt(downsideVariance) * Math.sqrt(TRADING_DAYS_PER_YEAR);

      const sortinoRatio =
        downsideDeviation > 0 ? (annualizedReturn - rf) / downsideDeviation : 0;

      // Calmar ratio
      const absMaxDD = Math.abs(maxDrawdown ?? 0);
      const calmarRatio = absMaxDD > 0 ? annualizedReturn / absMaxDD : 0;

      const result: RiskAdjustedReturnsResult = {
        annualizedReturn: Math.round(annualizedReturn * 10000) / 10000,
        annualizedVolatility: Math.round(annualizedVol * 10000) / 10000,
        sharpeRatio: Math.round(sharpeRatio * 100) / 100,
        sortinoRatio: Math.round(sortinoRatio * 100) / 100,
        calmarRatio: Math.round(calmarRatio * 100) / 100,
        riskFreeRate: rf,
        maxDrawdown: maxDrawdown ?? 0,
        downsideDeviation: Math.round(downsideDeviation * 10000) / 10000,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Risk-adjusted returns failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
