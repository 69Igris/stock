"use server";

/**
 * Fund Comparison Server Actions
 *
 * Thin wrapper over @usemoney/services fund comparison functions.
 * Fetches all data needed for the side-by-side fund comparison page.
 */

import { getComparisonData as getComparisonDataService } from "@usemoney/services";

// Re-export types for consumers
export type { ComparisonData } from "@usemoney/services";

// ============== ACTIONS ==============

/**
 * Get all comparison data for 2-4 funds.
 */
export async function getComparisonDataAction(
  funds: Array<{ fundType: "MF" | "ETF" | "INDEX" | "STOCK"; fundId: string }>
): Promise<{
  success: boolean;
  data?: import("@usemoney/services").ComparisonData;
  error?: string;
}> {
  // Map action param shape (fundType/fundId) to service param shape (type/id)
  const serviceFunds = funds.map((f) => ({ type: f.fundType, id: f.fundId }));
  return getComparisonDataService(serviceFunds);
}
