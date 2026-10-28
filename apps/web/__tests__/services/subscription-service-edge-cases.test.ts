/**
 * Subscription Service — entitlement / tier security tests (MONEY-620).
 *
 * DE-SHADOWED. The previous version of this file reimplemented the ENTIRE
 * subscription logic inline (resolvePlanId, PLAN_CONFIG, consume/refund/grace
 * math) and asserted the COPIES — a textbook shadow (and its inline PLAN_CONFIG
 * had already drifted from the real source: ULTIMATE price 0, PREMIUM annual
 * 9999, etc.). It was green while it tested nothing real.
 *
 * This rewrite asserts the REAL exported logic two ways:
 *
 *   1. PURE LOGIC — imports the real exports from
 *      `packages/services/src/subscription-logic.ts` (a pure, Prisma-free
 *      module the live service CALLS) via a relative path and drives them with
 *      adversarial fixtures: expired/null/unknown plans, Invalid-Date expiry,
 *      IST boundary, broker off-by-one, non-finite usage, self-heal idempotency.
 *
 *   2. LIVE SERVICE — drives the REAL `getSubscription` /
 *      `downgradeWithGracePeriod` exported from
 *      `packages/services/src/subscription.service.ts` against a RECORDING
 *      prisma stub injected at the `@usemoney/database` module boundary via
 *      `require.cache` (the established `demo-routes-branches.test.ts` seam).
 *      So the production access-control path and these tests execute the SAME
 *      code — including the entitlement-bypass / Invalid-Date fixes.
 *
 * Source under test:
 *   - packages/services/src/subscription-logic.ts
 *   - packages/services/src/subscription.service.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── REAL pure logic (relative import — module is pure, no DB side-effects) ──
import {
  resolveBasePlan,
  resolveEntitlementPlan,
  getEffectivePlan,
  isFeatureEntitled,
  isExpired,
  classifyExpiry,
  isValidDate,
  isProEntitlementExpired,
  isRecurringPlan,
  getBrokerLimit,
  canConnectAnotherBroker,
  safeCount,
  normalizeSubscription,
  calculateGracePeriodEndDate,
  getCreditLimitForPlan,
  isActiveStatus,
  PLAN_RANK,
  BASE_PLANS,
  type EntitlementInput,
} from "../../../../packages/services/src/subscription-logic";

// ════════════════════════════════════════════════════════════════════
// PART 1 — PURE ENTITLEMENT LOGIC (real exports)
// ════════════════════════════════════════════════════════════════════

describe("subscription-logic: resolveBasePlan (fail-closed)", () => {
  it("resolves the four real tiers as themselves", () => {
    assert.equal(resolveBasePlan("FREE"), "FREE");
    assert.equal(resolveBasePlan("PRO"), "PRO");
    assert.equal(resolveBasePlan("PREMIUM"), "PREMIUM");
    assert.equal(resolveBasePlan("ULTIMATE"), "ULTIMATE");
  });

  it("maps legacy IDs through resolvePlanId (AI_UNLIMITED -> PREMIUM)", () => {
    assert.equal(resolveBasePlan("AI_UNLIMITED"), "PREMIUM");
    assert.equal(resolveBasePlan("AI_PRO"), "PREMIUM");
  });

  it("[SECURITY] null/undefined/empty plan -> FREE (least privilege, NOT fail-open)", () => {
    assert.equal(resolveBasePlan(null), "FREE");
    assert.equal(resolveBasePlan(undefined), "FREE");
    assert.equal(resolveBasePlan(""), "FREE");
  });

  it("[SECURITY] unknown/garbage plan strings -> FREE, never a paid tier", () => {
    assert.equal(resolveBasePlan("PRO_HACK"), "FREE");
    assert.equal(resolveBasePlan("ULTIMATE "), "FREE"); // trailing space
    assert.equal(resolveBasePlan("premium"), "FREE"); // wrong case
    assert.equal(resolveBasePlan("{}"), "FREE");
  });

  it("[SECURITY] QUERY_PACK (an addon) is NOT a base entitlement tier -> FREE", () => {
    assert.equal(resolveBasePlan("QUERY_PACK"), "FREE");
    assert.equal(resolveBasePlan("AI_ADDON"), "FREE"); // legacy -> QUERY_PACK -> FREE
  });
});

describe("subscription-logic: isValidDate / classifyExpiry / isExpired", () => {
  const now = new Date("2026-06-05T12:00:00.000Z");

  it("isValidDate rejects null, non-Date, and Invalid Date", () => {
    assert.equal(isValidDate(new Date("2026-01-01")), true);
    assert.equal(isValidDate(null), false);
    assert.equal(isValidDate(undefined), false);
    assert.equal(isValidDate("2026-01-01"), false);
    assert.equal(isValidDate(new Date("not-a-date")), false);
    assert.equal(isValidDate(new Date(NaN)), false);
  });

  it("null endDate classifies active / not expired (no boundary in play)", () => {
    assert.equal(classifyExpiry(null, now), "active");
    assert.equal(isExpired(null, now), false);
  });

  it("future endDate -> active; past endDate -> expired", () => {
    assert.equal(classifyExpiry(new Date("2026-12-31"), now), "active");
    assert.equal(isExpired(new Date("2026-12-31"), now), false);
    assert.equal(classifyExpiry(new Date("2026-01-01"), now), "expired");
    assert.equal(isExpired(new Date("2026-01-01"), now), true);
  });

  it("[boundary] exactly-at-expiry (now === endDate to the ms) is NOT expired", () => {
    const at = new Date(now.getTime());
    assert.equal(classifyExpiry(at, now), "at-boundary");
    assert.equal(
      isExpired(at, now),
      false,
      "still entitled at the exact instant"
    );
  });

  it("[boundary] 1ms past expiry IS expired; 1ms before is NOT", () => {
    assert.equal(isExpired(new Date(now.getTime() - 1), now), true);
    assert.equal(isExpired(new Date(now.getTime() + 1), now), false);
  });

  it("[boundary][IST] endDate set to IST midnight compares by instant, not host TZ", () => {
    // 2026-06-06 00:00:00 IST == 2026-06-05 18:30:00 UTC. With now slightly
    // before that instant, the sub is still active regardless of server TZ.
    const istMidnightUtc = new Date("2026-06-05T18:30:00.000Z");
    const justBefore = new Date("2026-06-05T18:29:59.999Z");
    const justAfter = new Date("2026-06-05T18:30:00.001Z");
    assert.equal(isExpired(istMidnightUtc, justBefore), false);
    assert.equal(isExpired(istMidnightUtc, istMidnightUtc), false); // at-boundary
    assert.equal(isExpired(istMidnightUtc, justAfter), true);
  });

  it("[SECURITY] Invalid-Date endDate classifies 'invalid' and counts as EXPIRED", () => {
    // The trap: `now > new Date("garbage")` is false, which would mean
    // "never expires". We FAIL CLOSED instead.
    const bad = new Date("garbage");
    assert.equal(classifyExpiry(bad, now), "invalid");
    assert.equal(
      isExpired(bad, now),
      true,
      "Invalid Date must NOT be 'never expires'"
    );
    assert.equal(isExpired(new Date(NaN), now), true);
  });
});

describe("subscription-logic: isProEntitlementExpired (real export)", () => {
  it("no entitlement type -> expired", () => {
    assert.equal(isProEntitlementExpired({ proEntitlementType: null }), true);
    assert.equal(isProEntitlementExpired({}), true);
  });

  it("lifetime: within 10y not expired; past 10y expired", () => {
    const start = new Date("2025-01-01");
    assert.equal(
      isProEntitlementExpired(
        { proEntitlementType: "lifetime", proEntitlementStartDate: start },
        new Date("2030-06-15")
      ),
      false
    );
    assert.equal(
      isProEntitlementExpired(
        { proEntitlementType: "lifetime", proEntitlementStartDate: start },
        new Date("2036-01-02")
      ),
      true
    );
  });

  it("lifetime with missing start -> expired (fail closed)", () => {
    assert.equal(
      isProEntitlementExpired({
        proEntitlementType: "lifetime",
        proEntitlementStartDate: null,
      }),
      true
    );
  });

  it("annual/monthly: future end not expired; past end expired", () => {
    assert.equal(
      isProEntitlementExpired(
        {
          proEntitlementType: "annual",
          proEntitlementEndDate: new Date("2026-01-01"),
        },
        new Date("2025-06-15")
      ),
      false
    );
    assert.equal(
      isProEntitlementExpired(
        {
          proEntitlementType: "monthly",
          proEntitlementEndDate: new Date("2025-01-31"),
        },
        new Date("2025-02-15")
      ),
      true
    );
  });

  it("[SECURITY] annual with Invalid-Date end -> expired (NOT 'never expires')", () => {
    assert.equal(
      isProEntitlementExpired({
        proEntitlementType: "annual",
        proEntitlementEndDate: new Date("garbage"),
      }),
      true
    );
    assert.equal(
      isProEntitlementExpired({
        proEntitlementType: "monthly",
        proEntitlementEndDate: null,
      }),
      true
    );
  });
});

describe("subscription-logic: resolveEntitlementPlan (access-control core)", () => {
  function sub(overrides: Partial<EntitlementInput> = {}): EntitlementInput {
    return { planId: "PREMIUM", status: "ACTIVE", endDate: null, ...overrides };
  }
  const now = new Date("2026-06-05T12:00:00.000Z");

  it("active paid plan with no endDate -> that plan (behavior preserved)", () => {
    assert.deepEqual(resolveEntitlementPlan(sub({ planId: "PRO" }), now), {
      plan: "PRO",
      reason: "active",
    });
    assert.deepEqual(resolveEntitlementPlan(sub({ planId: "PREMIUM" }), now), {
      plan: "PREMIUM",
      reason: "active",
    });
    assert.deepEqual(resolveEntitlementPlan(sub({ planId: "ULTIMATE" }), now), {
      plan: "ULTIMATE",
      reason: "active",
    });
  });

  it("[BYPASS] EXPIRED status + planId PREMIUM -> FREE (no privilege leak)", () => {
    const r = resolveEntitlementPlan(sub({ status: "EXPIRED" }), now);
    assert.equal(r.plan, "FREE");
    assert.equal(r.reason, "inactive-status");
  });

  it("[BYPASS] CANCELLED / PAST_DUE status -> FREE", () => {
    assert.equal(getEffectivePlan(sub({ status: "CANCELLED" }), now), "FREE");
    assert.equal(getEffectivePlan(sub({ status: "PAST_DUE" }), now), "FREE");
    assert.equal(getEffectivePlan(sub({ status: null }), now), "FREE");
    assert.equal(getEffectivePlan(sub({ status: "active" }), now), "FREE"); // wrong case
  });

  it("[BYPASS] active PREMIUM whose grace endDate is in the PAST -> drops immediately", () => {
    // No PRO entitlement -> straight to FREE the moment grace is over.
    const r = resolveEntitlementPlan(
      sub({ endDate: new Date("2026-01-01") }),
      now
    );
    assert.equal(r.plan, "FREE");
    assert.equal(r.reason, "grace-expired-to-free");
  });

  it("[boundary] PREMIUM with grace endDate EXACTLY now -> still PREMIUM (not dropped)", () => {
    const r = resolveEntitlementPlan(
      sub({ endDate: new Date(now.getTime()) }),
      now
    );
    assert.equal(r.plan, "PREMIUM");
    assert.equal(r.reason, "active");
  });

  it("PREMIUM grace expired + VALID PRO entitlement -> falls back to PRO", () => {
    const r = resolveEntitlementPlan(
      sub({
        endDate: new Date("2026-01-01"),
        proEntitlementType: "lifetime",
        proEntitlementStartDate: new Date("2025-01-01"),
      }),
      now
    );
    assert.equal(r.plan, "PRO");
    assert.equal(r.reason, "grace-expired-to-pro");
  });

  it("PREMIUM grace expired + EXPIRED PRO entitlement -> FREE", () => {
    const r = resolveEntitlementPlan(
      sub({
        endDate: new Date("2026-01-01"),
        proEntitlementType: "annual",
        proEntitlementEndDate: new Date("2025-01-01"), // already past
      }),
      now
    );
    assert.equal(r.plan, "FREE");
    assert.equal(r.reason, "grace-expired-to-free");
  });

  it("PRO grace expired never 'falls back to PRO' (only higher tiers do) -> FREE", () => {
    const r = resolveEntitlementPlan(
      sub({
        planId: "PRO",
        endDate: new Date("2026-01-01"),
        proEntitlementType: "lifetime",
        proEntitlementStartDate: new Date("2025-01-01"),
      }),
      now
    );
    assert.equal(r.plan, "FREE");
  });

  it("[SECURITY] Invalid-Date grace endDate on PREMIUM -> treated EXPIRED -> FREE", () => {
    const r = resolveEntitlementPlan(
      sub({ endDate: new Date("garbage") }),
      now
    );
    assert.equal(r.plan, "FREE", "garbage endDate must NOT keep PREMIUM alive");
  });

  it("[SECURITY] unknown planId while ACTIVE -> FREE + 'unknown-plan' reason", () => {
    const r = resolveEntitlementPlan(sub({ planId: "SUPER_ADMIN" }), now);
    assert.equal(r.plan, "FREE");
    assert.equal(r.reason, "unknown-plan");
  });

  it("[DOWNGRADE] a row downgraded to FREE drops higher entitlement at once", () => {
    assert.equal(getEffectivePlan(sub({ planId: "FREE" }), now), "FREE");
  });
});

describe("subscription-logic: isFeatureEntitled (gates on EFFECTIVE plan)", () => {
  const now = new Date("2026-06-05T12:00:00.000Z");

  it("active PREMIUM gets taxAnalysis/riskAnalysis/learningContent", () => {
    const s: EntitlementInput = { planId: "PREMIUM", status: "ACTIVE" };
    assert.equal(isFeatureEntitled(s, "taxAnalysis", now), true);
    assert.equal(isFeatureEntitled(s, "riskAnalysis", now), true);
    assert.equal(isFeatureEntitled(s, "learningContent", now), true);
  });

  it("[BYPASS] EXPIRED PREMIUM is DENIED premium features (gated on effective FREE)", () => {
    const s: EntitlementInput = { planId: "PREMIUM", status: "EXPIRED" };
    assert.equal(isFeatureEntitled(s, "taxAnalysis", now), false);
    assert.equal(isFeatureEntitled(s, "riskAnalysis", now), false);
    assert.equal(isFeatureEntitled(s, "documentVault", now), false);
  });

  it("[BYPASS] PREMIUM past its grace endDate is DENIED premium features", () => {
    const s: EntitlementInput = {
      planId: "PREMIUM",
      status: "ACTIVE",
      endDate: new Date("2026-01-01"),
    };
    assert.equal(isFeatureEntitled(s, "taxAnalysis", now), false);
  });

  it("PRO is denied PREMIUM-only features but keeps portfolioRoast/aiAnalysis", () => {
    const s: EntitlementInput = { planId: "PRO", status: "ACTIVE" };
    assert.equal(isFeatureEntitled(s, "taxAnalysis", now), false);
    assert.equal(isFeatureEntitled(s, "aiStrategies", now), false);
    assert.equal(isFeatureEntitled(s, "portfolioRoast", now), true);
    assert.equal(isFeatureEntitled(s, "aiAnalysis", now), true);
  });

  it("FREE retains the free features (basicPortfolio, fireCalculator, aiQueries)", () => {
    const s: EntitlementInput = { planId: "FREE", status: "ACTIVE" };
    assert.equal(isFeatureEntitled(s, "basicPortfolio", now), true);
    assert.equal(isFeatureEntitled(s, "fireCalculator", now), true);
    assert.equal(isFeatureEntitled(s, "aiQueries", now), true);
    assert.equal(isFeatureEntitled(s, "portfolioRoast", now), false);
  });

  it("[SECURITY] unknown plan denied every premium feature (fail closed)", () => {
    const s: EntitlementInput = { planId: "HACK", status: "ACTIVE" };
    assert.equal(isFeatureEntitled(s, "taxAnalysis", now), false);
    assert.equal(isFeatureEntitled(s, "unlimitedConnections", now), false);
    // still gets the universal free features (effective FREE)
    assert.equal(isFeatureEntitled(s, "basicPortfolio", now), true);
  });
});

describe("subscription-logic: broker / usage limits (off-by-one)", () => {
  it("FREE broker limit is exactly 1; paid tiers are unlimited", () => {
    assert.equal(getBrokerLimit("FREE"), 1);
    assert.equal(getBrokerLimit("PRO"), Number.POSITIVE_INFINITY);
    assert.equal(getBrokerLimit("PREMIUM"), Number.POSITIVE_INFINITY);
    assert.equal(getBrokerLimit("ULTIMATE"), Number.POSITIVE_INFINITY);
  });

  it("[SECURITY] unknown plan broker limit fails closed to 1 (FREE)", () => {
    assert.equal(getBrokerLimit("HACK"), 1);
    assert.equal(getBrokerLimit(null), 1);
    assert.equal(getBrokerLimit("QUERY_PACK"), 1);
  });

  it("[off-by-one] FREE allows the 1st broker, REJECTS the 2nd", () => {
    assert.equal(
      canConnectAnotherBroker("FREE", 0),
      true,
      "1st broker allowed"
    );
    assert.equal(
      canConnectAnotherBroker("FREE", 1),
      false,
      "2nd broker REJECTED"
    );
    assert.equal(canConnectAnotherBroker("FREE", 2), false);
  });

  it("paid tiers allow connecting another broker at any count", () => {
    assert.equal(canConnectAnotherBroker("PRO", 0), true);
    assert.equal(canConnectAnotherBroker("PRO", 5), true);
    assert.equal(canConnectAnotherBroker("PREMIUM", 99), true);
  });

  it("[SECURITY] non-finite/negative currentCount coerced to 0 (no crash, no overflow grant)", () => {
    assert.equal(canConnectAnotherBroker("FREE", NaN), true); // treated as 0
    assert.equal(
      canConnectAnotherBroker("FREE", Number.POSITIVE_INFINITY),
      true
    );
    assert.equal(canConnectAnotherBroker("FREE", -3), true);
    // but the FREE limit still caps at 1 once a real count is present
    assert.equal(canConnectAnotherBroker("FREE", 1), false);
  });

  it("safeCount floors/guards garbage to a non-negative int", () => {
    assert.equal(safeCount(3.9), 3);
    assert.equal(safeCount(NaN), 0);
    assert.equal(safeCount(-5), 0);
    assert.equal(safeCount(Number.POSITIVE_INFINITY), 0);
    assert.equal(safeCount("7" as unknown), 0);
    assert.equal(safeCount(null), 0);
  });
});

describe("subscription-logic: isRecurringPlan / credits / status", () => {
  it("PREMIUM & ULTIMATE always recur; PRO only with monthly/annual billing", () => {
    assert.equal(isRecurringPlan("PREMIUM", null), true);
    assert.equal(isRecurringPlan("ULTIMATE", null), true);
    assert.equal(isRecurringPlan("PRO", "monthly"), true);
    assert.equal(isRecurringPlan("PRO", "annual"), true);
    assert.equal(isRecurringPlan("PRO", null), false); // lifetime PRO
    assert.equal(isRecurringPlan("FREE", null), false);
    assert.equal(isRecurringPlan("QUERY_PACK", null), false);
  });

  it("getCreditLimitForPlan mirrors core (FREE 5, PRO 50, PREMIUM 200, ULTIMATE 750)", () => {
    assert.equal(getCreditLimitForPlan("FREE"), 5);
    assert.equal(getCreditLimitForPlan("PRO"), 50);
    assert.equal(getCreditLimitForPlan("PREMIUM"), 200);
    assert.equal(getCreditLimitForPlan("ULTIMATE"), 750);
    assert.equal(getCreditLimitForPlan("HACK"), 5); // fail closed to FREE
  });

  it("isActiveStatus only true for exact 'ACTIVE'", () => {
    assert.equal(isActiveStatus("ACTIVE"), true);
    assert.equal(isActiveStatus("EXPIRED"), false);
    assert.equal(isActiveStatus("active"), false);
    assert.equal(isActiveStatus(null), false);
  });

  it("PLAN_RANK orders privilege FREE<PRO<PREMIUM<ULTIMATE; BASE_PLANS has all four", () => {
    assert.ok(PLAN_RANK.FREE < PLAN_RANK.PRO);
    assert.ok(PLAN_RANK.PRO < PLAN_RANK.PREMIUM);
    assert.ok(PLAN_RANK.PREMIUM < PLAN_RANK.ULTIMATE);
    assert.deepEqual([...BASE_PLANS], ["FREE", "PRO", "PREMIUM", "ULTIMATE"]);
  });
});

describe("subscription-logic: normalizeSubscription (self-heal, idempotent)", () => {
  const now = new Date("2026-06-05T12:00:00.000Z");

  it("active matching paid plan -> unchanged", () => {
    const n = normalizeSubscription(
      { planId: "PREMIUM", status: "ACTIVE" },
      now
    );
    assert.deepEqual(
      { planId: n.planId, status: n.status, changed: n.changed },
      { planId: "PREMIUM", status: "ACTIVE", changed: false }
    );
  });

  it("[self-heal] stale ACTIVE-PREMIUM whose grace expired + expired PRO ent -> FREE/EXPIRED + changed", () => {
    const stale: EntitlementInput = {
      planId: "PREMIUM",
      status: "ACTIVE",
      endDate: new Date("2026-01-01"),
      proEntitlementType: "annual",
      proEntitlementEndDate: new Date("2025-01-01"),
    };
    const n = normalizeSubscription(stale, now);
    assert.equal(n.planId, "FREE");
    assert.equal(n.status, "EXPIRED");
    assert.equal(n.changed, true);
  });

  it("[self-heal] EXPIRED-status PRO row -> FREE/EXPIRED + changed", () => {
    const n = normalizeSubscription({ planId: "PRO", status: "EXPIRED" }, now);
    assert.equal(n.planId, "FREE");
    assert.equal(n.status, "EXPIRED");
    assert.equal(n.changed, true);
  });

  it("[idempotent] normalizing the already-healed output is a no-op (changed=false)", () => {
    const stale: EntitlementInput = {
      planId: "PREMIUM",
      status: "ACTIVE",
      endDate: new Date("2026-01-01"),
    };
    const first = normalizeSubscription(stale, now);
    // Feed the healed result back in (FREE / EXPIRED) — must stabilize.
    const second = normalizeSubscription(
      { planId: first.planId, status: first.status },
      now
    );
    assert.equal(second.planId, "FREE");
    assert.equal(second.changed, false, "second pass must not flip anything");
    // and a third pass is identical
    const third = normalizeSubscription(
      { planId: second.planId, status: second.status },
      now
    );
    assert.deepEqual(
      { planId: third.planId, status: third.status, changed: third.changed },
      { planId: "FREE", status: "EXPIRED", changed: false }
    );
  });

  it("an already-FREE/ACTIVE row stays FREE/ACTIVE unchanged", () => {
    const n = normalizeSubscription({ planId: "FREE", status: "ACTIVE" }, now);
    assert.deepEqual(
      { planId: n.planId, status: n.status, changed: n.changed },
      { planId: "FREE", status: "ACTIVE", changed: false }
    );
  });
});

describe("subscription-logic: calculateGracePeriodEndDate", () => {
  it("PRO -> +1 year; PREMIUM annual -> +1y; PREMIUM monthly/null -> +1mo", () => {
    const start = new Date("2025-03-15T00:00:00.000Z");
    assert.equal(
      calculateGracePeriodEndDate("PRO", null, start)!.getUTCFullYear(),
      2026
    );
    assert.equal(
      calculateGracePeriodEndDate("PREMIUM", "annual", start)!.getUTCFullYear(),
      2026
    );
    const monthly = calculateGracePeriodEndDate("PREMIUM", "monthly", start)!;
    assert.equal(monthly.getUTCMonth(), 3); // April (from March)
    const nullBilling = calculateGracePeriodEndDate("PREMIUM", null, start)!;
    assert.equal(nullBilling.getUTCMonth(), 3);
  });

  it("FREE/QUERY_PACK/unknown -> null (immediate, no open-ended grace)", () => {
    const start = new Date("2025-01-01");
    assert.equal(calculateGracePeriodEndDate("FREE", null, start), null);
    assert.equal(calculateGracePeriodEndDate("QUERY_PACK", null, start), null);
    assert.equal(calculateGracePeriodEndDate("HACK", null, start), null);
  });

  it("[SECURITY] invalid startDate -> null (fail closed, no NaN grace)", () => {
    assert.equal(
      calculateGracePeriodEndDate("PREMIUM", "annual", new Date("garbage")),
      null
    );
  });

  it("legacy AI_UNLIMITED resolves to PREMIUM grace math", () => {
    const start = new Date("2025-01-01T00:00:00.000Z");
    const end = calculateGracePeriodEndDate("AI_UNLIMITED", "monthly", start)!;
    assert.equal(end.getUTCMonth(), 1); // Feb
  });
});

// ════════════════════════════════════════════════════════════════════
// PART 2 — LIVE SERVICE via recording-prisma seam (require.cache)
// ════════════════════════════════════════════════════════════════════

// ── Recording prisma stub keyed by userId (proves IDOR scoping) ─────────

interface SubRow {
  id: string;
  userId: string;
  planId: string;
  status: string;
  billingPeriod: string | null;
  startDate: Date;
  endDate: Date | null;
  aiQueriesUsed: number;
  aiQueriesLimit: number;
  aiQueriesResetAt: Date | null;
  fastQueriesUsed: number | null;
  fastQueriesLimit: number | null;
  advancedQueriesUsed: number | null;
  advancedQueriesLimit: number | null;
  queryPackActive: boolean | null;
  queryPackFastQueriesUsed: number | null;
  queryPackFastQueriesLimit: number | null;
  queryPackAdvancedQueriesUsed: number | null;
  queryPackAdvancedQueriesLimit: number | null;
  queryPackStartDate: Date | null;
  queryPackEndDate: Date | null;
  creditsUsed: number | null;
  creditsLimit: number | null;
  creditsResetAt: Date | null;
  packCreditsUsed: number | null;
  packCreditsLimit: number | null;
  proEntitlementType: string | null;
  proEntitlementStartDate: Date | null;
  proEntitlementEndDate: Date | null;
  nextBillingDate: Date | null;
  scheduledPlanId: string | null;
  scheduledBillingPeriod: string | null;
  scheduledEffectiveAt: Date | null;
  cancelledAt: Date | null;
  addons: string[];
}

function makeRow(over: Partial<SubRow> & { userId: string }): SubRow {
  return {
    id: `sub-${over.userId}`,
    planId: "FREE",
    status: "ACTIVE",
    billingPeriod: null,
    startDate: new Date("2025-01-01T00:00:00.000Z"),
    endDate: null,
    aiQueriesUsed: 0,
    aiQueriesLimit: 0,
    aiQueriesResetAt: null,
    fastQueriesUsed: 0,
    fastQueriesLimit: 0,
    advancedQueriesUsed: 0,
    advancedQueriesLimit: 0,
    queryPackActive: false,
    queryPackFastQueriesUsed: 0,
    queryPackFastQueriesLimit: 0,
    queryPackAdvancedQueriesUsed: 0,
    queryPackAdvancedQueriesLimit: 0,
    queryPackStartDate: null,
    queryPackEndDate: null,
    creditsUsed: 0,
    creditsLimit: 5,
    creditsResetAt: null,
    packCreditsUsed: 0,
    packCreditsLimit: 0,
    proEntitlementType: null,
    proEntitlementStartDate: null,
    proEntitlementEndDate: null,
    nextBillingDate: null,
    scheduledPlanId: null,
    scheduledBillingPeriod: null,
    scheduledEffectiveAt: null,
    cancelledAt: null,
    addons: [],
    ...over,
  };
}

interface PrismaRecorder {
  store: Map<string, SubRow>;
  updateArgs: Array<{ userId: string; data: Record<string, unknown> }>;
}

/**
 * A recording prisma double for `prisma.subscription.*` keyed by userId. It
 * honours the same `{ where: { userId } }` contract the live service uses, so a
 * lookup for userA can NEVER return userB's row (the IDOR guard).
 */
