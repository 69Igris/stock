/**
 * Pure, server-only-free helpers for the subscribers actions
 * (`subscribers.ts`).
 *
 * Extracted out of the `"use server"` action module so the list `where`
 * builder, the editable-field length validation, and the timeline sort can be
 * unit-tested against the REAL exported symbols instead of inline copies.
 * `subscribers.ts` imports and calls these.
 *
 * @see apps/content/__tests__/actions/subscribers.test.ts
 */

export type SubscriberFilter = {
  status?: string;
  segment?: string;
  name?: string;
  email?: string;
  source?: string;
  createdAfter?: string;
  createdBefore?: string;
};

export type TimelineEvent = {
  type:
    | "subscribed"
    | "unsubscribed"
    | "email_sent"
    | "email_failed"
    | "email_bounced";
  description: string;
  timestamp: string;
};

/** Build the subscriber-list `where` from an optional filter. */
export function buildSubscriberWhere(
  filter?: SubscriberFilter,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (filter?.status) {
    where.status = filter.status;
  }
  if (filter?.segment) {
    where.segments = { hasSome: [filter.segment] };
  }
  if (filter?.name) {
    where.name = { contains: filter.name, mode: "insensitive" };
  }
  if (filter?.email) {
    where.email = { contains: filter.email, mode: "insensitive" };
  }
  if (filter?.source) {
    where.source = filter.source;
  }
  if (filter?.createdAfter || filter?.createdBefore) {
    const createdAt: Record<string, Date> = {};
    if (filter.createdAfter) createdAt.gt = new Date(filter.createdAfter);
    if (filter.createdBefore) createdAt.lt = new Date(filter.createdBefore);
    where.createdAt = createdAt;
  }
  return where;
}

/**
 * Validate editable subscriber fields: name ≤ 200, note ≤ 500, location ≤ 200
 * (name is checked first).
 */
export function validateUpdateSubscriber(data: {
  name?: string;
  note?: string;
  location?: string;
}): { valid: boolean; error?: string } {
  if (data.name && data.name.length > 200) {
    return { valid: false, error: "Name must be 200 characters or less" };
  }
  if (data.note && data.note.length > 500) {
    return { valid: false, error: "Note must be 500 characters or less" };
  }
  if (data.location && data.location.length > 200) {
    return { valid: false, error: "Location must be 200 characters or less" };
  }
  return { valid: true };
}

/** Sort timeline events newest-first (non-mutating). */
export function sortTimelineEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}
