/**
 * Holdings pure-logic helpers (service layer).
 *
 * These are the side-effect-free calculation/aggregation helpers used by
 * `getHoldings` in `./holdings.service.ts` (the user-facing holdings money
 * path: `apps/web/lib/actions/holdings.ts` → `getHoldingsService`). They are
 * isolated here, away from the Prisma-importing service, so they can be
 * unit-tested without pulling in the Prisma client at import time, and —
 * critically — so the LIVE holdings path runs the SAME non-finite-guarded math
 * the regression tests assert.
 *
 * Behaviour here is identical, for FINITE inputs, to the math that previously
 * lived inline in `getHoldings`; the service now calls these helpers. The only
 * intentional behavioural differences are defensive and user-facing:
 *
 *   - a `NaN`/`±Infinity` field on ONE corrupt holding row (a divide that went
 *     wrong upstream, a partial/garbage broker sync) can no longer poison the
 *     whole portfolio `totalInvested`/`totalCurrent`/`totalPnL` total ("₹NaN")
 *     or any sector/exchange subtotal;
 *   - the per-holding `pnlPercentage` and the summary `pnlPercentage` can no
 *     longer be `Infinity` / the literal string `"NaN"` (a div-by-non-positive
 *     or non-finite invested clamps to `0` / `"0"`);
 *   - an Invalid-Date `createdAt` can no longer throw `RangeError` on
 *     `.toISOString()` (the holdings query used to 500 for the whole portfolio).
 *
 * Mirrors the `finite()`-guard precedent in `./dashboard-logic.ts`.
 */

