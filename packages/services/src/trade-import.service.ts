/**
 * Trade Import Service
 *
 * CRUD for import history records.
 * CSV/XLSX parsing and import pipeline stay in apps/web.
 * Source: apps/web/lib/actions/trade-import.ts
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@usemoney/database";
import { clearTradeCache } from "@usemoney/core";
import { generateDuplicateHash, type TradeRow } from "@usemoney/core/import";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  finite,
  summarizeImport,
  type DuplicateCounters,
} from "./trade-import-logic";

// Pure, Prisma-free trade-import orchestration helpers (finite-guarded
// row→Trade mapping, cross-source duplicate priority resolution, batch
// progress %, summary rollup). Re-exported so the LIVE service path and its
// regression tests execute the SAME guarded logic, mirroring how the index
// re-exports `dashboard-logic`. See `./trade-import-logic.ts`.
//
// NOTE: `finite` is intentionally NOT re-exported here — it is a per-module
// local guard and `dashboard-logic` already exports a `finite` through the
// package barrel; re-exporting a second one would collide. The service uses it
// internally via the direct import above; tests assert it via the relative
// `trade-import-logic` import.
export {
  getTradePriority,
  resolveDuplicate,
  categorizeSkip,
  mapRowToTradeInput,
  mapParsedRowToTradeInput,
  computeImportProgress,
  clampPercent,
  emptyDuplicateCounters,
  rollupDuplicateCount,
  determineImportStatus,
  summarizeImport,
  type TradeSourceType,
  type ExistingTradeForDedup,
  type NewTradeLinking,
  type DuplicateAction,
  type DuplicateResolution,
  type DuplicateBucket,
  type TradeCreateData,
  type MapRowContext,
  type MapRowResult,
  type DuplicateCounters,
  type ImportStatus,
  type ImportSummaryInput,
  type ImportSummary,
} from "./trade-import-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface CreateImportInput {
  fileName: string;
  fileSize: number;
  broker: string;
  totalRows: number;
}

export interface UpdateImportInput {
  status: "COMPLETED" | "FAILED" | "PARTIAL";
  importedCount?: number;
  skippedCount?: number;
  duplicateCount?: number;
  errorCount?: number;
  errors?: string[];
  summary?: Record<string, unknown>;
}

export interface ImportHistoryItem {
  batchId: string;
  importedAt: Date;
  tradeCount: number;
  fileName?: string | null;
  brokerFormat?: string;
  linkedBroker?: string | null;
  linkedBrokerUserId?: string | null;
  linkedToManual?: boolean;
  importedCount?: number;
  skippedCount?: number;
  duplicateCount?: number;
  errorCount?: number;
  status?: string;
}

export interface ImportDetail {
  batchId: string;
  fileName: string | null;
  fileSize: number | null;
  brokerFormat: string;
  linkedBroker: string | null;
  linkedBrokerUserId: string | null;
  linkedToManual: boolean;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  duplicateCount: number;
  errorCount: number;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  duplicateDetails: Array<{
    tradeHash: string;
    reason: string;
    existingBroker: string | null;
    existingSourceType: string;
    rowNumber: number;
  }> | null;
  errorDetails: Array<{
    row: number;
    error: string;
    data?: Record<string, unknown>;
  }> | null;
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * Get import history records ordered by createdAt desc.
 * Uses the ImportLog collection first, falls back to grouping trades for legacy imports.
 */
