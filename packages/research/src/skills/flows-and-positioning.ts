/**
 * Flows & Positioning Skill - Institutional money flows, smart-money positioning
 *
 * Triggers: "FII/DII flows", "institutional flows / positioning / activity",
 * "sector rotation", "short interest", "smart money".
 *
 * Output: who's buying/selling (FII vs DII), where capital is rotating across
 * sectors, and crowding/short-interest signals around a name.
 *
 * SEBI: observation-only. Reports describe flows and positioning; it does NOT
 * recommend trades or predict price direction.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const flowsAndPositioningSkill: ResearchSkill = {
  name: "flows-and-positioning",
  description:
    "Institutional flows & positioning - FII/DII flows, sector rotation, short interest, and smart-money positioning around a stock (observation-only)",
  triggers: [
    // FII / DII flows (kept specific to the *flow* sense, not bare FII/DII macro)
    /\b(FII|DII)\s*(\/?\s*(FII|DII))?\s*(flows?|buying|selling|activity)\b/i,
    /\b(foreign|domestic)\s*institutional\s*(flows?|buying|selling|activity)\b/i,
    // Institutional flows / positioning / activity
    /\binstitutional\s*(flows?|positioning|activity|footprint|ownership\s*change)\b/i,
    // Generic positioning intent
    /\b(positioning|flows?\s*and\s*positioning|flow\s*analysis)\b/i,
    // Sector rotation
    /\bsector\s*rotation\b/i,
    /\b(rotation|money\s*rotating|capital\s*rotation)\s*(across|into|out\s*of)?\s*sectors?\b/i,
    // Short interest / crowding
    /\bshort\s*(interest|positions?|build[\s-]?up|covering|squeeze)\b/i,
    // Smart money
    /\bsmart\s*money\b/i,
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
      fetchTask("fii_dii_flows", "fetch_fii_dii_flows", { days: 10 }),
      fetchTask("profile", "fetch_company_profile", { symbol }),
      fetchTask("macro", "fetch_macro_dashboard", {}),
      fetchTask("short_interest", "fetch_short_interest", { symbol }),

      // Phase 2: Compute (sector rotation reads profile sector + macro + flows)
      computeTask("sector_rotation", "compute_sector_rotation", {}, [
        "profile",
        "macro",
        "fii_dii_flows",
      ]),

      // Phase 3: Synthesis (depends on every prior task)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Institutional flows & positioning of ${params.symbol}`,
        },
        [
          "fii_dii_flows",
          "profile",
          "macro",
          "short_interest",
          "sector_rotation",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Institutional flows & positioning of ${params.symbol}`,
      skill: "flows-and-positioning",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
