"use server";

/**
 * Sector deep-dive - Images #43, #44.
 *
 * Builds the full deep-dive payload from real data:
 *   - Identity row stats (count, YTD perf, Nifty YTD comp, total mcap)
 *   - 4-stat hero cards (weighted P/E, P/B, div yield, beta 1Y)
 *   - Constituents table (top 12 by mcap with day/1Y/P/E/trend)
 *   - Correlation chart (vs the other canonical sectors, 90d returns)
 *   - Results calendar for a RESULTS SEASON (MONEY-1217, not a rolling window)
 *
 * `institutionalPicks` replaces the old always-empty `fiiPicks`/`diiPicks`
 * (MONEY-268). Those described per-symbol FII/DII flow, which does not exist at
 * any grain we hold — see the block above the call below.
 *
 * Data sources:
 *   - InstrumentMapping (sector + industry classification)
 *   - LatestQuote (price, marketCap, changePercent for day/1Y)
 *   - DailyPrice (90d windows for correlation)
 *   - StockRatios (P/E, P/B, div yield, beta) - optional, returns null
 *     when row missing
 *   - UpcomingEvent (earnings calendar)
 */

import prisma from "@usemoney/database";
import type { ActionResponse } from "@usemoney/validation";
import {
  cachedWithStaleFallback,
  SingleFlightTimeoutError,
  type ResolveOutcome,
} from "@usemoney/core/cache/stale-while-error";
import { getNseMarketStatus } from "@usemoney/core";
import { getAllSectorNames } from "@usemoney/core/sector-taxonomy";
import {
  getSectorInstitutionalPicks,
  type SectorInstitutionalPicksData,
} from "@usemoney/services";

/**
 * Re-exported so the CLIENT component types its rows without importing
 * `@usemoney/services` itself — that barrel reaches the Prisma client, and a
 * value import of it from a "use client" module would drag the server graph
 * into the browser bundle. Type-only, so this erases at compile time (the same
 * reason `export interface SectorDeepDive` below is legal in a "use server"
 * module, where only async function VALUE exports are allowed).
 */
export type {
  SectorInstitutionalPick,
  SectorInstitutionalPicksData,
} from "@usemoney/services";
import {
  currentOrNextSeason,
  groupResultsByDay,
  isSeasonOrdinalInRange,
  seasonFromOrdinal,
  type ResultsCalendarDay,
  type ResultsSeason,
} from "@usemoney/core/market-data/results-season";
import { UNCATEGORISED_SECTOR, SECTOR_SKIPPED } from "@/lib/sectors/buckets";
import {
  SECTOR_DEEP_DIVE_TIMEOUT_ERROR,
  SECTOR_DEEP_DIVE_FAILED_ERROR,
} from "./sector-deep-dive-messages";

/* ---------------------------------------------------------------------
   MONEY-1092 - bounds, batching and caching
   ---------------------------------------------------------------------
   This action used to run ~38 SEQUENTIAL queries over ~50k documents per
   sector pick, with no timeout and no cache, on every pick by every user.
   The peer-correlation block alone did 3 awaited queries inside a loop
   over 11 sectors. On a cold database that exceeded the platform function
   limit, the client promise rejected, and because the caller had no
   `.catch` the spinner hung forever.

   Three changes:
     1. the 11-iteration peer loop collapses into 3 batched queries;
     2. every leg runs under a timeout, so a slow database degrades into
        an error the UI can render rather than an infinite wait;
     3. the whole payload is cached with the same stale-while-error
        primitive the heatmap uses.
   ------------------------------------------------------------------ */

/** Per-query ceiling. Matches the heatmap's budget. */
const QUERY_TIMEOUT_MS = 10_000;

/**
 * How many constituents ride into the response. This is a PREVIEW list -
 * the panel links out to the screener for the full sector - but note the
 * aggregates below are deliberately NOT limited to it.
 */
const CONSTITUENT_PREVIEW = 12;

/**
 * How many instruments (largest first) get a daily-price series.
 *
 * Series are needed for two things: the sparkline on previewed rows, and
 * the mcap-weighted return series used for sector correlation. Both are
 * mcap-weighted, so the long tail of a 284-name sector contributes
 * almost nothing while costing ~130 rows each. Capping at the top 50 by
 * market cap keeps the query an order of magnitude smaller for a
 * difference well below the noise floor of a correlation estimate.
 *
 * The cheap aggregates (count, total mcap, weighted P/E, P/B, dividend
 * yield, beta) do NOT use this cap - they run over every constituent.
 */
const DAILY_SERIES_LIMIT = 50;

/** Peers sampled per sector for the correlation series (largest first). */
const PEER_SAMPLE = 30;

/**
 * Backstop on the per-sector instrument fetch.
 *
 * Measured on live prod, NSE-only: the largest sector is Industrials at ~380
 * instruments, so 2000 gives an order of magnitude of headroom and never
 * binds in practice. It exists so this query can never become the unbounded
 * scan that took the heatmap down - "no sector is that big today" is not a
 * guarantee, and a silent 4,000-element `$in` is how the last one started.
 */
const SECTOR_INSTRUMENT_CAP = 2000;

/**
 * Per-sector cap for the peer-correlation query.
 *
 * Comfortably above the largest real sector this file has measured (~380 NSE
 * rows) and an order of magnitude above `PEER_SAMPLE`, so the mcap ranking has
 * plenty to choose from. A GLOBAL cap across 13 sectors could not give that
 * guarantee: it let one sector consume another's budget, so the tail sectors
 * were sampled from a truncated prefix or dropped entirely.
 */
const PEER_SECTOR_CAP = 600;

