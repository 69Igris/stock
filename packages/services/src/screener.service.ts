/**
 * Screener Service (MONEY-1062 P4c — discovery-power parity).
 *
 * Faithful extraction of the three screener server actions for apps/api:
 *   - apps/web/lib/actions/screener.ts:290  `screenStocksAction`  → screenStocks
 *   - apps/web/lib/actions/screener.ts:927  `screenMfsAction`     → screenMfs
 *   - apps/web/lib/actions/screener.ts:1044 `screenEtfsAction`    → screenEtfs
 *
 * The web action pulls its pure helpers from three web-local modules that
 * `@usemoney/services` cannot import (`@/lib/...`):
 *   - apps/web/lib/screener/match-score.ts   (score/where builders + filter types)
 *   - apps/web/lib/screener/etf-derive.ts    (name-derived ETF AMC/category/class)
 *   - apps/web/lib/screener/index-constituents.ts (resolveIndexFilter + data)
 * They are pure and are ported VERBATIM below so the service is self-contained.
 * (The right long-term home is a shared package; that refactor is out of P4c's
 * file scope — web keeps its copy, this is the API-side twin.)
 *
 * DUAL-PATH env behaviour PRESERVED exactly:
 *   - `SKIP_MF_NAV_GATE=1` drops the 30-day NAV-freshness gate in the MF where
 *     (dev/QA have stale seeded NAVs; prod keeps the gate) — see buildMfScreenWhere.
 *   - the search path is InstrumentMapping regex (`contains`, insensitive) —
 *     the same regex path the web action runs; the Atlas path lives one layer
 *     down in getDiscoverData (untouched here).
 *
 * SCOPING: screener data is GLOBAL market data — no userId (mirrors the web
 * action, which has no auth/plan gate).
 *
 * IO SEAM: prisma + cache + getDiscoverData are injectable via `deps` so the
 * suite can drive the DB path deterministically (no Redis, controlled universe).
 *
 * @see packages/services/__tests__/parity-p4c-screener.service.test.ts
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { getCached, setCached } from "@usemoney/core";
// Subpath, NOT the root barrel: suites that swap `@usemoney/core` in the
// require cache model only `getCached`/`setCached`, so a root-barrel import of
// `singleFlight` would be `undefined` at call time there.
import { singleFlight } from "@usemoney/core/cache";
import type { ServiceResult } from "./types";
import { getDiscoverData } from "./discover.service";
import {
  FUND_INSTRUMENT_TYPES,
  INDIA_DISCOVER_EXCHANGES,
} from "@usemoney/core/market-data";
// MONEY-1157 — the sector predicate and its Mongo twin. These used to be a
// local pair here and an identical local pair in apps/web/lib/actions/screener.ts,
// kept "in lockstep" by comment. They were — right up until the FACETS
// (`buildSectorFacets`) learned to fold `Construction` into Industrials and
// `Textiles` into Consumer Discretionary and these two did not. The chips then
// over-reported by ~285 rows on prod (Industrials +40, Consumer Discretionary
// +8, Not Categorised +242): counted under a chip, not returned by it.
//
// The aliases keep every call site unchanged; the definitions live in ONE place
// so a future fold cannot reach the counts without reaching the filter. See
// `@usemoney/core/sector-taxonomy` for the branch-by-branch reasoning,
// including why the DB clause must be a SUPERSET of the predicate and why
// `{ sector: { isSet: false } }` cannot be replaced by a bare `$nin`.
import {
  matchesSectorFacet as sectorMatches,
  sectorFacetInstrumentWhere as sectorInstrumentFilter,
} from "@usemoney/core/sector-taxonomy";

// ════════════════════════════════════════════════════════════════════════════
// Ported pure helpers — match-score.ts (apps/web/lib/screener/match-score.ts)
// ════════════════════════════════════════════════════════════════════════════

export type MarketCapBucket = "LARGE" | "MID" | "SMALL";

/** Filter values exactly as the UI sidebar emits them. */
export interface ScreenFilters {
  exchange?: "NSE" | "BSE";
  sector?: string;
  marketCapBucket?: MarketCapBucket;
  minMarketCap?: number;
  maxMarketCap?: number;
  minPe?: number;
  maxPe?: number;
  minRoe?: number;
  maxRoe?: number;
  minRevenueGrowth?: number;
  maxRevenueGrowth?: number;
  minDebtToEquity?: number;
  maxDebtToEquity?: number;
  minDividendYield?: number;
  maxDividendYield?: number;
  /** Index membership id resolved via `resolveIndexFilter`. `"all"`/undefined = no-op. */
  index?: string;
  limit?: number;
}

// Crore thresholds: Large ₹20,000 Cr+ | Mid 5,000–20,000 Cr | Small <5,000 Cr
export const MCAP_BUCKETS: Record<
  MarketCapBucket,
  { min?: number; max?: number }
> = {
  LARGE: { min: 20_000 },
  MID: { min: 5_000, max: 20_000 },
  SMALL: { max: 5_000 },
};

export interface NumericRule {
  min?: number;
  max?: number;
}
export interface CategoricalRule {
  equals?: string | null;
  equalsAny?: readonly string[];
}
export type FilterRule = NumericRule | CategoricalRule;

function isCategoricalRule(rule: FilterRule): rule is CategoricalRule {
  return "equals" in rule || "equalsAny" in rule;
}

/**
 * Per-filter distance score (0..1) or null when the filter is inactive / the
 * value is missing (excluded from the mean). See match-score.ts for the full
 * numeric-band + categorical semantics.
 */
export function filterScore(
  value: number | string | null | undefined,
  rule: FilterRule,
): number | null {
  if (value == null) return null;

  if (isCategoricalRule(rule)) {
    const v = String(value);
    if (rule.equalsAny && rule.equalsAny.length > 0) {
      return rule.equalsAny.includes(v) ? 1 : 0;
    }
    if (rule.equals != null) {
      return v === rule.equals ? 1 : 0;
    }
    return null;
  }

  if (typeof value !== "number") return null;
  const hasMin = rule.min != null;
  const hasMax = rule.max != null;
  if (!hasMin && !hasMax) return null;

  if (hasMin && value < rule.min!) return 0;
  if (hasMax && value > rule.max!) return 0;

  if (hasMin && hasMax) {
    const mid = (rule.min! + rule.max!) / 2;
    const halfWidth = (rule.max! - rule.min!) / 2;
    const distance = Math.abs(value - mid);
    return Math.max(0, 1 - (distance / halfWidth) * 0.5);
  }
  return 1;
}

export function computeMatchScore(
  row: {
    pe: number | null;
    roe: number | null;
    revenueGrowth: number | null;
    debtToEquity: number | null;
    marketCap: number | null;
    dividendYield?: number | null;
  },
  filters: ScreenFilters,
): number {
  const scores: number[] = [];

  const peScore = filterScore(row.pe, {
    min: filters.minPe,
    max: filters.maxPe,
  });
  if (peScore != null) scores.push(peScore);

  const roeScore = filterScore(row.roe, {
    min: filters.minRoe,
    max: filters.maxRoe,
  });
  if (roeScore != null) scores.push(roeScore);

  const revScore = filterScore(row.revenueGrowth, {
    min: filters.minRevenueGrowth,
    max: filters.maxRevenueGrowth,
  });
  if (revScore != null) scores.push(revScore);

  const deScore = filterScore(row.debtToEquity, {
    min: filters.minDebtToEquity,
    max: filters.maxDebtToEquity,
  });
  if (deScore != null) scores.push(deScore);

  const effectiveMin = filters.marketCapBucket
    ? (MCAP_BUCKETS[filters.marketCapBucket].min ?? filters.minMarketCap)
    : filters.minMarketCap;
  const effectiveMax = filters.marketCapBucket
    ? (MCAP_BUCKETS[filters.marketCapBucket].max ?? filters.maxMarketCap)
    : filters.maxMarketCap;
  const mcapScore = filterScore(row.marketCap, {
    min: effectiveMin,
    max: effectiveMax,
  });
  if (mcapScore != null) scores.push(mcapScore);

  const divYieldScore = filterScore(row.dividendYield ?? null, {
    min: filters.minDividendYield,
    max: filters.maxDividendYield,
  });
  if (divYieldScore != null) scores.push(divYieldScore);

  if (scores.length === 0) return 100;
  const mean = scores.reduce((sum, v) => sum + v, 0) / scores.length;
  return Math.round(mean * 100);
}

/** Resolve effective min/max market cap from either a preset bucket or explicit values. */
export function resolveMarketCapRange(filters: ScreenFilters): {
  min?: number;
  max?: number;
} {
  if (filters.marketCapBucket) {
    const bucket = MCAP_BUCKETS[filters.marketCapBucket];
    return {
      min: bucket.min ?? filters.minMarketCap,
      max: bucket.max ?? filters.maxMarketCap,
    };
  }
  return { min: filters.minMarketCap, max: filters.maxMarketCap };
}

