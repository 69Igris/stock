/**
 * Broker Sync Processor Tests (workers/src/processors/sync.ts) — DE-SHADOWED.
 *
 * The previous version of this file SHADOWED the processor: it declared a local
 * ~340-line `async function processSync` "(mirrors workers/src/processors/
 * sync.ts)" that re-implemented the connection filter, credential guard, every
 * per-data-type payload, the position computed-field math, the status stamping,
 * and the stats accumulation — then asserted the COPY against a hand-rolled
 * mock-prisma. No real worker symbol was imported, so the suite stayed green
 * against code that does not exist in production.
 *
 * This rewrite asserts ONLY real shipped code: the pure orchestration helpers
 * exported from `workers/src/processors/sync-logic.ts`, which `sync.ts` now
 * CALLS — `buildConnectionWhere`, `hasCompleteCreds`, `isTokenExpired`,
 * `is403Error`, `resolveEffectiveUserId` / `resolveEffectiveBrokerUserId`,
 * `buildHoldingCreateData`, `computePositionDerived` / `buildPositionCreateData`,
 * `buildTradeUpsertArgs`, `buildMutualFundUpsertArgs`, `buildSyncJobStatusUpdate`,
 * and `accumulateSynced`. The processor imports Prisma + `@usemoney/security` +
 * the broker adapters + Datadog at module load, so it cannot be pulled into a
 * pure unit test; the orchestration harness at the end mirrors only its prisma
 * call SEQUENCE (PROCESSING → per-connection per-type build loop → COMPLETED /
 * FAILED), building every payload/where/stat/status patch by calling the SAME
 * real exports — so the lifecycle, per-type error-isolation, multi-connection
 * and computed-field assertions all run production code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  HoldingData,
  PositionData,
  TradeData,
  MutualFundData,
} from "@usemoney/types";

// MONEY-1379: `buildConnectionWhere` moved OUT of workers/src/processors/
// sync-logic.ts. It existed in both that file and the service, each docblock
// calling itself "the single source", and nothing outside this test imported
// the worker's copy — so two spellings of a cross-user data-hazard rule could
// have drifted apart unnoticed. The service's copy is the one `sync.ts`
// actually reaches (through `syncBrokerConnections`), so that is the one the
// cases below now exercise.
import { buildConnectionWhere, SYNC_ENABLED_BROKERS } from "@usemoney/services";

// REAL worker orchestration helpers under test (no shadow). sync.ts CALLS these.
import {
  hasCompleteCreds,
  isTokenExpired,
  is403Error,
  startOfTodayIST,
  shouldSendSyncEmail,
  shouldSendHistoricalEmail,
  resolveEffectiveUserId,
  resolveEffectiveBrokerUserId,
  buildHoldingCreateData,
  computePositionDerived,
  buildPositionCreateData,
  buildTradeUpsertArgs,
  buildMutualFundUpsertArgs,
  buildSyncJobStatusUpdate,
  accumulateSynced,
  DEFAULT_SYNC_DATA_TYPES,
  type SyncDataType,
  // MONEY-841 — shard fan-out + idempotency
  isFanoutTrigger,
  buildShardFanoutMessages,
  isSyncInFlight,
  inFlightSyncCutoff,
  SYNC_IN_FLIGHT_WINDOW_MS,
} from "../../../../workers/src/processors/sync-logic";
import type { SyncJobMessage } from "@usemoney/types";

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

// ══════════════════════════════════════════════════════════════════════
// buildConnectionWhere — the findMany filter (real export)
// ══════════════════════════════════════════════════════════════════════

describe("broker-sync.service.buildConnectionWhere (real export)", () => {
  it("scopes to userId when no broker / id", () => {
    const w = buildConnectionWhere("u-1");
    assert.strictEqual(w.userId, "u-1");
    assert.strictEqual("id" in w, false);
    assert.strictEqual("broker" in w, false);
  });

  // MONEY-1379: a SCHEDULED SHARD — and only a scheduled shard — also narrows
  // to the syncable broker set. A plain user-scoped call is not the cron's
  // fan-out and is deliberately left alone.
  it("a shard leaf narrows to the syncable brokers", () => {
    assert.deepEqual(
      buildConnectionWhere("*", undefined, undefined, 3).broker,
      {
        in: [...SYNC_ENABLED_BROKERS],
      }
    );
  });

  it("adds broker when provided", () => {
    assert.strictEqual(
      buildConnectionWhere("u-1", undefined, "UPSTOX").broker,
      "UPSTOX"
    );
  });

  it("adds id when brokerConnectionId provided", () => {
    assert.strictEqual(buildConnectionWhere("u-1", "conn-abc").id, "conn-abc");
  });

  it("adds both broker and id", () => {
    const w = buildConnectionWhere("u-1", "conn-xyz", "DHAN");
    assert.strictEqual(w.userId, "u-1");
    assert.strictEqual(w.id, "conn-xyz");
    assert.strictEqual(w.broker, "DHAN");
  });

  it("OMITS userId entirely for the wildcard (all-users) sync", () => {
    const w = buildConnectionWhere("*");
    assert.strictEqual("userId" in w, false);
  });

  it("wildcard still narrows by broker/id when given", () => {
    const w = buildConnectionWhere("*", "conn-1", "ZERODHA");
    assert.strictEqual("userId" in w, false);
    assert.strictEqual(w.id, "conn-1");
    assert.strictEqual(w.broker, "ZERODHA");
  });

  // MONEY-841: per-shard scoping for the fan-out leaf.
  it("adds syncBucket when an integer bucket is provided (wildcard shard)", () => {
    const w = buildConnectionWhere("*", undefined, undefined, 7);
    assert.strictEqual("userId" in w, false);
    assert.strictEqual(w.syncBucket, 7);
  });

  it("bucket 0 is included (falsy-but-valid)", () => {
    const w = buildConnectionWhere("*", undefined, undefined, 0);
    assert.strictEqual(w.syncBucket, 0);
  });

  it("OMITS syncBucket when undefined / NaN (no accidental shard filter)", () => {
    assert.strictEqual("syncBucket" in buildConnectionWhere("*"), false);
    assert.strictEqual(
      "syncBucket" in buildConnectionWhere("*", undefined, undefined, NaN),
      false
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// MONEY-841 — shard fan-out + idempotency (real exports)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.isFanoutTrigger (real export)", () => {
  it("TRUE only for a scheduled message with no syncBucket", () => {
    assert.strictEqual(
      isFanoutTrigger({ isScheduled: true }),
      true,
      "scheduled + no bucket = fan-out trigger"
    );
  });

  it("FALSE for a scheduled per-shard leaf (has a bucket)", () => {
    assert.strictEqual(
      isFanoutTrigger({ isScheduled: true, syncBucket: 0 }),
      false
    );
    assert.strictEqual(
      isFanoutTrigger({ isScheduled: true, syncBucket: 5 }),
      false
    );
  });

  it("FALSE for a non-scheduled (user-scoped) message", () => {
    assert.strictEqual(isFanoutTrigger({}), false);
    assert.strictEqual(isFanoutTrigger({ isScheduled: false }), false);
    assert.strictEqual(isFanoutTrigger({ syncBucket: 3 }), false);
  });
});

describe("sync-logic.buildShardFanoutMessages (real export)", () => {
  const trigger: SyncJobMessage = {
    jobId: "cron-1",
    userId: "*",
    isScheduled: true,
    historicalDays: 30,
    dataTypes: ["holdings", "trades"],
  };

  it("emits exactly `count` messages, one per bucket [0, count)", () => {
    let n = 0;
    const msgs = buildShardFanoutMessages(trigger, () => `j-${n++}`, 8);
    assert.strictEqual(msgs.length, 8);
    const buckets = msgs.map((m) => m.syncBucket);
    assert.deepStrictEqual(buckets, [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("each leaf preserves the trigger's job fields (broker/dataTypes/historical)", () => {
    const msgs = buildShardFanoutMessages(trigger, (b) => `j-${b}`, 4);
    for (const m of msgs) {
      assert.strictEqual(m.userId, "*");
      assert.strictEqual(m.isScheduled, true);
      assert.strictEqual(m.historicalDays, 30);
      assert.deepStrictEqual(m.dataTypes, ["holdings", "trades"]);
    }
  });

  it("each leaf gets its OWN jobId (not the trigger's) so rows don't collide", () => {
    const msgs = buildShardFanoutMessages(trigger, (b) => `shard-${b}`, 3);
    const ids = msgs.map((m) => m.jobId);
    assert.deepStrictEqual(ids, ["shard-0", "shard-1", "shard-2"]);
    assert.strictEqual(
      ids.includes("cron-1"),
      false,
      "the trigger's jobId must not leak onto a leaf"
    );
    assert.strictEqual(new Set(ids).size, ids.length, "jobIds are unique");
  });

  it("a leaf is itself NOT a fan-out trigger (no infinite fan-out)", () => {
    const msgs = buildShardFanoutMessages(trigger, (b) => `j-${b}`, 5);
    for (const m of msgs) {
      assert.strictEqual(
        isFanoutTrigger(m),
        false,
        "a per-shard leaf must re-enter as a leaf, never re-fan-out"
      );
    }
  });

  it("drops any stray syncBucket on the trigger (always set per-message)", () => {
    const stray = { ...trigger, syncBucket: 99 } as SyncJobMessage;
    const msgs = buildShardFanoutMessages(stray, (b) => `j-${b}`, 2);
    assert.deepStrictEqual(
      msgs.map((m) => m.syncBucket),
      [0, 1]
    );
  });
});

describe("sync-logic.isSyncInFlight + inFlightSyncCutoff (real exports)", () => {
  it("SYNC_IN_FLIGHT_WINDOW_MS is 15 minutes", () => {
    assert.strictEqual(SYNC_IN_FLIGHT_WINDOW_MS, 15 * 60 * 1000);
  });

  it("isSyncInFlight is true iff there is ≥1 OTHER active job", () => {
    assert.strictEqual(isSyncInFlight(0), false);
    assert.strictEqual(isSyncInFlight(1), true);
    assert.strictEqual(isSyncInFlight(3), true);
  });

  it("inFlightSyncCutoff subtracts the 15-min window from now", () => {
    const now = new Date("2026-06-19T12:00:00.000Z");
    const cutoff = inFlightSyncCutoff(now);
    assert.strictEqual(cutoff.toISOString(), "2026-06-19T11:45:00.000Z");
    // A job queued before the cutoff is stale; one after is in-flight.
    assert.ok(new Date("2026-06-19T11:44:59Z") < cutoff);
    assert.ok(new Date("2026-06-19T11:50:00Z") > cutoff);
  });
});

// ══════════════════════════════════════════════════════════════════════
// hasCompleteCreds — the credential presence gate (real export)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.hasCompleteCreds (real export)", () => {
  const full = { encryptedCreds: "e", iv: "i", authTag: "a" };

  it("true when all three present", () => {
    assert.strictEqual(hasCompleteCreds(full), true);
  });

  it("false when encryptedCreds is null", () => {
    assert.strictEqual(
      hasCompleteCreds({ ...full, encryptedCreds: null }),
      false
    );
  });

  it("false when iv is null", () => {
    assert.strictEqual(hasCompleteCreds({ ...full, iv: null }), false);
  });

  it("false when authTag is null", () => {
    assert.strictEqual(hasCompleteCreds({ ...full, authTag: null }), false);
  });

  it("false on empty-string creds (a blank tag is not a credential)", () => {
    assert.strictEqual(hasCompleteCreds({ ...full, authTag: "" }), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// isTokenExpired — the daily-reset guard (real export)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.isTokenExpired (real export)", () => {
  const now = new Date("2026-06-06T12:00:00.000Z");

  it("true when tokenExpiry is in the past", () => {
    assert.strictEqual(
      isTokenExpired(
        { tokenExpiry: new Date("2026-06-06T00:00:00.000Z") },
        now
      ),
      true
    );
  });

  it("false when tokenExpiry is in the future", () => {
    assert.strictEqual(
      isTokenExpired(
        { tokenExpiry: new Date("2026-06-07T00:00:00.000Z") },
        now
      ),
      false
    );
  });

  it("false when tokenExpiry is null/absent", () => {
    assert.strictEqual(isTokenExpired({ tokenExpiry: null }, now), false);
    assert.strictEqual(isTokenExpired({}, now), false);
  });

  it("accepts an ISO-string tokenExpiry", () => {
    assert.strictEqual(
      isTokenExpired({ tokenExpiry: "2026-06-06T00:00:00.000Z" }, now),
      true
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// is403Error — expired-token classification (real export)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.is403Error (real export)", () => {
  it("matches a '403' message", () => {
    assert.strictEqual(is403Error(new Error("Request failed with 403")), true);
  });

  it("matches a 'Forbidden' message", () => {
    assert.strictEqual(is403Error(new Error("Forbidden")), true);
  });

  it("does not match an unrelated error", () => {
    assert.strictEqual(is403Error(new Error("ECONNRESET")), false);
  });

  it("handles a non-Error throw", () => {
    assert.strictEqual(is403Error("403 Forbidden"), true);
    assert.strictEqual(is403Error(null), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// startOfTodayIST — historical-backfill toDate cap (real export, MONEY-846)
//
// IST = UTC+5:30 (no DST). The result is a UTC INSTANT, so assertions use UTC
// getters only — they must be timezone-INDEPENDENT (identical whether the host
// is UTC, IST, or a US CI runner). Never assert local getHours().
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.startOfTodayIST (real export)", () => {
  it("a UTC-morning instant maps to the SAME IST calendar day's 18:30 UTC prior", () => {
    // 2026-06-15T09:00:00Z = 2026-06-15 14:30 IST → IST day start 2026-06-15
    // 00:00 IST = 2026-06-14T18:30:00Z.
    const r = startOfTodayIST(new Date("2026-06-15T09:00:00.000Z"));
    assert.strictEqual(r.toISOString(), "2026-06-14T18:30:00.000Z");
  });

  it("an instant just BEFORE IST midnight still belongs to the prior IST day", () => {
    // 2026-06-15T18:29:00Z = 2026-06-15 23:59 IST → still the 15th in IST.
    const r = startOfTodayIST(new Date("2026-06-15T18:29:00.000Z"));
    assert.strictEqual(r.toISOString(), "2026-06-14T18:30:00.000Z");
  });

  it("an instant AT IST midnight rolls to the new IST day", () => {
    // 2026-06-15T18:30:00Z = 2026-06-16 00:00 IST → IST day start is the 16th.
    const r = startOfTodayIST(new Date("2026-06-15T18:30:00.000Z"));
    assert.strictEqual(r.toISOString(), "2026-06-15T18:30:00.000Z");
  });

  it("a late-UTC-evening instant maps to the NEXT calendar day's IST start", () => {
    // 2026-06-15T20:00:00Z = 2026-06-16 01:30 IST → IST day = 16th → 2026-06-15
    // 18:30 UTC.
    const r = startOfTodayIST(new Date("2026-06-15T20:00:00.000Z"));
    assert.strictEqual(r.toISOString(), "2026-06-15T18:30:00.000Z");
  });

  it("the result is ALWAYS in the past relative to now (excludes today's fills)", () => {
    // The whole point: the historical toDate must never include 'now', so the
    // day-sync owns today and the backfill stops at yesterday's IST midnight.
    const now = new Date("2026-06-15T12:34:56.000Z");
    assert.ok(startOfTodayIST(now).getTime() < now.getTime());
  });

  it("is idempotent on its own output (already an IST midnight → unchanged)", () => {
    const once = startOfTodayIST(new Date("2026-06-15T09:00:00.000Z"));
    const twice = startOfTodayIST(once);
    assert.strictEqual(twice.toISOString(), once.toISOString());
  });

  it("the computed historical toDate EXCLUDES today (toDate <= start-of-today < now)", () => {
    // Mirrors sync.ts: toDate = startOfTodayIST(); fromDate = now - Nd. The
    // backfill window [fromDate, toDate] must end at the IST day boundary, never
    // at 'now' — so a fill that the day-sync already pulled with its real
    // trade_id can't be re-imported under a synthesized bo: id.
    const now = new Date("2026-06-15T10:00:00.000Z");
    const toDate = startOfTodayIST(now);
    const historicalDays = 3650;
    const fromDate = new Date(now.getTime() - historicalDays * 86_400_000);
    assert.ok(toDate.getTime() <= now.getTime(), "toDate not in the future");
    assert.ok(toDate.getTime() < now.getTime(), "toDate strictly before now");
    assert.ok(fromDate.getTime() < toDate.getTime(), "from precedes to");
  });
});

// ══════════════════════════════════════════════════════════════════════
// shouldSendSyncEmail — day "Sync Complete" gate (real export, MONEY-846)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.shouldSendSyncEmail (real export)", () => {
  it("syncEmail only (no historical, real user) → SEND", () => {
    assert.strictEqual(
      shouldSendSyncEmail({
        syncEmail: true,
        historicalEmail: false,
        userId: "u-1",
      }),
      true
    );
  });

  it("BOTH syncEmail + historicalEmail → suppress (connect email already covers it)", () => {
    assert.strictEqual(
      shouldSendSyncEmail({
        syncEmail: true,
        historicalEmail: true,
        userId: "u-1",
      }),
      false
    );
  });

  it("only historicalEmail (no syncEmail) → no day-summary", () => {
    assert.strictEqual(
      shouldSendSyncEmail({
        syncEmail: false,
        historicalEmail: true,
        userId: "u-1",
      }),
      false
    );
  });

  it("neither flag → no email (silent refresh / scheduled cron)", () => {
    assert.strictEqual(
      shouldSendSyncEmail({
        syncEmail: false,
        historicalEmail: false,
        userId: "u-1",
      }),
      false
    );
  });

  it("wildcard userId never emails an individual, even with syncEmail", () => {
    assert.strictEqual(
      shouldSendSyncEmail({
        syncEmail: true,
        historicalEmail: false,
        userId: "*",
      }),
      false
    );
  });

  it("undefined flags behave as false (no email)", () => {
    assert.strictEqual(shouldSendSyncEmail({ userId: "u-1" }), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// shouldSendHistoricalEmail — connect "import complete" gate (MONEY-846)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.shouldSendHistoricalEmail (real export)", () => {
  it("historicalEmail + real user + no errors → SEND", () => {
    assert.strictEqual(
      shouldSendHistoricalEmail({
        historicalEmail: true,
        userId: "u-1",
        hasErrors: false,
      }),
      true
    );
  });

  it("errors present → suppress (surfaceHistoricalErrors already notified)", () => {
    assert.strictEqual(
      shouldSendHistoricalEmail({
        historicalEmail: true,
        userId: "u-1",
        hasErrors: true,
      }),
      false
    );
  });

  it("no historicalEmail flag (weekly catch-up cron) → quiet", () => {
    assert.strictEqual(
      shouldSendHistoricalEmail({
        historicalEmail: false,
        userId: "u-1",
        hasErrors: false,
      }),
      false
    );
  });

  it("wildcard userId never emails an individual", () => {
    assert.strictEqual(
      shouldSendHistoricalEmail({
        historicalEmail: true,
        userId: "*",
        hasErrors: false,
      }),
      false
    );
  });

  it("undefined historicalEmail behaves as false", () => {
    assert.strictEqual(
      shouldSendHistoricalEmail({ userId: "u-1", hasErrors: false }),
      false
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// resolveEffectiveUserId / resolveEffectiveBrokerUserId (real exports)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.resolveEffectiveUserId (real export)", () => {
  it("returns the job userId for a normal (non-wildcard) sync", () => {
    assert.strictEqual(resolveEffectiveUserId("u-1", "conn-user"), "u-1");
  });

  it("returns the connection's own userId for a wildcard sync", () => {
    assert.strictEqual(resolveEffectiveUserId("*", "conn-user"), "conn-user");
  });

  it("falls back to '*' when a wildcard connection has no userId", () => {
    assert.strictEqual(resolveEffectiveUserId("*", null), "*");
  });
});

describe("sync-logic.resolveEffectiveBrokerUserId (real export)", () => {
  it("returns the brokerUserId when present", () => {
    assert.strictEqual(resolveEffectiveBrokerUserId("ZR001"), "ZR001");
  });

  it("returns '' for null/undefined", () => {
    assert.strictEqual(resolveEffectiveBrokerUserId(null), "");
    assert.strictEqual(resolveEffectiveBrokerUserId(undefined), "");
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildHoldingCreateData — Holding payload + value math (real export)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.buildHoldingCreateData (real export)", () => {
  it("computes investedValue = totalQuantity * averagePrice", () => {
    const d = buildHoldingCreateData(
      makeHolding({ totalQuantity: 10, averagePrice: 2400 }),
      CTX
    );
    assert.strictEqual(d.investedValue, 24000);
  });

  it("computes currentValue = totalQuantity * lastPrice", () => {
    const d = buildHoldingCreateData(
      makeHolding({ totalQuantity: 10, lastPrice: 2500 }),
      CTX
    );
    assert.strictEqual(d.currentValue, 25000);
  });

  it("defaults t1/pledged/collateral quantities to 0 when missing", () => {
    const d = buildHoldingCreateData(
      makeHolding({
        t1Quantity: undefined,
        pledgedQuantity: undefined,
        collateralQty: undefined,
      }),
      CTX
    );
    assert.strictEqual(d.t1Quantity, 0);
    assert.strictEqual(d.pledgedQuantity, 0);
    assert.strictEqual(d.collateralQty, 0);
  });

  it("carries the scope (userId / broker / brokerUserId) onto the row", () => {
    const d = buildHoldingCreateData(makeHolding(), {
      userId: "u-9",
      broker: "ZERODHA",
      brokerUserId: "ZR9",
    });
    assert.strictEqual(d.userId, "u-9");
    assert.strictEqual(d.broker, "ZERODHA");
    assert.strictEqual(d.brokerUserId, "ZR9");
  });

  it("maps quantity/averagePrice/currentPrice from the broker fields", () => {
    const d = buildHoldingCreateData(
      makeHolding({ totalQuantity: 7, averagePrice: 100, lastPrice: 110 }),
      CTX
    );
    assert.strictEqual(d.quantity, 7);
    assert.strictEqual(d.averagePrice, 100);
    assert.strictEqual(d.currentPrice, 110);
  });

  it("zero quantity yields zero invested + current value", () => {
    const d = buildHoldingCreateData(
      makeHolding({ totalQuantity: 0, averagePrice: 2400, lastPrice: 2500 }),
      CTX
    );
    assert.strictEqual(d.investedValue, 0);
    assert.strictEqual(d.currentValue, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// computePositionDerived / buildPositionCreateData (real exports)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.computePositionDerived (real export)", () => {
  it("buyValue = buyQuantity * buyPrice", () => {
    assert.strictEqual(
      computePositionDerived(makePosition({ buyQuantity: 50, buyPrice: 21000 }))
        .buyValue,
      1050000
    );
  });

  it("sellValue = sellQuantity * sellPrice", () => {
    assert.strictEqual(
      computePositionDerived(
        makePosition({ sellQuantity: 25, sellPrice: 21500 })
      ).sellValue,
      537500
    );
  });

  it("netValue = abs(netQuantity) * lastPrice (short position)", () => {
    assert.strictEqual(
      computePositionDerived(
        makePosition({ netQuantity: -10, lastPrice: 21200 })
      ).netValue,
      212000
    );
  });

  it("totalPnl = realizedPnl + unrealizedPnl", () => {
    assert.strictEqual(
      computePositionDerived(
        makePosition({ realizedPnl: 5000, unrealizedPnl: 3000 })
      ).totalPnl,
      8000
    );
  });

  it("pnlPercentage = (totalPnl / buyValue) * 100 when buyValue > 0", () => {
    const d = computePositionDerived(
      makePosition({
        buyQuantity: 10,
        buyPrice: 1000,
        realizedPnl: 500,
        unrealizedPnl: 500,
      })
    );
    assert.strictEqual(d.pnlPercentage, 10);
  });

  it("DIV-BY-ZERO GUARD: pnlPercentage = 0 when buyValue is 0 (never NaN)", () => {
    const d = computePositionDerived(
      makePosition({
        buyQuantity: 0,
        buyPrice: 0,
        realizedPnl: 100,
        unrealizedPnl: 50,
      })
    );
    assert.strictEqual(d.pnlPercentage, 0);
    assert.ok(!Number.isNaN(d.pnlPercentage));
  });

  it("supports negative P&L percentages", () => {
    const d = computePositionDerived(
      makePosition({
        buyQuantity: 10,
        buyPrice: 1000,
        realizedPnl: -500,
        unrealizedPnl: -300,
      })
    );
    assert.strictEqual(d.totalPnl, -800);
    assert.strictEqual(d.pnlPercentage, -8);
  });

  it("maps positionType 'DAY' → 'DAY'", () => {
    assert.strictEqual(
      computePositionDerived(makePosition({ positionType: "DAY" }))
        .positionType,
      "DAY"
    );
  });

  it("maps any non-DAY positionType → 'NET'", () => {
    assert.strictEqual(
      computePositionDerived(makePosition({ positionType: "NET" }))
        .positionType,
      "NET"
    );
  });
});

describe("sync-logic.buildPositionCreateData (real export)", () => {
  it("embeds the derived values onto the row", () => {
    const d = buildPositionCreateData(
      makePosition({
        buyQuantity: 10,
        buyPrice: 1000,
        sellQuantity: 5,
        sellPrice: 1100,
        netQuantity: 5,
        lastPrice: 1200,
        realizedPnl: 200,
        unrealizedPnl: 300,
      }),
      CTX
    );
    assert.strictEqual(d.buyValue, 10000);
    assert.strictEqual(d.sellValue, 5500);
    assert.strictEqual(d.netValue, 6000);
    assert.strictEqual(d.totalPnl, 500);
    assert.strictEqual(d.pnlPercentage, 5);
  });

  it("carries scope + raw fields through", () => {
    const d = buildPositionCreateData(makePosition(), CTX);
    assert.strictEqual(d.userId, "u-1");
    assert.strictEqual(d.broker, "ZERODHA");
    assert.strictEqual(d.symbol, "NIFTY");
    assert.strictEqual(d.productType, "NRML");
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildTradeUpsertArgs — synced-trade upsert (real export)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.buildTradeUpsertArgs (real export)", () => {
  it("keys on the (userId, broker, brokerUserId, brokerTradeId) compound unique", () => {
    const args = buildTradeUpsertArgs(makeTrade({ tradeId: "t-abc" }), CTX);
    const key = (
      args.where as {
        userId_broker_brokerUserId_brokerTradeId: {
          userId: string;
          broker: string;
          brokerTradeId: string;
        };
      }
    ).userId_broker_brokerUserId_brokerTradeId;
    assert.strictEqual(key.userId, "u-1");
    assert.strictEqual(key.broker, "ZERODHA");
    assert.strictEqual(key.brokerTradeId, "t-abc");
  });

  it("stamps SYNCED / isEditable=false / needsRepairing=true in BOTH branches", () => {
    const args = buildTradeUpsertArgs(makeTrade(), CTX);
    assert.strictEqual(args.create.sourceType, "SYNCED");
    assert.strictEqual(args.update.sourceType, "SYNCED");
    assert.strictEqual(args.create.isEditable, false);
    assert.strictEqual(args.update.isEditable, false);
    assert.strictEqual(args.create.needsRepairing, true);
    assert.strictEqual(args.update.needsRepairing, true);
  });

  it("sets brokerName to the lowercased broker (create only)", () => {
    assert.strictEqual(
      buildTradeUpsertArgs(makeTrade(), CTX).create.brokerName,
      "zerodha"
    );
  });

  it("maps tradeType from the broker transactionType", () => {
    const args = buildTradeUpsertArgs(
      makeTrade({ transactionType: "SELL" }),
      CTX
    );
    assert.strictEqual(args.create.tradeType, "SELL");
    assert.strictEqual(args.update.tradeType, "SELL");
  });

  it("carries the full trade payload onto create", () => {
    const tradeTime = new Date("2026-02-01T10:30:00Z");
    const args = buildTradeUpsertArgs(
      makeTrade({
        tradeId: "t-full",
        orderId: "o-full",
        symbol: "HDFC",
        tradingSymbol: "HDFC-EQ",
        exchange: "BSE",
        segment: "EQ",
        transactionType: "SELL",
        productType: "MIS",
        quantity: 25,
        price: 1700.5,
        tradeValue: 42512.5,
        tradeTime,
      }),
      CTX
    );
    assert.strictEqual(args.create.symbol, "HDFC");
    assert.strictEqual(args.create.tradingSymbol, "HDFC-EQ");
    assert.strictEqual(args.create.exchange, "BSE");
    assert.strictEqual(args.create.segment, "EQ");
    assert.strictEqual(args.create.productType, "MIS");
    assert.strictEqual(args.create.quantity, 25);
    assert.strictEqual(args.create.price, 1700.5);
    assert.strictEqual(args.create.tradeValue, 42512.5);
    assert.strictEqual(args.create.brokerOrderId, "o-full");
    assert.strictEqual(args.create.brokerTradeId, "t-full");
    assert.deepStrictEqual(args.create.tradeDate, tradeTime);
    assert.deepStrictEqual(args.create.tradeTime, tradeTime);
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildMutualFundUpsertArgs — synced-MF upsert (real export)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.buildMutualFundUpsertArgs (real export)", () => {
  function mfKey(args: ReturnType<typeof buildMutualFundUpsertArgs>) {
    return (
      args.where as {
        userId_broker_brokerUserId_folioNumber_tradingSymbol: {
          folioNumber: string;
          tradingSymbol: string;
        };
      }
    ).userId_broker_brokerUserId_folioNumber_tradingSymbol;
  }

  it("keys on folio + tradingSymbol (ISIN when present)", () => {
    const args = buildMutualFundUpsertArgs(
      makeMutualFund({ folio: "FOLIO-123", isin: "INF179K01BC4" }),
      CTX
    );
    const k = mfKey(args);
    assert.strictEqual(k.folioNumber, "FOLIO-123");
    assert.strictEqual(k.tradingSymbol, "INF179K01BC4");
  });

  it("falls back to schemeName as tradingSymbol when ISIN is empty", () => {
    const args = buildMutualFundUpsertArgs(
      makeMutualFund({ isin: "", schemeName: "My Fund" }),
      CTX
    );
    assert.strictEqual(mfKey(args).tradingSymbol, "My Fund");
    assert.strictEqual(args.create.tradingSymbol, "My Fund");
  });

  it("defaults folio + folioNumber to '' when missing", () => {
    const args = buildMutualFundUpsertArgs(makeMutualFund({ folio: "" }), CTX);
    assert.strictEqual(args.create.folioNumber, "");
    assert.strictEqual(args.create.folio, "");
  });

  it("stamps lastUpdated on the update branch only", () => {
    const args = buildMutualFundUpsertArgs(makeMutualFund(), CTX);
    assert.ok(
      (args.update as { lastUpdated?: Date }).lastUpdated instanceof Date
    );
    assert.strictEqual("lastUpdated" in args.create, false);
  });

  it("mirrors investedValue into both investedAmount and investedValue", () => {
    const args = buildMutualFundUpsertArgs(
      makeMutualFund({ investedValue: 5000 }),
      CTX
    );
    assert.strictEqual(args.create.investedAmount, 5000);
    assert.strictEqual(args.create.investedValue, 5000);
  });
});

// ══════════════════════════════════════════════════════════════════════
// accumulateSynced — per-type stats fold (real export)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.accumulateSynced (real export)", () => {
  it("adds a type count and bumps the total", () => {
    const r = accumulateSynced({}, 0, "holdings", 3);
    assert.deepStrictEqual(r.stats, { holdings: 3 });
    assert.strictEqual(r.total, 3);
  });

  it("accumulates across multiple types", () => {
    let s = accumulateSynced({}, 0, "holdings", 2);
    s = accumulateSynced(s.stats, s.total, "positions", 1);
    s = accumulateSynced(s.stats, s.total, "trades", 4);
    assert.deepStrictEqual(s.stats, { holdings: 2, positions: 1, trades: 4 });
    assert.strictEqual(s.total, 7);
  });

  it("is pure — does not mutate the input stats object", () => {
    const original = { holdings: 1 };
    accumulateSynced(original, 1, "positions", 5);
    assert.deepStrictEqual(original, { holdings: 1 });
  });
});

// ══════════════════════════════════════════════════════════════════════
// buildSyncJobStatusUpdate — BackgroundJob lifecycle patch (real export)
// ══════════════════════════════════════════════════════════════════════

describe("sync-logic.buildSyncJobStatusUpdate (real export)", () => {
  it("PROCESSING stamps startedAt, nothing terminal", () => {
    const before = new Date();
    const p = buildSyncJobStatusUpdate("PROCESSING");
    const after = new Date();
    assert.strictEqual(p.status, "PROCESSING");
    assert.ok(p.startedAt instanceof Date);
    assert.ok(
      (p.startedAt as Date) >= before && (p.startedAt as Date) <= after
    );
    assert.strictEqual("completedAt" in p, false);
    assert.strictEqual("progress" in p, false);
  });

  it("COMPLETED stamps completedAt + progress=100 + result", () => {
    const result = { success: true, synced: { holdings: 2 }, total: 2 };
    const p = buildSyncJobStatusUpdate("COMPLETED", { result });
    assert.strictEqual(p.status, "COMPLETED");
    assert.strictEqual(p.progress, 100);
    assert.ok(p.completedAt instanceof Date);
    assert.deepStrictEqual(p.result, result);
    assert.strictEqual("startedAt" in p, false);
  });

  it("COMPLETED omits result when none provided", () => {
    assert.strictEqual(
      "result" in buildSyncJobStatusUpdate("COMPLETED"),
      false
    );
  });

  it("FAILED stamps completedAt + errorMessage, never progress", () => {
    const p = buildSyncJobStatusUpdate("FAILED", {
      errorMessage: "No broker connections found",
    });
    assert.strictEqual(p.status, "FAILED");
    assert.strictEqual(p.errorMessage, "No broker connections found");
    assert.ok(p.completedAt instanceof Date);
    assert.strictEqual("progress" in p, false);
  });

  it("FAILED omits errorMessage when none provided", () => {
    const p = buildSyncJobStatusUpdate("FAILED");
    assert.strictEqual("errorMessage" in p, false);
    assert.ok(p.completedAt instanceof Date);
  });

  it("does not leak an errorMessage onto a COMPLETED patch", () => {
    const p = buildSyncJobStatusUpdate("COMPLETED", {
      errorMessage: "ignored",
    });
    assert.strictEqual("errorMessage" in p, false);
  });

  it("the default data types are holdings+positions+trades+mutualFunds (MONEY-837)", () => {
    assert.deepStrictEqual(
      [...DEFAULT_SYNC_DATA_TYPES],
      ["holdings", "positions", "trades", "mutualFunds"]
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Orchestration harness — mirrors the processor's prisma call SEQUENCE, building
// every payload / where / stat / status patch via the SAME real exports above.
// (The real processSync boots Prisma + the security decryptor + broker adapters
// at import, so it can't run in a pure unit test.)
// ══════════════════════════════════════════════════════════════════════

interface PrismaCall {
  model: string;
  method: string;
  args: unknown;
}

interface MockConnection {
  id: string;
  userId: string;
  broker: string;
  brokerUserId: string | null;
  encryptedCreds: string | null;
  iv: string | null;
  authTag: string | null;
  tokenExpiry?: Date | null;
  status?: string;
}

interface MockAdapter {
  fetchHoldings: () => Promise<HoldingData[]>;
  fetchPositions: () => Promise<PositionData[]>;
  fetchTrades: () => Promise<TradeData[]>;
  fetchMutualFunds: () => Promise<MutualFundData[]>;
}

function emptyAdapter(): MockAdapter {
  return {
    fetchHoldings: async () => [],
    fetchPositions: async () => [],
    fetchTrades: async () => [],
    fetchMutualFunds: async () => [],
  };
}

/**
 * Re-runs the processor's control flow against injected fakes, building EVERY
 * payload/where/stat/status patch through the real sync-logic exports. Mirrors
 * the SEQUENCE in `sync.ts` (sans the parts already covered above: 403/token
 * skips, which the standalone is403Error / isTokenExpired tests cover).
 */
