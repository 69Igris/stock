/**
 * Positions pure-logic helpers (service layer).
 *
 * These are the side-effect-free calculation/classification helpers used by
 * `getPositions` and `getClosedTodayPositions` in `./positions.service.ts`.
 * They are isolated here (away from the Prisma-importing service) so they can
 * be unit-tested without pulling in the Prisma client at import time, and —
 * critically — so the LIVE F&O-positions money path runs the SAME
 * non-finite-guarded math the regression tests assert.
 *
 * Behaviour here is identical, for FINITE inputs, to the logic that previously
 * lived inline in `getPositions` / `getClosedTodayPositions`; the service now
 * calls these helpers. The only intentional behavioural differences are
 * defensive:
 *   - a `NaN`/`±Infinity` `lastPrice`/`buyPrice`/`sellPrice`/`netQuantity`
 *     (a corrupt broker-sync row) can no longer poison the position summary
 *     (`totalInvested`, `unrealizedPnL`) into `NaN`/`Infinity` ("₹NaN"), nor
 *     the per-row market value / MTM% surfaced to the UI;
 *   - a divide-by-zero cost basis (zero-price option, fully-hedged net value)
 *     can no longer make MTM%/return% `Infinity`/`NaN`;
 *   - an Invalid-Date `tradeDate`/`closedAt` can no longer throw `RangeError`
 *     on `.toISOString()`.
 *
 * Mirrors the `finite()`-guard precedent in `./dashboard-logic.ts`.
 */

// ---------------------------------------------------------------------------
// Non-finite guard (local, mirrors ./dashboard-logic.ts#finite)
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * A position summary is a SUM surface: a single `NaN`/`Infinity` addend poisons
 * the whole reduce (one corrupt position row => the Positions tab renders
 * "₹NaN"). Broker `netValue`/`unrealizedPnl`/`lastPrice` are occasionally
 * `NaN`/`Infinity` (a divide that went wrong upstream, a corrupt sync row), so
 * every value that enters a sum, a product, a ratio, or a
 * `.toFixed()`/`.toLocaleString()` is funnelled through this guard first.
 * `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback` (default 0).
 *
 * Local to this module by design (the disjoint-file rule): it intentionally
 * duplicates `./dashboard-logic.ts#finite` rather than importing it, so the two
 * services never couple through a shared edit.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Direction classification (net quantity sign)
// ---------------------------------------------------------------------------

/**
 * LONG when net quantity is strictly positive, else SHORT. A flat (0) or
 * non-finite net quantity classifies as SHORT — matching the original inline
 * `netQuantity > 0 ? "LONG" : "SHORT"` (a `NaN > 0` is `false` → SHORT). Flat
 * positions are excluded upstream by the `netQuantity: { not: 0 }` query, so
 * the 0 case is only reachable via a direct helper call / a poisoned row.
 */
export function classifyPositionDirection(
  netQuantity: number,
): "LONG" | "SHORT" {
  return netQuantity > 0 ? "LONG" : "SHORT";
}

/** Human label for the position direction ("Long" / "Short"). */
export function positionDirectionLabel(netQuantity: number): "Long" | "Short" {
  return netQuantity > 0 ? "Long" : "Short";
}

/**
 * Order side implied by a net quantity: a net-long book reads as a BUY, a
 * net-short book as a SELL. Mirrors the inline `netQuantity > 0 ? "BUY" : "SELL"`.
 */
export function tradeTypeForQuantity(netQuantity: number): "BUY" | "SELL" {
  return netQuantity > 0 ? "BUY" : "SELL";
}

/**
 * Displayable absolute quantity. `Math.abs(NaN) === NaN` and
 * `Math.abs(Infinity) === Infinity`, both of which would leak into a
 * `.toLocaleString()` on the row, so the result is finite-guarded to 0.
 */
export function absQuantity(netQuantity: number): number {
  return finite(Math.abs(finite(netQuantity)));
}

