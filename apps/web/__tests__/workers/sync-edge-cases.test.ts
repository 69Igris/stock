/**
 * Broker Sync Processor — EDGE-CASE Tests (workers/src/processors/sync.ts)
 *
 * De-shadowed. The previous version of this file re-implemented the ENTIRE
 * ~340-line `processSync` orchestration inline (`async function processSync(...)`
 * with a mock Prisma) and asserted the COPY — a textbook shadow that stayed
 * green regardless of the real worker.
 *
 * The real `sync.ts` is a thin Prisma/crypto/adapter shell around the pure
 * decision points in `sync-logic.ts`, and `processor-sync.test.ts` already
 * exercises every one of those exports for the happy path. This file now pins
 * the EDGE-CASE behaviour those same exports encode — the exact scenarios the
 * old inline copy claimed:
 *
 *   - decryption failure → FAILED job patch shape (buildSyncJobStatusUpdate)
 *   - partial sync (one type fails) → stats omit the failed type (accumulateSynced)
 *   - all types fail → empty stats, total 0
 *   - delete-then-insert accounting → a type that wrote nothing stays absent
 *   - wildcard userId → connection.userId resolution (resolveEffectiveUserId)
 *   - skipped (no-cred) connections → hasCompleteCreds gate
 *   - position math div-by-zero guard, dedup-key stability
 *
 * Orchestration-only behaviours that CANNOT be unit-tested without booting
 * Prisma + the broker adapters + the decryptor (cache-invalidation `.catch`
 * swallow, notification propagation, the delete→insert ordering itself) are
 * called out inline as needing a functional/integration test, never re-shadowed.
 *
 * @see workers/src/processors/sync.ts (the orchestration under test)
 * @see workers/src/processors/sync-logic.ts (the real exports asserted here)
 * @see apps/web/__tests__/workers/processor-sync.test.ts (happy-path coverage)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  HoldingData,
  PositionData,
  TradeData,
  MutualFundData,
} from "@usemoney/types";

// REAL worker exports under test (no shadow). sync.ts CALLS every one of these.
import {
  hasCompleteCreds,
  resolveEffectiveUserId,
  computePositionDerived,
  buildHoldingCreateData,
  buildTradeUpsertArgs,
  buildMutualFundUpsertArgs,
  buildSyncJobStatusUpdate,
  accumulateSynced,
  type SyncJobResult,
} from "../../../../workers/src/processors/sync-logic";

// ── Fixtures (the adapter return shapes the worker consumes) ───────────

function makeHolding(overrides: Partial<HoldingData> = {}): HoldingData {
  return {
    symbol: "RELIANCE",
    tradingSymbol: "RELIANCE-EQ",
    isin: "INE002A01018",
    exchange: "NSE",
    totalQuantity: 10,
    freeQuantity: 10,
    averagePrice: 2400,
    lastPrice: 2500,
    closePrice: 2480,
    pnl: 1000,
    pnlPercentage: 4.17,
    product: "CNC",
    dayChange: 20,
    dayChangePerc: 0.81,
    ...overrides,
  };
}

function makePosition(overrides: Partial<PositionData> = {}): PositionData {
  return {
    symbol: "NIFTY",
    tradingSymbol: "NIFTY25JANFUT",
    exchange: "NFO",
    segment: "FO",
    positionType: "DAY",
    productType: "NRML",
    buyQuantity: 50,
    sellQuantity: 0,
    netQuantity: 50,
    buyPrice: 21000,
    sellPrice: 0,
    averagePrice: 21000,
    lastPrice: 21200,
    realizedPnl: 0,
    unrealizedPnl: 10000,
    multiplier: 1,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<TradeData> = {}): TradeData {
  return {
    tradeId: "t-001",
    orderId: "o-001",
    symbol: "TCS",
    tradingSymbol: "TCS-EQ",
    exchange: "NSE",
    segment: "EQ",
    transactionType: "BUY",
    productType: "CNC",
    quantity: 5,
    price: 3800,
    tradeValue: 19000,
    brokerage: 0,
    exchangeFee: 0,
    gst: 0,
    sebiCharges: 0,
    stampDuty: 0,
    transactionTax: 0,
    totalCharges: 0,
    netAmount: 19000,
    tradeTime: new Date("2026-01-15"),
    ...overrides,
  };
}

function makeMutualFund(
  overrides: Partial<MutualFundData> = {}
): MutualFundData {
  return {
    fundName: "HDFC Flexi Cap Fund",
    schemeName: "HDFC Flexi Cap Fund",
    isin: "INF179K01BC4",
    folio: "1234567890",
    units: 100,
    averageNav: 15,
    currentNav: 18,
    investedValue: 1500,
    currentValue: 1800,
    pnl: 300,
    pnlPercentage: 20,
    isSIP: false,
    ...overrides,
  };
}

const CTX = {
  userId: "u-1",
  broker: "ZERODHA",
  brokerUserId: "ZR001",
} as const;

/**
 * Re-derives the running `{ stats, total }` over a sequence of per-type outcomes
 * using the REAL `accumulateSynced`. A FAILED fetch is modelled exactly as the
 * processor models it: the type is simply never folded in (its `count` entry is
 * absent), so it stays out of `syncStats`. This is the pure heart of the old
 * inline "partial sync" / "all fail" assertions, now run on real code.
 */
