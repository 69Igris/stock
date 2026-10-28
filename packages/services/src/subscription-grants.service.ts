/**
 * Subscription grant + lifecycle writes — SUBSCRIPTION domain (MONEY-1062 W1-B).
 *
 * Founder directive (mid-wave): payments and subscription are SEPARATE setups
 * with a hard module boundary. This module owns every write to the Subscription
 * table — the paid-plan / addon / credit-pack GRANT upserts and the Dodo
 * lifecycle state mutations (cancel, renew, activate, past-due, expire). The
 * payments transport (`payment-provisioning.service.ts`) does the Payment-row
 * bookkeeping + the appliedAt claim-once mechanics, then CALLS INTO these
 * functions, passing the claim/release as callbacks so the claim-once mechanics
 * stay entirely on the payments side.
 *
 * Boundary rules honoured here:
 *   - defines its OWN input types — does NOT import the payment webhook/envelope
 *     types (`DodoWebhookData`, `PaymentNotifier`) or the payments claim helpers;
 *   - reads pre-extracted primitives (dodoSubscriptionId, creditPackSize,
 *     next_billing_date) from the caller rather than the Payment row;
 *   - may import core plan config + proration + provider I/O (dodoClient) —
 *     those are shared core, not the payments SERVICE.
 * Grant-shape parity is tested against THIS module.
 *
 * Behaviour is preserved verbatim from the pre-split handlers, including the two
 * intentional webhook↔callback divergences: the WEBHOOK main-plan grant reads
 * the legacy `aiQueriesLimit` from WEBHOOK_PLANS (PRO→10) while the CALLBACK
 * reads it from the canonical PLAN_CONFIG (PRO→20); and the callback writes no
 * emails / anchor-backfill.
 *
 * @see packages/services/src/payment-provisioning.service.ts (payments transport)
 * @see apps/web/__tests__/api/subscription-grants-service.test.ts (grant-shape)
 */

import { prisma, PlanType } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { PLAN_CONFIG, resolvePlanId } from "@usemoney/core/subscription";
import { dodoClient } from "@usemoney/core/payments";
import {
  WEBHOOK_PLANS,
  getAddonQueries,
  calculatePackCreditLimit,
  calculateQueryPackLimits,
  determineQueryPackEndDate,
  determineRenewalEndDate,
  getReadablePlanName,
} from "@usemoney/core/payments/plan-config";
import {
  computeFulfillmentBonusDays,
  type BillingCycle,
} from "@usemoney/core/subscription/proration";
import { buildProEntitlementFields } from "./subscription-logic";
import { invalidateEntitlement } from "./entitlement-invalidation";

/** A one-shot fulfillment claim, provided by the payments transport. Returns
 * true only for the caller that won the race. */
export type ClaimFn = () => Promise<boolean>;
/** Hand a won claim back (best-effort) so a retry can re-grant. */
export type ReleaseClaimFn = () => Promise<void>;

/**
 * Parse an external Dodo date string (`next_billing_date`), returning null for a
 * missing value OR an Invalid Date (MONEY-1062 review). A malformed date used to
 * flow straight into `new Date(...)` and persist an Invalid Date at the grant
 * write, which throws → route 500 → Dodo redelivery loop. Callers skip the field
 * when this returns null.
 */
function validDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Webhook grant (payment.succeeded).
// ---------------------------------------------------------------------------

/**
 * Everything the subscription grant needs from a completed Dodo payment,
 * pre-extracted by the payments transport (so this module never touches the
 * Payment row or the webhook types).
 */
export interface WebhookGrantContext {
  userId: string;
  /** Raw Payment.planId (verified); the addon branch pushes it as the addon id. */
  planId: string;
  /** Payment.period ("one-time" | "monthly" | "annual"). */
  period: string | null;
  /** dodoSubscriptionId resolved from Payment metadata ?? webhook subscription_id. */
  dodoSubscriptionId: string | null;
  /** Raw Dodo `next_billing_date` (ISO string) or null. */
  nextBillingDate: string | null;
  /** Credit-pack size extracted from the Payment record (0 for legacy packs). */
  creditPackSize: number;
}

export type WebhookGrantResult =
  | "plan_granted"
  | "addon_granted"
  | "addon_no_subscription"
  | "addon_ineligible"
  | "already_applied";

/**
 * Apply the paid-plan / addon subscription grant for a Dodo webhook. The
 * payments transport has already updated the Payment row + resolved the plan;
 * `claim`/`releaseClaim` are its one-shot fulfillment claim. Returns a descriptor
 * so the transport can notify + record the coupon exactly as before. Rethrows on
 * a grant write failure (after releasing the claim).
 */
