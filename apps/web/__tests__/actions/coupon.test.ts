/**
 * MONEY-620 — Coupon money-math + validation (REAL exports, de-shadowed).
 *
 * The previous version of this file was a SHADOW: it re-declared `validateCoupon`,
 * `normalizeCode`, and a `simulateRecordRedemption` copy INSIDE the test and
 * asserted the copies — the live `@usemoney/services` coupon path was never
 * executed (a green test while the real code could rot). This rewrite:
 *
 *   PART A — imports the REAL exported pure logic from
 *   `packages/services/src/coupon-logic.ts` (relative path; the module is
 *   Prisma-free — only a `import type { Prisma }`, erased at runtime — so it is
 *   safe to import directly with no stubbing) and exhaustively asserts the
 *   money/security guards the brief enumerates:
 *     · percent clamp (>100 / negative / NaN / Infinity)
 *     · basis-points conversion (the value forwarded to Dodo)
 *     · final-price = max(0, price − discount): never negative, never inverts to
 *       a charge-UP, Infinity discount ⇒ free, NaN-safe; max-discount cap;
 *       min-order gate; flat + percent
 *     · usage off-by-one boundary (Nth allowed, N+1 rejected; corrupt counter
 *       fails closed)
 *     · expiry / active-window boundary (exactly-at-expiry valid; Invalid-Date
 *       fails closed = invalid, never always-valid)
 *     · the ordered validation gate, incl. per-user (IDOR) email scoping and
 *       case/whitespace-normalised code lookup
 *
 *   PART B — drives the REAL exported `recordCouponRedemption` from the
 *   `@usemoney/services` barrel through a recording-prisma double injected at the
 *   `@usemoney/database` module boundary via `require.cache` (the proven pattern
 *   from `webhooks-dodo-e2e.test.ts` / `notifications/service-idor-edge.test.ts`).
 *   It asserts the LIVE behaviour: code is normalised before lookup, the
 *   create-redemption + usage-increment run in ONE `$transaction` (atomic, so
 *   currentUsage can't drift), a unique-constraint error is swallowed
 *   (idempotent re-delivery), and any other error propagates.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/coupon-logic.ts
 *         packages/services/src/coupon.service.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import {
  applyDiscount,
  applyPercentDiscount,
  buildRedemptionWrites,
  classifyRedemptionError,
  clampDiscountPercent,
  COUPON_ERRORS,
  couponFinalPrice,
  couponTermEnd,
  discountPercentToBasisPoints,
  finite,
  isCodeLongEnough,
  isFullyCovered,
  isUsageLimitReached,
  isValidDate,
  isWithinActiveWindow,
  normalizeCouponCode,
  normalizeDiscountType,
  validateCoupon,
  type CouponValidationFields,
} from "../../../../packages/services/src/coupon-logic";

// ============================================================================
// PART A — pure logic (real exports)
// ============================================================================

describe("coupon-logic — finite()", () => {
  it("passes finite numbers through", () => {
    assert.equal(finite(42), 42);
    assert.equal(finite(0), 0);
    assert.equal(finite(-3.5), -3.5);
  });
  it("collapses null/undefined/NaN/±Infinity to the fallback", () => {
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(NaN, 7), 7);
  });
});

describe("coupon-logic — normalizeCouponCode()", () => {
  it("uppercases", () => {
    assert.equal(normalizeCouponCode("save20"), "SAVE20");
  });
  it("keeps already-uppercase unchanged", () => {
    assert.equal(normalizeCouponCode("SAVE20"), "SAVE20");
  });
  it("uppercases mixed case", () => {
    assert.equal(normalizeCouponCode("SaVe20"), "SAVE20");
  });
  it("trims surrounding whitespace (paste with trailing space still matches)", () => {
    assert.equal(normalizeCouponCode("  save20 "), "SAVE20");
    assert.equal(normalizeCouponCode("\tSAVE20\n"), "SAVE20");
  });
  it("returns '' for non-string / nullish input (defensive)", () => {
    assert.equal(normalizeCouponCode(null), "");
    assert.equal(normalizeCouponCode(undefined), "");
  });
});

describe("coupon-logic — isCodeLongEnough()", () => {
  it("rejects empty / short / whitespace-only (trim-aware)", () => {
    assert.equal(isCodeLongEnough(""), false);
    assert.equal(isCodeLongEnough("AB"), false);
    assert.equal(isCodeLongEnough("  A "), false); // trimmed length 1
    assert.equal(isCodeLongEnough("   "), false);
    assert.equal(isCodeLongEnough(null), false);
    assert.equal(isCodeLongEnough(undefined), false);
  });
  it("accepts >= 3 trimmed chars", () => {
    assert.equal(isCodeLongEnough("ABC"), true);
    assert.equal(isCodeLongEnough(" SAVE20 "), true);
  });
});

describe("coupon-logic — clampDiscountPercent() [REAL MONEY: > 100 / negative / non-finite]", () => {
  it("passes a normal percent through", () => {
    assert.equal(clampDiscountPercent(20), 20);
    assert.equal(clampDiscountPercent(0.1), 0.1);
    assert.equal(clampDiscountPercent(100), 100);
  });
  it("caps a > 100% coupon at 100 (can at most make the item free, never pay the buyer)", () => {
    assert.equal(clampDiscountPercent(150), 100);
    assert.equal(clampDiscountPercent(1000), 100);
  });
  it("floors a negative percent at 0 (a '-20%' coupon must NOT become a +20% surcharge)", () => {
    assert.equal(clampDiscountPercent(-20), 0);
    assert.equal(clampDiscountPercent(-0.0001), 0);
  });
  it("collapses NaN/±Infinity to 0 (fail closed — no free/garbage charge)", () => {
    // finite() runs FIRST: a non-finite percent collapses to 0 (NO discount /
    // full price), which is the SAFE posture — an Infinity coupon must never be
    // read as 100%-off (free). It is 0%-off.
    assert.equal(clampDiscountPercent(NaN), 0);
    assert.equal(clampDiscountPercent(Infinity), 0);
    assert.equal(clampDiscountPercent(-Infinity), 0);
    assert.equal(clampDiscountPercent(null), 0);
    assert.equal(clampDiscountPercent(undefined), 0);
  });
});

describe("coupon-logic — discountPercentToBasisPoints() [value forwarded to Dodo]", () => {
  it("matches admin Math.round(percent*100) for normal percents", () => {
    assert.equal(discountPercentToBasisPoints(20), 2000);
    assert.equal(discountPercentToBasisPoints(12.5), 1250);
    assert.equal(discountPercentToBasisPoints(0.1), 10);
    assert.equal(discountPercentToBasisPoints(100), 10000);
  });
  it("never emits a basis-points value outside [0, 10000] for corrupt percents", () => {
    assert.equal(discountPercentToBasisPoints(150), 10000); // capped at 100%
    assert.equal(discountPercentToBasisPoints(-50), 0); // floored
    assert.equal(discountPercentToBasisPoints(NaN), 0);
    // Non-finite ⇒ 0 (fail closed): a corrupt percent yields a 0bp (no-)discount
    // sent to Dodo, never a runaway 100%-off.
    assert.equal(discountPercentToBasisPoints(Infinity), 0);
    assert.equal(discountPercentToBasisPoints(-Infinity), 0);
  });
  it("always returns an integer (Dodo basis points)", () => {
    for (const p of [33.333, 66.666, 0.01, 99.999]) {
      const bp = discountPercentToBasisPoints(p);
      assert.ok(Number.isInteger(bp), `bp for ${p} must be integer, got ${bp}`);
    }
  });
});

describe("coupon-logic — applyDiscount() [REAL MONEY: final price never < 0, never inverts]", () => {
  it("percent: computes final price = price - percent*price", () => {
    const r = applyDiscount({
      price: 1000,
      type: "percent",
      discountPercent: 20,
    });
    assert.equal(r.originalPrice, 1000);
    assert.equal(r.discountAmount, 200);
    assert.equal(r.finalPrice, 800);
    assert.equal(r.applied, true);
  });

  it("100% percent ⇒ free (finalPrice 0), exactly, not negative", () => {
    const r = applyDiscount({
      price: 999,
      type: "percent",
      discountPercent: 100,
    });
    assert.equal(r.discountAmount, 999);
    assert.equal(r.finalPrice, 0);
  });

  it("> 100% percent does NOT invert to a charge-up — discount capped at price, finalPrice 0", () => {
    const r = applyDiscount({
      price: 500,
      type: "percent",
      discountPercent: 150,
    });
    assert.equal(r.discountAmount, 500); // not 750
    assert.equal(r.finalPrice, 0); // not -250
    assert.ok(r.finalPrice >= 0);
    assert.ok(r.finalPrice <= r.originalPrice);
  });

  it("negative percent ⇒ no discount (finalPrice === price), never a surcharge", () => {
    const r = applyDiscount({
      price: 500,
      type: "percent",
      discountPercent: -20,
    });
    assert.equal(r.discountAmount, 0);
    assert.equal(r.finalPrice, 500);
  });

  it("Infinity discountValue (flat) ⇒ fail closed to NO discount (full price), never NaN/negative", () => {
    // finite() collapses an Infinity flat discount to 0 — the safe posture: a
    // corrupt amount-off does not silently zero the charge. finalPrice stays the
    // full, finite price. (The cap/floor still GUARANTEE >=0 either way.)
    const r = applyDiscount({
      price: 1000,
      type: "flat",
      discountValue: Infinity,
    });
    assert.equal(r.discountAmount, 0);
    assert.equal(r.finalPrice, 1000);
    assert.ok(Number.isFinite(r.finalPrice));
    assert.ok(r.finalPrice >= 0);
  });

  it("NaN price ⇒ finite 0 (no NaN propagation)", () => {
    const r = applyDiscount({
      price: NaN,
      type: "percent",
      discountPercent: 20,
    });
    assert.equal(r.originalPrice, 0);
    assert.equal(r.discountAmount, 0);
    assert.equal(r.finalPrice, 0);
    assert.ok(Number.isFinite(r.finalPrice));
  });

  it("NaN discountPercent ⇒ no discount applied (price unchanged, finite)", () => {
    const r = applyDiscount({
      price: 1000,
      type: "percent",
      discountPercent: NaN,
    });
    assert.equal(r.discountAmount, 0);
    assert.equal(r.finalPrice, 1000);
  });

  it("flat: subtracts a fixed rupee amount, floored at 0", () => {
    assert.equal(
      applyDiscount({ price: 1000, type: "flat", discountValue: 300 })
        .finalPrice,
      700
    );
    // flat larger than price ⇒ free, never negative
    const r = applyDiscount({ price: 200, type: "flat", discountValue: 500 });
    assert.equal(r.discountAmount, 200);
    assert.equal(r.finalPrice, 0);
  });

  it("negative flat discountValue ⇒ no discount (never a surcharge)", () => {
    const r = applyDiscount({ price: 1000, type: "flat", discountValue: -300 });
    assert.equal(r.discountAmount, 0);
    assert.equal(r.finalPrice, 1000);
  });

  it("maxDiscount caps the rupee discount below the percent value", () => {
    // 50% of 1000 = 500, but capped at 150
    const r = applyDiscount({
      price: 1000,
      type: "percent",
      discountPercent: 50,
      maxDiscount: 150,
    });
    assert.equal(r.discountAmount, 150);
    assert.equal(r.finalPrice, 850);
  });

  it("non-finite maxDiscount is ignored (price cap still bounds the discount)", () => {
    const r = applyDiscount({
      price: 1000,
      type: "percent",
      discountPercent: 30,
      maxDiscount: NaN,
    });
    assert.equal(r.discountAmount, 300);
    assert.equal(r.finalPrice, 700);
  });

  it("minOrder NOT met ⇒ coupon does not apply (applied:false, full price charged)", () => {
    const r = applyDiscount({
      price: 400,
      type: "percent",
      discountPercent: 20,
      minOrder: 500,
    });
    assert.equal(r.applied, false);
    assert.equal(r.discountAmount, 0);
    assert.equal(r.finalPrice, 400);
  });

  it("minOrder met exactly ⇒ coupon applies (inclusive boundary)", () => {
    const r = applyDiscount({
      price: 500,
      type: "percent",
      discountPercent: 20,
      minOrder: 500,
    });
    assert.equal(r.applied, true);
    assert.equal(r.finalPrice, 400);
  });

  it("INVARIANT: for adversarial inputs, finalPrice is always finite, >= 0, and <= originalPrice", () => {
    const prices = [0, 1, 250, 1000, NaN, Infinity, -Infinity, -100];
    const pcts = [0, 1, 20, 100, 150, -50, NaN, Infinity, -Infinity];
    for (const price of prices) {
      for (const discountPercent of pcts) {
        const r = applyDiscount({ price, type: "percent", discountPercent });
        assert.ok(
          Number.isFinite(r.finalPrice),
          `finalPrice finite for price=${price} pct=${discountPercent}`
        );
        assert.ok(
          r.finalPrice >= 0,
          `finalPrice>=0 for price=${price} pct=${discountPercent}`
        );
        assert.ok(
          r.finalPrice <= r.originalPrice + 1e-9,
          `finalPrice<=original for price=${price} pct=${discountPercent}`
        );
        assert.ok(r.discountAmount >= 0);
        assert.ok(r.discountAmount <= r.originalPrice + 1e-9);
      }
    }
  });
});

describe("coupon-logic — applyPercentDiscount() convenience", () => {
  it("equals applyDiscount(...).finalPrice for the percent model", () => {
    assert.equal(applyPercentDiscount(1000, 20), 800);
    assert.equal(applyPercentDiscount(1000, 150), 0);
    assert.equal(applyPercentDiscount(1000, -10), 1000);
    assert.equal(applyPercentDiscount(NaN, 20), 0);
    // Infinity percent ⇒ fail closed to no discount ⇒ full price (finite).
    assert.equal(applyPercentDiscount(1000, Infinity), 1000);
  });
});

describe("coupon-logic — isUsageLimitReached() [off-by-one]", () => {
  it("null maxUsage is unlimited (never reached)", () => {
    assert.equal(isUsageLimitReached(null, 0), false);
    assert.equal(isUsageLimitReached(null, 999999), false);
  });
  it("exact boundary: Nth allowed, N+1 rejected (maxUsage 1)", () => {
    assert.equal(isUsageLimitReached(1, 0), false); // the single allowed use
    assert.equal(isUsageLimitReached(1, 1), true); // already consumed
  });
  it("exact boundary: maxUsage 5", () => {
    assert.equal(isUsageLimitReached(5, 4), false); // 5th use allowed
    assert.equal(isUsageLimitReached(5, 5), true); // 6th rejected
    assert.equal(isUsageLimitReached(5, 7), true); // over-used (data drift) rejected
  });
  it("corrupt currentUsage (NaN/null) fails CLOSED (treated as exhausted)", () => {
    assert.equal(isUsageLimitReached(5, NaN), true);
    assert.equal(isUsageLimitReached(5, null), true);
    assert.equal(isUsageLimitReached(5, undefined), true);
    assert.equal(isUsageLimitReached(5, Infinity), true);
  });
});

describe("coupon-logic — isValidDate()", () => {
  it("true for a real date", () => {
    assert.equal(isValidDate(new Date("2026-01-01T00:00:00Z")), true);
  });
  it("false for null / undefined / Invalid Date / non-Date", () => {
    assert.equal(isValidDate(null), false);
    assert.equal(isValidDate(undefined), false);
    assert.equal(isValidDate(new Date("garbage")), false);
  });
});

describe("coupon-logic — isWithinActiveWindow() [expiry boundary + Invalid-Date fail-closed]", () => {
  const now = new Date("2026-06-05T12:00:00Z");

  it("null bounds ⇒ always within window (open-ended coupon)", () => {
    assert.equal(isWithinActiveWindow(null, null, now), true);
  });
  it("expiry strictly in the past ⇒ NOT within (expired)", () => {
    assert.equal(
      isWithinActiveWindow(null, new Date("2020-01-01T00:00:00Z"), now),
      false
    );
  });
  it("expiry in the future ⇒ within", () => {
    assert.equal(
      isWithinActiveWindow(null, new Date("2030-01-01T00:00:00Z"), now),
      true
    );
  });
  it("EXACTLY at expiry ⇒ still within (live check is strict `<`)", () => {
    assert.equal(
      isWithinActiveWindow(null, new Date(now.getTime()), now),
      true
    );
  });
  it("one millisecond past expiry ⇒ NOT within", () => {
    assert.equal(
      isWithinActiveWindow(null, new Date(now.getTime() - 1), now),
      false
    );
  });
  it("Invalid-Date expiresAt fails CLOSED (invalid), NOT treated as always-valid", () => {
    assert.equal(
      isWithinActiveWindow(null, new Date("not-a-date"), now),
      false
    );
  });
  it("validFrom in the future ⇒ not yet started", () => {
    assert.equal(
      isWithinActiveWindow(new Date("2030-01-01T00:00:00Z"), null, now),
      false
    );
  });
  it("EXACTLY at validFrom ⇒ within (inclusive start)", () => {
    assert.equal(
      isWithinActiveWindow(new Date(now.getTime()), null, now),
      true
    );
  });
  it("Invalid-Date validFrom fails CLOSED", () => {
    assert.equal(isWithinActiveWindow(new Date("nope"), null, now), false);
  });
  it("Invalid `now` clock fails CLOSED (defensive)", () => {
    assert.equal(isWithinActiveWindow(null, null, new Date("bad")), false);
  });
});

// ── validateCoupon — the ordered gate (real export) ────────────────────────

function makeCoupon(
  overrides?: Partial<CouponValidationFields>
): CouponValidationFields {
  return {
    code: "SAVE20",
    name: "Save 20%",
    discountPercent: 20,
    isActive: true,
    expiresAt: null,
    maxUsage: null,
    currentUsage: 0,
    isUserSpecific: false,
    targetUserEmail: null,
    ...overrides,
  };
}

describe("coupon-logic — validateCoupon() plan-scope (MONEY-NEW)", () => {
  const T = new Date("2026-06-05T12:00:00Z");
  it("empty applicablePlans → valid for ANY plan (no target needed)", () => {
    const r = validateCoupon("SAVE20", makeCoupon({ applicablePlans: [] }), T);
    assert.equal(r.valid, true);
  });
  it("plan-scoped coupon REJECTS a non-matching target plan", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ applicablePlans: ["PRO"] }),
      T,
      { userEmail: null, existingRedemption: false, targetPlanId: "PREMIUM" }
    );
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.wrongPlan);
  });
  it("plan-scoped coupon REJECTS when no target plan is supplied", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ applicablePlans: ["PRO"] }),
      T,
      { userEmail: null, existingRedemption: false, targetPlanId: null }
    );
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.wrongPlan);
  });
  it("plan-scoped coupon ACCEPTS the matching plan + surfaces applicablePlans", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ applicablePlans: ["PRO", "PREMIUM"] }),
      T,
      { userEmail: null, existingRedemption: false, targetPlanId: "PRO" }
    );
    assert.equal(r.valid, true);
    assert.deepEqual(r.applicablePlans, ["PRO", "PREMIUM"]);
  });
});

describe("coupon-logic — validateCoupon() once-per-user (MONEY-872)", () => {
  const T = new Date("2026-06-05T12:00:00Z");

  it("rejects a NON-user-specific coupon the caller ALREADY redeemed (the bug: a promo reused by the same user on signup then upgrade)", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ isUserSpecific: false }),
      T,
      {
        userEmail: "a@b.com",
        existingRedemption: true,
        targetPlanId: null,
      }
    );
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.alreadyUsed);
  });

  it("allows a NON-user-specific coupon the caller has NOT yet redeemed", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ isUserSpecific: false }),
      T,
      {
        userEmail: "a@b.com",
        existingRedemption: false,
        targetPlanId: null,
      }
    );
    assert.equal(r.valid, true);
  });

  it("user-specific coupon already redeemed is still rejected (unchanged)", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ isUserSpecific: true, targetUserEmail: "a@b.com" }),
      T,
      { userEmail: "a@b.com", existingRedemption: true, targetPlanId: null }
    );
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.alreadyUsed);
  });
});

describe("coupon-logic — validateCoupon() billing-cycle scope (MONEY-865)", () => {
  const T = new Date("2026-06-05T12:00:00Z");
  it("empty applicableBillingPeriods → valid for BOTH cycles (no target needed)", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ applicableBillingPeriods: [] }),
      T
    );
    assert.equal(r.valid, true);
  });
  it("cycle-scoped coupon REJECTS the wrong billing period", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ applicableBillingPeriods: ["annual"] }),
      T,
      {
        userEmail: null,
        existingRedemption: false,
        targetBillingPeriod: "monthly",
      }
    );
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.wrongBillingPeriod);
  });
  it("cycle-scoped coupon REJECTS when no target period is supplied", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ applicableBillingPeriods: ["annual"] }),
      T,
      { userEmail: null, existingRedemption: false, targetBillingPeriod: null }
    );
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.wrongBillingPeriod);
  });
  it("cycle-scoped coupon ACCEPTS the matching cycle + surfaces the scope", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ applicableBillingPeriods: ["monthly", "annual"] }),
      T,
      {
        userEmail: null,
        existingRedemption: false,
        targetBillingPeriod: "annual",
      }
    );
    assert.equal(r.valid, true);
    assert.deepEqual(r.applicableBillingPeriods, ["monthly", "annual"]);
  });
});

describe("coupon-logic — couponTermEnd (auto-downgrade term, MONEY-NEW)", () => {
  const base = new Date("2026-06-05T12:00:00Z");
  it("monthly → +1 month", () => {
    const r = couponTermEnd("monthly", base);
    assert.equal(r.getUTCFullYear(), 2026);
    assert.equal(r.getUTCMonth(), 6); // July (0-indexed)
  });
  it("undefined/unknown period defaults to monthly (+1 month)", () => {
    assert.equal(couponTermEnd(undefined, base).getUTCMonth(), 6);
    assert.equal(couponTermEnd("weird", base).getUTCMonth(), 6);
  });
  it("annual → +1 year", () => {
    const r = couponTermEnd("annual", base);
    assert.equal(r.getUTCFullYear(), 2027);
    assert.equal(r.getUTCMonth(), 5); // June
  });
});

const NOW = new Date("2026-06-05T12:00:00Z");

describe("coupon-logic — normalizeDiscountType()", () => {
  it("maps exactly 'flat' to flat", () => {
    assert.equal(normalizeDiscountType("flat"), "flat");
  });
  it("maps everything else to percent (fail-safe default)", () => {
    assert.equal(normalizeDiscountType("percent"), "percent");
    assert.equal(normalizeDiscountType(null), "percent");
    assert.equal(normalizeDiscountType(undefined), "percent");
    assert.equal(normalizeDiscountType("FLAT"), "percent"); // case-sensitive
    assert.equal(normalizeDiscountType("garbage"), "percent");
  });
});

describe("coupon-logic — couponFinalPrice() + isFullyCovered() [skip decision]", () => {
  it("percent applies the percent off", () => {
    const r = couponFinalPrice(1999, {
      discountType: "percent",
      discountPercent: 20,
    });
    assert.equal(r.finalPrice, 1999 - 1999 * 0.2);
  });
  it("percent 100 → fully covered (skip payment)", () => {
    const coupon = { discountType: "percent", discountPercent: 100 };
    assert.equal(isFullyCovered(1999, coupon), true);
    assert.equal(couponFinalPrice(1999, coupon).finalPrice, 0);
  });
  it("percent 99 → NOT fully covered (still pays via Dodo)", () => {
    assert.equal(
      isFullyCovered(1999, { discountType: "percent", discountPercent: 99 }),
      false
    );
  });
  it("flat >= price → fully covered (skip payment)", () => {
    assert.equal(
      isFullyCovered(999, { discountType: "flat", discountAmount: 999 }),
      true
    );
    assert.equal(
      isFullyCovered(999, { discountType: "flat", discountAmount: 2000 }),
      true
    );
    assert.equal(
      couponFinalPrice(999, { discountType: "flat", discountAmount: 999 })
        .finalPrice,
      0
    );
  });
  it("flat < price → partial (final = price - flat, NOT skipped)", () => {
    const coupon = { discountType: "flat", discountAmount: 500 };
    assert.equal(couponFinalPrice(1999, coupon).finalPrice, 1499);
    assert.equal(isFullyCovered(1999, coupon), false);
  });
  it("legacy/garbage discountType is treated as percent", () => {
    assert.equal(
      couponFinalPrice(1000, { discountPercent: 50 }).finalPrice,
      500
    );
    assert.equal(isFullyCovered(1000, { discountPercent: 100 }), true);
  });
  it("non-finite / negative inputs never under/over-cover (money-safety)", () => {
    // NaN percent → fail-closed 0% → not covered
    assert.equal(
      isFullyCovered(1000, { discountType: "percent", discountPercent: NaN }),
      false
    );
    // Infinity flat → finite-guard collapses to 0 discount → price unchanged
    assert.equal(
      couponFinalPrice(1000, { discountType: "flat", discountAmount: Infinity })
        .finalPrice,
      1000
    );
    assert.equal(
      isFullyCovered(1000, { discountType: "flat", discountAmount: Infinity }),
      false
    );
    // negative flat → 0 discount → not covered (no charge-up)
    assert.equal(
      isFullyCovered(1000, { discountType: "flat", discountAmount: -500 }),
      false
    );
  });
  it("a zero base price reads as fully covered", () => {
    assert.equal(
      isFullyCovered(0, { discountType: "percent", discountPercent: 10 }),
      true
    );
  });
});

describe("coupon-logic — validateCoupon() [ordered gate]", () => {
  it("rejects empty code", () => {
    const r = validateCoupon("", null, NOW);
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.invalidCode);
  });
  it("rejects code shorter than 3 chars", () => {
    const r = validateCoupon("AB", null, NOW);
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.invalidCode);
  });
  it("rejects whitespace-only code shorter than 3 trimmed chars", () => {
    const r = validateCoupon("  A ", null, NOW);
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.invalidCode);
  });
  it("rejects coupon not found", () => {
    const r = validateCoupon("NOTEXIST", null, NOW);
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.notFound);
  });
  it("rejects inactive coupon", () => {
    const r = validateCoupon("SAVE20", makeCoupon({ isActive: false }), NOW);
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.inactive);
  });
  it("rejects expired coupon", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ expiresAt: new Date("2020-01-01T00:00:00Z") }),
      NOW
    );
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.expired);
  });
  it("accepts coupon expiring EXACTLY now (boundary)", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ expiresAt: new Date(NOW.getTime()) }),
      NOW
    );
    assert.equal(r.valid, true);
  });
  it("rejects coupon with Invalid-Date expiresAt (fail closed)", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ expiresAt: new Date("garbage") }),
      NOW
    );
    assert.equal(r.valid, false);
    assert.equal(r.error, COUPON_ERRORS.expired);
  });
  it("accepts coupon with future expiry / null expiry", () => {
    assert.equal(
      validateCoupon(
        "SAVE20",
        makeCoupon({ expiresAt: new Date("2030-01-01") }),
        NOW
      ).valid,
      true
    );
    assert.equal(
      validateCoupon("SAVE20", makeCoupon({ expiresAt: null }), NOW).valid,
      true
    );
  });
  it("rejects coupon AT max usage and OVER max usage", () => {
    assert.equal(
      validateCoupon(
        "SAVE20",
        makeCoupon({ maxUsage: 10, currentUsage: 10 }),
        NOW
      ).error,
      COUPON_ERRORS.usageLimit
    );
    assert.equal(
      validateCoupon(
        "SAVE20",
        makeCoupon({ maxUsage: 5, currentUsage: 7 }),
        NOW
      ).error,
      COUPON_ERRORS.usageLimit
    );
  });
  it("accepts the LAST allowed use (off-by-one boundary)", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ maxUsage: 10, currentUsage: 9 }),
      NOW
    );
    assert.equal(r.valid, true);
  });
  it("accepts unlimited (null maxUsage) regardless of currentUsage", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ maxUsage: null, currentUsage: 999 }),
      NOW
    );
    assert.equal(r.valid, true);
  });

  it("user-specific: rejects when no user email", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ isUserSpecific: true }),
      NOW,
      {
        userEmail: null,
        existingRedemption: false,
      }
    );
    assert.equal(r.error, COUPON_ERRORS.signIn);
  });
  it("user-specific: rejects with no user context at all", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ isUserSpecific: true }),
      NOW
    );
    assert.equal(r.error, COUPON_ERRORS.signIn);
  });
  it("user-specific (IDOR): rejects wrong email", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ isUserSpecific: true, targetUserEmail: "vip@example.com" }),
      NOW,
      { userEmail: "other@example.com", existingRedemption: false }
    );
    assert.equal(r.error, COUPON_ERRORS.wrongAccount);
  });
  it("user-specific: email match is CASE-INSENSITIVE (target stored lower, caller upper)", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ isUserSpecific: true, targetUserEmail: "vip@example.com" }),
      NOW,
      { userEmail: "VIP@Example.COM", existingRedemption: false }
    );
    assert.equal(r.valid, true);
  });
  it("user-specific: rejects when this caller already redeemed", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ isUserSpecific: true, targetUserEmail: "vip@example.com" }),
      NOW,
      { userEmail: "vip@example.com", existingRedemption: true }
    );
    assert.equal(r.error, COUPON_ERRORS.alreadyUsed);
  });
  it("user-specific: accepts matching email + no prior redemption, returns discount", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({
        isUserSpecific: true,
        targetUserEmail: "vip@example.com",
        discountPercent: 50,
      }),
      NOW,
      { userEmail: "vip@example.com", existingRedemption: false }
    );
    assert.equal(r.valid, true);
    assert.equal(r.discountPercent, 50);
  });
  it("user-specific: null targetUserEmail ⇒ any signed-in user", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ isUserSpecific: true, targetUserEmail: null }),
      NOW,
      { userEmail: "anyone@example.com", existingRedemption: false }
    );
    assert.equal(r.valid, true);
  });

  it("happy path: returns clamped discount + name", () => {
    const r = validateCoupon(
      "QUARTER25",
      makeCoupon({
        discountPercent: 25,
        name: "Quarter Off",
        code: "QUARTER25",
      }),
      NOW
    );
    assert.equal(r.valid, true);
    assert.equal(r.discountPercent, 25);
    assert.equal(r.couponName, "Quarter Off");
    assert.equal(r.error, undefined);
  });
  it("happy path: falls back to code when name is null", () => {
    const r = validateCoupon(
      "NONAME10",
      makeCoupon({ name: null, code: "NONAME10" }),
      NOW
    );
    assert.equal(r.couponName, "NONAME10");
  });
  it("SECURITY: a corrupt > 100% stored discountPercent is CLAMPED in the success payload (never echoed raw)", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ discountPercent: 250 }),
      NOW
    );
    assert.equal(r.valid, true);
    assert.equal(r.discountPercent, 100); // not 250
  });
  it("SECURITY: a corrupt negative discountPercent is floored to 0 in the success payload", () => {
    const r = validateCoupon(
      "SAVE20",
      makeCoupon({ discountPercent: -30 }),
      NOW
    );
    assert.equal(r.discountPercent, 0);
  });
});

// ── redemption write builder + error classifier (real exports) ─────────────

describe("coupon-logic — buildRedemptionWrites()", () => {
  it("builds the create-redemption data and the +1 usage increment keyed by coupon id", () => {
    const w = buildRedemptionWrites(
      "coupon-1",
      "user-1",
      "u@test.com",
      "pay-9"
    );
    assert.deepEqual(w.redemption.data, {
      couponId: "coupon-1",
      userId: "user-1",
      userEmail: "u@test.com",
      paymentId: "pay-9",
    });
    assert.deepEqual(w.usageIncrement.where, { id: "coupon-1" });
    assert.deepEqual(w.usageIncrement.data, { currentUsage: { increment: 1 } });
  });
  it("threads a null paymentId through", () => {
    const w = buildRedemptionWrites("c", "u", "e", null);
    assert.equal(
      (w.redemption.data as { paymentId: string | null }).paymentId,
      null
    );
  });
});

describe("coupon-logic — classifyRedemptionError()", () => {
  it("swallows a Prisma unique-constraint error as a duplicate (idempotent)", () => {
    const err = new Error(
      "Unique constraint failed on the fields: (`couponId`,`userId`)"
    );
    assert.deepEqual(classifyRedemptionError(err), { action: "duplicate" });
  });
  it("rethrows any other error", () => {
    const err = new Error("Database connection lost");
    const out = classifyRedemptionError(err);
    assert.equal(out.action, "rethrow");
    assert.equal((out as { error: Error }).error, err);
  });
  it("does NOT treat a partial 'Unique' (without 'constraint') as duplicate", () => {
    const err = new Error("Unique index violation on something else");
    assert.equal(classifyRedemptionError(err).action, "rethrow");
  });
  it("rethrows non-Error throwables", () => {
    assert.equal(classifyRedemptionError("boom").action, "rethrow");
    assert.equal(classifyRedemptionError(null).action, "rethrow");
  });
});

// ============================================================================
// PART B — LIVE service: recordCouponRedemption via recording-prisma seam
// ============================================================================

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

/**
 * Recording prisma double. `$transaction([...])` resolves the array exactly like
 * Prisma so the real create+increment ops execute and are recorded. A per-
 * `model.method` failure can be queued to drive the catch branches.
 */
