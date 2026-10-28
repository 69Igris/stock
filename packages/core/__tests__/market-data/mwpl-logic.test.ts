/**
 * UNIT TEST — NSE combined open interest → `MwplDaily` (MONEY-1204, P14 14b.2).
 *
 * Fixture is the REAL published file, complete and unedited:
 *   __tests__/fixtures/nse-mwpl/combineoi_deleq_14082026.csv  (217 data rows)
 *
 * MONEY-1201's lesson is the reason: a synthetic fixture encodes the same
 * misunderstanding as the parser and goes green while being wrong. Every count
 * and every cell below was read out of those bytes.
 *
 * The cases that carry the weight:
 *
 *   1. `utilisation is null for every substitute denominator` — the point of the
 *      whole task. `mwpl` has no source, and `0` is the dangerous input: `x / 0`
 *      is `Infinity`, which passes a `>= 80` ban-risk comparison for every
 *      symbol on the board.
 *   2. `MwplDailyWrite cannot carry a denominator` — the literal-`null` typing is
 *      asserted at runtime too, so deleting the type guard still fails a test.
 *   3. `14-08-2026 is read day-first, and MM-DD-YYYY is rejected not swapped` —
 *      `14-08-2026` is self-disambiguating, so the guard has to be written
 *      against a token that is NOT (`08-14-2026`), or it proves nothing.
 *   4. `the nine index rows are kept and marked` — MWPL is a single-stock
 *      concept; dropping NIFTY/BANKNIFTY loses real open interest, and treating
 *      them as MWPL candidates invents a limit that does not exist.
 *   5. `a file missing an OI column is not this report` — a half-read file whose
 *      missing column looks like a genuine all-null day is the silent-failure
 *      mode this repo keeps re-learning.
 *
 * MONEY-1204 adds the OLDER layouts, and six more real fixtures with them. NSE
 * published this file in three column shapes, the parser knew one, and the other
 * 409 of 689 archived objects were rejected as "not this report" and
 * checkpointed DONE — 270 days of a 688-day archive. The cases that carry the
 * weight there:
 *
 *   6. `reads a day-of-month > 12 correctly in EVERY era` — the assertion that
 *      falsifies MM-DD-YYYY. `26-10-2023`, `27-06-2025`, `14-07-2025` and
 *      `14-08-2026` are each self-disambiguating, so one per layout proves the
 *      old files were not silently re-dated by nine months.
 *   7. `maps PORTFOLIO-wise onto futEquivOi, never CONTRACT-wise` — the old file
 *      has three numeric columns and the modern one has two. Getting this wrong
 *      is undetectable downstream, so it is asserted against the real numbers on
 *      both sides of the changeover.
 *   8. the two refusal fixtures — a slash date and a mangled year. Both are real
 *      published files, both are REFUSED rather than guessed at, and the test
 *      pins that they reach `bad-date` and produce `rows: []` rather than being
 *      quietly accepted.
 *
 * Everything is synchronous: no timers, no promises, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MWPL_SOURCE,
  computeUtilisationPct,
  parseCombinedOiDeleq,
  parseMwplDate,
  toMwplDailyWrite,
  type CombinedOiFile,
  type CombinedOiRow,
} from "../../src/market-data/mwpl-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const mwplFixture = (name: string): string =>
  readFileSync(join(FIXTURES, "nse-mwpl", name), "utf-8");

const CSV = mwplFixture("combineoi_deleq_14082026.csv");

/**
 * Every layout NSE has published, one REAL file each, read off the prod archive.
 *
 * Named by what distinguishes them, not by date, because the eras INTERLEAVE in
 * the archive and "old"/"new" would imply a cutover that does not exist.
 */
/** Layout 1 — 7 columns, quoted, 2023-04-12 → 2024-11-18 (254 files). */
const QUOTED_7COL = mwplFixture("combineoi_deleq_26102023.csv");
/** Layout 2 — 7 columns, unquoted, 2023-11-02 → 2025-06-27 (154 files). */
const PLAIN_7COL = mwplFixture("combineoi_deleq_27062025.csv");
/** Layout 3 — 6 columns with two spaces missing from the header (64 files). */
const SQUASHED_6COL = mwplFixture("combineoi_deleq_14072025.csv");
/**
 * Layout 4's FIRST file — the trading day immediately after {@link PLAIN_7COL}.
 *
 * Kept specifically because it is adjacent. The column-mapping check below is a
 * magnitude comparison, and open interest drifts: against this file the right
 * mapping is 8.1x closer than the wrong one, but against a file 17 trading days
 * later the same comparison collapses to 1.4x and proves nothing.
 */