export async function grantWebhookSubscription(
  ctx: WebhookGrantContext,
  claim: ClaimFn,
  releaseClaim: ReleaseClaimFn,
): Promise<WebhookGrantResult> {
  const resolvedPaymentPlan = resolvePlanId(ctx.planId);
  const plan = WEBHOOK_PLANS[resolvedPaymentPlan as keyof typeof WEBHOOK_PLANS];
  const isAddon = resolvedPaymentPlan === "QUERY_PACK";

  const existingSub = await prisma.subscription.findUnique({
    where: { userId: ctx.userId },
  });

  if (isAddon && !existingSub) {
    // A pack purchase with no subscription row must NOT fall into the main-plan
    // branch (which would rewrite planId to QUERY_PACK with zero credits). Claim
    // NOT taken, so a redelivery can still grant once the sub row exists.
    logger.error(
      { userId: ctx.userId },
      "[DODO WEBHOOK] Pack purchase with no subscription row — grant skipped",
    );
    return "addon_no_subscription";
  }

  if (isAddon && existingSub) {
    const resolvedUserPlan = resolvePlanId(existingSub.planId);
    if (
      resolvedUserPlan !== "PRO" &&
      resolvedUserPlan !== "PREMIUM" &&
      resolvedUserPlan !== "ULTIMATE"
    ) {
      logger.error(
        { userId: ctx.userId, planId: existingSub.planId },
        "[DODO WEBHOOK] Query Pack requires Pro, Premium, or Ultimate plan",
      );
      return "addon_ineligible";
    }

    // SECURITY (MONEY-594, A08): claim BEFORE reading the carry-forward state
    // (lost-update guard — only the race winner reads/acts on the subscription).
    if (!(await claim())) {
      logger.info(
        { userId: ctx.userId },
        "[DODO WEBHOOK] Query pack already applied, skipping",
      );
      return "already_applied";
    }

    // MONEY-594 (MONEY-1062 review): the post-claim re-read is INSIDE the
    // release-protected try. A transient DB error on this read AFTER the claim
    // flipped appliedAt would otherwise propagate → route 500 → Dodo redelivery's
    // claim() returns false → "already_applied" → user PAID but never granted. With
    // the read inside the try, a read failure releases the claim so the retry
    // re-grants cleanly.
    try {
      // Re-read AFTER winning the claim so carry-forward uses the post-claim snapshot.
      const claimedSub =
        (await prisma.subscription.findUnique({
          where: { userId: ctx.userId },
        })) ?? existingSub;

      const additionalQueries = getAddonQueries(claimedSub.planId);
      const { fastLimit: newFastLimit, advancedLimit: newAdvancedLimit } =
        calculateQueryPackLimits(
          claimedSub.queryPackFastQueriesLimit,
          claimedSub.queryPackFastQueriesUsed,
          claimedSub.queryPackAdvancedQueriesLimit,
          claimedSub.queryPackAdvancedQueriesUsed,
          additionalQueries,
          claimedSub.status === "ACTIVE",
        );
      // MONEY-298 cycle-7 unified ledger: credit packs are normalized to
      // QUERY_PACK on the Payment row, so this addon branch also fulfils them.
      const newPackLimit = calculatePackCreditLimit(
        claimedSub.packCreditsLimit,
        claimedSub.packCreditsUsed,
        ctx.creditPackSize,
        claimedSub.status === "ACTIVE",
      );

      await prisma.subscription.update({
        where: { userId: ctx.userId },
        data: {
          // Verified addon id from the paid Payment record.
          addons: { push: ctx.planId },
          queryPackActive: true,
          packCreditsLimit: newPackLimit,
          packCreditsUsed: 0,
          queryPackFastQueriesLimit: newFastLimit,
          queryPackFastQueriesUsed: 0,
          queryPackAdvancedQueriesLimit: newAdvancedLimit,
          queryPackAdvancedQueriesUsed: 0,
          queryPackStartDate: new Date(),
          queryPackEndDate: determineQueryPackEndDate(
            claimedSub.status,
            claimedSub.endDate,
          ),
        },
      });
    } catch (grantErr) {
      // Guard the release so a throwing release cannot swallow grantErr.
      await releaseClaim().catch(() => {});
      throw grantErr;
    }

    logger.info(
      { userId: ctx.userId },
      "[DODO WEBHOOK] Query pack added for user",
    );
    return "addon_granted";
  }

  // Changing main plan.
  const isRecurring = ctx.period === "monthly" || ctx.period === "annual";
  const planConfig =
    PLAN_CONFIG[resolvedPaymentPlan as keyof typeof PLAN_CONFIG];
  const dodoSubscriptionId = ctx.dodoSubscriptionId;

  // SECURITY (MONEY-594, A08): claim BEFORE reading/applying — a re-delivery
  // that loses the race must return before the upsert resets usage counters.
  if (!(await claim())) {
    // Claim already applied — idempotent billing-anchor backfill only (never a
    // grant), and only onto a row that has no linkage yet.
    const anchorData: Record<string, unknown> = {};
    if (dodoSubscriptionId) anchorData.dodoSubscriptionId = dodoSubscriptionId;
    // MONEY-1062 review: skip an Invalid `next_billing_date` (never persist an
    // Invalid Date, which throws at the write).
    const anchorNextBillingDate = validDateOrNull(ctx.nextBillingDate);
    if (anchorNextBillingDate) {
      anchorData.nextBillingDate = anchorNextBillingDate;
    }
    if (anchorData.dodoSubscriptionId) {
      try {
        const linked = await prisma.subscription.updateMany({
          where: {
            userId: ctx.userId,
            // MongoDB unset-vs-null trap: legacy rows have the field MISSING.
            OR: [
              { dodoSubscriptionId: null },
              { dodoSubscriptionId: { isSet: false } },
            ],
          },
          data: anchorData,
        });
        if (linked.count > 0) {
          logger.info(
            { userId: ctx.userId, dodoSubscriptionId },
            "[DODO WEBHOOK] Billing anchors backfilled on already-applied payment",
          );
        }
      } catch (err) {
        logger.error(
          { error: err, userId: ctx.userId },
          "[DODO WEBHOOK] Anchor backfill failed",
        );
      }
    }
    logger.info(
      { userId: ctx.userId },
      "[DODO WEBHOOK] Subscription already applied, skipping",
    );
    return "already_applied";
  }

  // MONEY-866: PRO-entitlement fields (post-claim read). PRO grant sets its own
  // anchor; a higher tier preserves the existing PRO entitlement.
  // MONEY-594 (MONEY-1062 review): the post-claim read is INSIDE the release-
  // protected try — a transient read failure AFTER the claim must release the
  // claim (else the redelivery sees "already_applied" → user PAID, never granted).
  try {
    const existingEntitlement =
      resolvedPaymentPlan === "PRO"
        ? null
        : await prisma.subscription.findUnique({
            where: { userId: ctx.userId },
            select: {
              proEntitlementType: true,
              proEntitlementStartDate: true,
              proEntitlementEndDate: true,
            },
          });
    const proEntitlementFields = buildProEntitlementFields({
      resolvedPlan: resolvedPaymentPlan,
      period: ctx.period,
      now: new Date(),
      existing: existingEntitlement,
    });

    // MONEY-1062 review: reject an Invalid Date from external `next_billing_date`
    // BEFORE the write — an Invalid Date persisted here throws at the grant → 500
    // retry loop.
    const validNextBillingDate = validDateOrNull(ctx.nextBillingDate);

    const subscriptionData = {
      planId: resolvedPaymentPlan as PlanType,
      // MONEY-1063 divergence #2, deliberately NOT changed here. The callback
      // writes `(PREMIUM|ULTIMATE|PRO) ? period : null`; this writes
      // `isRecurring ? period : null`, where `isRecurring` is derived from
      // `ctx.period` (line ~221), NOT from the webhook payload — so both paths
      // do have the same information.
      //
      // They are not the same rule, though, and neither is obviously canonical:
      // this one asks "is the period a real billing period", the callback asks
      // "is this a subscription plan". They differ for a QUERY_PACK carrying a
      // period (this writes it, callback nulls it) and for a subscription plan
      // carrying an odd period (this nulls it, callback writes it). The correct
      // rule is arguably the CONJUNCTION of both, which is a third behaviour —
      // a semantic decision on a live billing field, not a unification.
      //
      // Left for MONEY-1063 follow-up rather than guessed at, because unlike
      // aiQueriesLimit there is no canonical source to point to.
      billingPeriod: isRecurring ? ctx.period : null,
      status: "ACTIVE" as const,
      startDate: new Date(),
      endDate: null as Date | null,
      aiQueriesUsed: 0,
      // MONEY-1063 — was `plan?.aiQueries` (WEBHOOK_PLANS, PRO→10) while the
      // CALLBACK granting the SAME payment wrote PLAN_CONFIG's PRO→20. Whichever
      // path won the appliedAt claim decided how many AI queries a paying PRO
      // user got, so the entitlement was settled by a race. Nothing surfaced it:
      // both writes succeed, and 10 is a plausible number.
      //
      // PLAN_CONFIG is canonical — it is what the pricing page, the callback and
      // every OTHER limit on this very object already read (fastQueries,
      // advancedQueries, credits all use `planConfig` three lines below).
      // `aiQueriesLimit` was the lone holdout reaching into the legacy table.
      //
      // Unmapped plan (e.g. ULTIMATE) → 0 so the upsert still runs (MONEY-650),
      // preserved from the original.
      aiQueriesLimit: planConfig?.aiQueries ?? 0,
      aiQueriesResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      fastQueriesUsed: 0,
      fastQueriesLimit: planConfig?.fastQueries ?? 0,
      advancedQueriesUsed: 0,
      advancedQueriesLimit: planConfig?.advancedQueries ?? 0,
      creditsUsed: 0,
      creditsLimit: planConfig?.credits ?? 5,
      creditsResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      ...(dodoSubscriptionId ? { dodoSubscriptionId } : {}),
      ...(validNextBillingDate
        ? { nextBillingDate: validNextBillingDate }
        : {}),
      // A fresh paid grant supersedes any pending scheduled cancel / downgrade.
      scheduledPlanId: null,
      scheduledBillingPeriod: null,
      scheduledEffectiveAt: null,
      cancelledAt: null,
      ...proEntitlementFields,
    };

    await prisma.subscription.upsert({
      where: { userId: ctx.userId },
      update: subscriptionData,
      create: {
        userId: ctx.userId,
        addons: [],
        packCreditsUsed: 0,
        packCreditsLimit: 0,
        ...subscriptionData,
      },
    });
  } catch (grantErr) {
    // Guard the release so a throwing release cannot swallow grantErr.
    await releaseClaim().catch(() => {});
    throw grantErr;
  }

  logger.info(
    { userId: ctx.userId, planId: ctx.planId },
    "[DODO WEBHOOK] Subscription updated for user",
  );

  // Stop the OLD Dodo subscription after a tier/cycle change (double-billing
  // guard). Best-effort — a failure never blocks the grant.
  const previousDodoSubId = existingSub?.dodoSubscriptionId;
  if (
    previousDodoSubId &&
    dodoSubscriptionId &&
    previousDodoSubId !== dodoSubscriptionId
  ) {
    try {
      await dodoClient.subscriptions.update(previousDodoSubId, {
        cancel_at_next_billing_date: true,
      });
      logger.info(
        { previousDodoSubId, userId: ctx.userId },
        "[DODO WEBHOOK] Old Dodo subscription set to cancel after plan change",
      );
    } catch (err) {
      logger.error(
        { error: err, previousDodoSubId, userId: ctx.userId },
        "[DODO WEBHOOK] Failed to cancel old Dodo subscription after plan change — manual cleanup needed",
      );
    }
  }

  // Honor the upgrade dialog's remaining-days promise (bonus days).
  const oldResolvedPlan = existingSub
    ? resolvePlanId(existingSub.planId)
    : null;
  const newCycle: BillingCycle | null =
    ctx.period === "annual" || ctx.period === "monthly" ? ctx.period : null;
  const bonusDays =
    existingSub && oldResolvedPlan
      ? computeFulfillmentBonusDays({
          fromPlanId: oldResolvedPlan,
          fromCycle:
            existingSub.billingPeriod === "annual" ||
            existingSub.billingPeriod === "monthly"
              ? existingSub.billingPeriod
              : null,
          fromPlan: PLAN_CONFIG[oldResolvedPlan as keyof typeof PLAN_CONFIG],
          toPlanId: resolvedPaymentPlan,
          toCycle: newCycle,
          toPlan: planConfig,
          termAnchor: existingSub.endDate ?? existingSub.nextBillingDate,
        })
      : 0;
  if (bonusDays > 0 && dodoSubscriptionId && newCycle) {
    // MONEY-1062 (J-F5): reuse validDateOrNull for this THIRD ctx.nextBillingDate
    // use too — a malformed date made `new Date(...)` Invalid, so the later
    // `extendedAnchor.toISOString()` threw INSIDE the try and the bonus days were
    // silently dropped. null (missing OR invalid) → the standard-term default.
    const baseAnchor =
      validDateOrNull(ctx.nextBillingDate) ??
      new Date(
        Date.now() + (newCycle === "annual" ? 365 : 30) * 24 * 60 * 60 * 1000,
      );
    const extendedAnchor = new Date(
      baseAnchor.getTime() + bonusDays * 24 * 60 * 60 * 1000,
    );
    try {
      await dodoClient.subscriptions.update(dodoSubscriptionId, {
        next_billing_date: extendedAnchor.toISOString(),
      });
      await prisma.subscription.update({
        where: { userId: ctx.userId },
        data: { nextBillingDate: extendedAnchor },
      });
      logger.info(
        { userId: ctx.userId, bonusDays, extendedAnchor },
        "[DODO WEBHOOK] Upgrade bonus days applied to next billing date",
      );
    } catch (err) {
      logger.error(
        { error: err, userId: ctx.userId, bonusDays },
        "[DODO WEBHOOK] Failed to apply upgrade bonus days — honor manually",
      );
    }
  }

  // MONEY-1134 — a webhook-only upgrade must be visible immediately, not after
  // the cache TTL. This is the path the original fix named and did not cover.
  await invalidateEntitlement(ctx.userId);
  return "plan_granted";
}