export interface MfScreenFilters {
  category?: string;
  amcName?: string;
  amcAny?: readonly string[];
  plan?: "DIRECT" | "REGULAR";
  riskLevel?: string;
  fundType?: string;
  minAum?: number;
  maxAum?: number;
  minReturns1Y?: number;
  maxReturns1Y?: number;
  minReturns3Y?: number;
  maxReturns3Y?: number;
  minReturns5Y?: number;
  maxReturns5Y?: number;
  minExpenseRatio?: number;
  maxExpenseRatio?: number;
  limit?: number;
}

export function computeMfMatchScore(
  row: {
    category: string | null;
    amcName: string | null;
    plan: string | null;
    riskLevel: string | null;
    fundType: string | null;
    aum: number | null;
    returns1Y: number | null;
    returns3Y: number | null;
    returns5Y: number | null;
    expenseRatio: number | null;
  },
  filters: MfScreenFilters,
): number {
  const scores: number[] = [];

  const categoryScore = filterScore(row.category, {
    equals: filters.category ?? null,
  });
  if (categoryScore != null) scores.push(categoryScore);

  const amcRule: CategoricalRule =
    filters.amcAny && filters.amcAny.length > 0
      ? { equalsAny: filters.amcAny }
      : { equals: filters.amcName ?? null };
  const amcScore = filterScore(row.amcName, amcRule);
  if (amcScore != null) scores.push(amcScore);

  const planScore = filterScore(row.plan, { equals: filters.plan ?? null });
  if (planScore != null) scores.push(planScore);

  const riskScore = filterScore(row.riskLevel, {
    equals: filters.riskLevel ?? null,
  });
  if (riskScore != null) scores.push(riskScore);

  const fundTypeScore = filterScore(row.fundType, {
    equals: filters.fundType ?? null,
  });
  if (fundTypeScore != null) scores.push(fundTypeScore);

  const aumScore = filterScore(row.aum, {
    min: filters.minAum,
    max: filters.maxAum,
  });
  if (aumScore != null) scores.push(aumScore);

  const r1Score = filterScore(row.returns1Y, {
    min: filters.minReturns1Y,
    max: filters.maxReturns1Y,
  });
  if (r1Score != null) scores.push(r1Score);

  const r3Score = filterScore(row.returns3Y, {
    min: filters.minReturns3Y,
    max: filters.maxReturns3Y,
  });
  if (r3Score != null) scores.push(r3Score);

  const r5Score = filterScore(row.returns5Y, {
    min: filters.minReturns5Y,
    max: filters.maxReturns5Y,
  });
  if (r5Score != null) scores.push(r5Score);

  const expScore = filterScore(row.expenseRatio, {
    min: filters.minExpenseRatio,
    max: filters.maxExpenseRatio,
  });
  if (expScore != null) scores.push(expScore);

  if (scores.length === 0) return 100;
  const mean = scores.reduce((sum, v) => sum + v, 0) / scores.length;
  return Math.round(mean * 100);
}

export interface EtfScreenFilters {
  exchange?: "NSE" | "BSE";
  assetClass?: string;
  theme?: string;
  amcName?: string;
  category?: string;
  minAum?: number;
  maxAum?: number;
  minReturns1Y?: number;
  maxReturns1Y?: number;
  minExpenseRatio?: number;
  maxExpenseRatio?: number;
  limit?: number;
}

/**
 * Build the Mongo `where` for the MF screener. The 30-day NAV-freshness gate
 * (14k → ~1.7k investable in prod) is skippable via `SKIP_MF_NAV_GATE=1` so
 * dev/QA (stale seeded NAVs) don't zero the results table — env behaviour
 * PRESERVED byte-for-byte from the web action.
 */
export function buildMfScreenWhere(
  filters: MfScreenFilters,
  query?: string,
): Record<string, unknown> {
  const NAV_FRESHNESS_DAYS = 30;
  const stalenessCutoff = new Date(
    Date.now() - NAV_FRESHNESS_DAYS * 24 * 60 * 60 * 1000,
  );
  const where: Record<string, unknown> = { isActive: true };
  if (process.env.SKIP_MF_NAV_GATE !== "1") {
    where.navDate = { gte: stalenessCutoff };
  }

  if (filters.category) where.category = filters.category;
  if (filters.amcAny && filters.amcAny.length > 0) {
    where.amcName = { in: [...filters.amcAny] };
  } else if (filters.amcName) {
    where.amcName = filters.amcName;
  }
  if (filters.plan) where.plan = filters.plan;
  if (filters.riskLevel) {
    const r = filters.riskLevel.toLowerCase();
    if (r === "low") {
      where.riskLevel = { in: ["Low", "Low to Moderate"] };
    } else if (r === "moderate" || r === "med") {
      where.riskLevel = {
        in: ["Low to Moderate", "Moderate", "Moderately High"],
      };
    } else if (r === "high") {
      where.riskLevel = { in: ["Moderately High", "High", "Very High"] };
    } else {
      where.riskLevel = filters.riskLevel;
    }
  }
  if (filters.fundType) where.fundType = filters.fundType;

  if (filters.minAum != null || filters.maxAum != null) {
    where.aum = {
      ...(filters.minAum != null ? { gte: filters.minAum } : {}),
      ...(filters.maxAum != null ? { lte: filters.maxAum } : {}),
    };
  }
  if (filters.minReturns1Y != null || filters.maxReturns1Y != null) {
    where.returns1Y = {
      ...(filters.minReturns1Y != null ? { gte: filters.minReturns1Y } : {}),
      ...(filters.maxReturns1Y != null ? { lte: filters.maxReturns1Y } : {}),
    };
  }
  if (filters.minReturns3Y != null || filters.maxReturns3Y != null) {
    where.returns3Y = {
      ...(filters.minReturns3Y != null ? { gte: filters.minReturns3Y } : {}),
      ...(filters.maxReturns3Y != null ? { lte: filters.maxReturns3Y } : {}),
    };
  }
  if (filters.minReturns5Y != null || filters.maxReturns5Y != null) {
    where.returns5Y = {
      ...(filters.minReturns5Y != null ? { gte: filters.minReturns5Y } : {}),
      ...(filters.maxReturns5Y != null ? { lte: filters.maxReturns5Y } : {}),
    };
  }
  if (filters.minExpenseRatio != null || filters.maxExpenseRatio != null) {
    where.expenseRatio = {
      ...(filters.minExpenseRatio != null
        ? { gte: filters.minExpenseRatio }
        : {}),
      ...(filters.maxExpenseRatio != null
        ? { lte: filters.maxExpenseRatio }
        : {}),
    };
  }

  const trimmedQuery = query?.trim() ?? "";
  if (trimmedQuery) {
    where.OR = [
      { schemeName: { contains: trimmedQuery, mode: "insensitive" } },
      { amcName: { contains: trimmedQuery, mode: "insensitive" } },
    ];
  }

  return where;
}

/** Build the Mongo `where` for the ETF screener's InstrumentMapping query. */
export function buildEtfScreenWhere(
  filters: EtfScreenFilters,
  query?: string,
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    isActive: true,
    // MONEY-1085 follow-up: REIT/INVIT screen alongside ETFs (all are
    // exchange-traded funds/trusts, not operating companies).
    // MONEY-1263 — scope to Indian venues. `instrument_mappings` is now
    // SHARED with the US master (~7,600 active US ETFs against India's
    // ~541), and without a venue clause this surface fills with US names.
    // Scoped by EXCHANGE, not `market`: that attribute is ABSENT on every
    // pre-existing India row, so `{market: "IN"}` matches ZERO.
    exchange: { in: [...INDIA_DISCOVER_EXCHANGES] },
    instrumentType: { in: [...FUND_INSTRUMENT_TYPES] },
  };
  if (filters.exchange) where.exchange = filters.exchange;
  const trimmedQuery = query?.trim() ?? "";
  if (trimmedQuery) {
    where.OR = [
      { symbol: { startsWith: trimmedQuery.toUpperCase() } },
      { name: { contains: trimmedQuery, mode: "insensitive" } },
    ];
  }
  return where;
}

