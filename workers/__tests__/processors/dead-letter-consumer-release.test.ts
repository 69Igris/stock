/**
 * A FAILED dead-letter notification must not be committed as COMPLETED —
 * MONEY-1238.
 *
 * Source: workers/src/processors/dead-letter-consumer.ts
 *         workers/src/lib/notifications.ts
 *
 * ## The defect
 *
 * `processDeadLetter` caught a notification failure, set `error =
 * "notify_failed"`, and then — four lines later, without consulting it — ran
 *
 *     if (claimed) await releaseMessage(record.messageId, "COMPLETED");
 *
 * `COMPLETED` is not bookkeeping. `decideOnExistingMarker`
 * (workers/src/lib/pubsub-dedupe-logic.ts) answers a COMPLETED marker with
 * `SKIP_COMPLETED`, so the one delivery that could still have raised the alert
 * was discarded BECAUSE the failed attempt had claimed success. The failure
 * silenced its own retry.
 *
 * Two things compounded it, and both are pinned below:
 *
 *   - `notified: true` was evidence of nothing. It came from `notifyFounders`
 *     reaching the end of its loop, and the loop called `createNotification`,
 *     which returns `Promise<void>` and swallows its own write failure. The
 *     field's own doc said "True when a notification row was created".
 *   - A `DLQ_ALERT_EMAILS` alias with no matching `User` row yields
 *     `recipients.length === 0`, i.e. NOBODY is told about any dead letter on
 *     the platform — and the old code answered that with a warn, `notified:
 *     false`, a COMPLETED marker and an HTTP 200.
 *
 * ## Why these tests drive the REAL processor
 *
 * The defect is in the I/O shell's decision, so a pure-logic test would be a
 * shadow. `processDeadLetter` is executed here for real; only the three Prisma
 * delegate methods it ultimately reaches are replaced, by plain property
 * assignment — the technique `workers/__tests__/lib/notifications.test.ts`
 * already uses. That means the dedupe claim/release path runs the REAL
 * `claimMessage` / `releaseMessage` / `createDedupeStore` code and the
 * assertions are made against the actual Mongo command the store issues, not
 * against a re-implementation of it.
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "@usemoney/database";
import {
  decideOnExistingMarker,
  DEDUPE_COLLECTION,
} from "../../src/lib/pubsub-dedupe-logic";
import { processDeadLetter } from "../../src/processors/dead-letter-consumer";

// The dedupe kill switch must be OFF (i.e. dedupe ON) or nothing is claimed and
// nothing is released, and every assertion below would pass vacuously.
process.env.PUBSUB_DEDUPE = "";
process.env.DLQ_ALERT_EMAILS = "founder@example.com";

// ── recorded effects ────────────────────────────────────────────────────────

interface RawCommand {
  [k: string]: unknown;
}

let rawCommands: RawCommand[] = [];
let recipients: Array<{ id: string }> = [];
/** Per-call outcome for `prisma.notification.create`: true = write, false = throw. */
let notificationWrites: boolean[] = [];
let notificationCalls = 0;
let userFindManyThrows = false;
let logged: string[] = [];

/** The `$set` payload of the release `update`, or null when none was issued. */
function releaseSet(): Record<string, unknown> | null {
  const update = rawCommands.find((c) => c.update === DEDUPE_COLLECTION);
  if (!update) return null;
  const updates = update.updates as Array<{
    u: { $set: Record<string, unknown> };
  }>;
  return updates[0].u.$set;
}

// ── Prisma doubles ──────────────────────────────────────────────────────────

type RunCommandRaw = typeof prisma.$runCommandRaw;
type UserFindMany = typeof prisma.user.findMany;
type NotificationCreate = typeof prisma.notification.create;

let originalUserFindMany: UserFindMany;
let originalNotificationCreate: NotificationCreate;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

before(() => {
  originalUserFindMany = prisma.user.findMany;
  originalNotificationCreate = prisma.notification.create;

  // `$runCommandRaw` lives on the prototype; assigning here shadows it with an
  // own property, deleted again in `after`.
  (prisma as unknown as { $runCommandRaw: RunCommandRaw }).$runCommandRaw =
    (async (command: RawCommand) => {
      rawCommands.push(command);
      if (command.createIndexes) return { ok: 1 };
      // The claim INSERT wins the unique-index race → `{ n: 1 }` → action RUN.
      if (command.insert) return { n: 1, ok: 1 };
      return { n: 1, ok: 1 };
    }) as unknown as RunCommandRaw;

  prisma.user.findMany = (async () => {
    if (userFindManyThrows) throw new Error("user lookup failed (test double)");
    return recipients;
  }) as unknown as UserFindMany;

  prisma.notification.create = (async () => {
    const ok = notificationWrites[notificationCalls] ?? true;
    notificationCalls++;
    if (!ok) throw new Error("notification write failed (test double)");
    return {} as never;
  }) as unknown as NotificationCreate;
});

