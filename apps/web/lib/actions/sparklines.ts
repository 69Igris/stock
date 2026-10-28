"use server";

/**
 * Sparkline Server Actions
 *
 * Thin wrapper over @usemoney/services getSparklines for use by server
 * components that need to inline sparkline data in the initial HTML (e.g.
 * the Markets Overview page fetches 6 index sparklines at SSR time).
 *
 * Client components should use the useSparklines hook instead, which goes
 * through /api/market/sparkline and handles polling + error states.
 */

import {
  getSparklines as getSparklinesService,
  type ServiceResult,
} from "@usemoney/services";
import type { SparklineResult, SparklineWindow } from "@usemoney/core";

export interface SparklineInput {
  symbol: string;
  exchange: "NSE" | "BSE";
}

export async function getSparklinesAction(
  symbols: SparklineInput[],
  window: SparklineWindow = "1D"
): Promise<ServiceResult<Record<string, SparklineResult>>> {
  return getSparklinesService(symbols, window);
}
