"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import { hasFeatureAccess } from "@usemoney/core/subscription";
import { getSubscriptionAccess } from "@/lib/subscription/access";
import { publishRoastJob } from "@usemoney/pubsub/publish";
import {
  createRoastSession as createRoastSessionService,
  getRoastStatus as getRoastStatusService,
  getRunningRoasts as getRunningRoastsService,
  updateRoastStatus as updateRoastStatusService,
} from "@usemoney/services";
import { prisma } from "@usemoney/database";
import type { BrokerType } from "@prisma/client";
import { isDemoSession } from "@/lib/demo/session";

// Re-export types for consumers
export type {
  CreateRoastInput,
  RoastStatusData,
  RoastFullRecord,
  RoastRunningItem,
  RoastHistoryItem,
  UpdateRoastStatusInput,
} from "@usemoney/services";

export interface RoastParams {
  mode: "overall" | "broker";
  broker?: string;
  /** MONEY-837: scope to a specific account when a broker has multiple logins. */
  brokerUserId?: string;
  /** MONEY-837: tradebook-subset scope — ISO date bounds + symbol filter. */
  dateFrom?: string;
  dateTo?: string;
  symbols?: string[];
  assetType: "stocks" | "mf" | "all";
  /**
   * MONEY-145 - scope hint for the roast worker:
   *   - "PORTFOLIO" (default): emphasises allocation, concentration, sector mix
   *   - "TRADEBOOK": emphasises entry/exit timing, churn, realised P&L,
   *     behaviour gap. Wired from the Tradebook page "Roast my trades" CTA.
   *
   * Worker may still surface both angles regardless; this just biases the
   * narrative + which axes show up in the verdict.
   */
  scope?: "PORTFOLIO" | "TRADEBOOK";
}

export type RoastErrorType =
  | "NOT_CONNECTED"
  | "NEEDS_REAUTH"
  | "NEVER_SYNCED"
  | "NO_DATA"
  | "UNAUTHORIZED"
  | "UPGRADE_REQUIRED"
  | "NO_CREDITS"
  | "GENERAL";

// ---------- Credit System ----------

export async function canUseRoastAction(): Promise<{
  allowed: boolean;
  isFreeRoast: boolean;
  message?: string;
  remainingCredits?: number;
}> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { allowed: false, isFreeRoast: false, message: "Unauthorized" };
    }

    const sub = await prisma.subscription.findUnique({
      where: { userId: authUser.userId },
      select: {
        planId: true,
        freeRoastsUsedThisMonth: true,
        freeRoastsResetAt: true,
        advancedQueriesUsed: true,
        advancedQueriesLimit: true,
      },
    });

    const planId = sub?.planId || "FREE";

    // Check/reset monthly free roast counter
    let freeRoastsUsed = sub?.freeRoastsUsedThisMonth ?? 0;
    if (sub?.freeRoastsResetAt && sub.freeRoastsResetAt < new Date()) {
      // Reset counter
      freeRoastsUsed = 0;
      if (sub) {
        await prisma.subscription.update({
          where: { userId: authUser.userId },
          data: { freeRoastsUsedThisMonth: 0 },
        });
      }
    }

    // Free roast available for ALL users
    if (freeRoastsUsed === 0) {
      return { allowed: true, isFreeRoast: true };
    }

    // For PRO/PREMIUM/ULTIMATE users, check advanced query credits
    if (planId === "PRO" || planId === "PREMIUM" || planId === "ULTIMATE") {
      const used = sub?.advancedQueriesUsed ?? 0;
      const limit = sub?.advancedQueriesLimit ?? 0;
      const remaining = Math.max(0, limit - used);

      if (planId === "ULTIMATE" || planId === "PREMIUM" || remaining > 0) {
        return {
          allowed: true,
          isFreeRoast: false,
          remainingCredits:
            planId === "ULTIMATE" || planId === "PREMIUM"
              ? undefined
              : remaining,
        };
      }

      return {
        allowed: false,
        isFreeRoast: false,
        message: "No advanced credits remaining. Upgrade or wait for reset.",
      };
    }

    // FREE tier with free roast already used
    return {
      allowed: false,
      isFreeRoast: false,
      message: "Free monthly roast used. Upgrade to Pro for unlimited roasts.",
    };
  } catch (error) {
    console.error("[roast] canUseRoast check failed:", error);
    return {
      allowed: false,
      isFreeRoast: false,
      message: "Failed to check credit availability",
    };
  }
}

