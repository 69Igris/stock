/**
 * Subscription Service
 *
 * Subscription management, AI query consumption, and payment history.
 * Source: apps/web/lib/actions/subscription.ts
 */

import { prisma, PlanType as PrismaPlanType, Prisma } from "@usemoney/database";
import { invalidateEntitlement } from "./entitlement-invalidation";
import {
  PLAN_CONFIG,
  dodoClient,
  isDodoConfigured,
  resolvePlanId,
  getPlanCredits,
  type PlanId,
  type PlanConfig,
} from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
// Pure entitlement logic — SINGLE SOURCE OF TRUTH (no shadows). The service
// CALLS these so production access-control and tests run the same code.
import {
  isProEntitlementExpired as isProEntitlementExpiredLogic,
  isRecurringPlan as isRecurringPlanLogic,
  isExpired as isGraceExpiredLogic,
  isValidDate,
  resolveEntitlementPlan,
  calculateGracePeriodEndDate as calcGracePeriodEndDate,
  deriveNextBillingDate,
  is404PaymentError,
  get404PaymentErrorMessage,
  getPaymentRefreshUpdate,
  canUndoScheduledChange,
  buildProEntitlementFields,
  buildSubscriptionAccess,
  type EntitlementInput,
  type SubscriptionAccess,
} from "./subscription-logic";

// MONEY-866: re-export the pure entitlement helper so the web grant paths (Dodo
// webhook + payments callback) reach it via @usemoney/services.
export {
  buildProEntitlementFields,
  canUndoScheduledChange,
} from "./subscription-logic";
export type { ProEntitlementFields } from "./subscription-logic";

// MONEY-1062: subscription-access view. Extracted from
// apps/web/lib/subscription/access.ts — the web wrapper resolves Clerk → user;
// this reads the Subscription row and builds the (pure) access view. Re-export
// the view type + FREE default so the thin `access.ts` wrapper reaches them via
// @usemoney/services.
export { DEFAULT_FREE_ACCESS } from "./subscription-logic";
export type { SubscriptionAccess } from "./subscription-logic";

/**
 * Subscription access view for a resolved internal userId. Reads the row and
 * returns the (pure) access view built by `buildSubscriptionAccess`; a
 * missing / inactive / unknown-plan row resolves to `DEFAULT_FREE_ACCESS`
 * inside the builder. A DB failure is caught → ServiceResult error so the web
 * wrapper can fall back to FREE (the original fail-to-FREE posture).
 */

export async function getSubscriptionAccessForUser(
  userId: string,
): Promise<ServiceResult<SubscriptionAccess>> {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
    });
    return { success: true, data: buildSubscriptionAccess(subscription) };
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "Error getting subscription access",
    );
    return { success: false, error: "Failed to get subscription access" };
  }
}

// ── Types ──────────────────────────────────────────────────────────

export interface SubscriptionData {
  id: string;
  planId: string;
  billingPeriod?: string | null;
  status: string;
  startDate: string;
  endDate?: string;
  aiQueriesUsed: number;
  aiQueriesLimit: number;
  addons: string[];
  // Fast queries (legacy - use unified credits instead)
  fastQueriesUsed: number;
  fastQueriesLimit: number;
  // Advanced queries (legacy)
  advancedQueriesUsed: number;
  advancedQueriesLimit: number;
  // Query Pack (legacy)
  queryPackActive: boolean;
  queryPackFastQueriesUsed: number;
  queryPackFastQueriesLimit: number;
  queryPackAdvancedQueriesUsed: number;
  queryPackAdvancedQueriesLimit: number;
  queryPackStartDate?: string;
  queryPackEndDate?: string;
  // Unified credits
  creditsUsed: number;
  creditsLimit: number;
  creditsResetAt?: string | null;
  packCreditsUsed: number;
  packCreditsLimit: number;
  // PRO entitlement
  proEntitlementType?: string | null;
  proEntitlementStartDate?: string | null;
  proEntitlementEndDate?: string | null;
  // Billing
  nextBillingDate?: string | null;
  // MONEY-482: scheduled plan change (set when user queues a downgrade
  // or cancellation; cleared by the cron at effectiveAt or by Undo).
  scheduledPlanId?: string | null;
  scheduledBillingPeriod?: string | null;
  scheduledEffectiveAt?: string | null;
  // MONEY-865: true ONLY when the scheduled change is reversible — i.e. a real
  // renewing Dodo subscription exists to "keep". A coupon free-grant sets
  // scheduledPlanId="FREE" with NO dodoSubscriptionId; its term is fixed (the
  // auto-downgrade IS the grant's expiry), so the UI must not offer "Undo".
  scheduledChangeUndoable?: boolean;
}

export interface PaymentHistoryItem {
  id: string;
  planId: string;
  planName: string;
  amount: number;
  currency: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  period: string;
  // Invoice & payment method details
  invoiceUrl: string | null;
  paymentMethod: string | null;
  paymentMethodType: string | null;
  cardLastFour: string | null;
  cardNetwork: string | null;
}

// ── Constants ──────────────────────────────────────────────────────

/** Local plan limits (only used for legacy aiQueries/price fields) */
const PLANS: Record<
  string,
  { aiQueries: number; price: number; fastQueries: number }
> = {
  FREE: { aiQueries: 0, price: 0, fastQueries: 0 },
  PRO: { aiQueries: 20, price: 999, fastQueries: 20 },
  QUERY_PACK: { aiQueries: 200, price: 199, fastQueries: 200 },
  PREMIUM: { aiQueries: -1, price: 999, fastQueries: -1 },
};

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Get additional queries for QUERY_PACK based on user's plan.
 */
function getAddonQueries(planId: string): { fast: number; advanced: number } {
  const resolved = resolvePlanId(planId);
  if (resolved === "PRO") {
    return { fast: 200, advanced: 50 };
  } else if (resolved === "PREMIUM" || resolved === "ULTIMATE") {
    return { fast: 0, advanced: 200 };
  }
  return { fast: 0, advanced: 0 };
}

/**
 * Safely look up PLAN_CONFIG for a given planId string.
 * Supports legacy plan IDs via resolvePlanId.
 */
function getPlanConfigSafe(planId: string): PlanConfig | undefined {
  const resolved = resolvePlanId(planId);
  return PLAN_CONFIG[resolved];
}

/**
 * Invalid-Date-safe `.toISOString()`. A corrupt Date in the DB must never crash
 * the whole `getSubscription` serialization (which would fail-closed but also
 * deny a legitimately-active user). Returns `undefined` for null/invalid so the
 * field simply omits, matching the existing optional-string contract.
 */
function safeIso(date: Date | null | undefined): string | undefined {
  if (!isValidDate(date)) return undefined;
  return date.toISOString();
}

// ── PRO Entitlement Helpers ────────────────────────────────────────

/**
 * Check if a subscription's PRO entitlement has expired.
 * Lifetime: capped at 10 years from start.
 * Annual/Monthly: actual expiry date.
 */
