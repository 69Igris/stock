/**
 * NSE market-hours phase detector tests.
 *
 * Source: packages/core/src/market-data/market-hours.ts
 *
 * Each test pins a specific UTC instant and asserts the resulting
 * MarketStatus. We pick instants from FY 26-27 because the holiday
 * calendar in this repo only knows that FY today.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getNseMarketStatus,
  formatClosedReason,
} from "../src/market-data/market-hours";

/** Helper: build a UTC Date for a given IST clock time. */
function ist(
  year: number,
  month1to12: number,
  day: number,
  hh: number,
  mm: number,
): Date {
  const istUtc = Date.UTC(year, month1to12 - 1, day, hh, mm, 0);
  return new Date(istUtc - 5.5 * 60 * 60 * 1000);
}

describe("getNseMarketStatus - phase classification", () => {
  it("OPEN at 11:00 IST on a regular Wednesday", () => {
    // 2026-04-15 = Wed, no holiday
    const status = getNseMarketStatus(ist(2026, 4, 15, 11, 0));
    assert.equal(status.phase, "OPEN");
    assert.equal(status.isLive, true);
    assert.equal(status.reason, null);
    assert.notEqual(status.closesAt, null);
    assert.equal(status.nextOpenAt, null);
  });

  it("PRE_OPEN at 08:00 IST on a regular Tuesday", () => {
    // 2026-04-21 = Tue
    const status = getNseMarketStatus(ist(2026, 4, 21, 8, 0));
    assert.equal(status.phase, "PRE_OPEN");
    assert.equal(status.isLive, false);
    assert.equal(status.reason, null);
    assert.notEqual(status.nextOpenAt, null);
  });

  it("OPEN at exactly 09:15 IST", () => {
    const status = getNseMarketStatus(ist(2026, 4, 21, 9, 15));
    assert.equal(status.phase, "OPEN");
    assert.equal(status.isLive, true);
  });

  it("OPEN one minute before close (15:29 IST)", () => {
    const status = getNseMarketStatus(ist(2026, 4, 21, 15, 29));
    assert.equal(status.phase, "OPEN");
  });

  it("POST_CLOSE at exactly 15:30 IST", () => {
    const status = getNseMarketStatus(ist(2026, 4, 21, 15, 30));
    assert.equal(status.phase, "POST_CLOSE");
    assert.equal(status.isLive, false);
    assert.notEqual(status.nextOpenAt, null);
  });

  it("POST_CLOSE late evening (22:00 IST)", () => {
    const status = getNseMarketStatus(ist(2026, 4, 21, 22, 0));
    assert.equal(status.phase, "POST_CLOSE");
    assert.equal(status.isLive, false);
  });

  it("WEEKEND on Saturday", () => {
    // 2026-04-18 = Sat
    const status = getNseMarketStatus(ist(2026, 4, 18, 11, 0));
    assert.equal(status.phase, "WEEKEND");
    assert.equal(status.isLive, false);
    assert.equal(status.reason, "Saturday");
  });

  it("WEEKEND on Sunday", () => {
    // 2026-04-19 = Sun
    const status = getNseMarketStatus(ist(2026, 4, 19, 11, 0));
    assert.equal(status.phase, "WEEKEND");
    assert.equal(status.reason, "Sunday");
  });

  it("HOLIDAY on Diwali-Balipratipada 2026 even at market hours", () => {
    // 2026-11-10 (Tue), NSE/CMTR/71775 - holiday wins over OPEN (MONEY-1615)
    const status = getNseMarketStatus(ist(2026, 11, 10, 11, 0));
    assert.equal(status.phase, "HOLIDAY");
    assert.equal(status.isLive, false);
    assert.equal(status.reason, "Diwali-Balipratipada");
  });

  it("HOLIDAY at midnight IST", () => {
    const status = getNseMarketStatus(ist(2026, 8, 15, 0, 0));
    assert.equal(status.phase, "HOLIDAY");
    assert.equal(status.reason, "Independence Day");
  });
});

describe("getNseMarketStatus - nextOpenAt", () => {
  it("rolls weekend forward to Monday 09:15 IST", () => {
    // Saturday 2026-04-18 → next open is Monday 2026-04-20 09:15 IST
    const status = getNseMarketStatus(ist(2026, 4, 18, 11, 0));
    assert.notEqual(status.nextOpenAt, null);
    const next = status.nextOpenAt!;
    // Convert UTC back to IST clock fields and assert
    const istNext = new Date(next.getTime() + 5.5 * 60 * 60 * 1000);
    assert.equal(istNext.getUTCFullYear(), 2026);
    assert.equal(istNext.getUTCMonth() + 1, 4);
    assert.equal(istNext.getUTCDate(), 20);
    assert.equal(istNext.getUTCHours(), 9);
    assert.equal(istNext.getUTCMinutes(), 15);
  });

  it("skips a holiday landing on a weekday", () => {
    // 2026-10-20 (Tue, Dussehra) - next open is 2026-10-21, which the old
    // list (2025's dates) wrongly closed as "Diwali Laxmi Pujan" (MONEY-1615)
    const status = getNseMarketStatus(ist(2026, 10, 20, 11, 0));
    const next = status.nextOpenAt!;
    const istNext = new Date(next.getTime() + 5.5 * 60 * 60 * 1000);
    assert.equal(istNext.getUTCFullYear(), 2026);
    assert.equal(istNext.getUTCMonth() + 1, 10);
    assert.equal(istNext.getUTCDate(), 21);
  });

  it("post-close on a Friday rolls to Monday", () => {
    // 2026-04-17 Fri 16:00 IST → next open 2026-04-20 09:15 IST
    const status = getNseMarketStatus(ist(2026, 4, 17, 16, 0));
    const next = status.nextOpenAt!;
    const istNext = new Date(next.getTime() + 5.5 * 60 * 60 * 1000);
    assert.equal(istNext.getUTCDate(), 20);
  });
});

describe("formatClosedReason", () => {
  it("returns null when market is open", () => {
    const status = getNseMarketStatus(ist(2026, 4, 15, 11, 0));
    assert.equal(formatClosedReason(status), null);
  });

  it("decorates HOLIDAY with the holiday name", () => {
    const status = getNseMarketStatus(ist(2026, 8, 15, 11, 0));
    assert.equal(formatClosedReason(status), "Closed · Independence Day");
  });

  it("returns 'Closed · Weekend' for Sat/Sun", () => {
    const status = getNseMarketStatus(ist(2026, 4, 18, 11, 0));
    assert.equal(formatClosedReason(status), "Closed · Weekend");
  });

  it("PRE_OPEN reads 'Opens 09:15 IST'", () => {
    const status = getNseMarketStatus(ist(2026, 4, 21, 8, 0));
    assert.equal(formatClosedReason(status), "Opens 09:15 IST");
  });

  it("POST_CLOSE reads 'Closed · Opens tomorrow 09:15'", () => {
    const status = getNseMarketStatus(ist(2026, 4, 21, 16, 0));
    assert.equal(formatClosedReason(status), "Closed · Opens tomorrow 09:15");
  });
});
