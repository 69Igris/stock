/**
 * Worker Pairing Processor Tests (workers/src/processors/pairing.ts) — DE-SHADOWED.
 *
 * The previous version of this file SHADOWED the worker processor: it declared
 * a local `async function processPairing` "(mirrors workers/src/processors/
 * pairing.ts)" AND re-implemented the price/ISIN derivation inline, asserting
 * the COPY. The copy was lenient (`price || 0` lets Infinity leak; a non-finite
 * `tradeValue/quantity` ratio flowed straight through), so it stayed green even
 * though the real worker could persist a non-finite price into realizedPnL.
 *
 * This rewrite:
 *  1. Asserts the REAL exported derivation helpers from
 *     `workers/src/processors/pairing-logic.ts` (which `pairing.ts` now CALLS).
 *  2. Drives an orchestration harness whose trade→input mapping and ISIN
 *     dedup-set are built by calling those SAME real exports — so every
 *     derivation assertion runs production code (the processor itself imports
 *     Prisma + clearTradeCache + createNotification at module load, so it can't
 *     be imported into a pure unit test; the harness mirrors only the prisma
 *     call SEQUENCE, never the derivation logic).
 *  3. Runs the REAL `pairTradesFIFO` from @usemoney/core/pairing end-to-end for
 *     partial-fill / oversell / cross-broker+symbol isolation / single / BUY-
 *     only / SELL-only / identical-timestamp (stable order) cases.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// REAL worker derivation under test (no shadow). pairing.ts CALLS these.
import {
  derivePairingPrice,
  deriveEffectiveIsin,
} from "../../../../workers/src/processors/pairing-logic";

// REAL FIFO algorithm — drives true partial-fill / oversell / isolation paths.
import {
  pairTradesFIFO,
  type TradeInput,
  type PairingResult as CorePairingResult,
} from "@usemoney/core/pairing";

// ── Mock infrastructure (prisma call recorder only — NOT logic) ──────

interface PrismaCall {
  model: string;
  method: string;
  args: unknown;
}

let prismaCalls: PrismaCall[] = [];

interface MockTrade {
  id: string;
  userId: string;
  symbol: string;
  isin: string | null;
  tradingSymbol: string | null;
  exchange: string;
  segment: string;
  broker: string | null;
  brokerUserId: string | null;
  tradeType: string;
  positionType: string;
  productType: string;
  quantity: number;
  price: number | null;
  averagePrice: number | null;
  tradeValue: number | null;
  tradeDate: Date;
  tradeTime: Date | null;
  sourceType: string;
  needsRepairing: boolean;
}

interface TradeInputForPairing {
  id: string;
  userId: string;
  symbol: string;
  isin: string | null;
  exchange: string;
  segment: string;
  broker: string | null;
  brokerUserId: string | null;
  tradeType: string;
  positionType: string;
  productType: string;
  quantity: number;
  price: number;
  tradeDate: Date;
  tradeTime: Date | null;
  sourceType: string;
  segmentLabel: null;
  productTypeLabel: null;
}

interface PairedTradeOutput {
  userId: string;
  sourceTradeIds: string[];
  entryTradeId: string | null;
  exitTradeId: string | null;
  symbol: string;
  isin: string | null;
  exchange: string;
  segment: string;
  broker: string | null;
  brokerUserId: string | null;
  entryDate: Date;
  entryPrice: number;
  entryQuantity: number;
  exitDate: Date | null;
  exitPrice: number | null;
  quantity: number;
  realizedPnL: number | null;
  pnlPercentage: number | null;
  status: string;
  positionType: string;
  productType: string;
  sourceType: string;
  tradeType: string;
  segmentLabel: string | null;
  productTypeLabel: string | null;
}

interface PairingStats {
  totalTrades: number;
  openPositions: number;
  closedPositions: number;
  partialPositions: number;
  totalRealizedPnL: number;
}

interface PairingResult {
  pairedViews: PairedTradeOutput[];
  stats: PairingStats;
}

interface PairingJobMessage {
  jobId: string;
  userId: string;
  batchId?: string;
}

/** Configurable mock return values for trade.findMany */
let mockTrades: MockTrade[] = [];

/** Configurable mock return for the FIFO call (orchestration tests). */
let mockPairingResult: PairingResult = emptyResult();

/** Trade inputs captured from the harness (built by the REAL derivation). */
let pairTradesFIFOCalls: TradeInputForPairing[][] = [];

function emptyResult(): PairingResult {
  return {
    pairedViews: [],
    stats: {
      totalTrades: 0,
      openPositions: 0,
      closedPositions: 0,
      partialPositions: 0,
      totalRealizedPnL: 0,
    },
  };
}

function createMockPrisma() {
  return {
    backgroundJob: {
      updateMany: async (args: unknown) => {
        prismaCalls.push({
          model: "backgroundJob",
          method: "updateMany",
          args,
        });
        return { count: 1 };
      },
    },
    trade: {
      findMany: async (args: unknown) => {
        prismaCalls.push({ model: "trade", method: "findMany", args });
        return mockTrades;
      },
      updateMany: async (args: unknown) => {
        prismaCalls.push({ model: "trade", method: "updateMany", args });
        return { count: mockTrades.length };
      },
    },
    pairedTradeView: {
      deleteMany: async (args: unknown) => {
        prismaCalls.push({
          model: "pairedTradeView",
          method: "deleteMany",
          args,
        });
        return { count: 0 };
      },
      createMany: async (args: unknown) => {
        prismaCalls.push({
          model: "pairedTradeView",
          method: "createMany",
          args,
        });
        return { count: 0 };
      },
    },
  };
}

/** Mock FIFO for the orchestration tests (records the harness-built inputs). */
function fakePairTradesFIFO(trades: TradeInputForPairing[]): PairingResult {
  pairTradesFIFOCalls.push(trades);
  return mockPairingResult;
}

/**
 * Orchestration harness mirroring `processPairing`'s prisma call SEQUENCE.
 *
 * IMPORTANT: the trade→input mapping and the ISIN dedup-set are built by
 * calling the REAL `derivePairingPrice` / `deriveEffectiveIsin` exports — the
 * exact functions the production processor calls — so all derivation
 * assertions exercise production code, not a copy.
 */
async function processPairing(
  data: PairingJobMessage,
  prisma: ReturnType<typeof createMockPrisma>
): Promise<void> {
  const { jobId, userId, batchId: inputBatchId } = data;
  const batchId = inputBatchId || crypto.randomUUID();

  await prisma.backgroundJob.updateMany({
    where: { jobId },
    data: { status: "PROCESSING", startedAt: new Date() },
  });

  try {
    const where: Record<string, unknown> = { userId, needsRepairing: true };
    const trades = (await prisma.trade.findMany({
      where,
      orderBy: [{ tradeDate: "asc" }, { tradeTime: "asc" }],
    })) as MockTrade[];

    if (trades.length === 0) {
      await prisma.backgroundJob.updateMany({
        where: { jobId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          progress: 100,
          result: {
            success: true,
            tradesProcessed: 0,
            openPositions: 0,
            closedPositions: 0,
          },
        },
      });
      return;
    }

    // Real derivation (production exports) — no inline copy.
    const tradeInputs = trades.map((t) => ({
      id: t.id,
      userId: t.userId,
      symbol: t.symbol,
      isin: deriveEffectiveIsin(t),
      exchange: t.exchange,
      segment: t.segment,
      broker: t.broker,
      brokerUserId: t.brokerUserId,
      tradeType: t.tradeType,
      positionType: t.positionType,
      productType: t.productType,
      quantity: t.quantity,
      price: derivePairingPrice(t),
      tradeDate: t.tradeDate,
      tradeTime: t.tradeTime,
      sourceType: t.sourceType,
      segmentLabel: null,
      productTypeLabel: null,
    }));

    const result = fakePairTradesFIFO(tradeInputs);

    const symbols = Array.from(new Set(trades.map((t) => t.symbol)));
    const isins = Array.from(
      new Set(trades.map((t) => deriveEffectiveIsin(t)).filter(Boolean))
    ) as string[];

    await prisma.pairedTradeView.deleteMany({
      where: {
        userId,
        OR: [
          { symbol: { in: symbols } },
          ...(isins.length > 0 ? [{ isin: { in: isins } }] : []),
        ],
      },
    });

    if (result.pairedViews.length > 0) {
      await prisma.pairedTradeView.createMany({
        data: result.pairedViews.map((view) => ({
          userId: view.userId,
          sourceTradeIds: view.sourceTradeIds,
          entryTradeId: view.entryTradeId,
          exitTradeId: view.exitTradeId,
          symbol: view.symbol,
          isin: view.isin,
          exchange: view.exchange,
          segment: view.segment,
          broker: view.broker,
          brokerUserId: view.brokerUserId,
          entryDate: view.entryDate,
          entryPrice: view.entryPrice,
          entryQuantity: view.entryQuantity,
          exitDate: view.exitDate,
          exitPrice: view.exitPrice,
          quantity: view.quantity,
          realizedPnL: view.realizedPnL,
          pnlPercentage: view.pnlPercentage,
          status: view.status,
          positionType: view.positionType,
          productType: view.productType,
          sourceType: view.sourceType,
          tradeType: view.tradeType,
          segmentLabel: view.segmentLabel,
          productTypeLabel: view.productTypeLabel,
          pairingBatchId: batchId,
        })),
      });
    }

    const tradeIds = trades.map((t) => t.id);
    await prisma.trade.updateMany({
      where: { id: { in: tradeIds } },
      data: { needsRepairing: false },
    });

    await prisma.backgroundJob.updateMany({
      where: { jobId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        progress: 100,
        result: {
          success: true,
          tradesProcessed: trades.length,
          pairedViewsCreated: result.pairedViews.length,
          openPositions: result.stats.openPositions,
          closedPositions: result.stats.closedPositions,
          partialPositions: result.stats.partialPositions,
          totalRealizedPnL: result.stats.totalRealizedPnL,
        },
      },
    });
  } catch (error) {
    await prisma.backgroundJob.updateMany({
      where: { jobId },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
    });
    throw error;
  }
}

