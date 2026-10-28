/**
 * Dead-letter consumer — I/O shell (MONEY-1204, 14a.5a).
 *
 * Subscribes to `dead-letter-${ENV}`, the topic every worker push subscription
 * has been dead-lettering into since MONEY-841 with nothing on the other end.
 *
 * ## What it does, and the three things it deliberately does NOT do
 *
 * DOES: log the source subscription / attributes / messageId plus a redacted,
 * truncated payload excerpt, and raise ONE in-app notification to the founder
 * through the existing `lib/notifications.ts` service.
 *
 * DOES NOT **auto-retry**. A message reaching this topic has already been
 * delivered `--max-delivery-attempts=5` times and failed every time. Re-running
 * it here is how a poison message becomes an infinite loop — with the loop now
 * running on the ONE queue that has no further dead-letter backstop. Requeuing
 * is a human decision, taken after the cause is fixed.
 *
 * DOES NOT **throw**. A throw out of the handler returns 5xx, which nacks, which
 * puts the message back on the dead-letter queue. Every path below is
 * exhaustively caught; the route returns 200 unconditionally.
 *
 * DOES NOT **log the payload verbatim**. See `dead-letter-consumer-logic.ts`.
 *
 * @see workers/src/processors/dead-letter-consumer-logic.ts (pure shaping)
 * @see workers/scripts/setup-pubsub.sh (the push subscription)
 */

import { prisma } from "@usemoney/database";
import { tryCreateNotification } from "../lib/notifications";
import { claimMessage, releaseMessage } from "../lib/pubsub-dedupe";
import {
  buildDeadLetterNotification,
  buildDeadLetterRecord,
  resolveDlqAlertEmails,
  type DeadLetterRecord,
} from "./dead-letter-consumer-logic";

/** Route path — also the key that opts this route out of the generic
 *  dedupe middleware (see `SELF_DEDUPING_ROUTES`). */
export const DEAD_LETTER_ROUTE = "/jobs/dead-letter";

export interface DeadLetterOutcome {
  /** Always true — the message is acked no matter what happened. */
  acked: true;
  /** True when this delivery was a repeat and no notification was written. */
  duplicate: boolean;
  /**
   * True when a notification row was ACTUALLY created for at least one
   * recipient — the write returned, not merely "nothing threw".
   *
   * MONEY-1238: this used to be hard-coded `true` whenever `notifyFounders`
   * returned, and `notifyFounders` returned `true` whenever it reached the end
   * of its loop. `createNotification` swallows its own write failure, so the
   * field asserted a row that need not exist. It is now threaded from
   * `tryCreateNotification`'s real result.
   */
  notified: boolean;
  /**
   * Set when something went wrong internally; the message is STILL acked.
   *
   * `notify_failed`  — the notification path threw, or every write failed.
   * `notify_partial` — some recipients were notified and some writes failed.
   * `no_recipients`  — no `User` row matched the configured alert emails, so
   *                    NOBODY was told about this dead letter.
   * `shape_failed`   — the push body could not be shaped into a record.
   *
   * Any value here also makes the dedupe release non-terminal — see
   * `processDeadLetter`.
   */
  error?: string;
}

/** Structured, single-line log of the parked message. */
function logRecord(record: DeadLetterRecord, duplicate: boolean): void {
  console.error(
    "[dead-letter] " +
      JSON.stringify({
        duplicate,
        messageId: record.messageId,
        sourceJob: record.sourceJob,
        sourceSubscription: record.sourceSubscription,
        sourceProject: record.sourceProject,
        originalPublishTime: record.originalPublishTime,
        deliveryCount: record.deliveryCount,
        dlqSubscription: record.subscription,
        payloadDecodable: record.payloadDecodable,
        payloadBytes: record.payloadBytes,
        payloadExcerpt: record.payloadExcerpt,
        attributes: record.attributes,
        autoRetry: false,
      }),
  );
}

/**
 * Handle one dead-lettered message.
 *
 * Idempotent on the DLQ delivery's own `messageId` via the shared dedupe store,
 * so a redelivery of the same dead letter produces exactly ONE notification.
 * Note the difference from the generic middleware: here EVERY dedupe outcome —
 * completed, in-flight elsewhere, store unavailable — results in an ack. The
 * generic path nacks on a live competing claim so the work is not lost; there is
 * no work to lose here, and a nack would grow the queue.
 *
 * A message with no usable `messageId` (a malformed or hand-posted body) is
 * still logged; it just cannot be deduped, because there is no identity to
 * dedupe on.
 */
