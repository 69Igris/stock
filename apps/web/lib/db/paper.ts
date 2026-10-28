import prisma from "@/lib/prisma";
import {
  resolveSegment,
  resolveSide,
  assetTypeForInstrumentType,
  positionTypeForSide,
  currentValue as computeCurrentValue,
  unrealizedPnL as computeUnrealizedPnL,
  realizedPnL as computeRealizedPnL,
  benchmarkAndAlpha,
  normalizeCreateValues,
  averageIntoPosition,
  summarizePaperPortfolio,
  calculatePerformance,
  pnlPercentage as computePnlPercentage,
  finite,
} from "@/lib/db/paper-logic";

export interface PaperPositionInput {
  symbol: string;
  name?: string;
  assetType: "STOCK" | "FNO_FUTURES" | "FNO_OPTIONS" | "MF";
  segment?: string;
  exchange?: string;
  positionType?: "LONG" | "SHORT";
  side?: string;
  quantity: number;
  lotSize?: number;
  averagePrice: number;
  // F&O specific
  strikePrice?: number;
  optionType?: "CE" | "PE";
  expiryDate?: Date;
  // MF specific
  schemeName?: string;
  units?: number;
  nav?: number;
  // Benchmark
  niftyAtEntry?: number;
  // Portfolio link
  portfolioId?: string;
  // Strategy
  stopLoss?: number;
  target?: number;
  strategy?: string;
  // Notes
  notes?: string;
  tags?: string[];
}

