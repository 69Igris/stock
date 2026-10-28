/**
 * FIFO pairing — NEGATIVE / EDGE / REGRESSION suite (MONEY-620).
 *
 * Drives the REAL `pairTradesFIFO` / `pairUserTrades` exports (and the now-
 * exported pure helpers `safeTime` / `resolveTradeDate` / `isFiniteQuantity` /
 * `sanitizePrice`) against the adversarial inputs that escape the happy-path
 * suite. These pin the bug class flagged in the de-shadow brief:
 *
 *   - non-finite leaks: a NaN/Infinity/negative quantity must NOT become a
 *     persisted PairedTradeView, and a NaN/Infinity price must NOT poison
 *     `realizedPnL` / `totalRealizedPnL`;
 *   - `new Date(bad).toISOString()` throwing: every emitted entryDate/exitDate
 *     must be a VALID Date even when the source tradeTime/tradeDate is Invalid;
 *   - stable FIFO order on identical timestamps;
 *   - cross-broker AND cross-symbol isolation (must NOT pair across).
 *
 * If `pairTradesFIFO` regresses to leaking non-finite values or Invalid Dates,
 * these fail — the whole point of de-shadowing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pairTradesFIFO,
  pairUserTrades,
  isFiniteQuantity,
  sanitizePrice,
  safeTime,
  resolveTradeDate,
  type TradeInput,
  type PairedTradeOutput,
} from "@usemoney/core/pairing";

let counter = 0;
function createTrade(overrides: Partial<TradeInput> = {}): TradeInput {
  counter++;
  return {
    id: `t-${counter}`,
    userId: "user-1",
    symbol: "RELIANCE",
    isin: null,
    exchange: "NSE",
    segment: "CASH",
    broker: null,
    brokerUserId: null,
    tradeType: "BUY",
    positionType: "LONG",
    productType: "CNC",
    quantity: 10,
    price: 100,
    tradeDate: new Date("2024-01-15"),
    tradeTime: new Date("2024-01-15T10:00:00"),
    sourceType: "SYNCED",
    ...overrides,
  };
}

/** Assert every emitted view has only finite numeric fields + valid dates. */
function assertViewsAreFinite(views: PairedTradeOutput[]): void {
  for (const v of views) {
    assert.equal(
      Number.isFinite(v.quantity),
      true,
      `quantity not finite: ${v.quantity}`
    );
    assert.equal(
      Number.isFinite(v.entryPrice),
      true,
      `entryPrice not finite: ${v.entryPrice}`
    );
    if (v.exitPrice !== null) {
      assert.equal(
        Number.isFinite(v.exitPrice),
        true,
        `exitPrice not finite: ${v.exitPrice}`
      );
    }
    if (v.realizedPnL !== null) {
      assert.equal(
        Number.isFinite(v.realizedPnL),
        true,
        `realizedPnL not finite: ${v.realizedPnL}`
      );
    }
    if (v.pnlPercentage !== null) {
      assert.equal(
        Number.isFinite(v.pnlPercentage),
        true,
        `pnlPercentage not finite: ${v.pnlPercentage}`
      );
    }
    // Dates must be VALID (.toISOString() must not throw — the Prisma-persist
    // failure mode the brief calls out).
    assert.doesNotThrow(() => v.entryDate.toISOString());
    if (v.exitDate !== null) {
      assert.doesNotThrow(() => v.exitDate!.toISOString());
    }
  }
}

