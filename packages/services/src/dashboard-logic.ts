/**
 * Dashboard pure-logic helpers (service layer).
 *
 * These are the side-effect-free calculation/aggregation helpers used by
 * `getDashboardStats` in `./dashboard.service.ts`. They are isolated here (away
 * from the Prisma-importing service) so they can be unit-tested without pulling
 * in the Prisma client at import time, and — critically — so the LIVE
 * user-facing dashboard path runs the SAME non-finite-guarded math that the
 * `apps/web/lib/db/dashboard-logic.ts` copy already runs.
 *
 * Behavior here is identical, for FINITE inputs, to the logic that previously
 * lived inline in `getDashboardStats`; the service now calls these helpers.
 * The only intentional behavioural difference is that a `NaN`/`±Infinity`
 * addend (a corrupt sync row) can no longer poison the whole portfolio total
 * ("₹NaN"), the `pnlPercentage` can no longer be the literal string "NaN", and
 * an Invalid-Date `tradeDate` can no longer throw `RangeError` on
 * `.toISOString()`.
 *
 * Mirrors `apps/web/lib/db/dashboard-logic.ts`.
 */

import type { DailyPnL } from "@usemoney/types";

// ---------------------------------------------------------------------------
// Non-finite guard
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * Portfolio aggregation is a SUM surface: a single `NaN`/`Infinity` addend
 * poisons the whole reduce (one bad holding row => the dashboard renders
 * "₹NaN"). Stored broker values are occasionally `NaN`/`Infinity` (a divide
 * that went wrong upstream, a corrupt sync row), so every value that enters a
 * sum, a ratio, or a `.toFixed()`/`.toLocaleString()` is funnelled through
 * this guard first. `null`/`undefined`/`NaN`/`±Infinity` all collapse to
 * `fallback` (default 0). Mirrors the same defensive treatment in
 * `apps/web/lib/db/dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Minimal structural input types (subset of Prisma model selections used by
// getDashboardStats). Kept narrow so callers can pass selected rows directly.
// ---------------------------------------------------------------------------

export interface DashboardHoldingInput {
  symbol: string;
  currentPrice: number;
  currentValue: number;
  investedValue: number;
  /** Absolute day change (₹) as of the last broker sync; feeds the TODAY tile. */
  dayChange?: number | null;
}

export interface DashboardMutualFundInput {
  currentValue: number | null;
  investedAmount: number | null;
  investedValue: number | null;
}

export interface DashboardPositionInput {
  symbol: string;
  netQuantity: number;
  lastPrice: number;
  unrealizedPnl: number | null;
  totalPnl: number | null;
}

export interface DashboardPairedTradeInput {
  status?: string;
  entryPrice: number | null;
  quantity: number | null;
  symbol: string;
  realizedPnL?: number | null;
}

export interface DashboardTradeInput {
  realizedPnL?: number | null;
  tradeDate: Date;
}

// ---------------------------------------------------------------------------
// Realized P&L
// ---------------------------------------------------------------------------

/** Sum realized P&L from closed trades (or a Prisma `_sum` aggregate). */
export function calculateTotalRealizedPnL(
  value: number | null | undefined,
): number {
  // `|| 0` already drops null/NaN (both falsy); finite() additionally guards a
  // stored ±Infinity from poisoning the realized-P&L total surfaced to the UI.
  return finite(value || 0);
}

// ---------------------------------------------------------------------------
// Current-price map & unrealized P&L
// ---------------------------------------------------------------------------

/**
 * Build current price map from holdings and positions.
 * Position prices override holdings prices (more up-to-date from broker sync).
 * Zero / falsy prices are skipped.
 */
export function buildCurrentPriceMap(
  holdings: Pick<DashboardHoldingInput, "symbol" | "currentPrice">[],
  positions: Pick<DashboardPositionInput, "symbol" | "lastPrice">[],
): Map<string, number> {
  const map = new Map<string, number>();
  holdings.forEach((h) => {
    if (h.currentPrice) {
      map.set(h.symbol, h.currentPrice);
    }
  });
  positions.forEach((p) => {
    if (p.lastPrice) {
      map.set(p.symbol, p.lastPrice);
    }
  });
  return map;
}

/** Build position unrealized P&L map (symbol -> unrealizedPnl), skipping null/undefined. */
export function buildPositionUnrealizedPnLMap(
  positions: Pick<DashboardPositionInput, "symbol" | "unrealizedPnl">[],
): Map<string, number> {
  const map = new Map<string, number>();
  positions.forEach((p) => {
    if (p.unrealizedPnl !== null && p.unrealizedPnl !== undefined) {
      map.set(p.symbol, p.unrealizedPnl);
    }
  });
  return map;
}

/**
 * Calculate total unrealized P&L from OPEN/PARTIAL paired trades.
 * Prefers pre-calculated position P&L (from broker sync); falls back to
 * (currentPrice - entryPrice) * quantity. Counts each symbol only once.
 */
export function calculateTotalUnrealizedPnL(
  openTrades: Pick<
    DashboardPairedTradeInput,
    "symbol" | "entryPrice" | "quantity"
  >[],
  positionPnLMap: Map<string, number>,
  currentPriceMap: Map<string, number>,
): number {
  let total = 0;
  const counted = new Set<string>();

  openTrades.forEach((t) => {
    if (!counted.has(t.symbol)) {
      const positionPnL = positionPnLMap.get(t.symbol);
      if (positionPnL !== undefined) {
        // Guard: a non-finite position P&L (corrupt sync row) would poison the
        // running total for the whole portfolio.
        total += finite(positionPnL);
        counted.add(t.symbol);
      } else {
        const currentPrice = currentPriceMap.get(t.symbol);
        if (currentPrice && t.entryPrice && t.quantity) {
          // The truthy gate drops NaN inputs but NOT ±Infinity; finite() keeps
          // an Infinity price/qty from leaking into the aggregate.
          total += finite((currentPrice - t.entryPrice) * t.quantity);
        }
      }
    }
  });

  return total;
}

// ---------------------------------------------------------------------------
// Today's P&L
// ---------------------------------------------------------------------------

/** Today's trades (tradeDate >= local midnight) and their summed realized P&L. */
export function calculateTodaysPnL(trades: DashboardTradeInput[]): {
  todaysPnL: number;
  todaysTrades: number;
} {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // An Invalid Date compares `>= today` as false, so it's naturally excluded —
  // no throw here. finite() guards a non-finite realizedPnL from the sum.
  const todaysTrades = trades.filter((t) => new Date(t.tradeDate) >= today);
  const todaysPnL = todaysTrades.reduce(
    (sum, t) => sum + finite(t.realizedPnL || 0),
    0,
  );
  return { todaysPnL, todaysTrades: todaysTrades.length };
}

/**
 * TODAY tile (MONEY-1074): mark-to-market day change of open holdings PLUS the
 * realized P&L of trades closed today. The old dashboard summed only today's
 * realized P&L, so a buy-and-hold / imported portfolio always showed ₹0 even
 * when its holdings moved — QA's "after the day has ended, there is no change".
 *
 * ACCEPTED APPROXIMATIONS (product decision, MONEY-1074):
 *  1. `dayChange` is as-of the LAST broker sync (30-min cadence intraday, final
 *     ~6PM snapshot), so on a non-trading day it shows the last session's move.
 *  2. A stock sold today leaves Holdings only at the next sync, so between the
 *     sell and that sync its dayChange AND its realized P&L may both count.
 *  3. Mutual funds carry no stored day-change, so MF contributes 0 here (day
 *     movement for MF needs NAV history — out of scope).
 * Every addend is finite()-guarded so one corrupt row can't produce "₹NaN".
 */
export function calculateTodaysChange(
  holdings: Pick<DashboardHoldingInput, "dayChange">[],
  todaysRealizedPnL: number,
): number {
  const dayChangeSum = holdings.reduce(
    (sum, h) => sum + finite(h.dayChange),
    0,
  );
  return dayChangeSum + finite(todaysRealizedPnL);
}

// ---------------------------------------------------------------------------
// Segment aggregations
// ---------------------------------------------------------------------------

/** Holdings aggregation: total value, invested, and P&L (currentValue - investedValue). */
export function calculateHoldingsAggregation(
  holdings: Pick<DashboardHoldingInput, "currentValue" | "investedValue">[],
): { totalValue: number; totalInvested: number; totalPnL: number } {
  // finite() each addend so one corrupt holding (NaN/Infinity currentValue or
  // investedValue) cannot turn the entire portfolio sum into NaN/Infinity.
  const totalValue = holdings.reduce(
    (sum, h) => sum + finite(h.currentValue),
    0,
  );
  const totalInvested = holdings.reduce(
    (sum, h) => sum + finite(h.investedValue),
    0,
  );
  const totalPnL = holdings.reduce(
    (sum, h) => sum + (finite(h.currentValue) - finite(h.investedValue)),
    0,
  );
  return { totalValue, totalInvested, totalPnL };
}

/**
 * Mutual fund aggregation. Invested prefers investedAmount, falls back to
 * investedValue, then 0. Null currentValue treated as 0.
 */
export function calculateMfAggregation(mfs: DashboardMutualFundInput[]): {
  totalValue: number;
  totalInvested: number;
  totalPnL: number;
} {
  // The `||` fallback chains are load-bearing (prefer investedAmount, fall back
  // to investedValue, then 0; NaN is falsy so it already falls through). finite()
  // wraps the chosen value so a stored Infinity can't poison the sum either.
  const totalValue = mfs.reduce(
    (sum, mf) => sum + finite(mf.currentValue || 0),
    0,
  );
  const totalInvested = mfs.reduce(
    (sum, mf) => sum + finite(mf.investedAmount || mf.investedValue || 0),
    0,
  );
  const totalPnL = mfs.reduce((sum, mf) => {
    const invested = finite(mf.investedAmount || mf.investedValue || 0);
    return sum + (finite(mf.currentValue || 0) - invested);
  }, 0);
  return { totalValue, totalInvested, totalPnL };
}

/**
 * Open positions aggregation. Value uses |netQuantity * lastPrice|; P&L sums
 * totalPnl (null treated as 0).
 */
export function calculatePositionsAggregation(
  positions: Pick<
    DashboardPositionInput,
    "netQuantity" | "lastPrice" | "totalPnl"
  >[],
): { totalValue: number; totalPnL: number } {
  const totalValue = positions.reduce(
    // finite() guards a NaN/Infinity netQuantity*lastPrice product (the
    // |Math.abs| still propagates non-finite without it).
    (sum, p) => sum + finite(Math.abs(p.netQuantity * p.lastPrice)),
    0,
  );
  const totalPnL = positions.reduce(
    (sum, p) => sum + finite(p.totalPnl || 0),
    0,
  );
  return { totalValue, totalPnL };
}

// ---------------------------------------------------------------------------
// Daily P&L chart
// ---------------------------------------------------------------------------

/**
 * Generate daily P&L chart data from trades over the trailing `days` window
 * (default 30), ending today. Pre-aggregates trades by ISO date in O(n).
 * Each entry carries the day's P&L and the running cumulative total.
 */
export function generateDailyPnL(
  trades: DashboardTradeInput[],
  days: number = 30,
): DailyPnL[] {
  const pnlByDate = new Map<string, number>();
  for (const t of trades) {
    // An Invalid Date (`new Date("garbage")`) throws RangeError on
    // .toISOString() — one corrupt tradeDate would crash the whole dashboard.
    // Skip such rows instead of throwing.
    const time = t.tradeDate?.getTime?.();
    if (time == null || !Number.isFinite(time)) continue;
    // ISO timestamps always contain a "T", so [0] is always a string.
    const dateStr = t.tradeDate.toISOString().split("T")[0]!;
    pnlByDate.set(
      dateStr,
      (pnlByDate.get(dateStr) || 0) + finite(t.realizedPnL || 0),
    );
  }

  const dailyPnL: DailyPnL[] = [];
  let cumulative = 0;
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0]!;
    const dayPnL = pnlByDate.get(dateStr) || 0;
    cumulative += dayPnL;
    dailyPnL.push({ date: dateStr, pnl: dayPnL, cumulativePnL: cumulative });
  }
  return dailyPnL;
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/** Total portfolio value = holdings + MF + positions (each finite-guarded). */
export function calculateTotalPortfolioValue(
  holdingsValue: number,
  mfValue: number,
  positionsValue: number,
): number {
  return finite(holdingsValue) + finite(mfValue) + finite(positionsValue);
}

/**
 * Portfolio P&L percentage as a fixed(2) string, or "0" when invested is not a
 * usable positive number. Non-finite P&L/invested return "0" too — otherwise
 * `(NaN).toFixed(2)` yields the literal string "NaN", which the dashboard would
 * render verbatim.
 */
export function calculatePnLPercentage(
  holdingsPnL: number,
  holdingsInvested: number,
): string {
  if (!Number.isFinite(holdingsInvested) || holdingsInvested <= 0) return "0";
  if (!Number.isFinite(holdingsPnL)) return "0";
  return ((holdingsPnL / holdingsInvested) * 100).toFixed(2);
}

/**
 * Portfolio-level P&L % (MONEY-1074): return over the invested base of holdings
 * PLUS mutual funds. The old TOTAL RETURN was holdings-only, so an MF-only (or
 * MF-dominated) portfolio showed 0% forever even with real MF gains. Positions
 * are deliberately excluded from BOTH numerator and denominator — they carry no
 * "invested" figure, so folding their P&L in without a matching denominator
 * contribution would make the ratio dimensionally dishonest. Each input is
 * finite()-guarded before summing; the "0"-on-degenerate / never-"NaN" contract
 * is delegated to `calculatePnLPercentage`.
 */
export function calculatePortfolioPnLPercentage(
  holdingsPnL: number,
  holdingsInvested: number,
  mfPnL: number,
  mfInvested: number,
): string {
  return calculatePnLPercentage(
    finite(holdingsPnL) + finite(mfPnL),
    finite(holdingsInvested) + finite(mfInvested),
  );
}

/** Win rate as a rounded integer percentage, 0 when no closed trades. */
export function calculateWinRate(
  winners: number,
  closedTrades: number,
): number {
  return closedTrades > 0 ? Math.round((winners / closedTrades) * 100) : 0;
}

/**
 * Surface a found best/worst paired trade pick as `{ symbol, pnl }`, with a
 * non-finite stored P&L collapsed to `null` (honest "—") rather than passing
 * NaN/Infinity to a downstream `.toFixed()`/`.toLocaleString()`. Returns `null`
 * when there is no pick.
 */
export function surfaceTradePick(
  pick: { symbol: string; realizedPnL?: number | null } | null | undefined,
): { symbol: string; pnl: number | null } | null {
  if (!pick) return null;
  return {
    symbol: pick.symbol,
    pnl: Number.isFinite(pick.realizedPnL) ? pick.realizedPnL! : null,
  };
}

// ---------------------------------------------------------------------------
// Portfolio returns (XIRR / CAGR) — pure builder + assembly
// ---------------------------------------------------------------------------
//
// The side-effect-free arithmetic that `getPortfolioReturns` in
// `./dashboard.service.ts` runs to turn a user's dated trade cashflows into the
// money-weighted (XIRR) and time-weighted (CAGR) annualised returns shown on the
// dashboard "returns" chart. The iterative XIRR/CAGR *solvers* themselves live
// in `@usemoney/core/calc` (`calcXirr` / `calcCagr`) and are injected here so
// this module stays import-free of the core package and the LIVE service path
// runs the SAME finite-guarded series-builder + plausibility gate that the unit
// test asserts. Extracting it here closes a de-shadow gap: the cashflow builder,
// the span/annualisation, and the plausibility band were previously inline in
// the service (untested) — a single non-finite `tradeValue`/`price`/
// `currentValue` could push `±Infinity` into the solver, and an Invalid-Date
// first BUY threw `RangeError` on `.toISOString()` (a 500 for the whole chart).

import type { PortfolioReturns } from "@usemoney/types";

/** A single dated cashflow handed to the XIRR solver (outflow < 0, inflow > 0). */
export interface ReturnsCashFlow {
  date: Date;
  amount: number;
}

/** Minimal trade shape the cashflow builder needs (subset of the Prisma row). */
export interface ReturnsTradeInput {
  tradeType: string | null;
  quantity: number | null;
  price: number | null;
  tradeValue: number | null;
  tradeDate: Date;
}

/** Minimal current-holding shape (only the marked value matters here). */
export interface ReturnsCurrentValueInput {
  currentValue: number | null;
}

/** Minimal open-position shape used to mark the position to market. */
export interface ReturnsPositionInput {
  netQuantity: number | null;
  lastPrice: number | null;
}

/** The pluggable solvers, injected so this module imports no I/O / core code. */
export interface ReturnsSolvers {
  /** XIRR over irregular dated cashflows; NaN on non-convergence/degenerate. */
  calcXirr: (flows: readonly ReturnsCashFlow[], guess?: number) => number;
  /** CAGR from start→end value over `years`; `null` when not computable. */
  calcCagr: (
    startValue: number,
    endValue: number,
    years: number,
  ) => number | null;
}

// Sanity bounds for an annualised portfolio return. Anything outside this band
// is almost certainly a numerical artefact (e.g. a single same-day round-trip
// producing a degenerate IRR) rather than a real return, so we surface "—"
// instead of a misleading number.
export const MIN_PLAUSIBLE_RATE = -0.99; // −99%
export const MAX_PLAUSIBLE_RATE = 10; // +1000% annualised
// XIRR over a span this short is dominated by noise and not meaningful.
export const MIN_DAYS_FOR_XIRR = 7;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** The empty/honest "—" returns result (no metric computable). */
export const EMPTY_PORTFOLIO_RETURNS: PortfolioReturns = {
  xirrPct: null,
  cagrPct: null,
  firstInvestmentDate: null,
  holdingPeriodYears: null,
};

/**
 * Resolve a trade's rupee value: prefer a stored, *positive & finite*
 * `tradeValue`, else fall back to `quantity × price` (the canonical fallback
 * used elsewhere). Returns `0` for any non-positive / non-finite combination so
 * the caller's `value > 0` gate drops it. Crucially this also rejects a stored
 * `Infinity` tradeValue (`Infinity > 0` is `true`, so the raw `> 0` check alone
 * would let it through and poison the cashflow series).
 */
export function resolveTradeValue(
  t: Pick<ReturnsTradeInput, "tradeValue" | "quantity" | "price">,
): number {
  if (
    t.tradeValue != null &&
    Number.isFinite(t.tradeValue) &&
    t.tradeValue > 0
  ) {
    return t.tradeValue;
  }
  const derived = finite(t.quantity) * finite(t.price);
  return Number.isFinite(derived) && derived > 0 ? derived : 0;
}

/**
 * True when `d` is a usable, finite calendar date (not `null`, not
 * `new Date("garbage")`). Guards every `getTime()` / `.toISOString()` that would
 * otherwise yield `NaN` or throw `RangeError`.
 */
export function isValidDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/** A `YYYY-MM-DD` string for a valid date, else `null` (never throws). */
export function safeIsoDate(d: Date | null | undefined): string | null {
  if (!isValidDate(d)) return null;
  return d.toISOString().split("T")[0] ?? null;
}

/**
 * Whole days between two dates (`later − earlier`), or `0` when either date is
 * invalid (so a corrupt date can never produce a `NaN` span that silently
 * disables / mis-scales the annualisation).
 */
export function daySpan(earlier: Date | null | undefined, later: Date): number {
  if (!isValidDate(earlier) || !isValidDate(later)) return 0;
  return (later.getTime() - earlier.getTime()) / MS_PER_DAY;
}

/**
 * Current mark-to-market value of everything still held = Σ holding value +
 * Σ MF value + Σ |netQuantity × lastPrice| over open positions. Every addend is
 * finite-guarded so one corrupt row (NaN / ±Infinity) contributes `0` rather
 * than turning the whole terminal value into a non-finite poison that would
 * flow into both the XIRR close and the CAGR end-value.
 */
export function calculateCurrentMarketValue(
  holdings: ReturnsCurrentValueInput[],
  mutualFunds: ReturnsCurrentValueInput[],
  positions: ReturnsPositionInput[],
): number {
  const holdingsValue = holdings.reduce(
    (sum, h) => sum + finite(h.currentValue),
    0,
  );
  const mfValue = mutualFunds.reduce(
    (sum, mf) => sum + finite(mf.currentValue),
    0,
  );
  const positionsValue = positions.reduce(
    (sum, p) =>
      sum + finite(Math.abs(finite(p.netQuantity) * finite(p.lastPrice))),
    0,
  );
  return holdingsValue + mfValue + positionsValue;
}

/** Result of {@link buildReturnsCashFlows}: the dated flows plus running totals. */
export interface ReturnsCashFlowSeries {
  flows: ReturnsCashFlow[];
  totalInvested: number;
  totalProceeds: number;
  firstBuyDate: Date | null;
}

/**
 * Build the dated cashflow series from a user's trades: each BUY is an outflow
 * (negative), each SELL an inflow (positive). Rows with a non-positive /
 * non-finite resolved value are skipped, and — critically — a row whose
 * `tradeDate` is an Invalid Date is skipped entirely (its `getTime()` is `NaN`,
 * which would poison the solver's day-count AND, if it were the first BUY, throw
 * `RangeError` on the later `.toISOString()`). Only finite-dated BUYs update
 * `firstBuyDate`, so the holding period is always anchored to a real date.
 */
export function buildReturnsCashFlows(
  trades: ReturnsTradeInput[],
): ReturnsCashFlowSeries {
  const flows: ReturnsCashFlow[] = [];
  let totalInvested = 0;
  let totalProceeds = 0;
  let firstBuyDate: Date | null = null;

  for (const t of trades) {
    const value = resolveTradeValue(t);
    if (!(value > 0)) continue; // skip zero/invalid/non-finite rows

    const date = new Date(t.tradeDate);
    // An Invalid Date would push NaN into the solver day-count and could throw
    // on a later .toISOString(); drop the row rather than corrupt the series.
    if (!isValidDate(date)) continue;

    if (t.tradeType === "BUY") {
      flows.push({ date, amount: -value });
      totalInvested += value;
      if (firstBuyDate === null || date < firstBuyDate) firstBuyDate = date;
    } else if (t.tradeType === "SELL") {
      flows.push({ date, amount: value });
      totalProceeds += value;
    }
  }

  return { flows, totalInvested, totalProceeds, firstBuyDate };
}

/**
 * Run the injected XIRR solver over the (already mark-to-market-closed) flows
 * and return the rate as a *percent*, or `null` when the result is not a
 * trustworthy number. Returns `null` (never NaN/Infinity to the chart) when:
 *   - there are < 2 flows or the span is shorter than {@link MIN_DAYS_FOR_XIRR};
 *   - the solver doesn't converge / has no sign change (it yields `NaN`);
 *   - the converged rate is outside the plausible band.
 */
export function computeXirrPct(
  flows: readonly ReturnsCashFlow[],
  spanDays: number,
  solve: ReturnsSolvers["calcXirr"],
): number | null {
  if (flows.length < 2) return null;
  if (!Number.isFinite(spanDays) || spanDays < MIN_DAYS_FOR_XIRR) return null;
  const rate = solve(flows);
  if (
    Number.isFinite(rate) &&
    rate >= MIN_PLAUSIBLE_RATE &&
    rate <= MAX_PLAUSIBLE_RATE
  ) {
    return rate * 100;
  }
  return null;
}

/** Result of {@link computeCagr}: the rate as a percent + the holding period. */
export interface CagrResult {
  cagrPct: number | null;
  holdingPeriodYears: number | null;
}

/**
 * Realised compound rate from invested capital → terminal value (current
 * holdings + realised proceeds) over the holding period, as a *percent*. Using
 * `invested + proceeds` as the end value credits sold positions back so a book
 * that sold winners isn't penalised. Returns `null` for both fields (honest
 * "—") when there's no positive invested capital, no real holding period, or the
 * solver / plausibility gate rejects the rate. `calcCagr` already returns `null`
 * for begin ≤ 0 / end < 0 / years ≤ 0 / non-finite / `Math.pow(neg, frac)` NaN,
 * so a degenerate input can never surface a fabricated number.
 */
export function computeCagr(
  totalInvested: number,
  currentValue: number,
  totalProceeds: number,
  spanDays: number,
  solve: ReturnsSolvers["calcCagr"],
): CagrResult {
  const NONE: CagrResult = { cagrPct: null, holdingPeriodYears: null };
  if (!(totalInvested > 0)) return NONE;
  if (!Number.isFinite(spanDays) || spanDays <= 0) return NONE;

  const years = spanDays / 365;
  const endValue = finite(currentValue) + finite(totalProceeds);
  const cagr = solve(totalInvested, endValue, years);
  if (
    cagr != null &&
    cagr >= MIN_PLAUSIBLE_RATE &&
    cagr <= MAX_PLAUSIBLE_RATE
  ) {
    return {
      cagrPct: cagr * 100,
      holdingPeriodYears: Math.round(years * 100) / 100,
    };
  }
  return NONE;
}

/**
 * Pure assembly of {@link PortfolioReturns} from a user's trades + current
 * holdings/MFs/positions, given the current instant `now` and the injected
 * solvers. This is exactly what `getPortfolioReturns` computes between its DB
 * read and its cache write; isolating it here means the LIVE dashboard path and
 * the unit test run the identical finite-guarded math.
 *
 * Honesty contract (never fabricates, never emits NaN/Infinity):
 *   - no trades at all → fully `null` ({@link EMPTY_PORTFOLIO_RETURNS});
 *   - no finite-valued/dated BUY → `firstBuyDate` stays `null` → CAGR `null`
 *     and XIRR `null`;
 *   - non-finite trade/holding values are neutralised to `0` before the solver;
 *   - an Invalid-Date row is dropped (no throw, no NaN day-count).
 */
export function computePortfolioReturns(
  input: {
    trades: ReturnsTradeInput[];
    holdings: ReturnsCurrentValueInput[];
    mutualFunds: ReturnsCurrentValueInput[];
    positions: ReturnsPositionInput[];
  },
  now: Date,
  solvers: ReturnsSolvers,
): PortfolioReturns {
  if (input.trades.length === 0) return { ...EMPTY_PORTFOLIO_RETURNS };

  const currentValue = calculateCurrentMarketValue(
    input.holdings,
    input.mutualFunds,
    input.positions,
  );

  const { flows, totalInvested, totalProceeds, firstBuyDate } =
    buildReturnsCashFlows(input.trades);

  // Close the series with the current portfolio value at `now` (only when
  // something is still held and the mark is a usable positive number). For a
  // fully realised book this is 0 and we rely on the realised SELL inflows.
  if (currentValue > 0) {
    flows.push({ date: now, amount: currentValue });
  }

  const spanDays = daySpan(firstBuyDate, now);

  const xirrPct = computeXirrPct(flows, spanDays, solvers.calcXirr);
  const { cagrPct, holdingPeriodYears } = computeCagr(
    totalInvested,
    currentValue,
    totalProceeds,
    spanDays,
    solvers.calcCagr,
  );

  return {
    xirrPct,
    cagrPct,
    firstInvestmentDate: safeIsoDate(firstBuyDate),
    holdingPeriodYears,
  };
}
