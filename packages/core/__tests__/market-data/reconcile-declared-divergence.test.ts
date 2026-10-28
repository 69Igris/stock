/**
 * The F3 gate's two ways of NOT BLOCKING on something real — MONEY-1255.
 *
 * Both are founder decisions taken in front of a ONE-WAY DOOR (`StockFinancials`
 * has no `source` in its unique key, so the first XBRL write for a period
 * destroys the value it replaced), and both are one careless edit away from
 * being a way to turn a red gate green:
 *
 *   DECLARED DIVERGENCE  a FIELD whose two sides are different QUANTITIES.
 *                        `totalDebt`: ours is the filing's own funding lines,
 *                        the vendor's adds Ind-AS 116 lease liabilities, and
 *                        the integrated-filing taxonomy publishes no
 *                        lease-liability BALANCE element to parse. Grades
 *                        DECLARED — neither a pass nor a block.
 *   SYMBOL EXCLUSION     four symbols removed from the population outright.
 *                        Different in KIND from every other exclusion in that
 *                        gate: the writer WILL still write these rows.
 *
 * What keeps each honest is a property, and each property is pinned here:
 *
 *  - the VERDICT ORDERING is a function, not the order three `if`s happen to be
 *    written in (`judgeFieldGateOutcome`);
 *  - a declared field still reports a full census, and says so when this run
 *    exercised nothing (`declarationUntested`);
 *  - the UNVERIFIABLE exemption still refuses the one shape that destroys data
 *    — our side blank, theirs populated — which is what separates it from the
 *    draining denominator of MONEY-1196;
 *  - a symbol exclusion is ACCOUNTED FOR EVEN AT ZERO (`tallySymbolExclusions`
 *    seeds from the declared list, never from the rows), because the entry that
 *    removed nothing is the one a reader needs to see.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  judgeFieldGateOutcome,
  tallySymbolExclusions,
  type ReconcileVerdict,
} from "../../src/market-data/xbrl-projection";

/* -------------------------------------------------------------------------- */
/* judgeFieldGateOutcome                                                      */
/* -------------------------------------------------------------------------- */

/** A comfortably graded field: plenty comparable, plenty of incumbent values. */
const GRADED = {
  comparable: 400,
  incomparable: 50,
  incumbentValuesSeen: 400,
} as const;

