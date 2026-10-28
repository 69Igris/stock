/**
 * Pure transforms for `useHistoricalData`.
 *
 * Extracted from the hook's `useMemo` bodies so the HistoricalBar → ChartBar
 * mapping and date-range extraction can be unit-tested without rendering
 * React. The hook imports `toChartData` / `getDateRange` — there is no dead
 * duplicate.
 */

import type { Time } from "lightweight-charts";
import type {
  HistoricalBar,
  ChartBar,
  Period,
  Interval,
  UseHistoricalDataOptions,
} from "./useHistoricalData";

/** Resolved option defaults. Mirrors the hook's `= ` destructuring defaults. */
export function resolveHistoricalOptions(
  options: UseHistoricalDataOptions = {}
): {
  period: Period;
  interval: Interval;
  exchange: "NSE" | "BSE";
  refreshInterval: number;
} {
  return {
    period: options.period ?? "1mo",
    interval: options.interval ?? "1d",
    exchange: options.exchange ?? "NSE",
    refreshInterval: options.refreshInterval ?? 0,
  };
}

/** URL search params for the historical API. */
export function buildHistoricalParams(
  symbol: string,
  exchange: "NSE" | "BSE",
  period: Period,
  interval: Interval
): URLSearchParams {
  return new URLSearchParams({ symbol, exchange, period, interval });
}

/** Raw API bar shape (date is an ISO string). */
export interface RawApiBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number;
}

/** Parse one raw API bar into a HistoricalBar (ISO string → Date). */
export function parseHistoricalBar(raw: RawApiBar): HistoricalBar {
  return {
    date: new Date(raw.date),
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    volume: raw.volume,
    adjClose: raw.adjClose,
  };
}

/** Parse a raw API bar array into HistoricalBar[]. */
export function parseHistoricalBars(rawBars: RawApiBar[]): HistoricalBar[] {
  return rawBars.map(parseHistoricalBar);
}

/** Convert one HistoricalBar to a ChartBar (Date → Unix seconds, floored). */
export function toChartBar(bar: HistoricalBar): ChartBar {
  return {
    time: Math.floor(bar.date.getTime() / 1000) as Time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

/**
 * Map HistoricalBars to lightweight-charts ChartBars (Date → Unix seconds).
 *
 * Bars whose date yields a non-finite Unix second (e.g. an Invalid Date →
 * NaN) are dropped: lightweight-charts requires finite, strictly-increasing
 * times, so a single NaN time would throw or corrupt the whole series.
 */
export function toChartData(data: HistoricalBar[]): ChartBar[] {
  const bars: ChartBar[] = [];
  for (const bar of data) {
    const seconds = Math.floor(bar.date.getTime() / 1000);
    if (!Number.isFinite(seconds)) continue; // skip Invalid Date / NaN time
    bars.push(toChartBar(bar));
  }
  return bars;
}

/** Extract an error message: Error → .message, else "Unknown error". */
export function extractHistoricalError(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

const VALID_PERIODS: readonly Period[] = [
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "ytd",
  "max",
];

/** Type guard for a valid Period string. */
export function isValidPeriod(period: string): period is Period {
  return (VALID_PERIODS as readonly string[]).includes(period);
}

const VALID_INTERVALS: readonly Interval[] = [
  "1m",
  "3m",
  "5m",
  "10m",
  "15m",
  "30m",
  "60m",
  "1h",
  "1d",
  "1wk",
  "1mo",
];

/** Type guard for a valid Interval string. */
export function isValidInterval(interval: string): interval is Interval {
  return (VALID_INTERVALS as readonly string[]).includes(interval);
}

/** First/last bar dates, or {null,null} for an empty series. */
export function getDateRange(data: HistoricalBar[]): {
  start: Date | null;
  end: Date | null;
} {
  if (data.length === 0) {
    return { start: null, end: null };
  }
  return {
    start: data[0]!.date,
    end: data[data.length - 1]!.date,
  };
}
