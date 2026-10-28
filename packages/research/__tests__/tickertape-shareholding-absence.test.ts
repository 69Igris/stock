/**
 * `mapTickertapeShareholdingRows` — the absence rules — MONEY-1205.
 *
 * ## What this file deliberately does NOT assert
 *
 * Which key carries the quarter label. `tickertape-statement-mapper.test.ts`
 * establishes, from CAPTURED fixtures, that the sibling income endpoint keys its
 * period as `displayPeriod` and not `period` — and that a hand-written input can
 * only ever prove a mapper self-consistent with the assumption that produced it.
 * No shareholding fixture has been captured, so no test here may claim to know
 * the wire format. The mapper accepts both spellings; that is a hedge, not a
 * finding.
 *
 * What IS assertable without a fixture is the mapper's own contract: it must not
 * invent values for things the payload did not contain. Every case below is
 * about absence, and holds whichever key the API turns out to use.
 *
 * ## Why absence is the whole bug
 *
 * The mapper used to read `(row.prmotrHldng as number) ?? 0` and
 * `(row.period as string) ?? ""`. `fetchShareholdingChain` runs
 * Tickertape → Screener through `tryChain`, which returns the FIRST NON-NULL
 * result. So a successful HTTP call yielding label-less, zero-filled rows was
 * still a non-null array: it WON the chain, Screener never ran, and the UI
 * received a populated-looking response that asserted "FIIs own 0.00%" — a
 * claim the feed never made and which is indistinguishable from a real zero.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mapTickertapeShareholdingRows } from "../src/data-sources/tickertape-client";

/** A row that is valid under EITHER quarter spelling, so no test depends on one. */
const good = (over: Record<string, unknown> = {}) => ({
  period: "Q1 FY26",
  prmotrHldng: 55.5,
  fiiHldng: 12.25,
  diiHldng: 18,
  publicHldng: 14.25,
  ...over,
});

describe("mapTickertapeShareholdingRows — absence is never a zero", () => {
  it("passes real numbers through untouched, including a genuine 0", () => {
    const out = mapTickertapeShareholdingRows([good({ fiiHldng: 0 })]);
    assert.ok(out);
    assert.equal(out[0]!.promoter, 55.5);
    // A reported 0 is DATA and must survive. The fix must not overcorrect into
    // treating every zero as missing.
    assert.equal(out[0]!.fii, 0);
  });

  it("an ABSENT holding becomes null, not 0", () => {
    const { fiiHldng: _drop, ...withoutFii } = good();
    const out = mapTickertapeShareholdingRows([withoutFii]);
    assert.ok(out);
    assert.equal(out[0]!.fii, null);
    assert.notEqual(
      out[0]!.fii,
      0,
      "0 is a holding; null is the absence of one",
    );
    assert.equal(out[0]!.promoter, 55.5, "siblings are unaffected");
  });

  it("non-numeric and non-finite holdings become null", () => {
    // `Number("")` is 0, so a string that slipped through would otherwise be
    // read as a zero holding — the exact absence→zero trap this closes.
    const out = mapTickertapeShareholdingRows([
      good({
        prmotrHldng: "",
        fiiHldng: null,
        diiHldng: NaN,
        publicHldng: 14.25,
      }),
    ]);
    assert.ok(out);
    assert.equal(out[0]!.promoter, null);
    assert.equal(out[0]!.fii, null);
    assert.equal(out[0]!.dii, null);
    assert.equal(out[0]!.public, 14.25);
  });

  it("a row with no quarter label is DROPPED, not emitted with an empty one", () => {
    const { period: _p, ...noQuarter } = good();
    const out = mapTickertapeShareholdingRows([noQuarter, good()]);
    assert.ok(out);
    assert.equal(out.length, 1, "the unlabelled row must not survive");
    assert.equal(out[0]!.quarter, "Q1 FY26");
  });

  it("a blank/whitespace quarter is treated as absent", () => {
    const out = mapTickertapeShareholdingRows([good({ period: "   " })]);
    assert.equal(out, null);
  });

  it("a labelled row carrying NO holdings at all is dropped", () => {
    const out = mapTickertapeShareholdingRows([
      {
        period: "Q1 FY26",
        prmotrHldng: null,
        fiiHldng: undefined,
        diiHldng: "n/a",
        publicHldng: NaN,
      },
    ]);
    assert.equal(
      out,
      null,
      "a label with nothing under it is not a data point",
    );
  });

  it("ONE surviving holding is enough to keep the row", () => {
    const out = mapTickertapeShareholdingRows([
      { period: "Q1 FY26", diiHldng: 18 },
    ]);
    assert.ok(out);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.dii, 18);
    assert.equal(out[0]!.promoter, null);
  });

  it("returns NULL when nothing is usable, so the chain falls through", () => {
    // This is the whole point. `tryChain` takes the first NON-NULL result, so
    // returning [] here would still beat Screener and silently win with nothing.
    assert.equal(mapTickertapeShareholdingRows([]), null);
    assert.equal(mapTickertapeShareholdingRows([{}, {}]), null);
    assert.notDeepEqual(
      mapTickertapeShareholdingRows([{}]),
      [],
      "an empty array is non-null and would starve the Screener fallback",
    );
  });

  it("accepts either quarter spelling — a hedge, not a claim about the API", () => {
    const viaPeriod = mapTickertapeShareholdingRows([
      { period: "Q1 FY26", prmotrHldng: 1 },
    ]);
    const viaDisplay = mapTickertapeShareholdingRows([
      { displayPeriod: "Q1 FY26", prmotrHldng: 1 },
    ]);
    assert.equal(viaPeriod?.[0]?.quarter, "Q1 FY26");
    assert.equal(viaDisplay?.[0]?.quarter, "Q1 FY26");
  });
});
