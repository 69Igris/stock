/**
 * Ask Screener chat — filter vocabulary + sanitizer (MONEY-1078).
 *
 * `sanitizeFilters` is the ONLY gate between model-supplied args and the
 * screener's filter state, so this suite pins its guarantees:
 *   - unknown keys are dropped, never merged;
 *   - numbers coerce from strings, reject non-finite, and clamp with a note;
 *   - enums match case-insensitively and canonicalise, else drop;
 *   - explicit null = "unset this key"; empty string clears a string field;
 *   - sort keys validate per mode (a fund sort must not apply to stocks).
 *
 * Source: apps/web/app/discover/screener/lib/chat/filters.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeFilters,
  sanitizeSort,
  FIELDS_BY_MODE,
  SORTS_BY_MODE,
} from "@/app/discover/screener/lib/chat/filters";
import { resolveIndexFilter } from "@/lib/screener/index-constituents";

describe("sanitizeFilters — allowlisting", () => {
  it("drops keys outside the mode's vocabulary", () => {
    const r = sanitizeFilters("stocks", {
      minPe: 25,
      pegRatio: 1.2,
      limit: 500,
    });
    assert.deepEqual(r.applied, { minPe: 25 });
    assert.ok(r.dropped.includes("pegRatio"));
    // `limit` is a paging internal deliberately kept out of the chat vocab.
    assert.ok(r.dropped.includes("limit"));
  });

  it("drops INHERITED Object keys instead of treating them as fields", () => {
    // Built via JSON.parse, NOT an object literal: `{__proto__: x}` invokes
    // the prototype SETTER, so Object.entries never sees the key and the
    // assertion would be vacuous. Real model output arrives via JSON.parse,
    // where these land as genuine own-properties.
    // Regression: a plain `fields[key]` lookup resolves "constructor" and
    // "toString" off the prototype chain, and the non-FieldSpec result fell
    // through to the string branch (maxLen undefined → no length cap),
    // merging junk into filter state.
    const hostile = JSON.parse(
      '{"constructor":"x","toString":"y","valueOf":"z","hasOwnProperty":"w","minPe":20}'
    ) as Record<string, unknown>;
    const r = sanitizeFilters("stocks", hostile);
    assert.deepEqual(r.applied, { minPe: 20 });
    assert.deepEqual(r.dropped.sort(), [
      "constructor",
      "hasOwnProperty",
      "toString",
      "valueOf",
    ]);
  });

  it("drops a stocks-only key when addressed to the MF mode", () => {
    const r = sanitizeFilters("mf", { minPe: 25, minAum: 1000 });
    assert.deepEqual(r.applied, { minAum: 1000 });
    assert.deepEqual(r.dropped, ["minPe"]);
  });

  it("returns nothing applied for an entirely unknown bag", () => {
    const r = sanitizeFilters("etf", { nonsense: 1, alsoBad: "x" });
    assert.deepEqual(r.applied, {});
    assert.equal(r.dropped.length, 2);
  });
});

describe("sanitizeFilters — numbers", () => {
  it("coerces numeric strings (models often quote numbers)", () => {
    const r = sanitizeFilters("stocks", { minRoe: "20" });
    assert.deepEqual(r.applied, { minRoe: 20 });
    assert.equal(r.dropped.length, 0);
  });

  it("drops NaN / Infinity / non-numeric rather than poisoning state", () => {
    const r = sanitizeFilters("stocks", {
      minPe: "abc",
      maxPe: Number.POSITIVE_INFINITY,
      minRoe: Number.NaN,
    });
    assert.deepEqual(r.applied, {});
    assert.deepEqual(r.dropped.sort(), ["maxPe", "minPe", "minRoe"]);
  });

  it("clamps out-of-range values and reports the correction", () => {
    const r = sanitizeFilters("mf", { maxExpenseRatio: 99 });
    // MF expense ratio is capped at 10%.
    assert.equal(r.applied.maxExpenseRatio, 10);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0]!, /maxExpenseRatio/);
  });

  it("clamps a negative AUM up to the floor", () => {
    const r = sanitizeFilters("mf", { minAum: -500 });
    assert.equal(r.applied.minAum, 0);
    assert.equal(r.notes.length, 1);
  });

  it("leaves in-range values untouched and note-free", () => {
    const r = sanitizeFilters("stocks", { minRoe: 20, maxPe: 25 });
    assert.deepEqual(r.applied, { minRoe: 20, maxPe: 25 });
    assert.deepEqual(r.notes, []);
  });

  it("treats an empty/whitespace string as CLEAR, not as zero", () => {
    // Regression: Number("") === 0 and passes Number.isFinite, so an empty
    // string used to be applied as a real `minPe: 0` bound — silently
    // narrowing the screen instead of unsetting the field.
    const r = sanitizeFilters("stocks", { minPe: "", maxRoe: "   " });
    assert.deepEqual(r.applied, {});
    assert.deepEqual(r.cleared.sort(), ["maxRoe", "minPe"]);
    assert.deepEqual(r.dropped, []);
  });

  it("still applies a real zero", () => {
    // "" clears, but an explicit 0 (or "0") is a legitimate bound.
    const r = sanitizeFilters("stocks", { minRoe: 0, maxDebtToEquity: "0" });
    assert.deepEqual(r.applied, { minRoe: 0, maxDebtToEquity: 0 });
    assert.deepEqual(r.cleared, []);
  });
});

describe("sanitizeFilters — inverted ranges", () => {
  it("swaps an inverted min/max pair and reports it", () => {
    // Regression: minPe:100 + maxPe:10 matches nothing, so the screen went
    // empty with no explanation of why.
    const r = sanitizeFilters("stocks", { minPe: 100, maxPe: 10 });
    assert.deepEqual(r.applied, { minPe: 10, maxPe: 100 });
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0]!, /inverted/);
  });

  it("leaves a correctly ordered pair alone", () => {
    const r = sanitizeFilters("stocks", { minPe: 10, maxPe: 100 });
    assert.deepEqual(r.applied, { minPe: 10, maxPe: 100 });
    assert.deepEqual(r.notes, []);
  });

  it("leaves an equal pair alone (a single-value band is valid)", () => {
    const r = sanitizeFilters("stocks", { minPe: 20, maxPe: 20 });
    assert.deepEqual(r.applied, { minPe: 20, maxPe: 20 });
    assert.deepEqual(r.notes, []);
  });

  it("only touches the inverted pair, not other filters", () => {
    const r = sanitizeFilters("stocks", {
      minRoe: 30,
      maxRoe: 5,
      sector: "IT",
      maxPe: 25,
    });
    assert.deepEqual(r.applied, {
      minRoe: 5,
      maxRoe: 30,
      sector: "IT",
      maxPe: 25,
    });
    assert.equal(r.notes.length, 1);
  });

  it("handles inverted ranges on the funds modes too", () => {
    const r = sanitizeFilters("mf", { minAum: 5000, maxAum: 100 });
    assert.deepEqual(r.applied, { minAum: 100, maxAum: 5000 });
    assert.match(r.notes[0]!, /minAum\/maxAum/);
  });

  it("does not swap when only one side is supplied", () => {
    const r = sanitizeFilters("stocks", { minPe: 100 });
    assert.deepEqual(r.applied, { minPe: 100 });
    assert.deepEqual(r.notes, []);
  });
});

describe("sanitizeFilters — market cap: bucket vs explicit band", () => {
  // resolveMarketCapRange merges the two per FIELD, not per group: it takes
  // the bucket's bound where it has one and falls back to the explicit value
  // where it doesn't. LARGE has no max, so an ACTIVE bucket plus a chat-set
  // maxMarketCap resolved to min 20000 / max 8000 — impossible, zero rows,
  // while the executor cheerfully reported the band as applied.
  it("clears the bucket when an explicit band is set", () => {
    const r = sanitizeFilters("stocks", { maxMarketCap: 8000 });
    assert.deepEqual(r.applied, { maxMarketCap: 8000 });
    assert.ok(
      r.cleared.includes("marketCapBucket"),
      "an already-active bucket must be unset, or it overrides the band"
    );
  });

  it("clears an explicit band when the bucket is set", () => {
    const r = sanitizeFilters("stocks", { marketCapBucket: "LARGE" });
    assert.deepEqual(r.applied, { marketCapBucket: "LARGE" });
    assert.deepEqual(r.cleared.sort(), ["maxMarketCap", "minMarketCap"]);
  });

  it("prefers the explicit band when one call sets both", () => {
    const r = sanitizeFilters("stocks", {
      marketCapBucket: "LARGE",
      minMarketCap: 500,
      maxMarketCap: 8000,
    });
    assert.deepEqual(r.applied, { minMarketCap: 500, maxMarketCap: 8000 });
    assert.ok(r.cleared.includes("marketCapBucket"));
    assert.match(r.notes.join(" "), /marketCapBucket dropped/);
  });

  it("leaves market-cap keys alone when the call sets neither", () => {
    const r = sanitizeFilters("stocks", { minPe: 20 });
    assert.deepEqual(r.cleared, []);
  });

  it("does not apply the rule to the funds modes", () => {
    const r = sanitizeFilters("mf", { minAum: 500 });
    assert.deepEqual(r.cleared, []);
  });
});

describe("sanitizeFilters — enums and strings", () => {
  it("canonicalises enum casing", () => {
    const r = sanitizeFilters("stocks", {
      exchange: "nse",
      marketCapBucket: "large",
    });
    assert.deepEqual(r.applied, { exchange: "NSE", marketCapBucket: "LARGE" });
  });

  it("drops an enum value outside the vocabulary", () => {
    const r = sanitizeFilters("stocks", { exchange: "NASDAQ" });
    assert.deepEqual(r.applied, {});
    assert.deepEqual(r.dropped, ["exchange"]);
  });

  it("every offered index id actually RESOLVES to a real filter", () => {
    // This used to loop over the declared vocab and assert the sanitizer
    // accepted it — circular, and it proved nothing. It passed happily while
    // the vocab offered "midcap150"/"smallcap250", ids the resolver has never
    // heard of: `resolveIndexFilter` returns { kind: "all" } for an unknown
    // id, so the chat reported "Applied index=midcap150" and the query
    // filtered NOTHING. Assert against the resolver, the thing that decides.
    const declared = (
      FIELDS_BY_MODE.stocks.index as { values: readonly string[] }
    ).values;
    assert.ok(declared.length > 0, "stocks mode must offer index ids");

    const noop: string[] = [];
    for (const idx of declared) {
      const r = sanitizeFilters("stocks", { index: idx });
      assert.equal(r.applied.index, idx, `index ${idx} should survive`);
      // kind "all" === no filter applied, i.e. a silent no-op for the user.
      if (resolveIndexFilter(idx).kind === "all") noop.push(idx);
    }
    assert.deepEqual(
      noop,
      [],
      `these index ids are offered to the model but filter nothing: ${noop.join(", ")}`
    );
  });

  it("does not offer the no-filter sentinel as a selectable index", () => {
    // "all" means "no index filter"; the chat clears with null instead.
    const declared = (
      FIELDS_BY_MODE.stocks.index as { values: readonly string[] }
    ).values;
    assert.ok(!declared.includes("all"));
  });

  it("trims and length-caps free-text fields", () => {
    const long = "x".repeat(200);
    const r = sanitizeFilters("stocks", { sector: `  Banking  ` });
    assert.equal(r.applied.sector, "Banking");
    const r2 = sanitizeFilters("etf", { theme: long });
    assert.equal((r2.applied.theme as string).length, 60);
  });
});

describe("sanitizeFilters — unsetting", () => {
  it("treats explicit null as an unset request, not a value", () => {
    const r = sanitizeFilters("stocks", { minPe: null, minRoe: 15 });
    assert.deepEqual(r.cleared, ["minPe"]);
    assert.deepEqual(r.applied, { minRoe: 15 });
    assert.deepEqual(r.dropped, []);
  });

  it("treats an empty string as clearing a text field", () => {
    const r = sanitizeFilters("stocks", { sector: "   " });
    assert.deepEqual(r.cleared, ["sector"]);
    assert.deepEqual(r.applied, {});
  });

  it("ignores undefined without clearing or dropping", () => {
    const r = sanitizeFilters("stocks", { minPe: undefined });
    assert.deepEqual(r.applied, {});
    assert.deepEqual(r.cleared, []);
    assert.deepEqual(r.dropped, []);
  });
});

describe("sanitizeSort", () => {
  it("accepts each mode's own keys", () => {
    for (const mode of ["stocks", "mf", "etf"] as const) {
      for (const key of SORTS_BY_MODE[mode]) {
        assert.equal(sanitizeSort(mode, key), key);
      }
    }
  });

  it("rejects a fund sort on the stocks tab", () => {
    assert.equal(sanitizeSort("stocks", "aum-desc"), null);
    assert.equal(sanitizeSort("stocks", "ret3y-desc"), null);
  });

  it("rejects a stocks sort on a funds tab", () => {
    assert.equal(sanitizeSort("mf", "mcap-desc"), null);
    assert.equal(sanitizeSort("etf", "change-desc"), null);
  });

  it("normalises case and whitespace, rejects junk", () => {
    assert.equal(sanitizeSort("stocks", "  MCAP-DESC "), "mcap-desc");
    assert.equal(sanitizeSort("stocks", "best"), null);
    assert.equal(sanitizeSort("stocks", undefined), null);
  });
});
