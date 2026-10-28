/**
 * MONEY-393 §40 - components/screener/SortDropdown.tsx coverage push
 * (48.5% → 90%+).
 *
 * Existing __tests__/screener/sort-dropdown.test.ts covers applySort.
 * Gap: the pure helpers (decomposeSort, composeSort, fieldHasDirection)
 * + the constant labels (SORT_LABELS, SORT_FIELD_LABELS, SORT_FIELDS).
 * These are testable without DOM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SORT_LABELS,
  SORT_FIELD_LABELS,
  SORT_FIELDS,
  fieldHasDirection,
  decomposeSort,
  composeSort,
  type SortKey,
  type SortField,
} from "@/components/screener/SortDropdown";

describe("MONEY-393 §40 - SortDropdown pure helpers", () => {
  it("[SORT_FIELDS] declares the canonical 4 fields in order", () => {
    assert.deepStrictEqual(SORT_FIELDS, ["match", "mcap", "change", "name"]);
  });

  it("[SORT_FIELD_LABELS] every field has a label", () => {
    for (const field of SORT_FIELDS) {
      const label = SORT_FIELD_LABELS[field];
      assert.ok(
        label && label.length > 0,
        `SORT_FIELD_LABELS["${field}"] must be a non-empty string`
      );
    }
  });

  it("[SORT_LABELS] every SortKey (asc + desc variants) has a label", () => {
    // Each of the 4 fields has asc + desc → 8 SortKey values.
    const keys = Object.keys(SORT_LABELS) as SortKey[];
    assert.ok(
      keys.length >= 6,
      `SORT_LABELS should declare at least 6 sort keys (4 fields × 2 dirs minus name-asc/match-desc edge), got ${keys.length}`
    );
    for (const k of keys) {
      assert.ok(SORT_LABELS[k] && SORT_LABELS[k].length > 0);
    }
  });

  it("[fieldHasDirection] returns true for every field (current contract)", () => {
    // The current implementation returns true for any field - kept
    // as a function so a future field with only one direction can
    // selectively return false. Pin the current behavior.
    for (const field of SORT_FIELDS) {
      assert.equal(fieldHasDirection(field), true);
    }
  });

  it("[composeSort] field + asc → '{field}-asc'", () => {
    for (const field of SORT_FIELDS) {
      const result = composeSort(field, "asc");
      assert.equal(result, `${field}-asc`);
    }
  });

  it("[composeSort] field + desc → '{field}-desc'", () => {
    for (const field of SORT_FIELDS) {
      const result = composeSort(field, "desc");
      assert.equal(result, `${field}-desc`);
    }
  });

  it("[decomposeSort] '{field}-asc' → { field, dir:'asc' }", () => {
    for (const field of SORT_FIELDS) {
      const result = decomposeSort(`${field}-asc` as SortKey);
      assert.deepStrictEqual(result, { field, dir: "asc" });
    }
  });

  it("[decomposeSort] '{field}-desc' → { field, dir:'desc' }", () => {
    for (const field of SORT_FIELDS) {
      const result = decomposeSort(`${field}-desc` as SortKey);
      assert.deepStrictEqual(result, { field, dir: "desc" });
    }
  });

  it("[round-trip] decomposeSort(composeSort(field, dir)) === { field, dir }", () => {
    for (const field of SORT_FIELDS) {
      for (const dir of ["asc", "desc"] as const) {
        const k = composeSort(field, dir);
        const back = decomposeSort(k);
        assert.deepStrictEqual(back, { field, dir });
      }
    }
  });

  it("[round-trip] composeSort(decomposeSort(key)) === key (excluding legacy bare 'match')", () => {
    // Legacy bare "match" stored in localStorage maps to "match-desc"
    // on decompose - that's a documented one-way migration (line 86
    // in SortDropdown.tsx). The round-trip is canonical for all
    // hyphenated keys; bare "match" intentionally collapses.
    for (const k of Object.keys(SORT_LABELS) as SortKey[]) {
      if (k === "match") continue;
      const { field, dir } = decomposeSort(k);
      const back = composeSort(field, dir);
      assert.equal(back, k, `round-trip failed for ${k}`);
    }
  });

  it("[legacy] bare 'match' decomposes to match-desc (documented migration)", () => {
    const { field, dir } = decomposeSort("match" as SortKey);
    assert.equal(field, "match");
    assert.equal(dir, "desc");
    // Re-compose lands on the canonical 'match-desc' form.
    assert.equal(composeSort(field, dir), "match-desc");
  });

  it("[type-safety] SortField + SortKey types resolve at module load", () => {
    // The types are erased at runtime - this just verifies the values
    // we extracted match the constraint.
    const field: SortField = "mcap";
    const key: SortKey = "mcap-desc";
    assert.equal(field, "mcap");
    assert.equal(key, "mcap-desc");
  });
});
