/**
 * Gemini LLM Integration - Vertex AI Client (compat adapter over @google/genai)
 *
 * MONEY-619 (Phase 4): mirrors `packages/core/src/gemini/client.ts`. The
 * deprecated `@google-cloud/vertexai` SDK is replaced by `@google/genai`, but
 * the OLD result shape (`result.response.candidates[0].content.parts[].text`,
 * `result.stream`, `candidate.groundingMetadata`) is preserved by a thin
 * COMPAT layer so the web call sites (grounding, guardrails, conversation,
 * intent-mapper, models.ts streaming) keep working unchanged.
 *
 * See the core client for the full rationale; this is the apps/web copy that
 * uses the local `Result<T>` type instead of `@usemoney/types`.
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
import type { Result } from "./types";
// Pure helpers — SINGLE SOURCE OF TRUTH (no shadows). getVertexAIClient + the
// location default CALL these so tests run the same code.
import {
  resolveGeminiLocation,
  validateProjectId,
  decodeBase64Credentials,
  determineAuthMethod,
  formatInitError,
} from "./client-logic";

/** The OLD-SDK-shaped `generationConfig` accepted by `getGenerativeModel`. */
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
 * exposed `response.text()` as a METHOD. We widen `text` to "string getter OR
 * callable" so BOTH patterns type-check and work (see `withTextCompat`).
 */
export type GeminiCompatResponse = Omit<GenerateContentResponse, "text"> & {
  text: (string & (() => string | undefined)) | undefined;
};

/** Compat result of `generateContent` — old-SDK `{ response }` shape. */
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
    req: GeminiGenerateContentRequest
  ): Promise<GeminiGenerateContentResult>;
  generateContentStream(
    req: GeminiGenerateContentRequest
  ): Promise<GeminiGenerateContentStreamResult>;
}

/** The top-level client (compat over `GoogleGenAI`). */
export interface GeminiClient {
  getGenerativeModel(opts: GeminiGetModelOptions): GeminiGenerativeModel;
}

/** Per-location cache of `GoogleGenAI` instances (e.g. global vs regional). */
const clientCache = new Map<string, GoogleGenAI>();

function defaultLocation(): string {
  return resolveGeminiLocation(process.env.GCP_LOCATION);
}

function toContents(req: GeminiGenerateContentRequest): ContentListUnion {
  if (typeof req === "string") {
    return [{ role: "user", parts: [{ text: req }] }];
  }
  return req.contents;
}

function toConfig(
  opts: GeminiGetModelOptions
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
 * Shadow the prototype `text` getter with an OWN callable hybrid so both
 * `resp.text` (coerces to the string) and `resp.text()` (old-SDK method form)
 * work. `resp.text = …` would throw (getter, no setter), hence defineProperty.
 */
function withTextCompat(resp: GenerateContentResponse): GeminiCompatResponse {
  const value = resp.text;
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
 * Aggregate streamed chunks into one response (old-SDK `response` promise):
 * concatenate first-candidate text parts; keep the last chunk's metadata.
 */
function aggregate(chunks: GenerateContentResponse[]): GenerateContentResponse {
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

function makeModel(
  ai: GoogleGenAI,
  opts: GeminiGetModelOptions
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

      const chunks: GenerateContentResponse[] = [];
      let resolveFinal: (v: GeminiCompatResponse) => void;
      let rejectFinal: (e: unknown) => void;
      const finalPromise = new Promise<GeminiCompatResponse>(
        (resolve, reject) => {
          resolveFinal = resolve;
          rejectFinal = reject;
        }
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
          resolveFinal(withTextCompat(aggregate(chunks)));
        } catch (err) {
          rejectFinal(err);
          throw err;
        }
      }

      finalPromise.catch(() => {});

      return { stream: tee(), response: finalPromise };
    },
  };
}

