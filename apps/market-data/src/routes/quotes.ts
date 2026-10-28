/**
 * `GET /quotes` — the batch quote reader. MONEY-1469 (A4).
 *
 * Reads Redis and nothing else. There is no vendor call on this path and there
 * must never be one: the route it replaces
 * (`apps/web/app/api/market/quote`) falls through to Yahoo on a cold miss, and
 * that client retries 3 x 15 s with 1/2/4 s backoff — which is the entire p95
 * of 4.0 s. A miss here is answered as a MISS, named per symbol, in
 * milliseconds; the caller decides what to do about it.
 *
 * ## A PARTIAL ANSWER IS THE NORMAL ANSWER
 *
 * One unknown ticker in a twenty-symbol watchlist must not cost the other
 * nineteen their quotes, and it must not vanish silently either. `missing`
 * names every symbol with no usable quote, so a caller can fall back for
 * exactly those and for nothing else.
 */
import { Hono } from "hono";
import { readQuotes } from "@usemoney/core/market-data/quotes/quote-store";
import type { QuoteMarket } from "@usemoney/core/market-data/quotes/quote-logic";
import { CACHE_CONTROL } from "../app-logic";
import {
  parseQuoteRequest,
  MAX_QUOTE_SYMBOLS,
} from "@usemoney/core/market-data/quotes/quote-request";
import { recordQuoteBatch } from "../metrics";
import { checkMarketToken } from "../middleware/market-token";
import { tokenMayReadUs } from "../app-logic";

const quotes = new Hono();

quotes.get("/", async (c) => {
  // AUTHENTICATED. This route shipped with no auth at all, under only
  // requestId/secureHeaders/cors — and CORS is a browser policy, not access
  // control. The route it replaces (`apps/web/app/api/market/quote`) calls
  // `auth()` and, for US, `currentUserMaySeeUsMarket()`; serving the same data
  // from a public origin removed both.
  const auth = checkMarketToken(c.req.header("Authorization"));
  if (!auth.ok) {
    console.warn(`[market-data] quotes refused: ${auth.reason}`);
    return c.json({ s: "error", errmsg: "unauthorized" }, 401);
  }

  const parsed = parseQuoteRequest({
    symbols: c.req.query("symbols"),
    market: c.req.query("market"),
    exchange: c.req.query("exchange"),
  });
  if (!parsed.ok) {
    // 400, not an empty 200. An empty `data` for a malformed request looks
    // exactly like "none of your symbols have quotes", and a caller would
    // retry it forever.
    return c.json({ s: "error", errmsg: parsed.reason }, 400);
  }

  // THE US LICENCE, checked independently of anything else.
  //
  // `market=US` resolves to `rt:us:quote:<SYMBOL>` — the live Tiingo socket
  // keyspace. Tiingo Commercial is INTERNAL USE ONLY: ingest and storage are
  // fine, serving a US price to a user is redistribution and needs the $250/mo
  // plan (MONEY-1262). Without this, `…/quotes?symbols=AAPL&market=US`
  // returned live top-of-book to any caller holding any token.
  if (parsed.market === "US" && !tokenMayReadUs(auth.claims)) {
    return c.json(
      { s: "error", errmsg: "US market data is not available on this account" },
      403,
    );
  }

  const result = await readQuotes(
    parsed.market as QuoteMarket,
    parsed.listingIds,
  );

  // The response is keyed by WHAT THE CALLER ASKED FOR, not by the storage key.
  // A caller that sent `RELIANCE` must find `RELIANCE` in `data`; handing back
  // `RELIANCE:NSE` would make every lookup on the client miss while the payload
  // looked full.
  const asked = new Map(
    parsed.listingIds.map((id, i) => [id, parsed.requested[i]!]),
  );
  const data: Record<string, unknown> = {};
  for (const [listingId, quote] of Object.entries(result.quotes)) {
    data[asked.get(listingId) ?? listingId] = quote;
  }
  const missing = result.missing.map((id) => asked.get(id) ?? id);
  // AN OUTAGE IS NOT A UNIVERSE OF UNKNOWN TICKERS. Answering `s:"ok"` with
  // every symbol in `missing` tells the caller those symbols have no quotes —
  // and, once the flag is on, the poller has no way to tell that from a dead
  // Redis. 503 is retryable and says which it was.
  if (!result.available) {
    return c.json({ s: "error", errmsg: "quote store unavailable" }, 503);
  }

  recordQuoteBatch(parsed.market, result);

  c.header("Cache-Control", CACHE_CONTROL.quotes);
  return c.json({
    s: "ok",
    market: parsed.market,
    data,
    missing,
    // Counts on the RESPONSE, not only in a metric: a caller debugging a slow
    // watchlist can see the hit ratio without a Datadog query.
    hits: result.hits,
    misses: result.misses,
    stale: result.stale,
    limit: MAX_QUOTE_SYMBOLS,
  });
});

export default quotes;
