/**
 * UNIT TEST — debt EOD prices (MONEY-1204, P14 / 14b.1).
 *
 * Fixture cut BY WHOLE ROWS from the prod archive (2026-08-16):
 *
 *   cbm_trd20260814.sample.csv   40 of 554 data rows
 *
 * The two deformities this family ships are both silent-wrong-answer shaped,
 * and both are asserted below against the real bytes:
 *
 *   1. every ISIN carries a TRAILING SPACE (`"INE261F08EO7 "`), which the
 *      master files do not — an un-normalised join matches nothing, and "no
 *      master row for anything that traded" reads exactly like "nothing
 *      traded";
 *   2. the weighted-average-price header has a DOUBLE SPACE
 *      (`"Weighted Average Price  (Rs.)"`), which a raw-string column match
 *      drops — leaving a null VWAP on every row of an otherwise healthy file.
 *
 * ## What the cross-file join test can and cannot prove here
 *
 * The three nse-debt fixtures are HEAD-CUTS of three much larger files
 * (554 / 10,678 / 3,717 rows), and their sampled windows do not intersect:
 * measured 2026-08-16, the 40 CBM ISINs share ZERO members with the 60 wdmlist
 * ISINs or the 54 corporate-report ISINs. So a "these two fixtures join" assert
 * is not available, and faking one by editing a fixture would be the MONEY-1201
 * mistake in a new costume.
 *
 * What IS proved: the deformation observed in the real CBM bytes, applied to a
 * real master ISIN, joins if and only if it is normalised — and the CBM parser
 * really applies that normalisation to all 40 archived rows. The zero-overlap
 * fact is asserted too, so that re-cutting the fixtures to overlapping windows
 * fails here and tells the next person to upgrade this to a direct assert.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseCbmTrades,
  type BondEodRow,
} from "../../src/market-data/bond-eod-logic";
import {
  normalizeBondIsin,
  parseCorporateBondReport,
  parseWdmList,
} from "../../src/market-data/bond-master-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "nse-debt");
const CBM_CSV = readFileSync(
  join(FIXTURES, "cbm_trd20260814.sample.csv"),
  "utf-8",
);
const WDM_CSV = readFileSync(
  join(FIXTURES, "wdmlist_14082026.sample.csv"),
  "utf-8",
);
const CORP_CSV = readFileSync(
  join(FIXTURES, "Corporate_bond_report_14-Aug-2026.sample.csv"),
  "utf-8",
);

const AUG14 = new Date(Date.UTC(2026, 7, 14));

// ─── The real cbm_trd file ───────────────────────────────────────────

describe("parseCbmTrades — real archived cbm_trd20260814.csv", () => {
  const out = parseCbmTrades(CBM_CSV);
  assert.ok(out, "the real cbm_trd file must parse");

  it("parses every data row and skips nothing", () => {
    assert.equal(out.rows.length, 40);
    assert.equal(out.skipped, 0);
    assert.deepEqual(out.reasons, {});
  });

  it("reads the first row cell-by-cell", () => {
    // 14-Aug-2026,INE261F08EO7 ,100.2612,2500.00,42500.00,7.3200,100.2436,7.3294
    assert.deepEqual(out.rows[0], {
      isin: "INE261F08EO7", // trailing space gone
      date: AUG14,
      segment: "CBM",
      lastPrice: 100.2612,
      lastYtm: 7.32,
      wapPrice: 100.2436,
      wtdYtm: 7.3294,
      lastTradeValueLacs: 2500,
      totalTradeValueLacs: 42500,
      source: "nse-cbm-trades",
    } satisfies BondEodRow);
  });

  it("locates the DOUBLE-SPACE weighted-average-price column", () => {
    // The header really is `Weighted Average Price  (Rs.)`. Matching the raw
    // string would null the VWAP on every row while the row still looks fine.
    const header = CBM_CSV.split(/\r?\n/)[0]!;
    assert.ok(
      header.includes("Weighted Average Price  (Rs.)"),
      "fixture lost the double space — re-cut it from the archive",
    );
    assert.ok(out.rows.every((r) => r.wapPrice !== null));
    // …and it is the VWAP column, not a copy of the last-trade price: this row
    // filled in parts, so the two differ.
    const partial = out.rows.find((r) => r.isin === "INE389Z07070");
    assert.ok(partial);
    assert.equal(partial.lastPrice, 99.9197);
    assert.equal(partial.wapPrice, 99.9418);
    assert.equal(partial.lastYtm, 10.2776);
    assert.equal(partial.wtdYtm, 10.2557);
  });

  it("dates every row from its own Trade Date column", () => {
    // BondEOD.date is read from the bytes, never from the archive key: the two
    // diverge on a replay, a late publication or a re-walk (MONEY-1189).
    assert.ok(out.rows.every((r) => r.date.getTime() === AUG14.getTime()));
    assert.equal(out.reasons.multipleTradeDates, undefined);
  });

  it("stamps the segment that is part of the unique key", () => {
    assert.ok(out.rows.every((r) => r.segment === "CBM"));
  });

  it("keeps a GENUINE zero trade value — not every 0 is a missing value", () => {
    // 14-Aug-2026,IN0020250059 ,97.5396,0.00,0.01,6.9000,97.5396,6.9000
    // A blanket "0 means absent" rule would erase this real print, which is
    // why the zero-filler rule lives only where an empty date corroborates it.
    const tiny = out.rows.find((r) => r.isin === "IN0020250059");
    assert.ok(tiny);
    assert.equal(tiny.lastTradeValueLacs, 0);
    assert.equal(tiny.totalTradeValueLacs, 0.01);
    assert.equal(tiny.lastPrice, 97.5396);
  });

  it("stores lac-denominated values UNCONVERTED, as the field name says", () => {
    const row = out.rows.find((r) => r.isin === "INE062A08496");
    assert.ok(row);
    assert.equal(row.lastTradeValueLacs, 25000); // ₹25,000 lacs, not ₹2.5bn
    assert.equal(row.totalTradeValueLacs, 50000);
  });
});

// ─── The join this whole task exists for ─────────────────────────────

describe("the trailing-space ISIN is what makes or breaks the join", () => {
  const eod = parseCbmTrades(CBM_CSV);
  const wdm = parseWdmList(WDM_CSV);
  const corp = parseCorporateBondReport(CORP_CSV);
  assert.ok(eod);
  assert.ok(wdm);
  assert.ok(corp);

  const master = new Map(
    [...wdm.rows, ...corp.rows].map((r) => [r.isin, r] as const),
  );

  it("the raw bytes really do pad every ISIN", () => {
    const rawCells = CBM_CSV.split(/\r?\n/)
      .slice(1)
      .filter((l) => l.trim().length > 0)
      .map((l) => l.split(",")[1]!);
    assert.equal(rawCells.length, 40);
    assert.equal(rawCells[0], "INE261F08EO7 ");
    assert.ok(
      rawCells.every((c) => c !== c.trim()),
      "fixture lost the trailing spaces — re-cut it from the archive",
    );
  });

  it("the parser strips the padding on all 40 rows", () => {
    for (const row of eod.rows) {
      assert.equal(row.isin, row.isin.trim().toUpperCase());
      assert.equal(row.isin.length, 12);
    }
  });

  it("a padded master ISIN joins ONLY after normalisation", () => {
    // A real wdmlist ISIN, wearing the exact deformation the real CBM bytes
    // apply. Un-normalised it misses; normalised it hits. That miss is the
    // failure mode this task exists to prevent — it looks identical to "this
    // bond does not trade".
    const padded = "IN0020060045 ";
    assert.equal(master.get(padded), undefined);

    const normalised = normalizeBondIsin(padded);
    assert.equal(normalised, "IN0020060045");
    const joined = master.get(normalised!);
    assert.ok(joined, "normalised lookup must hit the wdmlist master row");
    assert.equal(joined.symbol, "CG2036");
    assert.equal(joined.source, "nse-wdm-list");

    // Same, against the corporate master's namespace.
    const paddedCorp = "INE028A08299 ";
    assert.equal(master.get(paddedCorp), undefined);
    const joinedCorp = master.get(normalizeBondIsin(paddedCorp)!);
    assert.ok(joinedCorp);
    assert.equal(joinedCorp.issuer, "BANK OF BARODA");
    assert.equal(joinedCorp.source, "nse-corporate-bond-report");
  });

  it("documents that the three sampled windows do not overlap", () => {
    // If this fires, the fixtures were re-cut to intersecting windows — GOOD.
    // Replace it with a direct `eod.rows.filter(r => master.has(r.isin))`
    // assertion, which is the stronger proof this test would rather be.
    const overlap = eod.rows.filter((r) => master.has(r.isin));
    assert.equal(
      overlap.length,
      0,
      "fixtures now overlap — upgrade this to a direct join assertion",
    );
    // The masters themselves are disjoint namespaces in these windows too.
    assert.equal(
      wdm.rows.filter((r) => corp.rows.some((c) => c.isin === r.isin)).length,
      0,
    );
  });
});

// ─── "Not this report" vs "this report, and it was empty" ────────────

describe("the null signal is not the empty-rows signal", () => {
  it("returns null for bytes that are not a cbm_trd file", () => {
    for (const bytes of [
      "<html><body>404 Not Found</body></html>",
      "",
      "   ",
      "a,b,c\n1,2,3",
      WDM_CSV,
      CORP_CSV,
    ]) {
      assert.equal(parseCbmTrades(bytes), null);
    }
  });

  it("returns rows:[] — NOT null — for a real header carrying no trades", () => {
    // A session in which no corporate bond traded is a real outcome and must
    // not read as "the download failed".
    const headerOnly = CBM_CSV.split(/\r?\n/)[0]!;
    const out = parseCbmTrades(headerOnly);
    assert.ok(out);
    assert.deepEqual(out.rows, []);
    assert.equal(out.skipped, 0);
    assert.deepEqual(out.reasons, {});
  });
});

// ─── Drops are named, never silent ───────────────────────────────────

describe("every dropped row is counted", () => {
  /** Rebuild the fixture with one cell of one data row replaced. */
  function withCell(lineIndex: number, cellIndex: number, value: string) {
    const lines = CBM_CSV.split(/\r?\n/);
    const cells = (lines[lineIndex] ?? "").split(",");
    cells[cellIndex] = value;
    lines[lineIndex] = cells.join(",");
    return lines.join("\n");
  }

  it("drops a row whose ISIN is blank", () => {
    const out = parseCbmTrades(withCell(1, 1, "  "));
    assert.ok(out);
    assert.equal(out.rows.length, 39);
    assert.equal(out.skipped, 1);
    assert.equal(out.reasons.noIsin, 1);
  });

  it("drops a row whose own trade date will not parse", () => {
    // The date is part of @@unique([isin, date, segment]); guessing it would
    // mint a phantom print that can never be deduped against the real one.
    const out = parseCbmTrades(withCell(2, 0, "31-Feb-2026"));
    assert.ok(out);
    assert.equal(out.rows.length, 39);
    assert.equal(out.skipped, 1);
    assert.equal(out.reasons.unparseableTradeDate, 1);
  });

  it("keeps the first of two rows for one (isin, date) and counts it", () => {
    const lines = CBM_CSV.split(/\r?\n/);
    const dup = [...lines.slice(0, 2), lines[1], ...lines.slice(2)].join("\n");
    const out = parseCbmTrades(dup);
    assert.ok(out);
    assert.equal(out.rows.length, 40);
    assert.equal(out.skipped, 1);
    assert.equal(out.reasons.duplicateIsinDate, 1);
    assert.equal(out.rows[0]?.lastPrice, 100.2612);
  });

  it("flags a file carrying more than one trading day", () => {
    // One cbm_trd file is one session. If that stops being true the writer
    // must see it BEFORE it stamps a date on anything.
    const out = parseCbmTrades(withCell(1, 0, "13-Aug-2026"));
    assert.ok(out);
    assert.equal(out.rows.length, 40);
    assert.equal(out.reasons.multipleTradeDates, 2);
    assert.deepEqual(out.rows[0]?.date, new Date(Date.UTC(2026, 7, 13)));
  });
});
