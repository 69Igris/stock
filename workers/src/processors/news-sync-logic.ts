/**
 * News-sync processor — PURE helpers (no Prisma / network).
 *
 * `news-sync.ts` resolves its params, decides whether to auto-discover the
 * symbol set, and builds the discovery WHERE clause inline; the test re-declared
 * a whole `processNewsSync` copy + the route handler and asserted the copies
 * (a shadow). These side-effect-free bits now live here and the processor imports
 * + CALLS them. Mirrors `mf-sync-logic.ts`.
 *
 * @see workers/src/processors/news-sync.ts (caller)
 * @see apps/web/__tests__/workers/processor-news-sync.test.ts (tests the real exports)
 */

/**
 * The exchange the news population is scoped to.
 *
 * ONE constant, read by BOTH `buildNewsDiscoveryWhere` (which SELECTS) and
 * `stampSyncMarker` in the processor (which RETIRES a row from that selection).
 * They were two independent literals — one present, one absent — and that is
 * the whole of defect (2) below.
 */
export const NEWS_DISCOVERY_EXCHANGE = "NSE" as const;

export const DEFAULT_NEWS_LIMIT = 50;
export const DEFAULT_NEWS_DELAY_MS = 500;
/** Headlines fetched per symbol. */
export const NEWS_PER_SYMBOL = 10;

export interface NewsSyncParams {
  limit: number;
  delayMs: number;
}

/** Resolve the job message into concrete params, applying defaults (`|| default`). */
export function resolveNewsSyncParams(data: {
  limit?: number;
  delayMs?: number;
}): NewsSyncParams {
  return {
    limit: data.limit || DEFAULT_NEWS_LIMIT,
    delayMs: data.delayMs || DEFAULT_NEWS_DELAY_MS,
  };
}

/**
 * Whether the processor must auto-discover the top-analyzed symbol set: true
 * when the caller did not supply a non-empty `symbols` array.
 */
export function needsSymbolDiscovery(symbols: string[] | undefined): boolean {
  return !symbols || symbols.length === 0;
}

/**
 * Normalise one raw symbol population — MONEY-1293.
 *
 * Trimmed, upper-cased, de-duplicated, blanks dropped. Extracted from the
 * processor because there are now THREE populations to normalise (holdings,
 * watchlist, index constituents) and a rule applied by hand three times is a
 * rule that will be applied twice.
 *
 * The blank drop is the part that earns its place: a `""` that survives becomes
 * `{ in: ["", …] }`, which matches nothing while making the population look one
 * symbol larger than it is.
 */
export function normalizeDiscoverySymbols(
  raw: ReadonlyArray<string | null | undefined>,
): string[] {
  const out = new Set<string>();
  for (const s of raw) {
    const t = (s ?? "").trim().toUpperCase();
    if (t) out.add(t);
  }
  return [...out];
}

/** One OR arm of the discovery WHERE. */
export type NewsDiscoveryArm =
  | { symbol: { in: string[] } }
  | { analysisCount: { gt: 0 } };

export interface NewsDiscoveryWhere {
  isActive: true;
  instrumentType: "EQUITY";
  exchange: typeof NEWS_DISCOVERY_EXCHANGE;
  OR: NewsDiscoveryArm[];
}

