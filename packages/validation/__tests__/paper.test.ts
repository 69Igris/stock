/**
 * Negative / edge-case coverage for the REAL exported PlaceOrderSchema.
 *
 * Source: packages/validation/src/paper.ts
 *
 * Imports & exercises the actual schema (no shadow). `quantity` is an integer
 * (already rejects Infinity/NaN/floats via `.int()`). MONEY-620 hardening added
 * `.finite()` to the NON-integer positive price fields (price/triggerPrice/
 * stopLoss/target/strikePrice). `expiry` uses `z.coerce.date()` which rejects
 * unparseable date strings as an invalid Date.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlaceOrderSchema } from "../src/paper.ts";

describe("PlaceOrderSchema (real export)", () => {
  const valid = {
    symbol: "TCS",
    name: "Tata Consultancy",
    side: "BUY",
    quantity: 10,
  };

  it("accepts a minimal valid order and applies defaults", () => {
    const r = PlaceOrderSchema.safeParse(valid);
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.exchange, "NSE");
    assert.equal(r.data.instrumentType, "EQUITY");
    assert.equal(r.data.orderType, "MARKET");
  });

  it("rejects empty symbol", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, symbol: "" });
    assert.equal(r.success, false);
  });

  it("rejects empty name", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, name: "" });
    assert.equal(r.success, false);
  });

  it("rejects an out-of-enum side", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, side: "HOLD" });
    assert.equal(r.success, false);
  });

  it("rejects a missing side (required, no default)", () => {
    const { side: _omit, ...rest } = valid;
    void _omit;
    const r = PlaceOrderSchema.safeParse(rest);
    assert.equal(r.success, false);
  });

  it("rejects an out-of-enum orderType", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, orderType: "GTT" });
    assert.equal(r.success, false);
  });

  it("rejects zero quantity (must be positive)", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, quantity: 0 });
    assert.equal(r.success, false);
  });

  it("rejects negative quantity", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, quantity: -5 });
    assert.equal(r.success, false);
  });

  it("rejects a fractional quantity (must be an integer)", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, quantity: 1.5 });
    assert.equal(r.success, false);
  });

  it("rejects Infinity quantity (int guard)", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, quantity: Infinity });
    assert.equal(r.success, false);
  });

  it("rejects NaN quantity", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, quantity: NaN });
    assert.equal(r.success, false);
  });

  it("rejects negative price", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, price: -1 });
    assert.equal(r.success, false);
  });

  it("rejects Infinity price — MONEY-620 .finite() guard", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, price: Infinity });
    assert.equal(r.success, false);
  });

  it("rejects Infinity stopLoss — MONEY-620 .finite() guard", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, stopLoss: Infinity });
    assert.equal(r.success, false);
  });

  it("rejects Infinity strikePrice — MONEY-620 .finite() guard", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, strikePrice: Infinity });
    assert.equal(r.success, false);
  });

  it("rejects a fractional lotSize (must be an integer)", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, lotSize: 2.5 });
    assert.equal(r.success, false);
  });

  it("rejects an unparseable expiry date string (coerce.date invalid)", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, expiry: "not-a-date" });
    assert.equal(r.success, false);
  });

  it("coerces a valid ISO expiry string into a Date", () => {
    const r = PlaceOrderSchema.safeParse({
      ...valid,
      expiry: "2024-12-26T00:00:00.000Z",
    });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.ok(r.data.expiry instanceof Date);
  });

  it("strips unknown extra fields (non-strict object)", () => {
    const r = PlaceOrderSchema.safeParse({ ...valid, sneaky: 1 });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal("sneaky" in r.data, false);
  });
});
