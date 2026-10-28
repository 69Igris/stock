import prisma from "@/lib/prisma";
import type { DashboardStats, DailyPnL } from "@usemoney/types";
import {
  buildCurrentPriceMap,
  buildPositionUnrealizedPnLMap,
  calculateTotalUnrealizedPnL,
  calculateTodaysPnL,
  calculateTodaysChange,
  calculateHoldingsAggregation,
  calculateMfAggregation,
  calculatePositionsAggregation,
  generateDailyPnL,
  calculateTotalPortfolioValue,
  calculatePnLPercentage,
  calculatePortfolioPnLPercentage,
  calculateWinRate,
} from "./dashboard-logic";

export type { DashboardStats, DailyPnL };

// Re-export the pure dashboard helpers so the calculation logic has a single
// home and stays importable/testable without Prisma. The DB-level aggregates
// in getDashboardStats are the perf-optimized equivalents of the filtering
// helpers (getClosedPairedTrades/getWinners/etc.) and best/worst pickers.
export {
  getClosedPairedTrades,
  getOpenPairedTrades,
  getWinners,
  getLosers,
  calculateTotalRealizedPnL,
  buildCurrentPriceMap,
  buildPositionUnrealizedPnLMap,
  calculateTotalUnrealizedPnL,
  calculateTodaysPnL,
  calculateTodaysChange,
  calculateHoldingsAggregation,
  calculateMfAggregation,
  calculatePositionsAggregation,
  generateDailyPnL,
  calculateTotalPortfolioValue,
  calculatePnLPercentage,
  calculatePortfolioPnLPercentage,
  calculateWinRate,
  findBestTrade,
  findWorstTrade,
} from "./dashboard-logic";

/**
 * Get dashboard statistics
 * Uses PairedTradeView for realized P&L to match tradebook display
 *
 * Optimized: filters PairedTradeView by status at DB level to avoid
 * fetching 10,000+ records and filtering in JavaScript.
 */
export async function getDashboardStats(
  userId: string
): Promise<DashboardStats> {
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
    // Aggregate CLOSED trades at DB level - sum + count pushed to MongoDB
    prisma.pairedTradeView.aggregate({
      where: closedWhere,
      _sum: { realizedPnL: true },
      _count: true,
    }),
    // Winner/loser counts pushed to MongoDB (no JS filtering)
    prisma.pairedTradeView.count({
      where: { ...closedWhere, realizedPnL: { gt: 0 } },
    }),
    prisma.pairedTradeView.count({
      where: { ...closedWhere, realizedPnL: { lte: 0 } },
    }),
    // OPEN/PARTIAL trades still needed per-symbol for unrealized P&L calc
    prisma.pairedTradeView.findMany({
      where: { userId, status: { in: ["OPEN", "PARTIAL"] } },
      select: {
        entryPrice: true,
        quantity: true,
        symbol: true,
      },
    }),
    prisma.trade.count({ where: { userId } }),
    // Best trade (highest realizedPnL) - single document from DB
    prisma.pairedTradeView.findFirst({
      where: closedWhere,
      orderBy: { realizedPnL: "desc" },
      select: { symbol: true, realizedPnL: true },
    }),
    // Worst trade (lowest realizedPnL) - single document from DB
    prisma.pairedTradeView.findFirst({
      where: closedWhere,
      orderBy: { realizedPnL: "asc" },
      select: { symbol: true, realizedPnL: true },
    }),
  ]);

  // Realized P&L from aggregate (no JS reduce over 1000+ records)
  const totalRealizedPnL = closedAgg._sum.realizedPnL || 0;
  const closedTradeCount = closedAgg._count;

  // Create maps for current prices and unrealized P&L
  // Priority: Position data (from broker sync) > Holdings data
  const currentPriceMap = buildCurrentPriceMap(holdings, positions);
  const positionUnrealizedPnLMap = buildPositionUnrealizedPnLMap(positions);

  // Calculate unrealized P&L from OPEN/PARTIAL trades
  // Use Position model's unrealized P&L directly when available (synced from broker)
  const totalUnrealizedPnL = calculateTotalUnrealizedPnL(
    openPairedTrades,
    positionUnrealizedPnLMap,
    currentPriceMap
  );

  const { todaysPnL, todaysTrades: todaysTradeCount } =
    calculateTodaysPnL(trades);

  const holdingsAgg = calculateHoldingsAggregation(holdings);
  const totalHoldingsValue = holdingsAgg.totalValue;
  const totalHoldingsInvested = holdingsAgg.totalInvested;
  // Always calculate P&L from currentValue - invested (stored pnl may be stale or 0)
  const totalHoldingsPnL = holdingsAgg.totalPnL;

  // Mutual Funds calculations
  const mfAgg = calculateMfAggregation(mutualFunds);
  const totalMfValue = mfAgg.totalValue;
  const totalMfInvested = mfAgg.totalInvested;
  // Always calculate P&L from currentValue - invested (stored pnl may be stale or 0)
  const totalMfPnL = mfAgg.totalPnL;

  // Open Positions calculations
  const positionsAgg = calculatePositionsAggregation(positions);
  const totalPositionsValue = positionsAgg.totalValue;
  const totalPositionsPnL = positionsAgg.totalPnL;

  // Generate daily P&L chart data from actual trades (trailing 30-day window)
  const dailyPnL: DailyPnL[] = generateDailyPnL(trades, 30);

  return {
    portfolio: {
      totalValue: calculateTotalPortfolioValue(
        totalHoldingsValue,
        totalMfValue,
        totalPositionsValue
      ),
      totalPnL: totalHoldingsPnL + totalMfPnL + totalPositionsPnL,
      // MONEY-1074: TOTAL RETURN over holdings + MF invested base.
      pnlPercentage: calculatePortfolioPnLPercentage(
        totalHoldingsPnL,
        totalHoldingsInvested,
        totalMfPnL,
        totalMfInvested
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
      // MONEY-1074: mark-to-market TODAY = holdings dayChange + today's realized.
      todaysChange: calculateTodaysChange(holdings, todaysPnL),
      todaysTrades: todaysTradeCount,
      winRate: calculateWinRate(winnerCount, closedTradeCount),
      winners: winnerCount,
      losers: loserCount,
      bestTrade: bestTradePick
        ? { symbol: bestTradePick.symbol, pnl: bestTradePick.realizedPnL }
        : null,
      worstTrade: worstTradePick
        ? { symbol: worstTradePick.symbol, pnl: worstTradePick.realizedPnL }
        : null,
    },
    charts: { dailyPnL },
    recentTrades: trades.slice(0, 10),
  };
}
