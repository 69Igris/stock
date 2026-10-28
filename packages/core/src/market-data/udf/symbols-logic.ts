/**
 * Pure logic for the TradingView UDF symbol-resolution endpoint.
 *
 * Extracted from `route.ts` so the per-symbol resolution gating, the
 * "EXCHANGE:SYMBOL" prefix parse, and the `LibrarySymbolInfo` builders can be
 * unit tested directly. The route imports & calls these — production runs the
 * same code the tests assert.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Datafeed.LibrarySymbolInfo/
 */

// All resolutions the library accepts. Per-symbol filtering happens below.
export const ALL_INTRADAY_RESOLUTIONS = ["1", "3", "5", "10", "15", "30", "60"];
export const ZERODHA_ONLY_RESOLUTIONS = new Set(["3", "10"]);
export const DAILY_RESOLUTIONS = ["1D", "1W", "1M"];

export type TvSymbolType = "stock" | "etf" | "fund" | "index";

export interface ResolvedSymbol {
  ticker: string;
  name: string;
  full_name: string;
  description: string;
  type: TvSymbolType;
  session: string;
  timezone: string;
  exchange: string;
  listed_exchange: string;
  format: "price";
  pricescale: number;
  minmov: number;
  has_intraday: boolean;
  has_daily: boolean;
  has_weekly_and_monthly: boolean;
  supported_resolutions: string[];
  volume_precision: number;
  data_status: "streaming" | "endofday" | "delayed_streaming";
  has_no_volume: boolean;
  visible_plots_set?: "ohlcv" | "ohlc" | "c";
}

/**
 * Compute the resolutions the user can actually request for this symbol.
 * - MFs / indices: daily + above only.
 * - Equities WITHOUT broker creds: drop Zerodha-exclusive 3m and 10m.
 * - Equities WITH broker creds: full set.
 */
export function computeSupportedResolutions(
  type: TvSymbolType,
  hasBrokerCreds: boolean,
): string[] {
  if (type === "fund") {
    return [...DAILY_RESOLUTIONS];
  }
  if (type === "index") {
    // Indices are intraday-capable from Yahoo, but not from Zerodha; allow
    // intraday EXCEPT Zerodha-only resolutions regardless of broker status.
    return [
      ...ALL_INTRADAY_RESOLUTIONS.filter(
        (r) => !ZERODHA_ONLY_RESOLUTIONS.has(r),
      ),
      ...DAILY_RESOLUTIONS,
    ];
  }
  // Stock / ETF
  const intraday = hasBrokerCreds
    ? ALL_INTRADAY_RESOLUTIONS
    : ALL_INTRADAY_RESOLUTIONS.filter((r) => !ZERODHA_ONLY_RESOLUTIONS.has(r));
  return [...intraday, ...DAILY_RESOLUTIONS];
}

/**
 * Split "EXCHANGE:SYMBOL" into its prefix and raw symbol. With no colon the
 * exchange defaults to NSE. Only the FIRST colon splits (so "FOO:BAR:BAZ" →
 * prefix "FOO", rawSymbol "BAR:BAZ").
 */
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

/** Supported equity exchanges. MF is handled on its own branch. */
const SUPPORTED_EQUITY_EXCHANGES = new Set(["NSE", "BSE"]);

/**
 * True when the prefix is neither MF nor a supported equity exchange — the
 * route returns an error body for these.
 */
export function isUnsupportedEquityExchange(prefix: string): boolean {
  return prefix !== "MF" && !SUPPORTED_EQUITY_EXCHANGES.has(prefix);
}

/**
 * Build a `LibrarySymbolInfo` for an NSE/BSE-listed equity or ETF.
 * `data_status` is delayed_streaming when broker creds exist, else endofday.
 */
export function buildEquitySymbolInfo(args: {
  symbol: string;
  exchange: string;
  description: string;
  type: "stock" | "etf";
  hasBrokerCreds: boolean;
}): ResolvedSymbol {
  const { symbol, exchange, description, type, hasBrokerCreds } = args;
  return {
    ticker: `${exchange}:${symbol}`,
    name: symbol,
    full_name: `${exchange}:${symbol}`,
    description,
    type,
    session: "0915-1530",
    timezone: "Asia/Kolkata",
    exchange,
    listed_exchange: exchange,
    format: "price",
    pricescale: 100,
    minmov: 1,
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: true,
    supported_resolutions: computeSupportedResolutions(type, hasBrokerCreds),
    volume_precision: 0,
    data_status: hasBrokerCreds ? "delayed_streaming" : "endofday",
    has_no_volume: false,
  };
}

