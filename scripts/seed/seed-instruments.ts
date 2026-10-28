/**
 * Seed Instruments
 *
 * Syncs the instrument master from Zerodha's instrument dump
 * into the InstrumentMapping collection.
 *
 * Usage: npx tsx scripts/seed/seed-instruments.ts
 */

import "dotenv/config";
import {
  syncInstruments,
  ZerodhaInstrumentProvider,
} from "@usemoney/core/market-data";

async function main() {
  console.log("Starting instrument sync...");
  console.log("Exchanges: NSE, BSE");

  const results = await syncInstruments([new ZerodhaInstrumentProvider()], {
    exchanges: ["NSE", "BSE"],
    forceFullSync: true,
  });

  for (const result of results) {
    console.log(`\nProvider: ${result.provider}`);
    console.log(`  Fetched:     ${result.totalFetched}`);
    console.log(`  Upserted:    ${result.upserted}`);
    console.log(`  Failed:      ${result.failed}`);
    console.log(`  Deactivated: ${result.deactivated}`);
    if (result.errors.length > 0) {
      console.log(`  Errors (first 5):`);
      result.errors.slice(0, 5).forEach((e) => console.log(`    - ${e}`));
    }
  }

  console.log("\nInstrument sync complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Instrument sync failed:", err);
    process.exit(1);
  });
