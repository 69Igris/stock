/**
 * Trades pure-logic helpers.
 *
 * Side-effect-free logic used by `getTrades`, `createTrade`, and
 * `closePosition` in `./trades.ts`: segment-filter mapping, FIFO buy/sell
 * pairing, where-clause building, trade-stats math, and realized-P&L
 * calculation.
 *
 * Isolated here (away from the Prisma-importing `trades.ts`) so it can be
 * unit-tested without pulling in the Prisma client at import time. Behavior is
 * identical to the logic that previously lived inline in `trades.ts`.
 */

export interface TradeFilterInput {
  symbol?: string;
  broker?: string;
  segment?: string;
  tradeType?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  skip?: number;
}

export interface TradeStats {
  totalPnL: number;
  winRate: number;
  winners: number;
  losers: number;
  totalTrades: number;
}

/**
 * Minimal trade shape consumed by `pairTrades`. Extra fields on the input rows
 * are preserved via the spread in the returned objects.
 */
export interface PairableTrade {
  id: string;
  symbol: string;
  exchange: string;
  broker: string | null;
  tradeType: string;
  quantity: number;
  price: number;
  tradeDate: Date;
  status?: string;
}

/** A paired trade carries the input fields plus computed pairing results. */
export type PairedTrade<T extends PairableTrade> = T & {
  status: string;
  exitPrice?: number | null;
  realizedPnL?: number | null;
  pairedWith?: string[];
};

/**
 * Map a segment filter value to all possible database values.
 * Handles old data that might have different segment values.
 */
export function getSegmentFilterValues(segment: string): string[] {
  const segmentMappings: Record<string, string[]> = {
    // Equity segment - could be stored as CASH, EQUITY, NSE/BSE exchange, or CNC/MIS product types
    CASH: ["CASH", "EQUITY", "NSE", "BSE", "CNC", "MIS"],
    // F&O segment - could be stored as FO, NFO, BFO, or product types like NRML
    FO: ["FO", "NFO", "BFO", "NRML"],
    // Currency segment
    CD: ["CD", "CDS", "CURRENCY"],
    // Commodity segment
    COM: ["COM", "MCX", "NCDEX", "COMMODITY"],
  };
  return segmentMappings[segment] || [segment];
}

/**
 * Pair buy/sell trades of the same symbol to determine if trades are closed.
 * Returns trades with computed status, exitPrice, and realizedPnL.
 *
 * Grouping key: symbol + exchange + broker + trade-date (YYYY-MM-DD).
 * - quantities match     -> all CLOSED, P&L = (avgSell - avgBuy) * qty
 * - quantities partial   -> closed side CLOSED, other side PARTIAL, P&L pro-rated
 * - one-sided / unmatched -> keep existing status (default "OPEN")
 */
export function pairTrades<T extends PairableTrade>(
  trades: T[]
): PairedTrade<T>[] {
  // Group trades by symbol + exchange + broker + date
  const tradeGroups = new Map<string, T[]>();

  for (const trade of trades) {
    const dateStr = new Date(trade.tradeDate).toISOString().split("T")[0];
    const key = `${trade.symbol}|${trade.exchange}|${trade.broker || ""}|${dateStr}`;
    if (!tradeGroups.has(key)) {
      tradeGroups.set(key, []);
    }
    tradeGroups.get(key)!.push(trade);
  }

  const pairedTrades: PairedTrade<T>[] = [];

  for (const [, group] of Array.from(tradeGroups)) {
    const buys = group.filter((t) => t.tradeType === "BUY");
    const sells = group.filter((t) => t.tradeType === "SELL");

    // Calculate total buy and sell quantities
    const totalBuyQty = buys.reduce((sum, t) => sum + t.quantity, 0);
    const totalSellQty = sells.reduce((sum, t) => sum + t.quantity, 0);

    // If quantities match, it's a closed trade
    if (totalBuyQty > 0 && totalSellQty > 0 && totalBuyQty === totalSellQty) {
      // Calculate weighted average prices
      const avgBuyPrice =
        buys.reduce((sum, t) => sum + t.price * t.quantity, 0) / totalBuyQty;
      const avgSellPrice =
        sells.reduce((sum, t) => sum + t.price * t.quantity, 0) / totalSellQty;

      // Calculate P&L (for BUY first then SELL, P&L = sell - buy)
      const realizedPnL = (avgSellPrice - avgBuyPrice) * totalBuyQty;

      // Mark all trades in this group as CLOSED
      for (const trade of group) {
        pairedTrades.push({
          ...trade,
          status: "CLOSED",
          exitPrice: trade.tradeType === "BUY" ? avgSellPrice : avgBuyPrice,
          realizedPnL: trade.tradeType === "BUY" ? realizedPnL : -realizedPnL,
          pairedWith: group.filter((t) => t.id !== trade.id).map((t) => t.id),
        });
      }
    } else if (totalBuyQty > 0 && totalSellQty > 0) {
      // Partial match - some trades are closed, some open
      const closedQty = Math.min(totalBuyQty, totalSellQty);
      const avgBuyPrice =
        buys.reduce((sum, t) => sum + t.price * t.quantity, 0) / totalBuyQty;
      const avgSellPrice =
        sells.reduce((sum, t) => sum + t.price * t.quantity, 0) / totalSellQty;
      const realizedPnL = (avgSellPrice - avgBuyPrice) * closedQty;

      for (const trade of group) {
        const isFullyClosed =
          trade.tradeType === "BUY"
            ? totalSellQty >= totalBuyQty
            : totalBuyQty >= totalSellQty;

        pairedTrades.push({
          ...trade,
          status: isFullyClosed ? "CLOSED" : "PARTIAL",
          exitPrice: trade.tradeType === "BUY" ? avgSellPrice : avgBuyPrice,
          realizedPnL:
            trade.tradeType === "BUY"
              ? realizedPnL * (trade.quantity / totalBuyQty)
              : -realizedPnL * (trade.quantity / totalSellQty),
        });
      }
    } else {
      // No matching trades - all open
      for (const trade of group) {
        pairedTrades.push({
          ...trade,
          status: trade.status || "OPEN",
        });
      }
    }
  }

  return pairedTrades;
}

