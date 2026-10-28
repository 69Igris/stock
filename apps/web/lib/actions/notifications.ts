"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import { isDemoSession } from "@/lib/demo/session";
import {
  demoNotifications,
  demoUnreadNotificationCount,
} from "@/lib/demo/data";
import type { ActionResponse } from "@usemoney/validation";
import {
  getNotifications as getNotificationsService,
  getUnreadCount as getUnreadCountService,
  markAsRead as markAsReadService,
  markAllAsRead as markAllAsReadService,
  clearAllRead as clearAllReadService,
} from "@usemoney/services";

// Re-export types for consumers
export type { NotificationItem } from "@usemoney/services";

/**
 * Get recent notifications
 *
 * MONEY-392 demo coverage: returns the static `demoNotifications` set when the
 * `sb_demo` cookie is present. Demo users don't have DB-backed notifications,
 * but we still want the bell icon + panel to render meaningful content.
 */
export async function getNotificationsAction(
  limit = 20,
  skip = 0
): Promise<ActionResponse<import("@usemoney/services").NotificationItem[]>> {
  if (await isDemoSession()) {
    const slice = demoNotifications.slice(skip, skip + limit);
    return {
      success: true,
      data: slice as unknown as import("@usemoney/services").NotificationItem[],
    };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  return getNotificationsService(user.userId, limit, skip);
}

/**
 * Get unread notification count (cached in service layer)
 */
export async function getUnreadCountAction(): Promise<ActionResponse<number>> {
  if (await isDemoSession()) {
    return { success: true, data: demoUnreadNotificationCount };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  return getUnreadCountService(user.userId);
}

/**
 * Mark a notification as read
 *
 * Demo no-op: demo notifications are static, mutations don't persist.
 */
export async function markAsReadAction(
  notificationId: string
): Promise<ActionResponse<void>> {
  if (await isDemoSession()) {
    return { success: true, data: undefined };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  return markAsReadService(user.userId, notificationId);
}

/**
 * Mark all notifications as read
 */
export async function markAllAsReadAction(): Promise<ActionResponse<void>> {
  if (await isDemoSession()) {
    return { success: true, data: undefined };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  return markAllAsReadService(user.userId);
}

/**
 * Clear all read notifications (permanently delete)
 */
export async function clearAllReadAction(): Promise<ActionResponse<number>> {
  if (await isDemoSession()) {
    return { success: true, data: 0 };
  }
  const user = await getAuthenticatedUser();
  if (!user) return { success: false, error: "Unauthorized" };

  return clearAllReadService(user.userId);
}
