/**
 * Response Helpers Tests - API Server
 *
 * Exercises the REAL response helpers exported from
 * apps/api/src/lib/response.ts (which re-exports `success`/`paginated`/`error`/
 * `ErrorCodes` from @usemoney/api-utils and adds the Hono-specific `paginate`).
 * `jsonResponse` is invoked with a stub Hono `Context` so its status pass-through
 * is exercised against the real implementation. No inline reimplementation.
 *
 * (Moved here from apps/web/__tests__/api/response-helpers.test.ts — apps/web
 * cannot import apps/api source, so the test belonged in apps/api.)
 *
 * Source: apps/api/src/lib/response.ts
 *         packages/api-utils/src/response/index.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "hono";

import {
  success,
  paginated,
  error,
  paginate,
  jsonResponse,
  ErrorCodes,
  type ApiResponse,
} from "../../src/lib/response";

// ============================================================================
// Tests: success()
// ============================================================================

describe("Response Helpers - success()", () => {
  it("should create a basic success response", () => {
    const result = success({ message: "hello" });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { message: "hello" });
  });

  it("should not include meta when not provided", () => {
    assert.equal(success("data").meta, undefined);
  });

  it("should include meta when provided", () => {
    const meta = { total: 100, page: 1, limit: 10 };
    assert.deepEqual(success([1, 2, 3], meta).meta, meta);
  });

  it("should not include error field on success", () => {
    assert.equal(success({ id: 1 }).error, undefined);
  });

  it("should handle null data", () => {
    const result = success(null);
    assert.equal(result.success, true);
    assert.equal(result.data, null);
  });

  it("should handle array data", () => {
    assert.deepEqual(success([1, 2, 3]).data, [1, 2, 3]);
  });

  it("should handle nested object data", () => {
    const data = { user: { name: "Test", holdings: [{ symbol: "RELIANCE" }] } };
    assert.deepEqual(success(data).data, data);
  });

  it("should include hasMore in meta when provided", () => {
    const result = success([], {
      total: 50,
      page: 1,
      limit: 10,
      hasMore: true,
    });
    assert.equal(result.meta?.hasMore, true);
  });
});

// ============================================================================
// Tests: error()
// ============================================================================

describe("Response Helpers - error()", () => {
  it("should create a basic error response", () => {
    const result = error("NOT_FOUND", "Resource not found");
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "NOT_FOUND");
    assert.equal(result.error?.message, "Resource not found");
  });

  it("should not include data field on error", () => {
    assert.equal(error("UNAUTHORIZED", "No token").data, undefined);
  });

  it("should not include details when not provided", () => {
    assert.equal(
      error("INTERNAL_ERROR", "Something went wrong").error?.details,
      undefined,
    );
  });

  it("should include details when provided", () => {
    const details = { field: "email", reason: "invalid format" };
    assert.deepEqual(
      error("VALIDATION_ERROR", "Invalid input", details).error?.details,
      details,
    );
  });

  it("should handle details as a string", () => {
    assert.equal(
      error("INTERNAL_ERROR", "Error", "stack trace here").error?.details,
      "stack trace here",
    );
  });

  it("should handle details as an array", () => {
    assert.deepEqual(
      error("VALIDATION_ERROR", "Multiple errors", [
        "field1 required",
        "field2 invalid",
      ]).error?.details,
      ["field1 required", "field2 invalid"],
    );
  });

  it("should include details even when value is null (null !== undefined)", () => {
    assert.equal(error("INTERNAL_ERROR", "Error", null).error?.details, null);
  });
});

// ============================================================================
// Tests: paginated() / paginate()
// ============================================================================

describe("Response Helpers - paginated() / paginate()", () => {
  it("should create paginated response with correct meta", () => {
    const items = [{ id: 1 }, { id: 2 }];
    const result = paginate(items, 100, 1, 10);
    assert.equal(result.success, true);
    assert.deepEqual(result.data, items);
    assert.equal(result.meta?.total, 100);
    assert.equal(result.meta?.page, 1);
    assert.equal(result.meta?.limit, 10);
  });

  it("should compute hasMore when more pages exist", () => {
    assert.equal(paginate([], 100, 1, 10).meta?.hasMore, true);
  });

  it("should compute hasMore=false on the last page", () => {
    assert.equal(paginate([], 100, 10, 10).meta?.hasMore, false);
  });

  it("should compute hasMore=false when the page exceeds total", () => {
    assert.equal(paginate([], 5, 2, 10).meta?.hasMore, false);
  });

  it("should handle an empty items array", () => {
    const result = paginate([], 0, 1, 50);
    assert.deepEqual(result.data, []);
    assert.equal(result.meta?.total, 0);
    assert.equal(result.meta?.hasMore, false);
  });

  it("should produce the same result from paginate() and paginated()", () => {
    const items = [1, 2, 3];
    assert.deepEqual(
      paginate(items, 50, 2, 10),
      paginated(items, { total: 50, page: 2, limit: 10 }),
    );
  });

  it("should compute hasMore=true for page 0 (edge case)", () => {
    const result = paginate([], 10, 0, 10);
    assert.equal(result.meta?.page, 0);
    assert.equal(result.meta?.hasMore, true);
  });
});

// ============================================================================
// Tests: jsonResponse() (real Hono helper, stub Context)
// ============================================================================

/** Minimal stub of Hono's Context capturing the (body, status) of c.json. */
function makeStubContext(): {
  c: Context;
  calls: { body: unknown; status?: number }[];
} {
  const calls: { body: unknown; status?: number }[] = [];
  const c = {
    json(body: unknown, status?: number) {
      calls.push({ body, status });
      return { body, status } as unknown as Response;
    },
  } as unknown as Context;
  return { c, calls };
}

