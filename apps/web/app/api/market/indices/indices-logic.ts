/**
 * Market Indices — pure logic & config (no server-only deps).
 *
 * Extracted from `app/api/market/indices/route.ts` so the ticker taxonomy
 * (TICKER_INDICES / MCX_COMMODITIES), market-phase math, futures-symbol
 * generation, Yahoo-symbol stripping, the index-row builder, the positive-price
 * filter, the globalThis cache accessor, and the cache-freshness check can be
 * unit-tested against the REAL exported symbols instead of inline copies.
 *
 * The route handler owns auth + HTTP + the Yahoo/Zerodha fetch fan-out and
 * imports everything here. This module imports nothing server-only (no Clerk /
 * Prisma / network clients), so the tests stay pure and exit cleanly.
 *
 * @see apps/web/__tests__/api/market-indices.test.ts
 */

export type Market = "IN" | "US" | "MCX";
export type MarketPhase = "PRE" | "OPEN" | "POST" | "CLOSED";

export interface TickerIndex {
  yahooSymbol: string;
  name: string;
  market: Market;
}

export interface MCXCommodity {
  yahooFallback: string;
  zerodhaSymbol: string;
  name: string;
  unit: string;
}

export interface SimpleQuote {
  price: number;
  change: number;
  changePercent: number;
}

export interface IndexRow {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  market: string;
}

export interface YahooBasePayload {
  success: true;
  data: IndexRow[];
  marketStatus: { IN: MarketPhase; US: MarketPhase; MCX: MarketPhase };
}

export interface IndicesCache {
  // MONEY-566: the shared cache holds ONLY the Yahoo-only base payload (which
  // is identical for every user). Zerodha Gift NIFTY / MCX are overlaid
  // per-request and never stored here, so they can never leak cross-user.
  cachedResponse: { data: YahooBasePayload; timestamp: number } | null;
  inflightPromise: Promise<YahooBasePayload> | null;
}

// Key indices to display in the ticker
export const TICKER_INDICES: TickerIndex[] = [
  { yahooSymbol: "^NSEI", name: "NIFTY 50", market: "IN" },
  { yahooSymbol: "^BSESN", name: "SENSEX", market: "IN" },
  { yahooSymbol: "^NSEBANK", name: "NIFTY BANK", market: "IN" },
  { yahooSymbol: "^CNXIT", name: "NIFTY IT", market: "IN" },
  { yahooSymbol: "^NSEMDCP50", name: "NIFTY MIDCAP", market: "IN" },
  { yahooSymbol: "INDIAVIX.NS", name: "INDIA VIX", market: "IN" },
  { yahooSymbol: "^DJI", name: "DOW JONES", market: "US" },
  { yahooSymbol: "^GSPC", name: "S&P 500", market: "US" },
  { yahooSymbol: "^IXIC", name: "NASDAQ", market: "US" },
  { yahooSymbol: "^VIX", name: "VIX", market: "US" },
];

// MCX commodities - Yahoo global futures as fallback, Zerodha MCX when authenticated.
// Crude Oil temporarily removed (2026-05-04) - the upstream Yahoo CL=F
// feed was returning stale / missing values during US-market off-hours
// and surfacing as a confusing entry in the global ticker. Add it back
// once we wire a more reliable source (NSE IFSC futures or MCX direct).
export const MCX_COMMODITIES: MCXCommodity[] = [
  { yahooFallback: "GC=F", zerodhaSymbol: "GOLD", name: "GOLD", unit: "/oz" },
  {
    yahooFallback: "SI=F",
    zerodhaSymbol: "SILVER",
    name: "SILVER",
    unit: "/oz",
  },
];

// In-memory cache to prevent cascading Yahoo Finance timeouts.
// MarketTicker polls every 60s; if Yahoo is slow, stale data is far better than a 45s hang.
// Stored on globalThis so the cache survives HMR in dev mode - without this,
// every file save resets the cache and triggers a fresh 10-30s Yahoo Finance fetch.
export const CACHE_TTL_MS = 60_000;

const CACHE_KEY = "__sb_indices_cache__" as const;

/**
 * Process-wide indices cache, stored on globalThis so it survives HMR in dev.
 * Holds ONLY the Yahoo-only base payload (see IndicesCache).
 */
export function getIndicesCache(): IndicesCache {
  const g = globalThis as Record<string, unknown>;
  if (!g[CACHE_KEY]) {
    g[CACHE_KEY] = { cachedResponse: null, inflightPromise: null };
  }
  return g[CACHE_KEY] as IndicesCache;
}

/** True when a cache entry stamped `timestamp` is still within the 60s TTL. */
export function isCacheFresh(
  timestamp: number,
  now: number = Date.now()
): boolean {
  return now - timestamp < CACHE_TTL_MS;
}

/**
 * Get current market phase.
 *
 * IN (NSE/BSE):
 *   Pre-market:  9:00 AM - 9:15 AM IST
 *   Open:        9:15 AM - 3:30 PM IST
 *   Post-market: 3:30 PM - 4:00 PM IST
 *   Closed:      otherwise
 *
 * US (NYSE/NASDAQ):
 *   Pre-market:  4:00 AM - 9:30 AM ET
 *   Open:        9:30 AM - 4:00 PM ET
 *   Post-market: 4:00 PM - 8:00 PM ET
 *   Closed:      otherwise
 */