// ===========================================================================
// Helper-level guards (real exports)
// ===========================================================================
describe("pairing helpers: finite/date guards", () => {
  it("isFiniteQuantity rejects NaN / ±Infinity / 0 / negative / sub-epsilon", () => {
    assert.equal(isFiniteQuantity(NaN), false);
    assert.equal(isFiniteQuantity(Infinity), false);
    assert.equal(isFiniteQuantity(-Infinity), false);
    assert.equal(isFiniteQuantity(0), false);
    assert.equal(isFiniteQuantity(-5), false);
    assert.equal(isFiniteQuantity(1e-7), false); // below epsilon
    assert.equal(isFiniteQuantity(1), true);
    assert.equal(isFiniteQuantity(0.5), true);
  });

  it("sanitizePrice clamps non-finite to 0, passes finite through", () => {
    assert.equal(sanitizePrice(NaN), 0);
    assert.equal(sanitizePrice(Infinity), 0);
    assert.equal(sanitizePrice(-Infinity), 0);
    assert.equal(sanitizePrice(0), 0);
    assert.equal(sanitizePrice(-12.5), -12.5);
    assert.equal(sanitizePrice(99.99), 99.99);
  });

  it("safeTime returns epoch-anchored 0 for an Invalid Date, real ms otherwise", () => {
    assert.equal(safeTime(new Date("not-a-date")), 0);
    assert.equal(safeTime(new Date(0)), 0);
    assert.equal(safeTime(new Date("2024-01-15T00:00:00Z")), 1705276800000);
  });

  it("resolveTradeDate prefers valid tradeTime, falls back to tradeDate, then epoch", () => {
    assert.equal(
      resolveTradeDate({
        tradeTime: new Date("2024-02-01T09:00:00Z"),
        tradeDate: new Date("2024-01-01"),
      }).toISOString(),
      "2024-02-01T09:00:00.000Z"
    );
    // Invalid tradeTime → use tradeDate
    assert.equal(
      resolveTradeDate({
        tradeTime: new Date("garbage"),
        tradeDate: new Date("2024-01-10T00:00:00Z"),
      }).toISOString(),
      "2024-01-10T00:00:00.000Z"
    );
    // null tradeTime → use tradeDate
    assert.equal(
      resolveTradeDate({
        tradeTime: null,
        tradeDate: new Date("2024-03-03T00:00:00Z"),
      }).toISOString(),
      "2024-03-03T00:00:00.000Z"
    );
    // both invalid → epoch sentinel (never Invalid Date)
    assert.equal(
      resolveTradeDate({
        tradeTime: new Date("x"),
        tradeDate: new Date("y"),
      }).getTime(),
      0
    );
  });
});

// ===========================================================================
// Non-finite QUANTITY must never leak into a paired view
// ===========================================================================
describe("FIFO edge: non-finite / invalid quantity", () => {
  it("drops a NaN-quantity BUY (no view, no open position)", () => {
    const r = pairTradesFIFO([
      createTrade({ tradeType: "BUY", quantity: NaN }),
    ]);
    assert.equal(r.pairedViews.length, 0);
    assert.equal(r.stats.openPositions, 0);
    assertViewsAreFinite(r.pairedViews);
  });

  it("drops a +Infinity-quantity BUY", () => {
    const r = pairTradesFIFO([
      createTrade({ tradeType: "BUY", quantity: Infinity }),
    ]);
    assert.equal(r.pairedViews.length, 0);
  });

  it("drops a negative-quantity BUY", () => {
    const r = pairTradesFIFO([createTrade({ tradeType: "BUY", quantity: -5 })]);
    assert.equal(r.pairedViews.length, 0);
  });

  it("drops a zero-quantity BUY", () => {
    const r = pairTradesFIFO([createTrade({ tradeType: "BUY", quantity: 0 })]);
    assert.equal(r.pairedViews.length, 0);
  });

  it("a non-finite-qty trade does not consume a valid opposite leg", () => {
    // The NaN SELL must be dropped, leaving the BUY open (NOT matched/closed).
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        tradeTime: new Date("2024-01-15T10:00:00"),
      }),
      createTrade({
        id: "s",
        tradeType: "SELL",
        quantity: NaN,
        price: 110,
        tradeTime: new Date("2024-01-15T14:00:00"),
      }),
    ]);
    assert.equal(r.pairedViews.length, 1);
    assert.equal(r.pairedViews[0].status, "OPEN");
    assert.equal(r.pairedViews[0].quantity, 10);
    assert.equal(r.stats.closedPositions, 0);
    assertViewsAreFinite(r.pairedViews);
  });

  it("keeps valid trades while dropping invalid ones in the same group", () => {
    const r = pairTradesFIFO([
      createTrade({ id: "bad", tradeType: "BUY", quantity: Infinity }),
      createTrade({
        id: "good",
        tradeType: "BUY",
        quantity: 7,
        price: 100,
      }),
    ]);
    assert.equal(r.pairedViews.length, 1);
    assert.equal(r.pairedViews[0].entryTradeId, "good");
    assert.equal(r.pairedViews[0].quantity, 7);
    // totalTrades counts the raw input (2), not the survivors.
    assert.equal(r.stats.totalTrades, 2);
  });
});

