/**
 * MONEY-457: Deterministic per-stock comparison scoring.
 *
 * Replaces the LLM-emitted `stockScores` / `perStockBreakdown` numbers that
 * flipped between runs of the same comparison (e.g. ABB scored 82 in one
 * run and 64 in the next with the same data). Scores here are produced by
 * fixed thresholds + peer-relative ranks, so identical input → identical
 * output, every time.
 *
 * Two interfaces:
 *   1. `computeComparisonScores(stocks)` — pure function called directly
 *      from `compare-stocks.ts` to override LLM-emitted scores.
 *   2. `computeComparisonScoresTool` — `ResearchToolDef` registration so
 *      the planner can include it as an explicit task (useful when the
 *      synthesizer is delegated to via the standard plan→synthesize path
 *      instead of the bespoke compare-stocks call).
 *
 * The 7-criterion breakdown matches the existing single-stock scoreBreakdown
 * shape (Valuation /20, Profitability /20, Growth /15, Balance Sheet /15,
 * Earnings Quality /10, Momentum & Technicals /10, Ownership & Governance
 * /10 → 100) so the renderer's per-stock chart picks it up without changes.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { insufficientInput } from "./insufficient-input";

// ─── Public types ────────────────────────────────────────────

export interface ComparisonStockMetrics {
  symbol: string;
  /** Trailing-twelve-month PE. Lower is cheaper. */
  pe?: number;
  /** Price-to-Book. Lower is cheaper. */
  pb?: number;
  /** Return on Equity, %. Higher is better. */
  roe?: number;
  /** Return on Capital Employed, %. Higher is better. */
  roce?: number;
  /** Net profit margin, %. */
  netMargin?: number;
  /** Operating margin, %. */
  operatingMargin?: number;
  /** Revenue CAGR over last 3 fiscals, %. Higher is better. */
  revenueCagr3y?: number;
  /** Latest YoY revenue growth, %. */
  revenueGrowthYoY?: number;
  /** Trailing EPS growth %. */
  epsGrowth?: number;
  /** Debt / Equity multiple. Lower is safer. */
  debtEquity?: number;
  /** Current ratio (current assets / current liabilities). >1 is healthy. */
  currentRatio?: number;
  /** Interest coverage ratio. */
  interestCoverage?: number;
  /** Operating CF / Net Income. >1 indicates earnings backed by cash. */
  cfNiRatio?: number;
  /** Accrual ratio (lower is better). */
  accrualRatio?: number;
  /** RSI(14) latest reading. 30-70 is normal range. */
  rsi?: number;
  /** ADX strength. >25 indicates trending. */
  adx?: number;
  /** Price position vs SMA200: "above" | "below" | "near" */
  sma200Position?: "above" | "below" | "near";
  /** Promoter holding %. */
  promoterHolding?: number;
  /** Quarter-over-quarter change in promoter holding (%). +ve = rising. */
  promoterHoldingChange?: number;
  /** Promoter pledge as % of holding. 0 is best. */
  promoterPledge?: number;
  /** FII / DII recent trend: "rising" | "flat" | "falling" */
  institutionalTrend?: "rising" | "flat" | "falling";
}

export interface PerStockBreakdown {
  symbol: string;
  totalScore: number;
  criteria: Array<{
    criterion: string;
    score: number;
    maxScore: number;
    comment: string;
  }>;
}

export interface ComparisonScoresResult {
  stockScores: Array<{ symbol: string; score: number }>;
  perStockBreakdown: PerStockBreakdown[];
}

// ─── Scoring helpers ─────────────────────────────────────────

const fmt = (v: number | undefined, digits = 2): string =>
  v === undefined ? "n/a" : Number.isFinite(v) ? v.toFixed(digits) : "n/a";

const median = (values: number[]): number | undefined => {
  const sorted = values
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
};

/**
 * Score Valuation /20 — peer-relative on PE (lower is better). If PE is
 * missing, fall back to mid-range (10/20) with a data-gap note.
 */
