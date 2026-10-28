/**
 * User-sync transaction logic — packages/services/src/user-sync-logic.ts
 * (real export `runUserSyncTx`) + the validation guard on the service's
 * `ensureUserAndSubscription` (packages/services/src/user-sync.service.ts).
 *
 * MONEY-620 de-shadow/coverage gap: the only existing test that mentions
 * `ensureUserAndSubscription` (apps/web/__tests__/api/webhooks-clerk-e2e.test.ts)
 * STUBS it out entirely, so the actual Clerk→DB find-or-create / back-fill /
 * idempotency decision flow had ZERO real-export coverage. This file drives the
 * real `runUserSyncTx` with a recording fake `tx` (the same control flow the
 * live `prisma.$transaction` callback now runs) and asserts the writes it
 * decides to make.
 *
 * Pure & orphan-free: `user-sync-logic` imports no I/O; the service import is
 * only exercised on its pre-DB early-return guard, which never issues a query
 * (no DB/socket handle opened).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runUserSyncTx,
  type UserSyncTx,
  type UserSyncUserRow,
  type UserSyncSubscriptionRow,
} from "../../../../packages/services/src/user-sync-logic";
import {
  ensureUserAndSubscription,
  isRetryableSyncError,
} from "../../../../packages/services/src/user-sync.service";

// ── Recording fake transaction client ───────────────────────────────────────

interface FakeState {
  /** Row returned for the clerkId fast-path lookup (null = miss). */
  byClerkId?: UserSyncUserRow | null;
  /** Row returned for the email slow-path lookup (null = miss). */
  byEmail?: UserSyncUserRow | null;
  /** Existing subscription for the resolved user (null = none → create). */
  existingSub?: UserSyncSubscriptionRow | null;
}

type Call =
  | { op: "user.findUnique"; where: unknown }
  | { op: "user.update"; where: unknown; data: unknown }
  | { op: "user.create"; data: unknown }
  | { op: "subscription.findUnique"; where: unknown }
  | { op: "subscription.create"; data: unknown };

function makeTx(state: FakeState): { tx: UserSyncTx; calls: Call[] } {
  const calls: Call[] = [];

  const tx: UserSyncTx = {
    user: {
      findUnique: async (args) => {
        calls.push({ op: "user.findUnique", where: args.where });
        if ("clerkId" in args.where) return state.byClerkId ?? null;
        return state.byEmail ?? null;
      },
      update: async (args) => {
        calls.push({
          op: "user.update",
          where: args.where,
          data: args.data,
        });
        // Reflect the link/name change onto the returned row.
        const base = state.byEmail!;
        return { ...base, clerkId: args.data.clerkId, name: args.data.name };
      },
      create: async (args) => {
        calls.push({ op: "user.create", data: args.data });
        return {
          id: "new_user_id",
          email: args.data.email,
          clerkId: args.data.clerkId,
          name: args.data.name,
          lastResendSyncAt: null,
        };
      },
    },
    subscription: {
      findUnique: async (args) => {
        calls.push({ op: "subscription.findUnique", where: args.where });
        return state.existingSub ?? null;
      },
      create: async (args) => {
        calls.push({ op: "subscription.create", data: args.data });
        return {
          id: "new_sub_id",
          planId: "FREE",
          creditsLimit: 5,
        };
      },
    },
  };

  return { tx, calls };
}

const DEFAULT_SUB = { planId: "FREE", status: "ACTIVE", creditsLimit: 5 };
const INPUT = {
  clerkId: "user_abc123",
  email: "trader@example.com",
  name: "Ada Trader",
};

const ops = (calls: Call[]) => calls.map((c) => c.op);

