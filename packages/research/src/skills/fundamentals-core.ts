/**
 * Fundamentals Core Skill - Core fundamental analysis & financial health
 *
 * Triggers: "fundamental analysis", "fundamentals", "financial health",
 * "how financially healthy", "fundamental score"
 * Output: health score, growth metrics, accounting quality, revenue mix,
 * investment score - the institutional core fundamental view of a company.
 *
 * SEBI: observation-only. No buy/sell recommendation is produced; scores are
 * descriptive measures of historically reported fundamentals.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const fundamentalsCoreSkill: ResearchSkill = {
  name: "fundamentals-core",
  description:
    "Core fundamental analysis of a company - financial health score, growth metrics, accounting quality, revenue mix, and a composite fundamental investment score (observation-only)",
  triggers: [
    // "fundamental analysis" / "fundamentals" (+ optional of <X>)
    /\bfundamental(s|\s*analysis)\b/i,
    // "fundamental score" / "fundamental rating" / "fundamental health"
    /\bfundamental\s*(score|rating|health|grade)\b/i,
    // "financial health" / "financially healthy" / "how (financially) healthy"
    /\bfinancial(ly)?\s*health(y)?\b/i,
    /\bhow\s+(financially\s+)?healthy\b/i,
    // "health of <company>'s financials" / "financial soundness"
    /\bfinancial\s*soundness\b/i,
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
      fetchTask("financials", "fetch_income_statement", { symbol }),
      fetchTask("balance", "fetch_balance_sheet", { symbol }),
      fetchTask("cashflow", "fetch_cash_flow", { symbol }),
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),

      // Phase 2: Core fundamental computations
      computeTask("health", "compute_health_score", {}, ["ratios", "profile"]),
      computeTask("growth", "compute_growth_metrics", {}, ["financials"]),
      computeTask("accounting_quality", "compute_accounting_quality", {}, [
        "financials",
        "balance",
        "cashflow",
        "price",
      ]),
      computeTask("revenue_mix", "compute_revenue_mix", {}, [
        "profile",
        "financials",
      ]),
      computeTask("investment_score", "compute_investment_score", {}, [
        "ratios",
        "financials",
        "price",
      ]),

      // Phase 3: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            params.query || `Fundamental analysis of ${params.symbol}`,
        },
        [
          "profile",
          "financials",
          "balance",
          "cashflow",
          "ratios",
          "price",
          "health",
          "growth",
          "accounting_quality",
          "revenue_mix",
          "investment_score",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) || `Fundamental analysis of ${params.symbol}`,
      skill: "fundamentals-core",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
