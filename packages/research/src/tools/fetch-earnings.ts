/**
 * Fetch Earnings Data - Yahoo quoteSummary → Tickertape/Screener quarterly
 * results fallback. Yahoo's `earningsTrend` + `earnings` modules are sparse
 * for Indian listings, so the fallback chain pulls the raw quarterly result
 * series from Tickertape (with Screener as final fallback).
 */

import {
  yahooFetchQuoteSummary,
  withExchangeFallback,
} from "@usemoney/core/market-data";
import { fetchQuarterlyResultsChain } from "../data-sources/data-source-chain";
import type { ResearchToolDef, ToolOutput } from "./types";
import type { EarningsData } from "../types";

function extractRaw(obj: unknown): number | undefined {
  if (typeof obj === "number") return obj;
  if (typeof obj === "object" && obj !== null && "raw" in obj) {
    return (obj as Record<string, unknown>).raw as number;
  }
  return undefined;
}

export const fetchEarningsTool: ResearchToolDef = {
  name: "fetch_earnings",
  description: "Fetch earnings data: EPS estimates, surprises, and trends",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Yahoo Finance symbol",
      required: true,
    },
  },
  cacheTTL: 21600, // 6h
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      const data = await withExchangeFallback(symbol, (s) =>
        yahooFetchQuoteSummary(s, ["earningsTrend", "earnings"]),
      );

      if (!data) {
        // Yahoo returned nothing - fall through to Tickertape quarterly
        // results so Indian-listed stocks still get an earnings history.
        const chain = await fetchQuarterlyResultsChain(symbol);
        if (chain) {
          return {
            success: true,
            data: { history: chain, trends: [] },
            metadata: { source: "fallback", fallback: true },
          };
        }
        return { success: false, error: `No data found for ${symbol}` };
      }

      const earnings = data.earnings as Record<string, unknown> | undefined;
      const earningsTrend = data.earningsTrend as
        | Record<string, unknown>
        | undefined;

      // Extract recent earnings history
      const earningsHistory: EarningsData[] = [];
      const history = (earnings?.earningsChart as Record<string, unknown>)
        ?.quarterly as unknown[];
      if (Array.isArray(history)) {
        for (const q of history) {
          const quarter = q as Record<string, unknown>;
          earningsHistory.push({
            earningsDate: (quarter.date as string) || undefined,
            epsEstimate: extractRaw(quarter.estimate),
            epsActual: extractRaw(quarter.actual),
            surprisePercent: extractRaw(quarter.surprisePercent),
          });
        }
      }

      // Extract trend data
      const trends: Array<Record<string, unknown>> = [];
      const trendArr = earningsTrend?.trend as unknown[];
      if (Array.isArray(trendArr)) {
        for (const t of trendArr) {
          const trend = t as Record<string, unknown>;
          trends.push({
            period: trend.period,
            endDate: trend.endDate,
            growth: extractRaw(trend.growth),
            earningsEstimate: {
              avg: extractRaw(
                (trend.earningsEstimate as Record<string, unknown>)?.avg,
              ),
              low: extractRaw(
                (trend.earningsEstimate as Record<string, unknown>)?.low,
              ),
              high: extractRaw(
                (trend.earningsEstimate as Record<string, unknown>)?.high,
              ),
            },
            revenueEstimate: {
              avg: extractRaw(
                (trend.revenueEstimate as Record<string, unknown>)?.avg,
              ),
              low: extractRaw(
                (trend.revenueEstimate as Record<string, unknown>)?.low,
              ),
              high: extractRaw(
                (trend.revenueEstimate as Record<string, unknown>)?.high,
              ),
            },
          });
        }
      }

      // Yahoo data was present but completely empty for both shapes -
      // try the chain so we don't return a useless empty payload.
      if (earningsHistory.length === 0 && trends.length === 0) {
        const chain = await fetchQuarterlyResultsChain(symbol);
        if (chain) {
          return {
            success: true,
            data: { history: chain, trends: [] },
            metadata: { source: "fallback", fallback: true },
          };
        }
      }

      return {
        success: true,
        data: {
          history: earningsHistory,
          trends,
        },
      };
    } catch (error) {
      try {
        const chain = await fetchQuarterlyResultsChain(symbol);
        if (chain) {
          return {
            success: true,
            data: { history: chain, trends: [] },
            metadata: { source: "fallback", fallback: true },
          };
        }
      } catch {
        // Chain also failed
      }
      return {
        success: false,
        error: `Failed to fetch earnings: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
