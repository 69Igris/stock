/**
 * Unified Chat API Endpoint
 *
 * This endpoint handles all chat requests for Gemini LLM integration.
 * It orchestrates guardrails, query consumption, model selection, action detection,
 * tool execution, block parsing, and multi-turn conversation support.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { auth } from "@clerk/nextjs/server";
import { apiRateLimiter } from "@usemoney/security/rate-limit";
import { consumeAIQuery, refundAIQuery } from "@/lib/actions/subscription";
import { consumeCredits, refundCredits } from "@usemoney/services";
import {
  getResearchPreferences,
  resolveEffectiveSkills,
  RESEARCH_DEFAULT_MODEL,
} from "@usemoney/services/preferences";
import type {
  ResearchPreferences,
  ResearchPresetId,
  ResearchSkillId,
} from "@usemoney/services/preferences";
import {
  getGeminiModel,
  getGeminiModelById,
  generateWithTimeout,
  estimateTokenCount,
  isGeminiEnabled,
} from "@usemoney/core";
import {
  resolveChatModel,
  resolveResearchModel,
  getEffectiveCreditCost,
  getModelDefinition,
} from "@usemoney/core/gemini/model-registry";
import { logAiDecision } from "@usemoney/core/analytics";
import { captureChatSignal } from "@usemoney/core/investor/capture";
import { pickExplanationVariant } from "@usemoney/core/investor/bandit-select";
import { variantStyleDirective } from "@usemoney/core/investor/bandit";
import { assembleUserContext } from "@usemoney/core/investor/context";
import { assembleAnchorContext } from "@/lib/gemini/anchor-context";
import { parsePageAnchor } from "@usemoney/core/gemini";
import { sanitizeMemoryContext } from "@/lib/gemini/conversation";
import { isClaudeEntitled } from "@usemoney/core/gemini";
import {
  classifyTopic,
  shouldRefuse,
  buildRefusalMessage,
} from "@usemoney/core/gemini";
import PostHogClient from "@/lib/posthog";
import { getComposerPreferences } from "@usemoney/services/preferences";
import { withSoftTimeout } from "@usemoney/utils/with-soft-timeout";
import type {
  ChatResponse,
  QueryMode,
  ChatDashboardRequest,
  ContentBlock,
} from "@usemoney/types";
import { detectActions, removeActionMarkers } from "@/lib/gemini/actions";
import { flashGuardOutput } from "@/lib/gemini/guardrails";
import {
  buildCreditPaywallBlocks,
  creditPaywallTitle,
  shouldRunToolNarrative,
  buildToolNarrativeFallbackBlocks,
  TOOL_NARRATIVE_FALLBACK_TEXT,
} from "./route-logic";
import {
  trackTokenUsage,
  exceedsCostThreshold,
} from "@/lib/gemini/cost-tracker";
import {
  buildConversationContext,
  buildFullPrompt,
} from "@/lib/gemini/conversation";
import {
  retrievePageContext,
  retrieveStockContext,
  shouldUseRAG,
} from "@/lib/gemini/rag";
import { getDashboardPrompt } from "@/lib/gemini/tool-prompts";
import {
  selectPersona,
  getBareStockOptions,
} from "@/lib/gemini/persona-selector";
import type { PersonaId } from "@/lib/gemini/prompt-personas";
import { geminiLogger as logger } from "@usemoney/logger";
import { getOrCreateDbUser } from "@/lib/db/user";
import { validateInput } from "@/lib/chat-tools/input-validator";
import type { IntentMatch } from "@/lib/chat-tools/intent-mapper";
import type { TurnMeta } from "@usemoney/types";
import {
  loadPriorTurnContext,
  saveTurnContext,
  detectFollowUpFast,
  mergeScreenerParams,
  deriveScreenerTurnState,
  extractScreenerRows,
  type ConversationState,
} from "@/lib/chat-tools/turn-context";
import {
  validateOutput,
  factCheckNumbers,
} from "@/lib/chat-tools/output-validator";
import { executeTool } from "@/lib/chat-tools/executor";
import {
  buildTypedBlockFromTool,
  buildSecondaryBlocksFromTool,
} from "@/lib/chat-tools/typed-blocks";
import {
  shouldSkipNarration,
  deterministicToolSummary,
} from "@/lib/chat/tool-narration";
import { buildListToolBlocks } from "@/lib/chat/tool-result-blocks";
import { buildConfirmFields } from "@/lib/chat/confirm-config";
import { parseMessageToBlocks } from "@/lib/chat/message-parser";
import { mapStyleToMode } from "@/lib/chat/research-style";
import { generateContentStreamText } from "@/lib/gemini/models";
import {
  CHAT_STREAM_CONTENT_TYPE,
  encodeSSE,
  stripBlockMarkers,
  type ChatStreamEvent,
} from "@/lib/chat/chat-stream";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";
import prisma from "@usemoney/database";
import { yahooFetchSearch } from "@usemoney/core/market-data";
import {
  resolveInstrument,
  INDIA_CASH_VENUES,
} from "@usemoney/core/market-data/instruments/resolve-instrument";

/**
 * Resolve a raw symbol/company name to ticker + full name.
 * DB-first (`instrument_mappings`), Yahoo Finance fallback.
 *
 * ## MONEY-980 — why step 1 is no longer a bare `findFirst`
 *
 * It used to be `findFirst({ where: { symbol, isActive: true } })` with NO venue
 * clause and no ordering. That was harmless while `instrument_mappings` held
 * only Indian rows and `@@unique([symbol, exchange])` made an NSE/BSE pair the
 * only possible multiplicity — but "harmless" was luck: the query asked for ANY
 * row and got whichever Mongo's natural order handed back, so an NSE-listed and
 * a BSE-listed row for the same company were a coin flip.
 *
 * `resolveInstrument` replaces it with a RANKED read — live before retired, NSE
 * before BSE, and a deterministic tiebreak under both — stated once in
 * `@usemoney/core` instead of implied by a literal here.
 *
 * ## …and why it says `market: "IN"`
 *
 * The flag is not decoration and removing it is not a widening. This ladder's
 * first rung RETURNS EARLY, and `resolveInstrument`'s default consults
 * `us_instruments` too — ~72,685 listings — so an unscoped step 1 answers any
 * bare token that is an active US ticker BEFORE steps 2 and 3, which are the
 * rungs that exist to turn "INFOSYS" into INFY and "TATA CONSULTANCY" into TCS.
 * `decideResolution` prefers India in a TIE; it cannot prefer India when India
 * has not been asked the right question yet, and for a token pulled out of a
 * chat message that is the normal case rather than the exception.
 *
 * There is no US arm here at all, deliberately, and the product loses nothing
 * by it: everything this function feeds — `run_research` (NSE/BSE filings,
 * screener.in, NSE XBRL) and `get_stock_news` (NSE announcements) — is
 * India-only, and step 4's Yahoo search already answers a genuine US ticker
 * exactly as it did before MONEY-980. A US DB arm belongs here the day a US
 * research/news path exists to receive one, behind `us-stock-research` — the
 * same PostHog flag family that gates `/api/market/search`'s US leg. Adding it
 * now would ship dark and then ARM ITSELF the night the Tiingo backfill lands,
 * with no flag anywhere to stop it.
 */
async function resolveStockSymbol(rawInput: string): Promise<{
  symbol: string;
  name: string;
  yahooSymbol: string;
} | null> {
  const baseSym = rawInput
    .replace(/\.(NS|BO)$/i, "")
    .toUpperCase()
    .trim();
  if (!baseSym) return null;

  // 1. DB: exact symbol match. INDIA ONLY — see the header; this rung returns
  //    early, so widening it silently preempts steps 2 and 3.
  const resolved = await resolveInstrument({ symbol: baseSym, market: "IN" });
  if (resolved.status === "RESOLVED") {
    const { instrument } = resolved;
    return {
      symbol: instrument.symbol,
      // `InstrumentMapping.name` is non-null, but the resolver's shape is
      // market-agnostic and types it nullable; the symbol is the only honest
      // label if it is ever blank.
      name: instrument.name ?? instrument.symbol,
      yahooSymbol: instrument.yahooSymbol,
    };
  }

  // 2. DB: name startsWith (most specific)
  const byNameStart = await prisma.instrumentMapping.findFirst({
    where: {
      name: { startsWith: baseSym, mode: "insensitive" },
      isActive: true,
      // The CASH venues, shared with the resolver. `name` on an NFO/BFO/MCX row
      // is a contract, not a company.
      exchange: { in: [...INDIA_CASH_VENUES] },
    },
    select: { symbol: true, name: true, yahooSymbol: true },
    orderBy: { name: "asc" },
  });
  if (byNameStart) return byNameStart;

  // 3. DB: name contains (broader)
  const byNameContains = await prisma.instrumentMapping.findFirst({
    where: {
      name: { contains: baseSym, mode: "insensitive" },
      isActive: true,
      exchange: { in: [...INDIA_CASH_VENUES] },
    },
    select: { symbol: true, name: true, yahooSymbol: true },
    orderBy: { name: "asc" },
  });
  if (byNameContains) return byNameContains;

  // 4. Yahoo Finance fallback (new IPOs, unlisted in DB)
  try {
    const results = await yahooFetchSearch(baseSym, { quotesCount: 5 });
    // Prefer NSE (.NS) > BSE (.BO) > any
    const nsMatch = results.find((r) => r.symbol?.endsWith(".NS"));
    const bsMatch = results.find((r) => r.symbol?.endsWith(".BO"));
    const best = nsMatch || bsMatch || results[0];
    if (best?.symbol) {
      return {
        symbol: best.symbol.replace(/\.(NS|BO)$/, ""),
        name: best.longname || best.shortname || best.symbol,
        yahooSymbol: best.symbol,
      };
    }
  } catch {
    // Yahoo search failed, return null
  }

  return null;
}

import {
  classifyTier,
  determineCreditAction,
  assertL1Sticky,
  L1_FREE_CREDIT_ACTIONS,
  type AnalysisTier,
  type CreditAction,
} from "@/lib/chat-tools/tier-classifier";
import {
  logClassification,
  detectMisclassificationSignal,
} from "@/lib/chat-tools/classification-logger";
import { handleFlashQuery } from "@/lib/chat-tools/flash-responder";
import { METADATA_FIELDS } from "@/lib/chat-tools/metadata-fields";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

/** Daily cost threshold per user (in USD). Gemini Flash is ~$0.003/query, so $2 ≈ ~650 queries/day */
const DAILY_COST_THRESHOLD_USD = 2.0;

/**
 * Mock response for when Gemini is disabled or unavailable
 */
const MOCK_RESPONSES = [
  "This is a mock response. Gemini integration is currently disabled. Set USE_GEMINI=true in your environment to enable real AI responses.",
  "I'm currently running in mock mode. To enable real Gemini responses, configure your Google Cloud credentials.",
];

/**
 * POST /api/chat
 *
 * Process a chat message with Gemini LLM
 */
