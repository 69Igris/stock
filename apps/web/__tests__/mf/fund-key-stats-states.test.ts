/**
 * A missing number must say WHICH missing it is — MONEY-1205.
 *
 * `FundKeyStatsGrid` rendered a bare `-` for every empty cell, so these three
 * were indistinguishable on screen and all three read as a broken page:
 *
 *   1. we have not loaded this fund's NAV history yet (a backfill is queued);
 *   2. the fund is younger than the window (a 2.5-year-old fund has no 5Y);
 *   3. we have history but too little of it inside the window to be confident.
 *
 * It also labelled `returnsInception` **"10Y CAGR"**, which is a different
 * number for every fund younger than ten years — i.e. most of them.
 *
 * These are pure functions extracted from the component precisely so the rule
 * is testable without a DOM.
 *
 * Source: apps/web/components/mf/FundKeyStatsGrid.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  fundStatsState,
  historyCellText,
  rangeCellText,
  monthLabel,
  type FundStatsHistory,
} from "@/components/mf/FundKeyStatsGrid";
import { SECTION_EMPTY_BODY } from "@/components/stock/SectionShell";

const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "-" : `${v.toFixed(1)}%`;

/** The exact shape `computeNavDerivatives` reports for a fund with no history. */
const NOT_LOADED: FundStatsHistory = { dataPoints: 0, coverageYears: null };

/** A fund launched Feb 2024: real history, 2.5 years of it. */
const YOUNG: FundStatsHistory = {
  dataPoints: 620,
  coverageYears: 2.5,
  firstDate: "2024-02-14",
};

/** A fund with a decade of history. */
const MATURE: FundStatsHistory = {
  dataPoints: 2500,
  coverageYears: 10.2,
  firstDate: "2016-06-01",
};

describe("MONEY-1205 — the three NAV states are distinct", () => {
  it("dataPoints 0 + coverageYears null => NOT LOADED", () => {
    assert.equal(fundStatsState(NOT_LOADED, 5), "not-loaded");
    const cell = historyCellText(null, 5, NOT_LOADED, pct);
    // MONEY-1255 — the VALUE is the shared empty body now ("Not loaded" was
    // one of nineteen bespoke phrasings). The three-way STATE is untouched,
    // which is the thing this file exists to protect, and the reason the
    // backfill is still distinguishable is the hint.
    assert.equal(cell.value, SECTION_EMPTY_BODY);
    assert.equal(cell.hint, "NAV history pending");
    assert.notEqual(cell.value, "-", "a backfill in flight is not a blank");
  });

  it("dataPoints > 0 + r5Y null + coverageYears 2.5 => the fund's own start date", () => {
    assert.equal(fundStatsState(YOUNG, 5), "too-young");
    const cell = historyCellText(null, 5, YOUNG, pct);
    assert.equal(cell.value, "Since Feb 2024");
    assert.equal(cell.hint, "2.5 yrs of history");
    assert.notEqual(cell.value, "-");
  });

  it("history but not enough inside the window => an explained dash", () => {
    const sparse: FundStatsHistory = { dataPoints: 4, coverageYears: 6 };
    assert.equal(fundStatsState(sparse, 5), "sparse");
    const cell = historyCellText(null, 5, sparse, pct);
    assert.equal(cell.value, "-");
    assert.equal(cell.hint, "Not enough NAV data");
  });

  it("no history information at all keeps the legacy dash", () => {
    // A caller that passes nothing must not start claiming "Not loaded".
    assert.equal(fundStatsState(null, 5), "unknown");
    assert.deepEqual(historyCellText(null, 5, null, pct), {
      value: "-",
      hint: "Annualised",
    });
  });

  it("a real number always wins over every state", () => {
    assert.equal(historyCellText(12.34, 5, NOT_LOADED, pct).value, "12.3%");
    assert.equal(historyCellText(12.34, 5, YOUNG, pct).value, "12.3%");
  });

  it("the fund's STATED launch date is preferred over the first stored NAV", () => {
    const withLaunch: FundStatsHistory = { ...YOUNG, launchDate: "2024-01-02" };
    assert.equal(
      historyCellText(null, 5, withLaunch, pct).value,
      "Since Jan 2024"
    );
  });

  it("a 3Y horizon is satisfied by 2.5 years of history only for shorter windows", () => {
    assert.equal(fundStatsState(YOUNG, 3), "too-young");
    assert.equal(
      fundStatsState(YOUNG, 1),
      "sparse",
      "1Y is within a 2.5y series"
    );
    assert.equal(fundStatsState(MATURE, 5), "sparse");
  });
});

describe("MONEY-1205 — 'Since inception' carries its period", () => {
  it("the hint states the span rather than implying ten years", () => {
    // requiredYears === null is the inception cell: no horizon to fail.
    const cell = historyCellText(11.5, null, YOUNG, pct);
    assert.equal(cell.value, "11.5%");
    assert.equal(cell.hint, "Annualised over 2.5 yrs");
  });

  it("[regression] the grid no longer labels it '10Y CAGR'", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "components/mf/FundKeyStatsGrid.tsx"),
      "utf8"
    );
    assert.doesNotMatch(
      src,
      /label="10Y CAGR"/,
      "returnsInception is not a 10-year return for a 2.5-year-old fund"
    );
    assert.match(src, /label="Since inception"/);
  });
});

describe("MONEY-1205 — a price 52W is labelled as a price 52W", () => {
  it("PRICE basis says so on the value", () => {
    const cell = rangeCellText(230.4, "peak", "PRICE", null);
    assert.equal(cell.value, "₹230.4");
    assert.equal(cell.hint, "Traded price, not NAV peak");
  });

  it("NAV basis keeps the NAV wording", () => {
    assert.equal(
      rangeCellText(230.4, "trough", "NAV", null).hint,
      "NAV trough"
    );
  });

  it("an absent PRICE range does not blame the NAV feed", () => {
    // The ETF page's range comes from `daily_prices`; "NAV history pending"
    // would be the wrong explanation for a missing one.
    assert.deepEqual(rangeCellText(null, "peak", "PRICE", NOT_LOADED), {
      value: "-",
      hint: "No price history",
    });
  });

  it("an absent NAV range explains itself through the NAV states", () => {
    const cell = rangeCellText(null, "peak", "NAV", NOT_LOADED);
    assert.equal(cell.value, SECTION_EMPTY_BODY);
    // The distinction that must NOT collapse: a NAV-basis absence still
    // routes through the NAV states, so its hint blames the NAV feed, while
    // the PRICE-basis case above says "No price history". Same body, and the
    // hint is what tells them apart.
    assert.equal(cell.hint, "NAV history pending");
  });
});

describe("monthLabel", () => {
  it("formats in UTC so a date never slips a month", () => {
    assert.equal(monthLabel("2024-02-01"), "Feb 2024");
    assert.equal(monthLabel("2024-12-31"), "Dec 2024");
  });

  it("returns null for junk rather than 'Invalid Date'", () => {
    assert.equal(monthLabel(null), null);
    assert.equal(monthLabel(undefined), null);
    assert.equal(monthLabel("not-a-date"), null);
  });
});
