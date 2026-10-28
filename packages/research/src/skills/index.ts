/**
 * Research Skills - Registry and matching
 */

import type { ResearchSkill } from "./types";
import { stockAnalysisSkill } from "./stock-analysis";
import { peerComparisonSkill } from "./peer-comparison";
// MONEY-498: dcf-valuation promoted to the v2 institutional skill (richer plan:
// adds compute_dcf_sensitivity + valuation_bands). Old ./dcf-valuation kept on
// disk but no longer registered (same name "dcf-valuation").
import { dcfValuationSkill } from "./dcf-valuation-v2";
import { sectorAnalysisSkill } from "./sector-analysis";
import { sectorDeepDiveSkill } from "./sector-deep-dive";
import { stockScreenerSkill } from "./stock-screener";
import { portfolioAnalysisSkill } from "./portfolio-analysis";
import { portfolioRiskAnalysisSkill } from "./portfolio-risk-analysis";
import { stockRiskAnalysisSkill } from "./stock-risk-analysis";
import { shareholdingAnalysisSkill } from "./shareholding-analysis";
import { taxAnalysisSkill } from "./tax-analysis";
import { strategyAnalysisSkill } from "./strategy-analysis";
import { earningsAnalysisSkill } from "./earnings-analysis";
import { financialDeepDiveSkill } from "./financial-deep-dive";
import { investmentThesisSkill } from "./investment-thesis";
import { multiComparisonSkill } from "./multi-comparison";
import { portfolioOptimizationSkill } from "./portfolio-optimization";
import { mfAnalysisSkill } from "./mf-analysis";
import { globalFundComparisonSkill } from "./global-fund-comparison";
import { macroAnalysisSkill } from "./macro-analysis";

// MONEY-498 - 16 v2 institutional skills (promoted from skill-tool-map
// allowlists to first-class trigger-matchable skills). dcfValuationSkill is
// imported above (./dcf-valuation-v2).
import { fundamentalsCoreSkill } from "./fundamentals-core";
import { cashFlowQualitySkill } from "./cash-flow-quality";
import { earningsDeepDiveSkill } from "./earnings-deep-dive";
import { dividendIncomeSkill } from "./dividend-income";
import { relativeValuationSkill } from "./relative-valuation";
import { quantFactorScoresSkill } from "./quant-factor-scores";
import { technicalTrendSkill } from "./technical-trend";
import { chartPatternDetectionSkill } from "./chart-pattern-detection";
import { regimeVolatilitySkill } from "./regime-volatility";
import { macroSensitivitiesSkill } from "./macro-sensitivities";
import { flowsAndPositioningSkill } from "./flows-and-positioning";
import { forwardScenariosSkill } from "./forward-scenarios";
import { riskPortfolioImpactSkill } from "./risk-portfolio-impact";
import { governanceFlagsSkill } from "./governance-flags";
import { newsSentimentCatalystsSkill } from "./news-sentiment-catalysts";
// MONEY-550 - comparison v2: MF comparison (programmatic routing, like multi-comparison).
import { mfComparisonSkill } from "./mf-comparison";

export type { ResearchSkill } from "./types";
export { fetchTask, computeTask, synthesisTask } from "./types";

/**
 * MONEY-498 - the 16 institutional skills, in cluster order. Registered
 * BEFORE the v1 skills so their (specific) triggers win; a bare "analyze TCS"
 * still falls through to the generic stockAnalysisSkill.
 */
const V2_INSTITUTIONAL_SKILLS: ResearchSkill[] = [
  fundamentalsCoreSkill,
  cashFlowQualitySkill,
  earningsDeepDiveSkill,
  dcfValuationSkill, // v2
  dividendIncomeSkill,
  relativeValuationSkill,
  quantFactorScoresSkill,
  technicalTrendSkill,
  chartPatternDetectionSkill,
  regimeVolatilitySkill,
  macroSensitivitiesSkill,
  flowsAndPositioningSkill,
  forwardScenariosSkill,
  riskPortfolioImpactSkill,
  governanceFlagsSkill,
  newsSentimentCatalystsSkill,
];

const ALL_SKILLS: ResearchSkill[] = [
  // MONEY-498 - institutional skills first (specific triggers win).
  ...V2_INSTITUTIONAL_SKILLS,
  strategyAnalysisSkill, // Before stock-analysis so strategy triggers take priority
  earningsAnalysisSkill, // Before stock-analysis so earnings triggers take priority
  financialDeepDiveSkill, // Before stock-analysis so financial triggers take priority
  investmentThesisSkill, // Before stock-analysis so thesis triggers take priority
  shareholdingAnalysisSkill, // Before stock-analysis so shareholding triggers win
  stockAnalysisSkill,
  peerComparisonSkill,
  // dcfValuationSkill (v2) lives in V2_INSTITUTIONAL_SKILLS above.
  sectorDeepDiveSkill, // Before sector-analysis so deep-dive/rotation triggers take priority
  sectorAnalysisSkill,
  stockScreenerSkill,
  portfolioAnalysisSkill,
  stockRiskAnalysisSkill, // Before portfolio-risk so single-stock-risk triggers win
  portfolioRiskAnalysisSkill,
  taxAnalysisSkill,
  multiComparisonSkill,
  mfComparisonSkill, // MONEY-550 - MF comparison (programmatic)
  portfolioOptimizationSkill,
  mfAnalysisSkill,
  globalFundComparisonSkill,
  macroAnalysisSkill,
];

const SKILL_MAP = new Map<string, ResearchSkill>(
  ALL_SKILLS.map((s) => [s.name, s]),
);

/**
 * Get a skill by name
 */
export function getSkill(name: string): ResearchSkill | undefined {
  return SKILL_MAP.get(name);
}

/**
 * Get all registered skills
 */
export function getAllSkills(): ResearchSkill[] {
  return ALL_SKILLS;
}

/**
 * Match a user query to a skill using trigger patterns
 */
export function matchSkill(query: string): ResearchSkill | undefined {
  for (const skill of ALL_SKILLS) {
    for (const trigger of skill.triggers) {
      if (trigger.test(query)) {
        return skill;
      }
    }
  }
  return undefined;
}
