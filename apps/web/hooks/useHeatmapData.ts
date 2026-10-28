"use client";

/**
 * useHeatmapData - fetches treemap data via the
 * `getHeatmapDataAction` server action and refreshes it on a polling
 * cadence that respects NSE market hours.
 *
 * Polling rules (delegate to useMarketStatus):
 *   - OPEN          → poll at `interval` ms (default 60s - treemap
 *                     blocks shouldn't flicker faster than that)
 *   - PRE_OPEN      → no poll; SSR snapshot is what we render
 *   - POST_CLOSE    → no poll; SSR snapshot is what we render
 *   - WEEKEND       → no poll
 *   - HOLIDAY       → no poll
 *
 * Phase transitions (e.g. 15:30 close): we run one final fetch when
 * the phase flips OPEN → POST_CLOSE so the user sees the official
 * close values without a manual refresh.
 *
 * Initial data may be passed in from the server (`initialData`) so
 * the first paint doesn't flash an empty grid.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getHeatmapDataAction,
  type HeatmapData,
  type HeatmapScope,
  type HeatmapTimeframe,
} from "@/lib/actions/discover-heatmap";
import { useMarketStatus } from "@/hooks/useMarketStatus";

export interface UseHeatmapDataOptions {
  /** Initial server-rendered data - paint immediately on first render. */
  initialData?: HeatmapData | null;
  /** Polling interval in ms when the market is open. Default 60_000. */
  interval?: number;
  /**
   * MONEY-1092 - set false to suspend polling while the treemap is not on
   * screen. The markets page now hosts two views on one canvas, so without
   * this every visitor sitting on the SECTORS view would still refetch the
   * STOCK heatmap once a minute for a grid they cannot see. Scope and
   * timeframe changes are still honoured, and the first fetch on re-enable
   * happens immediately rather than after a full interval.
   */
  enabled?: boolean;
}

export interface UseHeatmapDataResult {
  data: HeatmapData | null;
  isLoading: boolean;
  error: string | null;
  /** Manually re-trigger a fetch (e.g. on scope change). */
  refresh: () => Promise<void>;
}

export function useHeatmapData(
  scope: HeatmapScope,
  options: UseHeatmapDataOptions & { timeframe?: HeatmapTimeframe } = {}
): UseHeatmapDataResult {
  const {
    initialData = null,
    interval = 60_000,
    timeframe = "1D",
    enabled = true,
  } = options;
  const [data, setData] = useState<HeatmapData | null>(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { status } = useMarketStatus();
  const mountedRef = useRef(true);
  const lastPhaseRef = useRef(status.phase);
  const initialDataRef = useRef(initialData);
  // Track the last scope rendered with `data`; used to skip the
  // initial fetch when SSR data already matches the active scope.
  const lastKeyRef = useRef<string | null>(
    initialData ? `${scope}:${timeframe}` : null
  );

  const fetchData = useCallback(async () => {
    if (!mountedRef.current) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await getHeatmapDataAction({ scope, timeframe });
      if (!mountedRef.current) return;
      if (result.success) {
        setData(result.data);
        lastKeyRef.current = `${scope}:${timeframe}`;
      } else {
        setError(result.error ?? "Failed to load heatmap");
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Heatmap fetch failed");
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [scope, timeframe]);

  // Refetch when scope OR timeframe changes - SSR data may not match.
  //
  // This effect ALSO needs the `enabled` gate, and not having it made the
  // previous "gate the bootstrap" fix inert. There are three effects here
  // that can call fetchData(); that fix added the guard to the other two and
  // left this one, which fires on mount whenever `lastKeyRef` is null — i.e.
  // exactly when SSR produced no data, which is the cold-cache case the
  // guard exists for. So the invisible stock heatmap still fetched.
  //
  // A genuine scope/timeframe CHANGE while disabled is still honoured: the
  // key mismatch persists, and flipping `enabled` true re-runs this effect.
  useEffect(() => {
    if (!enabled) return;
    const next = `${scope}:${timeframe}`;
    if (lastKeyRef.current === next) return;
    void fetchData();
  }, [scope, timeframe, enabled, fetchData]);

  // Polling - only when market is OPEN and the consumer is showing it.
  useEffect(() => {
    mountedRef.current = true;
    if (!status.isLive || !enabled) return;
    const id = setInterval(() => {
      void fetchData();
    }, interval);
    return () => {
      clearInterval(id);
    };
  }, [status.isLive, enabled, interval, fetchData]);

  // Phase-transition refresh: when the phase flips OPEN → POST_CLOSE
  // we want one last fetch so the closing snapshot is what stays on
  // screen overnight.
  useEffect(() => {
    const prev = lastPhaseRef.current;
    if (prev === "OPEN" && status.phase === "POST_CLOSE") {
      void fetchData();
    }
    lastPhaseRef.current = status.phase;
  }, [status.phase, fetchData]);

  // Cleanup
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Edge: if SSR provided no initialData and the page mounted in a
  // closed-market state, do exactly one fetch to populate the cache
  // (and the user's view).
  useEffect(() => {
    // `enabled` has to gate this too. It previously guarded only the polling
    // interval, so a cold-cache mount (SSR raced out -> initialData null) on
    // the SECTORS canvas still bootstrapped a full stock-heatmap fetch for a
    // grid that was never rendered. Flipping `enabled` true re-evaluates this
    // effect, so switching to Stocks still loads immediately.
    if (!enabled) return;
    if (!initialDataRef.current && !data && !isLoading && !error) {
      void fetchData();
    }
    // We deliberately depend on data/isLoading/error so a successful
    // first fetch flips the guard and stops re-firing.
  }, [data, isLoading, error, enabled, fetchData]);

  return { data, isLoading, error, refresh: fetchData };
}

export default useHeatmapData;
