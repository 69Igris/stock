/**
 * Chartink Strategy Sync Processor
 *
 * Scrapes Chartink screener strategy definitions and converts them
 * to our ScreenerFilter format. We don't call Chartink live for results -
 * we translate their strategy definitions and run them on our own DailyPrice data.
 *
 * Schedule: Monthly (1st of month, 10 PM IST)
 */

export interface ChartinkStrategySyncMessage {
  categories?: string[];
  delayMs?: number;
}

/** A Chartink screener category we translate into our ScreenerFilter format. */
export interface ChartinkCategory {
  id: string;
  name: string;
  url: string;
}

/** Default delay (ms) between category scrapes. */
export const DEFAULT_CHARTINK_DELAY_MS = 2000;

// Chartink category URLs
export const CHARTINK_CATEGORIES: ChartinkCategory[] = [
  {
    id: "bullish",
    name: "Bullish Patterns",
    url: "https://chartink.com/screeners/bullish",
  },
  {
    id: "bearish",
    name: "Bearish Patterns",
    url: "https://chartink.com/screeners/bearish",
  },
  {
    id: "volume",
    name: "Volume Screeners",
    url: "https://chartink.com/screeners/volume-shockers",
  },
  {
    id: "moving_average",
    name: "Moving Average",
    url: "https://chartink.com/screeners/moving-average",
  },
  {
    id: "rsi",
    name: "RSI Screeners",
    url: "https://chartink.com/screeners/rsi",
  },
  {
    id: "macd",
    name: "MACD Screeners",
    url: "https://chartink.com/screeners/macd",
  },
  {
    id: "candlestick",
    name: "Candlestick Patterns",
    url: "https://chartink.com/screeners/candlestick",
  },
  {
    id: "intraday",
    name: "Intraday Patterns",
    url: "https://chartink.com/screeners/intraday",
  },
  {
    id: "fundamental",
    name: "Fundamental",
    url: "https://chartink.com/screeners/fundamental",
  },
];

/**
 * Resolve which category IDs to process: the caller's list, or every known
 * category id when none supplied (`|| default` semantics — an empty array also
 * falls through to all, matching the live `||`).
 */
export function resolveChartinkCategoryIds(
  requested: string[] | undefined,
): string[] {
  return requested && requested.length > 0
    ? requested
    : CHARTINK_CATEGORIES.map((c) => c.id);
}

export async function processChartinkStrategySync(
  data: ChartinkStrategySyncMessage,
): Promise<void> {
  const categories = resolveChartinkCategoryIds(data.categories);
  const delayMs = data.delayMs || DEFAULT_CHARTINK_DELAY_MS;

  console.log(
    `[chartink-sync] Starting strategy sync for ${categories.length} categories`,
  );

  let processed = 0;
  let failed = 0;

  for (const cat of CHARTINK_CATEGORIES) {
    if (!categories.includes(cat.id)) continue;

    try {
      console.log(`[chartink-sync] Processing category: ${cat.name}`);

      // TODO: Implement scraping logic
      // 1. Fetch category page HTML
      // 2. Extract individual screener URLs
      // 3. For each screener, extract filter conditions
      // 4. Map Chartink filter syntax → our ScreenerFilter[] format
      // 5. Upsert as ScreenerStrategy with source: "chartink"
      //
      // Chartink uses a custom query language like:
      //   "Close > 200 SMA Close AND RSI(14) > 60 AND Volume > 2 * 20 SMA Volume"
      // This needs to be parsed into our ScreenerFilter format.
      //
      // For now, we have 28+ builtin strategies in strategies.ts
      // that cover the most common Chartink patterns.

      processed++;
      await new Promise((r) => setTimeout(r, delayMs));
    } catch (err) {
      console.error(`[chartink-sync] Failed for ${cat.name}:`, err);
      failed++;
    }
  }

  console.log(
    `[chartink-sync] Complete: processed=${processed}, failed=${failed}`,
  );
}
