/**
 * Market Quote — pure request/response logic (no server-only deps).
 *
 * Extracted from `app/api/market/quote/route.ts` so the symbol-list parsing,
 * the symbol / count validators, the exchange default, the Zerodha-vs-Yahoo
 * source selection, the missing-symbol diff, and the response shapers can be
 * unit-tested against the REAL exported symbols instead of inline copies.
 *
 * The `Exchange` type is imported type-only from the symbol mapper, so this
 * module carries no runtime dependency on Prisma / network clients and the
 * tests stay pure. Its one runtime import — `isLiveQuoteProvenance` — is a pure
 * core predicate with no I/O, deliberately imported rather than re-implemented;
 * see below.
 *
 * @see apps/web/__tests__/api/market-quote.test.ts
 */

import { isLiveQuoteProvenance } from "@usemoney/core/market-data/tiingo/tiingo-rt-read-logic";

import type { Exchange } from "@/lib/market/symbol-mapper";

/**
 * Every value the route's envelope-level `source` can carry.
 *
 * "zerodha" survives only because {@link determineSource} still models the
 * pre-MONEY-837 decision; nothing in `apps/web` produces it today. "TIINGO_RT"
 * / "TIINGO" arrived with MONEY-1309 and are OUR OWN two stores, not a vendor
 * round trip — see `@usemoney/core/market-data/tiingo/tiingo-rt-read`.
 */
export type QuoteResponseSource = "zerodha" | "yahoo" | "TIINGO_RT" | "TIINGO";

/**
 * May this quote be presented as a LIVE price?
 *
 * NOT A LOCAL DEFINITION — it is core's `isLiveQuoteProvenance`, re-exported so
 * apps/web has no second answer of its own. There is one rule, it lives beside
 * the type that names the sources, and apps/api reads the same function.
 *
 * ## It used to be `isLiveQuoteSource(source: string)`, and that shape was the bug
 *
 * A quote's liveness is a property of the PAIR (`source`, `fallback`), never of
 * the source alone: the read path can emit `TIINGO_RT` with `fallback:true`.
 * With a source-only signature every consumer had to remember to check the
 * second field separately, and `DelayedDataNote` did not — so a fallback quote
 * rendered a green `Live quote · 05:30 am` badge IN PLACE OF the exchange-delayed
 * disclaimer, on the same page whose provenance chip was correctly showing an
 * amber `fallback` pill.
 *
 * The signature now makes that omission unrepresentable: a caller cannot hand
 * this function a source without also handing it the flag, and there is no
 * exported source-only predicate left to reach for. `route.ts` passes
 * `{ source }` for the ENVELOPE, which carries no per-quote flag by
 * construction — `batchQuoteSource` has already demoted the whole batch to
 * `TIINGO` if any member was a fallback.
 *
 * Only TIINGO_RT is live. Yahoo is exchange-delayed by ~15 minutes; TIINGO is
 * the previous session's close.
 */
export { isLiveQuoteProvenance as isLiveQuote };

/** The two fields liveness is decided from. Both optional; both fail closed. */
export interface QuoteLiveness {
  source?: string | null;
  fallback?: boolean | null;
}

/**
 * Parse the comma-separated `symbols` parameter into a clean array:
 * split on comma, trim each, drop empties (handles leading / trailing /
 * consecutive commas and whitespace-only entries).
 */