export async function processDeadLetter(
  body: unknown,
): Promise<DeadLetterOutcome> {
  let record: DeadLetterRecord;
  try {
    record = buildDeadLetterRecord(body);
  } catch (err) {
    // `buildDeadLetterRecord` is total, so this is unreachable by construction.
    // It is caught anyway: "unreachable" plus "must never throw" is exactly the
    // combination that eventually throws.
    console.error("[dead-letter] failed to shape message; acking anyway", err);
    return {
      acked: true,
      duplicate: false,
      notified: false,
      error: "shape_failed",
    };
  }

  let claimed = false;
  let duplicate = false;

  if (record.messageId) {
    try {
      const decision = await claimMessage(record.messageId, DEAD_LETTER_ROUTE);
      if (decision.action === "SKIP_COMPLETED") {
        duplicate = true;
      } else if (decision.action === "RETRY_LATER") {
        // Another instance is mid-notification for this same dead letter.
        // Ack; it will finish. Do NOT nack.
        duplicate = true;
      } else {
        claimed = decision.action === "RUN";
      }
    } catch (err) {
      // `claimMessage` already fails open, so this is belt-and-braces.
      console.error("[dead-letter] dedupe claim failed; continuing", err);
    }
  }

  logRecord(record, duplicate);

  if (duplicate) {
    return { acked: true, duplicate: true, notified: false };
  }

  let notified = false;
  let error: string | undefined;
  try {
    const outcome = await notifyFounders(record);
    notified = outcome.created > 0;
    if (outcome.attempted === 0) {
      // Zero recipients. Not a crash — but nobody was told, and reporting
      // success here is how EVERY dead letter on the platform goes unseen
      // while each run logs a clean 200.
      error = "no_recipients";
    } else if (outcome.created === 0) {
      error = "notify_failed";
    } else if (outcome.created < outcome.attempted) {
      error = "notify_partial";
    }
  } catch (err) {
    // Covers the user lookup and anything else structural on the notify path.
    // A failed notification must not resurrect the message (we still ACK) — but
    // it must not be RECORDED as a success either; see the release below.
    console.error("[dead-letter] notification failed; acking anyway", err);
    error = "notify_failed";
  }

  if (claimed) {
    // MONEY-1238 — the outcome decides the marker, not the fact that we got
    // here. `COMPLETED` means `SKIP_COMPLETED` on any later delivery of this
    // same messageId (`decideOnExistingMarker`, pubsub-dedupe-logic.ts), so
    // committing COMPLETED after a FAILED notification throws away the one
    // delivery that could still have healed it — the failure permanently
    // silences its own retry. `FAILED` clears the lease and returns `RUN`
    // ("reclaim_after_failure"), so a redelivery re-notifies.
    //
    // THIS CANNOT LOOP, and the reason is NOT a delivery-attempt cap: the DLQ
    // subscription `dead-letter-${ENV}-push` deliberately has NO dead-letter
    // policy and therefore no `--max-delivery-attempts`
    // (workers/scripts/setup-pubsub.sh — "a DLQ for the DLQ is a loop with
    // extra steps"). The real bound is that this route ACKs unconditionally:
    // `routes/dead-letter.ts` returns 200 on every path including a throw, so
    // the delivery ENDS here regardless of the marker. Releasing FAILED never
    // causes a redelivery — it only stops one Pub/Sub independently decides to
    // make (at-least-once duplicate, a 60s ack-deadline overrun, an instance
    // restart before the ack lands) from being discarded as a duplicate. Each
    // such delivery notifies at most once more and then acks, and the message
    // is gone at `--message-retention-duration=7d` at the latest.
    //
    // The cost of being wrong in this direction is a DUPLICATE founder
    // notification when a partial write is redelivered. The cost of the old
    // behaviour was a dead letter nobody ever heard about. Duplicate is loud;
    // silent is not.
    await releaseMessage(record.messageId, error ? "FAILED" : "COMPLETED");
  }

  return { acked: true, duplicate: false, notified, error };
}

/** What `notifyFounders` actually managed to do. */
interface NotifyOutcome {
  /** Recipients we tried to write a notification for. 0 = nobody is listening. */
  attempted: number;
  /** Recipients whose notification row was CONFIRMED written. */
  created: number;
}

/**
 * Write one in-app notification per configured recipient.
 *
 * Uses the EXISTING `lib/notifications.ts` service rather than a new one, so
 * these land in the same inbox as every other worker notification and inherit
 * its "log, never throw" contract. Type is `SYSTEM` — the only member of
 * `VALID_NOTIFICATION_TYPES` that means "infrastructure event", as opposed to
 * the four *_COMPLETE types which all claim work succeeded.
 *
 * MONEY-1238: this returned a bare `true` from the end of the loop, which is
 * "no exception was thrown", not "a notification exists". It goes through
 * `tryCreateNotification` now and COUNTS, because the caller commits a dedupe
 * marker on the answer. `attempted` and `created` are kept separate so the
 * caller can tell "the alert list resolves to nobody" (a config fault that
 * silences the whole DLQ) apart from "the writes failed" (a transient fault
 * worth retrying) — conflating them into one boolean is what made the original
 * bug invisible.
 */
async function notifyFounders(
  record: DeadLetterRecord,
): Promise<NotifyOutcome> {
  const emails = resolveDlqAlertEmails(process.env);
  const recipients = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });

  if (recipients.length === 0) {
    // QA databases legitimately have no founder row, so this does not throw.
    // It is still REPORTED (`no_recipients`) rather than swallowed: on prod a
    // `DLQ_ALERT_EMAILS` alias with no matching `User` row means every dead
    // letter is unreported, and the old code answered that with `notified:false`
    // plus a marker that said COMPLETED.
    console.warn(
      `[dead-letter] no user rows for ${emails.length} alert email(s); ` +
        "notification skipped (the log line above is the record)",
    );
    return { attempted: 0, created: 0 };
  }

  const { title, message, metadata } = buildDeadLetterNotification(record);
  let created = 0;
  for (const user of recipients) {
    const ok = await tryCreateNotification({
      userId: user.id,
      type: "SYSTEM",
      title,
      message,
      metadata,
    });
    if (ok) created++;
  }
  return { attempted: recipients.length, created };
}