export function getMarketPhase(market: Market): MarketPhase {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat

  if (day === 0 || day === 6) return "CLOSED";

  if (market === "IN") {
    // IST = UTC + 5:30
    const istMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + 330;
    const adjusted = istMinutes >= 1440 ? istMinutes - 1440 : istMinutes;
    if (adjusted >= 9 * 60 && adjusted < 9 * 60 + 15) return "PRE";
    if (adjusted >= 9 * 60 + 15 && adjusted < 15 * 60 + 30) return "OPEN";
    if (adjusted >= 15 * 60 + 30 && adjusted < 16 * 60) return "POST";
    return "CLOSED";
  }

  if (market === "MCX") {
    // MCX: Mon-Fri 9:00 AM - 11:30 PM IST (non-agri) / 11:55 PM (agri)
    // Using 11:30 PM as close for simplicity
    const istMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + 330;
    const adjusted = istMinutes >= 1440 ? istMinutes - 1440 : istMinutes;
    if (adjusted >= 9 * 60 && adjusted < 23 * 60 + 30) return "OPEN";
    return "CLOSED";
  }

  // US: ET = UTC - 5 (EST) or UTC - 4 (EDT)
  const month = now.getUTCMonth();
  const isDST = month >= 2 && month <= 10; // rough Mar-Oct
  const etOffset = isDST ? -4 : -5;
  const etMinutes =
    now.getUTCHours() * 60 + now.getUTCMinutes() + etOffset * 60;
  const adjusted = etMinutes < 0 ? etMinutes + 1440 : etMinutes;
  if (adjusted >= 4 * 60 && adjusted < 9 * 60 + 30) return "PRE";
  if (adjusted >= 9 * 60 + 30 && adjusted < 16 * 60) return "OPEN";
  if (adjusted >= 16 * 60 && adjusted < 20 * 60) return "POST";
  return "CLOSED";
}

/**
 * Build Zerodha trading symbol for current month futures.
 * Format: {BASE}{YY}{MMM}FUT  e.g. NIFTY25FEBFUT, GOLD25FEBFUT
 */
export function getCurrentFutSymbol(base: string): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  return `${base}${yy}${months[now.getMonth()]}FUT`;
}

/**
 * Strip a Yahoo symbol down to its bare ticker: drop a trailing `.NS` / `.BO`
 * exchange suffix and a leading `^` index marker. Used to align Yahoo's
 * base-symbol-keyed quote map with the index's display symbol.
 */
export function stripYahooSuffix(symbol: string): string {
  return symbol.replace(/\.(NS|BO)$/, "").replace("^", "");
}

/**
 * Build the ticker row for an index from its (possibly null) quote, defaulting
 * every numeric field to 0 when the quote is missing.
 */
export function buildIndexQuote(
  idx: TickerIndex,
  quote: SimpleQuote | null
): IndexRow {
  return {
    symbol: idx.yahooSymbol,
    name: idx.name,
    price: quote?.price ?? 0,
    change: quote?.change ?? 0,
    changePercent: quote?.changePercent ?? 0,
    market: idx.market,
  };
}

/** Drop rows whose price is not strictly positive (Yahoo blanks / 0-quotes). */
export function filterPositivePrice<T extends { price: number }>(
  data: T[]
): T[] {
  return data.filter((d) => d.price > 0);
}

/**
 * MONEY-1135 — re-exported from the shared helper rather than re-implemented.
 * The local copy here never cleared its timer, so every call left a pending
 * `setTimeout` holding the event loop. `route.ts` and the indices test import
 * `withTimeout` from this module, so the name stays exported here.
 */
export { withTimeout } from "@/lib/utils/with-timeout";

/**
 * The caller's OWN Zerodha rows to overlay onto the shared Yahoo base:
 * Gift NIFTY (appended) and a map of commodity-name → MCX quote (each replacing
 * the matching Yahoo fallback row).
 */
export interface ZerodhaOverlayData {
  giftNifty: SimpleQuote | null;
  mcx: Map<string, SimpleQuote>;
}

/**
 * Overlay the caller's OWN Zerodha Gift NIFTY + MCX quotes onto the shared
 * Yahoo base. Returns a NEW payload (the base is never mutated) plus whether any
 * Zerodha row was added — which drives the private/no-store response header.
 * Gift NIFTY is appended (no Yahoo proxy exists); each MCX row replaces the
 * Yahoo fallback for the same commodity.
 *
 * MONEY-566 compliance invariant: the shared base must NEVER be mutated (it is
 * the process-wide cache entry served to every user), and any Zerodha row added
 * MUST flip `hasZerodha` to true so the route returns `private, no-store`.
 */
export function applyZerodhaOverlay(
  base: YahooBasePayload,
  zerodhaData: ZerodhaOverlayData | null
): { payload: YahooBasePayload; hasZerodha: boolean } {
  if (!zerodhaData) return { payload: base, hasZerodha: false };

  const data: IndexRow[] = [...base.data];
  let hasZerodha = false;

  if (zerodhaData.giftNifty) {
    data.push({
      symbol: "GIFT_NIFTY",
      name: "GIFT NIFTY",
      ...zerodhaData.giftNifty,
      market: "IN",
    });
    hasZerodha = true;
  }

  for (const commodity of MCX_COMMODITIES) {
    const zq = zerodhaData.mcx.get(commodity.name);
    if (!zq) continue;
    const row: IndexRow = {
      symbol: commodity.zerodhaSymbol,
      name: commodity.name,
      ...zq,
      market: "MCX",
    };
    const idx = data.findIndex(
      (r) => r.market === "MCX" && r.name === commodity.name
    );
    if (idx >= 0) {
      data[idx] = row;
    } else {
      data.push(row);
    }
    hasZerodha = true;
  }

  return { payload: { ...base, data }, hasZerodha };
}

/**
 * The cache-control decision: a payload carrying ANY of the caller's Zerodha
 * rows is per-user and must never be stored by a shared cache → "private";
 * the Yahoo-only base is identical for everyone → "public".
 */
export function cacheControlPolicy(hasZerodha: boolean): "private" | "public" {
  return hasZerodha ? "private" : "public";
}
