/**
 * Subscription Plans Configuration
 * Pure configuration without any dependencies on auth or database
 */

export type PlanId = "FREE" | "PRO" | "QUERY_PACK" | "PREMIUM" | "ULTIMATE";

export interface PlanConfig {
  id: string;
  name: string;
  price: number;
  originalPrice?: number;
  currency: string;
  period: "one-time" | "monthly" | "annual";
  aiQueries: number; // legacy
  fastQueries: number;
  slowQueries: number; // deprecated
  advancedQueries: number;
  /** Unified monthly credit allocation */
  credits: number;
  annualPrice?: number;
  annualOriginalPrice?: number;
  monthlyPrice?: number;
  monthlyOriginalPrice?: number;
  description?: string;
}

/** Credit cost per action - system decides, user never chooses */
export const CREDIT_COSTS: Record<string, number> = {
  // Free actions (0 credits)
  l1_flash: 0,
  l1_definition: 0,
  follow_up: 0,
  portfolio_query: 0,
  // L2 actions (1-3 credits)
  l2_research_fast: 1,
  l2_research_advanced: 3,
  // MONEY-619 (Phase 2): a "thinking" chat turn runs the tier's Pro model
  // instead of Flash, so it is no longer free. Base cost 1; the per-model
  // premium (e.g. +2 for gemini-3-pro) is layered on via
  // getEffectiveCreditCost at the consume site. NOT an l1_* action, so the
  // premium actually applies (l1_* always resolves to 0).
  l2_chat_thinking: 1,
  l2_earnings_analysis: 2,
  l2_financial_deep_dive: 3,
  l2_investment_thesis: 3,
  l2_dcf_valuation: 2,
  l2_stock_screener: 1,
  // MONEY-1049 - Ask FIRE chat. The deterministic parser tier is FREE (it
  // never calls a model); this action is charged ONCE per LLM-backed turn
  // (questions, goal-seeking, multi-intent). Flash-tier under the hood, but
  // billed as its own action per product decision (l1_flash would be free).
  fire_chat: 1,
  // MONEY-1078 - Ask Screener chat. Same policy as fire_chat: tool-producing
  // turns are free; a pure-answer LLM turn is charged once.
  screener_chat: 1,
  // L3 actions (high credit)
  l3_comprehensive_stock: 10,
  // Comparisons now run L4-comprehensive depth on every selected item per
  // user direction (2026-05-08), so the per-stock charge mirrors a full
  // comprehensive run. 5 stocks = 8 + 8×4 = 40 credits.
  l3_multi_comparison_base: 8,
  l3_multi_comparison_per_stock: 8,
  l3_portfolio_optimization: 8,
  // Premium features
  portfolio_roast: 5,
  risk_analysis: 3,
  tax_report: 2,
  document_analysis: 2,
  // Fund composition extraction (MONEY-1405). A `gemini-2.5-pro` thinking call
  // that reads a fund's holdings out of the model's own recollection, priced
  // like `document_analysis` because it is the same class of work.
  //
  // IT MUST BE IN THIS TABLE, not only at the call site. `getCreditCost`
  // returns `CREDIT_COSTS[action] ?? 0` and `consumeCredits` treats a cost of 0
  // as a FREE action that is always allowed — so an action missing from here is
  // metered by a meter that authorises everything, silently, which is the exact
  // defect the metering was added to close. The action's own call site passes a
  // `costOverride` as well; this entry is what makes that override redundant
  // rather than load-bearing.
  fund_composition_extract: 2,
  // AI Filter Builder (MONEY-202) - Gemini Flash converts a thesis
  // sentence into a screener filter object. 1 credit per generation.
  ai_filter_builder: 1,
  // Strategy backtest / forward (MONEY-298). Backtest is heavier than
  // forward in compute (5y signal replay) but forward needs a Monte
  // Carlo pass on top of the same residuals - 3 credits there reflects
  // the model cost, not just CPU time.
  strategy_backtest: 2,
  strategy_forward: 3,
};

/** Credit pack options for one-time purchase */
export const CREDIT_PACKS = [
  { id: "pack_50", credits: 50, price: 399, perCredit: 8 },
  { id: "pack_100", credits: 100, price: 699, perCredit: 7 },
  { id: "pack_250", credits: 250, price: 1499, perCredit: 6 },
  { id: "pack_500", credits: 500, price: 2499, perCredit: 5 },
  { id: "pack_1000", credits: 1000, price: 3999, perCredit: 4 },
] as const;

/** Parallel run limits per plan */
export const CONCURRENT_LIMITS: Record<
  PlanId,
  { l2: number; l3: number; roast: number }
> = {
  FREE: { l2: 1, l3: 0, roast: 0 },
  PRO: { l2: 2, l3: 1, roast: 1 },
  QUERY_PACK: { l2: 2, l3: 1, roast: 1 },
  PREMIUM: { l2: 5, l3: 2, roast: 1 },
  ULTIMATE: { l2: 10, l3: 3, roast: 2 },
};

/**
 * Plan configuration
 * Prices in INR
 */
