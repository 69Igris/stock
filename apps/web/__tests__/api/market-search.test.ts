/**
 * Market Symbol Search — REAL logic test.
 *
 * Exercises the ACTUAL exported symbols from
 * `@/app/api/market/search/search-logic` (the pure module the search route
 * now imports) and the real `symbol-mapper` helpers — NOT inline copies.
 *
 * Covers:
 *   - parseSearchLimit / parseIncludeIndices / parseTypes / isQueryValid /
 *     getWantedTypes (route input shaping)
 *   - mapAtlasInstrument / mapPrismaInstrument / mapAtlasMf / mapPrismaMf
 *     (source row → SearchResultItem)
 *   - mapPopularStocks / mapPopularIndices (no-query fallback shaping)
 *   - filterIndianYahooResults (NSE/BSE-only Yahoo gate)
 *   - matchLocalIndices / isPlausibleIndexReference (INDEX_MAPPINGS query match
 *     + exchange derivation)
 *   - filterUsResults + isUsResult + isDelistedUsResult (us-stocks flag gate)
 *   - mapUsInstrument / usAssetTypesForTypes / marketRank (MONEY-980 US leg)
 *   - presortNseFirst (NSE-before-BSE pre-sort for dedup)
 *   - dedupeResults (equity-by-base-symbol / other-by-yahoo + type gate)
 *   - compareSearchResults / rankSearchResults (the 8-criteria ranking,
 *     including the Atlas-score tiebreak)
 *   - capIndexRows / MAX_INDEX_ROWS (the per-group INDEX budget cap)
 *   - resolveSearchSource (atlas / db+yahoo / yahoo label)
 *   - toYahooSymbol / getAvailableIndices / POPULAR_STOCKS (real symbol-mapper)
 *   - the routes' upper-cased-Atlas-query wiring (source invariant, last block)
 *
 * MONEY-1205 — this file gained the regression suite for "an exact match is
 * buried by index injection": the index predicate, the budget cap, the score
 * tiebreak and the quote-tolerant name prefix. Every one of them is
 * mutation-proven (revert the fix → exactly these tests go red).
 *
 * (Replaces the previous SHADOW version, which reimplemented INDEX_MAPPINGS,
 * the row mappers, the dedup, and the sort comparator inline — including a
 * dedup that keyed equity by yahooSymbol and a sort missing the symbol-prefix
 * and NSE/BSE criteria — and asserted the copies. The transforms below were
 * INLINE in route.ts and untestable behind Clerk/Prisma; route.ts now imports
 * & calls them, so this asserts the same code production runs.)
 *
 * Source: apps/web/app/api/market/search/search-logic.ts
 *         (imported by apps/web/app/api/market/search/route.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSearchLimit,
  parseIncludeIndices,
  parseIncludeUs,
  parseTypes,
  isQueryValid,
  getWantedTypes,
  mapAtlasInstrument,
  mapPrismaInstrument,
  mapAtlasMf,
  mapPrismaMf,
  mapPopularStocks,
  mapPopularIndices,
  filterIndianYahooResults,
  matchLocalIndices,
  isPlausibleIndexReference,
  filterUsResults,
  isUsResult,
  isDelistedUsResult,
  marketRank,
  hasDisplayName,
  mapUsInstrument,
  usInstrumentType,
  usAssetTypesForTypes,
  US_RESULT_LIMIT,
  presortNseFirst,
  dedupeResults,
  compareSearchResults,
  rankSearchResults,
  capIndexRows,
  MAX_INDEX_ROWS,
  resolveSearchSource,
  type SearchResultItem,
  type UsInstrumentResultRow,
  type AtlasInstrumentRow,
  type PrismaInstrumentRow,
  type AtlasMfRow,
  type PrismaMfRow,
  type YahooSearchRow,
} from "@/app/api/market/search/search-logic";
import {
  toYahooSymbol,
  getAvailableIndices,
  POPULAR_STOCKS,
} from "@/lib/market/symbol-mapper";

// ── Fixture builder ──

function eq(
  symbol: string,
  overrides: Partial<SearchResultItem> = {}
): SearchResultItem {
  return {
    symbol,
    name: overrides.name ?? `${symbol} Ltd`,
    exchange: overrides.exchange ?? "NSE",
    type: overrides.type ?? "EQUITY",
    yahooSymbol: overrides.yahooSymbol ?? `${symbol}.NS`,
    instrumentId: overrides.instrumentId,
    sector: overrides.sector,
    instrumentType: overrides.instrumentType ?? overrides.type ?? "EQUITY",
    // MONEY-1205 — Atlas relevance, carried through the mappers onto the row.
    score: overrides.score,
  };
}

/**
 * A US result row, built through the REAL `mapUsInstrument` so the fixtures
 * cannot drift from the mapper the route runs (the shadow-test failure mode).
 */
function us(
  symbol: string,
  overrides: Partial<UsInstrumentResultRow> = {}
): SearchResultItem {
  return mapUsInstrument({
    listingId:
      overrides.listingId ??
      `${symbol}:${overrides.exchange ?? "NASDAQ"}:${overrides.listingEndDate ?? "1980-01-01"}`,
    symbol,
    exchange: overrides.exchange ?? "NASDAQ",
    assetType: overrides.assetType ?? "Stock",
    name: overrides.name === undefined ? `${symbol} Inc` : overrides.name,
    listingStatus: overrides.listingStatus ?? "ACTIVE",
    listingEndDate: overrides.listingEndDate ?? null,
    ...(overrides.score !== undefined ? { score: overrides.score } : {}),
  });
}

