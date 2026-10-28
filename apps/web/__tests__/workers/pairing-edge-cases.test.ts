/**
 * Worker Pairing Processor — derivation edge cases (DE-SHADOWED, MONEY-620).
 *
 * The previous version of this file SHADOWED the worker processor: it declared
 * a local `processPairing` "(mirrors workers/src/processors/pairing.ts)" and
 * re-implemented the price/ISIN derivation inline in each `it()`, asserting the
 * COPY. The copy was lenient (`price || 0` lets Infinity leak; a non-finite
 * `tradeValue/quantity` ratio flowed straight through) — so it stayed green
 * while the real worker could persist a non-finite price into realizedPnL.
 *
 * This rewrite asserts the REAL exported helpers from
 * `workers/src/processors/pairing-logic.ts` (imported via relative path, the
 * same pattern other apps/web worker tests use), which the real
 * `pairing.ts` now CALLS. Production path and these tests run the same code.
 *
 * Focus: the dominant worker bug class — non-finite leaks (NaN/Infinity through
 * `||`/division) and missing-value fallthrough — plus the MF ISIN-shape rule.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL source under test (no shadow). Relative path resolves from
// apps/web/__tests__/workers → repo-root workers/src/processors/pairing-logic.
import {
  derivePairingPrice,
  deriveEffectiveIsin,
  looksLikeIsin,
} from "../../../../workers/src/processors/pairing-logic";

describe("Workers Pairing — looksLikeIsin", () => {
  it("accepts a canonical 12-char IN ISIN", () => {
    assert.equal(looksLikeIsin("INF179K01BC4"), true);
    assert.equal(looksLikeIsin("INE002A01018"), true);
  });

  it("accepts lowercase (uppercased internally)", () => {
    assert.equal(looksLikeIsin("inf179k01bc4"), true);
  });

  it("rejects wrong length", () => {
    assert.equal(looksLikeIsin("INF179K01BC"), false); // 11
    assert.equal(looksLikeIsin("INF179K01BC44"), false); // 13
    assert.equal(looksLikeIsin("INF179"), false); // far too short
  });

  it("rejects non-IN prefix", () => {
    assert.equal(looksLikeIsin("XYF209K01YY8"), false);
    assert.equal(looksLikeIsin("US0378331005"), false);
  });

  it("rejects non-alphanumeric (special chars / spaces)", () => {
    assert.equal(looksLikeIsin("INF209K01-Y8"), false);
    assert.equal(looksLikeIsin("INF209 01YY8"), false);
  });

  it("rejects null / undefined / empty", () => {
    assert.equal(looksLikeIsin(null), false);
    assert.equal(looksLikeIsin(undefined), false);
    assert.equal(looksLikeIsin(""), false);
  });
});

describe("Workers Pairing — deriveEffectiveIsin (MF tradingSymbol inference)", () => {
  it("prefers the explicit isin column", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: "INF846K01EW2",
        segment: "MF",
        tradingSymbol: "INF209K01YY8",
      }),
      "INF846K01EW2"
    );
  });

  it("infers ISIN from an ISIN-shaped MF tradingSymbol when isin is null", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: null,
        segment: "MF",
        tradingSymbol: "INF179K01BC4",
      }),
      "INF179K01BC4"
    );
  });

  it("uppercases the tradingSymbol before inference", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: null,
        segment: "MF",
        tradingSymbol: "inf209k01yy8",
      }),
      "INF209K01YY8"
    );
  });

  it("does NOT infer for non-MF segments (EQ)", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: null,
        segment: "EQ",
        tradingSymbol: "INF209K01YY8",
      }),
      null
    );
  });

  it("returns null when MF tradingSymbol is not ISIN-shaped", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: null,
        segment: "MF",
        tradingSymbol: "HDFCFLEXICAP",
      }),
      null
    );
  });

  it("returns null when MF tradingSymbol is too short", () => {
    assert.equal(
      deriveEffectiveIsin({
        isin: null,
        segment: "MF",
        tradingSymbol: "INF179",
      }),
      null
    );
  });

  it("returns null when MF tradingSymbol is null", () => {
    assert.equal(
      deriveEffectiveIsin({ isin: null, segment: "MF", tradingSymbol: null }),
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

describe("Workers Pairing — derivePairingPrice", () => {
  const base = {
    price: null as number | null,
    tradeValue: null as number | null,
    quantity: null as number | null,
    averagePrice: null as number | null,
  };

  it("uses the stored price when present and non-zero", () => {
    assert.equal(derivePairingPrice({ ...base, price: 1500 }), 1500);
  });

  it("derives tradeValue / quantity when price is 0", () => {
    assert.equal(
      derivePairingPrice({
        ...base,
        price: 0,
        tradeValue: 30000,
        quantity: 10,
      }),
      3000
    );
  });

  it("derives tradeValue / quantity when price is null", () => {
    assert.equal(
      derivePairingPrice({
        ...base,
        price: null,
        tradeValue: 25000,
        quantity: 10,
      }),
      2500
    );
  });

  it("falls back to averagePrice when no usable tradeValue/quantity", () => {
    assert.equal(
      derivePairingPrice({
        ...base,
        price: 0,
        tradeValue: null,
        averagePrice: 900,
      }),
      900
    );
  });

  it("does NOT divide by zero quantity (falls through to averagePrice)", () => {
    assert.equal(
      derivePairingPrice({
        ...base,
        price: null,
        tradeValue: 5000,
        quantity: 0,
        averagePrice: 200,
      }),
      200
    );
  });

  it("does NOT divide by negative quantity (falls through to averagePrice)", () => {
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

  it("tradeValue=0 with a positive quantity divides to 0 (NOT fall-through)", () => {
    // The de-shadowed helper checks Number.isFinite(tradeValue) (0 passes), so
    // 0 / 10 = 0 and the averagePrice `else if` is skipped → 0. This is the
    // intentional behavior change vs the old worker shadow, whose
    // `if (t.tradeValue && …)` treated 0 as falsy and fell through to 500.
    assert.equal(
      derivePairingPrice({
        ...base,
        price: null,
        tradeValue: 0,
        quantity: 10,
        averagePrice: 500,
      }),
      0
    );
  });

  it("returns 0 when everything is missing", () => {
    assert.equal(derivePairingPrice({ ...base }), 0);
  });

  // ---- non-finite leak guards (the dominant worker bug class) ----

  it("treats a NaN stored price as missing and derives instead", () => {
    assert.equal(
      derivePairingPrice({ ...base, price: NaN, tradeValue: 200, quantity: 2 }),
      100
    );
  });

  it("treats an Infinity stored price as missing and derives instead", () => {
    assert.equal(
      derivePairingPrice({ ...base, price: Infinity, averagePrice: 55 }),
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

  it("never returns Infinity from an Infinity tradeValue (BUG the old shadow missed)", () => {
    // Old worker: `price = Infinity / 2 = Infinity`, then `Infinity || 0` === Infinity.
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
