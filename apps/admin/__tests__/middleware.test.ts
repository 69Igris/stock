/**
 * Admin Proxy (Middleware) Authorization Tests
 *
 * Exercises the REAL admin-authorization helpers from
 * apps/admin/lib/admin-auth-logic.ts — `parseAdminEmails` and `isUserAdmin` —
 * which proxy.ts (and every admin API route via lib/auth.ts) imports and calls.
 * No inline copy.
 *
 * Source: apps/admin/proxy.ts, apps/admin/lib/admin-auth-logic.ts
 *
 * Note: the previous inline copy also asserted `isPublicRoute` /
 * `matchesMiddlewareMatcher` against reimplemented regexes. Those mirror
 * Clerk's `createRouteMatcher` and the Next.js `config.matcher` array — third-
 * party behavior with no first-party source function to import — so they were
 * removed rather than left as a shadow of library internals.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAdminEmails,
  isUserAdmin,
  type AdminCheckUser,
} from "@/lib/admin-auth-logic";

function createMockUser(
  overrides: Partial<AdminCheckUser> = {},
): AdminCheckUser {
  return {
    emailAddresses: [{ id: "email-1", emailAddress: "deepshaswat@gmail.com" }],
    primaryEmailAddressId: "email-1",
    publicMetadata: {},
    ...overrides,
  };
}

describe("Admin Middleware", () => {
  describe("parseAdminEmails", () => {
    it("should parse comma-separated emails", () => {
      const emails = parseAdminEmails("admin@test.com,user@test.com");
      assert.deepStrictEqual(emails, ["admin@test.com", "user@test.com"]);
    });

    it("should trim whitespace from emails", () => {
      const emails = parseAdminEmails("  admin@test.com , user@test.com  ");
      assert.deepStrictEqual(emails, ["admin@test.com", "user@test.com"]);
    });

    it("should convert emails to lowercase", () => {
      const emails = parseAdminEmails("Admin@Test.COM,USER@test.com");
      assert.deepStrictEqual(emails, ["admin@test.com", "user@test.com"]);
    });

    it("should filter out empty entries", () => {
      const emails = parseAdminEmails("admin@test.com,,,,user@test.com,");
      assert.deepStrictEqual(emails, ["admin@test.com", "user@test.com"]);
    });

    it("should return empty array for undefined env var", () => {
      const emails = parseAdminEmails(undefined);
      assert.deepStrictEqual(emails, []);
    });

    it("should return empty array for empty string", () => {
      const emails = parseAdminEmails("");
      assert.deepStrictEqual(emails, []);
    });

    it("should handle single email", () => {
      const emails = parseAdminEmails("solo@test.com");
      assert.deepStrictEqual(emails, ["solo@test.com"]);
    });

    it("should handle emails with plus addressing", () => {
      const emails = parseAdminEmails("admin+tag@test.com");
      assert.deepStrictEqual(emails, ["admin+tag@test.com"]);
    });
  });

  describe("isUserAdmin", () => {
    it("should return true when user email is in admin list", () => {
      const user = createMockUser();
      const admins = parseAdminEmails("deepshaswat@gmail.com");
      assert.strictEqual(isUserAdmin(user, admins), true);
    });

    it("should return true when user has admin role in metadata", () => {
      const user = createMockUser({ publicMetadata: { role: "admin" } });
      assert.strictEqual(isUserAdmin(user, []), true);
    });

    it("should return false when user is neither in list nor has role", () => {
      const user = createMockUser({
        emailAddresses: [{ id: "email-1", emailAddress: "normie@test.com" }],
      });
      assert.strictEqual(isUserAdmin(user, []), false);
    });

    it("should be case-insensitive for email comparison", () => {
      const user = createMockUser({
        emailAddresses: [
          { id: "email-1", emailAddress: "DEEPSHASWAT@GMAIL.COM" },
        ],
      });
      const admins = parseAdminEmails("deepshaswat@gmail.com");
      assert.strictEqual(isUserAdmin(user, admins), true);
    });

    it("should return false when user has non-admin role", () => {
      const user = createMockUser({ publicMetadata: { role: "user" } });
      assert.strictEqual(isUserAdmin(user, []), false);
    });

    it("should return false when publicMetadata is empty", () => {
      const user = createMockUser({ publicMetadata: {} });
      assert.strictEqual(isUserAdmin(user, []), false);
    });

    it("should return false when publicMetadata is null", () => {
      const user = createMockUser({ publicMetadata: null });
      assert.strictEqual(isUserAdmin(user, []), false);
    });

    it("should fail closed when the primary email id does not match", () => {
      // primaryEmailAddressId points at an id not present in emailAddresses →
      // no resolvable primary email → not an admin even though the listed
      // address is allow-listed.
      const user = createMockUser({
        emailAddresses: [
          { id: "email-2", emailAddress: "deepshaswat@gmail.com" },
        ],
        primaryEmailAddressId: "email-1",
      });
      const admins = parseAdminEmails("deepshaswat@gmail.com");
      assert.strictEqual(isUserAdmin(user, admins), false);
    });

    it("should prioritize admin role over email allowlist", () => {
      const user = createMockUser({
        publicMetadata: { role: "admin" },
        emailAddresses: [{ id: "email-1", emailAddress: "random@test.com" }],
      });
      assert.strictEqual(isUserAdmin(user, []), true);
    });
  });
});