function makePrismaStub(rec: PrismaRecorder) {
  return {
    subscription: {
      findUnique: async (args: { where: { userId: string } }) => {
        const r = rec.store.get(args.where.userId);
        return r ? { ...r } : null;
      },
      create: async (args: { data: SubRow & { userId: string } }) => {
        const row = makeRow({ ...args.data, userId: args.data.userId });
        rec.store.set(row.userId, row);
        return { ...row };
      },
      update: async (args: {
        where: { userId: string };
        data: Record<string, unknown>;
      }) => {
        rec.updateArgs.push({ userId: args.where.userId, data: args.data });
        const existing = rec.store.get(args.where.userId);
        if (!existing) throw new Error("no row to update");
        const merged = { ...existing, ...args.data } as SubRow;
        rec.store.set(args.where.userId, merged);
        return { ...merged };
      },
    },
  };
}

// ── module-boundary injection ───────────────────────────────────────

type ServiceModule =
  typeof import("../../../../packages/services/src/subscription.service");

const dbPath = require.resolve("@usemoney/database");
const logPath = require.resolve("@usemoney/logger");
const svcPath =
  require.resolve("../../../../packages/services/src/subscription.service");

function cacheMap(): Record<string, unknown> {
  return (require as unknown as { cache: Record<string, unknown> }).cache;
}

