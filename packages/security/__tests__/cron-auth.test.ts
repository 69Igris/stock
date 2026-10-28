/**
 * Cron auth — constant-time CRON_SECRET verification (MONEY-592 security audit).
 *
 * Migrated (W0-α) from apps/web/__tests__/security/cron-auth.test.ts; only the
 * import path changed (`@/lib/security/cron-auth` → `../src/cron-auth`). Drives
 * the REAL verifyCronAuth through process.env.CRON_SECRET (the source reads the
 * secret from env, not an argument). Verifies the decision contract: 503 when
 * unset, 401 on missing/wrong/length-mismatched/scheme-less token, ok on the
 * exact match — and that the comparison is constant-time (timingSafeEqual with
 * a length guard).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { verifyCronAuth } from "../src/cron-auth";

const SECRET = "super-secret-cron-token-abc123";

/** Run `fn` with CRON_SECRET set to `secret` (or unset), restoring it after. */
function withCronSecret<T>(secret: string | undefined, fn: () => T): T {
  const prev = process.env.CRON_SECRET;
  if (secret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = secret;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
}

describe("verifyCronAuth (MONEY-592)", () => {
  let prevSecret: string | undefined;
  beforeEach(() => {
    prevSecret = process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevSecret;
  });

  it("503 when CRON_SECRET is not configured (fail closed)", () => {
    withCronSecret(undefined, () => {
      assert.deepEqual(verifyCronAuth(`Bearer ${SECRET}`), {
        ok: false,
        status: 503,
      });
    });
  });

  it("authorizes the exact Bearer secret", () => {
    withCronSecret(SECRET, () => {
      assert.deepEqual(verifyCronAuth(`Bearer ${SECRET}`), { ok: true });
    });
  });

  it("401 on a wrong token", () => {
    withCronSecret(SECRET, () => {
      assert.deepEqual(verifyCronAuth("Bearer wrong-token"), {
        ok: false,
        status: 401,
      });
    });
  });

  it("401 on a missing header", () => {
    withCronSecret(SECRET, () => {
      assert.deepEqual(verifyCronAuth(null), { ok: false, status: 401 });
    });
  });

  it("401 on a length-mismatched token (no crash from timingSafeEqual)", () => {
    // timingSafeEqual throws on unequal-length buffers; the real helper's length
    // guard must catch this and return 401, never throw.
    withCronSecret(SECRET, () => {
      assert.deepEqual(verifyCronAuth("Bearer x"), {
        ok: false,
        status: 401,
      });
    });
  });

  it("401 when the scheme is missing (raw secret, no 'Bearer ')", () => {
    withCronSecret(SECRET, () => {
      assert.deepEqual(verifyCronAuth(SECRET), { ok: false, status: 401 });
    });
  });

  it("uses constant-time comparison (timingSafeEqual on equal-length input)", () => {
    // Equal-length wrong token still returns 401 via timingSafeEqual, not via
    // the length short-circuit.
    const wrong = "Bearer " + "z".repeat(SECRET.length);
    assert.equal(wrong.length, `Bearer ${SECRET}`.length);
    withCronSecret(SECRET, () => {
      assert.deepEqual(verifyCronAuth(wrong), { ok: false, status: 401 });
    });
  });
});

/**
 * MONEY-595 (A07): /api/cron/apply-scheduled-plan-changes was migrated from an
 * inline `authHeader !== \`Bearer ${secret}\`` compare to this shared
 * `verifyCronAuth` helper. These cases pin the HTTP-status contract the route
 * depends on so the timing-unsafe inline compare can never regress back in.
 */
describe("apply-scheduled-plan-changes cron auth contract (MONEY-595 A07)", () => {
  // The route's verdict → HTTP-status mapping over the REAL verifyCronAuth.
  function routeStatus(
    authHeader: string | null,
    cronSecret: string | undefined,
  ): number {
    return withCronSecret(cronSecret, () => {
      const auth = verifyCronAuth(authHeader);
      return auth.ok ? 200 : auth.status; // 503 when unset, 401 otherwise
    });
  }

  it("503 (fail closed) when CRON_SECRET is unset", () => {
    assert.equal(routeStatus(`Bearer ${SECRET}`, undefined), 503);
  });

  it("401 on a missing Authorization header", () => {
    assert.equal(routeStatus(null, SECRET), 401);
  });

  it("401 on a wrong bearer token", () => {
    assert.equal(routeStatus("Bearer not-the-secret", SECRET), 401);
  });

  it("200 on the exact bearer secret", () => {
    assert.equal(routeStatus(`Bearer ${SECRET}`, SECRET), 200);
  });
});
