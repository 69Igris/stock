/**
 * Strategy Scan Processor
 *
 * Processes strategy scan jobs from Pub/Sub.
 * Uses the Hybrid Screener Engine (pure DB queries) - no external API calls.
 *
 * Flow:
 * 1. Load ScanResult from DB (idempotency: skip if COMPLETED)
 * 2. Mark as RUNNING
 * 3. Execute strategy via DB-first screener engine
 * 4. Update ScanResult with stocks + stockCount + status=COMPLETED
 * 5. Update CustomStrategy usage count if not built-in
 * 6. Create notification
 * 7. On error: mark FAILED, don't retry
 */

import { prisma } from "@usemoney/database";
import type { StrategyScanMessage } from "@usemoney/types";
import {
  executeStrategy,
  getStrategyById,
  type CustomStrategyInput,
} from "@usemoney/research";
import { createNotification } from "../lib/notifications";
import type { Prisma } from "@usemoney/database";
import {
  shouldSkipScan,
  shouldUpdateUsageCount,
  extractScanErrorMessage,
  buildScanCompletedNotification,
  buildScanFailedNotification,
  type StrategyScanLike,
} from "./strategy-scan-logic";

export async function processStrategyScan(
  data: StrategyScanMessage,
): Promise<void> {
  const {
    scanId,
    strategyId,
    isBuiltIn,
    userId,
    filters,
    logic,
    scanType,
    limit,
  } = data;

  console.log(
    `[strategy-scan] Processing scan ${scanId} strategy=${strategyId} isBuiltIn=${isBuiltIn}`,
  );

  try {
    // 1. Load ScanResult (idempotency check)
    const scanResult = await prisma.scanResult.findUnique({
      where: { id: scanId },
    });

    if (!scanResult) {
      console.error(`[strategy-scan] ScanResult ${scanId} not found`);
      return;
    }

    if (shouldSkipScan(scanResult.status)) {
      console.log(
        `[strategy-scan] Scan ${scanId} already completed - skipping`,
      );
      return;
    }

    // View of the message used by the pure notification/gate helpers.
    const scanLike: StrategyScanLike = {
      userId,
      scanId,
      strategyId,
      isBuiltIn,
      filters,
      logic,
      scanType,
    };

    // 2. Mark as RUNNING
    await prisma.scanResult.update({
      where: { id: scanId },
      data: { status: "RUNNING" },
    });

    // 3. Build strategy input
    let strategyInput: Parameters<typeof executeStrategy>[0];

    if (isBuiltIn) {
      const builtIn = getStrategyById(strategyId);
      if (!builtIn) {
        throw new Error(`Built-in strategy ${strategyId} not found`);
      }
      strategyInput = builtIn;
    } else {
      strategyInput = {
        id: strategyId,
        name: scanResult.scanName,
        filters: filters as CustomStrategyInput["filters"],
        logic: (logic || "AND") as "AND" | "OR",
        scanType: scanType as "fundamental" | "technical" | "combined",
      };
    }

    // 4. Execute strategy (pure DB query via Hybrid Screener Engine)
    const result = await executeStrategy(strategyInput, { limit });

    // 5. Update ScanResult with results
    await prisma.scanResult.update({
      where: { id: scanId },
      data: {
        results: result.stocks as unknown as Prisma.InputJsonValue,
        stockCount: result.stockCount,
        status: "COMPLETED",
      },
    });

    // 6. Update usage count for custom strategies
    if (shouldUpdateUsageCount(isBuiltIn)) {
      await prisma.customStrategy
        .update({
          where: { id: strategyId },
          data: {
            usageCount: { increment: 1 },
            lastRunAt: new Date(),
            lastRunCount: result.stockCount,
          },
        })
        .catch((err: unknown) => {
          // Non-critical - strategy may have been deleted
          console.warn(
            `[strategy-scan] Failed to update usage count for ${strategyId}:`,
            err instanceof Error ? err.message : err,
          );
        });
    }

    // 7. Create notification
    await createNotification(
      buildScanCompletedNotification(
        scanLike,
        scanResult.scanName,
        result.stockCount,
      ),
    );

    console.log(
      `[strategy-scan] Scan ${scanId} COMPLETED - ${result.stockCount} stocks in ${result.executionTimeMs}ms`,
    );
  } catch (error) {
    const errorMessage = extractScanErrorMessage(error);
    console.error(`[strategy-scan] Scan ${scanId} FAILED:`, errorMessage);

    // Mark as FAILED
    try {
      await prisma.scanResult.update({
        where: { id: scanId },
        data: {
          status: "FAILED",
          errorMessage,
        },
      });

      await createNotification(
        buildScanFailedNotification(
          { userId, scanId, strategyId, isBuiltIn, filters, logic, scanType },
          error,
        ),
      );
    } catch (cleanupError) {
      console.error(
        "[strategy-scan] Cleanup after failure also failed:",
        cleanupError,
      );
    }
  }
}