export function isProEntitlementExpired(sub: {
  proEntitlementType?: string | null;
  proEntitlementStartDate?: Date | null;
  proEntitlementEndDate?: Date | null;
}): boolean {
  // Delegates to the pure logic (Invalid-Date-safe: a garbage entitlement
  // end-date counts as EXPIRED, never "never expires").
  return isProEntitlementExpiredLogic(sub);
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * Get or create subscription for a user.
 * Handles monthly reset for recurring plans, grace period expiry, and limit updates.
 */
export async function getSubscription(
  userId: string,
): Promise<ServiceResult<SubscriptionData>> {
  try {
    // Get subscription
    let subscription = await prisma.subscription.findUnique({
      where: { userId },
    });

    // Create default free subscription if none exists
    if (!subscription) {
      subscription = await prisma.subscription.create({
        data: {
          userId,
          planId: "FREE",
          status: "ACTIVE",
          aiQueriesUsed: 0,
          aiQueriesLimit: 0,
          addons: [],
          fastQueriesUsed: 0,
          fastQueriesLimit: 0,
          advancedQueriesUsed: 0,
          advancedQueriesLimit: 0,
          // Unified credits
          creditsUsed: 0,
          creditsLimit: 5, // FREE plan = 5 credits
          packCreditsUsed: 0,
          packCreditsLimit: 0,
        },
      });
    }

    // Check if queries need to be reset (monthly/annual reset for recurring plans)
    // Recurring plans: PREMIUM, ULTIMATE, and PRO with annual/monthly billing
    // One-time plans: FREE, PRO lifetime, QUERY_PACK (no reset)
    const isRecurringPlan = isRecurringPlanLogic(
      subscription.planId,
      subscription.billingPeriod,
    );

    // The rolling 30-day refill only runs for ACTIVE rows: a PAST_DUE /
    // EXPIRED / CANCELLED subscription must not keep receiving fresh plan
    // credits forever (the dunning statuses now depend on this gate).
    if (isRecurringPlan && subscription.status === "ACTIVE") {
      const now = new Date();
      // MONEY-866: a MISSING reset anchor (legacy row / coupon free-grant /
      // self-healed row — applyPlanGrant doesn't always set aiQueriesResetAt)
      // previously made this whole block skip, stranding a paying user at 0
      // credits forever. Treat a missing anchor as "due now" so the row gets a
      // fresh 30-day cycle + a seeded anchor; thereafter the normal now>resetDate
      // path runs and never loops (the seeded anchor is 30d in the future).
      const resetDate = subscription.aiQueriesResetAt
        ? new Date(subscription.aiQueriesResetAt)
        : null;

      // If reset date has passed (or is unset), reset queries
      if (!resetDate || now > resetDate) {
        await prisma.subscription.update({
          where: { userId },
          data: {
            fastQueriesUsed: 0,
            advancedQueriesUsed: 0,
            aiQueriesUsed: 0,
            // Unified credits reset
            creditsUsed: 0,
            creditsResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            aiQueriesResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            // Pack credits carry forward (no reset)
          },
        });
        // Reload subscription after reset
        subscription = await prisma.subscription.findUnique({
          where: { userId },
        });
      }
    }

    // Self-heal missing billing anchors (MONEY-764): rows granted while
    // webhooks were dead — or by the legacy callback — carry NO
    // nextBillingDate (Billing renders "RENEWS —" forever) and often a
    // legacy startDate+30d endDate that keeps ticking toward a WRONGFUL
    // grace-expiry collapse even though Dodo auto-renewed the subscription.
    // Reconcile once against Dodo (the billing authority) BEFORE the grace
    // check below: recover the subscription id from recent completed
    // payments when the row never stored it, then persist the authoritative
    // next_billing_date. Best-effort — a Dodo outage must never break the
    // read path; once anchored this never re-runs.
    if (
      subscription &&
      subscription.status === "ACTIVE" &&
      !subscription.nextBillingDate &&
      resolvePlanId(subscription.planId) !== "FREE" &&
      isRecurringPlanLogic(subscription.planId, subscription.billingPeriod) &&
      isDodoConfigured()
    ) {
      try {
        let dodoSubId = subscription.dodoSubscriptionId;
        if (!dodoSubId) {
          // Legacy rows: recover the subscription id via recent completed
          // payments. No dodoPaymentId WHERE filter — `not: null` on this
          // Mongo schema is the unset-vs-null trap; skip in code instead.
          const recentPaid = await prisma.payment.findMany({
            where: { userId, status: "COMPLETED" },
            orderBy: { createdAt: "desc" },
            take: 8,
            select: { dodoPaymentId: true },
          });
          for (const paid of recentPaid) {
            if (!paid.dodoPaymentId) continue;
            const dodoPayment = (await dodoClient.payments.retrieve(
              paid.dodoPaymentId,
            )) as { subscription_id?: string | null } | null;
            // Pack purchases are one-time payments — no subscription_id.
            if (dodoPayment?.subscription_id) {
              dodoSubId = dodoPayment.subscription_id;
              break;
            }
          }
        }
        if (dodoSubId) {
          const dodoSub = (await dodoClient.subscriptions.retrieve(
            dodoSubId,
          )) as { status?: string; next_billing_date?: string | null } | null;
          const nextBilling = dodoSub?.next_billing_date
            ? new Date(dodoSub.next_billing_date)
            : null;
          if (dodoSub?.status === "active" && isValidDate(nextBilling)) {
            await prisma.subscription.update({
              where: { userId },
              data: {
                dodoSubscriptionId: dodoSubId,
                nextBillingDate: nextBilling,
                // A live Dodo billing cycle means the legacy +30d endDate is
                // stale — clear it so the grace check below can't collapse a
                // genuinely auto-renewing subscription to FREE.
                endDate: null,
              },
            });
            logger.info(
              { userId, dodoSubId, nextBilling },
              "Self-healed missing billing anchors from Dodo",
            );
            subscription = await prisma.subscription.findUnique({
              where: { userId },
            });
          }
        }
      } catch (anchorErr) {
        logger.warn(
          { error: anchorErr, userId, action: "getSubscription" },
          "Billing-anchor self-heal failed (non-fatal)",
        );
      }
    }

    // Auto-heal: if endDate and nextBillingDate are both set, the user
    // upgraded after a downgrade but endDate wasn't cleared (stale data).
    // Clear endDate since an active billing cycle means no grace period.
    if (
      subscription &&
      subscription.endDate &&
      subscription.nextBillingDate &&
      subscription.status === "ACTIVE"
    ) {
      logger.info(
        {
          userId,
          endDate: subscription.endDate,
          nextBillingDate: subscription.nextBillingDate,
        },
        "Auto-healing stale endDate (active billing cycle exists)",
      );
      await prisma.subscription.update({
        where: { userId },
        data: { endDate: null },
      });
      subscription = await prisma.subscription.findUnique({
        where: { userId },
      });
    }

    // Check if subscription with grace period has expired.
    // The expiry classification + fall-back-vs-downgrade decision is delegated
    // to the pure logic (`resolveEntitlementPlan`) so production runs the SAME
    // Invalid-Date-safe code the tests assert. CRITICAL: a garbage `endDate`
    // now classifies as EXPIRED instead of silently "never expires".
    const resolvedForGrace = subscription
      ? resolvePlanId(subscription.planId)
      : "FREE";
    if (
      subscription &&
      subscription.status === "ACTIVE" &&
      subscription.endDate &&
      (resolvedForGrace === "PRO" ||
        resolvedForGrace === "PREMIUM" ||
        resolvedForGrace === "ULTIMATE")
    ) {
      const now = new Date();
      const graceExpired = isGraceExpiredLogic(subscription.endDate, now);

      if (graceExpired) {
        const entitlement = resolveEntitlementPlan(
          subscription as EntitlementInput,
          now,
        );
        // Grace period expired - check if user has valid PRO entitlement to fall back to
        if (entitlement.reason === "grace-expired-to-pro") {
          // Fall back to PRO instead of FREE
          const proPlanConfig = getPlanConfigSafe("PRO");
          await prisma.subscription.update({
            where: { userId },
            data: {
              planId: "PRO",
              status: "ACTIVE",
              billingPeriod:
                subscription.proEntitlementType === "lifetime"
                  ? null
                  : subscription.proEntitlementType,
              endDate:
                subscription.proEntitlementType === "lifetime"
                  ? null
                  : subscription.proEntitlementEndDate,
              aiQueriesUsed: 0,
              aiQueriesLimit: 20,
              fastQueriesUsed: 0,
              fastQueriesLimit: proPlanConfig?.fastQueries ?? 20,
              advancedQueriesUsed: 0,
              advancedQueriesLimit: proPlanConfig?.advancedQueries ?? 5,
            },
          });

          logger.info(
            { userId },
            "Subscription fell back to PRO after grace period (entitlement preserved)",
          );
        } else {
          // No PRO entitlement - downgrade to FREE
          await prisma.subscription.update({
            where: { userId },
            data: {
              planId: "FREE",
              status: "EXPIRED",
              billingPeriod: null,
              // Clear the (now-spent, possibly Invalid-Date) grace endDate so a
              // FREE/EXPIRED row carries no stale expiry and serialization can
              // never `.toISOString()` an Invalid Date. Keeps self-heal idempotent.
              endDate: null,
              aiQueriesUsed: 0,
              aiQueriesLimit: 0,
              fastQueriesUsed: 0,
              fastQueriesLimit: 0,
              advancedQueriesUsed: 0,
              advancedQueriesLimit: 0,
              addons: [],
              // Unified credits
              creditsUsed: 0,
              creditsLimit: 5, // FREE = 5 credits
            },
          });

          logger.info({ userId }, "Subscription expired after grace period");
        }

        // Reload subscription after expiration
        subscription = await prisma.subscription.findUnique({
          where: { userId },
        });
      }
    }

    // The FREE-level view a PAST_DUE (mid-dunning) paid row is gated to in the
    // RESPONSE (J-F1) — the stored row is never rewritten. Declared ONCE and
    // shared by the gate below AND the post-usage-init re-apply so the two
    // sites can't drift (MONEY-1062 Round C).
    const pastDueGateFields = {
      planId: "FREE",
      status: "EXPIRED",
      billingPeriod: null,
      endDate: null,
      aiQueriesLimit: 0,
      fastQueriesLimit: 0,
      advancedQueriesLimit: 0,
      creditsLimit: 5,
    } as const;
    let pastDueGated = false;

    // Defensive self-heal (entitlement-bypass guard): a row whose stored plan is
    // a PAID tier but whose EFFECTIVE entitlement is FREE — e.g. a non-ACTIVE
    // (EXPIRED / CANCELLED / PAST_DUE) row that still says PREMIUM, or an
    // unknown/corrupt planId — must NOT keep reporting the paid plan to callers
    // (apps/api mobile + createCheckoutAction gate on planId). Collapse it to
    // FREE deterministically. Idempotent: a row already at FREE never re-enters.
    if (subscription) {
      const effective = resolveEntitlementPlan(
        subscription as EntitlementInput,
        new Date(),
      );
      const storedResolved = resolvePlanId(subscription.planId);
      if (storedResolved !== "FREE" && effective.plan === "FREE") {
        if (subscription.status === "PAST_DUE") {
          // MONEY-1062 (J-F1): a PAST_DUE row is mid-Dodo-dunning — DO NOT rewrite
          // it. Gate the RESPONSE to the same FREE-level view the destructive
          // collapse would have produced, but leave planId/billingPeriod/status
          // INTACT in the DB so the retry's subscription.active (PAST_DUE→ACTIVE)
          // + subscription.renewed restore the plan with no data loss. The
          // destructive rewrite bricked dunning recovery: storeDodoActivationAnchors
          // only revives status===PAST_DUE and applyDodoRenewal skips FREE rows, so
          // the user would keep being billed on Dodo while entitled FREE.
          pastDueGated = true;
          subscription = { ...subscription, ...pastDueGateFields };
          logger.info(
            { userId, from: storedResolved, reason: effective.reason },
            "PAST_DUE row gated to FREE-level entitlement in response (row preserved for dunning recovery)",
          );
        } else {
          await prisma.subscription.update({
            where: { userId },
            data: {
              planId: "FREE",
              status: "EXPIRED",
              billingPeriod: null,
              endDate: null,
              aiQueriesLimit: 0,
              fastQueriesLimit: 0,
              advancedQueriesLimit: 0,
              creditsLimit: 5,
            },
          });
          logger.info(
            { userId, from: storedResolved, reason: effective.reason },
            "Self-healed stale paid subscription to FREE (entitlement collapsed)",
          );
          subscription = await prisma.subscription.findUnique({
            where: { userId },
          });
        }
      }
    }

    // Ensure limits and usage fields are set correctly in database if they're 0 or missing
    if (subscription) {
      const planConfig = getPlanConfigSafe(subscription.planId);
      const needsLimitUpdate =
        planConfig &&
        ((subscription.fastQueriesLimit === 0 && planConfig.fastQueries > 0) ||
          (subscription.advancedQueriesLimit === 0 &&
            planConfig.advancedQueries > 0) ||
          // Heal-up stale credit allowances: rows written before a plan's
          // credit grant existed keep the FREE default forever (live case:
          // PRO-Lifetime showing 5/mo instead of the plan's 50/mo).
          (typeof planConfig.credits === "number" &&
            (subscription.creditsLimit ?? 0) < planConfig.credits));

      const needsUsageInit =
        subscription.fastQueriesUsed === null ||
        subscription.advancedQueriesUsed === null ||
        subscription.queryPackFastQueriesUsed === null ||
        subscription.queryPackAdvancedQueriesUsed === null;

      if (needsLimitUpdate || needsUsageInit) {
        const updateData: Prisma.SubscriptionUpdateInput = {};

        // Update limits if needed
        if (needsLimitUpdate && planConfig) {
          updateData.fastQueriesLimit =
            planConfig.fastQueries ?? subscription.fastQueriesLimit ?? 0;
          updateData.advancedQueriesLimit =
            planConfig.advancedQueries ??
            subscription.advancedQueriesLimit ??
            0;
          if (
            typeof planConfig.credits === "number" &&
            (subscription.creditsLimit ?? 0) < planConfig.credits
          ) {
            updateData.creditsLimit = planConfig.credits;
          }
        }

        // Initialize usage fields to 0 if they're null
        if (subscription.fastQueriesUsed === null)
          updateData.fastQueriesUsed = 0;
        if (subscription.advancedQueriesUsed === null)
          updateData.advancedQueriesUsed = 0;
        if (subscription.queryPackFastQueriesUsed === null)
          updateData.queryPackFastQueriesUsed = 0;
        if (subscription.queryPackAdvancedQueriesUsed === null)
          updateData.queryPackAdvancedQueriesUsed = 0;

        await prisma.subscription.update({
          where: { userId },
          data: updateData,
        });

        // Reload subscription after update
        subscription = await prisma.subscription.findUnique({
          where: { userId },
        });
        // MONEY-1062 (Round C): the reload above re-reads the RAW row. If this
        // call gated a PAST_DUE row to the FREE-level view (J-F1), re-apply the
        // gate — otherwise a legacy row with null usage fields (needsUsageInit)
        // would leak the paid planId + limits mid-dunning through this reload.
        // The init write itself correctly targeted the raw row (zeros persist).
        if (subscription && pastDueGated) {
          subscription = { ...subscription, ...pastDueGateFields };
        }
      }
    }

    // Get plan config for return values
    if (!subscription) {
      return { success: false, error: "Failed to load subscription" };
    }

    const finalPlanConfig = getPlanConfigSafe(subscription.planId);

    return {
      success: true,
      data: {
        id: subscription.id,
        planId: subscription.planId,
        billingPeriod: subscription.billingPeriod,
        status: subscription.status,
        // Invalid-Date-safe serialization throughout (a corrupt Date must not
        // crash the whole call and deny a legitimately-active user).
        startDate: safeIso(subscription.startDate) ?? new Date(0).toISOString(),
        endDate: safeIso(subscription.endDate),
        aiQueriesUsed: subscription.aiQueriesUsed,
        aiQueriesLimit: subscription.aiQueriesLimit,
        addons: subscription.addons,
        fastQueriesUsed: subscription.fastQueriesUsed ?? 0,
        fastQueriesLimit:
          subscription.fastQueriesLimit ?? finalPlanConfig?.fastQueries ?? 0,
        advancedQueriesUsed: subscription.advancedQueriesUsed ?? 0,
        advancedQueriesLimit:
          subscription.advancedQueriesLimit ??
          finalPlanConfig?.advancedQueries ??
          0,
        queryPackActive: subscription.queryPackActive ?? false,
        queryPackFastQueriesUsed: subscription.queryPackFastQueriesUsed ?? 0,
        queryPackFastQueriesLimit: subscription.queryPackFastQueriesLimit ?? 0,
        queryPackAdvancedQueriesUsed:
          subscription.queryPackAdvancedQueriesUsed ?? 0,
        queryPackAdvancedQueriesLimit:
          subscription.queryPackAdvancedQueriesLimit ?? 0,
        queryPackStartDate: safeIso(subscription.queryPackStartDate),
        queryPackEndDate: safeIso(subscription.queryPackEndDate),
        // Unified credits
        creditsUsed: subscription.creditsUsed ?? 0,
        creditsLimit:
          subscription.creditsLimit ?? getPlanCredits(subscription.planId),
        creditsResetAt: safeIso(subscription.creditsResetAt) ?? null,
        packCreditsUsed: subscription.packCreditsUsed ?? 0,
        packCreditsLimit: subscription.packCreditsLimit ?? 0,
        // PRO entitlement
        proEntitlementType: subscription.proEntitlementType ?? null,
        proEntitlementStartDate:
          safeIso(subscription.proEntitlementStartDate) ?? null,
        proEntitlementEndDate:
          safeIso(subscription.proEntitlementEndDate) ?? null,
        // Billing — display fallback when the Dodo anchor heal couldn't run
        // (offline / unconfigured): derive from the term start so an active
        // recurring plan never renders "RENEWS —". Derived dates are never
        // persisted; the DB anchor stays Dodo-authoritative.
        nextBillingDate:
          safeIso(subscription.nextBillingDate) ??
          safeIso(
            deriveNextBillingDate(
              subscription.planId,
              subscription.billingPeriod,
              subscription.startDate,
            ),
          ) ??
          null,
        // MONEY-482 scheduled-change fields
        scheduledPlanId: subscription.scheduledPlanId ?? null,
        scheduledBillingPeriod: subscription.scheduledBillingPeriod ?? null,
        scheduledEffectiveAt:
          safeIso(subscription.scheduledEffectiveAt) ?? null,
        // MONEY-865: only a renewing paid sub (has a Dodo subscription) can be
        // kept via Undo. A coupon free-grant has none → fixed term, not undoable.
        scheduledChangeUndoable: canUndoScheduledChange(
          subscription.scheduledPlanId,
          subscription.dodoSubscriptionId,
        ),
      },
    };
  } catch (error) {
    logger.error(
      { error, userId, action: "getSubscription" },
      "Get subscription error",
    );
    return { success: false, error: "Failed to fetch subscription" };
  }
}

/**
 * Update subscription after successful payment.
 * Can change the main plan or add an addon (query pack).
 */
export async function updateSubscriptionPlan(
  userId: string,
  planId: string,
  addAddon = false,
  billingPeriod?: string,
): Promise<ServiceResult<void>> {
  try {
    const resolved = resolvePlanId(planId);
    const plan = PLANS[resolved];
    if (!plan) {
      return { success: false, error: "Invalid plan" };
    }

    const subscription = await prisma.subscription.findUnique({
      where: { userId },
    });

    if (addAddon && subscription) {
      // Adding an addon - check plan type to determine query amount
      const additionalQueries = getAddonQueries(subscription.planId);
      if (additionalQueries.fast === 0 && additionalQueries.advanced === 0) {
        return {
          success: false,
          error: "AI Query Pack requires Pro or Premium plan",
        };
      }

      // Check if query pack already exists - if so, carry forward remaining queries
      const existingFastRemaining = Math.max(
        0,
        (subscription.queryPackFastQueriesLimit ?? 0) -
          (subscription.queryPackFastQueriesUsed ?? 0),
      );
      const existingAdvancedRemaining = Math.max(
        0,
        (subscription.queryPackAdvancedQueriesLimit ?? 0) -
          (subscription.queryPackAdvancedQueriesUsed ?? 0),
      );

      // Add new queries to remaining ones if plan is still active
      const newFastLimit =
        subscription.status === "ACTIVE"
          ? existingFastRemaining + additionalQueries.fast
          : additionalQueries.fast;
      const newAdvancedLimit =
        subscription.status === "ACTIVE"
          ? existingAdvancedRemaining + additionalQueries.advanced
          : additionalQueries.advanced;

      // Determine credit pack size from planId metadata or default
      let packCredits = additionalQueries.fast; // Legacy: use fast query count
      // For new CREDIT_PACK_* purchases, extract credit count from planId
      if (planId.startsWith("CREDIT_PACK_")) {
        packCredits = parseInt(planId.replace("CREDIT_PACK_", ""), 10) || 50;
      }

      // Update both legacy (queryPack*) and new (packCredits*) systems
      const existingPackCredits = subscription.packCreditsLimit ?? 0;
      const existingPackUsed = subscription.packCreditsUsed ?? 0;
      const newPackCreditsLimit =
        existingPackCredits - existingPackUsed + packCredits;

      await prisma.subscription.update({
        where: { userId },
        data: {
          addons: { push: planId },
          queryPackActive: true,
          queryPackFastQueriesLimit: newFastLimit,
          queryPackFastQueriesUsed: 0,
          queryPackAdvancedQueriesLimit: newAdvancedLimit,
          queryPackAdvancedQueriesUsed: 0,
          queryPackStartDate: new Date(),
          queryPackEndDate:
            subscription.status === "ACTIVE" && subscription.endDate
              ? subscription.endDate
              : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          // Unified credit system - add pack credits (never expire)
          packCreditsLimit: newPackCreditsLimit,
          packCreditsUsed: 0,
        },
      });
    } else {
      // Changing main plan
      // endDate is ONLY set by downgradeWithGracePeriod(), never on purchase/upgrade
      const endDate = null;

      const planConfig = getPlanConfigSafe(planId);

      // Check if plan is actually changing
      const isPlanChanging = !subscription || subscription.planId !== planId;

      // MONEY-866: PRO-entitlement fields (shared builder) — changePlan upgrades
      // and coupon grants route through here and previously wrote NO entitlement,
      // dropping the PRO downgrade anchor. PRO sets it from the billing period; a
      // higher tier preserves the existing PRO entitlement.
      const proEntitlementFields = buildProEntitlementFields({
        resolvedPlan: resolved,
        period: billingPeriod,
        now: new Date(),
        existing: subscription,
      });

      // Prepare update data
      const updateData: Prisma.SubscriptionUpdateInput = {
        planId: resolved as PrismaPlanType,
        billingPeriod: billingPeriod || null,
        status: "ACTIVE",
        endDate,
        ...proEntitlementFields,
        // MONEY-872: a fresh plan grant (in-place upgrade or coupon grant)
        // SUPERSEDES any pending schedule — clear it, exactly as the webhook /
        // callback upserts do. Without this, an upgrade that FOLLOWED a scheduled
        // downgrade/cancel kept the stale scheduledPlanId/effectiveAt, and the
        // hourly cron then dropped the freshly-upgraded plan to FREE within the
        // hour. (Coupon grants re-apply their own auto-downgrade AFTER this call.)
        scheduledPlanId: null,
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: null,
        cancelledAt: null,
      };

      if (isPlanChanging) {
        // Plan is changing - reset everything
        updateData.startDate = new Date();
        updateData.aiQueriesUsed = 0;
        updateData.aiQueriesLimit = plan.aiQueries;
        updateData.aiQueriesResetAt = new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        );
        updateData.fastQueriesUsed = 0;
        updateData.fastQueriesLimit = planConfig?.fastQueries ?? 0;
        updateData.advancedQueriesUsed = 0;
        updateData.advancedQueriesLimit = planConfig?.advancedQueries ?? 0;
        // Unified credits
        updateData.creditsUsed = 0;
        updateData.creditsLimit = planConfig?.credits ?? 5;
        updateData.creditsResetAt = new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        );
      } else if (subscription) {
        // Plan is not changing - only update limits if needed, keep usage
        updateData.startDate = subscription.startDate;
        updateData.fastQueriesLimit =
          planConfig?.fastQueries ?? subscription.fastQueriesLimit ?? 0;
        updateData.advancedQueriesLimit =
          planConfig?.advancedQueries ?? subscription.advancedQueriesLimit ?? 0;
        // Update unified credit limit (keep usage)
        updateData.creditsLimit =
          planConfig?.credits ?? subscription.creditsLimit ?? 5;
      }

      await prisma.subscription.upsert({
        where: { userId },
        update: updateData,
        create: {
          userId,
          planId: resolved as PrismaPlanType,
          billingPeriod:
            resolved === "PREMIUM" ||
            resolved === "ULTIMATE" ||
            resolved === "PRO"
              ? billingPeriod
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
          // Unified credits
          creditsUsed: 0,
          creditsLimit: planConfig?.credits ?? 5,
          creditsResetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          packCreditsUsed: 0,
          packCreditsLimit: 0,
          ...proEntitlementFields,
        },
      });
    }

    await invalidateEntitlement(userId);
    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, planId, action: "updateSubscriptionPlan" },
      "Update subscription plan error",
    );
    return { success: false, error: "Failed to update subscription plan" };
  }
}

