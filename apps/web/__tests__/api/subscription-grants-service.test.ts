/**
 * Subscription-grants GRANT-SHAPE contract tests — MONEY-1062 (W1-B).
 *
 * Per the founder directive, grant-shape parity lives on the SUBSCRIPTION side.
 * These drive the REAL `@usemoney/services` subscription-domain functions
 * (`grantWebhookSubscription`, `grantCallbackSubscription`, and the Dodo lifecycle
 * mutators) against a recording prisma double, with the claim-once claim passed
 * in as a callback (its mechanics are tested on the payments side). Asserts:
 *   - the exact upsert/update payloads. MONEY-1063 removed the aiQueriesLimit
 *     divergence these once pinned (webhook read WEBHOOK_PLANS' PRO→10 while the
 *     callback read PLAN_CONFIG's PRO→20 for the SAME payment); both now write
 *     20 and the assertions moved with the fix. The `billingPeriod` divergence
 *     is still live and still preserved — see the note at the webhook write;
 *   - the credit-pack unified-ledger grant, addon eligibility gates, anchor
 *     backfill on a lost claim, claim-release on a grant write failure;
 *   - the cancel / renew / activate / past-due / expire lifecycle writes.
 *
 * Lives in apps/web (CJS) because packages/services runs its suite as ESM where
 * the `require.cache` prisma-injection seam is unavailable — the same split the
 * repo already uses (subscription-billing-anchor-heal.test.ts).
 *
 * Source: packages/services/src/subscription-grants.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double (subscription table only) ───────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

interface SubRow {
  id: string;
  userId: string;
  planId: string;
  status: string;
  endDate: Date | null;
  nextBillingDate: Date | null;
  startDate: Date | null;
  billingPeriod: string | null;
  dodoSubscriptionId: string | null;
  queryPackFastQueriesLimit: number;
  queryPackFastQueriesUsed: number;
  queryPackAdvancedQueriesLimit: number;
  queryPackAdvancedQueriesUsed: number;
  packCreditsLimit: number;
  packCreditsUsed: number;
  proEntitlementType: string | null;
  proEntitlementStartDate: Date | null;
  proEntitlementEndDate: Date | null;
}

interface StubOpts {
  failUpsert?: boolean;
}

function makePrisma(subscription: SubRow | null, opts: StubOpts = {}) {
  const calls: RecordedCall[] = [];
  const push = (model: string, method: string, args: unknown) =>
    calls.push({ model, method, args });
  return {
    calls,
    subscription: {
      findUnique: (args: unknown) => {
        push("subscription", "findUnique", args);
        return Promise.resolve(subscription);
      },
      findFirst: (args: unknown) => {
        push("subscription", "findFirst", args);
        return Promise.resolve(subscription);
      },
      update: (args: unknown) => {
        push("subscription", "update", args);
        return Promise.resolve(subscription);
      },
      updateMany: (args: unknown) => {
        push("subscription", "updateMany", args);
        return Promise.resolve({ count: 1 });
      },
      upsert: (args: unknown) => {
        push("subscription", "upsert", args);
        if (opts.failUpsert) {
          return Promise.reject(new Error("simulated grant failure"));
        }
        return Promise.resolve(subscription);
      },
    },
  };
}

// ── require.cache injection (CJS) ───────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SVC_REL = "../../../../packages/services/src/subscription-grants.service";
type ServiceModule =
  typeof import("../../../../packages/services/src/subscription-grants.service");

function loadService(stub: ReturnType<typeof makePrisma>): ServiceModule {
  const cache = moduleCache();
  const dbPath = require.resolve("@usemoney/database");
  const logPath = require.resolve("@usemoney/logger");
  const corePayPath = require.resolve("@usemoney/core/payments");
  const svcPath = require.resolve(SVC_REL);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realCorePay = require("@usemoney/core/payments") as Record<
    string,
    unknown
  >;

  cache[dbPath] = {
    exports: { __esModule: true, prisma: stub, PlanType: {}, Prisma: {} },
  };
  cache[logPath] = {
    exports: {
      __esModule: true,
      dbLogger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
  cache[corePayPath] = {
    exports: {
      ...realCorePay,
      dodoClient: { subscriptions: { update: () => Promise.resolve({}) } },
    },
  };
  delete cache[svcPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(SVC_REL) as ServiceModule;
}

function freshSub(over: Partial<SubRow> = {}): SubRow {
  return {
    id: "sub_1",
    userId: "user_1",
    planId: "FREE",
    status: "ACTIVE",
    endDate: null,
    nextBillingDate: null,
    startDate: null,
    billingPeriod: null,
    dodoSubscriptionId: null,
    queryPackFastQueriesLimit: 0,
    queryPackFastQueriesUsed: 0,
    queryPackAdvancedQueriesLimit: 0,
    queryPackAdvancedQueriesUsed: 0,
    packCreditsLimit: 0,
    packCreditsUsed: 0,
    proEntitlementType: null,
    proEntitlementStartDate: null,
    proEntitlementEndDate: null,
    ...over,
  };
}

const alwaysWin = async () => true;
const alwaysLose = async () => false;
const noRelease = async () => {};

const upserts = (stub: ReturnType<typeof makePrisma>) =>
  stub.calls.filter((c) => c.model === "subscription" && c.method === "upsert");
const subUpdates = (stub: ReturnType<typeof makePrisma>) =>
  stub.calls.filter((c) => c.model === "subscription" && c.method === "update");

function webhookCtx(over: Record<string, unknown> = {}) {
  return {
    userId: "user_1",
    planId: "PRO",
    period: "one-time",
    dodoSubscriptionId: null,
    nextBillingDate: null,
    creditPackSize: 0,
    ...over,
  } as never;
}

function callbackCtx(over: Record<string, unknown> = {}) {
  return {
    userId: "user_1",
    planId: "PRO",
    period: "one-time",
    dodoSubscriptionId: null,
    creditPackSize: 0,
    ...over,
  } as never;
}

// ── webhook grant shape ─────────────────────────────────────────────────────

describe("grantWebhookSubscription — main-plan grant shape", () => {
  it("PRO → aiQueriesLimit 20 (PLAN_CONFIG), matching the callback grant", async () => {
    const stub = makePrisma(freshSub());
    const svc = loadService(stub);
    const result = await svc.grantWebhookSubscription(
      webhookCtx(),
      alwaysWin,
      noRelease
    );
    assert.equal(result, "plan_granted");
    const up = upserts(stub);
    assert.equal(up.length, 1);
    const update = (up[0].args as { update: Record<string, unknown> }).update;
    assert.equal(update.planId, "PRO");
    assert.equal(update.status, "ACTIVE");
    // MONEY-1063 — this asserted 10 and was RIGHT to, at the time: it pinned a
    // real preserved divergence so it stayed visible instead of implied. The
    // divergence is now fixed, so the assertion moves with it rather than being
    // deleted.
    //
    // Both grant paths for the SAME payment now write PLAN_CONFIG's 20. While
    // they disagreed, whichever won the appliedAt claim decided how many AI
    // queries a paying PRO user received — an entitlement settled by a race,
    // with both writes succeeding and 10 being a plausible-looking number.
    assert.equal(update.aiQueriesLimit, 20);
    assert.equal(update.fastQueriesLimit, 20);
    assert.equal(update.advancedQueriesLimit, 5);
    assert.equal(update.creditsLimit, 50);
    assert.equal(update.scheduledPlanId, null);
    assert.equal(update.cancelledAt, null);
  });

  it("a lost claim backfills billing anchors (unset-or-null) and never grants", async () => {
    const stub = makePrisma(freshSub({ planId: "PREMIUM" }));
    const svc = loadService(stub);
    const result = await svc.grantWebhookSubscription(
      webhookCtx({
        planId: "PREMIUM",
        period: "monthly",
        dodoSubscriptionId: "dodo_sub_relink",
        nextBillingDate: "2026-07-11T00:00:00Z",
      }),
      alwaysLose,
      noRelease
    );
    assert.equal(result, "already_applied");
    assert.equal(upserts(stub).length, 0);
    const link = stub.calls.find(
      (c) => c.model === "subscription" && c.method === "updateMany"
    );
    assert.ok(link, "expected the anchor-backfill updateMany");
    const args = link!.args as { where: { OR: unknown } };
    assert.deepEqual(args.where.OR, [
      { dodoSubscriptionId: null },
      { dodoSubscriptionId: { isSet: false } },
    ]);
  });

  it("releases the claim and rethrows on a grant write failure", async () => {
    const stub = makePrisma(freshSub(), { failUpsert: true });
    const svc = loadService(stub);
    let released = false;
    await assert.rejects(
      () =>
        svc.grantWebhookSubscription(webhookCtx(), alwaysWin, async () => {
          released = true;
        }),
      /simulated grant failure/
    );
    assert.equal(released, true, "claim released on failure");
  });
});

describe("grantWebhookSubscription — addon (credit pack)", () => {
  it("PREMIUM sub + 50-pack → packCreditsLimit 2050, 'addon_granted'", async () => {
    const stub = makePrisma(
      freshSub({ planId: "PREMIUM", packCreditsLimit: 2000 })
    );
    const svc = loadService(stub);
    const result = await svc.grantWebhookSubscription(
      webhookCtx({ planId: "QUERY_PACK", creditPackSize: 50 }),
      alwaysWin,
      noRelease
    );
    assert.equal(result, "addon_granted");
    assert.equal(upserts(stub).length, 0, "addon must not rewrite the plan");
    const data = (subUpdates(stub)[0].args as { data: Record<string, unknown> })
      .data;
    assert.equal(data.packCreditsLimit, 2050);
    assert.equal(data.queryPackActive, true);
  });

  it("no subscription row → 'addon_no_subscription' without calling claim", async () => {
    const stub = makePrisma(null);
    const svc = loadService(stub);
    let claimCalled = false;
    const result = await svc.grantWebhookSubscription(
      webhookCtx({ planId: "QUERY_PACK" }),
      async () => {
        claimCalled = true;
        return true;
      },
      noRelease
    );
    assert.equal(result, "addon_no_subscription");
    assert.equal(
      claimCalled,
      false,
      "no claim burned when there is no sub row"
    );
  });

  it("FREE-plan sub → 'addon_ineligible' without calling claim", async () => {
    const stub = makePrisma(freshSub({ planId: "FREE" }));
    const svc = loadService(stub);
    let claimCalled = false;
    const result = await svc.grantWebhookSubscription(
      webhookCtx({ planId: "QUERY_PACK" }),
      async () => {
        claimCalled = true;
        return true;
      },
      noRelease
    );
    assert.equal(result, "addon_ineligible");
    assert.equal(claimCalled, false);
  });
});

// ── callback grant shape (divergence) ───────────────────────────────────────

describe("grantCallbackSubscription — grant shape", () => {
  it("PRO → aiQueriesLimit 20 (PLAN_CONFIG divergence vs webhook)", async () => {
    const stub = makePrisma(freshSub());
    const svc = loadService(stub);
    const outcome = await svc.grantCallbackSubscription(
      callbackCtx(),
      alwaysWin,
      noRelease
    );
    assert.equal(outcome, "granted");
    const update = (
      upserts(stub)[0].args as { update: Record<string, unknown> }
    ).update;
    assert.equal(update.planId, "PRO");
    // PRESERVED divergence: callback reads aiQueriesLimit from PLAN_CONFIG → 20.
    assert.equal(update.aiQueriesLimit, 20);
    assert.equal(update.fastQueriesLimit, 20);
    assert.equal(update.creditsLimit, 50);
  });

  it("QUERY_PACK with no sub → 'addon_ineligible'", async () => {
    const stub = makePrisma(null);
    const svc = loadService(stub);
    const outcome = await svc.grantCallbackSubscription(
      callbackCtx({ planId: "QUERY_PACK" }),
      alwaysWin,
      noRelease
    );
    assert.equal(outcome, "addon_ineligible");
    assert.equal(upserts(stub).length, 0);
  });

  it("QUERY_PACK on a FREE sub → 'addon_ineligible'", async () => {
    const stub = makePrisma(freshSub({ planId: "FREE" }));
    const svc = loadService(stub);
    const outcome = await svc.grantCallbackSubscription(
      callbackCtx({ planId: "QUERY_PACK" }),
      alwaysWin,
      noRelease
    );
    assert.equal(outcome, "addon_ineligible");
  });

  it("a lost claim → 'already_applied', no grant", async () => {
    const stub = makePrisma(freshSub());
    const svc = loadService(stub);
    const outcome = await svc.grantCallbackSubscription(
      callbackCtx(),
      alwaysLose,
      noRelease
    );
    assert.equal(outcome, "already_applied");
    assert.equal(upserts(stub).length, 0);
  });
});

// ── lifecycle mutators ──────────────────────────────────────────────────────

describe("Dodo lifecycle mutators", () => {
  it("applyDodoCancellation with a future term keeps access + schedules the drop", async () => {
    const stub = makePrisma(
      freshSub({
        planId: "PREMIUM",
        endDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      })
    );
    const svc = loadService(stub);
    const target = await svc.applyDodoCancellation("dodo_sub_1");
    assert.ok(target);
    assert.equal(target!.planName, "Premium");
    const data = (subUpdates(stub)[0].args as { data: Record<string, unknown> })
      .data;
    assert.equal(data.scheduledPlanId, "FREE");
    assert.equal("status" in data, false, "stays ACTIVE while the term runs");
  });

  it("applyDodoCancellation with no remaining term flips to CANCELLED", async () => {
    const stub = makePrisma(freshSub({ planId: "PREMIUM", endDate: null }));
    const svc = loadService(stub);
    await svc.applyDodoCancellation("dodo_sub_1");
    const data = (subUpdates(stub)[0].args as { data: { status: string } })
      .data;
    assert.equal(data.status, "CANCELLED");
  });

  it("[J-F4] both anchors null + monthly period → SCHEDULED drop at derived term end (not immediate CANCELLED)", async () => {
    // A first-cycle webhook row can carry neither endDate nor nextBillingDate.
    // Cancelling immediately would eat the paid term; derive term end from
    // startDate + billingPeriod instead. startDate = 5 days ago on a monthly term
    // → derived end ~25 days out (future) → scheduled, access kept.
    const start = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const stub = makePrisma(
      freshSub({
        planId: "PREMIUM",
        endDate: null,
        nextBillingDate: null,
        billingPeriod: "monthly",
        startDate: start,
      })
    );
    const svc = loadService(stub);
    await svc.applyDodoCancellation("dodo_sub_1");
    const data = (subUpdates(stub)[0].args as { data: Record<string, unknown> })
      .data;
    assert.equal(data.scheduledPlanId, "FREE");
    assert.equal(
      "status" in data,
      false,
      "stays ACTIVE — the derived paid term still runs"
    );
    const effectiveAt = data.scheduledEffectiveAt as Date;
    assert.ok(effectiveAt instanceof Date);
    assert.ok(
      effectiveAt.getTime() > Date.now(),
      "scheduled at the derived FUTURE term end (start + 30d)"
    );
  });

  it("[J-F4] no derivable term (startDate present but no billing period) → immediate CANCELLED preserved", async () => {
    const stub = makePrisma(
      freshSub({
        planId: "PREMIUM",
        endDate: null,
        nextBillingDate: null,
        billingPeriod: null, // nothing to derive from
        startDate: new Date(),
      })
    );
    const svc = loadService(stub);
    await svc.applyDodoCancellation("dodo_sub_1");
    const data = (subUpdates(stub)[0].args as { data: { status: string } })
      .data;
    assert.equal(data.status, "CANCELLED");
  });

  it("applyDodoRenewal for a FREE-plan row is skipped (returns null, no write)", async () => {
    const stub = makePrisma(freshSub({ planId: "FREE" }));
    const svc = loadService(stub);
    const target = await svc.applyDodoRenewal("dodo_sub_1", null);
    assert.equal(target, null);
    assert.equal(subUpdates(stub).length, 0);
  });

  it("markDodoPastDue writes PAST_DUE; markDodoExpired writes EXPIRED+endDate", async () => {
    const stub1 = makePrisma(freshSub({ planId: "PREMIUM" }));
    const svc1 = loadService(stub1);
    await svc1.markDodoPastDue("dodo_sub_1", "subscription.on_hold");
    assert.equal(
      (subUpdates(stub1)[0].args as { data: { status: string } }).data.status,
      "PAST_DUE"
    );

    const stub2 = makePrisma(freshSub({ planId: "PREMIUM" }));
    const svc2 = loadService(stub2);
    await svc2.markDodoExpired("dodo_sub_1");
    const data = (
      subUpdates(stub2)[0].args as { data: Record<string, unknown> }
    ).data;
    assert.equal(data.status, "EXPIRED");
    assert.ok(data.endDate instanceof Date);
  });

  it("storeDodoActivationAnchors never rolls nextBillingDate backwards", async () => {
    const stub = makePrisma(
      freshSub({
        planId: "PREMIUM",
        nextBillingDate: new Date("2026-08-01T00:00:00Z"),
      })
    );
    const svc = loadService(stub);
    await svc.storeDodoActivationAnchors("dodo_sub_1", "2026-07-11T00:00:00Z");
    assert.equal(subUpdates(stub).length, 0, "stale anchor must not overwrite");
  });

  it("[guard] missing subscription_id → every lifecycle mutator skips without touching the DB", async () => {
    // MONEY-1062 review (F1): Prisma DROPS an undefined where-value, so
    // findFirst({ where: { dodoSubscriptionId: undefined } }) matches the
    // FIRST Subscription row — cancelling/renewing/expiring a random user.
    // Each mutator must return early instead.
    const stub = makePrisma(freshSub({ planId: "PREMIUM" }));
    const svc = loadService(stub);
    assert.equal(await svc.applyDodoCancellation(undefined), null);
    assert.equal(
      await svc.applyDodoRenewal(undefined, "2026-08-01T00:00:00Z"),
      null
    );
    await svc.markDodoPastDue(undefined, "subscription.on_hold");
    await svc.markDodoExpired(undefined);
    await svc.storeDodoActivationAnchors(undefined, "2026-08-01T00:00:00Z");
    assert.equal(
      stub.calls.length,
      0,
      "no prisma call may run with an undefined dodoSubscriptionId filter"
    );
  });
});

describe("grantWebhookSubscription — upgrade bonus days (J-F5 malformed anchor)", () => {
  it("a malformed ctx.nextBillingDate falls back to the standard term (bonus days NOT dropped)", async () => {
    // PRO(monthly) → PREMIUM(monthly) with ~20 days left yields bonus days (>0).
    // A malformed Dodo next_billing_date used to make the base anchor an Invalid
    // Date → the later extendedAnchor.toISOString() threw INSIDE the try, silently
    // dropping the bonus days (no nextBillingDate write). With the fix the base
    // anchor falls back to now + standard term, so the write still lands (valid Date).
    const futureTerm = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const stub = makePrisma(
      freshSub({
        planId: "PRO",
        billingPeriod: "monthly",
        endDate: futureTerm,
        dodoSubscriptionId: "dodo_old",
      })
    );
    const svc = loadService(stub);
    const result = await svc.grantWebhookSubscription(
      webhookCtx({
        planId: "PREMIUM",
        period: "monthly",
        dodoSubscriptionId: "dodo_new",
        nextBillingDate: "not-a-real-date", // malformed
      }),
      alwaysWin,
      noRelease
    );
    assert.equal(result, "plan_granted");
    // The bonus-days nextBillingDate write happened with a VALID date (previously
    // it threw + dropped the bonus).
    const bonusWrite = subUpdates(stub).find(
      (c) => (c.args as { data: Record<string, unknown> }).data.nextBillingDate
    );
    assert.ok(bonusWrite, "bonus-days nextBillingDate write must occur");
    const nbd = (bonusWrite!.args as { data: { nextBillingDate: Date } }).data
      .nextBillingDate;
    assert.ok(
      nbd instanceof Date && Number.isFinite(nbd.getTime()),
      "valid Date, not Invalid"
    );
  });
});
