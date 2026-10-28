/**
 * Yahoo Finance REST API — Pure Logic
 *
 * Pure, side-effect-free helpers used by `yahoo-api.ts`. Extracted so the exact
 * cookie/crumb-cache lifecycle, retry-decision, batch-splitting, URL-building,
 * quote-filtering and chart-bar-parsing logic that production runs can be
 * unit-tested without performing any network I/O.
 *
 * `yahoo-api.ts` imports and calls these — there are no parallel copies.
 */

import type { YahooRawQuote, ChartBar, SearchQuote } from "./yahoo-api";

// ─── Constants ───────────────────────────────────────────────────────
export const CRUMB_TTL_MS = 20 * 60 * 1000; // 20 minutes
export const FETCH_TIMEOUT_MS = 15_000; // 15 seconds per fetch
export const MAX_RETRIES = 3;

/**
 * MONEY-1135 — wall-clock budget for one `fetchQuotes` call, retries included.
 *
 * Per-fetch timeouts alone left the aggregate unbounded: the retry chain is
 * serial, so a single chunk's worst case was 4 x FETCH_TIMEOUT_MS plus backoff
 * — over a minute on a path a user is waiting on.
 *
 * 20s is chosen to sit comfortably under a serverless function timeout so the
 * CALLER's error/degradation path still gets to run, while leaving room for one
 * full attempt plus a retry on a merely-slow upstream. Quotes are refreshed by
 * polling, so a call that returns partial data is materially better than one
 * that returns nothing a minute later.
 */
export const QUOTE_FETCH_BUDGET_MS = 20_000;
export const BACKOFF_BASE_MS = 1000;
/**
 * Max symbols per Yahoo quote request (MONEY-1124).
 *
 * Was 6, on the theory that "smaller batches avoid the 15s timeout". That was
 * backwards: Yahoo's `/v7/finance/quote` endpoint costs essentially the same
 * whether you ask for 6 symbols or 40 (one document lookup per symbol, one
 * round trip), so a 50-symbol portfolio paid NINE round trips — nine chances to
 * hit the 15s timeout, nine chances to trip the 429 limiter, and nine
 * retry/backoff ladders running concurrently. 40 turns the same portfolio into
 * two requests.
 *
 * Chunking is still real (`splitIntoBatches` + `Promise.allSettled` in
 * `yahoo-api.ts#fetchQuotes`) so a single bad symbol can only poison its own
 * chunk, and callers with hundreds of symbols (the price-sync worker) still get
 * bounded URLs.
 *
 * 20, not 40: `Promise.allSettled` means a rejected chunk drops EVERY symbol in
 * it, and the failure is not visible to the user — `useLivePositions` falls back
 * to the last broker-synced price with `dayChange` forced to 0, which renders
 * identically to a live quote. At 40 a single chunk failure blanked 80% of a
 * 50-holding portfolio; at 20 it is 40%, for one extra round trip. The 6 → 20
 * step already captures most of the round-trip win (nine requests down to
 * three), and the 15s symbol cache above means a 5s poller pays that at most
 * once per 15s regardless.
 */
export const QUOTE_BATCH_SIZE = 20;

export const YAHOO_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ─── Cookie/Crumb auth cache ─────────────────────────────────────────

export interface YahooAuthCache {
  cookie: string | null;
  crumb: string | null;
  expiry: number;
}

export function createAuthCache(): YahooAuthCache {
  return { cookie: null, crumb: null, expiry: 0 };
}

/** Auth is valid only when both cookie and crumb are present and not expired. */
export function isAuthValid(cache: YahooAuthCache, now: number): boolean {
  return !!(cache.cookie && cache.crumb && now < cache.expiry);
}

export function setAuth(
  cache: YahooAuthCache,
  cookie: string,
  crumb: string,
  now: number,
): void {
  cache.cookie = cookie;
  cache.crumb = crumb;
  cache.expiry = now + CRUMB_TTL_MS;
}

export function invalidateAuthCache(cache: YahooAuthCache): void {
  cache.cookie = null;
  cache.crumb = null;
  cache.expiry = 0;
}

// ─── Retry decisions ─────────────────────────────────────────────────

/** Should the request be retried for this HTTP status? (401/403/429/5xx) */
export function shouldRetry(statusCode: number): boolean {
  if (statusCode === 401 || statusCode === 403) return true;
  if (statusCode === 429) return true;
  if (statusCode >= 500) return true;
  return false;
}

/** Should the cookie/crumb be invalidated for this status? (401/403 only) */
export function shouldInvalidateAuth(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403;
}

