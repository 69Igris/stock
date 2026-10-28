/**
 * Fetch Bulk & Block Deals — DB-FIRST, live NSE fallback (MONEY-1204 / 14e.2).
 *
 * ## What changed, and why it is more than a source swap
 *
 * This tool is called `fetch_bulk_block_deals` and it never fetched a bulk or
 * block deal. It hit NSE's `getTradeInfo` / `getCorporateActions` live — trade
 * INFO, which is delivery volume and a corporate-action list — and had ZERO
 * Prisma references, so "which institution bought how much of this stock, and
 * when" was a question the agent could not answer and did not know it could not
 * answer.
 *
 * `InstitutionalDeal` holds exactly that: the disclosed counterparty, side,
 * quantity, price and BULK-vs-BLOCK type, deduped on an all-fields SHA-256 so a
 * rolling snapshot re-serving yesterday's print collapses while two genuine
 * same-day prints by the same client at different prices both survive.
 *
 * The old live call is kept as the fallback, not deleted — the table is new,
 * and its trade-info payload is still the only thing available in an
 * environment that has not back-filled. It is returned as `liveContext`,
 * clearly labelled, rather than dressed up as deals it is not.
 *
 * `qty` is a Prisma `BigInt` (a single print in a high-float penny name exceeds
 * Int32) and is coerced to a number before it can reach `JSON.stringify`, which
 * THROWS on a BigInt rather than degrading.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { getNseClient } from "../data-sources/nse-client";
import {
  emptyCited,
  type CitedRows,
  type DealRow,
} from "../data-sources/market-structure-logic";

export interface BulkBlockLiveContext {
  tradeInfo?: unknown;
  corporateActions?: unknown;
}

export interface BulkBlockResult {
  cited: CitedRows<DealRow>;
  /** The old live payload — delivery/trade info and corporate actions. Only
   *  fetched when the DB had no deals, and never presented as deals. */
  liveContext: BulkBlockLiveContext | null;
}

/**
 * DB-first resolution. Exported so the ordering and the labelling are testable
 * against the SAME code `execute` runs.
 *
 * The live path runs ONLY when the DB returned no deals — the happy path costs
 * no egress at all, which is the whole point of the inversion.
 */
export async function resolveBulkBlockDeals(
  dbFetch: () => Promise<CitedRows<DealRow> | null>,
  liveFetch: () => Promise<BulkBlockLiveContext | null>,
): Promise<BulkBlockResult> {
  let dbError: string | undefined;
  try {
    const cited = await dbFetch();
    if (cited && cited.rows.length > 0) return { cited, liveContext: null };
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  let liveContext: BulkBlockLiveContext | null = null;
  let liveError: string | undefined;
  try {
    liveContext = await liveFetch();
  } catch (err) {
    liveError = err instanceof Error ? err.message : String(err);
  }

  const sourceError = dbError ?? liveError;
  const hasLive =
    liveContext !== null &&
    (liveContext.tradeInfo !== undefined ||
      liveContext.corporateActions !== undefined);

  return {
    // Still an EMPTY CITED result, not an error: NSE only publishes a deal when
    // one crossed the disclosure threshold, so "no deals" is usually a finding.
    cited: emptyCited<DealRow>(
      "InstitutionalDeal",
      hasLive
        ? "No disclosed bulk/block deals in the window. Live NSE trade info is attached as context — it is delivery/corporate-action data, NOT deals."
        : "No disclosed bulk/block deals in the window, and the live NSE trade-info fallback returned nothing either.",
      {
        fallback: true,
        ...(sourceError ? { sourceError } : {}),
      },
    ),
    liveContext: hasLive ? liveContext : null,
  };
}

export const fetchBulkBlockDealsTool: ResearchToolDef = {
  name: "fetch_bulk_block_deals",
  description:
    "Fetch disclosed bulk & block deals (counterparty, side, quantity, price) for a stock from InstitutionalDeal, with live NSE trade info as fallback context",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "NSE symbol (e.g., RELIANCE)",
      required: true,
    },
    days: {
      type: "number",
      description: "Lookback window in days (default: 90, max: 365)",
      required: false,
      default: 90,
    },
    dealType: {
      type: "string",
      description: "Restrict to BULK or BLOCK. Omit for both.",
      required: false,
    },
  },
  cacheTTL: 3600,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = String(params.symbol ?? "")
      .replace(/\.(NS|BO)$/i, "")
      .toUpperCase();

    if (!symbol) {
      return { success: false, error: "symbol is required" };
    }

    const days = Math.min(Math.max((params.days as number) || 90, 1), 365);
    const rawType = params.dealType;
    const dealType = rawType === "BULK" || rawType === "BLOCK" ? rawType : null;

    const { cited, liveContext } = await resolveBulkBlockDeals(
      // Lazy import inside the thunk — see the MONEY-1060 note in
      // fetch-fii-dii-flows.ts.
      async () => {
        const { getDealsFromDb } =
          await import("../data-sources/market-structure-store");
        return getDealsFromDb({ symbol, days, dealType });
      },
      async () => {
        const nse = getNseClient();
        const [tradeInfo, corporateActions] = await Promise.allSettled([
          nse.getTradeInfo(symbol),
          nse.getCorporateActions(symbol),
        ]);
        const out: BulkBlockLiveContext = {};
        if (tradeInfo.status === "fulfilled" && tradeInfo.value) {
          out.tradeInfo = tradeInfo.value;
        }
        if (corporateActions.status === "fulfilled" && corporateActions.value) {
          out.corporateActions = corporateActions.value;
        }
        return out;
      },
    );

    return {
      success: true,
      data: {
        symbol,
        rows: cited.rows,
        asOf: cited.asOf,
        provenance: cited.provenance,
        ...(liveContext ? { liveContext } : {}),
      },
      metadata: {
        symbol,
        source: cited.provenance.source,
        origin: cited.provenance.origin,
        fallback: cited.provenance.fallback === true,
        days,
        recordCount: cited.rows.length,
        ...(cited.provenance.sourceError
          ? { sourceError: cited.provenance.sourceError }
          : {}),
      },
    };
  },
};
