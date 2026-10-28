/**
 * Fetch Price History — DB-first (DailyPrice), live Yahoo fallback (MONEY-1060).
 *
 * RC1: the tool used to fetch ONLY from live Yahoo (`yahooFetchChart` via
 * `withExchangeFallback`). When a worker can't reach Yahoo the empty result
 * (`success:true, data:[], count:0`) cascaded into the ~11 compute tools that
 * bind `fetch_price_history.prices[]`. The CHART never had this problem because
 * it reads the persisted `DailyPrice` collection DB-first
 * (apps/web/lib/market/yahoo-client.ts:172-220 → InstrumentMapping by
 * yahooSymbol → DailyPrice bars). This tool now mirrors that seam: read the DB
 * first, fall through to live Yahoo only on a DB miss.
 *
 * RC4: production `yahooFetchChart` NEVER throws (it swallows transport errors
 * and returns `[]`) and `withExchangeFallback` swallows thrown fetches too, so a
 * transient outage was indistinguishable from a genuine empty gap — both looked
 * like `success:true` with no bars. The live path now passes an `onError`
 * collector through BOTH seams (the yahoo-api swallow-points invoke it right
 * before returning empty) and, on an empty-because-outage result, returns
 * `success:false` + `metadata.sourceError` so the executor (which only binds a
 * dependency's result when `success===true`) and the synthesizer can tell a
 * transient outage from "no data exists".
 *
 * Fix 4 (coverage): a non-empty DB slice is only served as the FULL period when
 * it passes the chart seam's gap check (`hasGaps`, MAX_PRICE_GAP_DAYS=5 boundary
 * + hole detection). A gappy slice falls through to live; if live also comes up
 * empty, the partial DB bars are served but LABELLED
 * (`metadata.partial:true` + `coverage:{firstBar,lastBar}` [+ sourceError]) —
 * partial data beats none, but never silently as the full window.
 *
 * Fix 5 (1wk/1mo): `DailyPrice` stores daily bars, so weekly/monthly requests
 * (sector-deep-dive statically plans `interval:"1wk"`) previously ALWAYS went
 * live. The daily bars for the window are now read and resampled (ISO week /
 * calendar month buckets: open=first, close=last, high=max, low=min,
 * volume=sum, date=bucket's first session — MONEY-1382, via core's
 * `resampleDailyBars`) under the same coverage check, falling through to live
 * exactly as 1d does.
 */

import prisma from "@usemoney/database";
import {
  yahooFetchChart,
  withExchangeFallback,
} from "@usemoney/core/market-data";
import {
  hasGaps,
  resampleDailyBars,
} from "@usemoney/core/market-data/prices/yahoo-price-logic";
import type { ResearchToolDef, ToolOutput } from "./types";

/** OHLCV bar with a Date-typed date — shared by the DB read + live fetch seams. */
export interface RawPriceBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Live-fetch outcome: bars plus the thrown error (null on success / genuine gap). */
export interface LiveFetchResult {
  bars: RawPriceBar[];
  error: Error | null;
}

/**
 * Minimal structural shape of the prisma surface the DB-first read touches.
 * Args are `any` so the real (more-strongly-typed) prisma client stays
 * assignable — the same DI shim used by fetch-youtube-transcript's
 * `TranscriptPrismaClient`; tests inject a fake (no real DB), production passes
 * the real `prisma` default.
 */
export interface PriceHistoryPrismaClient {
  instrumentMapping: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: (args: any) => Promise<{ id: string } | null>;
  };
  dailyPrice: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<
      Array<{
        date: Date;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }>
    >;
  };
}

/**
 * Low-level Yahoo chart fetch — injectable for tests; defaults to yahooFetchChart.
 * The optional third param mirrors yahoo-api's `YahooFetchErrorOpts` (MONEY-1060
 * RC4): the REAL `fetchChart` swallows transport errors internally and returns
 * `[]`, so the `onError` collector is the ONLY way an outage surfaces here —
 * fakes in tests should mirror that shape (return empty + call onError) rather
 * than throw.
 */
type ChartFetcher = (
  symbol: string,
  opts: { period1: Date; period2: Date; interval: string },
  fetchOpts?: { onError?: (error: unknown, context?: string) => void },
) => Promise<RawPriceBar[]>;

/** Injectable seams for the tool's execute() — real defaults, faked in tests. */
export interface PriceHistoryDeps {
  readDb: (
    symbol: string,
    period1: Date,
    period2: Date,
  ) => Promise<RawPriceBar[]>;
  fetchLive: (
    symbol: string,
    period1: Date,
    period2: Date,
    interval: string,
  ) => Promise<LiveFetchResult>;
}

