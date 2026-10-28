/**
 * Shareholding & Governance Analysis Skill (MONEY-613)
 *
 * Powers the L4 "Shareholding & Institutional Activity" segment, which used to
 * run stock-analysis (no governance signal). This skill fetches the shareholding
 * pattern + promoter holding/pledging + corporate actions + related-party
 * transactions and runs compute_governance_flags — a built+bound tool that no
 * L3/L4 segment previously invoked.
 *
 * SEBI: surfaces governance red-flags + ownership data only, no buy/sell/hold.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const shareholdingAnalysisSkill: ResearchSkill = {
  name: "shareholding-analysis",
  description:
    "Shareholding pattern + promoter holding/pledging + related-party transactions + governance red-flags for a single stock",
  triggers: [
    /\b(shareholding|promoter)\s*(pattern|holding|pledg)/i,
    /\b(governance|related[-\s]?party)\b.*\b(stock|company|share)\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      fetchTask("shareholding", "fetch_shareholding_pattern", { symbol }),
      fetchTask("promoter_holding", "fetch_promoter_holding", { symbol }),
      fetchTask("promoter_pledging", "fetch_promoter_pledging", { symbol }),
      fetchTask("corp_actions", "fetch_corporate_actions", { symbol }),
      fetchTask("related_party", "fetch_related_party", { symbol }),
      // Bulk + block deals — India's public insider/institutional-activity proxy.
      fetchTask("block_deals", "fetch_bulk_block_deals", { symbol }),

      computeTask("governance", "compute_governance_flags", {}, [
        "shareholding",
        "promoter_holding",
        "promoter_pledging",
        "corp_actions",
        "related_party",
      ]),

      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Shareholding & governance review of ${params.symbol}`,
        },
        [
          "shareholding",
          "promoter_holding",
          "promoter_pledging",
          "corp_actions",
          "related_party",
          "block_deals",
          "governance",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Shareholding & governance review of ${params.symbol}`,
      skill: "shareholding-analysis",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
