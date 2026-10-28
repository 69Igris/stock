/**
 * Sector-enrichment processor — PURE orchestration logic (no network / Prisma).
 *
 * Side-effect-free helpers extracted out of `sector-enrichment.ts` so they can be
 * unit-tested by importing the REAL symbol (no shadow copies) without booting the
 * `enrichSectors` pipeline (Prisma) or hitting Yahoo's quoteSummary endpoint.
 * `sector-enrichment.ts` imports and CALLS every export here, so the production
 * code path and the tests execute the SAME code. Mirrors `import-logic.ts`.
 *
 * BUG/DIVERGENCE this de-shadow fixes: the old inline test
 * (`processor-sector-enrichment.test.ts`) re-declared `processSectorEnrichment`
 * with defaults `batchSize=100`, `exchanges=["NSE"]`, `delayMs=2000` and asserted
 * the COPY — but the REAL source defaults `batchSize=500`, `exchanges=["NSE","BSE"]`,
 * `delayMs=500`. The shadow was green against the WRONG values (the same class of
 * defaults-divergence the processors.test de-shadow flagged). The defaults now
 * live ONCE here, so the processor and its test cannot drift again.
 *
 * What lives here (all side-effect-free):
 *   - `resolveSectorEnrichmentOptions` — single source of the enrichSectors option
 *     defaults (the divergence point above).
 *   - `parseSectorFromProfile` — maps a Yahoo `assetProfile` object → `SectorData`
 *     (null when absent), the body of `yahooSectorFetcher` on the success path.
 *   - `isMissingFundamentalsError` — classifies a fetch error as the benign
 *     "this instrument has no assetProfile" case (ETFs / indices) that maps to
 *     `null` instead of propagating. A regression here either crashes the whole
 *     batch on an ETF or swallows a real Yahoo outage.
 *
 * @see workers/src/processors/sector-enrichment.ts (caller)
 * @see apps/web/__tests__/workers/processor-sector-enrichment.test.ts (tests the real exports)
 */

import type { SectorData } from "@usemoney/core/market-data";

/** Default max instruments processed per sector-enrichment run. */
export const DEFAULT_SECTOR_BATCH_SIZE = 500;

/** Default exchanges enriched when the job omits an explicit list. */
export const DEFAULT_SECTOR_EXCHANGES: readonly string[] = ["NSE", "BSE"];

/** Default inter-call delay (ms) between Yahoo quoteSummary fetches. */
export const DEFAULT_SECTOR_DELAY_MS = 500;

/** Max number of enrichment error strings logged after a run. */
export const SECTOR_ERROR_LOG_CAP = 10;

/** Resolved options handed to `enrichSectors`. */
export interface ResolvedSectorEnrichmentOptions {
  batchSize: number;
  exchanges: string[];
  forceReEnrich: boolean;
  delayMs: number;
}

/**
 * Resolve the enrichment options from the job message. `batchSize` defaults to
 * `500`, `exchanges` to `["NSE","BSE"]`, `delayMs` to `500`, `forceReEnrich` to
 * `false`. A provided-but-empty `exchanges` array is preserved verbatim; only an
 * `undefined`/missing value triggers the default.
 */
export function resolveSectorEnrichmentOptions(data: {
  batchSize?: number;
  exchanges?: string[];
  forceReEnrich?: boolean;
  delayMs?: number;
}): ResolvedSectorEnrichmentOptions {
  return {
    batchSize: data.batchSize ?? DEFAULT_SECTOR_BATCH_SIZE,
    exchanges: data.exchanges ?? [...DEFAULT_SECTOR_EXCHANGES],
    forceReEnrich: data.forceReEnrich ?? false,
    delayMs: data.delayMs ?? DEFAULT_SECTOR_DELAY_MS,
  };
}

/** The `assetProfile` subset the fetcher reads off Yahoo's quoteSummary. */
export interface AssetProfileLike {
  sector?: string;
  industry?: string;
}

/**
 * Map a Yahoo `assetProfile` (or its absence) into a `SectorData`.
 *
 * Returns `null` when there is no profile at all (the instrument is an ETF /
 * index / has no fundamentals). When a profile exists, missing `sector` /
 * `industry` collapse to `null` (never `undefined`) so the downstream update
 * writes an explicit "unknown" rather than a partial object.
 */
export function parseSectorFromProfile(
  profile: AssetProfileLike | null | undefined,
): SectorData | null {
  if (!profile) return null;
  return {
    sector: profile.sector ?? null,
    industry: profile.industry ?? null,
  };
}

/**
 * True for a quoteSummary error that just means "this symbol has no
 * assetProfile" — i.e. ETFs, indices, and other instruments Yahoo has no
 * fundamentals for. The fetcher maps these to `null` (skip) instead of letting
 * them abort the whole batch; any OTHER error (network, quota, 5xx) propagates.
 */
export function isMissingFundamentalsError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return msg.includes("not found") || msg.includes("No fundamentals");
}

/** Cap an enrichment error list to `SECTOR_ERROR_LOG_CAP` for logging. */
export function capSectorErrorsForLog(errors: string[]): string[] {
  return errors.slice(0, SECTOR_ERROR_LOG_CAP);
}