describe("runUserSyncTx — User resolution order", () => {
  it("fast-path: clerkId hit reuses the row, never looks up by email or writes", async () => {
    const existing: UserSyncUserRow = {
      id: "u1",
      email: INPUT.email,
      clerkId: INPUT.clerkId,
      name: INPUT.name,
      lastResendSyncAt: new Date(),
    };
    const { tx, calls } = makeTx({
      byClerkId: existing,
      existingSub: { id: "s1", planId: "PRO", creditsLimit: 1000 },
    });

    const result = await runUserSyncTx(tx, INPUT, DEFAULT_SUB);

    assert.equal(result.user.id, "u1");
    assert.equal(result.created.user, false);
    assert.equal(result.created.subscription, false);
    // Only the clerkId lookup + the subscription lookup ran — no email lookup,
    // no update, no create.
    assert.deepEqual(ops(calls), [
      "user.findUnique",
      "subscription.findUnique",
    ]);
  });

  it("slow-path: email hit with changed clerkId/name back-fills via update", async () => {
    const preExisting: UserSyncUserRow = {
      id: "u2",
      email: INPUT.email,
      clerkId: null, // never linked to Clerk before
      name: "Old Name",
      lastResendSyncAt: null,
    };
    const { tx, calls } = makeTx({
      byClerkId: null,
      byEmail: preExisting,
      existingSub: { id: "s2", planId: "FREE", creditsLimit: 5 },
    });

    const result = await runUserSyncTx(tx, INPUT, DEFAULT_SUB);

    assert.equal(result.user.id, "u2");
    assert.equal(result.user.clerkId, INPUT.clerkId, "clerkId back-filled");
    assert.equal(result.user.name, INPUT.name, "name refreshed");
    assert.equal(result.created.user, false, "linking is not a creation");

    const update = calls.find((c) => c.op === "user.update");
    assert.ok(update, "a back-fill update must run");
    assert.deepEqual(
      (update as { data: unknown }).data,
      { clerkId: INPUT.clerkId, name: INPUT.name },
      "update writes exactly clerkId + name"
    );
  });

  it("slow-path: email hit with identical clerkId AND name short-circuits (no update)", async () => {
    const preExisting: UserSyncUserRow = {
      id: "u3",
      email: INPUT.email,
      clerkId: INPUT.clerkId, // already linked, same id
      name: INPUT.name, // unchanged
      lastResendSyncAt: null,
    };
    const { tx, calls } = makeTx({
      byClerkId: null, // fast path misses (e.g. stale index in this tx view)
      byEmail: preExisting,
      existingSub: null,
    });

    const result = await runUserSyncTx(tx, INPUT, DEFAULT_SUB);

    assert.equal(result.user.id, "u3");
    assert.ok(
      !ops(calls).includes("user.update"),
      "an unchanged row must NOT be re-written (no updatedAt churn)"
    );
  });

  it("create-path: both lookups miss → creates a new User", async () => {
    const { tx, calls } = makeTx({
      byClerkId: null,
      byEmail: null,
      existingSub: null,
    });

    const result = await runUserSyncTx(tx, INPUT, DEFAULT_SUB);

    assert.equal(result.created.user, true);
    assert.equal(result.user.id, "new_user_id");
    const create = calls.find((c) => c.op === "user.create");
    assert.ok(create);
    assert.deepEqual((create as { data: unknown }).data, {
      clerkId: INPUT.clerkId,
      email: INPUT.email,
      name: INPUT.name,
    });
  });
});

describe("runUserSyncTx — Subscription idempotency", () => {
  it("creates a Subscription (with defaults) when none exists", async () => {
    const { tx, calls } = makeTx({
      byClerkId: {
        id: "u4",
        email: INPUT.email,
        clerkId: INPUT.clerkId,
        name: INPUT.name,
        lastResendSyncAt: new Date(),
      },
      existingSub: null,
    });

    const result = await runUserSyncTx(tx, INPUT, DEFAULT_SUB);

    assert.equal(result.created.subscription, true);
    const create = calls.find((c) => c.op === "subscription.create");
    assert.ok(create, "subscription.create must run");
    assert.deepEqual((create as { data: unknown }).data, {
      userId: "u4",
      ...DEFAULT_SUB,
    });
  });

  it("NEVER overwrites an existing Subscription", async () => {
    const { tx, calls } = makeTx({
      byClerkId: {
        id: "u5",
        email: INPUT.email,
        clerkId: INPUT.clerkId,
        name: INPUT.name,
        lastResendSyncAt: new Date(),
      },
      existingSub: { id: "s5", planId: "PRO", creditsLimit: 1000 },
    });

    const result = await runUserSyncTx(tx, INPUT, DEFAULT_SUB);

    assert.equal(result.created.subscription, false);
    assert.equal(result.subscription.id, "s5");
    assert.equal(result.subscription.planId, "PRO");
    assert.ok(
      !ops(calls).includes("subscription.create"),
      "an existing PRO subscription must not be clobbered by FREE defaults"
    );
  });
});

describe("ensureUserAndSubscription — validation guard (real service)", () => {
  it("rejects a missing clerkId without touching the DB", async () => {
    const res = await ensureUserAndSubscription({
      clerkId: "",
      email: "x@y.com",
      name: "X",
    });
    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.error, "clerkId and email are required");
    }
  });

  it("rejects a missing email without touching the DB", async () => {
    const res = await ensureUserAndSubscription({
      clerkId: "user_x",
      email: "",
      name: "X",
    });
    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.error, "clerkId and email are required");
    }
  });
});

describe("isRetryableSyncError — webhook ↔ lazy-create race (MONEY-883)", () => {
  it("retries on Prisma P2034 (write conflict / deadlock)", () => {
    assert.equal(isRetryableSyncError({ code: "P2034" }), true);
  });

  it("retries on Prisma P2002 (unique constraint — lost the create race)", () => {
    assert.equal(isRetryableSyncError({ code: "P2002" }), true);
  });

  it("retries on the P2034 message text even without a code", () => {
    assert.equal(
      isRetryableSyncError(
        new Error(
          "Transaction failed due to a write conflict or a deadlock. Please retry your transaction."
        )
      ),
      true
    );
  });

  it("retries on a bare 'write conflict' / 'deadlock' message", () => {
    assert.equal(isRetryableSyncError(new Error("WriteConflict")), true);
    assert.equal(isRetryableSyncError(new Error("E11000 deadlock")), true);
  });

  it("does NOT retry a genuine error (P2025 not-found, validation)", () => {
    assert.equal(isRetryableSyncError({ code: "P2025" }), false);
    assert.equal(
      isRetryableSyncError(new Error("Invalid email address")),
      false
    );
  });

  it("does NOT retry null / non-Error values", () => {
    assert.equal(isRetryableSyncError(null), false);
    assert.equal(isRetryableSyncError(undefined), false);
    // a raw string is not an Error → only Error.message is inspected
    assert.equal(isRetryableSyncError("write conflict"), false);
  });
});
