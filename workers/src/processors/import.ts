/**
 * CSV Import Processor
 *
 * Processes CSV/XLSX file imports for tradebook data.
 * Uses shared parsing logic from @usemoney/core/import.
 */

import type { ImportJobMessage } from "@usemoney/types";
import type { BrokerType } from "@prisma/client";
import { prisma } from "@usemoney/database";
import { clearTradeCache } from "@usemoney/core";
import { randomUUID } from "node:crypto";
import {
  parseCSVContent,
  parseXLSXContent,
  parseCSVRow,
  getColumnMapping,
  resolveEffectiveBrokerFormat,
  generateDuplicateHash,
  sanitizeFormulaInjection,
  safeFetch,
  type BrokerFormat,
} from "@usemoney/core/import";
import { createNotification } from "../lib/notifications";
import { processPairing } from "./pairing";
import {
  buildJobStatusUpdate,
  buildImportResult,
  buildImportLogUpsertArgs,
  buildTradeCreateData,
  resolveImportStatus,
  isUniqueConstraintError,
} from "./import-logic";

// Cap on downloaded import files (CSV/XLSX). 50 MiB matches the upload limits.
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

// Upsert ImportLog to handle Pub/Sub retries (importBatchId is @unique).
// The idempotent { where, create, update } arg shaping lives in the pure
// `buildImportLogUpsertArgs` (tested in import-idempotency.test.ts); this thin
// wrapper just performs the I/O.
async function upsertImportLog(
  data: Parameters<typeof prisma.importLog.create>[0]["data"] & {
    importBatchId: string;
  },
) {
  await prisma.importLog.upsert(buildImportLogUpsertArgs(data));
}

