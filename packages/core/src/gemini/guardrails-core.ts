/**
 * Gemini Guardrails — pure core
 *
 * Dependency-free home for the content-filtering / topic-validation logic used
 * by `guardrails.ts`. Nothing here imports the logger or Vertex AI, so it can be
 * unit-tested directly (and imported from anywhere) without dragging side-effecting
 * deps into the test process.
 *
 * `guardrails.ts` imports every symbol below and layers its async / LLM / logging
 * concerns on top — it does NOT re-implement any of this logic. This is the single
 * source of truth for:
 *   - the FINANCE_KEYWORDS / BLOCKED_KEYWORDS lists
 *   - validateFinanceTopicSync (stages 1-4 + 6 of validateFinanceTopic)
 *   - the validateWithLLM caching/retry/fallback decision logic
 *   - detectPromptInjection patterns
 *   - sanitizeUserInput
 *   - filterUnsafeContent
 *   - getFinanceKeywords / getBlockedKeywords
 *
 * Security-relevant: keep every keyword, regex pattern, and threshold byte-for-byte.
 *
 * @see packages/core/src/gemini/guardrails.ts (the caller)
 * @see apps/web/__tests__/core/gemini/guardrails.test.ts
 * @see apps/web/__tests__/gemini/guardrails-edge-cases.test.ts
 */

import type { TopicValidationResult } from "@usemoney/types";

/**
 * Finance-related keywords that indicate valid queries
 */
export const FINANCE_KEYWORDS: readonly string[] = [
  // Investment terms
  "stock",
  "share",
  "equity",
  "market",
  "invest",
  "portfolio",
  "trade",
  "trading",
  "trader",
  "investment",
  "investor",
  "mutual fund",
  "mf",
  "etf",
  "bond",
  "debenture",
  "derivative",
  "option",
  "future",
  "commodity",
  "forex",
  "currency",

  // Financial metrics
  "dividend",
  "profit",
  "loss",
  "revenue",
  "earnings",
  "eps",
  "p/e",
  "pe ratio",
  "roe",
  "roce",
  "debt",
  "ebitda",
  "valuation",
  "capitalization",

  // Indices and exchanges
  "nifty",
  "sensex",
  "nse",
  "bse",
  "nasdaq",
  "dow jones",
  "s&p",

  // Retirement and planning
  "retirement",
  "fire",
  "financial independence",
  "corpus",
  "pension",
  "savings",
  "expense",
  "budget",
  "budgeting",
  "networth",
  "net worth",
  "asset",
  "liability",

  // Tax and regulatory
  "tax",
  "taxation",
  "capital gains",
  "stcg",
  "ltcg",
  "tds",
  "itr",
  "deduction",
  "exemption",

  // Banking and finance
  "bank",
  "account",
  "deposit",
  "loan",
  "emi",
  "interest",
  "credit",
  "debit",
  "insurance",

  // Economic terms
  "inflation",
  "deflation",
  "recession",
  "bull market",
  "bear market",
  "rally",
  "crash",
  "correction",
  "volatility",

  // Analysis terms
  "fundamental",
  "technical",
  "analysis",
  "chart",
  "trend",
  "support",
  "resistance",
  "indicator",
  "strategy",

  // IPO and corporate
  "ipo",
  "ipo allotment",
  "buyback",
  "split",
  "bonus",
  "merger",
  "acquisition",
  "delisting",

  // SIP and systematic
  "sip",
  "systematic",
  "lumpsum",
  "dca",
  "rupee cost averaging",

  // Sectors
  "sector",
  "it sector",
  "banking sector",
  "pharma",
  "auto",
  "fmcg",
  "real estate",
  "infrastructure",

  // Broker related
  "broker",
  "brokerage",
  "demat",
  "trading account",
  "zerodha",
  "upstox",
  "groww",

  // Return metrics
  "return",
  "returns",
  "cagr",
  "xirr",
  "absolute return",
  "annualized",
  "yield",
];

/**
 * Blocked keywords that indicate off-topic queries
 */
