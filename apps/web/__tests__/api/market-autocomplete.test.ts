/**
 * Market Autocomplete API logic tests.
 *
 * De-shadowed (MONEY-620): these tests now import and execute the REAL pure
 * helpers from `app/api/market/autocomplete/autocomplete-logic.ts` — the same
 * symbols the route handler (`route.ts`) calls — instead of re-declaring inline
 * copies. A regression in the real query-param parsing / response shaping now
 * fails this file.
 *
 * Source under test: apps/web/app/api/market/autocomplete/autocomplete-logic.ts
 * Wired into:        apps/web/app/api/market/autocomplete/route.ts
 *
 * MONEY-1205 adds `shouldFallbackToContains` and re-points `selectSource`: an
 * EMPTY Atlas hit list is a reason to ask Prisma, not an authoritative "no such
 * instrument". The old `selectSource([]) === "atlas"` case asserted the defect.
 * The pipeline half of that fix (the `text` leg that stops 4+-token queries
 * returning nothing) is asserted in `../market/atlas-search.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseQuery,
  parseLimit,
  parseTypes,
  isQueryEmpty,
  formatEmptyResponse,
  formatAtlasResponse,
  formatContainsResponse,
  formatErrorResponse,
  mapContainsResult,
  mapContainsResults,
  selectSource,
  shouldFallbackToContains,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type AutocompleteResult,
  type ContainsSearchResult,
} from "../../app/api/market/autocomplete/autocomplete-logic";

describe("Market Autocomplete API Logic (real source)", () => {
  // -- parseLimit --

  describe("parseLimit", () => {
    it("should return 8 as default when null", () => {
      assert.strictEqual(parseLimit(null), 8);
    });

    it("should return 8 as default when empty string", () => {
      assert.strictEqual(parseLimit(""), 8);
    });

    it("should parse valid number string", () => {
      assert.strictEqual(parseLimit("5"), 5);
    });

    it("should parse limit of 1", () => {
      assert.strictEqual(parseLimit("1"), 1);
    });

    it("should cap at 20 when exceeding max", () => {
      assert.strictEqual(parseLimit("50"), 20);
    });

    it("should cap at 20 for very large values", () => {
      assert.strictEqual(parseLimit("1000"), 20);
    });

    it("should return exactly 20 for '20'", () => {
      assert.strictEqual(parseLimit("20"), 20);
    });

    it("should return 8 for NaN input like 'abc'", () => {
      assert.strictEqual(parseLimit("abc"), 8);
    });

    it("should handle '0' as 0", () => {
      assert.strictEqual(parseLimit("0"), 0);
    });

    it("should handle negative values (passthrough, not clamped to 0)", () => {
      // parseInt("-5") = -5, Math.min(-5, 20) = -5
      assert.strictEqual(parseLimit("-5"), -5);
    });

    it("should handle decimal strings (parseInt truncates)", () => {
      assert.strictEqual(parseLimit("8.9"), 8);
    });

    it("should handle leading whitespace", () => {
      assert.strictEqual(parseLimit(" 10"), 10);
    });

    // -- edge cases (new) --

    it("should fall back to default for a bare '-' (NaN)", () => {
      assert.strictEqual(parseLimit("-"), DEFAULT_LIMIT);
    });

    it("should fall back to default for whitespace-only", () => {
      assert.strictEqual(parseLimit("   "), DEFAULT_LIMIT);
    });

    it("should fall back to default for '+' sign only (NaN)", () => {
      assert.strictEqual(parseLimit("+"), DEFAULT_LIMIT);
    });

    it("should parse a leading-numeric mixed string (parseInt prefix)", () => {
      assert.strictEqual(parseLimit("12abc"), 12);
    });

    it("should cap a mixed string whose numeric prefix exceeds the max", () => {
      assert.strictEqual(parseLimit("99xyz"), MAX_LIMIT);
    });

    it("should fall back to default for a non-numeric-leading mixed string", () => {
      assert.strictEqual(parseLimit("x12"), DEFAULT_LIMIT);
    });

    it("should never return a value above MAX_LIMIT for any positive integer", () => {
      for (const n of [21, 100, 1_000_000, Number.MAX_SAFE_INTEGER]) {
        assert.ok(
          parseLimit(String(n)) <= MAX_LIMIT,
          `parseLimit(${n}) must be <= ${MAX_LIMIT}`
        );
      }
    });

    it("should not leak NaN for any of the malformed inputs", () => {
      for (const bad of ["", "abc", "  ", "-", "+", "NaN", "null", "x9"]) {
        assert.ok(
          !Number.isNaN(parseLimit(bad)),
          `parseLimit(${JSON.stringify(bad)}) must not be NaN`
        );
      }
    });
  });

  // -- parseTypes --

  describe("parseTypes", () => {
    it("should return undefined for null", () => {
      assert.strictEqual(parseTypes(null), undefined);
    });

    it("should return undefined for empty string", () => {
      assert.strictEqual(parseTypes(""), undefined);
    });

    it("should parse single type", () => {
      assert.deepStrictEqual(parseTypes("EQUITY"), ["EQUITY"]);
    });

    it("should parse multiple comma-separated types", () => {
      assert.deepStrictEqual(parseTypes("EQUITY,INDEX"), ["EQUITY", "INDEX"]);
    });

    it("should parse three types", () => {
      assert.deepStrictEqual(parseTypes("EQUITY,INDEX,MF"), [
        "EQUITY",
        "INDEX",
        "MF",
      ]);
    });

    it("should filter out empty parts from trailing comma", () => {
      assert.deepStrictEqual(parseTypes("EQUITY,"), ["EQUITY"]);
    });

    it("should filter out empty parts from leading comma", () => {
      assert.deepStrictEqual(parseTypes(",EQUITY"), ["EQUITY"]);
    });

    it("should filter out empty parts from double comma", () => {
      assert.deepStrictEqual(parseTypes("EQUITY,,INDEX"), ["EQUITY", "INDEX"]);
    });

    it("should return undefined when all parts are empty", () => {
      assert.strictEqual(parseTypes(",,,"), undefined);
    });

    // -- edge cases (new) --

    it("should NOT trim surrounding whitespace inside a part (filter only drops empties)", () => {
      // filter(Boolean) keeps " " because a single space is truthy.
      assert.deepStrictEqual(parseTypes("EQUITY, INDEX"), ["EQUITY", " INDEX"]);
    });

    it("should preserve unicode/lowercase type tokens verbatim", () => {
      assert.deepStrictEqual(parseTypes("基金,etf"), ["基金", "etf"]);
    });

    it("should keep a single whitespace token (truthy)", () => {
      assert.deepStrictEqual(parseTypes(" "), [" "]);
    });

    it("should handle a large list without dropping non-empty parts", () => {
      const many = Array.from({ length: 500 }, (_, i) => `T${i}`);
      const result = parseTypes(many.join(","));
      assert.ok(result);
      assert.strictEqual(result!.length, 500);
      assert.strictEqual(result![499], "T499");
    });
  });

  // -- parseQuery --

  describe("parseQuery", () => {
    it("should return empty string for null", () => {
      assert.strictEqual(parseQuery(null), "");
    });

    it("should return the query string as-is", () => {
      assert.strictEqual(parseQuery("reliance"), "reliance");
    });

    it("should return empty string for empty input", () => {
      assert.strictEqual(parseQuery(""), "");
    });

    it("should preserve unicode and whitespace verbatim", () => {
      assert.strictEqual(parseQuery("  टाटा  "), "  टाटा  ");
    });
  });

  // -- isQueryEmpty --

  describe("isQueryEmpty", () => {
    it("should return true for null", () => {
      assert.strictEqual(isQueryEmpty(null), true);
    });

    it("should return true for empty string", () => {
      assert.strictEqual(isQueryEmpty(""), true);
    });

    it("should return false for single character", () => {
      assert.strictEqual(isQueryEmpty("r"), false);
    });

    it("should return false for multi-character query", () => {
      assert.strictEqual(isQueryEmpty("reliance"), false);
    });

    it("should return false for whitespace (length >= 1, not trimmed)", () => {
      assert.strictEqual(isQueryEmpty(" "), false);
    });

    it("should return false for a single unicode character", () => {
      assert.strictEqual(isQueryEmpty("क"), false);
    });
  });

  // -- formatEmptyResponse --

  describe("formatEmptyResponse", () => {
    it("should return success=true, empty results, source=empty", () => {
      const result = formatEmptyResponse();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.results.length, 0);
      assert.strictEqual(result.source, "empty");
    });

    it("should omit the count field for the empty response", () => {
      assert.strictEqual("count" in formatEmptyResponse(), false);
    });
  });

  // -- formatAtlasResponse --

  describe("formatAtlasResponse", () => {
    const items: AutocompleteResult[] = [
      {
        symbol: "RELIANCE",
        name: "Reliance Industries",
        type: "EQUITY",
        exchange: "NSE",
      },
      { symbol: "RELI", name: "Reli Capital", type: "EQUITY", exchange: "BSE" },
    ];

    it("should include source=atlas", () => {
      assert.strictEqual(formatAtlasResponse([]).source, "atlas");
    });

    it("should include correct count", () => {
      assert.strictEqual(formatAtlasResponse(items).count, 2);
    });

    it("should report count 0 for an empty Atlas hit list", () => {
      assert.strictEqual(formatAtlasResponse([]).count, 0);
    });

    it("should pass results through unchanged", () => {
      assert.strictEqual(
        formatAtlasResponse(items).results[0]!.symbol,
        "RELIANCE"
      );
    });

    it("should return success=true", () => {
      assert.strictEqual(formatAtlasResponse([]).success, true);
    });

    it("count must equal results.length for a large list", () => {
      const big: AutocompleteResult[] = Array.from(
        { length: 5000 },
        (_, i) => ({
          symbol: `S${i}`,
          name: `Name ${i}`,
          type: "EQUITY",
          exchange: i % 2 ? "BSE" : "NSE",
        })
      );
      const res = formatAtlasResponse(big);
      assert.strictEqual(res.count, res.results.length);
      assert.strictEqual(res.count, 5000);
    });
  });

  // -- formatContainsResponse --

  describe("formatContainsResponse", () => {
    it("should include source=contains", () => {
      assert.strictEqual(formatContainsResponse([]).source, "contains");
    });

    it("should include count", () => {
      const items: AutocompleteResult[] = [
        { symbol: "INFY", name: "Infosys", type: "EQUITY", exchange: "NSE" },
      ];
      assert.strictEqual(formatContainsResponse(items).count, 1);
    });

    it("should return success=true", () => {
      assert.strictEqual(formatContainsResponse([]).success, true);
    });
  });

  // -- formatErrorResponse --

  describe("formatErrorResponse", () => {
    it("should wrap message in error field", () => {
      assert.deepStrictEqual(formatErrorResponse("Failed to autocomplete"), {
        error: "Failed to autocomplete",
      });
    });

    it("should wrap the auth error message used by the route", () => {
      assert.deepStrictEqual(formatErrorResponse("Authentication required"), {
        error: "Authentication required",
      });
    });

    it("should preserve an empty message", () => {
      assert.deepStrictEqual(formatErrorResponse(""), { error: "" });
    });
  });

  // -- mapContainsResult / mapContainsResults --

  describe("mapContainsResult", () => {
    it("should map instrumentType to type", () => {
      const input: ContainsSearchResult = {
        symbol: "RELIANCE",
        name: "Reliance Industries Ltd",
        instrumentType: "EQUITY",
        exchange: "NSE",
      };
      assert.strictEqual(mapContainsResult(input).type, "EQUITY");
    });

    it("should preserve all fields", () => {
      const input: ContainsSearchResult = {
        symbol: "HDFCBANK",
        name: "HDFC Bank Limited",
        instrumentType: "EQUITY",
        exchange: "BSE",
      };
      const result = mapContainsResult(input);
      assert.strictEqual(result.symbol, "HDFCBANK");
      assert.strictEqual(result.name, "HDFC Bank Limited");
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should handle ETF type", () => {
      const input: ContainsSearchResult = {
        symbol: "NIFTYBEES",
        name: "Nippon India Nifty Bees ETF",
        instrumentType: "ETF",
        exchange: "NSE",
      };
      assert.strictEqual(mapContainsResult(input).type, "ETF");
    });

    it("should NOT carry over any extra source-only key (only the 4 fields)", () => {
      const input = {
        symbol: "SBIN",
        name: "State Bank of India",
        instrumentType: "EQUITY",
        exchange: "NSE",
        sector: "Banking", // extra field on the source row
      } as ContainsSearchResult & { sector: string };
      const result = mapContainsResult(input);
      assert.deepStrictEqual(Object.keys(result).sort(), [
        "exchange",
        "name",
        "symbol",
        "type",
      ]);
    });

    it("mapContainsResults should map an empty list to an empty list", () => {
      assert.deepStrictEqual(mapContainsResults([]), []);
    });

    it("mapContainsResults should map a large list preserving order", () => {
      const rows: ContainsSearchResult[] = Array.from(
        { length: 1000 },
        (_, i) => ({
          symbol: `SYM${i}`,
          name: `Co ${i}`,
          instrumentType: i % 2 ? "ETF" : "EQUITY",
          exchange: "NSE",
        })
      );
      const out = mapContainsResults(rows);
      assert.strictEqual(out.length, 1000);
      assert.strictEqual(out[0]!.type, "EQUITY");
      assert.strictEqual(out[1]!.type, "ETF");
      assert.strictEqual(out[999]!.symbol, "SYM999");
    });
  });

  // -- selectSource --

  describe("selectSource", () => {
    it("should return atlas when atlasResults has items", () => {
      const items: AutocompleteResult[] = [
        { symbol: "X", name: "X", type: "EQUITY", exchange: "NSE" },
      ];
      assert.strictEqual(selectSource(items), "atlas");
    });

    it("should return contains when atlasResults is null (Atlas unavailable)", () => {
      assert.strictEqual(selectSource(null), "contains");
    });

    it("should return contains when Atlas answered with NO rows", () => {
      // MONEY-1205: this asserted "atlas" — the shadow of the defect. An empty
      // Atlas hit list was reported as an authoritative Atlas answer, so the
      // route never ran the fallback and the dropdown stayed empty.
      assert.strictEqual(selectSource([]), "contains");
    });
  });

  // -- shouldFallbackToContains (MONEY-1205) --

  describe("shouldFallbackToContains", () => {
    it("falls back when Atlas is unavailable (null)", () => {
      assert.strictEqual(shouldFallbackToContains(null), true);
    });

    it("falls back when Atlas returned an EMPTY array", () => {
      // The measured production failure: `/api/market/autocomplete` returned
      // zero hits for every 4+-token query ("Tata Consultancy Services
      // Limited" → 0, "SBI NIFTY 200 QUALITY" → 0) and never consulted the
      // Prisma path, which finds those rows. `null` = Atlas unavailable,
      // `[]` = Atlas has no answer; BOTH are reasons to ask the other backend.
      assert.strictEqual(shouldFallbackToContains([]), true);
    });

    it("does NOT fall back when Atlas found something", () => {
      assert.strictEqual(
        shouldFallbackToContains([
          { symbol: "X", name: "X", type: "EQUITY", exchange: "NSE" },
        ]),
        false
      );
    });

    it("agrees with selectSource on every input", () => {
      const cases: Array<AutocompleteResult[] | null> = [
        null,
        [],
        [{ symbol: "X", name: "X", type: "EQUITY", exchange: "NSE" }],
      ];
      for (const input of cases) {
        assert.strictEqual(
          selectSource(input),
          shouldFallbackToContains(input) ? "contains" : "atlas"
        );
      }
    });
  });
});

describe("MONEY-1177 — renamed instruments explain themselves", () => {
  it("appends a (formerly X) hint when the hit came from a former ticker", () => {
    // A user who searched ZOMATO and got back "Eternal Limited" with no
    // explanation cannot tell a rename from a wrong result.
    const out = mapContainsResult(
      {
        symbol: "ETERNAL",
        name: "Eternal Limited",
        instrumentType: "EQUITY",
        exchange: "NSE",
        previousSymbols: ["ZOMATO"],
      },
      "zomato"
    );
    assert.strictEqual(out.name, "Eternal Limited (formerly ZOMATO)");
    assert.strictEqual(out.symbol, "ETERNAL");
  });

  it("leaves a normal symbol hit completely untouched", () => {
    const out = mapContainsResult(
      {
        symbol: "ETERNAL",
        name: "Eternal Limited",
        instrumentType: "EQUITY",
        exchange: "NSE",
        previousSymbols: ["ZOMATO"],
      },
      "eternal"
    );
    assert.strictEqual(out.name, "Eternal Limited");
  });

  it("is unchanged for rows with no aliases and for a missing query", () => {
    // Callers that predate MONEY-1177 pass no query; the hint must be opt-in,
    // never a behaviour change for them.
    const row = {
      symbol: "TCS",
      name: "Tata Consultancy",
      instrumentType: "EQUITY",
      exchange: "NSE",
    };
    assert.strictEqual(mapContainsResult(row).name, "Tata Consultancy");
    assert.strictEqual(mapContainsResult(row, "tcs").name, "Tata Consultancy");
  });

  it("threads the query through the batch mapper", () => {
    const out = mapContainsResults(
      [
        {
          symbol: "TMPV",
          name: "Tata Motors Passenger Vehicles",
          instrumentType: "EQUITY",
          exchange: "NSE",
          previousSymbols: ["TATAMOTORS"],
        },
        {
          symbol: "TMCV",
          name: "Tata Motors",
          instrumentType: "EQUITY",
          exchange: "NSE",
          previousSymbols: ["TATAMOTORS"],
        },
      ],
      "TATAMOTORS"
    );
    // A demerger returns BOTH successors, each explaining itself.
    assert.deepStrictEqual(
      out.map((r) => r.name),
      [
        "Tata Motors Passenger Vehicles (formerly TATAMOTORS)",
        "Tata Motors (formerly TATAMOTORS)",
      ]
    );
  });
});
