/**
 * ChatHistorySidebar - group + kind detection tests.
 *
 * Pure-function coverage for MONEY-231 Phase D.
 * Source: apps/web/components/chat/ChatHistorySidebar.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): import the REAL helpers, now extracted into the
// React-free chat-history-logic.ts (ChatHistorySidebar.tsx re-exports them).
import {
  groupChatsByDate,
  detectChatKind,
} from "@/components/chat/chat-history-logic";

// Local fixture shape (structurally a ChatHistoryRecord for the bits the
// helpers read).
type ChatMessage = { role: "user" | "assistant"; content: string };
type ChatHistoryRecord = {
  id: string;
  lastMessageAt: Date;
  messages: ChatMessage[];
  customTitle?: string;
};

// ── Helpers for fixtures ───────────────────────────────────────────

function fixture(daysAgo: number, content = "Hello world"): ChatHistoryRecord {
  const now = Date.now();
  // Anchor to today's start to avoid hour-of-day flakes near the
  // midnight boundary.
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const date = new Date(start.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  // Bump 6h into the day so date is unambiguously inside the bucket
  date.setHours(6, 0, 0, 0);
  void now;
  return {
    id: `chat-${daysAgo}-${Math.random().toString(36).slice(2, 6)}`,
    lastMessageAt: date,
    messages: [{ role: "user", content }],
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("ChatHistorySidebar - groupChatsByDate", () => {
  it("buckets today / yesterday / lastWeek / older correctly", () => {
    const out = groupChatsByDate([
      fixture(0),
      fixture(1),
      fixture(3),
      fixture(6),
      fixture(8),
      fixture(45),
    ]);
    assert.equal(out.today.length, 1);
    assert.equal(out.yesterday.length, 1);
    assert.equal(out.lastWeek.length, 2); // 3d + 6d
    assert.equal(out.older.length, 2); // 8d + 45d
  });

  it("handles empty input", () => {
    const out = groupChatsByDate([]);
    assert.equal(out.today.length, 0);
    assert.equal(out.yesterday.length, 0);
    assert.equal(out.lastWeek.length, 0);
    assert.equal(out.older.length, 0);
  });
});

describe("ChatHistorySidebar - detectChatKind", () => {
  const cases: Array<[string, ReturnType<typeof detectChatKind>]> = [
    ["Roast my portfolio please", "roast"],
    ["Trash my picks", "roast"],
    ["Compare TCS vs INFY", "compare"],
    ["TCS versus INFY", "compare"],
    ["Show me my portfolio breakdown", "portfolio"],
    ["What's my current allocation?", "portfolio"],
    ["What's my FIRE number?", "fire"],
    ["Plan my retirement at 50", "fire"],
    ["Screen for high-ROE banks", "screen"],
    ["Find stocks where P/E < 15", "screen"],
    ["Deep research on RELIANCE", "research"],
    ["Analyse the latest TCS earnings", "research"],
    ["Compute a DCF for INFY", "research"],
    ["@RELIANCE what's the news?", "stock"],
    ["RELIANCE update please", "stock"],
    ["Hello there", "generic"],
  ];

  for (const [input, expected] of cases) {
    it(`classifies ${JSON.stringify(input)} as ${expected}`, () => {
      const chat: ChatHistoryRecord = {
        id: "x",
        lastMessageAt: new Date(),
        messages: [{ role: "user", content: input }],
      };
      assert.equal(detectChatKind(chat), expected);
    });
  }

  it("returns generic when there's no user message", () => {
    const chat: ChatHistoryRecord = {
      id: "x",
      lastMessageAt: new Date(),
      messages: [{ role: "assistant", content: "Greetings" }],
    };
    assert.equal(detectChatKind(chat), "generic");
  });

  it("returns generic when messages is missing", () => {
    const chat = {
      id: "x",
      lastMessageAt: new Date(),
    } as unknown as ChatHistoryRecord;
    assert.equal(detectChatKind(chat), "generic");
  });
});
