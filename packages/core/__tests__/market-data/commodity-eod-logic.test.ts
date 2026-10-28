/**
 * UNIT TEST — MCX + NCDEX commodity EOD bhavcopies (MONEY-1112, Data Engine P9 C3).
 *
 * Fixtures are REAL published bytes, not hand-built:
 *   __tests__/fixtures/mcx/mcx-bhavcopy-{2015-08-13,2020-08-13,2024-08-08,2026-08-11}.csv
 *   __tests__/fixtures/ncdex/ncdex-bhavcopy-2026-08-12-{provisional,final}.zip
 * so the space padding, the mislabelled volume column, the lowercase `mmBtu`
 * unit, the two-member ZIP and NCDEX's provisional/final revision pair are all
 * exercised exactly as they arrive.
 *
 * Eleven years of MCX is the point, not thoroughness theatre: the shape is
 * identical across all four files and the CONTENT is what moves, so a
 * single-year fixture would have "passed" against every trap below.
 *
 * Six cases carry most of the weight:
 *
 *   1. `the trading date is read from the row, not from any filename` — the
 *      2026 file arrived from MCX named "Bhavcopy Nov 8 2026.csv" while every
 *      row says 11 Aug 2026. Any parser that trusts a label transposes the day
 *      and the month.
 *   2. `Volume(In 000's) is not in thousands` — the column header is a lie,
 *      and obeying it overstates every commodity volume 1000×.
 *   3. `ALUMINI and ALUMINIUM are two contracts, not one renamed` — the
 *      "rename" reading motivates an alias table that would merge two live
 *      series and double-count them in three of the four years.
 *   4. `the NSE UDiFF parser silently returns zero rows for NCDEX` — the
 *      header is byte-identical so it does not throw; the vocabulary is
 *      disjoint so it maps nothing. This pins the shim so it cannot go quiet.
 *   5. `provisional and final are distinguishable, and the numbers differ` —
 *      817 settlement prices change between the two files for one day.
 *   6. `null, no-data and rows: [] are three different answers` — `[]` must
 *      never stand for both "no data" and "could not parse".
 *
 * Everything here is synchronous: no timers, no promises, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MCX_COLUMNS,
  MCX_INSTRUMENTS,
  NCDEX_INSTRUMENTS,
  UDIFF_COLUMNS,
  ncdexRevisionFromSessionId,
  parseMcxBhavcopy,
  parseMcxDate,
  parseMcxExpiry,
  parseMcxNoDataEnvelope,
  parseMcxVolumeCell,
  parseNcdexArchive,
  parseNcdexBhavcopy,
  parseUdiffDate,
  unzipEntries,
  type McxBhavcopyDay,
  type McxBhavcopyRow,
  type NcdexBhavcopyDay,
} from "../../src/market-data/commodity-eod-logic";
import { parseUdiffFoBhavcopy } from "../../src/market-data/bhavcopy-derivatives";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** MCX fixtures keyed by the trading day their FILENAME claims (ground truth). */
const MCX_DAYS = [
  "2015-08-13",
  "2020-08-13",
  "2024-08-08",
  "2026-08-11",
] as const;

type McxDay = (typeof MCX_DAYS)[number];

const MCX_CSV = Object.fromEntries(
  MCX_DAYS.map((d) => [
    d,
    readFileSync(join(FIXTURES, "mcx", `mcx-bhavcopy-${d}.csv`), "utf-8"),
  ]),
) as Record<McxDay, string>;

const NCDEX_ZIP: Record<"provisional" | "final", Buffer> = {
  provisional: readFileSync(
    join(FIXTURES, "ncdex", "ncdex-bhavcopy-2026-08-12-provisional.zip"),
  ),
  final: readFileSync(
    join(FIXTURES, "ncdex", "ncdex-bhavcopy-2026-08-12-final.zip"),
  ),
};

const NSE_UDIFF_CSV = readFileSync(
  join(FIXTURES, "fo_udiff_day.sample.csv"),
  "utf-8",
);

/** Narrow to the ok-shape or fail the test with the actual value. */
function okMcx(value: unknown): McxBhavcopyDay {
  assert.ok(value !== null, "expected a parsed file, got null");
  const file = value as { status: string };
  assert.equal(file.status, "ok", `expected status "ok", got ${file.status}`);
  return value as McxBhavcopyDay;
}

function okNcdex(value: unknown): NcdexBhavcopyDay {
  assert.ok(value !== null, "expected a parsed file, got null");
  const file = value as { status: string };
  assert.equal(file.status, "ok", `expected status "ok", got ${file.status}`);
  return value as NcdexBhavcopyDay;
}

const iso = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

/**
 * Assert a lookup found something, and narrow the type.
 *
 * `assert.ok` cannot narrow here — TypeScript only applies an assertion
 * signature when the call target is a plain identifier, and this file reaches
 * it through the default import (`assert.ok`). A helper keeps the tests
 * readable without sprinkling non-null assertions, which would turn a missing
 * fixture row into a confusing TypeError instead of a named failure.
 */
function must<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) assert.fail(message);
  return value;
}

/** The nth line of a text file, trimmed. */
function lineAt(text: string, n: number): string {
  return must(text.split(/\r?\n/)[n], `no line ${n}`).trim();
}

/** The named member of a ZIP, or a named failure. */
function zipMember(zip: Buffer, prefix: string) {
  const entries = must(unzipEntries(zip), "not a readable ZIP");
  return must(
    entries.find((e) => e.name.startsWith(prefix)),
    `no ZIP member starting with ${prefix}`,
  );
}

/** Build a synthetic MCX CSV from the real header plus the given data rows. */
function mcxCsv(rows: string[][], header: readonly string[] = MCX_COLUMNS) {
  const quote = (cells: readonly string[]) =>
    cells.map((c) => `"${c}"`).join(",");
  return [header.join(","), ...rows.map(quote)].join("\r\n") + "\r\n";
}

/** A well-formed MCX row; override individual cells by index. */
function mcxRow(overrides: Record<number, string> = {}): string[] {
  const base = [
    "11 Aug 2026", // 0  Date
    "FUTCOM", // 1  Instrument Name
    "ALUMINI      ", // 2  Symbol
    "31AUG2026", // 3  Expiry Date
    "-", // 4  Option Type
    "0", // 5  Strike Price
    "356.20", // 6  Open
    "359.80", // 7  High
    "355.25", // 8  Low
    "356.65", // 9  Close
    "356.10", // 10 Previous Close
    "4784", // 11 Volume(Lots)
    "4784.000 KGS  ", // 12 Volume(In 000's)
    "17108.05", // 13 Value(Lacs)
    "2305", // 14 Open Interest(Lots)
  ];
  for (const [i, v] of Object.entries(overrides)) base[Number(i)] = v;
  return base;
}

