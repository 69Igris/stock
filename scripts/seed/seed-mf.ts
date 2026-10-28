/**
 * Seed Mutual Funds
 *
 * Step 1: Bulk sync AMFI NAV feed into MutualFundMaster
 * Step 2: Enrich metadata for active funds missing metadata
 *
 * Usage: npx tsx scripts/seed/seed-mf.ts
 */

import "dotenv/config";
import {
  syncAmfiMutualFunds,
  enrichMfMetadata,
} from "@usemoney/core/market-data";
import { prisma } from "@usemoney/database";

const BATCH_SIZE = 500;
const DELAY_MS = 1000;

async function main() {
  // Step 1: Sync AMFI NAV feed
  console.log("Step 1: Syncing AMFI mutual fund NAV feed...");
  const syncResult = await syncAmfiMutualFunds();

  console.log(`  Parsed:   ${syncResult.totalParsed}`);
  console.log(`  Upserted: ${syncResult.upserted}`);
  console.log(`  Failed:   ${syncResult.failed}`);
  if (syncResult.errors.length > 0) {
    console.log(`  Errors (first 5):`);
    syncResult.errors.slice(0, 5).forEach((e) => console.log(`    - ${e}`));
  }

  // Step 2: Enrich metadata for active funds without it
  console.log("\nStep 2: Enriching MF metadata...");

  // Prisma MongoDB: `isSet: false` matches documents where field doesn't exist
  const fundsToEnrich = await prisma.mutualFundMaster.findMany({
    where: {
      isActive: true,
      metadataSyncedAt: { isSet: false },
    },
    select: { schemeCode: true },
    take: BATCH_SIZE,
  });

  console.log(`  Found ${fundsToEnrich.length} funds needing metadata enrichment`);

  let enriched = 0;
  let failed = 0;

  for (let i = 0; i < fundsToEnrich.length; i++) {
    const fund = fundsToEnrich[i];
    if (!fund) continue;

    try {
      const result = await enrichMfMetadata(fund.schemeCode);
      if (result.enriched) {
        enriched++;
      }
    } catch {
      failed++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  Progress: ${i + 1}/${fundsToEnrich.length} (enriched: ${enriched}, failed: ${failed})`);
    }

    // Rate limit
    if ((i + 1) % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log(`\nMF metadata enrichment complete: enriched=${enriched}, failed=${failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("MF seed failed:", err);
    process.exit(1);
  });
