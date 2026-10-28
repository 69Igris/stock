/**
 * MONEY-1598 and MONEY-1599: what the NSE subject parser reads, clause by
 * clause.
 *
 *   1598  a face-value split with no "From" ("Fv Split Rs.10/- To Rs.2/"): 156
 *         prod rows had ratio null
 *   1599  a dividend beside another action was dropped (56 rows); a "bonus" of
 *         debentures, NCRPS or preference shares was typed BONUS (ZEEL 22,
 *         TVSHLTD 1.0086); every ratio was the subject's FIRST a:b token
 *
 * Subjects are verbatim from prod `corporate_actions` unless a case says it
 * joins two of them.
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
  normalizeActionType,
  parseActionSubject,
  parseBulkCorporateActions,
  parseCorporateActions,
  parseFaceValueSplit,
} from "../src/data-sources/nse-filings-logic";

const fv = (s: string) => {
  const r = parseFaceValueSplit(s);
  return [r.oldFaceValue, r.newFaceValue, r.ratio];
};

describe("MONEY-1598: a face-value split that names no 'From'", () => {
  // Mutation: drop the `?? s.match(SPLIT_FACE_VALUE)` fallback -> RED on all.
  // Mutation: SPLIT_FACE_VALUE without `\s*` after "to" -> RED on NAVNETEDUL.
  // Mutation: without `(?:face\s*value\s*)?` -> RED on SHARONBIO.
  it("reads every no-From spelling on prod", () => {
    assert.deepEqual(fv("Fv Split Rs.10/- To Rs.2/"), [10, 2, 5]); // EKC, x80
    assert.deepEqual(fv("Fv Split Rs.5/- To Re.1/"), [5, 1, 5]); // USHAMART
    assert.deepEqual(
      fv("Fv Split Rs.10/- To Rs.2/Rd Date Revised"),
      [10, 2, 5],
    );
    assert.deepEqual(fv("Fv Split-Rs.10/-To Rs.2/-"), [10, 2, 5]); // JYOTISTRUC
    assert.deepEqual(fv("Face Value Split Rs 10 To Re 1"), [10, 1, 10]); // ASIANPAINT
    assert.deepEqual(fv("Agm/Fv Split Rs.2 To Re.1"), [2, 1, 2]); // GLENMARK
    assert.deepEqual(
      fv("Split-Rs.10tors.2/Div-60%Purpose Revised"), // NAVNETEDUL
      [10, 2, 5],
    );
    assert.deepEqual(
      fv("Bonus 1:1 / Face Value Split From 10/- To Face Value 2/-"), // SHARONBIO
      [10, 2, 5],
    );
  });

  it("the 'From' forms read exactly as before", () => {
    assert.deepEqual(
      fv(
        "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share",
      ),
      [10, 2, 5],
    );
    assert.deepEqual(fv("Stock  Split From Rs.10/- to Rs.1/-"), [10, 1, 10]); // BSE MWL
    assert.deepEqual(fv("Split of Mutual Fund Units"), [null, null, null]);
  });

  // Mutation: drop the `readings.size > 1` refusal -> RED (reads 5). The
  // subject joins EKC's and BATLIBOI's; no prod subject names two changes.
  it("two face-value changes that disagree read as none", () => {
    assert.deepEqual(
      fv("Fv Split Rs.10/- To Rs.2/ And Fv Split Rs.10/- To Rs.5/"),
      [null, null, null],
    );
  });

  // Mutation: restore the first-token fallback on the whole subject -> RED
  // (JBMA reads the BONUS's "1:1" as the split: 1, where the NSE cliff is 4.17
  // = split 2 x bonus 2).
  it("JBMA: the split is its face value, never the bonus's ratio", () => {
    const p = parseActionSubject(
      "Bonus 1:1 And Face Value Split Rs.10/- To Rs.5/- Per Share",
    );
    assert.deepEqual([p.type, p.ratio], ["SPLIT", 2]);
  });
});

describe("MONEY-1599: each ratio binds to its own keyword", () => {
  // Mutation: BONUS ratio from the FIRST token (`parseRatioToken(subject)`)
  // -> RED (1.5, the rights ratio). UNIWESTBNK files "Bonus - 1:5/Rights -
  // 1:2"; this is its two clauses in the other order.
  it("a rights ratio before the bonus is not the bonus's", () => {
    const p = parseActionSubject("Rights - 1:2/Bonus - 1:5");
    assert.deepEqual([p.type, p.ratio], ["BONUS", 1.2]);
    assert.equal(parseActionSubject("Bonus - 1:5/Rights - 1:2").ratio, 1.2);
  });

  // Mutation: `\bbonus\b` (a word boundary AFTER the keyword) -> RED on TCS.
  it("keeps every prod spelling of a bonus ratio", () => {
    assert.equal(parseActionSubject("Intdiv-Rs 3persh/Bonus1:1").ratio, 2); // TCS 2006
    assert.equal(parseActionSubject("Bonus issue 1:3").ratio, 4 / 3); // BSE
    assert.equal(parseActionSubject("Bonus 1 : 4").ratio, 1.25);
    assert.equal(parseActionSubject("Bonus-1:3").ratio, 4 / 3); // APARINDS
  });
});

describe("MONEY-1599: a bonus of no shares is not a BONUS", () => {
  // Mutation: `/bonus/.test(s)` without the NON_SHARE_BONUS strip -> RED on
  // all three (BONUS 1.0086, BONUS 22, BONUS null).
  it("NCRPS, preference shares and debentures type OTHER", () => {
    for (const s of [
      "Bonus Ncrps 1:116", // TVSHLTD, stored BONUS 1.0086
      "Bonus Preference Shares 21:1", // ZEEL, stored BONUS 22; NSE cliff 1.005
      " Scheme Of Arangement- Bonus - 1 Debenture For 1 Equity Share Held", // BRITANNIA
    ]) {
      const p = parseActionSubject(s);
      assert.deepEqual([p.type, p.ratio], ["OTHER", null], s);
    }
  });

  it("a share bonus still types BONUS", () => {
    assert.equal(normalizeActionType("Bonus 1:1"), "BONUS");
    assert.equal(
      normalizeActionType(
        "Annual General Meeting/Dividend Rs.3/- Per Share/Scheme Of Arrangement - Bonus Debentures 1:1 (Purpose Revised)",
      ),
      "DEMERGER",
    );
  });
});

describe("MONEY-1599: the dividend beside another action", () => {
  // Mutation: `parseDividendPerShare` as at HEAD (the whole subject, first
  // "per share" amount) -> RED (55, the rights premium).
  it("KESORAMIND: the amount comes from the dividend's own clause", () => {
    assert.deepEqual(
      combinedDividendLeg(
        "Rights 7:5@Premium Rs.55 Per Share/Annual General Meeting / Dividend Re.1/- Per Equity Share (Purpose Revised)",
      ),
      { dividendPerShare: 1 },
    );
  });

  // Mutation: `return null` unconditionally -> RED.
  it("reads the leg beside a bonus, a split, a buyback and a scheme", () => {
    const leg = (s: string) => combinedDividendLeg(s)?.dividendPerShare;
    assert.equal(leg(" Bonus 1:1 /Dividend- Rs 29 Per Share"), 29); // TCS 2018
    assert.equal(
      leg(
        "1st Interim Dividend Rs.2.50 Per Share And Face Value Split From Rs.10/- To Re.1/- (Purpose Revised)",
      ),
      2.5,
    ); // KCP
    assert.equal(leg(" Buy Back/Interim Dividend - Re 0.25 Per Share"), 0.25); // MAYURUNIQ
    assert.equal(
      leg("Dividend Re.0.50 Per Share And Scheme Of Arrangement"),
      0.5,
    ); // WEIZMANIND
  });

  it("a percentage leg exists with no amount; a 'Div-Rs' leg reads its amount (MONEY-1603)", () => {
    assert.deepEqual(combinedDividendLeg("Agm/ Div-100%/Bonus 1:1"), {
      dividendPerShare: null,
    });
    assert.deepEqual(combinedDividendLeg("Bonus 1:1/Div-Rs.5 Per Sh"), {
      dividendPerShare: 5,
    }); // TCS 2009
  });

  // Mutation: drop the `=== "DIVIDEND"` guard -> RED (a dividend row would be
  // emitted twice).
  it("a dividend subject has no second dividend", () => {
    assert.equal(
      combinedDividendLeg("Interim Dividend - Rs 6 Per Share"),
      null,
    );
    assert.equal(combinedDividendLeg("Bonus 1:1"), null);
  });

  // Mutation: drop the DIVIDEND push in parseCorporateActions -> RED on both.
  it("parseCorporateActions and the bulk path emit it on the same ex-date", () => {
    const row = {
      symbol: "TCS",
      subject: " Bonus 1:1 /Dividend- Rs 29 Per Share",
      exDate: "31-May-2018",
    };
    for (const out of [
      parseCorporateActions("TCS", [row]),
      parseBulkCorporateActions([row]),
    ]) {
      assert.deepEqual(
        out.map((a) => [a.type, a.ratio, a.dividendPerShare]),
        [
          ["BONUS", 2, null],
          ["DIVIDEND", null, 29],
        ],
      );
      assert.equal(out[1]!.exDate?.toISOString(), "2018-05-31T00:00:00.000Z");
    }
  });
});

describe("MONEY-1603 review: NSE's 'Spl' split and 'Bon' bonus", () => {
  const legs = (subject: string) =>
    parseCorporateActions("X", [{ subject }]).map((a) => [
      a.type,
      a.ratio ?? a.dividendPerShare,
    ]);

  // Mutation: drop SPL_FACE_VALUE from normalizeActionType -> RED on all
  // three (BONUS, DIVIDEND). Mutation: drop `\bspl\b` from SPLIT_FACE_VALUE ->
  // RED (the split's ratio is null).
  it("'Spl' before a face-value change is a split", () => {
    assert.deepEqual(legs("Spl-Rs10 To Rs2/Bonus-1:2"), [
      ["SPLIT", 5],
      ["BONUS", 1.5],
    ]); // EIHOTEL 2006: NSE's cliff 6.72; only BONUS 1.5 was stored
    assert.deepEqual(legs("Bonus-1:1 Spl-Rs 5/ To 2/"), [
      ["SPLIT", 2.5],
      ["BONUS", 2],
    ]); // BSOFT 2007
    assert.deepEqual(legs("Fv Spl 100 To 10/Div150%"), [
      ["SPLIT", 10],
      ["DIVIDEND", null],
    ]); // LMW 2006
  });

  // Mutation: SPL_FACE_VALUE without the face-value change (`\bspl\b`) ->
  // RED: a special dividend becomes a split.
  it("'Spl' before one amount is still a special dividend", () => {
    assert.equal(normalizeActionType("Agm/Div-Fin Rs.3+Spl Re1"), "DIVIDEND"); // VISAKAIND
    assert.equal(normalizeActionType("Agm/Spl/Bon-1:1/Div-20%"), "BONUS"); // SUNTV
  });

  // Mutation: drop `\bbon(?![a-z])` from normalizeActionType -> RED (DIVIDEND
  // alone). Mutation: BONUS_CLAUSE keyword `bonus` only -> RED (ratio null).
  it("'Bon' is a bonus", () => {
    assert.deepEqual(legs("Div-Rs.4.20 Pr Sh/Bon 1:1"), [
      ["BONUS", 2],
      ["DIVIDEND", 4.2],
    ]); // GLODYNE 2009: nothing stored on either exchange
    assert.deepEqual(legs("Div-Rs.5.50 Pr Sh/Bon 5:1purpose Revised"), [
      ["BONUS", 6],
      ["DIVIDEND", 5.5],
    ]); // JINDALSTEL 2009: the detector saw 5.86 and snapped 6
  });

  // Mutation: drop `dvr` from NON_SHARE_BONUS -> RED (BONUS).
  it("a bonus of DVR shares issues no ordinary shares", () => {
    assert.equal(normalizeActionType("Bonus 1 Dvr : 10 Eq Share"), "OTHER"); // GUJNRECOKE
  });

  // Mutation: "to" without `(?<![a-z])` in SPLIT_FACE_VALUE -> RED (2, read
  // from "In-to 5").
  it("the 'to' inside 'Into' is not a face-value change", () => {
    const p = parseActionSubject(
      "Split Of Equity Shares Of Rs 10 Each Into 5 Shares Of Rs 2 Each",
    );
    assert.deepEqual([p.type, p.ratio], ["SPLIT", null]);
  });

  // Mutation: drop BONUS_CLAUSE_AFTER -> RED on "1:1 Bonus" (null; HEAD read
  // 2). Mutation: let anything sit between (`[^:\d]*?`) -> RED on "Agm/2:1/
  // Bonus" (3); the rights case is also held by OWNS_A_RATIO.
  it("a ratio written before 'Bonus' is the bonus's, and only then", () => {
    assert.equal(parseActionSubject("1:1 Bonus").ratio, 2);
    assert.equal(parseActionSubject("Rights 1:2 / Bonus").ratio, null);
    // Constructed: no keyword owns the 2:1, but a separator stands between it
    // and "Bonus", so it is refused rather than guessed.
    assert.equal(parseActionSubject("Agm/2:1/Bonus").ratio, null);
  });
});

describe("MONEY-1603 re-review: ratios another keyword owns, and the dash form", () => {
  const legs = (subject: string) =>
    parseCorporateActions("X", [{ subject }]).map((a) => [a.type, a.ratio]);

  // Mutation: drop the OWNS_A_RATIO refusal -> RED (a BONUS 1.2 leg). The
  // 1:5 is the split's.
  it("a ratio after a split is not lent to a bonus that follows it", () => {
    assert.deepEqual(legs("Stock Split 1:5 Bonus"), [["SPLIT", 5]]);
  });

  // Mutation: drop the dash alternative from SPL_FACE_VALUE -> RED (DIVIDEND
  // only); from SPLIT_FACE_VALUE -> RED (the split's ratio is null).
  it("CASTEXTECH's 'Spl Rs10-Rs2' is a split", () => {
    assert.deepEqual(legs("Agm/Div-20%/Spl Rs10-Rs2"), [
      ["SPLIT", 5],
      ["DIVIDEND", null],
    ]);
  });

  // Mutation: the dash without "Rs" after it (`-\s*(?:r[se]\.?\s*)?\d`) ->
  // RED (SPLIT). Constructed: a special dividend of Re 1 beside a percentage.
  it("a dash is a face-value change only with 'Rs' after it", () => {
    assert.equal(normalizeActionType("Div-Rs2+Spl Rs1-2%"), "DIVIDEND");
  });
});
