/**
 * Subscription Module
 * Plan configurations and feature access control
 */

// Plan configurations
export {
  PLAN_CONFIG,
  LEGACY_PLAN_ID_MAP,
  CREDIT_COSTS,
  CREDIT_PACKS,
  CONCURRENT_LIMITS,
  resolvePlanId,
  getPlanConfig,
  getAvailablePlans,
  isPaidPlan,
  hasUnlimitedFastQueries,
  getPlanCredits,
  getCreditCost,
  isFreeAction,
  type PlanId,
  type PlanConfig,
} from "./plans";

// Feature access
export {
  FEATURE_ACCESS,
  hasFeatureAccess,
  getFeaturesForPlan,
  isPlanAtLeast,
  getMinimumPlanForFeature,
  type Feature,
} from "./features";

// Dynamic credit billing for research runs (MONEY-219)
export {
  computeRunCredits,
  estimateRunCredits,
  RUPEES_PER_CREDIT,
  type RunCostInputs,
  type RunCostBreakdown,
} from "./dynamic-credits";

// Plan display + checkout pricing/period logic (MONEY-865 / MONEY-866)
export {
  isLifetimePlan,
  planDisplayLabel,
  resolveCheckoutPeriod,
  resolveCheckoutAmount,
  type CheckoutPeriod,
} from "./plan-display";
