/**
 * Fetch FII/DII Flows Tool — DB-FIRST, live NSE fallback (MONEY-1204 / 14e.2).
 *
 * Daily buy/sell/net for Foreign and Domestic Institutional Investors.
 *
 * ## Why the order flipped
 *
 * This tool scraped NSE live and had ZERO Prisma references. We now ingest the
 * same numbers ourselves into `InstitutionalFlow`, on a schedule, with history
 * and an idempotency key — so the DB is both cheaper and DEEPER than the live
 * endpoint, which serves a rolling window. The live path is kept as the
 * fallback rather than deleted, because the table is new and an environment
 * that has not back-filled would otherwise lose the tool entirely.
 *
 * `{ rows, asOf, provenance }` throughout, so the synthesizer can say WHICH of
 * the two answered — and `asOf` is the newest row's own trading day, never the
 * fetch time. Values are in ₹ CRORE, NSE's own unit, unconverted.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  fetchFIIDIIFlows,
  type FIIDIISummary,
} from "../data-sources/nse-fii-dii";
import {
  dbFirstWithLiveFallback,
  newestAsOf,
  num,
  type CitedRows,
  type FlowRow,
} from "../data-sources/market-structure-logic";

/**
 * The live NSE summary → the same `FlowRow` shape the DB returns.
 *
 * One source day becomes TWO rows (FII and DII), which is the grain
 * `InstitutionalFlow` stores and the grain `@@unique([date, category, segment])`
 * enforces — so the fallback is a drop-in and nothing downstream has to branch
 * on which path answered.
 */
export function summaryToFlowRows(summary: FIIDIISummary | null): FlowRow[] {
  if (!summary?.flows?.length) return [];
  const out: FlowRow[] = [];
  for (const f of summary.flows) {
    const date = new Date(f.date);
    const iso = Number.isFinite(date.getTime())
      ? date.toISOString()
      : String(f.date);
    for (const [category, leg] of [
      ["FII", f.fii],
      ["DII", f.dii],
    ] as const) {
      if (!leg) continue;
      out.push({
        date: iso,
        category,
        segment: "CASH",
        buyValue: num(leg.buyValue),
        sellValue: num(leg.sellValue),
        netValue: num(leg.netValue),
        source: "NSE_LIVE",
      });
    }
  }
  return out;
}

/**
 * DB-first resolution, exported so the ordering is unit-testable against the
 * SAME code `execute` runs (inject fake DB/live readers — no network, no DB).
 */
export async function resolveFiiDiiFlows(
  dbFetch: () => Promise<CitedRows<FlowRow> | null>,
  liveFetch: () => Promise<FIIDIISummary | null>,
): Promise<CitedRows<FlowRow>> {
  return dbFirstWithLiveFallback<FlowRow>(
    dbFetch,
    async () => {
      const rows = summaryToFlowRows(await liveFetch());
      return {
        rows,
        asOf: newestAsOf(rows),
        provenance: { origin: "LIVE", source: "NSE India (fii-dii)" },
      };
    },
    {
      source: "InstitutionalFlow",
      emptyNote:
        "Neither the synced `InstitutionalFlow` table nor the live NSE endpoint returned flows for this window.",
    },
  );
}

/** Net totals per category. Sums the NET column NSE publishes rather than
 *  re-deriving buy − sell, because a publisher correction to the net is data we
 *  would otherwise discard. */
export function summariseFlows(rows: readonly FlowRow[]): {
  fiiNetTotal: number;
  diiNetTotal: number;
  trend: "fii_buying" | "fii_selling" | "balanced";
} {
  let fiiNetTotal = 0;
  let diiNetTotal = 0;
  for (const r of rows) {
    // A null net is NOT REPORTED, so it contributes nothing — not a zero that
    // drags the total toward neutral.
    if (r.netValue === null) continue;
    if (r.category === "FII") fiiNetTotal += r.netValue;
    else if (r.category === "DII") diiNetTotal += r.netValue;
  }
  const trend =
    fiiNetTotal > 0 && fiiNetTotal > Math.abs(diiNetTotal) * 0.5
      ? "fii_buying"
      : fiiNetTotal < 0 && Math.abs(fiiNetTotal) > Math.abs(diiNetTotal) * 0.5
        ? "fii_selling"
        : "balanced";
  return {
    fiiNetTotal: Math.round(fiiNetTotal * 100) / 100,
    diiNetTotal: Math.round(diiNetTotal * 100) / 100,
    trend,
  };
}

