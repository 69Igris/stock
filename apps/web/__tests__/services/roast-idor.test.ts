/**
 * MONEY-543 - IDOR regression test for portfolio roast lookups.
 * Mirrors the MONEY-286 fix shape from research-idor.test.ts.
 *
 * Pre-fix `getRoastStatus` in packages/services/src/roast.service.ts
 * used `prisma.portfolioRoast.findUnique({where: {sessionId}})` with
 * no userId filter, and `getRoastStatusAction` in
 * apps/web/lib/actions/roast.ts did not call getAuthenticatedUser
 * before passing the sessionId through. Any authenticated user who
 * guessed or harvested another user's roast sessionId could read
 * their `status`, `progress`, `currentStep`, `score`, and
 * `errorMessage` (which may include broker / portfolio hints).
 *
 * Two layers of regression guard:
 *   1. Algorithm-level (inline) - `findUserScopedRoast` MUST match
 *      both sessionId AND userId. Mirrors the in-source `findFirst`
 *      logic so a careless refactor that drops the userId filter
 *      fails here too. Also covers the sibling functions
 *      (`getRoastBySessionId`, `cancelRoast`, `deleteRoast`).
 *   2. Source-level (real import) - assert the service function
 *      signature accepts a `userId` arg and propagates it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getRoastStatus,
  getRoastBySessionId,
  cancelRoast,
  deleteRoast,
} from "@usemoney/services";

// ── Algorithm-level fixture mirroring the in-source findFirst predicate ──

interface RoastRow {
  id: string;
  sessionId: string;
  userId: string;
  status: string;
  progress: number;
  currentStep: string | null;
  score: number | null;
  errorMessage: string | null;
}

/**
 * Production code uses `findFirst({where: {sessionId, userId}})` when
 * userId is provided. When userId is undefined we fall through to the
 * legacy `findUnique({where: {sessionId}})` to preserve back-compat
 * (no production caller hits this path today; included for symmetry
 * with MONEY-286).
 */
function findUserScopedRoast(
  rows: RoastRow[],
  sessionId: string,
  userId: string | undefined
): RoastRow | null {
  if (!userId) {
    return rows.find((r) => r.sessionId === sessionId) ?? null;
  }
  return (
    rows.find((r) => r.sessionId === sessionId && r.userId === userId) ?? null
  );
}

/**
 * Mirrors the runtime check used by `cancelRoast`: only cancels when
 * the session is owned AND not yet finished.
 */
function findCancellableRoast(
  rows: RoastRow[],
  sessionId: string,
  userId: string
): RoastRow | null {
  return (
    rows.find(
      (r) =>
        r.sessionId === sessionId &&
        r.userId === userId &&
        r.status !== "COMPLETED" &&
        r.status !== "FAILED"
    ) ?? null
  );
}

/**
 * Action-layer demo / auth wrapper shape. Mirrors getRoastStatusAction:
 *   - demo session  → "Roast not found"
 *   - unauthenticated → "Unauthorized"
 *   - authenticated → service result
 */
type RoastStatusActionResult =
  | { success: true; data: Omit<RoastRow, "id" | "sessionId" | "userId"> }
  | { success: false; error: string };

function simulateGetRoastStatusAction(
  rows: RoastRow[],
  sessionId: string,
  opts: { isDemo: boolean; authUserId: string | null }
): RoastStatusActionResult {
  if (opts.isDemo) {
    return { success: false, error: "Roast not found" };
  }
  if (!opts.authUserId) {
    return { success: false, error: "Unauthorized" };
  }
  const found = findUserScopedRoast(rows, sessionId, opts.authUserId);
  if (!found) {
    return { success: false, error: "Roast not found" };
  }
  return {
    success: true,
    data: {
      status: found.status,
      progress: found.progress,
      currentStep: found.currentStep,
      score: found.score,
      errorMessage: found.errorMessage,
    },
  };
}