/** Exponential backoff (ms) for the given 0-based attempt: 1000 * 2^attempt. */
export function calculateBackoff(attempt: number): number {
  return BACKOFF_BASE_MS * Math.pow(2, attempt);
}

export function isWithinMaxRetries(
  attempt: number,
  maxRetries = MAX_RETRIES,
): boolean {
  return attempt < maxRetries;
}

// ─── Batch splitting ─────────────────────────────────────────────────

export function splitIntoBatches<T>(
  items: T[],
  batchSize = QUOTE_BATCH_SIZE,
): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

// ─── URL construction ────────────────────────────────────────────────

export function buildQuoteUrl(symbols: string[]): string {
  const joined = symbols.map((s) => encodeURIComponent(s)).join(",");
  return `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${joined}`;
}

export function appendCrumb(url: string, crumb: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}crumb=${encodeURIComponent(crumb)}`;
}

export function buildChartUrl(
  symbol: string,
  period1: Date,
  period2: Date,
  interval = "1d",
): string {
  const p1 = Math.floor(period1.getTime() / 1000);
  const p2 = Math.floor(period2.getTime() / 1000);
  const encodedSymbol = encodeURIComponent(symbol);
  return `https://query2.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?period1=${p1}&period2=${p2}&interval=${interval}`;
}

export function buildSearchUrl(query: string, quotesCount = 10): string {
  const encodedQuery = encodeURIComponent(query);
  return `https://query2.finance.yahoo.com/v1/finance/search?q=${encodedQuery}&quotesCount=${quotesCount}&newsCount=0`;
}

export function buildQuoteSummaryUrl(
  symbol: string,
  modules: string[],
): string {
  const encodedSymbol = encodeURIComponent(symbol);
  const moduleList = modules.join(",");
  return `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodedSymbol}?modules=${moduleList}`;
}

// ─── Quote filtering ─────────────────────────────────────────────────

/** A quote is usable only if it has a symbol and a non-null price (0 is valid). */
export function isValidQuote(quote: Partial<YahooRawQuote>): boolean {
  return !!(quote.symbol && quote.regularMarketPrice != null);
}

export function filterValidQuotes(
  quotes: Partial<YahooRawQuote>[],
): Map<string, YahooRawQuote> {
  const result = new Map<string, YahooRawQuote>();
  for (const q of quotes) {
    if (isValidQuote(q)) {
      result.set(q.symbol as string, q as YahooRawQuote);
    }
  }
  return result;
}

// ─── Chart bar parsing ───────────────────────────────────────────────

export interface RawChartQuote {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
}

/**
 * Convert raw Yahoo chart arrays into ChartBars. Skips bars missing open or
 * close; falls back to open for missing high/low and 0 for missing volume.
 */
export function parseChartBars(
  timestamps: number[],
  quote: RawChartQuote,
): ChartBar[] {
  const bars: ChartBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i];

    if (open == null || close == null) continue;

    bars.push({
      date: new Date(timestamps[i]! * 1000),
      open,
      high: high ?? open,
      low: low ?? open,
      close,
      volume: volume ?? 0,
    });
  }
  return bars;
}

// ─── Envelope parsers ────────────────────────────────────────────────

/** Raw shape of the Yahoo v8 chart response (only the fields we read). */
export interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: RawChartQuote[] };
    }>;
    error?: { code?: string; description?: string };
  };
}

/**
 * Parse a full Yahoo v8 chart response envelope into ChartBars.
 * Returns [] on an API error payload or a missing timestamp/quote series,
 * then delegates the per-bar mapping to {@link parseChartBars}.
 */
export function parseChartResponse(json: YahooChartResponse): ChartBar[] {
  if (json?.chart?.error) return [];

  const chartResult = json?.chart?.result?.[0];
  if (!chartResult?.timestamp || !chartResult.indicators?.quote?.[0]) {
    return [];
  }

  return parseChartBars(chartResult.timestamp, chartResult.indicators.quote[0]);
}

/** Extract the quotes array from a Yahoo search response envelope. */
export function parseSearchResponse(json: {
  quotes?: SearchQuote[];
}): SearchQuote[] {
  return json?.quotes ?? [];
}

/** Extract the first result object from a Yahoo quoteSummary envelope. */
export function parseQuoteSummaryResponse(json: {
  quoteSummary?: { result?: Array<Record<string, unknown>> };
}): Record<string, unknown> | null {
  return json?.quoteSummary?.result?.[0] ?? null;
}
