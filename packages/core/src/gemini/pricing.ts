/**
 * Gemini LLM Integration - Pricing and Cost Calculations
 *
 * This file handles cost estimation for Gemini API calls.
 * Database tracking functions should stay in the app layer.
 */

import { geminiLogger as logger } from "@usemoney/logger";
import type { ModelPricing, QueryMode } from "@usemoney/types";

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
  "gemini-2.5-flash-lite": {
    inputCostPer1M: 0.05,
    outputCostPer1M: 0.2,
  },
  "gemini-2.5-pro": {
    inputCostPer1M: 1.25, // $1.25 per 1M input tokens
    outputCostPer1M: 5.0, // $5.00 per 1M output tokens
  },
  // Gemini 3.x — live Developer API ids (MONEY-650). The picker/routing emit
  // the versioned preview ids (gemini-3-flash-preview / gemini-3.1-pro-preview);
  // the bare gemini-3-flash / gemini-3-pro keys are RETAINED as back-compat
  // aliases so any legacy/cached id still prices (calculateCost falls back to
  // 0 + a warn on a miss). Flash rates per Google's published $0.50/$3.00;
  // 3-pro is context-length-dependent so this is an upper-bound estimate.
  // Update when official rates are confirmed.
  "gemini-3-flash-preview": {
    inputCostPer1M: 0.5,
    outputCostPer1M: 3.0,
  },
  "gemini-3-flash": {
    inputCostPer1M: 0.5,
    outputCostPer1M: 3.0,
  },
  "gemini-3.5-flash": {
    inputCostPer1M: 0.6,
    outputCostPer1M: 3.5,
  },
  "gemini-3.1-pro-preview": {
    inputCostPer1M: 2.0,
    outputCostPer1M: 12.0,
  },
  "gemini-3-pro": {
    inputCostPer1M: 2.0,
    outputCostPer1M: 12.0,
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
  outputTokens: number,
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
 * Get the current USD to INR rate
 */
export function getUsdToInrRate(): number {
  return USD_TO_INR;
}

/**
 * Get model name based on query type
 *
 * @param queryType - Query mode (fast or advanced)
 * @returns Model name for the query type
 */
export function getModelForQueryType(queryType: QueryMode): string {
  return queryType === "fast" ? "gemini-2.5-flash" : "gemini-2.5-pro";
}

/**
 * Estimate cost for a query
 *
 * @param queryType - Query mode
 * @param inputTokens - Estimated input tokens
 * @param outputTokens - Estimated output tokens
 * @returns Cost estimate in USD and INR
 */
export function estimateQueryCost(
  queryType: QueryMode,
  inputTokens: number,
  outputTokens: number,
): { costUSD: number; costINR: number } {
  const modelName = getModelForQueryType(queryType);
  const costUSD = calculateCost(modelName, inputTokens, outputTokens);
  return {
    costUSD,
    costINR: convertToINR(costUSD),
  };
}

/**
 * Get pricing for a specific model
 *
 * @param modelName - Name of the model
 * @returns Pricing info or undefined if model not found
 */
export function getModelPricing(modelName: string): ModelPricing | undefined {
  return GEMINI_PRICING[modelName];
}

/**
 * Get all available model pricing
 */
export function getAllModelPricing(): Record<string, ModelPricing> {
  return { ...GEMINI_PRICING };
}

/**
 * Check if a model is a "flash" (cheap) model
 */
export function isFlashModel(modelName: string): boolean {
  return modelName.toLowerCase().includes("flash");
}

/**
 * Check if a model is a "pro" (expensive) model
 */
export function isProModel(modelName: string): boolean {
  return modelName.toLowerCase().includes("pro");
}