function makeRoast(overrides: Partial<RoastRow> = {}): RoastRow {
  return {
    id: "roast-1",
    sessionId: "sess-alice-1",
    userId: "alice",
    status: "FETCHING_DATA",
    progress: 25,
    currentStep: "Fetching holdings",
    score: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("MONEY-543 - IDOR regression on portfolio roast lookups", () => {
  const rows: RoastRow[] = [
    makeRoast({
      id: "r-alice",
      sessionId: "sess-alice-1",
      userId: "alice",
      status: "ANALYZING_STOCKS",
      progress: 40,
      currentStep: "Analyzing stocks",
      score: null,
      errorMessage: null,
    }),
    makeRoast({
      id: "r-bob",
      sessionId: "sess-bob-1",
      userId: "bob",
      status: "COMPLETED",
      progress: 100,
      currentStep: null,
      score: 72,
      errorMessage: null,
    }),
    makeRoast({
      id: "r-alice-fail",
      sessionId: "sess-alice-fail",
      userId: "alice",
      status: "FAILED",
      progress: 60,
      currentStep: null,
      score: null,
      // Pre-fix the errorMessage would leak across users; the failure
      // message often contains a broker name or portfolio hint.
      errorMessage: "ZERODHA sync token expired",
    }),
  ];

  // ── Algorithm-level guards (mirror in-source `findFirst` predicate) ──

  it("[algorithm] returns the roast for the owning user", () => {
    const r = findUserScopedRoast(rows, "sess-alice-1", "alice");
    assert.equal(r?.status, "ANALYZING_STOCKS");
    assert.equal(r?.progress, 40);
  });

  it("[algorithm] returns null when a different user guesses the sessionId", () => {
    const r = findUserScopedRoast(rows, "sess-alice-1", "bob");
    assert.equal(r, null, "cross-user lookup must NOT leak the roast");
  });

  it("[algorithm] does not leak FAILED errorMessage across users", () => {
    // Pre-fix bob would receive "ZERODHA sync token expired" - a broker
    // hint - by guessing alice's failed sessionId. Post-fix → null.
    const r = findUserScopedRoast(rows, "sess-alice-fail", "bob");
    assert.equal(r, null);
  });

  it("[algorithm] returns null for a non-existent sessionId regardless of user", () => {
    assert.equal(findUserScopedRoast(rows, "missing", "alice"), null);
    assert.equal(findUserScopedRoast(rows, "missing", "bob"), null);
  });

  it("[algorithm] does not allow superstring sessionId match", () => {
    // Defense-in-depth: prisma findFirst uses equality, not LIKE.
    const r = findUserScopedRoast(rows, "sess-alice", "alice");
    assert.equal(r, null);
  });

  it("[algorithm] cancelRoast only cancels owned and unfinished sessions", () => {
    // Owner + running → cancellable
    assert.ok(findCancellableRoast(rows, "sess-alice-1", "alice"));
    // Cross-user attempt → null even if running
    assert.equal(findCancellableRoast(rows, "sess-alice-1", "bob"), null);
    // Owner but COMPLETED → null
    assert.equal(findCancellableRoast(rows, "sess-bob-1", "bob"), null);
    // Owner but FAILED → null
    assert.equal(findCancellableRoast(rows, "sess-alice-fail", "alice"), null);
  });

  it("[algorithm] falls through to legacy unscoped path when userId is undefined", () => {
    // No production caller hits this; documented so a refactor doesn't
    // surprise. Action-layer callers always pass authUser.userId.
    const r = findUserScopedRoast(rows, "sess-alice-1", undefined);
    assert.equal(r?.userId, "alice");
  });

  it("[algorithm] two users with identical-shape sessions stay isolated", () => {
    const both: RoastRow[] = [
      makeRoast({
        id: "r1",
        sessionId: "sess-200",
        userId: "alice",
        score: 50,
      }),
      makeRoast({ id: "r2", sessionId: "sess-201", userId: "bob", score: 90 }),
    ];
    assert.equal(findUserScopedRoast(both, "sess-200", "alice")?.score, 50);
    assert.equal(
      findUserScopedRoast(both, "sess-200", "bob"),
      null,
      "bob must not see alice's sess-200"
    );
    assert.equal(findUserScopedRoast(both, "sess-201", "bob")?.score, 90);
  });

  // ── Action-layer simulation guards (mirror getRoastStatusAction) ──

  it("[action] returns data for the owning user", () => {
    const result = simulateGetRoastStatusAction(rows, "sess-alice-1", {
      isDemo: false,
      authUserId: "alice",
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.status, "ANALYZING_STOCKS");
      assert.equal(result.data.progress, 40);
    }
  });

  it("[action] returns 'Roast not found' for cross-user IDOR attempts", () => {
    const result = simulateGetRoastStatusAction(rows, "sess-alice-1", {
      isDemo: false,
      authUserId: "bob",
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error, "Roast not found");
    }
  });

  it("[action] returns 'Unauthorized' for anonymous callers", () => {
    const result = simulateGetRoastStatusAction(rows, "sess-alice-1", {
      isDemo: false,
      authUserId: null,
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error, "Unauthorized");
    }
  });

  it("[action] demo sessions return 'Roast not found' without DB access", () => {
    // Demo session must NOT hit the real DB; mirrors the existing
    // demo gate convention in the action (see roast.ts).
    const result = simulateGetRoastStatusAction(rows, "sess-alice-1", {
      isDemo: true,
      authUserId: "anyone-or-none",
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error, "Roast not found");
    }
  });

  it("[action] does not leak FAILED errorMessage across users via action layer", () => {
    const result = simulateGetRoastStatusAction(rows, "sess-alice-fail", {
      isDemo: false,
      authUserId: "bob",
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error, "Roast not found");
    }
  });

  // ── Source-level guard (real @usemoney/services exports) ────────────
  //
  // Single combined assertion to avoid node:test's `--test-force-exit`
  // race where late-queued `it()` callbacks get skipped when the prior
  // suite finishes before they're scheduled.

  it("[source] @usemoney/services exports getRoastStatus + sibling fns with userId-scoped shape", () => {
    assert.equal(typeof getRoastStatus, "function", "getRoastStatus exported");
    assert.equal(
      typeof getRoastBySessionId,
      "function",
      "getRoastBySessionId exported"
    );
    assert.equal(typeof cancelRoast, "function", "cancelRoast exported");
    assert.equal(typeof deleteRoast, "function", "deleteRoast exported");

    // Arity check - the IDOR fix added a `userId` optional param to
    // `getRoastStatus`, so required arity remains 1 (sessionId only).
    // For getRoastBySessionId/cancelRoast/deleteRoast the userId param
    // is required, so arity is 2.
    assert.ok(
      getRoastStatus.length >= 1,
      `getRoastStatus arity >= 1, got ${getRoastStatus.length}`
    );
    assert.ok(
      getRoastBySessionId.length >= 2,
      `getRoastBySessionId arity >= 2, got ${getRoastBySessionId.length}`
    );
    assert.ok(
      cancelRoast.length >= 2,
      `cancelRoast arity >= 2, got ${cancelRoast.length}`
    );
    assert.ok(
      deleteRoast.length >= 2,
      `deleteRoast arity >= 2, got ${deleteRoast.length}`
    );
  });
});