// ---------------------------------------------------------------------------
// Per-position market value & MTM
// ---------------------------------------------------------------------------

/**
 * Mark-to-market notional of an OPEN position = |netQuantity| * lastPrice.
 * Both factors are finite-guarded so a corrupt `lastPrice`/`netQuantity`
 * cannot produce a non-finite market value (`Infinity`/`NaN`) for the row or
 * the portfolio total. Uses the ABSOLUTE quantity so a short book reports a
 * positive notional exposure (matching the dashboard's
 * `Math.abs(netQuantity * lastPrice)`).
 */
export function positionMarketValue(
  netQuantity: number,
  lastPrice: number,
): number {
  return finite(Math.abs(finite(netQuantity) * finite(lastPrice)));
}

/**
 * Unrealized P&L for an open position from prices, when the broker does not
 * provide a pre-computed value. LONG: (last - avg) * qty; SHORT: (avg - last) *
 * |qty|. Finite-guarded end-to-end so a poisoned price/qty yields 0, not a
 * non-finite that poisons the summary. (The live service prefers the stored
 * `unrealizedPnl`; this is the price-derived fallback / demo-parity helper.)
 */
export function positionUnrealizedPnL(
  netQuantity: number,
  averagePrice: number,
  lastPrice: number,
): number {
  const qty = finite(netQuantity);
  const avg = finite(averagePrice);
  const ltp = finite(lastPrice);
  // Long books gain when price rises; short books gain when price falls. Using
  // signed qty makes both cases collapse to (ltp - avg) * qty.
  return finite((ltp - avg) * qty);
}

/**
 * Cost basis (absolute invested notional) of an open position. Prefers the
 * broker `netValue` magnitude (what `totalInvested` historically summed); falls
 * back to |avg * qty| when netValue is missing/non-finite. Always finite & >= 0.
 */
export function positionCostBasis(
  netValue: number | null | undefined,
  averagePrice: number,
  netQuantity: number,
): number {
  const fromNetValue = finite(Math.abs(finite(netValue)));
  if (fromNetValue > 0) return fromNetValue;
  return finite(Math.abs(finite(averagePrice) * finite(netQuantity)));
}

/**
 * Return percentage = pnl / costBasis * 100, clamped to a finite number.
 * A zero (or non-finite) cost basis — a zero-price option, a fully-hedged net
 * value — would make the raw ratio `Infinity`/`NaN`; we return `0` instead so
 * no `Infinity`/`NaN` reaches a `.toFixed()`/chart. Behaviour-preserving for a
 * normal positive cost basis.
 */
export function positionReturnPct(pnl: number, costBasis: number): number {
  const base = finite(costBasis);
  if (base <= 0) return 0;
  return finite((finite(pnl) / base) * 100);
}

// ---------------------------------------------------------------------------
// Summary aggregation (open positions)
// ---------------------------------------------------------------------------

/** Minimal shape the open-positions summary needs from each mapped row. */
export interface PositionSummaryInput {
  netQuantity: number;
  /** Broker net value (signed). May be null / non-finite on a corrupt row. */
  tradeValue: number | null;
  /** Pre-computed (or price-derived) unrealized P&L for the row. */
  unrealizedPnL: number;
  /** Last traded price — used for the mark-to-market notional total. */
  lastPrice: number;
}

export interface PositionSummaryTotals {
  totalPositions: number;
  totalInvested: number;
  unrealizedPnL: number;
  longPositions: number;
  shortPositions: number;
  /** Σ |netQuantity * lastPrice| — finite mark-to-market notional. */
  marketValue: number;
  /** Book return % = unrealizedPnL / totalInvested * 100, clamped finite. */
  returnPct: number;
}

