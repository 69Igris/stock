/**
 * Tests for typed-block emission (MONEY-587, StockSage design).
 *
 * The LLM must be able to emit the rich typed blocks via :::block:TYPE markers:
 *   - validateBlockData passes the typed blocks through (renderers are defensive)
 *   - the message parser's BLOCK_REGEX whitelist includes them
 *   - genuinely unknown block types still fall back to text (safe).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateBlockData } from "@usemoney/validation";
import { parseMessageToBlocks } from "../../lib/chat/message-parser";

const TYPED = [
  "holdings",
  "portfolio",
  "tax",
  "risk",
  "mf",
  "fire",
  "sector",
  "technical",
  "scorecard",
  "pnl",
  "dividend",
  "stock-list",
];

describe("validateBlockData: typed-block passthrough", () => {
  it("passes through every known typed block (object payload)", () => {
    for (const t of TYPED) {
      assert.equal(validateBlockData(t, { x: 1 }).success, true, `${t}`);
    }
  });

  it("rejects a non-object typed block + a truly unknown type", () => {
    assert.equal(validateBlockData("portfolio", "nope").success, false);
    assert.equal(validateBlockData("portfolio", [1, 2]).success, false);
    assert.equal(validateBlockData("totally_made_up", {}).success, false);
  });

  it("still strictly validates the schema-backed blocks", () => {
    // error block needs severity+title — a bare object should fail.
    assert.equal(validateBlockData("error", {}).success, false);
  });
});

describe("parseMessageToBlocks: typed blocks from :::block markers", () => {
  it("a :::block:portfolio marker becomes a portfolio block (not raw JSON)", () => {
    const raw = 'Here:\n:::block:portfolio\n{"totalValue":100}\n:::\nDone.';
    const blocks = parseMessageToBlocks(raw);
    const portfolio = blocks.find((b) => b.type === "portfolio") as
      | Record<string, unknown>
      | undefined;
    assert.ok(portfolio, `types: ${blocks.map((b) => b.type).join(",")}`);
    assert.equal(portfolio!.totalValue, 100);
  });

  it("a :::block:tax marker becomes a tax block", () => {
    const blocks = parseMessageToBlocks(':::block:tax\n{"stcg":5000}\n:::');
    assert.ok(blocks.some((b) => b.type === "tax"));
  });

  it("an unknown block type falls back to text (never an invalid block)", () => {
    const blocks = parseMessageToBlocks(':::block:bogus\n{"x":1}\n:::');
    // `bogus` is not in the ContentBlockType union, so compare the runtime
    // string: assert no emitted block claims the unknown type (it must have
    // fallen back to a text block instead).
    assert.ok(blocks.every((b) => (b.type as string) !== "bogus"));
  });
});
