/**
 * TradingView UDF - History endpoint
 *
 * GET /api/market/udf/history?symbol=NSE:TCS&from=1700000000&to=1730000000&resolution=1D&countback=300
 *
 * Returns OHLCV bars for a symbol over a time range, in TradingView's UDF
 * response shape.
 *
 * Critical rules (easy to get wrong):
 * - `t[]` is unix **seconds** (not milliseconds). Convert via Math.floor(d.getTime()/1000).
 * - `s:"no_data"` MUST include `nextTime` (in seconds) pointing to an older bar
 *   that does have data, otherwise the chart loops forever requesting older
 *   bars and the user sees an infinite spinner.
 * - Honor `countback` if newer TV versions send it: slice the tail N bars
 *   regardless of from/to.
 * - On unrecoverable error return `{s:"error", errmsg:"..."}` - never throw.
 *
 * For mutual funds (`MF:<schemeCode>`), the underlying NAV time series has no
 * OHLCV - we synthesize `o=h=l=c=nav` and `v=0`. The TV widget then renders a
 * line via `visible_plots_set:"c"` set on the symbol resolution side.
 *
 * Spec: https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#bars
 */

import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { apiLogger as logger } from "@usemoney/logger";
import { isDemoSession } from "@/lib/demo/session";
import { isDemoChartSymbol } from "@/lib/demo/data";
import {
  fetchHistoricalBars,
  HistoricalFetchError,
  type HistoricalBar,
} from "@/lib/market/historical-fetcher";
import { type Exchange } from "@/lib/market/symbol-mapper";
import {
  getMfNavHistory,
  getIntradayBars,
  INTRADAY_INTERVALS,
  type IntradayInterval,
} from "@usemoney/core/market-data";
import { prisma } from "@usemoney/database";
import {
  getCachedUdfHistory,
  setCachedUdfHistory,
} from "@/lib/market/udf-history-cache";
import { getBrokerMarketDataStatus } from "@/lib/actions/broker-status";
import {
  getSymbolAdjustment,
  EMPTY_ADJUSTMENT,
  type SymbolAdjustment,
} from "@/lib/market/corporate-action-adjust";
import { applyAdjustment } from "@usemoney/core/market-data";
import { getNseMarketStatus } from "@usemoney/core/market-data/market-hours";
import {
  istSessionDate,
  liveSessionBar,
  resampleFetchWindow,
} from "@usemoney/core/market-data/prices/yahoo-price-logic";
import { getQuoteByInstrumentId } from "@/lib/market/yahoo-client";
import {
  tvResolutionToInterval,
  pickPeriodForRange,
  barsToUdfOk,
  parseSymbolPrefix,
  shouldReadSharedCache,
  shouldWriteSharedCache,
  type UdfHistoryOk,
  loadHistoryPreconditions,
  isDailyPlusInterval,
  composeDailyPlusBars,
} from "./route-logic";

export const dynamic = "force-dynamic";

// ============== EARLIEST-BAR CACHE ==============
// In-process cache for the earliest available bar per (symbol, exchange,
// interval). Used to short-circuit no_data responses for pre-listing history
// requests. Without this, every backward scroll past the listing date triggers
// an expensive `period=max` probe against Yahoo (11+ seconds each).
//
// Sentinel values:
//   null                       - never probed, will probe on next no_data
//   Number.MAX_SAFE_INTEGER    - probed and confirmed no data available at all
//
// TTL: 1 hour. Stocks rarely change listing availability that quickly.
const EARLIEST_BAR_TTL_MS = 60 * 60 * 1000;
interface EarliestBarEntry {
  earliestSec: number;
  cachedAt: number;
}
const earliestBarCache = new Map<string, EarliestBarEntry>();

function earliestBarCacheKey(
  symbol: string,
  exchange: string,
  interval: string
): string {
  return `${symbol.toUpperCase()}::${exchange.toUpperCase()}::${interval}`;
}

function getCachedEarliestBar(key: string): number | null {
  const entry = earliestBarCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > EARLIEST_BAR_TTL_MS) {
    earliestBarCache.delete(key);
    return null;
  }
  return entry.earliestSec;
}

