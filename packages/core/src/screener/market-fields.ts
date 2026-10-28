/**
 * Market-structure screener fields — the READER — MONEY-1204 (P14 / 14e.1).
 *
 * Thin by design: it batches one query per SOURCE TABLE that the requested
 * fields actually need, groups the rows in memory, and hands them to
 * `buildMarketFieldValues`. Every judgement call about what a row MEANS —
 * null-vs-zero, "current" flag state, QoQ deltas, BigInt coercion — lives in
 * `market-fields-logic.ts` and is unit-tested without a database.
 *
 * Three properties this file is responsible for:
 *
 * 1. **Only the requested sources are read.** `marketFieldSources` derives the
 *    table set from the filters. A delivery-only screen never touches
 *    `bond_eod`, and — more to the point — a source that is NOT read leaves its
 *    fields `null` (unknown), which `matchesMarketFilters` excludes on. Nothing
 *    here ever fabricates a value for a table it did not query.
 *
 * 2. **The flag reference day is per KIND and MARKET-WIDE.** Three tiny
 *    `findFirst`s served straight off `@@index([kind, date desc])`. See
 *    `flagsReferenceDayByKind` for why a single global maximum is a fail-open.
 *
 * 3. **A missing table degrades to "no matches", never to an error.** `BondEOD`
 *    and `BondMaster` are new in this branch and nearly empty (their history
 *    walk is founder-gated), and `MwplDaily.utilisationPct` is null on every
 *    row. Each source read is individually guarded, so a table that is empty,
 *    absent or transiently unreadable yields unknown values — which exclude —
 *    rather than a thrown screen.
 */

import prisma from "@usemoney/database";

import {
  buildMarketFieldValues,
  emptyMarketFieldValues,
  marketFieldSources,
  MARKET_FLAG_KINDS,
  type MarketFieldRowSet,
  type MarketFieldSource,
  type MarketFieldValues,
  type ShareholdingQuarterRow,
} from "./market-fields-logic";
import type { DeliveryDayRow } from "../market-data/stock-section-logic";
import type { IndexMembershipRow } from "../market-data/stock-section-logic";
import type { StockFlagStateRow } from "../market-data/stock-section-logic";
import { dedupeShareholdingByQuarter } from "../market-data/ownership-section-logic";

/** Injectable IO seam, matching `ScreenerDeps`. */
export interface MarketFieldsDeps {
  prisma?: typeof prisma;
}

export interface MarketFieldCandidate {
  symbol: string;
  exchange: string;
}

/**
 * Symbols per batched read.
 *
 * Deliberately under the 200 `internalQueryMaxScansToExplode` ceiling the price
 * chunker documents: these reads are `symbol: { in: [...] }` sorted by
 * `date desc` off compound indexes whose leading field is the `$in`, which is
 * the same sorted-merge plan — and the same cliff past 200, where the planner
 * stops exploding and falls back to a blocking in-memory sort.
 */
export const MARKET_FIELD_CHUNK_SIZE = 100;

/**
 * Calendar-day lookbacks per source. Calendar, not sessions: the queries are
 * `date >= cutoff` and nothing here knows the trading calendar.
 */
export const MARKET_FIELD_LOOKBACK_DAYS = {
  /** ≥20 SESSIONS of delivery. 60 calendar days is ~40 sessions after holidays. */
  delivery: 60,
  /**
   * Flags. NSE republishes the surveillance, band and ban lists DAILY, so the
   * current state is always within days — the window exists to bound the scan,
   * not to reach back for a stale flag.
   */
  flags: 45,
  /** Newest F&O summary / MWPL row. */
  derivatives: 30,
  /**
   * Bonds. Much wider than the equity windows on purpose: `bond_eod` is sparse
   * (most listed bonds do not print every day) and nearly empty besides, so a
   * 30-day window would report "no yield" for a bond that traded last quarter.
   * `bondAsOf` carries the print date so a caller can judge the staleness
   * rather than have it silently decided here.
   */
  bonds: 180,
} as const;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * Exact `(symbol, exchange)` key — the same symbol trades on NSE and BSE and
 * they are different instruments. NUL cannot occur in either field, so it is an
 * unambiguous separator.
 *
 * Written as the ESCAPE `\u0000`, never as a literal NUL byte in the source.
 * git classifies a blob as BINARY on finding a NUL in its first 8000 bytes, and
 * a binary blob has no diff at all — `git diff`, `gh pr diff` and every review
 * tool print `Bin 0 -> 23738 bytes`. This whole module was invisible to review
 * for exactly that reason, which is how the unbounded surveillance
 * reference-day `findFirst` below shipped. Pinned by a test that scans the
 * package (`market-fields-reader.test.ts`).
 */
