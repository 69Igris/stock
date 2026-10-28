/**
 * `dedupe-candles.ts` DELETES rows. This pins which one survives. MONEY-1482.
 *
 * ## THE BUG THIS EXISTS FOR, FOUND IN REVIEW AFTER THE SCRIPT HAD ALREADY RUN
 *
 * The tie-break was `String(b._id).localeCompare(String(a._id))`. But
 * `$runCommandRaw` returns ObjectIds as EXTENDED JSON — `{ "$oid": "6a91…" }`,
 * never a string — so `String()` gives `"[object Object]"` for EVERY row, the
 * comparator returned 0 universally, and `Array.sort` (stable) kept whichever
 * row was pushed FIRST: the OLDER one, the exact opposite of the documented
 * "the LATER write is the correction".
 *
 * It decided 100% of the deletions rather than an edge: all 59 QA duplicates
 * were `TIINGO_RT` vs `TIINGO_RT`, so authority tied on every single group and
 * the id was the only discriminator.
 *
 * The lesson generalises past this script: a comparator over a value whose
 * runtime SHAPE was assumed rather than measured fails silently and totally,
 * because `localeCompare` returns a number either way.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { candleDedupeLosers as losersOf } from "../../src/market-data/candles/dedupe-logic";

/** Extended JSON, exactly as `$runCommandRaw` returns it — measured. */
const oid = (hex: string) => ({ $oid: hex });
const OLD = oid("6a91d5a2977abfe64717d0ca");
const NEW = oid("6a91d5a2977abfe64717d0dd");

describe("the survivor is chosen by AUTHORITY first", () => {
  it("a higher-authority source wins regardless of id order", () => {
    // BHAVCOPY 100 > TIINGO_RT 20. The exchange's own print is never displaced
    // by a quote-mid bar, whichever arrived later.
    const rows = [
      { _id: NEW, source: "TIINGO_RT" },
      { _id: OLD, source: "BHAVCOPY" },
    ];
    const losers = losersOf(rows);
    assert.ok(losers !== null);
    assert.deepEqual(losers, [{ _id: NEW, source: "TIINGO_RT" }]);
  });

  it("an unknown source ranks last, never first", () => {
    const rows = [
      { _id: OLD, source: "SOMETHING_NEW" },
      { _id: NEW, source: "DATABENTO" },
    ];
    const losers = losersOf(rows)!;
    assert.equal(losers.length, 1);
    assert.equal(losers[0]!.source, "SOMETHING_NEW");
  });
});

describe("on a tie, the LATER write survives — the bug that shipped", () => {
  it("keeps the newer id when both sources are identical", () => {
    // THE REGRESSION. Order the input oldest-first so a broken comparator's
    // stable sort keeps the OLD row and this fails.
    const rows = [
      { _id: OLD, source: "TIINGO_RT" },
      { _id: NEW, source: "TIINGO_RT" },
    ];
    const losers = losersOf(rows)!;
    assert.deepEqual(
      losers,
      [{ _id: OLD, source: "TIINGO_RT" }],
      "the OLDER row must be deleted; a second write of the same source is a correction",
    );
  });

  it("and the same holds when the input arrives newest-first", () => {
    // Input order must not decide the outcome — that was the whole defect.
    const losers = losersOf([
      { _id: NEW, source: "TIINGO_RT" },
      { _id: OLD, source: "TIINGO_RT" },
    ])!;
    assert.deepEqual(losers, [{ _id: OLD, source: "TIINGO_RT" }]);
  });
});

describe("a group it cannot rank is REFUSED, not guessed", () => {
  it("equal authority and an unusable id returns null", () => {
    // The safety docblock promises this. The previous `slice(1)` returned n-1
    // losers unconditionally, so `unrankable` was unreachable and the promise
    // was false for every group.
    assert.equal(
      losersOf([
        { _id: { nope: 1 }, source: "TIINGO_RT" },
        { _id: NEW, source: "TIINGO_RT" },
      ]),
      null,
    );
  });

  it("but an unusable id is fine when AUTHORITY can decide", () => {
    // Refusing here would strand real duplicates the script can rank perfectly
    // well — the refusal is for "no ground to choose", not "anything odd".
    const losers = losersOf([
      { _id: { nope: 1 }, source: "TIINGO_RT" },
      { _id: NEW, source: "BHAVCOPY" },
    ]);
    assert.ok(losers !== null);
    assert.equal(losers!.length, 1);
    assert.equal(losers![0]!.source, "TIINGO_RT");
  });

  it("a single row has no losers and is not a refusal", () => {
    assert.deepEqual(losersOf([{ _id: NEW, source: "TIINGO_RT" }]), []);
  });
});
