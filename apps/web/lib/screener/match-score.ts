import {
  FUND_INSTRUMENT_TYPES,
  INDIA_DISCOVER_EXCHANGES,
} from "@usemoney/core/market-data/instruments/types";
/**
 * Match Score - pure function used by the screener to rank results.
 * Lives outside lib/actions/ so it can be unit-tested directly.
 */

export type MarketCapBucket = "LARGE" | "MID" | "SMALL";

/** Filter values exactly as the UI sidebar emits them. */
export interface ScreenFilters {
  exchange?: "NSE" | "BSE";
  sector?: string;
  /** Either use a preset bucket (Large/Mid/Small) or explicit min/max. */
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
  /** Index membership: "nifty50" | "nifty100" | "nifty500" | "midcap150"
   *  | "smallcap250" | "banknifty" | "niftyit". `"all"` / undefined is
   *  the no-op. Resolved at query time via `resolveIndexFilter`
   *  (apps/web/lib/screener/index-constituents.ts). */
  index?: string;
  limit?: number;
}

// Crore thresholds per design copy:
// Large: ₹20,000 Cr+ | Mid: 5,000–20,000 Cr | Small: <5,000 Cr
export const MCAP_BUCKETS: Record<
  MarketCapBucket,
  { min?: number; max?: number }
> = {
  LARGE: { min: 20_000 },
  MID: { min: 5_000, max: 20_000 },
  SMALL: { max: 5_000 },
};

/** Numeric band rule - "P/E between 10 and 20", "min AUM 1000 Cr". */
export interface NumericRule {
  min?: number;
  max?: number;
}

/** Categorical rule - "Category = Equity", "AMC in SBI/HDFC/Axis". */
export interface CategoricalRule {
  equals?: string | null;
  equalsAny?: readonly string[];
}

export type FilterRule = NumericRule | CategoricalRule;

/** Convenience for older callers that only want numeric bands. */
type FilterRange = NumericRule;

function isCategoricalRule(rule: FilterRule): rule is CategoricalRule {
  return "equals" in rule || "equalsAny" in rule;
}

/**
 * Per-filter distance score.
 *
 * **Numeric rules `{min?, max?}`:**
 *   - midpoint of a min/max band → 1
 *   - edge of a min/max band → 0.5
 *   - outside the band → 0
 *   - open-ended (min-only or max-only) and in-range → 1
 *   - no active filter (neither min nor max set) → null (excluded from the mean)
 *
 * **Categorical rules `{equals?, equalsAny?}`:**
 *   - exact match → 1
 *   - mismatch → 0
 *   - no active filter (equals == null AND equalsAny empty/missing) → null
 *
 * Null or wrong-type value → null (excluded from the mean).
 */
export function filterScore(
  value: number | string | null | undefined,
  rule: FilterRule
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
    return null; // no categorical filter active
  }

  // Numeric rule
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
    /** MONEY-779: optional — only the paths that select it pass it. When
     *  absent (undefined) the dividend-yield filter is excluded from the
     *  mean exactly like a null value, so older callers are unaffected. */
    dividendYield?: number | null;
  },
  filters: ScreenFilters
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

  // MONEY-779: dividend yield (percentage). `filterScore` returns null both
  // when the value is missing and when no min/max is set, so this is a no-op
  // unless the user actually set a dividend-yield band.
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

// ============== MF SCREENER (MONEY-196) ==============

/**
 * Filter set for the Mutual Funds mode of the Screener.
 *
 * - `category` is the AMFI taxonomy bucket (Large Cap, Mid Cap, Flexi Cap,
 *   ELSS, etc.) and lives on `MutualFundMaster.category`.
 * - `amcName` is matched against `MutualFundMaster.amcName` exactly. Use
 *   `amcAny` for OR-multi-select.
 * - `plan` is "DIRECT" | "REGULAR" - Direct plans skip distributor fees.
 * - `riskLevel` is the SEBI riskometer label ("Low" / "Moderate" / "High" /
 *   "Very High").
 * - `fundType` is "equity" | "debt" | "hybrid" | "solution" | "other".
 *
 * All numeric ranges are inclusive on both ends. AUM is in crores; returns
 * are percentages (e.g. 18.5 = 18.5%); expenseRatio is a percentage too.
 */
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

