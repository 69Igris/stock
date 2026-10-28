/**
 * Unit tests for the pure pairing-input derivations (MONEY-620).
 *
 * Exercises the REAL exported helpers from `lib/pairing/pairing-logic.ts` that
 * `service.ts` (Prisma-importing) calls while mapping a DB Trade →
 * pairing-algorithm TradeInput. No shadow copies, no Prisma — the production
 * path and these tests run the same code.
 *
 * Focus: the dominant local bug class — non-finite leaks (NaN/Infinity through
 * `||`/division) and missing-value fallthrough — plus the MF ISIN-shape rule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  derivePairingPrice,
  deriveEffectiveIsin,
  looksLikeIsin,
} from "@/lib/pairing/pairing-logic";

describe("pairing-logic: looksLikeIsin", () => {
  it("accepts a canonical 12-char IN ISIN", () => {
    assert.equal(looksLikeIsin("INF109K01Y80"), true);
    assert.equal(looksLikeIsin("INE002A01018"), true);
  });

  it("lowercases are accepted (uppercased internally)", () => {
    assert.equal(looksLikeIsin("inf109k01y80"), true);
  });

  it("rejects wrong length", () => {
    assert.equal(looksLikeIsin("INF109K01Y8"), false); // 11
    assert.equal(looksLikeIsin("INF109K01Y800"), false); // 13
  });

  it("rejects non-IN prefix", () => {
    assert.equal(looksLikeIsin("US0378331005"), false);
  });

  it("rejects non-alphanumeric", () => {
    assert.equal(looksLikeIsin("INF109-01Y80"), false);
    assert.equal(looksLikeIsin("INF109 01Y80"), false);
  });

  it("rejects null / undefined / empty", () => {
    assert.equal(looksLikeIsin(null), false);
    assert.equal(looksLikeIsin(undefined), false);
    assert.equal(looksLikeIsin(""), false);
  });
});

describe("pairing-logic: deriveEffectiveIsin", () => {
  it("prefers the explicit isin column", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: "INE002A01018",
        segment: "MF",
        tradingSymbol: "INF109K01Y80",
      }),
      "INE002A01018"
    );
  });

  it("falls back to ISIN-shaped MF tradingSymbol when isin missing", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: null,
        segment: "MF",
        tradingSymbol: "inf109k01y80",
      }),
      "INF109K01Y80" // uppercased
    );
  });

  it("does NOT use tradingSymbol for non-MF segments", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: null,
        segment: "CASH",
        tradingSymbol: "INF109K01Y80",
      }),
      null
    );
  });

  it("returns null when MF tradingSymbol is not ISIN-shaped", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: null,
        segment: "MF",
        tradingSymbol: "RELIANCE",
      }),
      null
    );
  });

  it("returns null when nothing is derivable", () => {
    assert.equal(
      deriveEffectiveIsin({ isin: null, segment: null, tradingSymbol: null }),
      null
    );
  });
});

describe("pairing-logic: derivePairingPrice", () => {
  const base = {
    price: null as number | null,
    tradeValue: null as number | null,
    quantity: null as number | null,
    averagePrice: null as number | null,
  };

  it("uses the stored price when present and non-zero", () => {
    assert.equal(derivePairingPrice({ ...base, price: 123.45 }), 123.45);
  });

  it("derives tradeValue / quantity when price is 0", () => {
    assert.equal(
      derivePairingPrice({ ...base, price: 0, tradeValue: 1000, quantity: 8 }),
      125
    );
  });

  it("derives tradeValue / quantity when price is null", () => {
    assert.equal(
      derivePairingPrice({
        ...base,
        price: null,
        tradeValue: 500,
        quantity: 5,
      }),
      100
    );
  });

  it("falls back to averagePrice when no usable tradeValue/quantity", () => {
    assert.equal(
      derivePairingPrice({ ...base, price: 0, quantity: 0, averagePrice: 77 }),
      77
    );
  });

  it("does NOT divide by zero quantity (falls through)", () => {
    // quantity 0 must skip the division branch entirely.
    assert.equal(
      derivePairingPrice({
        ...base,
        price: 0,
        tradeValue: 1000,
        quantity: 0,
        averagePrice: 42,
      }),
      42
    );
  });

  it("does NOT divide by negative quantity (falls through)", () => {
    assert.equal(
      derivePairingPrice({
        ...base,
        price: null,
        tradeValue: 1000,
        quantity: -5,
        averagePrice: 9,
      }),
      9
    );
  });

  it("returns 0 when everything is missing", () => {
    assert.equal(derivePairingPrice({ ...base }), 0);
  });

  // ---- non-finite leak guards (the dominant bug class) ----

  it("treats a NaN stored price as missing and derives instead", () => {
    assert.equal(
      derivePairingPrice({ ...base, price: NaN, tradeValue: 200, quantity: 2 }),
      100
    );
  });

  it("treats an Infinity stored price as missing and derives instead", () => {
    assert.equal(
      derivePairingPrice({
        ...base,
        price: Infinity,
        averagePrice: 55,
      }),
      55
    );
  });

  it("never returns NaN from a NaN tradeValue (falls through to averagePrice)", () => {
    const p = derivePairingPrice({
      ...base,
      price: 0,
      tradeValue: NaN,
      quantity: 4,
      averagePrice: 12,
    });
    assert.equal(Number.isFinite(p), true);
    assert.equal(p, 12);
  });

  it("never returns Infinity from an Infinity tradeValue", () => {
    const p = derivePairingPrice({
      ...base,
      price: 0,
      tradeValue: Infinity,
      quantity: 2,
      averagePrice: 3,
    });
    assert.equal(Number.isFinite(p), true);
    assert.equal(p, 3);
  });

  it("never returns NaN from a NaN averagePrice (clamps to 0)", () => {
    const p = derivePairingPrice({ ...base, price: 0, averagePrice: NaN });
    assert.equal(p, 0);
  });

  it("ALWAYS returns a finite number across adversarial inputs", () => {
    const vals = [null, NaN, Infinity, -Infinity, 0, -1, 1e9];
    for (const price of vals) {
      for (const tradeValue of vals) {
        for (const quantity of vals) {
          for (const averagePrice of vals) {
            const p = derivePairingPrice({
              price,
              tradeValue,
              quantity,
              averagePrice,
            });
            assert.equal(
              Number.isFinite(p),
              true,
              `non-finite price ${p} from ${JSON.stringify({ price, tradeValue, quantity, averagePrice })}`
            );
          }
        }
      }
    }
  });
});
