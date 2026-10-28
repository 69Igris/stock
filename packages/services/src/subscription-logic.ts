/**
 * Subscription Entitlement Logic — pure, Prisma-free, SINGLE SOURCE OF TRUTH.
 *
 * The live `subscription.service.ts` CALLS these helpers so the production
 * access-control path and its regression tests execute the SAME code (no
 * shadows). Everything here is a pure function of its arguments — no DB, no
 * Clerk, no clock except the explicit `now` parameter — so it is exhaustively
 * testable and safe to import from any runtime (web action, Hono API, worker).
 *
 * Plan config is NOT forked: base-plan / feature / credit facts are read from
 * `@usemoney/core/subscription` (`PLAN_CONFIG`, `resolvePlanId`,
 * `hasFeatureAccess`, `FEATURE_ACCESS`). This module only adds the *decisions*
 * the service used to inline: base-plan resolution, expiry/grace
 * classification, status normalization, entitlement gating, and per-tier
 * usage limits.
 *
 * SECURITY POSTURE — every decision FAILS CLOSED to the least privilege (FREE):
 *   - A missing / null / unknown / legacy-unmapped plan resolves to FREE,
 *     never to a paid tier.
 *   - A non-ACTIVE (EXPIRED / CANCELLED / PAST_DUE) subscription grants NO
 *     paid entitlement — `resolveEntitlementPlan` collapses it to FREE.
 *   - An EXPIRED grace period (now strictly past endDate) drops the higher
 *     entitlement immediately.
 *   - An Invalid-Date expiry is treated as EXPIRED (closed), NEVER as
 *     "never expires" — `new Date("garbage") > now` is `false`, which would
 *     otherwise leak a privileged plan forever.
 *   - Non-finite / NaN usage counts never crash gating; they read as 0 used.
 *
 * Source of the inlined logic: packages/services/src/subscription.service.ts
 */

import {
  PLAN_CONFIG,
  resolvePlanId,
  hasFeatureAccess,
  getPlanCredits,
  type PlanId,
  type Feature,
} from "@usemoney/core/subscription";
// Type-only (erased at runtime, so this stays load-pure): the metadata patch
// must be Prisma's JSON input shape, not Record<string, unknown>, to feed
// straight into prisma.payment.update.
import type { Prisma } from "@usemoney/database";

// ── Plan / status vocabulary ─────────────────────────────────────────

/**
 * The four real entitlement tiers, lowest → highest privilege. (QUERY_PACK is
 * an addon, never a base entitlement tier; legacy IDs resolve via `resolvePlanId`.)
 */
export type BasePlan = "FREE" | "PRO" | "PREMIUM" | "ULTIMATE";

/** Privilege ordering — used for "drop to least privilege" decisions. */
export const PLAN_RANK: Record<BasePlan, number> = {
  FREE: 0,
  PRO: 1,
  PREMIUM: 2,
  ULTIMATE: 3,
};

/** Subscription lifecycle states (mirrors Prisma `SubscriptionStatus`). */
export type SubscriptionStatusLike =
  | "ACTIVE"
  | "CANCELLED"
  | "EXPIRED"
  | "PAST_DUE"
  | string
  | null
  | undefined;

/** Only ACTIVE grants paid entitlement; every other state fails closed. */
export function isActiveStatus(status: SubscriptionStatusLike): boolean {
  return status === "ACTIVE";
}

/**
 * Resolve any plan id to one of the four base entitlement tiers.
 *
 * Fails closed: null / "" / unknown strings / legacy IDs that don't map to a
 * real tier (and QUERY_PACK, which is an addon, not a tier) all become FREE.
 * This is the guard against an attacker (or a corrupt row) supplying e.g.
 * "PRO_HACK" or "ULTIMATE " and being fail-OPEN granted a paid tier.
 */
export function resolveBasePlan(planId: string | null | undefined): BasePlan {
  if (typeof planId !== "string" || planId.length === 0) return "FREE";
  const resolved = resolvePlanId(planId);
  if (
    resolved === "FREE" ||
    resolved === "PRO" ||
    resolved === "PREMIUM" ||
    resolved === "ULTIMATE"
  ) {
    return resolved;
  }
  // QUERY_PACK / anything unexpected → least privilege.
  return "FREE";
}

