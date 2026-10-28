/**
 * Paired-trade pure-logic tests (MONEY-729).
 *
 * Covers the two side-effect-free helpers the paired API surface runs — the
 * SAME functions the live `getPairedTradeStats` / list services CALL, so this is
 * not a shadow:
 *   - `aggregatePairedStats` — the /v1/paired/stats aggregation (counts, realised
 *     P&L, win rate, averages, profit factor) with finite-guarded money.
 *   - `keysetPageById` — the generic in-memory keyset pager the portfolio list
 *     services use to bound a page while keeping the summary over the full set.
 *
 * Pure + synchronous → no I/O, no timers, cannot orphan.
 *
 * @see packages/services/src/trades-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregatePairedStats,
  keysetPageById,
  type PairedStatsRow,
} from "../src/trades-logic";

// ════════════════════════════════════════════════════════════════════════════
// aggregatePairedStats
// ════════════════════════════════════════════════════════════════════════════

describe("aggregatePairedStats", () => {
  it("returns all-zero stats for an empty set (no divide-by-zero)", () => {
    const s = aggregatePairedStats([]);
    assert.deepEqual(s, {
      totalTrades: 0,
      openPositions: 0,
      closedPositions: 0,
      partialPositions: 0,
      totalRealizedPnL: 0,
      winRate: 0,
      winners: 0,
      losers: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
    });
  });

  it("counts OPEN / CLOSED / PARTIAL buckets across all rows", () => {
    const rows: PairedStatsRow[] = [
      { status: "OPEN", realizedPnL: null },
      { status: "PARTIAL", realizedPnL: 10 },
      { status: "CLOSED", realizedPnL: 100 },
      { status: "CLOSED", realizedPnL: -40 },
    ];
    const s = aggregatePairedStats(rows);
    assert.equal(s.totalTrades, 4);
    assert.equal(s.openPositions, 1);
    assert.equal(s.partialPositions, 1);
    assert.equal(s.closedPositions, 2);
  });

  it("computes realised P&L / win rate / averages / profit factor from CLOSED lots", () => {
    const rows: PairedStatsRow[] = [
      { status: "CLOSED", realizedPnL: 300 }, // win
      { status: "CLOSED", realizedPnL: 100 }, // win
      { status: "CLOSED", realizedPnL: -200 }, // loss
      { status: "PARTIAL", realizedPnL: 9999 }, // NOT counted in P&L (matches web)
      { status: "OPEN", realizedPnL: null },
    ];
    const s = aggregatePairedStats(rows);
    assert.equal(s.totalRealizedPnL, 200); // 300 + 100 - 200
    assert.equal(s.winners, 2);
    assert.equal(s.losers, 1);
    assert.equal(s.winRate, 67); // round(2/3 * 100)
    assert.equal(s.averageWin, 200); // (300 + 100) / 2
    assert.equal(s.averageLoss, 200); // |−200| / 1
    assert.equal(s.profitFactor, 2); // grossProfit 400 / grossLoss 200
  });

  it("win rate denominator is CLOSED count only (a break-even lot is neither win nor loss)", () => {
    const rows: PairedStatsRow[] = [
      { status: "CLOSED", realizedPnL: 50 }, // win
      { status: "CLOSED", realizedPnL: 0 }, // break-even (counts to closed, not win/loss)
    ];
    const s = aggregatePairedStats(rows);
    assert.equal(s.closedPositions, 2);
    assert.equal(s.winners, 1);
    assert.equal(s.losers, 0);
    assert.equal(s.winRate, 50); // round(1/2 * 100)
    assert.equal(s.profitFactor, 0); // no gross loss → clamped, not Infinity
  });

  it("finite-guards a poisoned realised P&L (NaN/Infinity/null never leak)", () => {
    const rows: PairedStatsRow[] = [
      { status: "CLOSED", realizedPnL: Number.NaN },
      { status: "CLOSED", realizedPnL: Number.POSITIVE_INFINITY },
      { status: "CLOSED", realizedPnL: null },
      { status: "CLOSED", realizedPnL: 500 }, // the one real win
    ];
    const s = aggregatePairedStats(rows);
    // The three poisoned lots collapse to 0 (neither win nor loss); only the
    // finite 500 counts. Nothing is NaN/Infinity.
    assert.equal(Number.isFinite(s.totalRealizedPnL), true);
    assert.equal(s.totalRealizedPnL, 500);
    assert.equal(s.winners, 1);
    assert.equal(s.losers, 0);
    assert.equal(s.closedPositions, 4);
    assert.equal(Number.isFinite(s.averageWin), true);
    assert.equal(Number.isFinite(s.profitFactor), true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// keysetPageById
// ════════════════════════════════════════════════════════════════════════════

describe("keysetPageById", () => {
  const items = [
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "d" },
    { id: "e" },
  ];

  it("returns the first page + next keyset when no cursor is given", () => {
    const { page, nextCursorId } = keysetPageById(items, 2);
    assert.deepEqual(
      page.map((i) => i.id),
      ["a", "b"],
    );
    assert.equal(nextCursorId, "b");
  });

  it("resumes AFTER the cursor id", () => {
    const { page, nextCursorId } = keysetPageById(items, 2, "b");
    assert.deepEqual(
      page.map((i) => i.id),
      ["c", "d"],
    );
    assert.equal(nextCursorId, "d");
  });

  it("signals the last page with nextCursorId = null", () => {
    const { page, nextCursorId } = keysetPageById(items, 2, "d");
    assert.deepEqual(
      page.map((i) => i.id),
      ["e"],
    );
    assert.equal(nextCursorId, null);
  });

  it("returns an empty final page when the cursor is the last id", () => {
    const { page, nextCursorId } = keysetPageById(items, 2, "e");
    assert.deepEqual(page, []);
    assert.equal(nextCursorId, null);
  });

  it("a limit ≥ length returns everything with no next cursor", () => {
    const { page, nextCursorId } = keysetPageById(items, 50);
    assert.equal(page.length, 5);
    assert.equal(nextCursorId, null);
  });

  it("falls back to the first page for a stale/unknown cursor id", () => {
    const { page } = keysetPageById(items, 2, "does-not-exist");
    assert.deepEqual(
      page.map((i) => i.id),
      ["a", "b"],
    );
  });

  it("handles an empty input", () => {
    const { page, nextCursorId } = keysetPageById([] as { id: string }[], 10);
    assert.deepEqual(page, []);
    assert.equal(nextCursorId, null);
  });
});
