/**
 * What the chart is actually showing — `trade` or `quote_mid`. MONEY-1470 (A5).
 *
 * ## WHY THIS IS A BADGE AND NOT A FOOTNOTE
 *
 * A `quote_mid` series is built from the MID of top-of-book, because the feed
 * that produces it carries no trades at all (MONEY-1309, measured across 236
 * captured frames). Two consequences the candles cannot reveal:
 *
 *   - its `volume` is a structural ZERO meaning "this feed does not report
 *     volume", NOT "nothing traded". A volume histogram of zeros beside a real
 *     one looks like a dead market.
 *   - its OHLC describes where the book WAS, not where anything CHANGED HANDS.
 *
 * ## WHY IT WRAPS `fetch`
 *
 * The basis arrives as the `X-Bar-Basis` response header, and the request is
 * issued by TradingView's bundled `UDFCompatibleDatafeed`, which owns `getBars`
 * and exposes no hook. `TradingViewAdvancedChart` already monkey-patches that
 * bundle for the realtime overlay, so this is the same seam, scoped tighter:
 * one URL substring, headers only, and the original `fetch` is returned
 * untouched on any error.
 *
 * Reading the header rather than inferring the basis from the market is
 * deliberate. A US symbol can be `trade` (Databento has loaded that session) or
 * `quote_mid` (only the socket has), and which one it is changes NIGHTLY. An
 * inferred badge would be wrong for exactly the sessions it matters for.
 */

export type BarBasis = "trade" | "quote_mid";

type Listener = (basis: BarBasis | null) => void;

const listeners = new Set<Listener>();
let current: BarBasis | null = null;

/**
 * ONE basis for the page, not one per chart.
 *
 * ponytail: a single global, last-writer-wins. Two intraday charts of
 * DIFFERENT symbols on one page would fight over it, and the badge would show
 * whichever answered last. That is acceptable today because no route renders
 * two — every chart surface is one symbol — and the alternative is keying by
 * symbol+resolution, which means parsing the query string of a request issued
 * by a bundle we do not control. Key it if a multi-chart page ever ships.
 */

/** The last basis the chart's own history request reported. */
export function getBarBasis(): BarBasis | null {
  return current;
}

export function subscribeBarBasis(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

/**
 * Record the basis of the newest `/udf/history` response.
 *
 * EXPORTED, because the fetch wrapper that observes it now lives in
 * `market-data-auth.ts` — the same wrapper has to attach the Authorization
 * header, and two wrappers over one request would have to agree about ordering.
 */
export function setBarBasis(next: BarBasis | null): void {
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn(next);
}

/**
 * The probe now lives in `market-data-auth.ts#installMarketDataFetch`, which
 * wraps `fetch` once for BOTH jobs: attaching the token and reading the basis.
 * Re-exported so the badge keeps one import.
 */
export { installMarketDataFetch as installBarBasisProbe } from "./market-data-auth";
