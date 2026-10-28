/**
 * Integration Tests: Holdings CRUD Operations
 *
 * Tests holding creation, bulk upsert, querying, filtering, and deletion
 * against the QA MongoDB.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

if (!process.env.RUN_INTEGRATION_TESTS) {
  describe("Integration: Holdings CRUD (skipped)", () => {
    it("skipped - set RUN_INTEGRATION_TESTS=true to run", () => {
      assert.ok(true, "Skipped");
    });
  });
} else {
  let db: PrismaClient;
  let createTestUser: typeof import("../helpers.js").createTestUser;
  let createTestHolding: typeof import("../helpers.js").createTestHolding;
  let cleanupTestUser: typeof import("../helpers.js").cleanupTestUser;

  let testUserId: string;
  const createdUserIds: string[] = [];

  describe("Integration: Holdings CRUD", () => {
    before(async () => {
      const setupMod = await import("../setup.js");
      await import("../teardown.js");
      const helpersMod = await import("../helpers.js");
      db = setupMod.db;
      createTestUser = helpersMod.createTestUser;
      createTestHolding = helpersMod.createTestHolding;
      cleanupTestUser = helpersMod.cleanupTestUser;

      const user = await createTestUser({ name: "Holdings Test User" });
      testUserId = user.id;
      createdUserIds.push(testUserId);
    });

    after(async () => {
      for (const userId of createdUserIds) {
        await cleanupTestUser(userId);
      }
    });

    // --- Create ---

    describe("create holdings", () => {
      it("should create a holding with default values", async () => {
        const holding = await createTestHolding(testUserId);

        assert.ok(holding.id, "Holding should have an id");
        assert.strictEqual(holding.userId, testUserId);
        assert.strictEqual(holding.symbol, "RELIANCE");
        assert.strictEqual(holding.exchange, "NSE");
        assert.strictEqual(holding.quantity, 10);
      });

      it("should create a holding with custom overrides", async () => {
        const holding = await createTestHolding(testUserId, {
          symbol: "TCS",
          exchange: "BSE",
          quantity: 25,
          averagePrice: 3500,
          currentPrice: 3600,
          investedValue: 87500,
          currentValue: 90000,
          unrealizedPnL: 2500,
          pnlPercentage: 2.86,
        });

        assert.strictEqual(holding.symbol, "TCS");
        assert.strictEqual(holding.exchange, "BSE");
        assert.strictEqual(holding.quantity, 25);
        assert.strictEqual(holding.averagePrice, 3500);
      });

      it("should create a holding with broker info", async () => {
        const holding = await createTestHolding(testUserId, {
          symbol: "INFY",
          broker: "ZERODHA",
          brokerUserId: "AB1234",
        });

        assert.strictEqual(holding.broker, "ZERODHA");
        assert.strictEqual(holding.brokerUserId, "AB1234");
      });

      it("should create a holding with sector info", async () => {
        const holding = await createTestHolding(testUserId, {
          symbol: "HDFCBANK",
          sector: "Financial Services",
        });

        assert.strictEqual(holding.sector, "Financial Services");
      });
    });

    // --- Bulk Upsert ---

    describe("bulk upsert holdings", () => {
      it("should upsert new holdings via createMany", async () => {
        const user2 = await createTestUser({ name: "Upsert Test" });
        createdUserIds.push(user2.id);

        const holdings = [
          {
            userId: user2.id,
            symbol: "SBIN",
            exchange: "NSE",
            quantity: 100,
            averagePrice: 600,
            currentPrice: 620,
            investedValue: 60000,
            currentValue: 62000,
            unrealizedPnL: 2000,
            pnlPercentage: 3.33,
            dayChange: 10,
            dayChangePerc: 1.64,
          },
          {
            userId: user2.id,
            symbol: "ICICIBANK",
            exchange: "NSE",
            quantity: 50,
            averagePrice: 1000,
            currentPrice: 1050,
            investedValue: 50000,
            currentValue: 52500,
            unrealizedPnL: 2500,
            pnlPercentage: 5.0,
            dayChange: 15,
            dayChangePerc: 1.45,
          },
        ];

        const result = await db.holding.createMany({ data: holdings });
        assert.strictEqual(result.count, 2, "Should create 2 holdings");

        const found = await db.holding.findMany({ where: { userId: user2.id } });
        assert.strictEqual(found.length, 2);
      });

      it("should update existing holding via update", async () => {
        const user3 = await createTestUser({ name: "Upsert Update Test" });
        createdUserIds.push(user3.id);

        const initial = await createTestHolding(user3.id, {
          symbol: "TATAMOTORS",
          exchange: "NSE",
          broker: "ZERODHA",
          brokerUserId: "XY9999",
          quantity: 50,
          averagePrice: 700,
          currentPrice: 720,
          investedValue: 35000,
          currentValue: 36000,
          unrealizedPnL: 1000,
          pnlPercentage: 2.86,
        });

        const upserted = await db.holding.update({
          where: { id: initial.id },
          data: {
            currentPrice: 750,
            currentValue: 37500,
            unrealizedPnL: 2500,
            pnlPercentage: 7.14,
          },
        });

        assert.strictEqual(upserted.currentPrice, 750);
        assert.strictEqual(upserted.currentValue, 37500);
        assert.strictEqual(upserted.unrealizedPnL, 2500);
        assert.strictEqual(upserted.quantity, 50);
        assert.strictEqual(upserted.averagePrice, 700);
      });
    });

    // --- Query / Filter ---

    describe("query holdings", () => {
      let queryUserId: string;

      before(async () => {
        const user = await createTestUser({ name: "Query Holdings User" });
        queryUserId = user.id;
        createdUserIds.push(queryUserId);

        await Promise.all([
          createTestHolding(queryUserId, {
            symbol: "RELIANCE",
            exchange: "NSE",
            broker: "ZERODHA",
            brokerUserId: "ZR001",
            sector: "Energy",
          }),
          createTestHolding(queryUserId, {
            symbol: "TCS",
            exchange: "NSE",
            broker: "UPSTOX",
            brokerUserId: "UP001",
            sector: "IT",
          }),
          createTestHolding(queryUserId, {
            symbol: "HDFCBANK",
            exchange: "BSE",
            broker: "ZERODHA",
            brokerUserId: "ZR001",
            sector: "Financial Services",
          }),
          createTestHolding(queryUserId, {
            symbol: "INFY",
            exchange: "NSE",
            broker: "UPSTOX",
            brokerUserId: "UP001",
            sector: "IT",
          }),
          createTestHolding(queryUserId, {
            symbol: "WIPRO",
            exchange: "BSE",
            broker: "DHAN",
            brokerUserId: "DH001",
            sector: "IT",
          }),
        ]);
      });

      it("should find all holdings for a user", async () => {
        const holdings = await db.holding.findMany({
          where: { userId: queryUserId },
        });
        assert.strictEqual(holdings.length, 5);
      });

      it("should filter holdings by broker", async () => {
        const holdings = await db.holding.findMany({
          where: { userId: queryUserId, broker: "ZERODHA" },
        });
        assert.strictEqual(holdings.length, 2);
        assert.ok(holdings.every((h) => h.broker === "ZERODHA"));
      });

      it("should filter holdings by exchange", async () => {
        const holdings = await db.holding.findMany({
          where: { userId: queryUserId, exchange: "BSE" },
        });
        assert.strictEqual(holdings.length, 2);
        assert.ok(holdings.every((h) => h.exchange === "BSE"));
      });

      it("should filter holdings by sector", async () => {
        const holdings = await db.holding.findMany({
          where: { userId: queryUserId, sector: "IT" },
        });
        assert.strictEqual(holdings.length, 3);
        assert.ok(holdings.every((h) => h.sector === "IT"));
      });

      it("should filter by broker AND exchange combined", async () => {
        const holdings = await db.holding.findMany({
          where: {
            userId: queryUserId,
            broker: "UPSTOX",
            exchange: "NSE",
          },
        });
        assert.strictEqual(holdings.length, 2);
      });

      it("should return empty array for non-matching filter", async () => {
        const holdings = await db.holding.findMany({
          where: {
            userId: queryUserId,
            broker: "ANGEL_ONE",
          },
        });
        assert.strictEqual(holdings.length, 0);
      });
    });

    // --- Delete ---

    describe("delete holdings", () => {
      it("should delete a single holding by id", async () => {
        const user = await createTestUser({ name: "Delete Holding Test" });
        createdUserIds.push(user.id);

        const holding = await createTestHolding(user.id);
        await db.holding.delete({ where: { id: holding.id } });

        const found = await db.holding.findUnique({ where: { id: holding.id } });
        assert.strictEqual(found, null);
      });

      it("should delete all holdings for a user", async () => {
        const user = await createTestUser({ name: "Delete All Holdings" });
        createdUserIds.push(user.id);

        await Promise.all([
          createTestHolding(user.id, { symbol: "A" }),
          createTestHolding(user.id, { symbol: "B" }),
          createTestHolding(user.id, { symbol: "C" }),
        ]);

        const result = await db.holding.deleteMany({ where: { userId: user.id } });
        assert.strictEqual(result.count, 3);
      });

      it("should not affect other users when deleting", async () => {
        const user1 = await createTestUser({ name: "Delete Isolation 1" });
        const user2 = await createTestUser({ name: "Delete Isolation 2" });
        createdUserIds.push(user1.id, user2.id);

        await createTestHolding(user1.id, { symbol: "X" });
        await createTestHolding(user2.id, { symbol: "Y" });

        await db.holding.deleteMany({ where: { userId: user1.id } });

        const user2Holdings = await db.holding.findMany({
          where: { userId: user2.id },
        });
        assert.strictEqual(user2Holdings.length, 1, "User2 holdings should be untouched");
      });
    });

    // --- Deduplication (unique constraint) ---

    describe("deduplication", () => {
      it("should enforce unique constraint on userId+broker+brokerUserId+symbol+exchange", async () => {
        const user = await createTestUser({ name: "Dedup Test" });
        createdUserIds.push(user.id);

        await createTestHolding(user.id, {
          symbol: "DEDUP",
          exchange: "NSE",
          broker: "ZERODHA",
          brokerUserId: "DD001",
        });

        await assert.rejects(
          () =>
            createTestHolding(user.id, {
              symbol: "DEDUP",
              exchange: "NSE",
              broker: "ZERODHA",
              brokerUserId: "DD001",
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

      it("should allow same symbol from different brokers", async () => {
        const user = await createTestUser({ name: "Multi Broker Holding" });
        createdUserIds.push(user.id);

        const h1 = await createTestHolding(user.id, {
          symbol: "SAMESTOCK",
          exchange: "NSE",
          broker: "ZERODHA",
          brokerUserId: "Z001",
        });
        const h2 = await createTestHolding(user.id, {
          symbol: "SAMESTOCK",
          exchange: "NSE",
          broker: "UPSTOX",
          brokerUserId: "U001",
        });

        assert.notStrictEqual(h1.id, h2.id);
      });
    });
  });
}
