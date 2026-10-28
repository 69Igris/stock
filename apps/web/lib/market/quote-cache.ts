/**
 * Symbol-keyed quote cache — production wiring (MONEY-1124).
 *
 * Builds the real {@link QuoteCachePorts} for `./quote-cache-logic.ts`:
 *
 *   1. shared cache  — `getCached`/`setCached` on the `"market"` module with a
 *                      15s TTL override, ONE ENTRY PER SYMBOL under the
 *                      `_global` scope (Yahoo data is exchange-delayed and not
 *                      user-specific, so cross-user sharing is licence-safe —
 *                      see `providers/quote-providers.ts#yahooQuoteProvider`);
 *   2. LatestQuote   — the DB rows `lib/market/data-manager.ts` already
 *                      maintains at ~60s freshness, which the quote route used
 *                      to bypass entirely;
 *   3. Yahoo         — the existing provider chain, unchanged.
 *
 * All three legs are wrapped so they resolve rather than throw: the route's
 * fail-open contract (an unresolvable symbol is simply absent from the payload)
 * is preserved end to end.
 */

import { getCached, setCached } from "@usemoney/core";
import { prisma } from "@usemoney/database";
import { apiLogger as logger } from "@usemoney/logger";

import { toYahooSymbol, type Exchange } from "@/lib/market/symbol-mapper";
import { extractSymbol, type QuoteData } from "@/lib/market/yahoo-client-logic";
import { getQuotesByInstrumentIds } from "@/lib/market/yahoo-client";
import {
  fetchQuotesFederated,
  type QuoteSource,
} from "@/lib/market/providers/quote-providers";
import type { QuoteExchange } from "@/lib/market/quote-exchange";
import { batchQuoteSource } from "@usemoney/core/market-data/tiingo/tiingo-rt-read-logic";
import {
  QUOTE_CACHE_TTL_MS,
  QUOTE_CACHE_TTL_SECONDS,
  QUOTE_REQUEST_BUDGET_MS,
  quoteCacheIdentifier,
  resolveQuotesCached,
  toEpochMs,
  withBudget,
  type CachedQuoteEnvelope,
  type QuoteCachePorts,
  type QuoteCacheResult,
} from "@/lib/market/quote-cache-logic";

/** Cache scope for the shared, cross-user quote entries. */
const CACHE_SCOPE = "_global";

/**
 * Freshness the DB leg demands of a `LatestQuote` row.
 *
 * Deliberately the same 60s the DB layer has always used, so this change does
 * not quietly alter what "cached quote" means anywhere else. Worst-case age of
 * a price the route can return is therefore ~15s (shared cache) + ~60s (DB) =
 * ~75s on top of Yahoo's own ~15-minute exchange delay — which is why the
 * response reports `asOf` from the quote's own market timestamp rather than
 * from the time the response was built.
 */
const DB_QUOTE_TTL_MS = 60_000;

/**
 * Read the shared cache for a batch of request symbols.
 *
 * `getCached` is per-key, so this is N parallel lookups — cheap, because layer
 * 1 is an in-process map and only true L1 misses reach Redis. Any failure
 * degrades to "miss".
 */
async function readSharedCache(
  symbols: string[],
  exchange: Exchange
): Promise<Map<string, CachedQuoteEnvelope<QuoteData>>> {
  const found = new Map<string, CachedQuoteEnvelope<QuoteData>>();

  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const hit = await getCached<CachedQuoteEnvelope<QuoteData>>(
          "market",
          CACHE_SCOPE,
          quoteCacheIdentifier(exchange, symbol),
          undefined,
          { ttl: QUOTE_CACHE_TTL_SECONDS }
        );
        return [symbol, hit] as const;
      } catch {
        return [symbol, null] as const;
      }
    })
  );

  for (const [symbol, hit] of entries) {
    // Guard the deserialised shape: a Redis round trip turns Dates into ISO
    // strings, and a schema change could leave older envelopes in place.
    if (hit && typeof hit.cachedAt === "number" && hit.quote && hit.key) {
      found.set(symbol, hit);
    }
  }

  return found;
}

/** Write resolved quotes back, one entry per symbol. Best-effort. */
async function writeSharedCache(
  entries: Array<{ symbol: string; envelope: CachedQuoteEnvelope<QuoteData> }>,
  exchange: Exchange
): Promise<void> {
  await Promise.all(
    entries.map(async ({ symbol, envelope }) => {
      try {
        await setCached(
          "market",
          CACHE_SCOPE,
          quoteCacheIdentifier(exchange, symbol),
          envelope,
          undefined,
          { ttl: QUOTE_CACHE_TTL_SECONDS }
        );
      } catch {
        // A failed write only costs the next request a miss.
      }
    })
  );
}

