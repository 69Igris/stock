/**
 * Financial Health Score Calculator
 *
 * Composite 0-100 score from profitability, leverage, liquidity, efficiency, and growth.
 * Supports sector-normalized benchmarks for accurate cross-sector comparison.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { HealthScore } from "../types";
import { anySectorKeyMatches } from "@usemoney/core/sector-key-match";

interface MetricDetail {
  score: number;
  metric: string;
  value: number;
  benchmark: number;
}

// Sector-specific benchmarks for Indian markets
const SECTOR_BENCHMARKS: Record<
  string,
  {
    roe: number;
    roa: number;
    operatingMargin: number;
    netMargin: number;
    debtToEquity: number;
    currentRatio: number;
    interestCoverage?: number;
  }
> = {
  banking: {
    roe: 0.12,
    roa: 0.01,
    operatingMargin: 0.3,
    netMargin: 0.2,
    debtToEquity: 8.0, // Banks are inherently leveraged
    currentRatio: 1.0,
    interestCoverage: 1.5,
  },
  it: {
    roe: 0.25,
    roa: 0.15,
    operatingMargin: 0.22,
    netMargin: 0.18,
    debtToEquity: 0.2,
    currentRatio: 2.0,
  },
  fmcg: {
    roe: 0.3,
    roa: 0.15,
    operatingMargin: 0.2,
    netMargin: 0.15,
    debtToEquity: 0.3,
    currentRatio: 1.5,
  },
  pharma: {
    roe: 0.15,
    roa: 0.08,
    operatingMargin: 0.18,
    netMargin: 0.12,
    debtToEquity: 0.5,
    currentRatio: 1.8,
  },
  auto: {
    roe: 0.15,
    roa: 0.07,
    operatingMargin: 0.12,
    netMargin: 0.08,
    debtToEquity: 0.8,
    currentRatio: 1.2,
  },
  metals: {
    roe: 0.12,
    roa: 0.06,
    operatingMargin: 0.15,
    netMargin: 0.08,
    debtToEquity: 1.2,
    currentRatio: 1.2,
    interestCoverage: 3.0,
  },
  realestate: {
    roe: 0.1,
    roa: 0.04,
    operatingMargin: 0.2,
    netMargin: 0.1,
    debtToEquity: 1.5,
    currentRatio: 1.3,
    interestCoverage: 2.0,
  },
  energy: {
    roe: 0.15,
    roa: 0.08,
    operatingMargin: 0.15,
    netMargin: 0.08,
    debtToEquity: 0.8,
    currentRatio: 1.2,
  },
  default: {
    roe: 0.15,
    roa: 0.05,
    operatingMargin: 0.15,
    netMargin: 0.1,
    debtToEquity: 1.0,
    currentRatio: 1.5,
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scoreMetric(
  value: number | undefined,
  benchmark: number,
  higherIsBetter: boolean,
  weight = 1,
): { score: number; value: number } {
  if (value == null || isNaN(value)) return { score: 50, value: 0 };
  const ratio = value / benchmark;
  let raw: number;
  if (higherIsBetter) {
    raw = clamp(ratio * 100, 0, 100);
  } else {
    raw = clamp((2 - ratio) * 50, 0, 100);
  }
  return { score: Math.round(raw * weight), value };
}

/**
 * Map a free-text sector name onto the benchmark bucket used for grading.
 *
 * MONEY-1093: this used to lower-case AND STRIP punctuation
 * (`replace(/[^a-z]/g, "")`), then test `lower.includes("it")` — so
 * "utilities" and "commodities" both graded as INFORMATION TECHNOLOGY, against
 * IT benchmarks (ROE 25%, D/E 0.2). A Tata Power or Tata Steel holding was
 * scored against the wrong industry norms and the report said so with
 * confidence.
 *
 * Two things changed. The keyword test is now word-boundary aware
 * (`sectorKeyMatches`), and the name is passed in RAW: stripping non-letters
 * turns "Information Technology" into "informationtechnology", which destroys
 * the boundaries the matcher needs — the canonical spelling of the sector this
 * bucket exists for would have stopped matching.
 *
 * Order matters: "metals" is tested before "energy" so "Metals & Commodities"
 * does not fall to a coal/power keyword, and the realestate bucket comes before
 * "construct" can be claimed elsewhere.
 */
function normalizeSector(sector: string): string {
  const raw = typeof sector === "string" ? sector : "";
  const hit = (...keys: string[]) => anySectorKeyMatches(raw, keys);

  if (hit("bank", "financ", "nbfc")) return "banking";
  if (hit("software", "tech", "it")) return "it";
  if (hit("fmcg", "consumer")) return "fmcg";
  if (hit("pharma", "health", "drug")) return "pharma";
  if (hit("auto", "vehicle")) return "auto";
  if (hit("metal", "steel", "mining", "commodit")) return "metals";
  if (hit("real", "estate", "realty", "construct")) return "realestate";
  if (hit("energy", "oil", "gas", "power", "utilit")) return "energy";
  return "default";
}

