/**
 * Single source of truth for Dodo payment plan configuration + the pure
 * webhook / callback / checkout helpers.
 *
 * Previously this logic was duplicated three ways:
 *   - the Dodo product `PLAN_CONFIG` (name / price / product-id metadata) lived
 *     in `lib/payments/dodo.ts` and was imported only by the create-checkout
 *     route, but `dodo.ts` also pulls in the `dodopayments` SDK (CJS), so the
 *     config could not be imported into a test without dragging the SDK;
 *   - the webhook `PLANS` map (aiQueries / price) + `getAddonQueries` +
 *     query-pack carry-forward + end-date logic was inlined in BOTH
 *     `app/api/webhooks/dodo/route.ts` and `app/api/payments/callback/route.ts`;
 *   - and each of those was re-implemented a *fourth* time inline inside the
 *     test files and the copy was asserted (a shadow).
 *
 * This module is pure (no `dodopayments`, no Prisma, no `next/*`), so the
 * webhook route, the callback route, the create-checkout route, AND their tests
 * all import the SAME exported symbols. It now lives in `@usemoney/core` and is
 * consumed via the `@usemoney/core/payments/plan-config` subpath (the SDK client
 * itself is `@usemoney/core/payments`).
 *
 * @see packages/core/__tests__/payments/plan-config.test.ts
 */
import { resolvePlanId, type PlanId } from "../subscription/plans";

export { resolvePlanId };
export type { PlanId };

// ---------------------------------------------------------------------------
// Dodo product configuration (used by the create-checkout route).
//
// NOTE: these values intentionally differ from the canonical `@usemoney/core`
// `PLAN_CONFIG` (e.g. name casing, the Dodo-side display prices). They are the
// product/catalog metadata the Dodo checkout session is built from, kept here
// verbatim from the original `dodo.ts` so checkout behaviour is unchanged.
// ---------------------------------------------------------------------------

export interface DodoPlanConfig {
  id: string;
  name: string;
  price: number;
  originalPrice?: number;
  currency: string;
  period: string;
  aiQueries: number;
  fastQueries: number;
  slowQueries: number;
  advancedQueries: number;
  annualPrice?: number;
  annualOriginalPrice?: number;
  description?: string;
}

export const PLAN_CONFIG: Record<string, DodoPlanConfig> = {
  FREE: {
    id: "FREE",
    name: "Free",
    price: 0,
    currency: "INR",
    period: "one-time",
    aiQueries: 0,
    fastQueries: 0,
    slowQueries: 0, // deprecated - use advancedQueries
    advancedQueries: 0,
  },
  PRO: {
    id: "PRO",
    name: "PRO",
    price: 999,
    originalPrice: 3999,
    currency: "INR",
    period: "one-time",
    aiQueries: 20, // legacy - updated to match fastQueries
    fastQueries: 20, // Gemini 2.5 Flash
    slowQueries: 5, // deprecated - use advancedQueries
    advancedQueries: 5, // Gemini 2.5 Pro
    description:
      "One-time payment for lifetime access - 20 fast + 5 advanced queries/month",
  },
  QUERY_PACK: {
    id: "QUERY_PACK",
    name: "Query Pack",
    price: 199,
    currency: "INR",
    period: "one-time",
    aiQueries: 200, // legacy - updated to match fastQueries
    fastQueries: 200, // Gemini 2.5 Flash (for PRO users)
    slowQueries: 50, // deprecated - use advancedQueries
    advancedQueries: 50, // Gemini 2.5 Pro (for PRO users)
    description:
      "Additional AI queries: 200 fast + 50 advanced (PRO), 200 advanced (Premium)",
  },
  PREMIUM: {
    id: "PREMIUM",
    name: "Premium",
    price: 999,
    originalPrice: 1899,
    currency: "INR",
    period: "monthly",
    aiQueries: -1, // legacy - unlimited
    fastQueries: -1, // Unlimited with rate limiting (Gemini 2.5 Flash)
    slowQueries: 200, // deprecated - use advancedQueries
    advancedQueries: 200, // Limited to 200/month (Gemini 2.5 Pro)
    annualPrice: 9999, // Fixed: ₹9,999/year
    annualOriginalPrice: 18999, // Fixed: was ₹18,999/year (47% off)
    description:
      "Unlimited fast queries (with rate limiting) + 200 advanced queries/month",
  },
};

