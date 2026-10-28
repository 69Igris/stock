"use server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { prisma, ContentRole } from "@usemoney/database";
import type { ActionResponse } from "@usemoney/validation";
import {
  listResendContacts,
  addContactToAudience,
  removeContactFromAudience,
  RESEND_AUDIENCE_FREE_ID,
  RESEND_AUDIENCE_PAID_ID,
} from "@usemoney/email";
import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import {
  buildSubscriberWhere,
  validateUpdateSubscriber,
  sortTimelineEvents,
  type SubscriberFilter,
  type TimelineEvent,
} from "./subscribers-logic";
import { searchUsersAtlas } from "@/lib/atlas-user-search";

export type { SubscriberFilter, TimelineEvent } from "./subscribers-logic";

const RESEND_AUDIENCE_SECURITY_ID =
  process.env.RESEND_AUDIENCE_USEMONEY_SECURITY_ID || "";

type Subscriber = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  source: string | null;
  segments: string[];
  resendContactIds: Record<string, string> | null;
  subscribedAt: Date | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
};

export type SubscriberDetail = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  source: string | null;
  segments: string[];
  resendContactIds: Record<string, string> | null;
  note: string | null;
  location: string | null;
  imageUrl: string | null;
  subscribedAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
  emailActivity: {
    sent: number;
    failed: number;
    bounced: number;
    lastEmail: {
      subject: string;
      status: string;
      sentAt: string;
    } | null;
  };
};

type SubscriberStats = {
  total: number;
  active: number;
  pending: number;
  unsubscribed: number;
  bySegment: {
    free: number;
    paid: number;
    security: number;
  };
};

const SEGMENT_AUDIENCE_MAP: Record<string, string> = {
  free: RESEND_AUDIENCE_FREE_ID,
  paid: RESEND_AUDIENCE_PAID_ID,
  security: RESEND_AUDIENCE_SECURITY_ID,
};

/**
 * Verify the current user is an admin or owner
 */
async function requireAdmin() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  const author = await prisma.contentAuthor.findUnique({
    where: { clerkId },
    select: { id: true, role: true },
  });

  if (!author || author.role === "WRITER") return null;
  return author;
}

/**
 * Get subscriber statistics with per-segment breakdown
 */
export async function getSubscriberStats(): Promise<
  ActionResponse<SubscriberStats>
> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const [
      total,
      active,
      pending,
      unsubscribed,
      freeCount,
      paidCount,
      securityCount,
    ] = await Promise.all([
      prisma.newsletterSubscriber.count(),
      prisma.newsletterSubscriber.count({ where: { status: "ACTIVE" } }),
      prisma.newsletterSubscriber.count({ where: { status: "PENDING" } }),
      prisma.newsletterSubscriber.count({ where: { status: "UNSUBSCRIBED" } }),
      prisma.newsletterSubscriber.count({
        where: { segments: { hasSome: ["free"] } },
      }),
      prisma.newsletterSubscriber.count({
        where: { segments: { hasSome: ["paid"] } },
      }),
      prisma.newsletterSubscriber.count({
        where: { segments: { hasSome: ["security"] } },
      }),
    ]);

    return {
      success: true,
      data: {
        total,
        active,
        pending,
        unsubscribed,
        bySegment: {
          free: freeCount,
          paid: paidCount,
          security: securityCount,
        },
      },
    };
  } catch (error) {
    console.error("Get subscriber stats error:", error);
    return { success: false, error: "Failed to get subscriber stats" };
  }
}

/**
 * List all newsletter subscribers with optional filters
 */
export async function listSubscribers(
  filter?: SubscriberFilter,
): Promise<ActionResponse<Subscriber[]>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const where = buildSubscriberWhere(filter);

    const subscribers = await prisma.newsletterSubscriber.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return {
      success: true,
      data: subscribers.map((s) => ({
        ...s,
        resendContactIds:
          (s.resendContactIds as Record<string, string>) ?? null,
      })),
    };
  } catch (error) {
    console.error("List subscribers error:", error);
    return { success: false, error: "Failed to list subscribers" };
  }
}

/**
 * Manually unsubscribe a subscriber
 */
export async function unsubscribeSubscriber(
  id: string,
): Promise<ActionResponse<void>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    await prisma.newsletterSubscriber.update({
      where: { id },
      data: {
        status: "UNSUBSCRIBED",
        unsubscribedAt: new Date(),
      },
    });

    return { success: true, message: "Subscriber unsubscribed successfully" };
  } catch (error) {
    console.error("Unsubscribe subscriber error:", error);
    return { success: false, error: "Failed to unsubscribe" };
  }
}

/**
 * Export subscribers as CSV-formatted string
 */
