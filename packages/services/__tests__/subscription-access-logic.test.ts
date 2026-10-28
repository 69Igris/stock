/**
 * MONEY-1062 — buildSubscriptionAccess (pure).
 *
 * The subscription-access view was extracted verbatim from
 * apps/web/lib/subscription/access.ts into the subscription-logic seam so the
 * web wrapper (Clerk auth → userId) and the service (row read) share one pure
 * builder. These cases pin the relocated behaviour 1:1 — the fail-to-FREE
 * branches, the query-pack carry-forward (added to LIMITS, floored/-1 aware),
 * the effective credit-limit max(), and the real per-plan feature flags.
 *
 * Source: packages/services/src/subscription-logic.ts (buildSubscriptionAccess)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSubscriptionAccess,
  DEFAULT_FREE_ACCESS,
} from "../src/subscription-logic.ts";

describe("buildSubscriptionAccess — fail-to-FREE branches", () => {
  it("null subscription → DEFAULT_FREE_ACCESS", () => {
    assert.deepEqual(buildSubscriptionAccess(null), DEFAULT_FREE_ACCESS);
  });

  it("non-ACTIVE status → DEFAULT_FREE_ACCESS", () => {
    assert.deepEqual(
      buildSubscriptionAccess({ status: "EXPIRED", planId: "PREMIUM" }),
      DEFAULT_FREE_ACCESS,
    );
    assert.deepEqual(
      buildSubscriptionAccess({ status: "CANCELLED", planId: "PRO" }),
      DEFAULT_FREE_ACCESS,
    );
  });

  it("unknown plan id → DEFAULT_FREE_ACCESS (no legacy resolve on lookup)", () => {
    assert.deepEqual(
      buildSubscriptionAccess({ status: "ACTIVE", planId: "GOLD" }),
      DEFAULT_FREE_ACCESS,
    );
  });

  it("DEFAULT_FREE_ACCESS grants FREE aiQueries (MONEY-295) but no paid features", () => {
    assert.equal(DEFAULT_FREE_ACCESS.canAccessAIQueries, true);
    assert.equal(DEFAULT_FREE_ACCESS.canAccessBrokerSync, false);
    assert.equal(DEFAULT_FREE_ACCESS.creditsLimit, 5);
    assert.equal(DEFAULT_FREE_ACCESS.totalCreditsRemaining, 5);
  });
});

describe("buildSubscriptionAccess — ACTIVE PRO (no pack)", () => {
  const access = buildSubscriptionAccess({
    status: "ACTIVE",
    planId: "PRO",
    fastQueriesUsed: 5,
    advancedQueriesUsed: 1,
    queryPackActive: false,
    creditsUsed: 10,
    creditsLimit: 50,
    packCreditsLimit: 0,
    packCreditsUsed: 0,
  });

  it("reflects the PRO plan config", () => {
    assert.equal(access.planId, "PRO");
    assert.equal(access.planName, "Pro");
    assert.equal(access.isActive, true);
    assert.equal(access.fastQueriesLimit, 20);
    assert.equal(access.fastQueriesUsed, 5);
    assert.equal(access.advancedQueriesLimit, 5);
    assert.equal(access.advancedQueriesUsed, 1);
  });

  it("credits: effective limit = max(plan, db); remaining floored at 0", () => {
    assert.equal(access.creditsLimit, 50);
    assert.equal(access.creditsUsed, 10);
    assert.equal(access.totalCreditsRemaining, 40);
  });

  it("PRO feature flags", () => {
    assert.equal(access.canAccessBrokerSync, true);
    assert.equal(access.canAccessAIQueries, true);
    assert.equal(access.canAccessStockDiscovery, true);
    assert.equal(access.canAccessUnlimitedConnections, true);
    assert.equal(access.canAccessAIStrategies, false);
    assert.equal(access.canAccessAILearning, false);
  });
});

describe("buildSubscriptionAccess — ACTIVE PREMIUM with active query pack", () => {
  const access = buildSubscriptionAccess({
    status: "ACTIVE",
    planId: "PREMIUM",
    fastQueriesUsed: 0,
    advancedQueriesUsed: 50,
    queryPackActive: true,
    queryPackFastQueriesLimit: 100,
    queryPackFastQueriesUsed: 10,
    queryPackAdvancedQueriesLimit: 200,
    queryPackAdvancedQueriesUsed: 20,
    creditsUsed: 100,
    creditsLimit: 200,
    packCreditsLimit: 500,
    packCreditsUsed: 50,
  });

  it("unlimited (-1) fast limit stays -1; pack fast usage still tallies", () => {
    assert.equal(access.fastQueriesLimit, -1);
    assert.equal(access.fastQueriesUsed, 10); // 0 + packFastUsed(10)
  });

  it("finite advanced limit gets pack limit added; usage tallied", () => {
    assert.equal(access.advancedQueriesLimit, 400); // 200 + 200
    assert.equal(access.advancedQueriesUsed, 70); // 50 + 20
  });

  it("pack credits roll into totalCreditsRemaining", () => {
    assert.equal(access.creditsLimit, 200);
    assert.equal(access.packCreditsLimit, 500);
    // planRemaining(200-100=100) + packRemaining(500-50=450) = 550
    assert.equal(access.totalCreditsRemaining, 550);
  });

  it("PREMIUM feature flags", () => {
    assert.equal(access.canAccessAIStrategies, true);
    assert.equal(access.canAccessAILearning, true);
  });
});

describe("buildSubscriptionAccess — query-pack guard", () => {
  it("FREE plan never absorbs a query pack even if queryPackActive", () => {
    const access = buildSubscriptionAccess({
      status: "ACTIVE",
      planId: "FREE",
      queryPackActive: true,
      queryPackFastQueriesLimit: 100,
      queryPackAdvancedQueriesLimit: 100,
      creditsUsed: 0,
      creditsLimit: 5,
    });
    assert.equal(access.planId, "FREE");
    assert.equal(access.fastQueriesLimit, 0); // FREE plan.fastQueries, no pack add
    assert.equal(access.advancedQueriesLimit, 0);
  });

  it("stale db creditsLimit (5) is overridden by the plan's higher allocation", () => {
    const access = buildSubscriptionAccess({
      status: "ACTIVE",
      planId: "PREMIUM",
      creditsUsed: 0,
      creditsLimit: 5, // stale — plan says 200
    });
    assert.equal(access.creditsLimit, 200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MONEY-1199 — the credits numerator and denominator must span the same thing
// ════════════════════════════════════════════════════════════════════════════

describe("buildSubscriptionAccess — credits span plan AND packs (MONEY-1199)", () => {
  /** An ACTIVE PRO subscription with a purchased query pack on top. */
  const withPack = (over: Record<string, unknown> = {}) =>
    buildSubscriptionAccess({
      status: "ACTIVE",
      planId: "PRO",
      creditsUsed: 0,
      packCreditsLimit: 2550,
      packCreditsUsed: 0,
      ...over,
    });

  it("totalCreditsRemaining INCLUDES pack credits, creditsLimit does not", () => {
    // This asymmetry is correct and deliberate — the two fields answer
    // different questions — but it is the trap the StockSage chat fell into:
    // rendering `totalCreditsRemaining / creditsLimit` showed "2750 / 200",
    // a remaining count larger than the limit, which cannot exist.
    const a = withPack();
    assert.ok(
      a.totalCreditsRemaining > a.creditsLimit,
      "with a pack purchased, total remaining EXCEEDS the plan limit — any UI " +
        "pairing these two directly will render an impossible fraction",
    );
    assert.equal(a.totalCreditsRemaining, a.creditsLimit + a.packCreditsLimit);
  });

  it("remaining never exceeds the COMBINED allowance, at any usage level", () => {
    // The invariant a display can rely on: numerator <= plan + pack.
    for (const [used, packUsed] of [
      [0, 0],
      [5, 0],
      [0, 100],
      [50, 1000],
      [99999, 99999], // over-consumption must clamp, not go negative
    ]) {
      const a = withPack({ creditsUsed: used, packCreditsUsed: packUsed });
      const combined = a.creditsLimit + a.packCreditsLimit;
      assert.ok(
        a.totalCreditsRemaining <= combined,
        `used=${used} packUsed=${packUsed}: remaining ` +
          `${a.totalCreditsRemaining} exceeds combined allowance ${combined}`,
      );
      assert.ok(
        a.totalCreditsRemaining >= 0,
        `used=${used} packUsed=${packUsed}: remaining went negative`,
      );
    }
  });

  it("with no pack, remaining and the plan limit agree — which is why this hid", () => {
    // Every user without a query pack saw a correct fraction, so the bug was
    // invisible until someone bought one.
    const a = buildSubscriptionAccess({
      status: "ACTIVE",
      planId: "PRO",
      creditsUsed: 0,
    });
    assert.equal(a.packCreditsLimit, 0);
    assert.equal(a.totalCreditsRemaining, a.creditsLimit);
  });
});