/**
 * Build a `LibrarySymbolInfo` for a US listing. MONEY-1478.
 *
 * ## THE TICKER IS THE LISTING ID, NOT THE SYMBOL
 *
 * Every other builder here returns `EXCHANGE:SYMBOL`, and for the US that would
 * be WRONG rather than merely inconsistent. A TICKER IS NOT A SECURITY: the
 * master holds two rows for `DOW` on NYSE — Dow Chemical 1972-2017 and Dow Inc.
 * 2019- — identical in exchange, assetType and currency. `Candle` and the D1
 * tiles are keyed on `listingId` (`{symbol}:{exchange}:{listingStartDate}`) for
 * exactly that reason, so `resolveListing` parses a 3-part US symbol and
 * `/udf/history` reads the tile under it.
 *
 * TradingView caches the `ticker` it is handed and requests every subsequent
 * bar under it. Returning `NASDAQ:AAPL` would have the widget ask history for a
 * 2-part symbol, which `resolveListing` reads as an INDIA listing on a
 * non-existent "NASDAQ" exchange — a resolve that succeeds and then charts
 * blank, which is the defect MONEY-1476 was spent closing. For `DOW` it would
 * be worse than blank: two companies' histories under one name.
 *
 * ## SESSION AND TIMEZONE ARE THE VENUE'S, NOT OURS
 *
 * `0930-1600` in `America/New_York`. Handing TradingView Asia/Kolkata for a US
 * listing does not fail — it draws the bars on the wrong days, which no number
 * on the chart reveals. RTH only: pre/post bars exist on the realtime feed but
 * the D1 tiles are EOD, and declaring an extended session would draw empty
 * space either side of every candle.
 *
 * `has_no_volume` is FALSE: these are Tiingo EOD bars, which are trade-derived
 * and carry real volume — unlike the `TIINGO_RT` quote-mid bars, whose zero is
 * structural. A fund's NAV series is the exception and is handled by
 * `buildFundSymbolInfo`.
 */
export function buildUsSymbolInfo(args: {
  listingId: string;
  symbol: string;
  exchange: string;
  description: string;
  type: "stock" | "etf" | "fund";
}): ResolvedSymbol {
  const { listingId, symbol, exchange, description, type } = args;
  const isFund = type === "fund";
  return {
    ticker: listingId,
    name: symbol,
    full_name: listingId,
    description,
    type,
    // A mutual fund prices ONCE, after the close. Giving it an RTH session
    // would have the widget draw an intraday grid across a single daily point.
    session: isFund ? "0000-2359" : "0930-1600",
    timezone: "America/New_York",
    exchange,
    listed_exchange: exchange,
    format: "price",
    pricescale: 100,
    minmov: 1,
    // No US INTRADAY tiles exist — `tile-build-d1` is daily by name and by
    // output. Declaring intraday here makes the widget request a resolution
    // that can only answer `no_data`, which renders as a blank chart with no
    // message rather than as the "not available" it is.
    has_intraday: false,
    has_daily: true,
    has_weekly_and_monthly: true,
    // `hasBrokerCreds` is an INDIA concept (Zerodha-only 3m/10m). Passing it
    // here would let a Zerodha connection widen a US resolution list.
    supported_resolutions: [...DAILY_RESOLUTIONS],
    volume_precision: 0,
    data_status: "endofday",
    has_no_volume: isFund,
    ...(isFund ? { visible_plots_set: "c" as const } : {}),
  };
}

/**
 * Build a `LibrarySymbolInfo` for an index. Indices hide volume and render the
 * close-only line view; `data_status` is always delayed_streaming.
 */
export function buildIndexSymbolInfo(args: {
  symbol: string;
  exchange: string;
  description: string;
  hasBrokerCreds: boolean;
}): ResolvedSymbol {
  const { symbol, exchange, description, hasBrokerCreds } = args;
  return {
    ticker: `${exchange}:${symbol}`,
    name: symbol,
    full_name: `${exchange}:${symbol}`,
    description,
    type: "index",
    session: "0915-1530",
    timezone: "Asia/Kolkata",
    exchange,
    listed_exchange: exchange,
    format: "price",
    pricescale: 100,
    minmov: 1,
    has_intraday: true,
    has_daily: true,
    has_weekly_and_monthly: true,
    supported_resolutions: computeSupportedResolutions("index", hasBrokerCreds),
    volume_precision: 0,
    data_status: "delayed_streaming",
    has_no_volume: true,
    visible_plots_set: "c",
  };
}

/**
 * Build a `LibrarySymbolInfo` for a mutual fund. MFs publish a single NAV per
 * day (no trading session), are quoted to 4dp, and hide volume.
 */
export function buildFundSymbolInfo(args: {
  schemeCode: string;
  schemeName: string;
  amcName: string;
  hasBrokerCreds: boolean;
}): ResolvedSymbol {
  const { schemeCode, schemeName, amcName, hasBrokerCreds } = args;
  return {
    ticker: `MF:${schemeCode}`,
    name: schemeCode,
    full_name: `MF:${schemeCode}`,
    description: schemeName,
    type: "fund",
    session: "24x7", // MFs publish a single NAV per day; no trading session
    timezone: "Asia/Kolkata",
    exchange: "MF",
    listed_exchange: amcName || "MF",
    format: "price",
    pricescale: 10000, // 4 decimal places - MFs are quoted to 4dp
    minmov: 1,
    has_intraday: false,
    has_daily: true,
    has_weekly_and_monthly: true,
    supported_resolutions: computeSupportedResolutions("fund", hasBrokerCreds),
    volume_precision: 0,
    data_status: "endofday",
    has_no_volume: true,
    visible_plots_set: "c",
  };
}