// ---------------------------------------------------------------------------
// Callback grant (browser redirect path).
// ---------------------------------------------------------------------------

/** Pre-extracted callback grant inputs (the payments transport verified status
 * + ownership + a known plan before calling this). */
export interface CallbackGrantContext {
  userId: string;
  planId: string;
  period: string | null;
  /** dodoSubscriptionId resolved from Payment metadata. */
  dodoSubscriptionId: string | null;
  creditPackSize: number;
}

export type CallbackGrantResult =
  | "granted"
  | "already_applied"
  | "addon_ineligible";

/**
 * Apply the payments-callback subscription grant. Same claim-once semantics as
 * the webhook (via the injected `claim`), but reads `aiQueriesLimit` from the
 * canonical PLAN_CONFIG (the preserved callback divergence) and sends no emails /
 * anchor-backfill. Rethrows on a grant write failure (after releasing the claim).
 */
export async function grantCallbackSubscription(
  ctx: CallbackGrantContext,
  claim: ClaimFn,
  releaseClaim: ReleaseClaimFn,
): Promise<CallbackGrantResult> {
  const resolvedPlanId = resolvePlanId(ctx.planId);
  const plan = PLAN_CONFIG[resolvedPlanId as keyof typeof PLAN_CONFIG];
  const persistedBillingPeriod = ctx.period;

  const isAddon = resolvedPlanId === "QUERY_PACK";
  const existingSub = await prisma.subscription.findUnique({
    where: { userId: ctx.userId },
  });

  if (isAddon && !existingSub) {
    logger.error(
      { userId: ctx.userId },
      "[Payment Callback] Pack purchase with no subscription row — grant skipped",
    );
    return "addon_ineligible";
  }

  if (isAddon && existingSub) {
    const resolvedUserPlan = resolvePlanId(existingSub.planId);
    if (
      resolvedUserPlan !== "PRO" &&
      resolvedUserPlan !== "PREMIUM" &&
      resolvedUserPlan !== "ULTIMATE"
    ) {
      return "addon_ineligible";
    }

    if (!(await claim())) return "already_applied";

    // MONEY-594 (MONEY-1062 review): post-claim re-read INSIDE the release-
    // protected try, so a transient read failure AFTER the claim releases it (else
    // the redelivery sees "already_applied" → user PAID but never granted).
    try {
      const claimedSub =
        (await prisma.subscription.findUnique({
          where: { userId: ctx.userId },
        })) ?? existingSub;

      const additionalQueries = getAddonQueries(claimedSub.planId);
      const { fastLimit: newFastLimit, advancedLimit: newAdvancedLimit } =
        calculateQueryPackLimits(
          claimedSub.queryPackFastQueriesLimit,
          claimedSub.queryPackFastQueriesUsed,
          claimedSub.queryPackAdvancedQueriesLimit,
          claimedSub.queryPackAdvancedQueriesUsed,
          additionalQueries,
          claimedSub.status === "ACTIVE",
        );
      const newPackLimit = calculatePackCreditLimit(
        claimedSub.packCreditsLimit,
        claimedSub.packCreditsUsed,
        ctx.creditPackSize,
        claimedSub.status === "ACTIVE",
      );

      await prisma.subscription.update({
        where: { userId: ctx.userId },
        data: {
          // Verified addon id (resolvedPlanId), not the user-supplied query param.
          addons: { push: resolvedPlanId },
          queryPackActive: true,
          packCreditsLimit: newPackLimit,
          packCreditsUsed: 0,
          queryPackFastQueriesLimit: newFastLimit,
          queryPackFastQueriesUsed: 0,
          queryPackAdvancedQueriesLimit: newAdvancedLimit,
          queryPackAdvancedQueriesUsed: 0,
          queryPackStartDate: new Date(),
          queryPackEndDate: determineQueryPackEndDate(
            claimedSub.status,
            claimedSub.endDate,
          ),
        },
      });
    } catch (grantErr) {
      // Guard the release so a throwing release cannot swallow grantErr.
      await releaseClaim().catch(() => {});
      throw grantErr;
    }
    return "granted";
  }

  // Changing main plan.
  const endDate = null;
  const planConfig = PLAN_CONFIG[resolvedPlanId as keyof typeof PLAN_CONFIG];

  if (!(await claim())) return "already_applied";

  const callbackDodoSubId = ctx.dodoSubscriptionId;

  // MONEY-866: PRO-entitlement fields (parity with the webhook path).
  // MONEY-594 (MONEY-1062 review): the post-claim entitlement read is INSIDE the
  // release-protected try — a transient read failure AFTER the claim must release
  // the claim (else the redelivery sees "already_applied" → user PAID but never
  // granted). Mirrors the webhook main-plan branch.
  try {
    const existingEntitlement =
      resolvedPlanId === "PRO"
        ? null
        : await prisma.subscription.findUnique({
            where: { userId: ctx.userId },
            select: {
              proEntitlementType: true,
              proEntitlementStartDate: true,
              proEntitlementEndDate: true,
            },
          });
    const proEntitlementFields = buildProEntitlementFields({
      resolvedPlan: resolvedPlanId,
      period: persistedBillingPeriod,
      now: new Date(),
      existing: existingEntitlement,
    });

    await prisma.subscription.upsert({
      where: { userId: ctx.userId },
      update: {
        planId: resolvedPlanId as PlanType,
        billingPeriod:
          resolvedPlanId === "PREMIUM" ||
          resolvedPlanId === "ULTIMATE" ||
          resolvedPlanId === "PRO"
            ? persistedBillingPeriod
            : null,
        status: "ACTIVE",
        startDate: new Date(),
        endDate,
        aiQueriesUsed: 0,
        // PRESERVED divergence: callback reads aiQueriesLimit from PLAN_CONFIG.
        aiQueriesLimit: plan.aiQueries,
        aiQueriesResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        fastQueriesUsed: 0,
        fastQueriesLimit: planConfig?.fastQueries ?? 0,
        advancedQueriesUsed: 0,
        advancedQueriesLimit: planConfig?.advancedQueries ?? 0,
        creditsUsed: 0,
        creditsLimit: planConfig?.credits ?? 5,
        creditsResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        scheduledPlanId: null,
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: null,
        cancelledAt: null,
        ...proEntitlementFields,
        ...(callbackDodoSubId ? { dodoSubscriptionId: callbackDodoSubId } : {}),
      },
      create: {
        userId: ctx.userId,
        planId: resolvedPlanId as PlanType,
        billingPeriod:
          resolvedPlanId === "PREMIUM" ||
          resolvedPlanId === "ULTIMATE" ||
          resolvedPlanId === "PRO"
            ? persistedBillingPeriod
            : null,
        status: "ACTIVE",
        aiQueriesUsed: 0,
        aiQueriesLimit: plan.aiQueries,
        aiQueriesResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        addons: [],
        fastQueriesUsed: 0,
        fastQueriesLimit: planConfig?.fastQueries ?? 0,
        advancedQueriesUsed: 0,
        advancedQueriesLimit: planConfig?.advancedQueries ?? 0,
        creditsUsed: 0,
        creditsLimit: planConfig?.credits ?? 5,
        creditsResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        packCreditsUsed: 0,
        packCreditsLimit: 0,
        ...proEntitlementFields,
        ...(callbackDodoSubId ? { dodoSubscriptionId: callbackDodoSubId } : {}),
      },
    });
  } catch (grantErr) {
    // Guard the release so a throwing release cannot swallow grantErr.
    await releaseClaim().catch(() => {});
    throw grantErr;
  }

  // Stop the OLD Dodo subscription after a tier/cycle change (best-effort).
  const previousDodoSubId = existingSub?.dodoSubscriptionId;
  if (
    previousDodoSubId &&
    callbackDodoSubId &&
    previousDodoSubId !== callbackDodoSubId
  ) {
    try {
      await dodoClient.subscriptions.update(previousDodoSubId, {
        cancel_at_next_billing_date: true,
      });
      logger.info(
        { previousDodoSubId, userId: ctx.userId },
        "[Payment Callback] Old Dodo subscription set to cancel after plan change",
      );
    } catch (err) {
      logger.error(
        { error: err, previousDodoSubId, userId: ctx.userId },
        "[Payment Callback] Failed to cancel old Dodo subscription — manual cleanup needed",
      );
    }
  }

  // Honor the upgrade bonus-days promise (base anchor = now + standard term;
  // the callback has no Dodo payload).
  const oldResolvedPlan = existingSub
    ? resolvePlanId(existingSub.planId)
    : null;
  const newCycle: BillingCycle | null =
    ctx.period === "annual" || ctx.period === "monthly" ? ctx.period : null;
  const bonusDays =
    existingSub && oldResolvedPlan
      ? computeFulfillmentBonusDays({
          fromPlanId: oldResolvedPlan,
          fromCycle:
            existingSub.billingPeriod === "annual" ||
            existingSub.billingPeriod === "monthly"
              ? existingSub.billingPeriod
              : null,
          fromPlan: PLAN_CONFIG[oldResolvedPlan as keyof typeof PLAN_CONFIG],
          toPlanId: resolvedPlanId,
          toCycle: newCycle,
          toPlan: planConfig,
          termAnchor: existingSub.endDate ?? existingSub.nextBillingDate,
        })
      : 0;
  if (bonusDays > 0 && callbackDodoSubId && newCycle) {
    const baseAnchor = new Date(
      Date.now() + (newCycle === "annual" ? 365 : 30) * 24 * 60 * 60 * 1000,
    );
    const extendedAnchor = new Date(
      baseAnchor.getTime() + bonusDays * 24 * 60 * 60 * 1000,
    );
    try {
      await dodoClient.subscriptions.update(callbackDodoSubId, {
        next_billing_date: extendedAnchor.toISOString(),
      });
      await prisma.subscription.update({
        where: { userId: ctx.userId },
        data: { nextBillingDate: extendedAnchor },
      });
      logger.info(
        { userId: ctx.userId, bonusDays, extendedAnchor },
        "[Payment Callback] Upgrade bonus days applied to next billing date",
      );
    } catch (err) {
      logger.error(
        { error: err, userId: ctx.userId, bonusDays },
        "[Payment Callback] Failed to apply upgrade bonus days — honor manually",
      );
    }
  }

  // MONEY-1134 — the callback path already invalidates in the route, but a
  // grant is a plan change and this module should not depend on its caller
  // remembering.
  await invalidateEntitlement(ctx.userId);
  return "granted";
}

