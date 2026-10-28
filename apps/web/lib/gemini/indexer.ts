/**
 * Document Indexer
 *
 * Indexes user documents for RAG by generating embeddings and storing them.
 * Call these functions after data syncs or updates.
 */

import prisma from "@/lib/prisma";
import { geminiLogger as logger } from "@usemoney/logger";
import {
  generateEmbedding,
  generateBatchEmbeddings,
  chunkText,
  formatHoldingsForEmbedding,
  formatTradesForEmbedding,
  formatFireScenarioForEmbedding,
  formatAnalysisForEmbedding,
} from "./embeddings";
import {
  storeEmbedding,
  storeBatchEmbeddings,
  deleteDocumentEmbeddings,
  type DocumentType,
  type DocumentMetadata,
} from "./vector-store";

// ============== TYPES ==============

export interface IndexingResult {
  success: boolean;
  documentsIndexed: number;
  chunksIndexed: number;
  errors: string[];
}

export interface IndexingOptions {
  forceReindex?: boolean; // Re-index even if recently indexed
  chunkSize?: number; // Max tokens per chunk
}

/** Default document types indexed when a caller does not specify a subset. */
export const DEFAULT_INDEX_DOC_TYPES: DocumentType[] = [
  "holdings",
  "trades",
  "fire_scenario",
  "analysis",
  "document",
];

/**
 * Merge several per-source IndexingResults into one. Exported & used by
 * indexAllUserData so the aggregation is a single tested code path:
 * success only if every part succeeded; counts and errors are summed.
 */
export function aggregateIndexingResults(
  results: IndexingResult[]
): IndexingResult {
  return {
    success: results.every((r) => r.success),
    documentsIndexed: results.reduce((sum, r) => sum + r.documentsIndexed, 0),
    chunksIndexed: results.reduce((sum, r) => sum + r.chunksIndexed, 0),
    errors: results.flatMap((r) => r.errors),
  };
}

/**
 * Resolve which document types to index: the caller's subset, or the default
 * set. Exported & used by runBackgroundIndexing.
 */
export function selectDocTypes(types?: DocumentType[]): DocumentType[] {
  return types || DEFAULT_INDEX_DOC_TYPES;
}

// ============== INDEXING FUNCTIONS ==============

/**
 * Index a user's holdings for RAG
 *
 * Call this after broker sync or manual holding updates.
 */
