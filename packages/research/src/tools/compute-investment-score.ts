/**
 * Investment Score Computation
 *
 * Weighted multi-dimensional score combining financial health,
 * growth, valuation, quality, and technical factors.
 * Used in L3 comprehensive analysis for final ranking.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface InvestmentScoreResult {
  overallScore: number; // 0-100
  dimensions: {
    financialHealth: { score: number; weight: number };
    growth: { score: number; weight: number };
    valuation: { score: number; weight: number };
    quality: { score: number; weight: number };
    momentum: { score: number; weight: number };
  };
  conviction: "high" | "medium" | "low";
  /**
   * MONEY-457: This field used to be a "strong_buy" | "buy" | "hold" | "sell"
   * | "strong_sell" bucket derived from `overallScore`. Feeding that token
   * back to the synthesizer LLM consistently caused it to render the
   * verdict into the report ("score of 76 leads to a BUY"). UseMoney is
   * not SEBI-registered as a Research Analyst, so labelled BUY/SELL/HOLD
   * recommendations are not permitted. The field is now constant "N/A" —
   * downstream prompts explicitly ignore it, but the schema stays so
   * historical comparison reports / type imports keep type-checking.
   */
  recommendation: "N/A";
}

export const computeInvestmentScoreTool: ResearchToolDef = {
  name: "compute_investment_score",
  description:
    "Compute a weighted investment score (0-100) combining health, growth, valuation, quality, and momentum",
  category: "computation",
  parameters: {
    healthScore: {
      type: "number",
      description: "Financial health score (0-100)",
    },
    growthScore: {
      type: "number",
      description: "Growth metrics score (0-100)",
    },
    valuationScore: {
      type: "number",
      description: "Valuation attractiveness score (0-100)",
    },
    qualityScore: {
      type: "number",
      description: "Earnings/cash flow quality score (0-100)",
    },
    momentumScore: {
      type: "number",
      description: "Technical momentum score (0-100)",
    },
    weights: {
      type: "object",
      description:
        "Custom weights (default: health 25%, growth 25%, valuation 20%, quality 20%, momentum 10%)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const health = Math.max(
      0,
      Math.min(100, (params.healthScore as number) || 50),
    );
    const growth = Math.max(
      0,
      Math.min(100, (params.growthScore as number) || 50),
    );
    const valuation = Math.max(
      0,
      Math.min(100, (params.valuationScore as number) || 50),
    );
    const quality = Math.max(
      0,
      Math.min(100, (params.qualityScore as number) || 50),
    );
    const momentum = Math.max(
      0,
      Math.min(100, (params.momentumScore as number) || 50),
    );

    const w = (params.weights as Record<string, number>) || {};
    const weights = {
      health: w.health ?? 0.25,
      growth: w.growth ?? 0.25,
      valuation: w.valuation ?? 0.2,
      quality: w.quality ?? 0.2,
      momentum: w.momentum ?? 0.1,
    };

    const overallScore = Math.round(
      health * weights.health +
        growth * weights.growth +
        valuation * weights.valuation +
        quality * weights.quality +
        momentum * weights.momentum,
    );

    let conviction: InvestmentScoreResult["conviction"] = "medium";
    if (overallScore >= 75) conviction = "high";
    else if (overallScore <= 35) conviction = "low";

    // MONEY-457: SEBI compliance — no labelled buy/sell/hold output. The
    // `overallScore` (0-100) carries the same signal numerically without
    // dressing it up as a verdict the user could act on.
    const recommendation: InvestmentScoreResult["recommendation"] = "N/A";

    const result: InvestmentScoreResult = {
      overallScore,
      dimensions: {
        financialHealth: { score: health, weight: weights.health },
        growth: { score: growth, weight: weights.growth },
        valuation: { score: valuation, weight: weights.valuation },
        quality: { score: quality, weight: weights.quality },
        momentum: { score: momentum, weight: weights.momentum },
      },
      conviction,
      recommendation,
    };

    return { success: true, data: result };
  },
};
