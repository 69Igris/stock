/**
 * Tax Analysis Skill
 *
 * Triggers: "tax", "capital gains", "STCG", "LTCG", "ITR", "tax harvest"
 * DAG: compute capital gains → tax harvesting → advance tax → ITR schedule → synthesis
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { computeTask, synthesisTask } from "./types";

export const taxAnalysisSkill: ResearchSkill = {
  name: "tax-analysis",
  description:
    "Indian capital gains tax computation - STCG, LTCG, tax harvesting, advance tax, ITR schedule",
  triggers: [
    /\b(capital\s*gains?|tax)\s*(report|comput|calculat|estimat)/i,
    /\b(stcg|ltcg|short\s*term|long\s*term)\s*(capital\s*gain|tax)/i,
    /\bitr\s*(schedule|filing|report)\b/i,
    /\btax\s*(harvest|loss\s*harvest)/i,
    /\badvance\s*tax\b/i,
    /\bhow\s*much\s*tax\b/i,
    /\bsection\s*(111a|112a)\b/i,
    /\bcapital\s*gains?\b.*\b(india|indian|fy)\b/i,
  ],
  requiredParams: [],
  optionalParams: ["fy"],
  buildPlan: (params): ResearchPlan => {
    const fy = (params.fy as string) || getCurrentFY();

    const tasks = [
      // Phase 1: Compute capital gains from paired trades
      // Trades data injected by server action at execution time
      computeTask("capital_gains", "compute_capital_gains_tax", { fy }, []),

      // Phase 2: Tax optimization
      computeTask("harvesting", "compute_tax_harvesting", {}, [
        "capital_gains",
      ]),
      computeTask("advance_tax", "compute_advance_tax", {}, ["capital_gains"]),

      // Phase 3: ITR formatting
      computeTask("itr_schedule", "generate_itr_schedule", {}, [
        "capital_gains",
      ]),

      // Phase 4: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query: (params.query as string) || `Tax analysis for FY ${fy}`,
        },
        ["capital_gains", "harvesting", "advance_tax", "itr_schedule"],
      ),
    ];

    return {
      query:
        (params.query as string) || `Capital gains tax analysis for FY ${fy}`,
      skill: "tax-analysis",
      symbols: [],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "moderate",
    };
  },
};

/**
 * Get current financial year in "YYYY-YY" format.
 * FY runs Apr 1 to Mar 31. e.g., in Feb 2026 → "2025-26"
 */
function getCurrentFY(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const fyStartYear = month >= 3 ? year : year - 1; // Apr=3
  const fyEndYear = fyStartYear + 1;
  return `${fyStartYear}-${String(fyEndYear).slice(-2)}`;
}