/**
 * Entry point. The body lives in `handleChatPost`; this wrapper tags every model call
 * underneath it with `ml_app: chat` (MONEY-1380). Auto-instrumented LLM
 * spans inherit it from this workflow parent, so calls made deep inside
 * packages this file never imports are attributed correctly.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return llmWorkflow("chat", "chat-turn", () => handleChatPost(request));
}

async function handleChatPost(request: NextRequest) {
  const requestId = randomUUID();
  const startTime = Date.now();
  let queryConsumed = false;
  let currentQueryType: QueryMode = "fast";
  let creditAction: CreditAction = "l1_flash"; // determined by tier classifier
  // MONEY-619: the action + amount actually charged (may differ from
  // creditAction when "thinking" mode upgrades a free turn to
  // l2_chat_thinking). Refund paths reverse exactly what was charged.
  let chargedAction: CreditAction = "l1_flash";
  let chargedAmount: number | undefined;
  let resolvedPersonaId: PersonaId | undefined;

  try {
    // 1. Authentication
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    // 1.5. Rate limiting
    const rateLimitResult = await apiRateLimiter.check(60, userId);
    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(rateLimitResult.reset / 1000)),
          },
        }
      );
    }

    // 2. Parse request body
    const body: ChatDashboardRequest = await request.json();
    const {
      message,
      queryType = "fast",
      pagePath,
      context,
      toolExecution,
      userContext,
      chatId,
      conversationHistory,
    } = body;

    currentQueryType = queryType as QueryMode;

    // Validate required fields
    if (!message || !pagePath) {
      return NextResponse.json(
        { error: "Message and pagePath are required" },
        { status: 400 }
      );
    }

    // Get database user for conversation context
    const dbUser = await getOrCreateDbUser(userId);

    // MONEY-229 Phase E - resolve the user's preferred Gemini model
    // once for this request. Falls back to a plan-default if the saved
    // ID is gated for the current plan or unrecognised. The resolved
    // ID flows through both Gemini call sites (narrative fallback +
    // main response) so a Pro-tier user gets their tier's model
    // consistently. (Computed after the dbUser null-guard below so we
    // can safely read dbUser.id.)
    let effectiveModelId: string | null = null;
    // MONEY-619 (Phase 2): the user's REAL base plan + whether they
    // opted into "thinking" mode for this turn. Both drive the credit
    // charge below (a thinking turn is billed `l2_chat_thinking`).
    let planId = "FREE";
    let thinkingEnabled = false;
    // MONEY-650 (B2): the research "deep lane" model (resolveResearchModel) —
    // distinct from effectiveModelId (the chat "fast lane"). The research
    // confirmation card + the worker run must use THIS model, not the chat
    // one, or the credit premium + model label shown to the user are wrong.
    let researchModelId: string | undefined;

    if (!dbUser) {
      return NextResponse.json(
        { error: "Failed to resolve user" },
        { status: 500 }
      );
    }

    // MONEY-221 - Saved research preferences (Auto / Quick / Deep / Custom +
    // optional customSkills + free-text focus). Loaded once per request and
    // applied at every research-related branch below: bare-stock-options
    // skips the chip prompt when the user has a non-Auto default, and the
    // run_research intent inherits the resolved mode + skills + focus.
    let userPrefs: ResearchPreferences | null = null;
    try {
      userPrefs = await getResearchPreferences(dbUser.id);
    } catch (prefsErr) {
      // Soft-fail: a Mongo blip on a single field shouldn't block chat.
      logger.warn(
        { requestId, error: String(prefsErr) },
        "[MONEY-221] research preferences load failed - falling back to Auto"
      );
    }

    // MONEY-619 (Phase 2) - chat now honors the user's REAL plan tier
    // (was hardcoded "PRO") + opt-in "thinking" mode. resolveChatModel
    // returns the tier's Flash model by default (FREE 2.5-flash / PRO
    // 3-flash / PREMIUM 3.5-flash), downgrades a Pro pick to Flash for
    // latency, and returns the tier's Pro model when thinking is on. The
    // resolved ID flows through both Gemini call sites below.
    try {
      const composerPrefs = await getComposerPreferences(dbUser.id);
      const subscription = await prisma.subscription.findUnique({
        where: { userId: dbUser.id },
        select: { planId: true },
      });
      planId = subscription?.planId ?? "FREE";
      thinkingEnabled = composerPrefs.thinking === true;
      // MONEY-626 / MONEY-1274 (#27): claudeAllowed = key configured AND
      // (the user is on the allowlist OR their PLAN reaches a Claude model's
      // requiresPlan). Only then is a Claude pick honored, in chat AND
      // research; everyone else stays Gemini-default, so a forged pick from an
      // unentitled user is still ignored here.
      //
      // This is the LOAD-BEARING gate — `getPickerModelsForUser` only decides
      // what the UI shows. It reads the same `isClaudeEntitled` the picker
      // does, so the two cannot drift and show a model the server will refuse.
      const claudeAllowed = isClaudeEntitled(dbUser.email, planId);
      effectiveModelId = resolveChatModel(planId, {
        userPick: composerPrefs.model,
        thinking: thinkingEnabled,
        claudeAllowed,
      });
      researchModelId = resolveResearchModel(
        planId,
        composerPrefs.model,
        claudeAllowed
      );
    } catch (composerErr) {
      logger.warn(
        { requestId, error: String(composerErr) },
        "[MONEY-619] composer prefs / plan load failed - falling back to QueryMode default"
      );
    }
    const resolvedResearchMode = mapStyleToMode(userPrefs?.researchStyle);
    // MONEY-219 v2 - preset takes precedence over the legacy
    // customSkills array. resolveEffectiveSkills handles preset →
    // skills + extras − removed; if the user is on legacy custom
    // style, we fall back to their stored customSkills array.
    let resolvedCustomSkills: readonly ResearchSkillId[] | undefined;
    let resolvedPreset: ResearchPresetId | undefined;
    if (userPrefs?.preset) {
      resolvedPreset = userPrefs.preset;
      const eff = resolveEffectiveSkills({
        preset: userPrefs.preset,
        extraSkills: userPrefs.extraSkills,
        removedSkills: userPrefs.removedSkills,
      });
      resolvedCustomSkills = eff.length > 0 ? eff : undefined;
    } else if (userPrefs?.customSkills && userPrefs.customSkills.length > 0) {
      // MONEY-650 (B5): honor saved customSkills for ANY non-preset style, not
      // just "custom". Picking "Advanced" (or "Comprehensive") in the popover
      // saves that tier's 16-skill bundle (PromptOptionsPopover.handleStyleChange),
      // but this branch previously gated on researchStyle === "custom", so an
      // Advanced run dropped its skills → the worker planner fell back to a
      // conservative ~17-task plan and "Advanced" behaved like a basic run.
      // Forwarding the skills lets the planner scale up
      // (minTasks = min(28, 8 + skills*2)).
      resolvedCustomSkills = userPrefs.customSkills;
    }
    const resolvedResearchFocus = userPrefs?.researchFocus?.trim() || undefined;

    // MONEY-801 (C1c) - institutional run-parameters. A chat-triggered research
    // run must honour the user's saved horizon / benchmark / reportLength /
    // VaR config / DCF assumptions, exactly as a run kicked off from the
    // research surface does. All optional; unset → the worker's per-skill
    // defaults (identical plan/report to today). Forwarded into enrichedParams
    // on the run_research confirmation path below.
    const resolvedHorizon = userPrefs?.horizon;
    const resolvedBenchmark = userPrefs?.benchmark;
    const resolvedReportLength = userPrefs?.reportLength;
    const resolvedVarConfig = userPrefs?.varConfig;
    const resolvedAssumptions = userPrefs?.assumptions;

    logger.info(
      {
        requestId,
        userId,
        queryType,
        pagePath,
        context,
        messageLength: message.length,
        hasChatId: !!chatId,
        hasInlineHistory: !!conversationHistory?.length,
        hasToolExecution: !!toolExecution,
      },
      "Chat request received"
    );

    // 2.5a. Load prior turn context (Redis first, fallback to conversationHistory turnMeta)
    let priorTurnContext: ConversationState | null = null;
    try {
      priorTurnContext = await loadPriorTurnContext(
        dbUser.id,
        chatId,
        pagePath,
        conversationHistory as Array<{
          role: string;
          content: string;
          turnMeta?: TurnMeta;
        }>
      );
      if (priorTurnContext) {
        logger.info(
          {
            requestId,
            turnCount: priorTurnContext.turnCount,
            lastTool: priorTurnContext.lastTurnMeta?.tool,
            activeSymbols: priorTurnContext.activeSymbols.slice(0, 5),
          },
          "Prior turn context loaded"
        );
      }
    } catch (error) {
      logger.warn(
        { requestId, error },
        "Failed to load prior turn context, continuing without"
      );
    }

    // 2.5. Per-user daily cost limit enforcement
    try {
      const overLimit = await exceedsCostThreshold(
        dbUser.id,
        DAILY_COST_THRESHOLD_USD,
        1
      );
      if (overLimit) {
        logger.warn(
          { requestId, userId, threshold: DAILY_COST_THRESHOLD_USD },
          "User exceeded daily cost threshold"
        );
        return NextResponse.json(
          {
            error:
              "You've reached your daily AI usage limit. Please try again tomorrow, or switch to Fast mode for lower-cost queries.",
          },
          { status: 429 }
        );
      }
    } catch {
      // Don't block on cost check failure - log and continue
      logger.warn(
        { requestId, userId },
        "Cost threshold check failed, continuing"
      );
    }

    // 3. Layer 1: Input Validation & Sanitization
    // Skip topic validation for conversation continuations - user is already
    // in a finance chat, so follow-up/meta questions should be allowed.
    const hasConversationContext =
      !!chatId || (conversationHistory && conversationHistory.length > 0);

    const inputValidation = await validateInput(message, context);

    if (!inputValidation.valid && !hasConversationContext) {
      logger.info(
        { requestId, userId, message, reason: inputValidation.reason },
        "Query blocked by guardrails"
      );

      // Still consume query (user is charged for blocked topics)
      await consumeAIQuery(queryType as QueryMode);

      const response: ChatResponse = {
        response: inputValidation.reason || "This query cannot be processed.",
        blocked: true,
        queryType: queryType as QueryMode,
      };

      return NextResponse.json(response);
    }

    const sanitizedMessage = inputValidation.sanitizedMessage || message;

    // MONEY-786: record a durable AI decision audit row for each model-backed
    // chat reply. Best-effort (never throws). Reads the mutating request-scoped
    // state (effectiveModelId/tier/creditAction/classificationSource) at call
    // time, so it always reflects the resolution that actually ran. Only invoke
    // it AFTER tier/resolvedIntent/classificationSource are initialized (their
    // `let` bindings sit below this closure — calling earlier, e.g. from the
    // topic-refusal gate, would hit the temporal dead zone). The refusal path
    // returns before any model call, so these only fire for COMPLETED turns.
    const logChatDecision = (args: {
      output: { length: number; hadTools: boolean };
      rationale: string;
      latencyMs: number;
      inputTokens: number;
      outputTokens: number;
      outcome?: string;
    }): void => {
      const modelId = effectiveModelId ?? `default:${currentQueryType}`;
      void logAiDecision({
        decisionType: "CHAT_REPLY",
        userId: dbUser.id,
        model: modelId,
        provider:
          effectiveModelId &&
          getModelDefinition(effectiveModelId)?.provider === "anthropic"
            ? "ANTHROPIC"
            : "GOOGLE",
        input: {
          intent: resolvedIntent?.tool ?? "general_chat",
          tier,
          message: sanitizedMessage.slice(0, 500),
        },
        output: args.output,
        rationale: args.rationale,
        outcome: args.outcome ?? "COMPLETED",
        usage: {
          inputTokens: args.inputTokens,
          outputTokens: args.outputTokens,
          latencyMs: args.latencyMs,
        },
        metadata: {
          tier,
          creditAction,
          classificationSource,
          pagePath,
        },
      }).catch(() => {});

      // MONEY-788 (B3): behaviour-signal capture — nudge the concepts the
      // resolved chat intent exercises + append a `chat_intent` UserEvent.
      // Best-effort, never throws. Reads `resolvedIntent` (a `let` below this
      // closure) at call time, so it's only safe because every caller fires
      // after the intent is resolved — see the TDZ note above.
      //
      // MONEY-805 (C1): carry the resolved/extracted symbols so chat_intent
      // events are symbol-attributed (the same `params.symbols` slot the route
      // stamps onto turnMeta). captureChatSignal bounds + sanitizes them.
      const signalSymbols = resolvedIntent?.params?.symbols;
      void captureChatSignal({
        userId: dbUser.id,
        tool: resolvedIntent?.tool,
        symbols: Array.isArray(signalSymbols)
          ? (signalSymbols as unknown[]).filter(
              (s): s is string => typeof s === "string"
            )
          : [],
      }).catch(() => {});
    };

    // 3.4. Topic classifier (MONEY-295) - refuse off-topic queries before
    // they reach the (expensive) Pro classifier + tool execution path.
    // Uses gemini-2.5-flash-lite (~500ms p95, free tier model). Bypassed
    // for slash commands and @-mentions which are structurally on-topic.
    // Fail-open: any classifier error allows the query through.
    if (!toolExecution) {
      const classifierStartedAt = Date.now();
      try {
        const classification = await classifyTopic(sanitizedMessage, {
          pagePath,
        });
        const classifierDurationMs = Date.now() - classifierStartedAt;

        // Telemetry - fire-and-forget. PostHogClient flushes immediately.
        try {
          const ph = PostHogClient();
          ph.capture({
            distinctId: userId ?? "anonymous",
            event: "topic_classifier_invoked",
            properties: {
              requestId,
              category: classification.category,
              confidence: classification.confidence,
              durationMs: classifierDurationMs,
              queryLength: sanitizedMessage.length,
              pagePath,
              willRefuse: shouldRefuse(classification),
            },
          });
          void ph.shutdown();
        } catch {
          // Telemetry must never break the request.
        }

        if (shouldRefuse(classification)) {
          logger.info(
            {
              requestId,
              userId,
              category: classification.category,
              confidence: classification.confidence,
            },
            "Chat query refused by topic classifier"
          );

          // Refusal-specific event - easier to filter in PostHog than
          // re-deriving from the invoked event.
          try {
            const ph = PostHogClient();
            ph.capture({
              distinctId: userId ?? "anonymous",
              event: "topic_classifier_refused",
              properties: {
                requestId,
                category: classification.category,
                confidence: classification.confidence,
                reason: classification.reason,
                queryLength: sanitizedMessage.length,
                pagePath,
              },
            });
            void ph.shutdown();
          } catch {
            // ignore
          }

          const refusalText = buildRefusalMessage(classification);
          const suggestedTopics = classification.suggestedTopics ?? [];
          return NextResponse.json({
            response: refusalText,
            blocks: [
              {
                type: "refusal",
                message: refusalText,
                suggestions: suggestedTopics,
                category: classification.category,
              },
            ],
            blocked: true,
            classifierCategory: classification.category,
            suggestedTopics,
            queryType: queryType as QueryMode,
          });
        }
      } catch (err) {
        logger.warn(
          {
            requestId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Topic classifier failed - falling open"
        );
        // continue
      }
    }

    // 3.5. Flash-first classification - PRIMARY intent + tier + persona resolution
    //
    // For queries without a data-fetch regex match, Flash determines EVERYTHING:
    // intent, tier (L1/L2/L3), persona, and tool - in a single LLM call.
    //
    // If Flash says L1 → route to Flash responder (definitions, simple facts)
    // If Flash says L2/L3 → route to tool execution (research, screener, risk, tax)
    //
    // The regex classifyTier() is ONLY used as a fallback when Flash fails.
    // This fixes the problem where natural language queries like
    // "stocks with RSI < 30 in Nifty 50" were misclassified as L1 by regex.

    let tier: AnalysisTier | undefined;
    let flashPersonaHint: string | undefined;
    let classificationSource: "flash" | "regex" | "fast-path" = "fast-path";
    let safetyNetActivated = false;

    // 3.5a. Follow-up fast-path - resolve "yes"/"tell me more" without LLM
    if (priorTurnContext && !toolExecution && !inputValidation.fastIntent) {
      const followUp = detectFollowUpFast(sanitizedMessage, priorTurnContext);
      if (followUp) {
        logger.info(
          {
            requestId,
            followUpTool: followUp.tool,
            escalate: followUp.escalateTier,
          },
          "Follow-up fast-path matched"
        );

        // Escalate tier if "tell me more"
        let resolvedTier = followUp.tier;
        if (followUp.escalateTier && resolvedTier) {
          if (resolvedTier === "L1") resolvedTier = "L2";
          else if (resolvedTier === "L2") resolvedTier = "L3";
        }

        inputValidation.fastIntent = {
          tool: followUp.tool,
          params: followUp.params,
          confidence: 0.95,
          persona: followUp.persona,
          tier: resolvedTier,
        };

        classificationSource = "fast-path";
        tier = resolvedTier;
        flashPersonaHint = followUp.persona;
      }
    }

    if (!inputValidation.fastIntent && !toolExecution) {
      try {
        const { classifyIntentWithFlash } =
          await import("@/lib/chat-tools/intent-mapper");
        const contextSummary = conversationHistory
          ?.slice(-6)
          .map(
            (m: { role: string; content: string }) =>
              `${m.role}: ${m.content.slice(0, 200)}`
          )
          .join("\n");
        const flashResult = await classifyIntentWithFlash(
          sanitizedMessage,
          contextSummary,
          priorTurnContext
        );

        if (flashResult && "clarification" in flashResult) {
          return NextResponse.json({
            response: flashResult.clarification,
            queryType: queryType as QueryMode,
          });
        }

        if (flashResult && "tool" in flashResult) {
          const flashTier = (flashResult as IntentMatch).tier;

          if (flashTier === "L1") {
            // L1: Flash responder handles definitions/concepts - no tool execution
            tier = "L1";
            flashPersonaHint = (flashResult as IntentMatch).persona;
          } else {
            // L2/L3: Route to tool execution
            if ((flashResult as IntentMatch).tool) {
              inputValidation.fastIntent = flashResult as IntentMatch;
            }
            if (flashTier) {
              tier = flashTier;
            }
            flashPersonaHint = (flashResult as IntentMatch).persona;
          }

          classificationSource = "flash";

          logger.info(
            {
              requestId,
              tool: (flashResult as IntentMatch).tool,
              confidence: (flashResult as IntentMatch).confidence,
              flashTier,
              persona: (flashResult as IntentMatch).persona,
            },
            "Flash classification resolved (intent + tier + persona)"
          );
        }
      } catch (flashError) {
        logger.warn(
          { requestId, flashError },
          "Flash classification failed, falling through to regex fallback"
        );
      }
    }

    // FALLBACK: If Flash didn't resolve tier (failed or returned null),
    // use regex-based classifyTier() + screener safety net
    if (tier === undefined) {
      classificationSource = "regex";
      tier = classifyTier(
        sanitizedMessage,
        pagePath,
        context as string | undefined
      );

      // Screener safety net: if regex says L1 but query looks like a screener request,
      // override to L2 and route to stock-screener tool.
      // Catches natural language queries that regex patterns miss.
      const SCREENER_FALLBACK =
        /\b(undervalued|overvalued|oversold|overbought|momentum|golden\s*cross|death\s*cross|breakout|breakdown|high\s*dividend|low\s*pe|high\s*roe|small\s*cap\s*gem|penny|multibagger|bollinger|macd|sma|ema|volume\s*breakout|52\s*week|stochastic|williams|atr|cash\s*rich|turnaround|garp|peg\s*ratio|high\s*roce|near\s*support)\b.*\b(stock|share|compan|nifty|large\s*cap|mid\s*cap|small\s*cap)/i;
      const SCREENER_FALLBACK_2 =
        /\b(stocks?|shares?|nifty|large\s*cap|mid\s*cap|small\s*cap)\b.*\b(undervalued|oversold|overbought|momentum|golden\s*cross|high\s*dividend|low\s*pe|high\s*roe|breakout|bollinger|macd|high\s*roce|turnaround|cash\s*rich)/i;

      if (
        tier === "L1" &&
        !inputValidation.fastIntent &&
        (SCREENER_FALLBACK.test(sanitizedMessage) ||
          SCREENER_FALLBACK_2.test(sanitizedMessage))
      ) {
        tier = "L2";
        inputValidation.fastIntent = {
          tool: "run_screener",
          params: {
            query: sanitizedMessage,
          },
          confidence: 0.6,
          persona: "quant_analyst",
          tier: "L2",
        };

        safetyNetActivated = true;

        logger.info(
          { requestId, message: sanitizedMessage },
          "Screener safety net activated - regex L1 overridden to L2 screener"
        );
      }
    }

    // Safety: tier is always resolved by this point (Flash or regex fallback)
    if (!tier) tier = "L1";

    // Fire-and-forget classification logging for the self-learning loop
    const resolvedIntent = inputValidation.fastIntent;
    logClassification({
      message: sanitizedMessage.slice(0, 500),
      intent: resolvedIntent ? undefined : "general_chat",
      tier,
      persona: resolvedIntent?.persona || flashPersonaHint,
      tool: resolvedIntent?.tool,
      confidence: resolvedIntent?.confidence,
      source: safetyNetActivated ? "screener-safety-net" : classificationSource,
      flashFailed: classificationSource === "regex",
      safetyNetActivated,
      userId: dbUser.id,
      chatId,
      pagePath,
      requestId,
    }).catch(() => {});

    // Async signal detection (rephrase / escalation)
    detectMisclassificationSignal(
      dbUser.id,
      sanitizedMessage,
      tier,
      resolvedIntent?.tool
    ).catch(() => {});

    // Determine unified credit action from tier + intent
    creditAction = determineCreditAction(tier, sanitizedMessage, {
      hasExistingChat:
        !!chatId ||
        (conversationHistory && conversationHistory.length > 0) ||
        false,
      isToolExecution: !!toolExecution,
    });

    // MONEY-224 - Free-chat lock. A turn classified as L1 with no tool
    // execution and no fast-path intent is a casual chat → must stay free.
    // The guard catches any future regression that would silently route an
    // L1 turn into a charged credit bucket.
    creditAction = assertL1Sticky({
      proposed: creditAction,
      wasOriginallyL1:
        tier === "L1" && !toolExecution && !inputValidation.fastIntent,
      requestId,
    });

    // L1 Flash responder - only for queries Flash classified as L1 (definitions, concepts)
    // AND that don't have a tool intent (e.g., "what is RSI" = L1 no tool needed).
    // MONEY-619: when the user opts into "thinking" mode we bypass the free
    // Flash fast-lane so the turn flows through the main path, which runs the
    // tier's Pro model (effectiveModelId) and charges l2_chat_thinking.
    if (
      tier === "L1" &&
      !toolExecution &&
      !inputValidation.fastIntent &&
      !thinkingEnabled
    ) {
      try {
        const flashResponse = await handleFlashQuery(
          sanitizedMessage,
          dbUser.id,
          pagePath,
          requestId,
          planId
        );
        logger.info(
          {
            requestId,
            userId,
            tier: "L1",
            duration: Date.now() - startTime,
          },
          "L1 Flash query completed"
        );
        // Save turn context fire-and-forget
        if (flashResponse.turnMeta) {
          saveTurnContext(
            dbUser.id,
            chatId,
            pagePath,
            flashResponse.turnMeta,
            priorTurnContext
          ).catch(() => {});
        }
        return NextResponse.json(flashResponse);
      } catch (error) {
        logger.warn(
          { requestId, error, userId },
          "L1 Flash failed, falling through to standard path"
        );
      }
    }

    // 3.8. Persona Resolution - select expert persona based on message + Flash result
    {
      const flashPersona =
        inputValidation.fastIntent?.persona || flashPersonaHint;
      const personaResult = selectPersona(sanitizedMessage, flashPersona);
      resolvedPersonaId = personaResult.personaId;

      logger.info(
        {
          requestId,
          personaId: resolvedPersonaId,
          personaSource: personaResult.source,
          personaConfidence: personaResult.confidence,
        },
        "Persona resolved"
      );
    }

    // 4. Fast-path tool execution (no LLM needed)
    if (inputValidation.fastIntent && !toolExecution) {
      const intent = inputValidation.fastIntent;

      // 4.0 Bare stock analysis - show persona-specific options instead of jumping to research
      // Detects patterns like "Analyse TCS", "Research RELIANCE" (short query with stock + verb)
      //
      // MONEY-240 follow-up (QA bundle B1): the classifier pre-sets
      // `params.mode = "fast"` for short prompts like "analyse TCS".
      // Previously we gated bare-stock enrichment on
      // `!intent.params.mode`, so the classifier's pick always won
      // over the user's saved Deep style + customSkills. Drop the
      // gate - bare-stock enrichment must re-apply the user's saved
      // style on top of the classifier default. Combined with the
      // precedence flip in `enrichedParams` near line 1444, this
      // restores "user prefs win".
      if (
        intent.tool === "run_research" &&
        intent.params.symbols &&
        Array.isArray(intent.params.symbols) &&
        intent.params.symbols.length === 1 &&
        !intent.params.skill
      ) {
        const rawSymbol = intent.params.symbols[0] as string;
        const resolved = await resolveStockSymbol(rawSymbol);

        const displaySymbol = resolved
          ? `${resolved.symbol} (${resolved.name})`
          : rawSymbol;
        const resolvedYahoo = resolved?.yahooSymbol || rawSymbol;

        intent.params.symbols = [resolvedYahoo];

        // MONEY-221 - when the user has saved a non-Auto research style,
        // skip the "pick Plan A / B / C" chip prompt and let the standard
        // confirmation flow below take over with the resolved mode +
        // skills + focus already injected. The chip prompt is only useful
        // for first-time users; power users with a saved default see it
        // as friction.
        if (resolvedResearchMode) {
          intent.params.mode = resolvedResearchMode;
          if (resolvedCustomSkills) {
            (intent.params as Record<string, unknown>).customSkills =
              resolvedCustomSkills;
          }
          if (resolvedResearchFocus) {
            (intent.params as Record<string, unknown>).researchFocus =
              resolvedResearchFocus;
          }
          // Fall through - the existing tool-execution path picks up the
          // enriched intent and either confirms (paid) or runs straight away.
        } else {
          const response = getBareStockOptions(displaySymbol);

          // Mark this turn so the chip reply (e.g. "Deep Valuation") can route
          // to advanced research mode instead of falling through Flash → fast.
          const bareStockTurnMeta: TurnMeta = {
            intent: "bare_stock_options",
            tool: "run_research",
            persona: "equity_research",
            symbols: [resolvedYahoo],
            confidence: 0.9,
          };
          saveTurnContext(
            dbUser.id,
            chatId,
            pagePath,
            bareStockTurnMeta,
            priorTurnContext
          );

          return NextResponse.json({
            response,
            queryType: queryType as QueryMode,
            stockContext: resolvedYahoo,
            personaId: "equity_research",
            turnMeta: bareStockTurnMeta,
          });
        }
      }

      // 4.1 Merge screener filters with prior state (for "tighten filter" follow-ups)
      if (
        intent.tool === "run_screener" &&
        priorTurnContext?.activeScreenerState
      ) {
        intent.params = mergeScreenerParams(
          priorTurnContext.activeScreenerState,
          intent.params
        );
      }

      // ── Universal stock symbol resolution + confirmation ──
      // For ANY tool that takes a stock symbol, resolve company name → ticker
      // (DB-first, Yahoo fallback) and show confirmation with ticker + full name.
      // Covers: get_stock_news and any future stock-symbol tools.
      const STOCK_SYMBOL_TOOLS = new Set(["get_stock_news"]);
      if (
        STOCK_SYMBOL_TOOLS.has(intent.tool) &&
        intent.params.symbol &&
        typeof intent.params.symbol === "string"
      ) {
        const resolved = await resolveStockSymbol(
          intent.params.symbol as string
        );

        if (resolved) {
          intent.params.symbol =
            resolved.yahooSymbol || `${resolved.symbol}.NS`;
          const actionId = `confirm-${randomUUID()}`;
          const displayLabel = `${resolved.symbol} (${resolved.name})`;
          const toolLabel =
            intent.tool === "get_stock_news"
              ? "Fetch news for"
              : "Fetch financial data for";
          const confirmMsg = `${toolLabel} ${displayLabel}?`;
          return NextResponse.json({
            response: confirmMsg,
            blocks: [
              {
                type: "action",
                actionId,
                tool: intent.tool,
                description: confirmMsg,
                params: intent.params,
                status: "pending",
              },
            ] as ContentBlock[],
            queryType: queryType as QueryMode,
          });
        }
      }

      // Execute tool directly (read-only tools don't need confirmation)
      const toolResult = await executeTool(
        intent.tool,
        intent.params,
        dbUser.id
      );

      if (toolResult.executed && toolResult.result?.success) {
        // Don't consume AI query for fast tool execution
        // Generate a brief LLM narrative if Gemini is enabled
        let narrative = "";
        let blocks: ContentBlock[] = [];
        // List/data tools: the rendered blocks ARE the answer, so we skip the
        // narration LLM and render deterministically (MONEY-587).
        const skipNarration = shouldSkipNarration(intent.tool);

        if (shouldRunToolNarrative(isGeminiEnabled())) {
          // L2 narrative is just Flash summarizing already-fetched tool
          // data - no new business intelligence, so cost is effectively
          // l1_flash (0 credits). Don't gate on legacy consumeAIQuery
          // (hard-blocks FREE plan at subscription.service.ts:639) or
          // unified credits - let it run for everyone, free or paid.
          {
            // Truncate data before stringifying to avoid broken JSON fragments
            // (e.g. `]}}`) leaking into Gemini's narrative
            const rawData = toolResult.result.data;
            let truncatedData = rawData;
            if (Array.isArray(rawData)) {
              truncatedData = rawData.slice(0, 10);
            } else if (
              rawData &&
              typeof rawData === "object" &&
              Array.isArray((rawData as Record<string, unknown>).data)
            ) {
              truncatedData = {
                ...(rawData as Record<string, unknown>),
                data: (
                  (rawData as Record<string, unknown>).data as unknown[]
                ).slice(0, 10),
              };
            }
            const toolDataSummary = JSON.stringify(truncatedData);
            const narrativePrompt = getDashboardPrompt(
              context,
              dbUser.name || undefined
            );
            const userPrompt = `The user asked: "${sanitizedMessage}"

The tool has already executed and returned these results:
${toolDataSummary}

Provide ONLY a brief 1-2 sentence plain-text summary of what was found. Rules:
- Speak in past tense - the data IS the result, not a preview
- Do NOT say "I'll use" or "this might take a moment" - the operation is ALREADY COMPLETE
- Do NOT output any JSON, code blocks, table markup, or :::block: markers - the data is displayed separately as a table
- Do NOT mention internal tool names, IDs, or field names like "distanceFrom52WeekLow"
- Use simple language: say "near their 52-week low" not "distance from 52 week low is 0.24"
- Just describe the count and highlight (e.g. "Found 40 Nifty 50 stocks near their 52-week low, led by HDFC Bank and Kotak Bank.")
- Keep it under 2 sentences`;

            const model = effectiveModelId
              ? getGeminiModelById(effectiveModelId)
              : getGeminiModel(queryType as QueryMode);
            try {
              // For deterministic list/data tools the fetched data IS the
              // answer - skip the second LLM call and summarise deterministically
              // instead. Saves a Flash round-trip + tokens + latency (MONEY-587).
              // MONEY-239 G - same soft-timer wrap as the main
              // chat-narrative path. PostHog signal lets us see how
              // often tool-result narratives flirt with the Vercel
              // 60 s timeout.
              const geminiResponse = skipNarration
                ? deterministicToolSummary(intent.tool, toolResult.result.data)
                : await withSoftTimeout(
                    () =>
                      generateWithTimeout(
                        model,
                        `${narrativePrompt}\n\n${userPrompt}`
                      ),
                    {
                      softMs: 25_000,
                      eventName: "tool_narrative_slow",
                      userId: dbUser.id,
                      metadata: {
                        tool: intent.tool,
                        queryType,
                        pagePath,
                      },
                    }
                  );
              narrative = removeActionMarkers(geminiResponse);
              // Strip any :::block: markers that Gemini might still produce
              narrative = narrative
                .replace(/:::block:\w+\s*\{[^}]*\}/g, "")
                .replace(/:::/g, "")
                .trim();
              // Only extract text blocks from Gemini's narrative
              blocks = parseMessageToBlocks(narrative);

              // Skip token telemetry when we short-circuited the LLM - there
              // was no real model call to attribute tokens to.
              if (!skipNarration) {
                const duration = Date.now() - startTime;
                const inTok = estimateTokenCount(userPrompt);
                const outTok = estimateTokenCount(geminiResponse);
                trackTokenUsage({
                  userId: dbUser.id,
                  queryType: queryType as QueryMode,
                  inputTokens: inTok,
                  outputTokens: outTok,
                  duration,
                  pagePath,
                }).catch((error) => {
                  logger.error({ error }, "Failed to track token usage");
                });
                logChatDecision({
                  output: { length: narrative.length, hadTools: true },
                  rationale: `Tool-narrated chat reply (${intent.tool})`,
                  latencyMs: duration,
                  inputTokens: inTok,
                  outputTokens: outTok,
                });
              }
            } catch {
              // Fallback to basic response
              narrative = "Here's what I found for your query.";
              blocks = [{ type: "text", content: narrative }];
            }

            // Skipped-narration list/data tools render through the shared
            // formatter (stock-list / typed block / generic table - unwraps
            // wrapper shapes like { scans: [...] }), so the deterministic
            // "details below" always has real blocks. The generic auto-format
            // below self-skips once a rich block is present.
            if (skipNarration) {
              blocks.push(
                ...buildListToolBlocks(
                  intent.tool,
                  toolResult.result.data,
                  sanitizedMessage
                )
              );
            } else {
              // Narrated tools (financial data / risk / tax / unknown) keep
              // their rich typed block ahead of the generic card flattener.
              const typedBlock = buildTypedBlockFromTool(
                intent.tool,
                toolResult.result.data
              );
              if (typedBlock) {
                blocks.push(typedBlock);
                blocks.push(
                  ...buildSecondaryBlocksFromTool(
                    intent.tool,
                    toolResult.result.data
                  )
                );
              }
            }

            // Auto-format tool result data as table/card blocks
            const data = toolResult.result.data;
            if (
              !blocks.some(
                (b) =>
                  b.type === "table" ||
                  b.type === "card" ||
                  b.type === "chart" ||
                  b.type === "stock-list" ||
                  b.type === "holdings" ||
                  b.type === "portfolio" ||
                  b.type === "news" ||
                  b.type === "risk" ||
                  // Any rich typed block already answers the query — don't also
                  // flatten the raw tool payload into a redundant table/card
                  // beneath it (MONEY-587 task #40 dedupe fix).
                  b.type === "tax" ||
                  b.type === "fire" ||
                  b.type === "sector" ||
                  b.type === "technical" ||
                  b.type === "pnl" ||
                  b.type === "dividend" ||
                  b.type === "mf" ||
                  b.type === "scorecard" ||
                  // A terminal error/info block (e.g. a zero-match screener)
                  // already answers — don't also flatten the empty payload
                  // into a redundant card.
                  b.type === "error"
              )
            ) {
              if (Array.isArray(data) && data.length > 0) {
                const sample = data[0] as Record<string, unknown>;
                const columns = Object.keys(sample)
                  .filter(
                    (k) =>
                      k !== "id" &&
                      k !== "userId" &&
                      k !== "createdAt" &&
                      k !== "updatedAt"
                  )
                  .filter(
                    (k) => typeof sample[k] !== "object" || sample[k] === null
                  )
                  .slice(0, 8)
                  .map((key) => ({
                    key,
                    label: key
                      .replace(/([A-Z])/g, " $1")
                      .replace(/^./, (s) => s.toUpperCase()),
                    align: (typeof sample[key] === "number"
                      ? "right"
                      : "left") as "left" | "right",
                    ...(typeof sample[key] === "number" &&
                    key.toLowerCase().includes("pnl")
                      ? { format: "pnl" }
                      : {}),
                    ...(typeof sample[key] === "number" &&
                    (key.toLowerCase().includes("price") ||
                      key.toLowerCase().includes("value") ||
                      key.toLowerCase().includes("invested") ||
                      key.toLowerCase().includes("amount"))
                      ? { format: "currency" }
                      : {}),
                  }));
                blocks.push({
                  type: "table",
                  title:
                    intent.tool
                      .replace(/_/g, " ")
                      .replace(/^get /, "")
                      .replace(/^./, (s: string) => s.toUpperCase()) ||
                    "Results",
                  columns,
                  rows: data.slice(0, 15) as Record<string, unknown>[],
                } as ContentBlock);
              } else if (
                typeof data === "object" &&
                data !== null &&
                !Array.isArray(data)
              ) {
                // Flatten nested objects (e.g. Yahoo Finance modules return
                // { financialData: { totalRevenue: {raw: N, fmt: "..."} } })
                // into scalar key-value pairs for card display.
                const flat: Array<{ label: string; value: string }> = [];
                const obj = data as Record<string, unknown>;

                for (const [moduleKey, moduleVal] of Object.entries(obj)) {
                  if (METADATA_FIELDS.has(moduleKey)) continue;

                  if (
                    typeof moduleVal === "object" &&
                    moduleVal !== null &&
                    !Array.isArray(moduleVal)
                  ) {
                    // Walk one level of nested module (e.g. financialData, price)
                    for (const [k, v] of Object.entries(
                      moduleVal as Record<string, unknown>
                    )) {
                      if (METADATA_FIELDS.has(k)) continue;

                      // Yahoo often wraps values as { raw: N, fmt: "..." }
                      if (
                        typeof v === "object" &&
                        v !== null &&
                        "fmt" in (v as Record<string, unknown>)
                      ) {
                        flat.push({
                          label: k
                            .replace(/([A-Z])/g, " $1")
                            .replace(/^./, (s) => s.toUpperCase()),
                          value: String(
                            (v as Record<string, unknown>).fmt ?? "N/A"
                          ),
                        });
                      } else if (
                        typeof v === "object" &&
                        v !== null &&
                        "raw" in (v as Record<string, unknown>)
                      ) {
                        const raw = (v as Record<string, unknown>).raw;
                        flat.push({
                          label: k
                            .replace(/([A-Z])/g, " $1")
                            .replace(/^./, (s) => s.toUpperCase()),
                          value:
                            typeof raw === "number"
                              ? raw.toLocaleString("en-IN")
                              : String(raw ?? "N/A"),
                        });
                      } else if (
                        typeof v === "string" ||
                        typeof v === "number" ||
                        typeof v === "boolean"
                      ) {
                        flat.push({
                          label: k
                            .replace(/([A-Z])/g, " $1")
                            .replace(/^./, (s) => s.toUpperCase()),
                          value:
                            typeof v === "number"
                              ? v.toLocaleString("en-IN")
                              : String(v),
                        });
                      }
                    }
                  } else if (
                    typeof moduleVal === "string" ||
                    typeof moduleVal === "number" ||
                    typeof moduleVal === "boolean"
                  ) {
                    // Top-level scalar
                    flat.push({
                      label: moduleKey
                        .replace(/([A-Z])/g, " $1")
                        .replace(/^./, (s) => s.toUpperCase()),
                      value:
                        typeof moduleVal === "number"
                          ? moduleVal.toLocaleString("en-IN")
                          : String(moduleVal),
                    });
                  }
                }

                const items = flat.slice(0, 12);

                if (items.length > 0) {
                  blocks.push({
                    type: "card",
                    variant: "metric",
                    title:
                      intent.tool
                        .replace(/_/g, " ")
                        .replace(/^get /, "")
                        .replace(/^./, (s: string) => s.toUpperCase()) ||
                      "Result",
                    items,
                  } as ContentBlock);
                }
              }
            }

            // Inject info block when regex fallback was used — but NOT for
            // fire_plan. That tool is matched by a precise, purpose-built FIRE
            // pattern; only the TIER fell back to regex (classifyIntentFast sets
            // no tier), which doesn't mean we misunderstood the query. An
            // "approximate / I may have misunderstood" banner on a correct plan
            // edit is misleading.
            if (
              classificationSource === "regex" &&
              intent.tool !== "fire_plan"
            ) {
              blocks.unshift({
                type: "error",
                severity: "info",
                title: "Approximate classification",
                message:
                  "I may have misunderstood your query - try rephrasing if the result isn't what you expected.",
              } as ContentBlock);
            }

            // Build turnMeta for this fast-path tool response
            const fastToolTurnMeta: TurnMeta = {
              intent: intent.tool === "run_screener" ? "screener" : intent.tool,
              tier: tier || "L2",
              tool: intent.tool,
              persona: resolvedPersonaId || intent.persona,
              confidence: intent.confidence,
              toolParams: intent.params,
              toolSuccess: true,
              symbols: (intent.params.symbols as string[]) || undefined,
            };

            // Capture screener state if this was a screener tool.
            // deriveScreenerTurnState is the de-shadowed (MONEY-620) pure
            // capture extracted into turn-context.ts so the route and its unit
            // tests run the identical transform.
            if (intent.tool === "run_screener" && toolResult.result?.data) {
              const { screenerState, symbols: screenerSymbols } =
                deriveScreenerTurnState(
                  intent.params,
                  toolResult.result.data,
                  sanitizedMessage
                );
              fastToolTurnMeta.screenerState = screenerState;
              if (screenerSymbols) {
                fastToolTurnMeta.symbols = screenerSymbols;
              }
              const resultArray = extractScreenerRows(toolResult.result.data);

              // MONEY-545: render the matches as a real table. The generic block
              // builder flattens the stock array into a useless scalar card, so
              // chat screening "ran" but showed no stocks (the reported bug).
              if (resultArray && resultArray.length > 0) {
                const num = (v: unknown) =>
                  typeof v === "number" && Number.isFinite(v) ? v : null;
                const tableRows = resultArray.slice(0, 25).map((s) => {
                  const r = s as Record<string, unknown>;
                  const mcap = num(r.marketCap);
                  const pe = num(r.pe);
                  const roe = num(r.roe);
                  return {
                    symbol: String(r.symbol || r.tradingsymbol || "—"),
                    name: String(r.name || r.companyName || ""),
                    mcap:
                      mcap != null
                        ? Math.round(mcap).toLocaleString("en-IN")
                        : "—",
                    pe: pe != null ? pe.toFixed(1) : "—",
                    roe: roe != null ? roe.toFixed(1) : "—",
                  };
                });
                blocks.unshift({
                  type: "table",
                  title: `${resultArray.length} match${resultArray.length === 1 ? "" : "es"}`,
                  columns: [
                    { key: "symbol", label: "Symbol", align: "left" as const },
                    { key: "name", label: "Name", align: "left" as const },
                    {
                      key: "mcap",
                      label: "M.Cap (₹Cr)",
                      align: "right" as const,
                    },
                    { key: "pe", label: "P/E", align: "right" as const },
                    { key: "roe", label: "ROE %", align: "right" as const },
                  ],
                  rows: tableRows,
                } as ContentBlock);
              }
            }

            // Save turn context fire-and-forget
            saveTurnContext(
              dbUser.id,
              chatId,
              pagePath,
              fastToolTurnMeta,
              priorTurnContext
            ).catch(() => {});

            return NextResponse.json({
              response: narrative,
              blocks,
              queryType: queryType as QueryMode,
              toolResults: [toolResult.result],
              personaId: resolvedPersonaId,
              turnMeta: fastToolTurnMeta,
            });
          }
        }

        // Gemini disabled - narrative path needs Gemini, fall back to
        // raw tool data with a generic stub. Should be very rare in
        // practice (only when GEMINI_ENABLED=false at the env level).
        return NextResponse.json({
          response: TOOL_NARRATIVE_FALLBACK_TEXT,
          blocks: buildToolNarrativeFallbackBlocks(),
          queryType: queryType as QueryMode,
          toolResults: [toolResult.result],
        });
      }

      // Tool execution failed - catch ALL failure modes, never fall through to Gemini
      // Case 1: executeTool returned { executed: false } (validation/param error)
      // Case 2: executeTool returned { executed: true, result: { success: false } } (tool ran but failed)
      const toolFailed =
        (!toolResult.executed && !toolResult.needsConfirmation) ||
        (toolResult.executed &&
          toolResult.result &&
          !toolResult.result.success);

      if (toolFailed) {
        // Tools return TWO failure strings: a terse `error` (for logs) and an
        // optional human `message` with guidance ("Try being more specific,
        // e.g. …"). Show the guidance to the user, keep the terse one in logs.
        const failedResult = toolResult.result as
          | { error?: string; message?: string }
          | undefined;
        const guidance =
          (toolResult.executed ? failedResult?.message?.trim() : undefined) ||
          undefined;
        const errorMsg =
          toolResult.error ||
          failedResult?.error ||
          "Could not process your request. Try rephrasing.";
        const userMessage = guidance || errorMsg;

        logger.warn(
          { requestId, tool: intent.tool, error: errorMsg },
          "Fast-path tool execution failed - returning guidance to user"
        );

        // Never dead-end (feedback: chat must degrade gracefully). When there's
        // actionable guidance it's a soft "refine your query", not a hard
        // error; and for the screener we add a next step to the visual tools.
        const failureBlocks: ContentBlock[] = [
          {
            type: "error",
            severity: guidance ? "info" : "warning",
            title: guidance ? "Let's refine that" : "Could not execute",
            message: userMessage,
          },
        ];
        if (intent.tool === "run_screener") {
          failureBlocks.push({
            type: "navigation",
            links: [
              {
                label: "Open Screener",
                href: "/discover/screener",
                description: "Build filters visually across 70+ metrics",
              },
              {
                label: "Browse strategies",
                href: "/strategies",
                description: "Pick a pre-built strategy and backtest it",
              },
            ],
          });
        }

        return NextResponse.json({
          response: userMessage,
          blocks: failureBlocks,
          queryType: queryType as QueryMode,
          personaId: resolvedPersonaId,
        });
      }

      // Tool needs confirmation
      if (toolResult.needsConfirmation) {
        // Consume credits for research tools at confirmation time
        // (user will proceed with the action after confirming)
        if (inputValidation.fastIntent?.tool === "run_research") {
          const confirmCreditResult = await consumeCredits(
            dbUser.id,
            creditAction,
            {
              query: sanitizedMessage.slice(0, 200),
              tier,
            }
          );
          if (!confirmCreditResult.success) {
            return NextResponse.json(
              {
                error:
                  confirmCreditResult.error || "Not enough credits remaining.",
              },
              { status: 403 }
            );
          }
          await consumeAIQuery(queryType as QueryMode);
        }

        const actionId = `confirm-${randomUUID()}`;
        // For research tools, inject:
        //   1. mode - the user's saved research style takes priority over the
        //      legacy queryType (fast/advanced) toggle (MONEY-221).
        //   2. customSkills + researchFocus - only when the user has style
        //      = custom or has typed a "always focus on" preference. Worker
        //      consumes these in MONEY-222.
        const enrichedParams =
          intent.tool === "run_research"
            ? {
                ...intent.params,
                // MONEY-240 follow-up (QA bundle B1): user prefs WIN
                // over the classifier's pick. The intent classifier
                // doesn't know the user has saved Deep style + 9
                // skills; if it pre-set `mode: "fast"` from a short
                // prompt like "analyse TCS", that should NOT override
                // a deliberate Deep-style preference.
                mode:
                  resolvedResearchMode ||
                  intent.params.mode ||
                  (queryType as "fast" | "advanced"),
                // Saved customSkills also win - if the user has 9
                // skills selected via the "+" popover and the
                // classifier emitted no skills, inject them.
                ...(resolvedCustomSkills
                  ? { customSkills: resolvedCustomSkills }
                  : {}),
                ...(resolvedResearchFocus
                  ? { researchFocus: resolvedResearchFocus }
                  : {}),
                // MONEY-219 v2 - pass the user's preset id so the worker
                // can stamp it on the ResearchPlan, surface it in the
                // result UI, and bill via dynamic credits.
                ...(resolvedPreset &&
                !(intent.params as Record<string, unknown>).preset
                  ? { preset: resolvedPreset }
                  : {}),
                // MONEY-219 - research defaults to 2.5 Pro across every
                // paid tier unless the user has explicitly chosen a
                // different model in their composer prefs (3.0/3.1).
                // MONEY-650 (B2): use the research deep-lane model (not the
                // chat fast-lane effectiveModelId) so the confirm card's
                // credits + model label match what the run bills + executes.
                ...(!(intent.params as Record<string, unknown>).model
                  ? { model: researchModelId ?? RESEARCH_DEFAULT_MODEL }
                  : {}),
                // MONEY-801 (C1c) - saved institutional run-parameters. Each is
                // forwarded only when the user has saved it AND the classifier
                // didn't already pin it on the intent (intent.params win), so a
                // chat-triggered run honours the user's saved horizon / benchmark
                // / report depth / VaR config / DCF assumptions just like a run
                // started from the research surface. Unset → worker defaults.
                ...(resolvedHorizon &&
                !(intent.params as Record<string, unknown>).horizon
                  ? { horizon: resolvedHorizon }
                  : {}),
                ...(resolvedBenchmark &&
                !(intent.params as Record<string, unknown>).benchmark
                  ? { benchmark: resolvedBenchmark }
                  : {}),
                ...(resolvedReportLength &&
                !(intent.params as Record<string, unknown>).reportLength
                  ? { reportLength: resolvedReportLength }
                  : {}),
                ...(resolvedVarConfig &&
                !(intent.params as Record<string, unknown>).varConfig
                  ? { varConfig: resolvedVarConfig }
                  : {}),
                ...(resolvedAssumptions &&
                !(intent.params as Record<string, unknown>).assumptions
                  ? { assumptions: resolvedAssumptions }
                  : {}),
              }
            : intent.params;
        // Rebuild confirmation message with enriched params (mode-aware)
        const modeLabel =
          intent.tool === "run_research"
            ? (enrichedParams as Record<string, unknown>).mode === "advanced"
              ? "comprehensive"
              : "quick"
            : null;
        // Resolve symbols to ticker + company name for the confirmation modal
        let confirmMsg: string;
        if (intent.tool === "run_research" && modeLabel) {
          const p = enrichedParams as Record<string, unknown>;
          const rawSyms =
            Array.isArray(p.symbols) && p.symbols.length > 0
              ? (p.symbols as string[])
              : null;

          let label = (p.query as string) || "this stock";
          // MONEY-1073 — a single-fund run carries a `[MUTUAL_FUND] <name>`
          // query and a numeric AMFI scheme-code "symbol" that will NOT resolve
          // on NSE/BSE. Label the card with the fund NAME from the query (not
          // the bare code), and skip the equity resolution that would just fall
          // back to the code.
          const isFundRun =
            typeof p.query === "string" && p.query.startsWith("[MUTUAL_FUND]");
          if (isFundRun) {
            label = (p.query as string).slice("[MUTUAL_FUND]".length).trim();
          } else if (rawSyms) {
            const resolvedLabels = await Promise.all(
              rawSyms.map(async (sym) => {
                const resolved = await resolveStockSymbol(sym);
                if (resolved) return `${resolved.symbol} (${resolved.name})`;
                return sym;
              })
            );
            label = resolvedLabels.join(", ");
          }
          // MONEY-650 (B2): label the confirmation with the user's actual
          // research style (quick / deep / comprehensive / advanced) instead
          // of the binary fast→"quick" / advanced→"comprehensive" mode, which
          // mislabelled an "Advanced" (L4) run as "comprehensive".
          const depthLabel =
            userPrefs?.researchStyle &&
            ["quick", "deep", "comprehensive", "advanced"].includes(
              userPrefs.researchStyle
            )
              ? userPrefs.researchStyle
              : modeLabel;
          confirmMsg = `Start ${depthLabel} research on ${label}?`;
        } else {
          confirmMsg = toolResult.confirmationMessage || "Confirm action";
        }
        logger.info(
          { requestId, userId, tool: intent.tool, actionId },
          "Tool requires confirmation"
        );
        return NextResponse.json({
          response: confirmMsg,
          blocks: [
            {
              type: "action",
              actionId,
              tool: intent.tool,
              description: confirmMsg,
              params: enrichedParams,
              status: "pending",
              // Variant data the renderer can't infer from `tool`
              // (paper-order sub-card, roast credits, broker chips).
              ...buildConfirmFields(
                intent.tool,
                enrichedParams as Record<string, unknown>
              ),
            },
          ] as ContentBlock[],
          queryType: queryType as QueryMode,
        });
      }
    }

    // 5. Credit Consumption (unified credit system)
    // Consume unified credits based on the action determined by tier classifier.
    //
    // MONEY-619 (Phase 2): "thinking" mode. A normal chat turn that would
    // otherwise be FREE (l1_flash / follow_up / portfolio_query) but ran on
    // the tier's Pro model (because the user toggled Thinking) must be
    // charged. We swap the free action for `l2_chat_thinking` and pass a
    // costOverride that layers the model premium on top of the base 1 (so
    // gemini-3-pro = 1 + 2 = 3). Paid research turns are untouched — they're
    // already billed via their own L2/L3 action — and a non-thinking turn
    // stays exactly as before (free l1).
    const chargeThinking =
      thinkingEnabled && L1_FREE_CREDIT_ACTIONS.has(creditAction);
    chargedAction = chargeThinking ? "l2_chat_thinking" : creditAction;
    const consumeMeta: {
      query: string;
      tier: string;
      geminiModel?: string;
      costOverride?: number;
    } = {
      query: sanitizedMessage.slice(0, 200),
      tier,
    };
    if (chargeThinking) {
      consumeMeta.geminiModel = effectiveModelId ?? undefined;
      chargedAmount = getEffectiveCreditCost(
        "l2_chat_thinking",
        effectiveModelId ?? "",
        1
      );
      consumeMeta.costOverride = chargedAmount;
    }
    const creditResult = await consumeCredits(
      dbUser.id,
      chargedAction,
      consumeMeta
    );

    if (!creditResult.success) {
      logger.warn(
        { requestId, userId, creditAction, error: creditResult.error },
        "Credit consumption failed"
      );

      // Render a structured paywall response (200 not 403) so the chat
      // stays alive - user can keep conversing with free Flash. The
      // error block + upgrade CTA gives them a clear next step.
      return NextResponse.json({
        response: creditPaywallTitle(creditResult),
        blocks: buildCreditPaywallBlocks(creditResult),
        queryType: queryType as QueryMode,
      });
    }

    // Also consume legacy query for backward compat during migration
    const queryResult = await consumeAIQuery(queryType as QueryMode);
    // If legacy consumption fails but credits succeeded, still proceed
    // (unified credits are the source of truth now)

    // Mark that query was consumed (for refund logic in case of errors)
    queryConsumed = true;

    // 6. Check if Gemini is enabled
    if (!isGeminiEnabled()) {
      logger.warn("Gemini is disabled - returning mock response");

      const mockResponse =
        MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)];

      const response: ChatResponse = {
        response: mockResponse,
        remaining: queryResult.remaining,
        queryType: queryType as QueryMode,
      };

      return NextResponse.json(response);
    }

    // MONEY-790 (B5) / MONEY-806 (1) - the user's durable InvestorProfile memory
    // block, injected into the prompt so StockSage "remembers" the investor
    // across sessions. Assembled HERE (just before it's consumed by
    // buildConversationContext below) rather than at request-entry, so the
    // off-topic refusal gate + every credit/intent early-return above skip its
    // profile upsert + ~8 DB queries. Best-effort + never-throws ("" on any
    // miss/error) so chat keeps working when memory is unavailable.
    const memoryContext = await assembleUserContext(dbUser.id).catch(() => "");

    // MONEY-1274 / MONEY-1155 #32 — when `pagePath` names a research report,
    // put THAT report's findings in front of the model so answers come from
    // what the user is looking at instead of a fresh analysis of the same
    // company. Scoped to `dbUser.id` inside: `pagePath` is request-body input,
    // so an unscoped read would be an IDOR straight into the model's context.
    // Best-effort and never throws, exactly like the memory block above.
    const anchorReportContext = await assembleAnchorContext(
      parsePageAnchor(pagePath),
      dbUser.id,
      sanitizeMemoryContext
    );

    // 7. Build conversation context (with history if available)
    let conversationContext;

    if (chatId || (conversationHistory && conversationHistory.length > 0)) {
      conversationContext = await buildConversationContext(
        dbUser.id,
        chatId || null,
        pagePath,
        userContext,
        { maxMessages: 20, maxTokenBudget: 16000 },
        memoryContext,
        anchorReportContext
      );

      // Inline history is a FALLBACK for the case where nothing could be
      // loaded — a conversation the client is tracking locally with no chatId
      // yet. It is used only when the loaded history is EMPTY.
      //
      // MONEY-1274 — it used to replace the loaded history whenever it was
      // "longer", which was wrong twice over:
      //
      //   1. `conversationHistory` is typed `{role, content, turnMeta}` with NO
      //      blocks, so the replacement threw away the block summaries
      //      `convertToGeminiFormat` had just flattened in — undoing the #44 fix
      //      at runtime for any client sending a long history. The model went
      //      back to reading `assistant: "Here are the research results:"`.
      //   2. It then took `.slice(-10)` — FEWER turns than the 20-message cap
      //      the loaded history uses. A DB history of 20 (already trimmed to the
      //      token budget) being "beaten" by an inline 25 was replaced with 10.
      //      Strictly shorter AND thinner.
      //
      // Falling back only on empty keeps the fallback's purpose and leaves the
      // loaded history — which respects maxMessages and the token budget, and
      // carries what each turn actually produced — in charge whenever it exists.
      if (
        conversationHistory &&
        conversationHistory.length > 0 &&
        conversationContext.history.length === 0
      ) {
        conversationContext.history = conversationHistory
          .slice(-20)
          .map((msg) => ({
            role: msg.role === "user" ? ("user" as const) : ("model" as const),
            parts: [{ text: msg.content }],
          }));
      }

      logger.info(
        {
          requestId,
          historyLength: conversationContext.history.length,
          tokenEstimate: conversationContext.tokenEstimate,
        },
        "Built conversation context with history"
      );
    } else {
      conversationContext = await buildConversationContext(
        dbUser.id,
        null,
        pagePath,
        userContext,
        undefined,
        memoryContext,
        anchorReportContext
      );
    }

    // 8. Override system prompt with persona-based composition
    if (pagePath === "/dashboard" || context) {
      conversationContext.systemPrompt = getDashboardPrompt(
        context || "all",
        dbUser.name || undefined,
        userContext || undefined,
        resolvedPersonaId,
        tier
      );
    }

    // 9. Retrieve RAG context if appropriate (with timeout)
    let ragContext = "";
    if (shouldUseRAG(sanitizedMessage, pagePath)) {
      try {
        const RAG_TIMEOUT_MS = 5000;
        const ragPromise = retrievePageContext(
          dbUser.id,
          sanitizedMessage,
          pagePath,
          { maxDocuments: 5, maxTokens: 2000, minScore: 0.5 }
        );
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), RAG_TIMEOUT_MS)
        );

        const ragResult = await Promise.race([ragPromise, timeoutPromise]);

        if (ragResult && ragResult.documents.length > 0) {
          ragContext = ragResult.formattedContext;
          logger.info(
            {
              requestId,
              userId,
              ragDocuments: ragResult.documents.length,
              ragTokens: ragResult.tokenEstimate,
            },
            "RAG context retrieved"
          );
        } else if (!ragResult) {
          logger.warn(
            { requestId, userId },
            "RAG retrieval timed out after 5s, continuing without context"
          );
        }
      } catch (error) {
        logger.warn(
          { requestId, error, userId },
          "RAG retrieval failed, continuing without context"
        );
      }
    }

    // 9b. Retrieve stock-specific financial document context if a symbol is detected
    const symbolMatch = sanitizedMessage.match(
      /\b([A-Z]{2,10}(?:\.NS|\.BO)?)\b/
    );
    if (symbolMatch && shouldUseRAG(sanitizedMessage, pagePath)) {
      try {
        const stockCtx = await retrieveStockContext(
          symbolMatch[1]!.replace(/\.(NS|BO)$/i, ""),
          sanitizedMessage,
          { maxDocuments: 3, maxTokens: 1500, minScore: 0.4 }
        );
        if (stockCtx.formattedContext) {
          ragContext = ragContext
            ? `${ragContext}\n\n${stockCtx.formattedContext}`
            : stockCtx.formattedContext;
        }
      } catch {
        // Non-critical - continue without stock doc context
      }
    }

    // 9c. MONEY-800 (B6): SELECT the explanation-style bandit arm for this
    // user, primed from their real 👍/👎 win-rates per arm. The resolved
    // `variantId` is threaded into (a) the prompt below as a short, bounded,
    // SEBI-safe style directive (framing only, never advice) and (b) the
    // assistant message turnMeta so the feedback component can echo it back —
    // closing the loop: render arm → user thumbs → recorded outcome → next pick.
    // Best-effort: pickExplanationVariant never throws (defaults to "detailed").
    // Pass an rng so the bandit does ε-greedy EXPLORATION (default ε≈0.1) instead
    // of a deterministic argmax that would lock onto the first arm to earn a 👍
    // and never sample competing framings (MONEY-779 scan fix — B6 must learn).
    const explanationVariantId = await pickExplanationVariant(
      dbUser.id,
      Math.random
    );
    const explanationDirective = variantStyleDirective(explanationVariantId);

    // 10. Build full prompt with conversation history and RAG context
    const fullPrompt = buildFullPrompt(
      conversationContext,
      sanitizedMessage,
      ragContext,
      priorTurnContext,
      explanationDirective
    );

    // 11. Generate response with Gemini
    const model = effectiveModelId
      ? getGeminiModelById(effectiveModelId)
      : getGeminiModel(queryType as QueryMode);

    // 11s. MONEY-291: opt-in streaming. When the client sends
    // `Accept: text/event-stream`, stream the narrative token-by-token (kills
    // the first-token wait), then run the SAME scrub + guardrail + block
    // pipeline as the JSON path and emit the final blocks. The non-streaming
    // JSON path below is unchanged — streaming only activates on opt-in, so
    // existing clients are unaffected.
    if (request.headers.get("accept")?.includes(CHAT_STREAM_CONTENT_TYPE)) {
      const encoder = new TextEncoder();
      const sseStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (ev: ChatStreamEvent) =>
            controller.enqueue(encoder.encode(encodeSSE(ev)));
          // MONEY-1380 — the streamed turn needs its OWN workflow span.
          //
          // The `chat-turn` span opened by this route's POST wrapper closes
          // when POST's promise resolves, which is the moment `new Response(
          // sseStream, ...)` is returned BELOW — before a single token has been
          // generated. Everything that costs money and time (the generation
          // loop, the tool hops, the guardrail pass) runs here, after that
          // point. Left alone, chat would report a workflow duration of the
          // setup only — milliseconds against a multi-second turn — which is
          // worse than no latency number, because it looks like one.
          //
          // `ml_app` is not the problem: `start()` begins inside the outer
          // span's AsyncLocalStorage context, so model spans below inherit
          // `chat` either way. Duration and run-grouping are what this fixes.
          return llmWorkflow("chat", "chat-stream", async () => {
            try {
              // MONEY-291 (task #38): emit the `meta` event the protocol declares
              // (chat-stream.ts) BEFORE the first token. It carries the up-front
              // turnMeta (intent / tier / persona / model / symbols — all known
              // pre-generation) so the client can render the meta line + feedback
              // affordances immediately, and any pre-assembled tool blocks. In
              // this narrative branch tools run AFTER generation, so `blocks` is
              // empty here; the final `blocks` event below still carries them.
              const preTurnMeta: TurnMeta = {
                intent: inputValidation.fastIntent?.tool || "general_chat",
                tier: tier || "L2",
                tool: inputValidation.fastIntent?.tool || undefined,
                persona: resolvedPersonaId,
                model: effectiveModelId ?? undefined,
                symbols: inputValidation.fastIntent?.params?.symbols as
                  | string[]
                  | undefined,
              };
              send({ t: "meta", turnMeta: preTurnMeta });

              // Stream the narrative PRE-SCRUBBED: strip action markers, block
              // markers, and buy/sell/hold/recommendation language as the text
              // forms, so the user never sees forbidden language mid-stream.
              // Emitted as a cumulative snapshot (the client REPLACES, not
              // appends) because scrubbing can shrink earlier text. The final
              // `blocks` event still carries the fully fact-checked +
              // flash-guarded version.
              let raw = "";
              let lastVisible = "";
              for await (const delta of generateContentStreamText(
                model,
                fullPrompt
              )) {
                raw += delta;
                const visible = stripRecommendationLanguage(
                  stripBlockMarkers(removeActionMarkers(raw))
                );
                if (visible !== lastVisible) {
                  lastVisible = visible;
                  send({ t: "delta", text: visible });
                }
              }

              const streamInTok = estimateTokenCount(fullPrompt);
              const streamOutTok = estimateTokenCount(raw);
              trackTokenUsage({
                userId: dbUser.id,
                queryType: queryType as QueryMode,
                inputTokens: streamInTok,
                outputTokens: streamOutTok,
                duration: Date.now() - startTime,
                pagePath,
              }).catch(() => {});

              // Same pipeline as the JSON path: validate → tools → scrub → blocks.
              const outputValidation = validateOutput(raw);

              // MONEY-786: durable AI decision audit row for the streamed reply.
              logChatDecision({
                output: {
                  length: raw.length,
                  hadTools: outputValidation.toolCalls.length > 0,
                },
                rationale: "Streamed chat reply",
                latencyMs: Date.now() - startTime,
                inputTokens: streamInTok,
                outputTokens: streamOutTok,
              });
              const toolResults = [];
              for (const toolCall of outputValidation.toolCalls) {
                const r = await executeTool(
                  toolCall.tool,
                  toolCall.params,
                  dbUser.id
                );
                if (r.executed && r.result) toolResults.push(r.result);
              }

              let cleanResponse = removeActionMarkers(
                outputValidation.cleanedResponse
              );
              const firstToolData =
                toolResults.length > 0
                  ? (toolResults[0]?.data as
                      | Record<string, unknown>
                      | undefined)
                  : undefined;
              if (firstToolData) {
                cleanResponse = factCheckNumbers(
                  cleanResponse,
                  firstToolData
                ).response;
              }
              try {
                const flashVerdict = await flashGuardOutput({
                  response: cleanResponse,
                  query: sanitizedMessage,
                  toolData: firstToolData,
                });
                if (flashVerdict.verdict !== "allow") {
                  cleanResponse = flashVerdict.sanitizedResponse;
                  if (
                    flashVerdict.disclaimer &&
                    !cleanResponse.includes(flashVerdict.disclaimer)
                  ) {
                    cleanResponse +=
                      "\n\n---\n*" + flashVerdict.disclaimer + "*";
                  }
                }
              } catch {
                // fail-open, same as the JSON path
              }
              if (outputValidation.disclaimers.length > 0) {
                cleanResponse +=
                  "\n\n---\n*" + outputValidation.disclaimers.join(" ") + "*";
              }

              const blocks = parseMessageToBlocks(cleanResponse);
              for (const tr of toolResults) {
                if (!tr.success || !tr.data) continue;
                const typed = buildTypedBlockFromTool(tr.tool ?? "", tr.data);
                if (typed && !blocks.some((b) => b.type === typed.type)) {
                  blocks.push(typed);
                  for (const extra of buildSecondaryBlocksFromTool(
                    tr.tool ?? "",
                    tr.data
                  )) {
                    if (!blocks.some((b) => b.type === extra.type)) {
                      blocks.push(extra);
                    }
                  }
                }
              }

              const streamTurnMeta: TurnMeta = {
                // MONEY-800 (B6): tag the streamed answer with its style arm too
                // (closes the streaming-path echo gap deferred during authoring).
                variantId: explanationVariantId,
                intent: inputValidation.fastIntent?.tool || "general_chat",
                tier: tier || "L2",
                tool:
                  outputValidation.toolCalls.length > 0
                    ? outputValidation.toolCalls[0]!.tool
                    : inputValidation.fastIntent?.tool || undefined,
                persona: resolvedPersonaId,
                model: effectiveModelId ?? undefined,
                toolSuccess:
                  toolResults.length > 0
                    ? toolResults.every((r) => r.success)
                    : undefined,
                symbols: inputValidation.fastIntent?.params?.symbols as
                  | string[]
                  | undefined,
              };
              saveTurnContext(
                dbUser.id,
                chatId,
                pagePath,
                streamTurnMeta,
                priorTurnContext
              ).catch(() => {});

              send({ t: "blocks", blocks });
              send({
                t: "done",
                turnMeta: streamTurnMeta,
                remaining: queryResult.remaining,
              });
            } catch (err) {
              logger.error(
                {
                  requestId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "Streaming chat generation failed"
              );
              send({
                t: "error",
                message: "Something went wrong generating the answer.",
              });
              // RETHROW so the workflow span records the failure.
              //
              // The client has already been told — the error event above is
              // what it renders — so this changes nothing a user sees. What it
              // fixes is the span: `llmWorkflow`'s callback swallowing the
              // error made `chat-stream` report status:ok on EVERY turn,
              // including failed ones, so an error-rate query on ml_app:chat
              // would read 0% forever. That is the same "a wrong number that
              // looks like a right one" defect this span was added to fix, in
              // the other field — and the shape MONEY-1238 has shipped four
              // times. The `.catch` below absorbs it at the boundary.
              throw err;
            } finally {
              controller.close();
            }
          }).catch(() => {
            // Deliberately empty. `start()` must still resolve — the stream was
            // closed in the `finally` above and the client already has its
            // error event, so an unhandled rejection here would be noise, not
            // information.
          });
        },
      });

      return new Response(sseStream, {
        headers: {
          "Content-Type": CHAT_STREAM_CONTENT_TYPE,
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          // disable proxy buffering so deltas flush immediately
          "X-Accel-Buffering": "no",
        },
      });
    }

    try {
      // MONEY-239 G - soft-timer wrap so we get PostHog telemetry on
      // L2-fast / L1 chat narratives that flirt with the Vercel 60 s
      // function limit. The hard timeout inside generateWithTimeout
      // (default 30 s) still kicks in if needed; this just gives us a
      // signal at 25 s so we know how often to escalate to the worker.
      const geminiResponse = await withSoftTimeout(
        () => generateWithTimeout(model, fullPrompt),
        {
          softMs: 25_000,
          eventName: "chat_narrative_slow",
          userId: dbUser.id,
          metadata: {
            queryType,
            pagePath,
            modelId: effectiveModelId ?? "queryTypeDefault",
          },
        }
      );

      const duration = Date.now() - startTime;

      // 12. Estimate token usage for cost tracking
      const inputTokens = estimateTokenCount(fullPrompt);
      const outputTokens = estimateTokenCount(geminiResponse);

      // Track usage asynchronously (don't block response)
      trackTokenUsage({
        userId: dbUser.id,
        queryType: queryType as QueryMode,
        inputTokens,
        outputTokens,
        duration,
        pagePath,
      }).catch((error) => {
        logger.error({ error }, "Failed to track token usage");
      });

      // 13. Layer 2: Output validation
      const outputValidation = validateOutput(geminiResponse);

      // MONEY-786: durable AI decision audit row for the JSON-path reply.
      logChatDecision({
        output: {
          length: geminiResponse.length,
          hadTools: outputValidation.toolCalls.length > 0,
        },
        rationale: "Chat reply (JSON path)",
        latencyMs: duration,
        inputTokens,
        outputTokens,
      });

      // 14. Execute any tool calls detected in the response
      const toolResults = [];
      for (const toolCall of outputValidation.toolCalls) {
        const result = await executeTool(
          toolCall.tool,
          toolCall.params,
          dbUser.id
        );
        if (result.executed && result.result) {
          toolResults.push(result.result);
        }
      }

      // 15. Detect legacy actions in response
      const detectedAction = detectActions(
        outputValidation.cleanedResponse,
        pagePath
      );

      // 16. Fact-check LLM response against tool data
      let cleanResponse = removeActionMarkers(outputValidation.cleanedResponse);
      const firstToolData =
        toolResults.length > 0
          ? (toolResults[0]?.data as Record<string, unknown> | undefined)
          : undefined;
      if (firstToolData) {
        const { response: checkedResponse } = factCheckNumbers(
          cleanResponse,
          firstToolData
        );
        cleanResponse = checkedResponse;
      }

      // 16b. Layer 2 (Flash) output guardrail — SINGLE call site.
      // Cheap gemini-flash-lite verdict that the answer stays on-topic +
      // SEBI-safe (no buy/sell/hold/target) + no fabricated numbers. Runs
      // ONLY when the internal deterministic scan flags something, so a
      // clean turn pays zero extra latency. Fail-open-safe: any guardrail
      // error degrades to the deterministic verdict and NEVER blocks chat.
      try {
        const flashVerdict = await flashGuardOutput({
          response: cleanResponse,
          query: sanitizedMessage,
          toolData: firstToolData,
        });
        if (flashVerdict.flashInvoked || flashVerdict.verdict !== "allow") {
          logger.info(
            {
              requestId,
              userId,
              verdict: flashVerdict.verdict,
              flags: flashVerdict.flags,
              flashInvoked: flashVerdict.flashInvoked,
              reason: flashVerdict.reason,
            },
            "Flash output guardrail evaluated"
          );
        }
        if (flashVerdict.verdict !== "allow") {
          cleanResponse = flashVerdict.sanitizedResponse;
          if (
            flashVerdict.disclaimer &&
            !cleanResponse.includes(flashVerdict.disclaimer)
          ) {
            cleanResponse += "\n\n---\n*" + flashVerdict.disclaimer + "*";
          }
        }
      } catch (guardErr) {
        // Defensive: flashGuardOutput is fail-open internally, but never let
        // the guardrail invocation itself break the response path.
        logger.warn(
          {
            requestId,
            err:
              guardErr instanceof Error ? guardErr.message : String(guardErr),
          },
          "Flash output guardrail invocation threw — allowing deterministic response"
        );
      }

      // Append disclaimers if any
      if (outputValidation.disclaimers.length > 0) {
        cleanResponse +=
          "\n\n---\n*" + outputValidation.disclaimers.join(" ") + "*";
      }

      const blocks = parseMessageToBlocks(cleanResponse);

      // 17. If tools were executed but LLM didn't produce block markers,
      //     auto-format the tool results as table/card blocks
      if (
        toolResults.length > 0 &&
        !blocks.some(
          (b) =>
            b.type === "table" ||
            b.type === "card" ||
            b.type === "chart" ||
            // A rich typed block (emitted via an LLM :::block marker) already
            // answers — suppress the generic table/card fallback so the result
            // doesn't render twice (MONEY-587 task #40 dedupe fix).
            b.type === "stock-list" ||
            b.type === "holdings" ||
            b.type === "portfolio" ||
            b.type === "news" ||
            b.type === "risk" ||
            b.type === "tax" ||
            b.type === "fire" ||
            b.type === "sector" ||
            b.type === "technical" ||
            b.type === "pnl" ||
            b.type === "dividend" ||
            b.type === "mf" ||
            b.type === "scorecard" ||
            b.type === "error"
        )
      ) {
        for (const tr of toolResults) {
          if (!tr.success || !tr.data) continue;
          let data = tr.data;

          // Unwrap nested objects: if data is { items: [...], summary: {...} },
          // extract the first array property for table rendering
          if (
            !Array.isArray(data) &&
            typeof data === "object" &&
            data !== null
          ) {
            const obj = data as Record<string, unknown>;
            const arrayKey = Object.keys(obj).find((k) =>
              Array.isArray(obj[k])
            );
            if (arrayKey) {
              data = obj[arrayKey] as {};
            }
          }

          // Auto-format arrays as tables
          if (Array.isArray(data) && data.length > 0) {
            const sample = data[0] as Record<string, unknown>;
            // Only use scalar (non-object) fields as table columns
            const columns = Object.keys(sample)
              .filter(
                (k) =>
                  k !== "id" &&
                  k !== "userId" &&
                  k !== "createdAt" &&
                  k !== "updatedAt"
              )
              .filter(
                (k) => typeof sample[k] !== "object" || sample[k] === null
              )
              .slice(0, 8)
              .map((key) => ({
                key,
                label: key
                  .replace(/([A-Z])/g, " $1")
                  .replace(/^./, (s) => s.toUpperCase()),
                align: (typeof sample[key] === "number" ? "right" : "left") as
                  | "left"
                  | "right",
                ...(typeof sample[key] === "number" &&
                key.toLowerCase().includes("pnl")
                  ? { format: "pnl" }
                  : {}),
                ...(typeof sample[key] === "number" &&
                (key.toLowerCase().includes("price") ||
                  key.toLowerCase().includes("value") ||
                  key.toLowerCase().includes("invested") ||
                  key.toLowerCase().includes("amount"))
                  ? { format: "currency" }
                  : {}),
              }));
            blocks.push({
              type: "table",
              title:
                tr.tool
                  ?.replace(/_/g, " ")
                  .replace(/^get /, "")
                  .replace(/^./, (s: string) => s.toUpperCase()) || "Results",
              columns,
              rows: data.slice(0, 15) as Record<string, unknown>[],
            } as ContentBlock);
          }
          // Auto-format objects as cards - flatten nested structures
          // (e.g. Yahoo Finance: { financialData: { totalRevenue: { raw: N, fmt: "..." } } })
          else if (typeof data === "object" && data !== null) {
            const obj = data as Record<string, unknown>;
            const flat: Array<{ label: string; value: string }> = [];

            for (const [mk, mv] of Object.entries(obj)) {
              if (METADATA_FIELDS.has(mk)) continue;

              if (typeof mv === "object" && mv !== null && !Array.isArray(mv)) {
                // Walk one level of nested module
                for (const [k, v] of Object.entries(
                  mv as Record<string, unknown>
                )) {
                  if (METADATA_FIELDS.has(k)) continue;

                  if (
                    typeof v === "object" &&
                    v !== null &&
                    "fmt" in (v as Record<string, unknown>)
                  ) {
                    flat.push({
                      label: k
                        .replace(/([A-Z])/g, " $1")
                        .replace(/^./, (s) => s.toUpperCase()),
                      value: String(
                        (v as Record<string, unknown>).fmt ?? "N/A"
                      ),
                    });
                  } else if (
                    typeof v === "object" &&
                    v !== null &&
                    "raw" in (v as Record<string, unknown>)
                  ) {
                    const raw = (v as Record<string, unknown>).raw;
                    flat.push({
                      label: k
                        .replace(/([A-Z])/g, " $1")
                        .replace(/^./, (s) => s.toUpperCase()),
                      value:
                        typeof raw === "number"
                          ? raw.toLocaleString("en-IN")
                          : String(raw ?? "N/A"),
                    });
                  } else if (
                    typeof v === "string" ||
                    typeof v === "number" ||
                    typeof v === "boolean"
                  ) {
                    flat.push({
                      label: k
                        .replace(/([A-Z])/g, " $1")
                        .replace(/^./, (s) => s.toUpperCase()),
                      value:
                        typeof v === "number"
                          ? v.toLocaleString("en-IN")
                          : String(v),
                    });
                  }
                }
              } else if (
                typeof mv === "string" ||
                typeof mv === "number" ||
                typeof mv === "boolean"
              ) {
                flat.push({
                  label: mk
                    .replace(/([A-Z])/g, " $1")
                    .replace(/^./, (s) => s.toUpperCase()),
                  value:
                    typeof mv === "number"
                      ? mv.toLocaleString("en-IN")
                      : String(mv),
                });
              }
            }

            const items = flat.slice(0, 12);
            if (items.length > 0) {
              blocks.push({
                type: "card",
                variant: "metric",
                title:
                  tr.tool
                    ?.replace(/_/g, " ")
                    .replace(/^get /, "")
                    .replace(/^./, (s: string) => s.toUpperCase()) || "Result",
                items,
              } as ContentBlock);
            }
          }
        }
      }

      logger.info(
        {
          requestId,
          userId,
          queryType,
          duration,
          hasAction: !!detectedAction,
          hasRAG: !!ragContext,
          blockCount: blocks.length,
          toolCallCount: outputValidation.toolCalls.length,
          inputTokens,
          outputTokens,
        },
        "Chat request completed successfully"
      );

      // Inject info block when regex fallback was used
      if (classificationSource === "regex") {
        blocks.unshift({
          type: "error",
          severity: "info",
          title: "Approximate classification",
          message:
            "I may have misunderstood your query - try rephrasing if the result isn't what you expected.",
        } as ContentBlock);
      }

      // Build turnMeta for the main Gemini response
      const geminiTurnMeta: TurnMeta = {
        // MONEY-800 (B6): tag the answer with its explanation-style arm so the
        // feedback component can attribute 👍/👎 back to it (closes the loop).
        variantId: explanationVariantId,
        intent: inputValidation.fastIntent?.tool
          ? inputValidation.fastIntent.tool
          : "general_chat",
        tier: tier || "L2",
        tool:
          outputValidation.toolCalls.length > 0
            ? outputValidation.toolCalls[0]!.tool
            : inputValidation.fastIntent?.tool || undefined,
        persona: resolvedPersonaId,
        toolSuccess:
          toolResults.length > 0
            ? toolResults.every((r) => r.success)
            : undefined,
        symbols: inputValidation.fastIntent?.params?.symbols as
          | string[]
          | undefined,
      };

      // Save turn context fire-and-forget
      saveTurnContext(
        dbUser.id,
        chatId,
        pagePath,
        geminiTurnMeta,
        priorTurnContext
      ).catch(() => {});

      const response: ChatResponse = {
        response: cleanResponse,
        blocks,
        action: detectedAction || undefined,
        remaining: queryResult.remaining,
        queryType: queryType as QueryMode,
        turnMeta: geminiTurnMeta,
      };

      return NextResponse.json({
        ...response,
        personaId: resolvedPersonaId,
        // MONEY-800 (B6): echo the explanation-style arm that framed this answer
        // so the feedback component can attribute the user's thumbs back to it.
        variantId: explanationVariantId,
      });
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error(
        {
          requestId,
          error,
          userId,
          queryType,
          duration,
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        },
        "Gemini generation failed"
      );

      // Refund credits + legacy query since the API call failed
      await Promise.all([
        refundCredits(dbUser.id, chargedAction, chargedAmount).catch((err) =>
          logger.error(
            { error: err },
            "Failed to refund credits after API failure"
          )
        ),
        refundAIQuery(queryType as QueryMode).catch((err) =>
          logger.error(
            { error: err },
            "Failed to refund query after API failure"
          )
        ),
      ]);

      // Check if it's a timeout or rate limit error
      const errorMessage = error instanceof Error ? error.message : "";

      if (errorMessage.includes("timeout")) {
        return NextResponse.json(
          {
            error:
              "The request took too long to process. Please try again with a shorter question or use fast mode.",
          },
          { status: 504 }
        );
      }

      if (errorMessage.includes("429") || errorMessage.includes("quota")) {
        return NextResponse.json(
          {
            error:
              "AI service is temporarily busy. Please try again in a few moments.",
          },
          { status: 429 }
        );
      }

      // Generic error - provide helpful message based on error type
      const isInvalidConfig =
        errorMessage.includes("Invalid JSON payload") ||
        errorMessage.includes("Invalid argument") ||
        errorMessage.includes("Cannot find field");

      if (isInvalidConfig) {
        return NextResponse.json(
          {
            error:
              "We're experiencing a technical issue with the advanced AI model. Please try using Fast mode instead, or try again in a few moments.",
          },
          { status: 500 }
        );
      }

      return NextResponse.json(
        {
          error:
            "We're having trouble processing your request right now. Please try again in a moment, or switch to Fast mode for quicker responses.",
        },
        { status: 500 }
      );
    }
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(
      {
        requestId,
        error,
        duration,
        errorStack: error instanceof Error ? error.stack : undefined,
      },
      "Chat API error"
    );

    // Refund credits + legacy query if consumed but API failed
    if (queryConsumed) {
      const dbUser = await getOrCreateDbUser("").catch(() => null);
      await Promise.all([
        dbUser
          ? refundCredits(dbUser.id, chargedAction, chargedAmount).catch(
              (err) =>
                logger.error(
                  { error: err },
                  "Failed to refund credits after error"
                )
            )
          : Promise.resolve(),
        refundAIQuery(currentQueryType).catch((err) =>
          logger.error({ error: err }, "Failed to refund query after error")
        ),
      ]);
    }

    return NextResponse.json(
      { error: "Something went wrong. Please try again in a moment." },
      { status: 500 }
    );
  }
}

/**
 * GET /api/chat
 *
 * Health check endpoint
 */
export async function GET() {
  const isEnabled = isGeminiEnabled();

  return NextResponse.json({
    status: "ok",
    geminiEnabled: isEnabled,
    message: isEnabled
      ? "Gemini integration is enabled"
      : "Gemini integration is disabled (USE_GEMINI=false)",
  });
}