// ---------------------------------------------------------------------------
// Dodo lifecycle state mutations (subscription domain).
// ---------------------------------------------------------------------------

/** Emit shape for the two lifecycle events that notify (userId + display plan). */
export interface LifecycleNotifyTarget {
  userId: string;
  planName: string;
}

/**
 * subscription.cancelled: a cancelled account stays ACTIVE until the paid term
 * ends (scheduled drop); only a cancel with no remaining term flips immediately.
 * Returns the notify target, or null when the subscription is unknown.
 */
export async function applyDodoCancellation(
  subscriptionId: string | undefined,
): Promise<LifecycleNotifyTarget | null> {
  // Prisma DROPS an undefined where-value — findFirst would match an ARBITRARY
  // row and cancel someone else's subscription. Skip a payload with no id.
  if (!subscriptionId) {
    logger.warn(
      { event: "subscription.cancelled" },
      "[DODO WEBHOOK] applyDodoCancellation: missing subscription_id — skipping",
    );
    return null;
  }
  const subscription = await prisma.subscription.findFirst({
    where: { dodoSubscriptionId: subscriptionId },
  });
  if (!subscription) {
    logger.error(
      { dodoSubscriptionId: subscriptionId },
      "[dodo] subscription.cancelled for unknown subscription id",
    );
    return null;
  }

  // MONEY-1062 (J-F4): first-cycle rows fulfilled by the webhook can carry NEITHER
  // endDate NOR nextBillingDate (reachable now that validDateOrNull lets an
  // anchor-less grant persist). Rather than cancel immediately — eating the paid
  // term — derive the term end from startDate + billingPeriod (the same fallback
  // the in-app cancelSubscription uses) when the row has a startDate and a
  // monthly/annual period. Only a row with NO derivable term cancels on the spot.
  let termEnd = subscription.endDate ?? subscription.nextBillingDate;
  if (
    !termEnd &&
    subscription.startDate &&
    (subscription.billingPeriod === "annual" ||
      subscription.billingPeriod === "monthly")
  ) {
    termEnd = new Date(
      subscription.startDate.getTime() +
        (subscription.billingPeriod === "annual" ? 365 : 30) *
          24 *
          60 *
          60 *
          1000,
    );
  }
  if (termEnd && termEnd > new Date()) {
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        cancelledAt: new Date(),
        scheduledPlanId: "FREE",
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: termEnd,
      },
    });
    logger.info(
      { dodoSubscriptionId: subscriptionId, effectiveAt: termEnd },
      "[DODO WEBHOOK] Subscription cancel scheduled at term end (access kept)",
    );
  } else {
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    logger.info(
      { dodoSubscriptionId: subscriptionId },
      "[DODO WEBHOOK] Subscription cancelled",
    );
  }

  // MONEY-1134 — the cached entitlement must not outlive the cancellation.
  // This is the direction that costs money: without it, ~30 PageGuard-ed routes
  // keep serving PREMIUM to a cancelled user for the cache TTL.
  await invalidateEntitlement(subscription.userId);

  return {
    userId: subscription.userId,
    planName: getReadablePlanName(subscription.planId),
  };
}

