/**
 * Studio API helper tests (MONEY-1062).
 *
 * Exercises the REAL `renderTopic()` exported from
 * apps/content/app/api/studio/_helpers.ts — the Pub/Sub topic the studio render
 * route publishes to. It must resolve via the SHARED env-suffix logic
 * (`getTopicName(PUBSUB_TOPICS.STUDIO_RENDER)`), so an UNSET `PUBSUB_ENV` falls
 * back to `-qa` OUTSIDE production and NEVER to the prod topic. (The old code
 * hand-built `studio-render-${PUBSUB_ENV ?? "prod"}`, which published a
 * local/dev render job to the PROD topic.)
 *
 * The base topic name MUST stay in lock-step with
 * workers/scripts/setup-pubsub.sh ("studio-render") and the worker's
 * `studio-render-<env>-push` subscription.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { renderTopic } from "@/app/api/studio/_helpers";

let savedEnv: NodeJS.ProcessEnv;

describe("renderTopic — studio-render topic resolution", () => {
  beforeEach(() => {
    savedEnv = { ...process.env };
    // Start each case from a clean slate: no explicit override, no PUBSUB_ENV.
    delete process.env.STUDIO_RENDER_TOPIC;
    delete process.env.PUBSUB_ENV;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("unset PUBSUB_ENV outside production → -qa (NEVER prod) [the fix]", () => {
    // NODE_ENV is unset here → not production.
    const topic = renderTopic();
    assert.equal(topic, "studio-render-qa");
    assert.ok(
      !topic.endsWith("-prod"),
      "unset env must not resolve to the prod topic",
    );
  });

  it("unset PUBSUB_ENV in a non-production NODE_ENV → -qa", () => {
    process.env.NODE_ENV = "development";
    assert.equal(renderTopic(), "studio-render-qa");
  });

  it("PUBSUB_ENV=qa → -qa", () => {
    process.env.PUBSUB_ENV = "qa";
    assert.equal(renderTopic(), "studio-render-qa");
  });

  it("PUBSUB_ENV=local → -local (isolates a dev worker)", () => {
    process.env.PUBSUB_ENV = "local";
    assert.equal(renderTopic(), "studio-render-local");
  });

  it("PUBSUB_ENV=prod → -prod", () => {
    process.env.PUBSUB_ENV = "prod";
    assert.equal(renderTopic(), "studio-render-prod");
  });

  it("NODE_ENV=production with unset PUBSUB_ENV → -prod (production default)", () => {
    process.env.NODE_ENV = "production";
    assert.equal(renderTopic(), "studio-render-prod");
  });

  it("STUDIO_RENDER_TOPIC overrides the whole name verbatim", () => {
    process.env.STUDIO_RENDER_TOPIC = "studio-render-custom";
    // Even with PUBSUB_ENV set, the explicit override wins.
    process.env.PUBSUB_ENV = "prod";
    assert.equal(renderTopic(), "studio-render-custom");
  });
});
