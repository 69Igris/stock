/**
 * Fetch Promoter Holding Data
 *
 * Retrieves promoter shareholding % and its QoQ trend via the unified
 * shareholding chain (Tickertape → Screener.in). A sustained DECREASE in
 * promoter holding is an amber governance signal (promoters trimming skin in
 * the game). Powers the governance-flags skill.
 *
 * SEBI note: outputs OBSERVATIONS / FLAGS only — no buy/sell/hold guidance.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { fetchShareholdingChain } from "../data-sources/index";

export interface PromoterHoldingSeriesPoint {
  quarter: string;
  promoterPercent: number;
}

export interface PromoterHoldingResult {
  available: boolean;
  reason?: string;
  symbol: string;
  promoterPercent?: number; // latest quarter
  previousQuarter?: number; // prior quarter
  change?: number; // latest − previous (pp), negative = trimming
  trend?: "increasing" | "stable" | "decreasing";
  pledgedPercent?: number; // % of promoter holding pledged, if source exposes it
  series?: PromoterHoldingSeriesPoint[];
  flags: string[];
}

/**
 * Defensive numeric coercion: returns a finite number or undefined.
 */
function toNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[%,\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Opportunistically read a pledged % off a raw row. The typed shareholding
 * shape does not carry pledging, but some upstream rows do — narrow via
 * Record<string, unknown> rather than assuming a key exists.
 */
function extractPledged(row: unknown): number | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  return (
    toNum(r.pledgedPercent) ??
    toNum(r.pledgedPercentage) ??
    toNum(r.pledged) ??
    toNum(r.pledge) ??
    toNum(r.prmotrPldgPct)
  );
}

export const fetchPromoterHoldingTool: ResearchToolDef = {
  name: "fetch_promoter_holding",
  description:
    "Fetch promoter shareholding % and its QoQ trend — flags sustained decreases as a governance signal",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "NSE symbol (e.g., RELIANCE)",
      required: true,
    },
  },
  cacheTTL: 86400, // 24h — shareholding patterns change quarterly
  execute: async (params): Promise<ToolOutput> => {
    const rawSymbol = params.symbol;
    const symbol =
      typeof rawSymbol === "string"
        ? rawSymbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
        : "";

    if (!symbol) {
      const result: PromoterHoldingResult = {
        available: false,
        reason: "symbol is required",
        symbol: "",
        flags: [],
      };
      return { success: true, data: result };
    }

    try {
      const chain = await fetchShareholdingChain(symbol);

      if (!chain || !Array.isArray(chain) || chain.length === 0) {
        const result: PromoterHoldingResult = {
          available: false,
          reason: `No shareholding data resolved for ${symbol} (Screener/Tickertape/NSE)`,
          symbol,
          flags: [],
        };
        return { success: true, data: result };
      }

      // Build the promoter % series. The chain is ordered oldest → newest;
      // keep only rows that carry a usable promoter % and a quarter label.
      const series: PromoterHoldingSeriesPoint[] = [];
      let latestPledged: number | undefined;

      for (const row of chain) {
        if (typeof row !== "object" || row === null) continue;
        const r = row as unknown as Record<string, unknown>;
        const promoterPercent = toNum(r.promoter) ?? toNum(r.promoterPercent);
        if (promoterPercent === undefined) continue;
        const quarter =
          typeof r.quarter === "string" && r.quarter.trim().length > 0
            ? r.quarter.trim()
            : `Q${series.length + 1}`;
        series.push({ quarter, promoterPercent: round2(promoterPercent) });

        // Track the most recent pledged figure (last row wins).
        const pledged = extractPledged(row);
        if (pledged !== undefined) latestPledged = pledged;
      }

      if (series.length === 0) {
        const result: PromoterHoldingResult = {
          available: false,
          reason: `Shareholding rows for ${symbol} carried no promoter percentage`,
          symbol,
          flags: [],
        };
        return { success: true, data: result };
      }

      const current = series[series.length - 1]!;
      const previous =
        series.length >= 2 ? series[series.length - 2] : undefined;

      const promoterPercent = current.promoterPercent;
      const previousQuarter = previous?.promoterPercent;
      const change =
        previousQuarter !== undefined
          ? round2(promoterPercent - previousQuarter)
          : undefined;

      // Trend classification. Use the latest QoQ delta with a 0.5pp dead-band
      // so reporting noise / rounding does not read as a real move.
      let trend: PromoterHoldingResult["trend"];
      if (change !== undefined) {
        if (change <= -0.5) trend = "decreasing";
        else if (change >= 0.5) trend = "increasing";
        else trend = "stable";
      }

      const flags: string[] = [];

      // Amber governance signal: promoters trimming holding.
      if (trend === "decreasing" && change !== undefined) {
        flags.push(
          `Promoter holding decreased ${Math.abs(change).toFixed(2)}pp QoQ (${previousQuarter?.toFixed(2)}% → ${promoterPercent.toFixed(2)}%) — governance signal to monitor`,
        );
      }

      // Multi-quarter persistent decline check (oldest → newest run).
      if (series.length >= 3) {
        const a = series[series.length - 3]!.promoterPercent;
        const b = series[series.length - 2]!.promoterPercent;
        const c = series[series.length - 1]!.promoterPercent;
        if (a - b >= 0.5 && b - c >= 0.5) {
          flags.push(
            `Promoter holding has declined for 3 consecutive quarters (${a.toFixed(2)}% → ${c.toFixed(2)}%)`,
          );
        }
      }

      // Low absolute promoter stake.
      if (promoterPercent < 25) {
        flags.push(
          `Low promoter holding (${promoterPercent.toFixed(2)}%) — limited promoter skin in the game`,
        );
      }

      const result: PromoterHoldingResult = {
        available: true,
        symbol,
        promoterPercent,
        previousQuarter,
        change,
        trend,
        pledgedPercent:
          latestPledged !== undefined ? round2(latestPledged) : undefined,
        series,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Promoter holding fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