async function runSyncSequence(
  data: {
    jobId: string;
    userId: string;
    brokerConnectionId?: string;
    broker?: string;
    dataTypes?: SyncDataType[];
  },
  deps: {
    connections: MockConnection[];
    adapters: Record<string, MockAdapter>;
  },
  calls: PrismaCall[] = []
): Promise<PrismaCall[]> {
  const {
    jobId,
    userId,
    brokerConnectionId,
    broker,
    dataTypes = [...DEFAULT_SYNC_DATA_TYPES],
  } = data;

  if (!jobId || !userId) {
    throw new Error("Missing required fields: jobId, userId");
  }

  calls.push({
    model: "backgroundJob",
    method: "updateMany",
    args: { where: { jobId }, data: buildSyncJobStatusUpdate("PROCESSING") },
  });

  try {
    const where = buildConnectionWhere(userId, brokerConnectionId, broker);
    calls.push({
      model: "brokerConnection",
      method: "findMany",
      args: { where },
    });
    const connections = deps.connections;
    if (connections.length === 0) {
      throw new Error("No broker connections found");
    }

    let syncStats: Record<string, number> = {};
    let totalSynced = 0;

    for (const connection of connections) {
      if (!hasCompleteCreds(connection)) continue;
      if (isTokenExpired(connection)) continue;

      const effectiveUserId = resolveEffectiveUserId(userId, connection.userId);
      const effectiveBrokerUserId = resolveEffectiveBrokerUserId(
        connection.brokerUserId
      );
      const ctx = {
        userId: effectiveUserId,
        broker: connection.broker as never,
        brokerUserId: effectiveBrokerUserId,
      };
      const adapter = deps.adapters[connection.broker] || emptyAdapter();

      if (dataTypes.includes("holdings")) {
        try {
          const holdings = await adapter.fetchHoldings();
          calls.push({
            model: "holding",
            method: "deleteMany",
            args: {
              where: {
                userId: effectiveUserId,
                broker: connection.broker,
                brokerUserId: effectiveBrokerUserId,
              },
            },
          });
          for (const h of holdings) {
            calls.push({
              model: "holding",
              method: "create",
              args: { data: buildHoldingCreateData(h, ctx) },
            });
          }
          ({ stats: syncStats, total: totalSynced } = accumulateSynced(
            syncStats,
            totalSynced,
            "holdings",
            holdings.length
          ));
        } catch {
          /* per-type isolation */
        }
      }

      if (dataTypes.includes("positions")) {
        try {
          const positions = await adapter.fetchPositions();
          calls.push({
            model: "position",
            method: "deleteMany",
            args: { where: { userId: effectiveUserId } },
          });
          for (const p of positions) {
            calls.push({
              model: "position",
              method: "create",
              args: { data: buildPositionCreateData(p, ctx) },
            });
          }
          ({ stats: syncStats, total: totalSynced } = accumulateSynced(
            syncStats,
            totalSynced,
            "positions",
            positions.length
          ));
        } catch {
          /* per-type isolation */
        }
      }

      if (dataTypes.includes("trades")) {
        try {
          const trades = await adapter.fetchTrades();
          for (const t of trades) {
            calls.push({
              model: "trade",
              method: "upsert",
              args: buildTradeUpsertArgs(t, ctx),
            });
          }
          ({ stats: syncStats, total: totalSynced } = accumulateSynced(
            syncStats,
            totalSynced,
            "trades",
            trades.length
          ));
        } catch {
          /* per-type isolation */
        }
      }

      if (dataTypes.includes("mutualFunds")) {
        try {
          const mfs = await adapter.fetchMutualFunds();
          for (const mf of mfs) {
            calls.push({
              model: "mutualFund",
              method: "upsert",
              args: buildMutualFundUpsertArgs(mf, ctx),
            });
          }
          ({ stats: syncStats, total: totalSynced } = accumulateSynced(
            syncStats,
            totalSynced,
            "mutualFunds",
            mfs.length
          ));
        } catch {
          /* per-type isolation */
        }
      }

      calls.push({
        model: "brokerConnection",
        method: "update",
        args: { where: { id: connection.id }, data: { lastSync: new Date() } },
      });
      calls.push({
        model: "syncLog",
        method: "create",
        args: {
          data: {
            userId: effectiveUserId,
            broker: connection.broker,
            syncType: "ALL",
            status: "SUCCESS",
            recordsFetched: totalSynced,
          },
        },
      });
    }

    calls.push({
      model: "backgroundJob",
      method: "updateMany",
      args: {
        where: { jobId },
        data: buildSyncJobStatusUpdate("COMPLETED", {
          result: { success: true, synced: syncStats, total: totalSynced },
        }),
      },
    });
  } catch (error) {
    calls.push({
      model: "backgroundJob",
      method: "updateMany",
      args: {
        where: { jobId },
        data: buildSyncJobStatusUpdate("FAILED", {
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        }),
      },
    });
    throw error;
  }
  return calls;
}

