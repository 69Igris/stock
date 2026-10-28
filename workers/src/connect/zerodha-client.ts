/**
 * Zerodha Kite Connect Market Data Client
 *
 * Provides quote and historical candle data from Zerodha's API.
 * Used as the primary data source when user has an active Zerodha connection.
 * Falls back to Yahoo Finance when Zerodha is unavailable.
 *
 * Quote: GET /quote?i=NSE:RELIANCE
 * Historical: GET /instruments/historical/{token}/{interval}
 * Auth: Authorization: token {api_key}:{access_token}
 */

import ky from "ky";
import type { QuoteData, HistoricalBar } from "./types";

// ============== TYPES ==============

export interface ZerodhaCredentials {
  apiKey: string;
  accessToken: string;
}

interface ZerodhaQuoteResponse {
  status: string;
  data: Record<
    string,
    {
      instrument_token: number;
      timestamp: string;
      last_price: number;
      last_quantity: number;
      buy_quantity: number;
      sell_quantity: number;
      volume: number;
      average_price: number;
      ohlc: {
        open: number;
        high: number;
        low: number;
        close: number;
      };
      net_change: number;
      oi: number;
      oi_day_high: number;
      oi_day_low: number;
      lower_circuit_limit: number;
      upper_circuit_limit: number;
    }
  >;
}

interface ZerodhaHistoricalResponse {
  status: string;
  data: {
    candles: Array<[string, number, number, number, number, number]>;
    // [timestamp, open, high, low, close, volume]
  };
}

// ============== INTERVAL MAPPING ==============

/**
 * Maps generic interval labels to Zerodha interval strings.
 * Intervals NOT in this map are not supported by Zerodha and should fall back to Yahoo.
 */
export const ZERODHA_INTERVAL_MAP: Record<string, string> = {
  "1m": "minute",
  "3m": "3minute",
  "5m": "5minute",
  "10m": "10minute",
  "15m": "15minute",
  "30m": "30minute",
  "60m": "60minute",
  "1h": "60minute",
  "1d": "day",
};

/**
 * Maximum lookback in calendar days for each Zerodha interval.
 * Zerodha's historical API enforces strict limits:
 *  - minute:  60 days
 *  - 3/5/10/15/30minute: 100 days
 *  - 60minute: 400 days
 *  - day: 2000 days (~5.5 years)
 */
const ZERODHA_MAX_DAYS: Record<string, number> = {
  minute: 60,
  "3minute": 100,
  "5minute": 100,
  "10minute": 100,
  "15minute": 100,
  "30minute": 100,
  "60minute": 400,
  day: 2000,
};

/**
 * Check if an interval is supported by Zerodha's historical API.
 */
export function isZerodhaInterval(interval: string): boolean {
  return interval in ZERODHA_INTERVAL_MAP;
}

// ============== CLIENT ==============

const ZERODHA_BASE_URL = "https://api.kite.trade";

function getHeaders(credentials: ZerodhaCredentials): Record<string, string> {
  return {
    Authorization: `token ${credentials.apiKey}:${credentials.accessToken}`,
    "X-Kite-Version": "3",
  };
}

/**
 * Fetch a single quote from Zerodha.
 * Returns null if the request fails (caller should fall back to Yahoo).
 */
export async function getZerodhaQuote(
  symbol: string,
  exchange: string,
  credentials: ZerodhaCredentials,
): Promise<QuoteData | null> {
  try {
    const instrument = `${exchange}:${symbol}`;
    const response = await ky
      .get(`${ZERODHA_BASE_URL}/quote`, {
        searchParams: { i: instrument },
        headers: getHeaders(credentials),
        timeout: 5000,
      })
      .json<ZerodhaQuoteResponse>();

    if (response.status !== "success" || !response.data[instrument]) {
      return null;
    }

    const q = response.data[instrument];
    return {
      symbol,
      exchange,
      name: symbol, // Zerodha quote doesn't return name
      price: q.last_price,
      change: q.net_change,
      changePercent: q.ohlc.close > 0 ? (q.net_change / q.ohlc.close) * 100 : 0,
      open: q.ohlc.open,
      high: q.ohlc.high,
      low: q.ohlc.low,
      previousClose: q.ohlc.close,
      volume: q.volume,
      timestamp: new Date(q.timestamp),
    };
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    if (status === 401 || status === 403) {
      // Token invalid/expired - signal fallback
      return null;
    }
    console.error(`Zerodha quote error for ${symbol}:`, error);
    return null;
  }
}

/**
 * Fetch quotes for multiple symbols from Zerodha.
 * Returns a map of symbol → QuoteData. Missing symbols are omitted (fall back to Yahoo for those).
 */
export async function getZerodhaQuotes(
  symbols: string[],
  exchange: string,
  credentials: ZerodhaCredentials,
): Promise<Map<string, QuoteData>> {
  const results = new Map<string, QuoteData>();

  if (symbols.length === 0) return results;

  try {
    // Zerodha accepts multiple i= params
    const params = new URLSearchParams();
    for (const sym of symbols) {
      params.append("i", `${exchange}:${sym}`);
    }

    const response = await ky
      .get(`${ZERODHA_BASE_URL}/quote`, {
        searchParams: params,
        headers: getHeaders(credentials),
        timeout: 10000,
      })
      .json<ZerodhaQuoteResponse>();

    if (response.status !== "success") return results;

    for (const sym of symbols) {
      const key = `${exchange}:${sym}`;
      const q = response.data[key];
      if (!q) continue;

      results.set(sym, {
        symbol: sym,
        exchange,
        name: sym,
        price: q.last_price,
        change: q.net_change,
        changePercent:
          q.ohlc.close > 0 ? (q.net_change / q.ohlc.close) * 100 : 0,
        open: q.ohlc.open,
        high: q.ohlc.high,
        low: q.ohlc.low,
        previousClose: q.ohlc.close,
        volume: q.volume,
        timestamp: new Date(q.timestamp),
      });
    }
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    if (status === 401 || status === 403) {
      return results; // Token invalid - return empty, caller falls back
    }
    console.error("Zerodha batch quote error:", error);
  }

  return results;
}

