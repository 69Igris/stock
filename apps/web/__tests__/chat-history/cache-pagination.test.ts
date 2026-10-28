/**
 * MONEY-392: `useChatHistoryCache` lazy-loads chat history - initial 25 +
 * scroll-triggered `loadMore` that pages off the existing length.
 *
 * Source-level assertion: the hook file declares `PAGE_SIZE = 25` and
 * exposes `loadMore` + `hasMore`. Full behavior testing happens via the
 * UI integration once we wire it in JSDOM (out of scope for this PR).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOK_PATH = join(
  __dirname,
  "..",
  "..",
  "hooks",
  "useChatHistoryCache.ts"
);
const src = readFileSync(HOOK_PATH, "utf8");

describe("MONEY-392 - useChatHistoryCache pagination", () => {
  it("declares PAGE_SIZE = 25", () => {
    assert.match(src, /const PAGE_SIZE = 25;/);
  });

  it("exports loadMore + hasMore + loadingMore via the hook return", () => {
    assert.ok(src.includes("loadingMore"));
    assert.ok(src.includes("hasMore"));
    assert.ok(src.includes("loadMore"));
  });

  it("loadMore skips by the current chats length", () => {
    assert.ok(src.includes("skip: currentLen"));
  });

  it("first page request uses skip: 0 + limit: PAGE_SIZE", () => {
    assert.ok(src.includes("skip: 0"));
    assert.ok(src.includes("limit: PAGE_SIZE"));
  });

  it("de-dupes loaded chats by id to avoid race-induced duplicates", () => {
    assert.ok(src.includes("seenIds"));
  });
});
