/**
 * What this service reports to Datadog. MONEY-1469 (A4).
 *
 * ## NAMES ARE BARE HERE, AND THAT IS THE WHOLE TRAP
 *
 * `datadog-metrics` is initialised with `prefix: METRIC_PREFIX` ("stockbook."),
 * so what ARRIVES is `stockbook.` + whatever is passed. The first cut passed
 * `"stockbook.quote.hit"` and shipped `stockbook.stockbook.quote.hit` — a
 * series that exists, carries correct values, and is invisible to every
 * dashboard and monitor that queries the name anyone would write.
 *
 * That renders as NO DATA, which is indistinguishable from a healthy idle
 * service. It is MONEY-1238 for the fourth time, and the sibling
 * `rt-metrics-logic.ts` opens with the same warning in the same words.
 *
 * ## THE MISS RATIO IS THE POINT, AND IT NEEDS BOTH HALVES
 *
 * `quote.miss` alone cannot be alerted on: it is zero when the store is healthy
 * AND zero when nothing is asking, and those are opposite states. So the hit
 * counter is emitted on every batch too, INCLUDING when it is zero, and the
 * monitor reads the RATIO.
 *
 * `stale` is counted separately from `miss` because they demand opposite
 * responses: a miss means fall back to a vendor, a stale hit means serve the
 * last known price and say so. Folding them together would make a weekend —
 * when every quote is legitimately stale — read as a total store failure.
 */
import { incrementCounter, METRIC_PREFIX } from "@usemoney/datadog";
import type { BatchQuoteResult } from "@usemoney/core/market-data/quotes/quote-logic";

/**
 * Counter field -> metric name AS PASSED (bare; the client adds the prefix).
 *
 * A TABLE rather than three string literals at the call site, so the naming
 * rule is a value a test can assert instead of a comment asking to be obeyed.
 */
export const QUOTE_METRICS = {
  hit: "quote.hit",
  miss: "quote.miss",
  stale: "quote.stale",
} as const;

/** The fully-qualified series that actually reach Datadog — what to query. */
export const EMITTED_QUOTE_METRICS = {
  hit: `${METRIC_PREFIX}${QUOTE_METRICS.hit}`,
  miss: `${METRIC_PREFIX}${QUOTE_METRICS.miss}`,
  stale: `${METRIC_PREFIX}${QUOTE_METRICS.stale}`,
} as const;

export function recordQuoteBatch(
  market: string,
  result: BatchQuoteResult,
): void {
  const tags = { market };
  // Emitted unconditionally, zeros included — see the header.
  incrementCounter(QUOTE_METRICS.hit, result.hits, tags);
  incrementCounter(QUOTE_METRICS.miss, result.misses, tags);
  incrementCounter(QUOTE_METRICS.stale, result.stale, tags);
}
