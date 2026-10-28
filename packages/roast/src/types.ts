/**
 * @usemoney/roast - Types
 */

import type { RoastJobMessage } from "@usemoney/types";

export interface RoastAgentConfig {
  /** Timeout per LLM step in ms (default: 60000) */
  stepTimeoutMs?: number;
  /** Total timeout for the entire pipeline in ms (default: 300000) */
  totalTimeoutMs?: number;
}

export interface PortfolioData {
  holdings: StockHolding[];
  mfs: MfHolding[];
  summary: PortfolioSummary;
  /**
   * MONEY-837: present for TRADEBOOK-scoped roasts (the "specific trade" subset
   * — a broker/account, a date range and/or a set of symbols). Lets the roast
   * judge HOW the user traded, not just what they hold.
   */
  trades?: TradeRow[];
  tradeStats?: TradeStats;
}

export interface StockHolding {
  symbol: string;
  name: string | null;
  sector: string | null;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  brokerName: string | null;
}

export interface MfHolding {
  schemeName: string;
  category: string | null;
  units: number;
  averageNav: number;
  currentNav: number;
  investedAmount: number;
  currentValue: number;
  unrealizedGain: number | null;
  xirr: number;
  brokerName: string | null;
}

export interface TradeRow {
  symbol: string;
  tradeType: string; // BUY | SELL
  quantity: number;
  price: number;
  tradeValue: number;
  realizedPnL: number | null;
  tradeDate: Date;
}

export interface TradeStats {
  totalTrades: number;
  buys: number;
  sells: number;
  distinctSymbols: number;
  turnover: number;
  realizedPnL: number;
  winningTrades: number;
  losingTrades: number;
  topSymbols: Array<{ symbol: string; trades: number }>;
  firstTrade: Date | null;
  lastTrade: Date | null;
}

export interface PortfolioSummary {
  totalStockInvested: number;
  totalStockCurrent: number;
  totalMfInvested: number;
  totalMfCurrent: number;
  sectorConcentration: Array<{
    sector: string;
    value: number;
    percentage: number;
  }>;
  stockCount: number;
  mfCount: number;
}

export interface StockAnalysisResult {
  diversificationIssues: string[];
  sectorConcentration: Array<{
    sector: string;
    percentage: number;
    verdict: string;
  }>;
  topPicks: Array<{ symbol: string; reason: string }>;
  bottomPicks: Array<{ symbol: string; reason: string }>;
  riskFlags: string[];
}

export interface MfAnalysisResult {
  categoryOverlap: string[];
  performanceVerdict: string;
  expenseIssues: string[];
  mfHighlights: Array<{ scheme: string; verdict: string }>;
}

export interface ScoresResult {
  overallScore: number;
  scoreBreakdown: {
    diversification: { score: number; comment: string };
    riskManagement: { score: number; comment: string };
    stockPicking: { score: number; comment: string };
    timing: { score: number; comment: string };
  };
}

export interface RoastContentResult {
  roastHighlights: Array<{
    type: "burn" | "praise";
    emoji: string;
    title: string;
    description: string;
  }>;
  topPerformers: Array<{ symbol: string; pnlPercent: number; roast: string }>;
  worstPerformers: Array<{ symbol: string; pnlPercent: number; roast: string }>;
  sectorAnalysis: Array<{
    sector: string;
    percentage: number;
    verdict: "overweight" | "underweight" | "fair";
    comment: string;
  }>;
  constructiveAdvice: Array<{ title: string; description: string }>;
  roastNarrative: string;
}

export type { RoastJobMessage };