// NOTE (MONEY-1062 review): the FEATURE_ACCESS map + hasFeatureAccess that were
// "kept verbatim from dodo.ts" here, and the getDodoMode / getDodoEnvironment /
// validateApiKey env helpers, have been DELETED. They duplicated (and silently
// conflicted with) the canonical entitlement map in
// `@usemoney/core/subscription` (features.ts) and the env logic inlined in
// `./dodo.ts` — with ZERO production consumers, they were auto-import traps
// (two getDodoMode with different return conventions; a stale FEATURE_ACCESS
// that would silently break entitlements). Entitlements ALWAYS come from
// `@usemoney/core/subscription`.

// ---------------------------------------------------------------------------
// Webhook / callback plan-grant configuration.
// ---------------------------------------------------------------------------

export interface WebhookPlan {
  aiQueries: number;
  price: number;
}

/**
 * The webhook's plan→{aiQueries, price} map. Single source of truth for the
 * local `PLANS` const that used to live in both the dodo webhook route and the
 * payments-callback route.
 */
export const WEBHOOK_PLANS: Record<string, WebhookPlan> = {
  FREE: { aiQueries: 0, price: 0 },
  PRO: { aiQueries: 10, price: 999 },
  QUERY_PACK: { aiQueries: 100, price: 99 },
  PREMIUM: { aiQueries: -1, price: 999 },
};

export interface AddonQueries {
  fast: number;
  advanced: number;
}

/**
 * Additional queries a QUERY_PACK grants, keyed off the user's RESOLVED plan.
 * Identical logic in the webhook route and the callback route (both resolve the
 * legacy id first). PRO → 200 fast + 50 advanced; PREMIUM / ULTIMATE → 0 fast +
 * 200 advanced (they already have unlimited fast); anyone else → nothing.
 */
export function getAddonQueries(planId: string): AddonQueries {
  const resolved = resolvePlanId(planId);
  if (resolved === "PRO") {
    return { fast: 200, advanced: 50 };
  } else if (resolved === "PREMIUM" || resolved === "ULTIMATE") {
    return { fast: 0, advanced: 200 };
  }
  return { fast: 0, advanced: 0 };
}

/** True if the (resolved) plan is the QUERY_PACK add-on rather than a main plan. */
export function isAddonPlan(planId: string): boolean {
  return resolvePlanId(planId) === "QUERY_PACK";
}

/**
 * True if a user on `existingPlanId` is allowed to buy a QUERY_PACK add-on.
 * Mirrors the PRO / PREMIUM / ULTIMATE gate in handlePaymentCompleted and the
 * callback. Resolves legacy ids first.
 */
export function isAddonEligible(existingPlanId: string): boolean {
  const resolved = resolvePlanId(existingPlanId);
  return (
    resolved === "PRO" || resolved === "PREMIUM" || resolved === "ULTIMATE"
  );
}

export interface QueryPackCarryForward {
  fastLimit: number;
  fastUsed: number | null;
  advancedLimit: number;
  advancedUsed: number | null;
}

/**
 * Query-pack carry-forward maths. When the subscription is ACTIVE, any unused
 * fast/advanced queries on the existing pack roll forward and the new pack is
 * added on top; otherwise the pack starts fresh. `Math.max(0, …)` floors a
 * negative (over-used) remaining at 0. Null limits/usage are treated as 0.
 */