/**
 * WHERE clause for the news-discovery query — MONEY-1215, widened by MONEY-1293.
 *
 * ## This used to select NOTHING, every run, for months
 *
 * It returned `{isActive, instrumentType:"EQUITY", exchange:"NSE",
 * analysisCount:{gt:0}}`, and `analysisCount` is incremented in exactly one
 * place — `packages/research/src/data-sources/db-store.ts`, on a StockSage
 * research run. Measured on prod 2026-08-19: **0 of 10,444** active NSE
 * equities have `analysisCount > 0`. Re-measured 2026-08-30: still **0**.
 *
 * `news-sync-market-hours-prod` is ENABLED and fires 4x EVERY DAY with an
 * empty payload `{}`, so auto-discovery is the ONLY path. Every one of those
 * runs logged `Syncing news for 0 symbols` and reported success. `stock_news`
 * holds 31 rows, newest `createdAt` 2026-04-16 — four months stale, and those
 * 31 came from on-demand `getOrFetchNews` calls off the web app, not from this
 * job.
 *
 * The schedule was `0 9,11,13,15 * * 1-5` — WEEKDAYS — until 2026-08-30, on the
 * reasoning that it tracked market hours. But news is not a market: companies
 * publish on weekends, and so does every wire this job reads. Measured that
 * Sunday, `stock_news` was 43.6h stale while `news_articles` (RSS, every 15
 * minutes, all week) was 15.6h — the two feeds had silently diverged by a day
 * and a half. Now `0 9,11,13,15 * * *`.
 *
 * Identical defect and identical fix to the tier selector that used to live in
 * `financial-data-sync-logic.ts` (MONEY-1211). That file is gone — deleted in
 * MONEY-1220 with the Tickertape processor it configured — and the surviving
 * shared implementation is `sync-tiers.ts` in `@usemoney/core/market-data`. The
 * populations are resolved by the caller and passed in, keeping this a pure
 * function.
 *
 * `analysisCount > 0` is KEPT as an OR branch rather than replaced: it is dead
 * today and correct the day StockSage starts writing it.
 *
 * ## MONEY-1293 — the population was 79 symbols, and that was the ceiling
 *
 * Measured on prod 2026-08-30, and the number that matters is not the stale
 * one:
 *
 *   Holding ∪ WatchlistItem            103 distinct symbols
 *     narrowed by isActive/EQUITY/NSE   79   <- everything this job could ever see
 *   analysisCount > 0                    0
 *   stock_news                        1,727 rows over 77 distinct symbols
 *
 * So `stock_news` was NOT stalled — 77 of 79 reachable symbols had news, and
 * the rotation below had been working. It was COMPLETE, over a population two
 * orders of magnitude smaller than the market. Every symbol nobody in the user
 * base happens to hold or watch had, by construction, no news and no path to
 * any: a stock-detail page for a NIFTY 50 constituent nobody had touched
 * rendered an empty News tab forever, and no counter anywhere read as unhealthy
 * because the job genuinely had nothing else to select.
 *
 * That is the reason the constituent arm is a POPULATION widening and not a
 * bug fix. `index_constituents` is refreshed weekly by `index-constituent-sync`
 * and held, measured the same day, 3,274 rows across 17 indices — NIFTY 500 at
 * exactly 500, NIFTY Total Market at 750 — collapsing to **753 distinct
 * symbols, 749 of which are active NSE equities**. Union with the portfolio
 * population: **810 symbols, 782 selectable rows**, a 9.9x widening. At
 * `DEFAULT_NEWS_LIMIT` 50 x 4 runs/day a full rotation is ~4 days, against the
 * ~16 days a whole-universe pass over ~3,184 real NSE cash equities would take.
 *
 * ### Why a SEPARATE OR arm rather than one merged `in` list
 *
 * `{symbol:{in:A}} OR {symbol:{in:B}}` and `{symbol:{in:A ∪ B}}` select the
 * identical rows, so this is a choice about what the code can be asked. Kept
 * separate because the two populations answer to different owners and fail
 * differently: the portfolio arm goes empty when nobody holds anything, the
 * constituent arm goes empty when `index-constituent-sync` dies. Merged, either
 * failure is a slightly smaller number in one list and neither is visible from
 * the query. Separate, the arm is either there or it is not — which is also
 * what makes "drop the constituent arm" a mutation a test can catch.
 *
 * An empty `{ in: [] }` matches NOTHING in Prisma, so an EMPTY population must
 * omit its arm rather than emit it — otherwise the OR is satisfied only by the
 * dead `analysisCount` arm and we are back where we started. That rule applies
 * to both arms, which is why passing no constituents renders byte-identically
 * to the pre-MONEY-1293 shape.
 */
export function buildNewsDiscoveryWhere(
  portfolio: readonly string[] = [],
  constituents: readonly string[] = [],
): NewsDiscoveryWhere {
  const or: NewsDiscoveryArm[] = [];
  if (portfolio.length > 0) or.push({ symbol: { in: [...portfolio] } });
  if (constituents.length > 0) or.push({ symbol: { in: [...constituents] } });
  // Last, and unconditional: it is the arm that costs nothing and is correct
  // the day StockSage starts incrementing the column.
  or.push({ analysisCount: { gt: 0 } });
  return {
    isActive: true,
    instrumentType: "EQUITY",
    exchange: NEWS_DISCOVERY_EXCHANGE,
    OR: or,
  };
}
