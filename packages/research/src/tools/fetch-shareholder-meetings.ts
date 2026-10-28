/**
 * Fetch Shareholder / Board Meetings — NSE corporate board-meetings filings
 * (board meetings, AGM / EGM). An official-channel source for MONEY-587:
 * carries the NSE source URL so the research pipeline can cite it.
 */

import { getNseClient } from "../data-sources/nse-client";
import { toNseSymbol } from "../data-sources/symbol-resolver";
import { cachedFetch } from "../data-sources/source-cache";
import type { ResearchToolDef, ToolOutput } from "./types";

export const SHAREHOLDER_MEETINGS_SOURCE =
  "https://www.nseindia.com/companies-listing/corporate-filings-board-meetings";

export interface ShareholderMeeting {
  date?: string;
  type?: string;
  purpose?: string;
}

function str(v: unknown): string | undefined {
  return v == null || v === "" ? undefined : String(v);
}

function asRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  const d = (raw as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? (d as Array<Record<string, unknown>>) : [];
}

/** Pure transform of the NSE board-meetings payload → typed meetings. */
export function mapBoardMeetings(raw: unknown): ShareholderMeeting[] {
  return asRows(raw)
    .map((m) => ({
      // NSE field names vary across endpoints — accept the common aliases.
      date: str(m.bm_date ?? m.meetingDate ?? m.date),
      type: str(m.meeting_type ?? m.type),
      purpose: str(m.bm_purpose ?? m.purpose ?? m.bm_desc ?? m.desc),
    }))
    .filter((m) => m.date || m.purpose);
}

export const fetchShareholderMeetingsTool: ResearchToolDef = {
  name: "fetch_shareholder_meetings",
  description:
    "Fetch board meetings and shareholder meetings (AGM / EGM) for a stock from NSE corporate filings, with the official source link.",
  category: "data",
  parameters: {
    symbol: { type: "string", description: "Stock symbol", required: true },
  },
  cacheTTL: 43200, // 12h
  execute: async (params): Promise<ToolOutput> => {
    const symbol = toNseSymbol(params.symbol as string);
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      // GCS-first: reuse the stored doc (shared NSE/BSE folder) when fresh,
      // else fetch live and store it back.
      const { data: raw, fromCache } = await cachedFetch({
        symbol,
        docType: "board-meetings",
        ttlMs: 12 * 60 * 60 * 1000, // 12h
        source: SHAREHOLDER_MEETINGS_SOURCE,
        fetch: () => getNseClient().getBoardMeetings(symbol),
      });
      const meetings = mapBoardMeetings(raw);
      return {
        success: true,
        data: meetings,
        metadata: {
          source: SHAREHOLDER_MEETINGS_SOURCE,
          sourceTitle: "NSE — Board & shareholder meetings",
          symbol,
          fromCache,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch shareholder meetings: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
