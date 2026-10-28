/**
 * User Service
 *
 * Handles user resolution (Clerk ID → internal MongoDB ID) and user CRUD:
 * profile read, currency preference (get/update), settings update, trial info,
 * and onboarding-state derivation.
 *
 * Source: apps/web/lib/db/user.ts + apps/web/lib/actions/user.ts
 *       + apps/web/lib/actions/walkthrough.ts (onboarding flags)
 *
 * SECURITY (MONEY-620). Every function takes the caller's internal `userId` as
 * its first argument and scopes EVERY Prisma read/write to it (`where: { id:
 * userId }`). There is no by-id mutation that trusts a client-supplied target id
 * — an attacker can never read or update another user's profile / currency /
 * settings (IDOR). The settings PATCH is run through an allow-list
 * (mass-assignment guard) so a client cannot escalate plan / role / credits, and
 * the currency is validated against an allow-list so garbage never persists. The
 * pure decision logic lives in `./user-logic.ts` (asserted directly by a unit
 * suite and, on this LIVE service, by a recording-prisma e2e suite) so the code
 * that ships is the code that's tested — no shadow.
 *
 * @see apps/web/__tests__/services/user-poison-live.test.ts (drives the LIVE service)
 * @see apps/web/__tests__/services/user-logic-unit.test.ts (pure-logic unit tests)
 */

import { prisma, Prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  calculateTrialInfo,
  deriveOnboardingState,
  isValidCurrency,
  normalizeCurrency,
  sanitizeUserSettingsPatch,
  toUserProfile,
  SUPPORTED_CURRENCIES,
  VALID_DEFAULT_PAGES,
  CURRENT_WALKTHROUGH_VERSION,
  isKnownWalkthroughVersion,
  readSnoozedUntil,
  mergePreferencesWithSnooze,
  type OnboardingState,
  type SupportedCurrency,
  type UserProfile,
} from "./user-logic";

export type { UserProfile, OnboardingState, SupportedCurrency };
export {
  SUPPORTED_CURRENCIES,
  VALID_DEFAULT_PAGES,
  isValidCurrency,
  normalizeCurrency,
  sanitizeUserSettingsPatch,
  calculateTrialInfo,
  deriveOnboardingState,
  toUserProfile,
};

// ── Types ──────────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

const USER_PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  preferredCurrency: true,
  createdAt: true,
  updatedAt: true,
} as const;

// In-memory cache for Clerk → DB user resolution (5 min TTL)
const userCache = new Map<string, { user: DbUser; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000;

// ── Service Functions ──────────────────────────────────────────────

/**
 * Resolve a Clerk user ID to the internal MongoDB user ID.
 * This is the primary user resolution function for the API server.
 * Uses in-memory cache for performance.
 */
export async function resolveUserId(
  clerkUserId: string,
): Promise<string | null> {
  // Check in-memory cache
  const cached = userCache.get(clerkUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user.id;
  }

  try {
    const user = await prisma.user.findFirst({
      where: { clerkId: clerkUserId },
      select: USER_SELECT,
    });

    if (user) {
      userCache.set(clerkUserId, {
        user: user as DbUser,
        expiresAt: Date.now() + CACHE_TTL,
      });
      return user.id;
    }

    return null;
  } catch (error) {
    logger.error({ error, clerkUserId }, "Failed to resolve user ID");
    return null;
  }
}

/**
 * Get user by internal MongoDB ID.
 *
 * IDOR: scoped to the supplied `userId` (the caller's own id, resolved from the
 * Clerk session upstream). There is no path here that reads a row by a
 * client-supplied arbitrary id.
 */
export async function getUserById(
  userId: string,
): Promise<ServiceResult<DbUser>> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    return { success: true, data: user as DbUser };
  } catch (error) {
    logger.error({ error, userId }, "Get user service error");
    return { success: false, error: "Failed to fetch user" };
  }
}

