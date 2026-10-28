/**
 * Global Fund Comparison Skill
 *
 * Triggers: "Compare SPY vs VOO", "Global fund vs Indian fund",
 *           "US ETF analysis", "International fund comparison"
 * Output: Fund data + comparison + synthesis report
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";

export const globalFundComparisonSkill: ResearchSkill = {
  name: "global-fund-comparison",
  description: "Compare Indian and global funds with currency normalization",
  triggers: [
    /\b(compare|vs|versus)\b.*\b(fund|etf|vanguard|fidelity|schwab|ishares|spy|voo|qqq)\b/i,
    /\b(global|international|us|foreign)\b.*\b(fund|etf|mutual)\b/i,
  ],
  requiredParams: ["symbols"],
  optionalParams: ["query"],
  buildPlan: (params): ResearchPlan => {
    const symbols = (params.symbols as string[]) || [];

    const fetchIds: string[] = [];
    const tasks = [];

    // Phase 1: Fetch data for each fund (parallel)
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i]!;
      const id = `fund_${i}`;
      fetchIds.push(id);
      tasks.push(fetchTask(id, "fetch_global_fund", { symbol: sym }));
    }

    // Phase 2: Compare funds (depends on all fetches)
    tasks.push(
      computeTask(
        "compare",
        "compare_global_funds",
        { baseCurrency: "INR" },
        fetchIds,
      ),
    );

    // Phase 3: Synthesize report
    tasks.push(
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Compare funds: ${symbols.join(" vs ")}`,
          mode: "advanced",
          queryType: "comparison",
        },
        [...fetchIds, "compare"],
      ),
    );

    return {
      query:
        (params.query as string) || `Compare funds: ${symbols.join(" vs ")}`,
      skill: "global-fund-comparison",
      symbols,
      tasks,
      estimatedSteps: tasks.length,
      complexity: "moderate",
    };
  },
};
