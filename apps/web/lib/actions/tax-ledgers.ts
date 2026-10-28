"use server";

/**
 * Tax ledgers - F&O / Intraday / Dividend tables for the Tax Report
 * page (design Tax.jsx). Pulls real trades from the `Trade` collection
 * scoped to a FY and shapes them into the three ledger rows.
 *
 * Dividend tracking has no model yet - returns an empty list with a
 * helpful note.
 */

import prisma from "@usemoney/database";
import { getAuthenticatedUser } from "@/lib/auth";
import { isDemoSession } from "@/lib/demo/session";
import type { ActionResponse } from "@usemoney/validation";

export interface FnoLedgerRow {
  date: string;
  instrument: string;
  side: string;
  lots: number;
  pnl: number;
}

export interface IntradayLedgerRow {
  date: string;
  symbol: string;
  pnl: number;
}

export interface DividendLedgerRow {
  date: string;
  symbol: string;
  amount: number;
}

export interface TaxLedgers {
  fno: FnoLedgerRow[];
  intraday: IntradayLedgerRow[];
  dividends: DividendLedgerRow[];
  totals: {
    fnoPnl: number;
    intradayPnl: number;
    dividendIncome: number;
  };
}

function parseFy(fy: string): { start: Date; end: Date } {
  // "2026-27" → April 1 2026 → March 31 2027
  const [startYear] = fy.split("-").map((s) => parseInt(s, 10));
  const safeStart = isNaN(startYear) ? new Date().getFullYear() : startYear;
  return {
    start: new Date(Date.UTC(safeStart, 3, 1)),
    end: new Date(Date.UTC(safeStart + 1, 3, 1)),
  };
}

function isFnoSegment(segment: string): boolean {
  const s = segment.toUpperCase();
  return s === "FNO" || s === "F&O" || s === "NFO" || s === "BFO";
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getTaxLedgersAction(
  fy: string
): Promise<ActionResponse<TaxLedgers>> {
  const empty: TaxLedgers = {
    fno: [],
    intraday: [],
    dividends: [],
    totals: { fnoPnl: 0, intradayPnl: 0, dividendIncome: 0 },
  };
  if (await isDemoSession()) {
    return { success: true, data: empty };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  const { start, end } = parseFy(fy);

  try {
    const trades = await prisma.trade.findMany({
      where: {
        userId: user.userId,
        tradeDate: { gte: start, lt: end },
      },
      select: {
        symbol: true,
        tradingSymbol: true,
        segment: true,
        productType: true,
        tradeType: true,
        quantity: true,
        price: true,
        realizedPnL: true,
        tradeDate: true,
      },
      orderBy: { tradeDate: "asc" },
    });

    // ── F&O ledger ──
    // Group by (instrument · tradeDate) and produce a directional row.
    const fnoRows: FnoLedgerRow[] = [];
    let fnoTotal = 0;
    const fnoGroup = new Map<
      string,
      {
        date: Date;
        instrument: string;
        side: "BUY" | "SELL";
        lots: number;
        pnl: number;
      }
    >();
    for (const t of trades) {
      if (!isFnoSegment(t.segment)) continue;
      const inst = t.tradingSymbol ?? t.symbol;
      const key = `${inst}__${fmtDate(t.tradeDate)}__${t.tradeType}`;
      const existing = fnoGroup.get(key);
      const lots = Math.abs(t.quantity);
      const pnl = t.realizedPnL ?? 0;
      if (existing) {
        existing.lots += lots;
        existing.pnl += pnl;
      } else {
        fnoGroup.set(key, {
          date: t.tradeDate,
          instrument: inst,
          side: t.tradeType.toUpperCase() === "BUY" ? "BUY" : "SELL",
          lots,
          pnl,
        });
      }
    }
    for (const v of Array.from(fnoGroup.values())) {
      fnoRows.push({
        date: fmtDate(v.date),
        instrument: v.instrument,
        side: v.side === "BUY" ? "BUY → SELL" : "SELL → BUY",
        lots: v.lots,
        pnl: v.pnl,
      });
      fnoTotal += v.pnl;
    }
    fnoRows.sort((a, b) => (a.date < b.date ? 1 : -1));

    // ── Intraday ledger ──
    // Equity trades with productType MIS or same-day BUY+SELL of same symbol.
    const eqTrades = trades.filter(
      (t) => !isFnoSegment(t.segment) && t.segment.toUpperCase() !== "FUTURES"
    );
    const bySymbolDay = new Map<
      string,
      {
        date: Date;
        symbol: string;
        buyQty: number;
        sellQty: number;
        pnl: number;
      }
    >();
    for (const t of eqTrades) {
      const isMis = (t.productType ?? "").toUpperCase() === "MIS";
      const key = `${t.symbol}__${fmtDate(t.tradeDate)}`;
      const existing = bySymbolDay.get(key);
      if (existing) {
        if (t.tradeType.toUpperCase() === "BUY") existing.buyQty += t.quantity;
        else existing.sellQty += t.quantity;
        if (isMis) existing.pnl += t.realizedPnL ?? 0;
      } else {
        bySymbolDay.set(key, {
          date: t.tradeDate,
          symbol: t.symbol,
          buyQty: t.tradeType.toUpperCase() === "BUY" ? t.quantity : 0,
          sellQty: t.tradeType.toUpperCase() === "SELL" ? t.quantity : 0,
          pnl: isMis ? (t.realizedPnL ?? 0) : 0,
        });
      }
    }
    const intradayRows: IntradayLedgerRow[] = [];
    let intradayTotal = 0;
    for (const v of Array.from(bySymbolDay.values())) {
      const matched = Math.min(v.buyQty, v.sellQty);
      if (matched <= 0 && v.pnl === 0) continue;
      intradayRows.push({
        date: fmtDate(v.date),
        symbol: v.symbol,
        pnl: v.pnl,
      });
      intradayTotal += v.pnl;
    }
    intradayRows.sort((a, b) => (a.date < b.date ? 1 : -1));

    // ── Dividend ledger ──
    // No Dividend model yet - return empty. The page renders an
    // empty-state pointing to the not-yet-built feature.

    return {
      success: true,
      data: {
        fno: fnoRows,
        intraday: intradayRows,
        dividends: [],
        totals: {
          fnoPnl: fnoTotal,
          intradayPnl: intradayTotal,
          dividendIncome: 0,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to load ledgers",
    };
  }
}
