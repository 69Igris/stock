/**
 * Sector Enrichment Service
 *
 * Enriches InstrumentMapping records with sector and industry data
 * from Yahoo Finance's quoteSummary assetProfile module.
 *
 * Strategy:
 * - Iterates active EQUITY instruments missing sector data
 * - Fetches assetProfile from Yahoo Finance for each
 * - Updates InstrumentMapping.sector + InstrumentMapping.industry
 * - Rate-limited to avoid Yahoo throttling (~2000/hour)
 */

import { prisma } from "@usemoney/database";
import {
  NSE_SECTORS,
  normalizeToNseSector,
  getSectorDisplayConfig,
  type SectorDisplayConfig,
} from "./sector-taxonomy";
import {
  SECTOR_SKIPPED,
  partitionFetchable,
  decideFetchOutcome,
  decideErrorOutcome,
  groupPendingUpdatesByData,
  selectSymbolKeysToEnrich,
  type PendingSectorUpdate,
  type SymbolKey,
  SectorFetchUnavailableError,
} from "./sector-enrichment-logic";
import { fetchQuoteSummaryOutcome } from "../yahoo-api";
import { sectorWritableWhere } from "./sector-write-guard";

// Re-export taxonomy utilities so existing consumers of SECTOR_CONFIG keep working
export { NSE_SECTORS, normalizeToNseSector, getSectorDisplayConfig };
// Re-export the sentinel from the logic module (single source of truth).
export { SECTOR_SKIPPED };

// ============== TYPES ==============

export interface SectorEnrichmentResult {
  totalProcessed: number;
  enriched: number;
  failed: number;
  skipped: number;
  errors: string[];
}

export interface SectorEnrichmentOptions {
  /** Maximum instruments to process in one run */
  batchSize?: number;
  /** Delay between Yahoo API calls in ms */
  delayMs?: number;
  /** Only process instruments matching these exchanges */
  exchanges?: string[];
  /** Force re-enrichment even if sector is already set */
  forceReEnrich?: boolean;
}

export interface SectorData {
  sector: string | null;
  industry: string | null;
}

/** Fetcher function signature - injected by the caller (worker or web app) */
export type YahooSectorFetcher = (
  yahooSymbol: string,
) => Promise<SectorData | null>;

// ============== SECTOR CONFIG (backward compat) ==============

/**
 * @deprecated Use `NSE_SECTORS` from `./sector-taxonomy` instead.
 * Kept as an alias so existing imports of `SECTOR_CONFIG` continue to work.
 */
export const SECTOR_CONFIG: Record<
  string,
  { label: string; color: string; icon: string }
> = NSE_SECTORS;

/**
 * @deprecated Use `getSectorDisplayConfig` from `./sector-taxonomy` instead.
 */
export function getSectorConfig(sectorName: string): SectorDisplayConfig {
  return getSectorDisplayConfig(sectorName);
}

// ============== ENRICHMENT SERVICE ==============

/**
 * Enriches instruments with sector/industry data from Yahoo Finance.
 *
 * Instruments that are unfetchable (bonds, FMPs, NCDs, suspended stocks)
 * or return 404 from Yahoo are marked with sector="SKIPPED" so they are
 * excluded from future enrichment runs.
 *
 * @param fetcher - Injected Yahoo Finance sector fetcher function
 * @param options - Configuration options
 * @returns Summary of the enrichment operation
 */
