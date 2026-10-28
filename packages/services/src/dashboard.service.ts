/**
 * Dashboard Service
 *
 * Aggregates portfolio stats from holdings, positions, trades, and MFs.
 * Source: apps/web/lib/actions/dashboard.ts + apps/web/lib/db/dashboard.ts
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
// Subpath, NOT the root barrel: these are pure in-process helpers (a dedupe
// registry and a string builder). The service tests stub the ROOT
// `@usemoney/core` with a catch-all Proxy that answers any unmodelled export
// with a no-op, so from the root `singleFlight` silently became `async () => {}`
// and the LIVE service tests got `undefined` instead of their result. The I/O
// boundary those tests DO need to control (getCached / setCached) stays on the
// root import above.
import { singleFlight, generateCacheKey } from "@usemoney/core/cache";
import { calcXirr, calcCagr } from "@usemoney/core/calc";
import { dbLogger as logger } from "@usemoney/logger";
import type {
  DashboardStats,
  DailyPnL,
  PortfolioReturns,
} from "@usemoney/types";
import type { ServiceResult } from "./types";
import {
  buildCurrentPriceMap,
  buildPositionUnrealizedPnLMap,
  calculateHoldingsAggregation,
  calculateMfAggregation,
  calculatePortfolioPnLPercentage,
  calculatePositionsAggregation,
  calculateTodaysPnL,
  calculateTodaysChange,
  calculateTotalPortfolioValue,
  calculateTotalRealizedPnL,
  calculateTotalUnrealizedPnL,
  calculateWinRate,
  computePortfolioReturns,
  EMPTY_PORTFOLIO_RETURNS,
  generateDailyPnL,
  surfaceTradePick,
} from "./dashboard-logic";

export type { DashboardStats, DailyPnL, PortfolioReturns };

/* ---------------------------------------------------------------------------
   Stampede protection (MONEY-705)
   ---------------------------------------------------------------------------
   Every portfolio read below used to be a bare `getCached` / `setCached` pair
   with NO coordination between concurrent callers. On each TTL boundary all N
   in-flight requests for the same user missed together and each ran the FULL
   query set — 11 Mongo queries per concurrent request for the dashboard, ~16
   external Yahoo fetches for risk — at exactly the moment the backend is
   already slowest.

   The fix is `singleFlight` (packages/core/src/cache/stale-while-error.ts):
   concurrent misses on the same key await ONE execution, and the registry
   entry is dropped in a `finally` so a rejected flight never poisons the key.

   Two deliberate choices, both load-bearing:

   1. **The flight key IS the cache key** — `generateCacheKey(module, userId,
      identifier, filters)`, the exact string `getCached`/`setCached` derive
      internally from the same arguments. Building it any other way would let
      the flight partition DRIFT from the cache partition, and the dangerous
      direction of that drift is collapsing two users onto one flight, which
      serves user A's portfolio to user B. Because `userId` is a key segment by
      construction, per-user isolation cannot be lost by a later edit that does
      not also change the cache key itself.

   2. **`singleFlight`, not `withCache`.** `withCache` also takes a cross-
      instance Redis lock and makes peers wait up to 3s for the holder to
      publish; these are cheap user-scoped payloads where that latency is not
      worth paying, and it would additionally cache the `{ success: false }`
      envelopes these services return (e.g. risk's "No holdings found"). The
      get/compute/set body stays inside the flight, so failures are still never
      written to the cache and the whole path stays fail-open: `singleFlight`
      is pure in-process state and touches no Redis at all.

   NOTHING about the cache keys, TTLs or configs changes here — entries written
   by the currently deployed build stay readable after deploy.
   -------------------------------------------------------------------------- */

// ── Service Functions ──────────────────────────────────────────────

export async function getDashboardStats(
  userId: string,
): Promise<ServiceResult<DashboardStats>> {
  try {
    const stats = await singleFlight(
      generateCacheKey("dashboard", userId, "stats"),
      () => resolveDashboardStats(userId),
    );
    return { success: true, data: stats };
  } catch (error) {
    logger.error({ error, userId }, "Dashboard service error");
    return { success: false, error: "Failed to fetch dashboard stats" };
  }
}