// ===========================================================================
// Non-finite PRICE must never poison realized P&L
// ===========================================================================
describe("FIFO edge: non-finite price", () => {
  it("NaN entry price → finite P&L (price clamped to 0), no NaN in stats", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        tradeType: "BUY",
        quantity: 10,
        price: NaN,
        tradeTime: new Date("2024-01-15T10:00:00"),
      }),
      createTrade({
        id: "s",
        tradeType: "SELL",
        quantity: 10,
        price: 110,
        tradeTime: new Date("2024-01-15T14:00:00"),
      }),
    ]);
    assert.equal(r.pairedViews.length, 1);
    assert.equal(r.pairedViews[0].status, "CLOSED");
    assert.equal(r.pairedViews[0].entryPrice, 0); // clamped
    assert.equal(r.pairedViews[0].realizedPnL, 1100); // (110-0)*10
    assert.equal(Number.isFinite(r.stats.totalRealizedPnL), true);
    assertViewsAreFinite(r.pairedViews);
  });

  it("Infinity exit price → finite P&L (clamped to 0)", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        tradeType: "BUY",
        quantity: 5,
        price: 100,
        tradeTime: new Date("2024-01-15T10:00:00"),
      }),
      createTrade({
        id: "s",
        tradeType: "SELL",
        quantity: 5,
        price: Infinity,
        tradeTime: new Date("2024-01-15T14:00:00"),
      }),
    ]);
    assert.equal(r.pairedViews[0].exitPrice, 0);
    assert.equal(Number.isFinite(r.pairedViews[0].realizedPnL), true);
    assert.equal(r.pairedViews[0].realizedPnL, -500); // (0-100)*5
  });

  it("aggregate P&L over a mixed batch stays finite even with a bad price", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b1",
        tradeType: "BUY",
        quantity: 5,
        price: 100,
        tradeTime: new Date("2024-01-15T09:00:00"),
      }),
      createTrade({
        id: "s1",
        tradeType: "SELL",
        quantity: 5,
        price: 120,
        tradeTime: new Date("2024-01-15T10:00:00"),
      }),
      createTrade({
        id: "b2",
        tradeType: "BUY",
        quantity: 3,
        price: NaN,
        tradeTime: new Date("2024-01-16T09:00:00"),
      }),
      createTrade({
        id: "s2",
        tradeType: "SELL",
        quantity: 3,
        price: 50,
        tradeTime: new Date("2024-01-16T10:00:00"),
      }),
    ]);
    assert.equal(Number.isFinite(r.stats.totalRealizedPnL), true);
    // (120-100)*5 + (50-0)*3 = 100 + 150 = 250
    assert.equal(r.stats.totalRealizedPnL, 250);
  });
});

