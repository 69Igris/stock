/**
 * RBI DBIE & Macro Data Client
 *
 * Fetches key Indian macroeconomic indicators: repo rate, CPI inflation,
 * GDP growth, forex reserves, IIP, and 10Y G-Sec yield.
 *
 * Strategy:
 *   1. Try the RBI DBIE JSON API (https://api.rbi.org.in/dbie/)
 *   2. Fall back to curated static data (updated periodically)
 *
 * All results are cached for 24 hours via the data-source cache.
 */

import { cacheWrap } from "./cache";

// ─── Types ───────────────────────────────────────────────────

export interface MacroIndicator {
  value: number;
  date: string;
  source: string;
}

export interface MacroIndicatorWithQuarter {
  value: number;
  quarter: string;
  source: string;
}

export interface MacroIndicatorWithUnit {
  value: number;
  unit: string;
  date: string;
  source: string;
}

export interface MacroSnapshot {
  repoRate: MacroIndicator;
  cpi: MacroIndicator;
  gdpGrowth: MacroIndicatorWithQuarter;
  forexReserves: MacroIndicatorWithUnit;
  iip: MacroIndicator | null;
  riskFreeRate: number; // 10Y G-Sec yield
}

// ─── Static Fallback Data ────────────────────────────────────
// Last updated: March 2026
// These values should be refreshed periodically when the RBI DBIE API is unreachable.

const STATIC_MACRO: MacroSnapshot = {
  repoRate: {
    value: 6.25,
    date: "2025-02-07",
    source: "RBI Monetary Policy - Feb 2025 (static fallback)",
  },
  cpi: {
    value: 3.61,
    date: "2025-02-01",
    source: "MOSPI CPI release - Feb 2025 (static fallback)",
  },
  gdpGrowth: {
    value: 6.2,
    quarter: "Q3 FY2025 (Oct-Dec 2024)",
    source: "MOSPI Advance Estimate - Feb 2025 (static fallback)",
  },
  forexReserves: {
    value: 630.6,
    unit: "USD Billion",
    date: "2025-02-21",
    source: "RBI Weekly Statistical Supplement (static fallback)",
  },
  iip: {
    value: 5.2,
    date: "2025-01-01",
    source: "MOSPI IIP - Jan 2025 (static fallback)",
  },
  riskFreeRate: 6.96, // 10Y G-Sec yield (approx)
};

// ─── RBI DBIE API helpers ────────────────────────────────────

const RBI_BASE = "https://api.rbi.org.in/dbie";
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Attempt a JSON fetch from the RBI DBIE API.
 * Returns null if the API is unreachable or returns unexpected data.
 */