export async function enrichSectors(
  fetcher: YahooSectorFetcher,
  options: SectorEnrichmentOptions = {},
): Promise<SectorEnrichmentResult> {
  const {
    batchSize = 500,
    delayMs = 500,
    exchanges = ["NSE", "BSE"],
    forceReEnrich = false,
  } = options;

  const result: SectorEnrichmentResult = {
    totalProcessed: 0,
    enriched: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Find instruments that need enrichment
  // Normal mode: only null/empty sector (already excludes N/A)
  // Force mode: re-enrich all except N/A (permanently unfetchable)
  const instruments = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: exchanges },
      ...(forceReEnrich
        ? { sector: { not: SECTOR_SKIPPED } }
        : {
            OR: [
              { sector: { isSet: false } },
              { sector: null },
              { sector: "" },
            ],
          }),
    },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      yahooSymbol: true,
    },
    take: batchSize,
  });

  console.log(
    `[sector-enrichment] Found ${instruments.length} instruments to enrich`,
  );

  // First pass: split unfetchable (mark SKIPPED in one batch) from fetchable.
  const { skippedIds, fetchable: fetchableInstruments } =
    partitionFetchable(instruments);
  result.totalProcessed += skippedIds.length;
  result.skipped += skippedIds.length;

  // Batch update all unfetchable instruments at once
  if (skippedIds.length > 0) {
    await prisma.instrumentMapping.updateMany({
      where: { id: { in: skippedIds } },
      data: { sector: SECTOR_SKIPPED, industry: SECTOR_SKIPPED },
    });
  }

  // Second pass: fetch sector data from Yahoo (rate-limited) and batch DB writes
  const DB_WRITE_BATCH = 50;
  const pendingUpdates: PendingSectorUpdate[] = [];

  async function flushUpdates() {
    if (pendingUpdates.length === 0) return;
    // Group by sector+industry to use updateMany where possible
    await Promise.all(
      groupPendingUpdatesByData(pendingUpdates).map(
        ({ sector, industry, ids }) =>
          prisma.instrumentMapping.updateMany({
            // MONEY-1093: re-check the type at WRITE time. The SELECT that
            // produced these ids is already scoped to EQUITY — that scoping is
            // what makes the "a retyped row is excluded from re-enrichment"
            // claim true, and several other files depend on it — but the ids
            // are then held across a live Yahoo call PER INSTRUMENT before
            // being flushed in a batch, so the read-to-write window is minutes,
            // not milliseconds. The nightly bhavcopy writer (21:00 IST) retypes
            // rows to DEBT and clears their sector inside exactly that window,
            // and because its clear only ever revisits rows still typed EQUITY,
            // anything written back afterwards is permanent.
            where: { id: { in: ids }, ...sectorWritableWhere() },
            data: { sector, industry },
          }),
      ),
    );
    pendingUpdates.length = 0;
  }

  for (const instrument of fetchableInstruments) {
    result.totalProcessed++;

    let outcome;
    try {
      const sectorData = await fetcher(instrument.yahooSymbol);
      outcome = decideFetchOutcome(instrument, sectorData);
      if (outcome.kind === "enriched") {
        console.log(
          `[sector-enrichment] ${instrument.symbol}: ${sectorData?.sector} / ${sectorData?.industry}`,
        );
      }
    } catch (error) {
      outcome = decideErrorOutcome(instrument, error);
    }

    if (outcome.kind === "enriched") {
      if (outcome.update) pendingUpdates.push(outcome.update);
      result.enriched++;
    } else if (outcome.kind === "skipped") {
      if (outcome.update) pendingUpdates.push(outcome.update);
      result.skipped++;
    } else {
      result.failed++;
      if (outcome.error) {
        result.errors.push(outcome.error);
        if (result.errors.length <= 10) {
          console.warn(`[sector-enrichment] Failed: ${outcome.error}`);
        }
      }
    }

    // Flush DB writes in batches
    if (pendingUpdates.length >= DB_WRITE_BATCH) {
      await flushUpdates();
    }

    // Rate limiting - wait between API calls
    if (result.totalProcessed < instruments.length) {
      await sleep(delayMs);
    }
  }

  // Flush remaining updates
  await flushUpdates();

  return result;
}

// ============== ON-DEMAND (TARGETED) ENRICHMENT ==============

