/**
 * Admin product-sync route CONTRACT test.
 *
 * Exercises the REAL exported symbols the POST /api/admin/sync-products handler
 * calls (from `@/app/api/admin/sync-products/route-logic`):
 *   - `isClerkUserAdmin` — case-sensitive `publicMetadata.role === "admin"`.
 *   - `checkAdminAccess` — the unauthenticated(401) → non-admin(403) → allowed
 *     gate ordering.
 *   - `formatAdminSyncResponse` — the success payload shape.
 *
 * (Replaces the previous shadow version, which reimplemented `isAuthenticated`
 * / `isAdmin` / `checkAdminAccess` / `formatAdminSyncResponse` inline and
 * asserted the copies.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isClerkUserAdmin,
  checkAdminAccess,
  formatAdminSyncResponse,
  type AdminMetadata,
} from "@/app/api/admin/sync-products/route-logic";

describe("Admin product-sync route", () => {
  describe("isClerkUserAdmin", () => {
    it("identifies an admin user", () => {
      assert.strictEqual(isClerkUserAdmin({ role: "admin" }), true);
    });

    it("rejects a non-admin role", () => {
      assert.strictEqual(isClerkUserAdmin({ role: "user" }), false);
    });

    it("rejects a user with no role", () => {
      assert.strictEqual(isClerkUserAdmin({}), false);
    });

    it("rejects undefined metadata", () => {
      assert.strictEqual(isClerkUserAdmin(undefined), false);
    });

    it("rejects null metadata", () => {
      assert.strictEqual(isClerkUserAdmin(null), false);
    });

    it("is case-sensitive (Admin)", () => {
      assert.strictEqual(isClerkUserAdmin({ role: "Admin" }), false);
    });

    it("is case-sensitive (ADMIN)", () => {
      assert.strictEqual(isClerkUserAdmin({ role: "ADMIN" }), false);
    });
  });

  describe("checkAdminAccess", () => {
    const adminMeta: AdminMetadata = { role: "admin" };

    it("allows an authenticated admin user", () => {
      const result = checkAdminAccess("user_123", adminMeta);
      assert.strictEqual(result.allowed, true);
    });

    it("rejects an unauthenticated request (null userId) with 401", () => {
      const result = checkAdminAccess(null, adminMeta);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(
        result.allowed === false && result.error,
        "Unauthorized"
      );
      assert.strictEqual(result.allowed === false && result.status, 401);
    });

    it("rejects an empty userId with 401", () => {
      const result = checkAdminAccess("", adminMeta);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.allowed === false && result.status, 401);
    });

    it("rejects an authenticated non-admin user with 403 Forbidden", () => {
      const result = checkAdminAccess("user_123", { role: "user" });
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.allowed === false && result.error, "Forbidden");
      assert.strictEqual(result.allowed === false && result.status, 403);
    });

    it("rejects an authenticated user with an empty role with 403", () => {
      const result = checkAdminAccess("user_123", { role: "" });
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.allowed === false && result.status, 403);
    });

    it("checks auth before admin role (null userId → 401, not 403)", () => {
      const result = checkAdminAccess(null, { role: "user" });
      assert.strictEqual(result.allowed === false && result.status, 401);
    });
  });

  describe("formatAdminSyncResponse", () => {
    it("formats a success response", () => {
      const result = formatAdminSyncResponse(10, []);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.synced, 10);
      assert.deepStrictEqual(result.errors, []);
      assert.strictEqual(typeof result.timestamp, "string");
    });

    it("includes errors in the response", () => {
      const result = formatAdminSyncResponse(8, [
        "Product A: not found",
        "Product B: price mismatch",
      ]);
      assert.strictEqual(result.synced, 8);
      assert.strictEqual(result.errors.length, 2);
    });

    it("emits an ISO-8601 timestamp string", () => {
      const result = formatAdminSyncResponse(0, []);
      assert.ok(!Number.isNaN(Date.parse(result.timestamp)));
    });
  });
});
