/**
 * UNIT TEST — `document_financial_extracts` → `RatioInputs` (MONEY-1346).
 *
 * ## What is actually at risk here
 *
 * The mapper is twelve assignments, which is exactly why it needs a test: every
 * one of its failure modes produces a NUMBER, and a wrong number in this
 * pipeline is invisible downstream. Three classes, all asserted below.
 *
 *   1. **SCALE.** The extract stores CRORES; `XbrlFinancials.values` is
 *      ABSOLUTE RUPEES. A missing `× 1e7` leaves every MARGIN perfectly correct
 *      (a ratio of two same-scale figures) while market cap, enterprise value
 *      and EV/EBITDA are wrong by ten million. So the scale is asserted on the
 *      RAW values AND through `deriveShareCount`, whose output is a count and
 *      therefore changes when either side of `paidUpCapital / faceValue` is
 *      scaled — the only cheap end-to-end detector of a half-applied conversion.
 *   2. **THE THREE UNSCALED COLUMNS.** `eps` and `faceValue` are rupees PER
 *      SHARE. `document-financials-logic.ts` marks them `unscaled` for a reason
 *      it states: "a face value of ₹10 read as in-lakhs becomes ₹0.1 and still
 *      looks like a plausible face value". Scaling them here is the same bug
 *      pointing the other way.
 *   3. **ABSENCE.** `null` must never become `0`. A `netIncome: 0` for a
 *      company whose profit was not read makes `netMargin` 0%, which reads as a
 *      fact rather than as a gap.
 *
 * Everything here is pure: no Prisma, no clock, no I/O, nothing to orphan.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractToRatioInputs,
  selectAnnualExtractsByPeriod,
  type DocumentExtractRow,
} from "../../src/market-data/document-ratio-inputs";
import { deriveShareCount } from "../../src/market-data/xbrl-valuation";
import { deriveRatios } from "../../src/market-data/xbrl-projection";
import { RUPEES_PER_CRORE } from "../../src/market-data/xbrl-financials-logic";

const CR = RUPEES_PER_CRORE;

function row(over: Partial<DocumentExtractRow> = {}): DocumentExtractRow {
  return {
    periodEnd: new Date("2025-03-31T00:00:00.000Z"),
    periodType: "ANNUAL",
    basis: "CONSOLIDATED",
    revenueFromOperations: 1_000,
    otherIncome: 20,
    operatingIncomeExOtherIncome: 150,
    ebitdaBeforeExceptionalItems: 200,
    netIncome: 100,
    totalAssets: 2_000,
    totalLiabilities: 1_000,
    totalEquity: 1_000,
    totalDebt: 300,
    totalCash: 50,
    eps: 10,
    faceValue: 10,
    paidUpCapital: 100,
    ...over,
  };
}

describe("extractToRatioInputs — units", () => {
  it("converts every MONEY column from crores to absolute rupees", () => {
    const v = extractToRatioInputs(row()).values;
    assert.equal(v.revenueFromOperations, 1_000 * CR);
    assert.equal(v.otherIncome, 20 * CR);
    assert.equal(v.profitForPeriod, 100 * CR);
    assert.equal(v.totalAssets, 2_000 * CR);
    assert.equal(v.totalLiabilities, 1_000 * CR);
    assert.equal(v.totalEquity, 1_000 * CR);
    assert.equal(v.borrowings, 300 * CR);
    assert.equal(v.cashAndCashEquivalents, 50 * CR);
    assert.equal(v.paidUpEquityShareCapital, 100 * CR);
  });

  it("leaves the PER-SHARE columns alone — eps and faceValue are rupees", () => {
    const v = extractToRatioInputs(row()).values;
    assert.equal(v.basicEps, 10, "eps must not be scaled");
    assert.equal(v.faceValuePerShare, 10, "faceValue must not be scaled");
  });

  it("the share COUNT comes out right, which only holds if BOTH sides agree", () => {
    // ₹100 Cr paid-up over a ₹10 face value is 10,00,00,000 shares. This is the
    // end-to-end detector: scale neither side and it is 10,00,00,000/10 = 1e7;
    // scale both and it is 1e9. Only the correct pairing gives 1e8.
    const shares = deriveShareCount(extractToRatioInputs(row()));
    assert.equal(shares?.shares, 100_000_000);
    assert.equal(shares?.basis, "paid-up");
  });

  it("reports the two directly-reported income lines in rupees too", () => {
    const i = extractToRatioInputs(row());
    assert.equal(i.reportedIncome?.operatingIncomeExOtherIncome, 150 * CR);
    assert.equal(i.reportedIncome?.ebitdaBeforeExceptionalItems, 200 * CR);
  });
});

describe("extractToRatioInputs — absence is never a zero", () => {
  it("omits a null column entirely rather than writing 0", () => {
    const v = extractToRatioInputs(
      row({ netIncome: null, totalEquity: null, eps: null }),
    ).values;
    assert.equal("profitForPeriod" in v, false);
    assert.equal("totalEquity" in v, false);
    assert.equal("basicEps" in v, false);
  });

  it("a genuine ZERO survives — it is data, not absence", () => {
    const v = extractToRatioInputs(row({ netIncome: 0 })).values;
    assert.equal(v.profitForPeriod, 0);
  });

  it("refuses a non-finite value", () => {
    const v = extractToRatioInputs(
      row({
        netIncome: Number.NaN,
        totalAssets: Number.POSITIVE_INFINITY,
      }),
    ).values;
    assert.equal("profitForPeriod" in v, false);
    assert.equal("totalAssets" in v, false);
  });

  it("omits `reportedIncome` when NEITHER line was read", () => {
    // The optional field must mean "this source reported nothing directly", not
    // "it reported two absences" — a present-but-empty object would make the
    // `??` fallback in `projectFinancials` look armed when it has nothing.
    const i = extractToRatioInputs(
      row({
        operatingIncomeExOtherIncome: null,
        ebitdaBeforeExceptionalItems: null,
      }),
    );
    assert.equal(i.reportedIncome, undefined);
  });
});

describe("extractToRatioInputs — period and basis", () => {
  it("an ANNUAL row spans end − 1 year + 1 day, inclusive", () => {
    const p = extractToRatioInputs(row()).period;
    assert.deepEqual(p, { start: "2024-04-01", end: "2025-03-31", days: 365 });
  });

  it("a LEAP fiscal year comes out at 366 without a special case", () => {
    const p = extractToRatioInputs(
      row({ periodEnd: new Date("2024-03-31T00:00:00.000Z") }),
    ).period;
    assert.deepEqual(p, { start: "2023-04-01", end: "2024-03-31", days: 366 });
  });

  it("a QUARTERLY row spans three months", () => {
    const p = extractToRatioInputs(
      row({
        periodType: "QUARTERLY",
        periodEnd: new Date("2025-06-30T00:00:00.000Z"),
      }),
    ).period;
    assert.deepEqual(p, { start: "2025-04-01", end: "2025-06-30", days: 91 });
  });

  it("lower-cases the stored basis", () => {
    assert.equal(extractToRatioInputs(row()).basis, "consolidated");
    assert.equal(
      extractToRatioInputs(row({ basis: "STANDALONE" })).basis,
      "standalone",
    );
  });

  it("refuses an unrecognised basis rather than picking one", () => {
    // `isAdjacentAnnual` treats an absent basis as UNKNOWN and refuses to
    // average across it, which is the right answer for a value we do not
    // recognise. Mapping it onto one of the two would assert a comparability
    // nobody checked.
    assert.equal(extractToRatioInputs(row({ basis: "COMBINED" })).basis, null);
  });

  it("family is `ind-as`, so the lender refusals do NOT fire", () => {
    assert.equal(extractToRatioInputs(row()).family, "ind-as");
  });
});

describe("extractToRatioInputs feeds the SAME derivations", () => {
  const prior = row({
    periodEnd: new Date("2024-03-31T00:00:00.000Z"),
    revenueFromOperations: 900,
    netIncome: 80,
  });

  it("produces the margins and returns, at the values the arithmetic says", () => {
    const r = deriveRatios(
      extractToRatioInputs(row()),
      extractToRatioInputs(prior),
    );
    assert.equal(r.netMargin, 10, "100 Cr over 1,000 Cr");
    assert.equal(r.operatingMargin, 15, "150 Cr over 1,000 Cr");
    assert.equal(r.ebitdaMargin, 20, "200 Cr over 1,000 Cr");
    assert.equal(r.roe, 10, "100 Cr over an averaged 1,000 Cr equity");
    assert.equal(r.roa, 5, "100 Cr over an averaged 2,000 Cr asset base");
    assert.equal(r.returnBasis, "AVERAGE");
    assert.equal(r.assetTurnover, 0.5);
  });

  it("growth is year-over-year off the prior ANNUAL row", () => {
    const r = deriveRatios(
      extractToRatioInputs(row()),
      extractToRatioInputs(prior),
    );
    assert.ok(r.revenueGrowth !== undefined);
    assert.ok(Math.abs(r.revenueGrowth - 11.1111) < 0.001);
    assert.equal(r.earningsGrowth, 25);
  });

  it("REFUSES the columns this cohort genuinely cannot support", () => {
    // Stated as assertions rather than left to be discovered as a column of
    // nulls. `roce` and `interestCoverage` need `profitBeforeTax` and
    // `financeCosts`; the extraction prompt asks for neither. `debtToEquity`
    // needs the current/non-current borrowing split that a single `totalDebt`
    // cannot supply without fabricating a maturity classification.
    const r = deriveRatios(extractToRatioInputs(row()));
    assert.equal(r.roce, undefined);
    assert.equal(r.interestCoverage, undefined);
    assert.equal(r.debtToEquity, undefined);
  });

  it("a MISSING reported EBITDA line yields no ebitdaMargin, not a zero", () => {
    const r = deriveRatios(
      extractToRatioInputs(row({ ebitdaBeforeExceptionalItems: null })),
    );
    assert.equal(r.ebitdaMargin, undefined);
    assert.equal(r.netMargin, 10, "the other margins are unaffected");
  });
});

describe("selectAnnualExtractsByPeriod — one row per period", () => {
  const consolidated = row({ basis: "CONSOLIDATED", totalAssets: 19_768 });
  const standalone = row({ basis: "STANDALONE", totalAssets: 7_332 });

  it("prefers CONSOLIDATED whichever order the rows arrive in", () => {
    // 360ONE FY2025: 19,768 Cr consolidated against 7,332 Cr standalone. The
    // two differ by a MULTIPLE, so an order-dependent choice is a different
    // company's balance sheet on alternate nights.
    for (const rows of [
      [consolidated, standalone],
      [standalone, consolidated],
    ]) {
      const picked = selectAnnualExtractsByPeriod(rows);
      assert.equal(picked.length, 1);
      assert.equal(picked[0]!.basis, "CONSOLIDATED");
    }
  });

  it("keeps STANDALONE when that is all the company filed", () => {
    const picked = selectAnnualExtractsByPeriod([standalone]);
    assert.equal(picked[0]!.basis, "STANDALONE");
  });

  it("sorts periods NEWEST first regardless of input order", () => {
    const older = row({ periodEnd: new Date("2023-03-31T00:00:00.000Z") });
    const newest = row({ periodEnd: new Date("2025-03-31T00:00:00.000Z") });
    const middle = row({ periodEnd: new Date("2024-03-31T00:00:00.000Z") });
    const picked = selectAnnualExtractsByPeriod([older, newest, middle]);
    assert.deepEqual(
      picked.map((r) => r.periodEnd.toISOString().slice(0, 10)),
      ["2025-03-31", "2024-03-31", "2023-03-31"],
    );
  });

  it("so [0] and [1] are two DIFFERENT fiscal years, never two bases of one", () => {
    // The whole point: handing `deriveRatios` the newest two ROWS would compare
    // a group against a parent and publish the consolidation gap as growth.
    const picked = selectAnnualExtractsByPeriod([
      consolidated,
      standalone,
      row({ periodEnd: new Date("2024-03-31T00:00:00.000Z") }),
    ]);
    assert.equal(picked.length, 2);
    assert.notEqual(
      picked[0]!.periodEnd.getTime(),
      picked[1]!.periodEnd.getTime(),
    );
  });

  it("drops a row whose periodEnd is not a real date", () => {
    const bad = row({ periodEnd: new Date("not-a-date") });
    assert.deepEqual(selectAnnualExtractsByPeriod([bad]), []);
  });
});
