/**
 * Yahoo Finance Client
 *
 * Provides market data using direct Yahoo Finance REST APIs.
 * Primary data source for all authenticated users.
 *
 * Enhanced with a fetch-and-store pattern:
 * - Historical data is cached in the DailyPrice table
 * - Latest quotes can be served from the LatestQuote table
 * - Falls back to direct Yahoo Finance API when DB is empty
 */

import { prisma } from "@usemoney/database";
import {
  yahooFetchQuotes,
  yahooFetchChart,
  yahooFetchSearch,
  getHistoricalPrices,
  getLatestQuote as getLatestQuoteFromDB,
  getLatestQuotes as getLatestQuotesFromDB,
  type YahooQuoteData,
} from "@usemoney/core/market-data";
import {
  queryByIdChunks,
  DEFAULT_QUOTE_TTL_MS as DEFAULT_LATEST_QUOTE_TTL_MS,
} from "@usemoney/core/market-data/prices/quote-logic";

// ============== TYPES ==============
// QuoteData + Period and the pure parsing/mapping helpers live in
// ./yahoo-client-logic so they can be unit-tested without this module's
// Prisma/network imports. Re-export QuoteData for existing consumers.

export type { QuoteData, Period } from "./yahoo-client-logic";
import {
  rawQuoteToQuoteData,
  extractSymbol,
  mapExchange,
  getPeriodStartDate,
  type QuoteData,
  type Period,
} from "./yahoo-client-logic";

// ONE bar type with core: it carries `source` and `adjustedThrough`, which the
// chart route needs to adjust a mixed exchange/Yahoo series once (MONEY-1382).
export type { HistoricalBar } from "@usemoney/core/market-data/prices/yahoo-price-logic";
import type { HistoricalBar } from "@usemoney/core/market-data/prices/yahoo-price-logic";

export interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  yahooSymbol: string;
}

export type Interval =
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "60m"
  | "1h"
  | "1d"
  | "5d"
  | "1wk"
  | "1mo"
  | "3mo";

// ============== QUOTE FUNCTIONS ==============

/**
 * Get a single quote for a symbol
 */
export async function getQuote(yahooSymbol: string): Promise<QuoteData | null> {
  try {
    const quotes = await yahooFetchQuotes([yahooSymbol]);
    const quote = quotes.get(yahooSymbol);

    if (!quote) {
      return null;
    }

    return rawQuoteToQuoteData(yahooSymbol, quote);
  } catch (error) {
    console.error(`Failed to fetch quote for ${yahooSymbol}:`, error);
    return null;
  }
}

/**
 * Get quotes for multiple symbols — a LIVE, UNCACHED read.
 *
 * MONEY-1124 deliberately did NOT put the shared 15s quote cache here. This
 * function is the tick source for the SSE stream
 * (`app/api/market/stream/route.ts`, `POLL_INTERVAL = 5000`), and a cache
 * shorter than the poll interval is a no-op while one longer than it makes the
 * stream emit duplicate frames — a visibly frozen "live" price. The cache lives
 * one layer up, in `lib/market/quote-cache.ts`, which only the request/response
 * quote route uses. If SSE upstream load ever needs reducing, raise
 * `POLL_INTERVAL`; do not cache here.
 *
 * (The stream does benefit from the batch-size fix: `QUOTE_BATCH_SIZE` went
 * 6 → 40, so a 50-symbol stream now costs 2 Yahoo requests per tick, not 9.)
 */
export async function getQuotes(
  yahooSymbols: string[]
): Promise<Map<string, QuoteData>> {
  const results = new Map<string, QuoteData>();

  if (yahooSymbols.length === 0) {
    return results;
  }

  try {
    const rawQuotes = await yahooFetchQuotes(yahooSymbols);

    rawQuotes.forEach((quote, symbol) => {
      const baseSymbol = extractSymbol(symbol);
      results.set(baseSymbol, rawQuoteToQuoteData(symbol, quote));
    });
  } catch (error) {
    // Gracefully degrade - return whatever we have (empty map) so callers
    // like the FIRE page don't freeze or block navigation.
    const isAbort =
      error instanceof DOMException && error.name === "AbortError";
    if (isAbort) {
      console.warn(
        "[yahoo-client] getQuotes timed out (AbortError), returning empty results"
      );
    } else {
      console.warn(
        "[yahoo-client] getQuotes failed, returning empty results:",
        error
      );
    }
  }

  return results;
}

