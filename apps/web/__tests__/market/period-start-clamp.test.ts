/**
 * MONEY-1274 — "6 months ago" must not land in the wrong month.
 *
 * ## How this was found
 *
 * The full gate went red on `yahoo-client-helpers.test.ts`:
 *
 *     should return 6 months ago for '6mo'   2 !== 1
 *
 * Not a regression from any change in this branch — a CALENDAR flake that had
 * been latent. The run happened to be on 29 August. `getPeriodStartDate("6mo")`
 * did `setMonth(getMonth() - 6)`, which keeps the day-of-month, so it asked for
 * 29 FEBRUARY 2026. That date does not exist, and JS Date silently rolls over
 * to 1 MARCH — month index 2 where the caller expected 1.
 *
 * The user-visible effect: on the 29th-31st, a "6 month" chart window is a
 * month short, and a "1 year" window from 29 Feb starts on 1 March. No error,
 * a chart still renders, and it is correct on roughly 90% of the calendar —
 * which is exactly why it survived, and why the existing date-relative tests
 * only catch it a few days a month.
 *
 * ## Why these cases are date-INDEPENDENT
 *
 * The existing tests call `getPeriodStartDate()`, which reads `new Date()`
 * internally, so they can only fail on the days the bug happens to fire. These
 * pin the pure helper against FIXED dates, so the overflow cases are asserted
 * on every run rather than a few days a month.
 *
 * Source under test: apps/web/lib/market/yahoo-client-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { monthsBack } from "../../lib/market/yahoo-client-logic";

/** Local-time date, matching how getPeriodStartDate builds its Dates. */
const at = (y: number, m: number, d: number) => new Date(y, m, d);
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

describe("monthsBack — the day is clamped, never rolled over", () => {
  it("[regression] 29 Aug 2026 minus 6 months is in FEBRUARY, not March", () => {
    // THE GATE FAILURE, as a fixed date. 29 Feb 2026 does not exist (2026 is
    // not a leap year), and the old code rolled forward into March.
    const got = monthsBack(at(2026, 7, 29), 6);
    assert.equal(got.getMonth(), 1, `expected February, got ${iso(got)}`);
    assert.equal(iso(got), "2026-02-28");
  });

  it("31 Mar minus 1 month is 28/29 Feb, not 2/3 March", () => {
    assert.equal(iso(monthsBack(at(2026, 2, 31), 1)), "2026-02-28");
    // 2024 IS a leap year, so the clamp lands on the 29th rather than the 28th.
    assert.equal(iso(monthsBack(at(2024, 2, 31), 1)), "2024-02-29");
  });

  it("31 May minus 1 month is 30 April", () => {
    assert.equal(iso(monthsBack(at(2026, 4, 31), 1)), "2026-04-30");
  });

  it("a year back from 29 Feb clamps to 28 Feb", () => {
    // `setFullYear(y - 1)` on a leap day has the identical defect: it returned
    // 1 March. Years route through the same helper for that reason.
    assert.equal(iso(monthsBack(at(2024, 1, 29), 12)), "2023-02-28");
  });

  it("crosses the year boundary correctly", () => {
    assert.equal(iso(monthsBack(at(2026, 0, 15), 1)), "2025-12-15");
    assert.equal(iso(monthsBack(at(2026, 0, 31), 2)), "2025-11-30");
  });

  it("leaves a day that FITS the target month exactly alone", () => {
    // The clamp must be a floor on overflow, not a rewrite of every date.
    assert.equal(iso(monthsBack(at(2026, 7, 15), 6)), "2026-02-15");
    assert.equal(iso(monthsBack(at(2026, 7, 1), 6)), "2026-02-01");
  });

  it("never moves the result into a month other than the target", () => {
    // The invariant the point-cases are instances of: for every day of a
    // 31-day month, going back N months must land in exactly the month N
    // before it — never the one after. This is the assertion that would have
    // caught the bug on ANY calendar day.
    for (let day = 1; day <= 31; day++) {
      for (const months of [1, 3, 6, 12]) {
        const from = at(2026, 7, day); // August 2026, 31 days
        const got = monthsBack(from, months);
        const expectedMonth = (7 - months + 24) % 12;
        assert.equal(
          got.getMonth(),
          expectedMonth,
          `Aug ${day} minus ${months}mo landed in month ${got.getMonth()} (${iso(got)}), expected ${expectedMonth}`
        );
      }
    }
  });
});
