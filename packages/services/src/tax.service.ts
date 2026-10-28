/**
 * Tax Service
 *
 * Tax report generation: capital gains, harvesting, advance tax, ITR schedule.
 * Source: apps/web/lib/actions/tax.ts
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
import { dbLogger as logger } from "@usemoney/logger";
import type {
  CapitalGainsTaxResult,
  TaxHarvestingResult,
  AdvanceTaxResult,
  ITRScheduleResult,
} from "@usemoney/research";
import {
  computeCapitalGainsTaxTool,
  computeTaxHarvestingTool,
  computeAdvanceTaxTool,
  generateItrScheduleTool,
} from "@usemoney/research/tools";
import type { ServiceResult } from "./types";
import {
  getCurrentFY,
  parseFYDates,
  mapPairedTradesForFY,
  mapHoldingsForHarvesting,
  safeISODate,
  type PairedTradeForFY,
} from "./tax-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface TaxReportResult {
  capitalGains: CapitalGainsTaxResult;
  harvesting: TaxHarvestingResult;
  advanceTax: AdvanceTaxResult;
  itrSchedule: ITRScheduleResult;
}

// `PairedTradeForFY` is owned by `tax-logic.ts` (single source of truth) and
// re-exported here so existing `@usemoney/services` consumers (web action, api
// route) keep importing it from the barrel unchanged.
export type { PairedTradeForFY } from "./tax-logic";

// ── Fallback defaults ─────────────────────────────────────────────

const EMPTY_HARVESTING: TaxHarvestingResult = {
  opportunities: [],
  totalPotentialSaving: 0,
  gaarWarning: "",
};

const EMPTY_ADVANCE_TAX: AdvanceTaxResult = {
  totalEstimatedTax: 0,
  isApplicable: false,
  installments: [],
  interestU234C: 0,
};

const EMPTY_ITR_SCHEDULE: ITRScheduleResult = {
  scheduleCG: {
    s111A: { description: "", stcgGains: 0, stcgTax: 0 },
    s112A: {
      description: "",
      ltcgGains: 0,
      exemption: 0,
      taxable: 0,
      ltcgTax: 0,
    },
  },
  csvData: "",
  summary: "",
};

// ── Service Functions ──────────────────────────────────────────────

export async function getPairedTradesForFY(
  userId: string,
  fy?: string,
): Promise<ServiceResult<PairedTradeForFY[]>> {
  try {
    const fyStr = fy || getCurrentFY();
    const { start, end } = parseFYDates(fyStr);

    const pairedTrades = await prisma.pairedTradeView.findMany({
      where: {
        userId,
        status: "CLOSED",
        exitDate: {
          gte: start,
          lte: end,
        },
      },
      select: {
        symbol: true,
        entryDate: true,
        exitDate: true,
        entryPrice: true,
        exitPrice: true,
        quantity: true,
        segment: true,
      },
      orderBy: { exitDate: "desc" },
    });

    // Pure, Invalid-Date-safe mapping: a stored trade with an unparseable
    // entry/exit date is DROPPED (never crashes the whole report on
    // `.toISOString()`), and non-finite prices/quantities are coerced to 0
    // rather than leaking NaN into the gain.
    const trades = mapPairedTradesForFY(pairedTrades);

    return { success: true, data: trades };
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), userId },
      "Failed to fetch paired trades for FY",
    );
    return { success: false, error: "Failed to fetch trade data." };
  }
}

export async function getTaxReport(
  userId: string,
  fy?: string,
): Promise<ServiceResult<TaxReportResult>> {
  try {
    const fyStr = fy || getCurrentFY();

    // MONEY-705 stampede protection. The flight key IS the cache key, derived
    // by the SAME `generateCacheKey` call the get/set pair uses — so it carries
    // both the userId AND the financial year, and two users (or two FYs) can
    // never share one execution. The flight resolves to the whole ServiceResult
    // so the mid-body compute failures keep their exact shape and stay uncached.
    return await singleFlight(
      generateCacheKey("tax" as const, userId, `report:${fyStr}`),
      () => resolveTaxReport(userId, fyStr),
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), userId },
      "Tax report generation service error",
    );
    return {
      success: false,
      error: "Failed to generate tax report. Please try again.",
    };
  }
}

/** Cache-read → compute → cache-write body, run at most once per key per flight. */
async function resolveTaxReport(
  userId: string,
  fyStr: string,
): Promise<ServiceResult<TaxReportResult>> {
  // Check cache
  const cached = await getCached<TaxReportResult>(
    "tax" as const,
    userId,
    `report:${fyStr}`,
  );
  if (cached) {
    logger.debug({ userId, fy: fyStr }, "Tax report from cache");
    return { success: true, data: cached };
  }

  logger.debug({ userId, fy: fyStr }, "Tax report cache miss");

  // 1. Fetch closed trades for this FY
  const tradesResult = await getPairedTradesForFY(userId, fyStr);
  if (!tradesResult.success) {
    return {
      success: false,
      error: tradesResult.error || "Failed to fetch trades",
    };
  }

  // 2. Compute capital gains tax
  const cgResult = await computeCapitalGainsTaxTool.execute({
    trades: tradesResult.data,
    fy: fyStr,
  });
  if (!cgResult.success) {
    return {
      success: false,
      error: cgResult.error || "Capital gains computation failed",
    };
  }
  const capitalGains = cgResult.data as CapitalGainsTaxResult;

  // 3. Fetch current holdings for tax harvesting (direct Prisma query)
  const holdings = await prisma.holding.findMany({
    where: { userId },
    select: {
      symbol: true,
      quantity: true,
      averagePrice: true,
      currentPrice: true,
      createdAt: true,
    },
  });

  // `safeISODate(new Date())` is always a valid YYYY-MM-DD; `?? ""` only
  // satisfies the type-narrowing (the fallback is never actually used).
  const todayISO = safeISODate(new Date()) ?? "";
  // Pure, Invalid-Date-safe mapping: a holding whose `createdAt` is missing OR
  // unparseable falls back to today instead of throwing on `.toISOString()`.
  const holdingsForHarvesting = mapHoldingsForHarvesting(holdings, todayISO);

  // 4. Tax harvesting
  const harvestResult = await computeTaxHarvestingTool.execute({
    holdings: holdingsForHarvesting,
    realizedGains: capitalGains.equity.stcg.net + capitalGains.equity.ltcg.net,
  });
  const harvesting =
    (harvestResult.data as TaxHarvestingResult) || EMPTY_HARVESTING;

  // 5. Advance tax
  const advanceResult = await computeAdvanceTaxTool.execute({
    totalEstimatedTax: capitalGains.totalTax,
  });
  const advanceTax =
    (advanceResult.data as AdvanceTaxResult) || EMPTY_ADVANCE_TAX;

  // 6. ITR Schedule
  const itrResult = await generateItrScheduleTool.execute({
    capitalGains,
  });
  const itrSchedule =
    (itrResult.data as ITRScheduleResult) || EMPTY_ITR_SCHEDULE;

  const result: TaxReportResult = {
    capitalGains,
    harvesting,
    advanceTax,
    itrSchedule,
  };

  // Cache for 10 minutes
  await setCached(
    "tax" as const,
    userId,
    `report:${fyStr}`,
    result,
    undefined,
    { ttl: 600, enableMemory: true, enableRedis: true },
  );

  return { success: true, data: result };
}

