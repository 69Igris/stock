"use client";

/**
 * useMarketData Hook
 *
 * Fetches real-time market quotes with polling.
 * Uses Yahoo Finance through the /api/market/quote endpoint.
 */

import { useState, useEffect, useCallback, useRef } from "react";
// Pure helpers — SINGLE SOURCE OF TRUTH (no shadows). The hook + useQuote CALL
// these so tests assert the same code that runs in production.
import {
  resolveMarketDataOptions,
  filterValidSymbols,
  buildQuoteParams,
  transformQuoteResponse,
  extractSingleQuote,
  extractMarketDataError,
  extractMarketDataMeta,
  isValidPollingInterval,
  EMPTY_MARKET_DATA_META,
  type MarketDataMeta,
  type RawApiQuote,
} from "./useMarketData-logic";
// MONEY-1469 (A4) — the service path.
import {
  buildServiceQuoteParams,
  dominantQuoteSource,
  transformServiceQuotes,
  type ServiceQuotesResponse,
} from "./useMarketData-logic";
import {
  BROKER_STATUS_URL,
  LEGACY_QUOTE_URL,
  isServiceQuotesUrl,
} from "@usemoney/core/market-data/quotes/quotes-target";
import { marketDataAuthHeaders } from "@/lib/market/market-data-auth";
import { useQuotesBaseUrl } from "@/components/charts/UdfBaseUrlProvider";
import type { QuoteExchange } from "@/lib/market/quote-exchange";

export type { MarketDataMeta };

// ============== TYPES ==============

/**
 * Where one quote came from and how old it is — MONEY-1309.
 *
 * Absent on India quotes (one provider, so a per-row label would be noise) and
 * present on US ones, where a batch can mix a live quote with yesterday's
 * close. Mirrors `QuoteProvenance` in `lib/market/yahoo-client-logic.ts`; the
 * hook re-declares rather than imports it because this file is the client-side
 * type surface and must not pull the server module graph into a bundle.
 */
export interface QuoteProvenance {
  source: string;
  asOf: string;
  fallback: boolean;
  session?: string;
  note?: string;
}

export interface QuoteData {
  symbol: string;
  exchange: string;
  /**
   * OPTIONAL. The market-data service stores prices, not instrument metadata,
   * so a quote read from Redis has no company name — and three of the four
   * consumers already guarded it (`quote?.name ?? symbol`). Declaring it
   * required while the service path could not supply it was the type lying
   * about the data.
   */
  name?: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  timestamp: Date;
  marketCap?: number;
  pe?: number;
  eps?: number;
  week52High?: number;
  week52Low?: number;
  provenance?: QuoteProvenance;
}

