"use server";

import { currentUser } from "@clerk/nextjs/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { validateCouponState } from "@usemoney/services";
import { dbLogger as logger } from "@usemoney/logger";

// ── Validate Coupon ──
//
// Thin Server Action that resolves the caller's identity from the session and
// delegates to the trusted `validateCouponState` gate in @usemoney/services —
// the SAME gate the checkout uses — so the UI preview and the server-side
// checkout enforcement can never diverge (code length, active window, usage
// limit, user-specific IDOR, AND target-plan scope). `targetPlanId` is the plan
// the user is about to buy, checked against the coupon's applicablePlans.
export async function validateCouponAction(
  code: string,
  targetPlanId?: string,
  targetBillingPeriod?: string
): Promise<{
  valid: boolean;
  discountType?: "percent" | "flat";
  discountPercent?: number;
  discountAmount?: number;
  applicablePlans?: string[];
  applicableBillingPeriods?: string[];
  couponName?: string;
  error?: string;
}> {
  if (!code || code.trim().length < 3) {
    return { valid: false, error: "Please enter a valid coupon code" };
  }

  try {
    const clerkUser = await currentUser();
    const email =
      clerkUser?.emailAddresses?.[0]?.emailAddress?.toLowerCase() ?? null;
    const authUser = await getAuthenticatedUser();

    return await validateCouponState(
      code,
      email,
      authUser?.userId ?? null,
      targetPlanId ?? null,
      targetBillingPeriod ?? null
    );
  } catch (error) {
    logger.error({ error, code }, "validateCoupon failed");
    return { valid: false, error: "Couldn't validate coupon, try again" };
  }
}

// ── Record Coupon Redemption ──
// SECURITY (MONEY-594): redemption recording is NOT a Server Action. It mutates
// coupon.currentUsage and writes a CouponRedemption row keyed by userId, so a
// browser-exposed entrypoint let attackers grief arbitrary victims / exhaust a
// coupon. The logic now lives in @usemoney/services (recordCouponRedemption)
// and is invoked only from the Svix-verified Dodo webhook
// (apps/web/app/api/webhooks/dodo/route.ts). Do NOT re-export it here.