export async function exportSubscribersCSV(): Promise<ActionResponse<string>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const subscribers = await prisma.newsletterSubscriber.findMany({
      where: { status: "ACTIVE" },
      orderBy: { subscribedAt: "asc" },
    });

    const header = "email,name,subscribed_at,source,segments";
    const rows = subscribers.map(
      (s) =>
        `${s.email},${s.name || ""},${s.subscribedAt?.toISOString() || ""},${s.source || ""},${(s.segments || []).join(";")}`,
    );

    return { success: true, data: [header, ...rows].join("\n") };
  } catch (error) {
    console.error("Export subscribers error:", error);
    return { success: false, error: "Failed to export subscribers" };
  }
}

/**
 * Sync subscribers from all Resend audiences into the local database.
 * Fetches contacts from free, paid, and security audiences, merges by email,
 * and upserts into the DB with segments[] and resendContactIds.
 */
export async function syncSubscribersFromResend(): Promise<
  ActionResponse<{ synced: number }>
> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const audiences = [
      { segment: "free", audienceId: RESEND_AUDIENCE_FREE_ID },
      { segment: "paid", audienceId: RESEND_AUDIENCE_PAID_ID },
      { segment: "security", audienceId: RESEND_AUDIENCE_SECURITY_ID },
    ].filter((a) => a.audienceId);

    // Fetch contacts from all audiences in parallel
    const results = await Promise.all(
      audiences.map(async ({ segment, audienceId }) => {
        const contacts = await listResendContacts(audienceId);
        return { segment, contacts };
      }),
    );

    // Merge by email
    const contactMap = new Map<
      string,
      {
        name: string | null;
        segments: string[];
        resendContactIds: Record<string, string>;
        unsubscribed: boolean;
      }
    >();

    for (const { segment, contacts } of results) {
      for (const contact of contacts) {
        const email = contact.email.toLowerCase();
        const existing = contactMap.get(email) || {
          name: null,
          segments: [],
          resendContactIds: {},
          unsubscribed: false,
        };

        const fullName = [contact.first_name, contact.last_name]
          .filter(Boolean)
          .join(" ");
        if (fullName && !existing.name) {
          existing.name = fullName;
        }

        existing.segments.push(segment);
        existing.resendContactIds[segment] = contact.id;
        if (contact.unsubscribed) {
          existing.unsubscribed = true;
        }

        contactMap.set(email, existing);
      }
    }

    // Upsert each contact into the database
    let synced = 0;
    for (const [email, data] of contactMap) {
      await prisma.newsletterSubscriber.upsert({
        where: { email },
        create: {
          email,
          name: data.name,
          status: data.unsubscribed ? "UNSUBSCRIBED" : "ACTIVE",
          segments: data.segments,
          resendContactIds: data.resendContactIds,
          subscribedAt: new Date(),
          source: "resend-sync",
          verifyToken: randomUUID(),
        },
        update: {
          segments: data.segments,
          resendContactIds: data.resendContactIds,
          ...(data.name && { name: data.name }),
          ...(data.unsubscribed && {
            status: "UNSUBSCRIBED" as const,
            unsubscribedAt: new Date(),
          }),
        },
      });
      synced++;
    }

    revalidatePath("/subscribers");

    return {
      success: true,
      data: { synced },
      message: `Synced ${synced} subscribers from Resend`,
    };
  } catch (error) {
    console.error("Sync subscribers from Resend error:", error);
    return { success: false, error: "Failed to sync from Resend" };
  }
}

/**
 * Toggle a subscriber's subscription status (active <-> unsubscribed).
 * Also syncs the toggle to Resend for all audiences the subscriber belongs to.
 */
export async function toggleSubscription(
  id: string,
): Promise<ActionResponse<void>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { id },
    });

    if (!subscriber) {
      return { success: false, error: "Subscriber not found" };
    }

    const newStatus =
      subscriber.status === "UNSUBSCRIBED" ? "ACTIVE" : "UNSUBSCRIBED";
    const isResubscribing = newStatus === "ACTIVE";

    await prisma.newsletterSubscriber.update({
      where: { id },
      data: {
        status: newStatus,
        ...(isResubscribing
          ? { unsubscribedAt: null, subscribedAt: new Date() }
          : { unsubscribedAt: new Date() }),
      },
    });

    // Sync to Resend: re-add or remove from each audience
    const contactIds =
      (subscriber.resendContactIds as Record<string, string>) ?? {};

    for (const segment of subscriber.segments) {
      const audienceId = SEGMENT_AUDIENCE_MAP[segment];
      if (!audienceId) continue;

      if (isResubscribing) {
        // Re-add contact to audience
        addContactToAudience(subscriber.email, audienceId).catch(() => {});
      } else {
        // Remove from audience
        const contactId = contactIds[segment];
        if (contactId) {
          removeContactFromAudience(contactId, audienceId).catch(() => {});
        }
      }
    }

    revalidatePath("/subscribers");

    return {
      success: true,
      message: isResubscribing
        ? "Subscriber re-activated"
        : "Subscriber unsubscribed",
    };
  } catch (error) {
    console.error("Toggle subscription error:", error);
    return { success: false, error: "Failed to toggle subscription" };
  }
}