/**
 * Default Yahoo Finance sector fetcher.
 *
 * Pulls the `assetProfile` module and maps it to {@link SectorData}.
 *
 * This is the SAME assetProfile→SectorData shape the weekly worker fetcher
 * produces; it lets the web/service layer enrich on-demand without depending on
 * the worker.
 *
 * ## Why this uses the OUTCOME client, not `fetchQuoteSummary` — MONEY-1238
 *
 * It used to call the lossy `fetchQuoteSummary`, whose `null` means BOTH "Yahoo
 * refused/timed out" and "this symbol genuinely has no assetProfile". The
 * caller cannot tell them apart, so it wrote the SKIPPED sentinel for both —
 * and that write is effectively permanent, because the selector only picks rows
 * with no sector and `forceReEnrich` excludes the sentinel. One bad minute of
 * Yahoo marked those instruments "N/A" for good.
 *
 * That is the repo's standing rule violated exactly: NEVER CACHE A FAIL-OPEN
 * DEFAULT — "couldn't determine" has to be its own value, and the decision has
 * to key on determinacy rather than on the value.
 *
 * This path is the more urgent of the two, and was missed when the WORKER was
 * fixed: the weekly job touches at most 500 rows on a schedule, while this one
 * is fired on EVERY holdings read (fire-and-forget, up to 25 symbols a call),
 * so it poisons rows continuously and under exactly the load that makes Yahoo
 * rate-limit us in the first place.
 *
 * A THROW rather than a sentinel return, mirroring `makeYahooSectorFetcher` in
 * the worker: `YahooSectorFetcher` is contractually `SectorData | null`, and
 * both call sites already wrap the fetch in `try/catch` → `decideErrorOutcome`,
 * which checks the tagged error FIRST and returns `failed` with NO update. So
 * the outage now costs a retry next call instead of a permanent row.
 */
export const defaultYahooSectorFetcher: YahooSectorFetcher = async (
  yahooSymbol,
) => {
  const outcome = await fetchQuoteSummaryOutcome(yahooSymbol, ["assetProfile"]);

  // Transport/HTTP failure — indeterminate. Must NOT be written down.
  if (outcome.kind === "unavailable") {
    throw new SectorFetchUnavailableError(yahooSymbol, outcome.status);
  }

  // From here Yahoo ANSWERED, so a null is its own answer and is safe to
  // record: either a 200 carrying no result, or a symbol with no assetProfile
  // (ETFs and indices legitimately have none).
  if (outcome.kind === "empty") return null;

  const profile = outcome.data.assetProfile as
    | { sector?: string; industry?: string }
    | undefined;
  if (!profile) return null;
  return {
    sector: profile.sector ?? null,
    industry: profile.industry ?? null,
  };
};

/** Options for {@link enrichInstrumentsBySymbol}. */
export interface EnrichBySymbolOptions {
  /** Only consider instruments on these exchanges. Default ["NSE", "BSE"]. */
  exchanges?: string[];
  /** Hard cap on Yahoo fetches per call (keeps the page-triggered path cheap). Default 25. */
  maxFetch?: number;
  /** Delay between Yahoo calls in ms. Default 250. */
  delayMs?: number;
}

/**
 * Best-effort, targeted sector enrichment for a SPECIFIC set of held symbols.
 *
 * Why this exists: stock sector is shown on the holdings page via a read-time
 * join to `InstrumentMapping.sector`. A newly-bought or newly-listed stock
 * (e.g. a demerged entity) waits up to a week for the idempotent weekly Yahoo
 * cron, so its sector shows "N/A" in the meantime. This lets the holdings read
 * fire-and-forget a small, bounded enrichment for just those names so they fill
 * in within a refresh or two — without waiting on the cron.
 *
 * Safety / idempotency guarantees (this is invoked from a hot read path):
 *   - Only rows whose sector is genuinely unset (null / "" / unset) are fetched.
 *     Rows already enriched OR permanently marked `SECTOR_SKIPPED` ("N/A") are
 *     excluded by the WHERE, so we never re-hit the same dead symbol forever.
 *   - The fetch set is de-duplicated and capped at `maxFetch` (default 25).
 *   - Reuses the EXACT same decide/group pipeline as {@link enrichSectors} (no
 *     parallel classification logic), so writes are consistent.
 *   - This function never throws: any DB/Yahoo error is swallowed and reported
 *     in the result. Callers SHOULD NOT await it on a latency-sensitive path.
 *
 * @param symbolKeys (symbol, exchange) pairs to consider (usually held stocks).
 * @param fetcher    Yahoo sector fetcher. Defaults to {@link defaultYahooSectorFetcher}.
 * @param options    Exchange filter, fetch cap, and inter-call delay.
 */
