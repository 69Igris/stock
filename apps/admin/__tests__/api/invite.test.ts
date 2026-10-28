/**
 * Admin Invite API Route Tests
 *
 * Exercises the REAL exported helpers the invite route imports and calls:
 *   - `validateInviteEmail` + `buildInviteResponse`
 *     (apps/admin/lib/actions/invite-logic.ts)
 *   - the admin gate `isUserAdmin` (apps/admin/lib/admin-auth-logic.ts), now
 *     shared by the route via lib/auth.ts#verifyAdminUserId.
 *
 * No inline reimplementation.
 *
 * Source: apps/admin/app/api/admin/invite/route.ts
 *
 * Note: the previous inline copy tested a role-ONLY `verifyAdminRole`. The
 * route now uses the shared `isUserAdmin` (role OR ADMIN_EMAILS allowlist),
 * fixing the prior inconsistency where an allow-listed admin could not use this
 * endpoint, so the gate is tested via the real predicate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateInviteEmail,
  buildInviteResponse,
} from "@/lib/actions/invite-logic";
import { isUserAdmin, type AdminCheckUser } from "@/lib/admin-auth-logic";

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

describe("Admin Invite API", () => {
  describe("admin gate (isUserAdmin)", () => {
    it("should return true for admin role", () => {
      const user = createMockClerkUser({ publicMetadata: { role: "admin" } });
      assert.strictEqual(isUserAdmin(user, []), true);
    });

    it("should return false for non-admin role", () => {
      const user = createMockClerkUser({ publicMetadata: { role: "user" } });
      assert.strictEqual(isUserAdmin(user, []), false);
    });

    it("should return false for missing role and no allowlist match", () => {
      const user = createMockClerkUser({
        publicMetadata: {},
        emailAddresses: [{ id: "email-1", emailAddress: "user@test.com" }],
      });
      assert.strictEqual(isUserAdmin(user, []), false);
    });

    it("should grant access to an allow-listed email (prior inconsistency fix)", () => {
      const user = createMockClerkUser({
        publicMetadata: {},
        emailAddresses: [
          { id: "email-1", emailAddress: "deepshaswat@gmail.com" },
        ],
      });
      assert.strictEqual(isUserAdmin(user, ["deepshaswat@gmail.com"]), true);
    });
  });

  describe("validateInviteEmail", () => {
    it("should return null for valid email", () => {
      assert.strictEqual(validateInviteEmail({ email: "user@test.com" }), null);
    });

    it("should return error for empty email", () => {
      assert.strictEqual(
        validateInviteEmail({ email: "" }),
        "Valid email is required",
      );
    });

    it("should return error for missing email", () => {
      assert.strictEqual(validateInviteEmail({}), "Valid email is required");
    });

    it("should return error for email without @", () => {
      assert.strictEqual(
        validateInviteEmail({ email: "notanemail" }),
        "Valid email is required",
      );
    });

    it("should accept email with plus addressing", () => {
      assert.strictEqual(
        validateInviteEmail({ email: "user+admin@test.com" }),
        null,
      );
    });

    it("should accept email with subdomain", () => {
      assert.strictEqual(
        validateInviteEmail({ email: "user@mail.test.com" }),
        null,
      );
    });
  });

  describe("buildInviteResponse", () => {
    it("should return existing user response when count > 0", () => {
      const email = "existing@test.com";
      const response = buildInviteResponse(email, 1);

      assert.strictEqual(response.success, true);
      assert.strictEqual(response.existing, true);
      assert.ok(response.message?.includes(email));
    });

    it("should return new user response when count is 0", () => {
      const email = "new@test.com";
      const response = buildInviteResponse(email, 0);

      assert.strictEqual(response.success, true);
      assert.strictEqual(response.existing, false);
      assert.ok(response.message?.includes(email));
      assert.ok(response.instructions !== undefined);
    });

    it("should include setup instructions for new users", () => {
      const response = buildInviteResponse("new@test.com", 0);
      assert.ok(response.instructions?.includes("publicMetadata"));
      assert.ok(response.instructions?.includes("admin"));
    });

    it("should include grant message for existing users", () => {
      const response = buildInviteResponse("user@test.com", 1);
      assert.ok(response.message?.includes("granted admin access"));
    });

    it("should treat multiple existing users as existing", () => {
      const response = buildInviteResponse("multi@test.com", 2);
      assert.strictEqual(response.existing, true);
    });
  });
});