const PERIOD_MS: Record<string, number> = {
  "1m": 30 * 24 * 60 * 60 * 1000,
  "3m": 90 * 24 * 60 * 60 * 1000,
  "6m": 180 * 24 * 60 * 60 * 1000,
  "1y": 365 * 24 * 60 * 60 * 1000,
  "2y": 730 * 24 * 60 * 60 * 1000,
  "3y": 1095 * 24 * 60 * 60 * 1000, // MONEY-794 horizon
  "5y": 1825 * 24 * 60 * 60 * 1000,
};

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0] ?? "";
}

// `resampleDailyBars` moved to core (MONEY-1382) so the chart and this tool
// bucket weekly/monthly bars with ONE function. Its date is now the bucket's
// FIRST session — the same stamp Yahoo's own 1wk/1mo bars carry, so the DB
// path and the live fallback below finally agree.

/** Map a raw bar to the tool's wire shape (YYYY-MM-DD date), unchanged from RC0. */
function toOutBar(b: RawPriceBar): {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
} {
  return {
    date: isoDate(b.date),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  };
}

/**
 * DB-first read (RC1): resolve the instrument by `yahooSymbol` and return its
 * persisted `DailyPrice` bars in [period1, period2] — the exact seam the chart
 * uses. Returns `[]` on a MISS (no instrument / no rows / DB error) so the caller
 * falls through to the live Yahoo path. Never throws (a DB error is a miss, not a
 * hard failure — mirrors fetch-corporate-actions' DB-first guard).
 */
