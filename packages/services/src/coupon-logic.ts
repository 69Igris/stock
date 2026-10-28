/**
 * Coupon pure-logic helpers (service layer).
 *
 * Side-effect-free coupon money-math + validation primitives used by
 * `./coupon.service.ts`. They are isolated here (away from the Prisma-importing
 * service) so they can be unit-tested without pulling in the Prisma client at
 * import time, and — critically — so the LIVE coupon path runs the SAME
 * guarded math the regression tests assert (mirrors the `dashboard-logic.ts`
 * de-shadow precedent).
 *
 * ## What is REAL in this codebase
 *
 * The persisted `Coupon` model (packages/database/prisma/schema.prisma) is
 * percent-only: a single `discountPercent: Float`, plus `maxUsage` /
 * `currentUsage`, `expiresAt`, `isActive`, and the user-specific
 * (`isUserSpecific` / `targetUserEmail`) IDOR fields. There is NO stored flat
 * amount, no min-order, and no max-discount column. The actual charge is
 * computed by Dodo from the `discount_code` we forward at checkout
 * (apps/web/lib/actions/subscription.ts); admin coupon creation converts the
 * percent to Dodo basis points via `Math.round(discountPercent * 100)`
 * (apps/admin/lib/actions/discounts.ts), and `validateCouponAction`
 * (apps/web/lib/actions/coupon.ts) is the read-side gate that surfaces the
 * percent for display and blocks expired / exhausted / wrong-user coupons.
 *
 * ## Why the extra guards here are load-bearing (REAL MONEY)
 *
 * `discountPercent` is an unbounded `Float` at the DB layer. Admin *create*
 * validates `0 < percent <= 100`, but a coupon can be seeded/imported/edited
 * out-of-band, and a corrupt value (`NaN`, `Infinity`, `> 100`, negative) must
 * NEVER:
 *   - convert to a basis-points value that under/over-charges or that Dodo
 *     rejects (a `NaN`/`Infinity`/negative `usage_limit`/amount), or
 *   - flow into a displayed/charged final price that is negative (the customer
 *     is paid to subscribe) or inverted to a charge-UP (> original price), or
 *   - poison a price total via a single non-finite addend.
 *
 * So every percent→amount conversion is funnelled through `clampDiscountPercent`
 * (→ a finite fraction in [0, 100]) and every final-price computation through
 * `applyDiscount`, which clamps the discount to `[0, price]` and floors the
 * result at `0`. These mirror the non-finite discipline already enforced in
 * `dashboard-logic.ts`.
 */

import type { Prisma } from "@usemoney/database";