const FIRST_6COL = mwplFixture("combineoi_deleq_30062025.csv");
/** The object archived under a 2023-04-12 key whose bytes are 2023-12-04's. */
const MISKEYED = mwplFixture("combineoi_deleq_12042023.csv");
/** A real file dated `11/08/25` — slashes, two-digit year, undecidable order. */
const SLASH_DATE = mwplFixture("combineoi_deleq_11082025.csv");
/** A real file whose every row is dated `20-11-0018`. */
const MANGLED_YEAR = mwplFixture("combineoi_deleq_18112024.csv");

/** The real file's header, verbatim — used to build negative fixtures from it. */
const HEADER =
  "Date,ISIN,Scrip Name,Symbol,Notional Open Interest," +
  "Portfolio-wise Futures Equivalent Open Interest";

function parsed(): CombinedOiFile {
  const file = parseCombinedOiDeleq(CSV);
  assert.ok(file, "the real file must parse");
  return file;
}

describe("parseCombinedOiDeleq — the real 14-Aug-2026 file", () => {
  it("reads all 217 data rows and drops nothing", () => {
    const file = parsed();
    assert.equal(file.rows.length, 217);
    assert.deepEqual(
      file.reasons,
      {},
      "a clean file must report no drop reasons at all",
    );
  });

  it("reads the first row cell-by-cell", () => {
    // 14-08-2026,INE260B01028,GODFREY PHILLIPS INDIA LT,GODFRYPHLP,4477000,1860466.76235715
    const row = parsed().rows[0]!;
    assert.equal(row.symbol, "GODFRYPHLP");
    assert.equal(row.isin, "INE260B01028");
    assert.equal(row.name, "GODFREY PHILLIPS INDIA LT");
    assert.equal(row.date.toISOString(), "2026-08-14T00:00:00.000Z");
    assert.equal(row.notionalOi, 4477000);
    assert.equal(row.futEquivOi, 1860466.76235715);
    assert.equal(row.isIndex, false);
  });

  it("keeps the fractional futures-equivalent OI at full precision", () => {
    // The model stores Float for exactly this reason. A parser that rounded, or
    // that read the column as an integer, would pass every other case here.
    const reliance = parsed().rows.find((r) => r.symbol === "RELIANCE")!;
    assert.equal(reliance.notionalOi, 241124500);
    assert.equal(reliance.futEquivOi, 140455762.42426288);
    assert.ok(
      !Number.isInteger(reliance.futEquivOi),
      "futEquivOi is delta-adjusted and fractional",
    );
  });

  it("stamps every row with the file's own date", () => {
    const file = parsed();
    assert.equal(file.tradingDate?.toISOString(), "2026-08-14T00:00:00.000Z");
    assert.ok(
      file.rows.every((r) => r.date.getTime() === file.tradingDate!.getTime()),
      "all 217 rows carry 14-08-2026",
    );
  });

  it("finds no duplicate symbol — the @@unique([symbol, date]) key holds", () => {
    const symbols = parsed().rows.map((r) => r.symbol);
    assert.equal(new Set(symbols).size, symbols.length);
  });
});

