/**
 * UNIT TEST — the StockRatios switchover gate's judgement (MONEY-1235).
 *
 * The defect this pins: the ladder used to live inline in
 * `scripts/data/xbrl-ratios-validate.ts` and could NEVER return pass=true. It
 * blocked whenever the comparison was thin, including when the thinness was
 * entirely on the VENDOR's side — the same code printed "Not evidence about our
 * derivation, in either direction" and then counted it as a failure.
 *
 * Measured on prod 2026-08-21, four of the five checked ratios have essentially
 * no vendor coverage (operatingMargin 0 of 2,135; netMargin/roa/debtToEquity
 * ~86 each; only roe at 2,038), so the arming precondition "the ratios gate
 * reads READY" was unsatisfiable by construction.
 *
 * Every case below is a situation the old two-verdict ladder got wrong, or a
 * trap the new three-verdict one must not fall into.
 *
 * MONEY-1237 adds the SELF-COMPARISON cases at the foot of the file. The gate
 * selected `stock_ratios.source` and never read it, so an incumbent our own
 * projection had written was indistinguishable from a vendor row. Since
 * `XBRL_PROJECTION_APPLY` arms the projection AND the ratios job, the natural
 * "confirm it worked" re-run after arming compared `roe` — the one ratio with
 * real vendor coverage — against ITSELF, scored 100%, read READY, and passed the
 * run on one READY plus four UNVERIFIABLE.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  judgeRatioReadiness,
  judgeRatiosGate,
  judgeRatioFill,
  checkBalanceIdentity,
  BALANCE_IDENTITY_MAX_FAIL_RATE,
  BALANCE_IDENTITY_MIN_CHECKED,
  FILL_MIN_POPULATION,
  RATIO_MIN_COMPARABLE,
  RATIO_VENDOR_FLOOR,
  type RatioGateInput,
  type RatioGateJudgement,
  type RatiosRunContext,
} from "@usemoney/core/market-data";

/** A healthy ratio: real vendor coverage, real overlap, agreeing, UNCONTAMINATED. */
function healthy(over: Partial<RatioGateInput> = {}): RatioGateInput {
  return {
    ratio: "roe",
    comparable: 2000,
    matched: 1980,
    scaleMismatches: 0,
    signMismatches: 0,
    weHave: 2100,
    theyHave: 2038,
    // MONEY-1401 F8 — the FILL CENSUS, and it is a SEPARATE population from
    // `weHave`/`theyHave`. Those two are the gate's GRADED set, joined on the
    // FILING's exchange; this is the set the WRITER can actually reach, joined
    // on the INSTRUMENT's. On prod 2026-09-13 they differ by 92.3%. Defaulted
    // healthy (ours >= theirs) so a case that is not about fill stays about
    // what it says it is about.
    fill: { xbrl: 2100, vendor: 2038 },
    // MONEY-1237. Spelled out rather than defaulted so every case below states
    // whether its incumbents are the vendor's or ours — that is the whole
    // question the gate exists to answer.
    selfComparisons: 0,
    selfMatched: 0,
    ...over,
  };
}

describe("judgeRatioReadiness — vendor absence is not our failure", () => {
  it("ZERO vendor rows is UNVERIFIABLE, never BLOCKED", () => {
    // operatingMargin on prod: 0 of 2,135. The old ladder called this "not
    // ready", which gates OUR derivation on a vendor we are RETIRING precisely
    // because its data is unavailable.
    const j = judgeRatioReadiness(
      healthy({
        ratio: "operatingMargin",
        theyHave: 0,
        comparable: 0,
        matched: 0,
      }),
    );
    assert.equal(j.verdict, "UNVERIFIABLE");
    assert.match(j.reason, /no vendor data at all/);
    assert.match(j.reason, /does NOT block/);
  });

  it("vendor coverage below the floor is UNVERIFIABLE", () => {
    const j = judgeRatioReadiness(
      healthy({
        theyHave: RATIO_VENDOR_FLOOR - 1,
        comparable: 10,
        matched: 10,
      }),
    );
    assert.equal(j.verdict, "UNVERIFIABLE");
    assert.match(j.reason, /too thin/);
  });

  it("vendor coverage AT the floor is judged, not excused", () => {
    // The boundary must not silently widen the excuse.
    const j = judgeRatioReadiness(
      healthy({ theyHave: RATIO_VENDOR_FLOOR, comparable: 10, matched: 10 }),
    );
    assert.notEqual(j.verdict, "UNVERIFIABLE");
  });

  it("vendor absence outranks a 'systematic' error computed against nothing", () => {
    // ORDERING IS LOAD-BEARING. A scale mismatch measured against 3 vendor rows
    // is noise wearing the costume of a systematic error. If the systematic
    // rule ran first, a ratio with no real vendor side would BLOCK the whole
    // switchover on 3 rows of coincidence.
    const j = judgeRatioReadiness(
      healthy({ theyHave: 3, comparable: 3, matched: 0, scaleMismatches: 3 }),
    );
    assert.equal(j.verdict, "UNVERIFIABLE");
  });
});

