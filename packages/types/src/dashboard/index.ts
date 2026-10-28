export interface RecentTrade {
  id: string;
  symbol: string;
  exchange: string;
  tradeType: string;
  quantity: number;
  price: number;
  realizedPnL?: number | null;
  tradeDate: Date | string;
}

export interface DashboardStats {
  portfolio: PortfolioStats;
  trading: TradingStats;
  charts: ChartData;
  recentTrades: RecentTrade[];
}

export interface PortfolioStats {
  totalValue: number;
  totalPnL: number;
  pnlPercentage: string;
  holdingsValue: number;
  holdingsInvested: number;
  holdingsPnL: number;
  mfValue: number;
  mfInvested: number;
  mfPnL: number;
  openPositionsValue: number;
  openPositionsPnL: number;
}

export interface TradingStats {
  totalRealizedPnL: number;
  totalUnrealizedPnL?: number;
  totalTrades: number;
  closedTrades?: number;
  openTrades?: number;
  todaysPnL: number;
  /**
   * MONEY-1074: mark-to-market TODAY = Σ holdings dayChange + todaysPnL
   * (realized). Optional so a 5-min-cached pre-deploy DashboardStats object
   * (Redis) still deserializes; consumers fall back to `todaysPnL`.
   */
  todaysChange?: number;
  todaysTrades: number;
  winRate: number;
  winners: number;
  losers: number;
  bestTrade?: { symbol: string; pnl: number | null } | null;
  worstTrade?: { symbol: string; pnl: number | null } | null;
}

export interface ChartData {
  dailyPnL: DailyPnL[];
}

export interface DailyPnL {
  date: string;
  pnl: number;
  cumulativePnL: number;
}

/**
 * Annualised portfolio-return metrics (MONEY-485).
 *
 * Each metric is `null` when it cannot be computed correctly from the
 * available data (e.g. no dated trade cashflows, no holding period).
 * Consumers render an honest "—" placeholder for `null` - the value is
 * NEVER faked or zero-filled.
 *
 * `xirrPct` / `cagrPct` are expressed in percent (18.7 = 18.7%).
 */
export interface PortfolioReturns {
  /** Money-weighted annualised return from dated trade cashflows. */
  xirrPct: number | null;
  /** Compound annual growth rate over the realised holding period. */
  cagrPct: number | null;
  /** First-purchase date used for the holding period (ISO date), if known. */
  firstInvestmentDate: string | null;
  /** Elapsed holding period in years (basis for CAGR), if known. */
  holdingPeriodYears: number | null;
}
