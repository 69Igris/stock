/**
 * Fund Composition Service Tests
 *
 * Tests the REAL pure logic extracted from
 *   packages/core/src/market-data/instruments/fund-composition-service.ts
 * into
 *   packages/core/src/market-data/instruments/fund-composition-logic.ts
 *
 * The service imports and calls every function/constant under test
 * (parseGeminiResponse, validateHoldings, buildExtractionPrompt,
 * isCompositionStale, STALE_THRESHOLD_MS, VALID_HOLDING_TYPES, VALID_CAP_SIZES),
 * so this exercises production code (no inline reimplementation, no Gemini/DB).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STALE_THRESHOLD_MS,
  VALID_HOLDING_TYPES,
  VALID_CAP_SIZES,
  isCompositionStale,
  parseGeminiResponse,
  validateHoldings,
  buildExtractionPrompt,
  type ExtractedHolding,
} from "@usemoney/core/market-data/instruments/fund-composition-logic";
import type { CompositionResult } from "@usemoney/core/market-data";

// ============================================================================
// Helper: build a valid holding object for reuse in tests
// ============================================================================

function makeHolding(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    holdingName: "HDFC Bank Ltd",
    holdingSymbol: "HDFCBANK",
    isin: "INE040A01034",
    holdingType: "EQUITY",
    sector: "Banking",
    industry: "Private Banking",
    marketCap: "LARGE",
    weightPercent: 8.5,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("Fund Composition Service", () => {
  // --------------------------------------------------------------------------
  // VALID_HOLDING_TYPES constant
  // --------------------------------------------------------------------------
  describe("VALID_HOLDING_TYPES constant", () => {
    it("should contain exactly 6 holding types", () => {
      assert.strictEqual(VALID_HOLDING_TYPES.size, 6);
    });

    it("should contain EQUITY", () => {
      assert.ok(VALID_HOLDING_TYPES.has("EQUITY"));
    });

    it("should contain DEBT", () => {
      assert.ok(VALID_HOLDING_TYPES.has("DEBT"));
    });

    it("should contain CASH", () => {
      assert.ok(VALID_HOLDING_TYPES.has("CASH"));
    });

    it("should contain REIT", () => {
      assert.ok(VALID_HOLDING_TYPES.has("REIT"));
    });

    it("should contain GOLD", () => {
      assert.ok(VALID_HOLDING_TYPES.has("GOLD"));
    });

    it("should contain OTHER", () => {
      assert.ok(VALID_HOLDING_TYPES.has("OTHER"));
    });

    it("should NOT contain lowercase variants", () => {
      assert.ok(!VALID_HOLDING_TYPES.has("equity"));
      assert.ok(!VALID_HOLDING_TYPES.has("debt"));
      assert.ok(!VALID_HOLDING_TYPES.has("cash"));
    });

    it("should NOT contain STOCK", () => {
      assert.ok(!VALID_HOLDING_TYPES.has("STOCK"));
    });

    it("should NOT contain BOND", () => {
      assert.ok(!VALID_HOLDING_TYPES.has("BOND"));
    });

    it("should NOT contain empty string", () => {
      assert.ok(!VALID_HOLDING_TYPES.has(""));
    });
  });

  // --------------------------------------------------------------------------
  // VALID_CAP_SIZES constant
  // --------------------------------------------------------------------------
  describe("VALID_CAP_SIZES constant", () => {
    it("should contain exactly 4 cap sizes", () => {
      assert.strictEqual(VALID_CAP_SIZES.size, 4);
    });

    it("should contain LARGE", () => {
      assert.ok(VALID_CAP_SIZES.has("LARGE"));
    });

    it("should contain MID", () => {
      assert.ok(VALID_CAP_SIZES.has("MID"));
    });

    it("should contain SMALL", () => {
      assert.ok(VALID_CAP_SIZES.has("SMALL"));
    });

    it("should contain MICRO", () => {
      assert.ok(VALID_CAP_SIZES.has("MICRO"));
    });

    it("should NOT contain MEGA", () => {
      assert.ok(!VALID_CAP_SIZES.has("MEGA"));
    });

    it("should NOT contain NANO", () => {
      assert.ok(!VALID_CAP_SIZES.has("NANO"));
    });

    it("should NOT contain lowercase variants", () => {
      assert.ok(!VALID_CAP_SIZES.has("large"));
      assert.ok(!VALID_CAP_SIZES.has("mid"));
      assert.ok(!VALID_CAP_SIZES.has("small"));
    });

    it("should NOT contain empty string", () => {
      assert.ok(!VALID_CAP_SIZES.has(""));
    });
  });

  // --------------------------------------------------------------------------
  // STALE_THRESHOLD_MS constant
  // --------------------------------------------------------------------------
  describe("STALE_THRESHOLD_MS constant", () => {
    it("should equal 90 days in milliseconds", () => {
      assert.strictEqual(STALE_THRESHOLD_MS, 90 * 24 * 60 * 60 * 1000);
    });

    it("should be approximately 7,776,000,000 ms", () => {
      assert.strictEqual(STALE_THRESHOLD_MS, 7776000000);
    });

    it("should be greater than 30 days in milliseconds", () => {
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      assert.ok(STALE_THRESHOLD_MS > thirtyDays);
    });

    it("should be less than 180 days in milliseconds", () => {
      const oneEightyDays = 180 * 24 * 60 * 60 * 1000;
      assert.ok(STALE_THRESHOLD_MS < oneEightyDays);
    });
  });

  // --------------------------------------------------------------------------
  // Staleness check logic
  // --------------------------------------------------------------------------
  describe("Staleness check logic (real isCompositionStale)", () => {
    const NOW = Date.parse("2026-06-01T00:00:00Z");
    const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

    it("data from 1 day ago should be considered fresh", () => {
      assert.strictEqual(isCompositionStale(daysAgo(1), NOW), false);
    });

    it("data from 30 days ago should be considered fresh", () => {
      assert.strictEqual(isCompositionStale(daysAgo(30), NOW), false);
    });

    it("data from 89 days ago should be considered fresh", () => {
      assert.strictEqual(isCompositionStale(daysAgo(89), NOW), false);
    });

    it("data from exactly 90 days ago should be considered stale (>=)", () => {
      assert.strictEqual(isCompositionStale(daysAgo(90), NOW), true);
    });

    it("data from 91 days ago should trigger re-extraction", () => {
      assert.strictEqual(isCompositionStale(daysAgo(91), NOW), true);
    });

    it("data from 365 days ago should trigger re-extraction", () => {
      assert.strictEqual(isCompositionStale(daysAgo(365), NOW), true);
    });

    it("data from 0 ms ago should be considered fresh", () => {
      assert.strictEqual(isCompositionStale(new Date(NOW), NOW), false);
    });
  });

  // --------------------------------------------------------------------------
  // parseGeminiResponse - valid JSON
  // --------------------------------------------------------------------------
  describe("parseGeminiResponse - valid JSON", () => {
    it("should parse a valid JSON response with all fields", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        sectorBreakdown: [{ sector: "Banking", weight: 25.5 }],
        capBreakdown: [{ cap: "LARGE", weight: 65 }],
        assetBreakdown: [{ type: "EQUITY", weight: 85 }],
        confidence: 0.85,
        dataAsOf: "2025-12",
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.holdings.length, 1);
      assert.strictEqual(result.confidence, 0.85);
      assert.strictEqual(result.dataAsOf, "2025-12");
    });

    it("should parse response with multiple holdings", () => {
      const input = JSON.stringify({
        holdings: [
          makeHolding({ holdingName: "HDFC Bank Ltd", weightPercent: 8.5 }),
          makeHolding({
            holdingName: "Reliance Industries",
            weightPercent: 7.2,
          }),
          makeHolding({ holdingName: "Infosys Ltd", weightPercent: 5.1 }),
        ],
        confidence: 0.9,
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.holdings.length, 3);
    });

    it("should preserve sector breakdown arrays", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        sectorBreakdown: [
          { sector: "Banking", weight: 25.5 },
          { sector: "IT", weight: 20.0 },
        ],
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.sectorBreakdown.length, 2);
      assert.strictEqual(result.sectorBreakdown[0]!.sector, "Banking");
    });

    it("should preserve cap breakdown arrays", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        capBreakdown: [
          { cap: "LARGE", weight: 65 },
          { cap: "MID", weight: 25 },
        ],
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.capBreakdown.length, 2);
    });

    it("should preserve asset breakdown arrays", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        assetBreakdown: [
          { type: "EQUITY", weight: 85 },
          { type: "DEBT", weight: 10 },
        ],
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.assetBreakdown.length, 2);
    });

    it("should handle response with leading/trailing whitespace", () => {
      const input = `   ${JSON.stringify({
        holdings: [makeHolding()],
        confidence: 0.8,
      })}   `;
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.confidence, 0.8);
    });
  });

  // --------------------------------------------------------------------------
  // parseGeminiResponse - markdown code fence stripping
  // --------------------------------------------------------------------------
  describe("parseGeminiResponse - markdown code fence stripping", () => {
    it("should strip ```json ... ``` fences", () => {
      const json = JSON.stringify({
        holdings: [makeHolding()],
        confidence: 0.85,
      });
      const input = "```json\n" + json + "\n```";
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.confidence, 0.85);
    });

    it("should strip ``` ... ``` fences without json label", () => {
      const json = JSON.stringify({
        holdings: [makeHolding()],
        confidence: 0.75,
      });
      const input = "```\n" + json + "\n```";
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.confidence, 0.75);
    });

    it("should handle fences with no newline after opening fence", () => {
      const json = JSON.stringify({
        holdings: [makeHolding()],
      });
      const input = "```json " + json + " ```";
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.holdings.length, 1);
    });

    it("should not strip fences if content does not start with backticks", () => {
      const json = JSON.stringify({
        holdings: [makeHolding()],
        confidence: 0.6,
      });
      // No backtick prefix - should parse normally
      const result = parseGeminiResponse(json);
      assert.ok(result);
      assert.strictEqual(result.confidence, 0.6);
    });
  });

  // --------------------------------------------------------------------------
  // parseGeminiResponse - missing fields and defaults
  // --------------------------------------------------------------------------
  describe("parseGeminiResponse - missing fields and defaults", () => {
    it("should return null when holdings array is missing", () => {
      const input = JSON.stringify({
        sectorBreakdown: [{ sector: "Banking", weight: 25 }],
        confidence: 0.9,
      });
      const result = parseGeminiResponse(input);
      assert.strictEqual(result, null);
    });

    it("should return null when holdings is not an array", () => {
      const input = JSON.stringify({
        holdings: "not an array",
        confidence: 0.9,
      });
      const result = parseGeminiResponse(input);
      assert.strictEqual(result, null);
    });

    it("should return null when holdings is null", () => {
      const input = JSON.stringify({
        holdings: null,
        confidence: 0.9,
      });
      const result = parseGeminiResponse(input);
      assert.strictEqual(result, null);
    });

    it("should return null when holdings is an object (not array)", () => {
      const input = JSON.stringify({
        holdings: { name: "test" },
        confidence: 0.9,
      });
      const result = parseGeminiResponse(input);
      assert.strictEqual(result, null);
    });

    it("should default confidence to 0.7 when missing", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.confidence, 0.7);
    });

    it("should default confidence to 0.7 when it is a string", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        confidence: "high",
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.confidence, 0.7);
    });

    it("should default confidence to 0.7 when it is null", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        confidence: null,
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.confidence, 0.7);
    });

    it("should use provided confidence when it is a valid number", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        confidence: 0.95,
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.confidence, 0.95);
    });

    it("should default dataAsOf to empty string when missing", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.dataAsOf, "");
    });

    it("should default dataAsOf to empty string when it is a number", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        dataAsOf: 2025,
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.dataAsOf, "");
    });

    it("should default sectorBreakdown to empty array when missing", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.deepStrictEqual(result.sectorBreakdown, []);
    });

    it("should default capBreakdown to empty array when missing", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.deepStrictEqual(result.capBreakdown, []);
    });

    it("should default assetBreakdown to empty array when missing", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.deepStrictEqual(result.assetBreakdown, []);
    });

    it("should default sectorBreakdown to empty array when it is not an array", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        sectorBreakdown: "not array",
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.deepStrictEqual(result.sectorBreakdown, []);
    });

    it("should default capBreakdown to empty array when it is an object", () => {
      const input = JSON.stringify({
        holdings: [makeHolding()],
        capBreakdown: { cap: "LARGE" },
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.deepStrictEqual(result.capBreakdown, []);
    });

    it("should accept empty holdings array", () => {
      const input = JSON.stringify({
        holdings: [],
        confidence: 0.5,
      });
      const result = parseGeminiResponse(input);
      assert.ok(result);
      assert.strictEqual(result.holdings.length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // parseGeminiResponse - invalid JSON
  // --------------------------------------------------------------------------
  describe("parseGeminiResponse - invalid JSON", () => {
    it("should return null for completely invalid JSON", () => {
      assert.strictEqual(parseGeminiResponse("this is not json"), null);
    });

    it("should return null for empty string", () => {
      assert.strictEqual(parseGeminiResponse(""), null);
    });

    it("should return null for whitespace-only input", () => {
      assert.strictEqual(parseGeminiResponse("   \n\t  "), null);
    });

    it("should return null for truncated JSON", () => {
      assert.strictEqual(
        parseGeminiResponse('{"holdings": [{"holdingName": "test"'),
        null
      );
    });

    it("should return null for XML-like content", () => {
      assert.strictEqual(
        parseGeminiResponse("<response><holdings></holdings></response>"),
        null
      );
    });

    it("should return null for markdown text without JSON", () => {
      assert.strictEqual(
        parseGeminiResponse(
          "```\nSorry, I cannot find data for this fund.\n```"
        ),
        null
      );
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - valid holdings pass through
  // --------------------------------------------------------------------------
  describe("validateHoldings - valid holdings pass through", () => {
    it("should accept a fully valid holding", () => {
      const result = validateHoldings([makeHolding()]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.holdingName, "HDFC Bank Ltd");
      assert.strictEqual(result[0]!.holdingSymbol, "HDFCBANK");
      assert.strictEqual(result[0]!.isin, "INE040A01034");
      assert.strictEqual(result[0]!.holdingType, "EQUITY");
      assert.strictEqual(result[0]!.sector, "Banking");
      assert.strictEqual(result[0]!.industry, "Private Banking");
      assert.strictEqual(result[0]!.marketCap, "LARGE");
      assert.strictEqual(result[0]!.weightPercent, 8.5);
    });

    it("should accept multiple valid holdings", () => {
      const result = validateHoldings([
        makeHolding({ holdingName: "HDFC Bank", weightPercent: 8.5 }),
        makeHolding({ holdingName: "Reliance", weightPercent: 7.2 }),
        makeHolding({ holdingName: "Infosys", weightPercent: 5.1 }),
      ]);
      assert.strictEqual(result.length, 3);
    });

    it("should accept holding with minimal required fields only", () => {
      const result = validateHoldings([
        { holdingName: "Test Stock", weightPercent: 5.0 },
      ]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.holdingName, "Test Stock");
      assert.strictEqual(result[0]!.weightPercent, 5.0);
    });

    it("should accept all valid holding types", () => {
      const types = ["EQUITY", "DEBT", "CASH", "REIT", "GOLD", "OTHER"];
      for (const type of types) {
        const result = validateHoldings([makeHolding({ holdingType: type })]);
        assert.strictEqual(result.length, 1, `Type ${type} should be accepted`);
        assert.strictEqual(result[0]!.holdingType, type);
      }
    });

    it("should accept all valid cap sizes", () => {
      const caps = ["LARGE", "MID", "SMALL", "MICRO"];
      for (const cap of caps) {
        const result = validateHoldings([makeHolding({ marketCap: cap })]);
        assert.strictEqual(result.length, 1, `Cap ${cap} should be accepted`);
        assert.strictEqual(result[0]!.marketCap, cap);
      }
    });

    it("should accept weightPercent of exactly 100", () => {
      const result = validateHoldings([makeHolding({ weightPercent: 100 })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.weightPercent, 100);
    });

    it("should accept weightPercent of 0.01 (very small)", () => {
      const result = validateHoldings([makeHolding({ weightPercent: 0.01 })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.weightPercent, 0.01);
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - missing holdingName filtered out
  // --------------------------------------------------------------------------
  describe("validateHoldings - missing holdingName filtered out", () => {
    it("should filter out holding with missing holdingName", () => {
      const result = validateHoldings([
        { weightPercent: 8.5, holdingSymbol: "HDFCBANK" },
      ]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with null holdingName", () => {
      const result = validateHoldings([makeHolding({ holdingName: null })]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with empty string holdingName", () => {
      const result = validateHoldings([makeHolding({ holdingName: "" })]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with whitespace-only holdingName", () => {
      const result = validateHoldings([makeHolding({ holdingName: "   " })]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with numeric holdingName", () => {
      const result = validateHoldings([makeHolding({ holdingName: 12345 })]);
      assert.strictEqual(result.length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - missing/zero/negative weightPercent filtered
  // --------------------------------------------------------------------------
  describe("validateHoldings - invalid weightPercent filtered", () => {
    it("should filter out holding with missing weightPercent", () => {
      const result = validateHoldings([{ holdingName: "Test Stock" }]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with zero weightPercent", () => {
      const result = validateHoldings([makeHolding({ weightPercent: 0 })]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with negative weightPercent", () => {
      const result = validateHoldings([makeHolding({ weightPercent: -5 })]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with weightPercent as string", () => {
      const result = validateHoldings([makeHolding({ weightPercent: "8.5" })]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with null weightPercent", () => {
      const result = validateHoldings([makeHolding({ weightPercent: null })]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with weightPercent greater than 100", () => {
      const result = validateHoldings([makeHolding({ weightPercent: 100.01 })]);
      assert.strictEqual(result.length, 0);
    });

    it("should filter out holding with weightPercent of 150", () => {
      const result = validateHoldings([makeHolding({ weightPercent: 150 })]);
      assert.strictEqual(result.length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - invalid holdingType defaults to EQUITY
  // --------------------------------------------------------------------------
  describe("validateHoldings - invalid holdingType defaults to EQUITY", () => {
    it("should default to EQUITY when holdingType is missing", () => {
      const holding = makeHolding();
      delete holding.holdingType;
      const result = validateHoldings([holding]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.holdingType, "EQUITY");
    });

    it("should default to EQUITY when holdingType is an invalid string", () => {
      const result = validateHoldings([makeHolding({ holdingType: "STOCK" })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.holdingType, "EQUITY");
    });

    it("should default to EQUITY when holdingType is lowercase", () => {
      const result = validateHoldings([makeHolding({ holdingType: "equity" })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.holdingType, "EQUITY");
    });

    it("should default to EQUITY when holdingType is null", () => {
      const result = validateHoldings([makeHolding({ holdingType: null })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.holdingType, "EQUITY");
    });

    it("should default to EQUITY when holdingType is a number", () => {
      const result = validateHoldings([makeHolding({ holdingType: 1 })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.holdingType, "EQUITY");
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - invalid marketCap defaults to null
  // --------------------------------------------------------------------------
  describe("validateHoldings - invalid marketCap defaults to null", () => {
    it("should default to null when marketCap is missing", () => {
      const holding = makeHolding();
      delete holding.marketCap;
      const result = validateHoldings([holding]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.marketCap, null);
    });

    it("should default to null when marketCap is an invalid string", () => {
      const result = validateHoldings([makeHolding({ marketCap: "MEGA" })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.marketCap, null);
    });

    it("should default to null when marketCap is lowercase", () => {
      const result = validateHoldings([makeHolding({ marketCap: "large" })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.marketCap, null);
    });

    it("should default to null when marketCap is null", () => {
      const result = validateHoldings([makeHolding({ marketCap: null })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.marketCap, null);
    });

    it("should default to null when marketCap is a number", () => {
      const result = validateHoldings([makeHolding({ marketCap: 100 })]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0]!.marketCap, null);
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - string fields trimmed
  // --------------------------------------------------------------------------
  describe("validateHoldings - string fields trimmed", () => {
    it("should trim holdingName", () => {
      const result = validateHoldings([
        makeHolding({ holdingName: "  HDFC Bank Ltd  " }),
      ]);
      assert.strictEqual(result[0]!.holdingName, "HDFC Bank Ltd");
    });

    it("should trim holdingSymbol", () => {
      const result = validateHoldings([
        makeHolding({ holdingSymbol: "  HDFCBANK  " }),
      ]);
      assert.strictEqual(result[0]!.holdingSymbol, "HDFCBANK");
    });

    it("should trim isin", () => {
      const result = validateHoldings([
        makeHolding({ isin: "  INE040A01034  " }),
      ]);
      assert.strictEqual(result[0]!.isin, "INE040A01034");
    });

    it("should trim sector", () => {
      const result = validateHoldings([makeHolding({ sector: "  Banking  " })]);
      assert.strictEqual(result[0]!.sector, "Banking");
    });

    it("should trim industry", () => {
      const result = validateHoldings([
        makeHolding({ industry: "  Private Banking  " }),
      ]);
      assert.strictEqual(result[0]!.industry, "Private Banking");
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - non-string optional fields default to null
  // --------------------------------------------------------------------------
  describe("validateHoldings - non-string optional fields default to null", () => {
    it("should set holdingSymbol to null when it is a number", () => {
      const result = validateHoldings([makeHolding({ holdingSymbol: 12345 })]);
      assert.strictEqual(result[0]!.holdingSymbol, null);
    });

    it("should set isin to null when it is a number", () => {
      const result = validateHoldings([makeHolding({ isin: 12345 })]);
      assert.strictEqual(result[0]!.isin, null);
    });

    it("should set sector to null when it is a boolean", () => {
      const result = validateHoldings([makeHolding({ sector: true })]);
      assert.strictEqual(result[0]!.sector, null);
    });

    it("should set industry to null when it is undefined", () => {
      const holding = makeHolding();
      delete holding.industry;
      const result = validateHoldings([holding]);
      assert.strictEqual(result[0]!.industry, null);
    });

    it("should set holdingSymbol to null when missing entirely", () => {
      const holding = makeHolding();
      delete holding.holdingSymbol;
      const result = validateHoldings([holding]);
      assert.strictEqual(result[0]!.holdingSymbol, null);
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - non-object and null items filtered
  // --------------------------------------------------------------------------
  describe("validateHoldings - non-object and null items filtered", () => {
    it("should filter out null items", () => {
      const result = validateHoldings([null, makeHolding()]);
      assert.strictEqual(result.length, 1);
    });

    it("should filter out undefined items", () => {
      const result = validateHoldings([undefined, makeHolding()]);
      assert.strictEqual(result.length, 1);
    });

    it("should filter out string items", () => {
      const result = validateHoldings(["some string", makeHolding()]);
      assert.strictEqual(result.length, 1);
    });

    it("should filter out number items", () => {
      const result = validateHoldings([42, makeHolding()]);
      assert.strictEqual(result.length, 1);
    });

    it("should filter out boolean items", () => {
      const result = validateHoldings([true, false, makeHolding()]);
      assert.strictEqual(result.length, 1);
    });

    it("should return empty array when all items are invalid", () => {
      const result = validateHoldings([null, undefined, "string", 42, true]);
      assert.strictEqual(result.length, 0);
    });

    it("should return empty array for empty input", () => {
      const result = validateHoldings([]);
      assert.strictEqual(result.length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - weightPercent rounding
  // --------------------------------------------------------------------------
  describe("validateHoldings - weightPercent rounding", () => {
    it("should round weightPercent to 2 decimal places", () => {
      const result = validateHoldings([makeHolding({ weightPercent: 8.555 })]);
      assert.strictEqual(result[0]!.weightPercent, 8.56);
    });

    it("should round 3.141592 to 3.14", () => {
      const result = validateHoldings([
        makeHolding({ weightPercent: 3.141592 }),
      ]);
      assert.strictEqual(result[0]!.weightPercent, 3.14);
    });

    it("should keep integer weights unchanged", () => {
      const result = validateHoldings([makeHolding({ weightPercent: 10 })]);
      assert.strictEqual(result[0]!.weightPercent, 10);
    });

    it("should keep single decimal weights unchanged", () => {
      const result = validateHoldings([makeHolding({ weightPercent: 5.5 })]);
      assert.strictEqual(result[0]!.weightPercent, 5.5);
    });
  });

  // --------------------------------------------------------------------------
  // validateHoldings - mixed valid and invalid
  // --------------------------------------------------------------------------
  describe("validateHoldings - mixed valid and invalid items", () => {
    it("should keep only valid holdings from mixed input", () => {
      const noWeight: Record<string, unknown> = { holdingName: "No Weight" };
      const result = validateHoldings([
        null,
        makeHolding({ holdingName: "Valid Stock", weightPercent: 5.0 }),
        makeHolding({ holdingName: "", weightPercent: 10.0 }),
        makeHolding({ holdingName: "Another Valid", weightPercent: 3.0 }),
        noWeight,
        42,
      ]);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0]!.holdingName, "Valid Stock");
      assert.strictEqual(result[1]!.holdingName, "Another Valid");
    });
  });

  // --------------------------------------------------------------------------
  // buildExtractionPrompt - MF prompt
  // --------------------------------------------------------------------------
  describe("buildExtractionPrompt - MF prompt", () => {
    const mfInfo = {
      name: "SBI Nifty 50 Index Fund",
      issuer: "SBI Mutual Fund",
      category: "Index Fund",
    };

    it("should include 'mutual fund' for MF type", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(prompt.includes("mutual fund"));
    });

    it("should NOT include 'ETF' as the fund type label for MF", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      // The prompt says "the following mutual fund" not "the following ETF"
      assert.ok(!prompt.includes("the following ETF"));
    });

    it("should include 'AMC:' label for MF type", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(prompt.includes("AMC: SBI Mutual Fund"));
    });

    it("should NOT include 'Issuer:' label for MF type", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(!prompt.includes("Issuer:"));
    });

    it("should include fund name in the prompt", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(prompt.includes("SBI Nifty 50 Index Fund"));
    });

    it("should include category in the prompt", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(prompt.includes("Index Fund"));
    });

    it("should include JSON format instructions", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(prompt.includes("RESPONSE FORMAT"));
      assert.ok(prompt.includes("valid JSON"));
    });

    it("should include holdingType enum values", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(prompt.includes("EQUITY"));
      assert.ok(prompt.includes("DEBT"));
      assert.ok(prompt.includes("CASH"));
      assert.ok(prompt.includes("REIT"));
      assert.ok(prompt.includes("GOLD"));
      assert.ok(prompt.includes("OTHER"));
    });

    it("should include marketCap enum values", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(prompt.includes("LARGE"));
      assert.ok(prompt.includes("MID"));
      assert.ok(prompt.includes("SMALL"));
      assert.ok(prompt.includes("MICRO"));
    });

    it("should include confidence instructions", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(prompt.includes("confidence"));
    });

    it("should include dataAsOf instructions", () => {
      const prompt = buildExtractionPrompt("MF", mfInfo);
      assert.ok(prompt.includes("dataAsOf"));
    });
  });

  // --------------------------------------------------------------------------
  // buildExtractionPrompt - ETF prompt
  // --------------------------------------------------------------------------
  describe("buildExtractionPrompt - ETF prompt", () => {
    const etfInfo = {
      name: "Nippon India Nifty BeES",
      issuer: "Nippon India Nifty BeES",
      category: "ETF",
    };

    it("should include 'ETF' for ETF type", () => {
      const prompt = buildExtractionPrompt("ETF", etfInfo);
      assert.ok(prompt.includes("the following ETF"));
    });

    it("should NOT include 'mutual fund' as the fund type label for ETF", () => {
      const prompt = buildExtractionPrompt("ETF", etfInfo);
      assert.ok(!prompt.includes("the following mutual fund"));
    });

    it("should include 'Issuer:' label for ETF type", () => {
      const prompt = buildExtractionPrompt("ETF", etfInfo);
      assert.ok(prompt.includes("Issuer: Nippon India Nifty BeES"));
    });

    it("should NOT include 'AMC:' label for ETF type", () => {
      const prompt = buildExtractionPrompt("ETF", etfInfo);
      assert.ok(!prompt.includes("AMC:"));
    });

    it("should include ETF name in the prompt", () => {
      const prompt = buildExtractionPrompt("ETF", etfInfo);
      assert.ok(prompt.includes("Nippon India Nifty BeES"));
    });

    it("should include category in the prompt", () => {
      const prompt = buildExtractionPrompt("ETF", etfInfo);
      assert.ok(prompt.includes("Category: ETF"));
    });

    it("should include the same structural instructions as MF", () => {
      const prompt = buildExtractionPrompt("ETF", etfInfo);
      assert.ok(prompt.includes("sectorBreakdown"));
      assert.ok(prompt.includes("capBreakdown"));
      assert.ok(prompt.includes("assetBreakdown"));
      assert.ok(prompt.includes("weightPercent"));
    });
  });

  // --------------------------------------------------------------------------
  // CompositionResult type structure
  // --------------------------------------------------------------------------
  describe("CompositionResult type structure", () => {
    it("should allow a valid MF CompositionResult object", () => {
      const result: CompositionResult = {
        fundType: "MF",
        fundId: "119598",
        holdings: [
          {
            holdingName: "HDFC Bank Ltd",
            holdingSymbol: "HDFCBANK",
            isin: "INE040A01034",
            holdingType: "EQUITY",
            sector: "Banking",
            industry: "Private Banking",
            marketCap: "LARGE",
            weightPercent: 8.5,
          },
        ],
        sectorBreakdown: [{ sector: "Banking", weight: 25.5 }],
        capBreakdown: [{ cap: "LARGE", weight: 65 }],
        assetBreakdown: [{ type: "EQUITY", weight: 85 }],
        totalHoldings: 1,
        confidence: 0.85,
        dataAsOf: "2025-12",
      };
      assert.strictEqual(result.fundType, "MF");
      assert.strictEqual(result.fundId, "119598");
      assert.strictEqual(result.holdings.length, 1);
      assert.strictEqual(result.totalHoldings, 1);
      assert.strictEqual(result.confidence, 0.85);
    });

    it("should allow a valid ETF CompositionResult object", () => {
      const result: CompositionResult = {
        fundType: "ETF",
        fundId: "NIFTYBEES",
        holdings: [],
        sectorBreakdown: [],
        capBreakdown: [],
        assetBreakdown: [],
        totalHoldings: 0,
        confidence: 0,
        dataAsOf: "",
      };
      assert.strictEqual(result.fundType, "ETF");
      assert.strictEqual(result.fundId, "NIFTYBEES");
      assert.strictEqual(result.holdings.length, 0);
    });

    it("should allow null holdingSymbol in ExtractedHolding", () => {
      const holding: ExtractedHolding = {
        holdingName: "Government Bond",
        holdingSymbol: null,
        isin: null,
        holdingType: "DEBT",
        sector: null,
        industry: null,
        marketCap: null,
        weightPercent: 15.0,
      };
      assert.strictEqual(holding.holdingSymbol, null);
      assert.strictEqual(holding.isin, null);
      assert.strictEqual(holding.marketCap, null);
    });

    it("should enforce holdingType as union of valid types", () => {
      const types: ExtractedHolding["holdingType"][] = [
        "EQUITY",
        "DEBT",
        "CASH",
        "REIT",
        "GOLD",
        "OTHER",
      ];
      assert.strictEqual(types.length, 6);
      for (const t of types) {
        assert.ok(VALID_HOLDING_TYPES.has(t));
      }
    });

    it("should enforce marketCap as union of valid sizes or null", () => {
      const caps: ExtractedHolding["marketCap"][] = [
        "LARGE",
        "MID",
        "SMALL",
        "MICRO",
        null,
      ];
      assert.strictEqual(caps.length, 5);
      for (const c of caps) {
        if (c !== null) {
          assert.ok(VALID_CAP_SIZES.has(c));
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // buildExtractionPrompt - prompt structure validation
  // --------------------------------------------------------------------------
  describe("buildExtractionPrompt - prompt structure", () => {
    it("should mention SEBI portfolio disclosure", () => {
      const prompt = buildExtractionPrompt("MF", {
        name: "Test Fund",
        issuer: "Test AMC",
        category: "Large Cap",
      });
      assert.ok(prompt.includes("SEBI"));
    });

    it("should mention 15-25 holdings target", () => {
      const prompt = buildExtractionPrompt("MF", {
        name: "Test Fund",
        issuer: "Test AMC",
        category: "Large Cap",
      });
      assert.ok(prompt.includes("15-25"));
    });

    it("should include critical rules about not fabricating data", () => {
      const prompt = buildExtractionPrompt("MF", {
        name: "Test Fund",
        issuer: "Test AMC",
        category: "Large Cap",
      });
      assert.ok(prompt.includes("Do NOT fabricate"));
    });

    it("should mention NSE symbols", () => {
      const prompt = buildExtractionPrompt("MF", {
        name: "Test Fund",
        issuer: "Test AMC",
        category: "Large Cap",
      });
      assert.ok(prompt.includes("NSE symbols"));
      assert.ok(prompt.includes("HDFCBANK"));
      assert.ok(prompt.includes("RELIANCE"));
      assert.ok(prompt.includes("INFY"));
    });

    it("should include example JSON in the prompt", () => {
      const prompt = buildExtractionPrompt("MF", {
        name: "Test Fund",
        issuer: "Test AMC",
        category: "Large Cap",
      });
      assert.ok(prompt.includes('"holdingName"'));
      assert.ok(prompt.includes('"holdingSymbol"'));
      assert.ok(prompt.includes('"weightPercent"'));
    });
  });
});
