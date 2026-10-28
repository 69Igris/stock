/**
 * Migration: Backfill sessionId + async fields on existing PortfolioRoast records.
 *
 * Required because the schema now has `sessionId @unique`. Existing records
 * have no sessionId (null), so this assigns a UUID to each and sets default
 * async tracking fields (status=COMPLETED, progress=100).
 *
 * Usage:
 *   DATABASE_URL=<url> npx tsx packages/database/scripts/backfill-roast-sessionid.ts
 *   # or via the migrate-roast-async.sh wrapper
 *
 * Safe to run multiple times - skips records that already have a sessionId.
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";

const prisma = new PrismaClient();

async function backfill() {
  // Use raw query to find records without sessionId
  const rawResult = (await prisma.$runCommandRaw({
    find: "portfolio_roasts",
    filter: {
      $or: [{ sessionId: { $exists: false } }, { sessionId: null }],
    },
    projection: { _id: 1 },
  })) as { cursor?: { firstBatch?: Array<{ _id: { $oid: string } }> } };

  const docs = rawResult.cursor?.firstBatch ?? [];
  console.log(`Found ${docs.length} roast(s) needing backfill`);

  if (docs.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  let success = 0;
  let failed = 0;

  for (const doc of docs) {
    const id = doc._id.$oid ?? (doc._id as unknown as string);
    const sid = randomUUID();
    try {
      await prisma.$runCommandRaw({
        update: "portfolio_roasts",
        updates: [
          {
            q: { _id: { $oid: id } },
            u: {
              $set: {
                sessionId: sid,
                status: "COMPLETED",
                progress: 100,
                currentStep: "Done!",
                updatedAt: { $date: new Date().toISOString() },
              },
            },
          },
        ],
      });
      console.log(`  ✓ ${id} → sessionId=${sid}`);
      success++;
    } catch (err) {
      console.error(`  ✗ ${id} failed:`, err);
      failed++;
    }
  }

  console.log(`\nBackfill complete: ${success} succeeded, ${failed} failed`);
  await prisma.$disconnect();

  if (failed > 0) process.exit(1);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
