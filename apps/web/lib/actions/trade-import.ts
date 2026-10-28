"use server";

import { auth } from "@clerk/nextjs/server";
import { prisma } from "@usemoney/database";
import { getOrCreateDbUser } from "@/lib/db/user";
import { revalidatePath } from "next/cache";
import type { BrokerType, TradeSource } from "@prisma/client";
import {
  sanitizeErrorMessage,
  sanitizeErrors,
  getSafeErrorMessage,
} from "@usemoney/utils/error-sanitization";
import {
  sendEmail,
  getEffectivePreferences,
  shouldSendEmail,
  buildUnsubscribeUrl,
} from "@usemoney/email";
import {
  TradeImportCompleteEmail,
  TradeImportFailedEmail,
} from "@usemoney/email/templates";
import { getAuthenticatedUser } from "@/lib/auth";
import { dbLogger as logger } from "@usemoney/logger";
import {
  getImportHistory,
  getImportById,
  deleteImport,
} from "@usemoney/services";
import React from "react";
import {
  parseCSVContent,
  parseXLSXContent,
  parseCSVRow,
  getColumnMapping,
  generateDuplicateHash,
  sanitizeFormulaInjection,
  resolveEffectiveBrokerFormat,
  brokerFormatLabel,
  type BrokerFormat,
  type TradeRow,
  type ParsedTradeRow,
  type ParsedFileData,
} from "@usemoney/core/import";

// ================== User Helper ==================

// MONEY-1062 (W2-B): the inferior inline copy is deleted in favour of the
// canonical getOrCreateDbUser (lib/db/user.ts). The old copy checked only
// PENDING/PROCESSING deletion states (MISSING the LOCKED guard) AND called
// currentUser() UNCONDITIONALLY (a redundant Clerk round-trip on every import);
// getOrCreateDbUser fast-paths existing users by clerkId, adds the LOCKED guard,
// the 5-min cache, P2002 race-retry, and Clerk-404 handling. This wrapper only
// adapts the Clerk-session → clerkUserId boundary.
async function getOrCreateUser() {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    return null;
  }
  return getOrCreateDbUser(clerkUserId);
}

// ================== Duplicate Detection ==================

interface ExistingTrade {
  id: string;
  duplicateHash: string | null;
  sourceType: TradeSource;
  broker: BrokerType | null;
  brokerUserId: string | null;
  brokerTradeId: string | null;
  importBatchId: string | null;
}

interface DuplicateResolution {
  action: "SKIP" | "IMPORT" | "UPGRADE" | "PROMPT";
  reason: string;
  existingTrade?: ExistingTrade;
  promptOptions?: {
    currentBroker: string;
    newBroker: string;
  };
}

/**
 * Build a map of existing trades by their duplicate hash
 */
async function buildDuplicateMap(
  userId: string,
  hashes: string[]
): Promise<Map<string, ExistingTrade[]>> {
  if (hashes.length === 0) return new Map();

  const existing = await prisma.trade.findMany({
    where: {
      userId,
      duplicateHash: { in: hashes },
    },
    select: {
      id: true,
      duplicateHash: true,
      sourceType: true,
      broker: true,
      brokerUserId: true,
      brokerTradeId: true,
      importBatchId: true,
    },
  });

  const map = new Map<string, ExistingTrade[]>();
  for (const trade of existing) {
    if (!trade.duplicateHash) continue;
    const list = map.get(trade.duplicateHash) || [];
    list.push(trade);
    map.set(trade.duplicateHash, list);
  }
  return map;
}

/**
 * Priority order for duplicate resolution:
 * 1. SYNCED (highest - immutable broker sync)
 * 2. IMPORTED with broker link
 * 3. MANUAL
 * 4. IMPORTED without link (lowest)
 */
function getTradePriority(trade: ExistingTrade): number {
  if (trade.sourceType === "SYNCED") return 4;
  if (trade.sourceType === "IMPORTED" && trade.broker) return 3;
  if (trade.sourceType === "MANUAL") return 2;
  return 1; // IMPORTED without broker
}

/**
 * Resolve duplicate based on priority rules
 */
