/**
 * Kite value normalizers — MONEY-582e.
 *
 * kite-normalize.ts is dependency-free, so this imports the real implementation
 * directly (no inline-copy, no drift).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toFiniteNumber,
  normalizeSide,
} from "../../lib/brokers/clients/kite-normalize";

describe("toFiniteNumber (MONEY-582e NaN guard)", () => {
  it("passes finite numbers through", () => {
    assert.equal(toFiniteNumber(10), 10);
    assert.equal(toFiniteNumber(0), 0);
    assert.equal(toFiniteNumber(-3.5), -3.5);
  });

  it("coerces numeric strings", () => {
    assert.equal(toFiniteNumber("10"), 10);
    assert.equal(toFiniteNumber("3.5"), 3.5);
  });

  it("returns 0 for non-finite / junk (prevents NaN poisoning qty*price)", () => {
    assert.equal(toFiniteNumber("abc"), 0);
    assert.equal(toFiniteNumber(null), 0);
    assert.equal(toFiniteNumber(undefined), 0);
    assert.equal(toFiniteNumber(NaN), 0);
    assert.equal(toFiniteNumber(Infinity), 0);
    assert.equal(toFiniteNumber({}), 0);
  });

  it("a junk price yields value 0, not NaN", () => {
    const qty = toFiniteNumber("5");
    const price = toFiniteNumber("not-a-price");
    assert.equal(qty * price, 0);
    assert.ok(!Number.isNaN(qty * price));
  });
});

describe("normalizeSide (MONEY-582e pairing correctness)", () => {
  it("accepts canonical BUY/SELL", () => {
    assert.equal(normalizeSide("BUY"), "BUY");
    assert.equal(normalizeSide("SELL"), "SELL");
  });

  it("uppercases + trims mis-cased values (the common drift)", () => {
    assert.equal(normalizeSide("buy"), "BUY");
    assert.equal(normalizeSide(" Sell "), "SELL");
  });

  it("returns null for unrecognized sides (so caller can skip, not mis-pair)", () => {
    assert.equal(normalizeSide("HOLD"), null);
    assert.equal(normalizeSide(""), null);
    assert.equal(normalizeSide(null), null);
    assert.equal(normalizeSide(undefined), null);
    assert.equal(normalizeSide(1), null);
  });
});