class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();
  private readonly failures = new Map<string, Error>();

  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }

  fail(model: string, method: string, error: Error): void {
    this.failures.set(`${model}.${method}`, error);
  }

  private next(model: string, method: string): unknown {
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) return q.shift();
    if (method === "findUnique" || method === "findFirst") return null;
    if (method === "create" || method === "update" || method === "upsert")
      return {};
    if (method === "updateMany" || method === "deleteMany") return { count: 0 };
    return [];
  }

  readonly client: Record<string, unknown>;

  constructor() {
    const self = this;
    const model = (name: string) =>
      new Proxy(
        {},
        {
          get(_m, method: string) {
            return (args?: unknown) => {
              self.calls.push({ model: name, method, args });
              const err = self.failures.get(`${name}.${method}`);
              if (err) return Promise.reject(err);
              return Promise.resolve(self.next(name, method));
            };
          },
        }
      );
    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, prop: string) {
          if (typeof prop !== "string") return undefined;
          if (prop === "then") return undefined;
          if (prop === "$transaction") {
            return (arg: unknown) => {
              self.calls.push({
                model: "$transaction",
                method: "$transaction",
                args: arg,
              });
              if (typeof arg === "function") {
                return Promise.resolve(
                  (arg as (tx: unknown) => unknown)(self.client)
                );
              }
              // Array form: settle each op-promise; reject if any rejects (atomic).
              return Promise.all(arg as Promise<unknown>[]);
            };
          }
          if (!(prop in target)) target[prop] = model(prop);
          return target[prop];
        },
      }
    ) as Record<string, unknown>;
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SILENT_LOGGER = {
  debug() {},
  error() {},
  info() {},
  warn() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};

