/**
 * Quiz Action logic tests.
 *
 * De-shadowed (MONEY-620): these tests now import and execute the REAL pure
 * helpers from `lib/actions/quiz-logic.ts` — the same symbols the
 * `generateQuizAction` server action (`lib/actions/quiz.ts`) calls — instead of
 * re-declaring inline copies that "mirror quiz.ts". A regression in the real
 * input validation / count clamp / JSON parsing / question validation now fails
 * this file.
 *
 * Source under test: apps/web/lib/actions/quiz-logic.ts
 * Wired into:        apps/web/lib/actions/quiz.ts (generateQuizAction)
 *
 * Covers:
 * - Input validation (auth, topic length, count clamping)
 * - JSON parsing logic (raw JSON, code blocks, invalid JSON)
 * - Question validation (filtering invalid questions)
 * - Response shape
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateQuizInput,
  clampCount,
  parseQuizJSON,
  isValidQuestion,
  validateQuestions,
  processQuizResponse,
  DEFAULT_QUESTION_COUNT,
  MIN_QUESTION_COUNT,
  MAX_QUESTION_COUNT,
  type QuizQuestion,
} from "../../lib/actions/quiz-logic";

describe("Quiz Action - Input Validation", () => {
  it("returns error when user is null", () => {
    const result = validateQuizInput(null, {
      topic: "stocks",
      difficulty: "Beginner",
      count: 5,
    });
    assert.deepEqual(result, {
      success: false,
      error: "Authentication required",
    });
  });

  it("returns error when topic is too short (< 3 chars)", () => {
    const result = validateQuizInput(
      { id: "user1" },
      { topic: "ab", difficulty: "Beginner", count: 5 }
    );
    assert.deepEqual(result, {
      success: false,
      error: "Please provide a more specific topic",
    });
  });

  it("returns error when topic is empty string", () => {
    const result = validateQuizInput(
      { id: "user1" },
      { topic: "", difficulty: "Beginner", count: 5 }
    );
    assert.deepEqual(result, {
      success: false,
      error: "Please provide a more specific topic",
    });
  });

  it("returns error when topic is too long (> 500 chars)", () => {
    const longTopic = "a".repeat(501);
    const result = validateQuizInput(
      { id: "user1" },
      { topic: longTopic, difficulty: "Intermediate", count: 5 }
    );
    assert.deepEqual(result, {
      success: false,
      error: "Topic too long (max 500 chars)",
    });
  });

  it("accepts topic of exactly 3 chars", () => {
    const result = validateQuizInput(
      { id: "user1" },
      { topic: "abc", difficulty: "Beginner", count: 5 }
    );
    assert.equal(result, null);
  });

  it("accepts topic of exactly 500 chars", () => {
    const topic = "a".repeat(500);
    const result = validateQuizInput(
      { id: "user1" },
      { topic, difficulty: "Advanced", count: 5 }
    );
    assert.equal(result, null);
  });

  it("accepts valid input and returns null", () => {
    const result = validateQuizInput(
      { id: "user1" },
      { topic: "Indian stock market basics", difficulty: "Beginner", count: 5 }
    );
    assert.equal(result, null);
  });

  // -- edge cases (new) --

  it("prioritises the auth check over a bad topic (null user + empty topic)", () => {
    const result = validateQuizInput(null, {
      topic: "",
      difficulty: "Beginner",
      count: 5,
    });
    assert.equal(result!.error, "Authentication required");
  });

  it("counts length by UTF-16 code units: a 2-char unicode topic passes", () => {
    // "नमस्ते" is well over 3 code units; a 3-emoji topic is 6+ units.
    const result = validateQuizInput(
      { id: "u" },
      { topic: "नमस्ते", difficulty: "Beginner", count: 5 }
    );
    assert.equal(result, null);
  });

  it("rejects a 2-code-unit topic even if it looks like 1 emoji", () => {
    // A single astral emoji is 2 UTF-16 units → length 2 < 3 → rejected.
    const result = validateQuizInput(
      { id: "u" },
      { topic: "😀", difficulty: "Beginner", count: 5 }
    );
    assert.equal(result!.error, "Please provide a more specific topic");
  });

  it("accepts a topic at the 500 boundary built from multibyte chars", () => {
    const topic = "क".repeat(500);
    assert.equal(topic.length, 500);
    const result = validateQuizInput(
      { id: "u" },
      { topic, difficulty: "Advanced", count: 5 }
    );
    assert.equal(result, null);
  });
});

describe("Quiz Action - Count Clamping", () => {
  it("clamps count=1 to minimum of 3", () => {
    assert.equal(clampCount(1), 3);
  });

  it("clamps count=2 to minimum of 3", () => {
    assert.equal(clampCount(2), 3);
  });

  it("clamps count=20 to maximum of 10", () => {
    assert.equal(clampCount(20), 10);
  });

  it("clamps count=100 to maximum of 10", () => {
    assert.equal(clampCount(100), 10);
  });

  it("keeps count=5 as-is", () => {
    assert.equal(clampCount(5), 5);
  });

  it("keeps count=3 as-is (lower bound)", () => {
    assert.equal(clampCount(3), 3);
  });

  it("keeps count=10 as-is (upper bound)", () => {
    assert.equal(clampCount(10), 10);
  });

  it("defaults to 5 when count is undefined", () => {
    assert.equal(clampCount(undefined), 5);
  });

  it("defaults to 5 when count is 0 (falsy)", () => {
    assert.equal(clampCount(0), 5);
  });

  // -- edge cases (new) --

  it("defaults to 5 then floors to >=3 when count is NaN (falsy)", () => {
    // NaN is falsy → `count || 5` yields 5.
    assert.equal(clampCount(NaN), DEFAULT_QUESTION_COUNT);
  });

  it("clamps a negative count up to the minimum", () => {
    assert.equal(clampCount(-7), MIN_QUESTION_COUNT);
  });

  it("clamps a huge count down to the maximum", () => {
    assert.equal(clampCount(Number.MAX_SAFE_INTEGER), MAX_QUESTION_COUNT);
  });

  it("never returns a value outside [MIN, MAX] for any finite count", () => {
    for (const c of [-100, -1, 0, 1, 2, 3, 4, 9, 10, 11, 50, 9999]) {
      const out = clampCount(c);
      assert.ok(
        out >= MIN_QUESTION_COUNT && out <= MAX_QUESTION_COUNT,
        `clampCount(${c}) = ${out} out of bounds`
      );
      assert.ok(!Number.isNaN(out), `clampCount(${c}) leaked NaN`);
    }
  });

  it("truncates a fractional in-range count toward the nearest bound via Math.min/max (no rounding)", () => {
    // 4.5 is in range so Math.min(Math.max(4.5,3),10) = 4.5 — passes through.
    assert.equal(clampCount(4.5), 4.5);
  });
});

describe("Quiz Action - JSON Parsing", () => {
  const validQuestion: QuizQuestion = {
    question: "What is NSE?",
    options: [
      "National Stock Exchange",
      "New Stock Exchange",
      "North Stock Exchange",
      "Net Stock Exchange",
    ],
    correctAnswer: 0,
    explanation: "NSE stands for National Stock Exchange of India",
  };

  it("parses raw JSON array", () => {
    const raw = JSON.stringify([validQuestion]);
    const result = parseQuizJSON(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.question, "What is NSE?");
  });

  it("strips ```json code block and parses", () => {
    const wrapped = "```json\n" + JSON.stringify([validQuestion]) + "\n```";
    const result = parseQuizJSON(wrapped);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.question, "What is NSE?");
  });

  it("strips ``` code block without json tag and parses", () => {
    const wrapped = "```\n" + JSON.stringify([validQuestion]) + "\n```";
    const result = parseQuizJSON(wrapped);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.question, "What is NSE?");
  });

  it("throws SyntaxError for invalid JSON", () => {
    assert.throws(() => parseQuizJSON("not json at all"), SyntaxError);
  });

  it("throws SyntaxError for partial JSON", () => {
    assert.throws(() => parseQuizJSON('[{"question": '), SyntaxError);
  });

  it("handles whitespace around JSON", () => {
    const raw = "  \n" + JSON.stringify([validQuestion]) + "\n  ";
    const result = parseQuizJSON(raw);
    assert.equal(result.length, 1);
  });

  // -- edge cases (new) --

  it("throws SyntaxError on an empty string", () => {
    assert.throws(() => parseQuizJSON(""), SyntaxError);
  });

  it("throws SyntaxError on a lone fence with no JSON body", () => {
    // After stripping the leading ```json the remainder is "" → invalid JSON.
    assert.throws(() => parseQuizJSON("```json\n```"), SyntaxError);
  });

  it("parses a non-array JSON value (validation happens downstream)", () => {
    // parseQuizJSON only JSON.parses; a bare object does NOT throw here.
    const parsed = parseQuizJSON("{}") as unknown;
    assert.deepEqual(parsed, {});
  });

  it("preserves unicode inside parsed question text", () => {
    const q = { ...validQuestion, question: "एनएसई क्या है?" };
    const result = parseQuizJSON(JSON.stringify([q]));
    assert.equal(result[0]!.question, "एनएसई क्या है?");
  });

  it("only strips a fence when it is at the very start (inner backticks kept)", () => {
    const q = { ...validQuestion, explanation: "use ``code`` here" };
    const result = parseQuizJSON(JSON.stringify([q]));
    assert.equal(result[0]!.explanation, "use ``code`` here");
  });
});

describe("Quiz Action - isValidQuestion (per-question predicate)", () => {
  const validQ: QuizQuestion = {
    question: "What is a P/E ratio?",
    options: [
      "Price to Earnings",
      "Profit to Equity",
      "Price to Equity",
      "Profit to Earnings",
    ],
    correctAnswer: 0,
    explanation: "P/E ratio is Price to Earnings ratio",
  };

  it("accepts a well-formed question", () => {
    assert.equal(isValidQuestion(validQ), true);
  });

  it("rejects empty question text", () => {
    assert.equal(isValidQuestion({ ...validQ, question: "" }), false);
  });

  it("rejects when options is not exactly length 4", () => {
    assert.equal(
      isValidQuestion({ ...validQ, options: ["A", "B", "C"] }),
      false
    );
    assert.equal(
      isValidQuestion({ ...validQ, options: ["A", "B", "C", "D", "E"] }),
      false
    );
  });

  it("rejects a NaN correctAnswer (NaN >= 0 is false)", () => {
    assert.equal(isValidQuestion({ ...validQ, correctAnswer: NaN }), false);
  });

  it("rejects a fractional correctAnswer? (still in range → accepted)", () => {
    // 2.5 satisfies typeof number && 0..3 — the source does NOT require an int.
    assert.equal(isValidQuestion({ ...validQ, correctAnswer: 2.5 }), true);
  });

  it("rejects correctAnswer just out of the upper bound", () => {
    assert.equal(isValidQuestion({ ...validQ, correctAnswer: 3.0001 }), false);
  });
});

describe("Quiz Action - Question Validation", () => {
  const validQ: QuizQuestion = {
    question: "What is a P/E ratio?",
    options: [
      "Price to Earnings",
      "Profit to Equity",
      "Price to Equity",
      "Profit to Earnings",
    ],
    correctAnswer: 0,
    explanation: "P/E ratio is Price to Earnings ratio",
  };

  it("accepts valid question", () => {
    const result = validateQuestions([validQ]);
    assert.equal(result.success, true);
    assert.equal(result.data?.length, 1);
  });

  it("filters out question with missing question field", () => {
    const invalid = { ...validQ, question: "" };
    const result = validateQuestions([invalid]);
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated invalid questions. Please try again."
    );
  });

  it("filters out question with options not being array", () => {
    const invalid = {
      ...validQ,
      options: "not an array" as unknown as string[],
    };
    const result = validateQuestions([invalid]);
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated invalid questions. Please try again."
    );
  });

  it("filters out question with wrong number of options (3)", () => {
    const invalid = { ...validQ, options: ["A", "B", "C"] };
    assert.equal(validateQuestions([invalid]).success, false);
  });

  it("filters out question with wrong number of options (5)", () => {
    const invalid = { ...validQ, options: ["A", "B", "C", "D", "E"] };
    assert.equal(validateQuestions([invalid]).success, false);
  });

  it("filters out question with correctAnswer < 0", () => {
    assert.equal(
      validateQuestions([{ ...validQ, correctAnswer: -1 }]).success,
      false
    );
  });

  it("filters out question with correctAnswer > 3", () => {
    assert.equal(
      validateQuestions([{ ...validQ, correctAnswer: 4 }]).success,
      false
    );
  });

  it("filters out question with correctAnswer as string", () => {
    const invalid = { ...validQ, correctAnswer: "0" as unknown as number };
    assert.equal(validateQuestions([invalid]).success, false);
  });

  it("filters out question with missing explanation", () => {
    assert.equal(
      validateQuestions([{ ...validQ, explanation: "" }]).success,
      false
    );
  });

  it("returns error for empty array from AI", () => {
    const result = validateQuestions([]);
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated an invalid quiz. Please try again."
    );
  });

  it("returns error for non-array", () => {
    const result = validateQuestions("not an array");
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated an invalid quiz. Please try again."
    );
  });

  it("returns error for null", () => {
    const result = validateQuestions(null);
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated an invalid quiz. Please try again."
    );
  });

  it("keeps only valid questions from mixed array", () => {
    const invalidQ = { ...validQ, options: ["A", "B"] };
    const validQ2 = { ...validQ, question: "Another valid question?" };
    const result = validateQuestions([validQ, invalidQ, validQ2]);
    assert.equal(result.success, true);
    assert.equal(result.data?.length, 2);
  });

  it("all questions invalid returns error", () => {
    const invalid1 = { ...validQ, question: "" };
    const invalid2 = { ...validQ, correctAnswer: 5 };
    const result = validateQuestions([invalid1, invalid2]);
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated invalid questions. Please try again."
    );
  });

  it("accepts correctAnswer=0", () => {
    assert.equal(
      validateQuestions([{ ...validQ, correctAnswer: 0 }]).success,
      true
    );
  });

  it("accepts correctAnswer=3", () => {
    assert.equal(
      validateQuestions([{ ...validQ, correctAnswer: 3 }]).success,
      true
    );
  });

  // -- edge cases (new) --

  it("returns error for undefined input (not an array)", () => {
    const result = validateQuestions(undefined);
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated an invalid quiz. Please try again."
    );
  });

  it("returns error for an object that is not an array", () => {
    const result = validateQuestions({ length: 1, 0: {} });
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated an invalid quiz. Please try again."
    );
  });

  it("keeps exactly the valid subset from a large mostly-invalid batch", () => {
    const batch: QuizQuestion[] = [];
    for (let i = 0; i < 1000; i++) {
      batch.push(
        i % 100 === 0
          ? { ...validQ, question: `Q${i}` } // 10 valid (i=0,100,...,900)
          : { ...validQ, options: ["A", "B"] } // invalid
      );
    }
    const result = validateQuestions(batch);
    assert.equal(result.success, true);
    assert.equal(result.data?.length, 10);
  });

  it("does not mutate the caller's array length on filter", () => {
    const arr = [validQ, { ...validQ, question: "" }];
    validateQuestions(arr);
    assert.equal(arr.length, 2, "validateQuestions must not mutate input");
  });
});

describe("Quiz Action - End-to-End Processing", () => {
  it("successfully processes valid JSON response", () => {
    const questions = [
      {
        question: "What is SEBI?",
        options: [
          "Securities and Exchange Board of India",
          "Stock Exchange Bureau of India",
          "Securities and Equity Board of India",
          "Stock and Exchange Board of India",
        ],
        correctAnswer: 0,
        explanation: "SEBI is the regulator of securities markets in India",
      },
    ];
    const result = processQuizResponse(JSON.stringify(questions));
    assert.equal(result.success, true);
    assert.equal(result.data?.length, 1);
    assert.equal(result.data?.[0]!.question, "What is SEBI?");
  });

  it("handles code block wrapped response", () => {
    const questions = [
      {
        question: "What is BSE?",
        options: [
          "Bombay Stock Exchange",
          "Bangalore Stock Exchange",
          "Baroda Stock Exchange",
          "Bengal Stock Exchange",
        ],
        correctAnswer: 0,
        explanation: "BSE is the Bombay Stock Exchange",
      },
    ];
    const wrapped = "```json\n" + JSON.stringify(questions) + "\n```";
    const result = processQuizResponse(wrapped);
    assert.equal(result.success, true);
    assert.equal(result.data?.length, 1);
  });

  it("returns SyntaxError message for invalid JSON", () => {
    const result = processQuizResponse("This is not JSON at all");
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "Failed to parse AI response. Please try again."
    );
  });

  it("response shape has success and data on success", () => {
    const questions = [
      {
        question: "What is IPO?",
        options: [
          "Initial Public Offering",
          "Internal Price Order",
          "Indian Price Option",
          "Institutional Purchase Order",
        ],
        correctAnswer: 0,
        explanation: "IPO is Initial Public Offering",
      },
    ];
    const result = processQuizResponse(JSON.stringify(questions));
    assert.equal(result.success, true);
    assert.ok(Array.isArray(result.data));
    assert.equal(result.error, undefined);
  });

  it("response shape has success=false and error on failure", () => {
    const result = processQuizResponse("invalid");
    assert.equal(result.success, false);
    assert.equal(typeof result.error, "string");
    assert.equal(result.data, undefined);
  });

  // -- edge cases (new) --

  it("maps valid-JSON-but-empty-array to the invalid-quiz message (not the parse message)", () => {
    const result = processQuizResponse("[]");
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated an invalid quiz. Please try again."
    );
  });

  it("maps valid-JSON-but-all-questions-bad to the invalid-questions message", () => {
    const result = processQuizResponse(
      JSON.stringify([
        { question: "", options: [], correctAnswer: 9, explanation: "" },
      ])
    );
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated invalid questions. Please try again."
    );
  });

  it("maps a non-array JSON value (object) to the invalid-quiz message", () => {
    const result = processQuizResponse("{}");
    assert.equal(result.success, false);
    assert.equal(
      result.error,
      "AI generated an invalid quiz. Please try again."
    );
  });

  it("never throws and never leaks data on the failure path", () => {
    for (const bad of ["", "   ", "not json", "```json\n```", "{", "[1,2,"]) {
      const result = processQuizResponse(bad);
      assert.equal(result.success, false);
      assert.equal(result.data, undefined);
      assert.equal(typeof result.error, "string");
    }
  });
});