// ============== HISTORICAL DATA ==============

/**
 * Yahoo Finance fetcher implementation for the core price service.
 * Bridges the REST API with the core module's interface.
 */
async function yahooHistoricalFetcher(
  yahooSymbol: string,
  startDate: Date,
  endDate: Date
): Promise<HistoricalBar[]> {
  return yahooFetchChart(yahooSymbol, {
    period1: startDate,
    period2: endDate,
    interval: "1d",
  });
}

/**
 * Get historical OHLCV data for a symbol.
 * Enhanced with fetch-and-store: checks DailyPrice DB first,
 * fetches from Yahoo only for missing data, stores results.
 */
export async function getHistorical(
  yahooSymbol: string,
  options: {
    period?: Period;
    interval?: Interval;
    startDate?: Date;
    endDate?: Date;
  } = {}
): Promise<HistoricalBar[]> {
  const { period = "1mo", interval = "1d", startDate, endDate } = options;

  console.log(
    `[yahoo-client] getHistorical ${yahooSymbol} interval=${interval} period=${period}`
  );

  const p1 = startDate ?? getPeriodStartDate(period);
  const p2 = endDate ?? new Date();

  // For daily interval, try the DB-backed fetch-and-store pattern (with timeout)
  if (interval === "1d") {
    try {
      const instrument = await prisma.instrumentMapping.findUnique({
        where: { yahooSymbol },
        select: { id: true },
      });

      if (instrument) {
        console.log(
          `[yahoo-client] Instrument found in DB (id=${instrument.id}), using DB-backed fetch`
        );

        // Race DB-backed fetch against a 10s timeout
        const DB_TIMEOUT_MS = 10_000;
        const dbResult = await Promise.race([
          getHistoricalPrices(instrument.id, p1, p2, yahooHistoricalFetcher),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), DB_TIMEOUT_MS)
          ),
        ]);

        if (dbResult !== null && dbResult.length > 0) {
          console.log(
            `[yahoo-client] DB-backed fetch returned ${dbResult.length} bars`
          );
          return dbResult;
        }

        if (dbResult === null) {
          console.warn(
            `[yahoo-client] DB-backed fetch timed out after ${DB_TIMEOUT_MS}ms, falling back to direct fetch`
          );
        } else {
          console.log(
            `[yahoo-client] DB-backed fetch returned 0 bars, falling back to direct fetch`
          );
        }
      } else {
        console.log(
          `[yahoo-client] Instrument not in DB, falling through to direct fetch`
        );
      }
    } catch (dbError) {
      console.warn(
        `[yahoo-client] DB-backed path failed, falling through to direct fetch:`,
        dbError
      );
    }
  }

  // Direct Yahoo Finance fetch - reliable fallback for any interval
  try {
    console.log(
      `[yahoo-client] Direct Yahoo fetch for ${yahooSymbol} (interval=${interval})`
    );
    const fetchedAt = new Date();
    const bars = await yahooFetchChart(yahooSymbol, {
      period1: p1,
      period2: p2,
      interval,
    });
    console.log(`[yahoo-client] Direct fetch returned ${bars.length} bars`);
    // MONEY-1382 — Yahoo serves history already restated for every split it
    // knows of as of NOW. Say so, or the chart route divides these bars by the
    // same splits a second time.
    return bars.map((b) => ({
      ...b,
      source: "YAHOO",
      adjustedThrough: fetchedAt,
    }));
  } catch (error) {
    console.error(
      `[yahoo-client] Failed to fetch historical data for ${yahooSymbol}:`,
      error
    );
    return [];
  }
}

/**
 * Get intraday chart data (for shorter timeframes).
 *
 * Accepts either a Yahoo-style `period` preset OR explicit `period1`/`period2`
 * timestamps. Explicit dates take priority and are required for the
 * TradingView progressive-scroll pattern, where each backward-scroll request
 * targets a different window inside Yahoo's intraday retention.
 *
 * Yahoo's intraday retention (per interval, approximate):
 *   - 1m:  ~7 days
 *   - 5m:  ~60 days
 *   - 15m: ~60 days
 *   - 30m: ~60 days
 *   - 60m: ~730 days
 *
 * Requests outside retention return an empty array; callers should map that
 * to a UDF `no_data` response so the chart stops scrolling.
 */
