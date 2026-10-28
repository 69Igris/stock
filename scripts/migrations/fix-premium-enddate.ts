/**
 * Fix Premium EndDate
 *
 * Finds all subscriptions with planId="PREMIUM", status="ACTIVE", endDate IS NOT
 * NULL, and no cancelledAt (no prior downgrade). Sets endDate=null for these
 * users.
 *
 * This fixes a bug where endDate was incorrectly set during purchase instead of
 * only being set during downgrade.
 *
 * ## MONEY-1236 — this script certified its own blind spot
 *
 * The selection filtered `cancelledAt: null`. On Prisma's MongoDB connector
 * that is an equality against an explicit JSON null, so it matches ONLY
 * documents that actually CARRY the key. A subscription that was never
 * cancelled has no `cancelledAt` key at all — `prisma db push` creates INDEXES,
 * never FIELDS, and nothing writes the field until a downgrade happens — so the
 * never-cancelled subscriptions, which are the ENTIRE target population, were
 * invisible to their own migration.
 *
 * MEASURED ON PROD 2026-08-21: `Subscription` total=652, `cancelledAt` absent=650
 * (99.7%), explicitly null=1, set=1. The filter could see 1 row out of 651.
 *
 * What makes it worse than an ordinary miss: the VERIFICATION loop re-ran the
 * SAME filter. So the script printed "Nothing to fix." and then "Verification: 0
 * ... (should be 0)" and exited 0 — a DOUBLE false success. A verify that shares
 * the selection's predicate cannot do anything except confirm the selection's
 * own blind spot, no matter how many times it runs.
 *
 * Two changes, and the second is the durable one:
 *   1. The selection now spells "unset" as an OR that reaches an absent key.
 *   2. The verification no longer uses Prisma at all. It counts through
 *      `$runCommandRaw`, where the semantics are INVERTED in our favour — raw
 *      Mongo's `{ field: null }` DOES match a missing key. So the raw predicate
 *      is the plain `cancelledAt: null` that was wrong on the Prisma side, and
 *      if the Prisma OR ever regressed the two would DISAGREE instead of
 *      agreeing on a comfortable zero.
 *
 * Fourth occurrence of the class (MONEY-1050 `{not:false}` vs absent,
 * MONEY-1205, MONEY-1234, MONEY-1235). `isSet: false` is the only Prisma
 * spelling that reaches an absent key (it lowers to `$exists: false`); a bare
 * `null`, `{ equals: null }` and `{ not: null }` all do not. A repo-wide guard
 * now fails on any new bare-`null` filter over an optional field
 * (apps/web/__tests__/meta/prisma-null-vs-isset.test.ts).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/migrations/fix-premium-enddate.ts
 *   DATABASE_URL=... npx tsx scripts/migrations/fix-premium-enddate.ts --dry-run
 */

import "dotenv/config";
import { prisma } from "@usemoney/database";
import { Prisma } from "@prisma/client";

const isDryRun = process.argv.includes("--dry-run");

/**
 * MONEY-1236 — "was never cancelled", spelled so it reaches an ABSENT field.
 *
 * Two arms on purpose: `isSet: false` for the 650 prod rows that never carried
 * the key, `null` for the 1 row that carries an explicit null. On Mongo those
 * are different documents and only this OR covers both.
 *
 * Kept as ONE constant rather than two copies of the literal so the SELECT and
 * the (now independent) verification cannot drift apart — a half-fixed
 * predicate is exactly how MONEY-1234's second broken pipe stayed hidden.
 *
 * NOT `as const`: Prisma's generated `SubscriptionWhereInput` types `OR` as a
 * MUTABLE array, so a readonly tuple is rejected (same footgun already written
 * down in scripts/jobs/xbrl-backfill.ts).
 */
const NEVER_CANCELLED_OR: Prisma.SubscriptionWhereInput[] = [
  { cancelledAt: null },
  { cancelledAt: { isSet: false } },
];

/**
 * Mongo collection name for `model Subscription`. The schema carries no
 * `@@map`, so Prisma uses the model name verbatim. `countStillBrokenRaw` proves
 * this is still true on every run rather than trusting it — see below.
 */
const SUBSCRIPTION_COLLECTION = "Subscription";

interface FacetCount {
  n?: number;
}
interface FacetDoc {
  total?: FacetCount[];
  hit?: FacetCount[];
}
interface AggregateReply {
  cursor?: { firstBatch?: FacetDoc[] };
}

/**
 * MONEY-1236 — the verification, by a route that shares NOTHING with the
 * selection.
 *
 * The `$facet` also re-counts the WHOLE collection and compares it against
 * Prisma's own total. That guard is load-bearing: `aggregate` against a
 * collection name that does not exist returns an empty result, NOT an error —
 * so a future `@@map("subscriptions")` would silently turn this verify into a
 * hard-coded zero, which is the very failure mode being fixed. On a mismatch it
 * throws instead of reporting success.
 *
 * `endDate: { $ne: null }` is the raw spelling of the Prisma `{ not: null }`
 * below. That one is deliberately NOT given an `isSet` arm: it means "HAS an
 * endDate to clear", and a subscription with no `endDate` key has nothing to
 * fix. Excluding absent is the intent there, which is exactly why the guard
 * flags a bare `null` and leaves `{ not: null }` alone.
 */