export const BLOCKED_KEYWORDS: readonly string[] = [
  // Cooking and food
  "recipe",
  "cooking",
  "cook",
  "bake",
  "food",
  "cuisine",
  "dish",
  "ingredient",

  // Health and medical
  "health",
  "medical",
  "disease",
  "doctor",
  "medicine",
  "treatment",
  "symptom",
  "diagnosis",
  "hospital",
  "pharmacy",

  // Politics
  "politics",
  "political",
  "politician",
  "election",
  "vote",
  "government policy",
  "parliament",
  "congress",

  // Religion
  "religion",
  "religious",
  "god",
  "prayer",
  "temple",
  "church",
  "mosque",

  // Sports
  "sport",
  "cricket",
  "football",
  "basketball",
  "tennis",
  "match",
  "tournament",
  "player",
  "team",
  "score",

  // Entertainment
  "entertainment",
  "movie",
  "film",
  "cinema",
  "actor",
  "actress",
  "music",
  "song",
  "concert",
  "album",
  "game",
  "gaming",
  "video game",

  // Travel
  "travel",
  "trip",
  "vacation",
  "hotel",
  "flight",
  "booking",
  "tourist",
  "destination",

  // Weather
  "weather",
  "temperature",
  "rain",
  "forecast",
  "climate",

  // Fashion
  "fashion",
  "clothing",
  "dress",
  "outfit",
  "style",
  "trend",

  // Celebrities
  "celebrity",
  "celeb",
  "famous",
  "star",
];

/** 10 minutes — guardrail validation cache TTL. */
export const CACHE_TTL_MS = 10 * 60 * 1000;

/** Cache entry shape used by the LLM guardrail cache. */
export interface GuardrailCacheEntry {
  result: TopicValidationResult;
  expiresAt: number;
}

/** Sentinel returned by {@link evaluateFinanceTopic} for ambiguous longer queries. */
export const STAGE_5_LLM_HYBRID = Symbol("STAGE_5_LLM_HYBRID");

/**
 * Which stage of {@link evaluateFinanceTopic} produced the result. Lets the
 * async wrapper emit the exact branch-specific log line without re-deriving the
 * stage from `confidence` (Stage 2 with a single match and Stage 3 both yield
 * confidence 0.75, so confidence alone is ambiguous).
 */
export type ValidationStage =
  | "tooShort"
  | "blocked"
  | "keyword"
  | "pattern"
  | "shortNoKeyword";

/** Discriminated result of the synchronous topic evaluation. */
export type FinanceTopicEvaluation =
  | { stage: ValidationStage; result: TopicValidationResult }
  | { stage: typeof STAGE_5_LLM_HYBRID };

/**
 * Synchronous, side-effect-free core of `validateFinanceTopic`.
 *
 * Covers stages 1-4 and reports the {@link ValidationStage} that fired so the
 * caller can log deterministically. Stage 5 (the optional LLM classification) is
 * intentionally NOT here — it requires Vertex AI and is layered on by the async
 * `validateFinanceTopic` wrapper, which handles the {@link STAGE_5_LLM_HYBRID}
 * sentinel.
 */
