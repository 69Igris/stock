/**
 * Paper-trading pure-logic helpers (service layer).
 *
 * These are the side-effect-free calculation/aggregation helpers used by the
 * paper-trading service (`./paper.service.ts`: `getPaperPortfolio`,
 * `createPaperTrade`, `closePaperTrade`, `updatePaperPrices`). They are isolated
 * here (away from the Prisma-importing service) so they can be unit-tested
 * without pulling in the Prisma client at import time, and — critically — so the
 * LIVE paper-trading money path runs the SAME non-finite-guarded math the
 * regression tests assert.
 *
 * The paper-trading service is reachable by callers WITHOUT the web Zod gate
 * (`apps/api/src/routes/v1/paper.ts` passes `await c.req.json()` straight into
 * `createPaperTrade`; `closePaperTrade` reads `body.exitPrice` raw). So a
 * non-finite `quantity`/`averagePrice`/`exitPrice`/`currentPrice` can reach this
 * math and — without a guard — would:
 *
 *   - poison the paper PORTFOLIO total (`totalInvested`/`totalCurrent`/
 *     `totalPnL`) into `NaN`/`Infinity` (the Paper-Trading header renders
 *     "₹NaN"), because a sum is a poison surface (one bad addend wins);
 *   - PERSIST `NaN`/`Infinity` into `realizedPnL`/`currentValue`/`unrealizedPnL`/
 *     `pnlPercentage` (Prisma `Float` accepts them) — corrupting the row for
 *     every future read;
 *   - make `pnlPercentage` `Infinity` (the old `investedValue > 0` gate passes
 *     for `Infinity`) or the literal string `"NaN"`;
 *   - return a non-finite `pnl` that the web action feeds to
 *     `pnl.toLocaleString("en-IN")` → "₹NaN" in the success toast;
 *   - throw `RangeError: Invalid time value` from `.toISOString()` on a corrupt
 *     `entryDate`/`exitDate`/`expiryDate`, 500-ing the WHOLE portfolio response.
 *
 * Behaviour here is identical, for FINITE inputs, to the math that previously
 * lived inline in the service; the service now calls these helpers.
 *
 * Mirrors the `finite()`-guard precedent in `./dashboard-logic.ts` /
 * `./holdings-logic.ts` / `./positions-logic.ts`.
 */

// ---------------------------------------------------------------------------
// Non-finite guard (LOCAL — intentionally NOT imported from a sibling
// *-logic.ts so this module stays self-contained, the disjoint-file rule holds,
// and the web/api tests can import it via a relative path without dragging
// another service's surface in). Mirrors ./dashboard-logic.ts#finite.
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * `??`/`|| 0` do NOT catch `NaN` in every path and NEVER catch `±Infinity`;
 * `Math.abs(NaN)` is still `NaN`. So every value that enters a sum, a product, a
 * ratio, a persisted Prisma `Float`, or a downstream
 * `.toFixed()`/`.toLocaleString()`/`Number()` is funnelled through this guard
 * first. `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback`
 * (default 0).
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Safe ISO date (full ISO timestamp)
// ---------------------------------------------------------------------------

/**
 * Format a `Date` (or anything read off a Prisma row) as a full ISO string,
 * returning `undefined` for a missing or Invalid Date instead of throwing.
 *
 * `new Date("garbage").toISOString()` throws `RangeError: Invalid time value`.
 * `entryDate`/`exitDate`/`expiryDate` are stored timestamps; a corrupt/legacy
 * row (or a garbage `entryDate`/`expiryDate` string handed to
 * `createPaperTrade` by a non-web caller) can deserialize to an Invalid Date,
 * and ONE such row used to throw inside the position `.map()` and 500 the ENTIRE
 * paper-portfolio response. We probe `getTime()` (finite epoch) before calling
 * `.toISOString()`.
 *
 * `entryDate` is required in the output shape, so the service falls back to
 * `new Date().toISOString()` when this returns `undefined`; the optional
 * `exitDate`/`expiryDate` simply degrade to `undefined`.
 */
export function safeToIso(
  value: Date | string | number | null | undefined,
): string | undefined {
  if (value == null) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  const time = d.getTime();
  if (!Number.isFinite(time)) return undefined;
  return d.toISOString();
}

/**
 * Parse a `Date | string` into a VALID `Date`, or `undefined` for a
 * missing/garbage value — so a corrupt `entryDate`/`expiryDate` string passed to
 * `createPaperTrade` never persists an Invalid Date (which would then throw on
 * every later `.toISOString()` read). The service substitutes `new Date()` for a
 * required date when this returns `undefined`.
 */
