/**
 * Topic Classifier (MONEY-295)
 *
 * Pre-gates StockSage chat queries with a fast `gemini-2.5-flash-lite`
 * classification call. Off-topic queries (recipes, coding, etc.) get
 * refused without ever reaching the expensive Pro model. Finance-shaped
 * but out-of-scope queries (crypto trading, US options) get logged but
 * pass through.
 *
 * Cached in Redis for 1 hour by query hash - same query = same answer
 * regardless of who asks. Fail-open on any classifier error so a flake
 * never blocks a legitimate user.
 */

import { createHash } from "node:crypto";
import { cacheClient } from "../cache/client";
import { getGeminiModelById } from "./models";
import { geminiLogger as logger } from "@usemoney/logger";

export type TopicCategory =
  | "on_topic"
  | "off_topic_unrelated"
  | "off_topic_finance_outside_scope"
  | "ambiguous";

export interface TopicClassification {
  category: TopicCategory;
  confidence: number; // 0-1
  reason?: string; // 1 sentence - used in refusal copy
  /** 2-3 example on-topic prompts; populated when refusing. */
  suggestedTopics?: string[];
}

export interface ClassifierContext {
  userHasHoldings?: boolean;
  pagePath?: string;
}

/** Default suggested-topics shown when an off-topic refusal renders. */
const DEFAULT_SUGGESTIONS = [
  "Analyse RELIANCE",
  "Compare HDFC Mid-Cap Opportunities vs Axis Midcap",
  "How much should I save monthly to retire at 50?",
];

const MODEL_ID = "gemini-2.5-flash-lite";
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour
const CLASSIFIER_TIMEOUT_MS = 2000;

/**
 * Slash commands and @-mentions are structurally on-topic - skip the
 * classifier entirely to save a Vertex round-trip. The chat route is
 * expected to filter these BEFORE calling classifyTopic, but we also
 * short-circuit here defensively.
 */
function shouldBypass(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 3) return true; // too short to classify meaningfully
  if (trimmed.startsWith("/")) return true; // slash command
  if (trimmed.startsWith("@")) return true; // @-mention
  return false;
}