describe("judgeRatioReadiness — the two THIN cases are opposite problems", () => {
  it("thin because WE cannot derive it BLOCKS", () => {
    // The vendor has 2,038 rows and we produced a handful: that is evidence
    // about US, and it must block. Collapsing this with vendor-absence is what
    // made the old ladder useless.
    const j = judgeRatioReadiness(
      healthy({
        comparable: RATIO_MIN_COMPARABLE - 1,
        matched: 49,
        weHave: 49,
      }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /WE cannot derive what they could/);
  });

  it("a real systematic error BLOCKS even at a high match rate", () => {
    const j = judgeRatioReadiness(healthy({ scaleMismatches: 1 }));
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /do not widen the tolerance/);
  });

  it("a sign mismatch BLOCKS", () => {
    assert.equal(
      judgeRatioReadiness(healthy({ signMismatches: 1 })).verdict,
      "BLOCKED",
    );
  });

  it("below the pass rate BLOCKS and states the rate", () => {
    const j = judgeRatioReadiness(healthy({ comparable: 1000, matched: 900 }));
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /90\.0%/);
  });

  it("a healthy ratio is READY", () => {
    const j = judgeRatioReadiness(healthy());
    assert.equal(j.verdict, "READY");
    assert.equal(Math.round(j.matchRate * 1000) / 1000, 0.99);
  });

  it("matchRate is 0, not NaN, when nothing is comparable", () => {
    // 0/0. A NaN here would propagate into a printed ladder and compare false
    // against every threshold, which reads as "fine".
    const j = judgeRatioReadiness(healthy({ comparable: 0, matched: 0 }));
    assert.equal(j.matchRate, 0);
    assert.ok(Number.isFinite(j.matchRate));
  });
});

describe("judgeRatiosGate — a run that proved nothing must not read as success", () => {
  const R = (
    ratio: string,
    verdict: "READY" | "BLOCKED" | "UNVERIFIABLE",
    selfComparisons = 0,
  ) => ({
    ratio,
    verdict,
    matchRate: 1,
    reason: "",
    selfComparisons,
    independentComparable: 100 - selfComparisons,
  });

  it("passes when nothing blocked and something was verified", () => {
    const out = judgeRatiosGate([
      R("roe", "READY"),
      R("operatingMargin", "UNVERIFIABLE"),
      R("netMargin", "UNVERIFIABLE"),
    ]);
    assert.equal(out.pass, true);
    assert.deepEqual(out.ready, ["roe"]);
    // The absence is NAMED, not rounded into "ready".
    assert.match(out.summary, /operatingMargin, netMargin/);
    assert.match(out.summary, /UNVERIFIABLE/);
  });

  it("FAILS when every ratio is UNVERIFIABLE — nothing was compared", () => {
    // The MONEY-1220 failure mode in gate form: a green verdict describing a
    // comparison that never happened.
    const out = judgeRatiosGate([
      R("roe", "UNVERIFIABLE"),
      R("netMargin", "UNVERIFIABLE"),
    ]);
    assert.equal(out.pass, false);
    assert.match(out.summary, /nothing was actually verified/);
  });

  it("FAILS on an empty input for the same reason", () => {
    const out = judgeRatiosGate([]);
    assert.equal(out.pass, false);
    assert.match(out.summary, /nothing was actually verified/);
  });

  it("one BLOCKED fails the run even beside a READY", () => {
    const out = judgeRatiosGate([R("roe", "READY"), R("roa", "BLOCKED")]);
    assert.equal(out.pass, false);
    assert.deepEqual(out.blocked, ["roa"]);
    assert.match(out.summary, /Do NOT point any reader/);
  });

  it("BLOCKED outranks the all-unverifiable check", () => {
    const out = judgeRatiosGate([
      R("roa", "BLOCKED"),
      R("roe", "UNVERIFIABLE"),
    ]);
    assert.equal(out.pass, false);
    assert.match(out.summary, /BLOCKED: roa/);
  });

  it("REGRESSION: the prod shape — only roe judgeable — can now pass", () => {
    // The exact measured situation. Under the old ladder this returned
    // pass=false forever, so the switchover could never be evidenced.
    const judgements = [
      judgeRatioReadiness(healthy({ ratio: "roe" })),
      judgeRatioReadiness(
        healthy({
          ratio: "operatingMargin",
          theyHave: 0,
          comparable: 0,
          matched: 0,
        }),
      ),
      judgeRatioReadiness(
        healthy({
          ratio: "netMargin",
          theyHave: 86,
          comparable: 80,
          matched: 79,
        }),
      ),
      judgeRatioReadiness(
        healthy({ ratio: "roa", theyHave: 85, comparable: 80, matched: 78 }),
      ),
      judgeRatioReadiness(
        healthy({
          ratio: "debtToEquity",
          theyHave: 86,
          comparable: 80,
          matched: 77,
        }),
      ),
    ];
    const out = judgeRatiosGate(judgements);
    assert.ok(out.ready.includes("roe"));
    assert.ok(out.unverifiable.includes("operatingMargin"));
    // netMargin/roa/debtToEquity clear the vendor floor (86/85/86 >= 25), so
    // they ARE judged on their merits rather than excused.
    assert.equal(out.blocked.includes("operatingMargin"), false);
  });
});

