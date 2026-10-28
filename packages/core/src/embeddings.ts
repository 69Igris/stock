/**
 * Shared query-embedding (MONEY-613 / 277).
 *
 * The web app + workers each had their own Vertex `text-embedding-004` embed
 * helper, but the research package had none — so true vector RAG was dead in
 * research (fetch_user_documents fell back to keyword scoring). This is the
 * SHARED query-embedding function research's vector-search tool needs.
 *
 * Embed-only (no chunking/formatters — those stay in the web/worker indexers).
 * Auth via google-auth-library (dynamic import, same as the web indexer) so the
 * dep only loads when an embedding is actually requested.
 */

export const EMBEDDING_DIMENSIONS = 768;
const MAX_EMBED_CHARS = 2048 * 4; // ~2048 tokens

/** Legacy default — kept for back-compat of `EMBEDDING_INFO` when the flag is off. */
const LEGACY_EMBEDDING_MODEL = "text-embedding-004";
/** New model the flag flips us onto (also 768-dim via outputDimensionality). */
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * The Vertex retrieval `task_type` for an embedding instance.
 * - RETRIEVAL_DOCUMENT: text being stored/indexed (the corpus side).
 * - RETRIEVAL_QUERY: a search query embedded to match against the corpus.
 * Both sides MUST use the same model/space; the task_type just tells the
 * model which optimization to apply. Only honored for gemini-embedding-001.
 */
export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/**
 * Env-gated embedding model (MONEY-619 Phase 5), mirroring the
 * `ENABLE_GEMINI_3X` safe-rollout pattern.
 *
 * Default (flag OFF) returns `text-embedding-004` so behavior is byte-for-byte
 * unchanged — the millions of already-stored vectors are 004, and an Atlas
 * vector index CANNOT mix embedding spaces (004 and 001 are different spaces
 * even at the same 768 dims). Flipping `USE_GEMINI_EMBEDDING_001=true` is a
 * COORDINATED cutover that MUST be paired with a full re-embed of every
 * `DocumentEmbedding` row (see the embed worker note). Do not flip it without
 * the backfill, or similarity search silently degrades.
 */
export function getEmbeddingModel(): string {
  return process.env.USE_GEMINI_EMBEDDING_001 === "true"
    ? GEMINI_EMBEDDING_MODEL
    : LEGACY_EMBEDDING_MODEL;
}

/**
 * Build the Vertex `:predict` request body for one embedding instance.
 *
 * PURE (no network/env) so it is unit-testable. The shape is model-dependent:
 * - `gemini-embedding-001`: adds per-instance `task_type` and a top-level
 *   `parameters.outputDimensionality: 768` (so the new model returns the same
 *   768 dims the existing Atlas index expects).
 * - `text-embedding-004`: EXACTLY the legacy body `{ instances: [{ content }] }`
 *   with NO parameters and NO task_type (byte-for-byte unchanged).
 */
export function buildEmbeddingRequestBody(
  content: string,
  model: string,
  taskType: EmbeddingTaskType = "RETRIEVAL_DOCUMENT",
): {
  instances: Array<{ content: string; task_type?: EmbeddingTaskType }>;
  parameters?: { outputDimensionality: number };
} {
  if (model === GEMINI_EMBEDDING_MODEL) {
    return {
      instances: [{ content, task_type: taskType }],
      parameters: { outputDimensionality: EMBEDDING_DIMENSIONS },
    };
  }
  // Legacy text-embedding-004: unchanged request.
  return { instances: [{ content }] };
}

/**
 * Generate a 768-dim embedding for `text` via Vertex AI. Throws on failure.
 *
 * Query-side helper: every caller here embeds a SEARCH query (vector-store
 * `searchSimilar` / `searchStockDocuments`, research `fetch-document-context`),
 * so the default `taskType` is RETRIEVAL_QUERY.
 */
export async function generateEmbedding(
  text: string,
  taskType: EmbeddingTaskType = "RETRIEVAL_QUERY",
): Promise<number[]> {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION || "us-central1";
  if (!projectId) {
    throw new Error("GCP_PROJECT_ID is required for embeddings");
  }

  const model = getEmbeddingModel();
  const truncated =
    text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;

  // Auth via the shared resolver (MONEY-780): SA-key var (Vercel), key-file
  // path, or ADC (GCE/local). The spread covers `credentials` / `keyFilename`;
  // `{}` = ADC, unchanged behaviour.
  const { GoogleAuth } = await import("google-auth-library");
  const { googleCredentials } = await import("./gemini/credentials");
  const authOptions: ConstructorParameters<typeof GoogleAuth>[0] = {
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    ...googleCredentials(),
  };
  const auth = new GoogleAuth(authOptions);
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  if (!accessToken.token) {
    throw new Error("Failed to obtain Vertex AI access token");
  }

  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildEmbeddingRequestBody(truncated, model, taskType)),
  });
  if (!response.ok) {
    throw new Error(
      `Vertex embedding failed: ${response.status} ${await response.text()}`,
    );
  }
  const data = (await response.json()) as {
    predictions?: Array<{ embeddings?: { values?: number[] } }>;
  };
  const embedding = data.predictions?.[0]?.embeddings?.values;
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Invalid embedding (expected ${EMBEDDING_DIMENSIONS} dims, got ${embedding?.length})`,
    );
  }
  return embedding;
}

/** Cosine similarity for the dev (non-Atlas) vector-search fallback. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const mag = Math.sqrt(na) * Math.sqrt(nb);
  return mag === 0 ? 0 : dot / mag;
}

export const EMBEDDING_INFO = {
  /** Resolves the live (env-gated) model; defaults to text-embedding-004. */
  get model(): string {
    return getEmbeddingModel();
  },
  dimensions: EMBEDDING_DIMENSIONS,
};
