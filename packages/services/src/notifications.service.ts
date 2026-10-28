/**
 * Notifications Service
 *
 * Handles notification queries, read/unread management, and clearing.
 * Source: apps/web/lib/actions/notifications.ts + apps/web/lib/db/notifications.ts
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  clampPagination,
  DEFAULT_NOTIFICATION_LIMIT,
} from "./notifications-pagination";

// ── Types ──────────────────────────────────────────────────────────

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: Date;
}

// ── Constants ──────────────────────────────────────────────────────

const NOTIFICATION_SELECT = {
  id: true,
  type: true,
  title: true,
  message: true,
  metadata: true,
  isRead: true,
  createdAt: true,
} as const;

/**
 * In-memory cache for unread notification count.
 * Since NotificationBell polls every 2 minutes, this avoids redundant DB queries
 * when count hasn't changed. Invalidated on mark-as-read actions.
 */
const unreadCountCache = new Map<
  string,
  { count: number; expiresAt: number }
>();
const UNREAD_COUNT_CACHE_TTL_MS = 60 * 1000; // 1 minute

function invalidateUnreadCountCache(userId: string): void {
  unreadCountCache.delete(userId);
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * Get recent notifications for a user
 */
export async function getNotifications(
  userId: string,
  limit: number = DEFAULT_NOTIFICATION_LIMIT,
  skip = 0,
): Promise<ServiceResult<NotificationItem[]>> {
  // Clamp possibly-untrusted pagination (web action / api ?limit= query) into
  // safe Prisma bounds. Without this, a NaN/negative/huge take|skip reaches
  // findMany and Prisma throws — see notifications-pagination.ts.
  const { take, skip: safeSkip } = clampPagination(limit, skip);
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId },
      select: NOTIFICATION_SELECT,
      orderBy: { createdAt: "desc" },
      take,
      skip: safeSkip,
    });

    const data = notifications.map((n) => ({
      ...n,
      type: n.type as string,
      metadata: n.metadata as Record<string, unknown> | null,
    }));

    return { success: true, data };
  } catch (error) {
    // Collection may not exist yet - return empty array, but log so a real
    // DB outage doesn't silently masquerade as "no notifications".
    logger.error({ error, userId }, "getNotifications failed");
    return { success: true, data: [] };
  }
}

/**
 * Get unread notification count (with in-memory cache, 1 min TTL)
 */
export async function getUnreadCount(
  userId: string,
): Promise<ServiceResult<number>> {
  try {
    // Check in-memory cache first
    const cached = unreadCountCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return { success: true, data: cached.count };
    }

    const count = await prisma.notification.count({
      where: { userId, isRead: false },
    });

    // Cache the result
    unreadCountCache.set(userId, {
      count,
      expiresAt: Date.now() + UNREAD_COUNT_CACHE_TTL_MS,
    });

    return { success: true, data: count };
  } catch (error) {
    // Collection may not exist yet - return 0, but log so a real DB outage
    // doesn't silently masquerade as "0 unread".
    logger.error({ error, userId }, "getUnreadCount failed");
    return { success: true, data: 0 };
  }
}

/**
 * Mark a single notification as read
 */
export async function markAsRead(
  userId: string,
  notificationId: string,
): Promise<ServiceResult<void>> {
  try {
    await prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true },
    });

    invalidateUnreadCountCache(userId);

    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, userId, notificationId },
      "Mark as read service error",
    );
    return { success: false, error: "Failed to update notification" };
  }
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllAsRead(
  userId: string,
): Promise<ServiceResult<void>> {
  try {
    await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });

    invalidateUnreadCountCache(userId);

    return { success: true, data: undefined };
  } catch (error) {
    logger.error({ error, userId }, "Mark all as read service error");
    return { success: false, error: "Failed to update notifications" };
  }
}

/**
 * Clear all read notifications (permanently delete)
 */
export async function clearAllRead(
  userId: string,
): Promise<ServiceResult<number>> {
  try {
    const result = await prisma.notification.deleteMany({
      where: { userId, isRead: true },
    });

    return { success: true, data: result.count };
  } catch (error) {
    logger.error({ error, userId }, "Clear read notifications service error");
    return { success: false, error: "Failed to clear notifications" };
  }
}
