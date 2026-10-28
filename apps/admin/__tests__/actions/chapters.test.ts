/**
 * Chapters Action Tests - Admin App
 *
 * Tests for chapter input validation and ordering logic.
 *
 * Exercises the REAL exported helpers from
 * apps/admin/lib/actions/chapters-logic.ts (imported by chapters.ts) instead
 * of an inline copy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateChapterInput,
  getNextChapterOrder,
  reorderAfterDelete,
  type ChapterOrderRecord,
} from "@/lib/actions/chapters-logic";

// --- Mock Data ---

function createMockChapter(
  overrides: Partial<ChapterOrderRecord> = {},
): ChapterOrderRecord {
  return {
    id: `chapter-${Math.random().toString(36).substr(2, 9)}`,
    courseId: "course-1",
    title: "Getting Started",
    order: 0,
    ...overrides,
  };
}

// --- Tests ---

describe("Chapters Actions", () => {
  describe("validateChapterInput", () => {
    it("should return null for valid input", () => {
      assert.strictEqual(
        validateChapterInput({ courseId: "c-1", title: "Chapter 1" }),
        null,
      );
    });

    it("should return error when courseId is missing", () => {
      const result = validateChapterInput({ title: "Chapter 1" });
      assert.ok(result?.includes("courseId"));
    });

    it("should return error when title is missing", () => {
      const result = validateChapterInput({ courseId: "c-1" });
      assert.ok(result?.includes("title"));
    });

    it("should return error when both are missing", () => {
      const result = validateChapterInput({});
      assert.ok(result !== null);
    });

    it("should return error for empty courseId string", () => {
      const result = validateChapterInput({ courseId: "", title: "Chapter" });
      assert.ok(result !== null);
    });

    it("should return error for empty title string", () => {
      const result = validateChapterInput({ courseId: "c-1", title: "" });
      assert.ok(result !== null);
    });
  });

  describe("getNextChapterOrder", () => {
    it("should return 0 for empty chapters list", () => {
      assert.strictEqual(getNextChapterOrder([]), 0);
    });

    it("should return maxOrder + 1 for existing chapters", () => {
      const chapters = [
        createMockChapter({ order: 0 }),
        createMockChapter({ order: 1 }),
        createMockChapter({ order: 2 }),
      ];
      assert.strictEqual(getNextChapterOrder(chapters), 3);
    });

    it("should handle non-sequential orders", () => {
      const chapters = [
        createMockChapter({ order: 0 }),
        createMockChapter({ order: 5 }),
        createMockChapter({ order: 2 }),
      ];
      assert.strictEqual(getNextChapterOrder(chapters), 6);
    });

    it("should handle single chapter", () => {
      const chapters = [createMockChapter({ order: 0 })];
      assert.strictEqual(getNextChapterOrder(chapters), 1);
    });
  });

  describe("reorderAfterDelete", () => {
    it("should reorder remaining chapters sequentially", () => {
      const chapters = [
        createMockChapter({ id: "c1", order: 0 }),
        createMockChapter({ id: "c2", order: 1 }),
        createMockChapter({ id: "c3", order: 2 }),
      ];
      const result = reorderAfterDelete(chapters, "c2");
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].id, "c1");
      assert.strictEqual(result[0].newOrder, 0);
      assert.strictEqual(result[1].id, "c3");
      assert.strictEqual(result[1].newOrder, 1);
    });

    it("should handle deleting first chapter", () => {
      const chapters = [
        createMockChapter({ id: "c1", order: 0 }),
        createMockChapter({ id: "c2", order: 1 }),
      ];
      const result = reorderAfterDelete(chapters, "c1");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, "c2");
      assert.strictEqual(result[0].newOrder, 0);
    });

    it("should return empty array when deleting only chapter", () => {
      const chapters = [createMockChapter({ id: "c1", order: 0 })];
      const result = reorderAfterDelete(chapters, "c1");
      assert.strictEqual(result.length, 0);
    });

    it("should return all if deleted ID not found", () => {
      const chapters = [
        createMockChapter({ id: "c1", order: 0 }),
        createMockChapter({ id: "c2", order: 1 }),
      ];
      const result = reorderAfterDelete(chapters, "nonexistent");
      assert.strictEqual(result.length, 2);
    });
  });
});
