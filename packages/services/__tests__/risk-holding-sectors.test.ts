/**
 * MONEY-1121 — resolve holding sectors that the broker sync never wrote.
 *
 * Reported in the MONEY-1095 bug doc as item 10: `/risk` rendered the sector
 * allocation as a single "Unknown 100%" slice. `Holding.sector` was null on
 * every row, and `risk.service` read that column directly — while
 * `InstrumentMapping` had the answer all along. Measured on the live data:
 *
 *   holdings          : IDEA=NULL, IRB=NULL, ADANIPOWER=NULL, TMCV=NULL
 *   instruments       : IDEA=Telecommunication, IRB=Industrials,
 *                       ADANIPOWER=Utilities, TMCV="N/A"
 *
 * The merge is pure — the service does the query and passes the map — so the
 * behaviour is asserted here without a database.
 *
 * Source: packages/services/src/risk-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeHoldingSectors, holdingSectorKey } from "../src/risk-logic";

type H = { symbol: string; exchange?: string | null; sector?: string | null };

describe("MONEY-1121 — holdingSectorKey", () => {
  it("includes the exchange — the same ticker lists on NSE and BSE", () => {
    assert.notEqual(
      holdingSectorKey("IDEA", "NSE"),
      holdingSectorKey("IDEA", "BSE"),
    );
  });

  it("is case-insensitive on both parts", () => {
    assert.equal(
      holdingSectorKey("idea", "nse"),
      holdingSectorKey("IDEA", "NSE"),
    );
  });

  it("tolerates a missing exchange without collapsing into another key", () => {
    assert.equal(
      holdingSectorKey("IDEA", null),
      holdingSectorKey("IDEA", undefined),
    );
    assert.notEqual(
      holdingSectorKey("IDEA", null),
      holdingSectorKey("IDEA", "NSE"),
    );
  });
});

describe("MONEY-1121 — mergeHoldingSectors", () => {
  it("fills a null sector from the instrument map", () => {
    const holdings: H[] = [
      { symbol: "IDEA", exchange: "NSE", sector: null },
      { symbol: "IRB", exchange: "NSE", sector: null },
    ];
    const map = new Map([
      [holdingSectorKey("IDEA", "NSE"), "Telecommunication"],
      [holdingSectorKey("IRB", "NSE"), "Industrials"],
    ]);
    assert.deepEqual(
      mergeHoldingSectors(holdings, map).map((h) => h.sector),
      ["Telecommunication", "Industrials"],
    );
  });

  it("never overwrites a sector the sync DID write", () => {
    // When the broker supplies a sector it is authoritative; the instrument
    // table is only the fallback.
    const holdings: H[] = [
      { symbol: "IDEA", exchange: "NSE", sector: "Telecom" },
    ];
    const map = new Map([[holdingSectorKey("IDEA", "NSE"), "Something Else"]]);
    assert.equal(mergeHoldingSectors(holdings, map)[0]!.sector, "Telecom");
  });

  it("leaves a holding untouched when the instrument is unknown", () => {
    const holdings: H[] = [{ symbol: "NOPE", exchange: "NSE", sector: null }];
    assert.equal(mergeHoldingSectors(holdings, new Map())[0]!.sector, null);
  });

  it("does not adopt a placeholder sector", () => {
    // Live data has TMCV = "N/A". Adopting it would put an "N/A" slice beside
    // the "Unknown" slice mapHoldingsData already emits — two labels for the
    // same thing. Placeholders must fall through to the single Unknown bucket.
    for (const placeholder of ["N/A", "n/a", "NA", "-", "", "  ", "Unknown"]) {
      const holdings: H[] = [{ symbol: "TMCV", exchange: "NSE", sector: null }];
      const map = new Map([[holdingSectorKey("TMCV", "NSE"), placeholder]]);
      assert.equal(
        mergeHoldingSectors(holdings, map)[0]!.sector,
        null,
        `"${placeholder}" must not be adopted as a real sector`,
      );
    }
  });

  it("matches on exchange, not symbol alone", () => {
    // An NSE holding must not silently inherit the BSE row's sector.
    const holdings: H[] = [{ symbol: "IDEA", exchange: "NSE", sector: null }];
    const map = new Map([
      [holdingSectorKey("IDEA", "BSE"), "Telecommunication"],
    ]);
    assert.equal(mergeHoldingSectors(holdings, map)[0]!.sector, null);
  });

  it("returns holdings unchanged when nothing needs filling", () => {
    const holdings: H[] = [
      { symbol: "IDEA", exchange: "NSE", sector: "Telecom" },
    ];
    assert.deepEqual(mergeHoldingSectors(holdings, new Map()), holdings);
  });

  it("preserves every other field on the holding", () => {
    const holdings = [
      {
        symbol: "IDEA",
        exchange: "NSE",
        sector: null,
        quantity: 10,
        averagePrice: 7.5,
      },
    ];
    const map = new Map([
      [holdingSectorKey("IDEA", "NSE"), "Telecommunication"],
    ]);
    const [out] = mergeHoldingSectors(holdings, map);
    assert.equal(out!.quantity, 10);
    assert.equal(out!.averagePrice, 7.5);
    assert.equal(out!.sector, "Telecommunication");
  });
});
