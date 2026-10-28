/**
 * Tests for the Tradebook period-range filter (MONEY-188).
 *
 * The pure helpers live at apps/web/app/tradebook/lib/range-filter.ts
 * so the client component stays thin and the date math is testable.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isInFY,
  daysBetween,
  matchesRange,
  rangeToDates,
  fyStartYear,
  fyWindowUtc,
  fyBounds,
} from "../../app/tradebook/lib/range-filter";

describe("isInFY (Indian financial year)", () => {
  test("includes 1 Apr (start of FY)", () => {
    assert.equal(isInFY(new Date("2025-04-01"), 2025), true);
  });

  test("includes 31 Mar of the following calendar year", () => {
    assert.equal(isInFY(new Date("2026-03-31"), 2025), true);
  });

  test("excludes 31 Mar of the start year", () => {
    assert.equal(isInFY(new Date("2025-03-31"), 2025), false);
  });

  test("excludes 1 Apr of the next FY", () => {
    assert.equal(isInFY(new Date("2026-04-01"), 2025), false);
  });

  test("FY 24-25 covers the previous fiscal", () => {
    assert.equal(isInFY(new Date("2025-01-15"), 2024), true);
  });
});

describe("daysBetween", () => {
  test("returns positive when 'to' is after 'from'", () => {
    const a = new Date("2026-05-01");
    const b = new Date("2026-05-10");
    assert.equal(daysBetween(a, b), 9);
  });

  test("returns 0 for identical dates", () => {
    const a = new Date("2026-05-01T10:00:00Z");
    const b = new Date("2026-05-01T10:00:00Z");
    assert.equal(daysBetween(a, b), 0);
  });

  test("returns negative when 'to' is before 'from'", () => {
    const a = new Date("2026-05-10");
    const b = new Date("2026-05-01");
    assert.equal(daysBetween(a, b), -9);
  });
});

describe("matchesRange", () => {
  // Anchor "now" so test results are deterministic.
  const now = new Date("2026-05-08T16:00:00");

  test("'all' always matches", () => {
    assert.equal(matchesRange(new Date("2020-01-01"), "all", now), true);
  });

  test("'7d' matches a trade from yesterday", () => {
    const d = new Date("2026-05-07T10:00:00");
    assert.equal(matchesRange(d, "7d", now), true);
  });

  test("'7d' rejects a trade 10 days old", () => {
    const d = new Date("2026-04-28T10:00:00");
    assert.equal(matchesRange(d, "7d", now), false);
  });

  test("'30d' matches a trade 25 days old", () => {
    const d = new Date("2026-04-13T10:00:00");
    assert.equal(matchesRange(d, "30d", now), true);
  });

  test("'3m' matches a trade ~90 days old", () => {
    const d = new Date("2026-02-08T10:00:00");
    assert.equal(matchesRange(d, "3m", now), true);
  });

  // MONEY-847: fy/pfy are now derived from `now` (IST), not hard-coded. With
  // now = 8-May-2026, the CURRENT FY is FY 26-27 and the PREVIOUS is FY 25-26.
  test("'fy' matches a trade in the current FY (FY 26-27 for this now)", () => {
    assert.equal(matchesRange(new Date("2026-12-15"), "fy", now), true);
    assert.equal(matchesRange(new Date("2026-04-01"), "fy", now), true);
  });

  test("'fy' rejects a trade in the previous FY", () => {
    assert.equal(matchesRange(new Date("2025-12-15"), "fy", now), false);
  });

  test("'pfy' matches previous-FY (FY 25-26) trades", () => {
    assert.equal(matchesRange(new Date("2025-12-15"), "pfy", now), true);
    assert.equal(matchesRange(new Date("2026-03-31"), "pfy", now), true);
  });
});

describe("rangeToDates (server-side period bounds, MONEY-839)", () => {
  // UTC-anchored so the ISO date slicing is deterministic regardless of the
  // test machine's timezone.
  const now = new Date("2026-05-08T16:00:00Z");

  test("'all' returns no bounds (period filter disabled)", () => {
    assert.deepEqual(rangeToDates("all", now), {});
  });

  // MONEY-847: now = 8-May-2026 → current FY 26-27, previous FY 25-26
  // (derived from `now`, no longer hard-coded to 2025/2024).
  // MONEY-846: the fy/pfy bounds are now IST-anchored UTC INSTANTS (1-Apr 00:00
  // IST → 31-Mar 23:59:59.999 IST), not date-only `yyyy-mm-dd`. Asserting the
  // exact `.toISOString()` makes the test TIMEZONE-INDEPENDENT (the old date-only
  // assertion would have masked the LOCAL `setHours` prod bug).
  test("'fy' maps to the current-FY IST instant window (FY 26-27 for this now)", () => {
    assert.deepEqual(rangeToDates("fy", now), {
      fromDate: "2026-03-31T18:30:00.000Z", // 1-Apr-2026 00:00 IST
      toDate: "2027-03-31T18:29:59.999Z", // 31-Mar-2027 23:59:59.999 IST
    });
  });

  test("'pfy' maps to the previous-FY IST instant window (FY 25-26 for this now)", () => {
    assert.deepEqual(rangeToDates("pfy", now), {
      fromDate: "2025-03-31T18:30:00.000Z", // 1-Apr-2025 00:00 IST
      toDate: "2026-03-31T18:29:59.999Z", // 31-Mar-2026 23:59:59.999 IST
    });
  });

  test("'7d' is a 7-day rolling window ending today", () => {
    assert.deepEqual(rangeToDates("7d", now), {
      fromDate: "2026-05-01",
      toDate: "2026-05-08",
    });
  });

  test("'30d' is a 30-day rolling window ending today", () => {
    assert.deepEqual(rangeToDates("30d", now), {
      fromDate: "2026-04-08",
      toDate: "2026-05-08",
    });
  });

  test("'3m' (~92d) reaches back further than 30d, toDate is today", () => {
    const r = rangeToDates("3m", now);
    assert.equal(r.toDate, "2026-05-08");
    assert.ok(r.fromDate && r.fromDate < "2026-04-08");
  });
});

describe("fyStartYear (IST FY boundary, MONEY-847)", () => {
  test("April → that calendar year is the FY start", () => {
    assert.equal(fyStartYear(new Date("2025-04-15T00:00:00Z")), 2025);
  });

  test("January/February/March belong to the PREVIOUS FY start", () => {
    assert.equal(fyStartYear(new Date("2026-01-10T00:00:00Z")), 2025);
    assert.equal(fyStartYear(new Date("2026-03-31T00:00:00Z")), 2025);
  });

  test("just-after-midnight IST on 1 Apr buckets into the NEW FY", () => {
    // 31-Mar 18:30 UTC == 1-Apr 00:00 IST → FY 2025, not 2024. A UTC-only
    // reading would wrongly say March/2024.
    assert.equal(fyStartYear(new Date("2025-03-31T18:30:00Z")), 2025);
  });

  test("just-before-midnight IST on 1 Apr stays in the OLD FY", () => {
    // 31-Mar 18:29 UTC == 31-Mar 23:59 IST → still FY 2024.
    assert.equal(fyStartYear(new Date("2025-03-31T18:29:00Z")), 2024);
  });

  test("Invalid Date → null", () => {
    assert.equal(fyStartYear(new Date("garbage")), null);
  });
});

describe("fyBounds", () => {
  test("derives the inclusive 1-Apr → 31-Mar window for a start year", () => {
    assert.deepEqual(fyBounds(2025), {
      fromDate: "2025-04-01",
      toDate: "2026-03-31",
    });
  });
});

describe("fyWindowUtc (IST-anchored UTC instants, MONEY-846)", () => {
  test("FY 2025 → 1-Apr 00:00 IST gte … 31-Mar 23:59:59.999 IST lte", () => {
    const { gte, lte } = fyWindowUtc(2025);
    // Assert the exact UTC INSTANT (not local time) → timezone-independent.
    assert.equal(gte.toISOString(), "2025-03-31T18:30:00.000Z");
    assert.equal(lte.toISOString(), "2026-03-31T18:29:59.999Z");
  });

  test("matches the services tax-logic fyWindowUtc window (cross-impl agreement)", () => {
    // The service computes the SAME window for the capital-gains FY filter; this
    // client-side replica must agree bit-for-bit. Hard-coded mirror of
    // packages/services/src/tax-logic.ts#fyWindowUtc("2024-25").
    const { gte, lte } = fyWindowUtc(2024);
    assert.equal(gte.toISOString(), "2024-03-31T18:30:00.000Z");
    assert.equal(lte.toISOString(), "2025-03-31T18:29:59.999Z");
  });
});

describe("isInFY IST boundary (MONEY-846)", () => {
  test("a trade just after 1-Apr midnight IST lands in the NEW FY (not dropped)", () => {
    // 2026-03-31T20:30:00Z == 1-Apr-2026 02:00 IST → FY 2026, NOT FY 2025.
    // The old UTC-midnight window (`>= 2026-04-01T00:00Z`) wrongly excluded it.
    const boundary = new Date("2026-03-31T20:30:00Z");
    assert.equal(isInFY(boundary, 2026), true);
    assert.equal(isInFY(boundary, 2025), false);
  });

  test("the last IST instant of the FY (31-Mar 23:59:59.999 IST) is included", () => {
    // 2026-03-31T18:29:59.999Z == 31-Mar-2026 23:59:59.999 IST → still FY 2025.
    const lastMoment = new Date("2026-03-31T18:29:59.999Z");
    assert.equal(isInFY(lastMoment, 2025), true);
    // …and one ms later (1-Apr 00:00:00.000 IST) flips to FY 2026.
    const firstNext = new Date("2026-03-31T18:30:00.000Z");
    assert.equal(isInFY(firstNext, 2025), false);
    assert.equal(isInFY(firstNext, 2026), true);
  });
});

describe("matchesRange / rangeToDates derive current+previous FY from now", () => {
  test("'fy'/'pfy' track now's FY rather than a hard-coded 2025/2024", () => {
    // Anchor 'now' in FY 27-28 (after 1 Apr 2027) — fy must be 2027, pfy 2026.
    const now = new Date("2027-08-01T10:00:00Z");
    assert.equal(matchesRange(new Date("2027-06-01"), "fy", now), true);
    assert.equal(matchesRange(new Date("2026-06-01"), "fy", now), false);
    assert.equal(matchesRange(new Date("2026-06-01"), "pfy", now), true);

    // MONEY-846: IST-anchored UTC instants.
    assert.deepEqual(rangeToDates("fy", now), {
      fromDate: "2027-03-31T18:30:00.000Z", // 1-Apr-2027 00:00 IST
      toDate: "2028-03-31T18:29:59.999Z", // 31-Mar-2028 23:59:59.999 IST
    });
    assert.deepEqual(rangeToDates("pfy", now), {
      fromDate: "2026-03-31T18:30:00.000Z", // 1-Apr-2026 00:00 IST
      toDate: "2027-03-31T18:29:59.999Z", // 31-Mar-2027 23:59:59.999 IST
    });
  });
});
