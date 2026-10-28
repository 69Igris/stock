/**
 * Kite (Zerodha) value normalizers — MONEY-582e.
 *
 * Defensive coercion for raw Kite API values, kept dependency-free so it can be
 * unit-tested directly (no broker-client / crypto import chain).
 */

/**
 * Coerce a raw API value to a finite number, or 0 if it is null/undefined/NaN/
 * Infinity. Kite normally sends numbers, but a malformed payload (string, null)
 * would otherwise poison arithmetic like quantity*price into NaN, which then
 * corrupts investedValue / currentValue / pnl downstream.
 */
export function toFiniteNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize a trade/order side to the canonical "BUY" | "SELL".
 *
 * The raw value was previously cast `as "BUY" | "SELL"` with no validation. If
 * Kite ever sends a different case ("buy") or an unexpected token, the cast lies
 * and FIFO pairing — which filters `tradeType === "BUY"` and `=== "SELL"`
 * separately — silently DROPS the trade from both sides. We uppercase+trim and
 * only accept exact BUY/SELL; anything else returns null so the caller can skip
 * or log it rather than silently mis-pair.
 */
export function normalizeSide(v: unknown): "BUY" | "SELL" | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return s === "BUY" || s === "SELL" ? s : null;
}
