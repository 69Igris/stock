/**
 * Market Indices API - Zerodha overlay compliance (MONEY-566).
 *
 * The `/api/market/indices` route caches ONLY the Yahoo base payload (shared,
 * public, user-agnostic). The caller's Zerodha Gift NIFTY + MCX rows are
 * overlaid per-request and NEVER written to the shared cache; their presence
 * flips the response to `Cache-Control: private, no-store`.
 *
 * De-shadowed (MONEY-620): these tests now import and execute the REAL
 * `applyZerodhaOverlay` + `cacheControlPolicy` from
 * `app/api/market/indices/indices-logic.ts` — the same symbols the route
 * handler (`route.ts`) calls — instead of inline copies. The compliance
 * invariant under test (any Zerodha row ⇒ `hasZerodha === true` ⇒ private
 * header, and the shared base is never mutated) now guards the real code.
 *
 * Source under test: apps/web/app/api/market/indices/indices-logic.ts
 * Wired into:        apps/web/app/api/market/indices/route.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyZerodhaOverlay,
  cacheControlPolicy,
  type SimpleQuote,
  type YahooBasePayload,
} from "../../app/api/market/indices/indices-logic";

// ============== TEST HELPERS ==============

function makeBase(): YahooBasePayload {
  return {
    success: true,
    data: [
      {
        symbol: "^NSEI",
        name: "NIFTY 50",
        price: 22000,
        change: 100,
        changePercent: 0.45,
        market: "IN",
      },
      {
        symbol: "GC=F",
        name: "GOLD",
        price: 2300,
        change: 5,
        changePercent: 0.2,
        market: "MCX",
      },
      {
        symbol: "SI=F",
        name: "SILVER",
        price: 27,
        change: 0.1,
        changePercent: 0.3,
        market: "MCX",
      },
    ],
    marketStatus: { IN: "OPEN", US: "CLOSED", MCX: "OPEN" },
  };
}

const Q = (price: number): SimpleQuote => ({
  price,
  change: 1,
  changePercent: 0.1,
});

// ============== applyZerodhaOverlay (real source) ==============

describe("applyZerodhaOverlay (MONEY-566 Zerodha overlay, real source)", () => {
  it("null overlay returns the base untouched and hasZerodha=false (public)", () => {
    const base = makeBase();
    const { payload, hasZerodha } = applyZerodhaOverlay(base, null);
    assert.equal(hasZerodha, false);
    assert.equal(cacheControlPolicy(hasZerodha), "public");
    assert.equal(payload, base); // same reference - no copy
  });

  it("empty overlay (no Gift NIFTY, no MCX) stays public", () => {
    const base = makeBase();
    const { hasZerodha } = applyZerodhaOverlay(base, {
      giftNifty: null,
      mcx: new Map(),
    });
    assert.equal(hasZerodha, false);
    assert.equal(cacheControlPolicy(hasZerodha), "public");
  });

  it("Gift NIFTY is APPENDED (no Yahoo proxy) and flips the response to private", () => {
    const base = makeBase();
    const { payload, hasZerodha } = applyZerodhaOverlay(base, {
      giftNifty: Q(22100),
      mcx: new Map(),
    });
    assert.equal(hasZerodha, true);
    assert.equal(cacheControlPolicy(hasZerodha), "private");
    const gift = payload.data.find((r) => r.symbol === "GIFT_NIFTY");
    assert.ok(gift, "GIFT_NIFTY row present");
    assert.equal(gift!.market, "IN");
    assert.equal(gift!.price, 22100);
  });

  it("Zerodha MCX REPLACES the Yahoo fallback row (no duplicate commodity)", () => {
    const base = makeBase();
    const { payload, hasZerodha } = applyZerodhaOverlay(base, {
      giftNifty: null,
      mcx: new Map([["GOLD", Q(73500)]]),
    });
    assert.equal(hasZerodha, true);
    const goldRows = payload.data.filter((r) => r.name === "GOLD");
    assert.equal(
      goldRows.length,
      1,
      "exactly one GOLD row - replaced, not added"
    );
    assert.equal(goldRows[0]!.symbol, "GOLD"); // zerodhaSymbol, not "GC=F"
    assert.equal(goldRows[0]!.price, 73500); // Zerodha price, not Yahoo 2300
    // SILVER had no Zerodha quote → keeps its Yahoo fallback row
    const silver = payload.data.find((r) => r.name === "SILVER");
    assert.equal(silver!.symbol, "SI=F");
  });

  it("does NOT mutate the shared base payload (overlay copies first)", () => {
    const base = makeBase();
    const baseLenBefore = base.data.length;
    applyZerodhaOverlay(base, {
      giftNifty: Q(22100),
      mcx: new Map([["GOLD", Q(73500)]]),
    });
    assert.equal(
      base.data.length,
      baseLenBefore,
      "base.data must be unchanged - the shared cache entry must not gain Zerodha rows"
    );
    assert.ok(!base.data.some((r) => r.symbol === "GIFT_NIFTY"));
  });

  it("INVARIANT: any Zerodha row ⇒ hasZerodha=true ⇒ private header", () => {
    const base = makeBase();
    for (const overlay of [
      { giftNifty: Q(1), mcx: new Map<string, SimpleQuote>() },
      { giftNifty: null, mcx: new Map([["SILVER", Q(2)]]) },
      { giftNifty: Q(1), mcx: new Map([["GOLD", Q(3)]]) },
    ]) {
      const { hasZerodha } = applyZerodhaOverlay(base, overlay);
      assert.equal(hasZerodha, true);
      assert.equal(cacheControlPolicy(hasZerodha), "private");
    }
  });

  // ============== edge cases (new) ==============

  it("replaces BOTH commodities in place when both Zerodha MCX quotes are present", () => {
    const base = makeBase();
    const { payload } = applyZerodhaOverlay(base, {
      giftNifty: null,
      mcx: new Map([
        ["GOLD", Q(73500)],
        ["SILVER", Q(91000)],
      ]),
    });
    // No new rows added — both replaced in place (still 3 rows).
    assert.equal(payload.data.length, 3);
    const gold = payload.data.find((r) => r.name === "GOLD")!;
    const silver = payload.data.find((r) => r.name === "SILVER")!;
    assert.equal(gold.symbol, "GOLD");
    assert.equal(gold.price, 73500);
    assert.equal(silver.symbol, "SILVER");
    assert.equal(silver.price, 91000);
  });

  it("ignores an MCX quote for a commodity not in the ticker taxonomy (e.g. COPPER)", () => {
    const base = makeBase();
    const { payload, hasZerodha } = applyZerodhaOverlay(base, {
      giftNifty: null,
      mcx: new Map([["COPPER", Q(800)]]),
    });
    // COPPER is not in MCX_COMMODITIES → the overlay loop never reads it.
    assert.equal(
      hasZerodha,
      false,
      "unknown commodity must not flip to private"
    );
    assert.equal(cacheControlPolicy(hasZerodha), "public");
    assert.ok(!payload.data.some((r) => r.name === "COPPER"));
    assert.equal(payload.data.length, base.data.length);
  });

  it("appends Gift NIFTY when the base has NO MCX rows to replace (only the IN index)", () => {
    const base: YahooBasePayload = {
      success: true,
      data: [
        {
          symbol: "^NSEI",
          name: "NIFTY 50",
          price: 22000,
          change: 0,
          changePercent: 0,
          market: "IN",
        },
      ],
      marketStatus: { IN: "OPEN", US: "CLOSED", MCX: "CLOSED" },
    };
    const { payload, hasZerodha } = applyZerodhaOverlay(base, {
      giftNifty: Q(22100),
      mcx: new Map([["GOLD", Q(73500)]]),
    });
    assert.equal(hasZerodha, true);
    // GOLD had no fallback row in the base → APPENDED (findIndex < 0 branch).
    const gold = payload.data.find((r) => r.name === "GOLD")!;
    assert.equal(gold.symbol, "GOLD");
    assert.equal(payload.data.length, 3); // NIFTY + GIFT_NIFTY + GOLD
  });

  it("still flips private for a non-positive / NaN Zerodha price (filtering is the route's job, not the overlay's)", () => {
    const base = makeBase();
    for (const bad of [0, -5, NaN]) {
      const { payload, hasZerodha } = applyZerodhaOverlay(base, {
        giftNifty: Q(bad),
        mcx: new Map(),
      });
      assert.equal(
        hasZerodha,
        true,
        `Gift NIFTY price ${bad} must still flip private`
      );
      const gift = payload.data.find((r) => r.symbol === "GIFT_NIFTY")!;
      assert.ok(gift, "row is added regardless of price value");
    }
  });

  it("returns a NEW payload object and a NEW data array (referential isolation)", () => {
    const base = makeBase();
    const { payload } = applyZerodhaOverlay(base, {
      giftNifty: Q(1),
      mcx: new Map(),
    });
    assert.notEqual(payload, base, "payload must be a fresh object");
    assert.notEqual(payload.data, base.data, "data must be a fresh array");
    // marketStatus is spread-shared (shallow copy) but base.data is untouched.
    assert.equal(payload.marketStatus, base.marketStatus);
  });

  it("repeated overlays on the same base never accumulate rows on the base", () => {
    const base = makeBase();
    const before = base.data.length;
    for (let i = 0; i < 50; i++) {
      applyZerodhaOverlay(base, {
        giftNifty: Q(i + 1),
        mcx: new Map([["GOLD", Q(i + 2)]]),
      });
    }
    assert.equal(
      base.data.length,
      before,
      "base must be immutable across N overlays"
    );
    assert.ok(!base.data.some((r) => r.symbol === "GIFT_NIFTY"));
  });
});

describe("cacheControlPolicy (header decision, real source)", () => {
  it("maps true → private (per-user Zerodha payload, never shared-cached)", () => {
    assert.equal(cacheControlPolicy(true), "private");
  });

  it("maps false → public (Yahoo-only base, shareable)", () => {
    assert.equal(cacheControlPolicy(false), "public");
  });
});
