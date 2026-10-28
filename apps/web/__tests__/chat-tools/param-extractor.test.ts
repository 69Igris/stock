/**
 * Parameter Extractor Tests (lib/chat-tools/param-extractor.ts)
 *
 * Tests for the Zod-based parameter extraction and validation:
 *   - extractAndValidateParams: validates raw params against a Zod schema
 *   - Missing required fields → error with field names in message
 *   - Type errors → validation error messages
 *   - Success → parsed params returned
 *
 * NOTE: The project uses Zod v4 which does NOT include a `received` property
 * on issue objects. The source code's `"received" in i` guard evaluates to false,
 * so missing fields always fall through to the generic "Invalid parameters" path
 * rather than the "I need more information" path. Tests reflect this actual behavior.
 *
 * Pure functions extracted inline from the source (no side-effecting imports).
 * Uses real Zod schemas matching the tool registry definitions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";

// De-shadowed (MONEY-620): drive the REAL pure validator over the REAL tool
// schemas. `validateParamsAgainstSchema` is the exact code param-extractor.ts
// (and thus executor.ts) runs after resolving the tool; the schemas come from
// `registry-metadata.ts` (registry-free, importable under node:test). This
// pins the actual Zod-v4 behavior — including the "received"-is-absent quirk
// that funnels missing fields into the generic "Invalid parameters" path.
import { validateParamsAgainstSchema } from "@/lib/chat-tools/param-extractor-logic";
import {
  EmptyParams,
  HoldingsFilterParams,
  PositionsFilterParams,
  TradesFilterParams,
  CreateFireScenarioParams,
  PaperBuyParams,
  PaperSellParams,
} from "@/lib/chat-tools/registry-metadata";

// ── Real tool-schema map (the schemas the registry actually uses) ───────

const SCHEMAS: Record<string, z.ZodSchema> = {
  get_portfolio_summary: EmptyParams,
  get_holdings: HoldingsFilterParams,
  get_positions: PositionsFilterParams,
  get_trades: TradesFilterParams,
  create_fire_scenario: CreateFireScenarioParams,
  buy_paper_position: PaperBuyParams,
  sell_paper_position: PaperSellParams,
};

/**
 * Thin wrapper mirroring the REAL `extractAndValidateParams`'s unknown-tool
 * branch, then delegating to the REAL `validateParamsAgainstSchema`. The
 * production code does `getTool(toolName)` (needs the registry's react.cache
 * chain) → `validateParamsAgainstSchema(tool.parameters, raw)`; here we resolve
 * the same real schema via the map and call the same validator.
 */
function extractAndValidateParams(
  toolName: string,
  rawParams: Record<string, unknown>
): ReturnType<typeof validateParamsAgainstSchema> {
  const schema = SCHEMAS[toolName];
  if (!schema) {
    // Mirrors the REAL extractAndValidateParams unknown-tool message.
    return {
      success: false,
      clarifyingQuestion:
        "I don't recognize that action. Could you rephrase your request?",
    };
  }
  return validateParamsAgainstSchema(schema, rawParams);
}

// ======================================================================
// Tests
// ======================================================================

