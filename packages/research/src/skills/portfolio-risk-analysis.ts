/**
 * Portfolio Risk Analysis Skill
 *
 * Triggers: "portfolio risk", "VaR", "sharpe", "drawdown", "how risky", "rebalance"
 * DAG: fetch holdings → fetch price histories (top 15) → concentration → correlation → VaR → drawdown → risk returns → rebalancing → synthesis
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";

export const portfolioRiskAnalysisSkill: ResearchSkill = {
  name: "portfolio-risk-analysis",
  description:
    "Comprehensive portfolio risk analysis - VaR, Sharpe, drawdown, correlation, rebalancing",
  triggers: [
    /\b(portfolio|my)\s*(risk|risky|riskiness)\b/i,
    /\b(var|value\s*at\s*risk)\b/i,
    /\b(sharpe|sortino|calmar)\s*(ratio)?\b/i,
    /\b(drawdown|max\s*drawdown)\b/i,
    /\bhow\s*(risky|safe|volatile)\s*(is|are)?\s*(my)?\s*(portfolio|stocks)?\b/i,
    /\brebalanc(e|ing)\s*(my)?\s*portfolio\b/i,
    /\bportfolio\s*(diversif|concentrat)/i,
    /\bcorrelation\s*(matrix|analysis)\b/i,
  ],
  requiredParams: [],
  optionalParams: ["symbols"],
  buildPlan: (params): ResearchPlan => {
    // This skill works with user's actual holdings
    // Symbols are resolved at execution time from holdings data
    const symbols = (params.symbols as string[]) || [];

    const tasks = [
      // Phase 1: Fetch price histories for top holdings
      // The server action will inject holdings data before execution
      fetchTask("price_all", "fetch_stock_price", {
        symbols,
        source: "holdings",
      }),

      // Phase 2: Risk computations (wired by executor/server action)
      computeTask("concentration", "compute_portfolio_concentration", {}, [
        "price_all",
      ]),
      computeTask("correlation", "compute_correlation_matrix", {}, [
        "price_all",
      ]),
      computeTask("var", "compute_var", {}, ["price_all"]),
      computeTask("drawdown", "compute_drawdown", {}, ["price_all"]),
      computeTask("risk_returns", "compute_risk_adjusted_returns", {}, [
        "drawdown",
      ]),
      computeTask("rebalancing", "compute_rebalancing", {}, ["price_all"]),

      // Phase 3: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query: (params.query as string) || "Portfolio risk analysis",
        },
        [
          "concentration",
          "correlation",
          "var",
          "drawdown",
          "risk_returns",
          "rebalancing",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) || "Comprehensive portfolio risk analysis",
      skill: "portfolio-risk-analysis",
      symbols,
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
