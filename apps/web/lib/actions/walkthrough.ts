"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { ActionResponse } from "@usemoney/validation";
import { authLogger as logger } from "@usemoney/logger";
import { getSafeErrorMessage } from "@usemoney/utils/error-sanitization";
import {
  CURRENT_WALKTHROUGH_VERSION,
  isKnownWalkthroughVersion,
} from "@/lib/walkthrough/tours";

export interface WalkthroughState {
  seenVersions: string[];
  snoozedUntil: Record<string, string>;
  currentVersion: string;
}

interface PreferencesShape {
  walkthrough?: {
    snoozedUntil?: Record<string, string>;
  };
  [key: string]: unknown;
}

function readSnoozedUntil(prefs: unknown): Record<string, string> {
  if (!prefs || typeof prefs !== "object") return {};
  const w = (prefs as PreferencesShape).walkthrough;
  if (!w || typeof w !== "object") return {};
  const map = w.snoozedUntil;
  if (!map || typeof map !== "object") return {};
  // Sanity-filter to string→string entries.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function mergePreferencesWithSnooze(
  existing: unknown,
  snoozedUntil: Record<string, string>
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === "object"
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const walkthrough =
    (base.walkthrough as { snoozedUntil?: Record<string, string> }) ?? {};
  base.walkthrough = { ...walkthrough, snoozedUntil };
  return base;
}

export async function getWalkthroughStateAction(): Promise<
  ActionResponse<WalkthroughState>
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { walkthroughVersionsSeen: true, preferences: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    return {
      success: true,
      data: {
        seenVersions: user.walkthroughVersionsSeen,
        snoozedUntil: readSnoozedUntil(user.preferences),
        currentVersion: CURRENT_WALKTHROUGH_VERSION,
      },
    };
  } catch (error) {
    logger.error(
      { error, action: "getWalkthroughStateAction" },
      "Get walkthrough state error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to load walkthrough state"),
    };
  }
}

export async function markWalkthroughSeenAction(
  version: string
): Promise<ActionResponse<{ seenVersions: string[] }>> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    if (!isKnownWalkthroughVersion(version)) {
      return { success: false, error: "Unknown walkthrough version" };
    }

    const existing = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { walkthroughVersionsSeen: true },
    });

    if (!existing) {
      return { success: false, error: "User not found" };
    }

    if (existing.walkthroughVersionsSeen.includes(version)) {
      return {
        success: true,
        data: { seenVersions: existing.walkthroughVersionsSeen },
      };
    }

    const updated = await prisma.user.update({
      where: { id: authUser.userId },
      data: {
        walkthroughVersionsSeen: {
          push: version,
        },
      },
      select: { walkthroughVersionsSeen: true },
    });

    return {
      success: true,
      data: { seenVersions: updated.walkthroughVersionsSeen },
    };
  } catch (error) {
    logger.error(
      { error, action: "markWalkthroughSeenAction" },
      "Mark walkthrough seen error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to save walkthrough state"),
    };
  }
}

export async function resetWalkthroughAction(
  version: string
): Promise<ActionResponse<{ seenVersions: string[] }>> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    if (!isKnownWalkthroughVersion(version)) {
      return { success: false, error: "Unknown walkthrough version" };
    }

    const existing = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { walkthroughVersionsSeen: true, preferences: true },
    });

    if (!existing) {
      return { success: false, error: "User not found" };
    }

    const nextSeen = existing.walkthroughVersionsSeen.filter(
      (v) => v !== version
    );

    // Also clear any pending snooze for this version so the user
    // actually sees the tour again after clicking "Take the tour again".
    const snoozed = readSnoozedUntil(existing.preferences);
    delete snoozed[version];
    const nextPrefs = mergePreferencesWithSnooze(existing.preferences, snoozed);

    const updated = await prisma.user.update({
      where: { id: authUser.userId },
      data: {
        walkthroughVersionsSeen: { set: nextSeen },
        preferences: nextPrefs as Record<string, unknown> & object,
      },
      select: { walkthroughVersionsSeen: true },
    });

    return {
      success: true,
      data: { seenVersions: updated.walkthroughVersionsSeen },
    };
  } catch (error) {
    logger.error(
      { error, action: "resetWalkthroughAction" },
      "Reset walkthrough error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to reset walkthrough"),
    };
  }
}

export async function snoozeWalkthroughAction(
  version: string,
  untilIso: string
): Promise<ActionResponse<{ snoozedUntil: Record<string, string> }>> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    if (!isKnownWalkthroughVersion(version)) {
      return { success: false, error: "Unknown walkthrough version" };
    }

    const parsed = Date.parse(untilIso);
    if (Number.isNaN(parsed)) {
      return { success: false, error: "Invalid snooze timestamp" };
    }

    const existing = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { preferences: true },
    });

    if (!existing) {
      return { success: false, error: "User not found" };
    }

    const snoozed = readSnoozedUntil(existing.preferences);
    snoozed[version] = new Date(parsed).toISOString();

    const nextPrefs = mergePreferencesWithSnooze(existing.preferences, snoozed);

    await prisma.user.update({
      where: { id: authUser.userId },
      data: { preferences: nextPrefs as Record<string, unknown> & object },
    });

    return { success: true, data: { snoozedUntil: snoozed } };
  } catch (error) {
    logger.error(
      { error, action: "snoozeWalkthroughAction" },
      "Snooze walkthrough error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to snooze walkthrough"),
    };
  }
}
