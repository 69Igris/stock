"use server";

/**
 * Heatmap Data Server Action - MONEY-242
 *
 * Returns a flat list of NSE equity stocks with the fields the
 * TradingView-style treemap needs: ticker, name, sector, marketCap,
 * price, changePercent, exchange. The Treemap component groups by
 * sector and squarifies on the client.
 *
 * Scope filters:
 *   - "all"       → every active NSE equity that has a sector + quote
 *                   (capped at 2000 to keep the SVG sane)
 *   - "nifty500"  → top 500 NSE equities by marketCap (proxy for the
 *                   index - we don't have an authoritative index-
 *                   membership dataset yet, so largest-by-mcap is
 *                   the closest signal we can compute today)
 *   - "nifty50"   → top 50 NSE equities by marketCap
 *
 * Cache:
 *   - During market hours: 60s TTL
 *   - After close / weekend / holiday: 5 min TTL
 *
 * Perf history:
 *   - v1 (broken): findMany on InstrumentMapping with `latestQuote: { ... }`
 *     1-1 join. On Prisma's MongoDB connector that's N+1 round trips -
 *     ~2k equities × 1 query each → 60+ seconds in the field, leading to
 *     ECONNRESET aborts on the SSR.
 *   - v2: One query against LatestQuote with the `instrument` relation
 *     included. Better, but the relation predicate still became a JS-side
 *     join on the Mongo connector.
 *   - v3 (this file): TWO flat single-collection queries + a JS merge, each
 *     under its own 10s timeout.
 *   - v4 (MONEY-1092): the missing piece. v2/v3 both claimed the
 *     `orderBy: { marketCap: "desc" }` "uses index" — it did not. LatestQuote
 *     indexed only changePercent and [instrumentId, changePercent], so Mongo
 *     ran a BLOCKING in-memory SORT over every matching document before
 *     `take` applied. That is the 10s timeout users saw as "Failed to load
 *     market heatmap", intermittent because it only bites on a cold cache.
 *     Fixed by @@index([marketCap(sort: Desc)]) on LatestQuote, plus
 *     single-flight (an expiring key used to trigger N concurrent scans) and
 *     stale-while-error (a failed recompute now serves the last good copy
 *     instead of blanking the page).
 *
 * No mock data - empty array if quotes unavailable, UI shows a skeleton
 * loader.
 */

import { prisma } from "@usemoney/database";
import {
  cachedWithStaleFallback,
  SingleFlightTimeoutError,
  type ResolveOutcome,
} from "@usemoney/core/cache/stale-while-error";
import { normalizeToNseSector } from "@usemoney/core";
import { getNseMarketStatus } from "@usemoney/core";
import type { ServiceResult } from "@usemoney/services";
import { heatmapCutoffFor } from "./discover-heatmap-logic";
import { REAL_SECTOR_WHERE, hasRealSector } from "@usemoney/core/market-data";

export type HeatmapScope = "all" | "nifty50" | "nifty500";
export type HeatmapTimeframe = "1D" | "1W" | "1M" | "YTD";

export interface HeatmapStock {
  /** Plain ticker without exchange suffix (RELIANCE, not RELIANCE.NS). */
  symbol: string;
  /** Full company name from InstrumentMapping. */
  name: string;
  /** Canonical NSE sector - already normalized by the action. */
  sector: string;
  /** Last quoted price (₹). */
  price: number;
  /** Day change percentage (-100 .. +100). */
  changePct: number;
  /** Market cap in INR (LatestQuote.marketCap). */
  mcap: number;
  /** Source exchange - almost always "NSE" but kept for future BSE/NSE-both support. */
  exchange: string;
}

export interface HeatmapData {
  stocks: HeatmapStock[];
  /** Coverage stats - useful for the "X stocks" caption. */
  coverage: {
    totalScope: number;
    withQuote: number;
    withSector: number;
  };
  /** ISO timestamp of the most recent quote in the response. */
  asOf: string;
  /** MONEY-1092 - true when the live recompute failed and this is the
   *  last-known-good copy. The UI must say so rather than presenting it as
   *  current; absent/false means freshly computed. */
  stale?: boolean;
  /** Epoch ms at which the stale copy was originally computed. Only set
   *  alongside `stale: true`. */
  staleSince?: number;
}

