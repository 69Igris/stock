/**
 * Pure backtest computation + validation for POST /api/backtest.
 *
 * Extracted from `./route.ts` so the indicator math (SMA / RSI), the
 * strategy trade-generators (MA crossover, RSI), input validation, and the
 * response shaping are tested against the REAL exported symbols the route
 * calls — not inline copies. Kept free of `next/server` / Clerk / Yahoo
 * imports so it stays a cheap pure unit.
 *
 * @see apps/web/__tests__/api/backtest.test.ts
 */

export interface BacktestTrade {
  type: "BUY" | "SELL";
  date: string;
  price: number;
  pnl?: number;
}

export interface BacktestResponse {
  symbol: string;
  strategy: string;
  period: string;
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  totalPnl: number;
  trades: BacktestTrade[];
}

export interface StrategyRun {
  trades: BacktestTrade[];
  totalPnl: number;
  winners: number;
  losers: number;
}

/** Known strategy identifiers the route supports. */
export const VALID_STRATEGIES = ["MA_CROSSOVER", "RSI"] as const;
export type StrategyName = (typeof VALID_STRATEGIES)[number];

/** Simple Moving Average; `null` for the first `period - 1` positions. */
export function calculateSMA(
  data: number[],
  period: number
): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    }
  }
  return result;
}

/** Relative Strength Index; `null` for index 0 and the first `period` rows. */
export function calculateRSI(
  data: number[],
  period: number = 14
): (number | null)[] {
  const result: (number | null)[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      result.push(null);
      continue;
    }

    const change = data[i] - data[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);

    if (i < period) {
      result.push(null);
      continue;
    }

    const avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
    const avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;

    if (avgLoss === 0) {
      result.push(100);
    } else {
      const rs = avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
  }
  return result;
}

/** True iff `strategy` is one the route can run. */
export function isKnownStrategy(strategy: string): strategy is StrategyName {
  return (VALID_STRATEGIES as readonly string[]).includes(strategy);
}

/**
 * Validate the request body's required fields. Mirrors the route: an absent
 * symbol OR strategy is a 400. (Strategy-name validity is enforced separately,
 * after the data fetch, via `isKnownStrategy` — preserving the route's order.)
 */
export function validateBacktestInput(body: {
  symbol?: string;
  strategy?: string;
  params?: Record<string, unknown>;
}): { valid: true } | { valid: false; error: string; status: number } {
  const { symbol, strategy } = body;
  if (!symbol || !strategy) {
    return {
      valid: false,
      error: "Symbol and strategy are required",
      status: 400,
    };
  }
  return { valid: true };
}

/** Append `.NS` (NSE) when the symbol has no exchange suffix. */
export function normalizeSymbol(symbol: string): string {
  return symbol.includes(".") ? symbol : `${symbol}.NS`;
}

/** Require ≥ 50 bars for a meaningful backtest. */
export function validateHistoricalData(
  data: unknown[] | null | undefined
): { valid: true } | { valid: false; error: string; status: number } {
  if (!data || data.length < 50) {
    return {
      valid: false,
      error: "Insufficient historical data for backtesting",
      status: 400,
    };
  }
  return { valid: true };
}

/** Moving-average-crossover strategy. Buys a golden cross, sells a death cross. */
export function runMACrossover(
  closes: number[],
  dates: string[],
  params?: { shortPeriod?: number; longPeriod?: number }
): StrategyRun {
  const shortPeriod = params?.shortPeriod || 20;
  const longPeriod = params?.longPeriod || 50;
  const shortSMA = calculateSMA(closes, shortPeriod);
  const longSMA = calculateSMA(closes, longPeriod);

  const trades: BacktestTrade[] = [];
  let position: { price: number; date: string } | null = null;
  let totalPnl = 0;
  let winners = 0;
  let losers = 0;

  for (let i = 1; i < closes.length; i++) {
    const prevShort = shortSMA[i - 1];
    const prevLong = longSMA[i - 1];
    const currShort = shortSMA[i];
    const currLong = longSMA[i];

    if (
      prevShort == null ||
      prevLong == null ||
      currShort == null ||
      currLong == null
    )
      continue;

    if (prevShort <= prevLong && currShort > currLong && !position) {
      position = { price: closes[i], date: dates[i] };
      trades.push({ type: "BUY", date: dates[i], price: closes[i] });
    } else if (prevShort >= prevLong && currShort < currLong && position) {
      const pnl = closes[i] - position.price;
      totalPnl += pnl;
      if (pnl > 0) winners++;
      else losers++;
      trades.push({ type: "SELL", date: dates[i], price: closes[i], pnl });
      position = null;
    }
  }

  return { trades, totalPnl, winners, losers };
}

/** RSI strategy. Buys an oversold crossover-up, sells when overbought. */
export function runRSIStrategy(
  closes: number[],
  dates: string[],
  params?: { period?: number; oversold?: number; overbought?: number }
): StrategyRun {
  const rsiPeriod = params?.period || 14;
  const oversold = params?.oversold || 30;
  const overbought = params?.overbought || 70;
  const rsi = calculateRSI(closes, rsiPeriod);

  const trades: BacktestTrade[] = [];
  let position: { price: number; date: string } | null = null;
  let totalPnl = 0;
  let winners = 0;
  let losers = 0;

  for (let i = 1; i < closes.length; i++) {
    const prevRSI = rsi[i - 1];
    const currRSI = rsi[i];

    if (prevRSI == null || currRSI == null) continue;

    if (prevRSI <= oversold && currRSI > oversold && !position) {
      position = { price: closes[i], date: dates[i] };
      trades.push({ type: "BUY", date: dates[i], price: closes[i] });
    } else if (currRSI >= overbought && position) {
      const pnl = closes[i] - position.price;
      totalPnl += pnl;
      if (pnl > 0) winners++;
      else losers++;
      trades.push({ type: "SELL", date: dates[i], price: closes[i], pnl });
      position = null;
    }
  }

  return { trades, totalPnl, winners, losers };
}

/**
 * Shape the final backtest result: period is always "1Y", winRate rounds to 1
 * decimal, totalPnl to 2, and `trades` is capped to the last 20.
 */
export function buildResponse(
  symbol: string,
  strategy: string,
  result: StrategyRun
): BacktestResponse {
  const { trades, totalPnl, winners, losers } = result;
  const totalTrades = winners + losers;
  const winRate = totalTrades > 0 ? (winners / totalTrades) * 100 : 0;

  return {
    symbol,
    strategy,
    period: "1Y",
    totalTrades,
    winners,
    losers,
    winRate: Math.round(winRate * 10) / 10,
    totalPnl: Math.round(totalPnl * 100) / 100,
    trades: trades.slice(-20),
  };
}
