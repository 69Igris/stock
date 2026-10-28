/**
 * The ratios gate must READ the incumbent's provenance, not merely select it —
 * MONEY-1237.
 *
 * ## The defect
 *
 * `scripts/data/xbrl-ratios-validate.ts` put `source: true` in its
 * `stock_ratios` select and typed it in the incumbent shape, and those were the
 * only two occurrences of `source` in the file. Nothing ever compared it to
 * anything.
 *
 * `StockRatios` is `@@unique([symbol, exchange])` with no `source` in the key,
 * so the first XBRL write for a symbol overwrites the vendor row and keeps no
 * history of it. `XBRL_PROJECTION_APPLY` arms BOTH the projection and the ratios
 * job, so the two most likely ways to run this gate — flip it in QA to try it,
 * or re-run on prod after arming to "confirm it worked" — both hand it
 * incumbents already stamped `NSE_XBRL`. `roe` is the only ratio with real
 * vendor coverage (2,038 of 2,135 rows on prod 2026-08-21, against 0 / 86 / 85 /
 * 86 for operatingMargin / netMargin / roa / debtToEquity), so a contaminated
 * `roe` matched ITSELF 100%, read READY, and `judgeRatiosGate` passed the run on
 * one READY plus four UNVERIFIABLE. The switchover would have been evidenced by
 * XBRL against XBRL.
 *
 * ## Why this is a SOURCE-TEXT test
 *
 * The script needs a database, and the same pattern is already used for this
 * gate's sibling in `reconcile-gate-population.test.ts`. The JUDGEMENT is pure
 * and unit-tested next door in `xbrl-ratios-gate.test.ts`; what cannot be
 * reached without Atlas is the WIRING — and the wiring is exactly what failed.
 * Each assertion below pins a way the fix can silently revert to the defect
 * while every other test stays green.
 *
 * The nastiest of those is the `select`. Drop `source: true` from the query and
 * `incumbent.source` is `undefined` on every row, so `=== XBRL_SOURCE` is
 * permanently false, every contaminated pair reports as clean, and the gate goes
 * straight back to certifying itself — with no error, no warning, and a
 * comparison count that looks exactly right.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** LINE comments before BLOCK comments — MONEY-1143. */
const strip = (src: string): string =>
  src.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const RATIOS = strip(
  readFileSync(join(ROOT, "scripts/data/xbrl-ratios-validate.ts"), "utf8"),
);

