/**
 * Stamp `welcomeEmailSentAt` on existing users so they can never be sent a late
 * welcome email — MONEY-1236.
 *
 * ## Why this exists
 *
 * `apps/web/app/api/webhooks/clerk/route.ts` claims the welcome email with
 * `updateMany({ where: { id, welcomeEmailSentAt: null } })`. On MongoDB that
 * matched NOTHING: the field is optional, no create path writes it, and Prisma's
 * connector does not treat an ABSENT field as null. Measured on prod
 * 2026-08-21 — 653 of 653 users absent, 0 null, 0 set — so the claim returned
 * `count: 0` for every signup since 2026-06-26 and nobody was ever emailed.
 *
 * Repairing the filter is necessary but NOT sufficient, because the claim runs
 * from `user.updated` as well as `user.created`. `user.updated` fires on any
 * Clerk profile change, so a repaired filter alone would let the next profile
 * edit by a user who signed up in January win the claim and receive a "Welcome
 * to UseMoney!" months late.
 *
 * The route defends itself with an account-age gate
 * (`WELCOME_BACKFILL_MAX_AGE_DAYS`, 30 days => at most 22 users could receive a
 * late welcome, and only on their next webhook). That makes the code safe to
 * deploy on its own, with no ordering dependency on this script.
 *
 * THIS SCRIPT IS THE ZERO-TAIL OPTION. Run it if you want NOBODY who already
 * exists to receive a late welcome, not even the recent signups the age gate
 * would allow. It is the more conservative choice and it is not the default,
 * because a user who signed up three weeks ago and was silently missed is
 * arguably owed the email.
 *
 * ## Why it writes a DATE and not a flag
 *
 * `welcomeEmailSentAt` is a watermark, and the route's MONEY-877 unwind resets
 * it to explicit `null` to mean "attempted and failed, retry". Writing a date
 * here therefore says "considered done" in the vocabulary the route already
 * speaks. It deliberately does NOT claim the email was sent — see
 * `--mark-as` below, which stamps the account's own `createdAt` so the row
 * carries an honest timestamp rather than a fictional "sent just now".
 *
 * ## Usage
 *
 *   npx tsx scripts/migrations/stamp-welcome-email-backfill.ts            # DRY RUN
 *   npx tsx scripts/migrations/stamp-welcome-email-backfill.ts --apply
 *   npx tsx scripts/migrations/stamp-welcome-email-backfill.ts --apply --older-than-days=30
 *
 * Prefer the wrapper so DATABASE_URL comes from Secret Manager rather than
 * being pasted in by hand.
 *
 * `--older-than-days=N` stamps only accounts older than N days, leaving recent
 * signups eligible for the late welcome the route's age gate permits. Passing
 * the same N the route uses makes the two agree exactly.
 */
// Both siblings in this directory load it, and the DRY RUN command in this
// file's own usage block cannot resolve DATABASE_URL without it — MONEY-1236.
import "dotenv/config";
import prisma from "@usemoney/database";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const OLDER_THAN_DAYS = Number(arg("older-than-days") ?? 0) || 0;

async function main(): Promise<void> {
  const cutoff =
    OLDER_THAN_DAYS > 0
      ? new Date(Date.now() - OLDER_THAN_DAYS * 24 * 60 * 60 * 1000)
      : null;

  // The population, counted the way the DEFECT sees it. `{ isSet: false }` is
  // the only shape that finds these rows; `{ welcomeEmailSentAt: null }` — the
  // filter this whole ticket is about — returns 0 here and would report
  // "nothing to do", which is precisely the false success being fixed.
  const where = {
    OR: [
      { welcomeEmailSentAt: null },
      { welcomeEmailSentAt: { isSet: false } },
    ],
    ...(cutoff ? { createdAt: { lt: cutoff } } : {}),
  };

  const total = await prisma.user.count();
  const unstamped = await prisma.user.count({ where });

  // The contrast that makes the bug legible in the run's own output.
  const brokenFilterWouldSee = await prisma.user.count({
    where: {
      // prisma-null-ok: this bare null is the DEFECT, quoted deliberately so the
      // run prints it beside the correct count. Removing it would delete the
      // evidence, not fix a bug — see the two numbers this script emits.
      welcomeEmailSentAt: null,
      ...(cutoff ? { createdAt: { lt: cutoff } } : {}),
    },
  });

  console.log(`[stamp-welcome] users total                    : ${total}`);
  console.log(`[stamp-welcome] unstamped (isSet:false OR null): ${unstamped}`);
  console.log(
    `[stamp-welcome] what the BROKEN filter sees      : ${brokenFilterWouldSee}` +
      ` <- the whole defect, in one number`,
  );
  if (cutoff) {
    console.log(
      `[stamp-welcome] restricted to accounts older than ${OLDER_THAN_DAYS}d ` +
        `(created before ${cutoff.toISOString().slice(0, 10)})`,
    );
  }

  if (unstamped === 0) {
    console.log("[stamp-welcome] nothing to stamp.");
    return;
  }

  if (!APPLY) {
    const sample = await prisma.user.findMany({
      where,
      select: { email: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    console.log(
      "[stamp-welcome] DRY RUN — nothing written. Newest 5 affected:",
    );
    for (const u of sample) {
      console.log(
        `  ${u.createdAt.toISOString().slice(0, 10)}  ${u.email ?? "(no email)"}`,
      );
    }
    console.log("[stamp-welcome] re-run with --apply to stamp.");
    return;
  }

  // Stamped to each account's OWN createdAt, not to now(). A watermark that
  // claims "sent just now" for a user who signed up in January is a lie that
  // any later audit would have to unpick; their own signup date is at least a
  // true statement about when the decision point was.
  //
  // Per-user rather than one updateMany, because updateMany cannot set a value
  // derived from the row. The population is ~653, so the cost is irrelevant and
  // a partial failure leaves a coherent state rather than an unknown one.
  const rows = await prisma.user.findMany({
    where,
    select: { id: true, createdAt: true },
  });
  let stamped = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await prisma.user.update({
        where: { id: r.id },
        data: { welcomeEmailSentAt: r.createdAt },
      });
      stamped++;
    } catch (error) {
      failed++;
      console.error(`[stamp-welcome] failed for ${r.id}:`, error);
    }
  }

  // Verified by RE-COUNTING the population, not by trusting the write loop —
  // two of the migrations this ticket also fixes reported "0 remaining" using
  // the same broken filter they selected with, and so certified their own blind
  // spot. This re-count uses the isSet-aware filter.
  const remaining = await prisma.user.count({ where });
  console.log(
    `[stamp-welcome] stamped ${stamped}, failed ${failed}, remaining ${remaining}`,
  );
  if (remaining > 0) {
    console.error(
      "[stamp-welcome] rows remain unstamped — a later webhook could still " +
        "send them a welcome. Investigate before deploying the route fix.",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error("[stamp-welcome] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
