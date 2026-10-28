/**
 * Revenue Mix Analysis
 *
 * Computes product-wise and geography-wise revenue breakdown,
 * segment operating profit, 3-year trends, and concentration risk (HHI).
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { insufficientInput } from "./insufficient-input";

interface SegmentData {
  name: string;
  revenue: number;
  operatingProfit?: number;
  history?: Array<{ year: string; revenue: number }>;
}

interface GeoData {
  region: string;
  revenue: number;
}

interface SegmentResult {
  name: string;
  revenue: number;
  share: number;
  growth: number | null;
  operatingProfit: number | null;
  operatingMargin: number | null;
  trend: Array<{ year: string; revenue: number; share: number }>;
}

interface GeoResult {
  region: string;
  revenue: number;
  share: number;
}

interface RevenueMixResult {
  segments: SegmentResult[];
  geography: GeoResult[] | null;
  totalRevenue: number;
  concentrationHHI: number;
  diversificationScore: number;
  topSegment: { name: string; share: number };
  trends: Array<{
    year: string;
    segments: Array<{ name: string; revenue: number; share: number }>;
  }>;
  flags: string[];
}

function computeHHI(shares: number[]): number {
  // HHI = sum of squared market shares (as percentages)
  // Range: 1/N * 10000 (perfectly equal) to 10000 (single segment)
  return shares.reduce((sum, s) => sum + s * s, 0);
}

function computeGrowthRate(
  history: Array<{ year: string; revenue: number }>,
): number | null {
  if (!history || history.length < 2) return null;
  const sorted = [...history].sort((a, b) => a.year.localeCompare(b.year));
  const oldest = sorted[0]!.revenue;
  const newest = sorted[sorted.length - 1]!.revenue;
  if (oldest <= 0) return null;
  const years = sorted.length - 1;
  return Math.round((Math.pow(newest / oldest, 1 / years) - 1) * 10000) / 100;
}

export const computeRevenueMixTool: ResearchToolDef = {
  name: "compute_revenue_mix",
  description:
    "Analyze revenue segment breakdown - product/geography mix, HHI concentration, 3-year trends, operating margins by segment",
  category: "computation",
  parameters: {
    financials: {
      type: "object",
      description:
        "Financial data with segment breakdown: { segments: [{ name, revenue, operatingProfit?, history?: [{ year, revenue }] }], geography?: [{ region, revenue }] }",
      required: true,
    },
    symbol: {
      type: "string",
      description: "Stock symbol for context",
      required: true,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const financials = params.financials as
      | {
          segments?: SegmentData[];
          geography?: GeoData[];
        }
      | undefined;
    const symbol = params.symbol as string;

    if (!financials || !financials.segments) {
      return { success: false, error: "financials with segments is required" };
    }
    if (financials.segments.length === 0) {
      return insufficientInput(
        "financials with at least one segment is required",
        { needed: "1 segment", got: 0 },
      );
    }

    if (!symbol) {
      return { success: false, error: "symbol is required" };
    }

    try {
      const rawSegments = financials.segments;
      const rawGeo = financials.geography;

      // Compute total revenue
      const totalRevenue = rawSegments.reduce(
        (sum, s) => sum + (s.revenue || 0),
        0,
      );

      if (totalRevenue <= 0) {
        return {
          success: false,
          error: "Total segment revenue must be positive",
        };
      }

      // Compute segment shares and results
      const segments: SegmentResult[] = rawSegments.map((seg) => {
        const share = Math.round((seg.revenue / totalRevenue) * 10000) / 100;

        const growth = seg.history ? computeGrowthRate(seg.history) : null;

        const operatingMargin =
          seg.operatingProfit != null && seg.revenue > 0
            ? Math.round((seg.operatingProfit / seg.revenue) * 10000) / 100
            : null;

        // Build trend from history
        const trend: Array<{ year: string; revenue: number; share: number }> =
          [];
        if (seg.history && seg.history.length > 0) {
          const sorted = [...seg.history].sort((a, b) =>
            a.year.localeCompare(b.year),
          );
          // Use last 3 years
          const recent = sorted.slice(-3);
          for (const h of recent) {
            trend.push({
              year: h.year,
              revenue: h.revenue,
              share: 0, // Will be computed below in cross-segment trends
            });
          }
        }

        return {
          name: seg.name,
          revenue: seg.revenue,
          share,
          growth,
          operatingProfit: seg.operatingProfit ?? null,
          operatingMargin,
          trend,
        };
      });

      // Sort by revenue descending
      segments.sort((a, b) => b.revenue - a.revenue);

      // Compute HHI from percentage shares
      const sharesForHHI = segments.map((s) => s.share);
      const concentrationHHI = Math.round(computeHHI(sharesForHHI));

      // Diversification score: 0 (single segment) to 100 (perfectly diversified)
      // HHI range: 10000 (monopoly) to 10000/N (equal split)
      // We scale: score = 100 * (1 - (HHI - minHHI) / (10000 - minHHI))
      const n = segments.length;
      const minHHI = n > 0 ? Math.round(10000 / n) : 10000;
      const diversificationScore =
        n <= 1
          ? 0
          : Math.round(
              Math.max(
                0,
                Math.min(
                  100,
                  ((10000 - concentrationHHI) / (10000 - minHHI)) * 100,
                ),
              ),
            );

      // Geography breakdown
      let geography: GeoResult[] | null = null;
      if (rawGeo && rawGeo.length > 0) {
        const geoTotal = rawGeo.reduce((sum, g) => sum + (g.revenue || 0), 0);
        if (geoTotal > 0) {
          geography = rawGeo
            .map((g) => ({
              region: g.region,
              revenue: g.revenue,
              share: Math.round((g.revenue / geoTotal) * 10000) / 100,
            }))
            .sort((a, b) => b.revenue - a.revenue);
        }
      }

      // Build cross-segment trends (yearly snapshots)
      const yearSet = new Set<string>();
      for (const seg of rawSegments) {
        if (seg.history) {
          for (const h of seg.history) {
            yearSet.add(h.year);
          }
        }
      }
      const years = Array.from(yearSet).sort().slice(-3);

      const trends: RevenueMixResult["trends"] = years.map((year) => {
        const yearSegments: Array<{
          name: string;
          revenue: number;
          share: number;
        }> = [];
        let yearTotal = 0;

        for (const seg of rawSegments) {
          const entry = seg.history?.find((h) => h.year === year);
          if (entry) {
            yearTotal += entry.revenue;
            yearSegments.push({
              name: seg.name,
              revenue: entry.revenue,
              share: 0,
            });
          }
        }

        // Compute shares for this year
        if (yearTotal > 0) {
          for (const ys of yearSegments) {
            ys.share = Math.round((ys.revenue / yearTotal) * 10000) / 100;
          }
        }

        return { year, segments: yearSegments };
      });

      // Update individual segment trends with correct shares
      for (const seg of segments) {
        for (const t of seg.trend) {
          const yearData = trends.find((tr) => tr.year === t.year);
          if (yearData) {
            const match = yearData.segments.find((s) => s.name === seg.name);
            if (match) {
              t.share = match.share;
            }
          }
        }
      }

      // Top segment
      const topSegment = {
        name: segments[0]!.name,
        share: segments[0]!.share,
      };

      // Generate flags
      const flags: string[] = [];

      if (topSegment.share > 80) {
        flags.push(
          `High concentration risk: ${topSegment.name} contributes ${topSegment.share}% of revenue`,
        );
      } else if (topSegment.share > 60) {
        flags.push(
          `Moderate concentration: ${topSegment.name} contributes ${topSegment.share}% of revenue`,
        );
      }

      if (concentrationHHI > 5000) {
        flags.push(
          `High HHI (${concentrationHHI}) indicates concentrated revenue streams`,
        );
      }

      // Check for declining segments
      for (const seg of segments) {
        if (seg.growth != null && seg.growth < -10) {
          flags.push(
            `${seg.name} segment declining at ${seg.growth}% CAGR - potential drag on growth`,
          );
        }
      }

      // Check for negative operating margins
      for (const seg of segments) {
        if (seg.operatingMargin != null && seg.operatingMargin < 0) {
          flags.push(
            `${seg.name} segment has negative operating margin (${seg.operatingMargin}%) - loss-making division`,
          );
        }
      }

      if (geography && geography.length > 0) {
        const domesticShare = geography.find(
          (g) =>
            g.region.toLowerCase().includes("india") ||
            g.region.toLowerCase().includes("domestic"),
        );
        if (domesticShare && domesticShare.share > 90) {
          flags.push(
            "Revenue heavily concentrated in domestic market (>90%) - limited geographic diversification",
          );
        }
      }

      const result: RevenueMixResult = {
        segments,
        geography,
        totalRevenue,
        concentrationHHI,
        diversificationScore,
        topSegment,
        trends,
        flags,
      };

      return {
        success: true,
        data: result,
        metadata: { symbol, segmentCount: segments.length },
      };
    } catch (error) {
      return {
        success: false,
        error: `Revenue mix analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
