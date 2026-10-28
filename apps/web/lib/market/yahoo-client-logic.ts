/**
 * Pure helpers for the Yahoo Finance client.
 *
 * Extracted from `yahoo-client.ts` (which also imports Prisma + the network
 * fetchers) so the symbol/exchange parsing, period→date math, and the raw
 * quote → normalized QuoteData mapping have real, importable units under
 * test without dragging in the DB/network module graph. `yahoo-client.ts`
 * imports these — there is no dead duplicate.
 */

import type { YahooRawQuote } from "@usemoney/core/market-data";

// ============== TYPES ==============

/**
 * Where one quote came from and how old it is — MONEY-1309.
 *
 * OPTIONAL, and absent on every Yahoo quote: for India there is exactly one
 * provider, so a per-quote label would say the same thing on every row and
 * teach the reader to ignore it. It is populated on the US path, where a batch
 * can legitimately mix a live quote with yesterday's close and the envelope's
 * single `source` therefore cannot be honest about all of it.
 *
 * Structurally the same shape as `SectionProvenance`
 * (`components/stock/SectionShell.tsx`), so the chip that already renders
 * provenance for the data-engine sections renders this without a translation.
 * `fallback` carries its established meaning there: not the preferred provider.
 */
export interface QuoteProvenance {
  /** e.g. "TIINGO_RT" (a live quote) or "TIINGO" (the EOD close). */
  source: string;
  /** ISO timestamp of what the NUMBER describes, not of the response. */
  asOf: string;
  /** True when this is a stand-in for the preferred provider. */
  fallback: boolean;
  /** US session the quote was taken in: pre / rth / post / closed. */
  session?: string;
  note?: string;
}

export interface QuoteData {
  symbol: string;
  exchange: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  timestamp: Date;
  marketCap?: number;
  pe?: number;
  eps?: number;
  week52High?: number;
  week52Low?: number;
  /** Populated on the US path only — see {@link QuoteProvenance}. */
  provenance?: QuoteProvenance;
}

export type Period =
  | "1d"
  | "5d"
  | "1mo"
  | "3mo"
  | "6mo"
  | "1y"
  | "2y"
  | "5y"
  | "10y"
  | "ytd"
  | "max";

// ============== HELPERS ==============

/**
 * Map a raw Yahoo quote into the normalized QuoteData shape.
 *
 * Guards against the "bogus change" case: when previousClose is missing/zero
 * but a positive price exists (e.g. fresh IPO / newly-listed instrument),
 * Yahoo sometimes reports a 100% change — we zero it so a single bad row
 * can't poison a heatmap/sparkline aggregate.
 */
export function rawQuoteToQuoteData(
  yahooSymbol: string,
  quote: YahooRawQuote
): QuoteData {
  const prevClose = quote.regularMarketPreviousClose || 0;
  const hasBogusChange = prevClose === 0 && quote.regularMarketPrice > 0;

  return {
    symbol: extractSymbol(yahooSymbol),
    exchange: extractExchange(yahooSymbol),
    name: quote.shortName || quote.longName || yahooSymbol,
    price: quote.regularMarketPrice,
    change: hasBogusChange ? 0 : quote.regularMarketChange || 0,
    changePercent: hasBogusChange ? 0 : quote.regularMarketChangePercent || 0,
    open: quote.regularMarketOpen || 0,
    high: quote.regularMarketDayHigh || 0,
    low: quote.regularMarketDayLow || 0,
    previousClose: prevClose,
    volume: quote.regularMarketVolume || 0,
    timestamp:
      typeof quote.regularMarketTime === "number"
        ? new Date(quote.regularMarketTime * 1000)
        : new Date(),
    marketCap: quote.marketCap,
    pe: quote.trailingPE,
    eps: quote.epsTrailingTwelveMonths,
    ...sane52WeekRange(quote),
  };
}

/**
 * Yahoo's 52-week fields, but only when they can actually BE a 52-week range
 * (MONEY-1198).
 *
 * Reported live on LAPL.BO, 2026-08-14:
 *
 *   52W HIGH  Rs 125.00      <- BELOW the previous close
 *   52W LOW   Rs 121.88      <- exactly today's open
 *   PREV CLOSE Rs 128.29
 *   DAY RANGE Rs 121.88 - Rs 125.00
 *
 * The "52-week" range was today's DAY range, and its high sat below last
 * night's close — a range that, read literally, says the stock never reached
 * within a year a price it closed at yesterday. LAPL is recently listed, so
 * Yahoo has almost no history for it and its 52-week fields degenerate to the
 * current session. Passing that through verbatim printed a fact that is not
 * merely stale but impossible.
 *
 * THE TEST IS CONTAINMENT, not plausibility. A genuine 52-week window must
 * contain every price the stock has traded at inside it — certainly today's
 * price and yesterday's close. That is checkable from fields we already hold,
 * needs no history of our own, and cannot reject a legitimately narrow range on
 * a quiet stock (which is why "high and low are close together" would be the
 * wrong test).
 *
 * On failure both fields are OMITTED rather than clamped or recomputed.
 * Widening the range to fit would invent a high the stock never traded at, and
 * the UI already renders a missing metric as "—". "We could not establish this"
 * is a distinct, honest third state; a wrong number is not.
 */
