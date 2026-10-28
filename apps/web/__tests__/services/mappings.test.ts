/**
 * Service Mappings Tests — packages/services/src/mappings.ts
 *
 * De-shadowed (MONEY-620): this file used to RE-DECLARE SEGMENT_MAP /
 * PRODUCT_TYPE_MAP and all three functions inline and assert the copy — a
 * classic shadow test (green even if the real source drifted). It now imports
 * and exercises the REAL exported symbols from the service package, which is
 * what `packages/services/src/positions.service.ts`, `trades-logic.ts`, and
 * `apps/web/lib/brokers/clients/zerodha.ts` actually call in production.
 *
 * These are pure, framework-free data maps (low risk: no user-computed
 * aggregates, no IDOR, no untrusted parsing) — the value here is purely the
 * real-import contract + the unknown-code passthrough fallbacks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getSegmentLabel,
  getProductTypeLabel,
  getSegmentFilterValues,
} from "../../../../packages/services/src/mappings";

describe("getSegmentLabel (real export)", () => {
  it("maps the canonical segment codes", () => {
    assert.strictEqual(getSegmentLabel("CASH"), "Equity");
    assert.strictEqual(getSegmentLabel("FO"), "F&O");
    assert.strictEqual(getSegmentLabel("CD"), "Currency");
    assert.strictEqual(getSegmentLabel("COM"), "Commodity");
    assert.strictEqual(getSegmentLabel("MF"), "Mutual Funds");
    assert.strictEqual(getSegmentLabel("EQUITY"), "Equity");
  });

  it("maps exchange codes to their category", () => {
    assert.strictEqual(getSegmentLabel("NSE"), "Equity");
    assert.strictEqual(getSegmentLabel("BSE"), "Equity");
    assert.strictEqual(getSegmentLabel("NFO"), "F&O");
    assert.strictEqual(getSegmentLabel("BFO"), "F&O");
    assert.strictEqual(getSegmentLabel("MCX"), "Commodity");
    assert.strictEqual(getSegmentLabel("CDS"), "Currency");
  });

  it("maps product-type codes that double as segments", () => {
    assert.strictEqual(getSegmentLabel("CNC"), "Equity");
    assert.strictEqual(getSegmentLabel("MIS"), "Equity");
    assert.strictEqual(getSegmentLabel("NRML"), "F&O");
  });

  it("returns the code itself for unknown / empty segments", () => {
    assert.strictEqual(getSegmentLabel("UNKNOWN"), "UNKNOWN");
    assert.strictEqual(getSegmentLabel("xyz"), "xyz");
    assert.strictEqual(getSegmentLabel(""), "");
  });

  it("is case-sensitive (lowercase known code is NOT mapped)", () => {
    // Broker data is upper-cased upstream; assert the real lookup semantics.
    assert.strictEqual(getSegmentLabel("cash"), "cash");
  });
});

describe("getProductTypeLabel (real export)", () => {
  it("maps the known product types", () => {
    assert.strictEqual(getProductTypeLabel("CNC"), "Cash & Carry");
    assert.strictEqual(getProductTypeLabel("MIS"), "Intraday");
    assert.strictEqual(getProductTypeLabel("NRML"), "Normal F&O");
    assert.strictEqual(getProductTypeLabel("BO"), "Bracket Order");
    assert.strictEqual(getProductTypeLabel("CO"), "Cover Order");
  });

  it("returns the code for unknown / empty product types", () => {
    assert.strictEqual(getProductTypeLabel("DELIVERY"), "DELIVERY");
    assert.strictEqual(getProductTypeLabel("UNKNOWN"), "UNKNOWN");
    assert.strictEqual(getProductTypeLabel(""), "");
  });
});

describe("getSegmentFilterValues (real export)", () => {
  it("expands CASH to all equity-storage variants", () => {
    assert.deepStrictEqual(getSegmentFilterValues("CASH"), [
      "CASH",
      "EQUITY",
      "NSE",
      "BSE",
      "CNC",
      "MIS",
    ]);
  });

  it("expands FO / CD / COM to their stored variants", () => {
    assert.deepStrictEqual(getSegmentFilterValues("FO"), [
      "FO",
      "NFO",
      "BFO",
      "NRML",
      "FUTURES",
      "OPTIONS",
    ]);
    assert.deepStrictEqual(getSegmentFilterValues("CD"), [
      "CD",
      "CDS",
      "CURRENCY",
    ]);
    assert.deepStrictEqual(getSegmentFilterValues("COM"), [
      "COM",
      "MCX",
      "NCDEX",
      "COMMODITY",
    ]);
  });

  it("wraps an unmapped segment in a single-element array", () => {
    assert.deepStrictEqual(getSegmentFilterValues("MF"), ["MF"]);
    assert.deepStrictEqual(getSegmentFilterValues("XYZ"), ["XYZ"]);
    assert.deepStrictEqual(getSegmentFilterValues(""), [""]);
  });

  it("keeps the filter expansion internally consistent with the label map", () => {
    // Every CASH-filter value must label back to Equity, and every FO value to
    // F&O — this cross-checks the two real maps against each other (the kind of
    // drift a shadow copy could silently hide).
    for (const v of getSegmentFilterValues("CASH")) {
      assert.strictEqual(getSegmentLabel(v), "Equity", `${v} → Equity`);
    }
    for (const v of getSegmentFilterValues("FO")) {
      assert.strictEqual(getSegmentLabel(v), "F&O", `${v} → F&O`);
    }
  });
});
