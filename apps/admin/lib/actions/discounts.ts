"use server";

import { requireAdmin } from "@/lib/auth";
import { auth, clerkClient } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { getDodoClient, isDodoConfigured, getDodoMode } from "@usemoney/core";
import {
  recordAdminAction,
  buildDodoDiscountParams,
  couponDisplayStatus,
  type CouponDisplayStatus,
} from "@usemoney/services";
import { CouponCreateSchema, CouponUpdateSchema } from "@usemoney/validation";

async function getAdminEmail(): Promise<string | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  return (
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress ?? null
  );
}

// ── Types ──

export interface CouponData {
  id: string;
  code: string;
  dodoDiscountId: string | null;
  name: string | null;
  // MONEY-865: "percent" (use discountPercent) | "flat" (use discountAmount ₹).
  discountType: string;
  discountPercent: number;
  discountAmount: number | null;
  // Target-plan scope; empty = any plan.
  applicablePlans: string[];
  // Billing-cycle scope; empty = both monthly + annual.
  applicableBillingPeriods: string[];
  maxUsage: number | null;
  currentUsage: number;
  expiresAt: string | null;
  isActive: boolean;
  isUserSpecific: boolean;
  targetUserEmail: string | null;
  createdBy: string | null;
  createdAt: string;
  // MONEY-866: effective live status (active/paused/exhausted/expired) computed
  // server-side via the shared couponDisplayStatus — single source for the pill,
  // replacing the client's inline re-derivation.
  displayStatus: CouponDisplayStatus;
}

export interface CouponRedemptionData {
  id: string;
  userEmail: string;
  paymentId: string | null;
  redeemedAt: string;
}

export interface CouponsResult {
  coupons: CouponData[];
  configured: boolean;
  mode: string;
}

function toCouponData(c: {
  id: string;
  code: string;
  dodoDiscountId: string | null;
  name: string | null;
  discountType: string;
  discountPercent: number;
  discountAmount: number | null;
  applicablePlans: string[];
  applicableBillingPeriods: string[];
  maxUsage: number | null;
  currentUsage: number;
  expiresAt: Date | null;
  isActive: boolean;
  isUserSpecific: boolean;
  targetUserEmail: string | null;
  createdBy: string | null;
  createdAt: Date;
}): CouponData {
  return {
    id: c.id,
    code: c.code,
    dodoDiscountId: c.dodoDiscountId,
    name: c.name,
    discountType: c.discountType,
    discountPercent: c.discountPercent,
    discountAmount: c.discountAmount,
    applicablePlans: c.applicablePlans,
    applicableBillingPeriods: c.applicableBillingPeriods,
    maxUsage: c.maxUsage,
    currentUsage: c.currentUsage,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    isActive: c.isActive,
    isUserSpecific: c.isUserSpecific,
    targetUserEmail: c.targetUserEmail,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
    displayStatus: couponDisplayStatus(c, new Date()),
  };
}

// ── List Coupons ──

export async function listCoupons(): Promise<CouponsResult> {
  await requireAdmin();

  const coupons = await prisma.coupon.findMany({
    orderBy: { createdAt: "desc" },
  });

  return {
    coupons: coupons.map(toCouponData),
    configured: isDodoConfigured(),
    mode: getDodoMode(),
  };
}

// ── Create Coupon ──

