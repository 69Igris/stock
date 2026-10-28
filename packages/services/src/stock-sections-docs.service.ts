/**
 * Stock-page DOCUMENT sections service — MONEY-1204 (P14 / 14c.7, 14c.8, 14c.9).
 *
 * Three read-only, GLOBAL (no userId) stock-page sections backed by the data
 * engine's own tables:
 *
 *   14c.7  filings & documents timeline  `stock_documents` + `upcoming_events`
 *   14c.8  financials source badge       `stock_financials.source`
 *          + basis / cumulative toggle   `xbrl_filings`
 *   14c.9  funds holding this stock      `mf_portfolio_holdings` (INVERSE read)
 *
 * Lives in `@usemoney/services` — not in the web action — so the server action
 * and its `apps/api` `/v1/stocks/:symbol/*` mirror run the SAME code rather than
 * two copies that drift. The web action is a `"use server"` wrapper over these
 * functions; `mountStockSection` in apps/api calls them directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Five decisions that are easy to get wrong here
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **1. `textContent` is NEVER selected.** `StockDocument.textContent` holds up
 * to ~100KB of extracted text per row. A timeline read of 120 documents that
 * includes it moves ~12MB out of Mongo, through Prisma, across the server/client
 * boundary — for a column no list renders. Every `select` below is explicit for
 * exactly this reason; a `findMany` without one would pull it by default.
 *
 * **2. A document that is not `READY` is still shown.** `processingStatus`
 * describes OUR extraction job, not the filing. Filtering `PENDING`/`FAILED`
 * out would hide real published filings behind an internal job's state and make
 * a stalled extractor look like a quiet company. The gate is on `readable`, the
 * affordance — not on presence.
 *
 * **3. `UpcomingEvent.symbol` is filtered EXPLICITLY.** It is nullable: macro
 * rows (RBI policy, US CPI) carry no symbol. A `where` that omits it, or a
 * null-tolerant match, pins one RBI date onto every stock page on the platform.
 * The model also has NO unique constraint (the writer is delete-then-createMany
 * across two feeds), so the reader dedupes.
 *
 * **4. The reads are keyed on `symbol` ALONE, never on the page's exchange.**
 * `xbrl_filings` and `stock_documents` both carry an exchange defaulting to NSE
 * and are populated from NSE/BSE announcement feeds; `mf_portfolio_holdings`
 * has no exchange at all. Adding `exchange: args.exchange` returns ZERO rows on
 * a BSE view of a dual-listed company — an empty panel indistinguishable from
 * "nothing has been published", which is the silent-zero failure this subsystem
 * keeps re-learning (MONEY-1169). Filings and fund ownership are company-level
 * facts. The de-duplication that this makes necessary happens in the pure layer.
 *
 * **5. `mf_portfolio_holdings` has NO `symbol` column.** The inverse lookup goes
 * through `isin` (`@@index([isin, period(sort: Desc)])`) with an `instrumentId`
 * fallback (`@@index([instrumentId, period(sort: Desc)])`), both of which are
 * nullable by design. Rows resolving to neither are counted in the payload
 * rather than dropped.
 *
 * Nothing empty and nothing failed is ever cached — caching "couldn't determine"
 * pins the failure for the TTL and makes the next request lie about it. A miss
 * costs one query.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core/cache";
import { getNseMarketStatus } from "@usemoney/core/market-data/market-hours";
import {
  buildFilingDrilldown,
  buildFilingsTimeline,
  buildFundsHoldingSection,
  selectFilings,
  summarizeFinancialsSource,
  DEFAULT_FINANCIALS_BASIS,
  FINANCIALS_BASES,
  type FilingBasisAvailability,
  type FilingPeriodView,
  type FilingsTimeline,
  type FinancialsBasis,
  type FinancialsSourceSummary,
  type FundsHoldingSection,
  type StockFundHoldingRow,
  type StockDocumentRow,
  type UpcomingEventRow,
  type XbrlFilingRow,
} from "@usemoney/core/market-data";
import { withProvenance, type WithProvenance } from "./provenance";
import type { ServiceResult } from "./types";

// ── Cache policy ─────────────────────────────────────────────────────────────
//
// Same module/scope as every other stock-page read (`discover` / `_global`), so
// the existing invalidation and metrics cover these too.
const SECTIONS_CACHE_NS = "discover" as const;
const CACHE_SCOPE = "_global" as const;

/**
 * Documents land nightly (`nse-announcements-sync` 21:15 IST, then the extract
 * chain at 22:00), and the pinned event's "in N days" is day-granular, so an
 * hour is the longest TTL that cannot show a wrong day count.
 */
