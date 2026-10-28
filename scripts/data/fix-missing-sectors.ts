/**
 * Fix Missing Sectors
 *
 * Uses Prisma findMany + update (which work) to explicitly set sector=null
 * on all EQUITY instruments that don't have a canonical sector.
 *
 * Bypasses the Prisma/MongoDB quirk where querying { sector: null } doesn't
 * match documents where the field was never created.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/data/fix-missing-sectors.ts
 */

import "dotenv/config";
import { PrismaClient } from "@usemoney/database";
import { getAllSectorNames } from "@usemoney/core/market-data";

const prisma = new PrismaClient();
const BATCH_SIZE = 1000;

async function main() {
  console.log(
    "Fixing instruments with missing/non-canonical sector field...\n",
  );

  const canonicalSectors = new Set(getAllSectorNames());
  console.log(
    `Canonical sectors (${canonicalSectors.size}): ${[...canonicalSectors].join(", ")}\n`,
  );

  // Step 1: Fetch ALL EQUITY instruments (just id + sector)
  console.log("Fetching all EQUITY instruments...");
  const instruments = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
    },
    select: { id: true, symbol: true, sector: true },
  });
  console.log(`Total instruments: ${instruments.length}`);

  // Step 2: Separate into canonical vs needs-fix
  const alreadyCanonical = instruments.filter(
    (i) => i.sector && canonicalSectors.has(i.sector),
  );
  const needsFix = instruments.filter(
    (i) => !i.sector || !canonicalSectors.has(i.sector),
  );

  console.log(`Already have canonical sector: ${alreadyCanonical.length}`);
  console.log(`Need fix (null/missing/non-canonical): ${needsFix.length}`);

  // Show sector distribution of needs-fix
  const sectorDist = new Map<string, number>();
  for (const i of needsFix) {
    const key =
      i.sector === null
        ? "<null>"
        : i.sector === undefined
          ? "<undefined>"
          : `"${i.sector}"`;
    sectorDist.set(key, (sectorDist.get(key) || 0) + 1);
  }
  console.log("\nSector values in needs-fix group:");
  for (const [val, count] of [...sectorDist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)) {
    console.log(`  ${val}: ${count}`);
  }

  if (needsFix.length === 0) {
    console.log(
      "\nAll instruments already have canonical sectors. Nothing to fix.",
    );
    return;
  }

  // Step 3: Batch update by ID (this always works since we're matching on _id)
  console.log(
    `\nUpdating ${needsFix.length} instruments in batches of ${BATCH_SIZE}...`,
  );
  let updated = 0;

  for (let i = 0; i < needsFix.length; i += BATCH_SIZE) {
    const batch = needsFix.slice(i, i + BATCH_SIZE);
    const ids = batch.map((inst) => inst.id);

    const result = await prisma.instrumentMapping.updateMany({
      where: { id: { in: ids } },
      data: { sector: null, industry: null },
    });

    updated += result.count;
    if ((i + BATCH_SIZE) % 5000 < BATCH_SIZE) {
      console.log(
        `  Progress: ${Math.min(i + BATCH_SIZE, needsFix.length)}/${needsFix.length}`,
      );
    }
  }

  console.log(`\nUpdated ${updated} instruments (set sector=null explicitly)`);

  // Step 4: Verify
  const verifyNull = await prisma.instrumentMapping.count({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
      // prisma-null-ok: INTENTIONAL. This runs AFTER step 3 has materialised
      // every missing sector as an explicit null, so a bare null is exactly the
      // right question here — it counts what this script just wrote. The rows a
      // bare null CANNOT see are counted separately below with raw
      // `$exists: false`, and a non-zero figure there fails the run.
      sector: null,
    },
  });
  const verifyNotNull = await prisma.instrumentMapping.count({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
      sector: { not: null },
    },
  });

  // COUNT THE ABSENT ROWS DIRECTLY — MONEY-1236.
  //
  // The two Prisma counts above cannot see a row whose `sector` key is MISSING:
  // neither `{sector: null}` nor `{sector: {not: null}}` reaches an absent
  // field. So the only signal that any remained was the SUM failing to match,
  // which reports a discrepancy without naming its cause and is easy to read as
  // an off-by-a-few rather than "the defect this script exists to remove is
  // still present". Raw Mongo `$exists: false` names it outright.
  //
  // The SELECTION above is deliberately not a Prisma null filter at all — it
  // fetches every row and decides in JavaScript (`!i.sector`), which is what
  // makes this script the remediation for the quirk rather than another victim
  // of it. Do not "simplify" it into a `where: { sector: null }`.
  const raw = (await prisma.$runCommandRaw({
    count: "instrument_mappings",
    query: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { $in: ["NSE", "BSE"] },
      sector: { $exists: false },
    },
  })) as { n?: number };
  // COULD-NOT-READ IS ITS OWN VALUE — MONEY-1236.
  //
  // This was `raw?.n ?? -1`, and the gate below is `stillAbsent > 0`. So an
  // unreadable reply became -1, failed the `> 0` test, printed "-1" and exited
  // 0 — the exact could-not-determine-read-as-success shape the gate was added
  // to remove, reintroduced by the fallback that feeds it.
  const stillAbsent = typeof raw?.n === "number" ? raw.n : null;

  console.log(`\nVerification:`);
  console.log(`  Prisma sector=null:  ${verifyNull}`);
  console.log(`  Prisma sector!=null: ${verifyNotNull}`);
  console.log(
    `  raw sector ABSENT:   ${stillAbsent ?? "UNREADABLE"}  <- invisible to both counts above`,
  );
  const sum = verifyNull + verifyNotNull;
  console.log(`  Sum: ${sum} (should be ${instruments.length})`);
  // "(should be N)" is an ASSERTION, so assert it — MONEY-1238. Printed and
  // never compared, it let an updateMany that matched 1 of 12,000 rows print
  // a plausible-looking pair of numbers followed by "Success!".
  if (sum !== instruments.length) {
    console.error(
      `  SUM MISMATCH: Prisma accounts for ${sum} of ${instruments.length} ` +
        `rows. The ${instruments.length - sum} unaccounted row(s) are ` +
        `invisible to both counts — see the raw ABSENT figure above.`,
    );
    process.exitCode = 1;
  }

  if (stillAbsent === null) {
    console.error(
      `\n  Could NOT read the raw ABSENT count ($runCommandRaw returned no ` +
        `numeric 'n'). This verification is the only thing that can see rows ` +
        `Prisma cannot, so an unreadable answer is a FAILED verification — not ` +
        `a passing one. Re-run before treating any sector count as complete.`,
    );
    process.exitCode = 1;
  } else if (stillAbsent > 0) {
    console.error(
      `\n${stillAbsent} row(s) still have NO sector key. The whole point of ` +
        `this script is to materialise those as explicit null, so a non-zero ` +
        `figure here means the run did not finish its job — re-run before ` +
        `treating any sector count as complete.`,
    );
    process.exitCode = 1;
  }

  if (verifyNull > 0) {
    console.log(`\nSuccess! Now run: npx tsx scripts/seed/seed-sectors.ts`);
  } else {
    console.log(
      `\nWarning: Prisma still can't find null sectors. The DB may need schema sync: npx prisma db push`,
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fix failed:", err);
    prisma.$disconnect();
    process.exit(1);
  });
