/**
 * Quote Service - Latest Quotes with DB Cache
 *
 * Manages the LatestQuote table as a cache layer for real-time quotes.
 * Quotes older than the configured TTL are refreshed from Yahoo Finance.
 *
 * Like yahoo-price-service, this module uses dependency injection for
 * the actual Yahoo Finance API calls.
 */

import { prisma } from "@usemoney/database";
import { isUnfetchableYahooSymbol } from "../instruments/types";
import {
  isFresh,
  shouldFetchFromApi,
  isWriteConflictError,
  calcBackoff,
  chunkIds,
  queryByIdChunks,
  runWithWriteConflictRetry,
  UPSERT_MAX_RETRIES,
  REFRESH_MAX_RETRIES,
  UPSERT_BACKOFF_BASE_MS,
  REFRESH_BACKOFF_BASE_MS,
  UPSERT_BATCH_SIZE,
} from "./quote-logic";
// MONEY-1469 (A4) — the write-through. NOTE the two `quote-logic` modules are
// different files: `prices/quote-logic` is this service's retry/backoff rules,
// `quotes/quote-logic` is the Redis quote contract.
import { writeQuote, writeQuotes } from "../quotes/quote-store";
import type { StoredQuote } from "../quotes/quote-logic";

/**
 * Keep only the finite numbers, so an absent optional stays ABSENT.
 *
 * Yahoo returns `null` for fields it has no value for, and `StoredQuote` says a
 * missing `change` is unknown rather than zero. Spreading nulls in would store
 * `"change": null`, which decodes back to undefined anyway but costs bytes on
 * every key and invites a reader to treat null as a value.
 */