// ---------------------------------------------------------------------------
// Non-finite guard (LOCAL — intentionally not imported from dashboard-logic so
// this module stays self-contained and the worker/web tests can import it via a
// relative path without dragging the dashboard surface in).
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * Holdings aggregation is a SUM surface: a single `NaN`/`Infinity` addend
 * poisons the whole reduce (one bad holding row => the page renders "₹NaN").
 * `??`/`|| 0` do NOT catch `NaN` (it is non-null and falsy-but-numeric in some
 * paths) and never catch `±Infinity`; `Math.abs(NaN)` / `Math.max(0, NaN)` are
 * still `NaN`. So every value that enters a sum, a ratio, or a downstream
 * `.toFixed()`/`.toLocaleString()`/`Number()` is funnelled through this guard
 * first. `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback`
 * (default 0). Mirrors `./dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Safe ISO date (YYYY-MM-DD)
// ---------------------------------------------------------------------------

/**
 * Format a `Date` (or anything `getHoldings` reads off a Prisma row) as a
 * `YYYY-MM-DD` string, returning `undefined` for a missing or Invalid Date
 * instead of throwing.
 *
 * `new Date("garbage").toISOString()` throws `RangeError: Invalid time value`.
 * `createdAt` is a stored timestamp; a corrupt/legacy row can deserialize to an
 * Invalid Date, and one such row used to throw inside the `.map()` and 500 the
 * ENTIRE holdings response. We probe `getTime()` (finite epoch) before calling
 * `.toISOString()`.
 */
export function safeToDateString(
  value: Date | string | number | null | undefined,
): string | undefined {
  if (value == null) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  const time = d.getTime();
  if (!Number.isFinite(time)) return undefined;
  // ISO timestamps always contain a "T", so [0] is always a string.
  return d.toISOString().split("T")[0]!;
}

// ---------------------------------------------------------------------------
// Minimal structural input types (subset of the Prisma Holding selection used
// by getHoldings). Kept narrow so callers can pass selected rows directly.
// ---------------------------------------------------------------------------

/** The numeric/identity fields the value math reads off a holding row. */
export interface HoldingValuesInput {
  quantity: number;
  t1Quantity: number | null;
  averagePrice: number;
  currentPrice: number;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
}

/** The derived, finite-guarded per-holding monetary values. */
export interface HoldingValues {
  t1Quantity: number;
  effectiveQuantity: number;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
}

// ---------------------------------------------------------------------------
// Per-holding value derivation (T1 settlement + finite guards)
// ---------------------------------------------------------------------------

/**
 * Derive a single holding's invested / current / P&L / P&L% with T1-settlement
 * handling, every output finite-guarded.
 *
 * Settlement rule (behaviour-preserving): when the settled `quantity > 0` the
 * service TRUSTS the broker-stored `investedValue`/`currentValue`/
 * `unrealizedPnL`; otherwise (only T1/unsettled stock left) it RECOMPUTES from
 * `effectiveQuantity * price`. The non-finite guards mean a corrupt stored
 * value (or a corrupt price/qty in the recompute branch) contributes a safe `0`
 * rather than `NaN`/`Infinity`.
 */
export function computeHoldingValues(
  holding: HoldingValuesInput,
): HoldingValues {
  const t1 = finite(holding.t1Quantity); // `?? 0` then finite-guard
  const quantity = finite(holding.quantity);
  const effectiveQty = quantity + t1;

  const investedValue =
    quantity > 0
      ? finite(holding.investedValue)
      : finite(effectiveQty * finite(holding.averagePrice));
  const currentValue =
    quantity > 0
      ? finite(holding.currentValue)
      : finite(effectiveQty * finite(holding.currentPrice));
  const unrealizedPnL =
    quantity > 0 ? finite(holding.unrealizedPnL) : currentValue - investedValue;

  return {
    t1Quantity: t1,
    effectiveQuantity: effectiveQty,
    investedValue,
    currentValue,
    unrealizedPnL,
    pnlPercentage: pnlPercentage(unrealizedPnL, investedValue),
  };
}

// ---------------------------------------------------------------------------
// P&L percentage
// ---------------------------------------------------------------------------

/**
 * P&L percentage as a finite number, `0` when invested is not a usable positive
 * finite number OR the P&L itself is non-finite.
 *
 * The old inline guard was only `investedValue > 0` — which leaks two ways:
 *   - `Infinity > 0` is `true`, so an `Infinity` invested would divide;
 *   - a finite positive invested with an `Infinity` P&L yields `Infinity` %.
 * Both reach a `.toFixed()`/chart axis as `Infinity`. We require BOTH operands
 * finite and the divisor strictly positive.
 */
export function pnlPercentage(
  unrealizedPnL: number,
  investedValue: number,
): number {
  if (!Number.isFinite(investedValue) || investedValue <= 0) return 0;
  if (!Number.isFinite(unrealizedPnL)) return 0;
  return (unrealizedPnL / investedValue) * 100;
}

/**
 * Portfolio P&L percentage as a `toFixed(2)` STRING, or `"0"` when invested is
 * not a usable positive finite number (matches the legacy summary contract,
 * which returns the string `"0"`). Never the literal `"NaN"`/`"Infinity"`,
 * which the holdings page would render verbatim.
 */
export function pnlPercentageString(
  totalPnL: number,
  totalInvested: number,
): string {
  if (!Number.isFinite(totalInvested) || totalInvested <= 0) return "0";
  if (!Number.isFinite(totalPnL)) return "0";
  return ((totalPnL / totalInvested) * 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Portfolio summary aggregation
// ---------------------------------------------------------------------------

/** The monetary fields the summary reduce reads off a transformed holding. */
export interface HoldingSummaryInput {
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
}

export interface HoldingSummary {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: string;
}

/**
 * Sum the portfolio summary across already-transformed holdings, every addend
 * finite-guarded so one corrupt row cannot turn the grand totals into
 * `NaN`/`Infinity`. `pnlPercentage` is the finite `toFixed(2)` string.
 *
 * Behaviour-preserving for finite inputs: identical to the prior inline
 * `reduce((sum, h) => sum + h.investedValue, 0)` trio + the
 * `totalInvested > 0 ? ((totalPnL/totalInvested)*100).toFixed(2) : "0"` summary.
 */
export function summarizeHoldings(
  holdings: HoldingSummaryInput[],
): HoldingSummary {
  let totalInvested = 0;
  let totalCurrent = 0;
  let totalPnL = 0;
  for (const h of holdings) {
    totalInvested += finite(h.investedValue);
    totalCurrent += finite(h.currentValue);
    totalPnL += finite(h.unrealizedPnL);
  }
  return {
    totalInvested,
    totalCurrent,
    totalPnL,
    pnlPercentage: pnlPercentageString(totalPnL, totalInvested),
  };
}

// ---------------------------------------------------------------------------
// Sector / exchange grouping
// ---------------------------------------------------------------------------

/** A bucket of holdings grouped by a key (sector or exchange). */
export interface HoldingGroup {
  key: string;
  count: number;
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: string;
}

/** The fields grouping reads off a transformed holding. */
export interface HoldingGroupInput {
  sector?: string | null;
  exchange?: string | null;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
}

/** Label applied when a grouping key is missing / empty / whitespace. */
export const UNGROUPED_KEY = "Unknown";

function normalizeKey(raw: string | null | undefined): string {
  if (raw == null) return UNGROUPED_KEY;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : UNGROUPED_KEY;
}

function groupBy(
  holdings: HoldingGroupInput[],
  pick: (h: HoldingGroupInput) => string | null | undefined,
): HoldingGroup[] {
  const buckets = new Map<
    string,
    { count: number; invested: number; current: number; pnl: number }
  >();
  for (const h of holdings) {
    // Missing / empty / whitespace key collapses to a single UNGROUPED bucket,
    // so a duplicate sector and a null sector never split a stock's value into
    // two ghost rows whose subtotals silently disagree with the grand total.
    const key = normalizeKey(pick(h));
    const b = buckets.get(key) ?? { count: 0, invested: 0, current: 0, pnl: 0 };
    b.count += 1;
    b.invested += finite(h.investedValue);
    b.current += finite(h.currentValue);
    b.pnl += finite(h.unrealizedPnL);
    buckets.set(key, b);
  }
  // Stable, deterministic order (largest current value first; key tiebreak) so
  // the UI renders the same heatmap regardless of input/Map iteration order.
  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      count: b.count,
      totalInvested: b.invested,
      totalCurrent: b.current,
      totalPnL: b.pnl,
      pnlPercentage: pnlPercentageString(b.pnl, b.invested),
    }))
    .sort(
      (a, z) => z.totalCurrent - a.totalCurrent || a.key.localeCompare(z.key),
    );
}

/**
 * Group holdings by `sector`, summing each bucket with finite-guarded addends.
 * A missing/empty/whitespace sector lands in the `UNGROUPED_KEY` bucket; the
 * union of all bucket subtotals equals the (finite-guarded) portfolio total.
 */
export function groupHoldingsBySector(
  holdings: HoldingGroupInput[],
): HoldingGroup[] {
  return groupBy(holdings, (h) => h.sector);
}

/** Group holdings by `exchange` (same finite-guarded, UNGROUPED-on-missing rules). */
export function groupHoldingsByExchange(
  holdings: HoldingGroupInput[],
): HoldingGroup[] {
  return groupBy(holdings, (h) => h.exchange);
}

// ---------------------------------------------------------------------------
// Weighted-average buy price
// ---------------------------------------------------------------------------

/** A `{ quantity, averagePrice }` leg for a weighted-average buy price. */
export interface WeightedAvgLot {
  quantity: number;
  averagePrice: number;
}

/**
 * Quantity-weighted average buy price across lots, `0` when the total quantity
 * is `<= 0` (avoids the `Σ(qty·px) / 0 = NaN/Infinity` div-by-zero when merging
 * a fully-exited / zero-net position) and finite-guarded throughout so one
 * corrupt lot cannot poison the blended price.
 */
export function weightedAverageBuyPrice(lots: WeightedAvgLot[]): number {
  let totalQty = 0;
  let totalCost = 0;
  for (const lot of lots) {
    const qty = finite(lot.quantity);
    totalQty += qty;
    totalCost += qty * finite(lot.averagePrice);
  }
  if (!(totalQty > 0)) return 0; // `> 0` is false for 0, negative, and NaN.
  return finite(totalCost / totalQty);
}

// ---------------------------------------------------------------------------
// Sector resolution (cross-exchange) — MONEY-846
// ---------------------------------------------------------------------------

/**
 * The permanent "unresolvable" sentinel written by sector-enrichment when a
 * symbol can't be resolved on Yahoo (e.g. a sparse BSE-only listing). It is a
 * real string, so a naive `sector != null` check treats it as a valid sector —
 * callers MUST use `isUsableSector` instead.
 */
export const SECTOR_SKIPPED = "N/A";

/** A sector is usable iff it's a non-empty string that isn't the SKIPPED sentinel. */
/**
 * Byte-identical twin of `hasRealSector` in `@usemoney/core/market-data`, and
 * deliberately NOT an import of it (MONEY-1152).
 *
 * This module has zero imports on purpose — see the file header: it exists so
 * the holdings math can be unit-tested without pulling the Prisma client in at
 * import time. Reaching for `@usemoney/core` to save six lines would give that
 * up for the whole holdings money path.
 *
 * So the duplication stays and gets pinned instead:
 * `holdings-sector-shadow.test.ts` asserts this predicate and `SECTOR_SKIPPED`
 * above agree with core's, across the sentinel, null, undefined and the empty
 * string. A drift fails a test rather than silently un-filtering one of the two
 * copies — which is exactly how six `sector: { not: null }` queries came to
 * ignore a warning this file already carried.
 */
export function isUsableSector(
  sector: string | null | undefined,
): sector is string {
  return (
    typeof sector === "string" && sector.length > 0 && sector !== SECTOR_SKIPPED
  );
}

export interface SectorMappingRow {
  symbol: string;
  exchange: string;
  sector: string | null;
}

/**
 * Resolve a usable sector for a holding from InstrumentMapping rows.
 *
 * Sector is a property of the COMPANY, not the exchange listing, so resolution
 * falls back across exchanges: a BSE holding whose own BSE row is unenriched or
 * stuck at the "N/A" SKIPPED sentinel (BSE Yahoo data is sparse) inherits the
 * SAME symbol's NSE sector. The holding's own exchange is preferred when it has
 * a usable sector.
 */
export function resolveSector(
  symbol: string,
  exchange: string,
  mappings: SectorMappingRow[],
): string | undefined {
  let crossExchange: string | undefined;
  for (const m of mappings) {
    if (m.symbol !== symbol || !isUsableSector(m.sector)) continue;
    if (m.exchange === exchange) return m.sector; // exact exchange wins
    crossExchange ??= m.sector; // first usable on any other exchange
  }
  return crossExchange;
}
