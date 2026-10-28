/**
 * MF Comparison Skill (L3)
 *
 * For comparing multiple mutual funds side-by-side. Each fund gets a full
 * overview + holdings fetch and a risk-adjusted analysis, then a single
 * cross-fund holdings-overlap computation surfaces how much the funds share,
 * and a synthesis segment describes them side-by-side.
 *
 * Triggers: programmatic only. The comparison classifier routes here once it
 *   has resolved the fund set; this skill never regex-matches raw user text
 *   (mirrors multi-comparison.ts with the __NEVER_MATCH__ sentinel).
 *
 * MONEY-457 SEBI compliance: observations/scores/flags only. UseMoney is not
 *   SEBI-registered as a Research Analyst, so each fund is described neutrally
 *   and no winner is named — no buy/sell/hold verdict.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";

export const mfComparisonSkill: ResearchSkill = {
  name: "mf-comparison",
  description:
    "Deep multi-fund comparison with per-fund analysis and cross-fund holdings overlap",
  triggers: [
    // This skill is triggered programmatically by the comparison classifier,
    // not by regex — never match raw user text.
    /\b__NEVER_MATCH__\b/,
  ],
  requiredParams: ["symbols"],
  optionalParams: ["exchange", "depth"],
  buildPlan: (params): ResearchPlan => {
    const symbols = params.symbols as string[];

    const tasks = [];

    // Per-fund data fetch and analysis.
    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i]!;
      const prefix = `fund_${i}`;

      tasks.push(
        fetchTask(`${prefix}_overview`, "fetch_mf_overview", { symbol }),
      );
      tasks.push(
        fetchTask(`${prefix}_holdings`, "fetch_mf_holdings", { symbol }),
      );
      tasks.push(
        computeTask(`${prefix}_analysis`, "compute_mf_analysis", {}, [
          `${prefix}_overview`,
          `${prefix}_holdings`,
        ]),
      );
    }

    // Cross-fund holdings overlap. The orchestrator wires the executor to
    // accumulate each fund's holdings into the `funds` param from these deps.
    tasks.push(
      computeTask(
        "overlap",
        "compute_holdings_overlap",
        {},
        symbols.map((_, i) => `fund_${i}_holdings`),
      ),
    );

    // Synthesis: describe all funds side-by-side (no winner).
    const allDeps: string[] = [];
    for (let i = 0; i < symbols.length; i++) {
      allDeps.push(
        `fund_${i}_overview`,
        `fund_${i}_holdings`,
        `fund_${i}_analysis`,
      );
    }
    allDeps.push("overlap");

    tasks.push(
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Compare funds ${symbols.join(" vs ")}`,
          outputFormat: "mf_comparison",
        },
        allDeps,
      ),
    );

    return {
      query:
        (params.query as string) ||
        `Compare funds ${symbols.join(" vs ")}`,
      skill: "mf-comparison",
      symbols,
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
