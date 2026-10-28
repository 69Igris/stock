/**
 * Peers sync (MONEY-1145) — I/O orchestration.
 *
 * `stock_peers` had 0 rows platform-wide. The only writer was a StockSage
 * research pass, so the Peers tab was empty by construction for every stock
 * since it shipped. This job derives peers from our OWN instrument + ratio +
 * quote data, which means no upstream, no rate limit, no PROD_ONLY_JOBS split,
 * and identical behaviour on QA and prod — the same posture as
 * `mf-nav-propagate`.
 *
 * Selection rules (and the measurements behind them) live in
 * `@usemoney/core/market-data` → `peer-selection-logic.ts`, which is pure and
 * unit-tested. This module is the part that touches the database.
 */

import { prisma } from "@usemoney/database";
import {
  hasRealSector,
  indexUniverse,
  selectPeers,
  type PeerCandidate,
  type SelectedPeer,
} from "@usemoney/core/market-data";
import { dbLogger as logger } from "@usemoney/logger";

import { mapWithConcurrency } from "./concurrency-logic";

/**
 * Provenance. NOT a vendor name — MONEY-1144 removed those from the product
 * surface, and inheriting the schema default `"TICKERTAPE"` for rows we
 * computed ourselves would be both wrong and a regression of that ticket.
 */
export const PEERS_SOURCE = "DERIVED";

/**
 * Composite map key for (symbol, exchange).
 *
 * The separator is a NUL written as the two-character ESCAPE, never the literal
 * byte. A NUL cannot occur in a symbol or an exchange, so the key is
 * unambiguous — but embedding the raw byte in the SOURCE makes git classify the
 * whole file as binary (its sniff window is the first 8000 bytes, and the first
 * of the two sites here sat at byte 4,649). A binary file has no diff in
 * `/code-review`, `gh pr diff` or `git log -p`, so every later change to it
 * ships unreviewed. Pinned by the repo-wide scan in
 * `packages/core/__tests__/screener/market-fields-reader.test.ts`.
 *
 * Exported and used by BOTH call sites on purpose: the key used to be built by
 * a local helper in one function and re-inlined by hand in another, which is
 * two constructions of one key that can drift apart silently.
 */
const KEY_SEP = "\u0000";

export function symbolExchangeKey(symbol: string, exchange: string): string {
  return `${symbol}${KEY_SEP}${exchange}`;
}

/** The subset of a `StockRatios` row this lookup needs to key on. */
export interface ExchangeKeyed {
  symbol: string;
  exchange: string;
}

/**
 * Resolve a listing's ratios, falling back to the company's NSE row.
 *
 * MONEY-1255. `stock_ratios` is written against NSE symbols — the XBRL
 * projection and the ratios job both key on the NSE filer — while
 * `instrument_mappings` carries a row per LISTING. So every BSE instrument
 * missed the exact (symbol, exchange) lookup and got a `stock_peers` row with
 * `marketCap: null, pe: null, roe: null`; only `changePercent` survived,
 * because that one joins on `instrumentId`. Verified in prod: every BSE peers
 * row carried exactly those three nulls, so the whole BSE side of the tab
 * rendered blank while looking perfectly healthy.
 *
 * A P/E, an ROE and a market cap are properties of the COMPANY, not of the
 * venue — a dual-listed company has one set of fundamentals and two tickers —
 * so reading the NSE row for a BSE listing is the correct value, not an
 * approximation.
 *
 * The exact (symbol, exchange) match still WINS. The fallback can therefore
 * only fill a cell that would otherwise have been null; it can never overwrite
 * a venue-specific row that genuinely exists. The fallback index is built from
 * NSE rows ONLY, so it stays a one-way BSE -> NSE read and two non-NSE listings
 * of different companies can never resolve to each other.
 */
export function buildRatioLookup<T extends ExchangeKeyed>(
  ratios: readonly T[],
): (symbol: string, exchange: string) => T | undefined {
  const byListing = new Map<string, T>();
  const byNseSymbol = new Map<string, T>();
  for (const r of ratios) {
    byListing.set(symbolExchangeKey(r.symbol, r.exchange), r);
    if (r.exchange === "NSE") byNseSymbol.set(r.symbol, r);
  }
  return (symbol, exchange) =>
    byListing.get(symbolExchangeKey(symbol, exchange)) ??
    byNseSymbol.get(symbol);
}

/**
 * Concurrent upserts. Same reasoning as every other bounded fan-out here: the
 * unbounded version stampedes the Mongo pool, and this job writes thousands of
 * rows in one pass.
 *
 * MEASURED on the QA DB (2026-08-05): 6,992 upserts in **168s** at this width,
 * ~24ms each against a remote Atlas. The push subscription's `--ack-deadline`
 * is **600s** (`workers/scripts/setup-pubsub.sh`), so there is ~3.5x headroom.
 *
 * That headroom is the number to watch, not the wall-clock: the universe grows
 * with instrument coverage, and blowing the ack deadline does not fail loudly —
 * Pub/Sub redelivers, so the job silently runs AGAIN on top of itself. If
 * scanned counts approach ~25k, raise this width before raising the deadline;
 * the whole computation (load + index + select) is only 2.4s of the 168, so
 * this is write-bound and widening actually helps.
 */
const UPSERT_CONCURRENCY = 8;

/** Rows per read page. The universe is ~22k instruments, so this is 3 pages. */
const READ_PAGE = 10_000;

export interface PeersSyncResult {
  /** Instruments considered (active EQUITY with a REAL sector). */
  scanned: number;
  /** Rows written — including deliberate empties, see below. */
  written: number;
  /** Instruments that produced at least one peer. */
  withPeers: number;
  /** Skipped for having no real sector (the "N/A" sentinel, or null). */
  skippedNoSector: number;
}

