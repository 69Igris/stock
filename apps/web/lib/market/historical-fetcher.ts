/**
 * Historical OHLCV Fetcher (shared)
 *
 * Fetches historical OHLCV bars from Yahoo Finance. Used by the TradingView UDF
 * history endpoint and the (non-UDF) historical route; the route handlers own
 * auth + HTTP response shaping, this module owns the fetch only.
 *
 * MONEY-837: the Zerodha (Kite Connect) historical-candle path was removed from
 * apps/web and moved to the standalone Connect service. Yahoo is now the only
 * runtime source here. The Zerodha-exclusive intervals (3m / 10m) are therefore
 * no longer served, and the chart no longer advertises them (see
 * app/api/market/udf/symbols/route.ts → `hasBrokerCreds = false`).
 */

import {
  getHistorical,
  getIntradayChart,
  type Period,
  type Interval,
} from "@/lib/market/yahoo-client";
import { toYahooSymbol, type Exchange } from "@/lib/market/symbol-mapper";
import { monthsBack } from "@/lib/market/yahoo-client-logic";
import { getBrokerMarketDataStatus } from "@/lib/actions/broker-status";

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

export interface FetchHistoricalOptions {
  symbol: string;
  exchange: Exchange;
  interval: string;
  /** Period string (e.g. "1mo", "1y"). Ignored when startDate/endDate are set. */
  period?: Period;
  /** Explicit start date. When set with endDate, takes precedence over period. */
  startDate?: Date;
  /** Explicit end date. */
  endDate?: Date;
}

export interface FetchHistoricalResult {
  data: HistoricalBar[];
  source: "yahoo";
  brokerStatus: "active" | "needs_reauth" | "none";
}

/**
 * Typed error so callers can map to the right HTTP status code.
 */
export class HistoricalFetchError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "HistoricalFetchError";
  }
}

// ============== CONSTANTS ==============

export const VALID_PERIODS: Period[] = [
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "10y",
  "ytd",
  "max",
];

export const VALID_INTERVALS: string[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "60m",
  "1h",
  "1d",
  "5d",
  "1wk",
  "1mo",
  "3mo",
];

/** Intervals Yahoo Finance can serve. */
export const YAHOO_INTERVALS: Interval[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "60m",
  "1h",
  "1d",
  "5d",
  "1wk",
  "1mo",
  "3mo",
];

/** Intervals treated as intraday for window-normalization / period gating. */
export const INTRADAY_INTERVALS = ["1m", "5m", "15m", "30m", "60m"];

/** Periods that intraday intervals may be requested with. */
export const INTRADAY_PERIODS = ["1d", "5d", "1mo"];

// ============== HELPERS ==============

/**
 * Return a new Date set to 00:00:00 local-time of the same calendar day.
 *
 * Used by the intraday fetch path to widen TradingView's [from, to] window
 * to whole-day bounds before calling Yahoo. Rationale below.
 */
function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Calculate the start date for a Yahoo-style period string.
 */
export function getPeriodStartDate(period: string): Date {
  const now = new Date();
  const start = new Date(now);

  switch (period) {
    case "1d":
      start.setDate(now.getDate() - 1);
      break;
    case "5d":
      start.setDate(now.getDate() - 5);
      break;
    // MONEY-1274 — the SECOND copy of this ladder. Both carried the same
    // day-overflow defect (`setMonth(getMonth() - 6)` on 29 Aug asks for 29 Feb
    // and JS rolls forward into March), so both are routed through the one
    // clamped helper rather than repaired twice and left to drift again.
    case "1mo":
      return monthsBack(now, 1);
    case "3mo":
      return monthsBack(now, 3);
    case "6mo":
      return monthsBack(now, 6);
    case "1y":
      return monthsBack(now, 12);
    case "2y":
      return monthsBack(now, 24);
    case "5y":
      return monthsBack(now, 60);
    case "10y":
      return monthsBack(now, 120);
    case "ytd":
      start.setMonth(0, 1);
      break;
    case "max":
      start.setFullYear(1970);
      break;
    default:
      return monthsBack(now, 1);
  }

  return start;
}

// ============== VALIDATION HELPERS ==============
//
// Small pure predicates over the constants above. The route handler and this
// fetcher call them (no inline membership checks), and they are unit-tested
// directly against the REAL constants rather than an inline copy.

/** True when `period` is a recognized Yahoo-style period string. */
export function isValidPeriod(period: string): boolean {
  return (VALID_PERIODS as readonly string[]).includes(period);
}

/** True when `interval` is accepted by the historical endpoint. */
export function isValidInterval(interval: string): boolean {
  return VALID_INTERVALS.includes(interval);
}

/** True when `interval` is classified as intraday (1m–60m, excludes 1h). */
export function isIntradayInterval(interval: string): boolean {
  return INTRADAY_INTERVALS.includes(interval);
}

/** True when `period` is permitted for intraday intervals. */
export function isIntradayPeriod(period: string): boolean {
  return INTRADAY_PERIODS.includes(period);
}

/** True when `interval` can be served by Yahoo. */
export function isYahooInterval(interval: string): boolean {
  return (YAHOO_INTERVALS as readonly string[]).includes(interval);
}

/**
 * Validate the symbol parameter. Empty / missing → invalid with the same
 * message the route returns.
 */