describe("index underlyings", () => {
  it("keeps the nine index rows and marks them isIndex", () => {
    // NSE publishes `NA` for both ISIN and Scrip Name on an index underlying.
    // Their OI is real; MWPL is a single-stock concept and never applies here.
    const indexRows = parsed().rows.filter((r) => r.isIndex);
    assert.equal(indexRows.length, 9);
    assert.deepEqual(
      indexRows.map((r) => r.symbol).sort(),
      [
        "BANKEX",
        "BANKNIFTY",
        "FINNIFTY",
        "FOCIT",
        "MIDCPNIFTY",
        "NIFTY",
        "NIFTYFPI",
        "NIFTYNXT50",
        "SENSEX",
      ],
      "SENSEX and BANKEX are BSE indices and are in NSE's own file",
    );
  });

  it("reads `NA` as absence, never as the string NA or as 0", () => {
    const nifty = parsed().rows.find((r) => r.symbol === "NIFTY")!;
    assert.equal(nifty.isin, null);
    assert.equal(nifty.name, null);
    // The OI on the same row is a real number and must survive.
    assert.equal(nifty.notionalOi, 550786455);
    assert.equal(nifty.futEquivOi, 64544540.23709695);
  });

  it("does not call a stock an index just because its ISIN cell is blank", () => {
    // `isIndex` keys on BOTH identity columns being NA, not on the ISIN alone.
    // A stock with a missing ISIN is a data gap; an index row is a different
    // kind of underlying, and MWPL applies to one and not the other. The real
    // file cannot separate these — every non-index row there has an ISIN — so
    // the distinction has to be asserted on bytes built to test exactly it.
    const csv =
      HEADER +
      "\n14-08-2026,,GODFREY PHILLIPS INDIA LT,GODFRYPHLP,4477000,1860466.76";
    const row = parseCombinedOiDeleq(csv)!.rows[0]!;
    assert.equal(row.isin, null);
    assert.equal(row.name, "GODFREY PHILLIPS INDIA LT");
    assert.equal(row.isIndex, false);
  });

  it("leaves the 208 stock rows carrying an ISIN", () => {
    const stocks = parsed().rows.filter((r) => !r.isIndex);
    assert.equal(stocks.length, 208);
    assert.ok(stocks.every((r) => r.isin !== null && r.isin.length === 12));
  });
});

describe("computeUtilisationPct — inert today, correct when a denominator lands", () => {
  it("is null for every denominator we do not have", () => {
    assert.equal(computeUtilisationPct(4477000, null), null);
    assert.equal(computeUtilisationPct(4477000, undefined), null);
    assert.equal(computeUtilisationPct(4477000, Number.NaN), null);
    assert.equal(
      computeUtilisationPct(4477000, Number.POSITIVE_INFINITY),
      null,
    );
    assert.equal(computeUtilisationPct(4477000, -1), null);
  });

  it("is null for a ZERO denominator — the one that would fire every flag", () => {
    // 4477000 / 0 === Infinity, and `Infinity >= 80` is true. A parser that let
    // this through would mark every symbol on the board as ban-risk.
    assert.equal(computeUtilisationPct(4477000, 0), null);
    assert.notEqual(
      computeUtilisationPct(4477000, 0),
      Number.POSITIVE_INFINITY,
    );
  });

  it("is null for an unusable numerator", () => {
    assert.equal(computeUtilisationPct(null, 5_000_000), null);
    assert.equal(computeUtilisationPct(undefined, 5_000_000), null);
    assert.equal(computeUtilisationPct(Number.NaN, 5_000_000), null);
    assert.equal(computeUtilisationPct(-1, 5_000_000), null);
  });

  it("computes correctly for a real denominator", () => {
    // GODFRYPHLP's published notional OI against a hypothetical 5,000,000-share
    // limit: 4,477,000 / 5,000,000 = 89.54%. The literal is the exact IEEE-754
    // result, NOT the rounded 89.54 — pinning the rounded value would quietly
    // require the helper to round, which is a display decision.
    assert.equal(computeUtilisationPct(4477000, 5_000_000), 89.53999999999999);
    // Both published columns are legal numerators — which one is correct is a
    // separate unsettled question, so the helper must not privilege either.
    assert.equal(
      computeUtilisationPct(1860466.76235715, 5_000_000),
      37.209335247143,
    );
    // Exactly at the limit, and past it — a real MWPL day can exceed 100%.
    assert.equal(computeUtilisationPct(5_000_000, 5_000_000), 100);
    assert.equal(computeUtilisationPct(6_000_000, 5_000_000), 120);
  });

  it("returns 0 for zero open interest — a real value, not absence", () => {
    assert.equal(computeUtilisationPct(0, 5_000_000), 0);
  });

  it("does not round", () => {
    // Rounding is a display decision. 1/3 must survive to the caller intact.
    assert.equal(computeUtilisationPct(1, 3), (1 / 3) * 100);
  });
});

