/**
 * Flash Responder (L1)
 *
 * Handles L1 Flash queries entirely inline - no Pub/Sub, no research agent, <5s.
 * For stock queries: fetches Yahoo data directly, then uses Gemini Flash for a brief narrative.
 * For definitions: uses Gemini Flash with finance knowledge prompt.
 *
 * No credits consumed - L1 is free for all plans (rate-limited by existing limiter).
 */

import type {
  ChatResponse,
  ContentBlock,
  QueryMode,
  TurnMeta,
} from "@usemoney/types";
import {
  getGeminiModelById,
  generateWithTimeout,
  estimateTokenCount,
  isGeminiEnabled,
} from "@usemoney/core";
import { resolveChatModel } from "@usemoney/core/gemini/model-registry";
import prisma from "@usemoney/database";
import { yahooFetchQuoteSummary } from "@usemoney/core/market-data";
import { extractSymbolsFromQuery, resolveSymbol } from "@usemoney/research";
import { trackTokenUsage } from "@/lib/gemini/cost-tracker";
import {
  FLASH_SYSTEM_PROMPT,
  buildFlashUserPrompt,
} from "@/lib/gemini/flash-prompt";
import { geminiLogger as logger } from "@usemoney/logger";
// De-shadowed (MONEY-620): the pure helpers (isDefinitionQuery,
// extractFinancialData, MIN_FINANCIAL_FIELDS) live in flash-responder-logic.ts
// so they can be unit-tested without this module's Prisma/Gemini/research chain.
import {
  isDefinitionQuery,
  extractFinancialData,
} from "./flash-responder-logic";

/** Timeout for L1 Flash Gemini call (shorter than default) */
const FLASH_TIMEOUT_MS = 15_000;

/**
 * MONEY-619: resolve the L1 chat-flash model for the user's tier.
 *
 * The caller (chat route) already knows the plan, so it threads it in.
 * When it doesn't, we read the subscription. resolveChatModel (no
 * `thinking`) returns the tier's Flash model — with ENABLE_GEMINI_3X off
 * this is gemini-2.5-flash for every tier, so behavior is unchanged until
 * the 3.x rollout.
 */
async function resolveFlashModelId(
  userId: string,
  planId?: string
): Promise<string> {
  let plan = planId;
  if (!plan) {
    try {
      const sub = await prisma.subscription.findUnique({
        where: { userId },
        select: { planId: true },
      });
      plan = sub?.planId ?? "FREE";
    } catch {
      plan = "FREE";
    }
  }
  return resolveChatModel(plan);
}

/**
 * Handle an L1 Flash query.
 *
 * @param message - User's sanitized message
 * @param userId - Internal DB user ID
 * @param pagePath - Current page path
 * @param requestId - Request trace ID
 * @param planId - The user's base plan (threaded from the chat route so we
 *   skip a duplicate subscription read). Falls back to a DB lookup.
 * @returns ChatResponse with narrative + optional card block
 */