async function countStillBrokenRaw(prismaTotal: number): Promise<number> {
  const res = (await prisma.$runCommandRaw({
    aggregate: SUBSCRIPTION_COLLECTION,
    pipeline: [
      {
        $facet: {
          total: [{ $count: "n" }],
          hit: [
            {
              $match: {
                planId: "PREMIUM",
                status: "ACTIVE",
                endDate: { $ne: null },
                // Raw Mongo: `null` reaches missing keys too. Deliberate — this
                // is the predicate the Prisma OR above has to be equivalent to.
                cancelledAt: null,
              },
            },
            { $count: "n" },
          ],
        },
      },
    ],
    cursor: {},
  })) as unknown as AggregateReply;

  // A `$facet` stage always yields exactly ONE document, so this is not the
  // `firstBatch` truncation trap (MONEY-1189) — there is no second batch.
  const doc = res.cursor?.firstBatch?.[0];
  const rawTotal = doc?.total?.[0]?.n ?? 0;
  if (rawTotal !== prismaTotal) {
    throw new Error(
      `Raw verification is not looking at the same data: collection ` +
        `"${SUBSCRIPTION_COLLECTION}" holds ${rawTotal} doc(s) but Prisma counts ` +
        `${prismaTotal}. The collection was probably renamed via @@map. ` +
        `Refusing to report a verification result that would be a hard-coded zero.`,
    );
  }
  return doc?.hit?.[0]?.n ?? 0;
}

async function main() {
  console.log("Fix Premium EndDate");
  console.log(
    `Mode: ${isDryRun ? "DRY RUN (no changes will be made)" : "LIVE"}`,
  );
  console.log("=".repeat(60));

  const subscriptionTotal = await prisma.subscription.count();

  // Find affected subscriptions.
  // MONEY-1236: `OR` (null OR absent) for cancelledAt. `endDate: { not: null }`
  // stays a plain "has a value" filter — see countStillBrokenRaw's note.
  const affected = await prisma.subscription.findMany({
    where: {
      planId: "PREMIUM",
      status: "ACTIVE",
      endDate: { not: null },
      OR: NEVER_CANCELLED_OR,
    },
    select: {
      id: true,
      userId: true,
      planId: true,
      startDate: true,
      endDate: true,
    },
  });

  // The contrast that makes a regression legible in the run's own output: if
  // these two ever disagree, the Prisma predicate has stopped reaching absent
  // keys and the "Nothing to fix" below would be the MONEY-1236 lie again.
  const rawAffected = await countStillBrokenRaw(subscriptionTotal);
  console.log(
    `\nPrisma selected ${affected.length}; raw $exists-semantics count says ` +
      `${rawAffected}`,
  );
  // Asymmetric ON PURPOSE. Only `raw > prisma` is the MONEY-1236 shape: rows
  // exist that the Prisma predicate cannot see. The opposite direction would
  // mean Prisma selected MORE than raw, which this migration is immune to
  // anyway — the write below is id-scoped to exactly what was selected. Making
  // this a strict `!==` would risk aborting a correct run over some unrelated
  // Prisma/Mongo nuance in the harmless direction, and an ops script that
  // refuses to run is its own outage.
  if (rawAffected > affected.length) {
    console.error(
      `SELECTION IS BROKEN: raw sees ${rawAffected} row(s), Prisma selected ` +
        `${affected.length}. This is MONEY-1236 regressing — a bare \`null\` ` +
        `filter cannot see a subscription that never carried \`cancelledAt\`. ` +
        `Aborting rather than reporting a result that is wrong in the ` +
        `safe-looking direction.`,
    );
    process.exit(1);
  }

  console.log(
    `Found ${affected.length} PREMIUM/ACTIVE subscriptions with incorrect endDate\n`,
  );

  if (affected.length === 0) {
    console.log("Nothing to fix.");
    return;
  }

  // Log each affected subscription
  for (const sub of affected) {
    console.log(
      `  [${sub.id}] userId=${sub.userId} startDate=${sub.startDate.toISOString()} endDate=${sub.endDate?.toISOString()}`,
    );
  }

  if (isDryRun) {
    console.log(
      `\nDRY RUN: Would update ${affected.length} subscriptions (set endDate=null)`,
    );
    return;
  }

  // Apply the fix
  console.log(`\nUpdating ${affected.length} subscriptions...`);

  const result = await prisma.subscription.updateMany({
    where: {
      id: { in: affected.map((s) => s.id) },
    },
    data: {
      endDate: null,
    },
  });

  console.log(`Updated ${result.count} subscriptions (set endDate=null)`);

  // Verify — MONEY-1236: through the RAW route, not by re-running the filter we
  // just selected with. The old version re-issued the identical broken Prisma
  // predicate here, so "0 remaining" was guaranteed regardless of what the write
  // did or did not touch.
  const remaining = await countStillBrokenRaw(
    await prisma.subscription.count(),
  );

  console.log(
    `\nVerification (raw $exists semantics): ${remaining} PREMIUM/ACTIVE ` +
      `subscriptions still have endDate set (should be 0)`,
  );

  if (remaining > 0) {
    console.error(
      `\n${remaining} subscription(s) were not fixed. Exiting non-zero so this ` +
        `cannot read as a success.`,
    );
    process.exit(1);
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
