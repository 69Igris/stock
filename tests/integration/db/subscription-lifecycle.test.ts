/**
 * Integration Tests: Subscription Lifecycle
 *
 * Tests subscription creation, plan upgrades/downgrades, query tracking,
 * cancellation, and grace period logic against the QA MongoDB.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

if (!process.env.RUN_INTEGRATION_TESTS) {
  describe("Integration: Subscription Lifecycle (skipped)", () => {
    it("skipped - set RUN_INTEGRATION_TESTS=true to run", () => {
      assert.ok(true, "Skipped");
    });
  });
} else {
  let db: PrismaClient;
  let createTestUser: typeof import("../helpers.js").createTestUser;
  let createTestSubscription: typeof import("../helpers.js").createTestSubscription;
  let cleanupTestUser: typeof import("../helpers.js").cleanupTestUser;

  const createdUserIds: string[] = [];

  describe("Integration: Subscription Lifecycle", () => {
    before(async () => {
      const setupMod = await import("../setup.js");
      await import("../teardown.js");
      const helpersMod = await import("../helpers.js");
      db = setupMod.db;
      createTestUser = helpersMod.createTestUser;
      createTestSubscription = helpersMod.createTestSubscription;
      cleanupTestUser = helpersMod.cleanupTestUser;
    });

    after(async () => {
      for (const userId of createdUserIds) {
        await cleanupTestUser(userId);
      }
    });

    // --- Create FREE subscription ---

    describe("create FREE subscription", () => {
      it("should create a FREE subscription with default limits", async () => {
        const user = await createTestUser({ name: "Free Sub Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "FREE");

        assert.ok(sub.id, "Subscription should have an id");
        assert.strictEqual(sub.userId, user.id);
        assert.strictEqual(sub.planId, "FREE");
        assert.strictEqual(sub.status, "ACTIVE");
        assert.strictEqual(sub.fastQueriesUsed, 0);
        assert.strictEqual(sub.fastQueriesLimit, 5);
        assert.strictEqual(sub.advancedQueriesUsed, 0);
        assert.strictEqual(sub.advancedQueriesLimit, 0);
      });

      it("should set startDate to now", async () => {
        const beforeCreate = new Date();
        const user = await createTestUser({ name: "Sub StartDate Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id);
        const afterCreate = new Date();

        assert.ok(sub.startDate >= beforeCreate);
        assert.ok(sub.startDate <= afterCreate);
      });

      it("should enforce one subscription per user (unique userId)", async () => {
        const user = await createTestUser({ name: "Unique Sub Test" });
        createdUserIds.push(user.id);

        await createTestSubscription(user.id);

        await assert.rejects(
          () => createTestSubscription(user.id),
          (err: Error) => {
            assert.ok(
              err.message.includes("Unique constraint") || err.message.includes("unique"),
              `Expected unique constraint error, got: ${err.message}`
            );
            return true;
          }
        );
      });
    });

    // --- Upgrade to PREMIUM ---

    describe("upgrade to PREMIUM", () => {
      it("should upgrade planId from FREE to PREMIUM", async () => {
        const user = await createTestUser({ name: "Upgrade Test" });
        createdUserIds.push(user.id);

        const freeSub = await createTestSubscription(user.id, "FREE");

        const upgraded = await db.subscription.update({
          where: { id: freeSub.id },
          data: {
            planId: "PREMIUM",
            billingPeriod: "monthly",
            fastQueriesLimit: 100,
            advancedQueriesLimit: 50,
          },
        });

        assert.strictEqual(upgraded.planId, "PREMIUM");
        assert.strictEqual(upgraded.billingPeriod, "monthly");
        assert.strictEqual(upgraded.fastQueriesLimit, 100);
        assert.strictEqual(upgraded.advancedQueriesLimit, 50);
      });

      it("should upgrade to PRO tier", async () => {
        const user = await createTestUser({ name: "Pro Upgrade Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "FREE");

        const upgraded = await db.subscription.update({
          where: { id: sub.id },
          data: {
            planId: "PRO",
            billingPeriod: "annual",
            fastQueriesLimit: 500,
            advancedQueriesLimit: 200,
          },
        });

        assert.strictEqual(upgraded.planId, "PRO");
        assert.strictEqual(upgraded.billingPeriod, "annual");
      });

      it("should preserve startDate on upgrade", async () => {
        const user = await createTestUser({ name: "Preserve StartDate Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "FREE");
        const originalStart = sub.startDate;

        const upgraded = await db.subscription.update({
          where: { id: sub.id },
          data: { planId: "PREMIUM", fastQueriesLimit: 100 },
        });

        assert.strictEqual(
          upgraded.startDate.getTime(),
          originalStart.getTime(),
          "startDate should not change on upgrade"
        );
      });
    });

    // --- Query consumption tracking ---

    describe("query consumption tracking", () => {
      it("should increment fastQueriesUsed", async () => {
        const user = await createTestUser({ name: "Query Track Test" });
        createdUserIds.push(user.id);

        await createTestSubscription(user.id, "PREMIUM");

        const updated = await db.subscription.update({
          where: { userId: user.id },
          data: { fastQueriesUsed: { increment: 1 } },
        });

        assert.strictEqual(updated.fastQueriesUsed, 1);
      });

      it("should increment advancedQueriesUsed", async () => {
        const user = await createTestUser({ name: "Advanced Query Track" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "PREMIUM");

        for (let i = 0; i < 3; i++) {
          await db.subscription.update({
            where: { id: sub.id },
            data: { advancedQueriesUsed: { increment: 1 } },
          });
        }

        const final = await db.subscription.findUnique({
          where: { id: sub.id },
        });
        assert.strictEqual(final!.advancedQueriesUsed, 3);
      });

      it("should reset query counts", async () => {
        const user = await createTestUser({ name: "Query Reset Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "PREMIUM");

        await db.subscription.update({
          where: { id: sub.id },
          data: { fastQueriesUsed: 42, advancedQueriesUsed: 7 },
        });

        const reset = await db.subscription.update({
          where: { id: sub.id },
          data: {
            fastQueriesUsed: 0,
            advancedQueriesUsed: 0,
            aiQueriesResetAt: new Date(),
          },
        });

        assert.strictEqual(reset.fastQueriesUsed, 0);
        assert.strictEqual(reset.advancedQueriesUsed, 0);
        assert.ok(reset.aiQueriesResetAt, "Reset timestamp should be set");
      });

      it("should track query pack usage separately", async () => {
        const user = await createTestUser({ name: "Query Pack Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "FREE");

        const updated = await db.subscription.update({
          where: { id: sub.id },
          data: {
            queryPackActive: true,
            queryPackFastQueriesLimit: 50,
            queryPackAdvancedQueriesLimit: 20,
            queryPackStartDate: new Date(),
            queryPackEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });

        assert.strictEqual(updated.queryPackActive, true);
        assert.strictEqual(updated.queryPackFastQueriesLimit, 50);
      });
    });

    // --- Cancellation ---

    describe("cancel subscription", () => {
      it("should set status to CANCELLED with cancelledAt timestamp", async () => {
        const user = await createTestUser({ name: "Cancel Sub Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "PREMIUM");

        const cancelledAt = new Date();
        const cancelled = await db.subscription.update({
          where: { id: sub.id },
          data: {
            status: "CANCELLED",
            cancelledAt,
          },
        });

        assert.strictEqual(cancelled.status, "CANCELLED");
        assert.ok(cancelled.cancelledAt, "cancelledAt should be set");
      });

      it("should set endDate for grace period", async () => {
        const user = await createTestUser({ name: "Grace Period Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "PREMIUM");

        const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const cancelled = await db.subscription.update({
          where: { id: sub.id },
          data: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            endDate,
          },
        });

        assert.ok(cancelled.endDate, "endDate should be set for grace period");
        assert.ok(
          cancelled.endDate! > new Date(),
          "endDate should be in the future"
        );
      });

      it("should find cancelled subscriptions", async () => {
        const user = await createTestUser({ name: "Find Cancelled Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "PREMIUM");

        await db.subscription.update({
          where: { id: sub.id },
          data: { status: "CANCELLED", cancelledAt: new Date() },
        });

        const found = await db.subscription.findFirst({
          where: { userId: user.id, status: "CANCELLED" },
        });

        assert.ok(found, "Should find the cancelled subscription");
        assert.strictEqual(found!.status, "CANCELLED");
      });
    });

    // --- Downgrade ---

    describe("downgrade flow", () => {
      it("should downgrade from PREMIUM to FREE", async () => {
        const user = await createTestUser({ name: "Downgrade Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "PREMIUM");

        const downgraded = await db.subscription.update({
          where: { id: sub.id },
          data: {
            planId: "FREE",
            billingPeriod: null,
            fastQueriesLimit: 5,
            advancedQueriesLimit: 0,
            fastQueriesUsed: 0,
            advancedQueriesUsed: 0,
            dodoCustomerId: null,
            dodoSubscriptionId: null,
          },
        });

        assert.strictEqual(downgraded.planId, "FREE");
        assert.strictEqual(downgraded.billingPeriod, null);
        assert.strictEqual(downgraded.fastQueriesLimit, 5);
        assert.strictEqual(downgraded.advancedQueriesLimit, 0);
      });

      it("should reset addons on downgrade", async () => {
        const user = await createTestUser({ name: "Downgrade Addons Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "PREMIUM");

        await db.subscription.update({
          where: { id: sub.id },
          data: { addons: ["AI_ADDON", "QUERY_PACK"] },
        });

        const downgraded = await db.subscription.update({
          where: { id: sub.id },
          data: {
            planId: "FREE",
            addons: [],
          },
        });

        assert.deepStrictEqual(downgraded.addons, []);
      });
    });

    // --- Expiration ---

    describe("expiration", () => {
      it("should set status to EXPIRED", async () => {
        const user = await createTestUser({ name: "Expired Sub Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "PREMIUM");

        const expired = await db.subscription.update({
          where: { id: sub.id },
          data: {
            status: "EXPIRED",
            endDate: new Date(),
          },
        });

        assert.strictEqual(expired.status, "EXPIRED");
      });

      it("should find active subscriptions only", async () => {
        const user1 = await createTestUser({ name: "Active Sub User" });
        const user2 = await createTestUser({ name: "Expired Sub User" });
        createdUserIds.push(user1.id, user2.id);

        await createTestSubscription(user1.id, "PREMIUM");
        const sub2 = await createTestSubscription(user2.id, "PREMIUM");
        await db.subscription.update({
          where: { id: sub2.id },
          data: { status: "EXPIRED" },
        });

        const activeSubs = await db.subscription.findMany({
          where: {
            userId: { in: [user1.id, user2.id] },
            status: "ACTIVE",
          },
        });

        assert.strictEqual(activeSubs.length, 1);
        assert.strictEqual(activeSubs[0]!.userId, user1.id);
      });
    });

    // --- Free roast tracking ---

    describe("free roast tracking", () => {
      it("should track free roasts used this month", async () => {
        const user = await createTestUser({ name: "Roast Track Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "FREE");

        const updated = await db.subscription.update({
          where: { id: sub.id },
          data: {
            freeRoastsUsedThisMonth: 1,
            freeRoastsResetAt: new Date(
              new Date().getFullYear(),
              new Date().getMonth() + 1,
              1
            ),
          },
        });

        assert.strictEqual(updated.freeRoastsUsedThisMonth, 1);
        assert.ok(updated.freeRoastsResetAt, "Reset date should be set");
      });
    });

    // --- Payment reference ---

    describe("payment reference", () => {
      it("should store Dodo customer and subscription IDs", async () => {
        const user = await createTestUser({ name: "Dodo Ref Test" });
        createdUserIds.push(user.id);

        const sub = await createTestSubscription(user.id, "PREMIUM");

        const updated = await db.subscription.update({
          where: { id: sub.id },
          data: {
            dodoCustomerId: "cust_test_123",
            dodoSubscriptionId: "sub_test_456",
          },
        });

        assert.strictEqual(updated.dodoCustomerId, "cust_test_123");
        assert.strictEqual(updated.dodoSubscriptionId, "sub_test_456");
      });
    });
  });
}
