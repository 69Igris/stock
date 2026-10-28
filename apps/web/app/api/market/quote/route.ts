/**
 * Market Quote API
 *
 * GET /api/market/quote?symbol=RELIANCE&exchange=NSE
 * GET /api/market/quote?symbols=RELIANCE,TCS,INFY&exchange=NSE
 *
 * Returns exchange-delayed quote data from Yahoo Finance.
 *
 * MONEY-837: the web app no longer fetches live quotes from Zerodha — that
 * (paid Kite Connect) path moved to the standalone Connect service. Quotes here
 * always come from Yahoo via the provider seam. The response still carries
 * `source` ("yahoo") and `brokerStatus` so the client can render the delayed-
 * data disclaimer / reconnect affordances.
 *
 * MONEY-1124: this route is polled every 5s per open tab (`useLivePositions`)
 * and every 10s by `useMarketData`, and it used to go LIVE to Yahoo on every
 * one of those requests — no cache, `force-dynamic`, `revalidate = 0` — while
 * bypassing the `LatestQuote` DB rows the rest of the app already maintains.
 * The resolution order is now:
 *
 *     shared cache (per symbol, 15s)  →  LatestQuote (60s)  →  Yahoo
 *
 * plus a whole-request time budget, because the Yahoo client's retry ladder
 * (3 attempts × a 15s timeout with 1s/2s/4s backoff) could otherwise stack to
 * ~67s of wall clock on one request. Fail-open is preserved: symbols nothing
 * could resolve are simply absent from `data`.
 *
 * The response stays `force-dynamic` / private — `brokerStatus` is per-user, so
 * the PAYLOAD must never be shared by a CDN even though the quotes inside it
 * are. Sharing happens in Redis, keyed per symbol, not in an HTTP cache.
 *
 * MONEY-1309: `?exchange=` now also accepts a US venue (NASDAQ / NYSE / ...),
 * which routes to `fetchUsQuotesUncached` instead. That path reads OUR OWN
 * realtime Redis keys with the `candles` EOD close behind them and issues ZERO
 * vendor requests — Tiingo is a paid, metered, internal-use-only feed and a
 * route polled every 5-10 seconds per open tab must never reach it. It also
 * skips the shared cache entirely; the three reasons are on
 * `fetchUsQuotesUncached`.
 *
 * `delayed` is consequently no longer hardcoded true. It is derived from the
 * source, so a US quote served live says so and the UI disclaimer follows the
 * DATA rather than the viewer.
 */

import { apiLogger as logger } from "@usemoney/logger";

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isDemoSession } from "@/lib/demo/session";
import { getBrokerMarketDataStatus } from "@/lib/actions/broker-status";
import {
  fetchQuotesCached,
  fetchUsQuotesUncached,
  type CachedQuotesResult,
} from "@/lib/market/quote-cache";
import { currentUserMaySeeUsMarket } from "@/lib/market/us-access";
import {
  isUsExchange,
  resolveQuoteExchange,
  type QuoteExchange,
} from "@/lib/market/quote-exchange";
import { QUOTE_REQUEST_BUDGET_MS } from "@/lib/market/quote-cache-logic";
import {
  parseSymbolList,
  validateSymbolListNotEmpty,
  validateSymbolListSize,
  validateSymbolParams,
  isLiveQuote,
  formatSingleQuoteResponse,
  formatMultiQuoteResponse,
  type QuoteResponseMeta,
  type QuoteResponseSource,
} from "./quote-logic";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Freshness metadata for the response envelope.
 *
 * `asOf` is the OLDEST market timestamp in the payload, so a partially-cached
 * response advertises the age of its stalest price, not its freshest.
 *
 * `delayed` used to be hardcoded true, correctly, because every provider was
 * Yahoo. It is now `!isLiveQuote({ source })` — one function, read by this
 * envelope, by the UI disclaimer and by apps/api, so the payload and the
 * compliance note cannot drift apart.
 *
 * The envelope has no per-quote `fallback` to pass, and does not need one:
 * `batchQuoteSource` is pessimistic, so a batch containing ANY fallback quote
 * already arrives here labelled `TIINGO`.
 */
function buildMeta(
  result: {
    fromCache: boolean;
    asOfMs: number | null;
    partial: boolean;
  },
  source: string
): QuoteResponseMeta {
  return {
    cached: result.fromCache,
    delayed: !isLiveQuote({ source }),
    partial: result.partial,
    ...(result.asOfMs !== null
      ? { asOf: new Date(result.asOfMs).toISOString() }
      : {}),
  };
}

