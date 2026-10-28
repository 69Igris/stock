"use server";

import { type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getEffectivePreferences,
  type EmailPreferences,
  addContactToSegment,
  removeContactFromSegment,
  addToAudience,
  removeFromAudience,
  EMAIL_SEGMENTS,
} from "@usemoney/email";
import { validateEmailPreferences } from "@/lib/actions/email-preferences-logic";

export async function getEmailPreferencesAction(): Promise<{
  success: boolean;
  data?: EmailPreferences;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { emailPreferences: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    return {
      success: true,
      data: getEffectivePreferences(user.emailPreferences),
    };
  } catch (error) {
    console.error("Get email preferences error:", error);
    return { success: false, error: "Failed to get email preferences" };
  }
}

export async function updateEmailPreferencesAction(
  preferences: EmailPreferences
): Promise<{
  success: boolean;
  data?: EmailPreferences;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    // Validate that all keys are booleans (full key set incl. usageAnalytics)
    const validation = validateEmailPreferences(
      preferences as unknown as Record<string, unknown>
    );
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { email: true, name: true, emailPreferences: true },
    });

    const updated = await prisma.user.update({
      where: { id: authUser.userId },
      data: {
        emailPreferences: preferences as unknown as Prisma.InputJsonValue,
      },
      select: { emailPreferences: true },
    });

    // Sync marketing segment in Resend (fire-and-forget)
    if (user?.email) {
      const oldPrefs = getEffectivePreferences(user.emailPreferences);
      const newPrefs = preferences;
      if (oldPrefs.marketingEmails !== newPrefs.marketingEmails) {
        const nameParts = (user.name || "").split(" ");
        if (newPrefs.marketingEmails) {
          addContactToSegment("marketing", {
            email: user.email,
            firstName: nameParts[0] || undefined,
            lastName: nameParts.slice(1).join(" ") || undefined,
          }).catch(() => {});
        } else {
          removeContactFromSegment("marketing", user.email).catch(() => {});
        }
      }
    }

    return {
      success: true,
      data: getEffectivePreferences(updated.emailPreferences),
    };
  } catch (error) {
    console.error("Update email preferences error:", error);
    return { success: false, error: "Failed to update email preferences" };
  }
}

// ---------------------------------------------------------------------------
// Email segment subscription actions (newsletter + marketing audiences)
// ---------------------------------------------------------------------------

type EmailSegmentId = "newsletter" | "marketing";

/**
 * Returns the user's current subscription state for the two managed audience
 * segments: newsletter (via NewsletterSubscriber row) and marketing (via the
 * User.emailPreferences.marketingEmails boolean).
 */
export async function getEmailSegmentSubscriptionsAction(): Promise<
  | {
      success: true;
      subscriptions: { newsletter: boolean; marketing: boolean };
    }
  | { success: false; error: string }
> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { email: true, emailPreferences: true },
    });

    if (!user) {
      return { success: false, error: "User not found" };
    }

    // Newsletter: check NewsletterSubscriber row for ACTIVE status
    let newsletter = false;
    if (user.email) {
      const sub = await prisma.newsletterSubscriber.findUnique({
        where: { email: user.email },
        select: { status: true },
      });
      newsletter = sub?.status === "ACTIVE";
    }

    // Marketing: read from emailPreferences JSON column
    const prefs = getEffectivePreferences(user.emailPreferences);
    const marketing = prefs.marketingEmails;

    return { success: true, subscriptions: { newsletter, marketing } };
  } catch (error) {
    console.error("Get email segment subscriptions error:", error);
    return {
      success: false,
      error: "Failed to get email segment subscriptions",
    };
  }
}

/**
 * Subscribe or unsubscribe from an audience segment.
 *
 * - "newsletter": syncs with Resend newsletter audience + upserts
 *   NewsletterSubscriber row (ACTIVE / UNSUBSCRIBED).
 * - "marketing": syncs with Resend marketing audience + updates
 *   User.emailPreferences.marketingEmails boolean.
 *
 * Returns `{ success: false, error: "marketing-not-configured" }` when the
 * marketing audience env var is unset — the UI surfaces this as disabled.
 */
export async function toggleEmailSegmentSubscriptionAction(
  segment: EmailSegmentId,
  subscribed: boolean
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const user = await prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { email: true, name: true, emailPreferences: true },
    });

    if (!user || !user.email) {
      return { success: false, error: "User not found" };
    }

    // Guard: if the segment's audience is not configured, fail fast so the UI
    // can show the "Not yet active" disabled state.
    const segmentEntry = EMAIL_SEGMENTS.find((s) => s.id === segment);
    if (!segmentEntry?.audienceId) {
      if (segment === "marketing") {
        return { success: false, error: "marketing-not-configured" };
      }
      // newsletter is always provisioned, but guard anyway
      return {
        success: false,
        error: `${segment}-not-configured`,
      };
    }

    const nameParts = (user.name ?? "").split(" ");
    const firstName = nameParts[0] || undefined;
    const lastName = nameParts.slice(1).join(" ") || undefined;

    if (subscribed) {
      await addToAudience(segment, {
        email: user.email,
        firstName,
        lastName,
      });
    } else {
      await removeFromAudience(segment, { email: user.email });
    }

    // Persist state in the DB so getEmailSegmentSubscriptionsAction can read
    // it without querying Resend on every page load.
    if (segment === "newsletter") {
      await prisma.newsletterSubscriber.upsert({
        where: { email: user.email },
        update: {
          status: subscribed ? "ACTIVE" : "UNSUBSCRIBED",
          subscribedAt: subscribed ? new Date() : undefined,
          unsubscribedAt: subscribed ? undefined : new Date(),
          segments: subscribed ? ["newsletter"] : [],
        },
        create: {
          email: user.email,
          name: user.name ?? undefined,
          status: subscribed ? "ACTIVE" : "UNSUBSCRIBED",
          source: "settings",
          segments: subscribed ? ["newsletter"] : [],
          subscribedAt: subscribed ? new Date() : undefined,
          unsubscribedAt: subscribed ? undefined : new Date(),
        },
      });
    } else {
      // marketing: persist in emailPreferences JSON
      const currentPrefs = getEffectivePreferences(user.emailPreferences);
      const updated: EmailPreferences = {
        ...currentPrefs,
        marketingEmails: subscribed,
      };
      await prisma.user.update({
        where: { id: authUser.userId },
        data: {
          emailPreferences: updated as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return { success: true };
  } catch (error) {
    console.error("Toggle email segment subscription error:", error);
    return {
      success: false,
      error: "Failed to update email subscription",
    };
  }
}
