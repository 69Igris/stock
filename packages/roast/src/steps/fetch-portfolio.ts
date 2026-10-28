/**
 * Step 1: Fetch Portfolio Data
 *
 * Queries holdings and mutual funds from Prisma, computes summary stats (sector
 * concentration, totals, P&L). For a TRADEBOOK-scoped roast (the "specific
 * trade" subset) it also loads the actual Trade rows — filtered by broker /
 * account / date range / symbols — and derives behavioural stats so the roast
 * can judge HOW the user traded, not just what they hold. No LLM call.
 *
 * MONEY-838: the where-builders, the trade-subset gate, and the summary / stats
 * math now live in `../lib/portfolio-query` (pure, unit-tested against the real
 * source). This file is the thin Prisma I/O shell that calls them.
 */

import { prisma } from "@usemoney/database";
import type {
  PortfolioData,
  StockHolding,
  MfHolding,
  TradeRow,
  TradeStats,
} from "../types";
import {
  buildPortfolioWhere,
  buildTradeWhere,
  wantTrades,
  computeTradeStats,
  computePortfolioSummary,
} from "../lib/portfolio-query";

export async function fetchPortfolio(
  userId: string,
  mode: "overall" | "broker",
  broker: string | undefined,
  assetType: "stocks" | "mf" | "all",
  brokerUserId?: string,
  scope: "PORTFOLIO" | "TRADEBOOK" = "PORTFOLIO",
  dateFrom?: string,
  dateTo?: string,
  symbols?: string[],
): Promise<PortfolioData> {
  const { holdingsWhere, mfWhere } = buildPortfolioWhere({
    userId,
    mode,
    broker,
    brokerUserId,
    symbols,
  });

  let holdings: StockHolding[] = [];
  let mfs: MfHolding[] = [];

  if (assetType === "stocks" || assetType === "all") {
    holdings = await prisma.holding.findMany({
      where: holdingsWhere,
      select: {
        symbol: true,
        name: true,
        sector: true,
        quantity: true,
        averagePrice: true,
        currentPrice: true,
        investedValue: true,
        currentValue: true,
        unrealizedPnL: true,
        pnlPercentage: true,
        brokerName: true,
      },
    });
  }

  if (assetType === "mf" || assetType === "all") {
    mfs = await prisma.mutualFund.findMany({
      where: mfWhere,
      select: {
        schemeName: true,
        category: true,
        units: true,
        averageNav: true,
        currentNav: true,
        investedAmount: true,
        currentValue: true,
        unrealizedGain: true,
        xirr: true,
        brokerName: true,
      },
    });
  }

  // MONEY-837: TRADEBOOK scope (or any date/symbol filter) loads actual trades so
  // the roast can judge trading BEHAVIOUR (churn, win-rate, turnover, timing).
  let trades: TradeRow[] | undefined;
  let tradeStats: TradeStats | undefined;

  if (wantTrades({ scope, dateFrom, dateTo, symbols })) {
    const tradeWhere = buildTradeWhere({
      userId,
      mode,
      broker,
      brokerUserId,
      symbols,
      dateFrom,
      dateTo,
    });
    const rows = await prisma.trade.findMany({
      where: tradeWhere,
      select: {
        symbol: true,
        tradeType: true,
        quantity: true,
        price: true,
        tradeValue: true,
        realizedPnL: true,
        tradeDate: true,
      },
      orderBy: { tradeDate: "desc" },
      take: 2000,
    });
    trades = rows.map((t) => ({
      symbol: t.symbol,
      tradeType: t.tradeType,
      quantity: t.quantity,
      price: t.price,
      tradeValue: t.tradeValue ?? t.quantity * t.price,
      realizedPnL: t.realizedPnL ?? null,
      tradeDate: t.tradeDate,
    }));
    tradeStats = computeTradeStats(trades);
  }

  return {
    holdings,
    mfs,
    trades,
    tradeStats,
    summary: computePortfolioSummary(holdings, mfs),
  };
}
