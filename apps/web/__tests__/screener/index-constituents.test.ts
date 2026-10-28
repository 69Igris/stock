/**
 * MONEY-393 §6 - Screener index-constituent resolution.
 *
 * Pure-function tests for `lib/screener/index-constituents.ts`:
 *   - resolveIndexFilter: id → static list / sector / mcap-rank / all
 *   - INDEX_OPTIONS: dropdown shape + ordering invariants
 *   - Static list invariants (Nifty 50 must include the mega-caps)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveIndexFilter,
  INDEX_OPTIONS,
} from "@/lib/screener/index-constituents";

describe("MONEY-393 §6 - Screener index constituents", () => {
  it("[resolve] undefined / null / 'all' → kind 'all' (skip filter)", () => {
    assert.equal(resolveIndexFilter(undefined).kind, "all");
    assert.equal(resolveIndexFilter(null).kind, "all");
    assert.equal(resolveIndexFilter("all").kind, "all");
    assert.equal(resolveIndexFilter("").kind, "all");
  });

  it("[resolve] unknown index id → kind 'all' (safe fallback, never crashes)", () => {
    assert.equal(resolveIndexFilter("definitely-not-an-index").kind, "all");
  });

  it("[resolve] nifty50 → kind 'static' with the mega-cap symbol list", () => {
    const r = resolveIndexFilter("nifty50");
    assert.equal(r.kind, "static");
    if (r.kind === "static") {
      assert.ok(r.symbols, "static resolution must carry a symbol list");
      // Sanity check: the index must include India's top market caps.
      for (const sym of ["RELIANCE", "HDFCBANK", "INFY", "TCS", "ICICIBANK"]) {
        assert.ok(r.symbols.includes(sym), `Nifty 50 must include ${sym}`);
      }
      // Standard constituent count is 50; allow the helper to ship
      // with a slightly different count if the index has been resized,
      // but it must always be a non-trivial list.
      assert.ok(
        r.symbols.length >= 40 && r.symbols.length <= 60,
        `Nifty 50 has ${r.symbols.length} entries - expected ~50`
      );
    }
  });

  it("[resolve] static lists return unique symbols (no duplicates)", () => {
    const r = resolveIndexFilter("nifty50");
    if (r.kind === "static") {
      assert.ok(r.symbols, "static resolution must carry a symbol list");
      assert.equal(
        new Set(r.symbols).size,
        r.symbols.length,
        "Nifty 50 list must not contain duplicates"
      );
    }
  });

  it("[options] dropdown has 'all listed' as the first entry", () => {
    assert.equal(INDEX_OPTIONS[0]?.value, "all");
  });

  it("[options] every option has both a value and a label", () => {
    for (const opt of INDEX_OPTIONS) {
      assert.ok(opt.value && opt.value.length > 0, "value must be non-empty");
      assert.ok(opt.label && opt.label.length > 0, "label must be non-empty");
    }
  });

  it("[options] index option values are unique", () => {
    const values = INDEX_OPTIONS.map((o) => o.value);
    assert.equal(
      new Set(values).size,
      values.length,
      `duplicate values in INDEX_OPTIONS: ${values
        .filter((v, i) => values.indexOf(v) !== i)
        .join(", ")}`
    );
  });

  it("[options] all referenced indices resolve to a non-'all' kind (or are explicitly 'all')", () => {
    for (const opt of INDEX_OPTIONS) {
      const r = resolveIndexFilter(opt.value);
      if (opt.value === "all") {
        assert.equal(r.kind, "all");
        continue;
      }
      // Every other dropdown entry must resolve to a concrete filter
      // (static list, sector match, or mcap-rank window).
      assert.notEqual(
        r.kind,
        "all",
        `INDEX_OPTIONS '${opt.value}' (${opt.label}) doesn't resolve - orphan dropdown entry`
      );
    }
  });

  it("[options] dropdown contains the headline broad-market indices", () => {
    const values = INDEX_OPTIONS.map((o) => o.value);
    for (const want of [
      "nifty50",
      "niftynext50",
      "nifty100",
      "nifty500",
      "banknifty",
      "niftyit",
    ]) {
      assert.ok(values.includes(want), `${want} must be in INDEX_OPTIONS`);
    }
  });

  it("[options] group headings cluster contiguously (no interleaving)", () => {
    // Once a group starts, all subsequent un-grouped options belong to
    // that group until the next group= entry. Verify that group labels
    // appear in declaration order without re-appearing.
    const groups: string[] = [];
    for (const opt of INDEX_OPTIONS) {
      if (opt.group && !groups.includes(opt.group)) {
        groups.push(opt.group);
      } else if (opt.group && groups[groups.length - 1] !== opt.group) {
        // A previously-seen group re-appearing later would mean
        // interleaved sections - bad UX.
        assert.fail(
          `group '${opt.group}' re-appears non-contiguously after '${groups[groups.length - 1]}'`
        );
      }
    }
    assert.ok(groups.length > 0, "expected at least one group heading");
  });
});
