/**
 * Kite (Zerodha) timestamp parsing — MONEY-582b.
 *
 * Kite Connect returns trade/order timestamps as IST wall-clock strings with a
 * SPACE separator and NO timezone offset, e.g. "2024-06-13 09:18:18". Per
 * ECMAScript, a date-time string that uses a space separator and lacks an offset
 * is parsed in the HOST time zone — which is UTC on Vercel / Cloud Run. So
 * `new Date("2024-06-13 09:18:18")` yields 09:18 UTC, i.e. the trade is stored
 * 5.5h EARLY. FIFO pairing orders by [tradeDate, tradeTime], so the drift makes
 * a SELL pair against the wrong BUY lot across the date boundary -> wrong
 * realized P&L on every Zerodha sync.
 *
 * This module is intentionally dependency-free so it can be unit-tested directly
 * (no broker-client / crypto import chain).
 */

/** A string already carries an explicit zone if it ends in Z or +HH:MM/-HH:MM. */
function hasExplicitZone(s: string): boolean {
  // Trailing Z, OR an offset in the time portion: a ':' (time) somewhere before
  // a trailing +HH:MM / -HH:MM / +HHMM. The date's own hyphens are earlier than
  // the time, so anchoring the sign to the END avoids matching them.
  return (
    /[zZ]$/.test(s) || /\d{2}:\d{2}(:\d{2})?(\.\d+)?[+-]\d{2}:?\d{2}$/.test(s)
  );
}

/**
 * Parse the first valid Kite timestamp from a fallback chain of candidate
 * fields (e.g. fill_timestamp -> exchange_timestamp -> order_timestamp).
 *
 * - A string WITHOUT an explicit zone is treated as IST (+05:30).
 * - A string WITH an explicit zone is trusted as-is.
 * - Returns null if no candidate yields a valid Date (caller decides the
 *   fallback — never silently substitute `now` inside FIFO-ordered data without
 *   intent).
 */
export function parseKiteTimestamp(
  ...candidates: (string | null | undefined)[]
): Date | null {
  for (const raw of candidates) {
    if (!raw || typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s) continue;

    const withT = s.replace(" ", "T");
    const iso = hasExplicitZone(s) ? withT : `${withT}+05:30`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Extract the IST calendar date ("YYYY-MM-DD") from a Kite timestamp string.
 * The date portion of the IST wall-clock string IS the correct trade date, so
 * we take it from the raw string rather than from a UTC-converted instant
 * (which could roll to the previous day for pre-05:30 instants).
 */
export function kiteTradeDate(
  ...candidates: (string | null | undefined)[]
): string {
  for (const raw of candidates) {
    if (!raw || typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s) continue;
    const datePart = s.split(/[ T]/)[0] ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  }
  return "";
}