export async function getIntradayChart(
  yahooSymbol: string,
  options: {
    period?: "1d" | "5d" | "1mo";
    interval?: "1m" | "5m" | "15m" | "30m" | "60m";
    /** Explicit start - takes priority over `period` when set with period2. */
    period1?: Date;
    /** Explicit end - takes priority over `period` when set with period1. */
    period2?: Date;
  } = {}
): Promise<HistoricalBar[]> {
  const { period = "1d", interval = "5m", period1, period2 } = options;

  const start = period1 ?? getPeriodStartDate(period);
  const end = period2 ?? new Date();

  try {
    return await yahooFetchChart(yahooSymbol, {
      period1: start,
      period2: end,
      interval,
    });
  } catch (error) {
    console.error(`Failed to fetch intraday chart for ${yahooSymbol}:`, error);
    return [];
  }
}

// ============== DB-BACKED QUOTE FUNCTIONS ==============

/**
 * Yahoo quote fetcher for the core quote service.
 * Bridges the REST API with the core module's interface.
 */
async function yahooQuoteFetcher(
  yahooSymbol: string
): Promise<YahooQuoteData | null> {
  const quote = await getQuote(yahooSymbol);
  if (!quote) return null;

  return {
    symbol: yahooSymbol,
    price: quote.price,
    change: quote.change,
    changePercent: quote.changePercent,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    previousClose: quote.previousClose,
    volume: quote.volume,
    marketCap: quote.marketCap,
    pe: quote.pe,
    eps: quote.eps,
    week52High: quote.week52High,
    week52Low: quote.week52Low,
    timestamp: quote.timestamp,
  };
}

/**
 * Yahoo batch quote fetcher for the core quote service.
 */
async function yahooBatchQuoteFetcher(
  yahooSymbols: string[]
): Promise<Map<string, YahooQuoteData>> {
  const quotes = await getQuotes(yahooSymbols);
  const result = new Map<string, YahooQuoteData>();

  quotes.forEach((quote) => {
    // Re-construct the Yahoo symbol from the parsed data
    const yahooSym = yahooSymbols.find(
      (ys) => extractSymbol(ys) === quote.symbol
    );
    if (!yahooSym) return;

    result.set(yahooSym, {
      symbol: yahooSym,
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      previousClose: quote.previousClose,
      volume: quote.volume,
      marketCap: quote.marketCap,
      pe: quote.pe,
      eps: quote.eps,
      week52High: quote.week52High,
      week52Low: quote.week52Low,
      timestamp: quote.timestamp,
    });
  });

  return result;
}

/**
 * Get a quote for an instrument by its DB ID.
 * Uses the LatestQuote DB cache with 60s TTL.
 */
export async function getQuoteByInstrumentId(
  instrumentId: string
): Promise<QuoteData | null> {
  const cached = await getLatestQuoteFromDB(
    instrumentId,
    yahooQuoteFetcher,
    60_000
  );

  if (!cached) return null;

  // Fetch instrument details for the full QuoteData shape
  const instrument = await prisma.instrumentMapping.findUnique({
    where: { id: instrumentId },
    select: { symbol: true, exchange: true, name: true },
  });

  return {
    symbol: instrument?.symbol ?? "UNKNOWN",
    exchange: instrument?.exchange ?? "NSE",
    name: instrument?.name ?? "Unknown",
    price: cached.price,
    change: cached.change ?? 0,
    changePercent: cached.changePercent ?? 0,
    open: cached.open ?? 0,
    high: cached.high ?? 0,
    low: cached.low ?? 0,
    previousClose: cached.previousClose ?? 0,
    volume: cached.volume ?? 0,
    timestamp: cached.timestamp,
    marketCap: cached.marketCap,
    pe: cached.pe ?? undefined,
    eps: cached.eps ?? undefined,
    week52High: cached.week52High ?? undefined,
    week52Low: cached.week52Low ?? undefined,
  };
}

/**
 * Get quotes for multiple instruments by their DB IDs.
 * Uses the LatestQuote DB cache (default 60s TTL — callers on an interactive
 * request path may pass a shorter one).
 */
