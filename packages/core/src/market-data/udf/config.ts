/**
 * Static datafeed configuration for the TradingView UDF `config` endpoint.
 *
 * Extracted from `route.ts` so the exact config object the widget consumes can
 * be asserted directly (the route returns this constant verbatim).
 *
 * MOVED here by MONEY-1466 (A1): `apps/market-data` serves the same UDF
 * contract from Cloud Run, so the PAYLOAD has to live where both apps can
 * import it. The CACHE-CONTROL HEADER deliberately did NOT move — web's is
 * `private` because it sits behind Clerk, and the Cloud Run service's is
 * `public` because it is fronted by a CDN. Same body, different caching
 * semantics; sharing the constant would have made one of them wrong.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/
 */

export interface UdfExchange {
  value: string;
  name: string;
  desc: string;
}

export interface UdfSymbolType {
  name: string;
  value: string;
}

export interface UdfConfig {
  supports_search: boolean;
  supports_group_request: boolean;
  supports_marks: boolean;
  supports_timescale_marks: boolean;
  supports_time: boolean;
  supported_resolutions: string[];
  exchanges: UdfExchange[];
  symbols_types: UdfSymbolType[];
}

/**
 * The datafeed capability document TradingView reads once, before it asks for
 * anything else. No user data and no request input — the same bytes for every
 * caller, which is what makes it shareable between two very different fronts.
 *
 * ## THE BODY IS SHARED; THE `Cache-Control` DELIBERATELY IS NOT
 *
 * Two consumers serve this constant and they must NOT agree on how it is
 * cached, so no header constant lives in this file:
 *
 *   `apps/web`            `private, max-age=3600`  behind Clerk/demo auth, so
 *                                                  a CDN or corporate proxy
 *                                                  must never retain it
 *   `apps/market-data`    `public, max-age=3600`   behind Cloud CDN, where
 *                                                  being retained IS the point
 *
 * Each owns its own value (`CONFIG_CACHE_CONTROL` in web,
 * `CACHE_CONTROL.config` in the service). Hoisting one up here would silently
 * make the other wrong, and a wrong `Cache-Control` is invisible until
 * something has been cached that should not have been.
 *
 * One hour on both: this constant changes only when the resolution list or the
 * exchange list changes, and an hour bounds how long a deployed change takes to
 * reach an open tab.
 */
export const UDF_CONFIG: UdfConfig = {
  supports_search: true,
  supports_group_request: false,
  // MONEY-1176 — corporate-action glyphs at each ex-date. Raw prices gap at a
  // split (correctly), and without a mark that gap reads as a crash.
  supports_marks: true,
  supports_timescale_marks: false,
  supports_time: true,
  // Per-symbol supported_resolutions are returned by /symbols. The list here
  // is the union; widget gating happens server-side based on broker creds.
  supported_resolutions: [
    "1",
    "3",
    "5",
    "10",
    "15",
    "30",
    "60",
    "1D",
    "1W",
    "1M",
  ],
  exchanges: [
    { value: "", name: "All Exchanges", desc: "" },
    { value: "NSE", name: "NSE", desc: "National Stock Exchange of India" },
    { value: "BSE", name: "BSE", desc: "Bombay Stock Exchange" },
    { value: "MF", name: "MF", desc: "Indian Mutual Funds (AMFI)" },
  ],
  symbols_types: [
    { name: "All", value: "" },
    { name: "Stock", value: "stock" },
    { name: "ETF", value: "etf" },
    { name: "Fund", value: "fund" },
    { name: "Index", value: "index" },
    // MONEY-1093: bonds became a distinct instrumentType, and the search
    // endpoint used to label them "stock". Declaring the type lets the symbol
    // search filter them and stops a G-Sec being presented as a share.
    { name: "Bond", value: "bond" },
  ],
};
