/**
 * Coupon Service
 *
 * Coupon validation (read-side) + redemption recording (write-side).
 *
 * SECURITY (MONEY-594): redemption recording must NEVER be reachable from the
 * browser. It is invoked exclusively from the Svix-signature-verified Dodo
 * payments webhook (apps/web/app/api/webhooks/dodo), where the real
 * (userId, paymentId) pair is known server-side. Exposing it as a
 * "use server" Server Action let an attacker plant redemption rows for
 * arbitrary victim userIds (poisoning validateCoupon → "already used") and
 * inflate currentUsage to exhaust maxUsage (coupon griefing / DoS).
 *
 * The side-effect-free money-math + validation primitives live in
 * `./coupon-logic.ts` (percent clamping, basis-points conversion, final-price
 * floor-at-zero, usage off-by-one, expiry/active-window with Invalid-Date
 * fail-closed, the ordered validation gate, and the redemption write builder).
 * This service is the thin Prisma-bound shell that CALLS them, so the LIVE
 * coupon path and the unit tests execute the SAME guarded logic.
 *
 * Source: apps/web/lib/actions/coupon.ts (validateCouponAction,
 *         recordCouponRedemption)
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import {
  buildRedemptionWrites,
  classifyRedemptionError,
  COUPON_ERRORS,
  normalizeCouponCode,
  validateCoupon,
  type ValidateCouponResult,
} from "./coupon-logic";

/**
 * Validate a coupon for a given caller, returning the (clamped) discount or a
 * user-facing error. This is the trusted server-side gate behind the
 * `validateCouponAction` Server Action: it does the I/O (look the coupon up by
 * its normalised code; for a user-specific coupon, check whether THIS caller
 * already redeemed it — a per-`userId`-scoped query, never the victim's) and
 * delegates every decision to the pure `validateCoupon` gate.
 *
 * `now` is injectable for deterministic boundary testing; the live caller
 * passes the current instant.
 */
export async function validateCouponState(
  code: string,
  userEmail: string | null,
  userId: string | null,
  targetPlanId: string | null = null,
  targetBillingPeriod: string | null = null,
  now: Date = new Date(),
): Promise<ValidateCouponResult> {
  try {
    const coupon = await prisma.coupon.findUnique({
      where: { code: normalizeCouponCode(code) },
    });

    let existingRedemption = false;
    // MONEY-872: ONCE-PER-USER for EVERY coupon — match an existing redemption by the
    // caller's userId OR their email (case-insensitive). The EMAIL match is what
    // survives a DELETE-then-RESIGNUP: a deleted user's CouponRedemption row is NOT
    // cascade-deleted (no User FK relation) and stays with their email, so a
    // re-created account — which gets a brand-new internal userId — is still blocked
    // from re-claiming. Scoping by the caller's own userId/email is the IDOR guard:
    // a coupon's "already used" state is never read against another person's id.
    if (coupon && (userId || userEmail)) {
      const redemption = await prisma.couponRedemption.findFirst({
        where: {
          couponId: coupon.id,
          OR: [
            ...(userId ? [{ userId }] : []),
            ...(userEmail
              ? [
                  {
                    userEmail: {
                      equals: userEmail.toLowerCase(),
                      mode: "insensitive" as const,
                    },
                  },
                ]
              : []),
          ],
        },
      });
      existingRedemption = redemption !== null;
    }

    return validateCoupon(code, coupon, now, {
      userEmail,
      existingRedemption,
      targetPlanId,
      targetBillingPeriod,
    });
  } catch (error) {
    logger.error({ error, code }, "validateCouponState failed");
    return { valid: false, error: COUPON_ERRORS.genericFailure };
  }
}

/**
 * Record a coupon redemption after a verified successful payment.
 *
 * Idempotent: a unique constraint on (couponId, userId) means a duplicate
 * redemption attempt is swallowed (warn-logged) rather than thrown. The
 * create + usage increment run in a single transaction (built by
 * `buildRedemptionWrites`) so currentUsage can never drift from the number of
 * redemption rows, and a concurrent double-redeem is stopped by the unique
 * index rather than a read-modify-write race.
 *
 * MUST only be called from a trusted server context (verified webhook).
 */
export async function recordCouponRedemption(
  discountCode: string,
  userId: string,
  userEmail: string,
  paymentId?: string,
): Promise<void> {
  const coupon = await prisma.coupon.findUnique({
    where: { code: normalizeCouponCode(discountCode) },
  });

  if (!coupon) return;

  const writes = buildRedemptionWrites(
    coupon.id,
    userId,
    userEmail,
    paymentId ?? null,
  );

  try {
    await prisma.$transaction([
      prisma.couponRedemption.create(writes.redemption),
      prisma.coupon.update(writes.usageIncrement),
    ]);
  } catch (err) {
    const outcome = classifyRedemptionError(err);
    if (outcome.action === "duplicate") {
      logger.warn(
        { discountCode, userId, action: "recordCouponRedemption" },
        "Duplicate coupon redemption attempt ignored",
      );
      return;
    }
    throw outcome.error;
  }
}

// Re-export the pure price/skip helpers (MONEY-865) so the checkout (apps/web)
// can reach them via @usemoney/services without importing the source path. A
// targeted re-export rather than `export *` to avoid name-ambiguity in the
// services barrel.
export {
  applyDiscount,
  applyPercentDiscount,
  couponFinalPrice,
  isFullyCovered,
  normalizeDiscountType,
  buildDodoDiscountParams,
  couponDisplayStatus,
} from "./coupon-logic";
export type {
  DiscountType,
  CouponDiscountShape,
  ValidateCouponResult,
  DodoDiscountParams,
  CouponDisplayStatus,
} from "./coupon-logic";