export async function processImport(data: ImportJobMessage): Promise<void> {
  const {
    jobId,
    userId,
    brokerFormat,
    fileType,
    fileName,
    content: inlineContent,
    fileUrl,
    brokerConnectionId,
    linkToManual,
  } = data;

  if (!jobId || !userId) {
    throw new Error("Missing required fields: jobId, userId");
  }
  if (!brokerFormat) {
    throw new Error("Missing required field: brokerFormat");
  }

  console.log(
    `Processing import job ${jobId} for user ${userId} (format: ${brokerFormat}, type: ${fileType}${fileName ? `, file: ${fileName}` : ""})`,
  );

  // Update job status to PROCESSING
  await prisma.backgroundJob.updateMany({
    where: { jobId },
    data: buildJobStatusUpdate("PROCESSING"),
  });

  try {
    // 1. Get file content
    let content: string;

    if (inlineContent) {
      content = inlineContent;
    } else if (fileUrl) {
      // SSRF-safe download: allowlisted to GCS, DNS-resolved IP must be public,
      // redirects re-validated, body size-capped (shared guard).
      const { response, buffer } = await safeFetch(
        fileUrl,
        {},
        {
          allowedHosts: ["storage.googleapis.com"],
          maxBytes: MAX_IMPORT_BYTES,
        },
      );
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }
      content = buffer.toString("utf-8");
    } else {
      throw new Error("No content or file URL provided");
    }

    // 2. Sanitize and parse
    if (fileType !== "xlsx") {
      content = sanitizeFormulaInjection(content);
    }

    const parseResult =
      fileType === "xlsx"
        ? parseXLSXContent(content)
        : parseCSVContent(content);

    // 3. Parse rows using broker-specific column mapping. In auto-detect mode
    // (`generic` — the API path always enqueues this, and the web path does too
    // when the user didn't pick a broker) the header row is inspected and the
    // detected broker's mapping is used so "other brokers" import correctly. An
    // explicit broker choice is respected as-is. Shared with the web preview so
    // the two never diverge. (MONEY-1074)
    const effectiveFormat = resolveEffectiveBrokerFormat(
      brokerFormat as BrokerFormat,
      parseResult.columns,
    );
    const columnMap = getColumnMapping(effectiveFormat);
    const validTrades: Array<{
      symbol: string;
      isin?: string;
      exchange: string;
      segment: string;
      tradeType: string;
      productType?: string;
      quantity: number;
      price: number;
      tradeDate: Date;
      tradeTime?: Date;
      orderId?: string;
      tradeId?: string;
      orderType?: string;
      series?: string;
      auction?: boolean;
      expiryDate?: Date;
    }> = [];

    for (let i = 0; i < parseResult.rows.length; i++) {
      const row = parseResult.rows[i];
      if (!row) continue;
      const parsed = parseCSVRow(row, columnMap, i + 1);
      if (!parsed.error && parsed.data.symbol) {
        validTrades.push(parsed.data);
      }
    }

    if (validTrades.length === 0) {
      await prisma.backgroundJob.updateMany({
        where: { jobId },
        data: buildJobStatusUpdate("COMPLETED", {
          result: buildImportResult(0, 0, 0, []),
        }),
      });
      // Upsert ImportLog so it shows in history (handles Pub/Sub retries)
      await upsertImportLog({
        userId,
        importBatchId: jobId,
        fileName: fileName || null,
        fileSize: null,
        brokerFormat,
        linkedBroker: null,
        linkedBrokerUserId: null,
        linkedToManual: false,
        totalRows: parseResult.rows.length,
        importedCount: 0,
        skippedCount: 0,
        duplicateCount: 0,
        errorCount: 0,
        status: "COMPLETED",
        completedAt: new Date(),
      });
      return;
    }

    // 4. Insert trades with duplicate detection
    let imported = 0;
    let skipped = 0;
    const importErrors: string[] = [];

    // Get broker info if connection specified
    let connBroker: BrokerType | undefined;
    let connBrokerUserId: string | undefined;

    if (brokerConnectionId) {
      // IDOR guard: scope the lookup by `userId` (findFirst, not findUnique).
      // The job message is attacker-controllable; a bare `findUnique({ where: {
      // id } })` would let a crafted `brokerConnectionId` attach ANOTHER user's
      // broker identity (broker / brokerUserId / brokerName) onto this user's
      // imported trades. Mirrors the web action + web job processor, which both
      // already scope this as `findFirst({ where: { id, userId } })`.
      const connection = await prisma.brokerConnection.findFirst({
        where: { id: brokerConnectionId, userId },
        select: { broker: true, brokerUserId: true },
      });
      if (connection) {
        connBroker = connection.broker;
        connBrokerUserId = connection.brokerUserId || undefined;
      }
    }

    for (let idx = 0; idx < validTrades.length; idx++) {
      const trade = validTrades[idx];
      if (!trade) continue;
      try {
        const tradeHash = generateDuplicateHash(trade);

        // Check for duplicate using hash
        const existing = await prisma.trade.findFirst({
          where: {
            userId,
            duplicateHash: tradeHash,
          },
        });

        if (existing) {
          skipped++;
          continue;
        }

        // Build the Trade-create payload via the shared pure helper, which
        // finite-guards `tradeValue` (quantity*price): a row whose product
        // overflows to ±Infinity is REJECTED here rather than persisting a
        // corrupt non-finite tradeValue that would poison every P&L sum.
        const built = buildTradeCreateData(trade, tradeHash, idx, {
          userId,
          jobId,
          broker: connBroker,
          brokerUserId: connBrokerUserId,
        });
        if (!built.ok) {
          importErrors.push(built.reason);
          continue;
        }

        await prisma.trade.create({ data: built.data });

        imported++;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          skipped++;
        } else {
          importErrors.push(
            `${trade.symbol}: ${error instanceof Error ? error.message : "Insert error"}`,
          );
        }
      }
    }

    console.log(
      `Import job ${jobId} completed: ${imported} imported, ${skipped} skipped, ${importErrors.length} errors`,
    );

    // Update job status to COMPLETED
    await prisma.backgroundJob.updateMany({
      where: { jobId },
      data: buildJobStatusUpdate("COMPLETED", {
        result: buildImportResult(
          imported,
          skipped,
          validTrades.length,
          importErrors,
        ),
      }),
    });

    // Create ImportLog entry so this import appears in history
    const importStatus = resolveImportStatus(imported, importErrors.length);

    // Upsert ImportLog (handles Pub/Sub retries - importBatchId is @unique)
    await upsertImportLog({
      userId,
      importBatchId: jobId,
      fileName: fileName || null,
      fileSize: null,
      brokerFormat,
      linkedBroker: connBroker || null,
      linkedBrokerUserId: connBrokerUserId || null,
      linkedToManual: linkToManual || false,
      totalRows: parseResult.rows.length,
      importedCount: imported,
      skippedCount: skipped,
      duplicateCount: skipped, // skipped trades are duplicates in worker flow
      errorCount: importErrors.length,
      errorDetails:
        importErrors.length > 0
          ? importErrors.map((e, i) => ({ row: i, error: e }))
          : null,
      status: importStatus,
      completedAt: new Date(),
    });

    // Invalidate trade/dashboard cache
    await clearTradeCache(userId).catch((err) =>
      console.warn(`Cache invalidation failed for user ${userId}:`, err),
    );

    // Create notification
    await createNotification({
      userId,
      type: "IMPORT_COMPLETE",
      title: "Trade Import Complete",
      message: `Imported ${imported} trades${skipped > 0 ? `, ${skipped} skipped` : ""}.`,
      metadata: { jobId, imported, skipped, link: "/tradebook/import/history" },
    });

    // MONEY-840: re-trigger FIFO trade pairing IN-PROCESS after a successful
    // import, so the just-imported trades pair against the user's history and the
    // tradebook reads CLOSED/OPEN/PARTIAL + realised P&L from the persisted
    // PairedTradeView. Only when something was actually imported — an all-skip
    // (duplicates) import changes no rows, so a re-pair would be wasted work.
    // Wrapped in its OWN try/catch — the import has ALREADY succeeded, so a
    // pairing failure must NOT fail the job (it would re-deliver + re-insert).
    // processPairing is called with ONLY { jobId, userId } (it self-enriches).
    if (imported > 0) {
      try {
        await processPairing({ jobId: randomUUID(), userId });
      } catch (pairErr) {
        console.warn(`Import job ${jobId}: post-import pairing failed:`, pairErr);
      }
    }
  } catch (error) {
    console.error(`Import job ${jobId} failed:`, error);

    await prisma.backgroundJob.updateMany({
      where: { jobId },
      data: buildJobStatusUpdate("FAILED", {
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      }),
    });

    // Create ImportLog for failed imports so they show in history
    await upsertImportLog({
      userId,
      importBatchId: jobId,
      fileName: fileName || null,
      fileSize: null,
      brokerFormat,
      linkedBroker: null,
      linkedBrokerUserId: null,
      linkedToManual: linkToManual || false,
      totalRows: 0,
      importedCount: 0,
      skippedCount: 0,
      duplicateCount: 0,
      errorCount: 1,
      errorDetails: [
        {
          row: 0,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      ],
      status: "FAILED",
      completedAt: new Date(),
    }).catch((err) =>
      console.error(`Failed to upsert ImportLog for failed job ${jobId}:`, err),
    );

    throw error;
  }
}