/**
 * Consume a fast or advanced AI query from plan or query pack.
 * Returns the number of remaining queries.
 *
 * NOTE: Does NOT send email notifications when queries are exhausted.
 * Email sending stays in the action layer.
 */
export async function consumeAIQuery(
  userId: string,
  queryType: "fast" | "advanced" = "fast",
): Promise<ServiceResult<{ remaining: number }>> {
  try {
    let subscription = await prisma.subscription.findUnique({
      where: { userId },
    });

    if (!subscription) {
      return { success: false, error: "No subscription found" };
    }

    // Check if plan is active - addon packs can only be used with active Pro/Premium plans
    if (subscription.status !== "ACTIVE") {
      return {
        success: false,
        error:
          "Please activate your Pro or Premium plan to use AI queries. Your addon pack credits are safe and will be available when you activate your plan.",
      };
    }

    // Check if plan is FREE - even with addon pack, FREE plan cannot use queries
    if (subscription.planId === "FREE") {
      return {
        success: false,
        error:
          "Please upgrade to Pro or Premium plan to use AI queries. Your addon pack credits will be available after upgrading.",
      };
    }

    // Initialize usage fields to 0 if they're null (critical for increment operations)
    const needsInit =
      subscription.fastQueriesUsed === null ||
      subscription.advancedQueriesUsed === null ||
      subscription.queryPackFastQueriesUsed === null ||
      subscription.queryPackAdvancedQueriesUsed === null;

    if (needsInit) {
      const initData: Prisma.SubscriptionUpdateInput = {};
      if (subscription.fastQueriesUsed === null) initData.fastQueriesUsed = 0;
      if (subscription.advancedQueriesUsed === null)
        initData.advancedQueriesUsed = 0;
      if (subscription.queryPackFastQueriesUsed === null)
        initData.queryPackFastQueriesUsed = 0;
      if (subscription.queryPackAdvancedQueriesUsed === null)
        initData.queryPackAdvancedQueriesUsed = 0;

      subscription = await prisma.subscription.update({
        where: { userId },
        data: initData,
      });
    }

    if (queryType === "advanced") {
      return consumeAdvancedQuery(userId, subscription);
    } else {
      return consumeFastQuery(userId, subscription);
    }
  } catch (error) {
    logger.error(
      { error, userId, queryType, action: "consumeAIQuery" },
      "Consume AI query error",
    );
    return { success: false, error: "Failed to consume AI query" };
  }
}

