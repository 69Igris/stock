/**
 * `fetch_us_13f_holders` — institutional holders of a US issuer, with the
 * quarter-on-quarter change (MONEY-979, T10).
 *
 * DB-only, no egress. Values are ALWAYS whole US dollars, whatever the filing
 * said: SEC Release 34-95148 moved 13F from thousands to dollars for every
 * report FILED on or after 2023-01-03 — keyed on the FILING date, not the
 * period, so a 2023-filed amendment of a 2022 quarter is in dollars while the
 * original was in thousands. The conversion happens once, at parse.
 *
 * ## `exits` is its own array, and that is the point
 *
 * A manager who SOLD OUT has a zero position, so any single list ranked by
 * value puts them last and any `limit` removes them. That is precisely the
 * holder a reader wants: the seller. The repository applies its limit per
 * bucket and this tool keeps the two apart in the payload, so a model reading
 * `holders` can never conclude "nobody sold" from a truncation.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { usToolMetadata, type UsToolResult } from "./fetch-us-financials";

/** One QoQ row, structurally. Mirrors `UsHolderDelta` in core. */
export interface UsHolderDeltaLike {
  managerCik10: string;
  managerName: string | null;
  shares: number;
  valueUsd: number;
  sharesDelta: number;
  valueDelta: number;
  isNew: boolean;
  isExited: boolean;
  /**
   * How many FILED rows this position sums. `1` is the ordinary case.
   *
   * Declared rather than left to the index signature so it is part of the
   * contract: the repository aggregates, and a payload that carried the summed
   * number with no way to see that it was summed is a number a reader cannot
   * reconcile against EDGAR.
   */
  rowsAggregated: number;
  [k: string]: unknown;
}

/** `rowsAggregated`, defended. A missing or junk value means one filed row. */
function rowsSummed(row: UsHolderDeltaLike): number {
  const n = Number(row.rowsAggregated);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Split the repository's single ranked list into the two buckets the payload
 * exposes, and total each side.
 *
 * Pure, so the split is testable without a database — and it is the half a
 * mutation would break: folding `exits` back into `holders` restores exactly
 * the silent-hiding failure the repository's per-bucket limit prevents.
 */
export function partitionHolders(rows: readonly UsHolderDeltaLike[]): {
  holders: UsHolderDeltaLike[];
  exits: UsHolderDeltaLike[];
  totalValueUsd: number;
  netValueDeltaUsd: number;
  newCount: number;
  exitedCount: number;
  aggregatedPositions: number;
  maxRowsAggregated: number;
} {
  const holders = rows.filter((r) => !r.isExited);
  const exits = rows.filter((r) => r.isExited);
  return {
    holders,
    exits,
    // How much of this payload is a SUM rather than a filed row. Counted over
    // both buckets: an exit is aggregated the same way, off its prior filing.
    aggregatedPositions: rows.filter((r) => rowsSummed(r) > 1).length,
    maxRowsAggregated: rows.reduce((max, r) => Math.max(max, rowsSummed(r)), 0),
    totalValueUsd: holders.reduce(
      (sum, r) => sum + (Number(r.valueUsd) || 0),
      0,
    ),
    // Exits are INCLUDED in the net: a quarter where one holder added $1bn and
    // another liquidated $2bn is a net outflow, and a net computed over the
    // held rows alone would report it as an inflow.
    netValueDeltaUsd: rows.reduce(
      (sum, r) => sum + (Number(r.valueDelta) || 0),
      0,
    ),
    newCount: holders.filter((r) => r.isNew).length,
    exitedCount: exits.length,
  };
}

/**
 * Explain a SUMMED position — but only when there is one.
 *
 * `rowsAggregated: 1` is the common case and says nothing, so a permanent
 * sentence about it would be noise the model re-reads on every query. This
 * fires only when at least one position is the sum of several filed rows, which
 * is when the number stops matching anything a reader can find in EDGAR.
 */
export function describeAggregation(split: {
  aggregatedPositions: number;
  maxRowsAggregated: number;
}): string {
  if (split.maxRowsAggregated <= 1) return "";
  return (
    ` ${split.aggregatedPositions} of these positions are the SUM of several filed rows` +
    ` (largest: ${split.maxRowsAggregated} rows). SEC lets one manager file the same CUSIP` +
    ` once per co-manager (\`otherManagers\`) combination, so NO single row in EDGAR will` +
    ` match the share count shown - Berkshire files twelve rows for its Apple position, the` +
    ` largest of them a small fraction of the whole. An AMENDMENT does not add to this count:` +
    ` a newer accession replaces the original wholesale, so it counts rows WITHIN the winning` +
    ` filing, not every row ever filed for the period.`
  );
}

/** The pure half: a repository result → a `ToolOutput`. */
export function buildUs13fOutput(args: {
  symbol: string;
  result: UsToolResult<UsHolderDeltaLike>;
}): ToolOutput {
  const split = partitionHolders(args.result.rows);
  return {
    success: true,
    data: {
      symbol: args.symbol,
      period: args.result.asOf,
      currency: "USD",
      ...split,
      note:
        "Values are whole US dollars. `exits` lists managers who held this issuer last quarter and hold none now - they are reported separately because a zero position sorts last and any top-N truncation would hide the seller. Put/Call rows are options positions and are not share positions. `managerName` is the name on that manager's own 13F cover page; a null means we hold no filing row for the accession evidencing the position, NOT that the manager is unnamed - cite the `managerCik10` in that case rather than calling it unknown." +
        describeAggregation(split),
    },
    metadata: usToolMetadata(args.result, {
      symbol: args.symbol,
      holderCount: split.holders.length,
      exitedCount: split.exitedCount,
    }),
  };
}

export const fetchUs13fHoldersTool: ResearchToolDef = {
  name: "fetch_us_13f_holders",
  description:
    "Fetch institutional holders of a US stock from SEC 13F filings, with quarter-on-quarter share and value changes. Managers who exited the position entirely are returned separately so a top-N list cannot hide a seller.",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "US ticker, e.g. AAPL",
      required: true,
    },
    period: {
      type: "string",
      description:
        "13F report period as an ISO date, e.g. 2026-06-30. Omit for the newest period we hold.",
      required: false,
    },
    limit: {
      type: "number",
      description: "Maximum holders per bucket - held and exited (default: 25)",
      required: false,
      default: 25,
    },
  },
  cacheTTL: 21600,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = String(params.symbol ?? "").trim();
    if (!symbol) return { success: false, error: "symbol is required" };
    const limit = Number(params.limit) > 0 ? Number(params.limit) : 25;
    const period = params.period ? String(params.period) : null;

    const { getTopHolders } = await import("@usemoney/core/us-fundamentals");
    const result = await getTopHolders({ symbol, period, limit });

    return buildUs13fOutput({
      symbol,
      result: result as unknown as UsToolResult<UsHolderDeltaLike>,
    });
  },
};
