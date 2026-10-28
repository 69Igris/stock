/**
 * Zerodha holdings schema-drift guard — MONEY-500 (ZA-2)
 *
 * Tests validateZerodhaHoldingShape: it validates the RAW snake_case Zerodha
 * holdings payload so a rename of a required key (the silent-corruption class)
 * is caught, while new/unexpected keys are forward-compatible drift. The module
 * only depends on `zod`, so this imports the real function.
 *
 * Source: apps/web/lib/brokers/clients/zerodha-holdings-schema.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateZerodhaHoldingShape } from "../../lib/brokers/clients/zerodha-holdings-schema";

const validRow = {
  tradingsymbol: "TCS",
  exchange: "NSE",
  quantity: 10,
  average_price: 3500,
  last_price: 3600,
  isin: "INE467B01029",
  instrument_token: 2953217,
  close_price: 3550,
  pnl: 1000,
  day_change: 50,
  day_change_percentage: 1.4,
  t1_quantity: 0,
  pledged_quantity: 0,
  collateral_quantity: 0,
};

describe("validateZerodhaHoldingShape (MONEY-500 drift guard)", () => {
  it("accepts a valid full payload", () => {
    const r = validateZerodhaHoldingShape([validRow]);
    assert.equal(r.valid, true);
    assert.deepEqual(r.driftKeys, []);
    assert.deepEqual(r.missingRequired, []);
  });

  it("flags an unexpected new key as drift but stays valid (forward-compatible)", () => {
    const r = validateZerodhaHoldingShape([{ ...validRow, mtf_v2: { x: 1 } }]);
    assert.equal(r.valid, true);
    assert.ok(r.driftKeys.includes("mtf_v2"));
    assert.deepEqual(r.missingRequired, []);
  });

  it("flags a missing required key as invalid (the corruption class)", () => {
    const noLastPrice: Record<string, unknown> = { ...validRow };
    delete noLastPrice.last_price;
    const r = validateZerodhaHoldingShape([noLastPrice]);
    assert.equal(r.valid, false);
    assert.ok(r.missingRequired.includes("last_price"));
  });

  it("flags a renamed required key (last_price → ltp) as BOTH missing + drift", () => {
    const renamed: Record<string, unknown> = { ...validRow, ltp: 3600 };
    delete renamed.last_price;
    const r = validateZerodhaHoldingShape([renamed]);
    assert.equal(r.valid, false);
    assert.ok(r.missingRequired.includes("last_price"));
    assert.ok(r.driftKeys.includes("ltp"));
  });

  it("treats an empty array as valid", () => {
    const r = validateZerodhaHoldingShape([]);
    assert.equal(r.valid, true);
    assert.deepEqual(r.driftKeys, []);
    assert.deepEqual(r.missingRequired, []);
  });

  it("does NOT false-flag the intentional name=symbol mapping (validates raw, not normalized)", () => {
    // The raw payload has no `name` field — name=symbol is set in the mapper.
    // The guard validates the RAW snake_case shape, so it never sees `name`.
    const r = validateZerodhaHoldingShape([validRow]);
    assert.equal(r.valid, true);
    assert.ok(!r.driftKeys.includes("name"));
  });
});