async function consumeRoastCredit(
  userId: string,
  isFreeRoast: boolean
): Promise<void> {
  if (isFreeRoast) {
    // Set reset date to 1st of next month
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    await prisma.subscription.update({
      where: { userId },
      data: {
        freeRoastsUsedThisMonth: { increment: 1 },
        freeRoastsResetAt: nextMonth,
      },
    });
  } else {
    // Consume an advanced query credit
    await prisma.subscription.update({
      where: { userId },
      data: {
        advancedQueriesUsed: { increment: 1 },
      },
    });
  }
}

async function refundRoastCredit(
  userId: string,
  isFreeRoast: boolean
): Promise<void> {
  if (isFreeRoast) {
    await prisma.subscription.update({
      where: { userId },
      data: {
        freeRoastsUsedThisMonth: { decrement: 1 },
      },
    });
  } else {
    await prisma.subscription.update({
      where: { userId },
      data: {
        advancedQueriesUsed: { decrement: 1 },
      },
    });
  }
}

// ---------- Async Roast Actions ----------

export async function startRoastAction(params: RoastParams): Promise<{
  success: boolean;
  sessionId?: string;
  error?: string;
  errorType?: RoastErrorType;
  warnings?: string[];
}> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return {
        success: false,
        error: "Unauthorized",
        errorType: "UNAUTHORIZED",
      };
    }

    // Feature gate
    const access = await getSubscriptionAccess();
    if (!hasFeatureAccess(access.planId, "portfolioRoast")) {
      return {
        success: false,
        error: "Upgrade to access Portfolio Roast",
        errorType: "UPGRADE_REQUIRED",
      };
    }

    // Broker validation (fail fast)
    const warnings: string[] = [];
    if (params.mode === "broker" && params.broker) {
      const connections = await prisma.brokerConnection.findMany({
        where: {
          userId: authUser.userId,
          broker: params.broker as BrokerType,
          // MONEY-837: when the broker has multiple accounts, validate the one
          // the user actually picked — not just connections[0].
          ...(params.brokerUserId ? { brokerUserId: params.brokerUserId } : {}),
        },
        select: { status: true, tokenExpiry: true, lastSync: true },
      });

      if (connections.length === 0) {
        return {
          success: false,
          error: `${params.broker} is not connected. Go to the Brokers page to connect it.`,
          errorType: "NOT_CONNECTED",
        };
      }

      const conn = connections[0];
      if (
        conn.status === "EXPIRED" ||
        conn.status === "NEEDS_REAUTH" ||
        (conn.tokenExpiry && conn.tokenExpiry < new Date())
      ) {
        return {
          success: false,
          error: `Your ${params.broker} session has expired. Please reconnect your broker to get fresh data.`,
          errorType: "NEEDS_REAUTH",
        };
      }

      if (!conn.lastSync) {
        return {
          success: false,
          error: `Your ${params.broker} account hasn't been synced yet. Sync your data from the Brokers page first.`,
          errorType: "NEVER_SYNCED",
        };
      }
    } else if (params.mode === "overall") {
      const allConnections = await prisma.brokerConnection.findMany({
        where: { userId: authUser.userId },
        select: { broker: true, status: true, tokenExpiry: true },
      });

      for (const conn of allConnections) {
        if (
          conn.status === "EXPIRED" ||
          conn.status === "NEEDS_REAUTH" ||
          (conn.tokenExpiry && conn.tokenExpiry < new Date())
        ) {
          warnings.push(
            `${conn.broker} session has expired - data may be stale. Reconnect for fresh data.`
          );
        }
      }
    }

    // Credit check
    const creditCheck = await canUseRoastAction();
    if (!creditCheck.allowed) {
      return {
        success: false,
        error: creditCheck.message || "No roast credits available",
        errorType: "NO_CREDITS",
      };
    }

    // Generate IDs
    const sessionId = crypto.randomUUID();
    const jobId = crypto.randomUUID();

    // Create roast session record via service. MONEY-1062: a failed INSERT must
    // NOT charge the user — check the ServiceResult and bail BEFORE consuming a
    // credit or publishing the job. Previously the failure was discarded, so the
    // credit was still spent and a job was queued whose session row never
    // existed → the user was charged for a roast that shows "Roast not found"
    // forever. Mirrors the publish-failure return leg below.
    const created = await createRoastSessionService({
      userId: authUser.userId,
      sessionId,
      jobId,
      mode: params.mode,
      broker: params.broker,
      assetType: params.assetType,
    });
    if (!created.success) {
      console.error("[roast] Failed to create roast session:", created.error);
      return {
        success: false,
        error: "Failed to start roast. Please try again.",
        errorType: "GENERAL",
      };
    }

    // Consume credit
    await consumeRoastCredit(authUser.userId, creditCheck.isFreeRoast);

    // Publish to Pub/Sub
    try {
      await publishRoastJob({
        jobId,
        userId: authUser.userId,
        sessionId,
        mode: params.mode,
        broker: params.broker,
        brokerUserId: params.brokerUserId,
        assetType: params.assetType,
        scope: params.scope,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        symbols: params.symbols,
      });
    } catch (publishError) {
      console.error("[roast] Failed to publish job:", publishError);
      // Refund credit and mark as failed
      await refundRoastCredit(authUser.userId, creditCheck.isFreeRoast);
      await updateRoastStatusService(sessionId, authUser.userId, {
        status: "FAILED",
        errorMessage: "Failed to queue roast job",
      });
      return {
        success: false,
        error: "Failed to start roast. Please try again.",
        errorType: "GENERAL",
      };
    }

    return {
      success: true,
      sessionId,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    console.error("[roast] Failed to start roast:", error);
    return {
      success: false,
      error: "Failed to start portfolio roast",
      errorType: "GENERAL",
    };
  }
}

