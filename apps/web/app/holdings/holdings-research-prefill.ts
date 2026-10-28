/**
 * MONEY-400 — Holdings → Research pre-fill transform.
 *
 * Pure logic extracted from app/holdings/client.tsx (the row → `positionPrefill`
 * literal, repeated at two render sites, and the `HoldingRowActions`
 * prefill → `positionData` step). Both render sites now call
 * {@link holdingToPositionPrefill}; `HoldingRowActions` calls
 * {@link prefillToPositionData}. End-to-end that equals
 * {@link holdingToPositionPreData}, which is what the unit test asserts — so the
 * test exercises the REAL production path, not a copy.
 */

/** Holdings feed doesn't track a per-row entry date yet (MONEY-407). */
export const PREFILL_PURCHASE_DATE = "since first lot";

/** The holding-row fields the pre-fill reads. */
export interface HoldingPrefillInput {
  quantity: number;
  t1Quantity?: number | null;
  averagePrice: number;
  currentPrice: number;
  unrealizedPnL: number;
}

/** The prefill payload forwarded to `HoldingRowActions`. */
export interface PositionPrefill {
  quantity: number;
  purchasePrice: number;
  purchaseDate: string;
  currentPrice: number;
  unrealizedPnL: number;
}

/** The `positionData` shape ResearchModal consumes. */
export interface PositionPreData extends PositionPrefill {
  status: "open" | "closed";
}

/**
 * Holding row → prefill. T1 (next-day-settlement) quantity rolls into the total
 * so the agent sees the full position; avg price becomes the purchase price.
 */
export function holdingToPositionPrefill(
  h: HoldingPrefillInput
): PositionPrefill {
  return {
    quantity: h.quantity + (h.t1Quantity ?? 0),
    purchasePrice: h.averagePrice,
    purchaseDate: PREFILL_PURCHASE_DATE,
    currentPrice: h.currentPrice,
    unrealizedPnL: h.unrealizedPnL,
  };
}

/**
 * Prefill → ResearchModal `positionData`. A holdings row is always an OPEN
 * position — we never infer "closed" from a negative unrealized P&L.
 */
export function prefillToPositionData(
  prefill: PositionPrefill
): PositionPreData {
  return { status: "open", ...prefill };
}

/** The full holding → positionData transform (the end-to-end production path). */
export function holdingToPositionPreData(
  h: HoldingPrefillInput
): PositionPreData {
  return prefillToPositionData(holdingToPositionPrefill(h));
}
