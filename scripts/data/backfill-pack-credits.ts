#!/usr/bin/env tsx
/**
 * Backfill `Subscription.packCreditsLimit` for users whose
 * COMPLETED CREDIT_PACK_* Payments never landed credits because of
 * the pre-cycle-7 callback bug (the returnUrl had planId=QUERY_PACK
 * and the old handler couldn't infer the pack size).
 *
 * Idempotent - relies on `Payment.metadata.backfilledAt` to skip
 * already-processed rows. Safe to re-run.
 *
 * Usage:
 *   tsx scripts/data/backfill-pack-credits.ts          # apply
 *   DRY_RUN=1 tsx scripts/data/backfill-pack-credits.ts  # report only
 */

import prisma, { Prisma } from "@usemoney/database";

const DRY_RUN = process.env.DRY_RUN === "1";

function creditsFromPayment(p: {
  metadata: unknown;
  planName: string | null;
}): number {
  const meta = (p.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.creditPackSize === "number") return meta.creditPackSize;

  if (typeof meta.originalPlanId === "string") {
    const m = (meta.originalPlanId as string).match(/^CREDIT_PACK_(\d+)$/);
    if (m?.[1]) return parseInt(m[1], 10);
  }

  if (p.planName) {
    const m = p.planName.match(/Credit Pack \((\d+) credits\)/i);
    if (m?.[1]) return parseInt(m[1], 10);
  }

  return 0;
}

async function main() {
  console.log(`[backfill-pack-credits] dry-run=${DRY_RUN}`);

  const rows = await prisma.payment.findMany({
    where: {
      status: "COMPLETED",
      OR: [{ planName: { contains: "Credit Pack" } }, { planId: "QUERY_PACK" }],
    },
    select: {
      id: true,
      userId: true,
      planName: true,
      metadata: true,
      paidAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `[backfill-pack-credits] found ${rows.length} completed pack payments`,
  );

  const totals = new Map<string, { credits: number; paymentIds: string[] }>();
  for (const p of rows) {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    if (meta.backfilledAt) continue;
    const credits = creditsFromPayment(p);
    if (credits <= 0) {
      console.warn(`  skip ${p.id} - couldn't parse credits from`, {
        planName: p.planName,
        metaKeys: Object.keys(meta),
      });
      continue;
    }
    const existing = totals.get(p.userId);
    if (existing) {
      existing.credits += credits;
      existing.paymentIds.push(p.id);
    } else {
      totals.set(p.userId, { credits, paymentIds: [p.id] });
    }
  }

  console.log(`[backfill-pack-credits] affecting ${totals.size} users`);

  for (const [userId, { credits, paymentIds }] of Array.from(
    totals.entries(),
  )) {
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    if (!sub) {
      console.warn(
        `  no subscription for user ${userId} - skipping ${credits}`,
      );
      continue;
    }

    const newLimit = (sub.packCreditsLimit ?? 0) + credits;
    console.log(
      `  user ${userId}: ${sub.packCreditsLimit} -> ${newLimit} (+${credits} from ${paymentIds.length} payments)`,
    );

    if (DRY_RUN) continue;

    await prisma.$transaction([
      prisma.subscription.update({
        where: { userId },
        data: { packCreditsLimit: newLimit },
      }),
      ...paymentIds.map((id) =>
        prisma.payment.update({
          where: { id },
          data: {
            metadata: {
              backfilledAt: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        }),
      ),
    ]);
  }

  console.log(`[backfill-pack-credits] done`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
