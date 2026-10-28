/**
 * Notification Helper Tests
 *
 * NOTE: This suite now exercises the REAL source
 * (workers/src/lib/notifications.ts), not an inline copy. It imports the
 * exported helpers (validateNotificationInput, VALID_NOTIFICATION_TYPES,
 * isValidNotificationType, castMetadata) and the createNotification entry
 * point, and asserts their behaviour directly. createNotification is tested
 * by stubbing prisma.notification.create (no real DB connection).
 *
 * Covers:
 * - Required field validation (userId, type, title, message)
 * - NotificationType enum membership + type guard
 * - Metadata casting (undefined preserved, objects passed through)
 * - createNotification data-shape construction
 * - Error handling: prisma failure logs but doesn't throw
 *
 * Source: workers/src/lib/notifications.ts
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@usemoney/database";

import {
  validateNotificationInput,
  VALID_NOTIFICATION_TYPES,
  isValidNotificationType,
  castMetadata,
  createNotification,
  type NotificationInput,
} from "../../src/lib/notifications";

describe("Notification Helper Logic", () => {
  describe("Required field validation", () => {
    it("should pass with all required fields present", () => {
      const result = validateNotificationInput({
        userId: "user_123",
        type: "SYNC_COMPLETE",
        title: "Sync Complete",
        message: "Your broker data has been synced.",
      });
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    it("should fail when userId is missing", () => {
      const result = validateNotificationInput({
        type: "SYNC_COMPLETE",
        title: "Sync Complete",
        message: "Your broker data has been synced.",
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("userId")));
    });

    it("should fail when userId is empty string", () => {
      const result = validateNotificationInput({
        userId: "",
        type: "SYNC_COMPLETE",
        title: "Title",
        message: "Message",
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("userId")));
    });

    it("should fail when userId is whitespace-only", () => {
      const result = validateNotificationInput({
        userId: "   ",
        type: "SYNC_COMPLETE",
        title: "Title",
        message: "Message",
      });
      assert.strictEqual(result.valid, false);
    });

    it("should fail when type is missing", () => {
      const result = validateNotificationInput({
        userId: "user_123",
        title: "Title",
        message: "Message",
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("type")));
    });

    it("should fail when title is missing", () => {
      const result = validateNotificationInput({
        userId: "user_123",
        type: "SYNC_COMPLETE",
        message: "Message",
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("title")));
    });

    it("should fail when title is empty string", () => {
      const result = validateNotificationInput({
        userId: "user_123",
        type: "SYNC_COMPLETE",
        title: "",
        message: "Message",
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("title")));
    });

    it("should fail when message is missing", () => {
      const result = validateNotificationInput({
        userId: "user_123",
        type: "SYNC_COMPLETE",
        title: "Title",
      });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes("message")));
    });

    it("should fail when message is empty string", () => {
      const result = validateNotificationInput({
        userId: "user_123",
        type: "SYNC_COMPLETE",
        title: "Title",
        message: "",
      });
      assert.strictEqual(result.valid, false);
    });

    it("should collect multiple errors when multiple fields are missing", () => {
      const result = validateNotificationInput({});
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.errors.length, 4);
    });
  });

  describe("NotificationType enum validation", () => {
    it("should accept RESEARCH_COMPLETE", () => {
      assert.strictEqual(isValidNotificationType("RESEARCH_COMPLETE"), true);
    });

    it("should accept SYNC_COMPLETE", () => {
      assert.strictEqual(isValidNotificationType("SYNC_COMPLETE"), true);
    });

    it("should accept IMPORT_COMPLETE", () => {
      assert.strictEqual(isValidNotificationType("IMPORT_COMPLETE"), true);
    });

    it("should accept PAIRING_COMPLETE", () => {
      assert.strictEqual(isValidNotificationType("PAIRING_COMPLETE"), true);
    });

    it("should accept SYSTEM", () => {
      assert.strictEqual(isValidNotificationType("SYSTEM"), true);
    });

    it("should have exactly 5 valid notification types", () => {
      assert.strictEqual(VALID_NOTIFICATION_TYPES.length, 5);
    });

    it("should reject unknown type", () => {
      assert.strictEqual(isValidNotificationType("UNKNOWN_TYPE"), false);
    });

    it("should reject empty string", () => {
      assert.strictEqual(isValidNotificationType(""), false);
    });

    it("should reject lowercase version", () => {
      assert.strictEqual(isValidNotificationType("sync_complete"), false);
    });
  });

  describe("Metadata handling (castMetadata)", () => {
    it("should return undefined when metadata is undefined", () => {
      const result = castMetadata(undefined);
      assert.strictEqual(result, undefined);
    });

    it("should return empty object when metadata is empty object", () => {
      const result = castMetadata({});
      assert.deepStrictEqual(result, {});
    });

    it("should pass through populated metadata", () => {
      const metadata = { broker: "ZERODHA", count: 42 };
      const result = castMetadata(metadata);
      assert.deepStrictEqual(result, { broker: "ZERODHA", count: 42 });
    });

    it("should handle metadata with nested objects", () => {
      const metadata = { details: { symbols: ["RELIANCE", "TCS"] } };
      const result = castMetadata(metadata);
      assert.deepStrictEqual(result, {
        details: { symbols: ["RELIANCE", "TCS"] },
      });
    });

    it("should handle metadata with null values", () => {
      const metadata = { key: null };
      const result = castMetadata(metadata);
      assert.deepStrictEqual(result, { key: null });
    });
  });

  // ── createNotification end-to-end ────────────────────────────────────
  // Stub prisma.notification.create with a plain data-property assignment
  // (the Prisma delegate is a runtime object whose `create` is a writable,
  // configurable value property — node:test's mock.method can't patch it,
  // so we save/restore it manually). No DB connection is opened.
  type NotificationCreate = typeof prisma.notification.create;

  describe("createNotification data construction", () => {
    let originalCreate: NotificationCreate;
    let createCalls: Array<{ data: NotificationInput }>;

    beforeEach(() => {
      originalCreate = prisma.notification.create;
      createCalls = [];
      // `as unknown as` below: Prisma's generated `create` is a generic whose
      // type parameter threads the `data` shape into the RETURN type, so no
      // plain stub signature sufficiently overlaps it (TS2352). Substituting a
      // double for a generic method is what the double assertion is for, and it
      // is the compiler's own suggested remedy. Surfaced when workers/__tests__
      // was first type-checked (MONEY-1326).
      prisma.notification.create = (async (args: { data: NotificationInput }) => {
        createCalls.push(args);
        return {} as never;
      }) as unknown as NotificationCreate;
    });

    afterEach(() => {
      prisma.notification.create = originalCreate;
    });

    it("should pass all fields through to prisma.notification.create", async () => {
      const input: NotificationInput = {
        userId: "user_abc",
        type: "IMPORT_COMPLETE",
        title: "Import Done",
        message: "Your CSV import has completed.",
        metadata: { rows: 100 },
      };
      await createNotification(input);

      assert.strictEqual(createCalls.length, 1);
      assert.deepStrictEqual(createCalls[0].data, {
        userId: "user_abc",
        type: "IMPORT_COMPLETE",
        title: "Import Done",
        message: "Your CSV import has completed.",
        metadata: { rows: 100 },
      });
    });

    it("should pass undefined metadata when not provided", async () => {
      const input: NotificationInput = {
        userId: "user_abc",
        type: "SYSTEM",
        title: "System Notice",
        message: "Maintenance window scheduled.",
      };
      await createNotification(input);

      const data = createCalls[0].data as { metadata: unknown };
      assert.strictEqual(data.metadata, undefined);
    });

    it("should preserve exact field values without transformation", async () => {
      const input: NotificationInput = {
        userId: "user_with_special-chars.123",
        type: "RESEARCH_COMPLETE",
        title: "Research: RELIANCE.NS",
        message: "AI analysis for RELIANCE is ready.",
        metadata: { symbol: "RELIANCE", exchange: "NSE" },
      };
      await createNotification(input);

      assert.strictEqual(
        createCalls[0].data.userId,
        "user_with_special-chars.123",
      );
      assert.strictEqual(createCalls[0].data.title, "Research: RELIANCE.NS");
      assert.deepStrictEqual(createCalls[0].data.metadata, {
        symbol: "RELIANCE",
        exchange: "NSE",
      });
    });
  });

  describe("createNotification error handling", () => {
    let originalCreate: NotificationCreate;

    beforeEach(() => {
      originalCreate = prisma.notification.create;
    });

    afterEach(() => {
      prisma.notification.create = originalCreate;
      mock.restoreAll();
    });

    it("should log error but not throw on prisma failure", async () => {
      prisma.notification.create = (async () => {
        throw new Error("DB connection lost");
      }) as NotificationCreate;
      const errorMock = mock.method(console, "error", () => {});

      await assert.doesNotReject(() =>
        createNotification({
          userId: "user_1",
          type: "SYSTEM",
          title: "Title",
          message: "Message",
        }),
      );

      assert.strictEqual(errorMock.mock.callCount(), 1);
      assert.strictEqual(
        errorMock.mock.calls[0].arguments[0],
        "[notifications] Failed to create notification:",
      );
    });

    it("should swallow non-Error rejections too", async () => {
      prisma.notification.create = (async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "string error";
      }) as NotificationCreate;
      mock.method(console, "error", () => {});

      await assert.doesNotReject(() =>
        createNotification({
          userId: "user_1",
          type: "SYSTEM",
          title: "Title",
          message: "Message",
        }),
      );
    });
  });
});
