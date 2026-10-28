/**
 * Symbol Mapper for Indian Markets
 *
 * Maps between internal symbols and Yahoo Finance symbols.
 * Handles NSE, BSE, and Index mappings.
 *
 * Uses a dual approach:
 * 1. DB-backed lookup from InstrumentMapping (primary, after instrument sync)
 * 2. Hardcoded fallbacks for graceful degradation when DB is empty
 */

import { prisma } from "@usemoney/database";
import {
  type CachedInstrument,
  getCachedInstrument,
  setCachedInstrument,
  YAHOO_TO_DISPLAY,
  normalizeSymbol,
  isValidSymbol,
} from "@/lib/market/symbol-mapper-logic";

// The pure cache primitives, reverse map, and validators live in
// `symbol-mapper-logic.ts` (dependency-free) so they can be unit-tested against
// the REAL exports without dragging Prisma into the test runner. Re-exported
// here so existing importers of this module keep working (YAHOO_TO_DISPLAY is
// also used internally by `fromYahooSymbol` below).
export { YAHOO_TO_DISPLAY, normalizeSymbol, isValidSymbol };

// ============== TYPES ==============

export type Exchange = "NSE" | "BSE";

export interface SymbolInfo {
  symbol: string;
  exchange: Exchange;
  yahooSymbol: string;
}

// ============== IN-MEMORY CACHE ==============

/**
 * Simple in-memory cache for DB-backed instrument lookups.
 * TTL: 60 seconds. Avoids hitting the DB on every symbol resolution.
 *
 * The get/set logic is the pure `getCachedInstrument` / `setCachedInstrument`
 * from `symbol-mapper-logic.ts`; these thin wrappers bind the process-wide
 * `instrumentCache` so the rest of the module keeps its (cache-free) signature.
 */
const instrumentCache = new Map<string, CachedInstrument>();

function getCached(symbol: string, exchange: string): CachedInstrument | null {
  return getCachedInstrument(instrumentCache, symbol, exchange);
}

function setCache(
  symbol: string,
  exchange: string,
  yahooSymbol: string,
  name: string
): void {
  setCachedInstrument(instrumentCache, symbol, exchange, yahooSymbol, name);
}

// ============== INDEX MAPPINGS (FALLBACK) ==============

/**
 * Known index symbol mappings (hardcoded fallback).
 * Primary source is InstrumentMapping DB table.
 */
export const INDEX_MAPPINGS: Record<string, string> = {
  // NSE Indices
  "NIFTY 50": "^NSEI",
  NIFTY50: "^NSEI",
  NIFTY: "^NSEI",
  "NIFTY BANK": "^NSEBANK",
  BANKNIFTY: "^NSEBANK",
  "NIFTY IT": "^CNXIT",
  NIFTYIT: "^CNXIT",
  "NIFTY MIDCAP 100": "^CNXMDCP",
  "NIFTY NEXT 50": "^NSMIDCP",
  "NIFTY PHARMA": "^CNXPHARMA",
  "NIFTY AUTO": "^CNXAUTO",
  "NIFTY FMCG": "^CNXFMCG",
  "NIFTY METAL": "^CNXMETAL",
  "NIFTY REALTY": "^CNXREALTY",
  "NIFTY ENERGY": "^CNXENERGY",
  "NIFTY INFRA": "^CNXINFRA",
  "NIFTY PRIVATE BANK": "^CNXPSUBANK",
  "NIFTY PSU BANK": "^NIFTYPSUBNK",
  "NIFTY FIN SERVICE": "^CNXFIN",
  "NIFTY MEDIA": "^CNXMEDIA",
  "INDIA VIX": "^INDIAVIX",

  // BSE Indices
  SENSEX: "^BSESN",
  "BSE SENSEX": "^BSESN",
  "BSE 100": "^BSE100",
  "BSE 200": "^BSE200",
  "BSE 500": "^BSE500",
  "BSE MIDCAP": "^BSEMCAP",
  "BSE SMALLCAP": "^BSESMLCAP",
  "BSE BANKEX": "^BSEBANKEX",
};

// YAHOO_TO_DISPLAY is defined in (and re-exported from) symbol-mapper-logic.ts.

// ============== DB-BACKED LOOKUP ==============

/**
 * Look up the Yahoo Finance symbol from the InstrumentMapping DB table.
 * Returns null if not found (caller should fall back to hardcoded logic).
 */