/**
 * subscription.renewed: reset plan credits/queries for the new period (keep pack
 * credits), store next billing date, extend a PRO entitlement. A renewal for a
 * FREE-collapsed row is skipped (reconciliation guard). Returns the notify
 * target, or null when skipped / unknown.
 */
export async function applyDodoRenewal(
  subscriptionId: string | undefined,
  nextBillingDate: string | null,
): Promise<LifecycleNotifyTarget | null> {
  // Prisma DROPS an undefined where-value — findFirst would match an ARBITRARY
  // row and reset a random user's counters. Skip a payload with no id.
  if (!subscriptionId) {
    logger.warn(
      { event: "subscription.renewed" },
      "[DODO WEBHOOK] applyDodoRenewal: missing subscription_id — skipping",
    );
    return null;
  }
  const subscription = await prisma.subscription.findFirst({
    where: { dodoSubscriptionId: subscriptionId },
  });
  if (!subscription) {
    logger.error(
      { dodoSubscriptionId: subscriptionId },
      "[dodo] subscription.renewed for unknown subscription id — credit reset skipped",
    );
    return null;
  }

  if (resolvePlanId(subscription.planId) === "FREE") {
    logger.error(
      { dodoSubscriptionId: subscriptionId, userId: subscription.userId },
      "[DODO WEBHOOK] subscription.renewed for a FREE-plan row — skipped, needs reconciliation",
    );
    return null;
  }

  const updateData: Record<string, unknown> = {
    status: "ACTIVE",
    aiQueriesUsed: 0,
    fastQueriesUsed: 0,
    advancedQueriesUsed: 0,
    aiQueriesResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    creditsUsed: 0,
    creditsResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };
  // MONEY-1062 (Round C / C1#5): a malformed Dodo next_billing_date must SKIP
  // the field, never persist an Invalid Date (which throws at the write → route
  // 500 → redelivery loop). The credit/usage reset above must still land.
  const renewalNbd = validDateOrNull(nextBillingDate);
  if (renewalNbd) {
    updateData.nextBillingDate = renewalNbd;
  }
  if (
    resolvePlanId(subscription.planId) === "PRO" &&
    subscription.proEntitlementType
  ) {
    if (
      subscription.billingPeriod === "annual" ||
      subscription.billingPeriod === "monthly"
    ) {
      updateData.proEntitlementEndDate = determineRenewalEndDate(
        subscription.billingPeriod,
      );
    }
  }

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: updateData,
  });
  logger.info(
    { dodoSubscriptionId: subscriptionId },
    "[DODO WEBHOOK] Subscription renewed",
  );
  // MONEY-1134 — a renewal resets credits and can extend entitlement.
  await invalidateEntitlement(subscription.userId);
  return {
    userId: subscription.userId,
    planName: getReadablePlanName(subscription.planId),
  };
}