const KEY_SEP = "\u0000";

export function marketFieldKey(symbol: string, exchange: string): string {
  return `${symbol}${KEY_SEP}${exchange}`;
}

/**
 * The prefix every DATABLE `ShareholdingPattern.quarter` starts with.
 *
 * The writer (`normalizeQuarter`, packages/research/.../ownership-logic.ts)
 * canonicalises a parseable period to `YYYY-MM` and keeps anything else
 * VERBATIM and upper-cased — `"Q1FY26"`, `"JUN 2026"`. In ASCII `"Q" > "2"`, so
 * under `orderBy: { quarter: "desc" }` every verbatim label sorts ABOVE every
 * real quarter. Combined with a per-symbol row cap, that is how
 * `[2026-06 @41.2%, 2026-03 @39.0%, Q1FY26 @3.0%]` used to publish
 * `pledgedPct: 3, pledgedPctQoqDelta: -38.2` — a fabricated pledge COLLAPSE
 * against a truth of 41.2 and +2.2, on the field whose null rule exists to
 * prevent exactly a fabricated all-clear (module header, rule 4).
 *
 * Excluded in the QUERY rather than re-ranked after the fact, because a correct
 * in-memory comparator cannot recover a row the cap already dropped.
 * `packages/research/src/data-sources/db-store.ts` defends the same table the
 * other way (over-read, then re-rank); both are needed here, since the pure
 * layer is also reachable with caller-supplied rows.
 */
const DATABLE_QUARTER_PREFIX = "20";

/**
 * How many `ShareholdingPattern` rows per symbol survive the reader's cap.
 *
 * Two are USED. More are kept so `applyShareholdingValues`' canonical-first
 * ranking has something to rank — the cap runs on the raw `orderBy` order.
 */
const SHAREHOLDING_ROWS_KEPT = 8;

function cutoff(days: number, now: number): Date {
  return new Date(now - days * 86_400_000);
}

function dayKey(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const iso = d instanceof Date ? d.toISOString() : String(d);
  return iso.length >= 10 ? iso.slice(0, 10) : null;
}

/**
 * Resolve the market-structure fields for every candidate.
 *
 * Returns a map keyed by `marketFieldKey(symbol, exchange)`. A candidate with
 * NO entry never happens — every candidate gets at least the all-unknown value
 * set, so the matcher's "unknown excludes" rule is what decides, not a lookup
 * miss that a caller might read as "no filters applied".
 */