describe("Market Search Logic — REAL transforms", () => {
  // ─────────────────────── QUERY PARAM PARSING ───────────────────────
  describe("parseSearchLimit", () => {
    it("defaults to 10 when null", () => {
      assert.equal(parseSearchLimit(null), 10);
    });
    it("parses a numeric string", () => {
      assert.equal(parseSearchLimit("25"), 25);
    });
    it("clamps to the 50 ceiling", () => {
      assert.equal(parseSearchLimit("999"), 50);
      assert.equal(parseSearchLimit("50"), 50);
    });
    it("empty string falls back to 10 (|| default)", () => {
      assert.equal(parseSearchLimit(""), 10);
    });
    it("garbage (non-numeric) clamps to the default 10, never NaN", () => {
      // Regression: a malformed ?limit=abc used to yield NaN (Math.min(NaN, 50)),
      // which then flowed into `prisma … take: NaN` and `Array.slice(0, NaN)`
      // (silently dropping ALL results). parseSearchLimit now finite-guards it.
      assert.equal(parseSearchLimit("abc"), 10);
      assert.ok(Number.isFinite(parseSearchLimit("abc")));
    });
  });

  describe("parseIncludeIndices", () => {
    it("null → true (indices included by default)", () => {
      assert.equal(parseIncludeIndices(null), true);
    });
    it("literal 'false' → false", () => {
      assert.equal(parseIncludeIndices("false"), false);
    });
    it("any other value → true", () => {
      assert.equal(parseIncludeIndices("true"), true);
      assert.equal(parseIncludeIndices(""), true);
      assert.equal(parseIncludeIndices("0"), true);
    });
  });

  describe("parseIncludeUs — the opposite default, deliberately", () => {
    it("only the literal 'true' opts in", () => {
      assert.equal(parseIncludeUs("true"), true);
    });

    it("null → false (US rows are OFF unless a surface asks)", () => {
      // Not symmetry with `parseIncludeIndices` — the inverse of it. Every
      // shipped caller of /api/market/search persists the pick into an
      // India-resolved record (AddTradeDialog, AddMutualFundDialog, the
      // watchlist) or routes it to a page that resolves against
      // `instrument_mappings` only (CommandPalette). "Absent" must mean "no".
      assert.equal(parseIncludeUs(null), false);
    });

    it("every near-miss fails CLOSED", () => {
      // `Boolean("false") === true` is the class of bug this shape avoids —
      // the same reason XBRL_PROJECTION_APPLY compares against the literal.
      for (const value of [
        "",
        "1",
        "yes",
        "TRUE",
        "True",
        "on",
        "false",
        "0",
      ]) {
        assert.equal(
          parseIncludeUs(value),
          false,
          `${JSON.stringify(value)} must not opt in`
        );
      }
    });
  });

  describe("parseTypes", () => {
    it("null / undefined → []", () => {
      assert.deepEqual(parseTypes(null), []);
      assert.deepEqual(parseTypes(undefined), []);
    });
    it("splits on comma and drops empties", () => {
      assert.deepEqual(parseTypes("EQUITY,MF"), ["EQUITY", "MF"]);
      assert.deepEqual(parseTypes("EQUITY,,MF,"), ["EQUITY", "MF"]);
    });
    it("empty string → []", () => {
      assert.deepEqual(parseTypes(""), []);
    });
  });

  describe("isQueryValid", () => {
    it("null / undefined → false", () => {
      assert.equal(isQueryValid(null), false);
      assert.equal(isQueryValid(undefined), false);
    });
    it("empty string → false", () => {
      assert.equal(isQueryValid(""), false);
    });
    it("non-empty → true (even a single char or whitespace)", () => {
      assert.equal(isQueryValid("a"), true);
      assert.equal(isQueryValid(" "), true);
    });
  });

  describe("getWantedTypes", () => {
    it("empty filter wants everything", () => {
      assert.deepEqual(getWantedTypes([]), {
        wantEquity: true,
        wantMF: true,
        wantIndex: true,
        wantETF: true,
        wantDebt: true,
      });
    });
    it("EQUITY turns on wantEquity only (not MF/Index)", () => {
      const w = getWantedTypes(["EQUITY"]);
      assert.equal(w.wantEquity, true);
      assert.equal(w.wantMF, false);
      assert.equal(w.wantIndex, false);
      assert.equal(w.wantETF, false);
    });
    it("ETF turns on BOTH wantEquity and wantETF (shared search path)", () => {
      const w = getWantedTypes(["ETF"]);
      assert.equal(w.wantEquity, true);
      assert.equal(w.wantETF, true);
      assert.equal(w.wantMF, false);
    });
    it("MF turns on wantMF only", () => {
      const w = getWantedTypes(["MF"]);
      assert.equal(w.wantMF, true);
      assert.equal(w.wantEquity, false);
      assert.equal(w.wantIndex, false);
    });
    it("INDEX turns on wantIndex only", () => {
      const w = getWantedTypes(["INDEX"]);
      assert.equal(w.wantIndex, true);
      assert.equal(w.wantEquity, false);
    });
  });

  // ────────────────────────── ROW MAPPERS ──────────────────────────
  describe("mapAtlasInstrument", () => {
    it("maps every field and lifts _id.$oid → instrumentId", () => {
      const row: AtlasInstrumentRow = {
        _id: { $oid: "abc123" },
        symbol: "RELIANCE",
        name: "Reliance Industries",
        exchange: "NSE",
        yahooSymbol: "RELIANCE.NS",
        instrumentType: "EQUITY",
        sector: "Energy",
        score: 30.7,
      };
      assert.deepEqual(mapAtlasInstrument(row), {
        symbol: "RELIANCE",
        name: "Reliance Industries",
        exchange: "NSE",
        type: "EQUITY",
        yahooSymbol: "RELIANCE.NS",
        instrumentId: "abc123",
        sector: "Energy",
        instrumentType: "EQUITY",
        // MONEY-1205 — the pipeline projects `$meta: "searchScore"`; the mapper
        // used to drop it here, which is where the relevance signal died.
        score: 30.7,
      });
    });

    it("undefined _id → instrumentId undefined; missing sector → null", () => {
      const row: AtlasInstrumentRow = {
        symbol: "TCS",
        name: "TCS",
        exchange: "NSE",
        yahooSymbol: "TCS.NS",
        instrumentType: "EQUITY",
      };
      const out = mapAtlasInstrument(row);
      assert.equal(out.instrumentId, undefined);
      assert.equal(out.sector, null);
    });

    it("null sector normalizes to null", () => {
      const row: AtlasInstrumentRow = {
        _id: { $oid: "x" },
        symbol: "X",
        name: "X",
        exchange: "BSE",
        yahooSymbol: "X.BO",
        instrumentType: "ETF",
        sector: null,
      };
      assert.equal(mapAtlasInstrument(row).sector, null);
    });

    it("preserves unicode in name", () => {
      const row: AtlasInstrumentRow = {
        _id: { $oid: "u" },
        symbol: "NIFTYBEES",
        name: "Nippon ETF — Niftý 50 ₹",
        exchange: "NSE",
        yahooSymbol: "NIFTYBEES.NS",
        instrumentType: "ETF",
      };
      assert.equal(mapAtlasInstrument(row).name, "Nippon ETF — Niftý 50 ₹");
    });
  });

  describe("mapPrismaInstrument", () => {
    it("uses row.id as instrumentId and copies instrumentType into type", () => {
      const row: PrismaInstrumentRow = {
        id: "mongoid",
        symbol: "INFY",
        name: "Infosys",
        exchange: "NSE",
        yahooSymbol: "INFY.NS",
        instrumentType: "EQUITY",
        sector: "IT",
      };
      const out = mapPrismaInstrument(row);
      assert.equal(out.instrumentId, "mongoid");
      assert.equal(out.type, "EQUITY");
      assert.equal(out.instrumentType, "EQUITY");
      assert.equal(out.sector, "IT");
    });

    it("null sector stays null", () => {
      const row: PrismaInstrumentRow = {
        id: "i",
        symbol: "S",
        name: "S",
        exchange: "BSE",
        yahooSymbol: "S.BO",
        instrumentType: "EQUITY",
        sector: null,
      };
      assert.equal(mapPrismaInstrument(row).sector, null);
    });
  });

  describe("mapAtlasMf / mapPrismaMf", () => {
    it("Atlas MF → schemeCode=symbol, amcName=exchange, MF type, empty yahoo", () => {
      const row: AtlasMfRow = {
        schemeCode: "118989",
        schemeName: "HDFC Flexi Cap Fund - Direct",
        amcName: "HDFC Mutual Fund",
        category: "Flexi Cap",
        score: 40.5,
      };
      assert.deepEqual(mapAtlasMf(row), {
        symbol: "118989",
        name: "HDFC Flexi Cap Fund - Direct",
        exchange: "HDFC Mutual Fund",
        type: "MF",
        yahooSymbol: "",
        instrumentId: undefined,
        sector: "Flexi Cap",
        instrumentType: "MF",
        // MONEY-1205 — carried, not dropped. See mapAtlasInstrument above.
        score: 40.5,
      });
    });

    it("Prisma MF with null category → sector null", () => {
      const row: PrismaMfRow = {
        schemeCode: "100",
        schemeName: "Some Fund",
        amcName: "Some AMC",
        category: null,
      };
      const out = mapPrismaMf(row);
      assert.equal(out.sector, null);
      assert.equal(out.type, "MF");
      assert.equal(out.yahooSymbol, "");
      assert.equal(out.instrumentId, undefined);
    });
  });

  // ─────────────────────── POPULAR (NO QUERY) ───────────────────────
  describe("mapPopularStocks", () => {
    it("maps the real POPULAR_STOCKS list with .NS suffix and EQUITY type", () => {
      const out = mapPopularStocks(POPULAR_STOCKS, 20);
      assert.equal(out.length, Math.min(20, POPULAR_STOCKS.length));
      for (const r of out) {
        assert.equal(r.type, "EQUITY");
        assert.ok(
          r.yahooSymbol.endsWith(".NS") || r.yahooSymbol.endsWith(".BO")
        );
      }
      assert.equal(out[0].symbol, POPULAR_STOCKS[0].symbol);
    });

    it("respects the limit slice", () => {
      assert.equal(mapPopularStocks(POPULAR_STOCKS, 5).length, 5);
    });

    it("derives .BO for a BSE stock", () => {
      const out = mapPopularStocks(
        [{ symbol: "FOO", name: "Foo", exchange: "BSE" }],
        10
      );
      assert.equal(out[0].yahooSymbol, "FOO.BO");
    });

    it("limit 0 → empty; empty list → empty", () => {
      assert.deepEqual(mapPopularStocks(POPULAR_STOCKS, 0), []);
      assert.deepEqual(mapPopularStocks([], 10), []);
    });
  });

  describe("mapPopularIndices", () => {
    it("maps available indices, deriving exchange from the Yahoo symbol", () => {
      const out = mapPopularIndices(getAvailableIndices().slice(0, 5));
      assert.ok(out.length > 0);
      for (const r of out) {
        assert.equal(r.type, "INDEX");
        assert.equal(r.symbol, r.name);
        assert.equal(r.exchange, r.yahooSymbol.includes("BSE") ? "BSE" : "NSE");
      }
    });

    it("a BSE-symbol index → BSE exchange", () => {
      const out = mapPopularIndices([
        { name: "SENSEX", yahooSymbol: "^BSESN" },
      ]);
      assert.equal(out[0].exchange, "BSE");
    });
  });

  // ────────────────────── INDIAN YAHOO FILTER ──────────────────────
  describe("filterIndianYahooResults", () => {
    it("keeps .NS / .BO suffixed symbols", () => {
      const rows: YahooSearchRow[] = [
        {
          symbol: "RELIANCE",
          name: "Reliance",
          exchange: "",
          type: "EQUITY",
          yahooSymbol: "RELIANCE.NS",
        },
        {
          symbol: "TCS",
          name: "TCS",
          exchange: "",
          type: "EQUITY",
          yahooSymbol: "TCS.BO",
        },
      ];
      assert.equal(filterIndianYahooResults(rows).length, 2);
    });

    it("keeps NSE/BSE/NSI/BOM exchange codes (case-insensitive) without suffix", () => {
      const rows: YahooSearchRow[] = [
        {
          symbol: "A",
          name: "A",
          exchange: "NSE",
          type: "EQUITY",
          yahooSymbol: "A",
        },
        {
          symbol: "B",
          name: "B",
          exchange: "bse",
          type: "EQUITY",
          yahooSymbol: "B",
        },
        {
          symbol: "C",
          name: "C",
          exchange: "NSI",
          type: "EQUITY",
          yahooSymbol: "C",
        },
        {
          symbol: "D",
          name: "D",
          exchange: "BOM",
          type: "EQUITY",
          yahooSymbol: "D",
        },
      ];
      assert.equal(filterIndianYahooResults(rows).length, 4);
    });

    it("drops US / foreign listings", () => {
      const rows: YahooSearchRow[] = [
        {
          symbol: "AAPL",
          name: "Apple",
          exchange: "NASDAQ",
          type: "EQUITY",
          yahooSymbol: "AAPL",
        },
        {
          symbol: "VOD",
          name: "Vodafone",
          exchange: "LSE",
          type: "EQUITY",
          yahooSymbol: "VOD.L",
        },
      ];
      assert.deepEqual(filterIndianYahooResults(rows), []);
    });

    it("falls back to symbol when yahooSymbol is empty", () => {
      const rows: YahooSearchRow[] = [
        {
          symbol: "RELIANCE.NS",
          name: "Reliance",
          exchange: "",
          type: "EQUITY",
          yahooSymbol: "",
        },
      ];
      assert.equal(filterIndianYahooResults(rows).length, 1);
    });

    it("empty input → empty output", () => {
      assert.deepEqual(filterIndianYahooResults([]), []);
    });
  });

  // ─────────────────────── LOCAL INDEX MATCH ───────────────────────
  describe("matchLocalIndices", () => {
    it("'NIFTY 50' matches and derives NSE (^NSEI has no 'BSE')", () => {
      const out = matchLocalIndices("NIFTY 50");
      const nifty50 = out.find((r) => r.name === "NIFTY 50");
      assert.ok(nifty50, "NIFTY 50 should be present");
      assert.equal(nifty50!.exchange, "NSE");
      assert.equal(nifty50!.yahooSymbol, "^NSEI");
      assert.equal(nifty50!.type, "INDEX");
      assert.equal(nifty50!.symbol, "NIFTY 50");
    });

    it("'BSE SENSEX' derives BSE (^BSESN contains 'BSE')", () => {
      const out = matchLocalIndices("BSE SENSEX");
      const sensex = out.find((r) => r.name === "BSE SENSEX");
      assert.ok(sensex);
      assert.equal(sensex!.exchange, "BSE");
      assert.equal(sensex!.yahooSymbol, "^BSESN");
    });

    it("non-index gibberish returns empty (no first-word collision)", () => {
      assert.deepEqual(matchLocalIndices("ZZZZQ"), []);
    });

    it("every matched row carries type INDEX and a caret yahooSymbol", () => {
      const out = matchLocalIndices("NIFTY");
      assert.ok(out.length > 0);
      for (const r of out) {
        assert.equal(r.type, "INDEX");
        assert.ok(r.yahooSymbol.startsWith("^"));
        assert.equal(r.symbol, r.name);
      }
    });

    // ── MONEY-1205: the index-injection defect ──
    //
    // The predicate was `name.includes(q) || q.includes(name.split(" ")[0])`.
    // Half two was meant for "NIFTY" → "NIFTY 50" but it tests the QUERY for
    // containment, so it fired for any query that merely mentioned NIFTY / BSE
    // / SENSEX / INDIA. This block is the fix's contract.

    it("a long query that merely MENTIONS 'NIFTY' matches no index at all", () => {
      // Reproduced against prod Atlas: this returned 17 index rows — more than
      // the palette's whole limit=12 budget — which pushed the ETF whose exact
      // name the user typed (SBIETFQLTY, Atlas rank #1, score 30.7) to rank 31
      // of 40. The user searched for a fund and got a wall of indices.
      assert.deepEqual(matchLocalIndices("SBI NIFTY 200 QUALITY 30 ETF"), []);
    });

    it("the token-count guard: more words than the index name → not that index", () => {
      // No entry in the 29-row map has more than 3 words, so a 4-word query
      // cannot be any of them however many words it shares.
      assert.deepEqual(matchLocalIndices("NIFTY BANK JUNIOR BEES"), []);
      // 3 words vs "NIFTY BANK"'s 2 — still one too many.
      assert.deepEqual(matchLocalIndices("NIFTY BANK ETF"), []);
    });

    it("a query longer than the index name is not a prefix of it either", () => {
      // Was the old first-word-containment case ("NIFTYFOO" contains "NIFTY").
      assert.deepEqual(matchLocalIndices("NIFTYFOO"), []);
    });

    it("still matches the real type-ahead cases it exists for", () => {
      const names = (q: string) => matchLocalIndices(q).map((r) => r.name);

      // Bare index word → the family.
      assert.ok(names("NIFTY").includes("NIFTY 50"));
      assert.ok(names("NIFTY").includes("NIFTY BANK"));
      // Mid-word prefix.
      assert.deepEqual(names("NIFTY BA"), ["NIFTY BANK"]);
      // Exact name.
      assert.ok(names("NIFTY 50").includes("NIFTY 50"));
      // Token subset in the "wrong" order — how people actually say it.
      assert.ok(names("BANK NIFTY").includes("NIFTY BANK"));
      // A single token that is a word of a longer name.
      assert.ok(names("SENSEX").includes("BSE SENSEX"));
      assert.ok(names("VIX").includes("INDIA VIX"));
    });

    it("case-normalises the query (a lower-cased query used to match nothing)", () => {
      // The route upper-cases before calling, but the function silently
      // returned [] for anything else — a landmine for any new caller.
      assert.deepEqual(
        matchLocalIndices("nifty ba").map((r) => r.name),
        ["NIFTY BANK"]
      );
      assert.ok(matchLocalIndices("nifty").length > 0);
    });

    it("an empty query matches nothing (it used to match all 29)", () => {
      // `"NIFTY 50".includes("")` is true, so every index was injected.
      assert.deepEqual(matchLocalIndices(""), []);
      assert.deepEqual(matchLocalIndices("   "), []);
    });

    it("the whole map stays reachable by its own name", () => {
      // Guards the predicate against over-tightening: every hardcoded index
      // must still be findable by typing exactly what it is called.
      for (const { name } of getAvailableIndices()) {
        assert.ok(
          matchLocalIndices(name).some((r) => r.name === name),
          `${name} must match its own name`
        );
      }
    });
  });

  // ─────────────────── INDEX BUDGET CAP (MONEY-1205) ───────────────────
  describe("capIndexRows", () => {
    const idx = (name: string): SearchResultItem => ({
      symbol: name,
      name,
      exchange: "NSE",
      type: "INDEX",
      yahooSymbol: `^${name.replace(/\s/g, "")}`,
    });

    it("keeps at most 3 index rows at the head", () => {
      const rows = [...Array.from({ length: 20 }, (_, i) => idx(`IDX${i}`))];
      const out = capIndexRows([...rows, eq("SBIETFQLTY")]);
      assert.equal(out.slice(0, 3).filter((r) => r.type === "INDEX").length, 3);
      assert.equal(out[3].symbol, "SBIETFQLTY");
    });

    it("the exact ETF survives limit=12 against 20 index rows", () => {
      // The whole point: 20 indices + 1 exact match, sliced to the palette's
      // limit of 12. Before the cap the ETF was at rank 21 and invisible.
      const rows = [
        ...Array.from({ length: 20 }, (_, i) => idx(`IDX${i}`)),
        eq("SBIETFQLTY", { type: "ETF", name: "SBI NIFTY 200 QUALITY 30 ETF" }),
      ];
      const page = capIndexRows(rows).slice(0, 12);
      assert.ok(
        page.some((r) => r.symbol === "SBIETFQLTY"),
        "the ETF must be on the first page"
      );
      assert.equal(page.length, 12, "the page is still full");
    });

    it("demotes rather than drops — length and membership are preserved", () => {
      const rows = [
        ...Array.from({ length: 6 }, (_, i) => idx(`IDX${i}`)),
        eq("A"),
      ];
      const out = capIndexRows(rows);
      assert.equal(out.length, rows.length);
      assert.deepEqual(
        [...out].map((r) => r.symbol).sort(),
        [...rows].map((r) => r.symbol).sort()
      );
    });

    it("an all-index result set is left completely alone", () => {
      // A user who typed "NIFTY BANK" and matched only indices must not be
      // answered with 3 rows when 6 matched.
      const rows = Array.from({ length: 6 }, (_, i) => idx(`IDX${i}`));
      assert.deepEqual(capIndexRows(rows), rows);
    });

    it("under the cap is a no-op; non-index order is untouched", () => {
      const rows = [idx("NIFTY 50"), eq("A"), idx("NIFTY BANK"), eq("B")];
      assert.deepEqual(
        capIndexRows(rows).map((r) => r.symbol),
        ["NIFTY 50", "A", "NIFTY BANK", "B"]
      );
    });

    it("keeps the BEST-ranked indices (it runs after the sort)", () => {
      const rows = [idx("BEST"), idx("SECOND"), idx("THIRD"), idx("WORST")];
      const out = capIndexRows([...rows, eq("A")], 3);
      assert.deepEqual(
        out.map((r) => r.symbol),
        ["BEST", "SECOND", "THIRD", "A", "WORST"]
      );
    });

    it("does not mutate the input", () => {
      const rows = [idx("A"), idx("B"), idx("C"), idx("D"), eq("X")];
      const snapshot = rows.map((r) => r.symbol);
      capIndexRows(rows);
      assert.deepEqual(
        rows.map((r) => r.symbol),
        snapshot
      );
    });

    it("empty input → empty output", () => {
      assert.deepEqual(capIndexRows([]), []);
    });

    it("defaults to MAX_INDEX_ROWS, which leaves room on a limit=12 page", () => {
      assert.equal(MAX_INDEX_ROWS, 3);
      const rows = [
        ...Array.from({ length: 20 }, (_, i) => idx(`IDX${i}`)),
        eq("A"),
      ];
      assert.deepEqual(
        capIndexRows(rows).map((r) => r.type),
        capIndexRows(rows, MAX_INDEX_ROWS).map((r) => r.type)
      );
    });

    it("cap 0 demotes every index below the other rows", () => {
      const rows = [idx("I1"), idx("I2"), eq("A")];
      assert.deepEqual(
        capIndexRows(rows, 0).map((r) => r.symbol),
        ["A", "I1", "I2"]
      );
    });

    it("the demotion stops at the market band — never below a US row", () => {
      // MONEY-980 review. `others` holds US rows too, so appending the surplus
      // after ALL of them put an Indian index below a US listing — inverting
      // ranking criterion 0 (the coarsest, most deliberate criterion there is)
      // from inside a function whose only job is a within-page reshuffle.
      //
      // Every INDEX row is Indian by construction: `matchLocalIndices` reads a
      // hardcoded India map, and `usInstrumentType` can only produce
      // EQUITY / ETF / MF.
      const rows = [
        idx("I1"),
        idx("I2"),
        idx("I3"),
        idx("I4"),
        idx("I5"),
        eq("INDIASTOCK"),
        us("USSTOCK", { name: "US Stock Inc" }),
      ];
      assert.deepEqual(
        capIndexRows(rows, 3).map((r) => r.symbol),
        ["I1", "I2", "I3", "INDIASTOCK", "I4", "I5", "USSTOCK"]
      );
      // Stated as the invariant rather than only as a literal: no India row may
      // follow a US row after the cap.
      const out = capIndexRows(rows, 3);
      const firstUs = out.findIndex((r) => r.market === "US");
      assert.ok(firstUs >= 0);
      assert.equal(
        out.slice(firstUs).every((r) => r.market === "US"),
        true,
        "the US section must be a suffix"
      );
    });

    it("...and still demotes when the ONLY other rows are US", () => {
      const rows = [idx("I1"), idx("I2"), idx("I3"), idx("I4"), us("USONLY")];
      assert.deepEqual(
        capIndexRows(rows, 3).map((r) => r.symbol),
        ["I1", "I2", "I3", "I4", "USONLY"]
      );
    });
  });

  // ───────────── INDEX-REFERENCE PREDICATE (MONEY-1205) ─────────────
  describe("isPlausibleIndexReference", () => {
    it("full and prefix matches on the index name", () => {
      assert.equal(isPlausibleIndexReference("NIFTY 50", "NIFTY 50"), true);
      assert.equal(isPlausibleIndexReference("NIFTY 50", "NIFTY"), true);
      assert.equal(isPlausibleIndexReference("NIFTY BANK", "NIFTY BA"), true);
      assert.equal(isPlausibleIndexReference("NIFTY 50", "NIFTY 5"), true);
    });

    it("token-subset matches, order-independent", () => {
      assert.equal(isPlausibleIndexReference("NIFTY BANK", "BANK"), true);
      assert.equal(isPlausibleIndexReference("NIFTY BANK", "BANK NIFTY"), true);
      assert.equal(isPlausibleIndexReference("BSE SENSEX", "SENSEX"), true);
      assert.equal(isPlausibleIndexReference("INDIA VIX", "VIX"), true);
      assert.equal(
        isPlausibleIndexReference("NIFTY MIDCAP 100", "MIDCAP 100"),
        true
      );
    });

    it("a partial WORD is not a token — only a name prefix counts", () => {
      // "BAN" prefixes the NAME "NIFTY BANK" only from the left; as a bare
      // token it must not match, or every 3-letter string matches something.
      assert.equal(isPlausibleIndexReference("NIFTY BANK", "BAN"), false);
      assert.equal(isPlausibleIndexReference("NIFTY BANK", "NIFTY BAN"), true);
    });

    it("THE GUARD: more query words than the index name has → false", () => {
      assert.equal(
        isPlausibleIndexReference("NIFTY 50", "SBI NIFTY 200 QUALITY 30 ETF"),
        false
      );
      assert.equal(
        isPlausibleIndexReference("NIFTY BANK", "NIFTY BANK A"),
        false
      );
    });

    it("a token the index does not have → false, however many match", () => {
      assert.equal(isPlausibleIndexReference("NIFTY 50", "NIFTY 200"), false);
      assert.equal(isPlausibleIndexReference("BSE SENSEX", "BSE NIFTY"), false);
    });

    it("empty / whitespace query → false", () => {
      assert.equal(isPlausibleIndexReference("NIFTY 50", ""), false);
      assert.equal(isPlausibleIndexReference("NIFTY 50", "   "), false);
    });

    it("case-insensitive on both sides", () => {
      assert.equal(isPlausibleIndexReference("NIFTY 50", "nifty"), true);
      assert.equal(isPlausibleIndexReference("nifty bank", "BANK NIFTY"), true);
    });
  });

  // ──────────────────── US LISTING MAPPER (MONEY-980) ────────────────────
  describe("mapUsInstrument", () => {
    const lehman: UsInstrumentResultRow = {
      listingId: "LEH:NYSE:1994-05-04",
      symbol: "LEH",
      exchange: "NYSE",
      assetType: "Stock",
      name: "Lehman Brothers Holdings Inc",
      listingStatus: "DELISTED",
      listingEndDate: "2017-01-13T00:00:00.000Z",
      score: 12.5,
    };

    it("carries everything a UI needs to badge `DELISTED · 2017`", () => {
      const row = mapUsInstrument(lehman);
      assert.equal(row.market, "US");
      assert.equal(row.listingStatus, "DELISTED");
      assert.equal(row.listingEndDate, "2017-01-13T00:00:00.000Z");
      assert.equal(new Date(row.listingEndDate!).getUTCFullYear(), 2017);
      assert.equal(row.listingId, "LEH:NYSE:1994-05-04");
      assert.equal(row.assetType, "Stock");
      assert.equal(row.score, 12.5);
    });

    it("the Yahoo symbol is the BARE ticker — never suffixed", () => {
      // `.NS` here would collide with a real NSE row and, historically, break
      // the unique index on the India table.
      assert.equal(mapUsInstrument(lehman).yahooSymbol, "LEH");
      assert.ok(!mapUsInstrument(lehman).yahooSymbol.endsWith(".NS"));
    });

    it("a NULL name becomes an empty name + hasName:false, NEVER the symbol", () => {
      // The trap: `name = symbol` would render a company literally called
      // "LEH" and erase the distinction the ranking depends on.
      const row = mapUsInstrument({ ...lehman, name: null });
      assert.equal(row.name, "");
      assert.equal(row.hasName, false);
      assert.notEqual(row.name, row.symbol);
    });

    it("a whitespace-only name counts as no name", () => {
      const row = mapUsInstrument({ ...lehman, name: "   " });
      assert.equal(row.hasName, false);
    });

    it("maps Tiingo asset types onto the canonical instrument types", () => {
      assert.equal(usInstrumentType("Stock"), "EQUITY");
      assert.equal(usInstrumentType("ETF"), "ETF");
      assert.equal(usInstrumentType("Mutual Fund"), "MF");
      // An unknown assetType must NOT pass through as itself: `type` gates the
      // dedup filter, and an unrecognised value silently deletes the row.
      assert.equal(usInstrumentType("Warrant"), "EQUITY");
      assert.equal(
        mapUsInstrument({ ...lehman, assetType: "ETF" }).type,
        "ETF"
      );
      assert.equal(
        mapUsInstrument({ ...lehman, assetType: "Mutual Fund" }).instrumentType,
        "MF"
      );
    });
  });

  describe("usAssetTypesForTypes", () => {
    it("an empty request means every asset type (expressed as no filter)", () => {
      assert.deepEqual(usAssetTypesForTypes([]), []);
    });

    it("maps the canonical types onto Tiingo's verbatim spellings", () => {
      assert.deepEqual(usAssetTypesForTypes(["EQUITY"]), ["Stock"]);
      assert.deepEqual(usAssetTypesForTypes(["ETF"]), ["ETF"]);
      assert.deepEqual(usAssetTypesForTypes(["MF"]), ["Mutual Fund"]);
      assert.deepEqual(usAssetTypesForTypes(["EQUITY", "ETF", "MF"]), [
        "Stock",
        "ETF",
        "Mutual Fund",
      ]);
    });

    it("casing is Tiingo's, not ours — token filters match exactly", () => {
      // `"STOCK"` / `"MUTUAL FUND"` would match zero rows with no error.
      for (const value of usAssetTypesForTypes(["EQUITY", "MF"])) {
        assert.notEqual(value, value.toUpperCase());
      }
    });

    it("a request with no US counterpart maps to nothing", () => {
      // The route reads this together with `types.length` — `[]` here plus a
      // NON-empty request means "do not run the US leg", never "no filter".
      assert.deepEqual(usAssetTypesForTypes(["DEBT"]), []);
      assert.deepEqual(usAssetTypesForTypes(["INDEX"]), []);
    });
  });

  // ───────────────────────── US-MARKET GATE ──────────────────────
  describe("filterUsResults (MONEY-980)", () => {
    const rows: SearchResultItem[] = [
      eq("RELIANCE"),
      us("AAPL", { name: "Apple Inc" }),
      us("LEH", { listingStatus: "DELISTED", name: "Lehman Brothers" }),
    ];

    it("drops US rows when showUsStocks=false", () => {
      assert.deepEqual(
        filterUsResults(rows, false).map((r) => r.symbol),
        ["RELIANCE"]
      );
    });

    it("keeps US rows — delisted included — when showUsStocks=true", () => {
      assert.deepEqual(
        filterUsResults(rows, true).map((r) => r.symbol),
        ["RELIANCE", "AAPL", "LEH"]
      );
    });

    it("gates on `market`, NOT on the exchange string", () => {
      // The stale-venue-list defect this replaced: five of the eight real US
      // venues (NYSE ARCA, NYSE MKT, NYSE NAT, BATS, NMFQS) were missing from
      // the old hardcoded set, and NMFQS alone carries 49,414 of the 72,685
      // listings. Every one of them must now be gated.
      const venues = [
        "NASDAQ",
        "NYSE",
        "AMEX",
        "NYSE ARCA",
        "NYSE MKT",
        "NYSE NAT",
        "BATS",
        "NMFQS",
      ];
      const wide = venues.map((exchange, i) =>
        us(`SYM${i}`, { exchange, name: `Co ${i}` })
      );
      assert.equal(
        filterUsResults(wide, false).length,
        0,
        "every US venue is gated, not just the seven Yahoo codes"
      );
      assert.equal(filterUsResults(wide, true).length, venues.length);
    });

    it("an India row on a US-sounding exchange is NOT gated", () => {
      // The mirror image: the gate is a positive claim about the row's origin,
      // so an India row can never be removed by it however it is spelled.
      const indiaRow = eq("X", { exchange: "NASDAQ" });
      assert.equal(filterUsResults([indiaRow], false).length, 1);
      assert.equal(isUsResult(indiaRow), false);
    });

    it('`market: "IN"` is explicit-India, not truthy-US', () => {
      // A truthiness test on `market` would call this US and delete it.
      const explicitIndia: SearchResultItem = { ...eq("TCS"), market: "IN" };
      assert.equal(isUsResult(explicitIndia), false);
      assert.equal(filterUsResults([explicitIndia], false).length, 1);
    });

    it("only a US row can be DELISTED", () => {
      const strayStatus: SearchResultItem = {
        ...eq("TCS"),
        listingStatus: "DELISTED",
      };
      assert.equal(isDelistedUsResult(strayStatus), false);
      assert.equal(marketRank(strayStatus), 0);
    });

    it("listingStatus casing does not decide the answer", () => {
      assert.equal(
        isDelistedUsResult(us("X", { listingStatus: "delisted" })),
        true
      );
      assert.equal(marketRank(us("X", { listingStatus: "active" })), 1);
    });
  });

  // ───────────────────── NSE-FIRST PRESORT ─────────────────────
  describe("presortNseFirst", () => {
    it("floats NSE rows ahead of non-NSE without mutating input", () => {
      const input = [
        eq("R", { exchange: "BSE" }),
        eq("R", { exchange: "NSE" }),
        eq("M", { exchange: "MF" }),
      ];
      const snapshot = input.map((r) => r.exchange);
      const out = presortNseFirst(input);
      assert.equal(out[0].exchange, "NSE");
      assert.deepEqual(
        input.map((r) => r.exchange),
        snapshot
      );
    });

    it("empty list → empty list", () => {
      assert.deepEqual(presortNseFirst([]), []);
    });
  });

  // ───────────────────────────── DEDUP ─────────────────────────────
  describe("dedupeResults", () => {
    it("collapses dual-listed equity by base symbol (NSE kept after presort)", () => {
      const presorted = presortNseFirst([
        eq("RELIANCE", { exchange: "BSE", yahooSymbol: "RELIANCE.BO" }),
        eq("RELIANCE", { exchange: "NSE", yahooSymbol: "RELIANCE.NS" }),
      ]);
      const out = dedupeResults(presorted);
      assert.equal(out.length, 1);
      assert.equal(out[0].exchange, "NSE");
    });

    it("equity base-symbol key is case-insensitive", () => {
      const out = dedupeResults([
        eq("reliance", { yahooSymbol: "reliance.NS" }),
        eq("RELIANCE", { yahooSymbol: "RELIANCE.NS" }),
      ]);
      assert.equal(out.length, 1);
    });

    it("ETF dedups by base symbol too (NSE+BSE ETF → one)", () => {
      const out = dedupeResults(
        presortNseFirst([
          eq("NIFTYBEES", {
            type: "ETF",
            instrumentType: "ETF",
            exchange: "BSE",
            yahooSymbol: "NIFTYBEES.BO",
          }),
          eq("NIFTYBEES", {
            type: "ETF",
            instrumentType: "ETF",
            exchange: "NSE",
            yahooSymbol: "NIFTYBEES.NS",
          }),
        ])
      );
      assert.equal(out.length, 1);
      assert.equal(out[0].exchange, "NSE");
    });

    it("distinct MFs (empty yahoo) survive — keyed by schemeCode", () => {
      const out = dedupeResults([
        mapAtlasMf({
          schemeCode: "1",
          schemeName: "A",
          amcName: "X",
          category: "C",
        }),
        mapAtlasMf({
          schemeCode: "2",
          schemeName: "B",
          amcName: "Y",
          category: "C",
        }),
      ]);
      assert.equal(out.length, 2);
    });

    it("two MFs with the SAME schemeCode collapse to one", () => {
      const out = dedupeResults([
        mapAtlasMf({
          schemeCode: "999",
          schemeName: "A",
          amcName: "X",
          category: "C",
        }),
        mapPrismaMf({
          schemeCode: "999",
          schemeName: "A dup",
          amcName: "X",
          category: "C",
        }),
      ]);
      assert.equal(out.length, 1);
    });

    it("type gate: only rows whose instrumentType∈types survive", () => {
      const out = dedupeResults(
        [
          eq("R", { type: "EQUITY", instrumentType: "EQUITY" }),
          mapAtlasMf({
            schemeCode: "1",
            schemeName: "MF",
            amcName: "X",
            category: "C",
          }),
          eq("N", {
            type: "INDEX",
            instrumentType: "INDEX",
            yahooSymbol: "^NSEI",
          }),
        ],
        ["MF"]
      );
      assert.deepEqual(
        out.map((r) => r.type),
        ["MF"]
      );
    });

    it("INDEX rows dedup by yahooSymbol (two, same caret symbol → one)", () => {
      const out = dedupeResults([
        {
          symbol: "NIFTY 50",
          name: "NIFTY 50",
          exchange: "NSE",
          type: "INDEX",
          yahooSymbol: "^NSEI",
        },
        {
          symbol: "NIFTY",
          name: "NIFTY",
          exchange: "NSE",
          type: "INDEX",
          yahooSymbol: "^NSEI",
        },
      ]);
      assert.equal(out.length, 1);
    });

    it("empty types array does NOT gate (keeps all uniques)", () => {
      assert.equal(dedupeResults([eq("A"), eq("B")], []).length, 2);
    });

    it("huge list: 5000 uniques + 5000 dups → 5000, no loss", () => {
      const big: SearchResultItem[] = Array.from({ length: 5000 }, (_, i) =>
        eq(`SYM${i}`, { yahooSymbol: `SYM${i}.NS` })
      );
      assert.equal(dedupeResults([...big, ...big]).length, 5000);
    });
  });

  // ─────────────────────────── RANKING ─────────────────────────────
  describe("compareSearchResults / rankSearchResults", () => {
    it("exact symbol match ranks first", () => {
      const ranked = rankSearchResults(
        [eq("RELIANCEPP"), eq("RELIANCE")],
        "RELIANCE",
        false
      );
      assert.equal(ranked[0].symbol, "RELIANCE");
    });

    it("INDEX type beats a non-exact, non-index equity", () => {
      const ranked = rankSearchResults(
        [
          eq("NIFTYBEES", { type: "EQUITY" }),
          {
            symbol: "NIFTY 50",
            name: "NIFTY 50",
            exchange: "NSE",
            type: "INDEX",
            yahooSymbol: "^NSEI",
          },
        ],
        "NIFTY",
        false
      );
      assert.equal(ranked[0].type, "INDEX");
    });

    it("symbol-prefix match beats name-only match (a criterion the shadow lacked)", () => {
      const ranked = rankSearchResults(
        [
          eq("ZZZ", { name: "ABC Corp" }), // name starts with query
          eq("ABCLTD", { name: "Something" }), // symbol starts with query
        ],
        "ABC",
        false
      );
      assert.equal(ranked[0].symbol, "ABCLTD");
    });

    it("NSE before BSE on a pure exchange tiebreak (a criterion the shadow lacked)", () => {
      const ranked = rankSearchResults(
        [
          eq("ABC", { exchange: "BSE", yahooSymbol: "ABC.BO" }),
          eq("ABC", { exchange: "NSE", yahooSymbol: "ABC.NS" }),
        ],
        "XYZ", // neither exact nor prefix → falls to NSE/BSE
        false
      );
      assert.equal(ranked[0].exchange, "NSE");
    });

    it("DB rows (instrumentId) beat Yahoo rows when NOT on Atlas", () => {
      const ranked = rankSearchResults(
        [
          eq("FOO", { instrumentId: undefined }),
          eq("FOO2", { instrumentId: "db1" }),
        ],
        "QUERY",
        false
      );
      assert.equal(ranked[0].instrumentId, "db1");
    });

    it("on Atlas, the DB-vs-Yahoo tiebreak is skipped → alphabetical name decides", () => {
      const ranked = rankSearchResults(
        [
          eq("S2", { name: "Bravo", instrumentId: "db" }),
          eq("S1", { name: "Alpha", instrumentId: undefined }),
        ],
        "QUERY",
        true
      );
      assert.equal(ranked[0].name, "Alpha");
    });

    it("final tiebreak is alphabetical by name", () => {
      const ranked = rankSearchResults(
        [eq("A", { name: "Zeta" }), eq("B", { name: "Alpha" })],
        "QUERY",
        false
      );
      assert.deepEqual(
        ranked.map((r) => r.name),
        ["Alpha", "Zeta"]
      );
    });

    it("comparator is anti-symmetric on the exact-match axis", () => {
      const a = eq("RELIANCE");
      const b = eq("TCS");
      assert.equal(
        Math.sign(compareSearchResults(a, b, "RELIANCE", false)),
        -Math.sign(compareSearchResults(b, a, "RELIANCE", false))
      );
    });

    it("does not mutate the input array", () => {
      const input = [eq("B"), eq("A"), eq("C")];
      const snapshot = input.map((r) => r.symbol);
      rankSearchResults(input, "Q", false);
      assert.deepEqual(
        input.map((r) => r.symbol),
        snapshot
      );
    });

    it("empty list ranks to empty", () => {
      assert.deepEqual(rankSearchResults([], "Q", false), []);
    });

    // ── MONEY-1205: Atlas relevance is the tiebreak on the Atlas path ──

    it("on Atlas, a higher score wins the tie — NOT the alphabet", () => {
      // The real prod case with the local indices removed: SBIETFQLTY is
      // Atlas's #1 at 30.7 but ranked 15th of 16 because every criterion tied
      // and `localeCompare` put ADITYA BIRLA / DSP / HDFC / ICICI first.
      const ranked = rankSearchResults(
        [
          eq("SETFNIF50", { name: "SBI NIFTY 50 ETF", score: 23.4 }),
          eq("ABSLNN50ET", { name: "ADITYA BIRLA NIFTY 50 ETF", score: 21.0 }),
          eq("SBIETFQLTY", {
            name: "SBI NIFTY 200 QUALITY 30 ETF",
            score: 30.7,
          }),
        ],
        "SBI NIFTY 200 QUALITY 30 ETF",
        true
      );
      assert.deepEqual(
        ranked.map((r) => r.symbol),
        ["SBIETFQLTY", "SETFNIF50", "ABSLNN50ET"]
      );
    });

    it("the score tiebreak is OFF when useAtlas is false (QA's regex path)", () => {
      // QA runs the Prisma `contains` path, where no row carries a score and
      // the previous ordering must be preserved exactly.
      const rows = [
        eq("B", { name: "Zeta", score: 99 }),
        eq("A", { name: "Alpha", score: 1 }),
      ];
      assert.deepEqual(
        rankSearchResults(rows, "QUERY", false).map((r) => r.name),
        ["Alpha", "Zeta"]
      );
      assert.deepEqual(
        rankSearchResults(rows, "QUERY", true).map((r) => r.name),
        ["Zeta", "Alpha"]
      );
    });

    it("equal / absent scores fall through to alphabetical, unchanged", () => {
      assert.deepEqual(
        rankSearchResults(
          [eq("A", { name: "Zeta" }), eq("B", { name: "Alpha" })],
          "QUERY",
          true
        ).map((r) => r.name),
        ["Alpha", "Zeta"]
      );
      assert.deepEqual(
        rankSearchResults(
          [
            eq("A", { name: "Zeta", score: 5 }),
            eq("B", { name: "Alpha", score: 5 }),
          ],
          "QUERY",
          true
        ).map((r) => r.name),
        ["Alpha", "Zeta"]
      );
    });

    it("an unscored row loses to a scored one instead of poisoning the sort", () => {
      // `undefined > n` and `undefined < n` are BOTH false, so a raw
      // comparison would be non-transitive and the output engine-dependent.
      const ranked = rankSearchResults(
        [
          eq("NOSCORE", { name: "Aaa" }),
          eq("SCORED", { name: "Zzz", score: 0.1 }),
        ],
        "QUERY",
        true
      );
      assert.deepEqual(
        ranked.map((r) => r.symbol),
        ["SCORED", "NOSCORE"]
      );
    });

    it("a NaN score is treated as 0, never propagated", () => {
      const ranked = rankSearchResults(
        [
          eq("NAN", { name: "Aaa", score: Number.NaN }),
          eq("REAL", { name: "Zzz", score: 2 }),
        ],
        "QUERY",
        true
      );
      assert.deepEqual(
        ranked.map((r) => r.symbol),
        ["REAL", "NAN"]
      );
    });

    it("score never outranks an exact symbol match", () => {
      const ranked = rankSearchResults(
        [
          eq("OTHER", { name: "Aaa", score: 999 }),
          eq("RELIANCE", { name: "Zzz", score: 0.1 }),
        ],
        "RELIANCE",
        true
      );
      assert.equal(ranked[0].symbol, "RELIANCE");
    });

    it("the name-prefix criterion sees through a leading CSV quote", () => {
      // 13,287 prod names begin with a literal `"`, so
      // `name.toUpperCase().startsWith(query)` could never be true for any of
      // them — criterion 5 was dead for half the collection.
      //
      // The competing row is stacked to WIN every later criterion — it holds an
      // instrumentId, so criterion 6 (DB before Yahoo) hands it the lead — and
      // the quoted row has none. Criterion 5 is then the only thing that can
      // put the quoted row on top.
      //
      // (An earlier version of this test opposed it with the ALPHABETICAL
      // tiebreak and passed with the fix reverted: `localeCompare` weights a
      // leading `"` ahead of every letter, so the quoted name won criterion 8
      // regardless and the assertion proved nothing. Mutation-testing caught
      // it; the name of the bug in the comment did not.)
      const rows = [
        eq("DBROW", { name: "AAA CORP", instrumentId: "db1" }),
        eq("QUOTED", { name: '"SBI NIFTY 200 QUALITY 30 ETF"' }),
      ];
      assert.equal(
        rankSearchResults(rows, "SBI NIFTY 200 QUALITY 30 ETF", false)[0]
          .symbol,
        "QUOTED"
      );
      // Control: with a query that prefixes NEITHER name, criterion 5 is silent
      // and the DB row must win on criterion 6 — i.e. the strip did not leak
      // into any other criterion.
      assert.equal(
        rankSearchResults(rows, "NOTHINGMATCHES", false)[0].symbol,
        "DBROW"
      );
    });
  });

  // ───────────────────────── SOURCE LABEL ──────────────────────────
  describe("resolveSearchSource", () => {
    it("atlas wins whenever useAtlas is true (regardless of db count)", () => {
      assert.equal(resolveSearchSource(true, 0), "atlas");
      assert.equal(resolveSearchSource(true, 9), "atlas");
    });
    it("db+yahoo when not atlas and db returned instruments", () => {
      assert.equal(resolveSearchSource(false, 3), "db+yahoo");
    });
    it("yahoo when not atlas and db empty", () => {
      assert.equal(resolveSearchSource(false, 0), "yahoo");
    });
  });

  // ─────────────── REAL symbol-mapper helpers (shadow re-pointed) ───────────────
  describe("toYahooSymbol (real symbol-mapper)", () => {
    it(".NS for NSE, .BO for BSE, default NSE", () => {
      assert.equal(toYahooSymbol("RELIANCE", "NSE"), "RELIANCE.NS");
      assert.equal(toYahooSymbol("RELIANCE", "BSE"), "RELIANCE.BO");
      assert.equal(toYahooSymbol("TCS"), "TCS.NS");
    });
    it("known indices map to caret symbols", () => {
      assert.equal(toYahooSymbol("NIFTY 50"), "^NSEI");
      assert.equal(toYahooSymbol("SENSEX"), "^BSESN");
      assert.equal(toYahooSymbol("BANKNIFTY"), "^NSEBANK");
    });
    it("already-Yahoo symbols pass through; uppercases + trims", () => {
      assert.equal(toYahooSymbol("RELIANCE.NS"), "RELIANCE.NS");
      assert.equal(toYahooSymbol("^NSEI"), "^NSEI");
      assert.equal(toYahooSymbol("reliance", "NSE"), "RELIANCE.NS");
      assert.equal(toYahooSymbol("  TCS  ", "NSE"), "TCS.NS");
    });
  });

  describe("getAvailableIndices (real symbol-mapper)", () => {
    it("returns {name, yahooSymbol} entries including NIFTY 50 + SENSEX", () => {
      const idx = getAvailableIndices();
      assert.ok(
        idx.some((i) => i.name === "NIFTY 50" && i.yahooSymbol === "^NSEI")
      );
      assert.ok(idx.some((i) => i.name === "SENSEX"));
      for (const i of idx) {
        assert.equal(typeof i.name, "string");
        assert.ok(i.yahooSymbol.startsWith("^"));
      }
    });
  });

  // ──────────────────── END-TO-END TRANSFORM PIPE ──────────────────
  describe("integration: combine → presort → dedupe → rank", () => {
    it("dual-listed equity collapses to NSE and exact match leads", () => {
      const combined: SearchResultItem[] = [
        ...matchLocalIndices("RELIANCE"), // none
        mapAtlasInstrument({
          _id: { $oid: "1" },
          symbol: "RELIANCE",
          name: "Reliance Industries",
          exchange: "BSE",
          yahooSymbol: "RELIANCE.BO",
          instrumentType: "EQUITY",
          sector: "Energy",
        }),
        mapAtlasInstrument({
          _id: { $oid: "2" },
          symbol: "RELIANCE",
          name: "Reliance Industries",
          exchange: "NSE",
          yahooSymbol: "RELIANCE.NS",
          instrumentType: "EQUITY",
          sector: "Energy",
        }),
        mapAtlasInstrument({
          _id: { $oid: "3" },
          symbol: "RELIANCEPP",
          name: "Reliance Partly Paid",
          exchange: "NSE",
          yahooSymbol: "RELIANCEPP.NS",
          instrumentType: "EQUITY",
        }),
      ];
      const gated = filterUsResults(combined, false);
      const ranked = rankSearchResults(
        dedupeResults(presortNseFirst(gated), []),
        "RELIANCE",
        true
      );
      assert.equal(ranked.length, 2); // RELIANCE (deduped) + RELIANCEPP
      assert.equal(ranked[0].symbol, "RELIANCE");
      assert.equal(ranked[0].exchange, "NSE"); // NSE listing won the dedup
    });

    // MONEY-1205 — the whole defect, end to end through the REAL route order:
    // combine → filterUsResults → presortNseFirst → dedupeResults →
    // rankSearchResults → capIndexRows → slice(0, limit).
    it("an exact-name ETF is not buried by index injection at limit=12", () => {
      const query = "SBI NIFTY 200 QUALITY 30 ETF";
      const upperQuery = query.toUpperCase();

      // The 24 instruments Atlas actually returns for this query, abridged to
      // the shape that matters: one exact hit at 30.7 and a field of SBI ETFs
      // at ~23.4 whose names all sort BEFORE it alphabetically.
      const atlasRows: AtlasInstrumentRow[] = [
        {
          _id: { $oid: "1" },
          symbol: "SBIETFQLTY",
          name: '"SBI NIFTY 200 QUALITY 30 ETF"',
          exchange: "NSE",
          yahooSymbol: "SBIETFQLTY.NS",
          instrumentType: "ETF",
          score: 30.7,
        },
        ...["ABSLNN50ET", "DSPNEWETF", "HDFCNIFTY", "ICICINIFTY"].map(
          (symbol, i): AtlasInstrumentRow => ({
            _id: { $oid: `x${i}` },
            symbol,
            name: `"${["ADITYA BIRLA", "DSP", "HDFC", "ICICI"][i]} NIFTY ETF"`,
            exchange: "NSE",
            yahooSymbol: `${symbol}.NS`,
            instrumentType: "ETF",
            score: 23.4,
          })
        ),
      ];

      const combined: SearchResultItem[] = [
        ...matchLocalIndices(upperQuery), // 17 rows before the fix, 0 after
        ...atlasRows.map(mapAtlasInstrument),
      ];
      const page = capIndexRows(
        rankSearchResults(
          dedupeResults(presortNseFirst(filterUsResults(combined, false)), []),
          upperQuery,
          true
        )
      ).slice(0, 12);

      assert.equal(
        page[0].symbol,
        "SBIETFQLTY",
        "the fund the user typed the exact name of must lead"
      );
      assert.equal(
        page.filter((r) => r.type === "INDEX").length,
        0,
        "no index should have matched this query at all"
      );
    });

    it("even a CORRECT index match leaves room for stocks at limit=12", () => {
      // "nifty" legitimately matches 20 indices — and returned 20 index rows
      // and ZERO stocks, so NIFTYBEES and every NIFTY ETF were invisible.
      const combined: SearchResultItem[] = [
        ...matchLocalIndices("NIFTY"),
        ...["NIFTYBEES", "SETFNIF50", "HDFCNIFTY"].map((symbol, i) =>
          mapAtlasInstrument({
            _id: { $oid: `s${i}` },
            symbol,
            name: `${symbol} ETF`,
            exchange: "NSE",
            yahooSymbol: `${symbol}.NS`,
            instrumentType: "ETF",
            score: 10 - i,
          })
        ),
      ];
      const page = capIndexRows(
        rankSearchResults(
          dedupeResults(presortNseFirst(combined), []),
          "NIFTY",
          true
        )
      ).slice(0, 12);

      // At most 3 indices may sit AHEAD of the first stock — that is the cap.
      assert.equal(
        page.findIndex((r) => r.type !== "INDEX"),
        3,
        "no more than 3 index rows before the first stock"
      );
      assert.deepEqual(
        page.filter((r) => r.type !== "INDEX").map((r) => r.symbol),
        ["NIFTYBEES", "SETFNIF50", "HDFCNIFTY"],
        "all three ETFs make the page, in Atlas score order"
      );
      // The demoted indices still fill the leftover budget — a query that
      // really is about indices is not answered with three rows.
      assert.equal(page.length, 12);
    });

    it("US rows are dropped before ranking when the flag is off", () => {
      const combined: SearchResultItem[] = [
        eq("INFY", { yahooSymbol: "INFY.NS" }),
        us("AAPL", { name: "Apple Inc" }),
      ];
      const ranked = rankSearchResults(
        dedupeResults(presortNseFirst(filterUsResults(combined, false)), []),
        "INFY",
        false
      );
      assert.deepEqual(
        ranked.map((r) => r.symbol),
        ["INFY"]
      );
    });
  });
});