after(() => {
  delete (prisma as unknown as { $runCommandRaw?: RunCommandRaw })
    .$runCommandRaw;
  prisma.user.findMany = originalUserFindMany;
  prisma.notification.create = originalNotificationCreate;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

beforeEach(() => {
  rawCommands = [];
  recipients = [{ id: "user-founder" }];
  notificationWrites = [];
  notificationCalls = 0;
  userFindManyThrows = false;
  logged = [];
  // Capture rather than discard: the zero-recipient warn is itself asserted,
  // and a silenced console hides a broken fixture.
  console.error = (...args: unknown[]) =>
    logged.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) =>
    logged.push(args.map(String).join(" "));
});

/** A well-formed DLQ push envelope with a real `messageId` (the claim key). */
function body(messageId = "dlq-msg-1"): unknown {
  return {
    message: {
      messageId,
      data: Buffer.from(JSON.stringify({ jobId: "job-1" })).toString("base64"),
      publishTime: "2026-08-20T18:30:00Z",
      attributes: {
        CloudPubSubDeadLetterSourceSubscription:
          "projects/p/subscriptions/price-sync-prod-push",
        CloudPubSubDeadLetterSourceDeliveryCount: "5",
      },
    },
    subscription: "projects/p/subscriptions/dead-letter-prod-push",
  };
}

describe("dead-letter release state follows the notification outcome", () => {
  it("a SUCCESSFUL notification still commits COMPLETED", async () => {
    // The control. Without this, "always release FAILED" would satisfy every
    // other case in this file and re-notify on every redelivery forever.
    const outcome = await processDeadLetter(body());

    assert.equal(outcome.notified, true);
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.acked, true);
    assert.deepEqual(releaseSet()?.status, "COMPLETED");
  });

  it("a THROWING notification write releases FAILED, not COMPLETED", async () => {
    notificationWrites = [false];

    const outcome = await processDeadLetter(body());

    assert.equal(
      outcome.notified,
      false,
      "`notified` must reflect the WRITE, not the absence of a throw",
    );
    assert.equal(outcome.error, "notify_failed");
    assert.equal(
      releaseSet()?.status,
      "FAILED",
      "COMPLETED here is the MONEY-1238 defect: it makes the redelivery that " +
        "could have healed this failure skip as a duplicate",
    );
  });

  it("ZERO recipients releases FAILED and reports no_recipients", async () => {
    recipients = [];

    const outcome = await processDeadLetter(body());

    assert.equal(outcome.notified, false);
    assert.equal(outcome.error, "no_recipients");
    assert.equal(releaseSet()?.status, "FAILED");
    assert.ok(
      logged.some((l) => l.includes("no user rows")),
      "the operator-facing warn must survive — it is the only record",
    );
  });

  it("a THROWING recipient lookup releases FAILED and still ACKs", async () => {
    userFindManyThrows = true;

    const outcome = await processDeadLetter(body());

    assert.equal(outcome.acked, true, "a 5xx would nack back onto the DLQ");
    assert.equal(outcome.notified, false);
    assert.equal(outcome.error, "notify_failed");
    assert.equal(releaseSet()?.status, "FAILED");
  });

  it("a PARTIAL write (1 of 2 recipients) releases FAILED", async () => {
    recipients = [{ id: "user-a" }, { id: "user-b" }];
    notificationWrites = [true, false];

    const outcome = await processDeadLetter(body());

    assert.equal(
      outcome.notified,
      true,
      "`notified` documents 'at least one recipient', and one did land",
    );
    assert.equal(outcome.error, "notify_partial");
    assert.equal(
      releaseSet()?.status,
      "FAILED",
      "a recipient who was NOT told is still a dead letter nobody heard about",
    );
  });

  it("never rejects, whatever fails", async () => {
    userFindManyThrows = true;
    notificationWrites = [false];
    await assert.doesNotReject(() => processDeadLetter(body()));
  });
});

describe("the released state means what the fix relies on", () => {
  // The link that makes the release choice load-bearing, asserted against the
  // REAL decision function rather than a restatement of it. If someone changes
  // `decideOnExistingMarker` so FAILED stops being re-claimable, this fails
  // here instead of silently re-breaking the consumer.
  const marker = (status: "COMPLETED" | "FAILED") => ({
    messageId: "dlq-msg-1",
    route: "/jobs/dead-letter",
    status,
    attempts: 1,
    // Both terminal states clear the lease — see `DedupeStore.release`.
    leaseExpiresAt: null as number | null,
  });

  it("FAILED is re-claimable: a redelivery RUNs and can heal the failure", () => {
    const decision = decideOnExistingMarker(marker("FAILED"), Date.now());
    assert.equal(decision.action, "RUN");
    assert.equal(decision.reason, "reclaim_after_failure");
  });

  it("COMPLETED is terminal: a redelivery is DISCARDED", () => {
    const decision = decideOnExistingMarker(marker("COMPLETED"), Date.now());
    assert.equal(
      decision.action,
      "SKIP_COMPLETED",
      "this is exactly why a failed notification must not release COMPLETED",
    );
  });
});

describe("the claim is real (guards against vacuous assertions)", () => {
  it("issues the dedupe INSERT and exactly one release UPDATE", async () => {
    await processDeadLetter(body());

    assert.equal(
      rawCommands.filter((c) => c.insert === DEDUPE_COLLECTION).length,
      1,
      "no claim means no release, and every release assertion above would be " +
        "checking `null === null`",
    );
    assert.equal(
      rawCommands.filter((c) => c.update === DEDUPE_COLLECTION).length,
      1,
    );
  });
});
