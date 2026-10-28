/**
 * Fetch Earnings Calendar
 *
 * Retrieves upcoming and recent earnings dates for stocks.
 * Uses Yahoo Finance earnings data.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { yahooFetchQuoteSummary } from "@usemoney/core/market-data";

export interface EarningsCalendarEntry {
  symbol: string;
  earningsDate?: string;
  epsForecast?: number;
  epsActual?: number;
  revenueEstimate?: number;
}

export const fetchEarningsCalendarTool: ResearchToolDef = {
  name: "fetch_earnings_calendar",
  description:
    "Fetch upcoming earnings dates and estimates for one or more stocks",
  category: "data",
  parameters: {
    symbols: {
      type: "array",
      description: "Array of Yahoo Finance symbols",
      required: true,
    },
  },
  cacheTTL: 3600, // 1h
  execute: async (params): Promise<ToolOutput> => {
    const symbols = params.symbols as string[];
    if (!symbols?.length) {
      return { success: false, error: "symbols array is required" };
    }

    try {
      const entries: EarningsCalendarEntry[] = [];

      for (const symbol of symbols.slice(0, 10)) {
        try {
          const data = await yahooFetchQuoteSummary(symbol, [
            "calendarEvents",
            "earnings",
          ]);
          if (!data) continue;

          const calendar = (data as Record<string, unknown>).calendarEvents as
            | Record<string, unknown>
            | undefined;
          const earnings = (data as Record<string, unknown>).earnings as
            | Record<string, unknown>
            | undefined;

          const entry: EarningsCalendarEntry = { symbol };

          // Extract next earnings date
          if (calendar) {
            const earningsObj = calendar.earnings as
              | Record<string, unknown>
              | undefined;
            if (earningsObj) {
              const dateRaw = earningsObj.earningsDate as
                | Array<{ raw: number }>
                | undefined;
              if (dateRaw?.[0]?.raw) {
                entry.earningsDate = new Date(
                  dateRaw[0].raw * 1000,
                ).toISOString();
              }

              const eps = earningsObj.earningsAverage as
                | { raw: number }
                | undefined;
              if (eps?.raw) entry.epsForecast = eps.raw;

              const rev = earningsObj.revenueAverage as
                | { raw: number }
                | undefined;
              if (rev?.raw) entry.revenueEstimate = rev.raw;
            }
          }

          // Extract recent actual EPS
          if (earnings) {
            const history = (earnings.earningsChart as Record<string, unknown>)
              ?.quarterly as Array<{ actual?: { raw: number } }> | undefined;
            if (history?.length) {
              const latest = history[history.length - 1];
              if (latest?.actual?.raw) entry.epsActual = latest.actual.raw;
            }
          }

          entries.push(entry);
        } catch {
          entries.push({ symbol });
        }
      }

      return {
        success: true,
        data: entries,
        metadata: { symbolCount: entries.length },
      };
    } catch (error) {
      return {
        success: false,
        error: `Earnings calendar fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
