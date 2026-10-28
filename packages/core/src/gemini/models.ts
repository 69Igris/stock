/**
 * Gemini LLM Integration - Model Configuration and Management
 *
 * This file handles model selection (Flash vs Pro), thinking mode configuration,
 * retry logic with exponential backoff, and generation parameter management.
 */

import { getVertexAIClient, type GeminiGenerativeModel } from "./client";
import { getModelLocation, getModelDefinition } from "./model-registry";
import { getClaudeCompatModel } from "../anthropic/compat";
import { geminiLogger as logger } from "@usemoney/logger";
import type { QueryMode, ModelConfig } from "@usemoney/types";

/**
 * Model configurations for fast and advanced modes
 */
export const MODEL_CONFIG: Record<QueryMode, ModelConfig> = {
  fast: {
    modelName: "gemini-2.5-flash",
    enableThinking: false,
    generationConfig: {
      temperature: 0.7, // Balanced creativity
      topP: 0.95, // Nucleus sampling
      topK: 40, // Top-K sampling
      maxOutputTokens: 2048, // Lower for faster responses
    },
  },
  advanced: {
    modelName: "gemini-2.5-pro",
    enableThinking: true, // ALWAYS enabled for advanced mode
    generationConfig: {
      temperature: 0.9, // Higher creativity for deep analysis
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 8192, // Higher for detailed responses
      // Thinking mode configuration for Gemini 2.5 Pro
      // thinkingBudget: minimum 1024, maximum 24576 tokens
      // Higher budget = more reasoning depth but slower response
      thinkingConfig: {
        thinkingBudget: 4096, // Allocate 4K tokens for thinking process
      },
    },
  },
};

/**
 * Get Gemini model instance for the specified query mode
 *
 * @param mode - Query mode (fast or advanced)
 * @returns Generative model instance configured for the mode
 */
export function getGeminiModel(mode: QueryMode): GeminiGenerativeModel {
  const vertexAI = getVertexAIClient();
  const config = MODEL_CONFIG[mode];

  logger.info(
    {
      mode,
      model: config.modelName,
      thinking: config.enableThinking,
    },
    "Initializing Gemini model",
  );

  return vertexAI.getGenerativeModel({
    model: config.modelName,
    generationConfig: config.generationConfig,
  });
}

/**
 * MONEY-229 Phase E - Get a Gemini model instance by explicit registry ID.
 *
 * The chat route + research synthesizer call this when the user has a
 * model preference saved (`User.preferences.model`). Routes to:
 *
 *   - 2.5-flash / 3-flash / 3.5-flash / flash-lite → fast config (2K out,
 *     no thinking)
 *   - 2.5-pro / 3-pro → advanced config (8K visible out + thinking budget;
 *     gemini-3-pro gets the deeper budget)
 *
 * Unknown IDs fall back to the QueryMode-based legacy config so the
 * caller never crashes on a stale stored value.
 *
 * MONEY-650: the Pro thinking-budget check keys on ANY Gemini 3.x Pro id
 * via regex — the live id is the versioned `gemini-3.1-pro-preview`, which a
 * literal `includes("gemini-3-pro")` would miss (silently dropping the deep
 * thinking budget). 2.5-pro keeps 4096.
 */
export function getGeminiModelById(modelId: string): GeminiGenerativeModel {
  // MONEY-626: route Anthropic ids to the Claude compat model — it exposes
  // the SAME GeminiGenerativeModel shape (generateContent + real token
  // streaming) with a lazy Gemini fallback, so chat + research call it
  // transparently. The founder allowlist is enforced UPSTREAM at resolve
  // time, so only an entitled pick ever reaches here as a Claude id.
  const def = getModelDefinition(modelId);
  if (def?.provider === "anthropic") {
    logger.info({ modelId }, "Routing to Claude compat model");
    return getClaudeCompatModel({
      model: modelId,
      fallback: () => getGeminiModel("advanced"),
    });
  }

  // Backend routing (MONEY-650): on the Gemini Developer API `location` is
  // ignored (region-less); it is only consulted on the legacy Vertex fallback,
  // where `getModelLocation` returns "global" for the 3.x family.
  const location = getModelLocation(modelId);
  const vertexAI = getVertexAIClient(location);

  // Map registered IDs to generation config. Thinking budget scales with
  // tier - the frontier Pro model gets more reasoning room before it emits.
  const lower = modelId.toLowerCase();
  const isFlashLite = lower.includes("flash-lite");
  const isFlash = lower.includes("flash");
  // Any Gemini 3.x Pro id (gemini-3-pro, gemini-3-pro-preview,
  // gemini-3.1-pro-preview) — version-tolerant so a preview suffix or a 3.x
  // minor bump never drops the deep thinking budget.
  const is3Pro = /gemini-3(\.\d+)?-pro/.test(lower);

  let generationConfig: ModelConfig["generationConfig"];
  if (isFlashLite) {
    generationConfig = {
      temperature: 0.6,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 1024,
    };
  } else if (isFlash) {
    generationConfig = {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 2048,
    };
  } else {
    // Pro tier - 2.5-pro / gemini-3.x-pro.
    //
    // On Gemini 2.5/3.x thinking models, maxOutputTokens caps THINKING +
    // visible output COMBINED. The thinking budget below scales up with
    // the tier, so a flat 8192 ceiling left almost no room for the visible
    // response on the larger models — equalling the ceiling truncated the
    // synthesizer's large ~17-section research JSON to just summary + score
    // (the §2–§16 body silently dropped). Budget the visible output as a
    // constant ON TOP of the thinking budget so every Pro tier always has
    // the same headroom (≈8192) to emit the full structured report.
    // (MONEY-587 — research §2–§16 regression.)
    const VISIBLE_OUTPUT_TOKENS = 8192;
    const thinkingBudget = is3Pro ? 12288 : 4096;
    generationConfig = {
      temperature: 0.9,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: VISIBLE_OUTPUT_TOKENS + thinkingBudget,
      thinkingConfig: {
        thinkingBudget,
      },
    };
  }

  logger.info(
    { modelId, generationConfig: { ...generationConfig } },
    "Initializing Gemini model by id",
  );

  return vertexAI.getGenerativeModel({
    model: modelId,
    generationConfig,
  });
}