/**
 * Consume an advanced query from plan or query pack.
 * Internal helper for consumeAIQuery.
 */
async function consumeAdvancedQuery(
  userId: string,
  subscription: NonNullable<
    Awaited<ReturnType<typeof prisma.subscription.findUnique>>
  >,
): Promise<ServiceResult<{ remaining: number }>> {
  const planConfig = getPlanConfigSafe(subscription.planId);
  const advancedLimit = planConfig?.advancedQueries ?? 0;

  // Unlimited advanced queries
  if (advancedLimit === -1) {
    await prisma.subscription.update({
      where: { userId },
      data: { advancedQueriesUsed: { increment: 1 } },
    });
    return { success: true, data: { remaining: Infinity } };
  }

  // Check plan advanced queries first
  const advancedUsed = subscription.advancedQueriesUsed ?? 0;

  if (advancedUsed < advancedLimit) {
    // Use plan queries - Set explicit value instead of increment
    const updated = await prisma.subscription.update({
      where: { userId },
      data: { advancedQueriesUsed: advancedUsed + 1 },
    });

    return {
      success: true,
      data: {
        remaining: advancedLimit - (updated.advancedQueriesUsed ?? 0),
      },
    };
  }

  // Plan queries exhausted, check query pack if active
  if (subscription.queryPackActive) {
    const packAdvancedUsed = subscription.queryPackAdvancedQueriesUsed ?? 0;
    const packAdvancedLimit = subscription.queryPackAdvancedQueriesLimit ?? 0;

    if (packAdvancedUsed < packAdvancedLimit) {
      const updated = await prisma.subscription.update({
        where: { userId },
        data: {
          queryPackAdvancedQueriesUsed: packAdvancedUsed + 1,
        },
      });
      return {
        success: true,
        data: {
          remaining:
            packAdvancedLimit - (updated.queryPackAdvancedQueriesUsed ?? 0),
        },
      };
    }
  }

  // Both plan and pack queries exhausted
  return {
    success: false,
    error: "No advanced queries remaining",
    code: "QUERIES_EXHAUSTED",
  };
}

