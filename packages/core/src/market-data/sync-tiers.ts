/**
 * Sync-tier populations — the shared "which symbols does a nightly job cover?"
 * decision (MONEY-1211, lifted here by MONEY-1217).
 *
 * ## Why this is in `@usemoney/core` and not in a worker
 *
 * It started life inside `workers/src/processors/financial-data-sync{,-logic}.ts`
 * as that one job's private notion of hot/warm. MONEY-1217 needed the SAME
 * population for `events-sync` — its Yahoo fallback was scoped to
 * `alerts ∪ holdings ∪ watchlist`, ~102 large-cap symbols, so an earnings
 * calendar asked by SECTOR CONSTITUENT (238 names for Financial Services)
 * barely intersected the set the job actually fetched. A second copy of the
 * tier rules in a second processor is exactly how "which population is hot"
 * drifts into two answers, so the rules live here, once, and the processors
 * import them.
 *
 * ## What a tier means
 *
 *   hot  = portfolio ∪ watchlist          ∪ (analysisCount>0 AND analyzed ≤30d)
 *   warm = hot        ∪ index constituents ∪ (analysisCount>0)
 *
 * Measured on prod 2026-08-19: hot **78**, warm **781**, from a 10,444-row
 * active NSE equity universe. The `analysisCount` branches are dead today
 * (nothing increments the counter outside a completed StockSage run) and are
 * KEPT anyway — they are the correct signal the day StockSage starts writing
 * them, and a research run is the one event that proves a user asked about a
 * symbol we do not otherwise track. Gating a tier SOLELY on that counter is what
 * MONEY-1211 removed: a selector keyed on a counter nothing increments is a
 * fail-closed gate wearing a prioritisation costume, and it let
 * `financial-data-sync` log "Found 0 instruments" and report success nightly for
 * five months.
 */

import prisma from "@usemoney/database";

/** Coverage tiers, cheapest first. */
export type SyncTier = "hot" | "warm";

/** Hot-tier recency window for the `analysisCount` branch, in days. */
export const HOT_TIER_WINDOW_DAYS = 30;

/**
 * The two symbol populations, resolved from our own tables.
 *
 * Kept as DATA rather than looked up inside the pure helpers so the tier
 * semantics stay unit-testable without a database — {@link loadSyncTierSymbols}
 * is the only part that touches Prisma.
 */
export interface SyncTierSymbols {
  /** Symbols a user is exposed to right now: `Holding` ∪ `WatchlistItem`. */
  portfolio: readonly string[];
  /** Index membership (`IndexConstituent`) — the warm tier's breadth. */
  index: readonly string[];
}

export const EMPTY_TIER_SYMBOLS: SyncTierSymbols = {
  portfolio: [],
  index: [],
};

/** The hot-tier cutoff: instruments analyzed on/after this date are "hot". */
export function computeHotTierCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - HOT_TIER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * De-duplicate + drop blanks, preserving first-seen order.
 *
 * A `""` in the list is ABSENCE, not a symbol — it must never reach
 * `symbol: { in: [...] }`, where it would silently widen the match to any row
 * carrying an empty symbol. Same rule as everywhere else in this repo: absence
 * is never a value.
 */
export function normalizeTierSymbols(
  symbols: readonly (string | null | undefined)[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of symbols) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** The symbols a tier covers: hot = portfolio; warm = portfolio ∪ index. */
export function tierSymbolSet(
  tier: SyncTier,
  symbols: SyncTierSymbols,
): string[] {
  return tier === "hot"
    ? normalizeTierSymbols(symbols.portfolio)
    : normalizeTierSymbols([...symbols.portfolio, ...symbols.index]);
}

/**
 * Build the tiered `instrumentMapping.findMany` WHERE clause.
 *
 * An EMPTY symbol list omits the `symbol` branch entirely rather than emitting
 * `{ symbol: { in: [] } }` — a branch that can never match, and which would make
 * the OR read as though a population were being considered when it is not.
 */
export function buildSyncTierWhere(
  tier: SyncTier,
  symbols: SyncTierSymbols = EMPTY_TIER_SYMBOLS,
  cutoff: Date = computeHotTierCutoff(),
): Record<string, unknown> {
  const tierSymbols = tierSymbolSet(tier, symbols);
  const analyzed =
    tier === "hot"
      ? { analysisCount: { gt: 0 }, lastAnalyzedAt: { gte: cutoff } }
      : { analysisCount: { gt: 0 } };

  return {
    isActive: true,
    instrumentType: "EQUITY",
    exchange: "NSE",
    OR: tierSymbols.length
      ? [{ symbol: { in: tierSymbols } }, analyzed]
      : [analyzed],
  };
}

/**
 * Resolve a tier's symbol populations from our OWN tables.
 *
 * Three cheap `groupBy` reads (a Mongo `$group`, not a fetch-then-dedupe), and
 * the index leg is skipped entirely on the hot tier because hot does not use it.
 * Measured on prod 2026-08-19: 79 distinct held symbols, 29 watchlisted, 753
 * index constituents.
 *
 * A failing lookup returns an EMPTY list rather than throwing: the
 * `analysisCount` branches of the WHERE still stand, and a partial population is
 * a smaller regression than a dead nightly job. It is logged, and the caller's
 * zero-selection warning is what makes a total failure visible.
 */
export async function loadSyncTierSymbols(
  tier: SyncTier,
  logLabel = "sync-tiers",
): Promise<SyncTierSymbols> {
  const grouped = async (
    label: string,
    run: () => Promise<Array<string | null>>,
  ): Promise<string[]> => {
    try {
      return normalizeTierSymbols(await run());
    } catch (err) {
      console.error(
        `[${logLabel}] ${label} symbol lookup failed — tier population degraded:`,
        err,
      );
      return [];
    }
  };

  const [holdings, watchlist] = await Promise.all([
    grouped("Holding", async () =>
      (await prisma.holding.groupBy({ by: ["symbol"] })).map((r) => r.symbol),
    ),
    grouped("WatchlistItem", async () =>
      (await prisma.watchlistItem.groupBy({ by: ["symbol"] })).map(
        (r) => r.symbol,
      ),
    ),
  ]);

  // Only the warm tier spans index membership; do not pay for it on a hot run.
  const index =
    tier === "warm"
      ? await grouped("IndexConstituent", async () =>
          (await prisma.indexConstituent.groupBy({ by: ["symbol"] })).map(
            (r) => r.symbol,
          ),
        )
      : [];

  return {
    portfolio: normalizeTierSymbols([...holdings, ...watchlist]),
    index,
  };
}
