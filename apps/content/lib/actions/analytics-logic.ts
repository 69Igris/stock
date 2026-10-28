/**
 * Pure, server-only-free helpers for the analytics actions (`analytics.ts`).
 *
 * Extracted out of the `"use server"` action module so the admin
 * authorization gate, subscriber-growth accumulation, limit clamping, date
 * serialisation, and overview assembly can be unit-tested against the REAL
 * exported symbols instead of inline copies. `analytics.ts` imports and calls
 * these.
 *
 * SECURITY: `requireAdminAuthor` is the authorization predicate for the whole
 * analytics surface — it MUST stay byte-for-byte identical to the gate the
 * action applies after fetching the author.
 *
 * @see apps/content/__tests__/actions/analytics.test.ts
 */

/**
 * Structural mirror of `@usemoney/email`'s `BroadcastSummary` so this pure
 * helper module stays free of server-only imports (the email package opens
 * client handles on load). Kept field-identical; the real type is assignable.
 */
export type BroadcastSummary = {
  id: string;
  name: string | null;
  audience_id: string | null;
  status: string;
  created_at: string;
};

export type AnalyticsOverview = {
  subscribers: {
    total: number;
    active: number;
    pending: number;
    unsubscribed: number;
  };
  posts: {
    total: number;
    published: number;
    totalViews: number;
  };
  broadcasts: BroadcastSummary[];
  subscriberGrowth: { date: string; count: number }[];
};

export type PostAnalytics = {
  id: string;
  title: string;
  postUrl: string;
  contentType: string;
  viewCount: number;
  publishDate: string | null;
  createdAt: string;
};

export type SubscriberActivity = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  source: string | null;
  segments: string[];
  subscribedAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
};

type ActionOk<T> = { success: true; data: T; message?: string };
type ActionErr = { success: false; error: string };

/**
 * Admin authorization gate: a fetched author passes only when present and not
 * a WRITER. Returns the author (caller treats `null` as Unauthorized).
 *
 * SECURITY-relevant — do not loosen.
 */
export function requireAdminAuthor<T extends { role: string }>(
  author: T | null,
): T | null {
  if (!author || author.role === "WRITER") return null;
  return author;
}

/**
 * Build subscriber growth data (cumulative count, grouped by day) from
 * subscribers ordered by `subscribedAt`.
 */
export function buildSubscriberGrowth(
  subscribers: { subscribedAt: Date | null }[],
): { date: string; count: number }[] {
  const growthMap = new Map<string, number>();
  let cumulative = 0;
  for (const sub of subscribers) {
    if (!sub.subscribedAt) continue;
    const day = sub.subscribedAt.toISOString().split("T")[0]!;
    cumulative++;
    growthMap.set(day, cumulative);
  }
  return Array.from(growthMap.entries()).map(([date, count]) => ({
    date,
    count,
  }));
}

/** Clamp a requested limit into the supported [1, 50] range. */
export function clampLimit(limit: number): number {
  return Math.min(Math.max(1, limit), 50);
}

/** Serialise a post's `Date` fields to ISO strings (publishDate nullable). */
export function serialisePostAnalytics(post: {
  id: string;
  title: string;
  postUrl: string;
  contentType: string;
  viewCount: number;
  publishDate: Date | null;
  createdAt: Date;
}): PostAnalytics {
  return {
    ...post,
    publishDate: post.publishDate?.toISOString() ?? null,
    createdAt: post.createdAt.toISOString(),
  };
}

/** Serialise a subscriber's `Date` fields to ISO strings (nullables kept). */
export function serialiseSubscriberActivity(subscriber: {
  id: string;
  email: string;
  name: string | null;
  status: string;
  source: string | null;
  segments: string[];
  subscribedAt: Date | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
}): SubscriberActivity {
  return {
    id: subscriber.id,
    email: subscriber.email,
    name: subscriber.name,
    status: subscriber.status,
    source: subscriber.source,
    segments: subscriber.segments,
    subscribedAt: subscriber.subscribedAt?.toISOString() ?? null,
    unsubscribedAt: subscriber.unsubscribedAt?.toISOString() ?? null,
    createdAt: subscriber.createdAt.toISOString(),
  };
}

/**
 * Assemble the analytics overview success response.
 * `totalViews` falls back to 0 when the views sum is null/0.
 */
export function buildOverviewResult(data: {
  totalSubs: number;
  activeSubs: number;
  pendingSubs: number;
  unsubSubs: number;
  totalPosts: number;
  publishedPosts: number;
  viewsSum: number | null;
  broadcasts: BroadcastSummary[];
  subscriberGrowth: { date: string; count: number }[];
}): ActionOk<AnalyticsOverview> | ActionErr {
  return {
    success: true,
    data: {
      subscribers: {
        total: data.totalSubs,
        active: data.activeSubs,
        pending: data.pendingSubs,
        unsubscribed: data.unsubSubs,
      },
      posts: {
        total: data.totalPosts,
        published: data.publishedPosts,
        totalViews: data.viewsSum || 0,
      },
      broadcasts: data.broadcasts,
      subscriberGrowth: data.subscriberGrowth,
    },
  };
}
