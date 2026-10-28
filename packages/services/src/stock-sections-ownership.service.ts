/**
 * Ownership sections service — MONEY-1204 (P14 / 14c.4, 14c.5, 14c.6).
 *
 * Read-only, GLOBAL (no userId) sections backed by the data engine's own
 * tables:
 *
 *   14c.4  shareholding pattern   `shareholding_patterns` (NSE)  ← PRIMARY
 *                                 `stock_shareholding` (Tickertape) ← fallback
 *   14c.5  insider & promoter     `insider_events`
 *   14c.6  bulk / block deals     `institutional_deals`
 *
 * …plus one SECTOR-scoped reader over the same deals table (MONEY-268), which
 * lives here rather than beside the sector deep-dive because the table, the
 * BigInt seam, the cache policy and the provenance envelope are all already
 * solved in this file — see the block above `getSectorInstitutionalPicks`.
 *
 * Lives in `@usemoney/services` — not in the web action — so the server action
 * and its `apps/api` `/v1/stocks/:symbol/*` mirror run the SAME code rather
 * than two copies that drift. The web action is a `"use server"` wrapper over
 * these functions; `mountStockSection` in apps/api calls them directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Three decisions that are easy to get wrong here
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **1. The reads are keyed on `symbol` ALONE, never on the page's exchange.**
 * All four tables carry `exchange String @default("NSE")` and every stored row
 * is NSE: these are NSE-published feeds. `ShareholdingPattern` goes further and
 * declares `@@unique([symbol, quarter])` with NO exchange in the key at all.
 * Adding `exchange: args.exchange` to the where clause would therefore return
 * ZERO rows on any BSE view of a dual-listed company — an empty panel that is
 * indistinguishable from "the exchange has not published this", which is the
 * silent-zero failure this subsystem keeps re-learning (MONEY-1169). Ownership
 * and insider filings are company-level facts anyway; the deals feed is
 * NSE-specific and says so through its `NSE_DEALS` provenance chip.
 *
 * **2. BigInt never reaches the caller.** `InsiderEvent.qty` and
 * `InstitutionalDeal.qty` are Prisma `BigInt`. `JSON.stringify` THROWS on a
 * BigInt, so a server action that returned one crashes at the server/client
 * boundary — a 500 with no useful message. `bigIntToNumber` runs at the read.
 *
 * **3. Nothing empty and nothing failed is ever cached.** Caching "couldn't
 * determine" pins the failure for the TTL and makes the next request lie about
 * it (the standing rule). A miss costs one query.
 *
 * These functions do NOT live-fetch. `getShareholdingAction` in
 * apps/web/lib/actions/stock-tabs.ts owns the bounded Tickertape/screener chain
 * for the legacy tab; this section reads what the data engine already persisted
 * and says so honestly through the provenance envelope when that is nothing.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core/cache";
import { getNseMarketStatus } from "@usemoney/core/market-data/market-hours";
import {
  ANNOUNCEMENT_DOC_TYPES,
  buildDealsSection,
  buildInsiderSection,
  buildOwnershipBreakdownSection,
  buildShareholdingSection,
  classifyInstitutionalClient,
  dealSide,
  hasOwnershipBreakdownValues,
  quarterEndDate,
  type DealInput,
  type InstitutionalClientClass,
  type DealsSection,
  type InsiderEventInput,
  type InsiderSection,
  type NseShareholdingRow,
  type OwnershipBreakdownRow,
  type OwnershipBreakdownSection,
  type PledgePoint,
  type ShareholdingQuarter,
  type ShareholdingSource,
  type StockDocumentInput,
  type TickertapeShareholdingRow,
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
 * Shareholding is filed quarterly — there is nothing to gain from a short TTL,
 * and a long one is what keeps a stock page off the DB on every tab switch.
 */
const SHAREHOLDING_TTL_S = 6 * 60 * 60;
/**
 * …EXCEPT when we are serving a stale fallback copy. A short TTL there means a
 * refresh that lands is visible in minutes instead of hours, which matters
 * precisely because the panel is currently apologising for its own age.
 */
const SHAREHOLDING_STALE_TTL_S = 30 * 60;

/**
 * The staleness bound preserved from `getShareholdingAction`
 * (apps/web/lib/actions/stock-tabs.ts:412). `persistShareholding` only INSERTS
 * missing quarters and never updates, and nothing schedules a Tickertape
 * refresh, so a single old StockSage run can pin a symbol to one quarter
 * forever. Shareholding is filed quarterly; a copy older than a month is
 * labelled rather than trusted silently.
 *
 * It applies to the FALLBACK path only. NSE rows are written by our own weekly
 * job from the exchange's own filing and carry no `fetchedAt` to age.
 */
const SHAREHOLDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** How many quarters the panel shows (three years). */
const SHAREHOLDING_QUARTERS = 12;
/**
 * Exchanges that can file the SAME quarter for one symbol (NSE + BSE).
 *
 * This is a read-window multiplier, not a list to filter on — see the query.
 * If a third exchange ever files into `shareholding_patterns`, raising this is
 * what keeps the window holding SHAREHOLDING_QUARTERS distinct quarters.
 */
const SHAREHOLDING_EXCHANGES = 2;
/**
 * Quarters the ownership-breakdown card needs: the latest, plus the one its
 * QoQ deltas are measured against.
 */
const BREAKDOWN_QUARTERS = 2;
/**
 * `shareholding_breakdown` is filed quarterly, like the summary above, so it
 * gets the same long TTL. There is no fallback provider and therefore no stale
 * short-TTL variant — a missing row is a missing row.
 */
const BREAKDOWN_TTL_S = 6 * 60 * 60;
/** Rows pulled for the insider timeline before the display cap. */
const INSIDER_READ_LIMIT = 200;
const INSIDER_DISPLAY_LIMIT = 60;
/** Rows pulled for the deals panel before the display cap. */
const DEALS_READ_LIMIT = 200;
const DEALS_DISPLAY_LIMIT = 50;
/** Announcement documents considered for the "likely" insider link. */
const INSIDER_DOC_READ_LIMIT = 100;

// ── IO seam ──────────────────────────────────────────────────────────────────

/**
 * Injectable collaborators. Defaults are the shared prisma client, the two-tier
 * cache wrapper and the pure NSE market-phase detector; `now` is injectable so
 * every window in the pure layer (90-day net, repeat-buyer window, staleness)
 * is pinned by the test rather than raced against the wall clock.
 */
