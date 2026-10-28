/**
 * `ObjectSummary`'s numeric coercion — MONEY-1474.
 *
 * A ledger uses `generation` as half its identity ("pins WHICH version of the
 * object was read"), so the difference between "absent" and "zero" is the
 * difference between a missing pin and a pin that matches no object which has
 * ever existed. This exists because the obvious spelling gets it wrong.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { numOrNull } from "../src/index";

describe("absent must not become a confident zero", () => {
  it("null, undefined and empty string are all NULL, not 0", () => {
    // THE TRAP, verified in node: `Number(null)` is 0 and `Number("")` is 0,
    // and BOTH pass `Number.isFinite`. So the natural
    // `Number.isFinite(Number(x)) ? Number(x) : null` records an absent
    // generation as `0` — a fail-open default where this repo's standing rule
    // is that "couldn't determine" must be its own value.
    assert.equal(Number(null), 0, "the trap this guards: Number(null) is 0");
    assert.equal(Number(""), 0, "and so is Number('')");
    assert.ok(Number.isFinite(Number(null)), "and it passes isFinite");

    assert.equal(numOrNull(null), null);
    assert.equal(numOrNull(undefined), null);
    assert.equal(numOrNull(""), null);
  });

  it("a real generation survives, as a number", () => {
    // The JSON API returns these as STRINGS. A real generation is ~1.758e15,
    // comfortably inside MAX_SAFE_INTEGER (9.007e15), so Number is safe here.
    assert.equal(numOrNull("1758000000000000"), 1758000000000000);
    assert.equal(numOrNull(4096), 4096);
    assert.ok(1758000000000000 < Number.MAX_SAFE_INTEGER);
  });

  it("a genuine zero is preserved — 0 bytes is a fact, not an absence", () => {
    // The caller decides what a zero MEANS (the ledger refuses it); this
    // function must not decide for it by folding 0 into null.
    assert.equal(numOrNull(0), 0);
    assert.equal(numOrNull("0"), 0);
  });

  it("garbage is NULL rather than NaN", () => {
    // NaN poisons every total downstream and renders as "—".
    assert.equal(numOrNull("not-a-number"), null);
    assert.equal(numOrNull({}), null);
  });
});
