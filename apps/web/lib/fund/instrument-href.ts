/**
 * The one place that decides which detail route an instrument belongs on —
 * MONEY-1205.
 *
 * ## Why this exists
 *
 * `SBIETFQLTY` rendered at THREE live routes with no canonical and no
 * redirect: `/etf/SBIETFQLTY`, `/mf/145648` and `/stock/SBIETFQLTY`. Not a
 * flag, not an environment difference — eight call sites each decided for
 * themselves, and which page you got was decided by which link you clicked.
 * Two of them emitted `/etf/`; the other six sent funds to `/stock/`, the
 * OHLC/PE page whose own header comment calls that "wrong for funds".
 *
 * A helper only fixes the sites that know the instrument's type. Watchlist
 * items and holdings rows do NOT carry one (see `WatchlistItem` in
 * schema.prisma — symbol + exchange only), so they still resolve to
 * `/stock/…`; the redirect in `app/stock/[symbol]/page.tsx` is the safety net
 * that catches those. Helper first, redirect second: the helper keeps the URL
 * honest when we know better, the redirect keeps the PAGE honest when we do
 * not.
 *
 * ## Deliberately pure
 *
 * No Prisma, no `next/navigation`, no React. It is imported by client
 * components, by server components and by the redirect in a server page, and
 * it is unit-testable without a database.
 */

/** What a caller must know to be routed. Everything but `symbol` is optional. */
export interface InstrumentDetailTarget {
  /** Trading symbol, or the AMFI scheme code for an MF with no `schemeCode`. */
  symbol: string;
  /** NSE / BSE. Omitted when the caller genuinely does not know. */
  exchange?: string | null;
  /** Canonical `InstrumentMapping.instrumentType` when the caller has it. */
  instrumentType?: string | null;
  /** Search payloads spell the same thing `type`; accepted as a synonym. */
  type?: string | null;
  /** AMFI scheme code. Wins over `symbol` for the `/mf/` route. */
  schemeCode?: string | null;
  /** Fragment to append, WITHOUT the leading `#` (e.g. `"chart"`). */
  hash?: string | null;
  /**
   * Return path for the detail page's back button (`?from=`). Both fund pages
   * read it via `useSearchParams`.
   */
  from?: string | null;
}

/** Route families this helper can emit. Exported for tests and callers that branch. */
export type InstrumentRouteFamily = "etf" | "mf" | "stock";

/**
 * ETFs are the only fund-shaped exchange-traded type with a dedicated page.
 *
 * REIT/INVIT are grouped with ETFs by `FUND_INSTRUMENT_TYPES` on the DISCOVER
 * surfaces, but they have no NAV, no AMC and no scheme code, so `/etf/` — which
 * leads on iNAV and premium/discount — would be a worse page for them than
 * `/stock/`, not a better one. They stay on `/stock/` until they have a page of
 * their own.
 */
const ETF_TYPES = new Set(["ETF"]);
const MF_TYPES = new Set(["MF", "MUTUAL_FUND", "MUTUALFUND"]);
const INDEX_TYPES = new Set(["INDEX"]);

/**
 * First NON-EMPTY of `instrumentType` then `type`.
 *
 * `??` alone would be wrong: the search route emits both fields and synthetic
 * index rows set only `type`, so an empty-string `instrumentType` must fall
 * through rather than win. This mirrors `result.instrumentType || result.type`
 * in `app/api/market/search/search-logic.ts`.
 */
function normalizeType(target: InstrumentDetailTarget): string {
  const first = target.instrumentType?.trim();
  if (first) return first.toUpperCase();
  return (target.type?.trim() ?? "").toUpperCase();
}

/** Which route family an instrument belongs to. Split out so tests can assert it directly. */
export function instrumentRouteFamily(
  target: InstrumentDetailTarget
): InstrumentRouteFamily {
  const t = normalizeType(target);
  if (MF_TYPES.has(t)) return "mf";
  if (ETF_TYPES.has(t)) return "etf";
  return "stock";
}

/**
 * Build the query string from already-known-safe pairs.
 *
 * Hand-rolled rather than `URLSearchParams` because that encodes a space as
 * `+`, and these values land in a Next.js route param.
 */
function query(pairs: Array<[string, string | null | undefined]>): string {
  const parts = pairs
    .filter((p): p is [string, string] => !!p[1])
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/**
 * The canonical detail-page href for an instrument.
 *
 * Path segments are percent-encoded. That is not cosmetic: `M&M` is a real NSE
 * symbol, and the raw-interpolated `/stock/${symbol}?exchange=${exchange}` this
 * replaces produced `/stock/M&M?exchange=NSE`, which a URL parser reads as the
 * path `M` plus a stray `M` parameter.
 */
export function instrumentDetailHref(target: InstrumentDetailTarget): string {
  const family = instrumentRouteFamily(target);
  const t = normalizeType(target);
  const suffix = target.hash ? `#${target.hash}` : "";
  const exchange = target.exchange?.trim() || null;

  const from = target.from?.trim() || null;

  if (family === "mf") {
    const id = target.schemeCode?.trim() || target.symbol;
    return `/mf/${encodeURIComponent(id)}${query([["from", from]])}${suffix}`;
  }

  if (family === "etf") {
    return `/etf/${encodeURIComponent(target.symbol)}${query([
      ["exchange", exchange],
      ["from", from],
    ])}${suffix}`;
  }

  return `/stock/${encodeURIComponent(target.symbol)}${query([
    ["exchange", exchange],
    // `type=index` is what lets the stock page synthesise a Yahoo symbol for an
    // index that is not in `instrument_mappings`; dropping it silently degrades
    // an index to an equity lookup.
    ["type", INDEX_TYPES.has(t) ? "index" : null],
    ["from", from],
  ])}${suffix}`;
}