// ===========================================================================
// Invalid Date timestamps — emitted dates must always be valid
// ===========================================================================
describe("FIFO edge: invalid / unparseable timestamps", () => {
  it("Invalid tradeTime falls back to a valid tradeDate in entryDate", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "t1",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        tradeTime: new Date("not-a-date"),
        tradeDate: new Date("2024-01-15T00:00:00Z"),
      }),
    ]);
    assert.equal(r.pairedViews.length, 1);
    assert.equal(
      r.pairedViews[0].entryDate.toISOString(),
      "2024-01-15T00:00:00.000Z"
    );
    assertViewsAreFinite(r.pairedViews);
  });

  it("both tradeTime and tradeDate invalid → epoch sentinel, .toISOString() does not throw", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "t1",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        tradeTime: null,
        tradeDate: new Date("garbage"),
      }),
    ]);
    assert.equal(r.pairedViews.length, 1);
    assert.doesNotThrow(() => r.pairedViews[0].entryDate.toISOString());
    assert.equal(r.pairedViews[0].entryDate.getTime(), 0);
  });

  it("closed pair: invalid exit tradeTime still yields a valid exitDate", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        tradeTime: new Date("2024-01-15T10:00:00Z"),
      }),
      createTrade({
        id: "s",
        tradeType: "SELL",
        quantity: 10,
        price: 110,
        tradeTime: new Date("nope"),
        tradeDate: new Date("2024-01-16T00:00:00Z"),
      }),
    ]);
    assert.equal(r.pairedViews[0].status, "CLOSED");
    assert.doesNotThrow(() => r.pairedViews[0].exitDate!.toISOString());
    assert.equal(
      r.pairedViews[0].exitDate!.toISOString(),
      "2024-01-16T00:00:00.000Z"
    );
  });

  it("FIFO order uses the resolved tradeDate when tradeTime is invalid", () => {
    // b_old has an invalid tradeTime but an earlier tradeDate → must match first.
    const r = pairTradesFIFO([
      createTrade({
        id: "b_old",
        tradeType: "BUY",
        quantity: 5,
        price: 100,
        tradeTime: new Date("invalid"),
        tradeDate: new Date("2024-01-10T00:00:00Z"),
      }),
      createTrade({
        id: "b_new",
        tradeType: "BUY",
        quantity: 5,
        price: 200,
        tradeTime: new Date("2024-01-20T10:00:00Z"),
        tradeDate: new Date("2024-01-20T00:00:00Z"),
      }),
      createTrade({
        id: "s",
        tradeType: "SELL",
        quantity: 5,
        price: 150,
        tradeTime: new Date("2024-01-25T10:00:00Z"),
      }),
    ]);
    const closed = r.pairedViews.find((p) => p.status === "CLOSED");
    assert.ok(closed);
    // Oldest BUY (b_old, by tradeDate) matched first → entry price 100.
    assert.equal(closed.entryPrice, 100);
    assert.equal(closed.entryTradeId, "b_old");
  });
});

// ===========================================================================
// Stable FIFO order on identical timestamps
// ===========================================================================
describe("FIFO edge: identical timestamps (stable order)", () => {
  it("matches the first-listed BUY first when timestamps tie", () => {
    const ts = new Date("2024-01-15T10:00:00Z");
    const r = pairTradesFIFO([
      createTrade({
        id: "b1",
        tradeType: "BUY",
        quantity: 5,
        price: 100,
        tradeTime: ts,
      }),
      createTrade({
        id: "b2",
        tradeType: "BUY",
        quantity: 5,
        price: 200,
        tradeTime: ts,
      }),
      createTrade({
        id: "s",
        tradeType: "SELL",
        quantity: 5,
        price: 150,
        tradeTime: new Date("2024-01-15T14:00:00Z"),
      }),
    ]);
    const closed = r.pairedViews.find((p) => p.status === "CLOSED");
    const open = r.pairedViews.find((p) => p.status === "OPEN");
    assert.ok(closed);
    assert.ok(open);
    // b1 (listed first) is consumed first → closed entry 100; b2 stays open.
    assert.equal(closed.entryPrice, 100);
    assert.equal(closed.entryTradeId, "b1");
    assert.equal(open.entryPrice, 200);
    assert.equal(open.entryTradeId, "b2");
  });

  it("is deterministic across repeated runs with tied timestamps", () => {
    const ts = new Date("2024-01-15T10:00:00Z");
    const build = (): TradeInput[] => [
      createTrade({
        id: "b1",
        tradeType: "BUY",
        quantity: 3,
        price: 10,
        tradeTime: ts,
      }),
      createTrade({
        id: "b2",
        tradeType: "BUY",
        quantity: 3,
        price: 20,
        tradeTime: ts,
      }),
      createTrade({
        id: "b3",
        tradeType: "BUY",
        quantity: 3,
        price: 30,
        tradeTime: ts,
      }),
      createTrade({
        id: "s",
        tradeType: "SELL",
        quantity: 3,
        price: 25,
        tradeTime: new Date("2024-01-15T14:00:00Z"),
      }),
    ];
    const a = pairTradesFIFO(build());
    const b = pairTradesFIFO(build());
    const closedA = a.pairedViews.find((p) => p.status === "CLOSED");
    const closedB = b.pairedViews.find((p) => p.status === "CLOSED");
    assert.equal(closedA?.entryTradeId, "b1");
    assert.equal(closedB?.entryTradeId, "b1");
  });
});

