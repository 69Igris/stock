/**
 * Payment-provisioning CLAIM-ONCE + transport contract tests — MONEY-1062 (W1-B).
 *
 * Per the founder directive, the claim-once / race / idempotency tests live on
 * the PAYMENTS side. These drive the REAL `@usemoney/services` payments transport
 * (`provisionPaymentCompleted`, `provisionPaymentCallbackGrant`, the lifecycle
 * handlers, and the `provisionDodoWebhookEvent` dispatcher) — which calls into the
 * REAL subscription-grants module — against a recording prisma double + spy
 * notifier. Asserts:
 *   - Payment-row bookkeeping (COMPLETED metadata merge, FAILED merge, REFUNDED);
 *   - the appliedAt claim (null-or-unset) is applied EXACTLY ONCE under a
 *     webhook↔callback race and a duplicate re-delivery;
 *   - claim-release + rethrow on a grant write failure;
 *   - notifier orchestration (success / failed / cancelled + segment moves) and
 *     coupon redemption;
 *   - dispatcher routing + lifecycle/refund events.
 * Grant-SHAPE parity is asserted separately in subscription-grants-service.test.ts.
 *
 * Lives in apps/web (CJS) because packages/services runs its suite as ESM where
 * `require.cache` injection is unavailable (subscription-billing-anchor-heal.test.ts
 * pattern).
 *
 * Source: packages/services/src/payment-provisioning.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ─────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

interface PaymentRow {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  period: string;
  amount: number;
  currency: string;
  metadata: Record<string, unknown>;
  appliedAt: Date | null;
  paymentMethod: string | null;
}

interface SubRow {
  id: string;
  userId: string;
  planId: string;
  status: string;
  endDate: Date | null;
  nextBillingDate: Date | null;
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

function makePrisma(
  payment: PaymentRow,
  subscription: SubRow | null,
  opts: StubOpts = {}
) {
  const calls: RecordedCall[] = [];
  const push = (model: string, method: string, args: unknown) =>
    calls.push({ model, method, args });
  const user = {
    id: payment.userId,
    email: "buyer@example.com",
    name: "Buyer Person",
    emailPreferences: null,
  };
  return {
    // NOTE: `user` is the Prisma DELEGATE (below), not the row. A `user,`
    // shorthand for the row literal used to sit here and was silently
    // overwritten by that delegate — dead the moment it was written.
    calls,
    payment: {
      findFirst: (args: unknown) => {
        push("payment", "findFirst", args);
        return Promise.resolve(payment);
      },
      findUnique: (args: unknown) => {
        push("payment", "findUnique", args);
        return Promise.resolve(payment);
      },
      update: (args: unknown) => {
        push("payment", "update", args);
        return Promise.resolve(payment);
      },
      updateMany: (args: {
        where: { id: string };
        data: { appliedAt: Date | null };
      }) => {
        push("payment", "updateMany", args);
        if (args.where.id !== payment.id) return Promise.resolve({ count: 0 });
        if (args.data.appliedAt === null) {
          payment.appliedAt = null; // release
          return Promise.resolve({ count: 1 });
        }
        if (payment.appliedAt === null) {
          payment.appliedAt = args.data.appliedAt; // claim
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      },
    },
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
    user: {
      findUnique: (args: unknown) => {
        push("user", "findUnique", args);
        return Promise.resolve(user);
      },
    },
  };
}

// ── spy notifier ────────────────────────────────────────────────────────────

interface NotifierCall {
  method: string;
  input: Record<string, unknown>;
}
function makeNotifier() {
  const calls: NotifierCall[] = [];
  const rec =
    (method: string) =>
    (input: Record<string, unknown>): void => {
      calls.push({ method, input });
    };
  return {
    calls,
    paymentSucceeded: rec("paymentSucceeded"),
    paymentFailed: rec("paymentFailed"),
    subscriptionCancelled: rec("subscriptionCancelled"),
    subscriptionRenewed: rec("subscriptionRenewed"),
    moveSegment: async (input: Record<string, unknown>) => {
      calls.push({ method: "moveSegment", input });
    },
  };
}

// ── require.cache injection (CJS) ───────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SVC_REL =
  "../../../../packages/services/src/payment-provisioning.service";
const GRANTS_REL =
  "../../../../packages/services/src/subscription-grants.service";
const PAYGRANT_REL = "../../../../packages/services/src/payment-grant.service";
const COUPON_REL = "../../../../packages/services/src/coupon.service";
type ServiceModule =
  typeof import("../../../../packages/services/src/payment-provisioning.service");

function loadService(
  stub: ReturnType<typeof makePrisma>,
  couponCalls: unknown[][] = []
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
      dbLogger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
  cache[corePayPath] = {
    exports: {
      ...realCorePay,
      dodoClient: { subscriptions: { update: () => Promise.resolve({}) } },
    },
  };
  // Spy on coupon redemption (DB-touching) so it never hits the stub prisma's
  // (absent) coupon delegate — records the args instead.
  cache[require.resolve(COUPON_REL)] = {
    exports: {
      __esModule: true,
      recordCouponRedemption: (...a: unknown[]) => {
        couponCalls.push(a);
        return Promise.resolve();
      },
    },
  };
  // Fresh-require the transport + its prisma-touching siblings so each test
  // rebinds to the injected doubles with no leaked module state (keep the
  // coupon spy above — don't delete it).
  for (const rel of [SVC_REL, GRANTS_REL, PAYGRANT_REL]) {
    delete cache[require.resolve(rel)];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(SVC_REL) as ServiceModule;
}

function freshPayment(over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: "pay_1",
    userId: "user_1",
    planId: "PRO",
    planName: "PRO",
    period: "one-time",
    amount: 999,
    currency: "INR",
    metadata: {},
    appliedAt: null,
    paymentMethod: null,
    ...over,
  };
}

function freshSub(over: Partial<SubRow> = {}): SubRow {
  return {
    id: "sub_1",
    userId: "user_1",
    planId: "FREE",
    status: "ACTIVE",
    endDate: null,
    nextBillingDate: null,
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

const upserts = (stub: ReturnType<typeof makePrisma>) =>
  stub.calls.filter((c) => c.model === "subscription" && c.method === "upsert");
const subUpdates = (stub: ReturnType<typeof makePrisma>) =>
  stub.calls.filter((c) => c.model === "subscription" && c.method === "update");
const claims = (stub: ReturnType<typeof makePrisma>) =>
  stub.calls.filter((c) => c.model === "payment" && c.method === "updateMany");

// ── claim-once + bookkeeping (webhook payment.succeeded) ────────────────────

describe("provisionPaymentCompleted — bookkeeping + claim-once", () => {
  it("stamps Payment COMPLETED (metadata merged), claims null-or-unset, grants once", async () => {
    const stub = makePrisma(
      freshPayment({
        metadata: { creditPackSize: 7, discountCode: undefined },
      }),
      freshSub()
    );
    const svc = loadService(stub);
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1", invoice_id: "inv_1" },
      makeNotifier()
    );
    // Payment bookkeeping: status COMPLETED, checkout keys preserved.
    const payUpdate = stub.calls.find(
      (c) => c.model === "payment" && c.method === "update"
    );
    const pdata = (payUpdate!.args as { data: Record<string, unknown> }).data;
    assert.equal(pdata.status, "COMPLETED");
    assert.equal(
      (pdata.metadata as Record<string, unknown>).creditPackSize,
      7,
      "original checkout metadata preserved on merge"
    );
    // Claim covers BOTH null and UNSET appliedAt (Mongo pin).
    const where = (claims(stub)[0].args as { where: { OR: unknown } }).where;
    assert.deepEqual(where.OR, [
      { appliedAt: null },
      { appliedAt: { isSet: false } },
    ]);
    assert.equal(upserts(stub).length, 1, "grant applied exactly once");
  });

  it("is idempotent across a duplicate re-delivery (grant applied exactly once)", async () => {
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1" },
      makeNotifier()
    );
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1" },
      makeNotifier()
    );
    assert.equal(claims(stub).length, 2, "both deliveries attempt the claim");
    assert.equal(upserts(stub).length, 1);
  });

  it("a grant write failure releases the claim and rethrows", async () => {
    const payment = freshPayment();
    const stub = makePrisma(payment, freshSub(), { failUpsert: true });
    const svc = loadService(stub);
    await assert.rejects(
      () =>
        svc.provisionPaymentCompleted(
          { payment_id: "dodo_pay_1" },
          makeNotifier()
        ),
      /simulated grant failure/
    );
    assert.equal(payment.appliedAt, null, "claim handed back for retry");
  });

  it("notifies paymentSucceeded THEN moveSegment(free→paid); REAL charge used", async () => {
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    const notifier = makeNotifier();
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1", total_amount: 129900, currency: "USD" },
      notifier
    );
    assert.deepEqual(
      notifier.calls.map((c) => c.method),
      ["paymentSucceeded", "moveSegment"]
    );
    assert.equal(notifier.calls[0].input.amount, "1299");
    assert.equal(notifier.calls[0].input.currency, "USD");
    assert.equal(notifier.calls[1].input.from, "free");
    assert.equal(notifier.calls[1].input.to, "paid");
  });

  it("records a coupon redemption when the paid Payment carried a discount code", async () => {
    const couponCalls: unknown[][] = [];
    const stub = makePrisma(
      freshPayment({ metadata: { discountCode: "LAUNCH20" } }),
      freshSub()
    );
    const svc = loadService(stub, couponCalls);
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1" },
      makeNotifier()
    );
    assert.equal(couponCalls.length, 1, "coupon recorded exactly once");
    assert.equal(couponCalls[0][0], "LAUNCH20");
    assert.equal(couponCalls[0][3], "pay_1", "keyed to the payment id");
  });

  it("[J-F10] missing Dodo total → receipt uses the stored INR amount AND its currency (paired)", async () => {
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    const notifier = makeNotifier();
    // No total_amount, but a presentment currency (USD) is present. The amount must
    // fall back to the stored checkout figure (999) AND its currency (INR) — never
    // the ₹ figure labelled USD (the mismatched-receipt bug).
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1", currency: "USD" },
      notifier
    );
    const ok = notifier.calls.find((c) => c.method === "paymentSucceeded")!;
    assert.equal(ok.input.amount, "999");
    assert.equal(ok.input.currency, "INR");
  });

  it("[J-F10] a garbage total_amount string also falls back to INR (coerce → null)", async () => {
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    const notifier = makeNotifier();
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1", total_amount: "abc", currency: "USD" },
      notifier
    );
    const ok = notifier.calls.find((c) => c.method === "paymentSucceeded")!;
    assert.equal(ok.input.amount, "999");
    assert.equal(ok.input.currency, "INR");
  });

  it("[J-F7] a transient post-grant side-effect failure does NOT rethrow (grant is durable)", async () => {
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    // The grant commits (upsert), THEN the post-grant user fetch throws transiently.
    // It must NOT propagate: a Dodo redelivery would hit already_applied and skip
    // the notify + coupon steps, so a side-effect throw must never 500 the route.
    stub.user.findUnique = () =>
      Promise.reject(new Error("transient user fetch"));
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1", total_amount: 129900, currency: "USD" },
      makeNotifier()
    );
    assert.equal(
      upserts(stub).length,
      1,
      "grant applied before the side-effect failure (durable)"
    );
  });
});

// ── webhook↔callback race ───────────────────────────────────────────────────

describe("claim-once under a webhook↔callback race (same Payment row)", () => {
  it("webhook wins → callback is a no-op ('already_applied'), one upsert total", async () => {
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1" },
      makeNotifier()
    );
    const outcome = await svc.provisionPaymentCallbackGrant({
      payment: {
        id: "pay_1",
        userId: "user_1",
        planId: "PRO",
        planName: "PRO",
        period: "one-time",
        status: "COMPLETED",
        metadata: {},
      },
    });
    assert.equal(outcome, "already_applied");
    assert.equal(upserts(stub).length, 1);
  });

  it("callback wins → webhook re-delivery is a no-op, one upsert total", async () => {
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    const outcome = await svc.provisionPaymentCallbackGrant({
      payment: {
        id: "pay_1",
        userId: "user_1",
        planId: "PRO",
        planName: "PRO",
        period: "one-time",
        status: "COMPLETED",
        metadata: {},
      },
    });
    assert.equal(outcome, "granted");
    await svc.provisionPaymentCompleted(
      { payment_id: "dodo_pay_1" },
      makeNotifier()
    );
    assert.equal(upserts(stub).length, 1);
  });
});

// ── payment.failed + refund bookkeeping ─────────────────────────────────────

describe("provisionPaymentFailed / provisionRefundSucceeded (payments bookkeeping)", () => {
  it("FAILED merges metadata under failureEvent + notifies with sanitized error", async () => {
    const stub = makePrisma(
      freshPayment({ metadata: { creditPackSize: 50 } }),
      freshSub()
    );
    const svc = loadService(stub);
    const notifier = makeNotifier();
    await svc.provisionPaymentFailed(
      { payment_id: "dodo_pay_1", error_message: "card declined by bank" },
      notifier
    );
    const data = (
      stub.calls.find((c) => c.model === "payment" && c.method === "update")!
        .args as { data: Record<string, unknown> }
    ).data;
    assert.equal(data.status, "FAILED");
    const meta = data.metadata as Record<string, unknown>;
    assert.equal(meta.creditPackSize, 50);
    assert.ok(meta.failureEvent);
    const failed = notifier.calls.find((c) => c.method === "paymentFailed")!;
    assert.ok((failed.input.errorMessage as string).includes("declined"));
  });

  it("refund marks the Payment REFUNDED and touches NO subscription", async () => {
    const stub = makePrisma(freshPayment(), freshSub({ planId: "PREMIUM" }));
    const svc = loadService(stub);
    await svc.provisionRefundSucceeded({ payment_id: "dodo_pay_1" });
    const payUpdate = stub.calls.find(
      (c) => c.model === "payment" && c.method === "update"
    );
    assert.equal(
      (payUpdate!.args as { data: { status: string } }).data.status,
      "REFUNDED"
    );
    const subWrites = stub.calls.filter(
      (c) => c.model === "subscription" && c.method !== "findFirst"
    );
    assert.equal(subWrites.length, 0, "refunds must not touch entitlements");
  });
});

// ── dispatcher + lifecycle routing ──────────────────────────────────────────

describe("provisionDodoWebhookEvent — dispatcher + lifecycle", () => {
  it("routes payment.succeeded → grant; unhandled → no DB work", async () => {
    const stub1 = makePrisma(freshPayment(), freshSub());
    const svc1 = loadService(stub1);
    await svc1.provisionDodoWebhookEvent(
      "payment.succeeded",
      { payment_id: "dodo_pay_1" },
      makeNotifier()
    );
    assert.equal(upserts(stub1).length, 1);

    const stub2 = makePrisma(freshPayment(), freshSub());
    const svc2 = loadService(stub2);
    await svc2.provisionDodoWebhookEvent(
      "invoice.paid",
      { payment_id: "dodo_pay_1" },
      makeNotifier()
    );
    assert.equal(stub2.calls.length, 0, "unhandled → no prisma work");
  });

  it("subscription.on_hold → PAST_DUE (via the dispatcher)", async () => {
    const stub = makePrisma(freshPayment(), freshSub({ planId: "PREMIUM" }));
    const svc = loadService(stub);
    await svc.provisionDodoWebhookEvent(
      "subscription.on_hold",
      { subscription_id: "dodo_sub_1" },
      makeNotifier()
    );
    assert.equal(
      (subUpdates(stub)[0].args as { data: { status: string } }).data.status,
      "PAST_DUE"
    );
  });

  it("subscription.cancelled (future term) schedules + notifies + moves segment", async () => {
    const stub = makePrisma(
      freshPayment(),
      freshSub({
        planId: "PREMIUM",
        endDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      })
    );
    const svc = loadService(stub);
    const notifier = makeNotifier();
    await svc.provisionDodoWebhookEvent(
      "subscription.cancelled",
      { subscription_id: "dodo_sub_1" },
      notifier
    );
    const data = (subUpdates(stub)[0].args as { data: Record<string, unknown> })
      .data;
    assert.equal(data.scheduledPlanId, "FREE");
    assert.deepEqual(
      notifier.calls.map((c) => c.method),
      ["subscriptionCancelled", "moveSegment"]
    );
    assert.equal(notifier.calls[1].input.to, "downgraded");
  });

  it("propagates a grant failure (payment.succeeded) so the route can 500", async () => {
    const stub = makePrisma(freshPayment(), freshSub(), { failUpsert: true });
    const svc = loadService(stub);
    await assert.rejects(() =>
      svc.provisionDodoWebhookEvent(
        "payment.succeeded",
        { payment_id: "dodo_pay_1" },
        makeNotifier()
      )
    );
  });
});

// ── callback entry ──────────────────────────────────────────────────────────

describe("provisionPaymentCallbackGrant (payments transport)", () => {
  it("PRO grant → 'granted' with one upsert", async () => {
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    const outcome = await svc.provisionPaymentCallbackGrant({
      payment: {
        id: "pay_1",
        userId: "user_1",
        planId: "PRO",
        planName: "PRO",
        period: "one-time",
        status: "COMPLETED",
        metadata: {},
      },
    });
    assert.equal(outcome, "granted");
    assert.equal(upserts(stub).length, 1);
  });

  it("QUERY_PACK with no subscription → 'addon_ineligible', no claim burned", async () => {
    const stub = makePrisma(freshPayment({ planId: "QUERY_PACK" }), null);
    const svc = loadService(stub);
    const outcome = await svc.provisionPaymentCallbackGrant({
      payment: {
        id: "pay_1",
        userId: "user_1",
        planId: "QUERY_PACK",
        planName: "AI Query Pack",
        period: "one-time",
        status: "COMPLETED",
        metadata: {},
      },
    });
    assert.equal(outcome, "addon_ineligible");
    assert.equal(claims(stub).length, 0);
    assert.equal(upserts(stub).length, 0);
  });

  it("[guard] non-COMPLETED payment → 'not_completed', no claim consumed, no grant", async () => {
    // MONEY-1062 review (F6): the exported seam re-asserts the route's status
    // guard instead of trusting it — an unpaid row must never reach the claim.
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    const outcome = await svc.provisionPaymentCallbackGrant({
      payment: {
        id: "pay_1",
        userId: "user_1",
        planId: "PRO",
        planName: "PRO",
        period: "one-time",
        status: "PENDING",
        metadata: {},
      },
    });
    assert.equal(outcome, "not_completed");
    assert.equal(claims(stub).length, 0, "no claim consumed");
    assert.equal(upserts(stub).length, 0, "no grant applied");
    assert.equal(stub.calls.length, 0, "no DB work at all");
  });
});

// ── missing-id / missing-payload guards (MONEY-1062 review) ─────────────────

describe("undefined-id and no-data guards (Prisma drops undefined filters)", () => {
  it("[guard] missing payment_id → completed/failed/refund handlers skip all DB work", async () => {
    // Without the guard, findFirst({ where: { dodoPaymentId: undefined } })
    // matches the FIRST Payment row (Prisma drops undefined filter values).
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    const notifier = makeNotifier();
    await svc.provisionPaymentCompleted({}, notifier);
    await svc.provisionPaymentFailed(
      { error_message: "card declined" },
      notifier
    );
    await svc.provisionRefundSucceeded({});
    assert.equal(stub.calls.length, 0, "no prisma call without a payment_id");
    assert.equal(
      notifier.calls.length,
      0,
      "no notification without a payment_id"
    );
  });

  it("[guard] missing data payload → dispatcher acks without action (no throw, no DB)", async () => {
    // A signed envelope with no `data` used to throw on destructure → 500 →
    // endless Dodo redelivery. It must ack and do nothing.
    const stub = makePrisma(freshPayment(), freshSub());
    const svc = loadService(stub);
    await svc.provisionDodoWebhookEvent(
      "payment.succeeded",
      undefined,
      makeNotifier()
    );
    await svc.provisionDodoWebhookEvent(
      "subscription.cancelled",
      null,
      makeNotifier()
    );
    assert.equal(stub.calls.length, 0, "no prisma work without a data payload");
  });
});
