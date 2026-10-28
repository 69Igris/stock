/**
 * Dodo webhook route THIN-TRANSPORT tests — MONEY-1062 (W1-B).
 *
 * After the W1-B extraction the webhook route is pure transport: resolve the
 * `webhook-*`/`svix-*` headers, verify the signature with the REAL `svix`
 * library, parse the envelope, and hand `(event, data, notifier)` to
 * `@usemoney/services` `provisionDodoWebhookEvent`. The grant behaviour (claim-
 * once, grant shape, lifecycle) now lives in the package and is contract-tested in
 * payment-provisioning-service.test.ts / subscription-grants-service.test.ts.
 *
 * So this file asserts ONLY the route's transport contract, with the service
 * STUBBED as a spy:
 *   1. a correctly-signed event → 200 { received: true } and the service is
 *      invoked with the parsed event type + data;
 *   2. `payload.type` wins over the legacy `payload.event` alias;
 *   3. an invalid signature → 401 and the service is NEVER called;
 *   4. missing signature headers → 400;
 *   5. a service throw (grant failure) → 500 (so Dodo retries).
 *
 * `svix.Webhook` is NEVER mocked — signatures are real.
 *
 * Source: apps/web/app/api/webhooks/dodo/route.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Webhook } from "svix";

// The route reads DODO_WEBHOOK_SECRET at MODULE LOAD, so set it before require().
const TEST_SECRET =
  "whsec_" + Buffer.from("dodo-e2e-signing-secret").toString("base64");
process.env.DODO_WEBHOOK_SECRET = TEST_SECRET;

interface ProvisionCall {
  event: string | undefined;
  data: unknown;
  hasNotifier: boolean;
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ROUTE_REL = "../../app/api/webhooks/dodo/route";
interface DodoRouteModule {
  POST: (req: unknown) => Promise<Response>;
}

/** Inject a spy `provisionDodoWebhookEvent` + no-op email package, then load a
 * fresh copy of the route. */
function loadRoute(opts: { throwOnProvision?: boolean } = {}): {
  route: DodoRouteModule;
  calls: ProvisionCall[];
} {
  const cache = moduleCache();
  const calls: ProvisionCall[] = [];
  const servicesPath = require.resolve("@usemoney/services");
  const emailPath = require.resolve("@usemoney/email");
  const emailTplPath = require.resolve("@usemoney/email/templates");
  const routePath = require.resolve(ROUTE_REL);

  cache[servicesPath] = {
    exports: {
      __esModule: true,
      provisionDodoWebhookEvent: async (
        event: string | undefined,
        data: unknown,
        notifier: unknown
      ) => {
        calls.push({ event, data, hasNotifier: !!notifier });
        if (opts.throwOnProvision) throw new Error("simulated grant failure");
      },
    },
  };
  cache[emailPath] = {
    exports: {
      __esModule: true,
      sendEmail: () => Promise.resolve({ success: true }),
      moveContactToSegment: () => Promise.resolve(),
      getEffectivePreferences: () => ({}),
      shouldSendEmail: () => false,
      buildUnsubscribeUrl: () => "https://usemoney.ai/unsub",
    },
  };
  cache[emailTplPath] = {
    exports: {
      __esModule: true,
      PaymentSuccessEmail: () => null,
      PaymentFailedEmail: () => null,
      SubscriptionRenewedEmail: () => null,
      SubscriptionCancelledEmail: () => null,
    },
  };
  delete cache[routePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { route: require(ROUTE_REL) as DodoRouteModule, calls };
}

const wh = new Webhook(TEST_SECRET);

function makeSignedRequest(
  eventBody: unknown,
  opts: { tamperSignature?: boolean } = {}
): unknown {
  const body = JSON.stringify(eventBody);
  const ts = Math.floor(Date.now() / 1000);
  const msgId = "msg_dodo_e2e";
  const signature = opts.tamperSignature
    ? "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    : wh.sign(msgId, new Date(ts * 1000), body);
  const headers = new Headers({
    "webhook-id": msgId,
    "webhook-timestamp": String(ts),
    "webhook-signature": signature,
    "content-type": "application/json",
  });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest("http://localhost/api/webhooks/dodo", {
    method: "POST",
    headers,
    body,
  });
}

describe("Dodo webhook route — thin transport (real svix, service stubbed)", () => {
  before(() => {
    process.env.DODO_WEBHOOK_SECRET = TEST_SECRET;
  });

  it("a correctly-signed event → 200 { received: true } and invokes the service", async () => {
    const { route, calls } = loadRoute();
    const res = await route.POST(
      makeSignedRequest({
        business_id: "biz_e2e",
        type: "payment.succeeded",
        timestamp: "2026-07-10T00:00:00Z",
        data: { payment_id: "dodo_pay_e2e_1", payload_type: "Payment" },
      })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
    assert.equal(calls.length, 1, "provisioning service invoked exactly once");
    assert.equal(calls[0].event, "payment.succeeded");
    assert.deepEqual(calls[0].data, {
      payment_id: "dodo_pay_e2e_1",
      payload_type: "Payment",
    });
    assert.equal(calls[0].hasNotifier, true, "a notifier is passed in");
  });

  it("prefers payload.type over the legacy payload.event alias", async () => {
    const { route, calls } = loadRoute();
    await route.POST(
      makeSignedRequest({
        type: "subscription.renewed",
        event: "payment.completed", // legacy alias must be ignored
        data: { subscription_id: "dodo_sub_1" },
      })
    );
    assert.equal(calls[0].event, "subscription.renewed");
  });

  it("falls back to payload.event when type is absent (replay safety)", async () => {
    const { route, calls } = loadRoute();
    await route.POST(
      makeSignedRequest({
        event: "payment.completed",
        data: { payment_id: "dodo_pay_e2e_1" },
      })
    );
    assert.equal(calls[0].event, "payment.completed");
  });

  it("an invalid signature → 401 and the service is NEVER called", async () => {
    const { route, calls } = loadRoute();
    const res = await route.POST(
      makeSignedRequest(
        { type: "payment.succeeded", data: { payment_id: "x" } },
        { tamperSignature: true }
      )
    );
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /Invalid webhook signature/);
    assert.equal(calls.length, 0, "no provisioning on a bad signature");
  });

  it("missing signature headers → 400 and no service call", async () => {
    const { route, calls } = loadRoute();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NextRequest } = require("next/server");
    const req = new NextRequest("http://localhost/api/webhooks/dodo", {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ type: "payment.succeeded", data: {} }),
    });
    const res = await route.POST(req);
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  it("a service throw (grant failure) → 500 so Dodo retries", async () => {
    const { route } = loadRoute({ throwOnProvision: true });
    const res = await route.POST(
      makeSignedRequest({
        type: "payment.succeeded",
        data: { payment_id: "dodo_pay_e2e_1" },
      })
    );
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /Webhook processing failed/);
  });
});
