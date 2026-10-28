/**
 * Subscription Routes
 *
 * Subscription management and payment history.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  safeJson,
  zodParse,
} from "../../lib/response";
import {
  getSubscription,
  getPaymentHistory,
  cancelSubscription,
  getSubscriptionAccessForUser,
  DEFAULT_FREE_ACCESS,
  downgradeWithGracePeriod,
  refreshPendingPayments,
  scheduleSubscriptionCancel,
  scheduleSubscriptionDowngrade,
  unscheduleSubscriptionChange,
  previewSubscriptionChange,
  computeAiCreditsPreflight,
} from "@usemoney/services";

const subscriptionRoutes = new Hono<AppContext>();

/**
 * Map a subscription-management service `code` to its HTTP status. Uncoded
 * failures stay 500 (the route's own try/catch handles those). Mirrors the web
 * actions' user-facing errors: NOT_FOUND → 404; every other client-state
 * conflict (already-FREE, no-derivable-term-end, coupon-grant) → 409.
 */
function mapScheduleError(
  c: import("hono").Context<AppContext>,
  result: { error: string; code?: string },
) {
  if (result.code === "NOT_FOUND") {
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }
  if (
    result.code === "ALREADY_FREE" ||
    result.code === "NO_TERM_END" ||
    result.code === "COUPON_GRANT"
  ) {
    return c.json(error(ErrorCodes.CONFLICT, result.error), 409);
  }
  return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
}

const ScheduleDowngradeSchema = z.object({
  targetPlanId: z.enum(["PRO", "PREMIUM"]),
  targetCycle: z.enum(["monthly", "annual"]),
});

/**
 * GET /v1/subscription
 * Get current subscription status
 */
subscriptionRoutes.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getSubscription(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Subscription error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch subscription"),
      500,
    );
  }
});

/**
 * GET /v1/subscription/access (MONEY-1062 P1a)
 * The computed entitlement gates mobile needs (planId, feature flags, credit
 * limits/usage) — the same SubscriptionAccess view apps/web's
 * /api/subscription/access serves. Mirrors the web wrapper's fail-to-FREE
 * posture: a service failure degrades to DEFAULT_FREE_ACCESS with a 200 (the
 * client renders FREE limits during a transient DB error) — entitlement gates
 * must never hard-error into an unusable app.
 */
subscriptionRoutes.get("/access", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getSubscriptionAccessForUser(userId);
    return c.json(success(result.success ? result.data : DEFAULT_FREE_ACCESS));
  } catch (err) {
    console.error("Subscription access error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to get subscription access"),
      500,
    );
  }
});

/**
 * GET /v1/subscription/payments
 * Get payment history
 */
subscriptionRoutes.get("/payments", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await getPaymentHistory(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success(result.data));
  } catch (err) {
    console.error("Payment history error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch payment history"),
      500,
    );
  }
});

/**
 * POST /v1/subscription/cancel
 * Cancel subscription
 */
subscriptionRoutes.post("/cancel", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await cancelSubscription(userId);
    if (!result.success) {
      // Cancelling with no active subscription is a client-state 404, not a
      // server failure. The service-side code:"NOT_FOUND" lands via another
      // wave (subscription.service is out of this task's ownership); until
      // then failures carry no code and correctly stay 500 — same as before.
      if (result.code === "NOT_FOUND") {
        return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success({ message: "Subscription cancelled" }));
  } catch (err) {
    console.error("Cancel subscription error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to cancel subscription"),
      500,
    );
  }
});

/**
 * POST /v1/subscription/downgrade (MONEY-1062 P4e)
 * Downgrade with grace period (PREMIUM/ULTIMATE → PRO fallback, or grace-period
 * endDate). Mirrors downgradeWithGracePeriodAction — reuses the EXISTING
 * downgradeWithGracePeriod service.
 */
subscriptionRoutes.post("/downgrade", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await downgradeWithGracePeriod(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    // gracePeriodEndDate is optional (immediate FREE downgrade omits it).
    return c.json(
      success({ gracePeriodEndDate: result.data.gracePeriodEndDate }),
    );
  } catch (err) {
    console.error("Downgrade subscription error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to downgrade subscription"),
      500,
    );
  }
});

/**
 * POST /v1/subscription/refresh-pending (MONEY-1062 P4e)
 * Reconcile PENDING payments against Dodo's API (localhost dev / webhook delay).
 * Mirrors refreshPendingPaymentsAction — reuses the EXISTING refreshPendingPayments
 * service (Dodo I/O lives in the service).
 */
subscriptionRoutes.post("/refresh-pending", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await refreshPendingPayments(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success({ updated: result.data.updated }));
  } catch (err) {
    console.error("Refresh pending payments error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to refresh payments"),
      500,
    );
  }
});

/**
 * POST /v1/subscription/schedule-cancel (MONEY-1062 P4e)
 * Schedule a cancellation at term end (keeps access until the paid period ends,
 * then drops to FREE). Mirrors scheduleCancelAction — the Dodo
 * `cancel_at_next_billing_date` write stays in the service with the same
 * swallow-and-log posture.
 */
