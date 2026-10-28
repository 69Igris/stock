/**
 * quiz.service + quiz-logic — REAL exports, injected prisma (MONEY-402).
 *
 * `@usemoney/services` runs its suite as ESM (no `require.cache` prisma
 * injection), so a fake prisma is injected via each fn's `deps` seam. Pins:
 *   - the answer key is STRIPPED on the pre-submit read (never leaks
 *     correctAnswer / explanation),
 *   - scoring is finite-guarded (a 0-question quiz scores 0, never NaN%),
 *   - the catalogue list filters to lessons that actually carry a quiz,
 *   - a thrown query fails closed to a sanitised error.
 *
 * Source: packages/services/src/quiz.service.ts + quiz-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scoreQuiz,
  clampPct,
  toPublicQuestion,
  sortByOrder,
  type QuizQuestionRow,
} from "../src/quiz-logic";
import {
  listQuizzes,
  getQuiz,
  submitQuiz,
  type QuizServiceDeps,
} from "../src/quiz.service";

const Q = (over: Partial<QuizQuestionRow> = {}): QuizQuestionRow => ({
  id: "q1",
  question: "2+2?",
  options: ["3", "4", "5"],
  correctAnswer: 1,
  explanation: "four",
  order: 0,
  ...over,
});

// ── pure logic ───────────────────────────────────────────────────────────────

describe("quiz-logic scoreQuiz", () => {
  it("scores correct/incorrect and reveals the answer key", () => {
    const res = scoreQuiz(
      [Q({ id: "a", order: 0 }), Q({ id: "b", order: 1, correctAnswer: 2 })],
      [1, 0],
    );
    assert.equal(res.total, 2);
    assert.equal(res.answered, 2);
    assert.equal(res.correctCount, 1);
    assert.equal(res.scorePct, 50);
    assert.equal(res.results[0]?.correct, true);
    assert.equal(res.results[1]?.correct, false);
    assert.equal(res.results[1]?.correctAnswer, 2); // key revealed on score
  });

  it("a 0-question quiz scores 0% (finite guard, never NaN)", () => {
    const res = scoreQuiz([], []);
    assert.equal(res.total, 0);
    assert.equal(res.scorePct, 0);
    assert.ok(Number.isFinite(res.scorePct));
  });

  it("treats non-integer / missing answers as unanswered (null, never correct)", () => {
    const res = scoreQuiz(
      [Q({ id: "a", order: 0 }), Q({ id: "b", order: 1 })],
      [1.5],
    );
    assert.equal(res.results[0]?.selected, null); // 1.5 → null
    assert.equal(res.results[1]?.selected, null); // missing → null
    assert.equal(res.answered, 0);
    assert.equal(res.correctCount, 0);
  });

  it("clampPct bounds to [0,100] and non-finite → 0", () => {
    assert.equal(clampPct(-5), 0);
    assert.equal(clampPct(150), 100);
    assert.equal(clampPct(Number.NaN), 0);
    assert.equal(clampPct(49.6), 50);
  });

  it("toPublicQuestion strips the answer key", () => {
    const pub = toPublicQuestion(Q());
    assert.equal("correctAnswer" in pub, false);
    assert.equal("explanation" in pub, false);
    assert.deepEqual(Object.keys(pub).sort(), [
      "id",
      "options",
      "order",
      "question",
    ]);
  });

  it("sortByOrder is deterministic (order, then id)", () => {
    const out = sortByOrder([
      Q({ id: "z", order: 1 }),
      Q({ id: "a", order: 1 }),
      Q({ id: "m", order: 0 }),
    ]);
    assert.deepEqual(
      out.map((q) => q.id),
      ["m", "a", "z"],
    );
  });
});

// ── service (injected prisma) ────────────────────────────────────────────────

interface Call {
  where?: unknown;
  select?: unknown;
  take?: number;
  skip?: number;
}
function fake(delegates: Record<string, (args: Call) => unknown>): {
  prisma: QuizServiceDeps["prisma"];
  calls: Record<string, Call[]>;
} {
  const calls: Record<string, Call[]> = {};
  const db: Record<string, Record<string, (a: Call) => unknown>> = {};
  for (const key of Object.keys(delegates)) {
    const [model, method] = key.split(".");
    db[model] ??= {};
    db[model][method] = async (args: Call) => {
      (calls[key] ??= []).push(args);
      return delegates[key](args);
    };
  }
  return { prisma: db as unknown as QuizServiceDeps["prisma"], calls };
}

describe("quiz.service listQuizzes", () => {
  it("lists lessons carrying a quiz and clamps take/skip", async () => {
    const { prisma, calls } = fake({
      "courseLesson.findMany": () => [
        { id: "l1", title: "Basics", _count: { quizzes: 3 } },
      ],
    });
    const res = await listQuizzes("u1", { limit: 999, skip: -5 }, { prisma });
    assert.equal(res.success, true);
    if (res.success)
      assert.deepEqual(res.data, [
        { lessonId: "l1", title: "Basics", questionCount: 3 },
      ]);
    const args = calls["courseLesson.findMany"]?.[0];
    assert.deepEqual(args?.where, { quizzes: { some: {} } });
    assert.equal(args?.take, 100); // clamped from 999
    assert.equal(args?.skip, 0); // clamped from -5
  });

  it("fails closed with a sanitised error when the query throws", async () => {
    const { prisma } = fake({
      "courseLesson.findMany": () => {
        throw new Error("Mongo down");
      },
    });
    const res = await listQuizzes("u1", {}, { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Failed to fetch quizzes");
  });
});

describe("quiz.service getQuiz", () => {
  it("returns questions with the answer key stripped", async () => {
    const { prisma } = fake({
      "courseLesson.findUnique": () => ({
        id: "l1",
        title: "T",
        quizzes: [Q({ id: "q1", order: 1 }), Q({ id: "q0", order: 0 })],
      }),
    });
    const res = await getQuiz("u1", "l1", { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(
        res.data.questions.map((q) => q.id),
        ["q0", "q1"],
      ); // sorted
      assert.equal("correctAnswer" in res.data.questions[0]!, false);
    }
  });

  it("returns not-found for a lesson with no quiz", async () => {
    const { prisma } = fake({
      "courseLesson.findUnique": () => ({ id: "l1", title: "T", quizzes: [] }),
    });
    const res = await getQuiz("u1", "l1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Quiz not found");
  });
});

describe("quiz.service submitQuiz", () => {
  it("scores a submission against the stored question set", async () => {
    const { prisma, calls } = fake({
      "quiz.findMany": () => [Q({ id: "a", order: 0, correctAnswer: 1 })],
    });
    const res = await submitQuiz("u1", "l1", { answers: [1] }, { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.correctCount, 1);
      assert.equal(res.data.scorePct, 100);
    }
    assert.deepEqual(calls["quiz.findMany"]?.[0]?.where, { lessonId: "l1" });
  });

  it("returns not-found when the lesson has no questions", async () => {
    const { prisma } = fake({ "quiz.findMany": () => [] });
    const res = await submitQuiz("u1", "l1", { answers: [] }, { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Quiz not found");
  });

  it("tolerates a non-array answers payload (no throw)", async () => {
    const { prisma } = fake({ "quiz.findMany": () => [Q()] });
    const res = await submitQuiz(
      "u1",
      "l1",
      { answers: undefined as unknown as number[] },
      { prisma },
    );
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.answered, 0);
  });
});