// ── Expiry / grace-period classification ─────────────────────────────

export type ExpiryClass = "active" | "at-boundary" | "expired" | "invalid";

/**
 * Is `date` a usable Date instant? Guards every downstream comparison against
 * the `new Date("garbage")` / `null` / non-finite-epoch trap that silently
 * makes `now > date` evaluate to `false` (i.e. "never expires").
 */
export function isValidDate(date: unknown): date is Date {
  return date instanceof Date && Number.isFinite(date.getTime());
}

/**
 * Classify an end/expiry instant against `now`. The boundary is EXACT and uses
 * strict `>` (matches the service: a subscription is live up to and INCLUDING
 * the exact expiry instant; it expires only once `now` is strictly past it).
 *
 * IST note: `endDate` and `now` are absolute instants (epoch ms), so the
 * comparison is timezone-independent — IST vs UTC does not move the instant.
 * Where a *calendar-day* boundary matters (grace math below) we add the IST
 * offset explicitly rather than relying on the host TZ.
 *
 *   - null endDate            → "active" (no expiry set ⇒ not expiring here)
 *   - Invalid Date            → "invalid" (callers treat as EXPIRED — closed)
 *   - now <  endDate          → "active"
 *   - now == endDate (to ms)  → "at-boundary" (still entitled)
 *   - now >  endDate          → "expired"
 */
export function classifyExpiry(
  endDate: Date | null | undefined,
  now: Date = new Date(),
): ExpiryClass {
  if (endDate === null || endDate === undefined) return "active";
  if (!isValidDate(endDate)) return "invalid";
  const nowMs = isValidDate(now) ? now.getTime() : Date.now();
  const endMs = endDate.getTime();
  if (nowMs > endMs) return "expired";
  if (nowMs === endMs) return "at-boundary";
  return "active";
}

/**
 * Has a grace period / subscription expired? FAILS CLOSED: an Invalid-Date
 * endDate counts as EXPIRED (never "never expires"). `null` endDate ⇒ not
 * expired (there is simply no expiry boundary in play). Exactly-at-boundary
 * is NOT expired (still entitled at the instant).
 */
export function isExpired(
  endDate: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  const cls = classifyExpiry(endDate, now);
  return cls === "expired" || cls === "invalid";
}

// ── PRO entitlement expiry (lifetime / annual / monthly) ─────────────

export interface ProEntitlementFields {
  proEntitlementType?: string | null;
  proEntitlementStartDate?: Date | null;
  proEntitlementEndDate?: Date | null;
}

/**
 * Has a subscription's PRO entitlement expired?
 *
 * - no type set                → expired (nothing to grant)
 * - "lifetime"                 → expires 10y after start; missing/invalid
 *                                start ⇒ expired (fail closed)
 * - "annual" / "monthly"       → expires at proEntitlementEndDate; missing/
 *                                invalid end ⇒ expired (fail closed)
 *
 * This is the de-shadowed source of `subscription.service.ts#isProEntitlementExpired`
 * with the added Invalid-Date guard.
 */
export function isProEntitlementExpired(
  sub: ProEntitlementFields,
  now: Date = new Date(),
): boolean {
  if (!sub.proEntitlementType) return true;
  const nowMs = isValidDate(now) ? now.getTime() : Date.now();

  if (sub.proEntitlementType === "lifetime") {
    if (!isValidDate(sub.proEntitlementStartDate)) return true;
    const cap = new Date(sub.proEntitlementStartDate);
    cap.setFullYear(cap.getFullYear() + 10);
    return nowMs > cap.getTime();
  }

  // annual / monthly
  if (!isValidDate(sub.proEntitlementEndDate)) return true;
  return nowMs > sub.proEntitlementEndDate.getTime();
}

// ── Effective entitlement resolution (the access-control core) ───────

export interface EntitlementInput extends ProEntitlementFields {
  planId: string | null | undefined;
  status: SubscriptionStatusLike;
  /** Grace-period end (set only by a downgrade). */
  endDate?: Date | null;
}

