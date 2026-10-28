/**
 * Clerk Webhook Handler (MONEY-144 + MONEY-391)
 *
 * Handles Clerk user events for proactive user sync:
 * - user.created: Atomically create User + FREE Subscription row
 * - user.updated: Idempotent re-sync (same path as created, safe to retry)
 * - user.deleted: No-op if user already gone (server-side delete owns hard-delete);
 *                 otherwise hard-delete cascade (legacy Clerk-initiated deletes)
 * - session.created: Trigger login briefing for paid users
 *
 * Idempotency: every handler can be called multiple times for the same event
 * (Svix retries, manual replay, weekly reconciliation worker) without
 * creating duplicates or breaking existing state.
 *
 * Setup in Clerk Dashboard:
 * 1. Go to Webhooks section
 * 2. Add endpoint: https://your-domain.com/api/webhooks/clerk
 * 3. Select events: user.created, user.updated, user.deleted, session.created
 * 4. Copy the signing secret to CLERK_WEBHOOK_SECRET env var
 */

import { Webhook } from "svix";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import {
  sendEmail,
  addContactToSegment,
  removeContactFromSegment,
  RESEND_AUDIENCE_FREE_ID,
} from "@usemoney/email";
import { WelcomeEmail, AccountDeletedEmail } from "@usemoney/email/templates";
import { clearAllUserCache } from "@usemoney/core";
import { ensureUserAndSubscription } from "@usemoney/services";
import { publishLoginBriefingJob } from "@usemoney/pubsub/publish";
import {
  validateSvixHeaders,
  getPrimaryEmail,
  getFullName,
  buildContentAuthorImageSyncUpdate,
  type ClerkUserData,
  type ClerkSessionData,
  type WebhookEvent,
  welcomeClaimWhere,
  shouldQueueBriefing,
} from "./clerk-webhook-logic";
import React from "react";

export async function POST(req: Request) {
  // Get the headers
  const headerPayload = await headers();
  const svixId = headerPayload.get("svix-id");
  const svixTimestamp = headerPayload.get("svix-timestamp");
  const svixSignature = headerPayload.get("svix-signature");

  // If there are no headers, error out
  const headerCheck = validateSvixHeaders({
    "svix-id": svixId,
    "svix-timestamp": svixTimestamp,
    "svix-signature": svixSignature,
  });
  // The `|| !svixId ...` is redundant at runtime (the helper already covers it)
  // but narrows all three from `string | null` to `string` for `wh.verify`.
  if (!headerCheck.valid || !svixId || !svixTimestamp || !svixSignature) {
    console.error("Missing svix headers");
    return new Response("Missing svix headers", { status: 400 });
  }

  // Get the body
  const payload = await req.json();
  const body = JSON.stringify(payload);

  // Get webhook secret
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("CLERK_WEBHOOK_SECRET not set");
    return new Response("Server configuration error", { status: 500 });
  }

  // Verify the webhook signature
  const wh = new Webhook(webhookSecret);
  let evt: WebhookEvent;

  try {
    evt = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as WebhookEvent;
  } catch (err) {
    console.error("Webhook verification failed:", err);
    return new Response("Webhook verification failed", { status: 400 });
  }

  // Handle the event
  const eventType = evt.type;
  console.log(
    `[Clerk Webhook] event=${eventType} svixId=${svixId} clerkId=${evt.data.id}`
  );

  try {
    switch (eventType) {
      case "user.created":
        await handleUserCreated(evt.data);
        break;

      case "user.updated":
        await handleUserUpdated(evt.data);
        break;

      case "user.deleted":
        await handleUserDeleted(evt.data);
        break;

      case "session.created":
        // Cast at the boundary: `evt.data` is typed as the user payload for the
        // four user.* events, but Clerk sends a SESSION here. See
        // ClerkSessionData for what that difference cost.
        await handleSessionCreated(evt.data as unknown as ClerkSessionData);
        break;

      default:
        console.log(`[Clerk Webhook] Unhandled event type: ${eventType}`);
    }

    return new Response("Success", { status: 200 });
  } catch (error) {
    console.error(
      `[Clerk Webhook] Error handling ${eventType} svixId=${svixId}:`,
      error
    );
    // Return 500 so Svix retries — handler is idempotent so retry is safe
    return new Response("Error processing webhook", { status: 500 });
  }
}

