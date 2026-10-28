/**
 * Serving an intraday `/udf/history`. MONEY-1470 (A5).
 *
 * Pure: the resolution mapping, the entitlement decision and the refusal
 * reasons. The route only does I/O.
 */
import {
  BASE_INTERVAL,
  INTERVAL_MINUTES,
  SUPPORTED_INTERVALS,
  derivableIntervals,
  type IntradayInterval,
} from "./rollup-logic";

/**
 * TradingView resolution -> our interval.
 *
 * UDF spells minutes as a BARE NUMBER (`"5"`), days as `"1D"`/`"D"`. The
 * config advertises 1/3/5/10/15/30/60 and we serve four of them; the rest are
 * refused BY NAME rather than rounded to the nearest one we have. A chart that
 * silently answers a 3-minute request with 5-minute bars is wrong in a way the
 * candles cannot reveal — every one of them plots at a plausible time.
 */
export function resolutionToInterval(
  resolution: string,
): IntradayInterval | null {
  const r = resolution.trim().toUpperCase();
  if (r === "D" || r === "1D" || r === "W" || r === "1W" || r === "M")
    return null;
  const minutes = Number(r);
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  return (
    SUPPORTED_INTERVALS.find((i) => INTERVAL_MINUTES[i] === minutes) ?? null
  );
}

/** Is this resolution an intraday one at all (as opposed to D/W/M)? */
export function isIntradayResolution(resolution: string): boolean {
  const r = resolution.trim().toUpperCase();
  if (r === "D" || r === "1D" || r === "W" || r === "1W" || r === "M")
    return false;
  return Number.isInteger(Number(r)) && Number(r) > 0;
}

export type IntradayVerdict =
  | { ok: true; interval: IntradayInterval; base: IntradayInterval }
  | { ok: false; reason: string };

/**
 * Can this market serve this resolution?
 *
 * India's base is 5m, so 1m is REFUSED rather than fabricated from it — see
 * `IntervalNotDerivableError`. The refusal names the intervals that ARE
 * available, because "not supported" with no alternative sends a caller
 * looking for a bug rather than a different button.
 */
export function planIntradayRead(
  market: "IN" | "US",
  resolution: string,
): IntradayVerdict {
  const interval = resolutionToInterval(resolution);
  if (!interval) {
    return {
      ok: false,
      reason: `resolution ${resolution} is not served — available: ${SUPPORTED_INTERVALS.map(
        (i) => INTERVAL_MINUTES[i],
      ).join(", ")} minutes`,
    };
  }
  const base = BASE_INTERVAL[market];
  const available = derivableIntervals(base);
  if (!available.includes(interval)) {
    return {
      ok: false,
      reason:
        `${interval} is not available for ${market}: the narrowest stored interval is ` +
        `${base}, and a narrower bar cannot be derived from a wider one. ` +
        `Available: ${available.join(", ")}`,
    };
  }
  return { ok: true, interval, base };
}

/**
 * How many BASE bars to read to satisfy a request for `count` target bars.
 *
 * Over-reads by one target bucket deliberately: the request's window rarely
 * aligns to a bucket boundary, so the oldest bucket is usually PARTIAL, and
 * serving a partial first candle makes a chart's leftmost bar wrong every time
 * the user pans. One extra bucket is cheap; a wrong opening candle is not.
 */
export function baseBarsNeeded(
  count: number,
  interval: IntradayInterval,
  base: IntradayInterval,
): number {
  const ratio = INTERVAL_MINUTES[interval] / INTERVAL_MINUTES[base];
  return Math.ceil((count + 1) * ratio);
}