describe("xbrl-ratios-validate reads the incumbent's provenance", () => {
  it("compares `source` against the writer's own constant", () => {
    // The read that was missing. Compared against the imported `XBRL_SOURCE`
    // rather than a literal, so the gate and `xbrl-projection-writer.ts` cannot
    // drift into two spellings of one source — a drift under which this check
    // passes everything.
    assert.match(RATIOS, /incumbent\.source\s*===\s*XBRL_SOURCE/);
    assert.match(RATIOS, /XBRL_SOURCE\s*,/);
    assert.match(RATIOS, /from "@usemoney\/core\/market-data"/);
    assert.doesNotMatch(RATIOS, /["']NSE_XBRL["']/);
  });

  it("still SELECTS `source`, or the read is `undefined` forever", () => {
    // The silent revert. Without this column the comparison above is always
    // false: every contaminated pair reports clean, the gate certifies itself,
    // and nothing anywhere errors.
    const select = RATIOS.slice(
      RATIOS.indexOf("prisma.stockRatios.findMany"),
      RATIOS.indexOf("prisma.stockRatios.findMany") + 600,
    );
    assert.notEqual(select, "");
    assert.match(select, /source:\s*true/);
  });

  it("feeds BOTH self-comparison counts to the pure judgement", () => {
    // The ladder is not decided in the script. If it stops passing these, the
    // module's defaults do not rescue it — the fields are required precisely so
    // that omitting them is a compile error rather than a silent "clean".
    assert.match(RATIOS, /judgeRatioReadiness\(\{/);
    assert.match(RATIOS, /\bselfComparisons\s*,/);
    assert.match(RATIOS, /\bselfMatched\s*,/);
  });

  it("tallies self-comparisons over COMPARABLE pairs, never over all rows", () => {
    // `judgeRatioReadiness` subtracts these from `comparable`. An INCOMPARABLE
    // pair is already outside both sides of that fraction, so tallying over
    // `rows` would over-subtract and drain the denominator — the MONEY-1196
    // shape, reintroduced by counting the wrong population.
    assert.match(RATIOS, /const selfComparisons\s*=\s*comparable\.filter\(/);
    assert.match(RATIOS, /const selfMatched\s*=\s*comparable\.filter\(/);
    assert.doesNotMatch(RATIOS, /const selfComparisons\s*=\s*rows\.filter\(/);
    assert.doesNotMatch(RATIOS, /const selfMatched\s*=\s*rows\.filter\(/);
  });

  it("reports the count before the ladder, at warn level", () => {
    // A number nobody prints is a number nobody acts on. The count decides
    // whether any per-ratio line below it can be believed, so it is emitted
    // ahead of them and on the warn channel.
    assert.match(RATIOS, /if \(xbrlIncumbentRows > 0\)/);
    assert.match(RATIOS, /log\.warn\(/);
  });

  it("prints the module's own `reason` rather than re-deriving one", () => {
    // The script used to branch on `verdict === "UNVERIFIABLE"` and print "NO
    // VENDOR DATA". That was a second copy of the ladder, and a third cause of
    // UNVERIFIABLE — a contaminated population — made the copy actively wrong:
    // a self-comparison drain would have printed "the incumbent has this ratio
    // on 0 rows", the opposite of what happened.
    assert.match(RATIOS, /judgement\.reason/);
    assert.doesNotMatch(RATIOS, /NO VENDOR DATA/);
  });
});

/**
 * The DECLARED divergence must actually reach the judgement — MONEY-1250.
 *
 * Same class of exposure as the `source: true` select above: the ladder now has
 * a `DECLARED_DIVERGENCE` rung, and it is reachable only if the script both
 * DECLARES the ratio and PASSES the declaration through. Drop either half and
 * `debtToEquity` silently returns to being graded — scored 71.4% against a
 * vendor column that includes Ind-AS 116 lease liabilities where ours does not
 * — with every other test in the repo still green.
 *
 * These are source-text assertions for the same reason the ones above are: the
 * script needs Atlas, the judgement is unit-tested next door, and the WIRING is
 * the part that has historically broken.
 */
describe("scripts/data/xbrl-ratios-validate.ts — the declared divergence is wired", () => {
  /**
   * The map's own text, sliced from its declaration.
   *
   * SCOPED, not a whole-file match. A bare `/debtToEquity:/` over the file
   * passes as long as the object literal exists ANYWHERE — including when it
   * has been detached from `DECLARED_DIVERGENCES` and left bound to some other
   * name, which is precisely the silent-revert shape these tests exist to
   * catch. Found by mutation-testing this assertion: the unscoped version
   * survived having the map replaced with `{}`.
   */
  const declBlock = (): string => {
    const m = /const DECLARED_DIVERGENCES\b[^=]*=\s*\{/.exec(RATIOS);
    if (m === null) return "";
    const from = m.index + m[0].length;
    // BRACE-BALANCED to this object's OWN closing brace — not a character
    // budget and not "the next `};`". Both of those keep matching after the map
    // has been emptied to `= {}` and its entries rebound to another name: the
    // literal simply sits a few lines further down and lands inside the window.
    // Two earlier drafts of this assertion survived exactly that mutation,
    // which is the whole reason this helper is not a one-liner.
    let depth = 1;
    for (let i = from; i < RATIOS.length; i++) {
      const c = RATIOS[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return RATIOS.slice(from, i);
      }
    }
    return "";
  };

  it("DECLARES debtToEquity, or the gate grades a definitional gap as accuracy", () => {
    assert.match(RATIOS, /const DECLARED_DIVERGENCES/);
    const decl = declBlock();
    assert.notEqual(
      decl,
      "",
      "DECLARED_DIVERGENCES is no longer an object literal",
    );
    assert.match(decl, /^\s*debtToEquity:/m);
  });

  it("PASSES the declaration to judgeRatioReadiness", () => {
    // The rung cannot fire on a declaration the judgement never receives. The
    // field is OPTIONAL on the input — deliberately, since absence must mean
    // "grade it" — so omitting it here is NOT a compile error, which is exactly
    // why it needs pinning.
    assert.match(RATIOS, /declaredDivergence:\s*DECLARED_DIVERGENCES\[/);
  });

  it("the declaration states its MECHANISM, not just that one exists", () => {
    // A declaration reduced to "known difference" is indistinguishable from a
    // suppression. The evidence has to be legible at the point of use, and it
    // is printed verbatim in the report.
    assert.match(RATIOS, /lease/i);
    assert.match(RATIOS, /Ind-AS 116/);
  });

  it("does not declare every ratio — a blanket declaration is an off switch", () => {
    // `roe` is the one ratio with real vendor coverage and the only thing this
    // gate can currently verify. Declaring it would make the run unfailable
    // while proving nothing, which is the MONEY-1220 shape in gate form.
    const decl = declBlock();
    assert.notEqual(decl, "");
    assert.doesNotMatch(decl, /^\s*roe:/m);
    assert.doesNotMatch(decl, /^\s*netMargin:/m);
    assert.doesNotMatch(decl, /^\s*operatingMargin:/m);
    assert.doesNotMatch(decl, /^\s*roa:/m);
  });
});

/**
 * MONEY-1401 — three more ways this gate can silently stop asking its own
 * questions. All source-text, for the reason the header already gives: the
 * JUDGEMENT is pure and unit-tested next door, and what needs Atlas is the
 * WIRING, which is what failed.
 */
describe("xbrl-ratios-validate asks the questions it claims to", () => {
  /** The whole `prisma.stockRatios.findMany({...})` call, comments removed. */
  const incumbentQuery = (() => {
    const at = RATIOS.indexOf("prisma.stockRatios.findMany");
    assert.notEqual(at, -1);
    const end = RATIOS.indexOf("});", at);
    assert.notEqual(end, -1);
    return RATIOS.slice(at, end);
  })();

  /** The members of the script's own `RATIOS` array. */
  const ratioNames = (() => {
    const at = RATIOS.indexOf("const RATIOS = [");
    assert.notEqual(at, -1);
    const end = RATIOS.indexOf("] as const;", at);
    assert.notEqual(end, -1);
    const names = [...RATIOS.slice(at, end).matchAll(/"([A-Za-z]+)"/g)].map(
      (m) => m[1],
    );
    // A sanity floor: if the extraction broke, the assertions below would pass
    // vacuously over an empty list — which is the defect class this whole file
    // exists for, one layer up.
    assert.ok(names.length >= 5, `parsed ${names.length} ratio name(s)`);
    assert.ok(names.includes("roce"));
    return names;
  })();

  it("DERIVES the incumbent select from RATIOS, so the two cannot drift", () => {
    // THE DEFECT. `RATIOS` listed "roce" and the select did not, so the gate
    // compared 1,704 derived values against `undefined` and printed "no vendor
    // data at all" over a column the vendor fills on 2,118 of 2,135 rows. It
    // read PASS for months on what was really one graded ratio.
    //
    // MUTATION: replace the spread with the old hardcoded list and BOTH
    // assertions below go red — the first on the missing derivation, the
    // second on the re-hardcoded names.
    assert.match(
      incumbentQuery,
      /\.\.\.Object\.fromEntries\(\s*RATIOS\.map\(/,
      "the select must be spread from RATIOS, not listed",
    );
    for (const name of ratioNames) {
      assert.doesNotMatch(
        incumbentQuery,
        new RegExp(`\\b${name}:\\s*true`),
        `"${name}" is hardcoded in the select — a second list to keep in sync`,
      );
    }
  });

  it("hands the RUN-LEVEL rungs to the pure judgement", () => {
    // `judgeRatiosGate`'s context parameter is OPTIONAL so the pure unit tests
    // can exercise one rung at a time. That makes the PRODUCTION call site the
    // only thing standing between "measured" and "silently not measured", and
    // an un-passed context prints "NOT MEASURED" rather than failing.
    //
    // MUTATION: drop the second argument and this goes red.
    assert.match(RATIOS, /judgeRatiosGate\(gateJudgements,\s*context\)/);
    assert.match(RATIOS, /const context: RatiosRunContext = \{/);
    assert.match(RATIOS, /cannotGrade:\s*\{\s*count:/);
  });

  it("checks the identity against the FILED liabilities, not a derived one", () => {
    // THE VACUOUS-CHECK TRAP, caught before this shipped.
    // `projectFinancials` fills `balanceSheet.totalLiabilities` as
    // `num(v,"totalLiabilities") ?? totalAssets - totalEquity`, so feeding it
    // its own answer makes |L + E - A| EXACTLY ZERO by construction. The first
    // wiring did that and scored 1,736 of 1,736 — a check that cannot fail,
    // reading as the strongest line in the report.
    //
    // MUTATION: pass `projected.balanceSheet?.totalLiabilities` and this goes
    // red on both assertions.
    assert.match(RATIOS, /values\.totalLiabilities/);
    assert.doesNotMatch(
      RATIOS,
      /projected\.balanceSheet\?\.totalLiabilities/,
      "the projection's totalLiabilities makes the identity a tautology",
    );
  });
});
