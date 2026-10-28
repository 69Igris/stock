/**
 * Stats Action Tests - Admin App
 *
 * Tests for content stats aggregation logic and count calculations.
 *
 * Exercises the REAL exported helpers from
 * apps/admin/lib/actions/stats-logic.ts (computeContentStats is imported and
 * called by getContentStats) instead of an inline copy.
 *
 * Note: the prior inline copy carried a `glossaryTerms` field that
 * getContentStats does not actually return; the real shape (courses,
 * publishedCourses, draftCourses, chapters, lessons, enrollments) is used here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeContentStats,
  validateDraftCalculation,
  formatStatsSummary,
  type ContentStats,
} from "@/lib/actions/stats-logic";

// --- Tests ---

describe("Stats Actions", () => {
  describe("computeContentStats", () => {
    it("should compute draftCourses as courses - publishedCourses", () => {
      const stats = computeContentStats({
        courses: 10,
        publishedCourses: 7,
        chapters: 30,
        lessons: 90,
        enrollments: 500,
      });
      assert.strictEqual(stats.draftCourses, 3);
    });

    it("should handle all courses published", () => {
      const stats = computeContentStats({
        courses: 5,
        publishedCourses: 5,
        chapters: 15,
        lessons: 45,
        enrollments: 100,
      });
      assert.strictEqual(stats.draftCourses, 0);
    });

    it("should handle no courses published", () => {
      const stats = computeContentStats({
        courses: 3,
        publishedCourses: 0,
        chapters: 9,
        lessons: 27,
        enrollments: 0,
      });
      assert.strictEqual(stats.draftCourses, 3);
    });

    it("should handle zero counts", () => {
      const stats = computeContentStats({
        courses: 0,
        publishedCourses: 0,
        chapters: 0,
        lessons: 0,
        enrollments: 0,
      });
      assert.deepStrictEqual(stats, {
        courses: 0,
        publishedCourses: 0,
        draftCourses: 0,
        chapters: 0,
        lessons: 0,
        enrollments: 0,
      });
    });

    it("should pass through all raw count fields", () => {
      const stats = computeContentStats({
        courses: 8,
        publishedCourses: 3,
        chapters: 24,
        lessons: 72,
        enrollments: 250,
      });
      assert.strictEqual(stats.courses, 8);
      assert.strictEqual(stats.chapters, 24);
      assert.strictEqual(stats.lessons, 72);
      assert.strictEqual(stats.enrollments, 250);
    });
  });

  describe("validateDraftCalculation", () => {
    it("should return true for correct calculation", () => {
      const stats: ContentStats = {
        courses: 10,
        publishedCourses: 7,
        draftCourses: 3,
        chapters: 0,
        lessons: 0,
        enrollments: 0,
      };
      assert.strictEqual(validateDraftCalculation(stats), true);
    });

    it("should return false for incorrect calculation", () => {
      const stats: ContentStats = {
        courses: 10,
        publishedCourses: 7,
        draftCourses: 5, // wrong
        chapters: 0,
        lessons: 0,
        enrollments: 0,
      };
      assert.strictEqual(validateDraftCalculation(stats), false);
    });
  });

  describe("formatStatsSummary", () => {
    it("should format a correct summary string", () => {
      const stats = computeContentStats({
        courses: 10,
        publishedCourses: 7,
        chapters: 30,
        lessons: 90,
        enrollments: 500,
      });
      const summary = formatStatsSummary(stats);
      assert.ok(summary.includes("10 courses"));
      assert.ok(summary.includes("7 published"));
      assert.ok(summary.includes("3 drafts"));
      assert.ok(summary.includes("30 chapters"));
      assert.ok(summary.includes("90 lessons"));
      assert.ok(summary.includes("500 enrollments"));
    });
  });
});
