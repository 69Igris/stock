/**
 * Pure helpers for the useMarketData hook (no React).
 *
 * The hook (and useQuote) CALL these so the option defaults, the valid-symbol
 * filter, the quote-API params, the raw→typed quote parse, the response→Map
 * transform, the single-quote lookup, the error message and the polling-interval
 * validation are defined once. Previously they were inlined in the hook and
 * re-implemented inside `__tests__/hooks/useMarketData.test.ts` (a shadow).
 */

import type { QuoteExchange } from "@/lib/market/quote-exchange";

import type { QuoteData, UseMarketDataOptions } from "./useMarketData";

export type ConnectionStatus = "connected" | "polling" | "error" | "idle";

/**
 * Freshness metadata the quote route has returned since MONEY-1124 and this
 * hook DROPPED until MONEY-1309.
 *
 * The route computed `cached` / `asOf` / `delayed` / `partial` on every
 * response and nothing consumed them, so a surface rendering a 75-second-old
 * cached price and one rendering a live tick looked identical. They are the
 * only way the UI can tell those apart — `lastUpdate` is when the FETCH
 * happened, not when the price was quoted.
 */
export interface MarketDataMeta {
  /** At least one quote came from the shared cache rather than a live read. */
  cached: boolean;
  /** ISO market time of the OLDEST price in the payload. */
  asOf: string | null;
  /** False only for a genuinely live source — see `isLiveQuoteSource`. */
  delayed: boolean;
  /** The request's time budget elapsed; results may be incomplete. */
  partial: boolean;
}

/** The meta a response carries before one has arrived. */
export const EMPTY_MARKET_DATA_META: MarketDataMeta = {
  cached: false,
  asOf: null,
  delayed: true,
  partial: false,
};

/**
 * Read the meta fields off a raw quote response.
 *
 * Every field is OPTIONAL on the wire (`withMeta` in the route's `quote-logic`
 * drops undefined keys), so each one falls back to the conservative reading:
 * not cached, unknown age, DELAYED, not partial. `delayed` defaulting to true
 * is the load-bearing one — an older deploy of the route, or a response shape
 * we failed to parse, must never be read as "this price is live".
 */
export function extractMarketDataMeta(
  payload: Record<string, unknown> | null | undefined
): MarketDataMeta {
  if (!payload || typeof payload !== "object") {
    return { ...EMPTY_MARKET_DATA_META };
  }
  return {
    cached: payload.cached === true,
    asOf: typeof payload.asOf === "string" ? payload.asOf : null,
    delayed: payload.delayed !== false,
    partial: payload.partial === true,
  };
}

/** Resolved option defaults. Mirrors the hook's `= ` destructuring defaults. */
export function resolveMarketDataOptions(options: UseMarketDataOptions = {}): {
  interval: number;
  enablePolling: boolean;
  exchange: QuoteExchange;
  needsFundamentals: boolean;
} {
  return {
    interval: options.interval ?? 10000,
    enablePolling: options.enablePolling ?? true,
    exchange: options.exchange ?? "NSE",
    // DEFAULTS FALSE. The expensive direction must be opted INTO: a default of
    // true would send every watchlist and ticker poll to the legacy route and
    // silently undo A4 for the whole platform.
    needsFundamentals: options.needsFundamentals ?? false,
  };
}

/**
 * Keep only non-empty string symbols. A stale upstream list with placeholders
 * would otherwise join to "symbols=,,,," → the quote endpoint 400s and the live
 * tile breaks.
 */
export function filterValidSymbols(
  symbols: readonly (string | undefined)[]
): string[] {
  return symbols.filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0
  );
}

/** URL params for the quote API. */
export function buildQuoteParams(
  symbols: string[],
  exchange: QuoteExchange
): URLSearchParams {
  return new URLSearchParams({
    symbols: symbols.join(","),
    exchange,
  });
}

/** Raw API quote shape (timestamp is an ISO string). */
export interface RawApiQuote extends Omit<QuoteData, "timestamp"> {
  timestamp: string;
}

/** Parse one raw API quote into a typed QuoteData (ISO string → Date). */
export function parseQuoteData(raw: RawApiQuote): QuoteData {
  return {
    ...raw,
    timestamp: new Date(raw.timestamp),
  };
}

/** Transform the full `{ symbol: rawQuote }` response into a Map. */
export function transformQuoteResponse(
  data: Record<string, RawApiQuote>
): Map<string, QuoteData> {
  const quotesMap = new Map<string, QuoteData>();
  for (const [symbol, quote] of Object.entries(data)) {
    quotesMap.set(symbol, parseQuoteData(quote));
  }
  return quotesMap;
}

