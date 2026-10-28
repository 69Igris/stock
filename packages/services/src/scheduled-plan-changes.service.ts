/**
 * Scheduled-plan-changes service — MONEY-482 / MONEY-1062 (W1-B).
 *
 * The hourly-cron body, moved verbatim out of
 * `apps/web/app/api/cron/apply-scheduled-plan-changes/route.ts` so the route is
 * pure transport (verifyCronAuth + call + JSON). For every Subscription whose
 * `scheduledEffectiveAt` has arrived it applies the scheduled change:
 *   - `scheduledPlanId === "FREE"`   → flip local plan to FREE (Dodo auto-renew
 *     was already stopped when the user scheduled the cancel).
 *   - `scheduledPlanId in {PRO,PREMIUM,…}` with a Dodo subscription → Dodo
 *     `changePlan` to the downgraded product, then flip local plan.
 *   - no Dodo subscription (rare/stale) → flip local plan only.
 * Cleared scheduled-* fields on success so a row never re-applies.
 *
 * `getDodoProductInfo` is bound directly from `./product-sync.service` — the
 * product-catalog lookup landed in this same package (W1-A), so the injection
 * seam it once needed is gone. `dodoClient` comes from `@usemoney/core/payments`.
 *
 * @see packages/services/src/scheduled-plan-changes-logic.ts (pure seams)
 * @see packages/services/__tests__/scheduled-plan-changes.test.ts
 */

import { prisma, PlanType } from "@usemoney/database";
import { paymentsLogger as logger } from "@usemoney/logger";
import { PLAN_CONFIG, resolvePlanId } from "@usemoney/core/subscription";
import { dodoClient } from "@usemoney/core/payments";
import { WEBHOOK_PLANS } from "@usemoney/core/payments/plan-config";
import { buildRebaseFields } from "./scheduled-plan-changes-logic";
import { getDodoProductInfo } from "./product-sync.service";
import { invalidateEntitlement } from "./entitlement-invalidation";

export interface ApplyScheduledChangesResult {
  applied: number;
  skipped: number;
  errors: Array<{ subscriptionId: string; message: string }>;
}

/**
 * Apply every due scheduled plan change. Errors on a single subscription are
 * captured (not thrown) so one bad row never aborts the batch — matching the
 * original cron. Returns per-run counts for the route's JSON response.
 */
