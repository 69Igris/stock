/**
 * Payments callback route THIN-TRANSPORT tests — MONEY-1062 (W1-B).
 *
 * After the W1-B extraction the callback route owns only the browser-return
 * transport: param validation, loading the Payment row, resolving PENDING→
 * COMPLETED/FAILED via the Dodo `payments.retrieve` poll, the MONEY-587 ownership
 * guard, plan validation, and mapping the grant OUTCOME to a redirect. The grant
 * itself (claim-once, subscription write) is `@usemoney/services`
 * `provisionPaymentCallbackGrant`, contract-tested in the service suites.
 *
 * So this file drives the REAL `GET` with the grant service STUBBED as a spy and
 * asserts the transport contract:
 *   1. COMPLETED + owner → service invoked, "granted"/"already_applied" → success;
 *   2. ownership mismatch / no auth → payment_forbidden, service NEVER called;
 *   3. FAILED → payment_failed, no grant; missing params → no DB;
 *   4. "addon_ineligible" outcome → addon_requires_pro_or_unlimited redirect;
 *   5. PENDING → Dodo poll resolves succeeded → grant → success;
 *   6. a service throw → callback_failed.
 *
 * The REAL `@usemoney/core/subscription` (resolvePlanId + PLAN_CONFIG) backs the
 * plan-validation guard; only the network `dodoClient` is stubbed.
 *
 * Source: apps/web/app/api/payments/callback/route.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = "https://usemoney.ai";
process.env.NEXT_PUBLIC_BASE_URL = BASE_URL;

interface PaymentRow {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  period: string;
  status: string;
  paidAt: Date | null;
  metadata: Record<string, unknown>;
  dodoPaymentId: string | null;
}

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

function makePrisma(payment: PaymentRow) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    payment: {
      findUnique: (args: unknown) => {
        calls.push({ model: "payment", method: "findUnique", args });
        return Promise.resolve(payment);
      },
      update: (args: unknown) => {
        calls.push({ model: "payment", method: "update", args });
        return Promise.resolve(payment);
      },
    },
  };
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ROUTE_REL = "../../app/api/payments/callback/route";
interface CallbackRouteModule {
  GET: (req: unknown) => Promise<Response>;
}

function loadRoute(opts: {
  stub: ReturnType<typeof makePrisma>;
  authUser: { userId: string } | null;
  dodoStatus?: "succeeded" | "failed" | "cancelled" | "processing";
  outcome?:
    | "granted"
    | "already_applied"
    | "addon_ineligible"
    | "not_completed";
  throwOnGrant?: boolean;
}): { route: CallbackRouteModule; grantCalls: unknown[] } {
  const cache = moduleCache();
  const grantCalls: unknown[] = [];
  const prismaPath = require.resolve("../../lib/prisma");
  const authPath = require.resolve("../../lib/auth");
  const corePayPath = require.resolve("@usemoney/core/payments");
  const servicesPath = require.resolve("@usemoney/services");
  const routePath = require.resolve(ROUTE_REL);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realCorePay = require("@usemoney/core/payments") as Record<
    string,
    unknown
  >;

  cache[prismaPath] = {
    exports: { __esModule: true, prisma: opts.stub, default: opts.stub },
  };
  cache[authPath] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () => Promise.resolve(opts.authUser),
    },
  };
  cache[corePayPath] = {
    exports: {
      ...realCorePay,
      dodoClient: {
        payments: {
          retrieve: () =>
            Promise.resolve({ status: opts.dodoStatus ?? "succeeded" }),
        },
        subscriptions: { update: () => Promise.resolve({}) },
      },
    },
  };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      provisionPaymentCallbackGrant: async (input: unknown) => {
        grantCalls.push(input);
        if (opts.throwOnGrant) throw new Error("simulated grant failure");
        return opts.outcome ?? "granted";
      },
    },
  };
  delete cache[routePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { route: require(ROUTE_REL) as CallbackRouteModule, grantCalls };
}

function makeGetRequest(params: Record<string, string>): unknown {
  const url = new URL(`${BASE_URL}/api/payments/callback`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(url, { method: "GET" });
}

function completedPro(over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: "pay_cb_1",
    userId: "user_cb_1",
    planId: "PRO",
    planName: "PRO",
    period: "one-time",
    status: "COMPLETED",
    paidAt: new Date(),
    metadata: {},
    dodoPaymentId: "dodo_cb_1",
    ...over,
  };
}

const location = (res: Response) => res.headers.get("location") ?? "";

describe("Payments callback route — thin transport (grant service stubbed)", () => {
  it("COMPLETED + owner → invokes the grant service and redirects to success", async () => {
    const stub = makePrisma(completedPro());
    const { route, grantCalls } = loadRoute({
      stub,
      authUser: { userId: "user_cb_1" },
    });
    const res = await route.GET(
      makeGetRequest({ paymentId: "pay_cb_1", planId: "PRO" })
    );
    assert.equal(res.status, 307);
    assert.equal(
      location(res),
      `${BASE_URL}/settings?tab=subscription&success=payment_complete`
    );
    assert.equal(grantCalls.length, 1, "grant service invoked once");
    // The grant is handed the paid Payment fields (verified plan derives inside).
    const input = grantCalls[0] as {
      payment: { id: string; planId: string; status: string };
    };
    assert.equal(input.payment.id, "pay_cb_1");
    assert.equal(input.payment.planId, "PRO");
    // MONEY-1062 review (F6): the route hands the service the row's status so
    // the service can re-assert the COMPLETED guard.
    assert.equal(input.payment.status, "COMPLETED");
  });

  it("'already_applied' outcome also lands on the success page", async () => {
    const stub = makePrisma(completedPro());
    const { route } = loadRoute({
      stub,
      authUser: { userId: "user_cb_1" },
      outcome: "already_applied",
    });
    const res = await route.GET(
      makeGetRequest({ paymentId: "pay_cb_1", planId: "PRO" })
    );
    assert.match(location(res), /success=payment_complete$/);
  });

  it("'addon_ineligible' outcome → addon_requires_pro_or_unlimited redirect", async () => {
    const stub = makePrisma(completedPro({ planId: "QUERY_PACK" }));
    const { route } = loadRoute({
      stub,
      authUser: { userId: "user_cb_1" },
      outcome: "addon_ineligible",
    });
    const res = await route.GET(
      makeGetRequest({ paymentId: "pay_cb_1", planId: "QUERY_PACK" })
    );
    assert.match(
      location(res),
      /\/pricing\?error=addon_requires_pro_or_unlimited$/
    );
  });

  it("'not_completed' outcome → payment_not_verified redirect (F6 seam guard)", async () => {
    // The service re-asserts the COMPLETED guard; if it ever fires, the route
    // must map it to the existing not-verified redirect, not the success page.
    const stub = makePrisma(completedPro());
    const { route } = loadRoute({
      stub,
      authUser: { userId: "user_cb_1" },
      outcome: "not_completed",
    });
    const res = await route.GET(
      makeGetRequest({ paymentId: "pay_cb_1", planId: "PRO" })
    );
    assert.match(location(res), /\/pricing\?error=payment_not_verified$/);
  });

  it("ownership mismatch → payment_forbidden and the grant is NEVER called", async () => {
    const stub = makePrisma(completedPro());
    const { route, grantCalls } = loadRoute({
      stub,
      authUser: { userId: "attacker_user" },
    });
    // Even a forged planId=PREMIUM in the URL must not matter.
    const res = await route.GET(
      makeGetRequest({ paymentId: "pay_cb_1", planId: "PREMIUM" })
    );
    assert.match(location(res), /\/pricing\?error=payment_forbidden$/);
    assert.equal(grantCalls.length, 0, "no grant on ownership failure");
  });

  it("no authenticated user → payment_forbidden", async () => {
    const stub = makePrisma(completedPro());
    const { route, grantCalls } = loadRoute({ stub, authUser: null });
    const res = await route.GET(
      makeGetRequest({ paymentId: "pay_cb_1", planId: "PRO" })
    );
    assert.match(location(res), /\/pricing\?error=payment_forbidden$/);
    assert.equal(grantCalls.length, 0);
  });

  it("FAILED payment → payment_failed and no grant", async () => {
    const stub = makePrisma(completedPro({ status: "FAILED" }));
    const { route, grantCalls } = loadRoute({
      stub,
      authUser: { userId: "user_cb_1" },
    });
    const res = await route.GET(
      makeGetRequest({ paymentId: "pay_cb_1", planId: "PRO" })
    );
    assert.match(location(res), /\/pricing\?error=payment_failed$/);
    assert.equal(grantCalls.length, 0);
  });

  it("missing paymentId → invalid_params with no DB work", async () => {
    const stub = makePrisma(completedPro());
    const { route } = loadRoute({ stub, authUser: { userId: "user_cb_1" } });
    const res = await route.GET(makeGetRequest({ planId: "PRO" }));
    assert.match(location(res), /\/pricing\?error=invalid_params$/);
    assert.equal(stub.calls.length, 0, "no DB touch without required params");
  });

  it("PENDING payment → Dodo poll resolves succeeded → grant → success", async () => {
    const stub = makePrisma(completedPro({ status: "PENDING", paidAt: null }));
    const { route, grantCalls } = loadRoute({
      stub,
      authUser: { userId: "user_cb_1" },
      dodoStatus: "succeeded",
    });
    const res = await route.GET(
      makeGetRequest({ paymentId: "pay_cb_1", planId: "PRO" })
    );
    assert.match(location(res), /success=payment_complete$/);
    assert.equal(grantCalls.length, 1);
    // The poll persisted the COMPLETED status.
    const statusUpdate = stub.calls.find(
      (c) =>
        c.model === "payment" &&
        c.method === "update" &&
        (c.args as { data: { status?: string } }).data.status === "COMPLETED"
    );
    assert.ok(statusUpdate, "poll persisted COMPLETED");
  });

  it("a grant service throw → callback_failed redirect", async () => {
    const stub = makePrisma(completedPro());
    const { route } = loadRoute({
      stub,
      authUser: { userId: "user_cb_1" },
      throwOnGrant: true,
    });
    const res = await route.GET(
      makeGetRequest({ paymentId: "pay_cb_1", planId: "PRO" })
    );
    assert.match(location(res), /\/pricing\?error=callback_failed$/);
  });
});