/**
 * Build the where clause for trade queries.
 *
 * Broker handling differs from positions: "manual" maps to
 * `brokerName: "manual"` (not `broker: null`).
 */
export function buildTradeWhereClause(
  userId: string,
  filters: TradeFilterInput
): Record<string, unknown> {
  const where: Record<string, unknown> = { userId };

  if (filters.symbol) {
    where.symbol = { contains: filters.symbol, mode: "insensitive" };
  }
  if (filters.broker && filters.broker !== "all") {
    // Handle broker filter - could be "manual" or "BROKER:userId" format
    if (filters.broker === "manual") {
      // Manual entries have null broker - use brokerName field which stores "manual"
      where.brokerName = "manual";
    } else if (filters.broker.includes(":")) {
      // Format: "BROKER:brokerUserId"
      const [broker, brokerUserId] = filters.broker.split(":");
      where.broker = broker;
      if (brokerUserId) {
        where.brokerUserId = brokerUserId;
      }
    } else {
      // Just broker name - could be enum value like "ZERODHA"
      where.broker = filters.broker;
    }
  }
  if (filters.segment && filters.segment !== "all") {
    // Use segment mapping to handle old data with different segment values
    const segmentValues = getSegmentFilterValues(filters.segment);
    where.segment = { in: segmentValues };
  }
  if (filters.tradeType && filters.tradeType !== "all") {
    where.tradeType = filters.tradeType;
  }
  if (filters.fromDate || filters.toDate) {
    const tradeDate: Record<string, Date> = {};
    if (filters.fromDate) {
      tradeDate.gte = new Date(filters.fromDate);
    }
    if (filters.toDate) {
      const toDate = new Date(filters.toDate);
      toDate.setHours(23, 59, 59, 999);
      tradeDate.lte = toDate;
    }
    where.tradeDate = tradeDate;
  }

  return where;
}

/**
 * Calculate trade stats from a list of (already-filtered) trades plus the
 * total trade count. This is the pure JS twin of the DB-level aggregate/count
 * stats produced by `getTrades`: a closed trade is a winner iff
 * realizedPnL > 0, totalPnL sums closed realizedPnL, winRate is the rounded
 * winner percentage over closed trades.
 */
export function calculateTradeStats(
  allFiltered: { status: string; realizedPnL: number | null }[],
  total: number
): TradeStats {
  const closedTrades = allFiltered.filter((t) => t.status === "CLOSED");
  const winners = closedTrades.filter((t) => (t.realizedPnL || 0) > 0);
  const totalPnL = closedTrades.reduce(
    (sum, t) => sum + (t.realizedPnL || 0),
    0
  );

  return {
    totalPnL,
    winRate:
      closedTrades.length > 0
        ? Math.round((winners.length / closedTrades.length) * 100)
        : 0,
    winners: winners.length,
    losers: closedTrades.length - winners.length,
    totalTrades: total,
  };
}

/**
 * Compute the realized P&L recorded by `createTrade` when an exit price is
 * present. SHORT profits when price falls; LONG (default) profits when price
 * rises. Brokerage is subtracted.
 */
export function calculateTradeRealizedPnL(
  positionType: string,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  brokerage: number
): number {
  const pnl =
    positionType === "SHORT"
      ? (entryPrice - exitPrice) * quantity
      : (exitPrice - entryPrice) * quantity;
  return pnl - brokerage;
}

/**
 * Compute the P&L for closing a position (`closePosition`). LONG profits when
 * the exit exceeds entry; otherwise (SHORT) profits when entry exceeds exit.
 * Brokerage is subtracted.
 */
export function calculateClosePositionPnL(
  positionType: string,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  brokerage: number
): number {
  const pnl =
    positionType === "LONG"
      ? (exitPrice - entryPrice) * quantity
      : (entryPrice - exitPrice) * quantity;
  return pnl - brokerage;
}