/** Cached payload lifetime. Short while the market moves, longer after. */
const CACHE_TTL_LIVE_SECONDS = 60;
const CACHE_TTL_CLOSED_SECONDS = 600;
const LAST_GOOD_TTL_SECONDS = 24 * 60 * 60;

/**
 * A sector with no mapped instruments. Distinct from a transient failure:
 * this is a permanent "no such thing" answer, so it must NOT be served
 * from the stale-fallback copy or retried.
 */
class SectorNotFoundError extends Error {
  readonly kind = "sector-not-found" as const;
}

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

export interface SectorDeepDive {
  name: string;
  count: number;
  totalMcap: number;
  ytdPerf: number | null;
  niftyYtdPerf: number | null;
  weighted: {
    pe: { value: number | null; vsIndex: number | null };
    pb: { value: number | null; vs5yAvg: number | null };
    divYield: { value: number | null; vsNifty: number | null };
    beta: { value: number | null; descriptor: "low" | "moderate" | "high" };
  };
  constituents: Array<{
    symbol: string;
    name: string;
    mcap: number;
    dayPct: number;
    oneYPct: number | null;
    pe: number | null;
    trend: number[];
  }>;
  /** MONEY-1092 - set when the live recompute failed and this is the
   *  last-known-good copy. The panel must say so rather than presenting it
   *  as current. Absent/false means freshly computed. */
  stale?: boolean;
  /** Epoch ms the stale copy was originally computed. Only with `stale`. */
  staleSince?: number;
  correlation: Array<{ peer: string; value: number }>;
  /**
   * Largest disclosed net buys/sells among this sector's constituents over the
   * feed's last few sessions (MONEY-268). Null when the read failed — which the
   * panel must render differently from an EMPTY window, because "we could not
   * load this" and "the exchange published no prints" are different facts.
   */
  institutionalPicks: SectorInstitutionalPicksData | null;
  /** The results calendar for the current-or-next season (MONEY-1217). */
  earnings: ResultsCalendar;
}

/**
 * A results calendar: one season's announced dates, grouped by day.
 *
 * `days` holds ONLY days that have at least one event — see `groupResultsByDay`
 * for why the zero-event days are omitted rather than rendered. `total` is the
 * event count, so `total === 0` is the honest "we know of nothing announced in
 * this window yet" state and is the one the UI must caption, never a pill
 * reading "0 events" over a month of blank cells.
 */
export interface ResultsCalendar {
  season: {
    /** e.g. "Q2 FY27". */
    label: string;
    /** Round-trips to the exact window via `seasonFromOrdinal`. */
    ordinal: number;
    /** `YYYY-MM-DD`, inclusive. */
    start: string;
    /** `YYYY-MM-DD`, INCLUSIVE last day — the window's `end` is exclusive. */
    endInclusive: string;
  };
  days: ResultsCalendarDay[];
  total: number;
}

/** What a results calendar is scoped to. */
export type ResultsCalendarScope =
  | { scope: "sector"; sector: string }
  | { scope: "stock"; symbol: string };

/**
 * Peer sectors for the correlation chart — the CANONICAL set, not a hand-written
 * list.
 *
 * The old hardcoded 12 contained only 5 canonical names. The other 7 ("Banks",
 * "Automobile", "Pharmaceuticals", "Metals", "Realty", "Media", "Consumer
 * Durables") match zero rows, so every sector's chart carried ~7 fabricated
 * "0.00" correlation rows. Real Estate made that visible rather than merely
 * wrong: the list held "Realty" and NOT "Real Estate", so the Real Estate panel
 * showed a row labelled "Realty · 0.00" — the sector's own former alias
 * presented as a distinct, uncorrelated sector — and no 1.00 self-anchor,
 * because the `peer === sector` check could never fire.
 */
const NIFTY_SECTORS = getAllSectorNames();

/**
 * Translate a DISPLAY bucket name into the value actually stored in
 * `InstrumentMapping.sector`.
 *
 * Only one bucket is rewritten on the way in, and it is the one that was always
 * broken: the heatmap shows "Not Categorised" for the enrichment sentinel, but
 * the stored value is the literal "N/A". So clicking that tile queried a string
 * that exists on zero rows and always rendered
 * `No instruments mapped to sector "Not Categorised"`.
 *
 * Everything else passes through unchanged — the non-canonical passthrough
 * buckets ("Other", "Construction", …) are stored exactly as displayed, and
 * collapsing them here would hide a real data-quality problem.
 */
function toStoredSector(displaySector: string): string {
  return displaySector === UNCATEGORISED_SECTOR
    ? SECTOR_SKIPPED
    : displaySector;
}

/**
 * The Prisma `sector` predicate for a display bucket.
 *
 * The bucket is NOT a single value. Both aggregators define it as
 * `s.sector && s.sector !== "N/A" ? s.sector : "Not Categorised"`
 * (`lib/sectors/aggregate.ts` and `discover-market.service.ts`) — so a NULL
 * sector lands in the same tile as the `"N/A"` sentinel. Querying only `"N/A"`
 * therefore computed the panel's constituents, total mcap and all four weighted
 * hero stats over a SMALLER population than the tile advertises, and showed the
 * empty state whenever uncategorised rows are predominantly null.
 */
function sectorWhere(displaySector: string) {
  if (displaySector !== UNCATEGORISED_SECTOR) {
    return { sector: displaySector };
  }
  // THREE buckets, not two — MONEY-1236.
  //
  // `sector` is `String?` and no instrument-mapping create path writes it, so a
  // row that enrichment has never reached carries the key ABSENT, and Prisma's
  // MongoDB connector does not match an absent key with `{ sector: null }`.
  // `peer-selection-logic.ts` measures the gap on the same table: 22,153 active
  // EQUITY rows against 21,885 with a non-null sector.
  //
  // The aggregators this predicate has to agree with treat all three the same —
  // `s.sector && s.sector !== "N/A" ? s.sector : "Not Categorised"` is falsy for
  // absent, null AND the sentinel — so leaving the absent arm out reproduced,
  // one bucket smaller, the exact undercount the comment above describes.
  return {
    OR: [
      { sector: null },
      { sector: { isSet: false } },
      { sector: SECTOR_SKIPPED },
    ],
  };
}

