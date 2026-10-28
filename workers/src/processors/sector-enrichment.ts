/**
 * Sector Enrichment Processor
 *
 * Handles the sector-enrichment Pub/Sub job.
 * Fetches sector/industry data from Yahoo Finance's quoteSummary
 * and updates InstrumentMapping records.
 */

import type { SectorEnrichmentMessage } from "@usemoney/types";
import {
  enrichSectors,
  yahooFetchQuoteSummary,
  type SectorData,
} from "@usemoney/core/market-data";
import { toSectorFetchError } from "@usemoney/core/market-data/instruments/sector-enrichment-logic";
import {
  resolveSectorEnrichmentOptions,
  parseSectorFromProfile,
  isMissingFundamentalsError,
  capSectorErrorsForLog,
  type AssetProfileLike,
} from "./sector-enrichment-logic";

/**
 * Yahoo Finance sector fetcher.
 * Uses the quoteSummary assetProfile module to get sector/industry.
 *
 * The assetProfile→SectorData mapping and the "no-fundamentals" error
 * classification are the pure `parseSectorFromProfile` / `isMissingFundamentalsError`
 * exports (so production and the unit tests run the SAME code, no shadow).
 *
 * MONEY-1238 (#7) — WHY THE `onError` DANCE.
 *
 * `yahooFetchQuoteSummary` catches every error and returns `null`. This
 * fetcher's own `catch` was therefore DEAD for network faults, and every
 * outage arrived here as `null` — indistinguishable from an ETF with no
 * assetProfile. `enrichSectors` then wrote `SECTOR_SKIPPED` ("N/A"), which its
 * own selector permanently excludes from re-enrichment, and reported
 * `failed=0`: a 500-row Yahoo outage logged `enriched=0, failed=0, skipped=500`,
 * byte-identical to 500 genuine ETFs.
 *
 * `YahooFetchErrorOpts.onError` (MONEY-1060) exists for exactly this — it is
 * invoked with the raw error immediately before each swallow, for "callers that
 * need to tell the two apart". Capturing it and RE-THROWING routes the failure
 * into `enrichSectors`' per-instrument catch → `decideErrorOutcome`, which
 * counts it FAILED and writes nothing. A throw here does not abort the batch;
 * the catch is inside the per-instrument loop.
 *
 * `toSectorFetchError` decides which errors stay raw: a 404 is a permanent
 * statement about the SYMBOL and keeps its shape so it is still SKIPPED;
 * everything else is TAGGED and can no longer be skipped by message text.
 */
export type QuoteSummaryFetch = (
  symbol: string,
  modules: string[],
  opts?: { onError?: (error: unknown, context?: string) => void },
) => Promise<Record<string, unknown> | null>;

/**
 * Build the fetcher. The quoteSummary call is a PARAMETER with a production
 * default so the outage/absence split can be exercised against a fixture —
 * production and the tests then run this exact body, not a copy of it (the
 * shadow that `sector-enrichment-logic.ts` was extracted to kill).
 */
export function makeYahooSectorFetcher(
  fetchSummary: QuoteSummaryFetch = yahooFetchQuoteSummary,
) {
  return async function yahooSectorFetcher(
    yahooSymbol: string,
  ): Promise<SectorData | null> {
    let swallowed: unknown;
    let didThrow = false;

    const result = await fetchSummary(yahooSymbol, ["assetProfile"], {
      onError: (error) => {
        didThrow = true;
        swallowed = error;
      },
    });

    if (didThrow) {
      // Some instruments (e.g., ETFs, indices) don't have assetProfile
      if (isMissingFundamentalsError(swallowed)) return null;
      throw toSectorFetchError(yahooSymbol, swallowed);
    }

    // From here the fetch COMPLETED, so a null is Yahoo's own answer: either a
    // 200 with no `quoteSummary.result[0]`, or a symbol on the never-fetchable
    // list. Both are deterministic and may be written down.
    if (!result) return null;

    const profile = result.assetProfile as AssetProfileLike | undefined;
    return parseSectorFromProfile(profile);
  };
}

const yahooSectorFetcher = makeYahooSectorFetcher();

export async function processSectorEnrichment(
  data: SectorEnrichmentMessage,
): Promise<void> {
  const { batchSize, exchanges, forceReEnrich, delayMs } =
    resolveSectorEnrichmentOptions(data);

  console.log(
    `Processing sector enrichment (batch: ${batchSize}, exchanges: ${exchanges.join(", ")}, force: ${forceReEnrich})`,
  );

  const result = await enrichSectors(yahooSectorFetcher, {
    batchSize,
    delayMs,
    exchanges,
    forceReEnrich,
  });

  console.log(
    `Sector enrichment completed: processed=${result.totalProcessed}, enriched=${result.enriched}, failed=${result.failed}, skipped=${result.skipped}`,
  );

  if (result.errors.length > 0) {
    const logged = capSectorErrorsForLog(result.errors);
    console.warn(`Sector enrichment errors (first ${logged.length}):`);
    logged.forEach((e) => console.warn(`  - ${e}`));
  }

  // `failed` is now REACHABLE (it was not, for any network fault), so say what
  // it means. A failed row was NOT written and will be picked up again next
  // run; a skipped row was written N/A and never will be. Conflating them is
  // what made a five-hundred-row outage look like a quiet night.
  if (result.failed > 0) {
    console.warn(
      `Sector enrichment: ${result.failed} instrument(s) could not be fetched ` +
        `(upstream unavailable) — NOTHING was written for them and they remain ` +
        `eligible for the next run. This is distinct from the ${result.skipped} ` +
        `skipped row(s), which were written the permanent "N/A" sentinel.`,
    );
  }
}