function setCachedEarliestBar(key: string, earliestSec: number): void {
  earliestBarCache.set(key, { earliestSec, cachedAt: Date.now() });
  // Simple eviction - keep the cache bounded
  if (earliestBarCache.size > 5000) {
    const oldestKey = earliestBarCache.keys().next().value;
    if (oldestKey !== undefined) earliestBarCache.delete(oldestKey);
  }
}

// ============== UDF RESPONSE BUILDERS ==============
//
// The pure helpers — tvResolutionToInterval, pickPeriodForRange, barsToUdfOk,
// parseSymbolPrefix, and the shared-cache READ/WRITE gates — live in
// ./route-logic so they're imported (and asserted) from one place. See that
// module's header for the MONEY-566 Zerodha-compliance rationale.

interface UdfHistoryNoData {
  s: "no_data";
  nextTime?: number;
}

interface UdfHistoryError {
  s: "error";
  errmsg: string;
}

type UdfHistoryResponse = UdfHistoryOk | UdfHistoryNoData | UdfHistoryError;

/**
 * The quote today's candle is built from (MONEY-1382 C4). `getQuoteByInstrumentId`
 * refreshes `latest_quotes` from Yahoo past a 60 s TTL: measured on prod
 * mid-session, 0 of 9,686 rows had been written in the last 10 minutes, so the
 * bare row is last night's close. Never throws — a missing quote only means no
 * candle for today.
 */
async function loadLiveQuote(symbol: string, exchange: string) {
  try {
    const instrument = await prisma.instrumentMapping.findUnique({
      where: {
        symbol_exchange: {
          symbol: symbol.toUpperCase(),
          exchange: exchange.toUpperCase(),
        },
      },
      select: { id: true },
    });
    return instrument ? await getQuoteByInstrumentId(instrument.id) : null;
  } catch (err) {
    logger.warn({ error: err }, "[udf/history] live quote failed");
    return null;
  }
}

// ============== HANDLER ==============

