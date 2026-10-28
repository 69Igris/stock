/**
 * Filings-sync processor — PURE helpers (no Prisma / network).
 *
 * `filings-sync.ts` resolves its params, decides whether to auto-discover the
 * hot-tier symbol set, and builds the discovery WHERE clause inline; the test
 * re-declared a whole `processFilingsSync` copy + the route handler and asserted
 * the copies (a shadow). These side-effect-free bits now live here and the
 * processor imports + CALLS them. Mirrors `mf-sync-logic.ts`.
 *
 * @see workers/src/processors/filings-sync.ts (caller)
 * @see apps/web/__tests__/workers/processor-filings-sync.test.ts (tests the real exports)
 */

export const DEFAULT_FILINGS_BATCH_SIZE = 50;
export const DEFAULT_FILINGS_DELAY_MS = 1000;
/** Hot-tier window: only instruments analyzed within the last N days. */
export const HOT_TIER_WINDOW_DAYS = 30;

export interface FilingsSyncParams {
  batchSize: number;
  delayMs: number;
}

/** Resolve the job message into concrete params, applying defaults (`|| default`). */
export function resolveFilingsSyncParams(data: {
  batchSize?: number;
  delayMs?: number;
}): FilingsSyncParams {
  return {
    batchSize: data.batchSize || DEFAULT_FILINGS_BATCH_SIZE,
    delayMs: data.delayMs || DEFAULT_FILINGS_DELAY_MS,
  };
}

/**
 * Whether the processor must auto-discover the hot-tier symbol set: true when
 * the caller did not supply a non-empty `symbols` array.
 */
export function needsSymbolDiscovery(symbols: string[] | undefined): boolean {
  return !symbols || symbols.length === 0;
}

/** The hot-tier cutoff: instruments analyzed on/after this date are "hot". */
export function computeHotTierCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - HOT_TIER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * WHERE clause for the hot-tier discovery query: active NSE equities with
 * analysisCount > 0 AND lastAnalyzedAt within the hot-tier window.
 */
export function buildFilingsDiscoveryWhere(
  symbols: readonly string[] = [],
  cutoff: Date = computeHotTierCutoff(),
): {
  isActive: true;
  instrumentType: "EQUITY";
  exchange: "NSE";
  OR: Array<
    | { symbol: { in: string[] } }
    | { analysisCount: { gt: 0 }; lastAnalyzedAt: { gte: Date } }
  >;
} {
  // MONEY-1215 — see `buildNewsDiscoveryWhere`. This one was strictly worse:
  // it required `analysisCount > 0` AND `lastAnalyzedAt >= cutoff`, and prod
  // has **0** rows satisfying even the first. `filings-sync-weekly-prod` is
  // ENABLED (Sun 19:00) and its only publisher sends `{}`, so every run
  // discovered nothing and reported success.
  const or: Array<
    | { symbol: { in: string[] } }
    | { analysisCount: { gt: 0 }; lastAnalyzedAt: { gte: Date } }
  > = [{ analysisCount: { gt: 0 }, lastAnalyzedAt: { gte: cutoff } }];
  if (symbols.length > 0) or.unshift({ symbol: { in: [...symbols] } });
  return {
    isActive: true,
    instrumentType: "EQUITY",
    exchange: "NSE",
    OR: or,
  };
}