/**
 * Update a subscriber's segments. Syncs additions/removals to Resend audiences.
 */
export async function updateSubscriberSegments(
  id: string,
  newSegments: string[],
): Promise<ActionResponse<void>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { id },
    });

    if (!subscriber) {
      return { success: false, error: "Subscriber not found" };
    }

    const oldSegments = subscriber.segments;
    const contactIds =
      (subscriber.resendContactIds as Record<string, string>) ?? {};

    const added = newSegments.filter((s) => !oldSegments.includes(s));
    const removed = oldSegments.filter((s) => !newSegments.includes(s));

    // Update local DB
    const updatedContactIds = { ...contactIds };

    // Add to new Resend audiences
    for (const segment of added) {
      const audienceId = SEGMENT_AUDIENCE_MAP[segment];
      if (!audienceId) continue;

      const result = await addContactToAudience(subscriber.email, audienceId);
      if (result.success && result.contactId) {
        updatedContactIds[segment] = result.contactId;
      }
    }

    // Remove from dropped Resend audiences
    for (const segment of removed) {
      const audienceId = SEGMENT_AUDIENCE_MAP[segment];
      const contactId = contactIds[segment];
      if (!audienceId || !contactId) continue;

      await removeContactFromAudience(contactId, audienceId);
      delete updatedContactIds[segment];
    }

    await prisma.newsletterSubscriber.update({
      where: { id },
      data: {
        segments: newSegments,
        resendContactIds: updatedContactIds,
      },
    });

    revalidatePath("/subscribers");

    return { success: true, message: "Segments updated successfully" };
  } catch (error) {
    console.error("Update subscriber segments error:", error);
    return { success: false, error: "Failed to update segments" };
  }
}

/**
 * Get a subscriber by ID with email activity summary
 */
export async function getSubscriberById(
  id: string,
): Promise<ActionResponse<SubscriberDetail>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { id },
    });

    if (!subscriber) {
      return { success: false, error: "Subscriber not found" };
    }

    // Query email activity + Clerk profile image
    const [sentCount, failedCount, bouncedCount, lastEmail, clerkImageUrl] =
      await Promise.all([
        prisma.emailLog.count({
          where: { to: subscriber.email, status: "SENT" },
        }),
        prisma.emailLog.count({
          where: { to: subscriber.email, status: "FAILED" },
        }),
        prisma.emailLog.count({
          where: { to: subscriber.email, status: "BOUNCED" },
        }),
        prisma.emailLog.findFirst({
          where: { to: subscriber.email },
          orderBy: { createdAt: "desc" },
        }),
        (async (): Promise<string | null> => {
          try {
            const client = await clerkClient();
            const users = await client.users.getUserList({
              emailAddress: [subscriber.email],
              limit: 1,
            });
            return users.data[0]?.imageUrl ?? null;
          } catch {
            return null;
          }
        })(),
      ]);

    return {
      success: true,
      data: {
        id: subscriber.id,
        email: subscriber.email,
        name: subscriber.name,
        status: subscriber.status,
        source: subscriber.source,
        segments: subscriber.segments,
        resendContactIds:
          (subscriber.resendContactIds as Record<string, string>) ?? null,
        note: subscriber.note ?? null,
        location: subscriber.location ?? null,
        imageUrl: clerkImageUrl,
        subscribedAt: subscriber.subscribedAt?.toISOString() ?? null,
        unsubscribedAt: subscriber.unsubscribedAt?.toISOString() ?? null,
        createdAt: subscriber.createdAt.toISOString(),
        emailActivity: {
          sent: sentCount,
          failed: failedCount,
          bounced: bouncedCount,
          lastEmail: lastEmail
            ? {
                subject: lastEmail.subject,
                status: lastEmail.status,
                sentAt: lastEmail.createdAt.toISOString(),
              }
            : null,
        },
      },
    };
  } catch (error) {
    console.error("Get subscriber by ID error:", error);
    return { success: false, error: "Failed to get subscriber" };
  }
}

/**
 * Update subscriber editable fields (name, note, location)
 */
export async function updateSubscriber(
  id: string,
  data: { name?: string; note?: string; location?: string },
): Promise<ActionResponse<void>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const validation = validateUpdateSubscriber(data);
    if (!validation.valid) {
      return { success: false, error: validation.error! };
    }

    await prisma.newsletterSubscriber.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name || null }),
        ...(data.note !== undefined && { note: data.note || null }),
        ...(data.location !== undefined && { location: data.location || null }),
      },
    });

    revalidatePath(`/subscribers/${id}`);

    return { success: true, message: "Subscriber updated" };
  } catch (error) {
    console.error("Update subscriber error:", error);
    return { success: false, error: "Failed to update subscriber" };
  }
}

