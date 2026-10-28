/**
 * UNIT TEST — XBRL → StockFinancials projection, ratios, reconciliation and the
 * switchover gate (MONEY-1115, Data Engine P10 F3).
 *
 * ## The core assertions run on REAL filings
 *
 * Three fixtures, already parsed by the sibling suite for
 * `xbrl-financials-logic`, are re-used here and PROJECTED. A projection that
 * only ever sees hand-built input is untested: the shapes that break it —
 * a bank with no depreciation line, a consolidated filing with two competing
 * profit rows, an income-statement-only filing with no balance sheet — are
 * exactly the shapes nobody remembers to synthesise.
 *
 * | fixture     | family  | basis        | what it is here for                    |
 * |-------------|---------|--------------|----------------------------------------|
 * | glaxo…      | ind-as  | standalone   | the complete happy path, both statements|
 * | icicibank…  | banking | standalone   | EBITDA suppression, Capital+Reserves    |
 * | bhartiartl… | ind-as  | consolidated | owners-vs-period profit, a loss base    |
 *
 * Every number asserted below was read out of the XML by hand before it was
 * asserted, so a regression shows up as a wrong REAL rupee figure and not as a
 * diff against a golden blob:
 *
 *   GLAXO Q2-FY25  revenue ₹1,000.05 Cr, finance costs ₹0.27 Cr, depreciation
 *                  ₹16.86 Cr, PBT ₹338.70 Cr, expenses ₹698.23 Cr
 *                  → EBITDA ₹355.83 Cr, operating income ₹318.95 Cr.
 *   ICICIBANK      interest earned ₹4,053.738 Cr… (₹40,537.38 Cr), interest
 *                  expended ₹20,489.40 Cr, Capital ₹3,060.19 Cr + Reserves
 *                  ₹2,56,479.80 Cr → equity ₹2,59,539.99 Cr.
 *   BHARTIARTL     Q2-FY20 AGR quarter: PBT −₹31,649.5 Cr, profit for period
 *                  −₹22,830.1 Cr, profit to OWNERS −₹23,044.9 Cr. The two
 *                  profit rows differ by the ₹214.8 Cr minority share, which is
 *                  what makes it the right fixture for the consolidated rule.
 *
 * ## Three cases carry most of the weight
 *
 *   1. `REGRESSION: a mostly-INCOMPARABLE source cannot pass the gate` — the
 *      MONEY-1196 draining-denominator failure. **This one FAILS today.**
 *   2. `REGRESSION: sumAll refuses a partial total` — a plausible-but-wrong
 *      EBITDA is worse than no EBITDA, because nothing about it says so.
 *   3. `REGRESSION: a zero or negative denominator yields undefined` — the
 *      non-finite poison class this repo keeps re-fixing, caught at the only
 *      place it can be.
 *
 * Everything here is synchronous and pure: no timers, no I/O beyond three
 * `readFileSync` calls at module load, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseXbrlFinancials,
  type XbrlConcept,
  type XbrlFamily,
  type XbrlFinancials,
} from "../../src/market-data/xbrl-financials-logic";
import {
  FINANCIALS_AUTHORITY,
  chooseAuthority,
  deriveRatios,
  growthPct,
  judgeSwitchoverReadiness,
  deriveGrowthQoQ,
  deriveTtm,
  periodLabel,
  projectFinancials,
  reconcile,
  type ProjectedFinancials,
  type ReconcileVerdict,
  exceptionalAdjustment,
  judgeExclusionComparison,
  lenderTopLineShape,
  isAdjacentAnnual,
  vendorComparablePeriodEnd,
  VENDOR_REPORTING_LAG_DAYS,
  EXCLUSION_COMPARISON_MIN_PAIRS,
  classifyIncomparable,
  splitIncomparable,
  planFinancialsWrite,
  writableFields,
} from "../../src/market-data/xbrl-projection";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "xbrl");
const read = (name: string): string =>
  readFileSync(join(FIXTURES, name), "utf8");

/** Parse-or-fail, so a `null` regression fails on the assertion, not a TypeError. */
function parsed(name: string): XbrlFinancials {
  const r = parseXbrlFinancials(read(name));
  assert.ok(r !== null, `expected ${name} to parse`);
  return r;
}

const GLAXO = parsed("glaxo-q2fy25-standalone-indas-2020-03-31.xml");
const ICICI = parsed("icicibank-q2fy25-standalone-banking-2019-09-30.xml");
const BHARTI = parsed("bhartiartl-q2fy20-consolidated-indas-2018-03-31.xml");

/** Non-null accessor, so a `null` statement fails loudly instead of via `?.`. */
function stmt(
  s: ProjectedFinancials | null,
  label: string,
): ProjectedFinancials {
  assert.ok(s !== null, `expected a ${label} statement, got null`);
  return s;
}

/* -------------------------------------------------------------------------- */
/* Synthetic filings — for the shapes the three real ones do not contain       */
/* -------------------------------------------------------------------------- */

/**
 * A minimal `XbrlFinancials`. Only `family` and `values` steer the projection;
 * everything else is provenance the projector never reads, so it is filled with
 * inert constants rather than being made optional — the whole point of the
 * parser's contract is that these fields are always present.
 */
function synth(opts: {
  family?: XbrlFamily;
  values: Partial<Record<XbrlConcept, number>>;
  /**
   * Override the period — MONEY-1250. `roe`/`roa`/`assetTurnover` need an
   * ADJACENT prior filing, so a fixture exercising them has to be able to sit
   * one fiscal year earlier.
   */
  period?: { start: string; end: string; days: number };
  /**
   * Override the basis — MONEY-1250 review. An ABSENT non-controlling element
   * means "zero" only on a STANDALONE filing, where subsidiaries cannot exist;
   * on a CONSOLIDATED one it means UNKNOWN.
   */
  basis?: XbrlFinancials["basis"];
}): XbrlFinancials {
  return {
    taxonomy: {
      namespace: "http://www.bseindia.com/xbrl/fin/2020-03-31/in-bse-fin",
      dialect: "in-bse-fin",
      version: "2020-03-31",
      prefix: "in-bse-fin",
      entryPoint: null,
    },
    family: opts.family ?? "ind-as",
    familySource: "default",
    symbol: "TESTCO",
    scripCode: null,
    companyName: "Test Company Limited",
    isin: null,
    basis: opts.basis ?? "standalone",
    audited: false,
    currency: "INR",
    roundingLabel: "Lakhs",
    reportingQuarterLabel: "Quarterly",
    period: {
      start: opts.period?.start ?? "2025-07-01",
      end: opts.period?.end ?? "2025-09-30",
      days: opts.period?.days ?? 91,
      contextRef: "OneD",
      source: "reported-facts",
    },
    otherPeriods: [],
    balanceSheetDate: "2025-09-30",
    balanceSheetSource: "column",
    values: opts.values,
    // Coverage is the parser's report on itself; the projector does not read it.
    coverage: {
      level: "none",
      present: [],
      missing: [],
      byGroup: {
        income: { present: 0, expected: 0 },
        perShare: { present: 0, expected: 0 },
        balanceSheet: { present: 0, expected: 0 },
      },
    },
  };
}

/**
 * The SAME fixture one fiscal year earlier — MONEY-1250.
 *
 * `roe`/`roa` are averaged over the two filings' balances, so a test that means
 * to exercise them must supply an adjacent prior. Values default to the
 * current-year ones, which makes the average equal the closing balance and
 * keeps every pre-existing expectation arithmetically unchanged.
 */
function priorOf(
  current: XbrlFinancials,
  values?: Partial<Record<XbrlConcept, number>>,
): XbrlFinancials {
  // Derived from the CURRENT period, never hardcoded: fixtures sit in different
  // years, and a fixed date can land NEWER than the filing it is prior to —
  // which `isAdjacentAnnual` correctly refuses, silently turning the test into
  // a no-op.
  const back = (iso: string): string => {
    const d = new Date(iso);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  };
  return synth({
    family: current.family,
    values: { ...current.values, ...(values ?? {}) },
    period: {
      start: back(current.period.start),
      end: back(current.period.end),
      days: current.period.days,
    },
  });
}

const repeat = (n: number, v: ReconcileVerdict): ReconcileVerdict[] =>
  Array.from({ length: n }, () => v);

/* -------------------------------------------------------------------------- */
/* Guards the guard                                                            */
/* -------------------------------------------------------------------------- */

