/**
 * Corporate-action cost-basis adjustment tests (MONEY-840).
 *
 * Exercises the REAL exports from `@usemoney/core/pairing`:
 *  - the pure matcher/scaler (`corpActionAppliesToLot`, `computeCostBasisAdjustment`)
 *  - `pairTradesFIFO` end-to-end with a `corporateActions` argument
 *
 * Invariant under test: a SPLIT/BONUS restates an OPEN BUY lot into post-action
 * units BEFORE FIFO matching — quantity ×ratio, per-unit price ÷ratio, TOTAL
 * COST preserved. Dividends never adjust. Re-running with the same inputs yields
 * identical lots (idempotent). No shadow copies — production path is the code
 * under test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pairTradesFIFO,
  corpActionAppliesToLot,
  computeCostBasisAdjustment,
  type TradeInput,
  type CorporateActionInput,
  type CostBasisLot,
} from "@usemoney/core/pairing";

// ── fixtures ─────────────────────────────────────────────────────────────
function createTrade(overrides: Partial<TradeInput> = {}): TradeInput {
  return {
    id: `trade-${Math.random().toString(36).slice(2, 11)}`,
    userId: "user-1",
    symbol: "TATAELXSI",
    isin: "INE670A01012",
    exchange: "NSE",
    segment: "CASH",
    broker: null,
    brokerUserId: null,
    tradeType: "BUY",
    positionType: "LONG",
    productType: "CNC",
    quantity: 10,
    price: 1000,
    tradeDate: new Date("2024-01-15"),
    tradeTime: new Date("2024-01-15T10:00:00"),
    sourceType: "SYNCED",
    ...overrides,
  };
}

function createAction(
  overrides: Partial<CorporateActionInput> = {}
): CorporateActionInput {
  return {
    id: `ca-${Math.random().toString(36).slice(2, 11)}`,
    symbol: "TATAELXSI",
    isin: "INE670A01012",
    exchange: "NSE",
    type: "SPLIT",
    exDate: new Date("2024-06-01"),
    ratio: 5,
    ...overrides,
  };
}

// A fixed "now" well after every fixture ex-date so the time window never
// excludes an action we expect to apply.
const NOW = new Date("2025-01-01T00:00:00Z");

const lotOf = (t: TradeInput): CostBasisLot => ({
  isin: t.isin,
  symbol: t.symbol,
  exchange: t.exchange,
  tradeDate: t.tradeTime ?? t.tradeDate,
});

// ── corpActionAppliesToLot ─────────────────────────────────────────────────
describe("corp-actions: corpActionAppliesToLot", () => {
  const lot = lotOf(createTrade({ tradeDate: new Date("2024-01-15") }));

  it("applies a SPLIT whose exDate is strictly after the lot's tradeDate", () => {
    const action = createAction({ exDate: new Date("2024-06-01"), ratio: 5 });
    assert.equal(corpActionAppliesToLot(action, lot, NOW), true);
  });

  it("does NOT apply when exDate is before the lot's tradeDate", () => {
    const action = createAction({ exDate: new Date("2023-01-01"), ratio: 5 });
    assert.equal(corpActionAppliesToLot(action, lot, NOW), false);
  });

  it("does NOT apply when exDate equals the lot's tradeDate (strictly after)", () => {
    const action = createAction({ exDate: new Date("2024-01-15"), ratio: 5 });
    assert.equal(corpActionAppliesToLot(action, lot, NOW), false);
  });

  it("does NOT apply an action whose exDate is in the future relative to now", () => {
    const action = createAction({
      exDate: new Date("2026-01-01"),
      ratio: 5,
    });
    assert.equal(corpActionAppliesToLot(action, lot, NOW), false);
  });

  it("DIVIDEND never applies (no cost-basis change)", () => {
    const action = createAction({ type: "DIVIDEND", ratio: null });
    assert.equal(corpActionAppliesToLot(action, lot, NOW), false);
  });

  it("ratio of 1, 0, NaN, Infinity, null never applies", () => {
    for (const ratio of [1, 0, NaN, Infinity, -2, null]) {
      const action = createAction({ ratio: ratio as number | null });
      assert.equal(
        corpActionAppliesToLot(action, lot, NOW),
        false,
        `ratio ${ratio}`
      );
    }
  });

  it("matches by ISIN when both sides carry one (symbol may differ)", () => {
    const renamedLot: CostBasisLot = { ...lot, symbol: "OLD_NAME" };
    const action = createAction({ symbol: "NEW_NAME", isin: lot.isin });
    assert.equal(corpActionAppliesToLot(action, renamedLot, NOW), true);
  });

  it("falls back to symbol match when an ISIN is missing on either side", () => {
    const noIsinLot: CostBasisLot = { ...lot, isin: null };
    const matches = createAction({ isin: null, symbol: lot.symbol });
    const noMatch = createAction({ isin: null, symbol: "OTHER" });
    assert.equal(corpActionAppliesToLot(matches, noIsinLot, NOW), true);
    assert.equal(corpActionAppliesToLot(noMatch, noIsinLot, NOW), false);
  });

  it("never matches across a different exchange", () => {
    const action = createAction({ exchange: "BSE" });
    assert.equal(corpActionAppliesToLot(action, lot, NOW), false);
  });

  it("applies BUYBACK/DEMERGER/MERGER only when a ratio is present (conservative)", () => {
    for (const type of ["BUYBACK", "DEMERGER", "MERGER"]) {
      const withRatio = createAction({ type, ratio: 2 });
      const noRatio = createAction({ type, ratio: null });
      assert.equal(corpActionAppliesToLot(withRatio, lot, NOW), true, type);
      assert.equal(corpActionAppliesToLot(noRatio, lot, NOW), false, type);
    }
  });
});

// ── computeCostBasisAdjustment ─────────────────────────────────────────────
describe("corp-actions: computeCostBasisAdjustment", () => {
  const lot = lotOf(createTrade({ tradeDate: new Date("2024-01-15") }));

  it("returns factor 1 (no-op) when no action applies", () => {
    const { factor, appliedActionIds } = computeCostBasisAdjustment(
      lot,
      [],
      NOW
    );
    assert.equal(factor, 1);
    assert.deepEqual(appliedActionIds, []);
  });

  it("compounds multiple qty-changing actions (1:5 split then 1:1 bonus → ×10)", () => {
    const split = createAction({
      id: "split",
      type: "SPLIT",
      exDate: new Date("2024-06-01"),
      ratio: 5,
    });
    const bonus = createAction({
      id: "bonus",
      type: "BONUS",
      exDate: new Date("2024-09-01"),
      ratio: 2,
    });
    const { factor, appliedActionIds } = computeCostBasisAdjustment(
      lot,
      [split, bonus],
      NOW
    );
    assert.equal(factor, 10);
    assert.deepEqual(new Set(appliedActionIds), new Set(["split", "bonus"]));
  });

  it("is order-independent (ratios multiply)", () => {
    const a = createAction({ id: "a", ratio: 5 });
    const b = createAction({ id: "b", type: "BONUS", ratio: 2 });
    const f1 = computeCostBasisAdjustment(lot, [a, b], NOW).factor;
    const f2 = computeCostBasisAdjustment(lot, [b, a], NOW).factor;
    assert.equal(f1, f2);
  });

  it("skips an action already absorbed in the pass (alreadyApplied)", () => {
    const split = createAction({ id: "split", ratio: 5 });
    const { factor, appliedActionIds } = computeCostBasisAdjustment(
      lot,
      [split],
      NOW,
      new Set(["split"])
    );
    assert.equal(factor, 1);
    assert.deepEqual(appliedActionIds, []);
  });
});

// ── pairTradesFIFO end-to-end with corporate actions ───────────────────────
describe("corp-actions: pairTradesFIFO cost-basis adjustment", () => {
  it("1:5 split adjusts a PRE-split open BUY lot (qty×5, price÷5, total cost preserved)", () => {
    const trades = [
      createTrade({
        id: "buy",
        tradeType: "BUY",
        quantity: 10,
        price: 1000,
        tradeDate: new Date("2024-01-15"),
        tradeTime: new Date("2024-01-15T10:00:00"),
      }),
    ];
    const actions = [
      createAction({ type: "SPLIT", exDate: new Date("2024-06-01"), ratio: 5 }),
    ];

    const result = pairTradesFIFO(trades, actions, NOW);

    assert.equal(result.pairedViews.length, 1);
    const view = result.pairedViews[0];
    assert.equal(view.status, "OPEN");
    assert.equal(view.quantity, 50); // 10 × 5
    assert.equal(view.entryPrice, 200); // 1000 ÷ 5
    assert.equal(view.entryQuantity, 50);
    // Total cost invariant: 10 × 1000 === 50 × 200.
    assert.equal(view.quantity * view.entryPrice, 10 * 1000);
  });

  it("does NOT adjust a lot bought ON/AFTER the split ex-date", () => {
    const trades = [
      createTrade({
        id: "buy",
        tradeType: "BUY",
        quantity: 10,
        price: 200,
        tradeDate: new Date("2024-07-01"), // after ex-date
        tradeTime: new Date("2024-07-01T10:00:00"),
      }),
    ];
    const actions = [
      createAction({ type: "SPLIT", exDate: new Date("2024-06-01"), ratio: 5 }),
    ];

    const result = pairTradesFIFO(trades, actions, NOW);
    const view = result.pairedViews[0];
    assert.equal(view.quantity, 10); // unchanged
    assert.equal(view.entryPrice, 200); // unchanged
  });

  it("1:1 bonus doubles qty and halves price on a pre-bonus BUY lot", () => {
    const trades = [
      createTrade({
        id: "buy",
        tradeType: "BUY",
        quantity: 20,
        price: 500,
        tradeDate: new Date("2024-01-15"),
      }),
    ];
    const actions = [
      createAction({ type: "BONUS", exDate: new Date("2024-06-01"), ratio: 2 }),
    ];

    const result = pairTradesFIFO(trades, actions, NOW);
    const view = result.pairedViews[0];
    assert.equal(view.quantity, 40); // 20 × 2
    assert.equal(view.entryPrice, 250); // 500 ÷ 2
    assert.equal(view.quantity * view.entryPrice, 20 * 500);
  });

  it("DIVIDEND does not adjust the lot", () => {
    const trades = [createTrade({ id: "buy", quantity: 10, price: 1000 })];
    const actions = [
      createAction({
        type: "DIVIDEND",
        ratio: null,
        exDate: new Date("2024-06-01"),
      }),
    ];

    const result = pairTradesFIFO(trades, actions, NOW);
    const view = result.pairedViews[0];
    assert.equal(view.quantity, 10);
    assert.equal(view.entryPrice, 1000);
  });

  it("no corporate actions ⇒ identical to the no-arg call (default [])", () => {
    const trades = [createTrade({ id: "buy", quantity: 10, price: 1000 })];
    const withEmpty = pairTradesFIFO(trades, [], NOW);
    const withDefault = pairTradesFIFO(trades);
    assert.equal(withEmpty.pairedViews[0].quantity, 10);
    assert.equal(withEmpty.pairedViews[0].entryPrice, 1000);
    assert.equal(
      withDefault.pairedViews[0].quantity,
      withEmpty.pairedViews[0].quantity
    );
  });

  it("post-split SELL pairs against an adjusted pre-split BUY at the right cost basis", () => {
    // Buy 10 @ ₹1000 (pre-split) → 50 @ ₹200 after a 1:5 split → sell 50 @ ₹250.
    // Realized P&L = (250 − 200) × 50 = ₹2,500 (NOT a nonsense −₹37,500).
    const trades = [
      createTrade({
        id: "buy",
        tradeType: "BUY",
        quantity: 10,
        price: 1000,
        tradeDate: new Date("2024-01-15"),
        tradeTime: new Date("2024-01-15T10:00:00"),
      }),
      createTrade({
        id: "sell",
        tradeType: "SELL",
        quantity: 50,
        price: 250,
        tradeDate: new Date("2024-09-01"),
        tradeTime: new Date("2024-09-01T10:00:00"),
      }),
    ];
    const actions = [
      createAction({ type: "SPLIT", exDate: new Date("2024-06-01"), ratio: 5 }),
    ];

    const result = pairTradesFIFO(trades, actions, NOW);
    const closed = result.pairedViews.find((v) => v.status === "CLOSED");
    assert.ok(closed, "expected a CLOSED paired view");
    assert.equal(closed!.quantity, 50);
    assert.equal(closed!.entryPrice, 200);
    assert.equal(closed!.exitPrice, 250);
    assert.equal(closed!.realizedPnL, 2500);
    // No residual open lot — the split made the quantities net to zero.
    assert.equal(
      result.pairedViews.some((v) => v.status !== "CLOSED"),
      false
    );
  });

  it("is idempotent: re-running with the same inputs yields identical lots", () => {
    const trades = [
      createTrade({
        id: "buy",
        tradeType: "BUY",
        quantity: 10,
        price: 1000,
        tradeDate: new Date("2024-01-15"),
      }),
    ];
    const actions = [
      createAction({ type: "SPLIT", exDate: new Date("2024-06-01"), ratio: 5 }),
    ];

    const run1 = pairTradesFIFO(trades, actions, NOW);
    const run2 = pairTradesFIFO(trades, actions, NOW);
    // The input trades must not be mutated between runs (purity).
    assert.equal(trades[0].quantity, 10);
    assert.equal(trades[0].price, 1000);
    assert.equal(run1.pairedViews[0].quantity, run2.pairedViews[0].quantity);
    assert.equal(
      run1.pairedViews[0].entryPrice,
      run2.pairedViews[0].entryPrice
    );
    assert.equal(run1.pairedViews[0].quantity, 50);
    assert.equal(run1.pairedViews[0].entryPrice, 200);
  });
});
