/**
 * Account Deletion Processor (MONEY-391 → MONEY-445 → MONEY-144)
 *
 * MONEY-144 changeset:
 *   - Phase 1 now LOCKS the Clerk user instead of deleting it. Locking
 *     invalidates the session (same UX as delete) but keeps the email
 *     reserved in Clerk's namespace for 24h so the same email cannot
 *     re-signup and inherit a half-deleted account.
 *   - DB delete is now ordered BEFORE the confirmation email so the
 *     email goes out only after the user's data is actually gone (the
 *     promise we make to the user).
 *   - The audit row terminates at status=LOCKED in this worker. A
 *     separate hourly `clerk-delete-sweep` worker picks LOCKED rows
 *     where `clerkDeleteScheduledFor <= now`, calls Clerk's deleteUser
 *     to release the email, and stamps status=COMPLETED.
 *
 * Phase order (each phase idempotent via timestamp stamps):
 *
 *   0. Audit row             - getOrCreateInProgressAudit
 *   1. Clerk LOCK            - users.lockUser; invalidates session FIRST
 *                              so any in-flight server action bounces
 *                              to sign-in before a phantom user row can
 *                              be recreated. Stamps clerkLockedAt +
 *                              clerkDeleteScheduledFor (= now + 24h).
 *   2. Snapshot              - capture portfolio + billing values AND
 *                              operational counts (chats, research,
 *                              comparisons, strategies, etc.) before
 *                              child data is gone.
 *   3. Dodo cancel           - best-effort; reads dodoSubscriptionId
 *                              from the audit row (written in Phase 2).
 *   4. User row delete       - cascades to all child models. Stamps
 *                              dbHardDeletedAt + flips status to LOCKED.
 *   5. Confirmation email    - sent LAST so the user's "deletion done"
 *                              email only goes out after the data is
 *                              actually gone.
 *
 * (Phase 6 — Clerk hard delete after 24h — lives in clerk-delete-sweep.)
 *
 * Failure handling: each phase service helper returns ServiceResult;
 * on a non-success return we throw so Pub/Sub retries with backoff,
 * but we also stamp the audit row FAILED so admin tooling can triage.
 */

import { createClerkClient } from "@clerk/backend";
import { sendEmail } from "@usemoney/email";
import { AccountDeletedEmail } from "@usemoney/email/templates";
import {
  getOrCreateInProgressAudit,
  captureSnapshotIntoAudit,
  cancelDodoFromAudit,
  finalizeUserDelete,
  markClerkUserLocked,
  markDeletionEmailSent,
  markDeletionFailed,
} from "@usemoney/services";
import type { AccountDeletionMessage } from "@usemoney/types/pubsub";
import React from "react";

let _clerk: ReturnType<typeof createClerkClient> | null = null;
function getClerk() {
  if (_clerk) return _clerk;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "CLERK_SECRET_KEY env var is required for account deletion",
    );
  }
  _clerk = createClerkClient({ secretKey });
  return _clerk;
}

/**
 * Clerk's 404 on user ban = already gone. Treat as success.
 *
 * 422 with errors[].code === "user_banned" / "already_a_member" = already
 * banned (idempotent retry). Same.
 *
 * Why ban and not lock: `lockUser` auto-unlocks after the dashboard-
 * configured lockout TTL (default ~60 min), which silently reverses
 * Phase 1 long before the 24h email-reservation window we promised
 * to the user. `banUser` has no TTL - the user stays banned until
 * we explicitly call `deleteUser` (the 24h sweep) or `unbanUser`.
 */
function isClerkAlreadyBannedOrGone(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    code?: string;
    clerkError?: boolean;
    errors?: Array<{ code?: string }>;
  };
  if (!e.clerkError) return false;
  if (e.status === 404 || e.code === "resource_not_found") return true;
  if (
    e.status === 422 &&
    Array.isArray(e.errors) &&
    e.errors.some(
      (x) => x?.code === "user_banned" || x?.code === "already_a_member",
    )
  ) {
    return true;
  }
  return false;
}

/**
 * MONEY-144 follow-up: Clerk's `lockUser` blocks future sign-ins but
 * does NOT revoke active sessions — the user's existing browser
 * cookie keeps working until it expires (default 7d). We must
 * explicitly revoke each active session so the user is signed out of
 * every device/tab immediately. Best-effort: failures are logged but
 * don't block the rest of the pipeline (the audit row is the source
 * of truth and the User row delete + email still need to run).
 */
async function revokeAllSessions(clerkId: string): Promise<void> {
  try {
    const list = await getClerk().sessions.getSessionList({
      userId: clerkId,
    });
    const sessions = Array.isArray(list)
      ? list
      : (list as { data?: unknown[] }).data ?? [];
    let revoked = 0;
    for (const s of sessions) {
      const session = s as { id: string; status: string };
      if (session.status !== "active") continue;
      try {
        await getClerk().sessions.revokeSession(session.id);
        revoked += 1;
      } catch (revokeErr) {
        console.error(
          `[account-deletion] revokeSession failed sessionId=${session.id}:`,
          revokeErr,
        );
      }
    }
    console.log(
      `[account-deletion] Revoked ${revoked}/${sessions.length} sessions for clerkId=${clerkId}`,
    );
  } catch (err) {
    console.error(
      `[account-deletion] revokeAllSessions failed clerkId=${clerkId}:`,
      err,
    );
  }
}