const CACHE_NAMESPACE = "discover" as const;
const CACHE_KEY_PREFIX = "heatmap";

/** Top-N marketcap thresholds for proxy index scopes. `all` is capped at
 *  2000 so the SVG stays interactive (each rectangle is a `<g>` with text). */
const SCOPE_LIMITS: Record<HeatmapScope, number> = {
  all: 2000,
  nifty500: 500,
  nifty50: 50,
};

/** Hard timeout for each Prisma leg. Beyond this we'd rather fail fast and
 *  let the UI render a "warming up" skeleton than block the SSR.
 *
 *  10s is inherited from the v2 era, when a single relation-filtered query
 *  (LatestQuote with `instrument` predicates) needed more headroom than 4s.
 *  v3 replaced that with two flat single-collection queries and v4 indexed
 *  the sort, so the budget is now generous rather than tight — prod explains
 *  at ~5ms. Kept as a backstop for a cold QA/dev Mongo, NOT because the
 *  query still needs it. (The old wording described a query shape this file
 *  no longer uses; a stale comment here already misled one reader.) */
const FETCH_TIMEOUT_MS = 10000;

/** How long a successful result survives as the stale-fallback copy.
 *  Deliberately far longer than the fresh TTL: this entry exists to cover an
 *  outage, and a fallback that expires during the incident it was created for
 *  is not a fallback. A day-old heatmap is still a better answer than an
 *  error box. */
