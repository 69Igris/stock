/**
 * Chat-history service — pure logic (no Prisma / no I/O / no server-only deps).
 *
 * Extracted from `chat-history.service.ts` so the parts that were previously
 * inline expressions (or re-declared inside a shadow test) become EXPORTED,
 * unit-testable symbols the real service CALLS. The production code path and
 * the tests then execute the SAME code.
 *
 * Covers four concerns, each a real bug surface on the live chat-history path:
 *
 *   1. Pagination clamping — `listChatHistories` forwards a caller-supplied
 *      `{ limit, skip }` (web `listChatHistoriesAction(options)` passes them
 *      verbatim) straight into either `prisma.chatHistory.findMany({ skip,
 *      take })` (the >500-chat direct path) or `Array.slice(start, start +
 *      limit)` (the cached path). A `NaN` / negative / absurd value makes
 *      Prisma 5 throw `Expected Int` (the outer catch then silently returns an
 *      EMPTY list for a real user) and makes `slice` return the wrong page or
 *      `[]`. `clampChatPagination` mirrors notifications' `clampPagination`.
 *
 *   2. Title derivation — the first user message → a bounded, single-line chat
 *      title (custom title wins). Must not crash on an empty/whitespace/very
 *      long/unicode message or a malformed (non-array) `messages` blob.
 *
 *   3. Preview derivation — a short, bounded snippet for list rows.
 *
 *   4. Message summary — defensive `{ total, user, assistant }` counts over a
 *      possibly-malformed `messages` value (consumer-safety: never throws).
 *
 * Importing this module must NOT open a Prisma/Redis/socket handle — it pulls
 * only the shared `ChatMessage` type — so the tests stay pure and exit clean.
 *
 * @see apps/web/__tests__/services/chat-history-logic.test.ts
 * @see packages/services/src/notifications-pagination.ts (clampPagination)
 */

import type { ChatMessage } from "@usemoney/types";

// ── Pagination ─────────────────────────────────────────────────────────────

/** Default page size when `limit` is omitted/unusable. */
export const DEFAULT_CHAT_LIMIT = 20;

/**
 * Hard ceiling on a single chat-list page. Bounds memory + payload regardless
 * of what a caller (or a hand-crafted `?limit=` query) asks for.
 */
export const MAX_CHAT_LIMIT = 100;

/** Longest a derived title may be (excluding the ellipsis). */
export const MAX_TITLE_LENGTH = 60;

/** Longest a derived preview may be (excluding the ellipsis). */
export const MAX_PREVIEW_LENGTH = 120;

/** Shown when a chat has no usable first user message. */
export const EMPTY_CHAT_TITLE = "New conversation";

export interface ChatPaginationBounds {
  /**
   * Safe `take`: integer in [1, MAX_CHAT_LIMIT], or `undefined` when the caller
   * supplied no limit at all (preserves the service's "no take" semantics so an
   * unpaginated list still returns every row).
   */
  take: number | undefined;
  /** Safe `skip`: non-negative integer (always defined; defaults to 0). */
  skip: number;
}

/**
 * Coerce a possibly-untrusted numeric input to a finite integer, or `null` when
 * it can't be (NaN, ±Infinity, non-number). Floats are truncated toward zero.
 */
function toFiniteInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Clamp a (limit, skip) pair into safe chat-list pagination bounds.
 *
 * - `limit`:
 *     - omitted (`undefined`) → `take: undefined` ("return everything", the
 *       service's documented behavior when no limit is passed);
 *     - NaN / Infinity / non-number / ≤ 0 → `DEFAULT_CHAT_LIMIT` (a stray
 *       `?limit=NaN` becomes a sane page, never a Prisma 500 / empty result);
 *     - above `MAX_CHAT_LIMIT` → capped; floats truncated.
 * - `skip`: NaN / Infinity / non-number / negative → 0; floats truncated.
 *
 * Pure + total: never throws. `take` is either `undefined` or a finite integer
 * in [1, MAX_CHAT_LIMIT]; `skip` is always a non-negative finite integer.
 */
export function clampChatPagination(
  limit?: unknown,
  skip: unknown = 0,
): ChatPaginationBounds {
  let take: number | undefined;
  if (limit === undefined) {
    take = undefined;
  } else {
    const rawLimit = toFiniteInt(limit);
    take =
      rawLimit === null || rawLimit <= 0
        ? DEFAULT_CHAT_LIMIT
        : Math.min(rawLimit, MAX_CHAT_LIMIT);
  }

  const rawSkip = toFiniteInt(skip);
  const safeSkip = rawSkip === null || rawSkip < 0 ? 0 : rawSkip;

  return { take, skip: safeSkip };
}

/**
 * Slice an already-filtered/sorted chat list by clamped `(skip, limit)`.
 *
 * The single in-memory pagination primitive both `listChatHistories` paths use
 * after `clampChatPagination`. With a clamped `take === undefined` it returns
 * from `skip` to the end; otherwise `[skip, skip + take)`. A `skip` past the end
 * yields `[]` (an empty trailing page), never a wrap-around.
 */
export function paginateChatList<T>(
  chats: T[],
  bounds: ChatPaginationBounds,
): T[] {
  const list = Array.isArray(chats) ? chats : [];
  const { skip, take } = bounds;
  return take === undefined ? list.slice(skip) : list.slice(skip, skip + take);
}

// ── Messages: defensive normalisation + derivations ─────────────────────────

/**
 * Narrow a possibly-malformed Prisma JSON `messages` blob to a `ChatMessage[]`.
 * Anything that isn't an array (null, object, string — corrupt/legacy rows)
 * becomes `[]`, and non-object entries are dropped, so every downstream
 * derivation can iterate safely.
 */
export function safeMessageArray(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m): m is ChatMessage => typeof m === "object" && m !== null,
  );
}

