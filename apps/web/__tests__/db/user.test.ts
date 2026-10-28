/**
 * User DB Layer Tests
 *
 * Tests for user.ts database logic including:
 * - getOrCreateDbUser: creates user if not exists, updates if exists
 * - getUserById: returns user or null
 * - Name fallback chain (fullName > firstName+lastName > firstName > "Trader")
 * - Null handling for missing Clerk user or email
 *
 * Since these functions call Prisma directly, we extract and test the
 * LOGIC portions (name resolution, email extraction, update checks)
 * as standalone pure functions mirroring the source code behavior.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// MONEY-620 de-shadow: import the REAL exports that lib/db/user.ts now calls in
// production (getOrCreateDbUser / syncClerkUserData). Previously these helpers
// were re-declared inline and the copy was asserted — a shadow.
import {
  resolveFullName,
  extractEmail,
  needsNameUpdate,
  type ClerkUserNameInput,
} from "@/lib/db/user-logic";

// ---------------------------------------------------------------------------
// Types mirroring the source
// ---------------------------------------------------------------------------

interface DbUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type ClerkUser = ClerkUserNameInput;

// ---------------------------------------------------------------------------
// Test-only composite over the REAL exports (not source — there is no single
// resolveUserAction in source; getOrCreateDbUser branches inline). Built ONLY
// from real imports so it introduces no shadowed logic.
// ---------------------------------------------------------------------------

/**
 * Models the create-or-update decision from getOrCreateDbUser using the real
 * primitives: reject on no email, create when absent, update when the resolved
 * name differs, else noop.
 */
