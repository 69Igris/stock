/**
 * Authors Action Tests
 *
 * Exercises the REAL exported helpers from
 * `apps/content/lib/actions/authors-logic.ts` (which `authors.ts` imports and
 * calls) — NOT inline copies.
 * - sanitizeUsername / generateUsernameBase / usernameWithCounter
 * - determineNewAuthorRole (first user = OWNER, invite = invite role, else WRITER)
 * - canChangeRoles / canSelfDemote (SECURITY: role-change guards)
 * - buildClerkName
 * - checkInviteEligibility / canRevokeInvite (SECURITY: invite guards)
 * - buildProfileUpdateData partial update logic
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeUsername,
  generateUsernameBase,
  usernameWithCounter,
  determineNewAuthorRole,
  canChangeRoles,
  canSelfDemote,
  buildClerkName,
  checkInviteEligibility,
  canRevokeInvite,
  buildProfileUpdateData,
} from "@/lib/actions/authors-logic";

// ── Tests ────────────────────────────────────────────────

describe("sanitizeUsername", () => {
  it("should lowercase input", () => {
    assert.strictEqual(sanitizeUsername("JohnDoe"), "johndoe");
  });

  it("should replace dots with underscores", () => {
    assert.strictEqual(sanitizeUsername("john.doe"), "john_doe");
  });

  it("should replace spaces with underscores", () => {
    assert.strictEqual(sanitizeUsername("John Doe"), "john_doe");
  });

  it("should keep existing underscores", () => {
    assert.strictEqual(sanitizeUsername("john_doe"), "john_doe");
  });

  it("should keep numbers", () => {
    assert.strictEqual(sanitizeUsername("user42"), "user42");
  });

  it("should truncate to 25 characters", () => {
    const long = "a".repeat(30);
    assert.strictEqual(sanitizeUsername(long).length, 25);
  });

  it("should handle empty string", () => {
    assert.strictEqual(sanitizeUsername(""), "");
  });

  it("should handle all special characters", () => {
    assert.strictEqual(sanitizeUsername("!@#$%"), "_____");
  });
});

describe("generateUsernameBase", () => {
  it("should use name when provided", () => {
    assert.strictEqual(
      generateUsernameBase("john@example.com", "John Doe"),
      "john_doe",
    );
  });

  it("should use email prefix when name is null", () => {
    assert.strictEqual(
      generateUsernameBase("trader@example.com", null),
      "trader",
    );
  });

  it("should use email prefix when name is undefined", () => {
    assert.strictEqual(
      generateUsernameBase("investor@usemoney.ai"),
      "investor",
    );
  });

  it("should handle email with dots in prefix", () => {
    assert.strictEqual(
      generateUsernameBase("john.doe@example.com", null),
      "john_doe",
    );
  });

  it("should handle email with plus sign", () => {
    assert.strictEqual(
      generateUsernameBase("john+test@example.com", null),
      "john_test",
    );
  });
});

describe("usernameWithCounter", () => {
  it("should append counter to base", () => {
    assert.strictEqual(usernameWithCounter("john", 1), "john_1");
  });

  it("should handle higher counters", () => {
    assert.strictEqual(usernameWithCounter("user", 99), "user_99");
  });
});

describe("determineNewAuthorRole", () => {
  it("should return OWNER when no authors exist", () => {
    assert.strictEqual(determineNewAuthorRole(0), "OWNER");
  });

  it("should return WRITER when authors already exist", () => {
    assert.strictEqual(determineNewAuthorRole(5), "WRITER");
  });

  it("should return invite role when pending invite exists", () => {
    assert.strictEqual(determineNewAuthorRole(5, "ADMIN"), "ADMIN");
  });

  it("should prefer invite role over first-author OWNER", () => {
    assert.strictEqual(determineNewAuthorRole(0, "WRITER"), "WRITER");
  });
});

describe("canChangeRoles", () => {
  it("should allow OWNER to change roles", () => {
    assert.strictEqual(canChangeRoles("OWNER"), true);
  });

  it("should deny ADMIN from changing roles", () => {
    assert.strictEqual(canChangeRoles("ADMIN"), false);
  });

  it("should deny WRITER from changing roles", () => {
    assert.strictEqual(canChangeRoles("WRITER"), false);
  });
});

describe("canSelfDemote", () => {
  it("should allow demoting other authors", () => {
    const result = canSelfDemote("a1", "a2", "WRITER", 1);
    assert.strictEqual(result.allowed, true);
  });

  it("should allow self-demotion when multiple owners exist", () => {
    const result = canSelfDemote("a1", "a1", "ADMIN", 2);
    assert.strictEqual(result.allowed, true);
  });

  it("should block self-demotion when sole owner", () => {
    const result = canSelfDemote("a1", "a1", "ADMIN", 1);
    assert.strictEqual(result.allowed, false);
    assert.ok(result.error?.includes("only owner"));
  });

  it("should allow keeping OWNER role even when sole owner", () => {
    const result = canSelfDemote("a1", "a1", "OWNER", 1);
    assert.strictEqual(result.allowed, true);
  });
});

describe("buildClerkName", () => {
  it("should combine first and last name", () => {
    assert.strictEqual(buildClerkName("John", "Doe"), "John Doe");
  });

  it("should return just first name when no last name", () => {
    assert.strictEqual(buildClerkName("John", null), "John");
  });

  it("should return just last name when no first name", () => {
    assert.strictEqual(buildClerkName(null, "Doe"), "Doe");
  });

  it("should return null when both are null", () => {
    assert.strictEqual(buildClerkName(null, null), null);
  });

  it("should return null when both are empty strings", () => {
    assert.strictEqual(buildClerkName("", ""), null);
  });
});

describe("checkInviteEligibility", () => {
  it("should allow OWNER to invite", () => {
    assert.strictEqual(checkInviteEligibility("OWNER").allowed, true);
  });

  it("should allow ADMIN to invite", () => {
    assert.strictEqual(checkInviteEligibility("ADMIN").allowed, true);
  });

  it("should deny WRITER from inviting", () => {
    const result = checkInviteEligibility("WRITER");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.error?.includes("Only owners and admins"));
  });
});

describe("canRevokeInvite", () => {
  it("should allow revoking PENDING invite", () => {
    assert.strictEqual(canRevokeInvite("PENDING").allowed, true);
  });

  it("should deny revoking ACCEPTED invite", () => {
    const result = canRevokeInvite("ACCEPTED");
    assert.strictEqual(result.allowed, false);
    assert.ok(result.error?.includes("Only pending"));
  });

  it("should deny revoking EXPIRED invite", () => {
    const result = canRevokeInvite("EXPIRED");
    assert.strictEqual(result.allowed, false);
  });

  it("should deny revoking REVOKED invite", () => {
    const result = canRevokeInvite("REVOKED");
    assert.strictEqual(result.allowed, false);
  });
});

describe("buildProfileUpdateData", () => {
  it("should include name when provided", () => {
    const data = buildProfileUpdateData({ name: "New Name" });
    assert.deepStrictEqual(data, { name: "New Name" });
  });

  it("should include imageUrl when provided", () => {
    const data = buildProfileUpdateData({
      imageUrl: "https://img.com/photo.jpg",
    });
    assert.deepStrictEqual(data, { imageUrl: "https://img.com/photo.jpg" });
  });

  it("should include both when both provided", () => {
    const data = buildProfileUpdateData({
      name: "Name",
      imageUrl: "https://img.com/photo.jpg",
    });
    assert.deepStrictEqual(data, {
      name: "Name",
      imageUrl: "https://img.com/photo.jpg",
    });
  });

  it("should return empty object when nothing provided", () => {
    const data = buildProfileUpdateData({});
    assert.deepStrictEqual(data, {});
  });

  it("should include empty string name when explicitly set", () => {
    const data = buildProfileUpdateData({ name: "" });
    assert.deepStrictEqual(data, { name: "" });
  });
});
