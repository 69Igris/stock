/**
 * Pure P&L math for `useLivePositions`.
 *
 * Extracted from the hook so the per-position P&L computation can be
 * unit-tested without React, and — critically — guarded against the
 * non-finite class: a zero `entryPrice` would make `pnlPercentage` a
 * division-by-zero (Infinity / NaN) that then poisons any aggregate or
 * renders as "₹NaN". The hook imports `calculatePositionPnL` /
 * `calculateTotalPnL` / `calculateTotalDayPnL` — there is no dead duplicate.
 */

import type { Position, LivePosition } from "./useLivePositions";

/** Coerce a non-finite number (NaN / ±Infinity) to 0. */
function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute live P&L for a single position.
 *
 * `multiplier` flips sign for SELL (short) positions. `pnlPercentage` is
 * finite-guarded so a 0 entryPrice yields 0% rather than Infinity/NaN.
 */
export function calculatePositionPnL(
  position: Position,
  currentPrice: number,
  quote?: { change?: number; changePercent?: number }
): LivePosition {
  const multiplier = position.action === "BUY" ? 1 : -1;

  const pnl = finite(
    (currentPrice - position.entryPrice) * position.quantity * multiplier
  );

  const pnlPercentage =
    position.entryPrice !== 0
      ? finite(
          ((currentPrice - position.entryPrice) / position.entryPrice) *
            100 *
            multiplier
        )
      : 0;

  const dayChange = finite(
    (quote?.change ?? 0) * position.quantity * multiplier
  );
  const dayChangePercent = finite(quote?.changePercent ?? 0);

  return {
    ...position,
    currentPrice,
    pnl,
    pnlPercentage,
    dayChange,
    dayChangePercent,
  };
}

/** Sum of position P&L (finite-guarded against poisoned rows). */
export function calculateTotalPnL(positions: LivePosition[]): number {
  return finite(positions.reduce((sum, p) => sum + finite(p.pnl), 0));
}

/** Sum of position day-change (finite-guarded against poisoned rows). */
export function calculateTotalDayPnL(positions: LivePosition[]): number {
  return finite(positions.reduce((sum, p) => sum + finite(p.dayChange), 0));
}