/**
 * Resolve quotes for whichever market the venue belongs to.
 *
 * The branch is at the TOP of the request rather than inside the cache, so no
 * US symbol ever touches `toYahooSymbol` (which would suffix `DOW` into the
 * NSE-listed `DOW.NS`) and no Tiingo-derived quote ever touches the `_global`
 * shared cache scope.
 */
async function fetchForExchange(
  symbols: string[],
  exchange: QuoteExchange,
  budgetMs: number
): Promise<CachedQuotesResult> {
  if (isUsExchange(exchange)) {
    // LICENCE GATE. Tiingo COMMERCIAL is internal-use-only: ingesting US
    // prices is permitted, serving them to a user is redistribution and needs
    // MONEY-1262. The stock PAGE was already behind `us-stocks-listing`, but
    // this route was behind nothing — a dark page in front of open data is not
    // a gate, it is a link nobody has been given yet.
    //
    // Refusal is ABSENCE, not an error: the same contract the US read path
    // already uses for symbols past the EOD fan-out cap, which every caller
    // reports as `unresolved`. An error would confirm to an unauthorised
    // caller that the data exists.
    if (!(await currentUserMaySeeUsMarket())) {
      return {
        quotes: {},
        // The value `batchQuoteSource([])` itself yields for an empty set, so
        // the refusal is indistinguishable from "the feed had nothing" and
        // there is no third spelling of this field. It reads DELAYED
        // downstream, never live — which is the safe direction for a payload
        // carrying no prices at all.
        source: "TIINGO",
        cacheHits: [],
        dbHits: [],
        upstreamHits: [],
        unresolved: [...symbols],
        asOfMs: null,
        fromCache: false,
        partial: false,
      };
    }
    return fetchUsQuotesUncached(symbols, exchange);
  }
  return fetchQuotesCached(symbols, exchange, { budgetMs });
}

export async function GET(request: NextRequest) {
  try {
    // Authenticate user or demo session
    const { userId } = await auth();
    const isDemo = !userId && (await isDemoSession());
    if (!userId && !isDemo) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const symbol = searchParams.get("symbol");
    const symbols = searchParams.get("symbols");
    const exchange = resolveQuoteExchange(searchParams.get("exchange"));

    // Require at least one of `symbol` / `symbols` up front (same 400 the
    // fall-through below returns; surfaced here so the contract is explicit).
    const paramCheck = validateSymbolParams(symbol, symbols);
    if (!paramCheck.valid) {
      return NextResponse.json({ error: paramCheck.error }, { status: 400 });
    }

    // Single symbol request
    if (symbol) {
      // `brokerStatus` is reported for client UI only (delayed-data disclaimer /
      // reconnect CTA). It no longer selects the data source — quotes are always
      // Yahoo (MONEY-837). It is resolved in parallel with the quote so its
      // (now cached) lookup never sits in front of the market data.
      const [result, brokerStatus] = await Promise.all([
        fetchForExchange([symbol], exchange, QUOTE_REQUEST_BUDGET_MS),
        getBrokerMarketDataStatus(),
      ]);

      const quotes = Object.values(result.quotes);
      const quote = quotes[0];
      if (!quote) {
        return NextResponse.json(
          { error: `Quote not found for ${symbol}` },
          { status: 404 }
        );
      }
      const source = result.source as QuoteResponseSource;
      return NextResponse.json(
        formatSingleQuoteResponse(
          quote,
          source,
          brokerStatus.status,
          buildMeta(result, source)
        )
      );
    }

    // Multiple symbols request
    if (symbols) {
      const symbolList = parseSymbolList(symbols);

      const emptyCheck = validateSymbolListNotEmpty(symbolList);
      if (!emptyCheck.valid) {
        return NextResponse.json({ error: emptyCheck.error }, { status: 400 });
      }

      const sizeCheck = validateSymbolListSize(symbolList);
      if (!sizeCheck.valid) {
        return NextResponse.json({ error: sizeCheck.error }, { status: 400 });
      }

      const [result, brokerStatus] = await Promise.all([
        fetchForExchange(symbolList, exchange, QUOTE_REQUEST_BUDGET_MS),
        getBrokerMarketDataStatus(),
      ]);

      const source = result.source as QuoteResponseSource;
      return NextResponse.json(
        formatMultiQuoteResponse(
          result.quotes,
          source,
          brokerStatus.status,
          buildMeta(result, source)
        )
      );
    }

    return NextResponse.json(
      { error: "Either 'symbol' or 'symbols' parameter is required" },
      { status: 400 }
    );
  } catch (error) {
    logger.error({ error }, "Quote API error");
    return NextResponse.json(
      { error: "Failed to fetch quote data" },
      { status: 500 }
    );
  }
}
