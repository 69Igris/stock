/**
 * Fetch Related-Party Transactions (RPT)
 *
 * Surfaces related-party transaction disclosures. The authoritative source is
 * the annual-report RPT note (PDFs land in GCS via stock-document-fetcher).
 * v1 cannot extract line items: full RPT extraction needs the annual-report
 * RAG/embedding pipeline (MONEY-270), which is NOT yet wired.
 *
 * What this tool does today: calls fetchScreenerDocuments(symbol) and reports
 * which annual-report / disclosure documents exist plus citation links, so the
 * synthesizer can point the user at primary sources instead of fabricating
 * RPT figures. Outputs OBSERVATIONS / citations only — no advice language.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { fetchScreenerDocuments } from "../data-sources/screener-client";

export interface RelatedPartySourceDoc {
  type: string;
  title: string;
  url: string | null;
  period: string;
  source?: string;
}

export interface RelatedPartyResult {
  available: boolean;
  symbol: string;
  /** Populated only when structured RPT data can be extracted (not yet wired). */
  transactions: never[];
  /** Annual-report / disclosure documents that likely contain the RPT note. */
  sourceDocs: RelatedPartySourceDoc[];
  /** Human-readable observations (no buy/sell/hold language). */
  observations: string[];
  /** Explanation when available === false. */
  reason?: string;
}

const RAG_NOT_WIRED_REASON =
  "Related-party detail requires annual-report RAG (MONEY-270); not yet wired";

export const fetchRelatedPartyTool: ResearchToolDef = {
  name: "fetch_related_party",
  description:
    "Surface related-party transaction disclosures - cites annual-report/disclosure docs (line-item extraction pending RAG)",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "NSE/BSE symbol (e.g., RELIANCE)",
      required: true,
    },
  },
  cacheTTL: 86400, // 24h - disclosures change at most quarterly/annually
  execute: async (params): Promise<ToolOutput> => {
    const rawSymbol = params.symbol;
    if (typeof rawSymbol !== "string" || rawSymbol.trim() === "") {
      return { success: false, error: "symbol is required" };
    }

    const symbol = rawSymbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

    try {
      const docs = await fetchScreenerDocuments(symbol);

      // Keep only documents that plausibly carry the RPT note: annual reports
      // disclose RPT in the notes to accounts; credit ratings frequently flag
      // related-party exposures.
      const relevant = Array.isArray(docs)
        ? docs.filter(
            (d) => d.type === "annual_report" || d.type === "credit_rating",
          )
        : [];

      const sourceDocs: RelatedPartySourceDoc[] = relevant.map((d) => ({
        type: d.type,
        title: d.title,
        url: d.url ?? null,
        period: d.period,
        source: d.source,
      }));

      // No structured RPT line items can be produced without the RAG pipeline,
      // so we always degrade — but with a helpful pointer plus any doc links.
      const observations: string[] = [];
      if (sourceDocs.length > 0) {
        const annualCount = sourceDocs.filter(
          (d) => d.type === "annual_report",
        ).length;
        if (annualCount > 0) {
          observations.push(
            `${annualCount} annual report${annualCount === 1 ? "" : "s"} found for ${symbol} - related-party transactions are disclosed in the notes to accounts of each.`,
          );
        }
        const ratingCount = sourceDocs.filter(
          (d) => d.type === "credit_rating",
        ).length;
        if (ratingCount > 0) {
          observations.push(
            `${ratingCount} credit-rating document${ratingCount === 1 ? "" : "s"} found - these often note related-party exposures.`,
          );
        }
      } else {
        observations.push(
          `No annual-report or disclosure documents could be located for ${symbol} via Screener.`,
        );
      }

      const result: RelatedPartyResult = {
        available: false,
        symbol,
        transactions: [],
        sourceDocs,
        observations,
        reason:
          sourceDocs.length > 0
            ? `${RAG_NOT_WIRED_REASON}. See the linked annual-report/disclosure documents for the RPT note.`
            : RAG_NOT_WIRED_REASON,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Related-party fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
