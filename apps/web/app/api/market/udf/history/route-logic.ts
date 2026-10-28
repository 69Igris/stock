/**
 * Pure helpers for the TradingView UDF history endpoint.
 *
 * Extracted from `./route.ts` (which imports Clerk / Prisma / Redis / Yahoo and
 * so can't be imported by a unit test) so the bug-prone bits are tested against
 * the REAL exported symbols the route calls, not inline copies:
 *
 *   - `tvResolutionToInterval` — TV resolution string → internal interval.
 *   - `pickPeriodForRange`      — from/to ms → Yahoo period bucket.
 *   - `barsToUdfOk`             — OHLCV bars → UDF columns (ms→**seconds**,
 *                                 countback tail-slice).
 *   - `parseSymbolPrefix`       — "EXCHANGE:SYMBOL" split (defaults to NSE).
 *   - `shouldReadSharedCache` / `shouldWriteSharedCache` — the MONEY-566
 *     Zerodha-compliance gate for the user-agnostic Redis cache. Pulling these
 *     out so the COMPLIANCE INVARIANT (a Zerodha-sourced bar is NEVER written
 *     to the shared cache) is asserted against the same code production runs.
 *
 * @see apps/web/__tests__/api/udf-history.test.ts
 */

import type { HistoricalBar } from "@/lib/market/historical-fetcher";
import type { Period as YahooPeriod } from "@/lib/market/yahoo-client";
import {
  adjustBarsForBasis,
  resampleDailyBars,
  type AdjustmentStep,
  type HistoricalBar as SourcedBar,
} from "@usemoney/core/market-data/prices/yahoo-price-logic";

