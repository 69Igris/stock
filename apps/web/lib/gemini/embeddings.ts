/**
 * Gemini Embeddings Module
 *
 * Generates vector embeddings for RAG using Vertex AI's text-embedding model.
 * Used to index user documents (holdings, trades, scenarios) for semantic search.
 */

import { geminiLogger as logger } from "@usemoney/logger";
import {
  getEmbeddingModel,
  buildEmbeddingRequestBody,
  type EmbeddingTaskType,
} from "@usemoney/core/embeddings";
import { googleCredentials } from "@usemoney/core/gemini/credentials";

// ============== CONFIGURATION ==============

// MONEY-619 Phase 5: model is now env-gated via getEmbeddingModel()
// (text-embedding-004 by default → gemini-embedding-001 when
// USE_GEMINI_EMBEDDING_001=true). Both emit 768-dim vectors so the existing
// DocumentEmbedding Atlas index is preserved. The pure model + request-body
// helpers live in @usemoney/core/embeddings (single source of truth).
const EMBEDDING_DIMENSIONS = 768; // 768-dim vectors for the Atlas index
const MAX_TOKENS_PER_REQUEST = 2048; // Safe limit for embedding requests
const CHARS_PER_TOKEN = 4; // Rough estimate: 1 token ≈ 4 chars

// ============== TYPES ==============

export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface BatchEmbeddingResult {
  embeddings: number[][];
  tokenCounts: number[];
  failedIndices: number[];
}

export interface ChunkedText {
  text: string;
  chunkIndex: number;
  originalLength: number;
}

// ============== CORE FUNCTIONS ==============

/**
 * Generate embedding for a single text
 *
 * @param text - Text to embed (will be truncated if too long)
 * @returns Embedding vector and token count
 */