export async function getQuotesByInstrumentIds(
  instrumentIds: string[],
  ttlMs: number = DEFAULT_LATEST_QUOTE_TTL_MS
): Promise<Map<string, QuoteData>> {
  const results = new Map<string, QuoteData>();

  if (instrumentIds.length === 0) return results;

  const cachedQuotes = await getLatestQuotesFromDB(
    instrumentIds,
    yahooBatchQuoteFetcher,
    ttlMs
  );

  // Fetch instrument details for the full QuoteData shape (MONEY-704).
  //
  // This was a full `instrumentMapping.findMany()` + in-memory `.filter()`,
  // justified by a comment about "Prisma $expr zombie ops on MongoDB". The
  // Prisma MongoDB connector compiles `{ id: { in: [...] } }` to a plain `$in`
  // on the primary key — an index lookup, not a COLLSCAN — so the whole
  // ~12k-row instrument universe was being read on every quote batch to hydrate
  // at most 50 names. Chunked so a huge id list still never reverts to a scan.
  const instruments = await queryByIdChunks(instrumentIds, (chunk) =>
    prisma.instrumentMapping.findMany({
      where: { id: { in: chunk } },
      select: { id: true, symbol: true, exchange: true, name: true },
    })
  );

  const instrumentMap = new Map(instruments.map((i) => [i.id, i]));

  cachedQuotes.forEach((cached, instrumentId) => {
    const inst = instrumentMap.get(instrumentId);
    results.set(instrumentId, {
      symbol: inst?.symbol ?? "UNKNOWN",
      exchange: inst?.exchange ?? "NSE",
      name: inst?.name ?? "Unknown",
      price: cached.price,
      change: cached.change ?? 0,
      changePercent: cached.changePercent ?? 0,
      open: cached.open ?? 0,
      high: cached.high ?? 0,
      low: cached.low ?? 0,
      previousClose: cached.previousClose ?? 0,
      volume: cached.volume ?? 0,
      timestamp: cached.timestamp,
      marketCap: cached.marketCap,
      pe: cached.pe ?? undefined,
      eps: cached.eps ?? undefined,
      week52High: cached.week52High ?? undefined,
      week52Low: cached.week52Low ?? undefined,
    });
  });

  return results;
}

// ============== SEARCH ==============

/**
 * Search for symbols by query
 */
export async function searchSymbols(
  query: string,
  options: {
    region?: string;
    quotesCount?: number;
  } = {}
): Promise<SearchResult[]> {
  const { region = "IN", quotesCount = 10 } = options;

  try {
    const rawQuotes = await yahooFetchSearch(query, { quotesCount });

    if (!rawQuotes || rawQuotes.length === 0) {
      return [];
    }

    return rawQuotes
      .filter((quote) => {
        // Filter for Indian exchanges if region is IN
        if (region === "IN") {
          return (
            quote.exchange === "NSI" ||
            quote.exchange === "BSE" ||
            quote.exchange === "NSE" ||
            quote.symbol?.endsWith(".NS") ||
            quote.symbol?.endsWith(".BO")
          );
        }
        return true;
      })
      .map((quote) => ({
        symbol: extractSymbol(quote.symbol || ""),
        name: quote.shortname || quote.longname || quote.symbol || "",
        exchange: mapExchange(quote.exchange || ""),
        type: quote.quoteType || "EQUITY",
        yahooSymbol: quote.symbol || "",
      }));
  } catch (error) {
    console.error("Failed to search symbols:", error);
    return [];
  }
}

// Symbol/exchange/period helpers now live in ./yahoo-client-logic
// (imported at the top of this file).

// ============== INDEX DATA ==============

// INDIAN_INDICES is a pure constant defined in ./yahoo-client-logic and
// re-exported here for existing consumers.
export { INDIAN_INDICES } from "./yahoo-client-logic";
import { INDIAN_INDICES } from "./yahoo-client-logic";

/**
 * Get major index quotes
 */
export async function getIndianIndices(): Promise<QuoteData[]> {
  const indexSymbols = Object.values(INDIAN_INDICES);
  const quotesMap = await getQuotes(indexSymbols);
  return Array.from(quotesMap.values());
}
