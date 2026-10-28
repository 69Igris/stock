/**
 * Negative / edge-case coverage for the REAL exported MutualFundFormSchema.
 *
 * Source: packages/validation/src/mutual-fund/index.ts
 *
 * Imports & exercises the actual schema (no shadow). MONEY-620 hardening added
 * `.finite()` to units/averageNav/currentNav/sipAmount. `sipDate` is bounded
 * 1..28 (Indian SIP-mandate day-of-month window).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MutualFundFormSchema } from "../src/mutual-fund/index.ts";

describe("MutualFundFormSchema (real export)", () => {
  const valid = { schemeName: "Axis Bluechip", units: 100, averageNav: 25.5 };

  it("accepts a minimal valid MF and applies defaults", () => {
    const r = MutualFundFormSchema.safeParse(valid);
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.category, "Equity");
    assert.equal(r.data.sipActive, false);
    assert.equal(r.data.brokerName, "manual");
  });

  it("rejects empty schemeName (required)", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, schemeName: "" });
    assert.equal(r.success, false);
  });

  it("rejects missing schemeName (required field absent)", () => {
    const { schemeName: _omit, ...rest } = valid;
    void _omit;
    const r = MutualFundFormSchema.safeParse(rest);
    assert.equal(r.success, false);
  });

  it("rejects zero units (must be positive)", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, units: 0 });
    assert.equal(r.success, false);
  });

  it("rejects negative units", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, units: -1 });
    assert.equal(r.success, false);
  });

  it("rejects NaN units", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, units: NaN });
    assert.equal(r.success, false);
  });

  it("rejects Infinity units — MONEY-620 .finite() guard", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, units: Infinity });
    assert.equal(r.success, false);
  });

  it("rejects zero averageNav", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, averageNav: 0 });
    assert.equal(r.success, false);
  });

  it("rejects Infinity averageNav — MONEY-620 .finite() guard", () => {
    const r = MutualFundFormSchema.safeParse({
      ...valid,
      averageNav: Infinity,
    });
    assert.equal(r.success, false);
  });

  it("rejects Infinity currentNav — MONEY-620 .finite() guard", () => {
    const r = MutualFundFormSchema.safeParse({
      ...valid,
      currentNav: Infinity,
    });
    assert.equal(r.success, false);
  });

  it("rejects Infinity sipAmount — MONEY-620 .finite() guard", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, sipAmount: Infinity });
    assert.equal(r.success, false);
  });

  it("accepts a null sipAmount (nullable)", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, sipAmount: null });
    assert.equal(r.success, true);
  });

  it("rejects sipDate below 1 (day-of-month floor)", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, sipDate: 0 });
    assert.equal(r.success, false);
  });

  it("rejects sipDate above 28 (day-of-month cap)", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, sipDate: 29 });
    assert.equal(r.success, false);
  });

  it("accepts sipDate at the 28 boundary", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, sipDate: 28 });
    assert.equal(r.success, true);
  });

  it("rejects a non-boolean sipActive", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, sipActive: "yes" });
    assert.equal(r.success, false);
  });

  it("rejects a string units (wrong type, no coercion)", () => {
    const r = MutualFundFormSchema.safeParse({ ...valid, units: "100" });
    assert.equal(r.success, false);
  });
});
