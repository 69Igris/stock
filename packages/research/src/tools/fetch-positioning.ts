/**
 * Fetch Positioning — `MarketPositioning` (MONEY-1204 / 14e.2).
 *
 * Participant-wise F&O long/short: who is long index futures, who is short
 * stock options, and how that moved.
 *
 * ## CRITICAL — this table holds TWO INCOMPATIBLE GRAINS
 *
 * `nse-fao-participant-oi` / `-vol` write `metric` `OI` | `VOLUME` for four
 * participants (CLIENT, DII, FII, PRO) over six buckets
 * (`FUT_IDX FUT_STK OPT_IDX_CALL OPT_IDX_PUT OPT_STK_CALL OPT_STK_PUT`), in
 * contract COUNTS only — the lot size is not in those files, so a rupee value
 * cannot be derived and is not stored.
 *
 * `nse-fii-stats` writes `metric: "FII_STATS"` for the SAME participant on the
 * SAME days, over its OWN bucket namespace (`IDX_FUT`, `IDX_OPT`, `STK_FUT`,
 * `STK_OPT`, plus per-underlying breakdowns like `IDX_OPT:NIFTY`), and DOES
 * carry ₹ crore. The namespaces are deliberately ordered opposite (`IDX_FUT`
 * here, `FUT_IDX` there) so the two can never be confused at a glance.
 *
 * Two rules follow, and this tool enforces both:
 *
 *   1. **ALWAYS filter on `metric`.** It is a required parameter, and it goes
 *      into the `where`. Open interest is a STOCK (positions standing at close)
 *      and volume is a FLOW (contracts traded during the day) — same schema,
 *      incomparable magnitudes.
 *   2. **Inside FII_STATS, a bucket containing `:` is a BREAKDOWN of the total
 *      that has none.** `IDX_OPT` IS the sum of `IDX_OPT:NIFTY`,
 *      `IDX_OPT:BANKNIFTY`, … so summing both double-counts every index. The
 *      default grain is TOTALS; `sumPositioning` REFUSES a mixed set rather
 *      than returning a plausible-looking number that is twice what it should
 *      be.
 */

import { FII_STATS_METRIC } from "@usemoney/core/market-data";

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  selectPositioningRows,
  sumPositioning,
  type CitedRows,
  type PositioningGrain,
  type PositioningRow,
} from "../data-sources/market-structure-logic";

/** The metrics `MarketPositioning` currently holds. */
export const POSITIONING_METRICS = ["OI", "VOLUME", FII_STATS_METRIC] as const;

function normalizeGrain(v: unknown): PositioningGrain {
  return v === "BREAKDOWNS" || v === "ALL" ? v : "TOTALS";
}

export const fetchPositioningTool: ResearchToolDef = {
  name: "fetch_positioning",
  description:
    "Fetch participant-wise F&O positioning (CLIENT/DII/FII/PRO long, short, net) from MarketPositioning. Requires a metric: OI or VOLUME (contract counts) or FII_STATS (FII only, with rupee values and per-underlying breakdowns).",
  category: "data",
  parameters: {
    metric: {
      type: "string",
      description:
        "REQUIRED. OI | VOLUME | FII_STATS. The table holds two incompatible grains and an unfiltered read mixes a stock with a flow.",
      required: true,
    },
    participant: {
      type: "string",
      description: "CLIENT | DII | FII | PRO. Omit for all four.",
      required: false,
    },
    bucket: {
      type: "string",
      description:
        "Bucket within the metric's own namespace (FUT_IDX… for OI/VOLUME; IDX_FUT… for FII_STATS). Omit for all.",
      required: false,
    },
    grain: {
      type: "string",
      description:
        "TOTALS (default) | BREAKDOWNS | ALL. Only meaningful for FII_STATS, where a bucket containing ':' is a per-underlying breakdown OF the total that has none.",
      required: false,
      default: "TOTALS",
    },
    days: {
      type: "number",
      description: "Lookback window in days (default: 30, max: 365)",
      required: false,
      default: 30,
    },
  },
  cacheTTL: 14_400,
  execute: async (params): Promise<ToolOutput> => {
    const metric = String(params.metric ?? "").trim();
    if (!metric) {
      return {
        success: false,
        error:
          "metric is required (OI | VOLUME | FII_STATS). MarketPositioning holds two incompatible grains — open interest is a stock, volume is a flow, and FII_STATS is a separate namespace with rupee values — so an unfiltered read cannot be interpreted.",
      };
    }
    if (!(POSITIONING_METRICS as readonly string[]).includes(metric)) {
      return {
        success: false,
        error: `Unknown metric "${metric}". Known metrics: ${POSITIONING_METRICS.join(", ")}.`,
      };
    }

    const grain = normalizeGrain(params.grain);
    const days = Math.min(Math.max((params.days as number) || 30, 1), 365);
    const participant =
      typeof params.participant === "string" && params.participant.trim()
        ? params.participant.trim().toUpperCase()
        : null;
    const bucket =
      typeof params.bucket === "string" && params.bucket.trim()
        ? params.bucket.trim()
        : null;

    // Lazy import inside the call — see the MONEY-1060 note in
    // fetch-fii-dii-flows.ts.
    const { getPositioningFromDb } =
      await import("../data-sources/market-structure-store");
    const cited: CitedRows<PositioningRow> = await getPositioningFromDb({
      metric,
      participant,
      bucket,
      days,
    });

    // Belt and braces: the `where` already pinned the metric, but the grain
    // split happens here and re-asserting the metric costs nothing and makes
    // this function safe to call with rows from anywhere.
    const rows = selectPositioningRows(cited.rows, { metric, grain });
    const total = sumPositioning(rows);

    return {
      success: true,
      data: {
        rows,
        asOf: cited.asOf,
        provenance: cited.provenance,
        metric,
        grain,
        // A refusal is a first-class answer here: it means the caller asked for
        // a set whose sum would be meaningless (mixed metrics) or
        // double-counted (FII_STATS totals + their breakdowns).
        total: total.ok ? total.sum : null,
        totalRefusedBecause: total.ok ? null : total.detail,
        note:
          metric === FII_STATS_METRIC
            ? "FII_STATS buckets containing ':' are per-underlying BREAKDOWNS of the total bucket with no ':'. Never sum both — the parent IS the sum of its children."
            : "OI/VOLUME rows are contract COUNTS only; the participant files carry no lot size, so every rupee column is null by design (not zero).",
      },
      metadata: {
        source: cited.provenance.source,
        origin: cited.provenance.origin,
        metric,
        grain,
        days,
        recordCount: rows.length,
        ...(cited.provenance.sourceError
          ? { sourceError: cited.provenance.sourceError }
          : {}),
      },
    };
  },
};