export interface EntitlementResolution {
  /** The tier whose features the caller ACTUALLY gets right now. */
  plan: BasePlan;
  /** Why we landed on `plan` — useful for logs / self-heal decisions. */
  reason:
    | "active"
    | "inactive-status"
    | "grace-expired-to-pro"
    | "grace-expired-to-free"
    | "unknown-plan";
}

/**
 * Resolve the EFFECTIVE entitlement plan for a subscription. This is THE
 * function access-control must trust — it folds together base-plan resolution,
 * status, grace-period expiry (Invalid-Date-safe) and the PRO-entitlement
 * fallback, and it ALWAYS fails closed to FREE.
 *
 * Decision order (load-bearing):
 *   1. Resolve base plan; unknown ⇒ FREE (least privilege).
 *   2. Non-ACTIVE status ⇒ FREE (an EXPIRED/CANCELLED/PAST_DUE row grants
 *      nothing, even if planId still says PREMIUM — the entitlement-bypass fix).
 *   3. FREE base ⇒ FREE.
 *   4. endDate present AND expired (strict `>`, or Invalid-Date) ⇒ grace over:
 *        - coming from a tier ABOVE PRO with a still-valid PRO entitlement
 *          ⇒ fall back to PRO;
 *        - otherwise ⇒ FREE.
 *      (Exactly-at-boundary is NOT expired ⇒ keep the plan.)
 *   5. Otherwise ⇒ the resolved base plan.
 */
export function resolveEntitlementPlan(
  sub: EntitlementInput,
  now: Date = new Date(),
): EntitlementResolution {
  const base = resolveBasePlan(sub.planId);

  if (!isActiveStatus(sub.status)) {
    return { plan: "FREE", reason: "inactive-status" };
  }

  // An unknown planId that resolved to FREE while status is ACTIVE is just a
  // FREE user — but flag it so callers can self-heal a corrupt row.
  if (base === "FREE") {
    const wasUnknown =
      typeof sub.planId === "string" &&
      sub.planId.length > 0 &&
      resolvePlanId(sub.planId) !== "FREE";
    return { plan: "FREE", reason: wasUnknown ? "unknown-plan" : "active" };
  }

  // Grace-period expiry only matters for the paid tiers that set an endDate.
  if (
    sub.endDate !== null &&
    sub.endDate !== undefined &&
    isExpired(sub.endDate, now)
  ) {
    if (
      base !== "PRO" && // only fall back when coming from ABOVE PRO
      sub.proEntitlementType &&
      !isProEntitlementExpired(sub, now)
    ) {
      return { plan: "PRO", reason: "grace-expired-to-pro" };
    }
    return { plan: "FREE", reason: "grace-expired-to-free" };
  }

  return { plan: base, reason: "active" };
}

/**
 * Convenience: the effective entitlement TIER only. The one call most
 * entitlement gates want.
 */
export function getEffectivePlan(
  sub: EntitlementInput,
  now: Date = new Date(),
): BasePlan {
  return resolveEntitlementPlan(sub, now).plan;
}

// ── Feature gating (reuses core FEATURE_ACCESS — no fork) ─────────────

/**
 * Does this subscription entitle the caller to `feature` RIGHT NOW?
 *
 * Gates on the EFFECTIVE plan (status + expiry applied), then defers to the
 * core `hasFeatureAccess` map. So an expired PREMIUM asking for `taxAnalysis`
 * is correctly DENIED, and a downgraded plan loses higher features immediately.
 * Fails closed on any unknown feature/plan.
 */
export function isFeatureEntitled(
  sub: EntitlementInput,
  feature: Feature,
  now: Date = new Date(),
): boolean {
  const plan = getEffectivePlan(sub, now);
  return hasFeatureAccess(plan, feature);
}

// ── Per-tier usage / broker limits ───────────────────────────────────

/**
 * Max simultaneously-connected brokers per tier.
 *   FREE        → 1 (single broker, trial-style)
 *   PRO+        → unlimited (Infinity) — `unlimitedConnections` feature.
 * Unknown plans fail closed to the FREE limit.
 */
export function getBrokerLimit(planId: string | null | undefined): number {
  const plan = resolveBasePlan(planId);
  return plan === "FREE" ? 1 : Number.POSITIVE_INFINITY;
}

