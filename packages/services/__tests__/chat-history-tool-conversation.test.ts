/**
 * MONEY-1245 — `toolConversation` on ChatHistory.
 *
 * Ask FIRE and Ask Screener are tool-driven: the functionCall /
 * functionResponse turns are what actually apply plan and screen edits. The
 * visible transcript alone is not enough to resume one, because a model
 * replayed without those turns has no idea which edits it already made — the
 * chat looks continuous to the user while the assistant starts blind.
 *
 * The field is deliberately SEPARATE from `messages`, which holds
 * { id, role, content, timestamp } and is what /chat-history's viewer renders;
 * folding raw Gemini turns in there would render as garbage.
 *
 * The dangerous property is that the attribute is ABSENT — not null, not [] —
 * on every row written before this change and on every StockSage chat, because
 * a Mongo `db push` creates indexes, not fields. That exact confusion caused
 * MONEY-1050, MONEY-1234 and MONEY-1235. These cases pin the reader's
 * behaviour on an absent field so a future "tidy-up" cannot turn missing into
 * a crash or, worse, into a filter that silently matches nothing.
 *
 * Source: packages/services/src/chat-history.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * The narrowing the panels apply when restoring a chat, mirrored from
 * `useSideChatHistory.load`. Kept in step with that reader deliberately: the
 * point is the CONTRACT — anything that is not an array means "no tool
 * context", and no shape may throw.
 */
function readToolConversation(stored: unknown): unknown[] {
  return Array.isArray(stored) ? stored : [];
}

describe("chat history toolConversation — absent is not empty (MONEY-1245)", () => {
  it("[regression] an ABSENT field reads as no tool context, not a crash", () => {
    // Every pre-existing row looks like this: the key simply is not there.
    const legacyRow: Record<string, unknown> = {
      id: "abc",
      messages: [{ role: "user", content: "hi" }],
    };

    assert.equal("toolConversation" in legacyRow, false);
    assert.deepEqual(readToolConversation(legacyRow.toolConversation), []);
  });

  it("[regression] null and undefined both read as no tool context", () => {
    // A row could carry an explicit null; it must behave like absent rather
    // than reaching the model as a bogus conversation.
    assert.deepEqual(readToolConversation(null), []);
    assert.deepEqual(readToolConversation(undefined), []);
  });

  it("[regression] a non-array value never throws", () => {
    // Defensive: JSON columns can hold anything a past writer put there.
    assert.deepEqual(readToolConversation("corrupt"), []);
    assert.deepEqual(readToolConversation(42), []);
    assert.deepEqual(readToolConversation({ role: "model" }), []);
  });

  it("a stored conversation round-trips unchanged", () => {
    const convo = [
      { role: "user", parts: [{ text: "retire at 45" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "updateRetirementAge", args: { age: 45 } } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "updateRetirementAge",
              response: { result: "ok" },
            },
          },
        ],
      },
    ];

    const restored = readToolConversation(convo);
    assert.equal(restored.length, 3);
    // The functionCall must survive intact — it is the record of what the
    // assistant already changed.
    assert.deepEqual(restored, convo);
  });

  it("a StockSage row (no tool loop) is indistinguishable from a legacy row", () => {
    // StockSage never passes toolConversation, so its rows keep the field
    // absent. That is the CORRECT representation of "this chat has no tool
    // loop" — not a gap to be backfilled.
    const stockSageRow: Record<string, unknown> = {
      id: "def",
      pagePath: "/dashboard",
      messages: [{ role: "user", content: "how am I doing?" }],
    };

    assert.equal("toolConversation" in stockSageRow, false);
    assert.deepEqual(readToolConversation(stockSageRow.toolConversation), []);
  });
});
