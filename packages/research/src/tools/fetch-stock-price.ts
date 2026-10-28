/**
 * Fetch Stock Price - Yahoo Quotes → Tickertape quote → DB fallback → Gemini
 * search-grounded quote (scalars only).
 *
 * Yahoo's `quote` endpoint is fragile for Indian listings (intermittent 429s,
 * missing fields for small/mid-caps). For any symbol Yahoo can't resolve,
 * we fall back to Tickertape's `/stocks/quote/{sid}` which keeps the
 * downstream DCF / WACC / scenario pipeline alive.
 *
 * MONEY-1060 (RC3/RC4): when BOTH live sources miss for a symbol we serve its
 * last synced close from `DailyPrice` (+ marketCap/PE from `StockRatios`) so a
 * live outage still yields a current price. Production `yahooFetchQuotes`
 * NEVER throws (failed chunks are swallowed via Promise.allSettled), so the
 * outage signal is threaded through its `onError` observer (yahoo-api,
 * MONEY-1060) instead of a dead catch.
 *
 * GAP vs OUTAGE (fix 3): when NOTHING resolves from any source —
 *   - and a live source ERRORED → `success:false` + `metadata.sourceError`
 *     (real outage; the synthesizer reads "source down");
 *   - and NO error was captured → quiet `success:true` with `{}` (genuine gap —
 *     legitimately-unfetchable symbols like bonds/BE-series/unmapped MF codes
 *     must not render as red FAILED tiles; pre-PR behavior restored).
 *
 * Alt-exchange keying (fix 6): a .NS→.BO retry now ALIASES the fresh quote back
 * under the ORIGINALLY REQUESTED key (with `requestedSymbol` noted and the
 * quote's own `symbol` kept as the actual exchange symbol), so the missing-set
 * logic and DB overlay can't re-fetch/overlay a stale row under the .NS key
 * while the fresh quote hides under an unrequested .BO key.
 *
 * Search tier (fix 10): after the DB fallback, any symbol still missing a
 * price — or whose DB row is staler than 7 days — is tried against the Gemini
 * google-search-grounded scalar quote (`fetchSearchGroundedQuote`), tagged
 * `source:"search"` and bounds-checked against the last known close.
 */

import {
  yahooFetchQuotes,
  type YahooFetchErrorOpts,
  type YahooRawQuote,
} from "@usemoney/core/market-data";
import { fetchQuoteChain } from "../data-sources/data-source-chain";
import type { ResearchToolDef, ToolOutput } from "./types";

// ── DB price fallback (MONEY-1060 RC3) ──────────────────────────────────────

/**
 * Minimal Prisma surface the DB price fallback needs — injectable so the
 * fallback is unit-testable without a live database. Defaults to the real client
 * (lazy-imported at call time so importing this module never loads Prisma, which
 * cannot be loaded under the plain node test runner).
 */
export interface PriceFallbackDb {
  instrumentMapping: {
    findFirst: (args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<{ id: string } | null>;
  };
  dailyPrice: {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      take?: number;
    }) => Promise<
      Array<{
        close: number;
        open?: number | null;
        high?: number | null;
        low?: number | null;
        volume?: number | null;
        date: Date;
      }>
    >;
  };
  stockRatios: {
    findUnique: (args: {
      where: Record<string, unknown>;
    }) => Promise<{ marketCap: number | null; pe: number | null } | null>;
  };
}

async function resolvePriceDb(db?: PriceFallbackDb): Promise<PriceFallbackDb> {
  if (db) return db;
  const mod = await import("@usemoney/database");
  return (mod.default ?? mod.prisma) as unknown as PriceFallbackDb;
}

/**
 * Last-known price for a symbol from the DB: most-recent `DailyPrice` close (+
 * the prior close for change/%), plus marketCap/PE from `StockRatios`. Returns
 * null when the symbol isn't mapped or has neither a price nor a marketCap.
 * Never throws.
 */