describe("the real fixtures actually reach the projector", () => {
  // Without this, a moved fixture directory or a renamed file turns every
  // "real filing" assertion below into an assertion about `null`, and a suite
  // that asserts nothing passes.
  it("all three parse, with the family and basis this file assumes", () => {
    assert.deepEqual(
      [GLAXO, ICICI, BHARTI].map((f) => `${f.symbol}/${f.family}/${f.basis}`),
      [
        "GLAXO/ind-as/standalone",
        "ICICIBANK/banking/standalone",
        "BHARTIARTL/ind-as/consolidated",
      ],
    );
  });

  it("all three project to a non-empty income statement", () => {
    for (const f of [GLAXO, ICICI, BHARTI]) {
      const p = projectFinancials(f);
      const income = stmt(p.income, `${String(f.symbol)} income`);
      // statementType alone is not evidence — count the money fields.
      const money = Object.keys(income).filter((k) => k !== "statementType");
      assert.ok(
        money.length >= 3,
        `${String(f.symbol)} projected only ${money.length} income field(s)`,
      );
    }
  });

  it("every projected number is finite — nothing NaN leaks into the tables", () => {
    for (const f of [GLAXO, ICICI, BHARTI]) {
      const p = projectFinancials(f);
      for (const s of [p.income, p.balanceSheet]) {
        if (s === null) continue;
        for (const [k, v] of Object.entries(s)) {
          if (k === "statementType") continue;
          assert.ok(
            typeof v === "number" && Number.isFinite(v),
            `${String(f.symbol)}.${k} is not finite: ${String(v)}`,
          );
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* projectFinancials — real filings                                            */
/* -------------------------------------------------------------------------- */

describe("projectFinancials — GLAXO Q2 FY25 (ind-as, standalone)", () => {
  const p = projectFinancials(GLAXO);

  it("lands the income statement on the published figures", () => {
    const income = stmt(p.income, "income");
    assert.equal(income.statementType, "INCOME");
    // ₹1,000.05 Cr revenue, ₹248.69 Cr PAT — GSK's published Q2-FY25.
    assert.equal(income.revenueFromOperations, 10_000_500_000);
    assert.equal(income.netIncome, 2_486_900_000);
    // EBITDA = PBT 3,387.0 + finance costs 2.7 + depreciation 168.6 (₹ mn)
    //        = ₹355.83 Cr, LESS the ₹4.69 Cr exceptional GAIN (MONEY-1239).
    // GLAXO is the fixture that proves the adjustment is symmetric: the
    // exceptional here is POSITIVE, so removing it LOWERS ebitda. A rule that
    // only stripped charges would leave this one overstated.
    assert.equal(
      income.ebitdaBeforeExceptionalItems,
      3_558_300_000 - 46_900_000,
    );
    assert.equal(income.ebitdaBeforeExceptionalItems, 3_511_400_000);
    // Operating income = revenue − expenses + the FINANCE addback only
    //   = 10,000.5 − 6,982.3 + 2.7 = ₹302.09 Cr.
    // Depreciation is NOT added back (MONEY-1234): it is an operating cost of
    // using the assets that earned the revenue, while interest is a financing
    // charge. The old value was 3,189,500,000 — higher by exactly the 168.6mn
    // depreciation line, which made this an EBITDA under an EBIT name. Note how
    // near `ebitda` above it used to sit: the two differed only by otherIncome.
    assert.equal(income.operatingIncomeExOtherIncome, 3_020_900_000);
  });

  it("lands the balance sheet, including the debt sum and the cash line", () => {
    const bs = stmt(p.balanceSheet, "balance sheet");
    assert.equal(bs.statementType, "BALANCE_SHEET");
    assert.equal(bs.totalAssets, 37_300_900_000);
    assert.equal(bs.totalEquity, 16_746_600_000);
    // `Liabilities` is disclosed, so it is read rather than derived — and it
    // reconciles: 16,746.6 + 20,554.3 = 37,300.9 (₹ mn).
    assert.equal(bs.totalLiabilities, 20_554_300_000);
    // current 106.1 + non-current 0.0. The zero is a REPORTED zero and must be
    // summed, not treated as absent — that is what makes the total whole.
    assert.equal(bs.totalDebt, 106_100_000);
    // THE THREE-WAY CASH SUM, on a real filing — MONEY-1250.
    //
    // This expected 38.49 crore, which is `CashAndCashEquivalents` alone. The
    // filing's three lines, read from the fixture XML:
    //
    //     CashAndCashEquivalents                          38.49 Cr
    //     CurrentInvestments                           1,000.82 Cr
    //     BankBalanceOtherThanCashAndCashEquivalents   1,060.75 Cr
    //                                                  ------------
    //                                                  2,100.06 Cr
    //
    // BOTH new lines matter and they are near-equal here — GSK Pharma India is
    // cash-rich and holds it in deposits and short-term instruments rather than
    // a current account. Publishing 38 crore of a 2,100 crore position is what
    // drove `totalCash` to an 85.8% disagreement with the incumbent over 2,437
    // pairs, 99.4% of it one way.
    //
    // NOTE the filing also carries `CashAndCashEquivalentsCashFlowStatement` at
    // 62.15 Cr — a CASH-FLOW element, not a balance-sheet one. The concept tags
    // match exactly and must not be loosened to a prefix, or the closing
    // cash-flow balance gets added to the balance sheet.
    //
    // A 54x move on ONE fixture is the point: the old number was not slightly
    // low, it was a different quantity. Kept as an exact assertion so the parts
    // cannot be silently dropped again.
    assert.equal(bs.totalCash, 21_000_600_000);
  });

  it("does NOT absorb the cash-flow statement's closing balance", () => {
    // GLAXO files `CashAndCashEquivalentsCashFlowStatement` at 62.15 Cr beside
    // the balance-sheet `CashAndCashEquivalents` at 38.49 Cr — MONEY-1250. The
    // three-way sum makes tag PRECISION load-bearing in a way it was not when
    // one element was read: loosening any of the three to a prefix or a
    // `startsWith` silently adds a cash-flow closing balance to a balance sheet.
    //
    // Asserted as an exclusion, because the sum being "about right" would not
    // reveal a 62 crore contaminant on a 2,100 crore figure.
    const bs = stmt(p.balanceSheet, "balance sheet");
    assert.equal(
      bs.totalCash,
      384_900_000 + 10_008_200_000 + 10_607_500_000,
      "totalCash must be exactly the three BALANCE-SHEET lines",
    );
    assert.notEqual(
      bs.totalCash,
      384_900_000 + 10_008_200_000 + 10_607_500_000 + 621_500_000,
      "the cash-flow closing balance leaked into the balance sheet",
    );
  });

  it("has nothing unfilled — a complete filing reports no gaps", () => {
    assert.deepEqual(p.unfilled, []);
  });
});

describe("projectFinancials — ICICIBANK Q2 FY25 (banking)", () => {
  const p = projectFinancials(ICICI);

  it("REGRESSION: EBITDA is NOT computed for a bank", () => {
    // Interest expended IS a bank's cost of goods. Adding ₹20,489.40 Cr of it
    // back to PBT would produce ₹35,979.49 Cr of "EBITDA" — a number with no
    // meaning that would nonetheless sort a screener and anchor a valuation.
    const income = stmt(p.income, "income");
    assert.equal(income.ebitdaBeforeExceptionalItems, undefined);
    assert.ok(
      !("ebitdaBeforeExceptionalItems" in income),
      "the key must be absent, not present-as-undefined",
    );
    // Named for the COLUMN, not the concept — MONEY-1255. `"ebitda" in income`
    // is now true of NO projection at all, so it would have passed for a bank,
    // for a manufacturer, and for an empty object alike.
    assert.notEqual(
      income.ebitdaBeforeExceptionalItems,
      154_900_900_000 + 204_894_000_000,
    );

    // And it is not reported as a GAP either: for a bank there is nothing to
    // fill, so listing it would make `unfilled` a list of things that are fine.
    assert.ok(
      !p.unfilled.some((u) => u.field === "ebitdaBeforeExceptionalItems"),
    );
  });

  it("maps the bank's top line and takes operating income from the RBI line", () => {
    const income = stmt(p.income, "income");
    // InterestEarned ₹40,537.38 Cr is the canonical `revenue`.
    assert.equal(income.revenueFromOperations, 405_373_800_000);
    assert.equal(income.netIncome, 117_458_800_000);
    // OperatingProfitBeforeProvisionAndContingencies — disclosed, not derived
    // from revenue − expenses, which for a bank would be a different concept.
    assert.equal(income.operatingIncomeExOtherIncome, 167_231_800_000);
  });

  it("sums a bank's equity from Capital + Reserves & Surplus", () => {
    const bs = stmt(p.balanceSheet, "balance sheet");
    // The RBI Form-A shape has no single `Equity` total, and the PARSER
    // deliberately refuses to invent one (summing is derivation). It is summed
    // here instead: ₹3,060.19 Cr + ₹2,56,479.80 Cr = ₹2,59,539.99 Cr.
    assert.equal(bs.totalEquity, 30_601_900_000 + 2_564_798_000_000);
    assert.equal(bs.totalEquity, 2_595_399_900_000);
    // NOT OWNED for an RBI Form-A bank — MONEY-1250. `Borrowings` alone is
    // SOURCEABLE (it reproduces screener exactly for HDFCBANK and AXISBANK) and
    // is still withheld, because the number it would publish is a leverage
    // claim nobody makes: deposits are a bank's franchise, not its gearing,
    // Indian bank analysis uses CAR/CET1, and the incumbent carries NO
    // `totalDebt` for a bank on 35 of 35 comparable rows. `debtToEquity` is not
    // lender-gated, so writing this would have published D/E 1.51 for HDFCBANK
    // into a column whose honest incumbent is null.
    assert.equal(bs.totalDebt, undefined);
    assert.ok(!("totalDebt" in bs), "withheld, not present-as-undefined");
    // No `Liabilities` tag in the Form-A shape, so it falls back to A − E.
    assert.equal(bs.totalLiabilities, 19_768_582_300_000 - 2_595_399_900_000);
    // Banks do not file `CashAndCashEquivalents` in this taxonomy. Absent, not
    // zero — a bank with ₹0 cash would be a different and alarming claim.
    assert.equal(bs.totalCash, undefined);
  });

  it("bank equity is undefined when EITHER half is missing", () => {
    for (const half of [
      { bankCapital: 30_601_900_000 },
      { bankReservesAndSurplus: 2_564_798_000_000 },
    ]) {
      const p2 = projectFinancials(
        synth({ family: "banking", values: { totalAssets: 100, ...half } }),
      );
      const bs = stmt(p2.balanceSheet, "balance sheet");
      assert.equal(bs.totalEquity, undefined);
      // The half that WAS present must not be reported as the whole.
      assert.notEqual(bs.totalEquity, Object.values(half)[0]);
      assert.deepEqual(
        p2.unfilled.find((u) => u.field === "totalEquity")?.needed,
        ["bankCapital", "bankReservesAndSurplus"],
      );
    }
  });
});

describe("projectFinancials — BHARTIARTL Q2 FY20 (consolidated)", () => {
  const p = projectFinancials(BHARTI);

  it("REGRESSION: netIncome prefers profit to OWNERS over profit for the period", () => {
    // The AGR quarter. `ProfitLossForPeriod` is −₹22,830.1 Cr and INCLUDES the
    // +₹214.8 Cr attributable to non-controlling interests;
    // `ProfitOrLossAttributableToOwnersOfParent` is −₹23,044.9 Cr. Reporting a
    // subsidiary's minority profit as the parent's earnings understates the
    // loss for exactly the companies where it matters most — holding
    // structures, which is most of the Indian large-cap consolidated universe.
    const income = stmt(p.income, "income");
    assert.equal(income.netIncome, -230_449_000_000);
    assert.notEqual(income.netIncome, -228_301_000_000);
    // Both rows really are present and really do differ, or the test is vacuous.
    assert.equal(BHARTI.values.profitAttributableToOwners, -230_449_000_000);
    assert.equal(BHARTI.values.profitForPeriod, -228_301_000_000);
  });

  it("carries the negative EBITDA through without clamping it", () => {
    const income = stmt(p.income, "income");
    // −31,649.5 + 2,931.4 + 6,935.1 = −₹21,783.0 Cr AS REPORTED, which is what
    // this assertion used to pin. It carried the entire ₹30,711.0 Cr AGR
    // provision, and an exceptional item is the one thing an operating-earnings
    // number must not contain: it produced a SIGN FLIP and a −103.1%
    // `ebitdaMargin` for the most-followed telco in the country.
    //
    // Removing it — MONEY-1239 — restores +₹8,928.0 Cr, and the sign is the
    // whole point: this is the case that made the defect undeniable. The
    // clamping guard the test is named for still holds; it is asserted below on
    // a value that is now positive for a real reason rather than by accident.
    assert.equal(
      income.ebitdaBeforeExceptionalItems,
      -217_830_000_000 + 307_110_000_000,
    );
    assert.equal(income.ebitdaBeforeExceptionalItems, 89_280_000_000);
    assert.equal(income.revenueFromOperations, 211_313_000_000);
    // 211,313.0 − 221,375.0 + 29,314.0 = ₹1,925.2 Cr (MONEY-1234).
    //
    // The largest single move from dropping the depreciation addback — it was
    // 88,603,000,000, a 41.93% margin, and is now 9.11%. That is not a rounding
    // change and it is the RIGHT direction: Bharti is the most capital-intensive
    // filer in these fixtures, so the depreciation line it was crediting back
    // into "operating" income was ₹6,935.1 Cr. The result stays POSITIVE while
    // `ebitda` above is negative, because the AGR exceptional charge sits below
    // the `totalExpenses` line and therefore inside PBT but outside this figure.
    assert.equal(income.operatingIncomeExOtherIncome, 19_252_000_000);
  });

  it("reports the absent balance sheet as null, with the causes named", () => {
    // This `_WEB.xml` is income-statement only. `null` is the honest answer;
    // an object of undefineds would read as "we looked and found zeroes".
    assert.equal(p.balanceSheet, null);
    assert.deepEqual(p.unfilled, [
      { field: "totalAssets", needed: ["totalAssets"] },
      {
        field: "totalEquity",
        needed: ["totalEquity", "equityShareCapital", "otherEquity"],
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* projectFinancials — the partial-total rule                                  */
/* -------------------------------------------------------------------------- */

describe("REGRESSION: sumAll refuses a partial total", () => {
  // A total assembled from half its components is worse than no total: it is
  // plausible, it is wrong, and nothing about it says so. This is the single
  // property `sumAll` exists to enforce, so it is proved directly rather than
  // being inferred from a filing that happens to be complete.
  const missingDepreciation = synth({
    values: {
      revenueFromOperations: 1000,
      totalExpenses: 700,
      profitBeforeTax: 320,
      financeCosts: 55,
      // depreciationAndAmortisation deliberately absent.
    },
  });

  it("a filing with no depreciation yields ebitda: undefined, not PBT+finance", () => {
    const income = stmt(
      projectFinancials(missingDepreciation).income,
      "income",
    );
    assert.equal(income.ebitdaBeforeExceptionalItems, undefined);
    assert.ok(
      !("ebitdaBeforeExceptionalItems" in income),
      "ebitda must be absent from the payload",
    );
    // The specific wrong answer: 320 + 55 = 375, assembled from the two parts
    // that happened to be there. It is within 10% of a real EBITDA, so no
    // downstream sanity check would ever catch it.
    assert.notEqual(income.ebitdaBeforeExceptionalItems, 375);
  });

  it("names the field AND all three concepts it needed", () => {
    const p = projectFinancials(missingDepreciation);
    // The COLUMN name — `unfilled` is stored on the row and names the cell it
    // is explaining, which is `ebitdaBeforeExceptionalItems` (MONEY-1255).
    assert.deepEqual(
      p.unfilled.find((u) => u.field === "ebitdaBeforeExceptionalItems")
        ?.needed,
      ["profitBeforeTax", "financeCosts", "depreciationAndAmortisation"],
    );
    // The two present parts are still reported as needed. That is deliberate:
    // the reader is being told what the FIELD requires, not what is missing —
    // a list that shrinks as parts arrive cannot be diffed across filings.
  });

  it("the same filing WITH depreciation does produce the total", () => {
    // Guards the guard: proves the undefined above comes from the missing part
    // and not from some unrelated rejection of the synthetic input.
    const income = stmt(
      projectFinancials(
        synth({
          values: {
            revenueFromOperations: 1000,
            totalExpenses: 700,
            profitBeforeTax: 320,
            financeCosts: 55,
            depreciationAndAmortisation: 30,
          },
        }),
      ).income,
      "income",
    );
    assert.equal(income.ebitdaBeforeExceptionalItems, 405);
  });

  it("PINS an asymmetry: operatingIncome DOES treat a missing part as zero", () => {
    // Same function, opposite rule. `revenue − totalExpenses + (financeCosts ??
    // 0)` silently skips the addback when finance costs are absent, producing
    // exactly the plausible-but-wrong total `sumAll` refuses three lines above.
    // Pinned rather than flagged because the `?? 0` is explicit in the source
    // and reads as intentional; if it is not, this is where the decision
    // surfaces.
    //
    // The depreciation term that used to sit alongside it is gone (MONEY-1234) —
    // it made this an EBITDA rather than an EBIT. The asymmetry being pinned
    // here is about the `?? 0`, not about which lines are added back, so the
    // expected value is unchanged.
    const income = stmt(
      projectFinancials(
        synth({ values: { revenueFromOperations: 1000, totalExpenses: 700 } }),
      ).income,
      "income",
    );
    assert.equal(income.operatingIncomeExOtherIncome, 300);
    // With a finance-costs line present it would have been 300 + n.
    assert.notEqual(income.operatingIncomeExOtherIncome, undefined);
  });

  it("PINS the debt fallback: a partial borrowings figure IS reported", () => {
    // `sumAll` refuses, then the `??` chain accepts the single half anyway. For
    // debt that is defensible (a filer with no long-term borrowings often omits
    // the line rather than filing 0), but it is the opposite of the EBITDA rule
    // and is worth stating.
    const bs = stmt(
      projectFinancials(
        synth({ values: { totalAssets: 5000, borrowingsCurrent: 120 } }),
      ).balanceSheet,
      "balance sheet",
    );
    assert.equal(bs.totalDebt, 120);
  });
});

describe("projectFinancials — nothing usable", () => {
  it("yields income: null, not an object of undefineds", () => {
    // The distinction the caller depends on: `null` means "no income statement
    // here". An object with four undefined fields serialises to `{}` and reads
    // downstream as a statement that exists and is empty.
    const p = projectFinancials(synth({ values: { otherIncome: 42 } }));
    assert.equal(p.income, null);
    assert.equal(p.balanceSheet, null);
  });

  it("still names every field it could not fill, and why", () => {
    const p = projectFinancials(synth({ values: { otherIncome: 42 } }));
    // `field` is the COLUMN, `needed` is the CONCEPT — MONEY-1255, and this is
    // the one place the two vocabularies sit side by side. They coincide for
    // `revenueFromOperations` (the column took the concept's name) and diverge
    // for the other two, which is exactly why the column half had to move.
    assert.deepEqual(p.unfilled, [
      {
        field: "ebitdaBeforeExceptionalItems",
        needed: [
          "profitBeforeTax",
          "financeCosts",
          "depreciationAndAmortisation",
        ],
      },
      {
        field: "operatingIncomeExOtherIncome",
        needed: ["revenueFromOperations", "totalExpenses"],
      },
      { field: "revenueFromOperations", needed: ["revenueFromOperations"] },
      {
        field: "netIncome",
        needed: ["profitAttributableToOwners", "profitForPeriod"],
      },
      { field: "totalAssets", needed: ["totalAssets"] },
      {
        field: "totalEquity",
        needed: ["totalEquity", "equityShareCapital", "otherEquity"],
      },
    ]);
  });

  it("a reported 0 is a value and keeps the statement alive", () => {
    // `0` revenue is a claim about the world (a shell company, a suspended
    // plant). It must not collapse to `income: null` the way absence does.
    const p = projectFinancials(
      synth({ values: { revenueFromOperations: 0, profitForPeriod: 0 } }),
    );
    const income = stmt(p.income, "income");
    assert.equal(income.revenueFromOperations, 0);
    assert.equal(income.netIncome, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1234 — a TAGGED zero is not a REPORTED zero                          */
/* -------------------------------------------------------------------------- */

describe("projectFinancials — attributable-to-owners tagged as literal 0", () => {
  // 2,490 of 18,381 ANNUAL filings on prod tag
  // `ProfitOrLossAttributableToOwnersOfParent` as 0 beside a material
  // `profitForPeriod`. The parser is innocent — self-closing (nil) facts are
  // skipped and empty text is rejected before coercion, precisely so a blank
  // never becomes a zero. These filings genuinely carry `0`, and `??` cannot
  // help, because 0 is a perfectly good value.
  //
  // Resolved by the accounting identity `attributable + nonControlling =
  // profitForPeriod` rather than by a magnitude threshold — a threshold would
  // corrupt the one shape where the zero is REAL.

  it("re-derives the owners' share when NCI is reported as zero too", () => {
    // The 2,480-filing majority: "owners got 0" AND "minorities got 0" out of a
    // material profit — arithmetically impossible, so the tagging is wrong.
    const p = projectFinancials(
      synth({
        values: {
          profitAttributableToOwners: 0,
          profitAttributableToNonControllingInterests: 0,
          profitForPeriod: 709_700_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 709_700_000);
  });

  it("re-derives when NCI is absent entirely (standalone filings)", () => {
    // 981 of the 2,490 are STANDALONE, where non-controlling interests cannot
    // exist by construction, so attributable MUST equal the period profit.
    const p = projectFinancials(
      synth({
        values: {
          profitAttributableToOwners: 0,
          profitForPeriod: 836_200_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 836_200_000);
  });

  it("KEEPS a zero the identity supports — the 4 real cases", () => {
    // Wholly minority-attributed profit. The zero is the truth here, and a
    // "profit is large, so use the total" rule would have replaced it with a
    // number belonging to somebody else. This is why the fix reads the identity
    // rather than the magnitude.
    const p = projectFinancials(
      synth({
        values: {
          profitAttributableToOwners: 0,
          profitAttributableToNonControllingInterests: 500_000_000,
          profitForPeriod: 500_000_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 0);
  });

  it("subtracts a PARTIAL minority share rather than taking the total", () => {
    // The identity yields the owners' share directly. Falling back to
    // `profitForPeriod` wholesale would hand minorities' profit to the parent —
    // the very thing the original preference exists to prevent.
    const p = projectFinancials(
      synth({
        values: {
          profitAttributableToOwners: 0,
          profitAttributableToNonControllingInterests: 200_000_000,
          profitForPeriod: 900_000_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 700_000_000);
  });

  it("leaves a NON-zero attributable alone, even against a larger total", () => {
    // The MONEY-1115 behaviour this must not regress: a real owners' share wins
    // over `profitForPeriod` for holding structures.
    const p = projectFinancials(
      synth({
        values: {
          profitAttributableToOwners: 300_000_000,
          profitAttributableToNonControllingInterests: 100_000_000,
          profitForPeriod: 400_000_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 300_000_000);
  });

  it("re-derives DHANUKA's lazy NEAR-zero when NCI is 0", () => {
    // MONEY-1250. Real prod filing: the owners' share is tagged 1 crore against
    // a 126 crore profit with NCI at 0 — the identity leaves nothing for the 1
    // crore to be a share OF. `=== 0` cannot see it, so this wrote a 126x
    // understatement straight into netMargin and ROE.
    const p = projectFinancials(
      synth({
        values: {
          profitAttributableToOwners: 10_000_000,
          profitAttributableToNonControllingInterests: 0,
          profitForPeriod: 1_261_777_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 1_261_777_000);
  });

  it("an ABSENT NCI on a CONSOLIDATED filing is UNKNOWN, not zero", () => {
    // MONEY-1250 review. Where the element is missing the identity
    // `att + nci = pfp` cannot be evaluated, so treating absence as zero takes
    // the identity's word for a term the document never supplies. The 26-row
    // census called this "nothing to attribute away" — that inference WAS the
    // defect, and the dataset contains the shape: IITL FY2021 carries an
    // untagged minority interest (owners -41.94, total -46.79, no NCI element).
    //
    // Without the basis guard this writes 100 crore for a company whose filing
    // credits its owners with 2 — a 50x overstatement, into a column whose
    // unique key has no `source`.
    const p = projectFinancials(
      synth({
        basis: "consolidated",
        values: {
          profitAttributableToOwners: 20_000_000, // 2 cr
          profitForPeriod: 1_000_000_000, // 100 cr
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 20_000_000);
  });

  it("an ABSENT NCI on a STANDALONE filing really is zero", () => {
    // The other side, and why `basis` is the right discriminator rather than a
    // blanket refusal: a standalone filing has no subsidiaries, so minorities
    // cannot exist and the absence is informative. 3 of the 13 intended rows are
    // this shape and must keep being corrected.
    const p = projectFinancials(
      synth({
        basis: "standalone",
        values: {
          profitAttributableToOwners: 20_000_000, // 2 cr
          profitForPeriod: 1_000_000_000, // 100 cr
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 1_000_000_000);
  });

  it("PASSES VADILALIND's tags THROUGH — the identity cannot adjudicate them", () => {
    // CORRECTED, MONEY-1255. This test was called "a near-zero the identity
    // CONFIRMS" and its comment said the row is "a genuinely wholly-minority-
    // owned structure whose owners really did take -47,000". Both claims are
    // false, and the reason is one line of arithmetic:
    //
    //     att -47,000    + nci 413,835,000 = 413,788,000 = pfp   EXACT
    //     att 413,835,000 + nci    -47,000 = 413,788,000 = pfp   EXACT
    //
    // `attributable + nonControlling = profitForPeriod` is SYMMETRIC in its two
    // addends, so it closes just as exactly on the SWAPPED assignment. It can
    // reject a pair that breaks it (COFFEEDAY, below) and it can never elect
    // one of two that keep it. The filing's own EPS — `basicEps x
    // (paidUpEquityShareCapital / faceValuePerShare)`, the arbiter this module
    // already uses for the `bothLinesNegated` census — points at the 41.38
    // crore side, so the tags are very probably swapped.
    //
    // The ASSERTION is unchanged, because the BEHAVIOUR is unchanged and is
    // deliberate: an EPS-arbitrated swap detector is a separate rule with its
    // own blast radius over a table whose `@@unique` carries no `source`, and
    // it needs its own ticket and its own whole-population replay. What this
    // test pins is that we pass the filing's tags through UNMODIFIED — we do
    // not invent the 41 crore, and we do not invent anything else either.
    //
    // WHAT IT DOES AND DOES NOT CATCH — mutation-measured, MONEY-1250, and the
    // measurement still stands. Removing the NCI gate ALONE does not fail it:
    // without the gate the row re-derives to `pfp - nci`, which is -47,000, the
    // same answer. It DOES fail the naive rule a reader is likely to reach for,
    // "near zero? take the total", i.e. dropping the gate AND substituting
    // `profitForPeriod` for the re-derivation. Do not read this as cover for
    // the gate; COFFEEDAY below is what pins that.
    const p = projectFinancials(
      synth({
        values: {
          profitAttributableToOwners: -47_000,
          profitAttributableToNonControllingInterests: 413_835_000,
          profitForPeriod: 413_788_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, -47_000);
  });

  it("the attribution identity is SYMMETRIC — it cannot elect either reading", () => {
    // The falsifier for the claim the test above used to make. If the identity
    // were evidence for the tagged assignment, the SWAPPED filing would have to
    // be treated differently — it is the competing hypothesis. It is not: both
    // filings satisfy `att + nci = pfp` to the rupee, and the projection simply
    // reports whichever line the filer put in the owners' slot.
    //
    // So a change that starts adjudicating between the two must break THIS
    // test, not the one above — which is the point of having it: the assertion
    // above passes under both the correct and the mistaken reading of why.
    const values = {
      profitAttributableToOwners: -47_000,
      profitAttributableToNonControllingInterests: 413_835_000,
      profitForPeriod: 413_788_000,
    };
    const swapped = {
      profitAttributableToOwners: 413_835_000,
      profitAttributableToNonControllingInterests: -47_000,
      profitForPeriod: 413_788_000,
    };
    // The identity closes on BOTH — that is the whole finding.
    assert.equal(
      values.profitAttributableToOwners +
        values.profitAttributableToNonControllingInterests,
      values.profitForPeriod,
    );
    assert.equal(
      swapped.profitAttributableToOwners +
        swapped.profitAttributableToNonControllingInterests,
      swapped.profitForPeriod,
    );
    // And the projection follows the SLOT, not the identity.
    assert.equal(
      stmt(projectFinancials(synth({ values })).income, "income").netIncome,
      -47_000,
    );
    assert.equal(
      stmt(projectFinancials(synth({ values: swapped })).income, "income")
        .netIncome,
      413_835_000,
    );
  });

  it("REFUSES COFFEEDAY — a near-zero whose identity is BROKEN", () => {
    // The 7 unresolvable rows. -2,40,00,000 + -1,00,00,000 = -3,40,00,000, which
    // is not the 1,48,30,00,000 the same document reports. Re-deriving would
    // assert 1,49,30,00,000 — a number nothing in the filing supports. Declining
    // to claim beats compensating, and this table has no `source` in its key.
    const p = projectFinancials(
      synth({
        values: {
          profitAttributableToOwners: -24_000_000,
          profitAttributableToNonControllingInterests: -10_000_000,
          profitForPeriod: 1_483_000_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, -24_000_000);
  });

  it("holds the band at 2% — a 3% share is a real share", () => {
    // The boundary is load-bearing: 13 further prod rows sit between 2% and 5%,
    // and nothing distinguishes them from a small genuine minority stake.
    const p = projectFinancials(
      synth({
        values: {
          profitAttributableToOwners: 3_000_000,
          profitAttributableToNonControllingInterests: 0,
          profitForPeriod: 100_000_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 3_000_000);
  });

  it("a genuine all-zero filing still reports 0", () => {
    // Nothing to re-derive: the identity yields 0 as well, so the guard must not
    // manufacture a value out of an empty result.
    const p = projectFinancials(
      synth({ values: { profitAttributableToOwners: 0, profitForPeriod: 0 } }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* deriveRatios                                                                */
/* -------------------------------------------------------------------------- */

describe("deriveRatios — real filings", () => {
  it("derives GLAXO's margins and returns from the projected statements", () => {
    // GLAXO_PRIOR carries the SAME balances, so the averaged denominator equals
    // the closing one and every expectation below is unchanged by MONEY-1250.
    const r = deriveRatios(GLAXO, priorOf(GLAXO));
    // 2,486.9 / 10,000.5 = 24.87%; 3,020.9 / 10,000.5 = 30.21%.
    //
    // `operatingMargin` moved 31.89 -> 30.21 with MONEY-1234, and this is the
    // test that proves `deriveRatios` has no second copy of the formula: it
    // reads `projectFinancials`' `operatingIncome` rather than recomputing, so
    // one definition change moves the stored ratio too. Every consumer of
    // `StockRatios.operatingMargin` — the screener's "High Margin Moats" preset
    // among them — shifts by depreciation/revenue.
    assert.ok(r.netMargin !== undefined);
    assert.equal(r.netMargin.toFixed(2), "24.87");
    assert.ok(r.operatingMargin !== undefined);
    assert.equal(r.operatingMargin.toFixed(2), "30.21");
    // QUARTERLY return, deliberately not annualised — 2,486.9 / 16,746.6.
    assert.ok(r.roe !== undefined);
    assert.equal(r.roe.toFixed(2), "14.85");
    assert.ok(r.roa !== undefined);
    assert.equal(r.roa.toFixed(2), "6.67");
    assert.ok(r.debtToEquity !== undefined);
    assert.equal(r.debtToEquity.toFixed(4), "0.0063");
  });

  it("REGRESSION: banking ratios are PASSED THROUGH, not recomputed", () => {
    const r = deriveRatios(ICICI);
    // ICICI's published Q2-FY25: GNPA 1.97%, NNPA 0.42%, CET1 14.65%. The
    // filing states them; recomputing GNPA from GrossNonPerformingAssets /
    // advances gives 271,211.5 / 12,772,404.3 = 2.12%, which disagrees with the
    // bank's own published figure over a definitional detail we cannot see.
    assert.equal(r.grossNpaRatio, 0.0197);
    assert.equal(r.netNpaRatio, 0.0042);
    assert.equal(r.cet1Ratio, 0.1465);
    assert.equal(r.grossNpaRatio, ICICI.values.grossNpaRatio);
    assert.notEqual(
      r.grossNpaRatio,
      (ICICI.values.grossNpa ?? 0) / (ICICI.values.advances ?? 1),
    );
  });

  it("omits balance-sheet ratios entirely when there is no balance sheet", () => {
    // BHARTIARTL files no balance sheet. ROE/ROA/D-E must be ABSENT keys, not
    // present-and-undefined — a JSON payload with `"roe": null` reads as a
    // measured zero-ish value to anything that coerces.
    const r = deriveRatios(BHARTI);
    assert.ok(!("roe" in r));
    assert.ok(!("roa" in r));
    assert.ok(!("debtToEquity" in r));
    // The income-side ratios still resolve: −23,044.9 / 21,131.3 = −109.06%.
    assert.ok(r.netMargin !== undefined);
    assert.equal(r.netMargin.toFixed(2), "-109.06");
  });
});

describe("REGRESSION: a degenerate denominator yields undefined, never Infinity", () => {
  // The non-finite defect class this repo keeps re-fixing. Infinity flows into
  // a chart axis or a screener sort and lands at an extreme, so a company with
  // zero equity tops a "highest ROE" list — silently, and forever.
  const cases: ReadonlyArray<
    [
      string,
      Partial<Record<XbrlConcept, number>>,
      keyof ReturnType<typeof deriveRatios>,
    ]
  > = [
    [
      "roe with zero equity",
      { profitForPeriod: 100, totalEquity: 0, totalAssets: 500 },
      "roe",
    ],
    [
      "roa with zero assets",
      { profitForPeriod: 100, totalAssets: 0, totalEquity: 500 },
      "roa",
    ],
    [
      "netMargin with zero revenue",
      { revenueFromOperations: 0, profitForPeriod: 100 },
      "netMargin",
    ],
    [
      "debtToEquity with zero equity",
      { borrowingsCurrent: 40, borrowingsNonCurrent: 60, totalEquity: 0 },
      "debtToEquity",
    ],
  ];

  for (const [label, values, key] of cases) {
    it(`${label} → undefined, and the key is absent`, () => {
      const r = deriveRatios(synth({ values }));
      assert.equal(r[key], undefined);
      assert.ok(!(key in r), `${key} must not be present-as-undefined`);
      // Belt and braces: whatever IS present must be finite.
      //
      // `returnBasis` is the ONE non-numeric key on DerivedRatios — the
      // denominator STAMP for roe/roa, not a measurement (MONEY-1250). Skipped
      // by NAME and asserted to be one of its two literals, rather than by a
      // loose `typeof v === "number"` filter that would also wave through a
      // future string field nobody meant to add.
      for (const [k, v] of Object.entries(r)) {
        if (k === "returnBasis") {
          assert.ok(
            v === "AVERAGE" || v === "CLOSING",
            `returnBasis must be AVERAGE or CLOSING, got ${String(v)}`,
          );
          continue;
        }
        assert.ok(Number.isFinite(v), `${k} is not finite: ${String(v)}`);
      }
    });
  }

  it("NEGATIVE equity → roe undefined, not a large negative", () => {
    // A negative-equity company (accumulated losses exceeding capital) with a
    // profit produces roe = 100 / −50 = −200%. That is not "bad ROE", it is a
    // meaningless ratio — and it sorts to the TOP of an ascending screener,
    // which is how a distressed balance sheet becomes a recommendation.
    // A PRIOR year is supplied because roe/roa are now averaged (MONEY-1250);
    // identical values keep the average equal to the closing balance, so this
    // still tests the denominator guard and nothing else.
    const cur = synth({
      values: { profitForPeriod: 100, totalEquity: -50, totalAssets: 500 },
    });
    const r = deriveRatios(cur, priorOf(cur));
    assert.equal(r.roe, undefined);
    assert.ok(!("roe" in r));
    assert.notEqual(r.roe, -200);
    // roa is unaffected — a negative denominator is refused per-ratio, not
    // per-filing, so a usable number is not discarded alongside the bad one.
    assert.ok(r.roa !== undefined);
    assert.equal(r.roa, 20);
  });

  it("negative equity also refuses debtToEquity", () => {
    const r = deriveRatios(
      synth({ values: { borrowingsCurrent: 100, totalEquity: -50 } }),
    );
    assert.equal(r.debtToEquity, undefined);
    assert.ok(!("debtToEquity" in r));
  });
});

describe("REGRESSION: a zero NUMERATOR is a real value and survives", () => {
  // The counterpart to the guard above, and the easy thing to break while
  // fixing it: a break-even quarter has a net margin of 0%, which is a
  // measurement. Collapsing it to undefined loses a fact; the guard belongs on
  // the denominator only.
  it("netIncome 0 → netMargin 0, not undefined", () => {
    const r = deriveRatios(
      synth({ values: { revenueFromOperations: 1000, profitForPeriod: 0 } }),
    );
    assert.equal(r.netMargin, 0);
    assert.ok("netMargin" in r, "a zero ratio must be REPORTED, not dropped");
  });

  it("netIncome 0 → roe 0 and roa 0 on a real balance sheet", () => {
    const cur = synth({
      values: {
        revenueFromOperations: 1000,
        profitForPeriod: 0,
        totalEquity: 500,
        totalAssets: 900,
      },
    });
    const r = deriveRatios(cur, priorOf(cur));
    assert.equal(r.roe, 0);
    assert.equal(r.roa, 0);
  });

  it("zero DEBT → debtToEquity 0, which is the strongest balance sheet there is", () => {
    const r = deriveRatios(
      synth({
        values: {
          borrowingsCurrent: 0,
          borrowingsNonCurrent: 0,
          totalEquity: 500,
        },
      }),
    );
    assert.equal(r.debtToEquity, 0);
    assert.ok("debtToEquity" in r);
  });
});

describe("growthPct — the base must be strictly positive", () => {
  it("computes an ordinary year-on-year change", () => {
    assert.equal(growthPct(150, 100), 50);
    assert.equal(growthPct(80, 100), -20);
  });

  it("REGRESSION: a LOSS NARROWING returns undefined, not a signed number", () => {
    // −100 → −50 is a 50% improvement, a −50% change, or a +50% change,
    // depending on which sign convention you pick. Every one of them is
    // defensible, which is exactly why none may be picked silently.
    assert.equal(growthPct(-50, -100), undefined);
    assert.notEqual(growthPct(-50, -100), -50);
    assert.notEqual(growthPct(-50, -100), 50);
    // A loss WIDENING off a negative base is equally refused.
    assert.equal(growthPct(-200, -100), undefined);
    // And so is a swing back to profit — the base is still unusable.
    assert.equal(growthPct(50, -100), undefined);
  });

  it("a zero base is refused rather than divided by", () => {
    assert.equal(growthPct(100, 0), undefined);
    assert.equal(growthPct(0, 0), undefined);
  });

  it("a zero CURRENT against a positive base is −100%, a real answer", () => {
    assert.equal(growthPct(0, 100), -100);
  });

  it("non-finite input is refused on either side", () => {
    assert.equal(growthPct(Number.NaN, 100), undefined);
    assert.equal(growthPct(100, Number.POSITIVE_INFINITY), undefined);
    assert.equal(growthPct(undefined, 100), undefined);
    assert.equal(growthPct(100, undefined), undefined);
  });
});

describe("deriveRatios — growth against a prior-year filing", () => {
  const current = synth({
    values: { revenueFromOperations: 1200, profitForPeriod: 150 },
  });

  /**
   * A prior that is genuinely ONE FISCAL YEAR EARLIER, on the SAME basis.
   *
   * UPDATED BY MONEY-1346, and the update is what the fixture always claimed
   * to be. `synth`'s default period is 2025-07-01..2025-09-30 for BOTH
   * arguments, so the "prior-year filing" these cases passed in shared the
   * current one's period end — a filing zero days earlier. Growth was computed
   * anyway because it was the only two-year ratio in `deriveRatios` NOT gated
   * on `isAdjacentAnnual`, so the fixture's unreality was invisible.
   */
  const priorYear = (values: Partial<Record<XbrlConcept, number>>) =>
    synth({
      values,
      period: { start: "2024-07-01", end: "2024-09-30", days: 91 },
    });

  it("computes growth only when a prior filing is handed in", () => {
    const without = deriveRatios(current);
    assert.ok(!("revenueGrowth" in without));
    assert.ok(!("earningsGrowth" in without));

    const with_ = deriveRatios(
      current,
      priorYear({ revenueFromOperations: 1000, profitForPeriod: 100 }),
    );
    assert.equal(with_.revenueGrowth, 20);
    assert.equal(with_.earningsGrowth, 50);
  });

  it("REGRESSION: a prior-year LOSS leaves earningsGrowth absent", () => {
    // The turnaround quarter: −100 → +150. A percentage change off a loss is
    // uninterpretable, so the field is omitted while revenue growth — which
    // has a usable base — still resolves. Dropping BOTH would be the easy
    // over-correction.
    const r = deriveRatios(
      current,
      priorYear({ revenueFromOperations: 1000, profitForPeriod: -100 }),
    );
    assert.ok(!("earningsGrowth" in r));
    assert.equal(r.revenueGrowth, 20);
  });

  /* ── MONEY-1346: growth needs the same ENTITY, not just a prior row ─────── */

  it("refuses growth across a CONSOLIDATED/STANDALONE pair", () => {
    // The consolidation gap wearing a growth label. For any holding company
    // the two bases differ by a MULTIPLE — CLAUDE.md records 360ONE FY2025
    // total assets as 19,768 Cr consolidated against 7,332 Cr standalone — so
    // "revenue grew 20%" here would be the group/parent ratio, and nothing on
    // the row would say so. `selectPeriodWinners` and
    // `selectAnnualExtractsByPeriod` both group WITHOUT basis, so this pair is
    // reachable on BOTH the filing and the document path.
    const r = deriveRatios(
      synth({
        values: { revenueFromOperations: 1200, profitForPeriod: 150 },
        basis: "consolidated",
      }),
      synth({
        values: { revenueFromOperations: 1000, profitForPeriod: 100 },
        basis: "standalone",
        period: { start: "2024-07-01", end: "2024-09-30", days: 91 },
      }),
    );
    assert.ok(!("revenueGrowth" in r), "a basis change is not growth");
    assert.ok(!("earningsGrowth" in r));
  });

  it("refuses growth when the prior is more than one year back", () => {
    // `isAdjacentAnnual`'s 550-day window. Only 59.7% of judged symbols hold
    // the adjacent prior, so this is the common case rather than the exotic
    // one: a 2022 prior against a 2025 current is a THREE-year change, and
    // publishing it in a column every reader takes for year-on-year is wrong
    // by a factor nothing on the row reveals.
    const r = deriveRatios(
      current,
      synth({
        values: { revenueFromOperations: 1000, profitForPeriod: 100 },
        period: { start: "2022-07-01", end: "2022-09-30", days: 91 },
      }),
    );
    assert.ok(!("revenueGrowth" in r));
    assert.ok(!("earningsGrowth" in r));
  });

  it("still computes growth for the adjacent same-basis pair", () => {
    // The control. Without it, a mutation refusing growth ALWAYS passes both
    // refusal cases above — the over-correction that costs the column entirely.
    const r = deriveRatios(
      synth({
        values: { revenueFromOperations: 1200, profitForPeriod: 150 },
        basis: "consolidated",
      }),
      synth({
        values: { revenueFromOperations: 1000, profitForPeriod: 100 },
        basis: "consolidated",
        period: { start: "2024-07-01", end: "2024-09-30", days: 91 },
      }),
    );
    assert.equal(r.revenueGrowth, 20);
    assert.equal(r.earningsGrowth, 50);
  });
});

/* -------------------------------------------------------------------------- */
/* reconcile — the ladder                                                      */
/* -------------------------------------------------------------------------- */

describe("reconcile — the verdict ladder", () => {
  it("MATCH inside the default 1% tolerance", () => {
    // Filings are printed in ₹ lakh or ₹ crore with two decimals and vendors
    // round differently, so a 0.4% gap is presentation, not disagreement.
    assert.deepEqual(reconcile(1004, 1000), {
      verdict: "MATCH",
      relativeDiff: 0.004,
    });
    // Exactly at the bound is a MATCH: `<=`, not `<`.
    assert.equal(reconcile(1010, 1000).verdict, "MATCH");
  });

  it("a 2% gap is a DISAGREEMENT — the tolerance is really applied", () => {
    assert.equal(reconcile(1020, 1000).verdict, "DISAGREEMENT");
    assert.equal(
      reconcile(1020, 1000, { tolerance: 0.05 }).verdict,
      "MATCH",
      "a caller-supplied tolerance must be honoured",
    );
  });

  it("SCALE_MISMATCH for the lakh↔crore factor, with the factor reported", () => {
    // Our number in ₹ lakh against theirs in ₹ crore.
    assert.deepEqual(reconcile(100_000, 1000), {
      verdict: "SCALE_MISMATCH",
      relativeDiff: 99,
      scaleFactor: 100,
    });
    // And the other direction — ours in crore, theirs in lakh.
    assert.deepEqual(reconcile(10, 1000), {
      verdict: "SCALE_MISMATCH",
      relativeDiff: 0.99,
      scaleFactor: 100,
    });
  });

  it("SCALE_MISMATCH for a plain power of ten", () => {
    const r = reconcile(10_000, 1000);
    assert.equal(r.verdict, "SCALE_MISMATCH");
    assert.equal(r.scaleFactor, 10);
  });

  it("SIGN_MISMATCH when the magnitudes agree and only the sign flips", () => {
    // The loss-convention case: we file −₹100 Cr, the vendor publishes ₹100 Cr
    // and expects the reader to know it is a loss.
    const r = reconcile(-1000, 1000);
    assert.equal(r.verdict, "SIGN_MISMATCH");
    assert.equal(r.relativeDiff, 2);
    assert.equal(r.scaleFactor, undefined);
  });

  it("a sign flip with DIFFERENT magnitudes is a DISAGREEMENT", () => {
    // −3000 against 1000 is not a convention difference; it is two different
    // numbers that also disagree about sign, and it needs a human.
    assert.equal(reconcile(-3000, 1000).verdict, "DISAGREEMENT");
  });

  it("REGRESSION: sign is checked BEFORE scale", () => {
    // A value that is BOTH sign-flipped and off by the lakh/crore factor: we
    // report −100,000 (₹ lakh, loss negative), they report 1,000 (₹ crore, loss
    // positive). The module header states the rule outright — "A sign flip with
    // a scale factor is still fundamentally a sign problem, and reporting it as
    // SCALE_MISMATCH would send the reader looking for a units bug that is not
    // there."
    const r = reconcile(-100_000, 1000);

    // The half that is genuinely load-bearing and DOES hold: the scale ladder
    // is unreachable once the signs differ, so the reader is never sent hunting
    // a units bug.
    assert.notEqual(r.verdict, "SCALE_MISMATCH");
    assert.equal(r.scaleFactor, undefined);

    // The half the header PROMISES: that this reads as a sign problem.
    assert.equal(
      r.verdict,
      "SIGN_MISMATCH",
      "header claims sign wins over scale; a flipped+scaled value must read as SIGN_MISMATCH",
    );
  });

  it("INCOMPARABLE when either side is absent or non-finite", () => {
    // Nothing to compare is not the same as disagreeing, and conflating them
    // is how a source with no data at all looks like a source that is wrong.
    for (const [ours, theirs] of [
      [undefined, 1000],
      [1000, undefined],
      [undefined, undefined],
      [Number.NaN, 1000],
      [1000, Number.NaN],
      [Number.POSITIVE_INFINITY, 1000],
      [1000, Number.NEGATIVE_INFINITY],
    ] as ReadonlyArray<[number | undefined, number | undefined]>) {
      const r = reconcile(ours, theirs);
      assert.equal(
        r.verdict,
        "INCOMPARABLE",
        `${String(ours)} vs ${String(theirs)}`,
      );
      assert.equal(r.relativeDiff, undefined);
    }
  });

  it("both zero is a MATCH", () => {
    assert.deepEqual(reconcile(0, 0), { verdict: "MATCH", relativeDiff: 0 });
  });

  it("a zero on exactly ONE side is a DISAGREEMENT, either way round", () => {
    // A zero cannot be scaled or signed into agreement with a non-zero, and
    // dividing by it would be the non-finite bug this module exists to avoid.
    assert.equal(reconcile(0, 1000).verdict, "DISAGREEMENT");
    assert.equal(reconcile(1000, 0).verdict, "DISAGREEMENT");
    assert.equal(reconcile(-1000, 0).verdict, "DISAGREEMENT");
  });

  it("REGRESSION: the zero-on-one-side branch does not emit a non-finite relativeDiff", () => {
    // No division by zero happens — but `Infinity` is written into the field by
    // hand, which lands in exactly the same place: `relativeDiff` is a reported
    // number, and `JSON.stringify({relativeDiff: Infinity})` is
    // `{"relativeDiff": null}` — indistinguishable from "we had no value".
    const r = reconcile(1000, 0);
    assert.equal(r.verdict, "DISAGREEMENT");
    assert.ok(
      r.relativeDiff === undefined || Number.isFinite(r.relativeDiff),
      `relativeDiff must be finite or absent, got ${String(r.relativeDiff)}`,
    );
  });

  it("is symmetric about which side is zero in VERDICT, and pure", () => {
    // No module state: repeated calls with interleaved inputs agree.
    const a = reconcile(1004, 1000);
    reconcile(-1, 1);
    reconcile(undefined, undefined);
    assert.deepEqual(reconcile(1004, 1000), a);
  });
});

/* -------------------------------------------------------------------------- */
/* chooseAuthority                                                             */
/* -------------------------------------------------------------------------- */

describe("chooseAuthority — the declared order, in one place", () => {
  it("NSE_XBRL displaces TICKERTAPE, and reports what it displaced", () => {
    // MONEY-1175's lesson: a silent overwrite is indistinguishable from never
    // having had the other value, so the loser is RETURNED, not discarded.
    assert.deepEqual(chooseAuthority("NSE_XBRL", "TICKERTAPE"), {
      winner: "NSE_XBRL",
      displaced: "TICKERTAPE",
      keepIncumbent: false,
    });
  });

  it("TICKERTAPE does NOT displace NSE_XBRL", () => {
    assert.deepEqual(chooseAuthority("TICKERTAPE", "NSE_XBRL"), {
      winner: "NSE_XBRL",
      displaced: null,
      keepIncumbent: true,
    });
  });

  it("an absent incumbent always loses — filling a gap is not a conflict", () => {
    for (const challenger of FINANCIALS_AUTHORITY) {
      assert.deepEqual(chooseAuthority(challenger, null), {
        winner: challenger,
        displaced: null,
        keepIncumbent: false,
      });
    }
  });

  it("equal rank is a refresh and is allowed", () => {
    // A corrected filing must be able to replace its own earlier reading.
    const d = chooseAuthority("NSE_XBRL", "NSE_XBRL");
    assert.equal(d.winner, "NSE_XBRL");
    assert.equal(d.keepIncumbent, false);
  });

  it("the whole order is transitive and matches FINANCIALS_AUTHORITY", () => {
    // Proves the ladder rather than spot-checking two rungs: every source beats
    // every source below it and loses to every source above it.
    for (let i = 0; i < FINANCIALS_AUTHORITY.length; i++) {
      for (let j = 0; j < FINANCIALS_AUTHORITY.length; j++) {
        const challenger = FINANCIALS_AUTHORITY[i]!;
        const incumbent = FINANCIALS_AUTHORITY[j]!;
        const d = chooseAuthority(challenger, incumbent);
        assert.equal(
          d.keepIncumbent,
          i > j,
          `${challenger} vs ${incumbent} (ranks ${i} vs ${j})`,
        );
      }
    }
  });

  it("REGRESSION: an UNKNOWN source ranks LAST and never throws", () => {
    // A new upstream appearing must not crash a write path. Ranking it last
    // means it can only ever fill a gap.
    assert.deepEqual(chooseAuthority("MYSTERY_FEED", null), {
      winner: "MYSTERY_FEED",
      displaced: null,
      keepIncumbent: false,
    });
    for (const known of FINANCIALS_AUTHORITY) {
      const d = chooseAuthority("MYSTERY_FEED", known);
      assert.equal(
        d.keepIncumbent,
        true,
        `MYSTERY_FEED must not displace ${known}`,
      );
      assert.equal(d.winner, known);
      assert.equal(d.displaced, null);
    }
  });

  it("a known source displaces an unknown incumbent", () => {
    assert.deepEqual(chooseAuthority("NSE_XBRL", "MYSTERY_FEED"), {
      winner: "NSE_XBRL",
      displaced: "MYSTERY_FEED",
      keepIncumbent: false,
    });
    // Even the weakest known source outranks an unknown one.
    assert.equal(chooseAuthority("YAHOO", "MYSTERY_FEED").keepIncumbent, false);
  });
});

/* -------------------------------------------------------------------------- */
/* judgeSwitchoverReadiness — the gate                                         */
/* -------------------------------------------------------------------------- */

describe("judgeSwitchoverReadiness — the gate the switchover turns on", () => {
  it("the happy path is reachable — a gate that never opens is not a gate", () => {
    const r = judgeSwitchoverReadiness(repeat(25, "MATCH"));
    assert.equal(r.ready, true);
    assert.equal(r.compared, 25);
    assert.equal(r.matched, 25);
    assert.match(r.reason, /25\/25 comparable matched/);
  });

  it("tolerates a disagreement rate at the threshold but not above it", () => {
    // 1 in 20 is exactly 5%: `>` not `>=`, so it passes.
    const at = judgeSwitchoverReadiness([
      ...repeat(19, "MATCH"),
      "DISAGREEMENT",
    ]);
    assert.equal(at.ready, true);
    // 2 in 20 is 10% and does not.
    const over = judgeSwitchoverReadiness([
      ...repeat(18, "MATCH"),
      ...repeat(2, "DISAGREEMENT"),
    ]);
    assert.equal(over.ready, false);
    assert.match(
      over.reason,
      /disagreement rate 10\.0% \(2\/20 comparable\) exceeds 5\.0%/,
    );
  });

  it("below minCompared is not ready, whatever the verdicts say", () => {
    // 19 perfect matches is still not enough evidence to move a data source
    // that every downstream valuation reads.
    const r = judgeSwitchoverReadiness(repeat(19, "MATCH"));
    assert.equal(r.ready, false);
    assert.equal(r.matched, 19);
    assert.match(r.reason, /only 19 COMPARABLE pair\(s\)/);
    // And the floor is caller-adjustable, so a narrow symbol can still ship.
    assert.equal(
      judgeSwitchoverReadiness(repeat(19, "MATCH"), { minCompared: 10 }).ready,
      true,
    );
  });

  it("REGRESSION: ANY scale mismatch blocks outright, regardless of rate", () => {
    // 1 in 200 is 0.5% — under every rate threshold there is. But a units bug
    // is SYSTEMATIC: one occurrence implies a whole class of periods is wrong,
    // so a percentage is the wrong instrument for it.
    const r = judgeSwitchoverReadiness([
      ...repeat(199, "MATCH"),
      "SCALE_MISMATCH",
    ]);
    assert.equal(r.ready, false);
    assert.equal(r.scaleMismatches, 1);
    assert.match(r.reason, /SCALE mismatch/);
    // Not even an explicitly permissive rate can wave it through.
    assert.equal(
      judgeSwitchoverReadiness([...repeat(199, "MATCH"), "SCALE_MISMATCH"], {
        maxDisagreementRate: 1,
      }).ready,
      false,
    );
  });

  it("REGRESSION: ANY sign mismatch blocks outright, regardless of rate", () => {
    const r = judgeSwitchoverReadiness([
      ...repeat(199, "MATCH"),
      "SIGN_MISMATCH",
    ]);
    assert.equal(r.ready, false);
    assert.equal(r.signMismatches, 1);
    assert.match(r.reason, /SIGN mismatch/);
    assert.equal(
      judgeSwitchoverReadiness([...repeat(199, "MATCH"), "SIGN_MISMATCH"], {
        maxDisagreementRate: 1,
      }).ready,
      false,
    );
  });

  it("counts every verdict class, so the report can be read without the input", () => {
    const r = judgeSwitchoverReadiness([
      ...repeat(10, "MATCH"),
      ...repeat(3, "DISAGREEMENT"),
      ...repeat(2, "SCALE_MISMATCH"),
      "SIGN_MISMATCH",
      ...repeat(4, "INCOMPARABLE"),
    ]);
    assert.deepEqual(
      {
        compared: r.compared,
        matched: r.matched,
        disagreements: r.disagreements,
        scaleMismatches: r.scaleMismatches,
        signMismatches: r.signMismatches,
        incomparable: r.incomparable,
      },
      {
        compared: 20,
        matched: 10,
        disagreements: 3,
        scaleMismatches: 2,
        signMismatches: 1,
        incomparable: 4,
      },
    );
    // The counts must partition the input exactly — a verdict class silently
    // falling out of the tally is how a gate stops seeing a whole failure mode.
    assert.equal(
      r.matched +
        r.disagreements +
        r.scaleMismatches +
        r.signMismatches +
        r.incomparable,
      r.compared,
    );
  });

  it("REGRESSION: a mostly-INCOMPARABLE source cannot pass the gate", () => {
    // THE MONEY-1196 draining-denominator failure, and the single most
    // important case in this file.
    //
    // 100 periods were put up for reconciliation. 95 of them had no value on
    // one side at all — the XBRL feed simply has no data there. 5 compared, and
    // those 5 matched. The module header states the intended defence outright:
    // "The population is every reconciled pair, INCOMPARABLE included, so a
    // source that mostly has no data cannot pass by comparing the handful it
    // does have."
    //
    // 5% coverage is not evidence of anything. If this passes, the switchover
    // is approved on five numbers and the product starts reading a source that
    // is blank for 95% of the periods it is now authoritative for.
    const verdicts = [...repeat(95, "INCOMPARABLE"), ...repeat(5, "MATCH")];
    const r = judgeSwitchoverReadiness(verdicts);

    assert.equal(r.compared, 100);
    assert.equal(r.incomparable, 95);
    assert.equal(r.matched, 5);
    assert.equal(
      r.ready,
      false,
      `a source with ${r.matched}/${r.compared} usable comparisons must not be ready — got reason: ${r.reason}`,
    );
  });

  it("REGRESSION: the INCOMPARABLE population must not DILUTE the failure rate", () => {
    // The mechanism behind the case above, isolated. Take a set that is
    // correctly rejected — 10 matches, 3 disagreements, 23% — and pad it with
    // periods that produced NO comparison at all. Nothing improved; the source
    // did not get better, it just has more blanks. The verdict must not flip.
    const real: ReconcileVerdict[] = [
      ...repeat(17, "MATCH"),
      ...repeat(3, "DISAGREEMENT"),
    ];
    assert.equal(
      judgeSwitchoverReadiness(real).ready,
      false,
      "premise: 3/20 = 15% disagreement is rejected",
    );

    const padded = [...real, ...repeat(80, "INCOMPARABLE")];
    assert.equal(
      judgeSwitchoverReadiness(padded).ready,
      false,
      `padding with blanks dropped the rate to ${((3 / 100) * 100).toFixed(1)}% and opened the gate`,
    );
  });

  it("an empty verdict list is not ready", () => {
    // Zero comparisons is the extreme of the same failure: `0/0` must not be
    // "no disagreements, therefore fine".
    const r = judgeSwitchoverReadiness([]);
    assert.equal(r.ready, false);
    assert.equal(r.compared, 0);
    assert.ok(Number.isFinite(r.matched));
  });
});

/* -------------------------------------------------------------------------- */
/* periodLabel — the JOIN between XbrlFiling dates and StockFinancials labels  */
/* -------------------------------------------------------------------------- */

/**
 * This function had NO tests, and it was wrong: it emitted a bare `"2025"`
 * while every one of prod's 32,359 `stock_financials` rows is labelled
 * `"FY 2025"`. The join therefore missed 100% of rows and every projection
 * would have been a CREATE.
 *
 * The labels below are not invented — they are the exact strings measured on
 * prod on 2026-08-18, with their row counts:
 *   FY 2025 (6,323)  FY 2024 (6,285)  FY 2023 (6,091)
 *   FY 2022 (5,884)  FY 2021 (5,629)  FY 2020 (24)   TTM (2,123)
 */
describe("periodLabel — addresses a real StockFinancials row", () => {
  const utc = (y: number, m: number, d: number): Date =>
    new Date(Date.UTC(y, m - 1, d));

  it("ANNUAL carries the 'FY ' prefix prod actually stores", () => {
    assert.equal(periodLabel(utc(2025, 3, 31), "ANNUAL"), "FY 2025");
    assert.equal(periodLabel(utc(2024, 3, 31), "ANNUAL"), "FY 2024");
    assert.equal(periodLabel(utc(2020, 3, 31), "ANNUAL"), "FY 2020");
  });

  it("never emits a BARE year — the shape that missed every row", () => {
    // The regression guard. A bare "2025" is the pre-fix output and joins to
    // nothing; asserting the positive alone would still pass if someone
    // reintroduced String(fyEndYear) for a DIFFERENT periodType spelling.
    for (const d of [utc(2025, 3, 31), utc(2024, 12, 31), utc(2023, 6, 30)]) {
      const label = periodLabel(d, "ANNUAL");
      assert.ok(
        /^FY \d{4}$/.test(label),
        `ANNUAL label ${JSON.stringify(label)} must be "FY <year>"`,
      );
      assert.notEqual(label, String(d.getUTCFullYear()));
    }
  });

  it("the Apr/Mar boundary governs QUARTERLY naming, not the ANNUAL label", () => {
    // REWRITTEN in MONEY-1232. This used to assert
    // `periodLabel(1-Apr-2025, "ANNUAL") === "FY 2026"`, treating the label as
    // "which Indian fiscal year does this DATE fall in".
    //
    // For an ANNUAL filing that question is the wrong one. `periodEnd` is not a
    // date inside the year — it IS the year's end — so the label is simply the
    // year it ends in. The old framing was harmless for April–March filers,
    // whose `periodEnd` is always in March and therefore never crossed the
    // boundary at all; it produced a wrong answer only for filers whose year
    // ends elsewhere, which is the bug this ticket fixes.
    assert.equal(periodLabel(utc(2025, 3, 31), "ANNUAL"), "FY 2025");
    assert.equal(periodLabel(utc(2025, 4, 30), "ANNUAL"), "FY 2025");

    // QUARTERLY still names the fiscal year the quarter sits IN, so the
    // boundary is real there and these two adjacent days still differ.
    assert.equal(periodLabel(utc(2025, 3, 31), "QUARTERLY"), "Q4-2025");
    assert.equal(periodLabel(utc(2025, 4, 1), "QUARTERLY"), "Q1-2026");
  });

  it("QUARTERLY labels are unchanged by the ANNUAL fix", () => {
    assert.equal(periodLabel(utc(2024, 6, 30), "QUARTERLY"), "Q1-2025");
    assert.equal(periodLabel(utc(2024, 9, 30), "QUARTERLY"), "Q2-2025");
    assert.equal(periodLabel(utc(2024, 12, 31), "QUARTERLY"), "Q3-2025");
    assert.equal(periodLabel(utc(2025, 3, 31), "QUARTERLY"), "Q4-2025");
  });

  it("never emits TTM — 2,123 prod rows carry it and no filing may target them", () => {
    // "TTM" is stored under periodType:"ANNUAL" but is not a fiscal year. An
    // XBRL filing covers a real period, so projecting onto the trailing-twelve-
    // month row would overwrite a DIFFERENT measure with a same-named one.
    for (const pt of ["ANNUAL", "QUARTERLY"]) {
      for (const d of [utc(2025, 3, 31), utc(2024, 9, 30), utc(2026, 1, 15)]) {
        assert.notEqual(periodLabel(d, pt), "TTM");
      }
    }
  });

  it("a December year-end lands on the year it ENDS in — measured, not assumed", () => {
    // INVERTED in MONEY-1232, and the reason is worth keeping because the
    // principle it was built on was RIGHT while its fact was wrong.
    //
    // It read: "Documented non-goal: ABB/Castrol/Nestlé CY2024 lands under
    // FY 2025. The label's job is to address the row the reconciliation
    // addressed, not to be more correct than it." The principle — the label is
    // a JOIN KEY, not a semantic claim — still stands and is why this is worth
    // getting exactly right. What was never checked is which row the incumbent
    // actually holds.
    //
    // Measured against prod on 2026-08-20. SANOFI is a December filer; our
    // filing for periodEnd 2021-12-31 projects netIncome 944.4 and ebitda
    // 1326.1. The incumbent Tickertape rows are:
    //
    //   "FY 2021"  netIncome 944.4   ebitda 1326.1     <- exact, both fields
    //   "FY 2022"  netIncome 620.6   ebitda  907.9
    //
    // Under the old rule that filing was labelled "FY 2022" and matched NEITHER
    // field against its incumbent; under this rule it matches BOTH to the
    // decimal. Two independent fields agreeing exactly is the join landing on
    // the right row, not a coincidence.
    //
    // The consequence of leaving it: `period` is in `StockFinancials`'s unique
    // key and `judgeProjectionEligibility` builds `verdict.target.period` from
    // this function, so a wrong label makes the writer CREATE a second row for
    // a year that already has one — under a name no reader queries.
    assert.equal(periodLabel(utc(2024, 12, 31), "ANNUAL"), "FY 2024");
    assert.equal(periodLabel(utc(2021, 12, 31), "ANNUAL"), "FY 2021");

    // The other two non-March shapes present in prod (4 June filers, 1
    // September). Same rule, and pinned so a future "simplification" back to
    // month-based folding fails here rather than in a reconciliation.
    assert.equal(periodLabel(utc(2021, 6, 30), "ANNUAL"), "FY 2021");
    assert.equal(periodLabel(utc(2021, 9, 30), "ANNUAL"), "FY 2021");

    // March is the other 98.9% and must be untouched by all of the above.
    assert.equal(periodLabel(utc(2022, 3, 31), "ANNUAL"), "FY 2022");
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1115 — the ratios that were missing, and TTM's refusals               */
/* -------------------------------------------------------------------------- */

/**
 * Built on the same real fixtures as the rest of this file. The engine gained
 * EBITDA margin, ROCE, interest coverage, asset turnover, QoQ growth and TTM;
 * what follows pins the REFUSALS as hard as the computations, because every one
 * of these has a plausible wrong answer that a screener would rank on.
 */
describe("deriveRatios — the MONEY-1115 additions", () => {
  it("EBITDA margin is built from PBT + finance + D&A, not read", () => {
    // The taxonomy has no EBITDA concept. Starting from profitForPeriod would
    // subtract tax and make this a post-tax margin under a pre-tax name.
    const f = parsed("infy-q1fy27-standalone-indas-2026-01-31.xml");
    const r = deriveRatios(f);
    const v = f.values;
    if (
      v.profitBeforeTax !== undefined &&
      v.financeCosts !== undefined &&
      v.depreciationAndAmortisation !== undefined &&
      v.revenueFromOperations
    ) {
      assert.ok(
        r.ebitdaMargin !== undefined,
        "should compute on a full filing",
      );
      assert.ok(
        r.ebitdaMargin > (r.operatingMargin ?? -Infinity) - 100,
        "sanity: an EBITDA margin is in a plausible band",
      );
    }
  });

  it("does NOT invent a gross margin — no COGS concept exists", () => {
    const r = deriveRatios(
      parsed("infy-q1fy27-standalone-indas-2026-01-31.xml"),
    );
    assert.ok(
      !("grossMargin" in r),
      "1 - totalExpenses/revenue is an operating margin wearing another name; " +
        "StockRatios.grossMargin must be left to its existing source",
    );
  });

  it("interest coverage is UNDEFINED at zero finance cost, never Infinity", () => {
    const f = parsed("infy-q1fy27-standalone-indas-2026-01-31.xml");
    const zeroed = {
      ...f,
      values: { ...f.values, profitBeforeTax: 1000, financeCosts: 0 },
    } as typeof f;
    const r = deriveRatios(zeroed);
    assert.equal(
      r.interestCoverage,
      undefined,
      "a company with no interest expense has undefined coverage, and an " +
        "Infinity tops every 'safest balance sheet' screen",
    );
  });

  it("ROCE refuses when NO borrowings figure exists rather than becoming ROE", () => {
    const f = parsed("infy-q1fy27-standalone-indas-2026-01-31.xml");
    const stripped = { ...f, values: { ...f.values } } as typeof f;
    delete (stripped.values as Record<string, unknown>).borrowingsCurrent;
    delete (stripped.values as Record<string, unknown>).borrowingsNonCurrent;
    delete (stripped.values as Record<string, unknown>).borrowings;
    assert.equal(deriveRatios(stripped).roce, undefined);
  });

  it("asset turnover needs BOTH filings — one filing yields nothing", () => {
    const f = parsed("infy-q1fy27-standalone-indas-2026-01-31.xml");
    assert.equal(
      deriveRatios(f).assetTurnover,
      undefined,
      "a point-in-time denominator overstates turnover for any company that grew",
    );
  });
});

describe("deriveGrowthQoQ — a separate door on purpose", () => {
  it("computes quarter-over-quarter from the preceding quarter", () => {
    const cur = parsed("infy-q1fy27-standalone-indas-2026-01-31.xml");
    const prev = parsed("cipla-q3fy26-standalone-indas-2025-01-31.xml");
    const r = deriveGrowthQoQ(cur, prev);
    // Both fixtures have revenue; the VALUE is not the point, the wiring is.
    assert.ok("revenueGrowthQoQ" in r || "earningsGrowthQoQ" in r);
  });

  it("is a DIFFERENT function from the YoY path", () => {
    // Nothing in the data distinguishes "last quarter" from "last year", so a
    // single parameter would silently accept the wrong one. Two named entry
    // points force the caller to state the comparison.
    const cur = parsed("infy-q1fy27-standalone-indas-2026-01-31.xml");
    const other = parsed("cipla-q3fy26-standalone-indas-2025-01-31.xml");
    const qoq = deriveGrowthQoQ(cur, other);
    const yoy = deriveRatios(cur, other);
    assert.ok(!("revenueGrowth" in qoq), "QoQ must not fill the YoY field");
    assert.ok(!("revenueGrowthQoQ" in yoy), "YoY must not fill the QoQ field");
  });
});

describe("deriveTtm — refuses far more than it computes", () => {
  const q = (endIso: string, days = 92, values: Record<string, number> = {}) =>
    ({
      financials: {
        period: {
          start: "x",
          end: endIso,
          days,
          contextRef: "c",
          source: "reported-facts",
        },
        values: {
          revenueFromOperations: 100,
          profitForPeriod: 10,
          basicEps: 1,
          ...values,
        },
      },
      cumulative: false,
    }) as unknown as Parameters<typeof deriveTtm>[0][number];

  const FOUR = [
    q("2026-03-31"),
    q("2025-12-31"),
    q("2025-09-30"),
    q("2025-06-30"),
  ];

  it("sums four contiguous discrete quarters", () => {
    const r = deriveTtm(FOUR);
    assert.ok(r);
    assert.equal(r.revenue, 400);
    assert.equal(r.netIncome, 40);
    assert.equal(r.eps, 4);
    assert.equal(r.periodEnds.length, 4);
  });

  it("REFUSES fewer than four — a partial year is not a trailing year", () => {
    assert.equal(deriveTtm(FOUR.slice(0, 3)), null);
  });

  it("REFUSES any cumulative quarter — the double-count trap", () => {
    const withYtd = [...FOUR];
    withYtd[0] = { ...withYtd[0]!, cumulative: true };
    assert.equal(
      deriveTtm(withYtd),
      null,
      "adding a 9-month YTD to three quarters double-counts most of the year " +
        "and the result is plausible enough to pass review",
    );
  });

  it("REFUSES a YTD-length period even when the flag is unset", () => {
    const longOne = [...FOUR];
    longOne[0] = q("2026-03-31", 274); // a 9-month column
    assert.equal(deriveTtm(longOne), null);
  });

  it("REFUSES a gap — four rows spanning fifteen months", () => {
    assert.equal(
      deriveTtm([
        q("2026-03-31"),
        q("2025-12-31"),
        q("2025-09-30"),
        q("2025-03-31"),
      ]),
      null,
    );
  });

  it("REFUSES a duplicated period-end (a revision, or standalone+consolidated)", () => {
    assert.equal(
      deriveTtm([
        q("2026-03-31"),
        q("2026-03-31"),
        q("2025-12-31"),
        q("2025-09-30"),
      ]),
      null,
    );
  });

  it("a field missing from ONE quarter makes the TTM field absent, not a 3/4 sum", () => {
    const missing = [...FOUR];
    const bare = q("2025-06-30");
    delete (
      bare as unknown as { financials: { values: Record<string, unknown> } }
    ).financials.values.revenueFromOperations;
    missing[3] = bare;
    const r = deriveTtm(missing);
    assert.ok(r);
    assert.equal(
      r.revenue,
      undefined,
      "three quarters must not be labelled twelve months",
    );
    assert.equal(r.netIncome, 40, "unaffected fields still sum");
  });

  it("orders periodEnds newest-first regardless of input order", () => {
    const shuffled = [FOUR[2]!, FOUR[0]!, FOUR[3]!, FOUR[1]!];
    const r = deriveTtm(shuffled);
    assert.ok(r);
    assert.equal(r.periodEnds[0]!.toISOString().slice(0, 10), "2026-03-31");
    assert.equal(r.periodEnds[3]!.toISOString().slice(0, 10), "2025-06-30");
  });
});

/* -------------------------------------------------------------------------- */
/* Review fixes — lenders, and TTM's basis guard                              */
/* -------------------------------------------------------------------------- */

describe("deriveRatios refuses a derived EBIT for LENDERS", () => {
  // `projectFinancials` already refuses `ebitda` for banking/nbfc: "Finance
  // cost IS a bank's cost of goods; adding interest expended back produces a
  // number with no meaning." Everything built on that add-back must refuse too.
  //
  // Before this guard, on these very fixtures: ICICI Bank got
  // interestCoverage 1.76 and roce 9.4; Religare got ebitdaMargin -673.2 and
  // interestCoverage -63.0. A coverage near 1.5 is what a distressed borrower
  // looks like, so every lender would sort to the bottom of a "can it service
  // its debt" screen — in a column whose honest incumbent is NULL for all of
  // HDFCBANK, ICICIBANK, SBIN, KOTAKBANK, AXISBANK and BAJFINANCE.
  const LENDERS = [
    "icicibank-q2fy25-standalone-banking-2019-09-30.xml",
    "finopb-q1fy27-standalone-banking-2026-01-31.xml",
    "ndgl-q1fy27-consolidated-nbfc-2026-01-31.xml",
    "religare-q4fy26-standalone-nbfc-2026-01-31.trimmed.xml",
  ];

  for (const fx of LENDERS) {
    it(`${fx.split("-")[0]} gets no ebitdaMargin / roce / interestCoverage`, () => {
      const f = parsed(fx);
      assert.ok(
        f.family === "banking" || f.family === "nbfc",
        `${fx} should parse as a lender, got ${f.family}`,
      );
      const r = deriveRatios(f);
      assert.equal(
        r.ebitdaMargin,
        undefined,
        "EBITDA is meaningless for a lender",
      );
      assert.equal(r.roce, undefined, "its denominator would exclude deposits");
      assert.equal(
        r.interestCoverage,
        undefined,
        "interest IS the cost of goods; coverage is not defined",
      );
    });
  }

  it("a NON-lender still gets them, so the guard is not blanket", () => {
    const r = deriveRatios(
      parsed("infy-q1fy27-standalone-indas-2026-01-31.xml"),
    );
    assert.ok(
      r.ebitdaMargin !== undefined || r.interestCoverage !== undefined,
      "an industrial must still derive at least one of them",
    );
  });

  it("margins and ROE, which need no add-back, still work for a lender", () => {
    const r = deriveRatios(
      parsed("icicibank-q2fy25-standalone-banking-2019-09-30.xml"),
    );
    assert.ok(
      r.netMargin !== undefined || r.roe !== undefined,
      "the refusal is scoped to EBIT-derived metrics, not to lenders wholesale",
    );
  });
});

describe("deriveTtm refuses a MIXED standalone/consolidated year", () => {
  const q = (endIso: string, basis: string, rev: number) =>
    ({
      financials: {
        basis,
        period: {
          start: "x",
          end: endIso,
          days: 92,
          contextRef: "c",
          source: "reported-facts",
        },
        values: {
          revenueFromOperations: rev,
          profitForPeriod: rev / 10,
          basicEps: 1,
        },
      },
      cumulative: false,
    }) as unknown as Parameters<typeof deriveTtm>[0][number];

  it("REFUSES two consolidated + two standalone quarters", () => {
    // `XbrlFiling`'s unique key deliberately keeps both bases for one period, so
    // a caller assembling "the last four quarters" by period-end alone picks up
    // two of each. The duplicate-end guard cannot see it — the ends differ.
    // 1000+100+1000+100 = 2200, where consolidated is 4000 and standalone 400.
    // It is not close to either, and nothing downstream can tell.
    const mixed = [
      q("2026-03-31", "consolidated", 1000),
      q("2025-12-31", "standalone", 100),
      q("2025-09-30", "consolidated", 1000),
      q("2025-06-30", "standalone", 100),
    ];
    assert.equal(deriveTtm(mixed), null);
  });

  it("accepts four CONSOLIDATED quarters", () => {
    const r = deriveTtm([
      q("2026-03-31", "consolidated", 1000),
      q("2025-12-31", "consolidated", 1000),
      q("2025-09-30", "consolidated", 1000),
      q("2025-06-30", "consolidated", 1000),
    ]);
    assert.equal(r?.revenue, 4000);
  });

  it("accepts four STANDALONE quarters", () => {
    const r = deriveTtm([
      q("2026-03-31", "standalone", 100),
      q("2025-12-31", "standalone", 100),
      q("2025-09-30", "standalone", 100),
      q("2025-06-30", "standalone", 100),
    ]);
    assert.equal(r?.revenue, 400);
  });
});

describe("MONEY-1239 — deriveTtm refuses a LENDER's EBITDA, like its two siblings", () => {
  // `projectFinancials` refuses `ebitda` for banking/nbfc and `deriveRatios`
  // repeats the refusal for everything built on the interest add-back. This
  // loop rebuilds the SAME quantity — PBT + financeCosts + D&A — and had no
  // guard, so `ttmEbitda` reached `deriveValuation` and `StockRatios.evToEbitda`
  // was written for every NBFC in the universe.
  //
  // Banks were spared only by accident: RBI Form-A files no depreciation line,
  // so the sum refused itself on a missing part. An NBFC files Ind-AS and DOES
  // report depreciation — RELIGARE Q4-FY26 carries PBT −12.36 cr, finance costs
  // 0.19 cr and depreciation 0.56 cr, all three present — so nothing stopped it
  // there. The numbers below are that fixture's shape.
  const q = (endIso: string, family: string) =>
    ({
      financials: {
        family,
        basis: "standalone",
        period: {
          start: "x",
          end: endIso,
          days: 92,
          contextRef: "c",
          source: "reported-facts",
        },
        values: {
          revenueFromOperations: 100,
          profitForPeriod: 10,
          basicEps: 1,
          profitBeforeTax: 20,
          financeCosts: 30,
          depreciationAndAmortisation: 5,
        },
      },
      cumulative: false,
    }) as unknown as Parameters<typeof deriveTtm>[0][number];

  const four = (family: string) => [
    q("2026-03-31", family),
    q("2025-12-31", family),
    q("2025-09-30", family),
    q("2025-06-30", family),
  ];

  for (const family of ["banking", "nbfc"]) {
    it(`${family}: ebitda is ABSENT, not 4 x (PBT + interest + D&A)`, () => {
      const r = deriveTtm(four(family));
      assert.ok(r, "the four quarters must still form a valid TTM");
      assert.equal(r.ebitda, undefined);
      assert.ok(!("ebitda" in r), "ebitda must not be present at all");
      // The specific wrong answer: 4 x (20 + 30 + 5) = 220, of which 120 is
      // interest expended — a lender's cost of goods, added back.
      assert.notEqual(r.ebitda, 220);
    });
  }

  it("the refusal is scoped to EBITDA — revenue, netIncome and eps still sum", () => {
    // Guards the scope. Without this, refusing the whole aggregate for lenders
    // would pass too, and `pe` (which needs `eps`) would silently die with it.
    const r = deriveTtm(four("nbfc"));
    assert.equal(r?.revenue, 400);
    assert.equal(r?.netIncome, 40);
    assert.equal(r?.eps, 4);
  });

  it("a NON-lender with the SAME numbers still gets it — the guard is not blanket", () => {
    // Guards the guard: proves the undefined above comes from the family and
    // not from some unrelated rejection of these synthetic quarters.
    const r = deriveTtm(four("ind-as"));
    assert.equal(r?.ebitda, 220);
  });

  it("ONE lender quarter in four poisons the year — `some`, not `every`", () => {
    // The quarters are only guaranteed to share a BASIS, not a family. A filer
    // reclassified mid-year must refuse rather than take whichever quarter
    // sorted first. An `every` here would let three ind-as quarters carry an
    // NBFC one straight into the sum.
    const mixed = [
      q("2026-03-31", "nbfc"),
      q("2025-12-31", "ind-as"),
      q("2025-09-30", "ind-as"),
      q("2025-06-30", "ind-as"),
    ];
    const r = deriveTtm(mixed);
    assert.ok(r, "a mixed FAMILY is not a mixed BASIS — the year still forms");
    assert.equal(r.ebitda, undefined);
    assert.equal(r.revenue, 400, "only the EBITDA leg is refused");
  });
});

describe("MONEY-1239 — a LENDER does not own the columns it cannot source", () => {
  // THE DEFECT. `ownedFields` was family-blind, so the writer claimed
  // `operatingIncome` and `ebitda` for every filer and wrote an explicit NULL
  // whenever the projection came up empty. For lenders that is almost always:
  // `operatingIncome` needs `operatingProfitBeforeProvisions` (76 of 741 ANNUAL
  // banking filings, 0 of 206 NBFC), and `ebitda` is REFUSED outright by
  // `projectFinancials` because interest is a lender's cost of goods.
  //
  // So the module already held the right opinion in two places — it declines to
  // compute lender EBITDA, and declines to list it in `unfilled` because "for a
  // bank there is nothing to fill" — and only the ownership list disagreed.
  //
  // This is the `grossProfit` decision from MONEY-1235 taken one dimension
  // further: that column left `INCOME_FIELDS` because no filer can supply it;
  // these two leave it per FAMILY because lenders cannot.
  const baseFiling = {
    basis: "CONSOLIDATED" as const,
    periodEnd: "2024-03-31",
    cumulative: false,
    sourceUrl: "u",
  };
  const NOW = new Date("2026-08-22T00:00:00.000Z");
  const projected = {
    statementType: "INCOME" as const,
    // OUR column — MONEY-1255. A key named `revenue` here reaches
    // `projectedValues` and is dropped (it is not in `ownedFields` any more),
    // which makes the whole statement read as "the filing disclosed nothing"
    // and every assertion below pass against an empty patch.
    revenueFromOperations: 1000,
    netIncome: 50,
  } as unknown as Parameters<typeof planFinancialsWrite>[0]["projected"];

  it("writableFields drops our EBIT and EBITDA columns for a lender", () => {
    // `otherIncome` is NOT dropped — MONEY-1250. The two removed fields are
    // ones a lender cannot SOURCE (`operatingProfitBeforeProvisions` is in 10%
    // of banking and 0% of nbfc filings). Other income is DISCLOSED by every
    // shape: ICICIBANK FY2025 reports it at 1,08,255 Cr on its own line, and
    // screener shows it as a separate row. Dropping a column we can fill would
    // be the "assert an absence we cannot support" mistake in reverse.
    assert.deepEqual(writableFields("INCOME", "banking"), [
      "revenueFromOperations",
      "otherIncome",
      "netIncome",
    ]);
    assert.deepEqual(writableFields("INCOME", "nbfc"), [
      "revenueFromOperations",
      "otherIncome",
      "netIncome",
    ]);
  });

  it("…and changes nothing for an ind-as filer", () => {
    // The control. Without it, narrowing everything would satisfy the case above.
    assert.deepEqual(writableFields("INCOME", "ind-as"), [
      "revenueFromOperations",
      "otherIncome",
      "operatingIncomeExOtherIncome",
      "netIncome",
      "ebitdaBeforeExceptionalItems",
    ]);
    // An UNKNOWN family is not narrowed either — only a POSITIVELY identified
    // lender loses columns, so a family we failed to classify keeps the full set.
    assert.deepEqual(writableFields("INCOME", undefined), [
      "revenueFromOperations",
      "otherIncome",
      "operatingIncomeExOtherIncome",
      "netIncome",
      "ebitdaBeforeExceptionalItems",
    ]);
  });

  it("filerShape, not family, decides who owns totalDebt", () => {
    // The trap this test exists for — MONEY-1250. `family` is "banking" for 665
    // of 947 lender filings because an NBFC tags `InterestEarned`, which is what
    // the family classifier keys on. Suppressing `totalDebt` on `family` would
    // therefore silence it for exactly the filings the four-way sum was built to
    // fill, and `projectedValues` writes an explicit NULL for any WRITABLE field
    // the projection omits — so the suppression has to happen here or the column
    // is asserted absent rather than left unclaimed.
    const indAsLender = writableFields("BALANCE_SHEET", "banking", "IND_AS");
    assert.ok(
      indAsLender.includes("totalDebt"),
      "an Ind-AS lender misfamilied as banking must keep totalDebt",
    );
    assert.ok(
      writableFields("BALANCE_SHEET", "nbfc", "IND_AS").includes("totalDebt"),
    );

    const formA = writableFields("BALANCE_SHEET", "banking", "RBI_FORM_A");
    assert.ok(
      !formA.includes("totalDebt"),
      "a Form-A bank's Schedule 4 Borrowings is not comparable debt",
    );
    // `totalCash` too: 0 of 84 Form-A filings carry any cash concept, so every
    // write was a NULL over the vendor — HDFCBANK FY2024 lost 2,28,834 crore.
    assert.ok(
      indAsLender.includes("totalCash"),
      "an Ind-AS lender still owns totalCash (484 of 916 carry it)",
    );
    assert.ok(
      !formA.includes("totalCash"),
      "a Form-A bank cannot produce totalCash, so it must not claim it",
    );
    // Exactly those two columns move between the shapes — nothing else.
    assert.deepEqual(
      indAsLender.filter((f) => f !== "totalDebt" && f !== "totalCash"),
      formA,
    );

    // A non-lender is untouched by the shape argument either way.
    // `as const` so the array is not widened to `(string | undefined)[]` —
    // `writableFields` takes `FilerShape | undefined`, and the widened element
    // type is not assignable to it. Surfaced when MONEY-1118 turned tsc on for
    // packages/core's tests.
    for (const shape of ["RBI_FORM_A", "IND_AS", undefined] as const) {
      assert.ok(
        writableFields("BALANCE_SHEET", "ind-as", shape).includes("totalDebt"),
        `a manufacturer keeps totalDebt (shape=${String(shape)})`,
      );
    }
  });

  it("a lender write never MENTIONS the column, so the vendor's survives", () => {
    const plan = planFinancialsWrite({
      projected,
      incumbent: {
        source: "TICKERTAPE",
        revenue: 990,
        operatingIncome: 123.45,
        ebitda: 200,
      },
      filing: { ...baseFiling, family: "nbfc" } as unknown as Parameters<
        typeof planFinancialsWrite
      >[0]["filing"],
      now: NOW,
    });
    assert.equal(plan.action, "UPDATE");
    assert.ok(plan.values);
    assert.ok(
      !("operatingIncomeExOtherIncome" in plan.values),
      "an explicit null here is what emptied the column",
    );
    assert.ok(!("ebitdaBeforeExceptionalItems" in plan.values));
    assert.equal(plan.values.revenueFromOperations, 1000);
    // The VENDOR's three income columns are unowned outright — MONEY-1255 —
    // so they are absent from EVERY patch, lender or not. Asserted apart from
    // the two above precisely because they can no longer distinguish a lender
    // from an ind-as filer: an assertion on `"operatingIncome" in plan.values`
    // now passes for both, which is what makes it useless as the lender test
    // and useful as this one.
    for (const vendorColumn of ["revenue", "operatingIncome", "ebitda"]) {
      assert.ok(
        !(vendorColumn in plan.values),
        `${vendorColumn} is the vendor's column and must never be written`,
      );
    }
  });

  it("an IND-AS filer still nulls what it owns and did not disclose", () => {
    // Ownership is the whole point: for a filer we DO source this column from,
    // an absence is a real gap and the null is the honest answer. And it is not
    // destructive — the incumbent's value is copied verbatim into the
    // displacement record on the same write.
    //
    // The two halves are asserted on DIFFERENT columns after MONEY-1255, and
    // that is forced rather than convenient. `operatingIncomeExOtherIncome` is
    // ours alone, so no vendor row has ever carried a value in it and the
    // "preserved verbatim" half cannot be shown there — the record would hold
    // a null whether the code preserved it or not. `netIncome` is the column
    // both sides write, so it is the only one where NULLING and PRESERVING can
    // both be observed on one write.
    const revenueOnly = {
      statementType: "INCOME" as const,
      revenueFromOperations: 1000,
    } as unknown as Parameters<typeof planFinancialsWrite>[0]["projected"];
    const plan = planFinancialsWrite({
      projected: revenueOnly,
      incumbent: {
        source: "TICKERTAPE",
        revenue: 990,
        operatingIncome: 123.45,
        netIncome: 42,
      },
      filing: { ...baseFiling, family: "ind-as" } as unknown as Parameters<
        typeof planFinancialsWrite
      >[0]["filing"],
      now: NOW,
    });
    assert.equal(plan.values?.operatingIncomeExOtherIncome, null);
    assert.equal(plan.values?.netIncome, null);
    assert.equal(plan.displaced?.values?.netIncome, 42);
    // …and the vendor's own EBIT column is untouched by the null above, which
    // is the half of this that changed: before MONEY-1255 the null landed IN
    // `operatingIncome` and 123.45 was destroyed.
    assert.ok(!("operatingIncome" in (plan.values ?? {})));
  });

  it("the displacement record still captures EVERY owned column", () => {
    // The record is what makes any null non-destructive, so it must be built
    // over the full OWNED set, not the narrowed writable one. Only a LENDER can
    // catch a regression here: for an ind-as filer the two sets are identical,
    // so narrowing the record would go unnoticed.
    //
    // Asserted on the KEYS rather than on values for the two lender-dropped
    // columns — MONEY-1255. No vendor row has ever held a value in either of
    // them, so a value assertion would read `null` under both the correct
    // implementation and the narrowed one. The presence of the key is what
    // separates "built over ownedFields" from "built over writableFields", and
    // it is the property the doc on `DisplacementRecord.values` actually
    // claims ("Every OWNED field as it stood, nulls included").
    const plan = planFinancialsWrite({
      projected,
      incumbent: {
        source: "TICKERTAPE",
        revenue: 990,
        operatingIncome: 123.45,
        ebitda: 200,
        netIncome: 42,
      },
      filing: { ...baseFiling, family: "banking" } as unknown as Parameters<
        typeof planFinancialsWrite
      >[0]["filing"],
      now: NOW,
    });
    const record = plan.displaced?.values ?? {};
    assert.ok(
      "operatingIncomeExOtherIncome" in record,
      "an owned column the LENDER cannot write must still be in the record",
    );
    assert.ok("ebitdaBeforeExceptionalItems" in record);
    // …and the write itself still omits them, or the pair above proves nothing
    // about the two sets being different.
    assert.ok(!("operatingIncomeExOtherIncome" in (plan.values ?? {})));
    assert.ok(!("ebitdaBeforeExceptionalItems" in (plan.values ?? {})));
    // A column both sides fill, carrying a real value, so the record is shown
    // to be a copy of the INCUMBENT and not a copy of the projection (50).
    assert.equal(record.netIncome, 42);
  });

  it("CONVERGES: a lender row settles instead of rewriting nightly", () => {
    // "Already current" is judged over the WRITABLE columns only. Judged over
    // all OWNED ones it would compare the vendor's operatingIncome against our
    // absent one, call the row changed every night, and rewrite it forever.
    const plan = planFinancialsWrite({
      projected,
      incumbent: {
        source: "NSE_XBRL",
        // OUR column, holding what last night's run put there.
        revenueFromOperations: 1000,
        netIncome: 50,
        operatingIncome: 123.45, // the vendor's, never claimed by us
        rawData: { xbrl: { filing: baseFiling } },
      },
      filing: { ...baseFiling, family: "banking" } as unknown as Parameters<
        typeof planFinancialsWrite
      >[0]["filing"],
      now: NOW,
    });
    assert.equal(plan.action, "SKIP");
    assert.equal(plan.skipReason, "UNCHANGED");
  });
});

describe("MONEY-1239 — the TTM path removes exceptional items too", () => {
  // A TTM that keeps an exceptional item is the same defect with a longer
  // memory: the charge stays in `ttmEbitda` — and therefore in
  // `StockRatios.evToEbitda` — for FOUR QUARTERS after the event.
  //
  // Each quarter has to prove its own convention, so every quarter here carries
  // a coherent totalIncome/totalExpenses/PBT identity.
  const q = (endIso: string, exceptional: number) =>
    ({
      financials: {
        family: "ind-as",
        basis: "CONSOLIDATED",
        period: {
          start: "x",
          end: endIso,
          days: 92,
          contextRef: "c",
          source: "reported-facts",
        },
        values: {
          revenueFromOperations: 1000,
          profitForPeriod: 10,
          basicEps: 1,
          profitBeforeTax: 100,
          financeCosts: 10,
          depreciationAndAmortisation: 5,
          exceptionalItems: exceptional,
          totalIncome: 1000,
          // identity: TI − TE + ex = PBT  =>  TE = TI + ex − PBT
          totalExpenses: 1000 + exceptional - 100,
        },
      },
      cumulative: false,
    }) as unknown as Parameters<typeof deriveTtm>[0][number];

  it("subtracts the charge from every quarter that proves its convention", () => {
    // One quarter carries a −40 charge; the other three carry none.
    const r = deriveTtm([
      q("2026-03-31", -40),
      q("2025-12-31", 0),
      q("2025-09-30", 0),
      q("2025-06-30", 0),
    ]);
    assert.ok(r, "four clean quarters must form a year");
    // Raw would be 4 × (100 + 10 + 5) = 460. The −40 charge is removed once.
    assert.equal(r.ebitda, 460 + 40);
  });

  it("CONTROL: with no exceptional items the TTM is the raw sum", () => {
    // Without this, a mutation that subtracted a constant would pass the case
    // above. 4 x 115 = 460, unadjusted.
    const r = deriveTtm([
      q("2026-03-31", 0),
      q("2025-12-31", 0),
      q("2025-09-30", 0),
      q("2025-06-30", 0),
    ]);
    assert.ok(r);
    assert.equal(r.ebitda, 460);
  });
});

describe("MONEY-1239 — exceptionalItems are REMOVED from EBITDA (CLOSED)", () => {
  // This describe replaces a CHARACTERISATION test that pinned the gap while it
  // was open. The gap is closed; the assertions below now prevent its return.
  //
  // THE DEFECT. `ebitda = PBT + financeCosts + depreciation` inherits whatever
  // exceptional charge sits inside PBT, and an exceptional item is the one thing
  // an operating-earnings figure must not contain. BHARTIARTL Q2-FY20 is the
  // worked example and it is not marginal: a −₹30,711.0 Cr AGR provision turned
  // a +₹8,928.0 Cr EBITDA into −₹21,783.0 Cr — a SIGN FLIP — which then fed
  // `StockRatios.ebitdaMargin` (−103.1%) and `evToEbitda`.
  //
  // `xbrl-reconcile.ts` already offered `ebitdaRaw − exceptional` as a gate
  // translation covering 20.1% of surviving EBITDA disagreements: the GATE was
  // compensating for a defect in the WRITER.
  //
  // WHY IT IS SAFE TO SUBTRACT, and why the guard is per-filing. Whether the
  // disclosed amount is SIGNED (charge tagged negative, PBT = TI − TE + ex) or
  // UNSIGNED (charge tagged positive and subtracted) is a filer convention, and
  // subtracting under the wrong one DOUBLES the error. Measured on prod
  // 2026-08-22 over the 4,724 non-banking ANNUAL filings with a MATERIAL
  // exceptional item (>1% of |PBT|): 4,697 satisfy the signed identity (99.4%),
  // ZERO satisfy the unsigned one, 27 satisfy neither. `exceptionalAdjustment`
  // therefore makes each filing prove its own convention and leaves the 27
  // untouched. And it cost no migration: `source: "NSE_XBRL"` was 0 rows in
  // BOTH stock_financials and stock_ratios when this landed.
  const CR = 10_000_000;

  it("BHARTIARTL: the AGR provision no longer flips the sign", () => {
    assert.equal(BHARTI.values.exceptionalItems, -30_711 * CR);
    const income = stmt(projectFinancials(BHARTI).income, "income");
    // Was −21,783 * CR. Exact arithmetic, not "8,928-ish".
    assert.equal(income.ebitdaBeforeExceptionalItems, 8_928 * CR);
    assert.ok(
      (income.ebitdaBeforeExceptionalItems ?? 0) > 0,
      "the sign is the whole point — a −103% ebitdaMargin for Airtel was the symptom",
    );
    // Still a complete answer, so the projector must report nothing unfilled.
    assert.equal(
      projectFinancials(BHARTI).unfilled.find(
        (u) => u.field === "ebitdaBeforeExceptionalItems",
      ),
      undefined,
    );
  });

  it("REGRESSION: deriveRatios uses the SAME EBITDA basis as projectFinancials", () => {
    // THE SECOND HALF OF THE BUG. MONEY-1239 corrected `projectFinancials` and
    // `deriveTtm` but not `deriveRatios`, which kept computing
    // `pbt + fin + dep` raw — so the two tables published contradictory figures
    // for the SAME filing, and the −103.1% ebitdaMargin this ticket exists to
    // remove was still being produced, just from a different function.
    const income = stmt(projectFinancials(BHARTI).income, "income");
    const ratios = deriveRatios(BHARTI);
    assert.ok(
      income.revenueFromOperations,
      "fixture must have a revenue to divide by",
    );
    const impliedByProjection =
      (income.ebitdaBeforeExceptionalItems! / income.revenueFromOperations!) *
      100;
    assert.ok(
      Math.abs(impliedByProjection - ratios.ebitdaMargin!) < 1e-9,
      `the two tables must agree: projection implies ${impliedByProjection.toFixed(2)}%, ` +
        `deriveRatios says ${ratios.ebitdaMargin?.toFixed(2)}%`,
    );
    assert.ok(
      (ratios.ebitdaMargin ?? 0) > 0,
      "a positive EBITDA cannot yield a negative margin",
    );
  });

  it("REGRESSION: roce and interestCoverage share that adjusted basis", () => {
    // EBIT carries the adjustment for the same reason EBITDA does — the charge
    // sits inside PBT. Leaving these two on the raw basis would put three
    // published ratios on two different definitions of operating earnings.
    const v = BHARTI.values;
    const rawEbit = v.profitBeforeTax! + v.financeCosts!;
    const adjustedEbit = rawEbit - exceptionalAdjustment(v);
    assert.notEqual(
      rawEbit,
      adjustedEbit,
      "[meta] fixture must exercise the adjustment",
    );

    const ratios = deriveRatios(BHARTI);
    if (ratios.interestCoverage !== undefined) {
      assert.ok(
        Math.abs(ratios.interestCoverage - adjustedEbit / v.financeCosts!) <
          1e-9,
        "interestCoverage must be computed from the ADJUSTED ebit",
      );
    }
  });

  it("GLAXO: the adjustment is SYMMETRIC — a GAIN is removed too", () => {
    // A rule that only stripped charges would leave every exceptional gain
    // overstating EBITDA. GLAXO's is positive, so removing it LOWERS the figure.
    assert.equal(GLAXO.values.exceptionalItems, 46_900_000);
    const income = stmt(projectFinancials(GLAXO).income, "income");
    assert.equal(
      income.ebitdaBeforeExceptionalItems,
      3_558_300_000 - 46_900_000,
    );
  });

  it("a filing that cannot prove its convention is left ALONE", () => {
    // The 27 prod filings satisfying NEITHER identity. Adjusting them would be
    // guessing; an as-reported number is defensible, a wrongly-adjusted one is
    // not. Identity broken deliberately: TI − TE + ex != PBT and TI − TE − ex
    // != PBT either.
    const v = {
      profitBeforeTax: 100 * CR,
      financeCosts: 10 * CR,
      depreciationAndAmortisation: 5 * CR,
      exceptionalItems: -20 * CR,
      totalIncome: 500 * CR,
      totalExpenses: 333 * CR, // 500 − 333 − 20 = 147, +20 = 187; PBT is 100
    };
    assert.equal(exceptionalAdjustment(v), 0);
  });

  it("a filing that PROVES the signed convention is adjusted", () => {
    // The control for the case above: same shape, identity satisfied.
    const v = {
      profitBeforeTax: 100 * CR,
      exceptionalItems: -20 * CR,
      totalIncome: 500 * CR,
      totalExpenses: 380 * CR, // 500 − 380 + (−20) = 100 = PBT
    };
    assert.equal(exceptionalAdjustment(v), -20 * CR);
  });

  it("an ABSENT or ZERO exceptional item adjusts by nothing", () => {
    assert.equal(exceptionalAdjustment({ profitBeforeTax: 1 }), 0);
    assert.equal(
      exceptionalAdjustment({
        exceptionalItems: 0,
        profitBeforeTax: 100,
        totalIncome: 500,
        totalExpenses: 400,
      }),
      0,
    );
  });
});

describe("MONEY-1237 — netIncome sign-masking: a loss tagged as a positive magnitude", () => {
  const CR = 10_000_000; // the projector works in RUPEES; crore only for reading

  it("REGRESSION: INDIGO FY2022 — a 6,162 cr LOSS was written as a 6,162 cr PROFIT", () => {
    // The real filing, measured on prod 2026-08-21. InterGlobe Aviation lost
    // ~6,162 crore in FY2022; `profitForPeriod` says so, and
    // `profitAttributableToOwners` carries the SAME MAGNITUDE POSITIVE because
    // the filer relies on a negated presentation label to render the minus.
    //
    // Preferring the attributable element wrote a record PROFIT for the worst
    // year in the airline's history — into the one table with no `source` in its
    // unique key, feeding netMargin, ROE and every screener rank from it.
    const p = projectFinancials(
      synth({
        values: {
          profitForPeriod: -6161.85 * CR,
          profitAttributableToOwners: 6161.85 * CR,
          revenueFromOperations: 25930.93 * CR,
          totalExpenses: 32810.21 * CR,
        },
      }),
    );
    const net = stmt(p.income, "income").netIncome;
    assert.ok(
      net !== undefined && net < 0,
      `a loss must stay a loss, got ${net}`,
    );
    assert.equal(net, -6161.85 * CR);
  });

  it("removes a genuine minority share while correcting the sign", () => {
    // The correction runs through the IDENTITY, not through `profitForPeriod`
    // directly, so a real non-controlling share is still attributed away rather
    // than silently folded into the owners' line.
    const p = projectFinancials(
      synth({
        values: {
          profitForPeriod: -100 * CR,
          profitAttributableToNonControllingInterests: -30 * CR,
          profitAttributableToOwners: 100 * CR,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, -70 * CR);
  });

  it("KANORICHEM — the reference is the IMPLIED share, not the total", () => {
    // Real prod filing, and one of the two netIncome SIGN mismatches the F3 gate
    // still reported. There IS a genuine minority interest here, so comparing
    // the tagged value against `profitForPeriod` builds that whole minority
    // share into the apparent disagreement:
    //
    //   pfp -12.88  att +8.73  nci -4.04   implied = -8.84
    //     vs implied  ->  1.2% apart, the negated-label shape
    //     vs total    ->   32% apart, refused
    //
    // The vendor reports -8.77 for this period.
    const p = projectFinancials(
      synth({
        values: {
          profitForPeriod: -12.88 * CR,
          profitAttributableToNonControllingInterests: -4.04 * CR,
          profitAttributableToOwners: 8.73 * CR,
        },
      }),
    );
    const net = stmt(p.income, "income").netIncome;
    assert.ok(net !== undefined && net < 0, `expected a loss, got ${net}`);
    assert.equal(Math.round(net! / CR / 0.01) * 0.01, -8.84);
  });

  it("PDSL — a real minority-absorbed year is left exactly alone", () => {
    // The other side of the widening. att -7.84 + nci 27.38 = pfp 19.53: the
    // identity closes, so the owners genuinely lost while the minorities gained,
    // and the signs differ for a real reason.
    //
    // Entering the branch here is a no-op UP TO THE FILING'S OWN ROUNDING, not
    // exactly: -7.84 + 27.38 is 19.54 against a reported 19.53, so re-deriving
    // returns -7.85. One paisa on a 7.84 crore figure. Asserted with a tolerance
    // rather than exactly, because claiming "identical" would be false and the
    // next person to read it would find that out the hard way. What matters is
    // that the SIGN and the MAGNITUDE survive — widening the test cannot turn
    // this population into the group total.
    const p = projectFinancials(
      synth({
        values: {
          profitForPeriod: 19.53 * CR,
          profitAttributableToNonControllingInterests: 27.38 * CR,
          profitAttributableToOwners: -7.84 * CR,
        },
      }),
    );
    const net = stmt(p.income, "income").netIncome;
    assert.ok(
      net !== undefined && net < 0,
      `expected the owners' loss, got ${net}`,
    );
    assert.ok(
      Math.abs(net! / CR - -7.84) <= 0.02,
      `expected ~-7.84 cr (the owners' share), got ${net! / CR}`,
    );
    // The falsifiable half: it must NOT have become the group total.
    assert.ok(
      Math.abs(net! / CR - 19.53) > 1,
      "netIncome collapsed to profitForPeriod — the minority share was folded in",
    );
  });

  it("leaves a sign difference alone when the MAGNITUDES do not agree", () => {
    // The guard is deliberately narrow, and this fixture is what makes that
    // narrowness testable: 5 crore attributable against a 100 crore group loss,
    // with no non-controlling line. The identity would say -100; the filing says
    // +5. They disagree in sign AND in size, so this is NOT the unambiguous
    // negated-label shape and the tagged value stands.
    //
    // An earlier version of this test used a fixture where the identity happened
    // to reproduce the tagged value, so BOTH the magnitude test and the
    // tolerance constant could be mutated away without failing anything — the
    // test asserted a number that was right for the wrong reason. Mutation
    // testing caught it.
    const p = projectFinancials(
      synth({
        values: {
          profitForPeriod: -100 * CR,
          profitAttributableToOwners: 5 * CR,
        },
      }),
    );
    assert.equal(
      stmt(p.income, "income").netIncome,
      5 * CR,
      "only a MATCHING-magnitude sign flip is a tagging error; this is not",
    );
  });

  it("the tolerance is tight enough to exclude a 20% difference", () => {
    // Pins SIGN_MASK_TOLERANCE itself. 80 against -100 is a 20% gap — far wider
    // than the rounding the guard exists to absorb (HINDWAREAP's 68.01 vs
    // 68.29), so it must NOT be corrected. Widening the constant to swallow this
    // would start rewriting real attribution splits.
    const p = projectFinancials(
      synth({
        values: {
          profitForPeriod: -100 * CR,
          profitAttributableToOwners: 80 * CR,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 80 * CR);
  });

  it("a profitable company with agreeing signs is untouched", () => {
    const p = projectFinancials(
      synth({
        values: {
          profitForPeriod: 500 * CR,
          profitAttributableToOwners: 480 * CR,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 480 * CR);
  });

  it("still fixes the ZERO-masking case (MONEY-1234) — both guards coexist", () => {
    const p = projectFinancials(
      synth({
        values: { profitForPeriod: -24 * CR, profitAttributableToOwners: 0 },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, -24 * CR);
  });
});

describe("judgeExclusionComparison — MONEY-1249", () => {
  /**
   * THE REGRESSION. The call site compared a FRACTION against a PERCENTAGE:
   *
   *     rate         = (disagreements / comparable) * 100   // 8.0
   *     excludedRate =  disagree / comparable               // 0.143
   *     if (excludedRate <= rate)                           // ALWAYS TRUE
   *
   * so the refutation printed on every field regardless of direction. These are
   * the three prod cases where it fired and was WRONG.
   */
  const PROD_2026_08_22 = [
    {
      field: "netIncome",
      excludedComparable: 49,
      excludedDisagree: 7,
      gradedRatePct: 8.0,
    },
    {
      field: "totalAssets",
      excludedComparable: 30,
      excludedDisagree: 7,
      gradedRatePct: 13.4,
    },
    {
      field: "totalEquity",
      excludedComparable: 30,
      excludedDisagree: 4,
      gradedRatePct: 6.2,
    },
  ];

  for (const c of PROD_2026_08_22) {
    it(`REGRESSION: ${c.field} — excluded disagrees MORE, so the hypothesis HOLDS`, () => {
      const v = judgeExclusionComparison(c);
      assert.equal(
        v.verdict,
        "BASIS_HYPOTHESIS_HOLDS",
        `${c.field}: ${v.excludedRatePct.toFixed(1)}% excluded vs ${c.gradedRatePct}% graded — ` +
          `the old guard called this REFUTED`,
      );
      assert.ok(
        v.excludedRatePct > c.gradedRatePct,
        "[meta] the fixture must actually exercise the above-graded case",
      );
    });
  }

  it("the fields where the refutation was CORRECT still refute", () => {
    // The control. A fix that flipped everything to HOLDS would pass the three
    // assertions above and be just as wrong in the other direction.
    const operatingIncome = judgeExclusionComparison({
      excludedComparable: 48,
      excludedDisagree: 6,
      gradedRatePct: 23.3,
    });
    assert.equal(operatingIncome.verdict, "BASIS_HYPOTHESIS_REFUTED");
    const ebitda = judgeExclusionComparison({
      excludedComparable: 48,
      excludedDisagree: 7,
      gradedRatePct: 24.7,
    });
    assert.equal(ebitda.verdict, "BASIS_HYPOTHESIS_REFUTED");
  });

  it("BOTH inputs are PERCENTAGES — a fraction is not silently accepted", () => {
    // The unit contract, asserted rather than assumed. 7/49 = 14.3%, and against
    // a graded rate of 8.0 the answer must be HOLDS. If a caller ever passes the
    // graded rate as a FRACTION (0.08) the answer is still HOLDS — the failure
    // mode the original had was the reverse, and it is now impossible because
    // this function computes the excluded side itself.
    const v = judgeExclusionComparison({
      excludedComparable: 49,
      excludedDisagree: 7,
      gradedRatePct: 8.0,
    });
    assert.ok(
      Math.abs(v.excludedRatePct - 14.2857) < 0.001,
      "must be a percentage",
    );
  });

  it("equal rates REFUTE — the exclusion bought a smaller sample, not a cleaner one", () => {
    const v = judgeExclusionComparison({
      excludedComparable: 50,
      excludedDisagree: 10,
      gradedRatePct: 20,
    });
    assert.equal(v.verdict, "BASIS_HYPOTHESIS_REFUTED");
  });

  it("too few excluded pairs is UNDERSIZED, never a verdict either way", () => {
    // Noise is not evidence. Below the floor the gate must say nothing rather
    // than assert a direction from a handful of rows.
    const v = judgeExclusionComparison({
      excludedComparable: EXCLUSION_COMPARISON_MIN_PAIRS - 1,
      excludedDisagree: 19,
      gradedRatePct: 1,
    });
    assert.equal(v.verdict, "UNDERSIZED");
  });

  it("zero excluded pairs does not divide by zero", () => {
    const v = judgeExclusionComparison({
      excludedComparable: 0,
      excludedDisagree: 0,
      gradedRatePct: 10,
    });
    assert.equal(v.verdict, "UNDERSIZED");
    assert.ok(Number.isFinite(v.excludedRatePct));
  });

  it("pins the floor", () => {
    assert.equal(EXCLUSION_COMPARISON_MIN_PAIRS, 20);
  });
});

describe("classifyIncomparable / splitIncomparable — MONEY-1250", () => {
  /**
   * THE DEFECT this answers: the F3 gate prints one `incomparable` count for a
   * bucket that holds two opposite things — a coverage GAP (we have nothing,
   * the vendor does) and a coverage WIN (we have something, the vendor does
   * not). Measured on prod 2026-08-24, `totalAssets` read `comparable 2555 of
   * 4744` and the 2,189 shortfall was 2,165 GAP / 19 WIN / 5 neither. A reader
   * before a one-way door saw only the 2,189.
   */
  it("names WHICH side was empty", () => {
    assert.equal(
      classifyIncomparable({ ours: undefined, theirs: 100 }),
      "OURS_BLANK",
    );
    assert.equal(
      classifyIncomparable({ ours: 100, theirs: undefined }),
      "THEIRS_BLANK",
    );
    assert.equal(
      classifyIncomparable({ ours: undefined, theirs: undefined }),
      "BOTH_BLANK",
    );
    assert.equal(classifyIncomparable({ ours: 1, theirs: 2 }), "COMPARABLE");
  });

  it("BOTH_BLANK is NOT counted as a gap on our side", () => {
    // The precise mis-attribution an inline `ours === undefined ? GAP : WIN`
    // makes. A pair where neither side has a value is not ground we failed to
    // cover — there is nothing to be missing against — and folding it in
    // inflates the one number this function exists to make honest.
    const s = splitIncomparable([
      { ours: undefined, theirs: undefined },
      { ours: undefined, theirs: undefined },
      { ours: undefined, theirs: 5 },
    ]);
    assert.equal(s.bothBlank, 2);
    assert.equal(s.oursBlank, 1, "both-blank must not be added to ours-blank");
    assert.equal(s.theirsBlank, 0);
  });

  it("ZERO is a value, not a blank", () => {
    // A vendor `totalDebt` of 0 is a real disclosure — prod carries several
    // (IITL FY 2024, JINDALPHOT FY 2024). A falsy check would call it absent
    // and move a real comparison into the shortfall.
    assert.equal(classifyIncomparable({ ours: 0, theirs: 0 }), "COMPARABLE");
    assert.equal(
      classifyIncomparable({ ours: undefined, theirs: 0 }),
      "OURS_BLANK",
    );
  });

  it("null is absent, and so is a NON-FINITE number", () => {
    // `null` because Prisma hands a missing column back as null, not undefined,
    // and a caller that forwards the row directly must not have it counted as a
    // value. NaN/Infinity because non-finite money is poison in this repo, and a
    // comparison cannot use one — counting it as present would put a pair that
    // can never be judged into the comparable denominator.
    assert.equal(classifyIncomparable({ ours: null, theirs: 7 }), "OURS_BLANK");
    assert.equal(
      classifyIncomparable({ ours: 7, theirs: null }),
      "THEIRS_BLANK",
    );
    assert.equal(
      classifyIncomparable({ ours: Number.NaN, theirs: 7 }),
      "OURS_BLANK",
    );
    assert.equal(
      classifyIncomparable({ ours: 7, theirs: Number.POSITIVE_INFINITY }),
      "THEIRS_BLANK",
    );
  });

  it("a MIS-FILED comparable pair is counted, never silently dropped", () => {
    // The caller filters on `verdict === "INCOMPARABLE"` before calling this.
    // If that filter ever breaks, the split must SAY so rather than quietly
    // rescale — a shortfall report that absorbs graded pairs is the draining
    // denominator of MONEY-1196 in a new place.
    const s = splitIncomparable([
      { ours: 1, theirs: 2 },
      { ours: undefined, theirs: 2 },
    ]);
    assert.equal(s.comparable, 1);
    assert.equal(s.oursBlank, 1);
  });

  it("the four buckets ALWAYS sum to the input length", () => {
    const pairs = [
      { ours: 1, theirs: 2 },
      { ours: undefined, theirs: 2 },
      { ours: 2, theirs: undefined },
      { ours: undefined, theirs: undefined },
      { ours: null, theirs: null },
      { ours: Number.NaN, theirs: 3 },
    ];
    const s = splitIncomparable(pairs);
    assert.equal(
      s.oursBlank + s.theirsBlank + s.bothBlank + s.comparable,
      pairs.length,
    );
  });

  it("PROD 2026-08-24: the balance-sheet shortfall is OURS, not theirs", () => {
    // The shape the gate now has to be able to print. Reproduced from the
    // measured prod split on `totalAssets` so a regression that re-merges the
    // buckets fails on a real distribution rather than on a toy one.
    const pairs = [
      ...Array.from({ length: 2165 }, () => ({
        ours: undefined,
        theirs: 500,
      })),
      ...Array.from({ length: 19 }, () => ({ ours: 500, theirs: undefined })),
      ...Array.from({ length: 5 }, () => ({
        ours: undefined,
        theirs: undefined,
      })),
    ];
    const s = splitIncomparable(pairs);
    assert.equal(s.oursBlank, 2165);
    assert.equal(s.theirsBlank, 19);
    assert.equal(s.bothBlank, 5);
    assert.ok(
      s.oursBlank > s.theirsBlank * 100,
      "the point of the block: this shortfall is ours, by two orders of magnitude",
    );
  });
});

describe("lenderTopLineShape — MONEY-1250 (the split MONEY-1239 could not make)", () => {
  const CR = 10_000_000;

  /** An RBI Form-A bank: InterestEarned, no RevenueFromOperations. */
  const bank = {
    family: "banking" as const,
    tags: { revenueFromOperations: "InterestEarned" },
  };
  /** An Ind-AS NBFC filing Division III: RevenueFromOperations. */
  const nbfc = {
    family: "nbfc" as const,
    tags: { revenueFromOperations: "RevenueFromOperations" },
  };

  it("an InterestEarned top line is the RBI Form-A shape", () => {
    assert.equal(lenderTopLineShape(bank), "RBI_FORM_A");
  });

  it("a RevenueFromOperations top line is the Ind-AS shape", () => {
    assert.equal(lenderTopLineShape(nbfc), "IND_AS");
  });

  it("a NON-lender is undefined regardless of its tag", () => {
    // The judge must not reach beyond lenders — an Ind-AS manufacturer's top
    // line is revenueFromOperations and always was.
    assert.equal(
      lenderTopLineShape({
        family: "ind-as",
        tags: { revenueFromOperations: "RevenueFromOperations" },
      }),
      undefined,
    );
  });

  it("REGRESSION: an UNRECORDED tag is undefined, never a guess", () => {
    // ~90,188 filings were stored before tags existed. `undefined` must mean
    // "not recorded" and fall through to the old behaviour — guessing from
    // `values` is precisely the move MONEY-1239 implemented and reverted.
    assert.equal(lenderTopLineShape({ family: "banking" }), undefined);
    assert.equal(lenderTopLineShape({ family: "nbfc", tags: {} }), undefined);
  });

  it("REGRESSION: a true BANK still takes InterestEarned as revenue", () => {
    // The case that broke MONEY-1239's first attempt. Screener reports
    // ICICIBANK FY2025 "Revenue" 1,86,331 Cr with "Other Income" 1,08,255 Cr on
    // a SEPARATE line, so the bank's top line IS interest earned and a blanket
    // "lenders use totalIncome" is WRONG for it.
    const icici = {
      family: "banking" as const,
      periodType: "ANNUAL" as const,
      tags: { revenueFromOperations: "InterestEarned" },
      values: {
        revenueFromOperations: 186_331 * CR, // tagged InterestEarned
        otherIncome: 108_255 * CR,
        totalIncome: 294_586 * CR,
      },
    } as unknown as Parameters<typeof projectFinancials>[0];
    const income = stmt(projectFinancials(icici).income, "income");
    assert.equal(
      income.revenueFromOperations,
      186_331 * CR,
      "a bank must keep InterestEarned as its top line, NOT totalIncome",
    );
  });

  it("REGRESSION: an Ind-AS lender keeps revenueFromOperations — the shape does NOT decide", () => {
    // This case ASSERTED THE OPPOSITE for one commit, on 360ONE FY2024
    // CONSOLIDATED alone (screener "Sales" 2,921 = totalIncome 2,924.73, not
    // revenueFromOperations 2,507.03). Two more companies of the SAME Ind-AS
    // lender shape refute the rule:
    //
    //     IWEL       FY2025 STANDALONE  rev 16  oi 878  ti 895  -> screener 16
    //     WILLAMAGOR FY2026 STANDALONE  rev  2  oi 151  ti 153  -> screener  2
    //
    // Both report Other Income on a SEPARATE line, which is what the existing
    // derivation already does. Switching on the shape would have multiplied
    // IWEL's revenue 56x in a column whose unique key carries no `source`.
    const iwel = {
      family: "banking" as const,
      periodType: "ANNUAL" as const,
      tags: { revenueFromOperations: "RevenueFromOperations" },
      values: {
        revenueFromOperations: 16.35 * CR,
        otherIncome: 878.2 * CR,
        totalIncome: 894.55 * CR,
      },
    } as unknown as Parameters<typeof projectFinancials>[0];
    const income = stmt(projectFinancials(iwel).income, "income");
    assert.equal(
      income.revenueFromOperations,
      16.35 * CR,
      "screener reports 16, not the 895 a shape-driven switch would write",
    );
  });

  it("the shape is still CLASSIFIED, it just does not drive revenue", () => {
    // The distinction is real and the tag does state it — keeping the judge is
    // what lets a future fix use it once something identifies WHICH signal
    // decides 360ONE's case. MONEY-1239 DEFECT 2 stays open.
    assert.equal(
      lenderTopLineShape({
        family: "nbfc",
        tags: { revenueFromOperations: "RevenueFromOperations" },
      }),
      "IND_AS",
    );
  });

  it("an Ind-AS lender with NO totalIncome falls back, never to undefined", () => {
    // Coverage is not guaranteed. Falling through to revenueFromOperations is
    // strictly better than emitting nothing for the field.
    const partial = {
      family: "nbfc" as const,
      periodType: "ANNUAL" as const,
      tags: { revenueFromOperations: "RevenueFromOperations" },
      values: { revenueFromOperations: 100 * CR },
    } as unknown as Parameters<typeof projectFinancials>[0];
    const income = stmt(projectFinancials(partial).income, "income");
    assert.equal(income.revenueFromOperations, 100 * CR);
  });
});

describe("roe/roa use AVERAGE denominators — MONEY-1250", () => {
  const CR = 10_000_000;
  /** Equity grew 100 -> 200. Closing gives 50%, average (150) gives 66.67%. */
  const grower = synth({
    values: { profitForPeriod: 100, totalEquity: 200, totalAssets: 400 },
  });
  const growerPrior = priorOf(grower, { totalEquity: 100, totalAssets: 200 });

  it("averages equity across the two filings, not the closing balance", () => {
    // Measured on prod against the vendor (583 symbols, same period, ONLY the
    // denominator changed): closing 45.3% match, average 89.5%, and 92.5% on
    // consolidated filings. Twelve symbols reproduce the vendor to 0.00%.
    const r = deriveRatios(grower, growerPrior);
    assert.ok(r.roe !== undefined);
    assert.equal(r.roe.toFixed(2), "66.67", "100 / ((200+100)/2) = 66.67%");
    assert.notEqual(
      r.roe.toFixed(2),
      "50.00",
      "50% is the CLOSING-equity answer this change replaces",
    );
  });

  it("REGRESSION: a NEGATIVE closing equity is refused even when the AVERAGE is positive", () => {
    // THE CASE AVERAGING BROKE. `pct()` refuses a non-positive denominator, so a
    // negative-equity company yielded no roe. Averaging moved the guard's input
    // out of its reach: OMAXE closes at -196 cr against a prior +488 cr, so the
    // MEAN is +146 cr — positive, accepted, and a -468.79% roe reached the table.
    //
    // The existing "NEGATIVE equity -> roe undefined" case does NOT cover this:
    // it was given a prior carrying the same negative values, so the mean stayed
    // negative and it passed for the wrong reason. A fixture can destroy a test's
    // coverage as thoroughly as editing its assertion.
    const cur = synth({
      values: {
        profitForPeriod: -684 * CR,
        totalEquity: -196 * CR,
        totalAssets: 900 * CR,
      },
    });
    const prior = priorOf(cur, {
      totalEquity: 488 * CR,
      totalAssets: 900 * CR,
    });
    const r = deriveRatios(cur, prior);
    assert.equal(r.roe, undefined, "a company with negative equity has no ROE");
    assert.ok(!("roe" in r));
    // roa is unaffected — both asset balances are positive, and the refusal is
    // per-denominator rather than per-filing.
    assert.ok(r.roa !== undefined);
  });

  it("[meta] the same fixture with POSITIVE closing equity does derive", () => {
    // The falsifiable ceiling: without it, a `mean()` that returned undefined
    // unconditionally would satisfy the case above.
    const cur = synth({
      values: {
        profitForPeriod: -684 * CR,
        totalEquity: 196 * CR,
        totalAssets: 900 * CR,
      },
    });
    const r = deriveRatios(
      cur,
      priorOf(cur, { totalEquity: 488 * CR, totalAssets: 900 * CR }),
    );
    assert.ok(r.roe !== undefined, "two positive balances must still average");
    assert.equal(r.returnBasis, "AVERAGE");
  });

  it("averages assets for roa on the same rule", () => {
    const r = deriveRatios(grower, growerPrior);
    assert.ok(r.roa !== undefined);
    assert.equal(r.roa.toFixed(2), "33.33", "100 / ((400+200)/2) = 33.33%");
  });

  it("no prior year → CLOSING denominator, STAMPED as such", () => {
    // Founder decision 2026-08-23. Refusing was considered and rejected: 35.9%
    // of symbols (845 of 2,353) have no adjacent prior, and some hold only
    // three filing-derived ratios in total — dropping two would take them under
    // `isPlanWorthWriting`'s floor and cost them their WHOLE row, not just
    // these two columns.
    //
    // Both answers are defensible; publishing them in one column without saying
    // which is not. The stamp is what makes the mixture judgeable — the gate
    // compares only AVERAGE rows.
    const r = deriveRatios(grower);
    assert.equal(r.roe?.toFixed(2), "50.00", "100 / 200 closing equity");
    assert.equal(r.roa?.toFixed(2), "25.00", "100 / 400 closing assets");
    assert.equal(r.returnBasis, "CLOSING");
  });

  it("an ADJACENT prior stamps AVERAGE, so the two are distinguishable", () => {
    // The control. Without it, a stamp hardcoded to CLOSING would satisfy the
    // case above and the column would carry no information at all.
    const r = deriveRatios(grower, growerPrior);
    assert.equal(r.returnBasis, "AVERAGE");
  });

  it("no return derived at all → NO stamp", () => {
    // A basis with no ratio beside it asserts a derivation that did not happen.
    const noBalance = synth({ values: { profitForPeriod: 100 } });
    const r = deriveRatios(noBalance);
    assert.equal(r.returnBasis, undefined);
    assert.ok(!("returnBasis" in r));
  });

  it("REGRESSION: a NON-adjacent prior is refused, not averaged across the gap", () => {
    // Only 59.7% of judged symbols hold the adjacent year. `(FY2026+FY2023)/2`
    // is not an average equity for FY2026 — it is a number with no referent,
    // landing in a published column with nothing saying so.
    const threeYearsBack = synth({
      values: { profitForPeriod: 100, totalEquity: 100, totalAssets: 200 },
      period: { start: "2022-07-01", end: "2022-09-30", days: 91 },
    });
    const r = deriveRatios(grower, threeYearsBack);
    assert.equal(
      r.returnBasis,
      "CLOSING",
      "a 3-year gap is not an adjacent year, so the average is not claimed",
    );
    assert.equal(r.roe?.toFixed(2), "50.00", "closing, not (200+100)/2");
    // `assetTurnover` REFUSES rather than falling back — unchanged by the
    // founder decision, which was about roe/roa. It has no stamp column, so a
    // silent basis switch there would be exactly the undeclared mixture the
    // stamp exists to prevent.
    assert.equal(r.assetTurnover, undefined, "assetTurnover is gated too");
  });

  it("[meta] the gap fixture would otherwise have produced a number", () => {
    // The falsifiable ceiling for the case above: same inputs at an ADJACENT
    // period DO produce a value, so the refusal is the gate acting rather than
    // the fixture being unusable.
    const adjacent = priorOf(grower, { totalEquity: 100, totalAssets: 200 });
    assert.equal(deriveRatios(grower, adjacent).returnBasis, "AVERAGE");
  });
});

describe("isAdjacentAnnual — MONEY-1250", () => {
  // Basis is part of adjacency (MONEY-1250) — a fixture without one is refused,
  // so the default here supplies a matching pair and the basis cases override it.
  const at = (end: string, basis = "CONSOLIDATED") => ({
    period: { end },
    basis,
  });

  it("one fiscal year back is adjacent", () => {
    assert.equal(isAdjacentAnnual(at("2025-03-31"), at("2024-03-31")), true);
  });

  it("tolerates a 53-week year and a late filing", () => {
    assert.equal(isAdjacentAnnual(at("2025-04-05"), at("2024-03-31")), true);
  });

  it("two years back is NOT adjacent", () => {
    assert.equal(isAdjacentAnnual(at("2026-03-31"), at("2024-03-31")), false);
  });

  it("a prior that is NEWER is not adjacent — order matters", () => {
    assert.equal(isAdjacentAnnual(at("2024-03-31"), at("2025-03-31")), false);
  });

  it("REGRESSION: a BASIS CHANGE is not adjacent — MONEY-1250", () => {
    // `selectPeriodWinners` groups on periodEnd|periodType|cumulative with no
    // basis, so the two filings handed to `deriveRatios` can be on DIFFERENT
    // bases. Averaging a STANDALONE closing against a CONSOLIDATED prior gives
    // a denominator describing no entity that exists — and it reached the table
    // stamped `returnBasis: "AVERAGE"`, asserting exactly what did not happen.
    // 29 of 532 graded pairs.
    assert.equal(
      isAdjacentAnnual(
        at("2025-03-31", "STANDALONE"),
        at("2024-03-31", "CONSOLIDATED"),
      ),
      false,
    );
    assert.equal(
      isAdjacentAnnual(
        at("2025-03-31", "CONSOLIDATED"),
        at("2024-03-31", "STANDALONE"),
      ),
      false,
      "and in the other direction",
    );
  });

  it("an UNKNOWN basis is refused, not assumed to match", () => {
    // Same reasoning as `tags` being optional: not-recorded is not matching.
    assert.equal(
      isAdjacentAnnual({ period: { end: "2025-03-31" } }, at("2024-03-31")),
      false,
    );
    assert.equal(
      isAdjacentAnnual(at("2025-03-31"), {
        period: { end: "2024-03-31" },
        basis: null,
      }),
      false,
    );
  });

  it("[meta] the SAME dates with a matching basis DO pass", () => {
    // The ceiling for the two cases above — otherwise a function that always
    // returned false would satisfy them.
    assert.equal(
      isAdjacentAnnual(
        at("2025-03-31", "STANDALONE"),
        at("2024-03-31", "STANDALONE"),
      ),
      true,
    );
  });

  it("a missing or unparseable period is not adjacent", () => {
    assert.equal(isAdjacentAnnual(at("2025-03-31"), undefined), false);
    assert.equal(isAdjacentAnnual(undefined, at("2024-03-31")), false);
    assert.equal(isAdjacentAnnual(at("2025-03-31"), at("garbage")), false);
  });
});

describe("vendorComparablePeriodEnd — MONEY-1250", () => {
  it("a March-2026 snapshot cannot describe FY2026", () => {
    // FY2026 ends 2026-03-31 and is filed up to ~60 days later, so a row
    // computed 2026-03-21 describes FY2025. Comparing it to our FY2026 filing
    // is two different years, not a disagreement — that join produced 90 of the
    // 127 sign mismatches.
    const w = vendorComparablePeriodEnd(new Date("2026-03-21"));
    assert.ok(w !== undefined);
    assert.ok(
      w < new Date("2026-03-31"),
      "FY2026 must fall OUTSIDE a March-2026 snapshot's window",
    );
    assert.ok(
      w > new Date("2025-03-31"),
      "FY2025 must fall INSIDE it — otherwise the window is too tight",
    );
  });

  it("[meta] the window actually discriminates between the two years", () => {
    // The falsifiable ceiling. A window that excluded BOTH years, or included
    // both, would satisfy a one-sided assertion while selecting nothing useful.
    const w = vendorComparablePeriodEnd(new Date("2026-03-21"))!;
    const fy2025 = new Date("2025-03-31");
    const fy2026 = new Date("2026-03-31");
    assert.equal(fy2025 <= w, true);
    assert.equal(fy2026 <= w, false);
  });

  it("accepts an ISO string as well as a Date", () => {
    assert.deepEqual(
      vendorComparablePeriodEnd("2026-03-21T00:00:00.000Z"),
      vendorComparablePeriodEnd(new Date("2026-03-21T00:00:00.000Z")),
    );
  });

  it("REGRESSION: an undated vendor row yields undefined, never a fallback", () => {
    // The caller must NOT fall back to "newest" — falling back IS the defect.
    assert.equal(vendorComparablePeriodEnd(null), undefined);
    assert.equal(vendorComparablePeriodEnd(undefined), undefined);
    assert.equal(vendorComparablePeriodEnd("not a date"), undefined);
  });

  it("pins the lag — it decides which fiscal year is comparable", () => {
    // Too SHORT picks a year the vendor could not have seen and manufactures
    // disagreements; too LONG picks the prior year, which is conservative but
    // comparable. The asymmetry is why 75 rather than 60.
    assert.equal(VENDOR_REPORTING_LAG_DAYS, 75);
  });
});

describe("lender totalDebt — two shapes, opposite answers (MONEY-1250)", () => {
  const CR = 10_000_000;
  const indAsLender = (v: Record<string, number>) =>
    ({
      family: "banking" as const, // 665 NBFC filings carry this — see below
      periodType: "ANNUAL" as const,
      values: v,
    }) as unknown as Parameters<typeof projectFinancials>[0];

  it("an Ind-AS lender sums all FOUR funding lines — BAJFINANCE FY2026", () => {
    // Third-sourced to 0.00%: screener's `Borrowing` row = 435,112 Cr.
    // `Borrowings` ALONE is 170,642.53 — 39.2% of the truth, and that is the
    // MEDIAN case, not an outlier. Above Rs 10,000 Cr of debt the old
    // derivation agreed with the incumbent on 0 of 43 company-years.
    const bs = stmt(
      projectFinancials(
        indAsLender({
          debtSecurities: 193_131.9 * CR,
          borrowings: 170_642.53 * CR,
          subordinatedLiabilities: 2_805.31 * CR,
          deposits: 68_532.75 * CR,
          totalAssets: 500_000 * CR,
          totalEquity: 116_985.54 * CR,
        }),
      ).balanceSheet,
      "balance sheet",
    );
    assert.equal(bs.totalDebt, 435_112.49 * CR);
  });

  it("a MISSING funding line counts as zero, it does not void the sum", () => {
    // `sumAll` would return undefined and delete the totalDebt of every NBFC
    // with no subordinated debt. The absences are measured true zeros: 433 of
    // 437 filings reconcile the additive children against their own
    // `FinancialLiabilities` total to within 0.5%.
    const bs = stmt(
      projectFinancials(
        indAsLender({
          borrowings: 100 * CR,
          deposits: 40 * CR,
          totalEquity: 50 * CR,
        }),
      ).balanceSheet,
      "balance sheet",
    );
    assert.equal(bs.totalDebt, 140 * CR);
  });

  it("REGRESSION: the branch is on FILING SHAPE, not on `family`", () => {
    // `family` is "banking" for 665 NBFC documents, because an NBFC tags
    // `InterestEarned` and the classifier keys on that. Branching on it would
    // have applied the BANK rule — withholding totalDebt — to exactly the
    // filings that need the four-way sum. `bankCapital` is the measured
    // discriminator: 76 of 76 Form-A filings, 0 of 871 Ind-AS ones.
    const bs = stmt(
      projectFinancials(
        indAsLender({
          borrowings: 100 * CR,
          debtSecurities: 60 * CR,
          totalEquity: 50 * CR,
        }),
      ).balanceSheet,
      "balance sheet",
    );
    assert.equal(
      bs.totalDebt,
      160 * CR,
      "family is 'banking' here and the Ind-AS rule must still apply",
    );
  });

  it("a Form-A bank withholds totalDebt even though Borrowings IS present", () => {
    // The discriminator is `bankCapital`. `Borrowings` is sourceable and
    // correct — it is withheld on judgement, not on availability.
    const bs = stmt(
      projectFinancials(
        indAsLender({
          bankCapital: 3_060.19 * CR,
          bankReservesAndSurplus: 256_479.8 * CR,
          borrowings: 124_492.93 * CR,
          deposits: 1_000_000 * CR,
          totalAssets: 1_976_858.23 * CR,
        }),
      ).balanceSheet,
      "balance sheet",
    );
    assert.equal(bs.totalDebt, undefined);
    assert.ok(!("totalDebt" in bs));
  });

  it("[meta] the same values WITHOUT bankCapital do produce a sum", () => {
    // The falsifiable ceiling for the case above — otherwise a derivation that
    // always withheld would satisfy it.
    const bs = stmt(
      projectFinancials(
        indAsLender({
          borrowings: 124_492.93 * CR,
          deposits: 1_000_000 * CR,
          totalAssets: 1_976_858.23 * CR,
          totalEquity: 259_539.99 * CR,
        }),
      ).balanceSheet,
      "balance sheet",
    );
    assert.equal(bs.totalDebt, 1_124_492.93 * CR);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1250 (T3.3) — the THIRD negated-label shape                           */
/* -------------------------------------------------------------------------- */

/**
 * Shapes (a) and (b) both assume the filer negated the OWNERS' line and got the
 * minority line right. A third shape exists and is measured on prod: BOTH
 * attribution elements tagged as unsigned MAGNITUDES of a loss, with
 * `profitForPeriod` carrying the sign correctly.
 *
 * Every fixture below is a REAL prod row, to the rupee. Consolidated filings
 * matching the signature: 19 ANNUAL + 31 QUARTERLY; already handled by the
 * owners-only mask: 13 + 21; NEWLY corrected here: 6 + 10. Replaying both
 * formulas over all 96,063 stored filings, netIncome moves on 27 of them.
 */
describe("projectFinancials — BOTH attribution lines negated (MONEY-1250 T3.3)", () => {
  it("IITL FY2021: +41.94 crore for a year the company lost 42 — the gate's last netIncome SIGN mismatch", () => {
    // owners +419,447,000, nci +47,097,000, pfp -467,863,000.
    // |owners| + |nci| = 466,544,000 against |pfp| = 467,863,000 — 0.28% apart.
    // The filing's own roll-up carries the sign correctly:
    //   profitFromContinuingOperations -14,085,000
    //   + shareOfProfitOfAssociates   -453,778,000  = -467,863,000 exactly.
    const p = projectFinancials(
      synth({
        basis: "consolidated",
        values: {
          profitAttributableToOwners: 419_447_000,
          profitAttributableToNonControllingInterests: 47_097_000,
          profitForPeriod: -467_863_000,
        },
      }),
    );
    const got = stmt(p.income, "income").netIncome;
    // Re-derived through the identity with the minority line's sign corrected:
    // owners = pfp - (-nci) = pfp + nci. The vendor says -42.04 crore; this is
    // -42.0766, i.e. 0.09% away.
    assert.equal(got, -420_766_000);
    // The three answers this must NOT give:
    assert.notEqual(got, 419_447_000); // the tag, unmasked — a PROFIT for a loss year
    assert.notEqual(got, -514_960_000); // pfp - nci, the owners-only reference
    assert.notEqual(got, -467_863_000); // the total, minorities not attributed away
  });

  it("ASHOKA FY2018 / PROVOGE FY2018 / PUNJLLOYD FY2018 / WIPL FY2021: the sign flips", () => {
    const cases: Array<[string, number, number, number, number]> = [
      ["ASHOKA", 1_111_434_000, 75_112_000, -1_186_544_000, -1_111_432_000],
      ["PROVOGE", 1_725_542_000, 39_312_000, -1_764_854_000, -1_725_542_000],
      ["PUNJLLOYD", 687_500_000, 30_700_000, -718_200_000, -687_500_000],
      ["WIPL", 4_300_000, 2_700_000, -7_000_000, -4_300_000],
    ];
    for (const [name, owners, nci, pfp, expected] of cases) {
      const p = projectFinancials(
        synth({
          basis: "consolidated",
          values: {
            profitAttributableToOwners: owners,
            profitAttributableToNonControllingInterests: nci,
            profitForPeriod: pfp,
          },
        }),
      );
      assert.equal(stmt(p.income, "income").netIncome, expected, name);
    }
  });

  it("REGRESSION: a filing whose own identity HOLDS can never reach this rule", () => {
    // Structural, not tolerance-dependent, and it is the reason this widening
    // is safe in front of a column whose unique key has no `source`. If
    // `owners + nci === pfp` then `(owners + nci) * pfp === pfp²`, which is
    // positive, so the sign test is false before any magnitude is compared.
    //
    // PDSL and APLLTD are the real wholly-minority-absorbed years that must
    // stay untouched: a large positive NCI absorbing a total profit while the
    // owners took a small loss.
    for (const [owners, nci, pfp] of [
      [-78_400_000, 273_800_000, 195_400_000], // PDSL
      [-10_800_000, 5_843_700_000, 5_832_900_000], // APLLTD FY2019
    ]) {
      const p = projectFinancials(
        synth({
          basis: "consolidated",
          values: {
            profitAttributableToOwners: owners!,
            profitAttributableToNonControllingInterests: nci!,
            profitForPeriod: pfp!,
          },
        }),
      );
      assert.equal(
        stmt(p.income, "income").netIncome,
        owners,
        "a self-consistent filing keeps its own tagged owners' share",
      );
    }
  });

  it("REGRESSION: a genuine minority split with matching signs is untouched", () => {
    // owners and pfp agree in sign, so nothing here is a negated label at all.
    const p = projectFinancials(
      synth({
        basis: "consolidated",
        values: {
          profitAttributableToOwners: 800_000_000,
          profitAttributableToNonControllingInterests: 200_000_000,
          profitForPeriod: 1_000_000_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, 800_000_000);
  });
});

describe("projectFinancials — the tie-break between the two negated readings", () => {
  it("HINDWAREAP FY2025: the OWNERS-ONLY reading is exact, and must win", () => {
    // att +682,900,000, nci +2,800,000, pfp -680,100,000. Both masks fire.
    //   owners-only:  -682,900,000 + 2,800,000 = -680,100,000  = pfp EXACTLY
    //   both-negated: -682,900,000 - 2,800,000 = -685,700,000  = 0.82% off
    // So this filing negated one line, not two, and the incumbent answer is
    // right. A rule that simply ordered the new branch first would break it.
    const p = projectFinancials(
      synth({
        basis: "consolidated",
        values: {
          profitAttributableToOwners: 682_900_000,
          profitAttributableToNonControllingInterests: 2_800_000,
          profitForPeriod: -680_100_000,
        },
      }),
    );
    assert.equal(stmt(p.income, "income").netIncome, -682_900_000);
    assert.notEqual(stmt(p.income, "income").netIncome, -677_300_000);
  });

  it("SELMCL FY2018: the BOTH-NEGATED reading is exact, and must win", () => {
    // The mirror image, and the one that had to be MEASURED. att
    // +25,274,833,000, nci +2,181,000, pfp -25,277,014,000. Both masks fire.
    //   owners-only:  residual 4,362,000 (0.017%)
    //   both-negated: residual         0
    // Measured over every consolidated filing with a non-zero NCI where both
    // masks fire (17 rows), the both-negated reading is the exact one in 10.
    // Positional precedence would have kept the wrong answer in all ten.
    const p = projectFinancials(
      synth({
        basis: "consolidated",
        values: {
          profitAttributableToOwners: 25_274_833_000,
          profitAttributableToNonControllingInterests: 2_181_000,
          profitForPeriod: -25_277_014_000,
        },
      }),
    );
    const got = stmt(p.income, "income").netIncome;
    // The filing's own EPS is an INDEPENDENT third figure — under Ind-AS 33 it
    // is computed on the owners' share alone, so it cannot be derived from the
    // three tags this rule reads. -76.28 x 331,373,875 shares = -25,275,149,160.
    assert.equal(got, -25_274_833_000);
    assert.notEqual(
      got,
      -25_279_195_000,
      "the owners-only reference is 0.017% worse",
    );
  });

  it("KOTARISUG Q4-FY2018: a STANDALONE filing that tags an NCI anyway", () => {
    // Written down rather than rounded off. att +35,195,000, nci +12,703,000,
    // pfp -47,897,000 on a STANDALONE filing, where minorities cannot exist.
    // The incumbent formula fires neither mask and keeps +35,195,000 — a
    // POSITIVE net income for a quarter the company lost money, feeding
    // netMargin, ROE and every screener rank.
    //
    // The corrected value is -35,194,000. Its EPS implies -46,417,616, so the
    // sign is now right and the magnitude is still ~24% light. That trade is
    // deliberate: zeroing the NCI on standalone filings (which is what
    // `attributableIsLazyNearZero` does) stops the rule firing here at all and
    // restores the positive number.
    const p = projectFinancials(
      synth({
        basis: "standalone",
        values: {
          profitAttributableToOwners: 35_195_000,
          profitAttributableToNonControllingInterests: 12_703_000,
          profitForPeriod: -47_897_000,
        },
      }),
    );
    const got = stmt(p.income, "income").netIncome;
    assert.equal(got, -35_194_000);
    assert.ok(
      got !== undefined && got < 0,
      "a loss quarter must not report a profit",
    );
  });

  it("REGRESSION: the 2% band, not the 5% the census was drawn at", () => {
    // Measured: every one of the 16 newly corrected filings sits at <=0.28%,
    // so 2% and 5% select the SAME rows and the looser band buys nothing. It
    // would only shrink the margin between this shape and a genuine
    // near-breakeven attribution split. 3% apart must therefore be refused.
    const p = projectFinancials(
      synth({
        basis: "consolidated",
        values: {
          profitAttributableToOwners: 400_000_000,
          profitAttributableToNonControllingInterests: 30_000_000,
          profitForPeriod: -417_000_000, // |sum| 430m vs 417m = 3.1% apart
        },
      }),
    );
    assert.equal(
      stmt(p.income, "income").netIncome,
      400_000_000,
      "outside the band the tag stands, exactly as before",
    );
  });
});
