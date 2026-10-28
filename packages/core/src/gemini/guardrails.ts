/**
 * Gemini LLM Integration - Guardrails System
 *
 * This file implements a multi-layer content filtering system to ensure:
 * 1. Only finance-related topics are discussed
 * 2. Off-topic queries are blocked but still charged
 * 3. Content safety and appropriateness
 *
 * The pure decision logic (keyword lists, topic-validation stages, injection
 * patterns, sanitization, cache maths) lives in the dependency-free sibling
 * `./guardrails-core` so it can be unit-tested without the logger / Vertex AI.
 * This file only adds the async / LLM / logging concerns on top.
 */

import { geminiLogger as logger } from "@usemoney/logger";
import type { TopicValidationResult } from "@usemoney/types";
import { getVertexAIClient } from "./client";
import {
  CACHE_TTL_MS,
  FALLBACK_ALLOW,
  STAGE_5_LLM_HYBRID,
  cleanupGuardrailCache,
  detectPromptInjection as detectPromptInjectionCore,
  evaluateFinanceTopic,
  exceedsSanitizeLimit,
  filterUnsafeContent as filterUnsafeContentCore,
  getBlockedKeywords as getBlockedKeywordsCore,
  getFinanceKeywords as getFinanceKeywordsCore,
  guardrailCacheKey,
  matchBlockedKeywords,
  matchFinanceKeywords,
  readGuardrailCache,
  sanitizeUserInput as sanitizeUserInputCore,
  validateWithLLMRetry,
  type GuardrailCacheEntry,
} from "./guardrails-core";

// Simple in-memory cache for guardrail validations (10 minute TTL)
const guardrailCache = new Map<string, GuardrailCacheEntry>();

// Track if cleanup interval is set up
let cleanupIntervalId: NodeJS.Timeout | null = null;

/**
 * Start the cache cleanup interval
 */
export function startCacheCleanup(): void {
  if (cleanupIntervalId) return;

  cleanupIntervalId = setInterval(
    () => {
      const cleanedCount = cleanupGuardrailCache(guardrailCache);

      if (cleanedCount > 0) {
        logger.debug(
          { cleanedCount, remainingEntries: guardrailCache.size },
          "Guardrail cache cleaned",
        );
      }
    },
    5 * 60 * 1000,
  );
}

/**
 * Stop the cache cleanup interval
 */