export async function enrichInstrumentsBySymbol(
  symbolKeys: SymbolKey[],
  fetcher: YahooSectorFetcher = defaultYahooSectorFetcher,
  options: EnrichBySymbolOptions = {},
): Promise<SectorEnrichmentResult> {
  const { exchanges = ["NSE", "BSE"], maxFetch = 25, delayMs = 250 } = options;

  const result: SectorEnrichmentResult = {
    totalProcessed: 0,
    enriched: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const keys = selectSymbolKeysToEnrich(symbolKeys, maxFetch);
    if (keys.length === 0) return result;

    // Find ONLY the still-unenriched instrument rows for these exact symbols.
    // The sector predicate excludes both already-enriched rows AND the SKIPPED
    // sentinel ("N/A"), so a permanently-unresolvable symbol is never re-fetched.
    const instruments = await prisma.instrumentMapping.findMany({
      where: {
        isActive: true,
        instrumentType: "EQUITY",
        exchange: { in: exchanges },
        OR: keys.map((k) => ({ symbol: k.symbol, exchange: k.exchange })),
        AND: [
          {
            OR: [
              { sector: { isSet: false } },
              { sector: null },
              { sector: "" },
            ],
          },
        ],
      },
      select: { id: true, symbol: true, exchange: true, yahooSymbol: true },
      take: maxFetch,
    });

    if (instruments.length === 0) return result;

    // Mark unfetchable instruments (bonds/FMPs/NCDs/suspended) SKIPPED in a batch.
    const { skippedIds, fetchable } = partitionFetchable(instruments);
    result.totalProcessed += skippedIds.length;
    result.skipped += skippedIds.length;
    if (skippedIds.length > 0) {
      await prisma.instrumentMapping.updateMany({
        where: { id: { in: skippedIds } },
        data: { sector: SECTOR_SKIPPED, industry: SECTOR_SKIPPED },
      });
    }

    // Fetch the rest from Yahoo (rate-limited) and batch the writes.
    const pendingUpdates: PendingSectorUpdate[] = [];
    for (let i = 0; i < fetchable.length; i++) {
      const instrument = fetchable[i]!;
      result.totalProcessed++;

      let outcome;
      try {
        const sectorData = await fetcher(instrument.yahooSymbol);
        outcome = decideFetchOutcome(instrument, sectorData);
      } catch (error) {
        outcome = decideErrorOutcome(instrument, error);
      }

      if (outcome.kind === "enriched") {
        if (outcome.update) pendingUpdates.push(outcome.update);
        result.enriched++;
      } else if (outcome.kind === "skipped") {
        if (outcome.update) pendingUpdates.push(outcome.update);
        result.skipped++;
      } else {
        result.failed++;
        if (outcome.error) result.errors.push(outcome.error);
      }

      if (i < fetchable.length - 1) await sleep(delayMs);
    }

    if (pendingUpdates.length > 0) {
      await Promise.all(
        groupPendingUpdatesByData(pendingUpdates).map(
          ({ sector, industry, ids }) =>
            prisma.instrumentMapping.updateMany({
              // MONEY-1093: same write-time type re-check as `flushUpdates` in
              // the function above. These two batch flushes are near-identical
              // twins in two enrichment passes; the guard was added to one and
              // missed here, which is why the invariant is now pinned by a
              // scan that DISCOVERS writers instead of listing them
              // (packages/core/__tests__/market-data/sector-write-guard.test.ts).
              where: { id: { in: ids }, ...sectorWritableWhere() },
              data: { sector, industry },
            }),
        ),
      );
    }
  } catch (error) {
    // Best-effort: never let an on-demand enrichment failure surface to the
    // caller (this runs fire-and-forget off a holdings read).
    result.errors.push(
      error instanceof Error ? error.message : "Unknown enrichment error",
    );
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
