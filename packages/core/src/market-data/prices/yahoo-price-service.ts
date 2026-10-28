/**
 * Yahoo Price Service - Fetch-and-Store Pattern
 *
 * Fetches historical OHLCV data from Yahoo Finance and caches it in the
 * DailyPrice collection. Subsequent requests for the same date range
 * are served from the database, with gap-filling for missing dates.
 *
 * This module lives in packages/core (no Yahoo Finance library dependency).
 * The actual Yahoo Finance API calls are made via the web app's yahoo-client
 * or via a lightweight fetch wrapper used by the worker.
 */

import { prisma } from "@usemoney/database";
import {
  type HistoricalBar,
  normalizeDate,
  toHistoricalBar,
  yahooFillRange,
} from "./yahoo-price-logic";
import { widenCandleRange } from "../candle-integrity";
import { mayWritePriceSource } from "../price-source-authority";

// HistoricalBar lives in ./yahoo-price-logic (the pure-logic source of truth);
// re-exported here so existing consumers can keep importing it from this module.
export type { HistoricalBar };

/**
 * Fetch function type - injected so this module doesn't depend on yahoo-finance2.
 * The caller provides a function that fetches historical data from Yahoo Finance.
 */
export type YahooHistoricalFetcher = (
  yahooSymbol: string,
  startDate: Date,
  endDate: Date,
) => Promise<HistoricalBar[]>;

/**
 * Get historical prices for an instrument, using DB cache with gap-filling.
 *
 * Flow:
 * 1. Check DailyPrice for existing data in the date range
 * 2. Identify gaps (missing trading dates)
 * 3. If gaps outside the exchange's span: fetch THAT range from Yahoo → upsert
 * 4. Return combined data from DB
 *
 * @param instrumentId - The InstrumentMapping ObjectId
 * @param startDate - Start of date range (inclusive)
 * @param endDate - End of date range (inclusive)
 * @param fetchFromYahoo - Injected Yahoo fetch function
 */
export async function getHistoricalPrices(
  instrumentId: string,
  startDate: Date,
  endDate: Date,
  fetchFromYahoo: YahooHistoricalFetcher,
): Promise<HistoricalBar[]> {
  // Normalize dates to UTC midnight
  const start = normalizeDate(startDate);
  const end = normalizeDate(endDate);

  // 1. Check existing data in DB
  const existingPrices = await prisma.dailyPrice.findMany({
    where: {
      instrumentId,
      date: { gte: start, lte: end },
    },
    orderBy: { date: "asc" },
  });

  // 2. Determine what, if anything, Yahoo may fill. Never inside the span the
  //    exchange covers (MONEY-1382): every row is returned, and a vendor row
  //    carries the instant it was fetched so the reader applies each split once.
  const fill = yahooFillRange(existingPrices, start, end);

  if (fill) {
    // Get the instrument's Yahoo symbol
    const instrument = await prisma.instrumentMapping.findUnique({
      where: { id: instrumentId },
      select: { yahooSymbol: true },
    });

    if (!instrument?.yahooSymbol) {
      // Return whatever we have from DB
      return existingPrices.map(toHistoricalBar);
    }

    // 3. Fetch from Yahoo and store — only sessions before the period2 asked
    //    for, whatever the vendor returns, so nothing lands inside coverage.
    const fetchedBars = (
      await fetchFromYahoo(instrument.yahooSymbol, fill.start, fill.end)
    ).filter((b) => normalizeDate(b.date) < fill.end);

    if (fetchedBars.length > 0) {
      await upsertDailyPrices(instrumentId, fetchedBars);
    }

    // 4. Return fresh data from DB
    const freshPrices = await prisma.dailyPrice.findMany({
      where: {
        instrumentId,
        date: { gte: start, lte: end },
      },
      orderBy: { date: "asc" },
    });

    return freshPrices.map(toHistoricalBar);
  }

  return existingPrices.map(toHistoricalBar);
}

/**
 * Backfill historical prices for an instrument.
 * Used by the price-sync worker to pre-populate price data.
 *
 * @param instrumentId - The InstrumentMapping ObjectId
 * @param yahooSymbol - The Yahoo Finance symbol
 * @param startDate - Start of backfill range
 * @param endDate - End of backfill range
 * @param fetchFromYahoo - Injected Yahoo fetch function
 */
export async function backfillPrices(
  instrumentId: string,
  yahooSymbol: string,
  startDate: Date,
  endDate: Date,
  fetchFromYahoo: YahooHistoricalFetcher,
): Promise<{ inserted: number; errors: number }> {
  const start = normalizeDate(startDate);
  const end = normalizeDate(endDate);

  let inserted = 0;
  let errors = 0;

  try {
    const bars = await fetchFromYahoo(yahooSymbol, start, end);

    if (bars.length > 0) {
      const result = await upsertDailyPrices(instrumentId, bars);
      inserted = result.upserted;
      errors = result.failed;
    }
  } catch (error) {
    console.error(`Failed to backfill prices for ${yahooSymbol}:`, error);
    errors = 1;
  }

  return { inserted, errors };
}

