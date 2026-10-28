/**
 * Pure, side-effect-free helpers for the Clerk webhook route.
 *
 * Split out of `route.ts` so they can be unit-tested against the REAL exported
 * symbols. The route file itself imports Prisma, `@usemoney/email`,
 * `@usemoney/services`, pubsub and `next/headers`, none of which can be loaded
 * in a plain `node --test` process — hence this sibling `*-logic.ts`. The route
 * imports these and calls them; the test asserts them directly.
 *
 * Signature verification is NOT here — it stays inline in the route using the
 * real `svix` `Webhook`. See the svix contract test in
 * `apps/web/__tests__/api/clerk-webhook.test.ts`.
 */

/** Clerk user payload shape (subset the webhook reads). */
/**
 * Clerk's `session.created` payload — MONEY-1236.
 *
 * A SESSION, not a user. `id` is the session id (`sess_…`); the user is at
 * `user_id` (`user_…`). `handleSessionCreated` was typed as {@link ClerkUserData}
 * and resolved the account with `where: { clerkId: data.id }`, so it looked up a
 * `sess_…` value in a column that only ever holds `user_…`. That returned null
 * on EVERY delivery and the handler returned before the repo's only
 * `loginBriefing.create` — which is why `login_briefings` has 0 rows on prod
 * while the topic, the push subscription and the worker route are all correctly
 * wired.
 *
 * Nothing could catch it: `ClerkUserData` has no `user_id` field, so `data.id`
 * typechecked perfectly, `handleSessionCreated` has no test coverage, and the
 * surrounding catch swallows and still returns 200 — so it is invisible in
 * metrics too.
 */
export interface ClerkSessionData {
  /** The SESSION id (`sess_…`). Never a user id — that is the bug this exists to stop. */
  id: string;
  /** The Clerk USER id (`user_…`) — this is what `User.clerkId` stores. */
  user_id: string;
  status?: string;
  created_at?: number;
}

export interface ClerkUserData {
  id: string;
  email_addresses?: Array<{ email_address: string; id: string }>;
  primary_email_address_id?: string;
  phone_numbers?: Array<{ phone_number: string }>;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string;
  created_at?: number;
  updated_at?: number;
  unsafe_metadata?: Record<string, unknown>;
  public_metadata?: Record<string, unknown>;
}

export interface WebhookEvent {
  data: ClerkUserData;
  type: string;
  object: "event";
}

/**
 * The three Svix headers Clerk signs the webhook with. The route reads these
 * off `next/headers` and forwards them verbatim to `svix`'s `Webhook.verify`.
 */
export const CLERK_SVIX_HEADERS = [
  "svix-id",
  "svix-timestamp",
  "svix-signature",
] as const;

/**
 * Presence check for the three Svix headers. The route 400s with the exact
 * `error` string below when any are missing. Verification itself is delegated
 * to `svix` — this only guards the obvious "no signature at all" case.
 */
export function validateSvixHeaders(headers: Record<string, string | null>): {
  valid: boolean;
  error?: string;
} {
  const svixId = headers["svix-id"];
  const svixTimestamp = headers["svix-timestamp"];
  const svixSignature = headers["svix-signature"];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return { valid: false, error: "Missing svix headers" };
  }

  return { valid: true };
}

/**
 * Shape-validate a (post-signature-verification) webhook payload. Returns the
 * `{ type, data }` pair only when `type` is a non-empty string and `data` is an
 * object; otherwise null.
 */
export function parseWebhookEvent(
  payload: unknown
): { type: string; data: unknown } | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== "object") return null;

  const obj = payload as Record<string, unknown>;

  if (typeof obj.type !== "string" || obj.type.length === 0) return null;
  if (!obj.data || typeof obj.data !== "object") return null;

  return { type: obj.type, data: obj.data };
}

/**
 * Map a Clerk event type to the internal user action, or null for events the
 * route's switch does not handle as a user mutation. (`session.created` is
 * handled separately by the route and is intentionally NOT a user action.)
 */
export function mapClerkEventToAction(eventType: string): string | null {
  switch (eventType) {
    case "user.created":
      return "createUser";
    case "user.updated":
      return "updateUser";
    case "user.deleted":
      return "deleteUser";
    default:
      return null;
  }
}

/** Is this a Clerk user event the route maps to a user mutation? */
export function isSupportedEvent(eventType: string): boolean {
  return mapClerkEventToAction(eventType) !== null;
}

/**
 * Primary email from Clerk user data: the address whose id matches
 * `primary_email_address_id`, else the first address, else null.
 */
export function getPrimaryEmail(data: ClerkUserData): string | null {
  if (!data.email_addresses || data.email_addresses.length === 0) {
    return null;
  }

  // Find primary email
  if (data.primary_email_address_id) {
    const primary = data.email_addresses.find(
      (e) => e.id === data.primary_email_address_id
    );
    if (primary) return primary.email_address;
  }

  // Fallback to first email
  return data.email_addresses[0].email_address;
}

