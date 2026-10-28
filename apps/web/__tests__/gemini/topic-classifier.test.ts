/**
 * Topic Classifier Tests (MONEY-295)
 *
 * Covers the pure logic in packages/core/src/gemini/topic-classifier.ts:
 *   - shouldRefuse policy
 *   - buildRefusalMessage shape
 *   - bypass behavior (slash / @-mention / short queries)
 *   - kill-switch via TOPIC_CLASSIFIER_ENABLED=false
 *
 * The Vertex AI call path (cache + LLM) is exercised in browser/integration
 * QA - mocking the Vertex client surface here would be brittle and
 * low-value. Pure-function tests give the regression coverage that
 * matters.
 *
 * Source: packages/core/src/gemini/topic-classifier.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  classifyTopic,
  shouldRefuse,
  buildRefusalMessage,
  type TopicClassification,
} from "../../../../packages/core/src/gemini/topic-classifier";

describe("topic-classifier: shouldRefuse policy", () => {
  it("never refuses on_topic", () => {
    const c: TopicClassification = { category: "on_topic", confidence: 0.99 };
    assert.equal(shouldRefuse(c), false);
  });

  it("refuses off_topic_unrelated above 0.7 confidence", () => {
    const c: TopicClassification = {
      category: "off_topic_unrelated",
      confidence: 0.71,
    };
    assert.equal(shouldRefuse(c), true);
  });

  it("does NOT refuse off_topic_unrelated at or below 0.7 confidence", () => {
    const c: TopicClassification = {
      category: "off_topic_unrelated",
      confidence: 0.7,
    };
    assert.equal(shouldRefuse(c), false);
  });

  it("does NOT refuse off_topic_finance_outside_scope (in the neighborhood)", () => {
    const c: TopicClassification = {
      category: "off_topic_finance_outside_scope",
      confidence: 0.99,
    };
    assert.equal(shouldRefuse(c), false);
  });

  it("does NOT refuse ambiguous", () => {
    const c: TopicClassification = { category: "ambiguous", confidence: 0.99 };
    assert.equal(shouldRefuse(c), false);
  });
});

describe("topic-classifier: buildRefusalMessage", () => {
  it("includes brand prefix + reason when provided", () => {
    const msg = buildRefusalMessage({
      category: "off_topic_unrelated",
      confidence: 0.95,
      reason: "Cooking question with no financial content.",
    });
    assert.ok(msg.includes("StockSage"), "brand prefix present");
    assert.ok(msg.includes("Cooking"), "reason carried through");
  });

  it("falls back to generic copy when reason missing", () => {
    const msg = buildRefusalMessage({
      category: "off_topic_unrelated",
      confidence: 0.95,
    });
    assert.ok(msg.includes("Indian stocks"));
  });
});

describe("topic-classifier: bypass + kill-switch", () => {
  // Save + restore env so tests don't leak.
  const originalFlag = process.env.TOPIC_CLASSIFIER_ENABLED;
  after(() => {
    if (originalFlag === undefined) {
      delete process.env.TOPIC_CLASSIFIER_ENABLED;
    } else {
      process.env.TOPIC_CLASSIFIER_ENABLED = originalFlag;
    }
  });

  it("kill-switch returns on_topic without calling Vertex", async () => {
    process.env.TOPIC_CLASSIFIER_ENABLED = "false";
    const result = await classifyTopic("how to bake a cake");
    assert.equal(result.category, "on_topic");
    assert.equal(result.confidence, 1);
    assert.equal(result.reason, "classifier disabled");
  });

  it("slash commands bypass classifier", async () => {
    process.env.TOPIC_CLASSIFIER_ENABLED = "true";
    const result = await classifyTopic("/markets");
    assert.equal(result.category, "on_topic");
    assert.match(result.reason ?? "", /bypass/);
  });

  it("@-mentions bypass classifier", async () => {
    process.env.TOPIC_CLASSIFIER_ENABLED = "true";
    const result = await classifyTopic("@RELIANCE");
    assert.equal(result.category, "on_topic");
    assert.match(result.reason ?? "", /bypass/);
  });

  it("short queries bypass (under 3 chars)", async () => {
    process.env.TOPIC_CLASSIFIER_ENABLED = "true";
    const result = await classifyTopic("hi");
    assert.equal(result.category, "on_topic");
    assert.match(result.reason ?? "", /bypass/);
  });
});
