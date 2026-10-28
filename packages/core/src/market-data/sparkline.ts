/**
 * Sparkline fetching - compact close-price arrays for small trend charts.
 *
 * Separate from fetchChart() because:
 * - We strip OHLCV down to just closes (smaller payload)
 * - We expose a batched API so list views can fetch N symbols in parallel
 * - We target a fixed window vocabulary (1D / 1W / 1M) that list UIs need
 *
 * Target sizes after projection:
 *   1D → ~30 5-minute bars
 *   1W → ~5 daily bars
 *   1M → ~22 daily bars
 */

import { fetchChart, withExchangeFallback } from "./yahoo-api";

export type SparklineWindow = "1D" | "1W" | "1M";

export interface SparklineSymbol {
  symbol: string;
  exchange: "NSE" | "BSE";
}

export interface SparklineResult {
  symbol: string;
  exchange: string;
  yahooSymbol: string;
  window: SparklineWindow;
  closes: number[];
  /** Unix ms of last bar. Lets the caller show "updated 12m ago". */
  lastUpdated: number | null;
}

/** How far back to look for each window, and what bar interval Yahoo should return. */
const WINDOW_CONFIG: Record<
  SparklineWindow,
  { lookbackMs: number; interval: string }
> = {
  "1D": { lookbackMs: 24 * 60 * 60 * 1000, interval: "5m" },
  "1W": { lookbackMs: 8 * 24 * 60 * 60 * 1000, interval: "1d" },
  "1M": { lookbackMs: 35 * 24 * 60 * 60 * 1000, interval: "1d" },
};

/** Map NSE/BSE symbol → Yahoo suffix. Callers can pass yahooSymbol directly if known. */
export function toYahooSparklineSymbol(
  symbol: string | null | undefined,
  exchange: "NSE" | "BSE" | null | undefined,
): string {
  // Defensive: callers occasionally pass undefined when an instrument
  // resolution failed (e.g. sector heatmap with a stale symbol cache).
  // Returning "" here lets `fetchSparkline` short-circuit and return an
  // empty series rather than crashing the entire batch.
  if (!symbol || typeof symbol !== "string") return "";
  // Already-suffixed (.NS / .BO) or Yahoo index symbols (^NSEI / ^BSESN) pass through.
  if (symbol.includes(".") || symbol.startsWith("^")) return symbol;
  return exchange === "BSE" ? `${symbol}.BO` : `${symbol}.NS`;
}

/**
 * Fetch a single sparkline series. Returns empty closes on any upstream failure
 * - callers are expected to render a muted placeholder rather than erroring.
 */
export async function fetchSparkline(
  symbol: string,
  exchange: "NSE" | "BSE",
  window: SparklineWindow,
): Promise<SparklineResult> {
  const yahooSymbol = toYahooSparklineSymbol(symbol, exchange);
  // Empty yahooSymbol = caller passed undefined/null; return an empty
  // series so the batch doesn't lose all the other symbols' data.
  if (!yahooSymbol) {
    return {
      symbol: symbol ?? "",
      exchange,
      yahooSymbol: "",
      window,
      closes: [],
      lastUpdated: null,
    };
  }
  const { lookbackMs, interval } = WINDOW_CONFIG[window];
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - lookbackMs);

  const bars = await withExchangeFallback(yahooSymbol, (sym) =>
    fetchChart(sym, { period1, period2, interval }),
  );

  if (!bars || bars.length === 0) {
    return {
      symbol,
      exchange,
      yahooSymbol,
      window,
      closes: [],
      lastUpdated: null,
    };
  }

  const closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c));
  const lastBar = bars[bars.length - 1];
  return {
    symbol,
    exchange,
    yahooSymbol,
    window,
    closes,
    lastUpdated: lastBar ? lastBar.date.getTime() : null,
  };
}

/**
 * Fetch sparklines for many symbols in parallel. Order of the input array is
 * NOT preserved in the returned Map - callers should look up by `${symbol}|${exchange}`.
 */
export async function fetchSparklines(
  symbols: SparklineSymbol[],
  window: SparklineWindow,
): Promise<Map<string, SparklineResult>> {
  const out = new Map<string, SparklineResult>();
  if (symbols.length === 0) return out;

  const results = await Promise.all(
    symbols.map(({ symbol, exchange }) =>
      fetchSparkline(symbol, exchange, window).catch((err) => {
        console.warn(
          `[sparkline] fetch failed for ${symbol} (${exchange}):`,
          err instanceof Error ? err.message : err,
        );
        return {
          symbol,
          exchange,
          yahooSymbol: toYahooSparklineSymbol(symbol, exchange),
          window,
          closes: [],
          lastUpdated: null,
        } as SparklineResult;
      }),
    ),
  );

  for (const r of results) {
    out.set(`${r.symbol}|${r.exchange}`, r);
  }
  return out;
}

export function sparklineCacheKey(
  symbol: string,
  exchange: "NSE" | "BSE",
  window: SparklineWindow,
): string {
  return `sparkline:${exchange}:${symbol}:${window}`;
}