/** Read a message's `content` as a string, tolerating a missing/non-string value. */
function messageContent(msg: ChatMessage | undefined): string {
  if (!msg) return "";
  const c = (msg as { content?: unknown }).content;
  return typeof c === "string" ? c : "";
}

/**
 * Collapse internal whitespace/newlines to single spaces and trim. Keeps the
 * title/preview single-line. Uses `\s` (Unicode-safe for the common cases) and
 * returns "" for an all-whitespace input.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Truncate to `max` characters (counting by code points, so a multi-byte
 * grapheme is never split mid-unit) and append "…" when shortened. `max <= 0`
 * yields "". Bounded output regardless of input length.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  const cps = Array.from(text); // code-point aware (won't split surrogate pairs)
  if (cps.length <= max) return text;
  return cps.slice(0, max).join("") + "…";
}

/**
 * Strip the synthetic `[Mentioned: …]` context prefix the chat UI prepends to a
 * user's first message before it's persisted, so a derived title shows the real
 * question rather than the mention bookkeeping.
 */
function stripMentionPrefix(content: string): string {
  return content.replace(/^\[Mentioned:[^\]]*\]\s*/, "");
}

/**
 * Derive a bounded, single-line chat title.
 *
 * Order of precedence (mirrors the sidebar's `getChatTitle`, now a shared
 * export so the service and UI can agree):
 *   1. a non-blank `customTitle` (user-set rename) wins verbatim (bounded);
 *   2. else the first `role: "user"` message's content, mention-prefix stripped,
 *      whitespace-collapsed, truncated to `MAX_TITLE_LENGTH`;
 *   3. else `EMPTY_CHAT_TITLE` (no user message / empty / whitespace-only /
 *      malformed `messages`).
 *
 * Total + safe: never throws on null/empty/whitespace/very-long/unicode input.
 */
export function deriveChatTitle(input: {
  customTitle?: string | null;
  messages: unknown;
}): string {
  const custom = (input.customTitle ?? "").trim();
  if (custom) return truncate(collapseWhitespace(custom), MAX_TITLE_LENGTH);

  const msgs = safeMessageArray(input.messages);
  const firstUser = msgs.find((m) => m.role === "user");
  const cleaned = collapseWhitespace(
    stripMentionPrefix(messageContent(firstUser)),
  );
  if (!cleaned) return EMPTY_CHAT_TITLE;
  return truncate(cleaned, MAX_TITLE_LENGTH);
}

/**
 * Derive a bounded, single-line preview snippet from the first user message
 * (longer than the title). Returns "" when there's no usable user message, so a
 * consumer can choose its own placeholder. Never throws.
 */
export function deriveChatPreview(messages: unknown): string {
  const msgs = safeMessageArray(messages);
  const firstUser = msgs.find((m) => m.role === "user");
  const cleaned = collapseWhitespace(
    stripMentionPrefix(messageContent(firstUser)),
  );
  return truncate(cleaned, MAX_PREVIEW_LENGTH);
}

export interface ChatMessageSummary {
  /** Total well-formed messages. */
  total: number;
  /** Count with `role: "user"`. */
  user: number;
  /** Count with `role: "assistant"`. */
  assistant: number;
}

/**
 * Defensive `{ total, user, assistant }` counts over a possibly-malformed
 * `messages` value. Consumer-safety: a non-array / corrupt blob yields all
 * zeros rather than throwing. `total` counts every well-formed message;
 * `user + assistant` may be `< total` if other roles (e.g. "system") exist.
 */
export function summarizeChatMessages(messages: unknown): ChatMessageSummary {
  const msgs = safeMessageArray(messages);
  let user = 0;
  let assistant = 0;
  for (const m of msgs) {
    if (m.role === "user") user += 1;
    else if (m.role === "assistant") assistant += 1;
  }
  return { total: msgs.length, user, assistant };
}