export async function getImportHistory(
  userId: string,
  options?: { limit?: number },
): Promise<ServiceResult<ImportHistoryItem[]>> {
  try {
    const take = options?.limit ?? 50;

    // First try to get from ImportLog (new system)
    const importLogs = await prisma.importLog.findMany({
      where: {
        userId,
        status: { not: "DELETED" },
      },
      orderBy: { createdAt: "desc" },
      take,
    });

    if (importLogs.length > 0) {
      // Get current trade counts for each batch (may differ from original due to deletes)
      const batchIds = importLogs.map((log) => log.importBatchId);
      const tradeCounts = await prisma.trade.groupBy({
        by: ["importBatchId"],
        where: {
          userId,
          importBatchId: { in: batchIds },
        },
        _count: { id: true },
      });

      const countMap = new Map(
        tradeCounts.map((tc) => [tc.importBatchId!, tc._count.id]),
      );

      const batches: ImportHistoryItem[] = importLogs.map((log) => ({
        batchId: log.importBatchId,
        importedAt: log.createdAt,
        tradeCount: countMap.get(log.importBatchId) || 0,
        fileName: log.fileName,
        brokerFormat: log.brokerFormat,
        linkedBroker: log.linkedBroker,
        linkedBrokerUserId: log.linkedBrokerUserId,
        linkedToManual: log.linkedToManual,
        importedCount: log.importedCount,
        skippedCount: log.skippedCount,
        duplicateCount: log.duplicateCount,
        errorCount: log.errorCount,
        status: log.status,
      }));

      return { success: true, data: batches };
    }

    // Fallback to old method (for imports before ImportLog was added)
    const trades = await prisma.trade.findMany({
      where: {
        userId,
        importBatchId: { not: null },
      },
      select: {
        importBatchId: true,
        createdAt: true,
        broker: true,
        sourceType: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Group by batch
    const batchMap = new Map<
      string,
      { importedAt: Date; count: number; broker: string | null }
    >();
    for (const trade of trades) {
      if (!trade.importBatchId) continue;
      const existing = batchMap.get(trade.importBatchId);
      if (existing) {
        existing.count++;
      } else {
        batchMap.set(trade.importBatchId, {
          importedAt: trade.createdAt,
          count: 1,
          broker: trade.broker,
        });
      }
    }

    const batches: ImportHistoryItem[] = Array.from(batchMap.entries()).map(
      ([batchId, data]) => ({
        batchId,
        importedAt: data.importedAt,
        tradeCount: data.count,
        linkedBroker: data.broker,
      }),
    );

    return { success: true, data: batches };
  } catch (error) {
    logger.error({ error, userId }, "getImportHistory service error");
    return { success: false, error: "Failed to fetch import history" };
  }
}

/** Injectable IO seam for the ESM service suite (fake prisma in tests). */
export interface TradeImportReadDeps {
  prisma?: typeof prisma;
}

/**
 * Get single import record with full details (summary, duplicate/error info).
 */
export async function getImportById(
  userId: string,
  importId: string,
  deps: TradeImportReadDeps = {},
): Promise<ServiceResult<ImportDetail>> {
  const db = deps.prisma ?? prisma;
  try {
    const importLog = await db.importLog.findFirst({
      where: { importBatchId: importId, userId },
    });

    if (!importLog) {
      return { success: false, error: "Import log not found" };
    }

    const detail: ImportDetail = {
      batchId: importLog.importBatchId,
      fileName: importLog.fileName,
      fileSize: importLog.fileSize,
      brokerFormat: importLog.brokerFormat,
      linkedBroker: importLog.linkedBroker,
      linkedBrokerUserId: importLog.linkedBrokerUserId,
      linkedToManual: importLog.linkedToManual,
      totalRows: importLog.totalRows,
      importedCount: importLog.importedCount,
      skippedCount: importLog.skippedCount,
      duplicateCount: importLog.duplicateCount,
      errorCount: importLog.errorCount,
      status: importLog.status,
      createdAt: importLog.createdAt,
      completedAt: importLog.completedAt,
      duplicateDetails:
        importLog.duplicateDetails as ImportDetail["duplicateDetails"],
      errorDetails: importLog.errorDetails as ImportDetail["errorDetails"],
    };

    return { success: true, data: detail };
  } catch (error) {
    logger.error({ error, userId, importId }, "getImportById service error");
    // MONEY-1062 (Round C / C1#3): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to fetch import details",
      code: "INTERNAL",
    };
  }
}

/**
 * Delete import record and its associated trades (source = IMPORTED, matching batchId).
 * Also cleans up paired trade views referencing deleted trades.
 * Cannot delete batches containing synced broker trades.
 */
export async function deleteImport(
  userId: string,
  importId: string,
  deps: TradeImportReadDeps = {},
): Promise<ServiceResult<{ deleted: number }>> {
  const db = deps.prisma ?? prisma;
  try {
    // Verify import belongs to user. MONEY-1062 (Round C / C2#3): a missing or
    // foreign batch used to fall through and return success { deleted: 0 } — an
    // existence oracle that also made the route 200 a nonexistent delete. Fail
    // fast with NOT_FOUND (mirrors retryImport's missing-log handling) so the
    // route 404s.
    const importLog = await db.importLog.findFirst({
      where: { importBatchId: importId, userId },
    });
    if (!importLog) {
      return { success: false, error: "Import not found", code: "NOT_FOUND" };
    }

    // Check if any trades are SYNCED (cannot delete synced trades)
    const hasSynced = await db.trade.findFirst({
      where: { importBatchId: importId, userId, sourceType: "SYNCED" },
    });
    if (hasSynced) {
      return {
        success: false,
        error: "Cannot delete - contains synced broker trades",
      };
    }

    // Get trade IDs for paired view cleanup
    const tradeIds = await db.trade.findMany({
      where: { importBatchId: importId, userId },
      select: { id: true },
    });

    // Delete trades
    const result = await db.trade.deleteMany({
      where: {
        userId,
        importBatchId: importId,
      },
    });

    // Delete associated paired trade views
    if (tradeIds.length > 0) {
      const ids = tradeIds.map((t) => t.id);
      await db.pairedTradeView.deleteMany({
        where: {
          userId,
          sourceTradeIds: { hasSome: ids },
        },
      });
    }

    // Mark import log as deleted (soft delete)
    await db.importLog.update({
      where: { importBatchId: importId },
      data: { status: "DELETED" },
    });

    await clearTradeCache(userId);

    logger.info(
      { userId, importId, deletedCount: result.count },
      "Import batch deleted",
    );

    return {
      success: true,
      data: { deleted: result.count },
      message: `Deleted ${result.count} imported trades`,
    };
  } catch (error) {
    logger.error({ error, userId, importId }, "deleteImport service error");
    // MONEY-1062 (Round C / C1#3): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to delete import batch",
      code: "INTERNAL",
    };
  }
}

/**
 * Count total imported trades for a user.
 */
export async function getImportedTradesCount(
  userId: string,
): Promise<ServiceResult<number>> {
  try {
    const count = await prisma.trade.count({
      where: {
        userId,
        sourceType: "IMPORTED",
      },
    });

    return { success: true, data: count };
  } catch (error) {
    logger.error({ error, userId }, "getImportedTradesCount service error");
    return { success: false, error: "Failed to count imported trades" };
  }
}

/**
 * Create a TradeImport record with status PROCESSING.
 * Called at the start of an import pipeline before trade rows are processed.
 */
export async function createImportRecord(
  userId: string,
  data: CreateImportInput,
): Promise<ServiceResult<{ importId: string; batchId: string }>> {
  try {
    const batchId = `import_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const importLog = await prisma.importLog.create({
      data: {
        userId,
        importBatchId: batchId,
        fileName: data.fileName,
        fileSize: data.fileSize,
        brokerFormat: data.broker,
        linkedBroker: null,
        linkedBrokerUserId: null,
        linkedToManual: false,
        totalRows: data.totalRows,
        importedCount: 0,
        skippedCount: 0,
        duplicateCount: 0,
        errorCount: 0,
        status: "PROCESSING",
      },
    });

    logger.info(
      { userId, batchId, fileName: data.fileName, totalRows: data.totalRows },
      "Import record created",
    );

    return {
      success: true,
      data: { importId: importLog.id, batchId },
    };
  } catch (error) {
    logger.error({ error, userId }, "createImportRecord service error");
    return { success: false, error: "Failed to create import record" };
  }
}

/**
 * Build the finite-safe import-log summary (totalRows / importedCount /
 * skippedCount / duplicateCount / errorCount / status) from the raw running
 * counters an import pipeline accumulates. A thin synchronous wrapper over the
 * pure `summarizeImport`, exposed at the service boundary so the web action and
 * the workers compute the persisted summary — including the `upgraded`-excluded
 * `duplicateCount` rollup and the COMPLETED/PARTIALLY_COMPLETED/FAILED status —
 * through ONE tested, finite-guarded function instead of re-deriving it inline
 * (where a NaN counter would leak into the row).
 */
export function buildImportSummary(input: {
  totalRows: number;
  imported: number;
  skipped: number;
  duplicates: DuplicateCounters;
  errorCount: number;
}): ReturnType<typeof summarizeImport> {
  return summarizeImport(input);
}

/**
 * Update import record status, summary, and error info.
 * Called when the import pipeline completes (success, partial, or failure).
 */
// MONEY-599: ownership-scoped (no callers today — kept safe if reimported).
export async function updateImportStatus(
  importId: string,
  userId: string,
  data: UpdateImportInput,
): Promise<ServiceResult<void>> {
  try {
    // Map "PARTIAL" to the DB enum value "PARTIALLY_COMPLETED"
    const dbStatus =
      data.status === "PARTIAL" ? "PARTIALLY_COMPLETED" : data.status;

    const res = await prisma.importLog.updateMany({
      where: { id: importId, userId },
      data: {
        status: dbStatus,
        // finite()-guard every persisted count so a NaN/Infinity that slipped
        // through an upstream counter can never be written to the ImportLog and
        // later poison the history-row summary formatters.
        importedCount: finite(data.importedCount ?? 0),
        skippedCount: finite(data.skippedCount ?? 0),
        duplicateCount: finite(data.duplicateCount ?? 0),
        errorCount: finite(data.errorCount ?? 0),
        errorDetails: data.errors
          ? data.errors.map((e, i) => ({ row: i, error: e }))
          : null,
        completedAt: new Date(),
      },
    });
    if (res.count === 0) {
      return { success: false, error: "Import log not found" };
    }

    logger.info(
      { importId, status: dbStatus, importedCount: data.importedCount },
      "Import status updated",
    );

    return { success: true, data: undefined };
  } catch (error) {
    logger.error({ error, importId }, "updateImportStatus service error");
    return { success: false, error: "Failed to update import status" };
  }
}

// ── Async import trigger + retry (apps/api mobile parity, MONEY-1062) ──────────
//
// Ports the ASYNC half of the web import flow for the API/mobile client:
//   - startTradeImport  ← apps/web/lib/actions/import-job.ts:startImportJobAction
//                         (createJob → publishImportJob → queueName stamp)
//   - retryImport       ← apps/web/lib/actions/trade-import.ts:retryFailedImportAction
//
// As with the broker-sync triggers, `startTradeImport` creates the pollable
// BackgroundJob row and RETURNS the jobId; the apps/api route owns the
// `publishImportJob` seam (so the publish is asserted at the route boundary).
// G3: the row insert is NOT best-effort here (unlike broker sync) — mirroring
// the web action, a failed insert returns { success:false } so the caller never
// publishes an import job with no row to track.

/** Injectable IO seam for the ESM service suite (fake prisma in tests). */
export interface StartTradeImportDeps {
  prisma?: typeof prisma;
}

export interface StartTradeImportInput {
  brokerFormat: string;
  fileType: "csv" | "xlsx";
  fileName?: string;
  /** Length of the inline CSV (stored in the job payload, not the content). */
  contentLength: number;
  brokerConnectionId?: string;
  linkToManual?: boolean;
}

/**
 * Create the pollable CSV_IMPORT BackgroundJob row for an async text import and
 * return its jobId. The caller builds the ImportJobMessage (carrying the inline
 * `content`) and publishes it via @usemoney/pubsub/publish, then returns
 * 202 { jobId } for /v1/jobs/:jobId polling. Full content is NOT stored in the
 * job payload (only its length) — matching the web `createJob` (avoids a bloated
 * BackgroundJob row).
 */
export async function startTradeImport(
  userId: string,
  input: StartTradeImportInput,
  deps: StartTradeImportDeps = {},
): Promise<ServiceResult<{ jobId: string }>> {
  const db = deps.prisma ?? prisma;
  try {
    const jobId = randomUUID();
    await db.backgroundJob.create({
      data: {
        jobId,
        userId,
        jobType: "CSV_IMPORT",
        status: "PENDING",
        progress: 0,
        queuedAt: new Date(),
        queueName: getTopicName(PUBSUB_TOPICS.CSV_IMPORT),
        payload: {
          brokerFormat: input.brokerFormat,
          fileType: input.fileType,
          fileName: input.fileName ?? null,
          brokerConnectionId: input.brokerConnectionId ?? null,
          linkToManual: input.linkToManual ?? false,
          contentLength: input.contentLength,
        },
      },
    });
    return { success: true, data: { jobId } };
  } catch (error) {
    logger.error({ error, userId }, "startTradeImport service error");
    return {
      success: false,
      error: "Failed to start trade import",
      code: "INTERNAL",
    };
  }
}

/** Injectable IO seam for the ESM service suite (fake prisma in tests). */
export interface RetryImportDeps {
  prisma?: typeof prisma;
}

export interface RetryImportData {
  retried: number;
  succeeded: number;
  failed: number;
}

type RetryErrorRow = { row: number; error: string; data?: TradeRow };

/**
 * Retry the failed rows of a partial/failed import (ports
 * retryFailedImportAction). Reads the stored per-row `data` from the ImportLog's
 * `errorDetails`, re-hashes each, skips ones that now exist, recreates the rest
 * with the original batch's broker linking, then rewrites the ImportLog's
 * imported/error counts + status. Synchronous (no publish/credits): the recreate
 * loop runs inline exactly like the web action.
 *   - missing/foreign log            → NOT_FOUND (404)
 *   - nothing retryable (no errors / no stored row data) → code-less failure (400)
 */
export async function retryImport(
  userId: string,
  batchId: string,
  deps: RetryImportDeps = {},
): Promise<ServiceResult<RetryImportData>> {
  const db = deps.prisma ?? prisma;
  try {
    const importLog = await db.importLog.findFirst({
      where: { importBatchId: batchId, userId },
    });
    if (!importLog) {
      return {
        success: false,
        error: "Import log not found",
        code: "NOT_FOUND",
      };
    }

    const errorDetails = importLog.errorDetails as RetryErrorRow[] | null;
    if (!errorDetails || errorDetails.length === 0) {
      return { success: false, error: "No failed rows to retry" };
    }
    const rowsWithData = errorDetails.filter((e) => e.data);
    if (rowsWithData.length === 0) {
      return {
        success: false,
        error: "No row data stored for retry. Please re-import the file.",
      };
    }

    const linkedBroker = importLog.linkedBroker;
    const linkedBrokerUserId = importLog.linkedBrokerUserId;
    const isLinkingToManual = importLog.linkedToManual;
    const isEditable = isLinkingToManual || !linkedBroker;

    let succeeded = 0;
    let failed = 0;
    const newErrorDetails: RetryErrorRow[] = [];

    for (const errorRow of rowsWithData) {
      const data = errorRow.data!;
      try {
        const hash = generateDuplicateHash({
          symbol: data.symbol,
          tradeDate: new Date(data.tradeDate),
          tradeType: data.tradeType,
          quantity: data.quantity,
          price: data.price,
          exchange: data.exchange,
          segment: data.segment,
        });

        const existing = await db.trade.findFirst({
          where: { userId, duplicateHash: hash },
        });
        if (existing) {
          // Already imported (e.g. a manual add or a prior retry) — count as
          // resolved, don't duplicate.
          succeeded++;
          continue;
        }

        await db.trade.create({
          data: {
            userId,
            symbol: data.symbol,
            tradingSymbol: data.isin || data.symbol,
            isin: data.isin || null,
            exchange: data.exchange,
            segment: data.segment,
            tradeType: data.tradeType,
            positionType: data.tradeType === "BUY" ? "LONG" : "SHORT",
            orderType: data.orderType || "MARKET",
            productType: data.productType || "CNC",
            quantity: data.quantity,
            price: data.price,
            tradeValue: data.quantity * data.price,
            tradeDate: new Date(data.tradeDate),
            tradeTime: data.tradeTime ? new Date(data.tradeTime) : null,
            status: "OPEN",
            broker: linkedBroker,
            brokerUserId: linkedBrokerUserId,
            sourceType: isLinkingToManual ? "MANUAL" : "IMPORTED",
            isEditable,
            importBatchId: batchId,
            brokerTradeId: data.tradeId || null,
            brokerOrderId: data.orderId || null,
            needsRepairing: true,
            duplicateHash: hash,
            brokerage: data.segment === "MF" ? 0 : 20,
            totalCharges: data.segment === "MF" ? 0 : 20,
          },
        });
        succeeded++;
      } catch (err) {
        failed++;
        newErrorDetails.push({
          row: errorRow.row,
          error: err instanceof Error ? err.message : String(err),
          data: errorRow.data,
        });
      }
    }

    const newImportedCount = importLog.importedCount + succeeded;
    const newErrorCount = newErrorDetails.length;
    const newStatus =
      newErrorCount === 0
        ? "COMPLETED"
        : newImportedCount > 0
          ? "PARTIALLY_COMPLETED"
          : "FAILED";

    await db.importLog.update({
      where: { id: importLog.id },
      data: {
        importedCount: newImportedCount,
        errorCount: newErrorCount,
        errorDetails:
          newErrorDetails.length > 0
            ? newErrorDetails.map((e) => ({
                row: e.row,
                error: e.error,
                data: e.data
                  ? {
                      ...e.data,
                      // Date → ISO for JSON storage (defensive: the stored data
                      // is already serialized, but a re-hydrated Date is coerced).
                      tradeDate:
                        e.data.tradeDate instanceof Date
                          ? e.data.tradeDate.toISOString()
                          : e.data.tradeDate,
                      tradeTime: e.data.tradeTime
                        ? e.data.tradeTime instanceof Date
                          ? e.data.tradeTime.toISOString()
                          : e.data.tradeTime
                        : undefined,
                      expiryDate: e.data.expiryDate
                        ? e.data.expiryDate instanceof Date
                          ? e.data.expiryDate.toISOString()
                          : e.data.expiryDate
                        : undefined,
                    }
                  : undefined,
              }))
            : null,
        status: newStatus,
      },
    });

    return {
      success: true,
      data: { retried: rowsWithData.length, succeeded, failed },
      message: `Retried ${rowsWithData.length} row(s)`,
    };
  } catch (error) {
    logger.error({ error, userId, batchId }, "retryImport service error");
    return { success: false, error: "Retry failed", code: "INTERNAL" };
  }
}
