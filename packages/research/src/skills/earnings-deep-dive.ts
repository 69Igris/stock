/**
 * Earnings Deep Dive Skill (v2) - Institutional-grade earnings analysis
 *
 * Triggers: "earnings deep dive", "earnings quality", "quarterly results",
 *           "EPS growth/surprise/beat/miss", "guidance sensitivity"
 * Output: Earnings quality scoring, estimate vs actual, beat/miss surprise
 *         history, guidance sensitivity bands, multi-period growth metrics.
 *
 * SEBI note: observation-only. No buy/sell/hold advice is produced.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const earningsDeepDiveSkill: ResearchSkill = {
  name: "earnings-deep-dive",
  description:
    "Institutional earnings deep dive - earnings quality, estimate vs actual, beat/miss surprise history, guidance sensitivity, and growth trajectory",
  triggers: [
    // "earnings deep dive" / "earnings deep-dive"
    /\bearnings?\s*deep[-\s]*dive\b/i,
    // "earnings quality"
    /\bearnings?\s*quality\b/i,
    // "quarterly results" / "Q3 results" — explicit quarterly intent
    /\b(quarterly\s*results?|q[1-4]\s*(fy\s*\d{2,4}\s*)?results?)\b/i,
    // EPS-specific intents: growth, surprise, beat, miss
    /\b(eps|earnings?\s*per\s*share)\s*(growth|surprise|beat|miss)\b/i,
    // bare beat / miss / surprise framed against estimates/consensus
    /\b(beat|miss|surprise)\s*(estimates?|consensus|expectations?)\b/i,
    // guidance sensitivity
    /\bguidance\s*sensitivity\b/i,
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
      fetchTask("financials", "fetch_income_statement", { symbol }),
      fetchTask("earnings", "fetch_earnings", { symbol }),
      fetchTask("quarterly", "fetch_quarterly_results", { symbol }),
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),

      // Phase 2: Earnings computations
      computeTask("earnings_quality", "compute_earnings_quality", {}, [
        "financials",
      ]),
      computeTask("earnings_estimates", "compute_earnings_estimates", {}, [
        "earnings",
        "financials",
      ]),
      computeTask("earnings_surprise", "compute_earnings_surprise", {}, [
        "earnings",
      ]),
      computeTask("guidance_sensitivity", "compute_guidance_sensitivity", {}, [
        "financials",
        "ratios",
        "price",
      ]),
      computeTask("growth", "compute_growth_metrics", {}, ["financials"]),

      // Phase 3: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) || `Earnings deep dive of ${params.symbol}`,
        },
        [
          "financials",
          "earnings",
          "quarterly",
          "ratios",
          "price",
          "earnings_quality",
          "earnings_estimates",
          "earnings_surprise",
          "guidance_sensitivity",
          "growth",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) || `Earnings deep dive of ${params.symbol}`,
      skill: "earnings-deep-dive",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
