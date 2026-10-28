/**
 * Trade Pairing Service
 *
 * Orchestrates trade pairing using the FIFO algorithm and persists
 * results to the PairedTradeView model.
 */

import prisma from "@/lib/prisma";
import { pairTradesFIFO, type PairingResult } from "@usemoney/core/pairing";
import {
  derivePairingPrice,
  deriveEffectiveIsin,
  reconcileOpenLotsVsHoldings,
  type ReconReport,
} from "@/lib/pairing/pairing-logic";
import type {
  Trade,
  PairedTradeView,
  BrokerType,
  TradeSource,
} from "@prisma/client";
import { v4 as uuidv4 } from "uuid";

interface PairTradesOptions {
  userId: string;
  batchId?: string;
  symbol?: string; // Optional: pair only specific symbol
  broker?: BrokerType; // Optional: pair only specific broker
  brokerUserId?: string; // Optional: pair only specific broker account
  forceRepair?: boolean; // Re-pair all trades, not just those flagged
}

interface PairTradesResult {
  success: boolean;
  batchId: string;
  stats: {
    tradesProcessed: number;
    openPositions: number;
    closedPositions: number;
    partialPositions: number;
    totalRealizedPnL: number;
  };
  error?: string;
}

/**
 * Pair trades for a user and persist to PairedTradeView
 */
