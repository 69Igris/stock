/**
 * Notifications Routes
 *
 * Manage user notifications.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import {
  success,
  error,
  ErrorCodes,
  paginatedCursor,
  encodeCursor,
  decodeCursor,
} from "../../lib/response";
import {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  clearAllRead,
} from "@usemoney/services";
import { parseLimit } from "./pagination";

const notificationsRoutes = new Hono<AppContext>();

/**
 * GET /v1/notifications
 * List notifications with pagination
 */
notificationsRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const limit = parseLimit(c.req.query("limit"), 20);
  const cursor = decodeCursor<{ skip: number }>(c.req.query("cursor"));
  const skip =
    cursor && Number.isFinite(cursor.skip) && cursor.skip > 0 ? cursor.skip : 0;

  try {
    const result = await getNotifications(userId, limit, skip);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    // Offset-backed opaque cursor: the notifications service exposes limit+skip
    // (a DB-bounded read), not a keyset id, so the cursor encodes the next
    // offset. A full page implies there MAY be more. NOTE: offset (not keyset)
    // because the service has no id-cursor param — out of this task's ownership.
    const items = result.data;
    const nextCursor =
      items.length === limit ? encodeCursor({ skip: skip + limit }) : null;

    return c.json(paginatedCursor(items, nextCursor));
  } catch (err) {
    console.error("Notifications error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to fetch notifications"),
      500,
    );
  }
});

/**
 * GET /v1/notifications/unread-count
 * Unread-notification count for the caller (service caches it, 1-min TTL —
 * mirrors the web NotificationBell poll). getUnreadCount(userId) fails soft in
 * the service (missing collection → 0), so a failure here is a real 500.
 * Registered before the parameterized routes so "unread-count" can never be
 * captured as an :id.
 */
notificationsRoutes.get("/unread-count", async (c) => {
  const userId = c.get("userId");

  const result = await getUnreadCount(userId);
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }

  return c.json(success({ count: result.data }));
});

/**
 * PATCH /v1/notifications/:id/read
 * Mark a notification as read.
 *
 * MONEY-1178 — the failure mapping here was INVERTED, the same way fire.ts's
 * GET /:id once was. `markAsRead` is a scoped `updateMany`, which does not
 * throw when it matches nothing — so a missing or FOREIGN id takes the success
 * path, and the ONLY way to reach `success: false` is a real DB exception.
 * Reporting that as 404 tells the client the notification does not exist, so it
 * stops retrying something that would have worked, and the notification stays
 * unread forever. A service failure is a 500.
 *
 * A no-op (an id that matches nothing for this caller) stays 200 deliberately:
 * marking-as-read is idempotent, the requested end state holds either way, and
 * the service does not surface the matched count for the route to distinguish
 * them. Making that a 404 needs a service change and would start failing
 * clients that mark-read a notification the user cleared in another session —
 * MONEY-1179 records that decision rather than smuggling it in here.
 */
notificationsRoutes.patch("/:id/read", async (c) => {
  const userId = c.get("userId");
  const notificationId = c.req.param("id");

  try {
    const result = await markAsRead(userId, notificationId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success({ message: "Notification marked as read" }));
  } catch (err) {
    console.error("Mark notification read error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to mark notification as read"),
      500,
    );
  }
});

/**
 * POST /v1/notifications/read-all
 * Mark all notifications as read
 */
notificationsRoutes.post("/read-all", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await markAllAsRead(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success({ message: "All notifications marked as read" }));
  } catch (err) {
    console.error("Mark all notifications read error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to mark all as read"),
      500,
    );
  }
});

/**
 * DELETE /v1/notifications/read
 * Clear all read notifications
 */
notificationsRoutes.delete("/read", async (c) => {
  const userId = c.get("userId");

  try {
    const result = await clearAllRead(userId);
    if (!result.success) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }

    return c.json(success({ message: "Read notifications cleared" }));
  } catch (err) {
    console.error("Clear notifications error:", err);
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, "Failed to clear notifications"),
      500,
    );
  }
});

export default notificationsRoutes;
