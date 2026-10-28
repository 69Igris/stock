"use server";

import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { validateQuizInput, mapGeneratedQuestions } from "./quizzes-logic";

export async function createQuiz(data: {
  lessonId: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation?: string;
  order?: number;
}) {
  await requireAdmin();
  const validationError = validateQuizInput(data);
  if (validationError) {
    throw new Error(validationError);
  }
  return prisma.quiz.create({ data });
}

export async function updateQuiz(
  quizId: string,
  data: Partial<{
    question: string;
    options: string[];
    correctAnswer: number;
    explanation: string;
    order: number;
  }>,
) {
  await requireAdmin();
  return prisma.quiz.update({ where: { id: quizId }, data });
}

export async function deleteQuiz(quizId: string) {
  await requireAdmin();
  return prisma.quiz.delete({ where: { id: quizId } });
}

export async function generateQuizzesForLesson(
  lessonId: string,
  topic: string,
  difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED" = "BEGINNER",
) {
  await requireAdmin();
  const { generateQuizQuestions } = await import("@usemoney/content-engine");

  const questions = await generateQuizQuestions({
    topic,
    difficulty,
    count: 5,
  });

  const created = [];
  for (const data of mapGeneratedQuestions(lessonId, questions)) {
    const quiz = await prisma.quiz.create({ data });
    created.push(quiz);
  }

  return created;
}
