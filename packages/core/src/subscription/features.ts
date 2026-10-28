/**
 * Feature Access Control
 * Defines which plans have access to which features
 */

import { resolvePlanId } from "./plans";

export type Feature =
  | "manualTradebook"
  | "fireCalculator"
  | "paperTrading"
  | "basicPortfolio"
  | "brokerSync"
  | "unlimitedConnections"
  | "autoSyncHoldings"
  | "positionsTracking"
  | "tradebookSync"
  | "stockDiscovery"
  | "aiQueries"
  | "aiStrategies"
  | "aiLearning"
  | "aiAnalysis"
  | "unlimitedSlowQueries"
  | "unlimitedFastQueries"
  | "prioritySupport"
  | "learningContent"
  | "learningVideos"
  | "learningAudio"
  | "advancedCourses"
  | "portfolioRoast"
  | "taxAnalysis"
  | "riskAnalysis"
  | "documentVault";

/**
 * Feature access configuration
 * Maps features to the plans that have access to them
 */
export const FEATURE_ACCESS: Record<Feature, string[]> = {
  // Free features (available to all plans)
  manualTradebook: ["FREE", "PRO", "PREMIUM", "ULTIMATE"],
  fireCalculator: ["FREE", "PRO", "PREMIUM", "ULTIMATE"],
  paperTrading: ["FREE", "PRO", "PREMIUM", "ULTIMATE"],
  basicPortfolio: ["FREE", "PRO", "PREMIUM", "ULTIMATE"],

  // Pro features
  brokerSync: ["FREE", "PRO", "PREMIUM", "ULTIMATE"], // FREE has 1 broker sync
  unlimitedConnections: ["PRO", "PREMIUM", "ULTIMATE"],
  autoSyncHoldings: ["PRO", "PREMIUM", "ULTIMATE"],
  positionsTracking: ["PRO", "PREMIUM", "ULTIMATE"],
  tradebookSync: ["PRO", "PREMIUM", "ULTIMATE"],
  stockDiscovery: ["PRO", "PREMIUM", "ULTIMATE"],
  // FREE plan is allowed at the feature-flag level. Real budget enforcement
  // happens via `CREDIT_COSTS` (l1_flash = 0, L2+ research = real credits)
  // and per-model `requiresPlan` gating in the model registry. The flag
  // here just answers "does this plan have an AI surface at all?"
  // - and the answer for FREE is YES (Flash chat free + 5 research credits).
  aiQueries: ["FREE", "PRO", "PREMIUM", "ULTIMATE"],

  // Premium features
  aiStrategies: ["PREMIUM", "ULTIMATE"],
  aiLearning: ["PREMIUM", "ULTIMATE"],
  aiAnalysis: ["PRO", "PREMIUM", "ULTIMATE"],
  unlimitedSlowQueries: ["PREMIUM", "ULTIMATE"], // deprecated
  unlimitedFastQueries: ["PREMIUM", "ULTIMATE"],
  prioritySupport: ["PREMIUM", "ULTIMATE"],

  // Learning content features (PREMIUM+ only)
  learningContent: ["PREMIUM", "ULTIMATE"],
  learningVideos: ["PREMIUM", "ULTIMATE"],
  learningAudio: ["PREMIUM", "ULTIMATE"],

  // Advanced courses (BEGINNER/INTERMEDIATE free for all, ADVANCED requires PREMIUM)
  advancedCourses: ["PREMIUM", "ULTIMATE"],

  // Portfolio roast (AI-powered - requires PRO+)
  portfolioRoast: ["PRO", "PREMIUM", "ULTIMATE"],

  // Tax & Risk analysis (PREMIUM-only AI features)
  taxAnalysis: ["PREMIUM", "ULTIMATE"],
  riskAnalysis: ["PREMIUM", "ULTIMATE"],

  // Document vault (PREMIUM+ feature)
  documentVault: ["PREMIUM", "ULTIMATE"],
};

/**
 * Check if a plan has access to a specific feature.
 * Supports legacy plan IDs by resolving them first.
 */
export function hasFeatureAccess(planId: string, feature: Feature): boolean {
  const resolved = resolvePlanId(planId);
  const allowedPlans = FEATURE_ACCESS[feature];
  return allowedPlans?.includes(resolved) ?? false;
}

/**
 * Get all features available for a plan
 */
export function getFeaturesForPlan(planId: string): Feature[] {
  const resolved = resolvePlanId(planId);
  const features: Feature[] = [];
  for (const [feature, plans] of Object.entries(FEATURE_ACCESS)) {
    if (plans.includes(resolved)) {
      features.push(feature as Feature);
    }
  }
  return features;
}

/**
 * Check if a plan is at least a certain tier
 */
export function isPlanAtLeast(planId: string, minPlanId: string): boolean {
  const resolvedCurrent = resolvePlanId(planId);
  const resolvedMin = resolvePlanId(minPlanId);

  const planTiers: Record<string, number> = {
    FREE: 0,
    PRO: 1,
    PREMIUM: 2,
    ULTIMATE: 3,
  };

  const currentTier = planTiers[resolvedCurrent] ?? 0;
  const minTier = planTiers[resolvedMin] ?? 0;

  return currentTier >= minTier;
}

/**
 * Get the minimum plan required for a feature
 */
export function getMinimumPlanForFeature(feature: Feature): string {
  const allowedPlans = FEATURE_ACCESS[feature];
  if (!allowedPlans || allowedPlans.length === 0) return "FREE";

  // Plan order from lowest to highest
  const planOrder = ["FREE", "PRO", "PREMIUM", "ULTIMATE"];

  for (const plan of planOrder) {
    if (allowedPlans.includes(plan)) {
      return plan;
    }
  }

  return "PREMIUM"; // Default to highest if not found
}
