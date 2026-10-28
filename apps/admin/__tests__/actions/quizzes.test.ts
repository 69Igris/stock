/**
 * Quizzes Action Tests - Admin App
 *
 * Tests for quiz input validation, option structure, and answer validation.
 *
 * Exercises the REAL exported helpers from
 * apps/admin/lib/actions/quizzes-logic.ts (imported and called by quizzes.ts)
 * instead of an inline copy. `validateQuizInput` and `mapGeneratedQuestions`
 * are called by the quiz actions; `validateQuizOptions` and
 * `validateCorrectAnswer` are shared validation helpers in the same module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateQuizInput,
  validateQuizOptions,
  validateCorrectAnswer,
  mapGeneratedQuestions,
  type GeneratedQuestion,
} from "@/lib/actions/quizzes-logic";

// --- Tests ---

describe("Quizzes Actions", () => {
  describe("validateQuizInput", () => {
    it("should return null for valid input", () => {
      const result = validateQuizInput({
        lessonId: "l-1",
        question: "What is a stock?",
        options: ["A", "B", "C", "D"],
        correctAnswer: 0,
      });
      assert.strictEqual(result, null);
    });

    it("should return error when lessonId is missing", () => {
      const result = validateQuizInput({ question: "Q?" });
      assert.ok(result?.includes("lessonId"));
    });

    it("should return error when question is missing", () => {
      const result = validateQuizInput({ lessonId: "l-1" });
      assert.ok(result?.includes("question"));
    });

    it("should return error when both are missing", () => {
      const result = validateQuizInput({});
      assert.ok(result !== null);
    });

    it("should return error for empty lessonId", () => {
      const result = validateQuizInput({ lessonId: "", question: "Q?" });
      assert.ok(result !== null);
    });

    it("should return error for empty question", () => {
      const result = validateQuizInput({ lessonId: "l-1", question: "" });
      assert.ok(result !== null);
    });
  });

  describe("validateQuizOptions", () => {
    it("should return null for valid options array", () => {
      assert.strictEqual(validateQuizOptions(["A", "B", "C", "D"]), null);
    });

    it("should return error for non-array", () => {
      assert.ok(validateQuizOptions("not an array") !== null);
    });

    it("should return error for single option", () => {
      assert.ok(validateQuizOptions(["A"])?.includes("at least 2"));
    });

    it("should return error for empty array", () => {
      assert.ok(validateQuizOptions([])?.includes("at least 2"));
    });

    it("should return error for options with empty strings", () => {
      assert.ok(validateQuizOptions(["A", ""])?.includes("non-empty"));
    });

    it("should return error for options with non-string items", () => {
      assert.ok(validateQuizOptions(["A", 123])?.includes("non-empty"));
    });

    it("should accept exactly 2 options", () => {
      assert.strictEqual(validateQuizOptions(["True", "False"]), null);
    });

    it("should return error for null", () => {
      assert.ok(validateQuizOptions(null) !== null);
    });

    it("should return error for undefined", () => {
      assert.ok(validateQuizOptions(undefined) !== null);
    });
  });

  describe("validateCorrectAnswer", () => {
    it("should return null for valid index", () => {
      assert.strictEqual(validateCorrectAnswer(0, ["A", "B", "C"]), null);
    });

    it("should return null for last index", () => {
      assert.strictEqual(validateCorrectAnswer(2, ["A", "B", "C"]), null);
    });

    it("should return error for negative index", () => {
      assert.ok(
        validateCorrectAnswer(-1, ["A", "B"])?.includes("non-negative"),
      );
    });

    it("should return error for out of bounds index", () => {
      assert.ok(
        validateCorrectAnswer(3, ["A", "B", "C"])?.includes("out of bounds"),
      );
    });

    it("should return error for float", () => {
      assert.ok(
        validateCorrectAnswer(1.5, ["A", "B", "C"])?.includes("integer"),
      );
    });
  });

  describe("mapGeneratedQuestions", () => {
    it("should map questions with correct lessonId and order", () => {
      const questions: GeneratedQuestion[] = [
        {
          question: "Q1?",
          options: ["A", "B", "C"],
          correctAnswer: 0,
          explanation: "Exp 1",
        },
        {
          question: "Q2?",
          options: ["X", "Y"],
          correctAnswer: 1,
          explanation: "Exp 2",
        },
      ];

      const result = mapGeneratedQuestions("lesson-1", questions);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].lessonId, "lesson-1");
      assert.strictEqual(result[0].order, 0);
      assert.strictEqual(result[1].order, 1);
      assert.strictEqual(result[0].question, "Q1?");
      assert.strictEqual(result[1].question, "Q2?");
    });

    it("should return empty array for empty questions", () => {
      const result = mapGeneratedQuestions("lesson-1", []);
      assert.strictEqual(result.length, 0);
    });

    it("should preserve all question fields", () => {
      const questions: GeneratedQuestion[] = [
        {
          question: "What is equity?",
          options: ["Stock", "Bond", "Cash", "Commodity"],
          correctAnswer: 0,
          explanation: "Equity means stock ownership",
        },
      ];

      const result = mapGeneratedQuestions("l-1", questions);
      assert.deepStrictEqual(result[0].options, [
        "Stock",
        "Bond",
        "Cash",
        "Commodity",
      ]);
      assert.strictEqual(result[0].explanation, "Equity means stock ownership");
      assert.strictEqual(result[0].correctAnswer, 0);
    });
  });
});
