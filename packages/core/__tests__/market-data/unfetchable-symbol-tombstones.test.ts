/**
 * `isUnfetchableYahooSymbol` — the TERMINAL sector-coverage gate (MONEY-1172).
 *
 * ## Why this predicate deserves its own suite
 *
 * It is not a hint. `partitionFetchable` sends everything it returns `true` for
 * straight to the `SECTOR_SKIPPED` ("N/A") sentinel WITHOUT fetching, and the
 * enrichment cron only ever selects rows whose sector is null. A non-null
 * sentinel is never reconsidered — so one wrong `true` removes an instrument
 * from sector coverage permanently, and no upstream improvement brings it back
 * without a manual backfill.
 *
 * Sector is not decorative: it drives the heatmap, sector browse, discover
 * aggregates, holdings allocation, and the derived-peers job (MONEY-1145),
 * which selects peers WITHIN a sector — so a tombstoned instrument has no peer
 * set at all.
 *
 * That asymmetry is the whole design rule, and it is why the false-positive
 * cases below are the important half of this file:
 *
 *   false positive → silent, permanent, invisible in every sector surface
 *   false negative → one wasted HTTP call the caller already tolerates
 *
 * ## The two bugs this pins
 *
 * `/^\d/` — "starts with a digit → BSE bond/debt" also matched 3MINDIA,
 * 63MOONS, 5PAISA and 20MICRONS, all real actively traded NSE equities. The
 * `\d{4,}` rule three lines below names 3MINDIA and 63MOONS as symbols to
 * protect but could never see them; the earlier rule had already returned.
 *
 * `/^Z[A-Z]/ && .BO` — confused BSE's Z GROUP (a surveillance classification in
 * its own field) with the first letter of a trading symbol, tombstoning
 * ZOMATO.BO, ZYDUSLIFE.BO, ZEEL.BO and others. ZOMATO.NS passed, so the same
 * company was classified on one exchange and permanently blank on the other.
 *
 * Source: packages/core/src/market-data/instruments/types.ts
 *         packages/core/src/market-data/instruments/sector-enrichment-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isUnfetchableYahooSymbol } from "../../src/market-data/instruments/types";
import { buildYahooSymbol } from "../../src/market-data/instruments/zerodha-instruments-logic";

/** Real, actively traded companies. A `true` here is permanent data loss. */
const TRADEABLE = [
  // MONEY-1172: digit-initial equities the old `/^\d/` rule tombstoned.
  "3MINDIA.NS",
  "3MINDIA.BO",
  "63MOONS.NS",
  "5PAISA.NS",
  "20MICRONS.NS",
  // MONEY-1172: BSE rows for companies whose symbol starts with Z.
  "ZOMATO.BO",
  "ZOMATO.NS",
  "ZYDUSLIFE.BO",
  "ZEEL.BO",
  "ZENSARTECH.BO",
  "ZFCVINDIA.BO",
  "ZUARI.BO",
  // Ordinary controls.
  "RELIANCE.NS",
  "TCS.NS",
  "HDFCBANK.BO",
  "DLF.NS",
  "INFY.NS",
];

/** Instruments Yahoo genuinely cannot price. A `false` costs one HTTP call. */
const UNFETCHABLE = [
  "500325.BO", // BSE numeric scrip code
  "828GUJ2029.BO", // state development loan
  "HDFC1204DG.BO", // MF/bond code, 4+ digits
  "EBBETF0431.BO",
  "SFMP68GR.BO", // MF payout suffix after digits
  "KTKFMP46G.BO", // fixed maturity plan
  "RFHXXIV05G.BO", // NCD, roman numeral
  "NFHXXV01G.BO",
  "RMFINAF1.BO", // RMFINAF debt series
];

describe("isUnfetchableYahooSymbol — the terminal sector gate (MONEY-1172)", () => {
  it("never tombstones a real tradeable equity", () => {
    // The important direction. Every symbol here that returns `true` is an
    // instrument permanently absent from the heatmap, sector browse, discover
    // aggregates, holdings allocation and peers — with no error anywhere.
    const wrongly = TRADEABLE.filter(isUnfetchableYahooSymbol);
    assert.deepEqual(
      wrongly,
      [],
      "these are real, actively traded companies. Returning true here writes " +
        "the N/A sentinel without fetching, and the enrichment cron only " +
        "selects rows with a NULL sector — so the tombstone is permanent and " +
        "silent. Narrow the rule instead",
    );
  });

  it("still catches the instruments Yahoo cannot price", () => {
    const missed = UNFETCHABLE.filter((s) => !isUnfetchableYahooSymbol(s));
    assert.deepEqual(
      missed,
      [],
      "these are bonds, MF codes and scrip numbers — skipping them is the " +
        "point of the predicate",
    );
  });

  it("[regression] a digit-initial symbol is judged by its WHOLE base, not its first character", () => {
    // `/^\d/` vs `/^\d+$/`. The old rule could not distinguish a BSE scrip
    // number from a company that happens to start with a numeral.
    assert.equal(isUnfetchableYahooSymbol("500325.BO"), true, "all digits");
    assert.equal(isUnfetchableYahooSymbol("3MINDIA.NS"), false, "3M India");
    assert.equal(isUnfetchableYahooSymbol("63MOONS.NS"), false, "63 Moons");
  });

  it("[regression] a leading Z says nothing — BSE's Z GROUP is a different field", () => {
    // The old rule read a surveillance classification off the spelling of the
    // symbol. The tell was that the SAME company disagreed across exchanges.
    assert.equal(isUnfetchableYahooSymbol("ZOMATO.BO"), false);
    assert.equal(
      isUnfetchableYahooSymbol("ZOMATO.BO"),
      isUnfetchableYahooSymbol("ZOMATO.NS"),
      "one company cannot be fetchable on NSE and permanently unresolvable " +
        "on BSE — that asymmetry is what exposed the bug",
    );
  });

  it("an empty symbol is unfetchable", () => {
    // F&O and index rows get "" from buildYahooSymbol; there is nothing to ask
    // Yahoo for, so the sentinel is correct here.
    assert.equal(isUnfetchableYahooSymbol(""), true);
  });

  it("[documented] the -BE rule cannot fire — the series is stripped upstream", () => {
    // Kept in the source as harmless and correct-if-reached, but a reader
    // should not believe BE-series symbols are being filtered here. If this
    // ever fails, a provider started passing the series through and the rule
    // has become load-bearing — decide deliberately at that point.
    const y = buildYahooSymbol({
      exchange: "NSE",
      tradingsymbol: "SUZLON-BE",
      instrument_type: "EQ",
    } as never);
    assert.equal(y, "SUZLON.NS", "buildYahooSymbol strips the series suffix");
    assert.equal(
      isUnfetchableYahooSymbol(y),
      false,
      "so a BE-series equity reaches the fetcher like any other",
    );
  });
});