/**
 * subscription.active: store Dodo billing anchors (forward-only) + recover
 * PAST_DUE → ACTIVE. Never resurrects a CANCELLED row. No notification.
 */
export async function storeDodoActivationAnchors(
  subscriptionId: string | undefined,
  nextBillingDate: string | null,
): Promise<void> {
  if (!subscriptionId) return;
  const subscription = await prisma.subscription.findFirst({
    where: { dodoSubscriptionId: subscriptionId },
  });
  if (!subscription) {
    logger.info(
      { dodoSubscriptionId: subscriptionId },
      "[DODO WEBHOOK] subscription.active for a not-yet-linked row (payment.succeeded links it)",
    );
    return;
  }

  const updateData: Record<string, unknown> = {};
  // MONEY-1062 (Round C / C1#5): a malformed Dodo next_billing_date must SKIP
  // the anchor field — the PAST_DUE→ACTIVE recovery below must never be blocked
  // by an Invalid-Date write throwing at the update.
  const nbd = validDateOrNull(nextBillingDate);
  if (nbd) {
    if (
      !subscription.nextBillingDate ||
      nbd > new Date(subscription.nextBillingDate)
    ) {
      updateData.nextBillingDate = nbd;
    }
  }
  if (subscription.status === "PAST_DUE") {
    updateData.status = "ACTIVE";
  }
  if (Object.keys(updateData).length === 0) return;

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: updateData,
  });
  logger.info(
    { dodoSubscriptionId: subscriptionId },
    "[DODO WEBHOOK] Subscription activated — billing anchors stored",
  );
}

