/**
 * Scheduled-plan-changes SERVICE contract tests — MONEY-482 / MONEY-1062 (W1-B).
 *
 * Drives the REAL `@usemoney/services` `applyScheduledChanges` (subscription
 * plan-lifecycle cron body) against a recording prisma double, with the
 * `./product-sync.service` module (getDodoProductInfo) and `dodoClient` stubbed
 * via the require.cache seam. Covers the FREE cancel flip, the
 * no-Dodo-subscription flip, the missing-product SKIP, the Dodo `changePlan`
 * downgrade, the due-selection `where`, and per-row error isolation. The pure
 * seam (buildRebaseFields) is tested in
 * packages/services/__tests__/scheduled-plan-changes.test.ts.
 *
 * Lives in apps/web (CJS) because packages/services runs its suite as ESM where
 * `require.cache` injection is unavailable.
 *
 * Source: packages/services/src/scheduled-plan-changes.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

interface DueSub {
  id: string;
  userId: string;
  scheduledPlanId: string | null;
  scheduledBillingPeriod: string | null;
  scheduledEffectiveAt: Date | null;
  dodoSubscriptionId: string | null;
}

interface ChangePlanCall {
  subscriptionId: string;
  args: unknown;
}

function makePrisma(due: DueSub[]) {
  const calls: RecordedCall[] = [];
  // Mutable "current DB state" backing the conditional FREE-flip `updateMany`.
  // Seeded from the snapshot; a test can null a row's scheduledPlanId to
  // simulate a fresh `payment.succeeded` grant landing between the `findMany`
  // snapshot and the write (which clears the scheduled-* fields).
  const state = new Map<string, { scheduledPlanId: string | null }>(
    due.map((d) => [d.id, { scheduledPlanId: d.scheduledPlanId }])
  );
  return {
    calls,
    state,
    subscription: {
      findMany: (args: unknown) => {
        calls.push({ model: "subscription", method: "findMany", args });
        return Promise.resolve(due);
      },
      update: (args: unknown) => {
        calls.push({ model: "subscription", method: "update", args });
        return Promise.resolve({});
      },
      updateMany: (args: { where: { id: string } }) => {
        calls.push({ model: "subscription", method: "updateMany", args });
        // Faithful to the real conditional write: the row matches only while
        // its scheduledPlanId is still set (the `{ not: null }` guard). A grant
        // that superseded the schedule nulled it → 0 rows match → count 0.
        const row = state.get(args.where.id);
        const matched = !!row && row.scheduledPlanId !== null;
        if (matched) state.set(args.where.id, { scheduledPlanId: null });
        return Promise.resolve({ count: matched ? 1 : 0 });
      },
    },
  };
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SVC_REL =
  "../../../../packages/services/src/scheduled-plan-changes.service";
const PRODUCT_SYNC_REL =
  "../../../../packages/services/src/product-sync.service";
type ServiceModule =
  typeof import("../../../../packages/services/src/scheduled-plan-changes.service");

/** Stub shape for the (now directly-imported) product-catalog lookup. */
type ProductInfoFn = (
  planType: string,
  billingPeriod?: string
) => Promise<{ productId: string; isRecurring: boolean; price: number } | null>;