export async function handleFlashQuery(
  message: string,
  userId: string,
  pagePath: string,
  requestId: string,
  planId?: string
): Promise<ChatResponse> {
  const startTime = Date.now();

  // For definition questions, skip stock lookup entirely
  if (isDefinitionQuery(message)) {
    const result = await handleDefinitionQuery(
      message,
      userId,
      pagePath,
      requestId,
      startTime,
      planId
    );
    result.turnMeta = {
      intent: "quick_lookup",
      tier: "L1",
      persona: "general_analyst",
    };
    return result;
  }

  // Try to extract stock symbols from the query
  const symbols = extractSymbolsFromQuery(message);
  let financialData: {
    items: Array<{ label: string; value: string }>;
    isRich: boolean;
  } | null = null;
  let rawData: Record<string, unknown> | null = null;
  let resolvedSymbol: string | null = null;

  if (symbols.length > 0) {
    resolvedSymbol = resolveSymbol(symbols[0]!);
    try {
      const data = await yahooFetchQuoteSummary(resolvedSymbol, [
        "defaultKeyStatistics",
        "financialData",
        "price",
      ]);
      if (data) {
        rawData = data as Record<string, unknown>;
        financialData = extractFinancialData(rawData);
      }
    } catch (error) {
      logger.warn(
        { requestId, symbol: resolvedSymbol, error },
        "Flash: Yahoo data fetch failed"
      );
    }
  }

  // Check data quality
  const hasData = financialData !== null && financialData.isRich;

  // Build response blocks
  const blocks: ContentBlock[] = [];

  // Add metric card if we have financial data
  if (financialData && financialData.items.length > 0) {
    blocks.push({
      type: "card",
      variant: "metric",
      title: resolvedSymbol
        ? `${resolvedSymbol.replace(/\.(NS|BO)$/, "")} Key Metrics`
        : "Key Metrics",
      items: financialData.items.slice(0, 12),
    } as ContentBlock);
  }

  // Generate Gemini Flash narrative
  if (!isGeminiEnabled()) {
    const fallback = hasData
      ? "Here are the key metrics for your query."
      : "Limited data available. Try a Deep Dive for comprehensive analysis.";
    blocks.unshift({ type: "text", content: fallback });
    return {
      response: fallback,
      blocks,
      queryType: "fast" as QueryMode,
      turnMeta: {
        intent: "quick_lookup",
        tier: "L1",
        persona: "general_analyst",
      },
    };
  }

  try {
    const dataJson = hasData
      ? JSON.stringify(rawData).slice(0, 3000)
      : "No data available";
    const userPrompt = buildFlashUserPrompt(message, dataJson, hasData);
    const fullPrompt = `${FLASH_SYSTEM_PROMPT}\n\n${userPrompt}`;

    const model = getGeminiModelById(await resolveFlashModelId(userId, planId));
    const narrative = await generateWithTimeout(
      model,
      fullPrompt,
      FLASH_TIMEOUT_MS,
      1
    );

    const duration = Date.now() - startTime;

    // Track token usage asynchronously
    trackTokenUsage({
      userId,
      queryType: "fast" as QueryMode,
      inputTokens: estimateTokenCount(fullPrompt),
      outputTokens: estimateTokenCount(narrative),
      duration,
      pagePath,
    }).catch((error) => {
      logger.error({ error }, "Flash: Failed to track token usage");
    });

    // Prepend narrative as text block
    blocks.unshift({ type: "text", content: narrative });

    logger.info(
      { requestId, userId, duration, symbol: resolvedSymbol, tier: "L1" },
      "Flash query completed"
    );

    const flashTurnMeta: TurnMeta = {
      intent: "quick_lookup",
      tier: "L1",
      tool: "get_financial_data",
      persona: "equity_research",
      symbols: resolvedSymbol
        ? [resolvedSymbol.replace(/\.(NS|BO)$/, "")]
        : symbols.length > 0
          ? [symbols[0]!]
          : undefined,
    };

    return {
      response: narrative,
      blocks,
      queryType: "fast" as QueryMode,
      turnMeta: flashTurnMeta,
    };
  } catch (error) {
    logger.error(
      { requestId, error, userId },
      "Flash: Gemini generation failed"
    );

    // Graceful fallback
    const fallback = hasData
      ? "Here are the key metrics I found."
      : "I couldn't find enough data for this stock. Try asking for a Deep Dive for more thorough analysis.";
    blocks.unshift({ type: "text", content: fallback });

    return {
      response: fallback,
      blocks,
      queryType: "fast" as QueryMode,
      turnMeta: {
        intent: "quick_lookup",
        tier: "L1",
        persona: "general_analyst",
      },
    };
  }
}

/**
 * Handle a definition/concept question with Gemini Flash only (no data lookup)
 */
async function handleDefinitionQuery(
  message: string,
  userId: string,
  pagePath: string,
  requestId: string,
  startTime: number,
  planId?: string
): Promise<ChatResponse> {
  if (!isGeminiEnabled()) {
    return {
      response: "AI is currently unavailable. Please try again later.",
      queryType: "fast" as QueryMode,
    };
  }

  try {
    const userPrompt = `The user asked: "${message}"\n\nProvide a clear, concise definition/explanation. Include a practical example relevant to Indian markets where appropriate.`;
    const fullPrompt = `${FLASH_SYSTEM_PROMPT}\n\n${userPrompt}`;

    const model = getGeminiModelById(await resolveFlashModelId(userId, planId));
    const narrative = await generateWithTimeout(
      model,
      fullPrompt,
      FLASH_TIMEOUT_MS,
      1
    );

    const duration = Date.now() - startTime;

    trackTokenUsage({
      userId,
      queryType: "fast" as QueryMode,
      inputTokens: estimateTokenCount(fullPrompt),
      outputTokens: estimateTokenCount(narrative),
      duration,
      pagePath,
    }).catch((error) => {
      logger.error({ error }, "Flash: Failed to track token usage");
    });

    logger.info(
      { requestId, userId, duration, tier: "L1", type: "definition" },
      "Flash definition query completed"
    );

    return {
      response: narrative,
      blocks: [{ type: "text", content: narrative }],
      queryType: "fast" as QueryMode,
    };
  } catch (error) {
    logger.error(
      { requestId, error, userId },
      "Flash: Definition query failed"
    );
    return {
      response:
        "I'm having trouble processing your question right now. Please try again.",
      queryType: "fast" as QueryMode,
    };
  }
}
