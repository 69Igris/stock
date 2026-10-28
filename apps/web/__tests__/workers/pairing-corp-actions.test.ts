/**
 * Worker corp-action wiring tests (workers/src/processors/pairing-logic.ts) —
 * MONEY-840.
 *
 * `processPairing` can't be imported into a pure test (it pulls Prisma +
 * notifications at module load), so its corp-action FETCH FILTER and the Prisma
 * row → `CorporateActionInput` mapping are extracted as pure exports the
 * processor CALLS. These tests assert the REAL exports (no shadow copy) — same
 * pattern as processor-pairing.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  corpActionFilterFromTrades,
  toCorporateActionInput,
  type CorpActionFilterTrade,
  type CorpActionRow,
} from "../../../../workers/src/processors/pairing-logic";

function trade(
  overrides: Partial<CorpActionFilterTrade> = {}
): CorpActionFilterTrade {
  return {
    symbol: "TATAELXSI",
    isin: "INE670A01012",
    segment: "CASH",
    tradingSymbol: null,
    ...overrides,
  };
}

describe("worker corp-actions: corpActionFilterFromTrades", () => {
  it("returns distinct symbols and effective ISINs across the trade set", () => {
    const { symbols, isins } = corpActionFilterFromTrades([
      trade({ symbol: "A", isin: "INE000A01001" }),
      trade({ symbol: "A", isin: "INE000A01001" }), // dup
      trade({ symbol: "B", isin: "INE000B01002" }),
    ]);
    assert.deepEqual(new Set(symbols), new Set(["A", "B"]));
    assert.deepEqual(new Set(isins), new Set(["INE000A01001", "INE000B01002"]));
  });

  it("recovers an MF ISIN packed into tradingSymbol (deriveEffectiveIsin)", () => {
    const { isins } = corpActionFilterFromTrades([
      trade({
        symbol: "SOME FUND",
        isin: null,
        segment: "MF",
        tradingSymbol: "INF109K01Y80",
      }),
    ]);
    assert.deepEqual(isins, ["INF109K01Y80"]);
  });

  it("omits ISINs for trades that have none (no null in the filter)", () => {
    const { symbols, isins } = corpActionFilterFromTrades([
      trade({
        symbol: "NOISIN",
        isin: null,
        segment: "CASH",
        tradingSymbol: null,
      }),
    ]);
    assert.deepEqual(symbols, ["NOISIN"]);
    assert.deepEqual(isins, []);
  });
});

describe("worker corp-actions: toCorporateActionInput", () => {
  it("maps the cost-basis-relevant CorporateAction fields verbatim", () => {
    const exDate = new Date("2024-06-01");
    const row: CorpActionRow = {
      id: "ca-1",
      symbol: "TATAELXSI",
      isin: "INE670A01012",
      exchange: "NSE",
      type: "SPLIT",
      exDate,
      ratio: 5,
    };
    const input = toCorporateActionInput(row);
    assert.deepEqual(input, {
      id: "ca-1",
      symbol: "TATAELXSI",
      isin: "INE670A01012",
      exchange: "NSE",
      type: "SPLIT",
      exDate,
      ratio: 5,
    });
  });

  it("passes a null ratio through (DIVIDEND-shaped rows)", () => {
    const input = toCorporateActionInput({
      id: "ca-2",
      symbol: "X",
      isin: null,
      exchange: "NSE",
      type: "DIVIDEND",
      exDate: new Date("2024-06-01"),
      ratio: null,
    });
    assert.equal(input.ratio, null);
    assert.equal(input.isin, null);
  });
});