export function evaluateFinanceTopic(query: string): FinanceTopicEvaluation {
  const lowerQuery = query.toLowerCase().trim();

  // Empty or very short queries
  if (lowerQuery.length < 3) {
    return {
      stage: "tooShort",
      result: {
        isValid: false,
        reason:
          "Please provide a more detailed question about finance, investments, or retirement planning.",
        confidence: 0.95,
      },
    };
  }

  // Stage 1: Check for blocked topics (highest priority)
  // Use word boundary matching to avoid false positives (e.g., "star" matching "start")
  const blockedMatches = matchBlockedKeywords(lowerQuery);

  if (blockedMatches.length > 0) {
    return {
      stage: "blocked",
      result: {
        isValid: false,
        reason:
          "I can only discuss finance-related topics such as investments, stocks, mutual funds, retirement planning, portfolio management, and trading strategies. Please ask a question related to finance.",
        confidence: 0.9,
      },
    };
  }

  // Stage 2: Check for finance keywords with word boundary consideration
  const words = lowerQuery.split(/\s+/);
  const financeMatches = matchFinanceKeywords(lowerQuery, words);

  if (financeMatches.length > 0) {
    return {
      stage: "keyword",
      result: {
        isValid: true,
        confidence: Math.min(0.7 + financeMatches.length * 0.05, 0.95),
      },
    };
  }

  // Stage 3: Check for finance-related question patterns (even without exact keywords)
  const patternMatch = FINANCE_PATTERNS.some((pattern) =>
    pattern.test(lowerQuery),
  );
  if (patternMatch) {
    return {
      stage: "pattern",
      result: {
        isValid: true,
        confidence: 0.75,
      },
    };
  }

  // Stage 4: Length-based heuristics for very short queries
  const wordCount = words.length;

  // Very short queries without finance keywords are likely off-topic
  if (wordCount < 5) {
    return {
      stage: "shortNoKeyword",
      result: {
        isValid: false,
        reason:
          "Please ask a finance-related question. I specialize in stocks, investments, mutual funds, portfolio management, and retirement planning (FIRE).",
        confidence: 0.7,
      },
    };
  }

  // Stage 5 is the LLM hybrid — escalate to the async wrapper.
  return { stage: STAGE_5_LLM_HYBRID };
}

/**
 * Synchronous topic validation returning just the {@link TopicValidationResult}
 * (or the {@link STAGE_5_LLM_HYBRID} sentinel for ambiguous longer queries).
 * Thin convenience wrapper over {@link evaluateFinanceTopic} for callers/tests
 * that don't need the stage label.
 */
export function validateFinanceTopicSync(
  query: string,
): TopicValidationResult | typeof STAGE_5_LLM_HYBRID {
  const evaluation = evaluateFinanceTopic(query);
  return "result" in evaluation ? evaluation.result : STAGE_5_LLM_HYBRID;
}

/** Stage-6 fallback result: allow the ambiguous query but flag low confidence. */
export const FALLBACK_ALLOW: TopicValidationResult = {
  isValid: true,
  confidence: 0.5, // Low confidence - might need manual review
};

/**
 * Stage 1 word-boundary match against {@link BLOCKED_KEYWORDS}.
 * `lowerQuery` MUST already be lower-cased (matches source behaviour).
 */
export function matchBlockedKeywords(lowerQuery: string): string[] {
  return BLOCKED_KEYWORDS.filter((keyword) => {
    // Create regex with word boundaries for single words
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordBoundaryRegex = new RegExp(`\\b${escapedKeyword}\\b`, "i");
    return wordBoundaryRegex.test(lowerQuery);
  });
}

/**
 * Stage 2 substring + per-word prefix match against {@link FINANCE_KEYWORDS}.
 * `lowerQuery` MUST already be lower-cased and `words` MUST be its `/\s+/` split.
 */
export function matchFinanceKeywords(
  lowerQuery: string,
  words: string[],
): string[] {
  return FINANCE_KEYWORDS.filter((keyword) => {
    // Check if keyword appears as substring (for phrases like "mutual fund")
    if (lowerQuery.includes(keyword)) {
      return true;
    }
    // Also check individual words (for acronyms like FIRE, SIP)
    return words.some((word) => word === keyword || word.startsWith(keyword));
  });
}

/** Stage 3 finance-related question patterns. */
export const FINANCE_PATTERNS: readonly RegExp[] = [
  /\b(invest|trading|stock|portfolio|retirement|savings|budget|wealth|financial|money|income|expense)\b/i,
  /\b(how (much|many|to|should|can).*(invest|save|retire|portfolio))/i,
  /\b(what (is|are).*(stock|equity|bond|fund|asset|return))/i,
  /\b(when (to|should).*(buy|sell|invest|retire))/i,
  /\b(where (to|should).*(invest|put|allocate))/i,
  /\b(why.*(invest|diversify|rebalance))/i,
];

/**
 * Build the {@link TopicValidationResult} for a resolved LLM classification.
 * `llmResponse` is the trimmed, upper-cased model reply; "YES" ⇒ finance-related.
 */