export const fetchFiiDiiFlowsTool: ResearchToolDef = {
  name: "fetch_fii_dii_flows",
  description:
    "Fetch daily FII/DII (Foreign & Domestic Institutional Investor) buy/sell/net cash flow data - DB-first from InstitutionalFlow, live NSE as fallback",
  category: "data",
  parameters: {
    days: {
      type: "number",
      description:
        "Number of recent trading days to fetch (default: 10, max: 90)",
      required: false,
      default: 10,
    },
    category: {
      type: "string",
      description: "Restrict to FII or DII. Omit for both.",
      required: false,
    },
  },
  cacheTTL: 14_400, // 4 hours
  execute: async (params): Promise<ToolOutput> => {
    const rawDays = params.days as number | undefined;
    const days = Math.min(Math.max(rawDays || 10, 1), 90);
    const rawCategory = params.category;
    const category =
      rawCategory === "FII" || rawCategory === "DII" ? rawCategory : null;

    const cited = await resolveFiiDiiFlows(
      // Lazy import INSIDE the thunk: `market-structure-store` pulls in
      // `@usemoney/database`, which instantiates PrismaClient at module scope.
      // Loading it eagerly would kill the tool in a Prisma-broken environment
      // where the live fallback alone would have succeeded (MONEY-1060 fix 9).
      async () => {
        const { getFlowsFromDb } =
          await import("../data-sources/market-structure-store");
        // A trading day is not a calendar day — widen the window so `days`
        // sessions actually fit inside it.
        return getFlowsFromDb({ days: Math.ceil(days * 1.6) + 7, category });
      },
      () => fetchFIIDIIFlows(days),
    );

    const rows = category
      ? cited.rows.filter((r) => r.category === category)
      : cited.rows;
    const totals = summariseFlows(rows);

    return {
      success: true,
      data: {
        rows,
        asOf: cited.asOf,
        provenance: cited.provenance,
        ...totals,
        interpretation: buildInterpretation(totals),
      },
      metadata: {
        source: cited.provenance.source,
        origin: cited.provenance.origin,
        fallback: cited.provenance.fallback === true,
        days,
        recordCount: rows.length,
        ...(cited.provenance.sourceError
          ? { sourceError: cited.provenance.sourceError }
          : {}),
      },
    };
  },
};

/**
 * Build a human-readable interpretation of FII/DII flow data.
 */
function buildInterpretation(summary: {
  fiiNetTotal: number;
  diiNetTotal: number;
  trend: string;
}): string {
  const parts: string[] = [];

  // FII summary
  if (summary.fiiNetTotal > 0) {
    parts.push(
      `FII/FPI have been net buyers with total net inflow of Rs ${formatCrore(summary.fiiNetTotal)} crore.`,
    );
  } else if (summary.fiiNetTotal < 0) {
    parts.push(
      `FII/FPI have been net sellers with total net outflow of Rs ${formatCrore(Math.abs(summary.fiiNetTotal))} crore.`,
    );
  } else {
    parts.push("FII/FPI activity has been broadly neutral.");
  }

  // DII summary
  if (summary.diiNetTotal > 0) {
    parts.push(
      `DII have been net buyers with total net inflow of Rs ${formatCrore(summary.diiNetTotal)} crore.`,
    );
  } else if (summary.diiNetTotal < 0) {
    parts.push(
      `DII have been net sellers with total net outflow of Rs ${formatCrore(Math.abs(summary.diiNetTotal))} crore.`,
    );
  } else {
    parts.push("DII activity has been broadly neutral.");
  }

  // Trend
  if (summary.trend === "fii_buying") {
    parts.push(
      "Overall trend: Foreign institutional buying - typically bullish for markets.",
    );
  } else if (summary.trend === "fii_selling") {
    parts.push(
      "Overall trend: Foreign institutional selling - domestic institutions may be providing counter-support.",
    );
  } else {
    parts.push(
      "Overall trend: Balanced activity between foreign and domestic institutions.",
    );
  }

  return parts.join(" ");
}

function formatCrore(value: number): string {
  return Math.abs(value).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
}
