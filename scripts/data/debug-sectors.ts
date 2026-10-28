/**
 * Debug Sectors - diagnose why enrichment finds 0 instruments
 *
 * Usage: DATABASE_URL=... npx tsx scripts/data/debug-sectors.ts
 */

import "dotenv/config";
import { PrismaClient } from "@usemoney/database";

const prisma = new PrismaClient();

async function main() {
  // Count all active equities
  const totalEquities = await prisma.instrumentMapping.count({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
    },
  });
  console.log(`Total active EQUITY instruments (NSE/BSE): ${totalEquities}`);

  // Count with sector = null (Prisma style)
  const nullSector = await prisma.instrumentMapping.count({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
      // MONEY-1236 — DELIBERATE. This script's whole job is to CONTRAST the two
      // semantics: this count is printed as "(Prisma)" and read against the
      // empty-string count and the raw-Mongo `$type`/`$ifNull` breakdown at the
      // bottom of this file, which is the thing that separates a MISSING key
      // from an explicit null. Rewriting it to `isSet` deletes the measurement.
      // prisma-null-ok: the bare null IS the datum being measured
      sector: null,
    },
  });
  console.log(`With sector = null (Prisma): ${nullSector}`);

  // Count with sector = "" (empty string)
  const emptySector = await prisma.instrumentMapping.count({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
      sector: "",
    },
  });
  console.log(`With sector = "" (empty): ${emptySector}`);

  // Count with sector set (not null)
  const hasSector = await prisma.instrumentMapping.count({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
      sector: { not: null },
    },
  });
  console.log(`With sector != null: ${hasSector}`);

  // Count with OR (how enrichment queries)
  const enrichmentQuery = await prisma.instrumentMapping.count({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
      // MONEY-1236 — DELIBERATE, same reason: this reproduces the ENRICHMENT
      // query VERBATIM so its count can be read against the raw-Mongo breakdown
      // below. "Fixing" it here would hide the very gap the script exists to
      // expose — the fix belongs in the enrichment scripts themselves
      // (scripts/data/enrich-sectors-gemini.ts, fix-missing-sectors.ts).
      // prisma-null-ok: reproducing the enrichment filter verbatim, on purpose
      OR: [{ sector: null }, { sector: "" }],
    },
  });
  console.log(`Enrichment query (OR null/empty): ${enrichmentQuery}`);

  // Sample 5 instruments to check raw field presence
  const samples = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: "NSE",
    },
    select: { id: true, symbol: true, sector: true, industry: true },
    take: 5,
  });
  console.log("\nSample instruments:");
  for (const s of samples) {
    console.log(
      `  ${s.symbol}: sector=${JSON.stringify(s.sector)}, industry=${JSON.stringify(s.industry)}`,
    );
  }

  // Use raw MongoDB to check if the field exists
  const db = (prisma as any).$runCommandRaw;
  if (db) {
    try {
      const result = await (prisma as any).$runCommandRaw({
        aggregate: "InstrumentMapping",
        pipeline: [
          {
            $match: {
              isActive: true,
              instrumentType: "EQUITY",
              exchange: { $in: ["NSE", "BSE"] },
            },
          },
          {
            $group: {
              _id: {
                hasField: {
                  $cond: [
                    { $ifNull: ["$sector", false] },
                    "has_value",
                    "null_or_missing",
                  ],
                },
                fieldType: { $type: "$sector" },
              },
              count: { $sum: 1 },
            },
          },
        ],
        cursor: {},
      });
      console.log("\nRaw MongoDB sector field analysis:");
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.log("\nCouldn't run raw aggregate:", (e as Error).message);
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Debug failed:", err);
    prisma.$disconnect();
    process.exit(1);
  });