export function computeEtfMatchScore(
  row: {
    exchange: string | null;
    assetClass: string | null;
    name: string | null;
    aum: number | null;
    returns1Y: number | null;
    expenseRatio: number | null;
  },
  filters: EtfScreenFilters,
): number {
  const scores: number[] = [];

  const exchangeScore = filterScore(row.exchange, {
    equals: filters.exchange ?? null,
  });
  if (exchangeScore != null) scores.push(exchangeScore);

  const assetClassScore = filterScore(row.assetClass, {
    equals: filters.assetClass ?? null,
  });
  if (assetClassScore != null) scores.push(assetClassScore);

  if (filters.theme) {
    const themeLower = filters.theme.toLowerCase();
    const nameLower = row.name?.toLowerCase() ?? "";
    scores.push(nameLower.includes(themeLower) ? 1 : 0);
  }

  const aumScore = filterScore(row.aum, {
    min: filters.minAum,
    max: filters.maxAum,
  });
  if (aumScore != null) scores.push(aumScore);

  const r1Score = filterScore(row.returns1Y, {
    min: filters.minReturns1Y,
    max: filters.maxReturns1Y,
  });
  if (r1Score != null) scores.push(r1Score);

  const expScore = filterScore(row.expenseRatio, {
    min: filters.minExpenseRatio,
    max: filters.maxExpenseRatio,
  });
  if (expScore != null) scores.push(expScore);

  if (scores.length === 0) return 100;
  const mean = scores.reduce((sum, v) => sum + v, 0) / scores.length;
  return Math.round(mean * 100);
}

// ════════════════════════════════════════════════════════════════════════════
// Ported pure helpers — etf-derive.ts (apps/web/lib/screener/etf-derive.ts)
// ════════════════════════════════════════════════════════════════════════════

const ETF_FUND_HOUSES = [
  "NIPPON INDIA",
  "SBI",
  "HDFC",
  "ICICI PRUDENTIAL",
  "KOTAK",
  "MOTILAL OSWAL",
  "EDELWEISS",
  "ADITYA BIRLA",
  "UTI",
  "AXIS",
  "MIRAE ASSET",
  "DSP",
  "TATA",
  "INVESCO",
  "BANDHAN",
  "PGIM",
  "QUANTUM",
  "LIC",
  "CPSE",
  "BHARAT",
  "GROWW",
] as const;

const titleCase = (s: string): string =>
  s
    .split(" ")
    .filter(Boolean)
    .map((w) => (w[0] ?? "") + w.slice(1).toLowerCase())
    .join(" ");

