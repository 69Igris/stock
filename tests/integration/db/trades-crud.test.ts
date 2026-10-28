/**
 * Integration Tests: Trades CRUD Operations
 *
 * Tests trade creation, pagination, filtering, ordering, and deletion
 * against the QA MongoDB.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";

if (!process.env.RUN_INTEGRATION_TESTS) {
  describe("Integration: Trades CRUD (skipped)", () => {
    it("skipped - set RUN_INTEGRATION_TESTS=true to run", () => {
      assert.ok(true, "Skipped");
    });
  });
} else {
  let db: PrismaClient;
  let createTestUser: typeof import("../helpers.js").createTestUser;
  let createTestTrade: typeof import("../helpers.js").createTestTrade;
  let cleanupTestUser: typeof import("../helpers.js").cleanupTestUser;

  const createdUserIds: string[] = [];

  describe("Integration: Trades CRUD", () => {
    before(async () => {
      const setupMod = await import("../setup.js");
      await import("../teardown.js");
      const helpersMod = await import("../helpers.js");
      db = setupMod.db;
      createTestUser = helpersMod.createTestUser;
      createTestTrade = helpersMod.createTestTrade;
      cleanupTestUser = helpersMod.cleanupTestUser;
    });

    after(async () => {
      for (const userId of createdUserIds) {
        await cleanupTestUser(userId);
      }
    });

    // --- Create ---

    describe("create trades", () => {
      it("should create a trade with default values", async () => {
        const user = await createTestUser({ name: "Trade Create Test" });
        createdUserIds.push(user.id);

        const trade = await createTestTrade(user.id);

        assert.ok(trade.id, "Trade should have an id");
        assert.strictEqual(trade.userId, user.id);
        assert.strictEqual(trade.symbol, "RELIANCE");
        assert.strictEqual(trade.tradeType, "BUY");
        assert.strictEqual(trade.quantity, 10);
        assert.strictEqual(trade.sourceType, "MANUAL");
      });

      it("should create a SELL trade", async () => {
        const user = await createTestUser({ name: "Sell Trade Test" });
        createdUserIds.push(user.id);

        const trade = await createTestTrade(user.id, {
          tradeType: "SELL",
          symbol: "TCS",
          quantity: 5,
          price: 3800,
        });

        assert.strictEqual(trade.tradeType, "SELL");
        assert.strictEqual(trade.symbol, "TCS");
        assert.strictEqual(trade.quantity, 5);
      });

      it("should create a trade with broker reference", async () => {
        const user = await createTestUser({ name: "Broker Trade Test" });
        createdUserIds.push(user.id);

        const trade = await createTestTrade(user.id, {
          broker: "ZERODHA",
          brokerUserId: "ZT001",
          brokerTradeId: `BT_${Date.now()}`,
          sourceType: "SYNCED",
        });

        assert.strictEqual(trade.broker, "ZERODHA");
        assert.strictEqual(trade.brokerUserId, "ZT001");
        assert.strictEqual(trade.sourceType, "SYNCED");
      });

      it("should create a trade with F&O segment", async () => {
        const user = await createTestUser({ name: "FnO Trade Test" });
        createdUserIds.push(user.id);

        const trade = await createTestTrade(user.id, {
          symbol: "NIFTY24MARFUT",
          segment: "FO",
          productType: "NRML",
          exchange: "NFO",
        });

        assert.strictEqual(trade.segment, "FO");
        assert.strictEqual(trade.productType, "NRML");
        assert.strictEqual(trade.exchange, "NFO");
      });

      it("should create trade with charges breakdown", async () => {
        const user = await createTestUser({ name: "Charges Trade Test" });
        createdUserIds.push(user.id);

        const trade = await createTestTrade(user.id, {
          brokerage: 20,
          exchangeFee: 3.5,
          gst: 4.23,
          sebiCharges: 0.25,
          stampDuty: 1.5,
          totalCharges: 29.48,
        });

        assert.strictEqual(trade.brokerage, 20);
        assert.strictEqual(trade.exchangeFee, 3.5);
        assert.strictEqual(trade.gst, 4.23);
        assert.strictEqual(trade.totalCharges, 29.48);
      });
    });

    // --- Pagination ---

    describe("pagination (skip/limit)", () => {
      let paginationUserId: string;

      before(async () => {
        const user = await createTestUser({ name: "Pagination Test User" });
        paginationUserId = user.id;
        createdUserIds.push(paginationUserId);

        const trades = [];
        for (let i = 0; i < 15; i++) {
          const date = new Date(2024, 0, i + 1);
          trades.push(
            createTestTrade(paginationUserId, {
              symbol: `STOCK${String(i).padStart(2, "0")}`,
              tradeDate: date,
            })
          );
        }
        await Promise.all(trades);
      });

      it("should return first page (skip=0, limit=5)", async () => {
        const trades = await db.trade.findMany({
          where: { userId: paginationUserId },
          orderBy: { tradeDate: "desc" },
          skip: 0,
          take: 5,
        });

        assert.strictEqual(trades.length, 5);
      });

      it("should return second page (skip=5, limit=5)", async () => {
        const trades = await db.trade.findMany({
          where: { userId: paginationUserId },
          orderBy: { tradeDate: "desc" },
          skip: 5,
          take: 5,
        });

        assert.strictEqual(trades.length, 5);
      });

      it("should return remaining items on last page", async () => {
        const trades = await db.trade.findMany({
          where: { userId: paginationUserId },
          orderBy: { tradeDate: "desc" },
          skip: 10,
          take: 10,
        });

        assert.strictEqual(trades.length, 5);
      });

      it("should return empty array when skip exceeds total", async () => {
        const trades = await db.trade.findMany({
          where: { userId: paginationUserId },
          orderBy: { tradeDate: "desc" },
          skip: 100,
          take: 5,
        });

        assert.strictEqual(trades.length, 0);
      });

      it("should get total count alongside pagination", async () => {
        const [trades, total] = await Promise.all([
          db.trade.findMany({
            where: { userId: paginationUserId },
            orderBy: { tradeDate: "desc" },
            skip: 0,
            take: 5,
          }),
          db.trade.count({ where: { userId: paginationUserId } }),
        ]);

        assert.strictEqual(trades.length, 5);
        assert.strictEqual(total, 15);
      });
    });

    // --- Filtering ---

    describe("filter trades", () => {
      let filterUserId: string;

      before(async () => {
        const user = await createTestUser({ name: "Filter Trades User" });
        filterUserId = user.id;
        createdUserIds.push(filterUserId);

        await Promise.all([
          createTestTrade(filterUserId, {
            symbol: "RELIANCE",
            tradeType: "BUY",
            broker: "ZERODHA",
            brokerUserId: "ZF001",
            sourceType: "SYNCED",
          }),
          createTestTrade(filterUserId, {
            symbol: "RELIANCE",
            tradeType: "SELL",
            broker: "ZERODHA",
            brokerUserId: "ZF001",
            sourceType: "SYNCED",
          }),
          createTestTrade(filterUserId, {
            symbol: "TCS",
            tradeType: "BUY",
            broker: "UPSTOX",
            brokerUserId: "UF001",
            sourceType: "SYNCED",
          }),
          createTestTrade(filterUserId, {
            symbol: "INFY",
            tradeType: "BUY",
            broker: "ZERODHA",
            brokerUserId: "ZF001",
            sourceType: "MANUAL",
          }),
          createTestTrade(filterUserId, {
            symbol: "WIPRO",
            tradeType: "BUY",
            sourceType: "IMPORTED",
            importBatchId: "batch_test_001",
          }),
        ]);
      });

      it("should filter by symbol", async () => {
        const trades = await db.trade.findMany({
          where: { userId: filterUserId, symbol: "RELIANCE" },
        });
        assert.strictEqual(trades.length, 2);
      });

      it("should filter by broker", async () => {
        const trades = await db.trade.findMany({
          where: { userId: filterUserId, broker: "ZERODHA" },
        });
        assert.strictEqual(trades.length, 3);
      });

      it("should filter by tradeType", async () => {
        const trades = await db.trade.findMany({
          where: { userId: filterUserId, tradeType: "SELL" },
        });
        assert.strictEqual(trades.length, 1);
        assert.strictEqual(trades[0]!.symbol, "RELIANCE");
      });

      it("should filter by sourceType", async () => {
        const trades = await db.trade.findMany({
          where: { userId: filterUserId, sourceType: "MANUAL" },
        });
        assert.strictEqual(trades.length, 1);
        assert.strictEqual(trades[0]!.symbol, "INFY");
      });

      it("should combine multiple filters", async () => {
        const trades = await db.trade.findMany({
          where: {
            userId: filterUserId,
            symbol: "RELIANCE",
            tradeType: "BUY",
          },
        });
        assert.strictEqual(trades.length, 1);
      });

      it("should filter by importBatchId", async () => {
        const trades = await db.trade.findMany({
          where: { userId: filterUserId, importBatchId: "batch_test_001" },
        });
        assert.strictEqual(trades.length, 1);
        assert.strictEqual(trades[0]!.symbol, "WIPRO");
      });
    });

    // --- Ordering ---

    describe("ordering", () => {
      let orderUserId: string;

      before(async () => {
        const user = await createTestUser({ name: "Order Trades User" });
        orderUserId = user.id;
        createdUserIds.push(orderUserId);

        await Promise.all([
          createTestTrade(orderUserId, {
            symbol: "EARLY",
            tradeDate: new Date("2024-01-01"),
          }),
          createTestTrade(orderUserId, {
            symbol: "MIDDLE",
            tradeDate: new Date("2024-06-15"),
          }),
          createTestTrade(orderUserId, {
            symbol: "LATE",
            tradeDate: new Date("2024-12-31"),
          }),
        ]);
      });

      it("should order by tradeDate descending", async () => {
        const trades = await db.trade.findMany({
          where: { userId: orderUserId },
          orderBy: { tradeDate: "desc" },
        });

        assert.strictEqual(trades[0]!.symbol, "LATE");
        assert.strictEqual(trades[1]!.symbol, "MIDDLE");
        assert.strictEqual(trades[2]!.symbol, "EARLY");
      });

      it("should order by tradeDate ascending", async () => {
        const trades = await db.trade.findMany({
          where: { userId: orderUserId },
          orderBy: { tradeDate: "asc" },
        });

        assert.strictEqual(trades[0]!.symbol, "EARLY");
        assert.strictEqual(trades[2]!.symbol, "LATE");
      });
    });

    // --- Delete ---

    describe("delete trades", () => {
      it("should delete a single trade", async () => {
        const user = await createTestUser({ name: "Delete Trade Test" });
        createdUserIds.push(user.id);

        const trade = await createTestTrade(user.id);
        await db.trade.delete({ where: { id: trade.id } });

        const found = await db.trade.findUnique({ where: { id: trade.id } });
        assert.strictEqual(found, null);
      });

      it("should delete all trades for a user", async () => {
        const user = await createTestUser({ name: "Delete All Trades" });
        createdUserIds.push(user.id);

        await Promise.all([
          createTestTrade(user.id, { symbol: "A" }),
          createTestTrade(user.id, { symbol: "B" }),
          createTestTrade(user.id, { symbol: "C" }),
        ]);

        const result = await db.trade.deleteMany({ where: { userId: user.id } });
        assert.strictEqual(result.count, 3);
      });

      it("should delete trades by importBatchId", async () => {
        const user = await createTestUser({ name: "Delete Batch Trades" });
        createdUserIds.push(user.id);
        const batchId = `test_batch_${Date.now()}`;

        await Promise.all([
          createTestTrade(user.id, { symbol: "X", importBatchId: batchId }),
          createTestTrade(user.id, { symbol: "Y", importBatchId: batchId }),
          createTestTrade(user.id, { symbol: "Z" }),
        ]);

        const result = await db.trade.deleteMany({
          where: { userId: user.id, importBatchId: batchId },
        });
        assert.strictEqual(result.count, 2);

        const remaining = await db.trade.findMany({
          where: { userId: user.id },
        });
        assert.strictEqual(remaining.length, 1);
        assert.strictEqual(remaining[0]!.symbol, "Z");
      });
    });
  });
}
