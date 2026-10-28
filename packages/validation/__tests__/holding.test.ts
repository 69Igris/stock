/**
 * Negative / edge-case coverage for the REAL exported HoldingFormSchema.
 *
 * Source: packages/validation/src/holding/index.ts
 *
 * Imports & exercises the actual schema (no shadow). MONEY-620 hardening added
 * `.finite()` to quantity/averagePrice/currentPrice so an `Infinity` value can
 * no longer pass `.positive()` and flow into portfolio-value math.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HoldingFormSchema } from "../src/holding/index.ts";

describe("HoldingFormSchema (real export)", () => {
  const valid = { symbol: "tcs", quantity: 10, averagePrice: 99.5 };

  it("accepts a minimal valid holding and applies defaults + uppercasing", () => {
    const r = HoldingFormSchema.safeParse(valid);
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.symbol, "TCS");
    assert.equal(r.data.sector, "Other");
    assert.equal(r.data.exchange, "NSE");
    assert.equal(r.data.brokerName, "manual");
  });

  it("rejects empty symbol", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, symbol: "" });
    assert.equal(r.success, false);
  });

  it("rejects missing symbol (required field absent)", () => {
    const { symbol: _omit, ...rest } = valid;
    void _omit;
    const r = HoldingFormSchema.safeParse(rest);
    assert.equal(r.success, false);
  });

  it("rejects oversized symbol (> 50 chars)", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, symbol: "A".repeat(51) });
    assert.equal(r.success, false);
  });

  it("accepts symbol at the 50-char boundary", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, symbol: "A".repeat(50) });
    assert.equal(r.success, true);
  });

  it("rejects out-of-enum exchange (only NSE/BSE allowed)", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, exchange: "NFO" });
    assert.equal(r.success, false);
  });

  it("accepts BSE exchange", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, exchange: "BSE" });
    assert.equal(r.success, true);
  });

  it("rejects zero quantity (must be positive)", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, quantity: 0 });
    assert.equal(r.success, false);
  });

  it("rejects negative quantity", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, quantity: -1 });
    assert.equal(r.success, false);
  });

  it("rejects NaN quantity", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, quantity: NaN });
    assert.equal(r.success, false);
  });

  it("rejects Infinity quantity — MONEY-620 .finite() guard", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, quantity: Infinity });
    assert.equal(r.success, false);
  });

  it("rejects a string quantity (wrong type, no coercion)", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, quantity: "10" });
    assert.equal(r.success, false);
  });

  it("rejects negative averagePrice", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, averagePrice: -0.01 });
    assert.equal(r.success, false);
  });

  it("rejects Infinity averagePrice — MONEY-620 .finite() guard", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, averagePrice: Infinity });
    assert.equal(r.success, false);
  });

  it("rejects Infinity currentPrice — MONEY-620 .finite() guard", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, currentPrice: Infinity });
    assert.equal(r.success, false);
  });

  it("accepts a finite optional currentPrice", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, currentPrice: 120.25 });
    assert.equal(r.success, true);
  });

  it("strips unknown extra fields (non-strict object)", () => {
    const r = HoldingFormSchema.safeParse({ ...valid, hacked: true });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal("hacked" in r.data, false);
  });
});
