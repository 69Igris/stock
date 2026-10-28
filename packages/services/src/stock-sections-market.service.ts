/**
 * Stock-page market sections service — MONEY-1204 (P14 / 14c.1 · 14c.2 · 14c.3).
 *
 * The read side of three data-engine tables that have shipped for months with
 * NO product reader at all:
 *
 *   14c.1  `StockFlag` + `IndexMembership`  → header badges + index chips
 *   14c.2  `DailyPrice.deliveryPct` et al   → overview delivery chip + trend
 *   14c.3  `DerivativeSummary` + `SlbPosition` + `MwplDaily` + `StockFlag`
 *          (`FO_BAN`)                       → the F&O section, F&O names only
 *
 * GLOBAL data: market/reference facts with no user scope, so — exactly like
 * `stock-tabs.service` / `discover-market.service` — there is no `userId`, no
 * demo branch and no `revalidatePath`. `apps/web`'s server actions are thin
 * wrappers over these functions rather than a second copy of the logic, which
 * is how the standing "apps/api must not drift from the server actions" rule is
 * satisfied by construction instead of by review (precedent:
 * `apps/web/lib/actions/discover-indices.ts` over `getIndices`).
 *
 * Everything shaped is returned inside `WithProvenance` — see `./provenance`
 * for why that envelope is load-bearing rather than decorative. `empty` is the
 * field the UI branches on, and because all three payloads are OBJECTS (not
 * lists) each one passes an explicit `emptyOverride`; that is the documented
 * exception, not a shortcut.
 *
 * ## Query shapes, and why they are these shapes
 *
 * `stock_flags` is a ~7.5M-row APPEND-ONLY table and this is its first
 * application reader, so the shape is chosen deliberately:
 *
 *   - Per-KIND queries, fanned out with `Promise.all`, each bounded by `take`.
 *     That hits `@@index([symbol, kind, date(sort: Desc)])` end-to-end — index
 *     equality on `(symbol, kind)`, index order on `date` — so there is no
 *     in-memory SORT stage and no unbounded fetch of a symbol's entire flag
 *     history. The obvious alternative (`where: {symbol}` + `orderBy: date`)
 *     can only use the `symbol` prefix and must then sort every row the stock
 *     has ever accrued, which for a daily-published kind like `WK52_HIGH_LOW`
 *     grows without bound.
 *   - The SAME page serves both jobs the section needs: the current-state
 *     reduce and the history popover. One fetch, two uses.
 *
 * `DailyPrice` is the one model here NOT keyed on `(symbol, exchange)` — it is
 * `@@unique([instrumentId, date])` — so it, and only it, resolves an
 * `InstrumentMapping` first.
 *
 * ## Absence discipline
 *
 * Missing rows are `success: true` with an empty envelope; never an error,
 * never a 404. `""` / `"-"` / blank ⇒ null, never 0 — including at the render
 * boundary, so nothing here coalesces a null metric with `?? 0`.
 *
 * Empty results are NOT cached. A cached "nothing here" is the fail-open
 * default the standing rule forbids, and the queries it saves are single
 * bounded index lookups.
 *
 * ## BigInt
 *
 * `DerivativeSummary.{futOi,futOiChange,nearFutOi,callOi,putOi,callVol,putVol}`
 * and `DailyPrice.deliveryQty` are Prisma `BigInt`. `JSON.stringify` THROWS on
 * a BigInt, so handing a raw row to a server action or a Hono response crashes
 * at the serialisation boundary rather than at the query — a failure that
 * shows up only for F&O names and only in production. Every one of them is
 * coerced to `number` inside `@usemoney/core/market-data`'s view builders
 * before it can reach a boundary.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core/cache";
import { getNseMarketStatus } from "@usemoney/core/market-data/market-hours";
import {
  buildDerivativeSummaryView,
  buildIndexChips,
  buildMwplSnapshot,
  buildSlbLadder,
  buildStockFlagBadges,
  computeDeliveryTrend,
  formatStockFlagValue,
  selectHeadlineStockFlagBadges,
  type DeliveryTrend,
  type DerivativeSummaryView,
  type MwplSnapshot,
  type SlbLadder,
  type StockFlagBadge,
  type StockIndexChip,
} from "@usemoney/core/market-data";
import type { ServiceResult } from "./types";
import { latestAsOf, withProvenance, type WithProvenance } from "./provenance";

// Same cache module + scope every global stock-detail read uses
// (stock-tabs.service.ts:55). Keeps one namespace to invalidate.
const TABS_CACHE_NS = "discover" as const;
const CACHE_SCOPE = "_global" as const;

/**
 * Flag rows fetched PER KIND.
 *
 * 60 sessions is roughly a quarter of trading days: long enough that the
 * history popover shows a meaningful stint and that most runs resolve inside
 * the window, short enough that the seven parallel reads stay trivial. A run
 * that does hit the edge is reported as such (`runReachesWindowEdge`) instead
 * of being silently truncated into a confident wrong start date.
 */
