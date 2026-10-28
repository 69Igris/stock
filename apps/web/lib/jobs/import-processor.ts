"use server";

import { prisma } from "@usemoney/database";
import { revalidatePath } from "next/cache";
import type { BrokerType, TradeSource } from "@prisma/client";
import {
  createJob,
  startJob,
  updateJobProgress,
  completeJob,
  failJob,
} from "./job-service";
import { sanitizeErrorMessage } from "@usemoney/utils/error-sanitization";
import {
  parseCSVContent,
  parseXLSXContent,
  parseCSVRow,
  getColumnMapping,
  generateDuplicateHash,
  sanitizeFormulaInjection,
  type BrokerFormat,
  type ColumnMapping,
  type TradeRow,
  type ParsedFileData,
} from "@usemoney/core/import";

// ================== Types ==================

// BrokerFormat, ColumnMapping, TradeRow, ParsedFileData imported from @usemoney/core/import
export { type BrokerFormat } from "@usemoney/core/import";

export interface ImportJobPayload {
  content: string;
  brokerFormat: BrokerFormat;
  fileType: "csv" | "xlsx";
  fileName?: string;
  fileSize?: number;
  brokerConnectionId?: string;
  linkToManual?: boolean;
}

export interface ImportJobResult {
  success: boolean;
  imported: number;
  skipped: number;
  duplicateSynced: number;
  errors: string[];
  batchId: string;
  duplicates: {
    synced: number;
    sameAccount: number;
    differentAccount: number;
    upgraded: number;
    manual: number;
  };
  // Progress tracking fields
  stage?: string;
  totalRows?: number;
  validRows?: number;
  processedCount?: number;
}

// ================== User Helper ==================

async function getOrCreateUser(
  clerkUserId: string,
  email: string,
  name?: string
) {
  let user = await prisma.user.findFirst({
    where: {
      OR: [{ clerkId: clerkUserId }, { email }],
    },
  });

  if (!user) {
    user = await prisma.user.create({
      data: { email, name, clerkId: clerkUserId },
    });
  } else if (!user.clerkId) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { clerkId: clerkUserId },
    });
  }

  return user;
}

// Column mappings, parsers, normalizers, and hash generation imported from @usemoney/core/import

// ================== Main Import Job Processor ==================

const BATCH_SIZE = 50; // Process 50 trades at a time for progress updates

