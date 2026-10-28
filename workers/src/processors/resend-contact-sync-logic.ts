/**
 * Resend contact-sync — PURE classification logic (no Prisma / Resend / I/O).
 *
 * Side-effect-free helpers extracted out of `resend-contact-sync.ts` so they can
 * be unit-tested by importing the REAL symbol (no shadow copies) without booting
 * Prisma or the Resend client. `resend-contact-sync.ts` imports and CALLS every
 * export here, so the production code path and the tests execute the SAME code.
 * Mirrors the worker precedent `sync-logic.ts` / `import-logic.ts`.
 *
 * The old inline `processor-resend-contact-sync.test.ts` re-declared
 * `classifySegment` / `splitName` / `shouldSyncToMarketing` / `shouldLogProgress`
 * and asserted the copy — a shadow. Crucially the copy used the WRONG progress
 * interval (`% 50`) while the source logs every `% 100`, so it could never have
 * caught a drift there. These exports are the single source of truth.
 *
 * @see workers/src/processors/resend-contact-sync.ts (caller)
 * @see apps/web/__tests__/workers/processor-resend-contact-sync.test.ts (tests the real exports)
 */

/** Plans that put a user in the PAID Resend audience. */
export const PAID_PLANS: ReadonlySet<string> = new Set([
  "PRO",
  "PREMIUM",
  "ULTIMATE",
]);

/** Delay between Resend API calls — 8 req/sec, under Resend's 10/sec limit. */
export const RATE_LIMIT_MS = 125;

/** Emit a progress line every Nth user. MUST match the processor loop guard. */
export const PROGRESS_LOG_INTERVAL = 100;

/** The minimal subscription shape the classifier reads. */
export interface SubscriptionLike {
  planId: string;
  status: string;
}

/**
 * True only when the subscription is ACTIVE *and* on a paid plan. A
 * cancelled/expired paid plan, or an active FREE plan, is NOT paid (the user
 * belongs in the free/downgraded audience).
 */
export function isPaidSubscription(
  subscription: SubscriptionLike | null | undefined,
): boolean {
  return (
    subscription?.status === "ACTIVE" && PAID_PLANS.has(subscription.planId)
  );
}

/** The three Resend audience tiers a user can resolve to. */
export type ResendTier = "paid" | "downgraded" | "free";

/**
 * Resolve a user's target audience tier:
 *   - paid:       active paid subscription
 *   - downgraded: not currently paid, but has paid before AND a downgraded
 *                 audience is configured (`downgradedConfigured`)
 *   - free:       everyone else
 *
 * This is the tier branch `resend-contact-sync.ts` uses to pick the audience id;
 * getting it wrong mis-files a user, so it is centralized here.
 */
export function resolveTargetTier(
  subscription: SubscriptionLike | null | undefined,
  hasEverPaid: boolean,
  downgradedConfigured: boolean,
): ResendTier {
  if (isPaidSubscription(subscription)) return "paid";
  if (hasEverPaid && downgradedConfigured) return "downgraded";
  return "free";
}

/**
 * Split a full name into Resend's `firstName` / `lastName`. The first
 * space-delimited token is the first name; everything after is the last name.
 * Empty/blank parts collapse to `undefined` (Resend treats absent vs ""
 * differently), and a null/empty name yields `{ undefined, undefined }`.
 */
export function splitName(name: string | null | undefined): {
  firstName: string | undefined;
  lastName: string | undefined;
} {
  const [firstName, ...rest] = (name || "").split(" ");
  return {
    firstName: firstName || undefined,
    lastName: rest.join(" ") || undefined,
  };
}

/**
 * Marketing-audience opt-in gate: STRICT boolean `true` only. A null/absent
 * `emailPreferences`, a missing key, or a truthy-but-non-boolean value (`"true"`,
 * `1`) all mean "no explicit consent" → false. (Consent must be unambiguous.)
 */
export function shouldSyncToMarketing(
  emailPreferences: Record<string, unknown> | null | undefined,
): boolean {
  if (emailPreferences == null) return false;
  return emailPreferences.marketingEmails === true;
}

/**
 * Whether the loop should emit a progress line after processing the
 * (0-indexed) `index`-th user — i.e. on every `PROGRESS_LOG_INTERVAL`-th user.
 */
export function shouldLogProgress(
  index: number,
  interval: number = PROGRESS_LOG_INTERVAL,
): boolean {
  return (index + 1) % interval === 0;
}