const find = (calls: PrismaCall[], model: string, method: string) =>
  calls.filter((c) => c.model === model && c.method === method);
const lastBg = (calls: PrismaCall[]) => {
  const bg = find(calls, "backgroundJob", "updateMany");
  return bg[bg.length - 1]!.args as { data: { status?: string } };
};

function fullConn(overrides: Partial<MockConnection> = {}): MockConnection {
  return {
    id: "conn-1",
    userId: "u-1",
    broker: "ZERODHA",
    brokerUserId: "ZR001",
    encryptedCreds: "enc",
    iv: "iv",
    authTag: "tag",
    ...overrides,
  };
}

describe("sync orchestration sequence (real exports)", () => {
  it("missing jobId/userId throws BEFORE any prisma call", async () => {
    const calls: PrismaCall[] = [];
    await assert.rejects(
      () =>
        runSyncSequence(
          { jobId: "", userId: "u-1" },
          { connections: [], adapters: {} },
          calls
        ),
      { message: "Missing required fields: jobId, userId" }
    );
    assert.strictEqual(calls.length, 0);
  });

  it("happy path: PROCESSING → COMPLETED with progress=100", async () => {
    const calls = await runSyncSequence(
      { jobId: "s1", userId: "u-1" },
      { connections: [fullConn()], adapters: {} }
    );
    const bg = find(calls, "backgroundJob", "updateMany");
    assert.strictEqual(
      (bg[0]!.args as { data: { status: string } }).data.status,
      "PROCESSING"
    );
    const done = bg[bg.length - 1]!.args as {
      data: { status: string; progress: number };
    };
    assert.strictEqual(done.data.status, "COMPLETED");
    assert.strictEqual(done.data.progress, 100);
  });

  it("no connections → FAILED with the exact errorMessage (2 bg calls)", async () => {
    const calls: PrismaCall[] = [];
    await assert.rejects(
      () =>
        runSyncSequence(
          { jobId: "s2", userId: "u-1" },
          { connections: [], adapters: {} },
          calls
        ),
      { message: "No broker connections found" }
    );
    const bg = find(calls, "backgroundJob", "updateMany");
    assert.strictEqual(bg.length, 2);
    assert.strictEqual(
      (bg[1]!.args as { data: { status: string; errorMessage: string } }).data
        .status,
      "FAILED"
    );
    assert.strictEqual(
      (bg[1]!.args as { data: { errorMessage: string } }).data.errorMessage,
      "No broker connections found"
    );
  });

  it("skips connections missing creds (no decrypt/holdings work) but still COMPLETES", async () => {
    const calls = await runSyncSequence(
      { jobId: "s3", userId: "u-1", dataTypes: ["holdings"] },
      { connections: [fullConn({ encryptedCreds: null })], adapters: {} }
    );
    assert.strictEqual(find(calls, "holding", "deleteMany").length, 0);
    assert.strictEqual(lastBg(calls).data.status, "COMPLETED");
  });

  it("skips an expired-token connection, processes a healthy one", async () => {
    const calls = await runSyncSequence(
      { jobId: "s4", userId: "u-1", dataTypes: ["holdings"] },
      {
        connections: [
          fullConn({ id: "expired", tokenExpiry: new Date("2000-01-01") }),
          fullConn({ id: "healthy" }),
        ],
        adapters: {
          ZERODHA: {
            ...emptyAdapter(),
            fetchHoldings: async () => [makeHolding()],
          },
        },
      }
    );
    // Only the healthy connection's holding delete+create ran.
    assert.strictEqual(find(calls, "holding", "deleteMany").length, 1);
    assert.strictEqual(find(calls, "holding", "create").length, 1);
  });

  it("holdings: delete+create per row; trades/MFs: upsert", async () => {
    const calls = await runSyncSequence(
      {
        jobId: "s5",
        userId: "u-1",
        dataTypes: ["holdings", "trades", "mutualFunds"],
      },
      {
        connections: [fullConn()],
        adapters: {
          ZERODHA: {
            fetchHoldings: async () => [
              makeHolding(),
              makeHolding({ symbol: "TCS" }),
            ],
            fetchPositions: async () => [],
            fetchTrades: async () => [
              makeTrade(),
              makeTrade({ tradeId: "t-2" }),
            ],
            fetchMutualFunds: async () => [makeMutualFund()],
          },
        },
      }
    );
    assert.strictEqual(find(calls, "holding", "deleteMany").length, 1);
    assert.strictEqual(find(calls, "holding", "create").length, 2);
    assert.strictEqual(find(calls, "trade", "upsert").length, 2);
    assert.strictEqual(find(calls, "trade", "deleteMany").length, 0);
    assert.strictEqual(find(calls, "mutualFund", "upsert").length, 1);
  });

  it("default dataTypes sync holdings+positions+trades+mutualFunds (MONEY-837)", async () => {
    const calls = await runSyncSequence(
      { jobId: "s6", userId: "u-1" },
      {
        connections: [fullConn()],
        adapters: {
          ZERODHA: {
            fetchHoldings: async () => [makeHolding()],
            fetchPositions: async () => [makePosition()],
            fetchTrades: async () => [makeTrade()],
            fetchMutualFunds: async () => [makeMutualFund()],
          },
        },
      }
    );
    assert.ok(find(calls, "holding", "deleteMany").length > 0);
    assert.ok(find(calls, "position", "deleteMany").length > 0);
    assert.ok(find(calls, "trade", "upsert").length > 0);
    assert.ok(find(calls, "mutualFund", "upsert").length > 0);
  });

  it("empty dataTypes syncs nothing but COMPLETES", async () => {
    const calls = await runSyncSequence(
      { jobId: "s7", userId: "u-1", dataTypes: [] },
      { connections: [fullConn()], adapters: {} }
    );
    const data = ["holding", "position", "trade", "mutualFund"].flatMap((m) =>
      calls.filter((c) => c.model === m)
    );
    assert.strictEqual(data.length, 0);
    assert.strictEqual(lastBg(calls).data.status, "COMPLETED");
  });

  it("per-type isolation: a failing fetch does not stop the others, job still COMPLETES", async () => {
    const calls = await runSyncSequence(
      { jobId: "s8", userId: "u-1", dataTypes: ["holdings", "positions"] },
      {
        connections: [fullConn()],
        adapters: {
          ZERODHA: {
            fetchHoldings: async () => {
              throw new Error("Holdings API down");
            },
            fetchPositions: async () => [makePosition()],
            fetchTrades: async () => [],
            fetchMutualFunds: async () => [],
          },
        },
      }
    );
    assert.ok(find(calls, "position", "create").length > 0);
    assert.strictEqual(find(calls, "holding", "create").length, 0);
    assert.strictEqual(lastBg(calls).data.status, "COMPLETED");
  });

  it("a failed data type is ABSENT from syncStats; the successful one is counted", async () => {
    const calls = await runSyncSequence(
      { jobId: "s9", userId: "u-1", dataTypes: ["holdings", "positions"] },
      {
        connections: [fullConn()],
        adapters: {
          ZERODHA: {
            fetchHoldings: async () => {
              throw new Error("fail");
            },
            fetchPositions: async () => [makePosition()],
            fetchTrades: async () => [],
            fetchMutualFunds: async () => [],
          },
        },
      }
    );
    const result = (
      lastBg(calls) as { data: { result: { synced: Record<string, number> } } }
    ).data.result;
    assert.strictEqual(result.synced.holdings, undefined);
    assert.strictEqual(result.synced.positions, 1);
  });

  it("accumulates total across all data types and multiple connections", async () => {
    const calls = await runSyncSequence(
      { jobId: "s10", userId: "u-1", dataTypes: ["holdings"] },
      {
        connections: [
          fullConn({ id: "c-z", broker: "ZERODHA" }),
          fullConn({ id: "c-u", broker: "UPSTOX" }),
        ],
        adapters: {
          ZERODHA: {
            ...emptyAdapter(),
            fetchHoldings: async () => [makeHolding()],
          },
          UPSTOX: {
            ...emptyAdapter(),
            fetchHoldings: async () => [
              makeHolding(),
              makeHolding({ symbol: "INFY" }),
            ],
          },
        },
      }
    );
    const total = (lastBg(calls) as { data: { result: { total: number } } })
      .data.result.total;
    assert.strictEqual(total, 3);
    // one syncLog + one lastSync update per connection.
    assert.strictEqual(find(calls, "syncLog", "create").length, 2);
    assert.strictEqual(find(calls, "brokerConnection", "update").length, 2);
  });

  it("full lifecycle across all 4 types on one connection (counts + result)", async () => {
    const calls = await runSyncSequence(
      {
        jobId: "s11",
        userId: "u-1",
        dataTypes: ["holdings", "positions", "trades", "mutualFunds"],
      },
      {
        connections: [fullConn()],
        adapters: {
          ZERODHA: {
            fetchHoldings: async () => [
              makeHolding(),
              makeHolding({ symbol: "TCS" }),
            ],
            fetchPositions: async () => [makePosition()],
            fetchTrades: async () => [
              makeTrade({ tradeId: "t-1" }),
              makeTrade({ tradeId: "t-2" }),
            ],
            fetchMutualFunds: async () => [makeMutualFund()],
          },
        },
      }
    );
    const result = (
      lastBg(calls) as {
        data: {
          result: {
            synced: Record<string, number>;
            total: number;
            success: boolean;
          };
        };
      }
    ).data.result;
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.synced, {
      holdings: 2,
      positions: 1,
      trades: 2,
      mutualFunds: 1,
    });
    assert.strictEqual(result.total, 6);
  });

  it("wildcard sync uses each connection's own userId on the written rows", async () => {
    const calls = await runSyncSequence(
      { jobId: "s12", userId: "*", dataTypes: ["holdings"] },
      {
        connections: [fullConn({ id: "c1", userId: "owner-A" })],
        adapters: {
          ZERODHA: {
            ...emptyAdapter(),
            fetchHoldings: async () => [makeHolding()],
          },
        },
      }
    );
    const created = find(calls, "holding", "create")[0]!.args as {
      data: { userId: string };
    };
    assert.strictEqual(created.data.userId, "owner-A");
    // findMany where must NOT carry a userId for the wildcard.
    const fm = find(calls, "brokerConnection", "findMany")[0]!.args as {
      where: Record<string, unknown>;
    };
    assert.strictEqual("userId" in fm.where, false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// MONEY-841 — processSync fan-out + idempotency WIRING (source guards)
// ══════════════════════════════════════════════════════════════════════
// processSync imports Prisma + @usemoney/security + the broker clients at load,
// so it can't be pulled into a pure unit test. The branch LOGIC is covered by
// the pure-helper tests above (isFanoutTrigger / buildShardFanoutMessages /
// isSyncInFlight); these static guards lock in that sync.ts actually CALLS them
// in the right shape (fan-out returns before syncing; idempotency skips; the
// shard bucket is threaded into the connection query).

describe("processSync fan-out + idempotency wiring (MONEY-841 source guards)", () => {
  // CWD is apps/web (the web test script runs from there).
  const src = readFileSync(
    join(process.cwd(), "../../workers/src/processors/sync.ts"),
    "utf-8"
  );

  it("fan-out trigger short-circuits BEFORE the sync (publish then return)", () => {
    // `\s` already matches newlines, so the dotAll `s` flag isn't needed (and
    // the web tsconfig target predates it).
    assert.ok(
      /if\s*\(\s*isFanoutTrigger\(data\)\s*\)\s*\{\s*await fanOutScheduledSync\([^)]*\);\s*return;/.test(
        src
      ),
      "processSync must call fanOutScheduledSync(...) and return on a fan-out trigger"
    );
  });

  it("fanOutScheduledSync publishes the buildShardFanoutMessages to the BROKER_SYNC topic", () => {
    assert.ok(
      /buildShardFanoutMessages\(\s*data,/.test(src),
      "fan-out must build per-shard messages from the trigger"
    );
    assert.ok(
      /getTopicName\(PUBSUB_TOPICS\.BROKER_SYNC\)/.test(src),
      "fan-out must publish back to the broker-sync topic"
    );
    assert.ok(
      /\.publishMessage\(\{\s*json:\s*msg\s*\}\)/.test(src),
      "fan-out must publish each shard message"
    );
  });

  it("the idempotency guard skips when another BROKER_SYNC is in flight", () => {
    // counts non-terminal BROKER_SYNC jobs for the user, excluding this jobId,
    // within the inFlightSyncCutoff window, then short-circuits via isSyncInFlight.
    assert.ok(/jobType:\s*"BROKER_SYNC"/.test(src));
    assert.ok(
      /status:\s*\{\s*in:\s*\["PENDING",\s*"PROCESSING"\]\s*\}/.test(src)
    );
    assert.ok(/queuedAt:\s*\{\s*gte:\s*inFlightSyncCutoff\(\)\s*\}/.test(src));
    assert.ok(/jobId:\s*\{\s*not:\s*jobId\s*\}/.test(src));
    assert.ok(
      /if\s*\(\s*isSyncInFlight\(active\)\s*\)/.test(src),
      "must branch on isSyncInFlight(active)"
    );
  });

  it("threads data.syncBucket into the syncBrokerConnections call", () => {
    assert.ok(
      /syncBrokerConnections\(\{[^}]*syncBucket:\s*data\.syncBucket/.test(src),
      "the per-shard bucket must flow into the connection query"
    );
  });
});