// ── Test helpers ─────────────────────────────────────────────────────

function findCalls(model: string, method: string): PrismaCall[] {
  return prismaCalls.filter((c) => c.model === model && c.method === method);
}

function getStatus(call: PrismaCall): string | undefined {
  const args = call.args as { data?: { status?: string } };
  return args?.data?.status;
}

function makeTrade(overrides: Partial<MockTrade> = {}): MockTrade {
  return {
    id: "trade-1",
    userId: "user-1",
    symbol: "RELIANCE",
    isin: null,
    tradingSymbol: null,
    exchange: "NSE",
    segment: "EQ",
    broker: "ZERODHA",
    brokerUserId: "AB1234",
    tradeType: "BUY",
    positionType: "LONG",
    productType: "CNC",
    quantity: 10,
    price: 2500,
    averagePrice: null,
    tradeValue: null,
    tradeDate: new Date("2025-01-15"),
    tradeTime: new Date("2025-01-15T10:30:00Z"),
    sourceType: "SYNCED",
    needsRepairing: true,
    ...overrides,
  };
}

function makePairedView(
  overrides: Partial<PairedTradeOutput> = {}
): PairedTradeOutput {
  return {
    userId: "user-1",
    sourceTradeIds: ["trade-1", "trade-2"],
    entryTradeId: "trade-1",
    exitTradeId: "trade-2",
    symbol: "RELIANCE",
    isin: null,
    exchange: "NSE",
    segment: "EQ",
    broker: "ZERODHA",
    brokerUserId: "AB1234",
    entryDate: new Date("2025-01-15"),
    entryPrice: 2500,
    entryQuantity: 10,
    exitDate: new Date("2025-02-01"),
    exitPrice: 2700,
    quantity: 10,
    realizedPnL: 2000,
    pnlPercentage: 8.0,
    status: "CLOSED",
    positionType: "LONG",
    productType: "CNC",
    sourceType: "SYNCED",
    tradeType: "BUY",
    segmentLabel: null,
    productTypeLabel: null,
    ...overrides,
  };
}

