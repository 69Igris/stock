/**
 * Google Cloud credential resolver (MONEY-780).
 *
 * Resolves Google Cloud credentials in a way that works BOTH on Cloud Run (an
 * attached SA → Application Default Credentials, no key needed) and on Vercel /
 * serverless (no key file on disk → pass the SA JSON via an env var, raw or
 * base64). The resolution spreads directly into the constructor of the client
 * that consumes it.
 *
 * Current consumers (the call sites — see callers of `googleCredentials()`):
 *   - embeddings (`packages/core` + `apps/web` + `workers` embedding clients)
 *   - the `@google/genai` Vertex fallback in `gemini/client.ts`
 *     (`googleAuthOptions: googleCredentials()`)
 *   - the Vertex RAG backend (`rag/vertex-rag.ts`, `new GoogleAuth({ ... })`)
 *   - the GCS Storage clients (`packages/storage/src/index.ts` +
 *     `apps/web/lib/storage/gcp-client.ts`, `new Storage({ ...googleCredentials() })`)
 *   - the Pub/Sub client (`packages/pubsub/src/client.ts`,
 *     `new PubSub({ ...googleCredentials() })`)
 *   - the workers Document AI client (`workers/src/lib/docai.ts`,
 *     `new DocumentProcessorServiceClient({ ...googleCredentials() })`)
 *
 * MONEY-805 migrated the Storage / Pub/Sub / Document AI clients onto this
 * resolver: each spreads `...googleCredentials()` into its constructor and pins
 * the explicit `GCP_PROJECT_ID` last (the resolver's derived `projectId` never
 * overrides it). Behaviour is unchanged for production (base64 still wins); the
 * gain is dedup plus the GOOGLE_APPLICATION_CREDENTIALS_JSON fallback.
 *
 * Precedence (back-compat FIRST so production behaviour is unchanged):
 *   (1) `GCP_SERVICE_ACCOUNT_KEY_BASE64`        — base64 → JSON (the legacy var)
 *   (2) `GOOGLE_APPLICATION_CREDENTIALS_JSON`   — raw JSON or base64
 *   (3) `GOOGLE_APPLICATION_CREDENTIALS`        — key-file path → `{ keyFilename }`
 *   (4) `{}`                                    — ADC (e.g. the SA attached to Cloud Run)
 *
 * Never throws — a malformed JSON var warns ONCE PER VAR (MONEY-806: a second
 * bad source is no longer silenced) and falls through to the next option. If a
 * var was present-but-unparseable AND resolution still ended at ADC (`{}`),
 * `credentialsFellBackToAdcAfterMalformed()` returns true so serverless callers
 * can surface a clear error rather than an opaque downstream auth failure (the
 * spreadable resolution itself stays a clean `{}` — no diagnostic key leaks into
 * the client constructors it is spread into). The result is memoized for the
 * life of the process.
 */

/**
 * How a Google Cloud credential resolves, in a shape that spreads directly into
 * `new Storage({...})` / `new GoogleAuth({...})` and into `@google/genai`'s
 * `googleAuthOptions: {...}`.
 */
export interface GoogleCredentialResolution {
  /** Parsed service-account JSON (used on Vercel/serverless via an env var). */
  credentials?: Record<string, unknown>;
  /** Path to a key file (local dev / anywhere with a writable disk). */
  keyFilename?: string;
  /** Project id derived from the SA, when available. */
  projectId?: string;
}

let cached: GoogleCredentialResolution | null = null;

/**
 * MONEY-806 (2): set ONLY when a credential var was present but unparseable AND
 * resolution still fell all the way through to ADC (`{}`) — i.e. no later source
 * rescued it. Surfaced via {@link credentialsFellBackToAdcAfterMalformed} rather
 * than as a field on {@link GoogleCredentialResolution}, because the resolution
 * is spread straight into `new Storage({...})` / `new PubSub({...})` /
 * `googleAuthOptions: {...}` — a diagnostic key must NEVER leak into a client
 * constructor. Healthy resolutions leave it `false`.
 */
let adcAfterMalformedCreds = false;