export async function indexUserHoldings(
  userId: string,
  options: IndexingOptions = {}
): Promise<IndexingResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let documentsIndexed = 0;
  let chunksIndexed = 0;

  try {
    // Fetch user's holdings
    const holdings = await prisma.holding.findMany({
      where: { userId },
      select: {
        symbol: true,
        name: true,
        quantity: true,
        averagePrice: true,
        currentPrice: true,
        pnlPercentage: true,
        sector: true,
        broker: true,
      },
    });

    if (holdings.length === 0) {
      // Delete any existing holdings embeddings
      await deleteDocumentEmbeddings(userId, "holdings");
      return {
        success: true,
        documentsIndexed: 0,
        chunksIndexed: 0,
        errors: [],
      };
    }

    // Format holdings for embedding
    const holdingsText = formatHoldingsForEmbedding(
      holdings.map((h) => ({
        symbol: h.symbol,
        name: h.name || undefined,
        quantity: h.quantity,
        averagePrice: h.averagePrice,
        currentPrice: h.currentPrice,
        pnlPercentage: h.pnlPercentage,
        sector: h.sector || undefined,
        broker: h.broker || undefined,
      }))
    );

    // Chunk if necessary
    const chunks = chunkText(holdingsText, options.chunkSize || 512);

    // Clear existing holdings embeddings
    await deleteDocumentEmbeddings(userId, "holdings");

    // Generate and store embeddings for each chunk
    for (const chunk of chunks) {
      try {
        const { embedding } = await generateEmbedding(chunk.text);

        await storeEmbedding(
          userId,
          "holdings",
          chunk.text,
          embedding,
          "portfolio_summary",
          chunk.chunkIndex,
          {
            holdingsCount: holdings.length,
            totalValue: holdings.reduce(
              (sum, h) => sum + h.quantity * h.currentPrice,
              0
            ),
          }
        );

        chunksIndexed++;
      } catch (error) {
        const errMsg = `Failed to index holdings chunk ${chunk.chunkIndex}`;
        errors.push(errMsg);
        logger.error({ error, userId, chunkIndex: chunk.chunkIndex }, errMsg);
      }
    }

    documentsIndexed = 1;

    logger.info(
      {
        userId,
        holdingsCount: holdings.length,
        chunksIndexed,
        duration: Date.now() - startTime,
      },
      "Indexed user holdings"
    );

    return {
      success: errors.length === 0,
      documentsIndexed,
      chunksIndexed,
      errors,
    };
  } catch (error) {
    const errMsg = `Holdings indexing failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    logger.error({ error, userId }, errMsg);
    return {
      success: false,
      documentsIndexed,
      chunksIndexed,
      errors: [errMsg],
    };
  }
}

/**
 * Index a user's trades for RAG
 *
 * Call this after broker sync or manual trade entries.
 */
export async function indexUserTrades(
  userId: string,
  options: IndexingOptions = {}
): Promise<IndexingResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let documentsIndexed = 0;
  let chunksIndexed = 0;

  try {
    // Fetch recent trades (last 90 days)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const trades = await prisma.trade.findMany({
      where: {
        userId,
        tradeDate: { gte: ninetyDaysAgo },
      },
      select: {
        symbol: true,
        tradeType: true,
        quantity: true,
        price: true,
        tradeDate: true,
        realizedPnL: true,
        broker: true,
      },
      orderBy: { tradeDate: "desc" },
      take: 500, // Limit to recent 500 trades
    });

    if (trades.length === 0) {
      await deleteDocumentEmbeddings(userId, "trades");
      return {
        success: true,
        documentsIndexed: 0,
        chunksIndexed: 0,
        errors: [],
      };
    }

    // Format trades for embedding
    const tradesText = formatTradesForEmbedding(
      trades.map((t) => ({
        symbol: t.symbol,
        tradeType: t.tradeType,
        quantity: t.quantity,
        price: t.price,
        tradeDate: t.tradeDate,
        realizedPnL: t.realizedPnL || undefined,
        broker: t.broker || undefined,
      }))
    );

    // Chunk if necessary
    const chunks = chunkText(tradesText, options.chunkSize || 512);

    // Clear existing trades embeddings
    await deleteDocumentEmbeddings(userId, "trades");

    // Generate and store embeddings
    for (const chunk of chunks) {
      try {
        const { embedding } = await generateEmbedding(chunk.text);

        await storeEmbedding(
          userId,
          "trades",
          chunk.text,
          embedding,
          "trades_summary",
          chunk.chunkIndex,
          {
            tradesCount: trades.length,
            dateFrom: trades[trades.length - 1]?.tradeDate?.toISOString(),
            dateTo: trades[0]?.tradeDate?.toISOString(),
          }
        );

        chunksIndexed++;
      } catch (error) {
        const errMsg = `Failed to index trades chunk ${chunk.chunkIndex}`;
        errors.push(errMsg);
        logger.error({ error, userId, chunkIndex: chunk.chunkIndex }, errMsg);
      }
    }

    documentsIndexed = 1;

    logger.info(
      {
        userId,
        tradesCount: trades.length,
        chunksIndexed,
        duration: Date.now() - startTime,
      },
      "Indexed user trades"
    );

    return {
      success: errors.length === 0,
      documentsIndexed,
      chunksIndexed,
      errors,
    };
  } catch (error) {
    const errMsg = `Trades indexing failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    logger.error({ error, userId }, errMsg);
    return {
      success: false,
      documentsIndexed,
      chunksIndexed,
      errors: [errMsg],
    };
  }
}

/**
 * Index a user's FIRE scenarios for RAG
 *
 * Call this after scenario creation or updates.
 */