describe("Response Helpers - jsonResponse()", () => {
  it("should default to status 200", () => {
    const { c, calls } = makeStubContext();
    jsonResponse(c, success({ ok: true }));
    assert.equal(calls[0]!.status, 200);
  });

  for (const status of [201, 400, 401, 403, 404, 429, 500, 503] as const) {
    it(`should pass through status ${status}`, () => {
      const { c, calls } = makeStubContext();
      const body: ApiResponse<unknown> =
        status < 400 ? success({ ok: true }) : error("INTERNAL_ERROR", "err");
      jsonResponse(c, body, status);
      assert.equal(calls[0]!.status, status);
    });
  }

  it("should pass the response body through unchanged", () => {
    const { c, calls } = makeStubContext();
    const data = success({ id: 42, name: "Test" });
    jsonResponse(c, data, 200);
    assert.deepEqual(calls[0]!.body, data);
  });
});

// ============================================================================
// Tests: ErrorCodes (real constant)
// ============================================================================

describe("Response Helpers - ErrorCodes", () => {
  it("should have the auth/server/resource codes", () => {
    assert.equal(ErrorCodes.UNAUTHORIZED, "UNAUTHORIZED");
    assert.equal(ErrorCodes.INTERNAL_ERROR, "INTERNAL_ERROR");
    assert.equal(ErrorCodes.NOT_FOUND, "NOT_FOUND");
    assert.equal(ErrorCodes.RATE_LIMIT_EXCEEDED, "RATE_LIMIT_EXCEEDED");
  });

  it("should have the broker-specific codes", () => {
    assert.equal(ErrorCodes.BROKER_NOT_CONNECTED, "BROKER_NOT_CONNECTED");
    assert.equal(ErrorCodes.BROKER_AUTH_EXPIRED, "BROKER_AUTH_EXPIRED");
    assert.equal(ErrorCodes.BROKER_SYNC_FAILED, "BROKER_SYNC_FAILED");
  });

  it("should have the subscription-specific codes", () => {
    assert.equal(ErrorCodes.SUBSCRIPTION_REQUIRED, "SUBSCRIPTION_REQUIRED");
    assert.equal(ErrorCodes.SUBSCRIPTION_EXPIRED, "SUBSCRIPTION_EXPIRED");
    assert.equal(ErrorCodes.FEATURE_NOT_AVAILABLE, "FEATURE_NOT_AVAILABLE");
  });

  it("should have the validation codes", () => {
    assert.equal(ErrorCodes.BAD_REQUEST, "BAD_REQUEST");
    assert.equal(ErrorCodes.VALIDATION_ERROR, "VALIDATION_ERROR");
    assert.equal(ErrorCodes.INVALID_INPUT, "INVALID_INPUT");
    assert.equal(ErrorCodes.MISSING_REQUIRED_FIELD, "MISSING_REQUIRED_FIELD");
  });

  it("should expose exactly 22 error codes", () => {
    // 21 original + BAD_REQUEST (MONEY-736, added for safeJson/zodParse 400s).
    assert.equal(Object.keys(ErrorCodes).length, 22);
  });
});