function scoreValuation(
  m: ComparisonStockMetrics,
  peerMedianPe: number | undefined,
): { score: number; comment: string } {
  if (m.pe === undefined || !peerMedianPe) {
    return {
      score: 10,
      comment: `PE data unavailable — neutral midpoint score`,
    };
  }
  const ratio = m.pe / peerMedianPe;
  // Lower ratio = cheaper = more points.
  let score: number;
  let bandLabel: string;
  if (ratio < 0.7) {
    score = 18;
    bandLabel = "deep discount";
  } else if (ratio < 0.85) {
    score = 15;
    bandLabel = "discount";
  } else if (ratio < 1.15) {
    score = 10;
    bandLabel = "in line";
  } else if (ratio < 1.35) {
    score = 5;
    bandLabel = "premium";
  } else {
    score = 2;
    bandLabel = "rich premium";
  }
  return {
    score,
    comment: `PE ${fmt(m.pe, 1)}x vs peer median ${fmt(peerMedianPe, 1)}x — ${bandLabel}`,
  };
}

/**
 * Profitability /20 — absolute on ROE (12 pts) + Net Margin (8 pts).
 */
function scoreProfitability(m: ComparisonStockMetrics): {
  score: number;
  comment: string;
} {
  let roePts = 0;
  if (m.roe !== undefined) {
    if (m.roe >= 20) roePts = 12;
    else if (m.roe >= 15) roePts = 9;
    else if (m.roe >= 10) roePts = 6;
    else if (m.roe >= 5) roePts = 3;
    else roePts = 0;
  } else {
    roePts = 5; // mid-range
  }
  let nmPts = 0;
  if (m.netMargin !== undefined) {
    if (m.netMargin >= 15) nmPts = 8;
    else if (m.netMargin >= 10) nmPts = 6;
    else if (m.netMargin >= 5) nmPts = 4;
    else if (m.netMargin >= 0) nmPts = 2;
    else nmPts = 0;
  } else {
    nmPts = 4; // mid-range
  }
  const score = roePts + nmPts;
  const parts: string[] = [];
  if (m.roe !== undefined) parts.push(`ROE ${fmt(m.roe, 1)}%`);
  if (m.netMargin !== undefined)
    parts.push(`Net Margin ${fmt(m.netMargin, 1)}%`);
  if (parts.length === 0) parts.push("profitability data partial");
  return { score, comment: parts.join(", ") };
}

/**
 * Growth /15 — Revenue CAGR (8 pts) + EPS growth (7 pts).
 */
function scoreGrowth(m: ComparisonStockMetrics): {
  score: number;
  comment: string;
} {
  const revGrowth = m.revenueCagr3y ?? m.revenueGrowthYoY;
  let revPts = 0;
  if (revGrowth !== undefined) {
    if (revGrowth >= 20) revPts = 8;
    else if (revGrowth >= 15) revPts = 6;
    else if (revGrowth >= 10) revPts = 4;
    else if (revGrowth >= 5) revPts = 2;
    else revPts = 0;
  } else {
    revPts = 3;
  }
  let epsPts = 0;
  if (m.epsGrowth !== undefined) {
    if (m.epsGrowth >= 25) epsPts = 7;
    else if (m.epsGrowth >= 15) epsPts = 5;
    else if (m.epsGrowth >= 5) epsPts = 3;
    else if (m.epsGrowth >= 0) epsPts = 1;
    else epsPts = 0;
  } else {
    epsPts = 3;
  }
  const parts: string[] = [];
  if (revGrowth !== undefined)
    parts.push(`Revenue growth ${fmt(revGrowth, 1)}%`);
  if (m.epsGrowth !== undefined)
    parts.push(`EPS growth ${fmt(m.epsGrowth, 1)}%`);
  if (parts.length === 0) parts.push("growth data partial");
  return { score: revPts + epsPts, comment: parts.join(", ") };
}

/**
 * Balance Sheet /15 — D/E (10 pts) + Current Ratio (5 pts).
 */
function scoreBalanceSheet(m: ComparisonStockMetrics): {
  score: number;
  comment: string;
} {
  let dePts = 0;
  if (m.debtEquity !== undefined) {
    if (m.debtEquity < 0.3) dePts = 10;
    else if (m.debtEquity < 0.6) dePts = 7;
    else if (m.debtEquity < 1.0) dePts = 4;
    else if (m.debtEquity < 1.5) dePts = 2;
    else dePts = 0;
  } else {
    dePts = 5;
  }
  let crPts = 0;
  if (m.currentRatio !== undefined) {
    if (m.currentRatio >= 2.0) crPts = 5;
    else if (m.currentRatio >= 1.5) crPts = 4;
    else if (m.currentRatio >= 1.2) crPts = 3;
    else if (m.currentRatio >= 1.0) crPts = 2;
    else crPts = 0;
  } else {
    crPts = 3;
  }
  const parts: string[] = [];
  if (m.debtEquity !== undefined) parts.push(`D/E ${fmt(m.debtEquity, 2)}x`);
  if (m.currentRatio !== undefined)
    parts.push(`Current ratio ${fmt(m.currentRatio, 2)}`);
  if (parts.length === 0) parts.push("balance sheet data partial");
  return { score: dePts + crPts, comment: parts.join(", ") };
}