/**
 * Generate content with retry logic and exponential backoff
 *
 * This function provides robust error handling for Gemini API calls:
 * - Retries failed requests up to maxRetries times
 * - Uses exponential backoff (1s, 2s, 4s, 8s...)
 * - Logs all attempts and errors
 * - Throws the last error if all retries fail
 *
 * @param model - Gemini model instance
 * @param prompt - Input prompt for generation
 * @param maxRetries - Maximum number of retry attempts
 * @returns Generated text response
 * @throws Error if all retries fail
 */
export async function generateWithRetry(
  model: GeminiGenerativeModel,
  prompt: string,
  maxRetries?: number,
): Promise<string> {
  const retries = maxRetries || parseInt(process.env.GEMINI_MAX_RETRIES || "3");
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      logger.info(
        {
          attempt: attempt + 1,
          maxRetries: retries,
          promptLength: prompt.length,
        },
        "Generating content with Gemini",
      );

      const result = await model.generateContent(prompt);
      const response = result.response;

      // Extract text from the first candidate
      const candidate = response.candidates?.[0];

      if (!candidate) {
        throw new Error("No response candidate generated by Gemini");
      }

      // Extract text from all parts and join them
      const text = (candidate.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("");

      logger.info(
        {
          attempt: attempt + 1,
          responseLength: text.length,
        },
        "Gemini generation successful",
      );

      return text;
    } catch (error) {
      lastError = error as Error;

      logger.warn(
        {
          attempt: attempt + 1,
          maxRetries: retries,
          error: lastError.message,
        },
        "Gemini generation attempt failed",
      );

      // Don't wait on the last attempt
      if (attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s...
        logger.info({ delay }, "Waiting before retry");
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.error(
    {
      attempts: retries,
      error: lastError?.message,
    },
    "All Gemini generation attempts failed",
  );

  throw lastError || new Error("Failed to generate content after retries");
}

/**
 * Generate content with timeout
 *
 * Wraps generateWithRetry with a timeout to prevent hanging requests
 *
 * @param model - Gemini model instance
 * @param prompt - Input prompt
 * @param timeout - Timeout in milliseconds (default from env)
 * @returns Generated text or throws timeout error
 */
export async function generateWithTimeout(
  model: GeminiGenerativeModel,
  prompt: string,
  timeout?: number,
  maxRetries?: number,
): Promise<string> {
  const timeoutMs =
    timeout || parseInt(process.env.GEMINI_TIMEOUT_MS || "30000");

  return Promise.race([
    generateWithRetry(model, prompt, maxRetries),
    new Promise<string>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`Gemini request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

/**
 * Estimate token count for a string
 *
 * This is a rough approximation. The actual token count may vary.
 * Rule of thumb: 1 token ≈ 4 characters for English text
 *
 * @param text - Input text
 * @returns Estimated token count
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate content with safety settings
 *
 * Adds safety settings to prevent harmful content generation
 *
 * @param model - Gemini model instance
 * @param prompt - Input prompt
 * @returns Generated text response
 */
export async function generateWithSafety(
  model: GeminiGenerativeModel,
  prompt: string,
): Promise<string> {
  // Safety settings can be added here if needed
  // For now, we rely on Gemini's default safety settings
  return generateWithRetry(model, prompt);
}

/**
 * Get the model name for a query mode
 */
export function getModelNameForMode(mode: QueryMode): string {
  return MODEL_CONFIG[mode].modelName;
}