export async function createCoupon(data: {
  code: string;
  name?: string;
  // MONEY-872: percentage-only (fixed-value coupons removed — Dodo supports % only).
  discountPercent?: number;
  applicablePlans?: string[]; // target-plan scope; empty/undefined = any plan
  applicableBillingPeriods?: string[]; // billing-cycle scope; empty = both cycles
  maxUsage?: number;
  expiresAt?: string;
  isUserSpecific: boolean;
  targetUserEmail?: string;
}): Promise<CouponData> {
  await requireAdmin();
  const adminEmail = await getAdminEmail();

  // MONEY-872: single-source validation (percentage-only).
  const parsed = CouponCreateSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid coupon input");
  }

  const code = data.code.toUpperCase();
  const discountPercent = data.discountPercent ?? 0;

  // Check for existing coupon with same code
  const existing = await prisma.coupon.findUnique({ where: { code } });
  if (existing) {
    throw new Error(`Coupon code "${code}" already exists`);
  }

  // For user-specific coupons, force maxUsage = 1
  const maxUsage = data.isUserSpecific ? 1 : (data.maxUsage ?? null);

  // Create the Dodo percentage discount. Wrapped so a Dodo hiccup never blocks the
  // LOCAL coupon — the local Coupon row is the source of truth for validation + the
  // fully-covered ₹0 skip; the Dodo discount applies the % on the checkout page.
  let dodoDiscountId: string | null = null;
  if (isDodoConfigured()) {
    try {
      const client = getDodoClient();
      const dodoParams = buildDodoDiscountParams({
        discountPercent,
        code,
        name: data.name,
        expiresAt: data.expiresAt,
        maxUsage,
      });
      const dodoResult = await client.discounts.create(
        dodoParams as unknown as Parameters<typeof client.discounts.create>[0],
      );
      dodoDiscountId = dodoResult.discount_id;
    } catch (err) {
      console.warn(
        "[Coupon] Dodo discount create failed; persisting local-only:",
        err,
      );
    }
  }

  // Resolve target user ID if user-specific
  let targetUserId: string | null = null;
  if (data.isUserSpecific && data.targetUserEmail) {
    const targetUser = await prisma.user.findUnique({
      where: { email: data.targetUserEmail.toLowerCase() },
    });
    if (targetUser) {
      targetUserId = targetUser.id;
    }
  }

  // Create in local DB
  const coupon = await prisma.coupon.create({
    data: {
      code,
      // MONEY-872: dodoDiscountId is @unique; MongoDB rejects a 2nd null. A coupon
      // whose Dodo create FAILED persists null and would collide on the next such
      // one, so store a unique non-Dodo sentinel (the code is @unique). dodoLinked
      // below reads the real (null) variable, so a sentinel never reads as linked.
      dodoDiscountId: dodoDiscountId ?? `local:${code}`,
      name: data.name || null,
      discountType: "percent",
      discountPercent,
      discountAmount: null,
      applicablePlans: data.applicablePlans ?? [],
      applicableBillingPeriods: data.applicableBillingPeriods ?? [],
      maxUsage,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      isUserSpecific: data.isUserSpecific,
      targetUserEmail: data.targetUserEmail?.toLowerCase() ?? null,
      targetUserId,
      createdBy: adminEmail,
    },
  });

  await recordAdminAction({
    actorEmail: adminEmail ?? "unknown",
    action: "coupon.create",
    targetType: "Coupon",
    targetId: coupon.code,
    diff: {
      discountPercent,
      applicablePlans: data.applicablePlans ?? [],
      applicableBillingPeriods: data.applicableBillingPeriods ?? [],
      maxUsage,
      isUserSpecific: data.isUserSpecific,
      dodoLinked: dodoDiscountId !== null,
    },
  });

  return toCouponData(coupon);
}

// ── Edit Coupon ──

// Adjust an existing coupon. `code`, `isUserSpecific`, and `targetUserEmail` are
// immutable (the code is the unique key + the Dodo discount code; changing scope
// after issuance is unsafe). Discount-affecting changes (type/amount/expiry/
// usage) recreate the linked Dodo discount in place (Dodo discounts aren't
// editable) — best-effort, mirroring create.
export async function updateCoupon(
  couponId: string,
  data: {
    name?: string | null;
    discountPercent?: number;
    maxUsage?: number | null;
    expiresAt?: string | null;
    applicablePlans?: string[];
    applicableBillingPeriods?: string[];
  },
): Promise<CouponData> {
  await requireAdmin();
  const adminEmail = await getAdminEmail();

  const existing = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!existing) {
    throw new Error("Coupon not found");
  }

  // MONEY-866: validate the input change-set (maxUsage positivity + discount
  // finiteness) via the shared schema before merging with the existing row.
  const parsedUpdate = CouponUpdateSchema.safeParse(data);
  if (!parsedUpdate.success) {
    throw new Error(
      parsedUpdate.error.issues[0]?.message ?? "Invalid coupon input",
    );
  }

  // Resolve the new effective values, falling back to the existing row.
  // MONEY-872: percentage-only.
  const discountPercent = data.discountPercent ?? existing.discountPercent;
  const maxUsage =
    data.maxUsage !== undefined ? data.maxUsage : existing.maxUsage;
  const expiresAt =
    data.expiresAt !== undefined
      ? data.expiresAt
        ? new Date(data.expiresAt)
        : null
      : existing.expiresAt;
  const applicablePlans = data.applicablePlans ?? existing.applicablePlans;
  const applicableBillingPeriods =
    data.applicableBillingPeriods ?? existing.applicableBillingPeriods;
  const name = data.name !== undefined ? data.name || null : existing.name;

  if (!discountPercent || discountPercent <= 0 || discountPercent > 100) {
    throw new Error("Discount must be between 0.1% and 100%");
  }

  // Recreate the Dodo discount if a Dodo-affecting field changed (Dodo discounts
  // aren't editable). Skip a `local:` sentinel — it has no real Dodo discount.
  let dodoDiscountId = existing.dodoDiscountId;
  const dodoAffecting =
    discountPercent !== existing.discountPercent ||
    (expiresAt?.getTime() ?? null) !==
      (existing.expiresAt?.getTime() ?? null) ||
    maxUsage !== existing.maxUsage;
  if (
    existing.dodoDiscountId &&
    !existing.dodoDiscountId.startsWith("local:") &&
    isDodoConfigured() &&
    dodoAffecting
  ) {
    try {
      const client = getDodoClient();
      await client.discounts.delete(existing.dodoDiscountId);
      const dodoParams = buildDodoDiscountParams({
        discountPercent,
        code: existing.code,
        name,
        expiresAt: expiresAt?.toISOString(),
        maxUsage,
      });
      const recreated = await client.discounts.create(
        dodoParams as unknown as Parameters<typeof client.discounts.create>[0],
      );
      dodoDiscountId = recreated.discount_id;
    } catch (err) {
      console.warn("[Coupon] Dodo discount update failed; local-only:", err);
    }
  }

  const coupon = await prisma.coupon.update({
    where: { id: couponId },
    data: {
      name,
      discountType: "percent",
      discountPercent,
      discountAmount: null,
      maxUsage,
      expiresAt,
      applicablePlans,
      applicableBillingPeriods,
      dodoDiscountId,
    },
  });

  await recordAdminAction({
    actorEmail: adminEmail ?? "unknown",
    action: "coupon.update",
    targetType: "Coupon",
    targetId: coupon.code,
    diff: {
      discountPercent,
      maxUsage,
      applicablePlans,
      applicableBillingPeriods,
    },
  });

  return toCouponData(coupon);
}