/**
 * MONEY-980 — US securities are reachable from search, delisted ones included.
 *
 * Every assertion drives the REAL exported transforms through the REAL route
 * order: combine → filterUsResults → presortNseFirst → dedupeResults →
 * rankSearchResults → capIndexRows → slice.
 *
 * These are the four things that would each have made the feature look shipped
 * while returning nothing:
 *   1. the market band (US below India, delisted below active),
 *   2. the dedup key (symbol-keying deletes the recycled-ticker tail — which
 *      is the entire reason `us_instruments` is its own collection),
 *   3. the nullable name (rank last, never drop, never show the ticker twice),
 *   4. the flag gate (positive `market`, not a hand-typed venue deny-list).
 */
describe("MONEY-980 — US results merge, rank and dedupe", () => {
  // ───────────────────────────── MARKET BAND ─────────────────────────────
  describe("marketRank", () => {
    it("India 0, US active 1, US delisted 2", () => {
      assert.equal(marketRank(eq("RELIANCE")), 0);
      assert.equal(marketRank(us("AAPL")), 1);
      assert.equal(marketRank(us("LEH", { listingStatus: "DELISTED" })), 2);
    });

    it("a US row with an UNKNOWN status ranks with the delisted, not ahead", () => {
      // Unreachable today (the column is required) — pinned because the wrong
      // default would promote an unclassifiable row above every live listing.
      assert.equal(marketRank(us("X", { listingStatus: "" })), 2);
      assert.equal(marketRank(us("X", { listingStatus: "SUSPENDED" })), 2);
    });
  });

  it("US rows rank BELOW every India match", () => {
    const ranked = rankSearchResults(
      [us("AAPL", { name: "Apple Inc", score: 99 }), eq("ZZZZ")],
      "AAPL",
      true
    );
    assert.deepEqual(
      ranked.map((r) => r.symbol),
      ["ZZZZ", "AAPL"],
      "an India row with NO score and a worse name outranks an exact US hit"
    );
  });

  it("an ADR does not displace its Indian listing: INFY stays first", () => {
    // `INFY` is an NSE symbol AND a NYSE ADR ticker, both exact matches for
    // the query. The band is what decides.
    //
    // The Indian row is deliberately the BSE listing. With NSE, criterion 4
    // (NSE-before-BSE) produces ["NSE","NYSE"] on its own and the test passes
    // with the market band DELETED — it proves nothing. On BSE neither row is
    // NSE, so criteria 1-5 tie (both exact symbol hits, neither name starts
    // with "INFY"), criterion 6 ties (both named), criterion 7 is skipped on
    // Atlas, and criterion 8 FAVOURS the ADR — it is the only scored row.
    // Every remaining criterion points the wrong way, so only criterion 0 can
    // produce this order.
    const ranked = rankSearchResults(
      [
        us("INFY", { exchange: "NYSE", name: "Infosys Ltd ADR", score: 40 }),
        eq("INFY", { exchange: "BSE", name: "Infosys Ltd" }),
      ],
      "INFY",
      true
    );
    assert.deepEqual(
      ranked.map((r) => r.exchange),
      ["BSE", "NYSE"]
    );
  });

  it("delisted US rows rank below active US ones", () => {
    const ranked = rankSearchResults(
      [
        us("LEH", {
          name: "Lehman Brothers",
          listingStatus: "DELISTED",
          listingEndDate: "2017-01-13T00:00:00.000Z",
          score: 90,
        }),
        us("LEHX", { name: "Lehman Tracker ETF", assetType: "ETF", score: 1 }),
      ],
      "LEH",
      true
    );
    assert.deepEqual(
      ranked.map((r) => r.symbol),
      ["LEHX", "LEH"],
      "active first even though the delisted row is the exact hit at 90x score"
    );
  });

  // ───────────────────────── NULLABLE NAME ─────────────────────────
  it("a nameless US row ranks LAST among its peers — but is never dropped", () => {
    // The names deliberately do NOT begin with the query. A fixture whose
    // names DO ("Lehman …" for "LEH") is decided by the name-prefix criterion
    // above and proves nothing about this one — the first version of this test
    // passed with the has-name criterion deleted.
    //
    // Every symbol prefixes "LEH", so criteria 1-5 tie and this criterion is
    // the only thing separating them. Without it the fall-through is
    // alphabetical, where the empty name sorts FIRST — i.e. exactly backwards.
    const ranked = rankSearchResults(
      [
        us("LEHQ", { name: null }),
        us("LEHB", { name: "Zeta Holdings Inc" }),
        us("LEHC", { name: "Yankee Holdings Inc" }),
      ],
      "LEH",
      true
    );
    assert.deepEqual(
      ranked.map((r) => r.symbol),
      ["LEHC", "LEHB", "LEHQ"],
      "named rows first (alphabetically between themselves), nameless last"
    );
    assert.equal(ranked.length, 3, "demoted, not dropped");
  });

  it("...but an EXACT ticker hit still wins even with no name", () => {
    // The founder case: someone types `LEH` while the paced name leg (~9
    // nights for 74k rows) has not reached it. Ranking "named first" ABOVE the
    // symbol criteria would bury the one row they asked for.
    const ranked = rankSearchResults(
      [us("LEHMANX", { name: "Lehman Index Fund" }), us("LEH", { name: null })],
      "LEH",
      true
    );
    assert.equal(ranked[0].symbol, "LEH");
  });

  it("hasDisplayName is inert for India rows (they always have names)", () => {
    assert.equal(hasDisplayName(eq("TCS")), true);
    assert.equal(hasDisplayName(us("X", { name: null })), false);
  });

  // ───────────────────────────── DEDUP ─────────────────────────────
  it("a RECYCLED ticker survives dedup as two rows", () => {
    // Tiingo's master holds two `DOW` rows on NYSE: Dow Chemical 1972-2017 and
    // Dow Inc. 2019-. Identical symbol, identical exchange, identical
    // assetType. Keyed by symbol they collapse to one and the delisted company
    // — the reason this collection exists — disappears.
    const rows = [
      us("DOW", {
        listingId: "DOW:NYSE:1972-06-01",
        exchange: "NYSE",
        name: "Dow Chemical Co",
        listingStatus: "DELISTED",
        listingEndDate: "2017-08-31T00:00:00.000Z",
      }),
      us("DOW", {
        listingId: "DOW:NYSE:2019-03-20",
        exchange: "NYSE",
        name: "Dow Inc",
      }),
    ];
    const out = dedupeResults(presortNseFirst(rows), []);
    assert.equal(out.length, 2, "both occupants of the ticker survive");
    assert.deepEqual(out.map((r) => r.listingStatus).sort(), [
      "ACTIVE",
      "DELISTED",
    ]);
  });

  it("a US ADR does not collapse into its Indian namesake", () => {
    const out = dedupeResults(
      presortNseFirst([
        eq("INFY", { name: "Infosys Ltd" }),
        us("INFY", { exchange: "NYSE", name: "Infosys Ltd ADR" }),
      ]),
      []
    );
    assert.equal(out.length, 2);
  });

  it("the SAME US listing twice still collapses to one", () => {
    // The dedup must still dedup — a key that never collides is not a key.
    const row = us("AAPL", { listingId: "AAPL:NASDAQ:1980-12-12" });
    assert.equal(dedupeResults([row, { ...row }], []).length, 1);
  });

  it("two US rows missing listingId fall back to symbol+exchange, not to one key", () => {
    const a: SearchResultItem = { ...us("DOW"), listingId: undefined };
    const b: SearchResultItem = {
      ...us("DOW", { exchange: "NYSE" }),
      listingId: undefined,
    };
    assert.equal(dedupeResults([a, b], []).length, 2);
  });

  it("the type filter still applies to US rows", () => {
    const rows = [
      us("AAPL", { assetType: "Stock" }),
      us("SPY", { assetType: "ETF" }),
      us("VFIAX", { assetType: "Mutual Fund" }),
    ];
    assert.deepEqual(
      dedupeResults(rows, ["ETF"]).map((r) => r.symbol),
      ["SPY"]
    );
    assert.deepEqual(
      dedupeResults(rows, ["MF"]).map((r) => r.symbol),
      ["VFIAX"]
    );
  });

  // ───────────────────────── SCORE TIEBREAK ─────────────────────────
  it("US Atlas relevance still decides when INDIA fell back to regex", () => {
    // The gate latches PER INDEX, so `instrument_search` can be down while
    // `us_instrument_search` is healthy — `useAtlas` (which describes the
    // India legs) is false, and without the US clause the US rows would sort
    // alphabetically and throw away their scores.
    //
    // The high-scoring row is deliberately the alphabetically LAST one: with
    // scores of 50 vs 3 on names "Aaa"/"Zeta" the ordering is the same either
    // way, so such a fixture passes with the score clause deleted.
    const ranked = rankSearchResults(
      [
        us("AAA", { name: "Aaa Corp", score: 3 }),
        us("ZZZ", { name: "Zeta Corp", score: 50 }),
      ],
      "QUERY",
      false
    );
    assert.deepEqual(
      ranked.map((r) => r.symbol),
      ["ZZZ", "AAA"],
      "score beats alphabetical, even though India fell back to regex"
    );
  });

  it("the India-only regex path is UNCHANGED by that clause", () => {
    // The MONEY-1205 invariant: on QA's regex path no India row's score counts.
    const ranked = rankSearchResults(
      [
        eq("B", { name: "Zeta", score: 99 }),
        eq("A", { name: "Alpha", score: 1 }),
      ],
      "QUERY",
      false
    );
    assert.deepEqual(
      ranked.map((r) => r.name),
      ["Alpha", "Zeta"]
    );
  });

  // ───────────────────── END-TO-END, THE ROUTE'S ORDER ─────────────────────
  it("flag ON: India first, then active US, then delisted US", () => {
    const combined: SearchResultItem[] = [
      us("LEH", {
        name: "Lehman Brothers Holdings",
        listingStatus: "DELISTED",
        listingEndDate: "2017-01-13T00:00:00.000Z",
        score: 30,
      }),
      us("LEHN", { name: "Lehman Nutrition Corp", score: 20 }),
      eq("LEHAR", { name: "Lehar Footwears Ltd" }),
    ];
    const page = capIndexRows(
      rankSearchResults(
        dedupeResults(presortNseFirst(filterUsResults(combined, true)), []),
        "LEH",
        true
      )
    ).slice(0, 12);

    assert.deepEqual(
      page.map((r) => r.symbol),
      ["LEHAR", "LEHN", "LEH"]
    );
    assert.equal(page[2].listingStatus, "DELISTED");
    assert.equal(
      new Date(page[2].listingEndDate!).getUTCFullYear(),
      2017,
      "a UI can render `DELISTED · 2017` from the payload"
    );
  });

  it("flag OFF: the SAME input returns exactly the India rows", () => {
    const combined: SearchResultItem[] = [
      us("LEH", { name: "Lehman Brothers", listingStatus: "DELISTED" }),
      us("LEHN", { name: "Lehman Nutrition" }),
      eq("LEHAR", { name: "Lehar Footwears Ltd" }),
    ];
    const page = capIndexRows(
      rankSearchResults(
        dedupeResults(presortNseFirst(filterUsResults(combined, false)), []),
        "LEH",
        true
      )
    );
    assert.deepEqual(
      page.map((r) => r.symbol),
      ["LEHAR"]
    );
  });

  // ─────────────── EMPTY vs NON-EMPTY us_instruments ───────────────
  //
  // One India fixture, run through the whole route pipeline. It is built so its
  // ranked order is NOT its alphabetical order: the query "ZEB" is an exact
  // match for NEITHER row, so criteria 1-3 tie and criterion 4 (NSE-before-BSE)
  // decides — the exact REVERSE of `localeCompare` on "Aaa Ltd" / "Zzz Ltd".
  //
  // The previous version of the first test `.sort()`ed its output, destroying
  // every ordering signal it was meant to check, and merged `[...india, ...[]]`
  // — literally `india` — so no US code path was reachable from it at all.
  const indiaPair = (): SearchResultItem[] => [
    eq("ZEBRA", { exchange: "BSE", name: "Aaa Ltd" }),
    eq("ZEBRAX", { exchange: "NSE", name: "Zzz Ltd" }),
  ];
  /**
   * The US row is built to win every criterion the market band does not
   * outrank: the top Atlas score in the set (criterion 8) and a name that beats
   * "Zzz Ltd" alphabetically (criterion 9). Delete `marketRank` and it moves
   * from LAST to SECOND.
   */
  const usRival = (): SearchResultItem =>
    us("ZEBRA", {
      exchange: "NASDAQ",
      name: "Zebra Technologies",
      score: 99,
    });
  /** Exactly what `handleSearch` does after the fetch fan-out. */
  const routePipeline = (rows: SearchResultItem[], allowUs: boolean) =>
    capIndexRows(
      rankSearchResults(
        dedupeResults(presortNseFirst(filterUsResults(rows, allowUs)), []),
        "ZEB",
        true
      )
      // Symbol ALONE cannot express this ordering — the Indian and US rows
      // share the ticker `ZEBRA`, which is the whole point of the fixture.
    ).map((r) => `${r.symbol}:${r.exchange}`);

  it("an EMPTY us_instruments is a no-op, not an error", () => {
    // Every environment today: the backfill has not run. Merging zero US rows
    // must produce exactly the India answer — same rows, same ORDER.
    assert.deepEqual(routePipeline(indiaPair(), true), [
      "ZEBRAX:NSE",
      "ZEBRA:BSE",
    ]);
  });

  it("...and a NON-empty one appends BELOW India, never into it", () => {
    const withUs = [...indiaPair(), usRival()];
    assert.deepEqual(routePipeline(withUs, true), [
      "ZEBRAX:NSE",
      "ZEBRA:BSE",
      "ZEBRA:NASDAQ",
    ]);
    // Three rows, not two: the US `ZEBRA` shares its ticker with the Indian
    // one, so it survives dedup only because US rows key on `listingId`.
    assert.equal(
      dedupeResults(presortNseFirst(filterUsResults(withUs, true)), []).length,
      3
    );
  });

  it("...and the flag/opt-in gate removes the US row without reordering India", () => {
    assert.deepEqual(routePipeline([...indiaPair(), usRival()], false), [
      "ZEBRAX:NSE",
      "ZEBRA:BSE",
    ]);
  });

  it("US_RESULT_LIMIT is the fixed budget the route actually passes", () => {
    // The old assertion was `Number.isInteger(x) && x > 0`, which every value
    // this constant could plausibly hold satisfies. Two things are worth
    // pinning: the decided number, and that it is a FIXED budget rather than
    // India's `limit * 2` — the two populations are not comparable (49,414 of
    // 72,685 US listings are mutual funds), and US rows rank below every India
    // match anyway, so a wider fetch only lengthens the tail that gets sliced.
    assert.equal(US_RESULT_LIMIT, 12);
    const src = readFileSync(
      join(__dirname, "..", "..", "app/api/market/search/route.ts"),
      "utf8"
    );
    assert.match(src, /limit:\s*US_RESULT_LIMIT/);
    assert.doesNotMatch(
      src,
      /searchUsInstruments\([\s\S]{0,400}?limit:\s*limit\s*\*/,
      "the US leg must not inherit India's limit * 2"
    );
  });
});

/**
 * MONEY-980 — the search route's US wiring, asserted against the route SOURCE.
 *
 * Same idiom as the MONEY-1205 block below and as
 * `packages/core/__tests__/market-data/no-feed-fetch-bypass.test.ts`: there is
 * no pure seam for "which legs the handler fans out to" — the route is behind
 * Clerk, Prisma, Atlas and PostHog — and every one of these is a wiring fact
 * whose failure is silent. `us_instruments` is empty in every environment, so
 * a broken wire returns the same empty list a working one does.
 */
describe("MONEY-980 — the route actually reaches us_instruments", () => {
  const ROOT = join(__dirname, "..", "..");
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
  const searchRoute = () => read("app/api/market/search/route.ts");

  it("fans out to searchUsInstruments with the UPPER-cased query", () => {
    // `us_instrument_search` maps `symbol` with `lucene.keyword` — one
    // unmodified token — and Tiingo tickers are stored upper-case, so a
    // lower-cased query reaches a US security only through its (nullable) name.
    const src = searchRoute();
    assert.match(src, /searchUsInstruments\(\s*upperQuery/);
    assert.doesNotMatch(src, /searchUsInstruments\(\s*query\b/);
  });

  /**
   * The object literal a `const <name> = { … }` declares, and nothing else.
   *
   * Scoping matters here and it was learned the hard way: the first version of
   * these two assertions read the WHOLE route source, so deleting `indices`
   * from the SEARCH key still matched the identical line in the POPULAR key and
   * the test stayed green through the mutation it existed to catch.
   */
  const objectLiteral = (src: string, name: string): string => {
    const at = src.indexOf(`const ${name} = {`);
    assert.ok(at >= 0, `${name} must be an object literal`);
    return src.slice(at, src.indexOf("};", at) + 2);
  };

  it("the SEARCH cache key carries every input that changes the body", () => {
    // `_global` scope: ONE entry serves every user for 300s, so anything that
    // changes the body has to be in the key. `generateVersionHash` sorts the
    // object's keys and hands them to `JSON.stringify` as the allow-list, so an
    // omission is silent — the two responses simply share an entry.
    //
    //   us       `us-stocks-search` is per-USER (PostHog) and `includeUs` is
    //            per-CALLER, so `usAllowed` differs between two simultaneous
    //            requests for the same query.
    //   indices  `includeIndices` decides whether `matchLocalIndices` runs, and
    //            the callers disagree: `useStockSearch` false,
    //            `InstrumentAutocomplete` "false", `InstrumentSearch` true,
    //            `CommandPalette` unset (→ true).
    const key = objectLiteral(searchRoute(), "searchFilters");
    assert.match(key, /query:\s*upperQuery/);
    assert.match(key, /limit,/);
    assert.match(key, /types:\s*types\.join/);
    assert.match(key, /us:\s*usAllowed\s*\?\s*"1"\s*:\s*"0"/);
    assert.match(key, /indices:\s*includeIndices\s*\?\s*"1"\s*:\s*"0"/);
  });

  it("the POPULAR cache key carries includeIndices too", () => {
    // Same `_global` scope, same hazard: `includeIndices` decides the
    // `unshift` of index rows on the no-query path. No `us` here — that path
    // has no US leg at all.
    const key = objectLiteral(searchRoute(), "popularFilters");
    assert.match(key, /indices:\s*includeIndices\s*\?\s*"1"\s*:\s*"0"/);
  });

  it("US rows are OPT-IN: the flag alone cannot turn them on", () => {
    // MONEY-980 review. `InstrumentSearch` (AddTradeDialog /
    // AddMutualFundDialog / watchlist) and `CommandPalette` both call THIS
    // route and both persist or resolve the pick through India-only machinery,
    // so the flag cannot be the only gate. `includeUs` defaults OFF and the
    // route must combine the two into one value.
    const src = searchRoute();
    assert.match(
      src,
      /parseIncludeUs\(\s*searchParams\.get\("includeUs"\)\s*\)/
    );
    assert.match(src, /const usAllowed\s*=\s*includeUs\s*\n?\s*\?/);
    // …and the resolved value — never the raw flag — is what gates the fetch
    // and the result filter.
    assert.match(src, /usWanted\s*=\s*\n?\s*usAllowed &&/);
    assert.match(src, /filterUsResults\([\s\S]{0,200}?usAllowed\s*\n?\s*\)/);
    assert.doesNotMatch(
      src,
      /showUsStocks/,
      "the flag must not survive as a second, drifting name for the decision"
    );
  });

  it("neither picker opts in — asserted against CODE, not comments", () => {
    // The enforcement for the write-side leak is an ABSENCE, so it is asserted
    // as one. Comments are stripped first: both files DISCUSS `includeUs` at
    // length (that is the point), and a guard that cannot tell code from an
    // explanation of code would force people to stop explaining.
    // LINE comments FIRST, then BLOCK — never the reverse (MONEY-1143, pinned
    // repo-wide by `__tests__/meta/comment-strip-ordering.test.ts`, which
    // failed on this exact line). A `//` comment containing `/*` opens a
    // phantom block that runs to the next `*` + `/` hundreds of lines away, and
    // an ABSENCE assertion over the wreckage passes because the code is gone
    // rather than because the leak is.
    const stripComments = (src: string) =>
      src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rel of [
      "components/InstrumentSearch.tsx",
      "components/CommandPalette.tsx",
    ]) {
      const src = read(rel);
      assert.doesNotMatch(
        stripComments(src),
        /includeUs/,
        `${rel} must not opt into US rows — it persists or India-resolves the pick`
      );
      assert.match(
        src,
        /INDIA ONLY|NO `includeUs`/,
        `${rel} must say WHY it does not opt in`
      );
    }
  });

  it("merges the US rows into the combined list", () => {
    const src = searchRoute();
    assert.match(src, /const usMapped[\s\S]{0,200}?\.map\(\s*mapUsInstrument/);
    assert.match(src, /filterUsResults\(\s*\[[^\]]*\.\.\.usMapped/);
  });

  it("does NOT narrow listingStatus — delisted rows are the point", () => {
    // The founder decision: searching `LEH` must FIND Lehman Brothers. A
    // `listingStatuses: ["ACTIVE"]` here would hide 32,754 of the 74,125
    // listings and, with them, the only route to the cold-storage load.
    assert.doesNotMatch(searchRoute(), /listingStatuses\s*:/);
  });

  it("the dead venue deny-list is gone, not merely bypassed", () => {
    // Matched as a CALL / a DECLARATION, not as a bare identifier: both files
    // still discuss the old gate in prose, and a guard that cannot tell code
    // from an explanation of code would force people to stop explaining.
    assert.doesNotMatch(searchRoute(), /filterUsExchanges\(/);
    assert.doesNotMatch(
      read("app/api/market/search/search-logic.ts"),
      /export (?:const|function) (?:US_EXCHANGES|filterUsExchanges)\b/,
      "the hand-typed Yahoo venue set is removed — it was missing 5 of the 8 " +
        "real US venues, NMFQS (49,414 listings) among them"
    );
  });

  it("autocomplete stays India-only, and says so", () => {
    // Pinned so the next person to make the two routes 'consistent' has to do
    // it deliberately: every autocomplete consumer writes the picked symbol
    // into an India-resolved record, and its 4-field payload has nowhere to
    // put `listingStatus`.
    const src = read("app/api/market/autocomplete/route.ts");
    assert.doesNotMatch(src, /us-instrument-search|searchUsInstruments/);
    assert.match(src, /INDIA ONLY/);
  });
});

/**
 * MONEY-1205 — the Atlas query MUST be upper-cased.
 *
 * This is a wiring invariant, not a transform, so it is asserted against the
 * route SOURCE (the same machine-checked-invariant idiom as
 * `packages/core/__tests__/market-data/no-feed-fetch-bypass.test.ts`). There is
 * no pure seam to assert it on: the routes are behind Clerk + Prisma + Atlas.
 *
 * Why it matters, measured against prod Atlas (limit=24, types=[EQUITY,ETF,DEBT]):
 *
 *     "tcs"  → TCS  ABSENT from 24 rows   |  "TCS"  → TCS  #1  (score  9.2)
 *     "sbin" → SBIN ABSENT from 24 rows   |  "SBIN" → SBIN #1  (score  9.2)
 *     "infy" → INFY #16 (score 2.0)       |  "INFY" → INFY #1  (score 10.2)
 *
 * `instrument_search` maps `symbol` twice — an edgeGram autocomplete field AND
 * a `string` with `lucene.keyword` (docs/setup/atlas-search-setup.md).
 * `lucene.keyword` emits the whole field as ONE unmodified token, so the leg
 * that carries the exact-symbol signal only fires on an exactly-cased symbol,
 * and symbols are stored upper-cased. RELIANCE and HDFCBANK hid this because
 * their ticker is a word of their name; TCS, INFY and SBIN have no such luck.
 *
 * Both cache keys were ALREADY built from the upper-cased query, so before this
 * the two casings shared one entry while returning different rows —
 * first-writer-wins.
 */
describe("MONEY-1205 — routes hand Atlas the upper-cased query", () => {
  const ROOT = join(__dirname, "..", "..");
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

  it("the search route calls both Atlas searches with upperQuery", () => {
    const src = read("app/api/market/search/route.ts");
    assert.match(src, /searchInstrumentsAtlas\(\s*upperQuery/);
    assert.match(src, /searchMutualFundsAtlas\(\s*upperQuery/);
    assert.doesNotMatch(src, /searchInstrumentsAtlas\(\s*query\b/);
    assert.doesNotMatch(src, /searchMutualFundsAtlas\(\s*query\b/);
  });

  it("the autocomplete route calls Atlas with upperQuery", () => {
    const src = read("app/api/market/autocomplete/route.ts");
    assert.match(src, /autocompleteInstruments\(\s*upperQuery/);
    assert.doesNotMatch(src, /autocompleteInstruments\(\s*query\b/);
  });

  it("the cache key and the Atlas query use the SAME normalisation", () => {
    // The collision this closes: a key of `upperQuery` over a query of `query`.
    for (const rel of [
      "app/api/market/search/route.ts",
      "app/api/market/autocomplete/route.ts",
    ]) {
      const src = read(rel);
      assert.match(
        src,
        /query:\s*upperQuery/,
        `${rel} must key the cache on upperQuery`
      );
    }
  });

  it("the Prisma fallback keeps the RAW query (it is case-insensitive already)", () => {
    // `searchInstruments` uppercases the symbol itself and matches the name
    // with `mode: "insensitive"`, and `withFormerlyHint` needs what the user
    // actually typed — so upper-casing there would be a behaviour change for
    // no gain.
    assert.match(
      read("app/api/market/search/route.ts"),
      /searchInstruments\(query,/
    );
    assert.match(
      read("app/api/market/autocomplete/route.ts"),
      /searchInstruments\(query,/
    );
  });
});
