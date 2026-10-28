/**
 * Embeddings Utility for Workers
 *
 * Generates vector embeddings via Vertex AI REST API.
 * Ported from apps/web/lib/gemini/embeddings.ts for use in
 * the Cloud Run workers environment.
 */

import { GoogleAuth } from "google-auth-library";
import {
  getEmbeddingModel,
  buildEmbeddingRequestBody,
  type EmbeddingTaskType,
} from "@usemoney/core/embeddings";
import { googleCredentials } from "@usemoney/core/gemini/credentials";

// MONEY-619 Phase 5: model is env-gated via getEmbeddingModel()
// (text-embedding-004 by default → gemini-embedding-001 when
// USE_GEMINI_EMBEDDING_001=true). Both emit 768-dim vectors so the existing
// DocumentEmbedding Atlas index is preserved.
//
// !! RE-EMBED CUTOVER !!  Flipping USE_GEMINI_EMBEDDING_001=true REQUIRES a
// full re-embed backfill of every DocumentEmbedding row (run
// stock-document-embed with forceReindex + re-index user/document corpora).
// 004 and 001 vectors MUST NOT coexist in one Atlas vector index — they are
// different embedding spaces, so mixing them breaks cosine similarity. This is
// an ops cutover; do not flip the flag and the backfill independently.
const EMBEDDING_DIMENSIONS = 768;
const MAX_TOKENS_PER_REQUEST = 2048;
const CHARS_PER_TOKEN = 4;

export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface ChunkedText {
  text: string;
  chunkIndex: number;
  originalLength: number;
}

// ============== Core Functions ==============

/**
 * Generate embedding for a single text via Vertex AI
 */
export async function generateEmbedding(
  text: string,
  taskType: EmbeddingTaskType = "RETRIEVAL_DOCUMENT"
): Promise<EmbeddingResult> {
  const truncatedText = truncateToTokenLimit(text);
  const embedding = await getEmbeddingFromVertexAI(truncatedText, taskType);

  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Invalid embedding dimensions: expected ${EMBEDDING_DIMENSIONS}, got ${embedding?.length}`
    );
  }

  return {
    embedding,
    tokenCount: estimateTokenCount(truncatedText),
  };
}

/**
 * Generate embeddings for multiple texts in batch
 */
export async function generateBatchEmbeddings(
  texts: string[],
  taskType: EmbeddingTaskType = "RETRIEVAL_DOCUMENT"
): Promise<{ embeddings: number[][]; failedIndices: number[] }> {
  const embeddings: number[][] = [];
  const failedIndices: number[] = [];

  // Process in batches of 5 to avoid rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((t) => generateEmbedding(t, taskType))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result && result.status === "fulfilled") {
        embeddings.push(result.value.embedding);
      } else {
        embeddings.push([]);
        failedIndices.push(i + j);
      }
    }
  }

  return { embeddings, failedIndices };
}

// ============== Text Chunking ==============

/**
 * Split text into overlapping chunks for embedding.
 * Uses sentence-boundary breaking with configurable overlap.
 */
export function chunkText(
  text: string,
  maxChunkTokens: number = 512,
  overlap: number = 50
): ChunkedText[] {
  const maxChunkChars = maxChunkTokens * CHARS_PER_TOKEN;
  const overlapChars = overlap * CHARS_PER_TOKEN;

  if (text.length <= maxChunkChars) {
    return [{ text, chunkIndex: 0, originalLength: text.length }];
  }

  const chunks: ChunkedText[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChunkChars, text.length);

    // Try to break at sentence boundary
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf(".", end);
      const lastNewline = text.lastIndexOf("\n", end);
      const breakPoint = Math.max(lastPeriod, lastNewline);

      if (breakPoint > start + maxChunkChars / 2) {
        end = breakPoint + 1;
      }
    }

    chunks.push({
      text: text.slice(start, end).trim(),
      chunkIndex,
      originalLength: text.length,
    });

    // We just consumed through the end of the text — nothing remains to chunk.
    // (Without this, the final window pins `end` at text.length while
    // `start = end - overlapChars` stays below it, and the loop spins forever
    // on any text whose tail has no sentence boundary, e.g. a CSV/base64 wall
    // or a long unbroken token. Hit by the production `chunkText(t, 512, 50)`
    // call when the last ~200 chars contain no "." or "\n".)
    if (end >= text.length) break;

    // Advance with overlap, but GUARANTEE forward progress: if the overlap is
    // wide enough to push `start` at or before where we began (e.g.
    // overlap >= chunk size), fall back to `end` so the window always moves.
    const nextStart = end - overlapChars;
    start = nextStart > start ? nextStart : end;
    chunkIndex++;
  }

  return chunks;
}

// ============== Internal Helpers ==============

async function getEmbeddingFromVertexAI(
  text: string,
  taskType: EmbeddingTaskType = "RETRIEVAL_DOCUMENT"
): Promise<number[]> {
  const projectId = process.env.GCP_PROJECT_ID;
  const location = process.env.GCP_LOCATION || "us-central1";

  if (!projectId) {
    throw new Error("GCP_PROJECT_ID environment variable is required");
  }

  const model = getEmbeddingModel();

  // Resolve credentials via the shared resolver (MONEY-780): SA-key var, key-file
  // path, or ADC on Cloud Run. The spread covers `credentials` / `keyFilename`;
  // `{}` = ADC, unchanged behaviour.
  const authOptions: ConstructorParameters<typeof GoogleAuth>[0] = {
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    ...googleCredentials(),
  };

  const auth = new GoogleAuth(authOptions);
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();

  if (!accessToken.token) {
    throw new Error("Failed to get access token for Vertex AI");
  }

  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildEmbeddingRequestBody(text, model, taskType)),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Vertex AI embedding request failed: ${response.status} - ${errorText}`
    );
  }

  const data = await response.json();
  const embedding = data.predictions?.[0]?.embeddings?.values;

  if (!embedding) {
    throw new Error("No embedding returned from Vertex AI");
  }

  return embedding;
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateToTokenLimit(text: string): string {
  const maxChars = MAX_TOKENS_PER_REQUEST * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}
