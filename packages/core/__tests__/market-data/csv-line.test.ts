/**
 * Tests for the ONE shared RFC-4180 line splitter — MONEY-1205.
 *
 * Exercises `packages/core/src/market-data/csv-line.ts` directly.
 *
 * ## Why this file exists
 *
 * The splitter was module-private in `instruments/nse-master-logic.ts`. A
 * private helper that other modules can only consume by copy-paste is how you
 * end up with `mwpl-logic.ts`'s hand-copy AND `zerodha-instruments-logic.ts`'s
 * `line.split(",")` — the latter being the defect that stored 13,287 of 26,669
 * prod instrument names wrapped in literal double quotes.
 *
 * Now there is one implementation and three importers, so this is the one place
 * the quoting rules are pinned. `nse-master-logic.test.ts` and
 * `mwpl-logic.test.ts` still cover their own parsers end-to-end; those suites
 * passing after the extraction is what proves it was behaviour-preserving.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitCsvLine } from "../../src/market-data/csv-line";

describe("splitCsvLine", () => {
  it("splits a plain unquoted line", () => {
    assert.deepEqual(splitCsvLine("a,b,c"), ["a", "b", "c"]);
  });

  it("removes the delimiters around a quoted cell", () => {
    // The MONEY-1205 defect in one assertion: under `split(",")` this cell kept
    // its quote characters and they were written straight to the database.
    assert.deepEqual(splitCsvLine('a,"B C",d'), ["a", "B C", "d"]);
  });

  it("treats a comma inside quotes as literal", () => {
    assert.deepEqual(splitCsvLine('a,"B, C",d'), ["a", "B, C", "d"]);
  });

  it("treats a doubled quote inside quotes as one literal quote", () => {
    assert.deepEqual(splitCsvLine('a,"B ""C"" D",e'), ["a", 'B "C" D', "e"]);
  });

  it("handles a quoted cell that is entirely a quoted quote", () => {
    assert.deepEqual(splitCsvLine('a,"""",b'), ["a", '"', "b"]);
  });

  it("preserves empty cells, including leading and trailing", () => {
    assert.deepEqual(splitCsvLine(",a,,b,"), ["", "a", "", "b", ""]);
  });

  it("preserves an empty quoted cell", () => {
    assert.deepEqual(splitCsvLine('a,"",b'), ["a", "", "b"]);
  });

  it("does NOT trim whitespace — that is the caller's policy", () => {
    // Callers differ: the Zerodha parser trims (long-standing, tested
    // behaviour), the NSE master parser trims per-field where it matters.
    // Keeping the splitter faithful means the policy stays visible at the call
    // site instead of being buried here.
    assert.deepEqual(splitCsvLine(" a , b "), [" a ", " b "]);
  });

  it("keeps a trailing \\r so the caller's trim can remove it (CRLF feeds)", () => {
    assert.deepEqual(splitCsvLine("a,b\r"), ["a", "b\r"]);
  });

  it("returns a single empty field for an empty line", () => {
    assert.deepEqual(splitCsvLine(""), [""]);
  });

  it("runs an unbalanced quote to end of line rather than throwing", () => {
    // Deliberate: a short field count is what every caller already treats as a
    // COUNTED rejection, so a malformed line surfaces as a number in `reasons`
    // rather than as an exception that aborts a 114k-line sync.
    assert.deepEqual(splitCsvLine('a,"B,c'), ["a", "B,c"]);
  });

  it("parses the real Kite instrument line that exposed the bug", () => {
    const line =
      '1847809,7218,SBIETFQLTY,"SBI NIFTY 200 QUALITY 30 ETF",0,,0,0.01,1,EQ,NSE,NSE';
    const cells = splitCsvLine(line);
    assert.equal(cells.length, 12, "the Kite dump has 12 columns");
    assert.equal(cells[2], "SBIETFQLTY");
    assert.equal(cells[3], "SBI NIFTY 200 QUALITY 30 ETF");
    assert.equal(cells[11], "NSE");
  });

  it("gives a quoted and an unquoted cell the same value", () => {
    assert.deepEqual(
      splitCsvLine('1,2,ABB,"ABB INDIA",NSE'),
      splitCsvLine("1,2,ABB,ABB INDIA,NSE"),
    );
  });
});
