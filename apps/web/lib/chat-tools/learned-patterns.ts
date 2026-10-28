/**
 * Learned Patterns - Warm In-Memory Cache
 *
 * Caches learned examples and regex patterns from Redis,
 * auto-refreshed every 5 minutes. Used by:
 * - classifyIntentWithFlash() - injects learned examples into the prompt
 * - classifyIntentFast() - applies learned regex patterns (low priority)
 */

export interface FlashExample {
  exampleMessage: string;
  correctIntent: string;
  correctTier?: string;
  correctTool?: string;
  correctPersona?: string;
}

export interface LearnedRegexPattern {
  regexPattern: string;
  targetTool: string;
  correctIntent?: string;
  correctTier?: string;
}

// ── In-memory cache ─────────────────────────────────────────────────────

let cachedExamples: FlashExample[] = [];
let cachedPatterns: LearnedRegexPattern[] = [];
let lastRefresh = 0;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get learned examples for Flash prompt injection (async - refreshes from Redis if stale).
 */
export async function getLearnedExamples(): Promise<FlashExample[]> {
  await refreshIfStale();
  return cachedExamples;
}

/**
 * Get learned regex patterns for fast-path matching (sync - uses cached data).
 */
export function getLearnedPatterns(): LearnedRegexPattern[] {
  return cachedPatterns;
}

/**
 * Force a refresh from Redis (used by tests or manual trigger).
 */
export async function forceRefresh(): Promise<void> {
  await loadFromRedis();
}

// ── Redis loader ────────────────────────────────────────────────────────

async function refreshIfStale(): Promise<void> {
  const now = Date.now();
  if (now - lastRefresh < REFRESH_INTERVAL_MS) return;

  try {
    await loadFromRedis();
  } catch {
    // If Redis fails, keep using cached data
  }
}

async function loadFromRedis(): Promise<void> {
  try {
    const { getRedisClient } = await import("@/lib/redis/client");
    const redis = getRedisClient();
    if (!redis) return;

    const [examplesJson, patternsJson] = await Promise.all([
      redis.get("intent-learning:active-examples"),
      redis.get("intent-learning:active-patterns"),
    ]);

    if (examplesJson) {
      try {
        cachedExamples = JSON.parse(examplesJson) as FlashExample[];
      } catch {
        cachedExamples = [];
      }
    }

    if (patternsJson) {
      try {
        cachedPatterns = JSON.parse(patternsJson) as LearnedRegexPattern[];
      } catch {
        cachedPatterns = [];
      }
    }

    lastRefresh = Date.now();
  } catch {
    // Redis unavailable - keep existing cache
  }
}
