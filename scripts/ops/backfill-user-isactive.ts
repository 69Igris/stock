/**
 * MONEY-1050 — backfill User.isActive for legacy documents missing the field.
 *
 * `User.isActive` (Boolean, @default(true), the soft-delete flag) was added
 * after some users had already been created. Prisma's `@default(true)` only
 * applies to NEW writes, so those pre-existing documents are PHYSICALLY missing
 * the `isActive` key (verified on prod: 9 of 599 users, incl. the founder).
 *
 * Why this matters: every `where: { isActive: true }` query silently drops
 * those users, because a missing field never equals `true`. Observed impact:
 *   - Content CMS "Individual Emails" people-picker couldn't find them
 *     (apps/content — Atlas + Prisma fallback). The Atlas path was fixed to
 *     `mustNot equals(isActive=false)`, but Prisma's `not:false` does NOT match
 *     a missing field, so the fallback (QA/dev) needs the field to exist.
 *   - packages/services countMissingSubscriptions() undercounts.
 *   - Any other `isActive: true` consumer skips them.
 *
 * This stamps the schema default (`isActive: true`) onto exactly those rows.
 * Explicitly soft-deleted users (isActive === false) are untouched.
 *
 * Properties:
 *   - Idempotent: only matches `{ isActive: { $exists: false } }`. Re-running
 *     after a full pass is a no-op.
 *   - Uses $runCommandRaw: Prisma's typed layer cannot express `$exists:false`
 *     on a required scalar, so we go through the raw Mongo command.
 *   - Safe by default: DRY-RUN unless `--apply` is passed. Dry-run only reads.
 *
 * Usage:
 *   DATABASE_URL=<url> npx tsx scripts/ops/backfill-user-isactive.ts            # preview (dry-run)
 *   DATABASE_URL=<url> npx tsx scripts/ops/backfill-user-isactive.ts --apply    # write
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");

interface RawResult {
  cursor?: { firstBatch?: Record<string, unknown>[] };
  n?: number;
  nModified?: number;
  ok?: number;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("Missing env: DATABASE_URL");
    process.exit(1);
  }

  const filter = { isActive: { $exists: false } };

  // Count how many docs are missing the field.
  const countRes = (await prisma.$runCommandRaw({
    aggregate: "User",
    pipeline: [{ $match: filter }, { $count: "n" }],
    cursor: {},
  })) as RawResult;
  const missing = (countRes.cursor?.firstBatch?.[0]?.n as number) ?? 0;

  // Sample a few emails so the operator can eyeball who is affected.
  const sampleRes = (await prisma.$runCommandRaw({
    find: "User",
    filter,
    projection: { email: 1, _id: 0 },
    limit: 20,
  })) as RawResult;
  const sample = (sampleRes.cursor?.firstBatch ?? []).map((d) => d.email);

  console.log(`[backfill-user-isactive] users missing isActive: ${missing}`);
  if (sample.length > 0) {
    console.log(`[backfill-user-isactive] sample: ${sample.join(", ")}`);
  }

  if (missing === 0) {
    console.log("[backfill-user-isactive] nothing to do ✅");
    await prisma.$disconnect();
    return;
  }

  if (!APPLY) {
    console.log(
      `[backfill-user-isactive] DRY-RUN — would set { isActive: true } on ${missing} user(s). ` +
        `Re-run with --apply to write.`,
    );
    await prisma.$disconnect();
    return;
  }

  const updateRes = (await prisma.$runCommandRaw({
    update: "User",
    updates: [
      { q: filter, u: { $set: { isActive: true } }, multi: true },
    ],
  })) as RawResult;

  const modified = updateRes.nModified ?? 0;
  console.log(
    `[backfill-user-isactive] APPLIED — set isActive=true on ${modified} user(s) ✅`,
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(
    "[backfill-user-isactive] FATAL:",
    e instanceof Error ? e.message : e,
  );
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