export function stopCacheCleanup(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

/**
 * Use LLM to validate if query is finance-related (optional, more accurate)
 *
 * This uses Gemini 2.5 Flash (cheap, fast, higher rate limits) to classify the topic
 * Enable by setting USE_LLM_GUARDRAILS=true in .env
 */
async function validateWithLLM(query: string): Promise<TopicValidationResult> {
  // The cache-hit debug log fires only when the entry is actually served, so
  // peek before delegating (the orchestrator re-reads the cache as the SoT).
  const cacheKey = guardrailCacheKey(query);
  if (readGuardrailCache(guardrailCache, cacheKey)) {
    logger.debug({ query, cached: true }, "LLM validation served from cache");
  }

  return validateWithLLMRetry(query, {
    cache: guardrailCache,
    llmCall: async () => {
      const vertexAI = getVertexAIClient();
      // Use gemini-2.5-flash instead of experimental model for higher rate limits
      const model = vertexAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      const classificationPrompt = `You are a topic classifier. Determine if this query is related to finance, investing, trading, stocks, retirement planning, or money management.

Query: "${query}"

Respond with ONLY "YES" if it's finance-related, or "NO" if it's not.`;

      const result = await model.generateContent(classificationPrompt);
      const candidate = result.response.candidates?.[0];
      const part = candidate?.content?.parts?.[0];
      const response = part?.text?.trim().toUpperCase() ?? "";

      logger.info(
        {
          query,
          llmResponse: response,
          isFinanceRelated: response === "YES",
        },
        "LLM topic classification",
      );

      return response;
    },
    onRetry: ({ retryCount, delay, errorMessage }) => {
      // Exponential backoff: 1s, 2s, 4s
      logger.warn(
        { query, retryCount, delay, error: errorMessage },
        `Rate limit hit, retrying after ${delay}ms`,
      );
    },
    onFailure: ({ error, retryCount }) => {
      logger.error(
        { error, retryCount },
        "LLM validation failed, falling back to keyword matching",
      );
    },
  });
}

/**
 * Validate if a query is finance-related
 *
 * This function implements a multi-stage validation:
 * 1. Check for blocked topics (immediate rejection with word boundaries)
 * 2. Optional: Use LLM for smart classification (if USE_LLM_GUARDRAILS=true)
 * 3. Check for finance keywords (acceptance)
 * 4. Finance-related question patterns
 * 5. Length-based heuristics (short queries without keywords are suspicious)
 *
 * The pure decision (stages 1-4 + 6 fallback) lives in
 * `validateFinanceTopicSync`; this wrapper adds logging and the stage-5 LLM
 * escalation. The branch-specific log lines are reconstructed from the sync
 * result so behaviour (and the structured log payloads) are unchanged.
 *
 * @param query - User's query text
 * @returns Validation result with isValid flag and optional reason
 */
export async function validateFinanceTopic(
  query: string,
): Promise<TopicValidationResult> {
  const lowerQuery = query.toLowerCase().trim();

  const evaluation = evaluateFinanceTopic(query);

  if (evaluation.stage !== STAGE_5_LLM_HYBRID) {
    // Emit the exact branch-specific log the original inlined at each stage.
    switch (evaluation.stage) {
      case "tooShort":
        logger.warn({ query }, "Query too short");
        break;
      case "blocked":
        logger.info(
          { query, blockedMatches: matchBlockedKeywords(lowerQuery) },
          "Query blocked - non-finance topic detected",
        );
        break;
      case "keyword":
        logger.info(
          {
            query,
            financeMatches: matchFinanceKeywords(
              lowerQuery,
              lowerQuery.split(/\s+/),
            ),
          },
          "Finance topic validated via keywords",
        );
        break;
      case "pattern":
        logger.info({ query }, "Finance topic validated via pattern match");
        break;
      case "shortNoKeyword":
        logger.warn(
          { query, wordCount: lowerQuery.split(/\s+/).length },
          "Short query without finance keywords",
        );
        break;
    }
    return evaluation.result;
  }

  // Stage 5: HYBRID - Use LLM for ambiguous longer queries (best accuracy at minimal cost)
  // This only triggers for queries that:
  // - Passed blocked keyword check (not obviously off-topic)
  // - Didn't match finance keywords (ambiguous)
  // - Are reasonably long (>5 words)
  // Cost: Only ~5-10% of queries reach here, so ~$0.001 per 1000 queries total
  if (process.env.USE_LLM_GUARDRAILS === "true") {
    logger.info({ query }, "Ambiguous query - using LLM for smart validation");
    return await validateWithLLM(query);
  }

  // Stage 6: Fallback - Allow ambiguous queries but log for monitoring
  logger.warn(
    { query },
    "Ambiguous query - allowing but monitoring (enable USE_LLM_GUARDRAILS for better accuracy)",
  );
  return FALLBACK_ALLOW;
}

/**
 * Filter potentially unsafe content from LLM response
 *
 * This is a basic filter. In production, you might integrate with
 * Google's Safety API or other content moderation services.
 *
 * @param response - LLM-generated response
 * @returns Filtered response
 */
export function filterUnsafeContent(response: string): string {
  return filterUnsafeContentCore(response);
}

/**
 * Check if query contains potential prompt injection attempts
 *
 * Detects common prompt injection patterns like:
 * - "Ignore previous instructions"
 * - "SYSTEM:", "ASSISTANT:", "USER:" role markers
 * - Attempts to override system behavior
 *
 * @param query - User's query
 * @returns true if injection attempt detected
 */
export function detectPromptInjection(query: string): boolean {
  const detected = detectPromptInjectionCore(query);

  if (detected) {
    logger.warn({ query }, "Prompt injection attempt detected");
  }

  return detected;
}

/**
 * Sanitize user input before sending to LLM
 *
 * Removes potential injection attempts and enforces length limits
 *
 * @param input - Raw user input
 * @returns Sanitized input
 */
export function sanitizeUserInput(input: string): string {
  // Surface the truncation warning the original logged before slicing.
  if (exceedsSanitizeLimit(input.length)) {
    logger.warn(
      { originalLength: input.length },
      "Input truncated to 5000 characters",
    );
  }
  return sanitizeUserInputCore(input);
}

/**
 * Comprehensive input validation
 *
 * Combines topic validation, injection detection, and sanitization
 *
 * @param query - User's query
 * @returns Validation result and sanitized query
 */
export async function validateAndSanitize(query: string): Promise<{
  valid: boolean;
  sanitizedQuery: string;
  reason?: string;
}> {
  // Sanitize first
  const sanitized = sanitizeUserInput(query);

  // Check for injection attempts
  if (detectPromptInjection(sanitized)) {
    return {
      valid: false,
      sanitizedQuery: sanitized,
      reason:
        "Your query contains patterns that are not allowed. Please ask a straightforward finance question.",
    };
  }

  // Validate topic
  const validation = await validateFinanceTopic(sanitized);

  if (!validation.isValid) {
    return {
      valid: false,
      sanitizedQuery: sanitized,
      reason: validation.reason,
    };
  }

  return {
    valid: true,
    sanitizedQuery: sanitized,
  };
}

/**
 * Get the list of finance keywords (for testing/debugging)
 */
export function getFinanceKeywords(): readonly string[] {
  return getFinanceKeywordsCore();
}

/**
 * Get the list of blocked keywords (for testing/debugging)
 */
export function getBlockedKeywords(): readonly string[] {
  return getBlockedKeywordsCore();
}

// Re-export the cache TTL constant for any callers relying on it.
export { CACHE_TTL_MS };
