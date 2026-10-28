/**
 * NSE holiday calendar tests.
 *
 * Source: packages/core/src/market-data/nse-holidays.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NSE_HOLIDAYS_BY_FY,
  getFinancialYear,
  getNonTradingReason,
  getNseHoliday,
  toIstDateKey,
} from "../src/market-data/nse-holidays";

describe("getFinancialYear", () => {
  it("April-Dec belongs to FY starting that calendar year", () => {
    // Apr 5 2026 IST → FY 26-27
    const d = new Date("2026-04-05T00:30:00Z"); // 06:00 IST
    assert.equal(getFinancialYear(addIst(d)), "26-27");
  });

  it("Jan-Mar belongs to FY starting previous calendar year", () => {
    // Feb 15 2027 IST → FY 26-27
    const d = new Date("2027-02-15T00:30:00Z"); // 06:00 IST
    assert.equal(getFinancialYear(addIst(d)), "26-27");
  });

  it("April 1 boundary lands on the new FY", () => {
    const d = new Date("2027-04-01T00:30:00Z"); // 06:00 IST 2027-04-01
    assert.equal(getFinancialYear(addIst(d)), "27-28");
  });
});

describe("toIstDateKey", () => {
  it("converts a UTC instant past midnight IST to the next IST day", () => {
    // 19:00 UTC on 2026-08-15 = 00:30 IST on 2026-08-16
    const d = new Date("2026-08-15T19:00:00Z");
    assert.equal(toIstDateKey(d), "2026-08-16");
  });

  it("preserves a regular IST midday key", () => {
    const d = new Date("2026-10-21T06:00:00Z"); // 11:30 IST
    assert.equal(toIstDateKey(d), "2026-10-21");
  });
});

describe("getNseHoliday", () => {
  it("returns the holiday entry for Diwali-Balipratipada 2026", () => {
    const d = new Date("2026-11-10T05:00:00Z"); // 10:30 IST
    const h = getNseHoliday(d);
    assert.ok(h);
    assert.equal(h?.name, "Diwali-Balipratipada");
  });

  it("names Diwali Laxmi Pujan 2026 on its Sunday (Muhurat day)", () => {
    const d = new Date("2026-11-08T05:00:00Z");
    assert.equal(getNseHoliday(d)?.name, "Diwali Laxmi Pujan");
  });

  it("returns null for a regular trading day", () => {
    // Tue Apr 7 2026 - no holiday
    const d = new Date("2026-04-07T05:00:00Z");
    assert.equal(getNseHoliday(d), null);
  });

  it("returns null for unmapped FYs (e.g. far-future date)", () => {
    const d = new Date("2030-08-15T05:00:00Z"); // FY 30-31, not yet entered
    assert.equal(getNseHoliday(d), null);
  });

  it("Republic Day 2027 (in FY 26-27) is mapped", () => {
    const d = new Date("2027-01-26T05:00:00Z");
    const h = getNseHoliday(d);
    assert.ok(h);
    assert.equal(h?.name, "Republic Day");
  });
});

describe("getNonTradingReason", () => {
  it("flags Saturday as WEEKEND", () => {
    // Sat Apr 4 2026
    const d = new Date("2026-04-04T05:00:00Z");
    const r = getNonTradingReason(d);
    assert.equal(r.isClosed, true);
    assert.equal(r.reason, "WEEKEND");
  });

  it("flags Sunday as WEEKEND", () => {
    // Sun Apr 5 2026
    const d = new Date("2026-04-05T05:00:00Z");
    const r = getNonTradingReason(d);
    assert.equal(r.isClosed, true);
    assert.equal(r.reason, "WEEKEND");
  });

  it("flags Independence Day 2026 (Sat) as WEEKEND first", () => {
    // 2026-08-15 is Saturday - weekend rule wins
    const d = new Date("2026-08-15T05:00:00Z");
    const r = getNonTradingReason(d);
    assert.equal(r.isClosed, true);
    assert.equal(r.reason, "WEEKEND");
  });

  it("flags Diwali-Balipratipada 2026 (Tue) as HOLIDAY with name", () => {
    const d = new Date("2026-11-10T05:00:00Z");
    const r = getNonTradingReason(d);
    assert.equal(r.isClosed, true);
    assert.equal(r.reason, "HOLIDAY");
    assert.equal(r.name, "Diwali-Balipratipada");
  });

  it("flags Diwali Laxmi Pujan 2026 (Sun) as WEEKEND first", () => {
    const r = getNonTradingReason(new Date("2026-11-08T05:00:00Z"));
    assert.equal(r.isClosed, true);
    assert.equal(r.reason, "WEEKEND");
  });

  it("returns isClosed=false for a regular weekday", () => {
    // Tue Apr 7 2026
    const d = new Date("2026-04-07T05:00:00Z");
    const r = getNonTradingReason(d);
    assert.equal(r.isClosed, false);
    assert.equal(r.reason, null);
  });
});

/**
 * MONEY-1615. FY 26-27 used to be 2025's calendar with the year changed, so
 * 2026-08-27 — a trading day — was skipped by every walker and never archived.
 * These pin the Apr–Dec 2026 dates to NSE circular NSE/CMTR/71775 (12-Dec-2025,
 * "Trading holidays for the calendar year 2026"), weekday AND weekend rows.
 */
