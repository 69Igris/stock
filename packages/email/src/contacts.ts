import { getResendClient } from "./client";
import {
  RESEND_AUDIENCE_FREE_ID,
  RESEND_AUDIENCE_PAID_ID,
  RESEND_AUDIENCE_DOWNGRADED_ID,
  RESEND_AUDIENCE_USEMONEY_SECURITY_ID,
  RESEND_AUDIENCE_MARKETING_ID,
  NEWSLETTER_AUDIENCE_ID,
  EMAIL_SEGMENTS,
} from "./constants";

/**
 * Segment audiences in Resend:
 * - "free": users who signed up but have never paid
 * - "paid": users with an active paid subscription (PRO/PREMIUM/ULTIMATE)
 * - "downgraded": users who had a paid subscription but are now on FREE plan
 *   (different from "free" - these users have payment history, good for win-back campaigns)
 * - "usemoney-security": all users (security & account notifications, no unsubscribe)
 * - "marketing": users who explicitly opted into marketing (separate consent)
 */
export type Segment =
  | "free"
  | "paid"
  | "downgraded"
  | "usemoney-security"
  | "marketing";

interface CreateContactOptions {
  email: string;
  firstName?: string;
  lastName?: string;
  unsubscribed?: boolean;
}

// NOTE (MONEY-864): the legacy single-audience helpers `getAudienceId`,
// `upsertResendContact`, and `unsubscribeResendContact` were removed. They read
// `process.env.RESEND_AUDIENCE_ID`, which is NOT configured in any environment,
// so every call silently no-op'd. The newsletter flow now uses
// `addToNewsletterAudience` / `removeFromNewsletterAudience` (RESEND_AUDIENCE_
// NEWSLETTER_ID) and the Clerk user sync uses the segment helpers below.

// ---------------------------------------------------------------------------
// Segment-based contact management (multi-audience)
// ---------------------------------------------------------------------------

/**
 * Resolve audience ID for a segment. Returns null if not configured.
 */
function getSegmentAudienceId(segment: Segment): string | null {
  let id: string;
  switch (segment) {
    case "free":
      id = RESEND_AUDIENCE_FREE_ID;
      break;
    case "paid":
      id = RESEND_AUDIENCE_PAID_ID;
      break;
    case "downgraded":
      id = RESEND_AUDIENCE_DOWNGRADED_ID;
      break;
    case "usemoney-security":
      id = RESEND_AUDIENCE_USEMONEY_SECURITY_ID;
      break;
    case "marketing":
      id = RESEND_AUDIENCE_MARKETING_ID;
      break;
    default:
      return null;
  }
  return id || null;
}

/**
 * Add (upsert) a contact to a segment audience.
 * Fire-and-forget: silently skips if audience ID not configured.
 */
export async function addContactToSegment(
  segment: Segment,
  contact: Omit<CreateContactOptions, "unsubscribed">,
): Promise<{ success: boolean }> {
  const audienceId = getSegmentAudienceId(segment);
  if (!audienceId) {
    console.warn(
      `[Resend Segments] No audience ID configured for segment "${segment}" - check RESEND_AUDIENCE_${segment.toUpperCase().replace("-", "_")}_ID env var. Skipping.`,
    );
    return { success: false };
  }

  try {
    const resend = getResendClient();
    const { error } = await resend.contacts.create({
      audienceId,
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      unsubscribed: false,
    });

    if (error) {
      console.error(`[Resend Segments] Failed to add to ${segment}:`, error);
      return { success: false };
    }

    console.log(
      `[Resend Segments] Added ${contact.email} to ${segment} audience`,
    );
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Resend Segments] Error adding to ${segment}:`, message);
    return { success: false };
  }
}

/**
 * Remove a contact from a segment audience.
 * Fire-and-forget: silently skips if audience ID not configured.
 */
export async function removeContactFromSegment(
  segment: Segment,
  email: string,
): Promise<{ success: boolean }> {
  const audienceId = getSegmentAudienceId(segment);
  if (!audienceId) return { success: false };

  try {
    const resend = getResendClient();
    const { error } = await resend.contacts.remove({
      audienceId,
      email,
    });

    if (error) {
      console.error(
        `[Resend Segments] Failed to remove from ${segment}:`,
        error,
      );
      return { success: false };
    }

    console.log(`[Resend Segments] Removed ${email} from ${segment} audience`);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Resend Segments] Error removing from ${segment}:`, message);
    return { success: false };
  }
}