export function calculateQueryPackLimits(
  existingFastLimit: number | null,
  existingFastUsed: number | null,
  existingAdvancedLimit: number | null,
  existingAdvancedUsed: number | null,
  additionalQueries: AddonQueries,
  isActive: boolean,
): { fastLimit: number; advancedLimit: number } {
  const existingFastRemaining = Math.max(
    0,
    (existingFastLimit ?? 0) - (existingFastUsed ?? 0),
  );
  const existingAdvancedRemaining = Math.max(
    0,
    (existingAdvancedLimit ?? 0) - (existingAdvancedUsed ?? 0),
  );

  const fastLimit = isActive
    ? existingFastRemaining + additionalQueries.fast
    : additionalQueries.fast;
  const advancedLimit = isActive
    ? existingAdvancedRemaining + additionalQueries.advanced
    : additionalQueries.advanced;

  return { fastLimit, advancedLimit };
}

// ---------------------------------------------------------------------------
// Unified credit-pack helpers (MONEY-298 cycle-7 ledger). Shared by the Dodo
// WEBHOOK and the redirect CALLBACK: both compete for the same one-shot
// appliedAt claim, so whichever path wins must apply the *same* grant. The
// webhook previously granted only the legacy queryPack* counters here, which
// silently dropped the pack-credit grant whenever it beat the callback to the
// claim (paid invoice, no credits added).
// ---------------------------------------------------------------------------

/**
 * Pack size of a credit-pack purchase, recovered from the paid Payment
 * record. The checkout normalizes CREDIT_PACK_N → QUERY_PACK for the Dodo
 * product lookup, so N only survives on the Payment row. Fallback chain:
 *   1. metadata.creditPackSize   (cycle-7 + later checkouts)
 *   2. metadata.originalPlanId   ("CREDIT_PACK_50")
 *   3. planName                  ("Credit Pack (50 credits)")
 * Legacy query-pack purchases (no credit-pack markers anywhere) return 0.
 */
export function extractCreditPackSize(
  metadata: unknown,
  planName: string | null | undefined,
): number {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.creditPackSize === "number" && meta.creditPackSize > 0) {
    return meta.creditPackSize;
  }
  if (typeof meta.originalPlanId === "string") {
    const m = /^CREDIT_PACK_(\d+)$/.exec(meta.originalPlanId);
    if (m?.[1]) return parseInt(m[1], 10);
  }
  if (planName) {
    const m = /Credit Pack \((\d+) credits\)/i.exec(planName);
    if (m?.[1]) return parseInt(m[1], 10);
  }
  return 0;
}

/**
 * Pack-credit carry-forward maths (mirrors calculateQueryPackLimits): on an
 * ACTIVE subscription the unused pack credits roll forward under the new
 * limit and usage resets to 0; otherwise the pack starts fresh. Null
 * limits/usage are treated as 0; over-used balances floor at 0.
 */
export function calculatePackCreditLimit(
  existingLimit: number | null,
  existingUsed: number | null,
  purchasedCredits: number,
  isActive: boolean,
): number {
  const existingRemaining = Math.max(
    0,
    (existingLimit ?? 0) - (existingUsed ?? 0),
  );
  return isActive ? existingRemaining + purchasedCredits : purchasedCredits;
}

/** 30 days in milliseconds — the default subscription/pack window. */
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** 365 days in milliseconds — the annual subscription window. */
export const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * End date for a main-plan grant. FREE and PRO (one-time / lifetime) have no
 * end date; recurring plans (PREMIUM / ULTIMATE) end 1 year out for an
 * `annual` period, otherwise 30 days out.
 *
 * `now` is injectable for deterministic tests; defaults to `Date.now()`.
 */
export function determineEndDate(
  resolvedPlan: string,
  period: string | null = null,
  now: number = Date.now(),
): Date | null {
  if (resolvedPlan === "FREE") return null;
  if (resolvedPlan === "PRO") return null; // One-time purchase - lifetime
  if (period === "annual") {
    return new Date(now + ONE_YEAR_MS);
  }
  return new Date(now + THIRTY_DAYS_MS);
}