export interface UdfHistoryOk {
  s: "ok";
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

/**
 * Map a TradingView resolution string to the internal interval string used by
 * /api/market/historical and the historical-fetcher module.
 *
 * TV resolution conventions:
 * - Numeric values are MINUTES: "1", "3", "5", "10", "15", "30", "60"
 * - "1D" / "D" - daily
 * - "1W" / "W" - weekly
 * - "1M" / "M" - monthly (note: capital M, lowercase m means minute)
 */
export function tvResolutionToInterval(resolution: string): string | null {
  const r = resolution.trim();
  // Daily / weekly / monthly first (avoid colliding with intraday "1")
  if (r === "1D" || r === "D") return "1d";
  if (r === "1W" || r === "W") return "1wk";
  if (r === "1M" || r === "M") return "1mo";
  // Intraday minutes
  switch (r) {
    case "1":
      return "1m";
    case "3":
      return "3m";
    case "5":
      return "5m";
    case "10":
      return "10m";
    case "15":
      return "15m";
    case "30":
      return "30m";
    case "60":
      return "60m";
    default:
      return null;
  }
}

/**
 * Pick a Yahoo period that comfortably covers the requested time range.
 */
export function pickPeriodForRange(fromMs: number, toMs: number): YahooPeriod {
  const days = (toMs - fromMs) / (1000 * 60 * 60 * 24);
  if (days <= 1) return "1d";
  if (days <= 5) return "5d";
  if (days <= 31) return "1mo";
  if (days <= 95) return "3mo";
  if (days <= 200) return "6mo";
  if (days <= 400) return "1y";
  if (days <= 800) return "2y";
  if (days <= 2000) return "5y";
  if (days <= 3700) return "10y";
  return "max";
}

/**
 * Convert internal OHLCV bars to UDF column-oriented arrays.
 * Honors countback by slicing the tail N bars when supplied.
 */
export function barsToUdfOk(
  bars: HistoricalBar[],
  countback: number | null
): UdfHistoryOk {
  const slice = countback && countback > 0 ? bars.slice(-countback) : bars;
  const t: number[] = new Array(slice.length);
  const o: number[] = new Array(slice.length);
  const h: number[] = new Array(slice.length);
  const l: number[] = new Array(slice.length);
  const c: number[] = new Array(slice.length);
  const v: number[] = new Array(slice.length);
  for (let i = 0; i < slice.length; i++) {
    const bar = slice[i]!;
    // unix SECONDS, not ms - TV requirement
    t[i] = Math.floor(bar.date.getTime() / 1000);
    o[i] = bar.open;
    h[i] = bar.high;
    l[i] = bar.low;
    c[i] = bar.close;
    v[i] = bar.volume ?? 0;
  }
  return { s: "ok", t, o, h, l, c, v };
}

/** Split "EXCHANGE:SYMBOL"; with no colon, default the exchange to NSE. */
export function parseSymbolPrefix(symbolParam: string): {
  prefix: string;
  rawSymbol: string;
} {
  const colonIdx = symbolParam.indexOf(":");
  const prefix = colonIdx === -1 ? "NSE" : symbolParam.slice(0, colonIdx);
  const rawSymbol =
    colonIdx === -1 ? symbolParam : symbolParam.slice(colonIdx + 1);
  return { prefix, rawSymbol };
}

// ── MONEY-566 shared-cache participation gate (Zerodha compliance) ──
//
// The UDF history Redis cache is user-agnostic — one bucket per (symbol,
// interval, window), shared across every user. Per the Zerodha market-data
// commitment, Zerodha-sourced bars must NEVER be served to a different user.
// Only requesters WITHOUT an active broker connection participate in the
// shared cache (their requests carry no Zerodha credentials, so the fetch can
// only return public Yahoo bars). Active-broker users bypass it entirely. The
// WRITE side additionally re-checks the fetch `source` as defense in depth.

/** True iff the requester's broker is active (and so must bypass the cache). */
export function isActiveBroker(status: string): boolean {
  return status === "active";
}

/**
 * READ gate: only non-countback requests from non-active-broker users read.
 *
 * `liveSession` (MONEY-1382): the window reaches today's session while it is
 * trading, so the response carries a candle rebuilt from a quote on every
 * request. The shared cache's in-session TTL is 5 minutes — longer than the
 * 60 s such a response may live — so it neither reads nor writes one.
 */
export function shouldReadSharedCache(opts: {
  countback: number | null;
  brokerStatus: string;
  liveSession?: boolean;
}): boolean {
  const useSharedCache = !isActiveBroker(opts.brokerStatus);
  return opts.countback === null && useSharedCache && !opts.liveSession;
}

/**
 * WRITE gate: cache only a non-error, non-countback payload from a
 * non-active-broker user whose fetch source is not "zerodha". The truth table
 * has NO row where a Zerodha-sourced payload is written.
 */
export function shouldWriteSharedCache(opts: {
  payloadKind: "ok" | "no_data" | "error";
  countback: number | null;
  brokerStatus: string;
  source?: string;
  /** See `shouldReadSharedCache`. */
  liveSession?: boolean;
}): boolean {
  const useSharedCache = !isActiveBroker(opts.brokerStatus);
  const isPublicSource = opts.source !== "zerodha";
  return (
    opts.payloadKind !== "error" &&
    opts.countback === null &&
    useSharedCache &&
    isPublicSource &&
    !opts.liveSession
  );
}

// ── MONEY-1382: daily / weekly / monthly are ONE series ──

/**
 * The resolutions served from the daily series. An ALLOW list on purpose:
 * three spellings of "which intervals are intraday" exist in this repo and they
 * disagree (core's omits 3m and 10m), so a deny list lets a daily candle
 * through to a minute chart.
 */
export function isDailyPlusInterval(
  interval: string
): interval is "1d" | "1wk" | "1mo" {
  return interval === "1d" || interval === "1wk" || interval === "1mo";
}

/**
 * Build a daily/weekly/monthly response from DAILY bars — the whole
 * composition, so a test can reach the order that matters:
 *
 *   1. today's forming bar joins ONCE, and only if no row already holds today;
 *   2. every session is adjusted on its own basis (`adjustBarsForBasis`), the
 *      live bar included — appended after, it would escape a forthcoming
 *      split that divides every other bar;
 *   3. THEN weeks/months are aggregated — a bucket straddling an ex-date holds
 *      sessions on two bases that only the daily bars can tell apart;
 *   4. only bars inside the requested window are served. For 1wk/1mo the
 *      caller fetched whole buckets, and a bucket is served by the request
 *      that holds its FIRST session, complete, exactly once.
 */
export function composeDailyPlusBars(input: {
  days: readonly SourcedBar[];
  interval: "1d" | "1wk" | "1mo";
  fromMs: number;
  toMs: number;
  steps: readonly AdjustmentStep[];
  liveBar: SourcedBar | null;
}): SourcedBar[] {
  const { days, liveBar } = input;
  const last = days[days.length - 1];
  const series =
    liveBar && (!last || last.date.getTime() < liveBar.date.getTime())
      ? [...days, liveBar]
      : days;
  const bars = resampleDailyBars(
    adjustBarsForBasis(series, input.steps),
    input.interval
  );
  return bars.filter(
    (b) => b.date.getTime() >= input.fromMs && b.date.getTime() <= input.toMs
  );
}

/**
 * Run the two INDEPENDENT preconditions of a history request concurrently.
 *
 * They are the corporate-action lookup and the broker-market-data status. Both
 * must resolve before the shared cache can be consulted — the adjustment
 * fingerprint is part of the cache KEY, and the broker status decides whether
 * this requester may participate in the shared cache at all — and neither reads
 * the other's result. Awaited in sequence they were two serial round trips, and
 * every hop is cross-region while the Vercel region is unpinned (MONEY-1122).
 *
 * A thin wrapper, deliberately. The property worth protecting is CONCURRENCY,
 * and a source scan for `Promise.all(` cannot observe it — it proves a call
 * site exists, not that the two calls overlap. Behind a named function a test
 * can watch the second task START before the first RESOLVES.
 *
 * Rejections propagate: each caller keeps its own error contract (the
 * adjustment lookup degrades to unadjusted bars inside its own catch).
 */
export async function loadHistoryPreconditions<A, B>(
  loadAdjustment: () => Promise<A>,
  loadBrokerStatus: () => Promise<B>
): Promise<[A, B]> {
  return Promise.all([loadAdjustment(), loadBrokerStatus()]);
}
