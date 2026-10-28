/**
 * Fetch India VIX — `IndexClose` where `indexSlug = "india-vix"`
 * (MONEY-1204 / 14e.2).
 *
 * The volatility index, as our own ingest already holds it. Verified against
 * the archive rather than assumed:
 *
 *     India VIX,14-08-2026,11.4175,11.56,10.825,11.31,-,-,-,-,-
 *
 * with depth reaching back to H1-2014. So this needs no scrape and no fallback:
 * the table IS the source.
 *
 * ## Those five trailing `-`
 *
 * Volume, Turnover, P/E, P/B and Dividend Yield are `null` on EVERY India VIX
 * row, and that is correct, not missing: a volatility index has no basket to
 * value, so there is nothing to measure. They must never render as 0 — a 0 P/E
 * reads as a screaming-cheap index in any screen built on this table, and a 0
 * turnover reads as a dead market. The row type keeps all five
 * `number | null` and the tool ships an explicit `notReported` list so the
 * synthesizer states the absence instead of quoting a zero.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  summarizeVix,
  type CitedRows,
  type VixRow,
} from "../data-sources/market-structure-logic";

/**
 * The columns India VIX never reports, named explicitly.
 *
 * Shipping the list beats hoping every consumer notices the nulls: it turns
 * "the data is missing" into "this index has no basket to value", which is the
 * fact, and it is the difference between a caveat and a wrong number.
 */
export const VIX_NOT_REPORTED = [
  "volume",
  "turnoverCr",
  "pe",
  "pb",
  "divYield",
] as const;

/** Rough regime read. Bands are the market's conventional ones, not a model. */
export function vixRegime(latest: number | null): string {
  if (latest === null) return "unknown";
  if (latest < 12) return "complacent";
  if (latest < 16) return "calm";
  if (latest < 22) return "elevated";
  return "stressed";
}

export const fetchVixTool: ResearchToolDef = {
  name: "fetch_vix",
  description:
    "Fetch India VIX (volatility index) history and its current level, mean, range and regime, from IndexClose",
  category: "data",
  parameters: {
    days: {
      type: "number",
      description: "Lookback window in days (default: 90, max: 1825)",
      required: false,
      default: 90,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const days = Math.min(Math.max((params.days as number) || 90, 1), 1825);

    // Lazy import inside the call — see the MONEY-1060 note in
    // fetch-fii-dii-flows.ts.
    const { getVixFromDb } =
      await import("../data-sources/market-structure-store");
    const cited: CitedRows<VixRow> = await getVixFromDb({ days });
    const summary = summarizeVix(cited.rows);

    return {
      success: true,
      data: {
        rows: cited.rows,
        asOf: cited.asOf,
        provenance: cited.provenance,
        ...summary,
        regime: vixRegime(summary.latest),
        notReported: [...VIX_NOT_REPORTED],
        note: "Volume, turnover, P/E, P/B and dividend yield are null for India VIX and must not be rendered as 0 - a volatility index has no basket to value.",
      },
      metadata: {
        source: cited.provenance.source,
        origin: cited.provenance.origin,
        days,
        recordCount: cited.rows.length,
        ...(cited.provenance.sourceError
          ? { sourceError: cited.provenance.sourceError }
          : {}),
      },
    };
  },
};