function makeLoggerStub(): Record<string, unknown> {
  const factory = () => SILENT_LOGGER;
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getLogger" || k === "default" || k === "createModuleLoggers")
          return factory;
        if (k === "initLogger" || k === "flushLogs")
          return async () => undefined;
        return SILENT_LOGGER;
      },
    }
  );
}

let activePrisma = new RecordingPrisma();

// A stable proxy installed once at the @usemoney/database boundary that always
// forwards to whichever `activePrisma` is current (swapped per test).
const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, prop: string) {
      if (typeof prop !== "string") return undefined;
      if (prop === "then") return undefined;
      if (prop === "$transaction") {
        return (arg: unknown) =>
          (
            activePrisma.client as { $transaction: (a: unknown) => unknown }
          ).$transaction(arg);
      }
      if (!(prop in target)) {
        target[prop] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                (
                  activePrisma.client[prop] as Record<
                    string,
                    (a?: unknown) => unknown
                  >
                )[method]!(args);
            },
          }
        );
      }
      return target[prop];
    },
  }
);

interface CouponServiceModule {
  recordCouponRedemption: (
    discountCode: string,
    userId: string,
    userEmail: string,
    paymentId?: string
  ) => Promise<void>;
}

let svc: CouponServiceModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): CouponServiceModule {
  if (svc) return svc;
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorCacheEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
  });
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  // The barrel pulls @usemoney/core (Redis/GCS) transitively; a light no-op keeps
  // requiring it from connecting anywhere.
  stub(
    require.resolve("@usemoney/core"),
    new Proxy(
      { __esModule: true },
      {
        get(_t, k: string) {
          if (k === "__esModule") return true;
          if (k === "getCached") return async () => null;
          return async () => {};
        },
      }
    )
  );
  // Drop any already-loaded service modules so they re-require with the stubs.
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") ||
        key.endsWith("/index.ts") ||
        key.endsWith("-logic.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // MONEY-1489 — the SUBPATH, never the "@usemoney/services" BARREL.
  //
  // This file was one of two killed at the 30s per-file timeout in CI (#713,
  // #727, #729), taking 106 cases with it while `# fail` stayed 0. Measured on
  // this tree: a cold `require("@usemoney/services")` costs **3817 ms** because
  // the barrel re-exports ~40 services and transitively loads @usemoney/core
  // (651 ms), @usemoney/research (829 ms), @usemoney/roast (231 ms) and
  // @react-pdf/renderer. The same require against `@usemoney/services/coupon`
  // costs **48 ms** — 79x less — and this suite uses exactly ONE export,
  // `recordCouponRedemption`, which lives in that file.
  //
  // NOTE the fix is NOT "hoist the require to module scope". Node treats each
  // FILE as a test, so `--test-timeout` is a per-file wall-clock budget that
  // covers module evaluation too — verified: a file that burns 5s at module
  // scope is cancelled by `--test-timeout=3000` exactly like one that burns it
  // inside `it()`. Moving the cost within the file moves nothing; only removing
  // it helps.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  svc = require("@usemoney/services/coupon") as CouponServiceModule;
  return svc;
}