const FILINGS_TTL_LIVE_S = 30 * 60;
const FILINGS_TTL_CLOSED_S = 60 * 60;
/** Financials and filings are quarterly. Nothing is gained from a short TTL. */
const FINANCIALS_SOURCE_TTL_S = 6 * 60 * 60;
/** Portfolio disclosures are MONTHLY. */
const FUNDS_TTL_S = 6 * 60 * 60;

/** Documents pulled before the display cap. */
const DOCS_READ_LIMIT = 200;
const DOCS_DISPLAY_LIMIT = 120;
/** Upcoming events pulled for the pin. Bounded by the `[symbol, date]` index. */
const EVENTS_READ_LIMIT = 20;
/** `stock_financials` rows scanned for the badge (3 statements × ~40 periods). */
const FINANCIALS_READ_LIMIT = 200;
/** Filings pulled for the drill-down: ~5 years × 4 quarters × 2 bases × 2. */
const FILINGS_READ_LIMIT = 160;
/** Periods kept per (basis, cumulative) bucket. */
const FILING_PERIODS_PER_VIEW = 20;
/**
 * Holding rows pulled PER disclosure month — never shared across the two.
 *
 * A single cap over both months is not a smaller version of the same read: with
 * `period: "desc"` leading the sort, the whole newest month lands first and the
 * cap falls INSIDE the prior month, so every scheme whose prior-month row was
 * cut off reads as a fund that just entered the stock. One Nifty-500 index fund
 * discloses ~500 rows a month, so a widely-held name crosses 800 across two
 * months today.
 */
const FUND_ROWS_PER_PERIOD = 800;
/** Funds listed before "and N more". */
const FUNDS_DISPLAY_LIMIT = 50;

// ── IO seam ──────────────────────────────────────────────────────────────────

/**
 * Injectable collaborators. Defaults are the shared prisma client, the two-tier
 * cache wrapper and the pure NSE market-phase detector; `now` is injectable so
 * the "next upcoming event" window is pinned by the test rather than raced
 * against the wall clock.
 */
export interface StockSectionsDocsDeps {
  prisma?: typeof prisma;
  getCached?: typeof getCached;
  setCached?: typeof setCached;
  getNseMarketStatus?: () => { isLive: boolean };
  now?: () => Date;
}

interface ResolvedDeps {
  db: typeof prisma;
  readCache: typeof getCached;
  writeCache: typeof setCached;
  ttl: (live: number, closed: number) => number;
  now: () => Date;
}

function resolve(deps: StockSectionsDocsDeps): ResolvedDeps {
  const marketStatus = deps.getNseMarketStatus ?? getNseMarketStatus;
  return {
    db: deps.prisma ?? prisma,
    readCache: deps.getCached ?? getCached,
    writeCache: deps.setCached ?? setCached,
    ttl: (live, closed) => (marketStatus().isLive ? live : closed),
    now: deps.now ?? (() => new Date()),
  };
}

