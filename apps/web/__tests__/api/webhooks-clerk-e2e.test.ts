/**
 * MONEY-620 — Clerk webhook END-TO-END (real POST, real svix, recording stubs).
 *
 * The sibling `clerk-webhook.test.ts` is a CONTRACT test over the route's pure
 * helpers + the `svix` library in isolation; it never imports the route's
 * `POST`. This file imports the REAL exported `POST` from
 * `app/api/webhooks/clerk/route.ts`, signs a payload with the REAL `svix`
 * `Webhook`, drives a real `Request` through it, and asserts the actual
 * user-sync side-effects:
 *
 *   1. user.created → calls `ensureUserAndSubscription({ clerkId, email, name })`
 *      with the email/name resolved from the Clerk payload, returns 200.
 *   2. user.deleted (User row already gone) → idempotent no-op cleanup: resolves
 *      the user by clerkId, finds nothing, returns 200 WITHOUT a hard delete.
 *      This is the expected path after a server-side account deletion.
 *   3. user.deleted with an in-flight DeletedUserAudit row → ignored (the
 *      account-deletion worker owns the lifecycle), returns 200, never queries
 *      the user table.
 *   4. An invalid signature is rejected (400) before any handler runs.
 *
 * Mocking seam: the route reads its svix headers via `next/headers` `headers()`
 * (Next request async-context, unavailable in a plain `node --test`), so we
 * inject a `next/headers` stub returning our header bag. prisma (`@/lib/prisma`),
 * `@usemoney/services` (ensureUserAndSubscription), `@usemoney/email`,
 * `@usemoney/email/templates`, `@usemoney/core` (clearAllUserCache) and the
 * pub/sub publisher are stubbed via `require.cache` (pattern from
 * `demo-routes-branches.test.ts`). `svix.Webhook` is NEVER mocked.
 *
 * NOTE ON user.deleted DB grant: the route's *legacy* hard-delete branch does
 * `const { hardDeleteUser } = await import("@usemoney/services")` — a DYNAMIC
 * import that bypasses `require.cache`, so it would load the REAL service and
 * hit Mongo. We therefore assert the deletion-cleanup *decision* paths (already-
 * gone no-op + in-flight-ignored) which are the realistically-drivable, security-
 * relevant branches and never reach that dynamic import. See the report.
 *
 * Runs under the default `node --import tsx --test` (CJS) — no experimental flag.
 *
 * Source: apps/web/app/api/webhooks/clerk/route.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Webhook } from "svix";

const TEST_SECRET =
  "whsec_" + Buffer.from("clerk-e2e-signing-secret").toString("base64");
process.env.CLERK_WEBHOOK_SECRET = TEST_SECRET;

// ── recording stubs ─────────────────────────────────────────────────────────

interface Recorder {
  ensureCalls: Array<{ clerkId: string; email: string; name: string }>;
  prismaCalls: string[];
}

interface PrismaShape {
  userFindFirstResult: {
    id: string;
    email: string;
    name: string;
    subscription: unknown;
  } | null;
  auditInFlight: boolean;
}

function makeStubs(shape: PrismaShape) {
  const rec: Recorder = { ensureCalls: [], prismaCalls: [] };

  const servicesExports = {
    __esModule: true,
    ensureUserAndSubscription: (a: {
      clerkId: string;
      email: string;
      name: string;
    }) => {
      rec.ensureCalls.push(a);
      return Promise.resolve({
        success: true,
        data: {
          // lastResendSyncAt set → skip the Resend onboarding branch entirely.
          user: { id: "db_user_1", lastResendSyncAt: new Date() },
          created: { user: true, subscription: true },
        },
      });
    },
    // Present so the *static* import resolves; the route reaches the legacy
    // hard-delete via a DYNAMIC import (not covered by these tests).
    hardDeleteUser: () =>
      Promise.resolve({
        success: false,
        error: "hardDeleteUser must not be reached in these tests",
      }),
  };

  const prismaStub = {
    deletedUserAudit: {
      findFirst: () => {
        rec.prismaCalls.push("deletedUserAudit.findFirst");
        return Promise.resolve(shape.auditInFlight ? { id: "audit_1" } : null);
      },
    },
    user: {
      findFirst: () => {
        rec.prismaCalls.push("user.findFirst");
        return Promise.resolve(shape.userFindFirstResult);
      },
      update: () => {
        rec.prismaCalls.push("user.update");
        return Promise.resolve({});
      },
      // Welcome-email idempotency claim (MONEY-NEW). Existing cases set
      // lastResendSyncAt so the onboarding branch is skipped and this isn't
      // reached; present so the path is safe if a future case exercises it.
      updateMany: () => {
        rec.prismaCalls.push("user.updateMany");
        return Promise.resolve({ count: 1 });
      },
    },
    subscription: {
      findUnique: () => {
        rec.prismaCalls.push("subscription.findUnique");
        return Promise.resolve(null);
      },
    },
  };

  return { rec, servicesExports, prismaStub };
}

// ── require.cache injection ─────────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ROUTE_REL = "../../app/api/webhooks/clerk/route";

interface ClerkRouteModule {
  POST: (req: Request) => Promise<Response>;
}

// Mutable holder so the injected next/headers stub returns the per-request bag.
let currentHeaders: Headers = new Headers();

function loadRouteWithStubs(
  stubs: ReturnType<typeof makeStubs>
): ClerkRouteModule {
  const cache = moduleCache();
  const prismaPath = require.resolve("../../lib/prisma");
  const nhPath = require.resolve("next/headers");
  const servicesPath = require.resolve("@usemoney/services");
  const emailPath = require.resolve("@usemoney/email");
  const emailTplPath = require.resolve("@usemoney/email/templates");
  const corePath = require.resolve("@usemoney/core");
  const pubsubPath = require.resolve("@usemoney/pubsub/publish");
  const routePath = require.resolve(ROUTE_REL);

  cache[prismaPath] = {
    exports: {
      __esModule: true,
      prisma: stubs.prismaStub,
      default: stubs.prismaStub,
    },
  };
  cache[nhPath] = {
    exports: {
      __esModule: true,
      headers: () => Promise.resolve(currentHeaders),
    },
  };
  cache[servicesPath] = { exports: stubs.servicesExports };
  cache[emailPath] = {
    exports: {
      __esModule: true,
      sendEmail: () => Promise.resolve({ success: true }),
      addContactToSegment: () => Promise.resolve({ success: true }),
      removeContactFromSegment: () => Promise.resolve(),
      RESEND_AUDIENCE_FREE_ID: "aud_free",
    },
  };
  cache[emailTplPath] = {
    exports: {
      __esModule: true,
      WelcomeEmail: () => null,
      AccountDeletedEmail: () => null,
    },
  };
  cache[corePath] = {
    exports: { __esModule: true, clearAllUserCache: () => Promise.resolve() },
  };
  cache[pubsubPath] = {
    exports: {
      __esModule: true,
      publishLoginBriefingJob: () => Promise.resolve(),
    },
  };

  delete cache[routePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ROUTE_REL) as ClerkRouteModule;
}

// ── request builder (real svix signature) ───────────────────────────────────

const wh = new Webhook(TEST_SECRET);

function makeSignedRequest(
  eventBody: unknown,
  opts: { tamperSignature?: boolean } = {}
): Request {
  const body = JSON.stringify(eventBody);
  const ts = Math.floor(Date.now() / 1000);
  const msgId = "msg_clerk_e2e";
  const signature = opts.tamperSignature
    ? "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    : wh.sign(msgId, new Date(ts * 1000), body);
  currentHeaders = new Headers({
    "svix-id": msgId,
    "svix-timestamp": String(ts),
    "svix-signature": signature,
    "content-type": "application/json",
  });
  return new Request("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: currentHeaders,
    body,
  });
}

function userCreatedEvent() {
  return {
    type: "user.created",
    object: "event",
    data: {
      id: "user_clerk_e2e",
      email_addresses: [
        { email_address: "newuser@example.com", id: "email_primary" },
      ],
      primary_email_address_id: "email_primary",
      first_name: "New",
      last_name: "User",
    },
  };
}

function userDeletedEvent() {
  return {
    type: "user.deleted",
    object: "event",
    data: { id: "user_clerk_e2e", deleted: true },
  };
}

describe("MONEY-620 — Clerk webhook end-to-end (real POST + real svix)", () => {
  describe("user.created → internal user upsert", () => {
    it("calls ensureUserAndSubscription with the resolved clerkId/email/name and returns 200", async () => {
      const stubs = makeStubs({
        userFindFirstResult: null,
        auditInFlight: false,
      });
      const route = loadRouteWithStubs(stubs);

      const res = await route.POST(makeSignedRequest(userCreatedEvent()));

      assert.equal(res.status, 200);
      assert.equal(await res.text(), "Success");

      assert.equal(
        stubs.rec.ensureCalls.length,
        1,
        "the internal user+subscription sync must run exactly once"
      );
      assert.deepEqual(stubs.rec.ensureCalls[0], {
        clerkId: "user_clerk_e2e",
        email: "newuser@example.com",
        name: "New User",
      });
    });
  });

  describe("user.deleted → idempotent cleanup decision", () => {
    it("no-ops (200) when the User row is already gone (server-side delete already ran)", async () => {
      const stubs = makeStubs({
        userFindFirstResult: null, // already deleted
        auditInFlight: false,
      });
      const route = loadRouteWithStubs(stubs);

      const res = await route.POST(makeSignedRequest(userDeletedEvent()));

      assert.equal(res.status, 200);
      // It resolved the user by clerkId (the lookup ran)...
      assert.ok(
        stubs.rec.prismaCalls.includes("user.findFirst"),
        "expected the clerkId → user lookup"
      );
      // ...and did NOT mutate anything (idempotent no-op).
      assert.ok(
        !stubs.rec.prismaCalls.includes("user.update"),
        "an already-gone user must not trigger writes"
      );
    });

    it("ignores the event (200) when a deletion is already in flight, without touching the user table", async () => {
      const stubs = makeStubs({
        userFindFirstResult: {
          id: "db_user_1",
          email: "x@y.com",
          name: "X",
          subscription: { id: "s1" },
        },
        auditInFlight: true, // worker pipeline owns the lifecycle
      });
      const route = loadRouteWithStubs(stubs);

      const res = await route.POST(makeSignedRequest(userDeletedEvent()));

      assert.equal(res.status, 200);
      // The in-flight audit short-circuits BEFORE the user lookup.
      assert.ok(
        stubs.rec.prismaCalls.includes("deletedUserAudit.findFirst"),
        "expected the in-flight deletion check"
      );
      assert.ok(
        !stubs.rec.prismaCalls.includes("user.findFirst"),
        "must bail out before resolving / deleting the user"
      );
    });
  });

  describe("signature rejection", () => {
    it("returns 400 for an invalid signature and runs no handler", async () => {
      const stubs = makeStubs({
        userFindFirstResult: null,
        auditInFlight: false,
      });
      const route = loadRouteWithStubs(stubs);

      const res = await route.POST(
        makeSignedRequest(userCreatedEvent(), { tamperSignature: true })
      );

      assert.equal(res.status, 400);
      assert.equal(
        stubs.rec.ensureCalls.length,
        0,
        "a rejected signature must not run the user sync"
      );
    });
  });
});
