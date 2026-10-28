/**
 * Fetch Corporate Actions — DB-first, NSE fallback (MONEY-840/844).
 *
 * The corporate-actions-sync worker ingests Screener + NSE into the
 * `CorporateAction` table on a weekly cron, so this tool reads the DB FIRST
 * (fast, structured, history-preserving, includes parsed ratios) and only falls
 * back to a LIVE NSE fetch when the DB has nothing for the symbol (e.g. a stock
 * the sync hasn't reached yet). The output shape is unchanged for downstream
 * consumers; `metadata.source` records where the data came from.
 */

import prisma from "@usemoney/database";
import { getNseClient } from "../data-sources/nse-client";
import { toNseSymbol } from "../data-sources/symbol-resolver";
import { toIstDateKey } from "@usemoney/core/market-data/nse-holidays";
import type { NseCorporateActionResponse } from "../data-sources/nse-types";
import type { ResearchToolDef, ToolOutput } from "./types";
import type { NseCorporateAction } from "../types";

/** Compact ratio/dividend hint appended to the DB row's purpose string. */
function describeDbAction(row: {
  type: string;
  ratio: number | null;
  dividendPerShare: number | null;
  details: unknown;
}): string {
  if (typeof row.details === "string" && row.details.trim()) {
    return row.details.trim();
  }
  if (row.type === "DIVIDEND" && row.dividendPerShare != null) {
    return `Dividend - Rs ${row.dividendPerShare} per share`;
  }
  if (row.ratio != null && (row.type === "SPLIT" || row.type === "BONUS")) {
    return `${row.type} (${row.ratio}x)`;
  }
  return row.type;
}

export const fetchCorporateActionsTool: ResearchToolDef = {
  name: "fetch_corporate_actions",
  description: "Fetch corporate actions (dividends, splits, bonuses) from NSE",
  category: "data",
  parameters: {
    symbol: { type: "string", description: "Stock symbol", required: true },
  },
  cacheTTL: 86400, // 24h
  execute: async (params): Promise<ToolOutput> => {
    const symbol = toNseSymbol(params.symbol as string);
    if (!symbol) return { success: false, error: "symbol is required" };

    const bare = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

    // ── DB-first: read the ingested CorporateAction rows ──
    try {
      const rows = await prisma.corporateAction.findMany({
        where: { symbol: bare, exchange: "NSE" },
        orderBy: { exDate: "desc" },
        take: 100,
      });
      if (rows.length > 0) {
        const actions: NseCorporateAction[] = rows.map((r) => ({
          symbol: r.symbol,
          // IST, not UTC — MONEY-1527. Prod stores exDate in two
          // conventions (18:30Z = IST midnight for 48,224 rows, 00:00Z for
          // 10,863) and a UTC slice reads the majority a day early. This
          // string goes to the model as fact.
          exDate: toIstDateKey(r.exDate),
          purpose: describeDbAction(r),
          details:
            typeof r.details === "string" ? r.details : describeDbAction(r),
        }));
        return {
          success: true,
          data: actions,
          metadata: { source: "db", count: actions.length },
        };
      }
    } catch (error) {
      // DB read failure shouldn't block the live fallback — log via the catch
      // below only if NSE also fails.
      console.warn(
        `[fetch-corporate-actions] DB read failed for ${bare}, falling back to NSE:`,
        error instanceof Error ? error.message : error,
      );
    }

    // ── Fallback: live NSE corporate-actions API ──
    try {
      const client = getNseClient();
      const raw = await client.getCorporateActions(symbol);

      if (!raw) {
        return {
          success: false,
          error: `No corporate actions found for ${symbol}`,
        };
      }

      const response = raw as NseCorporateActionResponse;
      const actions: NseCorporateAction[] = (response.data || []).map((a) => ({
        symbol: a.symbol,
        exDate: a.exDate,
        purpose: a.purpose,
        details: a.details,
      }));

      return {
        success: true,
        data: actions,
        metadata: { source: "nse-live", count: actions.length },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch corporate actions: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
