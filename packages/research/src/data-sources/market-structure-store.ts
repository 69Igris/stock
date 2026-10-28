/**
 * Market-structure research data — the READER — MONEY-1204 (P14 / 14e.2).
 *
 * Thin Prisma readers behind the agent's market-structure tools. Every one of
 * them returns a `CitedRows` (`{ rows, asOf, provenance }`) so the synthesizer
 * can attribute what it says, and every one of them DEGRADES rather than
 * throwing: a table that is empty, missing or transiently unreadable yields an
 * empty cited result with a `note` saying which, because "we have not ingested
 * this yet" and "there is nothing to find" are different answers and the agent
 * must be able to tell them apart.
 *
 * All shaping, all absence rules and all grain arithmetic live in
 * `market-structure-logic.ts` and are tested without a database. This file only
 * chooses indexes, windows and orderings.
 *
 * The Prisma client is injected through `deps` rather than imported at module
 * top for the MONEY-1060 reason: `@usemoney/database` instantiates
 * `PrismaClient` at module scope, and a tool that loads it eagerly dies in a
 * Prisma-broken environment where the live fallback would have succeeded.
 */

import prisma from "@usemoney/database";
import {
  buildStockFlagBadges,
  type StockFlagStateRow,
} from "@usemoney/core/market-data";

import {
  emptyCited,
  isoOrNull,
  newestAsOf,
  normalizeIsin,
  toBondQuoteRow,
  toDealRow,
  toFlowRow,
  toFundHoldingRow,
  toMacroRow,
  toPositioningRow,
  toStockFlagRowOut,
  toVixRow,
  INDIA_VIX_SLUG,
  type BondQuoteRow,
  type CitedRows,
  type DealRow,
  type FlowRow,
  type FundHoldingRow,
  type MacroRow,
  type PositioningRow,
  type StockFlagRowOut,
  type VixRow,
} from "./market-structure-logic";

export interface StoreDeps {
  prisma?: typeof prisma;
}

/** Every flag kind `StockFlag` can carry — the tool surfaces all of them. */
const ALL_FLAG_KINDS = [
  "FO_BAN",
  "SURVEILLANCE",
  "PRICE_BAND",
  "BAND_CHANGE",
  "SERIES_CHANGE",
  "WK52_HIGH_LOW",
  "SHORT_SELLING",
] as const;

function db(deps: StoreDeps): typeof prisma {
  return deps.prisma ?? prisma;
}

function since(days: number, now: number): Date {
  return new Date(now - Math.max(1, days) * 86_400_000);
}

function cleanSymbol(symbol: string): string {
  return symbol
    .replace(/\.(NS|BO)$/i, "")
    .trim()
    .toUpperCase();
}

function dayKey(v: Date | string | null | undefined): string | null {
  const iso = isoOrNull(v);
  return iso === null ? null : iso.slice(0, 10);
}

/**
 * Run a read; on ANY failure return an empty cited result rather than throwing.
 *
 * `BondEOD` / `BondMaster` are new in this branch and nearly empty, and
 * `MfPortfolioHolding` covers 3 of the top-5 AMCs — an agent tool over either
 * must be able to say "nothing" without taking the whole research run down.
 */
