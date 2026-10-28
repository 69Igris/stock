/**
 * Clerk Delete Sweep Processor (MONEY-144)
 *
 * Phase 6 of the lock-then-purge delete flow. The account-deletion
 * worker terminates with `DeletedUserAudit.status = "LOCKED"` after the
 * user's data is gone but while their Clerk identity is still locked
 * (i.e. the email is reserved for 24h, preventing immediate re-signup
 * with the same email).
 *
 * This sweep runs hourly via Cloud Scheduler. It selects rows where:
 *
 *   status = "LOCKED" AND clerkDeleteScheduledFor <= now
 *
 * For each one, calls Clerk's `users.deleteUser`, stamps
 * `clerkUserDeletedAt`, and flips status to `COMPLETED`. The index
 * `[status, clerkDeleteScheduledFor]` makes the query a single range
 * scan even with thousands of historical audit rows.
 *
 * Failure handling: each row is processed independently. A failure on
 * one row stamps it FAILED and skips to the next. The whole sweep
 * returns 200 (success) even if some rows failed - Pub/Sub retrying
 * the entire batch would just re-attempt the already-failed rows.
 */

import { createClerkClient } from "@clerk/backend";
import {
  completeDeletionAfterClerkPurge,
  findClerkDeletionsReadyForPurge,
  markDeletionFailed,
} from "@usemoney/services";
import type { ClerkDeleteSweepMessage } from "@usemoney/types/pubsub";

let _clerk: ReturnType<typeof createClerkClient> | null = null;
function getClerk() {
  if (_clerk) return _clerk;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "CLERK_SECRET_KEY env var is required for clerk-delete-sweep",
    );
  }
  _clerk = createClerkClient({ secretKey });
  return _clerk;
}

function isClerkUserNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string; clerkError?: boolean };
  return (
    e.clerkError === true &&
    (e.status === 404 || e.code === "resource_not_found")
  );
}

export interface ClerkDeleteSweepResult {
  processed: number;
  completed: number;
  skipped: number;
  failed: number;
}

export async function processClerkDeleteSweepJob(
  data: ClerkDeleteSweepMessage,
): Promise<ClerkDeleteSweepResult> {
  const now = data.now ? new Date(data.now) : new Date();
  const batchSize = data.batchSize ?? 100;

  const ready = await findClerkDeletionsReadyForPurge({ now, take: batchSize });
  if (!ready.success) {
    throw new Error(
      `findClerkDeletionsReadyForPurge failed: ${ready.error}`,
    );
  }

  const result: ClerkDeleteSweepResult = {
    processed: ready.data.length,
    completed: 0,
    skipped: 0,
    failed: 0,
  };

  console.log(
    `[clerk-delete-sweep] Processing ${ready.data.length} rows (cutoff=${now.toISOString()})`,
  );

  for (const row of ready.data) {
    if (!row.clerkId) {
      // Legacy audit with no clerk id - nothing to purge, just flip
      // to COMPLETED so the row exits the sweep query.
      await completeDeletionAfterClerkPurge(row.id);
      result.skipped += 1;
      continue;
    }
    try {
      try {
        await getClerk().users.deleteUser(row.clerkId);
        console.log(
          `[clerk-delete-sweep] Clerk user purged clerkId=${row.clerkId} auditId=${row.id}`,
        );
      } catch (clerkErr) {
        if (!isClerkUserNotFound(clerkErr)) throw clerkErr;
        console.log(
          `[clerk-delete-sweep] Clerk user already gone clerkId=${row.clerkId} auditId=${row.id}`,
        );
      }
      await completeDeletionAfterClerkPurge(row.id);
      result.completed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[clerk-delete-sweep] Failed auditId=${row.id} clerkId=${row.clerkId}:`,
        err,
      );
      await markDeletionFailed(
        row.id,
        `clerk-delete-sweep: ${message}`,
      );
      result.failed += 1;
    }
  }

  console.log(
    `[clerk-delete-sweep] Done: processed=${result.processed} completed=${result.completed} skipped=${result.skipped} failed=${result.failed}`,
  );
  return result;
}
