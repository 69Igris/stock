/**
 * Portfolio Roast - Structured result types
 */

export interface RoastScoreBreakdown {
  score: number;
  comment: string;
}

export interface RoastHighlight {
  type: "burn" | "praise";
  emoji: string;
  title: string;
  description: string;
}

export interface RoastPerformer {
  symbol: string;
  pnlPercent: number;
  roast: string;
}

export interface RoastSectorAnalysis {
  sector: string;
  percentage: number;
  verdict: "overweight" | "underweight" | "fair";
  comment: string;
}

export interface RoastAdvice {
  title: string;
  description: string;
}

export interface StructuredRoastResult {
  overallScore: number;
  scoreBreakdown: {
    diversification: RoastScoreBreakdown;
    riskManagement: RoastScoreBreakdown;
    stockPicking: RoastScoreBreakdown;
    timing: RoastScoreBreakdown;
  };
  roastHighlights: RoastHighlight[];
  topPerformers: RoastPerformer[];
  worstPerformers: RoastPerformer[];
  sectorAnalysis: RoastSectorAnalysis[];
  constructiveAdvice: RoastAdvice[];
  roastNarrative: string;
  disclaimer: string;
}
