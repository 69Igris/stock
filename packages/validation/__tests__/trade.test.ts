/**
 * Negative / edge-case coverage for the REAL exported trade Zod schemas.
 *
 * Source: packages/validation/src/trade/index.ts
 *
 * These tests import and exercise the actual exported schemas (no inline
 * re-declaration / shadow), asserting `.safeParse` REJECTS dangerous/invalid
 * input and ACCEPTS valid boundary input. TradeFormSchema accepts STRING inputs
 * (form-style) and transforms them — so quantity/price are validated AFTER the
 * `transform(Number)` pipe, where `"1e999"` becomes `Infinity`.
 *
 * MONEY-620 hardening: quantity/price/exitPrice now carry `.finite()` so an
 * `Infinity` (from `"1e999"`) can no longer flow into P&L math.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TradeFormSchema,
  ClosePositionSchema,
  TradeFilterSchema,
} from "../src/trade/index.ts";

describe("TradeFormSchema (real export)", () => {
  const valid = {
    tradeDate: "2024-01-15",
    symbol: "tcs",
    quantity: "10",
    price: "100.5",
  };

  it("accepts a minimal valid form input and applies defaults + transforms", () => {
    const r = TradeFormSchema.safeParse(valid);
    assert.equal(r.success, true);
    if (!r.success) return;
    // transform(Number) + uppercase transform
    assert.equal(r.data.symbol, "TCS");
    assert.equal(r.data.quantity, 10);
    assert.equal(r.data.price, 100.5);
    // defaults
    assert.equal(r.data.broker, "manual");
    assert.equal(r.data.exchange, "NSE");
    assert.equal(r.data.segment, "EQUITY");
    assert.equal(r.data.tradeType, "BUY");
    assert.equal(r.data.orderType, "MARKET");
    assert.equal(r.data.productType, "CNC");
    // optional defaults via transform
    assert.equal(r.data.brokerage, 20);
    assert.deepEqual(r.data.tags, []);
  });

  it("rejects empty tradeDate (required, min 1)", () => {
    const r = TradeFormSchema.safeParse({ ...valid, tradeDate: "" });
    assert.equal(r.success, false);
  });

  it("rejects missing tradeDate (required field absent)", () => {
    const { tradeDate: _omit, ...rest } = valid;
    void _omit;
    const r = TradeFormSchema.safeParse(rest);
    assert.equal(r.success, false);
  });

  it("rejects empty symbol", () => {
    const r = TradeFormSchema.safeParse({ ...valid, symbol: "" });
    assert.equal(r.success, false);
  });

  it("rejects oversized symbol (> 50 chars)", () => {
    const r = TradeFormSchema.safeParse({ ...valid, symbol: "A".repeat(51) });
    assert.equal(r.success, false);
  });

  it("accepts symbol at the 50-char boundary", () => {
    const r = TradeFormSchema.safeParse({ ...valid, symbol: "A".repeat(50) });
    assert.equal(r.success, true);
  });

  it("rejects out-of-enum exchange", () => {
    const r = TradeFormSchema.safeParse({ ...valid, exchange: "LSE" });
    assert.equal(r.success, false);
  });

  it("rejects out-of-enum tradeType", () => {
    const r = TradeFormSchema.safeParse({ ...valid, tradeType: "HOLD" });
    assert.equal(r.success, false);
  });

  it("rejects out-of-enum productType", () => {
    const r = TradeFormSchema.safeParse({ ...valid, productType: "CASH" });
    assert.equal(r.success, false);
  });

  it("rejects empty quantity string (required)", () => {
    const r = TradeFormSchema.safeParse({ ...valid, quantity: "" });
    assert.equal(r.success, false);
  });

  it("rejects non-numeric quantity (NaN after transform)", () => {
    const r = TradeFormSchema.safeParse({ ...valid, quantity: "abc" });
    assert.equal(r.success, false);
  });

  it("rejects zero quantity (must be positive)", () => {
    const r = TradeFormSchema.safeParse({ ...valid, quantity: "0" });
    assert.equal(r.success, false);
  });

  it("rejects negative quantity", () => {
    const r = TradeFormSchema.safeParse({ ...valid, quantity: "-5" });
    assert.equal(r.success, false);
  });

  it("rejects Infinity quantity (from '1e999') — MONEY-620 .finite() guard", () => {
    const r = TradeFormSchema.safeParse({ ...valid, quantity: "1e999" });
    assert.equal(r.success, false);
  });

  it("rejects negative price", () => {
    const r = TradeFormSchema.safeParse({ ...valid, price: "-1" });
    assert.equal(r.success, false);
  });

  it("rejects Infinity price (from '1e999') — MONEY-620 .finite() guard", () => {
    const r = TradeFormSchema.safeParse({ ...valid, price: "1e999" });
    assert.equal(r.success, false);
  });

  it("strips unknown extra fields (non-strict object)", () => {
    const r = TradeFormSchema.safeParse({
      ...valid,
      __proto_evil: "<script>",
      injected: 1,
    });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal("__proto_evil" in r.data, false);
    assert.equal("injected" in r.data, false);
  });

  it("rejects a wholly wrong type (string instead of object)", () => {
    const r = TradeFormSchema.safeParse("not-an-object");
    assert.equal(r.success, false);
  });

  it("parses comma-separated tags into a trimmed, non-empty array", () => {
    const r = TradeFormSchema.safeParse({ ...valid, tags: " a, b ,, c " });
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.deepEqual(r.data.tags, ["a", "b", "c"]);
  });
});

describe("ClosePositionSchema (real export)", () => {
  it("accepts a valid positive exit price", () => {
    const r = ClosePositionSchema.safeParse({
      positionId: "pos_1",
      exitPrice: 123.45,
    });
    assert.equal(r.success, true);
  });

  it("rejects empty positionId", () => {
    const r = ClosePositionSchema.safeParse({ positionId: "", exitPrice: 10 });
    assert.equal(r.success, false);
  });

  it("rejects missing positionId", () => {
    const r = ClosePositionSchema.safeParse({ exitPrice: 10 });
    assert.equal(r.success, false);
  });

  it("rejects zero exit price (must be positive)", () => {
    const r = ClosePositionSchema.safeParse({
      positionId: "pos_1",
      exitPrice: 0,
    });
    assert.equal(r.success, false);
  });

  it("rejects negative exit price", () => {
    const r = ClosePositionSchema.safeParse({
      positionId: "pos_1",
      exitPrice: -1,
    });
    assert.equal(r.success, false);
  });

  it("rejects NaN exit price", () => {
    const r = ClosePositionSchema.safeParse({
      positionId: "pos_1",
      exitPrice: NaN,
    });
    assert.equal(r.success, false);
  });

  it("rejects Infinity exit price — MONEY-620 .finite() guard", () => {
    const r = ClosePositionSchema.safeParse({
      positionId: "pos_1",
      exitPrice: Infinity,
    });
    assert.equal(r.success, false);
  });

  it("rejects a string exit price (wrong type — no coercion here)", () => {
    const r = ClosePositionSchema.safeParse({
      positionId: "pos_1",
      exitPrice: "100",
    });
    assert.equal(r.success, false);
  });
});

describe("TradeFilterSchema (real export)", () => {
  it("applies limit/skip defaults on empty input", () => {
    const r = TradeFilterSchema.safeParse({});
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.equal(r.data.limit, 20);
    assert.equal(r.data.skip, 0);
  });

  it("rejects limit below 1", () => {
    const r = TradeFilterSchema.safeParse({ limit: 0 });
    assert.equal(r.success, false);
  });

  it("rejects limit above 100", () => {
    const r = TradeFilterSchema.safeParse({ limit: 101 });
    assert.equal(r.success, false);
  });

  it("accepts limit at the 100 boundary", () => {
    const r = TradeFilterSchema.safeParse({ limit: 100 });
    assert.equal(r.success, true);
  });

  it("rejects negative skip", () => {
    const r = TradeFilterSchema.safeParse({ skip: -1 });
    assert.equal(r.success, false);
  });

  it("rejects a non-number limit (wrong type, no coercion)", () => {
    const r = TradeFilterSchema.safeParse({ limit: "20" });
    assert.equal(r.success, false);
  });
});
