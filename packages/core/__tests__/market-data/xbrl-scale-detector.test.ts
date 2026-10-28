/**
 * UNIT TEST — the vendor-free scale detector (MONEY-1235, MONEY-1237).
 *
 * ## What this is guarding and why it had to be built before arming
 *
 * The F3 reconcile found 28 scale mismatches across 15 (symbol, period)
 * filings — 1000x (12), 100x (11), 10x (4), 10000x (1) — in BOTH directions and
 * each internally consistent across that filing's own fields. That is a filer
 * mis-declaring its own `roundingLabel`, not our arithmetic: one code path
 * projects every filing, so an arithmetic bug would be uniform rather than
 * fifteen companies going two different ways.
 *
 * Those 28 are only what the VENDOR OVERLAP could expose. 90.7% of winner
 * periods have no vendor row, and the entire quarterly universe (71,450 filings
 * against ZERO quarterly `stock_financials` rows) is CREATE-only, so
 * `reconcile()` is structurally blind to it. Hence a detector whose only oracle
 * is the company's OWN other filings.
 *
 * ## MONEY-1237 — the negative half is now the bigger half
 *
 * The MONEY-1235 rule compared against the median of the WHOLE history, and a
 * reviewer executing it found three ordinary company shapes convicted:
 * a reverse merger (factor 100 on 4 fields), a pure spin-off (factor 0.01 on 4
 * fields), and — structurally, not by mistuning — the newest and oldest annual
 * filing of ANY company compounding >= 3.16x/yr, because for `n` points at
 * constant growth `r` the newest sits at `r^((n-1)/2)` times the median and at
 * n=7 that is `r^3`. It also INVERTED when the mis-scale was the majority.
 *
 * Each of those four is a `describe` block below, and each one is a period that
 * would have been quarantined permanently and invisibly. The must-FLAG cases
 * are unchanged and still carry the reconcile's real magnitudes: a detector
 * tuned on invented round numbers is a detector tuned on nothing — the rule has
 * to survive 0.0241 against 239.8 as well as 31,892.57 against 31.89, and those
 * are three orders of magnitude apart in absolute size.
 *
 * Pure, synchronous, no I/O, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  judgeFilingScale,
  judgeCrossBasisPaidUpCapital,
  BASIS_CONFLICT_MIN_FACTOR,
  NEIGHBOUR_WINDOW,
  SCALE_FIELDS,
  type ScaleObservation,
} from "../../src/market-data/xbrl-scale-detector";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

let seq = 0;

/** The fiscal year every fixture's CANDIDATE sits in, unless it says otherwise. */
const CANDIDATE_YEAR = 2021;

/** 31 March of an Indian fiscal year. Only the ORDER of these matters. */
function fyEnd(year: number): Date {
  return new Date(Date.UTC(year, 2, 31));
}

interface Over extends Partial<Omit<ScaleObservation, "values" | "periodEnd">> {
  /**
   * The fiscal year this observation describes — MONEY-1237.
   *
   * Fixtures used to carry no period at all, which was fine when the rule was
   * "candidate versus the median of everything" and is the whole subject now:
   * the detector compares against the periods ADJACENT to the candidate, so a
   * fixture without a place in the series is not a weaker test, it is a
   * different one.
   */
  year?: number;
  /**
   * Re-admitted after `periodEnd` is Omit-ed above, so a fixture can be
   * DELIBERATELY undated (`periodEnd: undefined`).
   *
   * `year` is the normal path and derives `periodEnd` via `fyEnd`. But two
   * cases exercise the undated fallback on purpose — "a dated candidate never
   * reaches the fallback" — and express that by overriding the field. That
   * already worked at runtime, because `...rest` spreads AFTER
   * `periodEnd: fyEnd(year)`; only the type forbade saying it. Surfaced when
   * MONEY-1118 turned tsc on for these files for the first time.
   */
  periodEnd?: Date | undefined;
}

function obs(
  values: ScaleObservation["values"],
  over: Over = {},
): ScaleObservation {
  seq += 1;
  const { year = CANDIDATE_YEAR, ...rest } = over;
  return {
    filingId: `f-${seq}`,
    basis: "CONSOLIDATED",
    periodType: "ANNUAL",
    periodEnd: fyEnd(year),
    label: `FY ${year}`,
    ...rest,
    values,
  };
}

/**
 * `n` sibling years STRADDLING the candidate, around the same magnitudes.
 *
 * Alternating older/newer (−1, +1, −2, +2, …) rather than all on one side: the
 * detector's conviction rule needs a neighbour on both sides, so a helper that
 * stacked every sibling before the candidate would quietly turn every must-flag
 * case in this file into the one-sided SCALE_UNCONFIRMED case and the suite
 * would still look like it was testing convictions.
 *
 * Jittered by a few percent rather than repeated verbatim: identical siblings
 * would make the median trivially exact and would hide a detector that only
 * works on constant data. Real neighbouring years never repeat a figure.
 */
function neighbours(
  n: number,
  values: ScaleObservation["values"],
  over: Over = {},
): ScaleObservation[] {
  const base = over.year ?? CANDIDATE_YEAR;
  return Array.from({ length: n }, (_, i) => {
    const step = Math.floor(i / 2) + 1;
    const year = i % 2 === 0 ? base - step : base + step;
    // BOUNDED to +/-8% however long the series is. Scaling the jitter with `n`
    // (the original `(i - n/2) * 0.04`) meant a 40-filing fixture spread its
    // siblings over 8x, which is not "neighbouring years never repeat a figure"
    // — it is a growth curve, and the detector correctly refused to read a
    // growth curve as a rescale.
    const jitter = 1 + ((i % 5) - 2) * 0.04;
    const scaled: ScaleObservation["values"] = {};
    for (const f of SCALE_FIELDS) {
      const v = values[f];
      if (typeof v === "number") scaled[f] = v * jitter;
    }
    return obs(scaled, { ...over, year });
  });
}

/** A whole company's magnitudes at one level, scaled by `x`. */
function level(x: number): ScaleObservation["values"] {
  return {
    revenue: 1_200 * x,
    netIncome: 170 * x,
    totalAssets: 4_700 * x,
    totalEquity: 2_000 * x,
  };
}

/* -------------------------------------------------------------------------- */
/* The measured cases — every one must still be caught                         */
/* -------------------------------------------------------------------------- */