const FLAG_ROWS_PER_KIND = 60;

/** Sessions of `DailyPrice` read for the delivery trend (60-day mini-series). */
const DELIVERY_SESSIONS = 60;

/**
 * The seven `StockFlagKind`s, queried individually.
 *
 * Listed here rather than derived from the TS union because the union is a
 * type and this is a runtime value; the `stock-flags.ts` module doc is the
 * source of truth for what may appear in the column, and a new NSE family
 * added there needs one line added here.
 */
const FLAG_KINDS = [
  "FO_BAN",
  "SURVEILLANCE",
  "SERIES_CHANGE",
  "BAND_CHANGE",
  "PRICE_BAND",
  "SHORT_SELLING",
  "WK52_HIGH_LOW",
] as const;

/** Index chips fetched. No stock is in more than a handful of NSE indices. */
const MAX_INDEX_CHIPS = 24;

// ── Wire types ───────────────────────────────────────────────────────────────

/** One historical `StockFlag` row, for the per-kind history popover. */
export interface StockFlagHistoryRow {
  /** ISO trading day the flag describes. */
  date: string;
  /**
   * Stored `value`, VERBATIM. STAYS — `display` sits BESIDE it, never in place
   * of it. The verbatim column is what makes a stored row checkable against
   * what NSE published, and it is the input a better decode table re-reads.
   */
  value: string;
  /**
   * `value` decoded for a human, via the ONE shared decoder
   * (`formatStockFlagValue`) — MONEY-1205.
   *
   * Computed HERE rather than at each render boundary because there are four of
   * them: the web popover, `/v1/stocks/:symbol/flags` (mobile gets this exact
   * object), the research tool and the alert/briefing writers. Three of the
   * four were shipping raw JSON — a price-band history row read `{"band":"5"}`.
   *
   * SURVEILLANCE is byte-identical to `value`; that is the decoder's contract,
   * not an accident of this call site.
   */
  display: string;
  series: string | null;
  source: string | null;
}

export interface StockFlagsAndIndexesData {
  /**
   * Current state, one badge per (kind, simultaneously-active value).
   *
   * The COMPLETE set, unfiltered. The screener reads `PRICE_BAND` off it and
   * research returns every kind, so narrowing this to the header's taste would
   * silently drop data from two other products. `headline` is the narrowed one.
   */
  badges: StockFlagBadge[];
  /**
   * The subset the header strip leads with — `selectHeadlineStockFlagBadges`.
   *
   * USUALLY EMPTY, and that is the feature. `PRICE_BAND` and `WK52_HIGH_LOW`
   * publish for the whole cash universe every session (3,489 and 3,325 rows on
   * 2026-08-17), so before this every stock page rendered a "flag" strip and
   * the strip's presence meant nothing. A flag is an exception by definition.
   * Nothing is lost: a badge excluded here is still in `badges`, and its rows
   * are still in `history`.
   */
  headline: StockFlagBadge[];
  /** `kind` → newest-first rows, for the badge's history popover. */
  history: Record<string, StockFlagHistoryRow[]>;
  /** Open index memberships. `fallback: true` ⇒ served from IndexConstituent. */
  indexes: StockIndexChip[];
  /**
   * Newest flag day we hold FOR THIS STOCK (ISO). The section's `asOf`.
   *
   * NOT the `isCurrent` reference any more — that is `referenceDayByKind`, per
   * kind. A single day was the fail-open this ticket fixed; it survives here
   * only as "how fresh is this stock's flag data", which is the question it
   * actually answers. Null when the stock has no flag rows at all.
   */
  referenceDay: string | null;
  /**
   * `kind` → that kind's newest MARKET-WIDE day (ISO day), or null when the
   * family has not landed for this environment. The denominator `isCurrent` was
   * computed against, exposed so a client can show its own staleness read
   * rather than re-deriving one.
   */
  referenceDayByKind: Record<string, string | null>;
}