/**
 * Get or initialize the (compat) Gemini client.
 *
 * MONEY-650: prefers the Gemini DEVELOPER API. If GOOGLE_GENAI_API_KEY is set
 * it is used (region-less, key bound to the gemini-stockbook-qa SA);
 * otherwise this falls back to Vertex AI, which needs GCP_PROJECT_ID +
 * GCP_LOCATION and ONE of:
 * - GCP_SERVICE_ACCOUNT_KEY_BASE64: Base64-encoded service account JSON (Vercel)
 * - GOOGLE_APPLICATION_CREDENTIALS: Path to a service account JSON key (local)
 *
 * The 3.x family (gemini-3.1-pro-preview / gemini-3.5-flash /
 * gemini-3-flash-preview) is served on the Developer API, NOT Vertex (where
 * the bare names 404), so a paid-tier chat that resolves a 3.x id REQUIRES
 * the api key path.
 *
 * @param location - Optional Vertex location override (ignored on the
 *   Developer API, which is region-less).
 * @returns GeminiClient compat instance
 * @throws Error on the Vertex fallback if GCP_PROJECT_ID is not set
 */
export function getVertexAIClient(location?: string): GeminiClient {
  const apiKey = process.env.GOOGLE_GENAI_API_KEY;
  const projectId = process.env.GCP_PROJECT_ID;
  const loc = location || defaultLocation();
  const base64Credentials = process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;
  const cacheKey = apiKey ? "genai-developer-api" : `vertex:${loc}`;

  // Auth strategy for the Vertex fallback (base64 wins over a file path, else
  // none) — shared with the client-logic tests.
  const authMethod = determineAuthMethod(
    base64Credentials,
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );

  let ai = clientCache.get(cacheKey);
  if (!ai) {
    try {
      if (apiKey) {
        // ── Primary: Gemini Developer API (api key bound to the SA) ──
        ai = new GoogleGenAI({ apiKey });

        logger.info(
          { backend: "gemini-developer-api" },
          "Gemini client initialized (Developer API, api key)"
        );
      } else if (authMethod === "base64_credentials") {
        // ── Fallback: Vertex AI with the base64 SA key ──
        if (!validateProjectId(projectId).valid) {
          throw new Error(
            "GCP_PROJECT_ID is required for the Vertex fallback (set GOOGLE_GENAI_API_KEY to use the Developer API)."
          );
        }
        const credentials = decodeBase64Credentials(base64Credentials!);
        const credentialsJSON = JSON.stringify(credentials);

        process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = credentialsJSON;

        ai = new GoogleGenAI({
          vertexai: true,
          project: projectId,
          location: loc,
          googleAuthOptions: {
            credentials,
          },
        });

        logger.info(
          { projectId, location: loc, authMethod, backend: "vertex" },
          "Vertex AI (genai) client initialized with base64 credentials (fallback)"
        );
      } else {
        // ── Fallback: Vertex AI with ADC (file path / default creds) ──
        if (!validateProjectId(projectId).valid) {
          throw new Error(
            "GCP_PROJECT_ID is required for the Vertex fallback (set GOOGLE_GENAI_API_KEY to use the Developer API)."
          );
        }
        ai = new GoogleGenAI({
          vertexai: true,
          project: projectId,
          location: loc,
        });

        logger.info(
          {
            projectId,
            location: loc,
            authMethod,
            backend: "vertex",
            credentialsPath:
              process.env.GOOGLE_APPLICATION_CREDENTIALS || "default",
          },
          "Vertex AI (genai) client initialized with credentials file (fallback)"
        );
      }
    } catch (error) {
      logger.error(
        { error, hasApiKey: !!apiKey, projectId, location: loc },
        "Failed to initialize Gemini client"
      );
      throw new Error(formatInitError(error));
    }
    clientCache.set(cacheKey, ai);
  }

  const bound = ai;
  return {
    getGenerativeModel(opts: GeminiGetModelOptions): GeminiGenerativeModel {
      return makeModel(bound, opts);
    },
  };
}

/**
 * Wrapper function for Vertex AI operations with error handling
 *
 * @param operation - Async function that performs a Vertex AI operation
 * @returns Result object with success/failure status
 */
export async function withVertexAI<T>(
  operation: (client: GeminiClient) => Promise<T>
): Promise<Result<T>> {
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
      "Vertex AI operation failed"
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
 * @returns true if USE_GEMINI environment variable is set to 'true'
 */
export function isGeminiEnabled(): boolean {
  return process.env.USE_GEMINI === "true";
}

/**
 * Test Vertex AI connection
 *
 * @returns Result indicating success or failure of connection test
 */
export async function testVertexAIConnection(): Promise<Result<boolean>> {
  try {
    const client = getVertexAIClient();

    // Try to get a model to verify the connection works
    client.getGenerativeModel({ model: "gemini-2.5-flash" });

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