const LAST_GOOD_TTL_SECONDS = 24 * 60 * 60;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export async function getHeatmapDataAction(args: {
  scope: HeatmapScope;
  /** Timeframe for the % change shown on each rectangle. Default 1D -
   *  uses LatestQuote.changePercent directly. Longer timeframes derive
   *  the change from DailyPrice deltas, which the longer scope action
   *  does behind a separate code path. */
  timeframe?: HeatmapTimeframe;
}): Promise<ServiceResult<HeatmapData>> {
  const { scope, timeframe = "1D" } = args;
  if (scope !== "all" && scope !== "nifty50" && scope !== "nifty500") {
    return { success: false, error: "Invalid scope" };
  }
  if (
    timeframe !== "1D" &&
    timeframe !== "1W" &&
    timeframe !== "1M" &&
    timeframe !== "YTD"
  ) {
    return { success: false, error: "Invalid timeframe" };
  }

  const status = getNseMarketStatus();
  // Per-(scope, timeframe) cache key. TTL stays the same - short during
  // live market, long after close.
  const cacheKey = `${CACHE_KEY_PREFIX}:${scope}:${timeframe}`;

  const limit = SCOPE_LIMITS[scope];
  // Pull a buffer above the cap so we have headroom after dropping rows
  // with missing sector/changePct. 1.5× scaling has held empirically; a
  // hard ceiling of 3000 prevents a single query from getting too big
  // when scope=all and the universe is ~2k stocks anyway.
  const fetchTake = Math.min(3000, Math.ceil(limit * 1.5));

  // MONEY-1092 - the cache read, the single-flight guard and the
  // stale-fallback all live in the helper now. `compute` runs ONLY on a
  // fresh-cache miss, and only ONCE per key per instance however many
  // requests arrive together: the previous bare getCached/setCached pair
  // let every concurrent visitor on an expired key launch its own scan.
  //
  // MONEY-1157 - the `await` is wrapped because `cachedWithStaleFallback` has
  // TWO ways of reporting a failure, and this call site only handled one.
  // Anything `compute` throws is folded INTO the returned outcome
  // (`failed`/`stale`) by `resolveWithStaleFallback`, so the outcome branches
  // below looked exhaustive. They are not: the helper's own single-flight
  // backstop REJECTS. `withDeadline` fires `SingleFlightTimeoutError` at
  // `SINGLE_FLIGHT_TIMEOUT_MS` (25s) for the leader AND every follower on the
  // key, and that rejection escaped this function entirely — past the
  // `status === "failed"` branch, so the sanitising `console.warn` below (by
  // its own comment "the only record of what actually broke") never ran and
  // the raw internal message went to the client instead of the generic string.
  // Prime suspect for the 2026-08-08 "0 sectors" render on /discover/markets:
  // a cold deploy is exactly when a 25s flight is plausible, and it recovered
  // with no code change once the cache was warm.
  //
  // Normalising the rejection into the SAME `failed` outcome (see the
  // `.catch` immediately after this call) keeps ONE error path rather than
  // growing a second one next to it.
  const resolution = cachedWithStaleFallback<HeatmapData>({
    module: CACHE_NAMESPACE,
    scope: "_global",
    identifier: cacheKey,
    ttlSeconds: status.isLive ? 60 : 300,
    staleTtlSeconds: LAST_GOOD_TTL_SECONDS,
    compute: async () => {
      // Compute the cutoff date for non-1D timeframes. We use IST calendar
      // days so weekends/holidays don't surprise us - the closest
      // earlier-or-equal trading day's close is what we'll diff against.
      // (Pure math extracted to ./discover-heatmap-logic for unit testing.)
      const cutoff: Date | null = heatmapCutoffFor(timeframe);

      // TWO round trips - but each is a single-collection scan with no
      // relation predicate. Prisma's MongoDB connector turns relation
      // predicates (`instrument: {...}`) into JS-side joins that often
      // exceed our timeout on cold caches. Splitting into:
      //   1. LatestQuote.findMany ordered by marketCap desc (uses index)
      //   2. InstrumentMapping.findMany filtered by id $in
      //   3. JS-side merge + filter
      // is faster and far more predictable. The instrument set is bounded
      // (3000 ids ≪ Mongo's $in soft cap of ~10k).
      const quoteRows = await withTimeout(
        prisma.latestQuote.findMany({
          where: {
            marketCap: { not: null, gt: 0 },
            changePercent: { not: null },
          },
          select: {
            instrumentId: true,
            price: true,
            changePercent: true,
            marketCap: true,
            timestamp: true,
          },
          orderBy: { marketCap: "desc" },
          take: fetchTake,
        }),
        FETCH_TIMEOUT_MS,
        "heatmap fetch"
      );

      const ids = quoteRows.map((q) => q.instrumentId);
      const instruments = ids.length
        ? await withTimeout(
            prisma.instrumentMapping.findMany({
              where: {
                id: { in: ids },
                isActive: true,
                instrumentType: "EQUITY",
                exchange: "NSE",
                sector: REAL_SECTOR_WHERE,
              },
              select: {
                id: true,
                symbol: true,
                name: true,
                sector: true,
                exchange: true,
              },
            }),
            FETCH_TIMEOUT_MS,
            "heatmap instruments fetch"
          )
        : [];
      const instrumentById = new Map(instruments.map((i) => [i.id, i]));

      const quotes = quoteRows
        .map((q) => {
          const inst = instrumentById.get(q.instrumentId);
          if (!inst) return null;
          return { ...q, instrument: inst };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // For non-1D timeframes, batch-fetch the closing price at (or
      // immediately before) the cutoff date for every instrument we care
      // about. One round trip across instrumentIds, then we compute the
      // delta in-memory. If the batch comes back empty (rare - early
      // backfill or DailyPrice not yet hydrated for this universe) we
      // fall back to the 1D `changePercent` rather than block the page.
      const cutoffCloseByInstrument = new Map<string, number>();
      if (cutoff && quotes.length > 0) {
        const ids = quotes.map((q) => q.instrumentId);
        try {
          const upper = new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);
          const dailyRows = await withTimeout(
            prisma.dailyPrice.findMany({
              where: {
                instrumentId: { in: ids },
                date: { gte: cutoff, lt: upper },
              },
              select: { instrumentId: true, close: true },
            }),
            FETCH_TIMEOUT_MS,
            "heatmap cutoff fetch"
          );
          for (const r of dailyRows) {
            if (Number.isFinite(r.close) && r.close > 0) {
              cutoffCloseByInstrument.set(r.instrumentId, r.close);
            }
          }
        } catch (err) {
          // Soft-fail: log + continue with empty map → falls back to 1D %.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `getHeatmapDataAction (timeframe=${timeframe}) cutoff lookup failed: ${msg}`
          );
        }
      }

      let withQuote = 0;
      let withSector = 0;
      let mostRecentQuoteAt = 0;
      const transformed: HeatmapStock[] = [];

      for (const q of quotes) {
        const inst = q.instrument;
        if (!inst || !hasRealSector(inst.sector)) continue; // MONEY-1152: `!inst.sector`
        // let the "N/A" tombstone through, and normalizeToNseSector passes it
        // straight out — so the treemap grew an "N/A" tile built from 7,822 of
        // the 10,111 NSE instruments, dwarfing every real sector.
        withSector += 1;
        if (
          !Number.isFinite(q.price) ||
          q.changePercent == null ||
          !Number.isFinite(q.changePercent) ||
          !q.marketCap ||
          !Number.isFinite(q.marketCap)
        ) {
          continue;
        }
        withQuote += 1;
        const ts = q.timestamp ? q.timestamp.getTime() : 0;
        if (ts > mostRecentQuoteAt) mostRecentQuoteAt = ts;
        const sector =
          normalizeToNseSector(inst.sector) ?? inst.sector ?? "Other";

        // Resolve the change% for the requested timeframe. 1D is the
        // already-stored intraday %. Longer windows use the closing price
        // at (or near) the cutoff date; if the daily-price row was missing
        // we silently fall back to 1D - better than hiding the cell.
        let changePct = q.changePercent;
        if (timeframe !== "1D") {
          const cutoffClose = cutoffCloseByInstrument.get(q.instrumentId);
          if (cutoffClose && cutoffClose > 0 && Number.isFinite(q.price)) {
            changePct = ((q.price - cutoffClose) / cutoffClose) * 100;
          }
        }

        transformed.push({
          symbol: inst.symbol,
          name: inst.name,
          sector,
          price: q.price,
          changePct,
          mcap: q.marketCap,
          exchange: inst.exchange,
        });
        if (transformed.length >= limit) break;
      }

      const data: HeatmapData = {
        stocks: transformed,
        coverage: {
          totalScope: quotes.length,
          withSector,
          withQuote,
        },
        asOf:
          mostRecentQuoteAt > 0
            ? new Date(mostRecentQuoteAt).toISOString()
            : new Date().toISOString(),
      };

      return data;
    },
  });

  // Attached synchronously (no `await` between the call above and here), so a
  // rejection can never surface as an unhandled one.
  const outcome: ResolveOutcome<HeatmapData> = await resolution.catch(
    (error: unknown): ResolveOutcome<HeatmapData> => {
      if (!(error instanceof SingleFlightTimeoutError)) {
        // NOT the known backstop, so something genuinely unexpected escaped
        // the cache helper (a bug in the helper itself, or in a port it
        // calls outside its own try/catch). It is still contained — a server
        // action must RETURN a ServiceResult, not throw a raw message at the
        // client — but it is logged at a distinct level and with a distinct
        // prefix so it can never hide inside the routine timeout line below.
        console.error(
          `getHeatmapDataAction (scope=${scope}) unexpected error escaped ` +
            `the cache helper: ${describeError(error)}`
        );
      }
      return { status: "failed", error };
    }
  );

  if (outcome.status === "failed") {
    const message = describeError(outcome.error);
    // The user-facing string is deliberately generic, so THIS line is the
    // only record of what actually broke. The two withTimeout labels above
    // ("heatmap fetch" vs "heatmap instruments fetch") are what tell you
    // which leg gave up - keep them distinct.
    console.warn(`getHeatmapDataAction (scope=${scope}) failed: ${message}`);
    return {
      success: false,
      error: "Failed to load market heatmap",
    };
  }

  if (outcome.status === "stale") {
    console.warn(
      `getHeatmapDataAction (scope=${scope}) serving last-good copy from ` +
        `${new Date(outcome.computedAt).toISOString()}: ${describeError(outcome.error)}`
    );
    // Degrade, never dead-end - but never pass a stale snapshot off as
    // live either. The flag is what lets the UI render "as of HH:MM".
    return {
      success: true,
      data: { ...outcome.data, stale: true, staleSince: outcome.computedAt },
    };
  }

  return { success: true, data: outcome.data };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