async function findInstrumentInDB(
  symbol: string,
  exchange: string
): Promise<{ yahooSymbol: string; name: string } | null> {
  // Check in-memory cache first
  const cached = getCached(symbol, exchange);
  if (cached) {
    return { yahooSymbol: cached.yahooSymbol, name: cached.name };
  }

  try {
    const instrument = await prisma.instrumentMapping.findUnique({
      where: {
        symbol_exchange: {
          symbol: symbol.toUpperCase(),
          exchange: exchange.toUpperCase(),
        },
      },
      select: { yahooSymbol: true, name: true },
    });

    if (instrument) {
      setCache(symbol, exchange, instrument.yahooSymbol, instrument.name);
      return { yahooSymbol: instrument.yahooSymbol, name: instrument.name };
    }
  } catch {
    // DB unavailable - fall through to hardcoded logic
  }

  return null;
}

/**
 * Find an instrument by its Yahoo symbol in the DB.
 */
async function findByYahooSymbolInDB(
  yahooSymbol: string
): Promise<{ symbol: string; exchange: string; name: string } | null> {
  try {
    const instrument = await prisma.instrumentMapping.findUnique({
      where: { yahooSymbol },
      select: { symbol: true, exchange: true, name: true },
    });

    return instrument;
  } catch {
    return null;
  }
}

// ============== CONVERSION FUNCTIONS ==============

/**
 * Convert internal symbol to Yahoo Finance symbol.
 * Tries DB lookup first, falls back to hardcoded mappings.
 *
 * Examples:
 * - toYahooSymbol("RELIANCE", "NSE") → "RELIANCE.NS"
 * - toYahooSymbol("RELIANCE", "BSE") → "RELIANCE.BO"
 * - toYahooSymbol("NIFTY 50") → "^NSEI"
 */
export function toYahooSymbol(
  symbol: string,
  exchange: Exchange = "NSE"
): string {
  // Check if it's an index
  const upperSymbol = symbol.toUpperCase().trim();
  if (INDEX_MAPPINGS[upperSymbol]) {
    return INDEX_MAPPINGS[upperSymbol];
  }

  // Already a Yahoo symbol
  if (
    symbol.endsWith(".NS") ||
    symbol.endsWith(".BO") ||
    symbol.startsWith("^")
  ) {
    return symbol;
  }

  // Add exchange suffix (synchronous fallback)
  const suffix = exchange === "BSE" ? ".BO" : ".NS";
  return `${upperSymbol}${suffix}`;
}

/**
 * Async version of toYahooSymbol that checks the DB first.
 * Use this when you can await (server components, server actions).
 *
 * Falls back to hardcoded logic if DB lookup fails.
 */
export async function toYahooSymbolAsync(
  symbol: string,
  exchange: Exchange = "NSE"
): Promise<string> {
  const upperSymbol = symbol.toUpperCase().trim();

  // Check hardcoded index mappings first (fastest)
  if (INDEX_MAPPINGS[upperSymbol]) {
    return INDEX_MAPPINGS[upperSymbol];
  }

  // Already a Yahoo symbol
  if (
    symbol.endsWith(".NS") ||
    symbol.endsWith(".BO") ||
    symbol.startsWith("^")
  ) {
    return symbol;
  }

  // Try DB lookup
  const dbResult = await findInstrumentInDB(upperSymbol, exchange);
  if (dbResult) {
    return dbResult.yahooSymbol;
  }

  // Fallback: generate from convention
  const suffix = exchange === "BSE" ? ".BO" : ".NS";
  return `${upperSymbol}${suffix}`;
}

/**
 * Convert Yahoo Finance symbol to internal format
 *
 * Examples:
 * - fromYahooSymbol("RELIANCE.NS") → { symbol: "RELIANCE", exchange: "NSE" }
 * - fromYahooSymbol("^NSEI") → { symbol: "NIFTY 50", exchange: "NSE" }
 */
export function fromYahooSymbol(yahooSymbol: string): SymbolInfo {
  // Check if it's an index
  if (yahooSymbol.startsWith("^")) {
    const displayName = YAHOO_TO_DISPLAY[yahooSymbol] || yahooSymbol;
    const exchange: Exchange =
      yahooSymbol === "^BSESN" || yahooSymbol.includes("BSE") ? "BSE" : "NSE";
    return {
      symbol: displayName,
      exchange,
      yahooSymbol,
    };
  }

  // Extract exchange from suffix
  let exchange: Exchange = "NSE";
  let symbol = yahooSymbol;

  if (yahooSymbol.endsWith(".NS")) {
    exchange = "NSE";
    symbol = yahooSymbol.slice(0, -3);
  } else if (yahooSymbol.endsWith(".BO")) {
    exchange = "BSE";
    symbol = yahooSymbol.slice(0, -3);
  }

  return {
    symbol,
    exchange,
    yahooSymbol,
  };
}

/**
 * Convert array of symbols to Yahoo format
 */
