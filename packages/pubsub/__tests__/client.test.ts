/**
 * @usemoney/pubsub — client factory + topic/env resolution.
 *
 * Ported + strengthened from workers/__tests__/lib/pubsub-client.test.ts and
 * apps/web/__tests__/pubsub/publish.test.ts. Drives the REAL reconciled source
 * (src/client.ts): validateProjectId (pure), getPubSubClient (singleton +
 * throw-on-missing-project, reset via the __setPubSubClientForTests seam), and
 * the shared getPubSubEnv/getTopicName resolution from @usemoney/types.
 *
 * Constructing a PubSub client opens no socket, so no handles leak.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  validateProjectId,
  getPubSubClient,
  __setPubSubClientForTests,
} from "../src/client";
import { getPubSubEnv, getTopicName, PUBSUB_TOPICS } from "@usemoney/types";

describe("validateProjectId", () => {
  it("passes for a valid string", () => {
    const result = validateProjectId("my-gcp-project");
    assert.equal(result.valid, true);
    if (result.valid) assert.equal(result.projectId, "my-gcp-project");
  });

  it("fails for undefined", () => {
    const result = validateProjectId(undefined);
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.error.includes("GCP_PROJECT_ID"));
      assert.ok(result.error.includes("Pub/Sub"));
    }
  });

  it("fails for empty string", () => {
    assert.equal(validateProjectId("").valid, false);
  });

  it("passes for ids with hyphens and numbers", () => {
    assert.equal(validateProjectId("stockbook-prod-123").valid, true);
    assert.equal(validateProjectId("project123456").valid, true);
  });
});

describe("getPubSubClient", () => {
  let savedProject: string | undefined;

  beforeEach(() => {
    savedProject = process.env.GCP_PROJECT_ID;
    __setPubSubClientForTests(null);
  });

  afterEach(() => {
    if (savedProject === undefined) delete process.env.GCP_PROJECT_ID;
    else process.env.GCP_PROJECT_ID = savedProject;
    __setPubSubClientForTests(null);
  });

  it("throws when GCP_PROJECT_ID is unset", () => {
    delete process.env.GCP_PROJECT_ID;
    assert.throws(() => getPubSubClient(), /GCP_PROJECT_ID/);
  });

  it("returns the same singleton across calls", () => {
    process.env.GCP_PROJECT_ID = "stockbook-test";
    const first = getPubSubClient();
    const second = getPubSubClient();
    const third = getPubSubClient();
    assert.equal(first, second);
    assert.equal(second, third);
  });

  it("constructs a client exposing the topic + subscription API", () => {
    process.env.GCP_PROJECT_ID = "stockbook-test";
    const client = getPubSubClient();
    assert.equal(typeof client.topic, "function");
    assert.equal(typeof client.subscription, "function");
    assert.equal(typeof client.createSubscription, "function");
  });
});

describe("topic/env resolution (@usemoney/types)", () => {
  let savedEnv: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.PUBSUB_ENV;
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PUBSUB_ENV;
    else process.env.PUBSUB_ENV = savedEnv;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it("PUBSUB_ENV wins: prod / qa / local", () => {
    process.env.PUBSUB_ENV = "prod";
    assert.equal(getPubSubEnv(), "prod");
    process.env.PUBSUB_ENV = "qa";
    assert.equal(getPubSubEnv(), "qa");
    process.env.PUBSUB_ENV = "local";
    assert.equal(getPubSubEnv(), "local");
  });

  it("falls back to prod when NODE_ENV=production and PUBSUB_ENV unset", () => {
    delete process.env.PUBSUB_ENV;
    process.env.NODE_ENV = "production";
    assert.equal(getPubSubEnv(), "prod");
  });

  it("falls back to qa otherwise", () => {
    delete process.env.PUBSUB_ENV;
    process.env.NODE_ENV = "development";
    assert.equal(getPubSubEnv(), "qa");
  });

  it("getTopicName suffixes the base topic with the env", () => {
    process.env.PUBSUB_ENV = "qa";
    assert.equal(getTopicName(PUBSUB_TOPICS.BROKER_SYNC), "broker-sync-qa");
    process.env.PUBSUB_ENV = "prod";
    assert.equal(
      getTopicName(PUBSUB_TOPICS.TRADE_PAIRING),
      "trade-pairing-prod",
    );
  });
});
