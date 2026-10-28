/**
 * MONEY-847 — segment-filter mapping tests (REAL export, no shadow).
 *
 * Imports the REAL `getSegmentFilterValues` from
 * `packages/services/src/mappings.ts` — the exact map the Tradebook segment
 * filter relies on (the client uppercases the dropdown choice, then
 * `buildTradeWhereClause` → `where.segment = { in: getSegmentFilterValues(...) }`).
 *
 * Regression guard for the BROKEN filter: the dropdown emits
 * equity/options/commodity/currency (uppercased to EQUITY/OPTIONS/COMMODITY/
 * CURRENCY), but the map only keyed CASH/FO/CD/COM — so F&O/Commodity matched
 * almost nothing. These assert the UI choices now resolve to the correct stored
 * segment buckets.
 *
 * Pure (no Prisma/Redis at import) → exits clean.
 *
 * Source: packages/services/src/mappings.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getSegmentFilterValues } from "../../../../packages/services/src/mappings";

describe("getSegmentFilterValues — canonical bucket keys", () => {
  it("CASH → equity stored values", () => {
    assert.deepEqual(getSegmentFilterValues("CASH"), [
      "CASH",
      "EQUITY",
      "NSE",
      "BSE",
      "CNC",
      "MIS",
    ]);
  });

  it("FO → F&O stored values (incl. FUTURES/OPTIONS)", () => {
    const v = getSegmentFilterValues("FO");
    for (const expected of ["FO", "NFO", "BFO", "NRML", "FUTURES", "OPTIONS"]) {
      assert.ok(v.includes(expected), `FO bucket should include ${expected}`);
    }
  });

  it("COM → commodity stored values", () => {
    assert.deepEqual(getSegmentFilterValues("COM"), [
      "COM",
      "MCX",
      "NCDEX",
      "COMMODITY",
    ]);
  });

  it("CD → currency stored values", () => {
    assert.deepEqual(getSegmentFilterValues("CD"), ["CD", "CDS", "CURRENCY"]);
  });
});

describe("getSegmentFilterValues — UI dropdown aliases (the bug fix)", () => {
  it("EQUITY (UI 'equity') resolves to the CASH bucket", () => {
    assert.deepEqual(
      getSegmentFilterValues("EQUITY"),
      getSegmentFilterValues("CASH")
    );
  });

  it("OPTIONS (UI 'options'=F&O) resolves to the FO bucket — was matching nothing", () => {
    const opts = getSegmentFilterValues("OPTIONS");
    assert.deepEqual(opts, getSegmentFilterValues("FO"));
    // The smoking gun: the F&O bucket must contain the real stored F&O codes.
    assert.ok(opts.includes("NFO"));
    assert.ok(opts.includes("BFO"));
  });

  it("COMMODITY (UI 'commodity') resolves to the COM bucket", () => {
    assert.deepEqual(
      getSegmentFilterValues("COMMODITY"),
      getSegmentFilterValues("COM")
    );
    assert.ok(getSegmentFilterValues("COMMODITY").includes("MCX"));
  });

  it("CURRENCY (UI 'currency') resolves to the CD bucket", () => {
    assert.deepEqual(
      getSegmentFilterValues("CURRENCY"),
      getSegmentFilterValues("CD")
    );
  });

  it("FUTURES and FNO also resolve to the FO bucket", () => {
    assert.deepEqual(
      getSegmentFilterValues("FUTURES"),
      getSegmentFilterValues("FO")
    );
    assert.deepEqual(
      getSegmentFilterValues("FNO"),
      getSegmentFilterValues("FO")
    );
  });
});

describe("getSegmentFilterValues — robustness", () => {
  it("is case-insensitive", () => {
    assert.deepEqual(
      getSegmentFilterValues("equity"),
      getSegmentFilterValues("EQUITY")
    );
    assert.deepEqual(
      getSegmentFilterValues("Options"),
      getSegmentFilterValues("OPTIONS")
    );
  });

  it("an unknown segment falls back to a single-element equality list", () => {
    assert.deepEqual(getSegmentFilterValues("WIDGET"), ["WIDGET"]);
  });
});
