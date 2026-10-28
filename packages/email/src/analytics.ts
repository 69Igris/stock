import { getResendClient } from "./client";

// Types for email analytics
export type EmailAnalytics = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
  last_event: string;
};

export type BroadcastAnalytics = {
  id: string;
  name: string | null;
  audience_id: string | null;
  status: string;
  created_at: string;
  scheduled_at: string | null;
  sent_at: string | null;
};

export type BroadcastSummary = {
  id: string;
  name: string | null;
  audience_id: string | null;
  status: string;
  created_at: string;
};

/**
 * Get analytics for a single email by ID.
 * Returns email details including status and last event.
 */
export async function getEmailAnalytics(
  emailId: string,
): Promise<EmailAnalytics | null> {
  try {
    const resend = getResendClient();
    const { data, error } = await resend.emails.get(emailId);

    if (error || !data) {
      console.error("[Email Analytics] Failed to get email:", error);
      return null;
    }

    return {
      id: data.id,
      from: data.from,
      to: data.to,
      subject: data.subject,
      created_at: data.created_at,
      last_event: data.last_event,
    };
  } catch (err) {
    console.error("[Email Analytics] Error:", err);
    return null;
  }
}

/**
 * Get analytics for a broadcast by ID.
 * Returns broadcast details and delivery stats.
 */
export async function getBroadcastAnalytics(
  broadcastId: string,
): Promise<BroadcastAnalytics | null> {
  try {
    const resend = getResendClient();
    const { data, error } = await resend.broadcasts.get(broadcastId);

    if (error || !data) {
      console.error("[Broadcast Analytics] Failed to get broadcast:", error);
      return null;
    }

    return {
      id: data.id,
      name: data.name ?? null,
      audience_id: data.audience_id ?? null,
      status: data.status,
      created_at: data.created_at,
      scheduled_at: data.scheduled_at ?? null,
      sent_at: data.sent_at ?? null,
    };
  } catch (err) {
    console.error("[Broadcast Analytics] Error:", err);
    return null;
  }
}

/**
 * List all broadcasts.
 * Returns a summary list of all broadcasts.
 */
export async function listBroadcasts(): Promise<BroadcastSummary[]> {
  try {
    const resend = getResendClient();
    const { data, error } = await resend.broadcasts.list();

    if (error || !data) {
      console.error("[Broadcast Analytics] Failed to list broadcasts:", error);
      return [];
    }

    return (data.data ?? []).map((b) => ({
      id: b.id,
      name: b.name ?? null,
      audience_id: b.audience_id ?? null,
      status: b.status,
      created_at: b.created_at,
    }));
  } catch (err) {
    console.error("[Broadcast Analytics] Error:", err);
    return [];
  }
}
