/**
 * Gemini LLM Integration - Vertex AI Client (compat adapter over @google/genai)
 *
 * MONEY-619 (Phase 4): the deprecated `@google-cloud/vertexai` SDK has been
 * replaced by the unified `@google/genai` SDK. To avoid churning the ~20 call
 * sites that read the OLD SDK's result shape
 * (`result.response.candidates[0].content.parts[].text`,
 * `result.stream`, `candidate.groundingMetadata`, …), this file wraps
 * `@google/genai` in a thin COMPAT layer that re-exposes those exact shapes:
 *
 *   getVertexAIClient(location?)               → GeminiClient
 *     .getGenerativeModel({ model, generationConfig, safetySettings?,
 *                           systemInstruction?, tools? })  → GeminiGenerativeModel
 *       .generateContent(promptOrReq)          → { response: GenerateContentResponse }
 *       .generateContentStream(promptOrReq)    → { stream: AsyncGenerator<chunk>,
 *                                                  response: Promise<final> }
 *
 * The new SDK's `GenerateContentResponse` is ALREADY structurally compatible
 * with the old SDK's `result.response` object — it carries `candidates`,
 * each candidate has `content.parts[].text` / `finishReason` /
 * `groundingMetadata`, plus a `text` getter and `usageMetadata`. The only
 * differences the adapter papers over are:
 *   1. the new top-level response has NO `.response` wrapper (we add it), and
 *   2. `response.text` is a getter (old code never calls `.text()`, but we
 *      attach a `text()` method too for safety), and
 *   3. the old `generationConfig` (with a NESTED `thinkingConfig`) maps onto
 *      the new flat `config` where `thinkingConfig` is a sibling field.
 *
 * It uses a per-location cache (the Gemini 3.x family is global-endpoint-only,
 * so models.ts builds a separate client for `location: "global"`).
 */

import {
  GoogleGenAI,
  type GenerateContentResponse,
  type GenerateContentConfig,
  type ContentListUnion,
  type SafetySetting,
  type ContentUnion,
  type ToolListUnion,
} from "@google/genai";
import { geminiLogger as logger } from "@usemoney/logger";
import type { GeminiResult } from "@usemoney/types";
import { googleCredentials } from "./credentials";

/**
 * The OLD-SDK-shaped `generationConfig` accepted by `getGenerativeModel`.
 * Mirrors `@usemoney/types` `GenerationConfig` but with every field optional
 * (grounding passes only `{ temperature, maxOutputTokens }`).
 */
export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  /** e.g. "application/json" — forces a structured JSON response. */
  responseMimeType?: string;
  /** Structured-output schema (forwarded as-is to the new SDK's config). */
  responseSchema?: GenerateContentConfig["responseSchema"];
  /** Stop sequences that halt generation. */
  stopSequences?: string[];
  thinkingConfig?: {
    thinkingBudget: number;
  };
}

/** Options for `getGenerativeModel` — the OLD `@google-cloud/vertexai` shape. */
export interface GeminiGetModelOptions {
  model: string;
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: SafetySetting[];
  systemInstruction?: ContentUnion;
  tools?: ToolListUnion;
}

/** A string prompt OR an object carrying `contents` (old-SDK request shape). */
export type GeminiGenerateContentRequest =
  | string
  | { contents: ContentListUnion };

/**
 * The new `GenerateContentResponse` carries a `text` GETTER. The OLD SDK
 * exposed `response.text()` as a METHOD. No current call site uses either
 * form (all read `.candidates[...].content.parts[].text`), but we widen the
 * `text` field to "string getter OR callable" so BOTH access patterns
 * type-check and work at runtime (see `withTextCompat`).
 */
export type GeminiCompatResponse = Omit<GenerateContentResponse, "text"> & {
  /** Concatenated first-candidate text, readable as a property OR a call. */
  text: (string & (() => string | undefined)) | undefined;
};

/**
 * Compat result of `generateContent` — wraps the new flat
 * `GenerateContentResponse` in `{ response }` (old-SDK shape).
 */
export interface GeminiGenerateContentResult {
  response: GeminiCompatResponse;
}

/** Compat result of `generateContentStream` — old-SDK `{ stream, response }`. */
export interface GeminiGenerateContentStreamResult {
  stream: AsyncGenerator<GenerateContentResponse, void, unknown>;
  response: Promise<GeminiCompatResponse>;
}