export async function loadMarketFieldValues(
  candidates: ReadonlyArray<MarketFieldCandidate>,
  fields: readonly string[],
  deps: MarketFieldsDeps = {},
  now: number = Date.now(),
): Promise<Map<string, MarketFieldValues>> {
  const db = deps.prisma ?? prisma;
  const out = new Map<string, MarketFieldValues>();
  for (const c of candidates) {
    out.set(marketFieldKey(c.symbol, c.exchange), emptyMarketFieldValues());
  }
  if (candidates.length === 0) return out;

  const sources = marketFieldSources(fields);
  if (sources.size === 0) return out;

  const symbols = Array.from(new Set(candidates.map((c) => c.symbol)));
  const exchanges = Array.from(new Set(candidates.map((c) => c.exchange)));

  // InstrumentMapping is needed for the two ID-keyed sources only: DailyPrice
  // joins on instrumentId, and the bond tables join on ISIN.
  const needsInstruments =
    sources.has("DailyPrice") ||
    sources.has("BondEOD") ||
    sources.has("BondMaster");

  const instruments = needsInstruments
    ? await safe(
        () =>
          db.instrumentMapping.findMany({
            where: {
              symbol: { in: symbols },
              exchange: { in: exchanges },
              isActive: true,
            },
            select: { id: true, symbol: true, exchange: true, isin: true },
          }),
        [] as Array<{
          id: string;
          symbol: string;
          exchange: string;
          isin: string | null;
        }>,
      )
    : [];

  const instrumentByPair = new Map<
    string,
    { id: string; isin: string | null }
  >();
  for (const row of instruments) {
    const key = marketFieldKey(row.symbol, row.exchange);
    // `@@unique([symbol, exchange])` means at most one row per key; first-seen
    // is kept anyway so a widened query cannot change which one wins.
    if (!instrumentByPair.has(key)) {
      instrumentByPair.set(key, { id: row.id, isin: row.isin });
    }
  }

  const rowSets = new Map<string, MarketFieldRowSet>();
  const rowSetFor = (key: string): MarketFieldRowSet => {
    let rs = rowSets.get(key);
    if (!rs) {
      rs = {};
      rowSets.set(key, rs);
    }
    return rs;
  };

  await Promise.all([
    sources.has("DailyPrice")
      ? loadDelivery(db, candidates, instrumentByPair, rowSetFor, now)
      : Promise.resolve(),
    sources.has("StockFlag")
      ? loadFlags(db, candidates, symbols, rowSetFor, now)
      : Promise.resolve(),
    sources.has("ShareholdingPattern")
      ? loadShareholding(db, candidates, symbols, rowSetFor)
      : Promise.resolve(),
    sources.has("IndexMembership")
      ? loadMemberships(db, candidates, symbols, rowSetFor)
      : Promise.resolve(),
    sources.has("DerivativeSummary")
      ? loadDerivatives(db, candidates, symbols, rowSetFor, now)
      : Promise.resolve(),
    sources.has("MwplDaily")
      ? loadMwpl(db, candidates, symbols, rowSetFor, now)
      : Promise.resolve(),
    sources.has("BondEOD") || sources.has("BondMaster")
      ? loadBonds(db, candidates, instrumentByPair, rowSetFor, sources, now)
      : Promise.resolve(),
  ]);

  for (const c of candidates) {
    const key = marketFieldKey(c.symbol, c.exchange);
    const rs = rowSets.get(key);
    if (rs) out.set(key, buildMarketFieldValues(rs));
  }

  return out;
}

/**
 * Run a read, or fall back to `fallback` on ANY failure.
 *
 * The screener must degrade, not explode: `bond_eod` / `bond_master` are new in
 * this branch and nearly empty, and a client generated before them (or a
 * transient Atlas error) must cost the affected FIELDS, not the whole screen.
 * An unread source leaves its fields unknown, and unknown excludes — so the
 * degraded answer is "no matches", never a wrong match.
 */