function resolveDuplicate(
  existing: ExistingTrade[],
  newLinking: { broker: BrokerType | null; manual: boolean }
): DuplicateResolution {
  // Sort by priority (highest first)
  const sorted = existing.sort(
    (a, b) => getTradePriority(b) - getTradePriority(a)
  );
  const highest = sorted[0];

  // Case: Synced trade exists
  if (highest.sourceType === "SYNCED") {
    if (newLinking.broker === highest.broker) {
      return {
        action: "SKIP",
        reason: `Already synced from ${highest.broker}`,
        existingTrade: highest,
      };
    }
    if (newLinking.manual) {
      return {
        action: "SKIP",
        reason: `Already synced from ${highest.broker}. Manual discarded.`,
        existingTrade: highest,
      };
    }
    if (newLinking.broker && newLinking.broker !== highest.broker) {
      return {
        action: "SKIP", // Skip by default for cross-broker conflicts
        reason: `Trade exists linked to ${highest.broker}. Cannot link to ${newLinking.broker}.`,
        existingTrade: highest,
        promptOptions: {
          currentBroker: highest.broker!,
          newBroker: newLinking.broker,
        },
      };
    }
    return {
      action: "SKIP",
      reason: `Already synced from ${highest.broker}`,
      existingTrade: highest,
    };
  }

  // Case: Manual trade exists, new is broker-linked
  if (highest.sourceType === "MANUAL" && newLinking.broker) {
    return {
      action: "UPGRADE",
      reason: `Upgrading from Manual to ${newLinking.broker}`,
      existingTrade: highest,
    };
  }

  // Case: Imported with same broker linking
  if (highest.broker === newLinking.broker) {
    return {
      action: "SKIP",
      reason: highest.broker
        ? `Already imported for ${highest.broker}`
        : "Duplicate import",
      existingTrade: highest,
    };
  }

  // Case: Imported with different broker
  if (
    highest.broker &&
    newLinking.broker &&
    highest.broker !== newLinking.broker
  ) {
    return {
      action: "SKIP",
      reason: `Trade exists linked to ${highest.broker}`,
      existingTrade: highest,
      promptOptions: {
        currentBroker: highest.broker,
        newBroker: newLinking.broker,
      },
    };
  }

  // Default: Skip duplicate
  return {
    action: "SKIP",
    reason: "Duplicate trade",
    existingTrade: highest,
  };
}

// ================== Types ==================

// Re-export BrokerFormat for consumers that imported it from this file
export { type BrokerFormat } from "@usemoney/core/import";

interface ImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  duplicateSynced: number; // Count of trades that matched already synced trades
  errors: string[];
  batchId: string;
  // Enhanced duplicate tracking
  duplicates: {
    synced: number; // Duplicates of synced broker trades
    sameAccount: number; // Duplicates of same account imports
    differentAccount: number; // Duplicates linked to different account
    upgraded: number; // Manual trades upgraded to broker-linked
    manual: number; // Duplicates of manual trades
  };
  hasImportLog: boolean; // Whether an import log was created
}

// Column mappings, normalizers, parsers, and hash generation imported from @usemoney/core/import

// ================== Main Import Action ==================

export interface ImportOptions {
  skipDuplicates?: boolean;
  markAsEditable?: boolean;
  // Broker linking options
  brokerConnectionId?: string; // Link to specific broker connection
  linkedBroker?: BrokerType; // Broker type to link
  linkedBrokerUserId?: string; // Broker user ID to link
  linkToManual?: boolean; // Link to manual account (no broker, editable)
}

