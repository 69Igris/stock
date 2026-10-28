/**
 * Tier-aware session-id routing helper.
 *
 * `analysisSession` rows (L3 / L4) use `l3-` / `l4-` prefixed sessionIds.
 * `researchSession` rows (L1 / L2) use bare UUIDs.
 *
 * Centralised so adding a future tier (L5+) is one edit, not a grep across
 * page client + status poller + result loader.
 */
export const ANALYSIS_SESSION_PREFIXES = ["l3-", "l4-"] as const;

export function isAnalysisSessionId(sessionId: string): boolean {
  if (typeof sessionId !== "string" || !sessionId) return false;
  return ANALYSIS_SESSION_PREFIXES.some((p) => sessionId.startsWith(p));
}

export type AnalysisTier = "l3" | "l4";

export function getAnalysisTier(sessionId: string): AnalysisTier | null {
  if (sessionId.startsWith("l4-")) return "l4";
  if (sessionId.startsWith("l3-")) return "l3";
  return null;
}