/**
 * Delete a subscriber and remove from all Resend audiences
 */
export async function deleteSubscriber(
  id: string,
): Promise<ActionResponse<void>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { id },
    });

    if (!subscriber) {
      return { success: false, error: "Subscriber not found" };
    }

    // Remove from all Resend audiences (fire-and-forget)
    const contactIds =
      (subscriber.resendContactIds as Record<string, string>) ?? {};
    for (const segment of subscriber.segments) {
      const audienceId = SEGMENT_AUDIENCE_MAP[segment];
      const contactId = contactIds[segment];
      if (audienceId && contactId) {
        removeContactFromAudience(contactId, audienceId).catch(() => {});
      }
    }

    await prisma.newsletterSubscriber.delete({ where: { id } });

    revalidatePath("/subscribers");

    return { success: true, message: "Subscriber deleted" };
  } catch (error) {
    console.error("Delete subscriber error:", error);
    return { success: false, error: "Failed to delete subscriber" };
  }
}

/**
 * Search ALL app users for the Individual-Emails people-picker.
 *
 * Unlike the audience/segment send paths (which target newsletter
 * subscribers), the Individual-Emails picker can target ANY user
 * irrespective of whether they ever subscribed to a segment. We therefore
 * query the User table directly (not NewsletterSubscriber), excluding
 * soft-deleted users via `isActive`. Returns email + name for matching
 * users (limit 50), keeping the same `{ email, name }` shape the picker
 * already consumes so the dialog UI is unchanged.
 */
export async function searchUsersForIndividualSend(
  query: string,
): Promise<ActionResponse<{ email: string; name: string | null }[]>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    if (!query || query.trim().length < 2) {
      return { success: true, data: [] };
    }

    const trimmed = query.trim();

    // PROD (MongoDB Atlas): use the "user_search" Atlas Search index for
    // fuzzy/autocomplete relevance. Returns null on QA/dev (DigitalOcean
    // rejects $search) → fall through to the Prisma `contains` regex query.
    const atlas = await searchUsersAtlas(trimmed, 50);
    if (atlas) {
      return { success: true, data: atlas };
    }

    const users = await prisma.user.findMany({
      where: {
        // MONEY-1050: exclude ONLY explicit soft-deletes, matching the Atlas
        // path's `mustNot equals(isActive=false)` semantic. NOTE: unlike raw
        // Mongo `$ne:false`, Prisma's `not:false` does NOT match documents that
        // are physically missing the field (verified against prod) — so legacy
        // users predating `isActive` are made visible here by the one-time
        // backfill (scripts/ops/backfill-user-isactive.ts) that stamps the
        // `@default(true)` value onto those rows, not by this clause alone.
        isActive: { not: false },
        OR: [
          { email: { contains: trimmed, mode: "insensitive" } },
          { name: { contains: trimmed, mode: "insensitive" } },
        ],
      },
      select: { email: true, name: true },
      orderBy: { email: "asc" },
      take: 50,
    });

    return { success: true, data: users };
  } catch (error) {
    console.error("Search users for individual send error:", error);
    return { success: false, error: "Failed to search users" };
  }
}

/**
 * Get activity timeline for a subscriber
 */
export async function getSubscriberTimeline(
  id: string,
): Promise<ActionResponse<TimelineEvent[]>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { id },
    });

    if (!subscriber) {
      return { success: false, error: "Subscriber not found" };
    }

    const events: TimelineEvent[] = [];

    // Subscribed event
    if (subscriber.subscribedAt) {
      events.push({
        type: "subscribed",
        description: "Subscribed to newsletter",
        timestamp: subscriber.subscribedAt.toISOString(),
      });
    }

    // Unsubscribed event
    if (subscriber.unsubscribedAt) {
      events.push({
        type: "unsubscribed",
        description: "Unsubscribed from newsletter",
        timestamp: subscriber.unsubscribedAt.toISOString(),
      });
    }

    // Email log entries (last 50)
    const emailLogs = await prisma.emailLog.findMany({
      where: { to: subscriber.email },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    for (const log of emailLogs) {
      const typeMap: Record<string, TimelineEvent["type"]> = {
        SENT: "email_sent",
        FAILED: "email_failed",
        BOUNCED: "email_bounced",
      };
      events.push({
        type: typeMap[log.status] || "email_sent",
        description: `Email ${log.status.toLowerCase()}: "${log.subject}"`,
        timestamp: log.createdAt.toISOString(),
      });
    }

    // Sort by timestamp descending
    return { success: true, data: sortTimelineEvents(events) };
  } catch (error) {
    console.error("Get subscriber timeline error:", error);
    return { success: false, error: "Failed to get timeline" };
  }
}