/**
 * Consume a fast query from plan or query pack.
 * Internal helper for consumeAIQuery.
 */
async function consumeFastQuery(
  userId: string,
  subscription: NonNullable<
    Awaited<ReturnType<typeof prisma.subscription.findUnique>>
  >,
): Promise<ServiceResult<{ remaining: number }>> {
  const planConfig = getPlanConfigSafe(subscription.planId);
  const fastLimit = planConfig?.fastQueries ?? 0;

  // Unlimited fast queries
  if (fastLimit === -1) {
    await prisma.subscription.update({
      where: { userId },
      data: { fastQueriesUsed: { increment: 1 } },
    });
    return { success: true, data: { remaining: Infinity } };
  }

  // Check plan fast queries first
  const fastUsed = subscription.fastQueriesUsed ?? 0;

  if (fastUsed < fastLimit) {
    // Use plan queries - Set explicit value instead of increment
    const updated = await prisma.subscription.update({
      where: { userId },
      data: { fastQueriesUsed: fastUsed + 1 },
    });

    return {
      success: true,
      data: {
        remaining: fastLimit - (updated.fastQueriesUsed ?? 0),
      },
    };
  }

  // Plan queries exhausted, check query pack if active
  if (subscription.queryPackActive) {
    const packFastUsed = subscription.queryPackFastQueriesUsed ?? 0;
    const packFastLimit = subscription.queryPackFastQueriesLimit ?? 0;

    if (packFastUsed < packFastLimit) {
      const updated = await prisma.subscription.update({
        where: { userId },
        data: { queryPackFastQueriesUsed: packFastUsed + 1 },
      });
      return {
        success: true,
        data: {
          remaining: packFastLimit - (updated.queryPackFastQueriesUsed ?? 0),
        },
      };
    }
  }

  // Both plan and pack queries exhausted
  return {
    success: false,
    error: "No fast queries remaining",
    code: "QUERIES_EXHAUSTED",
  };
}