describe("judgeFieldGateOutcome — the four verdicts and their ORDERING", () => {
  it("a graded field that cleared the ladder reads READY and does not block", () => {
    const o = judgeFieldGateOutcome({
      ...GRADED,
      ready: true,
      declared: false,
    });
    assert.equal(o.verdict, "READY");
    assert.equal(o.blocks, false);
    assert.equal(o.declarationUntested, undefined);
  });

  it("a graded field the ladder faulted BLOCKS — the only verdict that does", () => {
    // The whole point of the gate. If this ever stops blocking, the switchover
    // can be armed over a field with measured disagreements.
    const o = judgeFieldGateOutcome({
      ...GRADED,
      ready: false,
      declared: false,
    });
    assert.equal(o.verdict, "BLOCKED");
    assert.equal(o.blocks, true);
  });

  it("a column the vendor never populated is UNVERIFIABLE, not BLOCKED", () => {
    // MONEY-1250. `otherIncome` reads `comparable 0 of 4032` because
    // `stock_financials` holds no vendor value for it AT ALL. Graded BLOCKED
    // that is a floor no amount of work can clear, and the gate's premise does
    // not apply: where there is no incumbent there is nothing to destroy.
    const o = judgeFieldGateOutcome({
      comparable: 0,
      incomparable: 4032,
      incumbentValuesSeen: 0,
      ready: false,
      declared: false,
    });
    assert.equal(o.verdict, "UNVERIFIABLE");
    assert.equal(o.blocks, false);
  });

  it("ONE incumbent value is enough to keep BLOCKED — the shape that destroys data", () => {
    // The conjunct that is load-bearing, and the reason `incomparable > 0` is
    // NOT it. INCOMPARABLE says one side was empty and does not say which:
    //
    //     ours present, theirs absent   the column is NEW      -> safe to exempt
    //     ours ABSENT,  theirs present  the writer CANNOT FILL -> destroys data
    //
    // The second shape walks through the door — every write puts an explicit
    // NULL over a populated vendor value — while the gate prints "nothing for
    // the write to destroy". Reachable without a bug, because the gate's FIELDS
    // list is derived from the writer's ownership: add a column to ownership
    // before the projection can fill it and this would exempt it silently.
    const o = judgeFieldGateOutcome({
      comparable: 0,
      incomparable: 4032,
      incumbentValuesSeen: 1,
      ready: false,
      declared: false,
    });
    assert.equal(o.verdict, "BLOCKED");
    assert.equal(o.blocks, true);
  });

  it("a comparable field is NEVER exempted, however few pairs it has", () => {
    // `comparable === 0` is the first conjunct and it must stay strict. A field
    // with even one comparable pair has a sampling problem, not an absent
    // vendor — and exempting it is MONEY-1196's draining denominator under a
    // third name.
    const o = judgeFieldGateOutcome({
      comparable: 1,
      incomparable: 4000,
      incumbentValuesSeen: 0,
      ready: false,
      declared: false,
    });
    assert.equal(o.verdict, "BLOCKED");
    assert.equal(o.blocks, true);
  });

  it("DECLARED does not block, even on a field the ladder faulted — D2", () => {
    // The mechanism the ticket asks for, stated at its strongest: `totalDebt`
    // disagrees with the vendor on ~58% of comparable pairs and must not hold
    // the door, because the two sides are not the same quantity.
    const o = judgeFieldGateOutcome({
      ...GRADED,
      ready: false,
      declared: true,
    });
    assert.equal(o.verdict, "DECLARED");
    assert.equal(o.blocks, false);
  });

  it("DECLARED outranks READY — a declared field is not graded at all", () => {
    // Not cosmetic. A declared field printing READY would be a claim of
    // agreement about two columns we have just said are different quantities,
    // and would let the field count as evidence FOR arming.
    const o = judgeFieldGateOutcome({
      ...GRADED,
      ready: true,
      declared: true,
    });
    assert.equal(o.verdict, "DECLARED");
  });

  it("DECLARED outranks UNVERIFIABLE, and says the declaration was UNTESTED", () => {
    // The ordering AND its honesty clause in one case. A declaration asserts a
    // MEASURED gap; with zero comparable pairs this run measured none, so the
    // printed evidence is history rather than a finding and the report must say
    // so. Without the flag a reader sees an evidence paragraph full of numbers
    // and no indication that none of them came from this run.
    const o = judgeFieldGateOutcome({
      comparable: 0,
      incomparable: 900,
      incumbentValuesSeen: 0,
      ready: false,
      declared: true,
    });
    assert.equal(o.verdict, "DECLARED");
    assert.equal(o.blocks, false);
    assert.equal(o.declarationUntested, true);
  });

  it("an EXERCISED declaration carries no untested flag", () => {
    // The other half — otherwise the flag is a constant, which is the same as
    // no flag.
    const o = judgeFieldGateOutcome({
      ...GRADED,
      ready: false,
      declared: true,
    });
    assert.equal(o.declarationUntested, undefined);
  });

  it("UNVERIFIABLE outranks BLOCKED — the readiness floor must not win", () => {
    // `judgeSwitchoverReadiness` returns `ready: false` for ANY field under its
    // 20-pair comparable floor, including a field with no possible comparisons.
    // If BLOCKED were checked first, the exemption would be unreachable.
    const o = judgeFieldGateOutcome({
      comparable: 0,
      incomparable: 7,
      incumbentValuesSeen: 0,
      ready: false,
      declared: false,
    });
    assert.equal(o.verdict, "UNVERIFIABLE");
  });

  it("an all-blank field with no incomparable pairs at all still BLOCKS", () => {
    // The vacuity guard on the exemption itself. `comparable 0, incomparable 0`
    // is a field with NO pairs whatsoever — a broken join, not a new column —
    // and exempting it would let a gate pass on a population it never loaded.
    const o = judgeFieldGateOutcome({
      comparable: 0,
      incomparable: 0,
      incumbentValuesSeen: 0,
      ready: false,
      declared: false,
    });
    assert.equal(o.verdict, "BLOCKED");
    assert.equal(o.blocks, true);
  });

  it("blocks ONLY on BLOCKED, across every combination", () => {
    // Exhaustive rather than illustrative: `blocks` is what `allReady` reads,
    // so a verdict that silently starts blocking (or stops) is the whole gate
    // changing behaviour.
    for (const declared of [false, true]) {
      for (const ready of [false, true]) {
        for (const [comparable, incomparable, seen] of [
          [400, 50, 400],
          [0, 900, 0],
          [0, 900, 3],
          [0, 0, 0],
        ] as const) {
          const o = judgeFieldGateOutcome({
            ready,
            comparable,
            incomparable,
            incumbentValuesSeen: seen,
            declared,
          });
          assert.equal(
            o.blocks,
            o.verdict === "BLOCKED",
            `blocks disagreed with verdict ${o.verdict} for ` +
              `declared=${declared} ready=${ready} c=${comparable} ` +
              `i=${incomparable} seen=${seen}`,
          );
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* tallySymbolExclusions                                                      */
/* -------------------------------------------------------------------------- */

const row = (
  symbol: string,
  field: string,
  verdict: ReconcileVerdict,
): { symbol: string; field: string; verdict: ReconcileVerdict } => ({
  symbol,
  field,
  verdict,
});

describe("tallySymbolExclusions — a silent exclusion is how a gate lies", () => {
  it("gives EVERY declared symbol a row, including the ones that removed NOTHING", () => {
    // THE PROPERTY THIS FUNCTION EXISTS FOR. On the prod run of 2026-08-26,
    // MODIRUBBER and OPTIEMUS carry the only two surviving SIGN_MISMATCH rows
    // on the whole ladder, while CENTUM and DVL appear NOWHERE in the
    // financials reconcile — their two sign mismatches are in the SIBLING
    // ratios gate, on `roe`. A tally seeded from the ROWS would have printed
    // two symbols and let the other two look equally load-bearing.
    const t = tallySymbolExclusions(
      [row("MODIRUBBER", "operatingIncomeExOtherIncome", "SIGN_MISMATCH")],
      ["MODIRUBBER", "OPTIEMUS", "CENTUM", "DVL"],
    );
    assert.equal(t.length, 4);
    assert.deepEqual(
      t.map((x) => x.symbol),
      ["MODIRUBBER", "OPTIEMUS", "CENTUM", "DVL"],
      "order must follow the DECLARATION so the block reads in list order",
    );
    assert.deepEqual(
      t.filter((x) => x.total === 0).map((x) => x.symbol),
      ["OPTIEMUS", "CENTUM", "DVL"],
    );
  });

  it("buckets each verdict, and COMPARABLE excludes the blanks", () => {
    // Same rule as the ladder's own denominator: a pair with a blank on one
    // side was never in the rate, so counting it as a removal would overstate
    // what the exclusion cost.
    const t = tallySymbolExclusions(
      [
        row("MODIRUBBER", "revenueFromOperations", "SCALE_MISMATCH"),
        row("MODIRUBBER", "operatingIncomeExOtherIncome", "SIGN_MISMATCH"),
        row("MODIRUBBER", "netIncome", "DISAGREEMENT"),
        row("MODIRUBBER", "totalAssets", "MATCH"),
        row("MODIRUBBER", "totalCash", "INCOMPARABLE"),
        row("MODIRUBBER", "totalDebt", "INCOMPARABLE"),
      ],
      ["MODIRUBBER"],
    );
    const m = t[0];
    assert.ok(m);
    assert.equal(m.total, 6);
    assert.equal(m.comparable, 4);
    assert.equal(m.scale, 1);
    assert.equal(m.sign, 1);
    assert.equal(m.disagree, 1);
    assert.equal(m.matched, 1);
    assert.equal(m.incomparable, 2);
  });

  it("names the columns it touched, sorted and deduped", () => {
    // The claim has to be checkable PER COLUMN — "removed 4" says nothing about
    // whether the blocker it was listed for is among them.
    const t = tallySymbolExclusions(
      [
        row("OPTIEMUS", "netIncome", "DISAGREEMENT"),
        row("OPTIEMUS", "operatingIncomeExOtherIncome", "SIGN_MISMATCH"),
        row("OPTIEMUS", "netIncome", "DISAGREEMENT"),
      ],
      ["OPTIEMUS"],
    );
    assert.deepEqual(t[0]?.fields, [
      "netIncome",
      "operatingIncomeExOtherIncome",
    ]);
  });

  it("ignores rows for symbols that are NOT declared", () => {
    // It is handed `excluded === "SYMBOL_EXCLUDED"` rows today, but the guard
    // is what stops a caller widening that filter and silently attributing an
    // unrelated exclusion to this list.
    const t = tallySymbolExclusions(
      [
        row("RELIANCE", "netIncome", "DISAGREEMENT"),
        row("MODIRUBBER", "netIncome", "DISAGREEMENT"),
      ],
      ["MODIRUBBER"],
    );
    assert.equal(t.length, 1);
    assert.equal(t[0]?.total, 1);
  });

  it("a duplicated declaration does not double-count", () => {
    // A list is hand-maintained; a repeated entry must not turn one removal
    // into two rows claiming the same removal.
    const t = tallySymbolExclusions(
      [row("CENTUM", "netIncome", "MATCH")],
      ["CENTUM", "CENTUM"],
    );
    assert.equal(t.length, 1);
    assert.equal(t[0]?.total, 1);
    assert.equal(t[0]?.matched, 1);
  });

  it("an empty declaration list tallies nothing at all", () => {
    // The falsifiable floor: with no symbols declared there is nothing to
    // exclude, so any row returned here would mean the seeding came from the
    // rows after all — which is exactly the defect the first test guards.
    assert.deepEqual(
      tallySymbolExclusions(
        [row("MODIRUBBER", "netIncome", "DISAGREEMENT")],
        [],
      ),
      [],
    );
  });

  it("the per-symbol totals reconcile with the row count", () => {
    // Cross-check on the bucketing: every counted row lands in exactly one
    // bucket, so the buckets must re-add to `total`. A verdict added to
    // `ReconcileVerdict` and forgotten here would fail this rather than quietly
    // vanish from the printed census.
    const rows = [
      row("MODIRUBBER", "a", "SCALE_MISMATCH"),
      row("MODIRUBBER", "b", "SIGN_MISMATCH"),
      row("MODIRUBBER", "c", "DISAGREEMENT"),
      row("MODIRUBBER", "d", "MATCH"),
      row("MODIRUBBER", "e", "INCOMPARABLE"),
      row("OPTIEMUS", "a", "MATCH"),
    ];
    for (const t of tallySymbolExclusions(rows, ["MODIRUBBER", "OPTIEMUS"])) {
      assert.equal(
        t.scale + t.sign + t.disagree + t.matched + t.incomparable,
        t.total,
        `${t.symbol}: buckets do not re-add to total`,
      );
      assert.equal(
        t.scale + t.sign + t.disagree + t.matched,
        t.comparable,
        `${t.symbol}: comparable is not the non-blank buckets`,
      );
    }
  });
});
