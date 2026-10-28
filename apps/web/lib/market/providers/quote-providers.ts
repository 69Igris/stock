/**
 * Market-data quote provider seam (MONEY-566 → MONEY-837 → MONEY-1309).
 *
 * The web app's INDIA runtime market data is Yahoo-only. As of MONEY-837 the
 * Zerodha (Kite Connect) live-quote path was removed from `apps/web` entirely
 * and moved to the standalone Connect service (the paid Connect app key, the
 * WebSocket pool, and the redistributable live feed all live there now). This
 * module keeps ONE indirection point so a future feed plugs in as a single entry
 * in `resolveQuoteChain` — no route changes.
 *
 * MONEY-1309 is the first use of that seam. US venues resolve through
 * {@link tiingoUsQuoteProvider}, which reads OUR OWN two stores — the realtime
 * quote Redis keys the socket holder writes, and the `candles` EOD bars
 * `us-eod-sync` writes — and never the vendor. See
 * `@usemoney/core/market-data/tiingo/tiingo-rt-read`.
 *
 * ## The chain is now EXCHANGE-AWARE, and that is the whole fix
 *
 * `resolveQuoteChain()` used to take no argument because there was one provider.
 * With two markets in play the argument is load-bearing rather than cosmetic:
 * every India provider in here suffixes a symbol through `toYahooSymbol`, which
 * appends `.NS` to anything that is not BSE. Hand it a US ticker and it produces
 * `DOW.NS` — a real NSE-shaped symbol for a company that has never traded in
 * India — and Yahoo answers it with something. A wrong price is worse than no
 * price, so the split happens at chain construction, and `yahooQuoteProvider`
 * additionally REFUSES a US venue rather than trusting that it will never be
 * handed one.
 *
 * `isPublic` marks a provider whose data may be shared/cached cross-user (Yahoo
 * is exchange-delayed + license-clean). Any per-user/broker provider added here
 * later must be `isPublic:false` and must never be persisted to a shared cache
 * (the per-request quote path never does; shared caches are guarded by
 * `assertPublicPriceSource`).
 *
 * NOTE on Tiingo and `isPublic`: the US quotes are marked NOT public. We are on
 * Tiingo's COMMERCIAL plan, whose licence is INTERNAL USE ONLY — displaying US
 * prices to users is a redistribution act that needs the $250/mo redistribution
 * plan (MONEY-1262). The flag keeps these quotes out of any cross-user shared
 * cache while that stands; it is not a statement about the data's freshness.
 */

import { getQuote, getQuotes, type QuoteData } from "@/lib/market/yahoo-client";
import { toYahooSymbol } from "@/lib/market/symbol-mapper";
import {
  isUsExchange,
  normalizeUsExchange,
  type QuoteExchange,
} from "@/lib/market/quote-exchange";

export type QuoteSource = "yahoo" | "TIINGO_RT" | "TIINGO";

export interface QuoteProvider {
  name: QuoteSource;
  /** True if this provider's data may be shared/cached across users. */
  isPublic: boolean;
  /** Fetch one quote; null if this provider can't serve it. */
  fetchQuote(
    symbol: string,
    exchange: QuoteExchange
  ): Promise<QuoteData | null>;
  /** Fetch many; returns a (raw-symbol → quote) map, possibly partial/empty. */
  fetchQuotes(
    symbols: string[],
    exchange: QuoteExchange
  ): Promise<Map<string, QuoteData>>;
}

/** Public provider — Yahoo Finance (exchange-delayed; cacheable cross-user). */
export const yahooQuoteProvider: QuoteProvider = {
  name: "yahoo",
  isPublic: true,
  async fetchQuote(symbol, exchange) {
    // A US venue reaching here is a routing bug, and the failure it would cause
    // is silent: `toYahooSymbol("DOW", "NASDAQ")` returns `DOW.NS`, which is a
    // valid NSE symbol for a different company. Refusing is the only safe
    // answer — the chain then reports the symbol unresolved rather than wrong.
    if (isUsExchange(exchange)) return null;
    return getQuote(toYahooSymbol(symbol, exchange));
  },
  async fetchQuotes(symbols, exchange) {
    if (isUsExchange(exchange)) return new Map<string, QuoteData>();
    // getQuotes keys its result by the stripped base symbol (e.g. "RELIANCE"),
    // which equals the raw requested symbol — so the map aligns with the
    // requested symbols for a clean merge.
    return getQuotes(symbols.map((s) => toYahooSymbol(s, exchange)));
  },
};

/**
 * US provider — our own realtime keys with the EOD close behind them.
 *
 * ## Why ONE provider and not two chain entries
 *
 * The obvious shape is `[tiingoRtProvider, tiingoEodProvider]` and let
 * first-hit-wins pick. It is wrong here for a measured reason: a realtime quote
 * carries a bid/ask and NO previous close, so the EOD bars have to be read even
 * for the symbols Redis answered — otherwise `change` and `changePercent` are
 * unknowable and would be rendered as a flat zero, which reads as "unchanged"
 * rather than as "unknown". Two chain entries would issue that read twice.
 *
 * The cost of collapsing them is that the chain's single `name` can no longer
 * say which store answered. That is why each quote carries its OWN
 * `provenance` — which is strictly better than the envelope label anyway,
 * because a mixed batch (three symbols live, one on yesterday's close) has no
 * single honest answer at the envelope level. `batchQuoteSource` derives the
 * pessimistic envelope label from the per-quote truth.
 *
 * `import()`ed lazily, and that is about the INDIA path rather than about this
 * one. The US read pulls Prisma and the Redis singleton; a static import would
 * put both in the module graph of every `/api/market/quote?exchange=NSE`
 * request, which is the overwhelming majority and needs neither. The two
 * importers of this file are server-only today (`quote-cache.ts` and the quote
 * route), so this is a cold-start cost, not a bundling one.
 */
