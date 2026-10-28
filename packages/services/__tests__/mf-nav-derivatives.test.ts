/**
 * computeNavDerivatives — REAL export (MONEY-1205).
 *
 * Source: packages/services/src/mutualfunds-logic.ts
 *
 * This math used to live in a React `useMemo` in
 * `apps/web/app/mf/[schemeCode]/client.tsx` with a hard-coded +/-30-day anchor
 * tolerance and NO minimum-data-points floor, so `apps/api` and the web page
 * could disagree about the same fund's 3-year return and neither was tested.
 *
 * The behaviour these cases pin:
 *   - a horizon the series does not actually span returns **null**, never a
 *     shorter CAGR presented as a longer one (2.9 years !=> a 3-year return);
 *   - a horizon with too few observations returns null even when an anchor
 *     exists — two stray points must not produce a confident number;
 *   - `dataPoints` / `coverageYears` make "not enough history" a DISTINCT state
 *     from "failed to load", so a 2.5-year-old fund can say "launched Feb 2024"
 *     instead of a bare "-";
 *   - a 0 or non-finite NAV is DROPPED, never coerced (a 0 would sink the
 *     52-week low and fabricate a -100% return).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeNavDerivatives,
  NAV_MIN_POINTS_IN_WINDOW,
  NAV_ANCHOR_TOLERANCE_DAYS,
  type NavDerivativePoint,
} from "../src/mutualfunds-logic";

const DAY = 86_400_000;
/** Fixed reference so nothing here depends on the wall clock. */
const REF = new Date("2026-08-18T00:00:00Z");

/** Subtract whole calendar years (UTC), matching the implementation's anchor. */
function minusYears(d: Date, years: number): Date {
  const out = new Date(d.getTime());
  out.setUTCFullYear(out.getUTCFullYear() - years);
  return out;
}

/**
 * A weekly series ending exactly at `end`, starting exactly at `start`,
 * compounding from `startNav` to `endNav` linearly in log space.
 */
function series(
  start: Date,
  end: Date,
  startNav: number,
  endNav: number,
): NavDerivativePoint[] {
  const points: NavDerivativePoint[] = [];
  const span = end.getTime() - start.getTime();
  const steps = Math.max(1, Math.floor(span / (7 * DAY)));
  for (let i = 0; i <= steps; i++) {
    const t = start.getTime() + Math.round((span * i) / steps);
    const ratio = i / steps;
    points.push({
      date: new Date(t).toISOString().slice(0, 10),
      nav: startNav * Math.pow(endNav / startNav, ratio),
    });
  }
  // Guarantee the exact endpoints regardless of rounding.
  points[0] = { date: start.toISOString().slice(0, 10), nav: startNav };
  points[points.length - 1] = {
    date: end.toISOString().slice(0, 10),
    nav: endNav,
  };
  return points;
}

const opts = { now: REF };

// ══════════════════════════════════════════════════════════════════════
// Exactly three years
// ══════════════════════════════════════════════════════════════════════