/**
 * Cancel subscription (sets status to CANCELLED).
 */
export async function cancelSubscription(
  userId: string,
): Promise<ServiceResult<void>> {
  try {
    // Policy: a cancelled account stays ACTIVE until the paid term ends.
    // Stop Dodo auto-renew now, stamp the scheduled drop to FREE at the
    // term boundary (the apply-scheduled-plan-changes cron flips it), and
    // record cancelledAt. Previously this set status=CANCELLED immediately
    // — entitlement collapsed on the spot while Dodo (never told) kept
    // billing the card.
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    if (!sub) {
      // MONEY-1062 (H8): tag NOT_FOUND so the API layer can map this to 404
      // instead of a generic 500. (Route mapping is owned by apps/api.)
      return {
        success: false,
        error: "No subscription found",
        code: "NOT_FOUND",
      };
    }

    if (sub.dodoSubscriptionId) {
      try {
        await dodoClient.subscriptions.update(sub.dodoSubscriptionId, {
          cancel_at_next_billing_date: true,
        });
      } catch (dodoErr) {
        logger.error(
          { error: dodoErr, userId, action: "cancelSubscription" },
          "Dodo cancel_at_next_billing_date failed (local schedule still set)",
        );
      }
    }

    // First-cycle rows fulfilled by the webhook can have neither endDate
    // nor nextBillingDate — derive the term end from startDate + period
    // rather than cutting the paid term short.
    const derivedEnd = sub.startDate
      ? new Date(
          sub.startDate.getTime() +
            (sub.billingPeriod === "annual" ? 365 : 30) * 24 * 60 * 60 * 1000,
        )
      : new Date();
    const effectiveAt = sub.endDate ?? sub.nextBillingDate ?? derivedEnd;

    await prisma.subscription.update({
      where: { userId },
      data: {
        cancelledAt: new Date(),
        scheduledPlanId: "FREE",
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: effectiveAt,
      },
    });

    await invalidateEntitlement(userId);
    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, action: "cancelSubscription" },
      "Cancel subscription error",
    );
    return { success: false, error: "Failed to cancel subscription" };
  }
}

/**
 * Downgrade subscription with grace period calculation.
 * PRO: 1 year from start. PREMIUM monthly: 1 month from start.
 * PREMIUM annual: 1 year from start. FREE/other: immediate downgrade.
 */
