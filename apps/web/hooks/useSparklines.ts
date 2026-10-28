"use client";

/**
 * useSparklines Hook
 *
 * Calls the getSparklinesAction Server Action directly - no HTTP route
 * wrapper in apps/web. The service function lives in @usemoney/services
 * and is also consumable by apps/api (for mobile) via its own Hono route.
 *
 * Unlike useMarketData, this hook does NOT poll by default. Sparklines
 * change on the order of minutes (for 1D) or days (for 1W/1M), not
 * seconds - one-shot on mount + manual refresh is the right default.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getSparklinesAction } from "@/lib/actions/sparklines";

export type SparklineWindow = "1D" | "1W" | "1M";

export interface SparklineRequest {
  symbol: string;
  exchange?: "NSE" | "BSE";
}

export interface SparklineData {
  closes: number[];
  lastUpdated: number | null;
}

export interface UseSparklinesOptions {
  /** Window: 1D (default), 1W, or 1M. */
  window?: SparklineWindow;
  /** Default exchange when a request entry omits one. */
  exchange?: "NSE" | "BSE";
  /** Polling interval in ms. 0 disables polling (default). */
  interval?: number;
}

export interface UseSparklinesResult {
  sparklines: Map<string, SparklineData>;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Build the Map key from (symbol, exchange). */
export function sparklineKey(
  symbol: string,
  exchange: "NSE" | "BSE" = "NSE"
): string {
  return `${symbol}|${exchange}`;
}

export function useSparklines(
  requests: SparklineRequest[],
  options: UseSparklinesOptions = {}
): UseSparklinesResult {
  const { window = "1D", exchange = "NSE", interval = 0 } = options;

  const [sparklines, setSparklines] = useState<Map<string, SparklineData>>(
    () => new Map()
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestsRef = useRef(requests);
  const mountedRef = useRef(true);

  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);

  const fetchSparklines = useCallback(async () => {
    const current = requestsRef.current;
    if (current.length === 0) {
      setSparklines(new Map());
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const symbols = current.map((r) => ({
        symbol: r.symbol,
        exchange: (r.exchange ?? exchange) as "NSE" | "BSE",
      }));

      const result = await getSparklinesAction(symbols, window);

      if (!mountedRef.current) return;

      if (!result.success) {
        throw new Error(result.error ?? "Sparkline action failed");
      }

      const next = new Map<string, SparklineData>();
      for (const [key, val] of Object.entries(result.data)) {
        next.set(key, { closes: val.closes, lastUpdated: val.lastUpdated });
      }
      setSparklines(next);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [exchange, window]);

  const refresh = useCallback(async () => {
    await fetchSparklines();
  }, [fetchSparklines]);

  useEffect(() => {
    mountedRef.current = true;

    if (requests.length > 0) fetchSparklines();

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    if (interval > 0 && requests.length > 0) {
      pollTimer = setInterval(fetchSparklines, interval);
    }

    return () => {
      mountedRef.current = false;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [
    requests
      .map((r) => `${r.symbol}:${r.exchange ?? exchange}`)
      .sort()
      .join(","),
    interval,
    fetchSparklines,
    exchange,
  ]);

  return { sparklines, isLoading, error, refresh };
}

export default useSparklines;