export interface UseMarketDataOptions {
  /**
   * This caller RENDERS `pe` / `eps` / `marketCap` / `week52High` / `week52Low`.
   *
   * The market-data service stores PRICES, not instrument metadata: `StoredQuote`
   * carries price/OHLC/volume and nothing else, so a quote served from it is a
   * strictly SMALLER shape than a legacy (Yahoo) one — the same asymmetry
   * `quote-cache-logic.ts` already refuses for the `LatestQuote` DB leg, whose
   * own note records what it costs: "Serving it from the general quote route
   * blanked four of the eight tiles on every stock page".
   *
   * MONEY-1469 built a second origin with that same smaller shape and wired it
   * in behind `MARKET_DATA_QUOTES`, which put the defect back on a path the
   * existing guard does not cover. Flipping the flag blanked P/E, EPS, MARKET
   * CAP, 52W HIGH and 52W LOW on every stock page while the price tiles kept
   * updating — so the card looked alive and was missing half its content.
   *
   * Set it ONLY where those fields are rendered. It routes those symbols to the
   * legacy route through the fallback that already exists for `missing` and
   * `incomplete`, so it costs the A4 win for that caller and nothing else — the
   * watchlist and the tickers, which read price fields only, are untouched.
   */
  needsFundamentals?: boolean;
  /** Polling interval in milliseconds (default: 10000 = 10 seconds) */
  interval?: number;
  /** Enable/disable polling (default: true) */
  enablePolling?: boolean;
  /** Exchange (default: NSE). A US venue (NASDAQ / NYSE / ...) is accepted. */
  exchange?: QuoteExchange;
  /** Called when data is fetched */
  onUpdate?: (quotes: Map<string, QuoteData>) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

/**
 * The envelope-level source the route reports.
 *
 * "TIINGO_RT" is a LIVE quote out of our own realtime keys; "TIINGO" is the
 * end-of-day close standing in for one. Per-quote `provenance` is finer-grained
 * and should be preferred wherever a single quote is rendered — the envelope
 * label is pessimistic across a batch by design.
 */
export type DataSource = "zerodha" | "yahoo" | "TIINGO_RT" | "TIINGO";
export type BrokerConnectionStatus = "active" | "needs_reauth" | "none";

export interface UseMarketDataResult {
  /** Map of symbol to quote data */
  quotes: Map<string, QuoteData>;
  /** Loading state */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Last successful update timestamp */
  lastUpdate: Date | null;
  /** Manually refresh data */
  refresh: () => Promise<void>;
  /** Connection status */
  status: "connected" | "polling" | "error" | "idle";
  /** Data source reported by the route (see {@link DataSource}). */
  source: DataSource;
  /** Broker connection status */
  brokerStatus: BrokerConnectionStatus;
  /**
   * Freshness of the payload: cached / asOf / delayed / partial.
   *
   * The route has returned these since MONEY-1124 and this hook threw them away
   * until MONEY-1309, which meant no consumer could tell a 75-second-old cached
   * price from a live one. `lastUpdate` answers "when did we fetch"; this
   * answers "how old is the number", which is the question a reader has.
   */
  meta: MarketDataMeta;
}

// ============== HOOK ==============

/**
 * The legacy route: quotes AND `brokerStatus` in one response.
 *
 * Unchanged. It stays the fail-safe target of `resolveQuotesBaseUrl`, so this
 * is the path every request takes until the flag says otherwise.
 */
/**
 * What the poller consumes, whichever origin answered.
 *
 * ONE type for both paths, deliberately: the service and the legacy route are
 * two contracts meeting here, and an untyped `[k: string]: unknown` let a `{}`
 * through to `setSource`/`setBrokerStatus` — the compiler caught it, which is
 * the whole reason to name the shape rather than widen it.
 */
interface PollResponse {
  success?: boolean;
  data?: Record<string, RawApiQuote>;
  source?: DataSource;
  brokerStatus?: BrokerConnectionStatus;
  [k: string]: unknown;
}

async function fetchFromLegacyRoute(
  symbols: string[],
  exchange: QuoteExchange
): Promise<PollResponse> {
  const response = await fetch(
    `${LEGACY_QUOTE_URL}?${buildQuoteParams(symbols, exchange)}`
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch quotes: ${response.statusText}`);
  }
  return response.json();
}

/**
 * The service: quotes from Redis, `brokerStatus` from web, IN PARALLEL.
 *
 * `brokerStatus` failing is NOT a quote failure. It is an entitlement gate, and
 * the UI already treats a missing one as "not active" — so a broker-status
 * outage must cost the realtime affordance and never the prices. That is why it
 * is caught here rather than allowed to reject the pair.
 */
async function fetchFromService(
  baseUrl: string,
  symbols: string[],
  exchange: QuoteExchange,
  needsFundamentals: boolean
): Promise<PollResponse> {
  const [quoteRes, statusRes] = await Promise.all([
    fetch(`${baseUrl}?${buildServiceQuoteParams(symbols, exchange)}`, {
      credentials: "omit",
      headers: await marketDataAuthHeaders(),
    }),
    fetch(BROKER_STATUS_URL).catch(() => null),
  ]);

  // THE SERVICE FAILING IS NOT THE POLL FAILING. It answers 503 when its store
  // is unreachable and 401 when a token lapsed, and in both cases the legacy
  // route can still serve every symbol — so falling back is strictly better
  // than surfacing an error to a user whose prices we can still fetch. This is
  // the same asymmetry `resolveQuotesBaseUrl` is built on: failing to the old
  // route costs latency nobody notices.
  if (!quoteRes.ok) {
    console.warn(
      `[useMarketData] quote service ${quoteRes.status}; using the legacy route`
    );
    return fetchFromLegacyRoute(symbols, exchange);
  }
  const body = (await quoteRes.json()) as ServiceQuotesResponse;
  // `s:"error"` is a 200 in this contract — the UDF convention the service
  // follows throughout — so an `ok` response is not enough to trust the body.
  if (body.s !== "ok") {
    console.warn(
      "[useMarketData] quote service returned s:error; using the legacy route"
    );
    return fetchFromLegacyRoute(symbols, exchange);
  }

  const { quotes, incomplete } = transformServiceQuotes(
    body,
    exchange,
    needsFundamentals
  );

  // FALL BACK FOR WHAT THE SERVICE COULD NOT ANSWER.
  //
  // `body.missing` was read by nothing, and that made a whole class of failure
  // silent. `discover/markets` hands this hook YAHOO symbols (`^NSEI`,
  // `RELIANCE.NS`) which the service keys verbatim as `^NSEI:NSE`, while
  // `refreshAllQuotes` writes `NIFTY 50:NSE` — a 100% miss. The legacy route
  // tolerated it because it did the Yahoo mapping itself. With `missing`
  // discarded the response was `s:"ok"`, `hits:0`, no error and no warning, and
  // every index card simply froze.
  //
  // The same path covers every other gap by construction: a new listing, one
  // outside QUOTABLE_TYPES, one whose 24h TTL lapsed, and the `incomplete`
  // quotes the US store cannot give a change for.
  const needLegacy = [...new Set([...(body.missing ?? []), ...incomplete])];
  let fallback: Record<string, RawApiQuote> = {};
  if (needLegacy.length > 0) {
    try {
      const legacy = await fetchFromLegacyRoute(needLegacy, exchange);
      if (legacy.success && legacy.data) fallback = legacy.data;
    } catch (err) {
      // A fallback failure is NOT a batch failure: the symbols the service DID
      // answer are still good, and throwing here would discard them.
      console.warn("[useMarketData] legacy fallback failed", err);
    }
  }

  let brokerStatus: BrokerConnectionStatus | undefined;
  if (statusRes?.ok) {
    brokerStatus = await statusRes
      .json()
      .then(
        (b) =>
          ((
            b as {
              brokerStatus?: BrokerConnectionStatus;
              data?: BrokerConnectionStatus;
            }
          ).brokerStatus ?? (b as { data?: BrokerConnectionStatus }).data) as
            | BrokerConnectionStatus
            | undefined
      )
      .catch(() => undefined);
  }

  const merged = { ...fallback, ...quotes };
  return {
    success: true,
    data: merged,
    // The DATA's source, never the transport — see `dominantQuoteSource`. Any
    // symbol served by the legacy route is Yahoo, so a mixed batch reads as
    // delayed, which is the conservative direction.
    ...(Object.keys(fallback).length > 0
      ? { source: "yahoo" as DataSource }
      : dominantQuoteSource(body.data ?? {})
        ? { source: dominantQuoteSource(body.data ?? {}) }
        : {}),
    ...(brokerStatus ? { brokerStatus } : {}),
  };
}

export function useMarketData(
  symbols: string[],
  options: UseMarketDataOptions = {}
): UseMarketDataResult {
  const { onUpdate, onError } = options;
  // Value defaults resolved by the shared (unit-tested) helper.
  const { interval, enablePolling, exchange, needsFundamentals } =
    resolveMarketDataOptions(options);

  const [quotes, setQuotes] = useState<Map<string, QuoteData>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [status, setStatus] = useState<
    "connected" | "polling" | "error" | "idle"
  >("idle");
  const [source, setSource] = useState<DataSource>("yahoo");
  // Resolved on the SERVER and carried down — see QuotesBaseUrlProvider.
  const quotesBaseUrl = useQuotesBaseUrl();
  const [brokerStatus, setBrokerStatus] =
    useState<BrokerConnectionStatus>("none");
  const [meta, setMeta] = useState<MarketDataMeta>(EMPTY_MARKET_DATA_META);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const symbolsRef = useRef(symbols);
  const mountedRef = useRef(true);

  // Update symbols ref when symbols change
  useEffect(() => {
    symbolsRef.current = symbols;
  }, [symbols]);

  // Fetch quotes from API
  const fetchQuotes = useCallback(async () => {
    const currentSymbols = symbolsRef.current;
    // Filter out empty/undefined entries - when an upstream resolver
    // returns a stale list with placeholders, the unfiltered join would
    // become "symbols=,,,,,," which the quote endpoint correctly
    // rejects with HTTP 400, breaking the live tile.
    const validSymbols = filterValidSymbols(currentSymbols);
    if (validSymbols.length === 0) {
      setQuotes(new Map());
      setStatus("idle");
      return;
    }

    // Skip live market data in demo mode
    if (
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode") === "true"
    ) {
      setStatus("idle");
      return;
    }

    setIsLoading(true);
    setStatus("polling");

    try {
      // MONEY-1469 (A4) — the service path, when the flag resolved to it.
      //
      // `brokerStatus` is fetched in PARALLEL rather than chained: it is an
      // entitlement gate read from a broker-connection row, it has nothing to
      // do with market data, and the service has no database to learn about
      // brokers from. Chaining would put the Vercel round trip this ticket
      // exists to remove back in front of the quote read.
      const data = isServiceQuotesUrl(quotesBaseUrl)
        ? await fetchFromService(
            quotesBaseUrl,
            validSymbols,
            exchange,
            needsFundamentals
          )
        : await fetchFromLegacyRoute(validSymbols, exchange);

      if (!mountedRef.current) return;

      if (data.success && data.data) {
        const quotesMap = transformQuoteResponse(
          data.data as Record<string, RawApiQuote>
        );

        setQuotes(quotesMap);
        setLastUpdate(new Date());
        setError(null);
        setStatus("connected");
        if (data.source) setSource(data.source);
        if (data.brokerStatus) setBrokerStatus(data.brokerStatus);
        // Always set, never conditionally: the meta fields are dropped from the
        // payload when undefined, so a `if (data.asOf)` guard would leave the
        // PREVIOUS response's freshness on screen beside the new prices.
        setMeta(extractMarketDataMeta(data as Record<string, unknown>));
        onUpdate?.(quotesMap);
      }
    } catch (err) {
      if (!mountedRef.current) return;

      const errorMessage = extractMarketDataError(err);
      setError(errorMessage);
      setStatus("error");
      onError?.(err instanceof Error ? err : new Error(errorMessage));
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [exchange, onUpdate, onError, quotesBaseUrl, needsFundamentals]);

  // Manual refresh
  const refresh = useCallback(async () => {
    await fetchQuotes();
  }, [fetchQuotes]);

  // Initial fetch and polling
  useEffect(() => {
    mountedRef.current = true;

    // Initial fetch
    if (symbols.length > 0) {
      fetchQuotes();
    }

    // Set up polling. Guard the interval: a 0 / NaN / Infinity value would make
    // setInterval fire as fast as possible (NaN coerces to 0), pegging the CPU.
    if (
      enablePolling &&
      symbols.length > 0 &&
      isValidPollingInterval(interval)
    ) {
      pollingRef.current = setInterval(fetchQuotes, interval);
    }

    return () => {
      mountedRef.current = false;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [symbols.join(","), interval, enablePolling, fetchQuotes]);

  return {
    quotes,
    isLoading,
    error,
    lastUpdate,
    refresh,
    status,
    source,
    brokerStatus,
    meta,
  };
}

// ============== SINGLE QUOTE HOOK ==============

export interface UseSingleQuoteResult {
  quote: QuoteData | null;
  isLoading: boolean;
  error: string | null;
  lastUpdate: Date | null;
  refresh: () => Promise<void>;
  source: DataSource;
  brokerStatus: BrokerConnectionStatus;
  meta: MarketDataMeta;
}

/**
 * Convenience hook for single symbol quote
 */
export function useQuote(
  symbol: string,
  options: Omit<UseMarketDataOptions, "onUpdate"> = {}
): UseSingleQuoteResult {
  const {
    quotes,
    isLoading,
    error,
    lastUpdate,
    refresh,
    source,
    brokerStatus,
    meta,
  } = useMarketData(symbol ? [symbol] : [], options);

  return {
    quote: extractSingleQuote(quotes, symbol),
    isLoading,
    error,
    lastUpdate,
    refresh,
    source,
    brokerStatus,
    meta,
  };
}

export default useMarketData;
