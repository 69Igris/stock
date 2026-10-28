/**
 * API Response Helpers Tests
 *
 * Tests for the success(), error(), paginated(), and paginate() response
 * helper functions from @usemoney/api-utils and the Hono response wrapper.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  success,
  error,
  paginated,
  ErrorCodes,
} from "@usemoney/api-utils/response";

// Test the paginate wrapper from apps/api that calls paginated() internally
function paginate<T>(items: T[], total: number, page: number, limit: number) {
  return paginated(items, { total, page, limit });
}

describe("API Response Helpers", () => {
  // ───────────────────────────────── success() ─────────────────────────────────

  describe("success()", () => {
    it("should return correct format with data", () => {
      const result = success({ id: "1", name: "Test" });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, { id: "1", name: "Test" });
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(result.meta, undefined);
    });

    it("should include meta when provided", () => {
      const result = success([{ id: "1" }, { id: "2" }], {
        total: 100,
        page: 1,
        limit: 10,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data?.length, 2);
      assert.deepStrictEqual(result.meta, { total: 100, page: 1, limit: 10 });
    });

    it("should handle null data", () => {
      const result = success(null);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data, null);
    });

    it("should handle empty object data", () => {
      const result = success({});

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, {});
    });

    it("should handle empty array data", () => {
      const result = success([]);

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, []);
    });

    it("should handle string data", () => {
      const result = success("hello");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data, "hello");
    });

    it("should handle number data", () => {
      const result = success(42);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data, 42);
    });

    it("should handle boolean data", () => {
      const result = success(true);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data, true);
    });

    it("should not include meta when not provided", () => {
      const result = success({ key: "value" });

      assert.strictEqual("meta" in result, false);
    });

    it("should handle nested data structures", () => {
      const nested = {
        user: {
          id: "1",
          profile: { name: "Test", settings: { theme: "dark" } },
        },
        trades: [{ symbol: "RELIANCE", quantity: 10 }],
      };
      const result = success(nested);

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, nested);
    });
  });

  // ───────────────────────────────── error() ──────────────────────────────────

  describe("error()", () => {
    it("should return correct format with code and message", () => {
      const result = error("NOT_FOUND", "User not found");

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.data, undefined);
      assert.deepStrictEqual(result.error, {
        code: "NOT_FOUND",
        message: "User not found",
      });
    });

    it("should include details when provided", () => {
      const details = { field: "email", reason: "invalid format" };
      const result = error("VALIDATION_ERROR", "Invalid input", details);

      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(result.error, {
        code: "VALIDATION_ERROR",
        message: "Invalid input",
        details,
      });
    });

    it("should not include details when not provided", () => {
      const result = error("INTERNAL_ERROR", "Something went wrong");

      assert.strictEqual(result.error?.details, undefined);
      assert.strictEqual("details" in (result.error || {}), false);
    });

    it("should work with ErrorCodes constants", () => {
      const result = error(ErrorCodes.UNAUTHORIZED, "Not authenticated");

      assert.strictEqual(result.error?.code, "UNAUTHORIZED");
    });

    it("should work with RATE_LIMIT_EXCEEDED code", () => {
      const result = error(ErrorCodes.RATE_LIMIT_EXCEEDED, "Too many requests");

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error?.code, "RATE_LIMIT_EXCEEDED");
    });

    it("should handle details as an array", () => {
      const result = error("VALIDATION_ERROR", "Multiple errors", [
        "Field A is required",
        "Field B is invalid",
      ]);

      assert.ok(Array.isArray(result.error?.details));
      assert.strictEqual((result.error?.details as string[]).length, 2);
    });

    it("should handle empty string message", () => {
      const result = error("INTERNAL_ERROR", "");

      assert.strictEqual(result.error?.message, "");
    });
  });

  // ───────────────────────────────── paginated() ──────────────────────────────

  describe("paginated()", () => {
    it("should calculate pagination correctly for first page", () => {
      const items = [{ id: "1" }, { id: "2" }];
      const result = paginated(items, { total: 50, page: 1, limit: 10 });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, items);
      assert.strictEqual(result.meta?.total, 50);
      assert.strictEqual(result.meta?.page, 1);
      assert.strictEqual(result.meta?.limit, 10);
      assert.strictEqual(result.meta?.hasMore, true);
    });

    it("should set hasMore to false on last page", () => {
      const items = [{ id: "5" }];
      const result = paginated(items, { total: 5, page: 5, limit: 1 });

      assert.strictEqual(result.meta?.hasMore, false);
    });

    it("should set hasMore to false when exact fit", () => {
      const items = [{ id: "9" }, { id: "10" }];
      const result = paginated(items, { total: 10, page: 5, limit: 2 });

      // page * limit = 5 * 2 = 10, total = 10, so hasMore should be false
      assert.strictEqual(result.meta?.hasMore, false);
    });

    it("should set hasMore to true when more pages exist", () => {
      const items = [{ id: "1" }];
      const result = paginated(items, { total: 100, page: 1, limit: 10 });

      // page * limit = 1 * 10 = 10 < 100, so hasMore is true
      assert.strictEqual(result.meta?.hasMore, true);
    });

    it("should handle empty data array", () => {
      const result = paginated([], { total: 0, page: 1, limit: 10 });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, []);
      assert.strictEqual(result.meta?.total, 0);
      assert.strictEqual(result.meta?.hasMore, false);
    });

    it("should handle large page numbers beyond total", () => {
      const result = paginated([], { total: 10, page: 999, limit: 10 });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, []);
      // page * limit = 999 * 10 = 9990 >= 10, so hasMore = false
      assert.strictEqual(result.meta?.hasMore, false);
    });

    it("should handle limit of 1", () => {
      const items = [{ id: "1" }];
      const result = paginated(items, { total: 100, page: 1, limit: 1 });

      assert.strictEqual(result.meta?.limit, 1);
      assert.strictEqual(result.meta?.hasMore, true);
    });

    it("should handle total of 1 with page 1", () => {
      const items = [{ id: "1" }];
      const result = paginated(items, { total: 1, page: 1, limit: 10 });

      // page * limit = 10 >= 1, hasMore = false
      assert.strictEqual(result.meta?.hasMore, false);
    });

    it("should handle very large total", () => {
      const items = [{ id: "1" }];
      const result = paginated(items, { total: 1_000_000, page: 1, limit: 50 });

      assert.strictEqual(result.meta?.total, 1_000_000);
      assert.strictEqual(result.meta?.hasMore, true);
    });
  });

  // ────────────────────────────── paginate() wrapper ──────────────────────────

  describe("paginate() 4-argument wrapper", () => {
    it("should accept 4 separate arguments and return paginated response", () => {
      const items = [{ a: 1 }, { a: 2 }];
      const result = paginate(items, 20, 1, 10);

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.data, items);
      assert.strictEqual(result.meta?.total, 20);
      assert.strictEqual(result.meta?.page, 1);
      assert.strictEqual(result.meta?.limit, 10);
      assert.strictEqual(result.meta?.hasMore, true);
    });

    it("should calculate hasMore correctly through wrapper", () => {
      const result = paginate([], 10, 2, 5);

      // page * limit = 2 * 5 = 10 = total, so hasMore = false
      assert.strictEqual(result.meta?.hasMore, false);
    });

    it("should handle empty items with zero total", () => {
      const result = paginate([], 0, 1, 25);

      assert.deepStrictEqual(result.data, []);
      assert.strictEqual(result.meta?.total, 0);
      assert.strictEqual(result.meta?.hasMore, false);
    });
  });

  // ───────────────────────────────── ErrorCodes ───────────────────────────────

  describe("ErrorCodes", () => {
    it("should contain authentication error codes", () => {
      assert.strictEqual(ErrorCodes.UNAUTHORIZED, "UNAUTHORIZED");
      assert.strictEqual(ErrorCodes.FORBIDDEN, "FORBIDDEN");
      assert.strictEqual(ErrorCodes.INVALID_TOKEN, "INVALID_TOKEN");
      assert.strictEqual(ErrorCodes.TOKEN_EXPIRED, "TOKEN_EXPIRED");
    });

    it("should contain validation error codes", () => {
      assert.strictEqual(ErrorCodes.VALIDATION_ERROR, "VALIDATION_ERROR");
      assert.strictEqual(ErrorCodes.INVALID_INPUT, "INVALID_INPUT");
      assert.strictEqual(
        ErrorCodes.MISSING_REQUIRED_FIELD,
        "MISSING_REQUIRED_FIELD"
      );
    });

    it("should contain resource error codes", () => {
      assert.strictEqual(ErrorCodes.NOT_FOUND, "NOT_FOUND");
      assert.strictEqual(ErrorCodes.ALREADY_EXISTS, "ALREADY_EXISTS");
      assert.strictEqual(ErrorCodes.CONFLICT, "CONFLICT");
    });

    it("should contain rate limiting code", () => {
      assert.strictEqual(ErrorCodes.RATE_LIMIT_EXCEEDED, "RATE_LIMIT_EXCEEDED");
    });

    it("should contain server error codes", () => {
      assert.strictEqual(ErrorCodes.INTERNAL_ERROR, "INTERNAL_ERROR");
      assert.strictEqual(ErrorCodes.SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
      assert.strictEqual(ErrorCodes.DATABASE_ERROR, "DATABASE_ERROR");
    });

    it("should contain broker-specific error codes", () => {
      assert.strictEqual(
        ErrorCodes.BROKER_NOT_CONNECTED,
        "BROKER_NOT_CONNECTED"
      );
      assert.strictEqual(ErrorCodes.BROKER_AUTH_EXPIRED, "BROKER_AUTH_EXPIRED");
      assert.strictEqual(ErrorCodes.BROKER_SYNC_FAILED, "BROKER_SYNC_FAILED");
    });

    it("should contain subscription error codes", () => {
      assert.strictEqual(
        ErrorCodes.SUBSCRIPTION_REQUIRED,
        "SUBSCRIPTION_REQUIRED"
      );
      assert.strictEqual(
        ErrorCodes.SUBSCRIPTION_EXPIRED,
        "SUBSCRIPTION_EXPIRED"
      );
      assert.strictEqual(
        ErrorCodes.FEATURE_NOT_AVAILABLE,
        "FEATURE_NOT_AVAILABLE"
      );
    });
  });
});
