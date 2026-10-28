/**
 * Portfolio Optimization Skill (L3)
 *
 * Analyzes the user's portfolio for concentration, risk, and
 * generates rebalancing recommendations.
 *
 * Triggered programmatically by L3 comprehensive analysis.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { computeTask, synthesisTask } from "./types";

export const portfolioOptimizationSkill: ResearchSkill = {
  name: "portfolio-optimization",
  description:
    "Portfolio optimization with concentration analysis, risk metrics, and rebalancing suggestions",
  triggers: [
    // Triggered programmatically, not by regex
    /\b__NEVER_MATCH__\b/,
  ],
  requiredParams: [],
  optionalParams: [],
  buildPlan: (params): ResearchPlan => {
    const tasks = [
      // Phase 1: Risk computations (use portfolio data from context)
      computeTask("concentration", "compute_portfolio_concentration", {}, []),
      computeTask("correlation", "compute_correlation_matrix", {}, []),
      computeTask("var", "compute_var", {}, []),
      computeTask("drawdown", "compute_drawdown", {}, []),
      computeTask("risk_adjusted", "compute_risk_adjusted_returns", {}, []),

      // Phase 2: Rebalancing
      computeTask("rebalancing", "compute_rebalancing", {}, [
        "concentration",
        "correlation",
        "var",
      ]),

      // Phase 3: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query: params.query || "Portfolio optimization analysis",
          outputFormat: "portfolio_optimization",
        },
        [
          "concentration",
          "correlation",
          "var",
          "drawdown",
          "risk_adjusted",
          "rebalancing",
        ],
      ),
    ];

    return {
      query: (params.query as string) || "Portfolio optimization analysis",
      skill: "portfolio-optimization",
      symbols: [],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
