/**
 * Gemini LLM Integration - Cost Tracking
 *
 * This file handles token usage tracking and cost estimation for
 * Gemini API calls, enabling cost monitoring and analytics.
 */

import prisma from "@/lib/prisma";
import { geminiLogger as logger } from "@usemoney/logger";
import type { TokenUsageData, ModelPricing } from "@usemoney/types";
import {
  resolveModelName,
  exceedsThreshold,
  aggregateUsage,
  breakdownByModel,
  groupDailyUsage,
} from "./cost-tracker-logic";

/**
 * Gemini pricing (approximate - update based on current Google Cloud pricing)
 * Prices are in USD per 1 million tokens
 *
 * Reference: https://cloud.google.com/vertex-ai/generative-ai/pricing
 */
export const GEMINI_PRICING: Record<string, ModelPricing> = {
  // Gemini 2.5 stable models
  "gemini-2.5-flash": {
    inputCostPer1M: 0.075, // $0.075 per 1M input tokens
    outputCostPer1M: 0.3, // $0.30 per 1M output tokens
  },
  "gemini-2.5-pro": {
    inputCostPer1M: 1.25, // $1.25 per 1M input tokens
    outputCostPer1M: 5.0, // $5.00 per 1M output tokens
  },
  // Gemini 1.5 models (fallback for regions where 2.5 is not available)
  "gemini-1.5-pro": {
    inputCostPer1M: 1.25, // $1.25 per 1M input tokens
    outputCostPer1M: 5.0, // $5.00 per 1M output tokens
  },
  "gemini-1.5-flash": {
    inputCostPer1M: 0.075, // $0.075 per 1M input tokens
    outputCostPer1M: 0.3, // $0.30 per 1M output tokens
  },
  // Legacy 2.0 experimental models for backward compatibility
  "gemini-2.0-flash-exp": {
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.3,
  },
  "gemini-2.0-pro-exp": {
    inputCostPer1M: 1.25,
    outputCostPer1M: 5.0,
  },
};

/**
 * USD to INR conversion rate (approximate)
 * Update this periodically or fetch from an API
 */
const USD_TO_INR = 83;

/**
 * Calculate cost for a Gemini API call
 *
 * @param modelName - Name of the Gemini model used
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @returns Estimated cost in USD
 */
export function calculateCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = GEMINI_PRICING[modelName];

  if (!pricing) {
    logger.warn({ modelName }, "Unknown model for pricing calculation");
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputCostPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputCostPer1M;

  return inputCost + outputCost;
}

/**
 * Calculate cost in INR
 *
 * @param costUSD - Cost in USD
 * @returns Cost in INR
 */
export function convertToINR(costUSD: number): number {
  return costUSD * USD_TO_INR;
}

/**
 * Track token usage in database
 *
 * Stores token usage data for analytics and cost monitoring
 *
 * @param usage - Token usage data
 * @returns Success status
 */
export async function trackTokenUsage(
  usage: TokenUsageData
): Promise<{ success: boolean; error?: string }> {
  try {
    // Determine model name based on query type
    const modelName = resolveModelName(usage.queryType);

    // Calculate cost
    const costUSD = calculateCost(
      modelName,
      usage.inputTokens,
      usage.outputTokens
    );

    // Store in database
    await prisma.tokenUsage.create({
      data: {
        userId: usage.userId,
        modelName,
        queryType: usage.queryType,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCost: costUSD,
        duration: usage.duration,
        pagePath: usage.pagePath,
      },
    });

    logger.info(
      {
        userId: usage.userId,
        modelName,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUSD: costUSD.toFixed(6),
        costINR: convertToINR(costUSD).toFixed(2),
        duration: usage.duration,
      },
      "Token usage tracked"
    );

    return { success: true };
  } catch (error) {
    logger.error({ error, usage }, "Failed to track token usage");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get total token usage for a user
 *
 * @param userId - User ID
 * @param startDate - Optional start date for filtering
 * @param endDate - Optional end date for filtering
 * @returns Usage statistics
 */
export async function getUserTokenUsage(
  userId: string,
  startDate?: Date,
  endDate?: Date
): Promise<{
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  totalCostINR: number;
  queryCount: number;
}> {
  try {
    const where: any = { userId };

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const usage = await prisma.tokenUsage.findMany({ where });

    return aggregateUsage(usage);
  } catch (error) {
    logger.error({ error, userId }, "Failed to get user token usage");
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUSD: 0,
      totalCostINR: 0,
      queryCount: 0,
    };
  }
}

/**
 * Get token usage breakdown by model
 *
 * @param userId - User ID
 * @param days - Number of days to look back (default: 30)
 * @returns Usage breakdown by model
 */
export async function getUsageByModel(
  userId: string,
  days: number = 30
): Promise<
  Array<{
    modelName: string;
    queryCount: number;
    totalTokens: number;
    totalCost: number;
  }>
> {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const usage = await prisma.tokenUsage.findMany({
      where: {
        userId,
        createdAt: { gte: startDate },
      },
    });

    return breakdownByModel(usage);
  } catch (error) {
    logger.error({ error, userId }, "Failed to get usage by model");
    return [];
  }
}

/**
 * Get daily token usage for charting
 *
 * @param userId - User ID
 * @param days - Number of days to look back
 * @returns Daily usage data
 */
export async function getDailyUsage(
  userId: string,
  days: number = 30
): Promise<
  Array<{
    date: string;
    queries: number;
    tokens: number;
    cost: number;
  }>
> {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const usage = await prisma.tokenUsage.findMany({
      where: {
        userId,
        createdAt: { gte: startDate },
      },
      orderBy: { createdAt: "asc" },
    });

    return groupDailyUsage(usage);
  } catch (error) {
    logger.error({ error, userId }, "Failed to get daily usage");
    return [];
  }
}

/**
 * Check if user exceeds cost threshold
 *
 * Useful for alerting or rate limiting high-cost users
 *
 * @param userId - User ID
 * @param thresholdUSD - Cost threshold in USD
 * @param days - Number of days to check
 * @returns true if user exceeds threshold
 */
export async function exceedsCostThreshold(
  userId: string,
  thresholdUSD: number,
  days: number = 1
): Promise<boolean> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const usage = await getUserTokenUsage(userId, startDate);

  return exceedsThreshold(usage.totalCostUSD, thresholdUSD);
}

/**
 * Get average cost per query
 *
 * @param userId - User ID
 * @param queryType - Optional filter by query type
 * @returns Average cost per query
 */
export async function getAverageCostPerQuery(
  userId: string,
  queryType?: "fast" | "advanced"
): Promise<{ avgCostUSD: number; avgCostINR: number }> {
  try {
    const where: any = { userId };
    if (queryType) where.queryType = queryType;

    const result = await prisma.tokenUsage.aggregate({
      where,
      _avg: {
        estimatedCost: true,
      },
    });

    const avgCostUSD = result._avg.estimatedCost || 0;

    return {
      avgCostUSD,
      avgCostINR: convertToINR(avgCostUSD),
    };
  } catch (error) {
    logger.error({ error, userId }, "Failed to get average cost per query");
    return { avgCostUSD: 0, avgCostINR: 0 };
  }
}