export async function generateEmbedding(
  text: string,
  taskType: EmbeddingTaskType = "RETRIEVAL_DOCUMENT"
): Promise<EmbeddingResult> {
  try {
    // Truncate if too long
    const truncatedText = truncateToTokenLimit(text);

    // Get embedding from Vertex AI's embedding model endpoint
    const embedding = await getEmbeddingFromVertexAI(truncatedText, taskType);

    if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Invalid embedding dimensions: expected ${EMBEDDING_DIMENSIONS}, got ${embedding?.length}`
      );
    }

    const tokenCount = estimateTokenCount(truncatedText);

    logger.debug(
      { textLength: text.length, tokenCount, dimensions: embedding.length },
      "Generated embedding"
    );

    return {
      embedding,
      tokenCount,
    };
  } catch (error) {
    logger.error(
      { error, textLength: text.length },
      "Failed to generate embedding"
    );
    throw error;
  }
}

/**
 * Get embedding from Vertex AI using REST API
 * Since the Vertex AI SDK doesn't have a direct embedding method,
 * we call the embedding endpoint directly.
 */
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

  // Get access token from credentials
  const { GoogleAuth } = await import("google-auth-library");

  // Resolve credentials via the shared resolver (MONEY-780): SA-key var on
  // Vercel, key-file path locally, or ADC on GCE/Cloud Run. The spread covers
  // `credentials` / `keyFilename`; `{}` = ADC, unchanged behaviour.
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

/**
 * Generate embeddings for multiple texts in batch
 *
 * @param texts - Array of texts to embed
 * @returns Array of embeddings with same indices as input
 */
export async function generateBatchEmbeddings(
  texts: string[]
): Promise<BatchEmbeddingResult> {
  const embeddings: number[][] = [];
  const tokenCounts: number[] = [];
  const failedIndices: number[] = [];

  // Process in parallel with concurrency limit
  const BATCH_SIZE = 10;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(async (text, batchIndex) => {
      const globalIndex = i + batchIndex;
      try {
        const result = await generateEmbedding(text);
        return { success: true, result, index: globalIndex };
      } catch (error) {
        logger.warn(
          { error, index: globalIndex },
          "Failed to generate embedding for batch item"
        );
        return { success: false, result: null, index: globalIndex };
      }
    });

    const batchResults = await Promise.all(batchPromises);

    for (const item of batchResults) {
      if (item.success && item.result) {
        embeddings[item.index] = item.result.embedding;
        tokenCounts[item.index] = item.result.tokenCount;
      } else {
        failedIndices.push(item.index);
        // Insert placeholder for failed embedding
        embeddings[item.index] = new Array(EMBEDDING_DIMENSIONS).fill(0);
        tokenCounts[item.index] = 0;
      }
    }
  }

  logger.info(
    {
      total: texts.length,
      successful: texts.length - failedIndices.length,
      failed: failedIndices.length,
    },
    "Batch embedding generation complete"
  );

  return {
    embeddings,
    tokenCounts,
    failedIndices,
  };
}

// ============== TEXT CHUNKING ==============

/**
 * Split long text into chunks suitable for embedding
 *
 * @param text - Text to chunk
 * @param maxChunkTokens - Maximum tokens per chunk (default: 512)
 * @param overlap - Overlap between chunks in tokens (default: 50)
 * @returns Array of text chunks with metadata
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

    // Move start forward by (chunk size − overlap). Guard against a
    // non-advancing / backward start: when overlap ≥ the consumed span the
    // naive `end - overlapChars` can be ≤ start, which would loop forever
    // (e.g. chunkText(text, 100, 60)). Fall back to `end` so progress is
    // always made.
    const nextStart = end - overlapChars;
    start = nextStart > start ? nextStart : end;
    if (start >= text.length) break;
    chunkIndex++;
  }

  logger.debug(
    { originalLength: text.length, chunks: chunks.length },
    "Text chunked for embedding"
  );

  return chunks;
}

// ============== DOCUMENT FORMATTERS ==============

/**
 * Format holdings data for embedding
 */
export function formatHoldingsForEmbedding(
  holdings: {
    symbol: string;
    name?: string;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    pnlPercentage: number;
    sector?: string;
    broker?: string;
  }[]
): string {
  if (holdings.length === 0) return "";

  const lines = ["Portfolio Holdings Summary:"];

  // Group by sector if available
  const bySector: Record<string, typeof holdings> = {};
  for (const h of holdings) {
    const sector = h.sector || "Other";
    if (!bySector[sector]) bySector[sector] = [];
    bySector[sector].push(h);
  }

  for (const [sector, stocks] of Object.entries(bySector)) {
    lines.push(`\n${sector}:`);
    for (const s of stocks) {
      const pnlStr =
        s.pnlPercentage >= 0
          ? `+${s.pnlPercentage.toFixed(1)}%`
          : `${s.pnlPercentage.toFixed(1)}%`;
      lines.push(
        `- ${s.symbol}${s.name ? ` (${s.name})` : ""}: ${s.quantity} shares @ avg ${s.averagePrice.toFixed(2)}, current ${s.currentPrice.toFixed(2)}, ${pnlStr}`
      );
    }
  }

  // Add summary stats
  const totalValue = holdings.reduce(
    (sum, h) => sum + h.quantity * h.currentPrice,
    0
  );
  const totalInvested = holdings.reduce(
    (sum, h) => sum + h.quantity * h.averagePrice,
    0
  );
  const totalPnl = totalValue - totalInvested;
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  lines.push(`\nTotal Portfolio Value: ${totalValue.toFixed(2)}`);
  lines.push(`Total Invested: ${totalInvested.toFixed(2)}`);
  lines.push(
    `Overall P&L: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(1)}%)`
  );

  return lines.join("\n");
}

/**
 * Format trades data for embedding
 */
export function formatTradesForEmbedding(
  trades: {
    symbol: string;
    tradeType: string;
    quantity: number;
    price: number;
    tradeDate: Date;
    realizedPnL?: number;
    broker?: string;
  }[]
): string {
  if (trades.length === 0) return "";

  const lines = ["Recent Trading Activity:"];

  // Sort by date descending
  const sorted = [...trades].sort(
    (a, b) => b.tradeDate.getTime() - a.tradeDate.getTime()
  );

  // Group by symbol
  const bySymbol: Record<string, typeof trades> = {};
  for (const t of sorted) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }

  for (const [symbol, symbolTrades] of Object.entries(bySymbol)) {
    const buys = symbolTrades.filter((t) => t.tradeType === "BUY");
    const sells = symbolTrades.filter((t) => t.tradeType === "SELL");
    const totalPnl = symbolTrades.reduce(
      (sum, t) => sum + (t.realizedPnL || 0),
      0
    );

    lines.push(
      `\n${symbol}: ${buys.length} buys, ${sells.length} sells, realized P&L: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`
    );

    // Show recent trades
    for (const t of symbolTrades.slice(0, 5)) {
      const dateStr = t.tradeDate.toISOString().split("T")[0];
      lines.push(
        `  - ${dateStr}: ${t.tradeType} ${t.quantity} @ ${t.price.toFixed(2)}`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Format FIRE scenario for embedding
 */
export function formatFireScenarioForEmbedding(scenario: {
  name: string;
  description?: string;
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  currentCorpus: number;
  monthlySavings: number;
  withdrawalRate: number;
  fireNumber?: number;
  yearsToFire?: number;
}): string {
  const lines = [`FIRE Scenario: ${scenario.name}`];

  if (scenario.description) {
    lines.push(`Description: ${scenario.description}`);
  }

  lines.push(`\nPersonal Details:`);
  lines.push(`- Current Age: ${scenario.currentAge}`);
  lines.push(`- Target Retirement Age: ${scenario.retirementAge}`);
  lines.push(`- Life Expectancy: ${scenario.lifeExpectancy}`);

  lines.push(`\nFinancial Details:`);
  lines.push(`- Current Corpus: ${scenario.currentCorpus.toLocaleString()}`);
  lines.push(`- Monthly Savings: ${scenario.monthlySavings.toLocaleString()}`);
  lines.push(`- Safe Withdrawal Rate: ${scenario.withdrawalRate}%`);

  if (scenario.fireNumber) {
    lines.push(`\nCalculated Values:`);
    lines.push(`- FIRE Number: ${scenario.fireNumber.toLocaleString()}`);
    if (scenario.yearsToFire !== undefined) {
      lines.push(`- Years to FIRE: ${scenario.yearsToFire}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format analysis report for embedding
 */
