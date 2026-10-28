"use server";

/**
 * Mutual Fund Discovery Server Actions
 *
 * Thin wrappers over @usemoney/services discover functions.
 * Data source: AMFI NAVAll.txt (synced by the AMFI worker).
 */

import {
  getMfDiscoverData as getMfDiscoverDataService,
  getMfsByCategory as getMfsByCategoryService,
  getMfsBySchemeCodes as getMfsBySchemeCodesService,
} from "@usemoney/services";

// Re-export types for consumers
export type { DiscoverMutualFund, MfDiscoverData } from "@usemoney/services";

// ============== ACTIONS ==============

/**
 * Get all MF discovery data in a single query.
 * Returns top 50 DIRECT funds per category, category counts, and AMC list.
 */
export async function getMfDiscoverDataAction(): Promise<{
  success: boolean;
  data?: import("@usemoney/services").MfDiscoverData;
  error?: string;
}> {
  return getMfDiscoverDataService();
}

/**
 * Get mutual funds filtered by category, AMC, sort, etc.
 * Kept for backward compatibility with other callers.
 */
export async function getMfByCategoryAction(
  category: string | null,
  options: {
    plan?: string;
    sortBy?: "returns1Y" | "returns3Y" | "returns5Y" | "nav" | "aum";
    limit?: number;
    amcName?: string;
    search?: string;
  } = {}
): Promise<{
  success: boolean;
  data?: import("@usemoney/services").DiscoverMutualFund[];
  error?: string;
}> {
  return getMfsByCategoryService(category ?? "all", {
    plan: options.plan,
    amcName: options.amcName,
    search: options.search,
    sortBy: options.sortBy ?? "nav",
    limit: options.limit ?? 20,
  });
}

/**
 * Get mutual funds by scheme codes (for enriching search results).
 */
export async function getMfsBySchemeCodesAction(
  schemeCodes: string[]
): Promise<{
  success: boolean;
  data?: import("@usemoney/services").DiscoverMutualFund[];
  error?: string;
}> {
  if (!schemeCodes.length || schemeCodes.length > 50) {
    return { success: true, data: [] };
  }

  return getMfsBySchemeCodesService(schemeCodes);
}
