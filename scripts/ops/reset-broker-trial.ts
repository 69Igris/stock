/**
 * MONEY-877 — goodwill broker-trial reset (invoked by reset-broker-trial.sh).
 *
 * Sets User.brokerTrialEndsAt = now + 30d for every current FREE-plan user, giving
 * them a fresh 30-day broker trial. DRY_RUN=1 prints the counts without writing.
 * DATABASE_URL is provided by the .sh wrapper (resolved from GCP Secret Manager).
 *
 * The trial reads (brokerTrialEndsAt ?? createdAt + 30d), so this never touches the
 * real signup date and is reversible by clearing the field.
 */
import { prisma } from "@usemoney/database";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function main() {
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const now = new Date();
  const newEnd = new Date(now.getTime() + THIRTY_DAYS_MS);

  // All FREE-plan users (the only ones the broker gate applies to).
  const freeSubs = await prisma.subscription.findMany({
    where: { planId: "FREE" },
    select: { userId: true },
  });
  const userIds = [...new Set(freeSubs.map((s) => s.userId))];
  console.log(`FREE-plan users: ${userIds.length}`);

  // Visibility: how many are currently EXPIRED (a past end date, or no end set and
  // signed up >30d ago) — i.e. locked out right now, the main beneficiaries.
  const cutoff = new Date(now.getTime() - THIRTY_DAYS_MS);
  const expired = await prisma.user.count({
    where: {
      id: { in: userIds },
      OR: [
        { brokerTrialEndsAt: { lt: now } },
        // ABSENT counts too — MONEY-1236. Measured on prod 2026-08-21: 64 of
        // 653 users have no `brokerTrialEndsAt` key at all (0 explicit null),
        // and a bare `null` reaches none of them. Those 64 are precisely the
        // users on the createdAt-based fallback trial this arm exists to count,
        // so the "currently trial-expired" figure understated the lockout by
        // every one of them.
        {
          OR: [
            { brokerTrialEndsAt: null },
            { brokerTrialEndsAt: { isSet: false } },
          ],
          createdAt: { lt: cutoff },
        },
      ],
    },
  });
  console.log(`  currently trial-expired (locked out): ${expired}`);

  if (dryRun) {
    console.log(
      `DRY_RUN — would set brokerTrialEndsAt=${newEnd.toISOString()} for ${userIds.length} FREE users. No writes.`,
    );
    return;
  }

  // Batch the updateMany so the id-array stays sane on a large user base.
  const BATCH = 1000;
  let total = 0;
  for (let i = 0; i < userIds.length; i += BATCH) {
    const chunk = userIds.slice(i, i + BATCH);
    const res = await prisma.user.updateMany({
      where: { id: { in: chunk } },
      data: { brokerTrialEndsAt: newEnd },
    });
    total += res.count;
    console.log(`  batch ${Math.floor(i / BATCH) + 1}: ${res.count}`);
  }
  console.log(
    `Done — brokerTrialEndsAt=${newEnd.toISOString()} for ${total} FREE users.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("reset-broker-trial failed:", err);
    process.exit(1);
  });
