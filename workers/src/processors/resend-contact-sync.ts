/**
 * Resend Contact Sync Processor (rewritten MONEY-144)
 *
 * Ensures all users in the database are synced to Resend audiences.
 * Runs weekly via Cloud Scheduler to backfill any contacts the Clerk
 * webhook missed (Resend fire-and-forget failure, transient outage,
 * subscription change with no webhook fired etc.).
 *
 * Segments:
 *  - Free users               -> RESEND_AUDIENCE_FREE_ID
 *  - Paid users               -> RESEND_AUDIENCE_PAID_ID
 *  - Previously-paid free     -> RESEND_AUDIENCE_DOWNGRADED_ID (if configured)
 *  - All users                -> RESEND_AUDIENCE_USEMONEY_SECURITY_ID
 *  - Opted-in marketing users -> RESEND_AUDIENCE_MARKETING_ID
 *
 * MONEY-144 - DIFFERENTIAL sync. The previous implementation made 5-6
 * Resend API calls PER USER PER RUN unconditionally (3 DELETEs from
 * "wrong" tier audiences + 1 POST to target + 1 POST to security +
 * maybe 1 POST to marketing). On a 10k-user DB that's 50k-60k API
 * calls per cron tick, generating the 2.8M-log spam in the Resend
 * dashboard.
 *
 * The fix:
 *   1. Skip users whose User.updatedAt AND Subscription.updatedAt are
 *      both <= lastResendSyncAt. Unchanged users -> zero API calls.
 *   2. Only DELETE from the old tier audience when the tier ACTUALLY
 *      changes (tracked in User.resendAudienceTier). No more blanket
 *      DELETEs.
 *   3. Security audience POST only on first sync (assume admin doesn't
 *      remove from Resend dashboard). forceResync overrides.
 *   4. Marketing audience POST only on first sync or forceResync.
 *
 * forceResync=true bypasses all watermarks and re-runs everything for
 * everyone - used for admin rescue / schema-shape migrations.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { Resend } from "resend";
import type { ResendContactSyncMessage } from "@usemoney/types/pubsub";
import {
  RATE_LIMIT_MS,
  isPaidSubscription,
  resolveTargetTier,
  splitName,
  shouldSyncToMarketing,
  shouldLogProgress,
} from "./resend-contact-sync-logic";

const logger = {
  info: (...args: unknown[]) => console.log("[resend-sync]", ...args),
  warn: (...args: unknown[]) => console.warn("[resend-sync]", ...args),
  error: (...args: unknown[]) => console.error("[resend-sync]", ...args),
};

interface SyncStats {
  total: number;
  skippedUnchanged: number;
  synced: number;
  tierMoved: number;
  errors: number;
  apiCalls: number;
}

export async function processResendContactSync(
  message: ResendContactSyncMessage,
): Promise<void> {
  const { forceResync = false } = message;

  const apiKey = process.env.RESEND_API_KEY;
  const freeAudienceId = process.env.RESEND_AUDIENCE_FREE_ID;
  const paidAudienceId = process.env.RESEND_AUDIENCE_PAID_ID;
  const downgradedAudienceId = process.env.RESEND_AUDIENCE_DOWNGRADED_ID;
  const securityAudienceId = process.env.RESEND_AUDIENCE_USEMONEY_SECURITY_ID;
  const marketingAudienceId = process.env.RESEND_AUDIENCE_MARKETING_ID;

  if (!apiKey || !freeAudienceId || !paidAudienceId || !securityAudienceId) {
    logger.warn("Missing Resend env vars - skipping contact sync");
    // KNOWN GAP, MONEY-1250. This is the "an env var unset, so a provider never
    // registered" shape the zero-write monitor names, and the monitor cannot
    // catch it here: the guard fires BEFORE the user query, so the run has no
    // honest number for how many contacts it would have selected. Reporting a
    // made-up `selected` to force an alert would be a count that means nothing,
    // which is the defect this whole ticket is about. The run is visible in the
    // structured `job-outcome` line and its `skippedReason` instead.
    reportJobOutcome({
      job: "resend-contact-sync",
      selected: 0,
      written: 0,
      skippedReason:
        "Resend env vars missing (RESEND_API_KEY / _AUDIENCE_FREE_ID / " +
        "_AUDIENCE_PAID_ID / _AUDIENCE_USEMONEY_SECURITY_ID) — no contact " +
        "was examined",
    });
    return;
  }

  if (!downgradedAudienceId) {
    logger.warn(
      "RESEND_AUDIENCE_DOWNGRADED_ID not set - downgraded users stay in free",
    );
  }

  const resend = new Resend(apiKey);

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      emailPreferences: true,
      updatedAt: true,
      lastResendSyncAt: true,
      resendAudienceTier: true,
      subscription: {
        select: { planId: true, status: true, updatedAt: true },
      },
      payments: {
        where: { status: "COMPLETED" },
        select: { id: true },
        take: 1,
      },
    },
  });

  logger.info(
    `Found ${users.length} users; mode=${forceResync ? "FORCE" : "DIFFERENTIAL"}`,
  );

  const stats: SyncStats = {
    total: users.length,
    skippedUnchanged: 0,
    synced: 0,
    tierMoved: 0,
    errors: 0,
    apiCalls: 0,
  };

  for (let i = 0; i < users.length; i++) {
    const user = users[i]!;

    // Differential check: skip users with no changes since last sync.
    // forceResync bypasses this entirely. New users (lastResendSyncAt
    // = null) always get processed.
    if (!forceResync && user.lastResendSyncAt) {
      const userChanged = user.updatedAt > user.lastResendSyncAt;
      const subChanged =
        user.subscription &&
        user.subscription.updatedAt > user.lastResendSyncAt;
      if (!userChanged && !subChanged) {
        stats.skippedUnchanged++;
        continue;
      }
    }

    const hasEverPaid = user.payments.length > 0;

    const tier = resolveTargetTier(
      user.subscription,
      hasEverPaid,
      !!downgradedAudienceId,
    );
    const targetTierId =
      tier === "paid"
        ? paidAudienceId
        : tier === "downgraded"
          ? downgradedAudienceId!
          : freeAudienceId;

    const isFirstSync = !user.lastResendSyncAt;
    const oldTierId = user.resendAudienceTier;
    const tierChanged = oldTierId !== targetTierId;

    const { firstName, lastName } = splitName(user.name);

    try {
      // 1. Remove from OLD tier audience only if user actually moved tiers.
      // This is the call that was previously fired 3x per user per run
      // unconditionally - now it fires zero or one time, only when needed.
      if (oldTierId && tierChanged) {
        await resend.contacts
          .remove({ audienceId: oldTierId, email: user.email })
          .catch(() => {
            // "Contact not found" is expected if Resend audience was
            // edited externally - ignore silently.
          });
        stats.apiCalls++;
        await sleep(RATE_LIMIT_MS);
      }

      // 2. Add/refresh on target tier audience. Skip if already there
      // and nothing changed (covered by the differential pre-check
      // above, but double-guard for tier-already-correct case on first
      // sync of a user that was added in real-time by the webhook).
      if (isFirstSync || tierChanged) {
        await resend.contacts.create({
          audienceId: targetTierId,
          email: user.email,
          firstName,
          lastName,
          unsubscribed: false,
        });
        stats.apiCalls++;
        await sleep(RATE_LIMIT_MS);
        if (tierChanged && !isFirstSync) stats.tierMoved++;
      }

      // 3. Security audience: every user, always. POST only on first sync
      // (Clerk webhook adds new users in real-time; weekly cron is the
      // backfill for missed users). Admin can use forceResync to repair
      // if records were removed from the Resend dashboard.
      if (isFirstSync || forceResync) {
        await resend.contacts.create({
          audienceId: securityAudienceId,
          email: user.email,
          firstName,
          lastName,
          unsubscribed: false,
        });
        stats.apiCalls++;
        await sleep(RATE_LIMIT_MS);
      }

      // 4. Marketing audience: opted-in users only. Same first-sync /
      // forceResync gate as security.
      if (
        marketingAudienceId &&
        shouldSyncToMarketing(
          user.emailPreferences as Record<string, unknown> | null | undefined,
        ) &&
        (isFirstSync || forceResync)
      ) {
        await resend.contacts.create({
          audienceId: marketingAudienceId,
          email: user.email,
          firstName,
          lastName,
          unsubscribed: false,
        });
        stats.apiCalls++;
        await sleep(RATE_LIMIT_MS);
      }

      // 5. Stamp watermark and tier so the next differential run can skip.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          lastResendSyncAt: new Date(),
          resendAudienceTier: targetTierId,
        },
      });
      stats.synced++;
    } catch (err) {
      stats.errors++;
      logger.error(
        `Failed to sync ${user.email}: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (shouldLogProgress(i)) {
      logger.info(
        `Progress: ${i + 1}/${users.length} synced=${stats.synced} skipped=${stats.skippedUnchanged} api=${stats.apiCalls} errors=${stats.errors}`,
      );
    }
  }

  logger.info(
    `Resend sync complete: total=${stats.total} synced=${stats.synced} ` +
      `skippedUnchanged=${stats.skippedUnchanged} tierMoved=${stats.tierMoved} ` +
      `apiCalls=${stats.apiCalls} errors=${stats.errors}`,
  );

  // MONEY-1250 — `selected` is CHANGED users, not all users.
  //
  // The differential sync (MONEY-144) exists so an unchanged user costs zero
  // API calls, which means a week in which nobody changed writes nothing and is
  // perfectly healthy. Pairing `stats.total` with `stats.synced` would report
  // `selected 10000, written 0` on exactly that week. Subtracting
  // `skippedUnchanged` leaves the users the run DECIDED to process, and every
  // one of those is owed the `prisma.user.update` watermark stamp at the end of
  // its loop body — so `written` and `selected` are the same population counted
  // before and after the work.
  //
  // That makes `selected > 0 && written === 0` mean "every changed user failed
  // to sync", which is what a revoked RESEND_API_KEY looks like: the tier POST
  // throws, the catch counts an error, and the watermark is never stamped — so
  // the same users are re-selected next week and it alarms again.
  const candidates = stats.total - stats.skippedUnchanged;
  reportJobOutcome({
    job: "resend-contact-sync",
    selected: candidates,
    written: stats.synced,
    failed: stats.errors,
    ...(stats.synced < candidates
      ? {
          skippedReason:
            `${candidates - stats.synced} of ${candidates} changed user(s) ` +
            `not stamped (${stats.errors} error(s)); ` +
            `${stats.skippedUnchanged} unchanged user(s) skipped by design`,
        }
      : {}),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
