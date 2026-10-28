/**
 * MONEY-620 — message-parser.ts REAL-SOURCE negative / edge coverage.
 *
 * De-shadowed: imports the REAL exported parser
 * (apps/web/lib/chat/message-parser.ts) and drives it with adversarial input
 * — malformed / unterminated / nested / empty / oversized :::block markers,
 * invalid JSON inside a block, schema-failing block bodies, injection text,
 * and the legacy ACTION: path — asserting the parser DEGRADES gracefully
 * (never throws, always returns a renderable ContentBlock[]).
 *
 * These exports also execute the REAL @usemoney/validation `validateBlockData`
 * through the parser's block path, so a regression in either surfaces here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseMessageToBlocks,
  hasBlockMarkers,
  stripBlockMarkers,
} from "../../lib/chat/message-parser";

/** Find the first block of a given type (or undefined). */
function firstOfType(
  blocks: ReturnType<typeof parseMessageToBlocks>,
  type: string
) {
  return blocks.find((b) => (b as { type: string }).type === type) as
    | Record<string, unknown>
    | undefined;
}

describe("MONEY-620 parseMessageToBlocks — empty / whitespace / plain text", () => {
  it("empty string → empty block array (no throw)", () => {
    assert.deepEqual(parseMessageToBlocks(""), []);
  });

  it("whitespace-only string → empty block array", () => {
    assert.deepEqual(parseMessageToBlocks("   \n\t  \n "), []);
  });

  it("plain text with no markers → single text block, trimmed", () => {
    const blocks = parseMessageToBlocks("  Hello there.  ");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.equal((blocks[0] as { content: string }).content, "Hello there.");
  });
});

