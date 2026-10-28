/**
 * Index Constituents - Dynamic fetch from NSE + Redis cache.
 *
 * Fetches index constituent lists from NSE India API on demand,
 * caches in Redis for 24 hours. Falls back to a minimal hardcoded
 * list if the NSE API is unreachable.
 *
 * Supported indices: NIFTY 50, NIFTY 100, NIFTY 200, NIFTY 500,
 * NIFTY MIDCAP 100, NIFTY SMALLCAP 100, SENSEX, etc.
 */

import ky from "ky";
// MONEY-1127 (FIX 2): the canonical process-wide Redis singleton. This file
// used to build its OWN `new Redis(...)` on `globalThis.__indexRedis`, so a
// warm lambda held a second (sometimes third) TCP connection to a node whose
// documented ceiling is ~50 connections. Imported by relative path rather than
// the `@usemoney/core/cache` subpath because we are INSIDE that package, and
// `../cache/redis` pulls only ioredis + the logger — no barrel, no cycle.
import { getRedisClient } from "../cache/redis";

const NSE_INDEX_URL = "https://www.nseindia.com/api/equity-stockIndices";
const NSE_TIMEOUT_MS = 8000;
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// NSE requires browser-like headers
const NSE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/",
};

// Map user-friendly names to NSE API index identifiers
const INDEX_API_NAMES: Record<string, string> = {
  "NIFTY 50": "NIFTY 50",
  "NIFTY 100": "NIFTY 100",
  "NIFTY 200": "NIFTY 200",
  "NIFTY 500": "NIFTY 500",
  "NIFTY MIDCAP 100": "NIFTY MIDCAP 100",
  "NIFTY SMALLCAP 100": "NIFTY SMLCAP 100",
  SENSEX: "NIFTY 50", // BSE Sensex doesn't have an NSE API - approximate with Nifty 50
  "NIFTY BANK": "NIFTY BANK",
  "NIFTY IT": "NIFTY IT",
  "NIFTY PHARMA": "NIFTY PHARMA",
  "NIFTY AUTO": "NIFTY AUTO",
  "NIFTY FMCG": "NIFTY FMCG",
  "NIFTY METAL": "NIFTY METAL",
  "NIFTY ENERGY": "NIFTY ENERGY",
  "NIFTY REALTY": "NIFTY REALTY",
};

// Minimal fallback - used only when NSE API + Redis both fail
const FALLBACK_NIFTY_50 = [
  "ADANIENT",
  "ADANIPORTS",
  "APOLLOHOSP",
  "ASIANPAINT",
  "AXISBANK",
  "BAJAJ-AUTO",
  "BAJAJFINSV",
  "BAJFINANCE",
  "BHARTIARTL",
  "BPCL",
  "BRITANNIA",
  "CIPLA",
  "COALINDIA",
  "DIVISLAB",
  "DRREDDY",
  "EICHERMOT",
  "GRASIM",
  "HCLTECH",
  "HDFCBANK",
  "HDFCLIFE",
  "HEROMOTOCO",
  "HINDALCO",
  "HINDUNILVR",
  "ICICIBANK",
  "INDUSINDBK",
  "INFY",
  "ITC",
  "JSWSTEEL",
  "KOTAKBANK",
  "LT",
  "LTIM",
  "MARUTI",
  "NESTLEIND",
  "NTPC",
  "ONGC",
  "POWERGRID",
  "RELIANCE",
  "SBILIFE",
  "SBIN",
  "SHRIRAMFIN",
  "SUNPHARMA",
  "TATACONSUM",
  "TATAMOTORS",
  "TATASTEEL",
  "TCS",
  "TECHM",
  "TITAN",
  "TRENT",
  "ULTRACEMCO",
  "WIPRO",
];

interface NseIndexResponse {
  data?: Array<{ symbol: string; [key: string]: unknown }>;
}

/**
 * Get constituent symbols for an index name.
 * Fetches from NSE API with Redis caching (24h TTL).
 * Returns null if index is unknown.
 */
export async function getIndexConstituents(
  indexName: string,
): Promise<string[] | null> {
  const normalized = indexName.toUpperCase().trim();
  const nseIndexName = INDEX_API_NAMES[normalized];

  if (!nseIndexName) return null;

  const cacheKey = `index-constituents:${normalized}`;

  // 1. Try Redis cache
  try {
    const redis = getRedisClient();
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as string[];
      }
    }
  } catch {
    // Redis unavailable - continue to API
  }

  // 2. Fetch from NSE API
  try {
    const resp = await ky
      .get(NSE_INDEX_URL, {
        searchParams: { index: nseIndexName },
        headers: NSE_HEADERS,
        timeout: NSE_TIMEOUT_MS,
      })
      .json<NseIndexResponse>();

    if (resp?.data && resp.data.length > 0) {
      // First entry is usually the index itself - filter to stock entries
      const symbols = resp.data
        .map((d) => d.symbol)
        .filter((s) => s && !s.includes(" "));

      // Cache in Redis
      try {
        const redis = getRedisClient();
        if (redis) {
          await redis.set(
            cacheKey,
            JSON.stringify(symbols),
            "EX",
            CACHE_TTL_SECONDS,
          );
        }
      } catch {
        // Cache write failure is non-critical
      }

      return symbols;
    }
  } catch {
    // NSE API failed - use fallback
  }

  // 3. Fallback for known indices
  if (normalized === "NIFTY 50" || normalized === "SENSEX") {
    return FALLBACK_NIFTY_50;
  }

  return null;
}