export async function GET(request: NextRequest) {
  // MONEY-278: demo sessions can read history for allow-listed symbols only.
  const { userId } = await auth();
  // The handler's own `auth()` result is threaded into every helper below that
  // would otherwise repeat it. Three evaluations per request became one.
  const demo = userId ? false : await isDemoSession(userId);
  if (!userId && !demo) {
    return NextResponse.json(
      {
        s: "error",
        errmsg: "authentication required",
      } satisfies UdfHistoryResponse,
      { status: 200 }
    );
  }

  try {
    const params = request.nextUrl.searchParams;
    const symbolParam = params.get("symbol");

    if (demo && symbolParam) {
      const colonIdx = symbolParam.indexOf(":");
      const rawSymbolForDemo =
        colonIdx === -1 ? symbolParam : symbolParam.slice(colonIdx + 1);
      if (!isDemoChartSymbol(rawSymbolForDemo)) {
        return NextResponse.json(
          { s: "no_data" } satisfies UdfHistoryResponse,
          { status: 200 }
        );
      }
    }
    const fromStr = params.get("from");
    const toStr = params.get("to");
    const resolution = params.get("resolution");
    const countbackStr = params.get("countback");

    if (!symbolParam || !fromStr || !toStr || !resolution) {
      return NextResponse.json(
        {
          s: "error",
          errmsg: "missing required params: symbol, from, to, resolution",
        } satisfies UdfHistoryResponse,
        { status: 200 }
      );
    }

    const fromSec = parseInt(fromStr, 10);
    const toSec = parseInt(toStr, 10);
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) {
      return NextResponse.json(
        {
          s: "error",
          errmsg: "from/to must be unix seconds",
        } satisfies UdfHistoryResponse,
        { status: 200 }
      );
    }
    const fromMs = fromSec * 1000;
    const toMs = toSec * 1000;
    const startDate = new Date(fromMs);
    const endDate = new Date(toMs);
    const countback = countbackStr ? parseInt(countbackStr, 10) : null;
    // MONEY-1176 — corporate-action adjustment. DEFAULT ON for daily+, which
    // is what every mainstream chart does; `adj=0` opts out to the raw
    // exchange series. DailyPrice always stores RAW (MONEY-1175) — adjustment
    // happens here at serve time and never mutates stored data.
    const wantsAdjusted = params.get("adj") !== "0";

    // ── Parse "EXCHANGE:SYMBOL" ──
    const { prefix, rawSymbol } = parseSymbolPrefix(symbolParam);

    // ── MONEY-122: Redis response cache ──
    //
    // Cache key: (exchange, symbol, TV-resolution, fromSec, toSec). We
    // intentionally use the raw TV resolution string (e.g. "1D", "5"),
    // not our internal normalized interval, so the key matches exactly
    // what the widget sent. Same bucket for all users.
    //
    // Countback requests bypass the cache on the READ side: TV sends
    // countback=2 polls every ~10 s with sliding from/to pairs, and
    // each poll is a brand-new key anyway, so caching them would just
    // fill Redis with one-hit entries. We still cache non-countback
    // responses which is where the bulk of duplicate requests come from
    // (backward scroll, chart remounts, React StrictMode, etc.).
    // Resolved BEFORE the cache read because the fingerprint is part of the
    // key: without it a freshly backfilled split would serve stale unadjusted
    // bars for the whole TTL, and adjacent windows cached either side of the
    // backfill would disagree with each other inside ONE chart.
    // Intraday and MF are excluded — neither has the deep history where a
    // split matters, and the MF branch synthesises bars from NAV.
    const interval0 = tvResolutionToInterval(resolution);
    const adjustable =
      wantsAdjusted &&
      prefix !== "MF" &&
      interval0 !== null &&
      !(INTRADAY_INTERVALS as readonly string[]).includes(interval0);
    // MONEY-1382 C4 — a daily/weekly/monthly window that reaches today's
    // session WHILE IT TRADES carries a candle rebuilt from a quote on every
    // request, so it must not be served from, or written to, the shared cache.
    const now = new Date();
    const liveSession =
      (prefix === "NSE" || prefix === "BSE") &&
      interval0 !== null &&
      isDailyPlusInterval(interval0) &&
      toMs >= istSessionDate(now).getTime() &&
      getNseMarketStatus(now).isLive;

    // CONCURRENT with the broker-status read below — see
    // `loadHistoryPreconditions`. Neither reads the other's result and both
    // gate the cache lookup, so awaiting them in sequence put two round trips
    // in front of every request.
    const [adjustment, marketStatus] = await loadHistoryPreconditions(
      async (): Promise<SymbolAdjustment> => {
        if (!adjustable) return EMPTY_ADJUSTMENT;
        try {
          return await getSymbolAdjustment(rawSymbol, prefix);
        } catch (err) {
          // Adjustment is an enhancement; a lookup failure must serve raw bars,
          // not an error. The fingerprint stays "none" so the raw payload is
          // cached under its own key rather than poisoning the adjusted slot.
          logger.warn({ error: err }, "[udf/history] adjustment lookup failed");
          return EMPTY_ADJUSTMENT;
        }
      },
      () => getBrokerMarketDataStatus(userId)
    );
    const isAdjusted = adjustment.steps.length > 0;

    const cacheInput = {
      exchange: prefix,
      symbol: rawSymbol,
      interval: resolution,
      fromSec,
      toSec,
      adjusted: isAdjusted,
      actionsFingerprint: adjustment.fingerprint,
    };

    // ── MONEY-566: shared-cache participation gate (Zerodha compliance) ──
    //
    // The UDF history Redis cache is user-agnostic — one bucket per
    // (symbol, interval, window), shared across every user. Per the
    // Zerodha market-data commitment, Zerodha-sourced bars must NEVER be
    // served to a different user. We enforce that STRUCTURALLY rather than
    // by post-hoc filtering: only requesters WITHOUT an active broker
    // connection participate in the shared cache. Those requests carry no
    // Zerodha credentials, so `fetchHistoricalBars` can only ever return
    // Yahoo (public) bars — which makes the shared cache provably
    // Yahoo-only. Active-broker users bypass the shared cache entirely
    // (read AND write) and always fetch fresh under their own access
    // token. `respond()` re-checks the fetch `source` as defense in depth.
    const brokerStatus = marketStatus.status;

    if (shouldReadSharedCache({ countback, brokerStatus, liveSession })) {
      const cached = await getCachedUdfHistory<UdfHistoryResponse>(cacheInput);
      if (cached) {
        return NextResponse.json(cached, { status: 200 });
      }
    }

    // Helper: build the NextResponse AND (conditionally) populate the
    // shared cache via `shouldWriteSharedCache` (see ./route-logic). A payload
    // is written only when ALL of these hold:
    //   - it isn't an error payload (errors are never cached)
    //   - countback === null (countback polls are one-hit keys, never cached)
    //   - the requester has no active broker (non-active brokerStatus)
    //   - the fetch `source` is not "zerodha" (defense in depth: a Zerodha
    //     bar must never enter the user-agnostic cache). "yahoo" /
    //     "intraday-db" (Yahoo ingest) / undefined (MF NAV from AMFI, or
    //     no_data) are all public and cacheable.
    const respond = async (
      payload: UdfHistoryResponse,
      source?: string
    ): Promise<NextResponse<UdfHistoryResponse>> => {
      if (
        shouldWriteSharedCache({
          payloadKind: payload.s,
          countback,
          brokerStatus,
          source,
          liveSession,
        })
      ) {
        await setCachedUdfHistory(cacheInput, payload, {
          negative: payload.s === "no_data",
        });
      }
      return NextResponse.json(payload, { status: 200 });
    };

    // ── MF branch - synthesize OHLC from NAV ──
    if (prefix === "MF") {
      const navPoints = await getMfNavHistory(rawSymbol, startDate, endDate);
      if (navPoints.length === 0) {
        // Probe earlier to give TV a hint about where data starts.
        const earlier = await getMfNavHistory(rawSymbol);
        if (earlier.length === 0) {
          return respond({ s: "no_data" });
        }
        const earliest = earlier[0]!;
        const earliestSec = Math.floor(
          new Date(earliest.date).getTime() / 1000
        );
        return respond({ s: "no_data", nextTime: earliestSec });
      }

      // NavPoint.date is "YYYY-MM-DD" string and NavPoint.nav is number
      const synthesizedBars: HistoricalBar[] = navPoints
        .map((p) => ({
          date: new Date(`${p.date}T00:00:00.000Z`),
          open: p.nav,
          high: p.nav,
          low: p.nav,
          close: p.nav,
          volume: 0,
        }))
        // Sort ascending by date - getMfNavHistory may return newest-first
        .sort((a, b) => a.date.getTime() - b.date.getTime());

      return respond(barsToUdfOk(synthesizedBars, countback));
    }

    // ── Equity / ETF / Index branch ──
    if (prefix !== "NSE" && prefix !== "BSE") {
      return NextResponse.json(
        {
          s: "error",
          errmsg: `unsupported exchange prefix: ${prefix}`,
        } satisfies UdfHistoryResponse,
        { status: 200 }
      );
    }
    const exchange = prefix as Exchange;

    const interval = tvResolutionToInterval(resolution);
    if (!interval) {
      return NextResponse.json(
        {
          s: "error",
          errmsg: `unsupported resolution: ${resolution}`,
        } satisfies UdfHistoryResponse,
        { status: 200 }
      );
    }

    const period = pickPeriodForRange(fromMs, toMs);

    // ── MONEY-1382: 1D/1W/1M are all served from the DAILY series ──
    //
    // Weekly and monthly used to go to Yahoo direct and were then divided by
    // every split a second time. They are now built from daily bars, fetched
    // over whole buckets so no edge week is built from a partial one; today's
    // candle is read from a quote concurrently with the bars.
    const dailyPlus = isDailyPlusInterval(interval);
    const fetchInterval = dailyPlus ? "1d" : interval;
    const fetchWindow =
      dailyPlus && interval !== "1d"
        ? resampleFetchWindow(startDate, endDate, interval)
        : { start: startDate, end: endDate };
    const liveQuote = liveSession
      ? loadLiveQuote(rawSymbol, exchange)
      : Promise.resolve(null);

    // ── MONEY-123 Part A: IntradayBar DB read-first for intraday ──
    //
    // For intraday intervals (1m/5m/15m/30m/60m), try the IntradayBar
    // collection first. The `intraday-sync` worker populates it daily
    // post-market, so for tracked symbols the DB has up to 90 rolling
    // days of bars - far beyond what the live upstream APIs can serve
    // in a single response (~3 trading days cap on both Zerodha and
    // Yahoo's intraday endpoints).
    //
    // Fall-through policy:
    //   - If the DB returns ≥1 bar in the requested window → use it
    //   - If the DB returns 0 bars → fall through to the live fetcher
    //     (the symbol hasn't been ingested yet, or the requested range
    //     is outside our 90-day rolling buffer)
    //
    // We don't try to detect "partial coverage" (some bars in DB, some
    // missing) and merge - that path is complex and the upstream live
    // fetch would re-fetch most of what we have anyway. The worker's
    // daily 5-day overlap window (lookbackDays=5) keeps the DB
    // continuously current, so partial coverage is rare in practice.
    let result: { data: HistoricalBar[]; source?: string } | null = null;

    if ((INTRADAY_INTERVALS as readonly string[]).includes(interval)) {
      try {
        const instrument = await prisma.instrumentMapping.findUnique({
          where: {
            symbol_exchange: {
              symbol: rawSymbol.toUpperCase(),
              exchange: exchange.toUpperCase(),
            },
          },
          select: { id: true },
        });
        if (instrument) {
          const dbBars = await getIntradayBars(
            instrument.id,
            interval as IntradayInterval,
            startDate,
            endDate
          );
          if (dbBars.length > 0) {
            logger.info(
              { rawSymbol, exchange, interval, bars: dbBars.length },
              "[udf/history] IntradayBar hit"
            );
            result = { data: dbBars, source: "intraday-db" };
          }
        }
      } catch (dbErr) {
        // Don't fail the request on a DB cache miss - log and fall
        // through to the live fetch. The point of the DB cache is to
        // optimize the happy path, not to be a hard dependency.
        logger.warn(
          { error: dbErr },
          "[udf/history] IntradayBar read failed, falling through to live fetch"
        );
      }
    }

    if (!result) {
      try {
        result = await fetchHistoricalBars({
          symbol: rawSymbol,
          exchange,
          interval: fetchInterval,
          period,
          startDate: fetchWindow.start,
          endDate: fetchWindow.end,
        });
      } catch (err) {
        if (err instanceof HistoricalFetchError) {
          // MONEY-594 (A09): never echo the raw fetcher message to the client
          // (sibling of the market/historical route sanitized in MONEY-595).
          // Log the real error server-side and return a generic errmsg while
          // keeping the UDF { s:"error", errmsg } response shape.
          logger.error({ error: err }, "[udf/history] historical fetch error");
          return NextResponse.json(
            {
              s: "error",
              errmsg: "Failed to load history",
            } satisfies UdfHistoryResponse,
            { status: 200 }
          );
        }
        throw err;
      }
    }

    // ── Filter bars to the requested [fromSec, toSec] range ──
    // Some upstream fetchers (especially Yahoo's intraday API) ignore the
    // requested date range and return "the last N days" regardless. For
    // intraday resolutions, calling getIntradayChart for a 2023 range
    // returns 225 bars from the LAST 5 days of 2026. Without this filter,
    // the widget receives timestamps outside its requested window, keeps
    // storing them in its cache, and interprets "bars returned" as "more
    // history exists backwards" - infinite backward-scroll loop. This is
    // also a UDF protocol violation: the server must return ONLY bars
    // within the requested range.
    //
    // Note: for daily data the fetcher respects the range natively, so the
    // filter is a no-op. For intraday it clips the response to the widget's
    // visible window and lets the no_data branch handle stale-history
    // requests correctly.
    //
    // Daily/weekly/monthly run the same range rule inside
    // `composeDailyPlusBars`, AFTER today's candle is joined — so the candle
    // is never served to a backward-scroll window it is not in.
    if (dailyPlus) {
      const bars = composeDailyPlusBars({
        days: result.data,
        interval,
        fromMs,
        toMs,
        steps: adjustment.steps,
        liveBar: liveSessionBar(await liveQuote, now),
      });
      if (bars.length > 0) {
        return respond(barsToUdfOk(bars, countback), result.source);
      }
      result = { ...result, data: [] };
    } else if (result.data.length > 0) {
      const rangeStartMs = fromSec * 1000;
      const rangeEndMs = toSec * 1000;
      const filteredBars = result.data.filter((bar) => {
        const barMs = bar.date.getTime();
        return barMs >= rangeStartMs && barMs <= rangeEndMs;
      });
      if (filteredBars.length > 0) {
        return respond(
          barsToUdfOk(
            applyAdjustment(filteredBars, adjustment.steps) as HistoricalBar[],
            countback
          ),
          result.source
        );
      }
      // Fetched data exists but none of it is in the requested range. Fall
      // through to the no_data branch, which uses the earliest-bar cache
      // and the `earliestSec >= toSec` check to decide whether to send
      // `nextTime` - preventing the infinite backward-scroll loop.
      result = { ...result, data: [] };
    }

    if (result.data.length === 0) {
      // No bars in the requested range. Two possibilities:
      //   (a) The widget is asking for data before the stock's listing date
      //       (newly-listed stock, common case). → Return no_data WITHOUT
      //       nextTime so the widget stops scrolling backwards.
      //   (b) The symbol has sparse data and the requested range happens to
      //       fall in a gap, but older data exists. → Return no_data WITH
      //       nextTime pointing to the earliest available bar.
      //
      // The distinction: compare the earliest-available-bar timestamp to the
      // requested `toSec`. If earliest >= toSec, case (a). Otherwise (b).
      //
      // CRITICAL: `nextTime` is interpreted by TradingView as "the next bar
      // exists at this timestamp IN THE PAST." Returning nextTime that points
      // FORWARD relative to the requested range (which is what the original
      // buggy code did for pre-listing requests) causes the widget to
      // infinite-loop backwards trying to find data.
      //
      // Intraday special case: Yahoo's intraday retention is bounded (5m:
      // ~60 days, 1m: ~7 days). When a scroll request falls OUTSIDE
      // retention, Yahoo returns empty and we should NOT probe with
      // period="max" - that probe fetches daily bars and would return a
      // nextTime pointing to the earliest daily bar, which for intraday
      // intervals is nonsense (daily.earliest is years old, but there's no
      // intraday data there). Just return no_data without nextTime and let
      // the widget stop scrolling.
      const isIntradayInterval = [
        "1m",
        "3m",
        "5m",
        "10m",
        "15m",
        "30m",
        "60m",
      ].includes(interval);
      if (isIntradayInterval) {
        return respond({ s: "no_data" });
      }

      const cacheKey = earliestBarCacheKey(rawSymbol, exchange, interval);
      let earliestSec = getCachedEarliestBar(cacheKey);

      if (earliestSec === null) {
        try {
          const earlierResult = await fetchHistoricalBars({
            symbol: rawSymbol,
            exchange,
            interval: fetchInterval,
            period: "max",
          });
          if (earlierResult.data.length === 0) {
            // No historical data at all. Cache a sentinel so we don't
            // re-probe on every subsequent request.
            setCachedEarliestBar(cacheKey, Number.MAX_SAFE_INTEGER);
            return respond({ s: "no_data" });
          }
          const earliest = earlierResult.data[0]!;
          earliestSec = Math.floor(earliest.date.getTime() / 1000);
          setCachedEarliestBar(cacheKey, earliestSec);
        } catch {
          return respond({ s: "no_data" });
        }
      }

      // Sentinel: no data exists anywhere
      if (earliestSec === Number.MAX_SAFE_INTEGER) {
        return respond({ s: "no_data" });
      }

      // Case (a): earliest available is at or after the requested end.
      // The widget is asking for pre-listing data. Tell it to stop.
      if (earliestSec >= toSec) {
        return respond({ s: "no_data" });
      }

      // Case (b): earliest is within or before the requested range. Point
      // the widget to it so it knows where real data starts.
      return respond({ s: "no_data", nextTime: earliestSec });
    }

    return respond(
      barsToUdfOk(
        applyAdjustment(result.data, adjustment.steps) as HistoricalBar[],
        countback
      ),
      result.source
    );
  } catch (error) {
    logger.error({ error }, "[udf/history] error");
    return NextResponse.json(
      {
        s: "error",
        errmsg: "internal error fetching bars",
      } satisfies UdfHistoryResponse,
      { status: 200 }
    );
  }
}
