/**
 * UNIT TEST — backfill verification predicates (MONEY-941 / P3 step 5).
 *
 * A backfill fails in a way that LOOKS like success: it completes, the log says
 * done, and a year is simply thinner than it should be because a throttle
 * window turned 40 days into MISSING. Nothing downstream notices — a chart with
 * 210 days instead of 250 just looks like a chart. These graders are the cheap
 * check that catches it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  gradeYear,
  coverageByYear,
  compareParity,
  summarizeParity,
  MIN_EXPECTED_TRADING_DAYS,
} from "../../src/market-data/feed-backfill-verify";

describe("gradeYear", () => {
  it("passes a normal year", () => {
    const g = gradeYear(2015, 247, 5);
    assert.equal(g.verdict, "OK");
  });

  it("flags a half-empty year as SUSPICIOUS, not merely thin", () => {
    // The throttled-walk signature: far too few files to be a real year.
    const g = gradeYear(2015, 90, 160);
    assert.equal(g.verdict, "SUSPICIOUS");
    assert.match(g.note, /re-run/);
  });

  it("calls a slightly short year THIN rather than failing it", () => {
    // We have no historical holiday calendar, so a genuinely sparse early year
    // is possible. THIN is a prompt to look, not a claim of breakage.
    const g = gradeYear(1996, MIN_EXPECTED_TRADING_DAYS - 10, 20);
    assert.equal(g.verdict, "THIN");
  });

  it("reports a year with nothing archived as EMPTY", () => {
    const g = gradeYear(1993, 0, 250);
    assert.equal(g.verdict, "EMPTY");
    assert.equal(g.ratio, 0);
  });

  it("never divides by zero on an untouched year", () => {
    const g = gradeYear(1993, 0, 0);
    assert.ok(Number.isFinite(g.ratio));
    assert.equal(g.ratio, 0);
  });
});

describe("coverageByYear", () => {
  it("buckets checkpoints by IST year and grades each", () => {
    const rows = [
      ...Array.from({ length: 245 }, () => ({
        date: new Date("2015-06-15T00:00:00Z"),
        status: "DONE",
      })),
      { date: new Date("2015-06-16T00:00:00Z"), status: "MISSING" },
      { date: new Date("2016-06-15T00:00:00Z"), status: "DONE" },
    ];
    const cov = coverageByYear(rows);
    assert.equal(cov.length, 2);
    assert.equal(cov[0]!.year, 2015);
    assert.equal(cov[0]!.archived, 245);
    assert.equal(cov[0]!.missing, 1);
    assert.equal(cov[0]!.verdict, "OK");
    assert.equal(cov[1]!.verdict, "SUSPICIOUS");
  });

  it("ignores ERROR rows — they say nothing about coverage", () => {
    const cov = coverageByYear([
      { date: new Date("2015-06-15T00:00:00Z"), status: "ERROR" },
    ]);
    assert.equal(cov[0]!.archived, 0);
    assert.equal(cov[0]!.missing, 0);
  });

  it("returns [] for no checkpoints", () => {
    assert.deepEqual(coverageByYear([]), []);
  });
});

describe("era parity (the Jan-Jul 2024 overlap)", () => {
  it("accepts a last-paisa rounding difference", () => {
    // The two formats round differently in the final paisa; that is not a bug.
    assert.equal(compareParity("RELIANCE", 2845.6, 2845.61).matches, true);
  });

  it("rejects a real divergence", () => {
    const r = compareParity("RELIANCE", 2845.6, 2854.6);
    assert.equal(r.matches, false);
    assert.ok(r.diff > 1);
  });

  it("summarises a batch and surfaces only the mismatches", () => {
    const s = summarizeParity([
      compareParity("A", 100, 100),
      compareParity("B", 100, 100.005),
      compareParity("C", 100, 120),
    ]);
    assert.equal(s.checked, 3);
    assert.equal(s.matched, 2);
    assert.equal(s.mismatches.length, 1);
    assert.equal(s.mismatches[0]!.symbol, "C");
  });
});