export function formatAnalysisForEmbedding(analysis: {
  symbol: string;
  name?: string;
  recommendation: string;
  confidence?: number;
  targetPrice?: number;
  stopLoss?: number;
  strengths?: string[];
  weaknesses?: string[];
  commentary?: string;
}): string {
  const lines = [`Stock Analysis: ${analysis.symbol}`];

  if (analysis.name) {
    lines.push(`Company: ${analysis.name}`);
  }

  lines.push(`\nRecommendation: ${analysis.recommendation}`);

  if (analysis.confidence) {
    lines.push(`Confidence: ${analysis.confidence}%`);
  }

  if (analysis.targetPrice) {
    lines.push(`Target Price: ${analysis.targetPrice}`);
  }

  if (analysis.stopLoss) {
    lines.push(`Stop Loss: ${analysis.stopLoss}`);
  }

  if (analysis.strengths && analysis.strengths.length > 0) {
    lines.push(`\nStrengths:`);
    for (const s of analysis.strengths) {
      lines.push(`- ${s}`);
    }
  }

  if (analysis.weaknesses && analysis.weaknesses.length > 0) {
    lines.push(`\nWeaknesses:`);
    for (const w of analysis.weaknesses) {
      lines.push(`- ${w}`);
    }
  }

  if (analysis.commentary) {
    lines.push(`\nCommentary: ${analysis.commentary}`);
  }

  return lines.join("\n");
}

// ============== UTILITIES ==============

/**
 * Estimate token count for text
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Truncate text to fit within token limit.
 * Exported (used by generateEmbedding) for unit testing; `maxTokens` defaults
 * to MAX_TOKENS_PER_REQUEST so existing single-arg callers are unaffected.
 */
export function truncateToTokenLimit(
  text: string,
  maxTokens: number = MAX_TOKENS_PER_REQUEST
): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;

  // Try to truncate at sentence boundary
  const truncated = text.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf(".");

  if (lastPeriod > maxChars * 0.8) {
    return truncated.slice(0, lastPeriod + 1);
  }

  return truncated;
}

/**
 * Compute cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have same length");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Get embedding model info
 */
export function getEmbeddingModelInfo() {
  return {
    model: getEmbeddingModel(),
    dimensions: EMBEDDING_DIMENSIONS,
    maxTokens: MAX_TOKENS_PER_REQUEST,
  };
}
