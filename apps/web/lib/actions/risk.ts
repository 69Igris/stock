"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import {
  getPortfolioRisk as getPortfolioRiskService,
  type PortfolioRiskResult,
} from "@usemoney/services";
import { isDemoSession } from "@/lib/demo/session";
import { demoRiskResult } from "@/lib/demo/data";
import { requireFeature } from "./premium-gate";

// Re-export types for consumers
export type { PortfolioRiskResult } from "@usemoney/services";

export async function getPortfolioRiskAction(): Promise<
  ActionResponse<PortfolioRiskResult>
> {
  if (await isDemoSession()) {
    return { success: true, data: demoRiskResult };
  }

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Authentication required" };
  }

  // MONEY-1142 — `/risk` maps to the `riskAnalysis` feature in
  // PAGE_TO_FEATURE_MAP, but until now that gate lived ONLY in the client
  // PageGuard. Server actions are invocable directly, so anything that got
  // past the client got real premium risk analysis. Ordered after the demo
  // and auth checks on purpose: demo serves canned data, and an
  // unauthenticated caller should be told to sign in, not to upgrade.
  const denied = await requireFeature(authUser.userId, "riskAnalysis");
  if (denied) return denied;

  return getPortfolioRiskService(authUser.userId);
}
