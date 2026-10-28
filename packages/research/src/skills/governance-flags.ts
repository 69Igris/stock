/**
 * Governance Flags Skill - Corporate governance & promoter quality review
 *
 * Triggers: "corporate governance", "governance red flags", "promoter pledge",
 *           "promoter holding / stake change", "related party transactions"
 * Output: promoter pledge & holding-trend flags, related-party exposure,
 *          corporate-action scrutiny, dilution/quality signals.
 *
 * SEBI note: observation-only. This skill surfaces disclosure-derived signals
 * (pledging %, holding deltas, RPT exposure) for the user to examine. It does
 * not allege wrongdoing or make buy/sell recommendations.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const governanceFlagsSkill: ResearchSkill = {
  name: "governance-flags",
  description:
    "Corporate governance review - promoter pledging & holding trends, related-party transactions, corporate-action scrutiny, observation-only red flags",
  triggers: [
    // "corporate governance", "governance flags/risk/quality/analysis/review"
    /\b(corporate\s*)?governance\s*(flag|risk|quality|analysis|review|score|red\s*flag)s?\b/i,
    /\b(red\s*flag|risk|quality|analysis|review)s?\s+(in\s+)?(the\s+)?(corporate\s*)?governance\b/i,
    // promoter pledge / pledging
    /\bpromoter\s*(pledge|pledging|pledged)\b/i,
    // promoter holding / stake (change / trend / reduction)
    /\bpromoter\s*(holding|stake|shareholding|ownership)\b/i,
    // related party transactions
    /\brelated[\s-]*party\b/i,
    // explicit governance red flags
    /\bgovernance\b.*\bred\s*flags?\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Phase 1: Data fetch (governance disclosures, parallel)
      fetchTask("shareholding", "fetch_shareholding_pattern", { symbol }),
      fetchTask("promoter_pledging", "fetch_promoter_pledging", { symbol }),
      fetchTask("promoter_holding", "fetch_promoter_holding", { symbol }),
      fetchTask("corporate_actions", "fetch_corporate_actions", { symbol }),
      fetchTask("related_party", "fetch_related_party", { symbol }),
      // Official-channel filings (NSE listing/official source) — each carries
      // a primary-source URL the synthesizer + Sources rail can cite directly.
      fetchTask("exchange_announcements", "fetch_exchange_announcements", {
        symbol,
      }),
      fetchTask("shareholder_meetings", "fetch_shareholder_meetings", {
        symbol,
      }),

      // Phase 2: Governance flag computation (depends on all disclosures)
      computeTask("governance_flags", "compute_governance_flags", {}, [
        "shareholding",
        "promoter_pledging",
        "promoter_holding",
        "corporate_actions",
        "related_party",
      ]),

      // Phase 3: Synthesis (depends on all prior tasks)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            params.query || `Corporate governance review of ${params.symbol}`,
        },
        [
          "shareholding",
          "promoter_pledging",
          "promoter_holding",
          "corporate_actions",
          "related_party",
          "exchange_announcements",
          "shareholder_meetings",
          "governance_flags",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Corporate governance review of ${params.symbol}`,
      skill: "governance-flags",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