/**
 * Aggregate the open-positions summary in a single O(n) pass.
 *
 * - `totalInvested` sums |tradeValue| (finite-guarded per addend) — one corrupt
 *   `netValue` can no longer turn the whole invested total into NaN/Infinity.
 * - `unrealizedPnL` sums each row's P&L (finite-guarded) — same poison guard.
 * - `marketValue` sums each row's finite mark-to-market notional
 *   (`positionMarketValue`).
 * - `returnPct` divides the summed P&L by the summed cost basis, clamped via
 *   `positionReturnPct` so a zero/short-hedged invested total never yields
 *   `Infinity`/`NaN`.
 * - long/short counts use the strict-positive sign (0 / non-finite → neither),
 *   matching the original `filter(p => p.netQuantity > 0)` / `< 0`. A `NaN`
 *   net quantity counts as NEITHER long nor short (both comparisons are false),
 *   exactly like the original two independent filters.
 */
export function summarizeOpenPositions(
  rows: PositionSummaryInput[],
): PositionSummaryTotals {
  let totalInvested = 0;
  let unrealizedPnL = 0;
  let marketValue = 0;
  let longPositions = 0;
  let shortPositions = 0;

  for (const row of rows) {
    // `|| 0` keeps the original null-coalesce; finite() additionally neutralises
    // a stored ±Infinity netValue before it enters the |abs| sum.
    totalInvested += finite(Math.abs(finite(row.tradeValue || 0)));
    unrealizedPnL += finite(row.unrealizedPnL);
    marketValue += positionMarketValue(row.netQuantity, row.lastPrice);
    if (row.netQuantity > 0) longPositions += 1;
    else if (row.netQuantity < 0) shortPositions += 1;
  }

  return {
    totalPositions: rows.length,
    totalInvested,
    unrealizedPnL,
    longPositions,
    shortPositions,
    marketValue,
    returnPct: positionReturnPct(unrealizedPnL, totalInvested),
  };
}

// ---------------------------------------------------------------------------
// Closed-today (intraday squared-off) realized P&L
// ---------------------------------------------------------------------------

/**
 * Start of the local day (today at 00:00:00.000). Used as the `tradeDate >= …`
 * window bound for intraday squared-off positions. Returned as a fresh Date so
 * callers can't mutate a shared instance.
 */
export function startOfToday(now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Realized P&L for a position closed today.
 *
 * Zerodha's `realised` field is frequently 0, so when BOTH legs have a positive
 * price AND a positive quantity we derive it from prices: (sell - buy) * qty.
 * Otherwise we trust the stored `realizedPnl`. The whole result is
 * finite-guarded: a non-finite stored P&L, or a non-finite price slipping past
 * the `> 0` gate (`Infinity > 0` is `true`!), can no longer reach the UI as
 * `NaN`/`Infinity`.
 *
 * Behaviour-preserving for ordinary finite inputs (the price-derived branch and
 * the stored-fallback branch are exactly the original ternary).
 */
export function computeClosedTodayRealizedPnL(input: {
  buyPrice: number;
  sellPrice: number;
  quantity: number;
  realizedPnl: number;
}): number {
  const buy = input.buyPrice;
  const sell = input.sellPrice;
  const qty = input.quantity;
  const priceDerived =
    Number.isFinite(sell) &&
    Number.isFinite(buy) &&
    Number.isFinite(qty) &&
    sell > 0 &&
    buy > 0 &&
    qty > 0;
  return priceDerived ? finite((sell - buy) * qty) : finite(input.realizedPnl);
}

// ---------------------------------------------------------------------------
// Safe date formatting
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` for a Date, or `null` for an Invalid Date / missing date.
 * `new Date("garbage").toISOString()` throws `RangeError`; one corrupt
 * `tradeDate`/`closedAt` would otherwise crash the whole positions response.
 * Returning `null` lets the UI render an honest "—" instead.
 */
export function safeIsoDate(date: Date | null | undefined): string | null {
  if (date == null) return null;
  const time = date.getTime?.();
  if (time == null || !Number.isFinite(time)) return null;
  // ISO timestamps always contain a "T", so [0] is always a string.
  return date.toISOString().split("T")[0]!;
}
