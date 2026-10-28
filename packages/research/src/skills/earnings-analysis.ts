/**
 * Earnings Analysis Skill - Quarterly results deep dive
 *
 * Triggers: "earnings analysis TCS", "quarterly results", "EPS trend"
 * Output: Earnings beat/miss history, surprise patterns, revenue trajectory, management guidance
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const earningsAnalysisSkill: ResearchSkill = {
  name: "earnings-analysis",
  description:
    "Quarterly earnings analysis with surprise patterns, revenue trajectory, and guidance assessment",
  triggers: [
    /\b(earnings?|quarterly\s*results?|q[1-4]\s*results?)\s*(analysis|review|deep\s*dive|surprise)/i,
    /\b(eps|earnings?\s*per\s*share)\s*(trend|growth|history|beat|miss)/i,
    /\b(revenue|top\s*line)\s*(growth|trend|trajectory)\b/i,
    // The beat/miss/surprise trigger moved to earnings-deep-dive (v2), which
    // registers first — an identical copy here could never match (dead).
    /\bmanagement\s*guidance\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Phase 1: Data fetch
      fetchTask("earnings", "fetch_earnings", { symbol }),
      fetchTask("financials", "fetch_income_statement", {
        symbol,
        quarterly: true,
      }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      fetchTask("news", "fetch_news", { symbol, category: "earnings" }),
      fetchTask("recommendations", "fetch_analyst_recommendations", { symbol }),

      // Phase 2: Computation
      computeTask("surprise", "compute_earnings_surprise", {}, ["earnings"]),
      computeTask("growth", "compute_growth_metrics", {}, ["financials"]),

      // Phase 3: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        { query: params.query || `Earnings analysis of ${params.symbol}` },
        [
          "earnings",
          "financials",
          "price",
          "news",
          "recommendations",
          "surprise",
          "growth",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) || `Earnings analysis of ${params.symbol}`,
      skill: "earnings-analysis",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "moderate",
    };
  },
};
