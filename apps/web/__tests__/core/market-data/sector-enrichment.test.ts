/**
 * Sector Enrichment Service Tests
 *
 * Tests the REAL sector-enrichment logic:
 *   packages/core/src/market-data/instruments/sector-enrichment-logic.ts
 *     (partitionFetchable, decideFetchOutcome, decideErrorOutcome,
 *      groupPendingUpdatesByData, SECTOR_SKIPPED)
 *   packages/core/src/market-data/instruments/types.ts
 *     (isUnfetchableYahooSymbol)
 *   packages/core/src/market-data/instruments/sector-taxonomy.ts
 *     (normalizeToNseSector, NSE_SECTORS, YAHOO_TO_NSE_MAP)
 *
 * The production enrichSectors() in sector-enrichment.ts calls every one of
 * these decision helpers, so this exercises production code. The DB-driving
 * orchestration is replayed here through a thin harness that calls the SAME
 * real helpers (no inline reimplementation of the decision logic).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SECTOR_SKIPPED,
  partitionFetchable,
  decideFetchOutcome,
  decideErrorOutcome,
  groupPendingUpdatesByData,
  selectSymbolKeysToEnrich,
  type EnrichableInstrument,
  type SectorData,
  type PendingSectorUpdate,
} from "@usemoney/core/market-data/instruments/sector-enrichment-logic";
import {
  isUnfetchableYahooSymbol,
  normalizeToNseSector,
  NSE_SECTORS,
  YAHOO_TO_NSE_MAP,
} from "@usemoney/core/market-data";

type YahooSectorFetcher = (yahooSymbol: string) => Promise<SectorData | null>;

interface EnrichmentResult {
  totalProcessed: number;
  enriched: number;
  failed: number;
  skipped: number;
  errors: string[];
  /** The grouped writes that would have hit the DB (sector|industry → ids). */
  writes: Array<{ sector: string; industry: string | null; ids: string[] }>;
}

/**
 * Faithful replay of enrichSectors() orchestration that drives the REAL
 * decision helpers. No DB; collects the grouped writes the real flushUpdates
 * would have issued via groupPendingUpdatesByData.
 */
async function runEnrichment(
  instruments: EnrichableInstrument[],
  fetcher: YahooSectorFetcher
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    totalProcessed: 0,
    enriched: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    writes: [],
  };

  const { skippedIds, fetchable } = partitionFetchable(instruments);
  result.totalProcessed += skippedIds.length;
  result.skipped += skippedIds.length;
  if (skippedIds.length > 0) {
    result.writes.push({
      sector: SECTOR_SKIPPED,
      industry: SECTOR_SKIPPED,
      ids: skippedIds,
    });
  }

  const pendingUpdates: PendingSectorUpdate[] = [];

  for (const instrument of fetchable) {
    result.totalProcessed++;
    let outcome;
    try {
      const sectorData = await fetcher(instrument.yahooSymbol);
      outcome = decideFetchOutcome(instrument, sectorData);
    } catch (error) {
      outcome = decideErrorOutcome(instrument, error);
    }

    if (outcome.kind === "enriched") {
      if (outcome.update) pendingUpdates.push(outcome.update);
      result.enriched++;
    } else if (outcome.kind === "skipped") {
      if (outcome.update) pendingUpdates.push(outcome.update);
      result.skipped++;
    } else {
      result.failed++;
      if (outcome.error) result.errors.push(outcome.error);
    }
  }

  for (const group of groupPendingUpdatesByData(pendingUpdates)) {
    result.writes.push(group);
  }

  return result;
}

function createInstrument(
  overrides: Partial<EnrichableInstrument> = {}
): EnrichableInstrument {
  return {
    id: overrides.id ?? `inst-${Math.random().toString(36).slice(2, 8)}`,
    symbol: overrides.symbol ?? "RELIANCE",
    exchange: overrides.exchange ?? "NSE",
    yahooSymbol: overrides.yahooSymbol ?? "RELIANCE.NS",
  };
}

const successFetcher =
  (sector = "Technology", industry = "Software"): YahooSectorFetcher =>
  async () => ({ sector, industry });
const nullFetcher: YahooSectorFetcher = async () => null;
const f404Fetcher: YahooSectorFetcher = async () => {
  throw new Error("404 Not Found");
};
const errorFetcher =
  (message = "Network error"): YahooSectorFetcher =>
  async () => {
    throw new Error(message);
  };