/**
 * Full name from Clerk user data: `"<first> <last>"` trimmed, falling back to
 * `"Trader"` when both are empty/null.
 */
export function getFullName(data: ClerkUserData): string {
  const firstName = data.first_name || "";
  const lastName = data.last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();
  return fullName || "Trader";
}

/**
 * MONEY-523 — decides whether the Clerk webhook should run the one-time Resend
 * onboarding (welcome email + audience adds). Gated purely on the durable
 * `lastResendSyncAt` watermark: a never-synced user (null) is onboarded; an
 * already-synced user is skipped. Immune to the lazy-getOrCreateUser race the
 * old `created.user` check lost.
 */
export function shouldSyncContactToResend(
  lastResendSyncAt: Date | null
): boolean {
  return lastResendSyncAt == null;
}

/**
 * MONEY-1050 — build the guarded `contentAuthor.updateMany` args that refresh a
 * CMS author's avatar from a Clerk `user.updated`/`user.created` event.
 *
 * The content CMS snapshots `clerkUser.imageUrl` into `ContentAuthor.imageUrl`
 * when the author row is first created and never refreshes it. When a user
 * changes their Clerk photo, the old `img.clerk.com` proxy URL 404s, so the
 * public blog/newsletter author avatar renders broken. Syncing it here keeps it
 * fresh going forward.
 *
 * Guard: only overwrite rows whose stored image is empty or Clerk-hosted
 * (`img.clerk.com` / `images.clerk.dev`). A custom avatar uploaded through the
 * CMS (any other host) is preserved — we never stomp it with the Clerk photo.
 *
 * Returns null when there is no incoming image URL (nothing to sync).
 */
export function buildContentAuthorImageSyncUpdate(
  clerkId: string,
  clerkImageUrl: string | null | undefined
): {
  where: {
    clerkId: string;
    // This is the TYPE of the runtime filter built below, so the same guarantee
    // covers it; the evidence (writers + measured counts) is at the value site.
    // prisma-null-ok: `imageUrl` is written on every create (0 absent of 1)
    OR: Array<{ imageUrl: null } | { imageUrl: { contains: string } }>;
  };
  data: { imageUrl: string };
} | null {
  if (!clerkImageUrl) return null;
  return {
    where: {
      clerkId,
      OR: [
        // MONEY-1236 — measured on prod 2026-08-21: ContentAuthor total=1,
        // absent=0, null=0, set=1. Every create path for the model passes
        // `imageUrl: clerkUser.imageUrl` (apps/content/lib/actions/posts.ts,
        // dashboard.ts, authors.ts, ideas.ts — all four `contentAuthor.create`
        // calls), and Clerk's backend User declares `readonly imageUrl: string`
        // — never undefined — so Prisma always writes the key. That REFUTES the
        // earlier reading that an author created without an image is never
        // refreshed from Clerk: no create path can produce such a row.
        // prisma-null-ok: `imageUrl` is written on every create (0 absent of 1)
        { imageUrl: null },
        { imageUrl: { contains: "img.clerk.com" } },
        { imageUrl: { contains: "images.clerk.dev" } },
      ],
    },
    data: { imageUrl: clerkImageUrl },
  };
}

/**
 * Default window for a LATE welcome email, in days — MONEY-1236.
 *
 * Measured on prod 2026-08-21: 5 users signed up within 7 days, 12 within 14,
 * 22 within 30, 68 within 60, 100 within 90, out of 653 total. At 30 days at
 * most 22 people can receive a welcome they were silently denied, and only if
 * they trigger another webhook.
 *
 * Set to 0 for a pure go-forward cutover.
 */
export const WELCOME_BACKFILL_MAX_AGE_DAYS = 30;

/**
 * The `where` that claims the welcome email exactly once — MONEY-1236.
 *
 * ## The bug this replaces
 *
 * The claim was `{ id, welcomeEmailSentAt: null }`. `welcomeEmailSentAt` is
 * optional and no create path writes it, so on MongoDB it is ABSENT — and
 * Prisma's connector does not match an absent field with `null`. Measured on
 * prod: 653 of 653 users absent, 0 null, 0 set. The claim returned `count: 0`
 * for every signup since 2026-06-26, so `sendWelcome` was always false and
 * nobody was ever emailed. It failed silently because `count: 0` is exactly
 * what "already sent" looks like.
 *
 * ## Why BOTH null shapes
 *
 * ABSENT means never attempted. EXPLICIT NULL means attempted and FAILED — the
 * MONEY-877 unwind resets the watermark to null so the next event retries, and
 * that retry is the only path the old filter ever served.
 *
 * ## Why the age gate is load-bearing
 *
 * This claim runs from `user.created` AND `user.updated`, and `user.updated`
 * fires on any Clerk profile change. Repairing the filter alone would let the
 * next profile edit by a user who joined in January win the claim and receive a
 * welcome email months late — an irreversible, outward-facing action. Bounding
 * by account age makes the repair safe to deploy on its own, with no ordering
 * dependency on a backfill script.
 */
