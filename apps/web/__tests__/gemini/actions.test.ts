/**
 * Gemini Actions Tests
 *
 * Tests for the action detection and parsing system that enables
 * users to perform operations via chat commands.
 *
 * Tests cover:
 * - detectActions: regex-based action detection in LLM responses
 * - validateActionParameters: required field checking and type-specific validation
 * - sanitizeActionParams: XSS prevention and input sanitization
 * - removeActionMarkers: cleaning action markers from response text
 * - pageSupportsActions: page path validation for action support
 * - parseActionParameters: JSON parsing from key-value strings
 * - generateConfirmationMessage: user-friendly message generation
 *
 * The pure functions are reimplemented inline because the source module
 * (actions.ts) has side-effecting imports (@usemoney/logger, @usemoney/types)
 * that aren't available in the unit test environment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL actions.ts exports. The module only
// imports the logger + types, so it loads cleanly here.
// The previous inline copy was STALE on the SEBI-compliance front (MONEY-457):
//   • validateActionParameters("save_analysis") used to ACCEPT BUY/HOLD/SELL;
//     the real source REJECTS anything but "N/A" and rejects targetPrice/stopLoss.
//   • the save_analysis confirmation copy no longer echoes the recommendation
//     or a "target price" suffix — it is just "Save analysis for {symbol}?".
// The copy stayed green while asserting the OLD, non-compliant behaviour.
import {
  detectActions,
  validateActionParameters,
  sanitizeActionParams,
  removeActionMarkers,
  pageSupportsActions,
  parseActionParameters,
  generateConfirmationMessage,
} from "@/lib/gemini/actions";
import type { ActionType } from "@usemoney/types";

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Gemini Actions", () => {
  // ───────────────────── detectActions ─────────────────────

  describe("detectActions", () => {
    describe("create_scenario detection", () => {
      it("should detect create_scenario action with all params", () => {
        const response =
          'I can help you create that. ACTION: create_scenario { name: "Early Retirement", retirementAge: 50, currentAge: 30, currentCorpus: 500000 }';
        const result = detectActions(response, "/fire");
        assert.ok(result);
        assert.strictEqual(result.type, "create_scenario");
        assert.strictEqual(result.parameters.name, "Early Retirement");
        assert.strictEqual(result.parameters.retirementAge, 50);
      });

      it("should detect create_scenario with case-insensitive ACTION keyword", () => {
        const response =
          'action: create_scenario { name: "Test", retirementAge: 60, currentAge: 25, currentCorpus: 100000 }';
        const result = detectActions(response, "/fire");
        assert.ok(result);
        assert.strictEqual(result.type, "create_scenario");
      });
    });

    describe("add_stock detection", () => {
      it("should detect add_stock action", () => {
        const response =
          "Sure, I'll add that for you. ACTION: add_stock { symbol: RELIANCE, quantity: 10, buyPrice: 2500 }";
        const result = detectActions(response, "/holdings");
        assert.ok(result);
        assert.strictEqual(result.type, "add_stock");
        assert.strictEqual(result.parameters.quantity, 10);
        assert.strictEqual(result.parameters.buyPrice, 2500);
      });
    });

    describe("add_mutual_fund detection", () => {
      it("should detect add_mutual_fund action", () => {
        const response =
          'ACTION: add_mutual_fund { schemeName: "SBI Bluechip Fund", units: 100.5, nav: 55.25 }';
        const result = detectActions(response, "/holdings");
        assert.ok(result);
        assert.strictEqual(result.type, "add_mutual_fund");
        assert.strictEqual(result.parameters.schemeName, "SBI Bluechip Fund");
      });
    });

    describe("delete_scenario detection", () => {
      it("should detect delete_scenario action", () => {
        const response =
          'I will delete that scenario. ACTION: delete_scenario { name: "Old Plan" }';
        const result = detectActions(response, "/fire");
        assert.ok(result);
        assert.strictEqual(result.type, "delete_scenario");
        assert.strictEqual(result.parameters.name, "Old Plan");
      });
    });

    describe("modify_scenario detection", () => {
      it("should detect modify_scenario action", () => {
        const response =
          'ACTION: modify_scenario { name: "My Plan", retirementAge: 55 }';
        const result = detectActions(response, "/fire");
        assert.ok(result);
        assert.strictEqual(result.type, "modify_scenario");
      });
    });

    describe("remove_holding detection", () => {
      it("should detect remove_holding action", () => {
        const response = "ACTION: remove_holding { symbol: TCS }";
        const result = detectActions(response, "/holdings");
        assert.ok(result);
        assert.strictEqual(result.type, "remove_holding");
      });
    });

    describe("save_analysis detection", () => {
      it("should detect save_analysis action", () => {
        const response =
          'ACTION: save_analysis { symbol: INFY, recommendation: "BUY" }';
        const result = detectActions(response, "/analysis");
        assert.ok(result);
        assert.strictEqual(result.type, "save_analysis");
      });
    });

    describe("no action detection", () => {
      it("should return null when no action marker is present", () => {
        const response =
          "The stock market has been volatile recently. Consider diversifying.";
        const result = detectActions(response, "/holdings");
        assert.strictEqual(result, null);
      });

      it("should return null for empty response", () => {
        const result = detectActions("", "/fire");
        assert.strictEqual(result, null);
      });

      it("should return null for response with partial action marker", () => {
        const result = detectActions("ACTION: without_braces", "/fire");
        assert.strictEqual(result, null);
      });

      it("should return null for response with unknown action type", () => {
        const result = detectActions(
          "ACTION: unknown_action { foo: bar }",
          "/fire"
        );
        assert.strictEqual(result, null);
      });
    });

    describe("confirmation message in detected actions", () => {
      it("should include confirmation message for create_scenario", () => {
        const response =
          'ACTION: create_scenario { name: "FIRE Plan", retirementAge: 50, currentAge: 30, currentCorpus: 1000000 }';
        const result = detectActions(response, "/fire");
        assert.ok(result);
        assert.ok(result.confirmationMessage.includes("FIRE Plan"));
        assert.ok(result.confirmationMessage.includes("50"));
      });

      it("should include confirmation message for add_stock with buyDate", () => {
        const response =
          'ACTION: add_stock { symbol: TCS, quantity: 5, buyPrice: 3500, buyDate: "2024-01-15" }';
        const result = detectActions(response, "/holdings");
        assert.ok(result);
        assert.ok(result.confirmationMessage.includes("TCS"));
        assert.ok(result.confirmationMessage.includes("5"));
        assert.ok(result.confirmationMessage.includes("2024-01-15"));
      });

      it("should include confirmation message for delete_scenario with warning", () => {
        const response = 'ACTION: delete_scenario { name: "Old Plan" }';
        const result = detectActions(response, "/fire");
        assert.ok(result);
        assert.ok(result.confirmationMessage.includes("cannot be undone"));
      });
    });
  });

  // ───────────────────── validateActionParameters ─────────────────────

  describe("validateActionParameters", () => {
    describe("create_scenario validation", () => {
      it("should validate valid create_scenario params", () => {
        const result = validateActionParameters("create_scenario", {
          name: "Retirement Plan",
          retirementAge: 55,
          currentAge: 30,
          currentCorpus: 500000,
        });
        assert.strictEqual(result.valid, true);
      });

      it("should fail when required fields are missing", () => {
        const result = validateActionParameters("create_scenario", {
          name: "Plan",
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors);
        assert.ok(result.errors![0].includes("Missing required fields"));
      });

      it("should fail when retirementAge is less than 18", () => {
        const result = validateActionParameters("create_scenario", {
          name: "Plan",
          retirementAge: 15,
          currentAge: 25,
          currentCorpus: 100000,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.some((e) => e.includes("at least 18")));
      });

      it("should fail when currentAge is less than 18", () => {
        const result = validateActionParameters("create_scenario", {
          name: "Plan",
          retirementAge: 60,
          currentAge: 16,
          currentCorpus: 100000,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.some((e) => e.includes("Current age")));
      });

      it("should fail when retirementAge <= currentAge", () => {
        const result = validateActionParameters("create_scenario", {
          name: "Plan",
          retirementAge: 30,
          currentAge: 30,
          currentCorpus: 100000,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(
          result.errors!.some((e) =>
            e.includes("Retirement age must be greater")
          )
        );
      });

      it("should fail when currentCorpus is negative", () => {
        const result = validateActionParameters("create_scenario", {
          name: "Plan",
          retirementAge: 60,
          currentAge: 25,
          currentCorpus: -5000,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.some((e) => e.includes("cannot be negative")));
      });

      it("should allow zero currentCorpus", () => {
        const result = validateActionParameters("create_scenario", {
          name: "Plan",
          retirementAge: 60,
          currentAge: 25,
          currentCorpus: 0,
        });
        assert.strictEqual(result.valid, true);
      });

      it("should collect multiple errors", () => {
        const result = validateActionParameters("create_scenario", {
          name: "Plan",
          retirementAge: 15,
          currentAge: 10,
          currentCorpus: -1000,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.length >= 3);
      });
    });

    describe("add_stock validation", () => {
      it("should validate valid add_stock params", () => {
        const result = validateActionParameters("add_stock", {
          symbol: "RELIANCE",
          quantity: 10,
          buyPrice: 2500,
        });
        assert.strictEqual(result.valid, true);
      });

      it("should fail for missing required fields", () => {
        const result = validateActionParameters("add_stock", { symbol: "TCS" });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors![0].includes("Missing required fields"));
      });

      it("should fail for negative quantity", () => {
        const result = validateActionParameters("add_stock", {
          symbol: "TCS",
          quantity: -5,
          buyPrice: 3500,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.some((e) => e.includes("Quantity")));
      });

      it("should fail for zero quantity", () => {
        const result = validateActionParameters("add_stock", {
          symbol: "TCS",
          quantity: 0,
          buyPrice: 3500,
        });
        // quantity <= 0 check: 0 is falsy so the check won't trigger
        // This matches the source behavior where `if (params.quantity && ...)` is falsy for 0
        assert.strictEqual(result.valid, true);
      });

      it("should fail for negative buyPrice", () => {
        const result = validateActionParameters("add_stock", {
          symbol: "INFY",
          quantity: 10,
          buyPrice: -100,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.some((e) => e.includes("Buy price")));
      });

      it("should fail for lowercase symbol", () => {
        const result = validateActionParameters("add_stock", {
          symbol: "reliance",
          quantity: 10,
          buyPrice: 2500,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.some((e) => e.includes("uppercase letters")));
      });

      it("should fail for symbol with special characters", () => {
        const result = validateActionParameters("add_stock", {
          symbol: "REL-IANCE",
          quantity: 10,
          buyPrice: 2500,
        });
        assert.strictEqual(result.valid, false);
      });

      it("should pass for symbol with numbers", () => {
        const result = validateActionParameters("add_stock", {
          symbol: "M100",
          quantity: 5,
          buyPrice: 100,
        });
        assert.strictEqual(result.valid, true);
      });
    });

    describe("add_mutual_fund validation", () => {
      it("should validate valid mutual fund params", () => {
        const result = validateActionParameters("add_mutual_fund", {
          schemeName: "SBI Bluechip Fund",
          units: 100,
          nav: 55.5,
        });
        assert.strictEqual(result.valid, true);
      });

      it("should fail for negative units", () => {
        const result = validateActionParameters("add_mutual_fund", {
          schemeName: "SBI Bluechip",
          units: -10,
          nav: 55,
        });
        assert.strictEqual(result.valid, false);
      });

      it("should fail for negative NAV", () => {
        const result = validateActionParameters("add_mutual_fund", {
          schemeName: "SBI Bluechip",
          units: 100,
          nav: -5,
        });
        assert.strictEqual(result.valid, false);
      });
    });

    // SEBI compliance (MONEY-457): UseMoney is NOT a registered Research
    // Analyst, so save_analysis must NOT carry a BUY/HOLD/SELL verdict, a
    // target price, or a stop loss. Recommendation must be "N/A" (or absent).
    describe("save_analysis validation", () => {
      it("should validate save_analysis with recommendation 'N/A'", () => {
        const result = validateActionParameters("save_analysis", {
          symbol: "INFY",
          recommendation: "N/A",
        });
        assert.strictEqual(result.valid, true);
      });

      it("should validate save_analysis with lowercase 'n/a' (case-insensitive)", () => {
        const result = validateActionParameters("save_analysis", {
          symbol: "TCS",
          recommendation: "n/a",
        });
        assert.strictEqual(result.valid, true);
      });

      it("should REJECT a BUY recommendation (no SEBI verdicts)", () => {
        const result = validateActionParameters("save_analysis", {
          symbol: "INFY",
          recommendation: "BUY",
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.some((e) => e.includes('"N/A"')));
      });

      it("should REJECT HOLD and SELL recommendations", () => {
        for (const rec of ["HOLD", "SELL"]) {
          const result = validateActionParameters("save_analysis", {
            symbol: "TCS",
            recommendation: rec,
          });
          assert.strictEqual(result.valid, false, `${rec} must be rejected`);
        }
      });

      it("should REJECT any targetPrice (no price targets)", () => {
        const result = validateActionParameters("save_analysis", {
          symbol: "TCS",
          recommendation: "N/A",
          targetPrice: 1800,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.some((e) => e.includes("Target price")));
      });

      it("should REJECT any stopLoss (no stop-loss levels)", () => {
        const result = validateActionParameters("save_analysis", {
          symbol: "TCS",
          recommendation: "N/A",
          stopLoss: 1400,
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.errors!.some((e) => e.includes("Stop loss")));
      });
    });

    describe("modify_scenario validation", () => {
      it("should validate with only name", () => {
        const result = validateActionParameters("modify_scenario", {
          name: "My Plan",
        });
        assert.strictEqual(result.valid, true);
      });

      it("should fail when name is missing", () => {
        const result = validateActionParameters("modify_scenario", {
          retirementAge: 60,
        });
        assert.strictEqual(result.valid, false);
      });

      it("should validate retirementAge constraints on modify", () => {
        const result = validateActionParameters("modify_scenario", {
          name: "Plan",
          retirementAge: 15,
        });
        assert.strictEqual(result.valid, false);
      });
    });

    describe("delete_scenario validation", () => {
      it("should validate with name", () => {
        const result = validateActionParameters("delete_scenario", {
          name: "Old Plan",
        });
        assert.strictEqual(result.valid, true);
      });

      it("should fail without name", () => {
        const result = validateActionParameters("delete_scenario", {});
        assert.strictEqual(result.valid, false);
      });
    });

    describe("remove_holding validation", () => {
      it("should validate with symbol", () => {
        const result = validateActionParameters("remove_holding", {
          symbol: "TCS",
        });
        assert.strictEqual(result.valid, true);
      });

      it("should fail without symbol", () => {
        const result = validateActionParameters("remove_holding", {});
        assert.strictEqual(result.valid, false);
      });
    });
  });

  // ───────────────────── sanitizeActionParams ─────────────────────

  describe("sanitizeActionParams", () => {
    describe("string sanitization", () => {
      it("should remove script tags from string values", () => {
        const result = sanitizeActionParams({
          name: 'Test<script>alert("xss")</script>Name',
        });
        assert.strictEqual(result.name, "TestName");
      });

      it("should remove HTML tags from string values", () => {
        const result = sanitizeActionParams({
          name: "<b>Bold</b> Name",
        });
        assert.strictEqual(result.name, "Bold Name");
      });

      it("should remove nested script tags", () => {
        const result = sanitizeActionParams({
          name: '<script type="text/javascript">malicious()</script>Clean',
        });
        assert.strictEqual(result.name, "Clean");
      });

      it("should handle multiple HTML tags", () => {
        const result = sanitizeActionParams({
          name: "<div><span>Hello</span></div>",
        });
        assert.strictEqual(result.name, "Hello");
      });

      it("should trim whitespace from string values", () => {
        const result = sanitizeActionParams({
          name: "  Trimmed  ",
        });
        assert.strictEqual(result.name, "Trimmed");
      });

      it("should handle empty string", () => {
        const result = sanitizeActionParams({ name: "" });
        assert.strictEqual(result.name, "");
      });

      it("should remove script tag with content on multiple styles", () => {
        const result = sanitizeActionParams({
          name: "<SCRIPT>alert(1)</SCRIPT>Safe",
        });
        assert.strictEqual(result.name, "Safe");
      });

      it("should remove img tag with onerror XSS attempt", () => {
        const result = sanitizeActionParams({
          name: "<img src=x onerror=alert(1)>Clean",
        });
        assert.strictEqual(result.name, "Clean");
      });

      it("should handle script tags within larger text", () => {
        const result = sanitizeActionParams({
          description: "Before<script>document.cookie</script>After",
        });
        assert.strictEqual(result.description, "BeforeAfter");
      });
    });

    describe("number sanitization", () => {
      it("should keep valid numbers unchanged", () => {
        const result = sanitizeActionParams({ quantity: 10 });
        assert.strictEqual(result.quantity, 10);
      });

      it("should keep zero unchanged", () => {
        const result = sanitizeActionParams({ quantity: 0 });
        assert.strictEqual(result.quantity, 0);
      });

      it("should keep negative numbers unchanged", () => {
        const result = sanitizeActionParams({ value: -5 });
        assert.strictEqual(result.value, -5);
      });

      it("should replace NaN with 0", () => {
        const result = sanitizeActionParams({ value: NaN });
        assert.strictEqual(result.value, 0);
      });

      it("should keep float numbers unchanged", () => {
        const result = sanitizeActionParams({ price: 55.25 });
        assert.strictEqual(result.price, 55.25);
      });
    });

    describe("array sanitization", () => {
      it("should sanitize string elements in arrays", () => {
        const result = sanitizeActionParams({
          tags: ["<script>x</script>Clean", "Normal"],
        });
        assert.deepStrictEqual(result.tags, ["Clean", "Normal"]);
      });

      it("should keep non-string array elements unchanged", () => {
        const result = sanitizeActionParams({
          values: [1, 2, 3],
        });
        assert.deepStrictEqual(result.values, [1, 2, 3]);
      });

      it("should handle mixed array types", () => {
        // Array sanitization only removes script tags from strings, not all HTML
        const result = sanitizeActionParams({
          items: ["<script>x</script>text", 42, "normal"],
        });
        assert.deepStrictEqual(result.items, ["text", 42, "normal"]);
      });

      it("should handle empty array", () => {
        const result = sanitizeActionParams({ items: [] });
        assert.deepStrictEqual(result.items, []);
      });
    });

    describe("other types", () => {
      it("should pass through boolean values unchanged", () => {
        const result = sanitizeActionParams({ active: true });
        assert.strictEqual(result.active, true);
      });

      it("should pass through null values unchanged", () => {
        const result = sanitizeActionParams({ value: null });
        assert.strictEqual(result.value, null);
      });

      it("should pass through object values unchanged", () => {
        const nested = { inner: "value" };
        const result = sanitizeActionParams({ obj: nested });
        assert.deepStrictEqual(result.obj, nested);
      });
    });

    describe("empty and edge cases", () => {
      it("should handle empty params object", () => {
        const result = sanitizeActionParams({});
        assert.deepStrictEqual(result, {});
      });

      it("should handle params with many keys", () => {
        const result = sanitizeActionParams({
          name: "<b>Test</b>",
          symbol: "<i>TCS</i>",
          quantity: 10,
          active: true,
        });
        assert.strictEqual(result.name, "Test");
        assert.strictEqual(result.symbol, "TCS");
        assert.strictEqual(result.quantity, 10);
        assert.strictEqual(result.active, true);
      });
    });
  });

  // ───────────────────── removeActionMarkers ─────────────────────

  describe("removeActionMarkers", () => {
    it("should remove a single action marker", () => {
      const input =
        'Here is your analysis. ACTION: save_analysis { symbol: "TCS", recommendation: "BUY" }';
      const result = removeActionMarkers(input);
      assert.strictEqual(result, "Here is your analysis.");
    });

    it("should remove action marker from the beginning", () => {
      const input =
        'ACTION: add_stock { symbol: "RELIANCE", quantity: 10, buyPrice: 2500 } Done!';
      const result = removeActionMarkers(input);
      assert.strictEqual(result, "Done!");
    });

    it("should remove action marker from the middle", () => {
      const input = 'Before ACTION: delete_scenario { name: "Plan" } After';
      const result = removeActionMarkers(input);
      assert.strictEqual(result, "Before  After");
    });

    it("should handle response with no action markers", () => {
      const input = "Just a normal response about stocks.";
      const result = removeActionMarkers(input);
      assert.strictEqual(result, input);
    });

    it("should handle empty string", () => {
      const result = removeActionMarkers("");
      assert.strictEqual(result, "");
    });

    it("should handle case-insensitive action markers", () => {
      const input =
        'action: add_stock { symbol: "TCS", quantity: 5, buyPrice: 3000 }';
      const result = removeActionMarkers(input);
      assert.strictEqual(result, "");
    });

    it("should remove multiple action markers", () => {
      const input =
        'First ACTION: add_stock { symbol: "A", quantity: 1, buyPrice: 100 } Middle ACTION: remove_holding { symbol: "B" } End';
      const result = removeActionMarkers(input);
      assert.strictEqual(result, "First  Middle  End");
    });

    it("should trim resulting whitespace", () => {
      const input =
        '   ACTION: add_stock { symbol: "TCS", quantity: 5, buyPrice: 3000 }   ';
      const result = removeActionMarkers(input);
      assert.strictEqual(result, "");
    });

    it("should also strip TOOL_CALL markers (real source behaviour)", () => {
      // The real removeActionMarkers strips both ACTION:{…} and TOOL_CALL:{…}.
      const input =
        'Here is the data. TOOL_CALL: {"tool": "get_holdings", "params": {}}';
      const result = removeActionMarkers(input);
      assert.strictEqual(result, "Here is the data.");
      assert.ok(!result.includes("TOOL_CALL"));
    });

    it("should strip a multiline TOOL_CALL block", () => {
      const input =
        'Analysis follows.\nTOOL_CALL: {\n  "tool": "run_screener",\n  "params": { "strategy": "garp" }\n}';
      const result = removeActionMarkers(input);
      assert.ok(!result.includes("TOOL_CALL"));
      assert.ok(result.includes("Analysis follows."));
    });
  });

  // ───────────────────── pageSupportsActions ─────────────────────

  describe("pageSupportsActions", () => {
    it("should return true for /fire", () => {
      assert.strictEqual(pageSupportsActions("/fire"), true);
    });

    it("should return true for /holdings", () => {
      assert.strictEqual(pageSupportsActions("/holdings"), true);
    });

    it("should return true for /analysis", () => {
      assert.strictEqual(pageSupportsActions("/analysis"), true);
    });

    it("should return false for /dashboard", () => {
      assert.strictEqual(pageSupportsActions("/dashboard"), false);
    });

    it("should return false for /settings", () => {
      assert.strictEqual(pageSupportsActions("/settings"), false);
    });

    it("should return false for /positions", () => {
      assert.strictEqual(pageSupportsActions("/positions"), false);
    });

    it("should return false for /tradebook", () => {
      assert.strictEqual(pageSupportsActions("/tradebook"), false);
    });

    it("should return false for empty string", () => {
      assert.strictEqual(pageSupportsActions(""), false);
    });

    it("should return false for root path", () => {
      assert.strictEqual(pageSupportsActions("/"), false);
    });

    it("should return false for subpath of supported page", () => {
      assert.strictEqual(pageSupportsActions("/fire/scenarios"), false);
    });

    it("should return false for path with different casing", () => {
      assert.strictEqual(pageSupportsActions("/FIRE"), false);
    });
  });

  // ───────────────────── parseActionParameters ─────────────────────

  describe("parseActionParameters", () => {
    it("should parse simple key-value pairs", () => {
      const result = parseActionParameters('name: "Test", quantity: 10');
      assert.strictEqual(result.name, "Test");
      assert.strictEqual(result.quantity, 10);
    });

    it("should parse numeric values", () => {
      const result = parseActionParameters("retirementAge: 55, currentAge: 30");
      assert.strictEqual(result.retirementAge, 55);
      assert.strictEqual(result.currentAge, 30);
    });

    it("should parse boolean values", () => {
      const result = parseActionParameters("active: true, disabled: false");
      assert.strictEqual(result.active, true);
      assert.strictEqual(result.disabled, false);
    });

    it("should parse floating point values", () => {
      const result = parseActionParameters("nav: 55.25, units: 100.5");
      assert.strictEqual(result.nav, 55.25);
      assert.strictEqual(result.units, 100.5);
    });

    it("should throw for completely invalid input", () => {
      assert.throws(() => {
        parseActionParameters("{{invalid}}");
      }, /Invalid action parameters/);
    });

    it("should parse string values with spaces", () => {
      const result = parseActionParameters('schemeName: "SBI Bluechip Fund"');
      assert.strictEqual(result.schemeName, "SBI Bluechip Fund");
    });
  });

  // ───────────────────── generateConfirmationMessage ─────────────────────

  describe("generateConfirmationMessage", () => {
    it("should generate message for create_scenario", () => {
      const msg = generateConfirmationMessage("create_scenario", {
        name: "Early Retirement",
        retirementAge: 50,
      });
      assert.ok(msg.includes("Early Retirement"));
      assert.ok(msg.includes("50"));
      assert.ok(msg.includes("Create new FIRE scenario"));
    });

    it("should generate message for modify_scenario", () => {
      const msg = generateConfirmationMessage("modify_scenario", {
        name: "My Plan",
      });
      assert.ok(msg.includes("My Plan"));
      assert.ok(msg.includes("Modify"));
    });

    it("should generate message for delete_scenario with warning", () => {
      const msg = generateConfirmationMessage("delete_scenario", {
        name: "Old Plan",
      });
      assert.ok(msg.includes("Old Plan"));
      assert.ok(msg.includes("cannot be undone"));
    });

    it("should generate message for add_stock without buyDate", () => {
      const msg = generateConfirmationMessage("add_stock", {
        symbol: "TCS",
        quantity: 10,
        buyPrice: 3500,
      });
      assert.ok(msg.includes("10"));
      assert.ok(msg.includes("TCS"));
      assert.ok(msg.includes("3500"));
      assert.ok(!msg.includes("purchased on"));
    });

    it("should generate message for add_stock with buyDate", () => {
      const msg = generateConfirmationMessage("add_stock", {
        symbol: "RELIANCE",
        quantity: 5,
        buyPrice: 2500,
        buyDate: "2024-01-15",
      });
      assert.ok(msg.includes("2024-01-15"));
      assert.ok(msg.includes("purchased on"));
    });

    it("should generate message for add_mutual_fund without purchaseDate", () => {
      const msg = generateConfirmationMessage("add_mutual_fund", {
        schemeName: "SBI Bluechip",
        units: 100,
        nav: 55.5,
      });
      assert.ok(msg.includes("SBI Bluechip"));
      assert.ok(msg.includes("100"));
      assert.ok(!msg.includes("purchased on"));
    });

    it("should generate message for add_mutual_fund with purchaseDate", () => {
      const msg = generateConfirmationMessage("add_mutual_fund", {
        schemeName: "UTI Nifty",
        units: 50,
        nav: 120,
        purchaseDate: "2023-06-01",
      });
      assert.ok(msg.includes("2023-06-01"));
    });

    it("should generate message for remove_holding", () => {
      const msg = generateConfirmationMessage("remove_holding", {
        symbol: "WIPRO",
      });
      assert.ok(msg.includes("WIPRO"));
      assert.ok(msg.includes("delete the position"));
    });

    it("should generate a verdict-free message for save_analysis (SEBI)", () => {
      // MONEY-457: the confirmation copy must NOT echo the recommendation or a
      // price target — it is just "Save analysis for {symbol}?".
      const msg = generateConfirmationMessage("save_analysis", {
        symbol: "INFY",
        recommendation: "N/A",
      });
      assert.strictEqual(msg, "Save analysis for INFY?");
      assert.ok(!msg.includes("BUY"));
      assert.ok(!msg.includes("target price"));
    });

    it("should ignore targetPrice in save_analysis confirmation copy", () => {
      const msg = generateConfirmationMessage("save_analysis", {
        symbol: "INFY",
        recommendation: "N/A",
        targetPrice: 1800,
      });
      assert.strictEqual(msg, "Save analysis for INFY?");
      assert.ok(!msg.includes("target price"));
      assert.ok(!msg.includes("1800"));
    });
  });
});