describe("FY 26-27 matches NSE circular NSE/CMTR/71775", () => {
  const CIRCULAR_APR_DEC_2026 = [
    "2026-04-03",
    "2026-04-14",
    "2026-05-01",
    "2026-05-28",
    "2026-06-26",
    "2026-08-15",
    "2026-09-14",
    "2026-10-02",
    "2026-10-20",
    "2026-11-08",
    "2026-11-10",
    "2026-11-24",
    "2026-12-25",
  ];

  it("holds exactly the circular's Apr–Dec 2026 holidays", () => {
    const listed = (NSE_HOLIDAYS_BY_FY["26-27"] ?? [])
      .map((h) => h.date)
      .filter((d) => d < "2027-01-01");
    assert.deepEqual([...listed].sort(), CIRCULAR_APR_DEC_2026);
  });

  for (const day of ["2026-08-27", "2026-10-21", "2026-10-22", "2026-11-05"]) {
    it(`${day} is a trading day (last year's date, not this year's)`, () => {
      const r = getNonTradingReason(new Date(`${day}T05:00:00Z`));
      assert.equal(r.isClosed, false);
    });
  }

  it("Jan–Mar 2027 holds only Republic Day until the CY2027 circular", () => {
    const early2027 = (NSE_HOLIDAYS_BY_FY["26-27"] ?? []).filter(
      (h) => h.date >= "2027-01-01",
    );
    assert.deepEqual(
      early2027.map((h) => h.date),
      ["2027-01-26"],
    );
  });
});

describe("NSE_HOLIDAYS_BY_FY shape", () => {
  it("FY 26-27 has at least 10 holidays registered", () => {
    const list = NSE_HOLIDAYS_BY_FY["26-27"];
    assert.ok(list && list.length >= 10);
  });

  it("all dates are valid ISO YYYY-MM-DD", () => {
    for (const [fy, list] of Object.entries(NSE_HOLIDAYS_BY_FY)) {
      for (const h of list) {
        assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/, `${fy} ${h.name}`);
        const parsed = new Date(`${h.date}T00:00:00Z`);
        assert.ok(!isNaN(parsed.getTime()), `${fy} ${h.name}`);
      }
    }
  });

  it("all dates fall within the claimed FY window", () => {
    for (const [fy, list] of Object.entries(NSE_HOLIDAYS_BY_FY)) {
      const [startYY] = fy.split("-").map((s) => parseInt(s, 10) + 2000);
      for (const h of list) {
        // Pick a clearly-in-day instant for the holiday
        const d = new Date(`${h.date}T06:00:00Z`); // 11:30 IST
        const computed = getFinancialYear(d);
        assert.equal(
          computed,
          fy,
          `Holiday ${h.name} ${h.date} mapped to FY ${computed}, expected ${fy}`,
        );
        assert.ok(typeof startYY === "number");
      }
    }
  });
});

// ── Helpers ────────────────────────────────────────────────────────

/** Add the IST offset so getFinancialYear gets an "IST-shifted" Date. */
function addIst(d: Date): Date {
  return new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
}

/* ─────────────────────────────────────────────────────────────────────────
   The IST date-key mirror in @usemoney/lake, pinned — MONEY-1516 part (a)
   ──────────────────────────────────────────────────────────────────────── */

describe("toIstDateKey agrees with @usemoney/lake's copy", () => {
  // `corp-action-logic.ts` renders `ex_date` and `record_date` in IST with its
  // own copy of this function, because `packages/core` and `packages/lake`
  // have no dependency edge in either direction — and lake's tsconfig enforces
  // that, failing a relative import into core with TS6059. So the duplication
  // is deliberate; the rule is that the two must not DRIFT.
  //
  // THE PIN HAS TO SIT ON THIS SIDE. Core's test tsconfig sets
  // `rootDir: "../.."` and can see both packages; lake's cannot. Same
  // asymmetry, same arrangement, as the `numeric()` pin in
  // `databento-lake-logic.test.ts`.
  //
  // What drift would cost: a UTC round-trip here put 48,224 of 59,087 India
  // corporate actions one calendar day early — 6,857 SUNDAY ex-dates — and
  // landed every adjustment factor on the wrong bar.
  it("produces identical output to lake's istDateKey", async () => {
    const lake = (await import("../../lake/src/corp-action-logic")) as {
      istDateKey: (d: Date | null | undefined) => string | null;
    };

    for (const iso of [
      "2022-07-26T18:30:00.000Z", // IST midnight — the 48,224-row convention
      "2022-07-27T00:00:00.000Z", // UTC midnight — the 10,863-row convention
      "2022-07-26T18:29:59.999Z", // one ms before the IST day rolls
      "2023-01-01T18:30:00.000Z", // a Sunday in UTC, a Monday in IST
      "2024-02-29T18:30:00.000Z", // leap day, into the 1st of March
      "2023-12-31T18:30:00.000Z", // year boundary
      "1994-11-03T18:30:00.000Z", // the oldest bar the India lake holds
      "2026-09-22T05:30:00.000Z", // mid-session, neither midnight
    ]) {
      const d = new Date(iso);
      assert.equal(
        lake.istDateKey(d),
        toIstDateKey(d),
        `the two IST renderings disagree on ${iso}`,
      );
    }

    // The mirror additionally answers null where core's takes a real Date;
    // that widening is lake's own and must not be read back as agreement.
    assert.equal(lake.istDateKey(null), null);
    assert.equal(lake.istDateKey(new Date("nope")), null);
  });
});