describe("toMwplDailyWrite", () => {
  it("maps a row onto MwplDaily with both derived fields null", () => {
    const row = parsed().rows[0]!;
    assert.deepEqual(toMwplDailyWrite(row), {
      symbol: "GODFRYPHLP",
      isin: "INE260B01028",
      date: new Date("2026-08-14T00:00:00.000Z"),
      notionalOi: 4477000,
      futEquivOi: 1860466.76235715,
      mwpl: null,
      utilisationPct: null,
      source: MWPL_SOURCE,
    });
  });

  it("writes null mwpl for EVERY row, including the index ones", () => {
    // The type says `null`; this asserts it at runtime so that deleting the
    // literal type does not silently reopen the substitute-denominator door.
    const writes = parsed().rows.map((r) => toMwplDailyWrite(r));
    assert.equal(writes.length, 217);
    assert.ok(writes.every((w) => w.mwpl === null));
    assert.ok(writes.every((w) => w.utilisationPct === null));
    assert.ok(writes.every((w) => w.source === MWPL_SOURCE));
  });

  it("drops `name` and `isIndex` — the model has no column for either", () => {
    const write = toMwplDailyWrite(parsed().rows[0]!);
    assert.deepEqual(Object.keys(write).sort(), [
      "date",
      "futEquivOi",
      "isin",
      "mwpl",
      "notionalOi",
      "source",
      "symbol",
      "utilisationPct",
    ]);
  });
});

describe("parseMwplDate — DD-MM-YYYY, day-first, strict", () => {
  it("reads 14-08-2026 as 14 August", () => {
    const d = parseMwplDate("14-08-2026");
    assert.equal(d?.toISOString(), "2026-08-14T00:00:00.000Z");
    assert.equal(d?.getUTCDate(), 14);
    assert.equal(d?.getUTCMonth(), 7); // August
  });

  it("rejects MM-DD-YYYY rather than silently swapping it", () => {
    // 14-08-2026 is self-disambiguating, so the ordering guard has to be written
    // against a token that is not: 08-14-2026 has a month of 14.
    assert.equal(parseMwplDate("08-14-2026"), null);
  });

  it("reads an ambiguous token day-first, deterministically", () => {
    // 08-09-2026 parses under BOTH orderings. This pins which one we chose, so a
    // future edit that flips it fails here instead of shifting a month of data.
    assert.equal(
      parseMwplDate("08-09-2026")?.toISOString(),
      "2026-09-08T00:00:00.000Z",
    );
  });

  it("rejects impossible days that Date.UTC would roll over", () => {
    assert.equal(parseMwplDate("31-02-2026"), null); // would become 03-Mar
    assert.equal(parseMwplDate("00-08-2026"), null);
    assert.equal(parseMwplDate("32-08-2026"), null);
    assert.equal(parseMwplDate("14-00-2026"), null);
    assert.equal(parseMwplDate("14-13-2026"), null);
  });

  it("rejects other date grammars and junk", () => {
    assert.equal(parseMwplDate("2026-08-14"), null); // ISO
    assert.equal(parseMwplDate("14-AUG-2026"), null); // the EGR/debt grammar
    assert.equal(parseMwplDate("14/08/2026"), null);
    assert.equal(parseMwplDate("14082026"), null);
    assert.equal(parseMwplDate(""), null);
    assert.equal(parseMwplDate(null), null);
    assert.equal(parseMwplDate(undefined), null);
  });

  it("rejects years outside the plausible archive window", () => {
    assert.equal(parseMwplDate("14-08-1889"), null);
    assert.equal(parseMwplDate("14-08-2101"), null);
  });
});

