/**
 * Discover data-engine sections service — MONEY-1204 (P14 / 14d.2 · 14d.3 ·
 * 14d.5 · 14d.6).
 *
 * The read side of six data-engine tables that have shipped with NO product
 * reader at all:
 *
 *   14d.2  `InstitutionalFlow`   → FII/DII cash-flow widget (markets page)
 *          `MarketPositioning`   → participant positioning widget
 *          `MacroSeries`         → macro strip
 *   14d.3  `UpcomingIpo`         → /discover/ipo + the dashboard card
 *   14d.5  `NseCircular`         → /discover/circulars + the per-stock strip
 *   14d.6  `IndexConstituent` + `IndexMembership` + `IndexClose`
 *                                → /discover/indices/[slug]
 *
 * GLOBAL data — market/reference facts with no user scope — so, like
 * `discover-market.service` and `stock-sections-market.service`, there is no
 * `userId`, no demo branch and no `revalidatePath`. `apps/web`'s server actions
 * are thin wrappers over these functions rather than a second copy of the
 * logic, which is how "apps/api must not drift from the server actions" is
 * satisfied by construction instead of by review.
 *
 * Everything is returned inside `WithProvenance` (see `./provenance`). `empty`
 * is what the UI branches on; payloads that are OBJECTS rather than lists pass
 * an explicit `emptyOverride`, which is the documented exception.
 *
 * ## Query shapes, and why they are these shapes
 *
 * **`MarketPositioning` is queried WITH a `metric` filter, always.** The table
 * holds two feeds at incompatible grains: the participant files
 * (`metric: "OI" | "VOLUME"`, buckets `FUT_IDX`…) and `nse-fii-stats`
 * (`metric: "FII_STATS"`, buckets `IDX_FUT`… plus per-underlying breakdowns
 * like `IDX_OPT:NIFTY`). A read without the filter returns both, describing the
 * same FII on the same day in contract counts and in rupees; a sum over the
 * result double-counts every index. Nothing raises. The filter is also what
 * makes the read hit `@@index([participant, bucket, metric, date desc])`
 * end-to-end — so it is the fast shape and the correct one, and
 * `buildPositioningSection` re-checks it anyway.
 *
 * **`IndexConstituent` is read BY `indexId`.** That model has `@@index([indexId])`
 * and `@@index([indexId, rank])` and NO `[symbol]` index, so this route's
 * by-index read is index-served and cheap. The inverse — a symbol-first read —
 * is a collection scan and belongs on `IndexMembership`, which does have
 * `@@index([symbol])`. The two are not interchangeable and the direction of the
 * question decides which is correct.
 *
 * **`IndexClose` and `IndexConstituent` use DIFFERENT key vocabularies.**
 * `indexSlug` is derived from NSE's display name ("nifty-50"); `indexId` is the
 * older id ("nifty50", and "banknifty" where NSE says "niftybank"). They are
 * resolved once by `resolveIndexRoute` and never conflated.
 *
 * ## Absence discipline
 *
 * Missing rows are `success: true` with an empty envelope — never an error,
 * never a 404. `""` / `"-"` / blank ⇒ null, never 0, at the query boundary and
 * at the render boundary both. Empty results are NOT cached: a cached "nothing
 * here" is the fail-open default the standing rule forbids, and the queries it
 * would save are single bounded index lookups.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core/cache";
import { getNseMarketStatus } from "@usemoney/core/market-data/market-hours";
import {
  buildCircularFeed,
  buildIndexConstituents,
  buildIndexDetail,
  buildIndexMembership,
  buildInstitutionalFlowSection,
  buildIpoDashboardCard,
  buildMacroStrip,
  buildPositioningSection,
  bucketIpos,
  countCircularDepartments,
  matchCircularsForSymbol,
  resolveIndexRoute,
  shiftDayKey,
  istDayKey,
  CIRCULAR_MATCH_DISCLAIMER,
  MACRO_STRIP_SERIES_IDS,
  PARTICIPANT_METRICS,
  POSITIONING_PARTICIPANT_ORDER,
  type CircularSymbolMatch,
  type CircularView,
  type IndexConstituentSection,
  type IndexDetailSection,
  type IndexMembershipSection,
  type InstitutionalFlowSection,
  type IpoDashboardCard,
  type IpoSections,
  type MacroStrip,
  type ParticipantMetric,
  type PositioningSection,
  type ResolvedIndexRoute,
} from "@usemoney/core/market-data";
import type { ServiceResult } from "./types";
import { withProvenance, type WithProvenance } from "./provenance";

// Same cache module + scope every global discover read uses. One namespace to
// invalidate.
const CACHE_NS = "discover" as const;
const CACHE_SCOPE = "_global" as const;

// ── Provenance sources ───────────────────────────────────────────────────────
// Stored verbatim in the vocabulary the DB uses, decoded at the render boundary
// (`sourceLabel` in SectionShell), same rule `StockFlag` follows.
const SRC_FLOWS = "NSE_FII_DII_CASH";
const SRC_POSITIONING = "nse-fao-participant";
const SRC_MACRO = "RBI_MOSPI_OEA";
const SRC_IPO = "NSE_IPO";
const SRC_CIRCULARS = "NSE_CIRCULARS";
const SRC_INDEX = "NSE_INDICES";

// ── Bounds ───────────────────────────────────────────────────────────────────

/** Sessions of flow history fetched. 20-session cumulative + slack for holes. */
const FLOW_SESSIONS = 60;
/** Positioning days fetched: latest + the previous session, plus slack. */
const POSITIONING_DAYS_ROWS = 200;
/** Macro rows per series: enough to reach 12 months back for a YoY. */
const MACRO_ROWS = 400;
/** IPO rows fetched — the whole live universe is small. */
const IPO_ROWS = 400;
/** Circulars per page. */
const CIRCULARS_PAGE = 50;
/** Circulars scanned for the per-stock heuristic strip. */
const CIRCULAR_MATCH_SCAN = 500;
/** Sessions of index closes for the detail sparkline. */
const INDEX_CLOSE_SESSIONS = 180;
/** Membership stints fetched for the change log. */
const MEMBERSHIP_ROWS = 400;

