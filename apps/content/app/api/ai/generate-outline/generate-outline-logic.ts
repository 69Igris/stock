/**
 * Pure, Next-free fallback generator for the generate-outline route
 * (`route.ts`).
 *
 * The template-outline builder was previously a non-exported function inside
 * the route handler module, testable only via an inline copy. It is extracted
 * here so the REAL fallback can be unit-tested directly. `route.ts` imports and
 * calls `generateFallbackOutline`.
 *
 * @see apps/content/__tests__/api/ai-generation.test.ts
 */

/**
 * Build a template blog-post outline used when no AI key is configured (or the
 * AI call fails). Uses the provided title/description/topics; falls back to
 * generic copy when those are absent.
 */
export function generateFallbackOutline(
  title: string,
  description?: string,
  topics?: string[],
): string {
  return `# ${title}

## Introduction
- Hook the reader with an interesting opening
- Briefly introduce the topic
${description ? `- ${description}` : "- State the main premise of the article"}
- Preview what readers will learn

## Background/Context
- Provide necessary background information
- Define key terms if needed
- Set the stage for the main content

## Main Section 1
${topics?.[0] ? `### ${topics[0]}` : "### Key Point 1"}
- Discuss the first major point
- Include relevant examples
- Provide supporting evidence or data

## Main Section 2
${topics?.[1] ? `### ${topics[1]}` : "### Key Point 2"}
- Explore the second major aspect
- Connect to the previous section
- Add practical insights

## Main Section 3
${topics?.[2] ? `### ${topics[2]}` : "### Key Point 3"}
- Cover the third important element
- Include actionable tips
- Reference real-world applications

## Practical Tips/How-To
- List actionable steps readers can take
- Provide specific recommendations
- Include tools or resources if relevant

## Conclusion
- Summarize the key takeaways
- Reinforce the main message
- Include a call-to-action for readers

---

*Note: This is a template outline. Configure GOOGLE_GENAI_API_KEY for AI-generated outlines.*`;
}