export async function indexFireScenarios(
  userId: string,
  scenarioId?: string,
  options: IndexingOptions = {}
): Promise<IndexingResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let documentsIndexed = 0;
  let chunksIndexed = 0;

  try {
    // Fetch scenarios
    const scenarios = await prisma.fireScenario.findMany({
      where: {
        userId,
        ...(scenarioId && { id: scenarioId }),
      },
    });

    if (scenarios.length === 0) {
      if (scenarioId) {
        await deleteDocumentEmbeddings(userId, "fire_scenario", scenarioId);
      }
      return {
        success: true,
        documentsIndexed: 0,
        chunksIndexed: 0,
        errors: [],
      };
    }

    // Index each scenario
    for (const scenario of scenarios) {
      try {
        const scenarioText = formatFireScenarioForEmbedding({
          name: scenario.name,
          description: scenario.description || undefined,
          currentAge: scenario.currentAge,
          retirementAge: scenario.retirementAge,
          lifeExpectancy: scenario.lifeExpectancy,
          currentCorpus: scenario.currentCorpus,
          monthlySavings: scenario.monthlySavings,
          withdrawalRate: scenario.withdrawalRate,
          fireNumber: scenario.fireNumber || undefined,
          yearsToFire: scenario.yearsToFire || undefined,
        });

        // Delete existing embeddings for this scenario
        await deleteDocumentEmbeddings(userId, "fire_scenario", scenario.id);

        // Chunk if necessary
        const chunks = chunkText(scenarioText, options.chunkSize || 512);

        for (const chunk of chunks) {
          const { embedding } = await generateEmbedding(chunk.text);

          await storeEmbedding(
            userId,
            "fire_scenario",
            chunk.text,
            embedding,
            scenario.id,
            chunk.chunkIndex,
            {
              scenarioName: scenario.name,
              retirementAge: scenario.retirementAge,
              isDefault: scenario.isDefault,
            }
          );

          chunksIndexed++;
        }

        documentsIndexed++;
      } catch (error) {
        const errMsg = `Failed to index scenario ${scenario.name}`;
        errors.push(errMsg);
        logger.error({ error, userId, scenarioId: scenario.id }, errMsg);
      }
    }

    logger.info(
      {
        userId,
        scenariosIndexed: documentsIndexed,
        chunksIndexed,
        duration: Date.now() - startTime,
      },
      "Indexed FIRE scenarios"
    );

    return {
      success: errors.length === 0,
      documentsIndexed,
      chunksIndexed,
      errors,
    };
  } catch (error) {
    const errMsg = `FIRE scenario indexing failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    logger.error({ error, userId }, errMsg);
    return {
      success: false,
      documentsIndexed,
      chunksIndexed,
      errors: [errMsg],
    };
  }
}

/**
 * Index a user's analysis reports for RAG
 *
 * Call this after saving an analysis report.
 */
export async function indexAnalysisReports(
  userId: string,
  reportId?: string,
  options: IndexingOptions = {}
): Promise<IndexingResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  let documentsIndexed = 0;
  let chunksIndexed = 0;

  try {
    // Fetch analysis reports
    const reports = await prisma.analysisReport.findMany({
      where: {
        userId,
        ...(reportId && { id: reportId }),
      },
      orderBy: { createdAt: "desc" },
      take: 20, // Limit to recent 20 reports
    });

    if (reports.length === 0) {
      if (reportId) {
        await deleteDocumentEmbeddings(userId, "analysis", reportId);
      }
      return {
        success: true,
        documentsIndexed: 0,
        chunksIndexed: 0,
        errors: [],
      };
    }

    // Index each report
    for (const report of reports) {
      try {
        const analysisText = formatAnalysisForEmbedding({
          symbol: report.symbol,
          name: report.name || undefined,
          recommendation: report.recommendation,
          confidence: report.confidence || undefined,
          targetPrice: report.targetPrice || undefined,
          stopLoss: report.stopLoss || undefined,
          strengths: report.strengths || undefined,
          weaknesses: report.weaknesses || undefined,
          commentary: report.commentary || undefined,
        });

        // Delete existing embeddings for this report
        await deleteDocumentEmbeddings(userId, "analysis", report.id);

        // Chunk if necessary
        const chunks = chunkText(analysisText, options.chunkSize || 512);

        for (const chunk of chunks) {
          const { embedding } = await generateEmbedding(chunk.text);

          await storeEmbedding(
            userId,
            "analysis",
            chunk.text,
            embedding,
            report.id,
            chunk.chunkIndex,
            {
              symbol: report.symbol,
              recommendation: report.recommendation,
            }
          );

          chunksIndexed++;
        }

        documentsIndexed++;
      } catch (error) {
        const errMsg = `Failed to index analysis for ${report.symbol}`;
        errors.push(errMsg);
        logger.error({ error, userId, reportId: report.id }, errMsg);
      }
    }

    logger.info(
      {
        userId,
        reportsIndexed: documentsIndexed,
        chunksIndexed,
        duration: Date.now() - startTime,
      },
      "Indexed analysis reports"
    );

    return {
      success: errors.length === 0,
      documentsIndexed,
      chunksIndexed,
      errors,
    };
  } catch (error) {
    const errMsg = `Analysis report indexing failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    logger.error({ error, userId }, errMsg);
    return {
      success: false,
      documentsIndexed,
      chunksIndexed,
      errors: [errMsg],
    };
  }
}

/**
 * Index all user data for RAG
 *
 * Call this for initial setup or full reindex.
 */
export async function indexAllUserData(
  userId: string,
  options: IndexingOptions = {}
): Promise<{
  holdings: IndexingResult;
  trades: IndexingResult;
  fireScenarios: IndexingResult;
  analysisReports: IndexingResult;
  documents: IndexingResult;
  totalTime: number;
}> {
  const startTime = Date.now();

  logger.info({ userId }, "Starting full user data indexing");

  // Index user documents (find unembedded ones)
  const unembeddedDocs = await prisma.userDocument.findMany({
    where: {
      userId,
      isDeleted: false,
      isEmbedded: false,
      processingStatus: "READY",
    },
    select: { id: true },
  });

  // Run indexing operations in parallel
  const [holdings, trades, fireScenarios, analysisReports, ...docResults] =
    await Promise.all([
      indexUserHoldings(userId, options),
      indexUserTrades(userId, options),
      indexFireScenarios(userId, undefined, options),
      indexAnalysisReports(userId, undefined, options),
      ...unembeddedDocs.map((doc) =>
        indexUserDocument(userId, doc.id, options)
      ),
    ]);

  // Aggregate document results
  const documents: IndexingResult = aggregateIndexingResults(docResults);

  const totalTime = Date.now() - startTime;

  logger.info(
    {
      userId,
      totalTime,
      holdingsIndexed: holdings.documentsIndexed,
      tradesIndexed: trades.documentsIndexed,
      scenariosIndexed: fireScenarios.documentsIndexed,
      analysisIndexed: analysisReports.documentsIndexed,
      documentsIndexed: documents.documentsIndexed,
    },
    "Completed full user data indexing"
  );

  return {
    holdings,
    trades,
    fireScenarios,
    analysisReports,
    documents,
    totalTime,
  };
}