export function parseSymbolList(symbols: string): string[] {
  return symbols
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Reject an empty symbol list with the route's exact error message. */
export function validateSymbolListNotEmpty(symbolList: string[]): {
  valid: boolean;
  error?: string;
} {
  if (symbolList.length === 0) {
    return { valid: false, error: "No valid symbols provided" };
  }
  return { valid: true };
}

/** Reject a symbol list longer than 50 with the route's exact error message. */
export function validateSymbolListSize(symbolList: string[]): {
  valid: boolean;
  error?: string;
} {
  if (symbolList.length > 50) {
    return { valid: false, error: "Maximum 50 symbols allowed per request" };
  }
  return { valid: true };
}

/** Require at least one of `symbol` / `symbols` (both null/empty → invalid). */
export function validateSymbolParams(
  symbol: string | null,
  symbols: string | null
): { valid: boolean; error?: string } {
  if (!symbol && !symbols) {
    return {
      valid: false,
      error: "Either 'symbol' or 'symbols' parameter is required",
    };
  }
  return { valid: true };
}

/** Resolve the exchange param, defaulting to NSE. */
export function resolveExchange(exchange: string | null): Exchange {
  return (exchange || "NSE") as Exchange;
}

/**
 * Source label for a quote: "zerodha" only when the caller has active broker
 * credentials AND Zerodha actually returned data; otherwise "yahoo". Mirrors the
 * route's Zerodha-first / Yahoo-fallback decision.
 */
export function determineSource(
  hasCredentials: boolean,
  zerodhaReturnedData: boolean
): "zerodha" | "yahoo" {
  if (hasCredentials && zerodhaReturnedData) return "zerodha";
  return "yahoo";
}

/** Symbols absent from the Zerodha response → must be filled from Yahoo. */
export function findMissingSymbols(
  symbolList: string[],
  zerodhaMap: Map<string, unknown>
): string[] {
  return symbolList.filter((s) => !zerodhaMap.has(s));
}

/**
 * Freshness metadata attached to a quote response (MONEY-1124).
 *
 * The envelope's `timestamp` is, and always was, the time the RESPONSE was
 * assembled — not the age of the prices in it. Now that the route can serve a
 * quote out of a shared cache or a `LatestQuote` row, that distinction matters:
 * these fields say where the numbers came from and how old they actually are,
 * so nothing downstream can mistake "we answered just now" for "this price is
 * from just now".
 */
export interface QuoteResponseMeta {
  /** True when at least one quote came from the shared cache rather than live. */
  cached?: boolean;
  /**
   * ISO timestamp of the OLDEST market time across the returned quotes — the
   * honest "as of" for the payload. Omitted when nothing resolved.
   */
  asOf?: string;
  /**
   * Whether the prices in this payload are delayed rather than live.
   *
   * It used to be hardcoded true, with the note "every provider in the chain is
   * exchange-delayed (Yahoo)". MONEY-1309 made that false for US symbols served
   * out of the realtime keys, so it is now derived through {@link isLiveQuote}
   * — the single place that decides what "live" means, and the same function
   * apps/api and the UI disclaimer read. Still explicit in the payload so a
   * client never has to infer it.
   */
  delayed?: boolean;
  /** True when the request's time budget elapsed and results may be partial. */
  partial?: boolean;
}

/** Drop undefined keys so the response shape is unchanged when no meta is passed. */
function withMeta(
  base: Record<string, unknown>,
  meta?: QuoteResponseMeta
): Record<string, unknown> {
  if (!meta) return base;
  const out = { ...base };
  if (meta.cached !== undefined) out.cached = meta.cached;
  if (meta.asOf !== undefined) out.asOf = meta.asOf;
  if (meta.delayed !== undefined) out.delayed = meta.delayed;
  if (meta.partial !== undefined) out.partial = meta.partial;
  return out;
}

/**
 * Shape the single-symbol success response. `quote` is `unknown` because the
 * helper only forwards it into `data` — accepting the broker/Yahoo `QuoteData`
 * (with its `Date` field) without forcing a lossy `Record` cast at call sites.
 *
 * `timestamp` is the RESPONSE time. For data age read `meta.asOf`.
 */
export function formatSingleQuoteResponse(
  quote: unknown,
  source: QuoteResponseSource,
  brokerStatus: string,
  meta?: QuoteResponseMeta
): Record<string, unknown> {
  return withMeta(
    {
      success: true,
      data: quote,
      source,
      brokerStatus,
      timestamp: new Date().toISOString(),
    },
    meta
  );
}

/** Shape the multi-symbol success response (adds `count`). */
export function formatMultiQuoteResponse(
  quotes: Record<string, unknown>,
  source: QuoteResponseSource,
  brokerStatus: string,
  meta?: QuoteResponseMeta
): Record<string, unknown> {
  return withMeta(
    {
      success: true,
      data: quotes,
      count: Object.keys(quotes).length,
      source,
      brokerStatus,
      timestamp: new Date().toISOString(),
    },
    meta
  );
}