export async function processAccountDeletionJob(
  data: AccountDeletionMessage,
): Promise<void> {
  const {
    userId,
    clerkId,
    email,
    name,
    deletedBy,
    reason,
    ipAddress,
    userAgent,
    adminUserId,
  } = data;

  // Phase 0 - Audit row (idempotent: returns existing PROCESSING row if any).
  const auditResult = await getOrCreateInProgressAudit({
    userId,
    clerkId,
    email,
    name,
    deletedBy,
    reason,
    ipAddress,
    userAgent,
    adminUserId,
  });
  if (!auditResult.success) {
    throw new Error(
      `getOrCreateInProgressAudit failed: ${auditResult.error}`,
    );
  }
  const audit = auditResult.data;
  const auditId = audit.id;

  try {
    // Phase 1 - Clerk BAN + revoke active sessions.
    // banUser holds the email reserved with NO TTL (lockUser auto-
    // unlocks after ~60min and the user can sign back in - breaks
    // the 24h promise); revokeSession kills the active browser cookie
    // immediately (ban alone does not invalidate live sessions).
    //
    // MONEY-1157 — the `!audit.clerkLockedAt &&` idempotency guard that used to
    // lead this condition was DEAD, and removing it is runtime-identical.
    // `getOrCreateInProgressAudit` selects through `PIPELINE_AUDIT_SELECT`
    // (packages/services/src/account-deletion.service.ts), which does not include
    // `clerkLockedAt`, so the field was `undefined` on every row and the conjunct
    // was always true — this phase has always re-run on a Pub/Sub re-delivery.
    // `tsc` had been reporting it the whole time (TS2339: the property is not on
    // `AuditPipelineRow`); `tsup`/esbuild never type-checks, so nothing surfaced it.
    //
    // NOT restored here because that is a behaviour change, not a type fix: add
    // `clerkLockedAt` to `AuditPipelineRow` + `PIPELINE_AUDIT_SELECT` (2 lines,
    // outside workers/) and the guard starts working. It is worth doing — a
    // re-delivery currently re-stamps `clerkLockedAt` AND pushes
    // `clerkDeleteScheduledFor` out another 24h (`markClerkUserLocked`), delaying
    // the email release the 24h lock exists to schedule. The ban itself is
    // idempotent (`isClerkAlreadyBannedOrGone`), so nothing is corrupted today.
    if (clerkId) {
      try {
        await getClerk().users.banUser(clerkId);
        console.log(
          `[account-deletion] Clerk user banned clerkId=${clerkId} auditId=${auditId}`,
        );
      } catch (clerkErr) {
        if (!isClerkAlreadyBannedOrGone(clerkErr)) throw clerkErr;
        console.log(
          `[account-deletion] Clerk user already banned/gone clerkId=${clerkId} auditId=${auditId}`,
        );
      }
      await revokeAllSessions(clerkId);
      await markClerkUserLocked(auditId);
    }

    // Phase 2 - Snapshot (portfolio + billing + operational counts).
    if (!audit.snapshotCapturedAt) {
      const snap = await captureSnapshotIntoAudit(auditId, userId);
      if (!snap.success) {
        throw new Error(`Snapshot failed: ${snap.error}`);
      }
    }

    // Phase 3 - Dodo cancel (best-effort).
    if (!audit.dodoCancelledAt) {
      const dodo = await cancelDodoFromAudit(auditId);
      if (!dodo.success) {
        // Log but don't fail - the user's data still needs to be deleted.
        console.error(
          `[account-deletion] Dodo cancel failed auditId=${auditId}: ${dodo.error}`,
        );
      }
    }

    // Phase 4 - User row delete (BEFORE the email, so the email is
    // only sent after the data is actually gone). Flips status=LOCKED.
    if (!audit.dbHardDeletedAt) {
      const fin = await finalizeUserDelete(auditId, userId);
      if (!fin.success) {
        throw new Error(`Finalize user delete failed: ${fin.error}`);
      }
      console.log(
        `[account-deletion] User row deleted userId=${userId} auditId=${auditId}`,
      );
    }

    // Phase 5 - Confirmation email (LAST).
    // sendEmail returns { success, error } - it does NOT throw on
    // Resend API errors. Must check the returned `success` so we
    // don't stamp confirmationEmailSentAt + log "sent" when delivery
    // actually failed (bug surfaced in QA: react-dom missing in
    // worker image silently failed every account-deleted email).
    if (!audit.confirmationEmailSentAt) {
      try {
        const sendResult = await sendEmail({
          to: email,
          subject: "Your UseMoney account has been deleted",
          react: React.createElement(AccountDeletedEmail, {
            name: name || "there",
          }),
          template: "account-deleted",
        });
        if (sendResult.success) {
          await markDeletionEmailSent(auditId);
          console.log(
            `[account-deletion] Confirmation email sent email=${email} auditId=${auditId}`,
          );
        } else {
          console.error(
            `[account-deletion] Email send failed email=${email} auditId=${auditId}: ${sendResult.error}`,
          );
        }
      } catch (emailErr) {
        // Don't throw - email is non-critical at this point; admin can
        // re-send from the audit row. The 24h sweep still proceeds.
        console.error(
          `[account-deletion] Email send threw email=${email} auditId=${auditId}:`,
          emailErr,
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markDeletionFailed(auditId, message);
    throw err; // Re-throw so Pub/Sub retries with backoff
  }
}
