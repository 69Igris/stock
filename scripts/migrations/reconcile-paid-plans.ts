/**
 * Reconcile Subscription.planId against COMPLETED payments (MONEY-650).
 *
 * Repairs users who PAID but whose plan is still BELOW what they bought — e.g.
 * a Dodo webhook that threw AFTER claiming `appliedAt` (so the retry early-exits
 * on the idempotency claim and the plan is never written), or a webhook that
 * never delivered.
 *
 * NOTE: the billing-page bug that prompted this did NOT corrupt the DB — the
 * webhook still wrote planId for PRO/PREMIUM; only the client-side sidebar cache
 * went stale (fixed separately). So in the common case this finds ZERO repairs.
 * It is a safety net for genuine webhook failures.
 *
 * Strategy (conservative — never downgrades, never clobbers a deliberate
 * cancel/downgrade):
 *   - For each user, take the plan of their most-recent COMPLETED BASE payment
 *     (PRO / PREMIUM; QUERY_PACK / AI_ADDON are add-ons and ULTIMATE is not
 *     sold, so all are skipped).
 *   - A user is a REPAIR CANDIDATE iff the paid plan OUTRANKS the current
 *     Subscription.planId.
 *   - A candidate is SKIPPED (flagged, not written) if it shows a deliberate
 *     downgrade signal — status != ACTIVE, cancelledAt set, or a scheduled plan
 *     change — so we never undo an intentional downgrade/cancel.
 *   - Repairs set planId + status=ACTIVE + the plan LIMITS from PLAN_CONFIG,
 *     and never touch any *Used usage counters.
 *
 * Dry-run by DEFAULT (safer than the backfill scripts, since this grants paid
 * entitlements). Pass --apply to write.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/migrations/reconcile-paid-plans.ts
 *   DATABASE_URL=... npx tsx scripts/migrations/reconcile-paid-plans.ts --apply
 *   # or with the repo env file:
 *   dotenv -e .env -- npx tsx scripts/migrations/reconcile-paid-plans.ts
 */

import "dotenv/config";
import { prisma } from "@usemoney/database";
import { PLAN_CONFIG } from "@usemoney/core";

const APPLY = process.argv.includes("--apply");

// Base-plan rank for the "never downgrade" guard. Add-ons (QUERY_PACK /
// AI_ADDON) are NOT base tiers; ULTIMATE is not sold (MONEY-650 — skipped).
const RANK: Record<string, number> = { FREE: 0, PRO: 1, PREMIUM: 2 };
const PAID_BASE_PLANS = ["PRO", "PREMIUM"] as const;
type PaidPlan = (typeof PAID_BASE_PLANS)[number];

async function main() {
  console.log("Reconcile paid plans (MONEY-650)");
  console.log(`Mode: ${APPLY ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);
  console.log("=".repeat(60));

  // Most-recent COMPLETED base-plan payment per user.
  const payments = await prisma.payment.findMany({
    where: { status: "COMPLETED", planId: { in: [...PAID_BASE_PLANS] } },
    select: { userId: true, planId: true, paidAt: true, createdAt: true },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
  });

  const latestPaid = new Map<string, PaidPlan>();
  for (const p of payments) {
    if (!latestPaid.has(p.userId)) {
      latestPaid.set(p.userId, p.planId as PaidPlan);
    }
  }
  console.log(`Users with a COMPLETED PRO/PREMIUM payment: ${latestPaid.size}`);

  let candidates = 0;
  let skippedDowngrade = 0;
  let repaired = 0;

  for (const [userId, paidPlan] of latestPaid) {
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    const current = sub?.planId ?? "FREE";
    const currentRank = RANK[current] ?? 0;
    const paidRank = RANK[paidPlan] ?? 0;

    // Only under-provisioned users are candidates. Never downgrade.
    if (paidRank <= currentRank) continue;
    candidates++;

    // Respect a deliberate downgrade/cancel — do NOT undo it.
    const downgradeSignal =
      !!sub &&
      (sub.status !== "ACTIVE" ||
        sub.cancelledAt != null ||
        sub.scheduledPlanId != null);

    if (downgradeSignal) {
      skippedDowngrade++;
      console.log(
        `SKIP  userId=${userId} paid=${paidPlan} current=${current} ` +
          `status=${sub?.status} cancelledAt=${sub?.cancelledAt ?? "-"} ` +
          `scheduledPlanId=${sub?.scheduledPlanId ?? "-"} (deliberate downgrade/cancel — review manually)`,
      );
      continue;
    }

    const cfg = PLAN_CONFIG[paidPlan];
    console.log(
      `FIX   userId=${userId} paid=${paidPlan} current=${current}` +
        (APPLY ? " -> upgrading" : " (dry-run)"),
    );

    if (APPLY) {
      // Set the plan + limits; never reset *Used usage counters.
      await prisma.subscription.upsert({
        where: { userId },
        update: {
          planId: paidPlan,
          status: "ACTIVE",
          aiQueriesLimit: cfg.aiQueries,
          fastQueriesLimit: cfg.fastQueries,
          advancedQueriesLimit: cfg.advancedQueries,
          creditsLimit: cfg.credits,
        },
        create: {
          userId,
          planId: paidPlan,
          status: "ACTIVE",
          aiQueriesUsed: 0,
          aiQueriesLimit: cfg.aiQueries,
          fastQueriesUsed: 0,
          fastQueriesLimit: cfg.fastQueries,
          advancedQueriesUsed: 0,
          advancedQueriesLimit: cfg.advancedQueries,
          creditsUsed: 0,
          creditsLimit: cfg.credits,
          addons: [],
          packCreditsUsed: 0,
          packCreditsLimit: 0,
        },
      });
      repaired++;
    }
  }

  console.log("=".repeat(60));
  console.log(
    `Candidates (paid > current): ${candidates} | ` +
      `skipped (deliberate downgrade): ${skippedDowngrade} | ` +
      (APPLY ? `repaired: ${repaired}` : "repairable: " + (candidates - skippedDowngrade)),
  );
  if (!APPLY && candidates - skippedDowngrade > 0) {
    console.log("Re-run with --apply to upgrade the repairable users.");
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[reconcile] error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
