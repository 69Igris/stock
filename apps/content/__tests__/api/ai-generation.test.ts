/**
 * AI Generation Route Helper Tests
 *
 * Exercises the REAL fallback generators imported & used by the route handlers:
 * - apps/content/app/api/ai/generate-outline/generate-outline-logic.ts
 *   (generateFallbackOutline, used by generate-outline/route.ts)
 * - apps/content/app/api/ai/suggest-topics/suggest-topics-logic.ts
 *   (generateFallbackTopics, used by suggest-topics/route.ts)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateFallbackOutline } from "@/app/api/ai/generate-outline/generate-outline-logic";
import { generateFallbackTopics } from "@/app/api/ai/suggest-topics/suggest-topics-logic";

// ── Tests ────────────────────────────────────────────────

describe("generateFallbackOutline", () => {
  it("should include the title as H1", () => {
    const outline = generateFallbackOutline("Test Post");
    assert.ok(outline.startsWith("# Test Post"));
  });

  it("should include description when provided", () => {
    const outline = generateFallbackOutline(
      "Test",
      "A great post about investing",
    );
    assert.ok(outline.includes("- A great post about investing"));
  });

  it("should use default premise when no description", () => {
    const outline = generateFallbackOutline("Test");
    assert.ok(outline.includes("- State the main premise of the article"));
  });

  it("should use topics as section headings when provided", () => {
    const outline = generateFallbackOutline("Test", undefined, [
      "SIP",
      "Mutual Funds",
      "ETFs",
    ]);
    assert.ok(outline.includes("### SIP"));
    assert.ok(outline.includes("### Mutual Funds"));
    assert.ok(outline.includes("### ETFs"));
  });

  it("should use default headings when no topics", () => {
    const outline = generateFallbackOutline("Test");
    assert.ok(outline.includes("### Key Point 1"));
    assert.ok(outline.includes("### Key Point 2"));
    assert.ok(outline.includes("### Key Point 3"));
  });

  it("should include partial topics (only first topic provided)", () => {
    const outline = generateFallbackOutline("Test", undefined, ["Only One"]);
    assert.ok(outline.includes("### Only One"));
    assert.ok(outline.includes("### Key Point 2"));
    assert.ok(outline.includes("### Key Point 3"));
  });

  it("should include API key note at the bottom", () => {
    const outline = generateFallbackOutline("Test");
    assert.ok(outline.includes("GOOGLE_GENAI_API_KEY"));
  });

  it("should contain Introduction section", () => {
    const outline = generateFallbackOutline("Test");
    assert.ok(outline.includes("## Introduction"));
  });

  it("should contain Conclusion section", () => {
    const outline = generateFallbackOutline("Test");
    assert.ok(outline.includes("## Conclusion"));
  });

  it("should contain Practical Tips section", () => {
    const outline = generateFallbackOutline("Test");
    assert.ok(outline.includes("## Practical Tips/How-To"));
  });
});

describe("generateFallbackTopics", () => {
  it("should return 10 topics by default", () => {
    const topics = generateFallbackTopics();
    assert.strictEqual(topics.length, 10);
  });

  it("should respect count parameter", () => {
    assert.strictEqual(generateFallbackTopics(undefined, 5).length, 5);
    assert.strictEqual(generateFallbackTopics(undefined, 3).length, 3);
    assert.strictEqual(generateFallbackTopics(undefined, 1).length, 1);
  });

  it("should return at most 10 even if count is higher", () => {
    const topics = generateFallbackTopics(undefined, 100);
    assert.strictEqual(topics.length, 10);
  });

  it("should return empty array for count 0", () => {
    const topics = generateFallbackTopics(undefined, 0);
    assert.strictEqual(topics.length, 0);
  });

  it("should have required fields on each topic", () => {
    const topics = generateFallbackTopics();
    for (const topic of topics) {
      assert.ok(typeof topic.topic === "string");
      assert.ok(typeof topic.description === "string");
      assert.ok(typeof topic.relevanceScore === "number");
      assert.ok(Array.isArray(topic.relatedKeywords));
      assert.ok(topic.relatedKeywords.length > 0);
    }
  });

  it("should have relevance scores between 1 and 10", () => {
    const topics = generateFallbackTopics();
    for (const topic of topics) {
      assert.ok(topic.relevanceScore >= 1);
      assert.ok(topic.relevanceScore <= 10);
    }
  });

  it("should include India-specific financial topics", () => {
    const topics = generateFallbackTopics();
    const topicNames = topics.map((t) => t.topic);
    assert.ok(topicNames.includes("NIFTY 50 Analysis"));
    assert.ok(topicNames.includes("FIRE Planning India"));
  });

  it("should have first topic as NIFTY 50 Analysis", () => {
    const topics = generateFallbackTopics();
    assert.strictEqual(topics[0]!.topic, "NIFTY 50 Analysis");
  });
});
