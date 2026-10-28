/**
 * Fetch corporate actions and build a price-adjustment timeline for a symbol —
 * MONEY-1176.
 *
 * The MODEL is pure and lives in `@usemoney/core/market-data` (price-adjust.ts).
 * This is the thin DB/cache layer around it, kept out of the route so the route
 * stays about HTTP.
 *
 * ## Why a fingerprint, not just a TTL
 *
 * The UDF history cache is keyed per (symbol, interval, window). If a newly
 * backfilled split only invalidated by TTL, then for the whole TTL some windows
 * would be cached ADJUSTED and neighbouring ones UNADJUSTED — a single chart
 * would draw part of its history on one basis and part on another, which is
 * worse than being uniformly stale. The fingerprint (count + newest
 * `updatedAt`) changes the moment a backfill lands, so every window rolls over
 * together.
 */

import { prisma } from "@usemoney/database";
import {
  buildAdjustmentTimeline,
  loadAdjustingActions,
  type AdjustmentStep,
} from "@usemoney/core/market-data";

export interface SymbolAdjustment {
  steps: AdjustmentStep[];
  /** Changes whenever the underlying action set changes. */
  fingerprint: string;
  used: number;
  ignored: number;
  /** Rows another company filed under this ticker — MONEY-1543. */
  refused: number;
  /** Rows admitted because no issuer could be named for them. */
  unknownIssuer: number;
}

export const EMPTY_ADJUSTMENT: SymbolAdjustment = {
  steps: [],
  fingerprint: "none",
  used: 0,
  ignored: 0,
  refused: 0,
  unknownIssuer: 0,
};

/**
 * Actions change ~never intraday, so a small in-process cache keeps the DB out
 * of the hot path. Deliberately NOT `lib/cache/wrapper.withCache`: that helper
 * is user-scoped (it derives the key from a userId first argument) and this
 * data is identical for every user. Same shape as `earliestBarCache` in the
 * history route.
 */
const TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 2000;
const cache = new Map<string, { at: number; value: SymbolAdjustment }>();

/**
 * Load the qty-changing actions for a symbol and compile them into a timeline.
 *
 * Through `loadAdjustingActions`, the loader the tile builder calls too
 * (MONEY-1541 left this a hand copy of its query): the COMPANY's actions on
 * both exchanges, matched on the current symbol, every FORMER symbol
 * (MONEY-1177) and the ISIN — with another company's filings under the same
 * ticker refused (MONEY-1543). FOCUS is two companies on NSE and BSE, and each
 * chart divided its history by the other's bonus.
 */
export async function getSymbolAdjustment(
  symbol: string,
  exchange: string
): Promise<SymbolAdjustment> {
  const sym = symbol.toUpperCase();
  const exch = exchange.toUpperCase();

  const key = `${exch}:${sym}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const value = await (async (): Promise<SymbolAdjustment> => {
    const instrument = await prisma.instrumentMapping.findUnique({
      where: { symbol_exchange: { symbol: sym, exchange: exch } },
      select: { isin: true, previousSymbols: true },
    });

    const {
      actions: rows,
      refused,
      unknownIssuer,
    } = await loadAdjustingActions(prisma, {
      symbol: sym,
      previousSymbols: instrument?.previousSymbols,
      isin: instrument?.isin,
    });

    if (rows.length === 0) {
      return { ...EMPTY_ADJUSTMENT, refused: refused.length, unknownIssuer };
    }

    const newest = rows.reduce(
      (max, r) => (r.updatedAt > max ? r.updatedAt : max),
      rows[0]!.updatedAt
    );
    const { steps, used, ignored } = buildAdjustmentTimeline(rows);

    return {
      steps,
      // Count AND newest-updatedAt: count alone would miss a corrected ratio
      // on an existing row, which is exactly what the classifier writes.
      fingerprint: `${rows.length}-${newest.getTime()}`,
      used,
      ignored,
      refused: refused.length,
      unknownIssuer,
    };
  })();

  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

/** Test/ops hook — drop the memo so a fresh backfill is picked up at once. */
export function clearAdjustmentCache(): void {
  cache.clear();
}
