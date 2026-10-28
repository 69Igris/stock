# @usemoney/content-engine - CLAUDE.md

## Overview

AI content-generation engine for learning content: Gemini-powered lesson generation, quality verification, and quiz-question generation. Course structure/progress/delivery live in `@usemoney/database` + the apps; this package is consumed by the `apps/admin` content actions.

**Package:** `@usemoney/content-engine`

---

## Features

- AI lesson content generation (`generateLearningContent`)
- Content quality verification (`verifyContent`)
- Quiz question generation (`generateQuizQuestions`)
- Requires `USE_GEMINI=true` — all three go through `getVertexAIClient` from `@usemoney/core/gemini` and throw when disabled

---

## Status

Implemented. Provides AI-powered content generation, quality verification, and quiz question generation using Google Gemini (2.5 Flash).

### Exports

| Export                      | File          | Description                  |
| --------------------------- | ------------- | ---------------------------- |
| `generateLearningContent`   | `generate.ts` | AI content generation        |
| `verifyContent`             | `verify.ts`   | Content quality verification |
| `generateQuizQuestions`     | `quiz.ts`     | Quiz question generation     |
| `ContentVerificationResult` | `types.ts`    | Verification result type     |
| `ContentCheck`              | `types.ts`    | Individual check type        |
| `QuizQuestion`              | `types.ts`    | Quiz question type           |

---

_Last Updated: July 2026_
