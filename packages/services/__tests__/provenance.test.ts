/**
 * Provenance envelope — MONEY-1204 (P14 / 14c.0).
 *
 * The assertions that matter here are the ones about ZERO. `withProvenance`
 * decides whether a section renders its empty state, and the recurring defect in
 * this codebase is a real published zero being treated as absence: a 0% delivery
 * day, a 0-count flag list, a `-` coerced by `Number("")`. If `empty` fired on
 * those, a section with genuine data would show "nothing published yet".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { latestAsOf, withProvenance } from "../src/provenance";

describe("withProvenance — empty derivation", () => {
  it("an empty array is empty", () => {
    assert.equal(withProvenance([]).empty, true);
  });

  it("a populated array is not", () => {
    assert.equal(withProvenance([{ a: 1 }]).empty, false);
  });

  it("null and undefined are empty", () => {
    assert.equal(withProvenance(null).empty, true);
    assert.equal(withProvenance(undefined).empty, true);
  });

  it("an object with no keys is empty; with keys is not", () => {
    assert.equal(withProvenance({}).empty, true);
    assert.equal(withProvenance({ pct: 0 }).empty, false);
  });

  it("ZERO is not empty — a published 0 is a fact, not absence", () => {
    // The whole absence-rules discipline in this repo exists to keep "reported
    // zero" distinguishable from "not reported". If 0 read as empty here, a
    // stock with 0% delivery would render "nothing published yet".
    assert.equal(withProvenance(0).empty, false);
    assert.equal(withProvenance({ deliveryPct: 0 }).empty, false);
    assert.equal(withProvenance([0]).empty, false);
  });

  it("false is not empty either", () => {
    assert.equal(withProvenance(false).empty, false);
  });

  it("derives `empty` rather than trusting a caller who says otherwise", () => {
    // The one thing every caller gets wrong under time pressure is passing
    // empty:false beside an empty array.
    assert.equal(withProvenance([], { source: "NSE_SHP" }).empty, true);
  });

  it("honours emptyOverride for payloads whose emptiness is not a length", () => {
    assert.equal(withProvenance({ a: 1 }, { emptyOverride: true }).empty, true);
    assert.equal(withProvenance([], { emptyOverride: false }).empty, false);
  });
});

describe("withProvenance — envelope fields", () => {
  it("carries source and normalises asOf to ISO", () => {
    const out = withProvenance([{ x: 1 }], {
      source: "NSE_SHP",
      asOf: new Date("2026-08-14T00:00:00.000Z"),
    });
    assert.equal(out.source, "NSE_SHP");
    assert.equal(out.asOf, "2026-08-14T00:00:00.000Z");
  });

  it("defaults source and asOf to null, never to a placeholder", () => {
    const out = withProvenance([{ x: 1 }]);
    assert.equal(out.source, null);
    assert.equal(out.asOf, null);
  });

  it("rejects an invalid date rather than emitting a bogus timestamp", () => {
    assert.equal(withProvenance([], { asOf: new Date("nope") }).asOf, null);
    assert.equal(withProvenance([], { asOf: "" }).asOf, null);
  });

  it("omits `fallback` unless it is genuinely true", () => {
    // Present-and-false would render a "fallback" chip on the primary path in
    // any UI that checks for the key rather than the value.
    assert.equal("fallback" in withProvenance([], {}), false);
    assert.equal("fallback" in withProvenance([], { fallback: false }), false);
    assert.equal(withProvenance([], { fallback: true }).fallback, true);
  });

  it("passes data through untouched", () => {
    const rows = [{ symbol: "RELIANCE" }];
    assert.equal(withProvenance(rows).data, rows);
  });
});

describe("latestAsOf", () => {
  const rows = [
    { date: new Date("2026-08-10T00:00:00Z") },
    { date: new Date("2026-08-14T00:00:00Z") },
    { date: new Date("2026-08-12T00:00:00Z") },
  ];

  it("returns the newest date", () => {
    assert.equal(latestAsOf(rows)?.toISOString(), "2026-08-14T00:00:00.000Z");
  });

  it("returns null for no rows — never 'now'", () => {
    // Stamping an empty section with the current time is exactly the lie asOf
    // exists to prevent: it would make a section that has never had data look
    // like it updated seconds ago.
    assert.equal(latestAsOf([]), null);
  });

  it("skips unparseable values instead of coercing them", () => {
    // One malformed row must not be able to make a whole section look fresh,
    // and must not discard the good rows either.
    const mixed = [
      { date: "not-a-date" },
      { date: null },
      { date: "2026-08-11T00:00:00Z" },
    ];
    assert.equal(latestAsOf(mixed)?.toISOString(), "2026-08-11T00:00:00.000Z");
  });

  it("returns null when every value is unparseable", () => {
    assert.equal(latestAsOf([{ date: "x" }, { date: undefined }]), null);
  });

  it("reads a custom field name", () => {
    assert.equal(
      latestAsOf([{ quarter: "2026-06-30" }], "quarter")
        ?.toISOString()
        .slice(0, 10),
      "2026-06-30",
    );
  });

  it("accepts ISO strings and epoch numbers", () => {
    const t = Date.UTC(2026, 7, 14);
    assert.equal(latestAsOf([{ date: t }])?.getTime(), t);
    assert.equal(latestAsOf([{ date: "2026-08-14" }])?.getTime(), t);
  });
});
