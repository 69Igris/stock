/**
 * subscription-management.service — REAL exports, injected prisma + fake Dodo
 * (MONEY-1062 P4e).
 *
 * Pins the USER-INITIATED scheduled-plan-change flows extracted verbatim from
 * apps/web/lib/actions/subscription.ts, with the money-path invariants:
 *   - the Dodo auto-renew write STAYS in the service, swallowed-and-logged on
 *     failure (the local schedule still stamps),
 *   - NO Dodo call on a gate failure (no-sub / already-FREE / coupon-grant),
 *   - the coupon/trial FREE-grant is NOT user-unschedulable,
 *   - the previewSubscriptionChange classifier branches mirror the web action,
 *   - the pure computeAiCreditsPreflight decision.
 *
 * `@usemoney/services` runs its suite as ESM → inject a fake prisma + fake dodo
 * via `deps` rather than module-mocking.
 *
 * Source: packages/services/src/subscription-management.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scheduleSubscriptionCancel,
  scheduleSubscriptionDowngrade,
  unscheduleSubscriptionChange,
  previewSubscriptionChange,
  computeAiCreditsPreflight,
  type DodoSubscriptionUpdater,
} from "../src/subscription-management.service";

// ── fakes ────────────────────────────────────────────────────────────────────

type Sub = Record<string, unknown> | null;

function makePrisma(sub: Sub) {
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    subscription: {
      findUnique: async () => sub,
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { ...(sub ?? {}), ...args.data };
      },
    },
  };
  return { prisma: prisma as never, updates };
}

function makeDodo(opts: { throwOnUpdate?: boolean } = {}) {
  const calls: Array<{
    id: string;
    body: { cancel_at_next_billing_date: boolean };
  }> = [];
  const dodo: DodoSubscriptionUpdater = {
    subscriptions: {
      update: async (id, body) => {
        calls.push({ id, body });
        if (opts.throwOnUpdate) throw new Error("dodo down");
        return {};
      },
    },
  };
  return { dodo, calls };
}

const DAY = 24 * 60 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════
// scheduleSubscriptionCancel
// ════════════════════════════════════════════════════════════════════════════

describe("scheduleSubscriptionCancel", () => {
  it("stamps FREE at term-end AND tells Dodo to stop auto-renew", async () => {
    const endDate = new Date(Date.now() + 20 * DAY);
    const { prisma, updates } = makePrisma({
      planId: "PRO",
      dodoSubscriptionId: "sub_1",
      endDate,
      nextBillingDate: null,
      startDate: new Date(),
      billingPeriod: "monthly",
    });
    const { dodo, calls } = makeDodo();

    const res = await scheduleSubscriptionCancel("u1", { prisma, dodo });
    assert.equal(res.success, true);
    assert.ok(
      res.success && res.data.scheduledEffectiveAt === endDate.toISOString(),
    );
    // Dodo told to stop renewing.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { cancel_at_next_billing_date: true });
    // Local schedule stamped.
    assert.equal(updates.length, 1);
    assert.equal(updates[0].scheduledPlanId, "FREE");
    assert.equal(updates[0].scheduledBillingPeriod, null);
  });

  it("derives the term end from startDate + period when endDate/nextBillingDate absent", async () => {
    const startDate = new Date("2026-01-01T00:00:00.000Z");
    const { prisma } = makePrisma({
      planId: "PRO",
      dodoSubscriptionId: null,
      endDate: null,
      nextBillingDate: null,
      startDate,
      billingPeriod: "annual",
    });
    const res = await scheduleSubscriptionCancel("u1", { prisma });
    assert.ok(res.success);
    // annual → +365d.
    const expected = new Date(startDate.getTime() + 365 * DAY).toISOString();
    assert.equal(res.success && res.data.scheduledEffectiveAt, expected);
  });

  it("returns NOT_FOUND with NO Dodo call / NO write when there is no subscription", async () => {
    const { prisma, updates } = makePrisma(null);
    const { dodo, calls } = makeDodo();
    const res = await scheduleSubscriptionCancel("u1", { prisma, dodo });
    assert.equal(res.success, false);
    assert.equal(!res.success && res.code, "NOT_FOUND");
    assert.equal(calls.length, 0);
    assert.equal(updates.length, 0);
  });

  it("returns ALREADY_FREE with NO Dodo call / NO write for a FREE plan", async () => {
    const { prisma, updates } = makePrisma({
      planId: "FREE",
      dodoSubscriptionId: "sub_1",
      startDate: new Date(),
    });
    const { dodo, calls } = makeDodo();
    const res = await scheduleSubscriptionCancel("u1", { prisma, dodo });
    assert.equal(!res.success && res.code, "ALREADY_FREE");
    assert.equal(calls.length, 0);
    assert.equal(updates.length, 0);
  });

  it("returns NO_TERM_END when no term end is derivable", async () => {
    const { prisma, updates } = makePrisma({
      planId: "PRO",
      dodoSubscriptionId: null,
      endDate: null,
      nextBillingDate: null,
      startDate: null,
      billingPeriod: "monthly",
    });
    const res = await scheduleSubscriptionCancel("u1", { prisma });
    assert.equal(!res.success && res.code, "NO_TERM_END");
    assert.equal(updates.length, 0);
  });

  it("still stamps the local schedule when the Dodo call throws (swallow+log)", async () => {
    const endDate = new Date(Date.now() + 10 * DAY);
    const { prisma, updates } = makePrisma({
      planId: "PREMIUM",
      dodoSubscriptionId: "sub_9",
      endDate,
      startDate: new Date(),
      billingPeriod: "monthly",
    });
    const { dodo, calls } = makeDodo({ throwOnUpdate: true });
    const res = await scheduleSubscriptionCancel("u1", { prisma, dodo });
    assert.equal(res.success, true); // Dodo failure does NOT abort
    assert.equal(calls.length, 1);
    assert.equal(updates.length, 1); // schedule still stamped
  });
});

// ════════════════════════════════════════════════════════════════════════════
// scheduleSubscriptionDowngrade
// ════════════════════════════════════════════════════════════════════════════

describe("scheduleSubscriptionDowngrade", () => {
  it("stamps the target plan/cycle with NO Dodo call", async () => {
    const endDate = new Date(Date.now() + 15 * DAY);
    const { prisma, updates } = makePrisma({
      planId: "PREMIUM",
      endDate,
      nextBillingDate: null,
    });
    const { dodo, calls } = makeDodo();
    const res = await scheduleSubscriptionDowngrade("u1", "PRO", "monthly", {
      prisma,
      dodo,
    });
    assert.ok(res.success);
    assert.equal(
      res.success && res.data.scheduledEffectiveAt,
      endDate.toISOString(),
    );
    assert.equal(updates[0].scheduledPlanId, "PRO");
    assert.equal(updates[0].scheduledBillingPeriod, "monthly");
    assert.equal(calls.length, 0); // downgrade schedule NEVER calls Dodo
  });

  it("returns NOT_FOUND when there is no subscription", async () => {
    const { prisma, updates } = makePrisma(null);
    const res = await scheduleSubscriptionDowngrade("u1", "PRO", "annual", {
      prisma,
    });
    assert.equal(!res.success && res.code, "NOT_FOUND");
    assert.equal(updates.length, 0);
  });

  it("returns NO_TERM_END with no derivable term end", async () => {
    const { prisma } = makePrisma({
      planId: "PREMIUM",
      endDate: null,
      nextBillingDate: null,
    });
    const res = await scheduleSubscriptionDowngrade("u1", "PRO", "monthly", {
      prisma,
    });
    assert.equal(!res.success && res.code, "NO_TERM_END");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// unscheduleSubscriptionChange
// ════════════════════════════════════════════════════════════════════════════

describe("unscheduleSubscriptionChange", () => {
  it("re-enables Dodo auto-renew and clears the schedule for a paid cancel", async () => {
    const { prisma, updates } = makePrisma({
      scheduledPlanId: "FREE",
      dodoSubscriptionId: "sub_1",
    });
    const { dodo, calls } = makeDodo();
    const res = await unscheduleSubscriptionChange("u1", { prisma, dodo });
    assert.ok(res.success);
    assert.equal(res.success && res.data.unscheduled, true);
    assert.deepEqual(calls[0].body, { cancel_at_next_billing_date: false });
    assert.equal(updates[0].scheduledPlanId, null);
  });

  it("is an idempotent no-op when nothing is scheduled (NO Dodo, NO write)", async () => {
    const { prisma, updates } = makePrisma({ scheduledPlanId: null });
    const { dodo, calls } = makeDodo();
    const res = await unscheduleSubscriptionChange("u1", { prisma, dodo });
    assert.ok(res.success);
    assert.equal(res.success && res.data.unscheduled, false);
    assert.equal(calls.length, 0);
    assert.equal(updates.length, 0);
  });

  it("REFUSES a coupon/trial FREE-grant (no Dodo sub) → COUPON_GRANT, NO write", async () => {
    const { prisma, updates } = makePrisma({
      scheduledPlanId: "FREE",
      dodoSubscriptionId: null,
    });
    const { dodo, calls } = makeDodo();
    const res = await unscheduleSubscriptionChange("u1", { prisma, dodo });
    assert.equal(!res.success && res.code, "COUPON_GRANT");
    assert.equal(calls.length, 0);
    assert.equal(updates.length, 0);
  });

  it("clears a scheduled DOWNGRADE without any Dodo call", async () => {
    const { prisma, updates } = makePrisma({
      scheduledPlanId: "PRO",
      dodoSubscriptionId: "sub_1",
    });
    const { dodo, calls } = makeDodo();
    const res = await unscheduleSubscriptionChange("u1", { prisma, dodo });
    assert.ok(res.success);
    assert.equal(calls.length, 0); // only a FREE+dodoSub cancel re-enables renew
    assert.equal(updates[0].scheduledPlanId, null);
  });

  it("returns NOT_FOUND when there is no subscription", async () => {
    const { prisma } = makePrisma(null);
    const res = await unscheduleSubscriptionChange("u1", { prisma });
    assert.equal(!res.success && res.code, "NOT_FOUND");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// previewSubscriptionChange (read-only classifier)
// ════════════════════════════════════════════════════════════════════════════

describe("previewSubscriptionChange", () => {
  const future = () => new Date(Date.now() + 20 * DAY);

  it("noop for the same plan + cycle", async () => {
    const { prisma } = makePrisma({
      planId: "PRO",
      billingPeriod: "monthly",
      endDate: future(),
    });
    const res = await previewSubscriptionChange("u1", "PRO", "monthly", {
      prisma,
    });
    assert.ok(res.success && res.data.kind === "noop");
  });

  it("cancel (→ FREE) is scheduled, no charge today", async () => {
    const end = future();
    const { prisma } = makePrisma({
      planId: "PRO",
      billingPeriod: "monthly",
      endDate: end,
    });
    const res = await previewSubscriptionChange("u1", "FREE", null, { prisma });
    assert.ok(res.success);
    assert.equal(res.success && res.data.kind, "cancel");
    assert.equal(res.success && res.data.willChargeToday, false);
    assert.equal(res.success && res.data.effectiveAt, end.toISOString());
  });

  it("first_purchase (no sub) → monthly 30-day term, charges today", async () => {
    const { prisma } = makePrisma(null);
    const res = await previewSubscriptionChange("u1", "PRO", "monthly", {
      prisma,
    });
    assert.ok(res.success);
    assert.equal(res.success && res.data.kind, "first_purchase");
    assert.equal(res.success && res.data.newTermDays, 30);
    assert.equal(res.success && res.data.willChargeToday, true);
  });

  it("tier_upgrade charges today with numeric bonus days", async () => {
    const { prisma } = makePrisma({
      planId: "PRO",
      billingPeriod: "monthly",
      endDate: future(),
    });
    const res = await previewSubscriptionChange("u1", "PREMIUM", "monthly", {
      prisma,
    });
    assert.ok(res.success);
    assert.equal(res.success && res.data.kind, "tier_upgrade");
    assert.equal(res.success && res.data.willChargeToday, true);
    assert.equal(res.success && typeof res.data.bonusDays, "number");
  });

  it("cycle_append (monthly → annual, same tier) charges today", async () => {
    const { prisma } = makePrisma({
      planId: "PRO",
      billingPeriod: "monthly",
      endDate: future(),
    });
    const res = await previewSubscriptionChange("u1", "PRO", "annual", {
      prisma,
    });
    assert.ok(res.success);
    assert.equal(res.success && res.data.kind, "cycle_append");
    assert.equal(res.success && res.data.willChargeToday, true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// computeAiCreditsPreflight (pure)
// ════════════════════════════════════════════════════════════════════════════

describe("computeAiCreditsPreflight", () => {
  it("blocks FREE users", () => {
    assert.deepEqual(computeAiCreditsPreflight({ planId: "FREE" }), {
      allowed: false,
      reason: "free",
      planId: "FREE",
    });
  });

  it("allows unlimited credits (-1)", () => {
    const r = computeAiCreditsPreflight({
      planId: "PREMIUM",
      creditsLimit: -1,
      creditsUsed: 999,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "ok");
  });

  it("allows when plan credits remain", () => {
    const r = computeAiCreditsPreflight({
      planId: "PRO",
      creditsLimit: 50,
      creditsUsed: 10,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "ok");
  });

  it("allows on pack credits when the plan pool is exhausted", () => {
    const r = computeAiCreditsPreflight({
      planId: "PRO",
      creditsLimit: 50,
      creditsUsed: 50,
      packCreditsLimit: 100,
      packCreditsUsed: 40,
    });
    assert.equal(r.allowed, true);
  });

  it("blocks with no_credits when both pools are exhausted", () => {
    const r = computeAiCreditsPreflight({
      planId: "PRO",
      creditsLimit: 50,
      creditsUsed: 50,
      packCreditsLimit: 0,
      packCreditsUsed: 0,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "no_credits");
  });
});