/** Single-quote lookup (useQuote): the matching quote or null. */
export function extractSingleQuote(
  quotes: Map<string, QuoteData>,
  symbol: string
): QuoteData | null {
  return quotes.get(symbol) || null;
}

/** Error message: Error → .message, else "Unknown error". */
export function extractMarketDataError(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

/** A polling interval must be a positive, finite number. */
export function isValidPollingInterval(interval: number): boolean {
  return interval > 0 && Number.isFinite(interval);
}

/* ─────────────────────────────────────────────────────────────────────────
   The service path — MONEY-1469 (A4)
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The service's `/quotes` response, mapped into the legacy `RawApiQuote` shape.
 *
 * PURE and separate from the fetch, because this is where the two contracts
 * meet and a silent mismatch here looks exactly like "no quotes today". The
 * service answers `{s, data, missing, hits, misses, stale}`; the poller has
 * always consumed `{success, data: Record<symbol, RawApiQuote>}`.
 *
 * ## `change` MAY BE ABSENT, AND ABSENT IS NOT ZERO
 *
 * A US quote from the realtime socket carries no previous close, so the store
 * genuinely has no change to report. Mapping that to 0 renders "unchanged" in
 * green-or-red type — a claim about the market rather than an admission that we
 * do not know. It stays undefined and the UI decides.
 */
export interface ServiceQuote {
  price: number;
  change?: number;
  changePct?: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  volume?: number;
  ts: number;
  source: string;
  stale: boolean;
  ageMs: number;
}

export interface ServiceQuotesResponse {
  s?: string;
  data?: Record<string, ServiceQuote>;
  missing?: string[];
  hits?: number;
  misses?: number;
  stale?: number;
}

/**
 * Map the service's quotes into the poller's shape, NAMING what it cannot fill.
 *
 * ## THE CAST WAS A LIE AND IT CRASHED THE PAGE
 *
 * This built a partial object and wrote `as RawApiQuote`, which erases the
 * error. `QuoteData` declares `change`, `changePercent`, `open`, `high`, `low`,
 * `previousClose` and `volume` REQUIRED, and `watchlist/client.tsx:1875` does
 * `quote.changePercent.toFixed(2)` guarded only by `quote ?` — object
 * truthiness, not the field. A US quote from `rt:us:quote:*` NEVER carries a
 * change (the socket publishes top-of-book and has no previous close), so the
 * first render of any US watchlist row threw
 * `TypeError: Cannot read properties of undefined` and the error boundary
 * blanked the page.
 *
 * The fix is NOT to fabricate zeros. `undefined >= 0` is false, so an absent
 * change renders every row RED regardless of direction, and a zero CLAIMS the
 * market was flat. A quote that cannot satisfy the contract is reported as
 * INCOMPLETE and fetched from the legacy route, which has the EOD close behind
 * it that the service does not.
 *
 * `change` is DERIVED where `prevClose` allows it — arithmetic on data we hold,
 * not an invention.
 */
/**
 * Service quotes → the poller's shape, naming what the service could not answer.
 *
 * `incomplete` is NOT a synonym for "no price". It is "this quote cannot be
 * rendered by the caller that asked for it", and there are two ways to be
 * incomplete:
 *
 *   1. NO CHANGE. `change`/`changePct` are absent and no `prevClose` lets us
 *      derive them — the US store's shape.
 *   2. NO FUNDAMENTALS, when the caller renders them. `StoredQuote` has no
 *      `pe`, `eps`, `marketCap`, `week52High` or `week52Low` AT ALL, so this is
 *      a property of the SHAPE rather than of a particular symbol: with
 *      `needsFundamentals` every service quote is incomplete, by construction.
 *      That is the point — the caller gets the legacy route's full shape
 *      instead of five permanently blank tiles beside four live ones.
 *
 * Both land in the same `needLegacy` set the caller already falls back with, so
 * this adds a REASON to an existing path rather than a second path.
 */
export function transformServiceQuotes(
  body: ServiceQuotesResponse,
  exchange: QuoteExchange,
  needsFundamentals = false
): { quotes: Record<string, RawApiQuote>; incomplete: string[] } {
  const quotes: Record<string, RawApiQuote> = {};
  const incomplete: string[] = [];

  for (const [symbol, q] of Object.entries(body.data ?? {})) {
    const prevClose = finiteOrUndefined(q.prevClose);
    const change =
      finiteOrUndefined(q.change) ??
      (prevClose !== undefined ? q.price - prevClose : undefined);
    const changePercent =
      finiteOrUndefined(q.changePct) ??
      (prevClose !== undefined && prevClose !== 0
        ? ((q.price - prevClose) / prevClose) * 100
        : undefined);

    if (change === undefined || changePercent === undefined) {
      incomplete.push(symbol);
      continue;
    }

    // THE SHAPE CHECK — `||`, over EVERY field the caller renders.
    //
    // The first cut was `&&` over three of the five, and it could not work.
    // Two separate reasons, and the second is the one that bites:
    //
    //   1. `&&` means a PARTIAL rollout satisfies it. The service adds
    //      `marketCap` alone -> the guard sees one value -> not incomplete ->
    //      no fallback -> `pe`, `eps`, `week52High` and `week52Low` are still
    //      undefined and four tiles blank again, silently, with no code change.
    //   2. The object built below NEVER COPIES these fields, so even a service
    //      that carried all five would lose them here. The guard would stop
    //      firing and the tiles would stay empty — the comment claimed the
    //      opposite ("stops sending anything to the legacy route the moment the
    //      values arrive"), which is a claim about code that does not exist.
    //
    // Both are fixed by asking `||` over all five AND copying them through. A
    // caller is served the service's quote only when it genuinely has every
    // field that caller renders.
    const fundamentals = {
      marketCap: finiteOrUndefined(
        (q as unknown as Record<string, unknown>).marketCap
      ),
      pe: finiteOrUndefined((q as unknown as Record<string, unknown>).pe),
      eps: finiteOrUndefined((q as unknown as Record<string, unknown>).eps),
      week52High: finiteOrUndefined(
        (q as unknown as Record<string, unknown>).week52High
      ),
      week52Low: finiteOrUndefined(
        (q as unknown as Record<string, unknown>).week52Low
      ),
    };
    if (
      needsFundamentals &&
      Object.values(fundamentals).some((v) => v === undefined)
    ) {
      incomplete.push(symbol);
      continue;
    }

    quotes[symbol] = {
      symbol,
      exchange,
      price: q.price,
      change,
      changePercent,
      // The remaining OHLC fields default to the PRICE, not to 0: a zero low
      // draws a visible, wrong candle, while open==high==low==price is the
      // honest shape of "we have a price and nothing else".
      open: finiteOrUndefined(q.open) ?? q.price,
      high: finiteOrUndefined(q.high) ?? q.price,
      low: finiteOrUndefined(q.low) ?? q.price,
      previousClose: prevClose ?? q.price - change,
      volume: finiteOrUndefined(q.volume) ?? 0,
      timestamp: new Date(q.ts).toISOString(),
      // Carried through so a service that DOES grow these columns actually
      // delivers them. Undefined keys are dropped by the consumer the same way
      // an absent field is, so this is inert until the service supplies them.
      ...fundamentals,
    } as RawApiQuote;
  }
  return { quotes, incomplete };
}

function finiteOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The service's query string. `market` is IN/US; `exchange` narrows India. */
export function buildServiceQuoteParams(
  symbols: string[],
  exchange: QuoteExchange
): URLSearchParams {
  const market = exchange === "NSE" || exchange === "BSE" ? "IN" : "US";
  const params = new URLSearchParams({ symbols: symbols.join(","), market });
  if (market === "IN") params.set("exchange", exchange);
  return params;
}

/**
 * Which source does a batch report, for the delayed-data disclaimer?
 *
 * NOT the transport. `"market-data"` names the service that answered, and the
 * disclaimer is a claim about the DATA — an exchange-delayed Yahoo price and a
 * realtime Tiingo one are both served by the same origin. The route's own
 * header already records this: "`delayed` is derived from the source, so a US
 * quote served live says so and the UI disclaimer follows the DATA rather than
 * the viewer."
 *
 * CONSERVATIVE on a mixed batch: any delayed quote makes the whole batch read
 * as delayed. Over-warning costs a disclaimer nobody needed; under-warning
 * presents a 15-minute-old price as live, which is the half of this that is not
 * recoverable by looking again.
 */
export function dominantQuoteSource(
  quotes: Record<string, { source?: string }>
): "yahoo" | "TIINGO_RT" | "TIINGO" | "zerodha" | undefined {
  const sources = Object.values(quotes)
    .map((q) => q.source)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  if (sources.length === 0) return undefined;
  // Anything we do not positively recognise as realtime is treated as delayed.
  if (sources.some((s) => s !== "TIINGO_RT")) return "yahoo";
  return "TIINGO_RT";
}
