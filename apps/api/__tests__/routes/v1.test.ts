/**
 * V1 Routes Tests - API Server
 *
 * Exercises the REAL v1 query helpers
 * (apps/api/src/routes/v1/pagination.ts) that `trades.ts`/`paired.ts` call, plus
 * the REAL response helpers (apps/api/src/lib/response.ts → @usemoney/api-utils)
 * and the REAL `V1_ENDPOINTS` catalogue (apps/api/src/routes/v1/index.ts). No
 * inline reimplementation.
 *
 * Covers query-param bounds (limit clamped to 1-100 → protects the DB from an
 * unbounded `?limit=999999`), the skip calculation, and the success/paginated/
 * error response shapes.
 *
 * Source: apps/api/src/routes/v1/pagination.ts
 *         apps/api/src/lib/response.ts
 *         apps/api/src/routes/v1/index.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parsePagination,
  parsePage,
  parseLimit,
  calculateSkip,
  MAX_SKIP,
} from "../../src/routes/v1/pagination";
import { success, paginated, error, paginate } from "../../src/lib/response";
import { V1_ENDPOINTS } from "../../src/routes/v1/index";

// ============================================================================
// Tests: Query Parameter Bounds Validation
// ============================================================================

describe("V1 Routes - Pagination Bounds Validation", () => {
  it("should default page to 1 when not provided", () => {
    assert.equal(parsePagination({}).page, 1);
  });

  it("should default limit to 50 when not provided", () => {
    assert.equal(parsePagination({}).limit, 50);
  });

  it("should clamp limit to minimum of 1", () => {
    assert.equal(parsePagination({ page: "1", limit: "0" }).limit, 1);
  });

  it("should clamp negative limit to 1", () => {
    assert.equal(parsePagination({ page: "1", limit: "-10" }).limit, 1);
  });

  it("should clamp limit to maximum of 100", () => {
    assert.equal(parsePagination({ page: "1", limit: "500" }).limit, 100);
  });

  it("should clamp a very large limit to 100 (DoS guard)", () => {
    assert.equal(parsePagination({ page: "1", limit: "999999" }).limit, 100);
  });

  it("should allow limit of exactly 1", () => {
    assert.equal(parsePagination({ page: "1", limit: "1" }).limit, 1);
  });

  it("should allow limit of exactly 100", () => {
    assert.equal(parsePagination({ page: "1", limit: "100" }).limit, 100);
  });

  it("should allow limit of 50 (within range)", () => {
    assert.equal(parsePagination({ page: "1", limit: "50" }).limit, 50);
  });

  it("should clamp page to minimum of 1", () => {
    assert.equal(parsePagination({ page: "0", limit: "10" }).page, 1);
  });

  it("should clamp negative page to 1", () => {
    assert.equal(parsePagination({ page: "-5", limit: "10" }).page, 1);
  });

  it("should default a non-numeric page to 1 (NaN-safe)", () => {
    // parseInt("abc") = NaN; parsePage now falls back to the default page (1)
    // instead of propagating NaN into skip = (page - 1) * limit = NaN, which
    // Prisma rejects ("Expected Int") → a 500 on every offset-paginated list
    // endpoint (credits/usage, feedback, quizzes, roast).
    assert.equal(parsePagination({ page: "abc", limit: "10" }).page, 1);
  });

  it("should use a custom default page", () => {
    assert.equal(parsePage(undefined, 5), 5);
  });

  it("should use a custom default and max for limit", () => {
    assert.equal(parseLimit(undefined, 20, 50), 20);
    assert.equal(parseLimit("75", 20, 50), 50);
  });

  it("should fall back to the default for a non-numeric limit (MONEY-1062: no NaN → empty page)", () => {
    assert.equal(parseLimit("abc", 20, 50), 20);
    assert.equal(parseLimit("", 20, 50), 20);
    assert.equal(parseLimit("NaN", 20, 50), 20);
    // still clamps a valid over-max value
    assert.equal(parseLimit("999", 20, 50), 50);
  });
});

// ============================================================================
// Tests: Pagination Skip Calculation
// ============================================================================

describe("V1 Routes - Skip Calculation", () => {
  it("should calculate skip as 0 for page 1", () => {
    assert.equal(parsePagination({ page: "1", limit: "50" }).skip, 0);
  });

  it("should calculate skip as limit for page 2", () => {
    assert.equal(parsePagination({ page: "2", limit: "50" }).skip, 50);
  });

  it("should calculate skip correctly for page 3 with limit 20", () => {
    assert.equal(parsePagination({ page: "3", limit: "20" }).skip, 40);
  });

  it("should calculate skip as 0 for page 0 (clamped to 1)", () => {
    assert.equal(parsePagination({ page: "0", limit: "25" }).skip, 0);
  });

  it("should handle large page numbers correctly", () => {
    assert.equal(parsePagination({ page: "100", limit: "10" }).skip, 990);
  });

  it("calculateSkip should be (page-1)*limit", () => {
    assert.equal(calculateSkip(3, 25), 50);
    assert.equal(calculateSkip(1, 100), 0);
  });

  // ── MAX_SKIP saturation (Prisma Int overflow guard) ──────────────────────
  // `?page=99999999999&limit=100` used to compute skip ≈ 1e13, past Prisma's
  // 32-bit Int → a 500 on every offset-paginated family. The skip is now
  // saturated at MAX_SKIP (1e6) — page/limit echoes stay untouched.
  it("pins the skip cap: a huge ?page saturates skip at MAX_SKIP", () => {
    assert.equal(MAX_SKIP, 1_000_000);
    const p = parsePagination({ page: "99999999999", limit: "100" });
    assert.equal(p.skip, MAX_SKIP);
    // page/limit semantics are unchanged — only the derived offset saturates.
    assert.equal(p.page, 99999999999);
    assert.equal(p.limit, 100);
  });

  it("calculateSkip saturates at MAX_SKIP and stays exact below it", () => {
    assert.equal(calculateSkip(99999999999, 100), MAX_SKIP);
    assert.equal(calculateSkip(Number.MAX_SAFE_INTEGER, 100), MAX_SKIP);
    // Largest exact value at the max limit: (page-1)*100 ≤ 1e6 → page 10001.
    assert.equal(calculateSkip(10_001, 100), MAX_SKIP);
    assert.equal(calculateSkip(10_000, 100), 999_900);
  });
});

// ============================================================================
// Tests: Response Format (real success/paginated/error/paginate)
// ============================================================================

describe("V1 Routes - Response Format", () => {
  it("should wrap data in success response", () => {
    const result = success({ name: "test" });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { name: "test" });
  });

  it("should include meta when provided", () => {
    const result = success({ items: [] }, { total: 100, page: 1, limit: 50 });
    assert.equal(result.meta?.total, 100);
    assert.equal(result.meta?.page, 1);
    assert.equal(result.meta?.limit, 50);
  });

  it("should not include meta when not provided", () => {
    assert.equal(success({ items: [] }).meta, undefined);
  });

  it("should build paginated response with hasMore true", () => {
    const result = paginated(["a", "b", "c"], {
      total: 100,
      page: 1,
      limit: 3,
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, ["a", "b", "c"]);
    assert.equal(result.meta?.hasMore, true);
  });

  it("should build paginated response with hasMore false on last page", () => {
    const result = paginated(["a", "b"], { total: 2, page: 1, limit: 10 });
    assert.equal(result.meta?.hasMore, false);
  });

  it("paginate (4-arg) should equal paginated", () => {
    const r1 = paginate([1, 2, 3], 50, 2, 10);
    const r2 = paginated([1, 2, 3], { total: 50, page: 2, limit: 10 });
    assert.deepEqual(r1, r2);
  });

  it("should build error response with code and message", () => {
    const result = error("NOT_FOUND", "Resource not found");
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "NOT_FOUND");
    assert.equal(result.error?.message, "Resource not found");
  });

  it("should include details in error response when provided", () => {
    const result = error("VALIDATION_ERROR", "Invalid input", {
      field: "email",
    });
    assert.deepEqual(result.error?.details, { field: "email" });
  });

  it("should not include details when not provided", () => {
    assert.equal(
      error("INTERNAL_ERROR", "Something went wrong").error?.details,
      undefined,
    );
  });
});

// ============================================================================
// Tests: V1 Route Catalogue (real V1_ENDPOINTS)
// ============================================================================

describe("V1 Routes - Info Endpoint", () => {
  it("should list the core v1 endpoints", () => {
    const paths = V1_ENDPOINTS.map((e) => e.path);
    assert.ok(paths.includes("/v1/dashboard"));
    assert.ok(paths.includes("/v1/holdings"));
    assert.ok(paths.includes("/v1/positions"));
    assert.ok(paths.includes("/v1/trades"));
    assert.ok(paths.includes("/v1/paired"));
  });

  it("should give every endpoint a description", () => {
    for (const ep of V1_ENDPOINTS) {
      assert.ok(ep.description.length > 0, `${ep.path} missing description`);
    }
  });

  it("should wrap the catalogue in a success response shape", () => {
    const result = success({ version: "v1", endpoints: V1_ENDPOINTS });
    assert.equal(result.success, true);
    assert.equal(result.data.version, "v1");
    assert.equal(result.data.endpoints.length, V1_ENDPOINTS.length);
  });
});