/** A single model handle (compat over `ai.models`). */
export interface GeminiGenerativeModel {
  generateContent(
    req: GeminiGenerateContentRequest,
  ): Promise<GeminiGenerateContentResult>;
  generateContentStream(
    req: GeminiGenerateContentRequest,
  ): Promise<GeminiGenerateContentStreamResult>;
}

/** The top-level client (compat over `GoogleGenAI`). */
export interface GeminiClient {
  getGenerativeModel(opts: GeminiGetModelOptions): GeminiGenerativeModel;
}

/**
 * The minimal structural surface of `GoogleGenAI` the adapter actually uses
 * (`ai.models.generateContent` / `.generateContentStream`). Declared
 * structurally so `createGeminiModel` is unit-testable with a hand-rolled fake
 * that returns known payloads — no module mocking required.
 */
export interface GenAiHost {
  models: {
    generateContent(params: {
      model: string;
      contents: ContentListUnion;
      config?: GenerateContentConfig;
    }): Promise<GenerateContentResponse>;
    generateContentStream(params: {
      model: string;
      contents: ContentListUnion;
      config?: GenerateContentConfig;
    }): Promise<AsyncGenerator<GenerateContentResponse>>;
  };
}

/**
 * Per-location cache of `GoogleGenAI` instances. The 3.x family is
 * global-endpoint-only so models.ts builds a `"global"` client alongside the
 * regional (GCP_LOCATION) one; we cache each so we never re-auth per call.
 */
const clientCache = new Map<string, GoogleGenAI>();

/** Default Vertex location when a caller does not pin one. */
function defaultLocation(): string {
  return process.env.GCP_LOCATION || "us-central1";
}

/**
 * Normalize a string-or-`{contents}` request into the new SDK's `contents`.
 * A bare string becomes a single user text part (matching how the old SDK
 * accepted `model.generateContent("prompt")`).
 */
export function toContents(
  req: GeminiGenerateContentRequest,
): ContentListUnion {
  if (typeof req === "string") {
    return [{ role: "user", parts: [{ text: req }] }];
  }
  return req.contents;
}

/**
 * Map an OLD-SDK `getGenerativeModel` options object + a per-call request onto
 * the new flat `GenerateContentConfig`. The nested `thinkingConfig` is lifted
 * to a sibling field; safety/systemInstruction/tools are forwarded so grounding
 * (`tools: [{ googleSearch: {} }]`) and any safety config keep working.
 */
