/**
 * Normalize Sectors (one-time fix)
 *
 * Converts raw Yahoo GICS sector names to canonical NSE sector names
 * directly in the DB. No Yahoo API calls needed - just re-maps existing values.
 *
 * This fixes instruments that were enriched before normalizeToNseSector() existed,
 * so they have values like "Technology" instead of "Information Technology".
 *
 * Skips instruments with sector="N/A" (permanently unfetchable).
 *
 * Usage: DATABASE_URL=... npx tsx scripts/data/normalize-sectors.ts
 */

import "dotenv/config";
import { PrismaClient } from "@usemoney/database";
import {
  normalizeToNseSector,
  getAllSectorNames,
} from "@usemoney/core/market-data";

const SECTOR_SKIPPED = "N/A";
const prisma = new PrismaClient();

async function main() {
  console.log("Normalizing sector names in InstrumentMapping...\n");

  const canonicalNames = new Set(getAllSectorNames());
  console.log(
    `Canonical NSE sectors (${canonicalNames.size}):`,
    [...canonicalNames].join(", "),
  );

  // Find instruments that have a sector set, excluding N/A (unfetchable)
  const instruments = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      sector: { not: null, notIn: [SECTOR_SKIPPED, ""] },
    },
    select: {
      id: true,
      symbol: true,
      sector: true,
    },
  });

  console.log(
    `\nFound ${instruments.length} instruments with sector data (excluding N/A)`,
  );

  // Count current sector distribution
  const currentSectors = new Map<string, number>();
  for (const inst of instruments) {
    if (inst.sector) {
      currentSectors.set(
        inst.sector,
        (currentSectors.get(inst.sector) || 0) + 1,
      );
    }
  }
  console.log("\nCurrent sector distribution:");
  for (const [sector, count] of [...currentSectors.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    const isCanonical = canonicalNames.has(sector);
    const normalized = normalizeToNseSector(sector);
    const tag = isCanonical ? "OK" : `→ ${normalized}`;
    console.log(`  ${sector}: ${count} [${tag}]`);
  }

  // Normalize non-canonical sectors
  let updated = 0;
  let alreadyCanonical = 0;
  let markedNA = 0;

  for (const inst of instruments) {
    if (!inst.sector) continue;

    if (canonicalNames.has(inst.sector)) {
      alreadyCanonical++;
      continue;
    }

    const normalized = normalizeToNseSector(inst.sector);

    // If normalization didn't change anything (no mapping exists), mark as N/A
    if (normalized === inst.sector) {
      await prisma.instrumentMapping.update({
        where: { id: inst.id },
        data: { sector: SECTOR_SKIPPED, industry: SECTOR_SKIPPED },
      });
      markedNA++;
      continue;
    }

    await prisma.instrumentMapping.update({
      where: { id: inst.id },
      data: { sector: normalized },
    });
    updated++;
  }

  console.log(`\n========== Normalization complete ==========`);
  console.log(`  Already canonical: ${alreadyCanonical}`);
  console.log(`  Updated:           ${updated}`);
  console.log(`  Marked N/A:        ${markedNA}`);
  console.log(`  Total:             ${instruments.length}`);
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Sector normalization failed:", err);
    prisma.$disconnect();
    process.exit(1);
  });