function ytdFromDailyPrices(
  rows: Array<{ date: Date; close: number }>
): number | null {
  if (rows.length < 2) return null;
  const ytdStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const before = rows.find((r) => r.date >= ytdStart);
  if (!before) return null;
  const last = rows[rows.length - 1];
  if (!last || before.close <= 0) return null;
  return ((last.close - before.close) / before.close) * 100;
}

function correlationPair(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    sumA += av;
    sumB += bv;
    sumAA += av * av;
    sumBB += bv * bv;
    sumAB += av * bv;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  const varA = sumAA / n - meanA * meanA;
  const varB = sumBB / n - meanB * meanB;
  const cov = sumAB / n - meanA * meanB;
  const denom = Math.sqrt(varA * varB);
  if (!Number.isFinite(denom) || denom === 0) return 0;
  return cov / denom;
}

function pctReturns(rows: Array<{ date: Date; close: number }>): number[] {
  const out: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!.close;
    const cur = rows[i]!.close;
    if (prev > 0) out.push(((cur - prev) / prev) * 100);
  }
  return out;
}

/* ---------------------------------------------------------------------
   Results calendar — MONEY-1217
   ---------------------------------------------------------------------
   This panel used to query `UpcomingEvent` for `date` in `[now, now+30d)` and
   render a full month grid of the result. Measured on prod 2026-08-19 that
   window held **7** earnings rows for the ENTIRE market (30 in the future at
   all), so every sector's grid was a wall of blank cells under a green
   "0 events" pill — which a reader parses as "this sector has no earnings this
   month", a claim an empty query cannot support.

   The window was the bug, not the feed. `upcoming_events` holds 766 NSE-sourced
   earnings rows covering the whole listed universe; Indian companies just
   report in four bursts bounded by SEBI's 45/60-day deadlines, and mid-August
   sits between two of them. So the calendar is now scoped to a results SEASON
   (`@usemoney/core/market-data/results-season`) and lists only the days that
   actually have data.
   ------------------------------------------------------------------ */

/**
 * Load one season's announced results dates for a set of symbols.
 *
 * Shared by the cached deep-dive payload and the standalone
 * `getResultsCalendarAction` so the two surfaces cannot answer the same
 * question differently — the scope decides the symbol list, and nothing else
 * about the query changes.
 *
 * `names` supplies the display name per symbol. It is passed in rather than
 * joined here because both callers have already read `InstrumentMapping` for
 * their own reasons; a second lookup would be a query for data in scope.
 *
 * The `.catch` keeps a missing or slow `upcoming_events` degrading to an empty
 * calendar rather than failing the whole panel — and an empty calendar is a
 * legible state now, which is exactly what it was not before.
 */
async function loadResultsCalendar(
  names: ReadonlyArray<{ symbol: string; name: string | null }>,
  season: ResultsSeason
): Promise<ResultsCalendar> {
  const nameBySymbol = new Map(names.map((n) => [n.symbol, n.name]));
  const symbols = Array.from(nameBySymbol.keys());

  const rows = symbols.length
    ? await withTimeout(
        prisma.upcomingEvent.findMany({
          where: {
            symbol: { in: symbols },
            category: "earnings",
            // Half-open, matching the season's own contract: `start` inclusive,
            // `end` exclusive. `lte: end` would pull in the first day of the
            // gap after the season closes.
            date: { gte: season.start, lt: season.end },
          },
          select: { date: true, symbol: true, title: true },
          orderBy: { date: "asc" },
        }),
        QUERY_TIMEOUT_MS,
        "results calendar fetch"
      ).catch(
        () => [] as Array<{ date: Date; symbol: string | null; title: string }>
      )
    : [];

  const days = groupResultsByDay(
    rows
      // `symbol` is nullable on the model — a macro event (RBI policy) has no
      // issuer. Those can never be in a sector's calendar, and a null symbol
      // must never become the string "null" on screen.
      .filter((r): r is { date: Date; symbol: string; title: string } =>
        Boolean(r.symbol)
      )
      .map((r) => ({
        date: r.date,
        symbol: r.symbol,
        name: nameBySymbol.get(r.symbol) ?? null,
        title: r.title,
      }))
  );

  return {
    season: {
      label: season.label,
      ordinal: season.ordinal,
      start: season.start.toISOString().slice(0, 10),
      // `end` is exclusive; the reader wants the last day IN the window.
      endInclusive: new Date(season.end.getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10),
    },
    days,
    total: days.reduce((n, d) => n + d.events.length, 0),
  };
}

/**
 * The results calendar on its own, for the panel's season / scope selectors.
 *
 * Deliberately NOT part of the cached deep-dive payload: that payload is one
 * sector's worth of aggregates keyed on the sector name, and folding a
 * user-chosen season and scope into its cache key would multiply the entries by
 * the number of selector states while the expensive legs (quotes, ratios, 90-day
 * peer series) are identical across all of them.
 *
 * `seasonOrdinal` crosses a trust boundary. It is re-derived server-side through
 * `seasonFromOrdinal` — the client never sends dates — and rejected outright
 * when it is not within `SEASON_ORDINAL_SPAN` quarters of now, rather than
 * clamped: clamping a nonsense ordinal to a valid window hides the caller bug
 * that produced it and answers a question nobody asked.
 */