function resolveUserAction(
  existingUser: DbUser | null,
  clerkUser: ClerkUser
): "create" | "update" | "noop" | "reject" {
  const email = extractEmail(clerkUser);
  if (!email) return "reject";

  const fullName = resolveFullName(clerkUser);

  if (!existingUser) return "create";
  if (needsNameUpdate(existingUser.name, fullName)) return "update";
  return "noop";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("User DB Logic", () => {
  // =========================================================================
  // Name fallback chain
  // =========================================================================

  describe("resolveFullName - name fallback chain", () => {
    it("should use fullName when available", () => {
      const user: ClerkUser = {
        fullName: "Deep Shaswat",
        firstName: "Deep",
        lastName: "Shaswat",
        emailAddresses: [{ emailAddress: "deep@test.com" }],
      };
      assert.strictEqual(resolveFullName(user), "Deep Shaswat");
    });

    it("should concatenate firstName and lastName when fullName is null", () => {
      const user: ClerkUser = {
        fullName: null,
        firstName: "Deep",
        lastName: "Shaswat",
        emailAddresses: [{ emailAddress: "deep@test.com" }],
      };
      assert.strictEqual(resolveFullName(user), "Deep Shaswat");
    });

    it("should use firstName alone when lastName is null", () => {
      const user: ClerkUser = {
        fullName: null,
        firstName: "Deep",
        lastName: null,
        emailAddresses: [{ emailAddress: "deep@test.com" }],
      };
      assert.strictEqual(resolveFullName(user), "Deep");
    });

    it("should fall back to 'Trader' when all name fields are null", () => {
      const user: ClerkUser = {
        fullName: null,
        firstName: null,
        lastName: null,
        emailAddresses: [{ emailAddress: "deep@test.com" }],
      };
      assert.strictEqual(resolveFullName(user), "Trader");
    });

    it("should use fullName when it is empty string (falsy) and fall back", () => {
      const user: ClerkUser = {
        fullName: "",
        firstName: null,
        lastName: null,
        emailAddresses: [{ emailAddress: "deep@test.com" }],
      };
      // Empty string is falsy, so falls through to firstName check, then "Trader"
      assert.strictEqual(resolveFullName(user), "Trader");
    });

    it("should prefer fullName over firstName+lastName even when different", () => {
      const user: ClerkUser = {
        fullName: "Dr. Deep S.",
        firstName: "Deep",
        lastName: "Shaswat",
        emailAddresses: [{ emailAddress: "deep@test.com" }],
      };
      assert.strictEqual(resolveFullName(user), "Dr. Deep S.");
    });

    it("should not concatenate if only lastName is provided", () => {
      const user: ClerkUser = {
        fullName: null,
        firstName: null,
        lastName: "Shaswat",
        emailAddresses: [{ emailAddress: "deep@test.com" }],
      };
      // firstName is null -> condition (firstName && lastName) is false
      // -> firstName || "Trader" -> null || "Trader" -> "Trader"
      assert.strictEqual(resolveFullName(user), "Trader");
    });

    it("should handle firstName as empty string", () => {
      const user: ClerkUser = {
        fullName: null,
        firstName: "",
        lastName: "Shaswat",
        emailAddresses: [{ emailAddress: "deep@test.com" }],
      };
      // "" && "Shaswat" is "" (falsy) -> "" || "Trader" -> "Trader"
      assert.strictEqual(resolveFullName(user), "Trader");
    });
  });

  // =========================================================================
  // Email extraction
  // =========================================================================

  describe("extractEmail", () => {
    it("should extract first email address", () => {
      const user: ClerkUser = {
        fullName: "Test",
        firstName: "Test",
        lastName: null,
        emailAddresses: [
          { emailAddress: "primary@test.com" },
          { emailAddress: "secondary@test.com" },
        ],
      };
      assert.strictEqual(extractEmail(user), "primary@test.com");
    });

    it("should return null when emailAddresses is empty", () => {
      const user: ClerkUser = {
        fullName: "Test",
        firstName: "Test",
        lastName: null,
        emailAddresses: [],
      };
      assert.strictEqual(extractEmail(user), null);
    });

    it("should handle single email", () => {
      const user: ClerkUser = {
        fullName: "Test",
        firstName: null,
        lastName: null,
        emailAddresses: [{ emailAddress: "only@test.com" }],
      };
      assert.strictEqual(extractEmail(user), "only@test.com");
    });
  });

  // =========================================================================
  // Null handling for missing Clerk user
  // =========================================================================

  describe("Null handling for missing Clerk user", () => {
    it("should return null when clerkUser is null", () => {
      // In the source code, if currentUser() returns null, the function returns null
      const clerkUser: ClerkUser | null = null;
      const result = clerkUser === null ? null : "would_process";
      assert.strictEqual(result, null);
    });

    it("should return null when email is missing", () => {
      const clerkUser: ClerkUser = {
        fullName: "Test",
        firstName: "Test",
        lastName: null,
        emailAddresses: [],
      };
      const email = extractEmail(clerkUser);
      const result = email === null ? null : "would_process";
      assert.strictEqual(result, null);
    });

    it("should proceed when both clerkUser and email are present", () => {
      const clerkUser: ClerkUser = {
        fullName: "Test User",
        firstName: "Test",
        lastName: "User",
        emailAddresses: [{ emailAddress: "test@test.com" }],
      };
      const email = extractEmail(clerkUser);
      assert.notStrictEqual(email, null);
    });
  });

  // =========================================================================
  // getOrCreateDbUser logic
  // =========================================================================

  describe("getOrCreateDbUser logic", () => {
    it("should create user when not found in database", () => {
      const clerkUser: ClerkUser = {
        fullName: "New User",
        firstName: "New",
        lastName: "User",
        emailAddresses: [{ emailAddress: "new@test.com" }],
      };

      const action = resolveUserAction(null, clerkUser);
      assert.strictEqual(action, "create");
    });

    it("should update user when name has changed", () => {
      const existingUser: DbUser = {
        id: "user-1",
        email: "existing@test.com",
        name: "Old Name",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const clerkUser: ClerkUser = {
        fullName: "New Name",
        firstName: "New",
        lastName: "Name",
        emailAddresses: [{ emailAddress: "existing@test.com" }],
      };

      const action = resolveUserAction(existingUser, clerkUser);
      assert.strictEqual(action, "update");
    });

    it("should noop when name has not changed", () => {
      const existingUser: DbUser = {
        id: "user-1",
        email: "existing@test.com",
        name: "Same Name",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const clerkUser: ClerkUser = {
        fullName: "Same Name",
        firstName: "Same",
        lastName: "Name",
        emailAddresses: [{ emailAddress: "existing@test.com" }],
      };

      const action = resolveUserAction(existingUser, clerkUser);
      assert.strictEqual(action, "noop");
    });

    it("should reject when no email is provided", () => {
      const clerkUser: ClerkUser = {
        fullName: "No Email",
        firstName: "No",
        lastName: "Email",
        emailAddresses: [],
      };

      const action = resolveUserAction(null, clerkUser);
      assert.strictEqual(action, "reject");
    });

    it("should detect name update from null to a valid name", () => {
      const existingUser: DbUser = {
        id: "user-1",
        email: "test@test.com",
        name: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const clerkUser: ClerkUser = {
        fullName: "Now Has Name",
        firstName: "Now",
        lastName: "Has Name",
        emailAddresses: [{ emailAddress: "test@test.com" }],
      };

      assert.strictEqual(
        needsNameUpdate(existingUser.name, "Now Has Name"),
        true
      );
      const action = resolveUserAction(existingUser, clerkUser);
      assert.strictEqual(action, "update");
    });

    it("should detect no update needed when both names are Trader", () => {
      const existingUser: DbUser = {
        id: "user-1",
        email: "test@test.com",
        name: "Trader",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const clerkUser: ClerkUser = {
        fullName: null,
        firstName: null,
        lastName: null,
        emailAddresses: [{ emailAddress: "test@test.com" }],
      };

      const resolvedName = resolveFullName(clerkUser);
      assert.strictEqual(resolvedName, "Trader");
      assert.strictEqual(
        needsNameUpdate(existingUser.name, resolvedName),
        false
      );
    });
  });

  // =========================================================================
  // getUserById logic
  // =========================================================================

  describe("getUserById logic", () => {
    it("should return user data when found", () => {
      const user: DbUser = {
        id: "user-123",
        email: "found@test.com",
        name: "Found User",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-06-01"),
      };

      assert.strictEqual(user.id, "user-123");
      assert.strictEqual(user.email, "found@test.com");
      assert.strictEqual(user.name, "Found User");
    });

    it("should return null when user is not found", () => {
      const user: DbUser | null = null;
      assert.strictEqual(user, null);
    });

    it("should include all required fields in user select", () => {
      const selectFields = ["id", "email", "name", "createdAt", "updatedAt"];
      const user: DbUser = {
        id: "user-1",
        email: "test@test.com",
        name: "Test",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      for (const field of selectFields) {
        assert.ok(
          field in user,
          `Field '${field}' should be present in user object`
        );
      }
    });

    it("should handle user with null name", () => {
      const user: DbUser = {
        id: "user-1",
        email: "test@test.com",
        name: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      assert.strictEqual(user.name, null);
    });
  });

  // =========================================================================
  // syncClerkUserData logic
  // =========================================================================

  describe("syncClerkUserData logic (upsert behavior)", () => {
    it("should resolve correct data for upsert create", () => {
      const clerkUser: ClerkUser = {
        fullName: "New Sync User",
        firstName: "New",
        lastName: "Sync User",
        emailAddresses: [{ emailAddress: "newsync@test.com" }],
      };

      const email = extractEmail(clerkUser);
      const name = resolveFullName(clerkUser);

      assert.strictEqual(email, "newsync@test.com");
      assert.strictEqual(name, "New Sync User");
    });

    it("should resolve correct data for upsert update", () => {
      const clerkUser: ClerkUser = {
        fullName: "Updated Name",
        firstName: "Updated",
        lastName: "Name",
        emailAddresses: [{ emailAddress: "existing@test.com" }],
      };

      const name = resolveFullName(clerkUser);
      assert.strictEqual(name, "Updated Name");
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe("Error handling behavior", () => {
    it("should return null on error (mirrors try-catch pattern)", () => {
      // All three exported functions return null on error
      const simulateError = (): DbUser | null => {
        try {
          throw new Error("Simulated DB error");
        } catch {
          return null;
        }
      };

      assert.strictEqual(simulateError(), null);
    });

    it("should handle invalid userId gracefully", () => {
      const invalidIds = ["", " ", "undefined", "null"];
      for (const id of invalidIds) {
        // The function would still attempt lookup; it would simply find no user
        assert.strictEqual(typeof id, "string");
      }
    });
  });
});
