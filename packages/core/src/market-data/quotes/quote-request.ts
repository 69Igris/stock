/**
 * Parsing a `/quotes` request. MONEY-1469 (A4).
 *
 * Pure, and separate from the route, because every failure here is a 400 that
 * a caller has to be able to distinguish from an empty result — and because an
 * unbounded `symbols` list is the one input that turns a cheap read into an
 * expensive one.
 */
import type { QuoteMarket } from "./quote-logic";

/**
 * The ceiling on one batch.
 *
 * 100 because `MGET` is O(N) in one round trip and a watchlist is tens of
 * symbols; a caller asking for 5,000 is enumerating the universe, not rendering
 * a page. The request is REFUSED rather than TRUNCATED: a silently shortened
 * list returns a `missing` array that omits the symbols nobody looked up, which
 * is indistinguishable from "those have no quotes" and would send the caller
 * to a vendor for data that was never requested.
 */
export const MAX_QUOTE_SYMBOLS = 100;

/** The exchange assumed when a request names a bare India symbol. */
export const DEFAULT_IN_EXCHANGE = "NSE";

export type QuoteRequest =
  | {
      ok: true;
      market: QuoteMarket;
      /** Storage keys — `SYMBOL:EXCHANGE` for IN, a bare symbol for US. */
      listingIds: string[];
      /** What the caller ASKED for, in the same order, for the response map. */
      requested: string[];
    }
  | { ok: false; reason: string };

/**
 * `RELIANCE` -> `RELIANCE:NSE`; `RELIANCE:BSE` is left alone.
 *
 * THE EXCHANGE IS PART OF THE INDIA KEY, and this is not a detail. NSE and BSE
 * both list RELIANCE, at different prices, and `InstrumentMapping` is unique on
 * (symbol, exchange) precisely because they are two listings. A bare-symbol key
 * would have the two exchanges overwrite one another all night, and the last
 * writer would win silently.
 *
 * US is NOT given this treatment: its store is keyed by bare SYMBOL because
 * that is what the Tiingo socket holder already writes (`rt:us:quote:<SYMBOL>`)
 * and `quoteKey` strips anything after the colon for that market.
 */
export function toListingId(
  symbol: string,
  market: QuoteMarket,
  exchange: string,
): string {
  if (market === "US") return symbol;
  return symbol.includes(":") ? symbol : `${symbol}:${exchange}`;
}

export function parseQuoteRequest(input: {
  symbols?: string | null;
  market?: string | null;
  exchange?: string | null;
}): QuoteRequest {
  const market = (input.market ?? "IN").toUpperCase();
  if (market !== "IN" && market !== "US") {
    return {
      ok: false,
      reason: `unknown market ${market} (expected IN or US)`,
    };
  }
  const exchange =
    (input.exchange ?? DEFAULT_IN_EXCHANGE).trim().toUpperCase() ||
    DEFAULT_IN_EXCHANGE;

  const raw = (input.symbols ?? "").trim();
  if (!raw) return { ok: false, reason: "symbols is required" };

  // De-duplicated on the KEY, not on the request string: `RELIANCE` and
  // `RELIANCE:NSE` in one request are the same listing, and counting them twice
  // would skew the hit ratio the monitor watches.
  const byListing = new Map<string, string>();
  for (const part of raw.split(",")) {
    const s = part.trim().toUpperCase();
    if (!s) continue;
    const listingId = toListingId(s, market as QuoteMarket, exchange);
    if (!byListing.has(listingId)) byListing.set(listingId, s);
  }
  if (byListing.size === 0) return { ok: false, reason: "symbols is required" };
  if (byListing.size > MAX_QUOTE_SYMBOLS) {
    return {
      ok: false,
      reason: `too many symbols: ${byListing.size} > ${MAX_QUOTE_SYMBOLS}`,
    };
  }
  return {
    ok: true,
    market: market as QuoteMarket,
    listingIds: [...byListing.keys()],
    requested: [...byListing.values()],
  };
}
