/**
 * Fetch Exchange Announcements — official NSE corporate announcements /
 * filings (the listing/official channel for MONEY-587). Each announcement
 * carries its official attachment URL so research can cite the primary source.
 */

import { getNseClient } from "../data-sources/nse-client";
import { toNseSymbol } from "../data-sources/symbol-resolver";
import { cachedFetch } from "../data-sources/source-cache";
import { enqueueDocumentForRag } from "../data-sources/rag-enqueue";
import {
  categorizeNseAnnouncement,
  type NseAnnouncementDocType,
} from "../data-sources/nse-filings-logic";
import type { ResearchToolDef, ToolOutput } from "./types";

export const ANNOUNCEMENTS_SOURCE =
  "https://www.nseindia.com/companies-listing/corporate-filings-announcements";

export interface ExchangeAnnouncement {
  date?: string;
  subject?: string;
  detail?: string;
  url?: string;
}

function str(v: unknown): string | undefined {
  return v == null || v === "" ? undefined : String(v);
}

function asRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  const d = (raw as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? (d as Array<Record<string, unknown>>) : [];
}

/**
 * Derive a STABLE per-filing period token for the RAG enqueue unique key
 * (MONEY-798). Distinct filings must land in distinct `StockDocument` rows, but
 * the SAME filing re-surfaced on a later research run must resolve to the SAME
 * token so the idempotent upsert dedupes. We key on the attachment URL (unique
 * per filing) hashed to a short stable token, prefixed with the announcement
 * date when present for human-readable rows. Pure + deterministic.
 */
export function announcementPeriod(a: ExchangeAnnouncement): string {
  // Folder-safe date label (NSE dates are "DD-Mon-YYYY HH:mm"; keep the date,
  // drop the time + unsafe chars). Cosmetic — the hash below guarantees identity.
  const datePart = a.date
    ? String(a.date)
        .split(/[ T]/)[0]!
        .replace(/[^A-Za-z0-9-]/g, "")
        .slice(0, 12)
    : "";
  const seed = a.url || a.subject || a.detail || "";
  // djb2 — tiny, stable, dependency-free hash → base36 token.
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  const token = h.toString(36);
  return datePart ? `${datePart}-${token}` : token;
}

/**
 * MONEY-803b — resolve the RAG docType for a single announcement. Runs the
 * shared P3b categorizer (`categorizeNseAnnouncement`) over subject + detail and
 * falls back to the generic `corporate_filing` bucket when the categorizer
 * declines (returns `null` for board-meeting / trading-window noise). Pure +
 * deterministic so the passthrough mapping is unit-testable without the network
 * or a DB. The return type is a `StockDocType` literal subset — every value here
 * is a member of that union (see `categorizeNseAnnouncement`).
 */
export function announcementDocType(
  a: ExchangeAnnouncement,
): "corporate_filing" | NseAnnouncementDocType {
  return (
    categorizeNseAnnouncement(a.subject ?? "", a.detail ?? "") ??
    "corporate_filing"
  );
}

/** Pure transform of the NSE announcements payload → typed announcements. */
export function mapAnnouncements(raw: unknown): ExchangeAnnouncement[] {
  return asRows(raw)
    .map((a) => ({
      date: str(a.an_dt ?? a.dt ?? a.date ?? a.exchdisstime),
      subject: str(a.desc ?? a.subject ?? a.smIndustry),
      detail: str(a.attchmntText ?? a.bdesc ?? a.detail),
      // The attachment is the primary official filing (a PDF on the exchange).
      url: str(a.attchmntFile ?? a.url),
    }))
    .filter((a) => a.subject || a.detail);
}

export const fetchExchangeAnnouncementsTool: ResearchToolDef = {
  name: "fetch_exchange_announcements",
  description:
    "Fetch official corporate announcements / exchange filings for a stock from NSE (the listing/official channel), each with its primary filing URL.",
  category: "data",
  parameters: {
    symbol: { type: "string", description: "Stock symbol", required: true },
  },
  cacheTTL: 21600, // 6h
  execute: async (params): Promise<ToolOutput> => {
    const symbol = toNseSymbol(params.symbol as string);
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      // GCS-first: reuse the stored doc (shared NSE/BSE folder) when fresh,
      // else fetch live and store it back.
      const { data: raw, fromCache } = await cachedFetch({
        symbol,
        docType: "announcements",
        ttlMs: 6 * 60 * 60 * 1000, // 6h
        source: ANNOUNCEMENTS_SOURCE,
        fetch: () => getNseClient().getAnnouncements(symbol),
      });
      const announcements = mapAnnouncements(raw);

      // MONEY-798 (P3c): a research run that surfaces a filing with a PDF
      // attachment best-effort enqueues it for the RAG corpus (PENDING →
      // extract → embed chain). The `period` is derived per-filing
      // (`announcementPeriod`) so DISTINCT filings get distinct rows, while the
      // [symbol, exchange, docType, period] unique key keeps the SAME filing
      // idempotent across re-runs (the upsert dedupes).
      //
      // MONEY-803b: classify each filing with the P3b categorizer
      // (`categorizeNseAnnouncement`) instead of stamping every row as a generic
      // `corporate_filing`. This mirrors the sync worker so research-time
      // discovery gets the same docType breadth (investor_presentation /
      // credit_rating / press_release / earnings_call_intimation / annual_report),
      // which drives the right chunker + retrieval downstream. The categorizer
      // returns `null` for low-value noise — we fall back to `corporate_filing`
      // there so a filing with an attachment URL is never silently dropped.
      for (const a of announcements) {
        if (a.url) {
          void enqueueDocumentForRag({
            symbol,
            docType: announcementDocType(a),
            sourceUrl: a.url,
            period: announcementPeriod(a),
          }).catch(() => {});
        }
      }

      return {
        success: true,
        data: announcements,
        metadata: {
          source: ANNOUNCEMENTS_SOURCE,
          sourceTitle: "NSE — Corporate announcements",
          symbol,
          fromCache,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch exchange announcements: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