/**
 * Inject the recording prisma + a silent logger at the module boundary, then
 * (re)require the REAL subscription service so it binds to our stub.
 */
function loadServiceWith(rec: PrismaRecorder): ServiceModule {
  const cache = cacheMap();
  delete cache[svcPath];
  delete cache[dbPath];
  delete cache[logPath];
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: makePrismaStub(rec),
      PlanType: {},
      Prisma: {},
    },
  };
  cache[logPath] = {
    exports: {
      __esModule: true,
      dbLogger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../../../packages/services/src/subscription.service") as ServiceModule;
}

function newRecorder(): PrismaRecorder {
  return { store: new Map(), updateArgs: [] };
}

describe("subscription.service (LIVE) — getSubscription via recording prisma", () => {
  let rec: PrismaRecorder;
  let svc: ServiceModule;

  beforeEach(() => {
    rec = newRecorder();
    svc = loadServiceWith(rec);
  });

  afterEach(() => {
    const cache = cacheMap();
    delete cache[svcPath];
    delete cache[dbPath];
    delete cache[logPath];
  });

  it("creates a default FREE/ACTIVE subscription for a brand-new user", async () => {
    const res = await svc.getSubscription("brand-new");
    assert.equal(res.success, true);
    assert.ok(res.success && res.data);
    assert.equal(res.success && res.data.planId, "FREE");
    assert.equal(res.success && res.data.status, "ACTIVE");
    assert.equal(res.success && res.data.creditsLimit, 5);
  });

  it("returns an active PREMIUM unchanged (behavior preserved)", async () => {
    rec.store.set(
      "prem",
      makeRow({
        userId: "prem",
        planId: "PREMIUM",
        status: "ACTIVE",
        billingPeriod: "monthly",
        creditsLimit: 200,
      })
    );
    const res = await svc.getSubscription("prem");
    assert.ok(res.success);
    assert.equal(res.data.planId, "PREMIUM");
    assert.equal(res.data.status, "ACTIVE");
  });

  it("[J-F1][live] a PAST_DUE paid row is gated to FREE-level in the RESPONSE with NO DB write", async () => {
    rec.store.set(
      "dunning",
      makeRow({
        userId: "dunning",
        planId: "PREMIUM",
        status: "PAST_DUE",
        billingPeriod: "monthly",
        creditsLimit: 200,
      })
    );
    const res = await svc.getSubscription("dunning");
    assert.ok(res.success);
    // Response shows FREE-level access (entitlement gated while dunning)…
    assert.equal(res.data.planId, "FREE");
    assert.equal(res.data.status, "EXPIRED");
    assert.equal(res.data.creditsLimit, 5);
    // …but the ROW must NOT be destructively collapsed — dunning recovery
    // (subscription.active → PAST_DUE→ACTIVE, then subscription.renewed) needs it.
    assert.equal(
      rec.updateArgs.filter((u) => u.userId === "dunning").length,
      0,
      "PAST_DUE row must not be rewritten"
    );
    const stored = rec.store.get("dunning")!;
    assert.equal(stored.planId, "PREMIUM", "stored plan preserved");
    assert.equal(stored.status, "PAST_DUE", "stored status preserved");
  });

  it("[J-F1][live] after Dodo recovers the row to ACTIVE, FULL PREMIUM entitlement returns (no data loss)", async () => {
    rec.store.set(
      "recover",
      makeRow({
        userId: "recover",
        planId: "PREMIUM",
        status: "PAST_DUE",
        billingPeriod: "monthly",
        creditsLimit: 200,
      })
    );
    // 1) While PAST_DUE: FREE-level view, row untouched.
    const dunned = await svc.getSubscription("recover");
    assert.ok(dunned.success);
    assert.equal(dunned.data.planId, "FREE");
    // 2) Dodo retry succeeds → subscription.active flips the stored row ACTIVE.
    const row = rec.store.get("recover")!;
    rec.store.set("recover", { ...row, status: "ACTIVE" });
    // 3) getSubscription now returns the FULL PREMIUM entitlement — nothing lost.
    const recovered = await svc.getSubscription("recover");
    assert.ok(recovered.success);
    assert.equal(recovered.data.planId, "PREMIUM");
    assert.equal(recovered.data.status, "ACTIVE");
    assert.equal(recovered.data.creditsLimit, 200);
  });

  it("[BYPASS][live] PREMIUM whose grace endDate is PAST is healed to FREE/EXPIRED in the DB", async () => {
    rec.store.set(
      "expired-prem",
      makeRow({
        userId: "expired-prem",
        planId: "PREMIUM",
        status: "ACTIVE",
        billingPeriod: "monthly",
        endDate: new Date("2020-01-01T00:00:00.000Z"), // long past
      })
    );
    const res = await svc.getSubscription("expired-prem");
    assert.ok(res.success);
    assert.equal(
      res.data.planId,
      "FREE",
      "expired PREMIUM must NOT keep granting PREMIUM"
    );
    assert.equal(res.data.status, "EXPIRED");
    // The healing write actually happened.
    const wrote = rec.updateArgs.find(
      (u) => u.userId === "expired-prem" && u.data.planId === "FREE"
    );
    assert.ok(wrote, "service must persist the downgrade to FREE");
    assert.equal(wrote!.data.status, "EXPIRED");
  });

  it("[SECURITY][live] PREMIUM with an INVALID-DATE grace endDate is downgraded to FREE (not 'never expires')", async () => {
    rec.store.set(
      "garbage-end",
      makeRow({
        userId: "garbage-end",
        planId: "PREMIUM",
        status: "ACTIVE",
        billingPeriod: "monthly",
        endDate: new Date("not-a-real-date"), // Invalid Date
      })
    );
    const res = await svc.getSubscription("garbage-end");
    assert.ok(res.success);
    assert.equal(
      res.data.planId,
      "FREE",
      "Invalid-Date endDate must be treated as EXPIRED, not as 'never expires'"
    );
    assert.equal(res.data.status, "EXPIRED");
  });

  it("[live] PREMIUM grace expired + VALID lifetime PRO entitlement falls back to PRO", async () => {
    rec.store.set(
      "fallback-pro",
      makeRow({
        userId: "fallback-pro",
        planId: "PREMIUM",
        status: "ACTIVE",
        billingPeriod: "monthly",
        endDate: new Date("2020-01-01T00:00:00.000Z"),
        proEntitlementType: "lifetime",
        proEntitlementStartDate: new Date("2024-01-01T00:00:00.000Z"),
      })
    );
    const res = await svc.getSubscription("fallback-pro");
    assert.ok(res.success);
    assert.equal(
      res.data.planId,
      "PRO",
      "should preserve PRO entitlement on grace expiry"
    );
    assert.equal(res.data.status, "ACTIVE");
  });

  it("[IDOR][live] getSubscription(userA) never returns userB's row", async () => {
    rec.store.set(
      "bob",
      makeRow({
        userId: "bob",
        planId: "PREMIUM",
        status: "ACTIVE",
        billingPeriod: "monthly",
      })
    );
    // Alice has no row → service creates a fresh FREE one for ALICE, never bob's.
    const alice = await svc.getSubscription("alice");
    assert.ok(alice.success);
    assert.equal(alice.data.planId, "FREE");
    assert.notEqual(alice.data.id, rec.store.get("bob")!.id);
    // Bob's row is untouched and still PREMIUM.
    const bob = await svc.getSubscription("bob");
    assert.ok(bob.success);
    assert.equal(bob.data.planId, "PREMIUM");
    // Every write the service issued was scoped to the caller's own userId.
    for (const u of rec.updateArgs) {
      assert.ok(u.userId === "alice" || u.userId === "bob");
    }
  });

  it("[SELF-HEAL][live] stale EXPIRED-status PREMIUM row (no endDate) is healed to FREE", async () => {
    // This row never enters the grace block (status !== ACTIVE), so it relies on
    // the defensive self-heal. Without it, the service would leak planId=PREMIUM.
    rec.store.set(
      "stale-expired",
      makeRow({
        userId: "stale-expired",
        planId: "PREMIUM",
        status: "EXPIRED",
        endDate: null,
      })
    );
    const res = await svc.getSubscription("stale-expired");
    assert.ok(res.success);
    assert.equal(
      res.data.planId,
      "FREE",
      "stale EXPIRED PREMIUM must collapse to FREE"
    );
    assert.equal(res.data.status, "EXPIRED");
    assert.ok(
      rec.updateArgs.some(
        (u) => u.userId === "stale-expired" && u.data.planId === "FREE"
      ),
      "self-heal write must persist FREE"
    );
  });

  it("[SELF-HEAL][live] stale CANCELLED-status PREMIUM row is healed to FREE", async () => {
    rec.store.set(
      "stale-cancelled",
      makeRow({
        userId: "stale-cancelled",
        planId: "PREMIUM",
        status: "CANCELLED",
        endDate: null,
      })
    );
    const res = await svc.getSubscription("stale-cancelled");
    assert.ok(res.success);
    assert.equal(res.data.planId, "FREE");
  });

  it("[SELF-HEAL][live][idempotent] a second getSubscription after heal makes NO further FREE-downgrade write", async () => {
    rec.store.set(
      "idem",
      makeRow({
        userId: "idem",
        planId: "PREMIUM",
        status: "EXPIRED",
        endDate: null,
      })
    );
    await svc.getSubscription("idem"); // first call heals
    const writesAfterFirst = rec.updateArgs.filter(
      (u) => u.userId === "idem" && u.data.planId === "FREE"
    ).length;
    rec.updateArgs.length = 0; // reset the recorder window
    const res2 = await svc.getSubscription("idem"); // second call must be a no-op heal
    assert.ok(res2.success);
    assert.equal(res2.data.planId, "FREE");
    const downgradeWrites = rec.updateArgs.filter(
      (u) => u.userId === "idem" && u.data.planId === "FREE"
    ).length;
    assert.ok(writesAfterFirst >= 1, "first call should have healed");
    assert.equal(
      downgradeWrites,
      0,
      "second call must NOT re-issue a FREE downgrade"
    );
  });

  it("[live] returns a sanitized failure (not a throw) when prisma explodes", async () => {
    const boom = newRecorder();
    const exploding = loadServiceWith(boom);
    // Replace findUnique with a thrower after load by poisoning the store getter.
    const cache = cacheMap();
    cache[dbPath] = {
      exports: {
        __esModule: true,
        prisma: {
          subscription: {
            findUnique: async () => {
              throw new Error("db exploded");
            },
            create: async () => {
              throw new Error("db exploded");
            },
            update: async () => {
              throw new Error("db exploded");
            },
          },
        },
        PlanType: {},
        Prisma: {},
      },
    };
    delete cache[svcPath];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const svc2 =
      require("../../../../packages/services/src/subscription.service") as ServiceModule;
    const res = await svc2.getSubscription("whoever");
    assert.equal(res.success, false);
    assert.ok(!res.success && typeof res.error === "string");
    void exploding;
  });
});

describe("subscription.service (LIVE) — downgradeWithGracePeriod / isProEntitlementExpired export", () => {
  let rec: PrismaRecorder;
  let svc: ServiceModule;

  beforeEach(() => {
    rec = newRecorder();
    svc = loadServiceWith(rec);
  });

  afterEach(() => {
    const cache = cacheMap();
    delete cache[svcPath];
    delete cache[dbPath];
    delete cache[logPath];
  });

  it("rejects downgrade when there is no active subscription", async () => {
    const res = await svc.downgradeWithGracePeriod("nobody");
    assert.equal(res.success, false);
  });

  it("[H8][live] cancelSubscription with no row returns a NOT_FOUND-coded failure (route → 404, not 500)", async () => {
    const res = await svc.cancelSubscription("nobody");
    assert.equal(res.success, false);
    assert.equal(res.success ? undefined : res.code, "NOT_FOUND");
  });

  it("PREMIUM monthly downgrade schedules a grace endDate ~1 month out (shared math)", async () => {
    rec.store.set(
      "prem-dg",
      makeRow({
        userId: "prem-dg",
        planId: "PREMIUM",
        status: "ACTIVE",
        billingPeriod: "monthly",
        startDate: new Date("2026-06-15T00:00:00.000Z"),
      })
    );
    const res = await svc.downgradeWithGracePeriod("prem-dg");
    assert.ok(res.success);
    const wrote = rec.updateArgs.find((u) => u.userId === "prem-dg");
    assert.ok(wrote, "an endDate must be written");
    const end = wrote!.data.endDate as Date;
    assert.ok(end instanceof Date);
    // +1 month from June 15 → July 15.
    assert.equal(end.getUTCMonth(), 6);
  });

  it("the exported isProEntitlementExpired is the REAL (Invalid-Date-safe) symbol", () => {
    assert.equal(typeof svc.isProEntitlementExpired, "function");
    // garbage end-date → expired (proves it delegates to the hardened logic).
    assert.equal(
      svc.isProEntitlementExpired({
        proEntitlementType: "annual",
        proEntitlementEndDate: new Date("garbage"),
      }),
      true
    );
    assert.equal(
      svc.isProEntitlementExpired({ proEntitlementType: null }),
      true
    );
  });
});
