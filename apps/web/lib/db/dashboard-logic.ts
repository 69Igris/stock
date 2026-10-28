/**
 * Dashboard pure-logic helpers.
 *
 * These are the side-effect-free calculation/aggregation helpers used by
 * `getDashboardStats` in `./dashboard.ts`. They are isolated here (away from
 * the Prisma-importing `dashboard.ts`) so they can be unit-tested without
 * pulling in the Prisma client at import time.
 *
 * Behavior here is identical to the logic that previously lived inline in
 * `getDashboardStats`; the query function now calls these helpers.
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
 * `lib/pairing/pairing-logic.ts#derivePairingPrice`.
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
  realizedPnL: number | null;
  tradeDate: Date;
}

// ---------------------------------------------------------------------------
// Paired-trade filtering
// ---------------------------------------------------------------------------

/** Filter closed paired trades. */
export function getClosedPairedTrades<T extends { status?: string }>(
  pairedTrades: T[]
): T[] {
  return pairedTrades.filter((t) => t.status === "CLOSED");
}

/** Filter open/partial paired trades. */
export function getOpenPairedTrades<T extends { status?: string }>(
  pairedTrades: T[]
): T[] {
  return pairedTrades.filter(
    (t) => t.status === "OPEN" || t.status === "PARTIAL"
  );
}

/** Winners (positive realized P&L) from closed trades. */
export function getWinners<T extends { realizedPnL?: number | null }>(
  closedTrades: T[]
): T[] {
  return closedTrades.filter((t) => (t.realizedPnL || 0) > 0);
}

/** Losers (negative realized P&L) from closed trades. */
export function getLosers<T extends { realizedPnL?: number | null }>(
  closedTrades: T[]
): T[] {
  return closedTrades.filter((t) => (t.realizedPnL || 0) < 0);
}

/** Sum realized P&L from closed trades. */
export function calculateTotalRealizedPnL<
  T extends { realizedPnL?: number | null },
>(closedTrades: T[]): number {
  // `|| 0` already drops null/NaN (both falsy); finite() additionally guards a
  // stored ±Infinity from poisoning the realized-P&L total.
  return closedTrades.reduce((sum, t) => sum + finite(t.realizedPnL || 0), 0);
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
  positions: Pick<DashboardPositionInput, "symbol" | "lastPrice">[]
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
  positions: Pick<DashboardPositionInput, "symbol" | "unrealizedPnl">[]
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
  currentPriceMap: Map<string, number>
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
    0
  );
  return { todaysPnL, todaysTrades: todaysTrades.length };
}

/**
 * TODAY tile (MONEY-1074): mark-to-market day change of open holdings PLUS the
 * realized P&L of trades closed today. See the services mirror
 * (`packages/services/src/dashboard-logic.ts#calculateTodaysChange`) for the
 * accepted approximations (sync-cadence staleness; a stock sold today may
 * briefly double-count; MF contributes 0). Every addend is finite()-guarded.
 */
export function calculateTodaysChange(
  holdings: Pick<DashboardHoldingInput, "dayChange">[],
  todaysRealizedPnL: number
): number {
  const dayChangeSum = holdings.reduce(
    (sum, h) => sum + finite(h.dayChange),
    0
  );
  return dayChangeSum + finite(todaysRealizedPnL);
}

// ---------------------------------------------------------------------------
// Segment aggregations
// ---------------------------------------------------------------------------

/** Holdings aggregation: total value, invested, and P&L (currentValue - investedValue). */
export function calculateHoldingsAggregation(
  holdings: Pick<DashboardHoldingInput, "currentValue" | "investedValue">[]
): { totalValue: number; totalInvested: number; totalPnL: number } {
  // finite() each addend so one corrupt holding (NaN/Infinity currentValue or
  // investedValue) cannot turn the entire portfolio sum into NaN/Infinity.
  const totalValue = holdings.reduce(
    (sum, h) => sum + finite(h.currentValue),
    0
  );
  const totalInvested = holdings.reduce(
    (sum, h) => sum + finite(h.investedValue),
    0
  );
  const totalPnL = holdings.reduce(
    (sum, h) => sum + (finite(h.currentValue) - finite(h.investedValue)),
    0
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
    0
  );
  const totalInvested = mfs.reduce(
    (sum, mf) => sum + finite(mf.investedAmount || mf.investedValue || 0),
    0
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
  >[]
): { totalValue: number; totalPnL: number } {
  const totalValue = positions.reduce(
    // finite() guards a NaN/Infinity netQuantity*lastPrice product (the
    // |Math.abs| still propagates non-finite without it).
    (sum, p) => sum + finite(Math.abs(p.netQuantity * p.lastPrice)),
    0
  );
  const totalPnL = positions.reduce(
    (sum, p) => sum + finite(p.totalPnl || 0),
    0
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
  days: number = 30
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
      (pnlByDate.get(dateStr) || 0) + finite(t.realizedPnL || 0)
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
  positionsValue: number
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
  holdingsInvested: number
): string {
  if (!Number.isFinite(holdingsInvested) || holdingsInvested <= 0) return "0";
  if (!Number.isFinite(holdingsPnL)) return "0";
  return ((holdingsPnL / holdingsInvested) * 100).toFixed(2);
}

/**
 * Portfolio-level P&L % (MONEY-1074): return over the invested base of holdings
 * PLUS mutual funds (positions excluded from both sides — no invested figure).
 * Mirrors `packages/services/src/dashboard-logic.ts#calculatePortfolioPnLPercentage`.
 */
export function calculatePortfolioPnLPercentage(
  holdingsPnL: number,
  holdingsInvested: number,
  mfPnL: number,
  mfInvested: number
): string {
  return calculatePnLPercentage(
    finite(holdingsPnL) + finite(mfPnL),
    finite(holdingsInvested) + finite(mfInvested)
  );
}

/** Win rate as a rounded integer percentage, 0 when no closed trades. */
export function calculateWinRate(
  winners: number,
  closedTrades: number
): number {
  return closedTrades > 0 ? Math.round((winners / closedTrades) * 100) : 0;
}

/** Best trade (highest realized P&L) or null for empty input. */
export function findBestTrade<
  T extends { symbol: string; realizedPnL?: number | null },
>(closedTrades: T[]): { symbol: string; pnl: number | null } | null {
  if (closedTrades.length === 0) return null;
  const best = closedTrades.reduce(
    (best, t) =>
      finite(t.realizedPnL) > finite(best?.realizedPnL, -Infinity) ? t : best,
    closedTrades[0]!
  );
  // Surface a non-finite stored P&L as null (honest "—") rather than passing
  // NaN/Infinity to a downstream .toFixed()/.toLocaleString().
  return best
    ? {
        symbol: best.symbol,
        pnl: Number.isFinite(best.realizedPnL) ? best.realizedPnL! : null,
      }
    : null;
}

/** Worst trade (lowest realized P&L) or null for empty input. */
export function findWorstTrade<
  T extends { symbol: string; realizedPnL?: number | null },
>(closedTrades: T[]): { symbol: string; pnl: number | null } | null {
  if (closedTrades.length === 0) return null;
  const worst = closedTrades.reduce(
    (worst, t) =>
      finite(t.realizedPnL) < finite(worst?.realizedPnL, Infinity) ? t : worst,
    closedTrades[0]!
  );
  return worst
    ? {
        symbol: worst.symbol,
        pnl: Number.isFinite(worst.realizedPnL) ? worst.realizedPnL! : null,
      }
    : null;
}