export async function downgradeWithGracePeriod(
  userId: string,
): Promise<ServiceResult<{ gracePeriodEndDate?: string }>> {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
    });

    if (!subscription || subscription.status !== "ACTIVE") {
      return { success: false, error: "No active subscription found" };
    }

    const resolvedDowngrade = resolvePlanId(subscription.planId);

    // Handle PREMIUM/ULTIMATE downgrade - check for PRO entitlement fallback
    if (resolvedDowngrade === "PREMIUM" || resolvedDowngrade === "ULTIMATE") {
      if (
        subscription.proEntitlementType &&
        !isProEntitlementExpired(subscription)
      ) {
        // User has valid PRO entitlement - fall back to PRO immediately
        const proPlanConfig = getPlanConfigSafe("PRO");
        const proEndDate =
          subscription.proEntitlementType === "lifetime"
            ? null
            : subscription.proEntitlementEndDate;

        await prisma.subscription.update({
          where: { userId },
          data: {
            planId: "PRO",
            status: "ACTIVE",
            billingPeriod:
              subscription.proEntitlementType === "lifetime"
                ? null
                : subscription.proEntitlementType,
            endDate: proEndDate,
            aiQueriesUsed: 0,
            aiQueriesLimit: 20,
            fastQueriesUsed: 0,
            fastQueriesLimit: proPlanConfig?.fastQueries ?? 20,
            advancedQueriesUsed: 0,
            advancedQueriesLimit: proPlanConfig?.advancedQueries ?? 5,
          },
        });

        logger.info(
          { userId, proEntitlementType: subscription.proEntitlementType },
          "Downgraded PREMIUM/ULTIMATE to PRO (entitlement preserved)",
        );

        return {
          success: true,
          data: {
            gracePeriodEndDate: proEndDate?.toISOString(),
          },
        };
      }

      // No PRO entitlement - standard grace period (shared, tested date math).
      const gracePeriodEndDate =
        calcGracePeriodEndDate(
          resolvedDowngrade,
          subscription.billingPeriod,
          subscription.startDate,
        ) ?? new Date(subscription.startDate);

      await prisma.subscription.update({
        where: { userId },
        data: { endDate: gracePeriodEndDate },
      });

      logger.info(
        { userId, endDate: gracePeriodEndDate },
        "PREMIUM/ULTIMATE downgrade scheduled with grace period",
      );

      return {
        success: true,
        data: { gracePeriodEndDate: gracePeriodEndDate.toISOString() },
      };
    }

    // Handle PRO downgrade
    if (resolvedDowngrade === "PRO") {
      let gracePeriodEndDate: Date;

      if (subscription.proEntitlementType === "lifetime") {
        // Lifetime: 10 years from start
        gracePeriodEndDate = new Date(
          subscription.proEntitlementStartDate ?? subscription.startDate,
        );
        gracePeriodEndDate.setFullYear(gracePeriodEndDate.getFullYear() + 10);
      } else if (
        subscription.proEntitlementType === "annual" &&
        subscription.proEntitlementEndDate
      ) {
        gracePeriodEndDate = new Date(subscription.proEntitlementEndDate);
      } else if (
        subscription.proEntitlementType === "monthly" &&
        subscription.proEntitlementEndDate
      ) {
        gracePeriodEndDate = new Date(subscription.proEntitlementEndDate);
      } else {
        // Legacy PRO (no entitlement fields) - 1 year from start (shared math).
        gracePeriodEndDate =
          calcGracePeriodEndDate("PRO", null, subscription.startDate) ??
          new Date(subscription.startDate);
      }

      await prisma.subscription.update({
        where: { userId },
        data: { endDate: gracePeriodEndDate },
      });

      logger.info(
        { userId, endDate: gracePeriodEndDate },
        "PRO downgrade scheduled with grace period",
      );

      return {
        success: true,
        data: { gracePeriodEndDate: gracePeriodEndDate.toISOString() },
      };
    }

    // FREE or other: No grace period, immediate downgrade
    await prisma.subscription.update({
      where: { userId },
      data: {
        planId: "FREE",
        status: "ACTIVE",
        billingPeriod: null,
        aiQueriesUsed: 0,
        aiQueriesLimit: 0,
        addons: [],
        endDate: null,
        fastQueriesUsed: 0,
        fastQueriesLimit: 0,
        advancedQueriesUsed: 0,
        advancedQueriesLimit: 0,
        // Unified credits
        creditsUsed: 0,
        creditsLimit: 5,
      },
    });
    await invalidateEntitlement(userId);
    return { success: true, data: {} };
  } catch (error) {
    logger.error(
      { error, userId, action: "downgradeWithGracePeriod" },
      "Downgrade with grace period error",
    );
    return { success: false, error: "Failed to downgrade subscription" };
  }
}

/**
 * Refund a consumed query (when an API call fails after consumption).
 * Matches the consumption order: plan first, then query pack.
 */
export async function refundAIQuery(
  userId: string,
  queryType: "fast" | "advanced" = "fast",
): Promise<ServiceResult<void>> {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
    });

    if (!subscription) {
      return { success: false, error: "No subscription found" };
    }

    if (queryType === "advanced") {
      // Refund advanced query
      // IMPORTANT: Refund logic must match consumption logic order (plan first, then pack)
      const planConfig = getPlanConfigSafe(subscription.planId);
      const advancedLimit = planConfig?.advancedQueries ?? 0;
      const advancedUsed = subscription.advancedQueriesUsed ?? 0;
      const packAdvancedUsed = subscription.queryPackAdvancedQueriesUsed ?? 0;

      // Check which pool was used based on consumption order (plan first)
      if (advancedUsed > 0 && advancedUsed <= advancedLimit) {
        // Plan was used (plan wasn't exhausted yet)
        await prisma.subscription.update({
          where: { userId },
          data: { advancedQueriesUsed: Math.max(0, advancedUsed - 1) },
        });
        logger.info({ userId, queryType }, "Query refunded after API failure");
      } else if (packAdvancedUsed > 0 && subscription.queryPackActive) {
        // Pack was used (plan was already exhausted)
        await prisma.subscription.update({
          where: { userId },
          data: {
            queryPackAdvancedQueriesUsed: Math.max(0, packAdvancedUsed - 1),
          },
        });
        logger.info({ userId, queryType }, "Query refunded after API failure");
      }
    } else {
      // Refund fast query
      // IMPORTANT: Refund logic must match consumption logic order (plan first, then pack)
      const planConfig = getPlanConfigSafe(subscription.planId);
      const fastLimit = planConfig?.fastQueries ?? 0;
      const fastUsed = subscription.fastQueriesUsed ?? 0;
      const packFastUsed = subscription.queryPackFastQueriesUsed ?? 0;

      // Check which pool was used based on consumption order (plan first)
      if (fastUsed > 0 && fastUsed <= fastLimit) {
        // Plan was used (plan wasn't exhausted yet)
        await prisma.subscription.update({
          where: { userId },
          data: { fastQueriesUsed: Math.max(0, fastUsed - 1) },
        });
        logger.info({ userId, queryType }, "Query refunded after API failure");
      } else if (packFastUsed > 0 && subscription.queryPackActive) {
        // Pack was used (plan was already exhausted)
        await prisma.subscription.update({
          where: { userId },
          data: { queryPackFastQueriesUsed: Math.max(0, packFastUsed - 1) },
        });
        logger.info({ userId, queryType }, "Query refunded after API failure");
      }
    }

    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, queryType, action: "refundAIQuery" },
      "Refund query error",
    );
    return { success: false, error: "Failed to refund query" };
  }
}

