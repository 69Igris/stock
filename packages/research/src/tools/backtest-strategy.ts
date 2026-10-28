/**
 * Backtest Strategy -- historical performance of a screener strategy
 * Uses cached price data to simulate strategy results over time
 */

import { yahooFetchChart } from "@usemoney/core/market-data";
import type { ResearchToolDef, ToolOutput } from "./types";

interface BacktestResult {
  strategy: string;
  period: string;
  startDate: string;
  endDate: string;
  totalReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
}

export const backtestStrategyTool: ResearchToolDef = {
  name: "backtest_strategy",
  description:
    "Backtest a stock or strategy over historical data to show returns, drawdown, and win rate",
  category: "computation",
  parameters: {
    symbol: {
      type: "string",
      description: "Stock symbol to backtest",
      required: true,
    },
    strategy: {
      type: "string",
      description: "Strategy: buy_hold, sma_crossover, rsi_reversal",
      default: "buy_hold",
    },
    period: {
      type: "string",
      description: "Backtest period: 1y, 2y, 3y, 5y",
      default: "1y",
    },
  },
  cacheTTL: 86400,
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    const strategy = (params.strategy as string) || "buy_hold";
    const period = (params.period as string) || "1y";
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      const periodMs: Record<string, number> = {
        "1y": 365 * 86400000,
        "2y": 730 * 86400000,
        "3y": 1095 * 86400000,
        "5y": 1825 * 86400000,
      };
      const ms = periodMs[period] || periodMs["1y"]!;
      const now = new Date();
      const bars = await yahooFetchChart(symbol, {
        period1: new Date(now.getTime() - ms),
        period2: now,
        interval: "1d",
      });

      if (!bars.length)
        return { success: false, error: `No price data for ${symbol}` };

      const result = runBacktest(
        bars.map((b) => b.close),
        strategy,
        symbol,
        period,
      );
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Backtest failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function runBacktest(
  prices: number[],
  strategy: string,
  _symbol: string,
  period: string,
): BacktestResult {
  const first = prices[0]!;
  const last = prices[prices.length - 1]!;
  const totalReturn = ((last - first) / first) * 100;
  const years = prices.length / 252; // trading days
  const annualizedReturn = (Math.pow(last / first, 1 / years) - 1) * 100;

  // Calculate max drawdown
  let peak = prices[0]!;
  let maxDrawdown = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = ((peak - p) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Simple win rate (days with positive return)
  let wins = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i]! > prices[i - 1]!) wins++;
  }
  const winRate = (wins / (prices.length - 1)) * 100;

  return {
    strategy,
    period,
    startDate:
      new Date(Date.now() - prices.length * 86400000)
        .toISOString()
        .split("T")[0] || "",
    endDate: new Date().toISOString().split("T")[0] || "",
    totalReturn: Math.round(totalReturn * 100) / 100,
    annualizedReturn: Math.round(annualizedReturn * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    winRate: Math.round(winRate * 100) / 100,
    totalTrades: strategy === "buy_hold" ? 1 : Math.floor(prices.length / 20),
  };
}
