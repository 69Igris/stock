/**
 * A notification write failure must be VISIBLE to a caller that needs it —
 * MONEY-1238.
 *
 * Source: workers/src/lib/notifications.ts
 *
 * `createNotification` returns `Promise<void>` and swallows its own write
 * failure. That is the right default for the ~20 job processors that call it —
 * a notification is a courtesy and must never fail the job it reports on — and
 * it is deliberately UNCHANGED here.
 *
 * It is the wrong contract for the dead-letter consumer, which records
 * `notified` and commits a Pub/Sub dedupe marker on the answer. Reading
 * "success" from the absence of a throw made `DeadLetterOutcome.notified` a
 * fiction and released the marker COMPLETED after a write that never landed,
 * so the redelivery that could have raised the alert was skipped as a
 * duplicate.
 *
 * `tryCreateNotification` is the additive opt-in: same swallow-and-log, but the
 * swallow is now in the return value. These tests pin BOTH halves — the new
 * signal, and the old contract that ~20 callers still depend on.
 *
 * Prisma is stubbed by plain property assignment (the delegate's methods are
 * writable value properties, so `mock.method` cannot patch them) — the same
 * technique as `notifications.test.ts`. No DB connection is opened.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@usemoney/database";

import {
  createNotification,
  tryCreateNotification,
  type NotificationInput,
} from "../../src/lib/notifications";

type NotificationCreate = typeof prisma.notification.create;

const INPUT: NotificationInput = {
  userId: "user-1",
  type: "SYSTEM",
  title: "Dead letter parked",
  message: "price-sync failed 5 deliveries",
  metadata: { sourceJob: "price-sync" },
};

describe("tryCreateNotification reports the write outcome", () => {
  let originalCreate: NotificationCreate;
  let originalError: typeof console.error;
  let createCalls: Array<{ data: unknown }>;

  beforeEach(() => {
    originalCreate = prisma.notification.create;
    originalError = console.error;
    console.error = () => {};
    createCalls = [];
  });

  afterEach(() => {
    prisma.notification.create = originalCreate;
    console.error = originalError;
  });

  it("returns TRUE when the row is written", async () => {
    // `as unknown as` below: Prisma's generated `create` is a generic whose
    // type parameter threads the `data` shape into the RETURN type, so no
    // plain stub signature sufficiently overlaps it (TS2352). Substituting a
    // double for a generic method is what the double assertion is for, and it
    // is the compiler's own suggested remedy. Surfaced when workers/__tests__
    // was first type-checked (MONEY-1326).
    prisma.notification.create = (async (args: { data: unknown }) => {
      createCalls.push(args);
      return {} as never;
    }) as unknown as NotificationCreate;

    assert.equal(await tryCreateNotification(INPUT), true);
    assert.equal(createCalls.length, 1);
  });

  it("returns FALSE when the write throws — the failure is not swallowed silently", async () => {
    prisma.notification.create = (async () => {
      throw new Error("DB connection lost");
    }) as NotificationCreate;

    assert.equal(
      await tryCreateNotification(INPUT),
      false,
      "a caller that records `notified` from this must be able to see the failure",
    );
  });

  it("returns FALSE for a non-Error rejection too", async () => {
    prisma.notification.create = (async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "string error";
    }) as NotificationCreate;

    assert.equal(await tryCreateNotification(INPUT), false);
  });

  it("still does not THROW on a write failure", async () => {
    prisma.notification.create = (async () => {
      throw new Error("DB connection lost");
    }) as NotificationCreate;

    await assert.doesNotReject(() => tryCreateNotification(INPUT));
  });

  it("passes the same fields through as createNotification", async () => {
    prisma.notification.create = (async (args: { data: unknown }) => {
      createCalls.push(args);
      return {} as never;
    }) as unknown as NotificationCreate;

    await tryCreateNotification(INPUT);

    assert.deepEqual(createCalls[0].data, {
      userId: "user-1",
      type: "SYSTEM",
      title: "Dead letter parked",
      message: "price-sync failed 5 deliveries",
      metadata: { sourceJob: "price-sync" },
    });
  });
});

describe("createNotification's fire-and-forget contract is UNCHANGED", () => {
  // ~20 processors (roast, pairing, import, sync, research, alert-evaluator,
  // l3-analysis, login-briefing, strategy-scan, comparison, document-process)
  // call this and none can act on a failure. Widening it would have been a
  // 20-file blast radius for a one-file need.
  let originalCreate: NotificationCreate;
  let originalError: typeof console.error;

  beforeEach(() => {
    originalCreate = prisma.notification.create;
    originalError = console.error;
    console.error = () => {};
  });

  afterEach(() => {
    prisma.notification.create = originalCreate;
    console.error = originalError;
  });

  it("resolves to undefined on success (still void, not a leaked boolean)", async () => {
    prisma.notification.create = (async () =>
      ({}) as never) as NotificationCreate;

    assert.equal(await createNotification(INPUT), undefined);
  });

  it("resolves to undefined on failure and does not throw", async () => {
    prisma.notification.create = (async () => {
      throw new Error("DB connection lost");
    }) as NotificationCreate;

    await assert.doesNotReject(async () => {
      assert.equal(await createNotification(INPUT), undefined);
    });
  });

  it("still reaches prisma.notification.create exactly once", async () => {
    let calls = 0;
    prisma.notification.create = (async () => {
      calls++;
      return {} as never;
    }) as NotificationCreate;

    await createNotification(INPUT);
    assert.equal(calls, 1, "the delegation must not double-write or skip");
  });
});