/** Most frequent non-empty value, ties broken alphabetically for determinism. */
function dominant(values: ReadonlyArray<string | null | undefined>): {
  value: string | null;
  distinct: number;
} {
  const tally = new Map<string, number>();
  for (const v of values) {
    const s = (v ?? "").trim();
    if (s === "") continue;
    tally.set(s, (tally.get(s) ?? 0) + 1);
  }
  const ranked = [...tally.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  return { value: ranked[0]?.[0] ?? null, distinct: ranked.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.7 — filings & documents timeline
// ═══════════════════════════════════════════════════════════════════════════

export type StockFilingsTimelineData = FilingsTimeline;

/**
 * The filings timeline: the next scheduled event pinned above the documents we
 * have indexed for this company, newest-indexed first.
 *
 * "Newest-indexed", not "newest-filed", and the payload says so. `StockDocument`
 * has NO filing-date column — `period` is free-form (`"nse-{seq_id}"` for
 * announcements, `"2024"` for annual reports) and every writer sets `fetchedAt`
 * to `new Date()` at ingest. Presenting ingest time as a filing date would sort
 * a 2019 annual report to the top the day a backfill runs.
 */
export async function getStockFilingsTimeline(
  args: { symbol: string; exchange: string },
  deps: StockSectionsDocsDeps = {},
): Promise<ServiceResult<WithProvenance<StockFilingsTimelineData>>> {
  const { db, readCache, writeCache, ttl, now } = resolve(deps);
  const cacheKey = `stock-filings-timeline:${args.symbol}`;
  const cached = await readCache<WithProvenance<StockFilingsTimelineData>>(
    SECTIONS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // `textContent` is DELIBERATELY not selected — see header note 1. Every
    // other column the timeline renders is here; adding the text column back
    // would move megabytes per request.
    const docs = await db.stockDocument.findMany({
      where: { symbol: args.symbol },
      orderBy: { fetchedAt: "desc" },
      take: DOCS_READ_LIMIT,
      select: {
        id: true,
        docType: true,
        period: true,
        title: true,
        description: true,
        sourceUrl: true,
        sourceType: true,
        processingStatus: true,
        fileSize: true,
        mimeType: true,
        fetchedAt: true,
      },
    });

    // `symbol` filtered EXPLICITLY — the column is nullable for macro events and
    // a null-tolerant filter pins RBI policy day onto every stock (note 3).
    const startOfToday = new Date(
      `${now().toISOString().slice(0, 10)}T00:00:00.000Z`,
    );
    const events = await db.upcomingEvent.findMany({
      where: { symbol: args.symbol, date: { gte: startOfToday } },
      orderBy: { date: "asc" },
      take: EVENTS_READ_LIMIT,
      select: {
        id: true,
        date: true,
        symbol: true,
        title: true,
        category: true,
        source: true,
      },
    });

    const timeline = buildFilingsTimeline({
      docs: docs as StockDocumentRow[],
      events: events as UpcomingEventRow[],
      symbol: args.symbol,
      now: now(),
      limit: DOCS_DISPLAY_LIMIT,
    });

    const feed = dominant(docs.map((d) => d.sourceType));
    const envelope = withProvenance<StockFilingsTimelineData>(timeline, {
      source: feed.value,
      // What the data DESCRIBES is, honestly, when we indexed it. There is no
      // filing date on this model to use instead.
      asOf: timeline.latestIndexedAt,
      note: buildTimelineNote(timeline, feed.distinct),
      // The payload is an object, so `empty` cannot be read off a length. A
      // pinned event with no documents is NOT empty — the panel has something
      // to say.
      emptyOverride: timeline.items.length === 0 && timeline.pinned === null,
    });

    if (!envelope.empty) {
      await writeCache(
        SECTIONS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        { ttl: ttl(FILINGS_TTL_LIVE_S, FILINGS_TTL_CLOSED_S) },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockFilingsTimeline error:", error);
    return { success: false, error: "Failed to load filings timeline" };
  }
}

function buildTimelineNote(
  timeline: FilingsTimeline,
  distinctFeeds: number,
): string | undefined {
  const parts: string[] = [];
  if (timeline.items.length > 0) {
    parts.push(
      "Dated by when we indexed the document — the exchange feed carries no filing date.",
    );
  }
  if (timeline.notReadyCount > 0) {
    parts.push(
      `${timeline.notReadyCount} document${timeline.notReadyCount === 1 ? "" : "s"} not yet text-extracted.`,
    );
  }
  if (distinctFeeds > 1) parts.push(`${distinctFeeds} source feeds.`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.8 — financials source badge + basis / cumulative toggle
// ═══════════════════════════════════════════════════════════════════════════

/** One (basis, cumulative) view of the filing history. */
export interface FilingViewBucket {
  basis: FinancialsBasis;
  cumulative: boolean;
  periods: FilingPeriodView[];
}

export interface StockFinancialsSourceData {
  /** What `stock_financials.source` actually says. Never hardcoded. */
  badge: FinancialsSourceSummary;
  /**
   * The drill-down, PRE-SPLIT by (basis, cumulative).
   *
   * All four buckets ship in one payload rather than the toggle refetching,
   * for two reasons: the whole set is ~40 small objects, and — the load-bearing
   * one — a bucketed payload makes the merge the schema warns about
   * structurally impossible. A client cannot accidentally concatenate a
   * quarterly filing with the nine-month cumulative that shares its `periodEnd`
   * if they were never in the same array.
   */
  views: FilingViewBucket[];
  available: FilingBasisAvailability;
  defaultBasis: FinancialsBasis;
  /** True when `xbrl_filings` has nothing for this issuer. The badge still shows. */
  filingsEmpty: boolean;
}

/**
 * The financials provenance badge, plus the XBRL filing drill-down.
 *
 * The badge reads `StockFinancials.source` and reports it. It does NOT assume a
 * value: the 14a.4 XBRL switchover is not armed (its reconcile evidence run is
 * founder-gated and has not happened), so in practice every row reads
 * `TICKERTAPE` today — and a badge that hardcodes that is a badge that lies the
 * day the switchover lands. `source` is also NOT in
 * `@@unique([symbol, exchange, statementType, periodType, period])`, so two
 * sources for one period are ONE row and a write ERASES rather than duplicates;
 * `summarizeFinancialsSource` surfaces the `displacedByXbrl` records that are
 * the only audit trail of what was erased.
 */
export async function getStockFinancialsSource(
  args: { symbol: string; exchange: string },
  deps: StockSectionsDocsDeps = {},
): Promise<ServiceResult<WithProvenance<StockFinancialsSourceData>>> {
  const { db, readCache, writeCache } = resolve(deps);
  const cacheKey = `stock-financials-source:${args.symbol}:${args.exchange}`;
  const cached = await readCache<WithProvenance<StockFinancialsSourceData>>(
    SECTIONS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // The badge read IS exchange-scoped: `stock_financials` puts `exchange` in
    // its unique key and the legacy financials tab reads it that way
    // (apps/web/lib/actions/stock-tabs.ts), so a badge scoped differently from
    // the numbers it labels would describe a different set of rows.
    const finRows = await db.stockFinancials.findMany({
      where: { symbol: args.symbol, exchange: args.exchange },
      orderBy: { fetchedAt: "desc" },
      take: FINANCIALS_READ_LIMIT,
      select: {
        period: true,
        periodType: true,
        statementType: true,
        source: true,
        fetchedAt: true,
        rawData: true,
      },
    });

    // Filings are NOT exchange-scoped — see header note 4. `xbrl_filings` is an
    // NSE feed; a BSE view of a dual-listed company must still see them.
    const filings = await db.xbrlFiling.findMany({
      where: { symbol: args.symbol },
      orderBy: { periodEnd: "desc" },
      take: FILINGS_READ_LIMIT,
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        periodType: true,
        basis: true,
        cumulative: true,
        audited: true,
        coverage: true,
        conceptsFound: true,
        sourceUrl: true,
        filedAt: true,
        taxonomyVersion: true,
      },
    });

    const badge = summarizeFinancialsSource(finRows);
    const drill = buildFilingDrilldown(filings as XbrlFilingRow[], {
      limit: FILING_PERIODS_PER_VIEW,
    });

    // Every (basis, cumulative) combination the issuer actually filed, each in
    // its own bucket. `selectFilings` enforces BOTH filters, so no bucket can
    // contain a mixed series.
    const views: FilingViewBucket[] = [];
    for (const basis of FINANCIALS_BASES) {
      if (!drill.available.bases.includes(basis)) continue;
      for (const cumulative of [false, true]) {
        if (cumulative && !drill.available.hasCumulative) continue;
        if (!cumulative && !drill.available.hasDiscrete) continue;
        const periods = selectFilings(filings as XbrlFilingRow[], {
          basis,
          cumulative,
          limit: FILING_PERIODS_PER_VIEW,
        });
        if (periods.length === 0) continue;
        views.push({ basis, cumulative, periods });
      }
    }

    const data: StockFinancialsSourceData = {
      badge,
      views,
      available: drill.available,
      defaultBasis: drill.available.bases.includes(DEFAULT_FINANCIALS_BASIS)
        ? DEFAULT_FINANCIALS_BASIS
        : (drill.available.bases[0] ?? DEFAULT_FINANCIALS_BASIS),
      filingsEmpty: views.length === 0,
    };

    const envelope = withProvenance<StockFinancialsSourceData>(data, {
      source: badge.primary,
      asOf: badge.asOf,
      note: buildSourceNote(badge, views.length),
      // The section is empty only when there is NO source to label AND no
      // filing to drill into. A populated badge with zero filings is a real,
      // renderable state — it is today's state for every stock.
      emptyOverride: badge.primary === null && views.length === 0,
    });

    if (!envelope.empty) {
      await writeCache(
        SECTIONS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        { ttl: FINANCIALS_SOURCE_TTL_S },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockFinancialsSource error:", error);
    return { success: false, error: "Failed to load financials provenance" };
  }
}

function buildSourceNote(
  badge: FinancialsSourceSummary,
  viewCount: number,
): string | undefined {
  const parts: string[] = [];
  if (badge.mixed) {
    parts.push(
      `Mixed provenance: ${badge.breakdown
        .map((b) => `${b.source} ×${b.rows}`)
        .join(", ")}.`,
    );
  }
  if (badge.displacements.length > 0) {
    parts.push(
      `${badge.displacements.length} period${badge.displacements.length === 1 ? "" : "s"} replaced by an exchange filing.`,
    );
  }
  if (viewCount === 0) {
    parts.push("No XBRL filing has been parsed for this issuer yet.");
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.9 — funds holding this stock
// ═══════════════════════════════════════════════════════════════════════════

export type StockFundsHoldingData = FundsHoldingSection;

/**
 * Which mutual-fund schemes hold this stock, and what changed month over month.
 *
 * `mf_portfolio_holdings` has NO `symbol` column — the join is by `isin` with an
 * `instrumentId` fallback, both nullable by design (an unresolved holding is
 * still a real holding and is kept rather than dropped at ingest). So the read
 * is:
 *
 *   1. resolve every `InstrumentMapping` for this symbol → its ISINs and ids
 *      (a dual-listed name has an NSE row and a BSE row sharing one ISIN),
 *   2. find the two most recent disclosure MONTHS that mention it,
 *   3. pull only those two months' rows.
 *
 * Three bounded, indexed queries rather than one unbounded scan. Step 2 exists
 * because "the last two calendar months" is the wrong window: AMCs file at
 * different times and Nippon publishes only the CURRENT month, so a fixed
 * two-month window shows an empty panel for most of every month. The pure layer
 * flags a non-consecutive pair as `monthGap` rather than mislabelling the diff.
 */
export async function getStockFundsHolding(
  args: { symbol: string; exchange: string },
  deps: StockSectionsDocsDeps = {},
): Promise<ServiceResult<WithProvenance<StockFundsHoldingData>>> {
  const { db, readCache, writeCache } = resolve(deps);
  const cacheKey = `stock-funds-holding:${args.symbol}`;
  const cached = await readCache<WithProvenance<StockFundsHoldingData>>(
    SECTIONS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // Exchange-agnostic on purpose: one company, one ISIN, two listings.
    const instruments = await db.instrumentMapping.findMany({
      where: { symbol: args.symbol },
      take: 8,
      select: { id: true, isin: true },
    });
    const isins = [
      ...new Set(
        instruments
          .map((i) => (i.isin ?? "").trim().toUpperCase())
          .filter((s) => s !== ""),
      ),
    ];
    const ids = instruments.map((i) => i.id);

    // No ISIN AND no instrument row ⇒ nothing to join on. Return an honest
    // empty envelope rather than an unfiltered query.
    if (isins.length === 0 && ids.length === 0) {
      return {
        success: true,
        data: withProvenance<StockFundsHoldingData>(
          buildFundsHoldingSection([]),
          {
            source: MF_PORTFOLIO_SOURCE,
            asOf: null,
            note: "No ISIN on file for this symbol, so fund disclosures cannot be matched to it.",
            emptyOverride: true,
          },
        ),
      };
    }

    const match = {
      OR: [
        ...(isins.length > 0 ? [{ isin: { in: isins } }] : []),
        ...(ids.length > 0 ? [{ instrumentId: { in: ids } }] : []),
      ],
    };

    const latest = await db.mfPortfolioHolding.findFirst({
      where: match,
      orderBy: { period: "desc" },
      select: { period: true },
    });
    if (!latest) {
      return {
        success: true,
        data: withProvenance<StockFundsHoldingData>(
          buildFundsHoldingSection([]),
          { source: MF_PORTFOLIO_SOURCE, asOf: null, emptyOverride: true },
        ),
      };
    }

    // The month BEFORE the latest one that actually mentions this stock — not
    // "last calendar month", which is empty for most of every month.
    const prior = await db.mfPortfolioHolding.findFirst({
      where: { ...match, period: { lt: latest.period } },
      orderBy: { period: "desc" },
      select: { period: true },
    });

    const periods =
      prior === null ? [latest.period] : [latest.period, prior.period];

    // One bounded read PER PERIOD — the pattern `getInstitutionalFlows` uses,
    // and for the same reason: a single `{ in: [...] }` read with a shared cap
    // cannot guarantee that BOTH members are represented, and here the one that
    // gets starved is the month the entered/exited diff is measured against.
    const pages = await Promise.all(
      periods.map((period) =>
        db.mfPortfolioHolding.findMany({
          where: { ...match, period },
          orderBy: [{ percentToNav: "desc" }],
          take: FUND_ROWS_PER_PERIOD,
          select: {
            period: true,
            amc: true,
            schemeName: true,
            schemeKey: true,
            amfiSchemeCode: true,
            isin: true,
            instrumentId: true,
            instrumentName: true,
            holdingType: true,
            quantity: true,
            marketValue: true,
            percentToNav: true,
          },
        }),
      ),
    );
    const rows = pages.flat();

    const section = buildFundsHoldingSection(rows as StockFundHoldingRow[], {
      limit: FUNDS_DISPLAY_LIMIT,
    });

    const envelope = withProvenance<StockFundsHoldingData>(section, {
      source: MF_PORTFOLIO_SOURCE,
      // The month the disclosure DESCRIBES, never when we ingested it.
      asOf: section.period,
      note: buildFundsNote(section),
      emptyOverride: section.fundCount === 0,
    });

    if (!envelope.empty) {
      await writeCache(
        SECTIONS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        { ttl: FUNDS_TTL_S },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockFundsHolding error:", error);
    return { success: false, error: "Failed to load fund ownership" };
  }
}

/**
 * Registry-family-style slug so `sourceLabel()` in SectionShell renders it as
 * "AMC portfolio disclosure" without needing a table entry. These are the
 * SEBI-mandated monthly filings, not an AMFI product.
 */
const MF_PORTFOLIO_SOURCE = "amc-portfolio-disclosure";

function buildFundsNote(section: FundsHoldingSection): string | undefined {
  const parts: string[] = [];
  if (!section.comparable && section.fundCount > 0) {
    parts.push(
      "Only one disclosure month on file — no month-on-month diff yet.",
    );
  }
  if (section.monthGap) {
    parts.push("Compared months are not consecutive; changes span the gap.");
  }
  if (section.undisclosedWeightCount > 0) {
    parts.push(
      `${section.undisclosedWeightCount} scheme${section.undisclosedWeightCount === 1 ? "" : "s"} disclosed no weight (not counted as zero).`,
    );
  }
  if (section.unlinkedFundCount > 0) {
    parts.push(
      `${section.unlinkedFundCount} scheme${section.unlinkedFundCount === 1 ? "" : "s"} have no AMFI code, so they are unlinked.`,
    );
  }
  if (section.unresolvedRowCount > 0) {
    parts.push(`${section.unresolvedRowCount} rows could not be resolved.`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