/**
 * Fetch historical candle data from Zerodha.
 * Returns empty array on failure (caller should fall back to Yahoo).
 *
 * @param instrumentToken - Zerodha numeric instrument token from InstrumentMapping
 * @param interval - Generic interval (e.g. "1m", "5m", "1d")
 * @param from - Start date
 * @param to - End date
 * @param credentials - Zerodha API credentials
 */
export async function getZerodhaHistorical(
  instrumentToken: number,
  interval: string,
  from: Date,
  to: Date,
  credentials: ZerodhaCredentials,
): Promise<HistoricalBar[]> {
  const zerodhaInterval = ZERODHA_INTERVAL_MAP[interval];
  if (!zerodhaInterval) {
    return []; // Interval not supported by Zerodha
  }

  // Clamp 'from' to Zerodha's max lookback for this interval
  const maxDays = ZERODHA_MAX_DAYS[zerodhaInterval] ?? 2000;
  const earliestAllowed = new Date(to);
  earliestAllowed.setDate(earliestAllowed.getDate() - maxDays);

  const clampedFrom = from < earliestAllowed ? earliestAllowed : from;

  if (from < earliestAllowed) {
    console.log(
      `[zerodha] Clamped from=${from.toISOString().split("T")[0]} to ${clampedFrom.toISOString().split("T")[0]} (max ${maxDays} days for ${zerodhaInterval})`,
    );
  }

  // NOTE: Intraday window normalization (snapping from/to to whole-day
  // bounds) is now applied by the caller in historical-fetcher.ts before
  // invoking this function, so both the Zerodha and Yahoo fallback paths
  // use identical widened windows. See the comment in that file for why
  // Zerodha's intraday API needs whole-day bounds.

  try {
    const fromStr = formatDate(clampedFrom);
    const toStr = formatDate(to);

    // Expose which API key is being used so we can distinguish between
    // multiple Kite Connect apps (only the one with the Historical API
    // add-on has intraday history). The full key is not secret - Zerodha
    // docs treat the public api_key as non-sensitive; only api_secret +
    // access_token are sensitive.
    const apiKeyLabel = credentials.apiKey
      ? `${credentials.apiKey.slice(0, 6)}…${credentials.apiKey.slice(-3)}`
      : "<none>";
    console.log(
      `[zerodha] Historical request: token=${instrumentToken}, interval=${zerodhaInterval}, from=${fromStr}, to=${toStr}, apiKey=${apiKeyLabel}`,
    );

    const url = `${ZERODHA_BASE_URL}/instruments/historical/${instrumentToken}/${zerodhaInterval}`;
    const rawResponse = await ky.get(url, {
      searchParams: { from: fromStr, to: toStr, continuous: "0", oi: "0" },
      headers: getHeaders(credentials),
      timeout: 10000,
    });
    const response = (await rawResponse.json()) as ZerodhaHistoricalResponse & {
      error_type?: string;
      message?: string;
    };

    if (response.status !== "success" || !response.data?.candles) {
      console.warn(
        `[zerodha] Historical response not successful for token ${instrumentToken}: ${JSON.stringify(
          response,
        )}`,
      );
      return [];
    }

    if (response.data.candles.length === 0) {
      console.warn(
        `[zerodha] EMPTY success response for token ${instrumentToken} at ${url}?from=${fromStr}&to=${toStr}&continuous=0&oi=0  response=${JSON.stringify(
          response,
        )}`,
      );
    } else {
      // Log first + last candle timestamps so we can see which days
      // Zerodha actually returned vs which days we asked for. Helps
      // diagnose silent range clipping on the Zerodha side.
      const firstTs = response.data.candles[0]?.[0] ?? "?";
      const lastTs =
        response.data.candles[response.data.candles.length - 1]?.[0] ?? "?";
      console.log(
        `[zerodha] Historical returned ${response.data.candles.length} candles for token ${instrumentToken} (first=${firstTs}, last=${lastTs})`,
      );
    }

    return response.data.candles.map(
      ([timestamp, open, high, low, close, volume]) => ({
        date: new Date(timestamp),
        open,
        high,
        low,
        close,
        volume,
      }),
    );
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    if (status === 401 || status === 403) {
      console.warn(
        `[zerodha] Historical auth error (${status}) for token ${instrumentToken} - falling back`,
      );
      return []; // Token invalid - signal fallback
    }
    // Log the response body on non-auth errors so we can see what Zerodha
    // is complaining about (e.g. "no permission for this segment",
    // "historical data not available for this symbol").
    const errorBody = await (
      error as { response?: { text?: () => Promise<string> } }
    ).response
      ?.text?.()
      .catch(() => null);
    if (errorBody) {
      console.error(
        `[zerodha] Historical error body for token ${instrumentToken}: ${errorBody}`,
      );
    }
    console.error(
      `[zerodha] Historical error for token ${instrumentToken}:`,
      error,
    );
    return [];
  }
}

// ============== HELPERS ==============

/**
 * Format date as YYYY-MM-DD HH:mm:ss for Zerodha API.
 * Uses local-time methods because Zerodha expects IST - deployments run
 * with TZ=Asia/Kolkata so local time == IST.
 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}
