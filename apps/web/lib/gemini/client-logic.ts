/**
 * Pure helpers for the Vertex AI (Gemini) client (no `@google/genai`, no env
 * side effects at call time — args are passed in).
 *
 * `client.ts` CALLS these so the location default, project-id validation,
 * base64-credential decode, auth-method selection and init-error formatting are
 * defined once. Previously this logic was inlined (non-exported) in `client.ts`
 * and re-implemented a second time inside `__tests__/gemini/client.test.ts`
 * (a shadow).
 */

export interface ProjectIdValidation {
  valid: boolean;
  error?: string;
}

export type GeminiAuthMethod = "base64_credentials" | "file_path" | "none";

/** GCP location with the canonical default. Mirrors `GCP_LOCATION || default`. */
export function resolveGeminiLocation(
  gcpLocation: string | undefined,
  fallback = "us-central1"
): string {
  return gcpLocation || fallback;
}

/** Validate that a GCP project id is present (the guard in getVertexAIClient). */
export function validateProjectId(
  projectId: string | undefined
): ProjectIdValidation {
  if (!projectId) {
    return {
      valid: false,
      error: "GCP_PROJECT_ID environment variable is required.",
    };
  }
  return { valid: true };
}

/** Decode base64-encoded service-account JSON into an object (may throw). */
export function decodeBase64Credentials(
  base64: string
): Record<string, unknown> {
  const json = Buffer.from(base64, "base64").toString("utf-8");
  return JSON.parse(json);
}

/**
 * Pick the auth strategy from the available credentials: base64 wins over a file
 * path, else none. Mirrors the branching in getVertexAIClient.
 */
export function determineAuthMethod(
  base64Creds: string | undefined,
  filePath: string | undefined
): GeminiAuthMethod {
  if (base64Creds) return "base64_credentials";
  if (filePath) return "file_path";
  return "none";
}

/** Format an initialization error message (the catch block's wrap). */
export function formatInitError(error: unknown): string {
  return `Failed to initialize Vertex AI: ${
    error instanceof Error ? error.message : "Unknown error"
  }`;
}
