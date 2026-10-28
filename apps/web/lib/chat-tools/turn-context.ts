/**
 * Conversation Memory Layer - Turn Context
 *
 * Manages per-turn metadata (TurnMeta) and aggregated conversation state
 * (ConversationState) cached in Redis. Enables follow-up resolution:
 * "yes" → re-trigger last tool, "tighten filter" → merge screener params,
 * "tell me more" → escalate tier, "the top stock" → resolve from activeSymbols.
 *
 * Redis key: conv-state:{chatId} or conv-state:{userId}:{pagePath}
 * TTL: 1 hour
 */

import type { TurnMeta } from "@usemoney/types";
import { geminiLogger as logger } from "@usemoney/logger";

// ============== Types ==============

export interface ConversationState {
  lastTurnMeta: TurnMeta;
  activePersona?: string;
  activeSymbols: string[];
  activeScreenerState?: TurnMeta["screenerState"];
  turnCount: number;
  lastUpdated: number;
}

export interface FollowUpResult {
  intent: string;
  tool: string;
  params: Record<string, unknown>;
  tier?: "L1" | "L2" | "L3";
  persona?: string;
  escalateTier?: boolean;
}

// ============== Redis Keys ==============

const CONV_STATE_PREFIX = "conv-state";
const CONV_STATE_TTL = 3600; // 1 hour

/**
 * Build the Redis key for a conversation's turn-context state.
 *
 * Exported so the contract (chatId wins; otherwise userId:pagePath, with a
 * "default" pagePath fallback) can be asserted directly by tests instead of a
 * copy. Both `loadPriorTurnContext` and `saveTurnContext` call this, so it is
 * never dead.
 */
export function getConvStateKey(
  userId: string,
  chatId?: string,
  pagePath?: string
): string {
  if (chatId) return `${CONV_STATE_PREFIX}:${chatId}`;
  return `${CONV_STATE_PREFIX}:${userId}:${pagePath || "default"}`;
}

/**
 * Pure fallback used when Redis is unavailable: reconstruct the conversation
 * state from the last assistant message that carries a `turnMeta` in the
 * conversation history. Exported (and called by `loadPriorTurnContext`) so the
 * fallback logic is unit-testable without standing up Redis.
 */
export function extractStateFromHistory(
  conversationHistory?: Array<{
    role: string;
    content: string;
    turnMeta?: TurnMeta;
  }>
): ConversationState | null {
  if (!conversationHistory || conversationHistory.length === 0) return null;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i]!;
    if (msg.role === "assistant" && msg.turnMeta) {
      const meta = msg.turnMeta;
      return {
        lastTurnMeta: meta,
        activePersona: meta.persona,
        activeSymbols: meta.symbols || [],
        activeScreenerState: meta.screenerState,
        turnCount: conversationHistory.filter((m) => m.role === "user").length,
        lastUpdated: Date.now(),
      };
    }
  }
  return null;
}

// ============== Load / Save ==============

/**
 * Load prior turn context from Redis, falling back to conversationHistory turnMeta.
 */
export async function loadPriorTurnContext(
  userId: string,
  chatId: string | undefined,
  pagePath: string,
  conversationHistory?: Array<{
    role: string;
    content: string;
    turnMeta?: TurnMeta;
  }>
): Promise<ConversationState | null> {
  // 1. Try Redis
  try {
    const { getRedisClient } = await import("@/lib/redis/client");
    const redis = getRedisClient();
    if (redis) {
      const key = getConvStateKey(userId, chatId, pagePath);
      const raw = await redis.get(key);
      if (raw) {
        const state = JSON.parse(raw) as ConversationState;
        logger.debug(
          { userId, chatId, turnCount: state.turnCount },
          "Loaded conversation state from Redis"
        );
        return state;
      }
    }
  } catch (error) {
    logger.warn(
      { error, userId, chatId },
      "Failed to load conversation state from Redis, falling back to history"
    );
  }

  // 2. Fallback: extract turnMeta from last assistant message in conversationHistory
  return extractStateFromHistory(conversationHistory);
}

