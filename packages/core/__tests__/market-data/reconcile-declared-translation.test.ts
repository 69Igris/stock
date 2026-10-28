/**
 * The F3 reconcile must name a DEFINITIONAL match as one — MONEY-1239.
 *
 * ## The finding this encodes
 *
 * The gate BLOCKED while our projection was CORRECT. Adjudicated against
 * screener.in as a third source: 3MINDIA reconciles 12/12 to the rupee against
 * screener's CONSOLIDATED over FY2021-23 x {revenue, netIncome,
 * operatingIncome, ebitda}, while the vendor matches screener's STANDALONE. The
 * two sides agree about the FACTS and disagree about exactly one line item —
 * OTHER INCOME — which the vendor folds into `revenue` (their column is TOTAL
 * INCOME) and into `operatingIncome` (their column is EBIT INCLUDING other
 * income), and we do not.
 *
 * Measured on prod, 7,167 comparisons, relative-difference percentiles:
 *
 *   field              n     p50     p75     p90     p95     p99   within 1%
 *   revenue          2442   2.19%   6.93%  21.95%  51.00%  95.53%    29.7%
 *   netIncome        2443   0.01%   0.14%   3.20%  19.54%  99.43%    86.9%
 *   operatingIncome  2282  17.16%  41.54%  91.07% 117.46% 163.32%     3.0%
 *
 * Three magnitudes, ONE phenomenon: the same absolute other-income amount over
 * three different denominators. `netIncome` agrees because there is no gap
 * there, which is why translating it is FORBIDDEN rather than merely unhelpful.
 *
 * ## What these cases defend
 *
 * A translation is one move away from "widen the tolerance until the gate
 * passes", so every property that separates the two is pinned here:
 *
 *  - the extra term is read off THE SAME FILING, never fitted;
 *  - `netIncome` is not translated;
 *  - TRANSLATED is its own printed bucket and is never folded into `matched`;
 *  - both disagreement rates are reported and the verdict's one is named;
 *  - an absent `otherIncome` is `translationUnavailable`, not a failed
 *    translation, and still counts as a disagreement;
 *  - the ordering stays SCALE > SIGN > TRANSLATION > DISAGREE;
 *  - and the INCUMBENT-NULLING trade — invisible to the ladder by construction,
 *    because a blank on our side scores INCOMPARABLE — is counted and printed.
 *
 * The reconcile needs a database, so its own logic is pinned STRUCTURALLY, the
 * same way `reconcile-gate-population.test.ts` pins the population fixes. The
 * arithmetic PREMISE underneath it is pinned behaviourally against the real
 * exported `reconcile` / `judgeSwitchoverReadiness`, so the two halves cannot
 * both be true of a script that does not work.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  reconcile,
  judgeSwitchoverReadiness,
  type ReconcileVerdict,
} from "../../src/market-data/index.js";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** LINE comments before BLOCK comments — MONEY-1143. */
const strip = (src: string): string =>
  src.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const CODE = strip(
  readFileSync(join(ROOT, "scripts/data/xbrl-reconcile.ts"), "utf8"),
);

