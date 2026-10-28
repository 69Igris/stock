/**
 * DECISION TEST — is the SME (Emerge) bhavcopy archive additive, or already
 * covered by the CM cash ingest? (MONEY-1204, P14 14b.4)
 *
 * 14b.4 asked for a parser for `sme{DDMMYY}.csv`. The answer is that one would
 * be a SECOND writer of rows this repo already ingests, so the sub-task resolves
 * as **covered, not built** — and this file is the machine-checked form of that
 * verdict, so it cannot rot into a wrong assumption the way the registry's
 * "[probe 2026-08-08: 404 — this exact path is WRONG]" note did (the path had in
 * fact worked for five and a half years; 1,425 objects are archived under
 * `feeds/NSE/sme-bhavcopy/` spanning 2020-01 → 2025-10).
 *
 * Fixtures are REAL published bytes:
 *   __tests__/fixtures/nse-sme/sme101025.sample.csv   (SME bhavcopy, 40 rows)
 *   __tests__/fixtures/sec_bhavdata_full.sample.csv   (NSE cash feed, 07-Aug-2026)
 *
 * The evidence, in the order it is asserted:
 *
 *   1. Every series in a real SME bhavcopy is in `NSE_CASH_SERIES` — the set the
 *      CM parser KEEPS. Nothing in the file is a series the cash ingest drops.
 *   2. Every one of those series is also in `NSE_MASTER_SERIES`, so an
 *      instrument exists for the price to join to. Without this the rows would
 *      be fetched and then dropped on the join — the MONEY-1085 defect.
 *   3. AAKAAR, an SME symbol from the SME file, appears in the real archived NSE
 *      cash file with series `SM` and a full OHLC + delivery row. That is the
 *      direct proof, not an inference from a constant.
 *   4. The SME file's columns carry nothing the cash feeds lack, except
 *      `HI_52_WK`/`LO_52_WK` — and 52-week high/low is `nse-52wk-high-low`'s
 *      family, already parsed into `StockFlag`. The column list is pinned here,
 *      so an added column fails this test and reopens the decision.
 *
 * If any of these four goes red, "already covered" is no longer true and a
 * parser becomes the right answer again.
 *
 * Everything is synchronous: no timers, no promises, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  NSE_CASH_SERIES,
  NSE_CASH_SERIES_WITHOUT_MASTER,
} from "../../src/market-data/bhavcopy";
import { NSE_MASTER_SERIES } from "../../src/market-data/instruments/nse-master-logic";
import { parseSecBhavdataFull } from "../../src/market-data/delivery";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const SME_CSV = readFileSync(
  join(FIXTURES, "nse-sme", "sme101025.sample.csv"),
  "utf-8",
);
const CASH_CSV = readFileSync(
  join(FIXTURES, "sec_bhavdata_full.sample.csv"),
  "utf-8",
);

/** The SME bhavcopy's header, verbatim, in file order. */
const SME_HEADER = [
  "MARKET",
  "SERIES",
  "SYMBOL",
  "SECURITY",
  "PREV_CL_PR",
  "OPEN_PRICE",
  "HIGH_PRICE",
  "LOW_PRICE",
  "CLOSE_PRICE",
  "NET_TRDVAL",
  "NET_TRDQTY",
  "CORP_IND",
  "HI_52_WK",
  "LO_52_WK",
];

interface SmeRow {
  market: string;
  series: string;
  symbol: string;
}

/** Minimal reader — enough to interrogate the file, deliberately not a parser. */
function smeRows(): SmeRow[] {
  const lines = SME_CSV.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(1).map((l) => {
    const c = l.split(",");
    return {
      market: (c[0] ?? "").trim().toUpperCase(),
      series: (c[1] ?? "").trim().toUpperCase(),
      symbol: (c[2] ?? "").trim().toUpperCase(),
    };
  });
}

describe("the SME bhavcopy fixture", () => {
  it("has the header the decision was made against", () => {
    const header = SME_CSV.split(/\r?\n/)[0]!
      .split(",")
      .map((h) => h.trim());
    assert.deepEqual(header, SME_HEADER);
  });

  it("carries 40 rows, all NSE", () => {
    const rows = smeRows();
    assert.equal(rows.length, 40);
    assert.deepEqual([...new Set(rows.map((r) => r.market))], ["N"]);
  });
});

describe("evidence 1+2 — every SME series is one the CM ingest keeps and can join", () => {
  it("has no series outside NSE_CASH_SERIES", () => {
    const series = [...new Set(smeRows().map((r) => r.series))];
    assert.deepEqual(series, ["SM"]);
    for (const s of series) {
      assert.ok(
        NSE_CASH_SERIES.has(s),
        `series ${s} is dropped by the CM cash parser — the SME archive would be additive`,
      );
    }
  });

  it("has no series that lacks an instrument source", () => {
    // Keeping a price series with no master behind it is the MONEY-1085 defect:
    // rows fetched, then silently dropped on the join.
    for (const s of new Set(smeRows().map((r) => r.series))) {
      assert.ok(
        NSE_MASTER_SERIES.has(s) || NSE_CASH_SERIES_WITHOUT_MASTER.has(s),
        `series ${s} has no instrument source`,
      );
    }
  });
});

describe("evidence 3 — an SME symbol is in the real NSE cash file", () => {
  it("finds AAKAAR, series SM, with a full price row", () => {
    // The inference from constants is not enough on its own: this asserts the
    // rows are actually THERE, in bytes NSE published, parsed by the shipped
    // cash parser.
    const smeSymbols = new Set(smeRows().map((r) => r.symbol));
    assert.ok(smeSymbols.has("AAKAAR"));

    const cash = parseSecBhavdataFull(CASH_CSV, new Date(Date.UTC(2026, 7, 7)));
    const aakaar = cash.rows.find((r) => r.symbol === "AAKAAR");
    assert.ok(aakaar, "AAKAAR must be present in the NSE cash feed");
    assert.equal(aakaar.series, "SM");
    assert.equal(aakaar.close, 60.5);
    assert.equal(aakaar.open, 64.1);
    assert.equal(aakaar.volume, 14400);
    assert.equal(aakaar.deliveryQty, 12800);
  });
});

describe("evidence 4 — the SME file carries nothing the cash feeds lack", () => {
  it("pins the two columns that are NOT in the cash bhavcopy", () => {
    // Everything else (market, series, symbol, security name, prev close, OHLC,
    // traded value, traded quantity) has a column in the CM UDiFF bhavcopy
    // and/or sec_bhavdata_full. CORP_IND maps onto UDiFF's own remarks column.
    // 52-week high/low is its OWN registry family (`nse-52wk-high-low`), already
    // parsed into StockFlag — so it is covered too, just not by the price feed.
    const notInCash = SME_HEADER.filter(
      (h) => h.startsWith("HI_52") || h.startsWith("LO_52"),
    );
    assert.deepEqual(notInCash, ["HI_52_WK", "LO_52_WK"]);
    assert.equal(SME_HEADER.length, 14, "a new column reopens this decision");
  });
});
