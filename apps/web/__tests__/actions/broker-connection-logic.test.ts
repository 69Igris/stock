/**
 * Broker-connection PURE helper tests (lib/actions/broker-connection-logic.ts) —
 * MONEY-846.
 *
 * These assert the REAL exported helpers that `broker-connection.ts` CALLS (no
 * shadow): the historical-backfill window parse/clamp, the in-flight-job stale
 * cutoff, and the BackgroundJob → poller-status mapping. The action itself is a
 * `"use server"` module (Prisma + Clerk + next/cache at load) so it can't be
 * pulled into a pure test — the logic lives in this sibling, which the action
 * imports and the production path executes.
 *
 *   - parseHistoricalSyncDays — the `Number(raw) || 3650` bug: a NEGATIVE/0/NaN/
 *     empty override silently disabled backfill (fromDate landed in the future);
 *     it must now clamp to a sane positive and fall back to the default.
 *   - mapBrokerSyncJobStatus — defensive Json-parse (malformed `result` must NOT
 *     throw), CANCELLED → FAILED, missing row → UNKNOWN.
 *   - staleBrokerJobCutoff — the 15-minute "ignore stale job" boundary.
 *
 * Source: apps/web/lib/actions/broker-connection-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseHistoricalSyncDays,
  staleBrokerJobCutoff,
  mapBrokerSyncJobStatus,
  DEFAULT_HISTORICAL_SYNC_DAYS,
  STALE_BROKER_JOB_MS,
} from "../../lib/actions/broker-connection-logic";

// ══════════════════════════════════════════════════════════════════════
// parseHistoricalSyncDays — env override clamp (MONEY-846)
// ══════════════════════════════════════════════════════════════════════

describe("broker-connection-logic.parseHistoricalSyncDays (real export)", () => {
  it("the default constant is ~10 years (3650 days)", () => {
    assert.strictEqual(DEFAULT_HISTORICAL_SYNC_DAYS, 3650);
  });

  it("a valid positive override passes through unchanged", () => {
    assert.strictEqual(parseHistoricalSyncDays("365"), 365);
    assert.strictEqual(parseHistoricalSyncDays("30"), 30);
  });

  it("THE BUG: a NEGATIVE override falls back to the default (never disables backfill)", () => {
    // `Number("-5") || 3650` was -5 (truthy) → fromDate in the FUTURE → the
    // year-loop never ran. The clamp rejects it → default window instead.
    assert.strictEqual(parseHistoricalSyncDays("-5"), 3650);
    assert.strictEqual(parseHistoricalSyncDays("-3650"), 3650);
  });

  it("zero falls back to the default (a zero-day window syncs nothing)", () => {
    assert.strictEqual(parseHistoricalSyncDays("0"), 3650);
  });

  it("NaN / garbage / empty / undefined fall back to the default", () => {
    assert.strictEqual(parseHistoricalSyncDays("abc"), 3650);
    assert.strictEqual(parseHistoricalSyncDays(""), 3650);
    assert.strictEqual(parseHistoricalSyncDays(undefined), 3650);
    assert.strictEqual(parseHistoricalSyncDays("   "), 3650);
  });

  it("Infinity is rejected (not a finite window) → default", () => {
    assert.strictEqual(parseHistoricalSyncDays("Infinity"), 3650);
  });

  it("a huge positive override is accepted as-is (ops may want all history)", () => {
    assert.strictEqual(parseHistoricalSyncDays("36500"), 36500);
  });

  it("a fractional positive is accepted (caller derives a Date from it)", () => {
    assert.strictEqual(parseHistoricalSyncDays("1.5"), 1.5);
  });

  it("honours a custom fallback when the value is invalid", () => {
    assert.strictEqual(parseHistoricalSyncDays("-1", 730), 730);
    assert.strictEqual(parseHistoricalSyncDays("100", 730), 100);
  });
});

// ══════════════════════════════════════════════════════════════════════
// staleBrokerJobCutoff — the 15-min in-flight-job boundary (MONEY-846)
// ══════════════════════════════════════════════════════════════════════

describe("broker-connection-logic.staleBrokerJobCutoff (real export)", () => {
  it("the stale window is 15 minutes", () => {
    assert.strictEqual(STALE_BROKER_JOB_MS, 15 * 60 * 1000);
  });

  it("returns now minus 15 minutes", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    assert.strictEqual(
      staleBrokerJobCutoff(now).toISOString(),
      "2026-06-15T11:45:00.000Z"
    );
  });

  it("a job queued before the cutoff is stale; one after is fresh", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const cutoff = staleBrokerJobCutoff(now).getTime();
    const stale = new Date("2026-06-15T11:30:00.000Z").getTime(); // 30m ago
    const fresh = new Date("2026-06-15T11:50:00.000Z").getTime(); // 10m ago
    assert.ok(stale < cutoff, "30-min-old job is stale (below the >= cutoff)");
    assert.ok(fresh >= cutoff, "10-min-old job is fresh");
  });
});

// ══════════════════════════════════════════════════════════════════════
// mapBrokerSyncJobStatus — BackgroundJob row → poller status (MONEY-846)
// ══════════════════════════════════════════════════════════════════════

describe("broker-connection-logic.mapBrokerSyncJobStatus (real export)", () => {
  it("a missing row → UNKNOWN ('keep waiting')", () => {
    const r = mapBrokerSyncJobStatus(null);
    assert.strictEqual(r.status, "UNKNOWN");
    assert.strictEqual(r.synced, undefined);
    assert.strictEqual(r.total, undefined);
  });

  it("parses a well-formed worker result ({ success, synced, total })", () => {
    const r = mapBrokerSyncJobStatus({
      status: "COMPLETED",
      result: {
        success: true,
        synced: { holdings: 3, positions: 1, trades: 12, mutualFunds: 2 },
        total: 18,
      },
      errorMessage: null,
    });
    assert.strictEqual(r.status, "COMPLETED");
    assert.deepStrictEqual(r.synced, {
      holdings: 3,
      positions: 1,
      trades: 12,
      mutualFunds: 2,
    });
    assert.strictEqual(r.total, 18);
    assert.strictEqual(r.error, undefined);
  });

  it("CANCELLED maps to FAILED (the spinner can't hang on a terminal non-success)", () => {
    const r = mapBrokerSyncJobStatus({
      status: "CANCELLED",
      result: null,
      errorMessage: null,
    });
    assert.strictEqual(r.status, "FAILED");
  });

  it("passes PENDING / PROCESSING / FAILED through unchanged", () => {
    for (const s of ["PENDING", "PROCESSING", "FAILED"] as const) {
      assert.strictEqual(
        mapBrokerSyncJobStatus({ status: s, result: null, errorMessage: null })
          .status,
        s
      );
    }
  });

  it("surfaces errorMessage when present (FAILED job)", () => {
    const r = mapBrokerSyncJobStatus({
      status: "FAILED",
      result: null,
      errorMessage: "No broker connections found",
    });
    assert.strictEqual(r.status, "FAILED");
    assert.strictEqual(r.error, "No broker connections found");
  });

  it("a MALFORMED result Json does NOT throw → status kept, no counts", () => {
    // The column is Prisma Json; a legacy/garbage value must degrade to "no
    // counts", never crash the poller.
    const cases: unknown[] = [
      "a string result",
      42,
      true,
      [1, 2, 3], // array
      { synced: "not-an-object", total: "nope" }, // wrong inner types
      { synced: [1, 2], total: [3] }, // arrays where objects/numbers expected
      {}, // empty object
      null,
    ];
    for (const result of cases) {
      const r = mapBrokerSyncJobStatus({
        status: "COMPLETED",
        result,
        errorMessage: null,
      });
      assert.strictEqual(r.status, "COMPLETED");
      assert.strictEqual(r.synced, undefined, `synced for ${String(result)}`);
      assert.strictEqual(r.total, undefined, `total for ${String(result)}`);
    }
  });

  it("picks up total even when synced is absent, and vice-versa", () => {
    const totalOnly = mapBrokerSyncJobStatus({
      status: "COMPLETED",
      result: { total: 7 },
      errorMessage: null,
    });
    assert.strictEqual(totalOnly.total, 7);
    assert.strictEqual(totalOnly.synced, undefined);

    const syncedOnly = mapBrokerSyncJobStatus({
      status: "COMPLETED",
      result: { synced: { holdings: 1 } },
      errorMessage: null,
    });
    assert.deepStrictEqual(syncedOnly.synced, { holdings: 1 });
    assert.strictEqual(syncedOnly.total, undefined);
  });
});