describe("Sector Enrichment Service (real source)", () => {
  // ==========================================================================
  // Basic enrichment
  // ==========================================================================
  describe("Basic Enrichment", () => {
    it("should enrich instruments with sector data from fetcher", async () => {
      const result = await runEnrichment(
        [createInstrument({ id: "1", symbol: "TCS", yahooSymbol: "TCS.NS" })],
        successFetcher("Technology", "IT Services")
      );
      assert.strictEqual(result.enriched, 1);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(result.skipped, 0);
      assert.strictEqual(result.totalProcessed, 1);
    });

    it("should normalize Yahoo sector to NSE sector in the write", async () => {
      const result = await runEnrichment(
        [createInstrument({ id: "1", symbol: "TCS", yahooSymbol: "TCS.NS" })],
        successFetcher("Technology", "IT Services")
      );
      const write = result.writes.find(
        (w) => w.sector === "Information Technology"
      );
      assert.ok(
        write,
        "Should normalize 'Technology' to 'Information Technology'"
      );
      assert.deepStrictEqual(write!.ids, ["1"]);
    });

    it("should process multiple instruments", async () => {
      const result = await runEnrichment(
        [
          createInstrument({ id: "1", symbol: "TCS", yahooSymbol: "TCS.NS" }),
          createInstrument({ id: "2", symbol: "INFY", yahooSymbol: "INFY.NS" }),
          createInstrument({
            id: "3",
            symbol: "WIPRO",
            yahooSymbol: "WIPRO.NS",
          }),
        ],
        successFetcher("Technology", "IT")
      );
      assert.strictEqual(result.totalProcessed, 3);
      assert.strictEqual(result.enriched, 3);
    });

    it("should handle empty instrument list", async () => {
      const result = await runEnrichment([], successFetcher());
      assert.strictEqual(result.totalProcessed, 0);
      assert.strictEqual(result.enriched, 0);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(result.skipped, 0);
    });
  });

  // ==========================================================================
  // Unfetchable symbols (real isUnfetchableYahooSymbol via partitionFetchable)
  // ==========================================================================
  describe("Unfetchable Yahoo Symbols", () => {
    it("should skip symbols starting with digit (BSE bonds)", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "891234",
            yahooSymbol: "891234.BO",
          }),
        ],
        successFetcher()
      );
      assert.strictEqual(result.skipped, 1);
      assert.strictEqual(result.enriched, 0);
    });

    it("should skip symbols with -BE suffix (trade-to-trade)", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "XYZCO-BE",
            yahooSymbol: "XYZCO-BE.NS",
          }),
        ],
        successFetcher()
      );
      assert.strictEqual(result.skipped, 1);
    });

    it("should skip symbols with 4+ consecutive digits (MF codes)", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "FUND1234",
            yahooSymbol: "FUND1234.BO",
          }),
        ],
        successFetcher()
      );
      assert.strictEqual(result.skipped, 1);
    });

    it("should skip FMP symbols", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "KTKFMP46G",
            yahooSymbol: "KTKFMP46G.BO",
          }),
        ],
        successFetcher()
      );
      assert.strictEqual(result.skipped, 1);
    });

    it("should skip Roman numeral codes (NCDs)", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "RFHXXIV05G",
            yahooSymbol: "RFHXXIV05G.BO",
          }),
        ],
        successFetcher()
      );
      assert.strictEqual(result.skipped, 1);
    });

    // MONEY-1172 — was "should skip BSE suspended stocks (Z prefix)". A Z-prefix
    // .BO symbol is no longer skipped WITHOUT fetching, because that rule read
    // BSE's Z-group surveillance flag off the symbol's spelling and took
    // ZOMATO.BO, ZYDUSLIFE.BO and ZEEL.BO with it. Now it is fetched like any
    // other symbol; a genuine dud still ends at the sentinel via the fetch
    // outcome, one HTTP call later.
    it("no longer skips a Z-prefix BSE symbol before fetching (MONEY-1172)", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "ZHINDHSG",
            yahooSymbol: "ZHINDHSG.BO",
          }),
        ],
        successFetcher()
      );
      assert.strictEqual(result.skipped, 0);
      assert.strictEqual(result.enriched, 1);
    });

    it("should skip RMFINAF series", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "RMFINAF01",
            yahooSymbol: "RMFINAF01.BO",
          }),
        ],
        successFetcher()
      );
      assert.strictEqual(result.skipped, 1);
    });

    it("should batch-update unfetchable instruments as SKIPPED", async () => {
      const result = await runEnrichment(
        [
          createInstrument({ id: "1", yahooSymbol: "891234.BO" }),
          createInstrument({ id: "2", yahooSymbol: "KTKFMP46G.BO" }),
        ],
        successFetcher()
      );
      const skipWrite = result.writes.find((w) => w.sector === SECTOR_SKIPPED);
      assert.ok(skipWrite, "Should batch-update unfetchable as SKIPPED");
      assert.deepStrictEqual(skipWrite!.ids.sort(), ["1", "2"]);
    });
  });

  // ==========================================================================
  // Idempotency
  // ==========================================================================
  describe("Idempotency", () => {
    it("should not call fetcher for unfetchable symbols", async () => {
      let fetcherCallCount = 0;
      const fetcher: YahooSectorFetcher = async () => {
        fetcherCallCount++;
        return { sector: "Technology", industry: "IT" };
      };

      await runEnrichment(
        [
          createInstrument({ id: "1", yahooSymbol: "891234.BO" }), // unfetchable
          createInstrument({ id: "2", yahooSymbol: "RELIANCE.NS" }), // fetchable
        ],
        fetcher
      );

      assert.strictEqual(
        fetcherCallCount,
        1,
        "Should only fetch for fetchable instruments"
      );
    });

    it("should correctly separate fetchable from unfetchable", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "BOND",
            yahooSymbol: "123456.BO",
          }),
          createInstrument({ id: "2", symbol: "TCS", yahooSymbol: "TCS.NS" }),
          createInstrument({
            id: "3",
            symbol: "FMP",
            yahooSymbol: "KTKFMP46G.BO",
          }),
          createInstrument({ id: "4", symbol: "INFY", yahooSymbol: "INFY.NS" }),
        ],
        successFetcher("Technology", "IT")
      );
      assert.strictEqual(result.skipped, 2);
      assert.strictEqual(result.enriched, 2);
      assert.strictEqual(result.totalProcessed, 4);
    });
  });

  // ==========================================================================
  // Error handling
  // ==========================================================================
  describe("Error Handling", () => {
    it("should skip instruments returning null from fetcher", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "UNKNOWN",
            yahooSymbol: "UNKNOWN.NS",
          }),
        ],
        nullFetcher
      );
      assert.strictEqual(result.skipped, 1);
      assert.strictEqual(result.enriched, 0);
    });

    it("should skip instruments returning sector=null from fetcher", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "NOSEC",
            yahooSymbol: "NOSEC.NS",
          }),
        ],
        async () => ({ sector: null, industry: "SomeIndustry" })
      );
      assert.strictEqual(result.skipped, 1);
    });

    it("should mark 404 errors as skipped (not failed)", async () => {
      const result = await runEnrichment(
        [createInstrument({ id: "1", symbol: "GONE", yahooSymbol: "GONE.NS" })],
        f404Fetcher
      );
      assert.strictEqual(result.skipped, 1);
      assert.strictEqual(result.failed, 0);
    });

    it("should count non-404 errors as failed", async () => {
      const result = await runEnrichment(
        [createInstrument({ id: "1", symbol: "ERR", yahooSymbol: "ERR.NS" })],
        errorFetcher("Connection timeout")
      );
      assert.strictEqual(result.failed, 1);
      assert.strictEqual(result.skipped, 0);
    });

    it("should record error messages with symbol + reason", async () => {
      const result = await runEnrichment(
        [createInstrument({ id: "1", symbol: "FAIL", yahooSymbol: "FAIL.NS" })],
        errorFetcher("Rate limited")
      );
      assert.strictEqual(result.errors.length, 1);
      assert.ok(result.errors[0].includes("FAIL"));
      assert.ok(result.errors[0].includes("Rate limited"));
    });

    it("should record all error messages", async () => {
      const result = await runEnrichment(
        Array.from({ length: 15 }, (_, i) =>
          createInstrument({
            id: `${i}`,
            symbol: `ERR${i}`,
            yahooSymbol: `ERR${i}.NS`,
          })
        ),
        errorFetcher("Server error")
      );
      assert.strictEqual(result.failed, 15);
      assert.strictEqual(result.errors.length, 15);
    });
  });

  // ==========================================================================
  // Sector Normalization (real normalizeToNseSector + YAHOO_TO_NSE_MAP)
  // ==========================================================================
  describe("Sector Normalization", () => {
    it("should map 'Technology' to 'Information Technology'", () => {
      assert.strictEqual(
        normalizeToNseSector("Technology"),
        "Information Technology"
      );
    });

    it("should map 'Consumer Cyclical' to 'Consumer Discretionary'", () => {
      assert.strictEqual(
        normalizeToNseSector("Consumer Cyclical"),
        "Consumer Discretionary"
      );
    });

    it("should map 'Basic Materials' to 'Commodities'", () => {
      assert.strictEqual(
        normalizeToNseSector("Basic Materials"),
        "Commodities"
      );
    });

    it("should map 'Consumer Defensive' to 'FMCG'", () => {
      assert.strictEqual(normalizeToNseSector("Consumer Defensive"), "FMCG");
    });

    it("should map 'Communication Services' to 'Telecommunication'", () => {
      assert.strictEqual(
        normalizeToNseSector("Communication Services"),
        "Telecommunication"
      );
    });

    it("should return known NSE sector as-is", () => {
      assert.strictEqual(
        normalizeToNseSector("Information Technology"),
        "Information Technology"
      );
    });

    it("should return unknown sector as-is (fallback)", () => {
      assert.strictEqual(
        normalizeToNseSector("Alien Technology"),
        "Alien Technology"
      );
    });

    it("YAHOO_TO_NSE_MAP and NSE_SECTORS are consistent", () => {
      // Every mapped target should be a known NSE sector (or itself a valid key).
      for (const target of Object.values(YAHOO_TO_NSE_MAP)) {
        assert.ok(
          target in NSE_SECTORS,
          `YAHOO_TO_NSE_MAP target '${target}' should be a known NSE sector`
        );
      }
    });
  });

  // ==========================================================================
  // isUnfetchableYahooSymbol (real)
  // ==========================================================================
  describe("isUnfetchableYahooSymbol", () => {
    it("should return true for empty string", () => {
      assert.strictEqual(isUnfetchableYahooSymbol(""), true);
    });

    it("should return true for digit-leading symbols", () => {
      assert.strictEqual(isUnfetchableYahooSymbol("891234.BO"), true);
      assert.strictEqual(isUnfetchableYahooSymbol("500325.BO"), true);
    });

    it("should return false for regular equity symbols", () => {
      assert.strictEqual(isUnfetchableYahooSymbol("RELIANCE.NS"), false);
      assert.strictEqual(isUnfetchableYahooSymbol("TCS.NS"), false);
      assert.strictEqual(isUnfetchableYahooSymbol("INFY.NS"), false);
    });

    it("should return false for equities with mid-symbol digits", () => {
      assert.strictEqual(isUnfetchableYahooSymbol("A2ZINFRA.NS"), false);
    });

    it("should return true for -BE suffix", () => {
      assert.strictEqual(isUnfetchableYahooSymbol("XYZCO-BE.NS"), true);
    });

    it("should return true for FMP symbols", () => {
      assert.strictEqual(isUnfetchableYahooSymbol("KTKFMP46G.BO"), true);
      assert.strictEqual(isUnfetchableYahooSymbol("SFMP68GR.BO"), true);
    });

    it("should return true for roman numeral NCD codes", () => {
      assert.strictEqual(isUnfetchableYahooSymbol("RFHXXIV05G.BO"), true);
      assert.strictEqual(isUnfetchableYahooSymbol("NFHXXV01G.BO"), true);
    });

    // MONEY-1172 — these two used to assert that a leading "Z" meant
    // "BSE suspended/delisted" on .BO and nothing at all on .NS. That pair was
    // the bug, stated as a contract: BSE's **Z GROUP** is a surveillance
    // classification held in its own field, not a property of how a trading
    // symbol is spelled. The rule tombstoned ZOMATO.BO, ZYDUSLIFE.BO, ZEEL.BO
    // and ZENSARTECH.BO — and because the tombstone is written WITHOUT fetching
    // and the cron only re-reads rows with a NULL sector, permanently.
    //
    // The old pair is self-refuting read together: the same company was
    // "suspended" on BSE and fine on NSE purely because of the suffix.
    it("[regression] a leading Z is not a suspension signal, on either exchange", () => {
      assert.strictEqual(isUnfetchableYahooSymbol("ZENSARTECH.NS"), false);
      assert.strictEqual(isUnfetchableYahooSymbol("ZENSARTECH.BO"), false);
      assert.strictEqual(isUnfetchableYahooSymbol("ZOMATO.BO"), false);
    });

    it("a genuinely suspended Z-group stock is fetched, then skipped on the result", () => {
      // ZHINDHSG may well be unlisted — but that is for the FETCH to establish,
      // not the spelling. It now costs one HTTP call and reaches
      // decideFetchOutcome, which writes the sentinel when Yahoo returns no
      // sector. Same end state for a real dud, without taking live companies
      // with it. If Z-group should be skipped up front, read the group letter
      // (MONEY-1093's BSE scrip-master enricher supplies it).
      assert.strictEqual(isUnfetchableYahooSymbol("ZHINDHSG.BO"), false);
    });
  });

  // ==========================================================================
  // Decision helpers (direct)
  // ==========================================================================
  describe("decideFetchOutcome / decideErrorOutcome", () => {
    const inst = createInstrument({
      id: "x",
      symbol: "TCS",
      yahooSymbol: "TCS.NS",
    });

    it("enriched outcome normalizes sector and keeps industry", () => {
      const o = decideFetchOutcome(inst, {
        sector: "Technology",
        industry: "IT Services",
      });
      assert.strictEqual(o.kind, "enriched");
      assert.strictEqual(o.update?.sector, "Information Technology");
      assert.strictEqual(o.update?.industry, "IT Services");
    });

    it("null sectorData → skipped with SECTOR_SKIPPED", () => {
      const o = decideFetchOutcome(inst, null);
      assert.strictEqual(o.kind, "skipped");
      assert.strictEqual(o.update?.sector, SECTOR_SKIPPED);
      assert.strictEqual(o.update?.industry, SECTOR_SKIPPED);
    });

    it("404 error → skipped", () => {
      const o = decideErrorOutcome(inst, new Error("Request failed 404"));
      assert.strictEqual(o.kind, "skipped");
      assert.strictEqual(o.update?.sector, SECTOR_SKIPPED);
    });

    it("non-404 error → failed with message", () => {
      const o = decideErrorOutcome(inst, new Error("Timeout"));
      assert.strictEqual(o.kind, "failed");
      assert.ok(o.error?.includes("TCS"));
      assert.ok(o.error?.includes("Timeout"));
    });
  });

  describe("groupPendingUpdatesByData", () => {
    it("groups identical sector/industry pairs into a single write", () => {
      const groups = groupPendingUpdatesByData([
        { id: "1", sector: "Information Technology", industry: "IT" },
        { id: "2", sector: "Information Technology", industry: "IT" },
        { id: "3", sector: "Financial Services", industry: "Banking" },
      ]);
      const itGroup = groups.find((g) => g.sector === "Information Technology");
      assert.ok(itGroup);
      assert.deepStrictEqual(itGroup!.ids.sort(), ["1", "2"]);
      assert.strictEqual(groups.length, 2);
    });

    it("maps empty industry back to null", () => {
      const groups = groupPendingUpdatesByData([
        { id: "1", sector: SECTOR_SKIPPED, industry: null },
      ]);
      assert.strictEqual(groups.length, 1);
      assert.strictEqual(groups[0].industry, null);
    });
  });

  // ==========================================================================
  // selectSymbolKeysToEnrich (on-demand enrichment selection/bounding)
  // ==========================================================================
  describe("selectSymbolKeysToEnrich", () => {
    it("passes through a small clean set unchanged", () => {
      const out = selectSymbolKeysToEnrich([
        { symbol: "TMCV", exchange: "NSE" },
        { symbol: "TCS", exchange: "NSE" },
      ]);
      assert.deepStrictEqual(out, [
        { symbol: "TMCV", exchange: "NSE" },
        { symbol: "TCS", exchange: "NSE" },
      ]);
    });

    it("de-duplicates case-insensitively, preserving first-seen casing", () => {
      const out = selectSymbolKeysToEnrich([
        { symbol: "TMCV", exchange: "NSE" },
        { symbol: "tmcv", exchange: "nse" }, // dupe
        { symbol: "TMCV", exchange: "BSE" }, // distinct exchange → kept
      ]);
      assert.deepStrictEqual(out, [
        { symbol: "TMCV", exchange: "NSE" },
        { symbol: "TMCV", exchange: "BSE" },
      ]);
    });

    it("drops empty / whitespace-only symbols and exchanges", () => {
      const out = selectSymbolKeysToEnrich([
        { symbol: "", exchange: "NSE" },
        { symbol: "  ", exchange: "NSE" },
        { symbol: "TCS", exchange: "" },
        { symbol: "INFY", exchange: "NSE" },
      ]);
      assert.deepStrictEqual(out, [{ symbol: "INFY", exchange: "NSE" }]);
    });

    it("trims surrounding whitespace on kept keys", () => {
      const out = selectSymbolKeysToEnrich([
        { symbol: "  TMCV ", exchange: " NSE " },
      ]);
      assert.deepStrictEqual(out, [{ symbol: "TMCV", exchange: "NSE" }]);
    });

    it("caps the result at the default 25 (rest left for the cron)", () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        symbol: `S${i}`,
        exchange: "NSE",
      }));
      const out = selectSymbolKeysToEnrich(many);
      assert.strictEqual(out.length, 25);
      assert.deepStrictEqual(out[0], { symbol: "S0", exchange: "NSE" });
      assert.deepStrictEqual(out[24], { symbol: "S24", exchange: "NSE" });
    });

    it("honours an explicit max", () => {
      const many = Array.from({ length: 10 }, (_, i) => ({
        symbol: `S${i}`,
        exchange: "NSE",
      }));
      assert.strictEqual(selectSymbolKeysToEnrich(many, 3).length, 3);
    });

    it("max <= 0 returns empty (never spawns a fetch)", () => {
      assert.deepStrictEqual(
        selectSymbolKeysToEnrich([{ symbol: "TCS", exchange: "NSE" }], 0),
        []
      );
    });

    it("empty / non-array input returns empty", () => {
      assert.deepStrictEqual(selectSymbolKeysToEnrich([]), []);
      assert.deepStrictEqual(
        selectSymbolKeysToEnrich(undefined as unknown as []),
        []
      );
    });
  });

  // ==========================================================================
  // Mixed scenario
  // ==========================================================================
  describe("Mixed Scenarios", () => {
    it("should handle mix of fetchable, unfetchable, and error instruments", async () => {
      const fetcher: YahooSectorFetcher = async (symbol) => {
        if (symbol === "TCS.NS")
          return { sector: "Technology", industry: "IT Services" };
        if (symbol === "GONE.NS") throw new Error("404 Not Found");
        if (symbol === "ERR.NS") throw new Error("Timeout");
        return null;
      };

      const result = await runEnrichment(
        [
          createInstrument({ id: "1", symbol: "TCS", yahooSymbol: "TCS.NS" }),
          createInstrument({
            id: "2",
            symbol: "BOND",
            yahooSymbol: "891234.BO",
          }),
          createInstrument({ id: "3", symbol: "GONE", yahooSymbol: "GONE.NS" }),
          createInstrument({ id: "4", symbol: "ERR", yahooSymbol: "ERR.NS" }),
          createInstrument({
            id: "5",
            symbol: "UNKNOWN",
            yahooSymbol: "UNKNOWN.NS",
          }),
        ],
        fetcher
      );

      assert.strictEqual(result.totalProcessed, 5);
      assert.strictEqual(result.enriched, 1); // TCS
      assert.strictEqual(result.skipped, 3); // BOND + GONE(404) + UNKNOWN(null)
      assert.strictEqual(result.failed, 1); // ERR
      assert.strictEqual(result.errors.length, 1);
    });

    it("should preserve industry data alongside sector in the write", async () => {
      const result = await runEnrichment(
        [
          createInstrument({
            id: "1",
            symbol: "HDFCBANK",
            yahooSymbol: "HDFCBANK.NS",
          }),
        ],
        successFetcher("Financial Services", "Banking - Private")
      );
      const write = result.writes.find(
        (w) => w.sector === "Financial Services"
      );
      assert.ok(write);
      assert.strictEqual(write!.industry, "Banking - Private");
    });
  });
});