/** Best-effort fund-house extraction from an ETF instrument name. */
export function extractEtfFundHouse(name: string): string {
  const cleaned = name.replace(/^["']+|["']+$/g, "").trim();
  const upper = cleaned.toUpperCase();
  for (const h of ETF_FUND_HOUSES) {
    if (upper.startsWith(h)) return titleCase(h);
  }
  const idx = upper.indexOf(" ETF");
  if (idx > 0) return titleCase(cleaned.substring(0, idx).trim());
  return "Other";
}

/** Best-effort category derivation from an ETF instrument name. */
export function deriveEtfCategory(name: string): string {
  const n = name.toUpperCase();
  if (n.includes("GOLD") || n.includes("SILVER")) return "Commodity";
  if (n.includes("LIQUID") || n.includes("OVERNIGHT")) return "Liquid";
  if (
    n.includes("GILT") ||
    n.includes("BOND") ||
    n.includes("DEBT") ||
    n.includes("SDL")
  )
    return "Debt";
  if (
    n.includes("NIFTY 50") ||
    n.includes("SENSEX") ||
    n.includes("NIFTY NEXT 50")
  )
    return "Large Cap";
  if (
    n.includes("MIDCAP") ||
    n.includes("MID CAP") ||
    n.includes("NIFTY MIDSMALL")
  )
    return "Mid Cap";
  if (n.includes("SMALLCAP") || n.includes("SMALL CAP")) return "Small Cap";
  if (
    n.includes("BANK") ||
    n.includes("FINANCIAL") ||
    n.includes("PRIVATE BANK") ||
    n.includes("PSU BANK")
  )
    return "Banking";
  if (n.includes(" IT ") || n.match(/\bIT\b/)) return "Technology";
  if (n.includes("PHARMA") || n.includes("HEALTHCARE")) return "Healthcare";
  if (n.includes("INFRA")) return "Infrastructure";
  if (n.includes("CONSUMPTION") || n.includes("FMCG")) return "Consumption";
  if (n.includes("ENERGY") || n.includes("OIL") || n.includes("GAS"))
    return "Energy";
  if (n.includes("AUTO")) return "Auto";
  if (n.includes("METAL")) return "Metal";
  if (n.includes("REALTY") || n.includes("REAL ESTATE")) return "Real Estate";
  if (n.includes("NASDAQ") || n.includes("HANG SENG") || n.includes("S&P 500"))
    return "International";
  return "Other";
}

/** Derive the canonical asset class from an ETF instrument name. */
export function deriveEtfAssetClass(name: string): string {
  const n = name.toUpperCase();
  if (
    n.includes("GILT") ||
    n.includes("BOND") ||
    n.includes(" DEBT") ||
    n.includes("SDL") ||
    n.includes("LIQUID") ||
    n.includes("OVERNIGHT") ||
    n.includes("PSU BOND")
  )
    return "debt";
  if (n.includes("HYBRID") || n.includes("BALANCED ADVANTAGE")) return "hybrid";
  if (n.includes("TARGET MATURITY") || n.includes("RETIREMENT"))
    return "solution";
  if (n.includes("GOLD") || n.includes("SILVER") || n.includes("COMMODITY"))
    return "other";
  return "equity";
}

// ════════════════════════════════════════════════════════════════════════════
// Ported pure helpers — index-constituents.ts (resolveIndexFilter + data)
// ════════════════════════════════════════════════════════════════════════════

const NIFTY_50: readonly string[] = [
  "RELIANCE",
  "HDFCBANK",
  "ICICIBANK",
  "INFY",
  "TCS",
  "BHARTIARTL",
  "ITC",
  "SBIN",
  "LT",
  "HINDUNILVR",
  "AXISBANK",
  "BAJFINANCE",
  "KOTAKBANK",
  "MARUTI",
  "M&M",
  "ASIANPAINT",
  "TITAN",
  "SUNPHARMA",
  "HCLTECH",
  "ULTRACEMCO",
  "TATAMOTORS",
  "WIPRO",
  "ONGC",
  "POWERGRID",
  "NTPC",
  "TATASTEEL",
  "ADANIPORTS",
  "ADANIENT",
  "JSWSTEEL",
  "COALINDIA",
  "GRASIM",
  "HINDALCO",
  "BAJAJFINSV",
  "TECHM",
  "DRREDDY",
  "CIPLA",
  "INDUSINDBK",
  "BPCL",
  "EICHERMOT",
  "NESTLEIND",
  "HEROMOTOCO",
  "BRITANNIA",
  "DIVISLAB",
  "APOLLOHOSP",
  "SHREECEM",
  "BAJAJ-AUTO",
  "TATACONSUM",
  "SBILIFE",
  "HDFCLIFE",
  "LTIM",
];
const BANK_NIFTY: readonly string[] = [
  "HDFCBANK",
  "ICICIBANK",
  "AXISBANK",
  "SBIN",
  "KOTAKBANK",
  "INDUSINDBK",
  "BANKBARODA",
  "PNB",
  "BANDHANBNK",
  "FEDERALBNK",
  "AUBANK",
  "IDFCFIRSTB",
];
const NIFTY_PSU_BANK: readonly string[] = [
  "SBIN",
  "BANKBARODA",
  "PNB",
  "CANBK",
  "UNIONBANK",
  "INDIANB",
  "BANKINDIA",
  "IOB",
  "CENTRALBK",
  "MAHABANK",
  "PSB",
  "UCOBANK",
];
const NIFTY_PRIVATE_BANK: readonly string[] = [
  "HDFCBANK",
  "ICICIBANK",
  "AXISBANK",
  "KOTAKBANK",
  "INDUSINDBK",
  "BANDHANBNK",
  "FEDERALBNK",
  "AUBANK",
  "IDFCFIRSTB",
  "RBLBANK",
];
const NIFTY_AUTO: readonly string[] = [
  "M&M",
  "MARUTI",
  "TATAMOTORS",
  "BAJAJ-AUTO",
  "EICHERMOT",
  "HEROMOTOCO",
  "TVSMOTOR",
  "BOSCHLTD",
  "MOTHERSON",
  "MRF",
  "ASHOKLEY",
  "BALKRISIND",
  "BHARATFORG",
  "EXIDEIND",
  "TIINDIA",
];
const NIFTY_REALTY: readonly string[] = [
  "DLF",
  "GODREJPROP",
  "OBEROIRLTY",
  "PRESTIGE",
  "PHOENIXLTD",
  "BRIGADE",
  "MAHLIFE",
  "SOBHA",
  "LODHA",
  "SUNTECK",
];
const NIFTY_CONSUMPTION: readonly string[] = [
  "HINDUNILVR",
  "ITC",
  "NESTLEIND",
  "BRITANNIA",
  "TATACONSUM",
  "TITAN",
  "ASIANPAINT",
  "BERGEPAINT",
  "DABUR",
  "MARICO",
  "GODREJCP",
  "COLPAL",
  "VBL",
  "UBL",
  "MCDOWELL-N",
];
const NIFTY_INFRA: readonly string[] = [
  "RELIANCE",
  "BHARTIARTL",
  "LT",
  "POWERGRID",
  "NTPC",
  "ADANIPORTS",
  "ULTRACEMCO",
  "GRASIM",
  "ONGC",
  "BPCL",
  "GAIL",
  "IOC",
  "ADANIPOWER",
  "TATAPOWER",
  "JSWENERGY",
  "ADANIGREEN",
  "PFC",
  "RECLTD",
  "INDIGO",
];
const NIFTY_IT: readonly string[] = [
  "TCS",
  "INFY",
  "WIPRO",
  "HCLTECH",
  "TECHM",
  "LTIM",
  "MPHASIS",
  "PERSISTENT",
  "COFORGE",
  "LTTS",
];
const NIFTY_PHARMA: readonly string[] = [
  "SUNPHARMA",
  "DRREDDY",
  "CIPLA",
  "DIVISLAB",
  "TORNTPHARM",
  "AUROPHARMA",
  "LUPIN",
  "ZYDUSLIFE",
  "ALKEM",
  "BIOCON",
  "GLENMARK",
  "ABBOTINDIA",
  "GLAND",
  "IPCALAB",
  "LAURUSLABS",
];
const NIFTY_FMCG: readonly string[] = [
  "HINDUNILVR",
  "ITC",
  "NESTLEIND",
  "BRITANNIA",
  "TATACONSUM",
  "DABUR",
  "MARICO",
  "GODREJCP",
  "COLPAL",
  "VBL",
  "UBL",
  "MCDOWELL-N",
  "EMAMILTD",
  "JYOTHYLAB",
];
const NIFTY_METAL: readonly string[] = [
  "TATASTEEL",
  "JSWSTEEL",
  "HINDALCO",
  "VEDL",
  "JINDALSTEL",
  "SAIL",
  "NMDC",
  "COALINDIA",
  "HINDZINC",
  "NATIONALUM",
  "APLAPOLLO",
  "JINDALSAW",
  "WELCORP",
  "MOIL",
  "RATNAMANI",
];
const NIFTY_ENERGY: readonly string[] = [
  "RELIANCE",
  "ONGC",
  "POWERGRID",
  "NTPC",
  "BPCL",
  "IOC",
  "GAIL",
  "ADANIPOWER",
  "TATAPOWER",
  "ADANIGREEN",
  "JSWENERGY",
  "HINDPETRO",
  "OIL",
  "GUJGASLTD",
  "PETRONET",
];
const NIFTY_MEDIA: readonly string[] = [
  "ZEEL",
  "SUNTV",
  "PVRINOX",
  "NAZARA",
  "DISHTV",
  "TV18BRDCST",
  "NETWORK18",
  "SAREGAMA",
  "TIPSINDLTD",
];
const NIFTY_OIL_AND_GAS: readonly string[] = [
  "RELIANCE",
  "ONGC",
  "BPCL",
  "IOC",
  "GAIL",
  "HINDPETRO",
  "OIL",
  "PETRONET",
  "MGL",
  "GUJGASLTD",
  "AEGISLOG",
  "CASTROLIND",
  "GSPL",
];
const NIFTY_FIN_SERVICES: readonly string[] = [
  "HDFCBANK",
  "ICICIBANK",
  "AXISBANK",
  "SBIN",
  "KOTAKBANK",
  "BAJFINANCE",
  "BAJAJFINSV",
  "INDUSINDBK",
  "SBILIFE",
  "HDFCLIFE",
  "ICICIPRULI",
  "ICICIGI",
  "CHOLAFIN",
  "MUTHOOTFIN",
  "RECLTD",
  "PFC",
  "SHRIRAMFIN",
  "HDFCAMC",
];
const NIFTY_HEALTHCARE: readonly string[] = [
  "SUNPHARMA",
  "DRREDDY",
  "CIPLA",
  "DIVISLAB",
  "APOLLOHOSP",
  "MAXHEALTH",
  "TORNTPHARM",
  "AUROPHARMA",
  "LUPIN",
  "ZYDUSLIFE",
  "ALKEM",
  "BIOCON",
  "GLENMARK",
  "FORTIS",
  "METROPOLIS",
];
const NIFTY_COMMODITIES: readonly string[] = [
  "RELIANCE",
  "TATASTEEL",
  "JSWSTEEL",
  "HINDALCO",
  "ULTRACEMCO",
  "GRASIM",
  "VEDL",
  "COALINDIA",
  "ONGC",
  "NMDC",
  "ASIANPAINT",
  "BERGEPAINT",
  "PIDILITIND",
  "AMBUJACEM",
  "ACC",
  "SHREECEM",
];
const NIFTY_PSE: readonly string[] = [
  "ONGC",
  "POWERGRID",
  "NTPC",
  "COALINDIA",
  "BPCL",
  "IOC",
  "GAIL",
  "SBIN",
  "BANKBARODA",
  "PNB",
  "PFC",
  "RECLTD",
  "NMDC",
  "SAIL",
  "HINDPETRO",
  "OIL",
  "BHEL",
  "BEL",
  "HAL",
  "CONCOR",
];
const NIFTY_CPSE: readonly string[] = [
  "POWERGRID",
  "NTPC",
  "COALINDIA",
  "ONGC",
  "BPCL",
  "GAIL",
  "PFC",
  "RECLTD",
  "NMDC",
  "OIL",
  "BHEL",
  "NLCINDIA",
];
const NIFTY_MNC: readonly string[] = [
  "HINDUNILVR",
  "NESTLEIND",
  "BOSCHLTD",
  "AMBUJACEM",
  "BRITANNIA",
  "COLPAL",
  "ABBOTINDIA",
  "MARUTI",
  "BAYERCROP",
  "PFIZER",
  "CASTROLIND",
  "PROCTER",
];
const NIFTY_DIVIDEND_OPP_50: readonly string[] = [
  "ONGC",
  "COALINDIA",
  "POWERGRID",
  "NTPC",
  "ITC",
  "BPCL",
  "IOC",
  "GAIL",
  "VEDL",
  "TCS",
  "INFY",
  "HINDUNILVR",
  "SBIN",
  "WIPRO",
  "HEROMOTOCO",
];

const STATIC_INDICES: Record<string, readonly string[]> = {
  nifty50: NIFTY_50,
  banknifty: BANK_NIFTY,
  niftypsubank: NIFTY_PSU_BANK,
  niftyprivatebank: NIFTY_PRIVATE_BANK,
  niftyauto: NIFTY_AUTO,
  niftyit: NIFTY_IT,
  niftypharma: NIFTY_PHARMA,
  niftyfmcg: NIFTY_FMCG,
  niftymetal: NIFTY_METAL,
  niftyenergy: NIFTY_ENERGY,
  niftymedia: NIFTY_MEDIA,
  niftyoilgas: NIFTY_OIL_AND_GAS,
  niftyfinservice: NIFTY_FIN_SERVICES,
  niftyhealthcare: NIFTY_HEALTHCARE,
  niftycommodities: NIFTY_COMMODITIES,
  niftyrealty: NIFTY_REALTY,
  niftyconsumption: NIFTY_CONSUMPTION,
  niftyinfra: NIFTY_INFRA,
  niftypse: NIFTY_PSE,
  niftycpse: NIFTY_CPSE,
  niftymnc: NIFTY_MNC,
  niftydivopp50: NIFTY_DIVIDEND_OPP_50,
};

const SECTOR_INDEX_MAP: Record<string, string> = {
  niftyit: "Information Technology",
  niftypharma: "Healthcare",
  niftyhealthcare: "Healthcare",
  niftyfmcg: "FMCG",
  niftymetal: "Commodities",
  niftyenergy: "Energy",
  niftyoilgas: "Energy",
  niftymedia: "Telecommunication",
  niftyfinservice: "Financial Services",
  // MONEY-1093 — Nifty Realty maps onto the Real Estate sector, which became
  // canonical on 2026-07-30. Before that there was no sector to point it at.
  niftyrealty: "Real Estate",
};

export interface McapRankSpec {
  start: number;
  end: number;
}

const MCAP_RANK_SPECS: Record<string, McapRankSpec> = {
  niftynext50: { start: 51, end: 100 },
  nifty100: { start: 1, end: 100 },
  nifty200: { start: 1, end: 200 },
  nifty500: { start: 1, end: 500 },
  niftylargemid250: { start: 1, end: 250 },
  niftymidcap50: { start: 101, end: 150 },
  niftymidcap100: { start: 101, end: 200 },
  niftymidcap150: { start: 101, end: 250 },
  niftysmallcap50: { start: 251, end: 300 },
  niftysmallcap100: { start: 251, end: 350 },
  niftysmallcap250: { start: 251, end: 500 },
  niftymidsmall400: { start: 101, end: 500 },
  niftytotalmarket: { start: 1, end: 750 },
  niftymicrocap250: { start: 501, end: 750 },
};

export type IndexFilterKind = "static" | "mcap-rank" | "sector" | "all";

export interface IndexFilterResolution {
  kind: IndexFilterKind;
  symbols?: readonly string[];
  rank?: McapRankSpec;
  sector?: string;
}

/**
 * Resolve an index id into a constituent resolution strategy. Static lists win
 * over sector/mcap-rank; unknown/"all"/undefined → kind "all" (skip filter).
 */
export function resolveIndexFilter(
  indexId: string | undefined | null,
): IndexFilterResolution {
  if (!indexId || indexId === "all") return { kind: "all" };
  const stat = STATIC_INDICES[indexId];
  if (stat) return { kind: "static", symbols: stat };
  const sector = SECTOR_INDEX_MAP[indexId];
  if (sector) return { kind: "sector", sector };
  const rank = MCAP_RANK_SPECS[indexId];
  if (rank) return { kind: "mcap-rank", rank };
  return { kind: "all" };
}

// ════════════════════════════════════════════════════════════════════════════
// Service result types (mirror the web action return shapes)
// ════════════════════════════════════════════════════════════════════════════

export interface ScreenResult {
  symbol: string;
  exchange: string;
  name: string;
  sector: string | null;
  ltp: number | null;
  changePercent: number | null;
  marketCap: number | null;
  pe: number | null;
  roe: number | null;
  revenueGrowth: number | null;
  debtToEquity: number | null;
  matchScore: number;
}

export type StockSortKey =
  | "match"
  | "mcap-desc"
  | "mcap-asc"
  | "change-desc"
  | "change-asc"
  | "name-asc"
  | "name-desc";

export type FundSortKey =
  | "match"
  | "nav-desc"
  | "nav-asc"
  | "aum-desc"
  | "ret1y-desc"
  | "ret3y-desc"
  | "ret5y-desc";

export interface PageOpts {
  page?: number;
  pageSize?: number;
  sort?: StockSortKey | FundSortKey;
}

export interface PagedResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EtfScreenResult {
  symbol: string;
  exchange: string;
  name: string;
  yahooSymbol: string;
  ltp: number | null;
  changePercent: number | null;
  aum: number | null;
  returns1Y: number | null;
  expenseRatio: number | null;
  assetClass: string | null;
  matchScore: number;
}

export interface MfScreenResult {
  schemeCode: string;
  schemeName: string;
  amcName: string;
  category: string;
  plan: string | null;
  fundType: string | null;
  riskLevel: string | null;
  nav: number;
  navDate: Date;
  aum: number | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  expenseRatio: number | null;
  matchScore: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

const CACHE_NS = "discover";
const CACHE_SCOPE = "_global";
const CACHE_TTL = 5 * 60;

/** Cache seam — get returns the cached full ranked list (or null); set stores it. */
export interface ScreenerCache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
}

/** Injectable IO seam (ESM suite passes fakes via `deps`, not module mocks). */
export interface ScreenerServiceDeps {
  prisma?: typeof prisma;
  cache?: ScreenerCache;
  getDiscoverData?: typeof getDiscoverData;
}

/**
 * Read-through with stampede protection (MONEY-1131).
 *
 * All three screener entry points share the same shape — cache-first, else run
 * the (unbounded) DB path and store the full ranked list. Without a flight,
 * every concurrent request that arrives on an expired key runs its OWN full
 * scan. The key is the cache identifier, so only requests that would have
 * produced the SAME list collapse.
 *
 * The cache seam stays injectable, so the suite still drives get/set directly.
 */
async function resolveRanked<T>(
  cache: ScreenerCache,
  flightPrefix: string,
  cacheKey: string,
  compute: () => Promise<T[]>,
): Promise<T[]> {
  const cached = await cache.get<T[]>(cacheKey);
  if (cached) return cached;

  return singleFlight(`${flightPrefix}:${cacheKey}`, async () => {
    // Re-read inside the flight — the request we queued behind may have just
    // populated it.
    const again = await cache.get<T[]>(cacheKey);
    if (again) return again;

    const fresh = await compute();
    await cache.set(cacheKey, fresh);
    return fresh;
  });
}

function defaultCache(): ScreenerCache {
  return {
    get: <T>(key: string) =>
      getCached<T>(CACHE_NS, CACHE_SCOPE, key, undefined, { ttl: CACHE_TTL }),
    set: async <T>(key: string, value: T) => {
      await setCached(CACHE_NS, CACHE_SCOPE, key, value, undefined, {
        ttl: CACHE_TTL,
      });
    },
  };
}

// ── Sector helpers (MONEY-1157) ──────────────────────────────────────
//
// `sectorMatches` / `sectorInstrumentFilter` are no longer defined here — they
// are aliased at the top of this file to `matchesSectorFacet` /
// `sectorFacetInstrumentWhere` in `@usemoney/core/sector-taxonomy`, which is
// also what `buildSectorFacets` counts with. See the import for why.

/**
 * Resolve the screener `index` filter into a symbol allow-list. DB
 * `IndexConstituent` wins; else static / sector / mcap-rank fallback.
 * Returns null for "all"/undefined (caller skips the filter).
 */
async function resolveIndexSymbols(
  db: typeof prisma,
  indexId: string | undefined,
): Promise<readonly string[] | null> {
  if (!indexId || indexId === "all") return null;

  try {
    const dbRows = await db.indexConstituent.findMany({
      where: { indexId },
      orderBy: { rank: "asc" },
      select: { symbol: true },
    });
    if (dbRows.length > 0) return dbRows.map((r) => r.symbol);
  } catch {
    // Table may not exist yet on first deploy — fall through.
  }

  const resolved = resolveIndexFilter(indexId);
  if (resolved.kind === "all") return null;
  if (resolved.kind === "static") return resolved.symbols ?? null;
  if (resolved.kind === "sector" && resolved.sector) {
    const tagged = await db.instrumentMapping.findMany({
      where: {
        sector: resolved.sector,
        isActive: true,
        instrumentType: "EQUITY",
      },
      select: { symbol: true },
    });
    return tagged.map((r) => r.symbol);
  }
  if (resolved.kind === "mcap-rank" && resolved.rank) {
    const { start, end } = resolved.rank;
    const ranked = await db.stockRatios.findMany({
      where: { marketCap: { not: null } },
      orderBy: { marketCap: "desc" },
      skip: Math.max(0, start - 1),
      take: Math.max(0, end - start + 1),
      select: { symbol: true },
    });
    return ranked.map((r) => r.symbol);
  }
  return null;
}

function applyStockSort(rows: ScreenResult[], sort: StockSortKey): void {
  switch (sort) {
    case "mcap-desc":
      rows.sort(
        (a, b) => (b.marketCap ?? -Infinity) - (a.marketCap ?? -Infinity),
      );
      break;
    case "mcap-asc":
      rows.sort(
        (a, b) => (a.marketCap ?? Infinity) - (b.marketCap ?? Infinity),
      );
      break;
    case "change-desc":
      rows.sort(
        (a, b) =>
          (b.changePercent ?? -Infinity) - (a.changePercent ?? -Infinity),
      );
      break;
    case "change-asc":
      rows.sort(
        (a, b) => (a.changePercent ?? Infinity) - (b.changePercent ?? Infinity),
      );
      break;
    case "name-asc":
      rows.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "name-desc":
      rows.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case "match":
    default:
      rows.sort((a, b) => b.matchScore - a.matchScore);
      break;
  }
}

function applyFundSort<
  T extends {
    matchScore: number;
    nav?: number | null;
    ltp?: number | null;
    aum?: number | null;
    returns1Y?: number | null;
    returns3Y?: number | null;
    returns5Y?: number | null;
    schemeName?: string;
    name?: string;
  },
>(rows: T[], sort: FundSortKey): void {
  const num = (v: number | null | undefined): number =>
    v != null && Number.isFinite(v) ? v : 0;
  switch (sort) {
    case "nav-desc":
      rows.sort((a, b) => num(b.nav ?? b.ltp) - num(a.nav ?? a.ltp));
      break;
    case "nav-asc":
      rows.sort((a, b) => num(a.nav ?? a.ltp) - num(b.nav ?? b.ltp));
      break;
    case "aum-desc":
      rows.sort((a, b) => num(b.aum) - num(a.aum));
      break;
    case "ret1y-desc":
      rows.sort((a, b) => num(b.returns1Y) - num(a.returns1Y));
      break;
    case "ret3y-desc":
      rows.sort((a, b) => num(b.returns3Y) - num(a.returns3Y));
      break;
    case "ret5y-desc":
      rows.sort((a, b) => num(b.returns5Y) - num(a.returns5Y));
      break;
    case "match":
    default:
      rows.sort((a, b) => b.matchScore - a.matchScore);
      break;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// STOCKS
// ════════════════════════════════════════════════════════════════════════════

function hasFundamentalFilter(filters: ScreenFilters): boolean {
  return (
    filters.minPe != null ||
    filters.maxPe != null ||
    filters.minRoe != null ||
    filters.maxRoe != null ||
    filters.minRevenueGrowth != null ||
    filters.maxRevenueGrowth != null ||
    filters.minDebtToEquity != null ||
    filters.maxDebtToEquity != null ||
    filters.marketCapBucket != null ||
    filters.minMarketCap != null ||
    filters.maxMarketCap != null ||
    filters.minDividendYield != null ||
    filters.maxDividendYield != null
  );
}

interface UniverseRow {
  instrumentId: string;
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  price: number | null;
  changePercent: number | null;
}

async function ratiosFirstPath(
  db: typeof prisma,
  filters: ScreenFilters,
): Promise<ScreenResult[]> {
  const { min: effectiveMinMcap, max: effectiveMaxMcap } =
    resolveMarketCapRange(filters);

  const ratioWhere: Record<string, unknown> = {};
  if (filters.minPe != null || filters.maxPe != null) {
    ratioWhere.pe = {
      ...(filters.minPe != null ? { gte: filters.minPe } : {}),
      ...(filters.maxPe != null ? { lte: filters.maxPe } : {}),
    };
  }
  if (filters.minRoe != null || filters.maxRoe != null) {
    ratioWhere.roe = {
      ...(filters.minRoe != null ? { gte: filters.minRoe } : {}),
      ...(filters.maxRoe != null ? { lte: filters.maxRoe } : {}),
    };
  }
  if (filters.minRevenueGrowth != null || filters.maxRevenueGrowth != null) {
    ratioWhere.revenueGrowth = {
      ...(filters.minRevenueGrowth != null
        ? { gte: filters.minRevenueGrowth }
        : {}),
      ...(filters.maxRevenueGrowth != null
        ? { lte: filters.maxRevenueGrowth }
        : {}),
    };
  }
  if (filters.minDebtToEquity != null || filters.maxDebtToEquity != null) {
    ratioWhere.debtToEquity = {
      ...(filters.minDebtToEquity != null
        ? { gte: filters.minDebtToEquity }
        : {}),
      ...(filters.maxDebtToEquity != null
        ? { lte: filters.maxDebtToEquity }
        : {}),
    };
  }
  if (filters.minDividendYield != null || filters.maxDividendYield != null) {
    ratioWhere.dividendYield = {
      ...(filters.minDividendYield != null
        ? { gte: filters.minDividendYield }
        : {}),
      ...(filters.maxDividendYield != null
        ? { lte: filters.maxDividendYield }
        : {}),
    };
  }
  if (effectiveMinMcap != null || effectiveMaxMcap != null) {
    ratioWhere.marketCap = {
      ...(effectiveMinMcap != null ? { gte: effectiveMinMcap } : {}),
      ...(effectiveMaxMcap != null ? { lte: effectiveMaxMcap } : {}),
    };
  }
  if (filters.exchange) {
    ratioWhere.exchange = filters.exchange;
  }

  const indexSymbols = await resolveIndexSymbols(db, filters.index);
  if (indexSymbols !== null) {
    if (indexSymbols.length === 0) return [];
    ratioWhere.symbol = { in: indexSymbols };
  }

  // MONEY-1131 — sector goes into the query, not a post-fetch pass.
  // `instrument` is a REQUIRED to-one relation, so `is` is the correct form.
  const sectorFilter = sectorInstrumentFilter(filters.sector);
  if (sectorFilter) {
    ratioWhere.instrument = { is: sectorFilter };
  }

  const ratios = await db.stockRatios.findMany({
    where: ratioWhere,
    orderBy: { marketCap: "desc" },
    select: {
      symbol: true,
      exchange: true,
      pe: true,
      roe: true,
      revenueGrowth: true,
      debtToEquity: true,
      marketCap: true,
      dividendYield: true,
      instrument: {
        select: {
          name: true,
          sector: true,
          latestQuote: { select: { price: true, changePercent: true } },
        },
      },
    },
  });

  // `sectorMatches` stays the AUTHORITY on what the chip means and runs as a
  // final pass over the (now already narrowed) rows: the DB clause above can
  // only be equal or looser, so the pushdown provably cannot change the visible
  // result set — it only stops the wrong rows crossing the wire.
  const filtered = filters.sector
    ? ratios.filter((r) => sectorMatches(r.instrument?.sector, filters.sector))
    : ratios;

  return filtered.map((r) => ({
    symbol: r.symbol,
    exchange: r.exchange,
    name: r.instrument?.name ?? r.symbol,
    sector: r.instrument?.sector ?? null,
    ltp: r.instrument?.latestQuote?.price ?? null,
    changePercent: r.instrument?.latestQuote?.changePercent ?? null,
    marketCap: r.marketCap,
    pe: r.pe,
    roe: r.roe,
    revenueGrowth: r.revenueGrowth,
    debtToEquity: r.debtToEquity,
    matchScore: computeMatchScore(r, filters),
  }));
}

async function fallbackInstrumentUniverse(
  db: typeof prisma,
): Promise<UniverseRow[]> {
  const instruments = await db.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
    },
    select: {
      id: true,
      symbol: true,
      name: true,
      exchange: true,
      sector: true,
    },
  });

  const filtered = instruments.filter((inst) => {
    const n = inst.name.toUpperCase();
    return (
      !n.includes("MUTUAL FUND") &&
      !n.includes("MF -") &&
      !n.includes("MUTUAL FD")
    );
  });

  const quoteMap = new Map<
    string,
    { price: number; changePercent: number | null }
  >();
  try {
    const quotes = await db.latestQuote.findMany({
      select: { instrumentId: true, price: true, changePercent: true },
    });
    for (const q of quotes) {
      quoteMap.set(q.instrumentId, {
        price: q.price,
        changePercent: q.changePercent,
      });
    }
  } catch {
    // ignore — rows render with null LTP/Δ
  }

  return filtered.map((inst) => {
    const q = quoteMap.get(inst.id);
    return {
      instrumentId: inst.id,
      symbol: inst.symbol,
      name: inst.name,
      exchange: inst.exchange,
      sector: inst.sector ?? null,
      price: q?.price ?? null,
      changePercent: q?.changePercent ?? null,
    };
  });
}

async function instrumentsFirstPath(
  db: typeof prisma,
  discoverFn: typeof getDiscoverData,
  filters: ScreenFilters,
): Promise<ScreenResult[]> {
  const discover = await discoverFn();
  let stocks: UniverseRow[] =
    discover.success && discover.data
      ? discover.data.allStocks.map((s) => ({
          instrumentId: s.instrumentId,
          symbol: s.symbol,
          name: s.name,
          exchange: s.exchange,
          sector: s.sector ?? null,
          price: s.price,
          changePercent: s.changePercent,
        }))
      : [];

  if (stocks.length === 0) {
    stocks = await fallbackInstrumentUniverse(db);
  }

  if (filters.exchange) {
    stocks = stocks.filter((s) => s.exchange === filters.exchange);
  }
  if (filters.sector) {
    stocks = stocks.filter((s) => sectorMatches(s.sector, filters.sector));
  }
  const indexSymbolsForInstUniverse = await resolveIndexSymbols(
    db,
    filters.index,
  );
  if (indexSymbolsForInstUniverse !== null) {
    if (indexSymbolsForInstUniverse.length === 0) return [];
    const allow = new Set(indexSymbolsForInstUniverse);
    stocks = stocks.filter((s) => allow.has(s.symbol));
  }
  if (stocks.length === 0) return [];

  const ids = stocks.map((s) => s.instrumentId);
  const ratios = await db.stockRatios.findMany({
    where: { instrumentId: { in: ids } },
    select: {
      instrumentId: true,
      pe: true,
      roe: true,
      revenueGrowth: true,
      debtToEquity: true,
      marketCap: true,
    },
  });
  const ratioMap = new Map(ratios.map((r) => [r.instrumentId, r]));

  return stocks.map((s) => {
    const r = ratioMap.get(s.instrumentId);
    return {
      symbol: s.symbol,
      exchange: s.exchange,
      name: s.name,
      sector: s.sector ?? null,
      ltp: s.price,
      changePercent: s.changePercent,
      marketCap: r?.marketCap ?? null,
      pe: r?.pe ?? null,
      roe: r?.roe ?? null,
      revenueGrowth: r?.revenueGrowth ?? null,
      debtToEquity: r?.debtToEquity ?? null,
      matchScore: 100,
    };
  });
}

async function filterFirstPath(
  db: typeof prisma,
  discoverFn: typeof getDiscoverData,
  filters: ScreenFilters,
): Promise<ScreenResult[]> {
  if (hasFundamentalFilter(filters)) {
    return ratiosFirstPath(db, filters);
  }
  return instrumentsFirstPath(db, discoverFn, filters);
}

async function searchFirstPath(
  db: typeof prisma,
  filters: ScreenFilters,
  query: string,
): Promise<ScreenResult[]> {
  const qLower = query.toLowerCase();
  const qUpper = query.toUpperCase();

  const instrumentWhere: Record<string, unknown> = {
    isActive: true,
    instrumentType: "EQUITY",
    OR: [
      { symbol: { startsWith: qUpper } },
      { name: { contains: query, mode: "insensitive" } },
    ],
  };
  if (filters.exchange) {
    instrumentWhere.exchange = filters.exchange;
  }

  const indexSymbolsForInst = await resolveIndexSymbols(db, filters.index);
  if (indexSymbolsForInst !== null) {
    if (indexSymbolsForInst.length === 0) return [];
    instrumentWhere.symbol = { in: indexSymbolsForInst };
  }

  const instruments = await db.instrumentMapping.findMany({
    where: instrumentWhere,
    take: 2000,
    orderBy: { symbol: "asc" },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      name: true,
      sector: true,
      latestQuote: { select: { price: true, changePercent: true } },
    },
  });

  if (instruments.length === 0) return [];

  const instIds = instruments.map((i) => i.id);
  const ratios = await db.stockRatios.findMany({
    where: { instrumentId: { in: instIds } },
    select: {
      instrumentId: true,
      pe: true,
      roe: true,
      revenueGrowth: true,
      debtToEquity: true,
      marketCap: true,
      dividendYield: true,
    },
  });
  const ratioMap = new Map(ratios.map((r) => [r.instrumentId, r]));

  const sectorFiltered = filters.sector
    ? instruments.filter((i) => sectorMatches(i.sector, filters.sector))
    : instruments;

  const hasAnyFundamentalFilter =
    filters.minPe != null ||
    filters.maxPe != null ||
    filters.minRoe != null ||
    filters.maxRoe != null ||
    filters.minRevenueGrowth != null ||
    filters.maxRevenueGrowth != null ||
    filters.minDebtToEquity != null ||
    filters.maxDebtToEquity != null ||
    filters.marketCapBucket != null ||
    filters.minMarketCap != null ||
    filters.maxMarketCap != null ||
    filters.minDividendYield != null ||
    filters.maxDividendYield != null;

  const { min: effectiveMinMcap, max: effectiveMaxMcap } =
    resolveMarketCapRange(filters);

  const fundamentalFiltered = hasAnyFundamentalFilter
    ? sectorFiltered.filter((inst) => {
        const r = ratioMap.get(inst.id);
        if (!r) return false;
        if (filters.minPe != null && (r.pe == null || r.pe < filters.minPe))
          return false;
        if (filters.maxPe != null && (r.pe == null || r.pe > filters.maxPe))
          return false;
        if (filters.minRoe != null && (r.roe == null || r.roe < filters.minRoe))
          return false;
        if (filters.maxRoe != null && (r.roe == null || r.roe > filters.maxRoe))
          return false;
        if (
          filters.minRevenueGrowth != null &&
          (r.revenueGrowth == null ||
            r.revenueGrowth < filters.minRevenueGrowth)
        )
          return false;
        if (
          filters.maxRevenueGrowth != null &&
          (r.revenueGrowth == null ||
            r.revenueGrowth > filters.maxRevenueGrowth)
        )
          return false;
        if (
          filters.minDebtToEquity != null &&
          (r.debtToEquity == null || r.debtToEquity < filters.minDebtToEquity)
        )
          return false;
        if (
          filters.maxDebtToEquity != null &&
          (r.debtToEquity == null || r.debtToEquity > filters.maxDebtToEquity)
        )
          return false;
        if (
          effectiveMinMcap != null &&
          (r.marketCap == null || r.marketCap < effectiveMinMcap)
        )
          return false;
        if (
          effectiveMaxMcap != null &&
          (r.marketCap == null || r.marketCap > effectiveMaxMcap)
        )
          return false;
        if (
          filters.minDividendYield != null &&
          (r.dividendYield == null ||
            r.dividendYield < filters.minDividendYield)
        )
          return false;
        if (
          filters.maxDividendYield != null &&
          (r.dividendYield == null ||
            r.dividendYield > filters.maxDividendYield)
        )
          return false;
        return true;
      })
    : sectorFiltered;

  const scored: ScreenResult[] = fundamentalFiltered.map((inst) => {
    const r = ratioMap.get(inst.id);
    const symLower = inst.symbol.toLowerCase();
    const nameLower = inst.name.toLowerCase();

    let matchScore: number;
    if (symLower === qLower) matchScore = 100;
    else if (nameLower.startsWith(qLower)) matchScore = 90;
    else if (symLower.startsWith(qLower)) matchScore = 85;
    else if (nameLower.includes(qLower)) matchScore = 70;
    else matchScore = r ? computeMatchScore(r, filters) : 50;

    return {
      symbol: inst.symbol,
      exchange: inst.exchange,
      name: inst.name,
      sector: inst.sector ?? null,
      ltp: inst.latestQuote?.price ?? null,
      changePercent: inst.latestQuote?.changePercent ?? null,
      marketCap: r?.marketCap ?? null,
      pe: r?.pe ?? null,
      roe: r?.roe ?? null,
      revenueGrowth: r?.revenueGrowth ?? null,
      debtToEquity: r?.debtToEquity ?? null,
      matchScore,
    };
  });

  return scored;
}

