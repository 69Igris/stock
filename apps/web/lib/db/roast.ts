/**
 * Roast Database Queries
 *
 * CRUD operations for PortfolioRoast model (async agent version).
 */

import prisma from "@/lib/prisma";
import type { Prisma, RoastStatus } from "@prisma/client";
import type { StructuredRoastResult } from "@usemoney/types";

export async function createRoastSession(data: {
  userId: string;
  sessionId: string;
  jobId: string;
  mode: string;
  broker?: string;
  assetType: string;
}): Promise<{ id: string }> {
  const roast = await prisma.portfolioRoast.create({
    data: {
      userId: data.userId,
      sessionId: data.sessionId,
      jobId: data.jobId,
      mode: data.mode,
      broker: data.broker || null,
      assetType: data.assetType,
      status: "QUEUED",
      progress: 0,
    },
    select: { id: true },
  });
  return { id: roast.id };
}

export async function getRoastBySessionId(
  sessionId: string,
  userId: string
): Promise<{
  id: string;
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  status: RoastStatus;
  progress: number;
  currentStep: string | null;
  score: number | null;
  result: StructuredRoastResult | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
} | null> {
  const roast = await prisma.portfolioRoast.findFirst({
    where: { sessionId, userId },
    select: {
      id: true,
      sessionId: true,
      mode: true,
      broker: true,
      assetType: true,
      status: true,
      progress: true,
      currentStep: true,
      score: true,
      result: true,
      errorMessage: true,
      createdAt: true,
      completedAt: true,
    },
  });

  if (!roast) return null;

  return {
    ...roast,
    result: roast.result as unknown as StructuredRoastResult | null,
  };
}

export async function getRoastStatus(
  sessionId: string,
  userId?: string
): Promise<{
  status: RoastStatus;
  progress: number;
  currentStep: string | null;
  score: number | null;
  errorMessage: string | null;
} | null> {
  // MONEY-543 / mirrors MONEY-286: defense-in-depth - filter by userId
  // when provided so cross-user sessionId guesses do not leak status,
  // progress, score, or errorMessage. Currently this helper is unused
  // (the active path is packages/services roast.service.ts), kept
  // hardened to avoid regression if reimported.
  if (userId) {
    return prisma.portfolioRoast.findFirst({
      where: { sessionId, userId },
      select: {
        status: true,
        progress: true,
        currentStep: true,
        score: true,
        errorMessage: true,
      },
    });
  }
  return prisma.portfolioRoast.findUnique({
    where: { sessionId },
    select: {
      status: true,
      progress: true,
      currentStep: true,
      score: true,
      errorMessage: true,
    },
  });
}

export async function getRunningRoasts(userId: string): Promise<
  Array<{
    sessionId: string;
    mode: string;
    broker: string | null;
    assetType: string;
    status: RoastStatus;
    progress: number;
    currentStep: string | null;
    createdAt: Date;
  }>
> {
  return prisma.portfolioRoast.findMany({
    where: {
      userId,
      status: { notIn: ["COMPLETED", "FAILED"] },
    },
    select: {
      sessionId: true,
      mode: true,
      broker: true,
      assetType: true,
      status: true,
      progress: true,
      currentStep: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getRoastHistory(
  userId: string,
  page = 1,
  pageSize = 20
): Promise<{
  items: Array<{
    id: string;
    sessionId: string;
    mode: string;
    broker: string | null;
    assetType: string;
    status: RoastStatus;
    score: number | null;
    errorMessage: string | null;
    createdAt: Date;
  }>;
  total: number;
}> {
  const where = {
    userId,
    status: { in: ["COMPLETED", "FAILED"] as ("COMPLETED" | "FAILED")[] },
  };
  const [items, total] = await Promise.all([
    prisma.portfolioRoast.findMany({
      where,
      select: {
        id: true,
        sessionId: true,
        mode: true,
        broker: true,
        assetType: true,
        status: true,
        score: true,
        errorMessage: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.portfolioRoast.count({ where }),
  ]);
  return { items, total };
}

export async function cancelRoast(
  sessionId: string,
  userId: string
): Promise<boolean> {
  const roast = await prisma.portfolioRoast.findFirst({
    where: { sessionId, userId, status: { notIn: ["COMPLETED", "FAILED"] } },
    select: { id: true },
  });

  if (!roast) return false;

  await prisma.portfolioRoast.update({
    where: { id: roast.id },
    data: {
      status: "FAILED",
      errorMessage: "Cancelled by user",
      completedAt: new Date(),
    },
  });
  return true;
}

export async function getRoastById(
  id: string,
  userId: string
): Promise<{
  id: string;
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  score: number | null;
  result: StructuredRoastResult | null;
  createdAt: Date;
} | null> {
  const roast = await prisma.portfolioRoast.findFirst({
    where: { id, userId },
    select: {
      id: true,
      sessionId: true,
      mode: true,
      broker: true,
      assetType: true,
      score: true,
      result: true,
      createdAt: true,
    },
  });

  if (!roast) return null;

  return {
    ...roast,
    result: roast.result as unknown as StructuredRoastResult | null,
  };
}

export async function deleteRoast(
  id: string,
  userId: string
): Promise<boolean> {
  const roast = await prisma.portfolioRoast.findFirst({
    where: { id, userId },
    select: { id: true },
  });

  if (!roast) return false;

  await prisma.portfolioRoast.delete({ where: { id } });
  return true;
}

// MONEY-599: ownership-scoped (dead today — the canonical writer is
// roast.service.ts updateRoastStatus; kept safe here in case it's reimported).
export async function updateRoastStatus(
  sessionId: string,
  userId: string,
  data: { status: RoastStatus; errorMessage?: string }
): Promise<void> {
  await prisma.portfolioRoast.updateMany({
    where: { sessionId, userId },
    data,
  });
}