async function rbiFetch<T>(path: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(`${RBI_BASE}${path}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "UseMoney-Research/1.0",
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // Network error, timeout, or abort - expected for an unreliable endpoint
    return null;
  }
}

// ─── Individual Fetch Functions ──────────────────────────────

const CACHE_TTL_24H = 86_400; // 24 hours

/**
 * Fetch current RBI repo rate.
 * Tries RBI DBIE API first, falls back to static data.
 */
export async function fetchRepoRate(): Promise<MacroIndicator> {
  const cached = await cacheWrap<MacroIndicator>(
    "macro:repo_rate",
    async () => {
      // Attempt RBI DBIE API
      const data = await rbiFetch<Record<string, unknown>>(
        "/api/RbiWsApi/GetLatestMonetaryPolicyRates",
      );

      if (data && typeof data === "object") {
        // Try to extract repo rate from the response
        const records = (data as Record<string, unknown>).records;
        if (Array.isArray(records) && records.length > 0) {
          const latest = records[0] as Record<string, unknown>;
          const value = parseFloat(String(latest.rate || latest.value || ""));
          if (!isNaN(value)) {
            return {
              value,
              date: String(
                latest.date ||
                  latest.effectiveDate ||
                  new Date().toISOString().slice(0, 10),
              ),
              source: "RBI DBIE API",
            };
          }
        }
      }

      // Fallback to static
      return STATIC_MACRO.repoRate;
    },
    CACHE_TTL_24H,
  );

  return cached ?? STATIC_MACRO.repoRate;
}

/**
 * Fetch latest CPI inflation rate.
 */
export async function fetchInflationCPI(): Promise<MacroIndicator> {
  const cached = await cacheWrap<MacroIndicator>(
    "macro:cpi_inflation",
    async () => {
      const data = await rbiFetch<Record<string, unknown>>(
        "/api/RbiWsApi/GetCPIInflation",
      );

      if (data && typeof data === "object") {
        const records = (data as Record<string, unknown>).records;
        if (Array.isArray(records) && records.length > 0) {
          const latest = records[0] as Record<string, unknown>;
          const value = parseFloat(String(latest.value || latest.rate || ""));
          if (!isNaN(value)) {
            return {
              value,
              date: String(
                latest.date ||
                  latest.month ||
                  new Date().toISOString().slice(0, 10),
              ),
              source: "RBI DBIE API",
            };
          }
        }
      }

      return STATIC_MACRO.cpi;
    },
    CACHE_TTL_24H,
  );

  return cached ?? STATIC_MACRO.cpi;
}

/**
 * Fetch latest GDP growth rate.
 */
export async function fetchGDPGrowth(): Promise<MacroIndicatorWithQuarter> {
  const cached = await cacheWrap<MacroIndicatorWithQuarter>(
    "macro:gdp_growth",
    async () => {
      const data = await rbiFetch<Record<string, unknown>>(
        "/api/RbiWsApi/GetGDPGrowth",
      );

      if (data && typeof data === "object") {
        const records = (data as Record<string, unknown>).records;
        if (Array.isArray(records) && records.length > 0) {
          const latest = records[0] as Record<string, unknown>;
          const value = parseFloat(String(latest.value || latest.growth || ""));
          if (!isNaN(value)) {
            return {
              value,
              quarter: String(latest.quarter || latest.period || "Unknown"),
              source: "RBI DBIE API",
            };
          }
        }
      }

      return STATIC_MACRO.gdpGrowth;
    },
    CACHE_TTL_24H,
  );

  return cached ?? STATIC_MACRO.gdpGrowth;
}

/**
 * Fetch latest forex reserves figure.
 */
export async function fetchForexReserves(): Promise<MacroIndicatorWithUnit> {
  const cached = await cacheWrap<MacroIndicatorWithUnit>(
    "macro:forex_reserves",
    async () => {
      const data = await rbiFetch<Record<string, unknown>>(
        "/api/RbiWsApi/GetForexReserves",
      );

      if (data && typeof data === "object") {
        const records = (data as Record<string, unknown>).records;
        if (Array.isArray(records) && records.length > 0) {
          const latest = records[0] as Record<string, unknown>;
          const value = parseFloat(String(latest.value || latest.total || ""));
          if (!isNaN(value)) {
            return {
              value,
              unit: "USD Billion",
              date: String(
                latest.date ||
                  latest.weekEnding ||
                  new Date().toISOString().slice(0, 10),
              ),
              source: "RBI DBIE API",
            };
          }
        }
      }

      return STATIC_MACRO.forexReserves;
    },
    CACHE_TTL_24H,
  );

  return cached ?? STATIC_MACRO.forexReserves;
}

/**
 * Fetch all macro indicators in a single call.
 * Runs individual fetches in parallel for speed.
 */
export async function fetchMacroSnapshot(): Promise<MacroSnapshot> {
  const cached = await cacheWrap<MacroSnapshot>(
    "macro:snapshot",
    async () => {
      const [repoRate, cpi, gdpGrowth, forexReserves] = await Promise.all([
        fetchRepoRate(),
        fetchInflationCPI(),
        fetchGDPGrowth(),
        fetchForexReserves(),
      ]);

      // IIP - use static for now (no reliable DBIE endpoint)
      const iip = STATIC_MACRO.iip;

      // 10Y G-Sec yield - use static (would need a separate bond market API)
      const riskFreeRate = STATIC_MACRO.riskFreeRate;

      return {
        repoRate,
        cpi,
        gdpGrowth,
        forexReserves,
        iip,
        riskFreeRate,
      };
    },
    CACHE_TTL_24H,
  );

  return cached ?? STATIC_MACRO;
}