export async function fetchDbPriceFallback(
  symbol: string,
  db?: PriceFallbackDb,
): Promise<Record<string, unknown> | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const exchange = /\.BO$/i.test(symbol) ? "BSE" : "NSE";
  try {
    const client = await resolvePriceDb(db);
    const instrument = await client.instrumentMapping.findFirst({
      where: { symbol: clean, exchange, isActive: true },
      select: { id: true },
    });
    if (!instrument) return null;

    const [rows, ratios] = await Promise.all([
      client.dailyPrice.findMany({
        where: { instrumentId: instrument.id },
        orderBy: { date: "desc" },
        take: 2,
      }),
      client.stockRatios
        .findUnique({
          where: { symbol_exchange: { symbol: clean, exchange } },
        })
        .catch(() => null),
    ]);

    const marketCap =
      typeof ratios?.marketCap === "number" ? ratios.marketCap : undefined;
    const pe = typeof ratios?.pe === "number" ? ratios.pe : undefined;
    const latest = rows[0];

    if (!latest) {
      // No price history — a marketCap alone still keeps downstream sizing alive.
      if (marketCap === undefined) return null;
      return {
        symbol,
        price: undefined,
        marketCap,
        pe,
        source: "db",
        stale: true,
      };
    }

    const prevClose =
      typeof rows[1]?.close === "number" ? rows[1]!.close : undefined;
    const change =
      prevClose !== undefined ? latest.close - prevClose : undefined;
    const changePercent =
      prevClose !== undefined && prevClose !== 0
        ? ((latest.close - prevClose) / prevClose) * 100
        : undefined;

    return {
      symbol,
      name: undefined,
      price: latest.close,
      change,
      changePercent,
      open: latest.open ?? undefined,
      high: latest.high ?? undefined,
      low: latest.low ?? undefined,
      previousClose: prevClose,
      volume: latest.volume ?? undefined,
      marketCap,
      pe,
      eps: undefined,
      fiftyTwoWeekHigh: undefined,
      fiftyTwoWeekLow: undefined,
      asOf:
        latest.date instanceof Date
          ? latest.date.toISOString()
          : String(latest.date),
      source: "db",
      stale: true,
    };
  } catch {
    return null;
  }
}

// ── Live prices (Yahoo → Tickertape) ────────────────────────────────────────

/**
 * Batch quote fetcher seam — matches `yahooFetchQuotes`' shape (incl. its
 * `onError` observer). Injectable so the REAL swallow-path wiring (empty map +
 * onError call, never a throw) is exercisable in tests.
 */
export type BatchQuotesFetcher = (
  symbols: string[],
  opts?: YahooFetchErrorOpts,
) => Promise<Map<string, YahooRawQuote>>;

/** Per-symbol Tickertape quote seam — matches `fetchQuoteChain`. */
export type QuoteChainFetcher = (symbol: string) => Promise<unknown | null>;

/**
 * Resolve prices from the live sources (Yahoo Quotes, with a .NS↔.BO retry, then
 * a per-symbol Tickertape quote fallback). Returns the assembled result map and,
 * when Yahoo errored (429 / network — reported via the `onError` observer since
 * production `fetchQuotes` swallows and never throws), the captured error
 * message. Never throws itself, so the caller can still run the DB fallback.
 *
 * Fix 6 (MONEY-1060): an alternate-exchange retry hit is aliased back under the
 * ORIGINALLY REQUESTED key (quote `symbol` stays the actual exchange symbol;
 * `requestedSymbol` records the alias) — the .BO key is NOT added separately,
 * so the downstream missing-set / DB-overlay logic keys correctly.
 *
 * Exported with injectable fetcher seams so the onError wiring + aliasing run
 * against the SAME code `execute` uses — tests inject fakes, production the
 * real `yahooFetchQuotes` / `fetchQuoteChain`.
 */
