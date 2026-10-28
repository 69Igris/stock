/**
 * Fetch Financials Tool — our own `StockFinancials`, not Tickertape.
 *
 * ## What this used to be, and why it had to change
 *
 * This tool called `fetchTickertapeFinancials(symbol)` directly. That request
 * returns **403 from our Cloud Run egress** and 200 from a laptop, so the tool
 * was registered, offered to the research agent on every turn, and could not
 * succeed in production — the agent spent a turn on it and got
 * `No Tickertape data found for X`, which reads as "this company has no
 * financials" rather than "we were blocked".
 *
 * It now reads `StockFinancials`, which `xbrl-projection` fills nightly from our
 * own archive of NSE's XBRL results filings. Same shape of answer, from data we
 * hold, with the row's real `source` attached so a caller can tell an
 * XBRL-projected row from a legacy Tickertape one.
 *
 * The tool NAME changed with it (`fetch_tickertape_financials` ->
 * `fetch_financials`). The name is what the model sees when it decides what to
 * call, and a name that promises a specific vendor is a name that will be
 * chosen for the wrong reason — or avoided for the wrong reason — once that
 * vendor is not involved. Nothing else in the repo referenced the old string.
 *
 * `cacheTTL` drops 24h -> 6h: the underlying table is refreshed nightly now
 * rather than whenever someone happened to call this, so a shorter TTL costs a
 * cheap DB read instead of an external fetch.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { getOrFetchFinancials } from "../data-sources/db-store";

export const fetchTickertapeFinancialsTool: ResearchToolDef = {
  name: "fetch_financials",
  description:
    "Fetch annual income statement, balance sheet and cash flow for an Indian " +
    "stock, derived from the company's own NSE XBRL filings",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Stock symbol (e.g., RELIANCE, TCS)",
      required: true,
    },
  },
  cacheTTL: 21600, // 6h — the source table is rebuilt nightly
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    if (!symbol) {
      return { success: false, error: "symbol is required" };
    }

    try {
      const data = await getOrFetchFinancials(symbol, undefined, "ANNUAL");
      if (!data) {
        // Distinguishable on purpose. "Not covered yet" is a statement about
        // OUR coverage and is temporary — the backfill is what closes it. The
        // old message ("No Tickertape data found") blamed the company.
        return {
          success: false,
          error:
            `No stored financials for ${symbol} — the XBRL projection has not ` +
            `covered this symbol yet`,
        };
      }

      return {
        success: true,
        data,
        metadata: {
          source: data.source ?? "unknown",
          incomeYears: data.income?.length ?? 0,
          balanceSheetYears: data.balanceSheet?.length ?? 0,
          cashFlowYears: data.cashFlow?.length ?? 0,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Financials lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