/** Cache-read → compute → cache-write body, run at most once per user per flight. */
async function resolveDashboardStats(userId: string): Promise<DashboardStats> {
  const cached = await getCached<DashboardStats>("dashboard", userId, "stats");

  if (cached) {
    logger.debug({ userId }, "Dashboard stats from cache");
    return cached;
  }

  logger.debug({ userId }, "Dashboard stats cache miss");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const closedWhere = { userId, status: "CLOSED" as const };

  const [
    trades,
    holdings,
    mutualFunds,
    positions,
    closedAgg,
    winnerCount,
    loserCount,
    openPairedTrades,
    totalTradeCount,
    bestTradePick,
    worstTradePick,
  ] = await Promise.all([
    prisma.trade.findMany({
      where: { userId, tradeDate: { gte: thirtyDaysAgo } },
      orderBy: { tradeDate: "desc" },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        tradeType: true,
        quantity: true,
        price: true,
        realizedPnL: true,
        tradeDate: true,
      },
    }),
    prisma.holding.findMany({
      where: { userId },
      select: {
        symbol: true,
        currentPrice: true,
        currentValue: true,
        investedValue: true,
        unrealizedPnL: true,
        // MONEY-1074: feeds the TODAY tile (mark-to-market day change).
        dayChange: true,
      },
    }),
    prisma.mutualFund.findMany({
      where: { userId },
      select: {
        currentValue: true,
        investedAmount: true,
        investedValue: true,
      },
    }),
    prisma.position.findMany({
      where: { userId },
      select: {
        symbol: true,
        netQuantity: true,
        lastPrice: true,
        unrealizedPnl: true,
        totalPnl: true,
      },
    }),
    prisma.pairedTradeView.aggregate({
      where: closedWhere,
      _sum: { realizedPnL: true },
      _count: true,
    }),
    prisma.pairedTradeView.count({
      where: { ...closedWhere, realizedPnL: { gt: 0 } },
    }),
    prisma.pairedTradeView.count({
      where: { ...closedWhere, realizedPnL: { lte: 0 } },
    }),
    prisma.pairedTradeView.findMany({
      where: { userId, status: { in: ["OPEN", "PARTIAL"] } },
      select: { entryPrice: true, quantity: true, symbol: true },
    }),
    prisma.trade.count({ where: { userId } }),
    prisma.pairedTradeView.findFirst({
      where: closedWhere,
      orderBy: { realizedPnL: "desc" },
      select: { symbol: true, realizedPnL: true },
    }),
    prisma.pairedTradeView.findFirst({
      where: closedWhere,
      orderBy: { realizedPnL: "asc" },
      select: { symbol: true, realizedPnL: true },
    }),
  ]);

  // finite()-guard the aggregate sum: a stored ±Infinity realizedPnL would
  // otherwise pass `|| 0` and poison the realized-P&L total.
  const totalRealizedPnL = calculateTotalRealizedPnL(
    closedAgg._sum.realizedPnL,
  );
  const closedTradeCount = closedAgg._count;

  // Price maps (Position data overrides Holdings)
  const currentPriceMap = buildCurrentPriceMap(holdings, positions);
  const positionUnrealizedPnLMap = buildPositionUnrealizedPnLMap(positions);

  // Unrealized P&L from open/partial paired trades (each addend finite-guarded
  // so one corrupt sync row can't poison the running total).
  const totalUnrealizedPnL = calculateTotalUnrealizedPnL(
    openPairedTrades,
    positionUnrealizedPnLMap,
    currentPriceMap,
  );

  // Today's realized P&L. An Invalid Date is naturally excluded (compares
  // `>= today` as false); finite() guards a non-finite realizedPnL.
  const { todaysPnL, todaysTrades } = calculateTodaysPnL(trades);

  // Segment aggregations — every addend is finite-guarded so a single NaN /
  // ±Infinity holding/MF/position value can no longer turn the whole sum into
  // "₹NaN".
  const {
    totalValue: totalHoldingsValue,
    totalInvested: totalHoldingsInvested,
    totalPnL: totalHoldingsPnL,
  } = calculateHoldingsAggregation(holdings);

  const {
    totalValue: totalMfValue,
    totalInvested: totalMfInvested,
    totalPnL: totalMfPnL,
  } = calculateMfAggregation(mutualFunds);

  const { totalValue: totalPositionsValue, totalPnL: totalPositionsPnL } =
    calculatePositionsAggregation(positions);

  // Daily P&L chart data. Invalid-Date rows are skipped (never throw on
  // .toISOString()); non-finite realizedPnL is dropped from the day total.
  const dailyPnL: DailyPnL[] = generateDailyPnL(trades, 30);

  const stats: DashboardStats = {
    portfolio: {
      // Each segment value is finite-guarded again at the grand-total level.
      totalValue: calculateTotalPortfolioValue(
        totalHoldingsValue,
        totalMfValue,
        totalPositionsValue,
      ),
      totalPnL: totalHoldingsPnL + totalMfPnL + totalPositionsPnL,
      // MONEY-1074: TOTAL RETURN over the invested base of holdings + MF
      // (positions excluded — they carry no invested figure). "0" for
      // non-positive / non-finite invested, and never the literal "NaN".
      pnlPercentage: calculatePortfolioPnLPercentage(
        totalHoldingsPnL,
        totalHoldingsInvested,
        totalMfPnL,
        totalMfInvested,
      ),
      holdingsValue: totalHoldingsValue,
      holdingsInvested: totalHoldingsInvested,
      holdingsPnL: totalHoldingsPnL,
      mfValue: totalMfValue,
      mfInvested: totalMfInvested,
      mfPnL: totalMfPnL,
      openPositionsValue: totalPositionsValue,
      openPositionsPnL: totalPositionsPnL,
    },
    trading: {
      totalRealizedPnL,
      totalUnrealizedPnL,
      totalTrades: totalTradeCount,
      closedTrades: closedTradeCount,
      openTrades: openPairedTrades.length,
      todaysPnL,
      // MONEY-1074: mark-to-market TODAY = holdings dayChange + today's
      // realized P&L (todaysPnL keeps its realized-only meaning for other
      // consumers). Uses the holdings rows already fetched above.
      todaysChange: calculateTodaysChange(holdings, todaysPnL),
      todaysTrades,
      winRate: calculateWinRate(winnerCount, closedTradeCount),
      winners: winnerCount,
      losers: loserCount,
      // A non-finite stored best/worst P&L is surfaced as null (honest "—")
      // rather than handed to a downstream formatter as NaN/Infinity.
      bestTrade: surfaceTradePick(bestTradePick),
      worstTrade: surfaceTradePick(worstTradePick),
    },
    charts: { dailyPnL },
    recentTrades: trades.slice(0, 10),
  };

  await setCached("dashboard", userId, "stats", stats);
  return stats;
}

