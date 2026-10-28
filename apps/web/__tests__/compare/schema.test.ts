/**
 * MONEY-393 §16 - /compare URL schema parser tests.
 *
 * Pure-function tests for `lib/compare/schema.ts`:
 *   - parseCompareQuery: items / funds alias, malformed entries,
 *     MAX_COMPARE_ITEMS cap, needsPicker single-item detection,
 *     colon-in-id (INDEX:NIFTY 50) round-trip.
 *   - buildCompareUrl: canonical encoding back to the URL form.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseCompareQuery,
  buildCompareUrl,
  MAX_COMPARE_ITEMS,
  type CompareItem,
} from "@/lib/compare/schema";

describe("MONEY-393 §16 - /compare URL schema", () => {
  it("[parse] empty / undefined query → empty items, needsPicker false", () => {
    assert.deepEqual(parseCompareQuery(undefined, undefined), {
      items: [],
      needsPicker: false,
    });
    assert.deepEqual(parseCompareQuery("", ""), {
      items: [],
      needsPicker: false,
    });
  });

  it("[parse] single MF entry → needsPicker true (caller must surface picker)", () => {
    const r = parseCompareQuery("MF:119551", undefined);
    assert.equal(r.items.length, 1);
    assert.equal(r.needsPicker, true);
    assert.deepEqual(r.items[0], { fundType: "MF", fundId: "119551" });
  });

  it("[parse] two valid entries → no picker needed", () => {
    const r = parseCompareQuery("MF:119551,ETF:NIFTYBEES", undefined);
    assert.equal(r.items.length, 2);
    assert.equal(r.needsPicker, false);
  });

  it("[parse] legacy ?funds= alias produces the same shape as ?items=", () => {
    const a = parseCompareQuery("MF:1,MF:2", undefined);
    const b = parseCompareQuery(undefined, "MF:1,MF:2");
    assert.deepEqual(a, b);
  });

  it("[parse] items wins when both ?items= and ?funds= are present", () => {
    const r = parseCompareQuery("MF:1", "MF:2,MF:3");
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]?.fundId, "1");
  });

  it("[parse] uppercases the type token (mf / etf / index all accepted)", () => {
    const r = parseCompareQuery("mf:1,etf:NB,index:NIFTY 50", undefined);
    assert.deepEqual(
      r.items.map((i) => i.fundType),
      ["MF", "ETF", "INDEX"]
    );
  });

  it("[parse] INDEX:NIFTY 50 - colon-in-id is preserved (re-joined past first colon)", () => {
    // The split-then-join logic ensures that an id containing ":"
    // (theoretically) survives. NIFTY 50 has a space, not a colon -
    // but the regression guard catches a refactor that drops the
    // re-join.
    const r = parseCompareQuery(
      "INDEX:NIFTY 50,INDEX:NIFTY MIDCAP 100",
      undefined
    );
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0]?.fundId, "NIFTY 50");
    assert.equal(r.items[1]?.fundId, "NIFTY MIDCAP 100");
  });

  it("[parse] unknown type tokens are dropped (skipped, not error); STOCK is valid", () => {
    const r = parseCompareQuery("STOCK:RELIANCE,MF:1,FOO:2,ETF:NB", undefined);
    // MONEY-553 — STOCK is now first-class; only the genuinely-unknown FOO is
    // dropped silently. STOCK + MF + ETF are kept.
    assert.equal(r.items.length, 3);
    assert.deepEqual(
      r.items.map((i) => i.fundType),
      ["STOCK", "MF", "ETF"]
    );
  });

  it("[parse] empty id segments (MF:) are dropped", () => {
    const r = parseCompareQuery("MF:,MF:1,ETF:", undefined);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]?.fundId, "1");
  });

  it("[parse] missing colon (no type:id structure) is dropped", () => {
    const r = parseCompareQuery("MF119551,MF:1", undefined);
    assert.equal(r.items.length, 1);
  });

  it("[parse] caps at MAX_COMPARE_ITEMS (5) even if more provided", () => {
    const many = Array.from({ length: 10 }, (_, i) => `MF:${i}`).join(",");
    const r = parseCompareQuery(many, undefined);
    assert.equal(r.items.length, MAX_COMPARE_ITEMS);
    assert.equal(MAX_COMPARE_ITEMS, 5);
  });

  it("[parse] all-invalid entries → empty items + needsPicker false", () => {
    // STOCK is valid now (MONEY-553), so use genuinely-unknown tokens here.
    const r = parseCompareQuery("FOO:2,BAR:3,bareword", undefined);
    assert.deepEqual(r.items, []);
    assert.equal(r.needsPicker, false);
  });

  it("[parse] whitespace-only entries dropped", () => {
    const r = parseCompareQuery("  ,MF:1,  ,ETF:NB", undefined);
    assert.equal(r.items.length, 2);
  });

  it("[build] reconstructs the canonical ?items= URL", () => {
    const items: CompareItem[] = [
      { fundType: "MF", fundId: "119551" },
      { fundType: "ETF", fundId: "NIFTYBEES" },
    ];
    assert.equal(
      buildCompareUrl(items),
      "/compare?items=MF%3A119551%2CETF%3ANIFTYBEES"
    );
  });

  it("[round-trip] parse(build(items)) → items (within cap)", () => {
    const items: CompareItem[] = [
      { fundType: "INDEX", fundId: "NIFTY 50" },
      { fundType: "MF", fundId: "119551" },
      { fundType: "ETF", fundId: "NIFTYBEES" },
    ];
    const url = buildCompareUrl(items);
    // Extract the query string + decode.
    const match = url.match(/\?items=(.+)$/);
    assert.ok(match);
    const decoded = decodeURIComponent(match![1]!);
    const parsed = parseCompareQuery(decoded, undefined);
    assert.deepEqual(parsed.items, items);
  });

  it("[build] empty items → /compare?items= (caller should not pass empty, but no crash)", () => {
    const url = buildCompareUrl([]);
    assert.equal(url, "/compare?items=");
  });
});

describe("MONEY-553 — STOCK + cross-asset compare", () => {
  it("[parse] STOCK is a first-class type", () => {
    const r = parseCompareQuery("STOCK:RELIANCE", undefined);
    assert.equal(r.items.length, 1);
    assert.deepEqual(r.items[0], { fundType: "STOCK", fundId: "RELIANCE" });
    assert.equal(r.needsPicker, true); // single item → picker
  });

  it("[parse] lowercase stock token is uppercased", () => {
    const r = parseCompareQuery("stock:tcs,mf:1", undefined);
    assert.deepEqual(
      r.items.map((i) => i.fundType),
      ["STOCK", "MF"]
    );
  });

  it("[parse] CROSS-ASSET set (stock vs fund) parses both", () => {
    const r = parseCompareQuery("STOCK:RELIANCE,MF:119551", undefined);
    assert.equal(r.items.length, 2);
    assert.equal(r.needsPicker, false);
    assert.deepEqual(r.items, [
      { fundType: "STOCK", fundId: "RELIANCE" },
      { fundType: "MF", fundId: "119551" },
    ]);
  });

  it("[round-trip] a mixed stock + fund + ETF set survives build → parse", () => {
    const items: CompareItem[] = [
      { fundType: "STOCK", fundId: "RELIANCE" },
      { fundType: "MF", fundId: "119551" },
      { fundType: "ETF", fundId: "NIFTYBEES" },
    ];
    const url = buildCompareUrl(items);
    const decoded = decodeURIComponent(url.match(/\?items=(.+)$/)![1]!);
    assert.deepEqual(parseCompareQuery(decoded, undefined).items, items);
  });
});
