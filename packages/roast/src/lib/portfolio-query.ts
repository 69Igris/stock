/**
 * Roast portfolio-query helpers (MONEY-838 de-shadow)
 *
 * The PURE pieces of `steps/fetch-portfolio.ts` — Prisma where-clause builders,
 * the trade-subset gate, and the summary / behavioural-stats math — extracted so
 * they can be tested against the REAL source instead of a re-implemented shadow.
 * `fetch-portfolio.ts` is now a thin I/O shell that calls these; the prior
 * `roast-steps.test.ts` shadow had reimplemented this logic inline and even
 * filtered on the wrong field (`brokerName`, the bug fixed in `eab5942f`), so the
 * shadow stayed green against code that no longer existed in production.
 *
 * No Prisma / no I/O here — only data in, data out.
 */

import type { BrokerType } from "@prisma/client";
import type {
  StockHolding,
  MfHolding,
  TradeRow,
  TradeStats,
  PortfolioSummary,
} from "../types";

export interface PortfolioWhereParams {
  userId: string;
  mode: "overall" | "broker";
  broker?: string;
  brokerUserId?: string;
  symbols?: string[];
}

export interface TradeWhereParams extends PortfolioWhereParams {
  dateFrom?: string;
  dateTo?: string;
}

/** A non-empty symbol list, or undefined. Shared by the holdings + trade gates. */
function symbolFilterOf(symbols?: string[]): string[] | undefined {
  return symbols?.length ? symbols : undefined;
}

/**
 * Holdings + MF Prisma `where` for a roast.
 *
 * MONEY-837: holdings/MFs store the account on the `broker` ENUM (+ `brokerUserId`);
 * the sync never writes `brokerName` for them, so filtering on `brokerName` matched
 * NULL → zero rows → a false "no portfolio data". Use the `broker` enum, and narrow
 * to a SPECIFIC account when `brokerUserId` is given (a broker can have multiple
 * logins). A symbol subset narrows holdings only (MFs have no stock symbol).
 */
export function buildPortfolioWhere(p: PortfolioWhereParams): {
  holdingsWhere: Record<string, unknown>;
  mfWhere: Record<string, unknown>;
} {
  const holdingsWhere: Record<string, unknown> = { userId: p.userId };
  const mfWhere: Record<string, unknown> = { userId: p.userId };

  if (p.mode === "broker" && p.broker) {
    holdingsWhere.broker = p.broker as BrokerType;
    mfWhere.broker = p.broker as BrokerType;
    if (p.brokerUserId) {
      holdingsWhere.brokerUserId = p.brokerUserId;
      mfWhere.brokerUserId = p.brokerUserId;
    }
  }

  const symbolFilter = symbolFilterOf(p.symbols);
  if (symbolFilter) holdingsWhere.symbol = { in: symbolFilter };

  return { holdingsWhere, mfWhere };
}

/**
 * Whether to load actual trades: a TRADEBOOK-scoped roast, or any date/symbol
 * filter, means the roast should judge trading BEHAVIOUR (not just holdings).
 */
export function wantTrades(p: {
  scope?: "PORTFOLIO" | "TRADEBOOK";
  dateFrom?: string;
  dateTo?: string;
  symbols?: string[];
}): boolean {
  return (
    p.scope === "TRADEBOOK" ||
    Boolean(p.dateFrom) ||
    Boolean(p.dateTo) ||
    Boolean(symbolFilterOf(p.symbols))
  );
}

/**
 * Trade Prisma `where`. Same broker/account scoping as holdings, plus a symbol
 * subset and a tradeDate range (date ranges bite on trades, not point-in-time
 * holdings).
 */
export function buildTradeWhere(p: TradeWhereParams): Record<string, unknown> {
  const tradeWhere: Record<string, unknown> = { userId: p.userId };

  if (p.mode === "broker" && p.broker) {
    tradeWhere.broker = p.broker as BrokerType;
    if (p.brokerUserId) tradeWhere.brokerUserId = p.brokerUserId;
  }

  const symbolFilter = symbolFilterOf(p.symbols);
  if (symbolFilter) tradeWhere.symbol = { in: symbolFilter };

  if (p.dateFrom || p.dateTo) {
    tradeWhere.tradeDate = {
      ...(p.dateFrom ? { gte: new Date(p.dateFrom) } : {}),
      ...(p.dateTo ? { lte: new Date(p.dateTo) } : {}),
    };
  }

  return tradeWhere;
}

/** Behavioural stats over a trade subset — drives the TRADEBOOK roast. */
export function computeTradeStats(trades: TradeRow[]): TradeStats {
  const symbolCounts = new Map<string, number>();
  let buys = 0;
  let sells = 0;
  let turnover = 0;
  let realizedPnL = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let firstTrade: Date | null = null;
  let lastTrade: Date | null = null;

  for (const t of trades) {
    if (t.tradeType === "BUY") buys++;
    else if (t.tradeType === "SELL") sells++;
    turnover += Number.isFinite(t.tradeValue) ? t.tradeValue : 0;
    if (t.realizedPnL != null && Number.isFinite(t.realizedPnL)) {
      realizedPnL += t.realizedPnL;
      if (t.realizedPnL > 0) winningTrades++;
      else if (t.realizedPnL < 0) losingTrades++;
    }
    symbolCounts.set(t.symbol, (symbolCounts.get(t.symbol) || 0) + 1);
    if (!firstTrade || t.tradeDate < firstTrade) firstTrade = t.tradeDate;
    if (!lastTrade || t.tradeDate > lastTrade) lastTrade = t.tradeDate;
  }

  const topSymbols = Array.from(symbolCounts.entries())
    .map(([symbol, count]) => ({ symbol, trades: count }))
    .sort((a, b) => b.trades - a.trades)
    .slice(0, 5);

  return {
    totalTrades: trades.length,
    buys,
    sells,
    distinctSymbols: symbolCounts.size,
    turnover,
    realizedPnL,
    winningTrades,
    losingTrades,
    topSymbols,
    firstTrade,
    lastTrade,
  };
}

/** Totals + sector concentration over the holdings/MFs. */
export function computePortfolioSummary(
  holdings: StockHolding[],
  mfs: MfHolding[],
): PortfolioSummary {
  const totalStockInvested = holdings.reduce((s, h) => s + h.investedValue, 0);
  const totalStockCurrent = holdings.reduce((s, h) => s + h.currentValue, 0);
  const totalMfInvested = mfs.reduce((s, m) => s + m.investedAmount, 0);
  const totalMfCurrent = mfs.reduce((s, m) => s + m.currentValue, 0);

  const sectorMap = new Map<string, number>();
  for (const h of holdings) {
    const sec = h.sector || "Unknown";
    sectorMap.set(sec, (sectorMap.get(sec) || 0) + h.currentValue);
  }

  const sectorConcentration = Array.from(sectorMap.entries())
    .map(([sector, value]) => ({
      sector,
      value,
      percentage: totalStockCurrent > 0 ? (value / totalStockCurrent) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  return {
    totalStockInvested,
    totalStockCurrent,
    totalMfInvested,
    totalMfCurrent,
    sectorConcentration,
    stockCount: holdings.length,
    mfCount: mfs.length,
  };
}
