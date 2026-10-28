"use server";

/**
 * Studio library (MONEY-633) — list the signed-in user's generated images + reels.
 * Scoped by Clerk userId (the same id the generate-image route + render worker
 * persist under). Read-only; generations are written by the image route and the
 * studio-render worker.
 */
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@usemoney/database";

export interface StudioGenerationItem {
  id: string;
  kind: string;
  prompt: string | null;
  url: string;
  model: string | null;
  createdAt: string;
}

export async function listStudioGenerations(
  limit = 60,
): Promise<StudioGenerationItem[]> {
  const { userId } = await auth();
  if (!userId) return [];
  const rows = await prisma.studioGeneration.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true,
      kind: true,
      prompt: true,
      url: true,
      model: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