describe("absence and rejection", () => {
  it("returns null for bytes that are not this report", () => {
    assert.equal(parseCombinedOiDeleq(""), null);
    assert.equal(parseCombinedOiDeleq("   \n  \n"), null);
    assert.equal(
      parseCombinedOiDeleq("<html><body>Access Denied</body></html>"),
      null,
    );
    // A different NSE feed with a real header of its own.
    assert.equal(
      parseCombinedOiDeleq("SYMBOL,CLIENT_LIMIT,EXCHANGE\nX,1,NSE"),
      null,
    );
  });

  it("returns null when either open-interest column is missing", () => {
    // A half-read file is worse than a rejected one: its missing column is
    // indistinguishable from a genuine all-null day.
    const noNotional =
      "Date,ISIN,Scrip Name,Symbol,Portfolio-wise Futures Equivalent Open Interest\n" +
      "14-08-2026,INE260B01028,GODFREY PHILLIPS INDIA LT,GODFRYPHLP,1860466.76";
    assert.equal(parseCombinedOiDeleq(noNotional), null);

    const noFutEquiv =
      "Date,ISIN,Scrip Name,Symbol,Notional Open Interest\n" +
      "14-08-2026,INE260B01028,GODFREY PHILLIPS INDIA LT,GODFRYPHLP,4477000";
    assert.equal(parseCombinedOiDeleq(noFutEquiv), null);
  });

  it("distinguishes `null` from `rows: []`", () => {
    // Header alone: this IS the report, and it carried nothing. Collapsing the
    // two would make "NSE published an empty file" look like "we cannot read
    // NSE's files".
    const headerOnly = parseCombinedOiDeleq(HEADER);
    assert.ok(headerOnly, "a header-only file is still this report");
    assert.deepEqual(headerOnly.rows, []);
    assert.equal(headerOnly.tradingDate, null);
  });

  it("reads a blank OI cell as null, never as 0", () => {
    // Number("") is 0, and a 0 open interest is a tradeable-looking fact.
    const csv =
      HEADER +
      "\n14-08-2026,INE260B01028,GODFREY PHILLIPS INDIA LT,GODFRYPHLP,,1860466.76";
    const file = parseCombinedOiDeleq(csv)!;
    assert.equal(file.rows.length, 1);
    assert.equal(file.rows[0]!.notionalOi, null);
    assert.notEqual(file.rows[0]!.notionalOi, 0);
    assert.equal(file.rows[0]!.futEquivOi, 1860466.76);
  });

  it("counts every drop instead of losing it", () => {
    const csv = [
      HEADER,
      "14-08-2026,INE260B01028,GODFREY PHILLIPS INDIA LT,GODFRYPHLP,4477000,1860466.76",
      "14-08-2026,INE002A01018,RELIANCE INDUSTRIES LTD,,241124500,140455762.42", // no symbol
      "not-a-date,INE002A01018,X LTD,XSYM,1,2", // bad date
      "14-08-2026,INE002A01018,Y LTD,YSYM,,", // no open interest at all
      "14-08-2026,INE002A01018,TOO,MANY,COLUMNS,HERE,EXTRA", // field count
      "13-08-2026,INE002A01018,Z LTD,ZSYM,10,20", // a different day
    ].join("\n");

    const file = parseCombinedOiDeleq(csv)!;
    assert.deepEqual(
      file.rows.map((r) => r.symbol),
      ["GODFRYPHLP", "ZSYM"],
    );
    assert.deepEqual(file.reasons, {
      "no-symbol": 1,
      "bad-date": 1,
      "no-open-interest": 1,
      "field-count": 1,
      "mixed-date": 1,
    });
    // The mixed-date row is KEPT, carrying its own date — the model documents
    // the file's Date column as the source of truth, not the archive key.
    assert.equal(file.tradingDate?.toISOString(), "2026-08-14T00:00:00.000Z");
    assert.equal(file.rows[1]!.date.toISOString(), "2026-08-13T00:00:00.000Z");
  });

  it("survives CRLF and a trailing blank line", () => {
    const csv =
      HEADER +
      "\r\n14-08-2026,INE260B01028,GODFREY PHILLIPS INDIA LT,GODFRYPHLP,4477000,1860466.76\r\n\r\n";
    const file = parseCombinedOiDeleq(csv)!;
    assert.equal(file.rows.length, 1);
    assert.equal(file.rows[0]!.futEquivOi, 1860466.76);
    assert.deepEqual(file.reasons, {});
  });

  it("recovers a quoted Scrip Name containing a comma", () => {
    // Never observed, but the column is free text. Quoted, it must survive;
    // unquoted, it shifts every column right and is dropped with a count.
    const quoted =
      HEADER +
      '\n14-08-2026,INE260B01028,"GODFREY PHILLIPS, INDIA",GODFRYPHLP,4477000,1860466.76';
    const ok = parseCombinedOiDeleq(quoted)!;
    assert.equal(ok.rows[0]!.name, "GODFREY PHILLIPS, INDIA");
    assert.equal(ok.rows[0]!.symbol, "GODFRYPHLP");

    const unquoted =
      HEADER +
      "\n14-08-2026,INE260B01028,GODFREY PHILLIPS, INDIA,GODFRYPHLP,4477000,1860466.76";
    const bad = parseCombinedOiDeleq(unquoted)!;
    assert.deepEqual(bad.rows, []);
    assert.deepEqual(bad.reasons, { "field-count": 1 });
  });
});

