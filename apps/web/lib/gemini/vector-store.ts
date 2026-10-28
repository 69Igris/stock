/**
 * Vector Store Module
 *
 * Handles vector search operations for RAG.
 * - Production (Atlas): Uses native MongoDB Vector Search for performance
 * - Local/QA (DigitalOcean): Uses application-level cosine similarity
 *
 * Set MONGODB_VECTOR_SEARCH_ENABLED=true in production (Atlas only)
 */

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { geminiLogger as logger } from "@usemoney/logger";
import { generateEmbedding } from "./embeddings";
import { getEmbeddingModel } from "@usemoney/core/embeddings";
import {
  buildVectorSearchStage,
  writeTargets,
} from "@usemoney/core/embeddings-int8-logic";
import { getEmbeddingsMode } from "@usemoney/core/embeddings-v2-mode";
import { findEmbeddingRows } from "@usemoney/core/embeddings-v2-read";
import {
  deleteEmbeddingsV2,
  oid,
  upsertEmbeddingsV2,
} from "@usemoney/core/embeddings-v2-write";
import {
  rankBySimilarity,
  buildEmbeddingUpsertKey,
} from "./vector-store-logic";

// ============== CONFIGURATION ==============

/**
 * MongoDB Vector Search availability
 * - Production (Atlas): Supports native $vectorSearch - set to true
 * - Local/QA (DigitalOcean): No vector search support - leave false/unset
 */
const MONGODB_VECTOR_SEARCH_ENABLED =
  process.env.MONGODB_VECTOR_SEARCH_ENABLED === "true";

/**
 * MONEY-1499: `document_embeddings_v2` stores its vector as BSON BinData
 * subtype 9, which Prisma's `Bytes` scalar cannot write or read — so every v2
 * write, delete and vector-bearing read goes through the raw command, exactly
 * as `$vectorSearch` already did.
 */
const rawCmd = (cmd: Record<string, unknown>) =>
  prisma.$runCommandRaw(cmd as never) as unknown as Promise<unknown>;

// ============== TYPES ==============

export type DocumentType =
  | "holdings"
  | "trades"
  | "fire_scenario"
  | "analysis"
  | "user_preferences"
  | "document"
  | "filing"
  | "news"
  // Financial document types (system-level, per-stock)
  | "financial_statement"
  | "corporate_filing"
  | "annual_report"
  | "quarterly_result"
  | "concall_transcript"
  | "concall_ppt"
  // MONEY-779: screener_financials is the richest embedded text (full Screener.in
  // financials scrape) and concall_ai_summary is the AI-summarised earnings call.
  // Both are written by the worker's stock-document-sync but were never declared
  // here, so chat RAG silently excluded them from the default search.
  | "concall_ai_summary"
  | "screener_financials";