/**
 * Coerce a possibly-null / NaN / non-finite count to a safe non-negative
 * integer. Used so gating never throws or mis-decides on corrupt usage data.
 */
export function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Can the caller connect ANOTHER broker, given how many they already have?
 *
 * Off-by-one correct at the tier boundary: FREE allows EXACTLY 1 broker, so the
 * decision is `currentCount < limit`. With limit 1: count 0 ⇒ allowed (1st),
 * count 1 ⇒ REJECTED (the 2nd). PRO+ (Infinity) is always allowed.
 * A non-finite / negative `currentCount` is treated as 0 (fail safe-but-open
 * only for the *count*, never for the *tier*).
 */
export function canConnectAnotherBroker(
  planId: string | null | undefined,
  currentCount: number,
): boolean {
  const limit = getBrokerLimit(planId);
  return safeCount(currentCount) < limit;
}

// ── Recurring-plan + credit helpers (used by getSubscription reset) ──

/**
 * Is this a recurring (monthly/annual reset) plan? PREMIUM/ULTIMATE always
 * recur; PRO recurs only when explicitly billed monthly/annual (lifetime PRO
 * does not). One-time plans (FREE, lifetime PRO, QUERY_PACK) never reset.
 * De-shadows the `isRecurringPlan` check inlined in `getSubscription`.
 */
export function isRecurringPlan(
  planId: string | null | undefined,
  billingPeriod: string | null | undefined,
): boolean {
  const resolved = resolveBasePlan(planId);
  if (resolved === "PREMIUM" || resolved === "ULTIMATE") return true;
  if (resolved === "PRO") {
    return billingPeriod === "annual" || billingPeriod === "monthly";
  }
  return false;
}

/** Monthly credit allocation for a plan (reuses core; FREE default = 5). */
export function getCreditLimitForPlan(
  planId: string | null | undefined,
): number {
  const plan = resolveBasePlan(planId);
  return getPlanCredits(plan);
}

// ── Status normalization / self-heal target ──────────────────────────

export interface NormalizedSubscription {
  planId: BasePlan;
  status: "ACTIVE" | "EXPIRED";
  /** True when the row needs to be rewritten to match (drives self-heal). */
  changed: boolean;
  reason: EntitlementResolution["reason"];
}

/**
 * Deterministic, IDEMPOTENT normalization for a (possibly stale) subscription
 * row. Resolves the effective plan, then reports what the row SHOULD say so a
 * caller can self-heal it.
 *
 * Guarantees:
 *   - A stale FREE-with-expired-PRO (or any non-ACTIVE paid) row resolves to
 *     { planId: FREE, status: EXPIRED }, deterministically.
 *   - Running it again on its own output is a no-op (`changed === false`) —
 *     idempotent.
 *   - An already-correct ACTIVE paid plan is left untouched (`changed === false`).
 */
export function normalizeSubscription(
  sub: EntitlementInput,
  now: Date = new Date(),
): NormalizedSubscription {
  const resolution = resolveEntitlementPlan(sub, now);
  const effectivePlan = resolution.plan;

  // The status the row should carry: ACTIVE iff the effective plan still
  // matches the (active) stored base plan; otherwise the entitlement collapsed
  // (inactive status, or grace/entitlement expiry) ⇒ EXPIRED.
  const storedBase = resolveBasePlan(sub.planId);
  const collapsed = effectivePlan !== storedBase || !isActiveStatus(sub.status);
  const targetStatus: "ACTIVE" | "EXPIRED" =
    collapsed && effectivePlan === "FREE" ? "EXPIRED" : "ACTIVE";

  const changed =
    effectivePlan !== storedBase ||
    (sub.status !== targetStatus &&
      // Only treat a status delta as a change when the plan also collapsed to
      // FREE; an ACTIVE paid plan that stays its tier is not "changed".
      effectivePlan === "FREE");

  return {
    planId: effectivePlan,
    status: targetStatus,
    changed,
    reason: resolution.reason,
  };
}

// ── Grace-period end-date math (downgrade) ───────────────────────────

