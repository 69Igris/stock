export type PlanType = "FREE" | "PRO" | "PREMIUM" | "ULTIMATE" | "QUERY_PACK";

export interface SubscriptionAccess {
  planId: PlanType;
  isActive: boolean;
  canUseFastQueries: boolean;
  canUseAdvancedQueries: boolean;
  fastQueriesRemaining: number;
  advancedQueriesRemaining: number;
  hasUnlimitedFastQueries: boolean;
  hasUnlimitedAdvancedQueries: boolean;
}
