"use server";

import { requireAdmin } from "@/lib/auth";
import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { nanoid } from "nanoid";
import type { Prisma } from "@prisma/client";
import {
  serializeInviteToken,
  validateCreateInviteInput,
  buildInviteCreateData,
  toggleActive,
} from "./invites-logic";

export type { InviteTokenData } from "./invites-logic";
import type { InviteTokenData } from "./invites-logic";

export async function getInviteTokens(): Promise<InviteTokenData[]> {
  await requireAdmin();

  const tokens = await prisma.inviteToken.findMany({
    orderBy: { createdAt: "desc" },
  });

  return tokens.map(serializeInviteToken);
}

export async function createInviteToken(data: {
  planId: string;
  maxUses: number;
  assignedTo?: string;
  expiresAt?: string;
  discountId?: string;
  discountCode?: string;
}): Promise<InviteTokenData> {
  await requireAdmin();
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const validationError = validateCreateInviteInput(data);
  if (validationError) {
    throw new Error(validationError);
  }

  const token = await prisma.inviteToken.create({
    data: buildInviteCreateData(
      data,
      nanoid(12),
      userId,
    ) as Prisma.InviteTokenUncheckedCreateInput,
  });

  return serializeInviteToken(token);
}

export async function toggleInviteToken(id: string): Promise<void> {
  await requireAdmin();

  const existing = await prisma.inviteToken.findUnique({ where: { id } });
  if (!existing) throw new Error("Invite token not found");

  await prisma.inviteToken.update({
    where: { id },
    data: { isActive: toggleActive(existing.isActive) },
  });
}

export async function deleteInviteToken(id: string): Promise<void> {
  await requireAdmin();
  await prisma.inviteToken.delete({ where: { id } });
}
