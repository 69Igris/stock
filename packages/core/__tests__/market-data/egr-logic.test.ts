/**
 * UNIT TEST — NSE Electronic Gold Receipts bhavcopy (MONEY-1204, P14 14b.4).
 *
 * Fixture is the REAL published file, complete and unedited:
 *   __tests__/fixtures/nse-sme/EG_BC10082026.DAT   (195 bytes, ONE data row)
 *
 * That single row is the whole archive's shape, and two documented claims about
 * it are wrong — root `CLAUDE.md` calls EGR a 404 (it is not; 8 objects are
 * archived) and `feed-backfill-report.md` calls the 195 bytes "a header with no
 * rows" (there is no header, and the 195 bytes ARE the row). Both are asserted
 * against here so they cannot quietly return.
 *
 * The cases that carry the weight:
 *
 *   1. `qty and value are proven by VWAP, not by position` — 23766349/153 =
 *      155335.61 lands inside [low, high]; 23766349/110 = 216057.72 lands 39%
 *      above the high. The wrong pairing is falsified, not merely less likely.
 *   2. `the OHLC ordering is the only self-consistent one` — reading fields 5-9
 *      as OPEN,HIGH,LOW,CLOSE,PREV puts the low above the high.
 *   3. `the five unknown columns are carried, never named` — a guessed name is
 *      a value a writer will persist as fact. They travel as raw text + numeric
 *      reading so the later investigation reads what NSE actually wrote.
 *   4. `the blank at index 9 is null, not 0` — it is four SPACES, and
 *      `Number("    ")` is 0. This is the house absence rule at its sharpest.
 *   5. `these bytes are not UDiFF, and UDiFF bytes are not these` — the spec's
 *      shape branch has to be decidable in both directions or it is not a test.
 *
 * Everything is synchronous: no timers, no promises, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EGR_COLUMNS,
  EGR_FIELD_COUNT,
  EGR_UNKNOWN_COLUMNS,
  parseEgrBhavcopy,
  parseEgrDate,
  parseEgrNumber,
  type EgrBhavcopyFile,
} from "../../src/market-data/egr-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const DAT = readFileSync(
  join(FIXTURES, "nse-sme", "EG_BC10082026.DAT"),
  "utf-8",
);

function parsed(): EgrBhavcopyFile {
  const file = parseEgrBhavcopy(DAT);
  assert.ok(file, "the real file must parse");
  return file;
}

describe("the fixture is what the docs say it is not", () => {
  it("is 195 bytes of DATA, with no header row", () => {
    const lines = DAT.split(/\r?\n/).filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1, "one line, and it is not a header");
    assert.equal(lines[0]!.split(",").length, EGR_FIELD_COUNT);
    // A header would carry column NAMES. This line's first field is an
    // instrument description and its date field is a date.
    assert.ok(lines[0]!.startsWith("EGR 999 10 GRAM"));
    assert.ok(parseEgrDate(lines[0]!.split(",")[14]) !== null);
  });
});

describe("parseEgrBhavcopy — the real 10-Aug-2026 file", () => {
  it("reads the one row and drops nothing", () => {
    const file = parsed();
    assert.equal(file.rows.length, 1);
    assert.deepEqual(file.reasons, {});
    assert.equal(file.tradingDate?.toISOString(), "2026-08-10T00:00:00.000Z");
  });

  it("reads the row cell-by-cell", () => {
    const row = parsed().rows[0]!;
    assert.equal(row.name, "EGR 999 10 GRAM");
    assert.equal(row.symbol, "GOLD10G99");
    assert.equal(row.series, "EG");
    assert.equal(row.market, "N");
    assert.equal(row.date.toISOString(), "2026-08-10T00:00:00.000Z");
    assert.equal(row.prevClose, 153366);
    assert.equal(row.open, 155334);
    assert.equal(row.high, 155349);
    assert.equal(row.low, 155324);
    assert.equal(row.close, 155348);
    assert.equal(row.tradedQty, 153);
    assert.equal(row.tradedValue, 23766349);
  });

  it("strips the space padding from name and symbol", () => {
    // Published as `EGR 999 10 GRAM               ` and `GOLD10G99 `.
    const row = parsed().rows[0]!;
    assert.equal(row.name, row.name.trim());
    assert.equal(row.symbol, row.symbol.trim());
    assert.ok(!row.symbol.includes(" "));
  });

  it("satisfies the OHLC invariants — the proof the field order is right", () => {
    const { open, high, low, close } = parsed().rows[0]!;
    assert.ok(low! <= open! && open! <= high!, "open inside the range");
    assert.ok(low! <= close! && close! <= high!, "close inside the range");
    assert.ok(low! <= high!, "low does not exceed high");
    // The rejected reading, stated so the falsification is in the suite: taking
    // fields 5-9 as OPEN,HIGH,LOW,CLOSE,PREV gives high=155334, low=155349.
    assert.ok(155334 < 155349, "…which would put the low above the high");
  });

  it("pairs quantity with value by a VWAP that lands inside the day's range", () => {
    const { tradedQty, tradedValue, low, high } = parsed().rows[0]!;
    const vwap = tradedValue! / tradedQty!;
    assert.ok(vwap >= low! && vwap <= high!, `vwap ${vwap} inside [low, high]`);
    assert.equal(vwap, 155335.61437908496);

    // The alternative pairing — value against the OTHER small integer in the
    // row (110, field index 15) — is falsified, not merely less likely.
    const wrong = tradedValue! / 110;
    assert.ok(wrong > high!, `${wrong} is 39% above the day's high`);
  });

  it("reads prices as RUPEES, not paise", () => {
    // ₹155,348 per 10-gram receipt is ₹15,535/gram, which is where gold sits.
    // A paise reading would put gold at ₹1,553 per 10 grams.
    const { close } = parsed().rows[0]!;
    assert.ok(close! > 100_000 && close! < 300_000);
  });
});

describe("the five columns this parser refuses to name", () => {
  it("declares exactly which they are", () => {
    assert.deepEqual([...EGR_UNKNOWN_COLUMNS], [9, 12, 13, 15, 16]);
    assert.equal(EGR_COLUMNS.length, EGR_FIELD_COUNT);
    assert.equal(
      EGR_COLUMNS.filter((c) => c.confidence === "unknown").length,
      5,
    );
    // Every named column has an index that matches its slot in the table, so the
    // table cannot drift out of order.
    EGR_COLUMNS.forEach((c, i) => assert.equal(c.index, i));
    // Nothing marked `unknown` is given a field name a writer could persist.
    assert.ok(
      EGR_COLUMNS.filter((c) => c.confidence === "unknown").every(
        (c) => c.field === "UNKNOWN",
      ),
    );
  });

  it("carries them as raw text plus a numeric reading", () => {
    const unknown = parsed().rows[0]!.unknown;
    assert.deepEqual(unknown, [
      { index: 9, raw: "    ", value: null },
      { index: 12, raw: "0155349.00", value: 155349 },
      { index: 13, raw: "0147850.00", value: 147850 },
      { index: 15, raw: "     110", value: 110 },
      { index: 16, raw: "0155348.00", value: 155348 },
    ]);
  });

  it("keeps the four-space blank at index 9 as null, never 0", () => {
    // Number("    ") is 0. A 0 here would read as a real published quantity.
    const blank = parsed().rows[0]!.unknown.find((u) => u.index === 9)!;
    assert.equal(blank.value, null);
    assert.notEqual(blank.value, 0);
    assert.equal(
      blank.raw,
      "    ",
      "the padding is preserved, not trimmed away",
    );
  });

  it("records the coincidences that the experiments have to separate", () => {
    // Index 12 equals the day's HIGH and index 16 equals the day's CLOSE on this
    // one row. That is exactly why they are unknown: a duplicate column and a
    // 52-week-high / settlement column are indistinguishable in a single file.
    const row = parsed().rows[0]!;
    const at = (i: number) => row.unknown.find((u) => u.index === i)!.value;
    assert.equal(at(12), row.high);
    assert.equal(at(16), row.close);
    assert.ok(at(13)! < row.low!, "index 13 is below the day's low");
    assert.ok(
      at(15)! < row.tradedQty!,
      "index 15 is below the traded quantity",
    );
  });
});

describe("parseEgrNumber", () => {
  it("reads zero-padded and space-padded numerics", () => {
    assert.equal(parseEgrNumber("0153366.00"), 153366);
    assert.equal(parseEgrNumber("           153"), 153);
    assert.equal(parseEgrNumber("       23766349.00"), 23766349);
    assert.equal(parseEgrNumber("0000000.00"), 0);
  });

  it("does not read a leading zero as octal", () => {
    // parseInt("0155349", 8) would be 56545. Number() is the right reader.
    assert.equal(parseEgrNumber("0155349.00"), 155349);
    assert.equal(parseEgrNumber("0000110"), 110);
  });

  it("reads absence as null, never 0", () => {
    assert.equal(parseEgrNumber("    "), null);
    assert.equal(parseEgrNumber(""), null);
    assert.equal(parseEgrNumber("-"), null);
    assert.equal(parseEgrNumber("NA"), null);
    assert.equal(parseEgrNumber(null), null);
    assert.equal(parseEgrNumber(undefined), null);
    assert.equal(parseEgrNumber("EG"), null);
  });
});

describe("parseEgrDate — DD-MON-YYYY upper", () => {
  it("reads 10-AUG-2026", () => {
    assert.equal(
      parseEgrDate("10-AUG-2026")?.toISOString(),
      "2026-08-10T00:00:00.000Z",
    );
  });

  it("matches the archive key EG_BC10082026.DAT", () => {
    // The key is DDMMYYYY; the row is DD-MON-YYYY. They must agree or one of the
    // two is being read day/month-transposed.
    assert.equal(
      parsed().tradingDate?.toISOString(),
      new Date(Date.UTC(2026, 7, 10)).toISOString(),
    );
  });

  it("rejects the all-numeric grammar the MWPL feed uses", () => {
    assert.equal(parseEgrDate("10-08-2026"), null);
  });

  it("rejects impossible days and junk", () => {
    assert.equal(parseEgrDate("31-FEB-2026"), null);
    assert.equal(parseEgrDate("10-XXX-2026"), null);
    assert.equal(parseEgrDate(""), null);
    assert.equal(parseEgrDate(null), null);
  });
});

describe("shape detection — this is not UDiFF, and UDiFF is not this", () => {
  it("returns null for bytes that are not this report", () => {
    assert.equal(parseEgrBhavcopy(""), null);
    assert.equal(parseEgrBhavcopy("   \n \n"), null);
    assert.equal(parseEgrBhavcopy("<html><body>403</body></html>"), null);
  });

  it("rejects a UDiFF bhavcopy — header row, ~30 named columns", () => {
    const udiff =
      "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs," +
      "XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric," +
      "LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst," +
      "ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks\n" +
      "2026-08-10,2026-08-10,CM,NSE,STK,1234,INE002A01018,RELIANCE,EQ,,,0,,RELIANCE," +
      "1,2,0.5,1.5,1.5,1,,,0,0,10,15,3,F1,1,";
    assert.equal(parseEgrBhavcopy(udiff), null);
  });

  it("rejects the SME bhavcopy — 14 fields and a header", () => {
    const sme =
      "MARKET,SERIES,SYMBOL,SECURITY,PREV_CL_PR,OPEN_PRICE,HIGH_PRICE,LOW_PRICE," +
      "CLOSE_PRICE,NET_TRDVAL,NET_TRDQTY,CORP_IND,HI_52_WK,LO_52_WK\n" +
      "N,SM,AAKAAR,AAKAAR MEDICAL TECHNO LTD,        88.65,        88.90," +
      "        89.90,        86.55,        86.55,           847840.00,9600, ," +
      "       105.00,        62.00";
    assert.equal(parseEgrBhavcopy(sme), null);
  });

  it("rejects a row that gained a column AFTER the date field", () => {
    // The realistic drift, and the only case the 17-field check catches on its
    // own: a column added BEFORE index 14 moves the date and the date check
    // fires, but a column APPENDED leaves a valid date at index 14 while
    // silently reassigning the meaning of every unknown index after it. Found by
    // mutating the field-count guard away and watching nothing go red.
    const appended = DAT.trimEnd() + ",0155348.00";
    assert.equal(appended.split(",").length, EGR_FIELD_COUNT + 1);
    assert.ok(
      parseEgrDate(appended.split(",")[14]) !== null,
      "date still at 14",
    );
    assert.equal(parseEgrBhavcopy(appended), null);
  });

  it("survives a future header or trailer instead of losing the file to it", () => {
    // Headerless formats have no anchor, so a line that is not a row is counted
    // and skipped rather than treated as fatal — otherwise one added banner line
    // would take every real row down with it.
    const withBanner =
      "NATIONAL STOCK EXCHANGE OF INDIA LIMITED\n" +
      DAT.trimEnd() +
      "\nEND OF REPORT\n";
    const file = parseEgrBhavcopy(withBanner)!;
    assert.equal(file.rows.length, 1);
    assert.equal(file.rows[0]!.symbol, "GOLD10G99");
    assert.deepEqual(file.reasons, { "field-count": 2 });
  });

  it("counts a mixed-date file instead of silently taking the first day", () => {
    const second = DAT.trimEnd().replace("10-AUG-2026", "11-AUG-2026");
    const file = parseEgrBhavcopy(DAT.trimEnd() + "\n" + second)!;
    assert.equal(file.rows.length, 2);
    assert.deepEqual(file.reasons, { "mixed-date": 1 });
    assert.equal(file.tradingDate?.toISOString(), "2026-08-10T00:00:00.000Z");
    assert.equal(file.rows[1]!.date.toISOString(), "2026-08-11T00:00:00.000Z");
  });

  it("survives CRLF", () => {
    const crlf = DAT.trimEnd() + "\r\n";
    const file = parseEgrBhavcopy(crlf)!;
    assert.equal(file.rows.length, 1);
    assert.equal(file.rows[0]!.close, 155348);
    assert.deepEqual(file.reasons, {});
  });
});
