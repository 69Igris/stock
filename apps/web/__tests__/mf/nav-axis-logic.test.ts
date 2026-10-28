/**
 * NAV chart x-axis tick granularity.
 *
 * The axis formatted every tick as `getFullYear()`, so on 1M and 3M — where
 * every point shares a calendar year — it printed "2026" a dozen times across
 * the bottom of the chart. The axis was still rendering, still aligned, and
 * still correct at 3Y/5Y/ALL, which is why it went unnoticed: nothing looks
 * broken, the labels have simply stopped distinguishing anything.
 *
 * Granularity comes from the plotted SPAN, not the period button, and the
 * regression cases below pin that: the two can disagree whenever a fund has
 * less history than the period requests.
 *
 * Tick strings are asserted by pattern rather than by exact equality —
 * `toLocaleDateString` output varies with the ICU build, and pinning the exact
 * spacing would make this fail on a different Node without anything being
 * wrong.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  navAxisGranularity,
  formatNavAxisTick,
} from "../../components/mf/nav-axis-logic";

/** ISO date `days` after 2026-01-01. */
const iso = (days: number) =>
  new Date(Date.UTC(2026, 0, 1) + days * 86_400_000).toISOString().slice(0, 10);

describe("navAxisGranularity", () => {
  test("1M of data labels individual days", () => {
    assert.equal(navAxisGranularity(iso(0), iso(31)), "day");
  });

  test("3M of data labels individual days", () => {
    // The period from the screenshot that showed "2026" thirteen times.
    assert.equal(navAxisGranularity(iso(0), iso(92)), "day");
  });

  test("6M inside one calendar year labels bare months", () => {
    // 2026-01-01 → 2026-07-01: no year needed, every tick is unambiguous.
    assert.equal(navAxisGranularity(iso(0), iso(181)), "month");
  });

  test("a sub-year span that CROSSES new year keeps the year", () => {
    // Without it, "Jan" would appear twice meaning two different years.
    assert.equal(navAxisGranularity("2025-09-01", "2026-04-01"), "monthYear");
  });

  test("3Y and 5Y label years", () => {
    assert.equal(navAxisGranularity(iso(0), iso(365 * 3)), "year");
    assert.equal(navAxisGranularity(iso(0), iso(365 * 5)), "year");
  });

  test("[regression] a same-year span is never labelled by year", () => {
    // The bug, stated directly: every point in one year meant every tick read
    // "2026". Any span short enough to sit inside a year must be finer.
    for (const days of [1, 7, 31, 92, 119]) {
      assert.notEqual(
        navAxisGranularity(iso(0), iso(days)),
        "year",
        `a ${days}-day span must not be labelled by year`
      );
    }
  });

  test("[regression] granularity follows the DATA, not the period", () => {
    // A fund launched six weeks ago has ~40 points under the "1Y" button.
    // Deriving from the button would label them all "2026"; deriving from the
    // span gives days.
    assert.equal(navAxisGranularity(iso(0), iso(40)), "day");
  });

  test("boundaries fall on the expected side", () => {
    assert.equal(navAxisGranularity(iso(0), iso(120)), "day");
    assert.notEqual(navAxisGranularity(iso(0), iso(121)), "day");
    assert.notEqual(navAxisGranularity(iso(0), iso(400)), "year");
    assert.equal(navAxisGranularity(iso(0), iso(401)), "year");
  });

  test("reversed bounds are treated as the same span", () => {
    // The caller passes data[0] and data[n-1]; a descending series must not
    // produce a negative span that collapses to "day" by accident.
    assert.equal(navAxisGranularity(iso(365 * 3), iso(0)), "year");
  });

  test("unparseable bounds fall back to day, not year", () => {
    // A wrong date shown as "07 Aug" looks odd and gets reported; the same
    // wrong date shown as "2026" looks entirely normal.
    assert.equal(navAxisGranularity("not-a-date", iso(10)), "day");
    assert.equal(navAxisGranularity("", ""), "day");
  });
});

describe("formatNavAxisTick", () => {
  const AUG = "2026-08-07";

  test("day includes the day number and the month name", () => {
    const out = formatNavAxisTick(AUG, "day");
    assert.match(out, /07/);
    assert.match(out, /Aug/);
    assert.doesNotMatch(out, /2026/, "the year is the thing being replaced");
  });

  test("month is the month name alone", () => {
    assert.match(formatNavAxisTick(AUG, "month"), /Aug/);
    assert.doesNotMatch(formatNavAxisTick(AUG, "month"), /\d/);
  });

  test("monthYear carries a 2-digit year", () => {
    const out = formatNavAxisTick(AUG, "monthYear");
    assert.match(out, /Aug/);
    assert.match(out, /26/);
  });

  test("year is the 4-digit year", () => {
    assert.equal(formatNavAxisTick(AUG, "year"), "2026");
  });

  test("an unparseable date renders blank, not 'Invalid Date'", () => {
    // recharts prints whatever it is handed straight onto the axis.
    for (const g of ["day", "month", "monthYear", "year"] as const) {
      assert.equal(formatNavAxisTick("nonsense", g), "");
    }
  });

  test("consecutive days produce DIFFERENT labels at day granularity", () => {
    // The property the bug violated: adjacent ticks must be distinguishable.
    const a = formatNavAxisTick("2026-08-07", "day");
    const b = formatNavAxisTick("2026-08-08", "day");
    assert.notEqual(a, b);
  });
});