export interface OwnershipSectionDeps {
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

function resolve(deps: OwnershipSectionDeps): ResolvedDeps {
  const marketStatus = deps.getNseMarketStatus ?? getNseMarketStatus;
  return {
    db: deps.prisma ?? prisma,
    readCache: deps.getCached ?? getCached,
    writeCache: deps.setCached ?? setCached,
    ttl: (live, closed) => (marketStatus().isLive ? live : closed),
    now: deps.now ?? (() => new Date()),
  };
}

/**
 * Prisma `BigInt` → `number | null`.
 *
 * Share counts are `BigInt` because a single print in a high-float penny name
 * exceeds Int32 — but they are nowhere near `Number.MAX_SAFE_INTEGER`
 * (9.0 × 10^15), so the double conversion is exact for every real value. Null
 * in, null out: an undisclosed quantity must NOT become 0.
 */
function bigIntToNumber(v: bigint | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "bigint" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.4 — Shareholding pattern
// ═══════════════════════════════════════════════════════════════════════════

export interface StockShareholdingSectionData {
  /** Newest quarter first, each carrying its QoQ deltas. */
  quarters: ShareholdingQuarter[];
  /** Oldest first, for the pledge sparkline. Nulls are gaps, not zeros. */
  pledgeTrend: PledgePoint[];
  /** True when a FALLBACK copy is older than the staleness bound. */
  stale: boolean;
}

/**
 * Quarterly shareholding, NSE primary and Tickertape fallback.
 *
 * The precedence — and the visible `fallback` label that goes with it — is the
 * whole point of the section. The two tables' `quarter` strings do not join
 * (`2026-03` vs `Q3-2024`), so they cannot be merged; picking one and saying
 * which is the only honest option.
 */
export async function getStockShareholdingSection(
  args: { symbol: string; exchange: string },
  deps: OwnershipSectionDeps = {},
): Promise<ServiceResult<WithProvenance<StockShareholdingSectionData>>> {
  const { db, readCache, writeCache, now } = resolve(deps);
  // Exchange is IN the key because the section's content now depends on it:
  // where both exchanges filed the same quarter, the viewed exchange's filing
  // wins. A symbol-only key would let the NSE page serve BSE's numbers to the
  // BSE page and vice versa, whichever rendered first.
  const cacheKey = `stock-shareholding-section:${args.symbol}:${args.exchange}`;
  const cached = await readCache<WithProvenance<StockShareholdingSectionData>>(
    SECTIONS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // NOT keyed on symbol alone, and NOT filtered to one exchange either.
    //
    // This comment previously read "`@@unique([symbol, quarter])` has no
    // exchange in it, so there is no exchange-scoped row to find". That was
    // true when written and is now false: MONEY-1207 put `exchange` INTO the
    // unique key so BSE could not upsert over NSE's row. Reading on symbol
    // alone therefore returns the same quarter ONCE PER EXCHANGE for the 2,465
    // dual-listed symbols — which rendered `2026-06` twice in the table.
    //
    // The filter is still symbol-only on purpose: an `exchange` predicate would
    // return nothing for a quarter only the OTHER exchange filed. Both rows are
    // fetched and `buildShareholdingSection` picks one per quarter, preferring
    // the exchange being viewed.
    //
    // CANONICAL LABELS ONLY. `quarter` is a free-text key: the parser writes
    // `YYYY-MM` when it could date the period and otherwise keeps the label
    // VERBATIM and upper-cased ("Q1FY26"). Letters sort ABOVE digits, so in a
    // lexicographic `quarter: "desc"` every undatable label outranks every real
    // quarter — with enough of them the `take` window holds no real quarter at
    // all, and the section renders labels it cannot date, `asOf: null`, and
    // caches that for six hours. `startsWith: "20"` is what makes the DB order
    // chronological, which is the property the `take` is relying on.
    //
    // The excluded rows are not lost information being hidden: a label we
    // cannot rank cannot be ordered, dated, or QoQ-differenced, so it would
    // render as an undated row wherever it landed. A symbol that has ONLY those
    // falls through to the Tickertape fallback, which is labelled as such.
    // `packages/research/.../db-store.ts` defends the same column the same way
    // (`CANONICAL_QUARTER`); this reader had drifted from it.
    const nseRows = await db.shareholdingPattern.findMany({
      where: { symbol: args.symbol, quarter: { startsWith: "20" } },
      orderBy: { quarter: "desc" },
      // Sized in ROWS, and a quarter can occupy one row per exchange, so the
      // window has to be a multiple of the exchange count or the dedupe below
      // yields fewer distinct quarters than asked for.
      take: SHAREHOLDING_QUARTERS * SHAREHOLDING_EXCHANGES,
      select: {
        quarter: true,
        // Required by the dedupe. Dropping it from the select does not fail —
        // it silently makes every row rank equal, so the winner becomes
        // whichever exchange the DB happened to return first.
        exchange: true,
        // Required by the provenance chip (MONEY-1255). Same failure mode as
        // `exchange` above and a worse consequence: without it every row falls
        // back to the schema default and a BSE-only company renders "NSE
        // shareholding" over numbers no NSE filing produced. Pinned by
        // `stock-sections-ownership.breakdown.test.ts`, not by this comment.
        source: true,
        promoterPct: true,
        pledgedPct: true,
        fiiPct: true,
        diiPct: true,
        publicPct: true,
      },
    });

    // The fallback is read unconditionally rather than lazily: one extra
    // indexed read is cheaper than a second round trip, and reading it up front
    // is what lets `buildShareholdingSection` decide precedence in ONE place
    // instead of the decision being split across an if and an await.
    //
    // DO NOT COPY THE `startsWith: "20"` PREDICATE FROM THE QUERY ABOVE, and do
    // not add `orderBy: { quarter: "desc" }` here either. Both are correct
    // twenty lines up and wrong here, because this is a DIFFERENT table with a
    // different label vocabulary:
    //
    //   shareholding_patterns.quarter  "2026-06"   (NSE, parser-canonicalised)
    //   stock_shareholding.quarter     "Jun 2026"  (Tickertape, verbatim)
    //
    // Measured on prod 2026-08-16, every row in this table uses the month-name
    // form. So `startsWith: "20"` would match NOTHING and silently delete the
    // fallback — a well-formed empty result, indistinguishable from "this
    // symbol has no Tickertape history", on the exact path that exists to cover
    // NSE having filed nothing. And a lexicographic `desc` would be worse than
    // no order at all: it sorts alphabetically by MONTH NAME, so "Sep 2020"
    // outranks "Jun 2026".
    //
    // There is no correct DB-side ordering for this column; `quarterSortRank`
    // understands the month-name form and `sortShareholdingNewestFirst` inside
    // `buildShareholdingSection` is the authority. The `take` is therefore
    // headroom, not a window: 4x the quarters kept, against a measured maximum
    // of 12 rows for any symbol, so truncation is not currently reachable. If
    // this table ever grows past that, the fix is to raise the bound or read
    // per-period — NOT to invent an ordering the labels cannot support.
    const ttRows = await db.stockShareholding.findMany({
      where: { symbol: args.symbol },
      take: SHAREHOLDING_QUARTERS * 4,
      select: {
        quarter: true,
        promoter: true,
        fii: true,
        dii: true,
        public: true,
        pledgedPercent: true,
        fetchedAt: true,
      },
    });

    const section = buildShareholdingSection({
      // No cast: the select's shape has to keep satisfying `NseShareholdingRow`
      // on its own, so a renamed column fails the build instead of being
      // asserted away.
      nse: nseRows satisfies NseShareholdingRow[],
      tickertape: dedupeTickertapeQuarters(ttRows),
      maxQuarters: SHAREHOLDING_QUARTERS,
      // Both exchanges' filings are on the wire; this says which one wins a
      // quarter they both filed. Without it the pick is still deterministic
      // (NSE), but a BSE view would show NSE's numbers unlabelled.
      preferExchange: args.exchange,
    });

    // STALENESS — fallback path only. Preserved from getShareholdingAction:
    // nothing refreshes `stock_shareholding`, so an old StockSage run can pin a
    // symbol to one quarter indefinitely. This section cannot re-fetch (that
    // chain belongs to the legacy tab), so instead of hiding the rows it LABELS
    // them: a visible "last refreshed" note beats an unexplained blank panel,
    // and beats silently presenting a year-old copy as current.
    const freshest = ttRows.reduce<number>(
      (max, r) => Math.max(max, r.fetchedAt?.getTime() ?? 0),
      0,
    );
    const stale =
      section.source === "TICKERTAPE" &&
      now().getTime() - freshest > SHAREHOLDING_MAX_AGE_MS;

    const newestQuarter = section.quarters[0]?.quarter ?? null;
    const envelope = withProvenance<StockShareholdingSectionData>(
      {
        quarters: section.quarters,
        pledgeTrend: section.pledgeTrend,
        stale,
      },
      {
        source: section.source,
        // `asOf` is the quarter the data DESCRIBES, derived from the label —
        // never `fetchedAt`, which is when we copied it.
        asOf: newestQuarter ? quarterEndDate(newestQuarter) : null,
        fallback: section.fallback,
        note: buildShareholdingNote(section.source, stale, freshest),
        // The payload is an object, so `empty` cannot be read off a length —
        // this is the documented `emptyOverride` case.
        emptyOverride: section.quarters.length === 0,
      },
    );

    if (!envelope.empty) {
      await writeCache(
        SECTIONS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        { ttl: stale ? SHAREHOLDING_STALE_TTL_S : SHAREHOLDING_TTL_S },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockShareholdingSection error:", error);
    return { success: false, error: "Failed to load shareholding pattern" };
  }
}

/**
 * One Tickertape row per quarter, freshest copy winning.
 *
 * `stock_shareholding` is `@@unique([symbol, exchange, quarter])`, so the same
 * quarter can legitimately exist twice for a dual-listed name. Since the read
 * is exchange-agnostic (header note), the duplicates have to collapse here or
 * the series would plot the same quarter twice and compute a QoQ delta of zero
 * between the pair.
 */
function dedupeTickertapeQuarters(
  rows: ReadonlyArray<{
    quarter: string;
    promoter: number | null;
    fii: number | null;
    dii: number | null;
    public: number | null;
    pledgedPercent: number | null;
    fetchedAt: Date | null;
  }>,
): TickertapeShareholdingRow[] {
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = (r.quarter ?? "").trim();
    if (key === "") continue;
    const incumbent = best.get(key);
    if (
      !incumbent ||
      (r.fetchedAt?.getTime() ?? 0) > (incumbent.fetchedAt?.getTime() ?? 0)
    ) {
      best.set(key, r);
    }
  }
  return [...best.values()];
}

function buildShareholdingNote(
  source: ShareholdingSource | null,
  stale: boolean,
  freshestMs: number,
): string | undefined {
  if (source === "TICKERTAPE") {
    const when =
      freshestMs > 0
        ? new Date(freshestMs).toISOString().slice(0, 10)
        : "an unknown date";
    // Both exchanges, because both are read: `shareholding_patterns` holds
    // 17,075 BSE rows across 4,705 symbols, so "NSE has none" alone stopped
    // being the reason we are on this path (MONEY-1255).
    return stale
      ? `NSE has published no shareholding for this symbol, and neither has BSE. Showing a third-party copy last refreshed ${when} — older than a quarter.`
      : `NSE has published no shareholding for this symbol, and neither has BSE. Showing a third-party copy (refreshed ${when}).`;
  }
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.4b — Ownership breakdown (MONEY-1255)
// ═══════════════════════════════════════════════════════════════════════════

export type StockOwnershipBreakdownData = OwnershipBreakdownSection;

/**
 * The institutional split for the latest filed quarter, with its QoQ movement.
 *
 * ## Why this exists
 *
 * `shareholding_breakdown` holds 52,435 rows across 4,828 symbols and, before
 * this function, NOTHING user-facing read one. The summary table the section
 * above serves CANNOT substitute: `shareholding_patterns` has no mutual-fund,
 * insurance, banks, government or retail column, and MONEY-1207 measured its
 * FII/DII columns null on 100% of 7,953 rows. So the parse was done, the rows
 * were written nightly, and the answer never reached a screen.
 *
 * ## The read is symbol-only, and that is not an oversight
 *
 * Identical reasoning to the summary read twenty lines up, for an identical
 * key: this table is `@@unique([symbol, exchange, quarter])` too, so an
 * `exchange: args.exchange` predicate would return ZERO rows for a quarter only
 * the OTHER exchange filed — an empty card indistinguishable from "nobody has
 * published this", which is the silent-zero failure this subsystem keeps
 * re-learning. Both exchanges' rows are fetched and
 * `buildOwnershipBreakdownSection` picks one per quarter, preferring the
 * exchange being viewed.
 *
 * `startsWith: "20"` is the same defence as well: `quarter` is written by the
 * same `normalizeQuarter`, which keeps an undatable label VERBATIM. Letters
 * sort above digits, so in a lexicographic `desc` two such labels would fill a
 * `take` of four and the card would render a quarter it cannot date.
 *
 * ## BigInt
 *
 * The five share-count columns are Prisma `BigInt`. `JSON.stringify` THROWS on
 * one — a 500 at the server/client boundary, not a wrong number — so
 * `buildOwnershipBreakdownSection` converts every one to a decimal STRING
 * before it returns. String and not `Number()`: a share count is the one place
 * in this file where every digit is the fact.
 */
export async function getStockOwnershipBreakdownSection(
  args: { symbol: string; exchange: string },
  deps: OwnershipSectionDeps = {},
): Promise<ServiceResult<WithProvenance<StockOwnershipBreakdownData>>> {
  const { db, readCache, writeCache } = resolve(deps);
  // Exchange is IN the key for the same reason it is in the summary section's:
  // where both exchanges filed a quarter, the viewed exchange's filing wins, so
  // a symbol-only key would let one page serve the other's numbers.
  const cacheKey = `stock-ownership-breakdown:${args.symbol}:${args.exchange}`;
  const cached = await readCache<WithProvenance<StockOwnershipBreakdownData>>(
    SECTIONS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const rows = await db.shareholdingBreakdown.findMany({
      where: { symbol: args.symbol, quarter: { startsWith: "20" } },
      orderBy: { quarter: "desc" },
      // Sized in ROWS over a table where one quarter occupies one row PER
      // EXCHANGE, so it is a multiple of the exchange count — a `take: 2` would
      // hand back one dual-filed quarter and no prior quarter to compare it
      // against, and every delta on the card would be null (MONEY-1207).
      take: BREAKDOWN_QUARTERS * SHAREHOLDING_EXCHANGES,
      select: {
        quarter: true,
        // Both required by the dedupe and the provenance chip. Dropping either
        // does not fail — it silently makes every row rank equal and stamps the
        // card with the schema's default source.
        exchange: true,
        source: true,
        fiiPct: true,
        diiPct: true,
        mutualFundPct: true,
        insurancePct: true,
        banksFiPct: true,
        govtPct: true,
        retailPct: true,
        promoterShares: true,
        fiiShares: true,
        diiShares: true,
        publicShares: true,
        totalShares: true,
      },
    });

    const section = buildOwnershipBreakdownSection(
      // No cast: the select's shape has to keep satisfying `OwnershipBreakdownRow`
      // on its own, so a renamed column fails the build instead of being
      // asserted away.
      rows satisfies OwnershipBreakdownRow[],
      { preferExchange: args.exchange },
    );

    const envelope = withProvenance<StockOwnershipBreakdownData>(section, {
      source: section.source,
      // The quarter the filing DESCRIBES, never when we parsed it.
      asOf: section.quarter ? quarterEndDate(section.quarter) : null,
      note: buildBreakdownNote(section),
      // The payload is an object, so `empty` cannot be read off a length — the
      // documented `emptyOverride` case. Seven null legs and five null counts
      // is an empty card however real the row behind it is.
      emptyOverride: !hasOwnershipBreakdownValues(section),
    });

    if (!envelope.empty) {
      await writeCache(
        SECTIONS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        { ttl: BREAKDOWN_TTL_S },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockOwnershipBreakdownSection error:", error);
    return { success: false, error: "Failed to load ownership breakdown" };
  }
}

/**
 * What the card cannot say for itself.
 *
 * Only two cases are worth a sentence, and both are about a COMPARISON the
 * reader would otherwise assume happened:
 *
 *   - there is no prior quarter at all (a first filing, or a backfill that has
 *     reached one quarter);
 *   - there is one, and it is not adjacent — so every delta is null on purpose
 *     rather than because nothing moved.
 */
function buildBreakdownNote(
  section: OwnershipBreakdownSection,
): string | undefined {
  if (section.quarter === null || section.comparable) return undefined;
  if (section.prevQuarter === null)
    return "Only one quarter has been filed for this stock, so there is no quarter-on-quarter change to show.";
  return (
    `The previous quarter on file is ${section.prevLabel}, not the one ` +
    `immediately before ${section.label} — the change against it would not be ` +
    "a quarter's movement, so none is shown."
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.5 — Insider & promoter activity
// ═══════════════════════════════════════════════════════════════════════════

export type StockInsiderSectionData = InsiderSection;

/**
 * Insider / promoter filings: a month-grouped timeline plus a netted 90-day
 * summary, with a LIKELY link to a corroborating announcement.
 *
 * The document link is a date-proximity heuristic and nothing more — see
 * `matchLikelyDocument`, which is why every link carries `likely: true`.
 */
export async function getStockInsiderSection(
  args: { symbol: string; exchange: string },
  deps: OwnershipSectionDeps = {},
): Promise<ServiceResult<WithProvenance<StockInsiderSectionData>>> {
  const { db, readCache, writeCache, ttl, now } = resolve(deps);
  const cacheKey = `stock-insider:${args.symbol}`;
  const cached = await readCache<WithProvenance<StockInsiderSectionData>>(
    SECTIONS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // `@@index([symbol, category, date(sort: Desc)])` is the declared hot read.
    // We want EVERY category, so the equality is on `symbol` only and the sort
    // is not served by a contiguous index prefix — Mongo sorts the matched set,
    // which is bounded by `take` and by one symbol's filing count (tens, not
    // thousands). Narrowing to one category to please the index would mean
    // three round trips to rebuild the same timeline.
    const rows = await db.insiderEvent.findMany({
      where: { symbol: args.symbol },
      orderBy: { date: "desc" },
      take: INSIDER_READ_LIMIT,
      select: {
        id: true,
        date: true,
        person: true,
        category: true,
        action: true,
        qty: true,
        value: true,
        source: true,
      },
    });

    // Only fetched when there is something to link TO. An announcement query on
    // a symbol with no filings is pure waste, and an empty section must not
    // cost two reads.
    const docs: StockDocumentInput[] =
      rows.length === 0 ? [] : await readAnnouncementDocs(db, args.symbol);

    const events: InsiderEventInput[] = rows.map((r) => ({
      id: r.id,
      date: r.date,
      person: r.person,
      category: r.category,
      action: r.action,
      // BigInt → number at the read. See the header note; a BigInt on the wire
      // throws inside JSON.stringify.
      qty: bigIntToNumber(r.qty),
      value: r.value,
      source: r.source,
    }));

    const section = buildInsiderSection(events, {
      now: now(),
      documents: docs,
      limit: INSIDER_DISPLAY_LIMIT,
    });

    const newest = section.months[0]?.events[0] ?? null;
    const envelope = withProvenance<StockInsiderSectionData>(section, {
      // The panel mixes three feeds (NSE_PIT / NSE_SAST / NSE_PLEDGE). The chip
      // names the feed that produced the NEWEST event, so `source` and `asOf`
      // describe the SAME row rather than a source label floating free of the
      // timestamp beside it; the full set goes in the note.
      source: newest?.source ?? null,
      asOf: newest?.dateIso ?? null,
      note: describeInsiderSources(rows),
      emptyOverride: section.months.length === 0,
    });

    if (!envelope.empty) {
      await writeCache(
        SECTIONS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        // Filings land in weekly sweeps, but a fresh one during a session is
        // exactly what a user is looking for — so the live TTL is short.
        { ttl: ttl(30 * 60, 6 * 60 * 60) },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockInsiderSection error:", error);
    return { success: false, error: "Failed to load insider activity" };
  }
}

/**
 * Announcement-type documents for the heuristic link.
 *
 * NOTE: `StockDocument` has no filing-date column — only `period`, `fetchedAt`,
 * `createdAt`, `updatedAt`. `fetchedAt` (our ingest time) is therefore the
 * nearest available proxy for "when this document happened", and it is passed
 * in explicitly so the matcher stays honest about what it is comparing. This is
 * exactly why the resulting link is labelled "likely" and never asserted.
 */
async function readAnnouncementDocs(
  db: typeof prisma,
  symbol: string,
): Promise<StockDocumentInput[]> {
  const docs = await db.stockDocument.findMany({
    // Same list the matcher filters on, spread from ONE definition — a DB
    // predicate that drifted from `isAnnouncementDoc` would silently stop
    // offering a whole doc type without any code path looking wrong.
    where: { symbol, docType: { in: [...ANNOUNCEMENT_DOC_TYPES] } },
    orderBy: { fetchedAt: "desc" },
    take: INSIDER_DOC_READ_LIMIT,
    select: {
      id: true,
      docType: true,
      title: true,
      sourceUrl: true,
      fetchedAt: true,
    },
  });
  return docs.map((d) => ({
    id: d.id,
    docType: d.docType,
    title: d.title,
    sourceUrl: d.sourceUrl,
    date: d.fetchedAt,
  }));
}

function describeInsiderSources(
  rows: ReadonlyArray<{ source: string }>,
): string | undefined {
  const distinct = [...new Set(rows.map((r) => r.source).filter(Boolean))];
  if (distinct.length <= 1) return undefined;
  return `Combines ${distinct.join(", ")}.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 14c.6 — Bulk & block deals
// ═══════════════════════════════════════════════════════════════════════════

// ── Feed coverage helpers (MONEY-1205) ──────────────────────────────────────
//
// These live HERE rather than in `@usemoney/core/market-data` for one blunt
// reason: the coverage read is a service-layer query (`groupBy(date)` across
// every symbol) and its summariser is the only consumer. They are still pure
// and exported, so the run detection is unit-tested directly rather than
// through a Prisma fake.

const COVERAGE_MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC calendar day as `YYYY-MM-DD`. Deal dates are UTC-midnight IST days. */
function coverageIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function coverageToDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Feed coverage (MONEY-1205) ──────────────────────────────────────────────
//
// The section headlines `asOf` = this stock's newest print. On a quiet name
// that reads "latest 07 Nov 2024", which a reader parses as A DEAD FEED — and
// on prod it is not: the newest print anywhere is 2026-08-17. What IS true is
// that the archive only became a daily job partway through: prod holds
// 58–152 prints a day from 2026-08-04 onward and 2–3 a day for years before
// that, which is a sparse sampled backfill, not a series.
//
// So the section states the WINDOW it covers instead of leaving the reader to
// infer one from a single date. The distinction is computed, never asserted:
// a day the whole market produced two prints on did not have two prints.

/** One day of the feed, market-wide. Fed by a `groupBy(date)` count. */
export interface DealsFeedDay {
  date: Date | string;
  /** Rows we hold for that day, ACROSS ALL SYMBOLS. */
  count: number;
}

/**
 * How many market-wide prints a day must carry to count as covered.
 *
 * Measured on prod (2026-08-17): a covered session runs 58–152 prints across
 * the market; every day of the backfill tail runs 2–3. Twenty sits in the
 * empty middle of that gap, so the threshold does not have to be exact to be
 * right. It is a floor on OUR COVERAGE, never a claim about the market — a
 * genuinely quiet session that fell below it simply ends the run early, which
 * understates coverage rather than overstating it.
 */
export const DEALS_COVERAGE_MIN_ROWS_PER_DAY = 20;

/**
 * The longest gap between two covered days that still reads as continuous.
 *
 * Five calendar days spans a weekend plus a holiday, which is the real shape of
 * an Indian trading week (prod's run has a 4-day step across Independence Day).
 * A longer window would swallow the backfill tail, whose steps are 4–5 days
 * apart as well — which is exactly why the ROW COUNT above does the work and
 * this only stops the run from jumping a month.
 */
export const DEALS_COVERAGE_MAX_GAP_DAYS = 5;

export interface DealsCoverage {
  /** Newest day anywhere in the feed (ISO day). Null when we hold nothing. */
  latestDay: string | null;
  /**
   * First day of the newest UNBROKEN run of covered days (ISO day), or null
   * when the newest day itself is below the threshold — i.e. we cannot claim
   * continuous coverage at all right now.
   */
  continuousFrom: string | null;
  /** Days observed in that run. Zero when `continuousFrom` is null. */
  continuousDays: number;
}

/**
 * Summarise what the deals feed actually covers, from per-day market-wide counts.
 *
 * Pure and order-insensitive: it sorts its own input. The run is anchored at the
 * NEWEST covered day and walks backwards, so a covered stretch in 2024 followed
 * by a two-year hole never gets reported as today's coverage.
 */
export function summariseDealsCoverage(
  days: ReadonlyArray<DealsFeedDay>,
): DealsCoverage {
  const parsed = days
    .map((d) => ({ when: coverageToDate(d.date), count: Number(d.count) }))
    .filter(
      (d): d is { when: Date; count: number } =>
        d.when !== null && Number.isFinite(d.count),
    )
    .sort((a, b) => b.when.getTime() - a.when.getTime());

  if (parsed.length === 0)
    return { latestDay: null, continuousFrom: null, continuousDays: 0 };

  const latestDay = coverageIsoDay(parsed[0]!.when);

  // The run must START at the newest day we hold. If the most recent session
  // is a two-print artefact there is no current coverage to describe, and
  // saying "continuous since 2026-08-04" while the last three weeks are empty
  // would be the same lie in a new place.
  if (parsed[0]!.count < DEALS_COVERAGE_MIN_ROWS_PER_DAY)
    return { latestDay, continuousFrom: null, continuousDays: 0 };

  let from = parsed[0]!.when;
  let observed = 1;
  for (let i = 1; i < parsed.length; i += 1) {
    const day = parsed[i]!;
    if (day.count < DEALS_COVERAGE_MIN_ROWS_PER_DAY) break;
    const gap = (from.getTime() - day.when.getTime()) / COVERAGE_MS_PER_DAY;
    if (gap > DEALS_COVERAGE_MAX_GAP_DAYS) break;
    from = day.when;
    observed += 1;
  }

  return {
    latestDay,
    continuousFrom: coverageIsoDay(from),
    continuousDays: observed,
  };
}

/**
 * How far back the coverage probe looks.
 *
 * Long enough to reach past the covered run into the sparse tail (prod's run is
 * seven sessions), short enough that the grouped scan stays a handful of rows.
 */
const DEALS_COVERAGE_LOOKBACK_DAYS = 200;

export interface StockDealsSectionData extends DealsSection {
  /**
   * What the FEED covers, market-wide — not what this stock has (MONEY-1205).
   *
   * The section headlines `asOf` = this stock's newest print, and on a quiet
   * name that reads "latest 07 Nov 2024", which a reader parses as a dead feed.
   * It is not: the newest print anywhere on prod is 2026-08-17. Null when the
   * probe could not run — an unavailable window is not a claim of no coverage,
   * so the UI says nothing rather than something wrong.
   */
  coverage: DealsCoverage | null;
}

/**
 * One market-wide coverage probe, cached globally — MONEY-1205.
 *
 * NOT per symbol: the answer is a property of the FEED, so a per-symbol key
 * would run the same grouped scan once per stock page and cache thousands of
 * copies of one fact. The TTL is long because the answer changes once a day, at
 * most, when the nightly job lands.
 *
 * Failure returns null, never a fabricated window. A probe that could not run
 * is "we do not know how much we cover", and the panel then says nothing about
 * coverage — which is the only honest reading and, unlike a guessed window, is
 * not cached (see below).
 */
async function readDealsCoverage(
  deps: Pick<ResolvedDeps, "db" | "readCache" | "writeCache" | "now">,
): Promise<DealsCoverage | null> {
  const { db, readCache, writeCache, now } = deps;
  const cached = await readCache<DealsCoverage>(
    SECTIONS_CACHE_NS,
    CACHE_SCOPE,
    DEALS_COVERAGE_CACHE_KEY,
  );
  if (cached) return cached;
  try {
    const cutoff = new Date(
      now().getTime() - DEALS_COVERAGE_LOOKBACK_DAYS * COVERAGE_MS_PER_DAY,
    );
    const groups = await db.institutionalDeal.groupBy({
      by: ["date"],
      where: { date: { gte: cutoff } },
      _count: { _all: true },
      orderBy: { date: "desc" },
    });
    const coverage = summariseDealsCoverage(
      groups.map((g) => ({ date: g.date, count: g._count._all })),
    );
    // Only a REAL answer is cached. `latestDay: null` is "we hold nothing",
    // which on a populated database means the probe saw an empty window — the
    // standing rule is that a couldn't-determine never gets pinned for a TTL.
    if (coverage.latestDay !== null) {
      await writeCache(
        SECTIONS_CACHE_NS,
        CACHE_SCOPE,
        DEALS_COVERAGE_CACHE_KEY,
        coverage,
        undefined,
        { ttl: DEALS_COVERAGE_TTL_S },
      );
    }
    return coverage;
  } catch (error) {
    // Soft: the deals panel is fully usable without a coverage line. A throw
    // here must not take the section down with it.
    console.error("readDealsCoverage error:", error);
    return null;
  }
}

/**
 * ONE key for the whole feed — the answer is not per symbol, so neither is the
 * cache. Without this the grouped scan runs once per stock page.
 */
const DEALS_COVERAGE_CACHE_KEY = "deals-feed-coverage";
/** The window moves once a day at most, when the nightly deals job lands. */
const DEALS_COVERAGE_TTL_S = 6 * 60 * 60;

/**
 * The coverage window as one sentence, or null when there is nothing to say.
 *
 * Deliberately does NOT mention the backfill tail unless a continuous run
 * exists to contrast it with: "sparse before X" with no X is noise, and
 * claiming continuity we have not measured is the bug this replaced.
 */
export function describeDealsCoverage(
  coverage: DealsCoverage | null,
): string | undefined {
  if (!coverage || coverage.latestDay === null) return undefined;
  const latest = coverageDayLabel(coverage.latestDay);
  if (coverage.continuousFrom === null)
    return `Feed's newest disclosed print anywhere is ${latest}.`;
  const from = coverageDayLabel(coverage.continuousFrom);
  return (
    `Daily coverage of this feed runs ${from} → ${latest} ` +
    `(${coverage.continuousDays} sessions). Earlier days are a partial ` +
    `backfill, so a gap before ${from} is not evidence of no print.`
  );
}

const COVERAGE_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `2026-08-04` → `04 Aug 2026`. Returns the input when it will not parse. */
function coverageDayLabel(isoDayStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDayStr);
  if (!m) return isoDayStr;
  const mon = COVERAGE_MONTHS[Number(m[2]) - 1];
  return mon === undefined ? isoDayStr : `${m[3]} ${mon} ${m[1]}`;
}

/**
 * Disclosed bulk and block prints, with repeat counterparties surfaced.
 *
 * `clientName` is the point of this feed — it is the only free Indian source
 * that names WHO traded — so the repeat-buyer roll-up is the section's headline
 * rather than a nicety.
 */
export async function getStockDealsSection(
  args: { symbol: string; exchange: string },
  deps: OwnershipSectionDeps = {},
): Promise<ServiceResult<WithProvenance<StockDealsSectionData>>> {
  const { db, readCache, writeCache, ttl, now } = resolve(deps);
  const cacheKey = `stock-deals:${args.symbol}`;
  const cached = await readCache<WithProvenance<StockDealsSectionData>>(
    SECTIONS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // `@@index([symbol, date])` serves the per-symbol read exactly; the coverage
    // probe rides `@@index([date])` and returns one row per DAY, not per deal
    // (12 groups over 200 days on prod, ~550ms cold). They are independent, so
    // they run together rather than in sequence.
    const [rows, coverage] = await Promise.all([
      db.institutionalDeal.findMany({
        where: { symbol: args.symbol },
        orderBy: { date: "desc" },
        take: DEALS_READ_LIMIT,
        select: {
          id: true,
          date: true,
          securityName: true,
          clientName: true,
          buySell: true,
          qty: true,
          avgPrice: true,
          dealType: true,
          remarks: true,
          source: true,
        },
      }),
      readDealsCoverage({ db, readCache, writeCache, now }),
    ]);

    const deals: DealInput[] = rows.map((r) => ({
      id: r.id,
      date: r.date,
      securityName: r.securityName,
      clientName: r.clientName,
      buySell: r.buySell,
      qty: bigIntToNumber(r.qty),
      avgPrice: r.avgPrice,
      dealType: r.dealType,
      // Null on `-` AND when block.csv omits the column. Passed through as-is;
      // the pure layer nulls the sentinels so the UI never prints "null".
      remarks: r.remarks,
    }));

    const section = buildDealsSection(deals, {
      now: now(),
      limit: DEALS_DISPLAY_LIMIT,
    });

    // The window, in the envelope — so `/v1/stocks/:symbol/deals` and the
    // provenance tooltip carry it too, not just the panel that renders it.
    const coverageNote = describeDealsCoverage(coverage);
    const envelope = withProvenance<StockDealsSectionData>(
      { ...section, coverage },
      {
        source: rows[0]?.source ?? "NSE_DEALS",
        asOf: section.deals[0]?.dateIso ?? null,
        emptyOverride: section.deals.length === 0,
        ...(coverageNote === undefined ? {} : { note: coverageNote }),
      },
    );

    if (!envelope.empty) {
      await writeCache(
        SECTIONS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        // bulk.csv / block.csv are rolling EOD files; during a session there is
        // nothing new to see, after close there is.
        { ttl: ttl(60 * 60, 6 * 60 * 60) },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockDealsSection error:", error);
    return { success: false, error: "Failed to load bulk & block deals" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MONEY-268 — sector institutional picks
// ═══════════════════════════════════════════════════════════════════════════
//
// The sector deep-dive carried two cards, "TOP FII PICK" and "TOP DII PICK",
// hidden behind a comment block because the data they described does not
// exist: `institutional_flows` is keyed `(date, category, segment)` and is
// MARKET-WIDE — 8 rows on prod, no `symbol` column, and NSE's cash-flow file
// has no per-stock dimension to add. The ticket's original model (sector flow
// distributed by index weight) would therefore have multiplied a national
// aggregate by a weight and printed the product as a per-stock fact.
//
// `institutional_deals` answers a NARROWER question truthfully instead: which
// names in this sector saw the largest disclosed bulk/block prints this week,
// and on which side. 3,386 rows on prod, ~800 in the last 30 days, every one
// carrying a symbol, a side, a quantity, a price and a named counterparty.
// It is not "FII flow" and the card must not claim to be — see the caption in
// SectorDeepDive.tsx.

/**
 * How many TRADING SESSIONS the window covers.
 *
 * Sessions, not calendar days, and the sessions are taken from the FEED rather
 * than from a holiday calendar: the last N distinct dates that
 * `institutional_deals` actually holds. Two properties follow, and both matter.
 *
 * First, a market holiday or a missed nightly run shortens the calendar span
 * instead of silently emptying the window — 2026-08-04 → 2026-08-17 is six
 * sessions spanning fourteen days on prod right now.
 *
 * Second, the window is MARKET-WIDE, not per-sector. A sector with no prints in
 * the last seven sessions must render the honest empty state, not reach back
 * three months for its own last seven active days and label the result "this
 * week".
 */
const PICKS_SESSIONS = 7;
/** Rows on each side of the card. */
const PICKS_LIMIT = 5;
/**
 * Backstop on the constituent read, mirroring `SECTOR_INSTRUMENT_CAP` in
 * apps/web's sector-deep-dive action. The largest real NSE sector is ~380 rows,
 * so this never binds — it exists so the query is not unbounded.
 */
const PICKS_INSTRUMENT_CAP = 2000;
/**
 * Backstop on the deals read. Prod prints ~120 deals a session MARKET-WIDE, so
 * one sector over seven sessions is two orders of magnitude below this. If it
 * ever binds, the truncation is REPORTED rather than silently ranking a
 * date-ordered prefix.
 */
const PICKS_DEALS_READ_LIMIT = 5000;
/**
 * Below one rupee a net is float noise from two prints that cancelled, not a
 * direction. Such a symbol appears on NEITHER side — putting it on one would be
 * a claim the arithmetic does not support.
 */
const PICKS_NET_EPSILON_RUPEES = 1;

/**
 * `InstitutionalDeal.qty` → number, with the precision loss made VISIBLE.
 *
 * `Number()` on a BigInt above 2^53−1 does not throw and does not round-trip:
 * `Number(9007199254740993n) === 9007199254740992`. That is the whole reason
 * the column is BigInt rather than Int, so silently laundering it back through
 * a double is the one conversion this feed cannot afford to do blindly.
 *
 * The largest print on prod today is 170,116,200 — five orders of magnitude
 * inside the safe range — so `exact` is true for every real row. It is returned
 * anyway rather than assumed, because the assumption is exactly what would stop
 * being checked on the day a bonus-issue-inflated penny name breaks it.
 *
 * Distinct from `bigIntToNumber` above, which answers a different question
 * (null-preserving, non-finite-rejecting) for a nullable column.
 */
export function dealQtyToNumber(qty: bigint): {
  value: number;
  exact: boolean;
} {
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  return { value: Number(qty), exact: qty <= limit && qty >= -limit };
}

/** One row of a picks card. */
export interface SectorInstitutionalPick {
  symbol: string;
  /** The exchange's descriptive name, or `""` when the file dropped it. */
  securityName: string;
  /**
   * Net traded value in RUPEES over the window: `Σ (BUY ? +1 : −1) × qty ×
   * avgPrice`. Signed — negative is net selling. Rupees rather than crore
   * because rupees is the unit the multiplication produces; the render boundary
   * divides.
   */
  netValue: number;
  /** Prints that went into `netValue` — both sides, this symbol, this window. */
  dealCount: number;
  /**
   * Class of the counterparty with the largest |net| in this symbol. NOT a
   * claim about the whole row: a symbol's net can be the sum of an FII buying
   * and a domestic broker selling, and this names only the larger leg.
   */
  clientClass: InstitutionalClientClass;
  /** That counterparty's name, verbatim from the exchange file. */
  dominantClient: string;
}

export interface SectorInstitutionalPicksData {
  /** Largest net BUYS, most positive first. Never contains a net seller. */
  buys: SectorInstitutionalPick[];
  /** Largest net SELLS, most negative first. Never contains a net buyer. */
  sells: SectorInstitutionalPick[];
  /** Sessions the window actually covered — may be < the request near a cold start. */
  sessions: number;
  /** Oldest / newest session in the window, `YYYY-MM-DD`, or null when empty. */
  fromIso: string | null;
  toIso: string | null;
  /**
   * True when some `qty` exceeded 2^53−1 and its conversion was inexact. Always
   * false on today's data; surfaced so the day it flips is a signal rather than
   * a rounding no one notices.
   */
  qtyPrecisionLoss: boolean;
}

/** What the aggregator needs from a row. Decoupled from the Prisma select. */
export interface SectorDealInput {
  symbol: string;
  securityName: string;
  clientName: string;
  buySell: string;
  qty: bigint;
  avgPrice: number;
}

/**
 * Group prints by symbol, net them, and take the top N of each side.
 *
 * Pure, so the ordering rules below are testable without a database:
 *
 *   - **Sign** comes from `buySell` and nothing else. A row that is neither
 *     BUY nor SELL after trimming and upcasing is SKIPPED, not defaulted —
 *     defaulting a corrupt side to SELL would move real rupees to the wrong
 *     list, which is worse than dropping the print.
 *   - **Ties break deterministically**: net descending, then symbol ascending.
 *     Without the symbol tie-break, two symbols with an identical net swap
 *     places between requests according to Mongo's row order, and a card that
 *     reorders itself on refresh reads as live data that is not.
 *   - **A zero net is on neither side.** A symbol whose buys and sells
 *     cancelled has no direction to report.
 *   - Non-finite `avgPrice` (a `-` that parsed to NaN) is skipped for the same
 *     reason as a bad side: one NaN poisons the whole symbol's sum, and a NaN
 *     sorts unpredictably rather than loudly.
 */
export function aggregateSectorInstitutionalPicks(
  deals: readonly SectorDealInput[],
  opts: { limit?: number } = {},
): Pick<SectorInstitutionalPicksData, "buys" | "sells" | "qtyPrecisionLoss"> {
  const limit = opts.limit ?? PICKS_LIMIT;

  interface Acc {
    symbol: string;
    securityName: string;
    net: number;
    count: number;
    byClient: Map<string, number>;
  }
  const bySymbol = new Map<string, Acc>();
  let qtyPrecisionLoss = false;

  for (const d of deals) {
    // `dealSide` rather than a local compare: it is the section's existing,
    // already-tested reader of this column and it accepts the `B`/`S`
    // abbreviations the raw files sometimes carry. Null is SKIPPED, not
    // defaulted — see the doc block above.
    const side = dealSide(d.buySell);
    if (side === null) continue;
    if (!Number.isFinite(d.avgPrice)) continue;

    const { value: qty, exact } = dealQtyToNumber(d.qty);
    if (!exact) qtyPrecisionLoss = true;
    const signed = (side === "BUY" ? 1 : -1) * qty * d.avgPrice;
    if (!Number.isFinite(signed)) continue;

    const acc = bySymbol.get(d.symbol) ?? {
      symbol: d.symbol,
      // First non-empty name wins. `securityName` defaults to "" when the file
      // drops the column, and an empty string must not overwrite a real one.
      securityName: "",
      net: 0,
      count: 0,
      byClient: new Map<string, number>(),
    };
    if (acc.securityName === "" && d.securityName !== "") {
      acc.securityName = d.securityName;
    }
    acc.net += signed;
    acc.count += 1;
    acc.byClient.set(
      d.clientName,
      (acc.byClient.get(d.clientName) ?? 0) + signed,
    );
    bySymbol.set(d.symbol, acc);
  }

  const rows: SectorInstitutionalPick[] = [];
  for (const acc of bySymbol.values()) {
    // Dominant = largest |net| in this symbol; ties by name, so the chip does
    // not flip between two equally-sized counterparties on refresh.
    let dominantClient = "";
    let dominantAbs = -1;
    for (const [client, net] of acc.byClient) {
      const abs = Math.abs(net);
      if (
        abs > dominantAbs ||
        (abs === dominantAbs && client < dominantClient)
      ) {
        dominantAbs = abs;
        dominantClient = client;
      }
    }
    rows.push({
      symbol: acc.symbol,
      securityName: acc.securityName,
      netValue: acc.net,
      dealCount: acc.count,
      clientClass: classifyInstitutionalClient(dominantClient),
      dominantClient,
    });
  }

  const buys = rows
    .filter((r) => r.netValue >= PICKS_NET_EPSILON_RUPEES)
    .sort((a, b) => b.netValue - a.netValue || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, limit);
  const sells = rows
    .filter((r) => r.netValue <= -PICKS_NET_EPSILON_RUPEES)
    .sort((a, b) => a.netValue - b.netValue || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, limit);

  return { buys, sells, qtyPrecisionLoss };
}

/**
 * Largest disclosed net buys and sells among a sector's constituents.
 *
 * Reads three things and joins them in memory: the feed's last
 * `PICKS_SESSIONS` distinct dates, the sector's NSE constituents, and the
 * prints those symbols made inside that window.
 *
 * The constituent predicate deliberately mirrors apps/web's sector deep-dive
 * action — `isActive · EQUITY · exchange NSE · sector` — so the card ranks
 * exactly the population the panel's count, m-cap and weighted stats are
 * computed over. Dropping the exchange filter would double-count the ~278
 * dual-listed names, and dropping `EQUITY` would let an ETF into a sector card.
 */
export async function getSectorInstitutionalPicks(
  args: { sector: string; sessions?: number },
  deps: OwnershipSectionDeps = {},
): Promise<ServiceResult<WithProvenance<SectorInstitutionalPicksData>>> {
  const { db, readCache, writeCache, ttl, now } = resolve(deps);
  const sessions = args.sessions ?? PICKS_SESSIONS;
  const cacheKey = `sector-picks:${args.sector}:${sessions}`;
  const cached = await readCache<WithProvenance<SectorInstitutionalPicksData>>(
    SECTIONS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // Independent reads: the session window rides `@@index([date])`, the
    // constituents ride `(exchange, sector, isActive)`. Neither needs the
    // other's answer, so they run together.
    const [days, instruments] = await Promise.all([
      db.institutionalDeal.groupBy({
        by: ["date"],
        _count: { _all: true },
        orderBy: { date: "desc" },
        take: sessions,
      }),
      db.instrumentMapping.findMany({
        where: {
          isActive: true,
          instrumentType: "EQUITY",
          exchange: "NSE",
          sector: args.sector,
        },
        select: { symbol: true },
        take: PICKS_INSTRUMENT_CAP,
      }),
    ]);

    // `groupBy` returned newest-first, so the LAST element is the window floor.
    const oldest = days[days.length - 1]?.date ?? null;
    const newest = days[0]?.date ?? null;
    const dayIso = (d: Date | null): string | null =>
      d === null ? null : d.toISOString().slice(0, 10);

    // The WINDOW is reported even when this sector has nothing in it. "No
    // prints between 04 Aug and 17 Aug" and "we could not establish a window at
    // all" are different statements, and only the second one is a reason to
    // doubt the feed — so an empty sector still carries its dates, and null
    // dates mean the feed itself is empty.
    const empty = (): WithProvenance<SectorInstitutionalPicksData> =>
      withProvenance<SectorInstitutionalPicksData>(
        {
          buys: [],
          sells: [],
          sessions: days.length,
          fromIso: dayIso(oldest),
          toIso: dayIso(newest),
          qtyPrecisionLoss: false,
        },
        { source: "NSE_DEALS", asOf: dayIso(newest), emptyOverride: true },
      );

    if (oldest === null || instruments.length === 0) {
      return { success: true, data: empty() };
    }

    const symbols = instruments.map((i) => i.symbol);

    const rows = await db.institutionalDeal.findMany({
      where: { symbol: { in: symbols }, date: { gte: oldest } },
      // Ordered so a truncation at the cap drops the OLDEST prints rather than
      // an arbitrary subset — a bounded, explicable loss instead of a silent
      // reshuffle of the ranking.
      orderBy: { date: "desc" },
      take: PICKS_DEALS_READ_LIMIT,
      select: {
        symbol: true,
        securityName: true,
        clientName: true,
        buySell: true,
        qty: true,
        avgPrice: true,
      },
    });
    if (rows.length >= PICKS_DEALS_READ_LIMIT) {
      console.warn(
        `[sector-picks] read cap reached for ${args.sector} ` +
          `(${PICKS_DEALS_READ_LIMIT} rows) — the ranking is drawn from the ` +
          "newest prints only. Raise PICKS_DEALS_READ_LIMIT.",
      );
    }

    const agg = aggregateSectorInstitutionalPicks(rows, { limit: PICKS_LIMIT });
    const data: SectorInstitutionalPicksData = {
      ...agg,
      sessions: days.length,
      fromIso: dayIso(oldest),
      toIso: dayIso(newest),
    };
    if (data.qtyPrecisionLoss) {
      console.warn(
        `[sector-picks] ${args.sector}: a deal qty exceeded 2^53−1, so its ` +
          "value is approximate. Widen the aggregation before trusting it.",
      );
    }

    const isEmpty = data.buys.length === 0 && data.sells.length === 0;
    const envelope = isEmpty
      ? empty()
      : withProvenance<SectorInstitutionalPicksData>(data, {
          source: "NSE_DEALS",
          asOf: data.toIso,
          emptyOverride: false,
        });

    // Standing rule: an empty answer is never cached. A sector with no prints
    // this week gets one cheap query per request rather than a pinned "nothing
    // here" that outlives the next nightly load.
    if (!envelope.empty) {
      await writeCache(
        SECTIONS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        // Same argument as the per-stock deals section: bulk.csv / block.csv
        // are rolling EOD files, so nothing changes during a session.
        { ttl: ttl(60 * 60, 6 * 60 * 60) },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getSectorInstitutionalPicks error:", error);
    return { success: false, error: "Failed to load institutional deals" };
  }
}