function finiteFields(
  fields: Record<string, number | null | undefined>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Latest quote data (matches the LatestQuote model shape).
 */
export interface QuoteData {
  instrumentId: string;
  price: number;
  change?: number;
  changePercent?: number;
  open?: number;
  high?: number;
  low?: number;
  previousClose?: number;
  volume?: number;
  marketCap?: number;
  /**
   * MONEY-1255 — see the same four on {@link YahooQuoteData}. They are here so
   * a cache HIT reconstructs the whole quote rather than a subset of it.
   */
  pe?: number;
  eps?: number;
  week52High?: number;
  week52Low?: number;
  timestamp: Date;
  source: string;
}

/**
 * Raw quote fetched from Yahoo Finance (injected function return type).
 */
export interface YahooQuoteData {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  marketCap?: number;
  /**
   * Trailing twelve-month P/E and EPS, and the 52-week window — MONEY-1255.
   *
   * Optional because they are legitimately absent: a loss-making company has
   * no trailing P/E, and the 52-week pair is dropped WHOLESALE by the caller's
   * containment guard (`sane52WeekRange`) when the reported window cannot
   * contain prices we can already see. `undefined` means "not established" and
   * must never be coerced to 0 — that would be a factual claim about the
   * company that a screen would act on.
   *
   * These live on this transport type so `LatestQuote` can round-trip them. A
   * cache row that stores a strict SUBSET of the type it caches degrades every
   * reader that HITS it, which is the defect this field set closes.
   */
  pe?: number;
  eps?: number;
  week52High?: number;
  week52Low?: number;
  timestamp: Date;
}

/**
 * Fetch function type for single quotes - injected by the caller.
 */
export type YahooQuoteFetcher = (
  yahooSymbol: string,
) => Promise<YahooQuoteData | null>;

/**
 * Fetch function type for batch quotes - injected by the caller.
 */
export type YahooBatchQuoteFetcher = (
  yahooSymbols: string[],
) => Promise<Map<string, YahooQuoteData>>;

/** Default cache TTL in milliseconds (60 seconds) */
const DEFAULT_QUOTE_TTL_MS = 60 * 1000;

/**
 * `instrumentId` -> `SYMBOL:EXCHANGE`, memoised on a DETERMINATE answer only.
 *
 * The Redis quote key is keyed by LISTING, because the reader is handed a
 * symbol and an exchange and has no Mongo id to look up. A THROW is "we could
 * not find out" and is NOT cached — memoising it would pin a symbol to
 * "uncacheable" for the life of a warm container.
 */
const quoteListingCache = new Map<string, string | null>();

async function listingIdFor(instrumentId: string): Promise<string | null> {
  const hit = quoteListingCache.get(instrumentId);
  if (hit !== undefined) return hit;
  try {
    const row = await prisma.instrumentMapping.findUnique({
      where: { id: instrumentId },
      select: { symbol: true, exchange: true },
    });
    const listingId = row ? `${row.symbol}:${row.exchange}` : null;
    quoteListingCache.set(instrumentId, listingId);
    return listingId;
  } catch {
    return null;
  }
}

/**
 * Write one freshly-fetched quote THROUGH to Redis. MONEY-1469 (A4).
 *
 * ## WHY THE REQUEST PATH NEEDS THIS AND NOT JUST THE NIGHTLY SWEEP
 *
 * The write-through was wired to `refreshAllQuotes` alone — and that is the one
 * caller that never pays the cost this ticket measures. A cold symbol fetched
 * on the REQUEST path updated Mongo and not Redis, so the Yahoo round trip just
 * paid for (3 x 15s retries with 1/2/4s backoff) was discarded and the next
 * 5-second poll missed again.
 *
 * It gets worse once the flag flips: `/quotes` reads Redis ONLY. Any symbol the
 * nightly sweep did not cover — a new listing, one outside `QUOTABLE_TYPES`,
 * one whose 24-hour TTL lapsed after a failed run — would render with no price
 * and no error until the next sweep.
 *
 * NEVER THROWS. A cache write that fails must not fail the read it rode in on.
 */
async function cacheQuoteWriteThrough(
  instrumentId: string,
  data: {
    price: number;
    change?: number | null;
    changePercent?: number | null;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    previousClose?: number | null;
    volume?: number | null;
    timestamp: Date;
  },
): Promise<void> {
  try {
    if (!Number.isFinite(data.price)) return;
    const listingId = await listingIdFor(instrumentId);
    // A quote we cannot KEY is not written under a guess — a wrong listing id
    // files another company's price under this symbol.
    if (!listingId) return;
    await writeQuote("IN", listingId, {
      price: data.price,
      ts: data.timestamp.getTime(),
      source: "YAHOO",
      ...finiteFields({
        change: data.change,
        changePct: data.changePercent,
        open: data.open,
        high: data.high,
        low: data.low,
        prevClose: data.previousClose,
        volume: data.volume,
      }),
    });
  } catch {
    // Deliberately silent: the caller already has its price.
  }
}

/**
 * Get the latest quote for an instrument, using DB cache.
 *
 * Flow:
 * 1. Check LatestQuote table (if < TTL old, return cached)
 * 2. Fetch from Yahoo Finance
 * 3. Upsert into LatestQuote
 * 4. Return
 *
 * @param instrumentId - The InstrumentMapping ObjectId
 * @param fetchQuote - Injected Yahoo fetch function
 * @param ttlMs - Cache TTL in milliseconds (default: 60s)
 */
export async function getLatestQuote(
  instrumentId: string,
  fetchQuote: YahooQuoteFetcher,
  ttlMs: number = DEFAULT_QUOTE_TTL_MS,
): Promise<QuoteData | null> {
  // 1. Check DB cache
  const cached = await prisma.latestQuote.findUnique({
    where: { instrumentId },
  });

  // !shouldFetchFromApi(cached, ttlMs) === (cached && isFresh(...)): a null
  // cache always needs a fetch; otherwise serve it only while still fresh.
  // The leading `cached &&` is runtime-redundant (shouldFetchFromApi(null) is
  // always true) but narrows `cached` to non-null for the serve-from-cache body.
  if (cached && !shouldFetchFromApi(cached, ttlMs)) {
    return {
      instrumentId: cached.instrumentId,
      price: cached.price,
      change: cached.change ?? undefined,
      changePercent: cached.changePercent ?? undefined,
      open: cached.open ?? undefined,
      high: cached.high ?? undefined,
      low: cached.low ?? undefined,
      previousClose: cached.previousClose ?? undefined,
      volume: cached.volume ?? undefined,
      marketCap: cached.marketCap ?? undefined,
      pe: cached.pe ?? undefined,
      eps: cached.eps ?? undefined,
      week52High: cached.week52High ?? undefined,
      week52Low: cached.week52Low ?? undefined,
      timestamp: cached.timestamp,
      source: cached.source,
    };
  }

  // 2. Get Yahoo symbol
  const instrument = await prisma.instrumentMapping.findUnique({
    where: { id: instrumentId },
    select: { yahooSymbol: true },
  });

  if (!instrument?.yahooSymbol) {
    return cached
      ? {
          instrumentId: cached.instrumentId,
          price: cached.price,
          change: cached.change ?? undefined,
          changePercent: cached.changePercent ?? undefined,
          open: cached.open ?? undefined,
          high: cached.high ?? undefined,
          low: cached.low ?? undefined,
          previousClose: cached.previousClose ?? undefined,
          volume: cached.volume ?? undefined,
          marketCap: cached.marketCap ?? undefined,
          pe: cached.pe ?? undefined,
          eps: cached.eps ?? undefined,
          week52High: cached.week52High ?? undefined,
          week52Low: cached.week52Low ?? undefined,
          timestamp: cached.timestamp,
          source: cached.source,
        }
      : null;
  }

  // 3. Fetch from Yahoo
  const yahooData = await fetchQuote(instrument.yahooSymbol);

  if (!yahooData) {
    return cached
      ? {
          instrumentId: cached.instrumentId,
          price: cached.price,
          change: cached.change ?? undefined,
          changePercent: cached.changePercent ?? undefined,
          open: cached.open ?? undefined,
          high: cached.high ?? undefined,
          low: cached.low ?? undefined,
          previousClose: cached.previousClose ?? undefined,
          volume: cached.volume ?? undefined,
          marketCap: cached.marketCap ?? undefined,
          pe: cached.pe ?? undefined,
          eps: cached.eps ?? undefined,
          week52High: cached.week52High ?? undefined,
          week52Low: cached.week52Low ?? undefined,
          timestamp: cached.timestamp,
          source: cached.source,
        }
      : null;
  }

  // 4. Upsert into DB
  const upserted = await prisma.latestQuote.upsert({
    where: { instrumentId },
    create: {
      instrumentId,
      price: yahooData.price,
      change: yahooData.change,
      changePercent: yahooData.changePercent,
      open: yahooData.open,
      high: yahooData.high,
      low: yahooData.low,
      previousClose: yahooData.previousClose,
      volume: yahooData.volume,
      marketCap: yahooData.marketCap,
      pe: yahooData.pe ?? null,
      eps: yahooData.eps ?? null,
      week52High: yahooData.week52High ?? null,
      week52Low: yahooData.week52Low ?? null,
      timestamp: yahooData.timestamp,
      source: "YAHOO",
    },
    update: {
      price: yahooData.price,
      change: yahooData.change,
      changePercent: yahooData.changePercent,
      open: yahooData.open,
      high: yahooData.high,
      low: yahooData.low,
      previousClose: yahooData.previousClose,
      volume: yahooData.volume,
      marketCap: yahooData.marketCap,
      pe: yahooData.pe ?? null,
      eps: yahooData.eps ?? null,
      week52High: yahooData.week52High ?? null,
      week52Low: yahooData.week52Low ?? null,
      timestamp: yahooData.timestamp,
    },
  });

  // MONEY-1469 (A4) — write THROUGH, so the vendor round trip just paid for is
  // not discarded. See `cacheQuoteWriteThrough`.
  await cacheQuoteWriteThrough(instrumentId, {
    price: upserted.price,
    change: upserted.change,
    changePercent: upserted.changePercent,
    open: upserted.open,
    high: upserted.high,
    low: upserted.low,
    previousClose: upserted.previousClose,
    volume: upserted.volume,
    timestamp: upserted.timestamp,
  });

  return {
    instrumentId: upserted.instrumentId,
    price: upserted.price,
    change: upserted.change ?? undefined,
    changePercent: upserted.changePercent ?? undefined,
    open: upserted.open ?? undefined,
    high: upserted.high ?? undefined,
    low: upserted.low ?? undefined,
    previousClose: upserted.previousClose ?? undefined,
    volume: upserted.volume ?? undefined,
    marketCap: upserted.marketCap ?? undefined,
    timestamp: upserted.timestamp,
    source: upserted.source,
  };
}

/**
 * Get latest quotes for multiple instruments in batch.
 * Fetches from DB cache first, then fills missing from Yahoo.
 *
 * @param instrumentIds - Array of InstrumentMapping ObjectIds
 * @param fetchQuotes - Injected Yahoo batch fetch function
 * @param ttlMs - Cache TTL in milliseconds (default: 60s)
 */
export async function getLatestQuotes(
  instrumentIds: string[],
  fetchQuotes: YahooBatchQuoteFetcher,
  ttlMs: number = DEFAULT_QUOTE_TTL_MS,
): Promise<Map<string, QuoteData>> {
  const results = new Map<string, QuoteData>();

  if (instrumentIds.length === 0) return results;

  // 1. Fetch the cached quotes for EXACTLY these instruments (MONEY-704).
  //
  // This was `findMany({})` + an in-memory `.filter()`, justified by a comment
  // claiming Prisma compiles `{ in: [...] }` into `$expr` with N `$eq`
  // comparisons and therefore a COLLSCAN. That is not how the Prisma MongoDB
  // connector compiles `in` — it emits a plain `$in`, and `LatestQuote.
  // instrumentId` is `@unique` (schema.prisma), so this is an index lookup over
  // a bounded id list. The old shape read EVERY row in `latest_quotes` (the
  // whole tradable universe) on every call to serve at most 50 ids. The
  // heatmap/sector code already uses this exact pattern — see
  // `packages/services/src/discover.service.ts#fetchStocksBySector`.
  const cachedQuotes = await queryByIdChunks(instrumentIds, (chunk) =>
    prisma.latestQuote.findMany({ where: { instrumentId: { in: chunk } } }),
  );

  const staleIds: string[] = [];

  for (const cached of cachedQuotes) {
    if (isFresh(cached.updatedAt, ttlMs)) {
      results.set(cached.instrumentId, {
        instrumentId: cached.instrumentId,
        price: cached.price,
        change: cached.change ?? undefined,
        changePercent: cached.changePercent ?? undefined,
        open: cached.open ?? undefined,
        high: cached.high ?? undefined,
        low: cached.low ?? undefined,
        previousClose: cached.previousClose ?? undefined,
        volume: cached.volume ?? undefined,
        marketCap: cached.marketCap ?? undefined,
        pe: cached.pe ?? undefined,
        eps: cached.eps ?? undefined,
        week52High: cached.week52High ?? undefined,
        week52Low: cached.week52Low ?? undefined,
        timestamp: cached.timestamp,
        source: cached.source,
      });
    } else {
      staleIds.push(cached.instrumentId);
    }
  }

  // Find IDs that aren't cached at all
  const cachedSet = new Set(cachedQuotes.map((q) => q.instrumentId));
  const missingIds = instrumentIds.filter((id) => !cachedSet.has(id));
  const idsToFetch = [...staleIds, ...missingIds];

  if (idsToFetch.length === 0) return results;

  // 2. Get Yahoo symbols for instruments that need refreshing (MONEY-704).
  // Same story as step 1: bounded `{ id: { in: … } }` on the primary key,
  // not a full read of `instrument_mappings` followed by a JS filter.
  const instruments = await queryByIdChunks(idsToFetch, (chunk) =>
    prisma.instrumentMapping.findMany({
      where: { id: { in: chunk } },
      select: { id: true, yahooSymbol: true },
    }),
  );

  const yahooSymbols = instruments
    .filter((i) => i.yahooSymbol)
    .map((i) => i.yahooSymbol);

  const idByYahoo = new Map(instruments.map((i) => [i.yahooSymbol, i.id]));

  if (yahooSymbols.length === 0) return results;

  // 3. Batch fetch from Yahoo
  const yahooQuotes = await fetchQuotes(yahooSymbols);

  // 4. Upsert each fetched quote (MONEY-1124: batched, not one-at-a-time).
  //
  // This used to `await` one upsert per symbol in sequence, so a 50-symbol
  // portfolio serialised 50 Mongo round trips on the REQUEST path. It now runs
  // in `UPSERT_BATCH_SIZE` groups via Promise.allSettled: per-symbol failure
  // isolation is preserved exactly (each task still owns its write-conflict
  // retry and still swallows its own error), only the ordering changed.
  const pending = Array.from(yahooQuotes.entries()).filter(([yahooSymbol]) =>
    idByYahoo.has(yahooSymbol),
  );

  const upsertOne = async ([
    yahooSymbol,
    yahooData,
  ]: (typeof pending)[number]) => {
    const instrumentId = idByYahoo.get(yahooSymbol)!;

    // Retry on write conflict (may race with refreshAllQuotes worker).
    // runWithWriteConflictRetry retries only on transient conflicts and resolves
    // success:false on exhaustion (does not throw). Any other error rethrows.
    //
    // MONEY-1238 — the result MUST be bound. It was awaited and discarded, and
    // an exhausted retry is the one failure on this path that leaves no trace
    // anywhere: `runWithWriteConflictRetry` deliberately does not throw, so the
    // `catch` below never fires, `Promise.allSettled` records `fulfilled`, and
    // the only other evidence is an ABSENCE — `results.set(...)` lives inside
    // `fn`, after the upsert, so the symbol is quietly missing from the map the
    // caller returns. A stale price and a never-written one look identical to
    // every reader downstream.
    try {
      const outcome = await runWithWriteConflictRetry(
        async () => {
          const upserted = await prisma.latestQuote.upsert({
            where: { instrumentId },
            create: {
              instrumentId,
              price: yahooData.price,
              change: yahooData.change,
              changePercent: yahooData.changePercent,
              open: yahooData.open,
              high: yahooData.high,
              low: yahooData.low,
              previousClose: yahooData.previousClose,
              volume: yahooData.volume,
              marketCap: yahooData.marketCap,
              pe: yahooData.pe ?? null,
              eps: yahooData.eps ?? null,
              week52High: yahooData.week52High ?? null,
              week52Low: yahooData.week52Low ?? null,
              timestamp: yahooData.timestamp,
              source: "YAHOO",
            },
            update: {
              price: yahooData.price,
              change: yahooData.change,
              changePercent: yahooData.changePercent,
              open: yahooData.open,
              high: yahooData.high,
              low: yahooData.low,
              previousClose: yahooData.previousClose,
              volume: yahooData.volume,
              marketCap: yahooData.marketCap,
              pe: yahooData.pe ?? null,
              eps: yahooData.eps ?? null,
              week52High: yahooData.week52High ?? null,
              week52Low: yahooData.week52Low ?? null,
              timestamp: yahooData.timestamp,
            },
          });

          // MONEY-1469 (A4) — write THROUGH. Same reason as `getLatestQuote`:
          // this is a REQUEST-path fetch, so it is exactly the Yahoo round trip
          // the ticket exists to stop repeating.
          await cacheQuoteWriteThrough(instrumentId, {
            price: upserted.price,
            change: upserted.change,
            changePercent: upserted.changePercent,
            open: upserted.open,
            high: upserted.high,
            low: upserted.low,
            previousClose: upserted.previousClose,
            volume: upserted.volume,
            timestamp: upserted.timestamp,
          });

          results.set(instrumentId, {
            instrumentId: upserted.instrumentId,
            price: upserted.price,
            change: upserted.change ?? undefined,
            changePercent: upserted.changePercent ?? undefined,
            open: upserted.open ?? undefined,
            high: upserted.high ?? undefined,
            low: upserted.low ?? undefined,
            previousClose: upserted.previousClose ?? undefined,
            volume: upserted.volume ?? undefined,
            marketCap: upserted.marketCap ?? undefined,
            timestamp: upserted.timestamp,
            source: upserted.source,
          });
        },
        {
          maxRetries: UPSERT_MAX_RETRIES,
          backoffBaseMs: UPSERT_BACKOFF_BASE_MS,
        },
      );

      if (!outcome.success) {
        // Same severity as a thrown upsert error, because it IS one — the
        // write did not land and this instrument is absent from `results`.
        console.error(
          `Failed to upsert quote for ${yahooSymbol}: write conflict not ` +
            `resolved after ${outcome.attempts} attempt(s) — LatestQuote for ` +
            `instrument ${instrumentId} was NOT written`,
        );
      }
    } catch (error) {
      console.error(`Failed to upsert quote for ${yahooSymbol}:`, error);
    }
  };

  for (const batch of chunkIds(pending, UPSERT_BATCH_SIZE)) {
    await Promise.allSettled(batch.map(upsertOne));
  }

  return results;
}

/**
 * Refresh all active instrument quotes.
 * Used by the price-sync worker for post-market data refresh.
 */
export async function refreshAllQuotes(
  fetchQuotes: YahooBatchQuoteFetcher,
  options: {
    instrumentIds?: string[];
    batchSize?: number;
  } = {},
): Promise<{
  selected: number;
  refreshed: number;
  failed: number;
  /** How many quotes reached the Redis read path. MONEY-1469. */
  cached: number;
}> {
  const batchSize = options.batchSize ?? 50;
  let refreshed = 0;
  let failed = 0;
  // Quotes written THROUGH to Redis. Reported separately from `refreshed`
  // because a Redis that accepted nothing must not read as a successful sync.
  let cached = 0;

  // Get instruments to refresh (MONEY-704).
  //
  // Both branches used to read EVERY active instrument and filter in JS, on the
  // (incorrect) grounds that "Prisma { in: [...] } with large arrays" degrades.
  // Both predicates are now pushed into the query:
  //   - a caller-supplied id list → bounded `{ id: { in: … } }` on the primary
  //     key, chunked at ID_QUERY_CHUNK_SIZE so an arbitrarily long list still
  //     never becomes a collection scan;
  //   - no id list → the worker's genuine full-universe sweep, but with the
  //     instrumentType filter in the DB so the non-quotable rows (bonds, MF
  //     rows, …) are never shipped to Node at all.
  const QUOTABLE_TYPES = ["EQUITY", "INDEX", "ETF"];

  const instruments = options.instrumentIds?.length
    ? await queryByIdChunks(options.instrumentIds, (chunk) =>
        prisma.instrumentMapping.findMany({
          where: { id: { in: chunk }, isActive: true },
          select: {
            id: true,
            yahooSymbol: true,
            instrumentType: true,
            symbol: true,
            exchange: true,
          },
        }),
      )
    : await prisma.instrumentMapping.findMany({
        where: { isActive: true, instrumentType: { in: QUOTABLE_TYPES } },
        select: {
          id: true,
          yahooSymbol: true,
          instrumentType: true,
          symbol: true,
          exchange: true,
        },
      });

  // Process in batches
  for (let i = 0; i < instruments.length; i += batchSize) {
    const batch = instruments.slice(i, i + batchSize);
    const yahooSymbols = batch
      .filter(
        (inst) =>
          inst.yahooSymbol && !isUnfetchableYahooSymbol(inst.yahooSymbol),
      )
      .map((inst) => inst.yahooSymbol);

    const idByYahoo = new Map(batch.map((inst) => [inst.yahooSymbol, inst.id]));
    // MONEY-1469 (A4) — the Redis quote key is keyed by LISTING, not by the
    // Mongo id, because the reader is handed a symbol and an exchange and has
    // no id to look up. Without this map the write-through would have to
    // re-query the rows it already has in hand.
    const listingByYahoo = new Map(
      batch.map((inst) => [
        inst.yahooSymbol,
        `${inst.symbol}:${inst.exchange}`,
      ]),
    );
    const toCache: Array<{ listingId: string; quote: StoredQuote }> = [];

    try {
      const quotes = await fetchQuotes(yahooSymbols);
      const quoteEntries = Array.from(quotes.entries());

      for (const [yahooSymbol, data] of quoteEntries) {
        const instrumentId = idByYahoo.get(yahooSymbol);
        if (!instrumentId) continue;

        // Retry up to REFRESH_MAX_RETRIES times on write conflict / deadlock.
        // Shares the conflict-detection + backoff primitives with the rest of
        // the quote service via quote-logic.
        let attempt = 0;
        let success = false;
        while (attempt < REFRESH_MAX_RETRIES && !success) {
          try {
            await prisma.latestQuote.upsert({
              where: { instrumentId },
              create: {
                instrumentId,
                price: data.price,
                change: data.change,
                changePercent: data.changePercent,
                open: data.open,
                high: data.high,
                low: data.low,
                previousClose: data.previousClose,
                volume: data.volume,
                marketCap: data.marketCap,
                timestamp: data.timestamp,
                source: "YAHOO",
              },
              update: {
                price: data.price,
                change: data.change,
                changePercent: data.changePercent,
                open: data.open,
                high: data.high,
                low: data.low,
                previousClose: data.previousClose,
                volume: data.volume,
                marketCap: data.marketCap,
                timestamp: data.timestamp,
              },
            });
            success = true;
            refreshed++;
            // MONEY-1469 (A4) — WRITE-THROUGH. This is the whole point of the
            // ticket: `/api/market/quote` measures p95 4.0 s because a cold
            // miss falls through to Yahoo, whose client retries 3 x 15 s with
            // 1/2/4 s backoff. A quote PUT here is a quote no reader ever waits
            // on a vendor for. Collected, not written per row — see below.
            const listingId = listingByYahoo.get(yahooSymbol);
            if (listingId) {
              toCache.push({
                listingId,
                quote: {
                  price: data.price,
                  ts: data.timestamp.getTime(),
                  // YAHOO, not BHAVCOPY: this fan-out's only fetcher is the
                  // Yahoo batch client, and stamping a stronger provenance than
                  // the data has is how a 15-minute-delayed price starts being
                  // read as an exchange close.
                  source: "YAHOO",
                  ...finiteFields({
                    change: data.change,
                    changePct: data.changePercent,
                    open: data.open,
                    high: data.high,
                    low: data.low,
                    prevClose: data.previousClose,
                    volume: data.volume,
                  }),
                },
              });
            }
          } catch (upsertError: unknown) {
            attempt++;
            if (
              isWriteConflictError(upsertError) &&
              attempt < REFRESH_MAX_RETRIES
            ) {
              // Exponential backoff with jitter: ~200ms, ~400ms, ~800ms, ~1600ms
              const baseDelay = calcBackoff(REFRESH_BACKOFF_BASE_MS, attempt);
              const jitter = Math.random() * baseDelay;
              await new Promise((r) => setTimeout(r, baseDelay + jitter));
            } else {
              failed++;
              break;
            }
          }
        }
      }
      // ONE pipeline per batch of 50, not one SET per instrument. This job
      // sweeps ~20,700 active instruments against a 600 s Pub/Sub ack deadline,
      // and a handler that overruns it is REDELIVERED — a second copy running
      // concurrently, which is worse than being slow.
      //
      // NOT awaited for correctness, but awaited anyway: an unawaited rejection
      // is an `unhandledRejection` that takes the worker down, and one extra
      // round trip per 50 instruments is not worth that risk. `writeQuotes`
      // swallows its own Redis errors, so this cannot throw for market "IN".
      cached += await writeQuotes("IN", toCache);
    } catch (error) {
      console.error(`Failed to fetch batch quotes:`, error);
      failed += batch.length;
    }
  }

  // `selected` is RETURNED — MONEY-1250. It was computed here and dropped at
  // this boundary, so the worker could report how many quotes it wrote but not
  // how many it was supposed to write, and "the instrument table came back
  // empty" was indistinguishable from "there was nothing to do". Same shape as
  // the fix MONEY-1238 made to `runHistoricalBackfill`: a signal that cannot
  // leave the function it is computed in cannot reach anything that decides.
  return { selected: instruments.length, refreshed, failed, cached };
}