export async function applyScheduledChanges(): Promise<ApplyScheduledChangesResult> {
  const now = new Date();
  const due = await prisma.subscription.findMany({
    where: {
      scheduledPlanId: { not: null },
      scheduledEffectiveAt: { lte: now },
    },
  });

  logger.info(`Found ${due.length} scheduled plan changes due`);

  const result: ApplyScheduledChangesResult = {
    applied: 0,
    skipped: 0,
    errors: [],
  };

  for (const sub of due) {
    try {
      const targetPlanId = sub.scheduledPlanId as string;
      const targetCycle = sub.scheduledBillingPeriod;

      // Re-base entitlements to the TARGET plan on every flip. The read paths
      // are heal-UP-only (they never lower limits), so without this a
      // PREMIUM→PRO downgrade kept 200 credits/month at PRO price forever.
      const resolvedTarget = resolvePlanId(targetPlanId);
      const targetConfig =
        PLAN_CONFIG[resolvedTarget as keyof typeof PLAN_CONFIG];
      const rebaseFields = buildRebaseFields(
        WEBHOOK_PLANS[resolvedTarget as keyof typeof WEBHOOK_PLANS],
        targetConfig,
        Date.now(),
      );

      if (targetPlanId === "FREE") {
        // Cancel — Dodo auto-renew already stopped via
        // cancel_at_next_billing_date when the user scheduled this.
        // We just flip local state.
        //
        // TOCTOU guard (MONEY-1062): a `payment.succeeded` grant can land
        // between the snapshot `findMany` above and this write, CLEARING
        // scheduledPlanId/scheduledEffectiveAt because a fresh paid grant
        // supersedes the scheduled drop. An unconditional update-by-id would
        // clobber that just-paid user back to FREE — and the consumed
        // fulfillment claim means no webhook redelivery would re-grant. So write
        // conditionally, re-asserting the schedule is still in place (mirroring
        // the snapshot `where`); if it was superseded, `count` is 0 and we skip.
        const { count } = await prisma.subscription.updateMany({
          where: {
            id: sub.id,
            scheduledPlanId: { not: null },
            scheduledEffectiveAt: { lte: now },
          },
          data: {
            planId: "FREE" as PlanType,
            billingPeriod: null,
            endDate: null,
            scheduledPlanId: null,
            scheduledBillingPeriod: null,
            scheduledEffectiveAt: null,
            status: "ACTIVE",
            ...rebaseFields,
          },
        });
        if (count === 0) {
          // A fresh grant superseded the scheduled cancel between snapshot and
          // write. Leave the just-paid state untouched; count as skipped.
          result.skipped++;
          logger.info(
            `Scheduled cancel for subscription ${sub.id} (user ${sub.userId}) superseded by a fresh grant — skipped`,
          );
          continue;
        }
        result.applied++;
        // MONEY-1134 — the hourly cron applies scheduled downgrades and
        // cancellations. Without this the user keeps their old entitlement for
        // the cache TTL after the change actually took effect.
        await invalidateEntitlement(sub.userId);
        logger.info(
          `Applied scheduled cancel for subscription ${sub.id} (user ${sub.userId})`,
        );
        continue;
      }

      // Tier or cycle downgrade. Need to flip the active Dodo subscription to
      // the new plan's product so the next billing cycle charges the correct
      // amount.
      if (!sub.dodoSubscriptionId) {
        // No Dodo subscription to update (rare — possibly free-tier user with
        // stale schedule). Just flip the local plan.
        //
        // Same TOCTOU guard as the FREE branch (MONEY-1062 Round C): a fresh
        // grant landing between the snapshot and this write clears the
        // scheduled-* fields; an unconditional update-by-id would clobber the
        // just-paid plan back to the downgrade target. Write conditionally,
        // re-asserting the schedule is still in place; count 0 ⇒ superseded ⇒
        // skip.
        const { count } = await prisma.subscription.updateMany({
          where: {
            id: sub.id,
            scheduledPlanId: { not: null },
            scheduledEffectiveAt: { lte: now },
          },
          data: {
            planId: targetPlanId as PlanType,
            billingPeriod: targetCycle ?? null,
            scheduledPlanId: null,
            scheduledBillingPeriod: null,
            scheduledEffectiveAt: null,
            ...rebaseFields,
          },
        });
        if (count === 0) {
          result.skipped++;
          logger.info(
            `Scheduled downgrade for subscription ${sub.id} (user ${sub.userId}) superseded by a fresh grant — skipped`,
          );
          continue;
        }
        result.applied++;
        // MONEY-1134 — the hourly cron applies scheduled downgrades and
        // cancellations. Without this the user keeps their old entitlement for
        // the cache TTL after the change actually took effect.
        await invalidateEntitlement(sub.userId);
        continue;
      }

      const productInfo = await getDodoProductInfo(
        targetPlanId,
        targetCycle ?? undefined,
      );
      if (!productInfo) {
        // No catalog row for the target — the schedule stays in place for the
        // next hourly run (a product sync may land in between). Counted as
        // SKIPPED, not an error (MONEY-1062 review: `skipped` was always 0).
        logger.warn(
          `No Dodo product for ${targetPlanId} ${targetCycle ?? ""} — subscription ${sub.id} skipped`,
        );
        result.skipped++;
        continue;
      }

      // Dodo `changePlan` with `full_immediately` so the new pricing takes
      // effect right away on the renewed cycle. Difference and prorated modes
      // are for mid-cycle changes; we're applying at term-end so there's no
      // fractional period to compute.
      await dodoClient.subscriptions.changePlan(sub.dodoSubscriptionId, {
        product_id: productInfo.productId,
        proration_billing_mode: "full_immediately",
        quantity: 1,
      });

      // TOCTOU guard (MONEY-1062 Round C), re-asserted AFTER the
      // getDodoProductInfo + changePlan window above — that window is wide
      // enough for a fresh `payment.succeeded` grant to land and clear the
      // scheduled-* fields (superseding this downgrade); an unconditional
      // update-by-id would clobber the just-paid plan. Count 0 ⇒ superseded ⇒
      // skip the local flip. NOTE the asymmetry vs the branches above: Dodo
      // `changePlan` has ALREADY fired, so a superseded row here is a
      // Dodo-vs-local partial state — surfaced at error level for manual
      // review, mirroring how a changePlan-then-local-write failure surfaces
      // through `result.errors`.
      const { count } = await prisma.subscription.updateMany({
        where: {
          id: sub.id,
          scheduledPlanId: { not: null },
          scheduledEffectiveAt: { lte: now },
        },
        data: {
          planId: targetPlanId as PlanType,
          billingPeriod: targetCycle ?? null,
          scheduledPlanId: null,
          scheduledBillingPeriod: null,
          scheduledEffectiveAt: null,
          ...rebaseFields,
        },
      });
      if (count === 0) {
        result.skipped++;
        logger.error(
          {
            subscriptionId: sub.id,
            userId: sub.userId,
            dodoSubscriptionId: sub.dodoSubscriptionId,
            targetPlanId,
            targetCycle,
          },
          "Scheduled downgrade superseded by a fresh grant AFTER Dodo changePlan fired — local plan left as granted; the Dodo subscription may need manual review",
        );
        continue;
      }

      result.applied++;
      // MONEY-1134 — the scheduled DOWNGRADE path. Distinct indentation from
      // the two above, which is how a scripted edit missed it; found by
      // counting `result.applied++` sites rather than trusting the patch count.
      await invalidateEntitlement(sub.userId);
      logger.info(
        `Applied scheduled downgrade for subscription ${sub.id} → ${targetPlanId} ${targetCycle ?? ""}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ subscriptionId: sub.id, message });
      logger.error(
        { error: err, subscriptionId: sub.id },
        "Failed to apply scheduled plan change",
      );
    }
  }

  return result;
}
