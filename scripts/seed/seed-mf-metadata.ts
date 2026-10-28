/**
 * Seed MF Metadata (Full Enrichment)
 *
 * Enriches ALL MutualFundMaster records missing metadata, through whichever
 * provider `MF_METADATA_PROVIDER` selects — AMFI's own monthly files today,
 * and nothing at all when the flag is unset (MONEY-1409 deleted the only
 * other provider). It calls the same `enrichMfMetadata` seam the weekly
 * worker does, so it can never reach a source the worker cannot.
 * Unlike seed-mf.ts which only does 500, this loops through all ~45000 schemes.
 *
 * Fields enriched: AUM, expense ratio, returns (1Y/3Y/5Y/inception),
 * CRISIL rating, fund manager, volatility, fund type, risk level.
 *
 * Usage: npx tsx scripts/seed/seed-mf-metadata.ts
 *
 * Rate limiting: 10 requests/second (100ms delay per call)
 * Expected time: ~60-90 min for full enrichment
 */

import "dotenv/config";
import { enrichMfMetadata } from "@usemoney/core/market-data";
import { prisma } from "@usemoney/database";

const BATCH_SIZE = 500;
// Between per-fund DB writes, not between upstream calls: the AMFI provider
// fetches its three whole-universe files ONCE and memoises them.
const DELAY_BETWEEN_CALLS_MS = 100;
const DELAY_BETWEEN_BATCHES_MS = 2000; // 2s pause between batches

async function main() {
  console.log("Starting full MF metadata enrichment...");
  console.log(`Batch size: ${BATCH_SIZE} | Rate: ~10 req/sec`);
  console.log("");

  // Diagnostic: check if Prisma can reach the collection at all
  const rawTotal = await prisma.mutualFundMaster.count();
  console.log(`[debug] Raw count (no filter): ${rawTotal}`);

  if (rawTotal === 0) {
    console.log(
      "[debug] Collection appears empty. Check DATABASE_URL points to the right database.",
    );
    console.log(
      `[debug] DATABASE_URL host: ${process.env.DATABASE_URL?.replace(/\/\/[^@]*@/, "//***@").split("?")[0]}`,
    );
    return;
  }

  const activeCount = await prisma.mutualFundMaster.count({
    where: { isActive: true },
  });
  console.log(`[debug] Active count: ${activeCount}`);

  // Count total funds needing enrichment
  // NOTE: Prisma + MongoDB quirk - `metadataSyncedAt: null` does NOT match
  // documents where the field is entirely absent (only explicit null).
  // Use double-negative `NOT: { field: { not: null } }` to match both absent and null.
  const totalAlready = await prisma.mutualFundMaster.count({
    where: {
      isActive: true,
      metadataSyncedAt: { not: null },
    },
  });

  const totalNeeding = activeCount - totalAlready;

  // Check how many actually have ISINs (the provider's join key)
  const withIsin = await prisma.mutualFundMaster.count({
    where: {
      isActive: true,
      metadataSyncedAt: { isSet: false },
      OR: [
        { isinGrowth: { not: { equals: "" } } },
        { isinDividend: { not: { equals: "" } } },
      ],
    },
  });

  console.log(`Total active funds: ${totalNeeding + totalAlready}`);
  console.log(`Already enriched:   ${totalAlready}`);
  console.log(`Needing enrichment: ${totalNeeding}`);
  console.log(`  ├─ With ISIN (enrichable): ${withIsin}`);
  console.log(`  └─ Without ISIN (will skip): ${totalNeeding - withIsin}`);
  console.log("");

  if (totalNeeding === 0) {
    console.log("All funds already enriched. Nothing to do.");
    return;
  }

  let totalEnriched = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let batchNumber = 0;

  // Process in batches
  while (true) {
    batchNumber++;

    // Fetch next batch of funds needing enrichment
    // Prisma MongoDB: `isSet: false` matches documents where field doesn't exist
    const funds = await prisma.mutualFundMaster.findMany({
      where: {
        isActive: true,
        metadataSyncedAt: { isSet: false },
      },
      select: { schemeCode: true, schemeName: true },
      take: BATCH_SIZE,
    });

    if (funds.length === 0) {
      console.log("\nNo more funds to enrich.");
      break;
    }

    console.log(`Batch ${batchNumber}: Processing ${funds.length} funds...`);

    let batchEnriched = 0;
    let batchFailed = 0;
    let batchSkipped = 0;

    for (let i = 0; i < funds.length; i++) {
      const fund = funds[i];
      if (!fund) continue;

      try {
        const result = await enrichMfMetadata(fund.schemeCode);

        if (result.enriched) {
          batchEnriched++;
        } else {
          batchSkipped++;
          // Mark as "attempted" so we don't retry endlessly
          // Update with metadataSyncedAt even if no data found
          await prisma.mutualFundMaster.update({
            where: { schemeCode: fund.schemeCode },
            data: {
              metadataSource: "none",
              metadataSyncedAt: new Date(),
            },
          });
        }
      } catch {
        batchFailed++;
        // Mark as attempted to prevent infinite loop
        await prisma.mutualFundMaster
          .update({
            where: { schemeCode: fund.schemeCode },
            data: {
              metadataSource: "error",
              metadataSyncedAt: new Date(),
            },
          })
          .catch(() => {});
      }

      // Progress within batch
      if ((i + 1) % 100 === 0) {
        console.log(
          `   ${i + 1}/${funds.length} (enriched: ${batchEnriched}, skipped: ${batchSkipped}, failed: ${batchFailed})`,
        );
      }

      // Rate limit
      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_BETWEEN_CALLS_MS),
      );
    }

    totalEnriched += batchEnriched;
    totalFailed += batchFailed;
    totalSkipped += batchSkipped;

    const remaining = totalNeeding - totalEnriched - totalFailed - totalSkipped;
    console.log(
      `Batch ${batchNumber} done: enriched=${batchEnriched}, skipped=${batchSkipped}, failed=${batchFailed} | Total remaining: ~${Math.max(0, remaining)}`,
    );

    // Pause between batches
    if (funds.length === BATCH_SIZE) {
      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS),
      );
    }
  }

  console.log("");
  console.log("═══════════════════════════════════════");
  console.log("MF Metadata Enrichment Complete");
  console.log("═══════════════════════════════════════");
  console.log(`  Total enriched: ${totalEnriched}`);
  console.log(`  Total skipped:  ${totalSkipped} (no ISIN, or the provider had no row)`);
  console.log(`  Total failed:   ${totalFailed}`);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("MF metadata enrichment failed:", err);
    process.exit(1);
  });
