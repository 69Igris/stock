/**
 * Seed Sectors
 *
 * Enriches instruments with sector/industry data from Yahoo Finance.
 * Loops in batches until all EQUITY instruments have sectors.
 *
 * Instruments that Yahoo can't resolve (404, no data, unfetchable symbols)
 * are marked sector="N/A" so they're never re-queried.
 *
 * Usage:
 *   npx tsx scripts/seed/seed-sectors.ts           # Only enrich instruments missing sectors
 *   npx tsx scripts/seed/seed-sectors.ts --force   # Re-enrich ALL instruments (skip N/A)
 */

import "dotenv/config";
import {
  enrichSectors,
  yahooFetchQuoteSummary,
  type SectorData,
} from "@usemoney/core/market-data";

const BATCH_SIZE = 500;
const DELAY_MS = 500;
const FORCE = process.argv.includes("--force");

/**
 * Yahoo Finance sector fetcher.
 * Same implementation as workers/src/processors/sector-enrichment.ts
 */
async function yahooSectorFetcher(
  yahooSymbol: string,
): Promise<SectorData | null> {
  try {
    const result = await yahooFetchQuoteSummary(yahooSymbol, ["assetProfile"]);

    if (!result) return null;

    const profile = result.assetProfile as
      | { sector?: string; industry?: string }
      | undefined;

    if (profile) {
      return {
        sector: profile.sector ?? null,
        industry: profile.industry ?? null,
      };
    }

    return null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg.includes("not found") || msg.includes("No fundamentals")) {
      return null;
    }
    throw error;
  }
}

async function main() {
  console.log("Starting sector enrichment (loops until all done)...");
  console.log(
    `Exchanges: NSE, BSE | Batch size: ${BATCH_SIZE} | Delay: ${DELAY_MS}ms`,
  );
  if (FORCE) {
    console.log("Mode: FORCE RE-ENRICH (re-enriching all, skipping N/A)");
  }

  let totalEnriched = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalProcessed = 0;
  let round = 0;

  // Loop until no more instruments need enrichment
  while (true) {
    round++;
    console.log(`\n--- Round ${round} ---`);

    const result = await enrichSectors(yahooSectorFetcher, {
      batchSize: BATCH_SIZE,
      delayMs: DELAY_MS,
      exchanges: ["NSE", "BSE"],
      forceReEnrich: FORCE,
    });

    totalProcessed += result.totalProcessed;
    totalEnriched += result.enriched;
    totalFailed += result.failed;
    totalSkipped += result.skipped;

    console.log(
      `  Round ${round}: ${result.totalProcessed} processed, ${result.enriched} enriched, ${result.failed} failed, ${result.skipped} skipped`,
    );

    if (result.errors.length > 0) {
      console.log(`  Errors (first 5):`);
      result.errors.slice(0, 5).forEach((e) => console.log(`    - ${e}`));
    }

    // Stop when no more instruments found to enrich
    if (result.totalProcessed === 0) {
      console.log("\nNo more instruments need enrichment.");
      break;
    }

    // Safety: stop after too many rounds with only transient failures
    if (result.enriched === 0 && result.skipped === 0 && result.failed > 0) {
      console.log(
        "\nEntire batch was transient failures - stopping to avoid infinite loop.",
      );
      break;
    }
  }

  console.log(`\n========== Sector enrichment complete ==========`);
  console.log(`  Rounds:     ${round}`);
  console.log(`  Processed:  ${totalProcessed}`);
  console.log(`  Enriched:   ${totalEnriched}`);
  console.log(`  Failed:     ${totalFailed}`);
  console.log(`  Skipped:    ${totalSkipped}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Sector enrichment failed:", err);
    process.exit(1);
  });
