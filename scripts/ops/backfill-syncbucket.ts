/**
 * MONEY-841 — backfill BrokerConnection.syncBucket.
 *
 * New connections get a stable `syncBucket = syncBucketFor(userId)` stamped at
 * connect time (apps/web/lib/actions/broker-connection.ts). This one-off script
 * backfills the field for connections created BEFORE that change so the daily
 * fan-out cron's per-bucket queries (`where.syncBucket = N`) actually pick them
 * up — without it, every pre-existing connection is missing `syncBucket`
 * entirely (ABSENT, not null — see MONEY-1236 below) and is silently invisible
 * to the sharded cron.
 *
 * ## MONEY-1236 — the filter missed the exact population the script exists for
 *
 * Both queries below used to read `{ syncBucket: null }`. On Prisma's MongoDB
 * connector that is an equality against an explicit JSON null, so it matches
 * ONLY documents that actually CARRY the key. A connection created before
 * MONEY-841 has no `syncBucket` key at all — `prisma db push` creates INDEXES,
 * never FIELDS, and the connect path only started writing the field afterwards
 * — so the pre-MONEY-841 rows were invisible to their own backfill. The script
 * selected them, found nothing, printed "Nothing to backfill — every connection
 * already has a syncBucket", and exited 0.
 *
 * MEASURED ON PROD 2026-08-21: `BrokerConnection` total=9, absent=1 (11.1%),
 * set=8. One connection in nine is outside the daily sync fan-out today, and it
 * is precisely the row this script was written to rescue: the fan-out queries
 * `where.syncBucket = N` for each shard, and an absent field matches no N.
 *
 * This is the FOURTH occurrence of the class (MONEY-1050 `{not:false}` vs
 * absent, MONEY-1205, MONEY-1234, MONEY-1235). `isSet: false` is the only
 * Prisma spelling that reaches an absent key (it lowers to `$exists: false`);
 * a bare `null`, `{ equals: null }` and `{ not: null }` all do not. The
 * established fix is the OR below, and a repo-wide guard now fails on any new
 * bare-`null` filter over an optional field
 * (apps/web/__tests__/meta/prisma-null-vs-isset.test.ts).
 *
 * Properties:
 *   - Idempotent: only touches rows where `syncBucket` is null OR ABSENT.
 *     Re-running is a no-op once everything is stamped; safe to run repeatedly.
 *   - Deterministic: uses the SHARED `syncBucketFor` from @usemoney/types/pubsub
 *     (the exact hash the web connect path + the worker fan-out use), so a
 *     backfilled connection lands in the same shard it would have on a fresh
 *     connect. Honors SYNC_BUCKET_COUNT (via getSyncBucketCount) so an env
 *     override is respected here too.
 *   - Per-user: sharding is per USER, so all of a user's connections get the
 *     same bucket — computed once per distinct userId.
 *
 * Usage:
 *   DATABASE_URL=<url> npx tsx scripts/ops/backfill-syncbucket.ts            # apply
 *   DATABASE_URL=<url> npx tsx scripts/ops/backfill-syncbucket.ts --dry-run  # preview only
 *   DATABASE_URL=<url> SYNC_BUCKET_COUNT=128 npx tsx scripts/ops/backfill-syncbucket.ts
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { syncBucketFor, getSyncBucketCount } from "@usemoney/types/pubsub";

const prisma = new PrismaClient();

const DRY_RUN =
  process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

/**
 * MONEY-1236 — "has no bucket yet", spelled so it reaches an ABSENT field.
 *
 * Two arms on purpose: `isSet: false` for a row that never carried the key
 * (every pre-MONEY-841 connection), `null` for a row that was stamped and then
 * explicitly cleared. On Mongo those are different documents and only this OR
 * covers both.
 *
 * Kept as ONE constant rather than two copies of the literal so the SELECT and
 * the per-user UPDATE cannot drift apart — a half-fixed predicate is exactly
 * how MONEY-1234's second broken pipe stayed hidden.
 *
 * NOT `as const`: Prisma's generated `BrokerConnectionWhereInput` types `OR` as
 * a MUTABLE array, so a readonly tuple is rejected (same footgun already
 * written down in scripts/jobs/xbrl-backfill.ts).
 */
const NO_BUCKET_OR: Prisma.BrokerConnectionWhereInput[] = [
  { syncBucket: null },
  { syncBucket: { isSet: false } },
];

/**
 * Mongo collection name for `model BrokerConnection`. The schema carries no
 * `@@map`, so Prisma uses the model name verbatim. `verifyRemainingRaw` proves
 * this is still true on every run rather than trusting it — see below.
 */
const BROKER_CONNECTION_COLLECTION = "BrokerConnection";

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
 * MONEY-1236 — count the still-unbucketed rows by a route that shares NOTHING
 * with the selection above.
 *
 * The two migrations fixed alongside this script (fix-premium-enddate,
 * backfill-pro-entitlement) each verified with a re-run of the SAME filter they
 * selected with, so each printed "0 remaining" for a population it could not
 * see — a double false success. A verification that reuses the selection can
 * only ever confirm the selection's own blind spot.
 *
 * This goes through `$runCommandRaw`, where the semantics are INVERTED in our
 * favour: raw Mongo's `{ field: null }` matches an absent key as well as an
 * explicit null. So the raw predicate is the plain `{ syncBucket: null }` that
 * was WRONG on the Prisma side, and if the Prisma OR above ever regressed to a
 * bare `null` the two counts would disagree instead of agreeing on zero.
 *
 * The `$facet` also re-counts the WHOLE collection and compares it against
 * Prisma's own total. That guard is load-bearing: `aggregate` against a
 * collection name that does not exist returns an empty result, NOT an error —
 * so a future `@@map("broker_connections")` would silently turn this verify
 * into a hard-coded zero, which is the very failure mode being fixed. On a
 * mismatch it throws instead of reporting success.
 */