describe("MONEY-1239 — the declared other-income translation", () => {
  it("covers revenue and operatingIncome, and NOTHING else", () => {
    // The set is asserted WHOLE rather than by membership. `netIncome` has no
    // other-income gap (p50 0.01%, 86.9% within 1%), so a translation there
    // could only ever fire on a pair that is genuinely wrong — it would mask
    // the exact defect the gate exists to surface. Adding a third field is a
    // decision that has to break a test, not slide in.
    assert.match(
      CODE,
      // RENAMED, NOT WIDENED — MONEY-1255. `ProjectedFinancials.revenue` and
      // `.operatingIncome` became `.revenueFromOperations` and
      // `.operatingIncomeExOtherIncome` when the projection stopped claiming
      // the vendor's like-named columns. The SET IS STILL TWO and still
      // excludes `netIncome`, which is the whole point of asserting it whole.
      /const OTHER_INCOME_TRANSLATED: ReadonlySet<Field> = new Set<Field>\(\[\s*"revenueFromOperations",\s*"operatingIncomeExOtherIncome",\s*\]\);/,
    );
  });

  it("requires the otherIncome VALUE FROM THE SAME FILING", () => {
    // "ours + X == theirs for some X" is not evidence of anything. The term has
    // to be a concept the filing itself disclosed, which is what makes this a
    // translation rather than a fitted residual.
    assert.match(CODE, /const otherIncome = raw\("otherIncome"\);/);
    assert.match(
      CODE,
      /\(financials\.values as Record<string, number \| undefined>\)\[concept\]/,
    );
    // Gated on membership AND on the value being present — both, in that order.
    assert.match(
      CODE,
      /OTHER_INCOME_TRANSLATED\.has\(field\) &&\s*ours !== undefined &&\s*otherIncome !== undefined/,
    );
    assert.match(
      CODE,
      /label: "ours \+ otherIncome",\s*value: ours \+ otherIncome,/,
    );
  });

  it("never offers a numeric literal as a candidate quantity", () => {
    // The cheap net under the rule above. Every candidate is built from named
    // concepts; a bare number in the `value` slot is a fitted constant wearing
    // a label, and it would satisfy every other assertion in this file.
    assert.doesNotMatch(
      CODE,
      /alternatives\.push\(\{\s*label: "[^"]*",\s*value: -?\d/,
    );
  });

  it("tries the DECLARED reconstruction before any derived fallback", () => {
    // Candidates are tried in array order and the FIRST match wins, so source
    // order decides attribution. The declared form has to come first or the
    // `by reconstruction` histogram credits `PBT + FC` for pairs the plain
    // other-income gap already explains — and that histogram is the evidence
    // for how well the two sources are understood.
    const declared = CODE.indexOf('label: "ours + otherIncome"');
    const derived = CODE.indexOf('label: "PBT + FC"');
    assert.ok(declared > 0 && derived > 0, "could not locate both candidates");
    assert.ok(
      declared < derived,
      "the declared translation must be tried first",
    );
  });
});

describe("MONEY-1239 — TRANSLATED is a bucket, not a match", () => {
  it("classifies separately from the verdict handed to the judge", () => {
    // The verdict stays MATCH — no readiness threshold and no write decision
    // moves — while `classification` records what actually happened. Two
    // fields, deliberately: collapsing them is the silent fold this ticket
    // exists to remove.
    assert.match(
      CODE,
      /classification: translated \? "TRANSLATED" : r\.verdict,/,
    );
    assert.match(
      CODE,
      /if \(c\.classification === "TRANSLATED"\) t\.translated\+\+;/,
    );
  });

  it("subtracts translations out of the printed match count", () => {
    // `v.matched` counts MATCH verdicts and a translated pair IS one, so
    // printing it raw next to a translated count would double-count and read
    // as a larger raw agreement than exists. Pinned on the ARITHMETIC: a
    // version that prints the bucket and still shows `v.matched` as "matched"
    // satisfies every string assertion and states something false.
    assert.match(CODE, /const matchedRaw = v\.matched - t\.translated;/);
    assert.match(
      CODE,
      /matched \$\{matchedRaw\}, translated \$\{t\.translated\}, /,
    );
    assert.doesNotMatch(CODE, /matched \$\{v\.matched\}/);
  });

  it("reports BOTH disagreement rates and names the one the verdict used", () => {
    // The threshold decision is the founder's. The counterfactual is computed
    // by the SAME judge with the SAME defaults so the two numbers are directly
    // comparable rather than two different measurements.
    //
    // A translation is demoted to THE VERDICT IT ACTUALLY HELD, not blanket to
    // DISAGREEMENT — MONEY-1236. `judgeSwitchoverReadiness` blocks
    // UNCONDITIONALLY on a sign mismatch but treats a disagreement as one
    // contributor to a rate, so collapsing the two made this counterfactual
    // PERMISSIVE about the single verdict that is not negotiable: it could print
    // "would read READY" where the honest strict answer is BLOCKED. That line is
    // the founder's threshold input for a ONE-WAY DOOR.
    assert.match(CODE, /c\.signResolvedByTranslation/);
    assert.match(CODE, /\?\s*"SIGN_MISMATCH"\s*:\s*"DISAGREEMENT"/);
    assert.doesNotMatch(
      CODE,
      /strict\.push\(c\.classification === "TRANSLATED" \? "DISAGREEMENT" : c\.verdict\);/,
      "the blanket demotion is permissive about SIGN_MISMATCH",
    );
    assert.match(
      CODE,
      /const strict = judgeSwitchoverReadiness\(byFieldStrict\.get\(field\) \?\? \[\]\);/,
    );
    assert.match(CODE, /THIS IS THE RATE THE VERDICT ABOVE USED/);
    assert.match(CODE, /disagreement rate WITHOUT them/);
  });

  it("the sign-rescue flag survives onto the Comparison it describes", () => {
    // The demotion above can only be right if the flag actually reaches the
    // reduce. `signResolvedByTranslation` is set in the translation loop; if it
    // is not also pushed onto the comparison, the strict counterfactual reads
    // `undefined` for every pair and silently reverts to the permissive
    // behaviour — with the code above still looking correct.
    assert.match(
      CODE,
      /signResolvedByTranslation\s*\n?\s*\?\s*\{ signResolvedByTranslation: true as const \}/,
    );
    assert.match(CODE, /signResolvedByTranslation\?: true;/);
  });

  it("the strict counterfactual is evidence and never a gate", () => {
    // `allReady` is what the exit code reads. Wiring the strict verdict into it
    // would be this script making the founder's threshold decision for them —
    // in the opposite direction from the bug it was asked to fix.
    assert.doesNotMatch(CODE, /strict\.ready\) allReady/);

    // THE SOFTENERS MOVED INTO A TESTED FUNCTION — MONEY-1255, and the
    // guarantee this assertion carries is unchanged: `allReady` is driven by
    // ONE expression, and the exemptions it honours are enumerable.
    //
    // It used to be `if (!v.ready && !unverifiable) allReady = false;` — one
    // softener, spelled out here. D2 adds a second (`DECLARED`), and three
    // states whose precedence lives in the order three `if`s happen to be
    // written is how the ratios gate became unpassable for a release. So the
    // ladder is now `judgeFieldGateOutcome`, whose ORDERING is unit-tested in
    // `reconcile-declared-divergence.test.ts` — including that `blocks` is true
    // for BLOCKED and for nothing else, across every input combination.
    //
    // What is pinned HERE is the part that function cannot pin: that the call
    // site reads its answer and nothing else. A local `|| someExcuse` appended
    // to this line would compile and would not fail any core test.
    assert.match(
      CODE,
      /if \(outcome\.blocks\) allReady = false;/,
      "allReady must be driven by judgeFieldGateOutcome's `blocks`, with no " +
        "local softener appended at the call site",
    );
    // …and the exemption must keep being asked the SAFE question. The judge can
    // only be as narrow as its inputs: `incumbentValuesSeen` is what separates
    // "the column is NEW" from "the writer CANNOT FILL a column the vendor
    // populated", and a call site passing 0, or passing `v.incomparable`, would
    // widen the exemption without touching the tested function at all.
    assert.match(
      CODE,
      /incumbentValuesSeen: incumbentSeen\.get\(field\) \?\? 0,/,
      "the exemption must be handed the COUNTED incumbent values",
    );
    // And exactly one call site may apply it.
    assert.equal(
      (CODE.match(/judgeFieldGateOutcome\(/g) ?? []).length,
      1,
      "judgeFieldGateOutcome must be called exactly once — a second call site " +
        "is a second place the exemption can be applied",
    );
    // The conjunct that makes the exemption safe rather than merely narrow —
    // MONEY-1250. `incomparable` means ONE SIDE was empty and does not say
    // which, so without an explicit incumbent census this exempts the shape
    // where OUR side is the empty one and every write nulls a populated vendor
    // value — while printing that there is nothing to destroy.
    assert.match(
      CODE,
      /incumbentSeen/,
      "the exemption must COUNT incumbent values, not infer them from incomparable",
    );
    assert.match(
      CODE,
      /if \(c\.theirs !== undefined\)\s*\n?\s*incumbentSeen\.set\(/,
      "incumbentSeen must be populated from the incumbent side of graded pairs",
    );
    // Nothing may ever put `allReady` BACK to true. The other three
    // `allReady = false` sites in this file (exclusion-drained, contaminated,
    // standalone-mirror-diverged) only ever tighten, so the per-field line above
    // is the sole path that can spare a field — and a re-enable anywhere would
    // silently undo all four.
    assert.equal(
      (CODE.match(/allReady = true/g) ?? []).length,
      1,
      "allReady is re-enabled somewhere — a block must not be undoable",
    );
    assert.match(
      CODE,
      /let allReady = true;/,
      "the single `allReady = true` should be its declaration",
    );
  });

  it("prints the bucket whenever there is one to print", () => {
    // The guard, not just the sentence. `if (false && ...)` leaves every string
    // in the file and deletes the report — the mutation that escaped every
    // string assertion in the sibling suite.
    assert.match(CODE, /if \(t\.translated > 0 \|\| t\.unavailable > 0\) \{/);
  });
});

describe("MONEY-1239 — an untestable pair is not a failed one", () => {
  it("counts translationUnavailable when the filing discloses no otherIncome", () => {
    // "Couldn't determine" gets its own value — the standing rule this repo
    // learned from caching a fail-open default. Only reached when nothing else
    // resolved the pair, so the bucket means "still disagrees AND could not be
    // tested" rather than overlapping the translated count.
    assert.match(
      CODE,
      /!translated &&\s*OTHER_INCOME_TRANSLATED\.has\(field\) &&\s*otherIncome === undefined\s*\)\s*\{\s*translationUnavailable = true;/,
    );
    assert.match(CODE, /if \(c\.translationUnavailable\) t\.unavailable\+\+;/);
    assert.match(CODE, /COULD NOT BE TESTED/);
  });

  it("leaves those pairs counted as disagreements", () => {
    // Absence of evidence is not a match. `translated` is what upgrades the
    // verdict to MATCH, so the flag must never set it — and the way to pin that
    // is to pin where the ONE assignment lives, not to search for a second one
    // near the flag. (The first version of this case did the latter with
    // `/translationUnavailable[^;]*translated = true/`, which cannot cross the
    // semicolon that ends the flag's own statement: it could never match, so it
    // survived the mutation that added exactly that line. Bounded and counted
    // instead.)
    assert.equal(
      (CODE.match(/\btranslated = true;/g) ?? []).length,
      1,
      "`translated` must be set in exactly one place — the alternatives loop",
    );
    assert.match(CODE, /r = alt;\s*translated = true;/);
  });
});

describe("MONEY-1239 — the ladder's ordering survives", () => {
  it("SCALE still pre-empts every translation", () => {
    // A power-of-ten gap is a units bug and must never be laundered by trying a
    // different quantity until one lands. Scoped to the translation gate's own
    // variable, as the sibling suite does.
    assert.doesNotMatch(CODE, /r\.verdict === "SCALE_MISMATCH"/);
    assert.match(
      CODE,
      /r\.verdict === "DISAGREEMENT" \|\| r\.verdict === "SIGN_MISMATCH"/,
    );
  });

  it("a translation must produce a real MATCH at the same tolerance", () => {
    // The whole guard against this becoming a blanket excuse: the alternative
    // is put through the SAME `reconcile` with the SAME absolute epsilon. A
    // looser second comparison here would be a widened tolerance hiding inside
    // a translation.
    assert.match(
      CODE,
      /const alt = reconcile\(candidate\.value, theirs, \{\s*absoluteEpsilon: ABSOLUTE_EPSILON_CR,\s*\}\);/,
    );
    assert.match(CODE, /if \(alt\.verdict === "MATCH"\) \{/);
  });
});

describe("MONEY-1239 — the vendor's EBITDA is RAW, and the gate says so", () => {
  // Caught by MEASUREMENT, not review. `projectFinancials` started removing
  // exceptional items from `ebitda` (a -30,711 Cr AGR provision was turning a
  // +8,928 Cr EBITDA into -21,783 — a sign flip feeding `ebitdaMargin` at
  // -103%). Re-running the gate against prod immediately after showed the
  // ebitda disagreement rate going 24.0% -> 40.4%, with `matched` falling
  // 108 -> 86: 22 filings that had agreed no longer did.
  //
  // The cause was not the writer. `ebitdaRaw` inside the gate is recomputed
  // from the FACTS, so the pre-existing `EBITDA - exceptional` candidate was
  // offering the ADJUSTED figure as a guess at THEIRS — true only ~20% of the
  // time. 3IINFOLTD FY2024 is the clean read: theirs is -262.02, which is
  // exactly PBT(-299) + interest(10) + depreciation(27). The vendor carries the
  // exceptional item.
  //
  // So the missing candidate was the other direction — our adjusted value put
  // back to raw. Declared rather than reverted in the writer, for the same
  // reason as the other-income axis: our number is the analytically defensible
  // one, and the gate's job is to state how the vendor's differs.
  it("offers `ours + exceptionalItems` as an ebitda candidate", () => {
    const at = CODE.indexOf('label: "ours + exceptional');
    assert.notEqual(at, -1, "the raw-EBITDA translation is missing");
    assert.match(
      CODE.slice(at, at + 200),
      /value:\s*ours \+ exceptionalItems/,
      "must reconstruct THEIR raw figure from OURS plus the filing's own " +
        "exceptional item — never a fitted constant",
    );
  });

  it("keeps the opposite candidate too — the vendor is not consistent", () => {
    // ~20% of the time the vendor DOES exclude the exceptional item, which is
    // why both directions have to stay on the list. Dropping either one
    // reopens a bucket of disagreements that are definitional, not defects.
    assert.match(CODE, /label: "EBITDA - exceptional"/);
  });
});

describe("MONEY-1239 — INCUMBENT-NULLING, which the ladder cannot see", () => {
  it("counts pairs where a populated incumbent would be nulled — FIELD-aware", () => {
    // MONEY-1239: `wouldWrite` says the STATEMENT is written, not that this
    // COLUMN is. A lender does not own `operatingIncome` or `ebitda`, so the
    // write never mentions them and nothing is lost — counting those would
    // report a loss that no longer happens, in the one block that exists
    // BECAUSE the ladder cannot see this class.
    // `projectedValues` emits null for every OWNED field the projection could
    // not fill, so an UPDATE with an absent value REPLACES the vendor's number
    // with an empty cell. That pair scores INCOMPARABLE, which is outside the
    // disagreement rate by design (MONEY-1196) — so no rate moves, nothing
    // blocks, and the loss is invisible until after the one-way door.
    assert.match(
      CODE,
      // `writerSkip`, NOT `excluded` — MONEY-1255. The ladder's `excluded` now
      // also carries SYMBOL exclusions, which are NOT writer refusals: the
      // writer still writes those rows, so they still destroy the incumbent
      // value this block exists to count. Keying it on `excluded` would have
      // silently stopped counting incumbent destruction for exactly the four
      // symbols already known to be wrong.
      /const nullsIncumbent =\s*ours === undefined &&\s*theirs !== undefined &&\s*writerSkip === undefined &&\s*wouldWrite\.has\(statementOf\(field\)\) &&\s*\(writable as readonly string\[\]\)\.includes\(field\);/,
    );
  });

  it("requires an actual write, not merely the absence of a skip", () => {
    // `!skipOf.has(...)` is a DIFFERENT set and would overcount. When
    // `projectFinancials` returns `income: null` the statement never reaches
    // `planFinancialsWrite`: no plan, no skip reason, no `excluded` tag — and
    // no write either, so the incumbent survives untouched.
    assert.match(
      CODE,
      /\} else if \(plan\.action !== "SKIP"\) \{\s*wouldWrite\.add\(statement\.statementType\);/,
    );
  });

  it("prints the headline unconditionally, zero included", () => {
    // "No line" and "0 pairs" have to be different states — the same lesson the
    // scoped-sibling lines record. A diagnostic that only appears when it is
    // bad is missing from exactly the clean run someone uses to decide READY.
    assert.match(
      CODE,
      /const nulling = graded\.filter\(\(c\) => c\.nullsIncumbent === true\);\s*\n\s*log\.info\(""\);\s*\n\s*log\.info\(\s*`INCUMBENT-NULLING: \$\{nulling\.length\}/,
    );
  });

  it("names the lender cause and the ratio that follows the column", () => {
    // `operatingIncome` needs `operatingProfitBeforeProvisions` for a lender —
    // 76 of 741 banking and 0 of 206 NBFC ANNUAL filings on prod — and
    // `StockRatios.operatingMargin` reads this column, so those symbols lose
    // the margin too. A bare count would not tell the founder what they are
    // trading away.
    assert.match(CODE, /operatingProfitBeforeProvisions/);
    assert.match(CODE, /StockRatios\.operatingMargin/);
  });

  it("travels with the VERDICT line instead of scrolling off", () => {
    // Declaration plus BOTH verdict branches. A warn hundreds of lines earlier
    // is inert — the reader sees the verdict — and this must be visible whether
    // the run reads READY or BLOCKED.
    assert.equal(
      (CODE.match(/nullingNote/g) ?? []).length,
      3,
      "nullingNote must be declared and appended to both verdict branches",
    );
  });
});

describe("MONEY-1239 — the arithmetic premise, against the real functions", () => {
  // Behavioural, not structural. These call the exported `reconcile` and
  // `judgeSwitchoverReadiness` the script calls, with the script's own absolute
  // epsilon, so a change to either that invalidated the translation would fail
  // here rather than silently change what the gate means.
  const EPS = { absoluteEpsilon: 0.5 };

  it("the other-income gap is what separates the two sources", () => {
    // 3MINDIA-shaped: revenue from operations, other income, and the vendor's
    // TOTAL INCOME. Raw, they disagree; translated, they are the same figure.
    const oursRevenue = 1000;
    const otherIncome = 60;
    const theirsTotalIncome = 1060;
    assert.equal(
      reconcile(oursRevenue, theirsTotalIncome, EPS).verdict,
      "DISAGREEMENT",
    );
    assert.equal(
      reconcile(oursRevenue + otherIncome, theirsTotalIncome, EPS).verdict,
      "MATCH",
    );
  });

  it("does not rescue a pair that is genuinely wrong", () => {
    // The translation is not a licence. A vendor value that matches neither the
    // raw figure nor the reconstructed one keeps disagreeing, which is the only
    // reason the bucket is safe to count as a match at all.
    const ours = 1000;
    const otherIncome = 60;
    const theirsWrong = 1450;
    assert.equal(reconcile(ours, theirsWrong, EPS).verdict, "DISAGREEMENT");
    assert.equal(
      reconcile(ours + otherIncome, theirsWrong, EPS).verdict,
      "DISAGREEMENT",
    );
  });

  it("a units bug is still SCALE, and translating it does not help", () => {
    // Ordering, measured rather than asserted about: the primary comparison
    // returns SCALE_MISMATCH and the script never reaches the candidates for
    // it. Even if it did, `ours + otherIncome` lands nowhere near a 100x gap.
    const ours = 1000;
    const otherIncome = 60;
    const theirsScaled = 100000;
    assert.equal(reconcile(ours, theirsScaled, EPS).verdict, "SCALE_MISMATCH");
    assert.equal(
      reconcile(ours + otherIncome, theirsScaled, EPS).verdict,
      "DISAGREEMENT",
    );
  });

  it("the two reported rates can genuinely disagree about READY", () => {
    // The reason both numbers are printed. Same judge, same defaults, one
    // population: 84 definitional matches decide the verdict on their own.
    const withTranslations: ReconcileVerdict[] = [
      ...Array<ReconcileVerdict>(130).fill("MATCH"),
      ...Array<ReconcileVerdict>(84).fill("MATCH"),
      ...Array<ReconcileVerdict>(2).fill("DISAGREEMENT"),
    ];
    const withoutTranslations: ReconcileVerdict[] = [
      ...Array<ReconcileVerdict>(130).fill("MATCH"),
      ...Array<ReconcileVerdict>(84).fill("DISAGREEMENT"),
      ...Array<ReconcileVerdict>(2).fill("DISAGREEMENT"),
    ];
    assert.equal(judgeSwitchoverReadiness(withTranslations).ready, true);
    assert.equal(judgeSwitchoverReadiness(withoutTranslations).ready, false);
  });

  it("an absent projected value scores INCOMPARABLE, never DISAGREEMENT", () => {
    // Why INCUMBENT-NULLING needs its own count: this is the verdict a bank's
    // missing `operatingIncome` produces against a populated vendor value, and
    // INCOMPARABLE is outside the rate's denominator by design. The ladder
    // cannot express the loss, so something else has to.
    assert.equal(reconcile(undefined, 812.4, EPS).verdict, "INCOMPARABLE");
    const padded: ReconcileVerdict[] = [
      ...Array<ReconcileVerdict>(25).fill("MATCH"),
      ...Array<ReconcileVerdict>(300).fill("INCOMPARABLE"),
    ];
    assert.equal(judgeSwitchoverReadiness(padded).ready, true);
  });
});
