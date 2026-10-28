/**
 * UDF parity rules — MONEY-1468 (A3).
 *
 * The comparison decides whether the chart gets flipped, so its failure modes
 * are the expensive ones:
 *
 *   a tolerance that hides a real defect -> the flip ships a wrong chart
 *   a "failure" on a known divergence    -> the flip is blocked for ever, or,
 *                                           worse, somebody "fixes" tiles to
 *                                           match YAHOO — regressing to the
 *                                           weaker source while reporting
 *                                           success
 *   an empty run reading as a pass       -> parity proven over nothing
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PRICE_TOLERANCE_ABS,
  PRICE_TOLERANCE_PCT,
  VOLUME_TOLERANCE_PCT,
  classifyVolumeDiff,
  compareSeries,
  priceWithinTolerance,
  summarise,
  worstVerdict,
  type UdfSeries,
} from "../../../src/market-data/udf/parity-logic";

const ok = (t: number[], c: number[], v?: number[]): UdfSeries => ({
  s: "ok",
  t,
  o: c,
  h: c,
  l: c,
  c,
  v: v ?? t.map(() => 1000),
});

describe("the tolerances are what the brief says, and are not parameters", () => {
  it("0.5% or 0.05 absolute, 2% on volume", () => {
    // Pinned BY VALUE. Every parity failure is a wrong adjustment, a missing
    // year tile or a timezone split; widening a threshold converts a real
    // defect into a green report, so a change here has to fail a test first.
    assert.equal(PRICE_TOLERANCE_PCT, 0.005);
    assert.equal(PRICE_TOLERANCE_ABS, 0.05);
    assert.equal(VOLUME_TOLERANCE_PCT, 0.02);
  });

  it("EITHER bound satisfies the price check", () => {
    // A penny stock at 0.40 moves >0.5% on a 0.01 rounding; a large cap at
    // 3000 exceeds 0.05 absolute on any rounding at all. Both are Yahoo
    // rounding, so both bounds are needed.
    assert.ok(
      priceWithinTolerance(0.4, 0.44),
      "abs bound covers a small price",
    );
    assert.ok(
      priceWithinTolerance(3000, 3010),
      "pct bound covers a large price",
    );
    assert.ok(!priceWithinTolerance(100, 105), "5% is a real difference");
    assert.ok(
      !priceWithinTolerance(100, Number.NaN),
      "NaN is never within tolerance",
    );
  });
});

describe("a shape mismatch is the most important failure here", () => {
  it("no_data against ok is a FAILURE", () => {
    // One path draws a chart and the other draws nothing, and the blank one
    // shows no error. This is the single most likely symptom of a missing
    // tile, and it must never be softened.
    const r = compareSeries(
      "RELIANCE:NSE",
      "5y",
      ok([1, 2], [10, 11]),
      { s: "no_data" },
      {
        market: "IN",
        hadSplit: false,
      },
    );
    assert.equal(r.verdict, "failure");
    assert.match(r.notes.join(" "), /shape mismatch/);
  });

  it("nextTime must agree EXACTLY on a no_data pair", () => {
    // `nextTime` is what stops the widget looping backwards for ever, so a
    // difference is an infinite spinner on one path and not the other.
    const same = compareSeries(
      "X:NSE",
      "r",
      { s: "no_data", nextTime: 5 },
      { s: "no_data", nextTime: 5 },
      { market: "IN", hadSplit: false },
    );
    assert.equal(same.verdict, "match");
    const diff = compareSeries(
      "X:NSE",
      "r",
      { s: "no_data", nextTime: 5 },
      { s: "no_data" },
      { market: "IN", hadSplit: false },
    );
    assert.equal(diff.verdict, "failure");
    assert.match(diff.notes.join(" "), /nextTime/);
  });
});

describe("bar sets must be identical", () => {
  it("a missing bar is a FAILURE, not a rounding note", () => {
    // A tile missing one session — the timezone-split defect — shows up here
    // and nowhere else: every price that IS present still matches.
    const r = compareSeries(
      "X:NSE",
      "1y",
      ok([1, 2, 3], [10, 11, 12]),
      ok([1, 3], [10, 12]),
      {
        market: "IN",
        hadSplit: false,
      },
    );
    assert.equal(r.verdict, "failure");
    assert.deepEqual(r.missingFromCandidate, [2]);
  });

  it("an EXTRA bar is also a failure", () => {
    const r = compareSeries(
      "X:NSE",
      "1y",
      ok([1, 3], [10, 12]),
      ok([1, 2, 3], [10, 11, 12]),
      {
        market: "IN",
        hadSplit: false,
      },
    );
    assert.equal(r.verdict, "failure");
    assert.deepEqual(r.extraInCandidate, [2]);
  });

  it("bars are matched by TIMESTAMP, not by index", () => {
    // Index matching would compare a Tuesday against a Wednesday the moment
    // either series has a hole, turning one missing bar into N price failures.
    const r = compareSeries(
      "X:NSE",
      "1y",
      ok([1, 2, 3], [10, 20, 30]),
      ok([3, 2, 1], [30, 20, 10]),
      {
        market: "IN",
        hadSplit: false,
      },
    );
    assert.equal(
      r.verdict,
      "match",
      "same bars, different order, is not a price difference",
    );
  });
});

describe("volume divergence is EXPLAINED, never a failure, for the documented classes", () => {
  it("a split-factor ratio is explained", () => {
    // Yahoo back-adjusts volume across a split; a tile keeps raw volume scaled
    // by the factor. `applyAdjustment` multiplies volume where it DIVIDES
    // price, deliberately — the same turnover over R times as many shares.
    const { verdict, reason } = classifyVolumeDiff(1000, 2000, {
      market: "US",
      hadSplit: true,
    });
    assert.equal(verdict, "explained");
    assert.match(reason ?? "", /split/i);
  });

  it("India volume is reported, never failed", () => {
    const { verdict, reason } = classifyVolumeDiff(1000, 1500, {
      market: "IN",
      hadSplit: false,
    });
    assert.equal(verdict, "explained");
    assert.match(reason ?? "", /bhavcopy/i);
  });

  it("a US volume difference with NO split IS a failure", () => {
    // The one volume case that is a real defect: no split to explain it and a
    // market where both sides read the same consolidated tape.
    assert.equal(
      classifyVolumeDiff(1000, 1500, { market: "US", hadSplit: false }).verdict,
      "failure",
    );
  });

  it("`hadSplit` is SUPPLIED, never inferred from the discrepancy", () => {
    // Inferring "this looks like a split" from the very number under test is
    // how a real error explains itself away. Same ratio, no declared split:
    // still a failure.
    assert.equal(
      classifyVolumeDiff(1000, 2000, { market: "US", hadSplit: false }).verdict,
      "failure",
    );
    assert.equal(
      classifyVolumeDiff(1000, 2000, { market: "US", hadSplit: true }).verdict,
      "explained",
    );
  });

  it("a price difference is NEVER explained away", () => {
    // Volume has documented divergences. Price does not: the chart is read for
    // the price.
    const r = compareSeries(
      "X:NASDAQ:1",
      "1y",
      ok([1], [100]),
      ok([1], [130]),
      {
        market: "US",
        hadSplit: true,
      },
    );
    assert.equal(r.verdict, "failure", "a split must not excuse a wrong PRICE");
  });
});

describe("the roll-up gates the flip", () => {
  it("explained diffs do not block; failures do", () => {
    const base = {
      listing: "x",
      range: "r",
      shapeAgrees: true,
      baselineShape: "ok",
      candidateShape: "ok",
      baselineCount: 1,
      candidateCount: 1,
      missingFromCandidate: [],
      extraInCandidate: [],
      diffs: [],
      notes: [],
    };
    const s = summarise([
      { ...base, verdict: "match" as const },
      { ...base, verdict: "explained" as const },
    ]);
    assert.equal(s.pass, true);
    assert.equal(s.explained, 1);

    const withFailure = summarise([{ ...base, verdict: "failure" as const }]);
    assert.equal(withFailure.pass, false);
  });

  it("an EMPTY run is NOT a pass", () => {
    // `failed === 0` is true over nothing. A run that compared no listings
    // would otherwise certify parity it never measured.
    assert.equal(summarise([]).pass, false);
  });

  it("worstVerdict ranks failure above explained above match", () => {
    assert.equal(worstVerdict(["match", "explained", "failure"]), "failure");
    assert.equal(worstVerdict(["match", "explained"]), "explained");
    assert.equal(worstVerdict(["match"]), "match");
    assert.equal(worstVerdict([]), "match");
  });
});

describe("an error PAIR is a refusal, not agreement", () => {
  it("both sides s:error is a FAILURE", () => {
    // The most dangerous verdict this module can produce. An EXPIRED Clerk
    // token 401s every baseline while the candidate is mid-deploy, and the run
    // would otherwise report `matched = total, failed = 0, PASS = yes` over
    // comparisons that measured nothing. `main()` guards a MISSING token and
    // cannot see an expired one.
    const r = compareSeries(
      "X:NSE",
      "1y",
      { s: "error" },
      { s: "error" },
      {
        market: "IN",
        hadSplit: false,
      },
    );
    assert.equal(r.verdict, "failure");
    assert.match(r.notes.join(" "), /nothing was compared/i);
  });

  it("a whole run of error pairs cannot PASS", () => {
    const results = Array.from({ length: 360 }, () =>
      compareSeries(
        "X:NSE",
        "r",
        { s: "error" },
        { s: "error" },
        { market: "IN", hadSplit: false },
      ),
    );
    const s = summarise(results);
    assert.equal(s.failed, 360);
    assert.equal(
      s.pass,
      false,
      "360 comparisons that measured nothing must never certify a cutover",
    );
  });
});