describe("computeNavDerivatives — exactly 3 years", () => {
  const points = series(minusYears(REF, 3), REF, 100, 200);

  it("yields a 3-year return", () => {
    const d = computeNavDerivatives(points, opts);
    assert.notEqual(
      d.r3Y,
      null,
      "a series spanning exactly 3 years must produce r3Y",
    );
    // 100 -> 200 over 3 years == 2^(1/3) - 1 == 25.992...%
    assert.ok(Math.abs((d.r3Y as number) - 25.992) < 0.01, `got ${d.r3Y}`);
  });

  it("yields a 1-year return too (the shorter horizon is contained)", () => {
    const d = computeNavDerivatives(points, opts);
    assert.notEqual(d.r1Y, null);
  });

  it("does NOT invent a 5-year return", () => {
    const d = computeNavDerivatives(points, opts);
    assert.equal(d.r5Y, null, "the series does not span 5 years");
  });

  it("reports coverageYears ~= 3 and the real point count", () => {
    const d = computeNavDerivatives(points, opts);
    assert.ok(
      Math.abs((d.coverageYears as number) - 3) < 0.02,
      `got ${d.coverageYears}`,
    );
    assert.equal(d.dataPoints, points.length);
  });

  it("computes rInception over the actual span", () => {
    const d = computeNavDerivatives(points, opts);
    assert.notEqual(d.rInception, null);
    assert.ok(
      Math.abs((d.rInception as number) - 25.992) < 0.2,
      `got ${d.rInception}`,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2.9 years — the "must be null" case
// ══════════════════════════════════════════════════════════════════════

describe("computeNavDerivatives — 2.9 years", () => {
  const start = new Date(REF.getTime() - Math.round(2.9 * 365.25 * DAY));
  const points = series(start, REF, 100, 200);

  it("r3Y is NULL — a 2.9-year CAGR is not a 3-year return", () => {
    const d = computeNavDerivatives(points, opts);
    assert.equal(
      d.r3Y,
      null,
      "the series does not reach back 3 years; reporting one would overstate the horizon",
    );
  });

  it("but r1Y is available, and coverageYears says WHY r3Y is missing", () => {
    const d = computeNavDerivatives(points, opts);
    assert.notEqual(d.r1Y, null);
    assert.ok(
      Math.abs((d.coverageYears as number) - 2.9) < 0.02,
      `got ${d.coverageYears}`,
    );
    // This is the pair the UI needs: r3Y === null AND coverageYears === 2.9
    // means "too young", not "failed to load".
    assert.ok((d.coverageYears as number) < 3);
    assert.ok(d.dataPoints > 0);
  });

  it("is null even just BARELY short (tolerance must not paper over the span)", () => {
    // One day short of three years.
    const barely = series(
      new Date(minusYears(REF, 3).getTime() + DAY),
      REF,
      100,
      200,
    );
    assert.equal(computeNavDerivatives(barely, opts).r3Y, null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Sparse series — the minimum-points floor
// ══════════════════════════════════════════════════════════════════════

describe("computeNavDerivatives — sparse series", () => {
  it("refuses a horizon with fewer than the floor of observations", () => {
    // 10 points spanning exactly 3 years: an anchor sits EXACTLY on the 3-year
    // date (so tolerance is satisfied) but there are only 10 observations in the
    // window. Without a floor this returns a confident-looking CAGR from noise.
    assert.equal(NAV_MIN_POINTS_IN_WINDOW, 20);
    const start = minusYears(REF, 3);
    const points: NavDerivativePoint[] = [];
    for (let i = 0; i < 10; i++) {
      const t =
        start.getTime() +
        Math.round(((REF.getTime() - start.getTime()) * i) / 9);
      points.push({ date: new Date(t), nav: 100 + i });
    }
    const d = computeNavDerivatives(points, opts);
    assert.equal(d.dataPoints, 10);
    assert.equal(d.r3Y, null, "10 points < the 20-point floor");
    assert.equal(d.rInception, null, "inception uses the same floor");
    assert.ok(Math.abs((d.coverageYears as number) - 3) < 0.02);
  });

  it("an overridable floor lets a caller loosen it deliberately", () => {
    const start = minusYears(REF, 3);
    const points: NavDerivativePoint[] = [];
    for (let i = 0; i < 10; i++) {
      const t =
        start.getTime() +
        Math.round(((REF.getTime() - start.getTime()) * i) / 9);
      points.push({ date: new Date(t), nav: 100 + i });
    }
    const d = computeNavDerivatives(points, { ...opts, minPointsInWindow: 5 });
    assert.notEqual(d.r3Y, null);
  });

  it("no observation near the anchor date => null even with plenty of points", () => {
    assert.equal(NAV_ANCHOR_TOLERANCE_DAYS, 30);
    // Dense recent data, plus one very old point so the span "reaches back" —
    // but nothing within 30 days of the 3-year anchor.
    const points: NavDerivativePoint[] = [
      { date: minusYears(REF, 4), nav: 50 },
    ];
    for (let i = 0; i < 60; i++) {
      points.push({
        date: new Date(REF.getTime() - i * 7 * DAY),
        nav: 100 + i,
      });
    }
    const d = computeNavDerivatives(points, opts);
    assert.equal(
      d.r3Y,
      null,
      "the gap around the 3-year anchor exceeds the tolerance",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Degenerate inputs
// ══════════════════════════════════════════════════════════════════════

describe("computeNavDerivatives — single point", () => {
  const d = computeNavDerivatives([{ date: "2026-08-18", nav: 42 }], opts);

  it("derives nothing but still reports what it has", () => {
    assert.equal(d.r1Y, null);
    assert.equal(d.r3Y, null);
    assert.equal(d.r5Y, null);
    assert.equal(d.rInception, null);
    assert.equal(d.dataPoints, 1);
    assert.equal(d.coverageYears, 0, "one observation spans zero years");
  });

  it("does NOT label one observation as a 52-week range", () => {
    assert.equal(d.high52, null);
    assert.equal(d.low52, null);
  });
});

describe("computeNavDerivatives — empty / unusable input", () => {
  it("an empty series is dataPoints 0 and coverageYears null", () => {
    const d = computeNavDerivatives([], opts);
    assert.equal(d.dataPoints, 0);
    assert.equal(d.coverageYears, null);
    assert.equal(d.r1Y, null);
    assert.equal(d.high52, null);
  });

  it("dataPoints 0 vs coverageYears>0 is what separates 'failed' from 'too young'", () => {
    const failed = computeNavDerivatives([], opts);
    const young = computeNavDerivatives(
      series(minusYears(REF, 2), REF, 100, 130),
      opts,
    );
    assert.equal(failed.dataPoints, 0);
    assert.equal(failed.coverageYears, null);
    assert.ok(young.dataPoints > 0);
    assert.ok((young.coverageYears as number) > 1);
    assert.equal(young.r3Y, null);
    assert.notEqual(
      young.rInception,
      null,
      "a 2-year fund still has a since-inception number",
    );
  });

  it("drops non-finite and non-positive NAVs instead of coercing them", () => {
    const base = series(minusYears(REF, 2), REF, 100, 130);
    const poisoned: NavDerivativePoint[] = [
      ...base,
      { date: "2026-03-01", nav: 0 },
      { date: "2026-03-02", nav: -5 },
      { date: "2026-03-03", nav: Number.NaN },
      { date: "2026-03-04", nav: Number.POSITIVE_INFINITY },
    ];
    const d = computeNavDerivatives(poisoned, opts);
    assert.equal(
      d.dataPoints,
      base.length,
      "the four poisoned rows were dropped",
    );
    assert.ok(
      (d.low52 as number) > 0,
      "a 0 NAV must never become the 52-week low",
    );
    assert.ok(Number.isFinite(d.high52 as number));
  });

  it("drops unparseable dates and future-dated rows", () => {
    const base = series(minusYears(REF, 2), REF, 100, 130);
    const d = computeNavDerivatives(
      [
        ...base,
        { date: "not-a-date", nav: 120 },
        { date: "2099-01-01", nav: 999 },
      ],
      opts,
    );
    assert.equal(d.dataPoints, base.length);
    assert.ok(
      (d.high52 as number) < 999,
      "a future-dated row must not set the 52-week high",
    );
  });

  it("de-duplicates a repeated date rather than double-counting it", () => {
    const d = computeNavDerivatives(
      [
        { date: "2026-08-01", nav: 10 },
        { date: "2026-08-01", nav: 11 },
        { date: "2026-08-02", nav: 12 },
      ],
      opts,
    );
    assert.equal(d.dataPoints, 2);
  });

  it("accepts unsorted input", () => {
    const d = computeNavDerivatives(
      [
        { date: "2026-08-03", nav: 12 },
        { date: "2026-08-01", nav: 10 },
        { date: "2026-08-02", nav: 11 },
      ],
      opts,
    );
    assert.equal(d.dataPoints, 3);
    assert.equal(d.high52, 12);
    assert.equal(d.low52, 10);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 52-week range
// ══════════════════════════════════════════════════════════════════════

describe("computeNavDerivatives — 52-week range", () => {
  it("uses only the trailing 365 days, not the whole series", () => {
    const points: NavDerivativePoint[] = [
      // An all-time high well outside the window.
      { date: minusYears(REF, 3), nav: 500 },
      { date: minusYears(REF, 2), nav: 400 },
    ];
    for (let i = 0; i < 40; i++) {
      points.push({
        date: new Date(REF.getTime() - i * 7 * DAY),
        nav: 100 + i,
      });
    }
    const d = computeNavDerivatives(points, opts);
    assert.ok(
      (d.high52 as number) < 400,
      `a 3-year-old peak must not be reported as a 52-week high (got ${d.high52})`,
    );
    assert.equal(d.high52, 139);
    assert.equal(d.low52, 100);
  });
});
