/**
 * Currency Exchange Rate Service
 *
 * Fetches real-time and cached exchange rates from Yahoo Finance.
 * Primary use: INR/USD conversion for global fund comparison.
 * Cached in-memory for 1 hour.
 */

const rateCache = new Map<string, { rate: number; expiry: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Minimal shape this module needs from a Yahoo quote: just the spot price.
 * Kept structural so it stays compatible with `YahooRawQuote` from
 * `../market-data/yahoo-api` (whose `regularMarketPrice` is `number`).
 */
export interface ExchangeRateQuote {
  regularMarketPrice?: number | null;
}

/**
 * Fetch function type for currency-pair quotes — injected by the caller.
 *
 * Mirrors the `YahooBatchQuoteFetcher` dependency-injection pattern in
 * `../market-data/prices/quote-service.ts`: production passes a closure over
 * the real Yahoo call, tests pass a fake. Maps each requested symbol to its
 * quote (absent key = symbol not resolved).
 */
export type ExchangeRateFetcher = (
  symbols: string[],
) => Promise<Map<string, ExchangeRateQuote>>;

/**
 * A finite, strictly-positive number is the only thing that can be a valid FX
 * rate. Yahoo can echo `0`, a negative, `NaN`, or a non-finite value for a
 * stale/garbage pair; caching any of those would silently corrupt every
 * downstream conversion, so we treat them as "no rate".
 */
function isValidRate(rate: number | null | undefined): rate is number {
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

/**
 * Default fetcher: closes over the real Yahoo Finance batch-quote call.
 * Lazily imported so production callers are unchanged and the heavy
 * market-data module is only pulled in when an actual fetch is needed.
 */
const defaultFetcher: ExchangeRateFetcher = async (symbols) => {
  const { fetchQuotes } = await import("../market-data/yahoo-api");
  return fetchQuotes(symbols);
};

/**
 * Get exchange rate between two currencies.
 * Uses Yahoo Finance currency pairs (e.g., USDINR=X).
 *
 * @param from - Source currency code (e.g. "USD").
 * @param to - Target currency code (e.g. "INR").
 * @param fetcher - Optional injectable quote fetcher (DI seam). Defaults to the
 *   real Yahoo Finance call, so production callers need not pass it.
 * @returns The rate to multiply `from` amount to get `to` amount, or `null`
 *   when no valid (finite, positive) rate is available.
 */
export async function getExchangeRate(
  from: string,
  to: string,
  fetcher: ExchangeRateFetcher = defaultFetcher,
): Promise<number | null> {
  if (from.toUpperCase() === to.toUpperCase()) return 1;

  const pair = `${from.toUpperCase()}${to.toUpperCase()}`;
  const cacheKey = pair;

  // Check cache
  const cached = rateCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.rate;
  }

  try {
    const yahooSymbol = `${pair}=X`;
    const quotes = await fetcher([yahooSymbol]);
    const quote = quotes.get(yahooSymbol);

    // Positivity guard: only a finite, strictly-positive rate is cacheable.
    // A 0 / negative / NaN upstream price is treated as provider failure and
    // falls through to the reverse pair (and ultimately `null`).
    if (isValidRate(quote?.regularMarketPrice)) {
      const rate = quote!.regularMarketPrice as number;
      rateCache.set(cacheKey, { rate, expiry: Date.now() + CACHE_TTL_MS });
      return rate;
    }

    // Try reverse pair
    const reversePair = `${to.toUpperCase()}${from.toUpperCase()}`;
    const reverseSymbol = `${reversePair}=X`;
    const reverseQuotes = await fetcher([reverseSymbol]);
    const reverseQuote = reverseQuotes.get(reverseSymbol);

    if (isValidRate(reverseQuote?.regularMarketPrice)) {
      const rate = 1 / (reverseQuote!.regularMarketPrice as number);
      // Inverting a finite positive is always a finite positive, but guard
      // anyway so the cache invariant (only valid rates) holds unconditionally.
      if (isValidRate(rate)) {
        rateCache.set(cacheKey, { rate, expiry: Date.now() + CACHE_TTL_MS });
        return rate;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Convert an amount from one currency to another.
 *
 * @param fetcher - Optional injectable quote fetcher (DI seam), forwarded to
 *   `getExchangeRate`. Defaults to the real Yahoo Finance call.
 */
export async function convertCurrency(
  amount: number,
  from: string,
  to: string,
  fetcher: ExchangeRateFetcher = defaultFetcher,
): Promise<number | null> {
  const rate = await getExchangeRate(from, to, fetcher);
  if (rate === null) return null;
  return amount * rate;
}

/**
 * Get USD to INR rate (most common conversion).
 *
 * @param fetcher - Optional injectable quote fetcher (DI seam), forwarded to
 *   `getExchangeRate`. Defaults to the real Yahoo Finance call.
 */
export async function getUsdToInr(
  fetcher: ExchangeRateFetcher = defaultFetcher,
): Promise<number | null> {
  return getExchangeRate("USD", "INR", fetcher);
}

/**
 * Common currency codes for supported markets.
 */
export const MARKET_CURRENCIES: Record<string, string> = {
  IN: "INR",
  US: "USD",
  GB: "GBP",
  EU: "EUR",
  JP: "JPY",
  SG: "SGD",
  HK: "HKD",
  AU: "AUD",
  CA: "CAD",
};