/**
 * MONEY-144 — true if a DeletedUserAudit row exists for this clerkId in
 * any in-flight state. Used by user.updated and user.deleted handlers to
 * bow out so the account-deletion worker pipeline owns the lifecycle.
 *
 * - PENDING/PROCESSING: account-deletion worker is mid-pipeline
 * - LOCKED: account-deletion worker is done; clerk-delete-sweep
 *   pending or in progress (24h purge window)
 */
async function hasInFlightDeletion(clerkId: string): Promise<boolean> {
  try {
    const audit = await prisma.deletedUserAudit.findFirst({
      where: {
        clerkId,
        status: { in: ["PENDING", "PROCESSING", "LOCKED"] },
      },
      select: { id: true },
    });
    return audit !== null;
  } catch (err) {
    // Don't block the webhook on the audit lookup; worst case is we
    // run the legacy hardDeleteUser path, which itself is idempotent.
    console.warn("[Clerk Webhook] hasInFlightDeletion lookup failed:", err);
    return false;
  }
}

/**
 * MONEY-523 — one-time Resend onboarding for a freshly-synced user.
 *
 * Fires the welcome email and adds the contact to the "free" + security
 * audiences, then stamps `lastResendSyncAt`/`resendAudienceTier` so this never
 * runs twice (Svix retries, user.updated, and the weekly backfill all skip a
 * stamped user).
 *
 * Why this exists: the previous code gated the sync on `created.user` (was the
 * DB row created BY this webhook?). But after Clerk sign-up the user is
 * redirected straight into the app, and a lazy `getOrCreateUser()` server
 * action usually creates the row first — so `created.user` was false and the
 * sync silently never ran. Gating on the durable `lastResendSyncAt` watermark
 * instead is immune to that race.
 *
 * Awaited (not fire-and-forget): on Vercel the function can freeze the moment
 * the 200 response is returned, dropping un-awaited HTTP calls. The email /
 * segment helpers are internally try/caught and never throw, so awaiting them
 * is safe and adds only a few hundred ms to the webhook round-trip.
 */
