/**
 * Notifications DB layer — REAL logic test.
 *
 * Exercises the ACTUAL exported symbols from `@/lib/db/notifications-logic`
 * (the pure module `lib/db/notifications.ts` now imports) — NOT inline copies:
 *   - NOTIFICATION_SELECT (read projection; excludes userId)
 *   - buildUserNotificationsWhere / buildUnreadWhere / buildReadWhere /
 *     buildOwnedNotificationWhere (userId-scoped where-clauses)
 *   - mapNotificationRow (Prisma JSON metadata → Record|null narrowing)
 *
 * (Replaces the previous SHADOW version, which reimplemented the entire layer
 * inside a `createMockDb()` and asserted the copy. That mock even accepted
 * notification "types" — SYNC_FAILED, SUBSCRIPTION_CHANGE, BROKER_EXPIRED,
 * ACHIEVEMENT — that DO NOT exist in the real `NotificationType` enum, so it
 * was green while pinning a fictional contract. The where-clauses + projection
 * + mapper were INLINE in notifications.ts; it now imports & calls these, so
 * this asserts the same code production runs.)
 *
 * Source: apps/web/lib/db/notifications-logic.ts
 *         (imported by apps/web/lib/db/notifications.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NotificationType } from "@prisma/client";
import {
  NOTIFICATION_SELECT,
  buildUserNotificationsWhere,
  buildUnreadWhere,
  buildReadWhere,
  buildOwnedNotificationWhere,
  mapNotificationRow,
  type RawNotificationRow,
} from "@/lib/db/notifications-logic";

function rawRow(
  overrides: Partial<RawNotificationRow> = {}
): RawNotificationRow {
  return {
    id: overrides.id ?? "n1",
    type: overrides.type ?? ("SYNC_COMPLETE" as NotificationType),
    title: overrides.title ?? "Sync Complete",
    message: overrides.message ?? "Your ZERODHA data has been synced",
    metadata: "metadata" in overrides ? overrides.metadata : null,
    isRead: overrides.isRead ?? false,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

describe("Notifications DB logic — REAL exports", () => {
  // ───────────────────────── PROJECTION ─────────────────────────
  describe("NOTIFICATION_SELECT", () => {
    it("selects exactly the 7 client-facing fields", () => {
      assert.deepEqual(Object.keys(NOTIFICATION_SELECT).sort(), [
        "createdAt",
        "id",
        "isRead",
        "message",
        "metadata",
        "title",
        "type",
      ]);
    });

    it("each selected field is true", () => {
      for (const v of Object.values(NOTIFICATION_SELECT)) {
        assert.equal(v, true);
      }
    });

    it("does NOT select userId (never leaks to the client)", () => {
      assert.ok(!("userId" in NOTIFICATION_SELECT));
    });

    it("is frozen (callers can't mutate the shared select)", () => {
      assert.ok(Object.isFrozen(NOTIFICATION_SELECT));
    });
  });

  // ─────────────────────── WHERE BUILDERS ───────────────────────
  describe("buildUserNotificationsWhere", () => {
    it("scopes to the userId only", () => {
      assert.deepEqual(buildUserNotificationsWhere("user-1"), {
        userId: "user-1",
      });
    });

    it("does not add an isRead filter (returns read + unread)", () => {
      assert.ok(!("isRead" in buildUserNotificationsWhere("user-1")));
    });

    it("preserves an empty / unicode userId verbatim (no coercion)", () => {
      assert.deepEqual(buildUserNotificationsWhere(""), { userId: "" });
      assert.deepEqual(buildUserNotificationsWhere("用户-✓"), {
        userId: "用户-✓",
      });
    });
  });

  describe("buildUnreadWhere", () => {
    it("scopes to userId + isRead:false", () => {
      assert.deepEqual(buildUnreadWhere("user-1"), {
        userId: "user-1",
        isRead: false,
      });
    });
  });

  describe("buildReadWhere", () => {
    it("scopes to userId + isRead:true", () => {
      assert.deepEqual(buildReadWhere("user-1"), {
        userId: "user-1",
        isRead: true,
      });
    });
  });

  describe("buildOwnedNotificationWhere", () => {
    it("scopes to BOTH id and userId (defense-in-depth on writes)", () => {
      assert.deepEqual(buildOwnedNotificationWhere("user-1", "n9"), {
        id: "n9",
        userId: "user-1",
      });
    });

    it("a foreign userId still appears in the clause (so updateMany matches 0)", () => {
      const where = buildOwnedNotificationWhere("attacker", "victims-notif");
      assert.equal(where.userId, "attacker");
      assert.equal(where.id, "victims-notif");
    });
  });

  // ───────────────────────── ROW MAPPER ─────────────────────────
  describe("mapNotificationRow", () => {
    it("maps all fields straight through", () => {
      const created = new Date("2026-03-01T10:00:00Z");
      const out = mapNotificationRow(
        rawRow({
          id: "abc",
          type: "ROAST_COMPLETE" as NotificationType,
          title: "Roast ready",
          message: "Your portfolio roast is ready",
          metadata: { score: 42 },
          isRead: true,
          createdAt: created,
        })
      );
      assert.deepEqual(out, {
        id: "abc",
        type: "ROAST_COMPLETE",
        title: "Roast ready",
        message: "Your portfolio roast is ready",
        metadata: { score: 42 },
        isRead: true,
        createdAt: created,
      });
    });

    it("null metadata stays null", () => {
      assert.equal(
        mapNotificationRow(rawRow({ metadata: null })).metadata,
        null
      );
    });

    it("undefined metadata normalizes to null (never undefined)", () => {
      const out = mapNotificationRow(rawRow({ metadata: undefined }));
      assert.equal(out.metadata, null);
    });

    it("preserves a complex nested metadata object", () => {
      const meta = {
        broker: "ZERODHA",
        stats: { holdings: 5, synced: true },
        tags: ["important"],
      };
      assert.deepEqual(
        mapNotificationRow(rawRow({ metadata: meta })).metadata,
        meta
      );
    });

    it("preserves unicode in title/message", () => {
      const out = mapNotificationRow(
        rawRow({ title: "सिंक पूर्ण ✓", message: "₹1,23,456 synced" })
      );
      assert.equal(out.title, "सिंक पूर्ण ✓");
      assert.equal(out.message, "₹1,23,456 synced");
    });

    it("does not surface a userId even if the raw row carries one", () => {
      // Prisma's projection excludes userId, but assert the mapper's output
      // shape regardless of an over-broad raw row.
      const dirty = {
        ...rawRow(),
        userId: "should-not-leak",
      } as RawNotificationRow & { userId: string };
      const out = mapNotificationRow(dirty);
      assert.ok(!("userId" in out));
    });

    it("an array metadata value is preserved as-is (still object-typed)", () => {
      const out = mapNotificationRow(rawRow({ metadata: [1, 2, 3] }));
      assert.deepEqual(out.metadata, [1, 2, 3]);
    });
  });
});
