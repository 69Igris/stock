/**
 * Roast History Server Actions
 *
 * Retrieve and manage portfolio roast history.
 */

"use server";

import { auth } from "@clerk/nextjs/server";
import { getOrCreateDbUser } from "@/lib/db/user";
import {
  getRoastHistory,
  getRoastById,
  getRoastBySessionId,
  deleteRoast,
} from "@/lib/db/roast";
import type { StructuredRoastResult } from "@usemoney/types";
import type { RoastStatus } from "@prisma/client";
import { isDemoSession } from "@/lib/demo/session";
import { demoRoastHistory, demoRoastDetail } from "@/lib/demo/data";

export async function getRoastHistoryAction(
  page = 1,
  pageSize = 20
): Promise<{
  success: boolean;
  data?: {
    items: Array<{
      id: string;
      sessionId: string;
      mode: string;
      broker: string | null;
      assetType: string;
      status: RoastStatus;
      score: number | null;
      createdAt: Date;
    }>;
    total: number;
  };
  error?: string;
}> {
  if (await isDemoSession()) {
    return {
      success: true,
      data: {
        items: demoRoastHistory as unknown as Array<{
          id: string;
          sessionId: string;
          mode: string;
          broker: string | null;
          assetType: string;
          status: RoastStatus;
          score: number | null;
          createdAt: Date;
        }>,
        total: demoRoastHistory.length,
      },
    };
  }

  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return { success: false, error: "Unauthorized" };
    }

    const dbUser = await getOrCreateDbUser(clerkUserId);
    if (!dbUser) {
      return { success: false, error: "User not found" };
    }

    const data = await getRoastHistory(dbUser.id, page, pageSize);
    return { success: true, data };
  } catch (error) {
    console.error("[roast-history] Failed to get history:", error);
    return { success: false, error: "Failed to get roast history" };
  }
}

export async function getRoastByIdAction(id: string): Promise<{
  success: boolean;
  data?: {
    id: string;
    sessionId: string;
    mode: string;
    broker: string | null;
    assetType: string;
    score: number | null;
    result: StructuredRoastResult | null;
    createdAt: Date;
  };
  error?: string;
}> {
  if (await isDemoSession()) {
    if (id === "demo-roast-1") {
      return {
        success: true,
        data: demoRoastDetail as unknown as {
          id: string;
          sessionId: string;
          mode: string;
          broker: string | null;
          assetType: string;
          score: number | null;
          result: StructuredRoastResult | null;
          createdAt: Date;
        },
      };
    }
    return { success: false, error: "Roast not found" };
  }

  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return { success: false, error: "Unauthorized" };
    }

    const dbUser = await getOrCreateDbUser(clerkUserId);
    if (!dbUser) {
      return { success: false, error: "User not found" };
    }

    const data = await getRoastById(id, dbUser.id);
    if (!data) {
      return { success: false, error: "Roast not found" };
    }

    return { success: true, data };
  } catch (error) {
    console.error("[roast-history] Failed to get roast:", error);
    return { success: false, error: "Failed to get roast" };
  }
}

export async function getRoastBySessionIdAction(sessionId: string): Promise<{
  success: boolean;
  data?: {
    id: string;
    sessionId: string;
    mode: string;
    broker: string | null;
    assetType: string;
    status: string;
    progress: number;
    currentStep: string | null;
    score: number | null;
    result: StructuredRoastResult | null;
    errorMessage: string | null;
    createdAt: Date;
    completedAt: Date | null;
  };
  error?: string;
}> {
  if (await isDemoSession()) {
    if (sessionId === "demo-roast-1") {
      return {
        success: true,
        data: {
          ...demoRoastDetail,
          status: "COMPLETED",
          progress: 100,
          currentStep: null,
          errorMessage: null,
          completedAt: demoRoastDetail.createdAt,
        } as unknown as {
          id: string;
          sessionId: string;
          mode: string;
          broker: string | null;
          assetType: string;
          status: string;
          progress: number;
          currentStep: string | null;
          score: number | null;
          result: StructuredRoastResult | null;
          errorMessage: string | null;
          createdAt: Date;
          completedAt: Date | null;
        },
      };
    }
    return { success: false, error: "Roast not found" };
  }

  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return { success: false, error: "Unauthorized" };
    }

    const dbUser = await getOrCreateDbUser(clerkUserId);
    if (!dbUser) {
      return { success: false, error: "User not found" };
    }

    const data = await getRoastBySessionId(sessionId, dbUser.id);
    if (!data) {
      return { success: false, error: "Roast not found" };
    }

    return { success: true, data };
  } catch (error) {
    console.error("[roast-history] Failed to get roast by session:", error);
    return { success: false, error: "Failed to get roast" };
  }
}

export async function deleteRoastAction(
  id: string
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return { success: false, error: "Unauthorized" };
    }

    const dbUser = await getOrCreateDbUser(clerkUserId);
    if (!dbUser) {
      return { success: false, error: "User not found" };
    }

    const deleted = await deleteRoast(id, dbUser.id);
    if (!deleted) {
      return { success: false, error: "Roast not found" };
    }

    return { success: true };
  } catch (error) {
    console.error("[roast-history] Failed to delete roast:", error);
    return { success: false, error: "Failed to delete roast" };
  }
}