function foldOutcomes(
  outcomes: Array<{ type: string; count: number | null }>
): { stats: Record<string, number>; total: number } {
  let stats: Record<string, number> = {};
  let total = 0;
  for (const o of outcomes) {
    if (o.count === null) continue; // fetch failed → not accumulated
    ({ stats, total } = accumulateSynced(stats, total, o.type, o.count));
  }
  return { stats, total };
}

// ══════════════════════════════════════════════════════════════════════
// Credential decryption failure → FAILED job patch (buildSyncJobStatusUpdate)
// ══════════════════════════════════════════════════════════════════════

describe("Sync edge: decryption / fatal failure → FAILED patch", () => {
  it("FAILED patch carries the descriptive errorMessage and completedAt", () => {
    const patch = buildSyncJobStatusUpdate("FAILED", {
      errorMessage: "AES-GCM decryption failed",
    }) as { status: string; errorMessage?: string; completedAt?: Date };
    assert.strictEqual(patch.status, "FAILED");
    assert.strictEqual(patch.errorMessage, "AES-GCM decryption failed");
    assert.ok(patch.completedAt instanceof Date);
  });

  it("FAILED patch NEVER carries progress or a result (no false 'completed' signal)", () => {
    const patch = buildSyncJobStatusUpdate("FAILED", {
      errorMessage: "boom",
    }) as Record<string, unknown>;
    assert.ok(!("progress" in patch));
    assert.ok(!("result" in patch));
  });

  it("FAILED patch omits errorMessage entirely when none is supplied", () => {
    const patch = buildSyncJobStatusUpdate("FAILED") as Record<string, unknown>;
    assert.ok(!("errorMessage" in patch));
  });

  // The decrypt throw → catch → FAILED-write → rethrow CONTROL FLOW lives in
  // sync.ts and needs a functional test with a mocked decryptor; it is not
  // re-implemented here (that was the shadow).
});

// ══════════════════════════════════════════════════════════════════════
// Partial sync: holdings succeed, positions fail (accumulateSynced)
// ══════════════════════════════════════════════════════════════════════