// ── Tax ledgers (MONEY-1062 P4d — apps/api parity) ─────────────────────────

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
  totals: { fnoPnl: number; intradayPnl: number; dividendIncome: number };
}

function isFnoSegment(segment: string): boolean {
  const s = segment.toUpperCase();
  return s === "FNO" || s === "F&O" || s === "NFO" || s === "BFO";
}
/** Trade rows are Prisma DateTime (always valid) → raw slice mirrors the web. */
function fmtLedgerDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * F&O / Intraday / Dividend ledgers for the Tax Report page. Port of
 * getTaxLedgersAction (apps/web/lib/actions/tax-ledgers.ts:67) — the demo/auth
 * gate stays in the caller; the service owns the userId-scoped Trade read + the
 * grouping. FY window reuses the canonical `parseFYDates` (IST-aware, shared
 * with getTaxReport) rather than the web action's inline `parseFy`. Dividends
 * have no model yet → always empty (unchanged from the web action).
 */
export async function getTaxLedgers(
  userId: string,
  fy?: string,
): Promise<ServiceResult<TaxLedgers>> {
  try {
    const fyStr = fy || getCurrentFY();
    const { start, end } = parseFYDates(fyStr);

    const trades = await prisma.trade.findMany({
      where: { userId, tradeDate: { gte: start, lte: end } },
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

    // ── F&O ledger: group by (instrument · date · tradeType) → directional row.
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
      const key = `${inst}__${fmtLedgerDate(t.tradeDate)}__${t.tradeType}`;
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
        date: fmtLedgerDate(v.date),
        instrument: v.instrument,
        side: v.side === "BUY" ? "BUY → SELL" : "SELL → BUY",
        lots: v.lots,
        pnl: v.pnl,
      });
      fnoTotal += v.pnl;
    }
    fnoRows.sort((a, b) => (a.date < b.date ? 1 : -1));

    // ── Intraday ledger: equity MIS / same-day matched BUY+SELL.
    const eqTrades = trades.filter(
      (t) => !isFnoSegment(t.segment) && t.segment.toUpperCase() !== "FUTURES",
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
      const key = `${t.symbol}__${fmtLedgerDate(t.tradeDate)}`;
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
        date: fmtLedgerDate(v.date),
        symbol: v.symbol,
        pnl: v.pnl,
      });
      intradayTotal += v.pnl;
    }
    intradayRows.sort((a, b) => (a.date < b.date ? 1 : -1));

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
    logger.error(
      { error: error instanceof Error ? error.message : String(error), userId },
      "Tax ledgers service error",
    );
    return { success: false, error: "Failed to load ledgers" };
  }
}
