/**
 * Sparkline Sync Processor
 *
 * Pre-computes and caches sparkline (close-price) arrays for the "hot"
 * symbol universe so list views (watchlist, markets overview, discover,
 * screener) can render from Redis instead of hitting Yahoo per-symbol.
 *
 * Hot universe:
 *   - All indices (InstrumentMapping where instrumentType = "INDEX")
 *   - Top 500 instruments by recent volume
 *   - Every symbol referenced by a Watchlist
 *   - Every symbol referenced by a ResearchList (when that table lands - safe no-op otherwise)
 *
 * Runs every 10 minutes during market hours via Cloud Scheduler.
 *
 * Design note: we intentionally do not hit Yahoo for ALL 7000+ NSE stocks.
 * Most will never be rendered as a sparkline in a list view. On-demand
 * fetches (the API route handles cache misses live) cover the long tail.
 */

import type { SparklineSyncMessage } from "@usemoney/types";
import { prisma } from "@usemoney/database";
import { getSparklines } from "@usemoney/services";
import type { SparklineSymbol, SparklineWindow } from "@usemoney/core";

const DEFAULT_WINDOWS: SparklineWindow[] = ["1D", "1W"];
const HOT_TOP_N = 500;

type Exchange = "NSE" | "BSE";

function isExchange(value: string): value is Exchange {
  return value === "NSE" || value === "BSE";
}

/**
 * Assemble the hot symbol universe from existing tables. Safe to run
 * before ResearchList ships - the .catch(() => []) swallows the missing-
 * model error cleanly.
 */
async function buildHotUniverse(): Promise<SparklineSymbol[]> {
  const [indices, topByVolume, watchlistItems] = await Promise.all([
    prisma.instrumentMapping.findMany({
      where: { isActive: true, instrumentType: "INDEX" },
      select: { symbol: true, exchange: true },
    }),
    prisma.latestQuote.findMany({
      where: { volume: { gt: 0 } },
      orderBy: { volume: "desc" },
      take: HOT_TOP_N,
      select: {
        instrument: { select: { symbol: true, exchange: true } },
      },
    }),
    // Watchlist items by symbol - dedupe below.
    prisma.watchlistItem
      .findMany({
        select: { symbol: true, exchange: true },
      })
      .catch(() => [] as Array<{ symbol: string; exchange: string }>),
  ]);

  const seen = new Set<string>();
  const universe: SparklineSymbol[] = [];

  const push = (symbol: string | null | undefined, exchange: string) => {
    if (!symbol) return;
    const exch = exchange.toUpperCase();
    if (!isExchange(exch)) return;
    const key = `${symbol}|${exch}`;
    if (seen.has(key)) return;
    seen.add(key);
    universe.push({ symbol, exchange: exch });
  };

  for (const idx of indices) push(idx.symbol, idx.exchange);
  for (const q of topByVolume) {
    if (q.instrument) push(q.instrument.symbol, q.instrument.exchange);
  }
  for (const item of watchlistItems) push(item.symbol, item.exchange);

  return universe;
}

/**
 * Chunk an array into groups of `size`. Keeps Yahoo's parallel fan-out
 * from overwhelming the crumb auth (each sub-batch goes through ~1 auth
 * check; 500 symbols in one shot would amplify any transient error).
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const CHUNK_SIZE = 20;

export async function processSparklineSync(
  data: SparklineSyncMessage,
): Promise<void> {
  const windows = data.windows ?? DEFAULT_WINDOWS;
  const symbols: SparklineSymbol[] = data.symbols?.length
    ? data.symbols
    : await buildHotUniverse();

  if (symbols.length === 0) {
    console.log("[sparkline-sync] empty universe, skipping");
    return;
  }

  console.log(
    `[sparkline-sync] pre-computing ${symbols.length} symbols × ${windows.length} windows`,
  );

  let ok = 0;
  let failed = 0;

  for (const window of windows) {
    for (const group of chunk(symbols, CHUNK_SIZE)) {
      const result = await getSparklines(group, window, {
        forceRefresh: data.forceRefresh ?? false,
      });
      if (!result.success) {
        console.warn(
          `[sparkline-sync] batch failed for window=${window}: ${result.error}`,
        );
        failed += group.length;
        continue;
      }
      for (const value of Object.values(result.data)) {
        if (value.closes.length > 0) ok++;
        else failed++;
      }
    }
  }

  console.log(`[sparkline-sync] done - ${ok} cached, ${failed} empty/failed`);
}