/**
 * Names of credential vars seen present-but-unparseable this resolution. Drives
 * (a) warn-once PER VAR (so a second malformed source is never silenced), and
 * (b) the {@link adcAfterMalformedCreds} flag when resolution ends at ADC.
 */
const malformedVars = new Set<string>();

/**
 * Warn once PER credential var that it was present but unparseable. Unlike the
 * old single global latch, a second malformed var (e.g. both the base64 and the
 * JSON var are bad) still warns, so no bad source is silently swallowed.
 */
function warnMalformed(varName: string): void {
  if (malformedVars.has(varName)) return;
  malformedVars.add(varName);
  console.warn(
    `Google credentials: ${varName} is not valid JSON or base64-encoded JSON. Falling through to the next credential source.`,
  );
}

/** Parse a "raw JSON or base64" credential blob into a creds object, or null. */
function parseCredentialBlob(
  raw: string,
  varName: string,
): Record<string, unknown> | null {
  try {
    // Accept raw JSON or a single-line base64 blob (the Vercel-friendly form).
    const json = raw.trim().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    warnMalformed(varName);
    return null;
  }
}

/** Wrap parsed creds, deriving projectId from `project_id` when present. */
function fromCreds(creds: Record<string, unknown>): GoogleCredentialResolution {
  const projectId =
    typeof creds.project_id === "string" ? creds.project_id : undefined;
  return projectId ? { credentials: creds, projectId } : { credentials: creds };
}

/**
 * Resolve Google Cloud credentials following the documented precedence.
 *
 * Note on `projectId`: it is derived from the SA's `project_id` only as a
 * convenience. Call sites that already read an explicit `GCP_PROJECT_ID` MUST
 * keep using it and NOT override it with this value.
 */
export function googleCredentials(): GoogleCredentialResolution {
  if (cached) return cached;

  // (1) GCP_SERVICE_ACCOUNT_KEY_BASE64 — the legacy var, checked first so prod
  //     keeps its existing behaviour.
  const base64 = process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64?.trim();
  if (base64) {
    const creds = parseCredentialBlob(base64, "GCP_SERVICE_ACCOUNT_KEY_BASE64");
    if (creds) {
      cached = fromCreds(creds);
      return cached;
    }
  }

  // (2) GOOGLE_APPLICATION_CREDENTIALS_JSON — raw JSON or base64.
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim();
  if (json) {
    const creds = parseCredentialBlob(
      json,
      "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    );
    if (creds) {
      cached = fromCreds(creds);
      return cached;
    }
  }

  // (3) GOOGLE_APPLICATION_CREDENTIALS — key-file path.
  const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (keyFilename) {
    cached = { keyFilename };
    return cached;
  }

  // (4) ADC — e.g. the SA attached to a Cloud Run service.
  //
  // MONEY-806 (2): if we reached here only because a credential var was present
  // but unparseable (not because the env is genuinely creds-free), record it (in
  // a module flag, NOT on the spreadable resolution). On Cloud Run ADC resolves
  // the attached SA and this is harmless; on serverless (Vercel) ADC has no SA,
  // so downstream auth fails opaquely — the flag lets a call site raise a clear
  // "your credential var is malformed" error instead.
  if (malformedVars.size > 0) adcAfterMalformedCreds = true;
  cached = {};
  return cached;
}

/**
 * MONEY-806 (2): true when {@link googleCredentials} fell through to ADC ONLY
 * because a present credential var was unparseable (not because the env is
 * genuinely creds-free). Serverless (Vercel) callers — where ADC has no attached
 * SA — can check this to surface a clear "your credential var is malformed"
 * error instead of an opaque downstream auth failure. Call AFTER
 * `googleCredentials()` (it reflects the resolved/cached state).
 */
export function credentialsFellBackToAdcAfterMalformed(): boolean {
  return adcAfterMalformedCreds;
}

/** Test seam: clear the memoized resolution and the per-var warn latch. */
export function resetGoogleCredentials(): void {
  cached = null;
  adcAfterMalformedCreds = false;
  malformedVars.clear();
}