/** Build a core `TradeInput` for the real `pairTradesFIFO` integration tests. */
function makeInput(overrides: Partial<TradeInput> = {}): TradeInput {
  return {
    id: "in-1",
    userId: "user-1",
    symbol: "RELIANCE",
    isin: null,
    exchange: "NSE",
    segment: "EQ",
    broker: null,
    brokerUserId: null,
    tradeType: "BUY",
    positionType: "LONG",
    productType: "CNC",
    quantity: 10,
    price: 100,
    tradeDate: new Date("2025-01-15"),
    tradeTime: new Date("2025-01-15T10:00:00Z"),
    sourceType: "SYNCED",
    segmentLabel: null,
    productTypeLabel: null,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Workers - Processor: Pairing (orchestration via real derivation)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prismaCalls = [];
    pairTradesFIFOCalls = [];
    mockTrades = [];
    mockPairingResult = emptyResult();
    prisma = createMockPrisma();
  });

  // ── Job status lifecycle ──────────────────────────────────────────

  describe("Job status lifecycle", () => {
    it("should set BackgroundJob status to PROCESSING on start", async () => {
      await processPairing({ jobId: "job-1", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      assert.ok(calls.length >= 1);
      assert.strictEqual(getStatus(calls[0]!), "PROCESSING");
    });

    it("should set startedAt timestamp on PROCESSING", async () => {
      const before = new Date();
      await processPairing({ jobId: "job-1", userId: "user-1" }, prisma);
      const after = new Date();
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[0]!.args as { data: { startedAt: Date } };
      assert.ok(args.data.startedAt >= before);
      assert.ok(args.data.startedAt <= after);
    });

    it("should set BackgroundJob status to COMPLETED when trades exist", async () => {
      mockTrades = [makeTrade()];
      await processPairing({ jobId: "job-2", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      assert.strictEqual(getStatus(calls[calls.length - 1]!), "COMPLETED");
    });

    it("should set progress=100 on COMPLETED", async () => {
      mockTrades = [makeTrade()];
      await processPairing({ jobId: "job-3", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { progress: number };
      };
      assert.strictEqual(args.data.progress, 100);
    });

    it("should set completedAt on COMPLETED", async () => {
      mockTrades = [makeTrade()];
      const before = new Date();
      await processPairing({ jobId: "job-4", userId: "user-1" }, prisma);
      const after = new Date();
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { completedAt: Date };
      };
      assert.ok(args.data.completedAt >= before);
      assert.ok(args.data.completedAt <= after);
    });

    it("should use correct jobId in all where clauses", async () => {
      mockTrades = [makeTrade()];
      await processPairing({ jobId: "test-job-id", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      for (const call of calls) {
        const args = call.args as { where: { jobId: string } };
        assert.strictEqual(args.where.jobId, "test-job-id");
      }
    });
  });

  // ── No-trades early exit path ──────────────────────────────────────

  describe("No-trades early exit path", () => {
    it("should complete immediately when no trades need pairing", async () => {
      mockTrades = [];
      await processPairing({ jobId: "job-empty", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(getStatus(calls[0]!), "PROCESSING");
      assert.strictEqual(getStatus(calls[1]!), "COMPLETED");
    });

    it("should store tradesProcessed=0 in result when no trades", async () => {
      mockTrades = [];
      await processPairing({ jobId: "job-empty-2", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[1]!.args as {
        data: { result: { tradesProcessed: number } };
      };
      assert.strictEqual(args.data.result.tradesProcessed, 0);
    });

    it("should store openPositions=0 and closedPositions=0 when no trades", async () => {
      mockTrades = [];
      await processPairing({ jobId: "job-empty-3", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[1]!.args as {
        data: {
          result: {
            success: boolean;
            tradesProcessed: number;
            openPositions: number;
            closedPositions: number;
          };
        };
      };
      assert.deepStrictEqual(args.data.result, {
        success: true,
        tradesProcessed: 0,
        openPositions: 0,
        closedPositions: 0,
      });
    });

    it("should NOT call pairTradesFIFO when no trades", async () => {
      mockTrades = [];
      await processPairing({ jobId: "job-empty-4", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls.length, 0);
    });

    it("should NOT call pairedTradeView.deleteMany when no trades", async () => {
      mockTrades = [];
      await processPairing({ jobId: "job-empty-5", userId: "user-1" }, prisma);
      assert.strictEqual(findCalls("pairedTradeView", "deleteMany").length, 0);
    });

    it("should NOT call trade.updateMany when no trades", async () => {
      mockTrades = [];
      await processPairing({ jobId: "job-empty-6", userId: "user-1" }, prisma);
      assert.strictEqual(findCalls("trade", "updateMany").length, 0);
    });
  });

  // ── Trade query ─────────────────────────────────────────────────────

  describe("Trade query", () => {
    it("should query trades with userId and needsRepairing=true", async () => {
      await processPairing({ jobId: "q-1", userId: "user-abc" }, prisma);
      const calls = findCalls("trade", "findMany");
      assert.strictEqual(calls.length, 1);
      const args = calls[0]!.args as {
        where: { userId: string; needsRepairing: boolean };
      };
      assert.strictEqual(args.where.userId, "user-abc");
      assert.strictEqual(args.where.needsRepairing, true);
    });

    it("should order trades by tradeDate asc, tradeTime asc", async () => {
      await processPairing({ jobId: "q-2", userId: "user-1" }, prisma);
      const calls = findCalls("trade", "findMany");
      const args = calls[0]!.args as { orderBy: Array<Record<string, string>> };
      assert.deepStrictEqual(args.orderBy, [
        { tradeDate: "asc" },
        { tradeTime: "asc" },
      ]);
    });
  });

  // ── Price fallback logic (asserts REAL derivePairingPrice) ─────────

  describe("Price fallback logic (real derivePairingPrice)", () => {
    it("should use trade.price when it is set and non-zero", async () => {
      mockTrades = [
        makeTrade({
          id: "t-price",
          price: 1500,
          tradeValue: 30000,
          quantity: 10,
          averagePrice: 1400,
        }),
      ];
      await processPairing({ jobId: "pf-1", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 1500);
    });

    it("should fall back to tradeValue/quantity when price is null", async () => {
      mockTrades = [
        makeTrade({ id: "t-tv", price: null, tradeValue: 25000, quantity: 10 }),
      ];
      await processPairing({ jobId: "pf-2", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 2500);
    });

    it("should fall back to tradeValue/quantity when price is 0", async () => {
      mockTrades = [
        makeTrade({ id: "t-zero", price: 0, tradeValue: 30000, quantity: 10 }),
      ];
      await processPairing({ jobId: "pf-3", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 3000);
    });

    it("should fall back to averagePrice when price=null and tradeValue=null", async () => {
      mockTrades = [
        makeTrade({
          id: "t-avg",
          price: null,
          tradeValue: null,
          quantity: 10,
          averagePrice: 1800,
        }),
      ];
      await processPairing({ jobId: "pf-4", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 1800);
    });

    it("should fall back to averagePrice when price=0, tradeValue=null", async () => {
      mockTrades = [
        makeTrade({
          id: "t-avg2",
          price: 0,
          tradeValue: null,
          quantity: 5,
          averagePrice: 900,
        }),
      ];
      await processPairing({ jobId: "pf-5", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 900);
    });

    it("should use 0 when all price sources are null", async () => {
      mockTrades = [
        makeTrade({
          id: "t-none",
          price: null,
          tradeValue: null,
          averagePrice: null,
        }),
      ];
      await processPairing({ jobId: "pf-6", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 0);
    });

    it("should not use tradeValue/quantity when quantity is 0", async () => {
      mockTrades = [
        makeTrade({
          id: "t-q0",
          price: null,
          tradeValue: 5000,
          quantity: 0,
          averagePrice: 200,
        }),
      ];
      await processPairing({ jobId: "pf-7", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 200);
    });

    it("should not use tradeValue/quantity when tradeValue is null", async () => {
      mockTrades = [
        makeTrade({
          id: "t-tvnull",
          price: 0,
          tradeValue: null,
          quantity: 10,
          averagePrice: 350,
        }),
      ];
      await processPairing({ jobId: "pf-8", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 350);
    });

    // ---- the bug the old shadow missed: non-finite leaks ----

    it("REGRESSION: Infinity tradeValue must NOT leak Infinity into the input price", async () => {
      mockTrades = [
        makeTrade({
          id: "t-inf",
          price: 0,
          tradeValue: Infinity,
          quantity: 2,
          averagePrice: 3,
        }),
      ];
      await processPairing({ jobId: "pf-inf", userId: "user-1" }, prisma);
      const p = pairTradesFIFOCalls[0]![0]!.price;
      assert.strictEqual(Number.isFinite(p), true);
      assert.strictEqual(p, 3);
    });

    it("REGRESSION: NaN stored price falls through to a finite derived price", async () => {
      mockTrades = [
        makeTrade({
          id: "t-nan",
          price: NaN,
          tradeValue: 200,
          quantity: 2,
        }),
      ];
      await processPairing({ jobId: "pf-nan", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 100);
    });
  });

  // ── MF ISIN derivation (asserts REAL deriveEffectiveIsin) ──────────

  describe("MF ISIN derivation from tradingSymbol (real deriveEffectiveIsin)", () => {
    it("should derive ISIN from tradingSymbol for MF segment when isin is null", async () => {
      mockTrades = [
        makeTrade({
          id: "t-mf1",
          segment: "MF",
          isin: null,
          tradingSymbol: "INF209K01YY8",
        }),
      ];
      await processPairing({ jobId: "mf-1", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.isin, "INF209K01YY8");
    });

    it("should NOT derive ISIN when isin is already set", async () => {
      mockTrades = [
        makeTrade({
          id: "t-mf2",
          segment: "MF",
          isin: "INF846K01EW2",
          tradingSymbol: "INF209K01YY8",
        }),
      ];
      await processPairing({ jobId: "mf-2", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.isin, "INF846K01EW2");
    });

    it("should NOT derive ISIN for non-MF segment", async () => {
      mockTrades = [
        makeTrade({
          id: "t-eq1",
          segment: "EQ",
          isin: null,
          tradingSymbol: "INF209K01YY8",
        }),
      ];
      await processPairing({ jobId: "mf-3", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.isin, null);
    });

    it("should NOT derive ISIN when tradingSymbol is null", async () => {
      mockTrades = [
        makeTrade({
          id: "t-mf3",
          segment: "MF",
          isin: null,
          tradingSymbol: null,
        }),
      ];
      await processPairing({ jobId: "mf-4", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.isin, null);
    });

    it("should NOT derive ISIN when tradingSymbol does not start with IN", async () => {
      mockTrades = [
        makeTrade({
          id: "t-mf4",
          segment: "MF",
          isin: null,
          tradingSymbol: "XYF209K01YY8",
        }),
      ];
      await processPairing({ jobId: "mf-5", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.isin, null);
    });

    it("should NOT derive ISIN when tradingSymbol is not 12 characters", async () => {
      mockTrades = [
        makeTrade({
          id: "t-mf5",
          segment: "MF",
          isin: null,
          tradingSymbol: "INF209K01",
        }),
      ];
      await processPairing({ jobId: "mf-6", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.isin, null);
    });

    it("should NOT derive ISIN when tradingSymbol has special characters", async () => {
      mockTrades = [
        makeTrade({
          id: "t-mf6",
          segment: "MF",
          isin: null,
          tradingSymbol: "INF209K01-Y8",
        }),
      ];
      await processPairing({ jobId: "mf-7", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.isin, null);
    });

    it("should uppercase tradingSymbol before ISIN validation", async () => {
      mockTrades = [
        makeTrade({
          id: "t-mf7",
          segment: "MF",
          isin: null,
          tradingSymbol: "inf209k01yy8",
        }),
      ];
      await processPairing({ jobId: "mf-8", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.isin, "INF209K01YY8");
    });
  });

  // ── Paired view deletion ──────────────────────────────────────────

  describe("Paired view deletion", () => {
    it("should delete existing paired views for affected symbols", async () => {
      mockTrades = [
        makeTrade({ id: "t1", symbol: "RELIANCE" }),
        makeTrade({ id: "t2", symbol: "TCS" }),
      ];
      await processPairing({ jobId: "del-1", userId: "user-1" }, prisma);
      const calls = findCalls("pairedTradeView", "deleteMany");
      assert.strictEqual(calls.length, 1);
      const args = calls[0]!.args as {
        where: {
          userId: string;
          OR: Array<{ symbol?: { in: string[] }; isin?: { in: string[] } }>;
        };
      };
      assert.strictEqual(args.where.userId, "user-1");
      assert.ok(args.where.OR[0]!.symbol!.in.includes("RELIANCE"));
      assert.ok(args.where.OR[0]!.symbol!.in.includes("TCS"));
    });

    it("should include ISINs in delete where clause when present", async () => {
      mockTrades = [
        makeTrade({ id: "t1", symbol: "RELIANCE", isin: "INE002A01018" }),
      ];
      await processPairing({ jobId: "del-2", userId: "user-1" }, prisma);
      const calls = findCalls("pairedTradeView", "deleteMany");
      const args = calls[0]!.args as {
        where: {
          OR: Array<{ symbol?: { in: string[] }; isin?: { in: string[] } }>;
        };
      };
      assert.strictEqual(args.where.OR.length, 2);
      assert.ok(args.where.OR[1]!.isin!.in.includes("INE002A01018"));
    });

    it("should NOT include ISIN clause in OR when no ISINs exist", async () => {
      mockTrades = [makeTrade({ id: "t1", symbol: "RELIANCE", isin: null })];
      await processPairing({ jobId: "del-3", userId: "user-1" }, prisma);
      const calls = findCalls("pairedTradeView", "deleteMany");
      const args = calls[0]!.args as {
        where: {
          OR: Array<{ symbol?: { in: string[] }; isin?: { in: string[] } }>;
        };
      };
      assert.strictEqual(args.where.OR.length, 1);
      assert.ok(args.where.OR[0]!.symbol);
    });

    it("should include MF-derived ISINs from tradingSymbol in delete clause", async () => {
      mockTrades = [
        makeTrade({
          id: "t-mf-del",
          segment: "MF",
          isin: null,
          tradingSymbol: "INF209K01YY8",
          symbol: "MIRAE-FANG",
        }),
      ];
      await processPairing({ jobId: "del-4", userId: "user-1" }, prisma);
      const calls = findCalls("pairedTradeView", "deleteMany");
      const args = calls[0]!.args as {
        where: {
          OR: Array<{ symbol?: { in: string[] }; isin?: { in: string[] } }>;
        };
      };
      assert.strictEqual(args.where.OR.length, 2);
      assert.ok(args.where.OR[1]!.isin!.in.includes("INF209K01YY8"));
    });

    it("should deduplicate symbols before deletion", async () => {
      mockTrades = [
        makeTrade({ id: "t1", symbol: "RELIANCE" }),
        makeTrade({ id: "t2", symbol: "RELIANCE" }),
      ];
      await processPairing({ jobId: "del-5", userId: "user-1" }, prisma);
      const calls = findCalls("pairedTradeView", "deleteMany");
      const args = calls[0]!.args as {
        where: { OR: Array<{ symbol?: { in: string[] } }> };
      };
      assert.strictEqual(args.where.OR[0]!.symbol!.in.length, 1);
    });
  });

  // ── Paired view creation ──────────────────────────────────────────

  describe("Paired view creation", () => {
    it("should call pairedTradeView.createMany when result has pairedViews", async () => {
      mockTrades = [makeTrade()];
      mockPairingResult = {
        pairedViews: [makePairedView()],
        stats: {
          totalTrades: 1,
          openPositions: 1,
          closedPositions: 0,
          partialPositions: 0,
          totalRealizedPnL: 0,
        },
      };
      await processPairing({ jobId: "create-1", userId: "user-1" }, prisma);
      assert.strictEqual(findCalls("pairedTradeView", "createMany").length, 1);
    });

    it("should NOT call pairedTradeView.createMany when result has 0 pairedViews", async () => {
      mockTrades = [makeTrade()];
      mockPairingResult = emptyResult();
      mockPairingResult.stats.totalTrades = 1;
      await processPairing({ jobId: "create-2", userId: "user-1" }, prisma);
      assert.strictEqual(findCalls("pairedTradeView", "createMany").length, 0);
    });

    it("should map all fields from PairedTradeOutput to createMany data", async () => {
      mockTrades = [makeTrade()];
      mockPairingResult = {
        pairedViews: [makePairedView({ symbol: "TCS", exchange: "BSE" })],
        stats: {
          totalTrades: 1,
          openPositions: 0,
          closedPositions: 1,
          partialPositions: 0,
          totalRealizedPnL: 2000,
        },
      };
      await processPairing({ jobId: "create-3", userId: "user-1" }, prisma);
      const calls = findCalls("pairedTradeView", "createMany");
      const args = calls[0]!.args as { data: Array<Record<string, unknown>> };
      const created = args.data[0]!;
      assert.strictEqual(created.symbol, "TCS");
      assert.strictEqual(created.exchange, "BSE");
      assert.strictEqual(created.userId, "user-1");
      assert.strictEqual(created.entryPrice, 2500);
      assert.strictEqual(created.exitPrice, 2700);
      assert.strictEqual(created.realizedPnL, 2000);
      assert.strictEqual(created.status, "CLOSED");
    });

    it("should include pairingBatchId in created views", async () => {
      mockTrades = [makeTrade()];
      mockPairingResult = {
        pairedViews: [makePairedView()],
        stats: {
          totalTrades: 1,
          openPositions: 0,
          closedPositions: 1,
          partialPositions: 0,
          totalRealizedPnL: 2000,
        },
      };
      await processPairing(
        { jobId: "create-4", userId: "user-1", batchId: "batch-xyz" },
        prisma
      );
      const calls = findCalls("pairedTradeView", "createMany");
      const args = calls[0]!.args as { data: Array<Record<string, unknown>> };
      assert.strictEqual(args.data[0]!.pairingBatchId, "batch-xyz");
    });

    it("should create multiple paired views when multiple exist in result", async () => {
      mockTrades = [
        makeTrade({ id: "t1" }),
        makeTrade({ id: "t2" }),
        makeTrade({ id: "t3" }),
      ];
      mockPairingResult = {
        pairedViews: [
          makePairedView({ entryTradeId: "t1" }),
          makePairedView({ entryTradeId: "t2" }),
        ],
        stats: {
          totalTrades: 3,
          openPositions: 1,
          closedPositions: 2,
          partialPositions: 0,
          totalRealizedPnL: 4000,
        },
      };
      await processPairing({ jobId: "create-5", userId: "user-1" }, prisma);
      const calls = findCalls("pairedTradeView", "createMany");
      const args = calls[0]!.args as { data: Array<Record<string, unknown>> };
      assert.strictEqual(args.data.length, 2);
    });
  });

  // ── Trade marking ─────────────────────────────────────────────────

  describe("Trade marking (needsRepairing=false)", () => {
    it("should update trades to needsRepairing=false after pairing", async () => {
      mockTrades = [
        makeTrade({ id: "t-mark-1" }),
        makeTrade({ id: "t-mark-2" }),
      ];
      await processPairing({ jobId: "mark-1", userId: "user-1" }, prisma);
      const calls = findCalls("trade", "updateMany");
      assert.strictEqual(calls.length, 1);
      const args = calls[0]!.args as {
        where: { id: { in: string[] } };
        data: { needsRepairing: boolean };
      };
      assert.deepStrictEqual(args.where.id.in, ["t-mark-1", "t-mark-2"]);
      assert.strictEqual(args.data.needsRepairing, false);
    });

    it("should include all fetched trade IDs in the update", async () => {
      mockTrades = [
        makeTrade({ id: "a1" }),
        makeTrade({ id: "b2" }),
        makeTrade({ id: "c3" }),
      ];
      await processPairing({ jobId: "mark-2", userId: "user-1" }, prisma);
      const calls = findCalls("trade", "updateMany");
      const args = calls[0]!.args as { where: { id: { in: string[] } } };
      assert.strictEqual(args.where.id.in.length, 3);
      assert.ok(args.where.id.in.includes("a1"));
      assert.ok(args.where.id.in.includes("b2"));
      assert.ok(args.where.id.in.includes("c3"));
    });
  });

  // ── batchId logic ──────────────────────────────────────────────────

  describe("batchId logic", () => {
    function singleClosed(): void {
      mockTrades = [makeTrade()];
      mockPairingResult = {
        pairedViews: [makePairedView()],
        stats: {
          totalTrades: 1,
          openPositions: 0,
          closedPositions: 1,
          partialPositions: 0,
          totalRealizedPnL: 2000,
        },
      };
    }

    it("should use the provided batchId when present", async () => {
      singleClosed();
      await processPairing(
        { jobId: "batch-1", userId: "user-1", batchId: "custom-batch" },
        prisma
      );
      const calls = findCalls("pairedTradeView", "createMany");
      const args = calls[0]!.args as { data: Array<Record<string, unknown>> };
      assert.strictEqual(args.data[0]!.pairingBatchId, "custom-batch");
    });

    it("should generate a UUID when batchId is not provided", async () => {
      singleClosed();
      await processPairing({ jobId: "batch-2", userId: "user-1" }, prisma);
      const calls = findCalls("pairedTradeView", "createMany");
      const args = calls[0]!.args as { data: Array<Record<string, unknown>> };
      assert.match(
        args.data[0]!.pairingBatchId as string,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("should generate a UUID when batchId is empty string (falsy)", async () => {
      singleClosed();
      await processPairing(
        { jobId: "batch-3", userId: "user-1", batchId: "" },
        prisma
      );
      const calls = findCalls("pairedTradeView", "createMany");
      const args = calls[0]!.args as { data: Array<Record<string, unknown>> };
      assert.match(
        args.data[0]!.pairingBatchId as string,
        /^[0-9a-f]{8}-[0-9a-f]{4}-/
      );
    });

    it("should use the same batchId for all paired views in a single run", async () => {
      mockTrades = [makeTrade({ id: "t1" }), makeTrade({ id: "t2" })];
      mockPairingResult = {
        pairedViews: [
          makePairedView({ entryTradeId: "t1" }),
          makePairedView({ entryTradeId: "t2" }),
        ],
        stats: {
          totalTrades: 2,
          openPositions: 0,
          closedPositions: 2,
          partialPositions: 0,
          totalRealizedPnL: 4000,
        },
      };
      await processPairing(
        { jobId: "batch-4", userId: "user-1", batchId: "shared-batch" },
        prisma
      );
      const calls = findCalls("pairedTradeView", "createMany");
      const args = calls[0]!.args as { data: Array<Record<string, unknown>> };
      assert.strictEqual(args.data[0]!.pairingBatchId, "shared-batch");
      assert.strictEqual(args.data[1]!.pairingBatchId, "shared-batch");
    });
  });

  // ── Result stats ──────────────────────────────────────────────────

  describe("Result stats in COMPLETED status", () => {
    function withStats(stats: Partial<PairingStats>): void {
      mockTrades = [makeTrade()];
      mockPairingResult = {
        pairedViews: [],
        stats: { ...emptyResult().stats, totalTrades: 1, ...stats },
      };
    }

    it("should include tradesProcessed count", async () => {
      mockTrades = [
        makeTrade({ id: "t1" }),
        makeTrade({ id: "t2" }),
        makeTrade({ id: "t3" }),
      ];
      await processPairing({ jobId: "stats-1", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { result: { tradesProcessed: number } };
      };
      assert.strictEqual(args.data.result.tradesProcessed, 3);
    });

    it("should include pairedViewsCreated count", async () => {
      mockTrades = [makeTrade()];
      mockPairingResult = {
        pairedViews: [makePairedView(), makePairedView()],
        stats: { ...emptyResult().stats, totalTrades: 1, closedPositions: 2 },
      };
      await processPairing({ jobId: "stats-2", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { result: { pairedViewsCreated: number } };
      };
      assert.strictEqual(args.data.result.pairedViewsCreated, 2);
    });

    it("should include openPositions from pairing stats", async () => {
      withStats({ openPositions: 3 });
      await processPairing({ jobId: "stats-3", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { result: { openPositions: number } };
      };
      assert.strictEqual(args.data.result.openPositions, 3);
    });

    it("should include closedPositions from pairing stats", async () => {
      withStats({ closedPositions: 7 });
      await processPairing({ jobId: "stats-4", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { result: { closedPositions: number } };
      };
      assert.strictEqual(args.data.result.closedPositions, 7);
    });

    it("should include partialPositions from pairing stats", async () => {
      withStats({ partialPositions: 5 });
      await processPairing({ jobId: "stats-5", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { result: { partialPositions: number } };
      };
      assert.strictEqual(args.data.result.partialPositions, 5);
    });

    it("should include totalRealizedPnL from pairing stats", async () => {
      withStats({ totalRealizedPnL: -3500.75 });
      await processPairing({ jobId: "stats-6", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { result: { totalRealizedPnL: number } };
      };
      assert.strictEqual(args.data.result.totalRealizedPnL, -3500.75);
    });

    it("should include success=true in result", async () => {
      mockTrades = [makeTrade()];
      await processPairing({ jobId: "stats-7", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { result: { success: boolean } };
      };
      assert.strictEqual(args.data.result.success, true);
    });

    it("should have all expected keys in result for trades path", async () => {
      mockTrades = [makeTrade()];
      mockPairingResult = {
        pairedViews: [makePairedView()],
        stats: {
          totalTrades: 1,
          openPositions: 1,
          closedPositions: 2,
          partialPositions: 3,
          totalRealizedPnL: 999,
        },
      };
      await processPairing({ jobId: "stats-8", userId: "user-1" }, prisma);
      const calls = findCalls("backgroundJob", "updateMany");
      const args = calls[calls.length - 1]!.args as {
        data: { result: Record<string, unknown> };
      };
      const result = args.data.result;
      assert.ok("success" in result);
      assert.ok("tradesProcessed" in result);
      assert.ok("pairedViewsCreated" in result);
      assert.ok("openPositions" in result);
      assert.ok("closedPositions" in result);
      assert.ok("partialPositions" in result);
      assert.ok("totalRealizedPnL" in result);
    });
  });

  // ── pairTradesFIFO invocation ──────────────────────────────────────

  describe("pairTradesFIFO invocation", () => {
    it("should call pairTradesFIFO with converted trade inputs", async () => {
      mockTrades = [makeTrade({ id: "t-fifo", symbol: "INFY", price: 1600 })];
      await processPairing({ jobId: "fifo-1", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls.length, 1);
      assert.strictEqual(pairTradesFIFOCalls[0]!.length, 1);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.symbol, "INFY");
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 1600);
    });

    it("should pass segmentLabel=null and productTypeLabel=null", async () => {
      mockTrades = [makeTrade()];
      await processPairing({ jobId: "fifo-2", userId: "user-1" }, prisma);
      const input = pairTradesFIFOCalls[0]![0]!;
      assert.strictEqual(input.segmentLabel, null);
      assert.strictEqual(input.productTypeLabel, null);
    });

    it("should pass all trade fields correctly to pairTradesFIFO", async () => {
      const tradeDate = new Date("2025-03-10");
      const tradeTime = new Date("2025-03-10T09:15:00Z");
      mockTrades = [
        makeTrade({
          id: "t-all",
          userId: "user-xyz",
          symbol: "HDFC",
          isin: "INE001A01036",
          exchange: "BSE",
          segment: "EQ",
          broker: "UPSTOX",
          brokerUserId: "UP123",
          tradeType: "SELL",
          positionType: "SHORT",
          productType: "MIS",
          quantity: 50,
          price: 1800,
          tradeDate,
          tradeTime,
          sourceType: "IMPORTED",
        }),
      ];
      await processPairing({ jobId: "fifo-3", userId: "user-xyz" }, prisma);
      const input = pairTradesFIFOCalls[0]![0]!;
      assert.strictEqual(input.id, "t-all");
      assert.strictEqual(input.userId, "user-xyz");
      assert.strictEqual(input.symbol, "HDFC");
      assert.strictEqual(input.isin, "INE001A01036");
      assert.strictEqual(input.exchange, "BSE");
      assert.strictEqual(input.segment, "EQ");
      assert.strictEqual(input.broker, "UPSTOX");
      assert.strictEqual(input.brokerUserId, "UP123");
      assert.strictEqual(input.tradeType, "SELL");
      assert.strictEqual(input.positionType, "SHORT");
      assert.strictEqual(input.productType, "MIS");
      assert.strictEqual(input.quantity, 50);
      assert.strictEqual(input.price, 1800);
      assert.strictEqual(input.tradeDate, tradeDate);
      assert.strictEqual(input.tradeTime, tradeTime);
      assert.strictEqual(input.sourceType, "IMPORTED");
    });
  });

  // ── Operation ordering ────────────────────────────────────────────

  describe("Operation ordering", () => {
    function singleClosed(): void {
      mockTrades = [makeTrade()];
      mockPairingResult = {
        pairedViews: [makePairedView()],
        stats: {
          totalTrades: 1,
          openPositions: 0,
          closedPositions: 1,
          partialPositions: 0,
          totalRealizedPnL: 2000,
        },
      };
    }

    it("should delete old views before creating new ones", async () => {
      singleClosed();
      await processPairing({ jobId: "order-1", userId: "user-1" }, prisma);
      const deleteIndex = prismaCalls.findIndex(
        (c) => c.model === "pairedTradeView" && c.method === "deleteMany"
      );
      const createIndex = prismaCalls.findIndex(
        (c) => c.model === "pairedTradeView" && c.method === "createMany"
      );
      assert.ok(deleteIndex >= 0);
      assert.ok(createIndex >= 0);
      assert.ok(deleteIndex < createIndex);
    });

    it("should mark trades as paired after creating paired views", async () => {
      singleClosed();
      await processPairing({ jobId: "order-2", userId: "user-1" }, prisma);
      const createIndex = prismaCalls.findIndex(
        (c) => c.model === "pairedTradeView" && c.method === "createMany"
      );
      const updateIndex = prismaCalls.findIndex(
        (c) => c.model === "trade" && c.method === "updateMany"
      );
      assert.ok(createIndex < updateIndex);
    });

    it("should set COMPLETED status after all operations", async () => {
      singleClosed();
      await processPairing({ jobId: "order-3", userId: "user-1" }, prisma);
      const tradeUpdateIndex = prismaCalls.findIndex(
        (c) => c.model === "trade" && c.method === "updateMany"
      );
      const completedIndex = prismaCalls.findIndex(
        (c) =>
          c.model === "backgroundJob" &&
          c.method === "updateMany" &&
          getStatus(c) === "COMPLETED"
      );
      assert.ok(tradeUpdateIndex < completedIndex);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe("Error handling", () => {
    it("should set BackgroundJob status to FAILED on Error", async () => {
      const failPrisma = createMockPrisma();
      failPrisma.trade.findMany = async () => {
        throw new Error("Database connection lost");
      };
      await assert.rejects(
        () => processPairing({ jobId: "err-1", userId: "u-1" }, failPrisma),
        { message: "Database connection lost" }
      );
      const calls = prismaCalls.filter(
        (c) => c.model === "backgroundJob" && c.method === "updateMany"
      );
      assert.strictEqual(getStatus(calls[0]!), "PROCESSING");
      assert.strictEqual(getStatus(calls[1]!), "FAILED");
    });

    it("should store Error.message in errorMessage field", async () => {
      const failPrisma = createMockPrisma();
      failPrisma.trade.findMany = async () => {
        throw new Error("Pairing algorithm timeout");
      };
      await assert.rejects(() =>
        processPairing({ jobId: "err-2", userId: "u-2" }, failPrisma)
      );
      const calls = prismaCalls.filter(
        (c) => c.model === "backgroundJob" && c.method === "updateMany"
      );
      const args = calls[1]!.args as { data: { errorMessage: string } };
      assert.strictEqual(args.data.errorMessage, "Pairing algorithm timeout");
    });

    it("should store 'Unknown error' for non-Error thrown values", async () => {
      const failPrisma = createMockPrisma();
      failPrisma.trade.findMany = async () => {
        throw "string error"; // eslint-disable-line no-throw-literal
      };
      await assert.rejects(() =>
        processPairing({ jobId: "err-3", userId: "u-3" }, failPrisma)
      );
      const calls = prismaCalls.filter(
        (c) => c.model === "backgroundJob" && c.method === "updateMany"
      );
      const args = calls[1]!.args as { data: { errorMessage: string } };
      assert.strictEqual(args.data.errorMessage, "Unknown error");
    });

    it("should set completedAt on FAILED call", async () => {
      const failPrisma = createMockPrisma();
      failPrisma.trade.findMany = async () => {
        throw new Error("fail");
      };
      const before = new Date();
      await assert.rejects(() =>
        processPairing({ jobId: "err-4", userId: "u-4" }, failPrisma)
      );
      const after = new Date();
      const calls = prismaCalls.filter(
        (c) => c.model === "backgroundJob" && c.method === "updateMany"
      );
      const args = calls[1]!.args as { data: { completedAt: Date } };
      assert.ok(args.data.completedAt >= before);
      assert.ok(args.data.completedAt <= after);
    });

    it("should re-throw the original error", async () => {
      const failPrisma = createMockPrisma();
      failPrisma.trade.findMany = async () => {
        throw new Error("original error");
      };
      await assert.rejects(
        () => processPairing({ jobId: "err-5", userId: "u-5" }, failPrisma),
        { message: "original error" }
      );
    });

    it("should produce exactly 2 backgroundJob.updateMany calls on failure", async () => {
      const failPrisma = createMockPrisma();
      failPrisma.trade.findMany = async () => {
        throw new Error("test");
      };
      await assert.rejects(() =>
        processPairing({ jobId: "err-6", userId: "u-6" }, failPrisma)
      );
      const calls = prismaCalls.filter(
        (c) => c.model === "backgroundJob" && c.method === "updateMany"
      );
      assert.strictEqual(calls.length, 2);
    });

    it("should use correct jobId in FAILED where clause", async () => {
      const failPrisma = createMockPrisma();
      failPrisma.trade.findMany = async () => {
        throw new Error("test");
      };
      await assert.rejects(() =>
        processPairing({ jobId: "err-7", userId: "u-7" }, failPrisma)
      );
      const calls = prismaCalls.filter(
        (c) => c.model === "backgroundJob" && c.method === "updateMany"
      );
      const args = calls[1]!.args as { where: { jobId: string } };
      assert.strictEqual(args.where.jobId, "err-7");
    });

    it("should handle error during pairedTradeView.deleteMany", async () => {
      mockTrades = [makeTrade()];
      const failPrisma = createMockPrisma();
      failPrisma.trade.findMany = async (args: unknown) => {
        prismaCalls.push({ model: "trade", method: "findMany", args });
        return mockTrades;
      };
      failPrisma.pairedTradeView.deleteMany = async () => {
        throw new Error("delete failed");
      };
      await assert.rejects(
        () => processPairing({ jobId: "err-8", userId: "u-8" }, failPrisma),
        { message: "delete failed" }
      );
      const calls = prismaCalls.filter(
        (c) => c.model === "backgroundJob" && c.method === "updateMany"
      );
      assert.strictEqual(getStatus(calls[1]!), "FAILED");
    });
  });

  // ── Multiple trades with different properties ─────────────────────

  describe("Multiple trades with different properties", () => {
    it("should handle mixed segments including MF with ISIN derivation", async () => {
      mockTrades = [
        makeTrade({
          id: "eq-1",
          symbol: "RELIANCE",
          segment: "EQ",
          isin: "INE002A01018",
        }),
        makeTrade({
          id: "mf-1",
          symbol: "MIRAE-FANG",
          segment: "MF",
          isin: null,
          tradingSymbol: "INF209K01YY8",
        }),
      ];
      await processPairing({ jobId: "mix-1", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]!.length, 2);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.isin, "INE002A01018");
      assert.strictEqual(pairTradesFIFOCalls[0]![1]!.isin, "INF209K01YY8");
    });

    it("should handle trades with different price sources", async () => {
      mockTrades = [
        makeTrade({ id: "p1", price: 1500 }),
        makeTrade({ id: "p2", price: null, tradeValue: 20000, quantity: 10 }),
        makeTrade({
          id: "p3",
          price: null,
          tradeValue: null,
          averagePrice: 800,
        }),
        makeTrade({
          id: "p4",
          price: null,
          tradeValue: null,
          averagePrice: null,
        }),
      ];
      await processPairing({ jobId: "mix-2", userId: "user-1" }, prisma);
      const inputs = pairTradesFIFOCalls[0]!;
      assert.strictEqual(inputs[0]!.price, 1500);
      assert.strictEqual(inputs[1]!.price, 2000);
      assert.strictEqual(inputs[2]!.price, 800);
      assert.strictEqual(inputs[3]!.price, 0);
    });

    it("should collect unique symbols from all trades", async () => {
      mockTrades = [
        makeTrade({ id: "t1", symbol: "RELIANCE" }),
        makeTrade({ id: "t2", symbol: "TCS" }),
        makeTrade({ id: "t3", symbol: "RELIANCE" }),
        makeTrade({ id: "t4", symbol: "INFY" }),
      ];
      await processPairing({ jobId: "mix-3", userId: "user-1" }, prisma);
      const calls = findCalls("pairedTradeView", "deleteMany");
      const args = calls[0]!.args as {
        where: { OR: Array<{ symbol?: { in: string[] } }> };
      };
      const symbols = args.where.OR[0]!.symbol!.in;
      assert.strictEqual(symbols.length, 3);
      assert.ok(symbols.includes("RELIANCE"));
      assert.ok(symbols.includes("TCS"));
      assert.ok(symbols.includes("INFY"));
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("Edge cases", () => {
    it("should handle trade with null broker and brokerUserId", async () => {
      mockTrades = [
        makeTrade({ id: "t-null-broker", broker: null, brokerUserId: null }),
      ];
      await processPairing({ jobId: "edge-1", userId: "user-1" }, prisma);
      const input = pairTradesFIFOCalls[0]![0]!;
      assert.strictEqual(input.broker, null);
      assert.strictEqual(input.brokerUserId, null);
    });

    it("should handle trade with null tradeTime", async () => {
      mockTrades = [makeTrade({ id: "t-null-time", tradeTime: null })];
      await processPairing({ jobId: "edge-2", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.tradeTime, null);
    });

    it("should handle single trade", async () => {
      mockTrades = [makeTrade({ id: "single" })];
      await processPairing({ jobId: "edge-3", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls.length, 1);
      assert.strictEqual(pairTradesFIFOCalls[0]!.length, 1);
    });

    it("should handle very large number of trades in terms of ID collection", async () => {
      const trades: MockTrade[] = [];
      for (let i = 0; i < 100; i++) {
        trades.push(makeTrade({ id: `t-${i}`, symbol: `SYM${i % 10}` }));
      }
      mockTrades = trades;
      await processPairing({ jobId: "edge-4", userId: "user-1" }, prisma);
      const tradeUpdateCalls = findCalls("trade", "updateMany");
      const args = tradeUpdateCalls[0]!.args as {
        where: { id: { in: string[] } };
      };
      assert.strictEqual(args.where.id.in.length, 100);
    });

    it("should divide tradeValue=0 by a positive quantity to 0 (de-shadowed helper, NOT averagePrice)", async () => {
      // The real `derivePairingPrice` checks Number.isFinite(tradeValue), so a
      // zero tradeValue is a usable value: 0 / 10 = 0 (the averagePrice `else
      // if` is skipped). The old worker shadow treated tradeValue=0 as falsy
      // and returned 500 — this assertion pins the corrected behavior.
      mockTrades = [
        makeTrade({
          id: "t-tv0",
          price: null,
          tradeValue: 0,
          quantity: 10,
          averagePrice: 500,
        }),
      ];
      await processPairing({ jobId: "edge-5", userId: "user-1" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls[0]![0]!.price, 0);
    });

    it("should collect MF-derived ISINs and real ISINs together in delete clause", async () => {
      mockTrades = [
        makeTrade({
          id: "eq-isin",
          symbol: "RELIANCE",
          segment: "EQ",
          isin: "INE002A01018",
        }),
        makeTrade({
          id: "mf-derived",
          symbol: "MIRAE-FANG",
          segment: "MF",
          isin: null,
          tradingSymbol: "INF209K01YY8",
        }),
        makeTrade({
          id: "mf-real",
          symbol: "SBI-MF",
          segment: "MF",
          isin: "INF200K01RJ1",
        }),
      ];
      await processPairing({ jobId: "edge-6", userId: "user-1" }, prisma);
      const deleteCalls = findCalls("pairedTradeView", "deleteMany");
      const args = deleteCalls[0]!.args as {
        where: {
          OR: Array<{ symbol?: { in: string[] }; isin?: { in: string[] } }>;
        };
      };
      assert.strictEqual(args.where.OR.length, 2);
      const symbols = args.where.OR[0]!.symbol!.in;
      const isins = args.where.OR[1]!.isin!.in;
      assert.strictEqual(symbols.length, 3);
      assert.ok(isins.includes("INE002A01018"));
      assert.ok(isins.includes("INF209K01YY8"));
      assert.ok(isins.includes("INF200K01RJ1"));
    });
  });

  // ── Functional: complete pairing lifecycle ──────────────────────────

  describe("Functional: complete pairing lifecycle", () => {
    it("should handle full lifecycle: PROCESSING → fetch → pair → delete views → create views → mark trades → COMPLETED", async () => {
      mockTrades = [
        makeTrade({
          id: "buy-1",
          symbol: "TCS",
          tradeType: "BUY",
          price: 3500,
        }),
        makeTrade({
          id: "sell-1",
          symbol: "TCS",
          tradeType: "SELL",
          price: 3700,
        }),
        makeTrade({
          id: "buy-2",
          symbol: "INFY",
          tradeType: "BUY",
          price: 1500,
        }),
      ];
      mockPairingResult = {
        pairedViews: [
          makePairedView({
            symbol: "TCS",
            entryTradeId: "buy-1",
            exitTradeId: "sell-1",
            status: "CLOSED",
            realizedPnL: 2000,
          }),
          makePairedView({
            symbol: "INFY",
            entryTradeId: "buy-2",
            exitTradeId: null,
            status: "OPEN",
            realizedPnL: null,
          }),
        ],
        stats: {
          totalTrades: 3,
          openPositions: 1,
          closedPositions: 1,
          partialPositions: 0,
          totalRealizedPnL: 2000,
        },
      };
      await processPairing(
        { jobId: "func-1", userId: "user-func", batchId: "batch-func" },
        prisma
      );

      assert.strictEqual(findCalls("trade", "findMany").length, 1);
      assert.strictEqual(pairTradesFIFOCalls[0]!.length, 3);
      assert.strictEqual(findCalls("pairedTradeView", "deleteMany").length, 1);

      const createArgs = findCalls("pairedTradeView", "createMany")[0]!
        .args as {
        data: Array<Record<string, unknown>>;
      };
      assert.strictEqual(createArgs.data.length, 2);
      assert.strictEqual(createArgs.data[0]!.pairingBatchId, "batch-func");

      const updateArgs = findCalls("trade", "updateMany")[0]!.args as {
        where: { id: { in: string[] } };
        data: { needsRepairing: boolean };
      };
      assert.deepStrictEqual(updateArgs.where.id.in, [
        "buy-1",
        "sell-1",
        "buy-2",
      ]);
      assert.strictEqual(updateArgs.data.needsRepairing, false);

      const bgCalls = findCalls("backgroundJob", "updateMany");
      const result = (
        bgCalls[bgCalls.length - 1]!.args as {
          data: { result: Record<string, unknown> };
        }
      ).data.result;
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.tradesProcessed, 3);
      assert.strictEqual(result.pairedViewsCreated, 2);
      assert.strictEqual(result.openPositions, 1);
      assert.strictEqual(result.closedPositions, 1);
      assert.strictEqual(result.totalRealizedPnL, 2000);
    });

    it("should handle no-trades-to-pair lifecycle: PROCESSING → empty query → COMPLETED with zeros", async () => {
      mockTrades = [];
      await processPairing({ jobId: "func-2", userId: "user-empty" }, prisma);
      assert.strictEqual(pairTradesFIFOCalls.length, 0);
      assert.strictEqual(findCalls("pairedTradeView", "deleteMany").length, 0);
      assert.strictEqual(findCalls("pairedTradeView", "createMany").length, 0);
      assert.strictEqual(findCalls("trade", "updateMany").length, 0);
      const bgCalls = findCalls("backgroundJob", "updateMany");
      assert.strictEqual(bgCalls.length, 2);
      assert.strictEqual(getStatus(bgCalls[0]!), "PROCESSING");
      assert.strictEqual(getStatus(bgCalls[1]!), "COMPLETED");
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// REAL FIFO integration — the worker hands derived inputs to the SAME
// pairTradesFIFO from @usemoney/core/pairing. These cases drive that real
// algorithm end-to-end (negative/edge set mirroring the app pairing suite):
// partial fills, oversell, cross-broker/cross-symbol isolation, empty/single,
// BUY-only / SELL-only, identical timestamps (stable FIFO order), and the
// non-finite / Invalid-Date guards the worker path now relies on.
// ════════════════════════════════════════════════════════════════════

describe("Workers Pairing — real pairTradesFIFO integration", () => {
  it("empty input → no views, zero stats", () => {
    const r: CorePairingResult = pairTradesFIFO([]);
    assert.strictEqual(r.pairedViews.length, 0);
    assert.deepStrictEqual(r.stats, {
      totalTrades: 0,
      openPositions: 0,
      closedPositions: 0,
      partialPositions: 0,
      totalRealizedPnL: 0,
    });
  });

  it("single BUY → one OPEN long position", () => {
    const r = pairTradesFIFO([
      makeInput({ id: "b", quantity: 10, price: 100 }),
    ]);
    assert.strictEqual(r.pairedViews.length, 1);
    const v = r.pairedViews[0]!;
    assert.strictEqual(v.status, "OPEN");
    assert.strictEqual(v.positionType, "LONG");
    assert.strictEqual(v.quantity, 10);
    assert.strictEqual(r.stats.openPositions, 1);
  });

  it("single SELL → one OPEN short position", () => {
    const r = pairTradesFIFO([
      makeInput({ id: "s", tradeType: "SELL", quantity: 7, price: 100 }),
    ]);
    assert.strictEqual(r.pairedViews.length, 1);
    const v = r.pairedViews[0]!;
    assert.strictEqual(v.status, "OPEN");
    assert.strictEqual(v.positionType, "SHORT");
    assert.strictEqual(v.quantity, 7);
    assert.strictEqual(r.stats.openPositions, 1);
  });

  it("BUY-only (multiple) → all OPEN, no closed", () => {
    const r = pairTradesFIFO([
      makeInput({ id: "b1", quantity: 5 }),
      makeInput({ id: "b2", quantity: 8 }),
    ]);
    assert.strictEqual(r.stats.closedPositions, 0);
    assert.strictEqual(r.stats.openPositions, 2);
  });

  it("SELL-only (multiple) → all OPEN short, no closed", () => {
    const r = pairTradesFIFO([
      makeInput({ id: "s1", tradeType: "SELL", quantity: 5 }),
      makeInput({ id: "s2", tradeType: "SELL", quantity: 8 }),
    ]);
    assert.strictEqual(r.stats.closedPositions, 0);
    assert.strictEqual(r.stats.openPositions, 2);
    for (const v of r.pairedViews) assert.strictEqual(v.positionType, "SHORT");
  });

  it("exact fill: BUY 10 @100 then SELL 10 @120 → 1 CLOSED, P&L 200", () => {
    const r = pairTradesFIFO([
      makeInput({
        id: "b",
        quantity: 10,
        price: 100,
        tradeTime: new Date("2025-01-15T10:00:00Z"),
      }),
      makeInput({
        id: "s",
        tradeType: "SELL",
        quantity: 10,
        price: 120,
        tradeTime: new Date("2025-01-16T10:00:00Z"),
      }),
    ]);
    assert.strictEqual(r.stats.closedPositions, 1);
    assert.strictEqual(r.stats.openPositions, 0);
    assert.strictEqual(r.stats.totalRealizedPnL, 200); // (120-100)*10
    const closed = r.pairedViews.find((v) => v.status === "CLOSED")!;
    assert.strictEqual(closed.realizedPnL, 200);
    assert.strictEqual(closed.quantity, 10);
  });

  it("partial fill: BUY 10 then SELL 4 → 1 CLOSED(4) + 1 PARTIAL(6)", () => {
    const r = pairTradesFIFO([
      makeInput({
        id: "b",
        quantity: 10,
        price: 100,
        tradeTime: new Date("2025-01-15T10:00:00Z"),
      }),
      makeInput({
        id: "s",
        tradeType: "SELL",
        quantity: 4,
        price: 110,
        tradeTime: new Date("2025-01-16T10:00:00Z"),
      }),
    ]);
    assert.strictEqual(r.stats.closedPositions, 1);
    assert.strictEqual(r.stats.partialPositions, 1);
    const closed = r.pairedViews.find((v) => v.status === "CLOSED")!;
    const partial = r.pairedViews.find((v) => v.status === "PARTIAL")!;
    assert.strictEqual(closed.quantity, 4);
    assert.strictEqual(closed.realizedPnL, 40); // (110-100)*4
    assert.strictEqual(partial.quantity, 6);
  });

  it("oversell: BUY 5 then SELL 8 → CLOSED(5 long) + OPEN(3 short)", () => {
    const r = pairTradesFIFO([
      makeInput({
        id: "b",
        quantity: 5,
        price: 100,
        tradeTime: new Date("2025-01-15T10:00:00Z"),
      }),
      makeInput({
        id: "s",
        tradeType: "SELL",
        quantity: 8,
        price: 130,
        tradeTime: new Date("2025-01-16T10:00:00Z"),
      }),
    ]);
    assert.strictEqual(r.stats.closedPositions, 1);
    const closed = r.pairedViews.find((v) => v.status === "CLOSED")!;
    assert.strictEqual(closed.quantity, 5);
    assert.strictEqual(closed.positionType, "LONG");
    // 3 units of the SELL remain unmatched → a leftover SHORT. The algorithm
    // marks a partially-consumed entry as PARTIAL (remainingQty < quantity).
    const shortLeg = r.pairedViews.find(
      (v) => v.positionType === "SHORT" && v.exitTradeId === null
    )!;
    assert.ok(shortLeg);
    assert.strictEqual(shortLeg.quantity, 3);
    assert.strictEqual(shortLeg.status, "PARTIAL");
    assert.strictEqual(r.stats.partialPositions, 1);
  });

  it("cross-symbol isolation: a SELL of one symbol does not close another's BUY", () => {
    const r = pairTradesFIFO([
      makeInput({ id: "b-rel", symbol: "RELIANCE", quantity: 10 }),
      makeInput({
        id: "s-tcs",
        symbol: "TCS",
        tradeType: "SELL",
        quantity: 10,
        tradeTime: new Date("2025-01-16T10:00:00Z"),
      }),
    ]);
    assert.strictEqual(r.stats.closedPositions, 0);
    assert.strictEqual(r.stats.openPositions, 2);
  });

  it("cross-broker isolation: same symbol, different broker → not matched", () => {
    const r = pairTradesFIFO([
      makeInput({
        id: "b-z",
        symbol: "RELIANCE",
        broker: "ZERODHA",
        brokerUserId: "Z1",
        quantity: 10,
      }),
      makeInput({
        id: "s-u",
        symbol: "RELIANCE",
        broker: "UPSTOX",
        brokerUserId: "U1",
        tradeType: "SELL",
        quantity: 10,
        tradeTime: new Date("2025-01-16T10:00:00Z"),
      }),
    ]);
    assert.strictEqual(r.stats.closedPositions, 0);
    assert.strictEqual(r.stats.openPositions, 2);
  });

  it("identical timestamps → FIFO tie-break keeps input order (oldest BUY closed first)", () => {
    const ts = new Date("2025-01-15T10:00:00Z");
    const r = pairTradesFIFO([
      makeInput({ id: "b-first", quantity: 5, price: 100, tradeTime: ts }),
      makeInput({ id: "b-second", quantity: 5, price: 200, tradeTime: ts }),
      makeInput({
        id: "s",
        tradeType: "SELL",
        quantity: 5,
        price: 300,
        tradeTime: ts,
      }),
    ]);
    // FIFO must close b-first (entry 100), not b-second (entry 200).
    const closed = r.pairedViews.find((v) => v.status === "CLOSED")!;
    assert.strictEqual(closed.entryTradeId, "b-first");
    assert.strictEqual(closed.entryPrice, 100);
    assert.strictEqual(closed.realizedPnL, 1000); // (300-100)*5
  });

  it("ISIN grouping: a renamed MF (same ISIN, different symbol) nets off", () => {
    const r = pairTradesFIFO([
      makeInput({
        id: "mf-buy",
        symbol: "MIRAE FANG ETF",
        isin: "INF209K01YY8",
        segment: "MF",
        quantity: 100,
        price: 50,
        tradeTime: new Date("2025-01-15T10:00:00Z"),
      }),
      makeInput({
        id: "mf-sell",
        symbol: "MIRAE FANG+ ETF", // renamed
        isin: "INF209K01YY8",
        segment: "MF",
        tradeType: "SELL",
        quantity: 100,
        price: 60,
        tradeTime: new Date("2025-02-15T10:00:00Z"),
      }),
    ]);
    assert.strictEqual(r.stats.closedPositions, 1);
    assert.strictEqual(r.stats.totalRealizedPnL, 1000); // (60-50)*100
  });

  // ---- guard regressions through the real algorithm ----

  it("GUARD: NaN quantity is filtered → no garbage view, finite P&L", () => {
    const r = pairTradesFIFO([
      makeInput({ id: "good", quantity: 10, price: 100 }),
      makeInput({ id: "nan", quantity: NaN, price: 100 }),
    ]);
    for (const v of r.pairedViews) {
      assert.strictEqual(Number.isFinite(v.quantity), true);
    }
    assert.strictEqual(Number.isFinite(r.stats.totalRealizedPnL), true);
    // The NaN-qty row never forms a position.
    assert.strictEqual(
      r.pairedViews.some((v) => v.entryTradeId === "nan"),
      false
    );
  });

  it("GUARD: Infinity/negative/zero quantity rows are dropped", () => {
    const r = pairTradesFIFO([
      makeInput({ id: "inf", quantity: Infinity }),
      makeInput({ id: "neg", quantity: -5 }),
      makeInput({ id: "zero", quantity: 0 }),
    ]);
    assert.strictEqual(r.pairedViews.length, 0);
  });

  it("GUARD: Infinity price is sanitized → realized P&L stays finite", () => {
    const r = pairTradesFIFO([
      makeInput({
        id: "b",
        quantity: 10,
        price: Infinity,
        tradeTime: new Date("2025-01-15T10:00:00Z"),
      }),
      makeInput({
        id: "s",
        tradeType: "SELL",
        quantity: 10,
        price: 120,
        tradeTime: new Date("2025-01-16T10:00:00Z"),
      }),
    ]);
    assert.strictEqual(Number.isFinite(r.stats.totalRealizedPnL), true);
    const closed = r.pairedViews.find((v) => v.status === "CLOSED")!;
    assert.strictEqual(Number.isFinite(closed.realizedPnL as number), true);
  });

  it("GUARD: Invalid-Date tradeTime does not crash and keeps a valid entryDate", () => {
    const r = pairTradesFIFO([
      makeInput({
        id: "bad-time",
        quantity: 10,
        price: 100,
        tradeTime: new Date("not-a-date"),
        tradeDate: new Date("2025-01-15"),
      }),
    ]);
    assert.strictEqual(r.pairedViews.length, 1);
    const v = r.pairedViews[0]!;
    // entryDate must be a real instant (Invalid Date → falls back / epoch).
    assert.strictEqual(Number.isNaN(v.entryDate.getTime()), false);
    // Round-trips without throwing (the failure mode Invalid Date causes).
    assert.doesNotThrow(() => v.entryDate.toISOString());
  });
});
