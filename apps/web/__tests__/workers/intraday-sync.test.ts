/**
 * Intraday Sync Processor - Pure Function Tests (MONEY-123 Part A) — DE-SHADOWED.
 *
 * Previously this file INLINED byte-for-byte copies of `dedupTrackedTuples` and
 * the backfill-window math "to avoid pulling Prisma into the test runtime", and
 * asserted the copies — a classic shadow that stayed green even if the real
 * processor's window math regressed. The pure helpers now live in
 * `workers/src/processors/intraday-sync-logic.ts`, which `intraday-sync.ts`
 * imports and CALLS; this test asserts those REAL exports.
 *
 * BUG REGRESSION (MONEY-620): `computeBackfillWindow` now coerces a malformed
 * `dateRange` bound to a finite fallback. The old inline `new Date(start)` could
 * produce an Invalid Date that crashed `from.toISOString()` (RangeError) in the
 * processor's very next log line + sync-log metadata, aborting the entire
 * intraday backfill. Tests at the bottom lock that guard in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker logic under test (no shadow). intraday-sync.ts CALLS these.
import {
  dedupTrackedTuples,
  computeBackfillWindow,
  parseDateOr,
  MAX_SYMBOLS_PER_RUN,
  DEFAULT_LOOKBACK_DAYS,
} from "../../../../workers/src/processors/intraday-sync-logic";

// ============== dedupTrackedTuples (real export) ==============

describe("dedupTrackedTuples (real export)", () => {
  it("returns empty for all-empty inputs", () => {
    assert.deepEqual(dedupTrackedTuples([], [], []), []);
  });

  it("dedupes within a single source", () => {
    const result = dedupTrackedTuples(
      [
        { symbol: "TCS", exchange: "NSE" },
        { symbol: "TCS", exchange: "NSE" },
      ],
      [],
      []
    );
    assert.equal(result.length, 1);
  });

  it("dedupes across all three sources (case-insensitive)", () => {
    const result = dedupTrackedTuples(
      [{ symbol: "TCS", exchange: "NSE" }],
      [{ symbol: "tcs", exchange: "nse" }],
      [{ symbol: "TCS", exchange: "NSE" }]
    );
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { symbol: "TCS", exchange: "NSE" });
  });

  it("treats different exchanges as distinct symbols", () => {
    const result = dedupTrackedTuples(
      [{ symbol: "TCS", exchange: "NSE" }],
      [{ symbol: "TCS", exchange: "BSE" }],
      []
    );
    assert.equal(result.length, 2);
  });

  it("preserves insertion order: holdings → watchlists → paper", () => {
    const result = dedupTrackedTuples(
      [{ symbol: "RELIANCE", exchange: "NSE" }],
      [{ symbol: "INFY", exchange: "NSE" }],
      [{ symbol: "TCS", exchange: "NSE" }]
    );
    assert.equal(result[0]!.symbol, "RELIANCE");
    assert.equal(result[1]!.symbol, "INFY");
    assert.equal(result[2]!.symbol, "TCS");
  });

  it("filters out empty symbol/exchange entries", () => {
    const result = dedupTrackedTuples(
      [
        { symbol: "TCS", exchange: "NSE" },
        { symbol: "", exchange: "NSE" },
        { symbol: "RELIANCE", exchange: "" },
      ],
      [],
      []
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.symbol, "TCS");
  });

  it("uppercases on output regardless of input casing", () => {
    const result = dedupTrackedTuples(
      [{ symbol: "tcs", exchange: "nse" }],
      [],
      []
    );
    assert.equal(result[0]!.symbol, "TCS");
    assert.equal(result[0]!.exchange, "NSE");
  });

  it("exports MAX_SYMBOLS_PER_RUN = 500 (the cap the processor enforces)", () => {
    // The helper does NOT enforce the cap — that's the caller's job. We assert
    // the shared constant so the cap logic stays in sync with the processor.
    assert.equal(MAX_SYMBOLS_PER_RUN, 500);
  });
});

// ============== computeBackfillWindow (real export) ==============

describe("computeBackfillWindow (real export)", () => {
  it("exposes DEFAULT_LOOKBACK_DAYS = 5", () => {
    assert.equal(DEFAULT_LOOKBACK_DAYS, 5);
  });

  it("uses explicit dateRange when provided", () => {
    const window = computeBackfillWindow({
      dateRange: {
        start: "2026-04-01T00:00:00Z",
        end: "2026-04-08T00:00:00Z",
      },
    });
    assert.equal(window.from.toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(window.to.toISOString(), "2026-04-08T00:00:00.000Z");
  });

  it("computes a 5-day window from now when no dateRange is set", () => {
    const now = new Date("2026-04-08T18:00:00Z");
    const window = computeBackfillWindow({ now });
    const diffDays =
      (window.to.getTime() - window.from.getTime()) / (1000 * 60 * 60 * 24);
    assert.equal(diffDays, 5);
    assert.equal(window.to.toISOString(), now.toISOString());
  });

  it("honors a custom lookbackDays", () => {
    const now = new Date("2026-04-08T18:00:00Z");
    const window = computeBackfillWindow({ lookbackDays: 30, now });
    const diffDays =
      (window.to.getTime() - window.from.getTime()) / (1000 * 60 * 60 * 24);
    assert.equal(diffDays, 30);
  });

  it("clamps lookbackDays < 1 to 1 day", () => {
    const now = new Date("2026-04-08T18:00:00Z");
    const window = computeBackfillWindow({ lookbackDays: 0, now });
    const diffDays =
      (window.to.getTime() - window.from.getTime()) / (1000 * 60 * 60 * 24);
    assert.equal(diffDays, 1);

    const negative = computeBackfillWindow({ lookbackDays: -5, now });
    const negDiff =
      (negative.to.getTime() - negative.from.getTime()) / (1000 * 60 * 60 * 24);
    assert.equal(negDiff, 1);
  });

  it("dateRange wins over lookbackDays when both are provided", () => {
    const now = new Date("2026-04-08T18:00:00Z");
    const window = computeBackfillWindow({
      dateRange: {
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-31T00:00:00Z",
      },
      lookbackDays: 90,
      now,
    });
    assert.equal(window.from.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(window.to.toISOString(), "2026-01-31T00:00:00.000Z");
  });

  // ── BUG REGRESSION: Invalid Date → RangeError on .toISOString() ──

  it("never returns an Invalid Date for a malformed dateRange.start (no RangeError)", () => {
    const now = new Date("2026-04-08T18:00:00Z");
    const window = computeBackfillWindow({
      dateRange: { start: "not-a-date", end: "2026-04-08T00:00:00Z" },
      lookbackDays: 5,
      now,
    });
    // Must not throw — the processor calls .toISOString() on both immediately.
    assert.doesNotThrow(() => window.from.toISOString());
    assert.doesNotThrow(() => window.to.toISOString());
    // Bad start falls back to (now - lookback).
    assert.equal(window.from.toISOString(), "2026-04-03T18:00:00.000Z");
    assert.equal(window.to.toISOString(), "2026-04-08T00:00:00.000Z");
  });

  it("falls back to now for a malformed dateRange.end", () => {
    const now = new Date("2026-04-08T18:00:00Z");
    const window = computeBackfillWindow({
      dateRange: { start: "2026-04-01T00:00:00Z", end: "garbage" },
      now,
    });
    assert.doesNotThrow(() => window.to.toISOString());
    assert.equal(window.from.toISOString(), "2026-04-01T00:00:00.000Z");
    assert.equal(window.to.toISOString(), now.toISOString());
  });

  it("returns two finite Dates even when BOTH bounds are garbage", () => {
    const now = new Date("2026-04-08T18:00:00Z");
    const window = computeBackfillWindow({
      dateRange: { start: "???", end: "???" },
      lookbackDays: 5,
      now,
    });
    assert.equal(Number.isNaN(window.from.getTime()), false);
    assert.equal(Number.isNaN(window.to.getTime()), false);
    assert.ok(window.to.getTime() >= window.from.getTime());
  });
});

// ============== parseDateOr (real export) ==============

describe("parseDateOr (real export)", () => {
  const fb = new Date("2020-01-01T00:00:00Z");

  it("parses a valid ISO string", () => {
    assert.equal(
      parseDateOr("2026-04-08T00:00:00Z", fb).toISOString(),
      "2026-04-08T00:00:00.000Z"
    );
  });

  it("returns fallback for undefined", () => {
    assert.equal(parseDateOr(undefined, fb).getTime(), fb.getTime());
  });

  it("returns fallback for an empty string", () => {
    assert.equal(parseDateOr("", fb).getTime(), fb.getTime());
  });

  it("returns fallback for an unparseable string (no Invalid Date leaks)", () => {
    const out = parseDateOr("not-a-date", fb);
    assert.equal(Number.isNaN(out.getTime()), false);
    assert.equal(out.getTime(), fb.getTime());
  });
});
