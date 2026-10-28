/**
 * MONEY-866/872 — coupon admin validation (PERCENTAGE-ONLY; fixed-value removed).
 * Covers the audit money-safety gaps (a 0 / negative / fractional maxUsage was
 * accepted) AND the MONEY-872 regression (the admin form sends `null` for empty
 * optionals, which `.optional()` rejected → production 500).
 *
 * Source: packages/validation/src/coupon.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CouponCreateSchema, CouponUpdateSchema } from "@usemoney/validation";

const base = { code: "SAVE20", isUserSpecific: false } as const;
const ok = (v: unknown) => CouponCreateSchema.safeParse(v).success;

describe("MONEY-866 CouponCreateSchema — money-safety", () => {
  it("accepts a valid percent coupon", () => {
    assert.equal(ok({ ...base, discountPercent: 20 }), true);
  });

  it("rejects maxUsage = 0 (dead-on-arrival)", () => {
    assert.equal(ok({ ...base, discountPercent: 20, maxUsage: 0 }), false);
  });

  it("rejects negative / fractional maxUsage", () => {
    assert.equal(ok({ ...base, discountPercent: 20, maxUsage: -5 }), false);
    assert.equal(ok({ ...base, discountPercent: 20, maxUsage: 2.5 }), false);
  });

  it("accepts unlimited (maxUsage omitted / null)", () => {
    assert.equal(ok({ ...base, discountPercent: 20 }), true);
    assert.equal(ok({ ...base, discountPercent: 20, maxUsage: null }), true);
  });

  it("rejects percent > 100, <= 0, or missing (required)", () => {
    assert.equal(ok({ ...base, discountPercent: 150 }), false);
    assert.equal(ok({ ...base, discountPercent: 0 }), false);
    assert.equal(ok({ ...base }), false); // no discountPercent at all
  });

  it("rejects code shorter than 3 chars", () => {
    assert.equal(
      ok({ code: "AB", isUserSpecific: false, discountPercent: 20 }),
      false
    );
  });

  it("requires targetUserEmail for user-specific coupons", () => {
    assert.equal(
      ok({ code: "VIP", isUserSpecific: true, discountPercent: 20 }),
      false
    );
    assert.equal(
      ok({
        code: "VIP",
        isUserSpecific: true,
        targetUserEmail: "a@b.com",
        discountPercent: 20,
      }),
      true
    );
  });
});

describe("MONEY-866 CouponUpdateSchema", () => {
  it("rejects maxUsage = 0 / negative", () => {
    assert.equal(CouponUpdateSchema.safeParse({ maxUsage: 0 }).success, false);
    assert.equal(CouponUpdateSchema.safeParse({ maxUsage: -1 }).success, false);
  });

  it("accepts a partial valid update", () => {
    assert.equal(
      CouponUpdateSchema.safeParse({ discountPercent: 30 }).success,
      true
    );
    assert.equal(CouponUpdateSchema.safeParse({ maxUsage: 10 }).success, true);
  });
});

describe("MONEY-872 — the FULL admin-form payload (null for empty optionals)", () => {
  // RCA of why the earlier tests missed the production 500: they fed minimal
  // synthetic objects ({ discountPercent: 30 }), so they NEVER sent `name: null`.
  // The admin form submits the ENTIRE object with `null` for empty optionals —
  // which `.optional()` rejected ("Expected string, received null").
  it("UPDATE: a coupon with NO name (name:null) is accepted", () => {
    const r = CouponUpdateSchema.safeParse({
      name: null,
      discountPercent: 20,
      applicablePlans: ["PRO", "PREMIUM"],
      applicableBillingPeriods: ["monthly", "annual"],
      maxUsage: 2,
      expiresAt: "2026-06-25T16:40",
      isActive: true,
    });
    assert.equal(r.success, true);
  });

  it("CREATE: a coupon with name:null + targetUserEmail:null is accepted", () => {
    const r = CouponCreateSchema.safeParse({
      code: "SAVE25",
      name: null,
      discountPercent: 25,
      applicablePlans: ["PRO", "PREMIUM"],
      applicableBillingPeriods: ["monthly", "annual"],
      maxUsage: 2,
      expiresAt: "2026-06-25T16:43",
      isUserSpecific: false,
      targetUserEmail: null,
    });
    assert.equal(r.success, true);
  });
});
