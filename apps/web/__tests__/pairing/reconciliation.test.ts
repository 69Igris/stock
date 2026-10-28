/**
 * Holdings ↔ pairing reconciliation tests (MONEY-840).
 *
 * Exercises the REAL `reconcileOpenLotsVsHoldings` export from
 * `lib/pairing/pairing-logic.ts` that `service.ts` calls — no shadow copy, no
 * Prisma. Invariant: per security + account, Σ open PairedTradeView lot quantity
 * === Holding.quantity + Holding.t1Quantity (within RECON_QUANTITY_EPSILON).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileOpenLotsVsHoldings,
  RECON_QUANTITY_EPSILON,
  type ReconOpenLot,
  type ReconHolding,
} from "@/lib/pairing/pairing-logic";

function lot(overrides: Partial<ReconOpenLot> = {}): ReconOpenLot {
  return {
    symbol: "TATAELXSI",
    isin: "INE670A01012",
    exchange: "NSE",
    broker: "ZERODHA",
    brokerUserId: "AB1234",
    quantity: 10,
    ...overrides,
  };
}

function holding(overrides: Partial<ReconHolding> = {}): ReconHolding {
  return {
    symbol: "TATAELXSI",
    isin: "INE670A01012",
    exchange: "NSE",
    broker: "ZERODHA",
    brokerUserId: "AB1234",
    quantity: 10,
    t1Quantity: 0,
    ...overrides,
  };
}

describe("reconciliation: reconcileOpenLotsVsHoldings", () => {
  it("Σ open lots == Holding.quantity → no drift", () => {
    const report = reconcileOpenLotsVsHoldings(
      [lot({ quantity: 6 }), lot({ quantity: 4 })],
      [holding({ quantity: 10 })]
    );
    assert.equal(report.ok, true);
    assert.equal(report.drifted.length, 0);
    assert.equal(report.comparedCount, 1);
  });

  it("counts Holding.t1Quantity as part of the position", () => {
    // 8 settled + 2 T1 = 10 held; open lots also 10 → reconciled.
    const report = reconcileOpenLotsVsHoldings(
      [lot({ quantity: 10 })],
      [holding({ quantity: 8, t1Quantity: 2 })]
    );
    assert.equal(report.ok, true);
    assert.equal(report.drifted.length, 0);
  });

  it("flags drift when open lots and held quantity disagree", () => {
    const report = reconcileOpenLotsVsHoldings(
      [lot({ quantity: 12 })],
      [holding({ quantity: 10 })]
    );
    assert.equal(report.ok, false);
    assert.equal(report.drifted.length, 1);
    assert.equal(report.drifted[0].pairedOpenQuantity, 12);
    assert.equal(report.drifted[0].holdingQuantity, 10);
    assert.equal(report.drifted[0].drift, 2);
  });

  it("tolerates sub-epsilon float noise (no false alarm)", () => {
    const report = reconcileOpenLotsVsHoldings(
      [lot({ quantity: 10 + RECON_QUANTITY_EPSILON / 2 })],
      [holding({ quantity: 10 })]
    );
    assert.equal(report.ok, true);
  });

  it("ignores securities with open lots but no matching Holding (F&O / pre-platform)", () => {
    const report = reconcileOpenLotsVsHoldings(
      [lot({ symbol: "NIFTY24JUNFUT", isin: null, quantity: 50 })],
      [] // no holdings at all
    );
    assert.equal(report.ok, true);
    assert.equal(report.comparedCount, 0);
    assert.equal(report.drifted.length, 0);
  });

  it("keys by ISIN so a renamed symbol still reconciles", () => {
    const report = reconcileOpenLotsVsHoldings(
      [lot({ symbol: "OLD_NAME", quantity: 10 })],
      [holding({ symbol: "NEW_NAME", quantity: 10 })] // same ISIN
    );
    assert.equal(report.ok, true);
    assert.equal(report.comparedCount, 1);
  });

  it("scopes by account — two accounts holding the same stock do not net off", () => {
    const report = reconcileOpenLotsVsHoldings(
      [
        lot({ brokerUserId: "ACC_A", quantity: 10 }),
        lot({ brokerUserId: "ACC_B", quantity: 5 }),
      ],
      [
        holding({ brokerUserId: "ACC_A", quantity: 10 }),
        holding({ brokerUserId: "ACC_B", quantity: 5 }),
      ]
    );
    assert.equal(report.ok, true);
    assert.equal(report.comparedCount, 2);
  });

  it("reconciles a 1:5 split: 10 open lots ADJUSTED to 50 == Holding 50 (no false alarm)", () => {
    // After corp-action adjustment the open lot is already in post-split units
    // (50), matching the broker-restated Holding (50). The reconciler sees 50==50.
    const report = reconcileOpenLotsVsHoldings(
      [lot({ quantity: 50 })], // post-split-adjusted open lot
      [holding({ quantity: 50 })] // broker-restated holding
    );
    assert.equal(report.ok, true);
    assert.equal(report.drifted.length, 0);
  });

  it("would flag a split if the lot were NOT adjusted (regression guard)", () => {
    // Pre-adjustment: open lot still 10, Holding restated to 50 → drift 40.
    // This is exactly the false-alarm the cost-basis adjustment removes.
    const report = reconcileOpenLotsVsHoldings(
      [lot({ quantity: 10 })],
      [holding({ quantity: 50 })]
    );
    assert.equal(report.ok, false);
    assert.equal(report.drifted[0].drift, -40);
  });
});