// ── Deps seam ────────────────────────────────────────────────────────────────

/**
 * Injectable collaborators, same seam as `StockSectionsMarketDeps`.
 *
 * `@usemoney/services` runs its suite as ESM with no module mocking, so the
 * only way to assert the real code path's query shape, cache key and TTL is to
 * hand it fakes. Not a plugin system.
 */
export interface DiscoverSectionsDeps {
  prisma?: typeof prisma;
  getCached?: typeof getCached;
  setCached?: typeof setCached;
  getNseMarketStatus?: () => { isLive: boolean };
  /** Injected clock. The IST day boundary is the whole point of 14d.3. */
  now?: () => Date;
}

interface ResolvedDeps {
  db: typeof prisma;
  readCache: typeof getCached;
  writeCache: typeof setCached;
  ttl: (live: number, closed: number) => number;
  now: () => Date;
}

function resolve(deps: DiscoverSectionsDeps): ResolvedDeps {
  const marketStatus = deps.getNseMarketStatus ?? getNseMarketStatus;
  return {
    db: deps.prisma ?? prisma,
    readCache: deps.getCached ?? getCached,
    writeCache: deps.setCached ?? setCached,
    ttl: (live, closed) => (marketStatus().isLive ? live : closed),
    now: deps.now ?? (() => new Date()),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 14d.2 (a) — FII/DII cash flows
// ════════════════════════════════════════════════════════════════════════════

export interface InstitutionalFlowsData extends InstitutionalFlowSection {}

/**
 * FII/DII daily net + trailing cumulative, ₹ crore.
 *
 * Fetched by (category, date desc) so the read uses
 * `@@index([category, date(sort: Desc)])`, then reversed in the builder. The
 * fetch is bounded by SESSIONS, not by a date range: asking for "the last 30
 * calendar days" returns however many trading days happen to fall in it, which
 * is 20 in a normal month and 15 across Diwali — so the cumulative would
 * quietly change length with the holiday calendar.
 */
export async function getInstitutionalFlows(
  args: { windowSessions?: number; segment?: string } = {},
  deps: DiscoverSectionsDeps = {},
): Promise<ServiceResult<WithProvenance<InstitutionalFlowsData>>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const windowSessions = Math.min(120, Math.max(1, args.windowSessions ?? 20));
  const segment = (args.segment ?? "CASH").toUpperCase();
  const cacheKey = `discover-flows:${segment}:${windowSessions}`;

  const cached = await readCache<WithProvenance<InstitutionalFlowsData>>(
    CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // One bounded read per category, each on the (category, date desc) index.
    // A single `category: { in: [...] }` read cannot use that index's leading
    // equality and would have to take 2N rows and hope both categories are
    // represented — a quiet DII outage would silently shorten the FII window.
    const take = Math.max(FLOW_SESSIONS, windowSessions * 2);
    const page = (category: string) =>
      db.institutionalFlow.findMany({
        where: { category, segment },
        orderBy: { date: "desc" as const },
        take,
        select: {
          date: true,
          category: true,
          segment: true,
          buyValue: true,
          sellValue: true,
          netValue: true,
        },
      });
    const [fii, dii] = await Promise.all([page("FII"), page("DII")]);

    const section = buildInstitutionalFlowSection([...fii, ...dii], {
      windowSessions,
    });
    const envelope = withProvenance(section, {
      source: SRC_FLOWS,
      asOf: section.asOf,
      note: "Values in ₹ crore, as published by NSE.",
      emptyOverride: section.series.length === 0,
    });

    if (!envelope.empty) {
      await writeCache(CACHE_NS, CACHE_SCOPE, cacheKey, envelope, undefined, {
        ttl: ttl(15 * 60, 6 * 60 * 60),
      });
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getInstitutionalFlows error:", error);
    return { success: false, error: "Failed to load institutional flows" };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 14d.2 (b) — participant positioning
// ════════════════════════════════════════════════════════════════════════════

export interface MarketPositioningData extends PositioningSection {
  /** The participants the toggle may offer. */
  participants: readonly string[];
}

/**
 * One participant's derivative legs on the latest published day.
 *
 * THE METRIC FILTER IS NOT OPTIONAL. `MarketPositioning` also holds
 * `nse-fii-stats` rows (`metric: "FII_STATS"`) for the SAME participant on the
 * SAME days, in a different bucket namespace and carrying rupee values the
 * participant feed does not have — plus per-underlying breakdowns of its own
 * totals. Querying without `metric` mixes contract counts with rupees and
 * totals with their children; a chart or a sum over that result is wrong by
 * roughly a factor of two and looks entirely plausible. The `where` below pins
 * it, and `buildPositioningSection` refuses to render a mixed set even if a
 * future caller drops the filter.
 *
 * The day window is a bounded row fetch on
 * `@@index([participant, bucket, metric, date desc])`, taking enough rows to
 * cover the latest session AND the previous one for the day-on-day change.
 */
export async function getMarketPositioning(
  args: { participant?: string; metric?: ParticipantMetric } = {},
  deps: DiscoverSectionsDeps = {},
): Promise<ServiceResult<WithProvenance<MarketPositioningData>>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const participant = (args.participant ?? "FII").toUpperCase();
  const metric: ParticipantMetric = PARTICIPANT_METRICS.includes(
    args.metric as ParticipantMetric,
  )
    ? (args.metric as ParticipantMetric)
    : "OI";
  const cacheKey = `discover-positioning:${participant}:${metric}`;

  const cached = await readCache<WithProvenance<MarketPositioningData>>(
    CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const rows = await db.marketPositioning.findMany({
      // `metric` here is load-bearing, not a narrowing convenience — see above.
      where: { participant, metric },
      orderBy: { date: "desc" },
      take: POSITIONING_DAYS_ROWS,
      select: {
        date: true,
        participant: true,
        bucket: true,
        metric: true,
        longQty: true,
        shortQty: true,
        netQty: true,
      },
    });

    const section = buildPositioningSection(rows, { participant, metric });
    const data: MarketPositioningData = {
      ...section,
      participants: POSITIONING_PARTICIPANT_ORDER,
    };
    const envelope = withProvenance(data, {
      source: `${SRC_POSITIONING}-${metric.toLowerCase()}`,
      asOf: section.date,
      note:
        metric === "OI"
          ? "Contracts held open at end of day. NSE publishes counts, not notional."
          : "Contracts traded during the day. Not comparable with open interest.",
      emptyOverride: section.legs.length === 0,
    });

    if (!envelope.empty) {
      await writeCache(CACHE_NS, CACHE_SCOPE, cacheKey, envelope, undefined, {
        ttl: ttl(30 * 60, 6 * 60 * 60),
      });
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getMarketPositioning error:", error);
    return { success: false, error: "Failed to load participant positioning" };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 14d.2 (c) — macro strip
// ════════════════════════════════════════════════════════════════════════════

export interface MacroStripData extends MacroStrip {}

/**
 * Repo rate, CPI YoY, WPI YoY, forex reserves.
 *
 * Each tile carries its OWN period, and the envelope's `asOf` is the newest
 * across them ONLY so the shell has something to stamp — the component must
 * render the per-tile dates. Different series have genuinely different
 * vintages: the repo rate is days old, CPI is weeks old by the time MOSPI
 * prints it. One shared "as of" over the strip presents the stale as fresh
 * every single day.
 *
 * Reads on `@@index([seriesId, period(sort: Desc)])`, one bounded page per
 * series — enough rows to reach the observation twelve months back, which is
 * what a YoY needs and a single "latest row" read cannot supply.
 */
export async function getMacroStrip(
  args: { seriesIds?: readonly string[] } = {},
  deps: DiscoverSectionsDeps = {},
): Promise<ServiceResult<WithProvenance<MacroStripData>>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const seriesIds =
    args.seriesIds && args.seriesIds.length > 0
      ? args.seriesIds
      : MACRO_STRIP_SERIES_IDS;
  const cacheKey = `discover-macro:${[...seriesIds].sort().join(",")}`;

  const cached = await readCache<WithProvenance<MacroStripData>>(
    CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const rows = await db.macroSeries.findMany({
      where: { seriesId: { in: [...seriesIds] } },
      orderBy: { period: "desc" },
      take: MACRO_ROWS,
      select: {
        seriesId: true,
        period: true,
        value: true,
        unit: true,
        frequency: true,
        label: true,
        releasedOn: true,
      },
    });

    const strip = buildMacroStrip(rows);
    const hasAny = strip.items.some((i) => i.value !== null);
    const envelope = withProvenance(strip, {
      source: SRC_MACRO,
      asOf: strip.newestPeriod,
      note: "Each series has its own vintage — see the date on each tile.",
      emptyOverride: !hasAny,
    });

    if (!envelope.empty) {
      // Macro moves weekly at best; the market clock is irrelevant to it, so
      // both arms are the same and long.
      await writeCache(CACHE_NS, CACHE_SCOPE, cacheKey, envelope, undefined, {
        ttl: ttl(6 * 60 * 60, 6 * 60 * 60),
      });
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getMacroStrip error:", error);
    return { success: false, error: "Failed to load macro indicators" };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 14d.3 — IPO
// ════════════════════════════════════════════════════════════════════════════

export interface IpoSectionsData extends IpoSections {}

/**
 * Upcoming / current / recently-listed IPOs, bucketed on the IST calendar day.
 *
 * "Today" is resolved ONCE, here, from an injectable clock, and handed to the
 * pure bucketer as an IST day key. Two consequences, both deliberate: the
 * classification cannot drift between rows if a request straddles midnight, and
 * the boundary is testable at both ends without freezing a global clock.
 *
 * The DB filter is deliberately WIDE (a date floor, nothing else) and the
 * phase decision is made in the pure layer. Pushing "currently bidding" into
 * the `where` means writing `issueEnd >= new Date()`, which is the exact
 * instant-vs-IST-day bug this ticket exists to avoid — it drops an issue at
 * 05:30 IST on its own closing day.
 */
export async function getIpoSections(
  args: { recentDays?: number } = {},
  deps: DiscoverSectionsDeps = {},
): Promise<ServiceResult<WithProvenance<IpoSectionsData>>> {
  const { db, readCache, writeCache, ttl, now } = resolve(deps);
  const recentDays = Math.min(365, Math.max(1, args.recentDays ?? 30));
  const today = now();
  const todayKey = istDayKey(today) ?? new Date().toISOString().slice(0, 10);
  // Cache key carries the IST DAY, so the bucketing rolls over with IST rather
  // than living in Redis across the boundary it was computed on.
  const cacheKey = `discover-ipo:${todayKey}:${recentDays}`;

  const cached = await readCache<WithProvenance<IpoSectionsData>>(
    CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // Floor is generous: an issue that opened long ago may still be listing.
    const floor = new Date(
      `${shiftDayKey(todayKey, -(recentDays + 120))}T00:00:00.000Z`,
    );
    const rows = await db.upcomingIpo.findMany({
      where: {
        OR: [
          { issueStart: { gte: floor } },
          // MONEY-1236 — measured on prod 2026-08-21: UpcomingIpo total=1,423,
          // absent=0, null=0, set=1,423. The only writer,
          // workers/src/processors/ipo-sync.ts, SKIPS any issue with no
          // `issueStart` (`skippedNoStartDate`) because `issueStart` is half of
          // `@@unique([symbol, issueStart])` — a row without it cannot be keyed
          // and so cannot exist. This arm is a defensive no-op, not a source of
          // dropped rows.
          // prisma-null-ok: the upsert key forbids the row (0 absent of 1,423)
          { issueStart: null },
          { listingDate: { gte: floor } },
        ],
      },
      orderBy: { issueStart: "desc" },
      take: IPO_ROWS,
      select: {
        symbol: true,
        companyName: true,
        series: true,
        isSme: true,
        issueStart: true,
        issueEnd: true,
        listingDate: true,
        priceMin: true,
        priceMax: true,
        issueSize: true,
        lotSize: true,
        status: true,
      },
    });

    const sections = bucketIpos(rows, { today, recentDays });
    const total =
      sections.upcoming.length +
      sections.current.length +
      sections.recent.length +
      sections.unplaced.length;
    const envelope = withProvenance(sections, {
      source: SRC_IPO,
      asOf: sections.today,
      emptyOverride: total === 0,
    });

    if (!envelope.empty) {
      // Short TTL while a window is open — a band revision or an extension is
      // the kind of change a user acts on the same day.
      await writeCache(CACHE_NS, CACHE_SCOPE, cacheKey, envelope, undefined, {
        ttl: ttl(10 * 60, 60 * 60),
      });
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getIpoSections error:", error);
    return { success: false, error: "Failed to load IPO calendar" };
  }
}

export interface IpoDashboardData extends IpoDashboardCard {}

/**
 * The dashboard card — open windows and what closes today.
 *
 * Built on top of {@link getIpoSections} rather than beside it, so the
 * dashboard and the IPO page can never disagree about which issues are open.
 * Returns `empty: true` when nothing is open and nothing is forthcoming, which
 * is the dashboard's signal to render nothing at all.
 */
export async function getIpoDashboardCard(
  args: { limit?: number } = {},
  deps: DiscoverSectionsDeps = {},
): Promise<ServiceResult<WithProvenance<IpoDashboardData>>> {
  const res = await getIpoSections({}, deps);
  if (!res.success) return res;
  const card = buildIpoDashboardCard(res.data.data, args);
  return {
    success: true,
    data: withProvenance(card, {
      source: SRC_IPO,
      asOf: res.data.asOf,
      emptyOverride: card.empty,
    }),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 14d.5 — circulars
// ════════════════════════════════════════════════════════════════════════════

export interface CircularFeedData {
  circulars: CircularView[];
  /** Departments present in the fetched page, with counts, for the chips. */
  departments: Array<{ department: string; count: number }>;
  /** True when another page exists. Cursor is the caller's `skip` + page size. */
  hasMore: boolean;
}

/**
 * Circular feed, optionally filtered by department.
 *
 * Reads on `@@index([department, circularDate(sort: Desc)])` when a department
 * is given and `@@index([circularDate(sort: Desc)])` otherwise.
 *
 * Rows are keyed on `(circularNumber, department)` — the model's own unique —
 * NOT on `circularNumber`, which is not unique: NSE re-issues one circular
 * under every department it applies to (205 distinct numbers across 237 records
 * in one measured window). Deduping on the number alone silently discards half
 * of every re-issue and the survivor looks entirely normal.
 */
export async function getCircularFeed(
  args: {
    department?: string;
    topic?: string;
    limit?: number;
    skip?: number;
  } = {},
  deps: DiscoverSectionsDeps = {},
): Promise<ServiceResult<WithProvenance<CircularFeedData>>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const limit = Math.min(200, Math.max(1, args.limit ?? CIRCULARS_PAGE));
  const skip = Math.max(0, args.skip ?? 0);
  const department = args.department?.trim() || null;
  const topic = args.topic?.trim().toUpperCase() || null;
  const cacheKey = `discover-circulars:${department ?? "*"}:${topic ?? "*"}:${limit}:${skip}`;

  const cached = await readCache<WithProvenance<CircularFeedData>>(
    CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const rows = await db.nseCircular.findMany({
      where: {
        ...(department ? { department } : {}),
        ...(topic ? { topic } : {}),
      },
      orderBy: { circularDate: "desc" },
      skip,
      // One extra row is the hasMore probe — cheaper and more honest than a
      // count() over a table that grows every trading day.
      take: limit + 1,
      select: {
        circularNumber: true,
        displayNumber: true,
        department: true,
        category: true,
        subject: true,
        company: true,
        circularDate: true,
        topic: true,
        fileUrl: true,
        fileName: true,
        approxSizeBytes: true,
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const circulars = buildCircularFeed(page);
    const data: CircularFeedData = {
      circulars,
      departments: countCircularDepartments(page),
      hasMore,
    };
    const envelope = withProvenance(data, {
      source: SRC_CIRCULARS,
      asOf: circulars[0]?.date ?? null,
      emptyOverride: circulars.length === 0,
    });

    if (!envelope.empty) {
      await writeCache(CACHE_NS, CACHE_SCOPE, cacheKey, envelope, undefined, {
        ttl: ttl(30 * 60, 2 * 60 * 60),
      });
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getCircularFeed error:", error);
    return { success: false, error: "Failed to load exchange circulars" };
  }
}

export interface SymbolCircularsData {
  matches: CircularSymbolMatch[];
  /** The label the UI MUST render. Shipped in the payload so it cannot be forgotten. */
  disclaimer: string;
}

/**
 * Circulars that MENTION a symbol — a heuristic strip for the stock page.
 *
 * NOT an exchange-provided link. It is a token match on the symbol in the
 * circular's `company` column (higher confidence) or its subject line (lower),
 * and it therefore has real false positives: a ticker that is also an ordinary
 * English word matches when the word is used in its ordinary sense. The
 * disclaimer travels in the payload rather than being left to the component,
 * because "we forgot the caveat on one surface" is the failure that turns a
 * useful hint into a false claim about a specific security.
 *
 * Departments default to Surveillance — the ones a retail holder acts on
 * (ASM/GSM/ESM moves, price bands) — because scanning every department turns a
 * strip into a firehose in which the surveillance notice is invisible.
 */
export async function getCircularsForSymbol(
  args: {
    symbol: string;
    departments?: readonly string[];
    limit?: number;
    days?: number;
  },
  deps: DiscoverSectionsDeps = {},
): Promise<ServiceResult<WithProvenance<SymbolCircularsData>>> {
  const { db, readCache, writeCache, ttl, now } = resolve(deps);
  const symbol = String(args.symbol ?? "")
    .trim()
    .toUpperCase();
  if (symbol === "") {
    return {
      success: true,
      data: withProvenance(
        { matches: [], disclaimer: CIRCULAR_MATCH_DISCLAIMER },
        { source: SRC_CIRCULARS, emptyOverride: true },
      ),
    };
  }
  const departments = args.departments ?? ["Surveillance"];
  const limit = Math.min(50, Math.max(1, args.limit ?? 10));
  const days = Math.min(365, Math.max(1, args.days ?? 180));
  const cacheKey = `discover-circulars-symbol:${symbol}:${departments.join("|")}:${limit}:${days}`;

  const cached = await readCache<WithProvenance<SymbolCircularsData>>(
    CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const todayKey = istDayKey(now()) ?? new Date().toISOString().slice(0, 10);
    const since = new Date(`${shiftDayKey(todayKey, -days)}T00:00:00.000Z`);
    const rows = await db.nseCircular.findMany({
      // Department + date, which is exactly
      // `@@index([department, circularDate(sort: Desc)])`. The symbol match is
      // a substring question over free text and cannot be an index predicate —
      // scoping by department and recency is what keeps the scanned set small.
      where: {
        department: { in: [...departments] },
        circularDate: { gte: since },
      },
      orderBy: { circularDate: "desc" },
      take: CIRCULAR_MATCH_SCAN,
      select: {
        circularNumber: true,
        displayNumber: true,
        department: true,
        category: true,
        subject: true,
        company: true,
        circularDate: true,
        topic: true,
        fileUrl: true,
        fileName: true,
        approxSizeBytes: true,
      },
    });

    const matches = matchCircularsForSymbol(rows, symbol, {
      departments,
      limit,
    });
    const data: SymbolCircularsData = {
      matches,
      disclaimer: CIRCULAR_MATCH_DISCLAIMER,
    };
    const envelope = withProvenance(data, {
      source: SRC_CIRCULARS,
      asOf: matches[0]?.circular.date ?? null,
      note: CIRCULAR_MATCH_DISCLAIMER,
      emptyOverride: matches.length === 0,
    });

    if (!envelope.empty) {
      await writeCache(CACHE_NS, CACHE_SCOPE, cacheKey, envelope, undefined, {
        ttl: ttl(60 * 60, 6 * 60 * 60),
      });
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getCircularsForSymbol error:", error);
    return { success: false, error: "Failed to load circulars for this stock" };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 14d.6 — index detail
// ════════════════════════════════════════════════════════════════════════════

export interface IndexDetailData {
  route: ResolvedIndexRoute;
  detail: IndexDetailSection;
  constituents: IndexConstituentSection;
  membership: IndexMembershipSection;
}

/**
 * Everything the index-detail route renders, in one call.
 *
 * FOUR reads, three key vocabularies, resolved once:
 *
 *   `IndexClose`        keyed on `indexSlug` ("nifty-50")
 *   `IndexConstituent`  keyed on `indexId`   ("nifty50" / "banknifty")
 *   `IndexMembership`   keyed on `indexId`
 *
 * When `indexId` is null the index is one of the ~90 that publish closes and no
 * constituent list. That is the NORMAL case, not an error: the page renders the
 * price and valuation blocks and the constituents section shows its empty
 * state. Returning a 404 for a perfectly good index would be wrong.
 *
 * `IndexConstituent` is read BY INDEX here, which is what its `@@index([indexId])`
 * and `@@index([indexId, rank])` serve. The inverse question ("which indices is
 * this symbol in") must NOT use this model — it has no `[symbol]` index — and
 * belongs on `IndexMembership`, which does.
 */
export async function getIndexDetail(
  args: { slug: string; sessions?: number },
  deps: DiscoverSectionsDeps = {},
): Promise<ServiceResult<WithProvenance<IndexDetailData>>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const route = resolveIndexRoute(args.slug);
  if (route.indexSlug === "") {
    return { success: false, error: "Unknown index" };
  }
  const sessions = Math.min(
    750,
    Math.max(2, args.sessions ?? INDEX_CLOSE_SESSIONS),
  );
  const cacheKey = `discover-index:${route.indexSlug}:${sessions}`;

  const cached = await readCache<WithProvenance<IndexDetailData>>(
    CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const [closes, constituents, memberships] = await Promise.all([
      db.indexClose.findMany({
        where: { indexSlug: route.indexSlug },
        orderBy: { date: "desc" },
        take: sessions,
        select: {
          date: true,
          name: true,
          open: true,
          high: true,
          low: true,
          close: true,
          prevClose: true,
          pe: true,
          pb: true,
          divYield: true,
          volume: true,
          turnoverCr: true,
        },
      }),
      route.indexId === null
        ? Promise.resolve([])
        : db.indexConstituent.findMany({
            where: { indexId: route.indexId },
            orderBy: { rank: "asc" },
            select: {
              symbol: true,
              weightBps: true,
              rank: true,
              lastSyncedAt: true,
            },
          }),
      route.indexId === null
        ? Promise.resolve([])
        : db.indexMembership.findMany({
            where: { indexId: route.indexId },
            orderBy: { firstSeen: "desc" },
            take: MEMBERSHIP_ROWS,
            select: {
              symbol: true,
              firstSeen: true,
              lastSeen: true,
              addedOn: true,
              removedOn: true,
            },
          }),
    ]);

    const data: IndexDetailData = {
      route,
      detail: buildIndexDetail(closes, { label: route.label }),
      constituents: buildIndexConstituents(constituents),
      membership: buildIndexMembership(memberships),
    };
    const envelope = withProvenance(data, {
      source: SRC_INDEX,
      asOf: data.detail.date,
      note: route.known
        ? undefined
        : "Constituent list not tracked for this index — price history only.",
      emptyOverride:
        data.detail.date === null && data.constituents.rows.length === 0,
    });

    if (!envelope.empty) {
      await writeCache(CACHE_NS, CACHE_SCOPE, cacheKey, envelope, undefined, {
        ttl: ttl(15 * 60, 6 * 60 * 60),
      });
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getIndexDetail error:", error);
    return { success: false, error: "Failed to load index details" };
  }
}
