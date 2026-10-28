/**
 * Risk & Portfolio Impact Skill - Position-level risk + how it lands in a portfolio
 *
 * Triggers: "position VaR of TCS", "value at risk", "position sizing risk",
 *   "portfolio concentration impact", "portfolio beta drift",
 *   "risk contribution to portfolio"
 * Output: Single-position Value at Risk (historical & parametric VaR95/99,
 *   CVaR95, annualized vol) from the instrument's own return distribution,
 *   plus portfolio-aware concentration delta (HHI, single-name & sector weight
 *   shifts) and portfolio beta drift. The two portfolio-aware computations are
 *   fed by holdings injected from a server action; in single-stock research no
 *   portfolio context exists, so they degrade gracefully (available:false).
 *   Observation-only — no buy/sell/hold or sizing advice (MONEY-457 SEBI
 *   compliance).
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const riskPortfolioImpactSkill: ResearchSkill = {
  name: "risk-portfolio-impact",
  description:
    "Position-level risk and its portfolio impact — single-position Value at Risk (historical & parametric VaR95/99, CVaR95, annualized vol), concentration delta (HHI, single-name & sector weight shifts), and portfolio beta drift. Portfolio-aware computations use injected holdings and degrade gracefully in single-stock research. Observation-only.",
  triggers: [
    // position VaR / risk / sizing
    /\bposition\s*(var|value\s*at\s*risk|risk|sizing)\b/i,
    // value at risk (standalone)
    /\b(value\s*at\s*risk|cvar|expected\s*shortfall)\b/i,
    /\bvar(95|99)?\b.*\b(position|portfolio|stock)\b/i,
    // portfolio concentration impact / risk
    /\bportfolio\s*concentration\s*(impact|risk|delta)\b/i,
    /\bconcentration\s*(impact|delta)\b.*\bportfolio\b/i,
    // portfolio beta drift
    /\bportfolio\s*beta\s*(drift|impact)\b/i,
    /\bbeta\s*drift\b/i,
    // risk contribution to portfolio
    /\brisk\s*contribution\b.*\bportfolio\b/i,
    /\b(contribution\s*to|impact\s*on)\s*portfolio\s*risk\b/i,
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
      // Subject price history — return distribution drives the position VaR.
      fetchTask("history", "fetch_price_history", { symbol, period: "1y" }),
      // Current price snapshot for context / position-value scaling.
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),

      // Phase 2: Risk computations
      // Position VaR reads the close series from fetch_price_history.prices[].
      computeTask("position_var", "compute_position_var", { symbol }, [
        "history",
      ]),
      // Concentration delta is portfolio-aware: holdings are injected by the
      // executor from a server action. In single-stock research there is no
      // portfolio context, so the tool degrades gracefully (available:false).
      computeTask(
        "concentration_delta",
        "compute_concentration_delta",
        { candidateSymbol: symbol },
        ["price"],
      ),
      // Beta drift is also portfolio-aware (server-action holdings); degrades
      // gracefully without a portfolio.
      computeTask(
        "portfolio_beta_drift",
        "compute_portfolio_beta_drift",
        { symbol },
        ["price"],
      ),

      // Phase 3: Synthesis (depends on all prior task ids)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Risk & portfolio impact of ${params.symbol}`,
        },
        [
          "history",
          "price",
          "position_var",
          "concentration_delta",
          "portfolio_beta_drift",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Risk & portfolio impact of ${params.symbol}`,
      skill: "risk-portfolio-impact",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