export async function getResultsCalendarAction(
  args: ResultsCalendarScope & { seasonOrdinal?: number }
): Promise<ActionResponse<ResultsCalendar>> {
  const now = new Date();
  let season: ResultsSeason;
  if (args.seasonOrdinal == null) {
    season = currentOrNextSeason(now);
  } else if (isSeasonOrdinalInRange(args.seasonOrdinal, now)) {
    season = seasonFromOrdinal(args.seasonOrdinal);
  } else {
    return { success: false, error: "Season out of range" };
  }

  try {
    if (args.scope === "stock") {
      const symbol = args.symbol?.trim().toUpperCase();
      if (!symbol) return { success: false, error: "Missing symbol" };
      // One row, for the display name. A symbol we have no mapping for is still
      // a valid query against `upcoming_events` — the calendar just shows no
      // long name — so a miss degrades rather than erroring.
      const inst = await withTimeout(
        prisma.instrumentMapping.findFirst({
          where: { symbol, exchange: "NSE", isActive: true },
          select: { symbol: true, name: true },
        }),
        QUERY_TIMEOUT_MS,
        "results calendar symbol fetch"
      ).catch(() => null);
      return {
        success: true,
        data: await loadResultsCalendar(
          [inst ?? { symbol, name: null }],
          season
        ),
      };
    }

    const sector = args.sector?.trim();
    if (!sector) return { success: false, error: "Missing sector" };
    const instruments = await withTimeout(
      prisma.instrumentMapping.findMany({
        where: {
          isActive: true,
          instrumentType: "EQUITY",
          exchange: "NSE",
          ...sectorWhere(sector),
        },
        select: { symbol: true, name: true },
        // Same backstop as the deep-dive's own instrument fetch, for the same
        // reason: this is a bound, not a business rule.
        take: SECTOR_INSTRUMENT_CAP,
      }),
      QUERY_TIMEOUT_MS,
      "results calendar sector fetch"
    );
    return {
      success: true,
      data: await loadResultsCalendar(instruments, season),
    };
  } catch (error) {
    console.warn(
      `getResultsCalendarAction (${args.scope}) failed: ` +
        (error instanceof Error ? error.message : String(error))
    );
    return { success: false, error: "Could not load the results calendar" };
  }
}