function loadService(
  stub: ReturnType<typeof makePrisma>,
  changePlanCalls: ChangePlanCall[],
  // MONEY-1062 review: getDodoProductInfo is no longer an injection param on
  // applyScheduledChanges — it is imported from ./product-sync.service, so the
  // test stubs THAT module (same require.cache seam as prisma/dodoClient).
  getDodoProductInfo: ProductInfoFn = async () => null
): ServiceModule {
  const cache = moduleCache();
  const dbPath = require.resolve("@usemoney/database");
  const logPath = require.resolve("@usemoney/logger");
  const corePayPath = require.resolve("@usemoney/core/payments");
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
      paymentsLogger: { info() {}, warn() {}, error() {}, debug() {} },
      dbLogger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
  cache[corePayPath] = {
    exports: {
      ...realCorePay,
      dodoClient: {
        subscriptions: {
          changePlan: (subscriptionId: string, args: unknown) => {
            changePlanCalls.push({ subscriptionId, args });
            return Promise.resolve({});
          },
        },
      },
    },
  };
  cache[require.resolve(PRODUCT_SYNC_REL)] = {
    exports: { __esModule: true, getDodoProductInfo },
  };
  delete cache[require.resolve(SVC_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(SVC_REL) as ServiceModule;
}

function dueSub(over: Partial<DueSub> = {}): DueSub {
  return {
    id: "sub_1",
    userId: "user_1",
    scheduledPlanId: "FREE",
    scheduledBillingPeriod: null,
    scheduledEffectiveAt: new Date("2026-07-09T00:00:00Z"),
    dodoSubscriptionId: null,
    ...over,
  };
}

const updates = (stub: ReturnType<typeof makePrisma>) =>
  stub.calls.filter((c) => c.model === "subscription" && c.method === "update");

const updateManys = (stub: ReturnType<typeof makePrisma>) =>
  stub.calls.filter(
    (c) => c.model === "subscription" && c.method === "updateMany"
  );

describe("applyScheduledChanges (service)", () => {
  it("FREE cancel (normal path): conditionally flips to FREE, clears schedule, rebases, status ACTIVE", async () => {
    const stub = makePrisma([dueSub({ scheduledPlanId: "FREE" })]);
    const changePlanCalls: ChangePlanCall[] = [];
    const svc = loadService(stub, changePlanCalls);
    const result = await svc.applyScheduledChanges();
    assert.equal(result.applied, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors.length, 0);
    // The FREE flip is a conditional `updateMany` (TOCTOU guard), NOT `update`.
    assert.equal(updates(stub).length, 0, "FREE path never uses update()");
    const call = updateManys(stub)[0];
    const where = (call.args as { where: Record<string, unknown> }).where;
    assert.equal(where.id, "sub_1");
    assert.deepEqual(
      where.scheduledPlanId,
      { not: null },
      "re-asserts the schedule is still present"
    );
    assert.ok(
      (where.scheduledEffectiveAt as { lte: Date }).lte instanceof Date,
      "re-asserts effectiveAt <= the run's now"
    );
    const data = (call.args as { data: Record<string, unknown> }).data;
    assert.equal(data.planId, "FREE");
    assert.equal(data.status, "ACTIVE");
    assert.equal(data.scheduledPlanId, null);
    assert.equal(data.scheduledEffectiveAt, null);
    assert.equal(data.endDate, null);
    assert.equal(data.creditsLimit, 5, "rebased to FREE credits");
    assert.equal(changePlanCalls.length, 0, "FREE never calls Dodo changePlan");
  });

  it("FREE cancel superseded by a fresh grant (schedule cleared between snapshot and write) → skipped, not applied, no flip", async () => {
    // MONEY-1062 TOCTOU: a `payment.succeeded` grant lands between the snapshot
    // findMany and the FREE flip, clearing scheduledPlanId/scheduledEffectiveAt.
    // The conditional updateMany must match 0 rows so the just-paid user is NOT
    // clobbered back to FREE (the consumed fulfillment claim means no redelivery
    // would re-grant).
    const stub = makePrisma([dueSub({ scheduledPlanId: "FREE" })]);
    // Simulate the grant: the row's scheduled fields were cleared post-snapshot.
    stub.state.set("sub_1", { scheduledPlanId: null });
    const changePlanCalls: ChangePlanCall[] = [];
    const svc = loadService(stub, changePlanCalls);
    const result = await svc.applyScheduledChanges();
    assert.equal(result.applied, 0, "superseded row is NOT applied");
    assert.equal(result.skipped, 1, "superseded row counts as skipped");
    assert.equal(result.errors.length, 0);
    // The conditional write was attempted (guard ran) but matched 0 rows, so no
    // subscription was actually flipped to FREE.
    assert.equal(updateManys(stub).length, 1, "conditional updateMany ran");
    assert.equal(
      updates(stub).length,
      0,
      "no row flipped to FREE via update()"
    );
    assert.equal(changePlanCalls.length, 0);
  });

  it("downgrade with NO Dodo subscription: flips local plan only, no Dodo call", async () => {
    const stub = makePrisma([
      dueSub({
        scheduledPlanId: "PRO",
        scheduledBillingPeriod: "monthly",
        dodoSubscriptionId: null,
      }),
    ]);
    const changePlanCalls: ChangePlanCall[] = [];
    let productLookups = 0;
    const svc = loadService(stub, changePlanCalls, async () => {
      productLookups++;
      return null;
    });
    const result = await svc.applyScheduledChanges();
    assert.equal(result.applied, 1);
    // MONEY-1062 Round-C: the local flip is now a CAS `updateMany` (re-asserting
    // scheduledPlanId not-null + effectiveAt lte now) so a fresh grant landing
    // mid-run can't be clobbered — same guard the FREE branch got.
    const call = updateManys(stub)[0];
    const data = (call.args as { data: Record<string, unknown> }).data;
    assert.equal(data.planId, "PRO");
    assert.equal(data.billingPeriod, "monthly");
    const where = (call.args as { where: Record<string, unknown> }).where;
    assert.deepEqual(where.scheduledPlanId, { not: null });
    assert.equal(productLookups, 0, "no product lookup without a Dodo sub");
    assert.equal(changePlanCalls.length, 0);
  });

  it("downgrade with a Dodo sub but NO product → SKIPPED (not an error), no update", async () => {
    // MONEY-1062 review: a missing catalog row now counts as `skipped`
    // (retryable — the schedule stays for the next hourly run) instead of
    // being pushed to `errors`. Pinned expectation deliberately updated.
    const stub = makePrisma([
      dueSub({
        scheduledPlanId: "PRO",
        scheduledBillingPeriod: "monthly",
        dodoSubscriptionId: "dodo_sub_1",
      }),
    ]);
    const changePlanCalls: ChangePlanCall[] = [];
    const svc = loadService(stub, changePlanCalls, async () => null);
    const result = await svc.applyScheduledChanges();
    assert.equal(result.applied, 0);
    assert.equal(result.skipped, 1, "missing product counts as skipped");
    assert.equal(result.errors.length, 0, "no longer surfaced as an error");
    assert.equal(updates(stub).length, 0);
    assert.equal(changePlanCalls.length, 0);
  });

  it("downgrade with a Dodo sub + product → changePlan then local flip", async () => {
    const stub = makePrisma([
      dueSub({
        scheduledPlanId: "PREMIUM",
        scheduledBillingPeriod: "monthly",
        dodoSubscriptionId: "dodo_sub_1",
      }),
    ]);
    const changePlanCalls: ChangePlanCall[] = [];
    const svc = loadService(stub, changePlanCalls, async () => ({
      productId: "prod_premium_monthly",
      isRecurring: true,
      price: 999,
    }));
    const result = await svc.applyScheduledChanges();
    assert.equal(result.applied, 1);
    assert.equal(changePlanCalls.length, 1);
    assert.equal(changePlanCalls[0].subscriptionId, "dodo_sub_1");
    assert.equal(
      (changePlanCalls[0].args as { product_id: string }).product_id,
      "prod_premium_monthly"
    );
    // Local flip is a CAS `updateMany` here too — after the Dodo changePlan.
    const data = (
      updateManys(stub)[0].args as { data: Record<string, unknown> }
    ).data;
    assert.equal(data.planId, "PREMIUM");
    assert.equal(data.billingPeriod, "monthly");
  });

  it("downgrade superseded by a fresh grant between snapshot and write → skipped, not applied", async () => {
    // Simulate the TOCTOU: a payment.succeeded grant lands after the due-row
    // snapshot and nulls scheduledPlanId. The CAS updateMany matches 0 rows.
    const stub = makePrisma([
      dueSub({
        scheduledPlanId: "PRO",
        scheduledBillingPeriod: "monthly",
        dodoSubscriptionId: null,
      }),
    ]);
    // Grant landed: clear the backing state the updateMany guard reads.
    stub.state.set([...stub.state.keys()][0]!, { scheduledPlanId: null });
    const changePlanCalls: ChangePlanCall[] = [];
    const svc = loadService(stub, changePlanCalls, async () => null);
    const result = await svc.applyScheduledChanges();
    assert.equal(result.applied, 0, "the superseded flip did NOT apply");
    assert.equal(result.skipped, 1, "counted as skipped");
    assert.equal(
      updateManys(stub).length,
      1,
      "the guarded write was attempted"
    );
  });

  it("one failing row is captured as an error and never aborts the batch", async () => {
    const stub = makePrisma([
      dueSub({ id: "sub_ok", scheduledPlanId: "FREE" }),
      dueSub({
        id: "sub_bad",
        scheduledPlanId: "PRO",
        dodoSubscriptionId: "dodo_sub_bad",
      }),
    ]);
    const changePlanCalls: ChangePlanCall[] = [];
    const svc = loadService(stub, changePlanCalls, async () => {
      throw new Error("catalog down");
    });
    const result = await svc.applyScheduledChanges();
    assert.equal(result.applied, 1, "the FREE row still applied");
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].subscriptionId, "sub_bad");
    assert.match(result.errors[0].message, /catalog down/);
  });

  it("queries only due rows (scheduledPlanId not null AND effectiveAt lte now)", async () => {
    const stub = makePrisma([]);
    const svc = loadService(stub, []);
    await svc.applyScheduledChanges();
    const findMany = stub.calls.find(
      (c) => c.model === "subscription" && c.method === "findMany"
    );
    const where = (findMany!.args as { where: Record<string, unknown> }).where;
    assert.deepEqual(where.scheduledPlanId, { not: null });
    assert.ok(
      (where.scheduledEffectiveAt as { lte: Date }).lte instanceof Date
    );
  });
});