describe("judgeRatioReadiness — a self-comparison is not evidence (MONEY-1237)", () => {
  it("a fully self-compared ratio is NOT READY", () => {
    // THE HEADLINE DEFECT. `XBRL_PROJECTION_APPLY` arms the projection AND the
    // ratios job, so re-running the gate after arming — the natural "confirm it
    // worked" move — hands it incumbents already stamped NSE_XBRL. `roe` is the
    // only ratio with real vendor coverage on prod (2,038 of 2,135 rows,
    // 2026-08-21), so once contaminated it matches ITSELF 100% and used to read
    // READY on the strength of pairs that cannot fail.
    const j = judgeRatioReadiness(
      healthy({
        comparable: 2000,
        matched: 2000,
        selfComparisons: 2000,
        selfMatched: 2000,
      }),
    );
    assert.notEqual(j.verdict, "READY");
    assert.equal(j.verdict, "UNVERIFIABLE");
    assert.equal(j.independentComparable, 0);
    assert.equal(j.selfComparisons, 2000);
    // The rate must be 0, not the 100% the raw counts would produce.
    assert.equal(j.matchRate, 0);
    assert.ok(Number.isFinite(j.matchRate));
    assert.match(j.reason, /XBRL against ITSELF/);
    assert.match(j.reason, /never been armed/);
  });

  it("self-comparisons are removed from BOTH sides, so they cannot carry a rate over the line", () => {
    // 1,900 of 2,000 raw is exactly 95.0% — the pass rate — and would read
    // READY. Half of those "matches" are XBRL agreeing with itself. On the
    // 1,000 INDEPENDENT pairs the true rate is 90.0%, which blocks.
    //
    // Subtracting from the numerator only would give 900/2000 = 45%: also a
    // block, but by the draining-denominator route (MONEY-1196) rather than by
    // measuring anything. The number below has to be 90.0%.
    const j = judgeRatioReadiness(
      healthy({
        comparable: 2000,
        matched: 1900,
        selfComparisons: 1000,
        selfMatched: 1000,
      }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.equal(j.independentComparable, 1000);
    assert.equal(Math.round(j.matchRate * 1000) / 1000, 0.9);
    assert.match(j.reason, /90\.0%/);
    assert.match(j.reason, /1000 independent pair/);

    // Control: the same ratio with NO contamination clears the gate. This is
    // what proves the block above came from the exclusion and not from the
    // numbers happening to be low.
    assert.equal(
      judgeRatioReadiness(healthy({ comparable: 2000, matched: 1900 })).verdict,
      "READY",
    );
  });

  it("a few self-comparisons do NOT drain a big population — the ratio is still judged", () => {
    // The exclusion must not become its own denial-of-service. 3 contaminated
    // pairs out of 2,000 leave 1,997 to judge on. READY here is a statement
    // about those 1,997 only, and it says so.
    const j = judgeRatioReadiness(
      healthy({
        comparable: 2000,
        matched: 1980,
        selfComparisons: 3,
        selfMatched: 3,
      }),
    );
    assert.equal(j.verdict, "READY");
    assert.equal(j.independentComparable, 1997);
    assert.equal(j.selfComparisons, 3);
    assert.match(j.reason, /1977\/1997 within tolerance/);
    assert.match(j.reason, /the RUN still\s+fails while any exist/);
  });

  it("a drained population is NOT blamed on our derivation", () => {
    // The mis-attribution rung 0 exists to prevent. The vendor is rich (2,038
    // rows) and 30 independent pairs survive, so the OLD ladder would have said
    // "WE cannot derive what they could" — pointing the reader at our
    // derivation when the actual cause is that this environment was armed and
    // its vendor rows were overwritten. Same shape RATIO_VENDOR_FLOOR exists to
    // prevent, one rung further down.
    const j = judgeRatioReadiness(
      healthy({
        comparable: 60,
        matched: 55,
        selfComparisons: 30,
        selfMatched: 28,
      }),
    );
    assert.equal(j.verdict, "UNVERIFIABLE");
    assert.doesNotMatch(j.reason, /WE cannot derive/);
    assert.match(j.reason, /30 of 60 comparable pair/);
    assert.match(j.reason, /already been armed|never been armed/);
  });

  it("scale and sign mismatches are NOT discounted, even on self-comparisons", () => {
    // The one thing the exclusion must never touch. Our own writer disagreeing
    // with our own projection by a power of ten is a real defect, and
    // discounting a BLOCKER is the only direction that can manufacture a READY.
    const j = judgeRatioReadiness(
      healthy({ selfComparisons: 5, selfMatched: 5, scaleMismatches: 1 }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /systematic error/);
  });

  it("a CLEAN population is byte-for-byte unchanged", () => {
    // Regression fence: zero contamination must take exactly the pre-MONEY-1237
    // path, or this fix has quietly re-tuned the gate for every environment
    // that was never contaminated — which is all of them today.
    const j = judgeRatioReadiness(healthy());
    assert.equal(j.verdict, "READY");
    assert.equal(j.matchRate, 1980 / 2000);
    assert.equal(j.independentComparable, 2000);
    assert.equal(j.selfComparisons, 0);
    assert.equal(j.reason, "1980/2000 within tolerance");
  });

  it("clamps an impossible count instead of producing a negative rate", () => {
    // A negative denominator makes `matchRate` compare false against every
    // threshold, which reads as "fine" — the same trap the 0/0-is-NaN case is
    // pinned against. More self-comparisons than comparable pairs is a caller
    // bug; it must fail toward "cannot judge", never toward READY.
    const j = judgeRatioReadiness(
      healthy({
        comparable: 10,
        matched: 10,
        selfComparisons: 999,
        selfMatched: 999,
      }),
    );
    assert.ok(j.independentComparable >= 0);
    assert.ok(Number.isFinite(j.matchRate));
    assert.notEqual(j.verdict, "READY");
    // The REPORTED count is clamped to the population too, not just the
    // arithmetic. `judgeRatiosGate` sums these into the figure an operator
    // reads, so an unclamped 999-of-10 would put a fiction in the summary.
    assert.equal(j.selfComparisons, 10);
  });

  it("a count the caller could not supply is CONTAMINATED, not clean", () => {
    // NaN would otherwise be normalised to 0 — and 0 is the PERMISSIVE value
    // here, meaning "no XBRL incumbents", which is a licence to read READY.
    // "Couldn't determine" has to stay a distinct value all the way to the
    // run-level roll-up.
    const j = judgeRatioReadiness(
      healthy({ selfComparisons: Number.NaN, selfMatched: 0 }),
    );
    assert.equal(j.verdict, "UNVERIFIABLE");
    assert.equal(Number.isNaN(j.selfComparisons), true);
    assert.match(j.reason, /did not report/);
    // …and it must survive the roll-up as a failure, not be summed into 0.
    assert.equal(judgeRatiosGate([j]).pass, false);
  });
});

describe("judgeRatiosGate — a contaminated run can never be arming evidence", () => {
  const R = (
    ratio: string,
    verdict: "READY" | "BLOCKED" | "UNVERIFIABLE",
    selfComparisons = 0,
  ) => ({
    ratio,
    verdict,
    matchRate: 1,
    reason: "",
    selfComparisons,
    independentComparable: 100 - selfComparisons,
  });

  it("FAILS the run when any judged pair was a self-comparison, even beside a READY", () => {
    const out = judgeRatiosGate([
      R("roe", "READY", 7),
      R("operatingMargin", "UNVERIFIABLE"),
    ]);
    assert.equal(out.pass, false);
    assert.equal(out.selfComparisons, 7);
    assert.match(out.summary, /INCUMBENTS ARE PARTLY OURS/);
    assert.match(out.summary, /7 comparison pair/);
    assert.match(out.summary, /never been armed/);
  });

  it("names the blocked ratios too — contamination is the headline, not a replacement", () => {
    const out = judgeRatiosGate([R("roe", "BLOCKED", 4), R("roa", "BLOCKED")]);
    assert.equal(out.pass, false);
    assert.match(out.summary, /INCUMBENTS ARE PARTLY OURS/);
    assert.match(out.summary, /Also BLOCKED: roe, roa/);
  });

  it("treats a judgement that cannot ANSWER the question as contaminated, not clean", () => {
    // "Couldn't determine" must never collapse into the permissive value on a
    // one-way door. The type makes the field mandatory; this pins the runtime
    // behaviour if something ever gets past it.
    const broken = {
      ratio: "roe",
      verdict: "READY" as const,
      matchRate: 1,
      reason: "",
      independentComparable: 100,
    } as unknown as RatioGateJudgement;
    const out = judgeRatiosGate([broken]);
    assert.equal(out.pass, false);
    assert.match(out.summary, /did not report a self-comparison count/);
  });

  it("a clean run still passes and says so", () => {
    const out = judgeRatiosGate([
      R("roe", "READY"),
      R("operatingMargin", "UNVERIFIABLE"),
    ]);
    assert.equal(out.pass, true);
    assert.equal(out.selfComparisons, 0);
    assert.match(out.summary, /0 XBRL-vs-XBRL self-comparisons/);
  });

  it("REGRESSION: the post-arming prod shape can no longer certify itself", () => {
    // The precise scenario the fix exists for. Four ratios have no vendor
    // coverage to speak of, so they are UNVERIFIABLE either way; `roe` is the
    // only judgeable one, and after arming its 2,038 incumbents are OUR OWN
    // projection. Before MONEY-1237 that produced one READY plus four
    // UNVERIFIABLE, which `judgeRatiosGate` passed — the switchover "evidenced"
    // by XBRL against XBRL.
    const contaminated = [
      judgeRatioReadiness(
        healthy({
          ratio: "roe",
          comparable: 2038,
          matched: 2038,
          selfComparisons: 2038,
          selfMatched: 2038,
        }),
      ),
      judgeRatioReadiness(
        healthy({
          ratio: "operatingMargin",
          theyHave: 0,
          comparable: 0,
          matched: 0,
        }),
      ),
      judgeRatioReadiness(
        healthy({
          ratio: "netMargin",
          theyHave: 86,
          comparable: 80,
          matched: 79,
        }),
      ),
      judgeRatioReadiness(
        healthy({ ratio: "roa", theyHave: 85, comparable: 80, matched: 78 }),
      ),
      judgeRatioReadiness(
        healthy({
          ratio: "debtToEquity",
          theyHave: 86,
          comparable: 80,
          matched: 77,
        }),
      ),
    ];
    const out = judgeRatiosGate(contaminated);
    assert.equal(out.pass, false);
    assert.equal(out.ready.includes("roe"), false);
    assert.equal(out.selfComparisons, 2038);

    // And the SAME population, uncontaminated, still passes — otherwise this
    // test would also pass if the gate had simply been broken shut.
    const clean = contaminated.map((_, i) =>
      i === 0
        ? judgeRatioReadiness(
            healthy({ ratio: "roe", comparable: 2038, matched: 2038 }),
          )
        : contaminated[i]!,
    );
    const cleanOut = judgeRatiosGate(clean);
    assert.equal(cleanOut.pass, true);
    assert.ok(cleanOut.ready.includes("roe"));
  });
});

/**
 * MONEY-1250 — a DECLARED definitional divergence is not a pass, not a block,
 * and not "the vendor is thin".
 *
 * The situation: our `totalDebt` is `borrowingsCurrent + borrowingsNonCurrent`,
 * while the incumbent's also carries Ind-AS 116 LEASE LIABILITIES. Measured on
 * prod 2026-08-23/24 — 1,307 of 1,398 disagreeing `totalDebt` pairs (93.5%) run
 * theirs > ours; 267 of those have our borrowings at EXACTLY zero (TCS at
 * Rs 9,392 Cr, BATAINDIA 1,446, MPHASIS 1,116); screener.in reproduces the
 * incumbent to <0.5% on 12 of 20 comparable pairs against 1 of 20 for ours; and
 * BATAINDIA's borrowings step 0 -> 1,249 Cr at Mar-2020, the Ind-AS 116
 * adoption year, with no borrowing event.
 *
 * The gap CANNOT be closed: the integrated-filing taxonomy has no
 * lease-liability balance element, only the cash-flow `PaymentsOfLease…`. So
 * grading the ratio measures a disagreement about vocabulary and reports it as
 * an accuracy score.
 */
describe("judgeRatioReadiness — a declared divergence is not graded (MONEY-1250)", () => {
  const LEASES = "the incumbent's debt includes Ind-AS 116 lease liabilities";

  it("fires ABOVE the vendor floor, or it would be inert for the ratio it was written for", () => {
    // THE WIRING CASE. `debtToEquity` has 21 vendor rows against a floor of 50,
    // so it returns at the vendor-coverage rung. A declaration placed after
    // that rung would ship, change no output, and read as done.
    const j = judgeRatioReadiness(
      healthy({
        ratio: "debtToEquity",
        theyHave: 21,
        comparable: 21,
        matched: 15,
        declaredDivergence: LEASES,
      }),
    );
    assert.equal(j.verdict, "DECLARED_DIVERGENCE");
    assert.notEqual(j.verdict, "UNVERIFIABLE");
    // The EVIDENCE travels with the verdict. A declaration whose argument lives
    // only in a commit message is indistinguishable from a suppression later.
    assert.match(j.reason, /Ind-AS 116 lease liabilities/);
    assert.match(j.reason, /NOT GRADED/);
  });

  it("is NOT the same verdict as UNVERIFIABLE — they ask for opposite next steps", () => {
    const declared = judgeRatioReadiness(
      healthy({ theyHave: 21, comparable: 21, declaredDivergence: LEASES }),
    );
    const thin = judgeRatioReadiness(healthy({ theyHave: 21, comparable: 21 }));
    assert.equal(thin.verdict, "UNVERIFIABLE");
    assert.equal(declared.verdict, "DECLARED_DIVERGENCE");
    // "Get more vendor rows" vs "no number of vendor rows would help".
    assert.match(thin.reason, /vendor coverage too thin/);
    assert.doesNotMatch(declared.reason, /vendor coverage too thin/);
  });

  it("does NOT suppress a scale error the vendor side is big enough to evidence", () => {
    // The one direction a declaration must never work in. A definitional gap in
    // what a column MEANS does not produce a power-of-ten error, so a
    // declaration that swallowed a SCALE flag would hide a units bug behind a
    // paragraph of prose.
    const j = judgeRatioReadiness(
      healthy({
        theyHave: 2038,
        comparable: 2000,
        scaleMismatches: 1,
        declaredDivergence: LEASES,
      }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /systematic error/);
  });

  it("does NOT suppress a sign error either, on the same rule", () => {
    const j = judgeRatioReadiness(
      healthy({
        theyHave: 2038,
        comparable: 2000,
        signMismatches: 3,
        declaredDivergence: LEASES,
      }),
    );
    assert.equal(j.verdict, "BLOCKED");
  });

  it("still wins BELOW the floor, where a systematic count is not evidence", () => {
    // Deliberate boundary, and the same reasoning that already orders the
    // vendor floor ahead of the systematic rung: "a scale mismatch computed
    // against three vendor rows is noise wearing the costume of a systematic
    // error". Under the floor there is nothing for the flag to be evidence of.
    const j = judgeRatioReadiness(
      healthy({
        theyHave: 21,
        comparable: 21,
        scaleMismatches: 1,
        declaredDivergence: LEASES,
      }),
    );
    assert.equal(j.verdict, "DECLARED_DIVERGENCE");
  });

  it("an ABSENT declaration grades normally — absence is the STRICT reading", () => {
    // Opposite polarity to `selfComparisons`, where a missing answer has to
    // mean "contaminated". Here the permissive value would be a declaration,
    // so absence must mean "judge it", the strictest outcome available.
    const j = judgeRatioReadiness(healthy());
    assert.equal(j.verdict, "READY");
  });

  it("an EMPTY declaration is not a declaration", () => {
    // A blank string is how a declaration gets accidentally emptied by a
    // refactor. It must not silently switch the ratio off.
    for (const blank of ["", "   "]) {
      const j = judgeRatioReadiness(
        healthy({ theyHave: 21, comparable: 21, declaredDivergence: blank }),
      );
      assert.equal(j.verdict, "UNVERIFIABLE");
    }
  });

  it("contamination still outranks a declaration", () => {
    // A declared ratio in an already-armed environment must not launder the
    // self-comparison finding: that is a fact about the ENVIRONMENT, and the
    // run has to keep failing over it.
    const j = judgeRatioReadiness(
      healthy({
        comparable: 40,
        matched: 40,
        selfComparisons: 40,
        selfMatched: 40,
        declaredDivergence: LEASES,
      }),
    );
    assert.equal(j.verdict, "UNVERIFIABLE");
    assert.match(j.reason, /XBRL against ITSELF/);
  });
});

describe("judgeRatiosGate — a declaration is never verification (MONEY-1250)", () => {
  const J = (
    ratio: string,
    verdict: "READY" | "BLOCKED" | "UNVERIFIABLE" | "DECLARED_DIVERGENCE",
  ): RatioGateJudgement => ({
    ratio,
    verdict,
    matchRate: 1,
    reason: "",
    selfComparisons: 0,
    independentComparable: 100,
  });

  it("FAILS a run whose only non-unverifiable ratio was declared", () => {
    // The trap this closes: if a declaration counted as a pass, declaring every
    // ratio would arm the switchover on zero evidence.
    const out = judgeRatiosGate([
      J("debtToEquity", "DECLARED_DIVERGENCE"),
      J("roe", "UNVERIFIABLE"),
    ]);
    assert.equal(out.pass, false);
    assert.match(out.summary, /nothing was actually verified/);
    assert.deepEqual(out.ready, []);
  });

  it("FAILS a run where EVERY ratio is declared", () => {
    const out = judgeRatiosGate([
      J("debtToEquity", "DECLARED_DIVERGENCE"),
      J("roe", "DECLARED_DIVERGENCE"),
    ]);
    assert.equal(out.pass, false);
    assert.match(out.summary, /nothing was actually verified/);
  });

  it("names declared ratios SEPARATELY from unverifiable ones", () => {
    const out = judgeRatiosGate([
      J("roe", "READY"),
      J("roa", "UNVERIFIABLE"),
      J("debtToEquity", "DECLARED_DIVERGENCE"),
    ]);
    assert.equal(out.pass, true);
    assert.deepEqual(out.declared, ["debtToEquity"]);
    // Not folded into the UNVERIFIABLE list — the two mean different things.
    assert.deepEqual(out.unverifiable, ["roa"]);
    assert.match(out.summary, /NOT GRADED by declared definitional divergence/);
    assert.match(out.summary, /DELIBERATE non-claim, not an agreement/);
    // And it is NOT counted as ready anywhere.
    assert.equal(out.ready.includes("debtToEquity"), false);
  });

  it("a declaration never rescues a BLOCKED run", () => {
    const out = judgeRatiosGate([
      J("roe", "BLOCKED"),
      J("debtToEquity", "DECLARED_DIVERGENCE"),
    ]);
    assert.equal(out.pass, false);
    assert.match(out.summary, /BLOCKED: roe/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MONEY-1401 — the two rungs that need no vendor.
//
// The gate read PASS on prod for months on ONE graded ratio, and it could not
// see either of the failures below:
//
//   - `roce` was in `RATIOS` and NOT in the incumbent `select`, so 1,704
//     derived values were compared against `undefined` and printed as "no
//     vendor data at all" over a column the vendor fills on 2,118 of 2,135
//     rows. That half is pinned by the source scan in
//     `xbrl-ratios-self-comparison-wiring.test.ts`.
//   - NO rung measured FILL. `roe` read READY at a 95.9% match rate while our
//     derivation covered 797 symbols against the incumbent's 807 — arming
//     would have replaced a populated column with an emptier one, on a table
//     that keeps no `source` history.
// ─────────────────────────────────────────────────────────────────────────

describe("judgeRatioFill — a regression the agreement rungs cannot see", () => {
  it("OK when we cover at least as many symbols as the incumbent", () => {
    assert.equal(judgeRatioFill("roe", 807, 807).verdict, "OK");
    assert.equal(judgeRatioFill("roe", 900, 807).verdict, "OK");
  });

  it("BLOCKS a regression on roe / roce / netMargin", () => {
    // The measured prod numbers. MUTATION: drop "roe" from
    // FILL_BLOCKING_RATIOS and this reads WARN — which is exactly the state
    // that let the gate certify a coverage regression.
    assert.equal(judgeRatioFill("roe", 797, 807).verdict, "BLOCK");
    assert.equal(judgeRatioFill("roce", 1704, 1735).verdict, "BLOCK");
    assert.equal(judgeRatioFill("netMargin", 100, 101).verdict, "BLOCK");
  });

  it("WARNS on a ratio nobody reads, rather than gating on it", () => {
    // A regression on a column the vendor never filled costs a reader nothing.
    // The check still runs and still prints — it just does not gate.
    assert.equal(judgeRatioFill("roa", 10, 14).verdict, "WARN");
    assert.equal(judgeRatioFill("debtToEquity", 10, 21).verdict, "WARN");
  });

  it("a non-finite count is clamped to 0, never treated as coverage", () => {
    // A NaN on OUR side must not read as "we cover everything". The
    // permissive reading of a broken counter is the one that arms.
    assert.equal(judgeRatioFill("roe", Number.NaN, 807).verdict, "BLOCK");
    assert.equal(judgeRatioFill("roe", -5, 0).xbrl, 0);
  });
});

describe("judgeRatioReadiness — the fill rung can only ever be STRICTER", () => {
  it("turns a READY into BLOCKED when arming would empty the column", () => {
    // The exact prod shape: roe, 95.9% agreement, 797 ours against 807 theirs.
    // MUTATION: stop calling `judgeRatioFill` in `judgeRatioReadiness` and
    // this reads READY — the state that shipped.
    const j = judgeRatioReadiness(
      // On the WRITER's population — MONEY-1401 F8. `weHave`/`theyHave` stay at
      // the builder's defaults on purpose: the two pairs must be able to
      // disagree, or the census is the graded counts under a new name and the
      // whole finding is undone.
      healthy({ ratio: "roe", fill: { xbrl: 797, vendor: 807 } }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /FILL BLOCK/);
    // BOTH facts survive. "READY on agreement, BLOCKED on coverage" sends the
    // reader to a different place than either one alone.
    assert.match(j.reason, /agreement alone said READY/);
    assert.deepEqual(j.fill, { xbrl: 797, vendor: 807, verdict: "BLOCK" });
  });

  it("does NOT overwrite the ladder's reason when it already blocked", () => {
    // roce on prod: 49 sign mismatches AND a fill regression. An operator told
    // only about the coverage would fix coverage and re-run into the signs.
    const j = judgeRatioReadiness(
      healthy({
        ratio: "roce",
        signMismatches: 49,
        fill: { xbrl: 1704, vendor: 1735 },
      }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /systematic error/);
    assert.match(j.reason, /FILL BLOCK/);
  });

  it("a WARN annotates without changing the verdict", () => {
    const j = judgeRatioReadiness(
      healthy({
        ratio: "roa",
        theyHave: 85,
        comparable: 80,
        matched: 78,
        fill: { xbrl: 10, vendor: 14 },
      }),
    );
    // Still the ladder's own answer — 85 vendor rows clears the floor of 50.
    assert.equal(j.verdict, "READY");
    assert.match(j.reason, /FILL WARN/);
    assert.equal(j.fill?.verdict, "WARN");
  });

  it("NEVER rescues a BLOCK — the one direction that could manufacture a READY", () => {
    // Healthy fill beside a scale error. MUTATION: make the wrapper return the
    // fill verdict instead of merging, and this reads READY on a units bug.
    const j = judgeRatioReadiness(healthy({ scaleMismatches: 1 }));
    assert.equal(j.verdict, "BLOCKED");
    assert.equal(j.fill?.verdict, "OK");
  });

  it("carries the two counts on EVERY judgement, whatever the ladder said", () => {
    // The numbers have to be printable for an UNVERIFIABLE ratio too, or the
    // report can only show fill for ratios that happened to be graded.
    const j = judgeRatioReadiness(
      healthy({
        ratio: "operatingMargin",
        theyHave: 0,
        fill: { xbrl: 1726, vendor: 0 },
      }),
    );
    assert.equal(j.verdict, "UNVERIFIABLE");
    assert.deepEqual(j.fill, { xbrl: 1726, vendor: 0, verdict: "OK" });
  });
});

describe("checkBalanceIdentity — the rung that survives the vendor being dead", () => {
  it("PASSES a balance sheet that balances", () => {
    assert.equal(checkBalanceIdentity(1000, 600, 400), "PASS");
  });

  it("FAILS one that does not — and the failure IS reachable", () => {
    // MUTATION: return "PASS" unconditionally and this goes red. Measured on
    // prod, 0 of 10,185 checkable filings exceed the tolerance, so this case
    // is the only proof the arithmetic can produce a FAIL at all.
    assert.equal(checkBalanceIdentity(1000, 600, 300), "FAIL");
    assert.equal(checkBalanceIdentity(1000, 600, 500), "FAIL");
  });

  it("holds the tolerance at 0.1%, both sides of the line", () => {
    // 0.05% residual passes, 0.5% does not. MUTATION: widen the constant to
    // 0.01 and the second assertion goes red.
    assert.equal(checkBalanceIdentity(1000, 600.5, 400), "PASS");
    assert.equal(checkBalanceIdentity(1000, 605, 400), "FAIL");
  });

  it("a MISSING leg is UNCHECKABLE, never a pass", () => {
    // The permissive reading of "we could not tell" is exactly how a parser
    // that stopped emitting `totalLiabilities` would score 100%.
    assert.equal(checkBalanceIdentity(1000, null, 400), "UNCHECKABLE");
    assert.equal(checkBalanceIdentity(undefined, 600, 400), "UNCHECKABLE");
    assert.equal(checkBalanceIdentity(1000, 600, undefined), "UNCHECKABLE");
    assert.equal(checkBalanceIdentity(1000, Number.NaN, 400), "UNCHECKABLE");
  });

  it("zero assets is UNCHECKABLE, not a divide by zero", () => {
    assert.equal(checkBalanceIdentity(0, 0, 0), "UNCHECKABLE");
  });
});

describe("judgeRatiosGate — the run-level rungs", () => {
  const R = (
    ratio: string,
    verdict: "READY" | "BLOCKED" | "UNVERIFIABLE",
  ): RatioGateJudgement => ({
    ratio,
    verdict,
    matchRate: 1,
    reason: "",
    selfComparisons: 0,
    independentComparable: 100,
    // MONEY-1401 F8b review — a caller that supplies a `RatiosRunContext` is
    // claiming to have measured the run, and `judgeRatiosGate` now FAILS such a
    // run whose READY ratios carry no writable-cohort agreement. Stated here so
    // the cases below stay about identity and the census; the rung itself has
    // its own describe block.
    writable: { comparable: 200, matched: 200, matchRate: 1, verdict: "OK" },
  });
  const ctx = (over: Partial<RatiosRunContext> = {}): RatiosRunContext => ({
    identity: { passed: 1723, failed: 0, uncheckable: 13 },
    cannotGrade: { count: 426, top: [{ symbol: "VAML", marketCap: 1.6e12 }] },
    // MONEY-1401 F8 — above the floor by default, so a case that is not about
    // the census stays about what it says it is about.
    fillPopulation: 2000,
    // Above both populations drawn from it, for the same reason.
    writerReachable: 2000,
    ...over,
  });

  it("an otherwise-passing run FAILS when too many filings do not balance", () => {
    // 3% > the 2% ceiling. MUTATION: drop `!identityBlocked` from `done()`'s
    // `pass` and this reads pass=true on a projection that does not balance.
    const out = judgeRatiosGate(
      [R("roe", "READY"), R("roa", "UNVERIFIABLE")],
      ctx({ identity: { passed: 97, failed: 3, uncheckable: 0 } }),
    );
    assert.equal(out.pass, false);
    assert.match(out.summary, /BALANCE SHEET DOES NOT BALANCE/);
    assert.ok(out.identityFailRate !== undefined);
    assert.ok(out.identityFailRate > BALANCE_IDENTITY_MAX_FAIL_RATE);
  });

  it("passes at the ceiling and fails above it", () => {
    const at = judgeRatiosGate(
      [R("roe", "READY")],
      ctx({ identity: { passed: 98, failed: 2, uncheckable: 0 } }),
    );
    assert.equal(at.pass, true);
    const over = judgeRatiosGate(
      [R("roe", "READY")],
      ctx({ identity: { passed: 979, failed: 21, uncheckable: 0 } }),
    );
    assert.equal(over.pass, false);
  });

  it("UNCHECKABLE filings are reported apart and never count as passes", () => {
    // MUTATION: fold `uncheckable` into `passed` in the script's tally and the
    // fail rate silently shrinks toward zero.
    const out = judgeRatiosGate(
      [R("roe", "READY")],
      ctx({ identity: { passed: 0, failed: 0, uncheckable: 500 } }),
    );
    assert.equal(out.identityFailRate, undefined);

    // ── AND IT BLOCKS — MONEY-1401 F9 ──────────────────────────────────────
    //
    // THIS ASSERTION IS THE POINT, and the case shipped without it: it built
    // the exact dead state, matched the summary text, and never looked at
    // `pass` — which was TRUE. So the failure `checkBalanceIdentity`'s own
    // docstring names ("a parser that stopped emitting `totalLiabilities`
    // would score 100%") arrived as NOT-MEASURED and waved the run through,
    // with a green test describing it.
    //
    // MUT: drop `identityUnmeasured` from `identityBlocked` in
    // `judgeRatiosGate` -> `pass` is true again and this goes red.
    assert.equal(
      out.pass,
      false,
      "a rung that goes quiet exactly when it breaks must not pass the run",
    );
    assert.match(out.summary, /NOT MEASURED/);
    assert.match(out.summary, /below the floor of 50/);
  });

  it("blocks on EITHER side of the checkable floor, and passes above it", () => {
    // The floor is a threshold, so both sides of it are asserted — a bound
    // satisfied by refusing everything is the failure mode of every threshold.
    //
    // MUT: change `<` to `<=` in `identityUnmeasured` -> the `at` case blocks
    // and this goes red.
    const below = judgeRatiosGate(
      [R("roe", "READY")],
      ctx({
        identity: {
          passed: BALANCE_IDENTITY_MIN_CHECKED - 1,
          failed: 0,
          uncheckable: 3,
        },
      }),
    );
    assert.equal(below.pass, false);

    const at = judgeRatiosGate(
      [R("roe", "READY")],
      ctx({
        identity: {
          passed: BALANCE_IDENTITY_MIN_CHECKED,
          failed: 0,
          uncheckable: 3,
        },
      }),
    );
    assert.equal(at.pass, true);
    assert.equal(at.identityFailRate, 0);
  });

  it("names the CANNOT-GRADE population without counting it as a pass", () => {
    const out = judgeRatiosGate([R("roe", "READY")], ctx());
    assert.equal(out.pass, true);
    assert.equal(out.cannotGrade, 426);
    assert.match(
      out.summary,
      /426 symbol\(s\) hold XBRL data and NO vendor row/,
    );
    assert.match(out.summary, /neither graded nor passed/);
  });

  it("says NOT MEASURED when the caller passes no context", () => {
    // Absence must not read as clean. The production caller is pinned by the
    // source scan in xbrl-ratios-self-comparison-wiring.test.ts.
    const out = judgeRatiosGate([R("roe", "READY")]);
    assert.match(out.summary, /RUN-LEVEL rungs were NOT MEASURED/);
    assert.equal(out.identityFailRate, undefined);
    assert.equal(out.cannotGrade, undefined);
  });

  it("identity can only make the run STRICTER, never rescue a BLOCK", () => {
    const out = judgeRatiosGate([R("roce", "BLOCKED")], ctx());
    assert.equal(out.pass, false);
    assert.match(out.summary, /BLOCKED: roce/);
  });
});

describe("judgeRatiosGate — the FILL CENSUS must be a measurement — F8", () => {
  const J = (ratio: string): RatioGateJudgement => ({
    ratio,
    verdict: "READY",
    matchRate: 1,
    reason: "",
    selfComparisons: 0,
    independentComparable: 100,
    // See the F8b note on the sibling helper above.
    writable: { comparable: 200, matched: 200, matchRate: 1, verdict: "OK" },
  });
  const CTX = (fillPopulation: number): RatiosRunContext => ({
    identity: { passed: 1000, failed: 0, uncheckable: 0 },
    cannotGrade: { count: 0, top: [] },
    fillPopulation,
    // Never BELOW `fillPopulation`, which would be the cohort contradiction and
    // would fail every case here for a reason none of them is about.
    writerReachable: Math.max(fillPopulation, 200),
  });

  it("FAILS the run when the census covered too few writer-reachable symbols", () => {
    // `judgeRatioFill` compares two COUNTS, and `0 >= 0` is OK. So an empty
    // writer-reachable population makes every ratio's fill verdict read OK on
    // every run for ever — the F9 defect reproduced inside the F8 fix. The
    // hazard is named in a comment beside the code; a comment is not a guard.
    //
    // MUT: drop `!fillUnmeasured` from `done()`'s `pass` and this goes red.
    const out = judgeRatiosGate([J("roe")], CTX(FILL_MIN_POPULATION - 1));
    assert.equal(out.pass, false);
    assert.match(out.summary, /FILL CENSUS covered only/);
    assert.match(out.summary, /BELOW the floor/);
  });

  it("passes at the floor — the bound is not satisfied by refusing everything", () => {
    // MUT: `<=` instead of `<` in `fillUnmeasured` and this goes red.
    const out = judgeRatiosGate([J("roe")], CTX(FILL_MIN_POPULATION));
    assert.equal(out.pass, true);
    assert.match(out.summary, /FILL CENSUS taken over 50 writer-reachable/);
  });
});