/**
 * Earnings Quality /10 — CF/NI (6 pts) + Accrual (4 pts).
 */
function scoreEarningsQuality(m: ComparisonStockMetrics): {
  score: number;
  comment: string;
} {
  let cfniPts = 0;
  if (m.cfNiRatio !== undefined) {
    if (m.cfNiRatio >= 1.2) cfniPts = 6;
    else if (m.cfNiRatio >= 1.0) cfniPts = 5;
    else if (m.cfNiRatio >= 0.8) cfniPts = 3;
    else if (m.cfNiRatio >= 0.5) cfniPts = 1;
    else cfniPts = 0;
  } else {
    cfniPts = 3;
  }
  let accPts = 0;
  if (m.accrualRatio !== undefined) {
    if (m.accrualRatio < 0.05) accPts = 4;
    else if (m.accrualRatio < 0.1) accPts = 3;
    else if (m.accrualRatio < 0.15) accPts = 2;
    else if (m.accrualRatio < 0.25) accPts = 1;
    else accPts = 0;
  } else {
    accPts = 2;
  }
  const parts: string[] = [];
  if (m.cfNiRatio !== undefined) parts.push(`CF/NI ${fmt(m.cfNiRatio, 2)}`);
  if (m.accrualRatio !== undefined)
    parts.push(`Accrual ${fmt(m.accrualRatio, 3)}`);
  if (parts.length === 0) parts.push("earnings-quality data partial");
  return { score: cfniPts + accPts, comment: parts.join(", ") };
}

/**
 * Momentum & Technicals /10 — Price vs SMA200 (4) + RSI band (3) + ADX (3).
 */
function scoreMomentum(m: ComparisonStockMetrics): {
  score: number;
  comment: string;
} {
  let smaPts = 0;
  if (m.sma200Position === "above") smaPts = 4;
  else if (m.sma200Position === "near") smaPts = 2;
  else if (m.sma200Position === "below") smaPts = 0;
  else smaPts = 2;
  let rsiPts = 0;
  if (m.rsi !== undefined) {
    if (m.rsi >= 50 && m.rsi <= 65) rsiPts = 3;
    else if ((m.rsi > 65 && m.rsi <= 75) || (m.rsi >= 35 && m.rsi < 50))
      rsiPts = 2;
    else if (m.rsi >= 25 && m.rsi < 35) rsiPts = 1;
    else rsiPts = 0;
  } else {
    rsiPts = 2;
  }
  let adxPts = 0;
  if (m.adx !== undefined) {
    if (m.adx >= 25) adxPts = 3;
    else if (m.adx >= 15) adxPts = 2;
    else adxPts = 1;
  } else {
    adxPts = 2;
  }
  const parts: string[] = [];
  if (m.sma200Position) parts.push(`Price ${m.sma200Position} SMA200`);
  if (m.rsi !== undefined) parts.push(`RSI ${fmt(m.rsi, 0)}`);
  if (m.adx !== undefined) parts.push(`ADX ${fmt(m.adx, 0)}`);
  if (parts.length === 0) parts.push("technical data partial");
  return { score: smaPts + rsiPts + adxPts, comment: parts.join(", ") };
}

/**
 * Ownership & Governance /10 — Promoter holding stability (5) + Institutional
 * trend (3) + Promoter pledge (2).
 */