export function safeDate(
  value: Date | string | number | null | undefined,
): Date | undefined {
  if (value == null) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

// ---------------------------------------------------------------------------
// P&L percentage
// ---------------------------------------------------------------------------

/**
 * P&L percentage as a finite number, `0` when the cost basis is not a usable
 * positive finite number OR the P&L itself is non-finite.
 *
 * The old inline guard was only `investedValue > 0` — which leaks two ways:
 *   - `Infinity > 0` is `true`, so an `Infinity` invested would divide;
 *   - a finite positive invested with an `Infinity` P&L yields `Infinity` %.
 * Both reach a persisted `Float` / a `.toFixed()` as `Infinity`. We require BOTH
 * operands finite and the divisor strictly positive.
 *
 * Behaviour-preserving for finite inputs: identical to
 * `investedValue > 0 ? (pnl / investedValue) * 100 : 0`.
 */
export function pnlPercentage(pnl: number, investedValue: number): number {
  if (!Number.isFinite(investedValue) || investedValue <= 0) return 0;
  if (!Number.isFinite(pnl)) return 0;
  return (pnl / investedValue) * 100;
}

// ---------------------------------------------------------------------------
// Per-position market value & unrealized P&L
// ---------------------------------------------------------------------------

/**
 * Current (mark-to-market) value of a position = `currentPrice * quantity`,
 * finite-guarded so a corrupt price/qty yields `0` rather than `NaN`/`Infinity`.
 * Mirrors the inline `update.currentPrice * position.quantity`.
 */
export function currentValue(currentPrice: number, quantity: number): number {
  return finite(finite(currentPrice) * finite(quantity));
}

/**
 * Invested value (cost basis) of a position = `averagePrice * quantity`,
 * finite-guarded. Mirrors `data.quantity * data.averagePrice` in
 * `createPaperTrade`.
 */
export function investedValue(averagePrice: number, quantity: number): number {
  return finite(finite(averagePrice) * finite(quantity));
}

/**
 * Unrealized P&L for an OPEN position, from value endpoints.
 *   LONG : `currentValue - investedValue`
 *   SHORT: `investedValue - currentValue`
 * Both addends are finite-guarded so a corrupt value never yields
 * `NaN`/`Infinity`. Mirrors the `updatePaperPrices` ternary.
 */
export function unrealizedPnL(
  positionType: string,
  currentVal: number,
  investedVal: number,
): number {
  const c = finite(currentVal);
  const i = finite(investedVal);
  return positionType === "LONG" ? c - i : i - c;
}

/**
 * Derive the full finite-guarded mark-to-market bundle for an OPEN position on a
 * price update: `{ currentValue, unrealizedPnL, pnlPercentage }`. This is the
 * exact tuple `updatePaperPrices` persists; centralised so the write is always
 * finite (the Prisma `Float` write happens for api/worker callers too).
 */
export interface MarkToMarket {
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
}

export function markToMarket(
  positionType: string,
  currentPrice: number,
  quantity: number,
  investedVal: number,
): MarkToMarket {
  const cv = currentValue(currentPrice, quantity);
  const iv = finite(investedVal);
  const pnl = unrealizedPnL(positionType, cv, iv);
  return {
    currentValue: cv,
    unrealizedPnL: pnl,
    pnlPercentage: pnlPercentage(pnl, iv),
  };
}

// ---------------------------------------------------------------------------
// Realized P&L on close
// ---------------------------------------------------------------------------

/**
 * Realized P&L when CLOSING a position.
 *   LONG : `(exitPrice - averagePrice) * quantity`
 *   SHORT: `(averagePrice - exitPrice) * quantity`
 * Every operand is finite-guarded and the product is re-guarded, so a corrupt
 * `exitPrice`/`averagePrice`/`quantity` (a non-web caller, a poisoned row) can
 * never return `NaN`/`Infinity` — which would otherwise be PERSISTED as
 * `realizedPnL` AND fed to `pnl.toLocaleString("en-IN")` ("₹NaN") in the web
 * action's success toast.
 *
 * Behaviour-preserving for finite inputs (an `exitPrice < averagePrice` is a
 * legitimate loss; a `quantity <= 0` simply yields a `0`/negative number — these
 * are valid finite outcomes, not errors).
 */
export function realizedPnL(
  positionType: string,
  exitPrice: number,
  averagePrice: number,
  quantity: number,
): number {
  const exit = finite(exitPrice);
  const avg = finite(averagePrice);
  const qty = finite(quantity);
  const pnl = positionType === "LONG" ? (exit - avg) * qty : (avg - exit) * qty;
  return finite(pnl);
}

// ---------------------------------------------------------------------------
// Create-position normalization (guard the PERSISTED write)
// ---------------------------------------------------------------------------

/** The numeric fields `createPaperTrade` persists for a paper position. */
export interface NormalizedCreateValues {
  quantity: number;
  averagePrice: number;
  investedValue: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
}

/**
 * Normalize the raw create-position input into the finite-guarded numbers the
 * service persists, so a NaN/Infinity slipping past a missing Zod gate
 * (`apps/api` POST /v1/paper) cannot write a corrupt paper position.
 *
 * Mirrors the service defaults exactly for FINITE inputs:
 *   - `currentPrice` defaults to `averagePrice` (`trade.currentPrice || trade.averagePrice`);
 *   - `currentValue` defaults to `investedValue` (`trade.currentValue || trade.investedValue`);
 *   - `unrealizedPnL` / `pnlPercentage` default to `0`.
 * The only behavioural change is that each field is finite-guarded (a non-finite
 * value collapses to `0`, and a non-finite `currentPrice` falls back to the
 * guarded `averagePrice`).
 *
 * NOTE: `investedValue` is taken as provided (guarded), NOT recomputed from
 * `quantity * averagePrice`, to preserve the original service contract (the web
 * caller computes `investedValue` itself and the service trusted it verbatim).
 */
export function normalizeCreateValues(input: {
  quantity: number;
  averagePrice: number;
  investedValue: number;
  currentPrice?: number | null;
  currentValue?: number | null;
  unrealizedPnL?: number | null;
  pnlPercentage?: number | null;
}): NormalizedCreateValues {
  const quantity = finite(input.quantity);
  const averagePrice = finite(input.averagePrice);
  const invested = finite(input.investedValue);
  // `|| averagePrice` preserves the original fallback (0/NaN are falsy);
  // finite() additionally neutralises a stored ±Infinity.
  const currentPrice = finite(input.currentPrice || averagePrice);
  const curValue = finite(input.currentValue || invested);
  return {
    quantity,
    averagePrice,
    investedValue: invested,
    currentPrice,
    currentValue: curValue,
    unrealizedPnL: finite(input.unrealizedPnL || 0),
    pnlPercentage: finite(input.pnlPercentage || 0),
  };
}

// ---------------------------------------------------------------------------
// Portfolio summary aggregation
// ---------------------------------------------------------------------------

/** The status + monetary fields the portfolio summary reduce reads off a row. */
export interface PaperSummaryInput {
  status: string;
  investedValue: number;
  currentValue: number;
}

export interface PaperPortfolioTotals {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: number;
  openPositions: number;
  closedPositions: number;
}

/**
 * Sum the paper-portfolio summary across positions. ONLY `status === "OPEN"`
 * rows contribute to the value/P&L totals (matching the service); every addend
 * is finite-guarded so ONE corrupt OPEN row cannot turn `totalInvested`/
 * `totalCurrent`/`totalPnL` into `NaN`/`Infinity` ("₹NaN" header). `totalPnL` is
 * derived from the (already finite) totals — `totalCurrent - totalInvested` — so
 * it can never be `Infinity - Infinity = NaN`. `pnlPercentage` uses the strict
 * finite/positive divisor guard (never `Infinity`).
 *
 * Behaviour-preserving for finite inputs: identical to the inline
 * `openPositions.reduce((s, p) => s + p.investedValue, 0)` trio + the
 * `totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0` summary.
 */
export function summarizePaperPortfolio(
  positions: PaperSummaryInput[],
): PaperPortfolioTotals {
  let totalInvested = 0;
  let totalCurrent = 0;
  let openCount = 0;
  let closedCount = 0;
  for (const p of positions) {
    if (p.status === "OPEN") {
      totalInvested += finite(p.investedValue);
      totalCurrent += finite(p.currentValue);
      openCount += 1;
    } else if (p.status === "CLOSED") {
      closedCount += 1;
    }
  }
  const totalPnL = totalCurrent - totalInvested;
  return {
    totalInvested,
    totalCurrent,
    totalPnL,
    pnlPercentage: pnlPercentage(totalPnL, totalInvested),
    openPositions: openCount,
    closedPositions: closedCount,
  };
}