// ── Deactivate Coupon ──

export async function deactivateCoupon(couponId: string): Promise<void> {
  await requireAdmin();
  const adminEmail = await getAdminEmail();

  const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!coupon) {
    throw new Error("Coupon not found");
  }

  // Delete from Dodo if it exists there
  if (
    coupon.dodoDiscountId &&
    !coupon.dodoDiscountId.startsWith("local:") &&
    isDodoConfigured()
  ) {
    try {
      const client = getDodoClient();
      await client.discounts.delete(coupon.dodoDiscountId);
    } catch (err) {
      // If already deleted from Dodo, continue with local deactivation
      console.warn("Failed to delete from Dodo (may already be deleted):", err);
    }
  }

  await prisma.coupon.update({
    where: { id: couponId },
    data: { isActive: false },
  });

  await recordAdminAction({
    actorEmail: adminEmail ?? "unknown",
    action: "coupon.deactivate",
    targetType: "Coupon",
    targetId: coupon.code,
  });
}

// ── Pause / Resume (toggle active status) ──

// Flips `isActive` only — does NOT touch the linked Dodo discount, so Resume is
// a clean inverse of Pause. Safe because the web checkout calls
// validateCouponState() (rejects `!isActive`) BEFORE ever forwarding the code to
// Dodo, so a paused coupon can't be redeemed regardless of its Dodo state.
export async function setCouponActive(
  couponId: string,
  isActive: boolean,
): Promise<void> {
  await requireAdmin();
  const adminEmail = await getAdminEmail();

  const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!coupon) {
    throw new Error("Coupon not found");
  }

  await prisma.coupon.update({
    where: { id: couponId },
    data: { isActive },
  });

  await recordAdminAction({
    actorEmail: adminEmail ?? "unknown",
    action: isActive ? "coupon.resume" : "coupon.pause",
    targetType: "Coupon",
    targetId: coupon.code,
  });
}

// ── Hard delete ──

// Permanently removes the coupon (local row + linked Dodo discount). Refuses if
// it has any redemptions — those are part of the billing/audit trail and a
// CouponRedemption row references this coupon; pause it instead.
export async function deleteCoupon(
  couponId: string,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();
  const adminEmail = await getAdminEmail();

  const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!coupon) {
    return { success: false, error: "Coupon not found." };
  }

  const redemptions = await prisma.couponRedemption.count({
    where: { couponId },
  });
  if (redemptions > 0) {
    // RETURN (don't throw): a thrown Server Action error is opaqued by Next into a
    // generic boundary message, so the admin would only see "Couldn't delete the
    // coupon". This reason is known + user-safe — return it so the UI shows it.
    return {
      success: false,
      error:
        "This coupon has already been redeemed and can't be deleted — Suspend it instead.",
    };
  }

  // Remove the linked Dodo discount first (best-effort).
  if (
    coupon.dodoDiscountId &&
    !coupon.dodoDiscountId.startsWith("local:") &&
    isDodoConfigured()
  ) {
    try {
      const client = getDodoClient();
      await client.discounts.delete(coupon.dodoDiscountId);
    } catch (err) {
      console.warn("Failed to delete from Dodo (may already be deleted):", err);
    }
  }

  await prisma.coupon.delete({ where: { id: couponId } });

  await recordAdminAction({
    actorEmail: adminEmail ?? "unknown",
    action: "coupon.delete",
    targetType: "Coupon",
    targetId: coupon.code,
  });

  return { success: true };
}

// ── Get Coupon Usage History ──

export async function getCouponUsage(
  couponId: string,
): Promise<CouponRedemptionData[]> {
  await requireAdmin();

  const redemptions = await prisma.couponRedemption.findMany({
    where: { couponId },
    orderBy: { redeemedAt: "desc" },
  });

  return redemptions.map((r) => ({
    id: r.id,
    userEmail: r.userEmail,
    paymentId: r.paymentId,
    redeemedAt: r.redeemedAt.toISOString(),
  }));
}
