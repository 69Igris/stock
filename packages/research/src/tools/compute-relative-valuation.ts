/**
 * Relative Valuation - 20+ metric peer comparison with percentile ranking
 *
 * Compares a stock against its peer group on valuation, profitability,
 * growth, financial health, and returns metrics. Provides percentile
 * ranking and flags significant deviations.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { insufficientInput } from "./insufficient-input";

interface PeerData {
  symbol: string;
  name?: string;
  pe?: number;
  pb?: number;
  evToEbitda?: number;
  peg?: number;
  priceToSales?: number;
  priceToFcf?: number;
  roe?: number;
  roa?: number;
  roce?: number;
  operatingMargin?: number;
  netMargin?: number;
  grossMargin?: number;
  revenueGrowth?: number;
  epsGrowth?: number;
  ebitdaGrowth?: number;
  debtToEquity?: number;
  currentRatio?: number;
  interestCoverage?: number;
  dividendYield?: number;
  fcfYield?: number;
  marketCap?: number;
}

type Verdict =
  | "significantly_undervalued"
  | "undervalued"
  | "fairly_valued"
  | "overvalued"
  | "significantly_overvalued";

interface MetricResult {
  name: string;
  category: string;
  value: number | null;
  peerAvg: number | null;
  peerMedian: number | null;
  percentile: number | null;
  verdict: Verdict | "insufficient_data";
  higherIsBetter: boolean;
}

interface RelativeValuationResult {
  symbol: string;
  peerCount: number;
  metrics: MetricResult[];
  overallVerdict: Verdict;
  summary: string;
  categoryScores: Record<string, { avgPercentile: number; verdict: string }>;
}

interface MetricDef {
  key: keyof PeerData;
  name: string;
  category: string;
  higherIsBetter: boolean;
  filterZero?: boolean;
  filterNegative?: boolean;
}

const METRIC_DEFS: MetricDef[] = [
  // Valuation (lower is better for most)
  {
    key: "pe",
    name: "P/E Ratio",
    category: "Valuation",
    higherIsBetter: false,
    filterZero: true,
    filterNegative: true,
  },
  {
    key: "pb",
    name: "P/B Ratio",
    category: "Valuation",
    higherIsBetter: false,
    filterZero: true,
    filterNegative: true,
  },
  {
    key: "evToEbitda",
    name: "EV/EBITDA",
    category: "Valuation",
    higherIsBetter: false,
    filterZero: true,
    filterNegative: true,
  },
  {
    key: "peg",
    name: "PEG Ratio",
    category: "Valuation",
    higherIsBetter: false,
    filterZero: true,
    filterNegative: true,
  },
  {
    key: "priceToSales",
    name: "Price/Sales",
    category: "Valuation",
    higherIsBetter: false,
    filterZero: true,
  },
  {
    key: "priceToFcf",
    name: "Price/FCF",
    category: "Valuation",
    higherIsBetter: false,
    filterZero: true,
    filterNegative: true,
  },
  // Profitability (higher is better)
  {
    key: "roe",
    name: "Return on Equity",
    category: "Profitability",
    higherIsBetter: true,
  },
  {
    key: "roa",
    name: "Return on Assets",
    category: "Profitability",
    higherIsBetter: true,
  },
  {
    key: "roce",
    name: "Return on Capital Employed",
    category: "Profitability",
    higherIsBetter: true,
  },
  {
    key: "operatingMargin",
    name: "Operating Margin",
    category: "Profitability",
    higherIsBetter: true,
  },
  {
    key: "netMargin",
    name: "Net Margin",
    category: "Profitability",
    higherIsBetter: true,
  },
  {
    key: "grossMargin",
    name: "Gross Margin",
    category: "Profitability",
    higherIsBetter: true,
  },
  // Growth (higher is better)
  {
    key: "revenueGrowth",
    name: "Revenue Growth",
    category: "Growth",
    higherIsBetter: true,
  },
  {
    key: "epsGrowth",
    name: "EPS Growth",
    category: "Growth",
    higherIsBetter: true,
  },
  {
    key: "ebitdaGrowth",
    name: "EBITDA Growth",
    category: "Growth",
    higherIsBetter: true,
  },
  // Financial Health
  {
    key: "debtToEquity",
    name: "Debt/Equity",
    category: "Financial Health",
    higherIsBetter: false,
  },
  {
    key: "currentRatio",
    name: "Current Ratio",
    category: "Financial Health",
    higherIsBetter: true,
    filterZero: true,
  },
  {
    key: "interestCoverage",
    name: "Interest Coverage",
    category: "Financial Health",
    higherIsBetter: true,
  },
  // Returns
  {
    key: "dividendYield",
    name: "Dividend Yield",
    category: "Returns",
    higherIsBetter: true,
  },
  {
    key: "fcfYield",
    name: "FCF Yield",
    category: "Returns",
    higherIsBetter: true,
  },
];

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentileRank(
  value: number,
  values: number[],
  higherIsBetter: boolean,
): number {
  if (values.length === 0) return 50;
  const sorted = [...values].sort((a, b) => a - b);
  let countBelow = 0;
  for (const v of sorted) {
    if (v < value) countBelow++;
  }
  const rawPercentile = (countBelow / sorted.length) * 100;
  // For "lower is better" metrics, invert: being lower = higher percentile (better)
  return higherIsBetter
    ? Math.round(rawPercentile * 100) / 100
    : Math.round((100 - rawPercentile) * 100) / 100;
}

function verdictFromPercentile(pct: number): Verdict {
  if (pct >= 80) return "significantly_undervalued";
  if (pct >= 60) return "undervalued";
  if (pct >= 40) return "fairly_valued";
  if (pct >= 20) return "overvalued";
  return "significantly_overvalued";
}

export const computeRelativeValuationTool: ResearchToolDef = {
  name: "compute_relative_valuation",
  description:
    "Compare stock against peers on 20+ metrics with percentile ranking - valuation, profitability, growth, health, returns",
  category: "computation",
  parameters: {
    symbol: {
      type: "string",
      description: "Target stock symbol",
      required: true,
    },
    peers: {
      type: "array",
      description:
        "Array of peer data objects with symbol and metrics (pe, pb, roe, roce, revenueGrowth, etc.)",
      required: true,
    },
    ratios: {
      type: "object",
      description:
        "Target stock's ratios object with same fields as peer data (pe, pb, roe, roce, etc.)",
      required: true,
    },
  },
  cacheTTL: 1800,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    const peers = params.peers as PeerData[] | undefined;
    const ratios = params.ratios as PeerData | undefined;

    if (!symbol) {
      return { success: false, error: "symbol is required" };
    }
    if (!peers || !Array.isArray(peers)) {
      return { success: false, error: "peers array is required" };
    }
    if (peers.length === 0) {
      return insufficientInput(
        "peers array with at least 1 entry is required",
        {
          needed: "1 peer",
          got: 0,
        },
      );
    }
    if (!ratios) {
      return { success: false, error: "ratios object is required" };
    }

    try {
      const metrics: MetricResult[] = [];
      const categoryPercentiles: Record<string, number[]> = {};

      for (const metricDef of METRIC_DEFS) {
        const stockValue = ratios[metricDef.key] as number | undefined;

        // Gather peer values for this metric
        let peerValues: number[] = peers
          .map((p) => p[metricDef.key] as number | undefined)
          .filter((v): v is number => v != null && isFinite(v));

        if (metricDef.filterZero) {
          peerValues = peerValues.filter((v) => v !== 0);
        }
        if (metricDef.filterNegative) {
          peerValues = peerValues.filter((v) => v > 0);
        }

        if (
          stockValue == null ||
          !isFinite(stockValue) ||
          peerValues.length < 2
        ) {
          metrics.push({
            name: metricDef.name,
            category: metricDef.category,
            value: stockValue ?? null,
            peerAvg:
              peerValues.length > 0
                ? Math.round(
                    (peerValues.reduce((a, b) => a + b, 0) /
                      peerValues.length) *
                      100,
                  ) / 100
                : null,
            peerMedian:
              peerValues.length > 0
                ? Math.round(median(peerValues) * 100) / 100
                : null,
            percentile: null,
            verdict: "insufficient_data",
            higherIsBetter: metricDef.higherIsBetter,
          });
          continue;
        }

        // Include stock value in the pool for fair percentile calculation
        const allValues = [...peerValues, stockValue];
        const avg =
          Math.round(
            (peerValues.reduce((a, b) => a + b, 0) / peerValues.length) * 100,
          ) / 100;
        const med = Math.round(median(peerValues) * 100) / 100;
        const pct = percentileRank(
          stockValue,
          allValues,
          metricDef.higherIsBetter,
        );
        const verdict = verdictFromPercentile(pct);

        // Track for category scores
        if (!categoryPercentiles[metricDef.category]) {
          categoryPercentiles[metricDef.category] = [];
        }
        categoryPercentiles[metricDef.category]!.push(pct);

        metrics.push({
          name: metricDef.name,
          category: metricDef.category,
          value: Math.round(stockValue * 100) / 100,
          peerAvg: avg,
          peerMedian: med,
          percentile: pct,
          verdict,
          higherIsBetter: metricDef.higherIsBetter,
        });
      }

      // Category scores
      const categoryScores: Record<
        string,
        { avgPercentile: number; verdict: string }
      > = {};
      for (const [cat, pcts] of Object.entries(categoryPercentiles)) {
        if (pcts.length > 0) {
          const avg =
            Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 100) /
            100;
          categoryScores[cat] = {
            avgPercentile: avg,
            verdict: verdictFromPercentile(avg),
          };
        }
      }

      // Overall verdict from all valid percentiles
      const validPercentiles = metrics
        .filter((m) => m.percentile != null)
        .map((m) => m.percentile!);
      const overallPct =
        validPercentiles.length > 0
          ? validPercentiles.reduce((a, b) => a + b, 0) /
            validPercentiles.length
          : 50;
      const overallVerdict = verdictFromPercentile(overallPct);

      // Generate summary
      const strongMetrics = metrics.filter(
        (m) => m.percentile != null && m.percentile >= 70,
      );
      const weakMetrics = metrics.filter(
        (m) => m.percentile != null && m.percentile <= 30,
      );

      let summary = `${symbol} ranks at the ${Math.round(overallPct)}th percentile among ${peers.length} peers overall. `;
      if (strongMetrics.length > 0) {
        summary += `Strengths: ${strongMetrics
          .slice(0, 3)
          .map((m) => m.name)
          .join(", ")}. `;
      }
      if (weakMetrics.length > 0) {
        summary += `Weaknesses: ${weakMetrics
          .slice(0, 3)
          .map((m) => m.name)
          .join(", ")}. `;
      }
      summary += `Verdict: ${overallVerdict.replace(/_/g, " ")}.`;

      const result: RelativeValuationResult = {
        symbol,
        peerCount: peers.length,
        metrics,
        overallVerdict,
        summary,
        categoryScores,
      };

      return {
        success: true,
        data: result,
        metadata: {
          symbol,
          peerCount: peers.length,
          metricsComputed: metrics.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Relative valuation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