// ─── MONEY-1204: the layouts that cost two years of history ─────────────────

describe("the 7-column era parses at all", () => {
  it("reads the QUOTED layout that was rejected as `not this report`", () => {
    // 254 archived files looked like this and every one returned null, was
    // counted UNRECOGNISED-FORMAT, and was checkpointed DONE having written
    // nothing. Quoted text cells, bare numerics.
    const file = parseCombinedOiDeleq(QUOTED_7COL);
    assert.ok(file, "the quoted 7-column layout must parse");
    assert.equal(file.rows.length, 184);
    assert.deepEqual(file.reasons, {}, "a real file must drop nothing");

    const row = file.rows[0]!;
    // "26-10-2023","INE769A01020","Aarti Industries Limited","AARTIIND",
    //   20966000,17451548.17,13986394.6
    assert.equal(row.symbol, "AARTIIND");
    assert.equal(row.isin, "INE769A01020");
    assert.equal(row.name, "Aarti Industries Limited");
    assert.equal(row.notionalOi, 20966000);
    assert.equal(row.futEquivOi, 13986394.6);
    assert.equal(row.contractDeltaOi, 17451548.17);
    assert.equal(row.isIndex, false);
  });

  it("reads the UNQUOTED layout, same column names", () => {
    // 154 more files. Same header text, no quotes — which is why the two are
    // one rule here and not two.
    const file = parseCombinedOiDeleq(PLAIN_7COL);
    assert.ok(file);
    assert.equal(file.rows.length, 231);
    assert.deepEqual(file.reasons, {});

    const row = file.rows[0]!;
    // 27-06-2025,INE171Z01026,BHARAT DYNAMICS LIMITED,BDL,
    //   5389800,3770369.83720250,2465443.39796950
    assert.equal(row.symbol, "BDL");
    assert.equal(row.notionalOi, 5389800);
    assert.equal(row.futEquivOi, 2465443.3979695);
    assert.equal(row.contractDeltaOi, 3770369.8372025);
  });

  it("reads the 6-column layout whose header lost two spaces", () => {
    // `NotionalOpen Interest` / `Portfolio-wiseFutures Equivalent …`. It needs
    // no rule of its own — normalizeHeader strips the spacing — and this pins
    // that, because a header matcher written against the spaced label only
    // would silently drop 64 files.
    const file = parseCombinedOiDeleq(SQUASHED_6COL);
    assert.ok(file);
    assert.equal(file.rows.length, 231);
    assert.deepEqual(file.reasons, {});

    const row = file.rows[0]!;
    // 14-07-2025,INE044A01036,SUN PHARMACEUTICAL IND L,SUNPHARMA,30589300,20816638.92
    assert.equal(row.symbol, "SUNPHARMA");
    assert.equal(row.notionalOi, 30589300);
    assert.equal(row.futEquivOi, 20816638.92);
    assert.equal(
      row.contractDeltaOi,
      null,
      "the 6-column era publishes no contract-wise measure — null, not 0",
    );
  });

  it("keeps the index rows the 7-column era also carries", () => {
    const file = parseCombinedOiDeleq(PLAIN_7COL)!;
    const idx = file.rows.filter((r) => r.isIndex);
    assert.equal(idx.length, 7);
    assert.ok(idx.some((r) => r.symbol === "NIFTY"));
    for (const r of idx) {
      assert.equal(r.isin, null, "`NA` is absence, never the string NA");
      assert.equal(r.name, null);
      assert.ok(
        r.notionalOi !== null,
        "an index row's open interest is real and is kept",
      );
    }
  });
});

