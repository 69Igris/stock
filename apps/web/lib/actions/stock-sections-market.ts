"use server";

/**
 * Stock-page market sections — MONEY-1204 (P14 / 14c.1 · 14c.2 · 14c.3).
 *
 *   14c.1  header badges (`StockFlag`) + index chips (`IndexMembership`)
 *   14c.2  overview delivery chip + trend (`DailyPrice.deliveryPct`)
 *   14c.3  F&O section (`DerivativeSummary` / `SlbPosition` / `MwplDaily` /
 *          `StockFlag` kind `FO_BAN`), gated to F&O names
 *
 * THIN WRAPPERS, deliberately. The read logic, the `discover`/`_global` cache
 * keys and TTLs, the absence rules and the provenance envelope all live ONCE in
 * `@usemoney/services#stock-sections-market.service`, which `apps/api`'s
 * `/v1/stocks/:symbol/*` routes call directly. The older stock-tab actions
 * predate that arrangement and keep a second copy of their queries; copying
 * that here would re-create exactly the web-vs-mobile drift the standing rule
 * exists to prevent. Precedent: `discover-indices.ts#getIndicesAction` over
 * `getIndices`.
 *
 * NO auth, NO demo branch, NO `revalidatePath` — this is global market data
 * with no user scope, the same as `stock-tabs.ts` and `discover-market`.
 *
 * A missing row is `success: true` with an EMPTY envelope, never an error and
 * never a 404: the component owns the empty state and `SectionShell` renders
 * the sentence. `empty` on the envelope is the field it branches on.
 */

import {
  getStockDeliveryTrend,
  getStockDerivatives,
  getStockFlagsAndIndexes,
  type ServiceResult,
  type StockDeliveryData,
  type StockDerivativesData,
  type StockFlagsAndIndexesData,
  type StockFoBanState,
  type StockFlagHistoryRow,
  type WithProvenance,
} from "@usemoney/services";

// Re-exported so a client component imports its props from ONE place (the
// action it calls) instead of reaching into the services package itself.
export type {
  StockDeliveryData,
  StockDerivativesData,
  StockFlagsAndIndexesData,
  StockFlagHistoryRow,
  StockFoBanState,
  WithProvenance,
};

/**
 * 14c.1 — current exchange flags + open index memberships for the header.
 *
 * One call for both because they share a strip of chrome above the price and a
 * header that renders in two waves is worse than one that renders slightly
 * later. Flags supply the envelope's `asOf`; each index chip carries its own
 * `lastSeen`, because membership and surveillance do not update on the same
 * cadence.
 */
export async function getStockFlagsAction(args: {
  symbol: string;
  exchange: string;
  /** Rows fetched per flag kind — also the history-popover depth. Max 200. */
  rowsPerKind?: number;
}): Promise<ServiceResult<WithProvenance<StockFlagsAndIndexesData>>> {
  return getStockFlagsAndIndexes(args);
}

/**
 * 14c.2 — delivery % headline, 20-session mean and a 60-session mini-series.
 *
 * The mean SKIPS sessions NSE printed `-` for and reports how many actually
 * contributed; see `computeDeliveryTrend` for why averaging those as zero
 * understates delivery on exactly the illiquid names where it matters.
 */
export async function getStockDeliveryAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<WithProvenance<StockDeliveryData>>> {
  return getStockDeliveryTrend(args);
}

/**
 * 14c.3 — the F&O section, gated on `DerivativeSummary` having any row.
 *
 * `data.isFno === false` means the stock has no derivatives at all; the caller
 * must render NOTHING rather than an empty F&O tab.
 */
export async function getStockDerivativesAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<WithProvenance<StockDerivativesData>>> {
  return getStockDerivatives(args);
}