/**
 * Compute money-weighted (XIRR) and time-weighted (CAGR) annualised returns
 * for a user's portfolio from their *dated trade cashflows*.
 *
 * Method:
 *   1. Each BUY is an outflow (negative), each SELL an inflow (positive),
 *      dated at `tradeDate`. The trade value is `tradeValue` when present,
 *      else `quantity × price` (the canonical fallback used elsewhere).
 *   2. The portfolio's *current* market value (holdings + MFs + open
 *      positions) is appended as a final positive cashflow dated today -
 *      this is the standard "mark-to-market the open position" close that
 *      makes XIRR well-defined for a still-open portfolio.
 *   3. XIRR is solved via Newton-Raphson with bisection fallback
 *      (`calcXirr`). Non-convergence / degenerate inputs → `null`.
 *   4. CAGR is the realised compound rate from total invested capital to
 *      current value over the elapsed holding period (today − first BUY).
 *
 * All of the arithmetic — the finite-guarded cashflow series builder, the
 * mark-to-market close, the span/annualisation, and the plausibility band —
 * lives in {@link computePortfolioReturns} in `./dashboard-logic.ts` (so the
 * LIVE path runs the same code the unit test asserts, and a non-finite
 * `tradeValue`/`price`/`currentValue` or an Invalid-Date row can never push
 * NaN/±Infinity into the chart or throw on `.toISOString()`). The solvers
 * (`calcXirr`/`calcCagr`) are injected so the logic module stays I/O-free.
 *
 * Returns `null` for either metric when the data can't support a correct
 * computation. NEVER fabricates a value. Specifically:
 *   - No trades at all (e.g. holdings synced without a trade book) → both
 *     metrics `null`. Honest "—".
 *   - Zero current value AND no realised proceeds → `null`.
 *   - Holding period shorter than `MIN_DAYS_FOR_XIRR` → XIRR `null`.
 */