describe("Sync edge: partial sync stats (accumulateSynced)", () => {
  it("records the succeeded type's count but OMITS the failed type", () => {
    const { stats, total } = foldOutcomes([
      { type: "holdings", count: 2 },
      { type: "positions", count: null }, // fetch threw
    ]);
    assert.strictEqual(stats.holdings, 2);
    assert.strictEqual(stats.positions, undefined);
    assert.strictEqual(total, 2);
  });

  it("a COMPLETED patch built from partial stats still reads success:true", () => {
    const { stats, total } = foldOutcomes([
      { type: "holdings", count: 2 },
      { type: "positions", count: null },
    ]);
    const result: SyncJobResult = { success: true, synced: stats, total };
    const patch = buildSyncJobStatusUpdate("COMPLETED", { result }) as {
      status: string;
      progress?: number;
      result?: SyncJobResult;
    };
    assert.strictEqual(patch.status, "COMPLETED");
    assert.strictEqual(patch.progress, 100);
    assert.deepStrictEqual(patch.result, {
      success: true,
      synced: { holdings: 2 },
      total: 2,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// All data types fail → empty stats, total 0
// ══════════════════════════════════════════════════════════════════════

describe("Sync edge: all types fail → empty stats", () => {
  it("yields {} stats and total 0 when every fetch fails", () => {
    const { stats, total } = foldOutcomes([
      { type: "holdings", count: null },
      { type: "positions", count: null },
      { type: "trades", count: null },
      { type: "mutualFunds", count: null },
    ]);
    assert.deepStrictEqual(stats, {});
    assert.strictEqual(total, 0);
  });

  it("the COMPLETED patch for an all-fail run carries the empty result (not FAILED)", () => {
    const result: SyncJobResult = { success: true, synced: {}, total: 0 };
    const patch = buildSyncJobStatusUpdate("COMPLETED", { result }) as {
      result?: SyncJobResult;
    };
    assert.deepStrictEqual(patch.result, {
      success: true,
      synced: {},
      total: 0,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// Delete-then-insert accounting (accumulateSynced)
// ══════════════════════════════════════════════════════════════════════

describe("Sync edge: delete-then-insert accounting", () => {
  it("a type whose inserts all failed is NOT counted (stays absent from stats)", () => {
    // sync.ts deletes holdings, then the per-row create throws and is caught by
    // the per-type try/catch — so accumulateSynced("holdings", ...) is never
    // reached and holdings stays absent. We model that as a null outcome.
    const { stats, total } = foldOutcomes([{ type: "holdings", count: null }]);
    assert.strictEqual(stats.holdings, undefined);
    assert.strictEqual(total, 0);
    // The DATA-LOSS window (delete succeeds, insert fails) is an ordering
    // property of sync.ts itself and must be covered by an integration test
    // with a mock Prisma — not re-derived here.
  });

  it("an empty-but-successful fetch IS counted as 0 (distinct from a failure)", () => {
    const { stats, total } = foldOutcomes([{ type: "holdings", count: 0 }]);
    assert.strictEqual(stats.holdings, 0); // present, zero
    assert.strictEqual(total, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Wildcard userId resolution (resolveEffectiveUserId)
// ══════════════════════════════════════════════════════════════════════

describe("Sync edge: wildcard userId → connection.userId (resolveEffectiveUserId)", () => {
  it("a wildcard ('*') job writes under each connection's OWN userId", () => {
    assert.strictEqual(
      resolveEffectiveUserId("*", "real-user-42"),
      "real-user-42"
    );
  });

  it("a normal job ignores the connection userId and uses the job userId", () => {
    assert.strictEqual(resolveEffectiveUserId("u-1", "someone-else"), "u-1");
  });

  it("a wildcard job with a null connection userId falls back to '*' (never undefined)", () => {
    assert.strictEqual(resolveEffectiveUserId("*", null), "*");
  });

  it("the effective userId flows onto the built Holding row", () => {
    const row = buildHoldingCreateData(makeHolding(), {
      userId: resolveEffectiveUserId("*", "real-user-99"),
      broker: CTX.broker,
      brokerUserId: CTX.brokerUserId,
    });
    assert.strictEqual(row.userId, "real-user-99");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Skipped (no-cred) connections (hasCompleteCreds)
// ══════════════════════════════════════════════════════════════════════

describe("Sync edge: missing-credential connections are skipped (hasCompleteCreds)", () => {
  const base = { encryptedCreds: "enc", iv: "iv", authTag: "tag" };

  it("a fully-credentialled connection passes the gate", () => {
    assert.strictEqual(hasCompleteCreds(base), true);
  });

  it("a null in ANY of the three credential fields fails the gate", () => {
    assert.strictEqual(
      hasCompleteCreds({ ...base, encryptedCreds: null }),
      false
    );
    assert.strictEqual(hasCompleteCreds({ ...base, iv: null }), false);
    assert.strictEqual(hasCompleteCreds({ ...base, authTag: null }), false);
  });

  it("an empty-string credential is NOT a credential (blank tag fails the gate)", () => {
    assert.strictEqual(hasCompleteCreds({ ...base, authTag: "" }), false);
  });

  it("when every connection is skipped, the fold sees no outcomes → empty stats / total 0", () => {
    // Each skipped connection contributes zero per-type outcomes.
    const { stats, total } = foldOutcomes([]);
    assert.deepStrictEqual(stats, {});
    assert.strictEqual(total, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Numeric edge cases in the row builders (div-by-zero / dedup stability)
// ══════════════════════════════════════════════════════════════════════

describe("Sync edge: position math + dedup-key stability", () => {
  it("DIV-BY-ZERO GUARD: zero buyValue → pnlPercentage 0, never NaN/Infinity", () => {
    const d = computePositionDerived(
      makePosition({
        buyQuantity: 0,
        buyPrice: 0,
        realizedPnl: 500,
        unrealizedPnl: 0,
      })
    );
    assert.strictEqual(d.buyValue, 0);
    assert.strictEqual(d.pnlPercentage, 0);
    assert.ok(Number.isFinite(d.pnlPercentage));
  });

  it("a short (negative-net) position uses abs(netQuantity) for netValue", () => {
    const d = computePositionDerived(
      makePosition({ netQuantity: -50, lastPrice: 100 })
    );
    assert.strictEqual(d.netValue, 5000);
  });

  it("trade upsert is keyed on the (user, broker, brokerUserId, brokerTradeId) compound — stable across re-sync", () => {
    const a = buildTradeUpsertArgs(makeTrade({ tradeId: "X" }), CTX);
    const b = buildTradeUpsertArgs(
      makeTrade({ tradeId: "X", price: 9999 }),
      CTX
    );
    // Same identity ⇒ identical where-key ⇒ a re-sync converges to ONE row.
    assert.deepStrictEqual(
      a.where.userId_broker_brokerUserId_brokerTradeId,
      b.where.userId_broker_brokerUserId_brokerTradeId
    );
  });

  it("MF dedup key falls back to schemeName when ISIN is empty (no duplicate rows on re-sync)", () => {
    const noIsin = buildMutualFundUpsertArgs(
      makeMutualFund({ isin: "", folio: "" }),
      CTX
    );
    const key =
      noIsin.where.userId_broker_brokerUserId_folioNumber_tradingSymbol;
    assert.strictEqual(key?.tradingSymbol, "HDFC Flexi Cap Fund");
    assert.strictEqual(key?.folioNumber, "");
  });
});