export async function getSectorDeepDiveAction(args: {
  sector: string;
}): Promise<ActionResponse<SectorDeepDive>> {
  const { sector } = args;
  if (!sector) return { success: false, error: "Missing sector" };

  // The DB value to query. `sector` stays the DISPLAY name throughout — it is
  // what the panel heading and the self-anchor row show — but the sentinel
  // bucket is stored under a different string.
  const storedSector = toStoredSector(sector);

  const status = getNseMarketStatus();
  // MONEY-1157 — sibling of the same defect fixed in ./discover-heatmap.ts, and
  // there are exactly two `cachedWithStaleFallback` call sites in the repo, so
  // this is the whole class. `compute` errors are folded into the returned
  // outcome, but the helper's own single-flight backstop REJECTS with
  // `SingleFlightTimeoutError` at 25s — escaping every branch below, including
  // the `SectorNotFoundError` passthrough and the sanitising warn. This
  // compute has more legs than the heatmap's (instruments, quotes, ratios,
  // 90-day peer daily prices, FII/DII, earnings), so it is at least as likely
  // to hit the deadline. Normalised into the SAME `failed` outcome.
  const resolution = cachedWithStaleFallback<SectorDeepDive>({
    module: "discover",
    scope: "_global",
    identifier: `sector-deep-dive:${sector}`,
    ttlSeconds: status.isLive
      ? CACHE_TTL_LIVE_SECONDS
      : CACHE_TTL_CLOSED_SECONDS,
    staleTtlSeconds: LAST_GOOD_TTL_SECONDS,
    // A sector with no instruments is an ANSWER, not an outage. Without
    // this the stale branch would serve a last-good copy and resurrect a
    // sector that no longer exists for the whole 24h fallback window —
    // which MONEY-1093 is about to make a routine occurrence when it
    // reclassifies ~11.8k instruments.
    isPermanentError: (e) => e instanceof SectorNotFoundError,
    compute: async () => {
      // MONEY-1092 - two defects fixed here, both measured against live prod.
      //
      // 1. The old `take: 200` truncated the sector, and since every weighted
      //    aggregate below is computed from this list, the panel reported a
      //    market cap, a weighted P/E, a P/B and a beta for a 200-name SUBSET
      //    while labelling them as the sector's.
      //
      // 2. There was NO exchange filter. `{EQUITY, isActive, sector}` alone
      //    matched 4,394 rows for Financial Services - BSE 4,104 + NSE 290 -
      //    including 278 DUAL-LISTED symbols present on both exchanges. Those
      //    278 companies were counted TWICE in `totalMcap` and in every
      //    weighted average. That, not the truncation, is the main reason the
      //    drill-down's market cap never reconciled with the same sector's row
      //    in the ranked table: the two surfaces were reading different
      //    universes. The heatmap filters `exchange: "NSE"`
      //    (discover-heatmap.ts), so matching it here is what makes the
      //    numbers agree.
      //
      // NOTE the residual, deliberate scope difference: the ranked table
      // counts a sector's members WITHIN the heatmap's top-2000-by-mcap
      // universe (SCOPE_LIMITS.all in discover-heatmap.ts - the 3000 there is
      // only an over-fetch buffer consumed before filtering, never the output
      // cap), while this covers the whole NSE sector. So the table can read
      // 209 where this reads ~285. That gap is real and defensible;
      // double-counting BSE was not.
      const instruments = await withTimeout(
        prisma.instrumentMapping.findMany({
          where: {
            isActive: true,
            instrumentType: "EQUITY",
            exchange: "NSE",
            ...sectorWhere(sector),
          },
          select: { id: true, symbol: true, name: true, sector: true },
          // Backstop, not a business rule. With the exchange filter the
          // largest real sector is ~380 (Industrials), so this never binds -
          // but leaving the query fully unbounded would reintroduce exactly
          // the unbounded-scan class this ticket exists to remove.
          take: SECTOR_INSTRUMENT_CAP,
        }),
        QUERY_TIMEOUT_MS,
        "deep-dive instruments fetch"
      );
      if (instruments.length === 0) {
        throw new SectorNotFoundError(
          `No instruments mapped to sector "${sector}".`
        );
      }

      const ids = instruments.map((i) => i.id);
      // Quotes and ratios cover the FULL sector - they are the inputs to the
      // aggregates, and they are cheap (two indexed `$in` reads, no series).
      const [quotes, ratios] = await Promise.all([
        withTimeout(
          prisma.latestQuote.findMany({
            where: { instrumentId: { in: ids }, marketCap: { gt: 0 } },
            select: {
              instrumentId: true,
              price: true,
              marketCap: true,
              changePercent: true,
            },
          }),
          QUERY_TIMEOUT_MS,
          "deep-dive quotes fetch"
        ),
        // Stock ratios for the weighted P/E / P/B / div yield / beta.
        withTimeout(
          prisma.stockRatios.findMany({
            where: { symbol: { in: instruments.map((i) => i.symbol) } },
            select: {
              symbol: true,
              pe: true,
              pb: true,
              dividendYield: true,
              beta: true,
            },
          }),
          QUERY_TIMEOUT_MS,
          "deep-dive ratios fetch"
        ).catch(
          () =>
            [] as Array<{
              symbol: string;
              pe: number | null;
              pb: number | null;
              dividendYield: number | null;
              beta: number | null;
            }>
        ),
      ]);
      const quoteById = new Map(quotes.map((q) => [q.instrumentId, q]));
      const ratioBySym = new Map(ratios.map((r) => [r.symbol, r]));

      // Daily series are the expensive leg (~130 rows per instrument), and
      // the only things that need them - sparklines on previewed rows and
      // the mcap-weighted correlation series - are dominated by the largest
      // names. Restrict to the top DAILY_SERIES_LIMIT by market cap rather
      // than pulling a series for every constituent.
      const ninetyDaysAgo = new Date(Date.now() - 130 * 86_400_000);
      const seriesIds = [...instruments]
        .sort(
          (a, b) =>
            (quoteById.get(b.id)?.marketCap ?? 0) -
            (quoteById.get(a.id)?.marketCap ?? 0)
        )
        .slice(0, DAILY_SERIES_LIMIT)
        .map((i) => i.id);

      const dailyAll = await withTimeout(
        prisma.dailyPrice.findMany({
          where: {
            instrumentId: { in: seriesIds },
            date: { gte: ninetyDaysAgo },
          },
          select: { instrumentId: true, date: true, close: true },
          orderBy: { date: "asc" },
        }),
        QUERY_TIMEOUT_MS,
        "deep-dive daily-price fetch"
      );
      const dailyById = new Map<string, Array<{ date: Date; close: number }>>();
      for (const r of dailyAll) {
        const arr = dailyById.get(r.instrumentId) ?? [];
        arr.push({ date: r.date, close: r.close });
        dailyById.set(r.instrumentId, arr);
      }

      // Build constituent rows (top 12 by mcap).
      const merged = instruments
        .map((inst) => {
          const q = quoteById.get(inst.id);
          if (!q) return null;
          const r = ratioBySym.get(inst.symbol);
          const dailies = dailyById.get(inst.id) ?? [];
          const oneYPct = ytdFromDailyPrices(dailies);
          const trend = dailies.slice(-30).map((d) => d.close);
          return {
            // Carried so the correlation pass below can look the series up
            // directly instead of scanning `instruments` by symbol per row.
            id: inst.id,
            symbol: inst.symbol,
            name: inst.name,
            mcap: q.marketCap ?? 0,
            dayPct: q.changePercent ?? 0,
            oneYPct,
            pe: r?.pe ?? null,
            pb: r?.pb ?? null,
            divYield: r?.dividendYield ?? null,
            beta: r?.beta ?? null,
            trend,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      merged.sort((a, b) => b.mcap - a.mcap);
      const constituents = merged.slice(0, CONSTITUENT_PREVIEW).map((m) => ({
        symbol: m.symbol,
        name: m.name,
        mcap: m.mcap,
        dayPct: m.dayPct,
        oneYPct: m.oneYPct,
        pe: m.pe,
        trend: m.trend,
      }));

      // ── Weighted aggregates ──
      const totalMcap = merged.reduce((s, m) => s + m.mcap, 0);
      let wPe = 0;
      let wPeDen = 0;
      let wPb = 0;
      let wPbDen = 0;
      let wDy = 0;
      let wDyDen = 0;
      let wBeta = 0;
      let wBetaDen = 0;
      let totalYtdNum = 0;
      let totalYtdDen = 0;
      for (const m of merged) {
        if (m.pe != null && Number.isFinite(m.pe)) {
          wPe += m.pe * m.mcap;
          wPeDen += m.mcap;
        }
        if (m.pb != null && Number.isFinite(m.pb)) {
          wPb += m.pb * m.mcap;
          wPbDen += m.mcap;
        }
        if (m.divYield != null && Number.isFinite(m.divYield)) {
          wDy += m.divYield * m.mcap;
          wDyDen += m.mcap;
        }
        if (m.beta != null && Number.isFinite(m.beta)) {
          wBeta += m.beta * m.mcap;
          wBetaDen += m.mcap;
        }
        if (m.oneYPct != null) {
          totalYtdNum += m.oneYPct * m.mcap;
          totalYtdDen += m.mcap;
        }
      }
      const weightedPe = wPeDen > 0 ? wPe / wPeDen : null;
      const weightedPb = wPbDen > 0 ? wPb / wPbDen : null;
      const weightedDy = wDyDen > 0 ? wDy / wDyDen : null;
      const weightedBeta = wBetaDen > 0 ? wBeta / wBetaDen : null;
      const sectorYtd = totalYtdDen > 0 ? totalYtdNum / totalYtdDen : null;

      // ── Nifty-50 YTD for comparison ──
      let niftyYtd: number | null = null;
      try {
        // A bare try/catch catches a REJECTION, not a HANG. These three
        // legs were unbounded while the header above claimed "every leg
        // runs under a timeout" — the exact failure class (hang -> spinner
        // that never settles) this file was rewritten to eliminate. Each
        // now carries its own label so a stall names itself.
        const niftyIdx = await withTimeout(
          prisma.instrumentMapping.findFirst({
            where: { symbol: "NIFTY 50" },
            select: { id: true },
          }),
          QUERY_TIMEOUT_MS,
          "deep-dive nifty lookup"
        );
        if (niftyIdx) {
          const niftyRows = await withTimeout(
            prisma.dailyPrice.findMany({
              where: {
                instrumentId: niftyIdx.id,
                date: { gte: ninetyDaysAgo },
              },
              select: { date: true, close: true },
              orderBy: { date: "asc" },
            }),
            QUERY_TIMEOUT_MS,
            "deep-dive nifty daily-price fetch"
          );
          niftyYtd = ytdFromDailyPrices(niftyRows);
        }
      } catch {
        niftyYtd = null;
      }

      // ── Correlation vs peer sectors ──
      // Build this sector's mcap-weighted daily return series.
      const dailyDateMap = new Map<string, number>();
      const dailyDateDen = new Map<string, number>();
      for (const m of merged) {
        // Only the top DAILY_SERIES_LIMIT names have a series; the rest are
        // skipped here. That is deliberate - this series is mcap-weighted, so
        // the omitted tail would move it by far less than the estimate's own
        // error bar (see DAILY_SERIES_LIMIT).
        const dailies = dailyById.get(m.id);
        if (!dailies || dailies.length < 2) continue;
        const returns = pctReturns(dailies);
        const dates = dailies
          .slice(1)
          .map((d) => d.date.toISOString().slice(0, 10));
        for (let i = 0; i < returns.length; i++) {
          const key = dates[i]!;
          dailyDateMap.set(
            key,
            (dailyDateMap.get(key) ?? 0) + returns[i]! * m.mcap
          );
          dailyDateDen.set(key, (dailyDateDen.get(key) ?? 0) + m.mcap);
        }
      }
      const thisSectorDates = Array.from(dailyDateMap.keys()).sort();
      const thisSectorReturns = thisSectorDates.map(
        (d) => dailyDateMap.get(d)! / dailyDateDen.get(d)!
      );

      // MONEY-1092 - this used to be a `for` loop over 11 peer sectors doing
      // THREE awaited queries each: 33 sequential round trips, the dominant
      // cost of the whole action. It is now 3 batched queries total, grouped
      // in JS.
      //
      // One behavioural improvement falls out of the batching: the old
      // per-sector `take: 30` had NO `orderBy`, so it sampled an arbitrary 30
      // names and the correlation could shift between identical requests.
      // Sampling the top PEER_SAMPLE by market cap instead is both
      // deterministic and a better proxy for a cap-weighted sector.
      const peerSectors = NIFTY_SECTORS.filter((p) => p !== sector);
      const correlation: Array<{ peer: string; value: number }> = [];
      if (peerSectors.length > 0) {
        // ONE bounded query PER SECTOR, not one bounded query across all of
        // them.
        //
        // A single `take: SECTOR_INSTRUMENT_CAP` over `sector: { in: [...13] }`
        // ordered by `id` truncates by INSERTION ORDER, which has nothing to do
        // with sector. The sectors whose `_id`s sort last are returned
        // PARTIALLY, and the `slice(0, PEER_SAMPLE)` below then picks
        // "top 30 by mcap" from an arbitrary prefix of that sector rather than
        // from the sector — a real, plausible, wrong correlation with no signal
        // that anything was dropped. A sector truncated to zero disappears from
        // the chart entirely, via the `peerIds.length === 0` skip.
        //
        // The comment that justified the cap argued omission "makes the take
        // below non-load-bearing for correctness". That is inverted: omission is
        // what makes truncation INVISIBLE. And the margin was thin — this file's
        // own measurements put a single sector at ~380 NSE rows, so 13 sectors
        // against a 2,000-row cap is the marginal regime, not a comfortable one.
        //
        // Per-sector caps make starvation impossible: no sector can consume
        // another's budget, and PEER_SECTOR_CAP is far above PEER_SAMPLE so the
        // mcap ranking still sees plenty of candidates. The queries are indexed
        // on (exchange, sector, isActive) and run concurrently.
        const peerBySector = await withTimeout(
          Promise.all(
            peerSectors.map((sec) =>
              prisma.instrumentMapping.findMany({
                where: {
                  isActive: true,
                  instrumentType: "EQUITY",
                  // Same reason as the sector's own query above: without this a
                  // dual-listed company appears as BOTH its NSE and BSE row and
                  // is weighted twice in the peer return series.
                  exchange: "NSE",
                  sector: sec,
                },
                select: { id: true, sector: true },
                // Deterministic, so if a per-sector cap ever binds it is the
                // SAME rows every run rather than Mongo natural order silently
                // dropping different names each time.
                orderBy: { id: "asc" as const },
                take: PEER_SECTOR_CAP,
              })
            )
          ),
          QUERY_TIMEOUT_MS,
          "deep-dive peer instruments fetch"
        );
        const peerInst = peerBySector.flat();

        // Saturation is REPORTED, not silent. If a sector fills its cap the
        // mcap ranking below is drawn from a prefix of that sector, so the
        // sample is no longer "the largest 30" — the one thing a reader of the
        // chart would assume.
        const saturated = peerSectors.filter(
          (_, i) => peerBySector[i]!.length >= PEER_SECTOR_CAP
        );
        if (saturated.length > 0) {
          console.warn(
            `[sector-deep-dive] peer cap reached for ${saturated.join(", ")} ` +
              `(${PEER_SECTOR_CAP} rows) — their peer sample is drawn from an ` +
              `id-ordered prefix, not the whole sector. Raise PEER_SECTOR_CAP.`
          );
        }

        const peerMcaps = peerInst.length
          ? await withTimeout(
              prisma.latestQuote.findMany({
                where: { instrumentId: { in: peerInst.map((p) => p.id) } },
                select: { instrumentId: true, marketCap: true },
              }),
              QUERY_TIMEOUT_MS,
              "deep-dive peer quotes fetch"
            )
          : [];
        const mcapById = new Map(
          peerMcaps.map((q) => [q.instrumentId, q.marketCap ?? 0])
        );

        // Top PEER_SAMPLE per sector by mcap, then ONE daily-price query
        // across the union.
        const idsBySector = new Map<string, string[]>();
        for (const p of peerInst) {
          if (!p.sector) continue;
          const arr = idsBySector.get(p.sector) ?? [];
          arr.push(p.id);
          idsBySector.set(p.sector, arr);
        }
        for (const [sec, arr] of Array.from(idsBySector.entries())) {
          arr.sort((a, b) => (mcapById.get(b) ?? 0) - (mcapById.get(a) ?? 0));
          idsBySector.set(sec, arr.slice(0, PEER_SAMPLE));
        }
        const sampledIds = Array.from(idsBySector.values()).flat();

        const peerDaily = sampledIds.length
          ? await withTimeout(
              prisma.dailyPrice.findMany({
                where: {
                  instrumentId: { in: sampledIds },
                  date: { gte: ninetyDaysAgo },
                },
                select: { instrumentId: true, date: true, close: true },
                orderBy: { date: "asc" },
              }),
              QUERY_TIMEOUT_MS,
              "deep-dive peer daily-price fetch"
            )
          : [];
        const peerDailyByInst = new Map<
          string,
          Array<{ date: Date; close: number }>
        >();
        for (const r of peerDaily) {
          const arr = peerDailyByInst.get(r.instrumentId) ?? [];
          arr.push({ date: r.date, close: r.close });
          peerDailyByInst.set(r.instrumentId, arr);
        }

        // The self-anchor is pushed OUTSIDE this loop (below), because `sector`
        // is the raw DB bucket string and the loop only covers canonical names.
        // Every non-canonical passthrough bucket — prod carries Other (228),
        // Construction (40), Media & Entertainment (9), Agriculture (5) — used
        // to render a correlation chart with no 1.00 row, which is the same
        // defect the Real Estate fix removed, one bucket over.
        for (const peer of NIFTY_SECTORS) {
          if (peer === sector) continue;
          const peerIds = idsBySector.get(peer) ?? [];
          if (peerIds.length === 0) {
            // OMIT, never fabricate. Pushing `value: 0` claims the two sectors
            // are UNCORRELATED, which is a measurement — and it is the exact
            // fabricated-zero defect this file was fixed for ("Realty · 0.00").
            // A peer with no rows has no correlation to report.
            //
            // An earlier version of this comment went further and said omission
            // "makes the take non-load-bearing for correctness". That was
            // inverted, and it is worth stating why: omission is precisely what
            // makes truncation INVISIBLE. A capped query does not only zero a
            // sector out — it can return that sector PARTIALLY, and the mcap
            // ranking above then produces a real, plausible correlation computed
            // from an arbitrary subset. Silence about a dropped peer is honest;
            // silence about a half-sampled one is not. That is why the cap is
            // now per-sector and saturation is warned about, rather than being
            // reasoned away here.
            continue;
          }
          const peerDateMap = new Map<string, number>();
          const peerDateDen = new Map<string, number>();
          for (const instId of peerIds) {
            const rows = peerDailyByInst.get(instId);
            if (!rows || rows.length < 2) continue;
            const mcap = mcapById.get(instId) ?? 0;
            if (mcap <= 0) continue;
            const returns = pctReturns(rows);
            const dates = rows
              .slice(1)
              .map((d) => d.date.toISOString().slice(0, 10));
            for (let i = 0; i < returns.length; i++) {
              const key = dates[i]!;
              peerDateMap.set(
                key,
                (peerDateMap.get(key) ?? 0) + returns[i]! * mcap
              );
              peerDateDen.set(key, (peerDateDen.get(key) ?? 0) + mcap);
            }
          }
          const peerReturns = thisSectorDates.map((d) => {
            const num = peerDateMap.get(d);
            const den = peerDateDen.get(d);
            return num != null && den && den > 0 ? num / den : 0;
          });
          const value = correlationPair(thisSectorReturns, peerReturns);
          correlation.push({ peer, value: Number.isFinite(value) ? value : 0 });
        }
      }

      // Self-anchor, unconditionally and for ANY bucket name.
      if (!correlation.some((c) => c.peer === sector)) {
        correlation.push({ peer: sector, value: 1 });
      }
      correlation.sort((a, b) => b.value - a.value);

      // ── Institutional picks ── (MONEY-268, replacing MONEY-1215's absence)
      //
      // The two cards here used to be "TOP FII PICK" / "TOP DII PICK" and were
      // hidden, because nothing in the platform holds per-symbol FII/DII flow
      // and nothing NSE publishes could produce it:
      //
      //   - `InstitutionalFlow` (institutional_flows) IS the FII/DII feed, and
      //     its grain is `@@unique([date, category, segment])` — MARKET-WIDE,
      //     with no `symbol` column (verified on prod 2026-08-19: 8 rows, 4
      //     trading days × {FII,DII} × CASH). NSE's cash-flow file has no
      //     per-stock dimension to add, so this is not a table waiting to fill.
      //   - `MarketPositioning` is participant × derivative bucket. No symbol.
      //   - `StockShareholding.fii/dii` is a QUARTERLY STAKE PERCENT, not a
      //     ₹ flow, and on prod holds 12 rows for one symbol, all zeroes.
      //
      // The ticket's original model — sector flow × index weight — would have
      // multiplied a national aggregate by a weight and printed the product as
      // a per-stock fact. So the cards now answer a NARROWER question that the
      // data does support: which names in this sector saw the largest disclosed
      // bulk/block prints over the feed's last sessions, and on which side.
      // Every figure is arithmetic over exchange-reported prints; the FII/DII
      // chip is a separate, allowlist-only classification of the counterparty
      // name whose unmatched answer is "Institutional" (see
      // @usemoney/core/market-data/institutional-client-class).
      //
      // Soft-failing on purpose: the rest of this panel is real data and must
      // render even if the deals table is unreachable. `null` is distinct from
      // an empty window and the card says so.
      const picksResult = await withTimeout(
        getSectorInstitutionalPicks({ sector }),
        QUERY_TIMEOUT_MS,
        "deep-dive institutional picks fetch"
      ).catch((error: unknown) => {
        console.warn(
          `[sector-deep-dive] institutional picks failed for ${sector}: ` +
            (error instanceof Error ? error.message : String(error))
        );
        return null;
      });
      const institutionalPicks =
        picksResult && picksResult.success ? picksResult.data.data : null;

      // ── Results calendar ──
      // Scoped to a RESULTS SEASON, not the next 30 days (MONEY-1217). See
      // `loadResultsCalendar` for why the window changed and why zero-event
      // days never reach the payload.
      const earnings = await loadResultsCalendar(
        instruments,
        currentOrNextSeason(new Date())
      );

      return {
        name: sector,
        // `merged`, not `instruments`: the QUOTED constituents, i.e. exactly
        // the set every aggregate below is computed over. Reporting the raw
        // instrument row count instead would put a number on screen that no
        // figure beside it was derived from - the sector has ~290 NSE rows
        // but ~285 with a live quote, and only those carry an m-cap.
        count: merged.length,
        totalMcap,
        ytdPerf: sectorYtd,
        niftyYtdPerf: niftyYtd,
        weighted: {
          pe: { value: weightedPe, vsIndex: null },
          pb: { value: weightedPb, vs5yAvg: null },
          divYield: { value: weightedDy, vsNifty: null },
          beta: {
            value: weightedBeta,
            descriptor:
              weightedBeta == null
                ? "moderate"
                : weightedBeta < 0.85
                  ? "low"
                  : weightedBeta > 1.15
                    ? "high"
                    : "moderate",
          },
        },
        constituents,
        correlation,
        institutionalPicks,
        earnings,
      };
    },
  });

  // Attached synchronously (no `await` in between), so a rejection can never
  // surface as an unhandled one.
  const outcome: ResolveOutcome<SectorDeepDive> = await resolution.catch(
    (error: unknown): ResolveOutcome<SectorDeepDive> => {
      if (!(error instanceof SingleFlightTimeoutError)) {
        // Not the known backstop — a genuine programming error escaped the
        // cache helper. Contained (this action returns, it does not throw at
        // the client) but logged distinctly so it cannot read as a routine
        // 25s timeout.
        console.error(
          `getSectorDeepDiveAction (sector=${sector}) unexpected error ` +
            `escaped the cache helper: ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
      return { status: "failed", error };
    }
  );

  if (outcome.status === "failed") {
    // "No such sector" is a permanent answer, not a transient failure -
    // pass it through so the UI can say so precisely.
    if (outcome.error instanceof SectorNotFoundError) {
      return { success: false, error: outcome.error.message };
    }
    // Everything else is sanitized. The previous version returned
    // `error.message` verbatim, which put raw Prisma/Mongo text in front
    // of users; the detail belongs in the log, not the response.
    console.warn(
      `getSectorDeepDiveAction (sector=${sector}) failed: ` +
        (outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error))
    );
    // A 25s single-flight timeout is reported DISTINCTLY from a genuine
    // failure. Still a fixed constant — no driver text, no query, no stack —
    // so the sanitising rule above is intact; what changes is that the panel
    // can say "this was slow, try again" instead of implying a breakage.
    //
    // This is the common failure here, not an edge case: the heaviest sectors
    // spend ~half the 25s budget on DB time alone, and the same query has been
    // measured varying by several seconds run to run. See
    // ./sector-deep-dive-messages.ts for the numbers.
    if (outcome.error instanceof SingleFlightTimeoutError) {
      return { success: false, error: SECTOR_DEEP_DIVE_TIMEOUT_ERROR };
    }
    return { success: false, error: SECTOR_DEEP_DIVE_FAILED_ERROR };
  }

  if (outcome.status === "stale") {
    console.warn(
      `getSectorDeepDiveAction (sector=${sector}) serving last-good copy ` +
        `from ${new Date(outcome.computedAt).toISOString()}`
    );
    // Flag it. Serving an hours-old snapshot as though it were current is
    // the failure this whole mechanism exists to avoid.
    return {
      success: true,
      data: { ...outcome.data, stale: true, staleSince: outcome.computedAt },
    };
  }

  return { success: true, data: outcome.data };
}
