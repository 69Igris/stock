/**
 * Corporate-action subject parsing — REAL source (MONEY-840/844).
 *
 * Covers the structured ratio/type extraction added to the NSE parser
 * (`nse-filings-logic.ts`) and the Screener corp-action date parser
 * (`screener-full-scraper.ts`). The pairing cost-basis adjustment depends on
 * these ratios being correct, so the regex behaviour is pinned here with the
 * concrete real-world subject strings NSE/Screener emit.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeActionType,
  parseRatioToken,
  parseFaceValueSplit,
  parseDividendPerShare,
  parseActionSubject,
  parseCorporateActions as parseNseCorporateActions,
} from "@usemoney/research/data-sources/nse-filings-logic";
import {
  parseScreenerActionDate,
  parseCorporateActions as parseScreenerCorporateActions,
} from "@usemoney/research/data-sources/screener-full-scraper";
import * as cheerio from "cheerio";

// ── normalizeActionType ────────────────────────────────────────────────────

describe("normalizeActionType", () => {
  it("classifies a face-value split as SPLIT (not via the bare token)", () => {
    assert.strictEqual(
      normalizeActionType(
        "Face Value Split (Sub-Division) - From Rs 10 To Rs 1"
      ),
      "SPLIT"
    );
    assert.strictEqual(normalizeActionType("Stock Split 1:5"), "SPLIT");
    assert.strictEqual(normalizeActionType("Sub-division of shares"), "SPLIT");
  });

  it("classifies bonus / dividend / buyback / demerger / merger / rights", () => {
    assert.strictEqual(normalizeActionType("Bonus 1:1"), "BONUS");
    assert.strictEqual(
      normalizeActionType("Dividend - Rs 5 Per Share"),
      "DIVIDEND"
    );
    assert.strictEqual(
      normalizeActionType("Buy Back of Equity Shares"),
      "BUYBACK"
    );
    assert.strictEqual(normalizeActionType("Buyback"), "BUYBACK");
    assert.strictEqual(
      normalizeActionType("Scheme of Arrangement (Demerger)"),
      "DEMERGER"
    );
    assert.strictEqual(
      normalizeActionType("Amalgamation with parent"),
      "MERGER"
    );
    assert.strictEqual(normalizeActionType("Rights Issue 1:4"), "RIGHTS");
  });

  // ── MONEY-1189: NSE's pre-~2010 abbreviated wording ──────────────────────
  //
  // Every string below is VERBATIM from a live sample of 18 two-month windows
  // across 2004-2012. They were fetched, classified OTHER, and then dropped by
  // the backfill's type filter — paid for and discarded. ~1,000 real dividends
  // in the sample alone; it is why ITC's stored dividends began in 2010 despite
  // decades of annual payouts.
  describe("abbreviated dividend wording (verbatim NSE subjects)", () => {
    const DIVIDENDS = [
      "Agm/Div-Re.1/- Per Share",
      "Agm/Div-Rs.2/- Per Share",
      "Agm/Div-Rs.1.50 Per Share",
      "Agm/Div-Re.1/- Per Sh",
      "Agm/Div-Rs.3.50/- Per Sh",
      "Agm/Fin Div-Rs.2/- Per Sh",
      "Agm/Fin Div-Re.1/- Per Sh",
      "Annual General Meeting/Div.Rs.9/- Per Share",
      "Annual General Meeting/Fin.Div.Re.1/-Per Share",
      "Annual General Meeting / Div. Of Rs. 4/- Per Share",
      "Annual General Meeting/Div.Re.0.15 Per Equity Share",
      "Agm/ Divdend-60%",
      "Dividend-Rs.10/- Per Sh",
    ];
    for (const subject of DIVIDENDS) {
      it(`${JSON.stringify(subject)} -> DIVIDEND`, () => {
        assert.strictEqual(normalizeActionType(subject), "DIVIDEND");
      });
    }

    // The counter-cases that keep the widening honest. An AGM is a MEETING;
    // bare "Agm" and "Annual General Meeting" are 3,308 of the ~4,300 sampled
    // OTHER rows, so matching "agm" would bury DIVIDEND in meetings.
    const NOT_DIVIDENDS = [
      "Annual General Meeting",
      "Agm",
      "Annual Book Closure",
      "Extra Ordinary General Meeting",
      "Egm",
      "Interest Payment",
      "Agm                      Purpose Revised",
      "Annual General Meeting (Bc Dates Revised)",
      "Election Of Directors",
    ];
    for (const subject of NOT_DIVIDENDS) {
      it(`${JSON.stringify(subject)} stays OTHER`, () => {
        assert.strictEqual(normalizeActionType(subject), "OTHER");
      });
    }

    it("does not mistake 'division' or 'divestment' for a dividend", () => {
      // `sub-division` is a SPLIT and is checked first; the others must not
      // reach DIVIDEND at all. This is the "precision without a catch-all"
      // guard running the other way.
      assert.strictEqual(
        normalizeActionType("Sub-Division of shares"),
        "SPLIT"
      );
      assert.strictEqual(
        normalizeActionType("Divestment of subsidiary"),
        "OTHER"
      );
      assert.strictEqual(
        normalizeActionType("Individual holdings review"),
        "OTHER"
      );
    });
  });

  describe("abbreviated + misspelled RIGHTS wording (verbatim)", () => {
    // Safe to widen: RIGHTS is not in QTY_CHANGING_TYPES, so none of these can
    // reach chart adjustment.
    for (const subject of [
      "Rht 9:20@Prem Rs112 Pr Sh",
      "Rht 7:2@Prem Rs 20 Per Sh",
      "Rigths-Eq 3:10@Prem Rs.30",
      "Rigts-Eq 13:20@Prem Rs140",
    ]) {
      it(`${JSON.stringify(subject)} -> RIGHTS`, () => {
        assert.strictEqual(normalizeActionType(subject), "RIGHTS");
      });
    }
  });

  it("reads a DUAL-EFFECT face-value split + bonus as BOTH actions (MONEY-1603 review)", () => {
    // "Fv Spl-Rs10tore1/Bon-1:1" is a Rs10->Re1 face-value split (x10) AND a
    // 1:1 bonus (x2) — x20 in total. These were left OTHER because a row
    // carried one ratio and parseRatioToken grabbed the bonus's "1:1" as the
    // split's. That follow-up has landed: the split's ratio comes from its face
    // values ("Spl" is NSE's split abbreviation when a face-value CHANGE
    // follows), every ratio binds to its own keyword, and the parser emits the
    // bonus as a second action (MONEY-1542). So each is a SPLIT, and parsing
    // yields both effects with the right ratios.
    for (const [subject, split, bonus] of [
      ["Fv Spl-Rs10tore1/Bon-1:1", 10, 2],
      ["Fv Spl-Rs5 To Rs2/Bon 1:1", 2.5, 2],
      ["Fv Spl-Rs10tors2/Bon-12:1", 5, 13],
    ] as const) {
      assert.strictEqual(normalizeActionType(subject), "SPLIT");
      assert.deepStrictEqual(
        parseNseCorporateActions("X", [{ subject }]).map((a) => [
          a.type,
          a.ratio,
        ]),
        [
          ["SPLIT", split],
          ["BONUS", bonus],
        ]
      );
    }
  });

  it("prefers BONUS over RIGHTS when both 'bonus' and 'issue' appear", () => {
    assert.strictEqual(normalizeActionType("Bonus Issue 2:1"), "BONUS");
  });

  it("returns OTHER for unknown / empty subjects", () => {
    assert.strictEqual(normalizeActionType("Annual General Meeting"), "OTHER");
    assert.strictEqual(normalizeActionType(""), "OTHER");
    assert.strictEqual(normalizeActionType("   "), "OTHER");
  });
});

// ── parseRatioToken (a:b → post:pre multiplier) ─────────────────────────────

describe("parseRatioToken", () => {
  it("BONUS 1:1 → 2 (one new per held → 2 total per 1)", () => {
    assert.strictEqual(parseRatioToken("Bonus 1:1", "BONUS"), 2);
  });

  it("BONUS 2:1 → 3, BONUS 3:5 → 1.6", () => {
    assert.strictEqual(parseRatioToken("Bonus 2:1", "BONUS"), 3);
    assert.strictEqual(parseRatioToken("Bonus 3:5", "BONUS"), 1.6);
  });

  it("SPLIT 1:5 → 5 (NSE old:new convention, multiplier b/a)", () => {
    assert.strictEqual(parseRatioToken("Stock Split 1:5", "SPLIT"), 5);
  });

  it("SPLIT 1:2 → 2", () => {
    assert.strictEqual(parseRatioToken("Sub-division 1:2", "SPLIT"), 2);
  });

  it("returns null when there is no a:b token", () => {
    assert.strictEqual(parseRatioToken("Bonus shares", "BONUS"), null);
    assert.strictEqual(parseRatioToken("", "SPLIT"), null);
  });

  it("returns null for non-qty action types", () => {
    assert.strictEqual(parseRatioToken("Dividend 1:1", "DIVIDEND"), null);
  });

  it("ignores a zero denominator / numerator", () => {
    assert.strictEqual(parseRatioToken("Bonus 0:1", "BONUS"), null);
    assert.strictEqual(parseRatioToken("Split 1:0", "SPLIT"), null);
  });
});

// ── parseFaceValueSplit (From Rs X To Rs Y) ─────────────────────────────────

describe("parseFaceValueSplit", () => {
  it("parses 'From Rs 10/- Per Share To Rs 1/- Per Share' → 10x", () => {
    const r = parseFaceValueSplit(
      "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 1/- Per Share"
    );
    assert.strictEqual(r.oldFaceValue, 10);
    assert.strictEqual(r.newFaceValue, 1);
    assert.strictEqual(r.ratio, 10);
  });

  it("parses 'From Rs 10 to Rs 2' → 5x", () => {
    const r = parseFaceValueSplit("Split From Rs 10 to Rs 2");
    assert.strictEqual(r.oldFaceValue, 10);
    assert.strictEqual(r.newFaceValue, 2);
    assert.strictEqual(r.ratio, 5);
  });

  it("parses 'From Rs 10 to Re 1' (Re/Rs mix) → 10x", () => {
    const r = parseFaceValueSplit("From Rs 10 to Re 1");
    assert.strictEqual(r.oldFaceValue, 10);
    assert.strictEqual(r.newFaceValue, 1);
    assert.strictEqual(r.ratio, 10);
  });

  it("returns nulls when no face-value pattern is present", () => {
    const r = parseFaceValueSplit("Stock Split 1:5");
    assert.strictEqual(r.oldFaceValue, null);
    assert.strictEqual(r.newFaceValue, null);
    assert.strictEqual(r.ratio, null);
  });
});

// ── parseDividendPerShare ───────────────────────────────────────────────────

describe("parseDividendPerShare", () => {
  it("parses 'Dividend - Rs 5 Per Share' → 5", () => {
    assert.strictEqual(parseDividendPerShare("Dividend - Rs 5 Per Share"), 5);
  });

  it("parses decimals and Re: 'Interim Dividend Rs.2.50' → 2.5, 'Final Dividend Re 1' → 1", () => {
    assert.strictEqual(parseDividendPerShare("Interim Dividend Rs.2.50"), 2.5);
    assert.strictEqual(parseDividendPerShare("Final Dividend - Re 1"), 1);
  });

  it("prefers the explicit 'per share' amount", () => {
    assert.strictEqual(
      parseDividendPerShare("Dividend Rs 100 total, Rs 5 per share"),
      5
    );
  });

  it("returns null for a non-dividend subject", () => {
    assert.strictEqual(parseDividendPerShare("Bonus 1:1"), null);
  });

  it("returns null for a percentage-only dividend (no rupee amount)", () => {
    assert.strictEqual(parseDividendPerShare("Dividend 50%"), null);
  });

  // MONEY-1535 — both subjects are the stored text of real prod rows.
  // Mutation: drop the leading `\b` from both patterns -> RED on both (6 and
  // 28, read out of "Shareholde-RS 6" and "closu-RE 28").
  it("does not read Rs/Re out of the END of a word", () => {
    assert.strictEqual(
      parseDividendPerShare(
        "TDS Communication To Shareholders 6 Aug - Final dividend Rs. 5/share for FY26, record date 11 Aug 2026, AGM 18 Aug 2026."
      ),
      5
    );
    assert.strictEqual(
      parseDividendPerShare(
        "Intimation Regarding The Annual General Meeting 10 Jul - 85th AGM on 3 Aug 2026; book closure 28 Jul-3 Aug; dividend record date 27 Jul, payable from 20 Aug."
      ),
      null
    );
  });

  // Mutation: drop `(?:-\s*)?` from both patterns -> RED on all four (null):
  // 14,412 BSE and 49 NSE dividends on prod were stored null this way.
  it("reads the dash between the currency and the amount (BSE, older NSE)", () => {
    assert.strictEqual(
      parseDividendPerShare("Interim Dividend - Rs. - 7.0000"),
      7
    );
    assert.strictEqual(
      parseDividendPerShare("Final Dividend - Re. - 0.5000"),
      0.5
    );
    assert.strictEqual(
      parseDividendPerShare(" Dividend Rs - 1.2 Per Share"),
      1.2
    );
    assert.strictEqual(parseDividendPerShare(" Dividend Rs -2 Per Share"), 2);
  });
});

// ── parseActionSubject (combined) ───────────────────────────────────────────

describe("parseActionSubject", () => {
  it("face-value split → type SPLIT with ratio + old/new face value", () => {
    const r = parseActionSubject(
      "Face Value Split - From Rs 10/- To Rs 1/- Per Share"
    );
    assert.strictEqual(r.type, "SPLIT");
    assert.strictEqual(r.ratio, 10);
    assert.strictEqual(r.oldFaceValue, 10);
    assert.strictEqual(r.newFaceValue, 1);
    assert.strictEqual(r.dividendPerShare, null);
  });

  it("token split (no FV) → ratio from a:b token", () => {
    const r = parseActionSubject("Stock Split 1:5");
    assert.strictEqual(r.type, "SPLIT");
    assert.strictEqual(r.ratio, 5);
    assert.strictEqual(r.oldFaceValue, null);
  });

  it("bonus → ratio only", () => {
    const r = parseActionSubject("Bonus 1:1");
    assert.strictEqual(r.type, "BONUS");
    assert.strictEqual(r.ratio, 2);
    assert.strictEqual(r.dividendPerShare, null);
  });

  it("dividend → dividendPerShare only, no ratio", () => {
    const r = parseActionSubject("Dividend - Rs 12 Per Share");
    assert.strictEqual(r.type, "DIVIDEND");
    assert.strictEqual(r.ratio, null);
    assert.strictEqual(r.dividendPerShare, 12);
  });

  it("buyback → type only, all numeric fields null", () => {
    const r = parseActionSubject("Buy Back of Equity Shares");
    assert.strictEqual(r.type, "BUYBACK");
    assert.strictEqual(r.ratio, null);
    assert.strictEqual(r.oldFaceValue, null);
    assert.strictEqual(r.dividendPerShare, null);
  });
});

// ── parseCorporateActions (NSE rows → structured + raw kept) ─────────────────

describe("parseCorporateActions (NSE) — structured ratio/type", () => {
  it("populates type/ratio/faceValue and KEEPS the raw subject in details", () => {
    const [a] = parseNseCorporateActions("reliance.ns", [
      {
        subject: "Face Value Split From Rs 10 To Rs 1",
        exDate: "2024-03-15",
        recDate: "2024-03-16",
      },
    ]);
    assert.strictEqual(a!.symbol, "RELIANCE");
    assert.strictEqual(a!.type, "SPLIT");
    assert.strictEqual(a!.ratio, 10);
    assert.strictEqual(a!.oldFaceValue, 10);
    assert.strictEqual(a!.newFaceValue, 1);
    // raw subject preserved (both verbatim details + upper-cased actionType)
    assert.strictEqual(a!.details, "Face Value Split From Rs 10 To Rs 1");
    assert.strictEqual(a!.actionType, "FACE VALUE SPLIT FROM RS 10 TO RS 1");
    assert.deepStrictEqual(a!.exDate, new Date("2024-03-15"));
    assert.deepStrictEqual(a!.recordDate, new Date("2024-03-16"));
  });

  it("bonus row → BONUS with ratio 2 and null dividend", () => {
    const [a] = parseNseCorporateActions("TCS", [
      { subject: "Bonus 1:1", exDate: "2023-06-01" },
    ]);
    assert.strictEqual(a!.type, "BONUS");
    assert.strictEqual(a!.ratio, 2);
    assert.strictEqual(a!.dividendPerShare, null);
  });

  it("dividend row → DIVIDEND with dividendPerShare and null ratio", () => {
    const [a] = parseNseCorporateActions("INFY", [
      { subject: "Dividend - Rs 18 Per Share", exDate: "2024-05-30" },
    ]);
    assert.strictEqual(a!.type, "DIVIDEND");
    assert.strictEqual(a!.dividendPerShare, 18);
    assert.strictEqual(a!.ratio, null);
  });
});

// ── parseScreenerActionDate ─────────────────────────────────────────────────

describe("parseScreenerActionDate", () => {
  it("parses '15 Mar 2024' / '15 March 2024'", () => {
    assert.deepStrictEqual(
      parseScreenerActionDate("Stock Split 15 Mar 2024"),
      new Date(Date.UTC(2024, 2, 15))
    );
    assert.deepStrictEqual(
      parseScreenerActionDate("15 March 2024"),
      new Date(Date.UTC(2024, 2, 15))
    );
  });

  it("parses a month-year with no day → day 1", () => {
    assert.deepStrictEqual(
      parseScreenerActionDate("Dividend Mar 2024"),
      new Date(Date.UTC(2024, 2, 1))
    );
  });

  it("parses ISO '2024-03-15' and DD-MM-YYYY '15-03-2024'", () => {
    assert.deepStrictEqual(
      parseScreenerActionDate("2024-03-15"),
      new Date("2024-03-15T00:00:00Z")
    );
    assert.deepStrictEqual(
      parseScreenerActionDate("15-03-2024"),
      new Date(Date.UTC(2024, 2, 15))
    );
  });

  it("returns null (never Invalid Date) for unparseable text", () => {
    assert.strictEqual(parseScreenerActionDate("no date here"), null);
    assert.strictEqual(parseScreenerActionDate(""), null);
    // sanity: result is always toISOString-safe when non-null
    const d = parseScreenerActionDate("1 Jan 2020");
    assert.doesNotThrow(() => d && d.toISOString());
  });
});

// ── Screener parseCorporateActions (cheerio HTML → structured rows) ──────────

describe("parseCorporateActions (Screener) — cheerio extraction", () => {
  const HTML = `
    <html><body>
      <section id="documents">
        <ul>
          <li>Stock Split 1:5 - 15 Mar 2024</li>
          <li>Bonus 1:1 - 01 Jun 2023</li>
          <li>Dividend - Rs 5 Per Share - 30 May 2024</li>
          <li>Annual General Meeting 10 Aug 2024</li>
          <li>Stock Split 1:5 - 15 Mar 2024</li>
        </ul>
      </section>
    </body></html>`;

  it("extracts split/bonus/dividend rows with structured fields", () => {
    const $ = cheerio.load(HTML);
    const actions = parseScreenerCorporateActions($, "RELIANCE");

    const split = actions.find((a) => a.type === "SPLIT");
    const bonus = actions.find((a) => a.type === "BONUS");
    const dividend = actions.find((a) => a.type === "DIVIDEND");

    assert.ok(split, "should find a SPLIT");
    assert.strictEqual(split!.ratio, 5);
    assert.deepStrictEqual(split!.exDate, new Date(Date.UTC(2024, 2, 15)));
    assert.strictEqual(split!.symbol, "RELIANCE");

    assert.ok(bonus, "should find a BONUS");
    assert.strictEqual(bonus!.ratio, 2);

    assert.ok(dividend, "should find a DIVIDEND");
    assert.strictEqual(dividend!.dividendPerShare, 5);
    assert.strictEqual(dividend!.ratio, null);
  });

  it("skips non-action rows (AGM) and de-dupes repeated rows", () => {
    const $ = cheerio.load(HTML);
    const actions = parseScreenerCorporateActions($, "RELIANCE");
    // AGM is filtered out; the duplicated split collapses to one.
    assert.strictEqual(actions.length, 3);
    assert.ok(!actions.some((a) => a.type === "OTHER"));
  });

  it("returns [] when the page has no corp-action rows", () => {
    const $ = cheerio.load(
      "<html><body><div>Just financials here</div></body></html>"
    );
    assert.deepStrictEqual(parseScreenerCorporateActions($, "TCS"), []);
  });
});
