/**
 * MONEY-846 — cross-exchange sector resolution.
 *
 * Imports the REAL `holdings-logic` exports (no shadow). Pure + Prisma-free.
 * Guards the TMCV-class bug: a holding on an exchange whose InstrumentMapping
 * row is the "N/A" SKIPPED sentinel must inherit the SAME symbol's usable
 * sector from another exchange (sector is a company property, not a listing).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isUsableSector,
  resolveSector,
  SECTOR_SKIPPED,
} from "../../../../packages/services/src/holdings-logic";

describe("isUsableSector", () => {
  it("rejects null / undefined / empty / the N/A SKIPPED sentinel", () => {
    assert.equal(isUsableSector(null), false);
    assert.equal(isUsableSector(undefined), false);
    assert.equal(isUsableSector(""), false);
    assert.equal(isUsableSector(SECTOR_SKIPPED), false);
    assert.equal(isUsableSector("N/A"), false);
  });

  it("accepts a real sector string", () => {
    assert.equal(isUsableSector("Consumer Discretionary"), true);
    assert.equal(isUsableSector("Utilities"), true);
  });
});

describe("resolveSector (cross-exchange fallback)", () => {
  // The real TMCV shape on QA: BSE row SKIPPED, NSE row enriched.
  const tmcv = [
    { symbol: "TMCV", exchange: "BSE", sector: "N/A" },
    { symbol: "TMCV", exchange: "NSE", sector: "Consumer Discretionary" },
  ];

  it("a BSE holding whose BSE row is N/A inherits the NSE sector (the TMCV bug)", () => {
    assert.equal(resolveSector("TMCV", "BSE", tmcv), "Consumer Discretionary");
  });

  it("prefers the holding's own exchange when it has a usable sector", () => {
    const rows = [
      { symbol: "X", exchange: "BSE", sector: "Energy" },
      { symbol: "X", exchange: "NSE", sector: "Utilities" },
    ];
    assert.equal(resolveSector("X", "BSE", rows), "Energy");
    assert.equal(resolveSector("X", "NSE", rows), "Utilities");
  });

  it("falls back to any-exchange usable sector when own exchange is absent", () => {
    const rows = [{ symbol: "W", exchange: "NSE", sector: "Financials" }];
    assert.equal(resolveSector("W", "BSE", rows), "Financials");
  });

  it("returns undefined when no exchange has a usable sector", () => {
    const rows = [
      { symbol: "Y", exchange: "BSE", sector: "N/A" },
      { symbol: "Y", exchange: "NSE", sector: null },
    ];
    assert.equal(resolveSector("Y", "BSE", rows), undefined);
  });

  it("ignores rows for other symbols", () => {
    assert.equal(resolveSector("Z", "NSE", tmcv), undefined);
  });

  it("handles an empty mapping set", () => {
    assert.equal(resolveSector("TMCV", "BSE", []), undefined);
  });
});
