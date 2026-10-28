/**
 * IndexedDB Cache Tests (lib/chat-history/idb-cache.ts)
 *
 * Covers:
 *   - buildKey shape
 *   - graceful no-op when IndexedDB unavailable (Safari private mode)
 *
 * Source: apps/web/lib/chat-history/idb-cache.ts
 *
 * Note: Full IDB CRUD round-trip coverage requires a browser-grade
 * IDB implementation. We deliberately avoid pulling fake-indexeddb just
 * for one test file. The shape + degradation behavior verified here is
 * what catches real regressions; the read/write happy-path is mechanical
 * and best validated via browser QA.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildKey,
  idbGet,
  idbSet,
  idbClearForUser,
  idbClearAll,
} from "../../lib/chat-history/idb-cache";

describe("chat-history idb-cache: buildKey", () => {
  it("composes version, userId, archive flag, query", () => {
    // MONEY-1255 added the leading version segment. It is asserted rather than
    // ignored because the whole point of the prefix is that an OLD entry must
    // not be servable by a NEW build: StockSage stopped listing the side
    // chats, and a returning user's cached first page still contains them, so
    // without the bump the fix looks like it never shipped.
    assert.equal(buildKey("user-a", false, ""), "v2:user-a:active:");
    assert.equal(buildKey("user-a", true, ""), "v2:user-a:archived:");
    assert.equal(buildKey("user-a", false, "tcs"), "v2:user-a:active:tcs");
    assert.equal(
      buildKey("user-with-colon:in:id", false, "q"),
      "v2:user-with-colon:in:id:active:q"
    );
  });

  it("[regression] the key is VERSIONED, so a scope change invalidates it", () => {
    // Guards the mechanism, not the literal: any future change to what a
    // cached list contains must bump this, or stale entries survive it.
    assert.match(buildKey("u", false, ""), /^v\d+:/);
  });
});

describe("chat-history idb-cache: degrades when IDB unavailable", () => {
  it("idbGet returns null when indexedDB undefined (e.g. Safari private)", async () => {
    const out = await idbGet("any-key");
    assert.equal(out, null);
  });

  it("idbSet does not throw when indexedDB undefined", async () => {
    await idbSet("any-key", "user-a", [], 0);
    // No assert needed - if it throws, the test fails.
    assert.ok(true);
  });

  it("idbClearForUser does not throw when indexedDB undefined", async () => {
    await idbClearForUser("user-a");
    assert.ok(true);
  });

  it("idbClearAll does not throw when indexedDB undefined", async () => {
    await idbClearAll();
    assert.ok(true);
  });
});