async function verifyRemainingRaw(prismaTotal: number): Promise<number> {
  const res = (await prisma.$runCommandRaw({
    aggregate: BROKER_CONNECTION_COLLECTION,
    pipeline: [
      {
        $facet: {
          total: [{ $count: "n" }],
          // Raw Mongo: `null` reaches missing keys too. Deliberate.
          hit: [{ $match: { syncBucket: null } }, { $count: "n" }],
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
        `"${BROKER_CONNECTION_COLLECTION}" holds ${rawTotal} doc(s) but Prisma ` +
        `counts ${prismaTotal}. The collection was probably renamed via @@map. ` +
        `Refusing to report a verification result that would be a hard-coded zero.`,
    );
  }
  return doc?.hit?.[0]?.n ?? 0;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("Missing env: DATABASE_URL");
    process.exit(1);
  }

  const bucketCount = getSyncBucketCount();
  console.log(
    `Backfilling BrokerConnection.syncBucket (count=${bucketCount}${DRY_RUN ? ", DRY-RUN" : ""})`,
  );

  // Only rows missing a bucket — idempotent. Pull just the id + userId.
  // MONEY-1236: `OR` (null OR absent), never a bare `{ syncBucket: null }`.
  const pending = await prisma.brokerConnection.findMany({
    where: { OR: NO_BUCKET_OR },
    select: { id: true, userId: true },
  });

  if (pending.length === 0) {
    // MONEY-1236: this line used to be a LIE. With the old bare-`null` filter it
    // printed for a table whose pre-MONEY-841 rows had no key at all. It is now
    // cross-checked against raw Mongo before it is believed.
    const strandedRaw = await verifyRemainingRaw(
      await prisma.brokerConnection.count(),
    );
    if (strandedRaw > 0) {
      console.error(
        `\nSELECTION IS BROKEN: Prisma selected 0 rows but raw Mongo sees ` +
          `${strandedRaw} connection(s) with no syncBucket. Do NOT trust the ` +
          `"nothing to backfill" result — this is MONEY-1236 regressing.`,
      );
      await prisma.$disconnect();
      process.exit(1);
    }
    console.log(
      "Nothing to backfill — every connection already has a syncBucket " +
        "(confirmed independently via raw $exists semantics).",
    );
    await prisma.$disconnect();
    return;
  }

  // Compute the bucket once per distinct userId (sharding is per-user).
  const bucketByUser = new Map<string, number>();
  for (const c of pending) {
    if (!bucketByUser.has(c.userId)) {
      bucketByUser.set(c.userId, syncBucketFor(c.userId, bucketCount));
    }
  }

  console.log(
    `${pending.length} connection(s) across ${bucketByUser.size} user(s) need a bucket.`,
  );

  // Distribution preview (how many users land in each bucket) — a sanity check
  // that the hash spreads users instead of clumping.
  const perBucket = new Array<number>(bucketCount).fill(0);
  for (const bucket of bucketByUser.values()) perBucket[bucket]++;
  const nonEmpty = perBucket.filter((n) => n > 0).length;
  const max = Math.max(...perBucket);
  console.log(
    `Distribution: ${nonEmpty}/${bucketCount} buckets used, max ${max} user(s) in a bucket.`,
  );

  if (DRY_RUN) {
    console.log(
      "\nDRY-RUN: no rows updated. Re-run without --dry-run to apply.",
    );
    await prisma.$disconnect();
    return;
  }

  // Apply per-user (updateMany only the still-unbucketed rows for that user, so
  // a concurrent connect that already stamped the bucket isn't overwritten).
  let updated = 0;
  let i = 0;
  for (const [userId, bucket] of bucketByUser) {
    const res = await prisma.brokerConnection.updateMany({
      where: { userId, OR: NO_BUCKET_OR },
      data: { syncBucket: bucket },
    });
    updated += res.count;
    if (++i % 100 === 0) {
      console.log(
        `  ${i}/${bucketByUser.size} users processed (${updated} rows)`,
      );
    }
  }

  // MONEY-1236 — verify by the INDEPENDENT route, not by re-running the filter
  // we just selected with. A `remaining > 0` here means rows exist that the
  // Prisma predicate cannot see, which is the defect itself, not a partial run.
  const remaining = await verifyRemainingRaw(
    await prisma.brokerConnection.count(),
  );

  console.log(`\n========== Backfill Complete ==========`);
  console.log(`Connections updated: ${updated}`);
  console.log(`Users processed:     ${bucketByUser.size}`);
  console.log(`Remaining unbucketed (raw $exists): ${remaining} (should be 0)`);

  await prisma.$disconnect();

  if (remaining > 0) {
    console.error(
      `\n${remaining} connection(s) still have no syncBucket and are invisible ` +
        `to the sharded sync fan-out. Exiting non-zero so this cannot read as ` +
        `a success.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