export async function processImportJob(
  jobId: string,
  userId: string,
  payload: ImportJobPayload
): Promise<ImportJobResult> {
  const emptyDuplicates = {
    synced: 0,
    sameAccount: 0,
    differentAccount: 0,
    upgraded: 0,
    manual: 0,
  };
  const batchId = `import_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const errors: string[] = [];
  const duplicateDetails: Array<any> = [];
  const errorDetails: Array<{ row: number; error: string }> = [];
  const duplicates = {
    synced: 0,
    sameAccount: 0,
    differentAccount: 0,
    upgraded: 0,
    manual: 0,
  };

  let imported = 0;
  let skipped = 0;

  try {
    await startJob(jobId);

    // Resolve broker connection
    let linkedBroker: BrokerType | null = null;
    let linkedBrokerUserId: string | null = null;

    if (payload.brokerConnectionId) {
      const connection = await prisma.brokerConnection.findFirst({
        where: { id: payload.brokerConnectionId, userId },
      });
      if (connection) {
        linkedBroker = connection.broker;
        linkedBrokerUserId = connection.brokerUserId;
      }
    }

    const isLinkingToManual = payload.linkToManual === true;
    const isEditable = linkedBroker === null;

    // Sanitize and parse file
    const sanitizedContent =
      payload.fileType !== "xlsx"
        ? sanitizeFormulaInjection(payload.content)
        : payload.content;

    const parseResult =
      payload.fileType === "xlsx"
        ? parseXLSXContent(sanitizedContent)
        : parseCSVContent(sanitizedContent);

    if (parseResult.errors.length > 0) {
      await failJob(
        jobId,
        "Unable to parse file. Please check the file format and try again."
      );
      return {
        success: false,
        imported: 0,
        skipped: 0,
        duplicateSynced: 0,
        errors: [
          "Unable to parse file. Please ensure it's a valid CSV or Excel file from your broker.",
        ],
        batchId: "",
        duplicates: emptyDuplicates,
      };
    }

    const rows = parseResult.rows;
    if (rows.length === 0) {
      await failJob(jobId, "No data rows found");
      return {
        success: false,
        imported: 0,
        skipped: 0,
        duplicateSynced: 0,
        errors: ["No data rows found"],
        batchId: "",
        duplicates: emptyDuplicates,
      };
    }

    const columnMap = getColumnMapping(payload.brokerFormat);
    const totalRows = rows.length;

    // Parse all rows first
    const parsedRows = rows.map((row, index) =>
      parseCSVRow(row, columnMap, index + 2)
    );

    // Separate valid and invalid rows
    const validRows: typeof parsedRows = [];
    for (const parsed of parsedRows) {
      if (parsed.error) {
        errorDetails.push({ row: parsed.rowNumber, error: parsed.error });
        errors.push(`Row ${parsed.rowNumber}: ${parsed.error}`);
        skipped++;
      } else {
        validRows.push(parsed);
      }
    }

    // Update progress - parsing complete (10%)
    await updateJobProgress(jobId, 10, {
      stage: "parsing_complete",
      totalRows,
      validRows: validRows.length,
    });

    // Generate hashes and build duplicate map
    const hashToRowMap = new Map<string, typeof parsedRows>();
    for (const parsed of validRows) {
      const hash = generateDuplicateHash({
        symbol: parsed.data.symbol,
        tradeDate: parsed.data.tradeDate,
        tradeType: parsed.data.tradeType,
        quantity: parsed.data.quantity,
        price: parsed.data.price,
        exchange: parsed.data.exchange,
        segment: parsed.data.segment,
      });
      const existing = hashToRowMap.get(hash) || [];
      existing.push(parsed);
      hashToRowMap.set(hash, existing);
    }

    // Get existing trades with matching hashes
    const allHashes = Array.from(hashToRowMap.keys());
    const existingTrades = await prisma.trade.findMany({
      where: { userId, duplicateHash: { in: allHashes } },
      select: {
        id: true,
        duplicateHash: true,
        sourceType: true,
        broker: true,
        brokerUserId: true,
      },
    });

    const duplicateMap = new Map<string, typeof existingTrades>();
    for (const trade of existingTrades) {
      if (!trade.duplicateHash) continue;
      const list = duplicateMap.get(trade.duplicateHash) || [];
      list.push(trade);
      duplicateMap.set(trade.duplicateHash, list);
    }

    // Update progress - duplicate check complete (20%)
    await updateJobProgress(jobId, 20, { stage: "duplicate_check_complete" });

    // Process in batches
    const processedHashes = new Set<string>();
    let processedCount = 0;

    for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
      const batch = validRows.slice(i, i + BATCH_SIZE);

      // Use transaction for each batch
      await prisma.$transaction(async (tx) => {
        for (const parsed of batch) {
          const hash = generateDuplicateHash({
            symbol: parsed.data.symbol,
            tradeDate: parsed.data.tradeDate,
            tradeType: parsed.data.tradeType,
            quantity: parsed.data.quantity,
            price: parsed.data.price,
            exchange: parsed.data.exchange,
            segment: parsed.data.segment,
          });

          // Skip in-batch duplicates
          if (processedHashes.has(hash)) {
            duplicates.sameAccount++;
            skipped++;
            continue;
          }

          // Check database duplicates
          const existingList = duplicateMap.get(hash);
          if (existingList && existingList.length > 0) {
            const existing = existingList[0];
            if (existing.sourceType === "SYNCED") {
              duplicates.synced++;
              skipped++;
              continue;
            }
            if (existing.sourceType === "MANUAL" && linkedBroker) {
              // Upgrade manual to broker-linked
              await tx.trade.update({
                where: { id: existing.id },
                data: {
                  broker: linkedBroker,
                  brokerUserId: linkedBrokerUserId,
                  sourceType: "IMPORTED",
                  isEditable: false,
                  importBatchId: batchId,
                  needsRepairing: true,
                },
              });
              duplicates.upgraded++;
              imported++;
              processedHashes.add(hash);
              continue;
            }
            // Skip other duplicates
            if (existing.broker === linkedBroker) {
              duplicates.sameAccount++;
            } else {
              duplicates.manual++;
            }
            skipped++;
            continue;
          }

          // Create new trade
          try {
            // Check for existing trade by brokerTradeId to prevent unique constraint error
            const brokerTradeId = parsed.data.tradeId || null;
            if (brokerTradeId && linkedBroker) {
              const existingByTradeId = await tx.trade.findFirst({
                where: {
                  userId,
                  broker: linkedBroker,
                  brokerUserId: linkedBrokerUserId,
                  brokerTradeId: brokerTradeId,
                },
              });

              if (existingByTradeId) {
                // Trade already exists by broker trade ID - skip
                duplicates.sameAccount++;
                skipped++;
                processedHashes.add(hash);
                continue;
              }
            }

            await tx.trade.create({
              data: {
                userId,
                symbol: parsed.data.symbol,
                tradingSymbol: parsed.data.isin || parsed.data.symbol,
                exchange: parsed.data.exchange,
                segment: parsed.data.segment,
                tradeType: parsed.data.tradeType,
                positionType:
                  parsed.data.tradeType === "BUY" ? "LONG" : "SHORT",
                orderType: parsed.data.orderType || "MARKET",
                productType: parsed.data.productType || "CNC",
                quantity: parsed.data.quantity,
                price: parsed.data.price,
                tradeValue: parsed.data.quantity * parsed.data.price,
                tradeDate: parsed.data.tradeDate,
                tradeTime: parsed.data.tradeTime
                  ? new Date(parsed.data.tradeTime)
                  : null,
                status: "OPEN",
                broker: linkedBroker,
                brokerUserId: linkedBrokerUserId,
                sourceType: isLinkingToManual ? "MANUAL" : "IMPORTED",
                isEditable,
                importBatchId: batchId,
                brokerTradeId: brokerTradeId,
                brokerOrderId: parsed.data.orderId || null,
                needsRepairing: true,
                duplicateHash: hash,
                brokerage: parsed.data.segment === "MF" ? 0 : 20,
                totalCharges: parsed.data.segment === "MF" ? 0 : 20,
              },
            });
            imported++;
            processedHashes.add(hash);
          } catch (error) {
            const userFriendlyError = sanitizeErrorMessage(
              error instanceof Error ? error.message : "Unknown error"
            );
            errorDetails.push({
              row: parsed.rowNumber,
              error: userFriendlyError,
            });
            errors.push(`Row ${parsed.rowNumber}: ${userFriendlyError}`);
            skipped++;
          }
        }
      });

      processedCount += batch.length;
      const progress = Math.round(
        20 + (processedCount / validRows.length) * 70
      ); // 20-90%
      await updateJobProgress(jobId, progress, {
        imported,
        skipped,
        processedCount,
      });
    }

    // Create import log
    await prisma.importLog.create({
      data: {
        userId,
        importBatchId: batchId,
        fileName: payload.fileName || null,
        fileSize: payload.fileSize || null,
        brokerFormat: payload.brokerFormat,
        linkedBroker,
        linkedBrokerUserId,
        linkedToManual: isLinkingToManual,
        totalRows,
        importedCount: imported,
        skippedCount: skipped,
        duplicateCount:
          duplicates.synced +
          duplicates.sameAccount +
          duplicates.differentAccount +
          duplicates.manual,
        errorCount: errorDetails.length,
        duplicateDetails: duplicateDetails.length > 0 ? duplicateDetails : null,
        errorDetails: errorDetails.length > 0 ? errorDetails : null,
        status: imported > 0 ? "COMPLETED" : "PARTIALLY_COMPLETED",
        completedAt: new Date(),
      },
    });

    // Complete job
    const result: ImportJobResult = {
      success: imported > 0,
      imported,
      skipped,
      duplicateSynced: duplicates.synced,
      errors: errors.slice(0, 10),
      batchId,
      duplicates,
    };

    await completeJob(jobId, result as unknown as Record<string, unknown>);
    revalidatePath("/tradebook");

    return result;
  } catch (error) {
    const rawError = error instanceof Error ? error.message : "Unknown error";
    const userFriendlyError = sanitizeErrorMessage(rawError);
    await failJob(jobId, userFriendlyError, { imported, skipped, batchId });

    return {
      success: false,
      imported,
      skipped,
      duplicateSynced: duplicates.synced,
      errors: [
        userFriendlyError,
        ...errors.map(sanitizeErrorMessage).slice(0, 5),
      ],
      batchId,
      duplicates,
    };
  }
}
