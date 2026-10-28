/**
 * `fii-stats-logic` — MONEY-1204 (P14 / P0.1).
 *
 * Driven by the REAL archived object (`fii_stats_13-Aug-2026.xls`, cut from
 * `gs://stockbook-content-prod/feeds/NSE/fii-stats/2026/08/`), not a synthetic
 * workbook. MONEY-1201 is the precedent: a hand-built SLB fixture was green
 * while wrong on three of four columns, because the fixture encoded the same
 * misunderstanding as the parser.
 *
 * The suite is deliberately weighted toward the three things that would ship
 * silently broken: the two-tier header, the parent-vs-children checksum, and the
 * bucket/metric namespace that keeps these rows off `nse-fao-participant-*`'s
 * unique key.
 *
 * Synchronous throughout — no timers, no promises, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import {
  FII_STATS_BUCKETS,
  FII_STATS_METRIC,
  FII_STATS_PARTICIPANT,
  checkFiiStatsTotals,
  fiiStatsParentBucket,
  isFiiStatsTotal,
  parseFiiStatsXls,
  type FiiStatsRow,
} from "../../src/market-data/fii-stats-logic";
import { POSITIONING_BUCKETS } from "../../src/market-data/market-positioning-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "nse-positioning");
const XLS = readFileSync(join(FIXTURES, "fii_stats_13-Aug-2026.xls"));

const parsed = parseFiiStatsXls(XLS);
const rowsBy = (bucket: string): FiiStatsRow | undefined =>
  parsed?.rows.find((r) => r.bucket === bucket);

describe("parseFiiStatsXls — real 13-Aug-2026 archive object", () => {
  it("recognises the report", () => {
    assert.ok(parsed, "parser returned null on a real fii_stats object");
  });

  it("reads the trading date from the TITLE row, as UTC midnight", () => {
    // The filename says 13-Aug-2026 too, but the title is the only source we
    // trust: a replayed archive, a late publication or a re-walk make the two
    // disagree precisely when it matters (MONEY-1189).
    assert.equal(
      parsed!.tradingDate?.toISOString(),
      "2026-08-13T00:00:00.000Z",
    );
  });

  it("yields 16 rows: 4 segment totals + 12 per-underlying breakdowns", () => {
    assert.equal(parsed!.rows.length, 16);
    assert.equal(
      parsed!.rows.filter((r) => isFiiStatsTotal(r.bucket)).length,
      4,
    );
    assert.equal(
      parsed!.rows.filter((r) => !isFiiStatsTotal(r.bucket)).length,
      12,
    );
  });

  it("drops nothing — no falsification counters fire on a clean file", () => {
    assert.deepEqual(parsed!.reasons, {});
  });

  it("stops at the Notes: block instead of ingesting prose as data", () => {
    // Six prose rows follow the data ("Both buy and sell positions have been
    // considered", the Options/Futures value formulae, …). Any of them reaching
    // bucketForLabel would either throw off the row count or add a junk bucket.
    for (const r of parsed!.rows) {
      assert.match(r.bucket, /^(IDX|STK)_(FUT|OPT)(:[A-Z0-9]+)?$/);
    }
  });

  it("reads every published cell of INDEX FUTURES exactly", () => {
    const r = rowsBy("IDX_FUT");
    assert.ok(r);
    assert.equal(r.longQty, 4558);
    assert.equal(r.shortQty, 8091);
    assert.equal(r.netQty, 4558 - 8091);
    assert.equal(r.longValue, 736.93);
    assert.equal(r.shortValue, 1306.43);
    assert.equal(r.openInterestQty, 223676);
    assert.equal(r.openInterestValue, 36914.77);
    assert.equal(r.underlying, null);
  });

  it("splits the two-tier header correctly on a LARGE row (no column shear)", () => {
    // INDEX OPTIONS is the row where a mis-resolved column is most visible:
    // buy contracts and buy crores differ by two orders of magnitude.
    const r = rowsBy("IDX_OPT");
    assert.ok(r);
    assert.equal(r.longQty, 3460022);
    assert.equal(r.longValue, 553791.42);
    assert.equal(r.shortQty, 3543544);
    assert.equal(r.shortValue, 567329.7);
    assert.equal(r.openInterestQty, 2559834);
    assert.equal(r.openInterestValue, 413223.56);
  });

  it("carries the per-underlying breakdown the participant files lack", () => {
    const nifty = rowsBy("IDX_FUT:NIFTY");
    assert.ok(
      nifty,
      "NIFTY futures breakdown missing — this is why the feed exists",
    );
    assert.equal(nifty.underlying, "NIFTY");
    assert.equal(nifty.longQty, 3761);
    assert.equal(nifty.openInterestQty, 142285);
    for (const u of [
      "BANKNIFTY",
      "FINNIFTY",
      "MIDCPNIFTY",
      "NIFTYFPI",
      "NIFTYNXT50",
    ]) {
      assert.ok(rowsBy(`IDX_FUT:${u}`), `missing IDX_FUT:${u}`);
      assert.ok(rowsBy(`IDX_OPT:${u}`), `missing IDX_OPT:${u}`);
    }
  });

  it("keeps a genuine published zero as 0, distinct from an unreadable cell", () => {
    // NIFTYFPI futures really did print 0 / 0.00 on this day. That is a fact,
    // not a gap, and must not become null.
    const r = rowsBy("IDX_FUT:NIFTYFPI");
    assert.ok(r);
    assert.equal(r.longQty, 0);
    assert.equal(r.longValue, 0);
    assert.equal(r.openInterestQty, 0);
  });

  it("STOCK segments have no children and are stored as totals", () => {
    for (const b of ["STK_FUT", "STK_OPT"]) {
      const r = rowsBy(b);
      assert.ok(r);
      assert.equal(r.underlying, null);
      assert.ok(isFiiStatsTotal(r.bucket));
    }
    assert.equal(
      parsed!.rows.filter((r) => r.bucket.startsWith("STK_FUT:")).length,
      0,
    );
  });

  it("NSE's own totals reconcile against its own breakdown", () => {
    assert.deepEqual(
      parsed!.discrepancies,
      [],
      "the published segment totals no longer equal the sum of their parts — " +
        "read the delta before changing anything; NSE may have added an underlying",
    );
  });
});

describe("bucket namespace — the collision guard", () => {
  it("shares NO member with POSITIONING_BUCKETS", () => {
    // The whole point: `nse-fao-participant-*` owns
    // (date, participant, bucket, metric) for these same FII dates. An
    // overlapping bucket + an overlapping metric is a silent overwrite.
    const theirs = new Set<string>(POSITIONING_BUCKETS);
    for (const b of FII_STATS_BUCKETS) {
      assert.ok(!theirs.has(b), `${b} collides with POSITIONING_BUCKETS`);
    }
  });

  it("orders its segments the opposite way round, so the two cannot be confused", () => {
    assert.ok(FII_STATS_BUCKETS.includes("IDX_FUT"));
    assert.ok((POSITIONING_BUCKETS as readonly string[]).includes("FUT_IDX"));
  });

  it("uses a metric no other positioning feed writes", () => {
    assert.equal(FII_STATS_METRIC, "FII_STATS");
    assert.notEqual(FII_STATS_METRIC, "OI");
    assert.notEqual(FII_STATS_METRIC, "VOLUME");
    assert.equal(FII_STATS_PARTICIPANT, "FII");
  });

  it("makes the total-vs-breakdown grain syntactically decidable", () => {
    assert.equal(isFiiStatsTotal("IDX_FUT"), true);
    assert.equal(isFiiStatsTotal("IDX_FUT:NIFTY"), false);
    assert.equal(fiiStatsParentBucket("IDX_FUT:NIFTY"), "IDX_FUT");
    assert.equal(fiiStatsParentBucket("IDX_FUT"), "IDX_FUT");
  });

  it("every parsed breakdown bucket rolls up into a real total bucket", () => {
    const totals = new Set<string>(FII_STATS_BUCKETS);
    for (const r of parsed!.rows) {
      assert.ok(
        totals.has(fiiStatsParentBucket(r.bucket)),
        `${r.bucket} has no parent in FII_STATS_BUCKETS`,
      );
    }
  });
});

describe("checkFiiStatsTotals — the checksum actually fires", () => {
  const mk = (
    bucket: string,
    longQty: number,
    longValue: number | null,
  ): FiiStatsRow => ({
    bucket,
    underlying: bucket.includes(":") ? (bucket.split(":")[1] ?? null) : null,
    longQty,
    shortQty: 0,
    netQty: longQty,
    longValue,
    shortValue: 0,
    netValue: longValue,
    openInterestQty: null,
    openInterestValue: null,
  });

  it("passes when the parent equals the sum of its children", () => {
    assert.deepEqual(
      checkFiiStatsTotals([
        mk("IDX_FUT", 10, 100),
        mk("IDX_FUT:NIFTY", 6, 60),
        mk("IDX_FUT:BANKNIFTY", 4, 40),
      ]),
      [],
    );
  });

  it("flags a contract column that is off by ONE (integers get no tolerance)", () => {
    const out = checkFiiStatsTotals([
      mk("IDX_FUT", 10, 100),
      mk("IDX_FUT:NIFTY", 6, 60),
      mk("IDX_FUT:BANKNIFTY", 3, 40),
    ]);
    const qty = out.find((d) => d.column === "longQty");
    assert.ok(qty, "a one-contract disagreement must not be tolerated");
    assert.equal(qty.stated, 10);
    assert.equal(qty.computed, 9);
    assert.equal(qty.delta, -1);
  });

  it("tolerates NSE's own paise-level rounding on the crore columns", () => {
    assert.deepEqual(
      checkFiiStatsTotals([
        mk("IDX_FUT", 10, 100.0),
        mk("IDX_FUT:NIFTY", 6, 60.01),
        mk("IDX_FUT:BANKNIFTY", 4, 40.01),
      ]),
      [],
    );
  });

  it("still flags a crore column that is off by a real amount", () => {
    const out = checkFiiStatsTotals([
      mk("IDX_FUT", 10, 100.0),
      mk("IDX_FUT:NIFTY", 6, 60.0),
      mk("IDX_FUT:BANKNIFTY", 4, 45.0),
    ]);
    assert.ok(out.some((d) => d.column === "longValue"));
  });

  it("does NOT manufacture a discrepancy out of our own unreadable child", () => {
    // A null child makes the sum a FLOOR. Comparing it would report NSE as
    // wrong for our gap — the same "absent treated as zero" error the whole
    // feed layer polices.
    const out = checkFiiStatsTotals([
      mk("IDX_FUT", 10, 100),
      mk("IDX_FUT:NIFTY", 6, null),
      mk("IDX_FUT:BANKNIFTY", 4, 40),
    ]);
    assert.equal(out.filter((d) => d.column === "longValue").length, 0);
  });

  it("ignores a total that has no children at all", () => {
    assert.deepEqual(checkFiiStatsTotals([mk("STK_FUT", 10, 100)]), []);
  });
});

describe("parseFiiStatsXls — rejection paths", () => {
  it("returns null on bytes that are not a workbook", () => {
    assert.equal(parseFiiStatsXls(Buffer.from("not a workbook at all")), null);
  });

  it("returns null on an empty buffer", () => {
    assert.equal(parseFiiStatsXls(Buffer.alloc(0)), null);
  });

  it("returns null on an HTML challenge page served with a 200", () => {
    assert.equal(
      parseFiiStatsXls(
        Buffer.from("<!doctype html><html><body>blocked</body></html>"),
      ),
      null,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// An UNREADABLE header column must be COUNTED, never silently nulled
// ════════════════════════════════════════════════════════════════════════════

/**
 * Rebuild the REAL archived workbook with one cell changed.
 *
 * Derived from the same 1,636-object archive as every other case here rather
 * than hand-built, so the only difference between the control and the mutant is
 * the one label — MONEY-1201's lesson about a synthetic fixture that encoded
 * the parser's own misunderstanding and stayed green while wrong.
 */