/**
 * Resolve request symbols from the `LatestQuote` DB rows.
 *
 * Both queries are bounded (`{ symbol: { in: … } }` / `{ id: { in: … } }`) —
 * MONEY-704. `getQuotesByInstrumentIds` applies the DB TTL internally and
 * refreshes + upserts anything stale in ONE batched Yahoo call, so a stale row
 * costs the same upstream round trip the route would have made anyway while
 * warming the row for every other user.
 *
 * Returns a map keyed by REQUEST symbol. Never throws.
 *
 * NOTE for reviewers: a symbol that HAS an InstrumentMapping row but whose
 * refresh returned nothing (Yahoo down, or a wrong stored `yahooSymbol`) is not
 * returned here, so the resolver hands it to the upstream leg — which retries
 * it under `toYahooSymbol()` instead of the stored mapping. That is deliberate:
 * it is exactly today's behaviour as the LAST resort, and it recovers symbols
 * whose stored mapping is wrong. The cost is one extra Yahoo batch during an
 * outage, bounded by the request budget.
 */
async function readLatestQuoteRows(
  symbols: string[],
  exchange: Exchange
): Promise<Map<string, QuoteData>> {
  const resolved = new Map<string, QuoteData>();
  if (symbols.length === 0) return resolved;

  try {
    // Request symbol → the form stored in InstrumentMapping.
    const bySymbol = new Map<string, string[]>();
    for (const symbol of symbols) {
      const upper = symbol.toUpperCase();
      const list = bySymbol.get(upper);
      if (list) list.push(symbol);
      else bySymbol.set(upper, [symbol]);
    }

    const instruments = await prisma.instrumentMapping.findMany({
      where: { symbol: { in: Array.from(bySymbol.keys()) }, exchange },
      select: { id: true, symbol: true },
    });
    if (instruments.length === 0) return resolved;

    const dbQuotes = await getQuotesByInstrumentIds(
      instruments.map((i) => i.id),
      DB_QUOTE_TTL_MS
    );
    if (dbQuotes.size === 0) return resolved;

    for (const instrument of instruments) {
      const quote = dbQuotes.get(instrument.id);
      if (!quote) continue;
      for (const requested of bySymbol.get(instrument.symbol.toUpperCase()) ??
        []) {
        resolved.set(requested, quote);
      }
    }
  } catch (error) {
    // DB unavailable / slow → fall through to the upstream leg (fail-open).
    logger.warn({ error }, "[quote-cache] LatestQuote lookup failed");
    return new Map();
  }

  return resolved;
}

/** Upstream provider chain (Yahoo). Never throws. */
async function readUpstreamQuotes(
  symbols: string[],
  exchange: Exchange
): Promise<{ quotes: Map<string, QuoteData>; source: string }> {
  try {
    const { quotes, source } = await fetchQuotesFederated(symbols, exchange);
    return { quotes: new Map(Object.entries(quotes)), source };
  } catch (error) {
    logger.warn({ error }, "[quote-cache] upstream quote fetch failed");
    return { quotes: new Map(), source: "yahoo" };
  }
}

/** Build the production ports for one request. */
export function buildQuoteCachePorts(
  exchange: Exchange
): QuoteCachePorts<QuoteData> {
  return {
    readCache: (symbols) => readSharedCache(symbols, exchange),
    writeCache: (entries) => writeSharedCache(entries, exchange),
    readDb: (symbols) => readLatestQuoteRows(symbols, exchange),
    readUpstream: (symbols) => readUpstreamQuotes(symbols, exchange),
    // Mirrors how `getQuotes` keys its result today (`extractSymbol` of the
    // Yahoo symbol), so a cache/DB hit is byte-identical to a live fetch —
    // including index aliases, where NIFTY is emitted under ^NSEI.
    responseKey: (symbol) => extractSymbol(toYahooSymbol(symbol, exchange)),
    quotedAtMs: (quote) => toEpochMs(quote.timestamp),
    now: () => Date.now(),
  };
}

export type CachedQuotesResult = QuoteCacheResult<QuoteData> & {
  source: QuoteSource;
};

/**
 * Fetch quotes for `symbols` through cache → LatestQuote → Yahoo, inside a
 * whole-request time budget.
 *
 * Drop-in replacement for `fetchQuotesFederated` on the request path: the
 * `quotes` record is keyed identically, and an unresolvable symbol is still
 * simply absent (fail-open) rather than an error.
 */
