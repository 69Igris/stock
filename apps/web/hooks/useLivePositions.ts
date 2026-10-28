"use client";

/**
 * useLivePositions Hook
 *
 * Updates paper trading positions with live market prices.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  calculatePositionPnL,
  calculateTotalPnL,
  calculateTotalDayPnL,
} from "./useLivePositions-logic";

// ============== TYPES ==============

export interface Position {
  id: string;
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  action: "BUY" | "SELL";
}

export interface LivePosition extends Position {
  pnl: number;
  pnlPercentage: number;
  dayChange: number;
  dayChangePercent: number;
}

export interface UseLivePositionsOptions {
  /** Refresh interval in ms (default: 5000) */
  refreshInterval?: number;
  /** Exchange (default: NSE) */
  exchange?: "NSE" | "BSE";
  /** Enable auto-refresh */
  autoRefresh?: boolean;
}

export interface UseLivePositionsResult {
  /** Positions with live prices */
  positions: LivePosition[];
  /** Total unrealized P&L */
  totalPnL: number;
  /** Total day P&L */
  totalDayPnL: number;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Last update time */
  lastUpdate: Date | null;
  /** Manually refresh prices */
  refresh: () => Promise<void>;
}

// ============== HOOK ==============

export function useLivePositions(
  positions: Position[],
  options: UseLivePositionsOptions = {}
): UseLivePositionsResult {
  const {
    refreshInterval = 5000,
    exchange = "NSE",
    autoRefresh = true,
  } = options;

  const [livePositions, setLivePositions] = useState<LivePosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const refreshRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  const fetchPrices = useCallback(async () => {
    if (positions.length === 0) {
      setLivePositions([]);
      return;
    }

    setIsLoading(true);

    try {
      const symbols = Array.from(new Set(positions.map((p) => p.symbol)));

      const params = new URLSearchParams({
        symbols: symbols.join(","),
        exchange,
      });

      const response = await fetch(`/api/market/quote?${params}`);

      if (!response.ok) {
        throw new Error("Failed to fetch prices");
      }

      const data = await response.json();

      if (!mountedRef.current) return;

      if (data.success && data.data) {
        const updatedPositions: LivePosition[] = positions.map((pos) => {
          const quote = data.data[pos.symbol];
          const currentPrice = quote?.price || pos.currentPrice;

          // Finite-guarded P&L math lives in ./useLivePositions-logic so a
          // 0 entryPrice can't produce an Infinity/NaN pnlPercentage.
          return calculatePositionPnL(pos, currentPrice, quote);
        });

        setLivePositions(updatedPositions);
        setLastUpdate(new Date());
        setError(null);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [positions, exchange]);

  const refresh = useCallback(async () => {
    await fetchPrices();
  }, [fetchPrices]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    mountedRef.current = true;

    if (positions.length > 0) {
      fetchPrices();
    }

    if (autoRefresh && positions.length > 0) {
      refreshRef.current = setInterval(fetchPrices, refreshInterval);
    }

    return () => {
      mountedRef.current = false;
      if (refreshRef.current) {
        clearInterval(refreshRef.current);
        refreshRef.current = null;
      }
    };
  }, [positions, autoRefresh, refreshInterval, fetchPrices]);

  // Calculate totals (finite-guarded so one poisoned row can't NaN the sum)
  const totalPnL = calculateTotalPnL(livePositions);
  const totalDayPnL = calculateTotalDayPnL(livePositions);

  return {
    positions: livePositions,
    totalPnL,
    totalDayPnL,
    isLoading,
    error,
    lastUpdate,
    refresh,
  };
}

export default useLivePositions;
