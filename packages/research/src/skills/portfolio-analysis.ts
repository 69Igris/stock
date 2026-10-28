/**
 * Portfolio Analysis Skill - Analyze user's holdings
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";

export const portfolioAnalysisSkill: ResearchSkill = {
  name: "portfolio-analysis",
  description:
    "Analyze user's portfolio: concentration, sector allocation, risk score",
  triggers: [
    /\b(analyz|analyse|review)\s*(my\s*)?(portfolio|holdings)\b/i,
    /\bportfolio\s*(risk|health|analysis|review)\b/i,
  ],
  requiredParams: ["holdings"],
  buildPlan: (params): ResearchPlan => {
    const holdings = params.holdings as Array<{
      symbol: string;
      quantity: number;
      avgPrice: number;
    }>;

    if (!holdings?.length) {
      return {
        query: "Portfolio analysis",
        skill: "portfolio-analysis",
        symbols: [],
        tasks: [],
        estimatedSteps: 0,
        complexity: "simple",
      };
    }

    const symbols = holdings.map((h) => {
      const sym = h.symbol.toUpperCase();
      return sym.includes(".") ? sym : `${sym}.NS`;
    });

    const tasks = [fetchTask("prices", "fetch_stock_price", { symbols })];

    // Fetch ratios for top 10 holdings by value
    const ratioIds: string[] = ["prices"];
    const topSymbols = symbols.slice(0, 10);
    for (let i = 0; i < topSymbols.length; i++) {
      const id = `ratios_${i}`;
      tasks.push(fetchTask(id, "fetch_key_ratios", { symbol: topSymbols[i] }));
      ratioIds.push(id);
    }

    tasks.push(
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query: (params.query as string) || "Analyze my portfolio",
          holdings,
        },
        ratioIds,
      ),
    );

    return {
      query: (params.query as string) || "Portfolio analysis",
      skill: "portfolio-analysis",
      symbols,
      tasks,
      estimatedSteps: tasks.length,
      complexity: "moderate",
    };
  },
};
