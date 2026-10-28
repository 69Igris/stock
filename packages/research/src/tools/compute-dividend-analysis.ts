/**
 * Dividend Analysis Tool
 *
 * Yield, payout ratio, FCF coverage, dividend CAGR(5y),
 * sustainability score. Important for income-focused investors.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { DividendAnalysisResult } from "../types";

export const computeDividendAnalysisTool: ResearchToolDef = {
  name: "compute_dividend_analysis",
  description:
    "Analyze dividend sustainability - yield, payout ratio, FCF coverage, CAGR",
  category: "computation",
  parameters: {
    dividendYield: {
      type: "number",
      description: "Current dividend yield (decimal)",
    },
    dividendPerShare: {
      type: "number",
      description: "Latest annual dividend per share",
    },
    eps: { type: "number", description: "Earnings per share" },
    freeCashFlowPerShare: {
      type: "number",
      description: "FCF per share",
    },
    historicalDividends: {
      type: "array",
      description: "Array of { year, dividend, yield? } for last 5+ years",
    },
    currentPrice: { type: "number", description: "Current stock price" },
  },
  execute: async (params): Promise<ToolOutput> => {
    const dividendYield = (params.dividendYield as number) || 0;
    const dps = (params.dividendPerShare as number) || 0;
    const eps = (params.eps as number) || 0;
    const fcfps = (params.freeCashFlowPerShare as number) || 0;
    const history =
      (params.historicalDividends as Array<{
        year: string;
        dividend: number;
        yield?: number;
      }>) || [];
    const currentPrice = (params.currentPrice as number) || 0;

    try {
      // Payout ratio
      const payoutRatio = eps > 0 ? dps / eps : 0;

      // FCF coverage
      const fcfCoverage = dps > 0 && fcfps > 0 ? fcfps / dps : 0;

      // Dividend CAGR (5 year)
      let dividendCAGR5Y = 0;
      if (history.length >= 2) {
        const oldest = history[0]!.dividend;
        const newest = history[history.length - 1]!.dividend;
        const years = history.length - 1;
        if (oldest > 0 && newest > 0) {
          dividendCAGR5Y =
            Math.round((Math.pow(newest / oldest, 1 / years) - 1) * 10000) /
            10000;
        }
      }

      // Compute yield from price if not provided
      const effectiveYield =
        dividendYield || (currentPrice > 0 && dps > 0 ? dps / currentPrice : 0);

      // Sustainability score (0-100)
      let score = 50;
      if (payoutRatio > 0 && payoutRatio < 0.5) score += 15;
      else if (payoutRatio >= 0.5 && payoutRatio < 0.8) score += 5;
      else if (payoutRatio >= 0.8) score -= 10;

      if (fcfCoverage > 2) score += 15;
      else if (fcfCoverage > 1.2) score += 10;
      else if (fcfCoverage < 1 && fcfCoverage > 0) score -= 10;

      if (dividendCAGR5Y > 0.1) score += 10;
      else if (dividendCAGR5Y > 0.05) score += 5;
      else if (dividendCAGR5Y < 0) score -= 10;

      if (effectiveYield > 0.02) score += 5;
      if (effectiveYield > 0.04) score += 5;

      score = Math.max(0, Math.min(100, score));

      // Verdict
      let verdict: DividendAnalysisResult["verdict"] = "moderate";
      if (score >= 70 && payoutRatio < 0.6 && fcfCoverage > 1.5) {
        verdict = "safe";
      } else if (score < 40 || payoutRatio > 0.9 || fcfCoverage < 0.8) {
        verdict = "at_risk";
      }

      const result: DividendAnalysisResult = {
        currentYield: Math.round(effectiveYield * 10000) / 10000,
        payoutRatio: Math.round(payoutRatio * 10000) / 10000,
        fcfCoverage: Math.round(fcfCoverage * 100) / 100,
        dividendCAGR5Y,
        sustainabilityScore: score,
        history: history.map((h) => ({
          year: h.year,
          dividend: h.dividend,
          yield: h.yield || 0,
        })),
        verdict,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Dividend analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