/**
 * Compute the grace-period end date for a downgrade, given the resolved plan
 * and billing period. De-shadows `downgradeWithGracePeriod`'s date math.
 *   PRO              → start + 1 year
 *   PREMIUM/ULTIMATE annual → start + 1 year
 *   PREMIUM/ULTIMATE monthly|null → start + 1 month
 *   FREE / other     → null (immediate, no grace)
 *
 * Returns null for an invalid `startDate` (fail closed — no open-ended grace).
 */
export function calculateGracePeriodEndDate(
  planId: string | null | undefined,
  billingPeriod: string | null | undefined,
  startDate: Date,
): Date | null {
  if (!isValidDate(startDate)) return null;
  const resolved = resolveBasePlan(planId);

  if (resolved === "PRO") {
    const end = new Date(startDate);
    end.setFullYear(end.getFullYear() + 1);
    return end;
  }
  if (resolved === "PREMIUM" || resolved === "ULTIMATE") {
    const end = new Date(startDate);
    if (billingPeriod === "annual") {
      end.setFullYear(end.getFullYear() + 1);
    } else {
      end.setMonth(end.getMonth() + 1);
    }
    return end;
  }
  return null;
}

// ── Renewal-anchor derivation (RENEWS display fallback) ──────────────

/**
 * Derive the next renewal date for an ACTIVE recurring subscription whose
 * `nextBillingDate` anchor is missing (rows granted while webhooks were dead,
 * or by the legacy callback): roll the term start forward one billing period
 * at a time until it lands strictly in the future. Display fallback ONLY —
 * never persisted; Dodo stays the source of truth via the read-time heal.
 *
 * Returns null whenever the inputs can't produce a meaningful date: invalid
 * start, non-recurring plan (FREE, lifetime PRO, packs), or a recurring plan
 * whose billing period is unknown (don't guess a cycle length).
 */
export function deriveNextBillingDate(
  planId: string | null | undefined,
  billingPeriod: string | null | undefined,
  startDate: Date | string | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (!isRecurringPlan(planId, billingPeriod)) return null;
  if (billingPeriod !== "annual" && billingPeriod !== "monthly") return null;
  const start =
    startDate instanceof Date
      ? new Date(startDate)
      : new Date(startDate ?? NaN);
  if (!isValidDate(start) || !isValidDate(now)) return null;

  const next = new Date(start);
  // Bounded roll-forward (~100 years of monthly terms) — a corrupt ancient
  // start must not spin, and an in-range one converges far earlier.
  for (let i = 0; i < 1200 && next <= now; i++) {
    if (billingPeriod === "annual") next.setFullYear(next.getFullYear() + 1);
    else next.setMonth(next.getMonth() + 1);
  }
  return next > now ? next : null;
}

/** All four real tiers, for exhaustive iteration in tests/guards. */
export const BASE_PLANS: readonly BasePlan[] = [
  "FREE",
  "PRO",
  "PREMIUM",
  "ULTIMATE",
] as const;

/** Re-exported so callers don't double-import the core PlanId type alias. */
export type { PlanId, Feature };

// Compile-time guarantee that every BasePlan is a real PLAN_CONFIG key (and
// thus a real PlanId) — drift in core would break this assignment at build.
const _basePlanConfigGuard: Record<BasePlan, (typeof PLAN_CONFIG)[PlanId]> = {
  FREE: PLAN_CONFIG.FREE,
  PRO: PLAN_CONFIG.PRO,
  PREMIUM: PLAN_CONFIG.PREMIUM,
  ULTIMATE: PLAN_CONFIG.ULTIMATE,
};
void _basePlanConfigGuard;

// ---------------------------------------------------------------------------
// Pending-payment refresh logic (refreshPendingPayments).
//
// `refreshPendingPayments` polls Dodo for each PENDING payment and decides the
// DB patch. The decision half (which Dodo status → which {status, errorMessage}
// patch, and what a Dodo 404 means) is extracted here so the service CALLS it
// and tests run the same code instead of re-implementing it (a shadow).
// ---------------------------------------------------------------------------

/**
 * Subset of the Dodo payment-retrieve response the refresh path reads. Only
 * `status` is accessed by name (the whole object is still serialized into
 * metadata at runtime via JSON.stringify). No index signature: an index
 * signature would reject the concrete Dodo SDK `Payment` return type, which has
 * no index signature of its own. `status` is optional/nullable so the real
 * row's nullable status is accepted; the matchers fall through for a missing one.
 */
