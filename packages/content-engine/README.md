# @usemoney/content-engine

> Learning content generation and quiz system for UseMoney

Uses Google Gemini to generate learning content, verify quality, and create quiz questions.

## Features

- **Content Generation**: AI-generated articles, video scripts, audio scripts, infographics
- **Content Verification**: Quality checks for accuracy, completeness, tone, SEO
- **Quiz Generation**: MCQ quiz questions with configurable difficulty levels

## Usage

```typescript
import {
  generateLearningContent,
  verifyContent,
  generateQuizQuestions,
} from "@usemoney/content-engine";

// Generate content
const content = await generateLearningContent({
  topic: "What is P/E Ratio?",
  contentType: "article",
  language: "en",
});

// Verify quality
const result = await verifyContent({
  content: content.markdown,
  topic: "P/E Ratio",
});

// Generate quiz
const questions = await generateQuizQuestions({
  topic: "P/E Ratio",
  difficulty: "BEGINNER",
  count: 5,
});
```

## Exports

| Export                      | Description                  |
| --------------------------- | ---------------------------- |
| `generateLearningContent`   | AI content generation        |
| `verifyContent`             | Content quality verification |
| `generateQuizQuestions`     | Quiz question generation     |
| `ContentVerificationResult` | Verification result type     |
| `ContentCheck`              | Individual check type        |
| `QuizQuestion`              | Quiz question type           |

## Documentation

See **CLAUDE.md** for technical details.
