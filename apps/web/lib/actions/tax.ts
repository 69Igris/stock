"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import {
  getTaxReport as getTaxReportService,
  getPairedTradesForFY as getPairedTradesForFYService,
  type TaxReportResult,
  type PairedTradeForFY,
} from "@usemoney/services";
import { isDemoSession } from "@/lib/demo/session";
import { demoTaxResult } from "@/lib/demo/data";
import { requireFeature } from "./premium-gate";

// Re-export types for consumers
export type { TaxReportResult, PairedTradeForFY } from "@usemoney/services";

/**
 * Fetch closed paired trades for a specific financial year.
 */
export async function getPairedTradesForFYAction(fy?: string): Promise<
  ActionResponse<
    Array<{
      symbol: string;
      buyDate: string;
      sellDate: string;
      buyValue: number;
      sellValue: number;
      segment: string;
    }>
  >
> {
  if (await isDemoSession()) {
    return { success: true, data: [] };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  // MONEY-1142 — `/tax` maps to the `taxAnalysis` feature, but the gate lived
  // only in the client PageGuard. Both actions in this file are gated: the
  // paired-trades feed is the raw material of the report, so leaving it open
  // would hand over the same data one step earlier.
  const denied = await requireFeature(authUser.userId, "taxAnalysis");
  if (denied) return denied;

  return getPairedTradesForFYService(authUser.userId, fy);
}

/**
 * Generate full tax report for a financial year.
 */
export async function getTaxReportAction(
  fy?: string
): Promise<ActionResponse<TaxReportResult>> {
  if (await isDemoSession()) {
    return { success: true, data: demoTaxResult };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  const denied = await requireFeature(authUser.userId, "taxAnalysis");
  if (denied) return denied;

  return getTaxReportService(authUser.userId, fy);
}