export interface DodoPaymentStatusLike {
  status?:
    | "succeeded"
    | "failed"
    | "cancelled"
    | "pending"
    | (string & {})
    | null;
}

/** The DB patch applied to a `Payment` row during refresh. */
export interface PaymentRefreshUpdate {
  status: "COMPLETED" | "FAILED";
  paidAt?: Date;
  errorMessage?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * True when an error from `dodoClient.payments.retrieve` is a 404 "not found".
 * A 404 means the Dodo payment id is bogus/expired → the row is marked FAILED so
 * we stop re-polling it on every page load. Mirrors the `is404` check exactly
 * (message contains "404" OR an `.status === 404` field).
 */
export function is404PaymentError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("404") ||
      (err as unknown as Record<string, unknown>).status === 404)
  );
}

/**
 * Sanitized error message stored when a payment 404s — must never leak raw Dodo
 * API details (URL / status / payment id) into the user-visible `errorMessage`.
 */
export function get404PaymentErrorMessage(): string {
  return "Payment could not be verified";
}

/**
 * Decide the DB patch for a refreshed Dodo payment, or `null` when no update is
 * needed (still pending). `succeeded` → COMPLETED + paidAt + metadata; `failed`/
 * `cancelled` → FAILED with a sanitized message + metadata. `now` is injectable
 * for deterministic tests.
 */
/**
 * MONEY-865: whether a scheduled plan change can be reversed via "Undo". Only a
 * renewing PAID subscription (a Dodo subscription exists to keep) is undoable. A
 * coupon FREE-grant has scheduledPlanId="FREE" but NO dodoSubscriptionId — its
 * auto-downgrade IS the grant's fixed term, so it must NOT be undoable (undoing
 * it would strand the user on the paid plan forever, for free).
 */
export function canUndoScheduledChange(
  scheduledPlanId: string | null | undefined,
  dodoSubscriptionId: string | null | undefined,
): boolean {
  return !!scheduledPlanId && !!dodoSubscriptionId;
}

/** PRO-entitlement persistence fields (a subset of the Subscription row). */
export interface ProEntitlementFields {
  proEntitlementType?: string | null;
  proEntitlementStartDate?: Date | null;
  proEntitlementEndDate?: Date | null;
}

/**
 * MONEY-866: build the PRO-entitlement fields for a plan grant. A PRO grant
 * stores its own entitlement so that a LATER downgrade from a higher tier falls
 * back to PRO instead of collapsing to FREE; a higher-tier (PREMIUM/ULTIMATE)
 * grant PRESERVES any existing PRO entitlement. This is the SINGLE source the
 * webhook, the payments callback, and updateSubscriptionPlan all use — previously
 * only the webhook wrote these fields, so a callback-won race, a changePlan
 * upgrade, or a coupon grant silently dropped the PRO downgrade-safety-net.
 *
 * The one-time "lifetime" PRO is deprecated, so an unknown/missing period
 * defaults to "monthly" (never the old decade-long "lifetime"). Pure: the caller
 * reads `existing` (for the preserve case) and persists the result.
 */
export function buildProEntitlementFields(input: {
  resolvedPlan: string;
  period: string | null | undefined;
  now: Date;
  existing?: ProEntitlementFields | null;
}): ProEntitlementFields {
  if (input.resolvedPlan === "PRO") {
    const entType = input.period === "annual" ? "annual" : "monthly";
    const ms = entType === "annual" ? 365 : 30;
    return {
      proEntitlementType: entType,
      proEntitlementStartDate: input.now,
      proEntitlementEndDate: new Date(
        input.now.getTime() + ms * 24 * 60 * 60 * 1000,
      ),
    };
  }
  // Higher tier: keep the user's existing PRO entitlement as a downgrade anchor.
  if (input.existing?.proEntitlementType) {
    return {
      proEntitlementType: input.existing.proEntitlementType,
      proEntitlementStartDate: input.existing.proEntitlementStartDate,
      proEntitlementEndDate: input.existing.proEntitlementEndDate,
    };
  }
  return {};
}