export async function pairUserTrades(
  options: PairTradesOptions
): Promise<PairTradesResult> {
  const { userId, symbol, broker, brokerUserId, forceRepair = false } = options;
  const batchId = options.batchId || uuidv4();

  try {
    // Build query for trades to pair
    const where: any = { userId };

    if (!forceRepair) {
      where.needsRepairing = true;
    }

    if (symbol) {
      where.symbol = symbol;
    }

    if (broker) {
      where.broker = broker;
    }

    if (brokerUserId) {
      where.brokerUserId = brokerUserId;
    }

    // Fetch trades that need pairing
    const trades = await prisma.trade.findMany({
      where,
      orderBy: [{ tradeDate: "asc" }, { tradeTime: "asc" }],
    });

    if (trades.length === 0) {
      return {
        success: true,
        batchId,
        stats: {
          tradesProcessed: 0,
          openPositions: 0,
          closedPositions: 0,
          partialPositions: 0,
          totalRealizedPnL: 0,
        },
      };
    }

    // Convert trades to pairing algorithm input format.
    // Price + effective-ISIN derivation live in pairing-logic.ts (pure, tested).
    const tradeInputs = trades.map((t) => {
      return {
        id: t.id,
        userId: t.userId,
        symbol: t.symbol,
        // Include ISIN for proper matching across symbol name changes.
        isin: deriveEffectiveIsin(t),
        exchange: t.exchange,
        segment: t.segment,
        broker: t.broker,
        brokerUserId: t.brokerUserId,
        tradeType: t.tradeType,
        positionType: t.positionType,
        productType: t.productType,
        quantity: t.quantity,
        price: derivePairingPrice(t),
        tradeDate: t.tradeDate,
        tradeTime: t.tradeTime,
        sourceType: t.sourceType,
        segmentLabel: null,
        productTypeLabel: null,
      };
    });

    // Run the pairing algorithm
    const result: PairingResult = pairTradesFIFO(tradeInputs);

    // Get unique symbols and ISINs to clear old views
    const symbols = Array.from(new Set(trades.map((t) => t.symbol)));
    // Collect ISINs including those derived from tradingSymbol for MF trades.
    // Same derivation as the pairing input above (deriveEffectiveIsin).
    const isins = Array.from(
      new Set(trades.map((t) => deriveEffectiveIsin(t)).filter(Boolean))
    ) as string[];

    // Delete existing paired views for the affected symbols/ISINs and broker combinations
    // We need to delete by both symbol and ISIN to handle cases where symbol names changed
    if (forceRepair || trades.length > 0) {
      await prisma.pairedTradeView.deleteMany({
        where: {
          userId,
          OR: [
            // Match by symbol (for trades without ISIN)
            symbol ? { symbol } : { symbol: { in: symbols } },
            // Also match by ISIN if available (handles symbol name changes)
            ...(isins.length > 0 ? [{ isin: { in: isins } }] : []),
          ],
          ...(broker ? { broker } : {}),
          ...(brokerUserId ? { brokerUserId } : {}),
        },
      });
    }

    // Insert new paired views
    if (result.pairedViews.length > 0) {
      await prisma.pairedTradeView.createMany({
        data: result.pairedViews.map((view) => ({
          userId: view.userId,
          sourceTradeIds: view.sourceTradeIds,
          entryTradeId: view.entryTradeId,
          exitTradeId: view.exitTradeId,
          symbol: view.symbol,
          isin: view.isin, // Store ISIN for proper matching across symbol name changes
          exchange: view.exchange,
          segment: view.segment,
          broker: view.broker,
          brokerUserId: view.brokerUserId,
          entryDate: view.entryDate,
          entryPrice: view.entryPrice,
          entryQuantity: view.entryQuantity,
          exitDate: view.exitDate,
          exitPrice: view.exitPrice,
          quantity: view.quantity,
          realizedPnL: view.realizedPnL,
          pnlPercentage: view.pnlPercentage,
          status: view.status,
          positionType: view.positionType,
          productType: view.productType,
          sourceType: view.sourceType,
          tradeType: view.tradeType,
          segmentLabel: view.segmentLabel,
          productTypeLabel: view.productTypeLabel,
          pairingBatchId: batchId,
        })),
      });
    }

    // Mark trades as paired (needsRepairing = false)
    const tradeIds = trades.map((t) => t.id);
    await prisma.trade.updateMany({
      where: { id: { in: tradeIds } },
      data: { needsRepairing: false },
    });

    return {
      success: true,
      batchId,
      stats: {
        tradesProcessed: trades.length,
        openPositions: result.stats.openPositions,
        closedPositions: result.stats.closedPositions,
        partialPositions: result.stats.partialPositions,
        totalRealizedPnL: result.stats.totalRealizedPnL,
      },
    };
  } catch (error) {
    console.error("Error pairing trades:", error);
    return {
      success: false,
      batchId,
      stats: {
        tradesProcessed: 0,
        openPositions: 0,
        closedPositions: 0,
        partialPositions: 0,
        totalRealizedPnL: 0,
      },
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Trigger re-pairing for all trades of a user
 * Useful after import or sync
 */
export async function triggerFullRepairing(userId: string): Promise<void> {
  // Mark all trades as needing re-pairing
  await prisma.trade.updateMany({
    where: { userId },
    data: { needsRepairing: true },
  });
}

/**
 * Mark specific trades for re-pairing
 */
export async function markTradesForRepairing(
  tradeIds: string[]
): Promise<void> {
  await prisma.trade.updateMany({
    where: { id: { in: tradeIds } },
    data: { needsRepairing: true },
  });
}

/**
 * Get paired trade views for display in tradebook
 */
export interface PairedTradeFilters {
  symbol?: string;
  broker?: string;
  segment?: string;
  status?: "OPEN" | "CLOSED" | "PARTIAL" | "all";
  fromDate?: string;
  toDate?: string;
  limit?: number;
  skip?: number;
  sortBy?: "date" | "pnl";
  sortOrder?: "asc" | "desc";
}

export interface SegmentPnL {
  segment: string;
  realizedPnL: number;
  unrealizedPnL: number;
  closedCount: number;
  openCount: number;
  winners: number;
  losers: number;
}

export interface PairedTradeStats {
  totalTrades: number;
  openCount: number;
  closedCount: number;
  partialCount: number;
  totalRealizedPnL: number;
  totalUnrealizedPnL: number;
  winRate: number;
  winners: number;
  losers: number;
  // Segment-wise breakdown
  segmentBreakdown: SegmentPnL[];
}

export async function getPairedTrades(
  userId: string,
  filters: PairedTradeFilters = {}
): Promise<{
  trades: PairedTradeView[];
  total: number;
  stats: PairedTradeStats;
}> {
  const where: any = { userId };

  if (filters.symbol) {
    where.symbol = { contains: filters.symbol, mode: "insensitive" };
  }

  if (filters.broker && filters.broker !== "all") {
    if (filters.broker === "manual") {
      where.broker = null;
    } else if (filters.broker.includes(":")) {
      const [broker, brokerUserId] = filters.broker.split(":");
      where.broker = broker;
      if (brokerUserId) {
        where.brokerUserId = brokerUserId;
      }
    } else {
      where.broker = filters.broker;
    }
  }

  if (filters.segment && filters.segment !== "all") {
    // Map segment filter values similar to trades.ts
    const segmentMappings: Record<string, string[]> = {
      CASH: ["CASH", "EQUITY", "NSE", "BSE", "CNC", "MIS"],
      FO: ["FO", "NFO", "BFO", "NRML"],
      CD: ["CD", "CDS", "CURRENCY"],
      COM: ["COM", "MCX", "NCDEX", "COMMODITY"],
      MF: ["MF", "MUTUAL", "MUTUAL_FUND"],
    };
    const segmentValues = segmentMappings[filters.segment] || [filters.segment];
    where.segment = { in: segmentValues };
  }

  if (filters.status && filters.status !== "all") {
    where.status = filters.status;
  }

  if (filters.fromDate || filters.toDate) {
    where.entryDate = {};
    if (filters.fromDate) {
      where.entryDate.gte = new Date(filters.fromDate);
    }
    if (filters.toDate) {
      const toDate = new Date(filters.toDate);
      toDate.setHours(23, 59, 59, 999);
      where.entryDate.lte = toDate;
    }
  }

  // Fetch paired trades with pagination
  const sortDirection = filters.sortOrder || "desc";
  const sortBy = filters.sortBy || "date";

  // Determine orderBy based on sortBy
  let orderBy: any;
  if (sortBy === "pnl") {
    orderBy = { realizedPnL: sortDirection };
  } else {
    orderBy = { entryDate: sortDirection };
  }

  // Use DB-level counts instead of fetching ALL records and counting in JS.
  // Only fetch the full records for CLOSED trades (realized P&L) and
  // OPEN/PARTIAL trades (unrealized P&L) with status filter at DB level.
  const allUserWhere = { userId };

  const [
    trades,
    total,
    // Filtered stats: use counts + targeted queries instead of fetching ALL
    filteredClosedTrades,
    filteredOpenCount,
    filteredPartialCount,
    // All user trades for segment breakdown: separate CLOSED and OPEN queries
    allClosedTrades,
    allOpenTrades,
    holdings,
    positions,
    mutualFunds,
  ] = await Promise.all([
    prisma.pairedTradeView.findMany({
      where,
      orderBy,
      take: filters.limit || 50,
      skip: filters.skip || 0,
    }),
    prisma.pairedTradeView.count({ where }),
    // Filtered CLOSED trades for P&L stats (uses @@index([userId, status]))
    prisma.pairedTradeView.findMany({
      where: { ...where, status: "CLOSED" },
      select: {
        realizedPnL: true,
        segment: true,
        symbol: true,
      },
    }),
    // Count OPEN trades (no need to fetch full records)
    prisma.pairedTradeView.count({ where: { ...where, status: "OPEN" } }),
    // Count PARTIAL trades
    prisma.pairedTradeView.count({ where: { ...where, status: "PARTIAL" } }),
    // All user CLOSED trades for segment breakdown
    prisma.pairedTradeView.findMany({
      where: { ...allUserWhere, status: "CLOSED" },
      select: {
        realizedPnL: true,
        segment: true,
        symbol: true,
      },
    }),
    // All user OPEN/PARTIAL paired lots. Used for the Holdings↔pairing
    // RECONCILIATION (MONEY-840) — NOT for unrealized P&L any more (that is
    // sourced from current state: Positions/Holdings/MF only, to avoid the
    // double-count). Carries the identity fields the reconciler keys on.
    prisma.pairedTradeView.findMany({
      where: { ...allUserWhere, status: { in: ["OPEN", "PARTIAL"] } },
      select: {
        segment: true,
        symbol: true,
        isin: true,
        exchange: true,
        broker: true,
        brokerUserId: true,
        quantity: true,
        entryPrice: true,
      },
    }),
    // Get holdings for current prices and unrealized P&L (for equity/CNC trades).
    // Identity + quantity fields are also used by the reconciler.
    prisma.holding.findMany({
      where: { userId },
      select: {
        symbol: true,
        isin: true,
        exchange: true,
        broker: true,
        brokerUserId: true,
        quantity: true,
        t1Quantity: true,
        currentPrice: true,
        currentValue: true,
        investedValue: true,
        pnl: true,
      },
    }),
    // Get positions for current prices (for F&O, intraday - synced from broker)
    prisma.position.findMany({
      where: { userId, netQuantity: { not: 0 } },
      select: {
        symbol: true,
        segment: true,
        lastPrice: true,
        unrealizedPnl: true,
        netQuantity: true,
        averagePrice: true,
      },
    }),
    // Get mutual funds for unrealized P&L
    prisma.mutualFund.findMany({
      where: { userId },
      select: {
        schemeName: true,
        currentValue: true,
        investedAmount: true,
        investedValue: true,
        unrealizedGain: true,
        pnl: true,
      },
    }),
  ]);

  // MONEY-840: the symbol→currentPrice and symbol→positionUnrealizedPnL maps
  // that used to drive open-paired-lot P&L were removed alongside the
  // double-count — unrealized P&L now comes straight off the current-state
  // Position/Holding/MutualFund rows (each carries its own price + P&L).

  // Helper function to normalize segment name
  const normalizeSegment = (segment: string | null): string => {
    if (!segment) return "Other";
    const upperSegment = segment.toUpperCase();
    if (["CASH", "EQUITY", "NSE", "BSE", "CNC", "MIS"].includes(upperSegment))
      return "Equity";
    if (["FO", "NFO", "BFO", "NRML"].includes(upperSegment)) return "F&O";
    if (["CD", "CDS", "CURRENCY"].includes(upperSegment)) return "Currency";
    if (["COM", "MCX", "NCDEX", "COMMODITY"].includes(upperSegment))
      return "Commodity";
    if (["MF", "MUTUAL", "MUTUAL_FUND"].includes(upperSegment))
      return "Mutual Funds";
    return segment;
  };

  // Stats from DB-level filtered queries (no more in-memory filtering of ALL records)
  const openCount = filteredOpenCount;
  const closedCount = filteredClosedTrades.length;
  const partialCount = filteredPartialCount;

  const winners = filteredClosedTrades.filter((t) => (t.realizedPnL || 0) > 0);
  const losers = filteredClosedTrades.filter((t) => (t.realizedPnL || 0) < 0);

  const totalRealizedPnL = filteredClosedTrades.reduce(
    (sum, t) => sum + (t.realizedPnL || 0),
    0
  );

  // MONEY-840 — UNREALIZED P&L COMES FROM CURRENT STATE ONLY.
  //
  // Previously this also walked the open PairedTradeView lots and added
  // `(currentPrice − entryPrice) × qty` for equity, THEN added Holdings P&L on
  // top — double-counting every equity position (once as an open paired lot,
  // once as a Holding). PairedTradeView now contributes REALIZED P&L only
  // (CLOSED rows above); unrealized + open counts are sourced exclusively from
  // the current-state tables:
  //   - Position   → F&O / intraday open P&L (pre-computed by the broker)
  //   - Holding    → delivery-equity open P&L
  //   - MutualFund → MF open P&L
  let totalUnrealizedPnL = 0;

  // F&O / intraday: sum the broker-computed unrealized P&L across open positions.
  let totalPositionsUnrealizedPnL = 0;
  positions.forEach((p) => {
    if (p.unrealizedPnl !== null && p.unrealizedPnl !== undefined) {
      totalPositionsUnrealizedPnL += p.unrealizedPnl;
    } else if (p.lastPrice && p.averagePrice && p.netQuantity) {
      totalPositionsUnrealizedPnL +=
        (p.lastPrice - p.averagePrice) * p.netQuantity;
    }
  });

  // Calculate total Holdings unrealized P&L (for Equity segment)
  let totalHoldingsUnrealizedPnL = 0;
  let totalHoldingsOpenCount = 0;
  holdings.forEach((h) => {
    // Holdings unrealized P&L: use pnl if non-zero, otherwise calculate from currentValue - investedValue
    // This matches the pattern used in the holdings page
    const unrealized =
      h.pnl !== null && h.pnl !== undefined && h.pnl !== 0
        ? h.pnl
        : (h.currentValue || 0) - (h.investedValue || 0);
    totalHoldingsUnrealizedPnL += unrealized;
    totalHoldingsOpenCount++;
  });

  // Calculate total MF unrealized P&L
  let totalMfUnrealizedPnL = 0;
  let totalMfOpenCount = 0;
  mutualFunds.forEach((mf) => {
    // MF unrealized P&L: use unrealizedGain if non-zero, otherwise calculate from currentValue - invested
    // This matches the holdings page logic that treats unrealizedGain=0 as a signal to calculate
    const invested = mf.investedAmount || mf.investedValue || 0;
    const unrealized =
      mf.unrealizedGain !== null &&
      mf.unrealizedGain !== undefined &&
      mf.unrealizedGain !== 0
        ? mf.unrealizedGain
        : (mf.currentValue || 0) - invested;
    totalMfUnrealizedPnL += unrealized;
    totalMfOpenCount++;
  });

  // Total unrealized P&L = current-state only (no open-paired-lot contribution).
  totalUnrealizedPnL +=
    totalPositionsUnrealizedPnL +
    totalHoldingsUnrealizedPnL +
    totalMfUnrealizedPnL;

  // ── Holdings ↔ pairing RECONCILIATION (MONEY-840). Non-blocking: compare
  //    Σ open paired-lot qty vs Holding.quantity + t1Quantity per security and
  //    log any drift. Corp-action adjustment keeps splits from false-alarming;
  //    securities with no matching Holding (F&O, pre-platform) are ignored.
  const reconciliation: ReconReport = reconcileOpenLotsVsHoldings(
    allOpenTrades.map((t) => ({
      symbol: t.symbol,
      isin: t.isin,
      exchange: t.exchange,
      broker: t.broker,
      brokerUserId: t.brokerUserId,
      quantity: t.quantity,
    })),
    holdings.map((h) => ({
      symbol: h.symbol,
      isin: h.isin,
      exchange: h.exchange,
      broker: h.broker,
      brokerUserId: h.brokerUserId,
      quantity: h.quantity,
      t1Quantity: h.t1Quantity,
    }))
  );
  if (!reconciliation.ok) {
    console.warn(
      `[pairing-recon] userId=${userId}: ${reconciliation.drifted.length}/${reconciliation.comparedCount} securities drift between open paired lots and Holdings`,
      reconciliation.drifted.map((d) => ({
        symbol: d.symbol,
        isin: d.isin,
        pairedOpenQuantity: d.pairedOpenQuantity,
        holdingQuantity: d.holdingQuantity,
        drift: d.drift,
      }))
    );
  }

  // Calculate segment-wise breakdown from pre-filtered queries
  const segmentMap = new Map<string, SegmentPnL>();

  const getOrCreateSegment = (segment: string): SegmentPnL => {
    let stats = segmentMap.get(segment);
    if (!stats) {
      stats = {
        segment,
        realizedPnL: 0,
        unrealizedPnL: 0,
        closedCount: 0,
        openCount: 0,
        winners: 0,
        losers: 0,
      };
      segmentMap.set(segment, stats);
    }
    return stats;
  };

  // Process closed trades (already filtered at DB level)
  allClosedTrades.forEach((t) => {
    const stats = getOrCreateSegment(normalizeSegment(t.segment));
    stats.closedCount++;
    stats.realizedPnL += t.realizedPnL || 0;
    if ((t.realizedPnL || 0) > 0) stats.winners++;
    if ((t.realizedPnL || 0) < 0) stats.losers++;
  });

  // Open positions for the per-segment unrealized P&L + open counts come from
  // CURRENT STATE (Positions for F&O/intraday), NOT from open PairedTradeView
  // lots — walking the paired lots here double-counted against the Holdings /
  // MF contributions added below (MONEY-840). Each open Position adds its
  // broker-computed unrealized P&L (or a lastPrice-derived fallback) and one
  // open count to its segment.
  positions.forEach((p) => {
    const stats = getOrCreateSegment(normalizeSegment(p.segment));
    stats.openCount++;
    if (p.unrealizedPnl !== null && p.unrealizedPnl !== undefined) {
      stats.unrealizedPnL += p.unrealizedPnl;
    } else if (p.lastPrice && p.averagePrice && p.netQuantity) {
      stats.unrealizedPnL += (p.lastPrice - p.averagePrice) * p.netQuantity;
    }
  });

  // Add Holdings data to Equity segment (Holdings are "open" equity positions)
  if (holdings.length > 0) {
    let equityStats = segmentMap.get("Equity");
    if (!equityStats) {
      equityStats = {
        segment: "Equity",
        realizedPnL: 0,
        unrealizedPnL: 0,
        closedCount: 0,
        openCount: 0,
        winners: 0,
        losers: 0,
      };
      segmentMap.set("Equity", equityStats);
    }
    // Add Holdings open positions and unrealized P&L
    equityStats.openCount += totalHoldingsOpenCount;
    equityStats.unrealizedPnL += totalHoldingsUnrealizedPnL;
  }

  // Add Mutual Funds segment data (MFs are always "open" positions)
  if (mutualFunds.length > 0) {
    let mfStats = segmentMap.get("Mutual Funds");
    if (!mfStats) {
      mfStats = {
        segment: "Mutual Funds",
        realizedPnL: 0,
        unrealizedPnL: 0,
        closedCount: 0,
        openCount: 0,
        winners: 0,
        losers: 0,
      };
      segmentMap.set("Mutual Funds", mfStats);
    }
    // Add MF open positions and unrealized P&L
    mfStats.openCount += totalMfOpenCount;
    mfStats.unrealizedPnL += totalMfUnrealizedPnL;
  }

  const segmentBreakdown = Array.from(segmentMap.values()).sort(
    (a, b) => Math.abs(b.realizedPnL) - Math.abs(a.realizedPnL)
  );

  return {
    trades,
    total,
    stats: {
      totalTrades: total,
      openCount,
      closedCount,
      partialCount,
      totalRealizedPnL,
      totalUnrealizedPnL,
      winRate:
        closedCount > 0 ? Math.round((winners.length / closedCount) * 100) : 0,
      winners: winners.length,
      losers: losers.length,
      segmentBreakdown,
    },
  };
}

/**
 * Check if pairing is needed for a user
 * Returns true if:
 * 1. There are trades marked as needsRepairing
 * 2. There are trades but no paired views (legacy data)
 */
export async function checkPairingNeeded(userId: string): Promise<boolean> {
  // Check for trades needing repair
  const needsRepairCount = await prisma.trade.count({
    where: { userId, needsRepairing: true },
  });
  if (needsRepairCount > 0) return true;

  // Check for legacy scenario: trades exist but no paired views
  const [tradesCount, pairedCount] = await Promise.all([
    prisma.trade.count({ where: { userId } }),
    prisma.pairedTradeView.count({ where: { userId } }),
  ]);

  // If there are trades but no paired views, pairing is needed
  return tradesCount > 0 && pairedCount === 0;
}