export function toConfig(
  opts: GeminiGetModelOptions,
): GenerateContentConfig | undefined {
  const gc = opts.generationConfig;
  const config: GenerateContentConfig = {};

  if (gc) {
    if (gc.temperature !== undefined) config.temperature = gc.temperature;
    if (gc.topP !== undefined) config.topP = gc.topP;
    if (gc.topK !== undefined) config.topK = gc.topK;
    if (gc.maxOutputTokens !== undefined)
      config.maxOutputTokens = gc.maxOutputTokens;
    if (gc.responseMimeType !== undefined)
      config.responseMimeType = gc.responseMimeType;
    if (gc.responseSchema !== undefined)
      config.responseSchema = gc.responseSchema;
    if (gc.stopSequences !== undefined) config.stopSequences = gc.stopSequences;
    if (gc.thinkingConfig) {
      config.thinkingConfig = {
        thinkingBudget: gc.thinkingConfig.thinkingBudget,
      };
    }
  }
  if (opts.safetySettings) config.safetySettings = opts.safetySettings;
  if (opts.systemInstruction !== undefined)
    config.systemInstruction = opts.systemInstruction;
  if (opts.tools) config.tools = opts.tools;

  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Overlay a `text()` METHOD on a `GenerateContentResponse` (which already
 * exposes a `text` GETTER). Old code reads `.candidates[...].parts[].text`;
 * a few hypothetical callers of `.response.text()` keep working too.
 */
export function withTextCompat(
  resp: GenerateContentResponse,
): GeminiCompatResponse {
  // Read the getter ONCE (it concatenates the first candidate's text parts).
  const value = resp.text;

  // `text` is a getter on the prototype with NO setter, so `resp.text = …`
  // would throw. Define an OWN data property that SHADOWS the prototype
  // getter. The value is a callable hybrid: invoking it (`resp.text()`)
  // returns the string (old-SDK method form), while `valueOf`/`toString`
  // make it coerce to the string in any property/template context.
  const hybrid = (() => value) as (() => string | undefined) & {
    valueOf?: () => string;
    toString?: () => string;
  };
  hybrid.valueOf = () => value ?? "";
  hybrid.toString = () => value ?? "";

  Object.defineProperty(resp, "text", {
    value: hybrid,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return resp as unknown as GeminiCompatResponse;
}

/**
 * Build a model-compat handle bound to one genai host + options. Exported for
 * unit testing the OLD-shape mapping with a hand-rolled `GenAiHost` fake.
 */
export function createGeminiModel(
  ai: GenAiHost,
  opts: GeminiGetModelOptions,
): GeminiGenerativeModel {
  const config = toConfig(opts);

  return {
    async generateContent(req) {
      const response = await ai.models.generateContent({
        model: opts.model,
        contents: toContents(req),
        config,
      });
      return { response: withTextCompat(response) };
    },

    async generateContentStream(req) {
      const generator = await ai.models.generateContentStream({
        model: opts.model,
        contents: toContents(req),
        config,
      });

      // Aggregate chunks into a single final response (old-SDK `response`
      // promise) while ALSO yielding each chunk through `stream`. We tee the
      // generator: a buffer collects every chunk, the consumer pulls from it.
      const chunks: GenerateContentResponse[] = [];
      let resolveFinal: (v: GeminiCompatResponse) => void;
      let rejectFinal: (e: unknown) => void;
      const finalPromise = new Promise<GeminiCompatResponse>(
        (resolve, reject) => {
          resolveFinal = resolve;
          rejectFinal = reject;
        },
      );

      async function* tee(): AsyncGenerator<
        GenerateContentResponse,
        void,
        unknown
      > {
        try {
          for await (const chunk of generator) {
            chunks.push(chunk);
            yield chunk;
          }
          resolveFinal(withTextCompat(aggregateStreamChunks(chunks)));
        } catch (err) {
          rejectFinal(err);
          throw err;
        }
      }

      // Swallow unhandled rejection if the caller ignores `response` but the
      // stream errors — the stream consumer still sees the throw.
      finalPromise.catch(() => {});

      return { stream: tee(), response: finalPromise };
    },
  };
}

/**
 * Aggregate streamed chunks into a single response: concatenate the text parts
 * of the first candidate across chunks, and keep the LAST chunk's metadata
 * (finishReason / usageMetadata / groundingMetadata land on the final chunk).
 */
export function aggregateStreamChunks(
  chunks: GenerateContentResponse[],
): GenerateContentResponse {
  if (chunks.length === 0) {
    return { candidates: [] } as unknown as GenerateContentResponse;
  }
  const last = chunks[chunks.length - 1]!;
  const fullText = chunks
    .map((c) => {
      const parts = c.candidates?.[0]?.content?.parts ?? [];
      return parts.map((p) => (p.text ? p.text : "")).join("");
    })
    .join("");

  const merged = { ...last } as GenerateContentResponse;
  const lastCandidate = last.candidates?.[0];
  merged.candidates = [
    {
      ...(lastCandidate ?? {}),
      content: {
        role: lastCandidate?.content?.role ?? "model",
        parts: [{ text: fullText }],
      },
    },
  ];
  return merged;
}

/**
 * Get or initialize the (compat) Vertex AI client for a location.
 *
 * Environment variables required:
 * - GCP_PROJECT_ID: Google Cloud project ID
 * - GCP_LOCATION: Google Cloud region (default: us-central1)
 *
 * For authentication, use ONE of the following:
 * - GCP_SERVICE_ACCOUNT_KEY_BASE64: Base64-encoded service account JSON (recommended for Vercel)
 * - GOOGLE_APPLICATION_CREDENTIALS: Path to service account JSON key (for local development)
 *
 * @param location - Optional Vertex location override (e.g. "global" for the
 *                    Gemini 3.x family). Defaults to GCP_LOCATION.
 * @returns GeminiClient compat instance
 * @throws Error if GCP_PROJECT_ID is not set
 */
export function getVertexAIClient(location?: string): GeminiClient {
  // MONEY-650: the Gemini DEVELOPER API (api key) is now the PRIMARY backend.
  // Vertex AI is being sunset, and the 3.x family (gemini-3.1-pro-preview,
  // gemini-3.5-flash, gemini-3-flash-preview) is served on the Developer API,
  // NOT on Vertex (where they 404). When GOOGLE_GENAI_API_KEY is set we use it
  // (the key is bound to the gemini-stockbook-qa SA, so it bills to the
  // project); otherwise we fall back to the legacy Vertex path so any env that
  // is mid-migration keeps working. `location` has no meaning on the Developer
  // API (no regions / no global-endpoint split), so it is ignored there.
  const apiKey = process.env.GOOGLE_GENAI_API_KEY;
  const projectId = process.env.GCP_PROJECT_ID;
  const loc = location || defaultLocation();
  const cacheKey = apiKey ? "genai-developer-api" : `vertex:${loc}`;

  let ai = clientCache.get(cacheKey);
  if (!ai) {
    try {
      if (apiKey) {
        // ── Primary: Gemini Developer API (api key bound to the SA) ──
        ai = new GoogleGenAI({ apiKey });
        logger.info(
          { backend: "gemini-developer-api" },
          "Gemini client initialized (Developer API, api key)",
        );
      } else {
        // ── Fallback: Vertex AI ──
        // Credentials come from the shared resolver (MONEY-780): SA-key var,
        // key-file path, or ADC. Pass `googleAuthOptions` only when explicit
        // creds were resolved; otherwise let genai use ADC unchanged.
        if (!projectId) {
          throw new Error(
            "GCP_PROJECT_ID is required for the Vertex fallback (set GOOGLE_GENAI_API_KEY to use the Developer API).",
          );
        }
        const creds = googleCredentials();
        const hasExplicitCreds = !!creds.credentials || !!creds.keyFilename;

        ai = new GoogleGenAI({
          vertexai: true,
          project: projectId,
          location: loc,
          ...(hasExplicitCreds ? { googleAuthOptions: creds } : {}),
        });

        logger.info(
          {
            projectId,
            location: loc,
            authMethod: creds.credentials
              ? "service_account_credentials"
              : creds.keyFilename
                ? "file_path"
                : "adc",
            backend: "vertex",
          },
          "Vertex AI (genai) client initialized (fallback)",
        );
      }
    } catch (error) {
      logger.error(
        { error, hasApiKey: !!apiKey, projectId, location: loc },
        "Failed to initialize Gemini client",
      );
      throw new Error(
        `Failed to initialize Gemini client: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
    clientCache.set(cacheKey, ai);
  }

  const bound = ai;
  return {
    getGenerativeModel(opts: GeminiGetModelOptions): GeminiGenerativeModel {
      return createGeminiModel(bound, opts);
    },
  };
}

/**
 * Wrapper function for Vertex AI operations with error handling
 *
 * This function provides a consistent error handling pattern for all Vertex AI operations.
 * It catches errors, logs them, and returns a Result object.
 *
 * @param operation - Async function that performs a Vertex AI operation
 * @returns Result object with success/failure status
 *
 * @example
 * ```typescript
 * const result = await withVertexAI(async (client) => {
 *   const model = client.getGenerativeModel({ model: "gemini-2.5-flash" });
 *   return await model.generateContent("Hello");
 * });
 * if (result.success) {
 *   console.log(result.data);
 * }
 * ```
 */
export async function withVertexAI<T>(
  operation: (client: GeminiClient) => Promise<T>,
): Promise<GeminiResult<T>> {
  try {
    const client = getVertexAIClient();
    const data = await operation(client);
    return { success: true, data };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    logger.error(
      {
        error,
        errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
      "Vertex AI operation failed",
    );

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Check if Gemini integration is enabled
 *
 * This allows for easy toggling between real Gemini responses and mock responses
 * during development or when Gemini is unavailable.
 *
 * @returns true if USE_GEMINI environment variable is set to 'true'
 */
export function isGeminiEnabled(): boolean {
  return process.env.USE_GEMINI === "true";
}

/**
 * Test Vertex AI connection
 *
 * Useful for health checks and verifying that the Vertex AI client is properly configured.
 *
 * @returns Result indicating success or failure of connection test
 */
export async function testVertexAIConnection(): Promise<GeminiResult<boolean>> {
  try {
    const client = getVertexAIClient();

    // Try to get a model to verify the connection works
    client.getGenerativeModel({ model: "gemini-2.5-flash" });

    // If we can get the model, the connection is working
    logger.info("Vertex AI connection test successful");
    return { success: true, data: true };
  } catch (error) {
    logger.error({ error }, "Vertex AI connection test failed");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Connection test failed",
    };
  }
}

/**
 * Reset the Vertex AI client cache (useful for testing)
 */
export function resetVertexAIClient(): void {
  clientCache.clear();
}
