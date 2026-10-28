/**
 * Email-preferences unsubscribe END-TO-END test (real GET handler + real HMAC).
 *
 * Drives the REAL exported `GET` from
 * `app/api/email/preferences/unsubscribe/route.ts`, signing the unsubscribe
 * token with the REAL `generateUnsubscribeToken` from `@usemoney/email` (the
 * route verifies with the REAL `verifyUnsubscribeToken` — a timing-safe
 * HMAC-SHA256 over `email.toLowerCase().trim()`). Only `@/lib/prisma` is stubbed
 * (via the `require.cache` seam) so the database boundary is mocked but the
 * security-critical token contract is exercised for real.
 *
 * This pins the auth wire-format the way the writing-tests skill mandates for
 * external/security contracts: a correctly-signed token VERIFIES, and a tampered
 * token / wrong-email token / bad category is REJECTED before any DB write.
 *
 * (Replaces the previous SHADOW, which reimplemented the HMAC token derivation
 * AND the preferences-merge logic inline and asserted the copies — green even
 * if the real timing-safe verify drifted.)
 *
 * Source: apps/web/app/api/email/preferences/unsubscribe/route.ts
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";

// The email package reads EMAIL_UNSUBSCRIBE_SECRET at MODULE LOAD, so set it
// before anything requires `@usemoney/email`.
process.env.EMAIL_UNSUBSCRIBE_SECRET = "unsubscribe-e2e-secret-key";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ROUTE_REL = "../../app/api/email/preferences/unsubscribe/route";

interface RouteModule {
  GET: (req: unknown) => Promise<Response>;
}

interface UserRow {
  id: string;
  emailPreferences: Record<string, boolean> | null;
}

interface RecordedUpdate {
  where: { id: string };
  data: { emailPreferences: unknown };
}

let foundUser: UserRow | null = null;
let updates: RecordedUpdate[] = [];

function loadRoute(): RouteModule {
  const cache = moduleCache();
  const prismaPath = require.resolve("../../lib/prisma");
  const stub = {
    user: {
      findUnique: (args: { where: { email: string } }) => {
        // Mirror the route's `email.toLowerCase()` lookup expectation.
        void args;
        return Promise.resolve(foundUser);
      },
      update: (args: RecordedUpdate) => {
        updates.push(args);
        return Promise.resolve({ id: args.where.id });
      },
    },
  };
  cache[prismaPath] = {
    exports: { __esModule: true, prisma: stub, default: stub },
  };

  delete cache[require.resolve(ROUTE_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ROUTE_REL) as RouteModule;
}

// Sign with the REAL token generator (same secret the route verifies against).
function realToken(email: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateUnsubscribeToken } = require("@usemoney/email");
  return generateUnsubscribeToken(email) as string;
}

function makeRequest(params: {
  email?: string;
  token?: string;
  category?: string;
}): unknown {
  const sp = new URLSearchParams();
  if (params.email !== undefined) sp.set("email", params.email);
  if (params.token !== undefined) sp.set("token", params.token);
  if (params.category !== undefined) sp.set("category", params.category);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(
    `http://localhost/api/email/preferences/unsubscribe?${sp.toString()}`
  );
}

describe("Email unsubscribe GET (real handler + real HMAC)", () => {
  let route: RouteModule;

  before(() => {
    route = loadRoute();
  });

  afterEach(() => {
    foundUser = null;
    updates = [];
  });

  describe("parameter / token validation (400, no DB write)", () => {
    it("400 when parameters are missing", async () => {
      const res = await route.GET(makeRequest({}));
      assert.equal(res.status, 400);
      assert.equal(updates.length, 0);
    });

    it("400 for an invalid category even with a valid token", async () => {
      const email = "user@example.com";
      const res = await route.GET(
        makeRequest({ email, token: realToken(email), category: "hacking" })
      );
      assert.equal(res.status, 400);
      assert.equal(updates.length, 0);
    });

    it("400 for a tampered token (HMAC reject)", async () => {
      const email = "user@example.com";
      const good = realToken(email);
      const tampered = good.slice(0, -1) + (good.endsWith("a") ? "b" : "a");
      const res = await route.GET(
        makeRequest({ email, token: tampered, category: "marketingEmails" })
      );
      assert.equal(res.status, 400);
      assert.equal(updates.length, 0);
    });

    it("400 for a token signed for a DIFFERENT email", async () => {
      const res = await route.GET(
        makeRequest({
          email: "victim@example.com",
          token: realToken("attacker@example.com"),
          category: "marketingEmails",
        })
      );
      assert.equal(res.status, 400);
      assert.equal(updates.length, 0);
    });

    it("400 for a non-hex token string (verify swallows the throw)", async () => {
      const email = "user@example.com";
      const res = await route.GET(
        makeRequest({ email, token: "not-hex!!", category: "marketingEmails" })
      );
      assert.equal(res.status, 400);
      assert.equal(updates.length, 0);
    });
  });

  describe("valid token reaches the DB", () => {
    it("404 when the email is not in our records", async () => {
      const email = "ghost@example.com";
      foundUser = null;
      const res = await route.GET(
        makeRequest({ email, token: realToken(email), category: "tradeAlerts" })
      );
      assert.equal(res.status, 404);
      assert.equal(updates.length, 0);
    });

    it("200 + persists the unsubscribe (category flips to false)", async () => {
      const email = "user@example.com";
      foundUser = { id: "u1", emailPreferences: null }; // defaults: all true
      const res = await route.GET(
        makeRequest({
          email,
          token: realToken(email),
          category: "marketingEmails",
        })
      );
      assert.equal(res.status, 200);
      assert.equal(updates.length, 1);
      const prefs = updates[0].data.emailPreferences as Record<string, boolean>;
      assert.equal(prefs.marketingEmails, false);
    });

    it("200 (idempotent) when already unsubscribed, with NO further write", async () => {
      const email = "user@example.com";
      foundUser = {
        id: "u1",
        emailPreferences: { marketingEmails: false },
      };
      const res = await route.GET(
        makeRequest({
          email,
          token: realToken(email),
          category: "marketingEmails",
        })
      );
      assert.equal(res.status, 200);
      assert.equal(
        updates.length,
        0,
        "already-unsubscribed must not re-write the row"
      );
    });

    it("a valid token verifies regardless of email casing (lower/trim)", async () => {
      // Token is derived from email.toLowerCase().trim(); the route lower-cases
      // the lookup. A mixed-case email with the lower-cased token must verify.
      const lower = "mixed@example.com";
      foundUser = { id: "u2", emailPreferences: null };
      const res = await route.GET(
        makeRequest({
          email: "Mixed@Example.com",
          token: realToken(lower),
          category: "aiInsights",
        })
      );
      assert.equal(res.status, 200);
      assert.equal(updates.length, 1);
    });
  });

  describe("response is always HTML", () => {
    it("sets Content-Type text/html for the success page", async () => {
      const email = "user@example.com";
      foundUser = { id: "u1", emailPreferences: null };
      const res = await route.GET(
        makeRequest({ email, token: realToken(email), category: "tradeAlerts" })
      );
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      const text = await res.text();
      assert.match(text, /<!DOCTYPE html>/i);
    });
  });
});
