"use client";

/**
 * useHistoricalData Hook
 *
 * Fetches historical OHLCV data for charts.
 * Uses Yahoo Finance through the /api/market/historical endpoint.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { Time } from "lightweight-charts";
import {
  toChartData,
  getDateRange,
  resolveHistoricalOptions,
  buildHistoricalParams,
  parseHistoricalBars,
  extractHistoricalError,
} from "./useHistoricalData-logic";

// ============== TYPES ==============

export interface HistoricalBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number;
}

export interface ChartBar {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Period =
  | "1d"
  | "5d"
  | "1mo"
  | "3mo"
  | "6mo"
  | "1y"
  | "2y"
  | "5y"
  | "ytd"
  | "max";
export type Interval =
  | "1m"
  | "3m"
  | "5m"
  | "10m"
  | "15m"
  | "30m"
  | "60m"
  | "1h"
  | "1d"
  | "1wk"
  | "1mo";

export type DataSource = "zerodha" | "yahoo";
export type BrokerConnectionStatus = "active" | "needs_reauth" | "none";

export interface UseHistoricalDataOptions {
  /** Time period to fetch (default: 1mo) */
  period?: Period;
  /** Bar interval (default: 1d) */
  interval?: Interval;
  /** Exchange (default: NSE) */
  exchange?: "NSE" | "BSE";
  /** Auto-refresh interval in ms (0 to disable) */
  refreshInterval?: number;
  /** Called when data is fetched */
  onUpdate?: (data: HistoricalBar[]) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

export interface UseHistoricalDataResult {
  /** Raw historical data */
  data: HistoricalBar[];
  /** Data formatted for TradingView charts */
  chartData: ChartBar[];
  /** Loading state */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Manually refresh data */
  refresh: () => Promise<void>;
  /** Date range of data */
  dateRange: { start: Date | null; end: Date | null };
  /** Data source: "zerodha" or "yahoo" */
  source: DataSource;
  /** Broker connection status */
  brokerStatus: BrokerConnectionStatus;
}

// ============== HOOK ==============

export function useHistoricalData(
  symbol: string,
  options: UseHistoricalDataOptions = {}
): UseHistoricalDataResult {
  const { onUpdate, onError } = options;
  // Value defaults resolved by the shared (unit-tested) helper.
  const { period, interval, exchange, refreshInterval } =
    resolveHistoricalOptions(options);

  const [data, setData] = useState<HistoricalBar[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<DataSource>("yahoo");
  const [brokerStatus, setBrokerStatus] =
    useState<BrokerConnectionStatus>("none");

  const refreshRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  // Fetch historical data
  const fetchData = useCallback(async () => {
    if (!symbol) {
      setData([]);
      return;
    }

    // Skip live market data in demo mode
    if (
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode") === "true"
    ) {
      return;
    }

    setIsLoading(true);

    try {
      const params = buildHistoricalParams(symbol, exchange, period, interval);

      const response = await fetch(`/api/market/historical?${params}`);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch historical data: ${response.statusText}`
        );
      }

      const result = await response.json();

      if (!mountedRef.current) return;

      if (result.success && result.data) {
        const historicalData: HistoricalBar[] = parseHistoricalBars(
          result.data
        );

        setData(historicalData);
        setError(null);
        if (result.source) setSource(result.source);
        if (result.brokerStatus) setBrokerStatus(result.brokerStatus);
        onUpdate?.(historicalData);
      }
    } catch (err) {
      if (!mountedRef.current) return;

      const errorMessage = extractHistoricalError(err);
      setError(errorMessage);
      onError?.(err instanceof Error ? err : new Error(errorMessage));
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [symbol, exchange, period, interval, onUpdate, onError]);

  // Manual refresh
  const refresh = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    mountedRef.current = true;

    if (symbol) {
      fetchData();
    }

    // Set up auto-refresh
    if (refreshInterval > 0 && symbol) {
      refreshRef.current = setInterval(fetchData, refreshInterval);
    }

    return () => {
      mountedRef.current = false;
      if (refreshRef.current) {
        clearInterval(refreshRef.current);
        refreshRef.current = null;
      }
    };
  }, [symbol, period, interval, exchange, refreshInterval, fetchData]);

  // Convert to chart format
  // Pure transforms live in ./useHistoricalData-logic (unit-tested, and the
  // toChartData mapping drops non-finite Unix times so an Invalid Date can't
  // poison the lightweight-charts series).
  const chartData = useMemo((): ChartBar[] => toChartData(data), [data]);

  const dateRange = useMemo(() => getDateRange(data), [data]);

  return {
    data,
    chartData,
    isLoading,
    error,
    refresh,
    dateRange,
    source,
    brokerStatus,
  };
}

// ============== MULTIPLE SYMBOLS HOOK ==============

export interface UseMultipleHistoricalResult {
  data: Map<string, HistoricalBar[]>;
  chartData: Map<string, ChartBar[]>;
  isLoading: boolean;
  errors: Map<string, string>;
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching historical data for multiple symbols
 */
export function useMultipleHistoricalData(
  symbols: string[],
  options: Omit<UseHistoricalDataOptions, "onUpdate" | "onError"> = {}
): UseMultipleHistoricalResult {
  const [data, setData] = useState<Map<string, HistoricalBar[]>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  const { period = "1mo", interval = "1d", exchange = "NSE" } = options;

  const fetchAllData = useCallback(async () => {
    if (symbols.length === 0) {
      setData(new Map());
      return;
    }

    // Skip live market data in demo mode
    if (
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode") === "true"
    ) {
      return;
    }

    setIsLoading(true);
    const newData = new Map<string, HistoricalBar[]>();
    const newErrors = new Map<string, string>();

    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const params = new URLSearchParams({
            symbol,
            exchange,
            period,
            interval,
          });

          const response = await fetch(`/api/market/historical?${params}`);

          if (!response.ok) {
            throw new Error(`Failed to fetch data for ${symbol}`);
          }

          const result = await response.json();

          if (result.success && result.data) {
            const historicalData: HistoricalBar[] = result.data.map(
              (bar: {
                date: string;
                open: number;
                high: number;
                low: number;
                close: number;
                volume: number;
              }) => ({
                date: new Date(bar.date),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
              })
            );

            newData.set(symbol, historicalData);
          }
        } catch (err) {
          newErrors.set(
            symbol,
            err instanceof Error ? err.message : "Unknown error"
          );
        }
      })
    );

    setData(newData);
    setErrors(newErrors);
    setIsLoading(false);
  }, [symbols, exchange, period, interval]);

  useEffect(() => {
    fetchAllData();
  }, [fetchAllData]);

  // Convert all data to chart format
  const chartData = useMemo(() => {
    const result = new Map<string, ChartBar[]>();

    data.forEach((bars, symbol) => {
      result.set(
        symbol,
        bars.map((bar) => ({
          time: Math.floor(bar.date.getTime() / 1000) as Time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        }))
      );
    });

    return result;
  }, [data]);

  return {
    data,
    chartData,
    isLoading,
    errors,
    refresh: fetchAllData,
  };
}

export default useHistoricalData;