export interface StockDeliveryData extends DeliveryTrend {
  /**
   * `DailyPrice.source` of the session the headline came from, e.g.
   * "BHAVCOPY" — see `latest`. NOT the newest row's: those disagree exactly
   * when the newest row has no delivery columns to headline.
   */
  priceSource: string | null;
}

export interface StockFoBanState {
  /** Newest `FO_BAN` day (ISO). */
  date: string;
  /** First day of the unbroken ban run ending at `date` (ISO). */
  since: string;
  observedSessions: number;
  /** `since` is a lower bound — the run filled the fetched window. */
  runReachesWindowEdge: boolean;
  /**
   * True when the ban day is at or after the newest `DerivativeSummary` day,
   * i.e. the ban is in force as of the last session we have F&O data for.
   * Derived from the data's own trading days, never from the wall clock.
   */
  active: boolean;
}

export interface StockDerivativesData {
  /**
   * The gate. False ⇒ the stock has NO `DerivativeSummary` row and the whole
   * section must not render. A non-F&O stock showing an empty F&O tab reads as
   * a broken page, not as "this stock has no derivatives".
   */
  isFno: boolean;
  summary: DerivativeSummaryView | null;
  /** Latest SLB day's per-series ladder. NEVER collapsed across series. */
  slb: SlbLadder | null;
  slbDate: string | null;
  mwpl: MwplSnapshot | null;
  ban: StockFoBanState | null;
}

// ── Deps seam ────────────────────────────────────────────────────────────────

/**
 * Injectable collaborators, same seam as `StockTabsDeps`.
 *
 * `@usemoney/services` runs its suite as ESM with no module mocking, so the
 * only way to assert the real code path's query shape, cache key and TTL is to
 * hand it fakes. That is what these are for — they are not a plugin system.
 */
export interface StockSectionsMarketDeps {
  prisma?: typeof prisma;
  getCached?: typeof getCached;
  setCached?: typeof setCached;
  getNseMarketStatus?: () => { isLive: boolean };
}

interface ResolvedDeps {
  db: typeof prisma;
  readCache: typeof getCached;
  writeCache: typeof setCached;
  ttl: (live: number, closed: number) => number;
}

function resolve(deps: StockSectionsMarketDeps): ResolvedDeps {
  const marketStatus = deps.getNseMarketStatus ?? getNseMarketStatus;
  return {
    db: deps.prisma ?? prisma,
    readCache: deps.getCached ?? getCached,
    writeCache: deps.setCached ?? setCached,
    ttl: (live, closed) => (marketStatus().isLive ? live : closed),
  };
}

interface SymbolArgs {
  symbol: string;
  exchange: string;
}

// ════════════════════════════════════════════════════════════════════════════
// 14c.1 — flags + index chips
// ════════════════════════════════════════════════════════════════════════════

/**
 * Header badges (current `StockFlag` state per kind) + open index memberships.
 *
 * ONE call rather than two because both feed the same strip of chrome above the
 * price, and a header that renders in two waves is worse than one that renders
 * slightly later. The envelope's `asOf` is the FLAGS' newest day — they are the
 * headline datum and the one whose staleness matters; each index chip carries
 * its own `lastSeen` inside the payload, because membership and surveillance do
 * not update on the same cadence and one shared timestamp would misdescribe
 * whichever it did not come from.
 *
 * INDEX SOURCE ORDER. `IndexMembership` is preferred: it is point-in-time, has
 * `@@index([symbol])`, and its `removedOn: null` predicate is a real open
 * interval. `IndexConstituent` is the fallback and is queried ONLY when
 * membership yields nothing, because it has NO `[symbol]` index — its indexes
 * are `@@unique([indexId, symbol])`, `@@index([indexId])` and
 * `@@index([indexId, rank])`, all of which need `indexId` in the predicate — so
 * a symbol-only read is a collection scan.
 *
 * That scan is affordable HERE and nowhere else, and the bound is worth stating
 * because it is a bound on breadth, not on time: `index-constituent-sync`
 * rewrites the collection from `ALL_INDEX_IDS` = 22 `STATIC_INDICES` +
 * 14 `MCAP_RANK_SPECS` ids, whose slot ranges sum to roughly 3.5–4k rows, and
 * that number does not grow as market history accrues. Do not generalise the
 * fallback to a cross-sectional query, where the same scan runs per row.
 */