// ─────────────────────────────────────────────────────────────────────
describe("MCX — the four real files", () => {
  it("parses all four years with a stable 15-column header", () => {
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      assert.equal(file.exchange, "MCX");
      assert.ok(file.rows.length > 0, `${day} produced no rows`);
      assert.equal(file.mixedDates, false, `${day} has mixed dates`);
    }
  });

  it("emits the row counts the files actually contain", () => {
    const expected: Record<McxDay, number> = {
      "2015-08-13": 140,
      "2020-08-13": 4716,
      "2024-08-08": 6851,
      "2026-08-11": 16227,
    };
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      assert.equal(file.rows.length, expected[day], `row count for ${day}`);
    }
  });

  it("drops nothing from any real file", () => {
    // A non-zero drop on a known-good file means the guards are wrong, not the
    // data. This is the canary for every future change to the identity rules.
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      assert.deepEqual(
        file.dropped,
        { badDate: 0, badSymbol: 0, badExpiry: 0, badClose: 0 },
        `unexpected drops in ${day}`,
      );
    }
  });

  it("recognises every instrument code the four files use", () => {
    const seen = new Set<string>();
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      assert.deepEqual(
        file.unknownInstruments,
        {},
        `unknown instrument codes in ${day}`,
      );
      for (const r of file.rows) seen.add(r.instrument);
    }
    // The vocabulary GREW: 2015 is FUTCOM-only, 2026 adds index options.
    assert.deepEqual([...seen].sort(), [
      "FUTCOM",
      "FUTIDX",
      "OPTCOM",
      "OPTFUT",
      "OPTIDX",
    ]);
    for (const code of seen) assert.ok(MCX_INSTRUMENTS.includes(code));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("MCX — REGRESSION: the response date is never transposed", () => {
  it("reads the trading date from the row, matching the day each file is for", () => {
    // The filename is ground truth here only because we named the fixtures
    // from the request. The parser never sees it — it must arrive at the same
    // answer from the bytes alone.
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      assert.equal(iso(file.tradingDate), day, `trading date for ${day}`);
    }
  });

  it("does not reproduce MCX's own 'Bhavcopy Nov 8 2026' misreading", () => {
    // This is the bug in one assertion. MCX asked for 11/08/2026 (11 August,
    // DD/MM) and named its own download "Bhavcopy Nov 8 2026.csv" by
    // re-reading that request as MM/DD. Every row of the file says 11 Aug.
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2026-08-11"]));
    assert.equal(iso(file.tradingDate), "2026-08-11");
    assert.notEqual(
      iso(file.tradingDate),
      "2026-11-08",
      "day and month were transposed — this is the MONEY-1112 bug",
    );
    assert.equal(file.tradingDate?.getUTCMonth(), 7, "August is month index 7");
    assert.equal(file.tradingDate?.getUTCDate(), 11);
  });

  it("is pinned by a day-of-month that cannot be a month at all", () => {
    // 11/08 is ambiguous under a numeric reading; 13 is not. The 2015 and 2020
    // files are both the 13th, so no MM/DD reading of them can even produce a
    // valid date — the parse would have to fail rather than silently invert.
    for (const day of ["2015-08-13", "2020-08-13"] as const) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      assert.equal(iso(file.tradingDate), day);
      assert.equal(file.tradingDate?.getUTCDate(), 13);
      assert.equal(file.tradingDate?.getUTCMonth(), 7);
    }
  });

  it("refuses a numeric-month date outright instead of guessing", () => {
    // A numeric month is the one format where the transposition is
    // undetectable. If MCX ever starts sending it, this must fail loudly.
    assert.equal(parseMcxDate("11/08/2026"), null);
    assert.equal(parseMcxDate("08/11/2026"), null);
    assert.equal(parseMcxDate("2026-08-11"), null);
  });

  it("parses the published DD Mon YYYY form and rejects impossible days", () => {
    assert.equal(iso(parseMcxDate("11 Aug 2026")), "2026-08-11");
    assert.equal(iso(parseMcxDate("13 Aug 2015")), "2015-08-13");
    assert.equal(iso(parseMcxDate("1 Jan 2020")), "2020-01-01");
    assert.equal(iso(parseMcxDate("31 December 2024")), "2024-12-31");
    // Rolled-over dates are a wrong answer, which is worse than no answer.
    assert.equal(parseMcxDate("31 Feb 2026"), null);
    assert.equal(parseMcxDate("11 Xyz 2026"), null);
    assert.equal(parseMcxDate(""), null);
    assert.equal(parseMcxDate(null), null);
  });

  it("parses DDMONYYYY expiries and rejects rolled-over ones", () => {
    assert.equal(iso(parseMcxExpiry("31AUG2026")), "2026-08-31");
    assert.equal(iso(parseMcxExpiry("04DEC2020")), "2020-12-04");
    assert.equal(parseMcxExpiry("31FEB2026"), null);
    assert.equal(parseMcxExpiry("2026-08-31"), null);
  });

  it("carries a real expiry on every row of every file", () => {
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      for (const r of file.rows) {
        assert.ok(
          r.expiry instanceof Date && !Number.isNaN(r.expiry.getTime()),
        );
        assert.ok(
          r.expiry.getTime() >= r.tradingDate.getTime(),
          `${day} ${r.symbol}: expiry precedes its trading date`,
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("MCX — REGRESSION: Volume(In 000's) is not in thousands", () => {
  it("keeps 11,013 lots as 11,013 units, not 11,013,000", () => {
    // The 2015 ALUMINI August contract: Volume(Lots)=11013 and
    // Volume(In 000's)="11013.000 KGS". Same number. Obeying the header would
    // report eleven million.
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2015-08-13"]));
    const row = file.rows.find(
      (r) => r.symbol === "ALUMINI" && iso(r.expiry) === "2015-08-31",
    );
    assert.ok(row, "ALUMINI 31AUG2015 missing");
    assert.equal(row.volumeLots, 11013);
    assert.equal(row.volumeQuantity, 11013);
    assert.notEqual(
      row.volumeQuantity,
      11_013_000,
      "volume was multiplied by 1000 — this is the MONEY-1112 bug",
    );
    assert.equal(row.volumeUnit, "KGS");
  });

  it("tracks the contract's real lot size rather than a fixed multiplier", () => {
    // 2020 ALUMINIUM: 2,322 lots → 11,610 units. That is ×5 (the lot size),
    // and it is NOT ×1000. Both columns are independent readings, so both are
    // kept — a single "volume" field would have to pick one and be wrong.
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2020-08-13"]));
    const row = file.rows.find(
      (r) => r.symbol === "ALUMINIUM" && iso(r.expiry) === "2020-08-31",
    );
    assert.ok(row, "ALUMINIUM 31AUG2020 missing");
    assert.equal(row.volumeLots, 2322);
    assert.equal(row.volumeQuantity, 11610);
    assert.equal(row.volumeQuantity, row.volumeLots * 5);
    assert.notEqual(row.volumeQuantity, 2_322_000);
  });

  it("never leaves the ×1000 reading available anywhere in a real file", () => {
    // Blanket check: if the column really were thousands, quantity/lots would
    // sit near 1000 for some contract. Across 27,000 rows it never does.
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      for (const r of file.rows) {
        if (!r.volumeLots || !r.volumeQuantity) continue;
        const ratio = r.volumeQuantity / r.volumeLots;
        assert.ok(
          ratio < 1000,
          `${day} ${r.symbol}: qty/lots = ${ratio}, which looks like a ×1000 unit`,
        );
      }
    }
  });

  it("splits the unit suffix, including the lowercase-led mmBtu", () => {
    assert.deepEqual(parseMcxVolumeCell("11013.000 KGS  "), {
      quantity: 11013,
      unit: "KGS",
    });
    // An [A-Z ]+ unit pattern drops every natural-gas row silently.
    assert.deepEqual(parseMcxVolumeCell("157200.000 mmBtu"), {
      quantity: 157200,
      unit: "mmBtu",
    });
    assert.deepEqual(parseMcxVolumeCell("0.000 UNIT "), {
      quantity: 0,
      unit: "UNIT",
    });
    // A bare number is still usable — the quantity is the load-bearing half.
    assert.deepEqual(parseMcxVolumeCell("42"), { quantity: 42, unit: null });
    assert.equal(parseMcxVolumeCell(""), null);
    assert.equal(parseMcxVolumeCell("KGS"), null);
    assert.equal(parseMcxVolumeCell(null), null);
  });

  it("reads every unit the four files use, mmBtu included", () => {
    const units = new Set<string>();
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      for (const r of file.rows) if (r.volumeUnit) units.add(r.volumeUnit);
    }
    assert.deepEqual([...units].sort(), [
      "BALES",
      "BBL",
      "CANDY",
      "GRMS",
      "KGS",
      "MT",
      "MWH",
      "UNIT",
      "mmBtu",
    ]);
    // Case is preserved verbatim: normalising would invent a second spelling.
    assert.ok(units.has("mmBtu"));
    assert.ok(!units.has("MMBTU"));
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("MCX — REGRESSION: ALUMINI/ALUMINIUM is a listing gap, not a rename", () => {
  it("shows both contracts trading side by side in three of four years", () => {
    // The reported trap was a cross-year RENAME. It is not one: both symbols
    // are present, on the same day, in 2015, 2024 and 2026. Folding them
    // together with an alias table would merge two live contracts and
    // double-count their volume and open interest.
    const counts: Partial<Record<McxDay, { mini: number; full: number }>> = {};
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      counts[day] = {
        mini: file.rows.filter((r) => r.symbol === "ALUMINI").length,
        full: file.rows.filter((r) => r.symbol === "ALUMINIUM").length,
      };
    }
    assert.deepEqual(counts, {
      "2015-08-13": { mini: 5, full: 5 },
      // The mini simply was not listed on this day. That is the whole anomaly.
      "2020-08-13": { mini: 0, full: 5 },
      "2024-08-08": { mini: 5, full: 5 },
      "2026-08-11": { mini: 5, full: 5 },
    });
  });

  it("surfaces the day's symbols so a caller can see one disappear", () => {
    const y2015 = okMcx(parseMcxBhavcopy(MCX_CSV["2015-08-13"]));
    const y2020 = okMcx(parseMcxBhavcopy(MCX_CSV["2020-08-13"]));
    const y2026 = okMcx(parseMcxBhavcopy(MCX_CSV["2026-08-11"]));

    assert.ok(y2015.symbols.includes("ALUMINI"));
    assert.ok(y2015.symbols.includes("ALUMINIUM"));
    assert.ok(
      !y2020.symbols.includes("ALUMINI"),
      "2020-08-13 did not list the mini contract",
    );
    assert.ok(y2020.symbols.includes("ALUMINIUM"));
    assert.ok(y2026.symbols.includes("ALUMINI"));

    // Surfaced, not papered over: the parser applies no alias table, so the
    // two symbols stay distinct all the way to the caller.
    assert.deepEqual(
      y2026.symbols.filter((s) => s.startsWith("ALUMIN")),
      ["ALUMINI", "ALUMINIUM"],
    );
  });

  it("trims the space padding but keeps the raw symbol", () => {
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2026-08-11"]));
    const row = file.rows.find((r) => r.symbol === "ALUMINI");
    assert.ok(row);
    assert.equal(row.symbol, "ALUMINI");
    assert.equal(row.rawSymbol, "ALUMINI      ");
    assert.notEqual(row.symbol, row.rawSymbol);
    // No trimmed symbol anywhere retains padding — the join key is clean.
    for (const r of file.rows) assert.equal(r.symbol, r.symbol.trim());
  });

  it("keeps symbols distinct that differ only by their padded width", () => {
    // "ALUMINI      " and "ALUMINIUM    " are the same padded width; only
    // trimming separates them. A width-based slice would merge them.
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2026-08-11"]));
    const mini = file.rows.filter((r) => r.symbol === "ALUMINI");
    const full = file.rows.filter((r) => r.symbol === "ALUMINIUM");
    assert.equal(mini.length, 5);
    assert.equal(full.length, 5);
    assert.equal(
      must(mini[0], "no ALUMINI row").rawSymbol.length,
      must(full[0], "no ALUMINIUM row").rawSymbol.length,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("MCX — non-finite cells are dropped or nulled, never zeroed", () => {
  it("nulls a blank O/H/L instead of zeroing or close-filling it", () => {
    // 15,276 of the 2026 file's 16,227 rows have blank O/H/L: on MCX that
    // means "this contract did not trade" while Close still carries the
    // settlement forward. Zeroing invents a 0-to-close bar; close-filling
    // (what the NSE sibling does) invents a flat trade. Both would fire on
    // 94% of a day's contracts.
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2026-08-11"]));
    const untraded = file.rows.filter((r) => r.open === null);
    assert.equal(untraded.length, 15276);
    for (const r of untraded) {
      assert.equal(r.open, null);
      assert.equal(r.high, null);
      assert.equal(r.low, null);
      assert.notEqual(r.open, 0);
      assert.notEqual(r.open, r.close);
      // The close survives — it is the settlement price, and it is real.
      assert.ok(Number.isFinite(r.close));
    }
  });

  it("keeps a genuine zero volume as zero", () => {
    // The nulling rule is about blanks, not about the number 0. An untraded
    // contract really did trade zero lots, and that is a true statement.
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2026-08-11"]));
    const idle = file.rows.find((r) => r.open === null && r.volumeLots === 0);
    assert.ok(idle, "expected an untraded contract with 0 lots");
    assert.equal(idle.volumeLots, 0);
    assert.equal(idle.volumeQuantity, 0);
  });

  it("drops and COUNTS a row whose close is not a finite number", () => {
    const csv = mcxCsv([
      mcxRow(),
      mcxRow({ 2: "COPPER       ", 9: "" }),
      mcxRow({ 2: "GOLD         ", 9: "abc" }),
      mcxRow({ 2: "SILVER       ", 9: "Infinity" }),
      mcxRow({ 2: "ZINC         ", 9: "NaN" }),
    ]);
    const file = okMcx(parseMcxBhavcopy(csv));
    assert.equal(file.rows.length, 1, "only the well-formed row survives");
    assert.equal(file.dropped.badClose, 4);
    // Reported, not silent — and never a zero-priced row.
    assert.ok(!file.rows.some((r) => r.close === 0));
    assert.deepEqual(file.symbols, ["ALUMINI"]);
  });

  it("drops and counts rows with an unusable date, symbol or expiry", () => {
    const csv = mcxCsv([
      mcxRow(),
      mcxRow({ 0: "31 Feb 2026" }), // rolled-over date
      mcxRow({ 0: "11/08/2026" }), // numeric month
      mcxRow({ 2: "     " }), // symbol is padding only
      mcxRow({ 3: "31FEB2026" }), // rolled-over expiry
      mcxRow({ 3: "" }), // no expiry
    ]);
    const file = okMcx(parseMcxBhavcopy(csv));
    assert.equal(file.rows.length, 1);
    assert.deepEqual(file.dropped, {
      badDate: 2,
      badSymbol: 1,
      badExpiry: 2,
      badClose: 0,
    });
  });

  it("nulls a garbled measure without dropping the row", () => {
    // The close is intact, so the row is still a usable bar. Only the bad
    // cells go to null — losing the whole row would be an overreaction.
    const csv = mcxCsv([
      mcxRow({ 6: "abc", 11: "", 13: "NaN", 14: "-", 12: "not-a-number" }),
    ]);
    const file = okMcx(parseMcxBhavcopy(csv));
    assert.equal(file.rows.length, 1);
    const row = must(file.rows[0], "the well-formed row was dropped");
    assert.equal(row.open, null);
    assert.equal(row.volumeLots, null);
    assert.equal(row.valueLakh, null);
    assert.equal(row.openInterestLots, null);
    assert.equal(row.volumeQuantity, null);
    assert.equal(row.volumeUnit, null);
    assert.equal(row.close, 356.65);
    // Not one of them became 0.
    for (const v of [
      row.open,
      row.volumeLots,
      row.valueLakh,
      row.openInterestLots,
      row.volumeQuantity,
    ]) {
      assert.notEqual(v, 0);
    }
  });

  it("counts an unfamiliar instrument code instead of dropping it silently", () => {
    const csv = mcxCsv([mcxRow(), mcxRow({ 1: "FUTNEWTHING" })]);
    const file = okMcx(parseMcxBhavcopy(csv));
    assert.equal(
      file.rows.length,
      2,
      "the row is kept — MCX may list new products",
    );
    assert.deepEqual(file.unknownInstruments, { FUTNEWTHING: 1 });
    assert.equal(must(file.rows[1], "row 2 missing").instrument, "FUTNEWTHING");
  });

  it("flags a file whose rows disagree about the trading date", () => {
    const csv = mcxCsv([mcxRow(), mcxRow({ 0: "12 Aug 2026" })]);
    const file = okMcx(parseMcxBhavcopy(csv));
    assert.equal(file.mixedDates, true);
    assert.equal(file.rows.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("MCX — futures, options and the zero-strike sentinel", () => {
  it("gives futures a null option type and a null strike", () => {
    // MCX publishes a literal 0 strike on every future. Storing it would let a
    // downstream read it as "struck at zero", which is a very different thing.
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2026-08-11"]));
    const futures = file.rows.filter((r) => r.instrument === "FUTCOM");
    assert.ok(futures.length > 0);
    for (const r of futures) {
      assert.equal(r.optionType, null);
      assert.equal(r.strike, null);
    }
  });

  it("gives options a CE/PE type and a real strike", () => {
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2026-08-11"]));
    const options = file.rows.filter((r) => r.instrument === "OPTFUT");
    assert.ok(options.length > 0);
    for (const r of options) {
      assert.ok(r.optionType === "CE" || r.optionType === "PE");
      assert.ok(
        r.strike !== null && Number.isFinite(r.strike) && r.strike > 0,
        `${r.symbol}: option without a usable strike`,
      );
    }
    const call = options.find(
      (r) => r.symbol === "COPPER" && r.optionType === "CE",
    );
    assert.ok(call);
    assert.equal(call.strike, 1290);
    assert.equal(call.close, 86.95);
  });

  it("counts calls and puts symmetrically across the option files", () => {
    const expected: Record<McxDay, number> = {
      "2015-08-13": 0,
      "2020-08-13": 2309,
      "2024-08-08": 3367,
      "2026-08-11": 8038,
    };
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      const ce = file.rows.filter((r) => r.optionType === "CE").length;
      const pe = file.rows.filter((r) => r.optionType === "PE").length;
      assert.equal(ce, expected[day], `CE count for ${day}`);
      assert.equal(pe, expected[day], `PE count for ${day}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("MCX — null, no-data and an empty day are three answers", () => {
  it("returns a distinct no-data value for MCX's 200-with-JSON holiday", () => {
    const file = parseMcxBhavcopy(
      '{"IsSuccess":false,"Message":"No data found."}',
    );
    assert.ok(file !== null, "a holiday is not a parse failure");
    assert.equal(file.status, "no-data");
    assert.equal(
      file.status === "no-data" ? file.message : null,
      "No data found.",
    );
  });

  it("matches the envelope structurally, not by its message text", () => {
    // Only IsSuccess:false is a contract; the wording is not.
    assert.equal(
      parseMcxNoDataEnvelope('{"IsSuccess":false}'),
      "No data found.",
    );
    assert.equal(
      parseMcxNoDataEnvelope('{"IsSuccess":false,"Message":"Holiday"}'),
      "Holiday",
    );
    // A successful envelope is not a no-data answer.
    assert.equal(parseMcxNoDataEnvelope('{"IsSuccess":true,"Data":[]}'), null);
    assert.equal(parseMcxNoDataEnvelope("Date,Instrument Name,Symbol"), null);
    assert.equal(parseMcxNoDataEnvelope("{not json"), null);
    assert.equal(parseMcxNoDataEnvelope(""), null);
  });

  it("returns rows: [] — not null, not no-data — for a header-only file", () => {
    // Structurally a bhavcopy, substantively alarming. The caller alerts on
    // this; it retries null; it records no-data as a non-trading day.
    const file = okMcx(parseMcxBhavcopy(mcxCsv([])));
    assert.deepEqual(file.rows, []);
    assert.equal(file.tradingDate, null);
    assert.deepEqual(file.symbols, []);
    assert.equal(file.mixedDates, false);
  });

  it("returns null — never [] — for anything that is not a bhavcopy", () => {
    assert.equal(
      parseMcxBhavcopy("<html><body>403 Forbidden</body></html>"),
      null,
    );
    assert.equal(parseMcxBhavcopy(""), null);
    assert.equal(parseMcxBhavcopy("   \n  \n"), null);
    assert.equal(parseMcxBhavcopy("a,b,c\n1,2,3"), null);
    // A JSON body that is NOT the no-data envelope is also not a bhavcopy.
    assert.equal(parseMcxBhavcopy('{"IsSuccess":true,"Data":[]}'), null);
    // One missing column means our mapping would be guessing.
    const short = MCX_COLUMNS.filter((c) => c !== "Close");
    assert.equal(
      parseMcxBhavcopy(mcxCsv([mcxRow().slice(0, 14)], short)),
      null,
    );
  });

  it("survives an EXTRA column — additive change is not a failure", () => {
    const wide = [...MCX_COLUMNS, "Something New"];
    const file = okMcx(parseMcxBhavcopy(mcxCsv([[...mcxRow(), "x"]], wide)));
    assert.equal(file.rows.length, 1);
    assert.equal(must(file.rows[0], "row 1 missing").symbol, "ALUMINI");
  });

  it("tolerates a UTF-8 BOM on the header", () => {
    const file = okMcx(parseMcxBhavcopy("﻿" + mcxCsv([mcxRow()])));
    assert.equal(file.rows.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("UDiFF — the byte-identical header claim, machine-checked", () => {
  it("proves NSE and NCDEX ship the SAME 34-column header", () => {
    // The verdict this module rests on. Asserted against both committed
    // fixtures so that the day either exchange moves, this test names it.
    const ncdex = zipMember(NCDEX_ZIP.final, "BhavCopy_NCD");
    const nseHeader = lineAt(NSE_UDIFF_CSV, 0);
    const ncdexHeader = lineAt(ncdex.bytes.toString("utf-8"), 0);

    assert.equal(
      ncdexHeader,
      nseHeader,
      "NSE and NCDEX UDiFF headers have diverged",
    );
    assert.equal(nseHeader, UDIFF_COLUMNS.join(","));
    assert.equal(UDIFF_COLUMNS.length, 34);
    // Including the published format's own lowercase-i typo.
    assert.ok(UDIFF_COLUMNS.includes("FininstrmActlXpryDt"));
  });

  it("parses UDiFF's YYYY-MM-DD dates and rejects rolled-over ones", () => {
    assert.equal(iso(parseUdiffDate("2026-08-12")), "2026-08-12");
    assert.equal(parseUdiffDate("2026-02-31"), null);
    assert.equal(parseUdiffDate("12-08-2026"), null);
    assert.equal(parseUdiffDate(""), null);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("NCDEX — the shim: identical header, disjoint vocabulary", () => {
  it("shows the NSE F&O parser returning ZERO rows on NCDEX bytes, silently", () => {
    // This is the whole reason a separate row mapper exists. Because the
    // header is byte-identical, parseUdiffFoBhavcopy does not throw and does
    // not return null — it maps nothing and reports a structurally successful
    // parse of an empty day, which is indistinguishable from a holiday at the
    // call site. Pinned here so the shim can never go quiet.
    const udiffMember = zipMember(NCDEX_ZIP.final, "BhavCopy_NCD");
    const viaNse = parseUdiffFoBhavcopy(
      udiffMember.bytes.toString("utf-8"),
      "NSE",
      new Date(Date.UTC(2026, 7, 12)),
    );
    assert.deepEqual(viaNse.rows, [], "the NSE parser must map nothing here");
    assert.equal(viaNse.skipped, 0, "it does not even record them as skipped");
    assert.deepEqual(viaNse.skippedByType, { COF: 113, FUO: 1600 });

    // And the shim recovers every one of those 1,713 rows.
    const viaShim = okNcdex(parseNcdexArchive(NCDEX_ZIP.final));
    assert.equal(viaShim.rows.length, 1713);
    assert.equal(
      viaShim.rows.length,
      viaNse.skippedByType.COF + viaNse.skippedByType.FUO,
    );
  });

  it("has an EMPTY intersection with NSE's instrument vocabulary", () => {
    const ncdex = Object.keys(NCDEX_INSTRUMENTS);
    const nse = ["IDF", "IDO", "STF", "STO"];
    assert.deepEqual(ncdex.sort(), ["COF", "FUO"]);
    assert.deepEqual(
      ncdex.filter((c) => nse.includes(c)),
      [],
      "the disjointness is the shim",
    );
    // FUO is an option ON A FUTURE — MCX's own code for the same instrument,
    // reused rather than given a synonym.
    assert.equal(NCDEX_INSTRUMENTS.FUO, "OPTFUT");
    assert.equal(NCDEX_INSTRUMENTS.COF, "FUTCOM");
    assert.ok(MCX_INSTRUMENTS.includes(NCDEX_INSTRUMENTS.FUO));
    assert.ok(MCX_INSTRUMENTS.includes(NCDEX_INSTRUMENTS.COF));
  });

  it("uses NCDEX's own segment and source values, not NSE's", () => {
    const csv = zipMember(NCDEX_ZIP.final, "BhavCopy_NCD").bytes.toString(
      "utf-8",
    );
    const firstRow = lineAt(csv, 1).split(",");
    assert.equal(firstRow[2], "CO", "Sgmt is CO (commodity), not FO");
    assert.equal(firstRow[3], "NCD", "Src is NCD, not NSE");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("NCDEX — provisional and final are the same day, twice", () => {
  it("parses both revisions of 2026-08-12 to the same 1,713 contracts", () => {
    for (const rev of ["provisional", "final"] as const) {
      const file = okNcdex(parseNcdexArchive(NCDEX_ZIP[rev]));
      assert.equal(file.exchange, "NCDEX");
      assert.equal(file.rows.length, 1713);
      assert.equal(iso(file.tradingDate), "2026-08-12");
      assert.equal(file.mixedDates, false);
      assert.equal(file.mixedRevisions, false);
      assert.deepEqual(file.dropped, {
        badDate: 0,
        badSymbol: 0,
        badExpiry: 0,
        badClose: 0,
        unknownInstrumentType: {},
      });
    }
  });

  it("distinguishes them from CONTENT (SsnId), never from the filename", () => {
    // The filename's _P_ / _F_ token does not survive re-archiving under our
    // own feed-archive key. SsnId does.
    const prov = okNcdex(parseNcdexArchive(NCDEX_ZIP.provisional));
    const fin = okNcdex(parseNcdexArchive(NCDEX_ZIP.final));
    assert.equal(prov.revision, "provisional");
    assert.equal(fin.revision, "final");
    assert.notEqual(prov.revision, fin.revision);
    for (const r of prov.rows) assert.equal(r.revision, "provisional");
    for (const r of fin.rows) assert.equal(r.revision, "final");

    // Parsing the member CSV alone — no filename in sight — agrees.
    const bytes = zipMember(NCDEX_ZIP.provisional, "BhavCopy_NCD").bytes;
    assert.equal(
      okNcdex(parseNcdexBhavcopy(bytes.toString("utf-8"))).revision,
      "provisional",
    );
  });

  it("maps the session codes and refuses to guess an unknown one", () => {
    assert.equal(ncdexRevisionFromSessionId("I1"), "provisional");
    assert.equal(ncdexRevisionFromSessionId("F1"), "final");
    assert.equal(ncdexRevisionFromSessionId("i1"), "provisional");
    // Guessing "final" here would let unrevised numbers become permanent.
    assert.equal(ncdexRevisionFromSessionId("X9"), "unknown");
    assert.equal(ncdexRevisionFromSessionId(""), "unknown");
    assert.equal(ncdexRevisionFromSessionId(null), "unknown");
  });

  it("carries genuinely different numbers where the revision changed them", () => {
    // The revision is not cosmetic. Same contract id, different settlement.
    const prov = okNcdex(parseNcdexArchive(NCDEX_ZIP.provisional));
    const fin = okNcdex(parseNcdexArchive(NCDEX_ZIP.final));

    const byId = (d: NcdexBhavcopyDay, id: string) => {
      const r = d.rows.find((x) => x.instrumentId === id);
      assert.ok(r, `contract ${id} missing`);
      return r;
    };

    // BAJRA 20AUG2026: settlement and close both revised upward.
    const bajraP = byId(prov, "80888");
    const bajraF = byId(fin, "80888");
    assert.equal(bajraP.symbol, "BAJRA");
    assert.equal(bajraP.settlePrice, 2285);
    assert.equal(bajraF.settlePrice, 2287);
    assert.equal(bajraP.close, 2285);
    assert.equal(bajraF.close, 2287);
    assert.notEqual(bajraP.settlePrice, bajraF.settlePrice);

    // RAINMUMBAI 81777: volume, open interest and turnover all restated.
    const rainP = byId(prov, "81777");
    const rainF = byId(fin, "81777");
    assert.equal(rainP.volume, 322);
    assert.equal(rainF.volume, 388);
    assert.equal(rainP.openInterest, 124);
    assert.equal(rainF.openInterest, 133);
    assert.equal(rainP.lastPrice, 2403);
    assert.equal(rainF.lastPrice, 2381);
    assert.notEqual(rainP.turnoverRupees, rainF.turnoverRupees);
  });

  it("revises the SAME contract set — so a revision is an update, not a reload", () => {
    const prov = okNcdex(parseNcdexArchive(NCDEX_ZIP.provisional));
    const fin = okNcdex(parseNcdexArchive(NCDEX_ZIP.final));
    const ids = (d: NcdexBhavcopyDay) =>
      d.rows.map((r) => r.instrumentId).sort();
    assert.deepEqual(ids(prov), ids(fin));
    assert.deepEqual(prov.symbols, fin.symbols);
    assert.equal(prov.symbols.length, 24);
  });

  it("counts how many rows the revision actually moved", () => {
    // Documents the blast radius: treating provisional as final locks in 817
    // wrong settlement prices for one ordinary day.
    const prov = okNcdex(parseNcdexArchive(NCDEX_ZIP.provisional));
    const fin = okNcdex(parseNcdexArchive(NCDEX_ZIP.final));
    const finById = new Map(fin.rows.map((r) => [r.instrumentId, r]));

    let settle = 0;
    let close = 0;
    for (const p of prov.rows) {
      const f = finById.get(p.instrumentId)!;
      if (p.settlePrice !== f.settlePrice) settle++;
      if (p.close !== f.close) close++;
    }
    assert.equal(settle, 817);
    assert.equal(close, 515);
  });

  it("flags a file whose rows disagree about the revision", () => {
    const csv = zipMember(NCDEX_ZIP.final, "BhavCopy_NCD").bytes.toString(
      "utf-8",
    );
    const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
    // Flip one row's SsnId from F1 to I1.
    const cells = must(lines[1], "no data row").split(",");
    cells[27] = "I1";
    const mixed = [lines[0], cells.join(","), ...lines.slice(2)].join("\n");

    const file = okNcdex(parseNcdexBhavcopy(mixed));
    assert.equal(file.mixedRevisions, true);
    assert.equal(
      file.revision,
      "unknown",
      "a file we cannot classify must not claim a revision",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("NCDEX — rows, guards and the null contract", () => {
  it("reads a traded contract's full bar", () => {
    const file = okNcdex(parseNcdexArchive(NCDEX_ZIP.provisional));
    const castor = file.rows.find((r) => r.contractName === "CASTOR20AUG2026");
    assert.ok(castor);
    assert.equal(castor.symbol, "CASTOR");
    assert.equal(castor.instrument, "FUTCOM");
    assert.equal(castor.rawInstrumentType, "COF");
    assert.equal(iso(castor.expiry), "2026-08-20");
    assert.equal(castor.optionType, null);
    assert.equal(castor.strike, null);
    assert.equal(castor.open, 7160);
    assert.equal(castor.high, 7164);
    assert.equal(castor.low, 7092);
    assert.equal(castor.close, 7098);
    assert.equal(castor.settlePrice, 7098);
    assert.equal(castor.underlyingPrice, 7163.15);
    // OpnIntrst (5480) precedes TtlTradgVol (2880) in UDiFF column order, and
    // the two are easy to transpose by eye — this pins the mapping by name.
    assert.equal(castor.openInterest, 5480);
    assert.equal(castor.openInterestChange, -1720);
    assert.equal(castor.volume, 2880);
    // Turnover is RUPEES here, not lakhs — the UDiFF column's own unit.
    assert.equal(castor.turnoverRupees, 205288550);
    assert.equal(castor.tradeCount, 270);
    assert.equal(castor.boardLotQuantity, 5);
  });

  it("nulls the 0.00 O/H/L of a contract that did not trade", () => {
    // NCDEX sends a literal 0.00 rather than a blank, but 0 is still not a
    // price at which anything changed hands.
    const file = okNcdex(parseNcdexArchive(NCDEX_ZIP.provisional));
    const bajra = file.rows.find((r) => r.contractName === "BAJRA20AUG2026");
    assert.ok(bajra);
    assert.equal(bajra.open, null);
    assert.equal(bajra.high, null);
    assert.equal(bajra.low, null);
    assert.equal(bajra.lastPrice, null);
    // The settlement close is real and survives.
    assert.equal(bajra.close, 2285);
    // A true zero volume stays zero — that IS what happened.
    assert.equal(bajra.volume, 0);
    assert.equal(bajra.openInterest, 0);
  });

  it("reads options with a CE/PE type and a real strike", () => {
    const file = okNcdex(parseNcdexArchive(NCDEX_ZIP.final));
    const options = file.rows.filter((r) => r.instrument === "OPTFUT");
    assert.equal(options.length, 1600);
    for (const r of options) {
      assert.ok(r.optionType === "CE" || r.optionType === "PE");
      assert.ok(r.strike !== null && Number.isFinite(r.strike));
    }
    const futures = file.rows.filter((r) => r.instrument === "FUTCOM");
    assert.equal(futures.length, 113);
    for (const r of futures) {
      assert.equal(r.optionType, null);
      assert.equal(r.strike, null);
    }
  });

  it("counts an unmapped instrument code instead of dropping it silently", () => {
    const header = UDIFF_COLUMNS.join(",");
    const row = (tp: string) =>
      [
        "2026-08-12",
        "2026-08-12",
        "CO",
        "NCD",
        tp,
        "99999",
        "",
        "TESTSYM",
        "",
        "2026-08-20",
        "2026-08-20",
        "",
        "",
        "TESTSYM20AUG2026",
        "1",
        "2",
        "0.5",
        "1.5",
        "1.5",
        "1.4",
        "1.45",
        "1.5",
        "10",
        "1",
        "100",
        "150.00",
        "3",
        "F1",
        "5",
        "",
        "",
        "",
        "",
        "",
      ].join(",");
    const file = okNcdex(
      parseNcdexBhavcopy([header, row("COF"), row("ZZZ"), row("")].join("\n")),
    );
    assert.equal(file.rows.length, 1);
    assert.deepEqual(file.dropped.unknownInstrumentType, {
      ZZZ: 1,
      "(blank)": 1,
    });
  });

  it("returns null — never [] — for anything that is not a UDiFF bhavcopy", () => {
    assert.equal(parseNcdexBhavcopy("<html>challenge</html>"), null);
    assert.equal(parseNcdexBhavcopy(""), null);
    assert.equal(parseNcdexBhavcopy("a,b,c\n1,2,3"), null);
    // The MCX bhavcopy is a valid CSV — and still not this report.
    assert.equal(parseNcdexBhavcopy(MCX_CSV["2026-08-11"]), null);
    // One missing UDiFF column.
    const short = UDIFF_COLUMNS.filter((c) => c !== "ClsPric").join(",");
    assert.equal(parseNcdexBhavcopy(short + "\n" + short), null);
  });

  it("returns rows: [] for a header-only UDiFF file", () => {
    const file = okNcdex(parseNcdexBhavcopy(UDIFF_COLUMNS.join(",") + "\n"));
    assert.deepEqual(file.rows, []);
    assert.equal(file.tradingDate, null);
    assert.equal(file.revision, "unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("ZIP — two members, selected by name", () => {
  it("returns BOTH members of a real NCDEX archive", () => {
    // unzipSingleEntry in bhavcopy.ts reads only member #0 and documents why
    // ("the NSE file is always exactly one entry"). NCDEX ships two.
    for (const rev of ["provisional", "final"] as const) {
      const entries = unzipEntries(NCDEX_ZIP[rev]);
      assert.ok(entries);
      assert.equal(entries.length, 2);
      const names = entries.map((e) => e.name);
      assert.ok(names.some((n) => n.startsWith("BhavCopy_NCD_CO_")));
      assert.ok(names.some((n) => n.startsWith("FO_120826_")));
    }
  });

  it("selects the UDiFF member by NAME, not by position", () => {
    // Both fixtures happen to put the UDiFF member first, which is exactly
    // why position must not be the selector.
    const entries = unzipEntries(NCDEX_ZIP.final)!;
    const udiff = entries.find((e) => e.name.startsWith("BhavCopy_NCD"))!;
    const legacy = entries.find((e) => e.name.startsWith("FO_"))!;

    const udiffHeader = lineAt(udiff.bytes.toString("utf-8"), 0);
    const legacyHeader = lineAt(legacy.bytes.toString("utf-8"), 0);
    assert.equal(udiffHeader, UDIFF_COLUMNS.join(","));
    assert.ok(
      legacyHeader.startsWith('"Instrument Type"'),
      "the legacy member is a different 19-column format",
    );
    // Parsing the legacy member as UDiFF is a null, not a wrong answer.
    assert.equal(parseNcdexBhavcopy(legacy.bytes.toString("utf-8")), null);
  });

  it("shows the LEGACY member's header changing between revisions of one day", () => {
    // The clincher for preferring the UDiFF member. Same trading day, same
    // 19 columns, same 1,714 lines — and NCDEX respells the entire header
    // between the evening file and the post-midnight one:
    //
    //   provisional  "INSTRUMENT_TYPE","SYMBOL",…,"HIGH_PRCE",…,"OPEN_INTREST(IN QUANTITY)"
    //   final        "Instrument Type","Symbol",…,"High Price",…,"Open Interest"
    //
    // Different casing, different word separators, and two typos that exist
    // in one revision only. A parser keyed on the legacy header works on
    // exactly one of the two files per day and returns nothing for the other
    // — silently, since both are valid CSV. The UDiFF member has no such
    // problem: byte-identical across both revisions AND across exchanges.
    const legacyHeader = (buf: Buffer) =>
      lineAt(zipMember(buf, "FO_").bytes.toString("utf-8"), 0);
    const udiffHeader = (buf: Buffer) =>
      lineAt(zipMember(buf, "BhavCopy_NCD").bytes.toString("utf-8"), 0);

    const legacyProv = legacyHeader(NCDEX_ZIP.provisional);
    const legacyFinal = legacyHeader(NCDEX_ZIP.final);
    assert.notEqual(
      legacyProv,
      legacyFinal,
      "if these ever match, the legacy member became usable",
    );
    assert.ok(legacyProv.startsWith('"INSTRUMENT_TYPE"'));
    assert.ok(legacyFinal.startsWith('"Instrument Type"'));
    assert.ok(legacyProv.includes('"HIGH_PRCE"'), "typo present only in P");
    assert.ok(legacyFinal.includes('"High Price"'));

    // Meanwhile the member we actually parse is byte-stable across revisions.
    assert.equal(
      udiffHeader(NCDEX_ZIP.provisional),
      udiffHeader(NCDEX_ZIP.final),
    );
    assert.equal(udiffHeader(NCDEX_ZIP.provisional), UDIFF_COLUMNS.join(","));
  });

  it("returns Buffer, so a non-text member is not corrupted by decoding", () => {
    const entries = unzipEntries(NCDEX_ZIP.final)!;
    for (const e of entries) assert.ok(Buffer.isBuffer(e.bytes));
    // Inflated to the exact published length.
    const udiff = entries.find((e) => e.name.startsWith("BhavCopy_NCD"))!;
    assert.equal(udiff.bytes.length, 319838);
  });

  it("returns null for bytes that are not a ZIP we can read", () => {
    assert.equal(unzipEntries(Buffer.from("not a zip at all")), null);
    assert.equal(unzipEntries(Buffer.alloc(0)), null);
    // Right signature, truncated body.
    assert.equal(unzipEntries(Buffer.from("PK\x03\x04")), null);
    assert.equal(
      parseNcdexArchive(Buffer.from("<html>challenge</html>")),
      null,
    );
  });

  it("returns null when the archive holds no UDiFF member", () => {
    // A STORED single-member ZIP built by hand — no dependency, no fixture.
    const name = Buffer.from("README.txt");
    const body = Buffer.from("nothing to see");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(0, 8); // STORED
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    const zip = Buffer.concat([header, name, body]);

    const entries = unzipEntries(zip);
    assert.ok(entries);
    assert.equal(entries.length, 1);
    const only = must(entries[0], "no member");
    assert.equal(only.name, "README.txt");
    assert.equal(only.bytes.toString("utf-8"), "nothing to see");
    // …but it is not an NCDEX bhavcopy.
    assert.equal(parseNcdexArchive(zip), null);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe("purity — no I/O, no clock, no mutation", () => {
  it("returns equal results for repeated parses of the same bytes", () => {
    const a = okMcx(parseMcxBhavcopy(MCX_CSV["2024-08-08"]));
    const b = okMcx(parseMcxBhavcopy(MCX_CSV["2024-08-08"]));
    assert.deepEqual(a, b);

    const p = okNcdex(parseNcdexArchive(NCDEX_ZIP.final));
    const q = okNcdex(parseNcdexArchive(NCDEX_ZIP.final));
    assert.deepEqual(p, q);
  });

  it("does not mutate its input", () => {
    const before = Buffer.from(NCDEX_ZIP.final);
    parseNcdexArchive(NCDEX_ZIP.final);
    assert.ok(NCDEX_ZIP.final.equals(before), "the zip buffer was mutated");

    const csv = MCX_CSV["2015-08-13"];
    const copy = String(csv);
    parseMcxBhavcopy(csv);
    assert.equal(csv, copy);
  });

  it("never consults the clock — dates come only from the bytes", () => {
    // Nothing here defaults to "today", so a file parsed at any hour of any
    // day yields the same trading date. The 2015 file is the proof: eleven
    // years stale and it still reports its own day.
    const file = okMcx(parseMcxBhavcopy(MCX_CSV["2015-08-13"]));
    assert.equal(iso(file.tradingDate), "2015-08-13");
    for (const r of file.rows) assert.equal(iso(r.tradingDate), "2015-08-13");
  });

  it("returns rows whose every date is a valid UTC-midnight Date", () => {
    const check = (
      rows: ReadonlyArray<{ tradingDate: Date; expiry: Date }>,
    ) => {
      for (const r of rows) {
        for (const d of [r.tradingDate, r.expiry]) {
          assert.ok(!Number.isNaN(d.getTime()), "Invalid Date leaked out");
          assert.equal(d.getUTCHours(), 0);
          assert.equal(d.getUTCMinutes(), 0);
          assert.equal(d.getUTCSeconds(), 0);
          assert.equal(d.getUTCMilliseconds(), 0);
        }
      }
    };
    check(okMcx(parseMcxBhavcopy(MCX_CSV["2026-08-11"])).rows);
    check(okNcdex(parseNcdexArchive(NCDEX_ZIP.final)).rows);
  });

  it("never emits a non-finite number in any numeric field", () => {
    const numericFields: (keyof McxBhavcopyRow)[] = [
      "open",
      "high",
      "low",
      "close",
      "prevClose",
      "volumeLots",
      "volumeQuantity",
      "valueLakh",
      "openInterestLots",
      "strike",
    ];
    for (const day of MCX_DAYS) {
      const file = okMcx(parseMcxBhavcopy(MCX_CSV[day]));
      for (const r of file.rows) {
        for (const f of numericFields) {
          const v = r[f];
          if (v === null) continue;
          assert.ok(
            typeof v === "number" && Number.isFinite(v),
            `${day} ${r.symbol}.${String(f)} = ${String(v)}`,
          );
        }
      }
    }
  });
});
