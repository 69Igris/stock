/**
 * The WRITER-REACHABLE cohort — MONEY-1401 F8b.
 *
 * `StockRatios` is `@@unique([symbol, exchange])` with no `source` in the key,
 * so the first XBRL write destroys the vendor value and this gate can never
 * again produce arming evidence in that environment. A FALSE READY is the worst
 * outcome it has, and the population it grades is the whole question:
 *
 *   - the AGREEMENT ladder joins the incumbent on the FILING's exchange
 *     (`"NSE"` on all 108,073 rows);
 *   - the WRITER keys its upsert on the INSTRUMENT's and refuses a mismatch.
 *
 * Measured on prod 2026-09-13, those differ by 92.3%. Everything below exists
 * because the one line separating them — `inst.exchange === f.exchange` — lived
 * inline in `scripts/data/xbrl-ratios-validate.ts`, where DELETING IT restored
 * the defect with the whole suite green: `grep -rn 'writerReachable'` across
 * every test file returned nothing.
 *
 * Each `it` below was mutation-verified against the source it covers: the
 * assertion was confirmed RED with the rule broken and GREEN with it restored.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Imported from the MODULE rather than the `@usemoney/core/market-data` barrel:
// the barrel has no entry for the two new exports yet, and adding one is a
// change to a file this work does not own. Precedented across
// `packages/core/__tests__/brokers/*`.
import {
  writerReachableSymbols,
  judgeWritableAgreement,
  judgeRatioReadiness,
  judgeRatiosGate,
  RATIO_MIN_COMPARABLE,
  RATIO_PASS_RATE,
  type RatioGateInput,
  type RatioGateJudgement,
  type RatiosRunContext,
} from "../../src/market-data/xbrl-ratios-gate";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** LINE comments before BLOCK comments — MONEY-1143. */
const strip = (src: string): string =>
  src.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const SCRIPT = strip(
  readFileSync(join(ROOT, "scripts/data/xbrl-ratios-validate.ts"), "utf8"),
);

/** Index of `needle`, asserted present rather than silently -1. */
function at(hay: string, needle: string): number {
  const i = hay.indexOf(needle);
  assert.notEqual(i, -1, `expected to find \`${needle}\` in the script`);
  return i;
}

/* -------------------------------------------------------------------------- */
/* writerReachableSymbols                                                     */
/* -------------------------------------------------------------------------- */

describe("writerReachableSymbols — the exchange match is the whole rule", () => {
  it("REFUSES a filing whose instrument sits on another exchange", () => {
    // THE mutation target. Drop `inst.exchange === f.exchange` and this symbol
    // becomes reachable, which is the 92.3% over-count restored.
    const reachable = writerReachableSymbols(
      [{ symbol: "ACME", exchange: "NSE", instrumentId: "i1" }],
      new Map([["i1", { exchange: "BSE" }]]),
    );
    assert.deepEqual([...reachable], []);
  });

  it("ADMITS a filing whose instrument is on the filing's own exchange", () => {
    // The other half of the same mutation: an assertion that only ever refuses
    // would pass against a function that returns the empty set unconditionally.
    const reachable = writerReachableSymbols(
      [{ symbol: "ACME", exchange: "NSE", instrumentId: "i1" }],
      new Map([["i1", { exchange: "NSE" }]]),
    );
    assert.deepEqual([...reachable], ["ACME"]);
  });

  it("REFUSES an instrument the caller's query did not return", () => {
    // The caller filters `isActive` in the query, so a missing id is a row
    // outside the writer's own `XBRL_ARM_WHERE` cohort. Treating "not in the
    // map" as reachable is the fail-open reading.
    const reachable = writerReachableSymbols(
      [{ symbol: "ACME", exchange: "NSE", instrumentId: "gone" }],
      new Map([["i1", { exchange: "NSE" }]]),
    );
    assert.deepEqual([...reachable], []);
  });

  it("REFUSES a filing that resolves to no instrument at all", () => {
    const reachable = writerReachableSymbols(
      [{ symbol: "ACME", exchange: "NSE", instrumentId: null }],
      new Map([["", { exchange: "NSE" }]]),
    );
    assert.deepEqual([...reachable], []);
  });

  it("measures the prod shape: a mixed set collapses to the matching minority", () => {
    // 1 of 4, the direction prod is in (155 of 2,025). A per-filing rule that
    // looked right on a single row and wrong in aggregate is exactly what the
    // inline version was.
    const reachable = writerReachableSymbols(
      [
        { symbol: "A", exchange: "NSE", instrumentId: "i1" },
        { symbol: "B", exchange: "NSE", instrumentId: "i2" },
        { symbol: "C", exchange: "NSE", instrumentId: null },
        { symbol: "D", exchange: "NSE", instrumentId: "missing" },
      ],
      new Map([
        ["i1", { exchange: "NSE" }],
        ["i2", { exchange: "BSE" }],
      ]),
    );
    assert.deepEqual([...reachable].sort(), ["A"]);
  });
});