/**
 * Cache key for the per-kind market-wide reference days. SYMBOL-INDEPENDENT.
 *
 * That is the whole reason it is cached separately from the section envelope:
 * the map is identical for every stock on the site, so folding it into the
 * per-symbol entry would re-derive it once per symbol per TTL window.
 */
const FLAG_REFERENCE_CACHE_KEY = "stock-flags-reference-days";

/**
 * `kind` → the newest day THAT KIND published, market-wide (ISO day), or null
 * when the family has not landed at all.
 *
 * ## Why this exists (MONEY-1205)
 *
 * `buildStockFlagBadges` decides `isCurrent` by comparing a badge's day against
 * a reference. Handed ONE day for every kind, the whole-universe families set
 * the bar — `PRICE_BAND` and `WK52_HIGH_LOW` publish 3,489 and 3,325 rows every
 * single session — and every sparser family reads as stale the moment its own
 * file skips a day. HDFCBANK's newest `SHORT_SELLING` row rendered as "Short
 * sold 106 (ended)" for exactly this reason: the row WAS the newest that family
 * had for the stock, and it lost to yesterday's price band. The denominator has
 * to be per kind, and the two sibling readers (`flagsReferenceDayByKind` in the
 * screener, `market-structure-store` in research) already do it this way.
 *
 * ## Seven `findFirst`s, cached globally — and why not just seven per page view
 *
 * Each read is an index-only lookup on `@@index([kind, date(sort: Desc)])`, so
 * the query itself is cheap. The waste is that it is the SAME seven answers for
 * every symbol: a cold cache across 500 stock pages pays 3,500 round trips for
 * one 7-entry map. Caching it collapses that to 7 per TTL window, and the map
 * is small, symbol-free and has no user scope.
 *
 * A map containing a NULL is NEVER written to cache. "This family has not
 * landed" is precisely the fail-open the standing rule forbids freezing: on QA
 * `surveillance-sync` is prod-only, so caching `SURVEILLANCE: null` for six
 * hours would pin every surveillance badge to `isCurrent: false` — an all-clear
 * derived from an absent feed — long after the family arrived.
 */
async function loadFlagReferenceDays(
  deps: ResolvedDeps,
): Promise<Record<string, string | null>> {
  const { db, readCache, writeCache, ttl } = deps;
  const cached = await readCache<Record<string, string | null>>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    FLAG_REFERENCE_CACHE_KEY,
  );
  if (cached) return cached;

  const entries = await Promise.all(
    FLAG_KINDS.map(async (kind) => {
      const row = await db.stockFlag.findFirst({
        where: { kind },
        orderBy: { date: "desc" },
        select: { date: true },
      });
      const d = row?.date ?? null;
      return [kind, d ? d.toISOString().slice(0, 10) : null] as const;
    }),
  );
  const map: Record<string, string | null> = Object.fromEntries(entries);

  if (Object.values(map).every((v) => v !== null)) {
    await writeCache(
      TABS_CACHE_NS,
      CACHE_SCOPE,
      FLAG_REFERENCE_CACHE_KEY,
      map,
      undefined,
      { ttl: ttl(15 * 60, 6 * 60 * 60) },
    );
  }
  return map;
}

