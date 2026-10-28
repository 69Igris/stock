/**
 * ChatHistorySidebar - bulk-select + bulk-delete logic.
 *
 * Pure-function coverage for the multi-select feature added during
 * the MONEY-231 follow-up that simplified the per-row dropdown to
 * { Delete, Select all & delete }.
 *
 * Source: apps/web/components/chat/ChatHistorySidebar.tsx - the
 * `selectedIds` Set state machine + bulk-delete Promise.allSettled
 * partition + "all selected" predicate.
 *
 * Backfilled in Wave 0.5 of the MONEY-196 bundle.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): import the REAL bulk-select helpers, now extracted
// into the React-free chat-history-logic.ts and CALLED by ChatHistorySidebar's
// toggleSelect / allSelected / handleBulkDelete (so they aren't dead).
import {
  toggleSelect,
  isAllSelected,
  partitionDeleteResults as partitionResults,
  dropSucceeded,
} from "@/components/chat/chat-history-logic";

// ── Tests ──────────────────────────────────────────────────────────

describe("Sidebar bulk-select state machine", () => {
  describe("toggleSelect", () => {
    it("adds an id to an empty set", () => {
      const next = toggleSelect(new Set(), "a");
      assert.deepStrictEqual([...next], ["a"]);
    });

    it("removes an id when present", () => {
      const next = toggleSelect(new Set(["a", "b"]), "a");
      assert.deepStrictEqual([...next].sort(), ["b"]);
    });

    it("treats different ids independently", () => {
      const after1 = toggleSelect(new Set(), "a");
      const after2 = toggleSelect(after1, "b");
      assert.deepStrictEqual([...after2].sort(), ["a", "b"]);
    });

    it("returns a new Set instance each call (immutable)", () => {
      const start = new Set(["a"]);
      const next = toggleSelect(start, "b");
      assert.notStrictEqual(start, next);
      assert.deepStrictEqual([...start], ["a"]);
    });
  });

  describe("isAllSelected", () => {
    it("returns false when select mode is off", () => {
      const chats = [{ id: "a" }, { id: "b" }];
      assert.strictEqual(
        isAllSelected(false, chats, new Set(["a", "b"])),
        false
      );
    });

    it("returns false when no chats", () => {
      assert.strictEqual(isAllSelected(true, [], new Set()), false);
    });

    it("returns false when partial selection", () => {
      const chats = [{ id: "a" }, { id: "b" }];
      assert.strictEqual(isAllSelected(true, chats, new Set(["a"])), false);
    });

    it("returns true when every chat id is selected", () => {
      const chats = [{ id: "a" }, { id: "b" }];
      assert.strictEqual(isAllSelected(true, chats, new Set(["a", "b"])), true);
    });
  });
});

describe("Sidebar bulk-delete partition", () => {
  it("collects all succeeded ids when every action returns success", () => {
    const ids = ["a", "b", "c"];
    const results: PromiseSettledResult<{ success: boolean }>[] = [
      { status: "fulfilled", value: { success: true } },
      { status: "fulfilled", value: { success: true } },
      { status: "fulfilled", value: { success: true } },
    ];
    const { succeeded, failed } = partitionResults(ids, results);
    assert.deepStrictEqual(succeeded, ["a", "b", "c"]);
    assert.deepStrictEqual(failed, []);
  });

  it("treats fulfilled+success=false as failed", () => {
    const ids = ["a", "b"];
    const results: PromiseSettledResult<{ success: boolean }>[] = [
      { status: "fulfilled", value: { success: false } },
      { status: "fulfilled", value: { success: true } },
    ];
    const { succeeded, failed } = partitionResults(ids, results);
    assert.deepStrictEqual(succeeded, ["b"]);
    assert.deepStrictEqual(failed, ["a"]);
  });

  it("treats rejected promises as failed", () => {
    const ids = ["a", "b"];
    const results: PromiseSettledResult<{ success: boolean }>[] = [
      { status: "fulfilled", value: { success: true } },
      { status: "rejected", reason: new Error("network down") },
    ];
    const { succeeded, failed } = partitionResults(ids, results);
    assert.deepStrictEqual(succeeded, ["a"]);
    assert.deepStrictEqual(failed, ["b"]);
  });

  it("preserves order of input ids in succeeded + failed buckets", () => {
    const ids = ["a", "b", "c", "d"];
    const results: PromiseSettledResult<{ success: boolean }>[] = [
      { status: "fulfilled", value: { success: false } },
      { status: "fulfilled", value: { success: true } },
      { status: "fulfilled", value: { success: false } },
      { status: "fulfilled", value: { success: true } },
    ];
    const { succeeded, failed } = partitionResults(ids, results);
    assert.deepStrictEqual(succeeded, ["b", "d"]);
    assert.deepStrictEqual(failed, ["a", "c"]);
  });
});

describe("Sidebar dropSucceeded filter", () => {
  it("drops chats whose id is in the succeeded set", () => {
    const chats = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const remaining = dropSucceeded(chats, new Set(["a", "c"]));
    assert.deepStrictEqual(remaining, [{ id: "b" }]);
  });

  it("returns the original list when nothing succeeded", () => {
    const chats = [{ id: "a" }, { id: "b" }];
    const remaining = dropSucceeded(chats, new Set());
    assert.deepStrictEqual(remaining, chats);
  });

  it("returns an empty list when all ids succeeded", () => {
    const chats = [{ id: "a" }, { id: "b" }];
    const remaining = dropSucceeded(chats, new Set(["a", "b"]));
    assert.deepStrictEqual(remaining, []);
  });
});
