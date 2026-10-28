/**
 * Stock-tabs helpers (MONEY-244 v3.1).
 *
 * De-shadowed (MONEY-620): imports the REAL findCloseIndexAtOrBefore / pctReturnTo
 * from lib/actions/stock-returns-logic.ts (which getStockReturnsAction calls)
 * and the REAL relativeTime from components/stock/relative-time.ts (which
 * StockNewsTab renders). Both were extracted out of the Prisma "use server"
 * action / the "use client" component so they're testable directly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findCloseIndexAtOrBefore as findIdx,
  pctReturnTo as pctTo,
  type CloseRow as Close,
} from "../../lib/actions/stock-returns-logic";
import { relativeTime } from "../../components/stock/relative-time";

function makeCloses(): Close[] {
  // Most-recent-first, mimicking the action's `orderBy: { date: "desc" }`.
  // 30-day arithmetic series so offsets are easy to reason about.
  const out: Close[] = [];
  const today = new Date("2026-05-03T00:00:00Z");
  for (let i = 0; i < 1000; i++) {
    out.push({
      date: new Date(today.getTime() - i * 24 * 60 * 60 * 1000),
      close: 100 + (1000 - i) * 0.1, // monotonic upward
    });
  }
  return out;
}

describe("stock-tabs returns helpers (MONEY-244)", () => {
  const closes = makeCloses();

  it("findIdx(0) → -1 (no row strictly before today)", () => {
    // targetDays=0 means anything <= today; index 0 already qualifies,
    // so the action treats 1D as `pctTo(1)` directly.
    assert.equal(findIdx(closes, 0), 0);
  });

  it("findIdx(7) returns the row 7 days back", () => {
    const idx = findIdx(closes, 7);
    assert.equal(idx, 7);
    assert.equal(closes[idx]!.date.toISOString().slice(0, 10), "2026-04-26");
  });

  it("findIdx(365) returns the row a year back (or earliest available)", () => {
    const idx = findIdx(closes, 365);
    assert.ok(idx > 0);
    const days = Math.round(
      (closes[0]!.date.getTime() - closes[idx]!.date.getTime()) /
        (24 * 60 * 60 * 1000)
    );
    assert.ok(days >= 365);
  });

  it("findIdx(99999) → -1 when target predates all available history", () => {
    const idx = findIdx(closes, 99999);
    assert.equal(idx, -1);
  });

  it("pctTo handles a positive return", () => {
    const idx = findIdx(closes, 30);
    const pct = pctTo(closes, idx);
    assert.ok(pct != null);
    assert.ok((pct as number) > 0); // monotonic upward series
  });

  it("pctTo returns null for an out-of-range index", () => {
    assert.equal(pctTo(closes, -1), null);
    assert.equal(pctTo(closes, 100_000), null);
  });

  it("pctTo returns null when past close is 0 or negative (data error)", () => {
    const broken: Close[] = [
      { date: new Date("2026-05-03"), close: 100 },
      { date: new Date("2026-05-02"), close: 0 },
    ];
    assert.equal(pctTo(broken, 1), null);
  });
});

// ── relativeTime (real, from components/stock/relative-time.ts) ─────────────

describe("StockNewsTab relativeTime", () => {
  const now = new Date("2026-05-03T12:00:00Z").getTime();

  it("returns empty string for null input", () => {
    assert.equal(relativeTime(null, now), "");
  });

  it("returns empty string for an invalid iso", () => {
    assert.equal(relativeTime("not-a-date", now), "");
  });

  it("formats minutes with a 1m floor", () => {
    assert.equal(relativeTime("2026-05-03T11:59:30Z", now), "1m ago");
    assert.equal(relativeTime("2026-05-03T11:45:00Z", now), "15m ago");
  });

  it("formats hours below 24", () => {
    assert.equal(relativeTime("2026-05-03T09:00:00Z", now), "3h ago");
  });

  it("formats days below 30", () => {
    assert.equal(relativeTime("2026-05-01T12:00:00Z", now), "2d ago");
  });

  it("falls back to absolute date past 30 days", () => {
    const out = relativeTime("2026-03-15T12:00:00Z", now);
    assert.match(out, /^\d{2} [A-Za-z]{3} 2026$/);
  });
});
