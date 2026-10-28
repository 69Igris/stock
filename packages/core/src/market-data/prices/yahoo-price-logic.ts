/**
 * Yahoo Price Service — Pure Logic
 *
 * Pure, side-effect-free helpers used by `yahoo-price-service.ts` for date
 * normalisation, gap detection and DB-record → HistoricalBar conversion.
 * Extracted so the exact code production runs can be unit-tested without a DB.
 *
 * `yahoo-price-service.ts` imports and calls these — no parallel copies.
 *
 * MONEY-1382 added the serving half of the daily series: which rows carry a
 * vendor's restated basis (`toHistoricalBar`), when Yahoo may gap-fill
 * (`yahooFillRange`), adjusting a mixed series exactly once
 * (`adjustBarsForBasis`), weekly/monthly buckets (`resampleDailyBars`) and
 * today's forming candle (`liveSessionBar`).
 */

import {
  applyAdjustment,
  type AdjustmentStep,
  type RawBar,
} from "../price-adjust";
import { widenCandleRange } from "../candle-integrity";
import { getNseMarketStatus } from "../market-hours";
import { toIstDateKey } from "../nse-holidays";

export type { AdjustmentStep };

export interface HistoricalBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number;
  /** `DailyPrice.source`, carried so a reader can tell a raw print from a restated one. */
  source?: string;
  /**
   * Set ONLY on a vendor row (MONEY-1382). Yahoo restates its whole history for
   * every split and bonus it knows about at the moment it SERVES the data, so a
   * Yahoo row already reflects every corporate action with an ex-date on or
   * before this instant — the moment we fetched it (`DailyPrice.createdAt`).
   * An exchange row is a raw print and carries no such field.
   */
  adjustedThrough?: Date;
}

export interface DailyPriceRecord {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose: number | null;
  source?: string | null;
  createdAt?: Date | null;
}

/** The exchange's own print, raw. BHAVCOPY_HIST is the same file replayed. */
export const EXCHANGE_PRICE_SOURCES: ReadonlySet<string> = new Set([
  "BHAVCOPY",
  "BHAVCOPY_HIST",
]);

/** The one `daily_prices` source whose closes arrive restated (MONEY-1175 measured it). */
export const VENDOR_RESTATED_SOURCE = "YAHOO";

/** Maximum allowed gap (in days) between consecutive price points / boundaries. */
export const MAX_PRICE_GAP_DAYS = 5;

