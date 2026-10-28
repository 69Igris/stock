/**
 * Chat streaming protocol tests (MONEY-291) — imports the real encoder/parser
 * from lib/chat/chat-stream.ts (pure, type-only deps).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeSSE,
  parseSSEChunks,
  stripBlockMarkers,
  type ChatStreamEvent,
} from "@/lib/chat/chat-stream";

describe("chat-stream SSE protocol (MONEY-291)", () => {
  describe("encodeSSE", () => {
    it("frames an event as `data: <json>\\n\\n`", () => {
      const frame = encodeSSE({ t: "delta", text: "hello" });
      assert.equal(frame, 'data: {"t":"delta","text":"hello"}\n\n');
    });

    it("round-trips through the parser", () => {
      const ev: ChatStreamEvent = { t: "done", remaining: 3 };
      const { events, rest } = parseSSEChunks(encodeSSE(ev));
      assert.deepEqual(events, [ev]);
      assert.equal(rest, "");
    });
  });

  describe("parseSSEChunks", () => {
    it("decodes multiple complete frames", () => {
      const buf =
        encodeSSE({ t: "delta", text: "a" }) +
        encodeSSE({ t: "delta", text: "b" });
      const { events, rest } = parseSSEChunks(buf);
      assert.equal(events.length, 2);
      assert.equal((events[0] as { text: string }).text, "a");
      assert.equal((events[1] as { text: string }).text, "b");
      assert.equal(rest, "");
    });

    it("carries an incomplete trailing frame forward in `rest`", () => {
      const buf = encodeSSE({ t: "delta", text: "x" }) + 'data: {"t":"de';
      const { events, rest } = parseSSEChunks(buf);
      assert.equal(events.length, 1);
      assert.equal(rest, 'data: {"t":"de');
    });

    it("skips a malformed frame without throwing", () => {
      const buf =
        "data: {not json}\n\n" + encodeSSE({ t: "delta", text: "ok" });
      const { events } = parseSSEChunks(buf);
      assert.equal(events.length, 1);
      assert.equal((events[0] as { text: string }).text, "ok");
    });

    it("ignores frames without a data: line", () => {
      const { events } = parseSSEChunks(": keep-alive\n\n");
      assert.equal(events.length, 0);
    });
  });

  describe("stripBlockMarkers", () => {
    it("removes :::block:TYPE{...} markers", () => {
      assert.equal(
        stripBlockMarkers('Here is data :::block:card{"x":1} more'),
        "Here is data  more"
      );
    });

    it("removes bare ::: fences", () => {
      assert.equal(stripBlockMarkers("a:::b"), "ab");
    });

    it("leaves plain prose untouched", () => {
      assert.equal(stripBlockMarkers("just text"), "just text");
    });
  });
});
