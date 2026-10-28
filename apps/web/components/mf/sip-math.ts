/**
 * SIP / Lumpsum future-value helpers for the Fund detail calculator
 * (MONEY-245), shared with the ETF detail calculator.
 *
 * Extracted out of `SipCalculator.tsx` so the formulas can be unit-tested
 * under `node:test` without dragging in the React component (which imports
 * `./detail-playful.css` — a side-effect import node:test/tsx can't parse).
 * `SipCalculator.tsx` re-imports these helpers, so the widget keeps using the
 * exact same math and renders identically.
 *
 * MONEY-1162: the SIP formula is NO LONGER restated here. It used to carry its
 * own copy of the annuity formula, which made this module a second source of
 * truth for money math — a packaging workaround (dodging a CSS import) had
 * quietly become a place the product could disagree with itself. When
 * `/calculators` moved to SEBI's end-of-month convention, this copy would have
 * kept the old start-of-month one, so ₹5,000/mo at 12% over 5 years would read
 * ₹4,08,348 on the calculators page and ₹4,12,432 on every fund and ETF page.
 *
 * `computeSipFutureValue` now delegates to `calcSip` from `@usemoney/core/calc`
 * — the single SIP primitive — and only adapts the shape: positional args,
 * this widget's 1-month floor, and its `estimatedValue` field name.
 *
 * Lumpsum has no contribution schedule, so no annuity convention applies to it;
 * that formula legitimately lives here.
 *   FV = P × (1 + r)^n
 *   P = upfront amount
 *   r = annualReturn / 12 / 100
 *   n = years × 12
 */

import { calcSip } from "@usemoney/core/calc";

export interface SipFutureValue {
  invested: number;
  estimatedValue: number;
  gain: number;
}

/** Compute SIP future value for a fixed monthly contribution. */
export function computeSipFutureValue(
  monthly: number,
  years: number,
  annualReturnPct: number
): SipFutureValue {
  // This widget floors at one month, where calcSip treats a zero duration as
  // an empty plan. Resolve the month count here, then hand calcSip a duration
  // whose own Math.round(durationYears * 12) reproduces it exactly.
  const months = Math.max(1, Math.round(years * 12));
  const invested = monthly * months;

  const { finalValue } = calcSip({
    monthly,
    annualReturnPct,
    durationYears: months / 12,
  });

  // Guard retained: an extreme return can overflow Math.pow to Infinity, and
  // the widget shows the invested amount rather than "₹Infinity".
  const estimatedValue = Number.isFinite(finalValue) ? finalValue : invested;
  return {
    invested,
    estimatedValue,
    gain: estimatedValue - invested,
  };
}

/** Compute Lumpsum future value for a single upfront deposit. */
export function computeLumpsumFutureValue(
  upfront: number,
  years: number,
  annualReturnPct: number
): SipFutureValue {
  const months = Math.max(1, Math.round(years * 12));
  const r = annualReturnPct / 100 / 12;
  const invested = upfront;
  const fv = r === 0 ? invested : upfront * Math.pow(1 + r, months);
  const estimatedValue = Number.isFinite(fv) ? fv : invested;
  return {
    invested,
    estimatedValue,
    gain: estimatedValue - invested,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ETF extensions — MONEY-1211.
//
// `components/etf/EtfSipCalculator.tsx` was a 520-line FORK of the MF
// calculator built on pre-playful, dark-only Tailwind (`bg-white/[0.06]`,
// `bg-white/[0.03]`, `bg-white/[0.02]`, an unthemed result card) so it was
// broken in light mode and had no dark result card, and it labelled the "₹
// amount" input with a DOLLAR icon. Its lumpsum branch also re-derived
// `computeLumpsumFutureValue` inline, and its invested/gain split called
// `clamp(0, 100, pct)` against a `clamp(v, lo, hi)` signature — arguments
// transposed, so the bar read 100% invested / 0% gain at every input.
//
// Only three things in that file were genuinely ETF-specific. They live here,
// pure and testable; everything else was duplication and is deleted.
// ─────────────────────────────────────────────────────────────────────────

/** Format ₹ with Indian magnitude suffixes. */
export function formatInr(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}k`;
  return `₹${n.toFixed(0)}`;
}

/** Format a unit count (ETF mode). */
export function formatUnits(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M units`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k units`;
  return `${n.toFixed(0)} units`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Is this LTP usable for ₹↔units conversion?
 *
 * `null`, `undefined`, `NaN`, `Infinity` and `0` are all ABSENCE of a price —
 * never a price of zero. A 0 here would divide the projected-unit count to
 * Infinity, and `Number("")` is 0, so a blank upstream field reaches this
 * function looking exactly like a free ETF.
 */
export function isUsableLtp(ltp: number | null | undefined): ltp is number {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0;
}

/**
 * Default expected annual return per ETF asset class. Equity uses the
 * conventional long-run assumption (~12%), which is also the MF default when
 * no asset class is supplied at all. An explicit override always wins.
 */
export function seedReturnFor(
  assetClass: string | null | undefined,
  override: number | null | undefined
): number {
  if (override != null && Number.isFinite(override)) {
    return clamp(override, 1, 30);
  }
  const lower = (assetClass ?? "").toLowerCase();
  if (
    lower.includes("debt") ||
    lower.includes("bond") ||
    lower.includes("gilt")
  ) {
    return 7;
  }
  if (lower.includes("international") || lower.includes("global")) {
    return 10;
  }
  if (lower.includes("commodity") || lower.includes("gold")) {
    return 9;
  }
  return 12;
}

/**
 * Tax-treatment footnote tuned to the ETF's asset class. Short and factual —
 * no recommendation language. Post-2024 rules (Finance Act 2023 + 2024).
 * Returns null when there is no asset class to reason about (the MF caller),
 * because a wrong tax note is worse than no tax note.
 */
export function taxNoteFor(
  assetClass: string | null | undefined
): string | null {
  const raw = (assetClass ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower.includes("debt") ||
    lower.includes("bond") ||
    lower.includes("gilt")
  ) {
    return "Debt ETFs: gains taxed at your slab rate (no indexation for units bought after 31 Mar 2023).";
  }
  if (lower.includes("international") || lower.includes("global")) {
    return "International ETFs: LTCG (>24m) 12.5% without indexation; STCG taxed at slab rate (post 23 Jul 2024).";
  }
  if (lower.includes("gold") || lower.includes("commodity")) {
    return "Gold / commodity ETFs: LTCG (>24m) 12.5% without indexation; STCG taxed at slab rate.";
  }
  return "Equity ETFs: STCG (<12m) 20%; LTCG (>12m) 12.5% above ₹1.25L annual exemption.";
}

/**
 * Units the projected corpus buys at today's LTP, held constant (the
 * "indicative only" footnote covers the simplification). Null — never 0 —
 * when the LTP cannot support the conversion: 0 units is a claim, absence is
 * not.
 */
export function projectedUnitsFor(
  investedRupees: number,
  ltp: number | null | undefined
): number | null {
  if (!isUsableLtp(ltp)) return null;
  if (!Number.isFinite(investedRupees)) return null;
  return investedRupees / ltp;
}

/**
 * The invested share of the projected corpus, as a percentage clamped to
 * 0..100 so a negative gain (possible at low returns over short horizons)
 * still renders a bar.
 */
export function investedSplitPct(
  invested: number,
  estimatedValue: number
): number {
  if (!Number.isFinite(invested) || !Number.isFinite(estimatedValue)) return 0;
  if (estimatedValue <= 0) return 0;
  return clamp((invested / estimatedValue) * 100, 0, 100);
}
