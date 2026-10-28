import { z } from "zod";

/**
 * MONEY-872: coupon admin input validation — PERCENTAGE-ONLY.
 *
 * Fixed-value (flat ₹) discounts were REMOVED across the board: Dodo (the payment
 * provider) only supports percentage discounts — its API 422s on a "flat" variant
 * ("unknown variant `flat`, expected `percentage`") — so a flat coupon could never
 * apply on a paid checkout. Every coupon is a percentage now.
 *
 * Shape note: the admin form submits the FULL object with `null` for empty
 * optionals, so every optional scalar is `.nullish()` (accepts null AND
 * undefined). `.optional()` alone rejects `null` ("Expected <type>, received
 * null") and 500s the Server Action.
 */
export const CouponCreateSchema = z
  .object({
    code: z.string().trim().min(3, "Coupon code must be at least 3 characters"),
    name: z.string().trim().nullish(),
    discountPercent: z
      .number()
      .finite()
      .min(0.1, "Discount must be between 0.1% and 100%")
      .max(100, "Discount must be between 0.1% and 100%"),
    applicablePlans: z.array(z.string()).nullish(),
    applicableBillingPeriods: z.array(z.string()).nullish(),
    // null/undefined = unlimited; a finite cap MUST be a positive integer.
    maxUsage: z.number().int().positive().nullish(),
    expiresAt: z.string().nullish(),
    isUserSpecific: z.boolean(),
    targetUserEmail: z.string().trim().email().nullish(),
  })
  .superRefine((data, ctx) => {
    if (data.isUserSpecific && !data.targetUserEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetUserEmail"],
        message: "User-specific coupons require a target email address",
      });
    }
  });

export type CouponCreateInput = z.infer<typeof CouponCreateSchema>;

export const CouponUpdateSchema = z.object({
  name: z.string().trim().nullish(),
  discountPercent: z.number().finite().min(0.1).max(100).nullish(),
  applicablePlans: z.array(z.string()).nullish(),
  applicableBillingPeriods: z.array(z.string()).nullish(),
  maxUsage: z.number().int().positive().nullish(),
  expiresAt: z.string().nullish(),
  isActive: z.boolean().optional(),
});

export type CouponUpdateInput = z.infer<typeof CouponUpdateSchema>;