/** Normalize a date to UTC midnight (returns a new Date; does not mutate input). */
export function normalizeDate(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Whole-day distance between two dates (absolute). */
function daysDiff(d1: Date, d2: Date): number {
  return Math.abs(d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Check for significant gaps in a sorted price series across [start, end].
 * Returns true when the series is empty, the first/last point is more than
 * MAX_PRICE_GAP_DAYS from the requested boundary, or two consecutive points
 * are more than MAX_PRICE_GAP_DAYS apart.
 */
export function hasGaps(
  prices: Array<{ date: Date }>,
  start: Date,
  end: Date,
): boolean {
  if (prices.length === 0) return true;

  const first = prices[0];
  const last = prices[prices.length - 1];
  if (!first || !last) return true;

  // Missing the start or end of the requested range
  if (daysDiff(first.date, start) > MAX_PRICE_GAP_DAYS) return true;
  if (daysDiff(last.date, end) > MAX_PRICE_GAP_DAYS) return true;

  // Internal gaps between consecutive entries
  for (let i = 1; i < prices.length; i++) {
    const current = prices[i];
    const previous = prices[i - 1];
    if (!current || !previous) continue;
    if (daysDiff(current.date, previous.date) > MAX_PRICE_GAP_DAYS) {
      return true;
    }
  }

  return false;
}

/**
 * The part of [start, end] `getHistoricalPrices` may ask Yahoo to fill, or
 * null for none. `rows` must be date-ascending. MONEY-1382.
 *
 * NEVER INSIDE THE SPAN THE EXCHANGE COVERS. Yahoo cannot add a session the
 * exchange did not print, so over a suspension the fetch found nothing to
 * write and fired again on the next cache miss, forever. What it did write was
 * worse: Yahoo bars on dates the exchange never traded (RELIANCE holds 112 of
 * them, on holidays from 1996 on), on Yahoo's basis rather than ours.
 *
 * BEFORE the first exchange print Yahoo is all there is — an instrument added
 * after the BHAVCOPY_HIST backfill, or history that only ever lived in Yahoo —
 * so that span is still filled. The range is [start, first print): `end` is
 * Yahoo's period2, a timestamp, and it stamps an NSE session at 09:15 IST, so
 * the first print's own session lies after it. Yahoo-only instruments keep the
 * whole-window fill.
 *
 * Not AFTER the last print: the next bhavcopy would land beyond any Yahoo
 * holiday bar written there and leave it inside coverage, and at a delisting
 * the fetch finds nothing, forever.
 *
 * ponytail: an instrument that LISTED inside the window has nothing before its
 * first print, so this fetches an empty range on every cache miss — what
 * `hasGaps` did for every window before MONEY-1382. InstrumentMapping holds no
 * listing date to stop it; add one if that cost ever shows.
 */
export function yahooFillRange(
  rows: Array<{ date: Date; source?: string | null }>,
  start: Date,
  end: Date,
): { start: Date; end: Date } | null {
  const i = rows.findIndex(
    (r) => r.source != null && EXCHANGE_PRICE_SOURCES.has(r.source),
  );
  if (i === -1) return hasGaps(rows, start, end) ? { start, end } : null;
  const firstPrint = rows[i]!.date;
  return hasGaps(rows.slice(0, i + 1), start, firstPrint)
    ? { start, end: firstPrint }
    : null;
}

/** Convert a DailyPrice DB record into a HistoricalBar (null adjClose → undefined). */
export function toHistoricalBar(record: DailyPriceRecord): HistoricalBar {
  return {
    date: record.date,
    open: record.open,
    high: record.high,
    low: record.low,
    close: record.close,
    volume: record.volume,
    adjClose: record.adjClose ?? undefined,
    ...(record.source ? { source: record.source } : {}),
    ...(record.source === VENDOR_RESTATED_SOURCE && record.createdAt
      ? { adjustedThrough: record.createdAt }
      : {}),
  };
}

/**
 * Back-adjust a mixed-provenance daily series, applying each action ONCE.
 * MONEY-1382.
 *
 * `applyAdjustment` divides a bar by every action AFTER the bar's date — right
 * for a raw exchange print, wrong for a Yahoo row Yahoo had already divided by
 * every action up to the moment we fetched it. So a vendor row is looked up at
 * `max(date, adjustedThrough)`: only the actions Yahoo could not yet have
 * applied are applied here.
 *
 * NOT "skip vendor rows". Measured on prod 2026-09-23 against the nearest
 * exchange print: of 329 Yahoo rows the old route adjusted, 185 were written
 * the day after their session and BEFORE a later split, so they were raw with
 * respect to it and a blanket skip would have broken every one. Only the fetch
 * instant says which basis a row is on.
 */
export function adjustBarsForBasis<
  T extends RawBar & { adjustedThrough?: Date },
>(bars: readonly T[], steps: readonly AdjustmentStep[]): readonly T[] {
  if (steps.length === 0) return bars;
  return bars.map((bar) => {
    const asOf = bar.adjustedThrough;
    if (!asOf || asOf.getTime() <= bar.date.getTime()) {
      return applyAdjustment([bar], steps)[0]!;
    }
    const [restated] = applyAdjustment([{ ...bar, date: asOf }], steps);
    return { ...restated!, date: bar.date };
  });
}

// ── Weekly / monthly (MONEY-1382 C2; moved from research's fetch-price-history) ──

export type ResampleInterval = "1wk" | "1mo";

const DAY_MS = 86_400_000;

/** ISO-8601 week key (the week's Thursday determines its year). */
function isoWeekKey(d: Date): string {
  const t = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = t.getUTCDay() || 7; // Mon=1 … Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // move to the week's Thursday
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Calendar-month key (UTC). */
function calendarMonthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Resample DAILY bars into ISO-week / calendar-month buckets: open = first,
 * close = last, high = max, low = min, volume = sum, date = the bucket's FIRST
 * session — TradingView keys a weekly bar on the session the week opened, and
 * so does Yahoo's own 1wk series. Input must be date-ascending. Any other
 * interval passes through unchanged.
 *
 * Adjust BEFORE calling this: a bucket straddling an ex-date holds sessions on
 * two bases, and only the daily bars know which side each one is on.
 */
export function resampleDailyBars<
  T extends {
    date: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  },
>(bars: readonly T[], interval: string): T[] {
  if (interval !== "1wk" && interval !== "1mo") return bars.slice();
  const keyOf = interval === "1wk" ? isoWeekKey : calendarMonthKey;
  const out: T[] = [];
  let currentKey: string | null = null;
  let bucket: T | null = null;
  for (const b of bars) {
    const key = keyOf(b.date);
    if (bucket === null || key !== currentKey) {
      if (bucket) out.push(bucket);
      currentKey = key;
      bucket = { ...b };
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low = Math.min(bucket.low, b.low);
      bucket.close = b.close;
      bucket.volume += b.volume;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

/**
 * Widen [from, to] to whole buckets, so no bucket at either edge of a request
 * is built from a partial week or month. The caller keeps only the buckets
 * whose first session falls inside the ORIGINAL window, so each bucket is
 * served once, complete, by the request that holds its first session.
 */
export function resampleFetchWindow(
  from: Date,
  to: Date,
  interval: ResampleInterval,
): { start: Date; end: Date } {
  const y = (d: Date) => d.getUTCFullYear();
  const m = (d: Date) => d.getUTCMonth();
  const day = (d: Date) => d.getUTCDate();
  if (interval === "1wk") {
    const sinceMonday = (from.getUTCDay() + 6) % 7;
    const untilSunday = (7 - to.getUTCDay()) % 7;
    return {
      start: new Date(Date.UTC(y(from), m(from), day(from) - sinceMonday)),
      end: new Date(Date.UTC(y(to), m(to), day(to) + untilSunday + 1) - 1),
    };
  }
  return {
    start: new Date(Date.UTC(y(from), m(from), 1)),
    end: new Date(Date.UTC(y(to), m(to) + 1, 1) - 1),
  };
}

// ── Today's forming session (MONEY-1382 C4) ──

/** Today's IST trading date at UTC midnight — how `daily_prices` stamps a session. */
export function istSessionDate(now: Date): Date {
  return new Date(`${toIstDateKey(now)}T00:00:00.000Z`);
}

/** The quote fields a live bar is built from (`QuoteData` satisfies it). */
export interface LiveQuote {
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  /** When the NUMBER is from (Yahoo's regularMarketTime), not when it was read. */
  timestamp: Date;
}

/** 09:15 IST is 03:45 UTC. */
const SESSION_OPEN_UTC_MS = (3 * 60 + 45) * 60_000;

/**
 * Today's candle from a quote, or null. MONEY-1382 C4.
 *
 * Bhavcopy lands at 21:00 IST, so no `daily_prices` row exists for the session
 * in progress. Only while the NSE session is LIVE, and only from a quote whose
 * own timestamp falls in THIS session: `latest_quotes` is refreshed nightly at
 * 23:00, so a symbol nobody quoted today still holds last night's row, and
 * stamping that as today's candle would print yesterday's session twice.
 *
 * The bar is a RAW print dated today; the caller must adjust it WITH the rest
 * of the series, or a forthcoming ex-date divides every bar but this one.
 */
export function liveSessionBar(
  quote: LiveQuote | null,
  now: Date,
): HistoricalBar | null {
  if (!quote || !getNseMarketStatus(now).isLive) return null;
  const session = istSessionDate(now);
  if (
    !(quote.timestamp instanceof Date) ||
    !(quote.timestamp.getTime() >= session.getTime() + SESSION_OPEN_UTC_MS)
  ) {
    return null;
  }
  const candle = widenCandleRange({
    open: quote.open,
    high: quote.high,
    low: quote.low,
    close: quote.price,
  });
  if (!candle) return null;
  return {
    date: session,
    ...candle,
    volume:
      Number.isFinite(quote.volume) && quote.volume > 0
        ? Math.round(quote.volume)
        : 0,
    source: "LIVE",
  };
}
