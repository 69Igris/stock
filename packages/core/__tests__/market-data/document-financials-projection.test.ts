/**
 * UNIT TEST — the document-financials projection's PURE decisions (MONEY-1255).
 *
 * The seam that has a database in its hands is covered next door in
 * `workers/__tests__/processors/document-financials-projection.test.ts`. This
 * file covers the decisions themselves: who may overwrite whom, what a write
 * must preserve, what `null` means, and what the reconcile is allowed to
 * conclude from how little it compared.
 *
 * Every case here is written to FAIL if the rule it names is removed. Where a
 * rule is about an ORDER (authority, roll-up severity, basis) the assertion is
 * over the order rather than over one pair, because a single pair passes under
 * several wrong orderings.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  docAuthorityState,
  describeDocAuthorityState,
  docBasisRank,
  docOwnedFields,
  docReadField,
  docStatementOf,
  emptyFieldCensus,
  foldComparison,
  gradeExtract,
  judgeDocCeiling,
  planDocumentFinancialsWrite,
  projectDocumentExtract,
  projectDocumentStatement,
  rollUpVerdict,
  selectExtractForPeriod,
  DOC_ALL_FIELDS,
  DOC_BLOCKING_VERDICTS,
  DOC_CASH_FLOW_FIELDS,
  DOC_DERIVED_FIELDS,
  DOC_DISPLACEMENT_KEY,
  DOC_INCOME_FIELDS,
  DOC_MIN_COMPARABLE,
  DOC_SOURCE,
  DOC_UNOWNED_VENDOR_COLUMNS,
  DOC_VERDICT_SEVERITY,
  type DocIncumbentRow,
  type DocumentExtractReading,
} from "../../src/market-data/document-financials-projection";
import {
  chooseAuthority,
  existingDisplacement,
  mayOverwriteFinancials,
  BALANCE_SHEET_FIELDS,
  FINANCIALS_AUTHORITY,
  INCOME_FIELDS,
  type ReconcileVerdict,
} from "../../src/market-data/xbrl-projection";

const NOW = new Date("2026-08-26T00:00:00.000Z");
const PERIOD_END = new Date("2025-03-31T00:00:00.000Z");

function reading(
  over: Partial<DocumentExtractReading> = {},
): DocumentExtractReading {
  return {
    id: "extract-1",
    documentId: "doc-1",
    instrumentId: "inst-1",
    symbol: "TCS",
    exchange: "NSE",
    fiscalYear: "FY2025",
    periodEnd: PERIOD_END,
    periodType: "ANNUAL",
    basis: "CONSOLIDATED",
    status: "EXTRACTED",
    reconcileVerdict: "MATCH",
    model: "gemini-3-pro",
    promptVersion: "v1",
    confidence: 0.9,
    extractedAt: new Date("2026-08-20T00:00:00.000Z"),
    revenueFromOperations: 240_000,
    otherIncome: 4_000,
    operatingIncomeExOtherIncome: 58_000,
    netIncome: 46_000,
    ebitdaBeforeExceptionalItems: 66_000,
    totalAssets: 150_000,
    totalLiabilities: 60_000,
    totalEquity: 90_000,
    totalDebt: 8_000,
    totalCash: 20_000,
    operatingCashFlow: 44_000,
    capitalExpenditure: 3_000,
    freeCashFlow: 41_000,
    ...over,
  };
}

function incomeStatement(r: DocumentExtractReading) {
  const s = projectDocumentStatement(r, "INCOME");
  assert.ok(s, "fixture must project an INCOME statement");
  return s;
}

// ─── Authority ───────────────────────────────────────────────────────

describe("DOC_PDF's place in the ONE declared authority order", () => {
  it("can NEVER displace NSE_XBRL — the one incumbent that outranks it in every state", () => {
    // NSE_XBRL is the ONLY source that beats DOC_PDF in BOTH states of the
    // constant: undeclared, DOC_PDF ranks LAST and loses to everything;
    // declared at rank 2, it loses to NSE_XBRL alone. So this is the only
    // never-displaces assertion that is state-independent, and it is the one
    // that matters — the company's own machine-readable filing must never be
    // replaced by a model's reading of the same company's PDF.
    assert.equal(
      mayOverwriteFinancials(DOC_SOURCE, "NSE_XBRL"),
      false,
      `${DOC_SOURCE} must never overwrite NSE_XBRL`,
    );
    assert.equal(
      chooseAuthority(DOC_SOURCE, "NSE_XBRL").keepIncumbent,
      true,
      "NSE_XBRL must be kept over a document reading",
    );
  });

  it("CAN displace a vendor once declared — and that is the promotion, stated as a test", () => {
    // MONEY-1255. This ASSERTED BEHAVIOUR CHANGED: at the earlier position
    // (immediately above YAHOO) a document reading lost to TICKERTAPE and
    // SCREENER; at rank 2 it beats them. An annual report is a PRIMARY source
    // and both vendors are scrapes of that same document.
    //
    // Written as an EQUIVALENCE against the declared state rather than a flat
    // `true`, so it stays honest in both states: while the constant does not
    // carry DOC_PDF it ranks LAST and legitimately loses, and asserting `true`
    // unconditionally would fail for a fail-SAFE reason and teach the next
    // reader to weaken it.
    const declared = docAuthorityState() === "BELOW_XBRL_ONLY";
    for (const vendor of ["TICKERTAPE", "SCREENER", "YAHOO"]) {
      assert.equal(
        mayOverwriteFinancials(DOC_SOURCE, vendor),
        declared,
        `docAuthorityState() is ${docAuthorityState()}, so ` +
          `mayOverwriteFinancials(${DOC_SOURCE}, "${vendor}") must be ` +
          `${declared}. A mismatch means the predicate and the order have ` +
          `come apart.`,
      );
      assert.equal(
        chooseAuthority(DOC_SOURCE, vendor).keepIncumbent,
        !declared,
        `chooseAuthority must agree with mayOverwriteFinancials for ${vendor}`,
      );
    }
  });

  it("fills an EMPTY cell in both states — that cohort is the whole point", () => {
    const d = chooseAuthority(DOC_SOURCE, null);
    assert.equal(d.keepIncumbent, false);
    assert.equal(d.displaced, null);
    assert.equal(mayOverwriteFinancials(DOC_SOURCE, null), true);
  });

  it("refreshes its OWN row — a re-parse under a better prompt must be able to land", () => {
    const d = chooseAuthority(DOC_SOURCE, DOC_SOURCE);
    assert.equal(d.keepIncumbent, false);
    // Equal rank returns the incumbent as `displaced`; the planner reads that as
    // a REFRESH and records nothing. Asserted here because the planner's
    // write-once guarantee depends on it.
    assert.equal(d.displaced, DOC_SOURCE);
  });

  it("docAuthorityState reads the order rather than restating it", () => {
    assert.equal(
      docAuthorityState(["NSE_XBRL", "TICKERTAPE", "SCREENER", "YAHOO"]),
      "PENDING_RANKS_LAST",
    );
    assert.equal(
      docAuthorityState([
        "NSE_XBRL",
        "DOC_PDF",
        "TICKERTAPE",
        "SCREENER",
        "YAHOO",
      ]),
      "BELOW_XBRL_ONLY",
      "the decided position is DOC_PDF immediately below NSE_XBRL",
    );
    // Every OTHER position is MISPLACED, not silently tolerated — including
    // `…SCREENER > DOC_PDF > YAHOO`, which was the decided position until the
    // founder promoted it. A superseded position must fail exactly as loudly as
    // a never-decided one; "it used to be right" is not a state this predicate
    // has, and tolerating it would let a revert pass unnoticed.
    for (const order of [
      ["DOC_PDF", "NSE_XBRL", "TICKERTAPE", "SCREENER", "YAHOO"],
      ["NSE_XBRL", "TICKERTAPE", "SCREENER", "DOC_PDF", "YAHOO"],
      ["NSE_XBRL", "TICKERTAPE", "DOC_PDF", "SCREENER", "YAHOO"],
      ["NSE_XBRL", "TICKERTAPE", "SCREENER", "YAHOO", "DOC_PDF"],
    ]) {
      assert.equal(
        docAuthorityState(order),
        "MISPLACED",
        `${order.join(">")} must be reported as MISPLACED`,
      );
    }
  });

  it("the LIVE constant is in one of the two SAFE states, never MISPLACED", () => {
    // The guard that fires the day somebody inserts DOC_PDF in the wrong place.
    // It deliberately accepts BOTH safe states, because this change does not own
    // the constant and the pending state is fail-safe.
    const state = docAuthorityState();
    assert.ok(
      state === "PENDING_RANKS_LAST" || state === "BELOW_XBRL_ONLY",
      `FINANCIALS_AUTHORITY is ${FINANCIALS_AUTHORITY.join(">")}, which puts ` +
        `DOC_PDF in state ${state}: ${describeDocAuthorityState(state)}`,
    );
  });

  it("the YAHOO relationship follows the DECLARED state, in both directions", () => {
    // An EQUIVALENCE, so it holds today and after the constant changes, and
    // fails if the two ever come apart — which is the only outcome nobody would
    // notice. Today the state is PENDING_RANKS_LAST and DOC_PDF loses to YAHOO;
    // once D-a lands it wins. Asserting only one side would encode whichever
    // world the repo happened to be in when this was written.
    const declaredAboveYahoo = docAuthorityState() === "BELOW_XBRL_ONLY";
    assert.equal(
      mayOverwriteFinancials(DOC_SOURCE, "YAHOO"),
      declaredAboveYahoo,
      `docAuthorityState() says ${docAuthorityState()}, so ` +
        `mayOverwriteFinancials(DOC_PDF, "YAHOO") must be ` +
        `${declaredAboveYahoo}. A mismatch means the predicate and the order ` +
        `have come apart.`,
    );
  });

  it("describeDocAuthorityState says which state it is, in words", () => {
    // The pending state must be REPORTED, never inferred from behaviour —
    // "absent" and "declared" being the same observable state is MONEY-1214.
    assert.match(describeDocAuthorityState("PENDING_RANKS_LAST"), /ranks LAST/);
    assert.match(
      describeDocAuthorityState("BELOW_XBRL_ONLY"),
      /below NSE_XBRL/,
    );
    assert.match(describeDocAuthorityState("MISPLACED"), /NOT immediately/);
  });
});

// ─── Owned columns ───────────────────────────────────────────────────

describe("what DOC_PDF owns", () => {
  it("derives INCOME and BALANCE_SHEET from the XBRL constants rather than restating them", () => {
    for (const f of INCOME_FIELDS) {
      assert.ok(
        DOC_INCOME_FIELDS.includes(f),
        `${f} is in INCOME_FIELDS and must be owned here too`,
      );
    }
    assert.deepEqual(docOwnedFields("BALANCE_SHEET"), BALANCE_SHEET_FIELDS);
    assert.deepEqual(docOwnedFields("CASH_FLOW"), DOC_CASH_FLOW_FIELDS);
  });

  it("owns `revenue`, and does NOT own the three columns whose vendor definition was never measured for a PDF", () => {
    assert.ok(DOC_INCOME_FIELDS.includes("revenue"));
    for (const col of ["operatingIncome", "ebitda", "grossProfit"]) {
      assert.ok(
        !(DOC_ALL_FIELDS as readonly string[]).includes(col),
        `${col} must stay unowned — an unowned column is never mentioned by the patch`,
      );
      assert.ok(
        DOC_UNOWNED_VENDOR_COLUMNS[col],
        `${col} must carry its evidence, or the declaration is a suppression`,
      );
    }
    assert.equal(
      DOC_UNOWNED_VENDOR_COLUMNS.revenue,
      undefined,
      "`revenue` is OWNED as a derived total and must not also be declared unowned",
    );
  });

  it("every owned column maps to exactly one statement", () => {
    for (const f of DOC_ALL_FIELDS) {
      const st = docStatementOf(f);
      assert.ok(st, `${f} must belong to a statement`);
      assert.ok(
        docOwnedFields(st).includes(f),
        `${f} must be owned by the statement it maps to`,
      );
    }
    assert.equal(docStatementOf("notAColumn"), null);
  });
});

// ─── The derived `revenue` ───────────────────────────────────────────

describe("`revenue` is DERIVED, never read", () => {
  it("is the Schedule III total: revenueFromOperations + otherIncome", () => {
    assert.deepEqual(DOC_DERIVED_FIELDS.revenue?.from, [
      "revenueFromOperations",
      "otherIncome",
    ]);
    const r = reading({ revenueFromOperations: 240_000, otherIncome: 4_000 });
    assert.equal(docReadField(r, "revenue"), 244_000);
    assert.equal(incomeStatement(r).values.revenue, 244_000);
  });

  it("a MISSING otherIncome yields NULL, not a bare revenueFromOperations masquerading as total income", () => {
    // The case the coordinator asked for by name. A partial sum here is not
    // "slightly incomplete": it is revenue-from-operations sitting in a column
    // that means TOTAL INCOME, which is the exact silent redefinition the whole
    // arrangement exists to prevent, arrived at by a different route.
    for (const missing of [
      { otherIncome: undefined },
      { otherIncome: null },
      { otherIncome: Number.NaN },
      { otherIncome: Number.POSITIVE_INFINITY },
    ]) {
      const r = reading({ revenueFromOperations: 240_000, ...missing });
      assert.equal(
        docReadField(r, "revenue"),
        undefined,
        `otherIncome=${String(missing.otherIncome)} must make revenue UNSOURCED`,
      );
      const s = incomeStatement(r);
      assert.equal(
        s.values.revenue,
        null,
        `otherIncome=${String(missing.otherIncome)} must write NULL, not ${String(s.values.revenue)}`,
      );
      assert.notEqual(
        s.values.revenue,
        240_000,
        "a bare revenueFromOperations must never land in `revenue`",
      );
      assert.ok(s.unsourced.includes("revenue"));
    }
  });

  it("a MISSING revenueFromOperations also yields NULL", () => {
    const r = reading({ revenueFromOperations: null, otherIncome: 4_000 });
    assert.equal(docReadField(r, "revenue"), undefined);
    assert.equal(incomeStatement(r).values.revenue, null);
  });

  it("NEVER reads the extract's own `revenue` column, even when it holds a value", () => {
    // The extractor is pinned to the same contract from its side, so a value
    // arriving here is already a contract violation — one this module refuses
    // to act on rather than merely report.
    const r = reading({
      revenue: 999_999,
      revenueFromOperations: null,
      otherIncome: null,
    });
    assert.equal(docReadField(r, "revenue"), undefined);
    assert.equal(incomeStatement(r).values.revenue, null);

    // And when the components ARE present, the components win — the raw column
    // does not override them.
    const r2 = reading({
      revenue: 999_999,
      revenueFromOperations: 100,
      otherIncome: 1,
    });
    assert.equal(docReadField(r2, "revenue"), 101);
  });

  it("otherIncome ZERO is a real disclosure and still produces a total", () => {
    // `0` is a value, not an absence. Treating it as missing would null the
    // total for every company that discloses no other income.
    const r = reading({ revenueFromOperations: 240_000, otherIncome: 0 });
    assert.equal(docReadField(r, "revenue"), 240_000);
    assert.equal(incomeStatement(r).values.revenue, 240_000);
  });
});

// ─── null means UNSOURCED, never 0 ───────────────────────────────────

describe("`null` means UNSOURCED and is never 0", () => {
  it("an absent column is written as an explicit NULL and listed as unsourced", () => {
    const s = incomeStatement(reading({ netIncome: null }));
    assert.equal(s.values.netIncome, null);
    assert.notEqual(s.values.netIncome, 0, "0 is a factual claim; null is not");
    assert.ok(s.unsourced.includes("netIncome"));
    assert.ok(!s.sourced.includes("netIncome"));
  });

  it("a DISCLOSED zero is kept as 0", () => {
    const s = incomeStatement(reading({ netIncome: 0 }));
    assert.equal(s.values.netIncome, 0);
    assert.ok(s.sourced.includes("netIncome"));
  });

  it("NaN and Infinity are UNSOURCED, never numbers", () => {
    for (const poison of [Number.NaN, Infinity, -Infinity]) {
      const s = incomeStatement(reading({ netIncome: poison }));
      assert.equal(
        s.values.netIncome,
        null,
        `${String(poison)} must not reach a money column`,
      );
    }
  });

  it("a statement with NOTHING sourced projects to null rather than a row of nulls", () => {
    const empty = reading({
      operatingCashFlow: null,
      capitalExpenditure: null,
      freeCashFlow: null,
    });
    assert.equal(projectDocumentStatement(empty, "CASH_FLOW"), null);
    assert.equal(projectDocumentExtract(empty).length, 2);
  });
});

// ─── Grading ─────────────────────────────────────────────────────────

function incumbent(over: Partial<DocIncumbentRow> = {}): DocIncumbentRow {
  return { source: "YAHOO", ...over };
}

describe("the verdict ladder", () => {
  const only = (
    ours: Partial<DocumentExtractReading>,
    theirs: Partial<DocIncumbentRow>,
    field = "totalAssets",
  ) =>
    gradeExtract(reading(ours), {
      INCOME: null,
      BALANCE_SHEET: incumbent(theirs),
      CASH_FLOW: null,
    }).find((c) => c.field === field)!;

  it("MATCH inside the 1% band", () => {
    const c = only({ totalAssets: 150_000 }, { totalAssets: 150_500 });
    assert.equal(c.verdict, "MATCH");
    assert.equal(c.side, "COMPARABLE");
  });

  it("MATCH under the absolute floor, so near-zero rounding is not a coin flip", () => {
    // 3PLAND FY2021 netIncome: ours -0.136 against theirs -0.12 is 13% relative
    // on a Rs 16,000 absolute gap. Without the floor that reads DISAGREEMENT
    // and competes for attention with real defects.
    const c = only({ totalAssets: -0.136 }, { totalAssets: -0.12 });
    assert.equal(c.verdict, "MATCH");
  });

  it("SCALE_MISMATCH names the factor", () => {
    const c = only({ totalAssets: 150_000 }, { totalAssets: 1_500 });
    assert.equal(c.verdict, "SCALE_MISMATCH");
    assert.equal(c.scaleFactor, 100);
  });

  it("SIGN_MISMATCH when the magnitudes agree and the signs do not", () => {
    const c = only({ totalAssets: -150_000 }, { totalAssets: 150_000 });
    assert.equal(c.verdict, "SIGN_MISMATCH");
  });

  it("DISAGREEMENT when neither scale nor sign explains it", () => {
    const c = only({ totalAssets: 150_000 }, { totalAssets: 91_000 });
    assert.equal(c.verdict, "DISAGREEMENT");
  });

  it("INCOMPARABLE names WHICH SIDE was empty — the three causes are never one number", () => {
    assert.equal(
      only({ totalAssets: null }, { totalAssets: 150_000 }).side,
      "OURS_BLANK",
    );
    assert.equal(
      only({ totalAssets: 150_000 }, { totalAssets: null }).side,
      "THEIRS_BLANK",
    );
    assert.equal(
      only({ totalAssets: null }, { totalAssets: null }).side,
      "BOTH_BLANK",
    );
  });

  it("wouldNullIncumbent is set ONLY where they have a value and we do not", () => {
    assert.equal(
      only({ totalAssets: null }, { totalAssets: 150_000 }).wouldNullIncumbent,
      true,
    );
    assert.equal(
      only({ totalAssets: 150_000 }, { totalAssets: null }).wouldNullIncumbent,
      false,
    );
    assert.equal(
      only({ totalAssets: null }, { totalAssets: null }).wouldNullIncumbent,
      false,
      "both blank is not a gap on our side",
    );
  });

  it("grades `revenue` as the DERIVED total, so the gate measures what the writer writes", () => {
    const c = gradeExtract(
      reading({
        revenue: 999_999,
        revenueFromOperations: 240_000,
        otherIncome: 4_000,
      }),
      {
        INCOME: incumbent({ revenue: 244_000 }),
        BALANCE_SHEET: null,
        CASH_FLOW: null,
      },
    ).find((x) => x.field === "revenue")!;
    assert.equal(c.ours, 244_000);
    assert.equal(c.verdict, "MATCH");
  });

  it("THROWS when a statement was never fetched — an absent key is not 'they have no value'", () => {
    // The MONEY-1250 defect, made unrepresentable: a hardcoded select made "we
    // never asked for this column" print as "the vendor has no value", and
    // `totalDebt` read `comparable 0 of 4516` against 9,861 stored values.
    assert.throws(
      () => gradeExtract(reading(), { INCOME: null, BALANCE_SHEET: null }),
      /CASH_FLOW/,
    );
  });
});

describe("the row-level roll-up", () => {
  it("is WORST-WINS in the declared severity order", () => {
    assert.deepEqual(DOC_VERDICT_SEVERITY, [
      "SCALE_MISMATCH",
      "SIGN_MISMATCH",
      "DISAGREEMENT",
      "MATCH",
      "INCOMPARABLE",
    ]);
    // Every prefix of the order must beat everything after it, so a single
    // pair cannot pass under a wrong ordering.
    for (let i = 0; i < DOC_VERDICT_SEVERITY.length; i++) {
      for (let j = i + 1; j < DOC_VERDICT_SEVERITY.length; j++) {
        // Annotated because DOC_VERDICT_SEVERITY is declared as
        // `readonly ReconcileVerdict[]` in a module that itself re-imports the
        // type; without the annotation tsc reports these as circular implicit
        // any (TS7022) rather than inferring the element type.
        const a: ReconcileVerdict = DOC_VERDICT_SEVERITY[i]!;
        const b: ReconcileVerdict = DOC_VERDICT_SEVERITY[j]!;
        assert.equal(
          rollUpVerdict([{ verdict: b }, { verdict: a }]),
          a,
          `${a} must win over ${b} regardless of input order`,
        );
      }
    }
  });

  it("MATCH outranks INCOMPARABLE — one field agreeing is evidence, nothing comparable is not", () => {
    assert.equal(
      rollUpVerdict([{ verdict: "INCOMPARABLE" }, { verdict: "MATCH" }]),
      "MATCH",
    );
  });

  it("an all-blank row rolls up to INCOMPARABLE, which must NOT block", () => {
    // This is the ~821-symbol zero-coverage cohort. Blocking it would refuse
    // the entire population the pipeline exists for.
    assert.equal(rollUpVerdict([{ verdict: "INCOMPARABLE" }]), "INCOMPARABLE");
    assert.equal(rollUpVerdict([]), "INCOMPARABLE");
    assert.equal(DOC_BLOCKING_VERDICTS.has("INCOMPARABLE"), false);
    assert.equal(DOC_BLOCKING_VERDICTS.has("MATCH"), false);
    for (const v of ["SCALE_MISMATCH", "SIGN_MISMATCH", "DISAGREEMENT"]) {
      assert.equal(DOC_BLOCKING_VERDICTS.has(v), true, `${v} must block`);
    }
  });
});

// ─── The ceiling ─────────────────────────────────────────────────────

describe("the reconcile's CEILING — a run that compared nothing must not print agreement", () => {
  const census = (over: Partial<ReturnType<typeof emptyFieldCensus>> = {}) => ({
    ...emptyFieldCensus("totalAssets", "BALANCE_SHEET"),
    ...over,
  });

  it("NO_EXTRACTS when nothing was graded", () => {
    const v = judgeDocCeiling({ extracts: 0, census: [census()] });
    assert.equal(v.verdict, "NO_EXTRACTS");
    assert.match(v.reason, /NOT a passing reconciliation/);
  });

  it("NO_JOIN when pairs were examined and NOT ONE addressed an existing row", () => {
    // The period-LABEL bug signature: we addressed rows that do not exist under
    // the name we derived, which would make every write a CREATE.
    const v = judgeDocCeiling({
      extracts: 40,
      census: [census({ examined: 400, joinable: 0, comparable: 0 })],
    });
    assert.equal(v.verdict, "NO_JOIN");
    assert.match(v.reason, /period-label/);
  });

  it("--expect-no-incumbents turns NO_JOIN into an ASSERTED OK, and nothing else", () => {
    const v = judgeDocCeiling({
      extracts: 40,
      census: [census({ examined: 400, joinable: 0, comparable: 0 })],
      expectNoIncumbents: true,
    });
    assert.equal(v.verdict, "OK");
    assert.match(v.reason, /--expect-no-incumbents/);
    // It must NOT rescue an empty run.
    assert.equal(
      judgeDocCeiling({
        extracts: 0,
        census: [census()],
        expectNoIncumbents: true,
      }).verdict,
      "NO_EXTRACTS",
    );
    // Nor a run under the floor with a working join.
    assert.equal(
      judgeDocCeiling({
        extracts: 40,
        census: [census({ examined: 400, joinable: 400, comparable: 3 })],
        expectNoIncumbents: true,
      }).verdict,
      "BELOW_FLOOR",
    );
  });

  it("BELOW_FLOOR when the join worked and too little was comparable", () => {
    const v = judgeDocCeiling({
      extracts: 40,
      census: [census({ examined: 400, joinable: 400, comparable: 3 })],
    });
    assert.equal(v.verdict, "BELOW_FLOOR");
    assert.equal(v.floor, DOC_MIN_COMPARABLE);
  });

  it("OK only at or above the floor, and the floor is CONFIGURABLE but defaulted", () => {
    const at = judgeDocCeiling({
      extracts: 40,
      census: [
        census({
          examined: 400,
          joinable: 400,
          comparable: DOC_MIN_COMPARABLE,
        }),
      ],
    });
    assert.equal(at.verdict, "OK");
    const below = judgeDocCeiling({
      extracts: 40,
      census: [
        census({
          examined: 400,
          joinable: 400,
          comparable: DOC_MIN_COMPARABLE - 1,
        }),
      ],
    });
    assert.equal(below.verdict, "BELOW_FLOOR");
    assert.equal(
      judgeDocCeiling({
        extracts: 40,
        census: [
          census({
            examined: 400,
            joinable: 400,
            comparable: DOC_MIN_COMPARABLE - 1,
          }),
        ],
        minComparable: 1,
      }).verdict,
      "OK",
    );
  });

  it("the three counts NEST and are all reported, so each zero says something different", () => {
    const v = judgeDocCeiling({
      extracts: 7,
      census: [
        census({ examined: 10, joinable: 8, comparable: 5 }),
        census({ examined: 10, joinable: 6, comparable: 4 }),
      ],
    });
    assert.equal(v.examined, 20);
    assert.equal(v.joinable, 14);
    assert.equal(v.comparable, 9);
    assert.equal(v.extracts, 7);
  });
});

describe("foldComparison keeps the incomparable causes apart", () => {
  it("counts joinability from the ROW's existence, never from the value", () => {
    // A row that exists with a null column is JOINABLE and not comparable; a row
    // that does not exist is neither. Inferring joinability from the value would
    // collapse the two readings this census exists to separate.
    const c = emptyFieldCensus("totalAssets", "BALANCE_SHEET");
    foldComparison(
      c,
      {
        field: "totalAssets",
        statementType: "BALANCE_SHEET",
        ours: 1,
        theirs: undefined,
        verdict: "INCOMPARABLE",
        side: "THEIRS_BLANK",
        wouldNullIncumbent: false,
      },
      true,
    );
    assert.equal(c.examined, 1);
    assert.equal(c.joinable, 1, "the row existed; the column was empty");
    assert.equal(c.comparable, 0);
    assert.equal(c.theirsBlank, 1);
    assert.equal(c.oursBlank, 0);
    assert.equal(c.bothBlank, 0);

    foldComparison(
      c,
      {
        field: "totalAssets",
        statementType: "BALANCE_SHEET",
        ours: 1,
        theirs: undefined,
        verdict: "INCOMPARABLE",
        side: "THEIRS_BLANK",
        wouldNullIncumbent: false,
      },
      false,
    );
    assert.equal(c.examined, 2);
    assert.equal(c.joinable, 1, "no row existed for the second pair");
  });

  it("every graded verdict lands in `comparable`, and INCOMPARABLE never does", () => {
    const c = emptyFieldCensus("totalAssets", "BALANCE_SHEET");
    const base = {
      field: "totalAssets" as const,
      statementType: "BALANCE_SHEET" as const,
      ours: 1,
      theirs: 2,
      side: "COMPARABLE" as const,
      wouldNullIncumbent: false,
    };
    foldComparison(c, { ...base, verdict: "MATCH" }, true);
    foldComparison(c, { ...base, verdict: "DISAGREEMENT" }, true);
    foldComparison(c, { ...base, verdict: "SCALE_MISMATCH" }, true);
    foldComparison(c, { ...base, verdict: "SIGN_MISMATCH" }, true);
    foldComparison(
      c,
      { ...base, verdict: "INCOMPARABLE", side: "OURS_BLANK" },
      true,
    );
    assert.equal(c.comparable, 4);
    assert.equal(c.incomparable, 1);
    assert.equal(c.matched, 1);
    assert.equal(c.disagreements, 1);
    assert.equal(c.scaleMismatches, 1);
    assert.equal(c.signMismatches, 1);
  });
});

// ─── One period, one row ─────────────────────────────────────────────

describe("selectExtractForPeriod is a TOTAL order", () => {
  it("CONSOLIDATED beats STANDALONE, whatever else differs", () => {
    const cons = reading({ id: "a", basis: "CONSOLIDATED", confidence: 0.1 });
    const stand = reading({ id: "b", basis: "STANDALONE", confidence: 0.99 });
    assert.equal(selectExtractForPeriod([stand, cons])?.id, "a");
    assert.equal(selectExtractForPeriod([cons, stand])?.id, "a");
  });

  it("then CONFIDENCE, then coverage, then recency, then id", () => {
    const low = reading({ id: "a", confidence: 0.4 });
    const high = reading({ id: "b", confidence: 0.8 });
    assert.equal(selectExtractForPeriod([low, high])?.id, "b");

    const thin = reading({ id: "a", confidence: 0.5, totalCash: null });
    const full = reading({ id: "b", confidence: 0.5 });
    assert.equal(selectExtractForPeriod([thin, full])?.id, "b");

    const old = reading({
      id: "a",
      extractedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const fresh = reading({
      id: "b",
      extractedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    assert.equal(selectExtractForPeriod([old, fresh])?.id, "b");
  });

  it("is a function of the candidate SET, not of its order", () => {
    // The instability the tiebreak chain exists to remove: two rows identical in
    // every graded respect must not resolve by whatever order the store returned.
    const a = reading({ id: "aaa" });
    const b = reading({ id: "bbb" });
    assert.equal(selectExtractForPeriod([a, b])?.id, "aaa");
    assert.equal(selectExtractForPeriod([b, a])?.id, "aaa");
  });

  it("counts coverage through docReadField, so a raw `revenue` cannot win a period", () => {
    // A candidate holding a value nothing will ever persist must not out-cover
    // one whose columns are actually writable.
    const fake = reading({
      id: "a",
      revenue: 1_000,
      revenueFromOperations: null,
      otherIncome: null,
    });
    const real = reading({ id: "b", revenueFromOperations: 1, otherIncome: 1 });
    assert.equal(selectExtractForPeriod([fake, real])?.id, "b");
  });

  it("returns null for an empty set", () => {
    assert.equal(selectExtractForPeriod([]), null);
  });

  it("docBasisRank puts CONSOLIDATED first and an unknown basis LAST", () => {
    assert.ok(docBasisRank("CONSOLIDATED") < docBasisRank("STANDALONE"));
    assert.ok(docBasisRank("STANDALONE") < docBasisRank("IFRS"));
    assert.ok(docBasisRank("STANDALONE") < docBasisRank(null));
    assert.ok(docBasisRank("STANDALONE") < docBasisRank(undefined));
  });
});

// ─── The write plan ──────────────────────────────────────────────────

describe("planDocumentFinancialsWrite", () => {
  const plan = (
    r: Partial<DocumentExtractReading>,
    inc: DocIncumbentRow | null,
    over: Partial<Parameters<typeof planDocumentFinancialsWrite>[0]> = {},
  ) => {
    const read = reading(r);
    return planDocumentFinancialsWrite({
      reading: read,
      statement: incomeStatement(read),
      incumbent: inc,
      now: NOW,
      ...over,
    });
  };

  it("CREATES when there is no incumbent — the majority path for the zero-coverage cohort", () => {
    const p = plan({}, null);
    assert.equal(p.action, "CREATE");
    assert.equal(p.source, DOC_SOURCE);
    assert.equal(p.displaced, null);
    assert.equal(p.rawData?.doc.extract.extractId, "extract-1");
  });

  it("SKIPS AUTHORITY against NSE_XBRL, the only source that outranks DOC_PDF", () => {
    const p = plan({}, incumbent({ source: "NSE_XBRL" }));
    assert.equal(p.action, "SKIP", "must not write over NSE_XBRL");
    assert.equal(p.skipReason, "AUTHORITY");
    assert.equal(p.values, undefined, "a SKIP must carry no patch");
  });

  it("UPDATES over a vendor, recording what it displaced", () => {
    // MONEY-1255. The behavioural half of the rank-2 promotion: TICKERTAPE and
    // SCREENER used to produce SKIP/AUTHORITY here and now produce a write.
    //
    // The displacement record is the part that makes this survivable rather
    // than merely allowed. `StockFinancials` has no `source` in its unique key,
    // so the vendor's number is GONE the moment we write — the only reason a
    // wrong reading is recoverable is that the loser's identity is preserved on
    // the way out. Asserting the write without asserting the record would pass
    // against an implementation that quietly destroys the evidence.
    for (const vendor of ["TICKERTAPE", "SCREENER", "YAHOO"]) {
      const p = plan({}, incumbent({ source: vendor }));
      assert.equal(p.action, "UPDATE", `must write over ${vendor}`);
      assert.equal(p.skipReason, undefined);
      assert.ok(p.values, "an UPDATE must carry a patch");
      assert.equal(
        p.displaced?.displacedSource,
        vendor,
        `the displaced ${vendor} value must be recorded, not silently lost`,
      );
      // And the record must reach the ROW, not just the plan — `rawData` is
      // the only place it survives the write, and the write-once rule
      // (`prior ?? displaced`) is what stops a second pass from overwriting
      // the original evidence with the state this writer created.
      assert.equal(
        p.rawData?.displacedByXbrl?.displacedSource,
        vendor,
        `the ${vendor} record must be carried in rawData, where it survives`,
      );
    }
  });

  it("refuses an extract the reconcile has not graded", () => {
    const p = plan({ reconcileVerdict: null }, null);
    assert.equal(p.action, "SKIP");
    assert.equal(p.skipReason, "NOT_GRADED");
    // And the interlock is defeatable only DELIBERATELY, by a caller that says so.
    assert.equal(
      plan({ reconcileVerdict: null }, null, { requireGraded: false }).action,
      "CREATE",
    );
  });

  it("refuses a BLOCKING verdict and allows the rest", () => {
    for (const v of ["SCALE_MISMATCH", "SIGN_MISMATCH", "DISAGREEMENT"]) {
      const p = plan({ reconcileVerdict: v }, null);
      assert.equal(p.action, "SKIP", `${v} must block`);
      assert.equal(p.skipReason, "VERDICT_BLOCKS");
    }
    for (const v of ["MATCH", "INCOMPARABLE"]) {
      assert.equal(
        plan({ reconcileVerdict: v }, null).action,
        "CREATE",
        `${v} must not block`,
      );
    }
  });

  it("refuses an extract that is not EXTRACTED", () => {
    for (const s of ["FAILED", "FAILED_VALIDATION", "PENDING"]) {
      const p = plan({ status: s }, null);
      assert.equal(p.action, "SKIP");
      assert.equal(p.skipReason, "NOT_EXTRACTED");
    }
  });

  it("records the displaced source EXACTLY ONCE and never overwrites the first record", () => {
    // The write-once guarantee. A refresh that rebuilt the record would replace
    // "the incumbent said X" with "DOC_PDF said X" — the original numbers gone,
    // the row's history now a tautology, and nothing reporting a problem.
    //
    // The incumbent is an UNKNOWN source on purpose. `rankOf` ranks an unknown
    // LAST, so DOC_PDF outranks it in BOTH authority states — before the
    // constant carries DOC_PDF (when DOC_PDF itself ranks last and ties) and
    // after (when it sits above YAHOO). Using YAHOO here would make this case
    // assert the POST-change world only, and it would pass or fail for a reason
    // that has nothing to do with displacement mechanics.
    const first = plan(
      {},
      incumbent({
        source: "MORNINGSTAR",
        netIncome: 41_000,
        totalAssets: 1,
        fetchedAt: new Date("2026-01-01T00:00:00.000Z"),
        rawData: { vendor: "original" },
      }),
    );
    assert.equal(first.action, "UPDATE");
    assert.ok(first.displaced);
    assert.equal(first.displaced?.displacedSource, "MORNINGSTAR");
    assert.equal(first.displaced?.by, DOC_SOURCE);
    assert.equal(first.displaced?.values.netIncome, 41_000);
    assert.deepEqual(first.displaced?.rawData, { vendor: "original" });
    const stored = (first.rawData as unknown as Record<string, unknown>)[
      DOC_DISPLACEMENT_KEY
    ];
    assert.ok(
      stored,
      `the record must be stored under ${DOC_DISPLACEMENT_KEY}`,
    );

    // Now a SECOND write over the row we just created.
    const second = plan(
      { id: "extract-2" },
      incumbent({
        source: DOC_SOURCE,
        rawData: {
          doc: { extract: { extractId: "extract-1" } },
          [DOC_DISPLACEMENT_KEY]: first.displaced,
        },
      }),
    );
    assert.equal(second.action, "UPDATE");
    assert.equal(second.displaced, null, "a refresh displaces nothing");
    assert.deepEqual(
      (second.rawData as unknown as Record<string, unknown>)[
        DOC_DISPLACEMENT_KEY
      ],
      first.displaced,
      "the FIRST displacement record must survive verbatim",
    );
  });

  it("a NON-REFRESH displacement over a row that ALREADY carries a record keeps the FIRST one", () => {
    // The case `prior ?? displaced` actually protects, and the one a REFRESH
    // cannot exercise: on a refresh `displaced` is null, so `displaced ?? prior`
    // and `prior ?? displaced` agree and the ordering is unobservable. Here the
    // incumbent is a DIFFERENT source that already carries a record, so the
    // wrong order would overwrite the only copy of what was originally there
    // with the state a later writer created.
    const original = {
      displacedSource: "TICKERTAPE",
      by: "SOMETHING",
      displacedAt: "2026-01-01T00:00:00.000Z",
      values: { netIncome: 7 },
      fetchedAt: null,
      rawData: null,
    };
    const p = plan(
      {},
      incumbent({
        source: "MORNINGSTAR",
        netIncome: 41_000,
        rawData: { [DOC_DISPLACEMENT_KEY]: original },
      }),
    );
    assert.equal(p.action, "UPDATE");
    assert.ok(p.displaced, "this write DOES displace MORNINGSTAR");
    assert.equal(p.displaced?.displacedSource, "MORNINGSTAR");
    assert.deepEqual(
      (p.rawData as unknown as Record<string, unknown>)[DOC_DISPLACEMENT_KEY],
      original,
      "the FIRST record must survive — the newer one describes a state a " +
        "writer created, not what was originally there",
    );
  });

  it("stores the record under the key the XBRL writer reads, so a later XBRL write preserves it", () => {
    // The interop property. `planFinancialsWrite` rebuilds rawData from scratch
    // and carries forward ONLY this key; under any other name the original
    // vendor values would be dropped by the next XBRL write.
    const p = plan({}, incumbent({ source: "MORNINGSTAR", netIncome: 1 }));
    const found = existingDisplacement(p.rawData);
    assert.ok(
      found,
      "existingDisplacement must find what this module wrote, or the " +
        "write-once chain is broken across the two writers",
    );
    assert.equal(found?.displacedSource, "MORNINGSTAR");
  });

  it("SKIPS a STANDALONE reading that would displace another source", () => {
    const p = plan(
      { basis: "STANDALONE" },
      incumbent({ source: "MORNINGSTAR" }),
    );
    assert.equal(p.action, "SKIP");
    assert.equal(p.skipReason, "STANDALONE_NO_DISPLACE");
    // …but STANDALONE still CREATES where nothing exists: standalone beats
    // nothing.
    assert.equal(plan({ basis: "STANDALONE" }, null).action, "CREATE");
  });

  it("SKIPS a basis DOWNGRADE of our own row, and allows the upgrade", () => {
    const ours = (basis: string): DocIncumbentRow =>
      incumbent({
        source: DOC_SOURCE,
        rawData: { doc: { extract: { extractId: "x", basis } } },
      });
    const down = plan({ basis: "STANDALONE" }, ours("CONSOLIDATED"));
    assert.equal(down.action, "SKIP");
    assert.equal(down.skipReason, "BASIS_DOWNGRADE");
    // The upgrade path must keep writing, or the guard freezes exactly the rows
    // it exists to protect.
    assert.equal(
      plan({ basis: "CONSOLIDATED" }, ours("STANDALONE")).action,
      "UPDATE",
    );
  });

  it("falls back to the `basis` COLUMN when rawData provenance is unreadable", () => {
    const p = plan(
      { basis: "STANDALONE" },
      incumbent({ source: DOC_SOURCE, rawData: null, basis: "CONSOLIDATED" }),
    );
    assert.equal(p.skipReason, "BASIS_DOWNGRADE");
    // Absent on BOTH is an absence of evidence and must refuse nothing.
    assert.equal(
      plan(
        { basis: "STANDALONE" },
        incumbent({ source: DOC_SOURCE, rawData: null }),
      ).action,
      "UPDATE",
    );
  });

  it("the CREATE branch sits BELOW the basis guards, so a future guard cannot be bypassed by a missing row", () => {
    // Provably inert today — with no incumbent every guard above is a no-op —
    // so a BEHAVIOURAL assertion here passes under both orderings and would be
    // vacuous. The behaviour is pinned first...
    const p = plan({ basis: "STANDALONE" }, null);
    assert.equal(p.action, "CREATE");
    assert.equal(p.skipReason, undefined);

    // ...and the ORDER is asserted STRUCTURALLY, against the source, which is
    // the only thing that can actually fail if the branch moves back to the top
    // of the function. Creates are the MAJORITY path here (~821 symbols hold
    // zero rows), and a guard the majority path skips is not a guard — the
    // early return put one branch out of reach of every rule written after it,
    // purely by textual position (MONEY-1238).
    const src = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/market-data/document-financials-projection.ts",
      ),
      "utf8",
    );
    const standaloneGuard = src.indexOf('skipReason: "STANDALONE_NO_DISPLACE"');
    const basisGuard = src.indexOf('skipReason: "BASIS_DOWNGRADE"');
    const createBranch = src.indexOf("if (incumbent === null) {");
    assert.ok(standaloneGuard > 0 && basisGuard > 0 && createBranch > 0);
    assert.ok(
      createBranch > standaloneGuard,
      "the CREATE branch must appear AFTER the STANDALONE guard in the source",
    );
    assert.ok(
      createBranch > basisGuard,
      "the CREATE branch must appear AFTER the BASIS_DOWNGRADE guard",
    );
  });

  it("is a FIXPOINT: nothing to change is a SKIP, not an identical write", () => {
    const read = reading();
    const statement = incomeStatement(read);
    const same = planDocumentFinancialsWrite({
      reading: read,
      statement,
      incumbent: incumbent({
        source: DOC_SOURCE,
        basis: "CONSOLIDATED",
        rawData: {
          doc: {
            extract: {
              extractId: read.id,
              basis: read.basis,
              periodEnd: read.periodEnd.toISOString(),
            },
          },
        },
        ...(statement.values as Record<string, number | null>),
      }),
      now: NOW,
    });
    assert.equal(same.action, "SKIP");
    assert.equal(same.skipReason, "UNCHANGED");
  });

  it("a DIFFERENT extract for the same period is NOT unchanged, even with identical numbers", () => {
    // A re-parse under a better prompt must be able to land, or the row keeps a
    // superseded provenance forever.
    const read = reading({ id: "extract-2" });
    const statement = incomeStatement(read);
    const p = planDocumentFinancialsWrite({
      reading: read,
      statement,
      incumbent: incumbent({
        source: DOC_SOURCE,
        rawData: {
          doc: {
            extract: {
              extractId: "extract-1",
              basis: read.basis,
              periodEnd: read.periodEnd.toISOString(),
            },
          },
        },
        ...(statement.values as Record<string, number | null>),
      }),
      now: NOW,
    });
    assert.equal(p.action, "UPDATE");
  });

  it("the patch carries EXPLICIT nulls for owned columns the extract did not source", () => {
    const p = plan({ netIncome: null }, null);
    assert.ok("netIncome" in (p.values ?? {}));
    assert.equal(p.values?.netIncome, null);
    assert.notEqual(p.values?.netIncome, 0);
  });

  it("the patch NEVER mentions an unowned vendor column", () => {
    const p = plan({}, null);
    for (const col of Object.keys(DOC_UNOWNED_VENDOR_COLUMNS)) {
      assert.ok(
        !(col in (p.values ?? {})),
        `${col} is unowned and must not appear in the patch at all`,
      );
    }
  });

  it("SKIPS NO_VALUES rather than writing a statement of nothing", () => {
    const read = reading();
    const p = planDocumentFinancialsWrite({
      reading: read,
      statement: {
        statementType: "INCOME",
        values: {},
        unsourced: [...DOC_INCOME_FIELDS],
        sourced: [],
      },
      incumbent: null,
      now: NOW,
    });
    assert.equal(p.action, "SKIP");
    assert.equal(p.skipReason, "NO_VALUES");
  });
});
