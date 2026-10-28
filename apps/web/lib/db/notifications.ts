import prisma from "@/lib/prisma";
import type { NotificationType, Prisma } from "@prisma/client";
import { dbLogger as logger } from "@usemoney/logger";
import {
  type NotificationItem,
  NOTIFICATION_SELECT,
  buildUserNotificationsWhere,
  buildUnreadWhere,
  buildReadWhere,
  buildOwnedNotificationWhere,
  mapNotificationRow,
} from "./notifications-logic";

export type { NotificationItem };

/**
 * Get recent notifications for a user
 */
export async function getNotifications(
  userId: string,
  limit = 20
): Promise<NotificationItem[]> {
  try {
    const notifications = await prisma.notification.findMany({
      where: buildUserNotificationsWhere(userId),
      select: NOTIFICATION_SELECT,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return notifications.map(mapNotificationRow);
  } catch (error) {
    // Collection may not exist yet - return empty array, but log so a real
    // DB outage doesn't silently masquerade as "no notifications".
    logger.error({ error, userId }, "getNotifications failed");
    return [];
  }
}

/**
 * Get unread notification count
 */
export async function getUnreadCount(userId: string): Promise<number> {
  try {
    return await prisma.notification.count({
      where: buildUnreadWhere(userId),
    });
  } catch (error) {
    // Collection may not exist yet - return 0, but log so a real DB outage
    // doesn't silently masquerade as "0 unread".
    logger.error({ error, userId }, "getUnreadCount failed");
    return 0;
  }
}

/**
 * Mark a single notification as read
 */
export async function markAsRead(
  userId: string,
  notificationId: string
): Promise<void> {
  await prisma.notification.updateMany({
    where: buildOwnedNotificationWhere(userId, notificationId),
    data: { isRead: true },
  });
}

/**
 * Mark all notifications as read for a user
 */
export async function markAllAsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: buildUnreadWhere(userId),
    data: { isRead: true },
  });
}

/**
 * Clear all read notifications for a user
 */
export async function clearReadNotifications(userId: string): Promise<number> {
  const result = await prisma.notification.deleteMany({
    where: buildReadWhere(userId),
  });
  return result.count;
}

/**
 * Create a notification (used by server actions or workers)
 */
export async function createNotification(data: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: data.userId,
        type: data.type,
        title: data.title,
        message: data.message,
        metadata: (data.metadata ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
      },
    });
  } catch (error) {
    logger.error(
      { error, action: "createNotification" },
      "Failed to create notification"
    );
  }
}
