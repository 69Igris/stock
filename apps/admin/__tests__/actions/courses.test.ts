/**
 * Courses Action Tests - Admin App
 *
 * Tests for course CRUD validation logic, filter construction, and data shape.
 *
 * Exercises the REAL exported helpers from
 * apps/admin/lib/actions/courses-logic.ts (imported and called by courses.ts)
 * instead of an inline copy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCourseInput,
  buildCourseFilter,
  validateCourseId,
  type CourseInput,
} from "@/lib/actions/courses-logic";

// --- Mock Data ---

function createMockCourseInput(
  overrides: Partial<CourseInput> = {},
): CourseInput {
  return {
    slug: "intro-to-investing",
    title: "Introduction to Investing",
    description: "Learn the basics of investing in the Indian stock market.",
    level: "BEGINNER",
    duration: "4 hours",
    topics: ["stocks", "mutual funds", "portfolio"],
    published: false,
    order: 0,
    ...overrides,
  };
}

// --- Tests ---

describe("Courses Actions", () => {
  describe("validateCourseInput", () => {
    it("should return null for valid complete input", () => {
      const input = createMockCourseInput();
      assert.strictEqual(validateCourseInput(input), null);
    });

    it("should return error when slug is missing", () => {
      const input = createMockCourseInput({ slug: "" });
      assert.ok(
        validateCourseInput(input)?.includes("Missing required fields"),
      );
    });

    it("should return error when title is missing", () => {
      const input = createMockCourseInput({ title: "" });
      assert.ok(
        validateCourseInput(input)?.includes("Missing required fields"),
      );
    });

    it("should return error when description is missing", () => {
      const input = createMockCourseInput({ description: "" });
      assert.ok(
        validateCourseInput(input)?.includes("Missing required fields"),
      );
    });

    it("should return error when level is missing", () => {
      const input = createMockCourseInput({ level: "" });
      assert.ok(
        validateCourseInput(input)?.includes("Missing required fields"),
      );
    });

    it("should return error when duration is missing", () => {
      const input = createMockCourseInput({ duration: "" });
      assert.ok(
        validateCourseInput(input)?.includes("Missing required fields"),
      );
    });

    it("should accept input without optional image", () => {
      const input = createMockCourseInput();
      delete input.image;
      assert.strictEqual(validateCourseInput(input), null);
    });

    it("should accept input without optional published flag", () => {
      const input = createMockCourseInput();
      delete input.published;
      assert.strictEqual(validateCourseInput(input), null);
    });

    it("should accept input without optional order", () => {
      const input = createMockCourseInput();
      delete input.order;
      assert.strictEqual(validateCourseInput(input), null);
    });

    it("should return error when all required fields are empty", () => {
      const result = validateCourseInput({});
      assert.ok(result !== null);
    });
  });

  describe("buildCourseFilter", () => {
    it("should return empty object when no filters provided", () => {
      const where = buildCourseFilter();
      assert.deepStrictEqual(where, {});
    });

    it("should return empty object for undefined filters", () => {
      const where = buildCourseFilter(undefined);
      assert.deepStrictEqual(where, {});
    });

    it("should include published filter when true", () => {
      const where = buildCourseFilter({ published: true });
      assert.deepStrictEqual(where, { published: true });
    });

    it("should include published filter when false", () => {
      const where = buildCourseFilter({ published: false });
      assert.deepStrictEqual(where, { published: false });
    });

    it("should include level filter", () => {
      const where = buildCourseFilter({ level: "BEGINNER" });
      assert.deepStrictEqual(where, { level: "BEGINNER" });
    });

    it("should combine published and level filters", () => {
      const where = buildCourseFilter({ published: true, level: "ADVANCED" });
      assert.deepStrictEqual(where, { published: true, level: "ADVANCED" });
    });

    it("should not include level when empty string", () => {
      const where = buildCourseFilter({ level: "" });
      assert.deepStrictEqual(where, {});
    });
  });

  describe("validateCourseId", () => {
    it("should return null for valid courseId", () => {
      assert.strictEqual(validateCourseId("course-123"), null);
    });

    it("should return error for empty courseId", () => {
      assert.strictEqual(validateCourseId(""), "courseId is required");
    });

    it("should return error for undefined courseId", () => {
      assert.strictEqual(validateCourseId(undefined), "courseId is required");
    });

    it("should return error for null courseId", () => {
      assert.strictEqual(validateCourseId(null), "courseId is required");
    });
  });

  describe("Course data shape", () => {
    it("should have all required fields in mock", () => {
      const course = createMockCourseInput();
      assert.ok(course.slug);
      assert.ok(course.title);
      assert.ok(course.description);
      assert.ok(course.level);
      assert.ok(course.duration);
      assert.ok(Array.isArray(course.topics));
    });

    it("should have topics as array", () => {
      const course = createMockCourseInput({ topics: ["a", "b", "c"] });
      assert.strictEqual(course.topics.length, 3);
    });
  });
});
