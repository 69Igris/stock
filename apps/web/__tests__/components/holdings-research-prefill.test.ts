import { test } from "node:test";
import assert from "node:assert/strict";
import {
  holdingToPositionPreData,
  holdingToPositionPrefill,
  prefillToPositionData,
  PREFILL_PURCHASE_DATE,
} from "../../app/holdings/holdings-research-prefill";

// MONEY-400 - De-shadowed: imports the REAL holding → positionData transform
// from app/holdings/holdings-research-prefill.ts. Both Holdings render sites
// call holdingToPositionPrefill(r) and HoldingRowActions calls
// prefillToPositionData(prefill); their composition IS holdingToPositionPreData,
// so this test exercises the production path (no React render, no Clerk/Prisma).

test("holding with t1 stock rolls into total quantity", () => {
  const h = {
    quantity: 80,
    t1Quantity: 20,
    averagePrice: 1500,
    currentPrice: 1800,
    unrealizedPnL: 30_000,
  };
  const pre = holdingToPositionPreData(h);
  assert.equal(pre.quantity, 100);
  assert.equal(pre.purchasePrice, 1500);
  assert.equal(pre.status, "open");
});

test("holding without t1 still produces full prefill", () => {
  const h = {
    quantity: 50,
    averagePrice: 800,
    currentPrice: 920,
    unrealizedPnL: 6_000,
  };
  const pre = holdingToPositionPreData(h);
  assert.equal(pre.quantity, 50);
  assert.equal(pre.unrealizedPnL, 6_000);
  assert.equal(pre.currentPrice, 920);
});

test("negative unrealised PnL is preserved (loss-making holdings)", () => {
  const h = {
    quantity: 120,
    averagePrice: 698,
    currentPrice: 482,
    unrealizedPnL: -25_920,
  };
  const pre = holdingToPositionPreData(h);
  assert.equal(pre.unrealizedPnL, -25_920);
  // status remains "open" - we don't infer closed from negative pnl
  assert.equal(pre.status, "open");
});

test("uses the shared purchaseDate placeholder until lot-tracking lands", () => {
  const pre = holdingToPositionPreData({
    quantity: 10,
    averagePrice: 100,
    currentPrice: 110,
    unrealizedPnL: 100,
  });
  assert.equal(pre.purchaseDate, PREFILL_PURCHASE_DATE);
  assert.equal(pre.purchaseDate, "since first lot");
});

test("two-step production path (prefill → positionData) equals the composed transform", () => {
  // This is what the two render sites + HoldingRowActions actually do.
  const h = {
    quantity: 80,
    t1Quantity: 20,
    averagePrice: 1500,
    currentPrice: 1800,
    unrealizedPnL: 30_000,
  };
  const split = prefillToPositionData(holdingToPositionPrefill(h));
  assert.deepEqual(split, holdingToPositionPreData(h));
});

test("null/undefined t1Quantity is treated as zero", () => {
  const withNull = holdingToPositionPreData({
    quantity: 40,
    t1Quantity: null,
    averagePrice: 100,
    currentPrice: 100,
    unrealizedPnL: 0,
  });
  assert.equal(withNull.quantity, 40);
  const withUndef = holdingToPositionPreData({
    quantity: 40,
    averagePrice: 100,
    currentPrice: 100,
    unrealizedPnL: 0,
  });
  assert.equal(withUndef.quantity, 40);
});
