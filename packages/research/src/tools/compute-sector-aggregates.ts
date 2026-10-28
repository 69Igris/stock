/**
 * Sector Aggregates - Compute sector-level metrics from constituent stocks
 *
 * Weighted averages (by market cap), simple averages, medians,
 * sector health score, top/bottom performers, and concentration analysis.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { insufficientInput } from "./insufficient-input";

interface StockInput {
  symbol: string;
  name?: string;
  pe?: number;
  pb?: number;
  roe?: number;
  roce?: number;
  marketCap: number;
  revGrowth?: number;
  debtToEquity?: number;
  netMargin?: number;
  operatingMargin?: number;
  dividendYield?: number;
}

interface MetricAggregates {
  weightedAvg: number | null;
  simpleAvg: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

interface PerformerEntry {
  symbol: string;
  name: string;
  score: number;
  highlights: string[];
}

interface SectorAggregatesResult {
  stockCount: number;
  totalMarketCap: number;
  metrics: {
    pe: MetricAggregates;
    pb: MetricAggregates;
    roe: MetricAggregates;
    roce: MetricAggregates;
    revGrowth: MetricAggregates;
    debtToEquity: MetricAggregates;
    netMargin: MetricAggregates;
    operatingMargin: MetricAggregates;
    dividendYield: MetricAggregates;
  };
  healthScore: number;
  healthVerdict: string;
  topPerformers: PerformerEntry[];
  bottomPerformers: PerformerEntry[];
  concentration: {
    top3Share: number;
    top5Share: number;
    hhi: number;
    verdict: string;
  };
  summary: string;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function computeMetricAggregates(
  stocks: StockInput[],
  key: keyof StockInput,
  totalMarketCap: number,
  filterPositive: boolean = false,
): MetricAggregates {
  let values = stocks
    .map((s) => ({ val: s[key] as number | undefined, cap: s.marketCap }))
    .filter((v) => v.val != null && isFinite(v.val as number));

  if (filterPositive) {
    values = values.filter((v) => (v.val as number) > 0);
  }

  if (values.length === 0) {
    return {
      weightedAvg: null,
      simpleAvg: null,
      median: null,
      min: null,
      max: null,
      count: 0,
    };
  }

  const nums = values.map((v) => v.val as number);
  const simpleAvg = nums.reduce((a, b) => a + b, 0) / nums.length;
  const med = median(nums);

  // Market cap weighted average
  let weightedSum = 0;
  let weightTotal = 0;
  for (const v of values) {
    const cap = v.cap > 0 ? v.cap : 1;
    weightedSum += (v.val as number) * cap;
    weightTotal += cap;
  }
  const weightedAvg = weightTotal > 0 ? weightedSum / weightTotal : simpleAvg;

  return {
    weightedAvg: Math.round(weightedAvg * 100) / 100,
    simpleAvg: Math.round(simpleAvg * 100) / 100,
    median: Math.round(med * 100) / 100,
    min: Math.round(Math.min(...nums) * 100) / 100,
    max: Math.round(Math.max(...nums) * 100) / 100,
    count: nums.length,
  };
}

function scoreStock(stock: StockInput): {
  score: number;
  highlights: string[];
} {
  let score = 50;
  const highlights: string[] = [];

  // ROE
  if (stock.roe != null) {
    if (stock.roe > 20) {
      score += 15;
      highlights.push(`Strong ROE: ${stock.roe}%`);
    } else if (stock.roe > 12) {
      score += 8;
    } else if (stock.roe < 5) {
      score -= 10;
      highlights.push(`Low ROE: ${stock.roe}%`);
    }
  }

  // ROCE
  if (stock.roce != null) {
    if (stock.roce > 20) {
      score += 10;
      highlights.push(`Strong ROCE: ${stock.roce}%`);
    } else if (stock.roce < 8) {
      score -= 8;
    }
  }

  // Revenue growth
  if (stock.revGrowth != null) {
    if (stock.revGrowth > 20) {
      score += 15;
      highlights.push(`High growth: ${stock.revGrowth}%`);
    } else if (stock.revGrowth > 10) {
      score += 8;
    } else if (stock.revGrowth < 0) {
      score -= 12;
      highlights.push(`Negative growth: ${stock.revGrowth}%`);
    }
  }

  // Debt
  if (stock.debtToEquity != null) {
    if (stock.debtToEquity < 0.3) {
      score += 8;
      highlights.push("Low debt");
    } else if (stock.debtToEquity > 1.5) {
      score -= 10;
      highlights.push(`High debt: D/E ${stock.debtToEquity}`);
    }
  }

  // PE valuation
  if (stock.pe != null && stock.pe > 0) {
    if (stock.pe < 15) {
      score += 5;
    } else if (stock.pe > 60) {
      score -= 5;
    }
  }

  return { score: Math.max(0, Math.min(100, score)), highlights };
}

export const computeSectorAggregatesTool: ResearchToolDef = {
  name: "compute_sector_aggregates",
  description:
    "Compute sector-level aggregates - weighted/simple averages, medians, health score, top/bottom performers, concentration analysis",
  category: "computation",
  parameters: {
    stocks: {
      type: "array",
      description:
        "Array of { symbol, name?, pe?, pb?, roe?, roce?, marketCap, revGrowth?, debtToEquity?, netMargin?, operatingMargin?, dividendYield? }",
      required: true,
    },
  },
  cacheTTL: 1800,
  execute: async (params): Promise<ToolOutput> => {
    const stocks = params.stocks as StockInput[] | undefined;

    if (!stocks || !Array.isArray(stocks)) {
      return { success: false, error: "stocks array is required" };
    }
    if (stocks.length === 0) {
      return insufficientInput(
        "stocks array with at least 1 entry is required",
        { needed: "1 stock", got: 0 },
      );
    }

    try {
      // Filter to stocks with positive market cap
      const validStocks = stocks.filter((s) => s.marketCap > 0);
      if (validStocks.length === 0) {
        return {
          success: false,
          error: "No stocks with valid market cap found",
        };
      }

      const totalMarketCap = validStocks.reduce(
        (sum, s) => sum + s.marketCap,
        0,
      );

      // Compute aggregates for each metric
      const metrics = {
        pe: computeMetricAggregates(validStocks, "pe", totalMarketCap, true),
        pb: computeMetricAggregates(validStocks, "pb", totalMarketCap, true),
        roe: computeMetricAggregates(validStocks, "roe", totalMarketCap),
        roce: computeMetricAggregates(validStocks, "roce", totalMarketCap),
        revGrowth: computeMetricAggregates(
          validStocks,
          "revGrowth",
          totalMarketCap,
        ),
        debtToEquity: computeMetricAggregates(
          validStocks,
          "debtToEquity",
          totalMarketCap,
        ),
        netMargin: computeMetricAggregates(
          validStocks,
          "netMargin",
          totalMarketCap,
        ),
        operatingMargin: computeMetricAggregates(
          validStocks,
          "operatingMargin",
          totalMarketCap,
        ),
        dividendYield: computeMetricAggregates(
          validStocks,
          "dividendYield",
          totalMarketCap,
        ),
      };

      // Score each stock and sort
      const scored = validStocks.map((s) => {
        const { score, highlights } = scoreStock(s);
        return {
          symbol: s.symbol,
          name: s.name || s.symbol,
          score,
          highlights,
        };
      });
      scored.sort((a, b) => b.score - a.score);

      const topPerformers = scored.slice(0, 5);
      const bottomPerformers = scored.slice(-5).reverse();

      // Concentration analysis
      const sortedByCap = [...validStocks].sort(
        (a, b) => b.marketCap - a.marketCap,
      );
      const top3Cap = sortedByCap
        .slice(0, 3)
        .reduce((sum, s) => sum + s.marketCap, 0);
      const top5Cap = sortedByCap
        .slice(0, 5)
        .reduce((sum, s) => sum + s.marketCap, 0);
      const top3Share = Math.round((top3Cap / totalMarketCap) * 10000) / 100;
      const top5Share = Math.round((top5Cap / totalMarketCap) * 10000) / 100;

      // HHI from market cap shares
      const capShares = validStocks.map(
        (s) => (s.marketCap / totalMarketCap) * 100,
      );
      const hhi = Math.round(capShares.reduce((sum, s) => sum + s * s, 0));

      let concentrationVerdict: string;
      if (hhi > 2500) {
        concentrationVerdict =
          "Highly concentrated - dominated by a few large players";
      } else if (hhi > 1500) {
        concentrationVerdict = "Moderately concentrated";
      } else {
        concentrationVerdict = "Well distributed - competitive sector";
      }

      // Health score (0-100) from metric quality
      let healthScore = 50;

      // ROE quality
      if (metrics.roe.median != null) {
        if (metrics.roe.median > 15) healthScore += 12;
        else if (metrics.roe.median > 10) healthScore += 6;
        else if (metrics.roe.median < 5) healthScore -= 8;
      }

      // Growth quality
      if (metrics.revGrowth.median != null) {
        if (metrics.revGrowth.median > 15) healthScore += 12;
        else if (metrics.revGrowth.median > 8) healthScore += 6;
        else if (metrics.revGrowth.median < 0) healthScore -= 10;
      }

      // Debt quality
      if (metrics.debtToEquity.median != null) {
        if (metrics.debtToEquity.median < 0.5) healthScore += 8;
        else if (metrics.debtToEquity.median > 1.5) healthScore -= 8;
      }

      // Margin quality
      if (metrics.netMargin.median != null) {
        if (metrics.netMargin.median > 15) healthScore += 8;
        else if (metrics.netMargin.median > 8) healthScore += 4;
        else if (metrics.netMargin.median < 0) healthScore -= 10;
      }

      // Valuation reasonableness
      if (metrics.pe.median != null) {
        if (metrics.pe.median > 50) healthScore -= 5;
        if (metrics.pe.median < 10) healthScore += 5;
      }

      healthScore = Math.max(0, Math.min(100, healthScore));

      let healthVerdict: string;
      if (healthScore >= 75) {
        healthVerdict =
          "Strong sector fundamentals - high profitability and growth";
      } else if (healthScore >= 55) {
        healthVerdict = "Healthy sector with reasonable fundamentals";
      } else if (healthScore >= 35) {
        healthVerdict = "Mixed sector health - some structural concerns";
      } else {
        healthVerdict = "Weak sector fundamentals - caution advised";
      }

      // Summary
      const summary =
        `Sector analysis of ${validStocks.length} stocks (total market cap: ${formatMarketCap(totalMarketCap)}). ` +
        `Median PE: ${metrics.pe.median ?? "N/A"}, ROE: ${metrics.roe.median ?? "N/A"}%, ` +
        `Revenue Growth: ${metrics.revGrowth.median ?? "N/A"}%. ` +
        `Health Score: ${healthScore}/100. Top 3 stocks account for ${top3Share}% of sector market cap.`;

      const result: SectorAggregatesResult = {
        stockCount: validStocks.length,
        totalMarketCap,
        metrics,
        healthScore,
        healthVerdict,
        topPerformers,
        bottomPerformers,
        concentration: {
          top3Share,
          top5Share,
          hhi,
          verdict: concentrationVerdict,
        },
        summary,
      };

      return {
        success: true,
        data: result,
        metadata: { stockCount: validStocks.length, healthScore },
      };
    } catch (error) {
      return {
        success: false,
        error: `Sector aggregates computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function formatMarketCap(value: number): string {
  if (value >= 1e7) return `${Math.round(value / 1e5) / 100} Lakh Cr`;
  if (value >= 1e5) return `${Math.round(value / 1e3) / 100} Thousand Cr`;
  if (value >= 100) return `${Math.round(value * 100) / 100} Cr`;
  return `${Math.round(value * 100) / 100}`;
}