export async function importTradesFromCSVAction(
  content: string,
  brokerFormat: BrokerFormat,
  options?: ImportOptions,
  fileType: "csv" | "xlsx" = "csv",
  fileName?: string,
  fileSize?: number
): Promise<ImportResult> {
  const user = await getOrCreateUser();
  const emptyDuplicates = {
    synced: 0,
    sameAccount: 0,
    differentAccount: 0,
    upgraded: 0,
    manual: 0,
  };

  if (!user) {
    return {
      success: false,
      imported: 0,
      skipped: 0,
      duplicateSynced: 0,
      errors: ["Unauthorized - please sign in"],
      batchId: "",
      duplicates: emptyDuplicates,
      hasImportLog: false,
    };
  }

  const batchId = `import_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const columnMap = getColumnMapping(brokerFormat);
  const errors: string[] = [];
  const duplicateDetails: Array<{
    tradeHash: string;
    reason: string;
    existingBroker: string | null;
    existingSourceType: string;
    rowNumber: number;
  }> = [];
  const errorDetails: Array<{
    row: number;
    error: string;
    data?: TradeRow; // Store full row data for retry
  }> = [];

  let imported = 0;
  let skipped = 0;

  // Enhanced duplicate counters
  const duplicates = {
    synced: 0,
    sameAccount: 0,
    differentAccount: 0,
    upgraded: 0,
    manual: 0,
  };

  // Resolve broker connection if provided
  let linkedBroker: BrokerType | null = null;
  let linkedBrokerUserId: string | null = null;

  if (options?.brokerConnectionId) {
    const connection = await prisma.brokerConnection.findFirst({
      where: {
        id: options.brokerConnectionId,
        userId: user.id,
      },
    });
    if (connection) {
      linkedBroker = connection.broker;
      linkedBrokerUserId = connection.brokerUserId;
    } else {
      logger.warn(
        { brokerConnectionId: options.brokerConnectionId, userId: user.id },
        "import: brokerConnectionId did not resolve — importing unlinked"
      );
    }
  } else if (options?.linkedBroker) {
    linkedBroker = options.linkedBroker;
    linkedBrokerUserId = options.linkedBrokerUserId || null;
  }

  // Determine linking mode
  const isLinkingToManual = options?.linkToManual === true;
  const isLinkingToBroker = linkedBroker !== null;

  // Determine if trades should be editable
  // Linked to synced broker = not editable, Manual/unlinked = editable
  const isEditable = isLinkingToBroker ? false : true;

  try {
    // Sanitize CSV content to prevent formula injection
    const sanitizedContent =
      fileType !== "xlsx" ? sanitizeFormulaInjection(content) : content;

    // Parse file based on type
    const parseResult =
      fileType === "xlsx"
        ? parseXLSXContent(sanitizedContent)
        : parseCSVContent(sanitizedContent);

    if (parseResult.errors.length > 0) {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        duplicateSynced: 0,
        errors: [
          `${fileType.toUpperCase()} parsing errors:`,
          ...parseResult.errors.slice(0, 5),
        ],
        batchId: "",
        duplicates: emptyDuplicates,
        hasImportLog: false,
      };
    }

    const rows = parseResult.rows;
    if (rows.length === 0) {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        duplicateSynced: 0,
        errors: [`No data rows found in ${fileType.toUpperCase()} file`],
        batchId: "",
        duplicates: emptyDuplicates,
        hasImportLog: false,
      };
    }

    // Parse and validate each row
    const parsedRows: ParsedTradeRow[] = rows.map(
      (row, index) => parseCSVRow(row, columnMap, index + 2) // +2 for 1-based + header row
    );

    // Generate duplicate hashes for all valid rows
    const hashToRowMap = new Map<string, ParsedTradeRow[]>();
    const validParsedRows: ParsedTradeRow[] = [];

    for (const parsed of parsedRows) {
      if (parsed.error) {
        errorDetails.push({ row: parsed.rowNumber, error: parsed.error });
        errors.push(`Row ${parsed.rowNumber}: ${parsed.error}`);
        skipped++;
        continue;
      }
      validParsedRows.push(parsed);

      // Generate hash for duplicate detection
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

    // Build duplicate map from existing trades in database
    const allHashes = Array.from(hashToRowMap.keys());
    const duplicateMap = await buildDuplicateMap(user.id, allHashes);

    // Process each valid row with duplicate detection
    const processedHashes = new Set<string>();

    for (const parsed of validParsedRows) {
      const hash = generateDuplicateHash({
        symbol: parsed.data.symbol,
        tradeDate: parsed.data.tradeDate,
        tradeType: parsed.data.tradeType,
        quantity: parsed.data.quantity,
        price: parsed.data.price,
        exchange: parsed.data.exchange,
        segment: parsed.data.segment,
      });

      // Check if already processed in this batch (in-batch duplicate)
      if (processedHashes.has(hash)) {
        duplicates.sameAccount++;
        skipped++;
        duplicateDetails.push({
          tradeHash: hash,
          reason: "Duplicate within import batch",
          existingBroker: null,
          existingSourceType: "BATCH",
          rowNumber: parsed.rowNumber,
        });
        continue;
      }

      // Check for existing duplicates in database
      const existingTrades = duplicateMap.get(hash);
      if (existingTrades && existingTrades.length > 0) {
        const resolution = resolveDuplicate(existingTrades, {
          broker: linkedBroker,
          manual: isLinkingToManual,
        });

        if (resolution.action === "SKIP") {
          // Categorize the skip reason
          const existing = resolution.existingTrade!;
          if (existing.sourceType === "SYNCED") {
            duplicates.synced++;
          } else if (existing.sourceType === "MANUAL") {
            duplicates.manual++;
          } else if (existing.broker === linkedBroker) {
            duplicates.sameAccount++;
          } else if (
            existing.broker &&
            linkedBroker &&
            existing.broker !== linkedBroker
          ) {
            duplicates.differentAccount++;
          } else {
            duplicates.sameAccount++;
          }

          skipped++;
          duplicateDetails.push({
            tradeHash: hash,
            reason: resolution.reason,
            existingBroker: existing.broker,
            existingSourceType: existing.sourceType,
            rowNumber: parsed.rowNumber,
          });
          continue;
        }

        if (resolution.action === "UPGRADE") {
          // Upgrade existing manual trade to broker-linked
          try {
            await prisma.trade.update({
              where: { id: resolution.existingTrade!.id },
              data: {
                broker: linkedBroker,
                brokerUserId: linkedBrokerUserId,
                sourceType: "IMPORTED",
                isEditable: false,
                importBatchId: batchId,
                linkedUpdatedAt: new Date(),
                linkedUpdatedFrom: "MANUAL",
                needsRepairing: true,
              },
            });
            duplicates.upgraded++;
            imported++;
            processedHashes.add(hash);
          } catch (error) {
            errors.push(
              `Row ${parsed.rowNumber}: Failed to upgrade - ${getSafeErrorMessage(error, "Unknown error")}`
            );
            skipped++;
          }
          continue;
        }
      }

      // No duplicate or allowed to import - create new trade
      try {
        // Check for existing trade by brokerTradeId if present (prevents unique constraint error)
        const brokerTradeId = parsed.data.tradeId || null;
        if (brokerTradeId && linkedBroker) {
          const existingByTradeId = await prisma.trade.findFirst({
            where: {
              userId: user.id,
              broker: linkedBroker,
              brokerUserId: linkedBrokerUserId,
              brokerTradeId: brokerTradeId,
            },
          });

          if (existingByTradeId) {
            // Trade already exists by broker trade ID - skip
            duplicates.sameAccount++;
            skipped++;
            duplicateDetails.push({
              tradeHash: hash,
              reason: `Trade ID ${brokerTradeId} already imported for ${linkedBroker}`,
              existingBroker: linkedBroker,
              existingSourceType: existingByTradeId.sourceType,
              rowNumber: parsed.rowNumber,
            });
            continue;
          }
        }

        await prisma.trade.create({
          data: {
            userId: user.id,
            symbol: parsed.data.symbol,
            tradingSymbol: parsed.data.isin || parsed.data.symbol,
            isin: parsed.data.isin || null,
            exchange: parsed.data.exchange,
            segment: parsed.data.segment,
            tradeType: parsed.data.tradeType,
            positionType: parsed.data.tradeType === "BUY" ? "LONG" : "SHORT",
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

            // Broker linking
            broker: linkedBroker,
            brokerUserId: linkedBrokerUserId,

            // Import-specific fields
            sourceType: isLinkingToManual ? "MANUAL" : "IMPORTED",
            isEditable,
            importBatchId: batchId,
            brokerTradeId: brokerTradeId,
            brokerOrderId: parsed.data.orderId || null,
            needsRepairing: true,

            // Duplicate detection
            duplicateHash: hash,

            // Default charges
            brokerage: parsed.data.segment === "MF" ? 0 : 20,
            totalCharges: parsed.data.segment === "MF" ? 0 : 20,
          },
        });
        imported++;
        processedHashes.add(hash);
      } catch (error) {
        const userFriendlyError = getSafeErrorMessage(error, "Unknown error");
        errorDetails.push({
          row: parsed.rowNumber,
          error: userFriendlyError,
          data: parsed.data, // Store row data for retry
        });
        errors.push(`Row ${parsed.rowNumber}: ${userFriendlyError}`);
        skipped++;
      }
    }

    // Create ImportLog entry for tracking
    let hasImportLog = false;
    try {
      await prisma.importLog.create({
        data: {
          userId: user.id,
          importBatchId: batchId,
          fileName: fileName || null,
          fileSize: fileSize || null,
          brokerFormat,
          linkedBroker,
          linkedBrokerUserId,
          linkedToManual: isLinkingToManual,
          totalRows: rows.length,
          importedCount: imported,
          skippedCount: skipped,
          duplicateCount:
            duplicates.synced +
            duplicates.sameAccount +
            duplicates.differentAccount +
            duplicates.manual,
          errorCount: errorDetails.length,
          duplicateDetails:
            duplicateDetails.length > 0 ? duplicateDetails : null,
          errorDetails:
            errorDetails.length > 0
              ? errorDetails.map((e) => ({
                  row: e.row,
                  error: e.error,
                  data: e.data
                    ? {
                        ...e.data,
                        // Convert Date objects to ISO strings for JSON storage
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
          status:
            errorDetails.length === 0
              ? "COMPLETED"
              : imported > 0
                ? "PARTIALLY_COMPLETED"
                : "FAILED",
          completedAt: new Date(),
        },
      });
      hasImportLog = true;
    } catch (logError) {
      logger.error(
        { logError, userId: user.id, batchId },
        "ImportLog write failed"
      );
    }

    // Revalidate tradebook page
    revalidatePath("/tradebook");

    // Calculate legacy duplicateSynced for backward compatibility
    const duplicateSynced = duplicates.synced;

    // Send trade import complete email (fire-and-forget, preference-gated).
    // getOrCreateDbUser returns a lean DbUser (no emailPreferences) — read it here.
    if (imported > 0) {
      const prefUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { emailPreferences: true },
      });
      const importPrefs = getEffectivePreferences(prefUser?.emailPreferences);
      if (shouldSendEmail(importPrefs, "trade-import-complete")) {
        const unsubUrl = buildUnsubscribeUrl(user.email, "tradeAlerts");
        sendEmail({
          to: user.email,
          subject: `Trade Import Complete - ${imported} trades imported`,
          unsubscribeUrl: unsubUrl,
          react: React.createElement(TradeImportCompleteEmail, {
            name: user.name || "there",
            importedCount: imported,
            skippedCount: skipped,
            duplicateCount: duplicateSynced,
            unsubscribeUrl: unsubUrl,
          }),
          template: "trade-import-complete",
        });
      }
    }

    return {
      success: imported > 0,
      imported,
      skipped,
      duplicateSynced,
      errors: sanitizeErrors(errors.slice(0, 10)),
      batchId,
      duplicates,
      hasImportLog,
    };
  } catch (error) {
    // Try to create a failed import log
    try {
      await prisma.importLog.create({
        data: {
          userId: user.id,
          importBatchId: batchId,
          fileName: fileName || null,
          fileSize: fileSize || null,
          brokerFormat,
          linkedBroker,
          linkedBrokerUserId,
          linkedToManual: isLinkingToManual,
          totalRows: 0,
          importedCount: 0,
          skippedCount: 0,
          duplicateCount: 0,
          errorCount: 1,
          errorDetails: [
            {
              row: 0,
              error: getSafeErrorMessage(error, "Unknown error"),
            },
          ],
          status: "FAILED",
          completedAt: new Date(),
        },
      });
    } catch (logError) {
      logger.error(
        { logError, userId: user.id, batchId },
        "ImportLog write failed (failure path)"
      );
    }

    // Send trade import failed email (fire-and-forget, preference-gated).
    // getOrCreateDbUser returns a lean DbUser (no emailPreferences) — read it here.
    const prefUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { emailPreferences: true },
    });
    const failPrefs = getEffectivePreferences(prefUser?.emailPreferences);
    if (shouldSendEmail(failPrefs, "trade-import-failed")) {
      const unsubUrl = buildUnsubscribeUrl(user.email, "tradeAlerts");
      sendEmail({
        to: user.email,
        subject: "Trade Import Failed - UseMoney",
        unsubscribeUrl: unsubUrl,
        react: React.createElement(TradeImportFailedEmail, {
          name: user.name || "there",
          errorMessage: getSafeErrorMessage(error, "Unknown error occurred"),
          unsubscribeUrl: unsubUrl,
        }),
        template: "trade-import-failed",
      });
    }

    return {
      success: false,
      imported: 0,
      skipped: 0,
      duplicateSynced: 0,
      errors: [`Import failed: ${getSafeErrorMessage(error, "Unknown error")}`],
      batchId: "",
      duplicates: emptyDuplicates,
      hasImportLog: false,
    };
  }
}

// ================== Preview Action ==================

export interface PreviewRow {
  rowNumber: number;
  symbol: string;
  tradeDate: string;
  exchange: string;
  segment: string;
  tradeType: string;
  quantity: number;
  price: number;
  error?: string;
}

export interface PreviewResult {
  success: boolean;
  rows: PreviewRow[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  columns: string[];
  errors: string[];
  /**
   * The broker format actually used to parse (MONEY-1074). In auto-detect mode
   * this is the format the header row matched (`generic` if nothing matched);
   * with an explicit broker choice it echoes that choice. Drives the wizard's
   * "Detected as …" badge and the format the import job is started with.
   */
  detectedFormat?: BrokerFormat;
  /** Human-readable label for `detectedFormat` (e.g. "Fyers", "Standard format"). */
  detectedLabel?: string;
}

// Support both old name (previewCSVAction) and new name (previewFileAction)
export async function previewCSVAction(
  content: string,
  brokerFormat: BrokerFormat,
  fileType: "csv" | "xlsx" = "csv"
): Promise<PreviewResult> {
  return previewFileAction(content, brokerFormat, fileType);
}

export async function previewFileAction(
  content: string,
  brokerFormat: BrokerFormat,
  fileType: "csv" | "xlsx" = "csv"
): Promise<PreviewResult> {
  const authResult = await auth();
  if (!authResult?.userId) {
    return {
      success: false,
      rows: [],
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      columns: [],
      errors: ["Unauthorized - please sign in"],
    };
  }

  try {
    // Parse file based on type
    const parseResult =
      fileType === "xlsx"
        ? parseXLSXContent(content)
        : parseCSVContent(content);

    if (parseResult.errors.length > 0) {
      return {
        success: false,
        rows: [],
        totalRows: 0,
        validRows: 0,
        invalidRows: 0,
        columns: [],
        errors: parseResult.errors.slice(0, 5),
      };
    }

    const allRows = parseResult.rows;
    const columns = parseResult.columns;
    const totalRowCount = allRows.length;

    // Resolve the effective broker format (auto-detect on `generic`); shared
    // with the worker so preview and import agree (MONEY-1074).
    const effectiveFormat = resolveEffectiveBrokerFormat(brokerFormat, columns);
    const columnMap = getColumnMapping(effectiveFormat);

    const previewRows: PreviewRow[] = [];
    let validCount = 0;
    let invalidCount = 0;

    // Process ALL rows to get accurate counts
    for (let i = 0; i < allRows.length; i++) {
      const parsed = parseCSVRow(allRows[i], columnMap, i + 2);

      if (parsed.error) {
        invalidCount++;
        // Only add to preview array for first 50 rows (for display)
        if (i < 50) {
          previewRows.push({
            rowNumber: parsed.rowNumber,
            symbol: "-",
            tradeDate: "-",
            exchange: "-",
            segment: "-",
            tradeType: "-",
            quantity: 0,
            price: 0,
            error: parsed.error,
          });
        }
      } else {
        validCount++;
        // Only add to preview array for first 50 rows (for display)
        if (i < 50) {
          previewRows.push({
            rowNumber: parsed.rowNumber,
            symbol: parsed.data.symbol,
            tradeDate: parsed.data.tradeDate.toLocaleDateString("en-IN"),
            exchange: parsed.data.exchange,
            segment: parsed.data.segment,
            tradeType: parsed.data.tradeType,
            quantity: parsed.data.quantity,
            price: parsed.data.price,
          });
        }
      }
    }

    return {
      success: true,
      rows: previewRows,
      totalRows: totalRowCount,
      validRows: validCount,
      invalidRows: invalidCount,
      columns,
      errors: [],
      detectedFormat: effectiveFormat,
      detectedLabel: brokerFormatLabel(effectiveFormat),
    };
  } catch (error) {
    return {
      success: false,
      rows: [],
      totalRows: 0,
      validRows: 0,
      invalidRows: 0,
      columns: [],
      errors: [`Parse error: ${getSafeErrorMessage(error, "Unknown error")}`],
    };
  }
}

// ================== Delete Import Batch Action ==================

export async function deleteImportBatchAction(batchId: string): Promise<{
  success: boolean;
  deleted: number;
  error?: string;
}> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, deleted: 0, error: "Unauthorized" };
  }

  try {
    const result = await deleteImport(authUser.userId, batchId);

    if (!result?.success) {
      return { success: false, deleted: 0, error: result?.error };
    }

    revalidatePath("/tradebook");

    return {
      success: true,
      deleted: result?.data.deleted,
    };
  } catch (error) {
    return {
      success: false,
      deleted: 0,
      error: getSafeErrorMessage(error, "Failed to delete"),
    };
  }
}

// ================== Switch Import Broker Action ==================

export interface SwitchBrokerOptions {
  brokerConnectionId?: string; // Link to specific broker connection
  linkToManual?: boolean; // Link to manual account
  unlink?: boolean; // Remove all broker linking
}

export async function switchImportBrokerAction(
  importBatchId: string,
  options: SwitchBrokerOptions
): Promise<{
  success: boolean;
  updated: number;
  error?: string;
}> {
  const user = await getOrCreateUser();
  if (!user) {
    return { success: false, updated: 0, error: "Unauthorized" };
  }

  try {
    // Verify import belongs to user
    const importLog = await prisma.importLog.findFirst({
      where: { importBatchId, userId: user.id },
    });
    if (!importLog) {
      return { success: false, updated: 0, error: "Import not found" };
    }

    // Cannot switch if any trades are SYNCED
    const hasSynced = await prisma.trade.findFirst({
      where: { importBatchId, userId: user.id, sourceType: "SYNCED" },
    });
    if (hasSynced) {
      return {
        success: false,
        updated: 0,
        error: "Cannot modify synced trades",
      };
    }

    // Resolve new broker connection
    let newBroker: BrokerType | null = null;
    let newBrokerUserId: string | null = null;

    if (options.brokerConnectionId) {
      const conn = await prisma.brokerConnection.findFirst({
        where: { id: options.brokerConnectionId, userId: user.id },
      });
      if (conn) {
        newBroker = conn.broker;
        newBrokerUserId = conn.brokerUserId;
      } else {
        logger.warn(
          { brokerConnectionId: options.brokerConnectionId, userId: user.id },
          "import: brokerConnectionId did not resolve — importing unlinked"
        );
      }
    }

    // Get current linking for audit trail
    const firstTrade = await prisma.trade.findFirst({
      where: { importBatchId, userId: user.id },
      select: { broker: true, sourceType: true },
    });

    const previousBroker = firstTrade?.broker || null;
    const previousSourceType = firstTrade?.sourceType || "IMPORTED";

    // Determine new source type and editability
    let newSourceType: "IMPORTED" | "MANUAL" = "IMPORTED";
    let isEditable = true;

    if (options.linkToManual) {
      newSourceType = "MANUAL";
      isEditable = true;
    } else if (options.unlink) {
      newSourceType = "IMPORTED";
      isEditable = true;
    } else if (newBroker) {
      newSourceType = "IMPORTED";
      isEditable = false; // Broker-linked imports are not editable
    }

    // Update all trades in batch
    const result = await prisma.trade.updateMany({
      where: { importBatchId, userId: user.id },
      data: {
        broker: options.unlink ? null : newBroker,
        brokerUserId: options.unlink ? null : newBrokerUserId,
        sourceType: newSourceType,
        isEditable,
        linkedUpdatedAt: new Date(),
        linkedUpdatedFrom: previousBroker || previousSourceType,
        needsRepairing: true, // Re-pair after broker change
      },
    });

    // Update import log
    await prisma.importLog.update({
      where: { importBatchId },
      data: {
        linkedBroker: options.unlink ? null : newBroker,
        linkedBrokerUserId: options.unlink ? null : newBrokerUserId,
        linkedToManual: options.linkToManual || false,
      },
    });

    revalidatePath("/tradebook");

    return { success: true, updated: result.count };
  } catch (error) {
    return {
      success: false,
      updated: 0,
      error: getSafeErrorMessage(error, "Failed to switch broker"),
    };
  }
}

// ================== Get Import History Action ==================

export interface ImportBatch {
  batchId: string;
  importedAt: Date;
  tradeCount: number;
  // Enhanced fields from ImportLog
  fileName?: string | null;
  brokerFormat?: string;
  linkedBroker?: BrokerType | null;
  linkedBrokerUserId?: string | null;
  linkedToManual?: boolean;
  importedCount?: number;
  skippedCount?: number;
  duplicateCount?: number;
  errorCount?: number;
  status?: string;
}

export async function getImportHistoryAction(): Promise<{
  success: boolean;
  batches: ImportBatch[];
  error?: string;
}> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, batches: [], error: "Unauthorized" };
  }

  try {
    const result = await getImportHistory(authUser.userId);

    if (!result?.success) {
      return { success: false, batches: [], error: result?.error };
    }

    // Map service result to action's ImportBatch type
    const batches: ImportBatch[] = result?.data.map((item) => ({
      batchId: item.batchId,
      importedAt: item.importedAt,
      tradeCount: item.tradeCount,
      fileName: item.fileName,
      brokerFormat: item.brokerFormat,
      linkedBroker: item.linkedBroker as BrokerType | null | undefined,
      linkedBrokerUserId: item.linkedBrokerUserId,
      linkedToManual: item.linkedToManual,
      importedCount: item.importedCount,
      skippedCount: item.skippedCount,
      duplicateCount: item.duplicateCount,
      errorCount: item.errorCount,
      status: item.status,
    }));

    return { success: true, batches };
  } catch (error) {
    return {
      success: false,
      batches: [],
      error: getSafeErrorMessage(error, "Failed to fetch history"),
    };
  }
}

// ================== Get Import Log Detail Action ==================

export interface ImportLogDetail {
  batchId: string;
  fileName: string | null;
  fileSize: number | null;
  brokerFormat: string;
  linkedBroker: BrokerType | null;
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
    data?: TradeRow; // Stored for retry
  }> | null;
}

export async function getImportLogDetailAction(batchId: string): Promise<{
  success: boolean;
  log: ImportLogDetail | null;
  error?: string;
}> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, log: null, error: "Unauthorized" };
  }

  try {
    const result = await getImportById(authUser.userId, batchId);

    if (!result?.success) {
      return { success: false, log: null, error: result?.error };
    }

    // Map service result to action's ImportLogDetail type
    const detail = result?.data;
    const log: ImportLogDetail = {
      batchId: detail.batchId,
      fileName: detail.fileName,
      fileSize: detail.fileSize,
      brokerFormat: detail.brokerFormat,
      linkedBroker: detail.linkedBroker as BrokerType | null,
      linkedBrokerUserId: detail.linkedBrokerUserId,
      linkedToManual: detail.linkedToManual,
      totalRows: detail.totalRows,
      importedCount: detail.importedCount,
      skippedCount: detail.skippedCount,
      duplicateCount: detail.duplicateCount,
      errorCount: detail.errorCount,
      status: detail.status,
      createdAt: detail.createdAt,
      completedAt: detail.completedAt,
      duplicateDetails:
        detail.duplicateDetails as ImportLogDetail["duplicateDetails"],
      errorDetails: detail.errorDetails as ImportLogDetail["errorDetails"],
    };

    return { success: true, log };
  } catch (error) {
    return {
      success: false,
      log: null,
      error: getSafeErrorMessage(error, "Failed to fetch log"),
    };
  }
}

/**
 * Retry failed rows from a partial/failed import
 */
export async function retryFailedImportAction(batchId: string): Promise<{
  success: boolean;
  retried: number;
  succeeded: number;
  failed: number;
  error?: string;
}> {
  const user = await getOrCreateUser();
  if (!user) {
    return {
      success: false,
      retried: 0,
      succeeded: 0,
      failed: 0,
      error: "Unauthorized",
    };
  }

  try {
    // Fetch the import log
    const importLog = await prisma.importLog.findFirst({
      where: { importBatchId: batchId, userId: user.id },
    });

    if (!importLog) {
      return {
        success: false,
        retried: 0,
        succeeded: 0,
        failed: 0,
        error: "Import log not found",
      };
    }

    // Check if there are error details with data to retry
    const errorDetails = importLog.errorDetails as Array<{
      row: number;
      error: string;
      data?: TradeRow;
    }> | null;

    if (!errorDetails || errorDetails.length === 0) {
      return {
        success: false,
        retried: 0,
        succeeded: 0,
        failed: 0,
        error: "No failed rows to retry",
      };
    }

    // Filter rows that have data to retry
    const rowsWithData = errorDetails.filter((e) => e.data);
    if (rowsWithData.length === 0) {
      return {
        success: false,
        retried: 0,
        succeeded: 0,
        failed: 0,
        error: "No row data stored for retry. Please re-import the file.",
      };
    }

    // Get broker linking from original import
    const linkedBroker = importLog.linkedBroker;
    const linkedBrokerUserId = importLog.linkedBrokerUserId;
    const isLinkingToManual = importLog.linkedToManual;
    const isEditable = isLinkingToManual || !linkedBroker;

    let succeeded = 0;
    let failed = 0;
    const newErrorDetails: Array<{
      row: number;
      error: string;
      data?: TradeRow;
    }> = [];

    for (const errorRow of rowsWithData) {
      const data = errorRow.data!;

      try {
        // Generate duplicate hash
        const hash = generateDuplicateHash({
          symbol: data.symbol,
          tradeDate: new Date(data.tradeDate),
          tradeType: data.tradeType,
          quantity: data.quantity,
          price: data.price,
          exchange: data.exchange,
          segment: data.segment,
        });

        // Check if already exists (might have been imported manually)
        const existing = await prisma.trade.findFirst({
          where: {
            userId: user.id,
            duplicateHash: hash,
          },
        });

        if (existing) {
          // Already imported, skip
          succeeded++;
          continue;
        }

        // Try to create the trade
        await prisma.trade.create({
          data: {
            userId: user.id,
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
      } catch (error) {
        failed++;
        newErrorDetails.push({
          row: errorRow.row,
          error: getSafeErrorMessage(error, "Unknown error"),
          data: errorRow.data,
        });
      }
    }

    // Update the import log
    const newImportedCount = importLog.importedCount + succeeded;
    const newErrorCount = newErrorDetails.length;
    const newStatus =
      newErrorCount === 0
        ? "COMPLETED"
        : newImportedCount > 0
          ? "PARTIALLY_COMPLETED"
          : "FAILED";

    await prisma.importLog.update({
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

    revalidatePath("/tradebook");
    revalidatePath("/tradebook/import/history");

    return {
      success: true,
      retried: rowsWithData.length,
      succeeded,
      failed,
    };
  } catch (error) {
    return {
      success: false,
      retried: 0,
      succeeded: 0,
      failed: 0,
      error: getSafeErrorMessage(error, "Retry failed"),
    };
  }
}