/** Dunning (on_hold / failed): mark the row PAST_DUE so access gating stops. */
export async function markDodoPastDue(
  subscriptionId: string | undefined,
  event: string,
): Promise<void> {
  // Prisma DROPS an undefined where-value — findFirst would match an ARBITRARY
  // row and mark a random user PAST_DUE. Skip a payload with no id.
  if (!subscriptionId) {
    logger.warn(
      { event },
      "[DODO WEBHOOK] markDodoPastDue: missing subscription_id — skipping",
    );
    return;
  }
  const subscription = await prisma.subscription.findFirst({
    where: { dodoSubscriptionId: subscriptionId },
  });
  if (!subscription) {
    logger.error(
      { dodoSubscriptionId: subscriptionId, event },
      "[dodo] dunning event for unknown subscription id",
    );
    return;
  }
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: "PAST_DUE" },
  });
  logger.warn(
    { dodoSubscriptionId: subscriptionId, userId: subscription.userId, event },
    "[DODO WEBHOOK] Subscription marked PAST_DUE",
  );
  // MONEY-1134 — PAST_DUE is a STATUS change, and `buildSubscriptionAccess`
  // collapses anything that is not ACTIVE to FREE. Without this the user keeps
  // premium access for the cache TTL after their payment fails.
  await invalidateEntitlement(subscription.userId);
}

/** Dunning terminal: mark EXPIRED with an endDate. */
export async function markDodoExpired(
  subscriptionId: string | undefined,
): Promise<void> {
  // Prisma DROPS an undefined where-value — findFirst would match an ARBITRARY
  // row and expire a random user's subscription. Skip a payload with no id.
  if (!subscriptionId) {
    logger.warn(
      { event: "subscription.expired" },
      "[DODO WEBHOOK] markDodoExpired: missing subscription_id — skipping",
    );
    return;
  }
  const subscription = await prisma.subscription.findFirst({
    where: { dodoSubscriptionId: subscriptionId },
  });
  if (!subscription) {
    logger.error(
      { dodoSubscriptionId: subscriptionId },
      "[dodo] subscription.expired for unknown subscription id",
    );
    return;
  }
  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: "EXPIRED", endDate: new Date() },
  });
  logger.warn(
    { dodoSubscriptionId: subscriptionId, userId: subscription.userId },
    "[DODO WEBHOOK] Subscription EXPIRED (dunning exhausted)",
  );
  // MONEY-1134 — terminal revocation. The worst one to leave cached.
  await invalidateEntitlement(subscription.userId);
}