type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Build the candidate universe: every active EQUITY instrument, joined with its
 * ratios (marketCap/pe/roe) and latest quote (changePercent).
 *
 * Three batched reads rather than a per-instrument join. `StockRatios` is keyed
 * on the natural `(symbol, exchange)` — deliberately, per MONEY-1145: the
 * `instrumentId` FK is mutable and re-seeding `instrument_mappings` silently
 * orphans every row that depends on it. `LatestQuote` has no natural key, so it
 * is joined on `instrumentId`, which is safe HERE only because the price sync
 * re-resolves those ids daily.
 */
async function loadUniverse(): Promise<{
  candidates: PeerCandidate[];
  idBySymbolExchange: Map<string, string>;
  skippedNoSector: number;
}> {
  const instruments: Array<{
    id: string;
    symbol: string;
    exchange: string;
    name: string;
    sector: string | null;
    industry: string | null;
  }> = [];

  // Keyset-free paging is fine at this size and keeps the query planner on the
  // `[isActive, instrumentType, sector]` index.
  for (let skip = 0; ; skip += READ_PAGE) {
    const page = await prisma.instrumentMapping.findMany({
      where: { isActive: true, instrumentType: "EQUITY" },
      select: {
        id: true,
        symbol: true,
        exchange: true,
        name: true,
        sector: true,
        industry: true,
      },
      orderBy: { id: "asc" },
      skip,
      take: READ_PAGE,
    });
    instruments.push(...page);
    if (page.length < READ_PAGE) break;
  }

  const [ratios, quotes] = await Promise.all([
    prisma.stockRatios.findMany({
      select: {
        symbol: true,
        exchange: true,
        marketCap: true,
        pe: true,
        roe: true,
      },
    }),
    prisma.latestQuote.findMany({
      select: { instrumentId: true, changePercent: true },
    }),
  ]);

  const lookupRatios = buildRatioLookup(ratios);
  const quoteBy = new Map(quotes.map((q) => [q.instrumentId, q.changePercent]));

  const candidates: PeerCandidate[] = [];
  const idBySymbolExchange = new Map<string, string>();
  let skippedNoSector = 0;

  for (const i of instruments) {
    if (!hasRealSector(i.sector)) {
      skippedNoSector += 1;
      continue;
    }
    const r = lookupRatios(i.symbol, i.exchange);
    candidates.push({
      symbol: i.symbol,
      exchange: i.exchange,
      name: i.name,
      sector: i.sector,
      industry: i.industry,
      marketCap: r?.marketCap ?? null,
      pe: r?.pe ?? null,
      roe: r?.roe ?? null,
      changePercent: quoteBy.get(i.id) ?? null,
    });
    idBySymbolExchange.set(symbolExchangeKey(i.symbol, i.exchange), i.id);
  }

  return { candidates, idBySymbolExchange, skippedNoSector };
}

/**
 * Recompute `stock_peers` for the whole classifiable universe.
 *
 * ## Why empty results are WRITTEN rather than skipped
 *
 * Every processed instrument gets a row, even at `peerCount: 0`. That is what
 * makes "no row" mean *not computed yet* and "row with 0 peers" mean *computed,
 * genuinely has none* — the empty-vs-failed distinction MONEY-1145 asked for,
 * and the reason the tab could sit empty unnoticed for so long.
 *
 * It also fixes a staleness bug the skip-empties version would keep: if an
 * instrument is re-classified and no longer has peers, skipping would leave the
 * previous row serving stale ones forever.
 */
export async function syncStockPeers(
  opts: { dryRun?: boolean } = {},
): Promise<ServiceResult<PeersSyncResult>> {
  try {
    const { candidates, idBySymbolExchange, skippedNoSector } =
      await loadUniverse();
    const index = indexUniverse(candidates);

    let withPeers = 0;
    const rows = candidates.map((target) => {
      const peers: SelectedPeer[] = selectPeers(target, index);
      if (peers.length > 0) withPeers += 1;
      return { target, peers };
    });

    const results = await mapWithConcurrency(
      rows,
      UPSERT_CONCURRENCY,
      async ({ target, peers }) => {
        const instrumentId = idBySymbolExchange.get(
          symbolExchangeKey(target.symbol, target.exchange),
        );
        // Never write the sentinel id the old research writer used
        // ("000000000000000000000000"): it produced rows no reader querying by
        // instrumentId could ever match. If we cannot resolve a real id, we
        // skip rather than invent one.
        if (!instrumentId) return false;

        // Dry run counts what WOULD be written. Same house pattern as
        // `scripts/data/resector-real-estate.ts`: this job rewrites thousands of
        // rows, so being able to see the shape of a run before committing it is
        // the difference between a reviewable change and a hopeful one.
        if (opts.dryRun) return true;

        const peersJson = JSON.parse(JSON.stringify(peers)) as object[];
        await prisma.stockPeers.upsert({
          where: {
            symbol_exchange: {
              symbol: target.symbol,
              exchange: target.exchange,
            },
          },
          update: {
            peers: peersJson,
            peerCount: peers.length,
            source: PEERS_SOURCE,
            fetchedAt: new Date(),
          },
          create: {
            instrumentId,
            symbol: target.symbol,
            exchange: target.exchange,
            peers: peersJson,
            peerCount: peers.length,
            source: PEERS_SOURCE,
          },
        });
        return true;
      },
    );

    const written = results.filter(Boolean).length;
    return {
      success: true,
      data: { scanned: candidates.length, written, withPeers, skippedNoSector },
    };
  } catch (error) {
    logger.error({ error }, "Peers sync failed");
    return { success: false, error: "Failed to sync stock peers" };
  }
}