// ===========================================================================
// Oversell — SELL qty > total BUY qty
// ===========================================================================
describe("FIFO edge: oversell (sell qty > buy qty)", () => {
  it("closes the available BUY and opens a SHORT for the excess", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        tradeType: "BUY",
        quantity: 4,
        price: 100,
        tradeTime: new Date("2024-01-15T10:00:00Z"),
      }),
      createTrade({
        id: "s",
        tradeType: "SELL",
        quantity: 10,
        price: 110,
        tradeTime: new Date("2024-01-15T14:00:00Z"),
      }),
    ]);
    const closed = r.pairedViews.find((p) => p.status === "CLOSED");
    // The SELL(10) was partially consumed (4 matched), so its 6-unit SHORT
    // remainder is PARTIAL (remainingQty 6 < original 10), not OPEN.
    const short = r.pairedViews.find((p) => p.positionType === "SHORT");
    assert.ok(closed);
    assert.ok(short);
    assert.equal(closed.positionType, "LONG");
    assert.equal(closed.quantity, 4);
    assert.equal(short.status, "PARTIAL");
    assert.equal(short.quantity, 6); // 10 - 4 excess sold short
    assert.equal(r.stats.closedPositions, 1);
    assert.equal(r.stats.partialPositions, 1);
    assert.equal(r.stats.openPositions, 0);
  });

  it("oversell with no prior BUY is a pure SHORT open", () => {
    const r = pairTradesFIFO([
      createTrade({ id: "s", tradeType: "SELL", quantity: 8, price: 110 }),
    ]);
    assert.equal(r.pairedViews.length, 1);
    assert.equal(r.pairedViews[0].positionType, "SHORT");
    assert.equal(r.pairedViews[0].status, "OPEN");
    assert.equal(r.pairedViews[0].quantity, 8);
  });
});

// ===========================================================================
// Cross-broker AND cross-symbol isolation — must NOT pair across boundaries
// ===========================================================================
describe("FIFO edge: grouping isolation (no cross-pairing)", () => {
  it("does NOT pair a BUY and SELL of different symbols", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        symbol: "RELIANCE",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
      }),
      createTrade({
        id: "s",
        symbol: "TCS",
        tradeType: "SELL",
        quantity: 10,
        price: 110,
      }),
    ]);
    assert.equal(r.pairedViews.length, 2);
    assert.equal(r.stats.closedPositions, 0);
    assert.equal(r.stats.openPositions, 2);
    assert.ok(r.pairedViews.every((p) => p.status === "OPEN"));
  });

  it("does NOT pair across different brokers (same symbol)", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        broker: "ZERODHA",
        brokerUserId: "Z1",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
      }),
      createTrade({
        id: "s",
        broker: "UPSTOX",
        brokerUserId: "U1",
        tradeType: "SELL",
        quantity: 10,
        price: 110,
      }),
    ]);
    assert.equal(r.pairedViews.length, 2);
    assert.equal(r.stats.closedPositions, 0);
  });

  it("does NOT pair across different broker accounts of the SAME broker", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        broker: "ZERODHA",
        brokerUserId: "ACC_A",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
      }),
      createTrade({
        id: "s",
        broker: "ZERODHA",
        brokerUserId: "ACC_B",
        tradeType: "SELL",
        quantity: 10,
        price: 110,
      }),
    ]);
    assert.equal(r.pairedViews.length, 2);
    assert.equal(r.stats.closedPositions, 0);
  });

  it("does NOT pair across different exchanges (same symbol, no ISIN)", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        symbol: "RELIANCE",
        isin: null,
        exchange: "NSE",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
      }),
      createTrade({
        id: "s",
        symbol: "RELIANCE",
        isin: null,
        exchange: "BSE",
        tradeType: "SELL",
        quantity: 10,
        price: 110,
      }),
    ]);
    assert.equal(r.pairedViews.length, 2);
    assert.equal(r.stats.closedPositions, 0);
  });

  it("DOES pair across renamed symbols sharing an ISIN (MF rename)", () => {
    const r = pairTradesFIFO([
      createTrade({
        id: "b",
        symbol: "MIRAE ASSET NYSE FANG+ ETF",
        isin: "INF769K01EY0",
        productType: "CNC",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        tradeTime: new Date("2024-01-15T10:00:00Z"),
      }),
      createTrade({
        id: "s",
        symbol: "MIRAE ASSET NYSE FANG ETF",
        isin: "INF769K01EY0",
        productType: "CNC",
        tradeType: "SELL",
        quantity: 10,
        price: 110,
        tradeTime: new Date("2024-01-16T10:00:00Z"),
      }),
    ]);
    assert.equal(r.pairedViews.length, 1);
    assert.equal(r.pairedViews[0].status, "CLOSED");
    assert.equal(r.pairedViews[0].realizedPnL, 100);
  });
});