/**
 * Index a user document for RAG
 *
 * Call this after document text extraction completes.
 */
export async function indexUserDocument(
  userId: string,
  documentId: string,
  options: IndexingOptions = {}
): Promise<IndexingResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  try {
    const doc = await prisma.userDocument.findFirst({
      where: { id: documentId, userId, isDeleted: false },
      select: { id: true, title: true, textContent: true, isEmbedded: true },
    });

    if (!doc || !doc.textContent || doc.textContent.length < 50) {
      return {
        success: true,
        documentsIndexed: 0,
        chunksIndexed: 0,
        errors: [],
      };
    }

    // Delete old embeddings if re-indexing
    if (doc.isEmbedded || options.forceReindex) {
      await deleteDocumentEmbeddings(userId, "document", documentId);
    }

    // Chunk and embed
    const chunks = chunkText(doc.textContent, options.chunkSize || 512, 50);
    const texts = chunks.map(
      (chunk) => `Document: ${doc.title}\n\n${chunk.text}`
    );

    const batchResult = await generateBatchEmbeddings(texts);
    let chunksIndexed = 0;

    for (let i = 0; i < chunks.length; i++) {
      if (batchResult.failedIndices.includes(i)) continue;
      const embedding = batchResult.embeddings[i];
      if (!embedding || embedding.length === 0) continue;

      await storeEmbedding(
        userId,
        "document",
        texts[i]!,
        embedding,
        documentId,
        chunks[i]!.chunkIndex,
        {
          title: doc.title,
          sourceDocumentId: documentId,
        }
      );
      chunksIndexed++;
    }

    // Mark as embedded
    if (chunksIndexed > 0) {
      await prisma.userDocument.update({
        where: { id: documentId },
        data: { isEmbedded: true },
      });
    }

    logger.info(
      { userId, documentId, chunksIndexed, timeMs: Date.now() - startTime },
      "Indexed user document"
    );

    return { success: true, documentsIndexed: 1, chunksIndexed, errors };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    errors.push(msg);
    logger.error(
      { error, userId, documentId },
      "Failed to index user document"
    );
    return { success: false, documentsIndexed: 0, chunksIndexed: 0, errors };
  }
}

/**
 * Delete a specific scenario's embeddings
 */
export async function deleteScenarioEmbeddings(
  userId: string,
  scenarioId: string
): Promise<number> {
  return deleteDocumentEmbeddings(userId, "fire_scenario", scenarioId);
}

/**
 * Delete a specific analysis report's embeddings
 */
export async function deleteAnalysisEmbeddings(
  userId: string,
  reportId: string
): Promise<number> {
  return deleteDocumentEmbeddings(userId, "analysis", reportId);
}

/**
 * Background indexing job
 *
 * This can be called from a cron job or after-sync hook
 * to keep embeddings up to date.
 */
export async function runBackgroundIndexing(
  userId: string,
  docTypes?: DocumentType[]
): Promise<void> {
  const types = selectDocTypes(docTypes);

  logger.info({ userId, docTypes: types }, "Running background indexing");

  const promises: Promise<IndexingResult>[] = [];

  if (types.includes("holdings")) {
    promises.push(indexUserHoldings(userId));
  }
  if (types.includes("trades")) {
    promises.push(indexUserTrades(userId));
  }
  if (types.includes("fire_scenario")) {
    promises.push(indexFireScenarios(userId));
  }
  if (types.includes("analysis")) {
    promises.push(indexAnalysisReports(userId));
  }
  if (types.includes("document")) {
    // Index all unembedded documents
    const unembeddedDocs = await prisma.userDocument.findMany({
      where: {
        userId,
        isDeleted: false,
        isEmbedded: false,
        processingStatus: "READY",
      },
      select: { id: true },
    });
    for (const doc of unembeddedDocs) {
      promises.push(indexUserDocument(userId, doc.id));
    }
  }

  const results = await Promise.allSettled(promises);

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    logger.warn(
      { userId, failures: failures.length },
      "Some background indexing tasks failed"
    );
  }
}