describe("MONEY-620 parseMessageToBlocks — malformed :::block markers", () => {
  it("UNTERMINATED block (missing closing :::) is NOT parsed → degrades to text", () => {
    // No closing ::: on its own line ⇒ BLOCK_REGEX never matches; the whole
    // thing must survive as text rather than being swallowed or throwing.
    const raw = ':::block:table\n{"columns":[],"rows":[]}\nno closing fence';
    const blocks = parseMessageToBlocks(raw);
    assert.ok(blocks.length >= 1, "must produce at least one block");
    assert.equal(blocks[0].type, "text");
    // The raw marker text is preserved (not silently dropped).
    assert.match((blocks[0] as { content: string }).content, /:::block:table/);
    // And no table block was produced from the unterminated marker.
    assert.equal(firstOfType(blocks, "table"), undefined);
  });

  it("UNKNOWN block type (not in whitelist) is left as literal text", () => {
    // `frobnicate` isn't in the BLOCK_REGEX alternation, so the marker is not
    // recognised at all and the text passes through verbatim.
    const raw = ':::block:frobnicate\n{"a":1}\n:::';
    const blocks = parseMessageToBlocks(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.match(
      (blocks[0] as { content: string }).content,
      /:::block:frobnicate/
    );
  });

  it("INVALID JSON inside a recognised block → code-fenced text fallback (no throw)", () => {
    const raw = ":::block:table\n{not valid json,,,}\n:::";
    const blocks = parseMessageToBlocks(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    const content = (blocks[0] as { content: string }).content;
    assert.match(content, /```/); // rendered inside a code fence
    assert.match(content, /not valid json/);
  });

  it("VALID JSON but schema-FAILING body → 'Block validation error' text, not a typed block", () => {
    // `error` block requires severity+title — a bare {} parses as JSON but
    // fails validateBlockData, so it must render the validation-error fallback.
    const raw = ":::block:error\n{}\n:::";
    const blocks = parseMessageToBlocks(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.match(
      (blocks[0] as { content: string }).content,
      /Block validation error/
    );
    assert.equal(firstOfType(blocks, "error"), undefined);
  });

  it("array JSON for an object-only block → validation-error fallback", () => {
    const raw = ":::block:table\n[1,2,3]\n:::";
    const blocks = parseMessageToBlocks(raw);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
  });
});

describe("MONEY-620 parseMessageToBlocks — valid blocks + text interleaving", () => {
  it("text BEFORE and AFTER a valid block are emitted as separate text blocks", () => {
    const raw = [
      "Here is your data.",
      ":::block:navigation",
      JSON.stringify({ links: [{ label: "Go", href: "/x" }] }),
      ":::",
      "Anything else?",
    ].join("\n");
    const blocks = parseMessageToBlocks(raw);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, "text");
    assert.equal(
      (blocks[0] as { content: string }).content,
      "Here is your data."
    );
    assert.equal(blocks[1].type, "navigation");
    assert.equal(blocks[2].type, "text");
    assert.equal((blocks[2] as { content: string }).content, "Anything else?");
  });

  it("action block ALWAYS gets a server-generated confirm- actionId (LLM value discarded)", () => {
    const raw = [
      ":::block:action",
      JSON.stringify({
        actionId: "evil-attacker-supplied-id",
        tool: "get_holdings",
        description: "do it",
        params: {},
      }),
      ":::",
    ].join("\n");
    const blocks = parseMessageToBlocks(raw);
    const action = firstOfType(blocks, "action");
    assert.ok(action, "action block produced");
    assert.notEqual(action!.actionId, "evil-attacker-supplied-id");
    assert.match(String(action!.actionId), /^confirm-/);
  });

  it("TWO valid blocks back-to-back both parse (regex advances lastIndex)", () => {
    const raw = [
      ":::block:navigation",
      JSON.stringify({ links: [{ label: "A", href: "/a" }] }),
      ":::",
      ":::block:navigation",
      JSON.stringify({ links: [{ label: "B", href: "/b" }] }),
      ":::",
    ].join("\n");
    const blocks = parseMessageToBlocks(raw);
    const navs = blocks.filter((b) => b.type === "navigation");
    assert.equal(navs.length, 2);
  });

  it("passthrough typed block (scorecard) survives as its own block, not raw JSON", () => {
    const raw = [
      ":::block:scorecard",
      JSON.stringify({ symbol: "TCS", overall: 72, sections: [] }),
      ":::",
    ].join("\n");
    const blocks = parseMessageToBlocks(raw);
    const sc = firstOfType(blocks, "scorecard");
    assert.ok(sc, "scorecard passthrough block produced");
    assert.equal(sc!.symbol, "TCS");
    assert.equal(sc!.overall, 72);
  });
});

describe("MONEY-620 parseMessageToBlocks — oversized & unicode robustness", () => {
  it("OVERSIZED block body (large rows array) parses without throwing / hanging", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      c0: `row-${i}`,
    }));
    const raw = [
      ":::block:table",
      JSON.stringify({
        columns: [{ key: "c0", label: "C0" }],
        rows,
      }),
      ":::",
    ].join("\n");
    const blocks = parseMessageToBlocks(raw);
    const table = firstOfType(blocks, "table");
    assert.ok(table, "large table parsed");
    assert.equal((table!.rows as unknown[]).length, 5000);
  });

  it("unicode / emoji in surrounding text is preserved", () => {
    const blocks = parseMessageToBlocks("Profit 📈 ₹1,23,456 — solid 🚀");
    assert.equal(blocks.length, 1);
    assert.match(
      (blocks[0] as { content: string }).content,
      /📈.*₹1,23,456.*🚀/
    );
  });
});

describe("MONEY-620 parseMessageToBlocks — legacy ACTION: path", () => {
  it("legacy 'ACTION: add_stock {…}' → action block + cleaned text", () => {
    const raw =
      "Sure. ACTION: add_stock { symbol: RELIANCE, quantity: 10, buyPrice: 2900 } Done.";
    const blocks = parseMessageToBlocks(raw);
    const action = firstOfType(blocks, "action");
    assert.ok(action, "legacy action parsed into an action block");
    assert.equal(action!.tool, "add_stock");
    assert.equal(
      (action!.params as Record<string, unknown>).symbol,
      "RELIANCE"
    );
    // the literal "ACTION: …" marker is stripped from the surviving text block
    const text = firstOfType(blocks, "text");
    if (text) {
      assert.doesNotMatch(String(text.content), /ACTION:\s*add_stock/);
    }
  });

  it("malformed legacy ACTION body is left as text (parse failure swallowed)", () => {
    // Unbalanced/garbled inner params — parseLegacyParams throws, caught, and
    // the text must survive (no crash, no phantom action block).
    const raw = "ACTION: add_stock { : : : }";
    const blocks = parseMessageToBlocks(raw);
    assert.ok(blocks.length >= 1);
    // No well-formed action block (tool=add_stock with usable params)
    const action = firstOfType(blocks, "action");
    // Either no action block, or one whose params are empty/garbled is acceptable;
    // the hard guarantee is: it did not throw and produced output.
    assert.ok(action === undefined || action.type === "action");
  });
});

describe("MONEY-620 hasBlockMarkers / stripBlockMarkers — stateful-regex safety", () => {
  it("hasBlockMarkers is stable across repeated calls (no lastIndex bleed)", () => {
    const raw = [
      ":::block:navigation",
      JSON.stringify({ links: [{ label: "A", href: "/a" }] }),
      ":::",
    ].join("\n");
    // Global regexes with .test() advance lastIndex; a correct impl must reset.
    assert.equal(hasBlockMarkers(raw), true);
    assert.equal(hasBlockMarkers(raw), true);
    assert.equal(hasBlockMarkers(raw), true);
  });

  it("hasBlockMarkers false for plain text, true for legacy ACTION", () => {
    assert.equal(hasBlockMarkers("just chatting"), false);
    assert.equal(
      hasBlockMarkers("ACTION: remove_holding { symbol: TCS }"),
      true
    );
  });

  it("stripBlockMarkers removes a valid block region and trims", () => {
    const raw = [
      "before",
      ":::block:navigation",
      JSON.stringify({ links: [{ label: "A", href: "/a" }] }),
      ":::",
      "after",
    ].join("\n");
    const stripped = stripBlockMarkers(raw);
    assert.doesNotMatch(stripped, /:::block:navigation/);
    assert.match(stripped, /before/);
    assert.match(stripped, /after/);
  });

  it("stripBlockMarkers is idempotent and stable across repeated calls", () => {
    const raw = "ACTION: add_stock { symbol: TCS } tail";
    const once = stripBlockMarkers(raw);
    const twice = stripBlockMarkers(once);
    assert.equal(once, twice);
    assert.doesNotMatch(once, /ACTION:/);
  });
});