// ---------------------------------------------------------------------------
// Non-finite guard (local, mirrors dashboard-logic.ts#finite)
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * Coupon math is a money surface: a single `NaN`/`±Infinity` value (a corrupt
 * `discountPercent`, a malformed price) must not corrupt a charge or a price
 * total. `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback`
 * (default 0). Mirrors `dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Code normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a coupon code for case/whitespace-insensitive lookup: trim
 * surrounding whitespace and uppercase. This is the single source of truth the
 * service and validation share — the persisted `Coupon.code` is stored
 * uppercase, and the read-side action looks up by `code.toUpperCase()`. Trimming
 * additionally prevents a trailing-space paste ("SAVE20 ") from missing an
 * otherwise-valid coupon, and a non-string input (defensive) yields "".
 */
export function normalizeCouponCode(code: string | null | undefined): string {
  if (typeof code !== "string") return "";
  return code.trim().toUpperCase();
}

/**
 * True when a *raw* (un-normalised) code is long enough to bother looking up.
 * Mirrors the `validateCouponAction` gate: the TRIMMED code must be >= 3 chars
 * (a 2-char or whitespace-only code is rejected before any DB hit).
 */
export function isCodeLongEnough(code: string | null | undefined): boolean {
  if (typeof code !== "string") return false;
  return code.trim().length >= 3;
}

// ---------------------------------------------------------------------------
// Discount math (percent + generalised final-price)
// ---------------------------------------------------------------------------

/** A coupon's discount kind. The DB model is percent-only today; `flat` is
 * supported by the math so a future amount-off coupon shares the SAME clamping
 * and floor-at-zero guarantees rather than re-deriving them unsafely. */
export type DiscountType = "percent" | "flat";

/**
 * Normalize a stored/raw discount type to the {@link DiscountType} union.
 * Anything that isn't exactly "flat" is treated as "percent" (the legacy
 * default), so a null / legacy / garbage value can never accidentally select
 * the flat branch.
 */
export function normalizeDiscountType(
  type: string | null | undefined,
): DiscountType {
  return type === "flat" ? "flat" : "percent";
}

/**
 * Clamp a `discountPercent` to a finite fraction in `[0, 100]`.
 *
 * A non-finite percent (`NaN`/`±Infinity`) collapses to `0` (no discount — fail
 * closed, never a free/negative charge). A percent `> 100` is capped at `100`
 * (a 150%-off coupon can at most make the item free, never pay the customer),
 * and a negative percent floors at `0` (a "-20%" coupon must not become a 20%
 * surcharge / charge-UP). This is the single guard every percent→money
 * conversion below depends on.
 */
export function clampDiscountPercent(
  percent: number | null | undefined,
): number {
  const p = finite(percent, 0);
  if (p <= 0) return 0;
  if (p >= 100) return 100;
  return p;
}

/**
 * Convert a `discountPercent` to Dodo basis points (20% → 2000), matching the
 * admin-create conversion `Math.round(discountPercent * 100)` but with the
 * `clampDiscountPercent` guard in front so a corrupt percent can never become a
 * `NaN`/`Infinity`/negative/over-100% basis-points value sent to the payment
 * provider. Result is always an integer in `[0, 10000]`.
 */
export function discountPercentToBasisPoints(
  percent: number | null | undefined,
): number {
  return Math.round(clampDiscountPercent(percent) * 100);
}

/** Dodo `discounts.create` params for a (percentage-only) coupon. */
export interface DodoDiscountParams {
  amount: number;
  type: "percentage";
  code: string;
  name?: string;
  expires_at?: string;
  usage_limit?: number;
  /** Billing cycles the discount applies to (always 1 — see builder). */
  subscription_cycles: number;
}

/**
 * MONEY-872: build the Dodo discount-create params for a coupon. Dodo ONLY supports
 * `percentage` (its API 422s on a "flat" variant), so fixed-value coupons were
 * removed and every coupon is a percentage. `subscription_cycles: 1` caps the
 * discount to the FIRST billing cycle — without it Dodo applies it to EVERY renewal
 * forever. The percent is clamped to [0, 100] → basis points.
 */
export function buildDodoDiscountParams(input: {
  discountPercent?: number | null;
  code: string;
  name?: string | null;
  expiresAt?: string | null;
  maxUsage?: number | null;
}): DodoDiscountParams {
  return {
    amount: discountPercentToBasisPoints(input.discountPercent), // % → basis points
    type: "percentage",
    code: input.code,
    name: input.name || undefined,
    expires_at: input.expiresAt || undefined,
    usage_limit: input.maxUsage ?? undefined,
    subscription_cycles: 1,
  };
}

/** Inputs for the generalised final-price computation. */
export interface ApplyDiscountInput {
  /** The order subtotal before discount (rupees). */
  price: number | null | undefined;
  /** `percent` (uses `discountPercent`) or `flat` (uses `discountValue`). */
  type: DiscountType;
  /** Percent off, 0–100 (used when `type === "percent"`). */
  discountPercent?: number | null;
  /** Flat rupees off (used when `type === "flat"`). */
  discountValue?: number | null;
  /** Optional absolute cap on the rupee discount (max-discount). */
  maxDiscount?: number | null;
  /** Optional minimum order subtotal for the coupon to apply at all. */
  minOrder?: number | null;
}

/** Result of {@link applyDiscount}. */
export interface ApplyDiscountResult {
  /** Subtotal echoed back, finite-guarded (>= 0). */
  originalPrice: number;
  /** The rupee discount actually applied, in `[0, originalPrice]`. */
  discountAmount: number;
  /** Final price = `max(0, originalPrice - discountAmount)`, never negative. */
  finalPrice: number;
  /** False when `minOrder` is not met (then discountAmount is 0). */
  applied: boolean;
}

/**
 * The canonical, fully-guarded discount computation. Guarantees, regardless of
 * how corrupt the inputs are (REAL MONEY — these are the bug classes the
 * MONEY-620 brief enumerates):
 *
 *  1. `finalPrice` is ALWAYS finite and `>= 0` — a discount can never exceed the
 *     order total, so the customer is never paid to buy (no negative charge).
 *  2. The discount can never INVERT to a charge-UP — `finalPrice <= originalPrice`
 *     always (a > 100% percent, or a `flat`/`maxDiscount` larger than the price,
 *     caps the discount at the price, never adds to it).
 *  3. Non-finite `price`/`discountPercent`/`discountValue`/`maxDiscount`
 *     collapse to safe finite values; an `Infinity` discount → `finalPrice` 0
 *     (free), never `NaN`.
 *  4. When `minOrder` is set and the subtotal is below it, NO discount applies
 *     (`applied: false`, `discountAmount: 0`, `finalPrice === originalPrice`).
 */
export function applyDiscount(input: ApplyDiscountInput): ApplyDiscountResult {
  const originalPrice = Math.max(0, finite(input.price, 0));

  // Min-order gate: a subtotal below the (finite) minimum disqualifies the
  // coupon entirely. A non-finite minOrder is treated as "no minimum" (0).
  const minOrder = Math.max(0, finite(input.minOrder, 0));
  if (originalPrice < minOrder) {
    return {
      originalPrice,
      discountAmount: 0,
      finalPrice: originalPrice,
      applied: false,
    };
  }

  // Raw discount from the coupon kind.
  let rawDiscount: number;
  if (input.type === "flat") {
    rawDiscount = Math.max(0, finite(input.discountValue, 0));
  } else {
    const fraction = clampDiscountPercent(input.discountPercent) / 100;
    rawDiscount = originalPrice * fraction;
  }

  // Optional absolute cap (max-discount). A non-finite/absent cap means "no
  // cap" — but the price cap below still applies, so a runaway discount is
  // always bounded.
  if (input.maxDiscount != null && Number.isFinite(input.maxDiscount)) {
    rawDiscount = Math.min(rawDiscount, Math.max(0, input.maxDiscount));
  }

  // Hard floor/ceiling: the discount can never exceed the order total nor be
  // negative. This is the invariant that makes finalPrice >= 0 unconditionally.
  const discountAmount = Math.min(Math.max(0, rawDiscount), originalPrice);
  const finalPrice = Math.max(0, originalPrice - discountAmount);

  // `applied: true` here means the coupon was ELIGIBLE (the min-order gate
  // passed). The early `return` above is the only `applied: false` path. A valid
  // coupon that happens to compute a 0 discount (e.g. 0%-off after a fail-closed
  // clamp) is still "applied" — it just didn't reduce the price.
  return { originalPrice, discountAmount, finalPrice, applied: true };
}

/**
 * Convenience: the final price for the live percent-only coupon model. Equal to
 * `applyDiscount({ price, type: "percent", discountPercent }).finalPrice`, i.e.
 * `max(0, price - clamp(percent)·price)`.
 */
export function applyPercentDiscount(
  price: number | null | undefined,
  discountPercent: number | null | undefined,
): number {
  return applyDiscount({ price, type: "percent", discountPercent }).finalPrice;
}

/** The discount-defining subset of a coupon (a validated result or Prisma row). */
export interface CouponDiscountShape {
  discountType?: DiscountType | string | null;
  discountPercent?: number | null;
  /** Flat rupees off (used only when discountType === "flat"). */
  discountAmount?: number | null;
}

/**
 * Final-price computation for a coupon of EITHER kind, dispatching on
 * `discountType`. The single entry point the checkout uses so percent and flat
 * coupons share the same {@link applyDiscount} guards (floor-at-zero, never a
 * charge-up, non-finite safe).
 */
export function couponFinalPrice(
  price: number | null | undefined,
  coupon: CouponDiscountShape,
): ApplyDiscountResult {
  const type = normalizeDiscountType(
    coupon.discountType as string | null | undefined,
  );
  return type === "flat"
    ? applyDiscount({
        price,
        type: "flat",
        discountValue: coupon.discountAmount,
      })
    : applyDiscount({
        price,
        type: "percent",
        discountPercent: coupon.discountPercent,
      });
}

/**
 * True when a coupon FULLY covers the price (final price <= 0) — the signal the
 * checkout uses to SKIP the Dodo payment page and grant the plan directly. A
 * non-positive base price (a misconfigured ₹0 plan) also reads as fully covered.
 */
export function isFullyCovered(
  price: number | null | undefined,
  coupon: CouponDiscountShape,
): boolean {
  return couponFinalPrice(price, coupon).finalPrice <= 0;
}

/**
 * Term end for a coupon-granted plan: `now` + 1 month (default) or + 1 year
 * (annual). A fully-covered coupon grant has no Dodo subscription to renew, so
 * the grant must self-expire at this instant — the scheduled-change cron then
 * downgrades the plan to FREE. Pure (now is injected) so it is deterministic in
 * tests.
 */
export function couponTermEnd(
  billingPeriod: string | null | undefined,
  now: Date,
): Date {
  const end = new Date(now);
  if (billingPeriod === "annual") {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return end;
}

// ---------------------------------------------------------------------------
// Usage / per-user limit
// ---------------------------------------------------------------------------

/**
 * True when a coupon's global usage limit is reached (so it must be rejected).
 *
 * Mirrors the live gate `maxUsage !== null && currentUsage >= maxUsage`. A
 * `null` `maxUsage` is unlimited (never reached). The boundary is exact — the
 * Nth use (currentUsage = N−1 → N) of an N-limited coupon is allowed; the
 * (N+1)th (currentUsage = N) is rejected:
 *   - maxUsage 1, currentUsage 0 → false (the single allowed use)
 *   - maxUsage 1, currentUsage 1 → true  (already consumed)
 * Non-finite `currentUsage` fails closed (treated as exhausted) so a corrupt
 * counter can never grant unlimited redemptions. A non-finite `maxUsage` is
 * treated as "no limit" only when it is exactly `null`; any finite positive
 * value gates normally.
 */
export function isUsageLimitReached(
  maxUsage: number | null | undefined,
  currentUsage: number | null | undefined,
): boolean {
  if (maxUsage == null) return false; // unlimited
  if (!Number.isFinite(maxUsage)) return false; // garbage limit ⇒ treat as no cap
  const used =
    currentUsage == null || !Number.isFinite(currentUsage)
      ? Number.POSITIVE_INFINITY // corrupt counter ⇒ fail closed (exhausted)
      : currentUsage;
  return used >= maxUsage;
}

export type CouponDisplayStatus = "active" | "paused" | "exhausted" | "expired";

/**
 * MONEY-865: the effective status shown in the admin coupon list. An exhausted
 * (usage limit reached) or past-expiry coupon is already un-redeemable at the
 * gate, so it must NOT read "Active". `now` is injected for deterministic tests.
 */
export function couponDisplayStatus(
  coupon: {
    isActive: boolean;
    maxUsage?: number | null;
    currentUsage?: number | null;
    expiresAt?: string | Date | null;
  },
  now: Date,
): CouponDisplayStatus {
  if (!coupon.isActive) return "paused";
  if (isUsageLimitReached(coupon.maxUsage, coupon.currentUsage)) {
    return "exhausted";
  }
  if (
    coupon.expiresAt &&
    new Date(coupon.expiresAt).getTime() < now.getTime()
  ) {
    return "expired";
  }
  return "active";
}

// ---------------------------------------------------------------------------
// Active / expiry window
// ---------------------------------------------------------------------------

/** True when `d` is a usable, finite calendar date (not null / Invalid Date). */
export function isValidDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/**
 * True when a coupon is within its active window AT `now`.
 *
 * Mirrors the live expiry gate (`expiresAt && expiresAt < now` ⇒ expired) and
 * the optional lower bound `validFrom` (not part of the persisted model today,
 * but supported so a future "starts on" coupon shares the SAME fail-closed
 * date handling). Rules:
 *   - A `null` bound means "unbounded" on that side (open-ended coupon).
 *   - An **Invalid-Date** bound (e.g. `new Date("garbage")`) fails CLOSED — the
 *     coupon is treated as NOT active, rather than throwing or (worse) being
 *     read as always-valid because every comparison with `NaN` is `false`.
 *   - The boundary is exact: at EXACTLY `expiresAt` the coupon is still valid
 *     (the live check is strict `<`, i.e. it expires the instant AFTER), and at
 *     exactly `validFrom` it is valid (inclusive start).
 */
export function isWithinActiveWindow(
  validFrom: Date | null | undefined,
  expiresAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!isValidDate(now)) return false; // defensive: no usable clock ⇒ fail closed

  // Upper bound (expiry).
  if (expiresAt !== null && expiresAt !== undefined) {
    if (!isValidDate(expiresAt)) return false; // garbage expiry ⇒ fail closed
    if (expiresAt.getTime() < now.getTime()) return false; // strictly past ⇒ expired
  }

  // Lower bound (start), if present.
  if (validFrom !== null && validFrom !== undefined) {
    if (!isValidDate(validFrom)) return false; // garbage start ⇒ fail closed
    if (now.getTime() < validFrom.getTime()) return false; // not yet started
  }

  return true;
}

// ---------------------------------------------------------------------------
// Full validation gate
// ---------------------------------------------------------------------------

/** The subset of `Coupon` columns the validation gate reads. Structural so the
 * caller can hand a Prisma row straight in. */
export interface CouponValidationFields {
  code: string;
  name: string | null;
  /** "percent" | "flat" — optional/back-compat (legacy rows are percent). */
  discountType?: string | null;
  discountPercent: number;
  /** Flat rupees off (only meaningful when discountType === "flat"). */
  discountAmount?: number | null;
  /** Target plan scope; empty/undefined = valid for any plan (generic). */
  applicablePlans?: string[] | null;
  /** Billing-cycle scope; empty/undefined = valid for BOTH monthly + annual. */
  applicableBillingPeriods?: string[] | null;
  isActive: boolean;
  expiresAt: Date | null;
  /** Optional lower bound (not persisted today; future-proofing). */
  validFrom?: Date | null;
  maxUsage: number | null;
  currentUsage: number;
  isUserSpecific: boolean;
  targetUserEmail: string | null;
}

/** Caller-supplied user context for the per-user (IDOR) checks. */
export interface CouponUserContext {
  /** The CALLER's lowercased email (resolved server-side from the session). */
  userEmail: string | null;
  /** Whether THIS caller has already redeemed THIS coupon (scoped query). */
  existingRedemption: boolean;
  /** The plan being purchased at checkout — checked against applicablePlans. */
  targetPlanId?: string | null;
  /** The billing period at checkout ("monthly"|"annual"), checked against
   * applicableBillingPeriods. */
  targetBillingPeriod?: string | null;
}

/** Result shape mirroring `validateCouponAction`'s return. */
export interface ValidateCouponResult {
  valid: boolean;
  /** "percent" | "flat" — how to interpret the discount for price display. */
  discountType?: DiscountType;
  discountPercent?: number;
  /** Flat rupees off (present only for flat coupons). */
  discountAmount?: number;
  /** Target-plan scope (empty = any plan). Surfaced for display. */
  applicablePlans?: string[];
  /** Billing-cycle scope (empty = both monthly + annual). Surfaced for display. */
  applicableBillingPeriods?: string[];
  couponName?: string;
  error?: string;
}

/** User-facing error strings — kept identical to `validateCouponAction` so the
 * extraction is behaviour-preserving for the live read-side path. */
export const COUPON_ERRORS = {
  invalidCode: "Please enter a valid coupon code",
  notFound: "Invalid coupon code",
  inactive: "This coupon is no longer active",
  expired: "This coupon has expired",
  usageLimit: "This coupon has reached its usage limit",
  signIn: "Please sign in to use this coupon",
  wrongAccount: "This coupon is not valid for your account",
  alreadyUsed: "You have already used this coupon",
  wrongPlan: "This coupon isn't valid for the selected plan",
  wrongBillingPeriod: "This coupon isn't valid for the selected billing cycle",
  genericFailure: "Couldn't validate coupon, try again",
} as const;

/**
 * Pure validation gate — exactly the ordered checks `validateCouponAction`
 * performs, extracted so the read-side action and the tests run the SAME logic
 * (and so the hardened date/usage/clamp guards above are exercised on the live
 * path). Returns `{ valid: false, error }` at the first failing check, or
 * `{ valid: true, discountPercent, couponName }` on success.
 *
 * Order (each short-circuits):
 *   1. raw code too short / whitespace-only
 *   2. coupon not found (caller looked up by `normalizeCouponCode(code)`)
 *   3. inactive
 *   4. outside active window (expiry boundary; Invalid-Date fails closed)
 *   5. global usage limit reached (off-by-one exact)
 *   6. user-specific: must be signed in; email must match `targetUserEmail`
 *      (case-insensitive); must not have already redeemed (per-CALLER scope).
 *
 * `now` is injected so the boundary is deterministic in tests (the live caller
 * passes `new Date()`).
 */
export function validateCoupon(
  code: string,
  coupon: CouponValidationFields | null,
  now: Date,
  userContext?: CouponUserContext,
): ValidateCouponResult {
  // 1. Empty / short code (trim-aware, matches the live gate).
  if (!isCodeLongEnough(code)) {
    return { valid: false, error: COUPON_ERRORS.invalidCode };
  }

  // 2. Not found.
  if (!coupon) {
    return { valid: false, error: COUPON_ERRORS.notFound };
  }

  // 3. Inactive.
  if (!coupon.isActive) {
    return { valid: false, error: COUPON_ERRORS.inactive };
  }

  // 4. Active window (expiry + optional start). Invalid-Date fails CLOSED.
  if (!isWithinActiveWindow(coupon.validFrom ?? null, coupon.expiresAt, now)) {
    return { valid: false, error: COUPON_ERRORS.expired };
  }

  // 5. Global usage limit (exact off-by-one boundary).
  if (isUsageLimitReached(coupon.maxUsage, coupon.currentUsage)) {
    return { valid: false, error: COUPON_ERRORS.usageLimit };
  }

  // 6. Per-user (IDOR) checks — sign-in + target-account are user-specific only.
  if (coupon.isUserSpecific) {
    const userEmail = userContext?.userEmail
      ? userContext.userEmail.toLowerCase()
      : null;

    if (!userEmail) {
      return { valid: false, error: COUPON_ERRORS.signIn };
    }

    if (
      coupon.targetUserEmail &&
      coupon.targetUserEmail.toLowerCase() !== userEmail
    ) {
      return { valid: false, error: COUPON_ERRORS.wrongAccount };
    }
  }

  // 6b. MONEY-872: ONCE-PER-USER for EVERY coupon (not just user-specific). A coupon
  // the caller has already redeemed is rejected here. Previously this check lived
  // INSIDE the isUserSpecific branch, so a general promo (e.g. FLAT20) had NO reuse
  // block — the same user got the discount on every transaction (signup, then
  // upgrade…) while recordCouponRedemption (idempotent on couponId+userId) counted
  // it only ONCE. The caller now passes the (couponId, userId)-scoped
  // existingRedemption for every coupon.
  if (userContext?.existingRedemption) {
    return { valid: false, error: COUPON_ERRORS.alreadyUsed };
  }

  // 7. Target-plan scope. When the coupon is restricted to specific plans, the
  // checkout's target plan must be one of them. An empty list = any plan.
  const allowedPlans = coupon.applicablePlans ?? [];
  if (allowedPlans.length > 0) {
    const target = userContext?.targetPlanId ?? null;
    if (!target || !allowedPlans.includes(target)) {
      return { valid: false, error: COUPON_ERRORS.wrongPlan };
    }
  }

  // 8. Billing-cycle scope. When restricted to specific billing period(s), the
  // checkout's chosen period must be one of them. An empty list = both cycles.
  const allowedPeriods = coupon.applicableBillingPeriods ?? [];
  if (allowedPeriods.length > 0) {
    const period = userContext?.targetBillingPeriod ?? null;
    if (!period || !allowedPeriods.includes(period)) {
      return { valid: false, error: COUPON_ERRORS.wrongBillingPeriod };
    }
  }

  // Success — surface the CLAMPED percent so a corrupt > 100 / negative / NaN
  // stored value can never be echoed to the UI (or onward to a charge). For a
  // flat coupon also surface the (finite-guarded, >= 0) rupee amount so the
  // checkout can compute the authoritative final price via couponFinalPrice.
  const discountType = normalizeDiscountType(coupon.discountType);
  return {
    valid: true,
    discountType,
    discountPercent: clampDiscountPercent(coupon.discountPercent),
    discountAmount:
      discountType === "flat"
        ? Math.max(0, finite(coupon.discountAmount, 0))
        : undefined,
    applicablePlans: allowedPlans,
    applicableBillingPeriods: allowedPeriods,
    couponName: coupon.name ?? coupon.code,
  };
}

// ---------------------------------------------------------------------------
// Redemption-recording decision (pure)
// ---------------------------------------------------------------------------

/**
 * The pure decision the service makes when a `$transaction` (create redemption +
 * increment usage) settles. Extracted so the swallow-duplicate / rethrow logic
 * is asserted directly (it was previously inline + untested in the service).
 *
 * Prisma raises a unique-constraint error on the `(couponId, userId)` index when
 * the same user redeems twice; that is the IDEMPOTENCY signal and must be
 * swallowed (warn-logged) — anything else is a real failure and must propagate.
 * The check is the specific substring "Unique constraint" (a looser "Unique"
 * match would mis-swallow an unrelated error).
 */
export type RedemptionOutcome =
  | { action: "duplicate" }
  | { action: "rethrow"; error: unknown };

export function classifyRedemptionError(error: unknown): RedemptionOutcome {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Unique constraint")) {
    return { action: "duplicate" };
  }
  return { action: "rethrow", error };
}

/**
 * Build the atomic operations a redemption performs: create the
 * `CouponRedemption` row AND increment `currentUsage` in ONE transaction so the
 * counter can never drift from the number of redemption rows (and a concurrent
 * double-redeem is stopped by the unique index, not a read-modify-write race).
 * Returned as plain data so it is assertable without a live Prisma client.
 */
export function buildRedemptionWrites(
  couponId: string,
  userId: string,
  userEmail: string,
  paymentId: string | null,
): {
  redemption: {
    data: Prisma.CouponRedemptionUncheckedCreateInput;
  };
  usageIncrement: {
    where: { id: string };
    data: { currentUsage: { increment: number } };
  };
} {
  return {
    redemption: {
      data: { couponId, userId, userEmail, paymentId },
    },
    usageIncrement: {
      where: { id: couponId },
      data: { currentUsage: { increment: 1 } },
    },
  };
}