export function getPaymentRefreshUpdate(
  dodoPayment: DodoPaymentStatusLike,
  now: Date = new Date(),
  existingMetadata?: unknown,
): PaymentRefreshUpdate | null {
  // Merge (never replace) so the checkout-time keys the fulfillment paths
  // depend on (creditPackSize / originalPlanId / discountCode) survive the
  // poll — this clobber stranded real QA credit packs: the poller marked
  // them COMPLETED while wiping the pack size the grant reads (MONEY-764).
  const mergedMetadata = {
    ...((existingMetadata ?? {}) as object),
    ...JSON.parse(JSON.stringify(dodoPayment)),
  };
  if (dodoPayment.status === "succeeded") {
    return {
      status: "COMPLETED",
      paidAt: now,
      metadata: mergedMetadata,
    };
  }
  if (dodoPayment.status === "failed" || dodoPayment.status === "cancelled") {
    return {
      status: "FAILED",
      errorMessage:
        dodoPayment.status === "cancelled"
          ? "Payment was cancelled"
          : "Payment failed",
      metadata: mergedMetadata,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subscription access view (MONEY-1062) — pure builder relocated verbatim from
// apps/web/lib/subscription/access.ts. The web wrapper resolves Clerk → user and
// the service reads the Subscription row; THIS turns that row into the access
// view the UI consumes. Behaviour is preserved 1:1 (same `?? 0` handling, same
// no-legacy-resolve plan lookup, same fail-to-FREE branches).
// ---------------------------------------------------------------------------

export interface SubscriptionAccess {
  planId: string;
  planName: string;
  isActive: boolean;

  // Legacy query limits (kept for backward compat - use credits instead)
  fastQueriesUsed: number;
  fastQueriesLimit: number;
  advancedQueriesUsed: number;
  advancedQueriesLimit: number;

  // Unified credits (source of truth for UI)
  creditsUsed: number;
  creditsLimit: number; // plan monthly allocation (e.g. 50, 200, 750)
  packCreditsUsed: number;
  packCreditsLimit: number;
  totalCreditsRemaining: number;

  // Feature flags
  canAccessBrokerSync: boolean;
  canAccessAIQueries: boolean;
  canAccessAIStrategies: boolean;
  canAccessAILearning: boolean;
  canAccessStockDiscovery: boolean;
  canAccessUnlimitedConnections: boolean;
}

/**
 * The Subscription row fields `buildSubscriptionAccess` reads. Structural so the
 * live Prisma `Subscription` model (which has these + more) is assignable.
 */
export interface SubscriptionAccessRow {
  status: string;
  planId: string;
  fastQueriesUsed?: number | null;
  advancedQueriesUsed?: number | null;
  queryPackActive?: boolean | null;
  queryPackFastQueriesLimit?: number | null;
  queryPackFastQueriesUsed?: number | null;
  queryPackAdvancedQueriesLimit?: number | null;
  queryPackAdvancedQueriesUsed?: number | null;
  creditsUsed?: number | null;
  creditsLimit?: number | null;
  packCreditsLimit?: number | null;
  packCreditsUsed?: number | null;
}

export const DEFAULT_FREE_ACCESS: SubscriptionAccess = {
  planId: "FREE",
  planName: "Free",
  isActive: true,
  fastQueriesUsed: 0,
  fastQueriesLimit: 0,
  advancedQueriesUsed: 0,
  advancedQueriesLimit: 0,
  creditsUsed: 0,
  creditsLimit: 5,
  packCreditsUsed: 0,
  packCreditsLimit: 0,
  totalCreditsRemaining: 5,
  canAccessBrokerSync: false,
  // FREE plan can chat with Flash (cost = 0) and run research (5 credits/mo).
  // Real budget gating happens in CREDIT_COSTS + per-model requiresPlan,
  // not here. Was previously `false`, which caused the StockSage upgrade
  // prompt to fire on every free-user message (MONEY-295).
  canAccessAIQueries: true,
  canAccessAIStrategies: false,
  canAccessAILearning: false,
  canAccessStockDiscovery: false,
  canAccessUnlimitedConnections: false,
};

/**
 * Pure: derive the access view from a Subscription row (or null). Missing /
 * inactive / unknown-plan rows fall back to `DEFAULT_FREE_ACCESS`. Legacy plan
 * ids are intentionally NOT resolved for the plan lookup (verbatim from the
 * original `access.ts`); feature flags DO resolve legacy ids via
 * `hasFeatureAccess`.
 */
export function buildSubscriptionAccess(
  subscription: SubscriptionAccessRow | null | undefined,
): SubscriptionAccess {
  if (!subscription || subscription.status !== "ACTIVE") {
    return DEFAULT_FREE_ACCESS;
  }

  const planId = subscription.planId;
  const plan = PLAN_CONFIG[planId as keyof typeof PLAN_CONFIG];

  if (!plan) {
    return DEFAULT_FREE_ACCESS;
  }

  // Calculate total available queries (plan + query pack if active)
  let totalFastLimit = plan.fastQueries;
  let totalFastUsed = subscription.fastQueriesUsed ?? 0;

  // Calculate advanced queries (plan + query pack)
  let totalAdvancedLimit = plan.advancedQueries || 0;
  let totalAdvancedUsed = subscription.advancedQueriesUsed ?? 0;

  // Add query pack queries if active and plan is not FREE
  // Addon packs can only be used with active Pro/Premium plans
  if (
    subscription.queryPackActive &&
    subscription.status === "ACTIVE" &&
    subscription.planId !== "FREE"
  ) {
    const packFastLimit = subscription.queryPackFastQueriesLimit ?? 0;
    const packFastUsed = subscription.queryPackFastQueriesUsed ?? 0;
    const packAdvancedLimit = subscription.queryPackAdvancedQueriesLimit ?? 0;
    const packAdvancedUsed = subscription.queryPackAdvancedQueriesUsed ?? 0;

    // Add pack limits to plan limits (not remaining, but total limits)
    totalFastLimit =
      plan.fastQueries === -1 ? -1 : plan.fastQueries + packFastLimit;
    totalFastUsed = (subscription.fastQueriesUsed ?? 0) + packFastUsed;

    // Add advanced query pack limits
    totalAdvancedLimit =
      totalAdvancedLimit === -1 ? -1 : totalAdvancedLimit + packAdvancedLimit;
    totalAdvancedUsed = totalAdvancedUsed + packAdvancedUsed;
  }

  // Unified credits - use plan.credits as the limit, DB creditsUsed for usage
  const planCreditsLimit = plan.credits || 5;
  const dbCreditsUsed = subscription.creditsUsed ?? 0;
  // Override DB creditsLimit if it's stale (e.g. 5 when plan says 200)
  const effectiveCreditsLimit = Math.max(
    planCreditsLimit,
    subscription.creditsLimit ?? 0,
  );
  const packCreditsLimit = subscription.packCreditsLimit ?? 0;
  const packCreditsUsed = subscription.packCreditsUsed ?? 0;
  const planRemaining = Math.max(0, effectiveCreditsLimit - dbCreditsUsed);
  const packRemaining = Math.max(0, packCreditsLimit - packCreditsUsed);

  return {
    planId,
    planName: plan.name,
    isActive: subscription.status === "ACTIVE",

    // Legacy (backward compat)
    fastQueriesUsed: totalFastUsed,
    fastQueriesLimit: totalFastLimit,
    advancedQueriesUsed: totalAdvancedUsed,
    advancedQueriesLimit: totalAdvancedLimit,

    // Unified credits (UI should use these)
    creditsUsed: dbCreditsUsed,
    creditsLimit: effectiveCreditsLimit,
    packCreditsUsed,
    packCreditsLimit,
    totalCreditsRemaining: planRemaining + packRemaining,

    canAccessBrokerSync: hasFeatureAccess(planId, "brokerSync"),
    canAccessAIQueries: hasFeatureAccess(planId, "aiQueries"),
    canAccessAIStrategies: hasFeatureAccess(planId, "aiStrategies"),
    canAccessAILearning: hasFeatureAccess(planId, "aiLearning"),
    canAccessStockDiscovery: hasFeatureAccess(planId, "stockDiscovery"),
    canAccessUnlimitedConnections: hasFeatureAccess(
      planId,
      "unlimitedConnections",
    ),
  };
}
