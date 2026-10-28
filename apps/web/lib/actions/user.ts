"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { syncClerkUserData } from "@/lib/db/user";
import { getAuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { ActionResponse } from "@usemoney/validation";
import { getCached, setCached } from "@usemoney/core";
import { authLogger as logger } from "@usemoney/logger";
import { getSafeErrorMessage } from "@usemoney/utils/error-sanitization";
import { addContactToSegment, removeContactFromSegment } from "@usemoney/email";

/**
 * In-memory throttle for syncUserDataAction.
 * Prevents redundant DB upserts when the same user loads multiple pages.
 * Map<clerkUserId, lastSyncTimestamp>
 */
const syncThrottle = new Map<string, number>();
const SYNC_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Sync Clerk user data to database
 * Call this when user logs in or when profile is updated.
 *
 * Throttled: skips if already synced within the last 5 minutes.
 * Pass force=true to bypass throttle (e.g., manual sync button).
 */
export async function syncUserDataAction(
  force = false
): Promise<ActionResponse<void>> {
  try {
    const { userId } = await auth();
    if (!userId) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    // Check throttle - skip if synced recently (unless forced)
    if (!force) {
      const lastSync = syncThrottle.get(userId);
      if (lastSync && Date.now() - lastSync < SYNC_THROTTLE_MS) {
        return { success: true }; // Already synced recently, no-op
      }
    }

    await syncClerkUserData();
    syncThrottle.set(userId, Date.now());
    return { success: true };
  } catch (error) {
    logger.error(
      { error, action: "syncUserDataAction" },
      "Sync user data error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to sync user data"),
    };
  }
}

/**
 * Get account creation date and remaining days for free plan broker sync with caching
 * Cache: 5 minutes (static data - account creation date doesn't change)
 */
export async function getAccountTrialInfoAction(): Promise<
  ActionResponse<{
    createdAt: string;
    remainingDays: number;
    isExpired: boolean;
  }>
> {
  try {
    const { userId } = await auth();
    const clerkUser = await currentUser();

    if (!userId || !clerkUser?.emailAddresses?.[0]?.emailAddress) {
      return { success: false, error: "Unauthorized" };
    }

    const email = clerkUser.emailAddresses[0].emailAddress;
    const user = await prisma.user.findFirst({
      where: { email },
      select: { id: true, createdAt: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    // Try cache first
    const cached = await getCached<{
      createdAt: string;
      remainingDays: number;
      isExpired: boolean;
    }>(
      "user",
      user.id,
      "trial",
      undefined,
      { ttl: 5 * 60 } // 5 minutes - trial info recalculated daily
    );

    if (cached) {
      logger.debug({ userId: user.id }, "Trial info from cache");
      return { success: true, data: cached };
    }

    // Cache miss - calculate trial info
    logger.debug({ userId: user.id }, "Trial info cache miss");
    const createdAt = user.createdAt;
    const now = new Date();
    const daysSinceCreation = Math.floor(
      (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    const remainingDays = Math.max(0, 30 - daysSinceCreation);
    const isExpired = daysSinceCreation >= 30;

    const result = {
      createdAt: createdAt.toISOString(),
      remainingDays,
      isExpired,
    };

    // Store in cache
    await setCached("user", user.id, "trial", result, undefined, {
      ttl: 5 * 60,
    });

    return { success: true, data: result };
  } catch (error) {
    logger.error(
      { error, action: "getAccountTrialInfoAction" },
      "Get trial info error"
    );
    return { success: false, error: "Failed to get account trial info" };
  }
}

const VALID_CURRENCIES = ["INR", "USD", "EUR", "GBP"] as const;

/**
 * Get the user's preferred currency from the database.
 */
export async function getCurrencyPreferenceAction(): Promise<
  ActionResponse<{ currency: string }>
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { preferredCurrency: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    return { success: true, data: { currency: user.preferredCurrency } };
  } catch (error) {
    logger.error(
      { error, action: "getCurrencyPreferenceAction" },
      "Get currency preference error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to get currency preference"),
    };
  }
}

/**
 * Update the user's preferred currency.
 * Valid values: INR, USD, EUR, GBP.
 */
export async function updateCurrencyPreferenceAction(
  currency: string
): Promise<ActionResponse<{ currency: string }>> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    if (
      !VALID_CURRENCIES.includes(currency as (typeof VALID_CURRENCIES)[number])
    ) {
      return {
        success: false,
        error: `Invalid currency. Must be one of: ${VALID_CURRENCIES.join(", ")}`,
      };
    }

    const updated = await prisma.user.update({
      where: { id: authUser.userId },
      data: { preferredCurrency: currency },
      select: { preferredCurrency: true },
    });

    return { success: true, data: { currency: updated.preferredCurrency } };
  } catch (error) {
    logger.error(
      { error, action: "updateCurrencyPreferenceAction" },
      "Update currency preference error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to update currency preference"),
    };
  }
}