/** Screen stocks. Global (no userId), cached full ranked list, in-memory paging. */
export async function screenStocks(
  filters: ScreenFilters = {},
  query?: string,
  paging: PageOpts = {},
  deps: ScreenerServiceDeps = {},
): Promise<ServiceResult<PagedResult<ScreenResult>>> {
  const db = deps.prisma ?? prisma;
  const cache = deps.cache ?? defaultCache();
  const discoverFn = deps.getDiscoverData ?? getDiscoverData;

  const trimmedQuery = query?.trim() ?? "";
  const page = Math.max(0, paging.page ?? 0);
  const pageSize = Math.min(
    Math.max(1, paging.pageSize ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const sort = (paging.sort as StockSortKey | undefined) ?? "match";

  try {
    const cacheIdent = JSON.stringify({ ...filters, q: trimmedQuery, sort });
    const cacheKey = `screener:v3:${cacheIdent}`;
    const ranked = await resolveRanked<ScreenResult>(
      cache,
      "screener:stocks",
      cacheKey,
      async () => {
        const fresh = trimmedQuery
          ? await searchFirstPath(db, filters, trimmedQuery)
          : await filterFirstPath(db, discoverFn, filters);
        applyStockSort(fresh, sort);
        return fresh;
      },
    );

    const start = page * pageSize;
    const rows = ranked.slice(start, start + pageSize);
    return {
      success: true,
      data: { rows, total: ranked.length, page, pageSize },
    };
  } catch (error) {
    logger.error({ error }, "screenStocks service error");
    return { success: false, error: "Failed to run screener" };
  }
}

/** Screen mutual funds. Global, cached full ranked list, in-memory paging. */
export async function screenMfs(
  filters: MfScreenFilters = {},
  query?: string,
  paging: PageOpts = {},
  deps: ScreenerServiceDeps = {},
): Promise<ServiceResult<PagedResult<MfScreenResult>>> {
  const db = deps.prisma ?? prisma;
  const cache = deps.cache ?? defaultCache();

  const trimmedQuery = query?.trim() ?? "";
  const page = Math.max(0, paging.page ?? 0);
  const pageSize = Math.min(
    Math.max(1, paging.pageSize ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const sort = (paging.sort as FundSortKey | undefined) ?? "match";

  try {
    const cacheIdent = JSON.stringify({ ...filters, q: trimmedQuery, sort });
    const cacheKey = `screener-mf:v2:${cacheIdent}`;
    const ranked = await resolveRanked<MfScreenResult>(
      cache,
      "screener:mf",
      cacheKey,
      async () => {
        const where = buildMfScreenWhere(filters, trimmedQuery);
        const candidates = await db.mutualFundMaster.findMany({
          where,
          orderBy: [{ aum: "desc" }],
          select: {
            schemeCode: true,
            schemeName: true,
            amcName: true,
            category: true,
            plan: true,
            fundType: true,
            riskLevel: true,
            nav: true,
            navDate: true,
            aum: true,
            returns1Y: true,
            returns3Y: true,
            returns5Y: true,
            expenseRatio: true,
          },
        });

        const fresh: MfScreenResult[] = candidates.map((c) => ({
          schemeCode: c.schemeCode,
          schemeName: c.schemeName,
          amcName: c.amcName,
          category: c.category,
          plan: c.plan,
          fundType: c.fundType,
          riskLevel: c.riskLevel,
          nav: c.nav,
          navDate: c.navDate,
          aum: c.aum,
          returns1Y: c.returns1Y,
          returns3Y: c.returns3Y,
          returns5Y: c.returns5Y,
          expenseRatio: c.expenseRatio,
          matchScore: computeMfMatchScore(c, filters),
        }));
        applyFundSort(fresh, sort);
        return fresh;
      },
    );

    const start = page * pageSize;
    const rows = ranked.slice(start, start + pageSize);
    return {
      success: true,
      data: { rows, total: ranked.length, page, pageSize },
    };
  } catch (error) {
    logger.error({ error }, "screenMfs service error");
    return { success: false, error: "Failed to run mutual fund screener" };
  }
}

/** Screen ETFs. Global, cached full ranked list, in-memory paging. */
export async function screenEtfs(
  filters: EtfScreenFilters = {},
  query?: string,
  paging: PageOpts = {},
  deps: ScreenerServiceDeps = {},
): Promise<ServiceResult<PagedResult<EtfScreenResult>>> {
  const db = deps.prisma ?? prisma;
  const cache = deps.cache ?? defaultCache();

  const trimmedQuery = query?.trim() ?? "";
  const page = Math.max(0, paging.page ?? 0);
  const pageSize = Math.min(
    Math.max(1, paging.pageSize ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const sort = (paging.sort as FundSortKey | undefined) ?? "match";

  try {
    const cacheIdent = JSON.stringify({ ...filters, q: trimmedQuery, sort });
    const cacheKey = `screener-etf:v2:${cacheIdent}`;
    const ranked = await resolveRanked<EtfScreenResult>(
      cache,
      "screener:etf",
      cacheKey,
      () => computeEtfRanked(db, filters, trimmedQuery, sort),
    );

    const start = page * pageSize;
    return {
      success: true,
      data: {
        rows: ranked.slice(start, start + pageSize),
        total: ranked.length,
        page,
        pageSize,
      },
    };
  } catch (error) {
    logger.error({ error }, "screenEtfs service error");
    return { success: false, error: "Failed to run ETF screener" };
  }
}

/**
 * The ETF ranked-list builder, lifted verbatim out of `screenEtfs` so it can be
 * handed to `resolveRanked` (MONEY-1131). Row-for-row identical to the previous
 * inline body; the only change is that an EMPTY result is now cached like any
 * other rather than re-queried on every request.
 */
async function computeEtfRanked(
  db: typeof prisma,
  filters: EtfScreenFilters,
  trimmedQuery: string,
  sort: FundSortKey,
): Promise<EtfScreenResult[]> {
  const where = buildEtfScreenWhere(filters, trimmedQuery);
  const instruments = await db.instrumentMapping.findMany({
    where,
    take: 2000,
    orderBy: { symbol: "asc" },
    select: {
      id: true,
      symbol: true,
      name: true,
      exchange: true,
      yahooSymbol: true,
      isin: true,
    },
  });

  if (instruments.length === 0) return [];

  const instIds = instruments.map((i) => i.id);
  const quotes = await db.latestQuote.findMany({
    where: { instrumentId: { in: instIds }, previousClose: { gt: 0 } },
    select: {
      instrumentId: true,
      price: true,
      changePercent: true,
      marketCap: true,
    },
  });
  const quoteMap = new Map(quotes.map((q) => [q.instrumentId, q]));

  const isins = instruments.map((i) => i.isin).filter(Boolean) as string[];
  const mfRows =
    isins.length > 0
      ? await db.mutualFundMaster.findMany({
          where: {
            OR: [
              { isinGrowth: { in: isins } },
              { isinDividend: { in: isins } },
            ],
          },
          select: {
            isinGrowth: true,
            isinDividend: true,
            aum: true,
            returns1Y: true,
            expenseRatio: true,
            fundType: true,
          },
        })
      : [];
  const mfMap = new Map<
    string,
    {
      aum: number | null;
      returns1Y: number | null;
      expenseRatio: number | null;
      fundType: string | null;
    }
  >();
  for (const mf of mfRows) {
    const data = {
      aum: mf.aum,
      returns1Y: mf.returns1Y,
      expenseRatio: mf.expenseRatio,
      fundType: mf.fundType,
    };
    if (mf.isinGrowth) mfMap.set(mf.isinGrowth, data);
    if (mf.isinDividend) mfMap.set(mf.isinDividend, data);
  }

  const merged: Array<{
    inst: (typeof instruments)[number];
    quote: {
      price: number;
      changePercent: number | null;
      marketCap: number | null;
    };
    mf: {
      aum: number | null;
      returns1Y: number | null;
      expenseRatio: number | null;
      fundType: string | null;
    } | null;
    effectiveAum: number | null;
  }> = [];
  for (const inst of instruments) {
    const quote = quoteMap.get(inst.id);
    if (!quote) continue;
    const mf = inst.isin ? (mfMap.get(inst.isin) ?? null) : null;
    const effectiveAum = mf?.aum ?? quote.marketCap ?? null;

    if (filters.assetClass) {
      const effectiveClass = mf?.fundType ?? deriveEtfAssetClass(inst.name);
      if (effectiveClass !== filters.assetClass) continue;
    }

    if (filters.theme) {
      const themeLower = filters.theme.toLowerCase();
      if (!inst.name.toLowerCase().includes(themeLower)) continue;
    }

    if (filters.amcName) {
      const derivedAmc = extractEtfFundHouse(inst.name);
      if (derivedAmc.toLowerCase() !== filters.amcName.toLowerCase()) continue;
    }

    if (filters.category) {
      const derivedCategory = deriveEtfCategory(inst.name);
      if (derivedCategory.toLowerCase() !== filters.category.toLowerCase())
        continue;
    }

    if (
      filters.minAum != null &&
      effectiveAum != null &&
      effectiveAum < filters.minAum
    )
      continue;
    if (
      filters.maxAum != null &&
      effectiveAum != null &&
      effectiveAum > filters.maxAum
    )
      continue;

    if (
      filters.minReturns1Y != null &&
      mf?.returns1Y != null &&
      mf.returns1Y < filters.minReturns1Y
    )
      continue;
    if (
      filters.maxReturns1Y != null &&
      mf?.returns1Y != null &&
      mf.returns1Y > filters.maxReturns1Y
    )
      continue;
    if (
      filters.minExpenseRatio != null &&
      mf?.expenseRatio != null &&
      mf.expenseRatio < filters.minExpenseRatio
    )
      continue;
    if (
      filters.maxExpenseRatio != null &&
      mf?.expenseRatio != null &&
      mf.expenseRatio > filters.maxExpenseRatio
    )
      continue;

    merged.push({
      inst,
      quote: {
        price: quote.price,
        changePercent: quote.changePercent,
        marketCap: quote.marketCap ?? null,
      },
      mf,
      effectiveAum,
    });
  }

  const scored: EtfScreenResult[] = merged.map(
    ({ inst, quote, mf, effectiveAum }) => ({
      symbol: inst.symbol,
      exchange: inst.exchange,
      name: inst.name,
      yahooSymbol: inst.yahooSymbol,
      ltp: quote.price,
      changePercent: quote.changePercent,
      aum: effectiveAum,
      returns1Y: mf?.returns1Y ?? null,
      expenseRatio: mf?.expenseRatio ?? null,
      assetClass: mf?.fundType ?? deriveEtfAssetClass(inst.name),
      matchScore: computeEtfMatchScore(
        {
          exchange: inst.exchange,
          assetClass: mf?.fundType ?? deriveEtfAssetClass(inst.name),
          name: inst.name,
          aum: effectiveAum,
          returns1Y: mf?.returns1Y ?? null,
          expenseRatio: mf?.expenseRatio ?? null,
        },
        filters,
      ),
    }),
  );

  const ranked = scored;
  applyFundSort(ranked, sort);
  return ranked;
}