describe("judgeFilingScale — the mismatches the reconcile actually found", () => {
  it("SILGO FY2021: revenue 31,892.57 against neighbours near 31.89 → 1000x too large", () => {
    const candidate = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const context = neighbours(4, { revenue: 31.89, netIncome: 1.2 });

    const verdict = judgeFilingScale(candidate, context);
    assert.equal(verdict.verdict, "SCALE_SUSPECT");
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(verdict.factor, 1000);
    assert.deepEqual(verdict.fields.sort(), ["netIncome", "revenue"]);
  });

  it("TNTELE FY2024: netIncome −14,618.8 against neighbours near −14.62 → 1000x, sign irrelevant", () => {
    // A loss is not a scale defect. The detector compares MAGNITUDES precisely
    // so a company that swung from profit to loss is not flagged for the swing,
    // and a company reporting losses in the wrong unit still is.
    const candidate = obs({ netIncome: -14_618.8, revenue: 9_540.0 });
    const context = neighbours(4, { netIncome: -14.62, revenue: 9.54 });

    const verdict = judgeFilingScale(candidate, context);
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(verdict.factor, 1000);
  });

  it("PURVA FY2023: totalAssets 100.55 against neighbours near 10,055 → the OTHER direction", () => {
    // 11 of the 28 measured mismatches point this way. A magnitude-only factor
    // would have collapsed both directions into one number and thrown away
    // which side is wrong — which is exactly the judgement the quarantine
    // refuses to make automatically.
    const candidate = obs({ totalAssets: 100.55, totalEquity: 38.2 });
    const context = neighbours(4, { totalAssets: 10_055, totalEquity: 3_820 });

    const verdict = judgeFilingScale(candidate, context);
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(
      verdict.factor,
      0.01,
      "candidate ÷ neighbours — a hundred times too SMALL",
    );
  });

  it("IRCON FY2022: netIncome 5.92 against neighbours near 592 → 100x too small", () => {
    const candidate = obs({ netIncome: 5.92, revenue: 78.3 });
    const context = neighbours(4, { netIncome: 592, revenue: 7_830 });

    const verdict = judgeFilingScale(candidate, context);
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(verdict.factor, 0.01);
  });

  it("PRAJIND FY2023: 0.0241 against neighbours near 239.8 → 10,000x, the widest case", () => {
    // The extreme of the measured range, and the reason the threshold is a LOG
    // rather than a ratio: 0.0241 and 31,892.57 are six orders of magnitude
    // apart in absolute size and both have to be judged by the same rule.
    const candidate = obs({ netIncome: 0.0241, revenue: 0.0503 });
    const context = neighbours(4, { netIncome: 239.8, revenue: 501.2 });

    const verdict = judgeFilingScale(candidate, context);
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(verdict.factor, 0.0001);
  });

  it("catches the smallest measured factor — 10x, four of the 28", () => {
    // The threshold is |log10| >= 1.5 (~31.6x), so a clean 10x is BELOW it and
    // is deliberately not flagged. This asserts what the detector does at the
    // edge of the measured population rather than pretending it covers it:
    // 10x is left to the reconcile, which can see it where a vendor row exists.
    const candidate = obs({ revenue: 500, netIncome: 50 });
    const context = neighbours(4, { revenue: 50, netIncome: 5 });

    assert.equal(judgeFilingScale(candidate, context).verdict, "OK");
  });

  it("REGRESSION: the unmoved-field VETO does not block a WHOLE-document rescale", () => {
    // The complement of `a genuine collapse is a business event`. A
    // mis-declared `roundingLabel` scales every fact in the document, so all
    // four fields move together and there is nothing left to veto. If the veto
    // were written as "any field that did not move by the flagged factor", this
    // case would pass right through it — the detector would refuse to fire on
    // precisely the shape it exists for.
    const candidate = obs(level(100));
    const context = neighbours(4, level(1));

    const verdict = judgeFilingScale(candidate, context);
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(verdict.factor, 100);
    assert.equal(verdict.fields.length, 4, "every field agreed");
  });

  it("REGRESSION: a spike is still caught when the whole history is 40 filings long", () => {
    // The adjacent window (MONEY-1237) means the detector no longer sees most
    // of a long history. It must still catch the one bad year inside it — if
    // the window were drawn from the WRONG end of the series, or if the sides
    // were computed against the array rather than the period, this reads OK.
    const candidate = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const context = neighbours(40, { revenue: 31.89, netIncome: 1.2 });

    const verdict = judgeFilingScale(candidate, context);
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(verdict.factor, 1000);
    assert.equal(verdict.siblingPeriods, 40, "the tier is still the whole set");
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1237 — the real businesses the whole-history median convicted         */
/* -------------------------------------------------------------------------- */

describe("judgeFilingScale — whole-company STEP changes are not scale errors", () => {
  /**
   * A reverse merger: a small listed shell absorbs a large private business, so
   * revenue, profit, assets and equity all jump ~100x TOGETHER and stay there.
   * Routine in India, and the exact shape the unmoved-field veto cannot see —
   * the veto needs a field that barely moved, and here nothing stayed put.
   *
   * Executed against the MONEY-1235 rule by a reviewer this returned
   * `SCALE_SUSPECT factor 100 (4 fields)`: a real, correct period quarantined
   * and — because the writer stamped the quarantine — lost for good.
   */
  const merger = (): ScaleObservation[] => [
    obs(level(1), { year: 2018 }),
    obs(level(1.05), { year: 2019 }),
    obs(level(1.1), { year: 2020 }),
    obs(level(100), { year: 2021 }), // the merger lands
    obs(level(108), { year: 2022 }),
    obs(level(115), { year: 2023 }),
  ];

  it("REGRESSION: the merger year itself is OK once the company has filed again", () => {
    const series = merger();
    const transitional = series[3]!;

    const verdict = judgeFilingScale(transitional, series);
    assert.equal(
      verdict.verdict,
      "OK",
      "100x above the older side and level with the newer side is a STEP",
    );
  });

  it("…and so is every other year in the series", () => {
    const series = merger();
    for (const candidate of series) {
      const verdict = judgeFilingScale(candidate, series);
      assert.notEqual(
        verdict.verdict,
        "SCALE_SUSPECT",
        `${candidate.label} must not be convicted`,
      );
    }
  });

  it("the merger year at the NEWEST edge is HELD, not convicted", () => {
    // The honest boundary, and the reason `SCALE_UNCONFIRMED` exists. With no
    // filing after it, a 100x step and a 100x mis-scale are the same picture —
    // no rule reading magnitudes can separate them. Convicting would lose the
    // merger (that is the defect); passing would write an unchecked figure into
    // a table with no `source` in its unique key (that is the other defect).
    // So it is held: nothing written, nothing STAMPED, counted by the writer,
    // and re-judged every night until the next filing settles it.
    const series = merger().slice(0, 4);
    const verdict = judgeFilingScale(series[3]!, series);

    assert.equal(verdict.verdict, "SCALE_UNCONFIRMED");
    assert.ok(verdict.verdict === "SCALE_UNCONFIRMED");
    assert.equal(verdict.missingSide, "NEWER");
    assert.equal(verdict.factor, 100);
  });

  it("…and the hold RESOLVES ITSELF the moment the next period lands", () => {
    // The pair that makes the hold a deferral rather than a slower gap. Same
    // filing, same magnitudes, one more year of history.
    const series = merger().slice(0, 5);
    assert.equal(judgeFilingScale(series[3]!, series).verdict, "OK");
  });

  it("REGRESSION: a pure SPIN-OFF of the operating business is not a rescale", () => {
    // The mirror image, and the reviewer measured it as `SCALE_SUSPECT factor
    // 0.01 (4 fields)`. The company sells its whole operating division: revenue,
    // profit, assets and equity all fall ~100x and stay down.
    const series = [
      obs(level(100), { year: 2018 }),
      obs(level(104), { year: 2019 }),
      obs(level(110), { year: 2020 }),
      obs(level(1), { year: 2021 }), // the spin-off
      obs(level(1.05), { year: 2022 }),
      obs(level(1.1), { year: 2023 }),
    ];

    for (const candidate of series) {
      assert.notEqual(
        judgeFilingScale(candidate, series).verdict,
        "SCALE_SUSPECT",
        `${candidate.label} must not be convicted`,
      );
    }
    assert.equal(judgeFilingScale(series[3]!, series).verdict, "OK");
  });
});

describe("judgeFilingScale — sustained growth is a RAMP, not a spike", () => {
  /**
   * THE STRUCTURAL DEFECT, and the reason this block exists rather than a
   * tuning tweak.
   *
   * For `n` points at a constant growth rate `r`, newest ÷ median = `r^((n-1)/2)`.
   * At n = 7 that is `r^3`, and the flag fires at `r^3 >= 31.6` — so under the
   * MONEY-1235 rule EVERY company compounding >= 3.16x/yr lost its newest AND
   * its oldest annual filing, on both ends of the series, forever. Nothing
   * about that was a threshold that needed nudging; the statistic was wrong.
   *
   * Against the adjacent window the interior years compare against a side that
   * is `r^2` BELOW them and a side that is `r^2` ABOVE them, so the two
   * exponents are +1 and −1 and there is no agreement. At the edges only one
   * side exists, and against the nearest 3 the median sits at `r^-2`, so the
   * flag needs `r^2 >= 31.6`, i.e. sustained 5.62x/yr.
   */
  const compounder = (r: number): ScaleObservation[] =>
    [2018, 2019, 2020, 2021, 2022, 2023, 2024].map((year, i) =>
      obs(level(r ** i), { year }),
    );

  it("REGRESSION: 3x/yr over seven filings — every year, including both edges", () => {
    const series = compounder(3);
    for (const candidate of series) {
      const verdict = judgeFilingScale(candidate, series);
      assert.equal(
        verdict.verdict,
        "OK",
        `${candidate.label} came back ${verdict.verdict}`,
      );
    }
  });

  it("the NEWEST filing of a 3x/yr compounder is not even held", () => {
    // Sharper than the sweep above: the newest filing is the one the steady
    // state judges every single night (its older siblings are fetched, its
    // newer ones do not exist yet). If it landed in SCALE_UNCONFIRMED the job
    // would hold back the newest year of every fast-growing company forever.
    const series = compounder(3);
    assert.equal(judgeFilingScale(series[6]!, series).verdict, "OK");
    assert.equal(judgeFilingScale(series[0]!, series).verdict, "OK");
  });

  it("…and an interior year survives growth the one-sided edge could not", () => {
    // 10x/yr is past the 5.62x/yr the edge tolerates, and the interior still
    // reads OK — because the older side is 100x BELOW and the newer side 100x
    // ABOVE, which rounds to +2 and −2 and is not agreement. This is the
    // property that makes the rule "a spike, in the same direction on both
    // sides" rather than "far from its neighbours".
    const series = compounder(10);
    assert.equal(judgeFilingScale(series[3]!, series).verdict, "OK");
  });
});

describe("judgeFilingScale — a MAJORITY mis-scale no longer inverts", () => {
  /**
   * THE INVERSION, which is the shape a template-level `roundingLabel` error
   * takes: a filer switches units and keeps filing that way. Under the
   * whole-history median the three bad filings ARE the median, so the one
   * correct filing was 1000x from it and was the one quarantined — the detector
   * writing the three wrong numbers and dropping the right one.
   *
   * What the adjacent rule can and cannot do here is worth stating plainly:
   * `good, bad, bad, bad` is, in magnitudes alone, the identical series to a
   * company that grew 1000x and stayed there. No rule reading only these four
   * numbers can convict the three. What it CAN do is stop convicting the one —
   * and that is what these assertions pin.
   */
  const templateError = (): ScaleObservation[] => [
    obs({ revenue: 30, netIncome: 1.1 }, { year: 2020 }), // the correct filing
    obs({ revenue: 30_000, netIncome: 1_100 }, { year: 2021 }),
    obs({ revenue: 31_000, netIncome: 1_150 }, { year: 2022 }),
    obs({ revenue: 33_000, netIncome: 1_230 }, { year: 2023 }),
  ];

  it("REGRESSION: the CORRECT filing is not quarantined", () => {
    const series = templateError();
    const verdict = judgeFilingScale(series[0]!, series);

    assert.notEqual(
      verdict.verdict,
      "SCALE_SUSPECT",
      "three bad siblings must not convict the one good filing",
    );
    // It is HELD rather than passed, and that is the correct answer on this
    // evidence: it is the oldest filing we hold, so the only side that exists
    // disagrees, and one side cannot tell a mis-scale from a company that grew.
    assert.equal(verdict.verdict, "SCALE_UNCONFIRMED");
    assert.ok(verdict.verdict === "SCALE_UNCONFIRMED");
    assert.equal(verdict.missingSide, "OLDER");
  });

  it("DOCUMENTED MISS: the three mis-scaled filings are NOT caught", () => {
    // Written down as an assertion rather than left as a hope. FY2021 agrees
    // with the two filings after it, FY2022 and FY2023 agree with the ones on
    // both sides — there is nothing in the series that says which level is the
    // real one. Catching these needs a signal from OUTSIDE the series: the
    // filing's own `roundingLabel` read against its own magnitudes.
    const series = templateError();
    for (const candidate of series.slice(1)) {
      assert.equal(
        judgeFilingScale(candidate, series).verdict,
        "OK",
        `${candidate.label}`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The negatives that predate MONEY-1237                                       */
/* -------------------------------------------------------------------------- */

describe("judgeFilingScale — what must NOT be flagged", () => {
  it("a healthy symbol whose figures simply grow", () => {
    const candidate = obs({
      revenue: 1_240,
      netIncome: 180,
      totalAssets: 4_900,
      totalEquity: 2_100,
    });
    const context = neighbours(5, {
      revenue: 1_100,
      netIncome: 160,
      totalAssets: 4_400,
      totalEquity: 1_900,
    });

    const verdict = judgeFilingScale(candidate, context);
    assert.equal(verdict.verdict, "OK");
    assert.ok(verdict.verdict === "OK");
    assert.equal(
      verdict.siblingPeriods,
      5,
      "the oracle was actually consulted",
    );
  });

  it("REGRESSION: a genuine collapse is a business event, not a scale error", () => {
    // Revenue falls 40x — a demerger, a lost contract, an asset sale — while
    // the balance sheet stays put. That is precisely the shape ONE field would
    // flag and TWO cannot, and it is the reason the two-field rule exists at
    // all. Quarantining it would silently drop a real, correct period.
    const candidate = obs({
      revenue: 30,
      netIncome: 4,
      totalAssets: 4_800,
      totalEquity: 2_050,
    });
    const context = neighbours(4, {
      revenue: 1_200,
      netIncome: 170,
      totalAssets: 4_700,
      totalEquity: 2_000,
    });

    assert.equal(judgeFilingScale(candidate, context).verdict, "OK");
  });

  it("REGRESSION: two fields off by DIFFERENT powers of ten do not agree", () => {
    // A mis-declared unit scales every fact in the document by ONE factor, so
    // internally inconsistent movement is something else — and quarantining on
    // it would be a guess wearing the costume of a measurement.
    const candidate = obs({ revenue: 120_000, netIncome: 0.17 });
    const context = neighbours(4, { revenue: 1_200, netIncome: 170 });

    assert.equal(judgeFilingScale(candidate, context).verdict, "OK");
  });

  it("a single field moving alone is never enough, however far it moves", () => {
    // The second field deliberately sits BETWEEN the thresholds: netIncome is
    // 10x its median, which is neither evidence (>= 31.6x) nor a veto (< 3.16x).
    // That isolates the two-field rule as the only thing standing between this
    // fixture and a quarantine — with a stable second field the VETO would
    // rescue it and this test would pass no matter what
    // `MIN_AGREEING_FIELDS` said, which is a test that guards nothing.
    const candidate = obs({ revenue: 1_200_000, netIncome: 1_700 });
    const context = neighbours(4, { revenue: 1_200, netIncome: 170 });

    assert.equal(judgeFilingScale(candidate, context).verdict, "OK");
  });
});

/* -------------------------------------------------------------------------- */
/* No oracle is not a pass                                                     */
/* -------------------------------------------------------------------------- */

describe("judgeFilingScale — INSUFFICIENT_CONTEXT is its own answer", () => {
  it("REGRESSION: a caller bug is NOT reported as 'not enough history'", () => {
    // THE DEFECT MONEY-1236 FOUND. `xbrl-reconcile.ts` graded QUARTERLY
    // candidates against an ANNUAL-only context. The candidate was not in the
    // array at all, so the array-position fallback could not place it and the
    // verdict was INSUFFICIENT_CONTEXT on EVERY quarterly filing —
    // indistinguishable from a first-ever filer, and therefore invisible, right
    // before a drain that writes exactly that population.
    //
    // The verdict is still INSUFFICIENT_CONTEXT (it genuinely is), but the
    // CAUSE must be nameable, because the two need opposite responses: one is
    // benign, the other means the quarantine is off and the caller is wrong.
    //
    // Undated on purpose — a dated candidate never reaches the fallback.
    const candidate = obs(
      { revenue: 31_892.57, netIncome: 1_204.3 },
      { periodEnd: undefined, periodType: "QUARTERLY" },
    );
    const context = neighbours(4, { revenue: 31.89, netIncome: 1.2 }).map(
      (o) => ({ ...o, periodEnd: undefined }),
    );

    const verdict = judgeFilingScale(candidate, context);
    assert.equal(verdict.verdict, "INSUFFICIENT_CONTEXT");
    assert.ok(verdict.verdict === "INSUFFICIENT_CONTEXT");
    assert.equal(
      verdict.reason,
      "CANDIDATE_NOT_IN_CONTEXT",
      "a context that omits the candidate is a CALLER BUG, not a short history",
    );
  });

  it("the CONTROL: the same candidate IN its context is judged normally", () => {
    // Without this the assertion above passes for the wrong reason — any
    // fixture the detector refuses would satisfy it. Same numbers, same
    // undated observations, candidate present: a real verdict comes back.
    const candidate = obs(
      { revenue: 31_892.57, netIncome: 1_204.3 },
      { periodEnd: undefined, periodType: "QUARTERLY" },
    );
    const context = [
      candidate,
      ...neighbours(4, { revenue: 31.89, netIncome: 1.2 }).map((o) => ({
        ...o,
        periodEnd: undefined,
        periodType: "QUARTERLY",
      })),
    ];

    const verdict = judgeFilingScale(candidate, context);
    assert.notEqual(
      verdict.verdict,
      "INSUFFICIENT_CONTEXT",
      "the same evidence must produce a real verdict once the candidate is present",
    );
  });

  it("a genuinely short history reports NO_SIBLINGS, the benign cause", () => {
    const candidate = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const verdict = judgeFilingScale(
      candidate,
      neighbours(1, { revenue: 31.89 }),
    );
    assert.ok(verdict.verdict === "INSUFFICIENT_CONTEXT");
    assert.equal(verdict.reason, "NO_SIBLINGS");
  });

  it("one sibling period cannot convict anything", () => {
    // A median over a single point IS that point, so one mis-scaled sibling
    // would convict a healthy candidate — the detector's own defect turned into
    // a data loss.
    const candidate = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const context = neighbours(1, { revenue: 31.89, netIncome: 1.2 });

    const verdict = judgeFilingScale(candidate, context);
    assert.equal(verdict.verdict, "INSUFFICIENT_CONTEXT");
    assert.ok(verdict.verdict === "INSUFFICIENT_CONTEXT");
    assert.equal(verdict.siblingPeriods, 1);
  });

  it("REGRESSION: TWO siblings are not enough either — a two-point median is a MEAN", () => {
    // Found by running the writer over a real three-filing symbol: with the
    // floor at two, the mis-scaled year dragged its neighbours' median ~500x
    // and ALL THREE filings came back SCALE_SUSPECT. One bad document
    // quarantining a whole short-history symbol is a worse outcome than never
    // judging it, because the quarantine is silent and the unjudged filing is
    // still reconcilable.
    //
    // Three is the smallest sample whose median ignores one outlier — and one
    // outlier is precisely what this module hunts, so the floor and the
    // hypothesis are the same number by construction.
    const candidate = obs({ revenue: 31.89, netIncome: 1.2 }, { year: 2021 });
    const context = [
      obs({ revenue: 31_892.57, netIncome: 1_204.3 }, { year: 2020 }),
      obs({ revenue: 33.1, netIncome: 1.3 }, { year: 2022 }),
    ];

    const verdict = judgeFilingScale(candidate, context);
    assert.equal(
      verdict.verdict,
      "INSUFFICIENT_CONTEXT",
      "a healthy filing must not be convicted by its one bad neighbour",
    );
    assert.ok(verdict.verdict === "INSUFFICIENT_CONTEXT");
    assert.equal(verdict.siblingPeriods, 2);
  });

  it("…and with THREE siblings the median absorbs that same outlier", () => {
    // The complement: add one more good year and the healthy candidate is
    // judged, correctly, as fine — while the mis-scaled year beside it is still
    // caught. If raising the floor had merely switched the detector off for
    // small symbols this case would read INSUFFICIENT_CONTEXT too.
    const healthy = obs({ revenue: 31.89, netIncome: 1.2 }, { year: 2019 });
    const suspect = obs(
      { revenue: 31_892.57, netIncome: 1_204.3 },
      { year: 2021 },
    );
    const good = [
      obs({ revenue: 30.4, netIncome: 1.1 }, { year: 2020 }),
      obs({ revenue: 33.1, netIncome: 1.3 }, { year: 2022 }),
      obs({ revenue: 32.2, netIncome: 1.25 }, { year: 2023 }),
    ];

    assert.equal(
      judgeFilingScale(healthy, [suspect, ...good]).verdict,
      "OK",
      "the outlier sibling is outvoted by the median",
    );
    assert.equal(
      judgeFilingScale(suspect, [healthy, ...good]).verdict,
      "SCALE_SUSPECT",
      "…and the outlier itself is still caught",
    );
  });

  it("a first-ever filer has no context at all", () => {
    const candidate = obs({ revenue: 100, netIncome: 10 });
    assert.equal(
      judgeFilingScale(candidate, []).verdict,
      "INSUFFICIENT_CONTEXT",
    );
  });

  it("the candidate is never its own sibling", () => {
    // Compared against itself every ratio is 1 and nothing is ever flagged —
    // the detector would pass everything while looking like it ran.
    const candidate = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const verdict = judgeFilingScale(candidate, [candidate]);
    assert.equal(verdict.verdict, "INSUFFICIENT_CONTEXT");
    assert.ok(verdict.verdict === "INSUFFICIENT_CONTEXT");
    assert.equal(verdict.siblingPeriods, 0);
  });

  it("siblings carrying no comparable magnitudes are not context", () => {
    // A governance filing projects nothing. Counting it as a sibling would
    // inflate the tier past the floor while contributing zero comparisons —
    // the count would say "judged" and the judgement would be empty.
    const candidate = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const context = [
      obs({}, { year: 2019 }),
      obs({}, { year: 2020 }),
      obs({ revenue: 31.89 }, { year: 2022 }),
    ];

    assert.equal(
      judgeFilingScale(candidate, context).verdict,
      "INSUFFICIENT_CONTEXT",
    );
  });

  it("one sibling VALUE for a field leaves that field out of the vote", () => {
    // Tier-level context is sufficient (three siblings) but only ONE of them
    // carries `netIncome`, so netIncome cannot vote and revenue is left alone.
    const candidate = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const context = [
      obs({ revenue: 31.89, netIncome: 1.2 }, { year: 2020 }),
      obs({ revenue: 33.1 }, { year: 2022 }),
      obs({ revenue: 30.4 }, { year: 2019 }),
    ];

    assert.equal(judgeFilingScale(candidate, context).verdict, "OK");
  });

  it("REGRESSION: the sample floor is PER FIELD, not just per tier", () => {
    // Three siblings — a healthy tier — but only TWO of them disclose
    // `netIncome`. That column therefore has a two-point mean standing in for a
    // median, with all the fragility the case above measures, while the run
    // looks perfectly well supplied. Enforcing the floor only at tier level
    // leaves exactly this hole, and it is invisible: the verdict flips from OK
    // to SCALE_SUSPECT on a filing whose revenue evidence never changed.
    //
    // MONEY-1237 kept this floor at TIER level rather than per side. Per side
    // it would be a much harsher rule and would have switched the detector off
    // for the real SILGO case, which has exactly one older sibling.
    const candidate = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const context = [
      obs({ revenue: 31.89, netIncome: 1.2 }, { year: 2020 }),
      obs({ revenue: 33.1, netIncome: 1.3 }, { year: 2022 }),
      obs({ revenue: 30.4 }, { year: 2019 }),
    ];

    assert.equal(
      judgeFilingScale(candidate, context).verdict,
      "OK",
      "netIncome had only two samples and must not have been allowed to vote",
    );
  });

  it("zero is not a magnitude — log10(0) would be an infinite scale error", () => {
    const candidate = obs({ revenue: 0, netIncome: 0 });
    const context = neighbours(4, { revenue: 1_200, netIncome: 170 });

    assert.equal(judgeFilingScale(candidate, context).verdict, "OK");
  });

  it("REGRESSION: siblings that all share the candidate's PERIOD are no oracle", () => {
    // Three comparable siblings, so the tier floor passes — and not one of them
    // is a NEIGHBOURING period. Answering OK here would be a silent pass on an
    // unjudged filing, which is the outcome MONEY-1237's `skippedScaleCheck`
    // counter exists to make visible; answering SCALE_SUSPECT would convict on
    // a comparison between different VIEWS of one period rather than between
    // periods.
    const candidate = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const context = neighbours(3, { revenue: 31.89, netIncome: 1.2 }).map(
      (o) => ({ ...o, periodEnd: candidate.periodEnd }),
    );

    const verdict = judgeFilingScale(candidate, context);
    assert.equal(verdict.verdict, "INSUFFICIENT_CONTEXT");
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1237 — how the series gets ordered                                    */
/* -------------------------------------------------------------------------- */

describe("judgeFilingScale — placing the candidate in its own series", () => {
  it(`compares against the ${NEIGHBOUR_WINDOW} nearest periods on each side, not the whole history`, () => {
    // The far past is 1000x, the adjacent years are level with the candidate.
    // Under the whole-history median this reads SCALE_SUSPECT; under the
    // adjacent window it is a company that used to be much bigger.
    const candidate = obs({ revenue: 31.89, netIncome: 1.2 }, { year: 2024 });
    const context = [
      ...[2021, 2022, 2023].map((year) =>
        obs({ revenue: 31, netIncome: 1.15 }, { year }),
      ),
      ...[2014, 2015, 2016, 2017, 2018, 2019, 2020].map((year) =>
        obs({ revenue: 31_000, netIncome: 1_150 }, { year }),
      ),
    ];

    assert.equal(judgeFilingScale(candidate, context).verdict, "OK");
  });

  it("REGRESSION: falls back to the caller's ARRAY ORDER when no period is carried", () => {
    // `scripts/data/xbrl-reconcile.ts` builds `ScaleObservation`s without a
    // `periodEnd` — it predates MONEY-1237 and lives outside this ticket's
    // ownership. Its context list comes straight from
    // `orderBy: [{symbol:"asc"},{periodEnd:"desc"}]`, so index 0 is the NEWEST
    // filing, and the fallback reads exactly that. Without it the gate that
    // GUARDS the arming of this pipeline would silently stop convicting
    // anything — the writer and its own precondition measuring different
    // things, which is the defect class this ticket family exists to remove.
    const strip = (o: ScaleObservation): ScaleObservation => {
      const { periodEnd: _drop, ...rest } = o;
      return rest;
    };
    const suspect = strip(
      obs({ revenue: 31_892.57, netIncome: 1_204.3 }, { year: 2021 }),
    );
    // NEWEST FIRST, the way the query returns it.
    const context = [
      strip(obs({ revenue: 33.1, netIncome: 1.3 }, { year: 2023 })),
      strip(obs({ revenue: 32.2, netIncome: 1.25 }, { year: 2022 })),
      suspect,
      strip(obs({ revenue: 30.4, netIncome: 1.1 }, { year: 2020 })),
      strip(obs({ revenue: 29.8, netIncome: 1.05 }, { year: 2019 })),
    ];

    const verdict = judgeFilingScale(suspect, context);
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(verdict.factor, 1000);
  });

  it("REGRESSION: a dated candidate is never mixed with undated siblings", () => {
    // Epoch milliseconds and array indices on one axis is not a degraded
    // ordering, it is a wrong one: every dated observation would sort after
    // every undated one. All-or-nothing, so a half-dated context falls back to
    // array order for everything — and here the array order is deliberately
    // SCRAMBLED, so the sides are meaningless and the answer must not be a
    // conviction.
    const suspect = obs({ revenue: 31_892.57, netIncome: 1_204.3 });
    const context = [
      obs({ revenue: 33.1, netIncome: 1.3 }, { year: 2023 }),
      suspect,
      { ...obs({ revenue: 30.4, netIncome: 1.1 }, { year: 2020 }) },
      obs({ revenue: 29.8, netIncome: 1.05 }, { year: 2019 }),
    ];
    delete context[2]!.periodEnd;

    const verdict = judgeFilingScale(suspect, context);
    // Array order says: newest=2023, then the suspect, then 2020, then 2019 —
    // which happens to be the true chronological order, so this one still
    // convicts. The assertion that matters is that it did not throw and did not
    // read the two scales as one axis.
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(verdict.factor, 1000);
  });

  it("REGRESSION: an unplaceable candidate is INSUFFICIENT_CONTEXT, never a conviction", () => {
    // No `periodEnd`, and not present in its own context either, so nothing
    // says where it sits in the series. A future caller that hands over a
    // scrambled list gets "no oracle" rather than a verdict derived from
    // whatever order the rows happened to arrive in.
    const strip = (o: ScaleObservation): ScaleObservation => {
      const { periodEnd: _drop, ...rest } = o;
      return rest;
    };
    const candidate = strip(obs({ revenue: 31_892.57, netIncome: 1_204.3 }));
    const context = neighbours(4, { revenue: 31.89, netIncome: 1.2 }).map(
      strip,
    );

    const verdict = judgeFilingScale(candidate, context);
    assert.equal(verdict.verdict, "INSUFFICIENT_CONTEXT");
    assert.ok(verdict.verdict === "INSUFFICIENT_CONTEXT");
    assert.equal(
      verdict.siblingPeriods,
      4,
      "the tier was found, the order was not",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Choosing the comparable siblings                                            */
/* -------------------------------------------------------------------------- */

describe("judgeFilingScale — the context tier", () => {
  it("REGRESSION: same-basis siblings win, so a holding company is not convicted", () => {
    // A pure holding company's consolidated figures can be 1000x its standalone
    // ones. Comparing a STANDALONE filing against consolidated siblings would
    // flag every standalone filing that company ever made — and standalone-only
    // is 29.5% of winner periods, so the detector would have quarantined a
    // third of the universe on its first armed night.
    const candidate = obs(
      { revenue: 10, netIncome: 2 },
      { basis: "STANDALONE" },
    );
    const context = [
      ...neighbours(3, { revenue: 10, netIncome: 2 }, { basis: "STANDALONE" }),
      ...neighbours(
        4,
        { revenue: 10_000, netIncome: 2_000 },
        { basis: "CONSOLIDATED" },
      ),
    ];

    const verdict = judgeFilingScale(candidate, context);
    assert.equal(verdict.verdict, "OK");
    assert.ok(verdict.verdict === "OK");
    assert.equal(
      verdict.siblingPeriods,
      3,
      "only the three standalone siblings were consulted",
    );
  });

  it("falls back to same-periodType when a basis has too few filings of its own", () => {
    // One standalone sibling is below the floor, so the ladder widens rather
    // than answering INSUFFICIENT_CONTEXT — a company that files consolidated
    // most years and standalone once still gets judged.
    const candidate = obs(
      { revenue: 31_892.57, netIncome: 1_204.3 },
      { basis: "STANDALONE" },
    );
    const context = [
      ...neighbours(
        1,
        { revenue: 31.89, netIncome: 1.2 },
        { basis: "STANDALONE" },
      ),
      ...neighbours(3, { revenue: 31.89, netIncome: 1.2 }),
    ];

    const verdict = judgeFilingScale(candidate, context);
    assert.ok(verdict.verdict === "SCALE_SUSPECT");
    assert.equal(verdict.factor, 1000);
    assert.equal(verdict.siblingPeriods, 4, "all four periods, both bases");
  });

  it("a quarter is judged against quarters, not against the year", () => {
    // Four quarters make a year, so mixing period types injects a systematic 4x
    // before any defect is measured. Well below the threshold on its own — but
    // it moves every field in the same direction, which is exactly the
    // agreement the detector treats as signal.
    const candidate = obs(
      { revenue: 300, netIncome: 42 },
      { periodType: "QUARTERLY" },
    );
    const context = [
      ...neighbours(
        3,
        { revenue: 300, netIncome: 42 },
        { periodType: "QUARTERLY" },
      ),
      ...neighbours(4, { revenue: 1_200, netIncome: 170 }),
    ];

    const verdict = judgeFilingScale(candidate, context);
    assert.equal(verdict.verdict, "OK");
    assert.ok(verdict.verdict === "OK");
    assert.equal(verdict.siblingPeriods, 3);
  });

  it("REGRESSION: the periodType tier is a REAL rung, not a pass-through", () => {
    // The case above never exercises it: same-basis-AND-same-periodType already
    // has three members, so the ladder returns at rung one. And the fallback
    // case has no siblings of a different period type, so rung two and the
    // final `return siblings` produce the identical set — deleting rung two
    // would leave both green.
    //
    // Here the candidate's own basis has only ONE quarterly sibling (rung one
    // fails), quarterly siblings of the other basis make three (rung two), and
    // there are four ANNUAL filings besides. Rung two must return 4, not 8:
    // a quarter compared against annual siblings carries a systematic 4x that
    // moves every field the same way, which is precisely the agreement this
    // detector reads as signal.
    const candidate = obs(
      { revenue: 300, netIncome: 42 },
      { periodType: "QUARTERLY", basis: "STANDALONE" },
    );
    const context = [
      ...neighbours(
        1,
        { revenue: 300, netIncome: 42 },
        { periodType: "QUARTERLY", basis: "STANDALONE" },
      ),
      ...neighbours(
        3,
        { revenue: 300, netIncome: 42 },
        { periodType: "QUARTERLY" },
      ),
      ...neighbours(4, { revenue: 1_200, netIncome: 170 }),
    ];

    const verdict = judgeFilingScale(candidate, context);
    assert.ok(verdict.verdict === "OK");
    assert.equal(
      verdict.siblingPeriods,
      4,
      "the four QUARTERLY siblings, and not the four annual ones as well",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1250 (T3.2) — the CROSS-BASIS invariant                               */
/* -------------------------------------------------------------------------- */

/**
 * `PaidUpValueOfEquityShareCapital` is the PARENT's issued share capital, so a
 * company's CONSOLIDATED and STANDALONE filings for one period must state the
 * same number. When they do not, one of those two documents is mis-scaled.
 *
 * This exists because the neighbour rule above cannot reach the population that
 * needs it most. Measured on prod 2026-08-26 under the writer's own nightly
 * scoping: 123 winner periods have ZERO comparable siblings and 455 have
 * exactly one — 578 filings it will answer INSUFFICIENT_CONTEXT for, forever —
 * and its recall over the filings the vendor can independently expose is 31%
 * (5 of 16).
 *
 * The fixtures below carry the REAL prod magnitudes. A rule tuned on invented
 * round numbers is a rule tuned on nothing.
 */

/** A filing with a paid-up tag, deliberately WITHOUT usable scale magnitudes. */
function paidUpObs(
  paid: number,
  over: Over & { rounding?: string } = {},
): ScaleObservation {
  const { rounding, ...rest } = over;
  return {
    ...obs({}, rest),
    paidUpEquityShareCapital: paid,
    ...(rounding !== undefined ? { roundingLabel: rounding } : {}),
  };
}

describe("judgeCrossBasisPaidUpCapital — the invariant itself", () => {
  it("TRENT FY2022: CONS 0.3555 (Lakhs) vs STAN 35.55 (Crores) → held", () => {
    // Real prod row. The consolidated document is written in the wrong unit
    // throughout — its revenue series breaks 2592.96 -> 44.98 -> 8242.02 — and
    // no vendor row and no sibling count is needed to see it.
    const candidate = paidUpObs(3_555_000, {
      year: 2022,
      rounding: "Lakhs",
    });
    const counterpart = paidUpObs(355_500_000, {
      year: 2022,
      basis: "STANDALONE",
      rounding: "Crores",
    });

    const v = judgeCrossBasisPaidUpCapital(candidate, [candidate, counterpart]);
    assert.ok(v, "the invariant must fire on a 100x cross-basis disagreement");
    assert.equal(v.verdict, "SCALE_BASIS_CONFLICT");
    assert.equal(v.ratio, 0.01);
    assert.equal(v.paidUpEquityShareCapital, 3_555_000);
    assert.equal(v.counterpartPaidUpEquityShareCapital, 355_500_000);
    assert.equal(v.counterpartFilingId, counterpart.filingId);
    assert.equal(v.counterpartBasis, "STANDALONE");
    assert.equal(v.roundingLabel, "Lakhs");
    assert.equal(v.counterpartRoundingLabel, "Crores");
  });

  it("SHK FY2023: 1,000,006x with BOTH bases labelled Crores → STILL only held", () => {
    // The founder decision in one fixture. This is not a whole-filing rescale —
    // both documents declare the same rounding and nothing else in SHK's
    // FY2023 is disturbed, so it is one mis-tagged element. Multiplying by the
    // observed factor would be right for TRENT above and would destroy this
    // filing, into a table whose unique key has no `source`.
    const candidate = paidUpObs(1_384_200_000, {
      year: 2023,
      rounding: "Crores",
    });
    const counterpart = paidUpObs(1_384_208_010_000_000, {
      year: 2023,
      basis: "STANDALONE",
      rounding: "Crores",
    });

    const v = judgeCrossBasisPaidUpCapital(candidate, [candidate, counterpart]);
    assert.ok(v);
    assert.equal(v.verdict, "SCALE_BASIS_CONFLICT");
    // The RAW ratio, not rounded to a power of ten: 1,000,006x is not 1e6, and
    // the difference between them is the only hint in the payload about which
    // of the two readings applies.
    assert.notEqual(v.ratio, 1e-6);
    assert.ok(Math.abs(v.ratio - 1 / 1_000_006) < 1e-12);
    // The verdict must SAY what it could not distinguish. A bare factor reads
    // like an instruction to multiply.
    assert.match(v.undecidable, /WHICH SIDE/);
    assert.match(v.undecidable, /WHOLE FILING|SINGLE ELEMENT/);
    assert.match(v.undecidable, /held, never corrected/);
  });

  it("agreeing bases are not a conflict", () => {
    const candidate = paidUpObs(355_500_000);
    const counterpart = paidUpObs(355_500_000, { basis: "STANDALONE" });
    assert.equal(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, counterpart]),
      null,
    );
  });

  it("REGRESSION: below 9.5x is NOT a units error and must not be quarantined", () => {
    // A mis-declared unit is a POWER OF TEN, so the smallest one that can exist
    // is 10x. Everything under that floor is the shape that IS legitimately
    // possible here — an ESOP-trust elimination, a part-paid tranche, a rights
    // issue recorded on one basis before the other — and holding a period for
    // it costs a period that will never be written.
    const candidate = paidUpObs(1_000_000_000);
    const counterpart = paidUpObs(200_000_000, { basis: "STANDALONE" });
    assert.equal(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, counterpart]),
      null,
      "5x is not a power of ten and cannot be a rounding declaration",
    );
    assert.equal(BASIS_CONFLICT_MIN_FACTOR, 9.5);
  });

  it("REGRESSION: a lazy ZERO on either side is not evidence of anything", () => {
    // 732 prod filings tag paid-up capital as literal 0. Admitting them takes
    // the QUARTERLY census from 118 to 546 and ANNUAL from 45 to 80 — a lazy
    // zero is an ABSENT tag wearing a number, which is a different defect
    // (MONEY-1234) and must not be blamed on the scale rule.
    const real = paidUpObs(355_500_000);
    const zeroed = paidUpObs(0, { basis: "STANDALONE" });
    // BOTH directions. `ours / 0` is Infinity and `0 / theirs` is 0, and both
    // clear the 9.5x floor — so without the guard a lazy zero reads as an
    // infinite scale error on whichever side of the pair carries it.
    assert.equal(judgeCrossBasisPaidUpCapital(real, [real, zeroed]), null);
    assert.equal(judgeCrossBasisPaidUpCapital(zeroed, [zeroed, real]), null);
  });

  it("REGRESSION: a NEGATIVE paid-up tag is declined, not adjudicated", () => {
    // Share capital cannot be negative, so such a filing has a defect this rule
    // is not equipped to judge. Declining is not passing — and it must not
    // reach the arithmetic, where `Math.log10` of a negative ratio is NaN and
    // every comparison against NaN is false, i.e. a silent decline nothing
    // states.
    const real = paidUpObs(355_500_000);
    const negative = paidUpObs(-355_500_000, { basis: "STANDALONE" });
    assert.equal(judgeCrossBasisPaidUpCapital(real, [real, negative]), null);
    assert.equal(
      judgeCrossBasisPaidUpCapital(negative, [negative, real]),
      null,
    );
  });

  it("REGRESSION: a negative tag must not SHADOW a real conflict beside it", () => {
    // The assertion above is satisfied by the arithmetic alone — a negative
    // ratio yields a negative `spread`, which is below any positive floor — so
    // on its own it cannot tell a guarded implementation from an unguarded one.
    // This is the case that can: `Math.log10` of a negative ratio is NaN, and
    // `2 < NaN` is FALSE, so an unguarded negative counterpart WINS the
    // most-charitable slot on the first iteration and then can never be
    // displaced by the genuinely disagreeing one behind it. The conflict
    // disappears, silently, because of a filing that is not even a candidate.
    const candidate = paidUpObs(355_500_000, { year: 2022 });
    const negative = paidUpObs(-355_500_000, {
      year: 2022,
      basis: "STANDALONE",
    });
    const disagrees = paidUpObs(3_555_000, { year: 2022, basis: "STANDALONE" });
    const v = judgeCrossBasisPaidUpCapital(candidate, [
      candidate,
      negative,
      disagrees,
    ]);
    assert.ok(v, "the 100x counterpart must still be found");
    assert.equal(v.counterpartFilingId, disagrees.filingId);
    assert.equal(v.ratio, 100);
  });

  it("REGRESSION: a non-finite paid-up tag never reaches the payload", () => {
    const real = paidUpObs(355_500_000);
    const poison = paidUpObs(Number.NaN, { basis: "STANDALONE" });
    assert.equal(judgeCrossBasisPaidUpCapital(real, [real, poison]), null);
  });

  it("REGRESSION: the counterpart must be the SAME PERIOD, not merely adjacent", () => {
    // A consolidated FY2022 against a standalone FY2021 is a real disagreement
    // about a real thing — the company issued shares — reported as a units bug.
    const candidate = paidUpObs(3_555_000, { year: 2022 });
    const otherYear = paidUpObs(355_500_000, {
      year: 2021,
      basis: "STANDALONE",
    });
    assert.equal(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, otherYear]),
      null,
    );
  });

  it("REGRESSION: the counterpart must be the OTHER basis", () => {
    // Two consolidated filings for one period are a duplicate or a restatement,
    // not the invariant. The invariant is specifically that consolidation
    // cannot change the parent's own share capital.
    const candidate = paidUpObs(3_555_000, { year: 2022 });
    const sameBasis = paidUpObs(355_500_000, { year: 2022 });
    assert.equal(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, sameBasis]),
      null,
    );
  });

  it("REGRESSION: the counterpart must be the same PERIOD TYPE", () => {
    const candidate = paidUpObs(3_555_000, { year: 2022 });
    const quarterly = paidUpObs(355_500_000, {
      year: 2022,
      basis: "STANDALONE",
      periodType: "QUARTERLY",
    });
    assert.equal(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, quarterly]),
      null,
    );
  });

  it("basis comparison is case-insensitive — callers disagree about casing", () => {
    // `XbrlFiling.basis` is "CONSOLIDATED"; `XbrlFinancials.basis` is
    // "consolidated". Both reach this module through different callers, and a
    // case-sensitive compare would read a lowercase counterpart as the OTHER
    // basis when it is the same one — or as the SAME basis when it differs.
    const candidate = paidUpObs(3_555_000, {
      year: 2022,
      basis: "consolidated",
    });
    const counterpart = paidUpObs(355_500_000, {
      year: 2022,
      basis: "STANDALONE",
    });
    const twin = paidUpObs(355_500_000, { year: 2022, basis: "CONSOLIDATED" });
    assert.ok(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, counterpart]),
    );
    assert.equal(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, twin]),
      null,
      "CONSOLIDATED and consolidated are the same basis",
    );
  });

  it("picks the MOST CHARITABLE counterpart when a period holds several", () => {
    // Report a conflict only when even the friendliest available reading still
    // disagrees. The cost of this check is a period that never gets written.
    const candidate = paidUpObs(355_500_000, { year: 2022 });
    const agrees = paidUpObs(355_500_000, { year: 2022, basis: "STANDALONE" });
    const disagrees = paidUpObs(3_555_000, { year: 2022, basis: "STANDALONE" });
    assert.equal(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, disagrees, agrees]),
      null,
      "one agreeing counterpart is enough to decline",
    );
    // …and with only the disagreeing one present it fires, so the test above
    // is not passing because the whole rule is inert.
    const v = judgeCrossBasisPaidUpCapital(candidate, [candidate, disagrees]);
    assert.ok(v);
    assert.equal(v.counterpartFilingId, disagrees.filingId);
  });

  it("REGRESSION: no periodEnd means no verdict — a sequence is not a period", () => {
    // `resolveOrder`'s array-position fallback can place a filing in a series;
    // it cannot say two filings describe the SAME period. Guessing that from
    // adjacency is the FY2022-vs-FY2021 trap above with the evidence removed.
    const candidate = { ...paidUpObs(3_555_000, { year: 2022 }) };
    delete (candidate as { periodEnd?: Date }).periodEnd;
    const counterpart = paidUpObs(355_500_000, {
      year: 2022,
      basis: "STANDALONE",
    });
    assert.equal(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, counterpart]),
      null,
    );
  });

  it("a caller that supplies no paid-up tag gets the pre-MONEY-1250 behaviour", () => {
    // The field is optional, and this is what that has to mean: silence, not a
    // default. `scripts/data/xbrl-reconcile.ts` builds its observations without
    // it today, and must keep working unchanged.
    const candidate = obs(level(1), { year: 2022 });
    const counterpart = obs(level(1), { year: 2022, basis: "STANDALONE" });
    assert.equal(
      judgeCrossBasisPaidUpCapital(candidate, [candidate, counterpart]),
      null,
    );
  });
});

describe("judgeFilingScale — the invariant is WIRED, and where it ranks", () => {
  it("catches a filing with ZERO siblings — the 578 the neighbour rule cannot reach", () => {
    // The whole point. 123 prod winner periods have no comparable sibling and
    // 455 have one, so the adjacent-window rule answers INSUFFICIENT_CONTEXT
    // for 578 filings forever. The invariant needs no siblings at all.
    const candidate = paidUpObs(3_555_000, { year: 2022, rounding: "Lakhs" });
    const counterpart = paidUpObs(355_500_000, {
      year: 2022,
      basis: "STANDALONE",
      rounding: "Crores",
    });

    const before = judgeFilingScale(obs({}, { year: 2022 }), []);
    assert.equal(
      before.verdict,
      "INSUFFICIENT_CONTEXT",
      "sanity: with no siblings the neighbour rule has nothing to say",
    );

    const v = judgeFilingScale(candidate, [candidate, counterpart]);
    assert.equal(v.verdict, "SCALE_BASIS_CONFLICT");
  });

  it("SCALE_SUSPECT outranks it — a named filing beats a named pair", () => {
    // Both fire. The neighbour rule says WHICH filing, in WHICH direction, by
    // WHICH power of ten, corroborated on both sides; the invariant says only
    // that the pair disagrees. Reporting the weaker one throws away a diagnosis
    // the operator can act on, and both hold the filing either way.
    const candidate: ScaleObservation = {
      ...obs(level(1_000), { year: 2021 }),
      paidUpEquityShareCapital: 3_555_000,
    };
    const counterpart = paidUpObs(355_500_000, {
      year: 2021,
      basis: "STANDALONE",
    });
    const context = [
      candidate,
      counterpart,
      ...neighbours(6, level(1), { year: 2021 }),
    ];

    assert.ok(
      judgeCrossBasisPaidUpCapital(candidate, context),
      "sanity: the invariant does fire on this fixture",
    );
    assert.equal(judgeFilingScale(candidate, context).verdict, "SCALE_SUSPECT");
  });

  it("…but it outranks SCALE_UNCONFIRMED, which one more period would resolve", () => {
    // A one-sided magnitude disagreement cannot tell a mis-scale from a merger
    // and empties itself next period. A cross-basis contradiction is proven now
    // and will never empty itself, so it is the more informative of the two.
    const candidate: ScaleObservation = {
      ...obs(level(1_000), { year: 2021 }),
      paidUpEquityShareCapital: 3_555_000,
    };
    const counterpart = paidUpObs(355_500_000, {
      year: 2021,
      basis: "STANDALONE",
    });
    // Older siblings ONLY, so the neighbour rule has one side and cannot convict.
    const oneSided = [
      obs(level(1), { year: 2020 }),
      obs(level(1), { year: 2019 }),
      obs(level(1), { year: 2018 }),
    ];
    assert.equal(
      judgeFilingScale(candidate, [candidate, ...oneSided]).verdict,
      "SCALE_UNCONFIRMED",
      "sanity: without the counterpart this is the one-sided case",
    );
    assert.equal(
      judgeFilingScale(candidate, [candidate, counterpart, ...oneSided])
        .verdict,
      "SCALE_BASIS_CONFLICT",
    );
  });

  it("…and it outranks a clean OK, which is the silence it exists to break", () => {
    const candidate: ScaleObservation = {
      ...obs(level(1), { year: 2021 }),
      paidUpEquityShareCapital: 3_555_000,
    };
    const counterpart = paidUpObs(355_500_000, {
      year: 2021,
      basis: "STANDALONE",
    });
    const healthy = neighbours(6, level(1), { year: 2021 });
    assert.equal(
      judgeFilingScale(candidate, [candidate, ...healthy]).verdict,
      "OK",
      "sanity: the magnitudes themselves are unremarkable",
    );
    assert.equal(
      judgeFilingScale(candidate, [candidate, counterpart, ...healthy]).verdict,
      "SCALE_BASIS_CONFLICT",
    );
  });

  it("REGRESSION: agreeing bases leave every existing verdict untouched", () => {
    // The invariant must be additive. A healthy company that files both bases
    // is the common case, and it must reach exactly the verdict it reached
    // before this rule existed.
    const candidate: ScaleObservation = {
      ...obs(level(1), { year: 2021 }),
      paidUpEquityShareCapital: 355_500_000,
    };
    const counterpart = paidUpObs(355_500_000, {
      year: 2021,
      basis: "STANDALONE",
    });
    const healthy = neighbours(6, level(1), { year: 2021 });
    assert.equal(
      judgeFilingScale(candidate, [candidate, counterpart, ...healthy]).verdict,
      "OK",
    );
  });
});
