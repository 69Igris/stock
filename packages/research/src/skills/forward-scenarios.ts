/**
 * Forward Scenarios Skill - Probabilistic forward-looking projections
 *
 * Triggers: "forward scenarios for TCS", "monte carlo simulation of RELIANCE",
 *   "probability of INFY hitting 1800", "scenario analysis", "price projection",
 *   "price forecast"
 * Output: Bull/base/bear forward scenarios anchored on cash-flow trajectory and
 *   valuation ratios, plus a Monte Carlo return distribution (percentile bands,
 *   probability of target levels) driven by historical price dynamics.
 *   Observation-only — no buy/sell/hold verdict (MONEY-457 SEBI compliance).
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const forwardScenariosSkill: ResearchSkill = {
  name: "forward-scenarios",
  description:
    "Forward-looking scenario analysis — bull/base/bear projections from cash-flow trajectory and valuation ratios, plus a Monte Carlo return distribution (percentile bands, probability of target levels) from historical price dynamics. Observation-only.",
  triggers: [
    // "forward scenario(s)" or "forward looking" intent
    /\bforward[\s-]*(scenario|scenarios|looking|projection|projections)\b/i,
    // Monte Carlo simulation
    /\bmonte[\s-]*carlo\b/i,
    // "probability of <X>" — odds of a target/move/level
    /\bprobabilit(?:y|ies)\s+of\b/i,
    /\bodds\s+of\b/i,
    // explicit scenario analysis / projection
    /\bscenario\s*(analysis|analyses|projection|projections|modelling|modeling)\b/i,
    // price projection / forecast
    /\bprice\s*(projection|projections|forecast|forecasts|target\s*range)\b/i,
    /\b(project|forecast)\s+(the\s+)?(price|return|returns|stock)\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Phase 1: Data fetch (parallel, no deps)
      // Historical price series — drives Monte Carlo return distribution and
      // the price-path leg of the forward scenarios.
      fetchTask("history", "fetch_price_history", { symbol, period: "1y" }),
      // Current price snapshot — anchor for projections and probability bands.
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      // Cash-flow trajectory — fundamental basis for bull/base/bear scenarios.
      fetchTask("cashflow", "fetch_cash_flow", { symbol }),
      // Key ratios — valuation multiples that re-rate the scenario outcomes.
      fetchTask("ratios", "fetch_key_ratios", { symbol }),

      // Phase 2: Scenario / probabilistic computations
      // Forward scenarios draw on the full available data set (fundamentals
      // trajectory + valuation + current price).
      computeTask("forward_scenarios", "compute_forward_scenarios", {}, [
        "history",
        "price",
        "cashflow",
        "ratios",
      ]),
      // Monte Carlo return distribution is driven by historical price dynamics
      // anchored to the current price.
      computeTask("monte_carlo", "compute_monte_carlo_returns", {}, [
        "history",
        "price",
      ]),

      // Phase 3: Synthesis (depends on all prior task ids)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Forward scenario analysis of ${params.symbol}`,
        },
        [
          "history",
          "price",
          "cashflow",
          "ratios",
          "forward_scenarios",
          "monte_carlo",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Forward scenario analysis of ${params.symbol}`,
      skill: "forward-scenarios",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