async function syncNewContactToResend(args: {
  userId: string;
  email: string;
  name: string;
}): Promise<void> {
  const { userId, email, name } = args;
  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ") || undefined;
  const contact = { email, firstName: firstName || undefined, lastName };

  // MONEY-878 — log the email DOMAIN only (never the local-part) so a failed
  // welcome is diagnosable from logs without leaking PII.
  const emailDomain = email.includes("@")
    ? email.slice(email.indexOf("@") + 1)
    : "unknown";

  // MONEY-878 — one concise breadcrumb that the welcome/onboarding branch ran,
  // so a "no welcome email" report can be traced to whether we even got here.
  console.log(
    `[Clerk Webhook] welcome onboarding branch entered (domain=${emailDomain})`
  );

  // MONEY-878 — the most common silent failure: this webhook runtime has no
  // RESEND_API_KEY, so the welcome send AND both segment adds below all return
  // {success:false}. getResendClient() throws when it's unset, but the email
  // helpers swallow that into {success:false}, so without this line the root
  // cause is invisible. Make it LOUD and obviously a config gap.
  if (!process.env.RESEND_API_KEY) {
    console.error(
      `[Clerk Webhook] RESEND_API_KEY is NOT set in this runtime — welcome email ` +
        `+ segment adds will all fail (domain=${emailDomain}). Set RESEND_API_KEY ` +
        `in the Vercel env for this environment.`
    );
  }

  // Claim the welcome email exactly once — atomically, on the (shared) DB — so a
  // user.created + user.updated race, Svix retries, OR duplicate processing
  // across shared-infra environments (local + QA share one Clerk/DB/Resend, so a
  // single signup's webhook is handled by both endpoints) can't send it twice.
  // This is decoupled from the segment-gated `lastResendSyncAt` stamp below,
  // which is deliberately left null on segment-add failure so the weekly backfill
  // retries the audiences — that coupling is exactly what caused the duplicate
  // welcomes (segments unconfigured → watermark never stamped → every event
  // re-sent the email).
  // THE CLAIM MATCHED NOTHING — MONEY-1236.
  //
  // `welcomeEmailSentAt` is optional and no create path writes it, so on
  // MongoDB it is ABSENT — and Prisma's connector does NOT match an absent
  // field with `{field: null}`. Measured on prod 2026-08-21: 653 of 653 users
  // have it absent, 0 null, 0 set. This claim has therefore returned
  // `count: 0` for every signup since it shipped (fc1cc01b, 2026-06-26),
  // `sendWelcome` has been false every time, and NOBODY has received a welcome
  // email — silently, because `count: 0` is exactly what "already sent" looks
  // like.
  //
  // Both shapes are matched deliberately. ABSENT means never attempted.
  // EXPLICIT NULL means attempted and FAILED: the MONEY-877 unwind below
  // resets the watermark to null so the next event retries, and that retry
  // path is the only one this filter ever worked for.
  //
  // THE AGE GATE IS NOT DECORATION. This claim runs from `user.created` AND
  // `user.updated`, and `user.updated` fires on any Clerk profile change — so
  // repairing the filter ALONE would mean the next profile edit by any of the
  // 653 existing users wins the claim and sends them a welcome email months
  // after signup. Bounding by account age makes the fix safe to deploy on its
  // own, with no ordering dependency on a backfill. Measured:
  //
  //     within  7d:  5 users        within 60d:  68
  //     within 14d: 12 users        within 90d: 100
  //     within 30d: 22 users        all time:   653
  //
  // At 30 days at most 22 people can receive a late welcome, and only if they
  // trigger another webhook. Someone missed three weeks ago is owed one;
  // someone who signed up in January is not. Set this to 0 for a pure
  // go-forward cutover, and/or run
  // `scripts/migrations/stamp-welcome-email-backfill.ts` to stamp everyone.
  const welcomeClaim = await prisma.user.updateMany({
    where: welcomeClaimWhere(userId, new Date()),
    data: { welcomeEmailSentAt: new Date() },
  });
  const sendWelcome = welcomeClaim.count === 1;

  const [welcomeResult, freeResult, securityResult] = await Promise.all([
    // Welcome email — sent only by the caller that won the claim above.
    sendWelcome
      ? sendEmail({
          to: email,
          subject: "Welcome to UseMoney!",
          react: React.createElement(WelcomeEmail, { name }),
          template: "welcome",
        })
      : Promise.resolve(null),
    // The two audiences every new user must land in (all new users are free).
    addContactToSegment("free", contact),
    addContactToSegment("usemoney-security", contact),
  ]);

  // MONEY-877: the claim above stamps welcomeEmailSentAt BEFORE the send, so a FAILED
  // send (transient Resend error, an unset RESEND_API_KEY, or the Vercel function
  // freezing after the 200) was UNRECOVERABLE — every later user.created/updated event
  // re-entered but the claim then returned count===0 and never retried. If we won the
  // claim but the send did NOT succeed, RESET the watermark so the next webhook event
  // retries the welcome (mirrors the lastResendSyncAt "leave null on failure" pattern).
  if (sendWelcome && welcomeResult && !welcomeResult.success) {
    // MONEY-878 — surface WHY the welcome failed (reason from the email helper)
    // alongside the domain, then fall through to the watermark reset below.
    console.error(
      `[Clerk Webhook] welcome email send FAILED (domain=${emailDomain}, ` +
        `reason=${welcomeResult.error ?? "unknown"}) — resetting welcomeEmailSentAt ` +
        `so the next webhook event retries (MONEY-877)`
    );
    await prisma.user
      .updateMany({
        where: { id: userId },
        data: { welcomeEmailSentAt: null },
      })
      .catch(() => {});
  }

  // MONEY-878 — make each segment-add failure LOUD. The helper logs the precise
  // Resend reason internally; here we surface the consequence + the domain. A
  // {success:false} is almost always a missing RESEND_AUDIENCE_*_ID (logged
  // no-op) or a missing RESEND_API_KEY in this runtime.
  if (!freeResult.success) {
    console.error(
      `[Clerk Webhook] segment add FAILED: "free" (domain=${emailDomain}) — ` +
        `check RESEND_AUDIENCE_FREE_ID + RESEND_API_KEY in this runtime`
    );
  }
  if (!securityResult.success) {
    console.error(
      `[Clerk Webhook] segment add FAILED: "usemoney-security" (domain=${emailDomain}) — ` +
        `check RESEND_AUDIENCE_USEMONEY_SECURITY_ID + RESEND_API_KEY in this runtime`
    );
  }

  // Only stamp the watermark when the contact actually reached the audiences.
  // If Resend is mis-configured or down, leave lastResendSyncAt null so the
  // weekly backfill worker retries — it keys off the same null watermark.
  if (freeResult.success && securityResult.success) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        lastResendSyncAt: new Date(),
        resendAudienceTier: RESEND_AUDIENCE_FREE_ID || null,
      },
    });
    console.log(
      `[Clerk Webhook] Resend onboarding synced + stamped for ${email}`
    );
  } else {
    console.warn(
      `[Clerk Webhook] Resend onboarding incomplete for ${email} ` +
        `(free=${freeResult.success} security=${securityResult.success}) — ` +
        `leaving watermark null for weekly backfill`
    );
  }
}

