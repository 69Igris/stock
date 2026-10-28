/**
 * Step 6: Assemble Final Result
 *
 * Merges all step outputs into a StructuredRoastResult.
 * Pure computation - no LLM call.
 */

import type { StructuredRoastResult } from "@usemoney/types";
import type { PortfolioData, ScoresResult, RoastContentResult } from "../types";

export function assembleResult(
  scores: ScoresResult,
  roastContent: RoastContentResult,
  _portfolio: PortfolioData,
): StructuredRoastResult {
  return {
    overallScore: scores.overallScore,
    scoreBreakdown: scores.scoreBreakdown,
    roastHighlights: roastContent.roastHighlights,
    topPerformers: roastContent.topPerformers,
    worstPerformers: roastContent.worstPerformers,
    sectorAnalysis: roastContent.sectorAnalysis,
    constructiveAdvice: roastContent.constructiveAdvice,
    roastNarrative: roastContent.roastNarrative,
    disclaimer:
      "This is entertainment, not financial advice. Always consult a qualified financial advisor.",
  };
}