function scoreOwnership(m: ComparisonStockMetrics): {
  score: number;
  comment: string;
} {
  let phPts = 0;
  if (m.promoterHoldingChange !== undefined) {
    if (m.promoterHoldingChange >= 0) phPts = 5;
    else if (m.promoterHoldingChange >= -1) phPts = 3;
    else if (m.promoterHoldingChange >= -3) phPts = 1;
    else phPts = 0;
  } else if (m.promoterHolding !== undefined) {
    if (m.promoterHolding >= 50) phPts = 4;
    else if (m.promoterHolding >= 30) phPts = 3;
    else phPts = 2;
  } else {
    phPts = 3;
  }
  let trendPts = 0;
  if (m.institutionalTrend === "rising") trendPts = 3;
  else if (m.institutionalTrend === "flat") trendPts = 2;
  else if (m.institutionalTrend === "falling") trendPts = 0;
  else trendPts = 1;
  let pledgePts = 0;
  if (m.promoterPledge !== undefined) {
    if (m.promoterPledge === 0) pledgePts = 2;
    else if (m.promoterPledge < 10) pledgePts = 1;
    else pledgePts = 0;
  } else {
    pledgePts = 1;
  }
  const parts: string[] = [];
  if (m.promoterHolding !== undefined)
    parts.push(`Promoter holding ${fmt(m.promoterHolding, 1)}%`);
  if (m.institutionalTrend) parts.push(`FII/DII ${m.institutionalTrend}`);
  if (m.promoterPledge !== undefined && m.promoterPledge > 0)
    parts.push(`Pledge ${fmt(m.promoterPledge, 1)}%`);
  if (parts.length === 0) parts.push("ownership data partial");
  return { score: phPts + trendPts + pledgePts, comment: parts.join(", ") };
}

// ─── Public scoring function ──────────────────────────────────

/**
 * Deterministic per-stock comparison scoring. Same inputs → same outputs,
 * every time. Use this to override LLM-emitted `stockScores` /
 * `perStockBreakdown` in the comparison report.
 */
export function computeComparisonScores(
  stocks: ComparisonStockMetrics[],
): ComparisonScoresResult {
  // Peer median PE for relative valuation scoring.
  const peerPes = stocks
    .map((s) => s.pe)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const peerMedianPe = median(peerPes);

  const perStockBreakdown: PerStockBreakdown[] = stocks.map((m) => {
    const v = scoreValuation(m, peerMedianPe);
    const p = scoreProfitability(m);
    const g = scoreGrowth(m);
    const b = scoreBalanceSheet(m);
    const e = scoreEarningsQuality(m);
    const t = scoreMomentum(m);
    const o = scoreOwnership(m);
    const total =
      v.score + p.score + g.score + b.score + e.score + t.score + o.score;
    return {
      symbol: m.symbol,
      totalScore: total,
      criteria: [
        {
          criterion: "Valuation",
          score: v.score,
          maxScore: 20,
          comment: v.comment,
        },
        {
          criterion: "Profitability",
          score: p.score,
          maxScore: 20,
          comment: p.comment,
        },
        {
          criterion: "Growth",
          score: g.score,
          maxScore: 15,
          comment: g.comment,
        },
        {
          criterion: "Balance Sheet",
          score: b.score,
          maxScore: 15,
          comment: b.comment,
        },
        {
          criterion: "Earnings Quality",
          score: e.score,
          maxScore: 10,
          comment: e.comment,
        },
        {
          criterion: "Momentum & Technicals",
          score: t.score,
          maxScore: 10,
          comment: t.comment,
        },
        {
          criterion: "Ownership & Governance",
          score: o.score,
          maxScore: 10,
          comment: o.comment,
        },
      ],
    };
  });

  return {
    stockScores: perStockBreakdown.map((s) => ({
      symbol: s.symbol,
      score: s.totalScore,
    })),
    perStockBreakdown,
  };
}

// ─── Tool registration ───────────────────────────────────────

export const computeComparisonScoresTool: ResearchToolDef = {
  name: "compute_comparison_scores",
  description:
    "Deterministically compute per-stock 7-criterion comparison scores from financial metrics. Same input → same output every time, eliminating LLM run-to-run variance in comparison rankings.",
  category: "computation",
  parameters: {
    stocks: {
      type: "object[]",
      description:
        "Array of per-stock metric objects: { symbol, pe?, roe?, netMargin?, debtEquity?, currentRatio?, cfNiRatio?, accrualRatio?, rsi?, sma200Position?, adx?, promoterHolding?, promoterPledge?, institutionalTrend? }. Missing fields default to mid-range scores.",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const stocks = params.stocks as ComparisonStockMetrics[] | undefined;
    if (!Array.isArray(stocks)) {
      // MONEY-1274 — CALLER error: the argument is absent or the wrong shape.
      // That is the planner's mistake, not a thin market, so it must FAIL the
      // task rather than tell the model the data was insufficient.
      return { success: false, error: "stocks array is required" };
    }
    if (stocks.length < 2) {
      return insufficientInput(
        "compute_comparison_scores requires at least 2 stocks",
        { needed: "2 stocks", got: stocks.length },
      );
    }
    try {
      const result = computeComparisonScores(stocks);
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Scoring failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
