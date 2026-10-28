/**
 * Screener Match Score Tests (MONEY-196)
 *
 * The match score drives the order + the MATCH column progress bar on the
 * screener results table. Getting this wrong would mean users see
 * "94% match" next to a stock that barely meets the filter - or worse,
 * a stock that doesn't meet the filter at all appearing with high score.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { filterScore, computeMatchScore } from "@/lib/screener/match-score";

describe("filterScore", () => {
  it("returns null when no filter is active", () => {
    assert.equal(filterScore(10, {}), null);
  });

  it("returns null when value is null (missing data)", () => {
    assert.equal(filterScore(null, { min: 10, max: 20 }), null);
  });

  it("returns 0 when value is below min-only filter", () => {
    assert.equal(filterScore(5, { min: 10 }), 0);
  });

  it("returns 0 when value is above max-only filter", () => {
    assert.equal(filterScore(25, { max: 20 }), 0);
  });

  it("returns 1 for any in-range value with min-only filter", () => {
    assert.equal(filterScore(15, { min: 10 }), 1);
    assert.equal(filterScore(1000, { min: 10 }), 1);
  });

  it("returns 1 for midpoint of a min/max band", () => {
    // Band [10, 20], midpoint = 15 → score 1
    assert.equal(filterScore(15, { min: 10, max: 20 }), 1);
  });

  it("returns 0.5 for value at the edge of a min/max band", () => {
    // Band [10, 20], at edge → score 0.5
    assert.equal(filterScore(10, { min: 10, max: 20 }), 0.5);
    assert.equal(filterScore(20, { min: 10, max: 20 }), 0.5);
  });

  it("clamps to 0 for values outside the band", () => {
    assert.equal(filterScore(9, { min: 10, max: 20 }), 0);
    assert.equal(filterScore(21, { min: 10, max: 20 }), 0);
  });
});

describe("filterScore (categorical)", () => {
  it("returns 1 on exact equals match", () => {
    assert.equal(filterScore("NSE", { equals: "NSE" }), 1);
    assert.equal(filterScore("Direct", { equals: "Direct" }), 1);
  });

  it("returns 0 on equals mismatch", () => {
    assert.equal(filterScore("BSE", { equals: "NSE" }), 0);
    assert.equal(filterScore("Regular", { equals: "Direct" }), 0);
  });

  it("returns null when equals is not set and equalsAny is empty/missing", () => {
    // No categorical filter active → excluded from the mean
    assert.equal(filterScore("NSE", { equals: null }), null);
    assert.equal(filterScore("NSE", { equalsAny: [] }), null);
  });

  it("returns 1 when value is in equalsAny", () => {
    assert.equal(filterScore("SBI", { equalsAny: ["SBI", "HDFC", "Axis"] }), 1);
  });

  it("returns 0 when value is not in equalsAny", () => {
    assert.equal(
      filterScore("Kotak", { equalsAny: ["SBI", "HDFC", "Axis"] }),
      0
    );
  });

  it("returns null for null/undefined value regardless of rule", () => {
    assert.equal(filterScore(null, { equals: "NSE" }), null);
    assert.equal(filterScore(undefined, { equals: "NSE" }), null);
  });

  it("stringifies non-string values for equals comparison (numeric codes etc.)", () => {
    // Category codes might arrive as numbers from the DB
    assert.equal(filterScore(1, { equals: "1" }), 1);
    assert.equal(filterScore(1, { equals: "2" }), 0);
  });

  it("coerces numeric rule fallthrough - numeric value + numeric rule still works", () => {
    // Make sure the numeric path isn't broken by the union type widening
    assert.equal(filterScore(15, { min: 10, max: 20 }), 1);
  });

  it("returns null when numeric rule given but value is a string", () => {
    assert.equal(filterScore("oops" as unknown as number, { min: 10 }), null);
  });
});

describe("computeMatchScore", () => {
  const perfectRow = {
    pe: 15, // midpoint of [10, 20]
    roe: 25, // > 18 filter
    revenueGrowth: 15, // > 10 filter
    debtToEquity: 0.4, // midpoint of [0, 0.8]
    marketCap: 50_000,
  };

  const farRow = {
    pe: 19.9, // just inside [10, 20] edge
    roe: 18.1, // just above 18 min
    revenueGrowth: 10.1, // just above 10 min
    debtToEquity: 0.79, // just inside [0, 0.8] edge
    marketCap: 50_000,
  };

  it("returns 100 when no filters are applied (neutral)", () => {
    const score = computeMatchScore(perfectRow, {});
    assert.equal(score, 100);
  });

  it("returns 100 for a perfect-midpoint row", () => {
    const score = computeMatchScore(perfectRow, {
      minPe: 10,
      maxPe: 20,
      minRoe: 18,
      minRevenueGrowth: 10,
      minDebtToEquity: 0,
      maxDebtToEquity: 0.8,
    });
    assert.equal(score, 100);
  });

  it("scores an edge-of-band row lower than a midpoint row", () => {
    const filters = {
      minPe: 10,
      maxPe: 20,
      minDebtToEquity: 0,
      maxDebtToEquity: 0.8,
    };
    const perfect = computeMatchScore(perfectRow, filters);
    const far = computeMatchScore(farRow, filters);
    assert.ok(
      perfect > far,
      `perfect (${perfect}) should score higher than far (${far})`
    );
  });

  it("ignores filters where the row value is null", () => {
    const rowMissingPe = { ...perfectRow, pe: null };
    // With only P/E filter active and row has null P/E, no scores → neutral 100
    const score = computeMatchScore(rowMissingPe, { minPe: 10, maxPe: 20 });
    assert.equal(score, 100);
  });

  it("respects marketCapBucket preset (LARGE = ≥ 20,000 Cr)", () => {
    const largeCap = { ...perfectRow, marketCap: 50_000 };
    const smallCap = { ...perfectRow, marketCap: 1_000 };
    const filters = { marketCapBucket: "LARGE" as const };
    assert.equal(computeMatchScore(largeCap, filters), 100); // passes → 1 * 100
    assert.equal(computeMatchScore(smallCap, filters), 0); // fails mcap → 0
  });

  it("averages across multiple filters (not max)", () => {
    // Perfect on one filter, edge on another → ~75 not 100
    const filters = {
      minPe: 10,
      maxPe: 20, // perfect row scores 1
      minDebtToEquity: 0,
      maxDebtToEquity: 0.8, // row at edge scores 0.5
    };
    const row = { ...perfectRow, debtToEquity: 0.8 };
    const score = computeMatchScore(row, filters);
    assert.equal(score, 75); // mean of [1, 0.5] * 100 = 75
  });
});