/**
 * Upsert daily prices into the database.
 *
 * Performance: the naive "one upsert per bar in a loop" pattern is O(N)
 * round-trips to MongoDB, which for a 90-day backfill on hundreds of
 * instruments easily exceeds the caller's 10-second DB timeout
 * (apps/web/lib/market/yahoo-client.ts:238). The fix is to diff against
 * what's already in the DB, bulk-insert the missing bars with
 * `createMany` (single round-trip), and only `upsert` the one
 * mutable bar (today's, whose close moves intraday).
 *
 *   Step 1: findMany existing dates in range              (1 round-trip)
 *   Step 2: createMany missing historical bars            (1 round-trip)
 *   Step 3: upsert today's bar only if present in input   (0 or 1 round-trip)
 *
 * Total: 2–3 round-trips regardless of bar count, vs N round-trips before.
 *
 * Historical correctness: a 2023 close never changes, so skipping bars
 * that already exist is safe. Today's bar is re-written every time because
 * the close moves as the market trades.
 *
 * Why not `createMany({skipDuplicates:true})`? Prisma's support for it on
 * MongoDB is inconsistent - see the sibling mf-nav-service.ts which
 * explicitly avoids it. A findMany + diff is portable and deterministic.
 */
async function upsertDailyPrices(
  instrumentId: string,
  bars: HistoricalBar[],
): Promise<{ upserted: number; failed: number }> {
  if (bars.length === 0) return { upserted: 0, failed: 0 };

  let upserted = 0;
  let failed = 0;
  /** Bars dropped for an unrepairable OHLC defect (non-positive price). */
  let failedIntegrity = 0;

  const todayMs = normalizeDate(new Date()).getTime();

  // Normalize dates once and split today's bar out from the immutable past.
  const historicalBars: Array<HistoricalBar & { _date: Date }> = [];
  const todayBars: Array<HistoricalBar & { _date: Date }> = [];
  for (const bar of bars) {
    // MONEY-1175: repair the range BEFORE the row is written. Yahoo emits bars
    // with open == high == low and a different close — 46,573 of them reached
    // prod, all in 2026. Both numbers are real prices from that session; only
    // the range between them is missing, so widening low/high to span what we
    // observed fixes the candle without inventing a price. A bar with a
    // non-positive price (Yahoo also sends open: 0) cannot be rescued and is
    // dropped rather than stored as an undrawable row.
    const fixed = widenCandleRange(bar);
    if (!fixed) {
      failedIntegrity++;
      continue;
    }
    const _date = normalizeDate(bar.date);
    const repaired = { ...bar, ...fixed, _date };
    if (_date.getTime() === todayMs) {
      todayBars.push(repaired);
    } else {
      historicalBars.push(repaired);
    }
  }

  // ── Historical bars ──
  if (historicalBars.length > 0) {
    // Bound the date range for an efficient index scan on
    // [instrumentId, date].
    const minDate = historicalBars.reduce(
      (min, b) => (b._date < min ? b._date : min),
      historicalBars[0]!._date,
    );
    const maxDate = historicalBars.reduce(
      (max, b) => (b._date > max ? b._date : max),
      historicalBars[0]!._date,
    );

    try {
      const existing = await prisma.dailyPrice.findMany({
        where: {
          instrumentId,
          date: { gte: minDate, lte: maxDate },
        },
        select: { date: true },
      });
      const existingKeys = new Set(existing.map((r) => r.date.getTime()));

      const missing = historicalBars.filter(
        (b) => !existingKeys.has(b._date.getTime()),
      );

      if (missing.length > 0) {
        const result = await prisma.dailyPrice.createMany({
          data: missing.map((bar) => ({
            instrumentId,
            date: bar._date,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            adjClose: bar.adjClose,
            source: "YAHOO",
          })),
        });
        upserted += result.count;
      }
      // Bars that already existed aren't counted as upserted OR failed -
      // they're a no-op (same logical result as the old upsert loop).
    } catch (error) {
      console.error(
        `[yahoo-price-service] historical bulk insert failed for ${instrumentId}:`,
        error,
      );
      failed += historicalBars.length;
    }
  }

  // ── Today's bar ── upsert so intraday re-runs refresh the close.
  //
  // MONEY-1175: guarded by source precedence. The `update:` clause below never
  // set `source`, so when the nightly bhavcopy had already written today's row
  // this path overwrote the exchange's OHLC with Yahoo's while the row went on
  // claiming `source: "BHAVCOPY"`. That is a provenance lie — worse than a
  // wrong number, because every downstream check (including the audit that
  // found these) trusts `source` to say where a value came from.
  //
  // `mayWritePriceSource` allows EQUAL authority, which is what makes the
  // intraday refresh keep working: Yahoo rewriting its own bar as the close
  // moves is legitimate; Yahoo rewriting the exchange's bar is not.
  for (const bar of todayBars) {
    try {
      const current = await prisma.dailyPrice.findUnique({
        where: { instrumentId_date: { instrumentId, date: bar._date } },
        select: { id: true, source: true },
      });

      if (current && !mayWritePriceSource(current.source, "YAHOO")) {
        // A higher-authority row already owns today. Leave it alone; this is a
        // no-op, not a failure.
        continue;
      }

      if (current) {
        await prisma.dailyPrice.update({
          where: { id: current.id },
          data: {
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            adjClose: bar.adjClose,
            source: "YAHOO",
          },
        });
      } else {
        await prisma.dailyPrice.create({
          data: {
            instrumentId,
            date: bar._date,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            adjClose: bar.adjClose,
            source: "YAHOO",
          },
        });
      }
      upserted++;
    } catch (error) {
      console.error(
        `[yahoo-price-service] upsert failed for ${instrumentId} (today):`,
        error,
      );
      failed++;
    }
  }

  if (failedIntegrity > 0) {
    console.warn(
      `[yahoo-price-service] dropped ${failedIntegrity} unrepairable bar(s) for ${instrumentId}`,
    );
  }

  return { upserted, failed: failed + failedIntegrity };
}