/**
 * Get the caller's profile (id, email, name, currency, timestamps).
 *
 * IDOR: scoped to `userId`. The stored `preferredCurrency` is normalised
 * (a legacy/garbage value can never leak to the client) and timestamps degrade
 * to `null` instead of throwing on a corrupt `createdAt`/`updatedAt`.
 */
export async function getUserProfile(
  userId: string,
): Promise<ServiceResult<UserProfile>> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: USER_PROFILE_SELECT,
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    return { success: true, data: toUserProfile(user) };
  } catch (error) {
    logger.error({ error, userId }, "Get user profile service error");
    return {
      success: false,
      error: "Failed to fetch user profile",
      code: "INTERNAL",
    };
  }
}

/**
 * Get account trial info for a user.
 *
 * IDOR: scoped to `userId`. Cached for 5 min. The trial math is the shared,
 * Invalid-Date-guarded `calculateTrialInfo` (a corrupt `createdAt` no longer
 * throws on `.toISOString()` and fails closed as expired).
 */
export async function getAccountTrialInfo(
  userId: string,
): Promise<ServiceResult<{ remainingDays: number; isTrialActive: boolean }>> {
  try {
    // MONEY-1062 (Round C / C3#1): subkey is "trial-v2", NOT "trial" — the
    // dead-but-present web twin (apps/web/lib/actions/user.ts
    // getAccountTrialInfoAction) writes a DIFFERENT shape AND math
    // ({ createdAt, remainingDays, isExpired }, createdAt+30d only — no
    // brokerTrialEndsAt reset) under ("user", userId, "trial"). Sharing that key
    // would serve its stale shape/math from here (and vice-versa) whenever both
    // paths run within the TTL, so this service's entries are versioned apart.
    const cached = await getCached<{
      remainingDays: number;
      isTrialActive: boolean;
    }>("user", userId, "trial-v2");
    if (cached) return { success: true, data: cached };

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true, brokerTrialEndsAt: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    // MONEY-877: trial ends at brokerTrialEndsAt (resettable) when set, else createdAt+30d.
    const { remainingDays, isExpired } = calculateTrialInfo(
      user.createdAt,
      undefined,
      user.brokerTrialEndsAt,
    );
    const result = { remainingDays, isTrialActive: !isExpired };

    await setCached("user", userId, "trial-v2", result);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, userId }, "Get trial info service error");
    return { success: false, error: "Failed to fetch trial info" };
  }
}

/**
 * Get the caller's preferred currency, defaulted/validated against the
 * allow-list.
 *
 * IDOR: scoped to `userId`. A legacy/garbage stored value is coerced to the
 * default (`"INR"`) by {@link normalizeCurrency} rather than echoed back.
 */
export async function getCurrencyPreference(
  userId: string,
): Promise<ServiceResult<{ currency: SupportedCurrency }>> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferredCurrency: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    return {
      success: true,
      data: { currency: normalizeCurrency(user.preferredCurrency) },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get currency preference service error");
    return { success: false, error: "Failed to fetch currency preference" };
  }
}

/**
 * Update the caller's preferred currency.
 *
 * SECURITY:
 *   - IDOR: the update WHERE is scoped to `userId` (never a client-supplied id),
 *     so an attacker cannot rewrite another user's currency.
 *   - Allow-list: an invalid/garbage `currency` is REJECTED (`isValidCurrency`)
 *     before any DB write — garbage never persists into the column.
 */