/* -------------------------------------------------------------------------- */
/* judgeWritableAgreement                                                     */
/* -------------------------------------------------------------------------- */

describe("judgeWritableAgreement", () => {
  it("BLOCKS when the writable cohort agrees below the pass rate", () => {
    const w = judgeWritableAgreement(200, 100);
    assert.equal(w.verdict, "BLOCK");
    assert.equal(w.matchRate, 0.5);
  });

  it("is OK at the pass rate exactly — the gate is `< passRate`", () => {
    // A `<=` here would block a cohort that met the published gate, and the
    // constant is shared with the ladder, so the boundary has to be pinned on
    // both sides rather than asserted as "roughly 95%".
    const n = 200;
    const w = judgeWritableAgreement(n, Math.round(n * RATIO_PASS_RATE));
    assert.equal(w.matchRate, RATIO_PASS_RATE);
    assert.equal(w.verdict, "OK");
    assert.equal(
      judgeWritableAgreement(n, n * RATIO_PASS_RATE - 1).verdict,
      "BLOCK",
    );
  });

  it("is NOT_MEASURED below the floor, and NOT_MEASURED is not OK", () => {
    // The honest third value. `netMargin`'s writable cohort is ~3 pairs on
    // prod: a 0% rate over 3 rows is noise in a costume, and reporting it as OK
    // would be the rung going quiet in the state it exists to detect.
    const thin = judgeWritableAgreement(RATIO_MIN_COMPARABLE - 1, 0);
    assert.equal(thin.verdict, "NOT_MEASURED");
    assert.notEqual(thin.verdict, "OK");
    // And the floor is INCLUSIVE: at exactly the floor it is measured.
    assert.equal(
      judgeWritableAgreement(RATIO_MIN_COMPARABLE, 0).verdict,
      "BLOCK",
    );
  });

  it("an EMPTY cohort is NOT_MEASURED, never OK — `0/0` must not read as agreement", () => {
    const w = judgeWritableAgreement(0, 0);
    assert.equal(w.matchRate, 0);
    assert.equal(w.verdict, "NOT_MEASURED");
  });

  it("clamps a caller reporting more matches than pairs", () => {
    // Unclamped this prints a rate above 100% and passes. The same clamp the
    // agreement ladder carries, for the same reason.
    const w = judgeWritableAgreement(100, 400);
    assert.equal(w.matched, 100);
    assert.equal(w.matchRate, 1);
  });

  it("THREADS `opts` — both thresholds, through judgeRatioReadiness", () => {
    // The review's residual: `opts` was accepted and never exercised, so
    // `judgeRatioReadiness` could have called `judgeWritableAgreement(c, m)`
    // with no third argument and every existing case stayed green. Both
    // thresholds are asserted through the WRAPPER, not directly, because the
    // wrapper is the only caller that has to forward them.
    //
    // MUTATION: drop `opts` from the `judgeWritableAgreement(...)` call in
    // `judgeRatioReadiness` -> RED on both halves.
    const thin = judgeRatioReadiness(
      wide({ writable: { comparable: 10, matched: 10 } }),
      { minComparable: 5 },
    );
    assert.equal(
      thin.writable?.verdict,
      "OK",
      "a lowered floor must make a 10-pair cohort MEASURED",
    );
    const strict = judgeRatioReadiness(
      wide({ writable: { comparable: 200, matched: 198 } }),
      { passRate: 0.999 },
    );
    assert.equal(
      strict.writable?.verdict,
      "BLOCK",
      "a raised pass rate must block 99%",
    );
    // And the defaults still apply when nothing is passed — the falsifier for a
    // wrapper that ignored its own defaults too.
    assert.equal(
      judgeRatioReadiness(wide({ writable: { comparable: 10, matched: 10 } }))
        .writable?.verdict,
      "NOT_MEASURED",
    );
  });

  it("clamps non-finite and negative counts rather than trusting them", () => {
    // A NaN denominator makes every comparison false, which reads as "fine".
    assert.equal(
      judgeWritableAgreement(Number.NaN, 10).verdict,
      "NOT_MEASURED",
    );
    assert.equal(judgeWritableAgreement(200, -5).verdict, "BLOCK");
    assert.equal(judgeWritableAgreement(200, -5).matched, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* judgeRatioReadiness — the rung is STRICT-ONLY                              */
/* -------------------------------------------------------------------------- */

/** Agreeing on the wide population, healthy fill, UNCONTAMINATED. */
function wide(over: Partial<RatioGateInput> = {}): RatioGateInput {
  return {
    ratio: "roe",
    comparable: 2000,
    matched: 1980,
    scaleMismatches: 0,
    signMismatches: 0,
    weHave: 2100,
    theyHave: 2038,
    fill: { xbrl: 2100, vendor: 2038 },
    selfComparisons: 0,
    selfMatched: 0,
    ...over,
  };
}

describe("judgeRatioReadiness — the writable cohort can only make it stricter", () => {
  it("READY on the wide population is BLOCKED when the rows we STORE disagree", () => {
    // THE false READY this rung exists for. 99% across 2,000 graded pairs, 50%
    // across the 200 arming would actually write. Without the rung this is
    // READY, `blocked` empty, `pass` true, on a one-way door.
    const j = judgeRatioReadiness(
      wide({
        comparable: 2000,
        matched: 1980,
        writable: { comparable: 200, matched: 100 },
      }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.equal(j.writable?.verdict, "BLOCK");
    assert.match(j.reason, /WRITABLE-COHORT DISAGREEMENT/);
    // The ladder's own answer survives in the reason: "READY on agreement,
    // BLOCKED on the rows we store" is two facts.
    assert.match(j.reason, /agreement alone said READY/);
  });

  it("leaves a READY alone when the writable cohort agrees too", () => {
    // The falsifier. An assertion that only ever blocks would pass against a
    // rung that blocks unconditionally.
    const j = judgeRatioReadiness(
      wide({ writable: { comparable: 200, matched: 199 } }),
    );
    assert.equal(j.verdict, "READY");
    assert.equal(j.writable?.verdict, "OK");
    assert.doesNotMatch(j.reason, /WRITABLE-COHORT/);
  });

  it("NEVER rescues: a blocked ladder stays BLOCKED on a perfect writable cohort", () => {
    // `roce`'s shape — 49 sign mismatches on the wide population, all of them
    // outside today's reachable cohort. Rescuing it here is the review remedy
    // that was REFUSED: a sign error is a statement about the derivation code,
    // and `reresolve-xbrl-instruments.ts` grows the cohort to include those
    // rows. Arming on this would open the door and then widen the damage.
    const j = judgeRatioReadiness(
      wide({
        ratio: "roce",
        signMismatches: 49,
        writable: { comparable: 200, matched: 200 },
      }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /systematic error/);
    assert.equal(j.writable?.verdict, "OK");
  });

  it("a thin writable cohort does not BLOCK, but it does end the READY", () => {
    // THIS CASE USED TO ASSERT THE DEFECT. It read "a thin writable cohort
    // neither blocks nor rescues" and expected READY, and the module's own
    // docstring said the hazard was "answered one level up" by
    // `RatiosRunContext.fillPopulation`. That was a UNITS ERROR:
    // `fillPopulation` counts SYMBOLS (179 on prod) and `comparable` counts
    // PAIRS PER RATIO (0/69/133 on that same run), so neither bounds the other
    // and `judgeRatiosGate` never read `writable` at all. Executed: a READY
    // whose writable cohort agreed on ZERO of 7 pairs passed the run.
    //
    // UNVERIFIABLE, not BLOCKED: nothing disagreed. It is never counted toward
    // a pass, and it does not block — the same polarity as the vendor floor.
    const j = judgeRatioReadiness(
      wide({ writable: { comparable: 3, matched: 0 } }),
    );
    assert.equal(j.verdict, "UNVERIFIABLE");
    assert.equal(j.writable?.verdict, "NOT_MEASURED");
    assert.match(j.reason, /WRITABLE COHORT NOT MEASURED/);
    // The ladder's own answer survives, so "READY on agreement, unmeasured on
    // the rows we store" stays two facts.
    assert.match(j.reason, /agreement alone said READY/);
  });

  it("does NOT downgrade a verdict the ladder already settled", () => {
    // The falsifier for the rule above: it must reach only READY. A ladder that
    // said BLOCKED keeps the more actionable answer, and an UNVERIFIABLE keeps
    // the vendor-coverage reason rather than being re-blamed on the cohort.
    const blocked = judgeRatioReadiness(
      wide({ signMismatches: 49, writable: { comparable: 3, matched: 0 } }),
    );
    assert.equal(blocked.verdict, "BLOCKED");
    assert.doesNotMatch(blocked.reason, /WRITABLE COHORT NOT MEASURED/);

    const thinVendor = judgeRatioReadiness(
      wide({
        theyHave: 3,
        comparable: 3,
        matched: 3,
        writable: { comparable: 3, matched: 0 },
      }),
    );
    assert.equal(thinVendor.verdict, "UNVERIFIABLE");
    assert.match(thinVendor.reason, /vendor coverage too thin/);
  });

  it("a DECLARED_DIVERGENCE is NOT blocked by the writable cohort", () => {
    // MEDIUM-4. A declaration says the two sides are NOT THE SAME QUANTITY;
    // restricting those pairs to the writer's cohort grades the same
    // non-comparison over fewer rows. Blocking on that rate permanently fails
    // the run for the one reason the gate has already ruled is not a defect,
    // with no way to clear it.
    //
    // The FILL rung has this carve-out implicitly — `FILL_BLOCKING_RATIOS` is
    // {roe, roce, netMargin} and `debtToEquity` is not in it — and this rung had
    // none. Latent on the 2026-09-14 prod run only because `debtToEquity`'s
    // writable cohort is 0 pairs; it arms itself once
    // `reresolve-xbrl-instruments.ts` grows the cohort past the floor.
    const j = judgeRatioReadiness(
      wide({
        ratio: "debtToEquity",
        comparable: 21,
        matched: 1,
        theyHave: 21,
        declaredDivergence:
          "our totalDebt excludes Ind-AS 116 lease liabilities.",
        writable: { comparable: 120, matched: 6 },
      }),
    );
    assert.equal(j.verdict, "DECLARED_DIVERGENCE");
    assert.equal(j.writable?.verdict, "BLOCK");
    // PRINTED, never hidden — the same treatment a non-blocking fill WARN gets.
    assert.match(j.reason, /WRITABLE-COHORT DISAGREEMENT/);
  });

  it("still BLOCKS a GRADED ratio on the same numbers", () => {
    // The falsifier for the carve-out: without this, a rung that never blocks
    // at all would satisfy the case above.
    const j = judgeRatioReadiness(
      wide({ ratio: "roe", writable: { comparable: 120, matched: 6 } }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /WRITABLE-COHORT DISAGREEMENT/);
  });

  it("reports BOTH findings when fill and the writable cohort each fail", () => {
    // Nested, one would hide the other — the complaint `judgeRatioReadiness`'s
    // own header makes about placing the fill rung inside the ladder.
    const j = judgeRatioReadiness(
      wide({
        ratio: "roe",
        fill: { xbrl: 10, vendor: 800 },
        writable: { comparable: 200, matched: 100 },
      }),
    );
    assert.equal(j.verdict, "BLOCKED");
    assert.match(j.reason, /FILL BLOCK/);
    assert.match(j.reason, /WRITABLE-COHORT DISAGREEMENT/);
  });

  it("an absent `writable` leaves every existing verdict untouched", () => {
    // The optional field's polarity. Callers that do not measure the cohort get
    // exactly the judgement they got before, and the absence is VISIBLE as an
    // undefined field rather than scored as agreement.
    //
    // This is the PER-RATIO half only. The RUN-level half is the next describe
    // block: a caller that supplies a `RatiosRunContext` — i.e. one that claims
    // to have measured the run — fails the run if a READY carries no writable
    // information at all.
    const j = judgeRatioReadiness(wide());
    assert.equal(j.verdict, "READY");
    assert.equal(j.writable, undefined);
    assert.doesNotMatch(j.reason, /WRITABLE-COHORT/);
  });
});

/* -------------------------------------------------------------------------- */
/* judgeRatiosGate — the RUN-level half                                       */
/* -------------------------------------------------------------------------- */

/**
 * `pass` never read `writable`, and two population mutations never showed up.
 *
 * The per-ratio rungs above are half the F8b fix. The other half is here, and
 * it is where the review's three HIGH findings actually land:
 *
 *   - NOT_MEASURED was byte-identical to OK at run level, because
 *     `pass: o.pass && !identityBlocked && !fillUnmeasured` has no `writable`
 *     term. (Closed above, by the downgrade, plus `readyWithoutWritable` here.)
 *   - `writable: writerReachable.has(f.symbol)` -> `writable: true` in the
 *     script left 176/176 green.
 *   - `if (!writerReachable.has(f.symbol)) continue;` DELETED from the fill
 *     census left 176/176 green.
 *
 * The last two were only ever pinned by SOURCE SCANS, and one of those scans
 * was a `doesNotMatch` that the mutation satisfied HARDER. They are caught
 * arithmetically now: both produce a population LARGER than the writer-reachable
 * set it was drawn from, which correct code cannot do.
 */
describe("judgeRatiosGate — the writable cohort has a term in `pass`", () => {
  const ready = (
    over: Partial<RatioGateJudgement> = {},
  ): RatioGateJudgement => ({
    ratio: "netMargin",
    verdict: "READY",
    matchRate: 1,
    reason: "",
    selfComparisons: 0,
    independentComparable: 100,
    writable: { comparable: 150, matched: 150, matchRate: 1, verdict: "OK" },
    ...over,
  });
  const ctx = (over: Partial<RatiosRunContext> = {}): RatiosRunContext => ({
    identity: { passed: 2246, failed: 0, uncheckable: 220 },
    cannotGrade: { count: 426, top: [] },
    fillPopulation: 179,
    writerReachable: 183,
    ...over,
  });

  it("PASSES when the writable cohort was measured and agreed", () => {
    // The falsifier. Every case below asserts a REFUSAL; without this one they
    // would all pass against a gate that refuses unconditionally.
    const out = judgeRatiosGate([ready()], ctx());
    assert.equal(out.pass, true);
    assert.deepEqual(out.ready, ["netMargin"]);
  });

  it("FAILS a run whose READY ratio carries NO writable agreement at all", () => {
    // MUTATION: drop `!readyWithoutWritable` from `done()`'s `pass` -> GREEN
    // here, which is the state the gate shipped in.
    //
    // Behavioural where the old guard was a source scan: deleting `writable:
    // {...}` from the script's `judgeRatioReadiness` call now fails a test
    // regardless of how the call site is spelled.
    const out = judgeRatiosGate([ready({ writable: undefined })], ctx());
    assert.equal(out.pass, false);
    assert.match(out.summary, /NO writable-cohort agreement/);
  });

  it("leaves a context-less caller alone — absence there means a test literal", () => {
    // The polarity `identityUnmeasured` already uses. No context means "this
    // caller is not exercising the run-level rungs", which the summary says in
    // those words; the production caller is the one that supplies a context.
    const out = judgeRatiosGate([ready({ writable: undefined })]);
    assert.equal(out.pass, true);
    assert.match(out.summary, /RUN-LEVEL rungs were NOT MEASURED/);
  });

  it("FAILS when the FILL CENSUS is bigger than the writer-reachable set", () => {
    // HIGH-3, arithmetically. Deleting the census's
    // `if (!writerReachable.has(f.symbol)) continue;` takes `fillPopulation`
    // from 179 to ~2,300 against `writerReachable` 183 — impossible in correct
    // code, and the silent restoration of the 92.3% over-count.
    //
    // MUTATION: drop the `fillPopulation > writerReachable` clause -> GREEN.
    const out = judgeRatiosGate(
      [ready()],
      ctx({ fillPopulation: 2300, writerReachable: 183 }),
    );
    assert.equal(out.pass, false);
    assert.match(out.summary, /COHORT CONTRADICTION/);
    assert.match(out.summary, /census is not filtered by reachability/);
  });

  it("FAILS when a ratio's writable cohort is bigger than that set", () => {
    // HIGH-2, arithmetically. `writable: writerReachable.has(f.symbol)` ->
    // `writable: true` makes the writable cohort the GRADED cohort: roe's 69
    // pairs become 796 against `writerReachable` 183. One symbol contributes at
    // most one pair per ratio, so `comparable <= writerReachable` always holds
    // when the tag is real.
    //
    // MUTATION: drop the `j.writable.comparable > writerReachable` clause ->
    // GREEN.
    const out = judgeRatiosGate(
      [
        ready({
          ratio: "roe",
          writable: {
            comparable: 796,
            matched: 763,
            matchRate: 763 / 796,
            verdict: "OK",
          },
        }),
      ],
      ctx(),
    );
    assert.equal(out.pass, false);
    assert.match(out.summary, /COHORT CONTRADICTION/);
    assert.match(out.summary, /roe's writable cohort/);
  });

  it("allows the writable cohort to EQUAL the reachable set", () => {
    // The boundary, and the falsifier for a `>=` that would fail every healthy
    // run where the census refused nobody.
    const out = judgeRatiosGate(
      [
        ready({
          writable: {
            comparable: 183,
            matched: 183,
            matchRate: 1,
            verdict: "OK",
          },
        }),
      ],
      ctx({ fillPopulation: 183, writerReachable: 183 }),
    );
    assert.equal(out.pass, true);
  });

  it("reports EVERY contradiction, not just the first", () => {
    // Two populations drawn from one set; naming one and stopping sends the
    // reader to fix half of it and re-run.
    const out = judgeRatiosGate(
      [
        ready({
          ratio: "roe",
          writable: {
            comparable: 796,
            matched: 796,
            matchRate: 1,
            verdict: "OK",
          },
        }),
      ],
      ctx({ fillPopulation: 2300 }),
    );
    assert.match(out.summary, /census is not filtered by reachability/);
    assert.match(out.summary, /roe's writable cohort/);
  });
});

/* -------------------------------------------------------------------------- */
/* the PRODUCTION caller                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A source scan cannot assert a POLICY — it proves a call site exists, not that
 * the expression inside it is the right one. Every rule above is therefore
 * asserted against the pure functions; these four are ORDERING facts about a
 * script that cannot be imported (a top-level `main()` over Prisma), and
 * ordering is exactly what all three defects here were.
 */
describe("scripts/data/xbrl-ratios-validate.ts — the wiring", () => {
  it("computes the writer-reachable set BEFORE the grading loop", () => {
    // The defect: the set was built 400 lines BELOW the loop, so the only rung
    // that could see it was the fill census and every input to the verdict was
    // computed over the population the writer refuses.
    const built = SCRIPT.indexOf("writerReachableSymbols(");
    const loop = SCRIPT.indexOf("for (const f of newest.values()) {");
    assert.ok(built > 0, "the script must call writerReachableSymbols");
    assert.ok(loop > 0, "the grading loop must still exist");
    assert.ok(
      built < loop,
      "writerReachable must be computed before the first grading pass",
    );
  });

  it("hands the writable cohort to the ladder", () => {
    assert.match(SCRIPT, /writable:\s*\{\s*comparable:\s*writableRows\.length/);
    assert.match(SCRIPT, /comparable\.filter\(\(j\) => j\.writable\)/);
  });

  it("hands the reachable SET SIZE to the run context", () => {
    // The oracle for both arithmetic rungs above. A scan, and it is the WEAK
    // half deliberately: the rungs themselves are behavioural, and this only
    // pins where the number comes from. A mutation that ALSO lies here (passing
    // `newest.size`) defeats both — one deliberate edit past the two the review
    // found, and it is reported as residual rather than claimed as covered.
    assert.match(SCRIPT, /writerReachable:\s*writerReachable\.size/);
  });

  it("restricts the instrument map to ACTIVE rows", () => {
    // The writer's `XBRL_ARM_WHERE` cohort is active-only, and
    // `writerReachableSymbols` treats an id missing from the map as
    // unreachable — so this filter IS the "active" half of the rule, applied in
    // the caller's query where the pure function cannot see it. Dropped, an
    // inactive instrument becomes writer-reachable and the gate grades rows the
    // writer never selects.
    const query = SCRIPT.slice(
      at(SCRIPT, "prisma.instrumentMapping.findMany("),
      SCRIPT.indexOf("writerReachableSymbols("),
    );
    assert.match(query, /isActive:\s*true/);
  });

  it("TAGS each pair from the reachable SET, never a literal", () => {
    // The mutation the F8b review found: `writable: writerReachable.has(...)`
    // -> `writable: true`. The writable cohort becomes the GRADED cohort and
    // the rung can never block anything the ladder did not — and the ONLY
    // assertion naming `writerReachable.has` was the NEGATIVE one below, which
    // the mutation satisfies HARDER.
    //
    // A scan, and the WEAK half deliberately. The strong half is arithmetic and
    // runs at run time: `judgeRatiosGate` refuses when a ratio's writable
    // cohort exceeds `writerReachable`, which this mutation makes it do (roe:
    // 796 pairs against 183 reachable symbols). Verified against prod.
    const loop = SCRIPT.indexOf("for (const f of newest.values()) {");
    const census = SCRIPT.indexOf("const fillXbrl = new Map");
    const gradingLoop = SCRIPT.slice(loop, census);
    assert.match(gradingLoop, /writable:\s*writerReachable\.has\(f\.symbol\)/);
  });

  it("FILTERS the census by reachability — the other half of the same rule", () => {
    // The mirror of the case below, and the gap it left: that one pins the
    // grading loop's ABSENCE of the filter and nothing pinned the census's
    // PRESENCE of it. Deleting `if (!writerReachable.has(f.symbol)) continue;`
    // silently restored the 92.3% over-count with the suite green.
    //
    // Again the weak half; `fillPopulation > writerReachable` is the strong one.
    const census = SCRIPT.indexOf("const fillXbrl = new Map");
    const perRatio = SCRIPT.indexOf("const gateJudgements:");
    assert.ok(census > 0 && perRatio > census);
    assert.match(
      SCRIPT.slice(census, perRatio),
      /if \(!writerReachable\.has\(f\.symbol\)\) continue;/,
    );
  });

  it("does NOT filter the grading loop by reachability", () => {
    // The direction that was REFUSED, pinned so a later reader does not "finish
    // the job": narrowing the ladder loses `roce`'s blocker to an accident of
    // instrument resolution and collapses three ratios' vendor coverage to ~3
    // rows. The census loop has that `continue`; the grading loop must not.
    const loop = SCRIPT.indexOf("for (const f of newest.values()) {");
    const census = SCRIPT.indexOf("const fillXbrl = new Map");
    assert.ok(census > loop);
    const gradingLoop = SCRIPT.slice(loop, census);
    assert.doesNotMatch(gradingLoop, /!writerReachable\.has\(/);
  });

  it("counts BOTH fill sides after the writer's refusals", () => {
    // The vendor tally used to run ahead of the three `continue`s and ours
    // after them, so a refused row counted on the vendor side only — "would
    // arming replace a populated column" answered wrong for a row arming never
    // writes.
    const vendor = SCRIPT.indexOf("fillVendor.set(key,");
    const stale = SCRIPT.indexOf("fillStaleAnnual++");
    const veto = SCRIPT.indexOf("fillNotWorthWriting++");
    const ours = SCRIPT.indexOf("fillXbrl.set(key,");
    assert.ok(stale > 0 && veto > 0);
    assert.ok(
      vendor > stale,
      "vendor fill must be counted after the stale skip",
    );
    assert.ok(vendor > veto, "vendor fill must be counted after the plan veto");
    assert.ok(
      SCRIPT.indexOf("fillPopulation++") > veto,
      "fillPopulation must size the population the two counts were taken over",
    );
    assert.ok(ours > veto);
  });

  it("reads `facts` through the writer's own guard, never a local typeof", () => {
    // `{}` passes `typeof x === "object"` and its `.values` is undefined, so
    // the identity rung's `.values.totalLiabilities` TypeErrors. That rung runs
    // FIRST, for every symbol, and the loop has no per-symbol `try` — one
    // malformed row ended the run with no verdict at all.
    assert.match(SCRIPT, /import \{ readFacts \}/);
    assert.doesNotMatch(SCRIPT, /typeof\s+identityFacts\s*!==\s*"object"/);
    assert.doesNotMatch(SCRIPT, /typeof\s+facts\s*!==\s*"object"/);
    assert.doesNotMatch(SCRIPT, /typeof\s+priorFacts\s*===\s*"object"/);
  });
});
