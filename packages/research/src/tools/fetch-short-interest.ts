/**
 * Fetch Short Interest (India)
 *
 * India does NOT publish single-stock short interest the way US markets do
 * (e.g. FINRA's bi-monthly short-interest report). NSE only exposes SLB
 * (Securities Lending & Borrowing), F&O ban lists, and open-interest data —
 * none of which the research NSE client currently surfaces, and none of which
 * is a faithful proxy for true short interest.
 *
 * Per the product's graceful-degradation decision, this tool makes a best-effort
 * attempt against the NSE client and, when no reliable short-interest source is
 * available (the expected outcome in India), returns available:false with an
 * honest reason so the synthesizer renders "—" instead of fabricating a number.
 *
 * SEBI compliance: observations / flags only. No buy/sell/hold language.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { getNseClient } from "../data-sources/nse-client";

export interface ShortInterestResult {
  available: boolean;
  symbol: string;
  /** Present only when available:false — why no short-interest figure exists. */
  reason?: string;
  /** Short interest as a % of float, when a reliable source exists. */
  shortInterestPercent?: number;
  /** Whether a true single-stock short-interest source was found. */
  hasShortInterest?: boolean;
  /** Honest note on what India does/doesn't publish (SLB / OI context). */
  note?: string;
  /** Observation-only flags (never advice). */
  flags?: string[];
}

const NO_SOURCE_REASON =
  "NSE does not publish single-stock short interest; SLB/OI proxy unavailable";

export const fetchShortInterestTool: ResearchToolDef = {
  name: "fetch_short_interest",
  description:
    "Attempt to fetch single-stock short-interest / SLB positioning for an NSE symbol (India typically does not publish this)",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "NSE symbol (e.g., RELIANCE)",
      required: true,
    },
  },
  cacheTTL: 86400, // 24h — degraded result is stable; avoids repeated NSE hits
  execute: async (params): Promise<ToolOutput> => {
    const rawSymbol = typeof params.symbol === "string" ? params.symbol : "";
    const symbol = rawSymbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

    if (!symbol) {
      return { success: false, error: "symbol is required" };
    }

    try {
      const nse = getNseClient();

      // The NSE client exposes no SLB, F&O ban-list, or open-interest method,
      // so there is no faithful single-stock short-interest source. We probe
      // trade_info purely to confirm the symbol is live on NSE; we NEVER derive
      // a short-interest number from it (delivery % is not short interest).
      let symbolKnownOnNse = false;
      try {
        const tradeInfo = await nse.getTradeInfo(symbol);
        symbolKnownOnNse = tradeInfo != null;
      } catch {
        // Probe failure does not change the outcome — no source exists either way.
        symbolKnownOnNse = false;
      }

      // Expected, correct outcome for Indian equities: degrade honestly.
      const result: ShortInterestResult = {
        available: false,
        symbol,
        reason: NO_SOURCE_REASON,
        hasShortInterest: false,
        note: symbolKnownOnNse
          ? "Symbol is listed on NSE, but Indian markets do not disclose single-stock short interest. NSE offers SLB (securities lending & borrowing), F&O open interest, and ban lists — none of which is a reliable short-interest proxy and none is currently sourced here."
          : "Indian markets do not disclose single-stock short interest. NSE offers SLB, F&O open interest, and ban lists, but none is a reliable short-interest proxy and none is currently sourced here.",
        flags: [],
      };

      return { success: true, data: result };
    } catch (error) {
      // Genuine runtime exception (not just absent data).
      return {
        success: false,
        error: `Short interest fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