// ============== DEFAULT PAGE PREFERENCE ==============

const VALID_DEFAULT_PAGES = ["dashboard", "stocksage"] as const;
type DefaultPage = (typeof VALID_DEFAULT_PAGES)[number];

/**
 * Get the user's preferred default page after login.
 * Reads `preferences.defaultPage` from the User's preferences JSON blob.
 *
 * Defaults to "stocksage" (chat) when unset. Users who prefer the portfolio
 * overview can switch it in Settings → Preferences, and an EXPLICITLY stored
 * "dashboard" is honoured — this only moves the answer for people who never
 * chose, which is nearly everyone, since the preference is opt-in.
 */
export async function getDefaultPagePreferenceAction(): Promise<
  | { success: true; value: DefaultPage; isExplicit: boolean }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { preferences: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    const prefs = (user.preferences as Record<string, unknown>) ?? {};
    const stored = prefs["defaultPage"];
    const isExplicit =
      typeof stored === "string" &&
      VALID_DEFAULT_PAGES.includes(stored as DefaultPage);
    const value: DefaultPage = isExplicit
      ? (stored as DefaultPage)
      : "stocksage";

    // `isExplicit` separates "the user chose StockSage" from "the user chose
    // nothing and StockSage is the default". Both yield the same `value` — and
    // for redirect purposes that is the whole point — but they are NOT the same
    // signal for anything that adapts to a deliberate choice. The walkthrough's
    // adaptive intro ordering is exactly such a consumer: it swaps to the
    // chat-first tour for StockSage users, and since the default flipped, it
    // would otherwise swap for EVERY new sign-up — pulling a brand-new user off
    // the dashboard they just landed on into an empty chat. That is a different
    // product decision than "where does sign-in land", so it needs a different
    // signal.
    return { success: true, value, isExplicit };
  } catch (error) {
    logger.error(
      { error, action: "getDefaultPagePreferenceAction" },
      "Get default page preference error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(
        error,
        "Failed to get default page preference"
      ),
    };
  }
}

/**
 * Update the user's preferred default page after login.
 * Writes `preferences.defaultPage` into the User's preferences JSON blob,
 * merging with any existing preference namespaces (research, composer, etc.).
 * Valid values: "dashboard" | "stocksage".
 */