export function welcomeClaimWhere(
  userId: string,
  now: Date,
  maxAgeDays: number = WELCOME_BACKFILL_MAX_AGE_DAYS
): {
  id: string;
  OR: Array<
    | {
        AND: [
          { welcomeEmailSentAt: { isSet: false } },
          { createdAt: { gte: Date } },
        ];
      }
    | { welcomeEmailSentAt: null }
  >;
} {
  return {
    id: userId,
    OR: [
      // NEVER ATTEMPTED (absent) — age-bounded. This is the backfill arm: 653
      // users are sitting in it, and without the bound the next profile edit by
      // someone who joined in January wins the claim and gets a welcome email
      // months late.
      {
        AND: [
          { welcomeEmailSentAt: { isSet: false } },
          {
            createdAt: {
              gte: new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000),
            },
          },
        ],
      },
      // ATTEMPTED AND FAILED (explicit null) — NOT age-bounded, deliberately.
      //
      // The MONEY-877 unwind resets this watermark to an explicit null so the
      // next webhook retries a send that failed. An earlier revision ANDed the
      // age bound across BOTH arms, which silently killed that retry: a user
      // whose welcome failed at day 29 could never win the claim again, and the
      // explicit null they were left holding reads as "attempted, will retry"
      // forever.
      //
      // The two arms are disjoint on MongoDB and that is what makes this safe:
      // `{ field: null }` matches only a STORED null, never an absent key — the
      // very asymmetry this ticket family exists to handle. So this arm can
      // only ever match a row some code deliberately reset.
      { welcomeEmailSentAt: null },
    ],
  };
}

/**
 * How long to wait before retrying a briefing that FAILED — MONEY-1236.
 */
export const BRIEFING_FAILED_RETRY_COOLDOWN_MINUTES = 60;

/**
 * How many FAILED briefings in the 24h window before we stop retrying at all.
 */
export const BRIEFING_MAX_FAILED_PER_DAY = 3;

/** The statuses that mean a briefing still stands for something. */
export const BRIEFING_STANDING_STATUSES = [
  "QUEUED",
  "PROCESSING",
  "COMPLETED",
  "SKIPPED",
] as const;

export interface BriefingRowForDedup {
  status: string;
  createdAt: Date;
}

/**
 * Decide whether `session.created` should queue a new login briefing —
 * MONEY-1236.
 *
 * ## Two defects, in opposite directions
 *
 * The ORIGINAL `where` had no status clause at all, so a briefing that FAILED
 * counted as "already have one" and withheld a PAID feature for a full day,
 * with a row in the table that looked like a reason.
 *
 * The FIRST FIX excluded FAILED from the dedup entirely — which removed the only
 * bound on re-queueing. A deterministic failure (bad holding data, an unset key)
 * then re-queued on EVERY `session.created`: a user signing in on three devices
 * produced three rows x five Pub/Sub delivery attempts each, repeating on every
 * subsequent login, with no ceiling and no backoff. That is the amplification
 * shape the 600s ack-deadline notes in CLAUDE.md warn about, and it is worse
 * than the bug it replaced.
 *
 * ## What actually holds
 *
 * A FAILED briefing should be RETRIED, but at a bounded rate:
 *
 *   - anything still standing in the window (in flight, delivered, or a
 *     deliberate SKIPPED no-op) — hold off, unchanged
 *   - the last FAILED is younger than the cooldown — back off
 *   - {@link BRIEFING_MAX_FAILED_PER_DAY} failures already — stop; this is
 *     deterministic, and more attempts cannot fix it
 *   - otherwise — retry
 *
 * A transient Gemini/Mongo blip therefore recovers within the hour instead of
 * costing the user their day, while a deterministic failure costs at most three
 * attempts rather than one per sign-in forever.
 */
export function shouldQueueBriefing(
  recent: BriefingRowForDedup[],
  now: Date,
  cooldownMinutes: number = BRIEFING_FAILED_RETRY_COOLDOWN_MINUTES,
  maxFailedPerDay: number = BRIEFING_MAX_FAILED_PER_DAY
): { queue: boolean; reason: string } {
  const standing = recent.filter((r) =>
    (BRIEFING_STANDING_STATUSES as readonly string[]).includes(r.status)
  );
  if (standing.length > 0) {
    return { queue: false, reason: "recent-briefing-stands" };
  }

  const failed = recent.filter((r) => r.status === "FAILED");
  if (failed.length === 0) {
    return { queue: true, reason: "no-recent-briefing" };
  }

  if (failed.length >= maxFailedPerDay) {
    return { queue: false, reason: "failed-attempt-cap-reached" };
  }

  const cooldownMs = cooldownMinutes * 60 * 1000;
  const newestFailedAt = Math.max(...failed.map((r) => r.createdAt.getTime()));
  if (now.getTime() - newestFailedAt < cooldownMs) {
    return { queue: false, reason: "failed-retry-cooldown" };
  }

  return { queue: true, reason: "retry-after-failure" };
}