export async function getStockFlagsAndIndexes(
  args: SymbolArgs & { rowsPerKind?: number },
  deps: StockSectionsMarketDeps = {},
): Promise<ServiceResult<WithProvenance<StockFlagsAndIndexesData>>> {
  const resolved = resolve(deps);
  const { db, readCache, writeCache, ttl } = resolved;
  const rowsPerKind = Math.min(
    200,
    Math.max(1, args.rowsPerKind ?? FLAG_ROWS_PER_KIND),
  );
  const cacheKey = `stock-flags:${args.symbol}:${args.exchange}:${rowsPerKind}`;
  const cached = await readCache<WithProvenance<StockFlagsAndIndexesData>>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const [flagPages, memberships, referenceDayByKind] = await Promise.all([
      Promise.all(
        FLAG_KINDS.map((kind) =>
          db.stockFlag.findMany({
            where: { symbol: args.symbol, exchange: args.exchange, kind },
            orderBy: { date: "desc" },
            take: rowsPerKind,
            select: {
              kind: true,
              value: true,
              date: true,
              series: true,
              source: true,
            },
          }),
        ),
      ),
      db.indexMembership.findMany({
        // MONEY-1236 — the bare `removedOn: null` is correct: every writer
        // stamps the key. workers/src/processors/index-constituent-sync.ts
        // passes an explicit `removedOn: null` in `recordMembershipHistory`'s
        // `createMany` (line 354), and scripts/data/backfill-index-membership.ts
        // writes it in both `create` and `update`. Measured on prod 2026-08-21:
        // 924 rows, 0 absent, 924 explicit null.
        // prisma-null-ok: open stints carry an explicit null (0 absent of 924)
        where: { symbol: args.symbol, removedOn: null },
        orderBy: { lastSeen: "desc" },
        take: MAX_INDEX_CHIPS,
        select: {
          indexId: true,
          addedOn: true,
          firstSeen: true,
          lastSeen: true,
          removedOn: true,
        },
      }),
      // Symbol-independent and globally cached — see `loadFlagReferenceDays`.
      // It rides the SAME `Promise.all` as the row reads rather than awaiting
      // in front of them: on a cache miss it is seven index-only lookups, and
      // serialising them behind the eight per-symbol reads would add a round
      // trip to a page that already fans out.
      loadFlagReferenceDays(resolved),
    ]);

    const allFlagRows = flagPages.flat();
    const badges = buildStockFlagBadges(allFlagRows, { referenceDayByKind });
    const headline = selectHeadlineStockFlagBadges(badges);

    const history: Record<string, StockFlagHistoryRow[]> = {};
    FLAG_KINDS.forEach((kind, i) => {
      const page = flagPages[i] ?? [];
      if (page.length === 0) return;
      history[kind] = page.map((r) => ({
        date: r.date.toISOString(),
        value: r.value,
        // BESIDE `value`, never instead of it — one decoder for web, /v1,
        // research and the alert writers.
        display: formatStockFlagValue(kind, r.value, { date: r.date }),
        series: r.series,
        source: r.source,
      }));
    });

    let indexes = buildIndexChips(memberships);
    let indexFallback = false;
    if (indexes.length === 0) {
      const constituents = await db.indexConstituent.findMany({
        where: { symbol: args.symbol },
        take: MAX_INDEX_CHIPS,
        select: { indexId: true, lastSyncedAt: true },
      });
      // `IndexConstituent` is rewritten wholesale every sync, so a row in it IS
      // a current membership — but it carries no join date and no exit date, so
      // `addedOn` stays null (the honest "we do not know when") and `lastSeen`
      // borrows the sync stamp, which is the only date the model has.
      indexes = buildIndexChips(
        constituents.map((c) => ({
          indexId: c.indexId,
          addedOn: null,
          lastSeen: c.lastSyncedAt,
          removedOn: null,
        })),
        { fallback: true },
      );
      indexFallback = indexes.length > 0;
    }

    const newestFlag = latestAsOf(allFlagRows, "date");
    const data: StockFlagsAndIndexesData = {
      badges,
      headline,
      history,
      indexes,
      referenceDay: newestFlag ? newestFlag.toISOString() : null,
      referenceDayByKind,
    };

    const empty = badges.length === 0 && indexes.length === 0;
    const envelope = withProvenance(data, {
      // Flag rows record the registry family they came from ("nse-sec-list",
      // "nse-gsm-api", …), and the chip should name the family behind what the
      // reader is actually looking at.
      //
      // FALLBACK CHAIN, not `headline[0]` (MONEY-1205). This used to read
      // `badges[0]?.source`, which was safe only because `PRICE_BAND` and
      // `WK52_HIGH_LOW` guaranteed a badge on every stock. Now that the header
      // set is an exception, `headline` is empty for most of the market — and
      // `headline[0]?.source ?? null` would drop provenance from a section that
      // still renders `badges`, `history` and index chips. So: the rendered set
      // first, then any badge at all, then the index fallback.
      source:
        headline[0]?.source ??
        badges.find((b) => b.source !== null)?.source ??
        (indexFallback ? "NSE_INDICES" : null),
      asOf: newestFlag,
      ...(indexFallback ? { fallback: true } : {}),
      ...(indexFallback
        ? {
            note: "Index membership served from the current-constituents snapshot — join dates are not available for it.",
          }
        : {}),
      emptyOverride: empty,
    });

    // Never cache an empty section: "no flags yet" is indistinguishable from
    // "the nightly parse has not landed", and freezing that answer for hours is
    // the fail-open default the standing rule forbids.
    if (!empty) {
      await writeCache(
        TABS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        { ttl: ttl(30 * 60, 6 * 60 * 60) },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockFlagsAndIndexes error:", error);
    return { success: false, error: "Failed to load exchange flags" };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 14c.2 — delivery
// ════════════════════════════════════════════════════════════════════════════

/**
 * Delivery % headline, 20-session mean and 60-session mini-series.
 *
 * `DailyPrice` is keyed `@@unique([instrumentId, date])`, so this is the one
 * section that must resolve an `InstrumentMapping` first. An unresolvable
 * symbol is an empty section, not an error — the stock page renders for
 * symbols whose instrument row was re-minted, and a 500 there would be a
 * regression of exactly the MONEY-1145 class.
 *
 * The null-skipping mean lives in `computeDeliveryTrend`; read its doc for why
 * a `-` session must not average as zero.
 */
export async function getStockDeliveryTrend(
  args: SymbolArgs,
  deps: StockSectionsMarketDeps = {},
): Promise<ServiceResult<WithProvenance<StockDeliveryData>>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const cacheKey = `stock-delivery:${args.symbol}:${args.exchange}`;
  const cached = await readCache<WithProvenance<StockDeliveryData>>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const instrument = await db.instrumentMapping.findFirst({
      where: { symbol: args.symbol, exchange: args.exchange, isActive: true },
      select: { id: true },
    });

    const rows = instrument
      ? await db.dailyPrice.findMany({
          where: { instrumentId: instrument.id },
          orderBy: { date: "desc" },
          take: DELIVERY_SESSIONS,
          select: {
            date: true,
            deliveryPct: true,
            deliveryQty: true,
            avgPrice: true,
            trades: true,
            close: true,
            source: true,
          },
        })
      : [];

    const trend = computeDeliveryTrend(rows);
    const data: StockDeliveryData = {
      ...trend,
      // The row the HEADLINE was read from, not `rows[0]`. `DailyPrice.source`
      // defaults to "YAHOO" and Yahoo rows carry OHLCV only, so on any day the
      // bhavcopy has not landed yet `rows[0].source` credits Yahoo with a
      // delivery figure it never published. Falls back to the newest row's
      // source only when NOTHING reported delivery — a section that is `empty`
      // anyway, where the label describes where the prices came from.
      priceSource: trend.latest?.source ?? rows[0]?.source ?? null,
    };

    // A row with NO delivery column at all is not a delivery section. Yahoo
    // rows carry OHLCV and nothing else, so `rows.length > 0` alone would
    // render an all-null chip and call it data.
    const empty = trend.n20 === 0 && trend.latest?.deliveryPct == null;

    const envelope = withProvenance(data, {
      source: data.priceSource,
      asOf: trend.latest?.date ?? null,
      emptyOverride: empty,
      note:
        trend.n20 < trend.window20
          ? `${trend.n20} of the last ${trend.window20} sessions reported delivery; NSE prints "-" on trade-for-trade series.`
          : undefined,
    });

    if (!empty) {
      await writeCache(
        TABS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        envelope,
        undefined,
        { ttl: ttl(60 * 60, 6 * 60 * 60) },
      );
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockDeliveryTrend error:", error);
    return { success: false, error: "Failed to load delivery data" };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 14c.3 — F&O
// ════════════════════════════════════════════════════════════════════════════

/**
 * The F&O section: OI, basis, rollover, PCR, max pain, buildup, SLB and MWPL.
 *
 * GATED on `DerivativeSummary` having a row. The gate query IS the data query
 * — the newest summary row both answers "is this an F&O name" and supplies
 * every headline — so the gate costs nothing extra, and a cash-only stock
 * short-circuits before touching SLB, MWPL or the ban flag.
 *
 * MWPL's `utilisationPct` is NULL on every row in the table today (the model's
 * own comment forbids deriving it from a substitute denominator), so the
 * ≥80% ban-proximity warning is built, gated on `band !== null`, and simply
 * does not render until a real MWPL source exists. Ban proximity that IS
 * available comes from `StockFlag` kind `FO_BAN`, which is a published fact
 * rather than a derived one.
 */
export async function getStockDerivatives(
  args: SymbolArgs,
  deps: StockSectionsMarketDeps = {},
): Promise<ServiceResult<WithProvenance<StockDerivativesData>>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const cacheKey = `stock-derivatives:${args.symbol}:${args.exchange}`;
  const cached = await readCache<WithProvenance<StockDerivativesData>>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const summaryRow = await db.derivativeSummary.findFirst({
      where: { symbol: args.symbol, exchange: args.exchange },
      orderBy: { date: "desc" },
    });

    if (!summaryRow) {
      // Not an F&O name. Empty envelope, `success: true`, nothing cached.
      const data: StockDerivativesData = {
        isFno: false,
        summary: null,
        slb: null,
        slbDate: null,
        mwpl: null,
        ban: null,
      };
      return {
        success: true,
        data: withProvenance(data, { emptyOverride: true }),
      };
    }

    const summary = buildDerivativeSummaryView(summaryRow);

    const [slbLatest, mwplRow, banRows] = await Promise.all([
      db.slbPosition.findFirst({
        where: { symbol: args.symbol, exchange: args.exchange },
        orderBy: { date: "desc" },
        select: { date: true },
      }),
      // `MwplDaily` has NO `exchange` column — filtering on one would match
      // nothing. It is an NSE-only dataset by construction.
      db.mwplDaily.findFirst({
        where: { symbol: args.symbol },
        orderBy: { date: "desc" },
        select: {
          date: true,
          notionalOi: true,
          futEquivOi: true,
          mwpl: true,
          utilisationPct: true,
          source: true,
        },
      }),
      db.stockFlag.findMany({
        where: {
          symbol: args.symbol,
          exchange: args.exchange,
          kind: "FO_BAN",
        },
        orderBy: { date: "desc" },
        take: FLAG_ROWS_PER_KIND,
        select: {
          kind: true,
          value: true,
          date: true,
          series: true,
          source: true,
        },
      }),
    ]);

    // Per-series ladder for the LATEST SLB day only. Fetched as a second query
    // keyed on that exact date rather than as a `take` over the symbol's whole
    // history, because the number of series per day varies (CDSL printed nine
    // on 13-Aug-2026) and a fixed `take` would slice a day in half — the same
    // partial-day error, one layer up, that MONEY-1201 fixed in the writer.
    const slbRows = slbLatest
      ? await db.slbPosition.findMany({
          where: {
            symbol: args.symbol,
            exchange: args.exchange,
            date: slbLatest.date,
          },
          select: {
            series: true,
            openQty: true,
            openValue: true,
            expiryDate: true,
          },
        })
      : [];

    const banBadge = buildStockFlagBadges(banRows)[0] ?? null;
    const summaryDay = summary?.date ? summary.date.slice(0, 10) : null;

    const data: StockDerivativesData = {
      isFno: true,
      summary,
      slb: slbRows.length > 0 ? buildSlbLadder(slbRows) : null,
      slbDate: slbLatest ? slbLatest.date.toISOString() : null,
      mwpl: buildMwplSnapshot(mwplRow),
      ban: banBadge
        ? {
            date: banBadge.date,
            since: banBadge.since,
            observedSessions: banBadge.observedSessions,
            runReachesWindowEdge: banBadge.runReachesWindowEdge,
            // Clock-free: a ban is in force when its day is at or after the
            // newest F&O session we hold. Comparing to `Date.now()` would mark
            // every ban expired over a weekend and blank a real warning.
            active:
              summaryDay === null
                ? false
                : banBadge.date.slice(0, 10) >= summaryDay,
          }
        : null,
    };

    const envelope = withProvenance(data, {
      source: summary?.source ?? null,
      asOf: summary?.date ?? null,
      emptyOverride: false, // isFno === true — there is always a summary here.
    });

    await writeCache(
      TABS_CACHE_NS,
      CACHE_SCOPE,
      cacheKey,
      envelope,
      undefined,
      {
        ttl: ttl(60 * 60, 6 * 60 * 60),
      },
    );
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getStockDerivatives error:", error);
    return { success: false, error: "Failed to load derivatives data" };
  }
}
