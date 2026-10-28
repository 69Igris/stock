"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import {
  consumeCredits as consumeCreditsService,
  refundCredits as refundCreditsService,
  checkCredits as checkCreditsService,
  getCreditBalance as getCreditBalanceService,
  getCreditUsageHistory as getCreditUsageHistoryService,
  type CreditBalance,
  type CreditCheckResult,
  type CreditConsumeResult,
  type CreditUsageRecord,
} from "@usemoney/services";
import { dbLogger as logger } from "@usemoney/logger";

export type {
  CreditBalance,
  CreditCheckResult,
  CreditConsumeResult,
  CreditUsageRecord,
};

/**
 * Consume credits for an action (called from chat route, research, roast, etc.)
 */
export async function consumeCreditsAction(
  action: string,
  metadata?: {
    sessionId?: string;
    symbols?: string[];
    query?: string;
    tier?: string;
  }
): Promise<{
  success: boolean;
  remaining?: number;
  creditsUsed?: number;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const result = await consumeCreditsService(
      authUser.userId,
      action,
      metadata
    );
    if (result?.success) {
      return {
        success: true,
        remaining: result?.data.remaining,
        creditsUsed: result?.data.creditsUsed,
      };
    }
    return { success: false, error: result?.error };
  } catch (error) {
    logger.error({ error, action }, "consumeCreditsAction error");
    return { success: false, error: "Failed to consume credits" };
  }
}

/**
 * Pre-flight check: does user have enough credits for an action?
 */
export async function checkCreditsAction(action: string): Promise<{
  allowed: boolean;
  remaining: number;
  cost: number;
  planId: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { allowed: false, remaining: 0, cost: 0, planId: "FREE" };
    }

    const result = await checkCreditsService(authUser.userId, action);
    if (result?.success) {
      return { ...result?.data, planId: "UNKNOWN" };
    }
    return { allowed: false, remaining: 0, cost: 0, planId: "FREE" };
  } catch (error) {
    logger.error(
      { error, action: "checkCreditsAction" },
      "credit pre-check failed"
    );
    return { allowed: false, remaining: 0, cost: 0, planId: "FREE" };
  }
}

/**
 * Get current credit balance.
 */
export async function getCreditBalanceAction(): Promise<{
  success: boolean;
  data?: CreditBalance;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return {
        success: true,
        data: { plan: 5, pack: 0, total: 5, planLimit: 5, packLimit: 0 },
      };
    }

    const result = await getCreditBalanceService(authUser.userId);
    if (result?.success) {
      return { success: true, data: result?.data };
    }
    return { success: false, error: result?.error };
  } catch (error) {
    logger.error({ error }, "getCreditBalanceAction error");
    return { success: false, error: "Failed to get credit balance" };
  }
}

/**
 * Get credit usage history (paginated).
 */
export async function getCreditUsageHistoryAction(options?: {
  skip?: number;
  limit?: number;
  action?: string;
}): Promise<{
  success: boolean;
  data?: { items: CreditUsageRecord[]; total: number };
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const result = await getCreditUsageHistoryService(authUser.userId, options);
    if (result?.success) {
      return { success: true, data: result?.data };
    }
    return { success: false, error: result?.error };
  } catch (error) {
    logger.error({ error }, "getCreditUsageHistoryAction error");
    return { success: false, error: "Failed to get usage history" };
  }
}

/**
 * Refund credits (when an operation fails after consumption).
 */
export async function refundCreditsAction(
  action: string,
  amount?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const result = await refundCreditsService(authUser.userId, action, amount);
    return {
      success: result?.success,
      error: result?.success ? undefined : result?.error,
    };
  } catch (error) {
    logger.error({ error, action }, "refundCreditsAction error");
    return { success: false, error: "Failed to refund credits" };
  }
}