function rebuiltFixture(
  mutate?: (grid: Array<Array<string | null>>) => void,
): Buffer {
  const wb = XLSX.read(XLS, { type: "buffer", cellDates: false });
  const sheetName = wb.SheetNames[0]!;
  const grid = (
    XLSX.utils.sheet_to_json(wb.Sheets[sheetName]!, {
      header: 1,
      raw: false,
      defval: null,
    }) as Array<Array<string | null>>
  ).map((row) => [...row]);
  mutate?.(grid);
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(grid), sheetName);
  return XLSX.write(out, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("parseFiiStatsXls — a re-worded header column is REPORTED", () => {
  // Cell F2 of the real file: "OPEN INTEREST AT THE END OF THE DAY". The band
  // matcher keys on the substring "OPEN INTEREST", so NSE re-wording it to
  // "OPEN POSITIONS" costs both OI columns.
  const control = parseFiiStatsXls(rebuiltFixture());
  const reworded = parseFiiStatsXls(
    rebuiltFixture((grid) => {
      grid[1]![5] = "OPEN POSITIONS AT THE END OF THE DAY";
    }),
  );

  it("the CONTROL rebuild is faithful — the mutation is the only difference", () => {
    assert.ok(control);
    assert.equal(control.rows.length, 16);
    assert.deepEqual(control.reasons, {});
    assert.deepEqual(control.unresolvedColumns, []);
    assert.equal(
      control.rows.filter((r) => r.openInterestQty !== null).length,
      16,
    );
  });

  it("still reads the file — a bad OI header costs the columns, not the file", () => {
    assert.ok(reworded);
    assert.equal(reworded.rows.length, 16);
    assert.equal(reworded.rows[0]?.longQty, 4558, "traded legs still read");
  });

  it("COUNTS each column it could not resolve", () => {
    // Before this, `?? -1` returned a sentinel and counted nothing: the run
    // reported `rows: 16, reasons: {}, discrepancies: 0` with 0 of 16 rows
    // carrying open interest. Indistinguishable from a clean night.
    assert.ok(reworded);
    assert.equal(reworded.reasons["unresolvedColumn:openInterestQty"], 1);
    assert.equal(reworded.reasons["unresolvedColumn:openInterestValue"], 1);
    assert.deepEqual([...reworded.unresolvedColumns].sort(), [
      "openInterestQty",
      "openInterestValue",
    ]);
  });

  it("does NOT invent an OI reading for the columns it never read", () => {
    // The counter is the signal; the values must still be null rather than 0.
    assert.ok(reworded);
    for (const r of reworded.rows) {
      assert.equal(r.openInterestQty, null);
      assert.equal(r.openInterestValue, null);
    }
  });

  it("the parent-vs-children checksum cannot see the gap on its own", () => {
    // Why the counter had to be added rather than leaning on the checksum:
    // `checkFiiStatsTotals` skips a column whose parent value is null, so an
    // unresolved column disables its own check. Zero discrepancies here is the
    // checksum working as designed AND saying nothing at all.
    assert.ok(reworded);
    assert.equal(reworded.discrepancies.length, 0);
  });
});
