/**
 * Regime & Volatility Skill - Risk regime, drawdown profile, beta decomposition
 *
 * Triggers: "volatility regime of TCS", "drawdown profile", "beta decomposition",
 *   "risk regime", "how volatile is RELIANCE"
 * Output: Volatility-regime classification (calm/normal/stressed), drawdown
 *   profile (max DD, recovery, ulcer index), and beta decomposition vs Nifty
 *   (systematic/idiosyncratic vol, bull/bear asymmetry, up/down capture).
 *   Observation-only — no buy/sell/hold verdict (MONEY-457 SEBI compliance).
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const regimeVolatilitySkill: ResearchSkill = {
  name: "regime-volatility",
  description:
    "Risk regime & volatility analysis — volatility-regime classification, drawdown profile, and beta decomposition vs Nifty (systematic/idiosyncratic vol, bull/bear asymmetry, up/down capture). Observation-only.",
  triggers: [
    /\b(volatility|vol)\s*(regime|analysis|profile)\b/i,
    /\b(risk\s*regime|volatility\s*regime)\b/i,
    /\bdrawdown\s*(profile|analysis|risk)\b/i,
    /\bbeta\s*(decomposition|analysis|profile)\b/i,
    /\b(how|is\s+it)\s+(volatile|risky)\b/i,
    /\bhow\s+(volatile|risky)\s+is\b/i,
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
      // Subject price history — drives volatility regime, drawdown, and the
      // stock leg of the beta decomposition.
      fetchTask("history", "fetch_price_history", { symbol, period: "1y" }),
      // Nifty 50 benchmark price history — market leg of beta decomposition.
      fetchTask("nifty", "fetch_price_history", {
        symbol: "^NSEI",
        period: "1y",
      }),
      // Current price snapshot for context.
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),

      // Phase 2: Regime / risk computations
      computeTask("volatility_regime", "compute_volatility_regime", {}, [
        "history",
      ]),
      computeTask("drawdown_profile", "compute_drawdown_profile", {}, [
        "history",
      ]),
      // Beta decomposition needs BOTH the subject and the Nifty benchmark.
      computeTask(
        "beta_decomposition",
        "compute_beta_decomposition",
        { symbol },
        ["history", "nifty"],
      ),

      // Phase 3: Synthesis (depends on all prior task ids)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Risk regime & volatility analysis of ${params.symbol}`,
        },
        [
          "history",
          "nifty",
          "price",
          "volatility_regime",
          "drawdown_profile",
          "beta_decomposition",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Risk regime & volatility analysis of ${params.symbol}`,
      skill: "regime-volatility",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
