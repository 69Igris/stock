/**
 * Scan → ScreenFilters mapper — pure (MONEY-795 · C2).
 *
 * Verifies the engine `ScreenerFilter[]` → `ScreenFilters` band translation
 * that lets inline-runnable scans reuse `screenStocksAction`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ScreenerFilter } from "@usemoney/core/screener/engine";
import {
  mapFiltersToScreenFilters,
  isScreenerRunnable,
} from "@/lib/scans/scan-filters";

describe("mapFiltersToScreenFilters", () => {
  it("maps gt/gte → min band and lt/lte → max band", () => {
    const filters: ScreenerFilter[] = [
      { field: "pe", operator: "lt", value: 15 },
      { field: "roe", operator: "gt", value: 15 },
    ];
    const {
      filters: out,
      mappedCount,
      unmapped,
    } = mapFiltersToScreenFilters(filters);
    assert.equal(out.maxPe, 15);
    assert.equal(out.minRoe, 15);
    assert.equal(mappedCount, 2);
    assert.deepEqual(unmapped, []);
  });

  it("maps a between filter to both bounds", () => {
    const filters: ScreenerFilter[] = [
      { field: "marketCap", operator: "between", value: [500, 5000] },
    ];
    const { filters: out, mappedCount } = mapFiltersToScreenFilters(filters);
    assert.equal(out.minMarketCap, 500);
    assert.equal(out.maxMarketCap, 5000);
    assert.equal(mappedCount, 1);
  });

  it("maps dividendYield and debtToEquity bands", () => {
    const filters: ScreenerFilter[] = [
      { field: "dividendYield", operator: "gt", value: 3 },
      { field: "debtToEquity", operator: "lt", value: 1 },
    ];
    const { filters: out } = mapFiltersToScreenFilters(filters);
    assert.equal(out.minDividendYield, 3);
    assert.equal(out.maxDebtToEquity, 1);
  });

  it("keeps the tighter bound when two filters touch the same field", () => {
    const filters: ScreenerFilter[] = [
      { field: "pe", operator: "lt", value: 30 },
      { field: "pe", operator: "lt", value: 15 },
    ];
    const { filters: out } = mapFiltersToScreenFilters(filters);
    assert.equal(out.maxPe, 15, "tighter (smaller) max wins");
  });

  it("collects unmapped fields (pb, roce, technicals) without crashing", () => {
    const filters: ScreenerFilter[] = [
      { field: "pe", operator: "lt", value: 15 },
      { field: "pb", operator: "lt", value: 2 },
      { field: "roce", operator: "gt", value: 20 },
      { field: "rsi_14", operator: "lt", value: 30 },
      { field: "golden_cross", operator: "eq", value: 1 },
    ];
    const {
      filters: out,
      mappedCount,
      unmapped,
    } = mapFiltersToScreenFilters(filters);
    assert.equal(out.maxPe, 15);
    assert.equal(mappedCount, 1);
    assert.deepEqual(
      [...unmapped].sort(),
      ["golden_cross", "pb", "roce", "rsi_14"].sort()
    );
  });

  it("maps eq on a numeric fundamental to an exact-match band (min == max)", () => {
    const filters: ScreenerFilter[] = [
      { field: "roe", operator: "eq", value: 20 },
    ];
    const { filters: out } = mapFiltersToScreenFilters(filters);
    // Exact match, NOT a neighbourhood: min == max == the eq value.
    assert.equal(out.minRoe, 20);
    assert.equal(out.maxRoe, 20);
  });

  it("does not map cross_above / cross_below operators", () => {
    const filters: ScreenerFilter[] = [
      { field: "sma_50", operator: "cross_above", value: 0 },
    ];
    const { mappedCount, unmapped } = mapFiltersToScreenFilters(filters);
    assert.equal(mappedCount, 0);
    assert.deepEqual(unmapped, ["sma_50"]);
  });

  it("rejects non-finite scalar values (NaN / Infinity) — never poisons a band", () => {
    // A non-finite gte/lte bound would make the screener match the whole
    // universe (or nothing) — must be treated as UNMAPPED, never written.
    const filters: ScreenerFilter[] = [
      { field: "pe", operator: "lt", value: Number.NaN },
      { field: "roe", operator: "gt", value: Number.POSITIVE_INFINITY },
      { field: "marketCap", operator: "gte", value: Number.NEGATIVE_INFINITY },
    ];
    const {
      filters: out,
      mappedCount,
      unmapped,
    } = mapFiltersToScreenFilters(filters);
    assert.equal(mappedCount, 0, "no non-finite value maps");
    assert.equal(out.maxPe, undefined);
    assert.equal(out.minRoe, undefined);
    assert.equal(out.minMarketCap, undefined);
    assert.deepEqual([...unmapped].sort(), ["marketCap", "pe", "roe"].sort());
  });

  it("rejects a between band with a non-finite bound", () => {
    const filters: ScreenerFilter[] = [
      { field: "pe", operator: "between", value: [10, Number.NaN] },
    ];
    const {
      filters: out,
      mappedCount,
      unmapped,
    } = mapFiltersToScreenFilters(filters);
    assert.equal(mappedCount, 0);
    assert.equal(out.minPe, undefined);
    assert.equal(out.maxPe, undefined);
    assert.deepEqual(unmapped, ["pe"]);
  });

  it("rejects a between band that isn't a 2-tuple", () => {
    const filters = [
      { field: "pe", operator: "between", value: [10] },
    ] as unknown as ScreenerFilter[];
    const { mappedCount, unmapped } = mapFiltersToScreenFilters(filters);
    assert.equal(mappedCount, 0);
    assert.deepEqual(unmapped, ["pe"]);
  });

  it("rejects an array value on a scalar operator", () => {
    const filters = [
      { field: "pe", operator: "lt", value: [10, 20] },
    ] as unknown as ScreenerFilter[];
    const { mappedCount, unmapped } = mapFiltersToScreenFilters(filters);
    assert.equal(mappedCount, 0);
    assert.deepEqual(unmapped, ["pe"]);
  });

  it("keeps mapped finite filters while collecting non-finite ones", () => {
    const filters: ScreenerFilter[] = [
      { field: "pe", operator: "lt", value: 25 }, // good
      { field: "roe", operator: "gt", value: Number.NaN }, // poisoned
    ];
    const {
      filters: out,
      mappedCount,
      unmapped,
    } = mapFiltersToScreenFilters(filters);
    assert.equal(out.maxPe, 25);
    assert.equal(out.minRoe, undefined);
    assert.equal(mappedCount, 1);
    assert.deepEqual(unmapped, ["roe"]);
  });
});

describe("isScreenerRunnable", () => {
  it("is false for empty/undefined filters", () => {
    assert.equal(isScreenerRunnable(undefined), false);
    assert.equal(isScreenerRunnable([]), false);
  });

  it("is true when at least one filter maps", () => {
    assert.equal(
      isScreenerRunnable([{ field: "pe", operator: "lt", value: 15 }]),
      true
    );
  });

  it("is false when no filter maps (pure technical)", () => {
    assert.equal(
      isScreenerRunnable([
        { field: "golden_cross", operator: "eq", value: 1 },
        { field: "rsi_14", operator: "lt", value: 30 },
      ]),
      false
    );
  });

  it("is false when every mappable field carries a non-finite value", () => {
    // The field IS in the band map, but the poisoned value means nothing
    // actually maps — so the scan must be treated as browse-only, not a
    // full-universe dump.
    assert.equal(
      isScreenerRunnable([
        { field: "pe", operator: "lt", value: Number.NaN },
        { field: "roe", operator: "gt", value: Number.POSITIVE_INFINITY },
      ]),
      false
    );
  });
});
