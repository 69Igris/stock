/**
 * Relative Valuation Skill - Where a stock trades vs its peers & sector
 *
 * Triggers: "relative valuation", "valuation vs peers", "peer valuation",
 *           "cheaper or expensive than peers", "sector multiples"
 * Output: peer multiple table (P/E, P/B, EV/EBITDA), sector-aggregate
 *         medians, premium/discount vs peers, and historical valuation bands.
 *
 * SEBI: observation-only. Reports where the stock sits relative to peers and
 * its own history - it does not recommend buy/sell or assert fair value.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const relativeValuationSkill: ResearchSkill = {
  name: "relative-valuation",
  description:
    "Relative valuation vs peers and sector - peer multiple comparison (P/E, P/B, EV/EBITDA), sector-aggregate medians, premium/discount, and historical valuation bands",
  triggers: [
    /\brelative\s*valuation\b/i,
    /\bvaluation\s*(vs\.?|versus|against|relative\s*to|compared?\s*(?:to|with))\s*(its\s*)?peers?\b/i,
    /\bpeers?\s*valuation\b/i,
    /\b(cheaper|expensive|over\s*valued|under\s*valued|cheap|pricey|dearer)\b.*\b(than|vs\.?|versus|compared?\s*(?:to|with))\b.*\bpeers?\b/i,
    /\bpeers?\b.*\b(cheaper|expensive|over\s*valued|under\s*valued|cheap|pricey|dearer)\b/i,
    /\bsector\s*(multiples?|valuations?|averages?|medians?)\b/i,
    /\b(premium|discount)\s*(to|vs\.?|versus|over)\s*(its\s*)?(peers?|sector)\b/i,
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
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("peers", "fetch_peer_companies", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      fetchTask("profile", "fetch_company_profile", { symbol }),

      // Phase 2: Valuation computations
      computeTask("comparative_valuation", "compute_comparative_valuation", {}, [
        "ratios",
        "peers",
        "price",
      ]),
      computeTask("relative_valuation", "compute_relative_valuation", {}, [
        "ratios",
        "peers",
        "price",
      ]),
      computeTask("sector_aggregates", "compute_sector_aggregates", {}, [
        "peers",
        "profile",
      ]),
      computeTask("valuation_bands", "compute_valuation_bands", {}, [
        "ratios",
        "price",
      ]),

      // Phase 3: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Relative valuation of ${params.symbol} vs peers`,
        },
        [
          "ratios",
          "peers",
          "price",
          "profile",
          "comparative_valuation",
          "relative_valuation",
          "sector_aggregates",
          "valuation_bands",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Relative valuation of ${params.symbol} vs peers`,
      skill: "relative-valuation",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
