/**
 * Notifications DB layer — pure logic (no Prisma / no server-only deps).
 *
 * Extracted from `lib/db/notifications.ts` so the projection shape, the
 * three scoped where-clauses, and the row → NotificationItem mapper can be
 * unit-tested against the REAL exported symbols instead of inline copies.
 *
 * `notifications.ts` imports these and is the only caller; this module imports
 * nothing server-only, so the tests stay pure and exit cleanly.
 *
 * @see apps/web/__tests__/db/notifications.test.ts
 */

import type { NotificationType } from "@prisma/client";

export interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: Date;
}

/**
 * Field projection for notification reads. Excludes `userId` so it never
 * reaches the client response. Frozen so a caller can't mutate the shared
 * select object.
 */
export const NOTIFICATION_SELECT = Object.freeze({
  id: true,
  type: true,
  title: true,
  message: true,
  metadata: true,
  isRead: true,
  createdAt: true,
} as const);

// ── Where-clause builders (all userId-scoped) ──

/** All notifications for a user. */
export function buildUserNotificationsWhere(userId: string): {
  userId: string;
} {
  return { userId };
}

/** A user's UNREAD notifications (used for count + mark-all-read scope). */
export function buildUnreadWhere(userId: string): {
  userId: string;
  isRead: false;
} {
  return { userId, isRead: false };
}

/** A user's READ notifications (used for clear-read scope). */
export function buildReadWhere(userId: string): {
  userId: string;
  isRead: true;
} {
  return { userId, isRead: true };
}

/** A single notification scoped to its owner (defense-in-depth on writes). */
export function buildOwnedNotificationWhere(
  userId: string,
  notificationId: string
): { id: string; userId: string } {
  return { id: notificationId, userId };
}

// ── Row mapper ──

/** The raw projected row shape Prisma returns (metadata is untyped JSON). */
export interface RawNotificationRow {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata: unknown;
  isRead: boolean;
  createdAt: Date;
}

/**
 * Map a projected Prisma notification row → NotificationItem, narrowing the
 * untyped JSON `metadata` to `Record<string, unknown> | null`. A nullish
 * metadata normalizes to `null` (never `undefined`).
 */
export function mapNotificationRow(row: RawNotificationRow): NotificationItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    isRead: row.isRead,
    createdAt: row.createdAt,
  };
}
