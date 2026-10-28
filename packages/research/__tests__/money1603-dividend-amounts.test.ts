/**
 * MONEY-1603: the dividend amount a subject names, and every one it names.
 *
 * `parseDividendPerShare` required the word "dividend", so NSE's "Int Div-Rs
 * 0.5 Per Sh" read null (1,665 prod rows). And it kept ONE amount from a
 * subject naming two dividends: the first amount followed by "per share",
 * which in "Final Dividend - Rs 7/- + Special Dividend -Rs 3/- Per Share" is
 * the special's 3 (392 rows; RAJPALAYAM 7.50 where 15 is right).
 *
 * Subjects are verbatim from prod `corporate_actions`.
 *
 * ## Mutation log
 *
 * Each case was run against a deliberately broken source and confirmed red
 * before being kept. Recorded at each `it(...)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  combinedDividendLeg,
  dividendReading,
  parseDividendPerShare as amount,
} from "../src/data-sources/nse-filings-logic";

describe("'Div' counts only when an amount is bound to it", () => {
  // Mutation: drop `\bdiv\b\.?` from BOUND_DIVIDEND -> RED on all four.
  it("reads NSE's abbreviations", () => {
    assert.equal(amount(" Div - Rs 0.50 Per Sh"), 0.5); // ASHAPURMIN
    assert.equal(amount(" Int Div-Rs 0.5 Per Sh"), 0.5); // SHREEPUSHK
    assert.equal(amount("Annual General Meeting/Div.Rs.9/- Per Share"), 9); // LAKSHMIMIL
    assert.equal(amount("Agm/Div-Re.1/- Per Share"), 1); // SKIL
  });

  // Mutation: let a kind count on its own (`|${DIVIDEND_KIND}` as a third
  // alternative) -> RED: the split abbreviation "Spl-Rs10" reads as a special
  // dividend of 10.
  it("a percentage, or a split's 'Spl', names no amount", () => {
    assert.equal(amount("Agm/Div-50%/Rights-1:6"), null); // OCL
    assert.equal(amount("Fv Spl-Rs10tors2/Div-1.50record Date Revised"), null); // VINATIORGA
  });

  // Mutation: drop `\bdivided` -> RED (1.5, the special alone).
  it("reads NSE's typos 'Divdend' and 'Divided'", () => {
    assert.equal(amount("Interim Divdend - Rs 2 Per Share"), 2); // AEGISLOG
    assert.equal(
      amount(
        "Annual General Meeting/Divided - Rs 3.50 Per Share/Special Dividend - Rs 1.50 Per Share",
      ),
      5,
    );
  });
});

describe("every dividend a subject names is paid, so they are summed", () => {
  // Mutation: return only the first named amount -> RED on all.
  it("an ordinary and a special, in every separator prod uses", () => {
    assert.equal(
      amount("Dividend - Rs 20 Per Share/Special Dividend - Rs 7.50"),
      27.5,
    ); // DLINKINDIA
    assert.equal(
      amount(
        " Annual General Meeting/ Final Dividend - Rs 7/- + Special Dividend -Rs 3/- Per Share",
      ),
      10,
    ); // the old parser read 3
    assert.equal(
      amount(
        "Final Dividend Rs.7.50 Per Share And Special Dividend Rs.7.50 Per Share/Bonus 1:1 (Purpose Revised)",
      ),
      15,
    ); // RAJPALAYAM
    assert.equal(
      amount(
        "Final Dividend Rs.2/- Per Share/Interim Dividend Rs.2/- Per Share/Special Dividend Rs.2/- Per Share/Annual General Meeting (Purpose Revised)",
      ),
      6,
    ); // HCLTECH, three
  });

  // Mutation: drop the `.toFixed(6)` rounding -> RED (1.2000000000000002;
  // 9 prod sums carry that noise).
  it("sums to the rupee value, not a float's", () => {
    assert.equal(
      amount(
        " Interim Dividend Re 0.80/- Per Share + Special Dividend Re 0.40/- Per Share ",
      ),
      1.2,
    );
    assert.equal(
      amount(
        "Dividend - Re 0.85 Per Share/ Special Dividend - Re 0.70 Per Share",
      ),
      1.55,
    );
  });

  // Mutation: drop the `(?:[+&]|\band\b)\s*KIND` chain -> RED on all three.
  // Mutation: drop `\band\b` from it -> RED on the "And" case.
  // Mutation: drop the kind after the word -> RED on MANAPPURAM and VISAKAIND.
  it("the oldest wording: the kind after the word, a second dividend chained on", () => {
    assert.equal(amount("Agm/Div-Fin Rs.3+Spl Re1"), 4); // VISAKAIND
    assert.equal(
      amount(
        "Annual General Meeting/Div - Final Re 0.50 + Special Re 0.50 Per Share",
      ),
      1,
    ); // MANAPPURAM
    assert.equal(
      amount("Dividend - Final Rs 4/- And Special Re 1/- Per Share"),
      5,
    );
  });
});

describe("a named amount is a per-share amount", () => {
  // Mutation: drop the total/crore lookahead -> RED (100). The subject is the
  // existing apps/web fixture; Screener's prose carries totals like it.
  it("a total beside the per-share amount is not the dividend", () => {
    assert.equal(amount("Dividend Rs 100 total, Rs 5 per share"), 5);
  });

  // Mutation: the lookahead as `[\d.]` (any following dot) -> RED (1.5).
  it("a period after the amount ends it; a digit continues it", () => {
    assert.equal(
      amount(
        "Dividend - Rs  1.50 Per Share And Special Dividend - Rs 2. Per Share",
      ),
      3.5,
    );
  });
});

describe("what is not a named dividend reads as it did", () => {
  // Mutation: drop the UNIT_DISTRIBUTION guard -> RED on both: each reads the
  // NEXT part's amount, CAPINVIT 1.38 and KRT 0.03 (its interest).
  it("a unit trust's distribution, whose parts follow their amounts", () => {
    assert.equal(
      amount(
        "Distribution - Rs 12.71 Per Unit Consisting Of Rs 11.22 Per Unit Taxable Dividend & Rs 1.38 Per Unit Exempt Dividend/ Interest Payment Re 0.11 Per Unit",
      ),
      12.71,
    ); // CAPINVIT
    assert.equal(
      amount(
        "Distribution - Rs 1.556 Consists Of Rs 1.388 In The Form Of Dividend And Re 0.030 In The Form Of Interest And Re 0.138 In The Form Repayment Of Capital",
      ),
      1.556,
    ); // KRT
  });

  it("MONEY-1535's cases, and BSE", () => {
    assert.equal(
      amount(
        "TDS Communication To Shareholders 6 Aug - Final dividend Rs. 5/share for FY26, record date 11 Aug 2026, AGM 18 Aug 2026.",
      ),
      5,
    ); // SUDARSCHEM
    assert.equal(amount("Interim Dividend - Rs. - 7.0000"), 7);
    assert.equal(amount("Dividend - Rs. - 0.0000"), null);
    assert.equal(
      amount("Annual General Meeting/Dividend - Rs  Re 1 Per Share"),
      1,
    );
  });

  // Mutation: the fallback over the WHOLE subject and no named amounts (the
  // parser at HEAD) -> RED (55, the rights premium). MONEY-1535's repair reads
  // this function over the whole subject, so this is what keeps it off the
  // MONEY-1599 legs.
  it("another action's amount is never the dividend's", () => {
    const s =
      "Rights 7:5@Premium Rs.55 Per Share/Annual General Meeting / Dividend Re.1/- Per Equity Share (Purpose Revised)"; // KESORAMIND
    assert.equal(amount(s), 1);
    assert.deepEqual(combinedDividendLeg(s), { dividendPerShare: 1 });
  });

  // Mutation: read the fallback over the whole subject (`const text = s`) ->
  // RED (55). Constructed from KESORAMIND's rights clause and a dividend whose
  // amount is not bound to its word ("@"): no prod subject has both today.
  it("the fallback, too, reads from the dividend onward", () => {
    assert.equal(
      amount("Rights 7:5@Premium Rs.55 Per Share/Dividend @ Re.1 Per Share"),
      1,
    );
  });
});

describe("MONEY-1603 review: a total is not added to its own parts", () => {
  // Mutation: drop the parenthesis/"including" breakdown rule -> RED (ITC
  // 10.5, GSKCONS 100: the values prod holds, 8.5 and 50, are right).
  it("parts in parentheses, or after 'Including', belong to the total", () => {
    assert.equal(
      amount(
        " Dividend-Rs.8.50 Per Share (Including Special Dividend Of Rs.2/- Per Share).",
      ),
      8.5,
    ); // ITC 2016
    assert.equal(
      amount(
        "Annual General Meeting And Dividend Rs.50/- Per Share (Special Dividend Rs.25/- Per Share And Final Dividend Rs.25/- Per Share)",
      ),
      50,
    ); // GSKCONS 2011
  });

  // Mutation: drop the equal-sum rule -> RED (100). Constructed: GSKCONS's
  // subject without its parentheses.
  it("with three or more amounts, the one equal to the others' sum is the total", () => {
    assert.equal(
      amount(
        "Dividend Rs.50/- Per Share / Special Dividend Rs.25/- Per Share And Final Dividend Rs.25/- Per Share",
      ),
      50,
    );
  });

  // Mutation: drop the kind+amount de-duplication -> RED (10). Constructed:
  // the review's example without the parentheses (with them, it is also a
  // breakdown). Two KINDS at one amount stay two: RAJPALAYAM is 15 above.
  it("the same kind at the same amount, named twice, is one dividend", () => {
    assert.equal(
      amount("Interim Dividend - Rs 5 Per Share/Interim Dividend Rs 5"),
      5,
    );
    assert.equal(
      amount("Interim Dividend - Rs 5 Per Share (Interim Dividend Rs 5)"),
      5,
    );
  });
});

describe("MONEY-1603 review: the oldest compressed wording, read whole", () => {
  // Mutation: no "(" before the kind -> RED on TATACOMM (1.5). Mutation: drop
  // "gld jub" from CHAIN_KIND -> RED on RAMCOCEM (null: its Rs10 is unread).
  // Mutation: drop the Rs-less amount -> RED on GLAXO and SUNDARMFIN.
  it("the four partial fills the review found", () => {
    assert.equal(amount("Div-(Fin-Rs4.5+Spl-Rs1.5)"), 6); // TATACOMM 2005
    assert.equal(amount("Agm/Div-Rs10+Gld Jub-Rs10"), 20); // RAMCOCEM 2008
    assert.equal(amount("Div Fin-Rs18+Spl-18 Pr Sh"), 36); // GLAXO 2008
    assert.equal(amount(" Agm/Spl Div- Rs.5/- Div-7.5/-"), 12.5); // SUNDARMFIN 2019
  });

  // Mutation: no ")" after the kind -> RED (0.5).
  it("a kind in parentheses after the word", () => {
    assert.equal(
      amount(
        "Annual General Meeting / Final Dividend Re.0.50 Per Share / Special Dividend (Interim) Re.1/- Per Share (Purpose Revised)",
      ),
      1.5,
    ); // GDL
  });

  // Mutation: let an Rs-less amount count without a rupee marker -> RED on
  // the percentage (50).
  it("an amount without 'Rs' needs '/-' or 'per share' after it, never '%'", () => {
    assert.equal(
      amount("Dividend - Rs 4 Per Share/Special Dividend - 8 Per Share"),
      12,
    ); // LINDEINDIA
    assert.equal(amount("Agm/Div-17.50 Per Share"), 17.5); // TATACONSUM
    assert.equal(amount("Agm/Div-50%/Rights-1:6"), null); // OCL
  });

  // Mutation: drop the typo normalisation -> RED on all three.
  it("NSE's decimal typos are one number", () => {
    assert.equal(
      amount("Annual General Meeting/Dividend - Rs 62..50/- Per Share"),
      62.5,
    ); // GLAXO 2015
    assert.equal(
      amount(" Annual General Meeting/Dividend - Re 0..30 Per Share"),
      0.3,
    ); // CGCL
    assert.equal(amount(" Dividend - Rs 0 .70 Per Share"), 0.7); // JKTYRE
  });
});

describe("MONEY-1603 review: an amount it cannot account for leaves it null", () => {
  // Mutation: return the reading's amount whatever `unread` holds -> RED (5,
  // a part). Constructed: a kind with no chain before it, which is how an
  // unknown shape reads.
  it("a stray rupee amount in a dividend clause", () => {
    const s = "Dividend - Rs 5 Per Share/Final Rs 3 Per Share";
    assert.equal(amount(s), null);
    assert.deepEqual(dividendReading(s).unread, ["Rs 3"]);
  });

  // Mutation: drop `each` from RUPEE_AMOUNT -> RED on JEYPORE, VTMLTD and
  // TULSYAN; drop `income` from OTHER_ACTION_WORD -> RED on MINDSPACE.
  it("a face value, interest or other income is not a stray", () => {
    assert.equal(
      amount(
        "Annual General Meeting/ Dividend Rs. 2.50/- Per Equity Share Of Rs.10/- Each",
      ),
      2.5,
    ); // JEYPORE
    assert.equal(
      amount("Interim Div. Of Re. 0.70/- Per Equity Share Re.1/- Each"),
      0.7,
    ); // VTMLTD
    assert.equal(
      amount(
        "Annual General Meeting / Div. Of Rs. 1.50/- Per Equity Share Of Rs. 10/- Each.",
      ),
      1.5,
    ); // TULSYAN
    assert.equal(
      amount(
        "Dividend- Rs 4.41/Interest Amount- Rs 0.32/Other Income- Rs 0.01",
      ),
      4.41,
    ); // MINDSPACE
  });
});

describe("MONEY-1603 re-review: parentheses, totals and face values", () => {
  // Mutation: a parenthesis counts as a breakdown wherever it opens (drop
  // `open < m.index`) -> RED (5). Constructed (no prod row): each parenthesis
  // holds its own dividend's amount.
  it("a parenthesis after a dividend's own word is that dividend's", () => {
    assert.equal(
      amount(
        "Final Dividend (Rs 5 Per Share) And Special Dividend (Rs 3 Per Share)",
      ),
      8,
    );
  });

  // Mutation: let a kinded amount be the total (drop `kept[j].kind === ""`)
  // -> RED (10). Constructed: three kinds, the third equal to the other two.
  it("an amount with a kind of its own is never read as the total", () => {
    assert.equal(
      amount(
        "Special Dividend Rs 5 / Final Dividend Rs 5 / Interim Dividend Rs 10",
      ),
      20,
    );
  });

  // Mutation: drop the `per share of` lookbehind -> RED (null: "Rs 10" is a
  // stray). Mutation: drop the no-Rs alternative's `(?<!rs ...)` -> RED (the
  // rejected "Rs 10" re-read as "10/-").
  it("'Per Share Of Rs 10/-' is the face value", () => {
    assert.equal(amount("Dividend - Rs 3 Per Share Of Rs 10/-"), 3);
  });
});