function hashQuery(query: string): string {
  return createHash("sha256")
    .update(query.trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

const SYSTEM_PROMPT = `You are a strict topic classifier for UseMoney, an Indian stock-market and personal-finance app.

Classify the user query into EXACTLY ONE of these categories:

- on_topic: Indian stocks, mutual funds, ETFs, broker accounts (Zerodha/Upstox/Angel/etc.), the user's own portfolio/holdings, FIRE planning, SIPs, investing strategy, Indian market data/news, taxes on investments, asset allocation, retirement planning, personal finance for Indians.
- off_topic_unrelated: recipes, coding, weather, sports trivia, gossip, general chitchat, history, geography, science homework. Anything NOT about money / markets / investing.
- off_topic_finance_outside_scope: crypto trading, US/UK/EU stock options strategies, forex, gold smuggling, day-trading on overseas markets. Finance-shaped but outside our SEBI-compliant Indian remit. We DO support US-stock holdings tracking, so "what is Apple's P/E" is on_topic; "how do I trade SPY options" is outside scope.
- ambiguous: a one-word query, a vague follow-up like "show me more", or anything that could plausibly be about investing OR something else with insufficient context.

Output a single-line JSON object - no markdown, no fences, no commentary:
{"category":"on_topic|off_topic_unrelated|off_topic_finance_outside_scope|ambiguous","confidence":0.95,"reason":"one short sentence"}

Few-shot examples:

Query: "What's the P/E of HDFC Bank?"
{"category":"on_topic","confidence":0.99,"reason":"Direct question about an Indian stock's valuation metric."}

Query: "Best banana bread recipe?"
{"category":"off_topic_unrelated","confidence":0.99,"reason":"Cooking question, no financial content."}

Query: "Should I trade SPY options for income?"
{"category":"off_topic_finance_outside_scope","confidence":0.92,"reason":"US options trading is outside our Indian-market remit."}

Query: "Should I buy more BTC?"
{"category":"off_topic_finance_outside_scope","confidence":0.95,"reason":"Crypto trading is outside our SEBI-compliant Indian-market scope."}

Query: "tell me about reliance"
{"category":"on_topic","confidence":0.90,"reason":"Likely Reliance Industries - Indian listed equity."}

Query: "what's up"
{"category":"ambiguous","confidence":0.85,"reason":"Casual greeting with no financial signal."}

Query: "midcap thoughts"
{"category":"on_topic","confidence":0.85,"reason":"Indian mid-cap segment discussion."}

Query: "how do I write a Python script"
{"category":"off_topic_unrelated","confidence":0.99,"reason":"Programming question, unrelated to finance."}`;

interface RawClassifierResponse {
  category?: string;
  confidence?: number;
  reason?: string;
}

function parseClassifierResponse(text: string): TopicClassification | null {
  // Models occasionally wrap JSON in fences despite instructions - strip.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: RawClassifierResponse;
  try {
    parsed = JSON.parse(cleaned) as RawClassifierResponse;
  } catch {
    return null;
  }
  const validCategories: TopicCategory[] = [
    "on_topic",
    "off_topic_unrelated",
    "off_topic_finance_outside_scope",
    "ambiguous",
  ];
  if (
    typeof parsed.category !== "string" ||
    !validCategories.includes(parsed.category as TopicCategory)
  ) {
    return null;
  }
  const confidence =
    typeof parsed.confidence === "number" &&
    parsed.confidence >= 0 &&
    parsed.confidence <= 1
      ? parsed.confidence
      : 0.5;
  return {
    category: parsed.category as TopicCategory,
    confidence,
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
  };
}

/**
 * Classify a chat query. Cache-first; falls through to flash-lite on miss.
 * Returns `on_topic` (allow) on any failure to fail-open.
 */
export async function classifyTopic(
  query: string,
  context?: ClassifierContext,
): Promise<TopicClassification> {
  // Hard kill-switch
  if (process.env.TOPIC_CLASSIFIER_ENABLED === "false") {
    return {
      category: "on_topic",
      confidence: 1,
      reason: "classifier disabled",
    };
  }

  if (shouldBypass(query)) {
    return {
      category: "on_topic",
      confidence: 1,
      reason: "bypass (slash / @-mention / too short)",
    };
  }

  const cacheKey = `topic-class:${hashQuery(query)}`;
  const cacheConfig = {
    ttl: CACHE_TTL_SECONDS,
    enableMemory: true,
    enableRedis: true,
  };

  try {
    const cached = await cacheClient.get<TopicClassification>(
      cacheKey,
      cacheConfig,
    );
    if (cached) {
      logger.debug(
        { cacheHit: true, category: cached.category },
        "Topic classifier cache hit",
      );
      return cached;
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "Topic classifier cache read failed",
    );
  }

  // Cache miss - call flash-lite with a short timeout
  const startedAt = Date.now();
  let classification: TopicClassification;
  try {
    const model = getGeminiModelById(MODEL_ID);
    const userBlock = `Query: "${query.trim()}"`;
    const contextHint = context?.userHasHoldings
      ? "\nUser context: signed-in investor with active holdings."
      : "";
    const prompt = `${SYSTEM_PROMPT}\n\n${userBlock}${contextHint}`;

    // Manual timeout - Vertex client doesn't expose AbortSignal cleanly.
    const generation = model.generateContent(prompt);
    const result = await Promise.race([
      generation,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("classifier_timeout")),
          CLASSIFIER_TIMEOUT_MS,
        ),
      ),
    ]);

    const candidate = result.response?.candidates?.[0];
    const part = candidate?.content?.parts?.[0];
    const text = part && "text" in part ? (part.text ?? "") : "";

    const parsed = parseClassifierResponse(text);
    if (!parsed) {
      // Malformed response - fail-open with a logged tag.
      logger.warn(
        { rawText: text.slice(0, 200) },
        "Topic classifier produced unparseable output",
      );
      classification = {
        category: "on_topic",
        confidence: 0.5,
        reason: "parse_failed",
      };
    } else {
      classification = parsed;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "Topic classifier failed - failing open");
    classification = {
      category: "on_topic",
      confidence: 0.5,
      reason: `classifier_error:${message}`,
    };
  }

  // Attach default suggestions only when refusing - keeps cache compact.
  if (classification.category === "off_topic_unrelated") {
    classification = {
      ...classification,
      suggestedTopics: DEFAULT_SUGGESTIONS,
    };
  }

  logger.info(
    {
      category: classification.category,
      confidence: classification.confidence,
      durationMs: Date.now() - startedAt,
      cacheHit: false,
    },
    "Topic classifier result",
  );

  // Best-effort cache write - never let cache failure mask a real result.
  try {
    await cacheClient.set(cacheKey, classification, cacheConfig);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      "Topic classifier cache write failed",
    );
  }

  return classification;
}

/**
 * Helper: should this classification trigger an upstream refusal?
 *
 * Policy:
 * - on_topic: never refuse
 * - off_topic_unrelated AND confidence > 0.7: refuse with suggestions
 * - off_topic_finance_outside_scope: allow with logged warning (user is in the neighborhood)
 * - ambiguous: allow with logged tag
 */
export function shouldRefuse(c: TopicClassification): boolean {
  return c.category === "off_topic_unrelated" && c.confidence > 0.7;
}

/**
 * Build the user-facing refusal text.
 */
export function buildRefusalMessage(c: TopicClassification): string {
  const reason =
    c.reason ?? "I'm focused on Indian stocks and personal finance";
  return `Sorry - I'm StockSage. I help with Indian stocks, mutual funds, and personal finance. ${reason}`;
}