function sane52WeekRange(quote: YahooRawQuote): {
  week52High?: number;
  week52Low?: number;
} {
  const high = quote.fiftyTwoWeekHigh;
  const low = quote.fiftyTwoWeekLow;
  if (typeof high !== "number" || typeof low !== "number") return {};
  if (!Number.isFinite(high) || !Number.isFinite(low)) return {};
  if (high < low) return {};

  // Every price we can see must fall inside the window. `previousClose` is the
  // one that caught LAPL; `regularMarketPrice` catches the mirror-image case
  // where the range is stale on the other side.
  const mustContain = [
    quote.regularMarketPrice,
    quote.regularMarketPreviousClose,
  ].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0
  );

  for (const v of mustContain) {
    if (v > high || v < low) return {};
  }

  return { week52High: high, week52Low: low };
}

/**
 * Extract base symbol from a Yahoo symbol (e.g. RELIANCE.NS -> RELIANCE).
 * Index symbols (leading ^) are returned unchanged.
 */
export function extractSymbol(yahooSymbol: string): string {
  if (yahooSymbol.startsWith("^")) {
    // Index symbols
    return yahooSymbol;
  }
  return yahooSymbol.replace(/\.(NS|BO)$/, "");
}

/**
 * Determine the exchange from a Yahoo symbol suffix / known index ticker.
 * Defaults to NSE.
 */
export function extractExchange(yahooSymbol: string): string {
  if (yahooSymbol.endsWith(".NS")) return "NSE";
  if (yahooSymbol.endsWith(".BO")) return "BSE";
  if (yahooSymbol.startsWith("^")) {
    if (yahooSymbol === "^NSEI" || yahooSymbol === "^NSEBANK") return "NSE";
    if (yahooSymbol === "^BSESN") return "BSE";
  }
  return "NSE"; // Default
}

/**
 * Map a Yahoo exchange code to the canonical exchange name.
 * Unknown codes pass through unchanged.
 */
export function mapExchange(yahooExchange: string): string {
  const exchangeMap: Record<string, string> = {
    NSI: "NSE",
    NSE: "NSE",
    BSE: "BSE",
    BOM: "BSE",
  };
  return exchangeMap[yahooExchange] || yahooExchange;
}

/**
 * Go back `months` calendar months, CLAMPING the day to the target month.
 *
 * MONEY-1274. `setMonth(getMonth() - n)` keeps the day-of-month and lets the
 * Date roll over when the target month is shorter — so on 29 August, "6mo"
 * asks for 29 February, and in a non-leap year JS silently returns 1 MARCH.
 * The user gets a window one month shorter than the one they picked, and only
 * on the 29th-31st, which is why it survived: it is right for ~90% of the
 * calendar and the chart still renders.
 *
 * Clamping to the last valid day (29 Aug -6mo -> 28 Feb) is the conventional
 * reading of "six months ago" and never crosses into the wrong month.
 */
export function monthsBack(from: Date, months: number): Date {
  const day = from.getDate();
  const out = new Date(from);
  // Move to the 1st FIRST: shifting the month while the day is 29-31 is what
  // triggers the overflow in the first place.
  out.setDate(1);
  out.setMonth(out.getMonth() - months);
  const lastDayOfTarget = new Date(
    out.getFullYear(),
    out.getMonth() + 1,
    0
  ).getDate();
  out.setDate(Math.min(day, lastDayOfTarget));
  return out;
}

/**
 * Go back `years`, clamping 29 Feb to 28 Feb in a non-leap target year.
 *
 * Same defect class as {@link monthsBack}: `setFullYear(y - 1)` on 29 Feb 2024
 * returns 1 MARCH 2023, silently moving the window into the wrong month.
 */
function yearsBack(from: Date, years: number): Date {
  return monthsBack(from, years * 12);
}

/**
 * Compute the start Date for a period string, relative to now.
 * Unknown periods fall back to one month.
 */
export function getPeriodStartDate(period: Period): Date {
  const now = new Date();
  const startDate = new Date(now);

  switch (period) {
    case "1d":
      startDate.setDate(now.getDate() - 1);
      break;
    case "5d":
      startDate.setDate(now.getDate() - 5);
      break;
    case "1mo":
      return monthsBack(now, 1);
    case "3mo":
      return monthsBack(now, 3);
    case "6mo":
      return monthsBack(now, 6);
    case "1y":
      return yearsBack(now, 1);
    case "2y":
      return yearsBack(now, 2);
    case "5y":
      return yearsBack(now, 5);
    case "10y":
      return yearsBack(now, 10);
    case "ytd":
      startDate.setMonth(0, 1);
      break;
    case "max":
      startDate.setFullYear(1970);
      break;
    default:
      return monthsBack(now, 1);
  }

  return startDate;
}

// ============== INDEX CONSTANTS ==============

/** Common Indian market indices (Yahoo tickers). */
export const INDIAN_INDICES = {
  NIFTY_50: "^NSEI",
  NIFTY_BANK: "^NSEBANK",
  SENSEX: "^BSESN",
  NIFTY_IT: "^CNXIT",
  NIFTY_MIDCAP_100: "^CNXMDCP",
  NIFTY_NEXT_50: "^NSMIDCP",
} as const;
