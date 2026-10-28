/**
 * Strategy-scan processor — PURE helpers (no Prisma / executeStrategy).
 *
 * `strategy-scan.ts` built its strategy input, idempotency check, usage-gate,
 * error-message extraction and both notification payloads inline; the test
 * re-declared copies of all of them and asserted the copies (a shadow). These
 * side-effect-free bits now live here and the processor imports + CALLS them.
 * Mirrors `mf-sync-logic.ts`.
 *
 * @see workers/src/processors/strategy-scan.ts (caller)
 * @see apps/web/__tests__/workers/processor-strategy-scan.test.ts (tests the real exports)
 */

export type StrategyLogic = "AND" | "OR";
export type ScanType = "fundamental" | "technical" | "combined";

export interface StrategyInput {
  id: string;
  name: string;
  filters: unknown;
  logic: StrategyLogic;
  scanType: ScanType;
}

/** The slice of the job message these helpers need. */
export interface StrategyScanLike {
  userId: string;
  scanId: string;
  strategyId: string;
  isBuiltIn: boolean;
  filters: unknown;
  logic?: string;
  scanType?: string;
}

/** Idempotency: a scan already in COMPLETED state must be skipped on redelivery. */
export function shouldSkipScan(status: string | null | undefined): boolean {
  return status === "COMPLETED";
}

/** Usage-count is only bumped for custom (non-built-in) strategies. */
export function shouldUpdateUsageCount(isBuiltIn: boolean): boolean {
  return !isBuiltIn;
}

/** Error → human message, defaulting non-Error throws to "Unknown error". */
export function extractScanErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Build the strategy input for `executeStrategy`.
 * - built-in → resolved via `lookupBuiltIn` (throws if missing);
 * - custom → constructed from the message, defaulting empty logic to "AND".
 */
export function buildStrategyInput(
  data: StrategyScanLike,
  scanName: string,
  lookupBuiltIn: (id: string) => StrategyInput | undefined,
): StrategyInput {
  if (data.isBuiltIn) {
    const builtIn = lookupBuiltIn(data.strategyId);
    if (!builtIn) {
      throw new Error(`Built-in strategy ${data.strategyId} not found`);
    }
    return builtIn;
  }
  return {
    id: data.strategyId,
    name: scanName,
    filters: data.filters,
    logic: (data.logic || "AND") as StrategyLogic,
    scanType: data.scanType as ScanType,
  };
}

export interface ScanNotification {
  userId: string;
  type: "SCAN_COMPLETED" | "SCAN_FAILED";
  title: string;
  message: string;
  metadata: Record<string, unknown>;
}

/** Success-notification payload for a completed scan. */
export function buildScanCompletedNotification(
  data: StrategyScanLike,
  scanName: string,
  stockCount: number,
): ScanNotification {
  return {
    userId: data.userId,
    type: "SCAN_COMPLETED",
    title: "Strategy Scan Complete",
    message: `"${scanName}" found ${stockCount} matching stocks.`,
    metadata: {
      scanId: data.scanId,
      strategyId: data.strategyId,
      stockCount,
    },
  };
}

/** Failure-notification payload for a failed scan (no stockCount). */
export function buildScanFailedNotification(
  data: StrategyScanLike,
  error: unknown,
): ScanNotification {
  return {
    userId: data.userId,
    type: "SCAN_FAILED",
    title: "Strategy Scan Failed",
    message: `Scan failed: ${extractScanErrorMessage(error)}`,
    metadata: {
      scanId: data.scanId,
      strategyId: data.strategyId,
    },
  };
}
