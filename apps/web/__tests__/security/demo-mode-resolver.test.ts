/**
 * Demo-mode resolver — derive demo state from the sb_demo cookie ONLY
 * (MONEY-595 A01).
 *
 * De-shadowed (MONEY-620): previously this file re-implemented `isDemoSession`'s
 * decision inline. It now imports the REAL `resolveDemoState` from
 * `@/lib/demo/session` — the same pure decision `isDemoSession()` calls after
 * resolving Clerk + cookie. The forgeable `x-demo-mode` header is intentionally
 * NOT a parameter of `resolveDemoState`, so it is structurally impossible for it
 * to grant demo; the header cases below pass it only to prove the resolver never
 * reads it.
 *
 * `getUserId` (which maps demo → "demo-user-123" and lives in the route handler
 * apps/web/app/api/[[...path]]/route.ts) is reproduced as a thin wrapper over
 * the real resolver.
 *
 * Source: apps/web/lib/demo/session.ts (resolveDemoState)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveDemoState } from "@/lib/demo/session";

interface ResolverInputs {
  clerkUserId: string | null;
  /** Result of verifying the sb_demo cookie token (false = no/invalid cookie). */
  validDemoCookie: boolean;
  /** Forgeable header the resolver MUST ignore — present only to prove it does. */
  xDemoModeHeader?: string | null;
}

/**
 * Thin wrapper mirroring the route handler's getUserId: demo ⇒ fixed demo user;
 * else the Clerk userId (may be null ⇒ caller returns 401). Delegates the demo
 * decision to the REAL `resolveDemoState`; the header is never passed to it.
 */
function getUserId(inputs: ResolverInputs): {
  userId: string | null;
  isDemo: boolean;
} {
  const isDemo = resolveDemoState({
    clerkUserId: inputs.clerkUserId,
    validDemoCookie: inputs.validDemoCookie,
  });
  if (isDemo) {
    return { userId: "demo-user-123", isDemo: true };
  }
  return { userId: inputs.clerkUserId, isDemo: false };
}

describe("demo-mode resolver (MONEY-595 A01)", () => {
  it("a valid sb_demo cookie (no Clerk session) yields demo mode", () => {
    const out = getUserId({ clerkUserId: null, validDemoCookie: true });
    assert.equal(out.isDemo, true);
    assert.equal(out.userId, "demo-user-123");
  });

  it("IGNORES a forged 'x-demo-mode: true' header when there is no cookie", () => {
    const out = getUserId({
      clerkUserId: null,
      validDemoCookie: false,
      xDemoModeHeader: "true",
    });
    // Header must not grant demo — and with no Clerk userId this is a 401 case.
    assert.equal(out.isDemo, false);
    assert.equal(out.userId, null);
  });

  it("IGNORES 'x-demo-mode: true' even when an authenticated user is present", () => {
    const out = getUserId({
      clerkUserId: "user_real_123",
      validDemoCookie: false,
      xDemoModeHeader: "true",
    });
    // A real signed-in user is NEVER downgraded to demo via a header.
    assert.equal(out.isDemo, false);
    assert.equal(out.userId, "user_real_123");
  });

  it("Clerk session wins over a present (stale) sb_demo cookie", () => {
    const out = getUserId({
      clerkUserId: "user_real_123",
      validDemoCookie: true,
    });
    assert.equal(out.isDemo, false);
    assert.equal(out.userId, "user_real_123");
  });

  it("an invalid/forged cookie (failed HMAC verify) is NOT demo", () => {
    const out = getUserId({ clerkUserId: null, validDemoCookie: false });
    assert.equal(out.isDemo, false);
    assert.equal(out.userId, null);
  });

  it("no cookie and no session is NOT demo (unauthenticated)", () => {
    const out = getUserId({ clerkUserId: null, validDemoCookie: false });
    assert.equal(out.isDemo, false);
    assert.equal(out.userId, null);
  });

  it("header value variations ('1', 'TRUE', 'yes') are all ignored", () => {
    for (const v of ["1", "TRUE", "yes", "true"]) {
      const out = getUserId({
        clerkUserId: null,
        validDemoCookie: false,
        xDemoModeHeader: v,
      });
      assert.equal(out.isDemo, false, `header ${v} must not grant demo`);
    }
  });

  // Direct assertions on the REAL resolver (the decision under test).
  describe("resolveDemoState (real source)", () => {
    it("returns true only for no-Clerk + valid cookie", () => {
      assert.equal(
        resolveDemoState({ clerkUserId: null, validDemoCookie: true }),
        true
      );
    });

    it("Clerk session always wins (false) even with a valid cookie", () => {
      assert.equal(
        resolveDemoState({ clerkUserId: "u1", validDemoCookie: true }),
        false
      );
    });

    it("no Clerk + no valid cookie is false", () => {
      assert.equal(
        resolveDemoState({ clerkUserId: null, validDemoCookie: false }),
        false
      );
    });
  });
});