export async function fetchLivePrices(
  symbols: string[],
  quotesFetch: BatchQuotesFetcher = yahooFetchQuotes,
  quoteChainFetch: QuoteChainFetcher = fetchQuoteChain,
): Promise<{ result: Record<string, unknown>; error?: string }> {
  const result: Record<string, unknown> = {};
  let sourceError: string | undefined;
  const capture = (e: unknown): void => {
    // Keep the FIRST captured error — later retries usually repeat it.
    sourceError = sourceError ?? (e instanceof Error ? e.message : String(e));
  };

  try {
    const quotesMap = await quotesFetch(symbols, { onError: capture });

    // Retry missing symbols with alternate exchange (.NS ↔ .BO), aliasing any
    // hit back under the requested key (fix 6).
    const missing = symbols.filter(
      (s) => !quotesMap.has(s) && (s.endsWith(".NS") || s.endsWith(".BO")),
    );
    if (missing.length > 0) {
      const altToRequested = new Map<string, string>();
      const retrySymbols = missing.map((s) => {
        const alt = s.endsWith(".NS")
          ? s.replace(/\.NS$/, ".BO")
          : s.replace(/\.BO$/, ".NS");
        altToRequested.set(alt, s);
        return alt;
      });
      const retryMap = await quotesFetch(retrySymbols, { onError: capture });
      for (const [altSym, quote] of Array.from(retryMap.entries())) {
        const requested = altToRequested.get(altSym) ?? altSym;
        if (!quotesMap.has(requested)) quotesMap.set(requested, quote);
      }
    }

    for (const [sym, quote] of Array.from(quotesMap.entries())) {
      result[sym] = {
        // The quote's own symbol stays the ACTUAL exchange symbol (e.g. .BO
        // after an alias); requestedSymbol records the key it answers for.
        symbol: quote.symbol,
        ...(quote.symbol !== sym ? { requestedSymbol: sym } : {}),
        name: quote.shortName || quote.longName,
        price: quote.regularMarketPrice,
        change: quote.regularMarketChange,
        changePercent: quote.regularMarketChangePercent,
        open: quote.regularMarketOpen,
        high: quote.regularMarketDayHigh,
        low: quote.regularMarketDayLow,
        previousClose: quote.regularMarketPreviousClose,
        volume: quote.regularMarketVolume,
        marketCap: quote.marketCap,
        pe: quote.trailingPE,
        eps: quote.epsTrailingTwelveMonths,
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
      };
    }
  } catch (error) {
    // Defensive: production fetchQuotes never throws (allSettled), but an
    // injected fake / future refactor might.
    capture(error);
    return { result, ...(sourceError ? { error: sourceError } : {}) };
  }

  // Tickertape fallback for any symbol Yahoo failed to return
  const stillMissing = symbols.filter((s) => !(s in result));
  if (stillMissing.length > 0) {
    await Promise.all(
      stillMissing.map(async (sym) => {
        const tt = await quoteChainFetch(sym);
        if (!tt) return;
        const tquote = tt as Record<string, unknown>;
        result[sym] = {
          symbol: sym,
          name: tquote.name ?? tquote.companyName,
          price: tquote.price ?? tquote.lastPrice,
          change: tquote.change,
          changePercent: tquote.changePercent ?? tquote.percentChange,
          open: tquote.open,
          high: tquote.high ?? tquote.dayHigh,
          low: tquote.low ?? tquote.dayLow,
          previousClose: tquote.previousClose,
          volume: tquote.volume,
          marketCap: tquote.marketCap,
          pe: tquote.pe,
          eps: tquote.eps,
          fiftyTwoWeekHigh: tquote.yearHigh ?? tquote.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: tquote.yearLow ?? tquote.fiftyTwoWeekLow,
          source: "tickertape",
        };
      }),
    );
  }

  return { result, ...(sourceError ? { error: sourceError } : {}) };
}

/** Max age of a DB-fallback price before the search tier is tried (fix 10). */
export const SEARCH_TIER_MAX_DB_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Optional final-tier fetcher (fix 10): a Gemini google-search-grounded scalar
 * quote for a symbol the DB fallback also missed / only has a >7-day-old row
 * for. Receives the last known close (when any) for the hallucination bounds
 * check; returns a serialized price row (`source:"search"`) or null.
 */
export type SearchQuoteFetcher = (
  symbol: string,
  lastKnownClose?: number,
) => Promise<Record<string, unknown> | null>;

function isPositiveFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Is this row eligible for the search tier? Yes when the symbol has no row at
 * all, or its row is a DB-fallback (`source:"db"`) that is missing a price or
 * carries an `asOf` older than 7 days (or unparseable). Live rows never are.
 */
export function needsSearchQuote(
  row: Record<string, unknown> | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!row) return true;
  if (row.source !== "db") return false;
  if (!isPositiveFinite(row.price)) return true;
  const asOfMs = typeof row.asOf === "string" ? Date.parse(row.asOf) : NaN;
  if (!Number.isFinite(asOfMs)) return true;
  return nowMs - asOfMs > SEARCH_TIER_MAX_DB_AGE_MS;
}

/**
 * Merge the live result with a DB fallback for any symbol the live sources
 * missed, then (fix 10) try the search-grounded scalar tier for symbols still
 * missing / only stale-DB-covered, then apply the GAP-vs-OUTAGE rule (fix 3):
 *
 *   - empty result + a captured live sourceError → `success:false` +
 *     `metadata.sourceError` (real outage);
 *   - empty result + NO captured error → quiet `success:true` with `{}`
 *     (genuine gap — e.g. legitimately-unfetchable symbols; pre-PR behavior).
 *
 * Exported so the fallback + gap/outage decision is unit-testable against the
 * SAME code `execute` runs — inject fake live/DB/search fetchers in tests.
 */