export async function fetchQuotesCached(
  symbols: string[],
  exchange: Exchange,
  options: { budgetMs?: number; ttlMs?: number } = {}
): Promise<CachedQuotesResult> {
  const result = await resolveQuotesCached(
    symbols,
    buildQuoteCachePorts(exchange),
    {
      ttlMs: options.ttlMs ?? QUOTE_CACHE_TTL_MS,
      budgetMs: options.budgetMs ?? QUOTE_REQUEST_BUDGET_MS,
      fallbackSource: "yahoo",
    }
  );

  // Every leg of THIS function's chain is Yahoo-derived — LatestQuote rows are
  // written with `source: "YAHOO"` and `resolveQuoteChain("NSE"|"BSE")` returns
  // Yahoo alone. The US chain does NOT come through here; see
  // {@link fetchUsQuotesUncached} for why.
  return { ...result, source: "yahoo" };
}

/**
 * Fetch US quotes — provider chain only, NO shared cache layer.
 *
 * Deliberately not `fetchQuotesCached`. Three reasons, in order of how much
 * they cost if ignored:
 *
 *   1. LICENCE. The shared cache is keyed under the `_global` scope precisely
 *      so 40 users holding RELIANCE share one entry, and that is safe only
 *      because Yahoo's India feed is `isPublic`. Tiingo's Commercial plan is
 *      INTERNAL USE ONLY (MONEY-1262), so `tiingoUsQuoteProvider.isPublic` is
 *      false and its quotes must not land in a cross-user store.
 *   2. IT WOULD CACHE A CACHE. The realtime quote already lives in Redis — that
 *      is the entire read path. Copying it into a second Redis entry with its
 *      own 15s TTL adds a staleness layer on top of a store that is already
 *      the freshest thing we have.
 *   3. THE KEY WOULD BE WRONG. `buildQuoteCachePorts.responseKey` is
 *      `extractSymbol(toYahooSymbol(symbol, exchange))`, and `toYahooSymbol`
 *      suffixes anything that is not BSE with `.NS`. It happens to round-trip
 *      back to the bare ticker for a US symbol, which is exactly the kind of
 *      accidental correctness that stops being correct the first time someone
 *      touches either function.
 *
 * ## It KEEPS the whole-request budget
 *
 * The budget is not a Yahoo-specific device. The US read is one Redis `mget`
 * plus up to a dozen bounded Mongo queries, all of which are fast until one of
 * them is not — neither `getCandles` nor an in-flight ioredis command carries a
 * client-side deadline of its own, so a wedged store would hold the request
 * until the platform timeout with the user's tab on a spinner. `withBudget`
 * bounds it and reports `partial`, which keeps that field's documented meaning
 * ("the time budget elapsed") the same in both markets.
 *
 * The shape matches {@link CachedQuotesResult} so the route treats both markets
 * identically. `fromCache` is false and `cacheHits` empty by construction, and
 * an unresolvable symbol is reported by ABSENCE (in `unresolved`, not in
 * `partial`) exactly as the India resolver reports one.
 */
export async function fetchUsQuotesUncached(
  symbols: string[],
  exchange: QuoteExchange,
  options: { budgetMs?: number } = {}
): Promise<CachedQuotesResult> {
  // `withBudget` pre-catches the raced promise, so a rejection lands as the
  // fallback rather than as an unhandled rejection — the fail-open contract the
  // India path has: unresolved symbols are simply absent from `data`.
  const raced = await withBudget(
    fetchQuotesFederated(symbols, exchange).catch((error: unknown) => {
      logger.warn({ error }, "[quote-cache] US quote fetch failed");
      return { quotes: {} as Record<string, QuoteData>, source: "TIINGO" };
    }),
    options.budgetMs ?? QUOTE_REQUEST_BUDGET_MS,
    { quotes: {} as Record<string, QuoteData>, source: "TIINGO" }
  );
  const quotes = raced.value.quotes;

  // The chain's own `source` is the PROVIDER name ("TIINGO", the vendor whose
  // two stores answered) and cannot distinguish a live quote from an EOD close
  // — one provider serves both. The envelope label is therefore derived from
  // the per-quote provenance, pessimistically: a batch counts as live only when
  // every quote in it is. That is what makes `delayed` on the response, and the
  // disclaimer the UI renders from it, true of the whole payload rather than of
  // its luckiest member.
  const source: QuoteSource = batchQuoteSource(Object.values(quotes));

  const resolvedKeys = new Set(Object.keys(quotes));
  const unresolved = symbols.filter(
    (s) => !resolvedKeys.has(s.trim().toUpperCase())
  );

  let asOfMs: number | null = null;
  for (const quote of Object.values(quotes)) {
    const ms = toEpochMs(quote.timestamp);
    if (ms === null) continue;
    if (asOfMs === null || ms < asOfMs) asOfMs = ms;
  }

  return {
    quotes,
    source,
    cacheHits: [],
    dbHits: [],
    upstreamHits: Object.keys(quotes),
    unresolved,
    asOfMs,
    fromCache: false,
    partial: raced.timedOut,
  };
}