describe("day-of-month > 12 — the assertion that falsifies MM-DD-YYYY", () => {
  // The trap this exists for: from `04-12-2023` alone it is natural to conclude
  // the old era is month-first. It is not. Checked across the whole prod
  // archive, 675 of 677 dash-dated files agree with their own `{DDMMYYYY}`
  // object key read DAY-first, in BOTH eras. One self-disambiguating day per
  // layout is what proves a parser has not silently re-dated two years by nine
  // months — a token like `04-08-2025` would prove nothing, since it parses
  // either way.
  const cases: ReadonlyArray<readonly [string, string, string, number]> = [
    ["quoted 7-column", QUOTED_7COL, "26-10-2023", Date.UTC(2023, 9, 26)],
    ["unquoted 7-column", PLAIN_7COL, "27-06-2025", Date.UTC(2025, 5, 27)],
    ["squashed 6-column", SQUASHED_6COL, "14-07-2025", Date.UTC(2025, 6, 14)],
    ["modern 6-column", CSV, "14-08-2026", Date.UTC(2026, 7, 14)],
  ];

  for (const [label, csv, token, expected] of cases) {
    it(`reads ${token} day-first in the ${label} layout`, () => {
      const file = parseCombinedOiDeleq(csv)!;
      assert.equal(file.tradingDate!.getTime(), expected);
      // and every row agrees, not just the first
      for (const row of file.rows) {
        assert.equal(row.date.getTime(), expected);
      }
      const day = Number(token.slice(0, 2));
      assert.ok(day > 12, `${token} must be self-disambiguating to prove this`);
      assert.equal(parseMwplDate(token)!.getTime(), expected);
    });
  }
});

describe("the three old columns map onto the two new fields", () => {
  // Getting this wrong puts a contract-wise number in a portfolio-wise column,
  // which no reader could detect. It was settled by measurement across the
  // one-trading-day changeover (see the module header), and these assertions
  // are that measurement's shape, held against the real fixtures.
  it("takes futEquivOi from PORTFOLIO-wise, never from CONTRACT-wise", () => {
    const old = parseCombinedOiDeleq(PLAIN_7COL)!;
    const byOldSymbol = new Map(old.rows.map((r) => [r.symbol, r]));
    const bdl = byOldSymbol.get("BDL")!;
    // The published line, verbatim:
    // 27-06-2025,…,BDL,5389800,3770369.83720250,2465443.39796950
    //                            ^contract-wise   ^portfolio-wise
    assert.equal(bdl.futEquivOi, 2465443.3979695);
    assert.notEqual(
      bdl.futEquivOi,
      3770369.8372025,
      "contract-wise must NEVER land in futEquivOi",
    );
  });

  it("contract-wise is strictly the LARGER of the two in every row", () => {
    // True of every row of every archived 7-column file, and the reason the two
    // cannot be swapped without the numbers noticing.
    for (const csv of [QUOTED_7COL, PLAIN_7COL]) {
      for (const row of parseCombinedOiDeleq(csv)!.rows) {
        assert.ok(row.contractDeltaOi !== null && row.futEquivOi !== null);
        assert.ok(
          row.contractDeltaOi >= row.futEquivOi,
          `${row.symbol}: contract-wise ${row.contractDeltaOi} < portfolio-wise ${row.futEquivOi}`,
        );
      }
    }
  });

  it("the mapping is continuous across the changeover", () => {
    // 2025-06-27 is the LAST 7-column file and 2025-06-30 is the FIRST
    // 6-column one — one trading day apart, 231 symbols in both. Open interest
    // moves overnight, so this is a magnitude comparison, not an equality one.
    // Measured: portfolio-wise is 1.6% from the modern column and contract-wise
    // is 12.8% — 8.1x apart, far outside any one-night drift.
    const before = new Map(
      parseCombinedOiDeleq(PLAIN_7COL)!.rows.map((r) => [r.symbol, r]),
    );
    const after = new Map(
      parseCombinedOiDeleq(FIRST_6COL)!.rows.map((r) => [r.symbol, r]),
    );
    const shared = [...after.keys()].filter((s) => before.has(s));
    assert.ok(shared.length > 200, `only ${shared.length} shared symbols`);

    /** Median |relative difference| between an old column and the modern one. */
    const medianDrift = (
      pick: (row: CombinedOiRow) => number | null,
    ): number => {
      const diffs = shared
        .map((sym) => {
          const a = pick(before.get(sym)!);
          const b = after.get(sym)!.futEquivOi;
          return a === null || b === null || b === 0
            ? null
            : Math.abs(a - b) / Math.abs(b);
        })
        .filter((x): x is number => x !== null)
        .sort((x, y) => x - y);
      return diffs[Math.floor(diffs.length / 2)]!;
    };

    const portfolioWise = medianDrift((r) => r.futEquivOi);
    const contractWise = medianDrift((r) => r.contractDeltaOi);
    assert.ok(
      portfolioWise < contractWise,
      `portfolio-wise (${portfolioWise}) must track the modern column more ` +
        `closely than contract-wise (${contractWise})`,
    );
    assert.ok(
      contractWise / portfolioWise > 4,
      `the two candidates are only ${contractWise / portfolioWise}x apart — ` +
        "too close to call, so this would prove nothing",
    );
  });
});