export async function assemblePrices(
  symbols: string[],
  liveFetch: (
    symbols: string[],
  ) => Promise<{ result: Record<string, unknown>; error?: string }>,
  dbFetch: (symbol: string) => Promise<Record<string, unknown> | null>,
  searchFetch?: SearchQuoteFetcher,
): Promise<ToolOutput> {
  const { result, error: sourceError } = await liveFetch(symbols);

  // DB fallback for any symbol neither Yahoo nor Tickertape returned.
  const missingAfterLive = symbols.filter((s) => !(s in result));
  if (missingAfterLive.length > 0) {
    await Promise.all(
      missingAfterLive.map(async (sym) => {
        const dbRow = await dbFetch(sym);
        if (dbRow) result[sym] = dbRow;
      }),
    );
  }

  // Search-grounded final tier (fix 10): total misses + stale (>7d) DB rows.
  // Never throws — the fetcher swallows internally and returns null.
  if (searchFetch) {
    const eligible = symbols.filter((s) =>
      needsSearchQuote(result[s] as Record<string, unknown> | undefined),
    );
    if (eligible.length > 0) {
      await Promise.all(
        eligible.map(async (sym) => {
          const existing = result[sym] as Record<string, unknown> | undefined;
          const existingPrice = existing?.price;
          const lastKnownClose = isPositiveFinite(existingPrice)
            ? existingPrice
            : undefined;
          const searchRow = await searchFetch(sym, lastKnownClose);
          if (!searchRow) return;
          // Search supplies scalars only; keep the DB row's slow-moving
          // marketCap/PE when the search result lacks them.
          const merged: Record<string, unknown> = { ...searchRow };
          if (
            merged.marketCap === undefined &&
            typeof existing?.marketCap === "number"
          ) {
            merged.marketCap = existing.marketCap;
          }
          if (merged.pe === undefined && typeof existing?.pe === "number") {
            merged.pe = existing.pe;
          }
          result[sym] = merged;
        }),
      );
    }
  }

  // GAP vs OUTAGE (fix 3): nothing from any source. A captured live error is a
  // real outage → fail loudly with sourceError. No captured error is a genuine
  // gap (unfetchable/unmapped symbols) → the old quiet empty-success, so
  // healthy days never render red FAILED tiles for them.
  if (Object.keys(result).length === 0) {
    if (sourceError) {
      return {
        success: false,
        error: `No price data found for ${symbols.join(", ")}: ${sourceError}`,
        metadata: { sourceError },
      };
    }
    return { success: true, data: {} };
  }

  return {
    success: true,
    data: result,
    ...(sourceError ? { metadata: { sourceError, fallback: true } } : {}),
  };
}

export const fetchStockPriceTool: ResearchToolDef = {
  name: "fetch_stock_price",
  description: "Fetch current stock price, market cap, 52-week range, PE, EPS",
  category: "data",
  parameters: {
    symbols: {
      type: "string[]",
      description: "Yahoo Finance symbols array",
      required: true,
    },
  },
  cacheTTL: 300, // 5min
  execute: async (params): Promise<ToolOutput> => {
    const symbols = params.symbols as string[];
    if (!symbols?.length)
      return { success: false, error: "symbols array is required" };

    return assemblePrices(
      symbols,
      (syms) => fetchLivePrices(syms),
      (s) => fetchDbPriceFallback(s),
      // Search-grounded final tier (fix 10). Lazy import inside a guarded
      // thunk (test-runner safe; a broken Gemini env degrades to a null tier
      // exactly like the other fallbacks).
      async (sym, lastKnownClose) => {
        try {
          const { fetchSearchGroundedQuote } =
            await import("../data-sources/search-quote");
          const quote = await fetchSearchGroundedQuote(sym, {
            ...(lastKnownClose !== undefined ? { lastKnownClose } : {}),
          });
          if (!quote) return null;
          return {
            symbol: sym,
            price: quote.price,
            ...(quote.marketCap !== undefined
              ? { marketCap: quote.marketCap }
              : {}),
            ...(quote.asOf ? { asOf: quote.asOf } : {}),
            source: "search",
          };
        } catch {
          return null;
        }
      },
    );
  },
};
