/**
 * Single-Stock Risk Analysis Skill (MONEY-613)
 *
 * The L4 "Risk Assessment (VaR, Drawdown, Beta)" segment used to point at the
 * portfolio-risk-analysis skill, which is holdings-scoped (concentration /
 * correlation / rebalancing) — wrong for a single subject stock. This skill
 * runs the SINGLE-STOCK risk tools (historical VaR, drawdown profile,
 * volatility regime, beta vs Nifty) on the subject's own 1-year price history.
 *
 * Triggers are intentionally narrow so generic "VaR / drawdown" queries still
 * route to the portfolio skill; L4 reaches this skill by name, not by trigger.
 *
 * SEBI: descriptive risk metrics only, no buy/sell/hold.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const stockRiskAnalysisSkill: ResearchSkill = {
  name: "stock-risk-analysis",
  description:
    "Single-stock risk assessment — historical VaR, drawdown profile, volatility regime, and beta vs Nifty from the subject's own price history",
  triggers: [/\bsingle[-\s]?stock\s*risk\b/i, /\brisk\s*profile\s*of\s+\w+/i],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Subject + benchmark (Nifty 50) price history for beta vs market.
      fetchTask("history", "fetch_price_history", { symbol, period: "1y" }),
      fetchTask("benchmark", "fetch_price_history", {
        symbol: "^NSEI",
        period: "1y",
      }),

      // Single-stock risk computations (all bind from the subject price; beta
      // also reads the benchmark series via symbolMatch).
      computeTask("position_var", "compute_position_var", {}, ["history"]),
      computeTask("drawdown_profile", "compute_drawdown_profile", {}, [
        "history",
      ]),
      computeTask("volatility_regime", "compute_volatility_regime", {}, [
        "history",
      ]),
      computeTask("beta", "compute_beta_decomposition", {}, [
        "history",
        "benchmark",
      ]),

      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) || `Risk assessment of ${params.symbol}`,
        },
        [
          "history",
          "position_var",
          "drawdown_profile",
          "volatility_regime",
          "beta",
        ],
      ),
    ];

    return {
      query: (params.query as string) || `Risk assessment of ${params.symbol}`,
      skill: "stock-risk-analysis",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