/**
 * MONEY-1050 — refresh the CMS `ContentAuthor` avatar from the Clerk photo.
 *
 * Fire-and-forget (never throws): a content-author sync failure must not fail
 * the user webhook. No-op when the user has no ContentAuthor row (the guarded
 * updateMany matches nothing) or the event carries no image URL.
 */
async function syncContentAuthorImage(data: ClerkUserData): Promise<void> {
  const update = buildContentAuthorImageSyncUpdate(data.id, data.image_url);
  if (!update) return;
  try {
    const res = await prisma.contentAuthor.updateMany(update);
    if (res.count > 0) {
      console.log(
        `[Clerk Webhook] Synced ContentAuthor avatar for clerkId=${data.id} (${res.count} row)`
      );
    }
  } catch (err) {
    console.warn(
      `[Clerk Webhook] ContentAuthor avatar sync failed for clerkId=${data.id}:`,
      err
    );
  }
}

/**
 * Handle user.created event — creates User + Subscription atomically.
 *
 * Fix for MONEY-144: previously this only created the User row, leaving
 * 215/528 users without a Subscription until they hit an AI surface.
 */
async function handleUserCreated(data: ClerkUserData): Promise<void> {
  const email = getPrimaryEmail(data);

  if (!email) {
    console.warn(`[Clerk Webhook] No email for user ${data.id}, skipping`);
    return;
  }

  const name = getFullName(data);

  // Atomic User + Subscription sync (idempotent on clerkId + email)
  const result = await ensureUserAndSubscription({
    clerkId: data.id,
    email,
    name,
  });

  if (!result.success) {
    console.error(
      `[Clerk Webhook] ensureUserAndSubscription failed for ${email}: ${result.error}`
    );
    // Throw so the outer handler returns 500 → Svix retries
    throw new Error(result.error);
  }

  const { user, created } = result.data;
  console.log(
    `[Clerk Webhook] Synced user=${user.id} email=${email} ` +
      `userCreated=${created.user} subscriptionCreated=${created.subscription}`
  );

  // MONEY-523 — onboard to Resend exactly once, gated on the durable
  // `lastResendSyncAt` watermark instead of the transient `created.user` flag.
  // The old `if (!created.user) return;` guard suppressed the sync whenever a
  // lazy getOrCreateUser() path created the DB row before this webhook landed
  // (the common case, since Clerk redirects into the app instantly on signup).
  if (user.lastResendSyncAt == null) {
    await syncNewContactToResend({ userId: user.id, email, name });
  }

  // MONEY-1050 — keep the CMS author avatar in sync with the Clerk photo.
  await syncContentAuthorImage(data);
}

/**
 * Handle user.updated event — uses the same sync helper as create.
 *
 * The helper resolves by clerkId first, then email, so this safely covers:
 *   - Profile updates (name change)
 *   - Email changes (clerkId still resolves)
 *   - Late user.updated arriving before user.created (creates if missing)
 */