export async function updateDefaultPagePreferenceAction(
  value: DefaultPage
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    if (!VALID_DEFAULT_PAGES.includes(value)) {
      return {
        success: false,
        error: `Invalid value. Must be one of: ${VALID_DEFAULT_PAGES.join(", ")}`,
      };
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { preferences: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    const existingPrefs = (user.preferences as Record<string, unknown>) ?? {};
    const updatedPrefs = { ...existingPrefs, defaultPage: value };

    await prisma.user.update({
      where: { id: authUser.userId },
      data: { preferences: updatedPrefs },
    });

    return { success: true };
  } catch (error) {
    logger.error(
      { error, action: "updateDefaultPagePreferenceAction" },
      "Update default page preference error"
    );
    return {
      success: false,
      error: getSafeErrorMessage(
        error,
        "Failed to update default page preference"
      ),
    };
  }
}

// ============== TERMS ACCEPTANCE ==============

/**
 * Check if the current user has accepted terms.
 * Returns true if `termsAcceptedAt` is set, false otherwise.
 * Returns true for unauthenticated requests (they'll be blocked by middleware anyway).
 *
 * MONEY-445 / MONEY-144 — also returns true if the user has any
 * in-flight delete-account audit row (PENDING/PROCESSING/LOCKED).
 * Without this, a refresh during the worker window or the 24h
 * locked-but-not-purged window can race with `getOrCreateUser`
 * re-materialising a phantom row with `termsAcceptedAt = null`, which
 * would otherwise pop the TermsGate modal as if the user were brand new.
 */
/**
 * MONEY-144 - true when the caller has a valid Clerk session but the
 * underlying account is being / has been deleted. Triggers a
 * client-side signOut + redirect so the user doesn't sit in a
 * half-state where Clerk thinks they exist and every server action
 * 500s on the missing DB user. Conditions:
 *   - Clerk session present
 *   - DeletedUserAudit row exists for the clerkId in
 *     PENDING / PROCESSING / LOCKED state
 *     (LOCKED means the worker pipeline finished hard-deleting the
 *     User row but the Clerk identity is held for 24h)
 * Returns false on any error so we never accidentally sign out a
 * healthy user.
 *
 * MONEY-1126: `determined` reports whether `ghosted` is a real answer or the
 * fail-open default. The caller caches this result, and the two are NOT
 * interchangeable: remembering a defaulted `ghosted: false` would disable the
 * check for the rest of the page load, so one transient DB error would stop a
 * genuinely ghosted session from ever being signed out. Fail-open stays the
 * behaviour for the request; it just may not be remembered.
 */
export async function isSessionGhostedAction(): Promise<{
  ghosted: boolean;
  determined: boolean;
}> {
  try {
    const { userId: clerkUserId } = await auth();
    // No server-side session while the client believes it has one: a desync,
    // not an answer about this user.
    if (!clerkUserId) return { ghosted: false, determined: false };

    const audit = await prisma.deletedUserAudit.findFirst({
      where: {
        clerkId: clerkUserId,
        status: { in: ["PENDING", "PROCESSING", "LOCKED"] },
      },
      select: { id: true },
    });
    return { ghosted: audit !== null, determined: true };
  } catch {
    return { ghosted: false, determined: false };
  }
}

/**
 * MONEY-1126: see the note on `isSessionGhostedAction`. `determined` separates a
 * real acceptance answer from the fail-open default, because the caller caches
 * it. `hasAcceptedTermsAction` never rejects — it converts every failure into
 * the NON-blocking value — so without this flag a single DB hiccup would be
 * remembered as "accepted" and the terms gate would stay open for the rest of
 * the page load even after the database recovered. That is a compliance gate, so
 * only a genuine answer may be reused.
 */
export async function hasAcceptedTermsAction(): Promise<{
  accepted: boolean;
  determined: boolean;
}> {
  try {
    const { userId: clerkUserId } = await auth();
    // Not authenticated server-side while the client thinks it is — let
    // middleware handle it, but do not record it as an answer about this user.
    if (!clerkUserId) return { accepted: true, determined: false };

    const pendingDeletion = await prisma.deletedUserAudit.findFirst({
      where: {
        clerkId: clerkUserId,
        status: { in: ["PENDING", "PROCESSING", "LOCKED"] },
      },
      select: { id: true },
    });
    // Mid-deletion - never block with the modal. A real, stable answer.
    if (pendingDeletion) return { accepted: true, determined: true };

    const user = await prisma.user.findFirst({
      where: { OR: [{ clerkId: clerkUserId }, { email: clerkUserId }] },
      select: { termsAcceptedAt: true },
    });

    return { accepted: user?.termsAcceptedAt != null, determined: true };
  } catch {
    // Don't block the user on this request — but don't let it be cached either.
    return { accepted: true, determined: false };
  }
}

/**
 * Record that the user accepted the Terms of Service, Privacy Policy,
 * Data Usage Policy, and Risk Disclosure. Also stores optional
 * preferences (marketing emails, analytics consent) in emailPreferences.
 */
export async function acceptTermsAction(optionalPrefs?: {
  marketing?: boolean;
  analytics?: boolean;
}): Promise<ActionResponse<void>> {
  try {
    const { userId: clerkUserId } = await auth();
    logger.info({ clerkUserId }, "[acceptTerms] auth resolved");
    if (!clerkUserId) {
      logger.warn("[acceptTerms] no clerkUserId from auth()");
      return { success: false, error: "Authentication required" };
    }

    const user = await prisma.user.findFirst({
      where: { OR: [{ clerkId: clerkUserId }, { email: clerkUserId }] },
      select: { id: true, email: true, name: true, emailPreferences: true },
    });

    if (!user) {
      logger.warn({ clerkUserId }, "[acceptTerms] user not found in DB");
      return { success: false, error: "User not found" };
    }

    logger.info(
      { userId: user.id, email: user.email },
      "[acceptTerms] found user, writing termsAcceptedAt"
    );

    const wantsMarketing = optionalPrefs?.marketing ?? false;

    // Merge optional preferences into existing emailPreferences JSON
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

    // Sync marketing segment in Resend
    const nameParts = (user.name || "").split(" ");
    if (wantsMarketing) {
      logger.info(
        { email: user.email, segment: "marketing" },
        "[acceptTerms] Adding to marketing segment"
      );
      addContactToSegment("marketing", {
        email: user.email,
        firstName: nameParts[0] || undefined,
        lastName: nameParts.slice(1).join(" ") || undefined,
      })
        .then((result) => {
          logger.info(
            { email: user.email, result },
            "[acceptTerms] Marketing segment sync result"
          );
        })
        .catch((err) => {
          logger.error(
            { err, email: user.email },
            "[acceptTerms] Failed to add to marketing segment"
          );
        });
    } else {
      removeContactFromSegment("marketing", user.email).catch((err) =>
        logger.warn({ err }, "Failed to remove from marketing segment")
      );
    }

    return { success: true, data: undefined };
  } catch (error: unknown) {
    logger.error({ error }, "Accept terms error");
    return {
      success: false,
      error: getSafeErrorMessage(error, "Failed to accept terms"),
    };
  }
}
