/**
 * Pure logic for the TradingView UDF symbol-search endpoint.
 *
 * Extracted from `route.ts` so the input shaping (type/exchange filters,
 * limit parsing), the instrument-type → TradingView-type mapping, the MF
 * numeric-code classification, and the result-item builders can be unit
 * tested directly. The route imports & calls these — production runs the
 * same code the tests assert.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Datafeed.SearchSymbolResultItem/
 */
// Relative now that this lives INSIDE @usemoney/core — a package self-import
// resolves through the exports map and makes the module its own dependency.
import { withFormerlyHint } from "../index";

export interface SearchSymbolResultItem {
  symbol: string;
  full_name: string;
  description: string;
  exchange: string;
  ticker: string;
  type: string;
}

/**
 * Decide which corpora the type filter wants. Case-insensitive; an empty
 * filter wants everything. An unknown filter (e.g. "crypto") wants neither.
 */
export function computeTypeFilters(typeFilter: string): {
  wantsEquities: boolean;
  wantsFunds: boolean;
} {
  const normalized = typeFilter.toLowerCase();
  const wantsEquities =
    !normalized ||
    normalized === "stock" ||
    normalized === "etf" ||
    normalized === "index";
  const wantsFunds = !normalized || normalized === "fund";
  return { wantsEquities, wantsFunds };
}

/**
 * Decide which exchanges the exchange filter wants. Case-insensitive; an
 * empty filter wants everything. NSE/BSE map to the equity corpus, MF to the
 * mutual-fund corpus.
 */
export function computeExchangeFilters(exchangeFilter: string): {
  wantsExchangeNseBse: boolean;
  wantsExchangeMf: boolean;
} {
  const normalized = exchangeFilter.toUpperCase();
  const wantsExchangeNseBse =
    !normalized || normalized === "NSE" || normalized === "BSE";
  const wantsExchangeMf = !normalized || normalized === "MF";
  return { wantsExchangeNseBse, wantsExchangeMf };
}

/**
 * Parse the `limit` query param. Default 30, hard cap 100. A non-numeric or
 * zero value falls back to 30 (0 is falsy). Negative values pass through.
 */
export function computeSearchLimit(limitParam: string | null): number {
  return Math.min(parseInt(limitParam || "30", 10) || 30, 100);
}

/**
 * Map a raw `instrumentType` to a TradingView symbol type. Case-sensitive —
 * mirrors the route's `=== "ETF"` / `=== "INDEX"` checks. Anything else is a
 * stock.
 */
export function instrumentTypeToTvType(instrumentType: string): string {
  if (instrumentType === "ETF") return "etf";
  if (instrumentType === "INDEX") return "index";
  // MONEY-1093: DEBT fell through to "stock", so a government bond appeared in
  // the TradingView symbol search labelled as a share — on a chart where the
  // user is choosing what to trade. "bond" is declared in the UDF config's
  // symbols_types alongside the others.
  if (instrumentType === "DEBT") return "bond";
  return "stock";
}

/**
 * True when the search query is a pure scheme-code (digits only) → the MF
 * search keys off `schemeCode` prefix rather than name/AMC.
 */
export function isNumericCode(query: string): boolean {
  return /^\d+$/.test(query);
}

/**
 * When a specific (non-empty) type filter is set, only include an instrument
 * whose mapped TradingView type matches it.
 */
export function shouldIncludeEquity(
  typeFilter: string,
  instrumentType: string,
): boolean {
  const tvType = instrumentTypeToTvType(instrumentType);
  if (typeFilter && typeFilter !== tvType) return false;
  return true;
}

/** Build a TradingView search-result item for a mutual fund. */
export function buildMfResultItem(mf: {
  schemeCode: string;
  schemeName: string;
  amcName: string;
}): SearchSymbolResultItem {
  return {
    symbol: mf.schemeCode,
    full_name: `MF:${mf.schemeCode}`,
    description: `${mf.schemeName} (${mf.amcName})`,
    exchange: "MF",
    ticker: `MF:${mf.schemeCode}`,
    type: "fund",
  };
}

/** Build a TradingView search-result item for an equity / ETF / index. */
export function buildEquityResultItem(
  inst: {
    symbol: string;
    exchange: string;
    name: string;
    instrumentType: string;
    /** MONEY-1177 — former tickers, so a rename can explain itself. */
    previousSymbols?: string[];
  },
  /** The user's raw query, used only to decide whether to show the hint. */
  query = "",
): SearchSymbolResultItem {
  return {
    symbol: inst.symbol,
    full_name: `${inst.exchange}:${inst.symbol}`,
    // MONEY-1177: a chart search for a retired ticker resolves to the
    // successor; the description says why so it does not look like a mismatch.
    description: withFormerlyHint(inst.name, inst.previousSymbols, query),
    exchange: inst.exchange,
    ticker: `${inst.exchange}:${inst.symbol}`,
    type: instrumentTypeToTvType(inst.instrumentType),
  };
}