export const computeHealthScoreTool: ResearchToolDef = {
  name: "compute_health_score",
  description:
    "Calculate composite financial health score (0-100) with sector-normalized benchmarks",
  category: "computation",
  parameters: {
    roe: { type: "number", description: "Return on Equity (decimal)" },
    roa: { type: "number", description: "Return on Assets (decimal)" },
    operatingMargin: {
      type: "number",
      description: "Operating margin (decimal)",
    },
    netMargin: { type: "number", description: "Net margin (decimal)" },
    debtToEquity: { type: "number", description: "Debt to equity ratio" },
    currentRatio: { type: "number", description: "Current ratio" },
    revenueGrowth: { type: "number", description: "Revenue growth (decimal)" },
    earningsGrowth: {
      type: "number",
      description: "Earnings growth (decimal)",
    },
    sector: {
      type: "string",
      description: "Industry sector for benchmark normalization",
    },
    interestCoverage: {
      type: "number",
      description: "Interest coverage ratio (EBIT / Interest expense)",
    },
    cfToNetIncome: {
      type: "number",
      description: "Operating CF / Net Income ratio (cash flow quality)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const sector = normalizeSector((params.sector as string) || "");
      const benchmarks =
        SECTOR_BENCHMARKS[sector] || SECTOR_BENCHMARKS.default!;
      const details: Record<string, MetricDetail> = {};

      // Profitability (weight: 25%)
      const roe = scoreMetric(
        params.roe as number | undefined,
        benchmarks.roe,
        true,
      );
      details.roe = {
        score: roe.score,
        metric: "ROE",
        value: roe.value,
        benchmark: benchmarks.roe,
      };

      const netMargin = scoreMetric(
        params.netMargin as number | undefined,
        benchmarks.netMargin,
        true,
      );
      details.netMargin = {
        score: netMargin.score,
        metric: "Net Margin",
        value: netMargin.value,
        benchmark: benchmarks.netMargin,
      };

      const opMargin = scoreMetric(
        params.operatingMargin as number | undefined,
        benchmarks.operatingMargin,
        true,
      );
      details.operatingMargin = {
        score: opMargin.score,
        metric: "Operating Margin",
        value: opMargin.value,
        benchmark: benchmarks.operatingMargin,
      };

      const profitability = Math.round(
        (roe.score + netMargin.score + opMargin.score) / 3,
      );

      // Leverage (weight: 20%)
      const de = scoreMetric(
        params.debtToEquity as number | undefined,
        benchmarks.debtToEquity,
        false,
      );
      details.debtToEquity = {
        score: de.score,
        metric: "Debt/Equity",
        value: de.value,
        benchmark: benchmarks.debtToEquity,
      };

      // Interest coverage for debt-heavy sectors
      let interestCoverageScore = 50;
      if (params.interestCoverage != null) {
        const icBenchmark = benchmarks.interestCoverage || 3.0;
        const ic = scoreMetric(
          params.interestCoverage as number,
          icBenchmark,
          true,
        );
        interestCoverageScore = ic.score;
        details.interestCoverage = {
          score: ic.score,
          metric: "Interest Coverage",
          value: ic.value,
          benchmark: icBenchmark,
        };
      }

      const leverage = Math.round((de.score + interestCoverageScore) / 2);

      // Liquidity (weight: 15%)
      const cr = scoreMetric(
        params.currentRatio as number | undefined,
        benchmarks.currentRatio,
        true,
      );
      details.currentRatio = {
        score: cr.score,
        metric: "Current Ratio",
        value: cr.value,
        benchmark: benchmarks.currentRatio,
      };
      const liquidity = cr.score;

      // Efficiency (weight: 15%)
      const roa = scoreMetric(
        params.roa as number | undefined,
        benchmarks.roa,
        true,
      );
      details.roa = {
        score: roa.score,
        metric: "ROA",
        value: roa.value,
        benchmark: benchmarks.roa,
      };

      // Cash flow quality dimension
      let cfScore = 50;
      if (params.cfToNetIncome != null) {
        const cf = scoreMetric(params.cfToNetIncome as number, 1.0, true);
        cfScore = cf.score;
        details.cfToNetIncome = {
          score: cf.score,
          metric: "CF/NI Ratio",
          value: cf.value,
          benchmark: 1.0,
        };
      }

      const efficiency = Math.round((roa.score + cfScore) / 2);

      // Growth (weight: 15%)
      const revGrowth = scoreMetric(
        params.revenueGrowth as number | undefined,
        0.1,
        true,
      );
      details.revenueGrowth = {
        score: revGrowth.score,
        metric: "Revenue Growth",
        value: revGrowth.value,
        benchmark: 0.1,
      };

      const earnGrowth = scoreMetric(
        params.earningsGrowth as number | undefined,
        0.1,
        true,
      );
      details.earningsGrowth = {
        score: earnGrowth.score,
        metric: "Earnings Growth",
        value: earnGrowth.value,
        benchmark: 0.1,
      };

      const growth = Math.round((revGrowth.score + earnGrowth.score) / 2);

      // Weighted overall score
      const overall = Math.round(
        profitability * 0.25 +
          leverage * 0.2 +
          liquidity * 0.15 +
          efficiency * 0.15 +
          growth * 0.15,
      );

      const result: HealthScore = {
        overall: clamp(overall, 0, 100),
        profitability,
        leverage,
        liquidity,
        efficiency,
        growth,
        details,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Health score computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