export function toYahooSymbols(
  symbols: string[],
  exchange: Exchange = "NSE"
): string[] {
  return symbols.map((s) => toYahooSymbol(s, exchange));
}

/**
 * Async version of toYahooSymbols - checks DB for each symbol.
 */
export async function toYahooSymbolsAsync(
  symbols: string[],
  exchange: Exchange = "NSE"
): Promise<string[]> {
  return Promise.all(symbols.map((s) => toYahooSymbolAsync(s, exchange)));
}

/**
 * Check if a symbol is an index
 */
export function isIndex(symbol: string): boolean {
  const upperSymbol = symbol.toUpperCase().trim();
  return upperSymbol in INDEX_MAPPINGS || symbol.startsWith("^");
}

/**
 * Get all available index symbols
 */
export function getAvailableIndices(): Array<{
  name: string;
  yahooSymbol: string;
}> {
  return Object.entries(INDEX_MAPPINGS)
    .filter(
      ([name]) =>
        !name.includes(" ") || name === "NIFTY 50" || name === "SENSEX"
    )
    .map(([name, yahooSymbol]) => ({
      name,
      yahooSymbol,
    }));
}

// ============== VALIDATION ==============

// normalizeSymbol and isValidSymbol are defined in (and re-exported from)
// symbol-mapper-logic.ts so they can be unit-tested without importing Prisma.

// ============== POPULAR STOCKS ==============

/**
 * Popular Indian stocks for quick access (hardcoded fallback).
 * After instrument sync, use DB queries for richer data.
 */
export const POPULAR_STOCKS = [
  {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    exchange: "NSE" as Exchange,
  },
  {
    symbol: "TCS",
    name: "Tata Consultancy Services",
    exchange: "NSE" as Exchange,
  },
  { symbol: "HDFCBANK", name: "HDFC Bank", exchange: "NSE" as Exchange },
  { symbol: "INFY", name: "Infosys", exchange: "NSE" as Exchange },
  { symbol: "ICICIBANK", name: "ICICI Bank", exchange: "NSE" as Exchange },
  {
    symbol: "HINDUNILVR",
    name: "Hindustan Unilever",
    exchange: "NSE" as Exchange,
  },
  { symbol: "SBIN", name: "State Bank of India", exchange: "NSE" as Exchange },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", exchange: "NSE" as Exchange },
  { symbol: "ITC", name: "ITC Limited", exchange: "NSE" as Exchange },
  {
    symbol: "KOTAKBANK",
    name: "Kotak Mahindra Bank",
    exchange: "NSE" as Exchange,
  },
  { symbol: "LT", name: "Larsen & Toubro", exchange: "NSE" as Exchange },
  { symbol: "AXISBANK", name: "Axis Bank", exchange: "NSE" as Exchange },
  { symbol: "ASIANPAINT", name: "Asian Paints", exchange: "NSE" as Exchange },
  { symbol: "MARUTI", name: "Maruti Suzuki", exchange: "NSE" as Exchange },
  { symbol: "WIPRO", name: "Wipro", exchange: "NSE" as Exchange },
  { symbol: "HCLTECH", name: "HCL Technologies", exchange: "NSE" as Exchange },
  { symbol: "TATAMOTORS", name: "Tata Motors", exchange: "NSE" as Exchange },
  { symbol: "TATASTEEL", name: "Tata Steel", exchange: "NSE" as Exchange },
  {
    symbol: "SUNPHARMA",
    name: "Sun Pharmaceutical",
    exchange: "NSE" as Exchange,
  },
  {
    symbol: "POWERGRID",
    name: "Power Grid Corporation",
    exchange: "NSE" as Exchange,
  },
];

/**
 * Get popular stock symbols as Yahoo format
 */
export function getPopularYahooSymbols(): string[] {
  return POPULAR_STOCKS.map((s) => toYahooSymbol(s.symbol, s.exchange));
}

// ============== DB-BACKED INSTRUMENT LOOKUP ==============

/**
 * Find an instrument in the DB by symbol and exchange.
 * Returns the full instrument record or null.
 *
 * MONEY-1383 (L4) — `instrumentType` is in the select because the ONE caller
 * (`/api/market/udf/symbols`) needs it and used to issue a SECOND
 * `findUnique` against the same row to get it, doubling the DB round trip on
 * a route measured at 0.83s warm / 2.50s cold. It is one more projected field
 * on a lookup that already runs, not a second query.
 */