export function buildLLMValidationResult(
  llmResponse: string,
): TopicValidationResult {
  const isFinanceRelated = llmResponse === "YES";
  return {
    isValid: isFinanceRelated,
    reason: isFinanceRelated
      ? undefined
      : "I can only discuss finance-related topics such as investments, stocks, mutual funds, retirement planning, portfolio management, and trading strategies. Please ask a question related to finance.",
    confidence: 0.95,
  };
}

/** Result of the LLM-failure decision: whether to retry, and the fallback if not. */
export const LLM_FALLBACK_RESULT: TopicValidationResult = {
  isValid: true,
  confidence: 0.5, // Allow by default on error
};

/** Options for {@link validateWithLLMRetry} (all injectable for deterministic tests). */
export interface ValidateWithLLMOptions {
  /** Performs one LLM classification call; returns the raw (untrimmed) model text. */
  llmCall: () => Promise<string>;
  /** Shared validation cache. */
  cache: Map<string, GuardrailCacheEntry>;
  /** Max retries on rate-limit errors. Defaults to 3 (source value). */
  maxRetries?: number;
  /** Base backoff delay in ms. Defaults to 1000 (source value). */
  baseDelay?: number;
  /** Clock, injectable for tests. Defaults to {@link Date.now}. */
  now?: () => number;
  /** Sleep impl, injectable for tests. Defaults to a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional hook invoked when a rate-limit retry is scheduled (for logging). */
  onRetry?: (info: {
    retryCount: number;
    delay: number;
    errorMessage: string;
  }) => void;
  /** Optional hook invoked on the terminal failure (for logging). */
  onFailure?: (info: { error: unknown; retryCount: number }) => void;
}

/**
 * Pure orchestration of the LLM topic-validation retry/cache/fallback flow.
 *
 * This is the exact control flow the source `validateWithLLM` runs, with the
 * Vertex AI call, the clock, and `sleep` injected so it can be unit-tested
 * without a live model:
 *   1. serve from cache when present and unexpired
 *   2. call the LLM; "YES" ⇒ finance-related; cache + return the result
 *   3. on a rate-limit error with retries left: exponential backoff, then recurse
 *   4. otherwise fall back to {@link LLM_FALLBACK_RESULT} (allow @ 0.5 confidence)
 *
 * Logging is delegated to the optional `onRetry` / `onFailure` hooks.
 */
export async function validateWithLLMRetry(
  query: string,
  options: ValidateWithLLMOptions,
  retryCount = 0,
): Promise<TopicValidationResult> {
  const {
    llmCall,
    cache,
    maxRetries = 3,
    baseDelay = 1000,
    now = Date.now,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry,
    onFailure,
  } = options;

  const cacheKey = guardrailCacheKey(query);
  const cachedResult = readGuardrailCache(cache, cacheKey, now());
  if (cachedResult) {
    return cachedResult;
  }

  try {
    const raw = await llmCall();
    const response = raw.trim().toUpperCase();
    const validationResult = buildLLMValidationResult(response);
    writeGuardrailCache(cache, cacheKey, validationResult, now());
    return validationResult;
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    if (isRateLimitError(errorMessage) && retryCount < maxRetries) {
      const delay = backoffDelay(baseDelay, retryCount);
      onRetry?.({ retryCount, delay, errorMessage });
      await sleep(delay);
      return validateWithLLMRetry(query, options, retryCount + 1);
    }

    onFailure?.({ error, retryCount });
    return LLM_FALLBACK_RESULT;
  }
}

/** True if an error message indicates a rate-limit (429 / RESOURCE_EXHAUSTED). */
export function isRateLimitError(errorMessage: string): boolean {
  return (
    errorMessage.includes("429") || errorMessage.includes("RESOURCE_EXHAUSTED")
  );
}

/** Exponential backoff delay (ms) for retry `retryCount`: baseDelay * 2^retryCount. */
export function backoffDelay(baseDelay: number, retryCount: number): number {
  return baseDelay * Math.pow(2, retryCount);
}

