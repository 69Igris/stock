/**
 * Macro Sensitivities Skill - Interest-rate, inflation & commodity exposure
 *
 * Triggers: "macro sensitivity", "interest rate impact", "rate sensitive",
 *           "commodity correlation", "inflation impact"
 * Output: macro-factor impact mapping, commodity price correlation, rate
 *         sensitivity (duration-style exposure to policy moves).
 *
 * SEBI: observation-only. Describes historical/structural sensitivities; makes
 * no forward price prediction or buy/sell recommendation.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const macroSensitivitiesSkill: ResearchSkill = {
  name: "macro-sensitivities",
  description:
    "Maps a stock's exposure to macro factors - interest-rate sensitivity, inflation impact, and commodity price correlation",
  triggers: [
    // macro sensitivity / impact / exposure
    /\bmacro\b.*\b(sensitivit|impact|exposure)\w*\b/i,
    // interest rate sensitivity / impact / exposure, "rate sensitive"
    /\b(interest\s*rate|rate)\b.*\b(sensitiv|impact|exposure)\w*\b/i,
    /\brate[-\s]*sensitive\b/i,
    // commodity correlation / exposure
    /\bcommodit(?:y|ies)\b.*\b(correlation|exposure|sensitivit\w*|impact)\b/i,
    // inflation impact / sensitivity / exposure
    /\binflation\b.*\b(impact|sensitivit\w*|exposure)\b/i,
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
      fetchTask("profile", "fetch_company_profile", { symbol }),
      fetchTask("macro", "fetch_macro_dashboard", {}),
      fetchTask("history", "fetch_price_history", { symbol }),

      // Phase 2: Macro-sensitivity computations
      computeTask("macro_impact", "compute_macro_impact", {}, [
        "profile",
        "macro",
      ]),
      computeTask("commodity_correlation", "compute_commodity_correlation", {}, [
        "profile",
        "history",
      ]),
      computeTask("rate_sensitivity", "compute_rate_sensitivity", {}, [
        "profile",
        "macro",
      ]),

      // Phase 3: Synthesis (depends on all prior tasks)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Macro sensitivities of ${params.symbol}`,
        },
        [
          "profile",
          "macro",
          "history",
          "macro_impact",
          "commodity_correlation",
          "rate_sensitivity",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) || `Macro sensitivities of ${params.symbol}`,
      skill: "macro-sensitivities",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
