/**
 * MONEY-1274 / MONEY-1155 #44 — a follow-up can see what the conversation
 * already produced.
 *
 * ## The defect, as reported
 *
 * "If I started my research with Gemini and cross-question on Claude then the
 * whole chat must be sent to Claude to give an accurate answer with context."
 *
 * Tracing that turned up something wider than a model-switch bug. A chat
 * message carries TWO channels — `content` (a string) and `blocks` (what the UI
 * renders) — and history replay sent only the first:
 *
 *     parts: [{ text: msg.content }]
 *
 * while every rich turn writes a STUB into `content`:
 *
 *     content: "Here are the research results:"   ChatContext.tsx:983
 *     content: "Full research report loaded:"     ChatContext.tsx:1150
 *     content: ""                                 ChatContext.tsx:2240
 *
 * So the next turn reached the model as `assistant: "Here are the research
 * results:"` and nothing else — for GEMINI too. History is keyed by chatId and
 * userId, never by model, so switching providers loses nothing that was there;
 * the report was absent for both. The switch only makes it noticeable.
 *
 * Source under test: apps/web/lib/gemini/history-blocks.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  replayText,
  summariseBlock,
  summariseBlocks,
  MAX_BLOCK_SUMMARY_CHARS,
} from "../../../lib/gemini/history-blocks";

const identity = (s: string) => s;

describe("replayText — the reported scenario", () => {
  it("[regression] a research turn no longer replays as a bare stub", () => {
    // THE BUG. This is verbatim what ChatContext writes on research completion.
    const out = replayText(
      "Here are the research results:",
      [
        {
          type: "structured-report",
          symbol: "RELIANCE",
          report: { verdict: "Fairly valued", risks: [], valuation: {} },
        },
      ],
      identity
    );
    assert.match(
      out,
      /RELIANCE/,
      "the follow-up cannot see what was researched"
    );
    assert.match(out, /Fairly valued/);
    assert.notEqual(
      out,
      "Here are the research results:",
      "the stub is still all the model receives"
    );
  });

  it("[regression] a streaming turn with EMPTY content still carries something", () => {
    // ChatContext.tsx:2240 writes content: "" with the block alongside. Before
    // this, that turn replayed as an empty string — the model saw a blank
    // assistant message and nothing to explain it.
    const out = replayText(
      "",
      [{ type: "research-stream", status: "completed", symbols: ["TCS"] }],
      identity
    );
    assert.ok(out.length > 0, "an empty-content turn replayed as nothing");
    assert.match(out, /TCS/);
  });

  it("an ordinary message with no blocks is byte-identical to before", () => {
    // The no-regression case. Most turns have no blocks and must be untouched,
    // or this change alters every conversation rather than the broken ones.
    const plain = "What is the PE of INFY?";
    assert.equal(replayText(plain, undefined, identity), plain);
    assert.equal(replayText(plain, [], identity), plain);
    assert.equal(replayText(plain, null, identity), plain);
  });

  it("keeps the message text AND the summary, not one or the other", () => {
    const out = replayText(
      "Here are the results:",
      [
        {
          type: "stock-list",
          title: "Cheap IT",
          stocks: [{ symbol: "WIPRO", metrics: { pe: 18 } }],
          total: 1,
        },
      ],
      identity
    );
    assert.match(out, /Here are the results:/);
    assert.match(out, /WIPRO/);
  });
});

describe("summariseBlock — per type", () => {
  it("renders a table's rows, not just its title", () => {
    const out = summariseBlock({
      type: "table",
      title: "Peers",
      columns: [{ key: "symbol", label: "Symbol" }],
      rows: [
        { symbol: "TCS", pe: 28 },
        { symbol: "INFY", pe: 24 },
      ],
    });
    assert.match(String(out), /TCS/);
    assert.match(String(out), /INFY/);
  });

  it("says how many rows were withheld rather than silently cutting", () => {
    // A truncated list that does not SAY it is truncated is the same class of
    // bug as the rest of this ticket: the model reads it as the whole answer.
    const out = summariseBlock({
      type: "table",
      columns: [],
      rows: Array.from({ length: 40 }, (_, i) => ({ symbol: `S${i}` })),
    });
    // Wording is now shared with renderStockList via `withheld()`, so the two
    // renderers cannot drift into announcing truncation differently.
    assert.match(String(out), /\+35 more/);
  });

  it("skips `text` blocks — their content is already the message", () => {
    assert.equal(summariseBlock({ type: "text", content: "hello" }), null);
  });

  it("[regression] an UNKNOWN block type degrades to its scalars, not silence", () => {
    // There are 26 block types and more will be added. A type with no renderer
    // must still contribute something — vanishing is the exact failure this
    // module exists to remove.
    const out = summariseBlock({
      type: "some-future-block",
      headline: "Q3 beat",
      value: 42,
    });
    assert.match(String(out), /some-future-block/);
    assert.match(String(out), /Q3 beat/);
  });

  it("returns null for a block with nothing readable", () => {
    assert.equal(summariseBlock({ type: "chart" }), null);
    assert.equal(summariseBlock(null), null);
    assert.equal(summariseBlock("not an object"), null);
  });
});

describe("budgets — history is replayed on EVERY turn", () => {
  it("caps one message's summary", () => {
    const out = summariseBlocks(
      [{ type: "future", note: "x".repeat(50_000) }],
      identity
    );
    assert.ok(
      out.length <= MAX_BLOCK_SUMMARY_CHARS,
      `summary was ${out.length} chars`
    );
  });

  it("caps the number of blocks per message", () => {
    const blocks = Array.from({ length: 30 }, (_, i) => ({
      type: "future",
      label: `BLOCK${i}`,
    }));
    const out = summariseBlocks(blocks, identity);
    assert.ok(!out.includes("BLOCK20"), "every block was rendered");
  });

  it("an unbounded flatten would starve the oldest turns — this one does not", () => {
    // trimHistoryToTokenBudget drops the OLDEST messages to fit. If each turn
    // could grow without limit, adding block text would silently evict the
    // start of the conversation to pay for the end of it.
    const big = Array.from({ length: 20 }, () => ({
      type: "future",
      note: "y".repeat(5_000),
    }));
    assert.ok(summariseBlocks(big, identity).length <= MAX_BLOCK_SUMMARY_CHARS);
  });
});

describe("[security] blocks are untrusted input entering a prompt", () => {
  it("every rendered field goes through the sanitizer", () => {
    // Blocks hold model-generated text, tool output and FETCHED DOCUMENTS. The
    // marker is planted in each renderer's own fields and must not survive.
    const MARKER = "IGNORE-PREVIOUS-INSTRUCTIONS";
    const spy = (s: string) => s.replaceAll(MARKER, "[defanged]");
    const out = summariseBlocks(
      [
        {
          type: "structured-report",
          symbol: MARKER,
          report: { verdict: MARKER },
        },
        {
          type: "stock-list",
          title: MARKER,
          stocks: [{ symbol: MARKER, metrics: { pe: 1 } }],
          total: 1,
        },
        { type: "table", title: MARKER, columns: [], rows: [{ a: MARKER }] },
        { type: "future-type", field: MARKER },
      ],
      spy
    );
    assert.ok(out.length > 0, "nothing rendered — this would prove nothing");
    assert.ok(
      !out.includes(MARKER),
      `unsanitized text reached the prompt:\n${out}`
    );
  });

  it("the sanitizer is a required parameter, not an optional one", () => {
    // An optional sanitizer is one a caller forgets. Pinned on the signature
    // because that is what a future caller reads.
    const src = readFileSync(
      join(process.cwd(), "lib/gemini/history-blocks.ts"),
      "utf8"
    );
    assert.doesNotMatch(
      src,
      /sanitize\?\s*:/,
      "the sanitizer became optional — a caller can now skip it"
    );
  });
});

describe("the replay path is wired and provider-agnostic", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/gemini/conversation.ts"),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("[regression] convertToGeminiFormat no longer replays content alone", () => {
    // The whole fix is worthless if the flattener is not actually called — this
    // branch has already shipped one fix into a file nothing imported.
    assert.doesNotMatch(
      SRC,
      /parts:\s*\[\{\s*text:\s*msg\.content\s*\}\]/,
      "history is replaying msg.content alone again — blocks are invisible"
    );
    assert.match(SRC, /replayText\(/);
  });

  it("history is keyed by chat and user, never by model", () => {
    // Why a model switch loses nothing: there is no model in the cache key, so
    // Gemini and Claude read the same history for the same chat.
    assert.match(SRC, /getContextCacheKey\(userId, chatId\)/);
    assert.doesNotMatch(
      SRC,
      /getContextCacheKey\([^)]*model/i,
      "the history cache key gained a model — a switch would now lose history"
    );
  });
});

describe("[regression] budgets are spent on what RENDERS, not on what is present", () => {
  // All three of these returned "" before the review. One mistake in three
  // places: slicing a budget BEFORE knowing what would render, so entries that
  // produce nothing consumed the allowance. It reads as a cap and behaves as a
  // lottery — and it fails silently, which is the class this module exists to
  // remove.

  it("a report behind four TEXT blocks still renders", () => {
    // Text blocks are skipped by design, so they used to eat all four slots.
    const out = summariseBlocks(
      [
        ...Array.from({ length: 4 }, (_, i) => ({
          type: "text",
          content: `t${i}`,
        })),
        {
          type: "structured-report",
          symbol: "RELIANCE",
          report: { verdict: "Fairly valued" },
        },
      ],
      identity
    );
    assert.match(out, /RELIANCE/, "the report was dropped by skipped blocks");
  });

  it("keeps the NEWEST blocks, because blocks accumulate newest-last", () => {
    // ChatContext.tsx:2225 is `blocks: [...(msg.blocks ?? []), streamBlock]`, so
    // the block most worth carrying is at the END. Taking the first N cut it.
    const out = summariseBlocks(
      [
        ...Array.from({ length: 5 }, (_, i) => ({
          type: "future",
          label: `OLD${i}`,
        })),
        {
          type: "structured-report",
          symbol: "TCS",
          report: { verdict: "Rich" },
        },
      ],
      identity
    );
    assert.match(out, /TCS/, "the newest block was dropped");
    assert.ok(
      !out.includes("OLD0"),
      "the oldest block should have been dropped instead"
    );
  });

  it("a table whose leading rows are unusable still renders the good one", () => {
    const out = summariseBlock({
      type: "table",
      columns: [],
      rows: [1, 2, 3, 4, 5, { symbol: "TCS", pe: 28 }],
    });
    assert.match(String(out), /TCS/, "unrenderable rows spent the row budget");
  });
});

describe("[regression] the table renders its DECLARED columns", () => {
  it("uses the column labels, not arbitrary row keys", () => {
    // This was `cols.length ? Object.keys(o) : Object.keys(o)` — two identical
    // branches — so the declared columns were computed and thrown away, and the
    // per-row cap then picked the first keys in object order instead.
    const out = summariseBlock({
      type: "table",
      columns: [{ key: "pe", label: "P/E" }],
      rows: [{ symbol: "TCS", pe: 28, noise: "zzz", more: "yyy" }],
    });
    assert.match(String(out), /P\/E 28/, "the declared column was ignored");
    assert.ok(!String(out).includes("zzz"), "an undeclared column leaked in");
  });
});

describe("[regression] truncation is always announced", () => {
  it("a stock list says how many it withheld even when total equals its length", () => {
    // The comparison was against `stocks.length` (the FULL array) rather than
    // against how many were RENDERED, so a screener page whose `total` equals
    // its own length showed 5 of 10 and said nothing — and the model reads a
    // truncated list as the complete answer.
    const out = summariseBlock({
      type: "stock-list",
      title: "IT",
      total: 10,
      stocks: Array.from({ length: 10 }, (_, i) => ({
        symbol: `S${i}`,
        metrics: { pe: 10 + i },
      })),
    });
    assert.match(String(out), /\+5 more/, "5 of 10 were shown with no notice");
  });

  it("a larger declared total is reported over the array length", () => {
    const out = summariseBlock({
      type: "stock-list",
      title: "IT",
      total: 200,
      stocks: Array.from({ length: 10 }, (_, i) => ({
        symbol: `S${i}`,
        metrics: {},
      })),
    });
    assert.match(String(out), /\+195 more/);
  });
});

describe("[regression] the inline-history path does not discard the summaries", () => {
  const ROUTE = readFileSync(
    join(process.cwd(), "app/api/chat/route.ts"),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("inline history is a fallback for EMPTY history, not a replacement", () => {
    // It used to overwrite the loaded history whenever it was "longer".
    // `conversationHistory` is typed `{role, content, turnMeta}` with NO blocks,
    // so that replacement threw away everything this module had just flattened
    // in — undoing the fix at runtime. It also took `.slice(-10)`, FEWER turns
    // than the 20-message cap it was replacing.
    assert.doesNotMatch(
      ROUTE,
      /inlineHistory\.length > conversationContext\.history\.length/,
      "inline history can replace the loaded history again"
    );
    assert.match(
      ROUTE,
      /conversationContext\.history\.length === 0/,
      "the fallback is no longer gated on the loaded history being empty"
    );
  });
});
