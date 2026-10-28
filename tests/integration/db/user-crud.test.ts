/**
 * Integration Tests: User CRUD Operations
 *
 * Tests user creation, lookup, update, and deletion against the QA MongoDB.
 * All test data uses the `test_integration_` prefix and is cleaned up in after() hooks.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

if (!process.env.RUN_INTEGRATION_TESTS) {
  describe("Integration: User CRUD (skipped)", () => {
    it("skipped - set RUN_INTEGRATION_TESTS=true to run", () => {
      assert.ok(true, "Skipped");
    });
  });
} else {
  // Lazy-loaded modules (populated in top-level before())
  let db: PrismaClient;
  let createTestUser: typeof import("../helpers.js").createTestUser;
  let cleanupTestUser: typeof import("../helpers.js").cleanupTestUser;

  // Track all user IDs created during tests for cleanup
  const createdUserIds: string[] = [];

  describe("Integration: User CRUD", () => {
    before(async () => {
      const setupMod = await import("../setup.js");
      await import("../teardown.js");
      const helpersMod = await import("../helpers.js");
      db = setupMod.db;
      createTestUser = helpersMod.createTestUser;
      cleanupTestUser = helpersMod.cleanupTestUser;
    });

    after(async () => {
      for (const userId of createdUserIds) {
        await cleanupTestUser(userId);
      }
    });

    // --- Create ---

    describe("create user", () => {
      it("should create a user with email and name", async () => {
        const user = await createTestUser({ name: "Create Test" });
        createdUserIds.push(user.id);

        assert.ok(user.id, "User should have an id");
        assert.ok(user.email.startsWith("test_integration_"), "Email should have test prefix");
        assert.strictEqual(user.name, "Create Test");
        assert.strictEqual(user.isActive, true);
      });

      it("should create a user with custom email", async () => {
        const email = `test_integration_custom_${Date.now()}@test.usemoney.ai`;
        const user = await createTestUser({ email });
        createdUserIds.push(user.id);

        assert.strictEqual(user.email, email);
      });

      it("should auto-set createdAt and updatedAt", async () => {
        const beforeTime = new Date();
        const user = await createTestUser();
        createdUserIds.push(user.id);
        const afterTime = new Date();

        assert.ok(user.createdAt >= beforeTime, "createdAt should be >= test start");
        assert.ok(user.createdAt <= afterTime, "createdAt should be <= test end");
        assert.ok(user.updatedAt >= beforeTime, "updatedAt should be >= test start");
      });

      it("should reject duplicate email", async () => {
        const email = `test_integration_dup_${Date.now()}@test.usemoney.ai`;
        const user1 = await createTestUser({ email });
        createdUserIds.push(user1.id);

        await assert.rejects(
          () => createTestUser({ email }),
          (err: Error) => {
            assert.ok(
              err.message.includes("Unique constraint") || err.message.includes("unique"),
              `Expected unique constraint error, got: ${err.message}`
            );
            return true;
          }
        );
      });

      it("should create a user without a name (name is optional)", async () => {
        const email = `test_integration_noname_${Date.now()}@test.usemoney.ai`;
        const user = await db.user.create({
          data: { email, isActive: true },
        });
        createdUserIds.push(user.id);

        assert.strictEqual(user.name, null);
        assert.strictEqual(user.email, email);
      });
    });

    // --- Read / Find ---

    describe("find user", () => {
      let testUserId: string;
      let testUserEmail: string;
      const testClerkId = `test_integration_clerk_${Date.now()}`;

      before(async () => {
        testUserEmail = `test_integration_find_${Date.now()}@test.usemoney.ai`;
        const user = await db.user.create({
          data: {
            email: testUserEmail,
            name: "Find Test User",
            clerkId: testClerkId,
            isActive: true,
          },
        });
        testUserId = user.id;
        createdUserIds.push(testUserId);
      });

      it("should find user by id", async () => {
        const found = await db.user.findUnique({ where: { id: testUserId } });

        assert.ok(found, "User should be found");
        assert.strictEqual(found!.id, testUserId);
        assert.strictEqual(found!.name, "Find Test User");
      });

      it("should find user by email", async () => {
        const found = await db.user.findUnique({ where: { email: testUserEmail } });

        assert.ok(found, "User should be found by email");
        assert.strictEqual(found!.id, testUserId);
      });

      it("should find user by clerkId", async () => {
        const found = await db.user.findUnique({ where: { clerkId: testClerkId } });

        assert.ok(found, "User should be found by clerkId");
        assert.strictEqual(found!.id, testUserId);
      });

      it("should return null for non-existent id", async () => {
        const found = await db.user.findUnique({
          where: { id: "000000000000000000000000" },
        });
        assert.strictEqual(found, null);
      });

      it("should return null for non-existent email", async () => {
        const found = await db.user.findUnique({
          where: { email: "nonexistent_user_xyz@test.usemoney.ai" },
        });
        assert.strictEqual(found, null);
      });
    });

    // --- Update ---

    describe("update user", () => {
      it("should update user name", async () => {
        const user = await createTestUser({ name: "Before Update" });
        createdUserIds.push(user.id);

        const updated = await db.user.update({
          where: { id: user.id },
          data: { name: "After Update" },
        });

        assert.strictEqual(updated.name, "After Update");
        assert.ok(updated.updatedAt > user.updatedAt, "updatedAt should advance");
      });

      it("should update emailPreferences (JSON field)", async () => {
        const user = await createTestUser();
        createdUserIds.push(user.id);

        const prefs = { marketAlerts: true, weeklyDigest: false };
        const updated = await db.user.update({
          where: { id: user.id },
          data: { emailPreferences: prefs },
        });

        assert.deepStrictEqual(updated.emailPreferences, prefs);
      });

      it("should soft-delete user by setting isActive to false", async () => {
        const user = await createTestUser();
        createdUserIds.push(user.id);

        const updated = await db.user.update({
          where: { id: user.id },
          data: { isActive: false },
        });

        assert.strictEqual(updated.isActive, false);
      });

      it("should set clerkId on existing user", async () => {
        const user = await createTestUser();
        createdUserIds.push(user.id);
        const clerkId = `test_integration_clerk_update_${Date.now()}`;

        const updated = await db.user.update({
          where: { id: user.id },
          data: { clerkId },
        });

        assert.strictEqual(updated.clerkId, clerkId);
      });
    });

    // --- Delete ---

    describe("delete user", () => {
      it("should delete user by id", async () => {
        const user = await createTestUser();

        await db.user.delete({ where: { id: user.id } });

        const found = await db.user.findUnique({ where: { id: user.id } });
        assert.strictEqual(found, null, "User should no longer exist");
      });

      it("should handle deleteMany with zero matches gracefully", async () => {
        const result = await db.user.deleteMany({
          where: { email: "definitely_not_a_real_email_xyz@test.usemoney.ai" },
        });
        assert.strictEqual(result.count, 0);
      });
    });

    // --- Duplicate clerkId ---

    describe("duplicate clerkId handling", () => {
      it("should reject duplicate clerkId", async () => {
        const clerkId = `test_integration_dup_clerk_${Date.now()}`;

        const user1 = await db.user.create({
          data: {
            email: `test_integration_dup1_${Date.now()}@test.usemoney.ai`,
            clerkId,
            isActive: true,
          },
        });
        createdUserIds.push(user1.id);

        await assert.rejects(
          () =>
            db.user.create({
              data: {
                email: `test_integration_dup2_${Date.now()}@test.usemoney.ai`,
                clerkId,
                isActive: true,
              },
            }),
          (err: Error) => {
            assert.ok(
              err.message.includes("Unique constraint") || err.message.includes("unique"),
              `Expected unique constraint error, got: ${err.message}`
            );
            return true;
          }
        );
      });

      it("should allow multiple users without clerkId (null is not unique-conflicting)", async () => {
        const user1 = await createTestUser();
        const user2 = await createTestUser();
        createdUserIds.push(user1.id, user2.id);

        assert.strictEqual(user1.clerkId, null);
        assert.strictEqual(user2.clerkId, null);
        assert.notStrictEqual(user1.id, user2.id);
      });
    });
  });
}
