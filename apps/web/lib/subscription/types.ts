// Subscription Plans and Types

export type PlanType = "FREE" | "PRO" | "QUERY_PACK" | "PREMIUM" | "ULTIMATE";

export interface Plan {
  id: PlanType;
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  period: "one-time" | "monthly" | "annual" | "";
  features: string[];
  aiQueries: number;
  fastQueries?: number;
  advancedQueries?: number;
  isLimitedTime?: boolean;
  comingSoon?: boolean;
}

export interface UserSubscription {
  planId: PlanType;
  status: "active" | "cancelled" | "expired";
  startDate: string;
  endDate?: string;
  aiQueriesUsed: number;
  aiQueriesLimit: number;
  fastQueriesUsed?: number;
  fastQueriesLimit?: number;
  advancedQueriesUsed?: number;
  advancedQueriesLimit?: number;
  addons: string[];
}

export const PLANS: Record<PlanType, Plan> = {
  FREE: {
    id: "FREE",
    name: "Free",
    description: "Get started with manual trading tools",
    price: 0,
    period: "",
    features: [
      "FIRE Calculator",
      "Manual Tradebook Management",
      "Manual Paper Trading",
      "Manual Portfolio Management",
      "Manual Positions Management",
      "1 Broker Account (30 days trial)",
    ],
    aiQueries: 0,
    fastQueries: 0,
    advancedQueries: 0,
  },
  PRO: {
    id: "PRO",
    name: "PRO",
    description: "Unlimited broker sync with AI assistance",
    price: 999,
    originalPrice: 3999,
    period: "one-time",
    features: [
      "Everything in Free",
      "20 Fast AI Queries/month*",
      "5 Advanced AI Queries/month*",
      "Unlimited Broker Sync",
      "Unlimited Holdings & Positions Sync",
      "Stock & MF Discovery with Live Data",
      "Paper Trading with Live Data & Charting",
      "Purchase Additional Queries",
    ],
    aiQueries: 20,
    fastQueries: 20,
    advancedQueries: 5,
    isLimitedTime: true,
  },
  QUERY_PACK: {
    id: "QUERY_PACK",
    name: "Query Pack",
    description: "Additional AI queries for power users",
    price: 199,
    period: "one-time",
    features: [
      "200 Fast + 50 Advanced Queries (PRO Plan)",
      "200 Advanced Queries (Premium Plan)",
    ],
    aiQueries: 200,
    fastQueries: 200,
    advancedQueries: 50,
  },
  PREMIUM: {
    id: "PREMIUM",
    name: "Premium",
    description: "Full AI-powered trading intelligence",
    price: 999,
    originalPrice: 1899,
    period: "monthly",
    features: [
      "Everything in PRO",
      "Unlimited Fast Queries/month**",
      "200 Advanced Queries/month*",
      "Personalized Learning Modules",
      "Portfolio Analysis with AI",
      "Paper Trading with AI Analysis",
      "Build Trading Strategies with AI",
      "Purchase Additional Queries",
      "Priority Support",
    ],
    aiQueries: -1,
    fastQueries: -1,
    advancedQueries: 200,
    comingSoon: true,
  },
  ULTIMATE: {
    id: "ULTIMATE",
    name: "Ultimate",
    description: "Everything included - the complete trading suite",
    price: 0,
    period: "monthly",
    features: [
      "Everything in Premium",
      "Unlimited Advanced Queries",
      "Dedicated Support",
    ],
    aiQueries: -1,
    fastQueries: -1,
    advancedQueries: -1,
    comingSoon: true,
  },
};

export const ANNUAL_DISCOUNT = 0.47; // 47% discount for annual
export const PREMIUM_ANNUAL_PRICE = 9999;
export const PREMIUM_ANNUAL_ORIGINAL_PRICE = 18999;

// Feature access by plan
export const FEATURE_ACCESS: Record<string, PlanType[]> = {
  "manual-tradebook": ["FREE", "PRO", "PREMIUM", "ULTIMATE"],
  "fire-calculator": ["FREE", "PRO", "PREMIUM", "ULTIMATE"],
  "paper-trading": ["FREE", "PRO", "PREMIUM", "ULTIMATE"],
  "broker-sync": ["FREE", "PRO", "PREMIUM", "ULTIMATE"],
  "holdings-sync": ["PRO", "PREMIUM", "ULTIMATE"],
  "positions-sync": ["PRO", "PREMIUM", "ULTIMATE"],
  discovery: ["PRO", "PREMIUM", "ULTIMATE"],
  "ai-queries": ["PRO", "QUERY_PACK", "PREMIUM", "ULTIMATE"],
  "ai-strategies": ["PREMIUM", "ULTIMATE"],
  "ai-learning": ["PREMIUM", "ULTIMATE"],
  "ai-analysis": ["PREMIUM", "ULTIMATE"],
};

export function canAccessFeature(feature: string, userPlan: PlanType): boolean {
  const allowedPlans = FEATURE_ACCESS[feature] || [];
  return allowedPlans.includes(userPlan);
}

export function getDefaultSubscription(): UserSubscription {
  return {
    planId: "FREE",
    status: "active",
    startDate: new Date().toISOString(),
    aiQueriesUsed: 0,
    aiQueriesLimit: 0,
    addons: [],
  };
}
