/**
 * UNIT TEST — UDiFF F&O parser (MONEY-941 / P3 step 4).
 *
 * Fixtures are REAL rows copied from a 2026-08-07 NSE UDiFF F&O file, because
 * all three normalisations this parser performs were invisible from the cash
 * format and would each have been guessed wrong:
 *
 *   1. UDiFF uses IDF/IDO/STF/STO; the legacy era uses FUTIDX/OPTIDX/FUTSTK/
 *      OPTSTK. Nothing overlaps, so an unnormalised column would split
 *      DerivativeEOD into two vocabularies at the 2024 boundary.
 *   2. Expiry is ISO `2026-10-27`, not the legacy `29-JUN-2000`.
 *   3. TtlTrfVal is RUPEES; the legacy VAL_INLAKH is already lakhs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseUdiffFoBhavcopy,
  parseUdiffExpiry,
} from "../../src/market-data/bhavcopy-derivatives";

const DAY = new Date(Date.UTC(2026, 7, 7, 12, 0, 0));

const HEADER =
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt," +
  "FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric," +
  "LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol," +
  "TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4";

// Real shapes: futures carry EMPTY StrkPric/OptnTp, not 0/XX.
const IDF =
  "2026-08-07,2026-08-07,FO,NSE,IDF,1,,BANKNIFTY,,2026-10-27,2026-10-27,,,BANKNIFTY," +
  "58701.20,58900.00,58600.00,58714.80,58714.80,58600.00,58700.00,58714.80,23160,3990,351," +
  "618047016.00,120,S1,15,,,,,";
const IDO =
  "2026-08-07,2026-08-07,FO,NSE,IDO,2,,BANKNIFTY,,2026-08-25,2026-08-25,59100.00,PE,BANKNIFTY," +
  "1305.05,1350.00,1290.00,1330.60,1330.60,1300.00,58700.00,1330.60,3660,1230,89," +
  "161342701.50,45,S1,15,,,,,";
const STF =
  "2026-08-07,2026-08-07,FO,NSE,STF,3,,ABCAPITAL,,2026-09-29,2026-09-29,,,ABCAPITAL," +
  "421.70,425.00,408.00,410.20,410.20,420.00,410.00,410.20,911400,220100,230," +
  "294655465.00,88,S1,1100,,,,,";
// A cash row that must be skipped and TALLIED, not silently dropped.
const STK =
  "2026-08-07,2026-08-07,CM,NSE,STK,4,INE002A01018,RELIANCE,EQ,,,,,RELIANCE," +
  "1400,1410,1390,1405,1405,1398,,,0,0,100,140500.00,10,S1,1,,,,,";

const CSV = [HEADER, IDF, IDO, STF, STK].join("\n");

describe("parseUdiffExpiry", () => {
  it("parses the ISO expiry UDiFF actually uses", () => {
    assert.equal(
      parseUdiffExpiry("2026-10-27")!.toISOString(),
      "2026-10-27T00:00:00.000Z",
    );
  });

  it("rejects the LEGACY format — feeding one to the other drops every row", () => {
    assert.equal(parseUdiffExpiry("29-JUN-2000"), null);
    assert.equal(parseUdiffExpiry(""), null);
    assert.equal(parseUdiffExpiry("2026-13-01"), null);
  });
});

describe("parseUdiffFoBhavcopy", () => {
  it("maps UDiFF codes onto the LEGACY instrument vocabulary", () => {
    // Without this, DerivativeEOD.instrument holds IDF/IDO/STF/STO after 2024
    // and FUTIDX/OPTIDX/FUTSTK/OPTSTK before it, so any query filtering on the
    // column silently returns half the history.
    const { rows } = parseUdiffFoBhavcopy(CSV, "NSE", DAY);
    const types = rows.map((r) => r.instrument).sort();
    assert.deepEqual(types, ["FUTIDX", "FUTSTK", "OPTIDX"]);
    assert.ok(!types.some((t) => ["IDF", "IDO", "STF", "STO"].includes(t)));
  });

  it("normalises EMPTY strike / optionType to the 0 / XX sentinels", () => {
    // UDiFF futures leave both blank. Null would break the compound unique,
    // because MongoDB treats nulls as distinct and would admit duplicates.
    const { rows } = parseUdiffFoBhavcopy(CSV, "NSE", DAY);
    const fut = rows.find((r) => r.instrument === "FUTIDX")!;
    assert.equal(fut.strike, 0);
    assert.equal(fut.optionType, "XX");
  });

  it("converts turnover from RUPEES to lakhs", () => {
    // 618,047,016 rupees = 6180.47 lakh. Storing the raw rupee figure in a
    // column named valueLakh puts two units in one column, invisible until
    // someone sums across the 2024 boundary.
    const { rows } = parseUdiffFoBhavcopy(CSV, "NSE", DAY);
    const fut = rows.find((r) => r.instrument === "FUTIDX")!;
    assert.ok(Math.abs(fut.valueLakh! - 6180.47016) < 0.001);
  });

  it("keeps option fields intact", () => {
    const opt = parseUdiffFoBhavcopy(CSV, "NSE", DAY).rows.find(
      (r) => r.instrument === "OPTIDX",
    )!;
    assert.equal(opt.strike, 59100);
    assert.equal(opt.optionType, "PE");
    assert.equal(opt.close, 1330.6);
    assert.equal(opt.openInt, 3660);
    assert.equal(opt.oiChange, 1230);
    assert.equal(opt.expiry.toISOString(), "2026-08-25T00:00:00.000Z");
  });

  it("skips cash rows and TALLIES the unknown type", () => {
    // A new NSE code must surface as a count, not as quietly missing history.
    const { rows, skippedByType } = parseUdiffFoBhavcopy(CSV, "NSE", DAY);
    assert.ok(!rows.some((r) => r.symbol === "RELIANCE"));
    assert.equal(skippedByType.STK, 1);
  });

  it("stamps the trading date at UTC midnight of the IST day", () => {
    const { rows } = parseUdiffFoBhavcopy(CSV, "NSE", DAY);
    assert.equal(rows[0]!.date.toISOString(), "2026-08-07T00:00:00.000Z");
  });

  it("emits only finite prices", () => {
    for (const r of parseUdiffFoBhavcopy(CSV, "NSE", DAY).rows) {
      for (const v of [r.open, r.high, r.low, r.close, r.volume, r.openInt]) {
        assert.ok(Number.isFinite(v), `non-finite: ${v}`);
      }
    }
  });

  it("returns empty for junk rather than throwing", () => {
    assert.equal(parseUdiffFoBhavcopy("", "NSE", DAY).rows.length, 0);
    assert.equal(parseUdiffFoBhavcopy("a,b\n1,2", "NSE", DAY).rows.length, 0);
  });
});
