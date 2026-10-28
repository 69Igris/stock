/**
 * Macro Analysis Skill - Indian macro-economic analysis
 *
 * Triggers on queries about RBI policy, interest rates, inflation, GDP,
 * FII/DII flows, and macroeconomic conditions.
 *
 * Plan:
 *   1. Fetch macro snapshot (repo rate, CPI, GDP, forex reserves)
 *   2. Fetch FII/DII flows
 *   3. If a sector is mentioned, compute macro impact for common scenarios
 *   4. Synthesize a report
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { sectorKeyMatches } from "@usemoney/core/sector-key-match";

// Map of sector keywords to normalized sector names
const SECTOR_KEYWORDS: Record<string, string> = {
  bank: "banking",
  banks: "banking",
  banking: "banking",
  finance: "banking",
  financial: "banking",
  nbfc: "banking",
  it: "it",
  tech: "it",
  technology: "it",
  software: "it",
  infotech: "it",
  oil: "oil & gas",
  energy: "oil & gas",
  petroleum: "oil & gas",
  fmcg: "fmcg",
  consumer: "fmcg",
  auto: "auto",
  automobile: "auto",
  automotive: "auto",
  pharma: "pharma",
  healthcare: "pharma",
  pharmaceutical: "pharma",
  metals: "metals",
  metal: "metals",
  steel: "metals",
  mining: "metals",
  realty: "realty",
  "real estate": "realty",
  property: "realty",
  housing: "realty",
  construction: "realty",
};

// Map of scenario keywords to scenario IDs
const SCENARIO_KEYWORDS: Record<string, string> = {
  "rate cut": "rate_cut",
  "rate reduction": "rate_cut",
  "lower rates": "rate_cut",
  dovish: "rate_cut",
  accommodative: "rate_cut",
  "rate hike": "rate_hike",
  "rate increase": "rate_hike",
  "higher rates": "rate_hike",
  hawkish: "rate_hike",
  tightening: "rate_hike",
  "rupee fall": "rupee_depreciation",
  "rupee depreciation": "rupee_depreciation",
  "rupee weak": "rupee_depreciation",
  "inr depreciation": "rupee_depreciation",
  "dollar rise": "rupee_depreciation",
  "oil spike": "oil_spike",
  "oil price": "oil_spike",
  "crude oil": "oil_spike",
  "oil rise": "oil_spike",
  brent: "oil_spike",
  "inflation rise": "inflation_rise",
  "inflation high": "inflation_rise",
  "cpi rise": "inflation_rise",
  "price rise": "inflation_rise",
};

function extractSector(query: string): string | null {
  // MONEY-1093: `lower.includes(keyword)` with the two-character key "it"
  // matched inside "utilities" and "commodities", so a macro question about
  // either was answered with the IT sensitivity row. Same defect as the research
  // planner and the stress test; the rule now lives in one place.
  //
  // Note this matches against a QUERY, not a stored sector name — the same
  // boundary rule applies, and it also stops "it" firing on words like "with"
  // or "its" in an unrelated question.
  for (const [keyword, sector] of Object.entries(SECTOR_KEYWORDS)) {
    if (sectorKeyMatches(query, keyword)) return sector;
  }
  return null;
}

function extractScenario(query: string): string | null {
  const lower = query.toLowerCase();
  for (const [keyword, scenario] of Object.entries(SCENARIO_KEYWORDS)) {
    if (lower.includes(keyword)) return scenario;
  }
  return null;
}

export const macroAnalysisSkill: ResearchSkill = {
  name: "macro-analysis",
  description:
    "Indian macro-economic analysis - RBI policy, inflation, GDP, FII/DII flows, and sector impact assessment",
  triggers: [
    /\b(macro|macroeconomic|macro[\s-]?economic)\b/i,
    /\bRBI\b/i,
    /\b(repo\s*rate|interest\s*rate|monetary\s*policy)\b/i,
    /\b(rate\s*cut|rate\s*hike)\b/i,
    /\b(inflation|CPI|WPI)\b/i,
    /\b(GDP|gross\s*domestic\s*product)\b/i,
    /\b(FII|DII|foreign\s*institutional|domestic\s*institutional)\b/i,
    /\b(economy|economic\s*(outlook|conditions?|environment|impact))\b/i,
    /\b(fiscal\s*(policy|deficit)|budget\s*impact)\b/i,
    /\b(monetary\s*policy|money\s*supply|liquidity)\b/i,
    /\b(forex\s*reserves?|foreign\s*exchange\s*reserves?)\b/i,
    /\b(rupee\s*(depreciation|fall|weak)|INR\s*(depreciation|fall|weak))\b/i,
    /\b(oil\s*(spike|rise|impact)|crude\s*(spike|rise|impact))\b/i,
  ],
  requiredParams: [],
  optionalParams: ["sector", "scenario"],
  buildPlan: (params): ResearchPlan => {
    const query = (params.query as string) || "Indian macro-economic analysis";
    const sectorFromParams = params.sector as string | undefined;
    const scenarioFromParams = params.scenario as string | undefined;

    // Extract sector and scenario from query if not provided
    const sector = sectorFromParams || extractSector(query);
    const scenario = scenarioFromParams || extractScenario(query);

    const tasks = [];
    const dependsOnIds: string[] = [];

    // 1. Always fetch macro snapshot
    tasks.push(fetchTask("macro_snapshot", "fetch_macro_dashboard", {}));
    dependsOnIds.push("macro_snapshot");

    // 2. Always fetch FII/DII flows
    tasks.push(fetchTask("fii_dii_flows", "fetch_fii_dii_flows", { days: 10 }));
    dependsOnIds.push("fii_dii_flows");

    // 3. If sector is mentioned, compute macro impact
    if (sector) {
      // If a specific scenario is mentioned, compute just that
      if (scenario) {
        const impactId = "macro_impact";
        tasks.push(
          computeTask(impactId, "compute_macro_impact", { sector, scenario }, [
            "macro_snapshot",
          ]),
        );
        dependsOnIds.push(impactId);
      } else {
        // No specific scenario - compute all common scenarios for the sector
        const scenarios = [
          "rate_cut",
          "rate_hike",
          "rupee_depreciation",
          "oil_spike",
          "inflation_rise",
        ];
        for (let i = 0; i < scenarios.length; i++) {
          const impactId = `macro_impact_${i}`;
          tasks.push(
            computeTask(
              impactId,
              "compute_macro_impact",
              { sector, scenario: scenarios[i] },
              ["macro_snapshot"],
            ),
          );
          dependsOnIds.push(impactId);
        }
      }
    }

    // 4. Fetch news related to economic topics
    tasks.push(
      fetchTask("macro_news", "fetch_news", {
        symbol: "Indian economy RBI macro",
      }),
    );
    dependsOnIds.push("macro_news");

    // 5. Synthesize report
    tasks.push(
      synthesisTask("report", "synthesize_report", { query }, dependsOnIds),
    );

    return {
      query,
      skill: "macro-analysis",
      symbols: [],
      tasks,
      estimatedSteps: tasks.length,
      complexity: sector ? "moderate" : "simple",
    };
  },
};
