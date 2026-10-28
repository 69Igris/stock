/**
 * MONEY-1062 P3a — paper-portfolio.service cash/fill math (REAL service fns,
 * injected fake prisma via the `deps.prisma` seam).
 *
 * `@usemoney/services` runs its suite as ESM (no require.cache module-mocking),
 * so the Prisma collaborator is injected through each function's `deps` seam.
 * This pins the ported ORDER/CASH model math on the code that SHIPS:
 *   - getOrCreatePaperPortfolio: return existing / lazily create at ₹1,000,000,
 *   - placePaperOrder: price-required + cash GATE run BEFORE any write; BUY
 *     debits cash, SELL credits it; a new fill creates a position, a same
 *     symbol+side fill AVERAGES into the open one (150 avg from 100+200),
 *   - getPaperPerformance / getPaperDashboardStats: win-rate / totals / best-
 *     worst aggregation,
 *   - resetPaperPortfolio: one $transaction (purge orders + CLOSE positions +
 *     restore cash), idempotent no-op when no portfolio exists.
 *
 * Numeric cases are pinned against the web logic in
 * apps/web/lib/db/{paper,paper-portfolio,paper-order}.ts + paper-logic.ts.
 *
 * Source: packages/services/src/paper-portfolio.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getOrCreatePaperPortfolio,
  placePaperOrder,
  getPaperOrders,
  getPaperPerformance,
  getPaperDashboardStats,
  resetPaperPortfolio,
  type PaperPortfolioDeps,
} from "../src/paper-portfolio.service";
import type { PlaceOrderData } from "@usemoney/validation";

// ── fake prisma ─────────────────────────────────────────────────────────────
type Rec = Record<string, unknown>;
interface CreateArg {
  data: Rec;
}
interface UpdateArg {
  where: { id: string };
  data: Rec;
}
interface WhereArg {
  where?: { status?: string; userId?: string; portfolioId?: string };
  take?: number;
}

interface DbCfg {
  portfolio?: Rec | null;
  portfolioSeq?: Array<Rec | null>;
  createdPortfolio?: Rec;
  existingPosition?: Rec | null;
  orders?: Rec[];
  closed?: Rec[];
  open?: Rec[];
  orderId?: string;
}

interface Calls {
  portfolioFindUnique: unknown[];
  portfolioCreate: unknown[];
  portfolioUpdate: unknown[];
  orderCreate: unknown[];
  orderFindMany: unknown[];
  orderDeleteMany: unknown[];
  positionFindFirst: unknown[];
  positionCreate: unknown[];
  positionUpdate: unknown[];
  positionFindMany: unknown[];
  positionUpdateMany: unknown[];
  transaction: unknown[];
}

function makeDb(cfg: DbCfg = {}): { deps: PaperPortfolioDeps; calls: Calls } {
  const calls: Calls = {
    portfolioFindUnique: [],
    portfolioCreate: [],
    portfolioUpdate: [],
    orderCreate: [],
    orderFindMany: [],
    orderDeleteMany: [],
    positionFindFirst: [],
    positionCreate: [],
    positionUpdate: [],
    positionFindMany: [],
    positionUpdateMany: [],
    transaction: [],
  };
  let puIdx = 0;

  const db = {
    paperPortfolio: {
      findUnique: async (a: Rec) => {
        calls.portfolioFindUnique.push(a);
        if (cfg.portfolioSeq) {
          const v =
            cfg.portfolioSeq[Math.min(puIdx, cfg.portfolioSeq.length - 1)];
          puIdx += 1;
          return v ?? null;
        }
        return cfg.portfolio ?? null;
      },
      create: async (a: CreateArg) => {
        calls.portfolioCreate.push(a);
        return cfg.createdPortfolio ?? { id: "pf_new", ...a.data };
      },
      update: async (a: UpdateArg) => {
        calls.portfolioUpdate.push(a);
        return { id: a.where.id, ...a.data };
      },
    },
    paperOrder: {
      create: async (a: CreateArg) => {
        calls.orderCreate.push(a);
        return { id: cfg.orderId ?? "ord_1", ...a.data };
      },
      findMany: async (a: WhereArg) => {
        calls.orderFindMany.push(a);
        return cfg.orders ?? [];
      },
      deleteMany: async (a: WhereArg) => {
        calls.orderDeleteMany.push(a);
        return { count: 0 };
      },
    },
    paperPosition: {
      findFirst: async (a: Rec) => {
        calls.positionFindFirst.push(a);
        return cfg.existingPosition ?? null;
      },
      create: async (a: CreateArg) => {
        calls.positionCreate.push(a);
        return { id: "pos_new", ...a.data };
      },
      update: async (a: UpdateArg) => {
        calls.positionUpdate.push(a);
        return { id: a.where.id, ...a.data };
      },
      findMany: async (a: WhereArg) => {
        calls.positionFindMany.push(a);
        const status = a.where?.status;
        if (status === "CLOSED") return cfg.closed ?? [];
        if (status === "OPEN") return cfg.open ?? [];
        return [];
      },
      updateMany: async (a: WhereArg) => {
        calls.positionUpdateMany.push(a);
        return { count: 0 };
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => {
      calls.transaction.push(ops);
      return Promise.all(ops);
    },
  };

  return { deps: { prisma: db } as unknown as PaperPortfolioDeps, calls };
}

function order(o: {
  side: "BUY" | "SELL";
  quantity: number;
  price?: number;
  symbol?: string;
  name?: string;
}): PlaceOrderData {
  return {
    symbol: o.symbol ?? "RELIANCE",
    name: o.name ?? "Reliance Industries",
    exchange: "NSE",
    instrumentType: "EQUITY",
    side: o.side,
    orderType: "MARKET",
    quantity: o.quantity,
    ...(o.price !== undefined ? { price: o.price } : {}),
  } as PlaceOrderData;
}

const cashIncrement = (u: unknown): number =>
  ((u as UpdateArg).data.cash as { increment: number }).increment;

// ══════════════════════════════════════════════════════════════════════════
// getOrCreatePaperPortfolio
// ══════════════════════════════════════════════════════════════════════════

describe("getOrCreatePaperPortfolio", () => {
  it("returns the existing portfolio without creating one", async () => {
    const { deps, calls } = makeDb({
      portfolio: { id: "pf_1", initialCapital: 1_000_000, cash: 500_000 },
    });
    const res = await getOrCreatePaperPortfolio("u1", deps);
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.id, "pf_1");
    assert.equal(res.data.cash, 500_000);
    assert.equal(calls.portfolioCreate.length, 0);
  });

  it("lazily creates a portfolio at ₹1,000,000 when none exists", async () => {
    const { deps, calls } = makeDb({
      portfolio: null,
      createdPortfolio: {
        id: "pf_new",
        initialCapital: 1_000_000,
        cash: 1_000_000,
      },
    });
    const res = await getOrCreatePaperPortfolio("u1", deps);
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.cash, 1_000_000);
    assert.equal(calls.portfolioCreate.length, 1);
    const created = (calls.portfolioCreate[0] as CreateArg).data;
    assert.equal(created.userId, "u1");
    assert.equal(created.initialCapital, 1_000_000);
    assert.equal(created.cash, 1_000_000);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// placePaperOrder — cash + fill math (the GATE runs before any write)
// ══════════════════════════════════════════════════════════════════════════

describe("placePaperOrder", () => {
  it("BUY: debits cash and creates a new LONG position", async () => {
    const { deps, calls } = makeDb({
      portfolio: { id: "pf_1", initialCapital: 1_000_000, cash: 1_000_000 },
      existingPosition: null,
      orderId: "ord_9",
    });
    const res = await placePaperOrder(
      "u1",
      order({ side: "BUY", quantity: 10, price: 100 }),
      deps,
    );
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.orderId, "ord_9");
    assert.equal(res.data.executedPrice, 100);

    // order record
    assert.equal(calls.orderCreate.length, 1);
    const od = (calls.orderCreate[0] as CreateArg).data;
    assert.equal(od.side, "BUY");
    assert.equal(od.status, "EXECUTED");
    assert.equal(od.quantity, 10);
    assert.equal(od.executedPrice, 100);
    assert.equal(od.symbol, "RELIANCE");

    // new position (invested = currentValue = 10 * 100 = 1000)
    assert.equal(calls.positionCreate.length, 1);
    const pd = (calls.positionCreate[0] as CreateArg).data;
    assert.equal(pd.quantity, 10);
    assert.equal(pd.averagePrice, 100);
    assert.equal(pd.investedValue, 1000);
    assert.equal(pd.currentValue, 1000);
    assert.equal(pd.currentPrice, 100);
    assert.equal(pd.positionType, "LONG");
    assert.equal(pd.side, "BUY");
    assert.equal(pd.assetType, "STOCK");
    assert.equal(pd.segment, "EQUITY");
    assert.equal(pd.status, "OPEN");

    // cash debited by 1000
    assert.equal(calls.portfolioUpdate.length, 1);
    assert.equal((calls.portfolioUpdate[0] as UpdateArg).where.id, "pf_1");
    assert.equal(cashIncrement(calls.portfolioUpdate[0]), -1000);
  });

  it("SELL: credits cash and opens a SHORT position", async () => {
    const { deps, calls } = makeDb({
      portfolio: { id: "pf_1", initialCapital: 1_000_000, cash: 1_000_000 },
      existingPosition: null,
    });
    const res = await placePaperOrder(
      "u1",
      order({ side: "SELL", quantity: 5, price: 200 }),
      deps,
    );
    assert.equal(res.success, true);
    // cash credited by 200 * 5 = 1000 (SELL is not cash-checked)
    assert.equal(cashIncrement(calls.portfolioUpdate[0]), 1000);
    const pd = (calls.positionCreate[0] as CreateArg).data;
    assert.equal(pd.side, "SELL");
    assert.equal(pd.positionType, "SHORT");
  });

  it("rejects insufficient cash on BUY (INVALID_INPUT) — NO writes", async () => {
    const { deps, calls } = makeDb({
      portfolio: { id: "pf_1", initialCapital: 1_000_000, cash: 1000 },
    });
    const res = await placePaperOrder(
      "u1",
      order({ side: "BUY", quantity: 100, price: 20000 }), // 2,000,000 > 1000
      deps,
    );
    assert.equal(res.success, false);
    if (res.success) return;
    assert.equal(res.code, "INVALID_INPUT");
    assert.match(res.error, /Insufficient cash/);
    // gate ran before any write
    assert.equal(calls.orderCreate.length, 0);
    assert.equal(calls.positionCreate.length, 0);
    assert.equal(calls.positionUpdate.length, 0);
    assert.equal(calls.portfolioUpdate.length, 0);
  });

  it("rejects a missing price (INVALID_INPUT) — NO writes", async () => {
    const { deps, calls } = makeDb({
      portfolio: { id: "pf_1", initialCapital: 1_000_000, cash: 1_000_000 },
    });
    const res = await placePaperOrder(
      "u1",
      order({ side: "BUY", quantity: 10 }), // no price
      deps,
    );
    assert.equal(res.success, false);
    if (res.success) return;
    assert.equal(res.code, "INVALID_INPUT");
    assert.match(res.error, /Price is required/);
    assert.equal(calls.orderCreate.length, 0);
    assert.equal(calls.portfolioUpdate.length, 0);
  });

  it("averages a same symbol+side fill into the OPEN position (100 & 200 → 150)", async () => {
    const { deps, calls } = makeDb({
      portfolio: { id: "pf_1", initialCapital: 1_000_000, cash: 1_000_000 },
      existingPosition: {
        id: "pos_1",
        quantity: 10,
        averagePrice: 100,
        currentPrice: 100,
        side: "BUY",
        stopLoss: null,
        target: null,
        strategy: null,
      },
    });
    const res = await placePaperOrder(
      "u1",
      order({ side: "BUY", quantity: 10, price: 200 }),
      deps,
    );
    assert.equal(res.success, true);

    // averaged, NOT a new row
    assert.equal(calls.positionCreate.length, 0);
    assert.equal(calls.positionUpdate.length, 1);
    const upd = calls.positionUpdate[0] as UpdateArg;
    assert.equal(upd.where.id, "pos_1");
    assert.equal(upd.data.quantity, 20); // 10 + 10
    assert.equal(upd.data.averagePrice, 150); // (100*10 + 200*10) / 20
    assert.equal(upd.data.investedValue, 3000); // 20 * 150
    assert.equal(upd.data.currentValue, 2000); // 20 * existing currentPrice (100)

    // cash debited by 200 * 10 = 2000
    assert.equal(cashIncrement(calls.portfolioUpdate[0]), -2000);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getPaperOrders — scoped, limited
// ══════════════════════════════════════════════════════════════════════════

describe("getPaperOrders", () => {
  it("scopes to the user and passes limit + status to the query", async () => {
    const { deps, calls } = makeDb({
      orders: [{ id: "ord_1" }, { id: "ord_2" }],
    });
    const res = await getPaperOrders(
      "u1",
      { limit: 25, status: "EXECUTED" },
      deps,
    );
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.length, 2);
    const fm = calls.orderFindMany[0] as WhereArg;
    assert.equal(fm.take, 25);
    assert.equal(fm.where?.userId, "u1");
    assert.equal(fm.where?.status, "EXECUTED");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getPaperPerformance / getPaperDashboardStats — aggregation math
// ══════════════════════════════════════════════════════════════════════════

describe("getPaperPerformance", () => {
  it("aggregates win rate, totals and best/worst from closed trades", async () => {
    const { deps } = makeDb({
      closed: [
        { symbol: "A", realizedPnL: 500, benchmarkPnL: 0 },
        { symbol: "B", realizedPnL: -200, benchmarkPnL: 0 },
      ],
      open: [{ symbol: "C" }],
    });
    const res = await getPaperPerformance("u1", deps);
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.totalTrades, 3); // 2 closed + 1 open
    assert.equal(res.data.closedTrades, 2);
    assert.equal(res.data.winners, 1);
    assert.equal(res.data.losers, 1);
    assert.equal(res.data.winRate, 50);
    assert.equal(res.data.totalRealizedPnL, 300);
    assert.deepEqual(res.data.bestTrade, { symbol: "A", pnl: 500 });
    assert.deepEqual(res.data.worstTrade, { symbol: "B", pnl: -200 });
  });
});

describe("getPaperDashboardStats", () => {
  it("merges portfolio + open-position totals + closed performance", async () => {
    const { deps } = makeDb({
      portfolio: { id: "pf_1", initialCapital: 1_000_000, cash: 998_000 },
      open: [
        {
          status: "OPEN",
          assetType: "STOCK",
          investedValue: 1000,
          currentValue: 1200,
          benchmarkPnL: 0,
          dayPnl: 50,
        },
      ],
      closed: [
        { symbol: "A", status: "CLOSED", realizedPnL: 500, benchmarkPnL: 0 },
        { symbol: "B", status: "CLOSED", realizedPnL: -200, benchmarkPnL: 0 },
      ],
    });
    const res = await getPaperDashboardStats("u1", deps);
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data.portfolio.cash, 998_000);
    assert.equal(res.data.positions.open, 1);
    assert.equal(res.data.positions.closed, 2);
    assert.equal(res.data.positions.totalInvested, 1000);
    assert.equal(res.data.positions.totalCurrentValue, 1200);
    assert.equal(res.data.positions.totalPnl, 200);
    assert.equal(res.data.positions.totalPnlPercentage, 20); // 200/1000 * 100
    assert.equal(res.data.positions.dayPnl, 50);
    assert.equal(res.data.performance.winRate, 50);
    assert.equal(res.data.performance.totalTrades, 2); // closed trades
    assert.equal(res.data.performance.avgWin, 500);
    assert.equal(res.data.performance.avgLoss, -200);
    assert.equal(res.data.performance.bestTrade, 500);
    assert.equal(res.data.performance.worstTrade, -200);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// resetPaperPortfolio — one transaction; idempotent no-op when absent
// ══════════════════════════════════════════════════════════════════════════

describe("resetPaperPortfolio", () => {
  it("purges orders, CLOSES positions and restores cash in ONE transaction", async () => {
    const { deps, calls } = makeDb({
      portfolioSeq: [
        { id: "pf_1", initialCapital: 1_000_000, cash: 5000 }, // before
        { id: "pf_1", initialCapital: 1_000_000, cash: 1_000_000 }, // after
      ],
    });
    const res = await resetPaperPortfolio("u1", deps);
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data?.cash, 1_000_000);

    assert.equal(calls.transaction.length, 1);
    assert.equal((calls.transaction[0] as unknown[]).length, 3);

    assert.equal(calls.orderDeleteMany.length, 1);
    assert.equal(
      (calls.orderDeleteMany[0] as WhereArg).where?.portfolioId,
      "pf_1",
    );

    assert.equal(calls.positionUpdateMany.length, 1);
    const pum = calls.positionUpdateMany[0] as UpdateArg & WhereArg;
    assert.equal(pum.where?.portfolioId, "pf_1");
    assert.equal(pum.data.status, "CLOSED");

    assert.equal(calls.portfolioUpdate.length, 1);
    const pu = calls.portfolioUpdate[0] as UpdateArg;
    assert.equal(pu.where.id, "pf_1");
    assert.equal(pu.data.cash, 1_000_000); // restored to initialCapital
  });

  it("is a success no-op (data: null) when the user has no portfolio yet", async () => {
    const { deps, calls } = makeDb({ portfolio: null });
    const res = await resetPaperPortfolio("u1", deps);
    assert.equal(res.success, true);
    if (!res.success) return;
    assert.equal(res.data, null);
    assert.equal(calls.transaction.length, 0);
  });
});