/**
 * Move a contact between segment audiences (remove from old, add to new).
 * Fire-and-forget: both operations are independent.
 */
export async function moveContactToSegment(
  email: string,
  fromSegment: Segment,
  toSegment: Segment,
  contact: Omit<CreateContactOptions, "unsubscribed">,
): Promise<{ success: boolean }> {
  const [removeResult, addResult] = await Promise.all([
    removeContactFromSegment(fromSegment, email),
    addContactToSegment(toSegment, contact),
  ]);

  return { success: removeResult.success && addResult.success };
}

// ---------------------------------------------------------------------------
// Direct audience operations (for sync / admin use)
// ---------------------------------------------------------------------------

export type ResendContact = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  unsubscribed: boolean;
  created_at: string;
};

/**
 * List all contacts in a Resend audience.
 * Returns empty array if audience ID is not set or on error.
 */
export async function listResendContacts(
  audienceId: string,
): Promise<ResendContact[]> {
  if (!audienceId) return [];

  try {
    const resend = getResendClient();
    const { data, error } = await resend.contacts.list({ audienceId });

    if (error) {
      console.error("[Resend Contacts] Failed to list contacts:", error);
      return [];
    }

    return (data?.data as unknown as ResendContact[]) ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Resend Contacts] Error listing contacts:", message);
    return [];
  }
}

/**
 * Add a contact to a specific audience by audience ID.
 * Returns the contact ID on success.
 */
export async function addContactToAudience(
  email: string,
  audienceId: string,
  firstName?: string,
  lastName?: string,
): Promise<{ success: boolean; contactId?: string }> {
  if (!audienceId) return { success: false };

  try {
    const resend = getResendClient();
    const { data, error } = await resend.contacts.create({
      audienceId,
      email,
      firstName,
      lastName,
      unsubscribed: false,
    });

    if (error) {
      console.error("[Resend Contacts] Failed to add contact:", error);
      return { success: false };
    }

    return { success: true, contactId: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Resend Contacts] Error adding contact:", message);
    return { success: false };
  }
}

/**
 * Remove a contact from an audience by contact ID.
 */
export async function removeContactFromAudience(
  contactId: string,
  audienceId: string,
): Promise<{ success: boolean }> {
  if (!audienceId || !contactId) return { success: false };

  try {
    const resend = getResendClient();
    const { error } = await resend.contacts.remove({
      audienceId,
      id: contactId,
    });

    if (error) {
      console.error("[Resend Contacts] Failed to remove contact:", error);
      return { success: false };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Resend Contacts] Error removing contact:", message);
    return { success: false };
  }
}

// ---------------------------------------------------------------------------
// Newsletter audience helpers (audience-id-aware, ok/error return shape)
// ---------------------------------------------------------------------------

interface AudienceContactInput {
  email: string;
  audienceId: string;
  firstName?: string;
  lastName?: string;
}

interface AudienceRemoveInput {
  email: string;
  audienceId: string;
}

interface AudienceResult {
  ok: boolean;
  error?: string;
}

/**
 * Add a contact to an audience by email address (idempotent — Resend
 * deduplicates by email; a 422 "already exists" is treated as success).
 *
 * Returns `{ ok: false, error: "audience-not-configured" }` when
 * `audienceId` is empty/undefined without making an API call.
 */
