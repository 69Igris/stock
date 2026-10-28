"use server";

import { auth } from "@clerk/nextjs/server";
import { prisma } from "@usemoney/database";
import type { ActionResponse } from "@usemoney/validation";
import {
  listBroadcasts,
  getBroadcastAnalytics,
  type BroadcastAnalytics,
} from "@usemoney/email";
import {
  requireAdminAuthor,
  buildSubscriberGrowth,
  buildOverviewResult,
  clampLimit,
  serialisePostAnalytics,
  serialiseSubscriberActivity,
  type AnalyticsOverview,
  type PostAnalytics,
  type SubscriberActivity,
} from "./analytics-logic";

export type {
  AnalyticsOverview,
  PostAnalytics,
  SubscriberActivity,
} from "./analytics-logic";

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

  return requireAdminAuthor(author);
}

/**
 * Get platform-level analytics overview.
 * Combines subscriber stats, post stats, broadcast list, and growth data.
 */
export async function getAnalyticsOverview(): Promise<
  ActionResponse<AnalyticsOverview>
> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    // Fetch all stats in parallel
    const [
      totalSubs,
      activeSubs,
      pendingSubs,
      unsubSubs,
      totalPosts,
      publishedPosts,
      viewsAgg,
      broadcasts,
      recentSubscribers,
    ] = await Promise.all([
      prisma.newsletterSubscriber.count(),
      prisma.newsletterSubscriber.count({ where: { status: "ACTIVE" } }),
      prisma.newsletterSubscriber.count({ where: { status: "PENDING" } }),
      prisma.newsletterSubscriber.count({ where: { status: "UNSUBSCRIBED" } }),
      prisma.post.count({ where: { status: { not: "DELETED" } } }),
      prisma.post.count({ where: { status: "PUBLISHED" } }),
      prisma.post.aggregate({
        where: { status: { not: "DELETED" } },
        _sum: { viewCount: true },
      }),
      listBroadcasts(),
      // For subscriber growth: get subscribers ordered by subscribedAt
      prisma.newsletterSubscriber.findMany({
        where: { subscribedAt: { not: null } },
        select: { subscribedAt: true },
        orderBy: { subscribedAt: "asc" },
      }),
    ]);

    // Build subscriber growth data (group by day)
    const subscriberGrowth = buildSubscriberGrowth(recentSubscribers);

    return buildOverviewResult({
      totalSubs,
      activeSubs,
      pendingSubs,
      unsubSubs,
      totalPosts,
      publishedPosts,
      viewsSum: viewsAgg._sum.viewCount ?? null,
      broadcasts,
      subscriberGrowth,
    });
  } catch (error) {
    console.error("Get analytics overview error:", error);
    return { success: false, error: "Failed to get analytics overview" };
  }
}

/**
 * Get analytics for a specific post.
 */
export async function getPostAnalytics(
  postId: string,
): Promise<ActionResponse<PostAnalytics>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        id: true,
        title: true,
        postUrl: true,
        contentType: true,
        viewCount: true,
        publishDate: true,
        createdAt: true,
      },
    });

    if (!post) {
      return { success: false, error: "Post not found" };
    }

    return {
      success: true,
      data: serialisePostAnalytics(post),
    };
  } catch (error) {
    console.error("Get post analytics error:", error);
    return { success: false, error: "Failed to get post analytics" };
  }
}

/**
 * Get top posts by view count.
 */
export async function getTopPostsByViews(
  limit: number = 10,
): Promise<ActionResponse<PostAnalytics[]>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const safeLimit = clampLimit(limit);

    const posts = await prisma.post.findMany({
      where: { status: "PUBLISHED" },
      select: {
        id: true,
        title: true,
        postUrl: true,
        contentType: true,
        viewCount: true,
        publishDate: true,
        createdAt: true,
      },
      orderBy: { viewCount: "desc" },
      take: safeLimit,
    });

    return {
      success: true,
      data: posts.map(serialisePostAnalytics),
    };
  } catch (error) {
    console.error("Get top posts by views error:", error);
    return { success: false, error: "Failed to get top posts" };
  }
}

/**
 * Get subscriber activity/details by ID.
 */
export async function getSubscriberActivity(
  subscriberId: string,
): Promise<ActionResponse<SubscriberActivity>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { id: subscriberId },
    });

    if (!subscriber) {
      return { success: false, error: "Subscriber not found" };
    }

    return {
      success: true,
      data: serialiseSubscriberActivity(subscriber),
    };
  } catch (error) {
    console.error("Get subscriber activity error:", error);
    return { success: false, error: "Failed to get subscriber activity" };
  }
}

/**
 * Get broadcast details by ID (wrapper around email package).
 */
export async function getBroadcastDetails(
  broadcastId: string,
): Promise<ActionResponse<BroadcastAnalytics>> {
  try {
    const author = await requireAdmin();
    if (!author) {
      return { success: false, error: "Unauthorized" };
    }

    const broadcast = await getBroadcastAnalytics(broadcastId);
    if (!broadcast) {
      return { success: false, error: "Broadcast not found" };
    }

    return { success: true, data: broadcast };
  } catch (error) {
    console.error("Get broadcast details error:", error);
    return { success: false, error: "Failed to get broadcast details" };
  }
}
