"use server";

import { requireAdmin, getAdminActorEmail } from "@/lib/auth";
import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import {
  recordAdminAction,
  updateSubscriptionPlan,
  queueAccountDeletion,
} from "@usemoney/services";
import type { PlanType } from "@usemoney/database";

const PAGE_SIZE = 50;

export interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  planId: string;
  status: string;
  brokersConnected: number;
  createdAt: string;
}

export async function listMembers(filters?: {
  email?: string;
  plan?: string;
  skip?: number;
}): Promise<{ rows: MemberRow[]; total: number }> {
  await requireAdmin();

  const where = {
    ...(filters?.email
      ? { email: { contains: filters.email.toLowerCase() } }
      : {}),
    ...(filters?.plan
      ? { subscription: { is: { planId: filters.plan as PlanType } } }
      : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: filters?.skip ?? 0,
      include: {
        subscription: { select: { planId: true, status: true } },
        _count: { select: { brokerConnections: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    rows: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name ?? null,
      planId: u.subscription?.planId ?? "FREE",
      status: u.subscription?.status ?? "—",
      brokersConnected: u._count.brokerConnections,
      createdAt: u.createdAt.toISOString(),
    })),
    total,
  };
}

export interface MemberDetail {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  subscription: {
    planId: string;
    status: string;
    billingPeriod: string | null;
    startDate: string;
    endDate: string | null;
    nextBillingDate: string | null;
    creditsUsed: number;
    creditsLimit: number;
  } | null;
  brokers: {
    broker: string;
    status: string;
    brokerUserId: string | null;
    lastSync: string | null;
  }[];
  payments: {
    id: string;
    amount: number;
    status: string;
    planName: string;
    createdAt: string;
  }[];
}

export async function getMemberDetail(
  userId: string,
): Promise<MemberDetail | null> {
  await requireAdmin();

  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      subscription: true,
      brokerConnections: { orderBy: { createdAt: "desc" } },
      payments: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!u) return null;

  return {
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    createdAt: u.createdAt.toISOString(),
    subscription: u.subscription
      ? {
          planId: u.subscription.planId,
          status: u.subscription.status,
          billingPeriod: u.subscription.billingPeriod,
          startDate: u.subscription.startDate.toISOString(),
          endDate: u.subscription.endDate?.toISOString() ?? null,
          nextBillingDate:
            u.subscription.nextBillingDate?.toISOString() ?? null,
          creditsUsed: u.subscription.creditsUsed,
          creditsLimit: u.subscription.creditsLimit,
        }
      : null,
    brokers: u.brokerConnections.map((b) => ({
      broker: b.broker,
      status: b.status,
      brokerUserId: b.brokerUserId,
      lastSync: b.lastSync?.toISOString() ?? null,
    })),
    payments: u.payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      status: p.status,
      planName: p.planName,
      createdAt: p.createdAt.toISOString(),
    })),
  };
}

/** Switch / extend a member's plan via the shared service (audited). */
export async function setMemberPlan(
  userId: string,
  planId: string,
  billingPeriod?: string,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();
  const actor = await getAdminActorEmail();

  const before = await prisma.subscription.findUnique({
    where: { userId },
    select: { planId: true },
  });

  const result = await updateSubscriptionPlan(
    userId,
    planId,
    false,
    billingPeriod,
  );
  if (!result.success) {
    return { success: false, error: result.error ?? "Failed to update plan" };
  }

  await recordAdminAction({
    actorEmail: actor,
    action: "subscription.switchPlan",
    targetType: "User",
    targetId: userId,
    diff: { from: before?.planId ?? null, to: planId, billingPeriod },
  });

  return { success: true };
}

/**
 * Queue an account deletion the SAFE way — the existing account-deletion
 * service captures the audit snapshot, writes a DeletedUserAudit row, and
 * hands off to the worker (avoiding the Prisma 5s cascade tx-timeout from
 * MONEY-654). Never hand-rolls the cascade here.
 */
export async function softDeleteMember(
  userId: string,
  reason: string,
): Promise<{ success: boolean; error?: string }> {
  await requireAdmin();
  const actor = await getAdminActorEmail();
  const { userId: adminClerkId } = await auth();

  const result = await queueAccountDeletion({
    userId,
    deletedBy: "admin",
    adminUserId: adminClerkId ?? undefined,
    reason: reason || "Admin-initiated deletion",
  });
  if (!result.success) {
    return {
      success: false,
      error: result.error ?? "Failed to queue deletion",
    };
  }

  await recordAdminAction({
    actorEmail: actor,
    action: "user.softDelete",
    targetType: "User",
    targetId: userId,
    diff: { reason: reason || "Admin-initiated deletion" },
  });

  return { success: true };
}