async function handleUserUpdated(data: ClerkUserData): Promise<void> {
  const email = getPrimaryEmail(data);
  if (!email) {
    console.warn(`[Clerk Webhook] No email for user.updated ${data.id}`);
    return;
  }

  // MONEY-144 — when the account-deletion worker calls
  // clerkClient.users.lockUser, Clerk fires user.updated. We must NOT
  // re-materialise the User row mid-delete; the worker owns the
  // pipeline. Same guard for PROCESSING/LOCKED states (Pub/Sub
  // re-deliveries during the lock window).
  if (await hasInFlightDeletion(data.id)) {
    console.log(
      `[Clerk Webhook] user.updated ignored - deletion in flight for clerkId=${data.id}`
    );
    return;
  }

  const name = getFullName(data);
  const result = await ensureUserAndSubscription({
    clerkId: data.id,
    email,
    name,
  });

  if (!result.success) {
    console.error(
      `[Clerk Webhook] user.updated sync failed for ${email}: ${result.error}`
    );
    throw new Error(result.error);
  }

  const { user, created } = result.data;
  // Invalidate cache so stale name/email isn't served
  await clearAllUserCache(user.id).catch(() => {});

  // MONEY-1050 — keep the CMS author avatar in sync with the Clerk photo, so a
  // profile-picture change no longer leaves a dead img.clerk.com URL on the
  // public blog/newsletter author byline.
  await syncContentAuthorImage(data);
  console.log(
    `[Clerk Webhook] Updated user=${user.id} userCreated=${created.user} ` +
      `subscriptionCreated=${created.subscription}`
  );

  // MONEY-523 — fallback onboarding: if a never-synced row reaches us here
  // (e.g. user.created was dropped/missed but the row exists via lazy create),
  // the first user.updated still gets the contact into Resend exactly once.
  if (user.lastResendSyncAt == null) {
    await syncNewContactToResend({ userId: user.id, email, name });
  }
}

/**
 * Handle session.created event - trigger login briefing for Premium users
 */
async function handleSessionCreated(data: ClerkSessionData): Promise<void> {
  try {
    // `user_id`, NOT `id` — MONEY-1236.
    //
    // `session.created` delivers a SESSION: `data.id` is `sess_…` and the
    // account is at `data.user_id` (`user_…`). `User.clerkId` only ever holds
    // `user_…` (written at the user.created/user.updated upserts above), so
    // looking up `clerkId: data.id` matched nothing on EVERY delivery and this
    // function returned at the guard below — before the subscription gate,
    // before the 24h dedup, and before the repo's ONLY `loginBriefing.create`.
    //
    // That is the whole reason `login_briefings` holds 0 rows on prod while the
    // topic, the push subscription and the worker route are all correctly
    // wired: the feature has never run, not once.
    //
    // It could not be caught. The parameter was typed `ClerkUserData`, which has
    // no `user_id` field at all, so `data.id` typechecked perfectly;
    // `handleSessionCreated` has no test coverage; and the surrounding catch
    // swallows and still returns 200, so nothing showed up in metrics either.
    const user = await prisma.user.findFirst({
      where: { clerkId: data.user_id },
      select: { id: true },
    });

    if (!user) return;

    // Check subscription: PREMIUM or ULTIMATE only
    const subscription = await prisma.subscription.findUnique({
      where: { userId: user.id },
      select: { planId: true },
    });

    if (
      !subscription ||
      (subscription.planId !== "PREMIUM" && subscription.planId !== "ULTIMATE")
    ) {
      return;
    }

    // Dedupe: a briefing raised in the last 24h — but ONLY one that still
    // stands for something — MONEY-1238.
    //
    // THE DEFECT. This `where` had no status clause at all, so a briefing that
    // FAILED counted as "already have one" and withheld the feature for a full
    // day. `login-briefing.ts` stamps FAILED and (since MONEY-1238) re-throws
    // so Pub/Sub retries, but the retries are bounded at 5 delivery attempts:
    // once they are spent, this read is what decides, and it said "recent
    // briefing exists" about a row that produced nothing. A PAID feature,
    // silently withheld, with a row in the table that looks like a reason.
    //
    // The read is a findMany and the DECISION is `shouldQueueBriefing`, which
    // carries the full reasoning: a FAILED briefing is retried, but at a bounded
    // rate (cooldown + a per-day attempt cap) rather than on every single
    // sign-in. Excluding FAILED from the dedup outright — the first attempt at
    // this fix — removed the only ceiling on re-queueing.
    //
    // The standing-status list is a POSITIVE list rather than `{ not: "FAILED" }`
    // deliberately.
    // Prisma's MongoDB connector does not match an ABSENT field with a negation
    // — the defect class behind MONEY-1050, 1205, 1234, 1235 and 1236 — and
    // while `status` carries `@default(QUEUED)` today and is therefore always
    // written, an `in` list cannot be wrong about that whatever the schema does
    // later. Every listed status is a real reason to hold off: QUEUED and
    // PROCESSING are in flight, COMPLETED was delivered, and SKIPPED was a
    // deliberate no-op (no holdings) that re-queueing on every login would only
    // repeat.
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const recentBriefings = await prisma.loginBriefing.findMany({
      where: {
        userId: user.id,
        createdAt: { gte: twentyFourHoursAgo },
      },
      select: { status: true, createdAt: true },
    });

    const dedup = shouldQueueBriefing(recentBriefings, now);
    if (!dedup.queue) {
      console.log(
        `[Clerk Webhook] Login briefing skipped for user ${user.id}: ${dedup.reason}`
      );
      return;
    }

    // Check user has holdings
    const holdingsCount = await prisma.holding.count({
      where: { userId: user.id },
    });

    if (holdingsCount === 0) return;

    // Create briefing record and publish job
    const briefing = await prisma.loginBriefing.create({
      data: {
        userId: user.id,
        status: "QUEUED",
        briefingDate: new Date(),
      },
    });

    await publishLoginBriefingJob({
      userId: user.id,
      briefingId: briefing.id,
    });

    console.log(`[Clerk Webhook] Login briefing queued for user ${user.id}`);
  } catch (error) {
    // Don't fail the webhook for briefing errors
    console.error("[Clerk Webhook] Login briefing trigger failed:", error);
  }
}

