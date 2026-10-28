/**
 * Market-hours gating tests.
 *
 * Pure-function tests for the IST 09:15-15:30 weekday window helper used by
 * the paper-trading layout to decide whether to render the LIVE indicator
 * vs. CLOSED.
 *
 * Boundary cases covered:
 * - Saturday and Sunday → always closed (regardless of time)
 * - Before 09:15 IST on a weekday → closed
 * - At exactly 09:15 IST on a weekday → open
 * - Mid-session (12:00 IST on a weekday) → open
 * - At 15:29 IST on a weekday → open
 * - At exactly 15:30 IST on a weekday → closed (close is exclusive)
 * - After 15:30 IST on a weekday → closed
 *
 * Test instants are constructed in UTC and decoded into IST inside the
 * helper, so all expectations refer to IST times in the comments.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getMarketSnapshot,
  isMarketOpenAt,
} from "../../lib/market/market-hours";

/**
 * Build a UTC Date that, when interpreted in IST, is a specific weekday +
 * hour:minute. IST is UTC+5:30 so we subtract 5h30m from the desired IST
 * wall-clock to get the corresponding UTC instant.
 *
 * @param istYear  IST calendar year
 * @param istMonth IST calendar month (1-12)
 * @param istDay   IST day of month
 * @param istHour  IST hour (0-23)
 * @param istMin   IST minute (0-59)
 */
function istInstant(
  istYear: number,
  istMonth: number,
  istDay: number,
  istHour: number,
  istMin: number,
  istSec = 0
): Date {
  // Construct the IST wall-clock as UTC, then subtract 5h30m to get true UTC
  const naiveUtc = Date.UTC(
    istYear,
    istMonth - 1,
    istDay,
    istHour,
    istMin,
    istSec
  );
  return new Date(naiveUtc - (5 * 60 + 30) * 60 * 1000);
}

describe("getMarketSnapshot - weekend gating", () => {
  it("returns isOpen=false on a Saturday at noon IST", () => {
    // 2025-04-12 was a Saturday
    const at = istInstant(2025, 4, 12, 12, 0);
    const snap = getMarketSnapshot(at);
    assert.equal(snap.isOpen, false);
  });

  it("returns isOpen=false on a Sunday during what would be market hours", () => {
    // 2025-04-13 was a Sunday
    const at = istInstant(2025, 4, 13, 10, 30);
    const snap = getMarketSnapshot(at);
    assert.equal(snap.isOpen, false);
  });
});

describe("getMarketSnapshot - weekday boundary cases", () => {
  // 2025-04-15 was a Tuesday (a normal trading weekday)
  const TUE_YEAR = 2025;
  const TUE_MONTH = 4;
  const TUE_DAY = 15;

  it("returns isOpen=false at 09:14 IST (one minute before open)", () => {
    const at = istInstant(TUE_YEAR, TUE_MONTH, TUE_DAY, 9, 14);
    assert.equal(getMarketSnapshot(at).isOpen, false);
  });

  it("returns isOpen=true at exactly 09:15 IST (open is inclusive)", () => {
    const at = istInstant(TUE_YEAR, TUE_MONTH, TUE_DAY, 9, 15);
    assert.equal(getMarketSnapshot(at).isOpen, true);
  });

  it("returns isOpen=true at 12:00 IST (mid-session)", () => {
    const at = istInstant(TUE_YEAR, TUE_MONTH, TUE_DAY, 12, 0);
    assert.equal(getMarketSnapshot(at).isOpen, true);
  });

  it("returns isOpen=true at 15:29 IST (one minute before close)", () => {
    const at = istInstant(TUE_YEAR, TUE_MONTH, TUE_DAY, 15, 29);
    assert.equal(getMarketSnapshot(at).isOpen, true);
  });

  it("returns isOpen=false at exactly 15:30 IST (close is exclusive)", () => {
    const at = istInstant(TUE_YEAR, TUE_MONTH, TUE_DAY, 15, 30);
    assert.equal(getMarketSnapshot(at).isOpen, false);
  });

  it("returns isOpen=false at 18:00 IST (after-hours)", () => {
    const at = istInstant(TUE_YEAR, TUE_MONTH, TUE_DAY, 18, 0);
    assert.equal(getMarketSnapshot(at).isOpen, false);
  });

  it("returns isOpen=false at 03:00 IST (deep night)", () => {
    const at = istInstant(TUE_YEAR, TUE_MONTH, TUE_DAY, 3, 0);
    assert.equal(getMarketSnapshot(at).isOpen, false);
  });
});

describe("getMarketSnapshot - time formatting", () => {
  it("formats 09:15:42 IST as a HH:MM:SS string", () => {
    const at = istInstant(2025, 4, 15, 9, 15, 42);
    const snap = getMarketSnapshot(at);
    assert.equal(snap.time, "09:15:42");
  });

  it("formats 23:00:00 IST without rolling into the next day's wall-clock", () => {
    const at = istInstant(2025, 4, 15, 23, 0, 0);
    const snap = getMarketSnapshot(at);
    assert.equal(snap.time, "23:00:00");
  });

  it("zero-pads single-digit hours and minutes", () => {
    const at = istInstant(2025, 4, 15, 7, 5, 3);
    const snap = getMarketSnapshot(at);
    assert.equal(snap.time, "07:05:03");
  });
});

describe("isMarketOpenAt - convenience wrapper", () => {
  it("delegates to getMarketSnapshot.isOpen", () => {
    // Tuesday 12:00 IST → open
    assert.equal(isMarketOpenAt(istInstant(2025, 4, 15, 12, 0)), true);
    // Saturday 12:00 IST → closed
    assert.equal(isMarketOpenAt(istInstant(2025, 4, 12, 12, 0)), false);
  });
});

describe("getMarketSnapshot - DST safety", () => {
  it("handles a UTC date that is the previous day in IST (cross-midnight)", () => {
    // 2025-04-15 00:30 IST = 2025-04-14 19:00 UTC (Monday in IST)
    // Make sure the helper still classifies the IST weekday correctly.
    const at = new Date(Date.UTC(2025, 3, 14, 19, 0)); // 2025-04-14 19:00 UTC
    const snap = getMarketSnapshot(at);
    // It's 00:30 IST on Tuesday - overnight, market is closed.
    assert.equal(snap.isOpen, false);
    assert.equal(snap.time, "00:30:00");
  });
});
