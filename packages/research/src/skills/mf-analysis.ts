/**
 * MF Analysis Skill - Comprehensive mutual fund analysis
 *
 * Triggers: "Analyze Axis Bluechip Fund", "Research SBI Small Cap",
 *           "Evaluate Parag Parikh Flexi Cap"
 * Output: Overview + holdings + peers + risk-adjusted analysis + report
 *
 * MONEY-446 Part C — for a deeper (comprehensive/advanced) single-fund run the
 * plan ALSO looks into the fund: compute_constituent_analysis scores the top N
 * underlying constituent stocks by parameters (weight, rank, concentration
 * tier, sector context) straight from the already-fetched fetch_mf_holdings
 * payload, and the synthesis folds that in as a "Constituent Stock Analysis"
 * section. Bounded N (5 comprehensive / 8 advanced) keeps credits + latency in
 * check; we do NOT fan out a full per-stock research sub-job per constituent.
 */

import type { ResearchPlan, ResearchTask } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";

/** Top-N constituents to analyse per depth (bounds credits + wall-clock). */
const CONSTITUENT_TOP_N: Record<string, number> = {
  comprehensive: 5,
  advanced: 8,
};

/** Depths that pull the per-constituent parameter analysis into the plan. */
function constituentTopNForDepth(depth: string): number | null {
  return CONSTITUENT_TOP_N[depth] ?? null;
}

export const mfAnalysisSkill: ResearchSkill = {
  name: "mf-analysis",
  description: "Comprehensive analysis of a mutual fund",
  triggers: [
    /\b(analy[sz]e|research|review|evaluate)\b.*\b(fund|mutual|scheme|mf|etf)\b/i,
    /\b(fund|mutual\s*fund|mf|scheme|etf)\b.*\b(analy[sz]e|research|review|evaluate)\b/i,
    /\bshould\s*i\s*(invest|put\s*money)\b.*\b(fund|mutual|scheme|mf|etf|sip)\b/i,
    /\b(is|are)\s+.*\b(fund|mutual|scheme|mf|etf)\b.*\b(good|bad|worth)\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["query", "depth"],
  buildPlan: (params): ResearchPlan => {
    const symbol = (params.symbol as string) || "";
    const query = (params.query as string) || "";
    // Depth selects how deep the constituent analysis goes. Default to
    // "comprehensive" so the new MF "Analyse" button always looks into the
    // underlying stocks; a caller can pass "moderate" for the lighter run.
    const depth =
      typeof params.depth === "string" && params.depth.trim()
        ? params.depth.trim().toLowerCase()
        : "comprehensive";
    // Detect ETF vs traditional MF - they share most of the analysis pipeline
    // but emit slightly different sections (tracking error, underlying index)
    // via the synthesizer's queryType branch.
    const isEtf =
      /\bETF\b/i.test(symbol) ||
      /\bETF\b/i.test(query) ||
      /\bBEES\b/i.test(symbol) ||
      /(nifty|sensex|bank).*\bbees\b/i.test(symbol);

    const tasks: ResearchTask[] = [
      // Phase 1: Data fetch (parallel)
      fetchTask("mf_overview", "fetch_mf_overview", { symbol }),
      fetchTask("mf_holdings", "fetch_mf_holdings", { symbol }),
      fetchTask("mf_peers", "fetch_mf_peers", { symbol }),

      // Phase 2: Computation (depends on overview)
      computeTask("mf_analysis", "compute_mf_analysis", { symbol }, [
        "mf_overview",
      ]),
    ];

    // Phase 2b (MONEY-446 Part C): per-constituent parameter analysis for the
    // deeper depths. Pure compute over the already-fetched holdings — the
    // executor injects mf_holdings into the tool's `holdings` param (declarative
    // binding). Degrades to available:false when holdings are absent, so it is
    // always safe to include.
    const topN = constituentTopNForDepth(depth);
    const synthesisDeps = ["mf_overview", "mf_holdings", "mf_peers", "mf_analysis"];
    if (topN !== null) {
      tasks.push(
        computeTask(
          "constituents",
          "compute_constituent_analysis",
          { topN, fundName: symbol },
          ["mf_holdings"],
        ),
      );
      synthesisDeps.push("constituents");
    }

    // Phase 3: Synthesis - etf or mf queryType injects fund-specific schema
    tasks.push(
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Analyze ${isEtf ? "ETF" : "mutual fund"} ${symbol}`,
          mode: "advanced",
          queryType: isEtf ? "etf" : "mf",
        },
        synthesisDeps,
      ),
    );

    return {
      query:
        (params.query as string) ||
        `Comprehensive analysis of mutual fund ${symbol}`,
      skill: "mf-analysis",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: topN !== null ? "complex" : "moderate",
    };
  },
};
