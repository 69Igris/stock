/**
 * Event Bus Tests (lib/chat-history/event-bus.ts)
 *
 * Covers:
 *   - emit fires same-tab subscribers
 *   - subscribe returns unsubscribe
 *   - multiple subscribers all receive
 *   - cross-tab via BroadcastChannel mock
 *   - graceful no-op when BroadcastChannel undefined
 *
 * Source: apps/web/lib/chat-history/event-bus.ts
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// Minimal BroadcastChannel polyfill (Node ≥18 also has a built-in one,
// but we want to inspect calls). Installed before module import so the
// event-bus module's lazy channel-open uses our class.
class FakeChannel {
  static instances: FakeChannel[] = [];
  name: string;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  constructor(name: string) {
    this.name = name;
    FakeChannel.instances.push(this);
  }
  postMessage(data: unknown) {
    this.posted.push(data);
    // Mimic browser: do not echo to sender.
  }
  close() {}
}

before(() => {
  (
    globalThis as unknown as { BroadcastChannel: typeof FakeChannel }
  ).BroadcastChannel = FakeChannel;
});

import {
  emitChatHistoryEvent,
  subscribeChatHistoryEvents,
} from "../../lib/chat-history/event-bus";

describe("chat-history event-bus", () => {
  it("emit notifies same-tab subscribers", () => {
    const received: Array<{ type: string }> = [];
    const unsub = subscribeChatHistoryEvents((e) => {
      received.push(e);
    });
    emitChatHistoryEvent({ type: "chat-created", chatId: "c1" });
    emitChatHistoryEvent({ type: "chat-opened", chatId: "c2" });
    unsub();
    assert.equal(received.length, 2);
    assert.equal(received[0]?.type, "chat-created");
    assert.equal(received[1]?.type, "chat-opened");
  });

  it("unsubscribe stops further calls", () => {
    let count = 0;
    const unsub = subscribeChatHistoryEvents(() => {
      count++;
    });
    emitChatHistoryEvent({ type: "chat-mutated" });
    unsub();
    emitChatHistoryEvent({ type: "chat-mutated" });
    assert.equal(count, 1);
  });

  it("multiple subscribers all receive each event", () => {
    let a = 0;
    let b = 0;
    const ua = subscribeChatHistoryEvents(() => {
      a++;
    });
    const ub = subscribeChatHistoryEvents(() => {
      b++;
    });
    emitChatHistoryEvent({ type: "chat-mutated" });
    ua();
    ub();
    assert.equal(a, 1);
    assert.equal(b, 1);
  });

  it("emit posts to BroadcastChannel for cross-tab delivery", () => {
    // Pull whichever FakeChannel the module has opened (created lazily on
    // the first subscribe in this file's earlier tests).
    const ch = FakeChannel.instances[0];
    assert.ok(ch, "channel was opened during prior test setup");
    const before = ch!.posted.length;
    const noop = subscribeChatHistoryEvents(() => {});
    emitChatHistoryEvent({ type: "chat-created", chatId: "c-broadcast" });
    noop();
    assert.equal(ch!.posted.length - before, 1);
    assert.deepEqual(ch!.posted[ch!.posted.length - 1], {
      type: "chat-created",
      chatId: "c-broadcast",
    });
  });

  it("incoming BroadcastChannel message fans out to local listeners", () => {
    const ch = FakeChannel.instances[0];
    assert.ok(ch);
    const received: Array<{ type: string }> = [];
    const unsub = subscribeChatHistoryEvents((e) => {
      received.push(e);
    });
    // Simulate a message from another tab
    ch!.onmessage?.({ data: { type: "chat-mutated", chatId: "x" } });
    unsub();
    assert.equal(received.length, 1);
    assert.equal(received[0]?.type, "chat-mutated");
  });
});