async function guarded<T>(
  source: string,
  emptyNote: string,
  run: () => Promise<CitedRows<T>>,
): Promise<CitedRows<T>> {
  try {
    return await run();
  } catch (err) {
    return emptyCited<T>(source, emptyNote, {
      sourceError: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Institutional deals ─────────────────────────────────────────────

/**
 * Bulk & block deals from `InstitutionalDeal`.
 *
 * Symbol-scoped reads use `@@index([symbol, date])`; market-wide reads use
 * `@@index([date])`. `qty` is a Prisma `BigInt` and is coerced in
 * `toDealRow` — before it can reach `JSON.stringify`, which throws on one.
 */
export async function getDealsFromDb(
  opts: {
    symbol?: string | null;
    days?: number;
    limit?: number;
    dealType?: "BULK" | "BLOCK" | null;
  },
  deps: StoreDeps = {},
  now: number = Date.now(),
): Promise<CitedRows<DealRow>> {
  return guarded<DealRow>(
    "InstitutionalDeal",
    "No bulk/block deals recorded for this window. NSE only publishes a deal when one crossed the disclosure threshold, so an empty result is usually a genuine absence rather than a gap.",
    async () => {
      const symbol = opts.symbol ? cleanSymbol(opts.symbol) : null;
      const rows = await db(deps).institutionalDeal.findMany({
        where: {
          ...(symbol ? { symbol } : {}),
          ...(opts.dealType ? { dealType: opts.dealType } : {}),
          date: { gte: since(opts.days ?? 30, now) },
        },
        orderBy: { date: "desc" },
        take: Math.min(Math.max(opts.limit ?? 100, 1), 500),
      });
      const mapped = rows
        .map((r) => toDealRow(r as unknown as Record<string, unknown>))
        .filter((r): r is DealRow => r !== null);
      return {
        rows: mapped,
        asOf: newestAsOf(mapped),
        provenance: { origin: "DB", source: "InstitutionalDeal" },
      };
    },
  );
}

// ─── FII / DII flows ─────────────────────────────────────────────────

/** Daily FII/DII cash flows from `InstitutionalFlow` (`@@index([category, date desc])`). */
export async function getFlowsFromDb(
  opts: { days?: number; category?: "FII" | "DII" | null; segment?: string },
  deps: StoreDeps = {},
  now: number = Date.now(),
): Promise<CitedRows<FlowRow>> {
  return guarded<FlowRow>(
    "InstitutionalFlow",
    "No FII/DII flow rows in this window.",
    async () => {
      const rows = await db(deps).institutionalFlow.findMany({
        where: {
          ...(opts.category ? { category: opts.category } : {}),
          segment: opts.segment ?? "CASH",
          date: { gte: since(opts.days ?? 30, now) },
        },
        orderBy: { date: "desc" },
        take: 200,
      });
      const mapped = rows
        .map((r) => toFlowRow(r as unknown as Record<string, unknown>))
        .filter((r): r is FlowRow => r !== null);
      return {
        rows: mapped,
        asOf: newestAsOf(mapped),
        provenance: { origin: "DB", source: "InstitutionalFlow" },
      };
    },
  );
}

// ─── Macro series ────────────────────────────────────────────────────

/**
 * Macro observations from `MacroSeries`.
 *
 * `period` is what the observation is ABOUT, never when we fetched it — the two
 * differ on every one of these pages, which show several past periods at once.
 * Ordering by `period desc` is served by `@@index([seriesId, period desc])`
 * when `seriesId` is constrained and by `@@index([period desc])` otherwise.
 */
export async function getMacroFromDb(
  opts: { seriesIds?: readonly string[]; limit?: number },
  deps: StoreDeps = {},
): Promise<CitedRows<MacroRow>> {
  return guarded<MacroRow>(
    "MacroSeries",
    "No macro observations ingested. The RBI/MOSPI series land on their own weekly and monthly schedules.",
    async () => {
      const ids = (opts.seriesIds ?? []).filter((s) => s.trim() !== "");
      const rows = await db(deps).macroSeries.findMany({
        where: ids.length > 0 ? { seriesId: { in: [...ids] } } : {},
        orderBy: [{ seriesId: "asc" }, { period: "desc" }],
        take: Math.min(Math.max(opts.limit ?? 200, 1), 1000),
      });
      const mapped = rows
        .map((r) => toMacroRow(r as unknown as Record<string, unknown>))
        .filter((r): r is MacroRow => r !== null);
      return {
        rows: mapped,
        asOf: newestAsOf(mapped),
        provenance: { origin: "DB", source: "MacroSeries" },
      };
    },
  );
}

// ─── Stock flags ─────────────────────────────────────────────────────

/**
 * One stock's CURRENT flag state, per kind, from `StockFlag`.
 *
 * Two reads, and the second one is the whole point:
 *
 *   1. This stock's rows over the window, off `@@index([symbol, kind, date desc])`.
 *   2. Per KIND, the newest day that kind was published MARKET-WIDE, off
 *      `@@index([kind, date desc])` — one tiny `findFirst` each.
 *
 * Without (2) there is nothing to judge "current" against: `StockFlag` has NO
 * `@@unique` by design (a 40-day ban is 40 rows and the run length IS the
 * datum), so a stock's own newest FO_BAN row is trivially its own newest row
 * and every past ban reads as live. The reference is per kind rather than one
 * global maximum because the families arrive in different files on different
 * schedules — sharing one would make every surveillance badge non-current the
 * day the surveillance file ran an hour behind the ban file.
 */
export async function getStockFlagsFromDb(
  opts: { symbol: string; exchange?: string; days?: number },
  deps: StoreDeps = {},
  now: number = Date.now(),
): Promise<CitedRows<StockFlagRowOut>> {
  return guarded<StockFlagRowOut>(
    "StockFlag",
    "No surveillance, band or ban rows for this symbol in the window.",
    async () => {
      const client = db(deps);
      const symbol = cleanSymbol(opts.symbol);
      const windowDays = opts.days ?? 120;

      const rows = await client.stockFlag.findMany({
        where: {
          symbol,
          ...(opts.exchange ? { exchange: opts.exchange } : {}),
          date: { gte: since(windowDays, now) },
        },
        orderBy: { date: "desc" },
        take: 1000,
        select: {
          kind: true,
          value: true,
          date: true,
          series: true,
          source: true,
        },
      });

      if (rows.length === 0) {
        return {
          rows: [],
          asOf: null,
          provenance: {
            origin: "DB",
            source: "StockFlag",
            note: `No flags for ${symbol} in the last ${windowDays} days.`,
          },
        };
      }

      const kinds = Array.from(new Set(rows.map((r) => r.kind))).filter((k) =>
        (ALL_FLAG_KINDS as readonly string[]).includes(k),
      );

      const out: StockFlagRowOut[] = [];
      for (const kind of kinds) {
        const reference = await client.stockFlag.findFirst({
          where: { kind },
          orderBy: { date: "desc" },
          select: { date: true },
        });
        const referenceDay = dayKey(reference?.date ?? null);
        // No market-wide day for the kind means the family has not landed at
        // all. Judging "current" against nothing would answer "not flagged",
        // which is a fail-open — so the kind is skipped and simply absent.
        if (referenceDay === null) continue;

        const kindRows: StockFlagStateRow[] = rows
          .filter((r) => r.kind === kind)
          .map((r) => ({
            kind: r.kind,
            value: r.value,
            date: r.date,
            series: r.series,
            source: r.source,
          }));

        for (const badge of buildStockFlagBadges(kindRows, { referenceDay })) {
          out.push(toStockFlagRowOut(badge));
        }
      }

      out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

      return {
        rows: out,
        asOf: newestAsOf(out),
        provenance: { origin: "DB", source: "StockFlag" },
      };
    },
  );
}

// ─── Positioning ─────────────────────────────────────────────────────

/**
 * `MarketPositioning` rows for ONE metric.
 *
 * `metric` is a REQUIRED argument and goes into the `where`, never a
 * post-filter: the table holds two incompatible grains (`OI`/`VOLUME` from the
 * participant feed over `FUT_IDX`-style buckets, and `FII_STATS` over
 * `IDX_FUT`-style buckets with rupee values), and reading both back is how a
 * chart ends up averaging a stock against a flow. The query is served by
 * `@@index([participant, bucket, metric, date desc])` when a participant is
 * named and `@@index([date, metric])` otherwise.
 */
export async function getPositioningFromDb(
  opts: {
    metric: string;
    participant?: string | null;
    bucket?: string | null;
    days?: number;
    limit?: number;
  },
  deps: StoreDeps = {},
  now: number = Date.now(),
): Promise<CitedRows<PositioningRow>> {
  return guarded<PositioningRow>(
    "MarketPositioning",
    "No positioning rows for that metric and window.",
    async () => {
      const rows = await db(deps).marketPositioning.findMany({
        where: {
          metric: opts.metric,
          ...(opts.participant ? { participant: opts.participant } : {}),
          ...(opts.bucket ? { bucket: opts.bucket } : {}),
          date: { gte: since(opts.days ?? 30, now) },
        },
        orderBy: { date: "desc" },
        take: Math.min(Math.max(opts.limit ?? 300, 1), 1000),
      });
      const mapped = rows
        .map((r) => toPositioningRow(r as unknown as Record<string, unknown>))
        .filter((r): r is PositioningRow => r !== null);
      return {
        rows: mapped,
        asOf: newestAsOf(mapped),
        provenance: { origin: "DB", source: "MarketPositioning" },
      };
    },
  );
}

// ─── Mutual-fund holdings ────────────────────────────────────────────

/**
 * "Which funds hold X" from `MfPortfolioHolding`.
 *
 * Queried by ISIN, because THERE IS NO `symbol` COLUMN — the AMC files carry
 * the holding's ISIN and its printed name and nothing else, and `instrumentId`
 * is nullable (an unmatched holding is still a real holding). `@@index([isin,
 * period desc])` is exactly this read; `instrumentId` is the secondary path for
 * the rows whose ISIN never resolved.
 */
export async function getFundsHoldingFromDb(
  opts: {
    isin?: string | null;
    instrumentId?: string | null;
    months?: number;
    limit?: number;
  },
  deps: StoreDeps = {},
  now: number = Date.now(),
): Promise<CitedRows<FundHoldingRow>> {
  return guarded<FundHoldingRow>(
    "MfPortfolioHolding",
    "No AMC portfolio disclosures matched. Only 3 of the top-5 AMCs are fetched (ABSL and Kotak have unproven URLs, and a guessed URL 404s identically to 'not published yet'), and Nippon keeps only the current month.",
    async () => {
      const isin = normalizeIsin(opts.isin);
      const instrumentId = opts.instrumentId ?? null;
      if (!isin && !instrumentId) {
        return emptyCited<FundHoldingRow>(
          "MfPortfolioHolding",
          "No ISIN could be resolved for that symbol, and this table has no symbol column to fall back on.",
        );
      }

      const rows = await db(deps).mfPortfolioHolding.findMany({
        where: {
          ...(isin ? { isin } : { instrumentId }),
          period: { gte: since((opts.months ?? 6) * 31, now) },
        },
        orderBy: { period: "desc" },
        take: Math.min(Math.max(opts.limit ?? 200, 1), 1000),
      });
      const mapped = rows
        .map((r) => toFundHoldingRow(r as unknown as Record<string, unknown>))
        .filter((r): r is FundHoldingRow => r !== null);
      return {
        rows: mapped,
        asOf: newestAsOf(mapped),
        provenance: { origin: "DB", source: "MfPortfolioHolding" },
      };
    },
  );
}

// ─── Bonds ───────────────────────────────────────────────────────────

/**
 * Bond end-of-day quotes from `BondEOD`, enriched from `BondMaster`.
 *
 * BOTH tables are new in this branch and carry almost no rows — the history
 * walk is founder-gated — so the ONLY acceptable failure mode is an empty,
 * cited result. A thrown tool would take a research run down over a table we
 * always knew was empty.
 *
 * `segment` stays on every row: the same ISIN can print in CBM and WDM on the
 * same day at different prices, which is why it is in `@@unique([isin, date,
 * segment])`, and collapsing them is how MONEY-1201 lost 84.2% of open interest.
 */
export async function getBondQuotesFromDb(
  opts: { isins: readonly string[]; days?: number; limit?: number },
  deps: StoreDeps = {},
  now: number = Date.now(),
): Promise<CitedRows<BondQuoteRow>> {
  return guarded<BondQuoteRow>(
    "BondEOD",
    "No bond end-of-day rows. `bond_eod` and `bond_master` are new and nearly empty — their history walk is founder-gated — so this is a coverage gap, not evidence the bond does not trade.",
    async () => {
      const isins = Array.from(
        new Set(
          opts.isins
            .map((i) => normalizeIsin(i))
            .filter((i): i is string => i !== null),
        ),
      );
      if (isins.length === 0) {
        return emptyCited<BondQuoteRow>(
          "BondEOD",
          "No ISIN to look up. Bond rows join on ISIN only — there is no symbol column on `bond_eod`.",
        );
      }

      const client = db(deps);
      const eod = await client.bondEOD.findMany({
        where: {
          isin: { in: isins },
          date: { gte: since(opts.days ?? 180, now) },
        },
        orderBy: [{ isin: "asc" }, { date: "desc" }],
        take: Math.min(Math.max(opts.limit ?? 200, 1), 1000),
      });

      const masters = await client.bondMaster.findMany({
        where: { isin: { in: isins } },
      });
      const masterByIsin = new Map<string, Record<string, unknown>>();
      for (const m of masters) {
        const key = normalizeIsin((m as { isin: string }).isin);
        if (key && !masterByIsin.has(key)) {
          masterByIsin.set(key, m as unknown as Record<string, unknown>);
        }
      }

      const mapped = eod
        .map((r) => {
          const row = r as unknown as Record<string, unknown>;
          const key = normalizeIsin(row.isin);
          return toBondQuoteRow(
            row,
            key ? (masterByIsin.get(key) ?? null) : null,
          );
        })
        .filter((r): r is BondQuoteRow => r !== null);

      return {
        rows: mapped,
        asOf: newestAsOf(mapped),
        provenance: { origin: "DB", source: "BondEOD + BondMaster" },
      };
    },
  );
}

/** Resolve an equity/debt symbol to its ISIN. Bonds join on ISIN only. */
export async function resolveIsins(
  symbols: readonly string[],
  deps: StoreDeps = {},
): Promise<string[]> {
  if (symbols.length === 0) return [];
  try {
    const rows = await db(deps).instrumentMapping.findMany({
      where: {
        symbol: { in: symbols.map((s) => cleanSymbol(s)) },
        isActive: true,
      },
      select: { isin: true },
    });
    return Array.from(
      new Set(
        rows
          .map((r) => normalizeIsin(r.isin))
          .filter((i): i is string => i !== null),
      ),
    );
  } catch {
    return [];
  }
}

// ─── India VIX ───────────────────────────────────────────────────────

/**
 * India VIX history from `IndexClose` where `indexSlug = "india-vix"`.
 *
 * Populated, and verified from the archive:
 * `India VIX,14-08-2026,11.4175,11.56,10.825,11.31,-,-,-,-,-` — depth back to
 * H1-2014. Those five trailing `-` are why `volume` / `turnoverCr` / `pe` /
 * `pb` / `divYield` come back `null`: a volatility index has no basket to
 * value, so there is no measurement to report, and a rendered 0 would state
 * one that was never made.
 */
export async function getVixFromDb(
  opts: { days?: number; limit?: number },
  deps: StoreDeps = {},
  now: number = Date.now(),
): Promise<CitedRows<VixRow>> {
  return guarded<VixRow>(
    "IndexClose",
    "No India VIX rows in the window.",
    async () => {
      const rows = await db(deps).indexClose.findMany({
        // `@@index([indexSlug, date desc])` serves this exactly.
        where: {
          indexSlug: INDIA_VIX_SLUG,
          date: { gte: since(opts.days ?? 90, now) },
        },
        orderBy: { date: "desc" },
        take: Math.min(Math.max(opts.limit ?? 250, 1), 2000),
      });
      const mapped = rows
        .map((r) => toVixRow(r as unknown as Record<string, unknown>))
        .filter((r): r is VixRow => r !== null);
      return {
        rows: mapped,
        asOf: newestAsOf(mapped),
        provenance: { origin: "DB", source: "IndexClose (india-vix)" },
      };
    },
  );
}
