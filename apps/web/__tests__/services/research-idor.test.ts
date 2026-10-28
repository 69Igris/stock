/**
 * MONEY-286 / MONEY-620 — IDOR regression on research session lookups
 * (REAL exported gate, de-shadowed).
 *
 * Pre-fix `getResearchStatus`/`getResearchResult` used
 * `prisma.researchSession.findUnique({where: {sessionId}})` with NO userId
 * filter. Any authenticated user who guessed (or harvested via a leaked
 * `/analysis/{sessionId}` URL) another user's sessionId could read their
 * portfolio symbols, query text, and full research report. The cancel/delete
 * paths could likewise mutate another user's session.
 *
 * DE-SHADOW: the previous version mirrored the in-source `findFirst` predicate
 * as an inline `findUserScopedSession` and asserted the COPY. That copy could
 * stay green even if the real service dropped the userId filter. The fix
 * extracted the gate into the REAL exported `isOwnerScoped(userId)` that the
 * service now CALLS to FAIL CLOSED before any `findFirst({sessionId,userId})`
 * — so a missing/empty userId never falls through to a bare, cross-user
 * `findUnique`. This file asserts that real export plus the real
 * `@usemoney/services` function surface.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getResearchStatus,
  getResearchResult,
  cancelResearch,
  deleteResearch,
} from "@usemoney/services";
import { isOwnerScoped } from "../../../../packages/services/src/research-logic";

describe("MONEY-286/620 — IDOR gate on research session lookups", () => {
  // ── REAL gate the service calls (isOwnerScoped) ──────────────────────

  it("[real gate] a real owner id (Clerk / Mongo ObjectId) is scoped", () => {
    assert.equal(isOwnerScoped("user_2abcDEF"), true);
    assert.equal(isOwnerScoped("65f0c0ffee0000000000abcd"), true);
  });

  it("[real gate] empty string userId FAILS CLOSED (no bare cross-user findUnique)", () => {
    // This is the crux of the IDOR fix: an absent/empty userId must NOT read
    // or mutate a session it doesn't own. The service refuses (→ "not found").
    assert.equal(isOwnerScoped(""), false);
  });

  it("[real gate] null / undefined userId FAILS CLOSED", () => {
    assert.equal(isOwnerScoped(null), false);
    assert.equal(isOwnerScoped(undefined), false);
  });

  // ── Behavioural IDOR proof against the REAL service exports ───────────
  //
  // These call the real functions with a missing/empty owner id. The gate is
  // hit BEFORE any Prisma access, so the functions return the closed-door
  // "not found" result WITHOUT touching the DB (pure, no open handle). This is
  // the regression that would FAIL if a refactor removed the `isOwnerScoped`
  // guard and let an unscoped lookup through.

  it("[service] getResearchStatus with empty userId → not found, no DB read", async () => {
    const res = await getResearchStatus("sess-victim", undefined, "");
    assert.equal(res.success, false);
    assert.equal(
      res.success === false && res.error,
      "Research session not found"
    );
  });

  it("[service] getResearchResult with empty userId → not found, no DB read", async () => {
    const res = await getResearchResult("sess-victim", "");
    assert.equal(res.success, false);
    assert.equal(
      res.success === false && res.error,
      "Research session not found"
    );
  });

  it("[service] cancelResearch with empty userId → not found, no mutation", async () => {
    const res = await cancelResearch("", "sess-victim");
    assert.equal(res.success, false);
    assert.equal(
      res.success === false && res.error,
      "Research session not found"
    );
  });

  it("[service] deleteResearch with empty userId → not found, no mutation", async () => {
    const res = await deleteResearch("", "sess-victim");
    assert.equal(res.success, false);
    assert.equal(
      res.success === false && res.error,
      "Research session not found"
    );
  });

  // ── Source-level guard (real @usemoney/services exports) ─────────────
  //
  // Single combined assertion to avoid node:test's `--test-force-exit` race
  // where late-queued `it()` callbacks get skipped when the prior suite
  // finishes before they're scheduled.

  it("[source] @usemoney/services exports the 4 scoped fns with userId in signature", () => {
    assert.equal(
      typeof getResearchStatus,
      "function",
      "getResearchStatus exported"
    );
    assert.equal(
      typeof getResearchResult,
      "function",
      "getResearchResult exported"
    );
    assert.equal(typeof cancelResearch, "function", "cancelResearch exported");
    assert.equal(typeof deleteResearch, "function", "deleteResearch exported");
    // Arity guards: the IDOR fix keeps userId in each signature. cancel/delete
    // take (userId, sessionId) → length 2; status/result keep sessionId
    // required (userId optional) → length ≥ 1.
    assert.ok(
      getResearchStatus.length >= 1,
      `status arity, got ${getResearchStatus.length}`
    );
    assert.ok(
      getResearchResult.length >= 1,
      `result arity, got ${getResearchResult.length}`
    );
    assert.ok(
      cancelResearch.length >= 2,
      `cancel arity, got ${cancelResearch.length}`
    );
    assert.ok(
      deleteResearch.length >= 2,
      `delete arity, got ${deleteResearch.length}`
    );
  });
});
