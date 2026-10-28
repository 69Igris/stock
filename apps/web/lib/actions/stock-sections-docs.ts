"use server";

/**
 * Stock-page DOCUMENT section actions — MONEY-1204 (P14 / 14c.7, 14c.8, 14c.9).
 *
 *   14c.7  getStockFilingsTimelineAction   filings & documents timeline
 *   14c.8  getStockFinancialsSourceAction  financials source badge + basis toggle
 *   14c.9  getStockFundsHoldingAction      which MF schemes hold this stock
 *
 * These are THIN wrappers. All three read global market data with no per-user
 * component, so there is no auth check, no demo branch and no `revalidatePath`
 * — the same shape as `getStockPeersAction` in `stock-tabs.ts`. The queries, the
 * cache policy and the provenance envelope live in
 * `@usemoney/services/stock-sections-docs.service`, so this action and the
 * `apps/api` `/v1/stocks/:symbol/*` mirror run the SAME code rather than two
 * copies that drift (the standing api-parity rule).
 *
 * The caching is deliberately NOT duplicated here. The house pattern puts a
 * cache-first read at the top of the action, but doing that on top of a service
 * that already caches gives two keys for one payload and two TTLs to keep in
 * step — and the `apps/api` mirror would get only the inner one. One cache, in
 * the service, is the version of that rule a reviewer does not have to enforce
 * by eye. The service also owns the two invariants that matter: a missing row
 * returns `success: true` with an empty envelope (never a 404), and neither an
 * empty result nor a failure is ever written to cache.
 */

import {
  getStockFilingsTimeline,
  getStockFinancialsSource,
  getStockFundsHolding,
  type ServiceResult,
  type StockFilingsTimelineData,
  type StockFinancialsSourceData,
  type StockFundsHoldingData,
  type WithProvenance,
} from "@usemoney/services";

// Re-exported so components import one module rather than reaching into the
// services package. `export type` is erased at compile time, which is what
// keeps this legal in a `"use server"` file (every VALUE export must be an
// async function).
export type {
  StockFilingsTimelineData,
  StockFinancialsSourceData,
  StockFundsHoldingData,
};

export interface StockSectionArgs {
  symbol: string;
  exchange: string;
}

/**
 * 14c.7 — the filings timeline: documents we have indexed for this company,
 * newest-INDEXED first, with the next scheduled event pinned on top.
 *
 * "Indexed", not "filed": `StockDocument` carries no filing-date column, so the
 * payload's date field is `indexedAt` and the section says so.
 */
export async function getStockFilingsTimelineAction(
  args: StockSectionArgs
): Promise<ServiceResult<WithProvenance<StockFilingsTimelineData>>> {
  try {
    return await getStockFilingsTimeline(args);
  } catch (error) {
    console.error("getStockFilingsTimelineAction error:", error);
    return { success: false, error: "Failed to load filings timeline" };
  }
}

/**
 * 14c.8 — what `stock_financials.source` actually says, plus the XBRL filing
 * drill-down split by (basis, cumulative).
 */
export async function getStockFinancialsSourceAction(
  args: StockSectionArgs
): Promise<ServiceResult<WithProvenance<StockFinancialsSourceData>>> {
  try {
    return await getStockFinancialsSource(args);
  } catch (error) {
    console.error("getStockFinancialsSourceAction error:", error);
    return { success: false, error: "Failed to load financials provenance" };
  }
}

/**
 * 14c.9 — which mutual-fund schemes hold this stock, and what changed month on
 * month.
 */
export async function getStockFundsHoldingAction(
  args: StockSectionArgs
): Promise<ServiceResult<WithProvenance<StockFundsHoldingData>>> {
  try {
    return await getStockFundsHolding(args);
  } catch (error) {
    console.error("getStockFundsHoldingAction error:", error);
    return { success: false, error: "Failed to load fund ownership" };
  }
}