export async function updateCurrencyPreference(
  userId: string,
  currency: string,
): Promise<ServiceResult<{ currency: SupportedCurrency }>> {
  if (!isValidCurrency(currency)) {
    return {
      success: false,
      error: `Invalid currency. Must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
    };
  }

  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { preferredCurrency: currency },
      select: { preferredCurrency: true },
    });

    return {
      success: true,
      data: { currency: normalizeCurrency(updated.preferredCurrency) },
      message: "Currency updated",
    };
  } catch (error) {
    logger.error({ error, userId }, "Update currency preference service error");
    return { success: false, error: "Failed to update currency preference" };
  }
}

/**
 * Update the caller's editable settings (name, preferredCurrency).
 *
 * SECURITY:
 *   - Mass-assignment guard: the client patch is run through
 *     {@link sanitizeUserSettingsPatch} (an allow-list). Privileged keys
 *     (`plan`/`planId`/`role`/`isAdmin`/`credits*`/`isActive`/`clerkId`/`email`/
 *     `id`/`termsAcceptedAt`/`subscription`/`__proto__`/…) are STRIPPED — they
 *     can never reach `prisma.user.update`'s `data`. A stripped privileged key
 *     is logged (attempted escalation) but does not fail an otherwise-legit
 *     request.
 *   - Allow-list: a present-but-invalid `preferredCurrency` inside the patch is
 *     stripped (not coerced) so garbage never persists.
 *   - IDOR: the update WHERE is scoped to `userId` only.
 *   - No-op safe: an empty/garbage patch performs NO write and returns the
 *     current profile.
 */
export async function updateUserSettings(
  userId: string,
  patch: unknown,
): Promise<ServiceResult<UserProfile>> {
  try {
    const {
      patch: safePatch,
      preferences: prefsPatch,
      rejectedKeys,
    } = sanitizeUserSettingsPatch(patch);

    if (rejectedKeys.length > 0) {
      // Visibility for an attempted mass-assignment / unknown-field write.
      // Never reflected to the client.
      logger.warn(
        { userId, rejectedKeys },
        "updateUserSettings: stripped non-whitelisted settings keys",
      );
    }

    const hasPrefsPatch = Object.keys(prefsPatch).length > 0;

    // Nothing writable — don't issue an empty update; just return the profile.
    if (Object.keys(safePatch).length === 0 && !hasPrefsPatch) {
      return getUserProfile(userId);
    }

    // MONEY-1062 (D8): `defaultPage` (and any future preferences-JSON key) is
    // MERGED into the existing `User.preferences` blob — read-merge-write,
    // mirroring the web `updateDefaultPagePreferenceAction` — never spread as a
    // column and never a wholesale overwrite (which would clobber the sibling
    // research/composer namespaces).
    let mergedPreferences: Record<string, unknown> | undefined;
    if (hasPrefsPatch) {
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true },
      });
      mergedPreferences = {
        ...((current?.preferences ?? {}) as Record<string, unknown>),
        ...prefsPatch,
      };
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...safePatch,
        ...(mergedPreferences !== undefined
          ? { preferences: mergedPreferences as Prisma.InputJsonValue }
          : {}),
      },
      select: USER_PROFILE_SELECT,
    });

    return {
      success: true,
      data: toUserProfile(updated),
      message: "Settings updated",
    };
  } catch (error) {
    logger.error({ error, userId }, "Update user settings service error");
    return { success: false, error: "Failed to update settings" };
  }
}

// ── Terms acceptance (MONEY-1062 P1a — apps/api /v1/me/terms) ──────
//
// Mirrors apps/web/lib/actions/user.ts hasAcceptedTermsAction /
// acceptTermsAction, adapted to the service contract (caller passes the
// resolved internal userId instead of a Clerk session). The Resend
// marketing-segment sync the web action fires stays CALLER-side (this package
// does not depend on @usemoney/email) — `acceptTerms` returns the
// email/name/marketing trio the caller needs to run it.

/** Read-side terms status. */
export interface TermsStatus {
  accepted: boolean;
}

/**
 * Whether the caller has accepted the Terms of Service.
 *
 * Mirrors `hasAcceptedTermsAction`'s exact reads:
 *   - `termsAcceptedAt != null` → accepted.
 *   - An in-flight delete-account audit row (PENDING/PROCESSING/LOCKED, keyed
 *     on the user's clerkId) also counts as accepted — mid-deletion a phantom
 *     re-materialised row must never re-trigger the terms gate (MONEY-144).
 *   - A read ERROR fails OPEN (`accepted: true`), mirroring the web action's
 *     "on error, don't block the user" posture.
 *
 * IDOR: scoped to `userId`; the audit lookup uses the row's OWN clerkId.
 */
export async function hasAcceptedTerms(
  userId: string,
): Promise<ServiceResult<TermsStatus>> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { clerkId: true, termsAcceptedAt: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    if (user.termsAcceptedAt != null) {
      return { success: true, data: { accepted: true } };
    }

    if (user.clerkId) {
      const pendingDeletion = await prisma.deletedUserAudit.findFirst({
        where: {
          clerkId: user.clerkId,
          status: { in: ["PENDING", "PROCESSING", "LOCKED"] },
        },
        select: { id: true },
      });
      if (pendingDeletion) {
        return { success: true, data: { accepted: true } };
      }
    }

    return { success: true, data: { accepted: false } };
  } catch (error) {
    logger.error({ error, userId }, "Has accepted terms service error");
    // Mirror the web action's fail-open: a transient read error must never
    // block the user behind the terms gate.
    return { success: true, data: { accepted: true } };
  }
}

/** What `acceptTerms` hands back so the CALLER can run the segment sync. */
export interface AcceptTermsResult {
  email: string;
  name: string | null;
  /** The persisted marketing opt-in (defaults false when omitted). */
  marketing: boolean;
}

/**
 * Record that the caller accepted the Terms of Service (+ optional marketing /
 * analytics preferences merged into `emailPreferences`).
 *
 * Mirrors `acceptTermsAction`'s exact prisma ops: read
 * `{ id, email, name, emailPreferences }`, merge
 * `{ marketingEmails, usageAnalytics }` over the existing JSON, then write
 * `termsAcceptedAt = now` + the merged preferences in one update.
 *
 * IDOR: both the read and the write are scoped to `userId`.
 */
export async function acceptTerms(
  userId: string,
  optionalPrefs?: { marketing?: boolean; analytics?: boolean },
): Promise<ServiceResult<AcceptTermsResult>> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailPreferences: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    const wantsMarketing = optionalPrefs?.marketing ?? false;

    const existingPrefs =
      (user.emailPreferences as Record<string, unknown>) ?? {};
    const updatedPrefs = {
      ...existingPrefs,
      marketingEmails: wantsMarketing,
      usageAnalytics: optionalPrefs?.analytics ?? false,
    };

    await prisma.user.update({
      where: { id: user.id },
      data: {
        termsAcceptedAt: new Date(),
        emailPreferences: updatedPrefs,
      },
    });

    return {
      success: true,
      data: { email: user.email, name: user.name, marketing: wantsMarketing },
    };
  } catch (error) {
    logger.error({ error, userId }, "Accept terms service error");
    return {
      success: false,
      error: "Failed to accept terms",
      code: "INTERNAL",
    };
  }
}

/**
 * Get the caller's onboarding state (terms accepted + walkthrough seen).
 *
 * IDOR: scoped to `userId`. The seen-versions list is de-duplicated and
 * string-filtered, and `isOnboarded` derives from terms + current-tour. Pure
 * derivation lives in {@link deriveOnboardingState}.
 */
export async function getOnboardingState(
  userId: string,
  currentWalkthroughVersion: string,
): Promise<ServiceResult<OnboardingState>> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { walkthroughVersionsSeen: true, termsAcceptedAt: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    const state = deriveOnboardingState({
      seenVersions: user.walkthroughVersionsSeen,
      termsAcceptedAt: user.termsAcceptedAt,
      currentVersion: currentWalkthroughVersion,
    });

    return { success: true, data: state };
  } catch (error) {
    logger.error({ error, userId }, "Get onboarding state service error");
    return { success: false, error: "Failed to fetch onboarding state" };
  }
}

// ── Email preferences + audience segments (MONEY-1062 P4e) ─────────────────
//
// The DB half of apps/web/lib/actions/email-preferences.ts. @usemoney/services
// does NOT depend on @usemoney/email, so the effective-prefs MERGE
// (getEffectivePreferences), the "every key is a boolean" VALIDATION, and the
// Resend audience/segment SYNC all stay ROUTE-side (the route has the email
// dep) — exactly the P1a terms-wiring boundary. These functions only read/write
// the raw `emailPreferences` JSON + the NewsletterSubscriber row, IDOR-scoped.

/** Injectable IO seam for the additive P4e user-scoped reads/writes. */
export interface UserMeDeps {
  prisma?: typeof prisma;
  now?: () => Date;
}

/**
 * Read the caller's RAW `emailPreferences` JSON (route computes effective prefs
 * via `@usemoney/email` getEffectivePreferences). 404 when the user is missing.
 */
export async function getRawEmailPreferences(
  userId: string,
  deps: UserMeDeps = {},
): Promise<ServiceResult<{ emailPreferences: unknown }>> {
  const db = deps.prisma ?? prisma;
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { emailPreferences: true },
    });
    if (!user) {
      return { success: false, error: "User not found", code: "NOT_FOUND" };
    }
    return { success: true, data: { emailPreferences: user.emailPreferences } };
  } catch (error) {
    logger.error({ error, userId }, "Get email preferences service error");
    return { success: false, error: "Failed to get email preferences" };
  }
}

/** What `writeEmailPreferences` returns so the route can run the segment sync. */
export interface WriteEmailPreferencesResult {
  email: string | null;
  name: string | null;
  /** The RAW previous prefs (route diffs marketing on/off against the new). */
  previous: unknown;
  /** The RAW persisted prefs (route computes effective for the response). */
  updated: unknown;
}

/**
 * Persist the caller's `emailPreferences` (the route validates every key is a
 * boolean first). Returns the contact + previous/updated raw prefs so the route
 * can run the fire-and-forget marketing-segment sync (mirrors
 * updateEmailPreferencesAction). The `prefs` value is written verbatim.
 */
export async function writeEmailPreferences(
  userId: string,
  prefs: unknown,
  deps: UserMeDeps = {},
): Promise<ServiceResult<WriteEmailPreferencesResult>> {
  const db = deps.prisma ?? prisma;
  try {
    const existing = await db.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, emailPreferences: true },
    });

    const updated = await db.user.update({
      where: { id: userId },
      data: { emailPreferences: prefs as Prisma.InputJsonValue },
      select: { emailPreferences: true },
    });

    return {
      success: true,
      data: {
        email: existing?.email ?? null,
        name: existing?.name ?? null,
        previous: existing?.emailPreferences ?? null,
        updated: updated.emailPreferences,
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Update email preferences service error");
    return { success: false, error: "Failed to update email preferences" };
  }
}

/** Raw segment state: newsletter row status + raw prefs (route derives marketing). */
export interface EmailSegmentState {
  email: string | null;
  newsletterActive: boolean;
  emailPreferences: unknown;
}

/**
 * Read the caller's segment-subscription state: newsletter = NewsletterSubscriber
 * ACTIVE; marketing is derived route-side from `emailPreferences`. Mirrors
 * getEmailSegmentSubscriptionsAction. 404 when the user is missing.
 */
export async function getEmailSegmentState(
  userId: string,
  deps: UserMeDeps = {},
): Promise<ServiceResult<EmailSegmentState>> {
  const db = deps.prisma ?? prisma;
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true, emailPreferences: true },
    });
    if (!user) {
      return { success: false, error: "User not found", code: "NOT_FOUND" };
    }

    let newsletterActive = false;
    if (user.email) {
      const sub = await db.newsletterSubscriber.findUnique({
        where: { email: user.email },
        select: { status: true },
      });
      newsletterActive = sub?.status === "ACTIVE";
    }

    return {
      success: true,
      data: {
        email: user.email,
        newsletterActive,
        emailPreferences: user.emailPreferences,
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get email segment state service error");
    return {
      success: false,
      error: "Failed to get email segment subscriptions",
    };
  }
}

/**
 * Persist the newsletter-subscription state for the caller (the DB half of the
 * newsletter branch of toggleEmailSegmentSubscriptionAction — the route does the
 * Resend audience sync first). Upserts NewsletterSubscriber keyed on the user's
 * email. Returns the contact for symmetry. 404 when the user/email is missing.
 */
export async function setNewsletterSubscription(
  userId: string,
  subscribed: boolean,
  deps: UserMeDeps = {},
): Promise<ServiceResult<{ email: string; name: string | null }>> {
  const db = deps.prisma ?? prisma;
  const now = deps.now ?? (() => new Date());
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });
    if (!user || !user.email) {
      return { success: false, error: "User not found", code: "NOT_FOUND" };
    }

    const when = now();
    await db.newsletterSubscriber.upsert({
      where: { email: user.email },
      update: {
        status: subscribed ? "ACTIVE" : "UNSUBSCRIBED",
        subscribedAt: subscribed ? when : undefined,
        unsubscribedAt: subscribed ? undefined : when,
        segments: subscribed ? ["newsletter"] : [],
      },
      create: {
        email: user.email,
        name: user.name ?? undefined,
        status: subscribed ? "ACTIVE" : "UNSUBSCRIBED",
        source: "settings",
        segments: subscribed ? ["newsletter"] : [],
        subscribedAt: subscribed ? when : undefined,
        unsubscribedAt: subscribed ? undefined : when,
      },
    });

    return { success: true, data: { email: user.email, name: user.name } };
  } catch (error) {
    logger.error(
      { error, userId },
      "Set newsletter subscription service error",
    );
    return { success: false, error: "Failed to update email subscription" };
  }
}

// ── Login briefing (MONEY-1062 P4e — apps/api /v1/me/briefing) ─────────────
//
// Extracted from apps/web/lib/actions/briefing.ts. IDOR-scoped to `userId`.

/** A login briefing as returned to the client (timestamps ISO-stringified). */
export interface BriefingData {
  id: string;
  summary: string | null;
  sections: unknown[];
  portfolioValue: number | null;
  dayChange: number | null;
  briefingDate: string;
  completedAt: string | null;
}

/**
 * Fetch the latest unread (COMPLETED, not-yet-viewed) briefing for TODAY.
 * Returns `null` (success) when there is none — clients don't branch on error.
 * Mirrors getLatestBriefingAction.
 */
export async function getLatestBriefing(
  userId: string,
  deps: UserMeDeps = {},
): Promise<ServiceResult<BriefingData | null>> {
  const db = deps.prisma ?? prisma;
  const now = deps.now ?? (() => new Date());
  try {
    const today = new Date(now());
    today.setHours(0, 0, 0, 0);

    const briefing = await db.loginBriefing.findFirst({
      where: {
        userId,
        status: "COMPLETED",
        // MONEY-1236 — "not yet viewed" is null OR ABSENT. Prisma's MongoDB
        // connector does not treat a missing field as null: a bare
        // `viewedAt: null` matches ONLY documents that carry the key, and no
        // writer carries it. The one `loginBriefing.create` in the repo (the
        // Clerk `session.created` handler in
        // apps/web/app/api/webhooks/clerk/route.ts) writes
        // `{userId, status, briefingDate}` only, and `viewedAt DateTime?` has
        // no `@default`, so Mongo stores no key. This fetch returned null for
        // every briefing that ever existed, so /v1/me/briefing always answered
        // "none" and the mobile popup could never surface.
        //
        // The create path omitting `viewedAt` is the ROOT CAUSE and lives in a
        // file this ticket does not own. Fixing the READ is the more robust
        // half anyway: it is correct whichever writer produced the row, and it
        // is the ONLY half that can see rows already on disk — `prisma db push`
        // creates indexes, never fields, so a writer-side fix backfills
        // nothing.
        //
        // Must stay identical to apps/web/lib/actions/briefing.ts
        // (`getLatestBriefingAction`), which is the same query for the web app.
        // Same defect class as MONEY-1050 / 1205 / 1234 / 1235; `isSet: false`
        // is the only Prisma spelling that reaches an absent key.
        OR: [{ viewedAt: null }, { viewedAt: { isSet: false } }],
        briefingDate: { gte: today },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!briefing) {
      return { success: true, data: null };
    }

    const row = briefing as unknown as Record<string, unknown>;
    return {
      success: true,
      data: {
        id: row.id as string,
        summary: (row.summary as string | null) ?? null,
        sections: (row.sections as unknown[]) ?? [],
        portfolioValue: (row.portfolioValue as number | null) ?? null,
        dayChange: (row.dayChange as number | null) ?? null,
        briefingDate: (row.briefingDate as Date).toISOString(),
        completedAt: (row.completedAt as Date | null)?.toISOString() ?? null,
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get latest briefing service error");
    return { success: false, error: "Failed to fetch briefing" };
  }
}

/**
 * Mark a briefing as viewed (dismissed). IDOR: fetch by id, then verify the row
 * belongs to `userId` before the write (mirrors markBriefingViewedAction). A
 * non-owned/absent id → NOT_FOUND.
 */
export async function markBriefingViewed(
  userId: string,
  briefingId: string,
  deps: UserMeDeps = {},
): Promise<ServiceResult<void>> {
  const db = deps.prisma ?? prisma;
  const now = deps.now ?? (() => new Date());
  try {
    const briefing = await db.loginBriefing.findUnique({
      where: { id: briefingId },
      select: { userId: true },
    });

    if (!briefing || briefing.userId !== userId) {
      return { success: false, error: "Briefing not found", code: "NOT_FOUND" };
    }

    await db.loginBriefing.update({
      where: { id: briefingId },
      data: { viewedAt: now() },
    });

    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, briefingId },
      "Mark briefing viewed service error",
    );
    return { success: false, error: "Failed to update briefing" };
  }
}

// ── Walkthrough tour state (MONEY-1062 P4e — apps/api /v1/me/walkthrough) ───
//
// Extracted from apps/web/lib/actions/walkthrough.ts. IDOR-scoped to `userId`.
// Version validation uses the mirrored allow-list in user-logic.ts (the web
// tours registry can't cross the app boundary).

/** The caller's walkthrough state: seen versions, snooze map, current version. */
export interface WalkthroughStateData {
  seenVersions: string[];
  snoozedUntil: Record<string, string>;
  currentVersion: string;
}

/** Fetch the caller's walkthrough state. Mirrors getWalkthroughStateAction. */
export async function getWalkthroughState(
  userId: string,
  deps: UserMeDeps = {},
): Promise<ServiceResult<WalkthroughStateData>> {
  const db = deps.prisma ?? prisma;
  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { walkthroughVersionsSeen: true, preferences: true },
    });
    if (!user) {
      return { success: false, error: "User not found", code: "NOT_FOUND" };
    }

    return {
      success: true,
      data: {
        seenVersions: user.walkthroughVersionsSeen,
        snoozedUntil: readSnoozedUntil(user.preferences),
        currentVersion: CURRENT_WALKTHROUGH_VERSION,
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get walkthrough state service error");
    return { success: false, error: "Failed to load walkthrough state" };
  }
}

/**
 * Record that the caller has seen a tour version (idempotent — an already-seen
 * version is a no-op success). Mirrors markWalkthroughSeenAction. An unknown
 * version → INVALID_INPUT (route → 400); a missing user → NOT_FOUND.
 */
export async function markWalkthroughSeen(
  userId: string,
  version: string,
  deps: UserMeDeps = {},
): Promise<ServiceResult<{ seenVersions: string[] }>> {
  const db = deps.prisma ?? prisma;
  if (!isKnownWalkthroughVersion(version)) {
    return {
      success: false,
      error: "Unknown walkthrough version",
      code: "INVALID_INPUT",
    };
  }
  try {
    const existing = await db.user.findUnique({
      where: { id: userId },
      select: { walkthroughVersionsSeen: true },
    });
    if (!existing) {
      return { success: false, error: "User not found", code: "NOT_FOUND" };
    }

    if (existing.walkthroughVersionsSeen.includes(version)) {
      return {
        success: true,
        data: { seenVersions: existing.walkthroughVersionsSeen },
      };
    }

    const updated = await db.user.update({
      where: { id: userId },
      data: { walkthroughVersionsSeen: { push: version } },
      select: { walkthroughVersionsSeen: true },
    });

    return {
      success: true,
      data: { seenVersions: updated.walkthroughVersionsSeen },
    };
  } catch (error) {
    logger.error({ error, userId }, "Mark walkthrough seen service error");
    return { success: false, error: "Failed to save walkthrough state" };
  }
}

/**
 * Reset a tour version (remove from seen + clear its snooze) so the user sees it
 * again. Mirrors resetWalkthroughAction. Unknown version → INVALID_INPUT;
 * missing user → NOT_FOUND.
 */
export async function resetWalkthrough(
  userId: string,
  version: string,
  deps: UserMeDeps = {},
): Promise<ServiceResult<{ seenVersions: string[] }>> {
  const db = deps.prisma ?? prisma;
  if (!isKnownWalkthroughVersion(version)) {
    return {
      success: false,
      error: "Unknown walkthrough version",
      code: "INVALID_INPUT",
    };
  }
  try {
    const existing = await db.user.findUnique({
      where: { id: userId },
      select: { walkthroughVersionsSeen: true, preferences: true },
    });
    if (!existing) {
      return { success: false, error: "User not found", code: "NOT_FOUND" };
    }

    const nextSeen = existing.walkthroughVersionsSeen.filter(
      (v) => v !== version,
    );
    const snoozed = readSnoozedUntil(existing.preferences);
    delete snoozed[version];
    const nextPrefs = mergePreferencesWithSnooze(existing.preferences, snoozed);

    const updated = await db.user.update({
      where: { id: userId },
      data: {
        walkthroughVersionsSeen: { set: nextSeen },
        preferences: nextPrefs as Prisma.InputJsonValue,
      },
      select: { walkthroughVersionsSeen: true },
    });

    return {
      success: true,
      data: { seenVersions: updated.walkthroughVersionsSeen },
    };
  } catch (error) {
    logger.error({ error, userId }, "Reset walkthrough service error");
    return { success: false, error: "Failed to reset walkthrough" };
  }
}

/**
 * Snooze a tour version until a given ISO timestamp. Mirrors
 * snoozeWalkthroughAction. Unknown version / un-parseable timestamp →
 * INVALID_INPUT; missing user → NOT_FOUND.
 */
export async function snoozeWalkthrough(
  userId: string,
  version: string,
  untilIso: string,
  deps: UserMeDeps = {},
): Promise<ServiceResult<{ snoozedUntil: Record<string, string> }>> {
  const db = deps.prisma ?? prisma;
  if (!isKnownWalkthroughVersion(version)) {
    return {
      success: false,
      error: "Unknown walkthrough version",
      code: "INVALID_INPUT",
    };
  }
  const parsed = Date.parse(untilIso);
  if (Number.isNaN(parsed)) {
    return {
      success: false,
      error: "Invalid snooze timestamp",
      code: "INVALID_INPUT",
    };
  }
  try {
    const existing = await db.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    if (!existing) {
      return { success: false, error: "User not found", code: "NOT_FOUND" };
    }

    const snoozed = readSnoozedUntil(existing.preferences);
    snoozed[version] = new Date(parsed).toISOString();
    const nextPrefs = mergePreferencesWithSnooze(existing.preferences, snoozed);

    await db.user.update({
      where: { id: userId },
      data: { preferences: nextPrefs as Prisma.InputJsonValue },
    });

    return { success: true, data: { snoozedUntil: snoozed } };
  } catch (error) {
    logger.error({ error, userId }, "Snooze walkthrough service error");
    return { success: false, error: "Failed to snooze walkthrough" };
  }
}