export interface DocumentMetadata {
  symbol?: string;
  broker?: string;
  category?: string;
  scenarioName?: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface IndexedDocument {
  id: string;
  userId: string;
  docType: DocumentType;
  docId: string | null;
  content: string;
  chunkId: number;
  embedding: number[];
  metadata?: DocumentMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchResult {
  content: string;
  docType: DocumentType;
  docId: string | null;
  score: number;
  metadata?: DocumentMetadata;
}

export interface SearchOptions {
  topK?: number;
  docTypes?: DocumentType[];
  minScore?: number;
}

// ============== DOCUMENT OPERATIONS ==============

/**
 * Store a document embedding in the database
 *
 * @param userId - User ID
 * @param docType - Type of document
 * @param content - Text content that was embedded
 * @param embedding - Vector embedding
 * @param docId - Optional source document ID
 * @param chunkId - Chunk index for multi-chunk documents
 * @param metadata - Optional metadata
 */
export async function storeEmbedding(
  userId: string,
  docType: DocumentType,
  content: string,
  embedding: number[],
  docId: string | null = null,
  chunkId: number = 0,
  metadata?: DocumentMetadata
): Promise<void> {
  try {
    // MONEY-1499: `writeTargets` decides which collections receive this row.
    // Under `dual` BOTH do, so the backfill's cursor cannot leave a permanent
    // tail of rows written after it passed; under `on` only v2 does, which is
    // what stops a writer silently re-creating an empty `document_embeddings`
    // after v1 has been renamed away.
    const embeddingModel = getEmbeddingModel();
    const targets = writeTargets(await getEmbeddingsMode());

    if (targets.includes("v1")) {
      await prisma.documentEmbedding.upsert({
        where: {
          userId_docType_docId_chunkId: buildEmbeddingUpsertKey(
            userId,
            docType,
            docId,
            chunkId
          ),
        },
        update: {
          content,
          embedding,
          embeddingModel,
          metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
          updatedAt: new Date(),
        },
        create: {
          userId,
          docType,
          docId,
          content,
          chunkId,
          embedding,
          embeddingModel,
          metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
        },
      });
    }

    if (targets.includes("v2")) {
      const { refused } = await upsertEmbeddingsV2(rawCmd, [
        {
          userId,
          docType,
          docId,
          chunkId,
          content,
          embedding,
          embeddingModel,
          metadata,
        },
      ]);
      // A refusal is NAMED and logged rather than swallowed — a vector that
      // will not quantize is a row the corpus silently loses.
      if (refused.length > 0) {
        logger.error(
          { userId, docType, docId, chunkId, refused },
          "v2 embedding refused"
        );
      }
    }

    logger.debug(
      { userId, docType, docId, chunkId },
      "Stored document embedding"
    );
  } catch (error) {
    logger.error(
      { error, userId, docType, docId },
      "Failed to store document embedding"
    );
    throw error;
  }
}

/**
 * Store multiple document embeddings in batch
 */
export async function storeBatchEmbeddings(
  documents: {
    userId: string;
    docType: DocumentType;
    content: string;
    embedding: number[];
    docId?: string;
    chunkId?: number;
    metadata?: DocumentMetadata;
  }[]
): Promise<number> {
  try {
    // Tag rows with the model that produced them (env-gated).
    const embeddingModel = getEmbeddingModel();
    const targets = writeTargets(await getEmbeddingsMode()); // MONEY-1499

    if (targets.includes("v2")) {
      const { refused } = await upsertEmbeddingsV2(
        rawCmd,
        documents.map((doc) => ({
          userId: doc.userId,
          docType: doc.docType,
          docId: doc.docId ?? null,
          chunkId: doc.chunkId || 0,
          content: doc.content,
          embedding: doc.embedding,
          embeddingModel,
          metadata: doc.metadata,
        }))
      );
      if (refused.length > 0) {
        logger.error({ refused }, "v2 embeddings refused in batch");
      }
      if (!targets.includes("v1")) return documents.length - refused.length;
    }

    // Use createMany for efficiency (doesn't return created documents)
    // Since we need upsert behavior, we'll use transactions
    const results = await prisma.$transaction(
      documents.map((doc) =>
        prisma.documentEmbedding.upsert({
          where: {
            userId_docType_docId_chunkId: buildEmbeddingUpsertKey(
              doc.userId,
              doc.docType,
              doc.docId ?? null,
              doc.chunkId || 0
            ),
          },
          update: {
            content: doc.content,
            embedding: doc.embedding,
            embeddingModel,
            metadata: doc.metadata
              ? (doc.metadata as Prisma.InputJsonValue)
              : undefined,
            updatedAt: new Date(),
          },
          create: {
            userId: doc.userId,
            docType: doc.docType,
            docId: doc.docId || null,
            content: doc.content,
            chunkId: doc.chunkId || 0,
            embedding: doc.embedding,
            embeddingModel,
            metadata: doc.metadata
              ? (doc.metadata as Prisma.InputJsonValue)
              : undefined,
          },
        })
      )
    );

    logger.info({ count: results.length }, "Batch stored document embeddings");

    return results.length;
  } catch (error) {
    logger.error(
      { error, count: documents.length },
      "Failed to batch store embeddings"
    );
    throw error;
  }
}

/**
 * Delete embeddings for a specific document
 */
export async function deleteDocumentEmbeddings(
  userId: string,
  docType: DocumentType,
  docId?: string
): Promise<number> {
  try {
    // MONEY-1499: a delete goes to BOTH collections whenever both exist, and
    // that is stricter than the write path on purpose. Deleting from v1 alone
    // would leave the user's text AND its vector live and retrievable in v2 —
    // a privacy defect rather than a consistency one, and one that no counter
    // would report.
    const result = await prisma.documentEmbedding.deleteMany({
      where: {
        userId,
        docType,
        ...(docId && { docId }),
      },
    });
    const v2Count = await deleteEmbeddingsV2(rawCmd, {
      userId: oid(userId),
      docType,
      ...(docId ? { docId } : {}),
    });

    logger.info(
      { userId, docType, docId, deletedCount: result.count, v2Count },
      "Deleted document embeddings"
    );

    return Math.max(result.count, v2Count);
  } catch (error) {
    logger.error(
      { error, userId, docType, docId },
      "Failed to delete document embeddings"
    );
    throw error;
  }
}

/**
 * Delete all embeddings for a user
 */
export async function deleteUserEmbeddings(userId: string): Promise<number> {
  try {
    const result = await prisma.documentEmbedding.deleteMany({
      where: { userId },
    });
    // MONEY-1499 — both collections, always. See `deleteDocumentEmbeddings`.
    const v2Count = await deleteEmbeddingsV2(rawCmd, { userId: oid(userId) });

    logger.info(
      { userId, deletedCount: result.count, v2Count },
      "Deleted all user embeddings"
    );

    return Math.max(result.count, v2Count);
  } catch (error) {
    logger.error({ error, userId }, "Failed to delete user embeddings");
    throw error;
  }
}

// ============== VECTOR SEARCH ==============

/**
 * Search for similar documents using vector similarity
 *
 * Automatically selects the best search method:
 * - Production (Atlas): Uses native $vectorSearch for performance
 * - Local/QA (DigitalOcean): Uses application-level cosine similarity
 *
 * @param userId - User ID to search within
 * @param queryText - Text query to search for
 * @param options - Search options
 */
export async function searchSimilar(
  userId: string,
  queryText: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  // 1. Generate embedding for query (RETRIEVAL_QUERY task type)
  const { embedding: queryEmbedding } = await generateEmbedding(
    queryText,
    "RETRIEVAL_QUERY"
  );

  // 2. Use native vector search if available (Atlas only)
  if (MONGODB_VECTOR_SEARCH_ENABLED) {
    try {
      return await searchSimilarNative(userId, queryEmbedding, options);
    } catch (error) {
      // Fall back to application-level search if native fails
      logger.warn(
        { error, userId },
        "Native vector search failed, falling back to application-level"
      );
    }
  }

  // 3. Application-level search (DigitalOcean or fallback)
  return searchSimilarAppLevel(userId, queryEmbedding, queryText, options);
}

/**
 * Application-level vector search using cosine similarity
 * Works with any MongoDB provider (DigitalOcean, Atlas, etc.)
 */
async function searchSimilarAppLevel(
  userId: string,
  queryEmbedding: number[],
  queryText: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { topK = 5, docTypes, minScore = 0.5 } = options;

  try {
    // Fetch all user documents (filtered by type if specified).
    // MONEY-1499: through `findEmbeddingRows`, because under v2 the vector is
    // BinData that Prisma's client cannot return. The scores stay comparable —
    // cosine is invariant to the positive per-vector scale int8 quantization
    // applies.
    const { rows } = await findEmbeddingRows(rawCmd, {
      mode: await getEmbeddingsMode(),
      filter: {
        userId: oid(userId),
        ...(docTypes && { docType: { $in: docTypes } }),
      },
      limit: 0,
    });
    const documents = rows;

    if (documents.length === 0) {
      logger.debug(
        { userId, docTypes },
        "No documents found for vector search"
      );
      return [];
    }

    // Calculate similarity scores in-memory (shared pure ranking).
    const scored = rankBySimilarity(documents, queryEmbedding, {
      topK,
      minScore,
    });

    logger.info(
      {
        userId,
        query: queryText.slice(0, 50),
        totalDocs: documents.length,
        results: scored.length,
        topScore: scored[0]?.score,
        searchMethod: "application-level",
      },
      "Vector search completed"
    );

    return scored;
  } catch (error) {
    logger.error(
      { error, userId, query: queryText.slice(0, 50) },
      "Application-level vector search failed"
    );
    throw error;
  }
}

/**
 * Search using MongoDB Atlas Vector Search (native aggregation)
 *
 * The index definition used to be copied into this comment, and the only place
 * it actually existed was the Atlas UI. It now lives in
 * `scripts/ops/atlas-search-indexes.json`, applied by
 * `scripts/ops/apply-atlas-search-indexes.ts` (MONEY-1499) — so there is one
 * copy, it is reviewable, and `--verify` reports when the cluster has drifted
 * from it.
 *
 * Use this for better performance at scale.
 */
export async function searchSimilarNative(
  userId: string,
  queryEmbedding: number[],
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { topK = 5, docTypes, minScore = 0.5 } = options;

  try {
    // Use Prisma's $runCommandRaw for native MongoDB aggregation.
    // Note: This requires the vector search index to be set up in Atlas —
    // `scripts/ops/atlas-search-indexes.json`, applied by script (MONEY-1499).
    //
    // MONEY-1499: which collection, which index and how the query vector is
    // encoded are ONE decision, taken in @usemoney/core, so this and the
    // research tool cannot drift apart. A null stage means the query vector
    // would not quantize — which `catch` below already handles by falling
    // back to the application-level search.
    const search = buildVectorSearchStage({
      mode: await getEmbeddingsMode(),
      queryVector: queryEmbedding,
      numCandidates: topK * 10,
      limit: topK,
      filter: {
        // `oid()`, NOT a bare string — MONEY-1500. `userId` is
        // `String @db.ObjectId`; Prisma coerces it on a findMany and
        // `$runCommandRaw` does not, so this matched NOTHING for every user
        // and returned empty WITHOUT throwing — the `catch` below never fired
        // and the application-level fallback was unreachable.
        userId: oid(userId),
        ...(docTypes && { docType: { $in: docTypes } }),
      },
    });
    if (!search) throw new Error("query vector did not quantize");
    const pipeline = [
      search.stage,
      {
        $project: {
          content: 1,
          docType: 1,
          docId: 1,
          metadata: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
      {
        $match: {
          score: { $gte: minScore },
        },
      },
    ];

    // Execute native aggregation through Prisma
    const results = (await prisma.$runCommandRaw({
      aggregate: search.aggregate,
      pipeline,
      cursor: {},
    })) as { cursor?: { firstBatch?: any[] } };

    const documents = results.cursor?.firstBatch || [];

    logger.info(
      {
        userId,
        results: documents.length,
        topScore: documents[0]?.score,
        searchMethod: "atlas-native",
      },
      "Vector search completed"
    );

    return documents.map((doc: any) => ({
      content: doc.content,
      docType: doc.docType as DocumentType,
      docId: doc.docId,
      score: doc.score,
      metadata: doc.metadata,
    }));
  } catch (error) {
    // Log and rethrow - fallback is handled by searchSimilar()
    logger.error({ error, userId }, "Native vector search failed");
    throw error;
  }
}

// ============== STATISTICS ==============

/**
 * Get embedding statistics for a user
 */
export async function getUserEmbeddingStats(userId: string) {
  // MONEY-1499: these read no vector, so Prisma is fine — but they must read
  // the LIVE collection. After v1 is renamed away a v1 count does not error,
  // it returns 0, which is a plausible number and a wrong one.
  const onV2 = (await getEmbeddingsMode()) === "on";
  const stats = onV2
    ? await prisma.documentEmbeddingV2.groupBy({
        by: ["docType"],
        where: { userId },
        _count: true,
      })
    : await prisma.documentEmbedding.groupBy({
        by: ["docType"],
        where: { userId },
        _count: true,
      });

  const total = onV2
    ? await prisma.documentEmbeddingV2.count({ where: { userId } })
    : await prisma.documentEmbedding.count({ where: { userId } });

  return {
    total,
    byType: stats.reduce(
      (acc, s) => ({
        ...acc,
        [s.docType]: s._count,
      }),
      {} as Record<DocumentType, number>
    ),
  };
}

/**
 * Check if a document has been indexed
 */
export async function isDocumentIndexed(
  userId: string,
  docType: DocumentType,
  docId: string
): Promise<boolean> {
  const count =
    (await getEmbeddingsMode()) === "on"
      ? await prisma.documentEmbeddingV2.count({
          where: { userId, docType, docId },
        })
      : await prisma.documentEmbedding.count({
          where: { userId, docType, docId },
        });
  return count > 0;
}

/**
 * Get last indexed timestamp for a document type
 */
export async function getLastIndexedAt(
  userId: string,
  docType: DocumentType
): Promise<Date | null> {
  const latest =
    (await getEmbeddingsMode()) === "on"
      ? await prisma.documentEmbeddingV2.findFirst({
          where: { userId, docType },
          orderBy: { updatedAt: "desc" },
          select: { updatedAt: true },
        })
      : await prisma.documentEmbedding.findFirst({
          where: { userId, docType },
          orderBy: { updatedAt: "desc" },
          select: { updatedAt: true },
        });
  return latest?.updatedAt || null;
}

// ============== STOCK DOCUMENT OPERATIONS ==============

/** Well-known system userId for shared stock document embeddings */
export const SYSTEM_USER_ID = "000000000000000000000001";

/**
 * Store a stock document embedding (system-level, shared across all users).
 */
export async function storeStockDocEmbedding(
  symbol: string,
  docType: DocumentType,
  content: string,
  embedding: number[],
  docId: string,
  chunkId: number,
  metadata?: DocumentMetadata
): Promise<void> {
  return storeEmbedding(
    SYSTEM_USER_ID,
    docType,
    content,
    embedding,
    docId,
    chunkId,
    { ...metadata, symbol: symbol.toUpperCase() }
  );
}

/**
 * Search stock document embeddings for a specific symbol.
 * Searches system-level embeddings filtered by symbol in metadata.
 */
export async function searchStockDocuments(
  symbol: string,
  queryText: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { topK = 5, docTypes, minScore = 0.5 } = options;

  // Generate embedding for the query (RETRIEVAL_QUERY task type)
  const { embedding: queryEmbedding } = await generateEmbedding(
    queryText,
    "RETRIEVAL_QUERY"
  );

  // Stock doc types to search (all financial doc types if not specified).
  // MONEY-779: include screener_financials (the richest embedded text) plus the
  // concall summary/transcript types — these are what the worker actually embeds
  // for most symbols, and were previously excluded from the chat-RAG default.
  const stockDocTypes = docTypes || [
    "financial_statement",
    "corporate_filing",
    "annual_report",
    "quarterly_result",
    "screener_financials",
    "concall_ai_summary",
    "concall_transcript",
  ];

  // Try native Atlas vector search first
  if (MONGODB_VECTOR_SEARCH_ENABLED) {
    try {
      return await searchStockDocsNative(
        symbol,
        queryEmbedding,
        stockDocTypes,
        topK,
        minScore
      );
    } catch {
      // Fall back to app-level search
    }
  }

  // App-level fallback: fetch this symbol's system embeddings and score in
  // process. MONEY-1499: the `metadata.symbol` narrowing moved INTO the query
  // — Prisma could not express it, so this used to pull every system chunk of
  // every stock doc type into memory (millions of rows in prod) and filter
  // client-side. The raw find can, so it does.
  const upperSymbol = symbol.toUpperCase();
  const { rows: symbolDocs } = await findEmbeddingRows(rawCmd, {
    mode: await getEmbeddingsMode(),
    filter: {
      userId: oid(SYSTEM_USER_ID),
      docType: { $in: stockDocTypes },
      "metadata.symbol": upperSymbol,
    },
    limit: Math.max(topK * 50, 500),
  });

  return rankBySimilarity(symbolDocs, queryEmbedding, { topK, minScore });
}

/**
 * Native Atlas vector search for stock documents.
 */
async function searchStockDocsNative(
  symbol: string,
  queryEmbedding: number[],
  docTypes: string[],
  topK: number,
  minScore: number
): Promise<SearchResult[]> {
  // MONEY-1499: v1/v2 collection + index + query-vector encoding, decided once
  // in @usemoney/core. A null stage means the query vector would not quantize;
  // the caller already treats an empty result as "no stock-doc context".
  const search = buildVectorSearchStage({
    mode: await getEmbeddingsMode(),
    queryVector: queryEmbedding,
    numCandidates: topK * 10,
    limit: topK * 2, // Get extra to filter by symbol
    filter: {
      // `oid()` — MONEY-1500, same reason as above.
      userId: oid(SYSTEM_USER_ID),
      docType: { $in: docTypes },
    },
  });
  if (!search) return [];
  const pipeline = [
    search.stage,
    {
      $match: {
        "metadata.symbol": symbol.toUpperCase(),
      },
    },
    { $limit: topK },
    {
      $project: {
        content: 1,
        docType: 1,
        docId: 1,
        metadata: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];

  const results = (await prisma.$runCommandRaw({
    aggregate: search.aggregate,
    pipeline,
    cursor: {},
  })) as { cursor?: { firstBatch?: Record<string, unknown>[] } };

  const documents = results.cursor?.firstBatch || [];

  return documents
    .filter((doc) => (doc.score as number) >= minScore)
    .map((doc) => ({
      content: doc.content as string,
      docType: doc.docType as DocumentType,
      docId: (doc.docId as string) || null,
      score: doc.score as number,
      metadata: doc.metadata as DocumentMetadata | undefined,
    }));
}

/**
 * Delete all stock document embeddings for a symbol (for re-embedding).
 */
export async function deleteStockDocEmbeddings(
  symbol: string,
  docType?: DocumentType
): Promise<number> {
  // We can't filter by metadata in Prisma deleteMany, so fetch IDs first
  const docs = await prisma.documentEmbedding.findMany({
    where: {
      userId: SYSTEM_USER_ID,
      ...(docType ? { docType } : {}),
    },
    select: { id: true, metadata: true },
  });

  const idsToDelete = docs
    .filter((d) => {
      const meta = d.metadata as Record<string, unknown> | null;
      return meta?.symbol === symbol.toUpperCase();
    })
    .map((d) => d.id);

  const v1Count =
    idsToDelete.length === 0
      ? 0
      : (
          await prisma.documentEmbedding.deleteMany({
            where: { id: { in: idsToDelete } },
          })
        ).count;

  // MONEY-1499 — v2 too, and NOT via the id list above: those are v1 `_id`s,
  // and a row the dual-write created directly in v2 has its own. The raw
  // delete filters on `metadata.symbol` server-side, which Prisma's
  // `deleteMany` could not express and which is why this function had to
  // fetch-then-delete in the first place.
  const v2Count = await deleteEmbeddingsV2(rawCmd, {
    userId: oid(SYSTEM_USER_ID),
    ...(docType ? { docType } : {}),
    "metadata.symbol": symbol.toUpperCase(),
  });

  return Math.max(v1Count, v2Count);
}
