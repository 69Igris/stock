/**
 * Admin Config & Discounts API Route Tests
 *
 * Exercises the REAL exported units the config/discounts routes import and call:
 *   - Admin authorization: `isUserAdmin` + `parseAdminEmails`
 *     (apps/admin/lib/admin-auth-logic.ts, used by lib/auth.ts#verifyAdminUserId
 *      which all admin routes call).
 *   - Discount create validation + Dodo param building:
 *     `validateCreateDiscountInput` + `buildDodoCreateParams`
 *     (apps/admin/lib/actions/dodo-discounts-logic.ts, imported by the
 *      discounts route).
 *
 * No inline reimplementation.
 *
 * Sources:
 *   apps/admin/app/api/admin/config/route.ts
 *   apps/admin/app/api/admin/discounts/route.ts
 *   apps/admin/app/api/admin/discounts/[id]/route.ts
 *
 * Note: the previous inline copy also asserted trivial per-handler one-liners
 * (key-param checks, `{ data }` / `{ success: true }` response wrappers,
 * 401/403 status selection, Dodo-configured check). Those live inline in the
 * route handler bodies with no extracted source function to import, so they
 * were dropped rather than kept as shadows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isUserAdmin,
  parseAdminEmails,
  type AdminCheckUser,
} from "@/lib/admin-auth-logic";
import {
  validateCreateDiscountInput,
  buildDodoCreateParams,
} from "@/lib/actions/dodo-discounts-logic";

function createMockClerkUser(
  overrides: Partial<AdminCheckUser> = {},
): AdminCheckUser {
  return {
    emailAddresses: [{ id: "email-1", emailAddress: "deepshaswat@gmail.com" }],
    primaryEmailAddressId: "email-1",
    publicMetadata: { role: "admin" },
    ...overrides,
  };
}

describe("Admin Config & Discounts API Routes", () => {
  describe("isUserAdmin (route admin gate)", () => {
    it("should return true for user with admin role metadata", () => {
      const user = createMockClerkUser({ publicMetadata: { role: "admin" } });
      assert.strictEqual(isUserAdmin(user, []), true);
    });

    it("should return false for non-admin role", () => {
      const user = createMockClerkUser({ publicMetadata: { role: "user" } });
      assert.strictEqual(isUserAdmin(user, []), false);
    });

    it("should return true if email is in admin emails list", () => {
      const user = createMockClerkUser({
        publicMetadata: {},
        emailAddresses: [
          { id: "email-1", emailAddress: "deepshaswat@gmail.com" },
        ],
        primaryEmailAddressId: "email-1",
      });
      assert.strictEqual(isUserAdmin(user, ["deepshaswat@gmail.com"]), true);
    });

    it("should do case-insensitive email comparison", () => {
      const user = createMockClerkUser({
        publicMetadata: {},
        emailAddresses: [
          { id: "email-1", emailAddress: "DEEPSHASWAT@GMAIL.COM" },
        ],
        primaryEmailAddressId: "email-1",
      });
      assert.strictEqual(isUserAdmin(user, ["deepshaswat@gmail.com"]), true);
    });

    it("should return false when email not in admin list", () => {
      const user = createMockClerkUser({
        publicMetadata: {},
        emailAddresses: [{ id: "email-1", emailAddress: "user@test.com" }],
        primaryEmailAddressId: "email-1",
      });
      assert.strictEqual(isUserAdmin(user, ["deepshaswat@gmail.com"]), false);
    });

    it("should return false when no primary email found", () => {
      const user = createMockClerkUser({
        publicMetadata: {},
        emailAddresses: [
          { id: "email-2", emailAddress: "deepshaswat@gmail.com" },
        ],
        primaryEmailAddressId: "email-1", // mismatched ID
      });
      assert.strictEqual(isUserAdmin(user, ["deepshaswat@gmail.com"]), false);
    });

    it("should prioritize role check over email check", () => {
      const user = createMockClerkUser({
        publicMetadata: { role: "admin" },
        emailAddresses: [{ id: "email-1", emailAddress: "random@test.com" }],
        primaryEmailAddressId: "email-1",
      });
      assert.strictEqual(isUserAdmin(user, []), true);
    });
  });

  describe("parseAdminEmails", () => {
    it("should parse comma-separated emails", () => {
      const result = parseAdminEmails("a@b.com, c@d.com, e@f.com");
      assert.deepStrictEqual(result, ["a@b.com", "c@d.com", "e@f.com"]);
    });

    it("should handle empty string", () => {
      assert.deepStrictEqual(parseAdminEmails(""), []);
    });

    it("should handle undefined", () => {
      assert.deepStrictEqual(parseAdminEmails(undefined), []);
    });

    it("should trim whitespace", () => {
      const result = parseAdminEmails("  admin@test.com  ,  user@test.com  ");
      assert.deepStrictEqual(result, ["admin@test.com", "user@test.com"]);
    });

    it("should lowercase all emails", () => {
      const result = parseAdminEmails("Admin@Test.com,USER@FOO.com");
      assert.deepStrictEqual(result, ["admin@test.com", "user@foo.com"]);
    });

    it("should filter out empty entries from trailing comma", () => {
      assert.deepStrictEqual(parseAdminEmails("admin@test.com,"), [
        "admin@test.com",
      ]);
    });
  });

  describe("validateCreateDiscountInput (discount POST validation)", () => {
    it("should return null for valid amount", () => {
      assert.strictEqual(
        validateCreateDiscountInput({ amount: 1500, type: "percentage" }),
        null,
      );
    });

    it("should return error for zero amount", () => {
      assert.ok(
        validateCreateDiscountInput({ amount: 0 })?.includes("positive"),
      );
    });

    it("should return error for negative amount", () => {
      assert.ok(
        validateCreateDiscountInput({ amount: -10 })?.includes("positive"),
      );
    });

    it("should return error for missing amount", () => {
      assert.strictEqual(
        validateCreateDiscountInput({}),
        "amount must be a positive number",
      );
    });
  });

  describe("buildDodoCreateParams (discount POST param build)", () => {
    it("should default type to percentage and drop empty optionals", () => {
      const params = buildDodoCreateParams({ amount: 1000 });
      assert.strictEqual(params.amount, 1000);
      assert.strictEqual(params.type, "percentage");
      assert.strictEqual(params.code, undefined);
      assert.strictEqual(params.usage_limit, undefined);
      assert.strictEqual(params.restricted_to, undefined);
    });

    it("should pass through provided values and map to snake_case", () => {
      const params = buildDodoCreateParams({
        amount: 2000,
        type: "fixed",
        code: "SAVE20",
        expiresAt: "2030-01-01T00:00:00.000Z",
        usageLimit: 5,
        restrictedTo: ["prod_1"],
        name: "Launch",
      });
      assert.strictEqual(params.type, "fixed");
      assert.strictEqual(params.code, "SAVE20");
      assert.strictEqual(params.expires_at, "2030-01-01T00:00:00.000Z");
      assert.strictEqual(params.usage_limit, 5);
      assert.deepStrictEqual(params.restricted_to, ["prod_1"]);
      assert.strictEqual(params.name, "Launch");
    });

    it("should drop an empty restrictedTo array", () => {
      const params = buildDodoCreateParams({ amount: 500, restrictedTo: [] });
      assert.strictEqual(params.restricted_to, undefined);
    });
  });
});