subscriptionRoutes.post("/schedule-cancel", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await scheduleSubscriptionCancel(userId);
    if (!result.success) {
      return mapScheduleError(c, result);
    }
    return c.json(
      success({ scheduledEffectiveAt: result.data.scheduledEffectiveAt }),
    );
  } catch (err) {
    console.error("Schedule cancel error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to schedule cancellation"),
      500,
    );
  }
});

/**
 * POST /v1/subscription/schedule-downgrade (MONEY-1062 P4e)
 * Schedule a tier/cycle downgrade at term end. Mirrors scheduleDowngradeAction
 * (no Dodo call — the sub stays alive to term-end; the cron re-provisions).
 * Body: { targetPlanId: "PRO"|"PREMIUM", targetCycle: "monthly"|"annual" }.
 */
subscriptionRoutes.post("/schedule-downgrade", async (c) => {
  const userId = c.get("userId");

  const body = await safeJson(c);
  if (!body.ok) {
    return c.json(error(ErrorCodes.BAD_REQUEST, "Invalid JSON body"), 400);
  }
  const parsed = zodParse(ScheduleDowngradeSchema, body.data);
  if (!parsed.ok) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid downgrade payload",
        parsed.issues,
      ),
      400,
    );
  }

  try {
    const result = await scheduleSubscriptionDowngrade(
      userId,
      parsed.data.targetPlanId,
      parsed.data.targetCycle,
    );
    if (!result.success) {
      return mapScheduleError(c, result);
    }
    return c.json(
      success({ scheduledEffectiveAt: result.data.scheduledEffectiveAt }),
    );
  } catch (err) {
    console.error("Schedule downgrade error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to schedule downgrade"),
      500,
    );
  }
});

/**
 * POST /v1/subscription/unschedule (MONEY-1062 P4e)
 * Undo a pending scheduled change (re-enables Dodo auto-renew for a paid
 * cancel). Mirrors unscheduleChangeAction — a coupon/trial FREE-grant is NOT
 * user-cancellable (409 COUPON_GRANT). Nothing scheduled = idempotent success.
 */
subscriptionRoutes.post("/unschedule", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await unscheduleSubscriptionChange(userId);
    if (!result.success) {
      return mapScheduleError(c, result);
    }
    return c.json(success({ unscheduled: result.data.unscheduled }));
  } catch (err) {
    console.error("Unschedule change error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to undo scheduled change"),
      500,
    );
  }
});

/**
 * GET /v1/subscription/preview-change (MONEY-1062 P4e)
 * Read-only preview of a plan change for confirmation copy. Mirrors
 * previewPlanChangeAction. Query: ?targetPlanId=PRO|PREMIUM|FREE
 * &targetCycle=monthly|annual (targetCycle omitted → null, e.g. for FREE/cancel).
 */
subscriptionRoutes.get("/preview-change", async (c) => {
  const userId = c.get("userId");

  const targetPlanId = c.req.query("targetPlanId");
  if (
    targetPlanId !== "PRO" &&
    targetPlanId !== "PREMIUM" &&
    targetPlanId !== "FREE"
  ) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "targetPlanId must be one of PRO, PREMIUM, FREE",
      ),
      400,
    );
  }
  const rawCycle = c.req.query("targetCycle");
  if (
    rawCycle !== undefined &&
    rawCycle !== "monthly" &&
    rawCycle !== "annual"
  ) {
    return c.json(
      error(
        ErrorCodes.VALIDATION_ERROR,
        "targetCycle must be monthly or annual when provided",
      ),
      400,
    );
  }
  const targetCycle = (rawCycle ?? null) as "monthly" | "annual" | null;

  try {
    const result = await previewSubscriptionChange(
      userId,
      targetPlanId,
      targetCycle,
    );
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(success(result.data));
  } catch (err) {
    console.error("Preview plan change error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to preview plan change"),
      500,
    );
  }
});

/**
 * GET /v1/subscription/ai-credits (MONEY-1062 P4e)
 * Pre-flight credit gate for AI features (analysis/compare/research). Mirrors
 * checkAICreditsAction: composes getSubscription + the pure credit-decision
 * math. A subscription-read failure degrades to the FREE (blocked) verdict with
 * a 200 — a pre-check must never hard-error the calling feature.
 */
subscriptionRoutes.get("/ai-credits", async (c) => {
  const userId = c.get("userId");

  try {
    const subResult = await getSubscription(userId);
    if (!subResult.success || !subResult.data) {
      return c.json(
        success({ allowed: false, reason: "free", planId: "FREE" }),
      );
    }
    return c.json(success(computeAiCreditsPreflight(subResult.data)));
  } catch (err) {
    console.error("AI credits pre-check error:", err);
    // Fail closed to the FREE verdict (never hard-error the calling feature).
    return c.json(success({ allowed: false, reason: "free", planId: "FREE" }));
  }
});

export default subscriptionRoutes;
