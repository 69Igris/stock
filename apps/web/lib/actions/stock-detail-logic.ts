/**
 * Pure derivation helpers for the stock-detail data expansion (MONEY-796).
 *
 * Extracted from the "use server" actions + client components so the maths
 * (period-over-period %, upside-to-target, SMA position) is testable without
 * Prisma or a React render. The actions / components import these — there is
 * no shadow copy.
 *
 * Every helper is null-safe and finite-guarded: bad/missing inputs return
 * `null` instead of NaN / Infinity, matching the page's "real values only"
 * convention (poisoned rows must never reach the UI as "NaN%").
 */

/** Finite-number guard. Returns the number, or null for nullish / NaN / ±Inf. */
export function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Period-over-period percent change from `previous` → `latest`.
 *
 * Returns null when either side is missing/non-finite or when `previous` is
 * zero (the % is undefined / would divide-by-zero). A negative `previous`
 * (e.g. a loss-making prior quarter swinging to profit) is handled by scaling
 * against |previous| so the sign of the delta still reads correctly.
 */
export function periodOverPeriodPct(
  latest: number | null | undefined,
  previous: number | null | undefined
): number | null {
  const a = finiteOrNull(latest);
  const b = finiteOrNull(previous);
  if (a === null || b === null) return null;
  if (b === 0) return null;
  // Re-guard the RESULT: a finite-but-extreme input pair can still overflow to
  // ±Infinity (e.g. a huge numerator over a tiny denominator). The contract is
  // "never NaN / Infinity to the UI", so finite-check the output too.
  return finiteOrNull(((a - b) / Math.abs(b)) * 100);
}

/**
 * Upside-to-target percent: how far the current price is below (or above) a
 * third-party analyst target. Positive = target sits above current price.
 *
 * Pure DATA — the caller renders it as an informational figure, never advice.
 * Returns null on missing/non-finite inputs or a non-positive current price.
 */
export function upsideToTargetPct(
  currentPrice: number | null | undefined,
  targetPrice: number | null | undefined
): number | null {
  const cur = finiteOrNull(currentPrice);
  const tgt = finiteOrNull(targetPrice);
  if (cur === null || tgt === null) return null;
  if (cur <= 0) return null;
  // Re-guard the result against overflow (huge target / tiny price → Infinity).
  return finiteOrNull(((tgt - cur) / cur) * 100);
}

/** Where the price sits relative to a moving average. */
export type SmaPosition = "above" | "below" | "at" | null;

/**
 * Position of the current price relative to a simple moving average.
 * Descriptive only (above / below / at) — no buy/sell semantics.
 * Returns null when either input is missing/non-finite.
 */
export function smaPosition(
  price: number | null | undefined,
  sma: number | null | undefined
): SmaPosition {
  const p = finiteOrNull(price);
  const s = finiteOrNull(sma);
  if (p === null || s === null) return null;
  if (p > s) return "above";
  if (p < s) return "below";
  return "at";
}

/** Percent distance of the current price from a moving average. +above / −below. */
export function pctFromSma(
  price: number | null | undefined,
  sma: number | null | undefined
): number | null {
  const p = finiteOrNull(price);
  const s = finiteOrNull(sma);
  if (p === null || s === null || s <= 0) return null;
  // Re-guard the result against overflow (huge price / tiny SMA → Infinity).
  return finiteOrNull(((p - s) / s) * 100);
}

/**
 * Descriptive RSI zone label (educational, SEBI-neutral).
 * Standard 14-period bands: ≥70 "overbought", ≤30 "oversold", else "neutral".
 * These are textbook technical labels describing the indicator, not advice.
 */
export type RsiZone = "overbought" | "oversold" | "neutral" | null;
export function rsiZone(rsi: number | null | undefined): RsiZone {
  const v = finiteOrNull(rsi);
  if (v === null) return null;
  if (v >= 70) return "overbought";
  if (v <= 30) return "oversold";
  return "neutral";
}

// ── Period-aware financials ordering (MONEY-779) ─────────────────────────────
//
// `StockFinancials.period` is a free-form upstream STRING ("Q3-2024", "FY2024",
// "2024", "Mar 2024", …). Ordering by the raw string lexicographically is wrong
// — 'Q4-2023' sorts AHEAD of 'Q3-2024' and FY/Q rows interleave — so the DB
// `orderBy:{period:"desc"}` can't be trusted. The financials tab sorts each
// statement bucket with these helpers so it reads NEWEST-FIRST, which the QoQ/
// YoY delta (rows[0] vs rows[1]) and the latest-6 columns depend on.

/** Parsed (year, quarter) sort key for a financials period string. */
export interface ParsedPeriodKey {
  /** 4-digit year (calendar/fiscal), or null when no year is parseable. */
  year: number | null;
  /**
   * Quarter 1-4 when the period is quarterly, else null (annual / unknown).
   * Annual rows sort by year alone.
   */
  quarter: number | null;
}

/**
 * Parse a free-form financials `period` into a `(year, quarter)` sort key.
 * Robust to the shapes the upstream feeds emit:
 *   - Quarterly: "Q3-2024", "Q1 2025", "Q4 FY24", "Q2 FY2024" → quarter + year
 *   - Annual:    "FY2024", "FY 2024", "2024", "Mar 2024", "FY24" → year only
 * Two-digit years ("FY24") expand to 2000-relative. Returns
 * `{year:null, quarter:null}` for an unparseable string (those fall back to a
 * stable string compare in `comparePeriodsDesc`).
 */
export function parsePeriodKey(period: string): ParsedPeriodKey {
  const s = typeof period === "string" ? period.trim() : "";
  if (!s) return { year: null, quarter: null };

  // Quarter token: a standalone "Q<n>" (1-4).
  const qMatch = s.match(/Q\s*([1-4])\b/i);
  const quarter = qMatch ? Number(qMatch[1]) : null;

  // Year token: prefer a 4-digit year; else a trailing 2-digit one.
  const fourDigit = s.match(/(\d{4})/);
  let year: number | null = null;
  if (fourDigit) {
    year = Number(fourDigit[1]);
  } else {
    const twoDigit = s.match(/(\d{2})\b/);
    if (twoDigit) year = 2000 + Number(twoDigit[1]);
  }

  return { year, quarter };
}

/**
 * Newest-first comparator for two financials `period` strings. Higher year
 * first; within the same year, higher quarter first (a null quarter — annual or
 * un-quartered — sorts after a real quarter of that year). Unparseable years
 * fall back to a descending string compare so the order stays deterministic and
 * total. Use with `Array.prototype.sort`.
 */
export function comparePeriodsDesc(a: string, b: string): number {
  const ka = parsePeriodKey(a);
  const kb = parsePeriodKey(b);

  // Both unparseable → stable, deterministic string order (desc).
  if (ka.year === null && kb.year === null) return b.localeCompare(a);
  // A parseable year always outranks an unparseable one.
  if (ka.year === null) return 1;
  if (kb.year === null) return -1;

  if (ka.year !== kb.year) return kb.year - ka.year;

  // Same year: compare quarters, treating null as 0 (after Q1-Q4).
  const qa = ka.quarter ?? 0;
  const qb = kb.quarter ?? 0;
  if (qa !== qb) return qb - qa;

  // Fully tied on (year, quarter) → stable string order so sort is total.
  return b.localeCompare(a);
}