export async function addContactToAudienceByEmail(
  input: AudienceContactInput,
): Promise<AudienceResult> {
  const { email, audienceId, firstName, lastName } = input;
  if (!audienceId) return { ok: false, error: "audience-not-configured" };

  try {
    const resend = getResendClient();
    const { error } = await resend.contacts.create({
      audienceId,
      email,
      firstName,
      lastName,
      unsubscribed: false,
    });

    if (error) {
      // 422 "already exists" → treat as success (idempotent)
      const msg =
        typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      if (msg.toLowerCase().includes("already exists")) {
        return { ok: true };
      }
      console.error("[Resend Audience] Failed to add contact:", error);
      return { ok: false, error: msg };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Resend Audience] Error adding contact:", message);
    return { ok: false, error: message };
  }
}

/**
 * Remove a contact from an audience by email address.
 *
 * Returns `{ ok: false, error: "audience-not-configured" }` when
 * `audienceId` is empty/undefined without making an API call.
 */
export async function removeContactFromAudienceByEmail(
  input: AudienceRemoveInput,
): Promise<AudienceResult> {
  const { email, audienceId } = input;
  if (!audienceId) return { ok: false, error: "audience-not-configured" };

  try {
    const resend = getResendClient();
    const { error } = await resend.contacts.remove({
      audienceId,
      email,
    });

    if (error) {
      const msg =
        typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      console.error("[Resend Audience] Failed to remove contact:", error);
      return { ok: false, error: msg };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Resend Audience] Error removing contact:", message);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Newsletter-specific shortcuts (read NEWSLETTER_AUDIENCE_ID from constants)
// ---------------------------------------------------------------------------

interface NewsletterContactInput {
  email: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Add a contact to the newsletter audience.
 * Reads `RESEND_AUDIENCE_NEWSLETTER_ID` from env via the constants module.
 */
export async function addToNewsletterAudience(
  input: NewsletterContactInput,
): Promise<AudienceResult> {
  return addContactToAudienceByEmail({
    ...input,
    audienceId: NEWSLETTER_AUDIENCE_ID,
  });
}

/**
 * Remove a contact from the newsletter audience.
 * Reads `RESEND_AUDIENCE_NEWSLETTER_ID` from env via the constants module.
 */
export async function removeFromNewsletterAudience(
  input: Pick<NewsletterContactInput, "email">,
): Promise<AudienceResult> {
  return removeContactFromAudienceByEmail({
    email: input.email,
    audienceId: NEWSLETTER_AUDIENCE_ID,
  });
}

// ---------------------------------------------------------------------------
// Segment-aware helpers (for Stream 4's Marketing toggle and future segments)
// ---------------------------------------------------------------------------

type AudienceSegment = "newsletter" | "marketing";

/**
 * Resolve the audience ID for a named segment from the EMAIL_SEGMENTS registry.
 * Returns an empty string when the segment is not configured.
 */
function getAudienceIdForSegment(segment: AudienceSegment): string {
  const entry = EMAIL_SEGMENTS.find((s) => s.id === segment);
  return entry?.audienceId ?? "";
}

/**
 * Add a contact to a named audience segment.
 *
 * Returns `{ ok: false, error: "not-configured" }` when the segment's env var
 * is unset — the caller (e.g. Stream 4 Marketing toggle) must surface this as
 * a "Not yet active" hint rather than an error.
 */
export async function addToAudience(
  segment: AudienceSegment,
  input: NewsletterContactInput,
): Promise<AudienceResult> {
  const audienceId = getAudienceIdForSegment(segment);
  if (!audienceId) return { ok: false, error: "not-configured" };
  return addContactToAudienceByEmail({ ...input, audienceId });
}

/**
 * Remove a contact from a named audience segment.
 *
 * Returns `{ ok: false, error: "not-configured" }` when the segment's env var
 * is unset.
 */
export async function removeFromAudience(
  segment: AudienceSegment,
  input: Pick<NewsletterContactInput, "email">,
): Promise<AudienceResult> {
  const audienceId = getAudienceIdForSegment(segment);
  if (!audienceId) return { ok: false, error: "not-configured" };
  return removeContactFromAudienceByEmail({ email: input.email, audienceId });
}
