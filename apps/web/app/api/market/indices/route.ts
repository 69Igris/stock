/**
 * Market Indices API
 *
 * GET /api/market/indices
 *
 * Returns exchange-delayed quotes for major Indian & US market indices, used by
 * the MarketTicker component in the top bar. Cached for 60 seconds.
 *
 * MONEY-837: this is now Yahoo-only. The per-user Zerodha overlay (Gift NIFTY
 * futures + MCX commodity futures under the caller's own Kite Connect token) was
 * removed when the web app stopped using the paid Connect app. MCX commodities
 * still appear via their Yahoo COMEX/NYMEX proxies; Gift NIFTY (which had no
 * Yahoo proxy) is no longer shown. The payload is identical for every user, so
 * it is publicly cacheable.
 */

import { NextResponse } from "next/server";
import { apiLogger as logger } from "@usemoney/logger";
import { getQuotes } from "@/lib/market/yahoo-client";
import {
  TICKER_INDICES,
  MCX_COMMODITIES,
  getIndicesCache,
  isCacheFresh,
  getMarketPhase,
  stripYahooSuffix,
  buildIndexQuote,
  filterPositivePrice,
  withTimeout,
  type IndexRow,
  type YahooBasePayload,
  type IndicesCache,
} from "./indices-logic";

export const dynamic = "force-dynamic";

// Yahoo-only payloads are identical for every user → CDN + browser may cache.
const PUBLIC_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
} as const;

export async function GET() {
  const cache = getIndicesCache();

  try {
    // The indices payload is Yahoo-only and user-agnostic, so there is no auth
    // or per-user branch — every caller gets the same shared, cacheable base.
    const base = await getYahooBaseCached(cache);
    return NextResponse.json(base, { headers: PUBLIC_HEADERS });
  } catch (error) {
    logger.error({ error }, "Indices API error");
    // Return the stale Yahoo base on error if available (still public).
    if (cache.cachedResponse) {
      return NextResponse.json(cache.cachedResponse.data, {
        headers: PUBLIC_HEADERS,
      });
    }
    return NextResponse.json(
      { error: "Failed to fetch index data" },
      { status: 500 }
    );
  }
}

/**
 * Resolve the shared Yahoo base payload: fresh from the 60s globalThis cache,
 * coalesced onto an in-flight fetch, or freshly fetched + cached. The base is
 * Yahoo-only and identical for every user, so it is safe to share.
 */
async function getYahooBaseCached(
  cache: IndicesCache
): Promise<YahooBasePayload> {
  if (cache.cachedResponse && isCacheFresh(cache.cachedResponse.timestamp)) {
    return cache.cachedResponse.data;
  }

  // Coalesce concurrent refreshes onto one in-flight Yahoo fetch so a slow
  // Yahoo response doesn't fan out into N simultaneous upstream calls.
  if (cache.inflightPromise) {
    try {
      return await cache.inflightPromise;
    } catch {
      // in-flight fetch failed — fall through and start our own
    }
  }

  const promise = fetchYahooBase();
  cache.inflightPromise = promise;
  try {
    const base = await promise;
    cache.cachedResponse = { data: base, timestamp: Date.now() };
    return base;
  } finally {
    if (cache.inflightPromise === promise) {
      cache.inflightPromise = null;
    }
  }
}

/**
 * Fetch the Yahoo-only base payload: the standard indices plus the MCX
 * commodity COMEX/NYMEX proxies. Contains NO broker data, so it is cacheable
 * and shareable across all users.
 */
async function fetchYahooBase(): Promise<YahooBasePayload> {
  const allYahooSymbols = [
    ...TICKER_INDICES.map((i) => i.yahooSymbol),
    ...MCX_COMMODITIES.map((c) => c.yahooFallback),
  ];

  const quotesMap = await withTimeout(getQuotes(allYahooSymbols), 10_000).then(
    (r) => r ?? new Map()
  );

  const data: IndexRow[] = filterPositivePrice(
    TICKER_INDICES.map((idx) => {
      const stripped = stripYahooSuffix(idx.yahooSymbol);
      const quote = quotesMap.get(idx.yahooSymbol) || quotesMap.get(stripped);
      return buildIndexQuote(idx, quote ?? null);
    })
  );

  // MCX commodities → Yahoo global futures (COMEX/NYMEX). Public proxy shown to
  // everyone (the per-user Zerodha MCX upgrade was removed in MONEY-837).
  for (const commodity of MCX_COMMODITIES) {
    const quote = quotesMap.get(commodity.yahooFallback);
    if (quote && quote.price > 0) {
      data.push({
        symbol: commodity.yahooFallback,
        name: commodity.name,
        price: quote.price,
        change: quote.change,
        changePercent: quote.changePercent,
        market: "MCX",
      });
    }
  }

  return {
    success: true,
    data,
    marketStatus: {
      IN: getMarketPhase("IN"),
      US: getMarketPhase("US"),
      MCX: getMarketPhase("MCX"),
    },
  };
}