/**
 * Save conversation state to Redis (fire-and-forget).
 */
export async function saveTurnContext(
  userId: string,
  chatId: string | undefined,
  pagePath: string,
  turnMeta: TurnMeta,
  priorState: ConversationState | null
): Promise<void> {
  try {
    const { getRedisClient } = await import("@/lib/redis/client");
    const redis = getRedisClient();
    if (!redis) return;

    // Merge symbols: keep prior + add new (deduped)
    const priorSymbols = priorState?.activeSymbols || [];
    const newSymbols = turnMeta.symbols || [];
    const mergedSymbols = Array.from(
      new Set([...priorSymbols, ...newSymbols])
    ).slice(0, 20); // Cap at 20 symbols

    const state: ConversationState = {
      lastTurnMeta: turnMeta,
      activePersona: turnMeta.persona || priorState?.activePersona,
      activeSymbols: mergedSymbols,
      activeScreenerState:
        turnMeta.screenerState || priorState?.activeScreenerState,
      turnCount: (priorState?.turnCount || 0) + 1,
      lastUpdated: Date.now(),
    };

    const key = getConvStateKey(userId, chatId, pagePath);
    await redis.set(key, JSON.stringify(state), "EX", CONV_STATE_TTL);

    logger.debug(
      { userId, chatId, turnCount: state.turnCount },
      "Saved conversation state to Redis"
    );
  } catch (error) {
    logger.warn(
      { error, userId, chatId },
      "Failed to save conversation state to Redis"
    );
  }
}

// ============== Follow-Up Detection ==============

/**
 * Fast-path follow-up detection using regex.
 * Returns a FollowUpResult if the message is a clear follow-up, null otherwise.
 *
 * Only triggers when priorState has a meaningful last tool.
 */