export const PLAN_CONFIG: Record<PlanId, PlanConfig> = {
  FREE: {
    id: "FREE",
    name: "Free Forever",
    price: 0,
    currency: "INR",
    period: "one-time",
    aiQueries: 0,
    fastQueries: 0,
    slowQueries: 0,
    advancedQueries: 0,
    credits: 5, // 5 free credits/month
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    price: 999,
    originalPrice: 3999,
    currency: "INR",
    period: "one-time",
    aiQueries: 20,
    fastQueries: 20,
    slowQueries: 5,
    advancedQueries: 5,
    credits: 50, // 50 credits/month
    // MONEY-438: launch-offer pricing for the new Monthly / Annual PRO
    // SKUs (legacy lifetime SKU above stays for grandfathered users).
    //   Monthly: ₹249/month, normally ₹499 (50% off)
    //   Annual:  ₹1,999/year, normally ₹4,999 (60% off)
    // These literals are the single source of truth for checkout amount —
    // apps/web/lib/actions/subscription.ts reads them directly. The UI
    // surfaces (Landing, /pricing, Settings) mirror these numbers.
    annualPrice: 1999,
    annualOriginalPrice: 4999,
    monthlyPrice: 249,
    monthlyOriginalPrice: 499,
    description: "50 AI credits/month - casual investors",
  },
  QUERY_PACK: {
    id: "QUERY_PACK",
    name: "Query Pack",
    price: 199,
    currency: "INR",
    period: "one-time",
    aiQueries: 200,
    fastQueries: 200,
    slowQueries: 50,
    advancedQueries: 50,
    credits: 0, // Not a plan - credit packs use CREDIT_PACKS config
    description: "Legacy query pack - use credit packs instead",
  },
  PREMIUM: {
    id: "PREMIUM",
    name: "Premium",
    price: 1499,
    originalPrice: 2999,
    currency: "INR",
    period: "monthly",
    aiQueries: -1,
    fastQueries: -1,
    slowQueries: 200,
    advancedQueries: 200,
    credits: 200, // 200 credits/month
    // MONEY-872: per-cycle list prices are REQUIRED for upgrade-proration
    // (computeTierUpgradeBonusDays). PRO has them; PREMIUM was missing the
    // monthly pair, so a PRO→PREMIUM *monthly* upgrade threw "requires list
    // prices on both sides" and surfaced as "could not start checkout".
    monthlyPrice: 1499,
    monthlyOriginalPrice: 2999,
    annualPrice: 14990,
    annualOriginalPrice: 17988,
    description: "200 AI credits/month - active traders",
  },
  ULTIMATE: {
    id: "ULTIMATE",
    name: "Ultimate",
    price: 4999,
    currency: "INR",
    period: "monthly",
    aiQueries: -1,
    fastQueries: -1,
    slowQueries: -1,
    advancedQueries: -1,
    credits: 750, // 750 credits/month
    annualPrice: 49990,
    description: "750 AI credits/month - power users",
  },
};

/**
 * Backward-compatible plan ID mapping for webhook/callback processing.
 * Old DB records or incoming Dodo webhooks may still reference legacy IDs.
 */
export const LEGACY_PLAN_ID_MAP: Record<string, PlanId> = {
  AI_UNLIMITED: "PREMIUM",
  AI_ADDON: "QUERY_PACK",
  AI_PRO: "PREMIUM",
};

/**
 * Resolve a plan ID, mapping legacy IDs to current ones.
 */
export function resolvePlanId(planId: string): PlanId {
  return LEGACY_PLAN_ID_MAP[planId] ?? (planId as PlanId);
}

/**
 * Get plan configuration by ID (supports legacy IDs)
 */
export function getPlanConfig(planId: string): PlanConfig | undefined {
  const resolved = resolvePlanId(planId);
  return PLAN_CONFIG[resolved];
}

/**
 * Get all available plans (excluding placeholder tiers)
 */
export function getAvailablePlans(): PlanConfig[] {
  return [
    PLAN_CONFIG.FREE,
    PLAN_CONFIG.PRO,
    PLAN_CONFIG.PREMIUM,
    PLAN_CONFIG.QUERY_PACK,
  ];
}

/**
 * Check if a plan is paid (not FREE)
 */
export function isPaidPlan(planId: string): boolean {
  return resolvePlanId(planId) !== "FREE";
}

/**
 * Check if plan has unlimited fast queries
 */
export function hasUnlimitedFastQueries(planId: string): boolean {
  const plan = getPlanConfig(planId);
  return plan?.fastQueries === -1;
}

/**
 * Get unified credit limit for a plan
 */
export function getPlanCredits(planId: string): number {
  const plan = getPlanConfig(planId);
  return plan?.credits ?? 5;
}

/**
 * Get credit cost for an action
 */
export function getCreditCost(action: string): number {
  return CREDIT_COSTS[action] ?? 0;
}

/**
 * Check if an action is free (0 credits)
 */
export function isFreeAction(action: string): boolean {
  return getCreditCost(action) === 0;
}
