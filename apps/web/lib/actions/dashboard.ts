"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import type { DashboardStats, PortfolioReturns } from "@usemoney/types";
import {
  getDashboardStats as getDashboardStatsService,
  getPortfolioReturns as getPortfolioReturnsService,
} from "@usemoney/services";
import { calcXirr, calcCagr, type CashFlow } from "@usemoney/core/calc";
import { isDemoSession } from "@/lib/demo/session";
import { demoDashboardStats, demoTrades } from "@/lib/demo/data";

export type { DashboardStats, DailyPnL } from "@usemoney/types";
export type { PortfolioReturns } from "@usemoney/types";

/**
 * Get dashboard statistics with caching
 */
export async function getDashboardStatsAction(): Promise<
  ActionResponse<DashboardStats>
> {
  // Demo mode
  if (await isDemoSession()) {
    return { success: true, data: demoDashboardStats };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  return getDashboardStatsService(authUser.userId);
}

// Sanity bounds shared with the service - keep these in lockstep so the demo
// path and the real path apply identical plausibility gates.
const MIN_PLAUSIBLE_RATE = -0.99;
const MAX_PLAUSIBLE_RATE = 10;
const MIN_DAYS_FOR_XIRR = 7;

/**
 * Compute annualised portfolio returns (XIRR + CAGR) from dated trade
 * cashflows. Backs the holdings 5-stat strip (XIRR / CAGR tiles) and the
 * dashboard overview return stat (MONEY-485).
 *
 * Returns `null` for a metric when it cannot be computed correctly from real
 * data - the UI renders an honest "—" rather than a fabricated number.
 */
export async function getPortfolioReturnsAction(): Promise<
  ActionResponse<PortfolioReturns>
> {
  // Demo mode - compute real returns from the static demo trade book so the
  // demo shows a coherent number (not a hardcoded fake) using the same math.
  if (await isDemoSession()) {
    return { success: true, data: computeDemoReturns() };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  return getPortfolioReturnsService(authUser.userId);
}

/**
 * Derive XIRR / CAGR for demo mode from `demoTrades` + the demo portfolio's
 * current value. Mirrors the service algorithm exactly (BUY = outflow, SELL =
 * inflow, current value as the terminal flow). Demo data is illustrative, not
 * a real user portfolio, so computing from it is honest - and it still returns
 * `null` if the demo data ever can't support a clean computation.
 */
function computeDemoReturns(): PortfolioReturns {
  const now = new Date();
  const flows: CashFlow[] = [];
  let totalInvested = 0;
  let totalProceeds = 0;
  let firstBuyDate: Date | null = null;

  for (const t of demoTrades) {
    const value =
      t.tradeValue != null && t.tradeValue > 0
        ? t.tradeValue
        : (t.quantity || 0) * (t.price || 0);
    if (!(value > 0)) continue;
    const date = new Date(t.tradeDate);
    if (t.tradeType === "BUY") {
      flows.push({ date, amount: -value });
      totalInvested += value;
      if (!firstBuyDate || date < firstBuyDate) firstBuyDate = date;
    } else if (t.tradeType === "SELL") {
      flows.push({ date, amount: value });
      totalProceeds += value;
    }
  }

  const currentValue = demoDashboardStats.portfolio.totalValue;
  if (currentValue > 0) flows.push({ date: now, amount: currentValue });

  const spanDays =
    firstBuyDate != null
      ? (now.getTime() - firstBuyDate.getTime()) / (1000 * 60 * 60 * 24)
      : 0;

  let xirrPct: number | null = null;
  if (flows.length >= 2 && spanDays >= MIN_DAYS_FOR_XIRR) {
    const rate = calcXirr(flows);
    if (
      Number.isFinite(rate) &&
      rate >= MIN_PLAUSIBLE_RATE &&
      rate <= MAX_PLAUSIBLE_RATE
    ) {
      xirrPct = rate * 100;
    }
  }

  let cagrPct: number | null = null;
  let holdingPeriodYears: number | null = null;
  if (firstBuyDate != null && totalInvested > 0) {
    const years = spanDays / 365;
    const cagr = calcCagr(totalInvested, currentValue + totalProceeds, years);
    if (
      cagr != null &&
      cagr >= MIN_PLAUSIBLE_RATE &&
      cagr <= MAX_PLAUSIBLE_RATE
    ) {
      cagrPct = cagr * 100;
      holdingPeriodYears = Math.round(years * 100) / 100;
    }
  }

  return {
    xirrPct,
    cagrPct,
    firstInvestmentDate:
      firstBuyDate != null
        ? (firstBuyDate.toISOString().split("T")[0] ?? null)
        : null,
    holdingPeriodYears,
  };
}