// ===========================================================================
// Trivial / degenerate inputs
// ===========================================================================
describe("FIFO edge: trivial inputs", () => {
  it("empty input → empty result, zeroed stats", () => {
    const r = pairTradesFIFO([]);
    assert.equal(r.pairedViews.length, 0);
    assert.equal(r.stats.totalTrades, 0);
    assert.equal(r.stats.openPositions, 0);
    assert.equal(r.stats.closedPositions, 0);
    assert.equal(r.stats.partialPositions, 0);
    assert.equal(r.stats.totalRealizedPnL, 0);
  });

  it("single unmatched BUY → one OPEN LONG", () => {
    const r = pairTradesFIFO([
      createTrade({ id: "b", tradeType: "BUY", quantity: 10, price: 100 }),
    ]);
    assert.equal(r.pairedViews.length, 1);
    assert.equal(r.pairedViews[0].status, "OPEN");
    assert.equal(r.pairedViews[0].positionType, "LONG");
  });

  it("BUY-only batch → all OPEN, no closed", () => {
    const r = pairTradesFIFO([
      createTrade({ id: "b1", tradeType: "BUY", quantity: 5, price: 100 }),
      createTrade({ id: "b2", tradeType: "BUY", quantity: 5, price: 105 }),
    ]);
    assert.equal(r.stats.closedPositions, 0);
    assert.equal(r.stats.openPositions, 2);
    assert.ok(r.pairedViews.every((p) => p.positionType === "LONG"));
  });

  it("SELL-only batch → all OPEN SHORT, no closed", () => {
    const r = pairTradesFIFO([
      createTrade({ id: "s1", tradeType: "SELL", quantity: 5, price: 100 }),
      createTrade({ id: "s2", tradeType: "SELL", quantity: 5, price: 105 }),
    ]);
    assert.equal(r.stats.closedPositions, 0);
    assert.equal(r.stats.openPositions, 2);
    assert.ok(r.pairedViews.every((p) => p.positionType === "SHORT"));
  });
});

// ===========================================================================
// pairUserTrades convenience wrapper — user isolation
// ===========================================================================
describe("pairUserTrades: user isolation", () => {
  it("only pairs the requested user's trades", () => {
    const r = pairUserTrades(
      [
        createTrade({
          id: "a-buy",
          userId: "user-A",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
          tradeTime: new Date("2024-01-15T10:00:00Z"),
        }),
        createTrade({
          id: "a-sell",
          userId: "user-A",
          tradeType: "SELL",
          quantity: 10,
          price: 110,
          tradeTime: new Date("2024-01-15T14:00:00Z"),
        }),
        createTrade({
          id: "b-buy",
          userId: "user-B",
          tradeType: "BUY",
          quantity: 10,
          price: 100,
        }),
      ],
      "user-A"
    );
    // Only user-A's two trades pair (closed); user-B excluded entirely.
    assert.equal(r.stats.totalTrades, 2);
    assert.equal(r.stats.closedPositions, 1);
    assert.ok(r.pairedViews.every((v) => v.userId === "user-A"));
  });

  it("non-existent user → empty result", () => {
    const r = pairUserTrades(
      [createTrade({ userId: "user-A", tradeType: "BUY" })],
      "user-NOPE"
    );
    assert.equal(r.pairedViews.length, 0);
    assert.equal(r.stats.totalTrades, 0);
  });
});
