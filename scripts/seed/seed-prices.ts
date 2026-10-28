/**
 * Seed Prices
 *
 * Refreshes latest quotes for all active instruments from Yahoo Finance.
 *
 * Usage: npx tsx scripts/seed/seed-prices.ts
 */

import "dotenv/config";
import {
  refreshAllQuotes,
  yahooFetchQuotes,
  type YahooQuoteData,
} from "@usemoney/core/market-data";

/**
 * Yahoo Finance batch quote fetcher.
 * Same implementation as workers/src/processors/price-sync.ts
 */
async function fetchYahooBatchQuotes(
  yahooSymbols: string[]
): Promise<Map<string, YahooQuoteData>> {
  const results = new Map<string, YahooQuoteData>();

  if (yahooSymbols.length === 0) return results;

  try {
    const rawQuotes = await yahooFetchQuotes(yahooSymbols);

    rawQuotes.forEach((quote, symbol) => {
      const prevClose = quote.regularMarketPreviousClose ?? 0;
      const hasBogusChange = prevClose === 0 && quote.regularMarketPrice > 0;

      results.set(symbol, {
        symbol,
        price: quote.regularMarketPrice,
        change: hasBogusChange ? 0 : (quote.regularMarketChange ?? 0),
        changePercent: hasBogusChange ? 0 : (quote.regularMarketChangePercent ?? 0),
        open: quote.regularMarketOpen ?? 0,
        high: quote.regularMarketDayHigh ?? 0,
        low: quote.regularMarketDayLow ?? 0,
        previousClose: prevClose,
        volume: quote.regularMarketVolume ?? 0,
        marketCap: quote.marketCap,
        timestamp:
          typeof quote.regularMarketTime === "number"
            ? new Date(quote.regularMarketTime * 1000)
            : new Date(),
      });
    });
  } catch (error) {
    console.error("Failed to fetch batch quotes:", error);
  }

  return results;
}

async function main() {
  console.log("Starting price refresh...");
  console.log("Source: Yahoo Finance | Batch size: 50");

  const result = await refreshAllQuotes(fetchYahooBatchQuotes, {
    batchSize: 50,
  });

  console.log(`\nPrice refresh complete:`);
  console.log(`  Refreshed: ${result.refreshed}`);
  console.log(`  Failed:    ${result.failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Price refresh failed:", err);
    process.exit(1);
  });