/**
 * Get payment history for a user.
 * Returns completed, failed, and pending payments ordered by date.
 */
export async function getPaymentHistory(
  userId: string,
): Promise<ServiceResult<PaymentHistoryItem[]>> {
  try {
    const payments = await prisma.payment.findMany({
      where: {
        userId,
        status: { in: ["COMPLETED", "FAILED", "PENDING"] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        planId: true,
        planName: true,
        amount: true,
        currency: true,
        // BUG-2 / MONEY-877: the ACTUAL charged total + the PRESENTMENT currency it
        // was charged in, so the billing page shows what the customer really paid
        // (a discounted/prorated upgrade, a foreign adaptive-currency charge) with
        // the correct symbol — not our pre-checkout INR estimate.
        totalAmount: true,
        presentmentCurrency: true,
        status: true,
        paidAt: true,
        createdAt: true,
        errorMessage: true,
        period: true,
        invoiceUrl: true,
        paymentMethod: true,
        paymentMethodType: true,
        cardLastFour: true,
        cardNetwork: true,
      },
    });

    return {
      success: true,
      data: payments.map(({ totalAmount, presentmentCurrency, ...p }) => {
        // BUG-2 / MONEY-877: surface the REAL charge. totalAmount (incl. tax,
        // smallest unit → ÷100) is what the CUSTOMER paid, in the PRESENTMENT
        // currency. MONEY-1062 (Round C / C1#8): amount and currency move as an
        // ATOMIC pair — the Dodo (totalAmount, presentmentCurrency) pair is used
        // only when BOTH are stored; otherwise fall back to the full recorded
        // checkout pair (amount, currency). The old half-pair labelled the
        // presentment total with settlement/INR (or the INR figure with a
        // presentment currency) whenever one side was missing.
        const hasDodoPair = totalAmount != null && presentmentCurrency != null;
        return {
          ...p,
          amount: hasDodoPair ? totalAmount / 100 : p.amount,
          currency: hasDodoPair ? presentmentCurrency : p.currency,
          paidAt: p.paidAt?.toISOString() || null,
          createdAt: p.createdAt.toISOString(),
          invoiceUrl: p.invoiceUrl ?? null,
          paymentMethod: p.paymentMethod ?? null,
          paymentMethodType: p.paymentMethodType ?? null,
          cardLastFour: p.cardLastFour ?? null,
          cardNetwork: p.cardNetwork ?? null,
        };
      }),
    };
  } catch (error) {
    logger.error(
      { error, userId, action: "getPaymentHistory" },
      "Get payment history error",
    );
    return { success: false, error: "Failed to fetch payment history" };
  }
}

/**
 * Check Dodo API for pending payments and update their status.
 * Resolves payments where the webhook hasn't arrived yet
 * (e.g., localhost dev, webhook delivery delays).
 */
export async function refreshPendingPayments(
  userId: string,
): Promise<ServiceResult<{ updated: number }>> {
  try {
    // Find PENDING payments for this user
    const pendingPayments = await prisma.payment.findMany({
      where: { userId, status: "PENDING" },
      // metadata is carried through to getPaymentRefreshUpdate so the
      // checkout keys (creditPackSize/originalPlanId) survive the merge.
      select: { id: true, dodoPaymentId: true, metadata: true },
    });

    if (pendingPayments.length === 0) {
      return { success: true, data: { updated: 0 } };
    }

    let updated = 0;

    for (const payment of pendingPayments) {
      if (!payment.dodoPaymentId) continue;

      try {
        // Bound the Dodo round-trip (MONEY-1074): this now backs a 3s client
        // poll, so an unbounded retrieve (SDK default ~60s × 2 retries) could
        // pile up. 6s single attempt is well above a healthy Dodo p99.
        const dodoPayment = await dodoClient.payments.retrieve(
          payment.dodoPaymentId,
          { timeout: 6_000, maxRetries: 0 },
        );

        // Pure decision (shared with tests): which DB patch (if any) for the
        // refreshed Dodo status. `null` = still pending, no update. Existing
        // metadata is passed so checkout keys survive the merge.
        const updateData = getPaymentRefreshUpdate(
          dodoPayment,
          new Date(),
          payment.metadata,
        );
        if (updateData) {
          const updatedRow = await prisma.payment.update({
            where: { id: payment.id },
            data: updateData,
          });
          updated++;

          // MONEY-1074: when the poll resolves a payment to COMPLETED, APPLY
          // the subscription grant here. Previously this loop only flipped the
          // Payment status and relied on the Svix webhook to grant the plan —
          // so if the webhook was misconfigured/delayed (the QA case), the user
          // paid but never received the tier. The callback-grant is claim-once
          // (appliedAt CAS), so it is idempotent against a webhook that also
          // lands. A grant failure must not abort the remaining pending rows.
          if (updateData.status === "COMPLETED") {
            try {
              // Lazy import breaks the module cycle subscription.service →
              // payment-provisioning.service → payment-grant.service →
              // subscription.service (same pattern the web action uses for
              // syncDodoProducts).
              const { provisionPaymentCallbackGrant } =
                await import("./payment-provisioning.service");
              const outcome = await provisionPaymentCallbackGrant({
                payment: {
                  id: updatedRow.id,
                  userId: updatedRow.userId,
                  planId: updatedRow.planId,
                  planName: updatedRow.planName,
                  period: updatedRow.period,
                  status: updatedRow.status,
                  metadata: updatedRow.metadata,
                },
              });
              logger.info(
                { paymentId: updatedRow.id, outcome },
                "refreshPendingPayments: subscription grant applied for resolved payment",
              );
            } catch (grantErr) {
              // Payment stays COMPLETED and the claim was released, so the
              // webhook or the next refresh retries the grant.
              logger.error(
                { error: grantErr, paymentId: updatedRow.id },
                "refreshPendingPayments: grant failed after COMPLETED transition",
              );
            }
          }
        }
      } catch (err: unknown) {
        // If Dodo returns 404, the payment ID doesn't exist - mark as FAILED
        // so we don't keep retrying on every page load
        if (is404PaymentError(err)) {
          logger.warn(
            { paymentId: payment.id, dodoPaymentId: payment.dodoPaymentId },
            "Dodo payment not found (404) - marking as FAILED",
          );
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: "FAILED",
              errorMessage: get404PaymentErrorMessage(),
            },
          });
          updated++;
        } else {
          logger.error(
            { error: err, paymentId: payment.id },
            "Failed to check Dodo payment status",
          );
        }
      }
    }

    return { success: true, data: { updated } };
  } catch (error) {
    logger.error(
      { error, userId, action: "refreshPendingPayments" },
      "Refresh pending payments error",
    );
    return { success: false, error: "Failed to refresh payments" };
  }
}
