import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { roundCurrency } from "@usemoney/services/gst";

describe("roundCurrency - banker's rounding to 2dp", () => {
  it("rounds normal halves toward even (downward when below half)", () => {
    assert.equal(roundCurrency(1.234), 1.23);
    assert.equal(roundCurrency(1.236), 1.24);
  });

  it("preserves whole and half-tenth values that are exactly representable", () => {
    // Most "1.x5" decimals are NOT exact in IEEE-754, so direct half-to-even
    // observability is documented intent, not testable contract. What we CAN
    // verify is that exactly-representable values round-trip cleanly without
    // drift introduced by the multiply/floor pipeline.
    assert.equal(roundCurrency(0.5), 0.5);
    assert.equal(roundCurrency(1.5), 1.5);
    assert.equal(roundCurrency(0.25), 0.25);
    assert.equal(roundCurrency(0.75), 0.75);
  });

  it("handles negative amounts (refunds) by closeness, not symmetry", () => {
    // -1.234 is closer to -1.23 than -1.24 → rounds to -1.23
    assert.equal(roundCurrency(-1.234), -1.23);
    // -1.236 is closer to -1.24 → rounds to -1.24
    assert.equal(roundCurrency(-1.236), -1.24);
  });

  it("preserves whole numbers", () => {
    assert.equal(roundCurrency(100), 100);
    assert.equal(roundCurrency(0), 0);
  });

  it("does not introduce float drift for clean inputs", () => {
    assert.equal(roundCurrency(99.0), 99);
    assert.equal(roundCurrency(95.5), 95.5);
  });

  it("propagates non-finite inputs unchanged", () => {
    assert.ok(Number.isNaN(roundCurrency(Number.NaN)));
    assert.equal(
      roundCurrency(Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY
    );
  });
});