export async function getPortfolioReturns(
  userId: string,
): Promise<ServiceResult<PortfolioReturns>> {
  try {
    const returns = await singleFlight(
      generateCacheKey("dashboard", userId, "returns"),
      () => resolvePortfolioReturns(userId),
    );
    return { success: true, data: returns };
  } catch (error) {
    logger.error({ error, userId }, "Portfolio returns service error");
    return { success: false, error: "Failed to compute portfolio returns" };
  }
}

/**
 * Memory safety valve for the lifetime trade-book read (MONEY-705).
 *
 * XIRR is money-weighted return SINCE INCEPTION, so the cashflow series is the
 * user's entire trade history by definition — there is no date floor that keeps
 * the number correct, and `take` with `orderBy tradeDate asc` would silently
 * drop the NEWEST trades. Both would change a financial figure the user reads
 * without telling anyone.
 *
 * So the cap is not a truncation, it is a REFUSAL. We fetch `cap + 1` rows;
 * getting back more than `cap` proves the user exceeded it, and we return the
 * same honest "—" ({@link EMPTY_PORTFOLIO_RETURNS}) this module already returns
 * whenever the data cannot support a correct computation, plus a warning so the
 * cap can be raised deliberately. A user at or under the cap gets a bit-
 * identical result to the uncapped read: same rows, same order, same solver.
 *
 * 50k is far beyond any realistic retail trade book (a hyperactive intraday
 * trader books a few thousand fills a year), so this should never fire; it
 * exists so that when it does, the failure mode is a dash and a log line rather
 * than a serverless instance OOM-ing on an unbounded findMany.
 */
const XIRR_MAX_TRADES = 50_000;

/** Cache-read → compute → cache-write body, run at most once per user per flight. */
async function resolvePortfolioReturns(
  userId: string,
): Promise<PortfolioReturns> {
  const cached = await getCached<PortfolioReturns>(
    "dashboard",
    userId,
    "returns",
  );
  if (cached) {
    logger.debug({ userId }, "Portfolio returns from cache");
    return cached;
  }

  const [trades, holdings, mutualFunds, positions] = await Promise.all([
    prisma.trade.findMany({
      where: { userId },
      orderBy: { tradeDate: "asc" },
      // cap + 1 — see XIRR_MAX_TRADES. The extra row is the detector.
      take: XIRR_MAX_TRADES + 1,
      select: {
        tradeType: true,
        quantity: true,
        price: true,
        tradeValue: true,
        tradeDate: true,
      },
    }),
    prisma.holding.findMany({
      where: { userId },
      select: { currentValue: true },
    }),
    prisma.mutualFund.findMany({
      where: { userId },
      select: { currentValue: true },
    }),
    prisma.position.findMany({
      where: { userId },
      select: { netQuantity: true, lastPrice: true },
    }),
  ]);

  // No dated cashflows → nothing correct to compute. Honest "—".
  if (trades.length === 0) {
    await setCached("dashboard", userId, "returns", EMPTY_PORTFOLIO_RETURNS);
    return EMPTY_PORTFOLIO_RETURNS;
  }

  // Over the cap → the series we hold is provably incomplete. Refuse rather
  // than annualise a truncated cashflow set into a wrong percentage.
  if (trades.length > XIRR_MAX_TRADES) {
    logger.warn(
      { userId, cap: XIRR_MAX_TRADES },
      "Portfolio returns: trade book exceeds the XIRR row cap - returning null metrics",
    );
    await setCached("dashboard", userId, "returns", EMPTY_PORTFOLIO_RETURNS);
    return EMPTY_PORTFOLIO_RETURNS;
  }

  // Pure assembly: finite-guarded series builder + plausibility-gated solvers.
  const result = computePortfolioReturns(
    { trades, holdings, mutualFunds, positions },
    new Date(),
    { calcXirr, calcCagr },
  );

  await setCached("dashboard", userId, "returns", result);
  return result;
}