/**
 * Renewal end date — 1 year for an annual billing period, else 30 days.
 * `now` injectable for tests.
 */
export function determineRenewalEndDate(
  billingPeriod: string | null,
  now: number = Date.now(),
): Date {
  return billingPeriod === "annual"
    ? new Date(now + ONE_YEAR_MS)
    : new Date(now + THIRTY_DAYS_MS);
}

/**
 * Query-pack end date: when the subscription is ACTIVE and already has an end
 * date, the pack inherits it (so the pack expires with the plan); otherwise the
 * pack gets its own 30-day window.
 */
export function determineQueryPackEndDate(
  status: string,
  endDate: Date | null,
  now: number = Date.now(),
): Date {
  if (status === "ACTIVE" && endDate) {
    return endDate;
  }
  return new Date(now + THIRTY_DAYS_MS);
}

/** Human-readable plan name for transactional emails. */
export function getReadablePlanName(planId: string): string {
  if (planId === "PREMIUM") return "Premium";
  if (planId === "PRO") return "Pro";
  return planId;
}

// ---------------------------------------------------------------------------
// Fulfillment idempotency (MONEY-594).
// ---------------------------------------------------------------------------

/**
 * Pure decision half of the one-shot fulfillment claim. The DB does the atomic
 * compare-and-set via
 *   `prisma.payment.updateMany({ where: { id, appliedAt: null }, data: { appliedAt } })`
 * and reports `count`. This function encodes the rule the route applies to that
 * count: the grant proceeds iff EXACTLY one row flipped (the caller that won the
 * race). A re-delivered webhook / replayed callback sees `count === 0` and skips
 * the grant. Extracted so the "apply exactly once" invariant is unit-testable
 * without a live Prisma connection.
 */
export function shouldApplyFulfillment(claimUpdateCount: number): boolean {
  return claimUpdateCount === 1;
}

// ---------------------------------------------------------------------------
// Checkout helpers (used by the create-checkout route).
// ---------------------------------------------------------------------------

/**
 * Validate a requested checkout plan id against `PLAN_CONFIG`. Unknown plan →
 * "Invalid plan"; FREE → rejected (no payment needed). Mirrors the guards at
 * the top of the create-checkout handler.
 */
export function validateCheckoutPlan(
  planId: string,
  config: Record<string, DodoPlanConfig> = PLAN_CONFIG,
): { valid: boolean; error?: string } {
  const plan = config[planId];
  if (!plan) {
    return { valid: false, error: "Invalid plan" };
  }
  if (planId === "FREE") {
    return { valid: false, error: "Free plan does not require payment" };
  }
  return { valid: true };
}

/** Build the Dodo `return_url` the callback handler is hit on. */
export function buildCheckoutReturnUrl(
  baseUrl: string,
  paymentId: string,
  planId: string,
): string {
  return `${baseUrl}/api/payments/callback?paymentId=${paymentId}&planId=${planId}`;
}

/** Build the Dodo `product_id` for a plan (`tradebook_<lowercased planId>`). */
export function buildCheckoutProductId(planId: string): string {
  return `tradebook_${planId.toLowerCase()}`;
}

/** Success JSON body returned by the create-checkout route. */
export function formatCheckoutResponse(
  checkoutUrl: string | null | undefined,
  paymentId: string,
): {
  success: true;
  checkoutUrl: string | null | undefined;
  paymentId: string;
} {
  return {
    success: true,
    checkoutUrl,
    paymentId,
  };
}

/** Resolve the customer display name for the checkout (fullName → firstName → "Customer"). */
export function getCheckoutCustomerName(
  fullName: string | null | undefined,
  firstName: string | null | undefined,
): string {
  return fullName || firstName || "Customer";
}