export function detectFollowUpFast(
  message: string,
  priorState: ConversationState | null
): FollowUpResult | null {
  if (!priorState?.lastTurnMeta?.tool) return null;

  const normalized = message.trim().toLowerCase();
  const lastMeta = priorState.lastTurnMeta;
  const lastTool = lastMeta.tool!; // guaranteed by guard above

  // Pattern 1: Affirmative - re-trigger last tool with same params
  if (
    /^(yes|ok|okay|sure|go\s*ahead|do\s*it|proceed|yep|yeah)[.!]?$/i.test(
      normalized
    )
  ) {
    return {
      intent: lastMeta.intent || "follow_up",
      tool: lastTool,
      params: lastMeta.toolParams || {},
      tier: lastMeta.tier,
      persona: lastMeta.persona || priorState.activePersona,
    };
  }

  // Pattern 2: Deepen - same tool, escalate tier
  if (
    /^(tell\s*me\s*more|expand|elaborate|more\s*details?|explain\s*further|go\s*deeper|deep\s*dive|dig\s*deeper)[.!]?$/i.test(
      normalized
    )
  ) {
    return {
      intent: lastMeta.intent || "follow_up",
      tool: lastTool,
      params: lastMeta.toolParams || {},
      tier: lastMeta.tier,
      persona: lastMeta.persona || priorState.activePersona,
      escalateTier: true,
    };
  }

  // Pattern 3: Rejection - return null so Flash classifies fresh
  if (
    /^(no|nope|different|something\s*else|never\s*mind)[.!]?$/i.test(normalized)
  ) {
    return null;
  }

  // Pattern 4: Chip reply to a bare-stock disambiguation prompt.
  // The prompt offers: Equity Research, Deep Valuation, Technical Analysis,
  // Peer Comparison, Latest News. Without this pattern, the chip text falls
  // through to Flash and lands in "fast" research mode (~7 tasks) instead of
  // "advanced" (~23 tasks), making deep analysis from chips silently weaker.
  if (lastMeta.intent === "bare_stock_options") {
    const symbols =
      (lastMeta.symbols && lastMeta.symbols.length > 0
        ? lastMeta.symbols
        : priorState.activeSymbols) || [];

    // Match chip labels case-insensitively. Strip punctuation/markdown bullets.
    const stripped = message
      .replace(/^[\s\-*•·]+/, "")
      .replace(/[*_`]/g, "")
      .trim()
      .toLowerCase();

    type ChipRoute = {
      pattern: RegExp;
      tool: string;
      params: Record<string, unknown>;
    };
    const baseSymbols = symbols.length > 0 ? symbols : undefined;
    const chipRoutes: ChipRoute[] = [
      {
        pattern: /^(equity\s*research|investment\s*thesis)\b/i,
        tool: "run_research",
        params: {
          symbols: baseSymbols,
          mode: "advanced",
          skill: "investment-thesis",
        },
      },
      {
        pattern:
          /^(deep\s*valuation|dcf(\s*valuation)?|valuation|fundamental(s|\s*analysis)?)\b/i,
        tool: "run_research",
        params: {
          symbols: baseSymbols,
          mode: "advanced",
          skill: "dcf-valuation",
        },
      },
      {
        pattern: /^(technical(s|\s*analysis)?|charts?\s*analysis)\b/i,
        tool: "run_research",
        // No dedicated technical skill - stock-analysis includes RSI/MACD/etc.
        params: {
          symbols: baseSymbols,
          mode: "advanced",
          skill: "stock-analysis",
        },
      },
      {
        pattern: /^(peer\s*comparison|compare(\s*peers?|\s*sector)?|peers?)\b/i,
        tool: "run_research",
        params: {
          symbols: baseSymbols,
          mode: "advanced",
          skill: "peer-comparison",
        },
      },
      {
        pattern: /^(latest\s*news|news|headlines?|recent\s*news)\b/i,
        tool: "get_stock_news",
        params: {
          symbol: baseSymbols?.[0],
        },
      },
    ];

    for (const route of chipRoutes) {
      if (route.pattern.test(stripped)) {
        // Always include the user's full message as the research query.
        const params = { ...route.params };
        if (route.tool === "run_research" && !params.query) {
          params.query = message.trim();
        }
        return {
          intent: "bare_stock_chip_reply",
          tool: route.tool,
          params,
          tier: lastMeta.tier,
          persona: lastMeta.persona || priorState.activePersona,
        };
      }
    }
  }

  return null;
}

// ============== Screener Filter Merge ==============

/**
 * Merge new screener filters with prior state.
 * - Keeps prior filters, overrides same-field filters with new ones
 * - Carries forward index/exchange filters
 */
export function mergeScreenerParams(
  priorScreenerState: NonNullable<TurnMeta["screenerState"]>,
  newParams: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...newParams };

  // Carry forward index filter if not specified in new params
  if (priorScreenerState.indexFilter && !merged.indexFilter) {
    merged.indexFilter = priorScreenerState.indexFilter;
  }

  // Carry forward strategy if not specified
  if (priorScreenerState.strategy && !merged.strategy) {
    merged.strategy = priorScreenerState.strategy;
  }

  // Merge filters: new overrides prior on same field, prior fills gaps
  const newFilters = (merged.filters || []) as Array<{
    field: string;
    operator: string;
    value: unknown;
  }>;
  const priorFilters: Array<{
    field: string;
    operator: string;
    value: unknown;
  }> = priorScreenerState.filters || [];

  if (priorFilters.length > 0) {
    const newFieldSet = new Set(newFilters.map((f) => f.field));
    const carriedFilters = priorFilters.filter(
      (f) => !newFieldSet.has(f.field)
    );
    merged.filters = [...newFilters, ...carriedFilters];
  }

  return merged;
}

// ============== Build Context for Prompts ==============

/**
 * Format ConversationState as a text block for Flash/Gemini prompts.
 */
export function formatStateForPrompt(state: ConversationState): string {
  const lines: string[] = [];
  const m = state.lastTurnMeta;

  if (m.tool) lines.push(`- Last tool: ${m.tool}`);
  if (m.intent) lines.push(`- Last intent: ${m.intent}`);
  if (state.activePersona)
    lines.push(`- Active persona: ${state.activePersona}`);
  if (state.activeSymbols.length > 0) {
    lines.push(`- Stocks discussed: ${state.activeSymbols.join(", ")}`);
  }
  if (state.activeScreenerState) {
    const ss = state.activeScreenerState;
    lines.push(
      `- Active screener: "${ss.query}"${ss.resultCount !== undefined ? ` (${ss.resultCount} results)` : ""}`
    );
    if (ss.filters && ss.filters.length > 0) {
      lines.push(`- Filters: ${JSON.stringify(ss.filters)}`);
    }
    if (ss.indexFilter) {
      lines.push(`- Index filter: ${ss.indexFilter}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build the FOLLOW-UP RULES block for Flash classifier prompt.
 */
export function buildFollowUpRules(): string {
  return `FOLLOW-UP RULES (when PRIOR TURN CONTEXT is present):
- "yes"/"ok"/"go ahead" → reuse last tool + params (same intent)
- "tighten"/"add filter"/"remove filter"/"change" → screener with merged filters
- "tell me more"/"expand"/"go deeper" → same tool, escalate tier (L1→L2→L3)
- "the top stock"/"first one"/"best one" → resolve from activeSymbols[0]
- "compare them"/"compare these" → comparison using activeSymbols
- "no"/"different"/"something else" → classify fresh, ignore prior context
- If user references "above stock"/"this stock" → resolve from activeSymbols`;
}

// ============== Screener-result → TurnMeta capture ==============

/**
 * Coerce a screener tool's `result.data` into a flat array of result rows.
 *
 * Screener data arrives either as a bare array or wrapped as `{ data: [...] }`.
 * Anything else (null/undefined/scalar/object-without-data) yields `null`.
 * Pure — exported so the fast-path screener capture in the chat route and its
 * tests run the identical normalisation.
 */
export function extractScreenerRows(
  toolResultData: unknown
): Record<string, unknown>[] | null {
  if (Array.isArray(toolResultData)) {
    return toolResultData as Record<string, unknown>[];
  }
  if (
    toolResultData &&
    typeof toolResultData === "object" &&
    Array.isArray((toolResultData as Record<string, unknown>).data)
  ) {
    return (toolResultData as Record<string, unknown>).data as Record<
      string,
      unknown
    >[];
  }
  return null;
}

/** Read a row's symbol, tolerating both Yahoo (`symbol`) + Kite (`tradingsymbol`). */
function rowSymbol(row: Record<string, unknown>): string {
  return (row.symbol || row.tradingsymbol || "") as string;
}

/**
 * Derive the `screenerState` TurnMeta slice + the discussed-symbols list from a
 * screener tool's params and result data.
 *
 * This is the exact capture the chat route runs after a fast-path
 * `run_screener` execution (it was previously inlined there). Extracted +
 * exported so the route and the unit tests execute the same code:
 *   - `resultCount` = number of matched rows
 *   - `resultSummary` = first 5 symbols, comma-joined
 *   - `symbols` = first 10 non-empty symbols (undefined when no rows)
 *
 * `fallbackQuery` is used when params carry no `query` (the route passes the
 * sanitized user message).
 */
export function deriveScreenerTurnState(
  params: Record<string, unknown>,
  toolResultData: unknown,
  fallbackQuery: string
): {
  screenerState: NonNullable<TurnMeta["screenerState"]>;
  symbols: string[] | undefined;
} {
  const rows = extractScreenerRows(toolResultData);

  const screenerState: NonNullable<TurnMeta["screenerState"]> = {
    query: (params.query as string) || fallbackQuery,
    strategy: params.strategy as string | undefined,
    filters: params.filters as
      | Array<{ field: string; operator: string; value: unknown }>
      | undefined,
    indexFilter: params.indexFilter as string | undefined,
    resultCount: rows?.length,
    resultSummary: rows
      ? rows.slice(0, 5).map(rowSymbol).join(", ")
      : undefined,
  };

  const symbols = rows
    ? rows.slice(0, 10).map(rowSymbol).filter(Boolean)
    : undefined;

  return { screenerState, symbols };
}