export function validateSymbol(symbol: string | null): {
  valid: boolean;
  error?: string;
} {
  if (!symbol) {
    return { valid: false, error: "Symbol parameter is required" };
  }
  return { valid: true };
}

/**
 * Validate a custom date range: both dates must parse, and start must not be
 * after end. Mirrors the route's date guards.
 */
export function validateDateRange(
  startDate: Date,
  endDate: Date
): { valid: boolean; error?: string } {
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return { valid: false, error: "Invalid date format. Use YYYY-MM-DD" };
  }
  if (startDate > endDate) {
    return { valid: false, error: "startDate must be before endDate" };
  }
  return { valid: true };
}

// ============== MAIN FETCHER ==============

/**
 * Fetch OHLCV bars for a symbol from Yahoo Finance.
 *
 * - Yahoo is the only runtime source (MONEY-837). Intervals outside Yahoo's
 *   support (the old Zerodha-exclusive 3m / 10m) are rejected; the chart no
 *   longer offers them.
 * - Throws `HistoricalFetchError` with an appropriate `statusCode` for known
 *   failure modes; throws bare `Error` for unexpected internal failures.
 */
export async function fetchHistoricalBars(
  options: FetchHistoricalOptions
): Promise<FetchHistoricalResult> {
  const { symbol, exchange, interval, period, startDate, endDate } = options;

  // ── Validate inputs (shared pure predicates, also unit-tested directly) ──
  if (!validateSymbol(symbol).valid) {
    throw new HistoricalFetchError("Symbol parameter is required", 400);
  }

  if (period && !isValidPeriod(period)) {
    throw new HistoricalFetchError(
      `Invalid period. Valid periods: ${VALID_PERIODS.join(", ")}`,
      400
    );
  }

  if (!isValidInterval(interval)) {
    throw new HistoricalFetchError(
      `Invalid interval. Valid intervals: ${VALID_INTERVALS.join(", ")}`,
      400
    );
  }

  if (startDate && endDate && startDate > endDate) {
    throw new HistoricalFetchError("startDate must be before endDate", 400);
  }

  // ── Broker status (reported for client UI only; data is always Yahoo) ──
  const brokerStatus = await getBrokerMarketDataStatus();

  // ── Fetch from Yahoo — the only runtime market-data source (MONEY-837) ──
  //
  // Intraday window normalization: Yahoo's chart endpoint has an undocumented
  // forward-anchor quirk — it returns empty when `period2` is significantly in
  // the past, even for windows well within retention (diagnosed from prod logs
  // 2026-04-08: 4/04→4/08 returned 225 bars, 4/02→4/04 returned 0). The
  // TradingView Advanced Charts widget is backward-anchored (each scroll-back
  // is a fully-historical window), so we:
  //
  //   - snap `from` DOWN to start-of-local-day (midnight IST) for clean
  //     whole-day lower bounds, and
  //   - force `period2 = now` to satisfy the forward-anchor filter.
  //
  // The response over-fetches from the widened `from` up to now; the UDF
  // route's range filter (app/api/market/udf/history/route.ts) clips it back to
  // TradingView's original [from, to] window, so the widget gets reliable
  // backward-scroll paging. (MONEY-122 Redis cache + MONEY-123 IntradayBar
  // ingestion pipeline reduce the upstream calls to cache misses only.)
  let data: HistoricalBar[] = [];
  const source = "yahoo" as const;

  const yahooSymbol = toYahooSymbol(symbol, exchange);
  const yahooInterval = interval as Interval;

  if (isIntradayInterval(yahooInterval)) {
    // Explicit dates take priority over the period preset — required for the
    // TradingView progressive-scroll pattern (each backward-scroll arrives with
    // a different [from, to] window, not a fixed "last N days" preset).
    //
    //   1. period1 = startOfDay(from) — snap down to midnight IST.
    //   2. period2 = now — Yahoo returns empty when period2 is significantly in
    //      the past; forcing "now" satisfies its forward-anchor filter. The
    //      over-fetched response is clipped back to [fromSec, toSec] by the UDF
    //      route's range filter.
    //
    // Yahoo intraday retention is bounded (~60d for 5m/15m/30m, ~7d for 1m). If
    // `from` is outside retention, Yahoo starts at whatever it has and the UDF
    // route's `no_data` branch (no `nextTime`) stops the widget scrolling.
    if (startDate && endDate) {
      data = await getIntradayChart(yahooSymbol, {
        period1: startOfLocalDay(startDate),
        period2: new Date(), // always "now" - Yahoo forward-anchor quirk
        interval: yahooInterval as "1m" | "5m" | "15m" | "30m" | "60m",
      });
    } else {
      const intradayPeriod = period ?? "1mo";
      if (!isIntradayPeriod(intradayPeriod)) {
        throw new HistoricalFetchError(
          `Intraday intervals (${yahooInterval}) only support periods: ${INTRADAY_PERIODS.join(", ")}`,
          400
        );
      }

      data = await getIntradayChart(yahooSymbol, {
        period: intradayPeriod as "1d" | "5d" | "1mo",
        interval: yahooInterval as "1m" | "5m" | "15m" | "30m" | "60m",
      });
    }
  } else {
    data = await getHistorical(yahooSymbol, {
      period: startDate ? undefined : period,
      interval: yahooInterval,
      startDate,
      endDate,
    });
  }

  return {
    data,
    source,
    brokerStatus: brokerStatus.status,
  };
}
