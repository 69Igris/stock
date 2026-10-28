/**
 * MONEY-849 — MF category read-time join (REAL exported helpers).
 *
 * `normalizeZerodhaMutualFund` never sets `category` (Kite /mf/holdings has
 * none), so every synced MutualFund row stores `category: null`. The holdings
 * MF tab then buckets all funds under "Other" ("BY CATEGORY" donut) and the
 * "All categories" filter is empty. `getMutualFunds` now does a read-time join
 * against `MutualFundMaster` (whose `category` IS populated) to backfill the
 * missing category, mirroring `getHoldings`' InstrumentMapping sector fallback.
 *
 * The Prisma orchestration (the batched `mutualFundMaster.findMany`) is bound to
 * the live client and is exercised end-to-end via the apps/web recording-prisma
 * seam (mutualfunds-data-e2e.test.ts); the services package is ESM and can't use
 * that CJS `require.cache` seam. What carries the actual JOIN LOGIC, though, is
 * pure and exported — `collectMfMasterLookupKeys` (key collection, the no-N+1
 * contract) and `patchMfCategoriesFromMasters` (map-build + in-place patch). We
 * drive those REAL functions directly here.
 *
 * Source: packages/services/src/mutualfunds.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectMfMasterLookupKeys,
  patchMfCategoriesFromMasters,
  type MfCategoryJoinRow,
  type MfMasterCategoryRow,
} from "../src/mutualfunds.service";

// ── collectMfMasterLookupKeys ──────────────────────────────────────

describe("MONEY-849 — collectMfMasterLookupKeys (no-N+1 key collection)", () => {
  it("collects schemeCode AND isin keys from rows missing a category", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: "MF001", isin: null, category: null },
      { schemeCode: null, isin: "INF277K01QO1", category: null },
    ];
    const keys = collectMfMasterLookupKeys(rows);
    assert.deepEqual(keys.schemeCodes, ["MF001"]);
    assert.deepEqual(keys.isins, ["INF277K01QO1"]);
  });

  it("de-duplicates repeated keys (one IN clause, not N lookups)", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: "MF001", isin: "INF1" },
      { schemeCode: "MF001", isin: "INF1" }, // dup folio of same scheme
      { schemeCode: "MF002", isin: "INF2" },
    ];
    const keys = collectMfMasterLookupKeys(rows);
    assert.deepEqual(keys.schemeCodes.sort(), ["MF001", "MF002"]);
    assert.deepEqual(keys.isins.sort(), ["INF1", "INF2"]);
  });

  it("drops null/undefined/whitespace-only keys (no { in: [''] } hazard)", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: "", isin: "   " },
      { schemeCode: undefined, isin: undefined },
      { schemeCode: "  MF003  ", isin: "  INF3  " }, // trimmed
      {},
    ];
    const keys = collectMfMasterLookupKeys(rows);
    assert.deepEqual(keys.schemeCodes, ["MF003"]);
    assert.deepEqual(keys.isins, ["INF3"]);
  });

  it("returns empty key lists for an empty row set", () => {
    assert.deepEqual(collectMfMasterLookupKeys([]), {
      schemeCodes: [],
      isins: [],
    });
  });
});

// ── patchMfCategoriesFromMasters ───────────────────────────────────

describe("MONEY-849 — patchMfCategoriesFromMasters (read-time join)", () => {
  it("MATCHED via schemeCode: fills category + subCategory from master", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: "MF001", isin: null, category: null, subCategory: null },
    ];
    const masters: MfMasterCategoryRow[] = [
      {
        schemeCode: "MF001",
        isinGrowth: "INFX",
        isinDividend: null,
        category: "ELSS",
        subCategory: "Growth",
      },
    ];
    patchMfCategoriesFromMasters(rows, masters);
    assert.equal(rows[0]!.category, "ELSS");
    assert.equal(rows[0]!.subCategory, "Growth");
  });

  it("MATCHED via isin → isinGrowth (the Zerodha-sync case, schemeCode null)", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: null, isin: "INF277K01QO1", category: null },
    ];
    const masters: MfMasterCategoryRow[] = [
      {
        schemeCode: "120503",
        isinGrowth: "INF277K01QO1",
        isinDividend: "INF277K01QP8",
        category: "Small Cap",
        subCategory: null,
      },
    ];
    patchMfCategoriesFromMasters(rows, masters);
    assert.equal(rows[0]!.category, "Small Cap");
  });

  it("MATCHED via isin → isinDividend (dividend-plan ISIN)", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: null, isin: "INF277K01QP8", category: "" },
    ];
    const masters: MfMasterCategoryRow[] = [
      {
        schemeCode: "120503",
        isinGrowth: "INF277K01QO1",
        isinDividend: "INF277K01QP8",
        category: "Flexi Cap",
        subCategory: "Dividend",
      },
    ];
    patchMfCategoriesFromMasters(rows, masters);
    assert.equal(rows[0]!.category, "Flexi Cap");
    assert.equal(rows[0]!.subCategory, "Dividend");
  });

  it("UNMATCHED: no master row → category stays null (UI shows 'Other')", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: "NOPE", isin: "INF-NONE", category: null },
    ];
    const masters: MfMasterCategoryRow[] = [
      {
        schemeCode: "MF001",
        isinGrowth: "INF-OTHER",
        category: "Large Cap",
      },
    ];
    patchMfCategoriesFromMasters(rows, masters);
    assert.equal(rows[0]!.category, null);
  });

  it("ALREADY-SET: a row with an existing category is NEVER overwritten", () => {
    const rows: MfCategoryJoinRow[] = [
      {
        schemeCode: "MF001",
        isin: "INFX",
        category: "Mid Cap",
        subCategory: "Growth",
      },
    ];
    const masters: MfMasterCategoryRow[] = [
      {
        schemeCode: "MF001",
        isinGrowth: "INFX",
        category: "ELSS", // different — must NOT clobber the row
        subCategory: "Dividend",
      },
    ];
    patchMfCategoriesFromMasters(rows, masters);
    assert.equal(rows[0]!.category, "Mid Cap");
    assert.equal(rows[0]!.subCategory, "Growth");
  });

  it("BATCH (mixed): matched-by-code, matched-by-isin, unmatched, already-set", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: "MF001", isin: null, category: null }, // → by code
      { schemeCode: null, isin: "INF2", category: null }, //  → by isin
      { schemeCode: "ZZZ", isin: "INF-NONE", category: null }, // unmatched
      { schemeCode: "MF003", isin: "INF3", category: "Value" }, // skip (set)
    ];
    const masters: MfMasterCategoryRow[] = [
      { schemeCode: "MF001", isinGrowth: "INF1", category: "ELSS" },
      { schemeCode: "MF002", isinGrowth: "INF2", category: "Small Cap" },
      { schemeCode: "MF003", isinGrowth: "INF3", category: "Large Cap" },
    ];
    patchMfCategoriesFromMasters(rows, masters);
    assert.equal(rows[0]!.category, "ELSS"); // matched by schemeCode
    assert.equal(rows[1]!.category, "Small Cap"); // matched by isinGrowth
    assert.equal(rows[2]!.category, null); // no master → stays null
    assert.equal(rows[3]!.category, "Value"); // pre-set, untouched
  });

  it("schemeCode is PREFERRED over isin when both keys would match", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: "MF001", isin: "INF-SHARED", category: null },
    ];
    const masters: MfMasterCategoryRow[] = [
      { schemeCode: "MF001", isinGrowth: "INF-OTHER", category: "ELSS" },
      { schemeCode: "MF999", isinGrowth: "INF-SHARED", category: "Liquid" },
    ];
    patchMfCategoriesFromMasters(rows, masters);
    assert.equal(rows[0]!.category, "ELSS"); // schemeCode hit wins
  });

  it("ignores master rows with a null category (can't shadow a usable hit)", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: null, isin: "INF-DUP", category: null },
    ];
    const masters: MfMasterCategoryRow[] = [
      { schemeCode: "A", isinGrowth: "INF-DUP", category: null }, // useless
      { schemeCode: "B", isinDividend: "INF-DUP", category: "Gilt" }, // usable
    ];
    patchMfCategoriesFromMasters(rows, masters);
    assert.equal(rows[0]!.category, "Gilt");
  });

  it("does not clobber an existing subCategory with a null master subCategory", () => {
    const rows: MfCategoryJoinRow[] = [
      { schemeCode: "MF001", category: null, subCategory: "Growth" },
    ];
    const masters: MfMasterCategoryRow[] = [
      { schemeCode: "MF001", category: "ELSS", subCategory: null },
    ];
    patchMfCategoriesFromMasters(rows, masters);
    assert.equal(rows[0]!.category, "ELSS"); // category still filled
    assert.equal(rows[0]!.subCategory, "Growth"); // preserved
  });

  it("is a no-op for empty rows or empty masters", () => {
    const rows: MfCategoryJoinRow[] = [{ schemeCode: "MF001", category: null }];
    patchMfCategoriesFromMasters(rows, []);
    assert.equal(rows[0]!.category, null);
    // empty rows → nothing thrown
    assert.doesNotThrow(() =>
      patchMfCategoriesFromMasters(
        [],
        [{ schemeCode: "MF001", category: "X" }],
      ),
    );
  });
});
