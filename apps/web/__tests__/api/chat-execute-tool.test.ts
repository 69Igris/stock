/**
 * Chat execute-tool route CONTRACT test.
 *
 * Exercises the REAL exported symbols the POST /api/chat/execute-tool handler
 * calls (from `@/app/api/chat/execute-tool/route-logic`):
 *   - `validateExecuteToolRequest` — the `tool` + `actionId` required gate.
 *   - `isValidConfirmActionId` — the confirm-UUID format gate that rejects
 *     replayed client strings; cross-checked against the chat route's real
 *     `confirm-${randomUUID()}` minter.
 *   - `POLLED_TOOLS` / `WRITE_CONFIRM_TOOLS` / `shouldRenderResultBlocks` — the
 *     server-side terminal-block rendering decision (MONEY-587).
 *
 * The route can't be imported directly (it pulls the chat-tools registry →
 * server-only `react.cache`), so tool existence / confirmation / category stay
 * the registry's job and are NOT mirrored here (that would be a fresh shadow).
 *
 * (Replaces the previous shadow version, which reimplemented a fake
 * TOOL_REGISTRY plus `getTool` / `validateRequestBody` / `validateToolExists`
 * / `validateRequiredParams` / `formatToolResult` / `sanitizeParams` inline and
 * asserted the copies.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";

import {
  validateExecuteToolRequest,
  isValidConfirmActionId,
  POLLED_TOOLS,
  WRITE_CONFIRM_TOOLS,
  shouldRenderResultBlocks,
} from "@/app/api/chat/execute-tool/route-logic";

describe("Chat execute-tool route", () => {
  describe("validateExecuteToolRequest", () => {
    it("passes with both tool and actionId", () => {
      const result = validateExecuteToolRequest({
        tool: "get_holdings",
        actionId: "confirm-123",
      });
      assert.strictEqual(result.valid, true);
    });

    it("fails when tool is missing", () => {
      const result = validateExecuteToolRequest({ actionId: "confirm-123" });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "tool and actionId are required");
    });

    it("fails when actionId is missing", () => {
      const result = validateExecuteToolRequest({ tool: "get_holdings" });
      assert.strictEqual(result.valid, false);
    });

    it("fails when both are missing", () => {
      const result = validateExecuteToolRequest({});
      assert.strictEqual(result.valid, false);
    });

    it("fails when tool is an empty string", () => {
      const result = validateExecuteToolRequest({
        tool: "",
        actionId: "confirm-123",
      });
      assert.strictEqual(result.valid, false);
    });

    it("fails when actionId is an empty string", () => {
      const result = validateExecuteToolRequest({
        tool: "get_holdings",
        actionId: "",
      });
      assert.strictEqual(result.valid, false);
    });
  });

  describe("isValidConfirmActionId", () => {
    it("accepts a real confirm-UUID minted like the chat route", () => {
      // The chat route mints `confirm-${randomUUID()}` (app/api/chat/route.ts).
      const actionId = `confirm-${randomUUID()}`;
      assert.strictEqual(isValidConfirmActionId(actionId), true);
      // Pin the cross-route length contract: confirm- (8) + uuid (36) = 44.
      assert.strictEqual(actionId.length, 44);
    });

    it("rejects an id without the confirm- prefix", () => {
      assert.strictEqual(isValidConfirmActionId(randomUUID()), false);
    });

    it("rejects a too-short confirm- id (< 40 chars)", () => {
      assert.strictEqual(isValidConfirmActionId("confirm-short"), false);
    });

    it("rejects a non-string actionId", () => {
      assert.strictEqual(isValidConfirmActionId(12345), false);
      assert.strictEqual(isValidConfirmActionId(undefined), false);
      assert.strictEqual(isValidConfirmActionId(null), false);
    });

    it("rejects an empty string", () => {
      assert.strictEqual(isValidConfirmActionId(""), false);
    });

    it("accepts a confirm- id padded to exactly 40 chars (boundary)", () => {
      const actionId = "confirm-" + "x".repeat(32); // 8 + 32 = 40
      assert.strictEqual(actionId.length, 40);
      assert.strictEqual(isValidConfirmActionId(actionId), true);
    });

    it("rejects a confirm- id of 39 chars (just under boundary)", () => {
      const actionId = "confirm-" + "x".repeat(31); // 8 + 31 = 39
      assert.strictEqual(actionId.length, 39);
      assert.strictEqual(isValidConfirmActionId(actionId), false);
    });
  });

  describe("POLLED_TOOLS / WRITE_CONFIRM_TOOLS sets", () => {
    it("classifies async/polled tools", () => {
      for (const name of [
        "run_research",
        "start_roast",
        "run_comprehensive_analysis",
        "run_strategy_scan",
      ]) {
        assert.ok(POLLED_TOOLS.has(name), `${name} should be polled`);
      }
    });

    it("classifies write/confirm tools", () => {
      for (const name of [
        "buy_paper_position",
        "sell_paper_position",
        "create_fire_scenario",
        "create_strategy",
        "generate_report",
      ]) {
        assert.ok(WRITE_CONFIRM_TOOLS.has(name), `${name} should be write`);
      }
    });

    it("does not treat a read tool as polled or write-confirm", () => {
      assert.strictEqual(POLLED_TOOLS.has("get_holdings"), false);
      assert.strictEqual(WRITE_CONFIRM_TOOLS.has("get_holdings"), false);
    });
  });

  describe("shouldRenderResultBlocks", () => {
    it("renders blocks for a successful non-polled tool", () => {
      assert.strictEqual(shouldRenderResultBlocks("run_screener", true), true);
    });

    it("does not render blocks for a failed tool", () => {
      assert.strictEqual(
        shouldRenderResultBlocks("run_screener", false),
        false
      );
    });

    it("does not render terminal blocks for a polled tool (it's async)", () => {
      assert.strictEqual(shouldRenderResultBlocks("run_research", true), false);
      assert.strictEqual(shouldRenderResultBlocks("start_roast", true), false);
    });
  });
});