async function safe<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.warn(
      `[screener/market-fields] source read failed, degrading to unknown: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return fallback;
  }
}

type RowSetLookup = (key: string) => MarketFieldRowSet;

async function loadDelivery(
  db: typeof prisma,
  candidates: ReadonlyArray<MarketFieldCandidate>,
  instrumentByPair: ReadonlyMap<string, { id: string; isin: string | null }>,
  rowSetFor: RowSetLookup,
  now: number,
): Promise<void> {
  const idByPair = new Map<string, string>();
  for (const c of candidates) {
    const key = marketFieldKey(c.symbol, c.exchange);
    const inst = instrumentByPair.get(key);
    if (inst) idByPair.set(key, inst.id);
  }
  const ids = Array.from(new Set(idByPair.values()));
  if (ids.length === 0) return;

  const since = cutoff(MARKET_FIELD_LOOKBACK_DAYS.delivery, now);
  const byInstrument = new Map<string, DeliveryDayRow[]>();

  for (const group of chunk(ids, MARKET_FIELD_CHUNK_SIZE)) {
    const rows = await safe(
      () =>
        db.dailyPrice.findMany({
          where: { instrumentId: { in: group }, date: { gte: since } },
          // instrumentId leads the sort so `@@unique([instrumentId, date])`
          // serves it as a sorted merge instead of a blocking in-memory sort.
          orderBy: [{ instrumentId: "asc" }, { date: "desc" }],
          select: {
            instrumentId: true,
            date: true,
            deliveryPct: true,
            deliveryQty: true,
            avgPrice: true,
            trades: true,
            close: true,
          },
        }),
      [] as Array<{
        instrumentId: string;
        date: Date;
        deliveryPct: number | null;
        deliveryQty: bigint | null;
        avgPrice: number | null;
        trades: number | null;
        close: number;
      }>,
    );
    for (const r of rows) {
      let list = byInstrument.get(r.instrumentId);
      if (!list) {
        list = [];
        byInstrument.set(r.instrumentId, list);
      }
      // `computeDeliveryTrend` uses the newest 20; anything past 40 here is
      // dead weight on a table with no retention job.
      if (list.length >= 40) continue;
      list.push({
        date: r.date,
        deliveryPct: r.deliveryPct,
        deliveryQty: r.deliveryQty,
        avgPrice: r.avgPrice,
        trades: r.trades,
        close: r.close,
      });
    }
  }

  for (const [key, id] of idByPair) {
    rowSetFor(key).delivery = byInstrument.get(id) ?? [];
  }
}

async function loadFlags(
  db: typeof prisma,
  candidates: ReadonlyArray<MarketFieldCandidate>,
  symbols: readonly string[],
  rowSetFor: RowSetLookup,
  now: number,
): Promise<void> {
  const since = cutoff(MARKET_FIELD_LOOKBACK_DAYS.flags, now);

  // Per-kind, market-wide newest day. One `findFirst` each, straight off
  // `@@index([kind, date desc])`. NOT one global maximum — see
  // `flagsReferenceDayByKind`.
  //
  // BOUNDED BY THE SAME `since` AS THE ROW QUERY BELOW, and that is load-bearing
  // rather than tidiness. Unbounded, this happily returns a reference day whose
  // rows the row query has already discarded, and the two halves then disagree:
  // the kind reads as "publishing", so `applyFlagValues` seeds its booleans to
  // FALSE, while every row that could set one back to true has been filtered
  // out. On QA — where `surveillance-sync` is prod-only, so the newest flag row
  // can be months old — that turns a stock that was under ASM and F&O-banned on
  // the last published day into `asmFlag: false, foBanFlag: false`, and a screen
  // for "NOT under ASM" MATCHES a banned stock. With the bound, a stale feed
  // yields `referenceDay = null` and the fields stay UNKNOWN, which excludes
  // (module header, rules 3 and 7).
  const referenceEntries = await Promise.all(
    MARKET_FLAG_KINDS.map(async (kind) => {
      const row = await safe(
        () =>
          db.stockFlag.findFirst({
            where: { kind, date: { gte: since } },
            orderBy: { date: "desc" },
            select: { date: true },
          }),
        null as { date: Date } | null,
      );
      return [kind, dayKey(row?.date ?? null)] as const;
    }),
  );
  const flagsReferenceDayByKind: Record<string, string | null> =
    Object.fromEntries(referenceEntries);

  const bySymbol = new Map<string, StockFlagStateRow[]>();
  for (const group of chunk(symbols, MARKET_FIELD_CHUNK_SIZE)) {
    const rows = await safe(
      () =>
        db.stockFlag.findMany({
          where: {
            symbol: { in: group },
            kind: { in: [...MARKET_FLAG_KINDS] },
            date: { gte: since },
          },
          orderBy: [{ symbol: "asc" }, { date: "desc" }],
          select: {
            symbol: true,
            kind: true,
            value: true,
            date: true,
            series: true,
            source: true,
          },
        }),
      [] as Array<{
        symbol: string;
        kind: string;
        value: string;
        date: Date;
        series: string | null;
        source: string;
      }>,
    );
    for (const r of rows) {
      let list = bySymbol.get(r.symbol);
      if (!list) {
        list = [];
        bySymbol.set(r.symbol, list);
      }
      list.push({
        kind: r.kind,
        value: r.value,
        date: r.date,
        series: r.series,
        source: r.source,
      });
    }
  }

  for (const c of candidates) {
    const rs = rowSetFor(marketFieldKey(c.symbol, c.exchange));
    rs.flags = bySymbol.get(c.symbol) ?? [];
    rs.flagsReferenceDayByKind = flagsReferenceDayByKind;
  }
}

async function loadShareholding(
  db: typeof prisma,
  candidates: ReadonlyArray<MarketFieldCandidate>,
  symbols: readonly string[],
  rowSetFor: RowSetLookup,
): Promise<void> {
  const bySymbol = new Map<string, ShareholdingQuarterRow[]>();

  for (const group of chunk(symbols, MARKET_FIELD_CHUNK_SIZE)) {
    const rows = await safe(
      () =>
        db.shareholdingPattern.findMany({
          // Undatable period labels are excluded IN THE QUERY, not re-ranked
          // afterwards — see DATABLE_QUARTER_PREFIX.
          where: {
            symbol: { in: group },
            quarter: { startsWith: DATABLE_QUARTER_PREFIX },
          },
          // Served by the `(symbol, exchange, quarter)` unique. `exchange`
          // sits between the two sort columns, so the DESC on `quarter` is not
          // an index walk any more — it is a sort over one symbol's handful of
          // rows, which is why this is still fine.
          orderBy: [{ symbol: "asc" }, { quarter: "desc" }],
          select: {
            symbol: true,
            quarter: true,
            // MONEY-1207 put `exchange` in the unique key, so a dual-listed
            // symbol has one row per exchange per quarter. Needed by the
            // dedupe below — see the comment on the cap.
            exchange: true,
            pledgedPct: true,
            fiiPct: true,
            diiPct: true,
          },
        }),
      [] as Array<{
        symbol: string;
        quarter: string;
        exchange: string | null;
        pledgedPct: number | null;
        fiiPct: number | null;
        diiPct: number | null;
      }>,
    );
    // Grouped in full FIRST, deduped, and only then capped.
    //
    // The DEDUPE is what fixes the bug. MONEY-1207 put `exchange` in the unique
    // key, so a dual-listed symbol files each quarter twice; undeduped,
    // `applyShareholdingValues` reads rows[0] as the level and rows[1] as the
    // PRIOR quarter, and both are `2026-06`. Every pledge/FII/DII delta then
    // comes out as exactly 0 for all 2,465 dual-listed symbols — a confident
    // "no movement" that screener filters match on as real. Dedupe is what
    // makes rows[1] a different period again.
    //
    // The ORDER (dedupe before cap) is defensive, and deliberately kept even
    // though no assertion can currently fail on it: `SHAREHOLDING_ROWS_KEPT` is
    // 8, undatable labels are already excluded in the query, and only the
    // newest two quarters are ever read — so even fully dual-filed, 8 rows
    // still yield 4 distinct quarters and nothing observable is lost. That is a
    // margin, not a guarantee: it disappears the moment a third exchange files,
    // the cap is lowered, or a consumer reads a third quarter. Capping a
    // ROW count to bound a QUARTER count is only ever correct by coincidence.
    const perSymbol = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = perSymbol.get(r.symbol);
      if (list) list.push(r);
      else perSymbol.set(r.symbol, [r]);
    }

    for (const [symbol, symbolRows] of perSymbol) {
      let list = bySymbol.get(symbol);
      if (!list) {
        list = [];
        bySymbol.set(symbol, list);
      }
      // No `preferExchange`: this map is keyed by SYMBOL and the same list is
      // served to the NSE and BSE candidates alike, so there is no single
      // viewed exchange to prefer. The declared authority order (NSE first)
      // keeps both candidates quoting the same filing as each other.
      //
      // Only the newest two quarters are ever USED (a level and its QoQ delta),
      // but keep a few more: the cap is applied on the `orderBy` order, before
      // `applyShareholdingValues` gets to rank canonical labels first, so a cap
      // of exactly 2 leaves no room for that ranking to correct anything. The
      // rows are already on the wire (this query has no `take`), so the extra
      // ones cost memory only.
      for (const r of dedupeShareholdingByQuarter(symbolRows)) {
        if (list.length >= SHAREHOLDING_ROWS_KEPT) break;
        list.push({
          quarter: r.quarter,
          pledgedPct: r.pledgedPct,
          fiiPct: r.fiiPct,
          diiPct: r.diiPct,
        });
      }
    }
  }

  for (const c of candidates) {
    rowSetFor(marketFieldKey(c.symbol, c.exchange)).shareholding =
      bySymbol.get(c.symbol) ?? [];
  }
}

async function loadMemberships(
  db: typeof prisma,
  candidates: ReadonlyArray<MarketFieldCandidate>,
  symbols: readonly string[],
  rowSetFor: RowSetLookup,
): Promise<void> {
  const bySymbol = new Map<string, IndexMembershipRow[]>();

  for (const group of chunk(symbols, MARKET_FIELD_CHUNK_SIZE)) {
    const rows = await safe(
      () =>
        db.indexMembership.findMany({
          // OPEN stints only. `IndexMembership` is the symbol-first table:
          // `@@index([symbol])` exists here and NOT on `IndexConstituent`, so a
          // "which indexes is this symbol in" read that used the other table
          // would collection-scan.
          //
          // MONEY-1236 — the bare `removedOn: null` is correct: every writer
          // stamps the key. workers/src/processors/index-constituent-sync.ts
          // passes an explicit `removedOn: null` in `recordMembershipHistory`'s
          // `createMany` (line 354), and scripts/data/backfill-index-membership.ts
          // writes it in both `create` and `update`. Measured on prod
          // 2026-08-21: 924 rows, 0 absent, 924 explicit null.
          // prisma-null-ok: open stints carry an explicit null (0 absent of 924)
          where: { symbol: { in: group }, removedOn: null },
          select: {
            symbol: true,
            indexId: true,
            addedOn: true,
            firstSeen: true,
            lastSeen: true,
            removedOn: true,
          },
        }),
      [] as Array<{
        symbol: string;
        indexId: string;
        addedOn: Date | null;
        firstSeen: Date;
        lastSeen: Date;
        removedOn: Date | null;
      }>,
    );
    for (const r of rows) {
      let list = bySymbol.get(r.symbol);
      if (!list) {
        list = [];
        bySymbol.set(r.symbol, list);
      }
      list.push({
        indexId: r.indexId,
        addedOn: r.addedOn,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        removedOn: r.removedOn,
      });
    }
  }

  for (const c of candidates) {
    // `[]` here is a REAL answer ("in no index"), distinct from leaving the
    // field undefined, which means "we did not look".
    rowSetFor(marketFieldKey(c.symbol, c.exchange)).memberships =
      bySymbol.get(c.symbol) ?? [];
  }
}

async function loadDerivatives(
  db: typeof prisma,
  candidates: ReadonlyArray<MarketFieldCandidate>,
  symbols: readonly string[],
  rowSetFor: RowSetLookup,
  now: number,
): Promise<void> {
  const since = cutoff(MARKET_FIELD_LOOKBACK_DAYS.derivatives, now);
  const bySymbol = new Map<
    string,
    { date: Date; pcrOi: number | null; futOiChange: bigint | null }
  >();

  for (const group of chunk(symbols, MARKET_FIELD_CHUNK_SIZE)) {
    const rows = await safe(
      () =>
        db.derivativeSummary.findMany({
          where: { symbol: { in: group }, date: { gte: since } },
          orderBy: [{ symbol: "asc" }, { date: "desc" }],
          select: {
            symbol: true,
            date: true,
            pcrOi: true,
            futOiChange: true,
          },
        }),
      [] as Array<{
        symbol: string;
        date: Date;
        pcrOi: number | null;
        futOiChange: bigint | null;
      }>,
    );
    // Newest per symbol wins; the sort put it first.
    for (const r of rows) {
      if (!bySymbol.has(r.symbol)) {
        bySymbol.set(r.symbol, {
          date: r.date,
          pcrOi: r.pcrOi,
          futOiChange: r.futOiChange,
        });
      }
    }
  }

  for (const c of candidates) {
    rowSetFor(marketFieldKey(c.symbol, c.exchange)).derivatives =
      bySymbol.get(c.symbol) ?? null;
  }
}

async function loadMwpl(
  db: typeof prisma,
  candidates: ReadonlyArray<MarketFieldCandidate>,
  symbols: readonly string[],
  rowSetFor: RowSetLookup,
  now: number,
): Promise<void> {
  const since = cutoff(MARKET_FIELD_LOOKBACK_DAYS.derivatives, now);
  const bySymbol = new Map<
    string,
    { date: Date; utilisationPct: number | null }
  >();

  for (const group of chunk(symbols, MARKET_FIELD_CHUNK_SIZE)) {
    const rows = await safe(
      () =>
        db.mwplDaily.findMany({
          where: { symbol: { in: group }, date: { gte: since } },
          orderBy: [{ symbol: "asc" }, { date: "desc" }],
          // `utilisationPct` ONLY. `notionalOi` and `futEquivOi` are real
          // numbers on these rows and it would be one edit to divide by one of
          // them — which is exactly the substitution the model note forbids:
          // the denominator is a market-wide POSITION LIMIT nobody publishes,
          // and `oi_cli_limit` is a per-CLIENT limit, a different quantity.
          select: { symbol: true, date: true, utilisationPct: true },
        }),
      [] as Array<{
        symbol: string;
        date: Date;
        utilisationPct: number | null;
      }>,
    );
    for (const r of rows) {
      if (!bySymbol.has(r.symbol)) {
        bySymbol.set(r.symbol, {
          date: r.date,
          utilisationPct: r.utilisationPct,
        });
      }
    }
  }

  for (const c of candidates) {
    rowSetFor(marketFieldKey(c.symbol, c.exchange)).mwpl =
      bySymbol.get(c.symbol) ?? null;
  }
}

async function loadBonds(
  db: typeof prisma,
  candidates: ReadonlyArray<MarketFieldCandidate>,
  instrumentByPair: ReadonlyMap<string, { id: string; isin: string | null }>,
  rowSetFor: RowSetLookup,
  sources: ReadonlySet<MarketFieldSource>,
  now: number,
): Promise<void> {
  // ISIN is the join key for both bond tables, and it is normalised
  // `.trim().toUpperCase()` on ingest because `cbm_trd` prints ISINs with a
  // TRAILING SPACE while `wdmlist` does not. An un-normalised join matches
  // nothing, which looks exactly like "this bond does not trade".
  const isinByPair = new Map<string, string>();
  for (const c of candidates) {
    const key = marketFieldKey(c.symbol, c.exchange);
    const isin = instrumentByPair.get(key)?.isin;
    if (typeof isin === "string" && isin.trim() !== "") {
      isinByPair.set(key, isin.trim().toUpperCase());
    }
  }
  const isins = Array.from(new Set(isinByPair.values()));
  // No ISIN anywhere → no bond rows are reachable. Leave every bond field
  // unknown so the filter excludes; do not query with an empty `$in`.
  if (isins.length === 0) return;

  const since = cutoff(MARKET_FIELD_LOOKBACK_DAYS.bonds, now);
  const eodByIsin = new Map<
    string,
    {
      date: Date;
      segment: string;
      lastPrice: number | null;
      lastYtm: number | null;
      wtdYtm: number | null;
      totalTradeValueLacs: number | null;
    }
  >();

  if (sources.has("BondEOD")) {
    for (const group of chunk(isins, MARKET_FIELD_CHUNK_SIZE)) {
      const rows = await safe(
        () =>
          db.bondEOD.findMany({
            where: { isin: { in: group }, date: { gte: since } },
            orderBy: [{ isin: "asc" }, { date: "desc" }],
            select: {
              isin: true,
              date: true,
              segment: true,
              lastPrice: true,
              lastYtm: true,
              wtdYtm: true,
              totalTradeValueLacs: true,
            },
          }),
        [] as Array<{
          isin: string;
          date: Date;
          segment: string;
          lastPrice: number | null;
          lastYtm: number | null;
          wtdYtm: number | null;
          totalTradeValueLacs: number | null;
        }>,
      );
      for (const r of rows) {
        const prev = eodByIsin.get(r.isin);
        if (!prev) {
          eodByIsin.set(r.isin, r);
          continue;
        }
        // The SAME ISIN can print on the SAME day in BOTH segments at different
        // prices — that is why `@@unique([isin, date, segment])` includes the
        // segment. A screener headline needs one number, so the tie is broken
        // by TRADED VALUE (the segment where it actually traded), then by
        // segment name so the choice is deterministic rather than
        // order-dependent. The chosen segment travels with the value.
        if (r.date.getTime() !== prev.date.getTime()) continue; // older day
        const a = r.totalTradeValueLacs ?? -1;
        const b = prev.totalTradeValueLacs ?? -1;
        if (a > b || (a === b && r.segment < prev.segment)) {
          eodByIsin.set(r.isin, r);
        }
      }
    }
  }

  const masterByIsin = new Map<
    string,
    { coupon: number | null; maturityDate: Date | null }
  >();
  if (sources.has("BondMaster")) {
    for (const group of chunk(isins, MARKET_FIELD_CHUNK_SIZE)) {
      const rows = await safe(
        () =>
          db.bondMaster.findMany({
            where: { isin: { in: group } },
            select: { isin: true, coupon: true, maturityDate: true },
          }),
        [] as Array<{
          isin: string;
          coupon: number | null;
          maturityDate: Date | null;
        }>,
      );
      for (const r of rows) {
        if (!masterByIsin.has(r.isin)) {
          masterByIsin.set(r.isin, {
            coupon: r.coupon,
            maturityDate: r.maturityDate,
          });
        }
      }
    }
  }

  for (const [key, isin] of isinByPair) {
    const rs = rowSetFor(key);
    rs.bondEod = eodByIsin.get(isin) ?? null;
    rs.bondMaster = masterByIsin.get(isin) ?? null;
  }
}