export async function readDbPriceBars(
  symbol: string,
  period1: Date,
  period2: Date,
  db: PriceHistoryPrismaClient = prisma,
): Promise<RawPriceBar[]> {
  try {
    const instrument = await db.instrumentMapping.findUnique({
      where: { yahooSymbol: symbol },
      select: { id: true },
    });
    if (!instrument) return [];

    const rows = await db.dailyPrice.findMany({
      where: {
        instrumentId: instrument.id,
        date: { gte: period1, lte: period2 },
      },
      orderBy: { date: "asc" },
    });

    return rows.map((r) => ({
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  } catch {
    return [];
  }
}

/**
 * Live Yahoo path (RC4): the pre-existing `withExchangeFallback` + `yahooFetchChart`
 * behaviour, but with the swallowed errors CAPTURED. Production `fetchChart`
 * swallows internally (returns `[]`, never throws) and `withExchangeFallback`
 * swallows thrown fetches (returns null), so an outage previously looked like an
 * empty success. Both seams now take an `onError` observer (yahoo-api,
 * MONEY-1060) — we thread one collector through the chart fetch AND the
 * exchange-fallback wrapper (plus a local try/catch for throwing injected
 * fakes) and surface the capture via `LiveFetchResult.error`. The error is
 * only meaningful when NO bars came back: if the alternate exchange succeeded,
 * `bars.length > 0` and the earlier capture is ignored (we got data).
 */
export async function fetchLivePriceBars(
  symbol: string,
  period1: Date,
  period2: Date,
  interval: string,
  chartFetch: ChartFetcher = yahooFetchChart,
): Promise<LiveFetchResult> {
  let lastError: Error | null = null;
  const capture = (e: unknown): void => {
    lastError = e instanceof Error ? e : new Error(String(e));
  };

  const bars =
    (await withExchangeFallback(
      symbol,
      async (s) => {
        try {
          const result = await chartFetch(
            s,
            { period1, period2, interval },
            { onError: capture },
          );
          return result.length > 0 ? result : null;
        } catch (e) {
          capture(e);
          throw e; // rethrow so withExchangeFallback tries the alternate exchange
        }
      },
      { onError: capture },
    )) ?? [];

  return {
    bars: bars.map((b) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    })),
    error: bars.length === 0 ? lastError : null,
  };
}

const DEFAULT_DEPS: PriceHistoryDeps = {
  readDb: (symbol, period1, period2) =>
    readDbPriceBars(symbol, period1, period2),
  fetchLive: (symbol, period1, period2, interval) =>
    fetchLivePriceBars(symbol, period1, period2, interval),
};

/**
 * Serve DB bars for the requested interval: 1d directly, 1wk/1mo resampled from
 * the daily bars (fix 5).
 */
function serveDbBars(bars: RawPriceBar[], interval: string): RawPriceBar[] {
  return interval === "1d" ? bars : resampleDailyBars(bars, interval);
}

/**
 * Core resolve — DB-first (coverage-checked), then live Yahoo, then labelled
 * partial-DB, with RC4 honest errors. Exported so the seams (DB read / live
 * fetch) can be injected in tests without a real DB or network. `execute`
 * delegates here with the real defaults.
 *
 * Output contract is UNCHANGED for downstream input-bindings: `data` is the bars
 * array (`{ date, open, high, low, close, volume }[]`), `metadata.count` is the
 * bar count, and a result is only bound downstream when `success === true`
 * (executor.ts:189-191). `metadata.source` / `metadata.sourceError` /
 * `metadata.partial` / `metadata.coverage` are additive.
 */
export async function resolvePriceHistory(
  params: Record<string, unknown>,
  deps: PriceHistoryDeps = DEFAULT_DEPS,
): Promise<ToolOutput> {
  const symbol = params.symbol as string;
  const period = (params.period as string) || "1y";
  const interval = (params.interval as string) || "1d";
  if (!symbol) return { success: false, error: "symbol is required" };

  const now = new Date();
  const ms = PERIOD_MS[period] || PERIOD_MS["1y"]!;
  const period1 = new Date(now.getTime() - ms);

  // 1. DB-first (RC1, extended by fixes 4+5). `DailyPrice` stores DAILY bars:
  //    1d serves them directly; 1wk/1mo resample them (sector-deep-dive
  //    statically plans 1wk, which previously ALWAYS bypassed the DB). Unknown
  //    intervals go straight to live. Fix 4: a non-empty slice is only served
  //    as the FULL period when it passes the chart-seam coverage check
  //    (hasGaps: 5-day boundary + hole detection); a gappy slice is kept as a
  //    PARTIAL candidate served (labelled) only if live also fails.
  const dbEligible =
    interval === "1d" || interval === "1wk" || interval === "1mo";
  let dbBars: RawPriceBar[] = [];
  if (dbEligible) {
    try {
      dbBars = await deps.readDb(symbol, period1, now);
    } catch {
      dbBars = []; // DB read failure must not block the live fallback.
    }
    if (dbBars.length > 0 && !hasGaps(dbBars, period1, now)) {
      const served = serveDbBars(dbBars, interval);
      return {
        success: true,
        data: served.map(toOutBar),
        metadata: { count: served.length, period, interval, source: "db" },
      };
    }
  }

  // 2. Live Yahoo fallback (unchanged data path) with RC4 honest errors.
  try {
    const { bars, error } = await deps.fetchLive(
      symbol,
      period1,
      now,
      interval,
    );

    if (bars.length > 0) {
      return {
        success: true,
        data: bars.map(toOutBar),
        metadata: { count: bars.length, period, interval, source: "yahoo" },
      };
    }

    // 3. Live empty. Fix 4: partial DB coverage beats nothing — serve the
    //    gappy slice but LABEL it (partial:true + coverage bounds), carrying
    //    the live sourceError when the emptiness was an outage.
    if (dbBars.length > 0) {
      const served = serveDbBars(dbBars, interval);
      return {
        success: true,
        data: served.map(toOutBar),
        metadata: {
          count: served.length,
          period,
          interval,
          source: "db",
          partial: true,
          coverage: {
            firstBar: isoDate(dbBars[0]!.date),
            lastBar: isoDate(dbBars[dbBars.length - 1]!.date),
          },
          ...(error ? { sourceError: error.message } : {}),
        },
      };
    }

    // 4. Nothing anywhere — RC4/fix-3 semantics. An outage (captured error)
    //    that produced NO bars is NOT a genuine gap — report it so the
    //    executor/synthesizer don't treat a transient failure as "no data
    //    exists". A real empty response (error === null) stays an honest quiet
    //    success with empty data (the pre-PR behavior for e.g. brand-new
    //    listings and unfetchable symbols).
    if (error) {
      return {
        success: false,
        error: `Failed to fetch price history: ${error.message}`,
        metadata: {
          period,
          interval,
          source: "yahoo",
          sourceError: error.message,
        },
      };
    }

    return {
      success: true,
      data: [],
      metadata: { count: 0, period, interval, source: "yahoo" },
    };
  } catch (error) {
    // Defensive: the injected fetchLive contract is never-throw, but keep the
    // same partial-beats-none + honest-error semantics if one does.
    const message = error instanceof Error ? error.message : String(error);
    if (dbBars.length > 0) {
      const served = serveDbBars(dbBars, interval);
      return {
        success: true,
        data: served.map(toOutBar),
        metadata: {
          count: served.length,
          period,
          interval,
          source: "db",
          partial: true,
          coverage: {
            firstBar: isoDate(dbBars[0]!.date),
            lastBar: isoDate(dbBars[dbBars.length - 1]!.date),
          },
          sourceError: message,
        },
      };
    }
    return {
      success: false,
      error: `Failed to fetch price history: ${message}`,
      metadata: {
        period,
        interval,
        sourceError: message,
      },
    };
  }
}

export const fetchPriceHistoryTool: ResearchToolDef = {
  name: "fetch_price_history",
  description: "Fetch historical OHLCV price data for charting and analysis",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Yahoo Finance symbol",
      required: true,
    },
    period: {
      type: "string",
      description: "Period: 1m, 3m, 6m, 1y, 2y, 5y",
      default: "1y",
    },
    interval: {
      type: "string",
      description: "Interval: 1d, 1wk, 1mo",
      default: "1d",
    },
  },
  cacheTTL: 3600, // 1h
  execute: (params): Promise<ToolOutput> => resolvePriceHistory(params),
};
