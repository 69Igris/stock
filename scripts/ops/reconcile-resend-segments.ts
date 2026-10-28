/**
 * Reconciles Resend audiences with current DB subscription status.
 *
 * For each user, figures out the correct segment (paid / free / downgraded)
 * and removes them from the two OTHER segments. Fixes "add-only" drift from
 * webhook or previous sync failures.
 *
 * Segment rules:
 *   - ACTIVE paid subscription (PRO/PREMIUM/ULTIMATE)  → paid
 *   - Has completed payment history, not currently paid → downgraded
 *   - Never paid                                        → free
 *
 * Usage:
 *   DATABASE_URL=<url> \
 *   RESEND_API_KEY=<key> \
 *   RESEND_AUDIENCE_FREE_ID=<id> \
 *   RESEND_AUDIENCE_PAID_ID=<id> \
 *   RESEND_AUDIENCE_DOWNGRADED_ID=<id> \
 *   npx tsx scripts/ops/reconcile-resend-segments.ts
 */

import { PrismaClient } from "@prisma/client";
import { Resend } from "resend";

const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY!);

const FREE_ID = process.env.RESEND_AUDIENCE_FREE_ID!;
const PAID_ID = process.env.RESEND_AUDIENCE_PAID_ID!;
const DOWNGRADED_ID = process.env.RESEND_AUDIENCE_DOWNGRADED_ID || "";
const RATE_LIMIT_MS = 125;

const PAID_PLANS = new Set(["PRO", "PREMIUM", "ULTIMATE"]);

async function main() {
  if (!process.env.RESEND_API_KEY || !FREE_ID || !PAID_ID) {
    console.error(
      "Missing env: RESEND_API_KEY, RESEND_AUDIENCE_FREE_ID, RESEND_AUDIENCE_PAID_ID",
    );
    process.exit(1);
  }
  if (!DOWNGRADED_ID) {
    console.warn(
      "⚠ RESEND_AUDIENCE_DOWNGRADED_ID not set - previously-paid users will fall back to 'free'",
    );
  }

  const users = await prisma.user.findMany({
    select: {
      email: true,
      subscription: { select: { status: true, planId: true } },
      payments: {
        where: { status: "COMPLETED" },
        select: { id: true },
        take: 1,
      },
    },
  });

  console.log(`Reconciling ${users.length} users...`);
  console.log(`  FREE audience:       ${FREE_ID}`);
  console.log(`  PAID audience:       ${PAID_ID}`);
  console.log(
    `  DOWNGRADED audience: ${DOWNGRADED_ID || "(not configured)"}\n`,
  );

  let removedFromFree = 0;
  let removedFromPaid = 0;
  let removedFromDowngraded = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const sub = user.subscription;
    const isPaid =
      sub?.status === "ACTIVE" && PAID_PLANS.has(sub.planId as string);
    const hasEverPaid = user.payments.length > 0;

    // Determine correct segment
    let correctId: string;
    if (isPaid) correctId = PAID_ID;
    else if (hasEverPaid && DOWNGRADED_ID) correctId = DOWNGRADED_ID;
    else correctId = FREE_ID;

    // Remove from the OTHER two segments
    const toRemove = [FREE_ID, PAID_ID, DOWNGRADED_ID].filter(
      (id) => id && id !== correctId,
    );

    for (const audienceId of toRemove) {
      try {
        const { error } = await resend.contacts.remove({
          audienceId,
          email: user.email,
        });
        if (error) {
          if (error.message?.toLowerCase().includes("not found")) {
            notFound++;
          } else {
            errors++;
            console.error(`[${user.email}] ${error.message}`);
          }
        } else {
          if (audienceId === FREE_ID) removedFromFree++;
          else if (audienceId === PAID_ID) removedFromPaid++;
          else if (audienceId === DOWNGRADED_ID) removedFromDowngraded++;
        }
      } catch (err) {
        errors++;
        console.error(
          `[${user.email}] ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${users.length} processed`);
    }
  }

  console.log(`\n========== Reconcile Complete ==========`);
  console.log(`Removed from FREE:       ${removedFromFree}`);
  console.log(`Removed from PAID:       ${removedFromPaid}`);
  console.log(`Removed from DOWNGRADED: ${removedFromDowngraded}`);
  console.log(`Not found (already clean): ${notFound}`);
  console.log(`Errors:                  ${errors}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
