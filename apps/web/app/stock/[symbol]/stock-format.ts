/**
 * Stock Detail formatting helpers (pure).
 *
 * Extracted from `client.tsx` so the formatting surface (locale grouping,
 * crore/lakh/thousand volume buckets, ₹ market-cap scaling) has a real,
 * importable unit under test instead of an inline shadow. The client
 * component imports these — there is no dead duplicate.
 *
 * Every formatter returns the em-dash "—" (U+2014) for nullish/blank
 * input to match the page's "real values only" placeholder convention.
 */

const EMDASH = "—";

/** Locale-grouped number (en-IN lakh/crore grouping) with fixed decimals. */
export function formatNumber(
  value: number | undefined | null,
  decimals = 2
): string {
  if (value === undefined || value === null) return EMDASH;
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Volume bucketed into Cr / L / K, else the raw integer string. */
export function formatVolume(volume: number | undefined | null): string {
  if (!volume) return EMDASH;
  if (volume >= 10_000_000) return `${(volume / 10_000_000).toFixed(1)} Cr`;
  if (volume >= 100_000) return `${(volume / 100_000).toFixed(1)} L`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)} K`;
  return volume.toString();
}

/** Rupees in one crore. Spelled once so no caller re-derives it by hand. */
const RUPEES_PER_CRORE = 10_000_000;

/**
 * Market cap given in RUPEES, rendered in the Indian convention (Cr / L Cr).
 *
 * ⚠ Read the unit before calling this. Two different DB columns are both
 * called `marketCap` and they are NOT in the same unit:
 *
 *   - `LatestQuote.marketCap`  — RUPEES  (Yahoo). Use THIS function.
 *   - `StockRatios.marketCap`  — CRORES  (Tickertape/XBRL). Use
 *     {@link formatMarketCapCrores}.
 *
 * Passing a crores value here divides it by 10,000,000 a second time, so a
 * genuine ₹14,000 Cr company renders as "₹0 Cr" — a confident wrong number
 * rather than a missing one, so no empty state fires and nothing looks broken
 * (MONEY-1144). The unit is asserted in the repo at
 * `lib/actions/screener.ts:231` (`// crores`) and by the screener's mcap
 * buckets (`lib/screener/match-score.ts:41-43`, LARGE = 20,000+).
 *
 * MONEY-1148 — this used to carry its OWN T/B tier ladder, and both rungs were
 * wrong:
 *
 *   - "B" divided by 1e10 while labelling billions, so Hawkins' ₹4,300 Cr
 *     (₹43 B) rendered as "₹4 B" — understated 10x.
 *   - It had TWO trillion rungs, `>=1e13` dividing by 1e13 and `>=1e12`
 *     dividing by 1e12, which made the output NON-MONOTONIC: crossing ₹10 T
 *     made the displayed number DROP from "₹9.90 T" to "₹1.00 T". Reliance
 *     read "₹1.75 T" for ₹17.5 trillion.
 *
 * The fix is not a corrected ladder but the DELETION of the second ladder: an
 * Indian retail investor reads market cap in crores, so this converts to crores
 * and delegates to {@link formatMarketCapCrores}. There is now exactly one tier
 * implementation in this file, which is what stops the two from diverging again
 * — the previous duplicate is precisely how one of them drifted 10x off.
 */
export function formatMarketCap(
  marketCapInRupees: number | undefined | null
): string {
  if (!marketCapInRupees || !Number.isFinite(marketCapInRupees)) return EMDASH;
  return formatMarketCapCrores(marketCapInRupees / RUPEES_PER_CRORE);
}

/**
 * A financial-statement money value, already denominated in CRORES.
 *
 * `StockFinancials`' money columns are crores — Tickertape's own unit, and (as
 * of MONEY-1207) the unit every writer normalises to on the way in. The
 * financials tab used to divide them by 1e7 again under the comment "source
 * data is in INR", so HDFC Bank's ₹4,70,915 Cr revenue rendered as **₹0.05 Cr**.
 * That is the failure mode {@link formatMarketCap} warns about two functions
 * up: a confident wrong number, not a missing one, so no empty state fires and
 * nothing looks broken.
 *
 * Separate from {@link formatMarketCapCrores} only in its tiers — a statement
 * table needs the thousands step ("₹1.20 k Cr") that a market-cap chip does not.
 */
export function formatStatementCrores(
  valueInCrores: number | undefined | null
): string {
  if (valueInCrores == null || !Number.isFinite(valueInCrores)) return EMDASH;
  const cr = valueInCrores;
  if (Math.abs(cr) >= 100_000) return `₹${(cr / 100_000).toFixed(2)} L Cr`;
  if (Math.abs(cr) >= 1_000) return `₹${(cr / 1_000).toFixed(2)} k Cr`;
  return `₹${cr.toFixed(2)} Cr`;
}

/**
 * Market cap (or enterprise value) already denominated in CRORES.
 *
 * This is the unit `StockRatios` stores, so it is what the Fundamentals card,
 * the Peers table and (since MONEY-1148) {@link formatMarketCap} all render
 * through. Rendered the way an Indian retail investor reads it — "₹14,127 Cr",
 * and "₹17.50 L Cr" past a lakh crore.
 *
 * THE canonical tier ladder for a market cap on this page. {@link formatMarketCap}
 * converts rupees and delegates here rather than keeping a parallel ladder,
 * because the parallel ladder is what silently drifted 10x off and went
 * non-monotonic (MONEY-1148). Add a tier here and both surfaces get it; there
 * is no second place to forget.
 *
 * Deliberately NO thousands ("k Cr") rung: a market-cap chip reads better with
 * the full en-IN grouped figure ("₹28,023 Cr"), and {@link formatStatementCrores}
 * — which DOES have that rung — is the one for statement tables.
 */
export function formatMarketCapCrores(
  valueInCrores: number | undefined | null
): string {
  if (!valueInCrores || !Number.isFinite(valueInCrores)) return EMDASH;
  if (valueInCrores >= 100_000) {
    return `₹${(valueInCrores / 100_000).toFixed(2)} L Cr`;
  }
  return `₹${Math.round(valueInCrores).toLocaleString("en-IN")} Cr`;
}