/**
 * Compute a 0-100 match score for an MF row against the active filters.
 * Mirrors `computeMatchScore` for stocks but on MF dimensions:
 *   - Categorical: category, amcName, plan, riskLevel, fundType
 *   - Numeric: aum, returns1Y / 3Y / 5Y, expenseRatio
 *
 * Same edge cases as the stocks helper:
 *   - No active filter → returns 100 (everything matches)
 *   - Row missing a value the filter cares about → that filter is excluded
 *     from the mean (it doesn't penalise the row)
 */
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
  filters: MfScreenFilters
): number {
  const scores: number[] = [];

  // Categorical
  const categoryScore = filterScore(row.category, {
    equals: filters.category ?? null,
  });
  if (categoryScore != null) scores.push(categoryScore);

  // AMC supports both single equals + multi equalsAny. equalsAny wins.
  const amcRule: CategoricalRule =
    filters.amcAny && filters.amcAny.length > 0
      ? { equalsAny: filters.amcAny }
      : { equals: filters.amcName ?? null };
  const amcScore = filterScore(row.amcName, amcRule);
  if (amcScore != null) scores.push(amcScore);

  const planScore = filterScore(row.plan, {
    equals: filters.plan ?? null,
  });
  if (planScore != null) scores.push(planScore);

  const riskScore = filterScore(row.riskLevel, {
    equals: filters.riskLevel ?? null,
  });
  if (riskScore != null) scores.push(riskScore);

  const fundTypeScore = filterScore(row.fundType, {
    equals: filters.fundType ?? null,
  });
  if (fundTypeScore != null) scores.push(fundTypeScore);

  // Numeric
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

// ============== ETF SCREENER (MONEY-196) ==============

/**
 * Filter set for the ETFs mode of the Screener.
 *
 * ETFs are sourced from `InstrumentMapping` (instrumentType="ETF") and
 * cross-joined with `MutualFundMaster` via ISIN to pick up AUM + returns +
 * expense ratio. The filter shape is intentionally narrower than MFs -
 * ETFs are largely commoditised and users mostly care about exposure
 * (asset class / sector) and cost (expense ratio) and 1Y return.
 *
 * - `assetClass` is a coarser bucket than MF category - typically
 *   "equity" | "debt" | "commodity" | "international" | "thematic".
 *   Stored as `fundType` on the joined MutualFundMaster row.
 * - `theme` is a free-text search applied to the ETF name (e.g. "Nifty
 *   IT", "Gold", "Pharma"). Normalised to lowercase.
 */
export interface EtfScreenFilters {
  exchange?: "NSE" | "BSE";
  assetClass?: string;
  theme?: string;
  /** ETF AMC / fund house - name-derived (no DB column today). The
   *  filter is applied post-fetch in `screenEtfsAction` against the
   *  prefix list in `etf-derive.ts`. */
  amcName?: string;
  /** Coarse category derived from the ETF name (Large Cap, Banking,
   *  Commodity, …). Same post-fetch filter path as `amcName`. */
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
 * Build the Mongo `where` clause for `screenMfsAction` from a filter set.
 *
 * Lives here (instead of in the server-action file) so it can be unit-tested
 * directly - server-action files can't be imported by node:test because of
 * the `"use server"` directive.
 *
 * The shape is intentionally `Record<string, unknown>` rather than the
 * Prisma type because importing the Prisma client into a pure-TS module
 * pulls in heavy generators and breaks the test harness.
 */
export function buildMfScreenWhere(
  filters: MfScreenFilters,
  query?: string
): Record<string, unknown> {
  // De-facto delisted filter: AMFI marks ~14k schemes as `isActive: true`,
  // but a large fraction are matured FMPs / wound-down schemes that
  // simply stopped publishing a NAV. Filtering to schemes that have
  // reported a NAV in the last 30 days drops the universe to the
  // ~1.7k actually-investable funds (matches prod's tab badge).
  const NAV_FRESHNESS_DAYS = 30;
  const stalenessCutoff = new Date(
    Date.now() - NAV_FRESHNESS_DAYS * 24 * 60 * 60 * 1000
  );
  const where: Record<string, unknown> = {
    isActive: true,
  };
  // MONEY-367: the NAV-freshness gate drops matured / wound-down schemes
  // (14k → ~1.7k investable in prod, matching the tab badge) — but it ONLY
  // works where NAVs are kept current. In dev/QA the seeded NAVs are stale, so
  // the gate zeroed the ENTIRE MF results table while the filter dropdowns
  // (which gate on isActive only) populated — a confusing prod-vs-dev split.
  // Skippable via SKIP_MF_NAV_GATE=1 (set in dev/QA); default keeps prod
  // behaviour. The durable fix is to mark matured schemes isActive:false in the
  // sync layer, after which this gate can go entirely.
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
  // SEBI riskometer is a 6-level scale (Low / Low to Moderate /
  // Moderate / Moderately High / High / Very High) but the UI
  // segments down to 3 buckets (Low / Med / High). The picker writes
  // one of "Low" / "Moderate" / "High" - expand each into the full
  // set of DB labels that fall in that bucket so the filter actually
  // matches funds. Without this, picking "Moderate" only returns
  // funds with the literal string "Moderate" (image #89: 0 matches).
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
      // Unknown bucket - pass through verbatim so callers can supply
      // an exact DB label if they ever need to.
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

/**
 * Build the Mongo `where` clause for the ETF screener's
 * InstrumentMapping query. The MF-side fields (AUM, returns, expense
 * ratio, fundType / assetClass) live on a separate join and are filtered
 * post-fetch, so this where only handles fields native to InstrumentMapping:
 * exchange, isActive, instrumentType=ETF, and an OR-search on symbol/name.
 */
export function buildEtfScreenWhere(
  filters: EtfScreenFilters,
  query?: string
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    isActive: true,
    // MONEY-1085 follow-up: REIT/INVIT screen alongside ETFs. Must stay in
    // lockstep with packages/services/src/screener.service.ts, which has the
    // same builder.
    // MONEY-1263 — scope to Indian venues. MONEY-980 moved US securities out
    // to `us_instruments`, so the "~7,600 US ETFs flood this screen" reason
    // this clause shipped with no longer applies. The clause STAYS: it is
    // independently correct (SUPPORTED_EXCHANGES also admits NFO/BFO/MCX,
    // which do not belong on an equity/ETF screen) and it is a standing guard
    // against this table being shared again. See INDIA_DISCOVER_EXCHANGES for
    // the full reasoning.
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

/** Compute a 0-100 match score for an ETF row against the active filters. */
export function computeEtfMatchScore(
  row: {
    exchange: string | null;
    assetClass: string | null;
    name: string | null;
    aum: number | null;
    returns1Y: number | null;
    expenseRatio: number | null;
  },
  filters: EtfScreenFilters
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

  // Theme is a substring search rather than an equality check. Score is
  // 1 (match) or 0 (miss); null when no theme filter is active.
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
