"use server";

/**
 * Login Briefing Server Actions
 *
 * Fetches and manages proactive login briefings for dashboard display.
 */

import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import { prisma } from "@usemoney/database";

// ── Types ──────────────────────────────────────────────────────────

interface BriefingData {
  id: string;
  summary: string | null;
  sections: unknown[];
  portfolioValue: number | null;
  dayChange: number | null;
  briefingDate: string;
  completedAt: string | null;
}

// ── Get Latest Briefing ────────────────────────────────────────────

/**
 * Fetch the latest unread briefing for the current user (today only).
 */
export async function getLatestBriefingAction(): Promise<
  ActionResponse<BriefingData | null>
> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const briefing = await prisma.loginBriefing.findFirst({
    where: {
      userId: authUser.userId,
      status: "COMPLETED",
      // MONEY-1236 — "not yet viewed" is null OR ABSENT.
      //
      // Prisma's MongoDB connector does not treat a missing field as null: a
      // bare `viewedAt: null` lowers to an equality against an explicit JSON
      // null and matches ONLY documents that carry the key. No writer ever
      // carries it — the single `loginBriefing.create` in the repo
      // (apps/web/app/api/webhooks/clerk/route.ts, the `session.created`
      // handler) writes `{userId, status, briefingDate}` and nothing else, and
      // `viewedAt DateTime?` has no `@default`, so Mongo stores no key at all.
      // Every briefing was therefore invisible to this fetch and the popup
      // could never surface, no matter how many rows the worker completed.
      //
      // The create path omitting `viewedAt` is the ROOT CAUSE and lives in a
      // file this ticket does not own. Widening the READ is the more robust
      // half regardless: it is correct for rows produced by EITHER writer
      // shape, and it is the only half that can see rows already written —
      // `prisma db push` creates indexes, never fields, so no backfill happens
      // on deploy. Fixing only the writer would leave the existing population
      // permanently unreadable.
      //
      // Same defect class as MONEY-1050 / 1205 / 1234 / 1235. `isSet: false` is
      // the only Prisma spelling that reaches an absent key (`$exists: false`).
      OR: [{ viewedAt: null }, { viewedAt: { isSet: false } }],
      briefingDate: { gte: today },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!briefing) {
    return { success: true, data: null };
  }

  return {
    success: true,
    data: {
      id: briefing.id,
      summary: briefing.summary,
      sections: briefing.sections as unknown[],
      portfolioValue: briefing.portfolioValue,
      dayChange: briefing.dayChange,
      briefingDate: briefing.briefingDate.toISOString(),
      completedAt: briefing.completedAt?.toISOString() ?? null,
    },
  };
}

// ── Mark Briefing Viewed ───────────────────────────────────────────

/**
 * Mark a briefing as viewed (dismissed by user).
 */
export async function markBriefingViewedAction(
  briefingId: string
): Promise<ActionResponse<void>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const briefing = await prisma.loginBriefing.findUnique({
    where: { id: briefingId },
    select: { userId: true },
  });

  if (!briefing || briefing.userId !== authUser.userId) {
    return { success: false, error: "Briefing not found" };
  }

  await prisma.loginBriefing.update({
    where: { id: briefingId },
    data: { viewedAt: new Date() },
  });

  return { success: true, data: undefined };
}
