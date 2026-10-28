/**
 * Pure, Next-free fallback generator for the generate-script route (`route.ts`).
 *
 * The template-script builder was previously a non-exported function inside the
 * route handler module, testable only via an inline copy. It is extracted here
 * so the REAL fallback can be unit-tested directly. `route.ts` imports and
 * calls `generateFallbackScript`.
 *
 * @see apps/content/__tests__/api/ai-routes.test.ts
 */

/**
 * Build a template blog-post body used when no AI key is configured (or the AI
 * call fails). Uses the provided title/description/topics; falls back to
 * generic copy when those are absent.
 */
export function generateFallbackScript(
  title: string,
  description?: string,
  topics?: string[],
): string {
  const topicsSection = topics?.length
    ? topics.map((t) => `- **${t}**: Explore this aspect in detail`).join("\n")
    : "- Add your key points here";

  return `In today's dynamic Indian stock market, understanding ${title.toLowerCase()} has become increasingly important. ${description || "This comprehensive guide will walk you through everything you need to know."}

## Why This Matters

Before diving into the details, it's crucial to understand why this topic deserves your attention. The Indian market landscape is constantly evolving, and staying informed is key to making better investment decisions.

## Key Concepts

Let's explore the fundamental concepts:

${topicsSection}

## Getting Started

Here's how to begin:

1. **Start with the basics** - Build a solid foundation before moving to advanced topics
2. **Practice consistently** - Regular application reinforces learning
3. **Seek feedback** - Learn from others' experiences and insights

## Best Practices

Based on market experience, here are proven strategies:

- Focus on quality over quantity
- Stay updated with the latest developments
- Build a diversified approach

## Common Pitfalls to Avoid

Many investors make these mistakes:

- Rushing through fundamentals
- Ignoring feedback and iteration
- Following the herd without research

## Conclusion

Mastering ${title.toLowerCase()} is a journey, not a destination. Start with the basics, remain consistent, and don't be afraid to experiment. The key is to take action and learn from both successes and failures.

---

*Note: This is a template. Configure GOOGLE_GENAI_API_KEY for AI-generated content.*`;
}
