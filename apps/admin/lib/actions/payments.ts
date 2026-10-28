"use server";

import { requireAdmin, getAdminActorEmail } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { recordAdminAction, applyPlanGrant } from "@usemoney/services";
import type { PaymentStatus } from "@usemoney/database";

const PAGE_SIZE = 50;
// applyPlanGrant uses the base-plan grant path (updateSubscriptionPlan, no
// addon). Pack fulfillment (QUERY_PACK / CREDIT_PACK_*) is webhook-only.
const BASE_PLANS = new Set(["PRO", "PREMIUM", "ULTIMATE"]);

export interface PaymentRow {
  id: string;
  userEmail: string;
  amount: number;
  currency: string;
  status: string;
  planId: string;
  planName: string;
  period: string;
  dodoPaymentId: string | null;
  invoiceUrl: string | null;
  appliedAt: string | null;
  paidAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export async function listPayments(filters?: {
  status?: string;
  email?: string;
  skip?: number;
}): Promise<{ rows: PaymentRow[]; total: number }> {
  await requireAdmin();

  let userId: string | undefined;
  if (filters?.email) {
    const user = await prisma.user.findUnique({
      where: { email: filters.email.toLowerCase() },
      select: { id: true },
    });
    if (!user) return { rows: [], total: 0 };
    userId = user.id;
  }

  const where = {
    ...(filters?.status ? { status: filters.status as PaymentStatus } : {}),
    ...(userId ? { userId } : {}),
  };

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: filters?.skip ?? 0,
      include: { user: { select: { email: true } } },
    }),
    prisma.payment.count({ where }),
  ]);

  return {
    rows: payments.map((p) => ({
      id: p.id,
      userEmail: p.user.email,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      planId: p.planId,
      planName: p.planName,
      period: p.period,
      dodoPaymentId: p.dodoPaymentId,
      invoiceUrl: p.invoiceUrl,
      appliedAt: p.appliedAt?.toISOString() ?? null,
      paidAt: p.paidAt?.toISOString() ?? null,
      errorMessage: p.errorMessage,
      createdAt: p.createdAt.toISOString(),
    })),
    total,
  };
}

/**
 * Failover for a stuck PENDING base-plan payment (webhook outage): grant the
 * plan via the shared, idempotent applyPlanGrant (same appliedAt claim as the
 * webhook) and flip the row to COMPLETED. Packs are NOT supported here.
 */
export async function markPaymentComplete(
  paymentId: string,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();
  const actor = await getAdminActorEmail();

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { user: { select: { email: true } } },
  });
  if (!payment) return { success: false, error: "Payment not found" };
  if (payment.status === "COMPLETED") {
    return { success: false, error: "Payment is already completed" };
  }
  if (!BASE_PLANS.has(payment.planId)) {
    return {
      success: false,
      error:
        "Manual completion supports base plans only (PRO/PREMIUM/ULTIMATE); packs are webhook-only.",
    };
  }

  const grant = await applyPlanGrant({
    userId: payment.userId,
    userEmail: payment.user.email,
    planId: payment.planId,
    paymentId: payment.id,
  });
  if (!grant.success) {
    return { success: false, error: grant.error ?? "Plan grant failed" };
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "COMPLETED", paidAt: payment.paidAt ?? new Date() },
  });

  await recordAdminAction({
    actorEmail: actor,
    action: "payment.markComplete",
    targetType: "Payment",
    targetId: payment.id,
    diff: {
      planId: payment.planId,
      userEmail: payment.user.email,
      alreadyApplied: !grant.applied,
    },
  });

  return { success: true };
}