export async function getRoastStatusAction(sessionId: string): Promise<{
  success: boolean;
  data?: {
    status: string;
    progress: number;
    currentStep: string | null;
    score: number | null;
    errorMessage: string | null;
  };
  error?: string;
}> {
  // MONEY-543 / mirrors MONEY-286: demo sessions return a benign
  // "not found" instead of querying the real DB - prevents the demo
  // walkthrough from accidentally leaking a real user's roast status.
  if (await isDemoSession()) {
    return { success: false, error: "Roast not found" };
  }

  try {
    // MONEY-543 / mirrors MONEY-286: scope the lookup to the
    // authenticated user so a guessed sessionId from another account
    // returns "not found" rather than leaking status/progress/score/
    // errorMessage (which can include broker / portfolio hints).
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    const result = await getRoastStatusService(sessionId, authUser.userId);
    if (!result?.success) {
      return { success: false, error: result?.error || "Roast not found" };
    }
    return { success: true, data: result?.data };
  } catch (error) {
    console.error("[roast] Failed to get status:", error);
    return { success: false, error: "Failed to get roast status" };
  }
}

export async function cancelRoastAction(
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    // Cancel via service layer
    const { cancelRoast: cancelRoastService } =
      await import("@usemoney/services");
    const result = await cancelRoastService(authUser.userId, sessionId);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }

    return { success: true };
  } catch (error) {
    console.error("[roast] Failed to cancel roast:", error);
    return { success: false, error: "Failed to cancel roast" };
  }
}

export async function getRunningRoastsAction(): Promise<{
  success: boolean;
  data?: Array<{
    sessionId: string;
    mode: string;
    broker: string | null;
    assetType: string;
    status: string;
    progress: number;
    currentStep: string | null;
    createdAt: Date;
  }>;
  error?: string;
}> {
  if (await isDemoSession()) {
    return { success: true, data: [] };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    const result = await getRunningRoastsService(authUser.userId);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }
    return { success: true, data: result?.data };
  } catch (error) {
    console.error("[roast] Failed to get running roasts:", error);
    return { success: false, error: "Failed to get running roasts" };
  }
}
