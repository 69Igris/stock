/**
 * MONEY-1542: an NSE subject naming a split AND a bonus is two actions.
 *
 * NSE files a bonus and a split on the same ex-date as ONE subject. The parser
 * typed it SPLIT (split is checked first) and dropped the bonus. On prod that
 * left 31 NSE SPLIT rows without their BONUS, so gold's TITAN:NSE adjusts by 10
 * where 20 is right. On all 22 of those events that have NSE prints either
 * side of the ex-date, the raw cliff matches SPLIT x BONUS and not the SPLIT
 * alone (TITAN 18.75, ONGC 4.24, DPSCLTD 209.88 for 230).
 *
 * Every subject below is copied verbatim from prod `corporate_actions`.
 *
 * ## Mutation log
 *
 * Each case was run against a deliberately broken source and confirmed red
 * before being kept. Recorded at each `it(...)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  combinedBonusRatio,
  parseActionSubject,
  parseBulkCorporateActions,
  parseCorporateActions,
} from "../src/data-sources/nse-filings-logic";

const TITAN = "Bonus 1:1 / Face Value Split From Rs.10/- To Re.1/-";
const EDELWEISS = "Face Value Split From Rs.5/- To Re.1/- And Bonus 1:1";
const RAMASTEEL =
  " Bonus 4:1/Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 5/- Per Share";
const KTIL =
  " Bonus 1:25/ Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 5/- Per Share";
const DPSCLTD = "Bonus 22:1 And Face Value Split From Rs.10/- To Re.1/-";
const HINDZINC = "Bonus - 1:1 And Face Value Split From Rs. 10 To Rs. 2";
const SUDARSCHEM =
  "Bonus 1 : 1 / Face Value Split From Rs 10/- To Rs 2/- Per Share";
const JBMA = "Bonus 1:1 And Face Value Split Rs.10/- To Rs.5/- Per Share";

describe("combinedBonusRatio: the bonus a split subject names", () => {
  // Mutation: `return null` unconditionally -> RED on every row.
  // Mutation: BONUS_CLAUSE with no filler (`/\bbonus\s*\d{1,4}\s*:\s*\d{1,4}/i`)
  // -> RED on HINDZINC. Without the `\s*` around ":" -> RED on SUDARSCHEM.
  it("reads the bonus wherever it sits, in every prod spelling", () => {
    assert.equal(combinedBonusRatio(TITAN), 2);
    assert.equal(combinedBonusRatio(EDELWEISS), 2); // bonus AFTER the split
    assert.equal(combinedBonusRatio(RAMASTEEL), 5); // 4 new per 1 held
    assert.equal(combinedBonusRatio(KTIL), 1.04); // 1 new per 25 held
    assert.equal(combinedBonusRatio(DPSCLTD), 23);
    assert.equal(combinedBonusRatio(HINDZINC), 2);
    assert.equal(combinedBonusRatio(SUDARSCHEM), 2);
  });

  // Mutation: drop the `normalizeActionType(...) !== "SPLIT"` guard -> RED
  // (a plain bonus would be emitted twice; a scheme's debentures once).
  it("is null unless the subject is a split", () => {
    assert.equal(combinedBonusRatio("Bonus 1:1"), null);
    assert.equal(
      combinedBonusRatio("Scheme Of Arrangement - Bonus Debentures 1:1"),
      null,
    );
    assert.equal(
      combinedBonusRatio(
        "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share",
      ),
      null,
    );
  });

  // Mutation: drop `ncrp` from BONUS_CLAUSE's lookahead -> RED. The
  // subject joins TITAN's split to TVSHLTD's "Bonus Ncrps 1:116" (no prod
  // split names one today): a bonus of preference shares or debentures is not
  // a bonus of equity shares.
  it("a bonus of NCRPS beside a split is not a share bonus", () => {
    assert.equal(
      combinedBonusRatio(
        "Face Value Split From Rs.10/- To Re.1/- / Bonus Ncrps 1:116",
      ),
      null,
    );
  });
});

describe("the split never reads its ratio from the bonus", () => {
  // Mutation: drop `bonus` from SPLIT_CLAUSE's lookahead -> RED (SPLIT 1, the
  // bonus's ratio: how prod's JBMA got 1 where BSE files 2 and the NSE cliff is
  // 4.17 = 2 x 2). JBMA itself now reads its face value (MONEY-1598), so this
  // subject names the split with no values to reach the token fallback.
  it("with no face value to read, the split is null, never the bonus's 1", () => {
    const p = parseActionSubject("Face Value Split / Bonus 1:1");
    assert.equal(p.type, "SPLIT");
    assert.equal(p.ratio, null);
    assert.equal(parseActionSubject(JBMA).ratio, 2);
  });

  it("a readable face-value change is still the split's ratio", () => {
    const p = parseActionSubject(TITAN);
    assert.deepEqual(
      [p.type, p.ratio, p.oldFaceValue, p.newFaceValue],
      ["SPLIT", 10, 10, 1],
    );
  });
});

/** An NSE `corporates-corporateActions` row, in the feed's own spellings. */
function nseRow(subject: string): Record<string, unknown> {
  return {
    symbol: "TITAN",
    series: "EQ",
    subject,
    exDate: "23-Jun-2011",
    recDate: "24-Jun-2011",
  };
}

describe("parseCorporateActions emits both actions", () => {
  // Mutation: `return [action]` for every row -> RED (one action, SPLIT only).
  it("TITAN 2011: SPLIT 10 and BONUS 2 on one ex-date", () => {
    const out = parseCorporateActions("TITAN", [nseRow(TITAN)]);
    assert.deepEqual(
      out.map((a) => [a.type, a.ratio, a.oldFaceValue, a.newFaceValue]),
      [
        ["SPLIT", 10, 10, 1],
        ["BONUS", 2, null, null],
      ],
    );
    assert.equal(out[1]!.exDate?.toISOString(), "2011-06-23T00:00:00.000Z");
    assert.equal(out[1]!.exDate?.getTime(), out[0]!.exDate?.getTime());
    assert.equal(out[1]!.recordDate?.getTime(), out[0]!.recordDate?.getTime());
    assert.equal(out[1]!.details, TITAN);
  });

  it("a subject naming one action still yields exactly one", () => {
    const out = parseCorporateActions("TITAN", [nseRow("Bonus 1:1")]);
    assert.deepEqual(
      out.map((a) => [a.type, a.ratio]),
      [["BONUS", 2]],
    );
  });

  // Mutation: restore `const [parsed] = parseCorporateActions(...)` in the
  // bulk mapper -> RED. The nightly and the backfill both read the BULK path,
  // so the fix above alone would have reached neither.
  it("the bulk path keeps both", () => {
    const out = parseBulkCorporateActions([nseRow(TITAN)]);
    assert.deepEqual(
      out.map((a) => [a.symbol, a.type, a.ratio]),
      [
        ["TITAN", "SPLIT", 10],
        ["TITAN", "BONUS", 2],
      ],
    );
  });
});