/**
 * Cache-read helper: returns the cached result iff present AND not expired
 * (`expiresAt > now`), else null. `now` injectable for deterministic tests.
 */
export function readGuardrailCache(
  cache: Map<string, GuardrailCacheEntry>,
  cacheKey: string,
  now: number = Date.now(),
): TopicValidationResult | null {
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }
  return null;
}

/**
 * Cache-write helper mirroring the source: stores `result` under `cacheKey`
 * expiring `CACHE_TTL_MS` after `now`. `now` injectable for tests.
 */
export function writeGuardrailCache(
  cache: Map<string, GuardrailCacheEntry>,
  cacheKey: string,
  result: TopicValidationResult,
  now: number = Date.now(),
): void {
  cache.set(cacheKey, {
    result,
    expiresAt: now + CACHE_TTL_MS,
  });
}

/** Normalize a query into its guardrail cache key (`toLowerCase().trim()`). */
export function guardrailCacheKey(query: string): string {
  return query.toLowerCase().trim();
}

/**
 * Cache-cleanup helper: collect keys whose entries are expired (`expiresAt <= now`)
 * and delete them in place. Returns the number of entries removed. `now` injectable.
 */
export function cleanupGuardrailCache(
  cache: Map<string, GuardrailCacheEntry>,
  now: number = Date.now(),
): number {
  const keysToDelete: string[] = [];
  cache.forEach((value, key) => {
    if (value.expiresAt <= now) {
      keysToDelete.push(key);
    }
  });
  keysToDelete.forEach((key) => cache.delete(key));
  return keysToDelete.length;
}

/**
 * Filter potentially unsafe content from an LLM response.
 *
 * Basic passthrough filter; in production this would integrate with a content
 * safety service. Kept pure here so it can be tested + reused.
 */
export function filterUnsafeContent(response: string): string {
  // Basic filtering - can be enhanced with more sophisticated checks
  const filtered = response;

  // Remove potential harmful patterns (placeholder)
  // In production, integrate with Google Cloud Natural Language API
  // or similar content safety services

  return filtered;
}

/** Prompt-injection detection patterns. */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(previous|all|above)\s+instructions/i,
  /forget\s+(everything|all|previous)/i,
  /you\s+are\s+now\s+a/i,
  /system:/i,
  /assistant:/i,
  /\[system\]/i,
  /\[assistant\]/i,
  /act\s+as\s+if/i,
  /pretend\s+(to\s+be|you\s+are)/i,
  /disregard/i,
  /tell\s+me\s+a\s+(joke|story)/i, // Common injection attempt
  /ignore.*and\s+tell/i, // "ignore X and tell me Y"
];

/**
 * Check if a query contains a potential prompt-injection attempt.
 * Pure detector — logging stays in the `guardrails.ts` wrapper.
 */
export function detectPromptInjection(query: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(query));
}

/**
 * Sanitize user input before sending to the LLM.
 *
 * Removes role markers that could confuse the model and enforces a 5000-char cap.
 * Pure — the truncation log lives in the `guardrails.ts` wrapper.
 */
export function sanitizeUserInput(input: string): string {
  // Remove role markers that could confuse the model
  let sanitized = input
    .replace(/SYSTEM:/gi, "")
    .replace(/ASSISTANT:/gi, "")
    .replace(/USER:/gi, "")
    .replace(/\[SYSTEM\]/gi, "")
    .replace(/\[ASSISTANT\]/gi, "");

  // Enforce maximum length (5000 characters)
  if (sanitized.length > 5000) {
    sanitized = sanitized.slice(0, 5000);
  }

  return sanitized.trim();
}

/** True if `sanitized.length > 5000` — the cap that triggers a truncation log. */
export function exceedsSanitizeLimit(length: number): boolean {
  return length > 5000;
}

/**
 * Get the list of finance keywords (for testing/debugging)
 */
export function getFinanceKeywords(): readonly string[] {
  return FINANCE_KEYWORDS;
}

/**
 * Get the list of blocked keywords (for testing/debugging)
 */
export function getBlockedKeywords(): readonly string[] {
  return BLOCKED_KEYWORDS;
}
