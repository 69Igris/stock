/**
 * Comparative Valuation - Peer-relative valuation analysis
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { ComparativeValuation, NsePeerData } from "../types";

export const computeComparativeValuationTool: ResearchToolDef = {
  name: "compute_comparative_valuation",
  description: "Calculate peer-relative valuation (PE/PB/EV ratios vs peers)",
  category: "computation",
  parameters: {
    symbol: {
      type: "string",
      description: "Target stock symbol",
      required: true,
    },
    currentPrice: {
      type: "number",
      description: "Current stock price",
      required: true,
    },
    pe: { type: "number", description: "Target PE ratio" },
    pb: { type: "number", description: "Target PB ratio" },
    evToEbitda: { type: "number", description: "Target EV/EBITDA" },
    peers: {
      type: "object[]",
      description:
        "Array of peer data with symbol, name, pe, pb, evToEbitda, roe, marketCap",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    const currentPrice = params.currentPrice as number;
    const pe = params.pe as number | undefined;
    const pb = params.pb as number | undefined;
    const evToEbitda = params.evToEbitda as number | undefined;
    const peers = params.peers as NsePeerData[];

    if (!symbol || !currentPrice) {
      return {
        success: false,
        error: "symbol and currentPrice are required",
      };
    }

    // If no peers available, return partial result with just the company's own metrics
    if (!peers?.length) {
      return {
        success: true,
        data: {
          symbol,
          currentPrice,
          peers: [],
          relativeValuation: {
            peRelative: 1,
            pbRelative: 1,
            evEbitdaRelative: 1,
            verdict: "fairly_valued" as const,
          },
        },
        metadata: {
          note: "No peer data available - valuation is relative to self",
        },
      };
    }

    try {
      // Calculate peer averages
      const peerPEs = peers.map((p) => p.pe).filter((v) => v > 0);
      const peerPBs = peers.map((p) => p.pb).filter((v) => v > 0);

      const avgPE =
        peerPEs.length > 0
          ? peerPEs.reduce((a, b) => a + b, 0) / peerPEs.length
          : 0;
      const avgPB =
        peerPBs.length > 0
          ? peerPBs.reduce((a, b) => a + b, 0) / peerPBs.length
          : 0;

      // Relative valuation
      const peRelative = pe && avgPE ? pe / avgPE : 1;
      const pbRelative = pb && avgPB ? pb / avgPB : 1;
      const evEbitdaRelative = 1; // Simplified - NSE peers may not have this

      // Determine verdict based on averages
      const avgRelative = (peRelative + pbRelative) / 2;
      let verdict: "undervalued" | "fairly_valued" | "overvalued";
      if (avgRelative < 0.85) verdict = "undervalued";
      else if (avgRelative > 1.15) verdict = "overvalued";
      else verdict = "fairly_valued";

      const result: ComparativeValuation = {
        symbol,
        currentPrice,
        peers: peers.map((p) => ({
          symbol: p.symbol,
          name: p.companyName,
          pe: p.pe,
          pb: p.pb,
          marketCap: p.marketCap,
        })),
        relativeValuation: {
          peRelative: Math.round(peRelative * 100) / 100,
          pbRelative: Math.round(pbRelative * 100) / 100,
          evEbitdaRelative: Math.round(evEbitdaRelative * 100) / 100,
          verdict,
        },
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Comparative valuation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
