/**
 * broker-diagnostics-logic pure seam — REAL exports (MONEY-1062 W2-B).
 *
 * The counting / suggested-fix / fund-name-normalisation / fuzzy-similarity /
 * ISIN-lookup logic was extracted VERBATIM out of the diagnoseMFPairingAction +
 * populateMFISINAction server actions (apps/web/lib/actions/broker-connection.ts)
 * so it runs Prisma-free and both the action and these tests exercise the SAME
 * code. This pins the branch selection (which fix is suggested), the map keys,
 * and the exact match precedence (symbol → normalised → fuzzy ≥ 0.8).
 *
 * Source: packages/services/src/broker-diagnostics-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  diagnoseMFPairing,
  normalizeMFName,
  fundNameSimilarity,
  buildIsinMap,
  matchIsinForTrade,
  type MFTradeLite,
} from "../src/broker-diagnostics-logic";

describe("diagnoseMFPairing", () => {
  it("counts, dedupes symbols/ISINs, and suggests re-pairing when ALL have ISIN", () => {
    const trades: MFTradeLite[] = [
      { symbol: "HDFC FLEXI", tradingSymbol: "INF1", isin: "INF1" },
      { symbol: "HDFC FLEXI", tradingSymbol: "INF1", isin: "INF1" }, // dup symbol+isin
      { symbol: "AXIS BLUE", tradingSymbol: "INF2", isin: "INF2" },
    ];
    const d = diagnoseMFPairing(trades);
    assert.equal(d.totalMFTrades, 3);
    assert.equal(d.tradesWithIsin, 3);
    assert.equal(d.tradesWithoutIsin, 0);
    assert.equal(d.uniqueSymbols, 2);
    assert.equal(d.uniqueIsins, 2);
    assert.deepEqual(d.symbolsWithoutIsin, []);
    assert.match(d.suggestedFix, /All MF trades have ISIN/);
  });

  it("suggests populateMFISINAction when a no-ISIN symbol matches a with-ISIN trade", () => {
    const trades: MFTradeLite[] = [
      { symbol: "HDFC FLEXI", tradingSymbol: "INF1", isin: "INF1" },
      { symbol: "HDFC FLEXI", tradingSymbol: null, isin: null }, // same symbol, no ISIN
    ];
    const d = diagnoseMFPairing(trades);
    assert.equal(d.tradesWithIsin, 1);
    assert.equal(d.tradesWithoutIsin, 1);
    assert.deepEqual(d.symbolsWithoutIsin, ["HDFC FLEXI"]);
    assert.match(
      d.suggestedFix,
      /Some trades can be fixed by running populateMFISINAction/,
    );
  });

  it("suggests re-import when no-ISIN symbols match NOTHING with an ISIN", () => {
    const trades: MFTradeLite[] = [
      { symbol: "HDFC FLEXI", tradingSymbol: "INF1", isin: "INF1" },
      { symbol: "ICICI BLUECHIP", tradingSymbol: null, isin: null },
    ];
    const d = diagnoseMFPairing(trades);
    assert.equal(d.tradesWithoutIsin, 1);
    assert.deepEqual(d.symbolsWithoutIsin, ["ICICI BLUECHIP"]);
    assert.match(d.suggestedFix, /Re-import the CSV file/);
  });

  it("caps symbolsWithoutIsin at the first 10 distinct symbols", () => {
    const trades: MFTradeLite[] = Array.from({ length: 15 }, (_, i) => ({
      symbol: `FUND ${i}`,
      isin: null,
    }));
    const d = diagnoseMFPairing(trades);
    assert.equal(d.tradesWithoutIsin, 15);
    assert.equal(d.symbolsWithoutIsin.length, 10);
  });

  it("empty input → zeroed counts and the re-pairing suggestion", () => {
    const d = diagnoseMFPairing([]);
    assert.equal(d.totalMFTrades, 0);
    assert.equal(d.tradesWithIsin, 0);
    assert.match(d.suggestedFix, /All MF trades have ISIN/);
  });
});

describe("normalizeMFName", () => {
  it("uppercases, strips trailing MF keywords, special chars, and collapses spaces", () => {
    assert.equal(normalizeMFName("Hdfc Flexi Cap Fund"), "HDFC FLEXI CAP");
    assert.equal(
      normalizeMFName("Mirae Asset NYSE FANG+ ETF"),
      "MIRAE ASSET NYSE FANG",
    );
    assert.equal(normalizeMFName("  Axis   Bluechip  "), "AXIS BLUECHIP");
  });

  it("strips embedded keywords (GROWTH/DIRECT/...) too", () => {
    // "GROWTH" between words is removed by the mid-name replace.
    assert.equal(
      normalizeMFName("Axis Growth Opportunities"),
      "AXIS OPPORTUNITIES",
    );
  });
});

describe("fundNameSimilarity", () => {
  it("identical normalised names → 1", () => {
    assert.equal(fundNameSimilarity("MIRAE ASSET NYSE", "MIRAE ASSET NYSE"), 1);
  });

  it("fully disjoint → 0", () => {
    assert.equal(fundNameSimilarity("HDFC FLEXI", "AXIS BLUE"), 0);
  });

  it("ignores words of length <= 2 and returns Jaccard over long words", () => {
    // "OF" is dropped (len 2); "MIRAE","ASSET","NYSE" vs "MIRAE","ASSET" →
    // intersection 2 / union 3.
    const s = fundNameSimilarity("MIRAE ASSET NYSE", "MIRAE ASSET OF");
    assert.ok(Math.abs(s - 2 / 3) < 1e-9, `expected ~0.667, got ${s}`);
  });

  it("empty (all-short-word) side → 0", () => {
    assert.equal(fundNameSimilarity("A OF", "MIRAE ASSET"), 0);
  });
});

describe("buildIsinMap", () => {
  it("keys symbolToIsin on UPPER symbol AND tradingSymbol, normalizedToIsin on the fund name", () => {
    const maps = buildIsinMap([
      { symbol: "hdfc flexi", tradingSymbol: "inf001", isin: "INF001" },
    ]);
    assert.equal(maps.symbolToIsin.get("HDFC FLEXI"), "INF001");
    assert.equal(maps.symbolToIsin.get("INF001"), "INF001");
    assert.equal(maps.normalizedToIsin.get("HDFC FLEXI"), "INF001");
  });

  it("skips reference rows with no ISIN", () => {
    const maps = buildIsinMap([{ symbol: "NO ISIN", isin: null }]);
    assert.equal(maps.symbolToIsin.size, 0);
    assert.equal(maps.normalizedToIsin.size, 0);
  });
});

describe("matchIsinForTrade (precedence: exact symbol → normalised → fuzzy)", () => {
  const reference: MFTradeLite[] = [
    {
      symbol: "MIRAE ASSET NYSE FANG ETF",
      tradingSymbol: "INF900",
      isin: "INF900",
    },
  ];
  const maps = buildIsinMap(reference);

  it("exact symbol match", () => {
    assert.equal(
      matchIsinForTrade({ symbol: "MIRAE ASSET NYSE FANG ETF" }, maps),
      "INF900",
    );
  });

  it("exact tradingSymbol match", () => {
    assert.equal(
      matchIsinForTrade({ symbol: "unknown", tradingSymbol: "INF900" }, maps),
      "INF900",
    );
  });

  it("fuzzy match (Jaccard >= 0.8) on a near-identical fund name", () => {
    // "MIRAE ASSET NYSE FANG+ ETF" normalises to "MIRAE ASSET NYSE FANG",
    // identical to the reference's normalised name → matched.
    assert.equal(
      matchIsinForTrade({ symbol: "MIRAE ASSET NYSE FANG+ ETF" }, maps),
      "INF900",
    );
  });

  it("returns null when nothing clears the fuzzy threshold", () => {
    assert.equal(
      matchIsinForTrade({ symbol: "TOTALLY DIFFERENT SCHEME" }, maps),
      null,
    );
  });

  it("empty reference maps → null (no crash)", () => {
    assert.equal(matchIsinForTrade({ symbol: "ANY" }, buildIsinMap([])), null);
  });
});
