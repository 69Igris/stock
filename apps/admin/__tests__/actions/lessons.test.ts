/**
 * Lessons Action Tests - Admin App
 *
 * Tests for lesson input validation and lesson type logic.
 *
 * Exercises the REAL exported helpers from
 * apps/admin/lib/actions/lessons-logic.ts (imported and called by lessons.ts)
 * instead of an inline copy. `validateLessonInput`, `resolveDefaultType`, and
 * `resolveDefaultOrder` are called by createLesson; `isValidLessonType` and
 * `videoLessonRequiresUrl` are shared validation helpers in the same module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateLessonInput,
  isValidLessonType,
  resolveDefaultOrder,
  resolveDefaultType,
  videoLessonRequiresUrl,
} from "@/lib/actions/lessons-logic";

// --- Tests ---

describe("Lessons Actions", () => {
  describe("validateLessonInput", () => {
    it("should return null for valid input with all required fields", () => {
      const result = validateLessonInput({
        chapterId: "ch-1",
        title: "Lesson 1",
        content: "Content here",
        type: "TEXT",
      });
      assert.strictEqual(result, null);
    });

    it("should return error when chapterId is missing", () => {
      const result = validateLessonInput({
        title: "L1",
        content: "C",
        type: "TEXT",
      });
      assert.ok(result?.includes("chapterId"));
    });

    it("should return error when title is missing", () => {
      const result = validateLessonInput({
        chapterId: "ch-1",
        content: "C",
        type: "TEXT",
      });
      assert.ok(result?.includes("title"));
    });

    it("should return error when type is missing", () => {
      const result = validateLessonInput({
        chapterId: "ch-1",
        title: "L1",
        content: "C",
      });
      assert.ok(result?.includes("type"));
    });

    it("should return error when all required fields are missing", () => {
      const result = validateLessonInput({});
      assert.ok(result !== null);
    });

    it("should return error for empty string chapterId", () => {
      const result = validateLessonInput({
        chapterId: "",
        title: "L1",
        type: "TEXT",
        content: "",
      });
      assert.ok(result !== null);
    });
  });

  describe("isValidLessonType", () => {
    it("should accept TEXT type", () => {
      assert.strictEqual(isValidLessonType("TEXT"), true);
    });

    it("should accept VIDEO type", () => {
      assert.strictEqual(isValidLessonType("VIDEO"), true);
    });

    it("should accept AUDIO type", () => {
      assert.strictEqual(isValidLessonType("AUDIO"), true);
    });

    it("should accept DOCUMENT type", () => {
      assert.strictEqual(isValidLessonType("DOCUMENT"), true);
    });

    it("should reject unknown type", () => {
      assert.strictEqual(isValidLessonType("QUIZ"), false);
    });

    it("should reject lowercase type", () => {
      assert.strictEqual(isValidLessonType("text"), false);
    });

    it("should reject empty string", () => {
      assert.strictEqual(isValidLessonType(""), false);
    });
  });

  describe("resolveDefaultOrder", () => {
    it("should return 0 when order is undefined", () => {
      assert.strictEqual(resolveDefaultOrder(undefined), 0);
    });

    it("should return provided order when specified", () => {
      assert.strictEqual(resolveDefaultOrder(5), 5);
    });

    it("should return 0 when order is 0 (falsy but valid)", () => {
      // Mirrors the behavior of `data.order || 0`
      assert.strictEqual(resolveDefaultOrder(0), 0);
    });
  });

  describe("resolveDefaultType", () => {
    it("should return TEXT when type is undefined", () => {
      assert.strictEqual(resolveDefaultType(undefined), "TEXT");
    });

    it("should return provided type when specified", () => {
      assert.strictEqual(resolveDefaultType("VIDEO"), "VIDEO");
    });

    it("should return TEXT when type is empty string", () => {
      assert.strictEqual(resolveDefaultType(""), "TEXT");
    });
  });

  describe("videoLessonRequiresUrl", () => {
    it("should return true for TEXT lesson without url", () => {
      assert.strictEqual(videoLessonRequiresUrl("TEXT", undefined), true);
    });

    it("should return true for VIDEO lesson with url", () => {
      assert.strictEqual(
        videoLessonRequiresUrl("VIDEO", "https://example.com/v.mp4"),
        true,
      );
    });

    it("should return false for VIDEO lesson without url", () => {
      assert.strictEqual(videoLessonRequiresUrl("VIDEO", undefined), false);
    });

    it("should return true for AUDIO lesson without url", () => {
      assert.strictEqual(videoLessonRequiresUrl("AUDIO", undefined), true);
    });
  });
});
