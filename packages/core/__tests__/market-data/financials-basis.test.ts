/**
 * MONEY-1300 — the ONE rule for reading `StockFinancials.basis`.
 *
 * An Indian company files the SAME period twice under SEBI/Ind AS and for a
 * holding company the two differ by a MULTIPLE: 360ONE FY2025 `totalAssets` is
 * 19,768 Cr consolidated against 7,332 Cr standalone. Measured on prod
 * 2026-08-31, 1,786 of 2,467 symbols with an annual period (72%) file BOTH,
 * 664 standalone only, 17 consolidated only. `StockFinancials` deliberately
 * keeps ONE row per period, so the stored figure is correct and unattributable
 * until the basis is displayed beside it.
 *
 * FOUR inputs reach this module and the interesting assertion is that two of
 * them are indistinguishable:
 *
 *   "CONSOLIDATED"  the projection's normal write
 *   "STANDALONE"    a period filed standalone only
 *   "UNKNOWN"       a vendor row, being backfilled separately
 *   ABSENT          ~32,359 rows. On MongoDB a `db push` creates indexes and
 *                   never fields, so the attribute is MISSING, not null.
 *
 * ABSENT and "UNKNOWN" must render IDENTICALLY, and neither may render as
 * consolidated — presenting an unknown basis as the group's numbers is the
 * failure the whole ticket exists to prevent. That direction is asserted
 * explicitly below rather than left implied by an equality check, because an
 * implementation that returned "CONSOLIDATED" for BOTH would satisfy equality.
 *
 * Source: packages/core/src/market-data/financials-basis.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeStockFinancialsBasis,
  stockFinancialsBasisLabel,
  summariseStockFinancialsBasis,
  summariseStockFinancialsBasisLabel,
  STOCK_FINANCIALS_BASIS_LABEL,
} from "../../src/market-data/financials-basis";

describe("MONEY-1300 normalizeStockFinancialsBasis — the four inputs", () => {
  it("passes the two stated bases through", () => {
    assert.equal(normalizeStockFinancialsBasis("CONSOLIDATED"), "CONSOLIDATED");
    assert.equal(normalizeStockFinancialsBasis("STANDALONE"), "STANDALONE");
  });

  it("ABSENT and the literal UNKNOWN resolve to the SAME state", () => {
    const absent = normalizeStockFinancialsBasis(undefined);
    const stated = normalizeStockFinancialsBasis("UNKNOWN");
    assert.equal(absent, stated);
    // …and specifically to UNKNOWN, not to the consolidated default. Equality
    // alone would also hold if both wrongly returned "CONSOLIDATED".
    assert.equal(absent, "UNKNOWN");
    assert.notEqual(absent, "CONSOLIDATED");
  });

  it("never invents a basis for null / empty / unrecognised", () => {
    // `parseBasis` in xbrl-filing-index.ts resolves an unrecognised label to
    // STANDALONE, which is right for a WRITER storing a filing. A READER
    // describing someone else's row has no such licence.
    for (const v of [null, "", "   ", "consolidated-ish", 42, {}, []]) {
      assert.equal(
        normalizeStockFinancialsBasis(v),
        "UNKNOWN",
        `expected UNKNOWN for ${JSON.stringify(v)}`,
      );
    }
  });

  it("is case- and whitespace-insensitive", () => {
    // The filing METADATA the writer parses is lower case ("consolidated" /
    // "non-consolidated"); `xbrl-sync.ts:1607` upper-cases before storing. A
    // case-sensitive reader is one writer refactor away from reclassifying the
    // entire table as UNKNOWN.
    assert.equal(normalizeStockFinancialsBasis("consolidated"), "CONSOLIDATED");
    assert.equal(normalizeStockFinancialsBasis("  Standalone  "), "STANDALONE");
  });
});

describe("MONEY-1300 labels", () => {
  it("labels the stated bases and refuses to guess for the rest", () => {
    assert.equal(stockFinancialsBasisLabel("CONSOLIDATED"), "Consolidated");
    assert.equal(stockFinancialsBasisLabel("STANDALONE"), "Standalone");
    assert.equal(stockFinancialsBasisLabel("UNKNOWN"), "Basis not stated");
    assert.equal(stockFinancialsBasisLabel(undefined), "Basis not stated");
  });

  it("no label reads as consolidated unless the row said so", () => {
    for (const v of [undefined, null, "UNKNOWN", "", "garbage"]) {
      assert.notEqual(
        stockFinancialsBasisLabel(v),
        STOCK_FINANCIALS_BASIS_LABEL.CONSOLIDATED,
      );
    }
  });
});

describe("MONEY-1300 summariseStockFinancialsBasis", () => {
  it("reports the shared basis when the periods agree", () => {
    assert.equal(
      summariseStockFinancialsBasis([
        { basis: "CONSOLIDATED" },
        { basis: "CONSOLIDATED" },
      ]),
      "CONSOLIDATED",
    );
  });

  it("reports MIXED when they do not — reachable mid-drain", () => {
    // The nightly projection rewrites recent periods while older ones keep
    // whatever the vendor left, so one table really can hold a CONSOLIDATED
    // FY2025 beside an absent-basis FY2019.
    assert.equal(
      summariseStockFinancialsBasis([
        { basis: "CONSOLIDATED" },
        { period: "FY 2019" } as { basis?: unknown },
      ]),
      "MIXED",
    );
    assert.equal(
      summariseStockFinancialsBasisLabel([
        { basis: "CONSOLIDATED" },
        { basis: "STANDALONE" },
      ]),
      "Mixed basis",
    );
  });

  it("an empty set is UNKNOWN, never MIXED and never consolidated", () => {
    assert.equal(summariseStockFinancialsBasis([]), "UNKNOWN");
    assert.equal(summariseStockFinancialsBasisLabel([]), "Basis not stated");
  });

  it("a set of only absent-basis rows is UNKNOWN, not MIXED", () => {
    // All four inputs normalise first, so absent-beside-UNKNOWN is agreement,
    // not disagreement. Getting this wrong would badge every legacy symbol
    // "Mixed basis" and make the badge meaningless.
    assert.equal(
      summariseStockFinancialsBasis([
        { period: "FY 2019" } as { basis?: unknown },
        { basis: "UNKNOWN" },
        { basis: null },
      ]),
      "UNKNOWN",
    );
  });
});