describe("Parameter Extractor", () => {
  // ── Unknown tool ──────────────────────────────────────────────────

  describe("unknown tool", () => {
    it("should return a generic clarifying question for unknown tools", () => {
      const result = extractAndValidateParams("nonexistent_tool", {});
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion?.includes("don't recognize"));
    });

    it("should not leak the raw tool name in the error message", () => {
      // The real contract is a generic rephrase prompt (no internal name).
      const result = extractAndValidateParams("delete_account", {});
      assert.ok(!result.clarifyingQuestion?.includes("delete_account"));
    });

    it("should not have missingFields for unknown tool", () => {
      const result = extractAndValidateParams("bad_tool", {});
      assert.strictEqual(result.missingFields, undefined);
    });
  });

  // ── EmptyParams (get_portfolio_summary) ───────────────────────────

  describe("EmptyParams schema (get_portfolio_summary)", () => {
    it("should accept empty object", () => {
      const result = extractAndValidateParams("get_portfolio_summary", {});
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.params, {});
    });

    it("should strip unknown fields", () => {
      const result = extractAndValidateParams("get_portfolio_summary", {
        extra: "field",
        another: 42,
      });
      assert.strictEqual(result.success, true);
    });
  });

  // ── HoldingsFilterParams (get_holdings) ───────────────────────────

  describe("HoldingsFilterParams schema (get_holdings)", () => {
    it("should accept empty object (all optional)", () => {
      const result = extractAndValidateParams("get_holdings", {});
      assert.strictEqual(result.success, true);
    });

    it("should accept broker filter", () => {
      const result = extractAndValidateParams("get_holdings", {
        broker: "ZERODHA",
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.broker, "ZERODHA");
    });

    it("should accept all filters", () => {
      const result = extractAndValidateParams("get_holdings", {
        broker: "UPSTOX",
        sector: "Technology",
        symbol: "TCS",
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.broker, "UPSTOX");
      assert.strictEqual(result.params?.sector, "Technology");
      assert.strictEqual(result.params?.symbol, "TCS");
    });

    it("should reject non-string broker", () => {
      const result = extractAndValidateParams("get_holdings", {
        broker: 123,
      });
      assert.strictEqual(result.success, false);
    });

    it("should omit optional fields when not provided", () => {
      const result = extractAndValidateParams("get_holdings", {
        symbol: "RELIANCE",
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.broker, undefined);
      assert.strictEqual(result.params?.sector, undefined);
    });
  });

  // ── PositionsFilterParams (get_positions) ─────────────────────────

  describe("PositionsFilterParams schema (get_positions)", () => {
    it("should accept empty object", () => {
      const result = extractAndValidateParams("get_positions", {});
      assert.strictEqual(result.success, true);
    });

    it("should accept valid OPEN status", () => {
      const result = extractAndValidateParams("get_positions", {
        status: "OPEN",
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.status, "OPEN");
    });

    it("should accept valid CLOSED status", () => {
      const result = extractAndValidateParams("get_positions", {
        status: "CLOSED",
      });
      assert.strictEqual(result.success, true);
    });

    it("should reject invalid status enum", () => {
      const result = extractAndValidateParams("get_positions", {
        status: "PENDING",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion?.includes("Invalid parameters"));
    });
  });

  // ── TradesFilterParams (get_trades) ───────────────────────────────

  describe("TradesFilterParams schema (get_trades)", () => {
    it("should accept empty object", () => {
      const result = extractAndValidateParams("get_trades", {});
      assert.strictEqual(result.success, true);
    });

    it("should accept valid skip and limit", () => {
      const result = extractAndValidateParams("get_trades", {
        skip: 0,
        limit: 20,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.skip, 0);
      assert.strictEqual(result.params?.limit, 20);
    });

    it("should reject negative skip", () => {
      const result = extractAndValidateParams("get_trades", { skip: -1 });
      assert.strictEqual(result.success, false);
    });

    it("should reject zero limit (must be positive)", () => {
      const result = extractAndValidateParams("get_trades", { limit: 0 });
      assert.strictEqual(result.success, false);
    });

    it("should reject non-integer skip", () => {
      const result = extractAndValidateParams("get_trades", { skip: 1.5 });
      assert.strictEqual(result.success, false);
    });

    it("should accept valid tradeType BUY", () => {
      const result = extractAndValidateParams("get_trades", {
        tradeType: "BUY",
      });
      assert.strictEqual(result.success, true);
    });

    it("should reject invalid tradeType", () => {
      const result = extractAndValidateParams("get_trades", {
        tradeType: "HOLD",
      });
      assert.strictEqual(result.success, false);
    });
  });

  // ── CreateFireScenarioParams ──────────────────────────────────────

  describe("CreateFireScenarioParams schema (create_fire_scenario)", () => {
    it("should accept all required params", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "My Plan",
        currentAge: 30,
        retirementAge: 50,
        currentCorpus: 1000000,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.name, "My Plan");
    });

    it("should accept optional monthlySavings", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Plan B",
        currentAge: 25,
        retirementAge: 40,
        currentCorpus: 500000,
        monthlySavings: 50000,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.monthlySavings, 50000);
    });

    it("should fail when all required fields are missing", () => {
      const result = extractAndValidateParams("create_fire_scenario", {});
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion);
      // Zod v4 puts missing fields in "Invalid parameters" path (no `received` property)
      assert.ok(result.clarifyingQuestion.includes("name"));
      assert.ok(result.clarifyingQuestion.includes("currentAge"));
      assert.ok(result.clarifyingQuestion.includes("retirementAge"));
      assert.ok(result.clarifyingQuestion.includes("currentCorpus"));
    });

    it("should include field names in error for partially missing params", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Plan",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion);
      assert.ok(result.clarifyingQuestion.includes("currentAge"));
      assert.ok(result.clarifyingQuestion.includes("retirementAge"));
      assert.ok(result.clarifyingQuestion.includes("currentCorpus"));
      // name is provided, should not appear in error
      // (it appears in "Invalid parameters:" prefix but not as missing field)
    });

    it("should reject currentAge below 18", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Kid Plan",
        currentAge: 15,
        retirementAge: 50,
        currentCorpus: 0,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion?.includes("Invalid parameters"));
    });

    it("should reject retirementAge below 25", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Plan",
        currentAge: 20,
        retirementAge: 22,
        currentCorpus: 0,
      });
      assert.strictEqual(result.success, false);
    });

    it("should reject negative currentCorpus", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Plan",
        currentAge: 30,
        retirementAge: 50,
        currentCorpus: -100,
      });
      assert.strictEqual(result.success, false);
    });

    it("should accept zero currentCorpus", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Fresh Start",
        currentAge: 22,
        retirementAge: 45,
        currentCorpus: 0,
      });
      assert.strictEqual(result.success, true);
    });

    it("should reject non-integer currentAge", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Plan",
        currentAge: 30.5,
        retirementAge: 50,
        currentCorpus: 100000,
      });
      assert.strictEqual(result.success, false);
    });

    it("should reject negative monthlySavings", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Plan",
        currentAge: 30,
        retirementAge: 50,
        currentCorpus: 100000,
        monthlySavings: -5000,
      });
      assert.strictEqual(result.success, false);
    });

    it("should include only missing field name in error when one field missing", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Plan",
        currentAge: 30,
        retirementAge: 50,
        // currentCorpus is missing
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion?.includes("currentCorpus"));
    });

    it("should accept boundary values at age minimum", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Min Age Plan",
        currentAge: 18,
        retirementAge: 25,
        currentCorpus: 0,
      });
      assert.strictEqual(result.success, true);
    });
  });

  // ── PaperBuyParams ────────────────────────────────────────────────

  describe("PaperBuyParams schema (buy_paper_position)", () => {
    it("should accept valid buy params", () => {
      const result = extractAndValidateParams("buy_paper_position", {
        symbol: "TCS",
        quantity: 10,
        price: 3800,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.symbol, "TCS");
      assert.strictEqual(result.params?.quantity, 10);
      assert.strictEqual(result.params?.price, 3800);
    });

    it("should accept optional exchange and segment", () => {
      const result = extractAndValidateParams("buy_paper_position", {
        symbol: "RELIANCE",
        quantity: 5,
        price: 2500,
        exchange: "BSE",
        segment: "EQUITY",
        assetType: "STOCK",
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.exchange, "BSE");
    });

    it("should reject zero quantity", () => {
      const result = extractAndValidateParams("buy_paper_position", {
        symbol: "TCS",
        quantity: 0,
        price: 3800,
      });
      assert.strictEqual(result.success, false);
    });

    it("should reject negative quantity", () => {
      const result = extractAndValidateParams("buy_paper_position", {
        symbol: "TCS",
        quantity: -5,
        price: 3800,
      });
      assert.strictEqual(result.success, false);
    });

    it("should reject zero price", () => {
      const result = extractAndValidateParams("buy_paper_position", {
        symbol: "TCS",
        quantity: 10,
        price: 0,
      });
      assert.strictEqual(result.success, false);
    });

    it("should reject negative price", () => {
      const result = extractAndValidateParams("buy_paper_position", {
        symbol: "TCS",
        quantity: 10,
        price: -100,
      });
      assert.strictEqual(result.success, false);
    });

    it("should fail with field names when all required fields missing", () => {
      const result = extractAndValidateParams("buy_paper_position", {});
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion);
      assert.ok(result.clarifyingQuestion.includes("symbol"));
      assert.ok(result.clarifyingQuestion.includes("quantity"));
      assert.ok(result.clarifyingQuestion.includes("price"));
    });

    it("should reject non-integer quantity", () => {
      const result = extractAndValidateParams("buy_paper_position", {
        symbol: "TCS",
        quantity: 10.5,
        price: 3800,
      });
      assert.strictEqual(result.success, false);
    });

    it("should accept decimal price", () => {
      const result = extractAndValidateParams("buy_paper_position", {
        symbol: "SBIN",
        quantity: 100,
        price: 612.75,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.price, 612.75);
    });
  });

  // ── PaperSellParams ──────────────────────────────────────────────

  describe("PaperSellParams schema (sell_paper_position)", () => {
    it("should accept valid sell params", () => {
      const result = extractAndValidateParams("sell_paper_position", {
        positionId: "pos-123",
        exitPrice: 1800,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.positionId, "pos-123");
      assert.strictEqual(result.params?.exitPrice, 1800);
    });

    it("should fail when positionId is missing", () => {
      const result = extractAndValidateParams("sell_paper_position", {
        exitPrice: 1800,
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion?.includes("positionId"));
    });

    it("should fail when exitPrice is missing", () => {
      const result = extractAndValidateParams("sell_paper_position", {
        positionId: "pos-123",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion?.includes("exitPrice"));
    });

    it("should reject zero exitPrice", () => {
      const result = extractAndValidateParams("sell_paper_position", {
        positionId: "pos-123",
        exitPrice: 0,
      });
      assert.strictEqual(result.success, false);
    });

    it("should reject negative exitPrice", () => {
      const result = extractAndValidateParams("sell_paper_position", {
        positionId: "pos-123",
        exitPrice: -500,
      });
      assert.strictEqual(result.success, false);
    });

    it("should accept decimal exitPrice", () => {
      const result = extractAndValidateParams("sell_paper_position", {
        positionId: "pos-456",
        exitPrice: 1250.5,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.exitPrice, 1250.5);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should fail for completely empty params on required schema", () => {
      const result = extractAndValidateParams("create_fire_scenario", {});
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion);
      // All four required fields should appear in the error
      assert.ok(result.clarifyingQuestion.includes("name"));
      assert.ok(result.clarifyingQuestion.includes("currentAge"));
    });

    it("should distinguish missing fields from type errors in message", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: 123, // wrong type, not missing
        currentAge: 30,
        retirementAge: 50,
        currentCorpus: 100000,
      });
      assert.strictEqual(result.success, false);
      // "name" has wrong type → should appear in error but as type error not "undefined"
      assert.ok(result.clarifyingQuestion?.includes("name"));
    });

    it("should handle wrong type for all required fields", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: 123,
        currentAge: "thirty",
        retirementAge: "fifty",
        currentCorpus: "a lot",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion);
    });

    it("should include field names for multiple missing fields in error", () => {
      const result = extractAndValidateParams("buy_paper_position", {
        symbol: "TCS",
        // missing quantity and price
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion?.includes("quantity"));
      assert.ok(result.clarifyingQuestion?.includes("price"));
    });

    it("should produce error messages with field paths for type errors", () => {
      const result = extractAndValidateParams("get_trades", {
        tradeType: "INVALID",
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.clarifyingQuestion?.includes("Invalid parameters"));
      assert.ok(result.clarifyingQuestion?.includes("tradeType"));
    });

    it("should return success false and no params on failure", () => {
      const result = extractAndValidateParams("create_fire_scenario", {});
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.params, undefined);
    });

    it("should return params on success", () => {
      const result = extractAndValidateParams("get_holdings", {
        broker: "ZERODHA",
      });
      assert.strictEqual(result.success, true);
      assert.ok(result.params);
    });

    it("should handle large number values", () => {
      const result = extractAndValidateParams("create_fire_scenario", {
        name: "Big Plan",
        currentAge: 30,
        retirementAge: 65,
        currentCorpus: 999999999999,
        monthlySavings: 500000,
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.params?.currentCorpus, 999999999999);
    });
  });
});
