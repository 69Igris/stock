/**
 * MONEY-620 — chat-history pure logic (REAL exported symbols, no shadow).
 *
 * Asserts the ACTUAL helpers that `packages/services/src/chat-history.service.ts`
 * CALLS, imported straight from their pure source — no inline copy. The module
 * pulls only the shared `ChatMessage` type, so this stays pure and exits clean
 * (no prisma/redis/socket at load).
 *
 * What it guards (every case is a real bug surface on the live path):
 *   - clampChatPagination — the pagination-500 class. `listChatHistories`
 *     forwards the caller's raw `{ limit, skip }` into `prisma.findMany({ skip,
 *     take })` (>500-chat path) and `Array.slice` (cached path). NaN / negative
 *     / Infinity / non-int / absurd values must clamp, never reach Prisma as a
 *     non-Int (→ throw → silently-empty list) or slice to the wrong page.
 *   - paginateChatList — clamped slice; trailing page is empty, never wraps.
 *   - deriveChatTitle / deriveChatPreview — first-user-message derivation that
 *     must not crash on empty / whitespace / very-long / unicode / malformed
 *     (non-array) `messages`, and stays length-bounded.
 *   - summarizeChatMessages — defensive counts; corrupt blob → zeros, no throw.
 *   - safeMessageArray — narrows a malformed JSON blob to a clean ChatMessage[].
 *
 * Source: packages/services/src/chat-history-logic.ts
 *         (called by packages/services/src/chat-history.service.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "@usemoney/types";
import {
  clampChatPagination,
  paginateChatList,
  safeMessageArray,
  truncate,
  deriveChatTitle,
  deriveChatPreview,
  summarizeChatMessages,
  DEFAULT_CHAT_LIMIT,
  MAX_CHAT_LIMIT,
  MAX_TITLE_LENGTH,
  MAX_PREVIEW_LENGTH,
  EMPTY_CHAT_TITLE,
  type ChatPaginationBounds,
} from "../../../../packages/services/src/chat-history-logic";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({
  role: "assistant",
  content,
});

describe("MONEY-620 — chat-history-logic (REAL service exports)", () => {
  // ── constants ─────────────────────────────────────────────────────────────
  describe("constants", () => {
    it("DEFAULT_CHAT_LIMIT=20, MAX_CHAT_LIMIT=100", () => {
      assert.equal(DEFAULT_CHAT_LIMIT, 20);
      assert.equal(MAX_CHAT_LIMIT, 100);
    });
    it("title/preview bounds and empty title are sane", () => {
      assert.equal(MAX_TITLE_LENGTH, 60);
      assert.equal(MAX_PREVIEW_LENGTH, 120);
      assert.equal(EMPTY_CHAT_TITLE, "New conversation");
    });
  });

  // ── clampChatPagination — the pagination-500 guard ──────────────────────────
  describe("clampChatPagination", () => {
    it("passes a normal (limit, skip) pair through", () => {
      assert.deepEqual(clampChatPagination(15, 30), { take: 15, skip: 30 });
    });

    it("omitted limit → take undefined ('return everything'), skip defaults 0", () => {
      assert.deepEqual(clampChatPagination(), { take: undefined, skip: 0 });
      assert.deepEqual(clampChatPagination(undefined, 5), {
        take: undefined,
        skip: 5,
      });
    });

    it("caps limit above MAX to MAX", () => {
      assert.equal(clampChatPagination(100000, 0).take, MAX_CHAT_LIMIT);
      assert.equal(clampChatPagination(101, 0).take, MAX_CHAT_LIMIT);
      assert.equal(clampChatPagination(100, 0).take, 100);
    });

    it("NaN limit → DEFAULT (regression: NaN must never reach Prisma as take)", () => {
      assert.equal(clampChatPagination(NaN, 0).take, DEFAULT_CHAT_LIMIT);
    });

    it("Infinity / -Infinity limit → DEFAULT", () => {
      assert.equal(clampChatPagination(Infinity, 0).take, DEFAULT_CHAT_LIMIT);
      assert.equal(clampChatPagination(-Infinity, 0).take, DEFAULT_CHAT_LIMIT);
    });

    it("zero / negative limit → DEFAULT", () => {
      assert.equal(clampChatPagination(0, 0).take, DEFAULT_CHAT_LIMIT);
      assert.equal(clampChatPagination(-5, 0).take, DEFAULT_CHAT_LIMIT);
    });

    it("non-number limit (string/null/object) → DEFAULT", () => {
      // `null` is distinct from omitted `undefined`: it's a non-number, so it
      // does NOT mean "return everything" — it clamps to the default page.
      assert.equal(
        clampChatPagination("50" as unknown, 0).take,
        DEFAULT_CHAT_LIMIT
      );
      assert.equal(
        clampChatPagination(null as unknown, 0).take,
        DEFAULT_CHAT_LIMIT
      );
      assert.equal(
        clampChatPagination({} as unknown, 0).take,
        DEFAULT_CHAT_LIMIT
      );
    });

    it("float limit is truncated toward zero", () => {
      assert.equal(clampChatPagination(15.9, 0).take, 15);
    });

    it("NaN / Infinity / negative / non-number skip → 0", () => {
      assert.equal(clampChatPagination(10, NaN).skip, 0);
      assert.equal(clampChatPagination(10, Infinity).skip, 0);
      assert.equal(clampChatPagination(10, -1).skip, 0);
      assert.equal(clampChatPagination(10, -99999).skip, 0);
      assert.equal(clampChatPagination(10, "20" as unknown).skip, 0);
      assert.equal(clampChatPagination(10, null as unknown).skip, 0);
    });

    it("huge but finite skip is preserved (deep paging is legal)", () => {
      assert.equal(clampChatPagination(10, 1_000_000).skip, 1_000_000);
    });

    it("float skip is truncated toward zero", () => {
      assert.equal(clampChatPagination(10, 30.7).skip, 30);
    });

    it("is total: never throws on adversarial inputs", () => {
      const inputs: unknown[] = [
        NaN,
        Infinity,
        -Infinity,
        "abc",
        null,
        undefined,
        {},
        [],
        true,
        Symbol("x"),
      ];
      for (const a of inputs) {
        for (const b of inputs) {
          assert.doesNotThrow(() => clampChatPagination(a, b));
        }
      }
    });
  });

  // ── paginateChatList ────────────────────────────────────────────────────────
  describe("paginateChatList", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);

    it("take undefined → from skip to end", () => {
      const bounds: ChatPaginationBounds = { take: undefined, skip: 3 };
      assert.deepEqual(paginateChatList(items, bounds), [3, 4, 5, 6, 7, 8, 9]);
    });

    it("take defined → [skip, skip+take)", () => {
      assert.deepEqual(
        paginateChatList(items, { take: 3, skip: 0 }),
        [0, 1, 2]
      );
      assert.deepEqual(
        paginateChatList(items, { take: 3, skip: 3 }),
        [3, 4, 5]
      );
    });

    it("skip past the end → empty trailing page (never wraps)", () => {
      assert.deepEqual(paginateChatList(items, { take: 5, skip: 100 }), []);
    });

    it("tolerates a non-array (defensive) → []", () => {
      assert.deepEqual(
        paginateChatList(null as unknown as number[], { take: 5, skip: 0 }),
        []
      );
    });
  });

  // ── safeMessageArray ────────────────────────────────────────────────────────
  describe("safeMessageArray", () => {
    it("passes a well-formed array through", () => {
      const msgs = [user("a"), assistant("b")];
      assert.deepEqual(safeMessageArray(msgs), msgs);
    });

    it("non-array (null / undefined / object / string / number) → []", () => {
      for (const bad of [null, undefined, {}, "x", 42, true]) {
        assert.deepEqual(safeMessageArray(bad), []);
      }
    });

    it("drops non-object entries (null / primitives) inside the array", () => {
      const dirty = [user("a"), null, "x", 3, assistant("b")] as unknown;
      const out = safeMessageArray(dirty);
      assert.equal(out.length, 2);
      assert.equal(out[0]!.content, "a");
      assert.equal(out[1]!.content, "b");
    });
  });

  // ── truncate ────────────────────────────────────────────────────────────────
  describe("truncate", () => {
    it("returns short strings unchanged", () => {
      assert.equal(truncate("hello", 10), "hello");
      assert.equal(truncate("hello", 5), "hello");
    });

    it("appends an ellipsis when shortened", () => {
      assert.equal(truncate("hello world", 5), "hello…");
    });

    it("max <= 0 → empty string", () => {
      assert.equal(truncate("hello", 0), "");
      assert.equal(truncate("hello", -3), "");
    });

    it("counts code points (does not split a surrogate pair / emoji)", () => {
      // 4 emoji, each a surrogate pair; truncate to 2 → exactly 2 + ellipsis.
      const out = truncate("😀😁😂🤣", 2);
      assert.equal(Array.from(out.replace("…", "")).length, 2);
      assert.ok(out.endsWith("…"));
    });
  });

  // ── deriveChatTitle ─────────────────────────────────────────────────────────
  describe("deriveChatTitle", () => {
    it("uses the first USER message (ignores a leading assistant welcome)", () => {
      const title = deriveChatTitle({
        messages: [assistant("Welcome!"), user("What is my P&L?")],
      });
      assert.equal(title, "What is my P&L?");
    });

    it("custom title wins over the first user message", () => {
      const title = deriveChatTitle({
        customTitle: "My renamed chat",
        messages: [user("ignored")],
      });
      assert.equal(title, "My renamed chat");
    });

    it("blank / whitespace customTitle falls through to the message", () => {
      assert.equal(
        deriveChatTitle({ customTitle: "   ", messages: [user("real")] }),
        "real"
      );
      assert.equal(
        deriveChatTitle({ customTitle: null, messages: [user("real")] }),
        "real"
      );
    });

    it("no user message → EMPTY_CHAT_TITLE", () => {
      assert.equal(
        deriveChatTitle({ messages: [assistant("only assistant")] }),
        EMPTY_CHAT_TITLE
      );
      assert.equal(deriveChatTitle({ messages: [] }), EMPTY_CHAT_TITLE);
    });

    it("empty / whitespace-only first user message → EMPTY_CHAT_TITLE (no crash)", () => {
      assert.equal(deriveChatTitle({ messages: [user("")] }), EMPTY_CHAT_TITLE);
      assert.equal(
        deriveChatTitle({ messages: [user("   \n\t  ")] }),
        EMPTY_CHAT_TITLE
      );
    });

    it("malformed (non-array) messages → EMPTY_CHAT_TITLE (no throw)", () => {
      assert.equal(
        deriveChatTitle({ messages: null as unknown }),
        EMPTY_CHAT_TITLE
      );
      assert.equal(
        deriveChatTitle({ messages: "corrupt" as unknown }),
        EMPTY_CHAT_TITLE
      );
      assert.equal(
        deriveChatTitle({ messages: { not: "an array" } as unknown }),
        EMPTY_CHAT_TITLE
      );
    });

    it("a message missing/with non-string content does not crash", () => {
      assert.equal(
        deriveChatTitle({
          messages: [{ role: "user" } as unknown as ChatMessage],
        }),
        EMPTY_CHAT_TITLE
      );
      assert.equal(
        deriveChatTitle({
          messages: [
            { role: "user", content: 123 } as unknown as ChatMessage,
            user("fallback next"),
          ],
        }),
        EMPTY_CHAT_TITLE // first user message wins even if its content is unusable
      );
    });

    it("very long message → bounded to MAX_TITLE_LENGTH + ellipsis", () => {
      const long = "a".repeat(500);
      const title = deriveChatTitle({ messages: [user(long)] });
      assert.ok(title.endsWith("…"));
      assert.equal(Array.from(title.replace("…", "")).length, MAX_TITLE_LENGTH);
    });

    it("collapses internal newlines/whitespace to single spaces (single-line)", () => {
      const title = deriveChatTitle({
        messages: [user("line one\n\n   line two\tend")],
      });
      assert.equal(title, "line one line two end");
      assert.ok(!title.includes("\n"));
    });

    it("strips the synthetic [Mentioned: …] prefix the UI prepends", () => {
      const title = deriveChatTitle({
        messages: [user("[Mentioned: TCS, INFY] How are these doing?")],
      });
      assert.equal(title, "How are these doing?");
    });

    it("preserves unicode content (no crash, not mangled)", () => {
      const title = deriveChatTitle({
        messages: [user("Mera portfolio kaisा hai 📈 ₹10L")],
      });
      assert.ok(title.includes("₹10L"));
      assert.ok(title.includes("📈"));
    });
  });

  // ── deriveChatPreview ───────────────────────────────────────────────────────
  describe("deriveChatPreview", () => {
    it("derives from the first user message, bounded to MAX_PREVIEW_LENGTH", () => {
      const long = "x".repeat(300);
      const preview = deriveChatPreview([user(long)]);
      assert.ok(preview.endsWith("…"));
      assert.equal(
        Array.from(preview.replace("…", "")).length,
        MAX_PREVIEW_LENGTH
      );
    });

    it("no usable user message → empty string (consumer picks a placeholder)", () => {
      assert.equal(deriveChatPreview([assistant("hi")]), "");
      assert.equal(deriveChatPreview([]), "");
      assert.equal(deriveChatPreview(null as unknown), "");
      assert.equal(deriveChatPreview([user("   ")]), "");
    });

    it("short content is returned verbatim (no ellipsis)", () => {
      assert.equal(deriveChatPreview([user("hello there")]), "hello there");
    });
  });

  // ── summarizeChatMessages ───────────────────────────────────────────────────
  describe("summarizeChatMessages", () => {
    it("counts user + assistant + total", () => {
      const s = summarizeChatMessages([
        user("a"),
        assistant("b"),
        user("c"),
        assistant("d"),
        assistant("e"),
      ]);
      assert.deepEqual(s, { total: 5, user: 2, assistant: 3 });
    });

    it("empty array → all zeros", () => {
      assert.deepEqual(summarizeChatMessages([]), {
        total: 0,
        user: 0,
        assistant: 0,
      });
    });

    it("malformed (non-array) → all zeros (consumer-safety, no throw)", () => {
      for (const bad of [null, undefined, "x", 42, { length: 3 }]) {
        assert.deepEqual(summarizeChatMessages(bad), {
          total: 0,
          user: 0,
          assistant: 0,
        });
      }
    });

    it("total counts well-formed messages even with other roles; user+assistant may be < total", () => {
      const s = summarizeChatMessages([
        { role: "system", content: "sys" } as unknown as ChatMessage,
        user("a"),
      ]);
      assert.equal(s.total, 2);
      assert.equal(s.user, 1);
      assert.equal(s.assistant, 0);
    });

    it("ignores null/primitive entries embedded in the array", () => {
      const s = summarizeChatMessages([
        user("a"),
        null,
        "x",
        assistant("b"),
      ] as unknown);
      assert.deepEqual(s, { total: 2, user: 1, assistant: 1 });
    });
  });
});