export interface PaperPosition {
  id: string;
  userId: string;
  symbol: string;
  assetType: string;
  segment: string;
  exchange: string;
  positionType: string;
  quantity: number;
  lotSize: number | null;
  averagePrice: number;
  investedValue: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  // F&O
  strikePrice: number | null;
  optionType: string | null;
  expiryDate: Date | null;
  // MF
  schemeName: string | null;
  units: number | null;
  nav: number | null;
  // Benchmark
  niftyAtEntry: number | null;
  benchmarkPnL: number | null;
  alpha: number | null;
  // Portfolio
  portfolioId: string | null;
  name: string | null;
  side: string;
  dayPnl: number;
  stopLoss: number | null;
  target: number | null;
  strategy: string | null;
  // Status
  status: string;
  exitPrice: number | null;
  exitDate: Date | null;
  realizedPnL: number | null;
  // Meta
  notes: string | null;
  tags: string[];
  entryDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaperPortfolioSummary {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: number;
  totalPositions: number;
  stockPositions: number;
  fnoPositions: number;
  mfPositions: number;
  benchmarkPnL: number;
  alpha: number;
}

/**
 * Get all paper positions for a user
 */
export async function getPaperPositions(
  userId: string,
  filters: { status?: string; assetType?: string } = {}
): Promise<{ positions: PaperPosition[]; summary: PaperPortfolioSummary }> {
  const where: any = { userId };

  if (filters.status) {
    where.status = filters.status;
  }
  if (filters.assetType) {
    where.assetType = filters.assetType;
  }

  const positions = await prisma.paperPosition.findMany({
    where,
    orderBy: { updatedAt: "desc" },
  });

  // Finite-guarded summary over OPEN positions (see paper-logic.ts).
  const s = summarizePaperPortfolio(positions);

  return {
    positions: positions as PaperPosition[],
    summary: {
      totalInvested: s.totalInvested,
      totalCurrent: s.totalCurrent,
      totalPnL: s.totalPnL,
      pnlPercentage: s.pnlPercentage,
      totalPositions: s.totalPositions,
      stockPositions: s.stockPositions,
      fnoPositions: s.fnoPositions,
      mfPositions: s.mfPositions,
      benchmarkPnL: s.benchmarkPnL,
      alpha: s.alpha,
    },
  };
}

/**
 * Get a single paper position
 */
export async function getPaperPosition(
  userId: string,
  positionId: string
): Promise<PaperPosition | null> {
  const position = await prisma.paperPosition.findFirst({
    where: { id: positionId, userId },
  });
  return position as PaperPosition | null;
}

/**
 * Create a new paper position
 */
export async function createPaperPosition(
  userId: string,
  data: PaperPositionInput
): Promise<PaperPosition> {
  // Finite-guarded persisted numbers (a non-web caller / missing Zod gate can
  // otherwise write a NaN/Infinity paper position). See paper-logic.ts.
  const norm = normalizeCreateValues({
    quantity: data.quantity,
    averagePrice: data.averagePrice,
  });

  const position = await prisma.paperPosition.create({
    data: {
      userId,
      symbol: data.symbol.toUpperCase(),
      name: data.name,
      assetType: data.assetType,
      segment: resolveSegment(data.segment, data.assetType),
      exchange: data.exchange || "NSE",
      positionType: data.positionType || "LONG",
      side: resolveSide(data.side, data.positionType),
      quantity: norm.quantity,
      lotSize: data.lotSize,
      averagePrice: norm.averagePrice,
      investedValue: norm.investedValue,
      currentPrice: norm.currentPrice,
      currentValue: norm.currentValue,
      unrealizedPnL: 0,
      pnlPercentage: 0,
      dayPnl: 0,
      // F&O
      strikePrice: data.strikePrice,
      optionType: data.optionType,
      expiryDate: data.expiryDate,
      // MF
      schemeName: data.schemeName,
      units: data.units,
      nav: data.nav,
      // Benchmark
      niftyAtEntry: data.niftyAtEntry,
      benchmarkPnL: 0,
      alpha: 0,
      // Portfolio
      portfolioId: data.portfolioId,
      // Strategy
      stopLoss: data.stopLoss,
      target: data.target,
      strategy: data.strategy,
      // Status
      status: "OPEN",
      // Notes
      notes: data.notes,
      tags: data.tags || [],
      entryDate: new Date(),
    },
  });
  return position as PaperPosition;
}

/**
 * Update paper position prices
 */
export async function updatePaperPositionPrice(
  userId: string,
  positionId: string,
  currentPrice: number,
  currentNifty?: number
): Promise<boolean> {
  const position = await prisma.paperPosition.findFirst({
    where: { id: positionId, userId },
  });

  if (!position) return false;

  // Finite-guarded mark-to-market + benchmark/alpha (see paper-logic.ts).
  const currentValue = computeCurrentValue(position.quantity, currentPrice);
  const unrealizedPnL = computeUnrealizedPnL(
    position.positionType,
    currentValue,
    position.investedValue
  );
  const pnlPercentage = computePnlPercentage(
    unrealizedPnL,
    position.investedValue
  );
  const { benchmarkPnL, alpha } = benchmarkAndAlpha(
    position.investedValue,
    unrealizedPnL,
    position.niftyAtEntry,
    currentNifty
  );

  const result = await prisma.paperPosition.updateMany({
    where: { id: positionId, userId },
    data: {
      currentPrice: finite(currentPrice),
      currentValue,
      unrealizedPnL,
      pnlPercentage,
      benchmarkPnL,
      alpha,
    },
  });
  return result.count > 0;
}

/**
 * Close a paper position
 */
export async function closePaperPosition(
  userId: string,
  positionId: string,
  exitPrice: number,
  currentNifty?: number
): Promise<{ success: boolean; pnl: number }> {
  const position = await prisma.paperPosition.findFirst({
    where: { id: positionId, userId, status: "OPEN" },
  });

  if (!position) return { success: false, pnl: 0 };

  // Finite-guarded realized P&L + benchmark/alpha (see paper-logic.ts).
  const exitValue = computeCurrentValue(position.quantity, exitPrice);
  const realizedPnL = computeRealizedPnL(
    position.positionType,
    position.quantity,
    exitPrice,
    position.investedValue
  );
  const { benchmarkPnL, alpha } = benchmarkAndAlpha(
    position.investedValue,
    realizedPnL,
    position.niftyAtEntry,
    currentNifty
  );

  await prisma.paperPosition.updateMany({
    where: { id: positionId, userId },
    data: {
      status: "CLOSED",
      exitPrice: finite(exitPrice),
      exitDate: new Date(),
      currentPrice: finite(exitPrice),
      currentValue: exitValue,
      unrealizedPnL: 0,
      realizedPnL,
      pnlPercentage: computePnlPercentage(realizedPnL, position.investedValue),
      benchmarkPnL,
      alpha,
    },
  });

  return { success: true, pnl: realizedPnL };
}

/**
 * Delete a paper position
 */
export async function deletePaperPosition(
  userId: string,
  positionId: string
): Promise<boolean> {
  const result = await prisma.paperPosition.deleteMany({
    where: { id: positionId, userId },
  });
  return result.count > 0;
}

/**
 * Get paper trading performance summary
 */
export async function getPaperPerformance(userId: string): Promise<{
  totalTrades: number;
  closedTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  totalRealizedPnL: number;
  totalBenchmarkPnL: number;
  totalAlpha: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
}> {
  const closedPositions = await prisma.paperPosition.findMany({
    where: { userId, status: "CLOSED" },
    orderBy: { realizedPnL: "desc" },
  });

  const openPositions = await prisma.paperPosition.findMany({
    where: { userId, status: "OPEN" },
  });

  // Finite-guarded performance aggregation (win-rate div-by-zero, best/worst
  // NaN, total poison all guarded — see paper-logic.ts).
  const perf = calculatePerformance(closedPositions, openPositions.length);

  return {
    totalTrades: perf.totalTrades,
    closedTrades: perf.closedTrades,
    winners: perf.winners,
    losers: perf.losers,
    winRate: perf.winRate,
    totalRealizedPnL: perf.totalRealizedPnL,
    totalBenchmarkPnL: perf.totalBenchmarkPnL,
    totalAlpha: perf.totalAlpha,
    bestTrade: perf.bestTrade,
    worstTrade: perf.worstTrade,
  };
}

/**
 * Update or average into an existing position (for order-based trading)
 * If same symbol+side already open, averages the price. Otherwise creates new.
 */
export async function updateOrAveragePosition(
  userId: string,
  portfolioId: string,
  data: {
    symbol: string;
    name: string;
    exchange: string;
    instrumentType: string;
    side: string;
    quantity: number;
    price: number;
    stopLoss?: number;
    target?: number;
    strategy?: string;
    optionType?: string;
    strikePrice?: number;
    expiry?: Date;
    lotSize?: number;
  }
): Promise<PaperPosition> {
  // Check for existing open position with same symbol and side
  const existing = await prisma.paperPosition.findFirst({
    where: {
      userId,
      portfolioId,
      symbol: data.symbol.toUpperCase(),
      side: data.side,
      status: "OPEN",
    },
  });

  if (existing) {
    // Average the new fill into the existing position. Guards the
    // divide-by-zero when the legs net to zero quantity (see paper-logic.ts).
    const avg = averageIntoPosition(
      {
        quantity: existing.quantity,
        averagePrice: existing.averagePrice,
        currentPrice: existing.currentPrice,
      },
      { quantity: data.quantity, price: data.price }
    );

    const updated = await prisma.paperPosition.update({
      where: { id: existing.id },
      data: {
        quantity: avg.quantity,
        averagePrice: avg.averagePrice,
        investedValue: avg.investedValue,
        currentValue: avg.currentValue,
        stopLoss: data.stopLoss ?? existing.stopLoss,
        target: data.target ?? existing.target,
        strategy: data.strategy ?? existing.strategy,
      },
    });
    return updated as PaperPosition;
  }

  // Create new position
  const assetType = assetTypeForInstrumentType(data.instrumentType);

  return createPaperPosition(userId, {
    symbol: data.symbol,
    name: data.name,
    assetType,
    exchange: data.exchange,
    positionType: positionTypeForSide(data.side),
    side: data.side,
    quantity: data.quantity,
    averagePrice: data.price,
    portfolioId,
    stopLoss: data.stopLoss,
    target: data.target,
    strategy: data.strategy,
    optionType: data.optionType as "CE" | "PE" | undefined,
    strikePrice: data.strikePrice,
    expiryDate: data.expiry,
    lotSize: data.lotSize,
  });
}

/**
 * Get combined dashboard stats for paper trading
 */
export async function getPaperDashboardStats(userId: string) {
  const openPositions = await prisma.paperPosition.findMany({
    where: { userId, status: "OPEN" },
  });

  const closedPositions = await prisma.paperPosition.findMany({
    where: { userId, status: "CLOSED" },
  });

  // Finite-guarded OPEN-position totals (incl. dayPnl) and the CLOSED-position
  // performance block (win-rate div-by-zero, best/worst NaN, avg poison all
  // guarded — see paper-logic.ts).
  const s = summarizePaperPortfolio(openPositions);
  const perf = calculatePerformance(closedPositions, openPositions.length);

  return {
    positions: {
      open: openPositions.length,
      closed: closedPositions.length,
      totalInvested: s.totalInvested,
      totalCurrentValue: s.totalCurrent,
      totalPnl: s.totalPnL,
      totalPnlPercentage: s.pnlPercentage,
      dayPnl: s.dayPnl,
    },
    performance: {
      winRate: perf.winRate,
      totalTrades: perf.closedTrades,
      winners: perf.winners,
      losers: perf.losers,
      avgWin: perf.avgWin,
      avgLoss: perf.avgLoss,
      bestTrade: perf.bestTradePnL,
      worstTrade: perf.worstTradePnL,
    },
  };
}
