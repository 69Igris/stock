/**
 * Which origin does the quote poller talk to? MONEY-1469 (A4).
 *
 * The same shape and the same polarity as `udf/datafeed-target.ts` (A3),
 * deliberately: one resolver, one fail-safe direction, pure so both the server
 * and the tests exercise the same bytes.
 *
 * ## IT FAILS SAFE TO THE ROUTE THAT ALREADY WORKS
 *
 * Every ambiguous input — flag unset, unreadable, URL missing or malformed —
 * resolves to `apps/web`'s `/api/market/quote`, which has served this poller
 * for months. The two failure modes are not symmetric:
 *
 *   fail to the OLD route   a slower poll, correct prices, nobody notices
 *   fail to the NEW one     before India's keys are populated, every symbol is
 *                           a MISS and a watchlist renders blank rows
 *
 * ## `brokerStatus` DOES NOT MOVE, AND THAT IS THE POINT
 *
 * The legacy response carries `brokerStatus` alongside the quotes, and the UI
 * uses it as an ENTITLEMENT GATE — `realtimeAllowedRef.current = !loading &&
 * status === "active"`. It is per-user, comes from a broker connection row, and
 * has nothing to do with market data; the service has no database and must
 * never learn about brokers. So a caller on the service path reads it from
 * `/api/market/broker-status` instead, and the two are fetched in PARALLEL
 * rather than chained — chaining would put a Vercel round trip back in front of
 * the quote read this ticket exists to make fast.
 */

export const MARKET_DATA_QUOTES_FLAG = "MARKET_DATA_QUOTES";

/** The route that has served this poller all along. */
export const LEGACY_QUOTE_URL = "/api/market/quote";
/** Where `brokerStatus` comes from once quotes no longer carry it. */
export const BROKER_STATUS_URL = "/api/market/broker-status";

export interface QuotesTargetInput {
  /** The `PlatformConfig` value, whatever shape it came back as. */
  flagValue?: unknown;
  /** `NEXT_PUBLIC_MARKET_DATA_URL`. */
  marketDataUrl?: string | null;
}

/**
 * Read the flag out of an arbitrary `PlatformConfig` value.
 *
 * Anything that is not an explicit, recognisable TRUE is false — the same
 * literal-comparison discipline the `*_APPLY` env flags use, for the same
 * reason: `Boolean("false")` is `true`, which would arm the one configuration
 * meant to keep it off.
 */
export function isQuotesFlagEnabled(flagValue: unknown): boolean {
  if (flagValue === true) return true;
  if (typeof flagValue === "string") return flagValue.toLowerCase() === "true";
  if (flagValue && typeof flagValue === "object") {
    const v = (flagValue as { enabled?: unknown }).enabled;
    return v === true || (typeof v === "string" && v.toLowerCase() === "true");
  }
  return false;
}

/** The base URL the quote poller should use. */
export function resolveQuotesBaseUrl(input: QuotesTargetInput): string {
  if (!isQuotesFlagEnabled(input.flagValue)) return LEGACY_QUOTE_URL;

  const raw = (input.marketDataUrl ?? "").trim();
  if (!raw) return LEGACY_QUOTE_URL;

  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    return LEGACY_QUOTE_URL;
  }
  // https only: a CDN-fronted origin has no reason to be anything else, and a
  // quote poll carries a session cookie on the legacy path.
  if (origin.protocol !== "https:") return LEGACY_QUOTE_URL;

  return `${origin.origin}/quotes`;
}

/** Is a resolved base URL the service, rather than the legacy web route? */
export function isServiceQuotesUrl(baseUrl: string): boolean {
  return baseUrl !== LEGACY_QUOTE_URL;
}