describe("dates that are refused rather than guessed at", () => {
  it("refuses a real slash-dated file instead of inventing an ordering", () => {
    // 11 archived files use slashes, every one with both leading fields <= 12,
    // and they CONTRADICT each other: `4/3/2024` can only be day-first, and
    // `11/2/2023` can only be month-first. A day-first rule would be right ten
    // times and silently wrong by nine months once, so all eleven are refused.
    const file = parseCombinedOiDeleq(SLASH_DATE);
    assert.ok(file, "the header is recognised — this is not `not this report`");
    assert.equal(file.rows.length, 0, "not one row may be accepted");
    assert.equal(file.tradingDate, null);
    assert.equal(file.reasons["bad-date"], 224, "every row lands in bad-date");
    assert.equal(parseMwplDate("11/08/25"), null);
    assert.equal(parseMwplDate("11/2/2023"), null);
    assert.equal(parseMwplDate("4/3/2024"), null);
  });

  it("refuses a real file whose year is mangled to 0018", () => {
    // 2024-11-18 publishes `20-11-0018` in all 185 rows. A genuinely distinct
    // session — its body matches no other file in the archive — that cannot be
    // placed in time, so it is refused rather than reconstructed from the key.
    const file = parseCombinedOiDeleq(MANGLED_YEAR);
    assert.ok(file);
    assert.equal(file.rows.length, 0);
    assert.equal(file.reasons["bad-date"], 185);
    assert.equal(parseMwplDate("20-11-0018"), null);
  });

  it("dates the mis-keyed duplicate from its own cell, not its filename", () => {
    // `combineoi_deleq_12042023.csv` is a BYTE-FOR-BYTE duplicate of
    // `…_04122023.csv`: the archive holds one file under two keys. Reading the
    // ROW's own date lands it on 4 Dec where it belongs and makes the write
    // idempotent with the genuine object. No special case — the rule working.
    const file = parseCombinedOiDeleq(MISKEYED);
    assert.ok(file);
    assert.equal(file.rows.length, 184);
    assert.equal(file.tradingDate!.getTime(), Date.UTC(2023, 11, 4));
    assert.deepEqual(
      file.reasons,
      {},
      "it is internally consistent — mis-KEYED, not mis-dated",
    );
    assert.notEqual(
      file.tradingDate!.getTime(),
      Date.UTC(2023, 3, 12),
      "reading 04-12-2023 as 12 April is the MM-DD mistake this guards",
    );
  });
});

describe("toMwplDailyWrite drops the third measure", () => {
  it("has no column for contractDeltaOi and does not invent one", () => {
    const row = parseCombinedOiDeleq(QUOTED_7COL)!.rows[0]!;
    assert.ok(row.contractDeltaOi !== null, "the fixture must carry one");
    const write = toMwplDailyWrite(row);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(write, "contractDeltaOi"),
      "MwplDaily has no such column; it must not be smuggled in",
    );
    assert.equal(
      write.futEquivOi,
      row.futEquivOi,
      "and it must not be substituted for the portfolio-wise measure",
    );
    assert.equal(write.mwpl, null);
    assert.equal(write.utilisationPct, null);
    assert.equal(write.source, MWPL_SOURCE);
  });
});