function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  svc = null;
}

function swapPrisma(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  return activePrisma;
}

describe("coupon.service — recordCouponRedemption (LIVE fn, recording prisma)", () => {
  let mod: CouponServiceModule;
  let prisma: RecordingPrisma;

  before(() => {
    mod = installServices();
  });
  beforeEach(() => {
    prisma = swapPrisma();
  });
  after(() => {
    uninstallServices();
  });

  it("normalises the code (trim+upper) before looking the coupon up", async () => {
    prisma.queue("coupon", "findUnique", null); // not found ⇒ silent no-op
    await mod.recordCouponRedemption(
      "  save20 ",
      "user-1",
      "u@test.com",
      "pay-1"
    );
    const find = prisma.callsFor("coupon", "findUnique")[0];
    assert.ok(find, "expected coupon.findUnique");
    assert.deepEqual((find.args as { where: { code: string } }).where, {
      code: "SAVE20",
    });
  });

  it("no-ops silently when the coupon does not exist (no transaction)", async () => {
    prisma.queue("coupon", "findUnique", null);
    await mod.recordCouponRedemption("GHOST", "user-1", "u@test.com");
    assert.equal(prisma.callsFor("couponRedemption", "create").length, 0);
    assert.equal(prisma.callsFor("coupon", "update").length, 0);
  });

  it("on a found coupon: creates the redemption AND increments usage in ONE $transaction (atomic)", async () => {
    prisma.queue("coupon", "findUnique", { id: "coupon-1", code: "SAVE20" });
    await mod.recordCouponRedemption(
      "save20",
      "user-7",
      "buyer@test.com",
      "pay-42"
    );

    // Exactly ONE $transaction wrapped BOTH writes (the atomicity guarantee:
    // currentUsage can never drift from the redemption-row count).
    const txns = prisma.callsFor("$transaction", "$transaction");
    assert.equal(
      txns.length,
      1,
      "the redemption must run in a single $transaction"
    );
    assert.equal(
      (txns[0].args as unknown[]).length,
      2,
      "the transaction batches exactly the create + the usage increment"
    );

    const create = prisma.callsFor("couponRedemption", "create")[0];
    const update = prisma.callsFor("coupon", "update")[0];
    assert.ok(
      create,
      "expected couponRedemption.create inside the transaction"
    );
    assert.ok(
      update,
      "expected coupon.update (usage increment) inside the transaction"
    );

    assert.deepEqual((create.args as { data: unknown }).data, {
      couponId: "coupon-1",
      userId: "user-7",
      userEmail: "buyer@test.com",
      paymentId: "pay-42",
    });
    assert.deepEqual((update.args as { where: unknown; data: unknown }).where, {
      id: "coupon-1",
    });
    assert.deepEqual((update.args as { where: unknown; data: unknown }).data, {
      currentUsage: { increment: 1 },
    });
  });

  it("threads a missing paymentId through as null", async () => {
    prisma.queue("coupon", "findUnique", { id: "coupon-2", code: "X" });
    await mod.recordCouponRedemption("XXX", "user-1", "u@test.com");
    const create = prisma.callsFor("couponRedemption", "create")[0];
    assert.equal(
      (create.args as { data: { paymentId: string | null } }).data.paymentId,
      null
    );
  });

  it("SECURITY/idempotency: swallows a unique-constraint error (duplicate redemption — no throw)", async () => {
    prisma.queue("coupon", "findUnique", { id: "coupon-3", code: "DUP" });
    // The transaction (couponRedemption.create) rejects with the unique violation.
    prisma.fail(
      "couponRedemption",
      "create",
      new Error("Unique constraint failed on the fields: (`couponId`,`userId`)")
    );
    await assert.doesNotReject(
      mod.recordCouponRedemption("DUP", "user-1", "u@test.com", "pay-1")
    );
  });

  it("propagates a non-unique-constraint error (real failure must NOT be swallowed)", async () => {
    prisma.queue("coupon", "findUnique", { id: "coupon-4", code: "ERR" });
    prisma.fail(
      "couponRedemption",
      "create",
      new Error("Database connection lost")
    );
    await assert.rejects(
      mod.recordCouponRedemption("ERR", "user-1", "u@test.com"),
      /Database connection lost/
    );
  });
});