export async function findInstrument(
  symbol: string,
  exchange: Exchange = "NSE"
): Promise<{
  id: string;
  symbol: string;
  exchange: string;
  yahooSymbol: string;
  name: string;
  instrumentType: string;
} | null> {
  try {
    const instrument = await prisma.instrumentMapping.findUnique({
      where: {
        symbol_exchange: {
          symbol: symbol.toUpperCase(),
          exchange,
        },
      },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        yahooSymbol: true,
        name: true,
        instrumentType: true,
      },
    });

    return instrument;
  } catch {
    return null;
  }
}

/**
 * Search instruments in the DB by partial symbol or name match.
 * Used for typeahead/search functionality.
 */
export async function searchInstruments(
  query: string,
  options: { limit?: number; exchange?: Exchange } = {}
): Promise<
  Array<{
    id: string;
    symbol: string;
    exchange: string;
    yahooSymbol: string;
    name: string;
    instrumentType: string;
    sector: string | null;
    previousSymbols: string[];
  }>
> {
  const { limit = 10, exchange } = options;

  try {
    // Try startsWith first (exact prefix match), then fallback to contains
    const upperQuery = query.toUpperCase();
    let instruments = await prisma.instrumentMapping.findMany({
      where: {
        isActive: true,
        ...(exchange ? { exchange } : {}),
        OR: [
          { symbol: { startsWith: upperQuery } },
          { name: { startsWith: query, mode: "insensitive" } },
          // MONEY-1177: a retired ticker still finds its company. `has` is an
          // EXACT element match (Prisma cannot prefix-match inside an array),
          // which is all that is needed — users type the whole old ticker they
          // remember, not a prefix of it. The field is indexed, which this OR
          // requires: Mongo only index-serves an $or when EVERY branch has an
          // index, so an un-indexed branch would collection-scan the whole
          // query (the MONEY-1129 regression).
          { previousSymbols: { has: upperQuery } },
        ],
      },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        yahooSymbol: true,
        name: true,
        instrumentType: true,
        sector: true,
        previousSymbols: true,
      },
      take: limit,
      orderBy: { symbol: "asc" },
    });

    // If prefix match returns too few, broaden to contains
    if (instruments.length < limit) {
      const existingIds = new Set(instruments.map((i) => i.id));
      const broader = await prisma.instrumentMapping.findMany({
        where: {
          isActive: true,
          id: { notIn: Array.from(existingIds) },
          ...(exchange ? { exchange } : {}),
          OR: [
            { symbol: { contains: upperQuery, mode: "insensitive" } },
            { name: { contains: query, mode: "insensitive" } },
          ],
        },
        select: {
          id: true,
          symbol: true,
          exchange: true,
          yahooSymbol: true,
          name: true,
          instrumentType: true,
          sector: true,
          previousSymbols: true,
        },
        take: limit - instruments.length,
        orderBy: { symbol: "asc" },
      });
      instruments = [...instruments, ...broader];
    }

    // Sort: symbol match > name match, NSE > BSE
    instruments.sort((a, b) => {
      // MONEY-1177: an EXACT former-ticker hit outranks everything. Someone
      // typing "ZOMATO" wants Eternal, not whatever else happens to start with
      // those letters — the alias is a precise statement of intent, while a
      // prefix match is a guess.
      // `?? []` is load-bearing, not defensive noise. `searchInstruments` ends
      // in `catch { return [] }`, so a row whose `previousSymbols` is absent
      // would throw here and turn the ENTIRE search into a silent empty result
      // — the worst possible failure for a search box. Mongo documents written
      // before the field existed can come back without it regardless of the
      // schema default (the MONEY-1050 pattern).
      const aAlias = (a.previousSymbols ?? []).includes(upperQuery);
      const bAlias = (b.previousSymbols ?? []).includes(upperQuery);
      if (aAlias && !bAlias) return -1;
      if (!aAlias && bAlias) return 1;

      // Symbol prefix match first
      const aSymPrefix = a.symbol.toUpperCase().startsWith(upperQuery);
      const bSymPrefix = b.symbol.toUpperCase().startsWith(upperQuery);
      if (aSymPrefix && !bSymPrefix) return -1;
      if (!aSymPrefix && bSymPrefix) return 1;

      // NSE before BSE
      if (a.exchange === "NSE" && b.exchange !== "NSE") return -1;
      if (a.exchange !== "NSE" && b.exchange === "NSE") return 1;

      // Name prefix match
      const aNamePrefix = a.name.toUpperCase().startsWith(upperQuery);
      const bNamePrefix = b.name.toUpperCase().startsWith(upperQuery);
      if (aNamePrefix && !bNamePrefix) return -1;
      if (!aNamePrefix && bNamePrefix) return 1;

      return a.symbol.localeCompare(b.symbol);
    });

    return instruments;
  } catch {
    return [];
  }
}