/**
 * Handle user.deleted event (MONEY-391).
 *
 * Idempotent: if the User row is already gone, no-op. This is the expected
 * path when the user clicked "Delete account" — `deleteAccountAction` runs
 * the hard delete server-side and then calls clerkClient.users.deleteUser,
 * which fires THIS webhook for cleanup. By then the row is gone.
 *
 * Legacy path: if the User row is still present, run the same hard-delete
 * cascade as the server action. This covers admins deleting users directly
 * from the Clerk dashboard.
 */
async function handleUserDeleted(data: ClerkUserData): Promise<void> {
  // MONEY-144 — when the clerk-delete-sweep worker calls
  // Clerk.users.deleteUser 24h after lock, Clerk fires user.deleted.
  // The User row is long gone by then, but the audit row still exists
  // (status=LOCKED→COMPLETED transition). Bail out so we don't try to
  // resend the deletion email or re-run hardDeleteUser.
  if (await hasInFlightDeletion(data.id)) {
    console.log(
      `[Clerk Webhook] user.deleted ignored - sweep/worker pipeline owns clerkId=${data.id}`
    );
    return;
  }

  // Find user by clerkId
  const user = await prisma.user.findFirst({
    where: { clerkId: data.id },
    select: {
      id: true,
      email: true,
      name: true,
      subscription: { select: { id: true } },
    },
  });

  if (!user) {
    // Expected when server-side delete already ran
    console.log(
      `[Clerk Webhook] user.deleted: clerkId=${data.id} already gone (server-side delete already ran)`
    );
    return;
  }

  // Legacy path: Clerk-initiated delete (admin from dashboard).
  // The full hard-delete (with DeletedUserAudit) lives in
  // deleteAccountAction. Here we only have a clerk webhook context — no
  // request, no IP, no OTP. We still hard-delete to keep state consistent,
  // and write an audit row marked deletedBy=system.
  const { hardDeleteUser } = await import("@usemoney/services");
  const deleteResult = await hardDeleteUser({
    userId: user.id,
    deletedBy: "system",
    reason: "Clerk webhook user.deleted (admin or external delete)",
  });

  if (!deleteResult.success) {
    console.error(
      `[Clerk Webhook] hard delete failed for user ${user.id}: ${deleteResult.error}`
    );
    throw new Error(deleteResult.error);
  }

  // Clear cache for safety (rows are gone but stale entries may exist)
  await clearAllUserCache(user.id).catch(() => {});
  console.log(
    `[Clerk Webhook] Hard-deleted user=${user.id} email=${user.email}`
  );

  // Send account deletion email (fire-and-forget)
  sendEmail({
    to: user.email,
    subject: "Your UseMoney account has been deleted",
    react: React.createElement(AccountDeletedEmail, {
      name: user.name || "there",
    }),
    template: "account-deleted",
  });

  // Remove from all segment audiences (fire-and-forget)
  removeContactFromSegment("free", user.email);
  removeContactFromSegment("paid", user.email);
  removeContactFromSegment("marketing", user.email);
}