async function fetchUsQuotes(
  symbols: string[],
  exchange: QuoteExchange
): Promise<Map<string, QuoteData>> {
  const venue = normalizeUsExchange(exchange);
  const out = new Map<string, QuoteData>();
  if (venue === null || symbols.length === 0) return out;

  const { resolveUsQuotes } =
    await import("@usemoney/core/market-data/tiingo/tiingo-rt-read");
  const { quotes } = await resolveUsQuotes(symbols, venue);
  for (const [key, quote] of quotes) out.set(key, quote);
  return out;
}

export const tiingoUsQuoteProvider: QuoteProvider = {
  // The vendor, not the store. Per-quote `provenance.source` distinguishes
  // TIINGO_RT (a live quote) from TIINGO (the EOD close standing in for one).
  name: "TIINGO",
  // Commercial plan = internal use only. Never a shared cross-user cache.
  isPublic: false,
  async fetchQuote(symbol, exchange) {
    // Deliberately a module function and not `this.fetchQuotes` — a provider is
    // routinely pulled out of the chain array and called detached, and a `this`
    // that is `undefined` at that moment is a TypeError on a request path.
    const map = await fetchUsQuotes([symbol], exchange);
    return map.get(symbol.trim().toUpperCase()) ?? null;
  },
  fetchQuotes: fetchUsQuotes,
};

/**
 * Ordered provider chain for a quote request.
 *
 * India: Yahoo only (MONEY-837). US: our own stores (MONEY-1309), with NO Yahoo
 * behind them — a Yahoo fallback would re-introduce the `DOW.NS` collision the
 * refusal above exists to stop, and `resolveQuotesFromChain` would merge it in
 * under the same response key.
 */
export function resolveQuoteChain(
  exchange: QuoteExchange = "NSE"
): QuoteProvider[] {
  if (isUsExchange(exchange)) return [tiingoUsQuoteProvider];
  return [yahooQuoteProvider];
}

/**
 * Pure first-hit-wins walk over an EXPLICIT provider chain: the first provider
 * that returns a quote wins, and its name becomes the reported `source`. Kept
 * separate from chain construction so the resolution logic is unit-tested
 * directly with mock providers.
 */
export async function resolveQuoteFromChain(
  symbol: string,
  exchange: QuoteExchange,
  chain: QuoteProvider[]
): Promise<{ quote: QuoteData | null; source: QuoteSource }> {
  for (const provider of chain) {
    const quote = await provider.fetchQuote(symbol, exchange);
    if (quote) {
      return { quote, source: provider.name };
    }
  }
  // Nothing found — report the last provider as the (attempted) source.
  return { quote: null, source: chain[chain.length - 1]!.name };
}

/**
 * Fetch a single quote via the provider chain: the first provider that returns
 * a quote wins, and its name becomes the reported `source`.
 */
export async function fetchQuoteFederated(
  symbol: string,
  exchange: QuoteExchange
): Promise<{ quote: QuoteData | null; source: QuoteSource }> {
  return resolveQuoteFromChain(symbol, exchange, resolveQuoteChain(exchange));
}

/**
 * Pure merge walk over an EXPLICIT provider chain: each provider fills the
 * symbols still missing; the FIRST provider that returns anything sets the
 * primary `source`. Network-free given mock providers — `fetchQuotesFederated`
 * builds the chain and delegates here.
 */
export async function resolveQuotesFromChain(
  symbols: string[],
  exchange: QuoteExchange,
  chain: QuoteProvider[]
): Promise<{ quotes: Record<string, QuoteData>; source: QuoteSource }> {
  const quotes: Record<string, QuoteData> = {};
  let source: QuoteSource = chain[chain.length - 1]!.name;
  let primarySet = false;
  const remaining = new Set(symbols);

  for (const provider of chain) {
    if (remaining.size === 0) break;
    const map = await provider.fetchQuotes(Array.from(remaining), exchange);
    if (map.size === 0) continue;
    if (!primarySet) {
      source = provider.name;
      primarySet = true;
    }
    for (const [key, value] of map) {
      quotes[key] = value;
      remaining.delete(key);
    }
  }

  return { quotes, source };
}

/**
 * Fetch many quotes via the provider chain: each provider fills the symbols
 * still missing; the FIRST provider that returns anything sets the primary
 * `source`.
 */
export async function fetchQuotesFederated(
  symbols: string[],
  exchange: QuoteExchange
): Promise<{ quotes: Record<string, QuoteData>; source: QuoteSource }> {
  return resolveQuotesFromChain(symbols, exchange, resolveQuoteChain(exchange));
}
